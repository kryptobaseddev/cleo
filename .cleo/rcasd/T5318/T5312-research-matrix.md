# T5312 Research Matrix: CLEO Runtime Logging Architecture

**Task**: T5312 — R: Research runtime logging architecture across tasks/brain/nexus
**Epic**: T5284
**Package**: T5318 (Stream B)
**Status**: COMPLETE
**Date**: 2026-03-04

---

## 1. Channel Inventory (What Exists Today)

### 1.1 Channel A: Pino Structured Logger (`src/core/logger.ts`)

| Attribute | Value |
|-----------|-------|
| **Library** | `pino` + `pino-roll` transport |
| **Init location** | `src/cli/index.ts` preAction hook (`initLogger()`) |
| **MCP init** | NOT initialized in MCP startup — MCP uses `console.error` for startup messages; Pino only initialized when CLI runs |
| **Output** | `.cleo/logs/cleo.YYYY-MM-DD.N.log` (JSONL per line) |
| **Rotation** | `pino-roll`: size-based (10MB default) + daily, keeps 5 files |
| **Fallback** | `stderr` logger if `initLogger()` not called (safe for MCP) |
| **API** | `getLogger(subsystem)` → child logger |
| **Subsystems in use** | `audit`, `engine`, `data-safety`, `domain:tasks`, `domain:session`, `domain:orchestrate`, `domain:pipeline`, `domain:admin`, `domain:check`, `domain:memory`, `domain:nexus`, `domain:tools`, `domain:sharing`, `domain:sticky` |

**Usage pattern**: All domain handlers call `getLogger('domain:X').error(...)` in their error handlers only. The `audit` subsystem is the primary writer (every audited dispatch operation).

### 1.2 Channel B: SQLite `audit_log` Table (`tasks.db`)

| Attribute | Value |
|-----------|-------|
| **Table** | `audit_log` in `.cleo/tasks.db` |
| **Schema** | 17 columns: id, timestamp, action, task_id, actor, details_json, before_json, after_json, domain, operation, session_id, request_id, duration_ms, success, source, gateway, error_message |
| **Indexes** | task_id, action, timestamp, domain, request_id |
| **Write path 1** | `createAudit()` middleware — all `cleo_mutate` ops + grade-session `cleo_query` ops |
| **Write path 2** | `appendLog()` in `sqlite-data-accessor.ts` — task CRUD base columns only (id, timestamp, action, task_id, actor, details_json, before_json, after_json) |
| **Write path 3** | `src/core/tasks/add.ts` — calls `accessor.appendLog()` directly for add/update/complete events |
| **Read paths** | `queryAudit()` (session grading), `systemLog()` (admin.log operation), `coreTaskHistory()` reads JSONL fallback NOT SQLite |
| **Retention** | Unbounded (no TTL or pruning implemented) |

**Gap**: `coreTaskHistory()` in `task-ops.ts` still reads from `tasks-log.jsonl` file, NOT from `audit_log` SQLite table.

### 1.3 Channel C: Legacy JSONL Files (PARTIALLY ACTIVE)

| File | Status | Still Written? | Still Read? |
|------|--------|----------------|-------------|
| `.cleo/tasks-log.jsonl` | Legacy | NO (post-SQLite migration) | YES — `coreTaskHistory()`, `systemLog()` fallback |
| `.cleo/todo-log.jsonl` | Legacy | NO | YES — `health.ts` check, `upgrade.ts` migration path, `systemLog()` fallback |
| `.cleo/audit-log.json` | REMOVED per ADR-019 | NO | NO (removed) |
| `.cleo/audit-log-*.json` | REMOVED per ADR-019 | NO | NO (removed) |

**Gap**: `src/core/system/health.ts:114` checks for `todo-log.jsonl` presence as a health indicator — this is stale.

### 1.4 Channel D: Migration Logger (`src/core/migration/logger.ts`)

| Attribute | Value |
|-----------|-------|
| **File** | `.cleo/logs/migration-{ISO-timestamp}.jsonl` |
| **Format** | Custom JSONL (not pino — bespoke `MigrationLogger` class) |
| **Retention** | Last 10 files (configured in class) |
| **Scope** | Migration operations only (not operational logging) |
| **Discoverable?** | YES via `discoverLogFiles(opts, { includeMigration: true })` |

### 1.5 Channel E: MCP Startup `console.error` (Unstructured)

| Attribute | Value |
|-----------|-------|
| **Location** | `src/mcp/index.ts` |
| **Target** | `stderr` |
| **Format** | Unstructured strings |
| **Content** | Server startup, config load, tool calls, cache hits, errors |
| **Retention** | None (process lifetime only) |

**Gap**: MCP never calls `initLogger()`, so all MCP runtime diagnostics go to unstructured `stderr`. The Pino logger singleton is null during MCP operation; only the `stderr` fallback is used.

### 1.6 Channel F: brain.db (NO Logging Tables)

brain.db schema (`src/store/brain-schema.ts`) contains:
- `brain_decisions`, `brain_patterns`, `brain_learnings`, `brain_observations`, `brain_memory_links`, `brain_schema_meta`

**No audit_log equivalent exists in brain.db.** Operations on brain.db are NOT audit-logged to any structured store.

### 1.7 Channel G: nexus.db (NOT YET IMPLEMENTED)

nexus domain handler (`src/dispatch/domains/nexus.ts`) is a partial stub. No nexus.db exists. No logging architecture applies.

---

## 2. Write Path Map

```
CLI invocation
  └─> initLogger() called [Channel A initialized]
  └─> Dispatch pipeline runs
        └─> Middleware: createAudit()
              ├─> Pino log: subsystem='audit' [Channel A]
              └─> SQLite insert: audit_log table [Channel B]
        └─> Domain handler executes
              └─> getLogger('domain:X').error() on failure [Channel A]
  └─> core/tasks/add.ts
        └─> accessor.appendLog() [Channel B — base columns only]

MCP invocation
  └─> initLogger() NOT called [Channel A = stderr fallback]
  └─> console.error() startup messages [Channel E]
  └─> Dispatch pipeline runs (same as CLI)
        └─> Middleware: createAudit()
              ├─> Pino log: subsystem='audit' → stderr fallback [Channel A degraded]
              └─> SQLite insert: audit_log table [Channel B — still works]

brain.db operations
  └─> No audit logging [Gap]

Migrations
  └─> MigrationLogger writes to .cleo/logs/migration-*.jsonl [Channel D]
```

---

## 3. Level Taxonomy (Current)

Per ADR-019 §2.2:

| Level | Numeric | Current Usage |
|-------|---------|---------------|
| `fatal` | 60 | Defined but no usages found in codebase |
| `error` | 50 | Domain handler error paths, engine errors |
| `warn` | 40 | Audit SQLite write failures, session context conflicts |
| `info` | 30 | Audit entries (primary), lifecycle transitions |
| `debug` | 20 | Not used in production paths |
| `trace` | 10 | Not used |

**Gap**: No `requestId`, `sessionId`, `taskId`, `projectHash`, `domain`, `operation`, `source`, `gateway`, or `duration` fields are included in Pino log calls outside of the audit middleware. Domain handler error logs only include `{err}` field.

---

## 4. Correlation Fields (Current State vs. Required)

| Field | audit_log (SQLite) | Pino audit log | Domain error logs | Required by SN-006 |
|-------|-------------------|----------------|-------------------|--------------------|
| `requestId` | ✅ | ❌ | ❌ | YES |
| `sessionId` | ✅ | ✅ (partial) | ❌ | YES |
| `taskId` | ✅ | ✅ (partial) | ❌ | YES |
| `projectHash` | ❌ | ❌ | ❌ | YES |
| `domain` | ✅ | ✅ | ❌ | YES |
| `operation` | ✅ | ✅ | ❌ | YES |
| `source` | ✅ | ❌ | ❌ | YES |
| `gateway` | ✅ | ✅ (partial) | ❌ | YES |
| `duration` | ✅ | ✅ | ❌ | YES |
| `error` | ✅ | ❌ (separate entry) | `err` field | YES |

---

## 5. Startup/Install/Upgrade/Runtime Failure Observability

### Startup (MCP)
- `console.error()` messages only — NOT in Pino, NOT in SQLite
- Node.js version check failure → `process.exit(1)` + console.error
- Config load failure → NOT logged anywhere structured

### Startup (CLI)
- `initLogger()` called in preAction hook → Pino online
- Config load via `getConfig()` — failures not logged to Pino before logger init

### Install (scaffold)
- `src/core/scaffold.ts` creates `.cleo/` directory structure
- `.gitignore` includes `tasks-log.jsonl`, `todo-log.jsonl` entries — legacy artifacts
- No structured logging of install operations

### Upgrade
- `src/core/upgrade.ts` migrates `tasks-log.jsonl` → `audit_log` SQLite (one-time)
- Migration uses custom `appendLog` calls not through Pino
- `MigrationLogger` class handles migration logs to `.cleo/logs/migration-*.jsonl`

### Runtime Failures
- Engine errors: `engineError()` wrapper calls `getLogger('engine').error()` → Pino
- Data safety failures: `getLogger('data-safety').error()` → Pino
- SQLite errors in `appendLog`: logged via `log.warn/error()` → Pino

---

## 6. Query and Analysis Workflows

| Use Case | Current Mechanism | Limitation |
|----------|-------------------|------------|
| View recent operations | `cleo log` → `admin.log` → `systemLog()` → SQLite | No filtering by sessionId, gateway |
| Session grading | `queryAudit()` filtering by sessionId | Works; used by session-grade.ts |
| Task history | `coreTaskHistory()` → reads `tasks-log.jsonl` JSONL | Reads legacy file, not SQLite |
| Pino log viewing | No CLI command; `queryLogs()` in observability module unused in CLI | No `cleo logs` command |
| Migration logs | No CLI command; discoverable via `discoverLogFiles({includeMigration: true})` | No operator access |

---

## 7. Retention and Cost Controls

| Channel | Retention | Size Control |
|---------|-----------|--------------|
| Pino files | 5 files max (configurable), pino-roll rotation | 10MB/file default |
| audit_log SQLite | **UNBOUNDED** — no TTL, no pruning | Grows without bound |
| tasks-log.jsonl | Legacy; no longer written | Static on disk |
| migration-*.jsonl | Last 10 files | No size limit per file |
| MCP stderr | Process lifetime | None |

**Critical gap**: `audit_log` table has no retention policy. On busy projects with frequent MCP operations, it will grow indefinitely.

---

## 8. Open Issues / Gaps Summary

| ID | Gap | Severity | Relevant to ADR update? |
|----|-----|----------|------------------------|
| G1 | MCP does NOT call `initLogger()` — Pino runs on stderr fallback | High | YES |
| G2 | `coreTaskHistory()` reads `tasks-log.jsonl` not `audit_log` SQLite | High | YES |
| G3 | `health.ts` checks for `todo-log.jsonl` (stale health indicator) | Medium | YES |
| G4 | `audit_log` has no retention/TTL policy | High | YES |
| G5 | `projectHash` correlation field absent from all channels | Medium | YES |
| G6 | brain.db operations produce no audit trail | Medium | YES (strategy needed) |
| G7 | nexus.db not implemented; logging strategy TBD | Low | YES (forward-looking) |
| G8 | Domain error logs lack correlation fields (requestId, sessionId, taskId) | Medium | YES |
| G9 | No CLI command to view pino log files | Low | Operational gap |
| G10 | `scaffold.ts` still includes legacy `tasks-log.jsonl` in .gitignore scaffold | Low | YES |
| G11 | MCP startup uses unstructured `console.error()` — no structured log record | Medium | YES |

---

## 9. Confirmed Non-Issues (Covered by ADR-019)

- ✅ Pino-roll rotation: implemented correctly
- ✅ Dual-write (Pino + SQLite) for dispatch operations: implemented
- ✅ Legacy `audit-log.json` removed: confirmed
- ✅ MCP safety (stdout reserved): confirmed — Pino writes to file, not stdout
- ✅ SQLite `appendLog()` for task CRUD: implemented in sqlite-data-accessor
- ✅ `queryAudit()` for session grading: implemented and used

---

## 10. brain.db Logging Strategy (Research Finding)

brain.db contains cognitive memory (decisions, patterns, learnings, observations, links). These are user-level data objects, not operational events. There are two positions:

**Position A**: brain.db operations DO need audit trail → add `brain_audit_log` table or write to `tasks.db` audit_log with `domain='memory'` (already happens via dispatch middleware for MCP ops)

**Position B**: brain.db BRAIN CRUD is already audited via dispatch middleware (all `memory.*` MCP ops write to `tasks.db.audit_log` via `createAudit()`) — no separate brain.db audit table needed for operational auditing; brain_observations IS the cognitive persistence layer

**Analysis**: Position B appears correct. When MCP `memory.observe` is called, it flows through dispatch → `createAudit()` → writes to `audit_log` in `tasks.db`. The brain.db store layer (`brain-accessor.ts`) does not call any pino logger. Direct brain accessor calls (non-MCP) would NOT be audit logged.

**Recommendation for consensus**: Confirm Position B is canonical. Establish that direct `brain-accessor.ts` calls must only occur via dispatch (no bypassing the audit middleware).

---

## 11. nexus.db Logging Strategy (Research Finding)

nexus.db is not yet implemented. The `nexus` domain handler is a partial stub. Key observations:
- When nexus.db is implemented, it should follow the same dual-write pattern as tasks.db
- The dispatch middleware will automatically audit MCP nexus operations (same as brain.db)
- nexus.db should have its own `nexus_audit_log` table OR share `tasks.db.audit_log` with `domain='nexus'`
- **Recommendation**: Share `tasks.db.audit_log` for nexus operations (consistent, no new table needed)

---

*Research produced by Stream B agent, session ses_20260304165349_002b0c, T5312*
