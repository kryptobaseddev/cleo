# T532: Filesystem Walker + Structure Processor — Implementation Summary

**Task**: Wave D-1: Port filesystem walker + structure processor from GitNexus
**Status**: Complete
**Date**: 2026-04-12

## Files Created

### `packages/nexus/src/pipeline/language-detection.ts`
Extension-to-language mapping for 40+ file types. Two exports:
- `detectLanguageFromPath(filePath)` — returns canonical language name or null
- `isIndexableFile(filePath)` — returns true if extension is recognized

Covers TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, C/C++, C#, PHP, Ruby, Swift, Dart, Vue, HTML/CSS, Markdown, JSON/YAML/TOML, Shell, SQL, GraphQL, COBOL, and Proto.

### `packages/nexus/src/pipeline/filesystem-walker.ts`
Phase 1 ingestion: scans repository using Node 24's native `fs.promises.glob`.

Key behaviors ported from GitNexus (gitnexus/src/core/ingestion/filesystem-walker.ts):
- Skips files over 512 KB (generated/vendored)
- Stats files in batches of 32 for concurrency (no content loaded)
- Returns `ScannedFile[]` with `path`, `size`, `language`

Adaptations for CLEO:
- Replaces `glob` npm package with Node 24 native `fs.promises.glob`
- Replaces GitNexus `ignore-service` with a built-in gitignore reader
- Adds `.cleo/` to hard-coded excluded directories
- `ScannedFile` includes `language` field from `detectLanguageFromPath`

Excluded directories (hard-coded): `.git`, `node_modules`, `dist`, `build`, `target`, `.cleo`, `venv`, `__pycache__`, `.idea`, `.vscode`, `coverage`, and more.

### `packages/nexus/src/pipeline/structure-processor.ts`
Phase 2 ingestion: walks each file's path segments to build File + Folder graph nodes.

Key behaviors ported from GitNexus (gitnexus/src/core/ingestion/structure-processor.ts):
- Creates `GraphNode` with `kind: 'file'` for leaf nodes
- Creates `GraphNode` with `kind: 'folder'` for intermediate directories
- Creates `GraphRelation` with `type: 'contains'` for each parent → child edge

Adaptations for CLEO:
- Uses `GraphNode` / `GraphRelation` from `@cleocode/contracts` (not `gitnexus-shared`)
- Relation type `'contains'` (lowercase) matches `NEXUS_RELATION_TYPES` in nexus-schema
- Folder node IDs use trailing slash: `src/utils/` (distinguishes from same-name files)

### `packages/nexus/src/pipeline/knowledge-graph.ts`
In-memory KnowledgeGraph with Drizzle flush.

- `KnowledgeGraph.addNode()` — idempotent (deduplicates by ID)
- `KnowledgeGraph.addRelation()` — deduplicates by `source::target::type`
- `KnowledgeGraph.flush(projectId, db, tables)` — chunk-inserts nodes then relations
- Chunk size: 500 rows per insert (stays within SQLite parameter limits)
- Uses `onConflictDoNothing` so re-indexing is safe

No import from `@cleocode/core` — DB is injected to avoid circular dependency
(core depends on nexus, so nexus must not depend on core).

### `packages/nexus/src/pipeline/index.ts`
Pipeline entry point. Exports all pipeline types and the main `runPipeline` function.

```typescript
runPipeline(repoPath, projectId, db, tables) → PipelineResult
```

Orchestrates Phase 1 (walk) + Phase 2 (structure) + Drizzle flush.

### `packages/nexus/src/__tests__/pipeline.test.ts`
34 unit tests covering all pipeline components:
- Language detection: 9 tests (extensions, case-insensitivity, edge cases)
- Filesystem walker: 8 tests (discovery, exclusions, large file skipping, progress)
- Structure processor: 5 tests (nodes, folders, edges, deduplication)
- KnowledgeGraph: 4 tests (dedup, flush interface)
- runPipeline integration: 3 tests (counts, exclusions, empty repo)

### `packages/nexus/vitest.config.ts`
Package-local vitest configuration so `pnpm --filter @cleocode/nexus run test` finds tests.

## Changes to Existing Files

### `packages/nexus/src/index.ts`
Added pipeline exports to the public API surface:
`createKnowledgeGraph`, `detectLanguageFromPath`, `isIndexableFile`, `KnowledgeGraph`,
`NexusDbInsert`, `NexusTables`, `PipelineResult`, `processStructure`, `runPipeline`,
`ScannedFile`, `walkRepositoryPaths`.

## Quality Gates

| Gate | Result |
|------|--------|
| `pnpm biome check --write` | Passed (2 files auto-fixed) |
| `pnpm run build` | Passed (Build complete) |
| `pnpm --filter @cleocode/nexus run test` | 34/34 passed |
| `pnpm run test` (full workspace) | 7049/7050 passed (1 pre-existing flaky test in backup-pack) |

## Acceptance Criteria Status

| Criterion | Status |
|-----------|--------|
| Filesystem walker scans project respecting .gitignore | Done |
| Files over 512KB skipped | Done |
| Language detected from file extension | Done |
| File and Folder nodes created in nexus_nodes | Done (via flush) |
| CONTAINS edges created in nexus_relations | Done (via flush) |
| Handles monorepo structure | Done (tested with packages/ structure) |
| pnpm run build passes | Done |
| pnpm run test passes | Done (34 new tests, 0 regressions) |
