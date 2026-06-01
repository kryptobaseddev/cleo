/**
 * Project-scope `cleo.db` — consolidated **audit / governance** domain (6 tables
 * + schema_meta).
 *
 * Part of the consolidated PROJECT-scope `cleo.db` target shape authored for
 * SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2, task T11360). Target-shape
 * authoring only — physical names carry the `tasks_` domain prefix. The live
 * runtime module `schema/audit.ts` keeps its UNPREFIXED names until the exodus
 * migration (T11248) swaps the substrate.
 *
 * Tables: tasks_schema_meta · tasks_audit_log · tasks_token_usage ·
 * tasks_architecture_decisions · tasks_adr_task_links · tasks_adr_relations ·
 * tasks_status_registry.
 *
 * ## E10 typing (already conformant — preserved)
 *
 * - **§4 timestamps:** all canonical TEXT ISO8601 (no epoch non-conformers).
 * - **§3 booleans:** `status_registry.is_terminal` already `integer({ mode:
 *   'boolean' })` — preserved.
 * - **§5 enums:** all already `{ enum }`-narrowed (token_usage method/
 *   confidence/transport, ADR status/gate_status, link/relation/entity/
 *   namespace types). Inline-literal enums (`gate`, `adr_task_links.link_type`,
 *   `adr_relations.relation_type`, `status_registry.entity_type`/`namespace`)
 *   are promoted to named const arrays here (§5a — identifier over literal).
 * - **§7 idempotency:** `audit_log.idempotency_key` is the CANONICAL model the
 *   report cites (§7) — preserved. T11362 promotes its
 *   `(project_hash, domain, operation, idempotency_key)` composite to a true
 *   UNIQUE constraint (the dedup grain — the same key recurs across distinct
 *   domain/operation tuples, so the bare key is NOT unique).
 * - **§6a JSON:** `details_json` / `before_json` / `after_json` /
 *   `metadata_json` stay serialized TEXT per the JSON-Column Audit.
 *
 * Cross-table FKs into `tasks_tasks` / `tasks_sessions` / `docs_manifest_entries`
 * are carried as plain TEXT id columns (resolved by the exodus prefixer);
 * intra-table self-FKs (ADR supersedes/amends) are real `.references()`.
 *
 * @task T11360 · T11362 (§7 idempotency UNIQUE)
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §3 · §4 · §5 · §6a · §7
 * @see docs/migration/sqlite-schema-columns.json (per-column affinity SSoT)
 */

import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';
import { ADR_STATUSES, GATE_STATUSES } from '../../status-registry.js';
import { TOKEN_USAGE_CONFIDENCE, TOKEN_USAGE_METHODS, TOKEN_USAGE_TRANSPORTS } from '../audit.js';
import { makeSchemaMetaTable } from '../schema-utils.js';

/** ADR governance-gate kinds — promoted from inline literal (§5a). */
export const ADR_GATE_KINDS = ['HITL', 'automated'] as const;

/** ADR↔task link types — promoted from inline literal (§5a). */
export const ADR_TASK_LINK_TYPES = ['related', 'governed_by', 'implements'] as const;

/** ADR↔ADR relation types — promoted from inline literal (§5a). */
export const ADR_RELATION_TYPES = ['supersedes', 'amends', 'related'] as const;

/** Status-registry entity types — promoted from inline literal (§5a). */
export const STATUS_REGISTRY_ENTITY_TYPES = [
  'task',
  'session',
  'lifecycle_pipeline',
  'lifecycle_stage',
  'adr',
  'gate',
  'manifest',
] as const;

/** Status-registry namespaces — promoted from inline literal (§5a). */
export const STATUS_REGISTRY_NAMESPACES = ['workflow', 'governance', 'manifest'] as const;

/**
 * `tasks_schema_meta` — key-value schema-version store.
 *
 * @task T11360 (target shape)
 */
export const tasksSchemaMeta = makeSchemaMetaTable('tasks_schema_meta');

/**
 * `tasks_audit_log` — task-change audit log. No FK on task_id (entries outlive
 * task deletion). `idempotency_key` is the §7 canonical retry-dedup model.
 *
 * @task T11360 (target shape) · T4837 (original)
 */
export const tasksAuditLog = sqliteTable(
  'tasks_audit_log',
  {
    /** Audit row id (UUID v4). */
    id: text('id').primaryKey(),
    /** ISO-8601 UTC instant (canonical TEXT, §4). */
    timestamp: text('timestamp').notNull().default(sql`(datetime('now'))`),
    /** Mutating action name. */
    action: text('action').notNull(),
    /** Subject task id (NOT an FK — survives task deletion). */
    taskId: text('task_id').notNull(),
    /** Actor identity. */
    actor: text('actor').notNull().default('system'),
    /** JSON details payload (TEXT per JSON audit; empty-object default). */
    detailsJson: text('details_json').default('{}'),
    /** JSON before-snapshot (TEXT per JSON audit). */
    beforeJson: text('before_json'),
    /** JSON after-snapshot (TEXT per JSON audit). */
    afterJson: text('after_json'),
    /** Dispatch domain. */
    domain: text('domain'),
    /** Dispatch operation. */
    operation: text('operation'),
    /** Originating session id. */
    sessionId: text('session_id'),
    /** Dispatch request id. */
    requestId: text('request_id'),
    /**
     * Caller-supplied idempotency key (§7 canonical model — preserved). The
     * dedup grain is the composite `(project_hash, domain, operation,
     * idempotency_key)` — the same key is legitimately reused across distinct
     * `(domain, operation)` tuples, so the UNIQUE constraint is on that tuple
     * (see `uq_tasks_audit_log_idempotency_lookup`), NOT the bare key. UNIQUE
     * ignores rows whose `idempotency_key` is NULL, so only keyed mutations dedup.
     */
    idempotencyKey: text('idempotency_key'),
    /** Operation duration in ms. */
    durationMs: integer('duration_ms'),
    /** Outcome flag (0/1) — kept numeric to match the legacy nullable shape. */
    success: integer('success'),
    /** Origin source. */
    source: text('source'),
    /** CQRS gateway. */
    gateway: text('gateway'),
    /** Error message on failure. */
    errorMessage: text('error_message'),
    /** Project correlation hash. */
    projectHash: text('project_hash'),
  },
  (table) => [
    index('idx_tasks_audit_log_task_id').on(table.taskId),
    index('idx_tasks_audit_log_action').on(table.action),
    index('idx_tasks_audit_log_timestamp').on(table.timestamp),
    index('idx_tasks_audit_log_domain').on(table.domain),
    index('idx_tasks_audit_log_request_id').on(table.requestId),
    index('idx_tasks_audit_log_idempotency_key').on(table.idempotencyKey),
    index('idx_tasks_audit_log_project_hash').on(table.projectHash),
    index('idx_tasks_audit_log_actor').on(table.actor),
    index('idx_tasks_audit_log_session_timestamp').on(table.sessionId, table.timestamp),
    index('idx_tasks_audit_log_domain_operation').on(table.domain, table.operation),
    // §7: audit_log dedup grain is the composite, not the bare key — the same
    // idempotency_key is reused across distinct (domain, operation) tuples. The
    // UNIQUE constraint ignores NULL-key rows in SQLite, so only keyed writes
    // coalesce via onConflictDoNothing.
    unique('uq_tasks_audit_log_idempotency_lookup').on(
      table.projectHash,
      table.domain,
      table.operation,
      table.idempotencyKey,
    ),
  ],
);

/**
 * `tasks_token_usage` — provider-aware token telemetry.
 *
 * @task T11360 (target shape)
 */
export const tasksTokenUsage = sqliteTable(
  'tasks_token_usage',
  {
    /** Usage row id (UUID v4). */
    id: text('id').primaryKey(),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** Provider name. */
    provider: text('provider').notNull().default('unknown'),
    /** Model name. */
    model: text('model'),
    /** Transport — CHECK-backed via {@link TOKEN_USAGE_TRANSPORTS}. */
    transport: text('transport', { enum: TOKEN_USAGE_TRANSPORTS }).notNull().default('unknown'),
    /** CQRS gateway. */
    gateway: text('gateway'),
    /** Dispatch domain. */
    domain: text('domain'),
    /** Dispatch operation. */
    operation: text('operation'),
    /** FK → `tasks_sessions.id` (resolved at exodus). */
    sessionId: text('session_id'),
    /** FK → `tasks_tasks.id` (resolved at exodus). */
    taskId: text('task_id'),
    /** Dispatch request id. */
    requestId: text('request_id'),
    /** Input char count. */
    inputChars: integer('input_chars').notNull().default(0),
    /** Output char count. */
    outputChars: integer('output_chars').notNull().default(0),
    /** Input token count. */
    inputTokens: integer('input_tokens').notNull().default(0),
    /** Output token count. */
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Total token count. */
    totalTokens: integer('total_tokens').notNull().default(0),
    /** Measurement method — CHECK-backed via {@link TOKEN_USAGE_METHODS}. */
    method: text('method', { enum: TOKEN_USAGE_METHODS }).notNull().default('heuristic'),
    /** Measurement confidence — CHECK-backed via {@link TOKEN_USAGE_CONFIDENCE}. */
    confidence: text('confidence', { enum: TOKEN_USAGE_CONFIDENCE }).notNull().default('coarse'),
    /** Request hash. */
    requestHash: text('request_hash'),
    /** Response hash. */
    responseHash: text('response_hash'),
    /** JSON metadata object (TEXT per JSON audit; empty-object default). */
    metadataJson: text('metadata_json').notNull().default('{}'),
  },
  (table) => [
    index('idx_tasks_token_usage_created_at').on(table.createdAt),
    index('idx_tasks_token_usage_request_id').on(table.requestId),
    index('idx_tasks_token_usage_session_id').on(table.sessionId),
    index('idx_tasks_token_usage_task_id').on(table.taskId),
    index('idx_tasks_token_usage_provider').on(table.provider),
    index('idx_tasks_token_usage_transport').on(table.transport),
    index('idx_tasks_token_usage_domain_operation').on(table.domain, table.operation),
    index('idx_tasks_token_usage_method').on(table.method),
    index('idx_tasks_token_usage_gateway').on(table.gateway),
  ],
);

/**
 * `tasks_architecture_decisions` — DB-backed ADR records.
 *
 * @task T11360 (target shape)
 */
export const tasksArchitectureDecisions = sqliteTable(
  'tasks_architecture_decisions',
  {
    /** ADR id. */
    id: text('id').primaryKey(),
    /** ADR title. */
    title: text('title').notNull(),
    /** ADR status — CHECK-backed via {@link ADR_STATUSES}. */
    status: text('status', { enum: ADR_STATUSES }).notNull().default('proposed'),
    /** Self-FK → superseding ADR. */
    supersedesId: text('supersedes_id').references(
      (): AnySQLiteColumn => tasksArchitectureDecisions.id,
      { onDelete: 'set null' },
    ),
    /** Self-FK → superseded-by ADR. */
    supersededById: text('superseded_by_id').references(
      (): AnySQLiteColumn => tasksArchitectureDecisions.id,
      { onDelete: 'set null' },
    ),
    /** FK → `docs_manifest_entries.id` (resolved at exodus). */
    consensusManifestId: text('consensus_manifest_id'),
    /** ADR body content. */
    content: text('content').notNull(),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at'),
    /** ADR date string. */
    date: text('date').notNull().default(''),
    /** ISO-8601 UTC accepted instant (canonical TEXT, §4). */
    acceptedAt: text('accepted_at'),
    /** Governance gate kind — CHECK-backed via {@link ADR_GATE_KINDS} (§5a). */
    gate: text('gate', { enum: ADR_GATE_KINDS }),
    /** Gate status — CHECK-backed via {@link GATE_STATUSES}. */
    gateStatus: text('gate_status', { enum: GATE_STATUSES }),
    /** Self-FK → amended ADR. */
    amendsId: text('amends_id').references((): AnySQLiteColumn => tasksArchitectureDecisions.id, {
      onDelete: 'set null',
    }),
    /** Source file path. */
    filePath: text('file_path').notNull().default(''),
    /** Optional short summary. */
    summary: text('summary'),
    /** Optional JSON keyword array (TEXT per JSON audit). */
    keywords: text('keywords'),
    /** Optional JSON topic array (TEXT per JSON audit). */
    topics: text('topics'),
  },
  (table) => [
    index('idx_tasks_architecture_decisions_status').on(table.status),
    index('idx_tasks_architecture_decisions_amends_id').on(table.amendsId),
  ],
);

/**
 * `tasks_adr_task_links` — ADR↔task junction.
 *
 * @task T11360 (target shape)
 */
export const tasksAdrTaskLinks = sqliteTable(
  'tasks_adr_task_links',
  {
    /** FK → `tasks_architecture_decisions.id`. ON DELETE CASCADE. */
    adrId: text('adr_id')
      .notNull()
      .references(() => tasksArchitectureDecisions.id, { onDelete: 'cascade' }),
    /** FK → `tasks_tasks.id` (resolved at exodus). */
    taskId: text('task_id').notNull(),
    /** Link type — CHECK-backed via {@link ADR_TASK_LINK_TYPES} (§5a). */
    linkType: text('link_type', { enum: ADR_TASK_LINK_TYPES }).notNull().default('related'),
  },
  (table) => [
    primaryKey({ columns: [table.adrId, table.taskId] }),
    index('idx_tasks_adr_task_links_task_id').on(table.taskId),
  ],
);

/**
 * `tasks_adr_relations` — ADR↔ADR cross-reference junction.
 *
 * @task T11360 (target shape)
 */
export const tasksAdrRelations = sqliteTable(
  'tasks_adr_relations',
  {
    /** FK → `tasks_architecture_decisions.id` (source). ON DELETE CASCADE. */
    fromAdrId: text('from_adr_id')
      .notNull()
      .references(() => tasksArchitectureDecisions.id, { onDelete: 'cascade' }),
    /** FK → `tasks_architecture_decisions.id` (target). ON DELETE CASCADE. */
    toAdrId: text('to_adr_id')
      .notNull()
      .references(() => tasksArchitectureDecisions.id, { onDelete: 'cascade' }),
    /** Relation type — CHECK-backed via {@link ADR_RELATION_TYPES} (§5a). */
    relationType: text('relation_type', { enum: ADR_RELATION_TYPES }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.fromAdrId, table.toAdrId, table.relationType] })],
);

/**
 * `tasks_status_registry` — canonical status registry (ADR-018).
 *
 * @task T11360 (target shape)
 */
export const tasksStatusRegistry = sqliteTable(
  'tasks_status_registry',
  {
    /** Status name. */
    name: text('name').notNull(),
    /** Entity type — CHECK-backed via {@link STATUS_REGISTRY_ENTITY_TYPES} (§5a). */
    entityType: text('entity_type', { enum: STATUS_REGISTRY_ENTITY_TYPES }).notNull(),
    /** Namespace — CHECK-backed via {@link STATUS_REGISTRY_NAMESPACES} (§5a). */
    namespace: text('namespace', { enum: STATUS_REGISTRY_NAMESPACES }).notNull(),
    /** Human-readable description. */
    description: text('description').notNull(),
    /** Whether the status is terminal. §3a boolean — already typed, preserved. */
    isTerminal: integer('is_terminal', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.name, table.entityType] }),
    index('idx_tasks_status_registry_entity_type').on(table.entityType),
    index('idx_tasks_status_registry_namespace').on(table.namespace),
  ],
);

// === TYPE EXPORTS ===

/** Row type for `tasks_schema_meta` SELECT queries (target shape). */
export type TasksSchemaMetaRow = typeof tasksSchemaMeta.$inferSelect;
/** Row type for `tasks_schema_meta` INSERT operations (target shape). */
export type NewTasksSchemaMetaRow = typeof tasksSchemaMeta.$inferInsert;
/** Row type for `tasks_audit_log` SELECT queries (target shape). */
export type TasksAuditLogRow = typeof tasksAuditLog.$inferSelect;
/** Row type for `tasks_audit_log` INSERT operations (target shape). */
export type NewTasksAuditLogRow = typeof tasksAuditLog.$inferInsert;
/** Row type for `tasks_token_usage` SELECT queries (target shape). */
export type TasksTokenUsageRow = typeof tasksTokenUsage.$inferSelect;
/** Row type for `tasks_token_usage` INSERT operations (target shape). */
export type NewTasksTokenUsageRow = typeof tasksTokenUsage.$inferInsert;
/** Row type for `tasks_architecture_decisions` SELECT queries (target shape). */
export type TasksArchitectureDecisionRow = typeof tasksArchitectureDecisions.$inferSelect;
/** Row type for `tasks_architecture_decisions` INSERT operations (target shape). */
export type NewTasksArchitectureDecisionRow = typeof tasksArchitectureDecisions.$inferInsert;
/** Row type for `tasks_adr_task_links` SELECT queries (target shape). */
export type TasksAdrTaskLinkRow = typeof tasksAdrTaskLinks.$inferSelect;
/** Row type for `tasks_adr_task_links` INSERT operations (target shape). */
export type NewTasksAdrTaskLinkRow = typeof tasksAdrTaskLinks.$inferInsert;
/** Row type for `tasks_adr_relations` SELECT queries (target shape). */
export type TasksAdrRelationRow = typeof tasksAdrRelations.$inferSelect;
/** Row type for `tasks_adr_relations` INSERT operations (target shape). */
export type NewTasksAdrRelationRow = typeof tasksAdrRelations.$inferInsert;
/** Row type for `tasks_status_registry` SELECT queries (target shape). */
export type TasksStatusRegistryRow = typeof tasksStatusRegistry.$inferSelect;
/** Row type for `tasks_status_registry` INSERT operations (target shape). */
export type NewTasksStatusRegistryRow = typeof tasksStatusRegistry.$inferInsert;
