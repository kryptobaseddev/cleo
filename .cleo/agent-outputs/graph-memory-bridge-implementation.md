# Graph Memory Bridge Implementation

**Date**: 2026-04-14
**Status**: complete

## What Was Built

Implemented the graph memory bridge connecting brain.db memory nodes to nexus.db code intelligence nodes.

## Files Created

- `/mnt/projects/cleocode/packages/core/src/memory/graph-memory-bridge.ts` — Main bridge module with four public functions

## Files Modified

- `packages/core/src/store/brain-schema.ts` — Added `code_reference` to `BRAIN_EDGE_TYPES`
- `packages/core/src/memory/brain-lifecycle.ts` — Added Step 8 (autoLinkMemories) to `runConsolidation`, extended `RunConsolidationResult` with `codeLinksCreated`
- `packages/core/src/memory/engine-compat.ts` — Added 5 new EngineResult-wrapped functions: `memoryCodeLink`, `memoryCodeAutoLink`, `memoryCodeMemoriesForCode`, `memoryCodeForMemory`, `memoryCodeLinks`
- `packages/core/src/internal.ts` — Exported new functions and bridge types
- `packages/cleo/src/dispatch/engines/memory-engine.ts` — Re-exported new functions from @cleocode/core/internal
- `packages/cleo/src/dispatch/lib/engine.ts` — Re-exported from memory-engine
- `packages/cleo/src/dispatch/domains/memory.ts` — Wired 5 new operations into query/mutate handlers + getSupportedOperations()
- `packages/cleo/src/cli/commands/memory-brain.ts` — Added 4 new CLI subcommands

## Tests Created

- `packages/core/src/memory/__tests__/graph-memory-bridge.test.ts` — 14 tests covering all public functions

## Operations Added

### Query (tier 1)
- `memory.code.links` → `cleo memory code-links [--limit N]`
- `memory.code.memories-for-code` → `cleo memory code-memories-for-code <symbol>`
- `memory.code.for-memory` → `cleo memory code-for-memory <memoryId>`

### Mutate
- `memory.code.link` → create manual code_reference edge
- `memory.code.auto-link` → `cleo memory code-auto-link`

## Quality Gates

- `pnpm biome check --write` — passed (no errors)
- `pnpm run build` — passed
- New tests: 14/14 passed
- Memory test suite: 340/340 passed
- Dispatch domain test suite: 521/521 passed

## Design Decisions

- brain.db is read-write; nexus.db is read-only from this module
- Bridge edges stored in brain_page_edges (edgeType='code_reference')
- Entity matching: exact file path, exact symbol name, fuzzy case-insensitive (weight 0.6)
- Max 10 code_reference edges per brain node (noise control)
- Only brain nodes with qualityScore >= 0.3 are processed
- All operations are best-effort; never block or throw
- autoLinkMemories() called as Step 8 in runConsolidation() (sleep-time compute)
