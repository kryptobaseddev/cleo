# ADR-024: Multi-Store Canonical Logging Architecture

**Date**: 2026-03-05
**Status**: approved
**Accepted**: 2026-03-05
**Amends**: ADR-019 (sections 2.1-2.4 are extended)
**Related ADRs**: ADR-006, ADR-010, ADR-012, ADR-019, ADR-021
**Related Tasks**: T5312, T5313, T5314, T5318, T5340
**Gate**: HITL
**Gate Status**: passed (T5313 consensus)
**Summary**: Extends ADR-019 to cover MCP logger initialization, mandatory correlation fields (projectHash), audit_log retention policy, brain.db and nexus.db audit strategies, and removal of legacy JSONL read paths.
**Keywords**: logging, pino, sqlite, audit, mcp, retention, projectHash, brain, nexus, correlation
**Topics**: logging, audit, infrastructure, observability, multi-store

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context

ADR-019 established Pino + SQLite dual-write as canonical logging for dispatch-level events. The T5312 research audit revealed gaps in the implementation:

- MCP server never calls `initLogger()` -- all Pino entries go to stderr fallback during MCP operation
- `audit_log` table has no retention policy -- grows without bound
- `projectHash` is absent from all logging channels, preventing cross-project correlation
- brain.db operations have no defined audit strategy
- nexus.db is not yet implemented; its audit strategy is undefined
- Legacy JSONL read paths remain in test helpers

This ADR extends ADR-019 with decisions D1-D6 from the T5313 consensus process.

## 2. Decisions

### 2.1 MCP Logger Initialization (amends ADR-019 section 2.2)

The MCP server (`src/mcp/index.ts`) MUST call `initLogger()` at startup, before dispatch layer initialization, using `CleoConfig.logging`. This applies the same Pino configuration as the CLI.

**Invariant**: stderr fallback behavior (when `rootLogger = null`) is retained ONLY for:
- Pre-init fatal bootstrap errors
- Environments where log file creation fails (graceful fallback, not default path)

**MCP startup `console.error()` calls**: These SHOULD be migrated to Pino `info/debug` entries after `initLogger()` is called. A migration period is acceptable.

### 2.2 Legacy JSONL Read Paths REMOVED (amends ADR-019 section 2.5)

The following read paths are PROHIBITED in production code after migration:

- `coreTaskHistory()` reading `tasks-log.jsonl` -- MUST query `audit_log` SQLite instead
- `health.ts` `log_file` check for `todo-log.jsonl` -- MUST be replaced with structured logger + DB health validation
- `systemLog()` JSONL fallback in `system-engine.ts` -- MUST be removed (ADR-019 noted this should be done "in a future version"; that future is now)
- `scaffold.ts` entries for `tasks-log.jsonl` / `todo-log.jsonl` in `.gitignore` -- MUST be removed

**Note**: Research (T5318) found that most of these paths were already migrated to SQLite in the current codebase. Only stale test helper code remained.

### 2.3 audit_log Retention Policy (new section)

`audit_log` MUST have a configurable retention policy.

**Config schema addition** (`CleoConfig.logging`):

```typescript
interface LoggingConfig {
  level: LogLevel;
  filePath: string;
  maxFileSize: number;
  maxFiles: number;
  auditRetentionDays: number;    // default: 90
  archiveBeforePrune: boolean;   // default: true
}
```

**Pruning behavior**:
1. Triggered on CLI startup (preAction hook) and MCP startup -- fire-and-forget, non-blocking
2. Also triggered explicitly via `cleo cleanup logs`
3. When `archiveBeforePrune: true`: export rows older than `auditRetentionDays` to `.cleo/backups/logs/audit-YYYY-MM-DD.jsonl.gz` before deletion
4. Delete rows where `timestamp < (NOW - auditRetentionDays days)` from `audit_log`

**Environment override**: `CLEO_AUDIT_RETENTION_DAYS` (integer, days)

### 2.4 Mandatory Correlation Fields (amends ADR-019 sections 2.2, 2.3)

All audit entries in ALL stores MUST include the following correlation fields:

| Field | Type | Source | Required in Pino? | Required in audit_log? |
|-------|------|--------|-------------------|----------------------|
| `projectHash` | string | `project-info.json` | root context | new column |
| `requestId` | string | dispatch request ID | yes | yes (exists) |
| `sessionId` | string | active session | yes (partial) | yes (exists) |
| `taskId` | string | affected task | yes (partial) | yes (exists) |
| `domain` | string | dispatch domain | yes | yes (exists) |
| `operation` | string | dispatch operation | yes | yes (exists) |
| `source` | string | 'mcp'/'cli' | yes | yes (exists) |
| `gateway` | string | 'mutate'/'query' | yes | yes (exists) |
| `durationMs` | integer | timing | yes | yes (exists) |

**projectHash derivation**: A UUID generated once at scaffold time and stored in `.cleo/project-info.json` as `projectId`. Immutable after creation. This is a stable project identity token, not a path hash.

**Schema change**: `project_hash TEXT` column added to `audit_log` table via drizzle migration (T5334).

**Pino root logger**: `initLogger()` MUST accept `projectHash` as a parameter and bind it to the root logger context so all child loggers inherit it.

### 2.5 brain.db Audit Strategy

**Canon**: brain.db operations that are audit-worthy MUST route through the dispatch layer (MCP or CLI dispatch), which includes `createAudit()` middleware. These operations are automatically audit-logged to `tasks.db.audit_log` with `domain='memory'`.

**Prohibition**: Direct `brain-accessor.ts` mutating calls from production (non-test) code paths are PROHIBITED. Read-only operations are exempt.

**Terminology**: `brain_observations` in brain.db is a cognitive persistence layer -- it stores user/agent cognitive data objects. It is NOT an operational log.

**Enforcement**: A check in `admin.check` SHOULD validate that no production callers bypass dispatch for brain write operations.

### 2.6 nexus.db Audit Strategy (forward-looking)

When nexus.db is implemented:

- nexus.db lives at system scope (`~/.cleo/nexus.db`)
- A `nexus_audit_log` table in nexus.db captures cross-project and registry operations
- Project-scoped operations remain in project `.cleo/tasks.db.audit_log`
- Physical data stores are NOT mixed -- correlation happens at the query layer using shared correlation fields: `projectHash`, `requestId`, `sessionId`, `domain`, `operation`
- The nexus query layer MUST support cross-store join queries using these fields

### 2.7 Deduplication Contract (new section)

Every mutation produces exactly ONE canonical audit record. Write path authority:

| Writer | Authority | Columns |
|--------|-----------|---------|
| `createAudit()` middleware | Dispatch-level events | All columns |
| `appendLog()` data accessor | Task CRUD state diff | Base 8 columns + before/after JSON |

When both writers produce an entry for the same operation (same `requestId`), the dispatch entry is authoritative. The `appendLog()` entry provides the state diff (before/after JSON) that dispatch does not capture. `requestId` links them.

## 3. Required Schema Changes

### 3.1 audit_log table (tasks.db)

New column: `project_hash TEXT` -- added via drizzle migration (T5334).
New index: `idx_audit_log_project_hash`.

### 3.2 LoggingConfig type

New fields: `auditRetentionDays: number`, `archiveBeforePrune: boolean` (T5337).

### 3.3 project-info.json

New field: `projectId: string` (UUID, immutable, generated at scaffold time) (T5333).

## 4. Compliance Rules (extends ADR-019 section 4)

- All new logging MUST use `getLogger(subsystem)` -- unchanged from ADR-019
- `initLogger()` MUST be called at both CLI and MCP startup -- **NEW**
- All audit entries MUST include `projectHash`, `requestId`, `sessionId` -- **NEW**
- `audit_log` MUST have a configured retention policy -- **NEW**
- `tasks-log.jsonl` and `todo-log.jsonl` read paths are PROHIBITED -- **NEW**
- brain.db write operations MUST route through dispatch -- **NEW**

## 5. Consequences

### Positive

- **Cross-project correlation**: `projectHash` enables audit queries across nexus-connected projects
- **Bounded growth**: Retention policy prevents unbounded audit_log table growth
- **MCP parity**: MCP server gets the same structured logging as CLI
- **Clean codebase**: Legacy JSONL paths fully removed

### Negative

- **Migration required**: Existing installs need drizzle migration for `project_hash` column
- **Null backfill**: Pre-migration audit entries will have NULL `project_hash` (acceptable)

### Neutral

- **Dual-write principle unchanged**: Pino + SQLite remains canonical per ADR-019
- **Grade-mode auditing unchanged**: Query operations still audited only during grade sessions

## 6. References

- [ADR-019: Canonical Logging Architecture](ADR-019-canonical-logging-architecture.md) -- amended sections
- T5312: Research matrix (logging gap audit)
- T5313: Consensus decisions (D1-D6)
- T5314: ADR update proposal
- T5315: Logging specification
- T5318: Implementation package
- T5284: Epic -- Eliminate ALL tasks.json Legacy
