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
import {
  TASK_STATUSES,
  SESSION_STATUSES,
  LIFECYCLE_PIPELINE_STATUSES,
  LIFECYCLE_STAGE_STATUSES,
  ADR_STATUSES,
  GATE_STATUSES,
} from './status-registry.js';

// Re-export status constants and types so existing imports from schema.ts still work.
export {
  TASK_STATUSES,
  SESSION_STATUSES,
  LIFECYCLE_PIPELINE_STATUSES,
  LIFECYCLE_STAGE_STATUSES,
  ADR_STATUSES,
  GATE_STATUSES,
  MANIFEST_STATUSES,
  type TaskStatus,
  type SessionStatus,
  type PipelineStatus,
  type StageStatus,
  type AdrStatus,
  type GateStatus,
  type ManifestStatus,
  isValidStatus,
} from './status-registry.js';

// === CANONICAL ENUM CONSTANTS (non-status) ===

/** Task priorities matching DB CHECK constraint on tasks.priority. */
export const TASK_PRIORITIES = [
  'critical', 'high', 'medium', 'low',
] as const;

/** Task types matching DB CHECK constraint on tasks.type. */
export const TASK_TYPES = ['epic', 'task', 'subtask'] as const;

/** Task size values matching DB CHECK constraint on tasks.size. */
export const TASK_SIZES = ['small', 'medium', 'large'] as const;

/** Canonical lifecycle stage names matching DB CHECK constraint on lifecycle_stages.stage_name. */
export const LIFECYCLE_STAGE_NAMES = [
  'research', 'consensus', 'architecture_decision', 'specification', 'decomposition',
  'implementation', 'validation', 'testing', 'release', 'contribution',
] as const;

/** Gate result values matching DB CHECK constraint on lifecycle_gate_results.result. */
export const LIFECYCLE_GATE_RESULTS = [
  'pass', 'fail', 'warn',
] as const;

/** Evidence type values matching DB CHECK constraint on lifecycle_evidence.type. */
export const LIFECYCLE_EVIDENCE_TYPES = [
  'file', 'url', 'manifest',
] as const;

// === TASKS TABLE ===

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status', {
    enum: TASK_STATUSES,
  }).notNull().default('pending'),
  priority: text('priority', {
    enum: TASK_PRIORITIES,
  }).notNull().default('medium'),
  type: text('type', { enum: TASK_TYPES }),
  parentId: text('parent_id'),
  phase: text('phase'),
  size: text('size', { enum: TASK_SIZES }),
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
    enum: SESSION_STATUSES,
  }).notNull().default('active'),
  scopeJson: text('scope_json').notNull().default('{}'),
  currentTask: text('current_task'),
  taskStartedAt: text('task_started_at'),
  agent: text('agent'),
  notesJson: text('notes_json').default('[]'),
  tasksCompletedJson: text('tasks_completed_json').default('[]'),
  tasksCreatedJson: text('tasks_created_json').default('[]'),
  handoffJson: text('handoff_json'),
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
    enum: LIFECYCLE_PIPELINE_STATUSES,
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
  stageName: text('stage_name', { enum: LIFECYCLE_STAGE_NAMES }).notNull(),
  status: text('status', {
    enum: LIFECYCLE_STAGE_STATUSES,
  }).notNull().default('not_started'),
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
    enum: LIFECYCLE_GATE_RESULTS,
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
    enum: LIFECYCLE_EVIDENCE_TYPES,
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
  // Dispatch layer columns (migration 20260225200000_audit-log-dispatch-columns)
  domain: text('domain'),
  operation: text('operation'),
  sessionId: text('session_id'),
  requestId: text('request_id'),
  durationMs: integer('duration_ms'),
  success: integer('success'),
  source: text('source'),
  gateway: text('gateway'),
  errorMessage: text('error_message'),
}, (table) => [
  index('idx_audit_log_task_id').on(table.taskId),
  index('idx_audit_log_action').on(table.action),
  index('idx_audit_log_timestamp').on(table.timestamp),
  index('idx_audit_log_domain').on(table.domain),
  index('idx_audit_log_request_id').on(table.requestId),
]);

// === ARCHITECTURE DECISIONS ===

/**
 * Architecture Decision Records (ADRs) stored in the database.
 * Corresponds to the physical ADR markdown files in .cleo/adrs/.
 * Created by migration 20260225024442_sync-lifecycle-enums-and-arch-decisions.
 * Self-referential FKs (supersedes_id, superseded_by_id) are enforced at the
 * DB level by the migration; omitted here to avoid Drizzle circular-ref syntax.
 */
export const architectureDecisions = sqliteTable('architecture_decisions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status', { enum: ADR_STATUSES })
    .notNull()
    .default('proposed'),
  supersedesId: text('supersedes_id'),
  supersededById: text('superseded_by_id'),
  consensusManifestId: text('consensus_manifest_id'),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at'),
  // ADR-017 §5.3 extension columns
  date: text('date').notNull().default(''),
  acceptedAt: text('accepted_at'),
  gate: text('gate', { enum: ['HITL', 'automated'] }),
  gateStatus: text('gate_status', { enum: GATE_STATUSES }),
  amendsId: text('amends_id'),
  filePath: text('file_path').notNull().default(''),
  // ADR-017 §5.4 cognitive search columns (T4942)
  summary: text('summary'),
  keywords: text('keywords'),
  topics: text('topics'),
}, (table) => [
  index('idx_arch_decisions_status').on(table.status),
]);

// === ADR JUNCTION TABLES (ADR-017 §5.3) ===

/** ADR-to-Task links (soft FK — tasks can be purged) */
export const adrTaskLinks = sqliteTable('adr_task_links', {
  adrId: text('adr_id').notNull().references(() => architectureDecisions.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull(),
  linkType: text('link_type', {
    enum: ['related', 'governed_by', 'implements'],
  }).notNull().default('related'),
}, (table) => [
  primaryKey({ columns: [table.adrId, table.taskId] }),
  index('idx_adr_task_links_task_id').on(table.taskId),
]);

/** ADR cross-reference relationships */
export const adrRelations = sqliteTable('adr_relations', {
  fromAdrId: text('from_adr_id').notNull().references(() => architectureDecisions.id, { onDelete: 'cascade' }),
  toAdrId: text('to_adr_id').notNull().references(() => architectureDecisions.id, { onDelete: 'cascade' }),
  relationType: text('relation_type', {
    enum: ['supersedes', 'amends', 'related'],
  }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.fromAdrId, table.toAdrId, table.relationType] }),
]);

// === STATUS REGISTRY (ADR-018) ===

export const statusRegistryTable = sqliteTable('status_registry', {
  name:       text('name').notNull(),
  entityType: text('entity_type', {
    enum: ['task', 'session', 'lifecycle_pipeline', 'lifecycle_stage', 'adr', 'gate', 'manifest'],
  }).notNull(),
  namespace:   text('namespace', { enum: ['workflow', 'governance', 'manifest'] }).notNull(),
  description: text('description').notNull(),
  isTerminal:  integer('is_terminal', { mode: 'boolean' }).notNull().default(false),
}, (table) => [
  primaryKey({ columns: [table.name, table.entityType] }),
  index('idx_status_registry_entity_type').on(table.entityType),
  index('idx_status_registry_namespace').on(table.namespace),
]);

export type StatusRegistryRow = typeof statusRegistryTable.$inferSelect;

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
export type ArchitectureDecisionRow = typeof architectureDecisions.$inferSelect;
export type NewArchitectureDecisionRow = typeof architectureDecisions.$inferInsert;
export type AdrTaskLinkRow = typeof adrTaskLinks.$inferSelect;
export type NewAdrTaskLinkRow = typeof adrTaskLinks.$inferInsert;
export type AdrRelationRow = typeof adrRelations.$inferSelect;
export type NewAdrRelationRow = typeof adrRelations.$inferInsert;
