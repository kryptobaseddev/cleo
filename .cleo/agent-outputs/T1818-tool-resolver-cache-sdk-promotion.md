# T1818 — ToolResolver + ToolCache SDK Tool Promotion

**Status**: complete  
**Commit**: e4e4611b727de37fa616fbad06d58691e3555759  
**Merged**: 51e1a3173 (Merge T1818 into main)

## Changes Made

### `packages/core/src/validation/validate-ops.ts`
- Updated import of `resolveToolCommand` from `../tasks/tool-resolver.js` to `../tools/sdk/tool-resolver.js`
- One-line change; the SDK re-export stubs were already complete from T1815

### `packages/core/src/tools/sdk/tool-resolver.ts` (pre-existing, no change)
- Already re-exports `CanonicalTool`, `ResolutionSource`, `ResolvedToolCommand`, `ResolveToolResult`, `CANONICAL_TOOLS`, `resolveToolCommand` from `../../tasks/tool-resolver.js`

### `packages/core/src/tools/sdk/tool-cache.ts` (pre-existing, no change)
- Already re-exports `RunToolOptions`, `ToolCacheEntry`, `ToolRunResult`, `runToolCached`, `AcquireSlotOptions`, `ReleaseSlotFn`, `acquireGlobalSlot` from `../../tasks/tool-cache.js` + `../../tasks/tool-semaphore.js`

## Acceptance Criteria Status

| Criterion | Status |
|-----------|--------|
| tool-resolver.ts re-exports resolveToolCommand CANONICAL_TOOLS | PASS (T1815 filled stub) |
| tool-cache.ts re-exports runToolCached | PASS (T1815 filled stub) |
| validate-ops.ts imports from tools/sdk/ path | PASS (this task) |
| 35 tool-resolver + tool-cache tests pass | PASS |
| biome check clean | PASS |

## Gates

- implemented: commit:e4e4611b7 + 3 files
- testsPassed: test-run 35 passed / 0 failed
- qaPassed: lint exit 0, typecheck exit 0
- documented: files:packages/core/src/tools/sdk/tool-resolver.ts
- securityPassed: re-export only, no new network surface
- cleanupDone: additive re-export, no removals
