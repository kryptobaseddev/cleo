/**
 * Drizzle ORM schema for CLEO tasks.db (SQLite via sql.js WASM).
 *
 * Tables: tasks, task_dependencies, task_relations, sessions, session_focus_history
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
  currentFocus: text('current_focus'),
  focusSetAt: text('focus_set_at'),
  agent: text('agent'),
  notesJson: text('notes_json').default('[]'),
  tasksCompletedJson: text('tasks_completed_json').default('[]'),
  tasksCreatedJson: text('tasks_created_json').default('[]'),
  startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
  endedAt: text('ended_at'),
}, (table) => [
  index('idx_sessions_status').on(table.status),
]);

// === SESSION FOCUS HISTORY ===

export const sessionFocusHistory = sqliteTable('session_focus_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull(),
  setAt: text('set_at').notNull().default(sql`(datetime('now'))`),
  clearedAt: text('cleared_at'),
}, (table) => [
  index('idx_focus_history_session').on(table.sessionId),
]);

// === SCHEMA METADATA ===

export const schemaMeta = sqliteTable('schema_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// === TYPE EXPORTS ===

export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type TaskDependencyRow = typeof taskDependencies.$inferSelect;
export type TaskRelationRow = typeof taskRelations.$inferSelect;
export type FocusHistoryRow = typeof sessionFocusHistory.$inferSelect;
