# T513-CA: GitNexus Pipeline Implementation Specification

**Role**: Code Intelligence Pipeline Architect
**Task**: T513
**Date**: 2026-04-11
**Status**: Complete
**Audience**: Validators and implementation workers for waves 1–6

---

## Preamble

This specification defines the full port of the GitNexus code intelligence pipeline into `@cleocode/nexus`. It is self-contained — workers implementing this spec do not need to read GitNexus source.

The spec is grounded in the T506 foundations (tree-sitter bindings, TypeScript provider, BFS impact, `code_index` schema) and the T513-R research study of the GitNexus 14-phase pipeline. All file path references are relative to `/mnt/projects/cleocode/`.

---

## 1. Drizzle Schema Design

### 1.1 Relationship to Existing `code_index` Table

The existing `code_index` table (at `packages/nexus/src/schema/code-index.ts`) is a flat symbol index designed for quick search and outline. It stores one symbol per row with no relation or graph data. It is **not** replaced — it continues to serve the `smartSearch`, `smartOutline`, and `smartUnfold` pipeline for IDE-style symbol lookup.

The new `nexus_nodes` + `nexus_relations` tables form the **graph layer** that sits on top of `code_index`. The two layers serve complementary roles:

| Table | Purpose | Who reads it |
|-------|---------|-------------|
| `code_index` | Fast symbol search by name/kind | `cleo nexus search`, `smartSearch` |
| `nexus_nodes` | Graph node store with structural metadata | Impact, context, process detection |
| `nexus_relations` | Directed edges (calls, imports, extends) | All graph traversal |

After ingestion, both tables are populated from the same parse pass. They are NOT merged — workers MUST populate both.

### 1.2 `nexus_nodes` Table

File: `packages/core/src/store/nexus-schema.ts` (extend the existing file — do NOT create a new schema file).

```typescript
import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// === ENUM CONSTANTS ===

/** All node kind values — matches GraphNodeKind in contracts. */
export const NEXUS_NODE_KINDS = [
  // Structural
  'file', 'folder',
  // Module-level
  'module', 'namespace',
  // Callable
  'function', 'method', 'constructor',
  // Type hierarchy
  'class', 'interface', 'struct', 'trait', 'impl',
  'type_alias', 'enum',
  // Value-level
  'property', 'constant', 'variable', 'static',
  'record', 'delegate',
  // Language-specific
  'macro', 'union', 'typedef', 'annotation', 'template',
  // Graph-level (synthetic nodes from analysis)
  'community', 'process', 'route',
  // External references
  'tool', 'section',
  // Legacy (kept for T506 compatibility)
  'import', 'export', 'type',
] as const;

export type NexusNodeKind = (typeof NEXUS_NODE_KINDS)[number];

/**
 * Graph nodes table — one row per symbol or structural element.
 *
 * Stores all code intelligence graph nodes indexed per project.
 * Synthetic nodes (community, process) share this table with
 * source-derived nodes (function, class, file).
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
  ],
);
```

### 1.3 `nexus_relations` Table

Extends the same `packages/core/src/store/nexus-schema.ts` file.

```typescript
/** All relation type values — matches GraphRelationType in contracts. */
export const NEXUS_RELATION_TYPES = [
  // Structural
  'contains',
  // Definition / usage
  'defines', 'imports', 'accesses',
  // Callable
  'calls',
  // Type hierarchy
  'extends', 'implements',
  'method_overrides', 'method_implements',
  // Class structure
  'has_method', 'has_property',
  // Graph-level (synthetic, from analysis)
  'member_of',        // symbol → community
  'step_in_process',  // symbol → process
  // Web / API
  'handles_route',    // function → route node
  'fetches',          // function → external API
  // Tool / agent
  'handles_tool',
  'entry_point_of',   // function → process
  // Wrapping / delegation
  'wraps',
  // Data access
  'queries',
  // Cross-graph (brain link)
  'documents',        // brain_page_node → nexus_nodes
  'applies_to',       // brain_page_node → nexus_nodes
] as const;

export type NexusRelationType = (typeof NEXUS_RELATION_TYPES)[number];

/**
 * Graph relations table — one row per directed edge.
 *
 * All graph traversal (impact, context, process detection) reads from
 * this table after ingestion completes.
 *
 * Source and target reference nexus_nodes.id. They are soft FKs —
 * unresolved targets (e.g., external packages) are stored as raw specifiers.
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

    /** Extractor confidence (0.0 to 1.0). See confidence table in §7. */
    confidence: real('confidence').notNull(),

    /** Human-readable note explaining why this relation was emitted. */
    reason: text('reason'),

    /** Step index within an execution flow (for step_in_process relations). */
    step: integer('step'),

    /** ISO 8601 timestamp when this relation was last indexed. */
    indexedAt: text('indexed_at').notNull().default(sql`(datetime('now'))`),
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
  ],
);
```

### 1.4 Type Exports

Append to `packages/core/src/store/nexus-schema.ts`:

```typescript
export type NexusNodeRow = typeof nexusNodes.$inferSelect;
export type NewNexusNodeRow = typeof nexusNodes.$inferInsert;
export type NexusRelationRow = typeof nexusRelations.$inferSelect;
export type NewNexusRelationRow = typeof nexusRelations.$inferInsert;
```

### 1.5 Migration

The `nexus_nodes` and `nexus_relations` tables are NEW. They live in `nexus.db` alongside `project_registry` and `nexus_audit_log`. Add a Drizzle migration that creates both tables. Do not alter `code_index` — it remains in `nexus.db` as-is.

---

## 2. Contracts Expansion

File: `packages/contracts/src/graph.ts`

### 2.1 `GraphNodeKind` — Add Missing Kinds

Replace the existing `GraphNodeKind` type with:

```typescript
export type GraphNodeKind =
  // Structural
  | 'file'
  | 'folder'
  // Module-level
  | 'module'
  | 'namespace'
  // Callable
  | 'function'
  | 'method'
  | 'constructor'
  // Type hierarchy
  | 'class'
  | 'interface'
  | 'struct'
  | 'trait'
  | 'impl'
  | 'type_alias'
  | 'enum'
  // Value-level
  | 'property'
  | 'constant'
  | 'variable'
  | 'static'
  | 'record'
  | 'delegate'
  // Language-specific constructs
  | 'macro'
  | 'union'
  | 'typedef'
  | 'annotation'
  | 'template'
  // Graph-level (synthetic, from analysis phases)
  | 'community'
  | 'process'
  | 'route'
  | 'tool'
  | 'section'
  // Legacy (kept for T506 compatibility)
  | 'import'
  | 'export'
  | 'type';
```

**Rationale for additions**:
- `impl`: Rust impl blocks (e.g., `impl HttpTransport for Transport`)
- `trait`: Rust/Swift protocol conformance
- `type_alias`: TypeScript `type Foo = ...` (previously conflated with `type`)
- `static`: class-level static members
- `record`, `delegate`: C# / Java record types
- `macro`, `typedef`, `union`, `annotation`, `template`: C/C++ and Java constructs
- `community`: synthetic node from Louvain clustering (Phase 5)
- `process`: synthetic node from BFS execution flow detection (Phase 6)
- `route`: HTTP route node (extracted from Express/Fastify handler detection)
- `tool`, `section`: agent-side constructs for future use

### 2.2 `GraphRelationType` — Add Missing Types

Replace the existing `GraphRelationType` type with:

```typescript
export type GraphRelationType =
  // Structural
  | 'contains'
  // Definition / usage
  | 'defines'
  | 'imports'
  | 'accesses'
  // Callable
  | 'calls'
  // Type hierarchy
  | 'extends'
  | 'implements'
  | 'method_overrides'
  | 'method_implements'
  // Class structure
  | 'has_method'
  | 'has_property'
  // Graph-level (synthetic, from analysis)
  | 'member_of'       // symbol → community
  | 'step_in_process' // symbol → process
  // Web / API
  | 'handles_route'   // function → route node
  | 'fetches'         // function → external URL
  // Tool / agent
  | 'handles_tool'
  | 'entry_point_of'  // function → process
  // Wrapping / delegation
  | 'wraps'
  // Data access
  | 'queries'
  // Cross-graph (brain integration)
  | 'documents'       // brain node → nexus node
  | 'applies_to';     // brain decision/learning → nexus node
```

### 2.3 `GraphNode` Interface — New Optional Fields

Add to the existing `GraphNode` interface:

```typescript
export interface GraphNode {
  // ... existing fields (id, kind, name, filePath, startLine, endLine,
  //     language, exported, parent, parameters, returnType, docSummary) ...

  /** Community ID this node belongs to (set after Phase 5). */
  communityId?: string;

  /** Execution flow process IDs this node participates in (set after Phase 6). */
  processIds?: string[];

  /** Kind-specific metadata blob (matches nexus_nodes.meta_json). */
  meta?: Record<string, unknown>;
}
```

### 2.4 New Interfaces

Add to `packages/contracts/src/graph.ts`:

```typescript
/**
 * An in-memory symbol table entry tracking all files where a name appears.
 * Used during ingestion to resolve cross-file call targets.
 */
export interface SymbolIndex {
  /** Symbol name as it appears in source (e.g., "parseFile"). */
  name: string;
  /** All node IDs that define this name across the project. */
  nodeIds: string[];
  /** All file paths that export this name. */
  exportingFiles: string[];
}

/**
 * The in-memory KnowledgeGraph assembled during a single ingestion run.
 * Flushed to nexus_nodes + nexus_relations after all phases complete.
 */
export interface KnowledgeGraph {
  nodes: Map<string, GraphNode>;
  relations: GraphRelation[];
  /** Indexes for fast lookup during resolution phases. */
  symbolTable: SymbolTable;
  /** Files that changed since last index (incremental mode only). */
  changedFiles?: Set<string>;
}

/**
 * A community (module cluster) identified by Louvain detection.
 */
export interface CommunityNode {
  id: string;          // format: `community:<n>`
  label: string;       // inferred from top folder name
  memberCount: number;
  topFolders: string[];
}

/**
 * A detected execution flow (process) from BFS entry point analysis.
 */
export interface ProcessNode {
  id: string;          // format: `process:<slug>`
  label: string;       // entry point function name
  entryPointId: string;
  stepIds: string[];   // ordered node IDs in the flow
  stepCount: number;
}
```

---

## 3. Pipeline Implementation Architecture

### 3.1 In-Memory KnowledgeGraph During Ingestion

The pipeline maintains a single `KnowledgeGraph` instance in memory throughout a full analysis run. No partial flushes occur during ingestion — the graph is built completely in RAM, then flushed atomically at the end.

Structure:

```typescript
// packages/nexus/src/pipeline/knowledge-graph.ts

interface KnowledgeGraph {
  // Primary stores
  nodes: Map<string, GraphNode>;      // nodeId → GraphNode
  relations: GraphRelation[];         // all edges (appended, not deduplicated until flush)

  // Symbol table (5 indexes — see §5)
  symbolTable: SymbolTable;

  // Phase tracking
  heritageMap: Map<string, string[]>; // className → [parentClass, ...interfaces]
  communityMap: Map<string, string>;  // nodeId → communityId
  processMap: Map<string, string[]>;  // entryPointId → [stepNodeId...]

  // Error aggregation
  errors: PhaseError[];
}
```

### 3.2 Batch Flush to Drizzle

After all pipeline phases complete:

1. Deduplicate `relations` array (remove exact `source+target+type` duplicates, keep highest confidence).
2. Convert `Map<string, GraphNode>` to `NewNexusNodeRow[]` — serialize `parametersJson`, `metaJson`, etc.
3. Insert nodes in batches of 500 using `db.insert(nexusNodes).values(batch).onConflictDoUpdate(...)`.
4. Insert relations in batches of 1000 using `db.insert(nexusRelations).values(batch).onConflictDoUpdate(...)`.
5. Also upsert `code_index` rows from the same parse data (for search compatibility).
6. Record `indexedAt` timestamp on every row for incremental tracking.

Conflict resolution: `onConflictDoUpdate` on primary key — always overwrite with latest analysis result.

### 3.3 Incremental Re-indexing

Incremental mode (`cleo nexus analyze --incremental`):

1. Query `nexus_nodes` for all `filePath + indexedAt` pairs for this `projectId`.
2. Walk the filesystem and collect `(filePath, mtime)` for all source files.
3. Files where `mtime > indexedAt` are "changed" and go into `changedFiles`.
4. Delete all `nexus_nodes` and `nexus_relations` rows for changed files before re-analysis.
5. Run the full pipeline but only parse changed files (Phases 3–3f).
6. Resolution phases (3a import, 3e call, 14 cross-file) run over the **full** graph (existing + newly parsed). Load unchanged nodes from DB into the in-memory graph first.
7. Community and process detection (Phases 4.5–6) always re-run over the full graph (they are cheap relative to parsing).

### 3.4 Error Handling Per Phase

Each phase runs inside a `try/catch`. Errors are appended to `KnowledgeGraph.errors` with the phase name and file path, then the pipeline continues with the next file. A phase failure never aborts the full run.

```typescript
interface PhaseError {
  phase: string;       // e.g., "phase3-parse", "phase3a-import-resolve"
  filePath?: string;
  message: string;
  stack?: string;
}
```

After the full run, errors are:
1. Logged to `nexus_audit_log` with `action: "pipeline-error"`.
2. Reported in `cleo nexus analyze` output as a warning count.

---

## 4. Phase-by-Phase Implementation Spec

### Phase 1: Filesystem Walker

**File**: `packages/nexus/src/pipeline/phases/phase1-walk.ts`

**Input**: `projectRoot: string`, `options: { maxFileSizeBytes?: number, gitignore?: boolean }`

**Output**: `WalkResult { files: string[], skipped: string[], totalBytes: number }`

**Algorithm**:
1. Use `fast-glob` (already a likely dep) or `node:fs` recursive walk with `Dirent` objects.
2. Read `.gitignore` at `projectRoot/.gitignore` and parse ignore patterns. Use the `ignore` npm package.
3. Filter files by extension — only include extensions from `SUPPORTED_EXTENSIONS` in `packages/nexus/src/code/tree-sitter-languages.ts`.
4. Skip files where `stat.size > maxFileSizeBytes` (default: 512 * 1024 = 524288 bytes). Add to `skipped`.
5. Skip `node_modules/`, `dist/`, `.git/`, `.cleo/`, `target/` directories unconditionally.

**CLEO adaptation**: Same as GitNexus. No changes needed for CLEO's monorepo — the walker is scoped to a single `projectRoot`.

**Complexity**: small

**Dependencies**: none (first phase)

---

### Phase 2: Structure Processor

**File**: `packages/nexus/src/pipeline/phases/phase2-structure.ts`

**Input**: `WalkResult` from Phase 1

**Output**: Adds `file` and `folder` nodes to `KnowledgeGraph.nodes`, adds `contains` relations

**Algorithm**:
1. For each `filePath`, emit a `GraphNode` with `kind: 'file'`, `id: filePath`, `label: basename(filePath)`.
2. Collect all unique parent directories. For each directory (including all ancestors up to projectRoot), emit a `GraphNode` with `kind: 'folder'`.
3. Emit `contains` relation: `{ source: folderNode.id, target: fileNode.id, type: 'contains', confidence: 1.0 }`.
4. Emit `contains` relation for folder → sub-folder hierarchy.

**CLEO adaptation**: Node IDs for file/folder nodes use the relative path (e.g., `src/core/parser.ts`) not absolute path. This is consistent with existing `code_index` conventions.

**Complexity**: small

**Dependencies**: Phase 1

---

### Phase 3: Tree-sitter Parse Loop (Chunked)

**File**: `packages/nexus/src/pipeline/phases/phase3-parse.ts`

**Input**: `WalkResult.files`, `KnowledgeGraph`, `LanguageProvider[]`

**Output**: Adds symbol nodes and raw (unresolved) relations to `KnowledgeGraph`

**Algorithm**:
1. Group files into chunks where the total byte size of each chunk does not exceed 20MB (`CHUNK_BYTE_BUDGET = 20 * 1024 * 1024`).
2. For each chunk, iterate files sequentially (or parallel if worker pool is active — Wave 5).
3. For each file:
   a. Select the `LanguageProvider` for the file's language (dispatched from a `Map<string, LanguageProvider>`).
   b. If no provider exists, skip and log.
   c. Read file source with `readFileSync`.
   d. Call `provider.extractDefinitions(tree, source, filePath)` → add to `kg.nodes`.
   e. Call `provider.extractImports(tree, source, filePath)` → add raw import relations to `kg.relations`.
   f. Call `provider.extractCalls(tree, source, filePath)` → add raw call relations to `kg.relations` (targets are bare names, not resolved IDs yet).
4. After each file, add its exported names to `kg.symbolTable` (see §5).

**Worker pool trigger** (Wave 5): If `files.length >= 15` or `totalBytes >= 524288`, use a worker pool of `min(4, os.cpus().length)` workers. Each worker handles one chunk. Workers communicate via `MessageChannel`. The main thread merges results into `KnowledgeGraph` after all workers complete.

**CLEO adaptation**: The existing `parseFile` in `packages/nexus/src/code/parser.ts` handles the tree-sitter mechanics. Phase 3 calls it to get `ParseResult`, then passes the raw `symbols` array to the appropriate `LanguageProvider` for graph extraction. Do NOT duplicate the parser — call the existing `parseFile` for the parse step, then call the provider's extract methods separately.

**Complexity**: large

**Dependencies**: Phase 2

---

### Phase 3a: Import Resolution (TypeScript)

**File**: `packages/nexus/src/pipeline/phases/phase3a-import-resolve.ts`

**Input**: Raw import relations in `KnowledgeGraph` (targets are module specifiers like `'./foo'`, `'@cleocode/contracts'`)

**Output**: Updates relation `target` from specifier to resolved node ID (`src/contracts/index.ts::*`)

**Algorithm**:

1. **Load path aliases**: Read `tsconfig.json` from `projectRoot`. Parse `compilerOptions.paths` into an alias map: `{ "@cleocode/contracts": ["packages/contracts/src/index.ts"] }`.
2. **Suffix index**: Build an inverted map from `Set<string>` of all known file paths to enable suffix-based resolution. For a specifier `'./foo'`, try these suffixes in order: `.ts`, `.tsx`, `.js`, `/index.ts`, `/index.js`.
3. **Resolution tiers** (in order, stop at first match):
   - **Alias match**: If specifier starts with a `paths` alias key, substitute and apply suffix index.
   - **Relative match**: Resolve relative to the importing file's directory; apply suffix index.
   - **Barrel match**: If target is a directory, look for `index.ts` or `index.js`.
   - **Node module**: Specifier has no `.` prefix and no alias match → mark as external, keep as-is.
4. Unresolved relations keep their raw specifier as `targetId`. They are NOT removed.
5. For resolved relations, replace the raw `target` with the resolved file node ID (e.g., `packages/contracts/src/index.ts::*`).

**Stub for future languages**: The resolver is driven by a `ImportResolver` interface:

```typescript
interface ImportResolver {
  language: string;
  resolve(specifier: string, importingFile: string, kg: KnowledgeGraph): string | null;
}
```

The TypeScript resolver is the first implementation. Python, Go, Rust resolvers are stubs in Wave 6.

**CLEO adaptation**: The existing TypeScript provider at `packages/nexus/src/intelligence/providers/typescript.ts` already emits raw import specifiers. Phase 3a enriches those relations in place.

**Complexity**: medium

**Dependencies**: Phase 3

---

### Phase 3b: Wildcard Synthesis (Deferred — Wave 6)

Handles Go wildcard imports, Ruby `require_relative` globs, C/C++ header includes, Swift module imports, Python `from X import *`. Defer to Wave 6. Add a no-op stub that logs a warning and returns.

**Complexity**: large (language-specific)

---

### Phase 3c: Heritage Resolution (EXTENDS / IMPLEMENTS)

**File**: `packages/nexus/src/pipeline/phases/phase3c-heritage.ts`

**Input**: Nodes in `KnowledgeGraph` where the TypeScript provider's definition walk detects `extends` / `implements` clauses

**Output**: Populates `kg.heritageMap`, adds `extends` and `implements` relations

**Algorithm**:

1. The TypeScript provider needs to be extended (Wave 3) to emit heritage data during `extractDefinitions`. For each `class_declaration` node, detect the `heritage_clause` child node and read its type identifiers. Emit as a special `_heritage` annotation on the `GraphNode` (a new optional field `heritageRaw?: string[]`).
2. Phase 3c reads all nodes where `heritageRaw` is set, resolves each heritage name through `symbolTable.byName`, and emits `extends`/`implements` relations.
3. Populate `kg.heritageMap`: `Map<className, [parentClass, ...interfaceNames]>`.
4. For unresolved heritage names (external class), emit a stub node with `kind: 'class'`, `filePath: null`, and the unresolved name as `id`.

**Complexity**: medium

**Dependencies**: Phase 3, Phase 3a (needs resolved file nodes)

---

### Phase 3d: Route Resolution (Deferred — Wave 4)

Detects Express/Fastify route handler patterns and emits `route` nodes + `handles_route` relations. Pattern: `app.get('/path', handler)`, `router.post('/path', handler)`. Implement in Wave 4 alongside community detection.

**Complexity**: medium

---

### Phase 3e: Call Resolution (DEFERRED — must wait for full HeritageMap)

**File**: `packages/nexus/src/pipeline/phases/phase3e-call-resolve.ts`

**CRITICAL CONSTRAINT**: This phase MUST run after all file chunks complete parsing (Phase 3) and heritage resolution (Phase 3c) across the entire project. This is because call resolution uses the HeritageMap to find the correct method implementation via MRO.

**Input**: Raw call relations (source: callerNodeId, target: bareCalleeName), `kg.symbolTable`, `kg.heritageMap`

**Output**: Updates call relation `target` from bare name to resolved node ID

**Algorithm** (Tiered — see §7 for full confidence table):

**Tier 1 — Same-file (confidence 0.95)**:
1. For each raw call relation, look up `calleeName` in `symbolTable.byFileAndName[callerFile]`.
2. If found and callee is in the same file, resolve directly.
3. Emit resolved relation with confidence 0.95.

**Tier 2a — Named import (confidence 0.90)**:
1. Check `symbolTable.byImportedName[callerFile][calleeName]` — was this name imported from a specific file?
2. If yes, resolve to `importedFromFile::calleeName`.
3. Emit resolved relation with confidence 0.90.

**Tier 2b — Package-scoped (deferred, Wave 5)**:
Uses the monorepo package manifest to find the defining package. Deferred.

**Tier 3 — Global (confidence 0.50, deferred)**:
Scans all exported symbols project-wide. High false-positive rate. Deferred.

**Unresolved calls**: Keep the raw call relation with the bare name as `targetId` and confidence 0.70. These are valid data — they represent calls to external functions or runtime-resolved symbols.

**Complexity**: large

**Dependencies**: All file chunks parsed (Phase 3 complete), Phase 3c

---

### Phase 3f: Assignment Resolution (Deferred — Wave 5)

Tracks variable assignments to detect indirect call patterns (e.g., `const fn = doThing; fn()`). Defer to Wave 5.

**Complexity**: large

---

### Phase 14: Cross-File Return Type Propagation (Deferred — Wave 5)

Re-resolves call targets using inferred return types from cross-file function signatures. Required for accurate method dispatch through wrapper functions. Requires complete Phase 3e call graph. Deferred to Wave 5.

**Complexity**: large

---

### Phase 4.5: MRO — Method Resolution Order (Wave 3)

**File**: `packages/nexus/src/pipeline/phases/phase4-mro.ts`

**Input**: `kg.heritageMap`, all class + method nodes in `KnowledgeGraph`

**Output**: Adds `method_overrides` and `method_implements` relations; detects override conflicts

**Algorithm**:

1. Perform topological sort of the class hierarchy using `kg.heritageMap` (Kahn's algorithm). Cycle detection: if a cycle is detected, emit a `PhaseError` and skip the cycle members.
2. For each class in topological order, compute its MRO (C3 linearization algorithm — same as Python's MRO).
3. For each method in the class, walk the MRO chain to find the nearest ancestor that declares the same method name.
4. Emit `method_overrides` relation from the overriding method to the base method.
5. For interfaces in `implements` clauses, emit `method_implements` relations from each interface method to the implementing class method.

**Complexity**: medium

**Dependencies**: Phase 3c

---

### Phase 5: Community Detection

**File**: `packages/nexus/src/pipeline/phases/phase5-community.ts`

**Input**: `kg.nodes`, `kg.relations` (specifically `calls`, `extends`, `implements` edges)

**Output**: `CommunityNode[]` added to `kg.nodes`; `member_of` relations added; `communityId` set on all symbol nodes

**Algorithm**:

1. Build a `graphology` `UndirectedGraph` from nodes + relations.
2. Add all symbol nodes (kind not in `['file', 'folder', 'community', 'process', 'route']`).
3. Add undirected edges for `calls`, `extends`, and `implements` relations (confidence >= 0.5).
4. Run `graphology-communities-louvain` with default resolution parameter (1.0).
5. The result is a `Map<nodeId, communityIndex>`. Convert to community IDs: `community:0`, `community:1`, etc.
6. For each community, find the most common folder prefix among its member nodes → use as `label`.
7. Emit a `GraphNode` per community: `{ id: 'community:N', kind: 'community', label: folderLabel, ... }`.
8. Emit `member_of` relation from each symbol node to its community node (confidence: 1.0).
9. Set `communityId` on each symbol `GraphNode` in memory.

**Npm package**: `graphology` + `graphology-communities-louvain`. Do NOT vendor the Leiden algorithm from GitNexus. Louvain from npm is sufficient and well-maintained.

**CLEO adaptation**: GitNexus uses a vendored Leiden implementation. CLEO uses `graphology-communities-louvain` to avoid vendor lock-in and native compilation complexity.

**Complexity**: medium

**Dependencies**: Phase 3e (needs CALLS edges for meaningful communities)

---

### Phase 6: Process / Execution Flow Detection

**File**: `packages/nexus/src/pipeline/phases/phase6-process.ts`

**Input**: `kg.nodes`, `kg.relations` (CALLS edges), community memberships from Phase 5

**Output**: `ProcessNode[]` added to `kg.nodes`; `entry_point_of` and `step_in_process` relations added

**Algorithm**:

1. **Entry point scoring** — assign an entry score to each function/method node:
   - +0.4 if `isExported === true`
   - +0.3 if name matches route handler patterns: `handler`, `controller`, `resolve`, `execute`, `run`, `main`, `start`, `init`
   - +0.2 if `docSummary` mentions `entry`, `entrypoint`, `handler`, `endpoint`
   - +0.2 if the node has `handles_route` relation (a route handler)
   - +0.1 if the node has no incoming `calls` edges (nothing calls it — it IS the entry)
   - Score 0.0–1.0, threshold: 0.50

2. **BFS forward traversal** from each qualifying entry point:
   - Traverse `calls` edges (confidence >= 0.5), direction: downstream (caller → callee)
   - Max depth: 10 hops
   - Max branching: 4 children per node (take top-4 by confidence if more)
   - Stop conditions: visited node, depth > 10, or branching > 4

3. **Minimum step filter**: Only create a process node if the BFS found >= 3 unique steps (excluding the entry point itself).

4. **Deduplication**:
   - Subset removal: if process A's step set is a strict subset of process B's, remove A.
   - Endpoint dedup: if two processes share the same terminal (deepest) step node, merge the shorter one into the longer one.

5. For each surviving process:
   - Emit a `GraphNode`: `{ id: 'process:<entrySlug>', kind: 'process', label: entryFunctionName, ... }`.
   - Emit `entry_point_of` relation: entryPointNode → processNode (confidence: 1.0).
   - Emit `step_in_process` relations for each step node with the step index (confidence: 0.85, `step: N`).

**Complexity**: medium

**Dependencies**: Phase 5 (uses community data for entry scoring), Phase 3e (needs CALLS graph)

---

## 5. SymbolTable Design for CLEO

### 5.1 In-Memory Structure

```typescript
// packages/nexus/src/pipeline/symbol-table.ts

interface SymbolTable {
  /** Index 1: By name — all nodes that define a given symbol name. */
  byName: Map<string, string[]>;  // name → nodeId[]

  /** Index 2: By file — all node IDs defined in a given file. */
  byFile: Map<string, string[]>;  // filePath → nodeId[]

  /** Index 3: By file + name — for same-file call resolution (Tier 1). */
  byFileAndName: Map<string, Map<string, string>>;  // filePath → name → nodeId

  /** Index 4: Exported names — names exported by each file. */
  exportedByFile: Map<string, Set<string>>;  // filePath → Set<exportedName>

  /** Index 5: Import map — per-file record of what was imported from where.
   *  Built during Phase 3a. Used by Tier 2a call resolution. */
  importedFromFile: Map<string, Map<string, string>>;  // callerFile → name → sourceFile
}
```

### 5.2 Hydration from Drizzle (for Incremental Mode)

When running incremental analysis, unchanged files' nodes must be loaded from `nexus_nodes` into the in-memory `KnowledgeGraph`. Hydration steps:

1. Query `nexus_nodes WHERE project_id = ? AND file_path NOT IN (changedFiles)`.
2. Convert each `NexusNodeRow` to `GraphNode` (deserialize `parametersJson`, `metaJson`).
3. Add to `kg.nodes` Map.
4. Populate all 5 SymbolTable indexes from the loaded nodes.
5. Query `nexus_relations WHERE project_id = ? AND source_id NOT LIKE '<changedFile>%'` — load existing relations for unchanged files.

### 5.3 Flush Back to Drizzle

After analysis completes (all phases), flush the full in-memory graph:

1. Collect all `GraphNode` entries from `kg.nodes` Map.
2. Batch-insert into `nexus_nodes` (500 rows per batch). Use `onConflictDoUpdate` on `id` — update all columns.
3. Delete all `nexus_relations` for the project where `source_id` matches changed file patterns. Then batch-insert all relations (1000 rows per batch).
4. Update `nexus_nodes.indexed_at` for all changed nodes.

### 5.4 Cache Invalidation Strategy

| Trigger | Action |
|---------|--------|
| File modified (mtime changed) | Delete all nodes/relations for that file, re-parse |
| File deleted | Delete all nodes/relations for that file |
| File added | Parse and insert new nodes/relations |
| `tsconfig.json` changed | Full re-index (path aliases may have changed) |
| `package.json` changed | Full re-index (monorepo package boundaries may have changed) |

Cache invalidation is checked at the start of each `cleo nexus analyze --incremental` run. The mtime comparison uses the `indexedAt` column on `nexus_nodes`.

---

## 6. Import Resolution Strategy

### 6.1 TypeScript Resolver (First Implementation)

Implemented in Phase 3a. Full algorithm documented in §4 Phase 3a.

Key rules:
- Resolution is path-first, not type-first. The resolver returns a `filePath`, not a type signature.
- If a module specifier maps to a directory with an `index.ts`, resolve to the `index.ts` file node.
- Path aliases from `tsconfig.json` are loaded once at analysis start and cached for the full run.
- Do not use the TypeScript compiler API — parse `tsconfig.json` with `JSON.parse` directly (handle `//` comments with a simple strip pass).

### 6.2 Barrel Export Handling

When an import targets a barrel (`index.ts` or `index.js`), the resolver:
1. Resolves to the barrel file node.
2. Does NOT attempt to trace through the barrel's re-exports in Phase 3a (too expensive).
3. Phase 14 (cross-file propagation, Wave 5) handles barrel tracing by following `imports` edges into the barrel and out through re-export patterns.

### 6.3 Stub Interface for Future Language Resolvers

```typescript
// packages/nexus/src/pipeline/phases/phase3a-import-resolve.ts

export interface ImportResolver {
  /** Language this resolver handles. */
  language: string;

  /**
   * Resolve a module specifier to a file path relative to projectRoot.
   *
   * @param specifier - Raw import specifier (e.g., './foo', '@pkg/bar')
   * @param importingFile - File path of the importing file (relative)
   * @param context - Resolution context (path aliases, file index)
   * @returns Resolved relative file path, or null if unresolvable
   */
  resolve(
    specifier: string,
    importingFile: string,
    context: ImportResolverContext,
  ): string | null;
}

export interface ImportResolverContext {
  projectRoot: string;
  pathAliases: Map<string, string[]>;  // from tsconfig paths
  fileIndex: Set<string>;              // all known relative file paths
}
```

Wave 6 adds Python, Go, and Rust resolvers that implement this interface and are registered in the resolver registry.

---

## 7. Call Resolution Strategy (Tiered)

### 7.1 Confidence Table

| Tier | Strategy | Confidence | Wave |
|------|----------|-----------|------|
| 1 | Same-file — callee defined in same file as caller | 0.95 | 3 |
| 2a | Named import — callee was explicitly imported by name | 0.90 | 3 |
| 2b | Package-scoped — callee found in same monorepo package | 0.85 | 5 |
| 3 | Global — only one definition found project-wide | 0.75 | deferred |
| — | Unresolved — kept as bare name | 0.70 | always |

### 7.2 Resolution Implementation (Phase 3e)

**Tier 1 — Same-file**:

```typescript
// For each raw call relation where source is `filePath::callerName`
// and target is a bare name `calleeName`:

const callerFile = extractFile(relation.source);  // `filePath`
const fileIndex = symbolTable.byFileAndName.get(callerFile);
const calleeNodeId = fileIndex?.get(relation.target);

if (calleeNodeId) {
  relation.targetId = calleeNodeId;
  relation.confidence = 0.95;
  relation.reason = 'same-file resolution';
}
```

**Tier 2a — Named import**:

```typescript
// symbolTable.importedFromFile[callerFile][calleeName] = sourceFilePath
const sourceFile = symbolTable.importedFromFile.get(callerFile)?.get(relation.target);

if (sourceFile) {
  const sourceFileIndex = symbolTable.byFileAndName.get(sourceFile);
  const calleeNodeId = sourceFileIndex?.get(relation.target);
  if (calleeNodeId) {
    relation.targetId = calleeNodeId;
    relation.confidence = 0.90;
    relation.reason = 'named import resolution';
  }
}
```

### 7.3 Virtual Dispatch / MRO (Deferred — Wave 3 partial, Wave 5 full)

When a method call is on an object whose type is known from type inference, MRO is used to find the correct implementation. This requires the HeritageMap from Phase 3c. Wave 3 implements basic MRO (direct class resolution). Wave 5 adds polymorphic dispatch (virtual method resolution across inheritance chains).

---

## 8. Community Detection Strategy

### 8.1 Package Selection

Use `graphology` + `graphology-communities-louvain` from npm. These are well-maintained, pure-JS packages with no native compilation. Install in `packages/nexus/package.json`.

Do NOT use the vendored Leiden algorithm from GitNexus. The quality difference between Louvain and Leiden is negligible for code graphs under 50,000 nodes.

### 8.2 Graph Construction

```typescript
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

const graph = new Graph({ type: 'undirected' });

// Add all symbol nodes (exclude file/folder/community/process)
for (const [id, node] of kg.nodes) {
  if (!['file', 'folder', 'community', 'process', 'route'].includes(node.kind)) {
    graph.addNode(id, { label: node.name });
  }
}

// Add edges for semantic relations only
for (const rel of kg.relations) {
  const SEMANTIC_TYPES: GraphRelationType[] = ['calls', 'extends', 'implements'];
  if (!SEMANTIC_TYPES.includes(rel.type)) continue;
  if (rel.confidence < 0.5) continue;
  if (!graph.hasNode(rel.source) || !graph.hasNode(rel.target)) continue;
  if (!graph.hasEdge(rel.source, rel.target)) {
    graph.addEdge(rel.source, rel.target);
  }
}

const communities = louvain(graph);
// communities: Record<nodeId, communityIndex>
```

### 8.3 Community Labeling

For each community index N:
1. Collect all node IDs in the community.
2. For each node, get its `filePath` and extract the top-level directory component (e.g., `src/core/parser.ts` → `core`).
3. Count occurrences of each directory component.
4. Use the most frequent directory component as the community `label`.
5. If all nodes are in `src/`, use the second component (e.g., `src/core/` → `core`).

### 8.4 Output

After detection, for each community:
- Add community `GraphNode` to `kg.nodes`.
- Add `member_of` `GraphRelation` for each member.
- Set `communityId` on each member `GraphNode` in the in-memory graph.

---

## 9. Process Detection Strategy

### 9.1 Entry Point Scoring

Scoring function applied to every `function`, `method`, and `constructor` node:

```typescript
function scoreEntryPoint(node: GraphNode, kg: KnowledgeGraph): number {
  let score = 0;

  // Exported symbols are likely entry points
  if (node.isExported) score += 0.4;

  // Naming conventions for handlers
  const HANDLER_NAMES = ['handler', 'controller', 'resolve', 'execute', 'run', 'main', 'start', 'init', 'serve', 'listen'];
  if (HANDLER_NAMES.some(n => node.name.toLowerCase().includes(n))) score += 0.3;

  // Doc summary keywords
  if (node.docSummary) {
    const doc = node.docSummary.toLowerCase();
    if (['entry', 'entrypoint', 'handler', 'endpoint', 'command'].some(k => doc.includes(k))) {
      score += 0.2;
    }
  }

  // Has a handles_route relation
  const hasRoute = kg.relations.some(r => r.source === node.id && r.type === 'handles_route');
  if (hasRoute) score += 0.2;

  // Nothing calls this node (orphan entry)
  const hasCaller = kg.relations.some(r => r.target === node.id && r.type === 'calls');
  if (!hasCaller) score += 0.1;

  return Math.min(score, 1.0);
}
```

Threshold: score >= 0.50 qualifies as an entry point candidate.

### 9.2 BFS Traversal Parameters

- **Direction**: downstream (caller → callee via CALLS edges)
- **Max depth**: 10
- **Max branching**: 4 (take the 4 highest-confidence outgoing CALLS edges per node)
- **Min confidence**: 0.5 (skip speculative calls)
- **Visited set**: per-BFS, prevents cycles
- **Min steps**: 3 (processes with fewer than 3 steps after the entry are discarded)

### 9.3 Deduplication

After all BFS runs complete and process candidates are assembled:

1. **Subset removal**: Convert each process's step set to a `Set<string>`. If `processA.stepSet` is a strict subset of `processB.stepSet` (all of A's steps are in B), remove A.

2. **Endpoint dedup**: Find the terminal step (deepest BFS node) of each process. If two processes share the same terminal step, merge the shorter one into the longer one (keep only the longer process).

3. **Label dedup**: If two surviving processes have the same entry point label, keep the one with more steps.

### 9.4 Output Nodes

Each surviving process becomes:

```typescript
const processNode: GraphNode = {
  id: `process:${slugify(entryNode.name)}`,
  kind: 'process',
  name: entryNode.name,
  label: entryNode.name,
  filePath: undefined,  // synthetic node
  startLine: undefined,
  endLine: undefined,
  language: entryNode.language,
  isExported: false,
  meta: {
    stepCount: steps.length,
    entryScore: score,
    communityId: entryNode.communityId,
  },
};
```

---

## 10. CLI Commands

All commands live under the `nexus` subcommand. File locations follow CLEO's existing CLI patterns in `packages/cli/src/commands/`.

### 10.1 `cleo nexus analyze`

```
cleo nexus analyze [--incremental] [--project-id <id>]
```

- Full pipeline run (Phases 1 → 6).
- `--incremental`: Skip unchanged files (see §3.3).
- Output: JSON envelope with `{ success, data: { nodesIndexed, relationsIndexed, communitiesDetected, processesDetected, errorsCount, durationMs } }`.

### 10.2 `cleo nexus status`

```
cleo nexus status [--project-id <id>]
```

- Queries `nexus_nodes` and `nexus_relations` for counts by kind/type.
- Reports: `{ nodeCount, relationCount, communityCount, processCount, lastIndexed, freshness: 'fresh' | 'stale' | 'never' }`.
- `freshness` is `stale` if the most recent `indexedAt` is older than 24 hours.

### 10.3 `cleo nexus context <symbol>`

```
cleo nexus context <symbolName> [--project-id <id>]
```

- Finds the symbol by name in `nexus_nodes`.
- Returns: symbol node, incoming relations (callers, importers), outgoing relations (callees, imports), community membership, process participations.
- Equivalent to GitNexus `gitnexus_context`.

### 10.4 `cleo nexus impact <symbol>`

```
cleo nexus impact <symbolName> [--direction upstream|downstream] [--depth <n>] [--project-id <id>]
```

- Loads `nexus_nodes` + `nexus_relations` for the project into memory.
- Calls the existing `analyzeImpact` from `packages/nexus/src/intelligence/impact.ts`.
- Returns the `ImpactResult` in the LAFS envelope.

### 10.5 `cleo nexus clusters`

```
cleo nexus clusters [--project-id <id>]
```

- Lists all `kind: 'community'` nodes from `nexus_nodes`.
- For each community: `{ id, label, memberCount }`.

### 10.6 `cleo nexus flows`

```
cleo nexus flows [--project-id <id>] [--min-steps <n>]
```

- Lists all `kind: 'process'` nodes from `nexus_nodes`.
- For each process: `{ id, label, stepCount, entryFile }`.
- `--min-steps` filters by minimum step count (default: 3).

---

## 11. Wave-Based Implementation Plan

### Wave 1: Schema + Contracts + Filesystem Walker + Structure Processor

**Scope**:
1. Extend `packages/core/src/store/nexus-schema.ts` with `nexusNodes`, `nexusRelations`, and all enum constants.
2. Write Drizzle migration for the two new tables.
3. Expand `packages/contracts/src/graph.ts` with all new `GraphNodeKind`, `GraphRelationType`, and new optional `GraphNode` fields.
4. Add new contract interfaces (`SymbolTable`, `KnowledgeGraph`, `CommunityNode`, `ProcessNode`) to `packages/contracts/src/graph.ts`.
5. Implement `packages/nexus/src/pipeline/phases/phase1-walk.ts`.
6. Implement `packages/nexus/src/pipeline/phases/phase2-structure.ts`.
7. Implement `packages/nexus/src/pipeline/knowledge-graph.ts` (in-memory graph + SymbolTable factory).

**Acceptance Criteria**:
- `nexus_nodes` and `nexus_relations` tables exist in `nexus.db` after migration.
- `pnpm run build` passes with zero type errors.
- Phase 1 + 2 integration test: given a temp directory with known files, walker returns correct file count, structure processor emits correct file/folder nodes.
- `pnpm run test` passes with zero new failures.

**Dependencies**: None (builds on existing T506 foundations).

---

### Wave 2: SymbolTable + Import Resolution + Sequential Parse Loop

**Scope**:
1. Implement `packages/nexus/src/pipeline/symbol-table.ts` — all 5 indexes.
2. Implement `packages/nexus/src/pipeline/phases/phase3-parse.ts` — sequential parse loop (no worker pool yet).
3. Implement `packages/nexus/src/pipeline/phases/phase3a-import-resolve.ts` — TypeScript resolver + `ImportResolver` interface.
4. Implement the batch flush to Drizzle (both `nexus_nodes` and `nexus_relations`).
5. Implement incremental mode detection (mtime comparison against `indexedAt`).

**Acceptance Criteria**:
- Running `cleo nexus analyze` on `packages/nexus/src/` produces a non-empty `nexus_nodes` table.
- Import relations are resolved (targets show file paths, not raw specifiers) for TypeScript files.
- Incremental mode skips unchanged files.
- SymbolTable correctly reflects all 5 indexes after a full parse.
- `pnpm run build && pnpm run test` passes.

**Dependencies**: Wave 1

---

### Wave 3: Call Resolution + Heritage Processing + MRO

**Scope**:
1. Extend `typescriptProvider.extractDefinitions` to emit `heritageRaw` for class nodes.
2. Implement `packages/nexus/src/pipeline/phases/phase3c-heritage.ts`.
3. Implement `packages/nexus/src/pipeline/phases/phase3e-call-resolve.ts` (Tier 1 + Tier 2a).
4. Implement `packages/nexus/src/pipeline/phases/phase4-mro.ts`.
5. Add `method_overrides` and `method_implements` relations to test assertions.

**Acceptance Criteria**:
- For a test TypeScript project with inheritance: `extends` and `implements` relations exist in `nexus_relations`.
- `method_overrides` relation exists for an overridden method.
- Tier 1 call resolution resolves same-file calls to correct node IDs with confidence 0.95.
- Tier 2a call resolution resolves named imports with confidence 0.90.
- `pnpm run build && pnpm run test` passes.

**Dependencies**: Wave 2

---

### Wave 4: Community Detection + Process Detection + CLI Commands

**Scope**:
1. Add `graphology` and `graphology-communities-louvain` to `packages/nexus/package.json`.
2. Implement `packages/nexus/src/pipeline/phases/phase5-community.ts`.
3. Implement `packages/nexus/src/pipeline/phases/phase6-process.ts` (entry scoring + BFS + dedup).
4. Implement route detection (Phase 3d) for Express/Fastify patterns.
5. Implement all 6 CLI commands (`analyze`, `status`, `context`, `impact`, `clusters`, `flows`).
6. Wire the full pipeline in `packages/nexus/src/pipeline/pipeline.ts` as the main orchestrator.

**Acceptance Criteria**:
- `cleo nexus analyze` on the `cleocode` project completes without errors.
- `cleo nexus clusters` returns at least 3 communities.
- `cleo nexus flows` returns at least 1 process.
- `cleo nexus impact parseFile` returns a meaningful result.
- `cleo nexus status` shows fresh index.
- `pnpm run build && pnpm run test` passes.

**Dependencies**: Wave 3

---

### Wave 5: Worker Pool + Phase 14 + Incremental Re-index

**Scope**:
1. Implement worker pool in Phase 3 parse loop (trigger: >= 15 files or >= 512KB total).
2. Implement `packages/nexus/src/pipeline/phases/phase3f-assignment.ts` (assignment resolution).
3. Implement `packages/nexus/src/pipeline/phases/phase14-cross-file-propagation.ts`.
4. Implement Tier 2b call resolution (package-scoped) using `package.json` manifest.
5. Harden incremental re-index: handle file deletions, renames, and `tsconfig.json` changes.
6. Add performance benchmarks: index `cleocode` in < 30 seconds.

**Acceptance Criteria**:
- Worker pool activates on large projects.
- Phase 14 propagation improves call resolution accuracy (measure by comparing resolved/unresolved ratio before and after).
- Incremental re-index correctly handles deletions and renames.
- Performance target met.
- `pnpm run build && pnpm run test` passes.

**Dependencies**: Wave 4

---

### Wave 6: Additional Language Providers

**Scope**:
1. Implement `packages/nexus/src/intelligence/providers/python.ts` (definitions, imports, calls).
2. Implement `packages/nexus/src/intelligence/providers/rust.ts` (definitions, mod imports, calls).
3. Implement `packages/nexus/src/intelligence/providers/go.ts` (definitions, imports, calls).
4. Implement Python, Rust, Go import resolvers (`ImportResolver` interface).
5. Implement Phase 3b wildcard synthesis for Go and Python.
6. Integration tests per language.

**Acceptance Criteria**:
- Indexing a Python project produces meaningful nodes and relations.
- Indexing the `cleocode` Rust crates produces struct/impl/fn nodes.
- `pnpm run build && pnpm run test` passes.

**Dependencies**: Wave 5

---

## 12. Integration with Memory Graph

### 12.1 Schema Bridge

The `brain.db` graph (in `packages/core/src/store/brain-schema.ts`) stores cognitive artifacts:
- `brain_page_nodes`: task nodes (`task:T5241`), doc nodes (`doc:BRAIN-SPEC`), file nodes (`file:src/foo.ts`)
- `brain_page_edges`: `depends_on`, `relates_to`, `implements`, `documents` edges between brain nodes

The `nexus.db` graph stores code intelligence:
- `nexus_nodes`: file, folder, function, class, community, process nodes
- `nexus_relations`: calls, imports, extends, member_of, step_in_process edges

These are in **separate databases** (brain.db vs nexus.db). Cross-database linkage uses two new relation types added in §2.2:
- `documents`: a `brain_page_node` documents a `nexus_node` (e.g., a task node documents a function)
- `applies_to`: a brain decision or learning applies to a `nexus_node` (e.g., "Use drizzle-orm for DB access" applies to `src/store/*.ts`)

### 12.2 Cross-Link Edge Types

Cross-graph edges are NOT stored in either `nexus_relations` or `brain_page_edges`. They live in a dedicated bridge table:

```typescript
// Extend packages/core/src/store/nexus-schema.ts

export const NEXUS_BRAIN_LINK_TYPES = ['documents', 'applies_to'] as const;

/** Cross-database links between brain_page_nodes (brain.db) and nexus_nodes (nexus.db).
 *  Stored in nexus.db since brain.db is the source of truth for cognitive artifacts. */
export const nexusBrainLinks = sqliteTable(
  'nexus_brain_links',
  {
    /** brain_page_nodes.id from brain.db (soft FK across databases). */
    brainNodeId: text('brain_node_id').notNull(),
    /** nexus_nodes.id from nexus.db. */
    nexusNodeId: text('nexus_node_id').notNull(),
    /** Semantic link type. */
    linkType: text('link_type', { enum: NEXUS_BRAIN_LINK_TYPES }).notNull(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.brainNodeId, table.nexusNodeId, table.linkType] }),
    index('idx_nexus_brain_links_brain').on(table.brainNodeId),
    index('idx_nexus_brain_links_nexus').on(table.nexusNodeId),
  ],
);
```

### 12.3 Query Pattern: "Show Me All Decisions About This Function"

```sql
-- Step 1: Find the nexus node for the function
SELECT id FROM nexus_nodes
WHERE project_id = ? AND name = 'parseFile' AND kind = 'function'
LIMIT 1;
-- Returns: 'packages/nexus/src/code/parser.ts::parseFile'

-- Step 2: Find all brain nodes linked to this nexus node
SELECT brain_node_id, link_type FROM nexus_brain_links
WHERE nexus_node_id = 'packages/nexus/src/code/parser.ts::parseFile';
-- Returns: [{ brain_node_id: 'task:T509', link_type: 'documents' }, ...]

-- Step 3: In brain.db, fetch the task/decision details
SELECT * FROM brain_decisions WHERE context_task_id = 'T509';
SELECT * FROM brain_page_nodes WHERE id = 'task:T509';
```

In CLEO's CLI, `cleo nexus context parseFile --include-brain` executes this 3-step query and returns unified output.

### 12.4 Unified Traversal Strategy

Unified traversal (code graph + brain graph) is performed in memory after loading from both DBs:

1. Load `nexus_nodes` + `nexus_relations` for a symbol and its N-hop neighborhood.
2. Load `nexus_brain_links` for all nexus node IDs in the neighborhood.
3. Load `brain_page_nodes` and relevant `brain_decisions`/`brain_learnings` for the brain node IDs.
4. Assemble into a unified response object.

Cross-database JOIN is impossible (two SQLite files). Always fetch from each DB separately and join in application code.

---

## Appendix A: File Map Summary

| New File | Phase | Wave |
|----------|-------|------|
| `packages/nexus/src/pipeline/knowledge-graph.ts` | Core | 1 |
| `packages/nexus/src/pipeline/symbol-table.ts` | Core | 2 |
| `packages/nexus/src/pipeline/pipeline.ts` | Orchestrator | 4 |
| `packages/nexus/src/pipeline/phases/phase1-walk.ts` | Phase 1 | 1 |
| `packages/nexus/src/pipeline/phases/phase2-structure.ts` | Phase 2 | 1 |
| `packages/nexus/src/pipeline/phases/phase3-parse.ts` | Phase 3 | 2 |
| `packages/nexus/src/pipeline/phases/phase3a-import-resolve.ts` | Phase 3a | 2 |
| `packages/nexus/src/pipeline/phases/phase3b-wildcard.ts` | Phase 3b | 6 |
| `packages/nexus/src/pipeline/phases/phase3c-heritage.ts` | Phase 3c | 3 |
| `packages/nexus/src/pipeline/phases/phase3d-route.ts` | Phase 3d | 4 |
| `packages/nexus/src/pipeline/phases/phase3e-call-resolve.ts` | Phase 3e | 3 |
| `packages/nexus/src/pipeline/phases/phase3f-assignment.ts` | Phase 3f | 5 |
| `packages/nexus/src/pipeline/phases/phase4-mro.ts` | Phase 4.5 | 3 |
| `packages/nexus/src/pipeline/phases/phase5-community.ts` | Phase 5 | 4 |
| `packages/nexus/src/pipeline/phases/phase6-process.ts` | Phase 6 | 4 |
| `packages/nexus/src/pipeline/phases/phase14-cross-file.ts` | Phase 14 | 5 |
| `packages/nexus/src/intelligence/providers/python.ts` | Provider | 6 |
| `packages/nexus/src/intelligence/providers/rust.ts` | Provider | 6 |
| `packages/nexus/src/intelligence/providers/go.ts` | Provider | 6 |

| Modified File | Change | Wave |
|--------------|--------|------|
| `packages/core/src/store/nexus-schema.ts` | Add `nexusNodes`, `nexusRelations`, `nexusBrainLinks` | 1 |
| `packages/contracts/src/graph.ts` | Expand `GraphNodeKind`, `GraphRelationType`, `GraphNode`, new interfaces | 1 |
| `packages/nexus/src/intelligence/providers/typescript.ts` | Add `heritageRaw` emission | 3 |
| `packages/nexus/src/index.ts` | Export new pipeline surface | 4 |

---

## Appendix B: Key Invariants for Workers

1. **Call resolution runs LAST** — never before all files are parsed. Violating this produces incorrect graph data because the HeritageMap is incomplete.

2. **Community detection needs CALLS edges** — run Phase 5 only after Phase 3e completes.

3. **Process detection needs communities** — run Phase 6 after Phase 5.

4. **`code_index` is NOT replaced** — both tables are populated from the same parse pass. Do not remove or alter `code_index`.

5. **No `any` types** — all data flows through typed contracts. If a contract type is missing, add it to `packages/contracts/src/graph.ts` or the schema enums.

6. **Soft FKs across DBs** — `nexus_brain_links.brain_node_id` references brain.db. Never try to enforce this with SQLite FK pragmas. It is a soft FK by convention.

7. **Confidence values are semantic** — do not normalize or round-trip confidence through the DB. Store the exact float from the resolver.

8. **Node IDs are stable** — format `<relativeFilePath>::<symbolName>` for symbol nodes, `<relativeFilePath>` for file nodes, `community:<N>` for communities, `process:<slug>` for processes. Never use absolute paths.
