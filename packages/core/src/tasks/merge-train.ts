/**
 * Merge train (T14371, owner decision D11237): merge every open PR whose
 * required checks are green on its exact head and whose per-AC review passes,
 * one at a time, then run the merge sweep for it. Works in any project with a
 * GitHub remote; dry run by default.
 *
 * The rules come from merge incidents:
 *
 * 1. Merge only the head that was reviewed: verdicts are per head and the
 *    merge is pinned with `--match-head-commit`.
 * 2. Green is the required check run(s) on that exact sha, read from each
 *    run's latest attempt (`jobs?filter=latest`); an empty conclusion is not
 *    green and run-level status is never read.
 * 3. A red whose failing job logs show only a runner shutdown or a
 *    cancellation is infra: rerun the failed jobs, at most
 *    {@link MERGE_TRAIN_MAX_RERUNS} times per head, then stop and surface. Any
 *    other red is real: reported once per head, never rerun.
 * 4. An old main run is rerun only when that commit's workflow file gives a
 *    rerun its own per-sha concurrency group (`-rerun-{0}`) and does not
 *    cancel in progress on main; otherwise the rerun cancels main's newest run.
 * 5. The sweep runs once the merge commit has a completed `push` run
 *    (scheduled runs on the same sha do not count).
 * 6. `Merge-After: #<n>` holds a PR until PR n merged, and a PR stacked on a
 *    branch other than the default one is never merged; a PR is held while
 *    `cleo done --from-merge --dry-run` says waiting or refused.
 * 7. One train per repository (a heartbeat lock); a GitHub API error is a
 *    retry, never a CI failure.
 * 8. The PR body's `Closes:`/`Refs:` lines must resolve (a bare `Refs:` line
 *    links nothing).
 * 9. A train that stops (crash, lost lock) says so, now or on the next run.
 *
 * While main's latest completed push run is red, nothing merges except a PR
 * labelled {@link MAIN_FIX_LABEL}.
 *
 * @task T14371
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MergeSweepResult, ReviewJudgement } from '@cleocode/contracts';

/** Label that lets a PR merge while main is red: it is the fix. */
export const MAIN_FIX_LABEL = 'main-fix';

/** Infra reruns allowed per head (PR head or main commit) before the train stops trying. */
export const MERGE_TRAIN_MAX_RERUNS = 3;

/** Heartbeat age after which a train's lock is stale. */
export const MERGE_TRAIN_LOCK_STALE_MS = 10 * 60_000;

const LOCK_FILE = 'merge-train.lock';
const STATE_FILE = 'merge-train-state.json';

/** An open PR as the train reads it. */
export interface TrainPr {
  /** PR number. */
  number: number;
  /** Current head sha. */
  headSha: string;
  /** Draft PRs never merge. */
  isDraft: boolean;
  /** PR body (its `Closes:`/`Refs:`/`Merge-After:` lines). */
  body: string;
  /** Label names. */
  labels: string[];
  /** Base branch name. */
  baseRef: string;
}

/** One GitHub Actions workflow run. */
export interface TrainRun {
  /** Run id. */
  id: number;
  /** Triggering event (`push`, `pull_request`, `schedule`, ...). */
  event: string;
  /** `queued`, `in_progress`, `completed`, ... */
  status: string;
  /** The commit it ran on. */
  headSha: string;
  /** Workflow name. */
  workflowName: string;
  /** Workflow file path (`.github/workflows/ci.yml`). */
  workflowPath: string;
  /** Creation time (ISO), for newest-first ordering. */
  createdAt: string;
}

/** One job of a run's latest attempt. */
export interface TrainJob {
  /** Job id. */
  id: number;
  /** Job name (the check-run name). */
  name: string;
  /** `queued`, `in_progress`, `completed`, ... */
  status: string;
  /** `success`, `failure`, `cancelled`, ...; null while unfinished. */
  conclusion: string | null;
}

/** A GitHub read or write that failed (a 502, a timeout): the train retries it, never counts it as CI. */
export class MergeTrainApiError extends Error {}

/** Everything the train reads from or does on GitHub. Tests inject fixtures. */
export interface MergeTrainGitHub {
  /** The repository's default branch. */
  defaultBranch(): Promise<string>;
  /** Open PRs. */
  openPrs(): Promise<TrainPr[]>;
  /** Whether a PR has merged. */
  prMerged(prNumber: number): Promise<boolean>;
  /** Workflow runs, newest first, filtered by commit or branch and event. */
  runs(query: { sha?: string; branch?: string; event?: string }): Promise<TrainRun[]>;
  /** The jobs of a run's latest attempt (`jobs?filter=latest`). */
  latestJobs(runId: number): Promise<TrainJob[]>;
  /** A job's plain-text log. */
  jobLog(jobId: number): Promise<string>;
  /** A file's text at a commit, or null when it does not exist there. */
  fileAt(sha: string, path: string): Promise<string | null>;
  /** Rerun a run's failed jobs. */
  rerunFailed(runId: number): Promise<void>;
  /** Merge a PR pinned to `headSha`; returns the merge commit sha (null when GitHub reports none). */
  merge(prNumber: number, headSha: string): Promise<string | null>;
}

/** The train's outside access. */
export interface MergeTrainDeps {
  /** GitHub. */
  github: MergeTrainGitHub;
  /** Required check names (`release.prRequiredWorkflows`). */
  requiredChecks(root: string): Promise<string[]>;
  /** `cleo review check` for the PR's tasks: each judgement names the head it was judged on. */
  reviewCheck(
    root: string,
    prNumber: number,
    lines: ReadonlyArray<{ taskId: string; acs: string[] }>,
  ): Promise<Array<ReviewJudgement & { taskId: string }>>;
  /** `cleo done --from-merge <pr> --dry-run`. */
  closureDryRun(root: string, prNumber: number): Promise<MergeSweepResult>;
  /** `cleo done --from-merge <pr>`: the merge sweep for one PR. */
  sweep(root: string, prNumber: number): Promise<MergeSweepResult>;
  /** Clock (ms). */
  now?(): number;
}

/** What the train did, or would do, with one open PR. */
export interface MergeTrainDecision {
  /** PR number. */
  prNumber: number;
  /** The head judged. */
  headSha: string;
  /**
   * `merge`: would merge (dry run). `merged`: merged. `rerun`: infra-only red,
   * failed jobs rerun (dry run: would be). `retry`: a GitHub API error, judged
   * again next run. `skip`: not merged; `reason` says why.
   */
  action: 'merge' | 'merged' | 'rerun' | 'retry' | 'skip';
  /** Why. */
  reason: string;
  /** Set on a real CI failure or an exhausted rerun budget the first time it is seen on this head. */
  firstReport?: boolean;
  /** The merge commit, for `merged`. */
  mergeSha?: string | null;
}

/** A merged PR's sweep, run once its merge commit has a completed push run. */
export interface MergeTrainSweep {
  /** PR number. */
  prNumber: number;
  /** Its merge commit. */
  mergeSha: string | null;
  /** `swept`, `pending` (no completed push run yet), or `would-sweep` (dry run). */
  action: 'swept' | 'pending' | 'would-sweep';
  /** Tasks the sweep closed. */
  closed?: string[];
  /** Why, when pending or the sweep did not run. */
  reason?: string;
}

/** Main's latest completed push run, judged on the required checks. */
export interface MergeTrainMainState {
  /** `green`, `red`, or `unknown` (no completed push run carries a required check). */
  state: 'green' | 'red' | 'unknown';
  /** The commit judged. */
  sha?: string;
  /** The run judged. */
  runId?: number;
  /** Why, when not green. */
  reason?: string;
}

/** Result of {@link runMergeTrain} / `cleo merge train`. */
export interface MergeTrainResult {
  /** Whether this was a dry run (nothing merged, rerun, swept or written). */
  dryRun: boolean;
  /** False when the train did not judge any PR; `skippedReason` says why. */
  ran: boolean;
  /** Why it did not run. */
  skippedReason?: string;
  /** Main's state. */
  main?: MergeTrainMainState;
  /** What was done about main's infra-only red, when anything. */
  mainRerun?: string;
  /** One decision per open PR, in PR-number order. */
  decisions: MergeTrainDecision[];
  /** Sweeps of PRs this train merged. */
  sweeps: MergeTrainSweep[];
  /** Set when this train stopped before finishing (crash, lost lock). */
  stopped?: string;
  /** Set when the previous train stopped without finishing and nothing reported it. */
  previousRunStopped?: string;
}

/** The persisted state: rerun counts and reports per head, sweeps owed, and the running marker. */
interface TrainState {
  reruns?: Record<string, number>;
  reported?: Record<string, string>;
  pendingSweeps?: Array<{ prNumber: number; mergeSha: string | null }>;
  running?: { pid: number; startedAt: string };
}

/** Options of {@link runMergeTrain}. */
export interface MergeTrainOptions {
  /** Merge, rerun and sweep (default: dry run, which changes nothing). */
  execute?: boolean;
}

const MERGE_AFTER_LINE = /^[ \t>*-]*Merge-After[ \t]*:[ \t]*#?(\d+)/gim;

/**
 * The PRs a body's `Merge-After: #<n>` lines say must merge first.
 *
 * @param body - The PR body.
 * @returns The PR numbers.
 */
export function parseMergeAfter(body: string): number[] {
  return [...body.matchAll(MERGE_AFTER_LINE)].map((m) => Number(m[1]));
}

/**
 * Whether a workflow file lets an old main run be rerun without cancelling
 * main's newest run (rule 4): its concurrency group gives a rerun its own
 * per-sha group (`-rerun-{0}`), and `cancel-in-progress` is `false` or
 * conditioned off the default branch (`github.ref != 'refs/heads/...'`).
 *
 * @param workflow - The workflow file's text at the run's commit.
 * @returns True when a rerun is safe.
 */
export function rerunSafeConcurrency(workflow: string): boolean {
  const block = /^concurrency:\s*\n((?:[ \t]+.*\n?)+)/m.exec(workflow)?.[1] ?? '';
  const group = /^[ \t]+group:(.*)$/m.exec(block)?.[1] ?? '';
  const cancel = /^[ \t]+cancel-in-progress:(.*)$/m.exec(block)?.[1]?.trim() ?? '';
  const cancelOffMain = cancel === 'false' || /github\.ref\s*!=\s*'refs\/heads\//.test(cancel);
  return group.includes("'-rerun-{0}'") && cancelOffMain;
}

/** Whether a failing job's log shows only infra: a runner shutdown or a cancellation (rule 3). */
async function isInfraFailure(github: MergeTrainGitHub, job: TrainJob): Promise<boolean> {
  if (job.conclusion === 'cancelled') return true;
  const log = await github.jobLog(job.id);
  if (/The runner has received a shutdown signal/.test(log)) return true;
  const { isRunnerCancelOnlyLog } = await import('../release/ci-evidence.js');
  return isRunnerCancelOnlyLog(log);
}

/** Required checks judged on one commit's runs (rule 2). */
type CiState =
  | { state: 'green' }
  | { state: 'pending'; reason: string }
  | { state: 'red'; reason: string; runIds: number[]; failing: TrainJob[] };

const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);

/**
 * Judge the required checks on a set of runs of one commit, from each run's
 * latest attempt: a check named exactly like a job must be that job with
 * `success`; a check named like a workflow needs every job of its newest run
 * completed with `success` or `skipped`, at least one `success`. Unfinished,
 * empty-conclusion and missing checks are pending, never green.
 */
async function judgeChecks(
  github: MergeTrainGitHub,
  runs: readonly TrainRun[],
  required: readonly string[],
): Promise<CiState> {
  const newest = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const jobsOf = new Map<number, TrainJob[]>();
  for (const run of newest) jobsOf.set(run.id, await github.latestJobs(run.id));
  const pending: string[] = [];
  const red: Array<{ name: string; run: TrainRun }> = [];
  for (const name of required) {
    const byJob = newest.find((r) => jobsOf.get(r.id)?.some((j) => j.name === name));
    const byWorkflow = newest.find((r) => r.workflowName === name);
    const run = byJob ?? byWorkflow;
    if (run === undefined) {
      pending.push(`${name} has not run`);
      continue;
    }
    const jobs = (jobsOf.get(run.id) ?? []).filter((j) => byJob === undefined || j.name === name);
    if (jobs.length === 0 || jobs.some((j) => j.status !== 'completed' || !j.conclusion)) {
      pending.push(`${name} has not finished`);
      continue;
    }
    const ok =
      byJob !== undefined
        ? jobs.every((j) => j.conclusion === 'success')
        : jobs.every((j) => j.conclusion === 'success' || j.conclusion === 'skipped') &&
          jobs.some((j) => j.conclusion === 'success');
    if (!ok) red.push({ name, run });
  }
  if (red.length > 0) {
    const runIds = [...new Set(red.map((r) => r.run.id))];
    const all = runIds.flatMap((id) =>
      (jobsOf.get(id) ?? []).filter((j) => FAILED.has(j.conclusion ?? '')),
    );
    // The required aggregate job fails because a job it needs failed: judge that job's log.
    const others = all.filter((j) => !required.includes(j.name));
    return {
      state: 'red',
      reason: `required ${red.map((r) => r.name).join(', ')} failed`,
      runIds,
      failing: others.length > 0 ? others : all,
    };
  }
  if (pending.length > 0) return { state: 'pending', reason: pending.join('; ') };
  return { state: 'green' };
}

function statePath(root: string): string {
  return join(root, '.cleo', STATE_FILE);
}

function readState(root: string): TrainState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(root), 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as TrainState) : {};
  } catch {
    return {};
  }
}

/** Write the state tmp-then-rename, so a reader never sees half a file. */
function writeState(root: string, state: TrainState): void {
  mkdirSync(join(root, '.cleo'), { recursive: true });
  const path = statePath(root);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Main's latest completed push run, judged on the required checks. */
async function judgeMain(
  github: MergeTrainGitHub,
  branch: string,
  required: readonly string[],
): Promise<{ main: MergeTrainMainState; ci?: CiState; run?: TrainRun }> {
  const runs = (await github.runs({ branch, event: 'push' })).filter(
    (r) => r.event === 'push' && r.status === 'completed',
  );
  const bySha = new Map<string, TrainRun[]>();
  for (const run of runs) bySha.set(run.headSha, [...(bySha.get(run.headSha) ?? []), run]);
  // Newest commit first (runs come newest first); bounded so a quiet repo costs few calls.
  for (const [sha, shaRuns] of [...bySha.entries()].slice(0, 3)) {
    const ci = await judgeChecks(github, shaRuns, required);
    if (ci.state === 'pending') continue;
    const run = shaRuns[0];
    const main: MergeTrainMainState = {
      state: ci.state,
      sha,
      ...(run ? { runId: run.id } : {}),
      ...(ci.state === 'red' ? { reason: `main ${sha.slice(0, 9)}: ${ci.reason}` } : {}),
    };
    return { main, ci, ...(run ? { run } : {}) };
  }
  return {
    main: { state: 'unknown', reason: 'no completed push run on main carries the required checks' },
  };
}

/** Rerun main's infra-only red when its workflow makes that safe (rules 3 and 4). */
async function rerunMain(
  github: MergeTrainGitHub,
  ci: Extract<CiState, { state: 'red' }>,
  run: TrainRun,
  state: TrainState,
  execute: boolean,
): Promise<string> {
  for (const job of ci.failing)
    if (!(await isInfraFailure(github, job)))
      return `main ${run.headSha.slice(0, 9)} failed for real (${job.name}); not rerun`;
  const workflow = await github.fileAt(run.headSha, run.workflowPath);
  if (workflow === null || !rerunSafeConcurrency(workflow))
    return `main ${run.headSha.slice(0, 9)} red on infra, but its ${run.workflowPath} has no per-sha rerun concurrency group: a rerun would cancel main's newest run`;
  const key = `main:${run.headSha}`;
  const n = state.reruns?.[key] ?? 0;
  if (n >= MERGE_TRAIN_MAX_RERUNS)
    return `main ${run.headSha.slice(0, 9)} red on infra ${n} times; needs attention`;
  if (!execute) return `would rerun failed jobs of main run(s) ${ci.runIds.join(', ')}`;
  for (const id of ci.runIds) await github.rerunFailed(id);
  state.reruns = { ...state.reruns, [key]: n + 1 };
  return `reran failed jobs of main run(s) ${ci.runIds.join(', ')} (${n + 1} of ${MERGE_TRAIN_MAX_RERUNS})`;
}

/** Judge (and with `execute`, act on) one open PR. */
async function judgePr(
  root: string,
  pr: TrainPr,
  ctx: {
    deps: MergeTrainDeps;
    branch: string;
    required: readonly string[];
    mainRed: boolean;
    state: TrainState;
    execute: boolean;
  },
): Promise<MergeTrainDecision> {
  const { deps, state, execute } = ctx;
  const github = deps.github;
  const base = { prNumber: pr.number, headSha: pr.headSha };
  const skip = (reason: string): MergeTrainDecision => ({ ...base, action: 'skip', reason });
  const headKey = `${pr.number}:${pr.headSha}`;
  /** A failure surfaced once per head: `firstReport` only the first time. */
  const report = (reason: string): MergeTrainDecision => {
    const first = state.reported?.[headKey] === undefined;
    if (first && execute) state.reported = { ...state.reported, [headKey]: reason };
    return { ...skip(reason), ...(first ? { firstReport: true } : {}) };
  };
  if (pr.isDraft) return skip('draft');
  if (pr.baseRef !== ctx.branch)
    return skip(
      `stacked on ${pr.baseRef}: merge that branch's PR first, then retarget to ${ctx.branch}`,
    );
  for (const first of parseMergeAfter(pr.body))
    if (!(await github.prMerged(first))) return skip(`Merge-After: #${first} has not merged`);
  const { parseMergeDirectives } = await import('./merge-close.js');
  const { directives, errors } = parseMergeDirectives(pr.body);
  if (errors.length > 0) return skip(`malformed Closes:/Refs: lines: ${errors.join(' ')}`);
  if (directives.length === 0)
    return skip(
      'the body names no task (a bare "Refs:" line links nothing; add "Closes: T#### AC1,AC2")',
    );
  if (ctx.mainRed && !pr.labels.includes(MAIN_FIX_LABEL))
    return skip(`main is red; only a PR labelled ${MAIN_FIX_LABEL} merges`);
  const ci = await judgeChecks(github, await github.runs({ sha: pr.headSha }), ctx.required);
  if (ci.state === 'pending') return skip(`CI on ${pr.headSha.slice(0, 9)}: ${ci.reason}`);
  if (ci.state === 'red') {
    for (const job of ci.failing)
      if (!(await isInfraFailure(github, job)))
        return report(`CI on ${pr.headSha.slice(0, 9)} failed for real (${job.name}); not rerun`);
    const n = state.reruns?.[headKey] ?? 0;
    if (n >= MERGE_TRAIN_MAX_RERUNS)
      return report(`CI on ${pr.headSha.slice(0, 9)} red on infra ${n} times; needs attention`);
    if (execute) {
      for (const id of ci.runIds) await github.rerunFailed(id);
      state.reruns = { ...state.reruns, [headKey]: n + 1 };
    }
    return {
      ...base,
      action: 'rerun',
      reason: `infra-only red (${ci.failing.map((j) => j.name).join(', ')}); rerun ${n + 1} of ${MERGE_TRAIN_MAX_RERUNS}`,
    };
  }
  const reviews = await deps.reviewCheck(root, pr.number, directives);
  const moved = reviews.find((r) => r.headSha !== pr.headSha);
  if (moved)
    return skip(`head moved to ${moved.headSha.slice(0, 9)} after it was judged; judge again`);
  const gaps = reviews.flatMap((r) => r.gaps.map((g) => `${r.taskId} ${g.reason}`));
  if (gaps.length > 0) return skip(`review check: ${gaps.join('; ')}`);
  const dry = await deps.closureDryRun(root, pr.number);
  const outcome = dry.prs.find((p) => p.prNumber === pr.number);
  if (!dry.swept || outcome === undefined)
    return {
      ...base,
      action: 'retry',
      reason: `done --from-merge --dry-run did not run: ${dry.skippedReason ?? 'PR not read'}`,
    };
  if (outcome.closesNothing) return skip(`done --from-merge --dry-run: ${outcome.closesNothing}`);
  const held = outcome.outcomes.filter((o) => o.action === 'waiting' || o.action === 'refused');
  if (held.length > 0)
    return skip(
      `done --from-merge --dry-run: ${held.map((o) => `${o.taskId} ${o.action}: ${o.reason ?? ''}`).join('; ')}`,
    );
  if (!execute)
    return { ...base, action: 'merge', reason: 'green on head, reviewed, Closes: lines resolve' };
  const mergeSha = await github.merge(pr.number, pr.headSha);
  state.pendingSweeps = [...(state.pendingSweeps ?? []), { prNumber: pr.number, mergeSha }];
  return {
    ...base,
    action: 'merged',
    reason: 'green on head, reviewed, Closes: lines resolve',
    mergeSha,
  };
}

/** Sweep each merged PR whose merge commit has a completed push run (rule 5). */
async function runSweeps(
  root: string,
  deps: MergeTrainDeps,
  state: TrainState,
  execute: boolean,
): Promise<MergeTrainSweep[]> {
  const sweeps: MergeTrainSweep[] = [];
  const owed: NonNullable<TrainState['pendingSweeps']> = [];
  for (const entry of state.pendingSweeps ?? []) {
    const runs =
      entry.mergeSha === null
        ? []
        : (await deps.github.runs({ sha: entry.mergeSha, event: 'push' })).filter(
            (r) => r.event === 'push' && r.status === 'completed',
          );
    if (runs.length === 0) {
      owed.push(entry);
      sweeps.push({
        ...entry,
        action: 'pending',
        reason: 'its merge commit has no completed push run yet',
      });
      continue;
    }
    if (!execute) {
      sweeps.push({ ...entry, action: 'would-sweep' });
      continue;
    }
    const swept = await deps.sweep(root, entry.prNumber);
    if (!swept.swept) {
      owed.push(entry);
      sweeps.push({
        ...entry,
        action: 'pending',
        reason: swept.skippedReason ?? 'the sweep did not run',
      });
      continue;
    }
    sweeps.push({ ...entry, action: 'swept', closed: swept.closed });
  }
  state.pendingSweeps = owed;
  return sweeps;
}

/** Take the train lock: the release, and whether it is still ours. */
async function takeLock(
  root: string,
  now: () => number,
): Promise<{ release: () => void; holds: () => boolean } | null> {
  const { acquireHeartbeatLock, lockHolds } = await import('./merge-close.js');
  mkdirSync(join(root, '.cleo'), { recursive: true });
  const lock = join(root, '.cleo', LOCK_FILE);
  const release = acquireHeartbeatLock(lock, MERGE_TRAIN_LOCK_STALE_MS, now);
  if (release === null) return null;
  const token = readFileSync(lock, 'utf-8');
  return { release, holds: () => lockHolds(lock, token) };
}

/**
 * Run the merge train once: judge every open PR, and with `execute` merge
 * those that pass, one at a time, rerun infra-only reds, and sweep merged PRs
 * whose merge commit's push run completed. Idempotent: safe on a schedule.
 *
 * @param root - Project root (state and lock live in its `.cleo/`).
 * @param opts - `execute: true` acts; otherwise a dry run that changes nothing.
 * @param deps - Outside access; defaults to `gh` and the review and sweep paths.
 * @returns One decision per open PR, the sweeps, and whether the train stopped.
 * @example
 * ```ts
 * const r = await runMergeTrain(root);
 * for (const d of r.decisions) console.log(d.prNumber, d.action, d.reason);
 * ```
 */
export async function runMergeTrain(
  root: string,
  opts: MergeTrainOptions = {},
  deps?: MergeTrainDeps,
): Promise<MergeTrainResult> {
  const execute = opts.execute === true;
  const d = deps ?? (await defaultMergeTrainDeps(root));
  const clock = d.now ?? Date.now;
  const result: MergeTrainResult = { dryRun: !execute, ran: false, decisions: [], sweeps: [] };
  const lock = execute
    ? await takeLock(root, clock)
    : { release: () => undefined, holds: () => true };
  if (lock === null)
    return { ...result, skippedReason: 'another merge train is running in this repository' };
  const state = readState(root);
  if (state.running)
    result.previousRunStopped = `the train started ${state.running.startedAt} (pid ${state.running.pid}) stopped without finishing`;
  if (execute) {
    state.running = { pid: process.pid, startedAt: new Date(clock()).toISOString() };
    writeState(root, state);
  }
  try {
    const branch = await d.github.defaultBranch();
    const required = await d.requiredChecks(root);
    result.sweeps = await runSweeps(root, d, state, execute);
    const judged = await judgeMain(d.github, branch, required);
    result.main = judged.main;
    if (judged.ci?.state === 'red' && judged.run)
      result.mainRerun = await rerunMain(d.github, judged.ci, judged.run, state, execute);
    const prs = [...(await d.github.openPrs())].sort((a, b) => a.number - b.number);
    result.ran = true;
    const ctx = { deps: d, branch, required, mainRed: judged.main.state === 'red', state, execute };
    for (const pr of prs) {
      if (!lock.holds()) {
        result.stopped = `lost the merge-train lock before PR #${pr.number}; stopped`;
        break;
      }
      const decision = await judgePr(root, pr, ctx).catch(
        (err: Error): MergeTrainDecision => ({
          prNumber: pr.number,
          headSha: pr.headSha,
          action: 'retry',
          reason: `GitHub or store error, judged again next run: ${err.message}`,
        }),
      );
      result.decisions.push(decision);
    }
  } catch (err) {
    if (err instanceof MergeTrainApiError)
      result.skippedReason = `GitHub API error, retried next run: ${err.message}`;
    else result.stopped = `the train stopped: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (execute) {
      delete state.running;
      writeState(root, state);
    }
    lock.release();
  }
  return result;
}

/** Run `gh` in `cwd`; any failure is a {@link MergeTrainApiError}. */
async function gh(args: string[], cwd: string): Promise<string> {
  const { ghQueryTimeoutMs } = await import('../release/github-pr.js');
  try {
    return execFileSync('gh', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: ghQueryTimeoutMs(),
    });
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    const said = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : String(err);
    // @sync-invariant none:input-shape a failed gh call is retried by the next train run; nothing is written
    throw new MergeTrainApiError(`gh ${args.slice(0, 2).join(' ')}: ${said}`);
  }
}

/** JSON lines (`gh api --jq '.x[] | {...}'`) as records. */
function jsonLines(out: string): Array<Record<string, unknown>> {
  return out
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * {@link MergeTrainGitHub} over `gh`, run in `cwd` so `gh` resolves the
 * repository from its remote.
 *
 * @param cwd - A work tree of the repository.
 * @returns The client.
 */
export function ghMergeTrainGitHub(cwd: string): MergeTrainGitHub {
  const repo = 'repos/{owner}/{repo}';
  return {
    async defaultBranch() {
      return (
        await gh(
          ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
          cwd,
        )
      ).trim();
    },
    async openPrs() {
      const fields = 'number,headRefOid,isDraft,body,labels,baseRefName';
      const out = await gh(
        ['pr', 'list', '--state', 'open', '--limit', '100', '--json', fields],
        cwd,
      );
      const rows = JSON.parse(out) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        number: Number(r.number),
        headSha: String(r.headRefOid ?? ''),
        isDraft: r.isDraft === true,
        body: typeof r.body === 'string' ? r.body : '',
        labels: Array.isArray(r.labels)
          ? r.labels.map((l) => String((l as { name?: unknown }).name ?? ''))
          : [],
        baseRef: String(r.baseRefName ?? ''),
      }));
    },
    async prMerged(prNumber) {
      const out = await gh(
        ['pr', 'view', String(prNumber), '--json', 'state', '--jq', '.state'],
        cwd,
      );
      return out.trim() === 'MERGED';
    },
    async runs(query) {
      const params = [
        query.sha ? `head_sha=${query.sha}` : '',
        query.branch ? `branch=${encodeURIComponent(query.branch)}` : '',
        query.event ? `event=${query.event}` : '',
        'per_page=30',
      ].filter(Boolean);
      const jq = '.workflow_runs[] | {id, event, status, head_sha, name, path, created_at}';
      const out = await gh(['api', `${repo}/actions/runs?${params.join('&')}`, '--jq', jq], cwd);
      return jsonLines(out).map((r) => ({
        id: Number(r.id),
        event: String(r.event ?? ''),
        status: String(r.status ?? ''),
        headSha: String(r.head_sha ?? ''),
        workflowName: String(r.name ?? ''),
        workflowPath: String(r.path ?? '').replace(/@.*$/, ''),
        createdAt: String(r.created_at ?? ''),
      }));
    },
    async latestJobs(runId) {
      const path = `${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`;
      const jq = '.jobs[] | {id, name, status, conclusion}';
      const out = await gh(['api', '--paginate', path, '--jq', jq], cwd);
      return jsonLines(out).map((j) => ({
        id: Number(j.id),
        name: String(j.name ?? ''),
        status: String(j.status ?? ''),
        conclusion: typeof j.conclusion === 'string' && j.conclusion !== '' ? j.conclusion : null,
      }));
    },
    async jobLog(jobId) {
      // Job logs carry ANSI colour; gh refuses to print them without the flag.
      return gh(['api', '--allow-escape-sequences', `${repo}/actions/jobs/${jobId}/logs`], cwd);
    },
    async fileAt(sha, path) {
      try {
        return await gh(
          [
            'api',
            '-H',
            'Accept: application/vnd.github.raw',
            `${repo}/contents/${path}?ref=${sha}`,
          ],
          cwd,
        );
      } catch (err) {
        if (err instanceof MergeTrainApiError && /\b404\b|Not Found/.test(err.message)) return null;
        throw err;
      }
    },
    async rerunFailed(runId) {
      await gh(['run', 'rerun', String(runId), '--failed'], cwd);
    },
    async merge(prNumber, headSha) {
      await gh(['pr', 'merge', String(prNumber), '--merge', '--match-head-commit', headSha], cwd);
      const out = await gh(
        ['pr', 'view', String(prNumber), '--json', 'mergeCommit', '--jq', '.mergeCommit.oid'],
        cwd,
      );
      const sha = out.trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    },
  };
}

/**
 * The default {@link MergeTrainDeps}: `gh` in the invoking work tree, the
 * required checks from `.cleo/project-context.json`, `checkPrReviews` and
 * `sweepMergedClosures` (the code behind `cleo review check` and
 * `cleo done --from-merge`).
 *
 * @param root - Project root.
 * @returns The deps.
 */
export async function defaultMergeTrainDeps(root: string): Promise<MergeTrainDeps> {
  const { resolveEvidenceExecutionRoot } = await import('./evidence.js');
  const { defaultMergeCloseDeps, sweepMergedClosures } = await import('./merge-close.js');
  return {
    github: ghMergeTrainGitHub(resolveEvidenceExecutionRoot(root)),
    requiredChecks: (r) => defaultMergeCloseDeps.requiredChecks(r),
    async reviewCheck(r, prNumber, lines) {
      const { checkPrReviews } = await import('./review-verdict.js');
      const checks = [];
      for (const line of lines)
        checks.push(...(await checkPrReviews(r, prNumber, [line.taskId], { acs: line.acs })));
      return checks;
    },
    closureDryRun: (r, prNumber) =>
      sweepMergedClosures(r, { force: true, prNumbers: [prNumber], dryRun: true }),
    sweep: (r, prNumber) => sweepMergedClosures(r, { force: true, prNumbers: [prNumber] }),
  };
}
