/**
 * Coordinated process-lifetime teardown for short-lived CLI invocations.
 *
 * ## Why this exists (T11568 — post-E6 process hang)
 *
 * The CLEO CLI's success path does NOT call `process.exit()` — it emits the
 * LAFS envelope and returns, relying on the libuv event loop draining naturally
 * so the process exits with code 0 (see `runMainWithLafsEnvelope` in
 * `packages/cleo/src/cli/index.ts`). That contract only holds while every
 * resource opened during the command is released by the time the handler
 * resolves.
 *
 * Three process-lifetime singletons violate that contract because they own a
 * `worker_threads.Worker` whose `MessagePort` keeps the event loop alive:
 *
 *   1. **The BRAIN single-writer worker** ({@link shutdownBrainWriter}). Every
 *      hot-path write to `brain.db` (`cleo memory observe`, decisions, the
 *      dialectic pipeline) is funneled through a `worker_threads.Worker`
 *      (T10351). The worker is created lazily on first write and registered for
 *      a `process.on('exit')` flush — but that exit handler can never fire
 *      because the worker's `MessagePort` is itself what keeps the loop alive,
 *      so a `cleo memory observe` printed its success envelope and then hung
 *      (rc:124) until the shell timed it out.
 *   2. **The embedding queue worker** ({@link resetEmbeddingQueue}). The
 *      {@link EmbeddingQueue} singleton (T134/T137) lazily spawns a
 *      `worker_threads.Worker` to batch transformers.js embeddings off the main
 *      thread. Its live `MessagePort` keeps the loop alive exactly like the
 *      brain writer — and the opportunistic dream in `cleo briefing` could feed
 *      it (or, in the worker-unavailable fallback, run embeddings inline on the
 *      main thread), the residual hang/spin path tracked in T11655.
 *   3. **The pino-roll log transport** ({@link closeLogger}). `pino.transport()`
 *      backs a worker thread too; its rotation timer + port keep the loop alive
 *      in the same way once `initLogger` has run.
 *
 * Installed builds where the worker file was not resolvable fell back to the
 * inline executor (no worker) and exited cleanly — masking the defect until the
 * E6 build shipped a resolvable `brain-writer-worker.js`.
 *
 * {@link shutdownCliRuntime} is the single chokepoint the CLI calls from its
 * success-path `finally` (after the envelope has been written to stdout) so the
 * loop can drain and the process exits rc:0. It is best-effort and idempotent:
 * outcomes name incomplete steps. Resource closure starts only after tracked
 * producers settle, and no step receives time beyond the shared deadline.
 * Calling it again is harmless for already-closed handles.
 *
 * This is NOT a `process.exit()` band-aid: the established CLI exit contract is
 * "drain the loop, then exit". Forcing teardown of the long-lived handles
 * restores that contract when the producer barrier and resource steps finish.
 * Mid-operation handles (shared dual-scope `cleo.db`) are released only after
 * that barrier; incomplete teardown is surfaced for the existing exit backstop.
 *
 * @module
 * @task T11568
 */

import { closeLogger } from './logger.js';
import { shutdownBrainWriter } from './memory/brain-writer-thread.js';
import { resetEmbeddingQueue } from './memory/embedding-queue.js';
import { STEP_DEADLINE_MS, type StepOutcome, withDeadline } from './shutdown-deadline.js';
import {
  awaitBackgroundOps,
  type BackgroundDrainReport,
  pendingBackgroundOpCount,
} from './store/background-ops.js';
import { closeAllDatabases } from './store/sqlite.js';
import { markShuttingDown } from './teardown-signal.js';

/** Run only within the original shutdown deadline; never refresh a step's budget. */
async function safely(
  label: string,
  step: () => Promise<void> | void,
  deadlineAt: number,
): Promise<StepOutcome> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0)
    return {
      label,
      settled: false,
      threw: false,
      durationMs: 0,
      status: 'not-started',
      reason: 'shutdown-deadline',
    };
  const outcome = await withDeadline(label, step, remainingMs);
  return outcome.reason === 'step-deadline' ? { ...outcome, reason: 'shutdown-deadline' } : outcome;
}

/**
 * Tear down every process-lifetime resource that would otherwise keep the libuv
 * event loop alive after a short-lived CLI command resolves.
 *
 * Call this from the CLI's success-path `finally`, AFTER the command's LAFS
 * envelope has been emitted to stdout. The CLI does not `process.exit()` on
 * success (ADR-039 / T9633), so without this the brain-writer worker thread
 * (T10351) or the pino-roll transport worker can keep the process hanging at
 * rc:124.
 *
 * Order:
 *   0. Cancel registered contexts, then await registered producer settlement.
 *   1. {@link shutdownBrainWriter} — terminate the BRAIN single-writer worker
 *      thread (the `MessagePort` proven to hang `cleo memory observe`).
 *   2. {@link resetEmbeddingQueue} — flush + terminate the embedding queue
 *      worker thread (T11655 — the second live `MessagePort` that can keep a
 *      one-shot CLI command alive after its envelope is emitted).
 *   3. {@link closeAllDatabases} — close the dual-scope `cleo.db` + brain/nexus
 *      native handles (releases file locks; required on Windows).
 *   4. {@link closeLogger} — flush + terminate the pino-roll transport worker.
 *
 * @remarks All steps share one {@link STEP_DEADLINE_MS} budget captured at entry.
 * Cancellation preserves producers' original contexts; waiting grants no new
 * write budget. If tracked producers do not settle, resource closers are not
 * started. A timed-out drain cannot later resume closing resources. Untracked
 * work is outside this registry's guarantee, and synchronous work cannot be
 * preempted; the deadline is checked again before each subsequent step.
 * Already-settled best-effort failures do not undo committed command results.
 * The producer barrier reports its observed pending count and leaves individual
 * producer outcomes unassessed; settling is not proof that their work succeeded.
 *
 * @returns One stage receipt using the outcome contract of {@link withDeadline},
 *          in run order. A step with
 *          `settled: false` did not finish, or was not started because the
 *          shared budget or producer barrier prevented safe closure. The caller
 *          must surface incomplete teardown; it is not successful resource closure.
 *
 * @example
 * ```ts
 * try {
 *   await runCommand(cmd, { rawArgs });
 * } finally {
 *   await shutdownCliRuntime();
 * }
 * ```
 *
 * @task T11568
 */
export async function shutdownCliRuntime(): Promise<StepOutcome[]> {
  const deadlineAt = Date.now() + STEP_DEADLINE_MS;
  markShuttingDown();

  let report: BackgroundDrainReport | undefined;
  const drain = await safely(
    'background-operations',
    async () => {
      report = await awaitBackgroundOps();
      // The legacy barrier caps rescheduling rounds; a return alone does not
      // establish that every registered producer has actually settled.
      if (pendingBackgroundOpCount() !== 0) {
        throw new Error('Registered background producers remain after the shutdown barrier');
      }
    },
    deadlineAt,
  );
  const pendingAfterDrain = pendingBackgroundOpCount();
  // An abandoned drain produced no report, so its producers stay genuinely
  // unassessed. A completed one assessed every producer it observed, and the
  // count of real failures is disclosed instead of a standing caveat (T12310).
  const assessment: Pick<StepOutcome, 'producerOutcome' | 'failedOperations'> =
    report === undefined
      ? { producerOutcome: 'unassessed' }
      : { producerOutcome: 'assessed', failedOperations: report.failed };
  const outcomes: StepOutcome[] = [
    {
      ...drain,
      ...(drain.threw && pendingAfterDrain > 0 ? { reason: 'drain-incomplete' as const } : {}),
      ...assessment,
      pendingOperations: pendingAfterDrain,
    },
  ];
  let mayClose = drain.settled && !drain.threw;
  let blockedReason: StepOutcome['reason'] = mayClose ? undefined : 'drain-incomplete';
  const steps = [
    ['brain-writer', shutdownBrainWriter],
    ['embedding-queue', resetEmbeddingQueue],
    ['databases', closeAllDatabases],
    ['logger', closeLogger],
  ] as const;
  for (const [label, close] of steps) {
    // Recheck at each boundary: a closer may itself register more work.
    const pendingOperations = pendingBackgroundOpCount();
    if (pendingOperations > 0) {
      mayClose = false;
      blockedReason = 'background-pending';
    }
    if (!mayClose) {
      outcomes.push({
        label,
        settled: false,
        threw: false,
        durationMs: 0,
        status: 'not-started',
        reason: blockedReason,
        pendingOperations,
      });
      continue;
    }
    const outcome = await safely(label, close, deadlineAt);
    outcomes.push(outcome);
    // An unsettled closer can still own the resources later steps would close.
    mayClose = outcome.settled;
    if (!mayClose)
      blockedReason = outcome.status === 'not-started' ? outcome.reason : 'prior-step-incomplete';
  }
  return outcomes;
}
