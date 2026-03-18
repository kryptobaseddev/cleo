# T5723: Fix 2 Validation Issues

**Task**: T5723
**Epic**: T5701
**Date**: 2026-03-17
**Status**: complete

---

## Summary

Fixed two validation issues blocking the PR merge: (1) updated `core-parity.test.ts` import graph assertions to expect `@cleocode/core` instead of the old relative `../../core/` paths, and (2) fixed the `build.mjs` main bundle plugin to resolve `@cleocode/core` to `src/core/index.ts` (not `packages/core/src/index.ts`) which was causing 483 esbuild "no matching export" errors.

## Content

### Fix 1: core-parity.test.ts import graph assertions

**File**: `src/core/__tests__/core-parity.test.ts`

**Problem**: The Import Graph Verification tests checked that dispatch engine files contained import strings like `from '../../core/tasks/add.js'`. Since T5718 rewired all engines to use `from '@cleocode/core'`, these 6 assertions failed.

**Fix**: Updated all 6 per-engine import graph tests to:
- Check for `from '@cleocode/core'` instead of `from '../../core/...'`
- Verify key exported function names are present in the file content
- Updated the loop body `for (const file of ENGINE_FILES)` to also check `@cleocode/core` (loop body is never executed since `ENGINE_FILES` is empty, but kept consistent)

**Result**: 6 import-graph failures eliminated. The remaining 9 failures in the file are pre-existing runtime failures in Session/Lifecycle sections that were failing before T5718 (confirmed by git stash comparison: 15 failed before → 9 failed after these fixes).

### Fix 2: build.mjs main bundle resolver for @cleocode/core

**File**: `build.mjs`

**Problem**: The `buildOptions` (main CLI+MCP bundle) plugin mapped `@cleocode/core` to `packages/core/src/index.ts`. That file does `export * from '../../../src/core/index.js'` — but esbuild's named import validation cannot follow `export *` re-exports across that chain. When engines imported `{ checkGate } from '@cleocode/core'`, esbuild reported 483 errors: "No matching export in packages/core/src/index.ts for import checkGate".

**Fix**: Changed the `adapterMap` in `buildOptions` to map `@cleocode/core` to `src/core/index.ts` (the direct barrel that explicitly exports `checkGate`, `addTask`, etc.).

The `corePackageBuildOptions` (standalone `@cleocode/core` package bundle) correctly stays at `packages/core/src/index.ts` as its entry point — this bundle uses esbuild's own bundling to inline everything, so named import validation is not an issue there.

**Before**:
```js
'@cleocode/core': resolve(__dirname, 'packages/core/src/index.ts'),
```

**After**:
```js
// T5723: main bundle uses src/core/index.ts directly (avoids export* resolution issues)
// packages/core/src/index.ts is only used for the corePackageBuildOptions standalone bundle
'@cleocode/core': resolve(__dirname, 'src/core/index.ts'),
```

## Verification Results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | 0 errors (exit 0) |
| `npm run build` | "Build complete." (exit 0) |
| `npx vitest run tests/e2e/core-package-smoke.test.ts` | 10/10 passed |
| `npx vitest run src/core/__tests__/core-parity.test.ts` | 17/26 passed (9 pre-existing runtime failures, 0 import-graph failures) |

### Pre-existing failures note

The 9 remaining failures in `core-parity.test.ts` are in the "Session Engine Delegation" and "Lifecycle Engine Parity" describe blocks. They test runtime behavior of `sessionStart`, `taskStart`, `lifecycleStatus` etc. These failures existed on HEAD before any T5723 changes (confirmed: 15 failed before → 9 after, net -6 import-graph fixes). They are caused by `sessionStart` using `accessor.loadTaskFile().tasks.find()` while SQLite is the canonical store and the test's `createTestProject` seeds only SQLite. These are pre-existing bugs outside T5723 scope.

## References

- Related tasks: T5701, T5716, T5718
- Modified files:
  - `src/core/__tests__/core-parity.test.ts`
  - `build.mjs`
