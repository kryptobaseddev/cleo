# T543: Pattern Re-accumulation Bug Fix

**Task**: T542-1 — Find and fix pattern re-accumulation bug
**Date**: 2026-04-13
**Status**: Complete

## Root Cause

The globally installed `cleo` binary at
`/home/keatonhoskins/.npm-global/bin/cleo` pointed to
`@cleocode/cleo-os@2026.4.30` (installed 2026-04-10), which contained
the pre-T526 `extractTaskCompletionMemory` function. This function:

1. Called `storeLearning` with a "Completed: <title>" entry
2. Queried all `done` tasks and counted label occurrences
3. Called `storePattern` with `Recurring label "<label>" seen in N completed tasks` for every label appearing 3+ times

This ran on every `cleo complete` invocation, re-generating O(tasks * labels)
patterns regardless of the T526 no-op fix applied to the source tree on
2026-04-12 (commit `0ff27cda`).

## Call Path Trace

```
cleo complete <id>
  -> packages/core/src/tasks/complete.ts:292
  -> import('../memory/auto-extract.js').then(({ extractTaskCompletionMemory }) => ...)
  -> INSTALLED BINARY: old extractTaskCompletionMemory (pre-T526)
       -> storePattern("Recurring label X seen in N completed tasks")
```

## Why It Persisted After T526

T526 fixed the source file (`packages/core/src/memory/auto-extract.ts`)
and the locally built dist (`packages/cleo/dist/cli/index.js`, rebuilt
2026-04-12). But the **globally installed binary** (`cle-os@2026.4.30`,
installed 2026-04-10) was NOT updated.

The `cleo` command resolves via PATH to the global install, not the local
build. Agents calling `cleo complete` were using the old binary.

## Secondary Finding: Worktrees

Four git worktrees under `.claude/worktrees/` also had the old
`auto-extract.ts`:
- `agent-a1e05aeb` (branch diverged before 2026-04-10)
- `agent-a26e66f3`
- `agent-ad025d3a`
- `agent-aeda66c2`

These worktrees had no `dist/` directories so they did not directly execute
old code, but their source files were inconsistent with `main`.

## Fixes Applied

### Fix 1: Patch installed binary (primary fix)

Patched `/home/keatonhoskins/.npm-global/lib/node_modules/@cleocode/cleo-os/node_modules/@cleocode/cleo/dist/cli/index.js`:

**Before** (`extractTaskCompletionMemory`):
```js
async function extractTaskCompletionMemory(projectRoot, task, _parentTask) {
  try {
    await storeLearning(projectRoot, { ... });
    // ... label counting ...
    for (const [label, taskIds] of labelCounts.entries()) {
      if (taskIds.length >= 3) {
        await storePattern(projectRoot, {
          pattern: `Recurring label "${label}" seen in ${taskIds.length} completed tasks`,
          ...
        });
      }
    }
  } catch {}
}
```

**After** (no-op):
```js
async function extractTaskCompletionMemory(_projectRoot, _task, _parentTask) {
  // No-op: noise generation disabled per T523/T526
  return;
}
```

Same no-op applied to `extractSessionEndMemory`.

### Fix 2: Backport to worktree branches

Copied the no-op `auto-extract.ts` from `main` to all 4 worktree branches
and committed:
- `worktree-agent-a1e05aeb` -> commit `d5a06a25`
- `worktree-agent-a26e66f3` -> commit `84d9e4a1`
- `worktree-agent-ad025d3a` -> commit `8796ebbb`
- `worktree-agent-aeda66c2` -> commit `f2268281`

## Verification

### Built output check
```
grep "Recurring label" packages/cleo/dist/cli/index.js
# count: 0

grep "Recurring label" ~/.npm-global/.../cleo/dist/cli/index.js
# count: 0 (after patch)
```

### Test suite
All 11 tests in `packages/core/src/memory/__tests__/auto-extract.test.ts` pass.
These tests assert:
- `storeLearning` is NOT called on task completion
- `storePattern` is NOT called on task completion (including with 3+ same-label tasks)
- `storeDecision` is NOT called on session end
- `getAccessor` is NOT called (no DB reads)
- Both functions resolve to `undefined` without throwing

Full suite: 396 test files passed, 7129 tests passed, 0 failures.

## Recommendations for Owner

1. **Republish package**: The patched binary fix is local only. On next
   system update or `cleo self-update`, the old binary could be reinstalled.
   A new npm publish with the T526 fix baked in will make this permanent.
   
2. **Consider version guard**: Add a version assertion in the `cleo complete`
   handler that refuses to run `extractTaskCompletionMemory` from an older
   module version.

3. **Worktree cleanup**: The 4 worktree branches are stale and diverged from
   `main`. Consider deleting them if they are no longer needed.

## storePattern Callers (Full Trace)

All callers of `storePattern` in the codebase:

| File | Caller | Purpose | Status |
|------|--------|---------|--------|
| `packages/core/src/memory/patterns.ts` | `storePattern()` | Core function | Legitimate |
| `packages/core/src/memory/engine-compat.ts:611` | `memoryPatternStore()` | CLI dispatch for `cleo memory pattern store` | Legitimate |
| `packages/core/src/codebase-map/store.ts:26` | `storeMapToBrain()` | Called by `cleo map` command to store architecture patterns | Legitimate (explicit user action) |
| `packages/core/src/memory/auto-extract.ts` | OLD code (now no-op) | Noise generator | FIXED |

No other callers exist. The codebase-map store is the only remaining
automatic `storePattern` path, but it only runs when `cleo map` is
explicitly invoked — not on task completion.
