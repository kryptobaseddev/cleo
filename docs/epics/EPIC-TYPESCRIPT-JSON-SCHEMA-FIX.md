# EPIC: Fix TypeScript JSON Schema Import Errors

**Status:** Critical - Blocking CI  
**Errors:** 283 typecheck failures  
**Created:** 2026-03-25  
**Assignee:** [Agent to pick up]

## Problem Summary

CI typecheck is failing with 283 TypeScript errors related to JSON schema imports in the LAFS package.

## Error Categories

### 1. TS6307: File not listed in project (~200 errors)
**Files affected:**
- `packages/lafs/schemas/v1/conformance-profiles.json`
- `packages/lafs/schemas/v1/error-registry.json`
- `packages/lafs/schemas/v1/envelope.schema.json`

**Source files importing them:**
- `packages/lafs/src/conformanceProfiles.ts:1`
- `packages/lafs/src/errorRegistry.ts:1`
- `packages/lafs/src/validateEnvelope.ts:2`

**Root Cause:** JSON files imported with `{ type: 'json' }` but not included in TypeScript project

### 2. TS6305: Output file not built from source (~80 errors)
**Issue:** Stale `.d.ts` files in `dist/` directories
**Affected:** All packages with tests and examples
**Root cause:** Test files included in compilation but excluded from build

## Solution: Auto-Generated Type Declarations

**Script created:** `scripts/generate-json-types.mjs`

This script auto-generates `.d.ts` files for each JSON schema:
- `conformance-profiles.json` → `conformance-profiles.d.ts`
- `error-registry.json` → `error-registry.d.ts`
- `envelope.schema.json` → `envelope.schema.d.ts`

### To Implement:

1. **Run the generator:**
   ```bash
   node scripts/generate-json-types.mjs
   ```

2. **Update tsconfig.json:**
   ```json
   {
     "compilerOptions": {
       "resolveJsonModule": true
     },
     "include": [
       "src/**/*",
       "schemas/**/*.d.ts"
     ]
   }
   ```

3. **Update source files** to import from .d.ts instead of .json:
   ```typescript
   // Before
   import profilesJson from '../schemas/v1/conformance-profiles.json' with { type: 'json' };
   
   // After
   import profilesJson from '../schemas/v1/conformance-profiles.js';
   ```

4. **Add to package.json scripts:**
   ```json
   {
     "scripts": {
       "generate:json-types": "node scripts/generate-json-types.mjs"
     }
   }
   ```

## Alternative: Quick Fix (If needed urgently)

If you need to unblock CI immediately:

1. Update root `tsconfig.json`:
   ```json
   {
     "exclude": [
       "**/*.test.ts",
       "**/examples/**/*",
       "**/dist/**/*"
     ]
   }
   ```

2. Update `packages/lafs/tsconfig.json`:
   ```json
   {
     "include": [
       "src/**/*",
       "schemas/**/*.json"
     ]
   }
   ```

## Acceptance Criteria
- [ ] All 283 typecheck errors resolved
- [ ] CI typecheck job passes
- [ ] JSON schemas remain accessible at runtime
- [ ] No breaking changes to public APIs
- [ ] Script added to CI or pre-commit hooks

## Related
- Script: `scripts/generate-json-types.mjs` (already created)
- CI Workflow: `.github/workflows/ci.yml`
- LAFS tsconfig: `packages/lafs/tsconfig.json`
