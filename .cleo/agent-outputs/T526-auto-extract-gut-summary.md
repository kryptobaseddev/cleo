# T526 — Gut extractTaskCompletionMemory and extractSessionEndMemory

**Task**: T526  
**Epic**: T523 (BRAIN Integrity)  
**Date**: 2026-04-11  
**Status**: Complete

## What Was Done

### File: `packages/core/src/memory/auto-extract.ts`

Both noise-generating functions replaced with documented no-ops:

- `extractTaskCompletionMemory()` — all three write paths removed:
  - "Completed: \<title\>" learning on every task completion
  - "Task T### depended on T###" dependency chain learning
  - "Recurring label X seen in N completed tasks" pattern scan across last 50 done tasks (no dedup)

- `extractSessionEndMemory()` — all three write paths removed:
  - Process decision summarizing the session
  - Per-task "Completed:" learnings (duplicate of above)
  - "Session X completed N tasks with label Y" workflow patterns

Both functions now return immediately with a TSDoc comment referencing T523 CA1 and explaining the noise rationale (2,466 duplicate patterns, 327 duplicate learnings, 96.7% noise ratio).

The three unused imports (`storeDecision`, `storeLearning`, `storePattern`) were removed from the top-level imports. `resolveTaskDetails` and `extractFromTranscript` remain fully functional and unchanged.

### File: `packages/core/src/memory/__tests__/auto-extract.test.ts`

Updated all `extractTaskCompletionMemory` and `extractSessionEndMemory` tests to assert the no-op contract:
- Tests now assert `storeLearning`, `storePattern`, `storeDecision`, and `getAccessor` are NOT called
- `resolveTaskDetails` tests unchanged (function still active)
- Total: 11 tests, all passing

## Caller Verification

Two callers found, neither uses the return value:

| Caller | Pattern |
|--------|---------|
| `packages/core/src/tasks/complete.ts:293` | `.then(({ extractTaskCompletionMemory }) => extractTaskCompletionMemory(...))` |
| `packages/core/src/sessions/session-memory-bridge.ts:58-62` | `await extractSessionEndMemory(...)` |

Both are `Promise<void>` — no return value dependency. No caller changes needed.

## Quality Gates

| Gate | Result |
|------|--------|
| `pnpm biome check --write` | No fixes applied |
| `pnpm run build` | Build complete |
| `pnpm run test` | 7,011 passed, 15 skipped — 1 pre-existing failure in `session-hooks.test.ts` (T523 epic work from other agents, unrelated to T526) |
| Auto-extract test file | 11/11 tests pass |

## Impact

After this change, every call to `extractTaskCompletionMemory` or `extractSessionEndMemory` is a no-op. No new learnings, patterns, or decisions will be auto-generated on task completion or session end. Pattern detection moves to `cleo brain maintenance` (scheduled, dedup-aware).
