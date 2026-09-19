/**
 * Background job tables: background_jobs.
 *
 * @task T641
 */

import type { BackgroundJobStatus } from '@cleocode/contracts/jobs';
import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * Background job status enum values.
 *
 * - `pending`   – queued but not yet executing
 * - `running`   – actively executing in this process
 * - `complete`  – finished successfully
 * - `failed`    – finished with an error
 * - `cancelled` – explicitly cancelled by a caller
 * - `orphaned`  – was `running` when the process exited; requires human/agent review
 */
export const BACKGROUND_JOB_STATUSES = [
  'pending',
  'running',
  'complete',
  'failed',
  'cancelled',
  'orphaned',
] as const;

/**
 * Union type for {@link BACKGROUND_JOB_STATUSES}.
 *
 * Promoted to `@cleocode/contracts/jobs` in Phase 0c of the SG-ARCH-SOLID
 * Saga (T9955). Re-exported here for backward compatibility with every
 * `import { BackgroundJobStatus } from '@cleocode/core/store/tasks-schema'`
 * consumer.
 */
export type { BackgroundJobStatus };

/**
 * Durable background job row stored in tasks.db.
 *
 * This is the established active runtime table. The separately retained
 * tasks_background_jobs history uses a different timestamp encoding; no implicit
 * cutover or historical repair is performed here. Opening a client preserves rows.
 *
 * @task T641
 */
export const backgroundJobs = sqliteTable(
  'background_jobs',
  {
    /** Unique job identifier (UUID v4). */
    id: text('id').primaryKey(),
    /** Operation name, e.g. "nexus.analyze" or "tasks.sync.reconcile". */
    operation: text('operation').notNull(),
    /** Current lifecycle status. */
    status: text('status', { enum: BACKGROUND_JOB_STATUSES }).notNull().default('pending'),
    /** When the job was created (ms epoch). */
    startedAt: integer('started_at').notNull(),
    /** When the job finished (ms epoch); NULL while running. */
    completedAt: integer('completed_at'),
    /** JSON-serialised result payload; NULL on failure or while running. */
    result: text('result'),
    /** Human-readable error message; NULL on success or while running. */
    error: text('error'),
    /** Execution progress 0-100; NULL until progress is reported. */
    progress: integer('progress'),
    /** Last heartbeat timestamp (ms epoch). */
    heartbeatAt: integer('heartbeat_at').notNull(),
    /** Agent or session ID that claimed this job; NULL if unclaimed. */
    claimedBy: text('claimed_by'),
    /** Explicit project identity; NULL denotes unresolved legacy scope. */
    projectId: text('project_id'),
    /** Unique current client identity; NULL denotes unowned legacy work. */
    ownerId: text('owner_id'),
    /** Epoch-ms lease expiration; NULL must not be inferred as expired ownership. */
    leaseExpiresAt: integer('lease_expires_at'),
    /** Monotonic attempt fence; older owners cannot publish results. */
    fencingEpoch: integer('fencing_epoch').notNull().default(0),
    /** Number of issued execution claims. */
    attempts: integer('attempts').notNull().default(0),
    /** Epoch-ms cancellation request; not proof the executor has stopped. */
    cancellationRequestedAt: integer('cancellation_requested_at'),
    /** JSON checkpoint retained across an expired-attempt reclaim. */
    checkpointJson: text('checkpoint_json'),
    /** Last fenced checkpoint timestamp, in epoch milliseconds. */
    checkpointAt: integer('checkpoint_at'),
    /** Caller retry identity, scoped by project and operation. */
    idempotencyKey: text('idempotency_key'),
    /** SHA-256 of the immutable submitted proposal bytes. */
    proposalHash: text('proposal_hash'),
  },
  (table) => [
    index('idx_background_jobs_status').on(table.status),
    index('idx_background_jobs_operation').on(table.operation),
    index('idx_background_jobs_claimed_by').on(table.claimedBy),
    index('idx_background_jobs_started_at').on(table.startedAt),
    unique('uq_background_jobs_scoped_idempotency').on(
      table.projectId,
      table.operation,
      table.idempotencyKey,
    ),
  ],
);

// === TYPE EXPORTS ===

export type BackgroundJobRow = typeof backgroundJobs.$inferSelect;
export type NewBackgroundJobRow = typeof backgroundJobs.$inferInsert;
