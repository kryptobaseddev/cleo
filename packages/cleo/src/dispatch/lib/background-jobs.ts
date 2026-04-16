/**
 * Background Job Manager for Long-Running Operations
 *
 * Operations that may take >30s support async execution. This module
 * provides a job manager backed by a SQLite DurableJobStore so that job
 * state survives process restart.  Any job recorded as `running` in the
 * database at construction time is immediately transitioned to `orphaned`
 * so that humans/agents can triage it — no silent retry.
 *
 * @task T641
 */

import type { NodeSQLiteDatabase } from '@cleocode/core/store/sqlite';
import type * as schema from '@cleocode/core/store/tasks-schema';
import {
  type BackgroundJobRow,
  type BackgroundJobStatus,
  backgroundJobs,
  type NewBackgroundJobRow,
} from '@cleocode/core/store/tasks-schema';
import { randomUUID } from 'crypto';
import { eq, inArray } from 'drizzle-orm';

// Re-export for callers that import the type from this module.
export type { BackgroundJobStatus };

/**
 * Background job representation returned by public API methods.
 *
 * Timestamps are ISO-8601 strings so callers do not need to know that the
 * database stores them as integer milliseconds.
 */
export interface BackgroundJob {
  /** Unique job identifier (UUID v4). */
  id: string;
  /** Operation name, e.g. "nexus.analyze". */
  operation: string;
  /** Current lifecycle status. */
  status: BackgroundJobStatus;
  /** ISO-8601 timestamp of when the job started. */
  startedAt: string;
  /** ISO-8601 timestamp of when the job finished; undefined while running. */
  completedAt?: string;
  /** JSON-serialised result; undefined on failure or while running. */
  result?: unknown;
  /** Error message; undefined on success or while running. */
  error?: string;
  /** Progress 0-100; undefined until reported. */
  progress?: number;
  /** Agent or session that claimed this job; undefined if unclaimed. */
  claimedBy?: string;
}

/**
 * Configuration for {@link BackgroundJobManager}.
 */
export interface BackgroundJobManagerConfig {
  /** Maximum number of concurrently *running* jobs. Default: 10. */
  maxJobs?: number;
  /** How long (ms) to retain completed/failed/cancelled jobs. Default: 3 600 000 (1 h). */
  retentionMs?: number;
}

// ---------------------------------------------------------------------------
// Row ↔ domain model helpers
// ---------------------------------------------------------------------------

/** Convert a {@link BackgroundJobRow} (from DB) to the public {@link BackgroundJob}. */
function rowToJob(row: BackgroundJobRow): BackgroundJob {
  const job: BackgroundJob = {
    id: row.id,
    operation: row.operation,
    status: row.status as BackgroundJobStatus,
    startedAt: new Date(row.startedAt).toISOString(),
  };

  if (row.completedAt !== null && row.completedAt !== undefined) {
    job.completedAt = new Date(row.completedAt).toISOString();
  }

  if (row.result !== null && row.result !== undefined) {
    try {
      job.result = JSON.parse(row.result) as unknown;
    } catch {
      job.result = row.result;
    }
  }

  if (row.error !== null && row.error !== undefined) {
    job.error = row.error;
  }

  if (row.progress !== null && row.progress !== undefined) {
    job.progress = row.progress;
  }

  if (row.claimedBy !== null && row.claimedBy !== undefined) {
    job.claimedBy = row.claimedBy;
  }

  return job;
}

// ---------------------------------------------------------------------------
// DurableJobStore — thin Drizzle-backed persistence layer
// ---------------------------------------------------------------------------

type TasksDb = NodeSQLiteDatabase<typeof schema>;

/**
 * Drizzle-backed persistence layer for background jobs.
 *
 * On construction the store scans for `running` rows left by a prior
 * process and marks them `orphaned`.  All reads and writes go through
 * Drizzle — no raw SQL strings.
 *
 * @task T641
 */
export class DurableJobStore {
  readonly #db: TasksDb;

  constructor(db: TasksDb) {
    this.#db = db;
    this.#orphanStaleJobs();
  }

  /**
   * Transition all `running` rows to `orphaned`.
   *
   * Called once at startup so abandoned jobs surface via {@link listJobs}
   * rather than being silently retried.
   */
  #orphanStaleJobs(): void {
    const now = Date.now();
    this.#db
      .update(backgroundJobs)
      .set({
        status: 'orphaned',
        completedAt: now,
        error: 'process-exited-before-completion',
      })
      .where(eq(backgroundJobs.status, 'running'))
      .run();
  }

  /**
   * Insert a new job row with `running` status.
   *
   * @param id        - UUID for the job
   * @param operation - Operation name
   * @param now       - Current timestamp in ms
   */
  insert(id: string, operation: string, now: number): void {
    const row: NewBackgroundJobRow = {
      id,
      operation,
      status: 'running',
      startedAt: now,
      heartbeatAt: now,
    };
    this.#db.insert(backgroundJobs).values(row).run();
  }

  /**
   * Retrieve a single job by ID.  Returns `undefined` if not found.
   */
  get(id: string): BackgroundJob | undefined {
    const rows = this.#db.select().from(backgroundJobs).where(eq(backgroundJobs.id, id)).all();
    const row = rows[0];
    return row === undefined ? undefined : rowToJob(row);
  }

  /**
   * Retrieve all jobs, optionally filtered by status.
   */
  list(status?: string): BackgroundJob[] {
    const rows = status
      ? this.#db
          .select()
          .from(backgroundJobs)
          .where(eq(backgroundJobs.status, status as BackgroundJobStatus))
          .all()
      : this.#db.select().from(backgroundJobs).all();
    return rows.map(rowToJob);
  }

  /**
   * Mark a job as `complete` with an optional result payload.
   */
  complete(id: string, result: unknown, now: number): void {
    this.#db
      .update(backgroundJobs)
      .set({
        status: 'complete',
        completedAt: now,
        result: result !== undefined ? JSON.stringify(result) : null,
        progress: 100,
        heartbeatAt: now,
      })
      .where(eq(backgroundJobs.id, id))
      .run();
  }

  /**
   * Mark a job as `failed` with an error message.
   */
  fail(id: string, error: string, now: number): void {
    this.#db
      .update(backgroundJobs)
      .set({
        status: 'failed',
        completedAt: now,
        error,
        heartbeatAt: now,
      })
      .where(eq(backgroundJobs.id, id))
      .run();
  }

  /**
   * Mark a job as `cancelled`.
   */
  cancel(id: string, now: number): void {
    this.#db
      .update(backgroundJobs)
      .set({
        status: 'cancelled',
        completedAt: now,
        heartbeatAt: now,
      })
      .where(eq(backgroundJobs.id, id))
      .run();
  }

  /**
   * Update the progress (0-100) and heartbeat of a running job.
   */
  progress(id: string, progress: number, now: number): void {
    this.#db
      .update(backgroundJobs)
      .set({
        progress: Math.max(0, Math.min(100, progress)),
        heartbeatAt: now,
      })
      .where(eq(backgroundJobs.id, id))
      .run();
  }

  /**
   * Delete terminal (complete/failed/cancelled/orphaned) jobs whose
   * `completedAt` is older than `cutoffMs`.
   *
   * @returns Number of rows deleted.
   */
  purgeOlderThan(cutoffMs: number): number {
    const terminalStatuses: BackgroundJobStatus[] = ['complete', 'failed', 'cancelled', 'orphaned'];
    const rows = this.#db
      .select({ id: backgroundJobs.id, completedAt: backgroundJobs.completedAt })
      .from(backgroundJobs)
      .where(inArray(backgroundJobs.status, terminalStatuses))
      .all();

    const staleIds = rows
      .filter(
        (r) => r.completedAt !== null && r.completedAt !== undefined && r.completedAt < cutoffMs,
      )
      .map((r) => r.id);

    if (staleIds.length === 0) {
      return 0;
    }

    this.#db.delete(backgroundJobs).where(inArray(backgroundJobs.id, staleIds)).run();
    return staleIds.length;
  }
}

// ---------------------------------------------------------------------------
// BackgroundJobManager — public façade (same interface as before T641)
// ---------------------------------------------------------------------------

/**
 * Manages background jobs for long-running operations.
 *
 * Backed by a {@link DurableJobStore} so job state persists across process
 * restarts.  The public interface is identical to the previous in-memory
 * implementation so {@link job-manager-accessor} does not change.
 *
 * @task T641
 */
export class BackgroundJobManager {
  readonly #store: DurableJobStore;
  readonly #abortControllers: Map<string, AbortController>;
  readonly #maxJobs: number;
  readonly #retentionMs: number;
  #cleanupTimer: ReturnType<typeof setInterval> | null;

  constructor(db: TasksDb, config?: BackgroundJobManagerConfig) {
    this.#store = new DurableJobStore(db);
    this.#abortControllers = new Map();
    this.#maxJobs = config?.maxJobs ?? 10;
    this.#retentionMs = config?.retentionMs ?? 3_600_000; // 1 hour default
    this.#cleanupTimer = null;

    // Start periodic cleanup every 5 minutes
    this.#cleanupTimer = setInterval(() => this.cleanup(), 300_000);
    // Don't prevent process exit
    if (this.#cleanupTimer.unref) {
      this.#cleanupTimer.unref();
    }
  }

  /**
   * Start a new background job.
   *
   * @param operation - The operation identifier (e.g. "nexus.analyze")
   * @param executor  - Async function to execute in the background
   * @returns The job ID
   * @throws Error if the maximum number of concurrent running jobs is reached
   */
  async startJob(operation: string, executor: () => Promise<unknown>): Promise<string> {
    // Check concurrent job limit (only count running jobs)
    const runningCount = this.listJobs('running').length;
    if (runningCount >= this.#maxJobs) {
      throw new Error(
        `Maximum concurrent jobs reached (${this.#maxJobs}). Cancel or wait for existing jobs to complete.`,
      );
    }

    const jobId = randomUUID();
    const abortController = new AbortController();
    const now = Date.now();

    this.#store.insert(jobId, operation, now);
    this.#abortControllers.set(jobId, abortController);

    // Execute async — do not await
    void this.#executeJob(jobId, executor, abortController.signal);

    return jobId;
  }

  /**
   * Get a specific job by ID.
   *
   * @returns The job or `undefined` if not found.
   */
  getJob(jobId: string): BackgroundJob | undefined {
    return this.#store.get(jobId);
  }

  /**
   * List all jobs, optionally filtered by status.
   *
   * @param status - Optional status filter string.
   * @returns Array of matching jobs.
   */
  listJobs(status?: string): BackgroundJob[] {
    return this.#store.list(status);
  }

  /**
   * Cancel a running job.
   *
   * @returns `true` if the job was cancelled; `false` if not found or not running.
   */
  cancelJob(jobId: string): boolean {
    const job = this.#store.get(jobId);
    if (!job || job.status !== 'running') {
      return false;
    }

    const controller = this.#abortControllers.get(jobId);
    if (controller) {
      controller.abort();
      this.#abortControllers.delete(jobId);
    }

    this.#store.cancel(jobId, Date.now());
    return true;
  }

  /**
   * Update the progress of a running job (0-100).
   *
   * @returns `true` if updated; `false` if the job is not found or not running.
   */
  updateProgress(jobId: string, progress: number): boolean {
    const job = this.#store.get(jobId);
    if (!job || job.status !== 'running') {
      return false;
    }
    this.#store.progress(jobId, progress, Date.now());
    return true;
  }

  /**
   * Delete completed/failed/cancelled/orphaned jobs past the retention window.
   *
   * @returns Number of jobs removed.
   */
  cleanup(): number {
    const cutoff = Date.now() - this.#retentionMs;
    return this.#store.purgeOlderThan(cutoff);
  }

  /**
   * Destroy the manager: cancel all in-process running jobs and stop the
   * cleanup timer.  Does NOT purge DB rows — orphaned jobs must be reviewed.
   */
  destroy(): void {
    const now = Date.now();
    for (const runningJob of this.listJobs('running')) {
      const controller = this.#abortControllers.get(runningJob.id);
      if (controller) {
        controller.abort();
      }
      // Persist orphaned status for any jobs still running in this process
      this.#store.fail(runningJob.id, 'manager-destroyed', now);
    }

    this.#abortControllers.clear();

    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
  }

  /**
   * Execute a job's executor function and persist the outcome.
   */
  async #executeJob(
    jobId: string,
    executor: () => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    const job = this.#store.get(jobId);
    if (!job) {
      return;
    }

    try {
      const result = await executor();

      // Check if cancelled during execution
      if (signal.aborted) {
        return;
      }

      this.#store.complete(jobId, result, Date.now());
    } catch (error) {
      // Check if this was a cancellation
      if (signal.aborted) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.#store.fail(jobId, message, Date.now());
    } finally {
      this.#abortControllers.delete(jobId);
    }
  }
}
