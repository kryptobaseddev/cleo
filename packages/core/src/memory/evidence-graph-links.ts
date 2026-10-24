/**
 * Graph links from accepted verification evidence (T13950).
 *
 * When `cleo verify` accepts evidence atoms it has already validated them
 * against git, the filesystem or GitHub. Those atoms are the most reliable
 * statement of what a task touched, so they become graph edges:
 *
 * | atom        | graph write                                                    |
 * |-------------|----------------------------------------------------------------|
 * | `commit`    | `task:<id> --touches_code--> commit:<sha>` (`ensureCommitNode`) |
 * | `pr`        | the same, for the PR's merge commit                            |
 * | `files`     | `task:<id> --touches_code--> file:<path>`                      |
 * | `decision`  | `decision:<id> --applies_to--> task:<id>`                      |
 *
 * Other atoms (tool runs, test runs, notes, `satisfies` bindings that already
 * live in the tasks store) add no edge. Writes are explicit (they do not depend
 * on `brain.autoCapture`) and idempotent: nodes are created when absent and an
 * existing edge is left unchanged, so re-verifying adds nothing.
 *
 * Node ids are permanent and sync between devices, so a file node is keyed by
 * its POSIX path relative to the checkout that holds it. A path outside both
 * the evidence repository and the store root gets no node and is reported in
 * `skipped`. File and commit ids of every repository but the store's primary
 * one carry a repository key (`file:<repo>::<path>`, `commit:<repo>::<sha>`;
 * T14012, {@link createEvidenceRepoResolver}), so same-named files in two child
 * repositories stay separate nodes.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @module memory/evidence-graph-links
 * @task T13950
 */

import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { EvidenceAtom } from '@cleocode/contracts';
import { and, eq } from 'drizzle-orm';
import {
  findNestedGitWorkTrees,
  gitCommonDir,
  gitHasCommit,
  gitHeadHasPath,
  gitOriginUrl,
  gitSubmoduleToplevels,
  gitToplevel,
  resolveDeclaredEvidenceGitRoot,
} from '../git/work-tree.js';
import { extractRepoOwnerAndName } from '../release/github-pr.js';
import { writeJsonFileAtomic } from '../store/file-utils.js';
import { getBrainDb } from '../store/memory-sqlite.js';
import type { BrainEdgeType, BrainNodeType } from '../store/schema/memory-schema.js';
import { brainPageEdges, brainPageNodes } from '../store/schema/memory-schema.js';
import { resolveEvidenceExecutionRoot } from '../tasks/evidence.js';
import {
  ensureCommitNode,
  REPO_ID_SEPARATOR,
  repoQualifiedNodeId,
  writeGraphBatch,
} from './graph-auto-populate.js';

/** Provenance stamped on every edge this module writes. */
export const EVIDENCE_EDGE_PROVENANCE = 'evidence:verify';

/** Graph writes from one accepted verification. */
export interface EvidenceLinkResult {
  /** Commits linked (from `commit` and `pr` atoms). */
  commits: number;
  /** Files linked. */
  files: number;
  /** Decisions linked. */
  decisions: number;
  /** `files:` paths given no node because they lie outside the evidence repository. */
  skipped: string[];
}

/**
 * Resolve symlinks (macOS `/tmp` → `/private/tmp`) through the nearest
 * existing ancestor, so a file deleted since verify still compares equal.
 */
function real(path: string): string {
  const abs = resolve(path);
  const parent = dirname(abs);
  if (existsSync(abs) || parent === abs) {
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  }
  return join(real(parent), basename(abs));
}

/** True when `child` is `root` or lies below it. */
function within(root: string, child: string): boolean {
  const rel = relative(real(root), real(child));
  return !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** POSIX form of `rel`, or `null` when it escapes its base. */
function posixInside(rel: string): string | null {
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** A file's node key: its repository (`null` = the store's own) and repo-relative path. */
export interface EvidenceFileKey {
  /** Repository key, or `null` for the store's own repository. */
  repo: string | null;
  /** POSIX path relative to the checkout holding the file. */
  path: string;
}

/**
 * Resolves which repository an evidence file or commit belongs to (T14012),
 * caching every git probe by directory for the resolver's lifetime (one link
 * call or one migration run).
 */
export interface EvidenceRepoResolver {
  /**
   * Node key of an evidence file, or `null` when it lies outside both the
   * execution and the store root, or its path contains the id separator.
   */
  file(path: string, executionRoot: string): EvidenceFileKey | null;
  /**
   * Repository key of the checkout holding `dir`: `null` for the primary
   * repository, for a directory in no checkout, and for an outer repository
   * that tracks nothing under the store root.
   */
  repoOf(dir: string): string | null;
  /**
   * Repository of a commit, by the same rule as files: the key of the
   * checkout that contains it (`repo: null` for the primary repository), or
   * `null` when no known checkout, or checkouts of more than one repository,
   * contain it.
   */
  commit(sha: string): { repo: string | null } | null;
  /** The checkouts the store knows: primary, its children, and their submodules. */
  checkouts(): readonly string[];
}

/**
 * Repository key of an `origin` URL, the same on every device for the same
 * repository: `github.com/<owner>/<repo>` through the github.com-anchored
 * {@link extractRepoOwnerAndName} the PR evidence uses, else `<host>/<path>`.
 * Scheme, user, port (only a `scheme://` URL has one; in scp form the digits
 * after the colon are an owner) and `.git` are dropped and the key is
 * lowercased, so `git@github.com:O/R.git`, `https://github.com/o/r` and
 * `ssh://git@github.com:22/o/r` agree. A local-path remote has no key.
 *
 * @param url - Raw `origin` URL.
 * @returns The key, or `null`.
 * @example
 * ```ts
 * originRepoKey('ssh://git@github.com:22/O/R.git'); // 'github.com/o/r'
 * ```
 * @task T14012
 */
export function originRepoKey(url: string): string | null {
  const trimmed = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(trimmed);
  const rest = trimmed.slice(scheme?.[0].length ?? 0).replace(/^[^@/]+@/, '');
  // Only a URL with a scheme has a port; in scp form (`git@host:1234/repo`)
  // the digits after the colon are an owner or group (T14012).
  const match = scheme ? /^([^/:]+)(?::\d+)?\/+(.+)$/.exec(rest) : /^([^/:]+)[:/]+(.+)$/.exec(rest);
  const host = match?.[1]?.toLowerCase();
  const path = match?.[2]?.replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!host || !path || /^\.+$/.test(host)) return null;
  if (host === 'github.com') {
    const github = extractRepoOwnerAndName(`https://github.com/${path}`);
    return github ? `github.com/${github.owner}/${github.repo}`.toLowerCase() : null;
  }
  return `${host}/${path}`.toLowerCase();
}

/** Classification of a checkout toplevel relative to the store. */
type CheckoutClass = { kind: 'primary' } | { kind: 'ignored' } | { kind: 'repo'; key: string };

/**
 * Create an {@link EvidenceRepoResolver} for one CLEO store.
 *
 * The primary repository is the store root's own: the checkout whose toplevel
 * is the store root, or an outer repository that tracks files under it (a
 * store inside a monorepo); failing that, the declared evidence git root
 * (`evidence.gitRoot` or `CLEO_EVIDENCE_GIT_ROOT`). Its files and commits, in
 * any of its worktrees, keep unqualified ids, so single-repo stores never
 * change. Without either, nothing is primary: the id of a child repository
 * never depends on how many repositories the store holds, so adding one later
 * moves nothing. Every other checkout (a child repository, a submodule) is
 * keyed by {@link originRepoKey}; without a usable origin, by its main
 * checkout's directory relative to the store root. An outer repository that
 * tracks nothing under the store root (a dotfiles repository at `~`) is
 * ignored: files under the store root are keyed against the store root.
 *
 * @param storeRoot - CLEO store root.
 * @returns The resolver.
 * @example
 * ```ts
 * const repos = createEvidenceRepoResolver('/work');
 * repos.file('api/src/x.ts', '/work'); // { repo: 'github.com/o/api', path: 'src/x.ts' }
 * ```
 * @task T14012
 */
export function createEvidenceRepoResolver(storeRoot: string): EvidenceRepoResolver {
  const toplevels = new Map<string, string | null>();
  const classes = new Map<string, CheckoutClass>();
  const commits = new Map<string, { repo: string | null } | null>();
  let primaryCommonDir: string | null | undefined;
  let known: string[] | undefined;

  const toplevelOf = (dir: string): string | null => {
    let top = toplevels.get(dir);
    if (top === undefined) {
      top = existsSync(dir) ? gitToplevel(dir) : null;
      toplevels.set(dir, top);
    }
    return top;
  };

  /** The store root's own checkout (its toplevel or a tracking outer repository). */
  const storeTop = (): string | null => {
    const top = toplevelOf(storeRoot);
    if (top === null) return null;
    const rel = posixInside(relative(real(top), real(storeRoot)));
    return rel === '' || (rel !== null && gitHeadHasPath(top, rel)) ? top : null;
  };

  const declaredTop = (): string | null => {
    const declared = resolveDeclaredEvidenceGitRoot(storeRoot);
    return declared === null ? null : toplevelOf(declared.path);
  };

  const primaryCommon = (): string | null => {
    if (primaryCommonDir === undefined) {
      const top = storeTop() ?? declaredTop();
      primaryCommonDir = top === null ? null : gitCommonDir(top);
    }
    return primaryCommonDir;
  };

  const classify = (top: string): CheckoutClass => {
    const cached = classes.get(top);
    if (cached) return cached;
    const common = gitCommonDir(top);
    const primary = primaryCommon();
    let result: CheckoutClass;
    if (common !== null && common === primary) result = { kind: 'primary' };
    else if (top !== real(storeRoot) && within(top, storeRoot)) result = { kind: 'ignored' };
    else {
      const main = common !== null && basename(common) === '.git' ? dirname(common) : top;
      const rel = posixInside(relative(real(storeRoot), real(main)));
      const origin = gitOriginUrl(top);
      const key =
        (origin !== null ? originRepoKey(origin) : null) ??
        (rel !== null && rel !== '' ? rel : basename(main));
      result = { kind: 'repo', key };
    }
    classes.set(top, result);
    return result;
  };

  /** Toplevel of the git checkout holding `abs` (via its nearest existing directory). */
  const checkoutOf = (abs: string): string | null => {
    let dir = dirname(abs);
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
    return toplevelOf(dir);
  };

  const checkouts = (): readonly string[] => {
    if (known === undefined) {
      const tops = [storeTop(), declaredTop(), ...findNestedGitWorkTrees(storeRoot)].filter(
        (top): top is string => top !== null,
      );
      known = [...new Set(tops.flatMap((top) => [top, ...gitSubmoduleToplevels(top)]))];
    }
    return known;
  };

  return {
    file(path, executionRoot) {
      if (path.includes(REPO_ID_SEPARATOR)) return null;
      const fromExecution = isAbsolute(path) ? path : resolve(executionRoot, path);
      const fromStore = resolve(storeRoot, path);
      const abs = existsSync(fromExecution) || !existsSync(fromStore) ? fromExecution : fromStore;
      const insideExecution = within(executionRoot, abs);
      if (!insideExecution && !within(storeRoot, abs)) return null;
      let base = insideExecution ? executionRoot : storeRoot;
      let repo: string | null = null;
      const top = checkoutOf(abs);
      if (top !== null) {
        const cls = classify(top);
        if (cls.kind !== 'ignored') base = top;
        if (cls.kind === 'repo') repo = cls.key;
      }
      const rel = posixInside(relative(real(base), real(abs)));
      return rel === null || rel === '' ? null : { repo, path: rel };
    },
    repoOf(dir) {
      const top = toplevelOf(dir);
      if (top === null) return null;
      const cls = classify(top);
      return cls.kind === 'repo' ? cls.key : null;
    },
    commit(sha) {
      const cached = commits.get(sha);
      if (cached !== undefined) return cached;
      const repos = new Set<string | null>();
      for (const checkout of checkouts()) {
        const cls = classify(checkout);
        if (cls.kind !== 'ignored' && gitHasCommit(checkout, sha)) {
          repos.add(cls.kind === 'repo' ? cls.key : null);
        }
      }
      const [only] = repos;
      const result = repos.size === 1 && only !== undefined ? { repo: only } : null;
      commits.set(sha, result);
      return result;
    },
    checkouts,
  };
}

/**
 * The POSIX path of an evidence file relative to the checkout that holds it,
 * or `null` when it lies outside both the execution and the store root.
 *
 * The file is located as `validateFiles` located it: the execution root when it
 * exists there, else the store root, else (validated at a commit only) the
 * execution root. Keying by the holding checkout makes a file verified from a
 * worktree, from the main checkout, or through a store that parents several
 * repositories (T14005) one node with the commit-anchored form; the repository
 * itself is {@link EvidenceRepoResolver.file}'s `repo` (T14012).
 *
 * @param path - Path as the `files:` atom stored it.
 * @param executionRoot - Root of the repository the evidence is about.
 * @param storeRoot - CLEO store root.
 * @returns The normalised path, or `null`.
 * @example
 * ```ts
 * repoRelativeEvidencePath('./src/a.ts', '/repo', '/repo'); // 'src/a.ts'
 * ```
 */
export function repoRelativeEvidencePath(
  path: string,
  executionRoot: string,
  storeRoot: string,
): string | null {
  return createEvidenceRepoResolver(storeRoot).file(path, executionRoot)?.path ?? null;
}

/**
 * Link a task to the commits, files and decisions its accepted evidence names.
 *
 * @param projectRoot - Project whose brain graph is written.
 * @param taskId - Task the evidence was accepted for.
 * @param atoms - Validated atoms the verification stored.
 * @returns Counts of linked targets (repeat links count again; writes are
 *   idempotent) and the paths skipped as outside the repository.
 * @example
 * ```ts
 * await linkVerifiedEvidence(root, 'T123', evidenceStored);
 * ```
 */
export async function linkVerifiedEvidence(
  projectRoot: string,
  taskId: string,
  atoms: readonly EvidenceAtom[],
): Promise<EvidenceLinkResult> {
  const result: EvidenceLinkResult = { commits: 0, files: 0, decisions: 0, skipped: [] };
  const taskNode = `task:${taskId}`;
  const nodes: Array<{ id: string; nodeType: BrainNodeType; label: string; qualityScore: number }> =
    [{ id: taskNode, nodeType: 'task', label: taskId, qualityScore: 0.7 }];
  const edges: Array<{
    fromId: string;
    toId: string;
    edgeType: BrainEdgeType;
    provenance: string;
  }> = [];
  const shas: string[] = [];
  for (const atom of atoms) {
    if (atom.kind === 'commit') shas.push(atom.sha);
    else if (atom.kind === 'pr') shas.push(atom.mergeCommitSha);
  }
  const repos = createEvidenceRepoResolver(projectRoot);
  let executionRoot: string | undefined;
  for (const atom of atoms) {
    if (atom.kind === 'files') {
      // The same anchor validateAtom hands the resolver for a files: atom.
      executionRoot ??= resolveEvidenceExecutionRoot(
        projectRoot,
        undefined,
        shas[0] ? { commitSha: shas[0] } : {},
      );
      for (const file of atom.files) {
        const key = repos.file(file.path, executionRoot);
        if (key === null) {
          result.skipped.push(file.path);
          continue;
        }
        const fileNode = repoQualifiedNodeId('file', key.repo, key.path);
        nodes.push({ id: fileNode, nodeType: 'file', label: key.path, qualityScore: 0.8 });
        edges.push({
          fromId: taskNode,
          toId: fileNode,
          edgeType: 'touches_code',
          provenance: EVIDENCE_EDGE_PROVENANCE,
        });
        result.files++;
      }
    } else if (atom.kind === 'decision') {
      const decisionNode = `decision:${atom.decisionId}`;
      nodes.push({
        id: decisionNode,
        nodeType: 'decision',
        label: atom.decisionId,
        qualityScore: 0.8,
      });
      edges.push({
        fromId: decisionNode,
        toId: taskNode,
        edgeType: 'applies_to',
        provenance: EVIDENCE_EDGE_PROVENANCE,
      });
      result.decisions++;
    }
  }
  await writeGraphBatch(projectRoot, nodes, edges);
  const failed: Array<{ sha: string; error: unknown }> = [];
  for (const sha of shas) {
    try {
      // The same rule as files; a commit no single repository holds stays unqualified.
      await ensureCommitNode(projectRoot, sha, taskId, {
        provenance: EVIDENCE_EDGE_PROVENANCE,
        explicit: true,
        repo: repos.commit(sha)?.repo ?? null,
      });
      result.commits++;
    } catch (error) {
      failed.push({ sha, error });
    }
  }
  if (failed.length > 0) {
    const first = failed[0]?.error;
    // @sync-invariant none:local-only the verification already committed; the caller warns
    throw new Error(
      `commit links failed for ${failed.map((f) => f.sha.slice(0, 12)).join(', ')}; ` +
        `written: task, ${result.files} file, ${result.decisions} decision and ${result.commits} commit link(s): ` +
        (first instanceof Error ? first.message : String(first)),
    );
  }
  return result;
}

/** One evidence edge re-pointed by {@link migrateEvidenceRepoIds}. */
export interface EvidenceRepoMove {
  /** Source node of the edge (`task:<id>`). */
  from: string;
  /** Unqualified node id the edge pointed at. */
  oldTarget: string;
  /** Repo-qualified node id it points at now. */
  newTarget: string;
}

/** What {@link migrateEvidenceRepoIds} moved and left. */
export interface EvidenceRepoMigrationResult {
  /** True when nothing was written (the default; `apply` writes). */
  dryRun: boolean;
  /** Receipt an apply wrote before its first write, or `null` for a dry run. */
  receiptPath: string | null;
  /** Evidence edges re-pointed (or, in a dry run, that would be). */
  moved: EvidenceRepoMove[];
  /** Repo-qualified nodes created, each from the old node it copies. */
  nodes: Array<{ oldId: string; newId: string }>;
  /** Evidence edges left unchanged because their repository cannot be told. */
  unresolved: Array<{ from: string; target: string; reason: string }>;
}

/** Receipt of an applied {@link migrateEvidenceRepoIds} run: every old id → new id. */
export interface EvidenceRepoMigrationReceipt {
  /** Receipt format version. */
  version: 1;
  /** ISO timestamp of the apply. */
  migratedAt: string;
  /** `started` before the first write; `complete` once the transaction committed. */
  status: 'started' | 'complete';
  /** Edges re-pointed, old target → new target. */
  moved: EvidenceRepoMove[];
  /** Nodes created, old id → new id. Old nodes are kept for a later prune. */
  nodes: Array<{ oldId: string; newId: string }>;
  /** Edges left unchanged. */
  unresolved: EvidenceRepoMigrationResult['unresolved'];
}

/**
 * Default receipt path of an applied evidence repo-id migration.
 *
 * @param projectRoot - Project root.
 * @param migratedAt - ISO timestamp of the apply.
 * @returns Absolute receipt path under `.cleo/backups/migrations/`.
 * @example
 * ```ts
 * defaultEvidenceRepoReceiptPath(root, '2026-10-24T00:00:00.000Z');
 * ```
 * @task T14012
 */
export function defaultEvidenceRepoReceiptPath(projectRoot: string, migratedAt: string): string {
  return join(
    projectRoot,
    '.cleo',
    'backups',
    'migrations',
    `evidence-repo-ids-${migratedAt.replace(/[:.]/g, '-')}.json`,
  );
}

/** A node's metadata object, or an empty one when absent or not an object. */
function parseMetadata(json: string | null): Record<string, unknown> {
  if (json === null) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : {};
  } catch {
    return {};
  }
}

/** Write a receipt atomically, creating its directory. */
function writeReceipt(path: string, receipt: EvidenceRepoMigrationReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  writeJsonFileAtomic(path, receipt);
}

/**
 * Forward migration of evidence file and commit node ids to repo-qualified ids
 * (T14012), by the rule {@link createEvidenceRepoResolver} applies to new links.
 *
 * Only `evidence:verify` edges move. A commit belongs to the repository whose
 * checkout contains it. A file belongs to the one repository whose checkout has
 * its path, or, when several do, to the one the same task's commits belong to.
 * Anything still ambiguous or absent everywhere is reported in `unresolved`
 * and left as it is. Old nodes are never deleted here (other tables and
 * writers may still reference them; a later prune owns that); a copied commit
 * node records its `repo` in its metadata. Re-running is a no-op.
 *
 * A dry run is the default; only `apply` writes, after recording a receipt
 * (status `started`, every old id → new id) and completing it once the single
 * transaction commits. It never runs automatically.
 *
 * @param projectRoot - CLEO store root.
 * @param options - `apply` writes; `receiptPath` overrides the default; `now` for tests.
 * @returns The moves, the created nodes, the unresolved edges and the receipt path.
 * @example
 * ```ts
 * const plan = await migrateEvidenceRepoIds(root);
 * const done = await migrateEvidenceRepoIds(root, { apply: true });
 * ```
 * @task T14012
 */
export async function migrateEvidenceRepoIds(
  projectRoot: string,
  options: { apply?: boolean; receiptPath?: string; now?: Date } = {},
): Promise<EvidenceRepoMigrationResult> {
  const result: EvidenceRepoMigrationResult = {
    dryRun: options.apply !== true,
    receiptPath: null,
    moved: [],
    nodes: [],
    unresolved: [],
  };
  const repos = createEvidenceRepoResolver(projectRoot);
  const checkouts = repos.checkouts();
  const db = await getBrainDb(projectRoot);
  const evidenceEdges = db
    .select()
    .from(brainPageEdges)
    .where(
      and(
        eq(brainPageEdges.provenance, EVIDENCE_EDGE_PROVENANCE),
        eq(brainPageEdges.edgeType, 'touches_code'),
      ),
    )
    .all();

  // Repositories each task's commits belong to (`null` = the primary repository).
  const taskRepos = new Map<string, Set<string | null>>();
  for (const edge of evidenceEdges) {
    if (!edge.toId.startsWith('commit:')) continue;
    const rest = edge.toId.slice('commit:'.length);
    const at = rest.lastIndexOf(REPO_ID_SEPARATOR);
    const owner = at === -1 ? repos.commit(rest) : { repo: rest.slice(0, at) };
    if (owner === null) continue;
    const set = taskRepos.get(edge.fromId) ?? new Set<string | null>();
    set.add(owner.repo);
    taskRepos.set(edge.fromId, set);
  }

  const moves: Array<{ edge: (typeof evidenceEdges)[number]; newTarget: string }> = [];
  for (const edge of evidenceEdges) {
    const target = edge.toId;
    if (target.includes(REPO_ID_SEPARATOR)) continue;
    let newTarget: string | null = null;
    if (target.startsWith('commit:')) {
      const sha = target.slice('commit:'.length);
      const owner = repos.commit(sha);
      if (owner === null) {
        result.unresolved.push({
          from: edge.fromId,
          target,
          reason:
            'no known checkout, or checkouts of more than one repository, contain this commit',
        });
        continue;
      }
      if (owner.repo !== null) newTarget = repoQualifiedNodeId('commit', owner.repo, sha);
    } else if (target.startsWith('file:')) {
      const path = target.slice('file:'.length);
      const candidates = new Map<string, string | null>();
      for (const base of [projectRoot, ...checkouts]) {
        const abs = join(base, path);
        if (!existsSync(abs) && !(base !== projectRoot && gitHeadHasPath(base, path))) continue;
        const key = repos.file(abs, base);
        if (key) candidates.set(repoQualifiedNodeId('file', key.repo, key.path), key.repo);
      }
      let picks = [...candidates.keys()];
      const fromTask = taskRepos.get(edge.fromId);
      if (picks.length > 1 && fromTask) {
        picks = picks.filter((id) => fromTask.has(candidates.get(id) ?? null));
      }
      if (picks.length !== 1) {
        result.unresolved.push({
          from: edge.fromId,
          target,
          reason:
            candidates.size === 0
              ? 'no checkout has this path'
              : "more than one checkout has this path and the task's commits do not decide",
        });
        continue;
      }
      newTarget = picks[0] ?? null;
    }
    if (newTarget !== null && newTarget !== target) moves.push({ edge, newTarget });
  }
  for (const { edge, newTarget } of moves) {
    result.moved.push({ from: edge.fromId, oldTarget: edge.toId, newTarget });
  }
  const pairs = new Map(moves.map((m) => [m.newTarget, m.edge.toId]));
  result.nodes = [...pairs].map(([newId, oldId]) => ({ oldId, newId }));
  if (result.dryRun) return result;

  const at = (options.now ?? new Date()).toISOString();
  const receiptPath = options.receiptPath ?? defaultEvidenceRepoReceiptPath(projectRoot, at);
  const receipt: EvidenceRepoMigrationReceipt = {
    version: 1,
    migratedAt: at,
    status: 'started',
    moved: result.moved,
    nodes: result.nodes,
    unresolved: result.unresolved,
  };
  writeReceipt(receiptPath, receipt);
  result.receiptPath = receiptPath;
  // @sync-side-effect identity.local-minting copies evidence file and commit nodes to repo-qualified ids and re-points their edges (T14012)
  db.transaction((tx) => {
    for (const { oldId, newId } of result.nodes) {
      const old = tx.select().from(brainPageNodes).where(eq(brainPageNodes.id, oldId)).get();
      const sep = newId.lastIndexOf(REPO_ID_SEPARATOR);
      const repo = newId.slice(newId.indexOf(':') + 1, sep);
      const label = newId.slice(sep + REPO_ID_SEPARATOR.length);
      const isCommit = newId.startsWith('commit:');
      const metadataJson = isCommit
        ? JSON.stringify({ ...parseMetadata(old?.metadataJson ?? null), repo })
        : (old?.metadataJson ?? null);
      tx.insert(brainPageNodes)
        .values(
          old
            ? { ...old, id: newId, metadataJson }
            : { id: newId, nodeType: isCommit ? 'commit' : 'file', label, metadataJson },
        )
        .onConflictDoNothing()
        .run();
    }
    for (const { edge, newTarget } of moves) {
      tx.insert(brainPageEdges)
        .values({ ...edge, toId: newTarget })
        .onConflictDoNothing()
        .run();
      tx.delete(brainPageEdges)
        .where(
          and(
            eq(brainPageEdges.fromId, edge.fromId),
            eq(brainPageEdges.toId, edge.toId),
            eq(brainPageEdges.edgeType, edge.edgeType),
          ),
        )
        .run();
    }
  });
  writeReceipt(receiptPath, { ...receipt, status: 'complete' });
  return result;
}
