/**
 * Deadlines and a last-resort exit backstop for CLI teardown.
 *
 * ## Why this module exists (T12115 — the 12.9-hour `cleo` process)
 *
 * {@link ../shutdown.ts | shutdownCliRuntime} tears down the process-lifetime
 * workers so a one-shot CLI command can drain its event loop and exit rc:0.
 * Every step was best-effort — wrapped so a *throw* could not abort the rest —
 * but nothing bounded a step that never settles at all. A promise that simply
 * does not resolve is not an error, so `safely()` waited on it forever.
 *
 * Measured on a live box 2026-09-12: `cleo update T1690` sat in `ep_poll` for
 * **12.9 hours**, holding ~100 MB RSS and open SQLite descriptors on two
 * databases. Its envelope had been printed hours earlier; the command was DONE.
 * Sibling `cleo add` / `cleo update` processes from other agent sessions had
 * been resident 9.3 hours each. Thirty-one such processes held 3.25 GiB between
 * them while the host ran 13 GiB into swap with 3 GiB free of 62 GiB.
 *
 * The descriptors are the tell: `closeAllDatabases()` is step 3 of 4, so if the
 * DB handles are still open the teardown never got past step 1 or 2 — both of
 * which await a worker thread. A hang there is invisible: the envelope is on
 * stdout, the exit code is never written, and the caller cannot distinguish
 * "still working" from "wedged forever" (issues #1228, #1229, #1237, #1241).
 *
 * ## The two guarantees
 *
 * 1. {@link withDeadline} — no single teardown step can stall the exit path.
 *    A step that misses its deadline is abandoned, not awaited. Abandoning is
 *    safe here precisely because teardown is best-effort: the worst case is a
 *    worker thread that outlives us by microseconds before the process exits.
 *
 * 2. {@link armExitBackstop} — an **unref'd** timer that force-exits if the
 *    loop is still alive after the grace period. Unref'd means the timer does
 *    not itself hold the loop open, so a process that drains promptly exits
 *    naturally and never reaches it.
 *
 *    It does NOT mean the timer only fires on leaks. An unref'd timer still
 *    *fires* if the loop is alive for any other reason when the grace period
 *    elapses — including legitimate unawaited work. `cleo memory observe`
 *    schedules a fire-and-forget embedding whose first call loads a ~22 MB
 *    model, which will not finish inside the grace window on a cold cache. So
 *    the backstop can and does cut short work that was going to succeed. That
 *    is an accepted trade: a bounded exit with a named remedy beats an
 *    unbounded hang. It is why the message below says what was abandoned
 *    rather than claiming the process was idle.
 *
 * Neither is a substitute for fixing a leak. Both exist so that the next leak
 * costs a log line instead of a wedged host.
 *
 * @module
 * @task T12115
 */

/** Per-step teardown budget, in ms. */
export const STEP_DEADLINE_MS = 2_000;

/** Grace period after teardown before the backstop force-exits, in ms. */
export const EXIT_BACKSTOP_MS = 3_000;

/** Outcome of one deadline-bounded teardown step. */
export interface StepOutcome {
  /** Human-readable step name, used in diagnostics. */
  readonly label: string;
  /**
   * `true` when the step settled within its deadline.
   *
   * NOTE: settled includes "threw immediately" — see {@link threw}. Teardown is
   * best-effort by policy, so a throwing step is not a failure of the exit
   * path. It is still worth recording.
   */
  readonly settled: boolean;
  /**
   * `true` when the step threw rather than completing.
   *
   * Without this, `settled` alone made a throwing step **structurally
   * invisible**: four steps that all threw and four that all succeeded
   * produced byte-identical outcome arrays. That is absence reading as
   * success, in the teardown path, in code written to fix exactly that.
   *
   * It matters unevenly. A throwing `logger` close is noise; a throwing
   * `databases` close means an unclean SQLite shutdown, and this project has
   * explicit history with WAL/sidecar desync (AGENTS.md, Runtime Data Safety).
   * A throwing `brain-writer` plausibly means unflushed memory writes — every
   * invocation, forever, with nothing to look at.
   */
  readonly threw: boolean;
  /** Wall-clock time the step consumed, in ms. */
  readonly durationMs: number;
}

/**
 * Run a teardown step, abandoning it if it outlives `deadlineMs`.
 *
 * Swallows rejections as well as stalls — a teardown step must never be able to
 * abort the exit path, whether by throwing or by never settling.
 *
 * @param label - step name for diagnostics.
 * @param step - the teardown work.
 * @param deadlineMs - budget before the step is abandoned.
 * @returns what happened, for the caller's diagnostics.
 *
 * @example
 * ```ts
 * const outcome = await withDeadline('brain-writer', () => shutdownBrainWriter());
 * if (!outcome.settled) console.error('brain-writer did not stop in time');
 * ```
 */
export async function withDeadline(
  label: string,
  step: () => Promise<void> | void,
  deadlineMs: number = STEP_DEADLINE_MS,
): Promise<StepOutcome> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;

  let threw = false;

  const settled = await Promise.race([
    (async () => {
      try {
        await step();
      } catch {
        // Best-effort teardown — a throwing step is still a settled step and
        // must not abort the exit path. RECORDED rather than swallowed, so a
        // teardown failing on every invocation is discoverable.
        //
        // Deliberately not logged here. `closeLogger` is itself step 4 of this
        // sequence, so a catch that reaches for the logger can run against a
        // subsystem that is mid-teardown or already closed — turning a recorded
        // failure into a second, worse one. The caller surfaces `threw` on
        // stderr instead, where nothing is being torn down.
        threw = true;
      }
      return true;
    })(),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), deadlineMs);
      // Do not let the deadline timer itself hold the loop open.
      timer.unref();
    }),
  ]);

  if (timer) clearTimeout(timer);
  return { label, settled, threw, durationMs: Date.now() - startedAt };
}

/**
 * Names of the resources currently keeping the event loop alive.
 *
 * Wraps `process.getActiveResourcesInfo()`, which is the only supported way to
 * answer "what is holding this process open" without a native inspector. Values
 * are coarse type names (`'Timeout'`, `'MessagePort'`, `'TCPSocketWrap'`), which
 * is exactly the granularity needed to route the next report to a subsystem.
 *
 * @returns a tally of active-handle type names, most frequent first.
 */
export function activeHandleSummary(): string {
  const info = (
    process as NodeJS.Process & { getActiveResourcesInfo?: () => string[] }
  ).getActiveResourcesInfo?.();
  if (!info || info.length === 0) return 'none';

  const tally = new Map<string, number>();
  for (const name of info) tally.set(name, (tally.get(name) ?? 0) + 1);

  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
    .join(', ');
}

/**
 * Arm the last-resort exit backstop.
 *
 * Call once, AFTER the envelope has been written and teardown has been
 * attempted. The returned timer is unref'd, so a healthy process that drains
 * its loop exits normally and never reaches this code path.
 *
 * When it does fire, it writes one diagnostic line to **stderr** — never stdout,
 * which must carry exactly one LAFS envelope per call (ADR-086) — naming what
 * kept the loop alive and warning that unawaited background work was cut short,
 * then exits with `code`.
 *
 * The exit code stays the command's own result. A killed *tail* is not a failed
 * *command*: the envelope on stdout is already correct and the row is already
 * written. Exiting non-zero here would turn a slow-but-correct invocation into
 * a failure, which is the false-red defect (gh#1270) in a new place.
 *
 * @param code - exit code to use; the command's own result, not an error code.
 * @param graceMs - how long to let the loop try to drain on its own.
 * @returns the armed timer, so tests can inspect or clear it.
 *
 * @example
 * ```ts
 * await shutdownCliRuntime();
 * armExitBackstop(0);   // healthy commands exit before this ever fires
 * ```
 */
export function armExitBackstop(code = 0, graceMs: number = EXIT_BACKSTOP_MS): NodeJS.Timeout {
  const timer = setTimeout(() => {
    if (process.env.CLEO_NO_EXIT_BACKSTOP === '1') return;
    process.stderr.write(
      `cleo: event loop still alive ${graceMs}ms after teardown ` +
        `(held by: ${activeHandleSummary()}); exiting rc:${code}.\n` +
        `cleo: any unawaited background work was abandoned. The command's own ` +
        `result stands — its envelope is already written. Deferred BRAIN ` +
        `embeddings are recoverable with \`cleo brain maintenance\`. If this ` +
        `recurs on a fast command it is a resource leak; please report it with ` +
        `the command you ran.\n`,
    );
    process.exit(code);
  }, graceMs);

  timer.unref();
  return timer;
}
