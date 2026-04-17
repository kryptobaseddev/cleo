/**
 * Drizzle ORM table definitions for playbook state.
 * Both tables are added to tasks.db via migration at
 * packages/core/migrations/drizzle-tasks/20260417220000_t889-playbook-tables/.
 *
 * @task T889 / T904 / W4-6
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const playbookRuns = sqliteTable('playbook_runs', {
  runId: text('run_id').primaryKey(),
  playbookName: text('playbook_name').notNull(),
  playbookHash: text('playbook_hash').notNull(),
  currentNode: text('current_node'),
  bindings: text('bindings').notNull().default('{}'),
  errorContext: text('error_context'),
  status: text('status').notNull().default('running'),
  iterationCounts: text('iteration_counts').notNull().default('{}'),
  epicId: text('epic_id'),
  sessionId: text('session_id'),
  startedAt: text('started_at').notNull().default("(datetime('now'))"),
  completedAt: text('completed_at'),
});

export const playbookApprovals = sqliteTable('playbook_approvals', {
  approvalId: text('approval_id').primaryKey(),
  runId: text('run_id').notNull(),
  nodeId: text('node_id').notNull(),
  token: text('token').notNull().unique(),
  requestedAt: text('requested_at').notNull().default("(datetime('now'))"),
  approvedAt: text('approved_at'),
  approver: text('approver'),
  reason: text('reason'),
  status: text('status').notNull().default('pending'),
  autoPassed: integer('auto_passed').notNull().default(0),
});

export type {
  PlaybookApproval,
  PlaybookApprovalStatus,
  PlaybookRun,
  PlaybookRunStatus,
} from '@cleocode/contracts';
