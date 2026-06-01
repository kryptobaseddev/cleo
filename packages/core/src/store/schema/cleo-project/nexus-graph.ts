/**
 * Project-scope `cleo.db` — consolidated **nexus code-graph** domain (4 tables).
 *
 * ## Residency move (ADR-090 · T11538 — residency step 1)
 *
 * The four per-project code/knowledge-graph tables — `nexus_nodes`,
 * `nexus_relations`, `nexus_contracts`, `nexus_code_index` (ADR-090 "Category A")
 * — wrongly lived in the GLOBAL-scope `cleo.db` (`../cleo-global/nexus.ts`),
 * each carrying a redundant `project_id text NOT NULL` soft FK to
 * `nexus_project_registry`. Per ADR-090 §2.1 they MUST reside in the consolidated
 * PROJECT-scope `cleo.db` (`<projectRoot>/.cleo/cleo.db`) so that `.cleo/`
 * becomes the complete portable living brain (tasks + memory + conduit + docs +
 * code-graph).
 *
 * This module authors that **target shape** for the PROJECT scope. It is
 * purely ADDITIVE: it DEFINES the four tables (minus `project_id`) so the
 * type-checker and the project-scope schema barrel see them. It does NOT yet
 * remove the global copies, move data, or rewire the live accessor — those are:
 *   - T11539: remove the four tables from `cleo-global/nexus.ts` + the
 *     extract-by-project data move (nexus global table count 10 → 6).
 *   - T11545: partition the Hebbian plasticity columns out of `nexus_relations`
 *     into the sibling `nexus_relation_weights` table (ADR-090 §5.3). That table
 *     also belongs in THIS module and MUST land with the move, not after — until
 *     then the plasticity columns (`weight`, `last_accessed_at`,
 *     `co_accessed_count`) stay inline on `nexus_relations` as they are in the
 *     global source.
 *
 * ## `project_id` DROPPED (ADR-090 §2.1)
 *
 * The `project_id` column is REMOVED from all four tables — scope is now
 * implicit in which project's `.cleo/cleo.db` is open. Consequently every
 * `idx_*_project*` index that LED with `project_id` is dropped or collapsed:
 *   - `idx_nexus_nodes_project` → dropped.
 *   - `idx_nexus_nodes_project_kind(project_id, kind)` → collapses to the
 *     already-present `idx_nexus_nodes_kind(kind)`.
 *   - `idx_nexus_nodes_project_file(project_id, file_path)` → collapses to the
 *     already-present `idx_nexus_nodes_file(file_path)`.
 *   - `idx_nexus_relations_project` → dropped;
 *     `idx_nexus_relations_project_type(project_id, type)` → collapses to
 *     `idx_nexus_relations_type(type)`.
 *   - `idx_nexus_contracts_project` → dropped;
 *     `idx_nexus_contracts_project_type(project_id, type)` → collapses to
 *     `idx_nexus_contracts_type(type)`.
 *   - `idx_nexus_code_index_project` → dropped.
 * Every other column, index, and intra-graph soft FK is preserved BYTE-FOR-BYTE
 * from the global source.
 *
 * ## FK reconciliation — intra-scope soft FKs preserved (ADR-090 §2.1)
 *
 * All graph references are intra-scope (within the same project DB) and stay
 * plain `text` soft FKs exactly as in the global source — the graph stores
 * unresolved external module specifiers in the same columns, so they were never
 * enforced FKs:
 *   - `nexus_relations.{source_id,target_id}` → `nexus_nodes.id`.
 *   - `nexus_nodes.{parent_id,community_id}` → `nexus_nodes.id`.
 *   - `nexus_contracts.{source_symbol_id,route_node_id}` → `nexus_nodes.id`.
 * Post-split these tables hold NO machine-specific absolute paths and NO
 * cross-scope refs, so they are move-safe (ADR-090 §4 portability).
 *
 * ## E10 typing — inherited unchanged from the global source
 *
 * The enum const arrays ({@link NEXUS_NODE_KINDS}, {@link NEXUS_RELATION_TYPES},
 * {@link NEXUS_CONTRACT_TYPES}, {@link CODE_INDEX_KINDS}) and typed booleans
 * (`is_exported`, `is_external`, `exported` with `{ mode: 'boolean' }`) are
 * re-minted here verbatim to keep this scope module self-contained, mirroring
 * how `../cleo-global/nexus.ts` mints them in-module (no cross-package
 * contracts SSoT exists for these). The two barrels live in DISJOINT Drizzle
 * namespaces (`CleoProjectSchemaTypes` vs `CleoGlobalSchemaTypes` in
 * `store/dual-scope-db.ts`), so the duplicated identifiers never collide.
 *
 * @task T11538
 * @epic T11535
 * @saga T11242
 * @see ../cleo-global/nexus.ts (the GLOBAL source these four tables move OUT of)
 * @see docs/migration/sqlite-schema-canonical.md §4 · §5b
 * @see cleo docs fetch adr-090-nexus-graph-residency-split
 */

import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// E10 §5b — enum const arrays minted in-module (no cross-package contracts SSoT).
// Mirrors ../cleo-global/nexus.ts verbatim; values are the SSoT for the exodus
// `CHECK (col IN (...))` lists derived from these identifiers.
// ---------------------------------------------------------------------------

/**
 * All node kind values — matches `GraphNodeKind` in `@cleocode/contracts`.
 * Kept as a const tuple for the Drizzle enum column. Ordering intentional:
 * structural → module → callable → type → value-level → language-specific →
 * graph-level → legacy.
 *
 * @task T11538 (project-scope target shape) · T529 (original)
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
 * All relation type values — matches `GraphRelationType` in `@cleocode/contracts`.
 *
 * @task T11538 (project-scope target shape) · T529 (original)
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
 * All contract type values for cross-project API extraction.
 *
 * @task T11538 (project-scope target shape) · T1065 (original)
 */
export const NEXUS_CONTRACT_TYPES = ['http', 'grpc', 'topic'] as const;

/** TypeScript type derived from {@link NEXUS_CONTRACT_TYPES}. */
export type NexusContractType = (typeof NEXUS_CONTRACT_TYPES)[number];

/**
 * Legal `nexus_code_index.kind` values — tree-sitter symbol capture kinds.
 *
 * E10 §5b: `code_index.kind` was bare `text('kind')`. The legal set is the
 * symbol-kind taxonomy documented on the source column (the tree-sitter capture
 * groups): structural / module / callable / type-hierarchy / value-level
 * constructs. Kept as an in-module const so the exodus CHECK derives from this
 * identifier rather than a hand-typed literal.
 *
 * @task T11538 (project-scope target shape) · T11361 (global source)
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
// Code-intelligence graph (4 tables · project scope · no project_id)
// ---------------------------------------------------------------------------

/**
 * `nexus_nodes` — one row per symbol or structural element in the code
 * intelligence graph. PROJECT-scope: `project_id` dropped (ADR-090 §2.1) —
 * scope is implicit in the owning `.cleo/cleo.db`.
 *
 * @task T11538 (project-scope target shape) · T11361 (global source) · T529 (original)
 */
export const nexusNodes = sqliteTable(
  'nexus_nodes',
  {
    /** Stable node ID (`<filePath>::<name>` / `<filePath>` / `community:<n>` / `process:<slug>`). */
    id: text('id').primaryKey(),
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
    index('idx_nexus_nodes_kind').on(table.kind),
    index('idx_nexus_nodes_file').on(table.filePath),
    index('idx_nexus_nodes_name').on(table.name),
    index('idx_nexus_nodes_community').on(table.communityId),
    index('idx_nexus_nodes_parent').on(table.parentId),
    index('idx_nexus_nodes_exported').on(table.isExported),
    index('idx_nexus_nodes_is_external').on(table.isExternal),
  ],
);

/**
 * `nexus_relations` — one row per directed graph edge. PROJECT-scope:
 * `project_id` dropped (ADR-090 §2.1). The Hebbian plasticity columns
 * (`weight`, `last_accessed_at`, `co_accessed_count`) remain inline here until
 * T11545 partitions them into the sibling `nexus_relation_weights` table
 * (ADR-090 §5.3) — out of scope for T11538.
 *
 * @task T11538 (project-scope target shape) · T11361 (global source) · T529 (original)
 */
export const nexusRelations = sqliteTable(
  'nexus_relations',
  {
    /** UUID v4 row identifier. */
    id: text('id').primaryKey(),
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
    index('idx_nexus_relations_source').on(table.sourceId),
    index('idx_nexus_relations_target').on(table.targetId),
    index('idx_nexus_relations_type').on(table.type),
    index('idx_nexus_relations_source_type').on(table.sourceId, table.type),
    index('idx_nexus_relations_target_type').on(table.targetId, table.type),
    index('idx_nexus_relations_confidence').on(table.confidence),
    index('idx_nexus_relations_last_accessed').on(table.lastAccessedAt),
  ],
);

/**
 * `nexus_contracts` — HTTP/gRPC/topic contract registry extracted from the
 * project's code. PROJECT-scope: `project_id` dropped (ADR-090 §2.1).
 *
 * @task T11538 (project-scope target shape) · T11361 (global source) · T1065 (original)
 */
export const nexusContracts = sqliteTable(
  'nexus_contracts',
  {
    /** Unique contract id. Primary key. */
    contractId: text('contract_id').primaryKey(),
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
    index('idx_nexus_contracts_type').on(table.type),
    index('idx_nexus_contracts_path').on(table.path),
    index('idx_nexus_contracts_method').on(table.method),
    index('idx_nexus_contracts_source_symbol').on(table.sourceSymbolId),
    index('idx_nexus_contracts_created').on(table.createdAt),
  ],
);

/**
 * `nexus_code_index` — persistent index of code symbols extracted by
 * tree-sitter (one row per symbol per file). PROJECT-scope: `project_id`
 * dropped (ADR-090 §2.1).
 *
 * @task T11538 (project-scope target shape) · T11361 (global source)
 */
export const nexusCodeIndex = sqliteTable(
  'nexus_code_index',
  {
    /** Stable row identifier (UUID v4). Primary key. */
    id: text('id').primaryKey(),
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
    index('idx_nexus_code_index_file').on(table.filePath),
    index('idx_nexus_code_index_symbol').on(table.symbolName),
    index('idx_nexus_code_index_kind').on(table.kind),
  ],
);

// === TYPE EXPORTS ===

/** Row type for `nexus_nodes` SELECT queries (project-scope target shape). */
export type NexusNodeRow = typeof nexusNodes.$inferSelect;
/** Row type for `nexus_nodes` INSERT operations (project-scope target shape). */
export type NewNexusNodeRow = typeof nexusNodes.$inferInsert;
/** Row type for `nexus_relations` SELECT queries (project-scope target shape). */
export type NexusRelationRow = typeof nexusRelations.$inferSelect;
/** Row type for `nexus_relations` INSERT operations (project-scope target shape). */
export type NewNexusRelationRow = typeof nexusRelations.$inferInsert;
/** Row type for `nexus_contracts` SELECT queries (project-scope target shape). */
export type NexusContractRow = typeof nexusContracts.$inferSelect;
/** Row type for `nexus_contracts` INSERT operations (project-scope target shape). */
export type NewNexusContractRow = typeof nexusContracts.$inferInsert;
/** Row type for `nexus_code_index` SELECT queries (project-scope target shape). */
export type NexusCodeIndexRow = typeof nexusCodeIndex.$inferSelect;
/** Row type for `nexus_code_index` INSERT operations (project-scope target shape). */
export type NewNexusCodeIndexRow = typeof nexusCodeIndex.$inferInsert;
