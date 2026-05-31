/**
 * Background Job Manager for Long-Running Operations (thin re-export shim).
 *
 * The background-job manager was relocated to `@cleocode/runtime/gateway`
 * (R3-K1 · T11455 · SG-RUNTIME-UNIFICATION) as the type backing the relocated
 * job-manager singleton, so the runtime owns the shared handler dependencies.
 * This shim re-exports the full surface so any in-package consumer importing
 * from `'../lib/background-jobs.js'` compiles unchanged.
 *
 * @task T641
 * @task T11455
 */

export {
  type BackgroundJob,
  BackgroundJobManager,
  type BackgroundJobManagerConfig,
  type BackgroundJobStatus,
  DurableJobStore,
} from '@cleocode/runtime/gateway';
