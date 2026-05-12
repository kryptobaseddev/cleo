# T9075 — W5: Delete cleo bug command entirely

**Status**: complete  
**Branch**: task/T9075  
**Commits**: 1e9a75700, 531574442, 09eb2a8d9

## Summary

The `cleo bug` top-level command has been completely deleted. No shim, no tombstone, no alias. -242 LOC removed from `packages/cleo/src/cli/commands/bug.ts`.

## Changes Made

| File | Change |
|------|--------|
| `packages/cleo/src/cli/commands/bug.ts` | **Deleted** — entire 242-LOC file removed |
| `packages/cleo/src/cli/generated/command-manifest.ts` | Regenerated via `gen:manifest` — 119 → 118 entries; `bugCommand` entry removed |
| `packages/cleo/src/cli/help-renderer.ts` | Removed `'bug'` from `COMMAND_GROUPS` Task Management array |
| `packages/cleo/src/cli/__tests__/startup-migration.test.ts` | Removed `vi.mock('../commands/bug.js', ...)` line |
| `packages/cleo/README.md` | Removed `| cleo bug | Bug tracking |` row from command table |

## Acceptance Criteria Verification

1. `packages/cleo/src/cli/commands/bug.ts` does NOT exist — **PASS**
2. `cleo bug` not in `command-manifest.ts` CLI surface — **PASS** (0 entries for 'bug' command)
3. `help-renderer.ts` COMMAND_GROUPS has no `'bug'` entry — **PASS**
4. `startup-migration.test.ts` mock for `bug.js` removed — **PASS**
5. `bug-severity.jsonl` legacy path no longer referenced (T9071 migrated; bug.ts deleted) — **PASS**
6. Biome CI clean — **PASS** (321 files checked, no errors)

## Note on build/typecheck

Build and typecheck failures are pre-existing in the worktree (missing `node_modules`, tsconfig.json TS version mismatch, `@cleocode/core/internal` missing). Confirmed pre-existing via `git stash` test. These are not introduced by this task.

## Users Must Now Use

```bash
cleo add --kind bug --severity P1 --acceptance "AC1|AC2|AC3"
```
