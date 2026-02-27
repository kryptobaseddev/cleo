# ADR-019: Canonical Logging Architecture

**Date**: 2026-02-26
**Status**: accepted
**Supersedes**: Legacy JSON audit file system (T2920, T2929)
**Related ADRs**: ADR-006, ADR-010, ADR-012
**Related Tasks**: T4844, T4837
**Gate**: HITL
**Gate Status**: passed
**Summary**: Establishes Pino + SQLite as the canonical dual-write logging architecture, eliminating the legacy JSON file audit system that was producing unbounded rotated files in `.cleo/`.
**Keywords**: logging, pino, sqlite, audit, structured-logging, rotation, cleanup
**Topics**: logging, audit, infrastructure, observability

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context

CLEO had **three disconnected logging systems** running in parallel:

### 1.1 Legacy JSON File Logger (REMOVED)

`src/dispatch/middleware/audit.ts` (pre-ADR-019) contained a 400+ line JSON file logger that:
- Wrote JSONL entries to `.cleo/audit-log.json` on every MCP mutation
- Rotated files to `audit-log-{timestamp}.json` when exceeding 10MB
- Produced **60+ rotated files** polluting the `.cleo/` directory
- Had a 400-line dead code duplicate at `src/mcp/lib/audit.ts` (zero importers)
- Used custom rotation logic instead of proven rotation libraries

### 1.2 SQLite `audit_log` Table (RETAINED)

Created by T4837 migration, the `audit_log` table in `tasks.db` had:
- 8 base columns (id, timestamp, action, taskId, actor, detailsJson, beforeJson, afterJson)
- 9 dispatch-level columns added by migration `20260225200000_audit-log-dispatch-columns`
- Only written to by `appendLog()` in `sqlite-data-accessor.ts` for task CRUD operations
- The dispatch middleware never wrote to it

### 1.3 Pino Structured Logger (RETAINED)

`src/core/logger.ts` provides a centralized pino logger factory with:
- pino-roll for automatic size + daily rotation with retention
- MCP safety: all output goes to files (stdout reserved for MCP protocol)
- Child loggers via `getLogger(subsystem)` for contextual logging
- Configuration via `CleoConfig.logging` (level, filePath, maxFileSize, maxFiles)

## 2. Decision

### 2.1 Dual-Write Architecture

All dispatch-level audit events MUST be written to both:

1. **Pino structured log** (`subsystem: 'audit'`) — for human-readable debugging and operational monitoring
2. **SQLite `audit_log` table** — for queryable audit trail, session grading, and compliance reporting

### 2.2 Pino as the Structured Logging Layer

Pino is the CANONICAL structured logging system for CLEO.

**Log Levels** (standard pino levels):

| Level | Value | Usage |
|-------|-------|-------|
| `fatal` | 60 | Process-ending errors (DB corruption, unrecoverable state) |
| `error` | 50 | Operation failures that require attention |
| `warn` | 40 | Degraded behavior, fallback paths taken, missing optional config |
| `info` | 30 | Normal operations: audit entries, lifecycle transitions, session events |
| `debug` | 20 | Detailed operation flow for debugging |
| `trace` | 10 | Fine-grained tracing (parameter values, SQL queries) |
| `silent` | ∞ | Logging disabled |

**Configuration** (`CleoConfig.logging`):

```typescript
interface LoggingConfig {
  level: LogLevel;      // Default: 'info'
  filePath: string;     // Default: 'logs/cleo.log' (relative to .cleo/)
  maxFileSize: number;  // Default: 10MB
  maxFiles: number;     // Default: 5
}
```

**Environment overrides**: `CLEO_LOG_LEVEL`, `CLEO_LOG_FILE`

**Child logger subsystems** (as of ADR-019):

| Subsystem | Location | Purpose |
|-----------|----------|---------|
| `audit` | `src/dispatch/middleware/audit.ts` | Dispatch audit trail |
| `engine` | `src/dispatch/engines/_error.ts` | Engine error handling |
| `data-safety` | `src/store/safety-data-accessor.ts`, `data-safety-central.ts`, `data-safety.ts` | Atomic write safety |
| `domain:tasks` | `src/dispatch/domains/tasks.ts` | Task domain operations |
| `domain:session` | `src/dispatch/domains/session.ts` | Session domain operations |
| `domain:orchestrate` | `src/dispatch/domains/orchestrate.ts` | Orchestration operations |
| `domain:pipeline` | `src/dispatch/domains/pipeline.ts` | Lifecycle pipeline operations |
| `domain:admin` | `src/dispatch/domains/admin.ts` | Admin operations |
| `domain:check` | `src/dispatch/domains/check.ts` | Validation checks |
| `domain:memory` | `src/dispatch/domains/memory.ts` | Memory operations |
| `domain:nexus` | `src/dispatch/domains/nexus.ts` | Nexus registry operations |
| `domain:tools` | `src/dispatch/domains/tools.ts` | Tool/skill operations |
| `domain:sharing` | `src/dispatch/domains/sharing.ts` | Sharing operations |

### 2.3 SQLite as the Queryable Audit Layer

The `audit_log` table is the CANONICAL queryable audit store.

**Schema** (`src/store/schema.ts`):

| Column | Type | Source | Purpose |
|--------|------|--------|---------|
| `id` | TEXT PK | Generated UUID | Unique entry ID |
| `timestamp` | TEXT | ISO-8601 | When the operation occurred |
| `action` | TEXT | operation name | Legacy action name (backward compat) |
| `task_id` | TEXT | params.taskId | Affected task (or 'system') |
| `actor` | TEXT | 'agent'/'system' | Who performed the operation |
| `details_json` | TEXT | JSON(params) | Operation parameters |
| `before_json` | TEXT | JSON(before) | State before mutation |
| `after_json` | TEXT | JSON(after) | State after mutation |
| `domain` | TEXT | req.domain | Dispatch domain |
| `operation` | TEXT | req.operation | Dispatch operation |
| `session_id` | TEXT | session ID | Active session |
| `request_id` | TEXT | req.requestId | Dispatch request correlation ID |
| `duration_ms` | INTEGER | timing | Operation duration |
| `success` | INTEGER | 0/1 | Whether operation succeeded |
| `source` | TEXT | 'mcp'/'cli' | Entry point |
| `gateway` | TEXT | 'cleo_mutate'/'cleo_query' | MCP gateway used |
| `error_message` | TEXT | error.message | Error details if failed |

**Indexes**: task_id, action, timestamp, domain, request_id

**Two write paths to SQLite**:

1. **Dispatch middleware** (`createAudit()`) — writes ALL dispatch columns for every audited MCP operation
2. **Data accessor** (`appendLog()`) — writes base columns for task CRUD operations from `src/core/tasks/`

**Read paths**:

1. `queryAudit()` in `src/dispatch/middleware/audit.ts` — used by session grading
2. `systemLog()` in `src/dispatch/engines/system-engine.ts` — used by `system.log` operation (SQLite primary, JSONL fallback for pre-migration installs)

### 2.4 Audit Scope

| Gateway | Audited | Condition |
|---------|---------|-----------|
| `cleo_mutate` | Always | All write operations |
| `cleo_query` | Conditional | Only when session grade mode is active |

Grade mode is activated by `CLEO_SESSION_GRADE=true` or session `gradeMode: true` in SQLite.

### 2.5 JSON File Logging is REMOVED

The following are explicitly **NOT part of the canonical logging system**:

- `.cleo/audit-log.json` (JSONL append file)
- `.cleo/audit-log-{timestamp}.json` (rotated files)
- `.cleo/audit-log-archive-{date}.json` (archived files)
- `src/mcp/lib/audit.ts` (dead code duplicate)

The `system.log` operation in `system-engine.ts` retains a JSONL fallback read path for backward compatibility with pre-migration installs. This fallback SHOULD be removed in a future version.

## 3. Consequences

### Positive

- **No more file pollution**: Eliminates 60+ rotated JSON files from `.cleo/`
- **Queryable audit trail**: Session grading can filter by sessionId, domain, operation via SQL
- **Structured logging**: Pino provides consistent JSON log format with levels, timestamps, subsystems
- **Automatic rotation**: pino-roll handles size + daily rotation with configurable retention
- **MCP safe**: All diagnostic output goes to files, stdout reserved for MCP protocol
- **Single source of truth**: One audit table, one logger factory, no duplicates

### Negative

- **SQLite dependency**: Audit writing requires SQLite availability (graceful fallback to Pino-only if unavailable)
- **Migration required**: Pre-existing installs need to run drizzle migrations for dispatch columns

### Neutral

- **Task CRUD audit path unchanged**: `appendLog()` in data-accessor continues to write base columns for task operations. The dispatch middleware adds dispatch-level columns for the same operations when they flow through MCP.

## 4. Compliance

- All new logging MUST use `getLogger(subsystem)` from `src/core/logger.ts`
- All new audit-worthy operations MUST flow through the dispatch pipeline (which includes `createAudit()`)
- Direct file writes for audit purposes are PROHIBITED
- Log levels MUST follow the table in section 2.2
- Child logger subsystem names MUST follow the `domain:{name}` convention for dispatch domains

## 5. Migration Notes

### For existing installs

1. Run drizzle migrations to ensure `audit_log` table has dispatch columns
2. Delete stale `audit-log-*.json` files: `ct cleanup logs` or manually `rm .cleo/audit-log*.json`
3. The `.cleo/.gitignore` already includes `audit-log-*.json` patterns as a safety net

### For new installs

No action needed — the audit_log table is created by drizzle migrations and the Pino logger initializes on startup.
