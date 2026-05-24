/**
 * CLI projection signal context (T9922 / Saga T9855 / E8.3).
 *
 * Singleton that captures whether the user passed `--verbose`, `--full`, or
 * `--human` for this CLI invocation. The dispatcher reads this once via
 * {@link getProjectionOptOut} and forwards the signal to the MVI record
 * projection middleware so read operations (`tasks.show`, `tasks.list`,
 * `tasks.find`, `docs.list`, `docs.fetch`) can either project to MVI (default)
 * or return the full record.
 *
 * @module @cleocode/cleo/cli/projection-context
 *
 * @epic T9855
 * @task T9922
 */

let currentOptOut = false;

/**
 * Set the projection opt-out signal for this CLI invocation.
 *
 * Called once from the global flag parser in {@link startCli} when the user
 * passes `--verbose`, `--full`, or when the format-context resolves to
 * `--human` mode (the human renderer needs the full record).
 */
export function setProjectionOptOut(optOut: boolean): void {
  currentOptOut = optOut;
}

/**
 * Read the projection opt-out signal.
 *
 * @returns `true` when the user opted out of MVI projection; `false` (the
 *          default) means the projection middleware should apply MVI.
 */
export function getProjectionOptOut(): boolean {
  return currentOptOut;
}

/**
 * Reset the opt-out signal to its default. Test-only helper.
 *
 * @internal
 */
export function resetProjectionOptOut(): void {
  currentOptOut = false;
}
