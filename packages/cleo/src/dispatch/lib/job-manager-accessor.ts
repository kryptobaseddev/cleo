/**
 * Singleton accessor for BackgroundJobManager (thin re-export shim).
 *
 * The accessor was relocated to `@cleocode/runtime/gateway` (R3-K1 · T11455 ·
 * SG-RUNTIME-UNIFICATION) so the `admin` domain handler resolves the singleton
 * from the runtime layer rather than a cleo-internal path. This shim re-exports
 * the surface so any in-package consumer importing from
 * `'../lib/job-manager-accessor.js'` compiles unchanged.
 *
 * @task T4820
 * @task T11455
 */

export { getJobManager, setJobManager } from '@cleocode/runtime/gateway';
