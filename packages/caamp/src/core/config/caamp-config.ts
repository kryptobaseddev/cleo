/**
 * CAAMP-wide configuration accessors.
 *
 * @remarks
 * This module is the single source of truth for CAAMP configuration values
 * that affect runtime behaviour across the package. Today it carries one
 * setting — {@link ExclusivityMode} — introduced by ADR-035 §D7 to control
 * how `resolveDefaultTargetProviders()` selects target providers at runtime
 * invocation time.
 *
 * The accessor pattern intentionally uses a layered resolution order so the
 * setting can be overridden by tests, by environment variables in CI, and by
 * future programmatic callers (e.g. a `caamp config set` subcommand) without
 * any of those layers needing to know about the others:
 *
 * 1. Programmatic override via {@link setExclusivityMode} (highest priority).
 * 2. Environment variable `CAAMP_EXCLUSIVITY_MODE`.
 * 3. Default value `'auto'`.
 *
 * The programmatic override exists primarily for tests and for future
 * `caamp config set` integration; production code should prefer the
 * environment variable when wiring CI or shell sessions.
 *
 * @packageDocumentation
 */

import type { ExclusivityMode } from '../harness/types.js';

/**
 * Default exclusivity mode used when no override is configured.
 *
 * @remarks
 * `auto` mirrors the v2026.4.5+ behaviour: Pi is preferred when installed,
 * but explicit non-Pi targets remain functional. This is the value the
 * accessor returns when neither {@link setExclusivityMode} nor the
 * `CAAMP_EXCLUSIVITY_MODE` environment variable is set.
 *
 * @public
 */
export const DEFAULT_EXCLUSIVITY_MODE: ExclusivityMode = 'auto';

/**
 * Environment variable name read by {@link getExclusivityMode} when no
 * programmatic override is active.
 *
 * @remarks
 * Exported as a constant so tests and downstream tooling can refer to the
 * canonical name without typo risk. The variable accepts the same three
 * literal values as the {@link ExclusivityMode} type.
 *
 * @public
 */
export const EXCLUSIVITY_MODE_ENV_VAR = 'CAAMP_EXCLUSIVITY_MODE';

/**
 * Programmatic override slot. `null` means "no override active; fall through
 * to the environment variable layer". Mutated by {@link setExclusivityMode}
 * and {@link resetExclusivityModeOverride}.
 */
let programmaticOverride: ExclusivityMode | null = null;

/**
 * One-time warning latches for the two `auto`-mode warnings emitted by
 * `resolveDefaultTargetProviders`.
 *
 * @remarks
 * Kept in a single object so accessor and mutator helpers share state
 * without exporting individual `let` bindings. `piAbsentAutoWarned` tracks
 * the boot warning emitted when Pi is not installed; `explicitNonPiAutoWarned`
 * tracks the deprecation warning emitted when an explicit non-Pi target is
 * supplied while Pi is installed. Both flags reset to `false` via
 * {@link resetExclusivityWarningState}.
 *
 * @internal
 */
const exclusivityWarningState = {
  piAbsentAutoWarned: false,
  explicitNonPiAutoWarned: false,
};

/**
 * Read whether the `auto` + Pi-absent boot warning has already fired for
 * this process.
 *
 * @returns `true` once the warning has been emitted; `false` until then or
 *   after {@link resetExclusivityWarningState} runs.
 *
 * @internal
 */
export function hasPiAbsentAutoWarned(): boolean {
  return exclusivityWarningState.piAbsentAutoWarned;
}

/**
 * Read whether the `auto` + explicit-non-Pi deprecation warning has already
 * fired for this process.
 *
 * @returns `true` once the warning has been emitted; `false` until then or
 *   after {@link resetExclusivityWarningState} runs.
 *
 * @internal
 */
export function hasExplicitNonPiAutoWarned(): boolean {
  return exclusivityWarningState.explicitNonPiAutoWarned;
}

/**
 * Mark the `auto` + Pi-absent warning as already emitted for this process.
 *
 * @remarks
 * Called by `resolveDefaultTargetProviders` immediately after it writes the
 * boot warning to `console.warn`. Idempotent — calling more than once is
 * harmless.
 *
 * @internal
 */
export function markPiAbsentAutoWarned(): void {
  exclusivityWarningState.piAbsentAutoWarned = true;
}

/**
 * Mark the `auto` + explicit-non-Pi deprecation warning as already emitted
 * for this process.
 *
 * @remarks
 * Called by `resolveDefaultTargetProviders` immediately after it writes the
 * deprecation warning to `console.warn`. Idempotent.
 *
 * @internal
 */
export function markExplicitNonPiAutoWarned(): void {
  exclusivityWarningState.explicitNonPiAutoWarned = true;
}

/**
 * Reset both per-process exclusivity warning latches.
 *
 * @remarks
 * Exposed solely for tests so the matrix can verify both the "warns once"
 * and "subsequent calls do not re-emit" cases without relying on Vitest
 * isolation modes that reset the entire module graph between tests. Not
 * part of the user-facing API surface; do not call from production code.
 *
 * @internal
 */
export function resetExclusivityWarningState(): void {
  exclusivityWarningState.piAbsentAutoWarned = false;
  exclusivityWarningState.explicitNonPiAutoWarned = false;
}

/**
 * Error raised when {@link getExclusivityMode} resolves to `'force-pi'` but
 * Pi is not installed at the moment a runtime dispatch is requested.
 *
 * @remarks
 * Carries an `E_NOT_FOUND_RESOURCE`-shaped `code` so command-layer error
 * envelopes (LAFS) can map it to a stable category. Callers decide whether
 * to surface this as a process exit (typically code 4) or as a structured
 * envelope; the harness layer never calls `process.exit` itself.
 *
 * Lives next to the configuration accessor rather than in the harness
 * dispatcher so consumers that import the mode also pick up the matching
 * error type without a second module hop.
 *
 * @example
 * ```typescript
 * try {
 *   const targets = resolveDefaultTargetProviders();
 * } catch (err) {
 *   if (err instanceof PiRequiredError) {
 *     process.exit(4);
 *   }
 *   throw err;
 * }
 * ```
 *
 * @public
 */
export class PiRequiredError extends Error {
  /** LAFS-stable error code identifying this failure mode. */
  public readonly code = 'E_NOT_FOUND_RESOURCE' as const;

  /**
   * Construct a new {@link PiRequiredError}.
   *
   * @param message - Human-readable failure description; defaults to a
   *   stable string suitable for direct CLI display.
   */
  constructor(
    message = 'caamp.exclusivityMode is set to "force-pi" but Pi is not installed. Install Pi (https://github.com/mariozechner/pi-coding-agent) or change the mode with CAAMP_EXCLUSIVITY_MODE=auto.',
  ) {
    super(message);
    this.name = 'PiRequiredError';
  }
}

/**
 * Type guard that narrows an arbitrary string to {@link ExclusivityMode}.
 *
 * @remarks
 * Used both internally and by callers that need to validate untrusted input
 * (e.g. CLI flag parsers, env var readers) before passing it through to
 * {@link setExclusivityMode}.
 *
 * @param value - Candidate value to validate.
 * @returns `true` when `value` is one of `'auto'`, `'force-pi'`, `'legacy'`.
 *
 * @example
 * ```typescript
 * if (isExclusivityMode(userInput)) {
 *   setExclusivityMode(userInput);
 * }
 * ```
 *
 * @public
 */
export function isExclusivityMode(value: string): value is ExclusivityMode {
  return value === 'auto' || value === 'force-pi' || value === 'legacy';
}

/**
 * Resolve the active CAAMP exclusivity mode using the layered precedence
 * documented in {@link DEFAULT_EXCLUSIVITY_MODE}.
 *
 * @remarks
 * Resolution order:
 *
 * 1. Programmatic override (set via {@link setExclusivityMode}).
 * 2. Environment variable `CAAMP_EXCLUSIVITY_MODE`.
 * 3. {@link DEFAULT_EXCLUSIVITY_MODE} (`'auto'`).
 *
 * Invalid environment variable values are silently ignored (resolution
 * falls through to the default) so a typo in CI does not crash the CLI.
 * The value is never cached — every call re-reads the environment so tests
 * that mutate `process.env` see consistent results without needing to
 * reset module state.
 *
 * @returns The currently effective exclusivity mode.
 *
 * @example
 * ```typescript
 * const mode = getExclusivityMode();
 * if (mode === 'force-pi') {
 *   // ...
 * }
 * ```
 *
 * @public
 */
export function getExclusivityMode(): ExclusivityMode {
  if (programmaticOverride !== null) {
    return programmaticOverride;
  }
  const envValue = process.env[EXCLUSIVITY_MODE_ENV_VAR];
  if (envValue !== undefined && isExclusivityMode(envValue)) {
    return envValue;
  }
  return DEFAULT_EXCLUSIVITY_MODE;
}

/**
 * Install a programmatic override for the exclusivity mode.
 *
 * @remarks
 * The override takes precedence over the environment variable for the
 * remainder of the process or until {@link resetExclusivityModeOverride}
 * is called. Intended for tests, for future `caamp config set` wiring, and
 * for short-lived runtime adjustments (e.g. a one-shot CLI flag).
 *
 * @param mode - Mode to install.
 *
 * @example
 * ```typescript
 * setExclusivityMode('force-pi');
 * try {
 *   await runCommand();
 * } finally {
 *   resetExclusivityModeOverride();
 * }
 * ```
 *
 * @public
 */
export function setExclusivityMode(mode: ExclusivityMode): void {
  programmaticOverride = mode;
}

/**
 * Clear any programmatic override installed by {@link setExclusivityMode}.
 *
 * @remarks
 * After calling this, {@link getExclusivityMode} resumes reading from the
 * environment variable (and falls back to the default when the env var is
 * unset or invalid). Idempotent — safe to call when no override is active.
 *
 * @public
 */
export function resetExclusivityModeOverride(): void {
  programmaticOverride = null;
}
