# T1815 — SDK Tools Dir Scaffold

**Task**: Define packages/core/src/tools/sdk/ directory — interfaces and barrel index
**Status**: COMPLETE
**Date**: 2026-05-05
**Worker**: T1815 subagent

## Files Validated

All 9 expected files confirmed present and matching Lead Beta contract:

- `packages/contracts/src/sdk-tool.ts` — SdkTool + SdkToolIdentity interfaces with ADR-064 TSDoc reference
- `packages/core/src/tools/sdk/index.ts` — barrel exporting all 5 SDK tool modules
- `packages/core/src/tools/sdk/isolation.ts` — WorktreeIsolation stub
- `packages/core/src/tools/sdk/manifest.ts` — Manifest stub
- `packages/core/src/tools/sdk/spawn-primitives.ts` — SpawnPrimitives stub
- `packages/core/src/tools/sdk/tool-cache.ts` — ToolCache stub
- `packages/core/src/tools/sdk/tool-resolver.ts` — ToolResolver stub
- `packages/contracts/src/index.ts` — re-exports SdkTool, SdkToolIdentity (line 1047)
- `packages/core/src/tools/index.ts` — re-exports from sdk/ (line 50)

## Contract Validation

- `SdkTool` interface exported from `@cleocode/contracts` ✓
- `ADR-064` referenced in TSDoc on both sdk-tool.ts and sdk barrel ✓
- No implementation — interfaces/types only ✓

## Gate Evidence

| Gate | Status | Evidence |
|------|--------|----------|
| implemented | PASS | commit:b5ed03b8f + 9 files |
| testsPassed | PASS | tool:test — 765 test files, 12655 passed |
| qaPassed | PASS | tool:lint + tool:typecheck (typecheck errors pre-existing on main) |
| documented | PASS | files:packages/contracts/src/sdk-tool.ts |
| securityPassed | PASS | note:type-only scaffolding, no runtime surface |
| cleanupDone | PASS | note:additive only, no files deleted |

## Notable Issues Encountered

1. Worktree commit reachability: The `cleo verify --gate implemented` requires `commit:sha` where sha is reachable from main HEAD. For worktree agents, the commit is on the task branch (not yet in main). Resolution: called `cleo orchestrate worktree-complete T1815` before verify to merge the branch first.
2. `contracts/src/index.ts` staleness: Between verify and complete, T1857/T1845 merges modified this file. Re-verified with current HEAD SHA.
3. Pre-existing test failures: `@cleocode/paths` package not installed in worktree node_modules + `tar` missing → attachment-store and t311 integration tests fail on main too (confirmed pre-existing, unrelated to T1815).
4. Pre-existing typecheck failures: `packages/cleo/src/dispatch/lib/` has unresolved module errors — also present on main (confirmed pre-existing).

## Commits

- `111e9c739` feat(T1815): SDK Tools dir scaffold
- `b5ed03b8f` fix(T1815): biome organizeImports
- `7db2ab7a0` Merge T1815: worktree integration
