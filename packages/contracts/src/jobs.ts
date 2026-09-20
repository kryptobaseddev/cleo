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
 *   - `failed`    — finished with an error (`result` may retain authenticated outcome metadata)
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

/** Caller and query binding for one bounded durable candidate scan. */
export interface BackgroundJobPageScope {
  /** Cursor/query representation version. */
  version: 1;
  /** Exact persisted project identity. */
  projectId: string;
  /** Captured project root; a cursor cannot cross project copies. */
  projectRoot: string;
  /** Requesting principal, not the mutable claimedBy owner label. */
  actor: string;
  /** Exact operation being enumerated. */
  operation: string;
  /** Optional lifecycle filter, null for every retained status. */
  status: BackgroundJobStatus | null;
  /** Maximum candidate rows inspected, between one and 100. */
  limit: number;
  /** Maximum combined UTF-8 text payload bytes in each candidate. */
  maxPayloadBytes: number;
}

/** Stable position after an immutable submission timestamp and unique ID. */
export interface BackgroundJobPageCursor extends BackgroundJobPageScope {
  /** Original submission time; claiming or retrying never changes it. */
  startedAt: number;
  /** Unique tie-breaker at the last scanned candidate, not the last actor match. */
  id: string;
}

/** Bounded candidate query; the domain validates immutable proposal principals. */
export interface BackgroundJobPageQuery {
  /** Exact persisted operation to inspect. */
  operation: string;
  /** Optional stored status; omission includes every status and prior job. */
  status?: BackgroundJobStatus;
  /** Maximum scanned candidates, default 25 and capped at 100. */
  limit?: number;
  /** Per-candidate text-byte cap, default 256 KiB and capped at one MiB. */
  maxPayloadBytes?: number;
  /** Cursor bound to this exact caller, project and query. */
  after?: BackgroundJobPageCursor;
}

/** One bounded storage observation, not an actor-filtered or multi-page snapshot. */
export interface BackgroundJobCandidatePage<TJob> {
  /** Fully bounded candidate values; the domain must validate actor and source hashes. */
  candidates: TJob[];
  /** Exact query/caller binding. */
  scope: BackgroundJobPageScope;
  /** Number of candidates scanned in this page. */
  scannedCount: number;
  /** Additional storage candidates were observed beyond the page. */
  hasMoreCandidates: boolean;
  /** Continue after the last scanned row, including pages with no actor matches. */
  nextCursor: BackgroundJobPageCursor | null;
  /** Matching principal population is deliberately not counted by this generic store. */
  matchingTotal: null;
  /** Each page has its own SQLite read snapshot; concurrent changes may affect later pages. */
  observation: 'per-page-snapshot';
  /** Actor authorization is deferred to the domain's immutable proposal schema. */
  principalValidation: 'domain-required';
}

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

/** Immutable authority reference, revalidated against the job row inside each domain write transaction. */
export interface BackgroundJobWriteFence {
  /** Actual database file containing both the job row and guarded domain resources. */
  readonly dbPath: string;
  /** Authentic proposal digest; the executor must separately verify domain preconditions. */
  readonly proposalHash: string;
  /** Attempt ownership; copying this grant never substitutes for checking persisted state. */
  readonly lease: BackgroundJobLease;
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
  /** Optional shared foreground scope; persisted lease remains independently required. */
  readonly execution?: OperationExecutionContext;
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
  | 'E_JOB_TRANSACTION_OWNED'
  | 'E_JOB_DEADLINE_EXCEEDED'
  | 'E_JOB_LOCK_POLICY_CONFLICT';

/** Immutable routing and provenance captured before asynchronous operation work. */
export interface OperationExecutionIdentity {
  /** Stable project identifier; never inferred again during execution. */
  readonly projectId: string;
  /** Absolute repository/project root associated with this accepted operation. */
  readonly projectRoot: string;
  /** Foreground caller responsible for the operation. */
  readonly actor: string;
  /** Exact supported operation name. */
  readonly operation: string;
  /** Retry identity scoped to this project and operation. */
  readonly idempotencyKey: string;
}

/** Cooperative accounting limits; these are not process memory or CPU isolation. */
export interface OperationResourceLimits {
  /** Maximum aggregate bytes admitted through guarded stages. */
  readonly maxBytes?: number;
  /** Maximum aggregate items admitted through guarded stages. */
  readonly maxItems?: number;
}

/** Increment charged before a guarded stage starts work. */
export interface OperationResourceUsage {
  /** Bytes the stage intends to process. */
  readonly bytes?: number;
  /** Items the stage intends to process. */
  readonly items?: number;
}

/** Inputs for one operation lifetime; nested stages receive the same context. */
export interface OperationExecutionOptions {
  /** Optional immutable job authority to revalidate at domain transaction boundaries. */
  readonly writeFence?: BackgroundJobWriteFence;
  /** Shared foreground budget; defaults to two seconds and may be zero. */
  readonly budgetMs?: number;
  /** Earlier absolute deadline inherited from an enclosing invocation. */
  readonly deadlineAt?: number;
  /** Optional caller cancellation, forwarded into the operation signal. */
  readonly signal?: AbortSignal;
  /** Optional admission limits; omitted dimensions are not bounded here. */
  readonly resources?: OperationResourceLimits;
}

/** Structured-cloneable execution scope for an already admitted worker stage. */
export interface OperationExecutionTransfer {
  /** Origin-issued job fence; receivers must validate it against their actual database. */
  readonly writeFence?: BackgroundJobWriteFence;
  /** Captured routing and provenance; receiving realms must not resolve it again. */
  readonly identity: OperationExecutionIdentity;
  /** Original absolute deadline, never a new worker budget. */
  readonly deadlineAt: number;
  /** One Int32 cancellation flag: zero is active; nonzero forbids new guarded work. */
  readonly cancellation: SharedArrayBuffer;
}

/** Origin-owned cancellation link for one admitted cross-realm stage. */
export interface OperationExecutionTransferHandle {
  /** Serializable scope sent through the existing worker protocol. */
  readonly transfer: OperationExecutionTransfer;
  /** Invalidate future receiver writes and detach the originating abort listener. */
  readonly release: () => void;
}

/** Reasons why an operation must not admit a new guarded stage. */
export type OperationExecutionStopCode =
  | 'E_OPERATION_CANCELLED'
  | 'E_OPERATION_DEADLINE'
  | 'E_OPERATION_CLOSED'
  | 'E_OPERATION_RESOURCE_LIMIT';

/**
 * Capabilities shared by foreground assessment, waiting, mutation and verification.
 * @remarks This context fences cooperating boundaries only. It does not authorize a
 * repair or preempt arbitrary callbacks, synchronous SQLite, CPU work or processes.
 */
export interface OperationExecutionContext {
  /** Optional job fence for domain writes; this value alone does not confer authority. */
  readonly writeFence?: BackgroundJobWriteFence;
  /** Frozen routing/provenance captured at operation acceptance. */
  readonly identity: OperationExecutionIdentity;
  /** One absolute deadline; stages must not create replacement budgets. */
  readonly deadlineAt: number;
  /** Cancellation from the caller, teardown, deadline, resource limit or close. */
  readonly signal: AbortSignal;
  /** Frozen declared admission limits. */
  readonly resources: OperationResourceLimits;
  /** Milliseconds still available; checks wall time even if timers cannot run. */
  readonly remainingMs: () => number;
  /** Reject new handles/writes at a cooperating boundary after cancellation. */
  readonly assertActive: () => void;
  /** Charge a stage's bytes/items atomically before admitting its work. */
  readonly consume: (usage: OperationResourceUsage) => void;
  /** Invalidate future guarded work and release listeners/timers; never undo commits. */
  readonly close: () => void;
}

/**
 * Trusted synchronous domain mutation admitted inside the job store's write transaction.
 * @param execution - Captured identity, deadline, cancellation and current ownership fence.
 * @returns JSON receipt bytes to persist as the job outcome in the same transaction.
 * @remarks Implementations must use the already-open database named by the fence,
 * must not control transactions, and must not schedule work or perform external
 * side effects. This contract does not sandbox arbitrary callbacks or preempt
 * synchronous work; domain preconditions and receipt validation remain required.
 */
export type AtomicJobMutation = (execution: OperationExecutionContext) => string;

/** Declared terminal outcome of an observed attempt; never inferred from lease expiry. */
export interface JobAttemptOutcome {
  /** Actual observed failure or acknowledged cancellation. */
  readonly status: 'failed' | 'cancelled';
  /** Sourced failure/cancellation explanation retained with the attempt. */
  readonly message: string;
}

/**
 * Trusted synchronous attempt receipt/event bookkeeping, without domain repair authority.
 * @returns Serialized JSON receipt bytes retained with the terminal job row.
 * @remarks Only existing services may supply this callback. It must append metadata
 * in the already-open database, never mutate repaired resources, schedule work,
 * control transactions or change connection pragmas. This is not an arbitrary-code sandbox.
 */
export type AtomicJobBookkeeping = () => string;

/**
 * Trusted synchronous explicit-retry bookkeeping inside the existing job transaction.
 * @param previousAttemptJson - Complete previous stored row image, including original result,
 * error, checkpoint, cancellation, counters and lease fields; retain these exact JSON bytes.
 * @returns JSON receipt bytes verified by the domain after append-only persistence.
 * @remarks Recheck immutable domain preconditions and preserve the previous attempt before
 * returning. Expired running work is retained as uncertain, never relabeled as failed.
 * No asynchronous work, external effects or transaction control is permitted.
 * This trusted composition port does not sandbox arbitrary callbacks.
 */
export type AtomicJobRetryBookkeeping = (previousAttemptJson: string) => string;

/** Truthful terminal bookkeeping result, separate from the attempted domain operation. */
export type JobFinalizationResult =
  | {
      /** Metadata and terminal row committed together. */
      readonly state: 'finalized';
      /** Exact committed receipt bytes. */
      readonly resultJson: string;
      /** Connection cleanup failure observed after commit; the receipt remains committed. */
      readonly cleanupError?: string;
      /** Actual elapsed synchronous wall time, including cleanup. */
      readonly elapsedMs: number;
      /** Whether synchronous commit/cleanup finished after the original deadline. */
      readonly deadlineExceeded: boolean;
    }
  | {
      /** No terminal outcome was committed; preserve the existing lease/checkpoint. */
      readonly state: 'pending-finalization';
      /** Actual refusal or bookkeeping failure, not an invented attempt outcome. */
      readonly reason: string;
      /** Actual elapsed synchronous wall time, including cleanup. */
      readonly elapsedMs: number;
      /** Whether the original execution deadline has elapsed. */
      readonly deadlineExceeded: boolean;
    };

/**
 * Observation of a bounded wait, separate from the underlying operation's receipt.
 * @typeParam T - Value produced if the supplied promise settles during observation.
 */
export type OperationWaitResult<T> =
  | {
      /** The supplied promise settled before observation ended. */
      readonly settled: true;
      /** Successful outcome. */
      readonly success: true;
      /** Actual result, retained even when synchronous work exceeded its budget. */
      readonly value: T;
      /** Wall time exceeded the shared deadline; no preemption is claimed. */
      readonly deadlineExceeded: boolean;
    }
  | {
      /** The supplied promise rejected before observation ended. */
      readonly settled: true;
      /** Failed outcome. */
      readonly success: false;
      /** Actual diagnostic from the supplied work. */
      readonly error: Error;
      /** Wall time exceeded the shared deadline. */
      readonly deadlineExceeded: boolean;
    }
  | {
      /** Observation ended; this does not mean the supplied work stopped. */
      readonly settled: false;
      /** Reason the observer returned while work remained unresolved. */
      readonly reason: OperationExecutionStopCode;
      /** Wall time reached the shared deadline. */
      readonly deadlineExceeded: boolean;
    };
