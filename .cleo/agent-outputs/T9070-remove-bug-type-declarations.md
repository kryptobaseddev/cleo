# T9070 — W1: Remove 'bug' from 4 stale --type declarations

**Status**: complete
**Branch**: task/T9070
**Parent**: T9067
**Date**: 2026-05-08

## Summary

Eliminated help/validator drift: `bug` was advertised as a valid `--type` value in 4 declaration sites but the core validator rejects it. All 7 declaration sites now converge on `epic|task|subtask`.

## Changes

| File | Line | Change |
|------|------|--------|
| `packages/cleo/src/cli/commands/add.ts` | 63 | `'Task type (epic \| task \| subtask \| bug)'` → `'Task type (epic \| task \| subtask)'` |
| `packages/cleo/src/cli/commands/update.ts` | 53 | `'New type (task\|epic\|subtask\|bug)'` → `'New type (task\|epic\|subtask)'` |
| `packages/cleo/src/dispatch/registry.ts` | 1873 | `['epic', 'task', 'subtask', 'bug']` → `['epic', 'task', 'subtask']` |
| `packages/lafs/src/operation-gates.ts` | 110 | `['epic', 'task', 'subtask', 'bug']` → `['epic', 'task', 'subtask']` |

## Commits (task/T9070 branch)

- `e510c3a45` — fix(T9070): remove stale 'bug' from cleo add --type help
- `f9f0bb7f6` — fix(T9070): remove stale 'bug' from cleo update --type help
- `8f58e3281` — fix(T9070): remove stale 'bug' from dispatch registry type enum
- `6c4245300` — fix(T9070): remove stale 'bug' from LAFS operation-gates type enum

## Quality Gates

- **biome**: exit 0 on all 4 changed files
- **tests**: 413 passed, 0 failed (packages/cleo + packages/lafs)
- **build**: `pnpm --filter @cleocode/cleo --filter @cleocode/lafs run build` passes in main project

## Notes

- `--role bug` references in add.ts and update.ts are intentionally preserved — role is orthogonal to type (T944)
- Pre-existing biome format errors in `command-manifest.ts` (auto-generated) and `complete.test.ts` not introduced by this task
