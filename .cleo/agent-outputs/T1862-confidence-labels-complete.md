# T1862: Three-State Confidence Labels on Graph Edges

**Task**: T1862 — Add confidence labels (EXTRACTED|INFERRED|AMBIGUOUS) to all extracted edges
**Status**: Complete
**Branch**: task/T1862
**Commit**: 5e43659d697f2703a7fa03ffbcec43572babe8d3

## Summary

Added `GraphEdgeConfidenceLabel` type (`'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'`) to
`packages/contracts/src/graph.ts` and annotated all edge-emitting sites across the
code intelligence pipeline.

## Design Decision: Additive Field

Added `confidenceLabel?: GraphEdgeConfidenceLabel` as an optional field on `GraphRelation`
rather than replacing the numeric `confidence` field. Rationale:
- Existing consumers of the numeric field are unaffected (backward compatible)
- The label is always derivable from `confidence` via `confidenceLabelFromNumeric()`
- Owner expressed preference for LOC reduction: if a follow-up migration is desired,
  `confidence: number` can be deprecated and replaced — noted in manifest as follow-up

## Changes

### packages/contracts/src/graph.ts
- New `GraphEdgeConfidenceLabel` type: `'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'`
- New `confidenceLabelFromNumeric(confidence: number)` utility function
- Thresholds: ≥0.90 = EXTRACTED, 0.80–0.89 = INFERRED, <0.80 = AMBIGUOUS
- New optional `confidenceLabel?` field on `GraphRelation` interface
- Full TSDoc on all new exports

### packages/contracts/src/index.ts
- Export `GraphEdgeConfidenceLabel` type
- Export `confidenceLabelFromNumeric` function

### packages/nexus/src/pipeline/parse-loop.ts
- Import `confidenceLabelFromNumeric` from contracts
- `emitDefinesEdges`: annotates `defines` edges (confidence 1.0 → EXTRACTED)

### packages/nexus/src/pipeline/call-processor.ts
- `has_method`, `has_property` edges (0.99 → EXTRACTED)
- `calls` edges (tier-based: same-file 0.95 → EXTRACTED, import-scoped 0.90 → EXTRACTED,
  global 0.50 → AMBIGUOUS)

### packages/nexus/src/pipeline/heritage-processor.ts
- `extends`, `implements` edges (geometric-mean 0.80–0.95 → INFERRED or EXTRACTED)

### packages/nexus/src/pipeline/import-processor.ts
- `imports` edges (1.0 → EXTRACTED, both direct and external module variants)

### packages/nexus/src/pipeline/structure-processor.ts
- `contains` edges (1.0 → EXTRACTED)

### packages/nexus/src/pipeline/community-processor.ts
- `member_of` edges (1.0 → EXTRACTED)

### packages/nexus/src/pipeline/process-processor.ts
- `step_in_process` edges (1.0 → EXTRACTED)
- `entry_point_of` edges (1.0 → EXTRACTED)

### packages/nexus/src/pipeline/processors/access-processor.ts
- `accesses` edges (0.80 → INFERRED, global 0.50 → AMBIGUOUS)

### packages/nexus/src/intelligence/providers/typescript.ts
- `imports` edges (0.90 → EXTRACTED)
- `calls` edges (0.90 → EXTRACTED)
- `calls` (new expression) edges (0.85 → INFERRED)

### packages/nexus/src/__tests__/extractor-regression.test.ts
- New describe block: 'Confidence label regression — parse-loop edges (T1862)'
- Test: >70% EXTRACTED edges on TypeScript fixture
- Test: all defines edges carry `confidenceLabel === 'EXTRACTED'`
- Test: all edges have a `confidenceLabel` (labelling coverage gate)

## Test Results

- `pnpm --filter @cleocode/nexus run test`: 160 tests pass (7 test files)
- `pnpm --filter @cleocode/contracts run test`: 148 tests pass (5 test files)
- `pnpm run typecheck`: clean (0 errors)
- `pnpm biome check packages/nexus/ packages/contracts/`: 5 warnings (pre-existing), 0 errors

## Follow-up Proposal

If owner wants LOC reduction (fewer dual-semantics): deprecate `confidence: number` and
replace with `confidenceLabel: GraphEdgeConfidenceLabel` + keep numeric only in DB row.
This is a separate migration task due to impact on `knowledge-graph.ts` flush path and
any external consumers. Suggest filing as T1862-followup.
