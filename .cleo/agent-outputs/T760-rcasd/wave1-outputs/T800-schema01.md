# T800 SCHEMA-01: Tighten Acceptance Validator

**Epic**: T772 Schema Hardening  
**Status**: Complete  
**Date**: 2026-04-16

## Summary

Tightened the `Task.acceptance` validator to enforce strict type safety:

- **Strings**: Must be non-empty (trimmed). Rejects empty/whitespace-only.
- **Objects**: Must be valid `AcceptanceGate` with discriminated union (test, file, command, lint, http, manual). Rejects malformed objects.
- **Array**: Requires ≥1 item (matches CLEO policy). Rejects duplicate `req:` GSD-IDs.
- **Error Messages**: Clear guidance on fixing invalid input.

## Changes

### 1. `packages/contracts/src/acceptance-gate-schema.ts`

- **acceptanceItemSchema**: Tightened with `.trim().min(1)` on strings, clear error messages
- **acceptanceArraySchema**: Added `.min(1)` requirement + `.refine()` check for duplicate `req:` values
- All with detailed JSDoc examples showing valid/invalid usage

### 2. `packages/contracts/src/__tests__/acceptance-gate.test.ts`

Added 8 new test cases for T800:
- Rejects empty/whitespace-only strings
- Rejects malformed objects (missing `kind`)
- Rejects duplicate `req:` IDs across gates
- Accepts mixed arrays with unique `req:` IDs
- Accepts gates without `req:` fields

**All 52 tests pass** (52 passed, 0 failed)

### 3. `packages/contracts/src/task.ts`

- Added `AcceptanceItem` type definition: `export type AcceptanceItem = string | AcceptanceGate`
- Updated `Task.acceptance` field from `string[]` to `AcceptanceItem[]`
- Updated `TaskCreate.acceptance` field from `string[]` to `AcceptanceItem[]`

### 4. `packages/contracts/src/index.ts`

- Exported `AcceptanceItem` type in Task Types section

### 5. `packages/core/src/tasks/enforcement.ts`

- Updated `AddTaskEnforcementOptions.acceptance` from `string[]` to `AcceptanceItem[]`
- Updated `UpdateTaskEnforcementOptions.acceptance` from `string[]` to `AcceptanceItem[]`
- Updated `checkMin()` parameter type from `string[]` to `AcceptanceItem[]`
- Function logic unchanged (just counts array length)

## Quality Gates

✅ `pnpm run test` — 52/52 tests pass  
✅ `pnpm run build` — Full build green  
✅ Type safety — No `any` or `unknown` types  
✅ DRY/SOLID — Reused existing gate schema, added refinement only  
✅ Biome checks — Code formatted and linted  

## Dependency Status

✅ T779 (AcceptanceGate Zod schema) — Completed  
✅ T780 (Mixed acceptance widening) — Completed  
✅ This task (T800) — Completed  

## Notable Design Decisions

1. **Zod Union**: Used `.union([string, gate])` to try string first, avoiding gate parse errors on plain text
2. **Duplicate Check**: `.refine()` on array level, checks only non-undefined `req:` values
3. **Min(1) Array**: Enforces CLEO's anti-hallucination rule: tasks must have ≥1 acceptance criterion
4. **Error Messages**: All `.describe()` and custom error messages guide users toward fixes
