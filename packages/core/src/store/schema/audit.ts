/**
 * Audit and governance tables: schema_meta, audit_log, token_usage,
 * architecture_decisions, adr_task_links, adr_relations, status_registry.
 *
 * @task T4837 (audit_log)
 */

import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { ADR_STATUSES, GATE_STATUSES } from '../status-registry.js';
import { manifestEntries } from './manifest.js';
import { sessions, tasks } from './tasks.js';

/** Token measurement methods for central token telemetry. */
export const TOKEN_USAGE_METHODS = ['otel', 'provider_api', 'tokenizer', 'heuristic'] as const;

/** Confidence levels for token measurements. */
export const TOKEN_USAGE_CONFIDENCE = ['real', 'high', 'estimated', 'coarse'] as const;

/** Transport types for token telemetry. */
export const TOKEN_USAGE_TRANSPORTS = ['cli', 'api', 'agent', 'unknown'] as const;

// === SCHEMA METADATA ===

export const schemaMeta = sqliteTable('schema_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// === AUDIT LOG ===

/**
 * Task change audit log — stores every add/update/complete/delete/archive operation.
 * Migrated from legacy JSONL task logs to SQLite per ADR-006/ADR-012.
 * No FK on taskId — log entries must survive task deletion.
 *
 * @task T4837
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
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
    // Optional caller-supplied retry token for idempotent mutate operations (T10600).
    idempotencyKey: text('idempotency_key'),
    durationMs: integer('duration_ms'),
    success: integer('success'),
    source: text('source'),
    gateway: text('gateway'),
    errorMessage: text('error_message'),
    // Project correlation (T5334)
    projectHash: text('project_hash'),
  },
  (table) => [
    index('idx_audit_log_task_id').on(table.taskId),
    index('idx_audit_log_action').on(table.action),
    index('idx_audit_log_timestamp').on(table.timestamp),
    index('idx_audit_log_domain').on(table.domain),
    index('idx_audit_log_request_id').on(table.requestId),
    index('idx_audit_log_idempotency_key').on(table.idempotencyKey),
    index('idx_audit_log_project_hash').on(table.projectHash),
    index('idx_audit_log_actor').on(table.actor),
    // T033 composite indexes
    index('idx_audit_log_session_timestamp').on(table.sessionId, table.timestamp),
    index('idx_audit_log_domain_operation').on(table.domain, table.operation),
    index('idx_audit_log_idempotency_lookup').on(
      table.projectHash,
      table.domain,
      table.operation,
      table.idempotencyKey,
    ),
  ],
);

// === TOKEN USAGE ===

/**
 * Central provider-aware token telemetry for CLI and external adapters.
 * Stores measured request/response token counts plus method/confidence metadata.
 */
export const tokenUsage = sqliteTable(
  'token_usage',
  {
    id: text('id').primaryKey(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    provider: text('provider').notNull().default('unknown'),
    model: text('model'),
    transport: text('transport', { enum: TOKEN_USAGE_TRANSPORTS }).notNull().default('unknown'),
    gateway: text('gateway'),
    domain: text('domain'),
    operation: text('operation'),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    requestId: text('request_id'),
    inputChars: integer('input_chars').notNull().default(0),
    outputChars: integer('output_chars').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    method: text('method', { enum: TOKEN_USAGE_METHODS }).notNull().default('heuristic'),
    confidence: text('confidence', { enum: TOKEN_USAGE_CONFIDENCE }).notNull().default('coarse'),
    requestHash: text('request_hash'),
    responseHash: text('response_hash'),
    metadataJson: text('metadata_json').notNull().default('{}'),
  },
  (table) => [
    index('idx_token_usage_created_at').on(table.createdAt),
    index('idx_token_usage_request_id').on(table.requestId),
    index('idx_token_usage_session_id').on(table.sessionId),
    index('idx_token_usage_task_id').on(table.taskId),
    index('idx_token_usage_provider').on(table.provider),
    index('idx_token_usage_transport').on(table.transport),
    index('idx_token_usage_domain_operation').on(table.domain, table.operation),
    index('idx_token_usage_method').on(table.method),
    index('idx_token_usage_gateway').on(table.gateway),
  ],
);

// === ARCHITECTURE DECISIONS ===

/**
 * Architecture Decision Records (ADRs) stored in the database.
 * Corresponds to the physical ADR markdown files in .cleo/adrs/.
 * Self-referential FKs (supersedes_id, superseded_by_id, amends_id) are
 * enforced at the DB level by T033 migration.
 */
export const architectureDecisions = sqliteTable(
  'architecture_decisions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    status: text('status', { enum: ADR_STATUSES }).notNull().default('proposed'),
    supersedesId: text('supersedes_id').references(
      (): AnySQLiteColumn => architectureDecisions.id,
      { onDelete: 'set null' },
    ),
    supersededById: text('superseded_by_id').references(
      (): AnySQLiteColumn => architectureDecisions.id,
      { onDelete: 'set null' },
    ),
    consensusManifestId: text('consensus_manifest_id').references(
      (): AnySQLiteColumn => manifestEntries.id,
      { onDelete: 'set null' },
    ),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at'),
    // ADR-017 §5.3 extension columns
    date: text('date').notNull().default(''),
    acceptedAt: text('accepted_at'),
    gate: text('gate', { enum: ['HITL', 'automated'] }),
    gateStatus: text('gate_status', { enum: GATE_STATUSES }),
    amendsId: text('amends_id').references((): AnySQLiteColumn => architectureDecisions.id, {
      onDelete: 'set null',
    }),
    filePath: text('file_path').notNull().default(''),
    // ADR-017 §5.4 cognitive search columns (T4942)
    summary: text('summary'),
    keywords: text('keywords'),
    topics: text('topics'),
  },
  (table) => [
    index('idx_arch_decisions_status').on(table.status),
    index('idx_arch_decisions_amends_id').on(table.amendsId),
  ],
);

// === ADR JUNCTION TABLES (ADR-017 §5.3) ===

/** ADR-to-Task links (soft FK — tasks can be purged) */
export const adrTaskLinks = sqliteTable(
  'adr_task_links',
  {
    adrId: text('adr_id')
      .notNull()
      .references(() => architectureDecisions.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    linkType: text('link_type', {
      enum: ['related', 'governed_by', 'implements'],
    })
      .notNull()
      .default('related'),
  },
  (table) => [
    primaryKey({ columns: [table.adrId, table.taskId] }),
    index('idx_adr_task_links_task_id').on(table.taskId),
  ],
);

/** ADR cross-reference relationships */
export const adrRelations = sqliteTable(
  'adr_relations',
  {
    fromAdrId: text('from_adr_id')
      .notNull()
      .references(() => architectureDecisions.id, { onDelete: 'cascade' }),
    toAdrId: text('to_adr_id')
      .notNull()
      .references(() => architectureDecisions.id, { onDelete: 'cascade' }),
    relationType: text('relation_type', {
      enum: ['supersedes', 'amends', 'related'],
    }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.fromAdrId, table.toAdrId, table.relationType] })],
);

// === STATUS REGISTRY (ADR-018) ===

export const statusRegistryTable = sqliteTable(
  'status_registry',
  {
    name: text('name').notNull(),
    entityType: text('entity_type', {
      enum: ['task', 'session', 'lifecycle_pipeline', 'lifecycle_stage', 'adr', 'gate', 'manifest'],
    }).notNull(),
    namespace: text('namespace', { enum: ['workflow', 'governance', 'manifest'] }).notNull(),
    description: text('description').notNull(),
    isTerminal: integer('is_terminal', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.name, table.entityType] }),
    index('idx_status_registry_entity_type').on(table.entityType),
    index('idx_status_registry_namespace').on(table.namespace),
  ],
);

// === TYPE EXPORTS ===

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
export type TokenUsageRow = typeof tokenUsage.$inferSelect;
export type NewTokenUsageRow = typeof tokenUsage.$inferInsert;
export type ArchitectureDecisionRow = typeof architectureDecisions.$inferSelect;
export type NewArchitectureDecisionRow = typeof architectureDecisions.$inferInsert;
export type AdrTaskLinkRow = typeof adrTaskLinks.$inferSelect;
export type NewAdrTaskLinkRow = typeof adrTaskLinks.$inferInsert;
export type AdrRelationRow = typeof adrRelations.$inferSelect;
export type NewAdrRelationRow = typeof adrRelations.$inferInsert;
export type StatusRegistryRow = typeof statusRegistryTable.$inferSelect;
