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
  /** Explicit PR (`--pr <n>`); skips discovery. */
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
  const fields = 'number,title,body,headRefName';
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

/**
 * Step 1 — a merged PR that cites the task. Returns `true` when the PR path
 * decided the outcome (a change set or a blocker), `false` to fall through.
 */
async function derivePrChangeSet(
  cs: TaskChangeSet,
  input: DeriveChangeSetInput,
  roots: EvidenceRoots,
  deps: Required<Pick<ChangeSetDeps, 'listMergedPrs' | 'resolvePr'>>,
): Promise<boolean> {
  const { task } = input;
  let numbers: number[];
  if (input.prNumber !== undefined) {
    numbers = [input.prNumber];
  } else {
    const listed = await deps.listMergedPrs(task.id, roots.executionRoot);
    if (!listed.ok) {
      cs.warnings.push(`Merged-PR discovery skipped: ${listed.reason}`);
      return false;
    }
    const citing = listed.prs.filter((pr) =>
      citesTask(`${pr.title}\n${pr.body}\n${pr.headRefName}`, task.id),
    );
    cs.candidates = citing.map((pr) => ({
      prNumber: pr.number,
      title: pr.title,
      headRefName: pr.headRefName,
    }));
    numbers = citing.map((pr) => pr.number).sort((a, b) => a - b);
  }
  if (numbers.length === 0) return false;

  const resolved = new Map<number, PrAtomResolution>();
  if (numbers.length > 1 && task.files?.length) {
    for (const n of numbers) resolved.set(n, await deps.resolvePr(n, roots));
    const intersecting = numbers.filter((n) => {
      const r = resolved.get(n);
      return r?.ok === true && diffIntersectsAc(r.changedPaths, task.files ?? []);
    });
    if (intersecting.length > 0) numbers = intersecting;
  }
  if (numbers.length > 1) {
    // A PR merged FROM the task's own branch (`task/<id>` or `task/<id>-…`)
    // is the task's PR; an integration PR that merely lists the id in its body
    // is not. Deterministic by branch convention, never by wording.
    const own = cs.candidates.filter(
      (c) =>
        numbers.includes(c.prNumber) &&
        (c.headRefName === `task/${task.id}` || c.headRefName.startsWith(`task/${task.id}-`)),
    );
    if (own.length === 1) numbers = [own[0]!.prNumber];
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

  const prNumber = numbers[0] as number;
  const pr = resolved.get(prNumber) ?? (await deps.resolvePr(prNumber, roots));
  cs.prNumber = prNumber;
  if (!pr.ok) {
    cs.source = 'pr';
    cs.blockers.push(
      blocker(
        pr.codeName === 'E_EVIDENCE_GIT_ROOT' ? 'git-root' : 'pr-unverified',
        `PR #${prNumber} cannot serve as evidence: ${pr.reason}`,
        pr.codeName === 'E_EVIDENCE_GIT_ROOT'
          ? `CLEO_EVIDENCE_GIT_ROOT=<path to the repository> cleo done ${task.id} --plan`
          : `gh pr view ${prNumber} --json state,mergeCommit,statusCheckRollup`,
        'The existing pr: provenance check refused this PR; resolve the reason it names.',
        pr.codeName,
      ),
    );
    return true;
  }

  cs.source = 'pr';
  cs.mergeCommitSha = pr.mergeCommitSha;
  const root = roots.executionRoot;
  if (git(root, ['cat-file', '-e', `${pr.mergeCommitSha}^{commit}`]) === null) {
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
  const diff = git(root, [
    'diff-tree',
    '--root',
    '--no-commit-id',
    '-r',
    '--name-status',
    '--no-renames',
    '-m',
    '--first-parent',
    pr.mergeCommitSha,
  ]);
  const { files, deleted } = parseNameStatus(diff ?? '');
  const prPaths = new Set(pr.changedPaths);
  cs.files = prPaths.size > 0 ? files.filter((p) => prPaths.has(p)) : files;
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
    })
  )
    return cs;
  if (deriveBranchChangeSet(cs, input.task.id)) return cs;
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
