# T5338 Discovery: Legacy JSONL Read Path Audit

**Agent**: brief-reader
**Date**: 2026-03-05
**Scope**: All `.jsonl` / JSONL references in `src/` and `tests/` TypeScript files

---

## Summary

**Total JSONL references found**: 250+ (across src/ and tests/)
**Legacy audit JSONL (todo-log/tasks-log) references**: 13 locations
**Actionable items for T5338**: 6 items (3 production, 3 test)

The vast majority of JSONL references are **ACTIVE, LEGITIMATE** JSONL usage:
- MANIFEST.jsonl (research manifests) — active feature
- COMPLIANCE.jsonl (metrics) — active feature
- GRADES.jsonl (session grading) — active feature
- TOKEN_USAGE.jsonl (metrics) — active feature
- decisions.jsonl, assumptions.jsonl (audit trail) — active feature
- migration-*.jsonl (migration logs) — active feature
- Pino JSONL log parser — active feature

**Only the legacy audit log JSONL paths (todo-log.jsonl / tasks-log.jsonl) are in scope for T5338.**

---

## Category A: ACTIONABLE — Production Code (3 items)

### A1. `src/dispatch/engines/system-engine.ts:415` — STALE COMMENT
```
Line 415: * Reads from SQLite audit_log table (primary) with JSONL fallback.
```
**Status**: Comment says "JSONL fallback" but the function body (lines 419-437) is PURE SQLite. No JSONL code exists.
**Action**: `FIX_STALE_COMMENT` — Change comment to "Reads from SQLite audit_log table."
**Risk**: Zero. Comment-only change.

### A2. `src/core/stats/index.ts:56,170` — READS PINO LOG AS LEGACY FORMAT
```typescript
// Line 56:
const entries = await readLogEntries(getLogPath(opts.cwd));
// Line 170:
const allEntries = await readLogEntries(getLogPath(opts.cwd));
```
**What it does**: `getLogPath()` returns `.cleo/logs/cleo.log` (Pino JSONL log). `readLogEntries()` from `src/store/json.ts:135` uses a hybrid JSON/JSONL parser. It reads Pino log entries and filters by `action` fields like `task_created`, `task_completed`, `status_changed`.
**Problem**: Pino log entries use different field names (`domain`, `operation`, `durationMs`) than the legacy format (`action`, `taskId`). The stats module is filtering by `e.action === 'task_created'` which matches `audit_log` entry format, NOT Pino log format. This code is likely broken or returning empty results silently.
**Action**: `MIGRATE_TO_DB` — Rewrite to query `audit_log` SQLite table instead of reading Pino log files. Use same pattern as `coreTaskHistory()`.
**Risk**: Medium. This changes stats behavior. Needs a test to verify.
**Replacement**:
```typescript
// Query audit_log SQLite instead of reading Pino log file
const { getDb } = await import('../../store/sqlite.js');
const { auditLog } = await import('../../store/schema.js');
const { gte, desc } = await import('drizzle-orm');
const db = await getDb(opts.cwd ?? process.cwd());
const rows = await db.select().from(auditLog)
  .where(gte(auditLog.timestamp, cutoff))
  .orderBy(desc(auditLog.timestamp));
const entries = rows.map(r => ({
  action: r.action, taskId: r.taskId, timestamp: r.timestamp,
  details: r.detailsJson ? JSON.parse(r.detailsJson) : {},
  after: r.afterJson ? JSON.parse(r.afterJson) : undefined,
}));
```

### A3. `src/store/file-utils.ts:106` + `src/core/platform.ts:222` — ORPHANED UTILITY
```typescript
// file-utils.ts:106
export function readLogFileEntries(filePath: string): Record<string, unknown>[]
// platform.ts:222
export { readLogFileEntries } from '../store/file-utils.js';
```
**Callers**: Only `src/core/tasks/__tests__/task-ops-depends.test.ts:17` (mocked, never actually called).
**Action**: `CHECK_IF_ORPHANED` — Verify no other callers exist. If orphaned, mark for removal in a follow-up (not blocking for T5338). The function itself is a generic JSONL parser, not audit-specific.
**Risk**: Low. Re-export from platform.ts could have external consumers.

---

## Category B: ACTIONABLE — Test Code (3 items)

### B1. `src/mcp/__tests__/test-environment.ts:196-224` — STALE TEST HELPER
```typescript
// Line 198: reads todo-log.jsonl
export function getLogFilePath(projectRoot: string): string {
  return path.join(projectRoot, '.cleo', 'todo-log.jsonl');
}
// Line 206: parses legacy JSON format
export async function readAuditEntries(projectRoot, filter?)
```
**Callers**: None found in grep (the functions are exported but no imports detected).
**Action**: `DELETE_STALE_TEST` — Remove both functions. They read a file that no longer exists.
**Risk**: Low. Verify no test imports these before deleting.

### B2. `src/mcp/__tests__/integration-setup.ts:860-914` — STALE TEST HELPER
```typescript
// Line 862: reads todo-log.jsonl / tasks-log.jsonl with 4 candidate paths
export async function getAuditLogEntries(projectRootOrTestDataDir, filter?)
```
**Callers**: `src/mcp/gateways/__tests__/mutate.integration.test.ts:18,423,450,465,479` — actively used in integration tests.
**Action**: `MIGRATE_TEST_TO_DB` — Rewrite `getAuditLogEntries()` to query SQLite `audit_log` instead of reading JSONL files. The calling tests in `mutate.integration.test.ts` already note "Legacy JSON file-based getAuditLogEntries() may return 0 entries" (lines 423, 450) — they expect this is broken.
**Risk**: Medium. Must update `mutate.integration.test.ts` expectations too.
**Replacement**: Use `queryAudit()` from `src/dispatch/middleware/audit.ts` or direct SQLite query.

### B3. `src/store/__tests__/migration-integration.test.ts:265-286` — INTENTIONAL MIGRATION TEST
```typescript
// Lines 265-266, 285-286: Creates todo-log.jsonl and tasks-log.jsonl as test fixtures
await writeFile(join(cleoDir, 'todo-log.jsonl'), '');
await writeFile(join(cleoDir, 'tasks-log.jsonl'), '');
```
**Action**: `KEEP` — These test that the migration system handles legacy files correctly. They CREATE legacy files as fixtures to test the upgrade path. This is intentional and should NOT be removed.

---

## Category C: NOT IN SCOPE — Active JSONL Features (keep all)

| Feature | Files | JSONL File | Status |
|---------|-------|------------|--------|
| Research manifests | `src/core/memory/index.ts`, `src/core/paths.ts`, `src/core/skills/manifests/research.ts` | `MANIFEST.jsonl` | Active feature |
| Compliance metrics | `src/core/compliance/store.ts`, `src/core/validation/validate-ops.ts`, `src/core/metrics/common.ts` | `COMPLIANCE.jsonl` | Active feature |
| Session grades | `src/core/sessions/session-grade.ts` | `GRADES.jsonl` | Active feature |
| Token usage | `src/core/metrics/token-estimation.ts`, `src/core/otel/index.ts` | `TOKEN_USAGE.jsonl` | Active feature |
| Decision log | `src/core/sessions/decisions.ts`, `src/core/orchestration/bootstrap.ts` | `decisions.jsonl` | Active feature |
| Assumptions | `src/core/sessions/assumptions.ts` | `assumptions.jsonl` | Active feature |
| Migration logs | `src/core/migration/logger.ts` | `migration-*.jsonl` | Active feature |
| Pino log parser | `src/core/observability/log-parser.ts`, `log-reader.ts` | `.cleo/logs/*.log` | Active feature |
| ADR manifests | `src/core/adrs/sync.ts` | `MANIFEST.jsonl` | Active feature |
| Brain migration | `src/core/memory/brain-migration.ts` | `patterns.jsonl`, `learnings.jsonl` | Migration utility |
| A/B tests | `src/core/metrics/ab-test.ts` | `AB_TESTS.jsonl` | Active feature |
| Global metrics | `src/core/metrics/aggregation.ts` | `GLOBAL.jsonl`, `SESSIONS.jsonl` | Active feature |
| JSONL output format | `src/types/config.ts:9` | N/A | Output format enum |
| Protocol validation | `src/core/skills/validation.ts`, `src/core/validation/protocol-common.ts` | N/A | Pattern matching for "MANIFEST.jsonl" strings |
| Registry descriptions | `src/dispatch/registry.ts:1601,2061` | N/A | Operation descriptions |
| Schema comment | `src/store/schema.ts:339` | N/A | Historical comment |
| JSONL append utility | `src/store/json.ts:113-124` | N/A | Generic utility (used by manifests, compliance) |
| JSONL read utility | `src/store/json.ts:127-212` | N/A | Generic utility |
| JSONL read sync | `src/store/file-utils.ts:101-160` | N/A | Generic utility |

---

## Recommended Execution Order for T5338

1. **A1** (system-engine comment) — 1 line change, zero risk
2. **B1** (test-environment stale helpers) — delete dead code
3. **B2** (integration-setup JSONL helper) — rewrite to SQLite, update test expectations
4. **A2** (stats/index.ts) — rewrite to query audit_log SQLite
5. **A3** (file-utils orphan check) — verify, potentially defer

**Estimated scope**: Small. 3 file modifications, 1 dead code removal, 1 comment fix.
