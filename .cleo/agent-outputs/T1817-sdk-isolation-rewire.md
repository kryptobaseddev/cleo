# T1817: Promote WorktreeIsolation to SDK Tool

## Summary

Wired the SDK re-export for `WorktreeIsolation` and updated callers to use the new canonical import path.

## Changes

### `packages/core/src/tools/sdk/isolation.ts`
- Changed from re-exporting directly from `@cleocode/contracts` to re-exporting from `../../worktree/isolation.ts` (chained re-export per acceptance criterion)
- Updated TSDoc to reference T1817 and clarify the chain

### `packages/core/src/orchestrate/spawn-ops.ts`
- Updated import: `'../worktree/isolation.js'` → `'../tools/sdk/isolation.js'`

### `packages/core/src/orchestration/spawn-prompt.ts`
- Updated import: `'../worktree/isolation.js'` → `'../tools/sdk/isolation.js'`

## Evidence

- Commit: `39eca800d12c7a031c03cabd1a7847fb1c29cd82` on `task/T1817`
- Tests: 31 isolation tests passed (0 failed)
- Lint: biome check clean (8 files, no fixes)
- Typecheck: zero new isolation errors introduced

## Key Finding

The path `'../worktree/isolation.js'` from `tools/sdk/isolation.ts` would incorrectly resolve to `tools/worktree/isolation.js` (non-existent). Correct path is `'../../worktree/isolation.js'` — two hops up from `src/tools/sdk/` to `src/`.

## Status

Complete. T1821, T1822, T1823 unblocked.
