# T5586 — clean_working_tree Gate Fix Output

**Date**: 2026-03-07
**Task**: T5586
**Agent**: Claude Sonnet 4.6

---

## Summary

Fixed two bugs in the `clean_working_tree` release gate:
1. Dry-run mode now bypasses the gate entirely (untracked files cannot block a read-only preview).
2. Untracked files (`??` lines from `git status --porcelain`) are excluded from the dirty check in real-ship mode.

Also applied the same `??` exclusion to `pushRelease()`'s `requireCleanTree` policy check.

---

## Changes Made

### File: `/mnt/projects/claude-todo/src/core/release/release-manifest.ts`

#### Change 1 — `runReleaseGates()` signature (line 546)

Added optional `opts?: { dryRun?: boolean }` parameter:

```ts
// Before
export async function runReleaseGates(
  version: string,
  loadTasksFn: () => Promise<ReleaseTaskRecord[]>,
  cwd?: string,
): Promise<{...}>

// After
export async function runReleaseGates(
  version: string,
  loadTasksFn: () => Promise<ReleaseTaskRecord[]>,
  cwd?: string,
  opts?: { dryRun?: boolean },
): Promise<{...}>
```

#### Change 2 — `clean_working_tree` gate (lines ~624-655)

- When `opts?.dryRun` is true: gate is immediately pushed as `passed` with message `"Skipped in dry-run mode"`.
- When in real-ship mode: `??` lines (untracked files) are filtered out before the dirty check.

Key filter added:
```ts
.filter(l => !l.startsWith('?? '))
```

#### Change 3 — `pushRelease()` `requireCleanTree` check (lines ~895-910)

The existing `statusOutput.trim().length > 0` check was replaced with a filtered version that excludes `??` lines:

```ts
const trackedDirty = statusOutput
  .split('\n')
  .filter(l => l.trim() && !l.startsWith('?? '))
  .join('\n');
if (trackedDirty.trim().length > 0) {
  throw new Error('Git working tree is not clean...');
}
```

### File: `/mnt/projects/claude-todo/src/dispatch/engines/release-engine.ts`

#### Change 4 — `releaseShip()` wires `dryRun` to `runReleaseGates()` (line ~374)

```ts
// Before
const gatesResult = await runReleaseGates(
  version,
  () => loadTasks(projectRoot),
  projectRoot,
);

// After
const gatesResult = await runReleaseGates(
  version,
  () => loadTasks(projectRoot),
  projectRoot,
  { dryRun },
);
```

---

## Behavior After Fix

| Scenario | Before | After |
|----------|--------|-------|
| `--dry-run` with untracked files (e.g. `.cleo/agent-outputs/`) | Gate FAILS — blocks dry-run | Gate PASSES — skipped in dry-run mode |
| Real ship with only untracked files | Gate FAILS incorrectly | Gate PASSES — `??` lines excluded |
| Real ship with actual staged/modified files | Gate FAILS correctly | Gate FAILS correctly (unchanged behavior) |
| Real ship with CHANGELOG.md/VERSION/package.json dirty | Gate PASSES (allowed list) | Gate PASSES (unchanged behavior) |

---

## TypeScript Compiler Result

```
npx tsc --noEmit
```

Exit code: **0** — no errors.

---

## Test Results

### Release module tests (isolated):

```
npx vitest run src/core/release --reporter=dot
Test Files: 4 passed (4)
Tests:      28 passed (28)
```

### Release-ship engine tests (isolated):

```
npx vitest run src/dispatch/engines/__tests__/release-ship.test.ts
Test Files: 1 passed (1)
Tests:      4 passed (4)
```

Key test output confirmed:
- `dryRun returns what-would-happen without executing git ops` — PASSED
  - Gate step shows `✓ Validate release gates` (dry-run correctly bypasses clean_working_tree)
- `gate failure returns error with gate details` — PASSED

### Full suite:

```
npx vitest run --reporter=dot
Test Files: 6 failed | 270 passed (276)
Tests:      15 failed | 4235 passed | 77 skipped (4327)
```

The 6 failing test files all fail with `disk I/O error` (SQLite WAL exclusive lock conflict) — this is a pre-existing parallel execution issue unrelated to these changes. The `release-ship.test.ts` file is among the affected files in the full suite run, but passes cleanly when run in isolation (all 4 tests pass).

---

## Root Cause Summary (from audit)

- `git status --porcelain` outputs `?? .cleo/agent-outputs/` for untracked directories.
- The gate's filter (`f !== 'CHANGELOG.md' && ...`) only checked filenames, not the git status prefix.
- Untracked files' paths were extracted with `l.slice(3).trim()` and compared against the allowed list — `.cleo/agent-outputs/` was not in that list, so it counted as dirty.
- Additionally, `runReleaseGates()` ran unconditionally before the `if (dryRun)` branch in `releaseShip()`, meaning dry-run mode still triggered the gate.
