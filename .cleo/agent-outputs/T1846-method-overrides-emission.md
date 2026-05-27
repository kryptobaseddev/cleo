# T1846 — METHOD_OVERRIDES Edge Emission

**Worker**: T1846  
**Date**: 2026-05-05  
**Status**: partial (implemented gate blocked by worktree reachability; orchestrator must merge task/T1846 and verify commit:3331f10e8e27ff81d7b56abab7c49fedbf6329e7)

---

## Summary

Implemented METHOD_OVERRIDES edge emission from `heritage-processor.ts` as specified.
Also fixed a pre-existing bug in `typescript-extractor.ts` where nested `class_heritage`
AST nodes were not traversed (grammar version dependent), causing zero heritage records
to be extracted from the TypeScript fixture.

---

## Changes

### packages/nexus/src/pipeline/heritage-processor.ts

- Imported `GraphNode` from `@cleocode/contracts`
- Added `methodOverridesCount: number` to `HeritageProcessingResult`
- Added `emitMethodOverrides()` internal function:
  - Filters to `extends` records only (implements = T1847 territory)
  - Builds a `classNodeId → Map<methodName, GraphNode>` index from graph.nodes (one pass, O(N))
  - For each (child class, parent class) pair, compares method name sets
  - Skips constructors (not overrides in the classical sense)
  - Skips stub parents (`__heritage__` prefix = external/unresolved types)
  - Emits `method_overrides` edge: childMethod → parentMethod
  - Confidence: geometric mean of child (0.95, same-file) and parent resolution tier
  - confidenceLabel: set via `confidenceLabelFromNumeric` (EXTRACTED when parent is resolved at same-file or import-scoped tier)
- `processHeritage()` now calls `emitMethodOverrides()` and returns `methodOverridesCount`

### packages/nexus/src/pipeline/extractors/typescript-extractor.ts

- Fixed `extractHeritage()` to flatten the nested `class_heritage` node structure
- tree-sitter TypeScript grammar (v0.23.x) wraps `extends_clause` and `implements_clause`
  inside a nested `class_heritage` node within the class's `class_heritage` child
- Fix: collect `class_heritage`'s grandchildren before iterating for clause types
- This brings TypeScript `heritage` count from 0 → 4 for the fixture

### packages/nexus/src/__tests__/fixtures/typescript/sample.ts

- Added `UserRepository.toJSON()` override method to guarantee >= 1 `method_overrides` edge
  when UserRepository extends BaseRepository (both have `toJSON`)

### packages/nexus/src/__tests__/extractor-regression.test.ts

- Updated `TS_SNAPSHOT`: total 30→31, method 11→12, heritage 0→4
- Added imports: `processHeritage`, `createResolutionContext`
- Added `METHOD_OVERRIDES edges regression (heritage-processor, T1846)` describe block:
  - Wires ResolutionContext through parse loop (same pattern as index.ts)
  - Asserts `graph.relations.filter(r => r.type === 'method_overrides').length >= 1`
  - Asserts `result.methodOverridesCount >= 1`
  - Asserts all method_overrides edges have `confidenceLabel` defined

### packages/nexus/src/pipeline/index.ts

- Updated Phase 3c log line to include `methodOverridesCount`

---

## Test Results

- All 163 nexus tests pass (7 test files)
- testsPassed gate: verified via test-run:/tmp/t1846-test-clean.json (163 passed, 0 failed)
- qaPassed gate: verified via tool:lint (biome, exit 0) + tool:typecheck (tsc, exit 0)

---

## Gate Status

| Gate | Status | Evidence |
|------|--------|----------|
| implemented | BLOCKED | commit:3331f10e8 on task/T1846 — not yet reachable from main HEAD; orchestrator must merge before verifying |
| testsPassed | VERIFIED | test-run:/tmp/t1846-test-clean.json (163/163 pass) |
| qaPassed | VERIFIED | tool:lint exit 0, tool:typecheck exit 0 |

---

## Coordination Note for T1847 (METHOD_IMPLEMENTS)

T1847 will also need to modify `heritage-processor.ts`. The `emitMethodOverrides` function
is defined within the file and handles `extends` records only. T1847 should add a parallel
`emitMethodImplements` function following the same pattern, filtering on `implements` records.
The `HeritageProcessingResult` will need a `methodImplementsCount` field added.

Key difference: for `implements`, the parent methods may be abstract/interface methods — 
the pattern should check `graph.nodes` for the parent interface's methods by `node.parent === parentClassId`.

---

## Worktree Information

- Branch: task/T1846
- Commit SHA: 3331f10e8e27ff81d7b56abab7c49fedbf6329e7
- Merge base with main: aa32838e2277a2a60bbb57bdf72bb93b68e9672b (before main advanced to 51e1a3173)
- Branch is rebased onto current main (51e1a3173) — only one new commit ahead
