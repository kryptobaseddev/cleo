# T513: GitNexus Pipeline Architecture Study

**Research Type**: R (Research)
**Date**: 2026-04-11
**Status**: complete
**Source**: `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/`

---

## Executive Summary

GitNexus has a multi-phase ingestion pipeline (~76KB `pipeline.ts` + ~400KB of processors) that scans a repository, parses all source files with tree-sitter, extracts symbols, resolves cross-file relationships, and produces an in-memory knowledge graph. The pipeline is NOT a simple 14-step sequential chain — it is a chunked, parallel, two-pass architecture. This document maps all phases with their exact data contracts so the CLEO port can be planned accurately.

---

## 1. Pipeline Architecture — Phase Map

The main orchestrator is `runPipelineFromRepo()` in `pipeline.ts`. It calls three major sub-functions, each encapsulating a named phase group.

### Phase Group A: `runScanAndStructure()`

| Sub-Phase | Name | Purpose | Inputs | Outputs |
|-----------|------|---------|--------|---------|
| 1 | Filesystem Scan | Walk repo with glob, stat files (no content read) | `repoPath` (disk) | `ScannedFile[]` (path + size) |
| 2 | Structure Processing | Create File + Folder nodes and CONTAINS edges | `allPaths: string[]` | graph nodes/edges |
| 2.5 | Markdown Processing | Parse `.md`/`.mdx` headings + cross-links | `.md` file contents | Section nodes, cross-link edges |
| 2.6 | COBOL Processing | Regex-based extraction (no tree-sitter) | `.cob`/`.jcl` files | Program/Paragraph/Section nodes |

**Key design**: Phase 1 only stats files (no content), keeping memory to ~10MB for 100K files. Content is read lazily by subsequent phases in budget-sized chunks.

**Filesystem walker**: `walkRepositoryPaths()` uses `glob('**/*')` with a `.gitignore`-aware filter. Max file size: 512KB. Files larger than that are skipped (generated/vendored).

### Phase Group B: `runChunkedParseAndResolve()`

This is the core loop. Files are split into byte-budget chunks (~20MB each) and processed in a `for` loop:

| Sub-Phase | Name | Purpose | Inputs | Outputs |
|-----------|------|---------|--------|---------|
| 3 | Chunked Parse | Tree-sitter parse each chunk via worker pool or sequential fallback | chunk file contents, SymbolTable | graph nodes (symbols), `ParseWorkerResult` per chunk |
| 3a | Import Resolution | Resolve raw import paths to actual file paths, create IMPORTS edges | `ExtractedImport[]`, suffix index | `importMap`, `namedImportMap`, IMPORTS graph edges |
| 3b | Wildcard Synthesis | For Go/Ruby/C/C++/Swift/Python: expand whole-module imports to per-symbol bindings | `exportedSymbolsByFile`, `importMap` | `namedImportMap` entries (synthetic) |
| 3c | Heritage Resolution | Resolve EXTENDS/IMPLEMENTS edges per chunk (deferred to after all chunks for call resolution) | `ExtractedHeritage[]` | EXTENDS/IMPLEMENTS graph edges, HeritageMap |
| 3d | Route Resolution | Resolve framework routes (Laravel, decorator-based) | `ExtractedRoute[]`, `ExtractedDecoratorRoute[]` | Route nodes, HANDLES_ROUTE edges |
| 3e | Call Resolution (deferred) | After ALL chunks: process all buffered ExtractedCall records with complete HeritageMap | `deferredWorkerCalls`, complete `HeritageMap` | CALLS, ACCESSES graph edges |
| 3f | Assignment Resolution | Process property assignment records | `ExtractedAssignment[]` | ACCESSES graph edges |
| 3.5 | Route Registry | Build route registry from Next.js/Expo/PHP filesystem routes + framework/decorator routes | `allPaths`, `allExtractedRoutes`, `allDecoratorRoutes` | `routeRegistry` map |
| 3.5b | Middleware Linking | Link Next.js project-level `middleware.ts` to routes | `routeRegistry`, middleware files | Route node `middleware` property updates |
| 3.5c | Expo Navigation | Extract Expo Router navigation patterns | Expo app files | additional `allFetchCalls` entries |
| 3.6 | Tool Detection | Detect MCP/RPC tool definitions | `allToolDefs`, tool candidate files | Tool nodes, HANDLES_TOOL edges |
| 3.7 | ORM Detection | Detect Prisma/Supabase queries (regex-based) | `allORMQueries` | CodeElement (model) nodes, QUERIES edges |

**Critical ordering constraint**: Call resolution is deferred until ALL chunks have been parsed so the `HeritageMap` (implementor index for interface dispatch) is complete. This prevents interface method dispatch from missing implementing classes parsed in later chunks.

**Worker path vs sequential path**: When files >= 15 or total bytes >= 512KB, a worker pool is spawned (up to 8 workers, `os.cpus().length - 1`). Workers parse sub-batches of 1500 files each and return `ParseWorkerResult` structs over structured clone IPC. The sequential fallback does all work in the main thread with the same algorithms.

### Phase Group C: Cross-File Propagation (Phase 14)

| Phase | Name | Purpose | Inputs | Outputs |
|-------|------|---------|--------|---------|
| 14 | Cross-file type propagation | Re-resolve call targets using return types of imported functions | `exportedTypeMap`, topological sort of import graph | Updated CALLS edges with better receiver types |

**Threshold guard**: Only runs if >= 3% of files have cross-file binding gaps AND fewer than 2,000 files need re-processing. Files are re-processed in topological order (Kahn's algorithm) so upstream return types are available when downstream files are re-resolved.

### Phase Group D: `runGraphAnalysisPhases()`

| Sub-Phase | Name | Purpose | Inputs | Outputs |
|-----------|------|---------|--------|---------|
| 4.5 | MRO (Method Resolution Order) | Walk EXTENDS/IMPLEMENTS DAG, detect overrides, emit METHOD_OVERRIDES + METHOD_IMPLEMENTS edges | full graph EXTENDS/HAS_METHOD edges | METHOD_OVERRIDES edges, METHOD_IMPLEMENTS edges |
| 5 | Community Detection (Leiden) | Cluster symbols by call density via Leiden algorithm | CALLS/EXTENDS/IMPLEMENTS edges from graph | Community nodes, MEMBER_OF edges |
| 6 | Process Detection | Trace execution flows via BFS from entry points | CALLS adjacency, Community memberships, entry point scores | Process nodes, STEP_IN_PROCESS edges, ENTRY_POINT_OF edges |

Post-graph phases are skipped when `options.skipGraphPhases = true` (used in test runs).

---

## 2. Critical Data Structures

### 2.1 SymbolTable (in-memory, per pipeline run)

Five internal indexes, all Map-based:
1. `fileIndex: Map<FilePath, Map<SymbolName, SymbolDefinition[]>>` — per-file lookup (Tier 1 resolution)
2. `callableByName: Map<SymbolName, SymbolDefinition[]>` — all Function/Method/Constructor/Macro/Delegate (Tier 3)
3. `fieldByOwner: Map<"ownerNodeId\0fieldName", SymbolDefinition>` — property lookup
4. `methodByOwner: Map<"ownerNodeId\0methodName", SymbolDefinition[]>` — method lookup with overload support
5. `classByName: Map<SymbolName, SymbolDefinition[]>` + `classByQualifiedName` — Class/Struct/Interface/Enum/Record lookup

`SymbolDefinition` carries: `nodeId, filePath, type (NodeLabel), qualifiedName?, parameterCount?, requiredParameterCount?, parameterTypes?, returnType?, declaredType?, ownerId?`

### 2.2 ResolutionContext (wraps SymbolTable + import maps)

Single implementation of tiered name resolution. Tiers:
- **Tier 1 (same-file)**: `symbols.lookupExactAll(fromFile, name)` — confidence 0.95
- **Tier 2a-named**: `walkBindingChain(name, fromFile, ...)` via NamedImportMap — confidence 0.90
- **Tier 2a (import-scoped)**: iterate `importMap.get(fromFile)`, lookupExactAll per file — confidence 0.90
- **Tier 2b (package-scoped)**: inverted package dir index, lookupExactAll per file in package — confidence 0.90
- **Tier 3 (global)**: `lookupClassByName + lookupImplByName + lookupCallableByName` — confidence 0.50

Also holds: `importMap`, `packageMap`, `namedImportMap`, `moduleAliasMap` (Python namespace imports).

### 2.3 ImportResolutionContext

Built once from `allPaths` before chunking:
- `allFilePaths: Set<string>`
- `normalizedFileList: string[]`
- `index: SuffixIndex` (trie/suffix-indexed file list for O(log n) path resolution)
- `resolveCache: Map<string, string>` (memoized resolution results)

Freed after all chunks to reclaim ~94MB on large repos.

### 2.4 ExportedTypeMap

`Map<FilePath, Map<SymbolName, SimpleTypeName>>` — populated during call processing, consumed by Phase 14. Tracks the resolved return type of each exported symbol, enabling cross-file call result binding (e.g., `getUser()` returns `User`, so `user.save()` dispatches to `User.save`).

### 2.5 BindingAccumulator

Phase 9 structure: collects file-scope variable-to-type bindings from worker IPC (since workers can't share TypeEnv). After all chunks, used by `enrichExportedTypeMap` to add inferred return types to the ExportedTypeMap. Lifecycle: `append* → finalize → consume → dispose`. Freed before Phase 14.

### 2.6 HeritageMap

Built from `ExtractedHeritage[]` after all chunks complete. Two indexes:
- `directParents: Map<childNodeId, Set<parentNodeId>>` — parent lookup for MRO
- `implementorFiles: Map<interfaceName, Set<filePath>>` — interface dispatch (which files have implementing classes)

### 2.7 Worker Pool

`createWorkerPool(workerUrl, poolSize?)` spawns up to 8 Node.js Worker threads. Items are split into worker-count chunks, each sent as sub-batches of 1500 files with a 30-second per-sub-batch timeout. Results aggregated back in order. Spawning requires the compiled `dist/` worker script; falls back to sequential if script not found.

---

## 3. Node Types (28 total in LadybugDB / NODE_TABLES)

From `gitnexus-shared/src/lbug/schema-constants.ts`:

**Structural**: `File`, `Folder`, `Module`

**Symbols**: `Function`, `Class`, `Interface`, `Method`, `Property`, `Constructor`, `Enum`, `Struct`, `Trait`, `Impl` (Rust), `TypeAlias`, `Const`, `Static`, `Record`, `Delegate` (C#), `Annotation`, `Template`, `Union`, `Typedef`, `Macro`, `Namespace`, `CodeElement` (catch-all)

**Graph meta**: `Community`, `Process`, `Section` (Markdown heading)

**Integration**: `Route`, `Tool`

Total: 29 NODE_TABLES entries (the `NodeLabel` type has 30 including `Package` not in NODE_TABLES, and `Variable`, `Decorator`, `Import`, `Type` which are in `NodeLabel` but not in `NODE_TABLES`).

---

## 4. Relationship Types (20 total)

From `schema-constants.ts` `REL_TYPES`:

| Type | Direction | Meaning |
|------|-----------|---------|
| `CONTAINS` | Folder→File, File→Symbol | Structural containment |
| `DEFINES` | File→Symbol | Symbol defined in file |
| `IMPORTS` | File→File | Import dependency |
| `CALLS` | Symbol→Symbol | Function/method call |
| `EXTENDS` | Class→Class | Inheritance |
| `IMPLEMENTS` | Class→Interface | Interface implementation |
| `HAS_METHOD` | Class→Method | Method membership |
| `HAS_PROPERTY` | Class→Property | Property membership |
| `ACCESSES` | Symbol→Property | Property access |
| `METHOD_OVERRIDES` | Class→Method | MRO winner override |
| `METHOD_IMPLEMENTS` | Method→Method | Concrete implements abstract |
| `MEMBER_OF` | Symbol→Community | Community membership |
| `STEP_IN_PROCESS` | Symbol→Process | Execution flow step |
| `HANDLES_ROUTE` | File→Route | Route handler link |
| `FETCHES` | File→Route | Fetch call to route |
| `HANDLES_TOOL` | File→Tool | MCP tool handler |
| `ENTRY_POINT_OF` | Route/Tool→Process | Entry point to execution flow |
| `WRAPS` | Function→Function | Middleware wrapping |
| `QUERIES` | File→CodeElement | ORM query to model |
| `OVERRIDES` | (legacy alias for METHOD_OVERRIDES) | |

---

## 5. Language Providers (16 languages)

From `languages/index.ts`:

| Language | Provider file | Import Semantics | MRO Strategy |
|----------|--------------|------------------|--------------|
| TypeScript/JavaScript | `typescript.ts` | named | first-wins |
| Python | `python.ts` | namespace | c3 |
| Java | `java.ts` | named | implements-split |
| Kotlin | `kotlin.ts` | named | first-wins |
| Go | `go.ts` | wildcard | first-wins |
| Rust | `rust.ts` | named | qualified-syntax |
| C# | `csharp.ts` | named | implements-split |
| C | `c-cpp.ts` | wildcard | leftmost-base |
| C++ | `c-cpp.ts` | wildcard | leftmost-base |
| PHP | `php.ts` | named | first-wins |
| Ruby | `ruby.ts` | wildcard | first-wins |
| Swift | `swift.ts` | wildcard (+ implicit wiring) | first-wins |
| Dart | `dart.ts` | named | first-wins |
| Vue | `vue.ts` | named (preprocessed SFC) | first-wins |
| COBOL | `cobol.ts` | standalone (regex) | n/a |

Each provider implements `LanguageProvider`:
- `id`, `extensions`, `treeSitterQueries` (the query string for definitions/imports/calls/heritage)
- `typeConfig: LanguageTypeConfig` — type extraction rules
- `exportChecker: ExportChecker` — is this node exported?
- `importResolver: ImportResolverFn` — resolve raw import path to file path
- Optional: `callRouter`, `namedBindingExtractor`, `importPathPreprocessor`, `implicitImportWirer`, `enclosingFunctionFinder`, `labelOverride`, `heritageDefaultEdge`, `interfaceNamePattern`, `mroStrategy`, `fieldExtractor`, `methodExtractor`, `classExtractor`, `descriptionExtractor`, `isRouteFile`, `builtInNames`

**Import semantics** determine wildcard synthesis:
- `named` (TS, Java, C#, Rust, PHP, Kotlin, Dart): per-symbol imports, no synthesis needed
- `wildcard` (Go, Ruby, C, C++, Swift): all exported symbols visible, synthesis expands to per-symbol namedImportMap entries
- `namespace` (Python): module-alias map built instead (`import models` → `models.User` resolves via alias)

---

## 6. Type Extractors

In `type-extractors/` subdirectory (per-language type inference rules):

Each language file exports a `LanguageTypeConfig` with:
- `declarationTypes`: AST node types that carry type annotations (e.g., `type_annotation`, `declared_type`)
- `initializerTypes`: AST node types used for type inference from initializers (literal types)
- `forLoopTypes`: AST node types for loop variable binding (infer element type from collection)
- `inferFromLiteral: LiteralTypeInferrer` — function that maps literal node types to type names

These drive `buildTypeEnv()` in `type-env.ts` (56KB — the biggest single concern for porting).

The `type-env.ts` TypeEnvironment tracks variable-to-type bindings within each scope during sequential parse. For each function body, it maps `varName → typeName`, enabling `user.save()` to resolve `user` → `User` when `const user: User = getUser()` is in scope.

---

## 7. Community Detection — Leiden Algorithm

**File**: `community-processor.ts`

**Algorithm**: Vendored Leiden algorithm (CJS, loaded via `createRequire`). The source is from `graphology-communities-leiden` which was never published to npm.

**Process**:
1. Build a `graphology` undirected graph from the knowledge graph
2. Include only `Function`, `Class`, `Method`, `Interface` nodes that have CALLS/EXTENDS/IMPLEMENTS edges
3. For large graphs (>10K symbols): filter edges below confidence 0.5 and skip degree-1 nodes
4. Run `leiden.detailed(graph, { resolution: 1.0 | 2.0, maxIterations: 0 | 3 })`
5. 60-second timeout with fallback (assign all to community 0)
6. Group results by community number, skip singletons (size < 2)
7. Generate heuristic labels from most common folder name among members
8. Calculate cohesion (internal edge ratio)

**Cohesion formula**: internal edges (both endpoints in same community) / total edges touching any community member.

**Label generation**: Count folder names from member file paths, skip generic names (`src`, `lib`, `utils`, `core`, `components`, `types`, `helpers`, `common`), take top 3 folders as the label.

**Output**: `Community` nodes (id, label, heuristicLabel, cohesion, symbolCount) + `MEMBER_OF` edges.

**Porting note**: The Leiden algorithm vendor bundle (`vendor/leiden/index.cjs`) needs to be bundled with CLEO or replaced with a JS port. This is the largest external dependency for community detection.

---

## 8. Process Detection — Execution Flow Tracing

**File**: `process-processor.ts`

**Algorithm**: BFS from scored entry points.

**Entry point scoring** (`entry-point-scoring.ts`):
- Base score: `callees / (callers + 1)` (functions that call many but are called by few)
- Multipliers for: exported status, universal name patterns (`handle*`, `on*`, `*Controller`), per-language patterns (Django views, ASP.NET actions, etc.), framework path patterns (detected from file path)
- Test files excluded entirely
- Top 200 candidates selected

**Trace algorithm**:
1. BFS forward via CALLS edges (confidence >= 0.5 only)
2. Max depth: 10, max branching: 4, max processes: 75/300 (dynamic: `max(20, min(300, symbolCount/10))`)
3. Min steps: 3 (2-step traces discarded as trivial)
4. Cycle prevention: path.includes() check

**Deduplication** (two passes):
1. Subset removal: if trace A is a subset of trace B, keep only B
2. Endpoint deduplication: for same (entry, terminal) pair, keep longest path

**Output**: `Process` nodes (id, label, heuristicLabel, processType, stepCount, communities, entryPointId, terminalId) + `STEP_IN_PROCESS` edges + `ENTRY_POINT_OF` edges linking Route/Tool nodes to their Process.

---

## 9. What T506 Already Ported vs What Remains

### Already in `@cleocode/nexus` (T506)

| Component | Status | Location |
|-----------|--------|----------|
| Tree-sitter integration | Done | `src/code/parser.ts` |
| `LanguageProvider` interface | Done (simplified) | `src/intelligence/language-provider.ts` |
| Graph types (`GraphNode`, `GraphRelation`, `GraphNodeKind`, `GraphRelationType`) | Done | `packages/contracts/src/graph.ts` |
| Basic impact analysis (BFS) | Done | `src/intelligence/impact.ts` |
| `code_index` Drizzle schema | Done | `src/schema/code-index.ts` |
| TypeScript language provider (basic) | Done | `src/intelligence/providers/typescript.ts` |

### Missing for T513

| Component | Complexity | Notes |
|-----------|-----------|-------|
| Filesystem walker | small | Phase 1 — glob with gitignore filter |
| Structure processor | small | Creates File/Folder/CONTAINS nodes |
| Full graph schema (Drizzle) | medium | 28+ node tables, 20 relationship types need Drizzle tables |
| SymbolTable | medium | 5 in-memory indexes; needs to map to/from Drizzle rows |
| ImportResolutionContext + suffix index | medium | Suffix-indexed trie for path resolution |
| Import processor (per-language) | large | Per-language resolver fns, named binding extraction |
| Wildcard import synthesis | medium | Go/Ruby/C/C++/Swift/Python |
| Chunked parse loop | medium | Byte-budget chunking, worker coordination |
| Worker pool | medium | Node.js Worker threads, sub-batch protocol |
| Call processor | very large | 128KB — virtual dispatch, MRO chain walking, TypeEnv, all resolution tiers |
| Heritage processor | medium | EXTENDS/IMPLEMENTS edge creation |
| Heritage map builder | small-medium | Parent lookup + implementor index |
| MRO processor | medium | C3 linearization, language-specific rules |
| Type environment (`type-env.ts`) | large | 56KB — scope tracking, literal inference, for-loop binding |
| Binding accumulator | small-medium | Worker IPC type binding aggregation |
| Leiden community detection | large | External algorithm, graphology integration |
| Process detection | medium | BFS traces, entry point scoring |
| Entry point scoring | small | Pattern matching + framework detection |
| Language providers (Python, Go, Rust, etc.) | large | Each needs tree-sitter queries + type configs + resolvers |
| Named binding processor | small-medium | Alias chain walking |
| Route extractors | medium | Next.js, Expo, PHP, decorator-based |
| ORM detection | small | Regex-based Prisma/Supabase |
| Tool detection | small | MCP tool definition detection |
| Phase 14 cross-file propagation | medium | Topological sort + re-resolution |
| Markdown processor | small | Section nodes + cross-links |
| AST cache | small | LRU cache for parsed trees |

---

## 10. Drizzle/SQLite Porting Strategy

The GitNexus pipeline uses an **in-memory graph** (arrays + Maps) that is later persisted to LadybugDB (a custom columnar graph database). CLEO needs to either:

**Option A: In-memory graph + periodic Drizzle flush** (recommended)
- Keep the full in-memory KnowledgeGraph during ingestion (same as GitNexus)
- After ingestion completes, batch-insert all nodes/relationships into Drizzle SQLite tables
- Re-load from Drizzle for queries (impact analysis, context queries)
- Avoids the complexity of writing to SQLite mid-ingestion (transaction size, WAL pressure)

**Option B: Direct Drizzle writes per phase**
- More complex — requires transactions per chunk, FK constraints, index rebuild
- Slower for large repos (many small inserts vs one batch)
- Not recommended for first port

### Drizzle Schema Design

The existing `code_index` table is a flat symbol index, not a graph. We need:

```
nexus_nodes     — id, project_id, label, name, file_path, start_line, end_line, language, is_exported, parent_id, return_type, declared_type, qualified_name, parameter_count, visibility, is_static, is_abstract, cohesion (for Community), step_count (for Process), process_type, properties (JSON blob for extras)
nexus_relations — id, project_id, source_id, target_id, type, confidence, reason, step
```

One unified node table avoids 28 separate DDL tables (which is what LadybugDB uses for performance — CLEO doesn't need that granularity). The `label` column discriminates type.

One unified relations table with a `type` text column. Index on `(project_id, source_id)` and `(project_id, target_id)` for traversal.

The SymbolTable can be rebuilt from `nexus_nodes` on load. ResolutionContext maps are ephemeral (rebuilt per analysis run or cached in memory).

---

## 11. Phase Dependency Graph

```
Phase 1 (scan) → Phase 2 (structure) → Phase 2.5 (markdown) → Phase 2.6 (COBOL)
                                                      ↓
Phase 3 (chunked parse loop):
  for each chunk:
    parse → imports → [wildcard synthesis] → defer(calls, heritage) → routes
                                                      ↓
  after all chunks: call resolution + assignment resolution
                                                      ↓
Phase 3.5 (route registry) → 3.5b (middleware) → 3.5c (expo nav)
Phase 3.6 (tool detection)
Phase 3.7 (ORM detection)
                                                      ↓
Phase 14 (cross-file propagation, conditional)
                                                      ↓
Phase 4.5 (MRO) → Phase 5 (Leiden communities) → Phase 6 (process detection)
```

**Hard dependencies**:
- Call resolution MUST wait for complete HeritageMap (all chunks)
- Community detection MUST wait for complete CALLS graph (all call resolution)
- Process detection MUST wait for community memberships
- Phase 14 MUST wait for ExportedTypeMap (populated during call resolution)

---

## 12. Key Algorithms Requiring Careful Porting

### 12.1 Call Resolution (call-processor.ts, 128KB)

The most complex component. Resolution pipeline per call site:
1. **D0 member-call dispatch**: If receiver type is known, look up method by `(ownerNodeId, methodName)` — O(1) via `methodByOwner` index
2. **D0 via TypeEnv**: Build TypeEnvironment per file, infer receiver type from local variables
3. **D1 MRO chain**: Walk ancestor chain via HeritageMap, check each ancestor's methods
4. **D2 widen**: Fall back to Tier 3 global lookup when class-specific lookup fails
5. **Interface dispatch**: Check implementorFiles, look up method in each implementing class

For CLEO's initial port: implement only free-function call resolution (Tier 1/2a/3) and basic member call dispatch. Interface dispatch and full MRO chain walking can come in a later sub-task.

### 12.2 Import Resolution

Path resolution uses a suffix index (a trie-like structure mapping path suffixes to full paths). For `./models/user` → finds `src/models/user.ts`. Language-specific resolvers handle:
- TypeScript: strip extensions, try `.ts`/`.tsx`/`.js`/`index.ts`
- Go: map package import path to directory suffix
- Ruby: `require 'user'` → find `user.rb` anywhere in project
- Python: `from . import models` → relative resolution

For CLEO port: start with TypeScript/JavaScript resolver, add others incrementally.

### 12.3 Leiden Algorithm

The vendored CJS bundle (`vendor/leiden/index.cjs`) must be either:
- Bundled with CLEO's nexus package as-is (copy the vendor/ dir)
- Replaced with a JS graph clustering library available on npm (e.g., `graphology-communities-louvain` which IS published)

Louvain is available on npm and produces similar results. Leiden produces better modularity scores but the difference is minor for CLEO's use case.

### 12.4 Topological Sort (Kahn's algorithm, Phase 14)

The `topologicalLevelSort()` function groups files into topological levels based on their import dependencies. Files at the same level have no mutual imports and can be processed in parallel for cross-file propagation. Cycles are detected and grouped as a final level. This is a clean, self-contained function that ports directly.

### 12.5 C3 Linearization (Python MRO)

The `c3Linearize()` function in `mro-processor.ts` implements Python's C3 linearization for method resolution in multiple-inheritance scenarios. It is a well-known algorithm that ports cleanly. Only needed if Python support is required.

---

## 13. Complexity Estimates for CLEO Port

| Phase/Component | Estimated Complexity | Port Strategy |
|-----------------|---------------------|---------------|
| Filesystem walker | small | Direct port |
| Structure processor | small | Direct port |
| SymbolTable (in-memory) | small-medium | Direct port (same data model) |
| ResolutionContext (Tier 1+2a) | medium | Port Tier 1+2a first, defer 2b+3 |
| Import processor (TS only) | medium | Port TS resolver, stub others |
| Chunked parse loop (sequential only) | medium | Skip worker pool initially |
| Worker pool | medium | Port after sequential works |
| Heritage processor | medium | Direct port |
| Heritage map builder | small | Direct port |
| Call processor (free functions only) | medium | Start with free-function calls |
| Call processor (full) | very large | Multi-sub-task effort |
| Type environment | large | Can stub initially, add incrementally |
| MRO processor | medium | Port after heritage works |
| Community detection (Leiden/Louvain) | medium | Use graphology-communities-louvain |
| Process detection | medium | Direct port after community detection |
| Phase 14 propagation | medium | Port after call resolution |
| Drizzle schema (unified node+rel tables) | medium | Design first, implement second |
| Additional language providers | large | One language per sub-task |
| Route/tool detection | small-medium | Optional for MVP |
| ORM detection | small | Optional for MVP |

---

## 14. Recommended Port Sequence for T513 Sub-Tasks

1. **Drizzle schema** — `nexus_nodes` + `nexus_relations` tables (replace flat `code_index`)
2. **Filesystem walker + structure processor** — produce File/Folder graph
3. **SymbolTable** — in-memory, exact match from GitNexus
4. **ResolutionContext** (Tier 1 + 2a only) — same-file + named import resolution
5. **Import processor** (TypeScript only) — IMPORTS edges, namedImportMap
6. **Heritage processor** — EXTENDS/IMPLEMENTS edges
7. **Heritage map** — parent lookup + implementor index
8. **Call processor** (free functions, Tier 1-3) — CALLS edges without virtual dispatch
9. **Sequential parse loop** (no workers yet) — orchestrate phases 1-3f
10. **MRO processor** — METHOD_OVERRIDES + METHOD_IMPLEMENTS edges
11. **Community detection** — Louvain via graphology, Community nodes + MEMBER_OF edges
12. **Process detection** — Process nodes + STEP_IN_PROCESS edges
13. **Worker pool** — parallel parsing for large repos
14. **Phase 14 propagation** — cross-file type propagation
15. **Additional language providers** — Python, Go, Rust (one per sub-task)
16. **Full call resolution** — TypeEnv, virtual dispatch, interface dispatch

---

## 15. What We Need to Add to `@cleocode/contracts`

Currently `GraphRelationType` in `contracts/src/graph.ts` is lowercase and missing several types present in GitNexus. Required additions:

```typescript
// Add to GraphRelationType:
| 'member_of'       // Community membership
| 'step_in_process' // Process step
| 'handles_route'   // Route handler
| 'fetches'         // Fetch call to route
| 'handles_tool'    // MCP tool handler
| 'entry_point_of'  // Route/tool → process
| 'wraps'           // Middleware wrapping
| 'queries'         // ORM query → model

// Add to GraphNodeKind (currently missing):
| 'community'       // Leiden community cluster
| 'process'         // Execution flow
| 'route'           // HTTP/RPC route
| 'tool'            // MCP/RPC tool
| 'section'         // Markdown section
| 'trait'           // Rust/PHP trait
| 'impl'            // Rust impl block
| 'type_alias'      // TypeScript type alias
| 'const'           // Exported const
| 'static'          // Static class member
| 'record'          // Java record / TS satisfies record
| 'delegate'        // C# delegate
| 'macro'           // C/C++ macro
| 'union'           // C union / Rust enum-like
| 'typedef'         // C typedef
| 'annotation'      // Java annotation
| 'template'        // C++ template
```

The existing `GraphNode` interface also needs additional optional fields: `qualifiedName`, `parameterCount`, `visibility`, `isStatic`, `isAbstract`, `isFinal`, `isAsync`, `returnType`, `declaredType`, `heuristicLabel`, `cohesion`, `symbolCount`, `processType`, `stepCount`, `entryPointId`, `terminalId`, `communities`.

---

## Sources

All findings are from direct code reading of:
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/pipeline.ts` (76KB)
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/parsing-processor.ts`
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/import-processor.ts`
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/call-processor.ts` (128KB, imports studied)
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/heritage-processor.ts`
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/heritage-map.ts`
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/mro-processor.ts`
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/community-processor.ts`
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/process-processor.ts`
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/entry-point-scoring.ts`
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/symbol-table.ts`
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/resolution-context.ts`
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/filesystem-walker.ts`
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/structure-processor.ts`
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/workers/parse-worker.ts` (types only)
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/workers/worker-pool.ts`
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/language-provider.ts`
- `/mnt/projects/gitnexus/gitnexus/src/core/ingestion/languages/index.ts`
- `/mnt/projects/gitnexus/gitnexus-shared/src/graph/types.ts`
- `/mnt/projects/gitnexus/gitnexus-shared/src/lbug/schema-constants.ts`
- `/mnt/projects/cleocode/packages/nexus/src/**` (existing ported foundations)
- `/mnt/projects/cleocode/packages/contracts/src/graph.ts`
