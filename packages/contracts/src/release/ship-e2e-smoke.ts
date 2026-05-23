/**
 * Ship E2E Smoke contracts — types for the `cleo release ship-e2e-smoke`
 * one-shot walker that exercises the full release lifecycle end-to-end.
 *
 * The smoke runs `plan` → `open` → wait-for-PR-merge → wait-for-tag →
 * verify-npm-published. Each step records its status, duration, and any
 * side-effect identifier (PR number, tag SHA, npm version) for downstream
 * inspection. The aggregate envelope reports the final lifecycle state
 * reached so failures can be resumed.
 *
 * Dry-run is the default; `--execute` flips the runner to perform real
 * mutations. Both modes return the same envelope shape so consumers can
 * diff a dry-run preview against a real run.
 *
 * @task T10103
 * @epic E-CLEO-RELEASE-VERBS
 * @saga T10099
 */

/**
 * The discrete steps the smoke walker executes, in order. The aggregate
 * envelope records one entry per step with status + duration.
 */
export type ShipE2eSmokeStepName =
  | 'plan'
  | 'open'
  | 'wait-for-pr'
  | 'wait-for-tag'
  | 'verify-npm-published';

/** Outcome of a single smoke step. */
export type ShipE2eSmokeStepStatus =
  /** Step completed successfully (or, in dry-run, would have run). */
  | 'ok'
  /** Step was skipped — e.g. dry-run mode shortcuts post-plan. */
  | 'skipped'
  /** Step failed; the smoke envelope's success flag will be false. */
  | 'failed';

/** Per-step result attached to the smoke envelope. */
export interface ShipE2eSmokeStep {
  /** The step name. */
  name: ShipE2eSmokeStepName;
  /** Outcome. */
  status: ShipE2eSmokeStepStatus;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /**
   * Optional human-readable detail string captured at step completion
   * (e.g. "plan written to .cleo/release/v2026.5.104.plan.json",
   * "PR #524 merged", "tag v2026.5.104 found", "npm @cleocode/cleo@…
   * published").
   */
  detail?: string;
  /**
   * Optional error message when `status === 'failed'`. Single-line so
   * the envelope stays compact for CLI consumers.
   */
  error?: string;
}

/**
 * Final lifecycle state the smoke reached. Mirrors the `releases.status`
 * column values plus a synthetic `npm-published` terminal state captured
 * by the verify step.
 */
export type ShipE2eSmokeFinalState =
  | 'not-started'
  | 'planned'
  | 'pr-opened'
  | 'pr-merged'
  | 'tag-pushed'
  | 'npm-published';

/** Parameters accepted by the smoke walker. */
export interface ShipE2eSmokeParams {
  /** Candidate release version (e.g. "v2026.6.0" or "2026.6.0"). */
  version: string;
  /** Epic task ID that scopes the release (forwarded to `release plan`). */
  epicId: string;
  /**
   * When false (default), no side effects — every step reports what it
   * WOULD do. When true, each step performs its real mutation.
   */
  execute: boolean;
  /**
   * Total wall-clock budget across all polling waits, in milliseconds.
   * Default 30 minutes when omitted. Per-step waits MUST respect this
   * shared budget so a stuck PR doesn't hang the whole smoke.
   */
  totalTimeoutMs?: number;
  /**
   * Poll interval for wait-* steps, in milliseconds. Default 5_000.
   * Lowered in tests via DI to keep the suite fast.
   */
  pollIntervalMs?: number;
}

/** Top-level envelope returned by the smoke walker. */
export interface ShipE2eSmokeResult {
  /** True when every step completed (or was intentionally skipped). */
  success: boolean;
  /** Echo of the version under smoke. */
  version: string;
  /** True when --execute was passed; false for dry-run preview. */
  executed: boolean;
  /** Ordered step log. */
  steps: ShipE2eSmokeStep[];
  /** Lifecycle state at smoke termination. */
  finalState: ShipE2eSmokeFinalState;
  /** Total wall-clock duration across all steps, in milliseconds. */
  totalDurationMs: number;
}
