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
 * Two process-lifetime singletons violate that contract because they own a
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
 *   2. **The pino-roll log transport** ({@link closeLogger}). `pino.transport()`
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
import { closeAllDatabases } from './store/sqlite.js';

/**
 * Run a teardown step, swallowing any error so a single failure cannot abort
 * the remaining teardown steps. Best-effort by design.
 */
async function safely(step: () => Promise<void> | void): Promise<void> {
  try {
    await step();
  } catch {
    // Best-effort teardown — never let cleanup throw out of the CLI exit path.
  }
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
 *   2. {@link closeAllDatabases} — close the dual-scope `cleo.db` + brain/nexus
 *      native handles (releases file locks; required on Windows).
 *   3. {@link closeLogger} — flush + terminate the pino-roll transport worker.
 *
 * Every step is best-effort and idempotent — safe to call once per process at
 * exit, and harmless if a given subsystem was never initialized.
 *
 * @returns A promise that resolves once all teardown steps have settled.
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
export async function shutdownCliRuntime(): Promise<void> {
  // 1. BRAIN single-writer worker thread — the live MessagePort that hangs
  //    `cleo memory observe` / `cleo docs add` / any brain.db write path.
  await safely(() => shutdownBrainWriter());

  // 2. Close DB singletons (dual-scope cleo.db + brain/nexus native handles).
  //    Releases SQLite file handles — required before tmpdir cleanup on Windows.
  await safely(() => closeAllDatabases());

  // 3. Flush + terminate the pino-roll transport worker thread.
  await safely(() => closeLogger());
}
