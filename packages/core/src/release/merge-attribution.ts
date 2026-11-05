/**
 * Merge attribution receipt (T14252, Council change 1, D11224): what a merged
 * PR's merge-commit CI shows about the PR itself, decided once per (PR,
 * resolved merge sha) from a test-level first-parent differential.
 *
 * ## The rule
 *
 * For each job that failed on the merge commit (latest attempt), the same job
 * on the merge's first parent is the baseline:
 *
 * - a test identity that fails on the merge and also on the parent is
 *   `disjoint`: the PR did not cause it;
 * - a test identity absent from the parent's failures is new at the merge:
 *   `pr-caused`, or `combination` when the PR head's own run passed that job.
 *   It is never excused;
 * - a job that failed in the same step as the parent's, with no test failing,
 *   is `disjoint`; a budget tripwire step the parent passed (bundle size,
 *   gate-39 module counts, `gen:sdk` drift) is `budget-crossed`, naming the
 *   crossing PR;
 * - a job that failed only on the flaky-quarantine budget is `main-health`
 *   (D11225): the budget counts open quarantine issues across the repo, so it
 *   is never attributed to the merging PR, whatever the parent's job
 *   concluded (with no parent observation it stays `unknown`);
 * - a job that tested nothing (runner cancel, worker crash, setup step) and a
 *   merge whose runs were only cancelled or skipped are `superseded`;
 * - no parent observation (no parent run, a skipped matrix, a cancelled or
 *   running parent job, an unreadable log, a parent seen at another point in
 *   time) is `unknown` with its reason, never a guess.
 *
 * Only failures that blocked the job count: after the CI test step's re-run of
 * failing files (T13145), only files that failed again; a quarantine-only
 * failure is the budget's, not a test's.
 *
 * ## Attempts (T14253)
 *
 * `commits/<sha>/check-runs` keeps only each job's latest attempt, so a rerun
 * would replace the evidence. Jobs are read per run attempt instead: each
 * merge job is judged at its first attempt (a same-day rerun that passed it
 * on the same sha counts; a failing, crashed or later rerun never does), and
 * the parent job at its latest attempt that had started when the merge job
 * did. The required aggregates (`CI`) only report the jobs they need and are
 * left out. The receipt pins the run id, attempt and completion time on both
 * sides, and once stored it is final.
 *
 * ## Shadow mode
 *
 * Every merged PR's receipt is appended to `.cleo/audit/merge-attribution.jsonl`
 * keyed by (PR, merge sha), whether or not the PR names a task (pre-ADR-099
 * PRs name none); a PR that names a task also gets a `merge_attribution`
 * audit row on it pointing at the receipt. It is listed beside the sweep's
 * outcome and changes no closure (D11224). The log readers are ci-evidence.ts's.
 *
 * @task T14252
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  MergeAttributionFailure,
  MergeAttributionReceipt,
  MergeAttributionRunPin,
  MergeAttributionVerdict,
} from '@cleocode/contracts';
import {
  blockingTestIds,
  type CommitCheck,
  defaultFetchChecks,
  defaultFetchJobLog,
  defaultFetchRunAttemptJobs,
  defaultFirstParentOf,
  failedStepOf,
  isQuarantineBudgetOnlyLog,
  isSetupStepFailureLog,
  untestedFailureCause,
} from './ci-evidence.js';

/** The rule's version, stored on every receipt. */
export const MERGE_ATTRIBUTION_RULE_VERSION = 2;

/** The audit action a receipt is stored under. */
export const MERGE_ATTRIBUTION_ACTION = 'merge_attribution';

/** Conclusions that fail a job. */
const FAILING = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

/** Conclusions of a job that did not run to a result. */
const NOT_RUN = new Set(['cancelled', 'skipped', 'neutral', 'stale']);

/** A parent observation further from the merge run than this is another point in time. */
const CONTEMPORANEOUS_MS = 24 * 60 * 60 * 1000;

/** Most serious first: a PR's verdict is its most serious job's. */
const RANK: readonly MergeAttributionVerdict[] = [
  'pr-caused',
  'combination',
  'unknown',
  'budget-crossed',
  'main-health',
  'disjoint',
  'superseded',
  'clean',
];

/** The cause name of a quarantine-budget-only failure. */
const QUARANTINE_BUDGET = 'flaky-quarantine-budget';

/**
 * Budget tripwire steps a PR crosses with its own change (D11225): the core
 * bundle size, the gate-39 CLI startup module counts and generated-SDK drift.
 */
const BUDGET_TRIPWIRE_STEP = /check-core-bundle-budget|check-cli-startup-graph|gen:sdk:check/;

/** The label of the one open fix task per budget main is over (T14254). */
export const MAIN_OVER_BUDGET_LABEL = 'main-over-budget';

/** Where every receipt is kept, keyed by (PR, merge sha). */
export const MERGE_ATTRIBUTION_FILE = '.cleo/audit/merge-attribution.jsonl';

/** What a receipt is computed from. */
export interface MergeAttributionInput {
  /** PR number. */
  readonly prNumber: number;
  /** The PR head. */
  readonly headSha: string | null;
  /** The merge commit. */
  readonly mergeSha: string;
  /** Its first parent, or `null` when unknown. */
  readonly parentSha: string | null;
  /** Jobs on the merge commit, every attempt (T14253). */
  readonly mergeChecks: readonly CommitCheck[];
  /** Jobs on the parent, every attempt, or `null` when they could not be read. */
  readonly parentChecks: readonly CommitCheck[] | null;
  /**
   * The required check names (the `CI` aggregate): left out, since they only
   * report the jobs they need.
   */
  readonly aggregates?: readonly string[];
  /** Checks on the PR head (its `pull_request` runs), when read. */
  readonly headChecks?: readonly CommitCheck[] | null;
  /** The plain-text log of one job, or `null` when unreadable. */
  readonly log: (check: CommitCheck) => Promise<string | null>;
}

/**
 * Every attempt of each GitHub Actions job on `sha` for `event`, oldest first.
 * The required aggregates are left out.
 */
function attemptsOf(
  checks: readonly CommitCheck[],
  sha: string | null,
  event: string,
  aggregates: readonly string[],
): Map<string, CommitCheck[]> {
  const jobs = new Map<string, CommitCheck[]>();
  for (const c of checks) {
    if (c.source !== 'check-run' || c.headSha !== sha) continue;
    if (c.event !== undefined && c.event !== event) continue;
    if (c.appSlug !== undefined && c.appSlug !== 'github-actions') continue;
    if (aggregates.includes(c.name)) continue;
    jobs.set(c.name, [...(jobs.get(c.name) ?? []), c]);
  }
  for (const list of jobs.values())
    list.sort((a, b) => (a.runAttempt ?? 1) - (b.runAttempt ?? 1) || a.id - b.id);
  return jobs;
}

/**
 * The merge job judged (T14253): its first attempt, the one that ran at merge
 * time, unless a rerun at the same point in time (within a day) passed it on
 * the same sha (the tree can pass). A failing or crashed rerun never replaces
 * it, and neither does a later one (main and its base moved on). An attempt
 * still running at that point is returned, so the receipt waits.
 */
function pinMergeJobs(attempts: Map<string, CommitCheck[]>): Map<string, CommitCheck> {
  const pinned = new Map<string, CommitCheck>();
  for (const [name, list] of attempts) {
    const first = list[0];
    if (first === undefined) continue;
    const then = list.filter(
      (a) =>
        !first.startedAt ||
        !a.startedAt ||
        Date.parse(a.startedAt) - Date.parse(first.startedAt) <= CONTEMPORANEOUS_MS,
    );
    pinned.set(
      name,
      then.find((a) => a.status !== 'completed') ??
        then.find((a) => a.conclusion === 'success') ??
        first,
    );
  }
  return pinned;
}

/**
 * The parent job as it stood when the merge job started (T14253): its latest
 * attempt started by then, never a later rerun. Without times, its latest.
 */
function parentAt(list: readonly CommitCheck[], at: string | undefined): CommitCheck | undefined {
  const started = at
    ? list.filter((a) => !a.startedAt || Date.parse(a.startedAt) <= Date.parse(at))
    : list;
  return started[started.length - 1];
}

/** The run attempts `jobs` came from, each with its last job's completion time. */
function pinsOf(jobs: readonly CommitCheck[]): MergeAttributionRunPin[] {
  const pins = new Map<string, MergeAttributionRunPin>();
  for (const j of jobs) {
    if (j.runId === undefined) continue;
    const attempt = j.runAttempt ?? 1;
    const key = `${j.runId}/${attempt}`;
    const completedAt = j.completedAt ?? null;
    const prev = pins.get(key);
    if (!prev) pins.set(key, { runId: j.runId, attempt, completedAt });
    else if (completedAt !== null && (prev.completedAt === null || completedAt > prev.completedAt))
      pins.set(key, { ...prev, completedAt });
  }
  return [...pins.values()].sort((a, b) => a.runId - b.runId || a.attempt - b.attempt);
}

/** What a failing job's log shows: the tests that decided it, or its non-test cause. */
interface JobRead {
  readonly tests: readonly string[];
  readonly cause: string | null;
  /** The job tested nothing of the change. */
  readonly untested: boolean;
}

function readJob(log: string): JobRead {
  if (isQuarantineBudgetOnlyLog(log, { unretriedTimeouts: true }))
    return { tests: [], cause: QUARANTINE_BUDGET, untested: false };
  const untested = untestedFailureCause(log);
  if (untested !== null) return { tests: [], cause: untested, untested: true };
  if (isSetupStepFailureLog(log)) return { tests: [], cause: 'setup', untested: true };
  const tests = blockingTestIds(log);
  const step = tests.length === 0 ? failedStepOf(log) : null;
  return { tests, cause: step === null ? null : `step:${step}`, untested: false };
}

/** The parent's job as the baseline, or why it is no observation. */
function observe(
  job: CommitCheck,
  parentJobs: Map<string, CommitCheck[]> | null,
): { readonly parent: CommitCheck } | { readonly missing: string } {
  if (parentJobs === null) return { missing: 'no parent run was observed' };
  const attempts = parentJobs.get(job.name);
  if (attempts === undefined || attempts.length === 0)
    return { missing: 'the parent has no such job (matrix skipped or not run)' };
  const parent = parentAt(attempts, job.startedAt);
  if (parent === undefined)
    return { missing: 'no parent attempt had started when the merge job ran' };
  if (parent.status !== 'completed') return { missing: 'the parent job has not completed' };
  if (NOT_RUN.has(parent.conclusion ?? ''))
    return { missing: `the parent job was ${parent.conclusion}` };
  if (job.startedAt && parent.startedAt) {
    const apart = Math.abs(Date.parse(job.startedAt) - Date.parse(parent.startedAt));
    if (apart > CONTEMPORANEOUS_MS)
      return {
        missing: `the parent ran at ${parent.startedAt}, the merge job at ${job.startedAt}: not the same point in time`,
      };
  }
  return { parent };
}

/** pr-caused, or combination when the PR head's own run passed this job. */
function newAtMerge(
  job: CommitCheck,
  headJobs: Map<string, CommitCheck> | null,
): 'pr-caused' | 'combination' {
  return headJobs?.get(job.name)?.conclusion === 'success' ? 'combination' : 'pr-caused';
}

async function judgeJob(
  job: CommitCheck,
  input: MergeAttributionInput,
  parentJobs: Map<string, CommitCheck[]> | null,
  headJobs: Map<string, CommitCheck> | null,
): Promise<MergeAttributionFailure> {
  const verdict = (
    v: MergeAttributionVerdict,
    reason: string,
    read?: JobRead,
  ): MergeAttributionFailure => ({
    job: job.name,
    tests: [...(read?.tests ?? [])],
    cause: read?.cause ?? null,
    verdict: v,
    reason,
  });
  const log = await input.log(job);
  if (log === null) return verdict('unknown', 'the merge job log is unreadable');
  const read = readJob(log);
  if (read.untested) return verdict('superseded', `the job tested nothing (${read.cause})`, read);
  const observed = observe(job, parentJobs);
  if ('missing' in observed) return verdict('unknown', observed.missing, read);
  // D11225: the quarantine budget is main's health, never the merging PR's.
  if (read.cause === QUARANTINE_BUDGET)
    return verdict('main-health', 'only the flaky-quarantine budget failed: main health', read);
  const { parent } = observed;
  if (parent.conclusion === 'success') {
    if (read.cause !== null && BUDGET_TRIPWIRE_STEP.test(read.cause))
      return verdict(
        'budget-crossed',
        `the parent job passed: ${read.cause} crossed here, by PR #${input.prNumber}`,
        read,
      );
    if (read.tests.length > 0 || read.cause !== null)
      return verdict(
        newAtMerge(job, headJobs),
        `the parent job passed: ${read.tests.length > 0 ? read.tests.join(', ') : read.cause} is new at the merge`,
        read,
      );
    return verdict(
      'unknown',
      'the parent job passed and the merge failure names no test or step',
      read,
    );
  }
  if (!FAILING.has(parent.conclusion ?? ''))
    return verdict('unknown', `the parent job concluded ${parent.conclusion}`, read);
  const parentLog = await input.log(parent);
  if (parentLog === null) return verdict('unknown', 'the parent job log is unreadable', read);
  const before = readJob(parentLog);
  if (read.tests.length > 0) {
    const fresh = read.tests.filter((t) => !before.tests.includes(t));
    return fresh.length === 0
      ? verdict(
          'disjoint',
          `all ${read.tests.length} failing test(s) also fail on the parent`,
          read,
        )
      : verdict(newAtMerge(job, headJobs), `new at the merge: ${fresh.join(', ')}`, read);
  }
  if (read.cause !== null && read.cause === before.cause)
    return verdict('disjoint', `the parent failed the same way (${read.cause})`, read);
  if (read.cause !== null && BUDGET_TRIPWIRE_STEP.test(read.cause))
    return verdict(
      'budget-crossed',
      `the parent failed differently: ${read.cause} crossed here, by PR #${input.prNumber}`,
      read,
    );
  if (read.cause !== null)
    return verdict(
      newAtMerge(job, headJobs),
      `the parent failed differently: ${read.cause} is new at the merge`,
      read,
    );
  return verdict('unknown', 'the merge failure names no test or step', read);
}

/**
 * Compute a merged PR's attribution receipt (T14252). Null while a merge job
 * is still running: the receipt is computed once the merge's CI is final.
 * Each merge job is judged at its first attempt and the parent at the attempt
 * that had started by then (T14253); the receipt pins both.
 *
 * @param input - The merge, its parent, their jobs and a log reader.
 * @returns The receipt, or `null` when the merge's CI has not finished.
 * @task T14252
 * @task T14253
 */
export async function computeMergeAttribution(
  input: MergeAttributionInput,
): Promise<MergeAttributionReceipt | null> {
  const aggregates = input.aggregates ?? [];
  const merge = pinMergeJobs(attemptsOf(input.mergeChecks, input.mergeSha, 'push', aggregates));
  if ([...merge.values()].some((j) => j.status !== 'completed')) return null;
  const parentJobs =
    input.parentChecks === null || input.parentSha === null
      ? null
      : attemptsOf(input.parentChecks, input.parentSha, 'push', aggregates);
  const failing = [...merge.values()]
    .filter((j) => FAILING.has(j.conclusion ?? ''))
    .sort((a, b) => a.name.localeCompare(b.name));
  const compared = failing.flatMap((j) => {
    const parent = parentAt(parentJobs?.get(j.name) ?? [], j.startedAt);
    return parent === undefined ? [] : [parent];
  });
  const base = {
    prNumber: input.prNumber,
    headSha: input.headSha,
    mergeSha: input.mergeSha,
    resolvedFrom: 'merge-commit' as const,
    parentSha: input.parentSha,
    mergeRuns: pinsOf([...merge.values()]),
    parentRuns: pinsOf(compared),
    ruleVersion: MERGE_ATTRIBUTION_RULE_VERSION,
  };
  if (failing.length === 0) {
    const ran = [...merge.values()].some((j) => j.conclusion === 'success');
    const cancelled = [...merge.values()].filter((j) => j.conclusion === 'cancelled').length;
    return ran && cancelled === 0
      ? {
          ...base,
          failures: [],
          verdict: 'clean',
          claim: 'holds-on-main',
          reason: 'every merge job passed',
        }
      : {
          ...base,
          failures: [],
          verdict: 'superseded',
          claim: 'green-at-head',
          reason:
            merge.size === 0
              ? 'no CI job ran on the merge commit'
              : ran
                ? `${cancelled} merge job(s) were cancelled; none failed`
                : 'the merge jobs were only cancelled or skipped',
        };
  }
  const headJobs = input.headChecks
    ? new Map(
        [...attemptsOf(input.headChecks, input.headSha, 'pull_request', aggregates)].flatMap(
          ([name, list]) => {
            const latest = list[list.length - 1];
            return latest === undefined ? [] : [[name, latest] as const];
          },
        ),
      )
    : null;
  const failures: MergeAttributionFailure[] = [];
  for (const job of failing) failures.push(await judgeJob(job, input, parentJobs, headJobs));
  const decisive = failures.reduce((a, b) =>
    RANK.indexOf(b.verdict) < RANK.indexOf(a.verdict) ? b : a,
  );
  const verdict = decisive.verdict;
  return {
    ...base,
    failures,
    verdict,
    claim:
      verdict === 'disjoint' || verdict === 'main-health'
        ? 'holds-on-main'
        : verdict === 'superseded'
          ? 'green-at-head'
          : 'none',
    reason: `${decisive.job}: ${decisive.reason}`,
  };
}

/** The GitHub and git readers a receipt is computed from (T14253). */
export interface MergeAttributionIo {
  /** Every attempt's push jobs on a commit. */
  fetchRunJobs: typeof defaultFetchRunAttemptJobs;
  /** The latest checks on the PR head. */
  fetchHeadChecks: typeof defaultFetchChecks;
  /** A commit's first parent. */
  firstParentOf: typeof defaultFirstParentOf;
  /** One job's plain-text log. */
  fetchJobLog: typeof defaultFetchJobLog;
  /** The main commits after the merge that contain its change, oldest first (T14255). */
  laterMainCommits: typeof defaultLaterMainCommits;
}

/** Run git; its trimmed stdout, or `null` when it fails. */
function git(args: readonly string[], cwd: string, input?: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      input,
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/** A patch's stable id (`git patch-id --stable`), or `null`. */
function patchIdOf(patch: string, cwd: string): string | null {
  return git(['patch-id', '--stable'], cwd, patch)?.split(/\s+/)[0] || null;
}

/**
 * The main commits after `mergeSha` that contain its change, oldest first
 * (T14255): its first-parent descendants on main, or, when the merge is not
 * on main (history rewritten), the main commit carrying the same patch (by
 * `git patch-id`) and its descendants. `null` when git cannot tell.
 *
 * @param mergeSha - The merge commit.
 * @param cwd - The repository work tree.
 * @returns The commits and how they contain the change, or `null`.
 * @task T14255
 */
export function defaultLaterMainCommits(
  mergeSha: string,
  cwd: string,
): { via: 'ancestry' | 'patch-id'; shas: string[] } | null {
  const main = git(['rev-parse', '--verify', '--quiet', 'origin/main'], cwd)
    ? 'origin/main'
    : 'main';
  const after = (sha: string): string[] =>
    (
      git(['rev-list', '--reverse', '--first-parent', '--ancestry-path', `${sha}..${main}`], cwd) ??
      ''
    )
      .split('\n')
      .filter((line) => line !== '');
  if (git(['merge-base', '--is-ancestor', mergeSha, main], cwd) !== null)
    return { via: 'ancestry', shas: after(mergeSha) };
  const diff = git(['diff', `${mergeSha}^1`, mergeSha], cwd);
  const since = git(['show', '-s', '--format=%cI', mergeSha], cwd);
  if (!diff || !since) return null;
  const id = patchIdOf(`${diff}\n`, cwd);
  const log = git(
    [
      'log',
      '--first-parent',
      '--diff-merges=first-parent',
      '--reverse',
      '-p',
      `--since=${since}`,
      main,
    ],
    cwd,
  );
  if (id === null || log === null) return null;
  const match = (git(['patch-id', '--stable'], cwd, `${log}\n`) ?? '')
    .split('\n')
    .map((line) => line.split(/\s+/))
    .find(([pid]) => pid === id)?.[1];
  return match
    ? { via: 'patch-id', shas: [match, ...after(match)] }
    : { via: 'patch-id', shas: [] };
}

const DEFAULT_IO: MergeAttributionIo = {
  fetchRunJobs: defaultFetchRunAttemptJobs,
  fetchHeadChecks: defaultFetchChecks,
  firstParentOf: defaultFirstParentOf,
  fetchJobLog: defaultFetchJobLog,
  laterMainCommits: defaultLaterMainCommits,
};

/** Later main commits read per resolution look; the next look continues after the last (T14255). */
export const MERGE_ATTRIBUTION_RESOLUTION_READS = 20;

/**
 * Resolve an `unknown` receipt (T14255): it holds on main once a later main
 * commit containing the change has a completed green run of every job the
 * receipt left undecided (each at its first attempt, as on the merge). It
 * reads runs that exist and never triggers one. A red or partial run moves
 * on to the next commit; a running one waits. The verdict stays `unknown`
 * and closes nothing by itself: the resolution is recorded beside it.
 *
 * @param receipt - The stored receipt.
 * @param root - The repository work tree.
 * @param required - The required check names (aggregates).
 * @param io - The GitHub and git readers.
 * @returns The receipt with its resolution or cursor, or the same receipt when nothing changed.
 * @task T14255
 */
export async function resolveUnknownReceipt(
  receipt: MergeAttributionReceipt,
  root: string,
  required: readonly string[],
  io: MergeAttributionIo = DEFAULT_IO,
): Promise<MergeAttributionReceipt> {
  if (receipt.verdict !== 'unknown' || receipt.resolution) return receipt;
  const covering = [
    ...new Set(receipt.failures.filter((f) => f.verdict === 'unknown').map((f) => f.job)),
  ];
  const later = covering.length === 0 ? null : io.laterMainCommits(receipt.mergeSha, root);
  if (later === null) return receipt;
  const from = receipt.unresolvedThrough ? later.shas.indexOf(receipt.unresolvedThrough) + 1 : 0;
  let through = receipt.unresolvedThrough;
  for (const sha of later.shas.slice(from, from + MERGE_ATTRIBUTION_RESOLUTION_READS)) {
    const fetched = await io.fetchRunJobs(sha, root);
    if (!fetched.ok) break;
    const jobs = pinMergeJobs(attemptsOf(fetched.checks, sha, 'push', required));
    const runs = covering.flatMap((name) => {
      const job = jobs.get(name);
      return job === undefined ? [] : [job];
    });
    if (runs.some((j) => j.status !== 'completed')) break;
    through = sha;
    if (runs.length === covering.length && runs.every((j) => j.conclusion === 'success'))
      return {
        ...receipt,
        resolution: { claim: 'holds-on-main', sha, via: later.via, runs: pinsOf(runs) },
      };
  }
  return through === receipt.unresolvedThrough
    ? receipt
    : { ...receipt, unresolvedThrough: through };
}

/** A merged PR as the merge sweep reads it. */
export interface AttributedPr {
  readonly number: number;
  readonly headRefOid: string | null;
  readonly mergeCommitSha: string | null;
}

/**
 * Every stored receipt (T14252), oldest first, from
 * {@link MERGE_ATTRIBUTION_FILE}; malformed lines are skipped.
 *
 * @param storeRoot - The CLEO store.
 * @returns The receipts.
 * @task T14252
 */
export function readMergeAttributions(storeRoot: string): MergeAttributionReceipt[] {
  let text: string;
  try {
    text = readFileSync(join(storeRoot, MERGE_ATTRIBUTION_FILE), 'utf-8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    const receipt = parseReceipt(line.trim() === '' ? null : line);
    return receipt === null ? [] : [receipt];
  });
}

/**
 * The merge sweep's attribution hook (T14252, SHADOW): the stored receipt of
 * (PR, merge sha), else one computed from GitHub and appended to
 * {@link MERGE_ATTRIBUTION_FILE} (not under `dryRun`). Every merged PR gets
 * one, task or not; a PR naming a task also gets a `merge_attribution` audit
 * row on it pointing at the receipt. Null when the merge's CI has not finished
 * or GitHub cannot be read.
 *
 * @param storeRoot - The CLEO store.
 * @param root - The repository work tree for `git` and `gh`.
 * @param pr - The merged PR.
 * @param taskId - The PR's first Closes/Refs task, or `null` when it names none.
 * @param required - The required check names (aggregates left out of the judgement).
 * @param dryRun - Compute, store nothing.
 * @param io - The GitHub and git readers (gh by default).
 * @returns The receipt, or `null`.
 * @task T14252
 */
export async function attributeMergedPr(
  storeRoot: string,
  root: string,
  pr: AttributedPr,
  taskId: string | null,
  required: readonly string[],
  dryRun: boolean,
  io: MergeAttributionIo = DEFAULT_IO,
): Promise<MergeAttributionReceipt | null> {
  const mergeSha = pr.mergeCommitSha;
  if (!mergeSha) return null;
  // A stored verdict is final: a later rerun on either commit never changes it
  // (T14253). An unknown one may only gain its resolution (T14255); the
  // newest line of a (PR, merge sha) wins.
  const stored = readMergeAttributions(storeRoot)
    .reverse()
    .find(
      (r) =>
        r.prNumber === pr.number &&
        r.mergeSha === mergeSha &&
        r.ruleVersion === MERGE_ATTRIBUTION_RULE_VERSION,
    );
  if (stored !== undefined) {
    if (dryRun) return stored;
    const resolved = await resolveUnknownReceipt(stored, root, required, io);
    if (resolved !== stored) appendReceiptLine(storeRoot, resolved);
    return resolved;
  }
  const merge = await io.fetchRunJobs(mergeSha, root);
  if (!merge.ok) return null;
  const parentSha = io.firstParentOf(mergeSha, root);
  const parent = parentSha === null ? null : await io.fetchRunJobs(parentSha, root);
  const head = pr.headRefOid ? await io.fetchHeadChecks(pr.headRefOid, root) : null;
  const receipt = await computeMergeAttribution({
    prNumber: pr.number,
    headSha: pr.headRefOid,
    mergeSha,
    parentSha,
    mergeChecks: merge.checks,
    parentChecks: parent?.ok ? parent.checks : null,
    headChecks: head?.ok ? head.checks : null,
    aggregates: required,
    log: (check) => io.fetchJobLog(check.id, root),
  });
  if (receipt === null || dryRun) return receipt;
  const filed = await fileMainBudgetTasks(storeRoot, receipt, taskId);
  const final: MergeAttributionReceipt = {
    ...(await resolveUnknownReceipt(receipt, root, required, io)),
    ...(filed.tasks.length > 0 ? { budgetTasks: filed.tasks } : {}),
    ...(filed.skipped ? { budgetTaskSkipped: filed.skipped } : {}),
  };
  await storeMergeAttribution(storeRoot, final, taskId);
  return final;
}

/**
 * File the fix task for each budget a merge crossed (T14254, D11225): one open
 * `main-over-budget` task per budget (bundle size, gate-39 module counts,
 * `gen:sdk` drift), under the epic of the crossing PR's task, naming the PR.
 * A budget that already has an open task gets none: that task is returned.
 * The PR's own task is untouched and closes as it would.
 *
 * @param storeRoot - The CLEO store.
 * @param receipt - The computed receipt.
 * @param taskId - The PR's first Closes/Refs task, or `null`.
 * @returns The fix tasks, or why none could be filed.
 * @task T14254
 */
export async function fileMainBudgetTasks(
  storeRoot: string,
  receipt: MergeAttributionReceipt,
  taskId: string | null,
): Promise<{ tasks: string[]; skipped?: string }> {
  const budgets = [
    ...new Set(
      receipt.failures.flatMap((f) => {
        const budget =
          f.verdict === 'budget-crossed' ? BUDGET_TRIPWIRE_STEP.exec(f.cause ?? '') : null;
        return budget === null ? [] : [budget[0]];
      }),
    ),
  ];
  if (budgets.length === 0) return { tasks: [] };
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const accessor = await getTaskAccessor(storeRoot);
  const open = (
    await accessor.queryTasks({
      label: MAIN_OVER_BUDGET_LABEL,
      excludeStatus: ['done', 'cancelled', 'archived'],
    })
  ).tasks;
  const tasks: string[] = [];
  const unfiled: string[] = [];
  for (const budget of budgets) {
    const title = `Main over budget: ${budget}`;
    const existing = open.find((t) => t.title.startsWith(title));
    if (existing) tasks.push(existing.id);
    else unfiled.push(budget);
  }
  if (unfiled.length === 0) return { tasks };
  const parentId =
    taskId === null ? null : ((await accessor.loadSingleTask(taskId))?.parentId ?? null);
  if (!parentId)
    return {
      tasks,
      skipped: `${unfiled.join(', ')}: PR #${receipt.prNumber} names no task under an epic to file the fix task in`,
    };
  const { addTask } = await import('../tasks/add.js');
  for (const budget of unfiled) {
    const added = await addTask(
      {
        title: `Main over budget: ${budget} (crossed by PR #${receipt.prNumber})`,
        description: `PR #${receipt.prNumber}'s merge ${receipt.mergeSha} crossed ${budget}, which passed on its first parent ${receipt.parentSha ?? '(unknown)'} (merge attribution receipt, T14254, D11225).`,
        acceptance: [`${budget} passes on main again`],
        parentId,
        labels: [MAIN_OVER_BUDGET_LABEL],
        // One open task per budget is the identity (checked above by label and title).
        forceDuplicate: true,
      },
      storeRoot,
      accessor,
    );
    tasks.push(added.task.id);
  }
  return { tasks };
}

/**
 * Append a receipt to {@link MERGE_ATTRIBUTION_FILE} and, when the PR names a
 * task, point a `merge_attribution` audit row on it at the receipt (T14252).
 *
 * @param storeRoot - The CLEO store.
 * @param receipt - The computed receipt.
 * @param taskId - The PR's first Closes/Refs task, or `null`.
 * @task T14252
 */
export async function storeMergeAttribution(
  storeRoot: string,
  receipt: MergeAttributionReceipt,
  taskId: string | null,
): Promise<void> {
  appendReceiptLine(storeRoot, receipt);
  if (taskId === null) return;
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  await (await getTaskAccessor(storeRoot)).appendLog({
    action: MERGE_ATTRIBUTION_ACTION,
    taskId,
    actor: 'merge-sweep',
    details: {
      prNumber: receipt.prNumber,
      mergeSha: receipt.mergeSha,
      verdict: receipt.verdict,
      receipt: MERGE_ATTRIBUTION_FILE,
    },
  });
}

/** Append one receipt line to {@link MERGE_ATTRIBUTION_FILE}. */
function appendReceiptLine(storeRoot: string, receipt: MergeAttributionReceipt): void {
  const file = join(storeRoot, MERGE_ATTRIBUTION_FILE);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(receipt)}\n`, 'utf-8');
}

/** Whether a parsed jsonl line is a stored receipt. */
function isReceipt(value: unknown): value is MergeAttributionReceipt {
  return (
    typeof value === 'object' &&
    value !== null &&
    'prNumber' in value &&
    typeof value.prNumber === 'number' &&
    'mergeSha' in value &&
    typeof value.mergeSha === 'string' &&
    'verdict' in value &&
    typeof value.verdict === 'string' &&
    'ruleVersion' in value &&
    typeof value.ruleVersion === 'number' &&
    'failures' in value &&
    Array.isArray(value.failures)
  );
}

/** A stored receipt from one jsonl line, or `null`. */
function parseReceipt(detailsJson: string | null): MergeAttributionReceipt | null {
  if (detailsJson === null) return null;
  try {
    const value: unknown = JSON.parse(detailsJson);
    return isReceipt(value) ? value : null;
  } catch {
    return null;
  }
}
