/**
 * Singleton accessor for the gateway {@link BackgroundJobManager}.
 *
 * @remarks
 * Relocated from `packages/cleo/src/dispatch/lib/job-manager-accessor.ts` into
 * `@cleocode/runtime/gateway` (R3-K1 · T11455 · SG-RUNTIME-UNIFICATION) so the
 * `admin` domain handler resolves the job-manager singleton from the runtime
 * layer rather than a cleo-internal path. A thin re-export shim remains at the
 * old path so any existing import site compiles unchanged.
 *
 * Long-lived hosts (e.g. the daemon) call {@link setJobManager} once at startup;
 * short-lived CLI invocations leave the singleton `null`, and consumers handle
 * the absence gracefully.
 *
 * @task T4820
 * @task T11455
 */

import type { BackgroundJobManager } from './background-jobs.js';

/** Process-wide singleton instance, or `null` when no host has registered one. */
let _instance: BackgroundJobManager | null = null;

/**
 * Register the process-wide {@link BackgroundJobManager} singleton.
 *
 * @param manager - The manager instance to expose to gateway consumers.
 */
export function setJobManager(manager: BackgroundJobManager): void {
  _instance = manager;
}

/**
 * Retrieve the registered {@link BackgroundJobManager} singleton.
 *
 * @returns The registered manager, or `null` when running in a short-lived
 * host (e.g. a one-shot CLI invocation) that never called {@link setJobManager}.
 */
export function getJobManager(): BackgroundJobManager | null {
  return _instance;
}
