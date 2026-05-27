# T1694 — W1-A1: Reconcile GateStatus shape mismatch

**Task**: T1694  
**Date**: 2026-05-02  
**Status**: completed  
**Commit**: da3048c0 (task/T1694)

## Drift Analysis

Two definitions of `GateStatus` existed in `packages/contracts/src/`:

| File | Type |
|------|------|
| `operations/lifecycle.ts` | `'passed' \| 'failed' \| 'blocked' \| null` |
| `status-registry.ts` (canonical, ADR-018) | `'pending' \| 'passed' \| 'failed' \| 'waived'` |

Differences: lifecycle had `null` and `'blocked'`; lacked `'pending'` and `'waived'`.

## Changes Made

### `packages/contracts/src/operations/lifecycle.ts`
- Removed local `export type GateStatus = 'passed' | 'failed' | 'blocked' | null`
- Added `import type { GateStatus, StageStatus } from '../status-registry.js'`
- Re-exports canonical `GateStatus` via `export type { GateStatus, StageStatus }`
- Updated `LifecycleCheckResult.gateStatus` from inline `'passed' | 'failed' | 'pending'` to use `GateStatus`

### `packages/contracts/src/index.ts`
- Added `Gate` to top-level lifecycle exports (previously omitted due to now-resolved conflict)
- Updated stale comment that documented the removed conflict

## Caller Impact

Grep across all packages confirmed:
- No consumer imports `GateStatus` or `Gate` directly from `operations/lifecycle.ts`
- All consumers use `GateStatus` from `status-registry.ts` (via `@cleocode/contracts` top-level or `core/store/status-registry.ts`)
- The `GateStatus` enum in `operation-verification-gates.ts` (core) is a SEPARATE symbol (`GateStatus.PASSED`, `.FAILED`, etc.) — not a contracts type

## Quality Gates

- `pnpm --filter @cleocode/contracts run build`: CLEAN (6 schemas emitted)
- `pnpm run build` (full monorepo): CLEAN (`Build complete`)
- `pnpm run test` (full suite): 12230/12231 passed; 1 failure confirmed pre-existing SQLite migration state issue unrelated to this change
- `pnpm biome ci` on modified files: CLEAN (no fixes applied)
