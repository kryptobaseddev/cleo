/**
 * Merge closes tasks (T14101, owner decision D11209): the contract of the
 * post-merge sweep that records a merged PR's evidence on the tasks its body
 * names and completes them, with no agent step.
 *
 * A PR body names tasks one per line:
 *
 * - `Closes: T#### AC1,AC2` binds those criteria and completes the task once
 *   the criteria every merged PR bound cover all of the task's criteria.
 * - `Refs: T#### AC1` binds those criteria from a PR that delivers part of a
 *   task, and leaves it open.
 *
 * @task T14101
 */

/** One `Closes:` / `Refs:` line of a PR body. */
export interface MergeDirective {
  /** `closes` completes the task; `refs` only binds criteria. */
  kind: 'closes' | 'refs';
  /** The task the line names. */
  taskId: string;
  /** Criterion aliases (`AC1`, …) the PR delivers, in the order written. */
  acs: string[];
}

/**
 * What a merged PR says, judged without a task store (the CI job's receipt):
 * its lines, whether its required checks were green on its exact head, and
 * why it closes nothing when it does not.
 */
export interface MergeReceipt {
  /** PR number. */
  prNumber: number;
  /** The merge commit, or null when GitHub reports none. */
  mergeSha: string | null;
  /** The PR's final head. */
  headSha: string | null;
  /** The parsed lines. */
  directives: MergeDirective[];
  /** Malformed `Closes:` / `Refs:` lines, each with the fix. */
  errors: string[];
  /** Whether every required check passed on the PR's head. */
  ciGreen: boolean;
  /** Why CI does not count as green, when it does not. */
  ciReason?: string;
  /** Why the PR closes nothing at all, when it closes nothing. */
  closesNothing?: string;
}

/** What the sweep did, or would do under `dryRun`, for one task of one PR. */
export interface MergeTaskOutcome {
  /** The task. */
  taskId: string;
  /**
   * `closed`: evidence recorded and the task completed. `bound`: a `Refs:`
   * line's criteria recorded, the task left open. `already`: an earlier sweep
   * handled this PR for the task, or the task was already done. `refused`:
   * nothing recorded; `reason` says why.
   */
  action: 'closed' | 'bound' | 'already' | 'refused';
  /** The criteria the line named. */
  acs: string[];
  /** Why, for `refused` and `already`; for a dry run of an open PR, what would happen. */
  reason?: string;
}

/** The sweep's result for one merged PR. */
export interface MergePrOutcome {
  /** PR number. */
  prNumber: number;
  /** Its merge commit. */
  mergeSha: string | null;
  /** One entry per task the PR names. */
  outcomes: MergeTaskOutcome[];
  /** Why nothing was attempted for this PR (no lines, malformed lines, CI not green). */
  closesNothing?: string;
}

/** Options of `sweepMergedClosures`. */
export interface MergeSweepOptions {
  /** Report what would be recorded; write, complete and comment nothing. */
  dryRun?: boolean;
  /** Ignore the throttle (`cleo release` always passes it). */
  force?: boolean;
  /** Only PRs merged at or after this ISO time (default: the last sweep's high-water mark). */
  since?: string;
  /** Only these PRs (implies `force`). */
  prNumbers?: number[];
}

/** What the sweep did with open `macos-regression` issues (T14104). */
export interface MacosRegressionSync {
  /** Tasks created for newly seen issues (under `dryRun`: issue URLs that would get one). */
  created: string[];
  /** Issue URLs closed because their task is done. */
  closedIssues: string[];
  /** Why the issues were not read. */
  skippedReason?: string;
}

/** The newest release's provenance reconcile, run by the sweep (T14102). */
export interface MergeSweepReconcile {
  /** The release version, or null when there is none. */
  version: string | null;
  /** What happened. */
  action: 'reconciled' | 'already' | 'unpublished' | 'none' | 'failed';
  /** Why, when it did not reconcile. */
  reason?: string;
}

/** The other upkeep one sweep runs after the closures, inside the same claim. */
export interface MergeSweepHooks {
  /** Task ids flagged `docs-update` for docs a merged change left stale (T14111). */
  docsRot?: string[];
  /** `macos-regression` issues turned into tasks, and closed when their task is done (T14104). */
  macosRegression?: MacosRegressionSync;
  /** The newest release's reconcile (T14102); skipped under `dryRun`. */
  reconcile?: MergeSweepReconcile;
}

/** Result of `sweepMergedClosures` / `cleo done --from-merge`. */
export interface MergeSweepResult {
  /** False when the sweep did not run: throttled, `gh` unavailable, or offline. */
  swept: boolean;
  /** Why it did not run. */
  skippedReason?: string;
  /** Whether this was a dry run. */
  dryRun: boolean;
  /** Each merged PR considered, oldest merge first. */
  prs: MergePrOutcome[];
  /** Tasks completed (under `dryRun`: that would be). */
  closed: string[];
  /** Tasks with criteria bound by `Refs:`, left open. */
  bound: string[];
  /** Tasks nothing was recorded for, with the reason. */
  refused: Array<{ taskId: string; prNumber: number; reason: string }>;
  /** The upkeep run in the same sweep, when any ran. */
  hooks?: MergeSweepHooks;
}
