/**
 * Drizzle ORM schema for CLEO nexus.db (SQLite via node:sqlite + sqlite-proxy).
 *
 * Tables: project_registry, nexus_audit_log, nexus_schema_meta
 * Stores cross-project registry and audit infrastructure for the Nexus domain.
 *
 * @task T5365
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// === PROJECT_REGISTRY TABLE ===

/** Central registry of all CLEO projects known to the Nexus. */
export const projectRegistry = sqliteTable(
  'project_registry',
  {
    projectId: text('project_id').primaryKey(),
    projectHash: text('project_hash').notNull().unique(),
    projectPath: text('project_path').notNull().unique(),
    name: text('name').notNull(),
    registeredAt: text('registered_at').notNull().default(sql`(datetime('now'))`),
    lastSeen: text('last_seen').notNull().default(sql`(datetime('now'))`),
    healthStatus: text('health_status').notNull().default('unknown'),
    healthLastCheck: text('health_last_check'),
    permissions: text('permissions').notNull().default('read'),
    lastSync: text('last_sync').notNull().default(sql`(datetime('now'))`),
    taskCount: integer('task_count').notNull().default(0),
    labelsJson: text('labels_json').notNull().default('[]'),
  },
  (table) => [
    index('idx_project_registry_hash').on(table.projectHash),
    index('idx_project_registry_health').on(table.healthStatus),
    index('idx_project_registry_name').on(table.name),
  ],
);

// === NEXUS_AUDIT_LOG TABLE ===

/** Append-only audit log for all Nexus operations across projects. */
export const nexusAuditLog = sqliteTable(
  'nexus_audit_log',
  {
    id: text('id').primaryKey(),
    timestamp: text('timestamp').notNull().default(sql`(datetime('now'))`),
    action: text('action').notNull(),
    projectHash: text('project_hash'),
    projectId: text('project_id'),
    domain: text('domain'),
    operation: text('operation'),
    sessionId: text('session_id'),
    requestId: text('request_id'),
    source: text('source'),
    gateway: text('gateway'),
    success: integer('success'),
    durationMs: integer('duration_ms'),
    detailsJson: text('details_json').default('{}'),
    errorMessage: text('error_message'),
  },
  (table) => [
    index('idx_nexus_audit_timestamp').on(table.timestamp),
    index('idx_nexus_audit_action').on(table.action),
    index('idx_nexus_audit_project_hash').on(table.projectHash),
    index('idx_nexus_audit_project_id').on(table.projectId),
    index('idx_nexus_audit_session').on(table.sessionId),
  ],
);

// === SCHEMA METADATA ===

/** Key-value store for nexus.db schema versioning and metadata. */
export const nexusSchemaMeta = sqliteTable('nexus_schema_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// === TYPE EXPORTS ===

export type ProjectRegistryRow = typeof projectRegistry.$inferSelect;
export type NewProjectRegistryRow = typeof projectRegistry.$inferInsert;
export type NexusAuditLogRow = typeof nexusAuditLog.$inferSelect;
export type NewNexusAuditLogRow = typeof nexusAuditLog.$inferInsert;
export type NexusSchemaMetaRow = typeof nexusSchemaMeta.$inferSelect;
export type NewNexusSchemaMetaRow = typeof nexusSchemaMeta.$inferInsert;
