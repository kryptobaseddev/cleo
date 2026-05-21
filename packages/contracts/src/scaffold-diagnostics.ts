/**
 * Scaffold + diagnostic result contracts.
 *
 * Canonical home for the result shapes produced by CLEO's directory/file
 * scaffolding utilities (`ensure*`) and read-only health-check utilities
 * (`check*`). Promoted to `@cleocode/contracts` in Phase 0a of the
 * SG-ARCH-SOLID Saga to eliminate duplicate definitions that previously
 * lived in `packages/core/src/scaffold.ts`, `injection.ts`, `hooks.ts`,
 * `schema-management.ts`, and `validation/doctor/checks.ts`.
 *
 * Consolidated types:
 *   - {@link ScaffoldResult} — was defined 3× in core (scaffold/injection/hooks)
 *   - {@link CheckStatus}   — was defined 2× in core (scaffold/doctor checks)
 *   - {@link CheckResult}   — was defined 2× in core (scaffold/doctor checks)
 *   - {@link HookCheckResult} — single canonical definition (no prior duplication;
 *     promoted here to keep all scaffold-diagnostic shapes co-located)
 *
 * NOT consolidated (intentional — different domain shape):
 *   - `CheckResult` in `packages/core/src/schema-management.ts` is a
 *     `{ ok, installed, bundled, missing, stale }` schema-install report,
 *     unrelated to diagnostic checks. It retains its local definition and
 *     will be renamed in a follow-up slice if/when its naming collision
 *     warrants a separate cleanup task.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 (Phase 0a)
 */

// ── ScaffoldResult ────────────────────────────────────────────────────

/**
 * Result of an `ensure*` scaffolding operation.
 *
 * All ensure functions in `@cleocode/core` are idempotent — they may
 * create, repair, or skip the requested resource and report which
 * action they took.
 *
 * Originally defined in:
 *   - `packages/core/src/scaffold.ts`
 *   - `packages/core/src/injection.ts`
 *   - `packages/core/src/hooks.ts`
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 (Phase 0a)
 */
export interface ScaffoldResult {
  /** What action was taken: created, repaired, or skipped. */
  action: 'created' | 'repaired' | 'skipped';
  /** Filesystem path that was operated on. */
  path: string;
  /** Human-readable explanation of the result. */
  details?: string;
}

// ── CheckStatus + CheckResult ─────────────────────────────────────────

/**
 * Status of a `check*` diagnostic.
 *
 * Originally defined in:
 *   - `packages/core/src/scaffold.ts`
 *   - `packages/core/src/validation/doctor/checks.ts`
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 (Phase 0a)
 */
export type CheckStatus = 'passed' | 'failed' | 'warning' | 'info';

/**
 * Result of a `check*` diagnostic (used by `cleo doctor` and scaffold
 * health checks).
 *
 * Originally defined in:
 *   - `packages/core/src/scaffold.ts`
 *   - `packages/core/src/validation/doctor/checks.ts`
 *
 * The scaffold.ts and doctor/checks.ts definitions were structurally
 * identical; this is the consolidated shape with TSDoc preserved.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 (Phase 0a)
 */
export interface CheckResult {
  /** Unique check identifier (e.g. "cleo_structure", "sqlite_db"). */
  id: string;
  /** Category grouping (e.g. "scaffold", "global"). */
  category: string;
  /** Diagnostic outcome: passed, failed, warning, or info. */
  status: CheckStatus;
  /** Human-readable description of the check result. */
  message: string;
  /** Structured metadata about the check (paths, sizes, missing items). */
  details: Record<string, unknown>;
  /** Suggested CLI command to fix the issue, or null if passed. */
  fix: string | null;
}

// ── HookCheckResult ───────────────────────────────────────────────────

/**
 * Result of a git-hook installation check.
 *
 * Reports whether a managed hook (commit-msg, pre-commit, pre-push) is
 * installed in `.git/hooks/` and whether the installed copy matches the
 * source template under `packages/core/templates/git-hooks/`.
 *
 * Originally defined in `packages/core/src/hooks.ts`. Promoted here to
 * co-locate all scaffold-diagnostic shapes.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 (Phase 0a)
 */
export interface HookCheckResult {
  /** Hook name (commit-msg, pre-commit, pre-push). */
  hook: string;
  /** Whether the hook is installed at `.git/hooks/<hook>`. */
  installed: boolean;
  /** Whether the installed hook bytes match the source template. */
  current: boolean;
  /** Absolute path of the source template that should be installed. */
  sourcePath: string;
  /** Absolute path where the hook is (or would be) installed. */
  installedPath: string;
}
