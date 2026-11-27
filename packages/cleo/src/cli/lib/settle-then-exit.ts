/**
 * The CLI's error exit: settle best-effort writes, then exit (T13164).
 *
 * The error paths print the error envelope and end the process with
 * `process.exit(code)`, which kills whatever is still pending and skips
 * `beforeExit`. A failed mutation's audit row (now written before the dispatcher
 * returns), its tracked hook dispatches and its buffered telemetry event were
 * all lost that way. `settleBeforeExit` waits for tracked producers within the
 * shutdown deadline and flushes telemetry; it closes nothing, so it is safe
 * where `process.exit` is stubbed.
 *
 * @module
 * @task T13164
 */

/**
 * Settle the CLI's best-effort writes, then exit with `code`.
 *
 * @param code - Process exit code.
 * @param settle - Settles pending work; core `settleBeforeExit` by default.
 * @param exit - Ends the process; core `exitProcess` by default, which stops
 *   tracked worker threads within a deadline so `process.exit` cannot hang
 *   joining a wedged one (T14670).
 * @returns Never, when `exit` ends the process.
 *
 * @example
 * ```ts
 * cliError(message, exitCode, details);
 * await settleThenExit(exitCode);
 * ```
 */
export async function settleThenExit(
  code: number,
  settle: () => Promise<unknown> = settleWithCore,
  exit: (code: number) => never | Promise<never> = exitWithCore,
): Promise<never> {
  // Set first: if the loop drains while the settle is pending, Node exits on
  // its own with process.exitCode, and a failed command must never exit 0.
  process.exitCode = code;
  try {
    await settle();
  } catch {
    // Settling is best effort; the exit code stands.
  }
  return await exit(code);
}

/** Core's settle, loaded on demand from its leaf module (no barrel). */
async function settleWithCore(): Promise<number> {
  const { settleBeforeExit } = await import('@cleocode/core/shutdown');
  return settleBeforeExit();
}

/** Core's bounded exit (T14670), loaded on demand from its leaf module. */
async function exitWithCore(code: number): Promise<never> {
  try {
    const { exitProcess } = await import('@cleocode/core/shutdown-deadline');
    return await exitProcess(code);
  } catch {
    return process.exit(code);
  }
}
