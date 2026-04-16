# T754 — CI Biome Fix (main CI red after v2026.4.63)

**Date**: 2026-04-16
**Status**: complete
**Commit**: (see below)

## Problem

Main CI run 24485000916 failed at "Lint & Format / Run biome ci ." with 3 errors in 3 files after v2026.4.63 shipped. The close-out worker ran `biome check --write` but did not stage/commit the resulting fixes.

## Root Cause

A close-out worker for a prior task ran autofix but forgot to stage the diff before committing, so the CI-required file state was never committed to main.

## Files Fixed

### 1. `packages/adapters/src/providers/claude-sdk/__tests__/spawn.test.ts`
- **Error**: File content differs from formatting output (line 110-112)
- **Fix**: Biome reformatted a `.fn().mockImplementation(...)` chain from 3-line inline to 3-line method-chain style. Applied via `biome check --write`.

### 2. `packages/cleo/src/cli/index.ts`
- **Error**: Imports and exports not sorted (line 9+)
- **Fix**: Biome re-sorted the import block. Applied via `biome check --write`.

### 3. `packages/core/src/memory/__tests__/llm-extraction.test.ts`
- **Error**: `checkHashDedup` imported from `../extraction-gate.js` but never used as a symbol in tests (only referenced as a string key in a `vi.mock()` factory on line 46)
- **Fix**: Manually removed `checkHashDedup` from import on line 91. `verifyAndStore` remains (it is used in test assertions).

## Verification

```
npx biome ci --config-path=biome.json packages/  # Exit 0 — 1389 files clean
pnpm run build                                    # Exit 0 — Build complete
```

## Notes

- Local `biome ci .` from repo root fails with "nested root configuration" due to `.claude/worktrees/agent-ac5f6c49/biome.json` existing locally. CI doesn't hit this because worktrees dir is not checked out. No action needed on that.
- No version bump — still v2026.4.63 codebase.
