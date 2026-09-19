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
 * Opening a client preserves running work. Ownership expires only by its
 * persisted lease; legacy rows without ownership require explicit recovery.
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

/** Immutable request used to coalesce a job within one project and operation. */
export interface BackgroundJobSubmission {
  /** Stable identity of the project owning the operation. */
  projectId: string;
  /** Caller-selected retry key, scoped to project and operation. */
  idempotencyKey: string;
  /** Exact serialized proposal bytes; changing them rejects retry-key reuse. */
  proposalJson: string;
}

/** Persisted execution ownership; the epoch fences earlier attempts. */
export interface BackgroundJobLease {
  /** Job to which this grant belongs. */
  readonly jobId: string;
  /** Unique store-client identity, independent of actor display labels. */
  readonly ownerId: string;
  /** Monotonically increasing claim epoch. */
  readonly epoch: number;
  /** Expiration observed when this grant was issued, in epoch milliseconds. */
  readonly expiresAt: number;
}

/** Configuration for a client of the existing durable job store. */
export interface BackgroundJobStoreOptions {
  /** Explicit project scope; absent on legacy unscoped clients. */
  projectId?: string;
  /** Human/agent identity recorded separately from the unique owner token. */
  actor?: string;
  /** Positive lease duration in milliseconds; defaults to 30 seconds. */
  leaseMs?: number;
}

/** Capabilities delivered to the existing executor, not a new execution engine. */
export interface BackgroundJobExecutionContext {
  /** Cooperative cancellation signal, including remote persisted requests. */
  signal: AbortSignal;
  /** Current attempt fence; does not authorize arbitrary domain mutations. */
  lease: BackgroundJobLease;
  /** Persist JSON checkpoint bytes only while this attempt still owns the lease. */
  checkpoint: (valueJson: string) => void;
}

/** Stable failures for scoped retry, lease ownership, and malformed job inputs. */
export type BackgroundJobFailureCode =
  | 'E_JOB_INPUT_INVALID'
  | 'E_JOB_SCOPE_MISMATCH'
  | 'E_JOB_IDEMPOTENCY_CONFLICT'
  | 'E_JOB_LEASE_LOST'
  | 'E_JOB_NOT_RECLAIMABLE'
  | 'E_JOB_TRANSACTION_OWNED';
