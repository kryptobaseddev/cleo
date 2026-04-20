/**
 * Drizzle ORM schema for CLEO nexus.db (SQLite via node:sqlite + sqlite-proxy).
 *
 * Tables: project_registry, nexus_audit_log, nexus_schema_meta,
 *         nexus_nodes, nexus_relations
 * Stores cross-project registry and audit infrastructure for the Nexus domain,
 * plus the code intelligence graph layer (nodes + directed edges).
 *
 * @task T5365
 * @task T529
 */

import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
    /** Absolute path to the project's brain.db file. */
    brainDbPath: text('brain_db_path'),
    /** Absolute path to the project's tasks.db file. */
    tasksDbPath: text('tasks_db_path'),
    /** ISO 8601 timestamp of the last successful code intelligence index run. */
    lastIndexed: text('last_indexed'),
    /** JSON object with per-project code intelligence stats (node_count, relation_count, file_count). */
    statsJson: text('stats_json').notNull().default('{}'),
  },
  (table) => [
    index('idx_project_registry_hash').on(table.projectHash),
    index('idx_project_registry_health').on(table.healthStatus),
    index('idx_project_registry_name').on(table.name),
    index('idx_project_registry_last_indexed').on(table.lastIndexed),
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

// === NEXUS_NODES TABLE ===

/**
 * All node kind values — matches GraphNodeKind in @cleocode/contracts.
 *
 * Kept as a const tuple for use in Drizzle enum column definitions.
 * The ordering is intentional: structural → module → callable → type →
 * value-level → language-specific → graph-level → legacy.
 */
export const NEXUS_NODE_KINDS = [
  // Structural
  'file',
  'folder',
  // Module-level
  'module',
  'namespace',
  // Callable
  'function',
  'method',
  'constructor',
  // Type hierarchy
  'class',
  'interface',
  'struct',
  'trait',
  'impl',
  'type_alias',
  'enum',
  // Value-level
  'property',
  'constant',
  'variable',
  'static',
  'record',
  'delegate',
  // Language-specific constructs
  'macro',
  'union',
  'typedef',
  'annotation',
  'template',
  // Graph-level (synthetic nodes from analysis phases)
  'community',
  'process',
  'route',
  // External references
  'tool',
  'section',
  // Legacy (kept for T506 compatibility)
  'import',
  'export',
  'type',
] as const;

/** TypeScript type derived from NEXUS_NODE_KINDS. */
export type NexusNodeKind = (typeof NEXUS_NODE_KINDS)[number];

/**
 * Graph nodes table — one row per symbol or structural element.
 *
 * Stores all code intelligence graph nodes indexed per project.
 * Synthetic nodes (community, process) share this table with
 * source-derived nodes (function, class, file).
 *
 * Both this table and `code_index` are populated from the same parse pass.
 * They serve complementary roles — do NOT merge them.
 *
 * @task T529
 */
export const nexusNodes = sqliteTable(
  'nexus_nodes',
  {
    /** Stable node ID. Format: `<filePath>::<name>` for symbols,
     *  `<filePath>` for file nodes, `community:<n>` for community nodes,
     *  `process:<slug>` for execution flow nodes. */
    id: text('id').primaryKey(),

    /** Foreign key to project_registry.project_id. Scopes the node. */
    projectId: text('project_id').notNull(),

    /** Node kind from GraphNodeKind union. */
    kind: text('kind', { enum: NEXUS_NODE_KINDS }).notNull(),

    /** Human-readable label for display. For symbols, same as name.
     *  For communities, the inferred folder label. For processes, the
     *  entry point function name. */
    label: text('label').notNull(),

    /** Symbol name as it appears in source code. Null for file/folder nodes. */
    name: text('name'),

    /** File path relative to project root. Null for community/process nodes. */
    filePath: text('file_path'),

    /** Start line in source file (1-based). Null for structural nodes. */
    startLine: integer('start_line'),

    /** End line in source file (1-based). Null for structural nodes. */
    endLine: integer('end_line'),

    /** Source language (typescript, python, go, rust, etc.). */
    language: text('language'),

    /** Whether the symbol is publicly exported from its module. */
    isExported: integer('is_exported', { mode: 'boolean' }).notNull().default(false),

    /** Parent node ID for nested symbols (e.g., method inside class).
     *  References nexus_nodes.id in the same project. Soft FK. */
    parentId: text('parent_id'),

    /** JSON array of parameter name strings for functions/methods.
     *  Stored as `["param1","param2"]`. Null if not applicable. */
    parametersJson: text('parameters_json'),

    /** Return type annotation text (e.g., "Promise<void>"). */
    returnType: text('return_type'),

    /** First line of the TSDoc/JSDoc comment for this symbol. */
    docSummary: text('doc_summary'),

    /** Community membership ID — references the community node's id.
     *  Set during Phase 4.5 community detection. Null until then. */
    communityId: text('community_id'),

    /** JSON blob for kind-specific metadata.
     *  For `process` nodes: `{"stepCount": 7, "entryScore": 0.92}`.
     *  For `community` nodes: `{"memberCount": 14, "topFolders": ["src/core"]}`.
     *  For `route` nodes: `{"method": "GET", "path": "/api/v1/tasks"}`.
     *  For all others: null. */
    metaJson: text('meta_json'),

    /** Whether this node represents an external module (unresolved import).
     *  Set to true for ExternalModule nodes created by import processor when
     *  an import specifier cannot be resolved to a local file. */
    isExternal: integer('is_external', { mode: 'boolean' }).notNull().default(false),

    /** ISO 8601 timestamp when this node was last indexed. */
    indexedAt: text('indexed_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_nexus_nodes_project').on(table.projectId),
    index('idx_nexus_nodes_kind').on(table.kind),
    index('idx_nexus_nodes_file').on(table.filePath),
    index('idx_nexus_nodes_name').on(table.name),
    index('idx_nexus_nodes_project_kind').on(table.projectId, table.kind),
    index('idx_nexus_nodes_project_file').on(table.projectId, table.filePath),
    index('idx_nexus_nodes_community').on(table.communityId),
    index('idx_nexus_nodes_parent').on(table.parentId),
    index('idx_nexus_nodes_exported').on(table.isExported),
    index('idx_nexus_nodes_is_external').on(table.isExternal),
  ],
);

// === NEXUS_RELATIONS TABLE ===

/**
 * All relation type values — matches GraphRelationType in @cleocode/contracts.
 *
 * Kept as a const tuple for use in Drizzle enum column definitions.
 */
export const NEXUS_RELATION_TYPES = [
  // Structural
  'contains',
  // Definition / usage
  'defines',
  'imports',
  'accesses',
  // Callable
  'calls',
  // Type hierarchy
  'extends',
  'implements',
  'method_overrides',
  'method_implements',
  // Class structure
  'has_method',
  'has_property',
  // Graph-level (synthetic, from analysis phases)
  'member_of', // symbol → community
  'step_in_process', // symbol → process
  // Web / API
  'handles_route', // function → route node
  'fetches', // function → external API
  // Tool / agent
  'handles_tool',
  'entry_point_of', // function → process
  // Wrapping / delegation
  'wraps',
  // Data access
  'queries',
  // Cross-graph (brain link)
  'documents', // brain_page_node → nexus_nodes
  'applies_to', // brain_page_node → nexus_nodes
  // Plasticity co-access relations (T998)
  'co_changed', // nodes frequently changed together in the same commit
  'co_cited_in_task', // nodes co-cited in the same task description
] as const;

/** TypeScript type derived from NEXUS_RELATION_TYPES. */
export type NexusRelationType = (typeof NEXUS_RELATION_TYPES)[number];

/**
 * Graph relations table — one row per directed edge.
 *
 * All graph traversal (impact, context, process detection) reads from
 * this table after ingestion completes.
 *
 * Source and target reference nexus_nodes.id. They are soft FKs —
 * unresolved targets (e.g., external packages) are stored as raw specifiers.
 *
 * @task T529
 */
export const nexusRelations = sqliteTable(
  'nexus_relations',
  {
    /** UUID v4 row identifier. */
    id: text('id').primaryKey(),

    /** Foreign key to project_registry.project_id. */
    projectId: text('project_id').notNull(),

    /** Source node ID (nexus_nodes.id). */
    sourceId: text('source_id').notNull(),

    /** Target node ID (nexus_nodes.id) or raw module specifier for
     *  unresolved imports. Example: `@cleocode/contracts` or
     *  `src/core/parser.ts::parseFile`. */
    targetId: text('target_id').notNull(),

    /** Semantic relation type. */
    type: text('type', { enum: NEXUS_RELATION_TYPES }).notNull(),

    /** Extractor confidence (0.0 to 1.0). */
    confidence: real('confidence').notNull(),

    /** Human-readable note explaining why this relation was emitted. */
    reason: text('reason'),

    /** Step index within an execution flow (for step_in_process relations). */
    step: integer('step'),

    /** ISO 8601 timestamp when this relation was last indexed. */
    indexedAt: text('indexed_at').notNull().default(sql`(datetime('now'))`),

    // T998: Plasticity columns for Hebbian co-access strengthening.
    // Edges strengthen over time as nodes are accessed together during retrieval.
    /** Plasticity weight in [0.0, 1.0]. Starts at 0.0; increments 0.05 per co-access; capped at 1.0. */
    weight: real('weight').default(0.0),
    /** ISO 8601 timestamp of the last co-access strengthening event. NULL until first strengthen. */
    lastAccessedAt: text('last_accessed_at'),
    /** Number of times this edge has been co-access strengthened. */
    coAccessedCount: integer('co_accessed_count').default(0),
  },
  (table) => [
    index('idx_nexus_relations_project').on(table.projectId),
    index('idx_nexus_relations_source').on(table.sourceId),
    index('idx_nexus_relations_target').on(table.targetId),
    index('idx_nexus_relations_type').on(table.type),
    index('idx_nexus_relations_project_type').on(table.projectId, table.type),
    index('idx_nexus_relations_source_type').on(table.sourceId, table.type),
    index('idx_nexus_relations_target_type').on(table.targetId, table.type),
    index('idx_nexus_relations_confidence').on(table.confidence),
    // T998: index for plasticity decay queries and temporal access tracking
    index('idx_nexus_relations_last_accessed').on(table.lastAccessedAt),
  ],
);

// === NEXUS_CONTRACTS TABLE ===

/**
 * All contract type values for extraction.
 *
 * Kept as a const tuple for use in Drizzle enum column definitions.
 *
 * @task T1065
 */
export const NEXUS_CONTRACT_TYPES = ['http', 'grpc', 'topic'] as const;

/** TypeScript type derived from NEXUS_CONTRACT_TYPES. */
export type NexusContractType = (typeof NEXUS_CONTRACT_TYPES)[number];

/**
 * Cross-project code contract registry for HTTP/gRPC/topic APIs.
 *
 * Stores extracted contracts keyed by type, path/method, and project.
 * Used to detect integration points and compatibility across projects.
 *
 * @task T1065
 */
export const nexusContracts = sqliteTable(
  'nexus_contracts',
  {
    /** Unique contract ID (format: `<type>:<projectId>::<path>::<method>` or similar). */
    contractId: text('contract_id').primaryKey(),

    /** Foreign key to project_registry.project_id. */
    projectId: text('project_id').notNull(),

    /** Contract type: 'http', 'grpc', 'topic'. */
    type: text('type', { enum: NEXUS_CONTRACT_TYPES }).notNull(),

    /** Path or endpoint identifier (HTTP: `/api/v1/tasks`, gRPC: `ServiceName`, Topic: `topic.name`). */
    path: text('path').notNull(),

    /** HTTP method (GET, POST, etc.) or gRPC method name. Null for topics. */
    method: text('method'),

    /** Request schema as JSON string. */
    requestSchemaJson: text('request_schema_json').notNull().default('{}'),

    /** Response schema as JSON string. */
    responseSchemaJson: text('response_schema_json').notNull().default('{}'),

    /** Source symbol ID (format: `<filePath>::<functionName>`). */
    sourceSymbolId: text('source_symbol_id'),

    /** Route node ID from nexus_nodes (if applicable). */
    routeNodeId: text('route_node_id'),

    /** Extraction confidence [0..1]. */
    confidence: real('confidence').notNull().default(1.0),

    /** Human-readable description. */
    description: text('description'),

    /** ISO 8601 timestamp when contract was extracted. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),

    /** ISO 8601 timestamp of last update. */
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_nexus_contracts_project').on(table.projectId),
    index('idx_nexus_contracts_type').on(table.type),
    index('idx_nexus_contracts_path').on(table.path),
    index('idx_nexus_contracts_method').on(table.method),
    index('idx_nexus_contracts_project_type').on(table.projectId, table.type),
    index('idx_nexus_contracts_source_symbol').on(table.sourceSymbolId),
    index('idx_nexus_contracts_created').on(table.createdAt),
  ],
);

// === TYPE EXPORTS ===

export type ProjectRegistryRow = typeof projectRegistry.$inferSelect;
export type NewProjectRegistryRow = typeof projectRegistry.$inferInsert;
export type NexusAuditLogRow = typeof nexusAuditLog.$inferSelect;
export type NewNexusAuditLogRow = typeof nexusAuditLog.$inferInsert;
export type NexusSchemaMetaRow = typeof nexusSchemaMeta.$inferSelect;
export type NewNexusSchemaMetaRow = typeof nexusSchemaMeta.$inferInsert;
export type NexusNodeRow = typeof nexusNodes.$inferSelect;
export type NewNexusNodeRow = typeof nexusNodes.$inferInsert;
export type NexusRelationRow = typeof nexusRelations.$inferSelect;
export type NewNexusRelationRow = typeof nexusRelations.$inferInsert;
export type NexusContractRow = typeof nexusContracts.$inferSelect;
export type NewNexusContractRow = typeof nexusContracts.$inferInsert;
