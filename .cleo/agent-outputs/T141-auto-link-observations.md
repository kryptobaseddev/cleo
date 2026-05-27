# T141: Auto-link observations to current session/task

**Epic**: T134 (Brain Memory Automation)
**Status**: complete
**Date**: 2026-03-23

## What was implemented

Enhanced `observeBrain()` in `packages/core/src/memory/brain-retrieval.ts` to automatically
create `brain_memory_links` entries linking new observations to the currently focused task.

### Changes

**File**: `packages/core/src/memory/brain-retrieval.ts`

1. Added a fire-and-forget call to `autoLinkObservationToTask()` inside `observeBrain()`,
   guarded by `if (sourceSessionId)`. The call is wrapped in `.catch()` so linking failures
   never block the observation return.

2. Added private function `autoLinkObservationToTask()` that:
   - Dynamically imports `sessionStatus` from `../sessions/index.js` (avoids circular dep)
   - Calls `sessionStatus(projectRoot)` to get the active session
   - Returns early (no-op) if no session, or if `taskWork.taskId` is null
   - Calls `accessor.addLink()` with: `memoryType: 'observation'`, `memoryId: observationId`,
     `taskId`, `linkType: 'produced_by'`
   - All exceptions are swallowed — errors in the outer `.catch()` are silently ignored

### Graceful no-op conditions

- No `sourceSessionId` in params → skip entirely (most backward-compatible path)
- No active session found → return early
- Session has no focused task (`taskWork.taskId` is null) → return early
- `brain_memory_links` table doesn't exist (accessor throws) → caught by outer `.catch()`
- Any other error → caught by outer `.catch()`

## Quality gates

- `pnpm biome check --write` — no fixes applied, passes clean
- `pnpm run build` — esbuild bundle builds successfully. Pre-existing TS error in
  `memory-bridge-refresh.ts` (T138, untracked file) fails `tsc --emitDeclarationOnly`.
  No new TypeScript errors in `brain-retrieval.ts` (`tsc --noEmit` clean for that file).
- Tests — pre-existing 25 failures. Zero new failures introduced by this change.

## Provenance

@task T141
@epic T134
@why Enable context-aware bridge to find task-relevant memories automatically
@what Auto-link observations to current session's focused task via brain_memory_links
