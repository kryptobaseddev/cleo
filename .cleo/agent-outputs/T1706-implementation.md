# T1706 Implementation Output

**Task**: W1-F: DELETE contracts-internal LAFSEnvelope/LAFSMeta divergent inlines + re-export from @cleocode/lafs
**Date**: 2026-05-02
**Commit**: 1d676f3bf4298ebdfe3ce28252157048514ba561 (task/T1706 branch)
**Status**: Complete

## Summary

Deleted the rogue 4th envelope variant from `packages/contracts/src/lafs.ts` that diverged silently from `@cleocode/lafs` canonical. ADR-039 mandates `@cleocode/lafs` as the LAFS protocol owner; contracts must re-export, not redefine.

## Changes Made

### `packages/contracts/src/lafs.ts`
- Deleted inline `LAFSEnvelope` (hybrid `{success, data?, error?, _meta?}` shape — diverges from both the SDK `{$schema, _meta, result}` shape and the CLI `{success, data?, error?, meta}` shape)
- Deleted inline `LAFSMeta` (subset: transport+mvi+page+warnings+durationMs — diverges from SDK `LAFSMeta` which requires specVersion, schemaVersion, timestamp, operation, requestId, transport, strict, mvi, contextVersion)
- Deleted inline `LAFSError` (used lowercase `category: LAFSErrorCategory` and `code: number|string` — diverges from SDK canonical `code: string` + SCREAMING_SNAKE_CASE category)
- Deleted inline `LAFSErrorCategory` (lowercase values: 'validation', 'not_found', 'conflict', 'authorization', 'internal', 'rate_limit', 'timeout', 'dependency' — all WRONG vs canonical SCREAMING_SNAKE_CASE)
- Deleted inline `LAFSTransport` (missing 'grpc' transport variant)
- Deleted inline `MVILevel` (missing 'custom' level)
- Deleted inline `Warning`, `LAFSPageNone`, `LAFSPageOffset`, `LAFSPageCursor`, `LAFSPage`
- Added re-exports: `LAFSEnvelope`, `LAFSMeta`, `LAFSError`, `LAFSErrorCategory`, `LAFSTransport`, `LAFSPage`, `LAFSPageCursor`, `LAFSPageNone`, `LAFSPageOffset`, `MVILevel`, `Warning` from `@cleocode/lafs`
- `GatewayMeta extends LAFSMeta` now uses the canonical `@cleocode/lafs` shape. `createGatewayMeta()` in `packages/cleo/src/dispatch/lib/gateway-meta.ts` already populates all required fields (specVersion, schemaVersion, timestamp, operation, requestId, transport, strict, mvi, contextVersion), so no callers broke.
- Kept contracts-owned types: `FlagInput`, `ConformanceReport` (different shapes from lafs SDK equivalents), `LafsAlternative`, `LafsErrorDetail`, `LafsSuccess`, `LafsError`, `LafsEnvelope`, `GatewayMeta`, `GatewaySuccess`, `GatewayError`, `GatewayEnvelope`, `CleoResponse`, type guards

### `packages/contracts/src/index.ts`
- Added `LAFSPageCursor` to the barrel export (was previously missing)

### `packages/contracts/package.json`
- Added `@cleocode/lafs: workspace:*` to dependencies (no circular dependency — lafs has zero contracts deps)

## Impact Analysis

Impact was checked before changes:
- No external consumer imports `LAFSEnvelope`, `LAFSMeta`, `LAFSError`, or `LAFSErrorCategory` from `@cleocode/contracts` — they import from `@cleocode/lafs` directly
- Only `GatewayMeta` is imported from `@cleocode/contracts` externally (gateway-meta.ts) — this type now correctly extends the full `@cleocode/lafs` LAFSMeta

## Quality Gates

- **Build**: Full repo `pnpm run build` — clean
- **Biome CI**: `pnpm biome ci packages/` — clean (2047 files, no fixes)
- **Tests (contracts)**: 148/148 passed
- **Tests (full)**: 46 files failed / 11585 passed — all failures are pre-existing (studio tsconfig missing, SQLite infrastructure, epic-enforcement) — baseline on main was 49 files failed

## Casing Fix

The `LAFSErrorCategory` lowercase drift is eliminated. Before: contracts exported `'validation' | 'not_found' | 'conflict' | ...`. After: contracts re-exports the canonical `'VALIDATION' | 'AUTH' | 'PERMISSION' | 'NOT_FOUND' | 'CONFLICT' | 'RATE_LIMIT' | 'TRANSIENT' | 'INTERNAL' | 'CONTRACT' | 'MIGRATION'` from `@cleocode/lafs`. No callers were using the contracts version of `LAFSErrorCategory` — they all imported from `@cleocode/lafs` directly.
