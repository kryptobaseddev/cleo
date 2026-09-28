/**
 * Implemented change-set derivation for the streamlined verification flow.
 *
 * Given a task, find the work that implements it, first match wins:
 *
 *  1. a merged PR that cites the task — files read from its merge commit;
 *  2. the unmerged task branch, diffed against its merge-base with origin's
 *     default branch;
 *  3. for research, spike and documentation tasks, the attached docs and the
 *     decisions linked to the task.
 *
 * The result is an atom string for the EXISTING ADR-051 validators
 * (`parseEvidence` → `validateAtom` → `checkGateEvidenceMinimum` →
 * `checkTaskEvidenceContext`). Nothing here validates, records or writes:
 * every git and gh call is a read, and the PR lookup runs with
 * `readOnly: true` so not even the PR cache is written.
 *
 * Every git and gh call runs in one resolved execution root: a declared
 * `evidence.gitRoot` first, then the caller's own worktree of this project,
 * then — when invoked from the main checkout — the task's registered
 * worktree, then the store root (or its single child checkout).
 *
 * Paths are repo-relative, which is the portable form the `files:` atom
 * stores; deleted paths are reported separately and never enter `files:`,
 * because a deleted file has no bytes to hash.
 *
 * Spec: `verify-streamlined-design` §3.2 step 2 and §6.
 *
 * @task T12624
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type {
  ChangeSetDoc,
  ChangeSetRootSource,
  DonePlanBlocker,
  Task,
  TaskChangeSet,
} from '@cleocode/contracts';
import { gitToplevel, resolveDeclaredEvidenceGitRoot } from '../git/work-tree.js';
import type { PrAtomResolution } from '../release/pr-evidence.js';
import { enumerateWorktrees } from '../worktree/list.js';
import {
  classifyEvidenceTask,
  diffIntersectsAc,
  type EvidenceRoots,
  resolveEvidenceExecutionRoot,
} from './evidence.js';

/** Task fields change-set derivation reads. */
export type ChangeSetTask = Pick<Task, 'id' | 'kind' | 'labels' | 'files' | 'acceptance'> & {
  verification?: Task['verification'];
};

/** A merged PR as returned by discovery, before verification. */
export interface MergedPrSummary {
  /** PR number. */
  number: number;
  /** PR title. */
  title: string;
  /** PR body. */
  body: string;
  /** Head branch. */
  headRefName: string;
  /** Merge time, when discovery reports it (orders a revert after its original). */
  mergedAt?: string | null;
}

/** One PR as `gh pr view` reports it: where it merged, and its commits. */
export interface PrDetails {
  /** PR number. */
  number: number;
  /** PR title. */
  title: string;
  /** Head branch. */
  headRefName: string;
  /** Branch the PR merged (or will merge) into. */
  baseRefName: string;
  /** `MERGED`, `OPEN` or `CLOSED`. */
  state: string;
  /** Merge time, or null when unmerged. */
  mergedAt: string | null;
  /** Head branch tip the PR carried. */
  headRefOid: string | null;
  /** Merge commit, or null when unmerged. */
  mergeCommitSha: string | null;
}

/** A document attached to a task, as the docs read model reports it. */
export interface TaskDocRef {
  /** Attachment or blob identifier. */
  id: string;
  /** Stable slug, when present. */
  slug: string | null;
  /** Content sha256 — locates the stored bytes. */
  sha256: string;
}

/**
 * Injectable I/O for {@link deriveTaskChangeSet}. Every member defaults to the
 * real implementation; tests replace the `gh` and store readers.
 */
export interface ChangeSetDeps {
  /** Merged PRs whose title, body or head branch may cite the task. */
  listMergedPrs?: (
    taskId: string,
    executionRoot: string,
  ) => Promise<{ ok: true; prs: MergedPrSummary[] } | { ok: false; reason: string }>;
  /** One PR's base branch, state and commits (`gh pr view`); null when unknown. */
  viewPr?: (prNumber: number, executionRoot: string) => Promise<PrDetails | null>;
  /** The PR whose head is `branch` — merged first, else newest; null when none. */
  findPrByHead?: (branch: string, executionRoot: string) => Promise<PrDetails | null>;
  /** Verify one PR through the existing `pr:` provenance code. */
  resolvePr?: (prNumber: number, roots: EvidenceRoots) => Promise<PrAtomResolution>;
  /** Documents attached to the task. */
  listTaskDocs?: (storeRoot: string, taskId: string) => Promise<TaskDocRef[]>;
  /** Accepted or proposed decisions linked to the task. */
  listTaskDecisions?: (storeRoot: string, taskId: string) => Promise<string[]>;
  /** Environment for declared git-root resolution. */
  env?: NodeJS.ProcessEnv;
}

/** Input to {@link deriveTaskChangeSet}. */
export interface DeriveChangeSetInput {
  /** The task whose work is being located. */
  task: ChangeSetTask;
  /** CLEO store root. */
  storeRoot: string;
  /** Directory the command was invoked from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Explicit PR (`--pr <n>`); replaces candidate selection (discovery still runs, to find reverts). */
  prNumber?: number;
}

/** Run git read-only in `cwd`; `null` on any failure. */
function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).trimEnd();
  } catch {
    return null;
  }
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolvePath(path);
  }
}

/** `(^|non-alnum)T123(non-alnum|$)` — T123 never matches inside T1234. */
function citesTask(text: string, taskId: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${taskId}([^A-Za-z0-9]|$)`).test(text);
}

function blocker(
  code: DonePlanBlocker['code'],
  message: string,
  command: string,
  why: string,
  cause?: string,
): DonePlanBlocker {
  return { code, message, next: { command, why }, ...(cause ? { cause } : {}) };
}

/**
 * Resolve the repository a task's change set is read from.
 *
 * Order: declared git root → the invocation's own worktree of this project →
 * the task's registered worktree (only when invoked from the main checkout)
 * → the store root or its single child checkout, as
 * {@link resolveEvidenceExecutionRoot} already decides.
 *
 * @param storeRoot - CLEO store root.
 * @param taskId - Task whose registered worktree to look for.
 * @param cwd - Invocation directory.
 * @param env - Environment for the declared-root tier.
 * @returns The execution root and why it was chosen.
 * @task T12624
 */
export function resolveChangeSetRoot(
  storeRoot: string,
  taskId: string,
  cwd: string = process.cwd(), // CWD-OK: the invocation dir is the subject (gh#1220)
  env: NodeJS.ProcessEnv = process.env,
): { root: string; source: ChangeSetRootSource } {
  const declared = resolveDeclaredEvidenceGitRoot(storeRoot, env);
  if (declared !== null) {
    return { root: gitToplevel(declared.path) ?? declared.path, source: 'declared' };
  }
  const base = resolveEvidenceExecutionRoot(storeRoot, cwd);
  const mainCheckout = git(base, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const isLinkedWorktree =
    mainCheckout !== null &&
    canonical(join(base, '.git')) !== canonical(mainCheckout) &&
    canonical(base) !== canonical(storeRoot);
  if (isLinkedWorktree) return { root: base, source: 'invocation-worktree' };

  let worktrees: ReturnType<typeof enumerateWorktrees> = [];
  try {
    worktrees = enumerateWorktrees(base);
  } catch {
    worktrees = [];
  }
  const own = worktrees.find(
    (entry) =>
      (entry.branch === `task/${taskId}` || entry.branch.startsWith(`task/${taskId}-`)) &&
      existsSync(entry.path) &&
      canonical(entry.path) !== canonical(base),
  );
  if (own) return { root: own.path, source: 'task-worktree' };
  return { root: base, source: 'store' };
}

/** Split `git diff --name-status --no-renames` output into kept and deleted paths. */
function parseNameStatus(output: string): { files: string[]; deleted: string[] } {
  const files: string[] = [];
  const deleted: string[] = [];
  for (const line of output.split('\n')) {
    const [status, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!status || !path) continue;
    if (status.startsWith('D')) deleted.push(path);
    else files.push(path);
  }
  return { files, deleted };
}

/** `origin/<default>` from `origin/HEAD`, never from a possibly stale local branch. */
function resolveOriginDefault(root: string): string | null {
  const symbolic = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symbolic) return symbolic.replace(/^refs\/remotes\//, '');
  for (const candidate of ['origin/main', 'origin/master']) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${candidate}`]) !== null)
      return candidate;
  }
  return null;
}

/** Default merged-PR discovery: `gh pr list` by search text and by task branch. */
async function defaultListMergedPrs(
  taskId: string,
  executionRoot: string,
): Promise<{ ok: true; prs: MergedPrSummary[] } | { ok: false; reason: string }> {
  const { isGhCliAvailable } = await import('../release/github-pr.js');
  if (!isGhCliAvailable()) return { ok: false, reason: 'gh CLI is not available on PATH' };
  const fields = 'number,title,body,headRefName,mergedAt';
  const queries: string[][] = [
    ['--search', taskId],
    ['--head', `task/${taskId}`],
  ];
  const byNumber = new Map<number, MergedPrSummary>();
  for (const query of queries) {
    try {
      const out = execFileSync(
        'gh',
        ['pr', 'list', '--state', 'merged', ...query, '--json', fields, '--limit', '30'],
        { cwd: executionRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const parsed: unknown = JSON.parse(out);
      if (!Array.isArray(parsed)) continue;
      for (const row of parsed as MergedPrSummary[]) {
        if (typeof row?.number === 'number') byNumber.set(row.number, row);
      }
    } catch (err) {
      return {
        ok: false,
        reason: `gh pr list failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      };
    }
  }
  return { ok: true, prs: [...byNumber.values()] };
}

const PR_DETAIL_FIELDS =
  'number,title,headRefName,baseRefName,state,mergedAt,headRefOid,mergeCommit';

/** Normalise one `gh pr view/list --json PR_DETAIL_FIELDS` row. */
function toPrDetails(row: unknown): PrDetails | null {
  if (row === null || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.number !== 'number') return null;
  const merge = r.mergeCommit as { oid?: unknown } | null | undefined;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    number: r.number,
    title: str(r.title),
    headRefName: str(r.headRefName),
    baseRefName: str(r.baseRefName),
    state: str(r.state),
    mergedAt: typeof r.mergedAt === 'string' && r.mergedAt !== '' ? r.mergedAt : null,
    headRefOid: typeof r.headRefOid === 'string' ? r.headRefOid : null,
    mergeCommitSha: typeof merge?.oid === 'string' ? merge.oid : null,
  };
}

/** Run a read-only `gh` query; `null` on any failure. */
function ghJson(args: readonly string[], cwd: string): unknown {
  try {
    return JSON.parse(
      execFileSync('gh', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  } catch {
    return null;
  }
}

/** Default {@link ChangeSetDeps.viewPr}: `gh pr view <n>`. */
async function defaultViewPr(prNumber: number, executionRoot: string): Promise<PrDetails | null> {
  return toPrDetails(
    ghJson(['pr', 'view', String(prNumber), '--json', PR_DETAIL_FIELDS], executionRoot),
  );
}

/** Default {@link ChangeSetDeps.findPrByHead}: `gh pr list --head <branch> --state all`. */
async function defaultFindPrByHead(
  branch: string,
  executionRoot: string,
): Promise<PrDetails | null> {
  const rows = ghJson(
    ['pr', 'list', '--head', branch, '--state', 'all', '--json', PR_DETAIL_FIELDS, '--limit', '10'],
    executionRoot,
  );
  if (!Array.isArray(rows)) return null;
  const prs = rows.map(toPrDetails).filter((p): p is PrDetails => p !== null);
  return prs.find((p) => p.state === 'MERGED') ?? prs[0] ?? null;
}

/** Default PR verification: the existing `pr:` provenance code, persisting nothing. */
async function defaultResolvePr(prNumber: number, roots: EvidenceRoots): Promise<PrAtomResolution> {
  const { resolvePrEvidenceAtom } = await import('../release/pr-evidence.js');
  const { loadProjectContext } = await import('../agents/variable-substitution.js');
  const ctx = loadProjectContext(roots.storeRoot);
  return resolvePrEvidenceAtom(prNumber, roots, {
    projectContext: ctx.loaded ? ctx.context : null,
    readOnly: true,
  });
}

/** Default attached-docs reader: the same read model `cleo docs list --task` uses. */
async function defaultListTaskDocs(storeRoot: string, taskId: string): Promise<TaskDocRef[]> {
  const { createDocsReadModel } = await import('../docs/docs-read-model.js');
  const model = createDocsReadModel(storeRoot);
  try {
    const docs = await model.resolveByOwner(taskId);
    return docs.map((doc) => ({ id: doc.id, slug: doc.slug, sha256: doc.sha256 }));
  } finally {
    model.close();
  }
}

/** Default decision reader: decisions whose context task, or brain link, is this task. */
async function defaultListTaskDecisions(storeRoot: string, taskId: string): Promise<string[]> {
  const { getBrainDb } = await import('../store/memory-sqlite.js');
  const { eq } = await import('drizzle-orm');
  const { brainDecisions } = await import('../store/schema/memory-schema.js');
  const db = await getBrainDb(storeRoot);
  const rows = await db
    .select()
    .from(brainDecisions)
    .where(eq(brainDecisions.contextTaskId, taskId))
    .all();
  const { getLinkedDecisions } = await import('../memory/brain-links.js');
  const linked = await getLinkedDecisions(storeRoot, taskId).catch(() => []);
  const ids = new Set<string>();
  for (const row of [...rows, ...linked]) {
    const state = (row as { confirmationState?: string | null }).confirmationState ?? '';
    if (state === 'accepted' || state === 'proposed') ids.add(row.id);
  }
  return [...ids].sort();
}

/**
 * Locate the stored bytes of an attached doc, as a store-relative path the
 * `files:` validator can hash: the content-addressed blob, else the
 * attachment store copy.
 */
function locateDocBytes(storeRoot: string, sha256: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const blob = join('.cleo', 'blobs', 'blobs', sha256);
  if (existsSync(join(storeRoot, blob))) return blob;
  const dir = join('.cleo', 'attachments', 'sha256', sha256.slice(0, 2));
  try {
    const hit = readdirSync(join(storeRoot, dir)).find(
      (name) => name === sha256.slice(2) || name.startsWith(`${sha256.slice(2)}.`),
    );
    return hit ? join(dir, hit) : null;
  } catch {
    return null;
  }
}

function emptyChangeSet(root: string, rootSource: ChangeSetRootSource): TaskChangeSet {
  return {
    source: 'none',
    executionRoot: root,
    rootSource,
    files: [],
    deletedFiles: [],
    docs: [],
    decisions: [],
    candidates: [],
    implementedEvidence: null,
    blockers: [],
    warnings: [],
  };
}

/** `a;b` separators and `,` inside a files list cannot be carried by the atom grammar. */
function atomSafe(text: string): string {
  return text.replace(/[;\n]/g, ',').trim();
}

/** First-parent name-status of a merge (or squash) commit. */
function mergeCommitChanges(root: string, sha: string): { files: string[]; deleted: string[] } {
  return parseNameStatus(
    git(root, [
      'diff-tree',
      '--root',
      '--no-commit-id',
      '-r',
      '--name-status',
      '--no-renames',
      '-m',
      '--first-parent',
      sha,
    ]) ?? '',
  );
}

function hasCommit(root: string, sha: string | null): boolean {
  return sha !== null && git(root, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
}

/** A GitHub revert PR: `Revert "…"` by default, `revert:` by convention. */
function isRevertTitle(title: string): boolean {
  return /^revert\b/i.test(title.trim());
}

/**
 * The task's PR merged into another branch — a stacked PR. Its merge commit
 * is on that branch, not on the default branch, so `pr:` provenance cannot
 * attribute it. Once the base branch's own PR has merged to the default
 * branch AND its head contains the stacked merge, the task is attributed to
 * that base merge commit via `commit:` + the stacked PR's surviving files;
 * otherwise a `pr-stacked` blocker names the base branch and its PR.
 */
async function deriveStackedChangeSet(
  cs: TaskChangeSet,
  taskId: string,
  root: string,
  pr: PrDetails,
  defaultBranch: string,
  findPrByHead: NonNullable<ChangeSetDeps['findPrByHead']>,
): Promise<true> {
  const baseRef = pr.baseRefName;
  const basePr = await findPrByHead(baseRef, root);
  cs.stackedOn = { baseRef, ...(basePr ? { basePrNumber: basePr.number } : {}) };
  const baseLanded =
    basePr !== null && basePr.state === 'MERGED' && basePr.baseRefName === defaultBranch;
  if (baseLanded && hasCommit(root, pr.mergeCommitSha) && hasCommit(root, basePr.headRefOid)) {
    const contained =
      git(root, [
        'merge-base',
        '--is-ancestor',
        pr.mergeCommitSha as string,
        basePr.headRefOid as string,
      ]) !== null;
    const baseMerge = basePr.mergeCommitSha;
    if (contained && baseMerge !== null && hasCommit(root, baseMerge)) {
      const { files, deleted } = mergeCommitChanges(root, pr.mergeCommitSha as string);
      const surviving = files.filter(
        (f) => git(root, ['cat-file', '-e', `${baseMerge}:${f}`]) !== null,
      );
      if (surviving.length > 0) {
        cs.source = 'pr';
        cs.mergeCommitSha = baseMerge;
        cs.files = surviving;
        cs.deletedFiles = deleted;
        cs.implementedEvidence = `commit:${baseMerge};files:${surviving.join(',')}`;
        return true;
      }
    }
  }
  const baseState =
    basePr === null
      ? `no PR has ${baseRef} as its head`
      : `its PR #${basePr.number} is ${basePr.state.toLowerCase()} into ${basePr.baseRefName || 'unknown'}`;
  const settled = basePr !== null && basePr.state === 'MERGED';
  cs.source = 'pr';
  cs.blockers.push(
    blocker(
      'pr-stacked',
      `PR #${pr.number} merged into ${baseRef}, not ${defaultBranch}; ${baseState}.`,
      settled ? `cleo done ${taskId} --plan --pr ${basePr.number}` : `cleo done ${taskId} --plan`,
      settled
        ? `PR #${basePr.number} is where ${baseRef} merged, but its head does not contain PR #${pr.number}'s merge; name the PR that carried the work to ${defaultBranch}.`
        : basePr !== null
          ? `Re-plan after PR #${basePr.number} (${baseRef}) merges into ${defaultBranch}.`
          : `Re-plan after ${baseRef} reaches ${defaultBranch} through its own PR.`,
    ),
  );
  return true;
}

/** Candidate numbers after the declared-files and own-branch narrowing rules. */
async function narrowCandidates(
  numbers: number[],
  cs: TaskChangeSet,
  task: ChangeSetTask,
  roots: EvidenceRoots,
  resolvePr: NonNullable<ChangeSetDeps['resolvePr']>,
  resolved: Map<number, PrAtomResolution>,
): Promise<number[]> {
  let out = numbers;
  if (out.length > 1 && task.files?.length) {
    for (const n of out) resolved.set(n, await resolvePr(n, roots));
    const intersecting = out.filter((n) => {
      const r = resolved.get(n);
      return r?.ok === true && diffIntersectsAc(r.changedPaths, task.files ?? []);
    });
    if (intersecting.length > 0) out = intersecting;
  }
  if (out.length > 1) {
    // A PR merged FROM the task's own branch (`task/<id>` or `task/<id>-…`)
    // is the task's PR; an integration PR that merely lists the id in its body
    // is not. Deterministic by branch convention, never by wording.
    const own = cs.candidates.filter(
      (c) =>
        out.includes(c.prNumber) &&
        (c.headRefName === `task/${task.id}` || c.headRefName.startsWith(`task/${task.id}-`)),
    );
    // D11151: several own-branch PRs are all the task's; the integration PRs
    // that merely list the id drop out either way.
    if (own.length >= 1) out = own.map((c) => c.prNumber).sort((a, b) => a - b);
  }
  return out;
}

/**
 * Step 1 — a merged PR that cites the task. Returns `true` when the PR path
 * decided the outcome (a change set or a blocker), `false` to fall through.
 * A PR the `pr:` validator refuses leaves a `pr-unverified` blocker and
 * returns `false`, so the caller can still try the task branch.
 */
async function derivePrChangeSet(
  cs: TaskChangeSet,
  input: DeriveChangeSetInput,
  roots: EvidenceRoots,
  deps: Required<Pick<ChangeSetDeps, 'listMergedPrs' | 'resolvePr' | 'viewPr' | 'findPrByHead'>>,
): Promise<boolean> {
  const { task } = input;
  const root = roots.executionRoot;
  const listed = await deps.listMergedPrs(task.id, root);
  if (!listed.ok) {
    cs.warnings.push(`Merged-PR discovery skipped: ${listed.reason}`);
    cs.prDiscoveryFailed = true;
  }
  const citing = (listed.ok ? listed.prs : []).filter((pr) =>
    citesTask(`${pr.title}\n${pr.body}\n${pr.headRefName}`, task.id),
  );
  const reverts = citing.filter((pr) => isRevertTitle(pr.title));
  const originals = citing.filter((pr) => !isRevertTitle(pr.title));
  cs.candidates = originals.map((pr) => ({
    prNumber: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
  }));
  let numbers =
    input.prNumber !== undefined
      ? [input.prNumber]
      : originals.map((pr) => pr.number).sort((a, b) => a - b);
  if (numbers.length === 0) return false;

  const resolved = new Map<number, PrAtomResolution>();
  numbers = await narrowCandidates(numbers, cs, task, roots, deps.resolvePr, resolved);
  const ownBranch = (n: number): boolean => {
    const head = cs.candidates.find((c) => c.prNumber === n)?.headRefName ?? '';
    return head === `task/${task.id}` || head.startsWith(`task/${task.id}-`);
  };
  // D11151: a task shipped across several of its OWN PRs (every candidate
  // merged from task/<id> or task/<id>-…) records one implemented attempt per
  // PR. Candidates that merely mention the id stay ambiguous.
  if (numbers.length > 1 && input.prNumber === undefined && numbers.every(ownBranch)) {
    return deriveMultiPrChangeSet(
      cs,
      numbers,
      { originals, reverts, resolved },
      input,
      roots,
      deps,
    );
  }
  if (numbers.length > 1) {
    const list = numbers.map((n) => `#${n}`).join(', ');
    cs.blockers.push(
      blocker(
        'pr-ambiguous',
        `${numbers.length} merged PRs cite ${task.id} (${list}) and declared task files do not narrow them to one.`,
        `cleo done ${task.id} --plan --pr ${numbers[0]}`,
        `Name the PR that implements ${task.id}; candidates: ${list}.`,
      ),
    );
    return true;
  }

  return deriveOnePr(
    cs,
    numbers[0] as number,
    { originals, reverts, resolved },
    input,
    roots,
    deps,
  );
}

/** Discovery facts one PR's derivation needs. */
interface PrDiscovery {
  originals: MergedPrSummary[];
  reverts: MergedPrSummary[];
  resolved: Map<number, PrAtomResolution>;
}

/**
 * D11151: derive every own-branch PR of the task in merge order. The latest is
 * the primary change set; the others become {@link TaskChangeSet.additionalPrs},
 * each recorded as its own `implemented` attempt. Any PR's blocker blocks.
 */
async function deriveMultiPrChangeSet(
  cs: TaskChangeSet,
  numbers: number[],
  discovery: PrDiscovery,
  input: DeriveChangeSetInput,
  roots: EvidenceRoots,
  deps: Required<Pick<ChangeSetDeps, 'listMergedPrs' | 'resolvePr' | 'viewPr' | 'findPrByHead'>>,
): Promise<boolean> {
  const ordered = [...numbers].sort((a, b) => a - b);
  const parts: TaskChangeSet[] = [];
  for (const n of ordered) {
    const part = emptyChangeSet(cs.executionRoot, cs.rootSource);
    part.candidates = cs.candidates;
    await deriveOnePr(part, n, discovery, input, roots, deps);
    parts.push(part);
  }
  const primary = parts[parts.length - 1]!;
  Object.assign(cs, { ...primary, candidates: cs.candidates });
  cs.blockers = parts.flatMap((p) => p.blockers);
  cs.warnings = [...cs.warnings, ...parts.flatMap((p) => p.warnings)];
  cs.additionalPrs = parts.slice(0, -1).map((p) => ({
    prNumber: p.prNumber as number,
    ...(p.mergeCommitSha ? { mergeCommitSha: p.mergeCommitSha } : {}),
    files: p.files,
    deletedFiles: p.deletedFiles,
    implementedEvidence: p.implementedEvidence,
  }));
  return true;
}

/** Derive the change set of one chosen PR (revert, stacked, provenance, merge files). */
async function deriveOnePr(
  cs: TaskChangeSet,
  prNumber: number,
  discovery: PrDiscovery,
  input: DeriveChangeSetInput,
  roots: EvidenceRoots,
  deps: Required<Pick<ChangeSetDeps, 'listMergedPrs' | 'resolvePr' | 'viewPr' | 'findPrByHead'>>,
): Promise<boolean> {
  const { task } = input;
  const root = roots.executionRoot;
  const { originals, reverts, resolved } = discovery;
  cs.prNumber = prNumber;
  const original = originals.find((pr) => pr.number === prNumber);
  const revert = reverts.find(
    (r) =>
      r.number !== prNumber &&
      (r.mergedAt && original?.mergedAt ? r.mergedAt > original.mergedAt : r.number > prNumber),
  );
  if (revert) {
    cs.source = 'pr';
    cs.blockers.push(
      blocker(
        'pr-reverted',
        `PR #${prNumber} was reverted by PR #${revert.number} ("${revert.title}"); its change is not on the default branch.`,
        `cleo done ${task.id} --plan --pr <the PR that re-landed the work>`,
        'A reverted PR cannot prove the task is implemented; name the PR that re-landed it.',
      ),
    );
    return true;
  }

  const defaultRef = resolveOriginDefault(root);
  const defaultBranch = defaultRef?.replace(/^origin\//, '') ?? null;
  const detail = await deps.viewPr(prNumber, root);
  if (detail && defaultBranch && detail.baseRefName && detail.baseRefName !== defaultBranch) {
    return deriveStackedChangeSet(cs, task.id, root, detail, defaultBranch, deps.findPrByHead);
  }

  const pr = resolved.get(prNumber) ?? (await deps.resolvePr(prNumber, roots));
  if (!pr.ok) {
    cs.source = 'pr';
    const gitRoot = pr.codeName === 'E_EVIDENCE_GIT_ROOT';
    cs.blockers.push(
      blocker(
        gitRoot ? 'git-root' : 'pr-unverified',
        `PR #${prNumber} cannot serve as evidence: ${pr.reason}`,
        gitRoot
          ? `CLEO_EVIDENCE_GIT_ROOT=<path to the repository> cleo done ${task.id} --plan`
          : pr.codeName === 'E_EVIDENCE_TESTS_FAILED'
            ? `gh pr checks ${prNumber}`
            : `gh pr view ${prNumber} --json state,baseRefName,mergeCommit`,
        gitRoot
          ? 'Declare the repository the evidence is about.'
          : 'The existing pr: provenance check refused this PR. The task branch diff is used instead when the branch still exists; otherwise resolve the reason it names.',
        pr.codeName,
      ),
    );
    return gitRoot;
  }

  cs.source = 'pr';
  cs.mergeCommitSha = pr.mergeCommitSha;
  if (!hasCommit(root, pr.mergeCommitSha)) {
    cs.blockers.push(
      blocker(
        'merge-commit-missing',
        `Merge commit ${pr.mergeCommitSha.slice(0, 12)} of PR #${prNumber} is not in the local object store, so its files cannot be read.`,
        `git -C '${root}' fetch origin`,
        'Evidence bytes are read from the merge commit, never from the working tree.',
      ),
    );
    return true;
  }
  const { files, deleted } = mergeCommitChanges(root, pr.mergeCommitSha);
  const prPaths = new Set(pr.changedPaths);
  cs.files = prPaths.size > 0 ? files.filter((p) => prPaths.has(p)) : files;
  // A PR shared by several tasks (batch `--pr`): each task's files: evidence
  // names only the files it declared, when any of them is in the PR.
  const declared = task.files ?? [];
  if (declared.length > 0) {
    const own = cs.files.filter((f) => diffIntersectsAc([f], declared));
    if (own.length > 0) cs.files = own;
  }
  cs.deletedFiles = deleted;
  if (cs.files.length === 0) {
    cs.blockers.push(
      blocker(
        'no-change-set',
        `PR #${prNumber}'s merge commit leaves no surviving changed file to hash (deleted: ${deleted.length}).`,
        `cleo verify ${task.id} --gate implemented --evidence "pr:${prNumber};files:<a file the PR changed>"`,
        'The implemented gate needs files evidence for an artifact the PR changed.',
      ),
    );
    return true;
  }
  cs.implementedEvidence = `pr:${prNumber};files:${cs.files.join(',')}`;
  return true;
}

/** Step 2 — the unmerged task branch or worktree. */
function deriveBranchChangeSet(cs: TaskChangeSet, taskId: string): boolean {
  const root = cs.executionRoot;
  const current = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  let headRef: string | null = null;
  if (current && current !== 'HEAD' && citesTask(current, taskId)) headRef = 'HEAD';
  else if (git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/task/${taskId}`]) !== null)
    headRef = `task/${taskId}`;
  if (headRef === null) return false;

  const baseRef = resolveOriginDefault(root);
  if (baseRef === null) {
    cs.warnings.push(`No origin default branch in ${root}; the branch diff has no base.`);
    return false;
  }
  const commitSha = git(root, ['rev-parse', headRef]);
  const mergeBase = git(root, ['merge-base', baseRef, headRef]);
  if (!commitSha || !mergeBase || commitSha === mergeBase) return false;

  cs.source = 'branch';
  cs.headRef = headRef;
  cs.baseRef = baseRef;
  cs.mergeBase = mergeBase;
  cs.commitSha = commitSha;
  const { files, deleted } = parseNameStatus(
    git(root, ['diff', '--name-status', '--no-renames', mergeBase, commitSha]) ?? '',
  );
  cs.files = files;
  cs.deletedFiles = deleted;
  if (headRef === 'HEAD') {
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty) {
      cs.blockers.push(
        blocker(
          'dirty-tree',
          `${root} has uncommitted tracked changes; evidence must describe a commit.`,
          `git -C '${root}' commit -am "<message>"`,
          'Commit (or stash) the changes so the recorded commit is the code under test.',
        ),
      );
    }
  }
  cs.implementedEvidence =
    files.length > 0
      ? `commit:${commitSha};files:${files.join(',')}`
      : `commit:${commitSha};note:${atomSafe(`removes ${deleted.length} file(s): ${deleted.join(' ')}`)}`;
  return true;
}

/** Step 3 — the documentary path for research, spike and documentation tasks. */
async function deriveDocsChangeSet(
  cs: TaskChangeSet,
  input: DeriveChangeSetInput,
  deps: Required<Pick<ChangeSetDeps, 'listTaskDocs' | 'listTaskDecisions'>>,
): Promise<boolean> {
  const { task, storeRoot } = input;
  if (classifyEvidenceTask({ task }) === 'code') return false;
  const refs = await deps.listTaskDocs(storeRoot, task.id);
  const docs: ChangeSetDoc[] = [];
  for (const ref of refs) {
    const path = locateDocBytes(storeRoot, ref.sha256);
    if (path && !docs.some((d) => d.path === path)) docs.push({ id: ref.id, slug: ref.slug, path });
  }
  const decisions = await deps.listTaskDecisions(storeRoot, task.id);
  if (docs.length === 0 && decisions.length === 0) return false;

  cs.source = 'docs';
  cs.docs = docs;
  cs.decisions = decisions;
  cs.files = docs.map((d) => d.path);
  const names = docs.map((d) => d.slug ?? d.id.slice(0, 12));
  const note = `note:${atomSafe(`Deliverable: ${names.length > 0 ? names.join(', ') : decisions.join(', ')}`)}`;
  const files = cs.files.length > 0 ? `;files:${cs.files.join(',')}` : '';
  if (decisions.length > 0) {
    cs.implementedEvidence = `decision:${decisions[0]}${files};${note}`;
    return true;
  }
  // GATE_EVIDENCE_REQUIREMENTS.implemented has no files+note alternative: a
  // task with no commit proves `implemented` through a decision. Say so rather
  // than plan an atom set the validator will refuse.
  cs.implementedEvidence = `${files.slice(1)};${note}`;
  cs.blockers.push(
    blocker(
      'decision-missing',
      `${task.id} has attached docs but no accepted or proposed decision; without a commit, implemented needs decision+files.`,
      `cleo memory decision-store --decision "<what ${task.id} concluded>" --rationale "<why>" --linked-task ${task.id}`,
      'A no-commit task proves implemented with its decision and the doc that records it.',
    ),
  );
  return true;
}

/**
 * Derive the implemented change set for a task. Read-only.
 *
 * @param input - Task, store root, invocation directory and optional `--pr`.
 * @param deps - Injectable I/O; defaults to git, gh and the CLEO stores.
 * @returns The change set, its provenance, the planned `implemented` atoms and
 *   any blockers. `source: 'none'` carries one `no-change-set` blocker.
 * @example
 * ```ts
 * const cs = await deriveTaskChangeSet({ task, storeRoot: getProjectRoot() });
 * if (cs.implementedEvidence) console.log(cs.implementedEvidence);
 * ```
 * @task T12624
 */
export async function deriveTaskChangeSet(
  input: DeriveChangeSetInput,
  deps: ChangeSetDeps = {},
): Promise<TaskChangeSet> {
  const cwd = input.cwd ?? process.cwd(); // CWD-OK: invocation dir locates the worktree (gh#1220)
  const { root, source } = resolveChangeSetRoot(
    input.storeRoot,
    input.task.id,
    cwd,
    deps.env ?? process.env,
  );
  const cs = emptyChangeSet(root, source);
  const roots: EvidenceRoots = { storeRoot: input.storeRoot, executionRoot: root };

  if (
    await derivePrChangeSet(cs, input, roots, {
      listMergedPrs: deps.listMergedPrs ?? defaultListMergedPrs,
      resolvePr: deps.resolvePr ?? defaultResolvePr,
      viewPr: deps.viewPr ?? defaultViewPr,
      findPrByHead: deps.findPrByHead ?? defaultFindPrByHead,
    })
  )
    return cs;
  // A PR the pr: validator refused does not end the search: the task branch
  // still describes the work. The refusal survives as a warning when the
  // branch answers, and as the blocker when it does not.
  const refused = cs.blockers.filter((b) => b.code === 'pr-unverified');
  if (deriveBranchChangeSet(cs, input.task.id)) {
    if (refused.length > 0) {
      cs.blockers = cs.blockers.filter((b) => b.code !== 'pr-unverified');
      cs.warnings.push(
        ...refused.map((b) => `${b.message} — derived from the task branch instead.`),
      );
      delete cs.prNumber;
    }
    return cs;
  }
  if (refused.length > 0) return cs;
  if (
    await deriveDocsChangeSet(cs, input, {
      listTaskDocs: deps.listTaskDocs ?? defaultListTaskDocs,
      listTaskDecisions: deps.listTaskDecisions ?? defaultListTaskDecisions,
    })
  )
    return cs;

  const id = input.task.id;
  cs.blockers.push(
    blocker(
      'no-change-set',
      `No merged PR, task branch or attached document references ${id}.`,
      `git switch -c task/${id}`,
      `Commit the work on task/${id}, or pass --pr <n> if a PR that does not cite ${id} implements it.`,
    ),
  );
  return cs;
}
