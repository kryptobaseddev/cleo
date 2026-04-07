/**
 * Pure helper for computing the human-readable `profile` status string
 * surfaced by `cleo agent start`.
 *
 * Extracted from `agent.ts` so it can be unit-tested without spinning up
 * the full daemon, the SignalDock registry, or the Pi runtime. The
 * helper has zero side effects and accepts only plain inputs — that is
 * the entire point of pulling it out.
 *
 * **Daemon vs. Pi session.** The status this helper produces describes
 * what `cleo agent start` did with the on-disk `.cant` profile file. It
 * is purely informational. The daemon NEVER interprets the profile —
 * profile-driven workflow execution lives inside the Pi extension at
 * `packages/cleo/templates/cleoos-hub/pi-extensions/cant-bridge.ts`,
 * not inside the daemon process. See ADR-035 §D5 (Option Y addendum)
 * for the rationale.
 *
 * @see ../commands/agent.ts
 * @see .cleo/adrs/ADR-035-pi-v2-v3-harness.md §D5 + Addendum
 *
 * @packageDocumentation
 */

/**
 * Outcome of validating a `.cant` profile via `@cleocode/cant`'s
 * `validate()` function (when available in the current build).
 *
 * @public
 */
export interface ProfileValidation {
  /** `true` when the parser produced zero diagnostics. */
  readonly valid: boolean;
  /** Diagnostic messages surfaced by the parser, in order. */
  readonly errors: readonly string[];
}

/**
 * Possible status values surfaced by `cleo agent start` for the
 * profile-loading step.
 *
 * - `'none'` — no `.cant` file at the resolved path; the daemon starts
 *   without a profile loaded.
 * - `'loaded (unvalidated)'` — file existed and was read into memory,
 *   but the optional `@cleocode/cant` validator was not available in
 *   this build, so we cannot say whether it parses cleanly.
 * - `'validated'` — file existed, the validator ran, and the parser
 *   produced zero diagnostics.
 * - `` `invalid (${N} errors)` `` — file existed, the validator ran,
 *   and the parser surfaced N diagnostics. The N is the diagnostic
 *   count, not a severity score.
 *
 * The status is purely informational. None of these branches change
 * the daemon's behaviour — the daemon polls SignalDock either way.
 * Profile-driven behaviour runs inside Pi sessions via the
 * `cant-bridge.ts` Pi extension.
 *
 * @public
 */
export type ProfileStatus =
  | 'none'
  | 'loaded (unvalidated)'
  | 'validated'
  | `invalid (${number} errors)`;

/**
 * Compute the human-readable profile status string for the
 * `cleo agent start` command output.
 *
 * @remarks
 * This is a pure function with three branches:
 *
 * 1. `profile === null` → `'none'` — no file existed at the resolved path.
 * 2. `validation === null` → `'loaded (unvalidated)'` — file was read
 *    but the optional validator was not available.
 * 3. `validation.valid === true` → `'validated'`
 * 4. `validation.valid === false` → `` `invalid (${N} errors)` ``
 *    where N is `validation.errors.length`.
 *
 * The function NEVER consults `createRuntime`, the registry, or any
 * other side-effecting subsystem. It exists exactly so the
 * profile-status branch can be exercised in unit tests without booting
 * the daemon.
 *
 * @param profile - The contents of the `.cant` file, or `null` when no
 *   file was present at the resolved path.
 * @param validation - The result of running `@cleocode/cant`'s
 *   `validate()` against `profile`, or `null` when the validator was
 *   not available in the current build.
 * @returns A status string suitable for the `profile` field of the
 *   `cleo agent start` LAFS envelope.
 *
 * @example
 * ```typescript
 * computeProfileStatus(null, null);                        // 'none'
 * computeProfileStatus('agent foo:', null);                // 'loaded (unvalidated)'
 * computeProfileStatus('agent foo:', { valid: true, errors: [] });
 * // 'validated'
 * computeProfileStatus('agent foo:', { valid: false, errors: ['e1', 'e2'] });
 * // 'invalid (2 errors)'
 * ```
 *
 * @public
 */
export function computeProfileStatus(
  profile: string | null,
  validation: ProfileValidation | null,
): ProfileStatus {
  if (profile === null) return 'none';
  if (validation === null) return 'loaded (unvalidated)';
  if (validation.valid) return 'validated';
  return `invalid (${validation.errors.length} errors)`;
}
