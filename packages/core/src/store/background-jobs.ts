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
  BackgroundJobExecutionContext,
  BackgroundJobFailureCode,
  BackgroundJobLease,
  BackgroundJobStoreOptions,
  BackgroundJobSubmission,
  OperationExecutionContext,
} from '@cleocode/contracts/jobs';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
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
  execution.assertActive();
  const fence = execution.writeFence;
  if (!fence) return;
  const row = db
    .select({ proposalJson: sql<string | null>`${backgroundJobs.proposalJson}` })
    .from(sql`main.${backgroundJobs}`)
    .where(
      and(
        eq(backgroundJobs.id, fence.lease.jobId),
        eq(backgroundJobs.status, 'running'),
        eq(backgroundJobs.ownerId, fence.lease.ownerId),
        eq(backgroundJobs.fencingEpoch, fence.lease.epoch),
        gt(backgroundJobs.leaseExpiresAt, Date.now()),
        isNull(backgroundJobs.cancellationRequestedAt),
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
    createHash('sha256').update(row.proposalJson).digest('hex') !== fence.proposalHash
  ) {
    throw new BackgroundJobError(
      'E_JOB_LEASE_LOST',
      'Domain write refused: job authority or proposal no longer matches the captured attempt',
    );
  }
}

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
    return this.#db
      .select()
      .from(backgroundJobs)
      .where(and(eq(backgroundJobs.id, id), this.#scope()))
      .get();
  }

  #write<T>(operation: () => T): T {
    // BEGIN outside the rollback scope: failure must never roll back another caller.
    try {
      this.#db.run(sql`BEGIN IMMEDIATE`);
    } catch (error) {
      if (error instanceof Error && /within a transaction/i.test(String(error.cause ?? error))) {
        throw new BackgroundJobError(
          'E_JOB_TRANSACTION_OWNED',
          'Job write refused: another caller owns the native transaction',
        );
      }
      throw error;
    }
    try {
      const value = operation();
      this.#db.run(sql`COMMIT`);
      return value;
    } catch (error) {
      this.#db.run(sql`ROLLBACK`);
      throw error;
    }
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

  /** Atomically coalesce or insert complete immutable proposal state. */
  #submit(
    id: string,
    operation: string,
    now: number,
    submission: BackgroundJobSubmission | undefined,
    status: 'pending' | 'running',
    maxRunning?: number,
  ) {
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
    return this.#write(() => {
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
    });
  }

  /**
   * Persist authentic pending work without claiming or starting an executor.
   * @param id - Proposed job identity; matching retries retain the original identity.
   * @param operation - Exact operation whose supported inputs the domain service validates.
   * @param now - Submission timestamp in epoch milliseconds.
   * @param submission - Required project-scoped immutable serialized proposal.
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
  ): BackgroundJob {
    if (!submission)
      throw new BackgroundJobError(
        'E_JOB_INPUT_INVALID',
        'Pending work requires a scoped proposal',
      );
    return rowToJob(this.#submit(id, operation, now, submission, 'pending').row);
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
    return row ? rowToJob(row) : undefined;
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
   * Claim authentic unstarted work or reclaim an explicitly expired lease.
   * @param id - Existing job identity.
   * @param now - Claim timestamp.
   * @param maxRunning - Optional capacity limit enforced atomically with the claim.
   * @returns New attempt's lease.
   * @remarks Preserves checkpoint and cancellation request. Pending work must have
   * authentic hash-matching inputs and no prior execution; ambiguous legacy rows refuse.
   * @example
   * ```ts
   * const lease = store.claim(expiredJob.id, Date.now());
   * ```
   */
  claim(id: string, now: number, maxRunning?: number): BackgroundJobLease {
    const row = this.#write(() => {
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
        })
        .where(eq(backgroundJobs.id, id))
        .returning()
        .get();
    });
    if (!row) throw new BackgroundJobError('E_JOB_LEASE_LOST', 'Claimed job disappeared');
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
   * @returns Whether pending work was cancelled or running work has a persisted request.
   * @remarks Terminal results are preserved when cancellation arrives after commit.
   * @example
   * ```ts
   * const requested = store.requestCancel(id, Date.now());
   * ```
   */
  requestCancel(id: string, now: number): boolean {
    return this.#write(() => {
      const row = this.#row(id);
      if (!row || (row.status !== 'running' && row.status !== 'pending')) return false;
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
    });
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
      this.#db
        .update(backgroundJobs)
        .set({
          status: 'complete',
          completedAt: now,
          result: resultJson,
          progress: 100,
          heartbeatAt: now,
        })
        .where(eq(backgroundJobs.id, id))
        .run();
    });
    this.#grants.delete(id);
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
