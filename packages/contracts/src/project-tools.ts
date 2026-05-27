/**
 * ProjectTools contracts — input/output types for scaffold-project,
 * doctor-project, and scaffold-global SDK tools.
 *
 * These are pure-functional, harness-agnostic operation contracts. Each
 * tool function accepts an options bag and returns a typed result envelope —
 * no I/O is performed inside the contract shapes themselves.
 *
 * Taxonomy: Category B SDK Tool (ADR-064).
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CORE-TOOLS T9835 (T9835b)
 */

import type { CheckResult, ScaffoldResult } from './scaffold-diagnostics.js';

// ── scaffold-project ──────────────────────────────────────────────────

/**
 * Options for {@link ScaffoldProjectResult} — controls idempotency and override.
 */
export interface ScaffoldProjectOptions {
  /**
   * Absolute path to the project root (directory that contains `.cleo/`).
   * Defaults to `process.cwd()` if omitted.
   */
  projectRoot?: string;
  /**
   * When `true`, re-writes files even if they already exist (mirrors the
   * `--force` flag in `cleo init`).
   *
   * @default false
   */
  force?: boolean;
}

/**
 * Result of a {@link scaffoldProject} call.
 *
 * Aggregates the individual {@link ScaffoldResult} returned by each
 * `ensure*` step so callers can inspect per-step outcomes without re-running
 * discovery.
 */
export interface ScaffoldProjectResult {
  /** Absolute project root that was operated on. */
  projectRoot: string;
  /** Per-step results, in canonical execution order. */
  steps: ScaffoldProjectStep[];
  /** Whether all steps completed without an exception (individual steps may still report `repaired`). */
  success: boolean;
  /** Aggregated human-readable summary (e.g. "3 created, 8 skipped"). */
  summary: string;
}

/**
 * One step within a {@link ScaffoldProjectResult}.
 */
export interface ScaffoldProjectStep {
  /** Stable step name used in diagnostics (e.g. `"cleo-structure"`, `"config"`). */
  name: string;
  /** Outcome of the corresponding `ensure*` call. Absent when the step was skipped due to an error. */
  result?: ScaffoldResult;
  /** Non-null when the step threw an exception (logged but not fatal). */
  error?: string;
}

// ── doctor-project ────────────────────────────────────────────────────

/**
 * Options for {@link doctorProject}.
 */
export interface DoctorProjectOptions {
  /**
   * Absolute path to the project root.
   * Defaults to `process.cwd()` if omitted.
   */
  projectRoot?: string;
  /**
   * Override the global cleo home used for CLI-level checks.
   * Defaults to `getCleoHome()` if omitted.
   */
  cleoHome?: string;
}

/**
 * Result of a {@link doctorProject} call — aggregates all synchronous
 * diagnostic checks into a flat list.
 */
export interface DoctorProjectResult {
  /** Absolute project root that was inspected. */
  projectRoot: string;
  /** Flat list of all check outcomes, global + project-scoped. */
  checks: CheckResult[];
  /**
   * Rolled-up exit-code style status:
   * - `0`  — all checks passed
   * - `50` — at least one warning, no failures
   * - `52` — at least one failure
   */
  exitCode: 0 | 50 | 52;
}

// ── scaffold-global ───────────────────────────────────────────────────

/**
 * Result of a {@link scaffoldGlobal} call — mirrors the return shape of
 * the underlying `ensureGlobalScaffold()` call with added provenance.
 */
export interface ScaffoldGlobalResult {
  /** Outcome of `ensureGlobalHome()`. */
  home: ScaffoldResult;
  /** Outcome of `ensureGlobalTemplates()`. */
  templates: ScaffoldResult;
  /** Outcome of `ensureCleoOsHub()`. */
  cleoosHub: ScaffoldResult;
  /** Whether all three steps completed without throwing. */
  success: boolean;
}
