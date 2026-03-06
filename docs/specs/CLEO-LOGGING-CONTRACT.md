# CLEO Production Runtime Logging Contract

**Version**: 2026.03.05
**Status**: APPROVED
**Task**: T5309
**Supersedes**: (none -- first canonical logging contract)
**Related ADRs**: ADR-019, ADR-024

---

## 1. Overview

CLEO uses a two-store logging architecture that separates operational diagnostics from structured audit trails:

1. **Pino structured logs** -- operational events, startup lifecycle, warnings, and debug traces written to rotating log files via pino-roll.
2. **SQLite audit_log** -- every audited MCP/CLI dispatch operation written to the `audit_log` table in `.cleo/tasks.db`.

Both stores share a common set of correlation fields (`projectHash`, `requestId`, `sessionId`, `taskId`) that enable cross-referencing entries between the two systems. The dual-write principle is established in ADR-019 and extended by ADR-024.

---

## 2. Store Boundaries and Ownership

### 2.1 Pino Structured Logs (File Sink)

**What goes here**: Operational events, debug traces, startup/shutdown lifecycle, warnings, error diagnostics, cache decisions, migration progress, and any non-audit diagnostic output.

**Where written**: Log files under `.cleo/logs/` via pino-roll transport. The default file path is `.cleo/logs/cleo.log`. Rotation occurs daily and when files exceed `maxFileSize`. A pre-init fallback logger writes to stderr (fd 2) when the root logger has not yet been initialized.

**Retention**: Managed by pino-roll's built-in retention mechanism. The `maxFiles` configuration (default: 5) controls how many rotated log files are kept. pino-roll removes older files automatically via `limit.count` with `removeOtherLogFiles: true`. CLEO does not implement custom log file pruning.

**Owner**: `src/core/logger.ts` -- provides `initLogger()`, `getLogger()`, `getLogDir()`, and `closeLogger()`.

**Format**: Newline-delimited JSON (NDJSON). Each line is a Pino JSON object with uppercase level labels and ISO-8601 timestamps. Example fields per entry:

```json
{
  "level": "INFO",
  "time": "2026-03-05T10:30:00.000Z",
  "projectHash": "a1b2c3d4e5f6",
  "subsystem": "audit",
  "domain": "tasks",
  "operation": "add",
  "msg": "mutate tasks.add"
}
```

### 2.2 SQLite audit_log (tasks.db)

**What goes here**: Every audited MCP/CLI dispatch operation -- mutations always, queries only during grade sessions. Each row captures the full request/response lifecycle of a dispatch operation.

**Columns per row** (from `src/store/schema.ts`):

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID per entry (`crypto.randomUUID()`) |
| `timestamp` | TEXT NOT NULL | ISO-8601 timestamp of operation completion |
| `action` | TEXT NOT NULL | Operation name (legacy column, mirrors `operation`) |
| `task_id` | TEXT NOT NULL | Affected task ID or `'system'` for non-task ops |
| `actor` | TEXT NOT NULL | User/agent identifier (default: `'system'`) |
| `details_json` | TEXT | JSON-serialized request parameters |
| `before_json` | TEXT | Pre-operation state snapshot (from `appendLog()` data accessor) |
| `after_json` | TEXT | Post-operation state snapshot (from `appendLog()` data accessor) |
| `domain` | TEXT | Dispatch domain (e.g., `'tasks'`, `'session'`, `'memory'`) |
| `operation` | TEXT | Dispatch operation (e.g., `'add'`, `'complete'`, `'find'`) |
| `session_id` | TEXT | Active session ID (NULL if no session) |
| `request_id` | TEXT | Per-request UUID from dispatch layer |
| `duration_ms` | INTEGER | Operation duration in milliseconds |
| `success` | INTEGER | 1 for success, 0 for failure |
| `source` | TEXT | Entry point: `'mcp'` or `'cli'` |
| `gateway` | TEXT | Gateway type: `'mutate'`, `'query'` |
| `error_message` | TEXT | Error message on failure (NULL on success) |
| `project_hash` | TEXT | 12-char SHA-256 hex of project root path |

**Indexes**: `task_id`, `action`, `timestamp`, `domain`, `request_id`, `project_hash`.

**Retention**: CLEO-controlled via `pruneAuditLog()` in `src/core/audit-prune.ts`. Default retention: 90 days (`auditRetentionDays`). When `archiveBeforePrune` is true (default), prunable rows are exported to `.cleo/backups/logs/audit-YYYY-MM-DD.jsonl.gz` before deletion.

**Owner**: `src/dispatch/middleware/audit.ts` (write path via `createAudit()` middleware) and `src/core/audit-prune.ts` (retention enforcement).

### 2.3 Store Boundary Rules

- Operational/debug log events MUST NOT be written to `audit_log`. The audit store captures dispatch operations only.
- Dispatch operation audit events MUST be written to both Pino (immediate structured log) and SQLite (persistent audit trail). This is the dual-write contract from ADR-019.
- `brain.db` is a cognitive memory store, NOT a logging store. Brain write operations route through dispatch and are therefore audit-logged to `tasks.db.audit_log` with `domain='memory'`.
- `nexus.db` (when implemented) is a project sync store, NOT a logging store. It will have its own `nexus_audit_log` table for cross-project operations per ADR-024 section 2.6.

---

## 3. Correlation Fields

Every log entry (both stores) MUST include the following correlation fields where available:

| Field | Pino Binding | audit_log Column | Source | Availability |
|-------|-------------|------------------|--------|-------------|
| `projectHash` | Root logger `base` object (inherited by all children) | `project_hash` | `project-info.json` via `getProjectInfoSync()` | Always (warn if absent) |
| `requestId` | Per-request child logger binding | `request_id` | `req.requestId` from dispatch layer | Dispatch operations only |
| `sessionId` | Per-audit-entry field | `session_id` | `req.sessionId` from session-resolver middleware, fallback to `CLEO_SESSION_ID` env var | When session is active |
| `taskId` | Per-audit-entry field | `task_id` | `req.params.taskId` or `req.params.parent` | When operation is task-scoped |

### How Each Is Populated

**projectHash**: Read synchronously from `.cleo/project-info.json` via `getProjectInfoSync()` at startup. For Pino, it is bound to the root logger's `base` object in `initLogger()`, so every child logger inherits it automatically. For `audit_log`, it is resolved in `writeToSqlite()` via a cached `resolveProjectHash()` call. The value is a 12-character hex string derived from `SHA-256(projectRootPath)`, generated once at scaffold time by `generateProjectHash()` in `src/core/scaffold.ts`.

**requestId**: Assigned by the dispatch layer as a per-request UUID. Passed to `writeToSqlite()` from the audit middleware. Links the Pino audit entry to its corresponding SQLite row.

**sessionId**: Populated by the session-resolver middleware (`req.sessionId`) before the audit middleware runs. Falls back to `CLEO_SESSION_ID` or `CLEO_SESSION_GRADE_ID` environment variables when the resolver is not in the pipeline.

**taskId**: Extracted from request parameters (`params.taskId` or `params.parent`) by the audit middleware. Set to `'system'` when no task is in scope.

---

## 4. Level Policy

| Level | Numeric | When to Use | Example |
|-------|---------|-------------|---------|
| `fatal` | 60 | Process-ending errors that require immediate termination | DB corruption, unrecoverable bootstrap failure, unsupported Node.js version |
| `error` | 50 | Operation failures requiring attention but not process termination | Engine errors, unhandled exceptions caught at the top level, SQLite write failures in critical paths |
| `warn` | 40 | Degraded behavior where a fallback was taken or optional config is missing | `projectHash` not provided to `initLogger()`, audit archive failure (continues with deletion), audit prune failure at startup, audit SQLite write failure (fire-and-forget) |
| `info` | 30 | Normal operational events worth recording | Audit entries (dual-write), server startup/ready, dispatch layer initialized, audit prune completed with row counts, shutdown signals received |
| `debug` | 20 | Detailed operation flow useful for troubleshooting | Tool call arguments, cache hit/miss decisions, budget enforcement details, tool call results |
| `trace` | 10 | Fine-grained tracing for deep debugging | SQL queries, middleware chain execution steps |

**Default level**: `info` (configurable via `logging.level` in config or `CLEO_LOG_LEVEL` env var).

---

## 5. Startup / Install / Upgrade Coverage

### 5.1 MCP Startup Sequence

The MCP server startup in `src/mcp/index.ts` logs the following sequence:

1. **Node.js version check** (pre-init): If below minimum, logs `fatal` via the pre-init fallback logger and exits with code 1.
2. **Global bootstrap** (`ensureGlobalBootstrap()`): Warnings logged at `warn` level if bootstrap fails (non-blocking).
3. **Config load** (`loadConfig()`): Configuration loaded from MCP-specific config.
4. **Logger initialization** (`initLogger()`): Pino root logger created with `projectHash` bound to base context. File sink at `.cleo/logs/cleo.log`. After this point, all logging goes to files.
5. **Startup info**: Three `info` entries -- server starting (with log level), metrics status, and log level echo.
6. **Audit prune** (fire-and-forget): `pruneAuditLog()` called asynchronously. Failures logged at `warn`, never blocking startup.
7. **Dispatch layer init** (`initMcpDispatcher()`): `info` log before and after initialization.
8. **Background job manager init**: `info` with `maxJobs` and `retentionMs`.
9. **Query cache init**: `info` with enabled status and TTL.
10. **Transport connect**: `info` when stdio transport connects.
11. **Server ready**: `info` with `transport: 'stdio'` -- final startup entry.

**Shutdown**: `info` on signal receipt, `info` on server close, then `closeLogger()` flushes and closes the Pino transport.

**Fatal errors**: `fatal` for unrecoverable startup errors, uncaught exceptions, and unhandled rejections.

### 5.2 CLI Startup Sequence

The CLI entry point in `src/cli/index.ts` uses a `preAction` hook for logger initialization:

1. **Node.js version check** (synchronous, pre-Commander): If below minimum, writes directly to `process.stderr` and exits with code 1. This runs before any logger is available.
2. **preAction hook -- Logger init** (first command invocation only):
   - Loads core config via `loadCoreConfig()`.
   - Calls `initCliLogger(cwd, config.logging)` which reads `projectHash` from `project-info.json` synchronously and calls `initLogger()`.
   - Fires `pruneAuditLog()` as fire-and-forget (failures silently caught).
   - Best-effort: if config loading fails, commands still work with the stderr fallback logger.
3. **preAction hook -- Output format resolution**: Resolves `--json`/`--human`/`--quiet` flags.
4. **preAction hook -- Storage migration preflight**: Checks if JSON-to-SQLite migration is needed. Warnings written to `process.stderr` (not Pino) to avoid polluting stdout JSON output. Skipped for `version`, `init`, `self-update`, `upgrade`, and `help` commands.

### 5.3 Install / Scaffold

Scaffold operations in `src/core/scaffold.ts` create the `.cleo/` directory structure including `project-info.json` with `projectHash` and `projectId`. Scaffold runs before the logger is typically initialized (it creates the infrastructure the logger depends on), so scaffold events are not logged to Pino. The `project-info.json` file is the source of truth for `projectHash` used by all subsequent logging.

### 5.4 Upgrade / Migrate

Migration events are logged via both `MigrationLogger` (a migration-specific logger) and Pino `getLogger('migration')` when available. Migration started, completed, and failed events are logged at `info`, `info`, and `error` levels respectively.

---

## 6. Actionable Event Taxonomy

Required events that MUST always be logged:

| Event | Store | Level | Required Fields |
|-------|-------|-------|----------------|
| MCP server starting | Pino | info | `logLevel` |
| MCP dispatch layer initialized | Pino | info | (message only) |
| MCP background job manager initialized | Pino | info | `maxJobs`, `retentionMs` |
| MCP query cache initialized | Pino | info | `enabled`, `ttlMs` |
| MCP server ready | Pino | info | `transport` |
| MCP shutdown signal received | Pino | info | `signal` |
| MCP server closed | Pino | info | `signal` |
| MCP tool call received | Pino | debug | `tool` |
| MCP tool call error | Pino | error | `err` |
| MCP fatal startup error | Pino | fatal | `err` |
| MCP uncaught exception | Pino | fatal | `err`, `errorType` |
| Node.js version unsupported | Pino | fatal | `minimumNodeMajor`, `nodeVersion`, `recommendedUpgrade` |
| Dispatch operation audited | Pino + SQLite | info | `domain`, `operation`, `sessionId`, `taskId`, `gateway`, `success`, `exitCode`, `durationMs` |
| Audit SQLite write failed | Pino | warn | `err` |
| Audit SQLite persist failed | Pino | error | `err` |
| Audit prune completed | Pino | info | `rowsArchived`, `archivePath` (archive) and `rowsDeleted`, `cutoff` (delete) |
| Audit prune skipped (no old rows) | Pino | debug | (message only) |
| Audit prune skipped (retention=0) | Pino | debug | (message only) |
| Audit archive failed | Pino | warn | `err` |
| Audit prune failed | Pino | warn | `err` |
| projectHash missing at init | Pino | warn | (message only) |
| Query cache hit | Pino | debug | `domain`, `operation` |
| Query cache invalidated | Pino | debug | `domain`, `invalidated` |
| Budget enforcement applied | Pino | debug | `estimatedTokens`, `tokenBudget`, `truncated` |
| Global bootstrap warning | Pino | warn | `err`, `errorMessage` |

---

## 7. MCP-First Rules

- MCP operations are the primary logging path. The MCP server calls `initLogger()` at startup with the same Pino configuration as the CLI.
- All MCP tool calls route through the dispatch layer, which includes the `createAudit()` middleware for dual-write to Pino and SQLite.
- MCP stdout is reserved exclusively for the MCP protocol (JSON-RPC). All diagnostic logging MUST go to Pino file sinks or stderr. The `initLogger()` function configures pino-roll to write to `.cleo/logs/cleo.log`, keeping stdout clean.
- Pre-init fallback: Before `initLogger()` is called, `getLogger()` returns a stderr-bound logger at `warn` level. This ensures early startup code and error paths never crash due to missing logger infrastructure.
- No `console.log()` or `console.error()` in post-init paths. Pre-init `console.error()` is acceptable only for the Node.js version check (which runs before any logger is available).

---

## 8. CLI Parity Rules

- CLI startup MUST call `initLogger()` before any operations. This is done in the `preAction` hook via `initCliLogger()` in `src/cli/logger-bootstrap.ts`.
- CLI `preAction` hook MUST fire `pruneAuditLog()` as fire-and-forget after logger initialization. Failures are silently caught to avoid blocking command execution.
- All CLI commands that route through the dispatch layer pass through the same `createAudit()` middleware as MCP, producing identical `audit_log` entries with `source: 'cli'`.
- The `initCliLogger()` function in `src/cli/logger-bootstrap.ts` reads `projectHash` from `project-info.json` synchronously and passes it to `initLogger()`, ensuring CLI log entries have the same correlation context as MCP entries.

---

## 9. Retention Policy

### 9.1 Pino Log Files

| Setting | Config Key | Default | Description |
|---------|-----------|---------|-------------|
| Log level | `logging.level` | `'info'` | Minimum level to record |
| File path | `logging.filePath` | `'logs/cleo.log'` | Relative to `.cleo/` |
| Max file size | `logging.maxFileSize` | 10,485,760 (10 MB) | Triggers size-based rotation |
| Max files | `logging.maxFiles` | 5 | Number of rotated files to retain |
| Rotation frequency | (hardcoded) | `'daily'` | Time-based rotation via pino-roll |
| Date format | (hardcoded) | `'yyyy-MM-dd'` | Suffix for rotated files |

Retention is enforced by pino-roll via `limit.count` with `removeOtherLogFiles: true`. CLEO does not manage log file deletion independently.

### 9.2 SQLite audit_log

| Setting | Config Key | Env Var | Default | Description |
|---------|-----------|---------|---------|-------------|
| Retention days | `logging.auditRetentionDays` | `CLEO_AUDIT_RETENTION_DAYS` | 90 | Days to retain rows before pruning |
| Archive before prune | `logging.archiveBeforePrune` | (none) | `true` | Export rows to gzip JSONL before deletion |

**Archive location**: `.cleo/backups/logs/audit-YYYY-MM-DD.jsonl.gz`

**Archive format**: Gzip-compressed newline-delimited JSON. Each line is a JSON object representing one `audit_log` row with all columns.

**Pruning behavior**:
1. If `auditRetentionDays` is 0 or unset, pruning is skipped entirely.
2. Compute cutoff: `new Date(Date.now() - auditRetentionDays * 86_400_000).toISOString()`.
3. Select rows where `timestamp < cutoff`.
4. If no old rows exist, return early.
5. If `archiveBeforePrune` is true, write selected rows to archive file. Archive failure does NOT prevent deletion (logged at `warn`).
6. Delete rows where `timestamp < cutoff`.
7. Log result at `info` level with `rowsDeleted` and `cutoff`.

**Idempotency**: `pruneAuditLog()` is safe to call multiple times. It never throws -- returns zero counts on any error.

---

## 10. Audit Middleware Details

### 10.1 What Is Audited

The `createAudit()` middleware in `src/dispatch/middleware/audit.ts` audits:

- **All mutate operations**: Every `gateway === 'mutate'` request is audited.
- **Query operations during grade sessions only**: When `CLEO_SESSION_GRADE === 'true'`, query operations are also audited for behavioral analysis.
- **Audit toggle**: If `config.auditLog` is falsy, auditing is disabled entirely.

### 10.2 Write Semantics

- **Pino write**: Immediate, non-blocking `log.info()` call with structured fields.
- **SQLite write (normal mode)**: Fire-and-forget -- `writeToSqlite()` is called without `await`. Failures are caught and logged at `error` level.
- **SQLite write (grade mode)**: Awaited -- ensures the audit row is committed before the response is returned, preventing race conditions with grading queries.

### 10.3 Deduplication Contract

Per ADR-024 section 2.7, every mutation produces exactly one canonical audit record. When both `createAudit()` middleware and `appendLog()` data accessor write entries for the same operation:

| Writer | Authority | Columns |
|--------|-----------|---------|
| `createAudit()` middleware | Dispatch-level events | All 18 columns |
| `appendLog()` data accessor | Task CRUD state diff | Base 8 columns + `before_json` / `after_json` |

The dispatch entry is authoritative. The `appendLog()` entry provides state diffs not captured by dispatch. `request_id` links them.

---

## 11. References

- [ADR-019: Canonical Logging Architecture](.cleo/adrs/ADR-019-canonical-logging-architecture.md) -- original dual-write decision
- [ADR-024: Multi-Store Canonical Logging Architecture](.cleo/adrs/ADR-024-multi-store-canonical-logging.md) -- extensions for MCP init, retention, correlation, and brain.db
- `src/core/logger.ts` -- Pino logger factory (initLogger, getLogger, closeLogger)
- `src/core/audit-prune.ts` -- audit_log retention enforcement (pruneAuditLog)
- `src/core/project-info.ts` -- projectHash/projectId reader (getProjectInfo, getProjectInfoSync)
- `src/dispatch/middleware/audit.ts` -- dual-write audit middleware (createAudit, writeToSqlite, queryAudit)
- `src/cli/logger-bootstrap.ts` -- CLI logger initialization (initCliLogger)
- `src/mcp/index.ts` -- MCP server startup sequence
- `src/cli/index.ts` -- CLI entry point with preAction hooks
- `src/core/config.ts` -- configuration defaults including LoggingConfig
- `src/types/config.ts` -- LoggingConfig type definition
- `src/store/schema.ts` -- audit_log Drizzle schema definition
- T5318 -- implementation epic
- T5309 -- this contract document
