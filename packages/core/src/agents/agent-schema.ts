/**
 * Drizzle ORM schema for the CLEO Agent dimension.
 *
 * Defines the `agent_instances` table that tracks live agent processes,
 * their health (heartbeat protocol), capacity, and error history.
 *
 * This is the DB-backed runtime registry -- distinct from the file-based
 * skill agent registry in `skills/agents/registry.ts` which tracks
 * installed agent *definitions*. This table tracks running agent *instances*.
 *
 * @module agents/agent-schema
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// ============================================================================
// Canonical enum constants
// ============================================================================

/** Agent instance status values matching DB CHECK constraint. */
export const AGENT_INSTANCE_STATUSES = [
  'starting',
  'active',
  'idle',
  'error',
  'crashed',
  'stopped',
] as const;

/** Agent type values for classification. */
export const AGENT_TYPES = [
  'orchestrator',
  'executor',
  'researcher',
  'architect',
  'validator',
  'documentor',
  'custom',
] as const;

// ============================================================================
// Agent Instances Table
// ============================================================================

export const agentInstances = sqliteTable(
  'agent_instances',
  {
    id: text('id').primaryKey(),
    agentType: text('agent_type', { enum: AGENT_TYPES }).notNull(),
    status: text('status', { enum: AGENT_INSTANCE_STATUSES }).notNull().default('starting'),
    // T033: FK constraints enforced at DB level by migration; kept soft here
    // to avoid circular dependency with tasks-schema.ts (which imports agent-schema.ts).
    // The migration SQL adds: session_id -> sessions ON DELETE SET NULL,
    //                         task_id -> tasks ON DELETE SET NULL,
    //                         parent_agent_id -> agent_instances ON DELETE SET NULL.
    sessionId: text('session_id'),
    taskId: text('task_id'),
    startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
    lastHeartbeat: text('last_heartbeat').notNull().default(sql`(datetime('now'))`),
    stoppedAt: text('stopped_at'),
    errorCount: integer('error_count').notNull().default(0),
    totalTasksCompleted: integer('total_tasks_completed').notNull().default(0),
    capacity: text('capacity').notNull().default('1.0'),
    metadataJson: text('metadata_json').default('{}'),
    parentAgentId: text('parent_agent_id'),
  },
  (table) => [
    index('idx_agent_instances_status').on(table.status),
    index('idx_agent_instances_agent_type').on(table.agentType),
    index('idx_agent_instances_session_id').on(table.sessionId),
    index('idx_agent_instances_task_id').on(table.taskId),
    index('idx_agent_instances_parent_agent_id').on(table.parentAgentId),
    index('idx_agent_instances_last_heartbeat').on(table.lastHeartbeat),
  ],
);

// ============================================================================
// Agent Error Log Table
// ============================================================================

export const agentErrorLog = sqliteTable(
  'agent_error_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agentId: text('agent_id').notNull(),
    errorType: text('error_type', {
      enum: ['retriable', 'permanent', 'unknown'],
    }).notNull(),
    message: text('message').notNull(),
    stack: text('stack'),
    occurredAt: text('occurred_at').notNull().default(sql`(datetime('now'))`),
    resolved: integer('resolved', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    index('idx_agent_error_log_agent_id').on(table.agentId),
    index('idx_agent_error_log_error_type').on(table.errorType),
    index('idx_agent_error_log_occurred_at').on(table.occurredAt),
  ],
);

// ============================================================================
// Type exports
// ============================================================================

export type AgentInstanceRow = typeof agentInstances.$inferSelect;
export type NewAgentInstanceRow = typeof agentInstances.$inferInsert;
export type AgentErrorLogRow = typeof agentErrorLog.$inferSelect;
export type NewAgentErrorLogRow = typeof agentErrorLog.$inferInsert;
export type AgentInstanceStatus = (typeof AGENT_INSTANCE_STATUSES)[number];
export type AgentType = (typeof AGENT_TYPES)[number];
export type AgentErrorType = 'retriable' | 'permanent' | 'unknown';
