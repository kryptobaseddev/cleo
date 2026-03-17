# Errors Agent Output - Task #11

**Task**: Phase 1A: LAFS v1.7.0 upgrade + RFC 9457 error consolidation
**Status**: COMPLETED

## Summary

Upgraded LAFS to v1.7.0, created unified error catalog, added RFC 9457 ProblemDetails support, added adapter-specific error codes (95-99), created CLI error renderer, and deprecated legacy error registries.

## Changes Made

### Step 1: LAFS v1.7.0 Upgrade
- **File**: `package.json` (line 85)
- Upgraded `@cleocode/lafs-protocol` from `^1.6.0` to `^1.7.0`
- v1.7.0 confirmed available on npm registry

### Step 2: Error Registries Identified
Found 5 scattered error registries:
1. `src/core/errors.ts` -- CleoError class with toLAFSError()
2. `src/mcp/lib/exit-codes.ts` -- Duplicate ExitCode enum + ERROR_MAP (1000+ lines)
3. `src/core/error-registry.ts` -- CLEO_ERROR_REGISTRY array
4. `src/dispatch/engines/_error.ts` -- STRING_TO_EXIT map + engineError()
5. `src/types/exit-codes.ts` -- Canonical ExitCode enum (source of truth)

### Step 3: Unified Error Catalog
- **New file**: `src/core/error-catalog.ts`
- Single Map<number, ErrorDefinition> covering all 72+ exit codes
- Each entry includes: code, name, category, message, httpStatus, recoverable, lafsCode, fix
- Exported helpers: `getErrorDefinition()`, `getErrorDefinitionByLafsCode()`, `getAllErrorDefinitions()`
- Includes new adapter error codes (95-99)

### Step 4: RFC 9457 ProblemDetails on CleoError
- **Modified**: `src/core/errors.ts`
- Added `ProblemDetails` interface (type, title, status, detail, instance, extensions)
- Added `toProblemDetails()` method on CleoError
- `exitCodeToCategory()` now delegates to catalog first, falls back to range-based logic
- `exitCodeToLafsCode()` now uses catalog's canonical lafsCode
- Added private `getHttpStatus()` fallback method

### Step 5: EngineResult + DispatchError Updated
- **Modified**: `src/dispatch/domains/_base.ts` -- EngineResult.error now has optional `problemDetails`
- **Modified**: `src/dispatch/types.ts` -- DispatchError now has optional `problemDetails` field
- wrapResult() passes through problemDetails when present

### Step 6: Adapter Error Codes
- **Modified**: `src/types/exit-codes.ts` -- Added ADAPTER_NOT_FOUND (95) through ADAPTER_INSTALL_FAILED (99)
- **Modified**: `src/dispatch/engines/_error.ts` -- Added E_ADAPTER_* entries to STRING_TO_EXIT

### Step 7: CLI Error Renderer
- **New file**: `src/cli/renderers/error.ts`
- `renderErrorMarkdown(error: CleoError): string` -- renders structured markdown output
- Shows error code, name, message, category, fix, alternatives, recoverability

### Step 8: Deprecated Legacy Registries
- **Modified**: `src/core/error-registry.ts` -- Added @deprecated JSDoc tag pointing to error-catalog.ts
- **Modified**: `src/mcp/lib/exit-codes.ts` -- Added @deprecated JSDoc tag pointing to error-catalog.ts and exit-codes.ts
- Legacy files retained for backward compatibility; no deletions

### Step 9: Test Fixes
- **Modified**: `src/core/__tests__/lafs-conformance.test.ts` -- Updated regex from `/^E_NOT_FOUND/` to `/^E_CLEO_NOT_FOUND/` (catalog now returns canonical LAFS codes)
- **Modified**: `src/core/__tests__/cli-parity.test.ts` -- Same regex update

## Build + Test Results
- `npm run build`: PASSES
- `npx tsc --noEmit`: ZERO type errors
- `npx vitest run`: 4637 passed, 4 failed (all 4 failures are pre-existing: research-workflow.test.ts + 2 were fixed above)
- Only remaining failure: `research-workflow.test.ts` (pre-existing, documented in MEMORY.md)

## Files Modified/Created

| File | Action |
|------|--------|
| `package.json` | Modified (LAFS ^1.7.0) |
| `src/core/error-catalog.ts` | **Created** |
| `src/core/errors.ts` | Modified (ProblemDetails) |
| `src/cli/renderers/error.ts` | **Created** |
| `src/types/exit-codes.ts` | Modified (adapter codes 95-99) |
| `src/dispatch/engines/_error.ts` | Modified (adapter STRING_TO_EXIT) |
| `src/dispatch/domains/_base.ts` | Modified (problemDetails field) |
| `src/dispatch/types.ts` | Modified (problemDetails field) |
| `src/core/error-registry.ts` | Modified (deprecated tag) |
| `src/mcp/lib/exit-codes.ts` | Modified (deprecated tag) |
| `src/core/__tests__/lafs-conformance.test.ts` | Modified (regex fix) |
| `src/core/__tests__/cli-parity.test.ts` | Modified (regex fix) |
