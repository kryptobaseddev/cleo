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
 * every teardown is wrapped so one failure cannot mask another, and calling it
 * twice is a no-op for already-closed handles.
 *
 * This is NOT a `process.exit()` band-aid: the established CLI exit contract is
 * "drain the loop, then exit". Forcing teardown of the long-lived handles
 * restores that contract instead of papering over it. Mid-operation handles
 * (shared dual-scope `cleo.db`) are released here too, honoring the L4/L5
 * shared-handle rule that they close at PROCESS EXIT, not mid-operation.
 *
 * @module
 * @task T11568
 */

import { closeLogger } from './logger.js';
import { shutdownBrainWriter } from './memory/brain-writer-thread.js';
import { resetEmbeddingQueue } from './memory/embedding-queue.js';
import { type StepOutcome, withDeadline } from './shutdown-deadline.js';
import { closeAllDatabases } from './store/sqlite.js';

/**
 * Run a teardown step under a deadline, swallowing both errors and stalls.
 *
 * T12115: the original helper swallowed only *throws*. A step that never
 * settles is not a throw, so a stalled worker handshake hung the exit path
 * forever — measured at 12.9 hours on a live host, with the process still
 * holding its SQLite descriptors because teardown never reached step 3.
 * Bounding each step is what makes "best-effort" actually best-effort.
 */
async function safely(label: string, step: () => Promise<void> | void): Promise<StepOutcome> {
  return withDeadline(label, step);
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
 *   1. {@link shutdownBrainWriter} — terminate the BRAIN single-writer worker
 *      thread (the `MessagePort` proven to hang `cleo memory observe`).
 *   2. {@link resetEmbeddingQueue} — flush + terminate the embedding queue
 *      worker thread (T11655 — the second live `MessagePort` that can keep a
 *      one-shot CLI command alive after its envelope is emitted).
 *   3. {@link closeAllDatabases} — close the dual-scope `cleo.db` + brain/nexus
 *      native handles (releases file locks; required on Windows).
 *   4. {@link closeLogger} — flush + terminate the pino-roll transport worker.
 *
 * Every step is best-effort and idempotent — safe to call once per process at
 * exit, and harmless if a given subsystem was never initialized.
 *
 * @returns One {@link StepOutcome} per step, in run order. A step with
 *          `settled: false` blew its deadline and was abandoned — the caller
 *          should surface that, because it means something leaked.
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
  // 1. BRAIN single-writer worker thread — the live MessagePort that hangs
  //    `cleo memory observe` / `cleo docs add` / any brain.db write path.
  const outcomes: StepOutcome[] = [];
  outcomes.push(await safely('brain-writer', () => shutdownBrainWriter()));

  // 2. Embedding queue worker thread (T11655) — the second live MessagePort.
  //    Flushes in-flight batches then terminates the worker, so an opportunistic
  //    embed enqueued during the command cannot keep the loop alive at exit.
  outcomes.push(await safely('embedding-queue', () => resetEmbeddingQueue()));

  // 3. Close DB singletons (dual-scope cleo.db + brain/nexus native handles).
  //    Releases SQLite file handles — required before tmpdir cleanup on Windows.
  outcomes.push(await safely('databases', () => closeAllDatabases()));

  // 4. Flush + terminate the pino-roll transport worker thread.
  outcomes.push(await safely('logger', () => closeLogger()));

  return outcomes;
}
