/**
 * Global-scope `cleo.db` — consolidated **nexus** domain (10 tables).
 *
 * Part of the consolidated GLOBAL-scope `cleo.db` target shape authored for
 * SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2, task T11361). Target-shape
 * authoring only — physical names carry the `nexus_` domain prefix. The live
 * runtime modules `schema/nexus-schema.ts` + `schema/code-index.ts` keep their
 * UNPREFIXED / partially-prefixed names until the exodus migration (T11248)
 * swaps the substrate to this shape.
 *
 * ## Idempotent prefixer (AC1)
 *
 * Five source tables already carry the recognized `nexus_` prefix and are NOT
 * double-prefixed: `nexus_audit_log` · `nexus_schema_meta` · `nexus_nodes` ·
 * `nexus_relations` · `nexus_contracts`. The remaining five bare tables gain the
 * domain prefix at exodus: `project_registry` → `nexus_project_registry` ·
 * `project_id_aliases` → `nexus_project_id_aliases` · `user_profile` →
 * `nexus_user_profile` · `sigils` → `nexus_sigils` · `code_index` →
 * `nexus_code_index` (the relocated tree-sitter symbol index, formerly in
 * `nexus.db` alongside the registry).
 *
 * ## E10 typing applied
 *
 * - **§4 timestamps (Drizzle-Date non-conformers → TEXT ISO8601):**
 *   `nexus_user_profile.{first_observed_at,last_reinforced_at}` and
 *   `nexus_sigils.{created_at,updated_at}` were `integer({ mode:'timestamp' })`
 *   (the 4 Date non-conformers in §4). They become canonical `text` ISO8601;
 *   the matching `CHECK (col GLOB 'YYYY-MM-DD*')` ships as raw DDL at exodus.
 * - **§5b enum-like bare TEXT → `{ enum }`:** `nexus_sigils.role` →
 *   `{ enum: SIGIL_ROLES }` and `nexus_code_index.kind` →
 *   `{ enum: CODE_INDEX_KINDS }`. The const arrays below are minted in-module
 *   (no cross-package contracts const exists for either) per §5b — the CHECK
 *   list derives from the identifier, never a hand-typed literal.
 * - **§3a already-conformant booleans:** `nexus_nodes.{is_exported,is_external}`
 *   and `nexus_code_index.exported` keep `{ mode:'boolean' }`; only the SQL
 *   `CHECK (col IN (0,1))` is added at exodus.
 *
 * ## FK reconciliation to single-file Pattern A (AC4)
 *
 * The nexus source used soft FKs (plain `text` + `@cross-db` annotations) for
 * every cross-table reference; none crossed file boundaries via a real
 * `.references()`. Under the consolidated GLOBAL `cleo.db` they remain plain
 * `text` soft FKs:
 *   - intra-nexus refs (`nexus_nodes.project_id` → `nexus_project_registry`,
 *     `nexus_relations.{source_id,target_id}` → `nexus_nodes`, `parent_id`)
 *     stay soft because the source never declared them as enforced FKs and the
 *     graph stores unresolved external specifiers in the same column.
 *   - cross-domain refs (`nexus_audit_log.session_id` → project-scope
 *     `tasks_sessions`, `nexus_user_profile.derived_from_message_id` →
 *     `conduit_session_messages`) point at the PROJECT-scope `cleo.db`, so they
 *     CANNOT be native FKs — they remain soft TEXT, resolved by the nexus
 *     accessor. No ATTACH; no cross-file FK.
 *
 * @task T11361
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §1 (D1″ · global counts) · §4 · §5b
 * @see docs/migration/sqlite-schema-columns.json (per-column affinity SSoT)
 * @see ../nexus-schema.ts · ../code-index.ts (the runtime source modules)
 */

import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// E10 §5b — enum const arrays minted in-module (no cross-package contracts SSoT)
// ---------------------------------------------------------------------------

/**
 * Legal `nexus_sigils.role` values — the `.cant` agent role taxonomy.
 *
 * E10 §5b: `sigils.role` was bare `text('role')` (default `''`). The value is
 * the `role:` frontmatter field of a `.cant` agent file, parsed by
 * `nexus/sigil-sync.ts`. The legal set enumerated from the writer + canonical
 * seed roster (`project-orchestrator`, `project-dev-lead`, `project-*-worker`)
 * and the parsed-sigil fixtures (`subagent`, `specialist`). `''` is retained
 * because the column defaults to empty before a `.cant` role is associated.
 *
 * @task T11361
 */
export const SIGIL_ROLES = [
  '',
  'orchestrator',
  'lead',
  'worker',
  'subagent',
  'specialist',
  'validator',
] as const;

/** TypeScript union derived from {@link SIGIL_ROLES}. */
export type SigilRole = (typeof SIGIL_ROLES)[number];

/**
 * Legal `nexus_code_index.kind` values — tree-sitter symbol capture kinds.
 *
 * E10 §5b: `code_index.kind` was bare `text('kind')`. The legal set is the
 * symbol-kind taxonomy documented on the source column (the tree-sitter capture
 * groups): structural / module / callable / type-hierarchy / value-level
 * constructs. Kept as an in-module const so the exodus CHECK derives from this
 * identifier rather than a hand-typed literal.
 *
 * @task T11361
 */
export const CODE_INDEX_KINDS = [
  'function',
  'method',
  'class',
  'interface',
  'type',
  'enum',
  'variable',
  'constant',
  'module',
  'import',
  'export',
  'struct',
  'trait',
  'impl',
] as const;

/** TypeScript union derived from {@link CODE_INDEX_KINDS}. */
export type CodeIndexKind = (typeof CODE_INDEX_KINDS)[number];

// ---------------------------------------------------------------------------
// Registry + aliases
// ---------------------------------------------------------------------------

/**
 * `nexus_project_registry` — central registry of all CLEO projects known to the
 * Nexus (one row per project). Bare `project_registry` → `nexus_project_registry`
 * under the AC1 idempotent prefixer.
 *
 * @task T11361 (target shape) · T5365 / T529 (original)
 */
export const nexusProjectRegistry = sqliteTable(
  'nexus_project_registry',
  {
    /** Canonical 12-hex-char project identifier (T9149 W5). Primary key. */
    projectId: text('project_id').primaryKey(),
    /** Stable project hash (unique). */
    projectHash: text('project_hash').notNull().unique(),
    /** Absolute filesystem path that owns this project_id (unique). */
    projectPath: text('project_path').notNull().unique(),
    /** Human-readable project name. */
    name: text('name').notNull(),
    /** ISO-8601 UTC registration instant (canonical TEXT, §4). */
    registeredAt: text('registered_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-seen instant (canonical TEXT, §4). */
    lastSeen: text('last_seen').notNull().default(sql`(datetime('now'))`),
    /** Health status string (e.g. "healthy", "warning", "unknown"). */
    healthStatus: text('health_status').notNull().default('unknown'),
    /** ISO-8601 UTC last health-check instant; NULL until first check. */
    healthLastCheck: text('health_last_check'),
    /** Permission level ("read" / "write"). */
    permissions: text('permissions').notNull().default('read'),
    /** ISO-8601 UTC last-sync instant (canonical TEXT, §4). */
    lastSync: text('last_sync').notNull().default(sql`(datetime('now'))`),
    /** Cached task count for the project. */
    taskCount: integer('task_count').notNull().default(0),
    /** JSON array of project labels (serialized TEXT per JSON-Column Audit). */
    labelsJson: text('labels_json').notNull().default('[]'),
    /** Absolute path to the project's project-scope `cleo.db` brain partition. */
    brainDbPath: text('brain_db_path'),
    /** Absolute path to the project's project-scope `cleo.db` tasks partition. */
    tasksDbPath: text('tasks_db_path'),
    /** ISO-8601 UTC last successful code-intelligence index run; NULL until indexed. */
    lastIndexed: text('last_indexed'),
    /** JSON object with per-project code-intelligence stats (serialized TEXT). */
    statsJson: text('stats_json').notNull().default('{}'),
  },
  (table) => [
    index('idx_nexus_project_registry_hash').on(table.projectHash),
    index('idx_nexus_project_registry_health').on(table.healthStatus),
    index('idx_nexus_project_registry_name').on(table.name),
    index('idx_nexus_project_registry_last_indexed').on(table.lastIndexed),
  ],
);

/**
 * `nexus_project_id_aliases` — maps legacy base64url(path) project IDs to their
 * canonical IDs (T9149 W5). Bare `project_id_aliases` → `nexus_project_id_aliases`.
 *
 * @task T11361 (target shape) · T9149 (original)
 */
export const nexusProjectIdAliases = sqliteTable(
  'nexus_project_id_aliases',
  {
    /** Legacy base64url(path) ID. Primary key. */
    legacyId: text('legacy_id').primaryKey(),
    /** Canonical 12-hex-char ID this alias maps to (soft FK → nexus_project_registry). */
    canonicalId: text('canonical_id').notNull(),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_nexus_project_id_aliases_canonical').on(table.canonicalId)],
);

// ---------------------------------------------------------------------------
// Audit + schema meta
// ---------------------------------------------------------------------------

/**
 * `nexus_audit_log` — append-only audit log for all Nexus operations across
 * projects. Already domain-prefixed; the idempotent prefixer is a no-op.
 *
 * @task T11361 (target shape) · T5365 (original)
 */
export const nexusAuditLog = sqliteTable(
  'nexus_audit_log',
  {
    /** UUID primary key. */
    id: text('id').primaryKey(),
    /** ISO-8601 UTC instant of the audited operation (canonical TEXT, §4). */
    timestamp: text('timestamp').notNull().default(sql`(datetime('now'))`),
    /** Audited action name. */
    action: text('action').notNull(),
    /** Project hash context; NULL for global operations. */
    projectHash: text('project_hash'),
    /** Project id (soft FK → nexus_project_registry.project_id). */
    projectId: text('project_id'),
    /** Operation domain (e.g. "tasks", "memory"). */
    domain: text('domain'),
    /** Operation name. */
    operation: text('operation'),
    /**
     * Project-tier session that issued the audited operation.
     *
     * Cross-domain soft FK → PROJECT-scope `cleo.db` `tasks_sessions.id`.
     * CANNOT be a native FK (different scope DB file); resolved by the nexus
     * accessor (AC4 — no ATTACH).
     */
    sessionId: text('session_id'),
    /** Correlated request id. */
    requestId: text('request_id'),
    /** Originating source/process. */
    source: text('source'),
    /** CQRS gateway ("query" / "mutate"). */
    gateway: text('gateway'),
    /** Outcome flag (numeric LAFS code echo; not a strict 0/1 boolean). */
    success: integer('success'),
    /** Wall-clock duration in milliseconds. */
    durationMs: integer('duration_ms'),
    /** JSON detail blob (serialized TEXT). */
    detailsJson: text('details_json').default('{}'),
    /** Error message when the operation failed. */
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

/**
 * `nexus_schema_meta` — key-value schema-version tracking (single-table KV).
 * Already domain-prefixed.
 *
 * @task T11361 (target shape) · T5365 (original)
 */
export const nexusSchemaMeta = sqliteTable('nexus_schema_meta', {
  /** Config key. */
  key: text('key').primaryKey(),
  /** Config value. */
  value: text('value').notNull(),
});

// ---------------------------------------------------------------------------
// Code-intelligence graph
// ---------------------------------------------------------------------------

/**
 * All node kind values — matches `GraphNodeKind` in `@cleocode/contracts`.
 * Kept as a const tuple for the Drizzle enum column. Ordering intentional:
 * structural → module → callable → type → value-level → language-specific →
 * graph-level → legacy.
 *
 * @task T11361 (target shape) · T529 (original)
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

/** TypeScript type derived from {@link NEXUS_NODE_KINDS}. */
export type NexusNodeKind = (typeof NEXUS_NODE_KINDS)[number];

/**
 * `nexus_nodes` — one row per symbol or structural element in the code
 * intelligence graph. Already domain-prefixed.
 *
 * @task T11361 (target shape) · T529 (original)
 */
export const nexusNodes = sqliteTable(
  'nexus_nodes',
  {
    /** Stable node ID (`<filePath>::<name>` / `<filePath>` / `community:<n>` / `process:<slug>`). */
    id: text('id').primaryKey(),
    /** Owning project (soft FK → nexus_project_registry.project_id). */
    projectId: text('project_id').notNull(),
    /** Node kind from {@link NEXUS_NODE_KINDS} (E10 §5a — already enum-typed). */
    kind: text('kind', { enum: NEXUS_NODE_KINDS }).notNull(),
    /** Human-readable display label. */
    label: text('label').notNull(),
    /** Symbol name as it appears in source; NULL for file/folder nodes. */
    name: text('name'),
    /** File path relative to project root; NULL for community/process nodes. */
    filePath: text('file_path'),
    /** Start line (1-based); NULL for structural nodes. */
    startLine: integer('start_line'),
    /** End line (1-based); NULL for structural nodes. */
    endLine: integer('end_line'),
    /** Source language (typescript, python, go, rust, …). */
    language: text('language'),
    /** Whether the symbol is publicly exported (E10 §3a — typed boolean). */
    isExported: integer('is_exported', { mode: 'boolean' }).notNull().default(false),
    /** Parent node id for nested symbols (intra-nexus soft FK → nexus_nodes.id). */
    parentId: text('parent_id'),
    /** JSON array of parameter name strings (serialized TEXT). */
    parametersJson: text('parameters_json'),
    /** Return-type annotation text. */
    returnType: text('return_type'),
    /** First line of the leading TSDoc/JSDoc comment. */
    docSummary: text('doc_summary'),
    /** Community membership id (soft FK → the community node's nexus_nodes.id). */
    communityId: text('community_id'),
    /** JSON blob for kind-specific metadata (serialized TEXT). */
    metaJson: text('meta_json'),
    /** Whether this node is an external/unresolved module (E10 §3a — typed boolean). */
    isExternal: integer('is_external', { mode: 'boolean' }).notNull().default(false),
    /** ISO-8601 UTC last-indexed instant (canonical TEXT, §4). */
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

/**
 * All relation type values — matches `GraphRelationType` in `@cleocode/contracts`.
 *
 * @task T11361 (target shape) · T529 (original)
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
  'member_of',
  'step_in_process',
  // Web / API
  'handles_route',
  'fetches',
  // Tool / agent
  'handles_tool',
  'entry_point_of',
  // Wrapping / delegation
  'wraps',
  // Data access
  'queries',
  // Cross-graph (brain link)
  'documents',
  'applies_to',
  // Plasticity co-access relations (T998)
  'co_changed',
  'co_cited_in_task',
] as const;

/** TypeScript type derived from {@link NEXUS_RELATION_TYPES}. */
export type NexusRelationType = (typeof NEXUS_RELATION_TYPES)[number];

/**
 * `nexus_relations` — one row per directed graph edge. Already domain-prefixed.
 *
 * @task T11361 (target shape) · T529 (original)
 */
export const nexusRelations = sqliteTable(
  'nexus_relations',
  {
    /** UUID v4 row identifier. */
    id: text('id').primaryKey(),
    /** Owning project (soft FK → nexus_project_registry.project_id). */
    projectId: text('project_id').notNull(),
    /** Source node id (intra-nexus soft FK → nexus_nodes.id). */
    sourceId: text('source_id').notNull(),
    /** Target node id or raw module specifier (intra-nexus soft FK → nexus_nodes.id). */
    targetId: text('target_id').notNull(),
    /** Semantic relation type from {@link NEXUS_RELATION_TYPES} (E10 §5a). */
    type: text('type', { enum: NEXUS_RELATION_TYPES }).notNull(),
    /** Extractor confidence [0.0, 1.0]. */
    confidence: real('confidence').notNull(),
    /** Human-readable note explaining why this relation was emitted. */
    reason: text('reason'),
    /** Step index within an execution flow (for step_in_process relations). */
    step: integer('step'),
    /** ISO-8601 UTC last-indexed instant (canonical TEXT, §4). */
    indexedAt: text('indexed_at').notNull().default(sql`(datetime('now'))`),
    /** Plasticity weight in [0.0, 1.0] (T998 Hebbian co-access strengthening). */
    weight: real('weight').default(0.0),
    /** ISO-8601 UTC last co-access strengthening instant; NULL until first strengthen. */
    lastAccessedAt: text('last_accessed_at'),
    /** Number of co-access strengthening events. */
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
    index('idx_nexus_relations_last_accessed').on(table.lastAccessedAt),
  ],
);

/**
 * All contract type values for cross-project API extraction.
 *
 * @task T11361 (target shape) · T1065 (original)
 */
export const NEXUS_CONTRACT_TYPES = ['http', 'grpc', 'topic'] as const;

/** TypeScript type derived from {@link NEXUS_CONTRACT_TYPES}. */
export type NexusContractType = (typeof NEXUS_CONTRACT_TYPES)[number];

/**
 * `nexus_contracts` — cross-project HTTP/gRPC/topic contract registry. Already
 * domain-prefixed.
 *
 * @task T11361 (target shape) · T1065 (original)
 */
export const nexusContracts = sqliteTable(
  'nexus_contracts',
  {
    /** Unique contract id. Primary key. */
    contractId: text('contract_id').primaryKey(),
    /** Owning project (soft FK → nexus_project_registry.project_id). */
    projectId: text('project_id').notNull(),
    /** Contract type from {@link NEXUS_CONTRACT_TYPES} (E10 §5a). */
    type: text('type', { enum: NEXUS_CONTRACT_TYPES }).notNull(),
    /** Path or endpoint identifier. */
    path: text('path').notNull(),
    /** HTTP/gRPC method; NULL for topics. */
    method: text('method'),
    /** Request schema as JSON string (serialized TEXT). */
    requestSchemaJson: text('request_schema_json').notNull().default('{}'),
    /** Response schema as JSON string (serialized TEXT). */
    responseSchemaJson: text('response_schema_json').notNull().default('{}'),
    /** Source symbol id (soft FK → nexus_nodes.id). */
    sourceSymbolId: text('source_symbol_id'),
    /** Route node id (soft FK → nexus_nodes.id). */
    routeNodeId: text('route_node_id'),
    /** Extraction confidence [0..1]. */
    confidence: real('confidence').notNull().default(1.0),
    /** Human-readable description. */
    description: text('description'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
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

/**
 * `nexus_code_index` — persistent index of code symbols extracted by
 * tree-sitter (one row per symbol per file). Bare `code_index` →
 * `nexus_code_index` under the AC1 idempotent prefixer (the relocated
 * code-intelligence index that lived in `nexus.db` alongside the registry).
 *
 * @task T11361 (target shape) · original `code-index.ts`
 */
export const nexusCodeIndex = sqliteTable(
  'nexus_code_index',
  {
    /** Stable row identifier (UUID v4). Primary key. */
    id: text('id').primaryKey(),
    /** Owning project (soft FK → nexus_project_registry.project_id). */
    projectId: text('project_id').notNull(),
    /** Relative file path within the project root. */
    filePath: text('file_path').notNull(),
    /** Symbol name as extracted from the AST. */
    symbolName: text('symbol_name').notNull(),
    /** Symbol kind from {@link CODE_INDEX_KINDS} (E10 §5b — was bare TEXT). */
    kind: text('kind', { enum: CODE_INDEX_KINDS }).notNull(),
    /** Start line in the source file (1-based). */
    startLine: integer('start_line').notNull(),
    /** End line in the source file (1-based). */
    endLine: integer('end_line').notNull(),
    /** Source language detected from the file extension. */
    language: text('language').notNull(),
    /** Whether the symbol has an `export` modifier (E10 §3a — typed boolean). */
    exported: integer('exported', { mode: 'boolean' }).default(false),
    /** Parent symbol name for nested declarations; NULL at module scope. */
    parent: text('parent'),
    /** Return-type annotation extracted from the declaration. */
    returnType: text('return_type'),
    /** First line of the leading JSDoc/docstring comment. */
    docSummary: text('doc_summary'),
    /** ISO-8601 UTC last-indexed instant (canonical TEXT, §4). */
    indexedAt: text('indexed_at').notNull(),
  },
  (table) => [
    index('idx_nexus_code_index_project').on(table.projectId),
    index('idx_nexus_code_index_file').on(table.filePath),
    index('idx_nexus_code_index_symbol').on(table.symbolName),
    index('idx_nexus_code_index_kind').on(table.kind),
  ],
);

// ---------------------------------------------------------------------------
// Global identity / preference layers
// ---------------------------------------------------------------------------

/**
 * `nexus_user_profile` — global user identity / preference profile (PSYCHE
 * Wave 1, T1077). Bare `user_profile` → `nexus_user_profile`.
 *
 * E10 §4: `first_observed_at` / `last_reinforced_at` were
 * `integer({ mode:'timestamp' })` (Drizzle-Date non-conformers) — now canonical
 * TEXT ISO8601.
 *
 * @task T11361 (target shape) · T1077 (original)
 */
export const nexusUserProfile = sqliteTable(
  'nexus_user_profile',
  {
    /** Stable semantic trait key. Primary key — traits are upserted by key. */
    traitKey: text('trait_key').primaryKey(),
    /** JSON-encoded trait value (serialized TEXT). */
    traitValue: text('trait_value').notNull(),
    /** Bayesian confidence in [0.0, 1.0]. */
    confidence: real('confidence').notNull(),
    /** Trait origin (e.g. "dialectic:<sessionId>", "import:...", "manual"). */
    source: text('source').notNull(),
    /**
     * Source message id.
     *
     * Cross-domain soft FK → PROJECT-scope `cleo.db`
     * `conduit_session_messages.id` (RESERVED — table ships in Wave 5 / T1145).
     * CANNOT be a native FK (different scope DB file); resolved by the nexus
     * accessor (AC4 — no ATTACH).
     */
    derivedFromMessageId: text('derived_from_message_id'),
    /** ISO-8601 UTC first-observed instant (E10 §4: Drizzle-Date → TEXT ISO8601). */
    firstObservedAt: text('first_observed_at').notNull(),
    /** ISO-8601 UTC last-reinforced instant (E10 §4: Drizzle-Date → TEXT ISO8601). */
    lastReinforcedAt: text('last_reinforced_at').notNull(),
    /** Number of reinforcement events (starts at 1). */
    reinforcementCount: integer('reinforcement_count').notNull().default(1),
    /** traitKey of the trait that supersedes this one (T1139 supersession graph). */
    supersededBy: text('superseded_by'),
  },
  (table) => [
    index('idx_nexus_user_profile_confidence').on(table.confidence),
    index('idx_nexus_user_profile_source').on(table.source),
    index('idx_nexus_user_profile_last_reinforced').on(table.lastReinforcedAt),
    index('idx_nexus_user_profile_superseded').on(table.supersededBy),
  ],
);

/**
 * `nexus_sigils` — peer-card sigil identity layer for CANT agents (PSYCHE
 * Wave 8, T1148). Bare `sigils` → `nexus_sigils`.
 *
 * E10 §5b: `role` was bare `text('role')` → `{ enum: SIGIL_ROLES }`.
 * E10 §4: `created_at` / `updated_at` were `integer({ mode:'timestamp' })`
 * (Drizzle-Date non-conformers) — now canonical TEXT ISO8601.
 *
 * @task T11361 (target shape) · T1148 (original)
 */
export const nexusSigils = sqliteTable(
  'nexus_sigils',
  {
    /** Stable peer id (matches `peer_id` on brain tables). Primary key. */
    peerId: text('peer_id').primaryKey(),
    /** Absolute/relative path to the CANT (.cant) agent file; NULL if unassociated. */
    cantFile: text('cant_file'),
    /** Human-readable display name. */
    displayName: text('display_name').notNull().default(''),
    /** Short role from {@link SIGIL_ROLES} (E10 §5b — was bare TEXT). */
    role: text('role', { enum: SIGIL_ROLES }).notNull().default(''),
    /** System-prompt fragment injected into spawn payloads; NULL if none. */
    systemPromptFragment: text('system_prompt_fragment'),
    /** JSON-encoded capability flags object (serialized TEXT); NULL until set. */
    capabilityFlags: text('capability_flags'),
    /** ISO-8601 UTC creation instant (E10 §4: Drizzle-Date → TEXT ISO8601). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (E10 §4: Drizzle-Date → TEXT ISO8601). */
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_nexus_sigils_display_name').on(table.displayName),
    index('idx_nexus_sigils_role').on(table.role),
  ],
);

// ---------------------------------------------------------------------------
// Inferred row + insert types
// ---------------------------------------------------------------------------

/** Row type for `nexus_project_registry` SELECT (target shape). */
export type NexusProjectRegistryRow = typeof nexusProjectRegistry.$inferSelect;
/** Row type for `nexus_project_registry` INSERT (target shape). */
export type NewNexusProjectRegistryRow = typeof nexusProjectRegistry.$inferInsert;
/** Row type for `nexus_project_id_aliases` SELECT (target shape). */
export type NexusProjectIdAliasRow = typeof nexusProjectIdAliases.$inferSelect;
/** Row type for `nexus_project_id_aliases` INSERT (target shape). */
export type NewNexusProjectIdAliasRow = typeof nexusProjectIdAliases.$inferInsert;
/** Row type for `nexus_audit_log` SELECT (target shape). */
export type NexusAuditLogRow = typeof nexusAuditLog.$inferSelect;
/** Row type for `nexus_audit_log` INSERT (target shape). */
export type NewNexusAuditLogRow = typeof nexusAuditLog.$inferInsert;
/** Row type for `nexus_schema_meta` SELECT (target shape). */
export type NexusSchemaMetaRow = typeof nexusSchemaMeta.$inferSelect;
/** Row type for `nexus_schema_meta` INSERT (target shape). */
export type NewNexusSchemaMetaRow = typeof nexusSchemaMeta.$inferInsert;
/** Row type for `nexus_nodes` SELECT (target shape). */
export type NexusNodeRow = typeof nexusNodes.$inferSelect;
/** Row type for `nexus_nodes` INSERT (target shape). */
export type NewNexusNodeRow = typeof nexusNodes.$inferInsert;
/** Row type for `nexus_relations` SELECT (target shape). */
export type NexusRelationRow = typeof nexusRelations.$inferSelect;
/** Row type for `nexus_relations` INSERT (target shape). */
export type NewNexusRelationRow = typeof nexusRelations.$inferInsert;
/** Row type for `nexus_contracts` SELECT (target shape). */
export type NexusContractRow = typeof nexusContracts.$inferSelect;
/** Row type for `nexus_contracts` INSERT (target shape). */
export type NewNexusContractRow = typeof nexusContracts.$inferInsert;
/** Row type for `nexus_code_index` SELECT (target shape). */
export type NexusCodeIndexRow = typeof nexusCodeIndex.$inferSelect;
/** Row type for `nexus_code_index` INSERT (target shape). */
export type NewNexusCodeIndexRow = typeof nexusCodeIndex.$inferInsert;
/** Row type for `nexus_user_profile` SELECT (target shape). */
export type NexusUserProfileRow = typeof nexusUserProfile.$inferSelect;
/** Row type for `nexus_user_profile` INSERT (target shape). */
export type NewNexusUserProfileRow = typeof nexusUserProfile.$inferInsert;
/** Row type for `nexus_sigils` SELECT (target shape). */
export type NexusSigilRow = typeof nexusSigils.$inferSelect;
/** Row type for `nexus_sigils` INSERT (target shape). */
export type NewNexusSigilRow = typeof nexusSigils.$inferInsert;
