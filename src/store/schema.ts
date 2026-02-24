/**
 * Drizzle ORM schema for CLEO tasks.db (SQLite via node:sqlite + sqlite-proxy).
 *
 * Tables: tasks, task_dependencies, task_relations, sessions, task_work_history
 * Archive uses the same tasks table with status = 'archived' + archive metadata.
 *
 * @epic T4454
 * @task W1-T2
 */

import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// === TASKS TABLE ===

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status', {
    enum: ['pending', 'active', 'blocked', 'done', 'cancelled', 'archived'],
  }).notNull().default('pending'),
  priority: text('priority', {
    enum: ['critical', 'high', 'medium', 'low'],
  }).notNull().default('medium'),
  type: text('type', { enum: ['epic', 'task', 'subtask'] }),
  parentId: text('parent_id'),
  phase: text('phase'),
  size: text('size', { enum: ['small', 'medium', 'large'] }),
  position: integer('position'),
  positionVersion: integer('position_version').default(0),

  // JSON-serialized complex fields (avoids excessive normalization)
  labelsJson: text('labels_json').default('[]'),
  notesJson: text('notes_json').default('[]'),
  acceptanceJson: text('acceptance_json').default('[]'),
  filesJson: text('files_json').default('[]'),

  // Provenance
  origin: text('origin'),
  blockedBy: text('blocked_by'),
  epicLifecycle: text('epic_lifecycle'),
  noAutoComplete: integer('no_auto_complete', { mode: 'boolean' }),

  // Timestamps
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at'),
  completedAt: text('completed_at'),
  cancelledAt: text('cancelled_at'),
  cancellationReason: text('cancellation_reason'),

  // Archive metadata (populated when status = 'archived')
  archivedAt: text('archived_at'),
  archiveReason: text('archive_reason'),
  cycleTimeDays: integer('cycle_time_days'),

  // Verification (JSON-serialized)
  verificationJson: text('verification_json'),

  // Provenance tracking
  createdBy: text('created_by'),
  modifiedBy: text('modified_by'),
  sessionId: text('session_id'),
}, (table) => [
  index('idx_tasks_status').on(table.status),
  index('idx_tasks_parent_id').on(table.parentId),
  index('idx_tasks_phase').on(table.phase),
  index('idx_tasks_type').on(table.type),
  index('idx_tasks_priority').on(table.priority),
]);

// === TASK DEPENDENCIES ===

export const taskDependencies = sqliteTable('task_dependencies', {
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  dependsOn: text('depends_on').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.taskId, table.dependsOn] }),
  index('idx_deps_depends_on').on(table.dependsOn),
]);

// === TASK RELATIONS ===

export const taskRelations = sqliteTable('task_relations', {
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  relatedTo: text('related_to').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  relationType: text('relation_type', {
    enum: ['related', 'blocks', 'duplicates'],
  }).notNull().default('related'),
}, (table) => [
  primaryKey({ columns: [table.taskId, table.relatedTo] }),
]);

// === SESSIONS ===

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status', {
    enum: ['active', 'ended', 'orphaned', 'suspended'],
  }).notNull().default('active'),
  scopeJson: text('scope_json').notNull().default('{}'),
  currentTask: text('current_task'),
  taskStartedAt: text('task_started_at'),
  agent: text('agent'),
  notesJson: text('notes_json').default('[]'),
  tasksCompletedJson: text('tasks_completed_json').default('[]'),
  tasksCreatedJson: text('tasks_created_json').default('[]'),
  startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
  endedAt: text('ended_at'),
}, (table) => [
  index('idx_sessions_status').on(table.status),
]);

// === TASK WORK HISTORY ===

export const taskWorkHistory = sqliteTable('task_work_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull(),
  setAt: text('set_at').notNull().default(sql`(datetime('now'))`),
  clearedAt: text('cleared_at'),
}, (table) => [
  index('idx_work_history_session').on(table.sessionId),
]);

// === LIFECYCLE PIPELINES ===

export const lifecyclePipelines = sqliteTable('lifecycle_pipelines', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  status: text('status', {
    enum: ['active', 'completed', 'aborted'],
  }).notNull().default('active'),
  currentStageId: text('current_stage_id'),
  startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
  completedAt: text('completed_at'),
}, (table) => [
  index('idx_lifecycle_pipelines_task_id').on(table.taskId),
  index('idx_lifecycle_pipelines_status').on(table.status),
]);

// === LIFECYCLE STAGES ===

export const lifecycleStages = sqliteTable('lifecycle_stages', {
  id: text('id').primaryKey(),
  pipelineId: text('pipeline_id').notNull().references(() => lifecyclePipelines.id, { onDelete: 'cascade' }),
  stageName: text('stage_name').notNull(),
  status: text('status', {
    enum: ['pending', 'active', 'blocked', 'completed', 'skipped'],
  }).notNull().default('pending'),
  sequence: integer('sequence').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  blockedAt: text('blocked_at'),
  blockReason: text('block_reason'),
  skippedAt: text('skipped_at'),
  skipReason: text('skip_reason'),
  notesJson: text('notes_json').default('[]'),
  metadataJson: text('metadata_json').default('{}'),
}, (table) => [
  index('idx_lifecycle_stages_pipeline_id').on(table.pipelineId),
  index('idx_lifecycle_stages_stage_name').on(table.stageName),
  index('idx_lifecycle_stages_status').on(table.status),
]);

// === LIFECYCLE GATE RESULTS ===

export const lifecycleGateResults = sqliteTable('lifecycle_gate_results', {
  id: text('id').primaryKey(),
  stageId: text('stage_id').notNull().references(() => lifecycleStages.id, { onDelete: 'cascade' }),
  gateName: text('gate_name').notNull(),
  result: text('result', {
    enum: ['pass', 'fail', 'warn'],
  }).notNull(),
  checkedAt: text('checked_at').notNull().default(sql`(datetime('now'))`),
  checkedBy: text('checked_by').notNull(),
  details: text('details'),
  reason: text('reason'),
}, (table) => [
  index('idx_lifecycle_gate_results_stage_id').on(table.stageId),
]);

// === LIFECYCLE EVIDENCE ===

export const lifecycleEvidence = sqliteTable('lifecycle_evidence', {
  id: text('id').primaryKey(),
  stageId: text('stage_id').notNull().references(() => lifecycleStages.id, { onDelete: 'cascade' }),
  uri: text('uri').notNull(),
  type: text('type', {
    enum: ['file', 'url', 'manifest'],
  }).notNull(),
  recordedAt: text('recorded_at').notNull().default(sql`(datetime('now'))`),
  recordedBy: text('recorded_by'),
  description: text('description'),
}, (table) => [
  index('idx_lifecycle_evidence_stage_id').on(table.stageId),
]);

// === LIFECYCLE TRANSITIONS ===

export const lifecycleTransitions = sqliteTable('lifecycle_transitions', {
  id: text('id').primaryKey(),
  pipelineId: text('pipeline_id').notNull().references(() => lifecyclePipelines.id, { onDelete: 'cascade' }),
  fromStageId: text('from_stage_id').notNull(),
  toStageId: text('to_stage_id').notNull(),
  transitionType: text('transition_type', {
    enum: ['automatic', 'manual', 'forced'],
  }).notNull().default('automatic'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_lifecycle_transitions_pipeline_id').on(table.pipelineId),
]);

// === SCHEMA METADATA ===

export const schemaMeta = sqliteTable('schema_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// === AUDIT LOG ===

/**
 * Task change audit log — stores every add/update/complete/delete/archive operation.
 * Migrated from tasks-log.jsonl to SQLite per ADR-006/ADR-012.
 * No FK on taskId — log entries must survive task deletion.
 *
 * @task T4837
 */
export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  timestamp: text('timestamp').notNull().default(sql`(datetime('now'))`),
  action: text('action').notNull(),
  taskId: text('task_id').notNull(),
  actor: text('actor').notNull().default('system'),
  detailsJson: text('details_json').default('{}'),
  beforeJson: text('before_json'),
  afterJson: text('after_json'),
}, (table) => [
  index('idx_audit_log_task_id').on(table.taskId),
  index('idx_audit_log_action').on(table.action),
  index('idx_audit_log_timestamp').on(table.timestamp),
]);

// === TYPE EXPORTS ===

export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type TaskDependencyRow = typeof taskDependencies.$inferSelect;
export type TaskRelationRow = typeof taskRelations.$inferSelect;
export type WorkHistoryRow = typeof taskWorkHistory.$inferSelect;
export type LifecyclePipelineRow = typeof lifecyclePipelines.$inferSelect;
export type NewLifecyclePipelineRow = typeof lifecyclePipelines.$inferInsert;
export type LifecycleStageRow = typeof lifecycleStages.$inferSelect;
export type NewLifecycleStageRow = typeof lifecycleStages.$inferInsert;
export type LifecycleGateResultRow = typeof lifecycleGateResults.$inferSelect;
export type NewLifecycleGateResultRow = typeof lifecycleGateResults.$inferInsert;
export type LifecycleEvidenceRow = typeof lifecycleEvidence.$inferSelect;
export type NewLifecycleEvidenceRow = typeof lifecycleEvidence.$inferInsert;
export type LifecycleTransitionRow = typeof lifecycleTransitions.$inferSelect;
export type NewLifecycleTransitionRow = typeof lifecycleTransitions.$inferInsert;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
