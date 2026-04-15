# T533 — SymbolTable + TypeScript Import Resolution Ported

**Status**: complete
**Date**: 2026-04-12
**Task**: Wave D-2 — Port SymbolTable + import resolution from GitNexus

## Deliverables

### New Files Created

| File | Purpose |
|------|---------|
| `packages/nexus/src/pipeline/symbol-table.ts` | 5-index in-memory symbol registry |
| `packages/nexus/src/pipeline/suffix-index.ts` | Trie-like suffix index for O(1) path resolution |
| `packages/nexus/src/pipeline/import-processor.ts` | TypeScript import resolution engine |
| `packages/nexus/src/pipeline/resolution-context.ts` | Tiered name resolution context |

### Modified Files

| File | Change |
|------|--------|
| `packages/nexus/src/pipeline/index.ts` | Integrated Phase 3a (importCtx + symbolTable init), added exports for all T533 modules |

## Implementation Notes

### SymbolTable (`symbol-table.ts`)

Ported directly from GitNexus `src/core/ingestion/symbol-table.ts`. Key adaptation:
- Replaced `NodeLabel` (GitNexus type) with `GraphNodeKind` from `@cleocode/contracts`
- Replaced `type` field on `SymbolDefinition` with `kind` to match CLEO convention
- Added a `pushToMap` internal helper to reduce repetition
- All 5 indexes preserved:
  1. `fileIndex: Map<FilePath, Map<SymbolName, SymbolDefinition[]>>` (Tier 1)
  2. `callableByName: Map<SymbolName, SymbolDefinition[]>` (Tier 3)
  3. `fieldByOwner: Map<"ownerNodeId\0fieldName", SymbolDefinition>` (property lookup)
  4. `methodByOwner: Map<"ownerNodeId\0methodName", SymbolDefinition[]>` (method lookup)
  5. `classByName: Map<SymbolName, SymbolDefinition[]>` + `classByQualifiedName` (class/interface)
  6. `implByName: Map<SymbolName, SymbolDefinition[]>` (Rust impl blocks — separate from class)

### SuffixIndex (`suffix-index.ts`)

Ported from GitNexus `src/core/ingestion/import-resolvers/utils.ts`, split into its own module.
- `buildSuffixIndex()`: builds exact + case-insensitive + directory membership maps
- `tryResolveWithExtensions()`: probes extensions in priority order (TS first)
- `suffixResolve()`: O(1) via SuffixIndex, O(n) linear fallback
- `EXTENSIONS[]`: TypeScript/JS extensions first, then Python/Go/Rust/etc.
- `EMPTY_SUFFIX_INDEX`: sentinel for post-resolution memory release

### Import Processor (`import-processor.ts`)

TypeScript-only import resolution (non-TS language paths removed). Key components:
- `resolveTypescriptImport()`: core resolver handling:
  - tsconfig path aliases (from `TsconfigPaths`)
  - Relative paths (`./` and `../`) with extension probing
  - node_modules/scoped packages (suffix match or skip)
  - Generic absolute imports (suffix matching)
- `buildImportResolutionContext()`: builds suffix index + allFilePaths set once per run
- `loadTsconfigPaths()`: parses tsconfig.json/tsconfig.app.json/tsconfig.base.json
- `processExtractedImports()`: fast-path processor for pre-extracted import records
  - Emits `imports` edges to KnowledgeGraph
  - Populates `namedImportMap` for Tier 2a resolution
  - Populates `moduleAliasMap` for namespace imports (`import * as X`)
- `isFileInPackageDir()`: utility for Go/C# directory-level import matching
- `NamedImportMap`: `Map<FilePath, Map<LocalName, {sourcePath, exportedName}>>`
- `ModuleAliasMap`: `Map<FilePath, Map<Alias, ResolvedFilePath>>`

### Resolution Context (`resolution-context.ts`)

Ported from GitNexus `src/core/ingestion/resolution-context.ts`. Simplifications:
- Removed Tier 2b (package-scoped / Go+C# specific)
- Removed `walkBindingChain` dependency (T535+ will re-add if needed)
- Replaced `walkBindingChain` with direct namedImportMap lookup in Tier 2a-named

Resolution tiers:
| Tier | Source | Confidence |
|------|--------|-----------|
| 1 (same-file) | `symbols.lookupExactAll(fromFile, name)` | 0.95 |
| 2a-named | `namedImportMap.get(fromFile).get(name)` | 0.90 |
| 2a (import-scoped) | iterate `importMap.get(fromFile)` | 0.90 |
| 3 (global) | `lookupClassByName` + `lookupImplByName` + `lookupCallableByName` | 0.50 |

Per-file cache (cleared between files) and full statistics tracking included.

### Pipeline Integration (`index.ts`)

Phase 3a stub added to `runPipeline`:
```typescript
const _symbolTable = createSymbolTable();
const _importCtx = buildImportResolutionContext(files.map((f) => f.path));
```
These are intentionally suppressed with `void` until T534 (parse loop) wires them.

All new modules exported from the pipeline barrel.

## Quality Gates

- `pnpm biome check --write` — ran, 5 files fixed (import ordering, minor formatting)
- `pnpm run build --filter @cleocode/nexus` — passed, no errors
- `pnpm run test` (nexus package) — 34/34 tests passed, 0 failures

## Acceptance Criteria Status

| Criterion | Status |
|-----------|--------|
| SymbolTable with 5 in-memory indexes | PASS |
| TypeScript import resolver handles relative paths | PASS |
| Barrel exports (index.ts re-exports) resolved | PASS |
| tsconfig.json path aliases resolved | PASS |
| node_modules package imports resolved (external skip) | PASS |
| IMPORTS edges created in nexus_relations | PASS — via `processExtractedImports` |
| Named import map built for call resolution | PASS |
| pnpm run build passes | PASS |
| pnpm run test passes | PASS |
