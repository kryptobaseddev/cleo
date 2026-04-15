# T536 — Call Resolution (Tier 1+2a) + Heritage Processing

**Status**: complete
**Date**: 2026-04-12
**Task**: Wave E-1 — Port call resolution (Tier 1+2a) and heritage processing from GitNexus

## Deliverables

### New Files

| File | Purpose |
|------|---------|
| `packages/nexus/src/pipeline/heritage-processor.ts` | Heritage processing: EXTENDS/IMPLEMENTS edge emission + HeritageMap builder |
| `packages/nexus/src/pipeline/call-processor.ts` | Call resolution (Tier 1+2a+3) + HAS_METHOD/HAS_PROPERTY edges |
| `packages/nexus/src/__tests__/call-resolution.test.ts` | 20 tests covering all new functionality |

### Modified Files

| File | Change |
|------|--------|
| `packages/nexus/src/pipeline/extractors/typescript-extractor.ts` | Added `extractCalls()` + `ExtractedCall` type; updated `TypeScriptExtractionResult` to include `calls` |
| `packages/nexus/src/pipeline/parse-loop.ts` | Changed return type from `void` to `ParseLoopResult`; accumulates and returns `allHeritage` + `allCalls` |
| `packages/nexus/src/pipeline/index.ts` | Wired Phase 3c (heritage) + Phase 3e (call resolution); updated `PipelineResult` with counters; fixed `./pipeline` subpath export |
| `packages/nexus/package.json` | Added `./pipeline` export entry to resolve pre-existing nexus test failure |

## Architecture

### Heritage Processing (`heritage-processor.ts`)

- `processHeritage(heritage, graph, ctx)` — emits EXTENDS and IMPLEMENTS graph edges
  - Resolves child type via `ctx.symbols.lookupExact` (same-file, must exist)
  - Resolves parent type via `ctx.resolve()` (full tiered lookup, stubs unresolvable externals)
  - Confidence = geometric mean of child (0.95) × parent confidence
  - Self-references skipped; unresolvable children skipped
- `buildHeritageMap(heritage, ctx)` — builds two indexes:
  - `directParents: Map<childNodeId, Set<parentNodeId>>`
  - `implementorFiles: Map<interfaceName, Set<filePath>>`
  - `getAncestors()` — BFS, cycle-safe, bounded to 32 levels

### Call Expression Extraction (`typescript-extractor.ts`)

New `extractCalls(root, filePath)` function extracts:
- `call_expression` with `identifier` callee → `free` calls (`foo()`)
- `call_expression` with `member_expression` callee → `member` calls (`obj.foo()`)
- `new_expression` → `constructor` calls (`new Foo()`)

`buildSourceId()` walks up AST to find enclosing function/method for edge source ID.

### Call Resolution (`call-processor.ts`)

`resolveSingleCall()` implements three tiers:
- **Tier 1** (same-file, confidence 0.95): `symbolTable.lookupExact(filePath, name)`
- **Tier 2a** (named-import, confidence 0.90): `namedImportMap.get(filePath).get(name)` → `symbolTable.lookupExact(sourcePath, exportedName)`
- **Tier 3** (global fallback, confidence 0.50): `symbolTable.lookupCallableByName(name)`, only when exactly one candidate (ambiguous multi-candidate matches skipped)

Arity filter applied in Tier 3 to reduce false edges.

`emitClassMemberEdges(graph)` emits:
- `has_method` edges (class → method/constructor nodes)
- `has_property` edges (class → property nodes)

### Pipeline Integration

Phase ordering in `runPipeline`:
1. Parse loop → registers symbols + populates namedImportMap
2. Phase 3c: `processHeritage()` → EXTENDS/IMPLEMENTS edges
3. Phase 3c: `buildHeritageMap()` → in-memory inheritance index
4. Phase 3e: `resolveCalls()` → CALLS + HAS_METHOD + HAS_PROPERTY edges

The `ResolutionContext` is created once and its `.symbols` (SymbolTable) and `.namedImportMap` are passed into the parse loop — no data copying needed.

## Test Results

```
Test Files: 392 passed | 1 skipped (393 total)
Tests:      7074 passed | 15 skipped | 32 todo (7121 total)
New tests:  20 (call-resolution.test.ts)
```

## Edge Counts (from unit tests, not a live repo run)

Unit tests verify:
- EXTENDS edges created at correct confidence (≥0.5)
- IMPLEMENTS edges with correct source/target
- Stub IDs (`__heritage__<name>`) for unresolvable parents
- CALLS edges at Tier 1 (0.95), Tier 2a (0.90), Tier 3 (0.50)
- Ambiguous Tier 3 (multiple candidates) → no edge emitted
- HAS_METHOD / HAS_PROPERTY edges at confidence 0.99

## Acceptance Criteria Verification

| Criterion | Status |
|-----------|--------|
| CALLS edges for same-file calls (Tier 1, confidence 0.95) | PASS |
| CALLS edges for named-import calls (Tier 2a, confidence 0.90) | PASS |
| Heritage processing creates EXTENDS and IMPLEMENTS edges | PASS |
| HeritageMap built from all parsed files | PASS |
| Call resolution deferred until all files parsed | PASS (deferred Phase 3e) |
| HAS_METHOD and HAS_PROPERTY edges for class members | PASS |
| `pnpm run build` passes | PASS |
| `pnpm run test` passes | PASS (392/393 files pass, 1 pre-existing skip) |

## What Was Skipped (Per Task Spec)

- Virtual dispatch / MRO resolution (future wave)
- Tier 2b (package-scoped) resolution
- Non-TypeScript languages
