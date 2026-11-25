# CLEO Production Runtime Logging Contract

**Version**: 2026.03.05 (store names and code paths updated to the current source)
**Status**: APPROVED
**Related ADRs**: ADR-019, ADR-024

---

## 1. Overview

CLEO uses a two-store logging architecture that separates operational diagnostics from structured audit trails:

1. **Pino structured logs**: operational events, startup lifecycle, warnings and debug traces, written in-thread (no worker thread) to rotating log files.
2. **SQLite audit log**: every audited dispatch operation, written to the `tasks_audit_log` table in the project store `<project>/.cleo/cleo.db`.

Both stores share a common set of correlation fields (`projectHash`, `requestId`, `sessionId`, `taskId`) that let entries in one be matched to entries in the other. The dual-write principle is established in ADR-019 and extended by ADR-024.

The audit middleware is mounted on the CLI dispatcher (`packages/cleo/src/dispatch/adapters/cli.ts`). The `source` column records where a request came from. The allowed values are `GATEWAY_SOURCES` in `packages/contracts/src/gateway/index.ts` (`cli`, `mcp`, `rpc`, `http`). Requests built by the CLI adapter carry `'cli'`.

Separate from both stores, the CLI output contract (ADR-086) puts exactly one LAFS envelope on stdout per call. All logs and progress go to stderr or to the log files.

> Every CLI call except `--help`/`--version` starts the Pino file sink in §2.1 once, inside a project (§5.1, §8). Outside a project, Pino output goes to the stderr fallback logger, which drops everything below `warn`.

---

## 2. Store Boundaries and Ownership

### 2.1 Pino Structured Logs (File Sink)

**What goes here**: Operational events, debug traces, startup/shutdown lifecycle, warnings, error diagnostics, cache decisions, migration progress, and any non-audit diagnostic output.

**Where written**: `initLogger(cleoDir, config, projectHash)` writes to `join(cleoDir, config.filePath)`; the default is `.cleo/logs/cleo.log`, written as files named `cleo.<yyyy-MM-dd>.<n>.log`. `rotateLogAtStartup()` picks the file once per process: today's newest file until it reaches `maxFileSize`, then the next `<n>`; a new day starts at 1. Lines go through `pino.destination` (sonic-boom) in the calling thread, with no transport worker; pino's exit hook flushes buffered lines on a normal exit and `closeLogger()` flushes and closes the file at teardown. Before `initLogger()` runs, `getLogger()` returns a fallback logger that writes to stderr (fd 2) at `warn`, or at `silent` when `--quiet` set `setLoggerQuiet(true)`.

**Retention**: `rotateLogAtStartup()` keeps `maxFiles` (default 5) older `cleo.*` files besides the active one and deletes the rest, at startup.

**Owner**: `packages/core/src/logger.ts`, which provides `initLogger()`, `getLogger()`, `getLogDir()`, `closeLogger()`, `setLoggerQuiet()` and `isLoggerQuiet()`. Read access to log files lives in `packages/core/src/observability/` (`discoverLogFiles`, `getProjectLogDir`, `getGlobalLogDir`, which is `<cleoHome>/logs`).

**Format**: Newline-delimited JSON (NDJSON). Each line is a Pino JSON object with an uppercase level label and an ISO-8601 timestamp. The root logger's `base` adds `platform`, `arch`, `nodeVersion` and, when known, `projectHash` to every entry; each child logger adds `subsystem`. Example:

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

### 2.2 SQLite audit log (`tasks_audit_log` in the project `cleo.db`)

**What goes here**: Every audited dispatch operation: mutations always, queries only in grade mode (§10.1). Since T13777 the dispatch audit writes `tasks_audit_log`. Rows an older build writes to the bare `audit_log` table are drained into it when the store opens. The table syncs.

**Columns** (from `packages/core/src/store/schema/cleo-project/audit.ts`):

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID per entry (`crypto.randomUUID()`) |
| `timestamp` | TEXT NOT NULL | ISO-8601 timestamp of operation completion |
| `action` | TEXT NOT NULL | Operation name (legacy column; the middleware writes the operation) |
| `task_id` | TEXT NOT NULL | Affected task ID, or `'system'` for non-task ops |
| `actor` | TEXT NOT NULL | Actor identity. Column default `'system'`; the dispatch middleware writes `'agent'` when no user id is known |
| `details_json` | TEXT | JSON-serialized request parameters (redacted column) |
| `before_json` | TEXT | Pre-operation state snapshot (from `appendLog()`; redacted column) |
| `after_json` | TEXT | Post-operation state (from `appendLog()`); for a dispatch row with an idempotency key, the response envelope (redacted column) |
| `domain` | TEXT | Dispatch domain (e.g. `'tasks'`, `'session'`, `'memory'`) |
| `operation` | TEXT | Dispatch operation (e.g. `'add'`, `'complete'`, `'find'`) |
| `session_id` | TEXT | Active session ID (NULL if no session) |
| `request_id` | TEXT | Per-request id from the dispatch layer |
| `idempotency_key` | TEXT | Caller-supplied idempotency key; UNIQUE together with `project_hash`, `domain` and `operation` |
| `duration_ms` | INTEGER | Operation duration in milliseconds |
| `success` | INTEGER | 1 for success, 0 for failure |
| `source` | TEXT | Request origin (§1) |
| `gateway` | TEXT | `'mutate'` or `'query'` |
| `error_message` | TEXT | Error message on failure, NULL on success (redacted column) |
| `project_hash` | TEXT | 12-char SHA-256 hex of the project root path |
| `uid` | TEXT | Row uid (UUIDv8 over the audit id), unique |
| `dispatch_idempotency_key` | TEXT | A dispatch request's idempotency key; not unique (a failed attempt and its retry both record a row) |

**Indexes**: `task_id`, `action`, `timestamp`, `domain`, `request_id`, `idempotency_key`, `project_hash`, `actor`, `(session_id, timestamp)`, `(domain, operation)`, `(project_hash, domain, operation, dispatch_idempotency_key)`, and unique `uid`.

**Retention**: `pruneAuditLog()` in `packages/core/src/audit-prune.ts` (§9.2).

**Owner**: `packages/cleo/src/dispatch/middleware/audit.ts` (write path, `createAudit()`) and `packages/core/src/audit-prune.ts` (retention).

### 2.3 Store Boundary Rules

- Operational/debug log events MUST NOT be written to the audit log. The audit store captures dispatch operations only.
- Dispatch operation audit events MUST be written to both Pino (immediate structured log) and SQLite (persistent audit trail). This is the dual-write contract from ADR-019.
- The `brain_*` tables are a cognitive memory store, NOT a logging store. Memory writes that route through dispatch are audit-logged to `tasks_audit_log` with `domain='memory'`.
- Cross-project NEXUS operations have their own `nexus_audit_log` table in the global `<cleoHome>/cleo.db` (ADR-024 §2.6). It is not a dispatch audit store.

---

## 3. Correlation Fields

Every log entry (both stores) MUST include the following correlation fields where available:

| Field | Pino Binding | Audit column | Source | Availability |
|-------|-------------|--------------|--------|-------------|
| `projectHash` | Root logger `base` object (inherited by all children) | `project_hash` | `project-info.json` via `getProjectInfoSync()` | Always (warn if absent) |
| `requestId` | — (not bound on the Pino audit entry) | `request_id` | `req.requestId` from the dispatch layer | Dispatch operations only |
| `sessionId` | Field on the audit entry | `session_id` | `req.sessionId` from the session-resolver middleware; fallback described below | When a session is active |
| `taskId` | Field on the audit entry | `task_id` | `req.params.taskId` or `req.params.parent` | When the operation is task-scoped |

### How Each Is Populated

**projectHash**: Read from `.cleo/project-info.json` via `getProjectInfoSync()`. For Pino, `initLogger()` binds it to the root logger's `base` object, so every child logger inherits it. For the audit log, `writeToSqlite()` resolves it through a cached `resolveProjectHash()`. The value is `generateProjectHash()` (`packages/core/src/nexus/hash.ts`): the first 12 hex characters of `SHA-256(projectRootPath)`, written by scaffold.

**requestId**: Assigned by the dispatch layer per request and passed to `writeToSqlite()` by the audit middleware. It links an `appendLog()` row to its dispatch row (§10.3).

**sessionId**: Populated by the session-resolver middleware (`req.sessionId`) before the audit middleware runs. When it is missing, the middleware uses `CLEO_SESSION_GRADE_ID` (in grade mode), then the env-first resolver `resolveSessionIdFromEnv()`.

**taskId**: Taken from `params.taskId` or `params.parent` by the audit middleware. Set to `'system'` when no task is in scope.

---

## 4. Level Policy

| Level | Numeric | When to Use | Example |
|-------|---------|-------------|---------|
| `fatal` | 60 | Process-ending errors that require immediate termination | DB corruption, unrecoverable bootstrap failure |
| `error` | 50 | Operation failures requiring attention but not process termination | Engine errors, unhandled exceptions caught at the top level, a failed startup migration |
| `warn` | 40 | Degraded behavior where a fallback was taken or optional config is missing | `projectHash` not provided to `initLogger()`, audit archive failure (deletion continues), automatic audit prune failure, audit SQLite write failure |
| `info` | 30 | Normal operational events worth recording | Audit entries (dual-write), audit prune completed with row counts, global-salt fingerprint at startup |
| `debug` | 20 | Detailed operation flow useful for troubleshooting | Prune skipped, migration check skipped with no project |
| `trace` | 10 | Fine-grained tracing for deep debugging | SQL queries, middleware chain execution steps |

**Default level**: `info` (`logging.level` in config, or the `CLEO_LOG_LEVEL` env var). The stderr fallback logger ignores this setting and runs at `warn`.

---

## 5. Startup / Install / Upgrade Coverage

### 5.1 CLI Startup Sequence

The CLI entry point `packages/cleo/src/cli/index.ts` runs:

1. **Node.js version check**: `enforceNodeVersion()` (`packages/paths/src/node-version-gate.ts`) runs at module load. Below the floor it prints upgrade guidance to stderr and exits 1. No logger is involved.
2. **Fast path**: `--version` and `--help` return before any startup maintenance.
3. **Quiet mode**: with `--quiet`, `setLoggerQuiet(true)` silences the fallback logger before startup maintenance.
4. **Startup maintenance** (`runStartupMaintenance`), through `getLogger('cli-startup')`: one-shot legacy-file cleanup, the signaldock-to-conduit migration check (`error` on failure, `warn` if the check throws, `debug` when there is no project), and the global-salt check (`info` fingerprint, `warn` on failure).

Before quiet mode and startup maintenance, `startCliFileLogger()` in `packages/cleo/src/cli/index.ts` starts the file logger: it resolves the project root and `.cleo/` directory (nothing starts outside a project), reads `projectHash` with `getProjectInfoSync()`, and calls `startFileLogger(cleoDir, projectHash)` (`packages/core/src/logger.ts`), which reads the `logging` settings with `resolveLoggerConfig()` and calls `initLogger()` unless a logger is already running. It never fails the command. Because it runs first, `--quiet` still silences the file logger.

### 5.2 Install / Scaffold

Scaffold (`packages/core/src/scaffold.ts`) creates the `.cleo/` directory structure, including `logs/` (`REQUIRED_CLEO_SUBDIRS` in `packages/core/src/scaffold/ensure-dirs.ts`) and `project-info.json` with `projectHash` and `projectId`. Scaffold events are not logged to Pino. `project-info.json` is the source of `projectHash` for all later logging.

### 5.3 Upgrade / Migrate

Migration events are written by `MigrationLogger` (`packages/core/src/migration/logger.ts`) as JSONL to `.cleo/logs/migration-<timestamp>.jsonl`, with levels `info`, `warn`, `error` and `debug`.

---

## 6. Actionable Event Taxonomy

Required events that MUST always be logged. "Emitter" names the code that logs the event today; rows marked **none** are required by this contract but no emitter was found in `packages/cleo/src`, `packages/core/src` or `packages/runtime/src`.

| Event | Store | Level | Required Fields | Emitter |
|-------|-------|-------|----------------|---------|
| Dispatch operation audited | Pino + SQLite | info | `domain`, `operation`, `sessionId`, `taskId`, `gateway`, `success`, `exitCode`, `durationMs` (plus `idempotencyKey` when given) | `dispatch/middleware/audit.ts` |
| Audit payload failed validation | Pino | warn | `issues` | `dispatch/middleware/audit.ts` |
| Audit SQLite write failed | Pino | warn | `err` | `dispatch/middleware/audit.ts` |
| Audit prune completed | Pino | info | `rowsArchived`, `archivePath` (archive) and `rowsDeleted`, `cutoff` (delete) | `core/audit-prune.ts` |
| Audit prune skipped (no old rows) | Pino | debug | (message only) | `core/audit-prune.ts` |
| Audit prune skipped (retention=0) | Pino | debug | (message only) | `core/audit-prune.ts` |
| Audit archive failed | Pino | warn | `err` | `core/audit-prune.ts` |
| Audit prune failed | Pino | warn | `err` | `core/audit-prune.ts` |
| Automatic audit prune failed | Pino | warn | `err`, `projectRoot` | `core/audit-prune.ts` |
| projectHash missing at init | Pino | warn | (message only) | `core/logger.ts` |
| Startup migration failed | Pino | error | `errors`, `projectRoot` | `cli/index.ts` |
| Global-salt fingerprint | Pino | info | `fingerprint` | `cli/index.ts` |
| Node.js version unsupported | stderr | — | upgrade guidance | `paths/node-version-gate.ts` |
| CLI logger initialized | Pino | info | `logLevel` | none |
| CLI dispatch layer initialized | Pino | info | (message only) | none |
| CLI background job manager initialized | Pino | info | `maxJobs`, `retentionMs` | none |
| CLI query cache initialized | Pino | info | `enabled`, `ttlMs` | none |
| CLI command received | Pino | debug | `command` | none |
| CLI command error | Pino | error | `err` | none |
| CLI fatal startup error | Pino | fatal | `err` | none |
| CLI uncaught exception | Pino | fatal | `err`, `errorType` | none |
| Audit SQLite persist failed | Pino | error | `err` | none (write failures log at `warn`) |
| Query cache hit | Pino | debug | `domain`, `operation` | none |
| Query cache invalidated | Pino | debug | `domain`, `invalidated` | none |
| Budget enforcement applied | Pino | debug | `estimatedTokens`, `tokenBudget`, `truncated` | none |
| Global bootstrap warning | Pino | warn | `err`, `errorMessage` | none |

---

## 7. CLI Logging Rules

- All CLI commands that dispatch go through the CLI dispatcher, whose middleware chain includes `createAudit()` for the Pino + SQLite dual-write.
- CLI stdout is reserved for command output: one LAFS envelope per call, or a human render with `--human` (ADR-086). All diagnostic logging MUST go to the Pino file sink or stderr.
- CLI startup MUST initialize the file logger before dispatching (`startFileLogger()` → `initLogger()`, §5.1).
- Pre-init fallback: before `initLogger()` is called, `getLogger()` returns a stderr-bound logger at `warn` (`silent` under `--quiet`), so early startup code and error paths never crash for lack of a logger.
- No `console.log()` or `console.error()` in post-init paths. The Node.js version check writes to stderr directly because it runs before any logger exists.

---

## 8. CLI Initialization Rules

- `startCliFileLogger()` in `packages/cleo/src/cli/index.ts` reads `projectHash` from `project-info.json` synchronously and passes it to `startFileLogger(cleoDir, projectHash)`, so every log entry carries the correlation context. It runs once per process, before any operation.
- `resolveLoggerConfig(cleoDir)` resolves the logging settings in the same order as `loadConfig()`: defaults, global `config.json` `logging`, project `pinoLogging` then `logging`, then `CLEO_LOG_LEVEL` / `CLEO_LOG_FILE`. It reads only the two JSON files, so CLI startup loads no extra modules for it.
- CLI commands dispatch through `packages/cleo/src/dispatch/adapters/cli.ts` (`getCliDispatcher()`, `dispatchRaw()`), which applies `createAudit()` and writes rows with `source: 'cli'`.

---

## 9. Retention Policy

### 9.1 Pino Log Files

| Setting | Config Key | Default | Description |
|---------|-----------|---------|-------------|
| Log level | `logging.level` | `'info'` | Minimum level to record (env `CLEO_LOG_LEVEL`) |
| File path | `logging.filePath` | `'logs/cleo.log'` | Relative to `.cleo/` |
| Max file size | `logging.maxFileSize` | 10,485,760 (10 MB) | Triggers size-based rotation |
| Max files | `logging.maxFiles` | 5 | Number of rotated files to retain |
| Rotation frequency | (hardcoded) | daily | Checked once per process at startup (`rotateLogAtStartup()`) |
| Date format | (hardcoded) | `'yyyy-MM-dd'` | Date part of rotated file names |

Defaults are in `packages/core/src/config.ts` and `LOGGER_CONFIG_DEFAULTS` in `packages/core/src/logger.ts` (a test keeps them equal). Rotation and retention run at startup in `rotateLogAtStartup()`; a long-running process keeps the file it opened.

### 9.2 SQLite audit log

| Setting | Config Key | Env Var | Default | Description |
|---------|-----------|---------|---------|-------------|
| Retention days | `logging.auditRetentionDays` | `CLEO_AUDIT_RETENTION_DAYS` | 90 | Days to retain rows before pruning; values below 30 are raised to 30 |
| Archive before prune | `logging.archiveBeforePrune` | (none) | `true` | Export rows to gzip JSONL before deletion |

**Archive location**: `.cleo/backups/logs/audit-YYYY-MM-DD.jsonl.gz`

**Archive format**: Gzip-compressed newline-delimited JSON, one audit row per line with all columns.

**Pruning behavior**:
1. If `auditRetentionDays` is 0 or unset, pruning is skipped.
2. Compute the cutoff from `max(auditRetentionDays, AUDIT_RETENTION_FLOOR_DAYS)` (floor 30). Pruned rows sync, so the delete reaches every device; the floor keeps one device set to a short retention from erasing everyone's recent history.
3. Select prunable rows: `timestamp < cutoff`, excluding the receipt actions in `AUDIT_PRUNE_EXEMPT_ACTIONS` (`ac.bindings.pruned`, `saga_reconciled`, `ranking_changed`) and `gate.verify.typed` rows of tasks that are not done or cancelled.
4. If there are none, return early.
5. If `archiveBeforePrune` is true, write the selected rows to the archive file. Archive failure does NOT prevent deletion (logged at `warn`).
6. Delete the same rows.
7. Log the result at `info` with `rowsDeleted` and `cutoff`.

**Idempotency**: `pruneAuditLog()` is safe to call repeatedly. It never throws; it returns zero counts on any error.

**When it runs** (T13828):
- Automatically at session end, after the session-end snapshot, through `autoPruneAuditLog()`: at most once a day per project, stamped in `.cleo/logs/audit-prune.last`.
- On demand with `cleo admin cleanup --target logs`.

Both apply the same retention days, the 30-day floor and the receipt exemptions.

---

## 10. Audit Middleware Details

### 10.1 What Is Audited

`createAudit()` in `packages/cleo/src/dispatch/middleware/audit.ts` audits:

- **All mutate operations**: every `gateway === 'mutate'` request.
- **Query operations in grade mode only**: when `CLEO_SESSION_GRADE === 'true'`, or when the caller's bound session has `gradeMode` set.
- **Audit toggle**: if the dispatch config's `auditLog` is false, auditing is off. It defaults to `true` (`packages/cleo/src/dispatch/lib/defaults.ts`).

### 10.2 Write Semantics

- **Pino write**: one `log.info()` call with the structured fields in §6, message `"<gateway> <domain>.<operation>"`.
- **SQLite write**: awaited in every mode, so the row exists before the response leaves the dispatcher (T13164). The payload is checked against `AuditLogInsertSchema` first; a validation failure or a write failure is logged at `warn` and never thrown.

### 10.3 Deduplication Contract

Per ADR-024 §2.7, every mutation produces exactly one canonical audit record. When both the `createAudit()` middleware and the `appendLog()` data accessor (`packages/core/src/store/sqlite-data-accessor.ts`) write rows for the same operation:

| Writer | Authority | Columns written |
|--------|-----------|-----------------|
| `createAudit()` middleware | Dispatch-level events | All dispatch columns (§2.2) except `before_json`, `idempotency_key`, `uid` |
| `appendLog()` data accessor | Task CRUD state diff | `id`, `timestamp`, `action`, `task_id`, `actor`, `details_json`, `before_json`, `after_json`, `session_id` |

The dispatch entry is authoritative; the `appendLog()` entry adds the state diff. `appendLog()` does not write `request_id`, so the two rows are not joined by that column.

---

## 11. Other diagnostic stores

- **Telemetry** (opt-in, off by default; `cleo diagnostics enable`): the dispatch `createTelemetry()` middleware records shape, timing and exit code (no params or output) to `telemetry_events` in the global `<cleoHome>/cleo.db`. Opt-in state is kept in `<cleoHome>/telemetry-config.json` (`packages/core/src/telemetry/index.ts`). Telemetry is not part of the logging contract.
- **Studio actions**: CLEO Studio appends its admin actions to `<project>/.cleo/audit/studio-actions.jsonl` (`packages/studio/src/lib/server/audit-log.ts`).

---

## 12. Known gaps

T14605 fixed the uninitialized file logger (CLI startup now starts it, §5.1) and the stale "preAction hook" comment in `packages/runtime/src/gateway/engine-error.ts`.

1. **Required events with no emitter.** The §6 rows marked **none**.
2. **Stale comment.** The header of `packages/cleo/src/dispatch/middleware/audit.ts` still names `.cleo/tasks.db`.
3. **Health check path.** `cleo doctor`'s `log_file` check looks for the configured path itself (`.cleo/logs/cleo.log`), but the logger writes the dated `cleo.<yyyy-MM-dd>.<n>.log` files, so the check warns even when logs are written.

---

## 13. References

- [ADR-019: Canonical Logging Architecture](../adr/adr-019-canonical-logging-architecture.md): original dual-write decision
- [ADR-024: Multi-Store Canonical Logging Architecture](../adr/adr-024-multi-store-canonical-logging.md): extensions for CLI init, retention, correlation and memory
- [ADR-086: CLI Output Contract](../adr/adr-086-cli-output-contract-e9.md): one envelope on stdout, logs on stderr
- `packages/core/src/logger.ts`: Pino logger factory (`initLogger`, `startFileLogger`, `resolveLoggerConfig`, `rotateLogAtStartup`, `getLogger`, `closeLogger`, `setLoggerQuiet`)
- `packages/core/src/observability/`: log-file discovery and reading
- `packages/core/src/audit-prune.ts`: audit retention (`pruneAuditLog`, `autoPruneAuditLog`)
- `packages/core/src/project-info.ts`: `projectHash`/`projectId` reader (`getProjectInfoSync`)
- `packages/core/src/config.ts`: logging defaults and env mapping
- `packages/contracts/src/logger.ts` (`LoggerConfig`), `packages/contracts/src/config/types.ts` (`LoggingConfig`)
- `packages/core/src/store/schema/cleo-project/audit.ts`: `tasks_audit_log` schema
- `packages/cleo/src/dispatch/adapters/cli.ts`: CLI dispatcher and middleware chain
- `packages/cleo/src/dispatch/middleware/audit.ts`: dual-write audit middleware (`createAudit`, `writeToSqlite`)
- `packages/cleo/src/cli/index.ts`: CLI entry point, `startCliFileLogger` and startup maintenance

