# T633 Phase 0: vi.mock Pollution Fix

**Date**: 2026-04-15
**Task**: T633 (CI regression — nexus-e2e shard isolation)
**Manifest ID**: phase0-vi-mock-fix
**Status**: complete

## Summary

Fixed 20 test files that used incomplete synchronous `vi.mock(paths.js)` factories,
replacing them with the canonical async `vi.importActual` pattern to prevent module
cache poisoning across vitest shards.

## Root Cause

When a test file does:
```typescript
vi.mock('../../../../../core/src/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));
```

The entire `paths.js` module is replaced with a stub containing only `getProjectRoot`.
All other exports (`getCleoHome`, `getNexusDbPath`, `getCleoDirAbsolute`, etc.) return
`undefined`. When vitest shards share module caches, nexus tests that rely on those
exports receive `undefined`, causing 140+ failures.

## Fix Applied

Canonical pattern applied to all 20 files:
```typescript
vi.mock('../../../../../core/src/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../core/src/paths.js')>(
    '../../../../../core/src/paths.js',
  );
  return {
    ...actual,
    getProjectRoot: vi.fn(() => '/mock/project'),
  };
});
```

## Files Fixed (20)

### packages/cleo/src/dispatch/domains/__tests__/
1. fixed: admin.test.ts
2. fixed: alias-detection.test.ts
3. fixed: check.test.ts
4. fixed: check-ops.test.ts
5. fixed: memory-brain.test.ts
6. fixed: memory-legacy-rejection.test.ts
7. fixed: orchestrate.test.ts
8. fixed: orchestrate-handoff.test.ts
9. fixed: pipeline-manifest.test.ts
10. fixed: registry-parity.test.ts
11. fixed: sticky-list.test.ts
12. fixed: tasks.test.ts

### packages/cleo/src/cli/__tests__/
13. fixed: import-tasks.test.ts (mocks getTodoPath, getBackupDir)
14. fixed: web.test.ts (mocks getCleoHome)

### packages/core/src/__tests__/
15. fixed: injection-shared.test.ts (mocks getCleoHome)
16. fixed: schema-management.test.ts (mocks getCleoSchemasDir)

### Other
17. fixed: packages/core/src/skills/orchestrator/__tests__/spawn-tier.test.ts (mocks getProjectRoot + getTaskPath + getAgentOutputsDir)
18. fixed: packages/core/src/store/__tests__/git-checkpoint.test.ts (mocks getCleoDir + getConfigPath)
19. fixed: packages/core/src/store/__tests__/global-salt.test.ts (mocks getCleoHome via factory)
20. fixed: packages/core/src/store/__tests__/import-logging.test.ts (mocks getLogPath via ../../core/paths.js)

## Quality Gates

- biome check --write: PASSED (all 20 files formatted)
- pnpm run build: PASSED (Build complete)
- Shard 1: 3432 passed | 4 skipped / 210 test files PASSED
- Shard 2: 4135 passed | 6 skipped | 32 todo / 209 test files PASSED, 1 FAILED

## Shard 2 Failure Note

One pre-existing failure in shard 2:
- `packages/studio/src/lib/server/living-brain/__tests__/created-at-projection.test.ts`
- This file is NOT in the 20-file fix list
- It is an uncommitted file (not in HEAD) from a different task
- It was failing BEFORE this fix (pre-existing regression from another task)
- This fix does NOT introduce or worsen this failure
