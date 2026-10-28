/**
 * Merge closes tasks (T14101, owner decision D11209).
 *
 * A merged PR whose required checks were green on its exact head closes the
 * tasks its body names, with no agent step. CI never writes to a task store:
 * the GitHub job only posts a receipt ({@link judgeMergedPr}); the store owner's
 * machine applies it here ({@link sweepMergedClosures}), re-deriving everything
 * from `gh` and recording through the same path as `cleo done --pr`
 * (`recordTaskDone`, then `taskComplete`), so the same validators and audit
 * apply. The sweep runs from the daemon loop, lazily (throttled) from the
 * commands agents already run, and before `cleo release` decides what ships.
 *
 * PR body lines, one per task:
 *
 * - `Closes: T#### AC1,AC2` — binds those criteria and completes the task once
 *   the criteria every merged PR bound cover all of its criteria.
 * - `Refs: T#### AC1` — binds those criteria; the task stays open.
 *
 * Every applied line writes one `merge_close` audit row keyed by
 * (PR, merge commit, task), so a rerun records nothing twice.
 *
 * @task T14101
 */

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  GhPrViewPayload,
  MacosRegressionSync,
  MergeDirective,
  MergePrOutcome,
  MergeReceipt,
  MergeSweepHooks,
  MergeSweepOptions,
  MergeSweepReconcile,
  MergeSweepResult,
  MergeTaskOutcome,
  ReviewVerdict,
  TaskAuditLogRow,
} from '@cleocode/contracts';

/** The audit action of an applied `Closes:` / `Refs:` line. */
export const MERGE_CLOSE_AUDIT_ACTION = 'merge_close';

/** The audit action of the one rerun of a merge commit's cancelled CI run (never repeated). */
export const MERGE_CLOSE_RERUN_ACTION = 'merge_close_rerun';

/** The audit action of a refusal already reported on the PR (posted once). */
export const MERGE_CLOSE_REFUSED_ACTION = 'merge_close_refused';

/** The lazy sweep runs at most this often per store. */
export const MERGE_SWEEP_INTERVAL_MS = 5 * 60_000;

/** A detached sweep child exits after this long, so a hung `gh` leaves no process behind. */
export const MERGE_SWEEP_CHILD_TIMEOUT_MS = 2 * 60_000;

/** The lock file, under `.cleo/`: held for the whole of one sweep. */
const SWEEP_LOCK_FILE = 'merge-sweep.lock';

/** The claim file, under `.cleo/`: its mtime is the last claimed sweep. */
const SWEEP_CLAIM_FILE = 'merge-sweep.claim';

/**
 * Each sweep re-reads this far behind its high-water mark: GitHub's search
 * index can list a PR some minutes after it merged, and re-reading an applied
 * PR is a no-op (its `merge_close` audit row).
 */
export const MERGE_SWEEP_OVERLAP_MS = 15 * 60_000;

/**
 * A sweep stops taking new PRs after this long and carries the rest on its
 * waiting list, so it finishes inside a lazy child's {@link MERGE_SWEEP_CHILD_TIMEOUT_MS}.
 */
export const MERGE_SWEEP_MAX_RUN_MS = 90_000;

/**
 * A sweep lock whose heartbeat is older than this is stale and may be taken:
 * several times the longest a sweep runs ({@link MERGE_SWEEP_CHILD_TIMEOUT_MS}).
 */
export const MERGE_SWEEP_LOCK_STALE_MS = 5 * MERGE_SWEEP_CHILD_TIMEOUT_MS;

/** A waiting PR is first re-judged after this long; each further wait doubles it. */
export const MERGE_WAITING_FIRST_BACKOFF_MS = 5 * 60_000;

/** The longest a waiting PR goes between re-judgements. */
export const MERGE_WAITING_MAX_BACKOFF_MS = 6 * 60 * 60_000;

/** A PR still waiting this long after it first waited is refused, with one final comment. */
export const MERGE_WAITING_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

/** A first sweep (no high-water mark yet) looks back this far. */
export const MERGE_SWEEP_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/** The merged PRs one `gh pr list` page returns. */
export const MERGE_SWEEP_PR_LIMIT = 50;

/**
 * The most `gh pr list` pages one sweep reads. When more PRs merged than that,
 * the unread (older) window is kept as a backlog the next sweep reads first,
 * and the result reports `truncated`.
 */
export const MERGE_SWEEP_MAX_PAGES = 10;

/** Open issues with this label become tasks (T14104). */
export const MACOS_REGRESSION_LABEL = 'macos-regression';

/** The external-link provider that records which task an issue became. */
const ISSUE_LINK_PROVIDER = 'github-issue';

/** The throttle and high-water file, under `.cleo/`. */
const SWEEP_STATE_FILE = 'merge-sweep.json';

/** A merged PR as the sweep reads it from `gh`. */
export interface MergedPrRecord extends Pick<GhPrViewPayload, 'statusCheckRollup'> {
  /** PR number. */
  number: number;
  /** PR body. */
  body: string;
  /** Merge time (ISO); empty for an open PR, which only a dry run reads. */
  mergedAt: string;
  /** Final head. */
  headRefOid: string | null;
  /** Merge commit. */
  mergeCommitSha: string | null;
}

/** The outcome of recording or completing one task. */
type StepResult = { ok: true } | { ok: false; reason: string };

/** Everything the sweep reaches outside the store; injectable for tests. */
export interface MergeCloseDeps {
  /**
   * One page ({@link MERGE_SWEEP_PR_LIMIT}) of the PRs merged in
   * `[since, until]` (`until` unset: up to now), newest first, or null when
   * `gh` failed. A full page means older PRs may remain.
   */
  listMergedPrs(root: string, since: string, until?: string): Promise<MergedPrRecord[] | null>;
  /** One PR, or null when `gh` failed or it is not merged. */
  viewPr(root: string, prNumber: number): Promise<MergedPrRecord | null>;
  /** Post a PR comment; false when it could not. */
  comment(root: string, prNumber: number, body: string): Promise<boolean>;
  /** The required check names (`release.prRequiredWorkflows` tiers). */
  requiredChecks(storeRoot: string): Promise<string[]>;
  /** Whether `gh` can run at all. */
  ghAvailable(): Promise<boolean>;
  /** Plan (`dryRun`) or record the task's gates from the PR, as `cleo done --pr`. */
  record(
    storeRoot: string,
    taskId: string,
    prNumber: number,
    acs: string[],
    dryRun: boolean,
  ): Promise<StepResult>;
  /** Complete the task, as `cleo done --pr` does after recording. */
  complete(storeRoot: string, taskId: string, prNumber: number): Promise<StepResult>;
  /** Open issues carrying a label (one `gh` call), or null when `gh` failed. */
  listLabelledIssues(
    root: string,
    label: string,
  ): Promise<Array<{ url: string; title: string }> | null>;
  /** Close an issue with a comment; false when it could not. */
  closeIssue(root: string, url: string, comment: string): Promise<boolean>;
  /** Flag the docs a merged change left stale on its tasks (T14111), returning the task ids flagged. */
  docsRot?(
    storeRoot: string,
    pr: { prNumber: number; mergeSha: string; taskIds: string[] },
  ): Promise<string[]>;
  /**
   * Reconcile the newest published release's provenance (T14102). Unset until
   * the release-cut module is on main.
   */
  reconcile?(storeRoot: string): Promise<MergeSweepReconcile>;
  /**
   * The independent reviewer verdicts recorded for a task's PR (T14122,
   * `cleo review`). Unset: no verdicts, so nothing closes.
   */
  reviewVerdicts?(storeRoot: string, taskId: string, prNumber: number): Promise<ReviewVerdict[]>;
  /**
   * The newest run of the required CI workflow on a commit, or null when there
   * is none yet (or `gh` failed).
   */
  mergeCiRun(
    root: string,
    sha: string,
    workflow: string,
  ): Promise<{ runId: number; status: string; conclusion: string | null } | null>;
  /** Rerun a CI run; false when it could not. */
  rerunRun(root: string, runId: number): Promise<boolean>;
  /** The clock (ms), for the run cap, backoff and age-out; tests inject it. */
  now?(): number;
  /**
   * Whether this sweep may rerun a cancelled merge-commit CI run. Off by
   * default until T14136: a rerun of an old main push run joins main's live
   * push concurrency group and cancels (or is cancelled by) main's newest run.
   */
  canRerun(): boolean;
  /** Open PRs (one `gh` call), for the pre-merge verdict check; null when `gh` failed. */
  listOpenPrs(root: string): Promise<MergedPrRecord[] | null>;
  /** Set the `cleo/merge-close` commit status on a head; false when it could not. */
  setStatus(
    root: string,
    sha: string,
    state: 'success' | 'failure',
    description: string,
  ): Promise<boolean>;
}

/** The commit status the pre-merge verdict check sets on an open PR's head. */
export const MERGE_CLOSE_STATUS_CONTEXT = 'cleo/merge-close';

/**
 * Why the criteria a line names are not independently verified on the PR's
 * head (T14122), one reason per criterion, from the shared judge
 * (`judgeReviewVerdicts`, the same text `cleo review check` prints): no
 * verdict, an unmet one, one on an older head (a push after review), or one
 * by the task's own author. Empty when every criterion is met.
 *
 * @param verdicts - The task's verdicts on the PR.
 * @param acs - The criteria the line names.
 * @param headSha - The PR's final head.
 * @returns The reasons.
 */
export async function unverifiedCriteria(
  verdicts: readonly ReviewVerdict[],
  acs: readonly string[],
  headSha: string | null,
): Promise<string[]> {
  if (headSha === null) return acs.map((ac) => `${ac}: the PR's head is unknown`);
  const { judgeReviewVerdicts } = await import('./review-verdict.js');
  return judgeReviewVerdicts(verdicts, acs, headSha).gaps.map((gap) => gap.reason);
}

const DIRECTIVE_LINE = /^[ \t>*-]*(Closes|Refs)[ \t]*:[ \t]*(.*)$/gim;
const DIRECTIVE_PAYLOAD = /^(T\d+)\s+(AC\d+(?:\s*,\s*AC\d+)*)\s*$/i;

/**
 * Parse a PR body's `Closes:` / `Refs:` lines (T14101). A line whose payload
 * does not start with a task id (`Closes: #123`, GitHub's own syntax) is not
 * CLEO's and is ignored; a CLEO line that is malformed, or names a task twice,
 * is an error with the fix.
 *
 * @param body - The PR body.
 * @returns The lines, and the errors.
 * @example
 * ```ts
 * parseMergeDirectives('Closes: T14101 AC1,AC2');
 * // { directives: [{ kind: 'closes', taskId: 'T14101', acs: ['AC1', 'AC2'] }], errors: [] }
 * ```
 */
export function parseMergeDirectives(body: string): {
  directives: MergeDirective[];
  errors: string[];
} {
  const directives: MergeDirective[] = [];
  const errors: string[] = [];
  for (const match of body.matchAll(DIRECTIVE_LINE)) {
    const keyword = (match[1] ?? '').toLowerCase() === 'closes' ? 'Closes' : 'Refs';
    const payload = (match[2] ?? '').replace(/`/g, '').trim();
    if (!/^T\d/i.test(payload)) continue;
    const parsed = DIRECTIVE_PAYLOAD.exec(payload);
    if (!parsed) {
      errors.push(
        `"${keyword}: ${payload}" is not "${keyword}: T#### AC1,AC2": name the task, then every criterion this PR delivers (no wildcard).`,
      );
      continue;
    }
    const taskId = (parsed[1] ?? '').toUpperCase();
    if (directives.some((d) => d.taskId === taskId)) {
      errors.push(`${taskId} is named on more than one Closes:/Refs: line; use one line per task.`);
      continue;
    }
    const acs = [...new Set((parsed[2] ?? '').split(',').map((a) => a.trim().toUpperCase()))];
    directives.push({ kind: keyword === 'Closes' ? 'closes' : 'refs', taskId, acs });
  }
  return { directives, errors };
}

/**
 * Judge a merged PR without a task store (T14101): its lines, and whether its
 * required checks were green on its exact head (`statusCheckRollup` is the
 * head's checks). This is the CI job's receipt; the store side judges again.
 *
 * @param pr - The merged PR.
 * @param required - Required check names.
 * @returns The receipt.
 */
export async function judgeMergedPr(
  pr: MergedPrRecord,
  required: readonly string[],
): Promise<MergeReceipt> {
  const { directives, errors } = parseMergeDirectives(pr.body);
  const { evaluateRollup } = await import('../release/pr-evidence.js');
  const ci = evaluateRollup(pr.statusCheckRollup ?? [], required, { prNumber: pr.number });
  const closesNothing =
    errors.length > 0
      ? `its Closes:/Refs: lines are malformed: ${errors.join(' ')}`
      : directives.length === 0
        ? 'its body names no task (add "Closes: T#### AC1,AC2" or "Refs: T#### AC1").'
        : !ci.ok
          ? `its required checks were not green on its head ${pr.headRefOid?.slice(0, 12) ?? '(unknown)'}: ${ci.reason}`
          : undefined;
  return {
    prNumber: pr.number,
    mergeSha: pr.mergeCommitSha,
    headSha: pr.headRefOid,
    directives,
    errors,
    ciGreen: ci.ok,
    ...(ci.ok ? {} : { ciReason: ci.reason }),
    ...(closesNothing !== undefined ? { closesNothing } : {}),
  };
}

/** The persisted cursor: the newest merge read, and an unread older window. */
interface SweepState {
  lastSweptAt?: string;
  highWater?: string;
  /**
   * Windows of PRs merged in `[since, until]` that a page budget left unread,
   * oldest first; each sweep reads the oldest first, so every one drains.
   * (A single object is the pre-list form.)
   */
  backlog?: Array<{ since: string; until: string }> | { since: string; until: string };
  /** The last `cleo/merge-close` status posted per open PR (`head:state:description`). */
  statuses?: Record<string, string>;
  /**
   * PRs to re-judge, keyed by number: a task waiting, a PR gh could not view,
   * or one a deadline left. (A plain number list is the earlier form.)
   */
  waiting?: number[] | Record<string, WaitingEntry>;
}

/** One waiting PR's backoff (T14101 review): when to re-judge it and since when it waits. */
interface WaitingEntry {
  /** When it first waited (ISO). */
  firstAt: string;
  /** Not re-judged before this (ISO), unless its verdicts changed. */
  nextAt: string;
  /** The current backoff (ms). */
  intervalMs: number;
  /** Its merge commit, for the final comment's audit key. */
  mergeSha: string | null;
  /** Its final head, for judging verdicts locally. */
  headSha: string | null;
  /** The Closes:/Refs: lines it waits on. */
  lines: Array<{ taskId: string; acs: string[] }>;
  /** Whether it waits only for reviewer verdicts (re-judged locally, no gh). */
  verdictOnly: boolean;
  /** The last waiting reason. */
  reason: string;
  /** Fingerprint of its tasks' verdicts when last judged; a change re-judges it at once. */
  verdictKey: string;
}

/** A window read page by page, newest first. */
interface WindowRead {
  prs: MergedPrRecord[];
  /** The mergedAt below which PRs remain unread, when the budget ran out. */
  unreadBefore?: string;
}

/**
 * The PRs one sweep reads (T14101): first the recorded backlog windows,
 * oldest first, then the window from `since` to now, all within one page
 * budget. A window the budget cuts short stays in the backlog with its
 * `until` lowered to what was read, so every window drains; a window the
 * budget never reached stays whole. `newestRead` is the newest merge read in
 * the new window (the next high-water mark), unset when it was not read.
 */
async function listSweepWindows(
  deps: MergeCloseDeps,
  root: string,
  state: SweepState,
  since: string,
  explicitSince: boolean,
): Promise<{
  prs: MergedPrRecord[];
  backlog: Array<{ since: string; until: string }>;
  newestRead?: string;
} | null> {
  const budget = { pages: MERGE_SWEEP_MAX_PAGES };
  const prior = state.backlog;
  const recorded = prior === undefined ? [] : Array.isArray(prior) ? prior : [prior];
  const backlog: Array<{ since: string; until: string }> = [];
  const byNumber = new Map<number, MergedPrRecord>();
  for (const window of [...recorded].sort((a, b) => a.since.localeCompare(b.since))) {
    // An explicit --since reads only its own window; the backlog waits, kept.
    if (budget.pages === 0 || explicitSince) {
      backlog.push(window);
      continue;
    }
    const read = await readMergedWindow(deps, root, window.since, window.until, budget);
    if (read === null) return null;
    for (const pr of read.prs) byNumber.set(pr.number, pr);
    if (read.unreadBefore !== undefined)
      backlog.push({ since: window.since, until: read.unreadBefore });
  }
  let newestRead: string | undefined;
  if (budget.pages > 0) {
    const read = await readMergedWindow(deps, root, since, undefined, budget);
    if (read === null) return null;
    for (const pr of read.prs) {
      byNumber.set(pr.number, pr);
      if (newestRead === undefined || pr.mergedAt > newestRead) newestRead = pr.mergedAt;
    }
    // Pages run newest first, so a cut-short window's unread part is below what was read.
    if (read.unreadBefore !== undefined) backlog.push({ since, until: read.unreadBefore });
  }
  return {
    prs: [...byNumber.values()],
    backlog,
    ...(newestRead !== undefined ? { newestRead } : {}),
  };
}

/**
 * Read every PR merged in `[since, until]`, newest first, a page at a time
 * (each page's oldest merge is the next page's `until`), until a short page
 * or the page budget runs out. Null when `gh` failed.
 */
async function readMergedWindow(
  deps: MergeCloseDeps,
  root: string,
  since: string,
  until: string | undefined,
  budget: { pages: number },
): Promise<WindowRead | null> {
  const seen = new Map<number, MergedPrRecord>();
  let upper = until;
  while (budget.pages > 0) {
    budget.pages -= 1;
    const page = await deps.listMergedPrs(root, since, upper);
    if (page === null) return null;
    const fresh = page.filter((pr) => !seen.has(pr.number));
    for (const pr of fresh) seen.set(pr.number, pr);
    if (page.length < MERGE_SWEEP_PR_LIMIT) return { prs: [...seen.values()] };
    // A full page of merges in one instant is not progress; leave the rest.
    if (fresh.length === 0) break;
    upper = page.reduce(
      (min, pr) => (pr.mergedAt < min ? pr.mergedAt : min),
      page[0]?.mergedAt ?? '',
    );
  }
  return { prs: [...seen.values()], unreadBefore: upper ?? new Date().toISOString() };
}

function sweepStatePath(storeRoot: string): string {
  return join(storeRoot, '.cleo', SWEEP_STATE_FILE);
}

function readSweepState(storeRoot: string): SweepState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(sweepStatePath(storeRoot), 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as SweepState) : {};
  } catch {
    return {};
  }
}

/** Write the state tmp-then-rename, so a reader never sees half a file. */
function writeSweepState(storeRoot: string, state: SweepState): void {
  const path = sweepStatePath(storeRoot);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Take the sweep lock for a store (T14101): an `O_EXCL` lock file held for
 * the whole sweep, its mtime refreshed while the sweep runs. A lock whose
 * heartbeat is older than {@link MERGE_SWEEP_LOCK_STALE_MS} is moved aside by
 * `rename` (only one caller's rename succeeds) and taken. Null when another
 * sweep holds it.
 *
 * @param storeRoot - CLEO store root.
 * @returns The release function, or null.
 */
export function acquireMergeSweepLock(
  storeRoot: string,
  now: () => number = Date.now,
): (() => void) | null {
  const lock = join(storeRoot, '.cleo', SWEEP_LOCK_FILE);
  let judged: string | null = null;
  try {
    if (now() - statSync(lock).mtimeMs < MERGE_SWEEP_LOCK_STALE_MS) return null;
    judged = readFileSync(lock, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }
  if (judged !== null && !stealStaleLock(lock, judged)) return null;
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  try {
    const fd = openSync(lock, 'wx');
    writeFileSync(fd, token);
    closeSync(fd);
  } catch {
    return null;
  }
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lock, now, now);
    } catch {
      // A lost lock is noticed at release.
    }
  }, 30_000);
  heartbeat.unref();
  return () => {
    clearInterval(heartbeat);
    try {
      if (readFileSync(lock, 'utf-8') === token) unlinkSync(lock);
    } catch {
      // Already gone or taken over: nothing of ours to remove.
    }
  };
}

/**
 * Move aside the stale lock whose token was `judged`, and only that one: rename
 * it to a unique name and read the token there. Another stealer may have
 * replaced the stale lock with a fresh one between the read and the rename; if
 * the renamed file is not the judged one, put it back (`link` refuses to
 * clobber a lock created meanwhile) and give up.
 *
 * @param lock - The lock path.
 * @param judged - The token read from the lock judged stale.
 * @returns True when the judged lock was removed.
 * @internal Exported for tests.
 */
export function stealStaleLock(lock: string, judged: string): boolean {
  const aside = `${lock}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(lock, aside);
  } catch {
    return false;
  }
  let got: string | null = null;
  try {
    got = readFileSync(aside, 'utf-8');
  } catch {
    // Unreadable: treat as not the judged lock.
  }
  if (got !== judged) {
    try {
      linkSync(aside, lock);
    } catch {
      // A newer lock already stands; it is the live one.
    }
    try {
      unlinkSync(aside);
    } catch {
      // Nothing left to clean.
    }
    return false;
  }
  try {
    unlinkSync(aside);
  } catch {
    // Already gone.
  }
  return true;
}

/**
 * Claim the next sweep for a store, atomically (T14101): true for exactly one
 * caller per {@link MERGE_SWEEP_INTERVAL_MS}. A claim older than the interval
 * is moved aside by `rename` (only one caller's rename succeeds), and the new
 * claim is created with `O_EXCL`, so two concurrent commands never start two
 * sweeps.
 *
 * @param storeRoot - CLEO store root.
 * @param now - Current time (ms).
 * @returns True when this caller owns the sweep.
 */
export function claimMergeSweep(storeRoot: string, now = Date.now()): boolean {
  const claim = join(storeRoot, '.cleo', SWEEP_CLAIM_FILE);
  try {
    if (now - statSync(claim).mtimeMs < MERGE_SWEEP_INTERVAL_MS) return false;
    const stale = `${claim}.${process.pid}.${now}`;
    renameSync(claim, stale);
    unlinkSync(stale);
  } catch (err) {
    // No claim yet is the only error that leaves the sweep ours to take.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  try {
    closeSync(openSync(claim, 'wx'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a read command may start a background sweep (T14101): never in CI,
 * under vitest, when turned off (`CLEO_MERGE_SWEEP=off`), or without `gh`
 * credentials (a token in the environment, or `gh`'s hosts file).
 *
 * @param env - The environment.
 * @param home - The home directory (for `gh`'s default config).
 * @returns True when a detached sweep may be spawned.
 */
export function mergeSweepSpawnAllowed(env: NodeJS.ProcessEnv, home = homedir()): boolean {
  if (env['CI'] === 'true' || env['VITEST'] !== undefined) return false;
  if (env['CLEO_MERGE_SWEEP'] === 'off') return false;
  if (env['GH_TOKEN'] || env['GITHUB_TOKEN']) return true;
  return existsSync(join(env['GH_CONFIG_DIR'] ?? join(home, '.config', 'gh'), 'hosts.yml'));
}

/** The criteria every earlier applied line bound for a task, and whether this PR was applied. */
async function priorBindings(
  storeRoot: string,
  taskId: string,
  prNumber: number,
  mergeSha: string | null,
): Promise<{ acs: Set<string>; applied: boolean; reported: Set<string> }> {
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const accessor = await getTaskAccessor(storeRoot);
  const rows: TaskAuditLogRow[] = await accessor.queryAuditLog({
    taskIds: [taskId],
    actions: [MERGE_CLOSE_AUDIT_ACTION, MERGE_CLOSE_REFUSED_ACTION],
  });
  const acs = new Set<string>();
  const reported = new Set<string>();
  let applied = false;
  for (const row of rows) {
    const details = JSON.parse(row.detailsJson ?? '{}') as {
      prNumber?: number;
      mergeSha?: string | null;
      acs?: string[];
      reason?: string;
      outcome?: 'refused' | 'waiting';
    };
    const samePr = details.prNumber === prNumber && (details.mergeSha ?? null) === mergeSha;
    if (row.action === MERGE_CLOSE_REFUSED_ACTION) {
      if (samePr) reported.add(details.outcome ?? 'refused');
      continue;
    }
    for (const ac of details.acs ?? []) acs.add(ac);
    if (samePr) applied = true;
  }
  return { acs, applied, reported };
}

async function appendMergeAudit(
  storeRoot: string,
  action: string,
  taskId: string,
  details: Record<string, unknown>,
): Promise<void> {
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const { randomBytes } = await import('node:crypto');
  await (await getTaskAccessor(storeRoot)).appendLog({
    id: `log-${Math.floor(Date.now() / 1000)}-${randomBytes(3).toString('hex')}`,
    timestamp: new Date().toISOString(),
    action,
    taskId,
    actor: 'merge-close',
    details,
  });
}

/**
 * Why a refused record is only waiting on the merge commit's own CI, or null
 * when the refusal is real (T14101): the newest run of the required workflow
 * on the merge commit is missing, unfinished, cancelled or skipped. A
 * cancelled or skipped run is rerun once per merge commit, ever (an audit row
 * remembers it), and only where {@link MergeCloseDeps.canRerun} allows (off by
 * default until T14136); a failed run is never rerun and refuses.
 */
async function mergeCiWait(
  storeRoot: string,
  root: string,
  pr: MergedPrRecord,
  taskId: string,
  required: readonly string[],
  deps: MergeCloseDeps,
  dryRun: boolean,
): Promise<{ reason: string; reran: boolean; final?: boolean } | null> {
  const sha = pr.mergeCommitSha;
  if (sha === null) return null;
  const workflow = required[0] ?? 'CI';
  const run = await deps.mergeCiRun(root, sha, workflow);
  const short = sha.slice(0, 12);
  if (run === null)
    return { reason: `no ${workflow} run on merge commit ${short} yet`, reran: false };
  if (run.status !== 'completed')
    return { reason: `${workflow} on merge commit ${short} is ${run.status}`, reran: false };
  if (run.conclusion === 'failure' || run.conclusion === 'timed_out')
    return { reason: `${workflow} failed on merge commit ${short}`, reran: false, final: true };
  if (run.conclusion !== 'cancelled' && run.conclusion !== 'skipped') return null;
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const accessor = await getTaskAccessor(storeRoot);
  const rows = await accessor.queryAuditLog({ actions: [MERGE_CLOSE_RERUN_ACTION] });
  const already = rows.some(
    (row) => (JSON.parse(row.detailsJson ?? '{}') as { mergeSha?: string }).mergeSha === sha,
  );
  const was = `${workflow} on merge commit ${short} was ${run.conclusion} and no later run stands in`;
  if (already) return { reason: `${was}; its one rerun is done, waiting for it`, reran: false };
  if (dryRun || !deps.canRerun())
    return {
      reason: `${was}; waiting (automatic reruns are off until T14136; rerun it by hand)`,
      reran: false,
    };
  if (!(await deps.rerunRun(root, run.runId)))
    return {
      reason: `${was}; the rerun of run ${run.runId} failed, retrying next sweep`,
      reran: false,
    };
  await appendMergeAudit(storeRoot, MERGE_CLOSE_RERUN_ACTION, taskId, {
    prNumber: pr.number,
    mergeSha: sha,
    runId: run.runId,
  });
  return { reason: `${was}; reran run ${run.runId}`, reran: true };
}

/** Whether a merged PR's own head still had required checks running (a pending, not a failed, CI). */
function headCiUnfinished(pr: MergedPrRecord): boolean {
  return (pr.statusCheckRollup ?? []).some(
    (check) => check.status !== undefined && check.status !== 'COMPLETED',
  );
}

/** Apply one line of one merged PR to its task. */
async function applyDirective(
  storeRoot: string,
  root: string,
  required: readonly string[],
  pr: MergedPrRecord,
  receipt: MergeReceipt,
  directive: MergeDirective,
  deps: MergeCloseDeps,
  dryRun: boolean,
): Promise<MergeTaskOutcome & { reran?: boolean; ciWait?: boolean }> {
  const { taskId, acs } = directive;
  const base = { taskId, acs };
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const accessor = await getTaskAccessor(storeRoot);
  const task = await accessor.loadSingleTask(taskId);
  if (!task)
    return { ...base, action: 'refused', reason: `${taskId} is not a task in this store.` };
  const prior = await priorBindings(storeRoot, taskId, pr.number, pr.mergeCommitSha);
  if (prior.applied)
    return { ...base, action: 'already', reason: `PR #${pr.number} was already applied.` };
  if (task.status === 'done' || task.status === 'cancelled')
    return { ...base, action: 'already', reason: `${taskId} is already ${task.status}.` };
  const own = (await accessor.getAcRows(taskId))
    .filter((row) => row.kind !== 'child_task')
    .map((row) => `AC${row.ordinal}`);
  const unknown = acs.filter((ac) => !own.includes(ac));
  if (unknown.length > 0)
    return {
      ...base,
      action: 'refused',
      reason: `${taskId} has no ${unknown.join(', ')} (its criteria are ${own.join(', ') || 'none'}).`,
    };
  // A dry run before merge checks the lines against the store; CI and the
  // recorded evidence are judged once the PR has merged.
  const open = pr.mergedAt === '';
  // Only failed CI, an unknown task and an unknown criterion are final; every
  // other gap waits and is re-judged each sweep (a later verdict, a later
  // Refs: merge, a transient gh or store failure).
  if (!open && !receipt.ciGreen) {
    const reason = receipt.closesNothing ?? 'CI was not green.';
    return headCiUnfinished(pr)
      ? { ...base, action: 'waiting', reason, ciWait: true }
      : { ...base, action: 'refused', reason };
  }
  // T14122 (D11211): satisfies: comes only from an independent reviewer's
  // `met` verdict on the PR's final head, never from the author's line.
  const verdicts = deps.reviewVerdicts
    ? await deps.reviewVerdicts(storeRoot, taskId, pr.number)
    : [];
  const unverified = await unverifiedCriteria(verdicts, acs, pr.headRefOid);
  if (unverified.length > 0)
    return {
      ...base,
      action: 'waiting',
      reason: `${NOT_VERIFIED} ${unverified.join('; ')} (cleo review records the verdicts).`,
    };
  const audit = { prNumber: pr.number, mergeSha: pr.mergeCommitSha, kind: directive.kind, acs };
  if (directive.kind === 'refs') {
    if (!dryRun) await appendMergeAudit(storeRoot, MERGE_CLOSE_AUDIT_ACTION, taskId, audit);
    return { ...base, action: 'bound' };
  }
  const union = new Set([...prior.acs, ...acs]);
  const missing = own.filter((ac) => !union.has(ac));
  if (missing.length > 0)
    return {
      ...base,
      action: 'waiting',
      reason:
        `no merged PR binds ${missing.join(', ')} of ${taskId}: list them on this PR's Closes: line, ` +
        'or bind them first with a Refs: line on the PR that delivers them.',
    };
  if (open)
    return { ...base, action: 'closed', reason: 'would close once it merges with green CI' };
  const recorded = await deps.record(storeRoot, taskId, pr.number, [...union], dryRun);
  if (!recorded.ok) {
    // A merge whose own CI run was cancelled, skipped or unfinished, with no
    // later run standing in yet (ci-evidence's T12742 rule, unchanged), waits.
    const wait = await mergeCiWait(storeRoot, root, pr, taskId, required, deps, dryRun);
    if (wait?.final)
      return { ...base, action: 'refused', reason: `${wait.reason}: ${recorded.reason}` };
    if (wait !== null)
      return { ...base, action: 'waiting', reason: wait.reason, reran: wait.reran, ciWait: true };
    return { ...base, action: 'waiting', reason: recorded.reason };
  }
  if (dryRun) return { ...base, action: 'closed' };
  const completed = await deps.complete(storeRoot, taskId, pr.number);
  if (!completed.ok) {
    // A concurrent sweep (or agent) may have completed it first.
    const now = await accessor.loadSingleTask(taskId);
    if (now?.status === 'done')
      return { ...base, action: 'already', reason: `${taskId} was completed meanwhile.` };
    return { ...base, action: 'waiting', reason: completed.reason };
  }
  await appendMergeAudit(storeRoot, MERGE_CLOSE_AUDIT_ACTION, taskId, audit);
  return { ...base, action: 'closed' };
}

/**
 * Post each refused or waiting task on its PR once per kind (an audit row
 * remembers it): a gap wait is re-judged every sweep but commented once. The
 * caller leaves out waits on the merge's own CI, which resolve themselves.
 */
async function reportRefusals(
  storeRoot: string,
  root: string,
  pr: MergedPrRecord,
  outcomes: MergeTaskOutcome[],
  deps: MergeCloseDeps,
): Promise<void> {
  for (const outcome of outcomes) {
    if ((outcome.action !== 'refused' && outcome.action !== 'waiting') || !outcome.reason) continue;
    const { reported } = await priorBindings(
      storeRoot,
      outcome.taskId,
      pr.number,
      pr.mergeCommitSha,
    ).catch(() => ({ reported: new Set<string>() }));
    if (reported.has(outcome.action)) continue;
    const body =
      outcome.action === 'refused'
        ? `CLEO merge-close: ${outcome.taskId} was not closed by this PR: ${outcome.reason}`
        : `CLEO merge-close: ${outcome.taskId} is waiting to close from this PR (re-checked every sweep): ${outcome.reason}`;
    if (!(await deps.comment(root, pr.number, body))) continue;
    await appendMergeAudit(storeRoot, MERGE_CLOSE_REFUSED_ACTION, outcome.taskId, {
      prNumber: pr.number,
      mergeSha: pr.mergeCommitSha,
      reason: outcome.reason,
      outcome: outcome.action,
    }).catch(() => undefined);
  }
}

/**
 * Apply each merged PR's lines, oldest merge first, into `result`; returns
 * the per-PR hook results. PRs not reached before `deadline` are left out of
 * `result` and pushed to `carried`, for the waiting list.
 */
async function applyMergedPrs(
  storeRoot: string,
  root: string,
  prs: readonly MergedPrRecord[],
  required: readonly string[],
  deps: MergeCloseDeps,
  dryRun: boolean,
  result: MergeSweepResult,
  deadline: number,
  carried: number[],
  clock: () => number,
): Promise<MergeSweepHooks> {
  const hooks: MergeSweepHooks = {};
  const silent = new Set<MergeTaskOutcome>();
  for (const pr of [...prs].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))) {
    if (clock() > deadline) {
      carried.push(pr.number);
      continue;
    }
    const receipt = await judgeMergedPr(pr, required);
    const entry: MergePrOutcome = {
      prNumber: pr.number,
      mergeSha: pr.mergeCommitSha,
      outcomes: [],
    };
    if (pr.mergedAt === '' && !dryRun) {
      entry.closesNothing = `PR #${pr.number} has not merged; check it with --dry-run.`;
      result.prs.push(entry);
      continue;
    }
    if (receipt.directives.length === 0 || receipt.errors.length > 0) {
      // The CI job comments these; a PR naming no task is not this store's.
      if (receipt.closesNothing) entry.closesNothing = receipt.closesNothing;
      result.prs.push(entry);
      continue;
    }
    for (const directive of receipt.directives) {
      const applied = applyDirective(
        storeRoot,
        root,
        required,
        pr,
        receipt,
        directive,
        deps,
        dryRun,
      );
      const { reran, ciWait, ...outcome } = await applied.catch(
        (err: Error): MergeTaskOutcome & { reran?: boolean; ciWait?: boolean } => ({
          taskId: directive.taskId,
          acs: directive.acs,
          // A throw (gh rate limit, SQLITE_BUSY, …) is transient: re-judge next sweep.
          action: 'waiting' as const,
          reason: err.message,
        }),
      );
      entry.outcomes.push(outcome);
      if (ciWait === true) silent.add(outcome);
      if (reran === true) result.reran++;
      if (outcome.action === 'waiting') result.waiting++;
      if (outcome.action === 'closed') result.closed.push(outcome.taskId);
      if (outcome.action === 'bound') result.bound.push(outcome.taskId);
      if (outcome.action === 'refused')
        result.refused.push({
          taskId: outcome.taskId,
          prNumber: pr.number,
          reason: outcome.reason ?? 'refused',
        });
    }
    // A wait on the merge's own CI resolves itself: no comment (lead rule).
    const loud = entry.outcomes.filter((o) => !silent.has(o));
    if (!dryRun) await reportRefusals(storeRoot, root, pr, loud, deps);
    // T14111: flag stale docs once, on the run that applied this PR.
    const applied = entry.outcomes.filter((o) => o.action === 'closed' || o.action === 'bound');
    if (!dryRun && deps.docsRot && pr.mergeCommitSha && applied.length > 0) {
      const taskIds = applied.map((o) => o.taskId);
      const flagged = await deps
        .docsRot(storeRoot, { prNumber: pr.number, mergeSha: pr.mergeCommitSha, taskIds })
        .catch(() => []);
      hooks.docsRot = [...(hooks.docsRot ?? []), ...flagged];
    }
    result.prs.push(entry);
  }
  return hooks;
}

/**
 * The criterion aliases a task owns (child-task criteria excluded), or null
 * when the task is not in this store.
 */
async function taskCriteria(storeRoot: string, taskId: string): Promise<string[] | null> {
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const accessor = await getTaskAccessor(storeRoot);
  if ((await accessor.loadSingleTask(taskId)) === null) return null;
  return (await accessor.getAcRows(taskId))
    .filter((row) => row.kind !== 'child_task')
    .map((row) => `AC${row.ordinal}`);
}

/**
 * The pre-merge check (T14122): for each open PR carrying Closes:/Refs:
 * lines, judge every named criterion against the store (a known task and
 * criterion, an independent `met` verdict on the PR's current head, and for
 * Closes: every criterion bound) and set the `cleo/merge-close` status on that
 * head, so a missing, unmet or stale verdict shows before merge. A status is
 * posted only when it changed since the last sweep.
 */
async function checkOpenPrs(
  storeRoot: string,
  root: string,
  deps: MergeCloseDeps,
  dryRun: boolean,
  posted: Record<string, string>,
): Promise<NonNullable<MergeSweepResult['openChecks']>> {
  const open = await deps.listOpenPrs(root);
  if (open === null) return [];
  const checks: NonNullable<MergeSweepResult['openChecks']> = [];
  for (const pr of open) {
    const { directives, errors } = parseMergeDirectives(pr.body);
    if ((directives.length === 0 && errors.length === 0) || !pr.headRefOid) continue;
    const problems = [...errors];
    for (const d of directives) {
      const own = await taskCriteria(storeRoot, d.taskId);
      if (own === null) {
        problems.push(`${d.taskId} is not a task in this store`);
        continue;
      }
      const unknown = d.acs.filter((ac) => !own.includes(ac));
      if (unknown.length > 0) problems.push(`${d.taskId} has no ${unknown.join(', ')}`);
      const verdicts = deps.reviewVerdicts
        ? await deps.reviewVerdicts(storeRoot, d.taskId, pr.number)
        : [];
      for (const p of await unverifiedCriteria(verdicts, d.acs, pr.headRefOid))
        problems.push(`${d.taskId} ${p}`);
      if (d.kind === 'closes') {
        const prior = await priorBindings(storeRoot, d.taskId, pr.number, null);
        const union = new Set([...prior.acs, ...d.acs]);
        const missing = own.filter((ac) => !union.has(ac));
        if (missing.length > 0) problems.push(`${d.taskId} ${missing.join(', ')} unbound`);
      }
    }
    const state = problems.length === 0 ? ('success' as const) : ('failure' as const);
    const description = (
      state === 'success'
        ? `${directives.length} task(s): every criterion independently verified`
        : problems.join('; ')
    ).slice(0, 140);
    checks.push({ prNumber: pr.number, headSha: pr.headRefOid, state, description });
    const key = `${pr.headRefOid}:${state}:${description}`;
    if (dryRun || posted[String(pr.number)] === key) continue;
    if (await deps.setStatus(root, pr.headRefOid, state, description))
      posted[String(pr.number)] = key;
  }
  return checks;
}

/**
 * Run `fn` under a bound session (T14101): the caller's when there is one,
 * else a short `merge-sweep` session this sweep starts and ends, so writes
 * from the daemon pass session enforcement.
 */
async function withSweepSession<T>(storeRoot: string, fn: () => Promise<T>): Promise<T> {
  const { getActiveSessionInfo } = await import('../sessions/session-enforcement.js');
  if ((await getActiveSessionInfo(storeRoot).catch(() => null)) !== null) return fn();
  const sessions = await import('../sessions/index.js');
  const session = await sessions
    .startSession(storeRoot, { scope: 'global', name: 'merge-sweep' })
    .catch(() => null);
  // No session could start: run anyway; a write enforcement refuses is a refusal like any other.
  if (session === null) return fn();
  const prior = process.env['CLEO_SESSION_ID'];
  process.env['CLEO_SESSION_ID'] = session.id;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env['CLEO_SESSION_ID'];
    else process.env['CLEO_SESSION_ID'] = prior;
    await sessions
      .endSession(storeRoot, { sessionId: session.id, note: 'merge sweep' })
      .catch(() => undefined);
  }
}

/**
 * Close the tasks merged PRs name (T14101): for each merged PR, judge its
 * receipt, then apply each `Closes:` / `Refs:` line to its task. Never throws
 * on `gh` or network trouble: it reports `swept: false` instead. Under
 * `dryRun` it records, completes and comments nothing, and leaves the throttle
 * alone.
 *
 * @param storeRoot - CLEO store root.
 * @param opts - Dry run, force, since, PR numbers.
 * @param deps - Outside access; defaults to `gh` and the done/complete path.
 * @returns What was closed, bound and refused.
 * @example
 * ```ts
 * const r = await sweepMergedClosures(root, { force: true, dryRun: true });
 * console.log(r.closed);
 * ```
 */
export async function sweepMergedClosures(
  storeRoot: string,
  opts: MergeSweepOptions = {},
  deps: MergeCloseDeps = defaultMergeCloseDeps,
): Promise<MergeSweepResult> {
  const dryRun = opts.dryRun === true;
  const empty: MergeSweepResult = {
    swept: false,
    dryRun,
    prs: [],
    closed: [],
    bound: [],
    refused: [],
    waiting: 0,
    reran: 0,
  };
  const targeted = (opts.prNumbers?.length ?? 0) > 0;
  if (!opts.force && !targeted && !claimMergeSweep(storeRoot))
    return { ...empty, skippedReason: 'throttled: the last sweep was under 5 minutes ago' };
  if (!(await deps.ghAvailable()))
    return { ...empty, skippedReason: 'gh is not available or not authenticated' };
  // One sweep at a time per store, for the whole sweep (a dry run writes nothing).
  const release = dryRun ? () => undefined : acquireMergeSweepLock(storeRoot, deps.now);
  if (release === null) return { ...empty, skippedReason: 'another merge sweep is running' };
  try {
    return await runSweep(storeRoot, opts, deps, empty, targeted);
  } finally {
    release();
  }
}

/** The prefix of a reason that waits only for independent reviewer verdicts. */
const NOT_VERIFIED = 'not independently verified:';

/** A waiting entry for a PR first seen waiting now (or carried with no history). */
function newWaitingEntry(at: string, pr?: MergedPrRecord): WaitingEntry {
  return {
    firstAt: at,
    nextAt: at,
    intervalMs: MERGE_WAITING_FIRST_BACKOFF_MS / 2,
    mergeSha: pr?.mergeCommitSha ?? null,
    headSha: pr?.headRefOid ?? null,
    lines: [],
    verdictOnly: false,
    reason: 'waiting',
    verdictKey: '',
  };
}

/** The waiting list as entries; the earlier plain-number form is due now. */
function normalizeWaiting(raw: SweepState['waiting'], at: string): Record<string, WaitingEntry> {
  if (raw === undefined) return {};
  if (Array.isArray(raw))
    return Object.fromEntries(raw.map((n) => [String(n), newWaitingEntry(at)]));
  return raw;
}

/** The entry with its backoff doubled (capped) and its next re-judgement scheduled. */
function backedOff(
  entry: WaitingEntry,
  now: number,
  verdictKey: string,
  reason: string,
): WaitingEntry {
  const intervalMs = Math.min(
    Math.max(entry.intervalMs * 2, MERGE_WAITING_FIRST_BACKOFF_MS),
    MERGE_WAITING_MAX_BACKOFF_MS,
  );
  return {
    ...entry,
    intervalMs,
    nextAt: new Date(now + intervalMs).toISOString(),
    verdictKey,
    reason,
  };
}

/** A fingerprint of the verdicts recorded on a PR's tasks (local reads only). */
async function verdictKeyFor(
  storeRoot: string,
  deps: MergeCloseDeps,
  prNumber: number,
  lines: ReadonlyArray<{ taskId: string }>,
): Promise<string> {
  if (!deps.reviewVerdicts) return '';
  const ids: string[] = [];
  for (const line of lines) {
    const verdicts = await deps.reviewVerdicts(storeRoot, line.taskId, prNumber).catch(() => []);
    ids.push(...verdicts.map((v) => v.id));
  }
  return ids.sort().join(',');
}

/**
 * Refuse each PR that waited past {@link MERGE_WAITING_MAX_AGE_MS} (T14101
 * review), with one final comment per task, and drop it from the list.
 */
async function ageOutWaiting(
  storeRoot: string,
  root: string,
  agedOut: ReadonlyArray<[number, WaitingEntry]>,
  deps: MergeCloseDeps,
  dryRun: boolean,
  result: MergeSweepResult,
): Promise<void> {
  for (const [prNumber, entry] of agedOut) {
    const reason = entry.verdictOnly
      ? 'waited 14 days without a reviewer verdict'
      : `waited 14 days without closing: ${entry.reason}`;
    const outcomes: MergeTaskOutcome[] = entry.lines.map((line) => ({
      taskId: line.taskId,
      acs: line.acs,
      action: 'refused',
      reason,
    }));
    for (const o of outcomes) result.refused.push({ taskId: o.taskId, prNumber, reason });
    result.prs.push({ prNumber, mergeSha: entry.mergeSha, outcomes });
    if (dryRun) continue;
    const pr: MergedPrRecord = {
      number: prNumber,
      body: '',
      mergedAt: entry.firstAt,
      headRefOid: entry.headSha,
      mergeCommitSha: entry.mergeSha,
      statusCheckRollup: [],
    };
    await reportRefusals(storeRoot, root, pr, outcomes, deps);
  }
}

/** The sweep proper, under the lock ({@link sweepMergedClosures}). */
async function runSweep(
  storeRoot: string,
  opts: MergeSweepOptions,
  deps: MergeCloseDeps,
  empty: MergeSweepResult,
  targeted: boolean,
): Promise<MergeSweepResult> {
  const dryRun = empty.dryRun;
  const { resolveEvidenceExecutionRoot } = await import('./evidence.js');
  const root = resolveEvidenceExecutionRoot(storeRoot);
  const state = readSweepState(storeRoot);
  const clock = deps.now ?? Date.now;
  const startedAt = new Date(clock()).toISOString();
  const deadline = clock() + MERGE_SWEEP_MAX_RUN_MS;
  const highWater = state.highWater;
  // Re-read an overlap behind the cursor: search can list a PR late.
  const since =
    opts.since ??
    (highWater === undefined
      ? new Date(clock() - MERGE_SWEEP_LOOKBACK_MS).toISOString()
      : new Date(Date.parse(highWater) - MERGE_SWEEP_OVERLAP_MS).toISOString());
  let prs: MergedPrRecord[];
  let backlog: Array<{ since: string; until: string }> = [];
  let newHighWater = highWater;
  const waitingIn = normalizeWaiting(state.waiting, startedAt);
  const waitingOut: Record<string, WaitingEntry> = {};
  const agedOut: Array<[number, WaitingEntry]> = [];
  if (targeted) {
    const viewed = await Promise.all((opts.prNumbers ?? []).map((n) => deps.viewPr(root, n)));
    prs = viewed.filter((pr): pr is MergedPrRecord => pr !== null);
  } else {
    const listed = await listSweepWindows(deps, root, state, since, opts.since !== undefined);
    if (listed === null) return { ...empty, skippedReason: 'gh could not list merged PRs' };
    ({ prs, backlog } = listed);
    if (listed.newestRead !== undefined)
      newHighWater =
        highWater === undefined || listed.newestRead > highWater ? listed.newestRead : highWater;
    // PRs a previous sweep left waiting come back on their backoff (sooner
    // when their verdicts changed); one gh could not view stays listed.
    const known = new Set(prs.map((pr) => pr.number));
    for (const [key, entry] of Object.entries(waitingIn)) {
      const n = Number(key);
      if (known.has(n)) continue;
      if (clock() - Date.parse(entry.firstAt) > MERGE_WAITING_MAX_AGE_MS) {
        agedOut.push([n, entry]);
        continue;
      }
      const verdictKey = await verdictKeyFor(storeRoot, deps, n, entry.lines);
      const changed = verdictKey !== entry.verdictKey;
      if (!changed && clock() < Date.parse(entry.nextAt)) {
        waitingOut[key] = entry;
        continue;
      }
      // Waiting only on verdicts that did not change: still unverified, no gh call.
      if (entry.verdictOnly && !changed) {
        waitingOut[key] = backedOff(entry, clock(), verdictKey, entry.reason);
        continue;
      }
      const pr = await deps.viewPr(root, n);
      if (pr === null) waitingOut[key] = backedOff(entry, clock(), verdictKey, entry.reason);
      else prs.push(pr);
    }
  }
  const required = await deps.requiredChecks(storeRoot);
  const result: MergeSweepResult = { ...empty, swept: true };
  const oldest = backlog[0];
  if (oldest)
    result.truncated = {
      read: prs.length,
      unreadSince: oldest.since,
      unreadBefore: backlog[backlog.length - 1]?.until ?? oldest.until,
    };
  const statuses = { ...(state.statuses ?? {}) };
  const carried: number[] = [];
  const work = async (): Promise<MergeSweepHooks> => {
    const hooks = await applyMergedPrs(
      storeRoot,
      root,
      prs,
      required,
      deps,
      dryRun,
      result,
      deadline,
      carried,
      clock,
    );
    if (!targeted) {
      result.openChecks = await checkOpenPrs(storeRoot, root, deps, dryRun, statuses);
      hooks.macosRegression = await syncMacosRegressionIssues(storeRoot, root, deps, dryRun);
      if (!dryRun && deps.reconcile) {
        hooks.reconcile = await deps.reconcile(storeRoot).catch((err: Error) => ({
          version: null,
          action: 'failed' as const,
          reason: err.message,
        }));
      }
    }
    return hooks;
  };
  // Writes need a bound session; a daemon sweep has none of its own.
  const hooks = dryRun ? await work() : await withSweepSession(storeRoot, work);
  if (Object.keys(hooks).length > 0) result.hooks = hooks;
  if (!targeted) await ageOutWaiting(storeRoot, root, agedOut, deps, dryRun, result);
  if (!dryRun && !targeted) {
    const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
    for (const entry of result.prs) {
      const waits = entry.outcomes.filter((o) => o.action === 'waiting');
      const pr = byNumber.get(entry.prNumber);
      if (waits.length === 0 || pr === undefined) continue;
      const lines = waits.map((o) => ({ taskId: o.taskId, acs: o.acs }));
      const prior = waitingIn[String(entry.prNumber)];
      const verdictKey = await verdictKeyFor(storeRoot, deps, entry.prNumber, lines);
      const reason = waits[0]?.reason ?? 'waiting';
      const next: WaitingEntry = {
        firstAt: prior?.firstAt ?? startedAt,
        nextAt: startedAt,
        intervalMs: prior ? prior.intervalMs : MERGE_WAITING_FIRST_BACKOFF_MS / 2,
        mergeSha: pr.mergeCommitSha,
        headSha: pr.headRefOid,
        lines,
        verdictOnly: waits.every((o) => (o.reason ?? '').startsWith(NOT_VERIFIED)),
        reason,
        verdictKey,
      };
      waitingOut[String(entry.prNumber)] = backedOff(next, clock(), verdictKey, reason);
    }
    // A PR a deadline left is re-judged at the next sweep, its age kept.
    for (const n of carried) {
      const prior = waitingIn[String(n)];
      waitingOut[String(n)] = prior
        ? { ...prior, nextAt: startedAt }
        : newWaitingEntry(startedAt, byNumber.get(n));
    }
    writeSweepState(storeRoot, {
      lastSweptAt: startedAt,
      ...(newHighWater !== undefined ? { highWater: newHighWater } : {}),
      ...(backlog.length > 0 ? { backlog } : {}),
      statuses,
      waiting: waitingOut,
    });
  }
  return result;
}

/**
 * Whether a directory is a CLEO project that takes merged CI as evidence
 * (T14101): a main git checkout (never a linked worktree, never a moved or
 * missing path) with `.cleo/project-context.json` setting
 * `evidence.ciSatisfies`. The daemon sweeps only these, never `$HOME`.
 *
 * @param root - Candidate project root.
 * @returns True when the merge sweep applies.
 */
export function mergeSweepApplies(root: string): boolean {
  try {
    // A main checkout only: a linked worktree's `.git` is a file (gitlink),
    // and a moved or missing path has none.
    if (!statSync(join(root, '.git')).isDirectory()) return false;
    const context = JSON.parse(
      readFileSync(join(root, '.cleo', 'project-context.json'), 'utf-8'),
    ) as { evidence?: { ciSatisfies?: unknown } };
    return context.evidence?.ciSatisfies === true;
  } catch {
    return false;
  }
}

/**
 * The daemon's merge sweep (T14101): every registered project on this
 * machine that {@link mergeSweepApplies} to, behind the same gate the lazy
 * path uses ({@link mergeSweepSpawnAllowed}: never in CI, under vitest, when
 * off, or without gh credentials). Each project's sweep throttles and locks
 * itself. Never throws.
 *
 * @param opts - Environment, project lister and sweep, for tests.
 * @returns The roots swept.
 */
export async function sweepRegisteredProjects(
  opts: {
    env?: NodeJS.ProcessEnv;
    listRoots?: () => Promise<string[]>;
    sweep?: (root: string) => Promise<unknown>;
  } = {},
): Promise<string[]> {
  if (!mergeSweepSpawnAllowed(opts.env ?? process.env)) return [];
  const listRoots =
    opts.listRoots ??
    (async () => {
      const { nexusList } = await import('../nexus/registry.js');
      return (await nexusList()).map((project) => project.path);
    });
  const roots = await listRoots().catch(() => [] as string[]);
  const swept: string[] = [];
  for (const root of new Set(roots)) {
    if (!mergeSweepApplies(root)) continue;
    await (opts.sweep ?? ((r: string) => sweepMergedClosures(r)))(root).catch(() => undefined);
    swept.push(root);
  }
  return swept;
}

/**
 * The PR comment for a receipt (T14101): what the store owner's sweep will
 * close or bind, or why the PR closes nothing, plus the receipt as JSON.
 *
 * @param receipt - The receipt.
 * @returns Markdown for `gh pr comment`.
 */
export function formatMergeReceipt(receipt: MergeReceipt): string {
  const lines = receipt.closesNothing
    ? [`CLEO merge-close: this PR closes nothing, because ${receipt.closesNothing}`]
    : [
        "CLEO merge-close receipt: the store owner's sweep (`cleo done --from-merge`) will record this PR's evidence for:",
        ...receipt.directives.map(
          (d) => `- ${d.kind === 'closes' ? 'close' : 'bind'} ${d.taskId} (${d.acs.join(', ')})`,
        ),
      ];
  return [...lines, '', '```json', JSON.stringify(receipt, null, 2), '```'].join('\n');
}

/**
 * Judge one merged PR without a task store and optionally comment the
 * receipt on it (T14101): the GitHub job's half. Reads only `gh` and the
 * tracked `.cleo/project-context.json` (for the required checks).
 *
 * @param storeRoot - Checkout root (the project context is read from it).
 * @param prNumber - The merged PR.
 * @param opts - `comment: true` posts the receipt on the PR.
 * @param deps - Outside access.
 * @returns The receipt, or null when `gh` could not read a merged PR.
 */
export async function mergeReceiptFor(
  storeRoot: string,
  prNumber: number,
  opts: { comment?: boolean } = {},
  deps: MergeCloseDeps = defaultMergeCloseDeps,
): Promise<{ receipt: MergeReceipt; commented: boolean } | null> {
  const pr = await deps.viewPr(storeRoot, prNumber);
  if (pr === null) return null;
  const receipt = await judgeMergedPr(pr, await deps.requiredChecks(storeRoot));
  const commented =
    opts.comment === true && (await deps.comment(storeRoot, prNumber, formatMergeReceipt(receipt)));
  return { receipt, commented };
}

/**
 * Turn open `macos-regression` issues into tasks (T14104), one per issue,
 * under the task `release.macosRegressionParent` names (an epic; unset, the
 * sync reads nothing), linked by issue URL in the external
 * task links so a rerun creates nothing twice; close an issue once its task is
 * done. Never throws. Under `dryRun` it creates and closes nothing.
 */
async function syncMacosRegressionIssues(
  storeRoot: string,
  root: string,
  deps: MergeCloseDeps,
  dryRun: boolean,
): Promise<MacosRegressionSync> {
  const sync: MacosRegressionSync = { created: [], closedIssues: [] };
  // A root task must be a saga, so without a configured container there is
  // nowhere to file the tasks: read no issues at all.
  const { loadProjectContext } = await import('../agents/variable-substitution.js');
  const ctx = loadProjectContext(storeRoot);
  const release = (ctx.context?.['release'] ?? {}) as { macosRegressionParent?: unknown };
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const accessor = await getTaskAccessor(storeRoot);
  const parent =
    typeof release.macosRegressionParent === 'string'
      ? await accessor.loadSingleTask(release.macosRegressionParent)
      : null;
  if (parent === null)
    return { ...sync, skippedReason: 'release.macosRegressionParent names no task in this store' };
  const issues = await deps.listLabelledIssues(root, MACOS_REGRESSION_LABEL);
  if (issues === null) return { ...sync, skippedReason: 'gh could not list issues' };
  const links = await import('../reconciliation/link-store.js');
  for (const issue of issues) {
    try {
      const link = await links.getLinkByExternalId(ISSUE_LINK_PROVIDER, issue.url, storeRoot);
      if (link === null) {
        if (dryRun) {
          sync.created.push(issue.url);
          continue;
        }
        const { addTask } = await import('./add.js');
        const added = await addTask(
          {
            title: `macOS regression: ${issue.title}`,
            description: `Opened from ${issue.url} by the merge sweep (T14104).`,
            acceptance: [
              `the macOS failure in ${issue.url} is fixed and its shards pass on main nightly`,
            ],
            parentId: parent.id,
            labels: [MACOS_REGRESSION_LABEL],
            // The issue URL is the identity (deduped by the link below); two
            // regressions with similar titles are still two tasks. Audited.
            forceDuplicate: true,
          },
          storeRoot,
          accessor,
        );
        await links.createLink(
          {
            taskId: added.task.id,
            providerId: ISSUE_LINK_PROVIDER,
            externalId: issue.url,
            externalUrl: issue.url,
            externalTitle: issue.title,
            linkType: 'created',
            syncDirection: 'inbound',
          },
          storeRoot,
        );
        sync.created.push(added.task.id);
        continue;
      }
      const task = await accessor.loadSingleTask(link.taskId);
      if (task?.status !== 'done' || dryRun) continue;
      const comment = `CLEO: ${task.id} is done; closing this macOS regression.`;
      if (await deps.closeIssue(root, issue.url, comment)) sync.closedIssues.push(issue.url);
    } catch {
      // One issue's failure never stops the others; the next sweep retries it.
    }
  }
  return sync;
}

const PR_FIELDS = 'number,body,mergedAt,headRefOid,mergeCommit,statusCheckRollup';

/** Normalise one `gh pr list/view --json PR_FIELDS` row (an open PR has `mergedAt: ''`). */
function toMergedPr(row: unknown): MergedPrRecord | null {
  if (row === null || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.number !== 'number') return null;
  const merge = r.mergeCommit as { oid?: unknown } | null | undefined;
  return {
    number: r.number,
    body: typeof r.body === 'string' ? r.body : '',
    mergedAt: typeof r.mergedAt === 'string' ? r.mergedAt : '',
    headRefOid: typeof r.headRefOid === 'string' ? r.headRefOid : null,
    mergeCommitSha: typeof merge?.oid === 'string' ? merge.oid : null,
    statusCheckRollup: Array.isArray(r.statusCheckRollup)
      ? (r.statusCheckRollup as GhPrViewPayload['statusCheckRollup'])
      : [],
  };
}

async function gh(args: string[], cwd: string): Promise<string | null> {
  const { ghQueryTimeoutMs } = await import('../release/github-pr.js');
  try {
    return execFileSync('gh', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: ghQueryTimeoutMs(),
    });
  } catch {
    return null;
  }
}

/** A step's engine result as a {@link StepResult}. */
function stepOf(r: { success: boolean; error?: { message?: string } | null }): StepResult {
  return r.success ? { ok: true } : { ok: false, reason: r.error?.message ?? 'refused' };
}

/** The default {@link MergeCloseDeps}: `gh`, and the `cleo done --pr` record and complete path. */
export const defaultMergeCloseDeps: MergeCloseDeps = {
  async listMergedPrs(root, since, until) {
    const out = await gh(
      [
        'pr',
        'list',
        '--state',
        'merged',
        '--search',
        until === undefined ? `merged:>=${since}` : `merged:${since}..${until}`,
        '--limit',
        String(MERGE_SWEEP_PR_LIMIT),
        '--json',
        PR_FIELDS,
      ],
      root,
    );
    if (out === null) return null;
    const rows: unknown = JSON.parse(out);
    if (!Array.isArray(rows)) return null;
    return rows.flatMap((row) => {
      const pr = toMergedPr(row);
      // No date filter here: the search is the window, and a page's length
      // tells the sweep whether older PRs remain.
      return pr && pr.mergedAt !== '' ? [pr] : [];
    });
  },
  async viewPr(root, prNumber) {
    const out = await gh(['pr', 'view', String(prNumber), '--json', PR_FIELDS], root);
    return out === null ? null : toMergedPr(JSON.parse(out));
  },
  async comment(root, prNumber, body) {
    return (await gh(['pr', 'comment', String(prNumber), '--body', body], root)) !== null;
  },
  async requiredChecks(storeRoot) {
    const { loadProjectContext } = await import('../agents/variable-substitution.js');
    const { resolveRequiredWorkflows } = await import('../release/pr-evidence.js');
    const ctx = loadProjectContext(storeRoot);
    return resolveRequiredWorkflows(process.env, ctx.loaded ? ctx.context : null);
  },
  async ghAvailable() {
    const { isGhCliAvailable } = await import('../release/github-pr.js');
    return isGhCliAvailable();
  },
  async record(storeRoot, taskId, prNumber, acs, dryRun) {
    const satisfies = acs;
    if (dryRun) {
      const { planTaskDone } = await import('./done-plan.js');
      const plan = await planTaskDone(taskId, { projectRoot: storeRoot, prNumber, satisfies });
      if (!plan.success) return stepOf(plan);
      const blocker = plan.data.blockers[0];
      return blocker ? { ok: false, reason: blocker.message } : { ok: true };
    }
    const { recordTaskDone } = await import('./done-record.js');
    const recorded = await recordTaskDone(taskId, {
      projectRoot: storeRoot,
      prNumber,
      satisfies,
      agent: 'merge-close',
      // The sweep runs no tool: a gate it cannot take from merged CI stays an
      // agent's (evidence.ciSatisfies makes testsPassed/qaPassed ci:<pr>).
      steps: {
        runTool: async (tool) => ({
          exitCode: null,
          cacheHit: false,
          durationMs: 0,
          timedOut: false,
          tail: '',
          killed: `merge-close runs no tool (${tool}); set evidence.ciSatisfies so merged CI records testsPassed and qaPassed`,
        }),
      },
    });
    return stepOf(recorded);
  },
  async complete(storeRoot, taskId, prNumber) {
    const { taskComplete } = await import('./complete.js');
    return stepOf(await taskComplete(storeRoot, taskId, { prNumber }));
  },
  async listLabelledIssues(root, label) {
    const args = ['issue', 'list', '--label', label, '--state', 'open', '--json', 'url,title'];
    const out = await gh([...args, '--limit', String(MERGE_SWEEP_PR_LIMIT)], root);
    if (out === null) return null;
    const rows: unknown = JSON.parse(out);
    if (!Array.isArray(rows)) return null;
    return rows.flatMap((row) => {
      const r = row as { url?: unknown; title?: unknown };
      return typeof r.url === 'string' && typeof r.title === 'string'
        ? [{ url: r.url, title: r.title }]
        : [];
    });
  },
  async reviewVerdicts(storeRoot, taskId, prNumber) {
    const { reviewVerdictsFor } = await import('./review-verdict.js');
    return reviewVerdictsFor(storeRoot, taskId, prNumber);
  },
  async docsRot(storeRoot, pr) {
    // T14111: flag the docs whose covers: globs match the merge's own changes.
    const { flagDocsRot } = await import('../docs/rot.js');
    return flagDocsRot(storeRoot, pr);
  },
  async closeIssue(root, url, comment) {
    return (await gh(['issue', 'close', url, '--comment', comment], root)) !== null;
  },
  async mergeCiRun(root, sha, workflow) {
    const args = ['run', 'list', '--commit', sha, '--workflow', workflow, '--limit', '1'];
    const out = await gh([...args, '--json', 'databaseId,status,conclusion'], root);
    if (out === null) return null;
    const [run] = JSON.parse(out) as Array<{
      databaseId?: number;
      status?: string;
      conclusion?: string | null;
    }>;
    return run?.databaseId === undefined
      ? null
      : { runId: run.databaseId, status: run.status ?? '', conclusion: run.conclusion ?? null };
  },
  async rerunRun(root, runId) {
    return (await gh(['run', 'rerun', String(runId)], root)) !== null;
  },
  canRerun() {
    // Disabled until T14136 gives reruns their own concurrency group; opt in
    // with CLEO_MERGE_SWEEP_RERUN=1, and never inside a CI job.
    return process.env['CLEO_MERGE_SWEEP_RERUN'] === '1' && process.env['CI'] !== 'true';
  },
  async listOpenPrs(root) {
    const fields = 'number,body,headRefOid';
    const out = await gh(
      ['pr', 'list', '--state', 'open', '--limit', String(MERGE_SWEEP_PR_LIMIT), '--json', fields],
      root,
    );
    if (out === null) return null;
    const rows: unknown = JSON.parse(out);
    return Array.isArray(rows) ? rows.flatMap((row) => toMergedPr(row) ?? []) : null;
  },
  async setStatus(root, sha, state, description) {
    const args = [
      'api',
      '--method',
      'POST',
      `repos/{owner}/{repo}/statuses/${sha}`,
      '-f',
      `state=${state}`,
      '-f',
      `context=${MERGE_CLOSE_STATUS_CONTEXT}`,
      '-f',
      `description=${description}`,
    ];
    return (await gh(args, root)) !== null;
  },
};
