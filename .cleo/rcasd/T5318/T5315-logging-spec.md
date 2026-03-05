# T5315 Implementation Spec: CLEO Canonical Logging Architecture

**Task**: T5315 — S: Logging specification and level taxonomy
**Epic**: T5284 / Package T5318 (Stream B)
**ADR**: ADR-023 (proposal at T5314)
**Status**: IMPLEMENTATION-READY
**Date**: 2026-03-05

---

## 1. Scope

This spec defines all implementation targets for ADR-023. It is organized by work area and provides exact file targets, behavioral contracts, and validation criteria for each change.

---

## 2. Log Level Taxonomy (Canonical)

Per ADR-019 §2.2 (unchanged by ADR-023):

| Level | Numeric | When to Use |
|-------|---------|-------------|
| `fatal` | 60 | Process-ending errors: DB corruption, unrecoverable bootstrap failure |
| `error` | 50 | Operation failures requiring attention: engine errors, SQLite write failures |
| `warn` | 40 | Degraded behavior: fallback paths taken, optional config missing, audit write failures |
| `info` | 30 | Normal operations: audit entries, lifecycle transitions, session start/end, startup |
| `debug` | 20 | Detailed operation flow: parameter values, cache decisions |
| `trace` | 10 | Fine-grained tracing: SQL queries, middleware chain execution |

**New usage requirements from ADR-023**:
- MCP startup completion: `info` (after logger initialized)
- MCP pre-init messages: `warn` to stderr (acceptable pre-init only)
- audit pruning run: `info` with rows_deleted, rows_archived counts
- audit pruning failure: `warn` (never block startup on prune failure)
- projectHash missing from config: `warn`

---

## 3. Mandatory Correlation Fields

Every Pino log entry at `info` level or above (in production paths) MUST include:

```typescript
interface CorrelationContext {
  projectHash: string;   // From project-info.json (immutable UUID)
  requestId?: string;    // Dispatch request ID (present in dispatch paths)
  sessionId?: string;    // Active session ID (when session is active)
  taskId?: string;       // Affected task ID (when operation is task-scoped)
  domain?: string;       // Dispatch domain
  operation?: string;    // Dispatch operation
  source?: 'mcp' | 'cli'; // Entry point
  gateway?: 'mutate' | 'query'; // Gateway type
  durationMs?: number;   // Operation duration
}
```

`projectHash` MUST be present in all entries. Other fields are context-dependent.

**Binding**: `projectHash` is bound to the root logger at `initLogger()` time and inherited by all child loggers automatically.

---

## 4. Work Area 1 — Logger Initialization (`src/core/logger.ts`)

### 4.1 `initLogger()` Signature Change

```typescript
export function initLogger(
  cleoDir: string,
  config: LoggerConfig,
  projectHash?: string,  // NEW: optional for backward compat, warn if absent
): pino.Logger
```

**Behavior**:
- If `projectHash` is provided, bind it to root logger context: `rootLogger.child({ projectHash })`
  Actually: bind at creation time via `pino({ base: { projectHash } })`
- If `projectHash` is absent, log a `warn` at the `engine` subsystem: "projectHash not provided to initLogger; audit correlation will be incomplete"

**Implementation note**: `pino({ base: { projectHash, pid, hostname } })` — add `projectHash` to the `base` object so it appears in every log entry.

### 4.2 No Other Changes to `logger.ts`

pino-roll transport, rotation config, child logger API — all unchanged.

---

## 5. Work Area 2 — MCP Startup (`src/mcp/index.ts`)

### 5.1 Add Logger Initialization

Insert immediately after config load, before `initMcpDispatcher()`:

```typescript
// Initialize structured logger (same as CLI)
import { initLogger } from '../core/logger.js';
import { readProjectInfo } from '../core/project-info.js'; // NEW utility

const projectInfo = readProjectInfo(process.cwd());
initLogger(
  join(process.cwd(), '.cleo'),
  {
    level: config.logLevel ?? 'info',
    filePath: 'logs/cleo.log',
    maxFileSize: 10 * 1024 * 1024,
    maxFiles: 5,
  },
  projectInfo?.projectId,
);
```

### 5.2 Migrate `console.error()` Calls

After `initLogger()` is called, replace `console.error('[CLEO MCP] ...')` calls with:

```typescript
const startupLog = getLogger('mcp:startup');
startupLog.info({ config }, 'CLEO MCP server starting');
```

**Priority**: Startup/shutdown messages first. Cache hit/miss `console.error()` calls are `debug` level, can be deferred to a follow-up task.

**Guardrail**: The Node.js version check failure and global bootstrap error paths MUST stay as `console.error()` since they run before the logger is initialized.

---

## 6. Work Area 3 — projectHash Infrastructure

### 6.1 New File: `src/core/project-info.ts`

```typescript
/**
 * Project identity token management.
 * projectId is immutable once set — generated at scaffold time.
 */
export interface ProjectInfo {
  projectId: string; // UUID, immutable
  createdAt: string; // ISO-8601
}

export function readProjectInfo(cwd: string): ProjectInfo | null;
export function ensureProjectInfo(cleoDir: string): ProjectInfo;
```

**Storage**: `.cleo/project-info.json`
**Generation**: `crypto.randomUUID()` at scaffold time
**Immutability**: Never overwrite `projectId` if already set

### 6.2 Scaffold Update (`src/core/scaffold.ts`)

Add `project-info.json` creation with `projectId = crypto.randomUUID()` to scaffold initialization. Add template file to scaffold output.

### 6.3 Database Migration

New drizzle migration: `add_project_hash_to_audit_log`

```sql
ALTER TABLE audit_log ADD COLUMN project_hash TEXT;
CREATE INDEX idx_audit_log_project_hash ON audit_log(project_hash);
```

**Note**: Use `drizzle-kit generate --custom` since `ALTER TABLE ADD COLUMN` may not be detectable by drizzle-kit snapshot diff.

### 6.4 Drizzle Schema Update (`src/store/schema.ts`)

```typescript
export const auditLog = sqliteTable('audit_log', {
  // ... existing columns ...
  projectHash: text('project_hash'), // NEW — nullable for pre-migration rows
}, ...);
```

### 6.5 Audit Middleware Update (`src/dispatch/middleware/audit.ts`)

`writeToSqlite()` must include `projectHash` in the insert:

```typescript
const projectHash = await getProjectHash(process.cwd()); // cached singleton

await db.insert(auditLog).values({
  // ... existing fields ...
  projectHash: projectHash ?? null,
}).run();
```

---

## 7. Work Area 4 — Legacy JSONL Removal

### 7.1 `coreTaskHistory()` (`src/core/tasks/task-ops.ts`)

**Current**: Reads `tasks-log.jsonl` via `readLogFileEntries()`
**Target**: Query `audit_log` SQLite

```typescript
export async function coreTaskHistory(
  projectRoot: string,
  taskId: string,
  limit?: number,
): Promise<Array<Record<string, unknown>>> {
  const { getDb } = await import('../../store/sqlite.js');
  const { auditLog } = await import('../../store/schema.js');
  const { eq, or, desc } = await import('drizzle-orm');

  const db = await getDb(projectRoot);
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.taskId, taskId))
    .orderBy(desc(auditLog.timestamp))
    .limit(limit ?? 100);

  return rows.map(row => ({
    operation: row.operation ?? row.action,
    taskId: row.taskId,
    timestamp: row.timestamp,
    actor: row.actor,
    details: row.detailsJson ? JSON.parse(row.detailsJson) : {},
    before: row.beforeJson ? JSON.parse(row.beforeJson) : undefined,
    after: row.afterJson ? JSON.parse(row.afterJson) : undefined,
  }));
}
```

**Validation**: Existing `coreTaskHistory` tests must pass. Add test for SQLite path.

### 7.2 `health.ts` Log Check (`src/core/system/health.ts`)

**Remove**: Lines 113–118 (checks for `todo-log.jsonl`)
**Replace with**: Logger initialized check + audit_log row count check

```typescript
// Check structured logger
const logDir = join(cleoDir, 'logs');
if (existsSync(logDir)) {
  checks.push({ name: 'log_dir', status: 'pass', message: 'Pino log directory exists' });
} else {
  checks.push({ name: 'log_dir', status: 'warn', message: 'Pino log directory not found' });
}

// Check audit_log table exists and has entries
const auditCount = /* SQLite count query */;
checks.push({ name: 'audit_log', status: auditCount >= 0 ? 'pass' : 'warn', ... });
```

**Also**: Remove line 440 (`const logPath = join(cleoDir, 'todo-log.jsonl')`)

### 7.3 `systemLog()` JSONL Fallback (`src/dispatch/engines/system-engine.ts`)

**Remove**: `queryAuditLogJsonl()` function (lines ~570–600)
**Remove**: `queryAuditLogJsonl()` call in `systemLog()` fallback path
**Simplify** `systemLog()` to:

```typescript
export async function systemLog(projectRoot, filters) {
  try {
    const entries = await queryAuditLogSqlite(projectRoot, filters);
    if (entries !== null) return { success: true, data: entries };
    return { success: true, data: { entries: [], pagination: { total: 0, offset: 0, limit: 20, hasMore: false } } };
  } catch (err) {
    return engineError('E_FILE_ERROR', (err as Error).message);
  }
}
```

**Note**: Remove the `total === 0 → return null (fall through to JSONL)` logic — empty SQLite result is valid and should return empty entries, not fall through.

### 7.4 `scaffold.ts` Cleanup (`src/core/scaffold.ts`)

Remove from `.gitignore` template (lines ~85–86):
```
tasks-log.jsonl
todo-log.jsonl
todo-log.json
```

---

## 8. Work Area 5 — audit_log Retention

### 8.1 Config Schema (`src/types/config.ts` or equivalent)

```typescript
interface LoggingConfig {
  level: string;
  filePath: string;
  maxFileSize: number;
  maxFiles: number;
  auditRetentionDays: number;   // Default: 90
  archiveBeforePrune: boolean;  // Default: true
}
```

**Defaults** in `src/core/config.ts`:

```typescript
logging: {
  level: 'info',
  filePath: 'logs/cleo.log',
  maxFileSize: 10 * 1024 * 1024,
  maxFiles: 5,
  auditRetentionDays: 90,
  archiveBeforePrune: true,
},
```

**ENV**: `CLEO_AUDIT_RETENTION_DAYS` (number)

### 8.2 New Function: `pruneAuditLog()` (`src/core/system/cleanup.ts`)

```typescript
export async function pruneAuditLog(
  projectRoot: string,
  config: { auditRetentionDays: number; archiveBeforePrune: boolean }
): Promise<{ rowsArchived: number; rowsDeleted: number }>
```

**Logic**:
1. Calculate cutoff: `new Date(Date.now() - auditRetentionDays * 86400000).toISOString()`
2. If `archiveBeforePrune`: query rows with `timestamp < cutoff`, serialize to JSONL, compress to `.cleo/backups/logs/audit-{date}.jsonl.gz`
3. `DELETE FROM audit_log WHERE timestamp < cutoff`
4. Log result at `info` level via `getLogger('system:cleanup')`

**Error handling**: Log pruning failures at `warn` level. NEVER throw — pruning must not block startup.

### 8.3 Trigger Points

- **CLI startup**: Call `pruneAuditLog()` in `preAction` hook after `initLogger()` — fire-and-forget (`pruneAuditLog().catch(err => log.warn({ err }, 'audit prune failed'))`)
- **MCP startup**: Same — fire-and-forget after `initLogger()`
- **`cleo cleanup logs`**: Call directly, await result, surface counts to user

---

## 9. Work Area 6 — Domain Error Log Correlation

### 9.1 Current State

Domain handlers call `getLogger('domain:X').error({ err }, message)`. This lacks correlation fields.

### 9.2 Target

In error handler of each domain (`src/dispatch/domains/*.ts`), enrich with available context:

```typescript
getLogger('domain:tasks').error(
  { err: error, gateway, domain, operation },
  message
);
```

**Minimal change**: Add `gateway`, `domain`, `operation` to each error log call. These are always in scope in the error handler.

**Full correlation**: Adding `requestId` and `sessionId` requires these to be passed from the dispatch request context — tracked as a follow-up in T5316 decomposition.

---

## 10. Startup/Install/Upgrade/Runtime Failure Observability

### 10.1 Startup

| Event | Level | Channel | Required fields |
|-------|-------|---------|----------------|
| MCP logger initialized | `info` | Pino | `subsystem: 'mcp:startup'`, `projectHash`, `config.logLevel` |
| MCP server ready | `info` | Pino | `subsystem: 'mcp:startup'`, `transport: 'stdio'` |
| Node.js version check fail | `fatal` via `console.error` (pre-init) | stderr | — |
| Config load fail | `error` | Pino (if init'd) / `console.error` (if not) | `err` |

### 10.2 Install (scaffold)

| Event | Level | Channel |
|-------|-------|---------|
| Project scaffolded | `info` | Pino (if init'd) |
| `project-info.json` created | `debug` | Pino |

### 10.3 Upgrade/Migration

| Event | Level | Channel |
|-------|-------|---------|
| Migration started | `info` | `MigrationLogger` + Pino `getLogger('migration')` |
| Migration completed | `info` | Both |
| Migration failed | `error` | Both |

**Note on MigrationLogger**: For now, `MigrationLogger` coexists with `getLogger('migration')`. Replacing it with a pure Pino child logger is tracked as a follow-up in T5316.

### 10.4 Runtime Failures

| Event | Level | Channel | Fields |
|-------|-------|---------|--------|
| Engine error | `error` | Pino `engine` | `err`, `gateway`, `domain`, `operation` |
| SQLite audit write fail | `warn` | Pino `audit` | `err` |
| Brain accessor direct mutate | `warn` (if detected) | Pino `check` | `callerPath` |
| audit_log prune fail | `warn` | Pino `system:cleanup` | `err` |

---

## 11. Query and Analysis Workflows (Operator Playbook)

### 11.1 View Recent Operations

```bash
cleo log --limit 50 --since 2026-03-01
```
→ Queries `audit_log` SQLite; returns dispatch-level entries newest-first.

### 11.2 View Operations for a Task

```bash
cleo log --task T5312
```

### 11.3 View Session Operations

```bash
cleo log --session ses_20260304165349_002b0c
```
(Add `--session` filter to `admin.log` operation — tracked in T5316)

### 11.4 View Pino Log Files

No CLI command exists today. T5316 decomposition should include a `cleo logs` command that uses `queryLogs()` from the observability module.

### 11.5 Prune Audit Log

```bash
cleo cleanup logs
```

---

## 12. Validation Criteria (Acceptance Tests)

Each implementation task from T5316 must pass:

| # | Criterion | Test Type |
|---|-----------|-----------|
| V1 | MCP startup creates Pino log entries in `.cleo/logs/` | Integration |
| V2 | All Pino entries include `projectHash` | Unit (logger) |
| V3 | `audit_log` rows include `project_hash` | Integration |
| V4 | `coreTaskHistory()` returns entries from SQLite | Unit |
| V5 | `health.ts` does not check for `todo-log.jsonl` | Unit |
| V6 | `systemLog()` returns empty array when no SQLite entries (no JSONL fallback) | Unit |
| V7 | `pruneAuditLog()` deletes rows older than cutoff | Unit |
| V8 | `pruneAuditLog()` creates archive file when `archiveBeforePrune: true` | Unit |
| V9 | Startup prune failure does not throw or block startup | Unit |
| V10 | `project-info.json` created at scaffold time with stable `projectId` | Unit |
| V11 | Re-running scaffold does NOT overwrite existing `projectId` | Unit |
| V12 | `npx tsc --noEmit` passes with zero errors | Build |
| V13 | Full vitest suite passes with zero failures | Test suite |

---

*Spec produced by Stream B agent (T5315), session ses_20260304165349_002b0c*
