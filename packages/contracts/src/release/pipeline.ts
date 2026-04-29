/**
 * Release pipeline contracts — canonical 4-step release flow types.
 *
 * Defines the type surface shared by `@cleocode/core/release/pipeline` and
 * `@cleocode/cleo/cli/commands/release` for the canonical pipeline:
 *
 *   start → verify → publish → reconcile
 *
 * All types are project-agnostic. Concrete commands and version-scheme rules
 * resolve at runtime from `.cleo/project-context.json`.
 *
 * @task T1597
 * @adr ADR-063
 */

/**
 * Supported version schemes. Mirrors `version.scheme` in
 * `.cleo/project-context.json`. `auto` defers to per-project detection
 * (CalVer for projects whose current version matches `YYYY.M.P`, SemVer
 * otherwise).
 */
export type ReleaseVersionScheme = 'calver' | 'semver' | 'sha' | 'auto';

/**
 * Handle returned by {@link releaseStart} and threaded through the rest of
 * the pipeline. Persisted under `.cleo/release/handle.json` so that
 * `cleo release verify` / `publish` / `reconcile` can resume without
 * re-passing `--version` on every step.
 */
export interface ReleaseHandle {
  /** Resolved version string (e.g. "2026.4.155" or "1.4.2"). */
  version: string;
  /** Resolved release tag (e.g. "v2026.4.155"). */
  tag: string;
  /** Active version scheme used for validation. */
  scheme: ReleaseVersionScheme;
  /** Branch the release is being cut from (resolved from git). */
  branch: string;
  /** ISO-8601 timestamp of `releaseStart`. */
  startedAt: string;
  /** Absolute project root the pipeline is operating against. */
  projectRoot: string;
  /** Optional epic ID this release ships (for reconcile auto-completion). */
  epicId?: string;
}

/** Per-gate verification status. */
export interface ReleaseGateStatus {
  /** Canonical gate name (test/lint/typecheck/audit/security-scan). */
  gate: string;
  /** Whether the gate passed. */
  passed: boolean;
  /** Tool that was invoked (resolved via project-context). */
  tool?: string;
  /** Human-readable reason on failure. */
  reason?: string;
}

/** Result of {@link releaseVerify}. */
export interface VerifyResult {
  /** All gates passed AND all child tasks have green gates. */
  passed: boolean;
  /** Per-gate results. */
  gates: ReleaseGateStatus[];
  /** Tasks discovered as children of the release epic with ungreen gates. */
  ungreenChildren: Array<{
    taskId: string;
    missingGates: string[];
  }>;
  /** Total tasks examined under the release epic (0 if no epic). */
  childrenExamined: number;
}

/** Result of {@link releasePublish}. */
export interface PublishResult {
  /** Whether publish succeeded. */
  success: boolean;
  /** Command that was executed (after project-context resolution). */
  command: string;
  /** Combined stdout/stderr (truncated). */
  output: string;
  /** Artifact identifier on the registry, when extractable (e.g. npm tag). */
  artifact?: string;
  /** Whether the publish was a dry-run (no remote mutation). */
  dryRun: boolean;
}

/** Result of {@link releaseReconcile}. */
export interface ReleaseReconcileResult {
  /** Whether reconcile completed without errors. */
  success: boolean;
  /** The tag reconciled. */
  tag: string;
  /** Tasks auto-completed by archive-reason invariant. */
  reconciledTasks: string[];
  /** Tasks that need operator follow-up. */
  unreconciledTasks: string[];
  /** Errors raised by any invariant. */
  errors: string[];
}
