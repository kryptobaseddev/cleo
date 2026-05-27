# T618 Decomposition Plan — Barrel Tracing Integration into NEXUS Pipeline

**Date**: 2026-04-14
**Author**: Team Lead subagent
**Status**: FINAL

---

## Current Pipeline Flow

The NEXUS ingestion pipeline (Phase 3) flows as follows:

1. **parse-worker.ts** (parallel path): Each worker receives file batches, calls
   `extractImports`, `extractReExports`, `walkDefinitions`, `extractHeritage`,
   and `extractCalls`. Results (including `reExports`) are accumulated in a
   `ParseWorkerResult` and sent back to the main thread via IPC.

2. **parse-loop.ts `runParallelParseLoop`**: Collects all worker results. Merges
   `workerResult.reExports` into `allParallelReExports`. After all workers finish,
   calls `buildBarrelExportMap(allParallelReExports, importCtx, tsconfigPaths)` and
   returns `{ allHeritage, allCalls, barrelMap }`.

3. **parse-loop.ts `runParseLoop` (sequential fallback)**: For each file calls
   `runExtractor(lang, rootNode, file.path)` which returns `extractTypeScript(...)`.
   The local variable `extracted` is typed with an optional `reExports?` field.
   The result is collected into `allReExports`. After the loop, calls
   `buildBarrelExportMap(allReExports, importCtx, tsconfigPaths)` and returns
   `{ allHeritage, allCalls, barrelMap }`.

4. **pipeline/index.ts**: Destructures `{ allHeritage, allCalls, barrelMap }` from
   `runParseLoop`, then passes `barrelMap` to `resolveCalls(allCalls, graph,
   symbolTable, namedImportMap, barrelMap)`.

5. **call-processor.ts `resolveSingleCall`**: When Tier 2a finds a named import
   binding whose `sourcePath` is a barrel, calls `resolveBarrelBinding(...)` to
   follow the chain and look up the canonical symbol in the SymbolTable.

---

## Gap Analysis

The full end-to-end wiring is **already in place** across all four files as of the
disk state observed. The previous workers left partial work that has been completed.
Specifically:

- `parse-worker.ts` line 870: `extractReExports` IS called and results DO go into
  `result.reExports`.
- `parse-loop.ts` line 430-434: parallel path DOES collect `workerResult.reExports`.
- `parse-loop.ts` line 507: `buildBarrelExportMap(allParallelReExports, ...)` IS called.
- `parse-loop.ts` line 700-703: sequential path DOES collect `extracted.reExports`.
- `parse-loop.ts` line 740: `buildBarrelExportMap(allReExports, ...)` IS called.
- `pipeline/index.ts` line 659: `barrelMap` IS destructured from `runParseLoop`.
- `pipeline/index.ts` line 683: `barrelMap` IS passed to `resolveCalls`.
- `call-processor.ts` line 173-197: barrel tracing via `resolveBarrelBinding` IS
  wired into `resolveSingleCall`.

**However**, there is a type-level gap that may be silently discarding `reExports`
in the sequential path:

- `CommonExtractionResult` (parse-loop.ts lines 194-199) does NOT include `reExports`.
- `runExtractor` is declared to return `CommonExtractionResult` (line 216).
- TypeScript allows the `extracted` local variable (lines 671-677) to have
  `reExports?` as an optional field, because `extractTypeScript` actually returns
  `{ definitions, imports, heritage, calls, reExports }` — the richer type
  structurally satisfies `CommonExtractionResult` and the extra field survives at
  runtime.

This means the sequential path WORKS at runtime (the field is present on the
returned object even though the declared return type drops it), but the code is
fragile: if TypeScript strict mode ever inlines the type or a future refactor
changes the assignment, `reExports` could be lost.

**The real problem causing 0 callers for `findTasks`/`endSession` is likely one of:**

1. **Barrel map is populated but import resolution does not store named bindings
   for the callers** — i.e., `namedImportMap` entries for the files that call
   `findTasks` are missing or use the wrong source path key.
2. **The barrel map keys use absolute paths while the symbol table keys use
   relative paths** (or vice versa) — a path normalization mismatch between
   `buildBarrelExportMap` output and what `namedImportMap` stores.
3. **The barrel map is empty** (`barrelMap.size === 0`) because `extractReExports`
   in the worker or the sequential path is not seeing the barrel files — possibly
   because the barrel files (`packages/core/src/index.ts`) are processed in the
   sequential fallback rather than the worker path, or because `grammarKeyForPath`
   in parse-worker.ts does not handle them (it does, for `.ts`).

The `CLEO_BARREL_DEBUG` environment variable in the codebase (parse-loop.ts lines
478-506 and 669-686, call-processor.ts lines 150-188) can expose exactly which of
these three cases applies. This diagnostic work belongs in a dedicated micro-task.

---

## Micro-Task Decomposition

### T618-M1: Diagnostic run — measure actual barrel map output and import bindings
- **File**: No code changes. Run `CLEO_BARREL_DEBUG=1 cleo nexus analyze` and capture stderr.
- **Change**: Execute the pipeline with debug mode enabled. Capture:
  - `barrelMap.size` (parallel and sequential path)
  - Which barrel files are in the map
  - Whether `packages/core/src/index.ts` or `packages/cleo/src/index.ts` appear
  - The `tier2a-debug` trace for `coreFindTasks` or `findTasks`
- **Acceptance**: Diagnosis document identifies whether the root cause is (a) empty
  barrel map, (b) path mismatch, or (c) namedImportMap missing the callers.
- **Estimated tool uses**: 8-12

### T618-M2: Fix `CommonExtractionResult` to include `reExports` (type safety)
- **File**: `packages/nexus/src/pipeline/parse-loop.ts` lines 194-199 and 212-216
- **Change**: Add `reExports?: ExtractedReExport[]` to `CommonExtractionResult`.
  Update `runExtractor` return type from `CommonExtractionResult` to the extended
  type. Remove the redundant inline type on the `extracted` local variable (lines
  671-677) in favor of the interface. Add `reExports: []` to all default-return
  branches in `runExtractor` (Python/Go/Rust/default).
- **Acceptance**: `pnpm biome check --write .` and `pnpm run build` pass with zero
  new errors. The `extracted.reExports` access is type-safe without `?` guard.
- **Estimated tool uses**: 10-15

### T618-M3: Verify path normalization between barrel map and namedImportMap
- **Files**: `packages/nexus/src/pipeline/import-processor.ts` (around line 621-688)
  and `packages/nexus/src/pipeline/parse-loop.ts` (around line 419-434 parallel path)
- **Change**: Audit whether `resolveTypescriptImport` returns the same path format
  (relative vs absolute, with vs without leading `./`) as what `processExtractedImports`
  stores as `sourcePath` in `namedImportMap`. If there is a mismatch, normalize both
  to the same canonical form (relative, no leading `./`, forward slashes).
- **Acceptance**: After `cleo nexus analyze`, `cleo nexus context findTasks` returns
  5+ callers OR the diagnostic from M1 confirms path mismatch is not the root cause.
- **Estimated tool uses**: 20-25

### T618-M4: Fix namedImportMap population for callers of barrel-exported symbols
- **File**: `packages/nexus/src/pipeline/import-processor.ts` (function
  `processExtractedImports`, approximately lines 400-580)
- **Change**: Verify that when a file imports `{ findTasks }` from
  `@cleocode/core` (which resolves to a barrel), the `namedImportMap` entry
  stores the barrel file path as `sourcePath` (not the package name). If the
  Tier 2a lookup uses the tsconfig alias-resolved path but the barrel map uses
  the resolved file path, add a normalization step that ensures both use the
  same resolved file path.
- **Acceptance**: After `cleo nexus analyze`, `cleo nexus context findTasks`
  returns 5+ callers with tier `import-scoped`.
- **Estimated tool uses**: 20-25

### T618-M5: End-to-end integration test — verify caller counts after full re-index
- **Files**: `packages/nexus/src/__tests__/barrel-tracing.test.ts` (extend existing
  441-line suite with integration-style assertions)
- **Change**: Add 2-3 test cases that construct a minimal in-memory graph with
  barrel files and verify that `resolveCalls` with a populated `barrelMap` produces
  the correct CALLS edges. These tests do NOT re-index the live project; they use
  synthetic fixture data consistent with the existing test suite's patterns.
- **Acceptance**: `pnpm run test` reports zero new failures. New tests cover the
  named-import-through-barrel scenario (Tier 2a-barrel path in call-processor.ts
  lines 173-197).
- **Estimated tool uses**: 20-25

---

## Build Order

1. **M1 first** — diagnostic run costs no code changes, defines which of M2/M3/M4
   is the actual blocking bug. If M1 shows the barrel map is empty, M2 is the
   fix. If the barrel map is populated but callers are 0, M3/M4 apply.
2. **M2 second** — type-safety fix is low-risk and enables the rest of the work
   to be written against a clean interface. Can be merged independently.
3. **M3 third** — path normalization audit. Depends on M1 diagnosis to know
   which direction the mismatch goes.
4. **M4 fourth** — namedImportMap fix. Depends on M3 to understand the path
   conventions already established.
5. **M5 last** — integration tests seal the fix and prevent regression. Depends
   on M4 so the code under test is final.

---

## Integration Test Plan

After all micro-tasks merge, verify in order:

1. `pnpm run build` — zero errors
2. `pnpm run test` — zero new failures (barrel-tracing.test.ts all green)
3. `cleo nexus analyze` — completes without error; stderr shows
   `Barrel map: N barrel files` where N > 0
4. `cleo nexus context findTasks` — returns 5+ callers
5. `cleo nexus context endSession` — returns 5+ callers
6. `CLEO_BARREL_DEBUG=1 cleo nexus analyze 2>&1 | grep tier2a-debug` — shows
   non-null `resolveBarrelBinding` results for `findTasks`

---

## Partial Work Found

All four files show substantial in-progress work from previous workers:

- **parse-worker.ts**: Complete. `extractReExports` is called, `reExports` field
  is in `ParseWorkerResult`, and `mergeResult` copies it. No changes needed here.
- **parse-loop.ts**: Complete at runtime; has the type-safety gap described in M2.
  The `allParallelReExports` collection (parallel path), `allReExports` collection
  (sequential path), and `buildBarrelExportMap` calls are all present.
- **call-processor.ts**: Complete. `resolveBarrelBinding` is wired into
  `resolveSingleCall` at the Tier 2a-barrel branch. Debug tracing for
  `coreFindTasks` is present.
- **pipeline/index.ts**: Complete. `barrelMap` is passed to `resolveCalls`.

The gap is **not** missing wiring — it is a data-quality issue: either the barrel
map is empty (M2 type gap causing `reExports` to be silently ignored in a specific
code path) or a path normalization mismatch (M3/M4). M1 will disambiguate.
