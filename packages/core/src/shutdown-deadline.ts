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
 *    loop is still alive after the grace period. Unref'd is the whole trick:
 *    a timer that does not itself hold the loop open. If teardown worked and
 *    the loop drains, the process exits naturally and this timer never fires —
 *    the established "drain, then exit" contract (ADR-039 / T9633) is fully
 *    preserved. It fires only in the case that used to hang forever.
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
  /** `true` when the step settled within its deadline. */
  readonly settled: boolean;
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

  const settled = await Promise.race([
    (async () => {
      try {
        await step();
      } catch {
        // Best-effort teardown — a throwing step is a settled step.
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
  return { label, settled, durationMs: Date.now() - startedAt };
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
 * kept the loop alive, then exits with `code`.
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
        `(held by: ${activeHandleSummary()}); exiting rc:${code}. ` +
        `This is a resource leak — please report it with the command you ran.\n`,
    );
    process.exit(code);
  }, graceMs);

  timer.unref();
  return timer;
}
