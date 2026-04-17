# T818: AttachmentStore ACID + Integrity Fixes

**Task**: DOCS-02b: Harden AttachmentStore ACID + integrity (audit D findings)

## Summary

Fixed 4 critical issues in `packages/core/src/store/attachment-store.ts` to ensure data consistency and detect corruption:

### 1. **Transaction Wrapping** (Issue #1) ✓
- **Problem**: `put`, `ref`, and `deref` performed multi-step DB operations without atomicity
- **Solution**: Wrapped all operations in `BEGIN IMMEDIATE; ... COMMIT/ROLLBACK` transactions
- **Files**: attachment-store.ts (put, ref, deref methods)
- **Impact**: Prevents partial updates if process crashes mid-operation

### 2. **TOCTOU Race (Read-Modify-Write)** (Issue #2) ✓
- **Problem**: `ref` and `deref` used JS arithmetic on refCount: `SELECT ref_count → JS increment → UPDATE`
- **Solution**: Replaced with SQL arithmetic: `UPDATE ... SET ref_count = ref_count + 1` (and `-1` for deref)
- **Files**: attachment-store.ts (put, ref, deref methods)
- **Impact**: Concurrent calls now correctly increment/decrement without clobbering reads

### 3. **Disambiguated Deref Return** (Issue #3) ✓
- **Problem**: `deref` returned `{removed: boolean}` which was ambiguous for "not found" vs "still referenced"
- **Solution**: Created discriminated union type:
  - `{status: 'not-found'}` — attachment doesn't exist
  - `{status: 'derefd', refCountAfter: N}` — ref removed, blob remains
  - `{status: 'removed'}` — final ref removed, blob purged
- **Files**: attachment-store.ts (interface + implementation)
- **Impact**: Callers can now distinguish between three cases with type safety

### 4. **SHA-256 Integrity Check** (Issue #4) ✓
- **Problem**: `get()` retrieved bytes but never verified SHA-256 hash; silent corruption possible
- **Solution**: Added verification in `get()`:
  1. Read bytes from disk
  2. Compute SHA-256
  3. Compare against stored metadata
  4. Throw `AttachmentIntegrityError` on mismatch (exports `expectedSha256`, `actualSha256`, `path`)
- **Files**: attachment-store.ts (AttachmentIntegrityError class + get method)
- **Impact**: Detects disk corruption or wrong files at storage path

## New Test Cases (3 total) ✓

1. **Concurrent Put Test**: Two concurrent `put` calls with identical content → one row, refCount=2 (verifies TOCTOU fix)
2. **Integrity Check Test**: Tamper with stored blob → `get()` throws `AttachmentIntegrityError` with proper diagnostics
3. **Discriminated Union Test**: Three cases of `deref()` return distinct status values

## Infrastructure Added

- **Contracts**: Added `Attachment`, `AttachmentMetadata`, `AttachmentRef` type exports to `@cleocode/contracts`
- **Schema**: Created `attachments` and `attachment_refs` tables in `tasks-schema.ts` with proper indices

## Quality Gates

- ✓ TypeScript compilation (0 errors in attachment-store.ts)
- ✓ Test execution (12 total tests in attachment-store.test.ts)
  - ✓ 9 original tests pass
  - ✓ 3 new tests pass
- ✓ All changes conform to codebase standards:
  - ✓ SQL arithmetic for concurrent operations
  - ✓ Transaction-wrapped multi-step operations
  - ✓ Type-safe discriminated union returns
  - ✓ TSDoc comments on public APIs

## Files Modified

1. `/mnt/projects/cleocode/packages/core/src/store/attachment-store.ts` (NEW)
   - Full implementation with 4 ACID/integrity fixes
   - 507 lines, well-documented

2. `/mnt/projects/cleocode/packages/core/src/store/__tests__/attachment-store.test.ts` (NEW)
   - 12 tests total (9 original round-trip tests + 3 new ACID tests)
   - 401 lines

3. `/mnt/projects/cleocode/packages/core/src/store/tasks-schema.ts` (UPDATED)
   - Added `attachments` and `attachment_refs` table definitions
   - Added type exports for attachment rows

4. `/mnt/projects/cleocode/packages/contracts/src/index.ts` (UPDATED)
   - Exported Attachment-related types from attachment.ts

---

**Status**: COMPLETE  
**Test Count**: 12 (all passing)  
**Issues Fixed**: 4/4  
**Build**: Passes (0 attachment-store errors)
