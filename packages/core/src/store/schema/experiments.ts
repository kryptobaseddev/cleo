/**
 * Experiments side-table: experiments.
 *
 * @task T944
 */

import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { tasks } from './tasks.js';

/**
 * Experiment metadata side-table, keyed 1:1 to `tasks.id` for rows where
 * `tasks.role='experiment'`.
 *
 * Tracks sandbox/branch state and metrics delta for experimental work so the
 * main `tasks` table stays clean and sparse. Cascades on task deletion.
 *
 * @task T944
 */
export const experiments = sqliteTable(
  'experiments',
  {
    /** Owning task ID. Primary key + cascade FK to {@link tasks}. */
    taskId: text('task_id')
      .primaryKey()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Git branch used as the experiment sandbox (nullable until created). */
    sandboxBranch: text('sandbox_branch'),
    /** Baseline commit SHA the experiment forked from. */
    baselineCommit: text('baseline_commit'),
    /** ISO 8601 timestamp when the experiment merged back (null = open). */
    mergedAt: text('merged_at'),
    /** Optional receipt ID linking to an audit/receipt record. */
    receiptId: text('receipt_id'),
    /** JSON-serialised metrics delta between baseline and experiment. */
    metricsDeltaJson: text('metrics_delta_json'),
    /** ISO 8601 timestamp of row creation. */
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    /** ISO 8601 timestamp of last update. */
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_experiments_merged').on(table.mergedAt)],
);

// === TYPE EXPORTS ===

export type ExperimentRow = typeof experiments.$inferSelect;
export type NewExperimentRow = typeof experiments.$inferInsert;
