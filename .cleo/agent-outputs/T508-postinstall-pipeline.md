# T508 — Postinstall Pipeline Enhancement

**Status**: complete
**Date**: 2026-04-11
**Task**: T508

## Summary

Enhanced the npm postinstall pipeline so that `npm install -g @cleocode/cleo` now verifies all runtime dependencies immediately after bootstrap completes, rather than leaving users to discover broken features at runtime.

## Deliverables

### 1. `packages/cleo/bin/postinstall.js` (modified)

Added `verifyDependencies()` function called after `bootstrapGlobalCleo()` succeeds.

Behavior:
- Imports `checkAllDependencies` via the same two-path strategy as bootstrap (`@cleocode/core/internal` first, `@cleocode/core` as fallback).
- Prints `CLEO: ✓ <name> <version>` for each healthy required dependency.
- Prints `CLEO: ✗ <name> — REQUIRED but <not found|unhealthy>` plus a fix hint for each failing required dependency.
- Prints a summary count of missing optional/feature dependencies with install hints.
- Prints a warning and points to `cleo doctor` when any required dep is missing.
- Wrapped in try/catch: prints "Dependency check deferred" on error. Exit code is always 0.

### 2. `packages/core/src/bootstrap.ts` (modified)

Added two new public exports:

**`BootstrapVerificationResult` (interface)**
- `complete: boolean` — true when both injection-chain and dependency checks pass.
- `bootstrapHealthy: boolean` — injection-chain result.
- `dependenciesHealthy: boolean` — all required deps healthy.
- `failures: string[]` — blocking failures from either check.
- `warnings: string[]` — non-fatal advisory messages.

**`verifyBootstrapComplete(): Promise<BootstrapVerificationResult>`**
- Part 1: Runs existing `verifyBootstrapHealth()` (injection-chain: XDG template, legacy template, AGENTS.md reference, orphaned content). Health check warnings are surfaced as warnings, not failures.
- Part 2: Dynamically imports `checkAllDependencies` from `./system/dependencies.js` and runs all 8 registered dep checks.
- Non-throwing: every error is captured. The function never throws.

### 3. `packages/core/src/internal.ts` (modified)

Added exports to the internal barrel:
- `BootstrapVerificationResult` (type) from `./bootstrap.js`
- `verifyBootstrapComplete` from `./bootstrap.js`
- `checkAllDependencies`, `checkDependency`, `getDependencySpecs` from `./system/dependencies.js`

### 4. `packages/core/src/system/health.ts` (pre-existing bug fix)

Fixed `TS6133: 'projectRoot' is declared but its value is never read` in `checkAdapterHealth()`. The parameter was passed by the caller but the function body ignored it and called `getPackageRoot()` instead. Fixed by using `projectRoot || getPackageRoot()` so the caller-supplied root takes precedence.

## Quality Gates

| Gate | Result |
|------|--------|
| `pnpm biome check --write` | Clean (2 files auto-fixed: import sort + string wrap) |
| `pnpm run build` | Build success (ESM + DTS both pass) |
| `pnpm run test` | 7018 passed, 15 skipped, 0 failures (390 test files) |

## Design Decisions

- **Non-blocking by contract**: `verifyDependencies()` in postinstall.js is wrapped in try/catch and `runPostinstall` exits 0 regardless. Dependency failures are warnings, not errors.
- **Same import fallback pattern**: Uses the established two-path import strategy (`@cleocode/core/internal` -> `@cleocode/core`) so postinstall.js works with both tsc multi-file and esbuild single-file builds.
- **Unicode checkmarks via escape**: Used `\u2713` (✓) and `\u2717` (✗) to avoid encoding issues in a plain JS file, consistent with owner preference for no emoji in production code.
- **`verifyBootstrapComplete` is additive**: The new function calls the existing private `verifyBootstrapHealth` — no duplication, single source of truth for injection-chain logic.
