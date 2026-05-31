/**
 * Background Job Manager — gateway re-export.
 *
 * @remarks
 * The Drizzle-backed background-job manager lives in `@cleocode/core/store`
 * (R3-K1 · T11455 · SG-RUNTIME-UNIFICATION) — that is the package which owns the
 * consolidated SQLite schema and the SINGLE `drizzle-orm` instance, so the query
 * builders type-check against one instance (no dual peer-hashed `SQL<unknown>`
 * mismatch under `tsc -b`). This module re-exports that surface so the gateway
 * (and the `@cleocode/runtime/gateway` barrel) expose `BackgroundJobManager` etc.
 * WITHOUT `@cleocode/runtime` taking its own `drizzle-orm` dependency.
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
} from '@cleocode/core/store/background-jobs.js';
