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
 *   is `disjoint`; a job that failed only on the flaky-quarantine budget while
 *   the parent passed is `budget-crossed`;
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
 * ## Shadow mode
 *
 * The receipt is recorded beside the merge sweep's current outcome (a
 * `merge_attribution` audit row and the PR's `attribution` entry) and changes
 * no closure (D11224). The log readers are ci-evidence.ts's.
 *
 * @task T14252
 */

import type {
  MergeAttributionFailure,
  MergeAttributionReceipt,
  MergeAttributionVerdict,
} from '@cleocode/contracts';
import {
  blockingTestIds,
  type CommitCheck,
  defaultFetchChecks,
  defaultFetchJobLog,
  defaultFirstParentOf,
  failedStepOf,
  isQuarantineBudgetOnlyLog,
  isSetupStepFailureLog,
  untestedFailureCause,
} from './ci-evidence.js';

/** The rule's version, stored on every receipt. */
export const MERGE_ATTRIBUTION_RULE_VERSION = 1;

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
  'disjoint',
  'superseded',
  'clean',
];

/** The cause name of a quarantine-budget-only failure. */
const QUARANTINE_BUDGET = 'flaky-quarantine-budget';

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
  /** Checks on the merge commit. */
  readonly mergeChecks: readonly CommitCheck[];
  /** Checks on the parent, or `null` when they could not be read. */
  readonly parentChecks: readonly CommitCheck[] | null;
  /** Checks on the PR head (its `pull_request` runs), when read. */
  readonly headChecks?: readonly CommitCheck[] | null;
  /** The plain-text log of one job, or `null` when unreadable. */
  readonly log: (check: CommitCheck) => Promise<string | null>;
}

/** The latest attempt of each GitHub Actions job on `sha` for `event`. */
function jobsOf(
  checks: readonly CommitCheck[],
  sha: string | null,
  event: string,
): Map<string, CommitCheck> {
  const jobs = new Map<string, CommitCheck>();
  for (const c of checks) {
    if (c.source !== 'check-run' || c.headSha !== sha) continue;
    if (c.event !== undefined && c.event !== event) continue;
    if (c.appSlug !== undefined && c.appSlug !== 'github-actions') continue;
    const prev = jobs.get(c.name);
    if (!prev || c.id > prev.id) jobs.set(c.name, c);
  }
  return jobs;
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
  parentJobs: Map<string, CommitCheck> | null,
): { readonly parent: CommitCheck } | { readonly missing: string } {
  if (parentJobs === null) return { missing: 'no parent run was observed' };
  const parent = parentJobs.get(job.name);
  if (parent === undefined)
    return { missing: 'the parent has no such job (matrix skipped or not run)' };
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
  parentJobs: Map<string, CommitCheck> | null,
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
  const { parent } = observed;
  if (parent.conclusion === 'success') {
    if (read.cause === QUARANTINE_BUDGET)
      return verdict('budget-crossed', 'the parent job passed under the quarantine budget', read);
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
  if (read.cause === QUARANTINE_BUDGET)
    return verdict(
      'budget-crossed',
      'the parent failed differently, under the quarantine budget',
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
 *
 * @param input - The merge, its parent, their checks and a log reader.
 * @returns The receipt, or `null` when the merge's CI has not finished.
 * @task T14252
 */
export async function computeMergeAttribution(
  input: MergeAttributionInput,
): Promise<MergeAttributionReceipt | null> {
  const merge = jobsOf(input.mergeChecks, input.mergeSha, 'push');
  if ([...merge.values()].some((j) => j.status !== 'completed')) return null;
  const base = {
    prNumber: input.prNumber,
    headSha: input.headSha,
    mergeSha: input.mergeSha,
    resolvedFrom: 'merge-commit' as const,
    parentSha: input.parentSha,
    ruleVersion: MERGE_ATTRIBUTION_RULE_VERSION,
  };
  const failing = [...merge.values()].filter((j) => FAILING.has(j.conclusion ?? ''));
  if (failing.length === 0) {
    const ran = [...merge.values()].some((j) => j.conclusion === 'success');
    return ran
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
              : 'the merge jobs were only cancelled or skipped',
        };
  }
  const parentJobs =
    input.parentChecks === null || input.parentSha === null
      ? null
      : jobsOf(input.parentChecks, input.parentSha, 'push');
  const headJobs = input.headChecks
    ? jobsOf(input.headChecks, input.headSha, 'pull_request')
    : null;
  const failures: MergeAttributionFailure[] = [];
  for (const job of failing.sort((a, b) => a.name.localeCompare(b.name)))
    failures.push(await judgeJob(job, input, parentJobs, headJobs));
  const decisive = failures.reduce((a, b) =>
    RANK.indexOf(b.verdict) < RANK.indexOf(a.verdict) ? b : a,
  );
  const verdict = decisive.verdict;
  return {
    ...base,
    failures,
    verdict,
    claim:
      verdict === 'disjoint'
        ? 'holds-on-main'
        : verdict === 'superseded'
          ? 'green-at-head'
          : 'none',
    reason: `${decisive.job}: ${decisive.reason}`,
  };
}

/** A merged PR as the merge sweep reads it. */
export interface AttributedPr {
  readonly number: number;
  readonly headRefOid: string | null;
  readonly mergeCommitSha: string | null;
}

/**
 * The merge sweep's attribution hook (T14252, SHADOW): the stored receipt of
 * (PR, merge sha), else one computed from GitHub and stored as a
 * `merge_attribution` audit row on `taskId` (not under `dryRun`). Null when
 * the merge's CI has not finished or GitHub cannot be read.
 *
 * @param storeRoot - The CLEO store.
 * @param root - The repository work tree for `git` and `gh`.
 * @param pr - The merged PR.
 * @param taskId - The task the receipt is filed on (the PR's first Closes/Refs task).
 * @param dryRun - Compute, store nothing.
 * @returns The receipt, or `null`.
 * @task T14252
 */
export async function attributeMergedPr(
  storeRoot: string,
  root: string,
  pr: AttributedPr,
  taskId: string,
  dryRun: boolean,
): Promise<MergeAttributionReceipt | null> {
  const mergeSha = pr.mergeCommitSha;
  if (!mergeSha) return null;
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const accessor = await getTaskAccessor(storeRoot);
  const stored = await accessor.queryAuditLog({
    taskIds: [taskId],
    actions: [MERGE_ATTRIBUTION_ACTION],
  });
  for (const row of stored) {
    const receipt = parseReceipt(row.detailsJson);
    if (
      receipt?.prNumber === pr.number &&
      receipt.mergeSha === mergeSha &&
      receipt.ruleVersion === MERGE_ATTRIBUTION_RULE_VERSION
    )
      return receipt;
  }
  const merge = await defaultFetchChecks(mergeSha, root);
  if (!merge.ok) return null;
  const parentSha = defaultFirstParentOf(mergeSha, root);
  const parent = parentSha === null ? null : await defaultFetchChecks(parentSha, root);
  const head = pr.headRefOid ? await defaultFetchChecks(pr.headRefOid, root) : null;
  const receipt = await computeMergeAttribution({
    prNumber: pr.number,
    headSha: pr.headRefOid,
    mergeSha,
    parentSha,
    mergeChecks: merge.checks,
    parentChecks: parent?.ok ? parent.checks : null,
    headChecks: head?.ok ? head.checks : null,
    log: (check) => defaultFetchJobLog(check.id, root),
  });
  if (receipt !== null && !dryRun)
    await accessor.appendLog({
      action: MERGE_ATTRIBUTION_ACTION,
      taskId,
      actor: 'merge-sweep',
      details: receipt,
    });
  return receipt;
}

/** Whether a parsed audit detail is a stored receipt. */
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

/** A stored receipt from its audit row's details, or `null`. */
function parseReceipt(detailsJson: string | null): MergeAttributionReceipt | null {
  if (detailsJson === null) return null;
  try {
    const value: unknown = JSON.parse(detailsJson);
    return isReceipt(value) ? value : null;
  } catch {
    return null;
  }
}
