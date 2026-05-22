/**
 * Background job tables: background_jobs.
 *
 * @task T641
 */

import type { BackgroundJobStatus } from '@cleocode/contracts/jobs';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
 * Jobs survive process restart; any row with `status='running'` at startup
 * is transitioned to `status='orphaned'` so humans/agents can triage them.
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
  },
  (table) => [
    index('idx_background_jobs_status').on(table.status),
    index('idx_background_jobs_operation').on(table.operation),
    index('idx_background_jobs_claimed_by').on(table.claimedBy),
    index('idx_background_jobs_started_at').on(table.startedAt),
  ],
);

// === TYPE EXPORTS ===

export type BackgroundJobRow = typeof backgroundJobs.$inferSelect;
export type NewBackgroundJobRow = typeof backgroundJobs.$inferInsert;
