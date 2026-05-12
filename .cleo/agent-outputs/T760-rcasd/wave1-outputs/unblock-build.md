# Build Unblocker — T760 Docs Domain Fixes

**Date**: 2026-04-15  
**Scope**: Fix 2 specific build breakages to unblock compilation

## Breakage 1: Missing exports from `@cleocode/core/internal`

**Problem**: `packages/cleo/src/dispatch/domains/docs.ts` imports the following symbols from `@cleocode/core/internal`, but they were not re-exported:
- `AttachmentRef`
- `LocalFileAttachment`
- `UrlAttachment`
- `createAttachmentStore`
- `DerefResult`

**Root Cause**: The attachment-store module and its types from contracts were never added to the internal.ts barrel.

**Solution**: Added re-exports to `packages/core/src/internal.ts` (lines 523-530):

```typescript
// Attachment store (T760 docs domain)
export { AttachmentIntegrityError, createAttachmentStore } from './store/attachment-store.js';
export type { DerefResult } from './store/attachment-store.js';
// Re-export attachment types from contracts for dispatch layer
export type {
  AttachmentRef,
  LocalFileAttachment,
  UrlAttachment,
} from '@cleocode/contracts';
```

**Verification**:
```bash
$ grep -c "AttachmentRef\|LocalFileAttachment\|UrlAttachment\|createAttachmentStore\|DerefResult" packages/core/src/internal.ts
5
```

✓ All 5 symbols now present in internal.ts

## Breakage 2: Type mismatch in task-engine.ts line 100

**Problem**: 
```
Type 'AcceptanceItem[] | undefined' is not assignable to type 'string[] | undefined'.
Type 'AcceptanceItem[]' is not assignable to type 'string[]'.
Type 'AcceptanceItem' is not assignable to type 'string'.
Type 'TestGate' is not assignable to type 'string'.
```

**Root Cause**: Task.acceptance is `AcceptanceItem[]` (from contracts, where `AcceptanceItem = string | AcceptanceGate`), but TaskRecord expects `string[]` for backward compatibility.

**Solution**: Added a type guard filter in `packages/cleo/src/dispatch/engines/task-engine.ts` to extract only string-typed acceptance criteria:

```typescript
// Line 100 (was):
acceptance: task.acceptance,

// Now:
acceptance: task.acceptance?.filter((a): a is string => typeof a === 'string'),
```

This strips out structured gates (T780/T800 concern) and preserves legacy string criteria for the LAFS dispatch layer.

**Verification**:
```bash
$ pnpm --filter @cleocode/cleo run build 2>&1 | grep "task-engine.ts" | wc -l
0
```

✓ No errors in task-engine.ts

## Build Status

```bash
$ pnpm --filter @cleocode/core run build 2>&1 | grep -iE "error TS|error:" | head -5
src/tasks/gate-runner.ts(29,3): error TS2724: ...  # Pre-existing (T781)
src/tasks/gate-runner.ts(30,3): error TS2305: ...  # Pre-existing (T781)
... [4 more pre-existing T781 errors]

$ pnpm --filter @cleocode/cleo run build 2>&1 | tail -3
> @cleocode/cleo@2026.4.69 build
> tsc
```

✓ @cleocode/cleo builds successfully (no errors)
✓ Pre-existing @cleocode/core errors are from T781 (gate-runner), not this work

## Scope Adherence

- ✓ Fixed Breakage 1 (missing exports)
- ✓ Fixed Breakage 2 (acceptance type mismatch)
- ✓ Did NOT touch T781 gate-runner
- ✓ Did NOT touch T782 req registration
- ✓ Did NOT touch other in-flight work
- ✓ No changes to registry.ts "docs" domain (out of scope per instructions)
- ✓ No changes to docs.ts parameter type (out of scope per instructions)

## Epic & Task References

- **Epic**: T760 (Unified Attachment System)
- **Related Task**: T797 (docs domain handler)
- **Type**: Build fix / unblock
