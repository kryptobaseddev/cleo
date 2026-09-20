/**
 * Existing durable job store and executor facade.
 *
 * Opening a client never changes ownership. Each mutation uses a SQLite write
 * transaction and an expiring owner/epoch fence. Legacy unowned rows remain
 * inspectable; they require explicit recovery rather than guessed ownership.
 *
 * The active table is background_jobs (epoch-ms timestamps). The separate
 * tasks_background_jobs history is retained without rebinding or conversion.
 * Job fences protect job metadata, not arbitrary mutations inside an executor.
 *
 * @task T12263
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  AtomicJobBookkeeping,
  AtomicJobMutation,
  AtomicJobRetryBookkeeping,
  BackgroundJobCandidatePage,
  BackgroundJobExecutionContext,
  BackgroundJobFailureCode,
  BackgroundJobLease,
  BackgroundJobPageQuery,
  BackgroundJobPageScope,
  BackgroundJobStoreOptions,
  BackgroundJobSubmission,
  JobAttemptOutcome,
  JobFinalizationResult,
  OperationExecutionContext,
} from '@cleocode/contracts/jobs';
import { and, asc, eq, getTableColumns, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from './sqlite.js';
import {
  BACKGROUND_JOB_STATUSES,
  type BackgroundJobRow,
  type BackgroundJobStatus,
  backgroundJobs,
} from './tasks-schema.js';

export type { BackgroundJobStatus };

/** Inspectable durable job, including unresolved legacy scope and ownership. */
export interface BackgroundJob {
  /** Unique persisted job ID. */
  id: string;
  /** Supported operation name. */
  operation: string;
  /** Persisted lifecycle status; cancellation requests are separate. */
  status: BackgroundJobStatus;
  /** ISO-8601 creation time. */
  startedAt: string;
  /** ISO-8601 terminal time, if committed. */
  completedAt?: string;
  /** Existing executor result surface. */
  result?: unknown;
  /** Persisted executor error, when failed. */
  error?: string;
  /** Last reported percentage. */
  progress?: number;
  /** Actor display identity, distinct from the unique lease owner. */
  claimedBy?: string;
  /** Explicit project identity; null discloses unresolved legacy scope. */
  projectId: string | null;
  /** Unique owner of the current claim; null on legacy unowned rows. */
  ownerId: string | null;
  /** Current lease expiration in epoch milliseconds. */
  leaseExpiresAt: number | null;
  /** Last heartbeat in epoch milliseconds. */
  heartbeatAt: number;
  /** Monotonic claim fence. */
  fencingEpoch: number;
  /** Number of issued execution claims. */
  attempts: number;
  /** Persisted cancellation request; does not assert executor termination. */
  cancellationRequestedAt: number | null;
  /** Last fenced JSON checkpoint bytes. */
  checkpointJson: string | null;
  /** Last checkpoint timestamp in epoch milliseconds. */
  checkpointAt: number | null;
  /** Project/operation-scoped retry key. */
  idempotencyKey: string | null;
  /** SHA-256 of immutable proposal bytes. */
  proposalHash: string | null;
  /** Authentic immutable input bytes; null means the original payload is unavailable. */
  proposalJson: string | null;
  /** Ownership assessment at read time, independent of lifecycle status. */
  ownership: 'current' | 'expired' | 'unclaimed' | 'legacy-unknown' | 'terminal';
  /** Explicit diagnostic failure, when result decoding or local persistence failed. */
  diagnosticError?: string;
}

/** Configuration for the existing executor facade. */
export interface BackgroundJobManagerConfig extends BackgroundJobStoreOptions {
  /** Maximum running jobs observed in this client's project scope. */
  maxJobs?: number;
  /** Former retention window. @deprecated Job evidence is retained regardless of age. */
  retentionMs?: number;
}

/**
 * Stable refusal of an unsafe ownership, retry, or transaction operation.
 * @remarks A refusal preserves the current owner's work and reports no committed transition.
 */
export class BackgroundJobError extends Error {
  /** Machine-readable refusal reason. */
  readonly code: BackgroundJobFailureCode;

  /**
   * Construct an explicit job-store refusal.
   * @param code - Stable failure category.
   * @param message - Human-readable reason and required correction.
   * @remarks This error never establishes successful job execution.
   * @example
   * ```ts
   * throw new BackgroundJobError('E_JOB_LEASE_LOST', 'Reclaim expired work first');
   * ```
   */
  constructor(code: BackgroundJobFailureCode, message: string) {
    super(message);
    this.name = 'BackgroundJobError';
    this.code = code;
  }
}

function rowToJob(row: BackgroundJobRow): BackgroundJob {
  const terminal = row.status !== 'running' && row.status !== 'pending';
  const job: BackgroundJob = {
    id: row.id,
    operation: row.operation,
    status: row.status,
    startedAt: new Date(row.startedAt).toISOString(),
    projectId: row.projectId,
    ownerId: row.ownerId,
    leaseExpiresAt: row.leaseExpiresAt,
    heartbeatAt: row.heartbeatAt,
    fencingEpoch: row.fencingEpoch,
    attempts: row.attempts,
    cancellationRequestedAt: row.cancellationRequestedAt,
    checkpointJson: row.checkpointJson,
    checkpointAt: row.checkpointAt,
    idempotencyKey: row.idempotencyKey,
    proposalHash: row.proposalHash,
    proposalJson: row.proposalJson,
    ownership: terminal
      ? 'terminal'
      : row.status === 'pending' && pendingProposalProblem(row) === null
        ? 'unclaimed'
        : row.ownerId === null || row.leaseExpiresAt === null
          ? 'legacy-unknown'
          : row.leaseExpiresAt <= Date.now()
            ? 'expired'
            : 'current',
  };
  if (row.status === 'pending') job.diagnosticError = pendingProposalProblem(row) ?? undefined;
  if (row.completedAt !== null) job.completedAt = new Date(row.completedAt).toISOString();
  if (row.result !== null) {
    try {
      job.result = JSON.parse(row.result);
    } catch {
      job.result = row.result;
      job.diagnosticError = 'Stored job result is not valid JSON';
    }
  }
  if (row.error !== null) job.error = row.error;
  if (row.progress !== null) job.progress = row.progress;
  if (row.claimedBy !== null) job.claimedBy = row.claimedBy;
  return job;
}

function pendingProposalProblem(row: BackgroundJobRow): string | null {
  if (
    row.ownerId !== null ||
    row.leaseExpiresAt !== null ||
    row.fencingEpoch !== 0 ||
    row.attempts !== 0
  )
    return 'Pending job contains inconsistent execution ownership; explicit recovery is required';
  if (
    !row.projectId ||
    !row.idempotencyKey ||
    row.proposalJson === null ||
    row.proposalHash === null
  )
    return 'Pending job has no authentic scoped proposal payload; explicit recovery is required';
  try {
    requireJson(row.proposalJson);
  } catch {
    return 'Pending job proposal is not valid JSON';
  }
  if (createHash('sha256').update(row.proposalJson).digest('hex') !== row.proposalHash)
    return 'Pending job proposal bytes do not match their immutable hash';
  return null;
}

function requireText(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BackgroundJobError('E_JOB_INPUT_INVALID', `${field} must be a nonempty string`);
  }
}

function requireJson(value: string): void {
  if (typeof value !== 'string')
    throw new BackgroundJobError(
      'E_JOB_INPUT_INVALID',
      'Proposal/checkpoint must contain serialized JSON bytes',
    );
  try {
    JSON.parse(value);
  } catch {
    throw new BackgroundJobError(
      'E_JOB_INPUT_INVALID',
      'Proposal/checkpoint must contain valid JSON bytes',
    );
  }
}

function requireRunningLimit(maxRunning?: number): void {
  if (maxRunning !== undefined && (!Number.isSafeInteger(maxRunning) || maxRunning < 1))
    throw new BackgroundJobError(
      'E_JOB_INPUT_INVALID',
      'Running-job limit must be a positive safe integer',
    );
}

/**
 * Revalidate captured job ownership inside the domain's existing write transaction.
 * @param db - The same transaction handle that will perform the domain mutation.
 * @param execution - Captured lifetime and optional immutable job fence.
 * @throws BackgroundJobError when ownership, scope, proposal, cancellation or file identity changed.
 * @remarks This read does not start a transaction or authorize arbitrary work. Callers
 * must own the surrounding write transaction and independently validate their domain
 * preconditions. Keeping this check inside that transaction fences concurrent claims
 * and permits domain mutations and receipts to compose in one atomic unit.
 * @example
 * ```ts
 * db.transaction(tx => { assertOperationWriteFence(tx, execution); writePreparedRows(tx); });
 * ```
 */
export function assertOperationWriteFence(
  db: Pick<NodeSQLiteDatabase, 'select'>,
  execution: OperationExecutionContext,
): void {
  assertOperationJobState(db, execution, 'running');
}

function assertOperationJobState(
  db: Pick<NodeSQLiteDatabase, 'select'>,
  execution: OperationExecutionContext,
  status: 'running' | 'complete' | 'failed' | 'cancelled',
  resultJson?: string,
  bookkeeping = false,
  outcome?: JobAttemptOutcome,
): void {
  if (!bookkeeping) execution.assertActive();
  const fence = execution.writeFence;
  if (!fence) return;
  const row = db
    .select({
      proposalJson: sql<string | null>`${backgroundJobs.proposalJson}`,
      result: sql<string | null>`${backgroundJobs.result}`,
      error: sql<string | null>`${backgroundJobs.error}`,
    })
    .from(sql`main.${backgroundJobs}`)
    .where(
      and(
        eq(backgroundJobs.id, fence.lease.jobId),
        eq(backgroundJobs.status, status),
        eq(backgroundJobs.ownerId, fence.lease.ownerId),
        eq(backgroundJobs.fencingEpoch, fence.lease.epoch),
        gt(backgroundJobs.leaseExpiresAt, Date.now()),
        bookkeeping ? undefined : isNull(backgroundJobs.cancellationRequestedAt),
        eq(backgroundJobs.projectId, execution.identity.projectId),
        eq(backgroundJobs.operation, execution.identity.operation),
        eq(backgroundJobs.idempotencyKey, execution.identity.idempotencyKey),
        eq(backgroundJobs.proposalHash, fence.proposalHash),
        sql`EXISTS (SELECT 1 FROM pragma_database_list WHERE name = 'main' AND file = ${fence.dbPath})`,
      ),
    )
    .get();
  if (
    !row?.proposalJson ||
    createHash('sha256').update(row.proposalJson).digest('hex') !== fence.proposalHash ||
    (resultJson !== undefined && row.result !== resultJson) ||
    (outcome !== undefined && row.error !== outcome.message)
  ) {
    throw new BackgroundJobError(
      'E_JOB_LEASE_LOST',
      'Domain write refused: job authority or proposal no longer matches the captured attempt',
    );
  }
}

// Coordination only: no connection lifetime or domain cache is owned here.
const boundedTransactionHandles = new WeakSet<object>();

/**
 * Drizzle-backed ownership of the established active job table.
 * @remarks Sync methods refuse an already-owned native transaction before writing.
 * No method infers a missing legacy lease to be expired. Rows are never age-pruned.
 * @example
 * ```ts
 * const jobs = new DurableJobStore(db, { projectId: 'project-uuid' });
 * const lease = jobs.insert('job-uuid', 'doctor.knowledge', Date.now());
 * if (lease) jobs.complete(lease.jobId, { verified: true }, Date.now());
 * ```
 */
export class DurableJobStore {
  readonly #db: NodeSQLiteDatabase;
  readonly #ownerId = randomUUID();
  readonly #options: BackgroundJobStoreOptions;
  readonly #grants = new Map<string, BackgroundJobLease>();
  readonly #committedCleanupFailures = new Map<string, string>();
  /** Positive lease duration used for claims and heartbeats. */
  readonly leaseMs: number;

  /**
   * Open a client without changing persisted work.
   * @param db - Existing canonical database handle; no new connection is opened.
   * @param options - Explicit scope, actor, and lease duration.
   * @remarks Unscoped legacy callers retain visible null project identity.
   * @example
   * ```ts
   * const store = new DurableJobStore(db, { projectId: 'project-uuid', leaseMs: 30000 });
   * ```
   */
  constructor(db: NodeSQLiteDatabase, options: BackgroundJobStoreOptions = {}) {
    this.#db = db;
    this.#options = Object.freeze({ ...options });
    this.leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0) {
      throw new BackgroundJobError(
        'E_JOB_INPUT_INVALID',
        'leaseMs must be a positive safe integer',
      );
    }
    if (options.projectId !== undefined) requireText(options.projectId, 'projectId');
  }

  #scope() {
    return this.#options.projectId === undefined
      ? undefined
      : eq(backgroundJobs.projectId, this.#options.projectId);
  }

  #row(id: string): BackgroundJobRow | undefined {
    const columns = getTableColumns(backgroundJobs);
    return this.#db
      .select({
        id: sql`${columns.id}`.mapWith(columns.id),
        operation: sql`${columns.operation}`.mapWith(columns.operation),
        status: sql`${columns.status}`.mapWith(columns.status),
        startedAt: sql`${columns.startedAt}`.mapWith(columns.startedAt),
        completedAt: sql`${columns.completedAt}`.mapWith(columns.completedAt),
        result: sql`${columns.result}`.mapWith(columns.result),
        error: sql`${columns.error}`.mapWith(columns.error),
        progress: sql`${columns.progress}`.mapWith(columns.progress),
        heartbeatAt: sql`${columns.heartbeatAt}`.mapWith(columns.heartbeatAt),
        claimedBy: sql`${columns.claimedBy}`.mapWith(columns.claimedBy),
        projectId: sql`${columns.projectId}`.mapWith(columns.projectId),
        ownerId: sql`${columns.ownerId}`.mapWith(columns.ownerId),
        leaseExpiresAt: sql`${columns.leaseExpiresAt}`.mapWith(columns.leaseExpiresAt),
        fencingEpoch: sql`${columns.fencingEpoch}`.mapWith(columns.fencingEpoch),
        attempts: sql`${columns.attempts}`.mapWith(columns.attempts),
        cancellationRequestedAt: sql`${columns.cancellationRequestedAt}`.mapWith(
          columns.cancellationRequestedAt,
        ),
        checkpointJson: sql`${columns.checkpointJson}`.mapWith(columns.checkpointJson),
        checkpointAt: sql`${columns.checkpointAt}`.mapWith(columns.checkpointAt),
        idempotencyKey: sql`${columns.idempotencyKey}`.mapWith(columns.idempotencyKey),
        proposalHash: sql`${columns.proposalHash}`.mapWith(columns.proposalHash),
        proposalJson: sql`${columns.proposalJson}`.mapWith(columns.proposalJson),
      })
      .from(sql`main.${backgroundJobs}`)
      .where(and(eq(backgroundJobs.id, id), this.#scope()))
      .get();
  }

  #write<T>(
    operation: () => T,
    deadlineAt?: number,
    onCommittedCleanupFailure?: (message: string) => void,
    assertCommitAllowed?: () => void,
    readOnly = false,
  ): T {
    let outcome: { value: T } | undefined;
    let failure: Error | undefined;
    let handle: object | undefined;
    let previousTimeout: number | undefined;
    let installedTimeout: number | undefined;
    if (deadlineAt !== undefined) {
      if (Date.now() >= deadlineAt)
        throw new BackgroundJobError(
          'E_JOB_DEADLINE_EXCEEDED',
          'No budget remains for job bookkeeping',
        );
      if (
        !('$client' in this.#db) ||
        typeof this.#db.$client !== 'object' ||
        this.#db.$client === null
      )
        throw new BackgroundJobError(
          'E_JOB_INPUT_INVALID',
          'Bounded writes require the actual native handle identity',
        );
      handle = this.#db.$client;
      if (boundedTransactionHandles.has(handle))
        throw new BackgroundJobError(
          'E_JOB_TRANSACTION_OWNED',
          'Another caller owns this bounded native transaction',
        );
      boundedTransactionHandles.add(handle);
    }
    try {
      if (deadlineAt !== undefined) {
        previousTimeout = this.#db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`).timeout;
        installedTimeout = Math.max(
          0,
          Math.min(previousTimeout, Math.floor(deadlineAt - Date.now())),
        );
        this.#db.run(sql.raw(`PRAGMA busy_timeout=${installedTimeout}`));
        if (Date.now() >= deadlineAt)
          throw new BackgroundJobError(
            'E_JOB_DEADLINE_EXCEEDED',
            'Deadline elapsed before lock acquisition',
          );
      }
      // BEGIN outside rollback scope: failure must not roll back another caller.
      try {
        this.#db.run(readOnly ? sql`BEGIN DEFERRED` : sql`BEGIN IMMEDIATE`);
      } catch (error) {
        if (error instanceof Error && /within a transaction/i.test(String(error.cause ?? error)))
          throw new BackgroundJobError(
            'E_JOB_TRANSACTION_OWNED',
            'Job write refused: another caller owns the native transaction',
          );
        throw error;
      }
      try {
        if (deadlineAt !== undefined && Date.now() >= deadlineAt)
          throw new BackgroundJobError(
            'E_JOB_DEADLINE_EXCEEDED',
            'Deadline elapsed during lock acquisition',
          );
        const value = operation();
        if (deadlineAt !== undefined && Date.now() >= deadlineAt)
          throw new BackgroundJobError('E_JOB_DEADLINE_EXCEEDED', 'Deadline elapsed before commit');
        if (
          installedTimeout !== undefined &&
          this.#db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`).timeout !== installedTimeout
        )
          throw new BackgroundJobError(
            'E_JOB_LOCK_POLICY_CONFLICT',
            'Another caller changed the native lock policy',
          );
        assertCommitAllowed?.();
        this.#db.run(sql`COMMIT`);
        outcome = { value };
      } catch (error) {
        this.#db.run(sql`ROLLBACK`);
        throw error;
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      try {
        // Do not overwrite a later caller's independently changed timeout value.
        if (
          previousTimeout !== undefined &&
          installedTimeout !== undefined &&
          this.#db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`).timeout === installedTimeout
        )
          this.#db.run(sql.raw(`PRAGMA busy_timeout=${previousTimeout}`));
      } catch (error) {
        if (outcome && onCommittedCleanupFailure) onCommittedCleanupFailure(String(error));
        else {
          const cleanupFailure = error instanceof Error ? error : new Error(String(error));
          failure = failure
            ? new AggregateError(
                [failure, cleanupFailure],
                'Transaction and timeout cleanup failed',
              )
            : cleanupFailure;
        }
      } finally {
        if (handle) boundedTransactionHandles.delete(handle);
      }
    }
    if (failure) throw failure;
    if (!outcome)
      throw new BackgroundJobError('E_JOB_INPUT_INVALID', 'Transaction produced no outcome');
    return outcome.value;
  }

  #owned(id: string): BackgroundJobRow {
    const grant = this.#grants.get(id);
    const row = this.#row(id);
    if (
      !grant ||
      !row ||
      row.status !== 'running' ||
      row.ownerId !== this.#ownerId ||
      row.ownerId !== grant.ownerId ||
      row.fencingEpoch !== grant.epoch ||
      row.leaseExpiresAt === null ||
      row.leaseExpiresAt <= Date.now()
    ) {
      throw new BackgroundJobError(
        'E_JOB_LEASE_LOST',
        `Job ${id} is not owned by this unexpired attempt`,
      );
    }
    return row;
  }

  #grant(row: BackgroundJobRow): BackgroundJobLease {
    if (row.ownerId === null || row.leaseExpiresAt === null) {
      throw new BackgroundJobError(
        'E_JOB_LEASE_LOST',
        'Cannot issue a grant for unowned legacy work',
      );
    }
    return Object.freeze({
      jobId: row.id,
      ownerId: row.ownerId,
      epoch: row.fencingEpoch,
      expiresAt: row.leaseExpiresAt,
    });
  }

  /**
   * Create a leased job, or return the existing immutable scoped submission.
   * @param id - Proposed UUID for a new job.
   * @param operation - Supported operation identifier.
   * @param now - Event timestamp in epoch milliseconds.
   * @param submission - Optional scoped immutable retry contract.
   * @param maxRunning - Optional running-job limit checked atomically with creation.
   * @returns Grant for new work, or null when an identical submission already exists.
   * @remarks A repeated submission never acquires ownership or re-executes by itself.
   * @example
   * ```ts
   * const grant = store.insert(id, 'doctor.knowledge', Date.now(), submission);
   * ```
   */
  insert(
    id: string,
    operation: string,
    now: number,
    submission?: BackgroundJobSubmission,
    maxRunning?: number,
  ): BackgroundJobLease | null {
    const { row, created } = this.#submit(id, operation, now, submission, 'running', maxRunning);
    if (!created) return null;
    const grant = this.#grant(row);
    this.#grants.set(id, grant);
    return grant;
  }

  /**
   * Find an existing immutable submission without claiming it.
   * @param operation - Exact supported operation.
   * @param submission - Project and retry identity.
   * @returns Persisted job, or undefined.
   * @remarks Input conflict validation is performed by insert before coalescing.
   * @example
   * ```ts
   * const prior = store.findSubmission('doctor.knowledge', submission);
   * ```
   */
  findSubmission(
    operation: string,
    submission: BackgroundJobSubmission,
  ): BackgroundJob | undefined {
    const row = this.#db
      .select()
      .from(backgroundJobs)
      .where(
        and(
          this.#scope(),
          eq(backgroundJobs.projectId, submission.projectId),
          eq(backgroundJobs.operation, operation),
          eq(backgroundJobs.idempotencyKey, submission.idempotencyKey),
        ),
      )
      .get();
    return row ? rowToJob(row) : undefined;
  }

  /** Check the project running limit while the caller owns the write transaction. */
  #requireCapacity(maxRunning?: number, excludeId?: string): void {
    requireRunningLimit(maxRunning);
    if (maxRunning === undefined) return;
    const count =
      this.#db
        .select({ count: sql<number>`count(*)` })
        .from(backgroundJobs)
        .where(
          and(
            this.#scope(),
            eq(backgroundJobs.status, 'running'),
            excludeId ? ne(backgroundJobs.id, excludeId) : undefined,
          ),
        )
        .get()?.count ?? 0;
    if (count >= maxRunning)
      throw new BackgroundJobError(
        'E_JOB_INPUT_INVALID',
        `Maximum concurrent jobs reached (${maxRunning})`,
      );
  }

  /** Check an optional invocation budget and immutable submission scope without granting authority. */
  #assertInvocation(
    execution: OperationExecutionContext | undefined,
    operation: string,
    projectId: string | null,
    idempotencyKey: string | null,
  ): void {
    if (!execution) return;
    execution.assertActive();
    if (
      execution.identity.projectId !== projectId ||
      execution.identity.projectId !== this.#options.projectId ||
      execution.identity.operation !== operation ||
      execution.identity.idempotencyKey !== idempotencyKey
    )
      throw new BackgroundJobError(
        'E_JOB_SCOPE_MISMATCH',
        'Invocation differs from immutable job scope',
      );
  }

  /** Atomically coalesce or insert complete immutable proposal state. */
  #submit(
    id: string,
    operation: string,
    now: number,
    submission: BackgroundJobSubmission | undefined,
    status: 'pending' | 'running',
    maxRunning?: number,
    execution?: OperationExecutionContext,
  ) {
    this.#assertInvocation(
      execution,
      operation,
      submission?.projectId ?? null,
      submission?.idempotencyKey ?? null,
    );
    requireRunningLimit(maxRunning);
    requireText(id, 'id');
    if (!Number.isSafeInteger(now))
      throw new BackgroundJobError(
        'E_JOB_INPUT_INVALID',
        'Job event timestamp must be a safe integer',
      );
    requireText(operation, 'operation');
    if (submission) {
      requireText(submission.projectId, 'projectId');
      requireText(submission.idempotencyKey, 'idempotencyKey');
      requireJson(submission.proposalJson);
      if (
        this.#options.projectId !== undefined &&
        this.#options.projectId !== submission.projectId
      ) {
        throw new BackgroundJobError(
          'E_JOB_SCOPE_MISMATCH',
          'Submission project differs from the store scope',
        );
      }
    }
    const proposalHash = submission
      ? createHash('sha256').update(submission.proposalJson).digest('hex')
      : null;
    let committedId = id;
    return this.#write(
      () => {
        this.#assertInvocation(
          execution,
          operation,
          submission?.projectId ?? null,
          submission?.idempotencyKey ?? null,
        );
        if (submission) {
          const prior = this.#db
            .select()
            .from(backgroundJobs)
            .where(
              and(
                eq(backgroundJobs.projectId, submission.projectId),
                eq(backgroundJobs.operation, operation),
                eq(backgroundJobs.idempotencyKey, submission.idempotencyKey),
              ),
            )
            .get();
          if (prior) {
            if (
              prior.proposalHash !== proposalHash ||
              (prior.proposalJson !== null && prior.proposalJson !== submission.proposalJson)
            )
              throw new BackgroundJobError(
                'E_JOB_IDEMPOTENCY_CONFLICT',
                'Retry key was already used with different immutable proposal bytes',
              );
            committedId = prior.id;
            return { row: prior, created: false };
          }
        }
        if (status === 'running') this.#requireCapacity(maxRunning);
        const row = this.#db
          .insert(backgroundJobs)
          .values({
            id,
            operation,
            status,
            startedAt: now,
            heartbeatAt: now,
            claimedBy: this.#options.actor ?? null,
            projectId: submission?.projectId ?? this.#options.projectId ?? null,
            ownerId: status === 'running' ? this.#ownerId : null,
            leaseExpiresAt: status === 'running' ? Date.now() + this.leaseMs : null,
            fencingEpoch: status === 'running' ? 1 : 0,
            attempts: status === 'running' ? 1 : 0,
            proposalHash,
            proposalJson: submission?.proposalJson ?? null,
            idempotencyKey: submission?.idempotencyKey ?? null,
          })
          .returning()
          .get();
        return { row, created: true };
      },
      execution?.deadlineAt,
      (message) => this.#committedCleanupFailures.set(committedId, message),
      () => execution?.assertActive(),
    );
  }

  /**
   * Persist authentic pending work without claiming or starting an executor.
   * @param id - Proposed job identity; matching retries retain the original identity.
   * @param operation - Exact operation whose supported inputs the domain service validates.
   * @param now - Submission timestamp in epoch milliseconds.
   * @param submission - Required project-scoped immutable serialized proposal.
   * @param execution - Optional original invocation budget; omitted legacy callers retain existing behavior.
   * @returns Persisted pending job, or unchanged prior matching submission.
   * @remarks Input and its hash commit in one native transaction. Existing history
   * without payload is retained, never reconstructed from a hash or overwritten.
   * @example
   * ```ts
   * const pending = store.defer(id, 'docs.projection', Date.now(), submission);
   * ```
   */
  defer(
    id: string,
    operation: string,
    now: number,
    submission: BackgroundJobSubmission,
    execution?: OperationExecutionContext,
  ): BackgroundJob {
    if (!submission)
      throw new BackgroundJobError(
        'E_JOB_INPUT_INVALID',
        'Pending work requires a scoped proposal',
      );
    return rowToJob(
      this.#submit(id, operation, now, submission, 'pending', undefined, execution).row,
    );
  }

  /**
   * Read a job with scope and ownership disclosed.
   * @param id - Job identity.
   * @returns Job or undefined.
   * @remarks A missing or expired lease is never represented as current ownership.
   * @example
   * ```ts
   * const job = store.get(id);
   * ```
   */
  get(id: string): BackgroundJob | undefined {
    const row = this.#row(id);
    if (!row) return undefined;
    const job = rowToJob(row);
    const cleanupError = this.#committedCleanupFailures.get(id);
    return cleanupError ? { ...job, diagnosticError: cleanupError } : job;
  }

  /**
   * List visible jobs.
   * @param status - Optional lifecycle filter.
   * @returns Matching scoped jobs.
   * @remarks Project-scoped clients exclude other projects and unscoped legacy rows.
   * @example
   * ```ts
   * const jobs = store.list('running');
   * ```
   */
  list(status?: string): BackgroundJob[] {
    if (
      status !== undefined &&
      !BACKGROUND_JOB_STATUSES.some((candidate) => candidate === status)
    ) {
      throw new BackgroundJobError('E_JOB_INPUT_INVALID', `Unsupported job status: ${status}`);
    }
    return this.#db
      .select()
      .from(backgroundJobs)
      .where(
        and(
          this.#scope(),
          status ? eq(backgroundJobs.status, status as BackgroundJobStatus) : undefined,
        ),
      )
      .all()
      .map(rowToJob);
  }

  /**
   * Read a bounded candidate page without a runtime manager or ownership mutation.
   * @param query - Exact operation, optional status, payload cap and bound cursor.
   * @param execution - Original captured caller and deadline; never renewed by this read.
   * @returns Candidate rows and a last-scanned cursor; the domain must validate principals.
   * @throws BackgroundJobError for ambiguous scope, mismatched cursors, oversized rows or borrowed transactions.
   * @remarks SQL limits candidates before payload materialization or JSON parsing. Mutable
   * claimedBy is not used as principal authority. Existing transaction cleanup bounds lock waits;
   * synchronous SQLite work is cooperative and cannot be preempted by a JavaScript timer.
   * @example
   * ```ts
   * const page = store.listPage({ operation: 'doctor.knowledge', limit: 20 }, execution);
   * ```
   */
  listPage(
    query: BackgroundJobPageQuery,
    execution: OperationExecutionContext,
  ): BackgroundJobCandidatePage<BackgroundJob> {
    execution.assertActive();
    const projectId = this.#options.projectId;
    const actor = this.#options.actor;
    if (
      !projectId ||
      !actor?.trim() ||
      execution.identity.projectId !== projectId ||
      execution.identity.actor !== actor ||
      execution.identity.operation !== query.operation
    )
      throw new BackgroundJobError(
        'E_JOB_SCOPE_MISMATCH',
        'Candidate reads require an exact project, explicit caller and operation',
      );
    requireText(query.operation, 'operation');
    const limit = query.limit ?? 25;
    const maxPayloadBytes = query.maxPayloadBytes ?? 262144;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(maxPayloadBytes) ||
      maxPayloadBytes < 1 ||
      maxPayloadBytes > 1048576 ||
      (query.status !== undefined &&
        !BACKGROUND_JOB_STATUSES.some((status) => status === query.status))
    )
      throw new BackgroundJobError('E_JOB_INPUT_INVALID', 'Invalid bounded candidate query');
    const scope: BackgroundJobPageScope = {
      version: 1,
      projectId,
      projectRoot: execution.identity.projectRoot,
      actor,
      operation: query.operation,
      status: query.status ?? null,
      limit,
      maxPayloadBytes,
    };
    const after = query.after;
    if (
      after !== undefined &&
      (!after ||
        typeof after !== 'object' ||
        !Number.isSafeInteger(after.startedAt) ||
        typeof after.id !== 'string' ||
        !after.id.trim() ||
        after.version !== scope.version ||
        after.projectId !== scope.projectId ||
        after.projectRoot !== scope.projectRoot ||
        after.actor !== scope.actor ||
        after.operation !== scope.operation ||
        after.status !== scope.status ||
        after.limit !== scope.limit ||
        after.maxPayloadBytes !== scope.maxPayloadBytes)
    )
      throw new BackgroundJobError(
        'E_JOB_SCOPE_MISMATCH',
        'Candidate cursor belongs to a different caller or query',
      );
    return this.#write(
      (): BackgroundJobCandidatePage<BackgroundJob> => {
        execution.assertActive();
        const columns = getTableColumns(backgroundJobs);
        const payloadBytes = sql<number>`${sql.join(
          Object.values(columns)
            .filter((column) => column.dataType === 'string' || column.dataType === 'string enum')
            .map((column) => sql`length(CAST(coalesce(${column}, '') AS BLOB))`),
          sql` + `,
        )}`;
        // The first query never returns opaque payloads. An over-limit ID is withheld too.
        const selected = this.#db
          .select({
            id: sql<string>`CASE WHEN ${payloadBytes} <= ${maxPayloadBytes} THEN ${columns.id} ELSE '' END`,
            startedAt: columns.startedAt,
            payloadBytes,
          })
          .from(backgroundJobs)
          .where(
            and(
              this.#scope(),
              eq(columns.operation, query.operation),
              query.status ? eq(columns.status, query.status) : undefined,
              after
                ? or(
                    gt(columns.startedAt, after.startedAt),
                    and(eq(columns.startedAt, after.startedAt), gt(columns.id, after.id)),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(columns.startedAt), asc(columns.id))
          .limit(limit + 1)
          .all();
        execution.assertActive();
        const scanned = selected.slice(0, limit);
        if (scanned.some((row) => row.payloadBytes > maxPayloadBytes))
          throw new BackgroundJobError(
            'E_JOB_INPUT_INVALID',
            'Candidate payload exceeds the explicit byte cap; no complete inventory is available',
          );
        execution.consume({
          items: scanned.length,
          bytes: scanned.reduce((total, row) => total + row.payloadBytes, 0),
        });
        const rows = scanned.length
          ? this.#db
              .select()
              .from(backgroundJobs)
              .where(
                and(
                  this.#scope(),
                  eq(columns.operation, query.operation),
                  inArray(
                    columns.id,
                    scanned.map((row) => row.id),
                  ),
                ),
              )
              .orderBy(asc(columns.startedAt), asc(columns.id))
              .all()
          : [];
        const candidates = rows.map((row) => {
          execution.assertActive();
          return rowToJob(row);
        });
        const last = scanned.at(-1);
        return {
          candidates,
          scope,
          scannedCount: scanned.length,
          hasMoreCandidates: selected.length > limit,
          nextCursor:
            selected.length > limit && last
              ? { ...scope, startedAt: last.startedAt, id: last.id }
              : null,
          matchingTotal: null,
          observation: 'per-page-snapshot',
          principalValidation: 'domain-required',
        };
      },
      execution.deadlineAt,
      undefined,
      () => execution.assertActive(),
      true,
    );
  }

  /**
   * Claim authentic unstarted work or reclaim an explicitly expired lease.
   * @param id - Existing job identity.
   * @param now - Claim timestamp.
   * @param maxRunning - Optional capacity limit enforced atomically with the claim.
   * @param execution - Optional original invocation budget; supplying it adds scoped cancellation and deadline checks.
   * @returns New attempt's lease.
   * @remarks Preserves checkpoint and cancellation request. Pending work must have
   * authentic hash-matching inputs and no prior execution; ambiguous legacy rows refuse.
   * @example
   * ```ts
   * const lease = store.claim(expiredJob.id, Date.now());
   * ```
   */
  claim(
    id: string,
    now: number,
    maxRunning?: number,
    execution?: OperationExecutionContext,
  ): BackgroundJobLease {
    execution?.assertActive();
    const row = this.#write(
      () => {
        const prior = this.#row(id);
        const pending = prior?.status === 'pending';
        const problem = pending && prior ? pendingProposalProblem(prior) : null;
        if (
          !prior ||
          (pending
            ? problem !== null
            : prior.status !== 'running' ||
              prior.ownerId === null ||
              prior.leaseExpiresAt === null ||
              prior.leaseExpiresAt > Date.now())
        ) {
          throw new BackgroundJobError(
            'E_JOB_NOT_RECLAIMABLE',
            problem ?? 'Only explicitly expired ownership or authentic pending work may be claimed',
          );
        }
        this.#assertInvocation(execution, prior.operation, prior.projectId, prior.idempotencyKey);
        this.#requireCapacity(maxRunning, id);
        if (
          !Number.isSafeInteger(prior.fencingEpoch + 1) ||
          !Number.isSafeInteger(prior.attempts + 1)
        ) {
          throw new BackgroundJobError(
            'E_JOB_INPUT_INVALID',
            'Claim counter exhausted; explicit recovery is required',
          );
        }
        return this.#claimRow(prior, now);
      },
      execution?.deadlineAt,
      (message) => this.#committedCleanupFailures.set(id, message),
      () => execution?.assertActive(),
    );
    if (!row) throw new BackgroundJobError('E_JOB_LEASE_LOST', 'Claimed job disappeared');
    const grant = this.#grant(row);
    this.#grants.set(id, grant);
    return grant;
  }

  /** Assign the next owned epoch; terminal retry clears its retained previous outcome from the active row. */
  #claimRow(prior: BackgroundJobRow, now: number, terminalRetry = false) {
    return this.#db
      .update(backgroundJobs)
      .set({
        status: 'running',
        ownerId: this.#ownerId,
        claimedBy: this.#options.actor ?? null,
        fencingEpoch: prior.fencingEpoch + 1,
        attempts: prior.attempts + 1,
        heartbeatAt: now,
        leaseExpiresAt: Date.now() + this.leaseMs,
        ...(terminalRetry
          ? {
              completedAt: null,
              result: null,
              error: null,
              cancellationRequestedAt: null,
              progress: 0,
            }
          : {}),
      })
      .where(eq(backgroundJobs.id, prior.id))
      .returning()
      .get();
  }

  /**
   * Start an explicit new attempt after retaining terminal or expired owned work atomically.
   * @param id - Authentic failed, cancelled or explicitly expired owned job with the same immutable proposal.
   * @param now - New attempt timestamp.
   * @param execution - Fresh bounded invocation; expired contexts or old fences cannot be renewed.
   * @param retainOutcome - Trusted synchronous core callback that rechecks domain preconditions,
   * appends the complete previous row image, and verifies its receipt before returning.
   * @param maxRunning - Optional capacity limit enforced inside the same transaction.
   * @returns New owned lease, without reapplying any domain operation.
   * @throws BackgroundJobError when scope, terminal status, authentic input, counters, or receipt is invalid.
   * @remarks Complete jobs are never reopened. Expired running rows retain their authentic
   * uncertain outcome; expiry does not invent failure. Explicit resume acknowledges a retained
   * previous cancellation request and clears it only with the new claim. Callback failure, cancellation, or claim failure
   * rolls back both historical bookkeeping and the new claim. The caller must independently
   * preserve its append-only history in the same database; this is not an arbitrary callback sandbox.
   * @example
   * ```ts
   * const lease = store.retryAtomically(id, Date.now(), context, retainPreviousAttempt);
   * ```
   */
  retryAtomically(
    id: string,
    now: number,
    execution: OperationExecutionContext,
    retainOutcome: AtomicJobRetryBookkeeping,
    maxRunning?: number,
  ): BackgroundJobLease {
    execution.assertActive();
    if (execution.writeFence)
      throw new BackgroundJobError(
        'E_JOB_INPUT_INVALID',
        'Explicit retry requires a fresh invocation without an old attempt fence',
      );
    requireRunningLimit(maxRunning);
    if (!Number.isSafeInteger(now))
      throw new BackgroundJobError('E_JOB_INPUT_INVALID', 'Retry timestamp must be a safe integer');
    const row = this.#write(
      () => {
        const prior = this.#row(id);
        const expiredOwned =
          prior?.status === 'running' &&
          prior.ownerId !== null &&
          prior.leaseExpiresAt !== null &&
          prior.leaseExpiresAt <= Date.now();
        if (!prior || (prior.status !== 'failed' && prior.status !== 'cancelled' && !expiredOwned))
          throw new BackgroundJobError(
            'E_JOB_NOT_RECLAIMABLE',
            'Explicit retry requires terminal or expired owned work; committed effects cannot be reopened',
          );
        this.#assertInvocation(execution, prior.operation, prior.projectId, prior.idempotencyKey);
        if (
          !prior.proposalJson ||
          !prior.proposalHash ||
          createHash('sha256').update(prior.proposalJson).digest('hex') !== prior.proposalHash
        )
          throw new BackgroundJobError(
            'E_JOB_INPUT_INVALID',
            'Terminal retry requires authentic immutable proposal bytes',
          );
        if (
          !Number.isSafeInteger(prior.fencingEpoch + 1) ||
          !Number.isSafeInteger(prior.attempts + 1)
        )
          throw new BackgroundJobError('E_JOB_INPUT_INVALID', 'Retry counter exhausted');
        this.#requireCapacity(maxRunning, id);
        const receipt = retainOutcome(JSON.stringify(prior));
        if (typeof receipt !== 'string')
          throw new BackgroundJobError(
            'E_JOB_INPUT_INVALID',
            'Retry bookkeeping must return synchronous JSON receipt bytes',
          );
        requireJson(receipt);
        if (JSON.stringify(this.#row(id)) !== JSON.stringify(prior))
          throw new BackgroundJobError(
            'E_JOB_LEASE_LOST',
            'Retry bookkeeping changed the original job before its new claim',
          );
        execution.assertActive();
        return this.#claimRow(prior, now, true);
      },
      execution.deadlineAt,
      (message) => this.#committedCleanupFailures.set(id, message),
      () => execution.assertActive(),
    );
    if (!row) throw new BackgroundJobError('E_JOB_LEASE_LOST', 'Retried job disappeared');
    const grant = this.#grant(row);
    this.#grants.set(id, grant);
    return grant;
  }

  /**
   * Renew an owned lease and observe persisted cancellation.
   * @param id - Owned job identity.
   * @param now - Heartbeat timestamp.
   * @returns Current job including cancellation request.
   * @remarks Expired attempts cannot revive themselves through heartbeat.
   * @example
   * ```ts
   * const job = store.heartbeat(id, Date.now());
   * ```
   */
  heartbeat(id: string, now: number): BackgroundJob {
    return this.#write(() => {
      this.#owned(id);
      const row = this.#db
        .update(backgroundJobs)
        .set({ heartbeatAt: now, leaseExpiresAt: Date.now() + this.leaseMs })
        .where(eq(backgroundJobs.id, id))
        .returning()
        .get();
      if (!row) throw new BackgroundJobError('E_JOB_LEASE_LOST', 'Heartbeat target disappeared');
      return rowToJob(row);
    });
  }

  /**
   * Persist a checkpoint under the current attempt fence.
   * @param id - Owned job identity.
   * @param valueJson - Valid serialized checkpoint bytes.
   * @param now - Checkpoint timestamp.
   * @remarks Writes atomically with ownership verification; does not authorize domain writes.
   * @example
   * ```ts
   * store.checkpoint(id, JSON.stringify({ nextFile: 8 }), Date.now());
   * ```
   */
  checkpoint(id: string, valueJson: string, now: number): void {
    requireJson(valueJson);
    this.#write(() => {
      this.#owned(id);
      this.#db
        .update(backgroundJobs)
        .set({ checkpointJson: valueJson, checkpointAt: now })
        .where(eq(backgroundJobs.id, id))
        .run();
    });
  }

  /**
   * Request cancellation without claiming that execution has stopped.
   * @param id - Visible job identity.
   * @param now - Request timestamp.
   * @param execution - Optional original invocation context; never renews its deadline.
   * @returns Whether pending work was cancelled or running work has a persisted request.
   * @remarks Terminal results are preserved when cancellation arrives after commit.
   * @example
   * ```ts
   * const requested = store.requestCancel(id, Date.now());
   * ```
   */
  requestCancel(id: string, now: number, execution?: OperationExecutionContext): boolean {
    execution?.assertActive();
    return this.#write(
      () => {
        const row = this.#row(id);
        if (!row) return false;
        this.#assertInvocation(execution, row.operation, row.projectId, row.idempotencyKey);
        if (row.status !== 'running' && row.status !== 'pending') return false;
        if (row.status === 'pending') {
          const problem = pendingProposalProblem(row);
          if (problem) throw new BackgroundJobError('E_JOB_NOT_RECLAIMABLE', problem);
          this.#db
            .update(backgroundJobs)
            .set({ status: 'cancelled', cancellationRequestedAt: now, completedAt: now })
            .where(eq(backgroundJobs.id, id))
            .run();
          return true;
        }
        if (row.cancellationRequestedAt === null)
          this.#db
            .update(backgroundJobs)
            .set({ cancellationRequestedAt: now })
            .where(eq(backgroundJobs.id, id))
            .run();
        return true;
      },
      execution?.deadlineAt,
      (message) => this.#committedCleanupFailures.set(id, message),
      () => execution?.assertActive(),
    );
  }

  /**
   * Commit actual executor success under ownership.
   * @param id - Job identity.
   * @param result - Actual outcome.
   * @param now - Completion timestamp.
   * @remarks An earlier cancellation request does not erase work already committed.
   * @example
   * ```ts
   * store.complete(id, { verified: true }, Date.now());
   * ```
   */
  complete(id: string, result: unknown, now: number): void {
    const resultJson = result === undefined ? null : JSON.stringify(result);
    this.#write(() => {
      this.#owned(id);
      this.#completeRow(id, resultJson, now);
    });
    this.#grants.delete(id);
  }

  /**
   * Persist terminal data inside the already-owned transaction.
   * @param id - Job whose ownership was checked by the caller.
   * @param resultJson - Serialized outcome, or null for the legacy empty result.
   * @param now - Completion time in epoch milliseconds.
   */
  #completeRow(id: string, resultJson: string | null, now: number): void {
    this.#db.run(sql`UPDATE main.background_jobs SET status='complete',
      completed_at=${now}, result=${resultJson}, progress=100, heartbeat_at=${now}
      WHERE id=${id}`);
  }

  /**
   * Commit a synchronous domain mutation, its receipt and job completion atomically.
   * @param execution - Captured context carrying this client's current claimed fence.
   * @param mutation - Trusted synchronous domain operation returning JSON receipt bytes.
   * @returns Exact receipt bytes committed with the domain changes and terminal job row.
   * @throws BackgroundJobError when the transaction is borrowed, authority changed,
   * cancellation was observed before commit, or receipt bytes are invalid.
   * @remarks The store acquires its own write transaction; an ambient BEGIN confers
   * no authority. Domain code must independently validate its proposal and operate
   * only on the same SQLite database without transaction control or external effects.
   * Guards are cooperative boundaries, not preemption. Cancellation observed after
   * COMMIT cannot erase the committed result. Arbitrary async callbacks are unsupported.
   * @example
   * ```ts
   * const receiptJson = store.completeAtomically(execution, () => applyPreparedRepair());
   * ```
   */
  completeAtomically(execution: OperationExecutionContext, mutation: AtomicJobMutation): string {
    execution.assertActive();
    const fence = execution.writeFence;
    if (!fence) {
      throw new BackgroundJobError(
        'E_JOB_LEASE_LOST',
        'Atomic mutation requires a claimed job fence',
      );
    }
    const resultJson = this.#write(
      () => {
        this.#owned(fence.lease.jobId);
        assertOperationWriteFence(this.#db, execution);
        const receipt = mutation(execution);
        requireJson(receipt);
        assertOperationWriteFence(this.#db, execution);
        this.#completeRow(fence.lease.jobId, receipt, Date.now());
        assertOperationJobState(this.#db, execution, 'complete', receipt);
        execution.assertActive();
        return receipt;
      },
      execution.deadlineAt,
      (message) => this.#committedCleanupFailures.set(fence.lease.jobId, message),
    );
    this.#grants.delete(fence.lease.jobId);
    return resultJson;
  }

  /**
   * Finalize trusted receipt/event metadata and a failed or cancelled attempt atomically.
   * @param execution - Original bounded attempt identity and current ownership fence.
   * @param outcome - Sourced observed outcome; expiry alone cannot supply this fact.
   * @param bookkeeping - Synchronous metadata-only service callback returning JSON receipt bytes.
   * @returns Committed receipt or explicit pending finalization with actual elapsed time.
   * @remarks Cancellation allows bookkeeping only; domain repair remains forbidden.
   * An exhausted deadline never acquires a lock. Failed finalization preserves the
   * lease/checkpoint for inspection and a later explicit recovery attempt. No budget
   * is renewed, and synchronous SQLite completion is not preempted by a timer.
   * @example
   * ```ts
   * const result = store.finalizeAtomically(context, outcome, () => appendAttemptReceipt());
   * ```
   */
  finalizeAtomically(
    execution: OperationExecutionContext,
    outcome: JobAttemptOutcome,
    bookkeeping: AtomicJobBookkeeping,
  ): JobFinalizationResult {
    const startedAt = Date.now();
    let cleanupError: string | undefined;
    try {
      if (outcome.status !== 'failed' && outcome.status !== 'cancelled')
        throw new BackgroundJobError('E_JOB_INPUT_INVALID', 'Unsupported terminal attempt outcome');
      requireText(outcome.message, 'outcome.message');
      const fence = execution.writeFence;
      if (!fence)
        throw new BackgroundJobError(
          'E_JOB_LEASE_LOST',
          'Finalization requires a claimed job fence',
        );
      const resultJson = this.#write(
        () => {
          const row = this.#owned(fence.lease.jobId);
          assertOperationJobState(this.#db, execution, 'running', undefined, true);
          if (
            outcome.status === 'cancelled' &&
            row.cancellationRequestedAt === null &&
            !execution.signal.aborted
          )
            throw new BackgroundJobError(
              'E_JOB_INPUT_INVALID',
              'Cancellation has not been observed or requested',
            );
          const receipt = bookkeeping();
          requireJson(receipt);
          this.#owned(fence.lease.jobId);
          assertOperationJobState(this.#db, execution, 'running', undefined, true);
          const now = Date.now();
          this.#db.run(sql`UPDATE main.background_jobs SET status=${outcome.status},
          completed_at=${now}, result=${receipt}, error=${outcome.message}, heartbeat_at=${now}
          WHERE id=${fence.lease.jobId}`);
          assertOperationJobState(this.#db, execution, outcome.status, receipt, true, outcome);
          return receipt;
        },
        execution.deadlineAt,
        (message) => {
          cleanupError = message;
          this.#committedCleanupFailures.set(fence.lease.jobId, message);
        },
      );
      this.#grants.delete(fence.lease.jobId);
      return {
        state: 'finalized',
        resultJson,
        ...(cleanupError ? { cleanupError } : {}),
        elapsedMs: Date.now() - startedAt,
        deadlineExceeded: Date.now() >= execution.deadlineAt,
      };
    } catch (error) {
      return {
        state: 'pending-finalization',
        reason: String(error),
        elapsedMs: Date.now() - startedAt,
        deadlineExceeded: Date.now() >= execution.deadlineAt,
      };
    }
  }

  /**
   * Commit actual executor failure under ownership.
   * @param id - Job identity.
   * @param error - Failure message.
   * @param now - Failure timestamp.
   * @remarks Stale owners cannot replace a newer attempt's outcome.
   * @example
   * ```ts
   * store.fail(id, 'Verification failed', Date.now());
   * ```
   */
  fail(id: string, error: string, now: number): void {
    this.#write(() => {
      this.#owned(id);
      this.#db
        .update(backgroundJobs)
        .set({ status: 'failed', completedAt: now, error, heartbeatAt: now })
        .where(eq(backgroundJobs.id, id))
        .run();
    });
    this.#grants.delete(id);
  }

  /**
   * Acknowledge an executor's cancellation.
   * @param id - Owned job identity.
   * @param now - Acknowledgement timestamp.
   * @remarks Requires a persisted cancellation request and current ownership.
   * @example
   * ```ts
   * store.cancel(id, Date.now());
   * ```
   */
  cancel(id: string, now: number): void {
    this.#write(() => {
      const row = this.#owned(id);
      if (row.cancellationRequestedAt === null)
        throw new BackgroundJobError(
          'E_JOB_INPUT_INVALID',
          'Cancellation must be requested before acknowledgement',
        );
      this.#db
        .update(backgroundJobs)
        .set({ status: 'cancelled', completedAt: now, heartbeatAt: now })
        .where(eq(backgroundJobs.id, id))
        .run();
    });
    this.#grants.delete(id);
  }

  /**
   * Update an owned attempt's progress.
   * @param id - Job identity.
   * @param progress - Finite percentage, clamped to zero through one hundred.
   * @param now - Observation timestamp.
   * @remarks Progress does not renew an expired lease or overwrite another owner.
   * @example
   * ```ts
   * store.progress(id, 50, Date.now());
   * ```
   */
  progress(id: string, progress: number, now: number): void {
    if (!Number.isFinite(progress))
      throw new BackgroundJobError('E_JOB_INPUT_INVALID', 'Progress must be finite');
    this.#write(() => {
      this.#owned(id);
      this.#db
        .update(backgroundJobs)
        .set({ progress: Math.max(0, Math.min(100, progress)), heartbeatAt: now })
        .where(eq(backgroundJobs.id, id))
        .run();
    });
  }

  /**
   * Retain historical job evidence regardless of age.
   * @param _cutoffMs - Former deletion threshold, retained for API compatibility.
   * @returns Zero; any future deletion requires explicit evidence-aware recovery policy.
   * @remarks No automatic or age-only pruning is performed.
   * @example
   * ```ts
   * const removed = store.purgeOlderThan(Date.now()); // 0
   * ```
   */
  purgeOlderThan(_cutoffMs: number): number {
    return 0;
  }
}

/**
 * Existing executor facade with persisted ownership and cooperative cancellation.
 * @remarks Executors must use a separately authorized transactional service for
 * domain changes and receipts; this class fences only job metadata/checkpoints.
 * @example
 * ```ts
 * const manager = new BackgroundJobManager(db, { projectId: 'project-uuid' });
 * const id = await manager.startJob('inspect', async ({ signal }) => ({ cancelled: signal.aborted }));
 * ```
 */
export class BackgroundJobManager {
  readonly #store: DurableJobStore;
  readonly #abortControllers = new Map<string, AbortController>();
  readonly #heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  readonly #diagnostics = new Map<string, string>();
  readonly #maxJobs: number;

  /**
   * Open the existing facade.
   * @param db - Canonical store.
   * @param config - Scope and lease configuration.
   * @remarks Construction does not orphan or execute persisted work.
   * @example
   * ```ts
   * const manager = new BackgroundJobManager(db, { projectId: 'project-uuid' });
   * ```
   */
  constructor(db: NodeSQLiteDatabase, config?: BackgroundJobManagerConfig) {
    this.#store = new DurableJobStore(db, config);
    this.#maxJobs = config?.maxJobs ?? 10;
  }

  /**
   * Start new work or coalesce an identical immutable submission.
   * @param operation - Supported operation.
   * @param executor - Existing executor, now given cancellation and checkpoint capabilities.
   * @param submission - Optional scoped retry identity.
   * @returns New or already persisted job identity.
   * @remarks Repeated submissions never invoke a second executor.
   * @example
   * ```ts
   * const id = await manager.startJob('inspect', async () => ({ verified: true }), submission);
   * ```
   */
  async startJob(
    operation: string,
    executor: (context: BackgroundJobExecutionContext) => Promise<unknown>,
    submission?: BackgroundJobSubmission,
  ): Promise<string> {
    const id = randomUUID();
    const lease = this.#store.insert(id, operation, Date.now(), submission, this.#maxJobs);
    if (!lease) {
      const existing = submission && this.#store.findSubmission(operation, submission);
      if (!existing)
        throw new BackgroundJobError('E_JOB_LEASE_LOST', 'Coalesced job is unavailable');
      return existing.id;
    }
    this.#launch(lease, executor);
    return id;
  }

  /**
   * Record optional work durably without scheduling an executor or model.
   * @param operation - Supported action validated by the calling domain service.
   * @param submission - Authentic scoped proposal bytes for explicit later resume.
   * @returns Existing or newly persisted job identity.
   * @remarks This does not establish completion of the optional projection or a
   * domain repair receipt. Explicit resume must validate current prerequisites.
   * @example
   * ```ts
   * const id = manager.deferJob('docs.projection', submission);
   * ```
   */
  deferJob(operation: string, submission: BackgroundJobSubmission): string {
    return this.#store.defer(randomUUID(), operation, Date.now(), submission).id;
  }

  /**
   * Explicitly start pending work or resume expired ownership using the existing facade.
   * @param id - Expired job identity.
   * @param executor - Executor capable of resuming its persisted checkpoint.
   * @returns Identity of the resumed job.
   * @remarks The earlier owner is fenced before a replacement executor can run.
   * @example
   * ```ts
   * await manager.resumeJob(id, async ({ checkpoint }) => { checkpoint('{}'); });
   * ```
   */
  async resumeJob(
    id: string,
    executor: (context: BackgroundJobExecutionContext) => Promise<unknown>,
  ): Promise<string> {
    const lease = this.#store.claim(id, Date.now(), this.#maxJobs);
    this.#launch(lease, executor);
    return id;
  }

  #launch(
    lease: BackgroundJobLease,
    executor: (context: BackgroundJobExecutionContext) => Promise<unknown>,
  ): void {
    const controller = new AbortController();
    this.#abortControllers.set(lease.jobId, controller);
    if (this.#store.get(lease.jobId)?.cancellationRequestedAt !== null) controller.abort();
    const timer = setInterval(
      () => {
        try {
          const job = this.#store.heartbeat(lease.jobId, Date.now());
          if (job.cancellationRequestedAt !== null) controller.abort();
        } catch (error) {
          this.#diagnostics.set(
            lease.jobId,
            error instanceof Error ? error.message : String(error),
          );
          controller.abort();
        }
      },
      Math.max(1, Math.floor(this.#store.leaseMs / 3)),
    );
    timer.unref();
    this.#heartbeatTimers.set(lease.jobId, timer);
    void this.#executeJob(lease, executor, controller.signal);
  }

  /**
   * Read persisted state and local diagnostic failures.
   * @param id - Job identity.
   * @returns Job or undefined.
   * @remarks Persistence errors are disclosed separately from a committed outcome.
   * @example
   * ```ts
   * const job = manager.getJob(id);
   * ```
   */
  getJob(id: string): BackgroundJob | undefined {
    const job = this.#store.get(id);
    const error = this.#diagnostics.get(id);
    if (job && error) job.diagnosticError = error;
    return job;
  }
  /**
   * List persisted scoped jobs.
   * @param status - Optional lifecycle filter.
   * @returns Matching jobs.
   * @remarks Includes cancellation requests and local diagnostic failures.
   * @example
   * ```ts
   * const jobs = manager.listJobs('running');
   * ```
   */
  listJobs(status?: string): BackgroundJob[] {
    return this.#store.list(status).map((job) => this.getJob(job.id) ?? job);
  }

  /**
   * Request cancellation of visible running work.
   * @param id - Job identity.
   * @returns Whether the request was recorded, not proof of termination.
   * @remarks Other owners observe the durable request on heartbeat.
   * @example
   * ```ts
   * const requested = manager.cancelJob(id);
   * ```
   */
  cancelJob(id: string): boolean {
    const requested = this.#store.requestCancel(id, Date.now());
    if (requested) this.#abortControllers.get(id)?.abort();
    return requested;
  }
  /**
   * Report progress from an owned executor.
   * @param id - Job identity.
   * @param progress - Finite percentage.
   * @returns Whether the job exists and is running.
   * @remarks A visible job owned by another attempt is explicitly refused.
   * @example
   * ```ts
   * manager.updateProgress(id, 50);
   * ```
   */
  updateProgress(id: string, progress: number): boolean {
    const job = this.#store.get(id);
    if (!job || job.status !== 'running') return false;
    this.#store.progress(id, progress, Date.now());
    return true;
  }
  /**
   * Preserve historical evidence.
   * @returns Zero rows removed.
   * @remarks Age alone never authorizes deletion of job evidence.
   * @example
   * ```ts
   * const removed = manager.cleanup(); // 0
   * ```
   */
  cleanup(): number {
    return 0;
  }

  /**
   * Request cancellation only for this manager's executors and stop its timers.
   * @remarks Does not claim non-cooperative executors stopped or alter another owner.
   * @example
   * ```ts
   * manager.destroy(); // inspect persisted cancellation/completion separately
   * ```
   */
  destroy(): void {
    for (const [id, controller] of this.#abortControllers) {
      try {
        this.#store.requestCancel(id, Date.now());
      } catch (error) {
        this.#diagnostics.set(id, error instanceof Error ? error.message : String(error));
      }
      controller.abort();
    }
    for (const timer of this.#heartbeatTimers.values()) clearInterval(timer);
    this.#heartbeatTimers.clear();
  }

  async #executeJob(
    lease: BackgroundJobLease,
    executor: (context: BackgroundJobExecutionContext) => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      if (signal.aborted) {
        this.#store.cancel(lease.jobId, Date.now());
        return;
      }
      const result = await executor({
        signal,
        lease,
        checkpoint: (value) => this.#store.checkpoint(lease.jobId, value, Date.now()),
      });
      // A resolved executor reports actual completion, even if cancellation arrived
      // after its commit. Only an acknowledged abort establishes cancelled status.
      this.#store.complete(lease.jobId, result, Date.now());
    } catch (error) {
      try {
        if (signal.aborted && error instanceof Error && error.name === 'AbortError')
          this.#store.cancel(lease.jobId, Date.now());
        else
          this.#store.fail(
            lease.jobId,
            error instanceof Error ? error.message : String(error),
            Date.now(),
          );
      } catch (persistenceError) {
        this.#diagnostics.set(
          lease.jobId,
          persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
        );
      }
    } finally {
      const timer = this.#heartbeatTimers.get(lease.jobId);
      if (timer) clearInterval(timer);
      this.#heartbeatTimers.delete(lease.jobId);
      this.#abortControllers.delete(lease.jobId);
    }
  }
}
