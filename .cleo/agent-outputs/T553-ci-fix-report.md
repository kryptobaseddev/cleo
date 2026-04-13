# CI Fix Report — T553

**Date**: 2026-04-13
**Version**: v2026.4.33
**Status**: RESOLVED

## Failure Summary

The GitHub CI run `24348256072` failed on the `Lint & Format` step (`biome ci .`).

**Root cause**: Import ordering violation in `packages/core/src/memory/engine-compat.ts` (line 16). Biome requires imports to be sorted. The block at lines 22-32 had `storeDecision` from `./decisions.js` placed before `./brain-links.js` and `./brain-retrieval.js`, violating alphabetical ordering.

**Error message from CI**:
```
The imports and exports are not sorted.
packages/core/src/memory/engine-compat.ts:16:1 assist/source/organizeImports FIXABLE
Found 1 error.
```

## Fix Applied

File: `packages/core/src/memory/engine-compat.ts`

The import block was reordered by running `pnpm biome check --write packages/core/src/memory/engine-compat.ts`. The corrected order (alphabetical by module path within the relative-imports group):

```
./brain-links.js        (was: moved after decisions.js)
./brain-retrieval.js    (was: same position)
./decisions.js          (was: before brain-links.js — the violation)
./learnings.js
./mental-model-queue.js
./patterns.js
```

## Local Verification

All three CI gates passed locally:

| Gate | Result |
|------|--------|
| `pnpm biome ci packages` | No errors (15 warnings, all pre-existing) |
| `pnpm run build` | Build complete |
| `pnpm run test` | 396 files passed, 7130 tests passed, 0 failures |

**Note on local `biome ci .`**: Running biome against `.` locally picks up nested `biome.json` files inside `.claude/worktrees/` (untracked local worktrees). This causes a configuration conflict error locally but does NOT affect CI — CI runs on a clean checkout where those directories do not exist. The `packages` scope is sufficient for local validation.

## No Other Failures

The CI run `24348256072` shows only one failing step (`biome ci`). The `typecheck` and `unit-tests` jobs are gated on `biome` passing, so they were never triggered. No additional issues were found.

## Files Changed

- `packages/core/src/memory/engine-compat.ts` — import order fix only (no logic changes)
