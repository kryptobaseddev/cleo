# Session Recovery Status -- 2026-03-05

## Task Completion

| Task | Status | Evidence | Issues |
|------|--------|---------|--------|
| T5333 | DONE | `src/core/project-info.ts` exports `getProjectInfo()` and `getProjectInfoSync()`, returns `{ projectHash, projectId, projectRoot, projectName }`. `src/core/scaffold.ts` generates `projectId` via `randomUUID()` and backfills on repair. | None |
| T5334 | DONE | `drizzle/20260305011924_cheerful_mongu/migration.sql` adds `project_hash TEXT` column + `idx_audit_log_project_hash` index. `snapshot.json` exists. `src/store/schema.ts:364`: `projectHash: text('project_hash')` with index at line 371. | None |
| T5335 | DONE | `src/core/logger.ts:50-54`: `initLogger()` accepts optional `projectHash` param. Lines 81-84: builds `base` object with `projectHash` for pino root logger. Warns if absent (lines 99-103). | None |
| T5336 | DONE | `src/mcp/index.ts:31`: imports `getProjectInfoSync`. Lines 76-83: calls `getProjectInfoSync()` and `initLogger()` with `projectHash` at MCP startup. Lines 85-97: uses `getLogger('mcp:startup')` for structured logging. Line 326: `closeLogger()` on shutdown. | 9 `console.error` calls remain -- 7 are pre-init/shutdown/error paths (acceptable per ADR-024 section 2.1 migration period), 2 are startup messages that could be migrated (line 68 bootstrap warning, line 72 loading config). Not blockers. |
| T5337 | DONE | `src/dispatch/middleware/audit.ts:17`: imports `getProjectInfoSync`. Lines 24-34: `resolveProjectHash()` with caching. Line 118: writes `projectHash` to SQLite via `resolveProjectHash()`. `src/types/config.ts:67-69`: `LoggingConfig` has `auditRetentionDays: number` and `archiveBeforePrune: boolean`. `src/core/config.ts:53-54`: defaults set (90 days, true). | None |
| T5338 | DONE | 1. `src/core/stats/index.ts:26-53`: `queryAuditEntries()` queries SQLite `audit_log` -- no Pino/JSONL file reads. 2. `src/dispatch/engines/system-engine.ts`: JSONL references are only `COMPLIANCE.jsonl` (metrics, not audit log) -- correct. 3. `src/mcp/__tests__/test-environment.ts:198-235`: `readAuditEntries()` queries SQLite. 4. `src/mcp/__tests__/integration-setup.ts:862-919`: `getAuditLogEntries()` queries SQLite. 5. `readLogFileEntries` -- grep returns no results, function is fully removed from codebase. | None |
| T5339 | INCOMPLETE | `pruneAuditLog` grep returns zero matches across entire `src/`. Function does not exist. Not wired into MCP startup or CLI preAction. | Full implementation needed: create `pruneAuditLog()` function, wire into startup, implement archive-before-prune logic. |
| T5340 | DONE | `ADR-024-multi-store-canonical-logging.md` exists with full content (187 lines, status: approved). `ADR-019-canonical-logging-architecture.md` has SUPERSEDED notice at top (lines 1-4) and `Status: superseded` in frontmatter (line 9). | ADR numbered 024 instead of 023 as referenced in task description -- minor naming difference, content is complete. |

## TypeScript Status

Clean -- `npx tsc --noEmit` produces zero errors.

## Test Status

- 237 test files, 3895 tests total
- 3894 passed, 1 failed
- Failed test: `src/dispatch/engines/__tests__/release-engine.test.ts > Release Engine > releasePrepare > should prepare a release with specified tasks`
  - This failure is **pre-existing** (release-engine test, unrelated to T5333-T5340 logging work)

## TODO Comments Found

No actionable TODO/FIXME/HACK/XXX comments found in non-test source files.

## Remaining Work

| Task | What needs to be done | Target files |
|------|----------------------|-------------|
| T5339 | Create `pruneAuditLog()` function that: (1) reads `logging.auditRetentionDays` from config, (2) optionally archives rows to `.cleo/backups/logs/audit-YYYY-MM-DD.jsonl.gz` when `archiveBeforePrune: true`, (3) deletes rows older than retention period from `audit_log`. Wire into MCP startup (fire-and-forget) and CLI preAction hook. | New file: `src/core/audit-prune.ts` or similar. Wire in: `src/mcp/index.ts`, `src/cli/index.ts` |
| T5336 (minor) | Optionally migrate 2 remaining `console.error` calls at lines 68 and 72 to Pino after `initLogger()` -- these are pre-init messages, so they require reordering or are acceptable as-is per ADR-024. | `src/mcp/index.ts:68,72` |
