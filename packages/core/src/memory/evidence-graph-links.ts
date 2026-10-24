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
 * `skipped`. In a store that parents several repositories, file and commit ids
 * of every repository but the store's own carry a repository key
 * (`file:<repo>::<path>`, `commit:<repo>::<sha>`; T14012), so same-named files
 * in two child repositories stay separate nodes.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @module memory/evidence-graph-links
 * @task T13950
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { EvidenceAtom } from '@cleocode/contracts';
import { and, eq, or } from 'drizzle-orm';
import {
  findNestedGitWorkTrees,
  findWorkTreeContainingCommit,
  gitCommonDir,
  gitHeadHasPath,
  gitOriginUrl,
  gitSubmoduleToplevels,
  gitToplevel,
} from '../git/work-tree.js';
import { normalizeRemoteUrl } from '../nexus/identity.js';
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
   * execution and the store root.
   */
  file(path: string, executionRoot: string): EvidenceFileKey | null;
  /**
   * Repository key of the checkout holding `dir`: `null` for the store's own
   * repository, for a directory in no checkout, and for an outer repository
   * that tracks nothing under the store root.
   */
  repoOf(dir: string): string | null;
}

/** Classification of a checkout toplevel relative to the store. */
type CheckoutClass = { kind: 'store' } | { kind: 'ignored' } | { kind: 'repo'; key: string };

/**
 * Create an {@link EvidenceRepoResolver} for one CLEO store.
 *
 * The store's own repository is the checkout whose toplevel is the store root,
 * any worktree of it, or an outer repository that tracks files under the store
 * root (a store inside a monorepo). Its files and commits keep unqualified ids,
 * so single-repo stores never change. Every other checkout — a child
 * repository of a store that parents several, or a submodule — is keyed by its
 * normalised `origin` URL, which is the same on every device; without an
 * origin, by its main checkout's directory relative to the store root. An outer
 * repository that tracks nothing under the store root (a dotfiles repository at
 * `~`) is ignored: files under the store root are keyed against the store root.
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
  let storeCommonDir: string | null | undefined;

  const toplevelOf = (dir: string): string | null => {
    let top = toplevels.get(dir);
    if (top === undefined) {
      top = gitToplevel(dir);
      toplevels.set(dir, top);
    }
    return top;
  };

  const storeCommon = (): string | null => {
    if (storeCommonDir !== undefined) return storeCommonDir;
    storeCommonDir = null;
    const top = existsSync(storeRoot) ? toplevelOf(storeRoot) : null;
    if (top !== null) {
      const rel = posixInside(relative(real(top), real(storeRoot)));
      if (rel === '' || (rel !== null && gitHeadHasPath(top, rel))) {
        storeCommonDir = gitCommonDir(top);
      }
    }
    return storeCommonDir;
  };

  const classify = (top: string): CheckoutClass => {
    const cached = classes.get(top);
    if (cached) return cached;
    const common = gitCommonDir(top);
    const store = storeCommon();
    let result: CheckoutClass;
    if (common !== null && common === store) result = { kind: 'store' };
    else if (top !== real(storeRoot) && within(top, storeRoot)) result = { kind: 'ignored' };
    else {
      const main = common !== null && basename(common) === '.git' ? dirname(common) : top;
      const rel = posixInside(relative(real(storeRoot), real(main)));
      const key =
        normalizeRemoteUrl(gitOriginUrl(top)) ??
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

  return {
    file(path, executionRoot) {
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
      const top = existsSync(dir) ? toplevelOf(dir) : null;
      if (top === null) return null;
      const cls = classify(top);
      return cls.kind === 'repo' ? cls.key : null;
    },
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
      // Each commit is anchored in the checkout that holds it, as validateAtom did.
      const repo = repos.repoOf(
        resolveEvidenceExecutionRoot(projectRoot, undefined, { commitSha: sha }),
      );
      await ensureCommitNode(projectRoot, sha, taskId, {
        provenance: EVIDENCE_EDGE_PROVENANCE,
        explicit: true,
        repo,
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

/** What {@link migrateEvidenceRepoIds} moved, left and removed. */
export interface EvidenceRepoMigrationResult {
  /** True when nothing was written. */
  dryRun: boolean;
  /** Evidence edges re-pointed from an unqualified node to a repo-qualified one. */
  moved: Array<{ from: string; oldTarget: string; newTarget: string }>;
  /** Evidence edges left unchanged because their repository cannot be told. */
  unresolved: Array<{ from: string; target: string; reason: string }>;
  /** Old nodes deleted because no edge used them any more. */
  removedNodes: string[];
}

/**
 * Forward migration of evidence file and commit node ids to repo-qualified ids
 * in a store that parents several repositories (T14012).
 *
 * Only `evidence:verify` edges move; edges from other writers (decision text
 * references, for example) stay on the old node, which is deleted only when no
 * edge uses it any more. A commit belongs to the one checkout that contains it.
 * A file belongs to the one checkout that has its path, or, when several do,
 * to the one the same task's commits belong to; anything still ambiguous or
 * absent everywhere is reported in `unresolved` and left as it is. A store with
 * no repository but its own has nothing to migrate. Re-running is a no-op.
 *
 * @param projectRoot - CLEO store root.
 * @param options - `dryRun` reports the plan without writing.
 * @returns The moves, the unresolved edges and the removed nodes.
 * @example
 * ```ts
 * const plan = await migrateEvidenceRepoIds(root, { dryRun: true });
 * ```
 * @task T14012
 */
export async function migrateEvidenceRepoIds(
  projectRoot: string,
  options: { dryRun?: boolean } = {},
): Promise<EvidenceRepoMigrationResult> {
  const dryRun = options.dryRun ?? false;
  const result: EvidenceRepoMigrationResult = {
    dryRun,
    moved: [],
    unresolved: [],
    removedNodes: [],
  };
  const repos = createEvidenceRepoResolver(projectRoot);
  const storeTop = gitToplevel(projectRoot);
  const tops = [...(storeTop ? [storeTop] : []), ...findNestedGitWorkTrees(projectRoot)];
  const checkouts = [...new Set(tops.flatMap((top) => [top, ...gitSubmoduleToplevels(top)]))];
  if (!checkouts.some((checkout) => repos.repoOf(checkout) !== null)) return result;

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

  const owners = new Map<string, string | null>();
  const ownerOf = (sha: string): string | null => {
    let owner = owners.get(sha);
    if (owner === undefined) {
      owner = findWorkTreeContainingCommit(checkouts, sha);
      owners.set(sha, owner);
    }
    return owner;
  };
  const qualified = (id: string): boolean => id.includes(REPO_ID_SEPARATOR);
  // Repositories each task's commits belong to (`null` = the store's own).
  const taskRepos = new Map<string, Set<string | null>>();
  for (const edge of evidenceEdges) {
    if (!edge.toId.startsWith('commit:')) continue;
    const rest = edge.toId.slice('commit:'.length);
    const at = rest.lastIndexOf(REPO_ID_SEPARATOR);
    let repo: string | null = at === -1 ? null : rest.slice(0, at);
    if (at === -1) {
      const owner = ownerOf(rest);
      if (owner === null) continue;
      repo = repos.repoOf(owner);
    }
    const set = taskRepos.get(edge.fromId) ?? new Set<string | null>();
    set.add(repo);
    taskRepos.set(edge.fromId, set);
  }

  const moves: Array<{ edge: (typeof evidenceEdges)[number]; newTarget: string }> = [];
  for (const edge of evidenceEdges) {
    const target = edge.toId;
    if (qualified(target)) continue;
    let newTarget: string | null = null;
    if (target.startsWith('commit:')) {
      const sha = target.slice('commit:'.length);
      const owner = ownerOf(sha);
      if (owner === null) {
        result.unresolved.push({
          from: edge.fromId,
          target,
          reason: 'no checkout, or more than one, contains this commit',
        });
        continue;
      }
      const repo = repos.repoOf(owner);
      if (repo !== null) newTarget = repoQualifiedNodeId('commit', repo, sha);
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
  if (moves.length === 0) return result;

  const oldIds = [...new Set(moves.map((m) => m.edge.toId))];
  // An old node goes once no edge uses it; a dry run predicts that from the moves.
  if (dryRun) {
    for (const id of oldIds) {
      const uses = db
        .select({ fromId: brainPageEdges.fromId })
        .from(brainPageEdges)
        .where(or(eq(brainPageEdges.fromId, id), eq(brainPageEdges.toId, id)))
        .all().length;
      if (uses === moves.filter((m) => m.edge.toId === id).length) result.removedNodes.push(id);
    }
  }
  if (dryRun) return result;
  // @sync-side-effect identity.local-minting renames evidence file and commit nodes and re-points their edges (T14012)
  db.transaction((tx) => {
    for (const { edge, newTarget } of moves) {
      const old = tx.select().from(brainPageNodes).where(eq(brainPageNodes.id, edge.toId)).get();
      const label = newTarget.slice(
        newTarget.lastIndexOf(REPO_ID_SEPARATOR) + REPO_ID_SEPARATOR.length,
      );
      tx.insert(brainPageNodes)
        .values(
          old
            ? { ...old, id: newTarget }
            : {
                id: newTarget,
                nodeType: newTarget.startsWith('commit:') ? 'commit' : 'file',
                label,
              },
        )
        .onConflictDoNothing()
        .run();
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
    for (const id of oldIds) {
      const used = tx
        .select({ fromId: brainPageEdges.fromId })
        .from(brainPageEdges)
        .where(or(eq(brainPageEdges.fromId, id), eq(brainPageEdges.toId, id)))
        .get();
      if (used) continue;
      tx.delete(brainPageNodes).where(eq(brainPageNodes.id, id)).run();
      result.removedNodes.push(id);
    }
  });
  return result;
}
