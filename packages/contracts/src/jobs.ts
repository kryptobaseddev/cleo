/**
 * Background job contracts.
 *
 * Canonical home for the durable-job lifecycle types. Promoted from
 * `packages/core/src/store/tasks-schema.ts` in Phase 0c of the
 * SG-ARCH-SOLID Saga so that the cleo dispatch layer
 * (`@cleocode/cleo/dispatch/lib/background-jobs.ts`) can import the
 * status union without pulling in the Drizzle schema runtime.
 *
 * The `BACKGROUND_JOB_STATUSES` const array remains in `tasks-schema.ts`
 * because Drizzle's `text({ enum: ... })` column declaration narrows the
 * runtime row type directly from that `as const` literal. `tasks-schema.ts`
 * re-exports {@link BackgroundJobStatus} from this module to preserve the
 * existing public surface.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9955 (Phase 0c)
 */

/**
 * Lifecycle status of a durable background job persisted in `tasks.db`.
 *
 *   - `pending`   — created but not yet picked up by a worker
 *   - `running`   — actively executing; emits heartbeats
 *   - `complete`  — finished successfully (`result` populated, `error` NULL)
 *   - `failed`    — finished with an error (`error` populated, `result` NULL)
 *   - `cancelled` — explicitly cancelled by a caller
 *   - `orphaned`  — was `running` when the process exited; requires human/agent review
 *
 * Jobs survive process restart; any row with `status='running'` at startup
 * is transitioned to `status='orphaned'` so humans/agents can triage them.
 *
 * @task T641
 * @remarks
 * The values here MUST stay aligned with `BACKGROUND_JOB_STATUSES` in
 * `tasks-schema.ts`; that const array drives the Drizzle row type. A
 * compile-time structural assertion in
 * `packages/contracts/src/__tests__/jobs.test.ts` pins both sides.
 */
export type BackgroundJobStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'orphaned';
