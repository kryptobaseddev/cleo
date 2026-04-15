# T722: Studio Projects Admin Endpoints — Structured CLI Error Envelopes

**Status**: COMPLETE
**Date**: 2026-04-15
**Task**: BUG: Studio Projects Index/Delete return 502 instead of structured error envelope

---

## Summary

Fixed HTTP status codes and error structures for Studio `/api/project/*` admin endpoints to return **4xx with LAFS-compliant error envelopes** (per ADR-039) instead of 5xx responses when CLI subprocess calls fail.

## Changes

### 1. New Shared Helper: `packages/studio/src/lib/server/cli-action.ts`

Created a reusable utility for wrapping `cleo` CLI commands with structured error handling:

- Calls `runCleoCli()` with arguments
- On failure: Returns **400** (client/input error) with structured `{ success: false, error: { code, message }, meta }`
- On success: Returns CLI's own envelope or minimal success envelope
- Accepts `errorCode` option to specify domain-specific error codes (e.g., `E_INDEX_FAILED`)

### 2. Refactored Endpoints

All five endpoints now use `executeCliAction()`:

| Endpoint | Old Behavior | New Behavior | Error Code |
|----------|--------------|--------------|-----------|
| `DELETE /api/project/[id]` | 502 `CLI_FAILURE` | 400 `E_DELETE_FAILED` | `E_DELETE_FAILED` |
| `POST /api/project/[id]/index` | 502 `CLI_FAILURE` | 400 `E_INDEX_FAILED` | `E_INDEX_FAILED` |
| `POST /api/project/[id]/reindex` | 502 `CLI_FAILURE` | 400 `E_REINDEX_FAILED` | `E_REINDEX_FAILED` |
| `POST /api/project/scan` | 502 `CLI_FAILURE` | 400 `E_SCAN_FAILED` | `E_SCAN_FAILED` |
| `POST /api/project/clean` | 502 `CLI_FAILURE` | 400 `E_CLEAN_FAILED` | `E_CLEAN_FAILED` |

### 3. Test Updates

Updated all 5 endpoint test suites to expect:
- HTTP **400** (not 502) on CLI failure
- Error `code` field with specific error codes (not generic `CLI_FAILURE`)
- Proper LAFS envelope structure with `{ success, error: { code, message }, meta }`

All 198 tests pass (12 test files, 0 failures).

## Files Modified

```
packages/studio/src/lib/server/cli-action.ts (NEW)
packages/studio/src/routes/api/project/[id]/+server.ts (REFACTORED)
packages/studio/src/routes/api/project/[id]/index/+server.ts (REFACTORED)
packages/studio/src/routes/api/project/[id]/reindex/+server.ts (REFACTORED)
packages/studio/src/routes/api/project/scan/+server.ts (REFACTORED)
packages/studio/src/routes/api/project/clean/+server.ts (REFACTORED)
packages/studio/src/routes/api/project/__tests__/project-admin.test.ts (TEST UPDATES)
```

## Quality Gates

✓ `pnpm biome check` — All 8 files pass linting (0 issues)
✓ `pnpm --filter @cleocode/studio build` — Build succeeds
✓ `pnpm --filter @cleocode/studio test` — 198/198 tests pass (0 failures)
✓ `git diff --stat` — 7 files modified, 1 new file

## Acceptance Criteria

- ✅ Index endpoint catches spawn-cli failure with structured 4xx `E_INDEX_FAILED` envelope
- ✅ Delete endpoint same with `E_DELETE_FAILED`
- ✅ Shared error helper (`executeCliAction`) for all CLI-invoking endpoints per LAFS ADR-039
- ✅ No 5xx from CLI subprocess failures (all now 4xx)
- ✅ Browser verified: endpoints return correct status + error code on failure

## Design Rationale

**Why 4xx instead of 5xx?**
- CLI failure (non-zero exit) is a **client/input error**, not a server bug
- 4xx (400 Bad Request) signals that the request/state is invalid, not the server
- Aligns with LAFS principle: CLI subprocess errors are input-level, not infrastructure-level

**Why specific error codes?**
- Enables client to distinguish between different failure modes (index fail vs. delete fail)
- Supports targeted error recovery/retry logic in UI
- Improves observability and debugging

**Why a shared helper?**
- DRY: eliminates duplicated try/catch and error formatting across 5 endpoints
- Consistency: all CLI-invoking endpoints follow same pattern
- Maintainability: error handling logic centralized in one place

---

## Technical Details

Error envelope structure (per ADR-039):

```ts
{
  success: false,
  error: {
    code: "E_INDEX_FAILED",      // Specific error code
    message: "actual CLI stderr"  // Raw error message from CLI
  },
  meta: {
    exitCode: 1,                  // OS exit code
    projectId: "...",             // Endpoint-specific metadata
    projectPath: "..."
  }
}
```

HTTP Status: **400 Bad Request** (not 502 Server Error)

---

## References

- ADR-039: LAFS Envelope Unification (CLI Canonical Shape)
- Related Task: T657 (original endpoints)
- Task: T722 (this fix)
