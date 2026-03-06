# T5314 ADR Update Proposal: Multi-Store Canonical Logging

**Task**: T5314 — A: ADR update for multi-store canonical logging
**Epic**: T5284 / Package T5318 (Stream B)
**Supersedes**: ADR-019 (extends, not replaces)
**Date**: 2026-03-05
**Status**: DRAFT — pending user review

---

## Proposal: ADR-023 — Multi-Store Canonical Logging Architecture

### Overview

This proposal supersedes sections of ADR-019 that are incomplete relative to the full system scope (MCP initialization, multi-database strategy, retention, and correlation fields). ADR-019's core dual-write principle (Pino + SQLite) remains canonical; this amendment adds:

1. **MCP logger initialization** (closes G1)
2. **Legacy JSONL removal directive** (closes G2, G3)
3. **audit_log retention policy** (closes G4)
4. **`projectHash` as mandatory correlation field** (closes G5)
5. **brain.db audit strategy** (closes G6)
6. **nexus.db audit strategy** (forward-looking)

---

## Draft ADR-023

```markdown
# ADR-023: Multi-Store Canonical Logging Architecture

**Date**: 2026-03-05
**Status**: proposed
**Supersedes**: ADR-019 §2 (sections 2.1–2.4 are amended)
**Related ADRs**: ADR-006, ADR-010, ADR-012, ADR-019, ADR-021
**Related Tasks**: T5312, T5313, T5314
**Gate**: HITL
**Gate Status**: passed (T5313 consensus)
**Summary**: Extends ADR-019 to cover MCP logger initialization, mandatory correlation fields (projectHash), audit_log retention policy, brain.db and nexus.db audit strategies, and removal of legacy JSONL read paths.
**Keywords**: logging, pino, sqlite, audit, mcp, retention, projectHash, brain, nexus, correlation
**Topics**: logging, audit, infrastructure, observability, multi-store

---

## 1. Context

ADR-019 established Pino + SQLite dual-write as canonical logging for dispatch-level events. The T5312 research audit revealed 11 gaps in the implementation:

- MCP server never calls `initLogger()` — all Pino entries go to stderr fallback during MCP operation
- `coreTaskHistory()` still reads legacy `tasks-log.jsonl` files (not SQLite)
- `health.ts` validates `todo-log.jsonl` existence (stale indicator)
- `audit_log` table has no retention policy — grows without bound
- `projectHash` is absent from all logging channels
- brain.db operations have no defined audit strategy
- nexus.db is not yet implemented; its audit strategy is undefined

## 2. Decisions

### 2.1 MCP Logger Initialization (amends ADR-019 §2.2)

The MCP server (`src/mcp/index.ts`) MUST call `initLogger()` at startup, before dispatch
layer initialization, using `CleoConfig.logging`. This applies the same Pino configuration
as the CLI.

**Invariant**: stderr fallback behavior (when `rootLogger = null`) is retained ONLY for:
- Pre-init fatal bootstrap errors
- Environments where log file creation fails (graceful fallback, not default path)

**MCP startup `console.error()` calls**: These SHOULD be migrated to Pino `info/debug`
entries after `initLogger()` is called. A migration period is acceptable.

### 2.2 Legacy JSONL Read Paths REMOVED (amends ADR-019 §2.5)

The following read paths are PROHIBITED in production code after migration:

- `coreTaskHistory()` reading `tasks-log.jsonl` — MUST query `audit_log` SQLite instead
- `health.ts` `log_file` check for `todo-log.jsonl` — MUST be replaced with structured
  logger + DB health validation
- `systemLog()` JSONL fallback in `system-engine.ts` — MUST be removed (ADR-019 noted
  this should be done "in a future version"; that future is now)
- `scaffold.ts` entries for `tasks-log.jsonl` / `todo-log.jsonl` in `.gitignore` — MUST
  be removed

**Prerequisite**: Ensure the `upgrade.ts` migration covers both `tasks-log.jsonl` and
`todo-log.jsonl` → `audit_log` before these read paths are removed.

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
1. Triggered on CLI startup (preAction hook) and MCP startup — fire-and-forget, non-blocking
2. Also triggered explicitly via `cleo cleanup logs`
3. When `archiveBeforePrune: true`: export rows older than `auditRetentionDays` to
   `.cleo/backups/logs/audit-YYYY-MM-DD.jsonl.gz` before deletion
4. Delete rows where `timestamp < (NOW - auditRetentionDays days)` from `audit_log`

**Environment override**: `CLEO_AUDIT_RETENTION_DAYS` (integer, days)

### 2.4 Mandatory Correlation Fields (amends ADR-019 §2.2, §2.3)

All audit entries in ALL stores MUST include the following correlation fields:

| Field | Type | Source | Required in Pino? | Required in audit_log? |
|-------|------|--------|-------------------|----------------------|
| `projectHash` | string | `project-info.json` (immutable UUID) | ✅ root context | ✅ new column |
| `requestId` | string | dispatch request ID | ✅ | ✅ (exists) |
| `sessionId` | string | active session | ✅ (partial) | ✅ (exists) |
| `taskId` | string | affected task | ✅ (partial) | ✅ (exists) |
| `domain` | string | dispatch domain | ✅ | ✅ (exists) |
| `operation` | string | dispatch operation | ✅ | ✅ (exists) |
| `source` | string | 'mcp'/'cli' | ✅ | ✅ (exists) |
| `gateway` | string | 'mutate'/'query' | ✅ | ✅ (exists) |
| `durationMs` | integer | timing | ✅ | ✅ (exists) |

**projectHash derivation**: A UUID generated once at scaffold time and stored in
`.cleo/project-info.json` as `projectId`. Immutable after creation. Hash is not a path
hash (path can change on moves); it is a stable project identity token.

**Schema change required**: Add `project_hash` column to `audit_log` table via drizzle
migration.

**Pino root logger**: `initLogger()` MUST accept `projectHash` as a parameter and bind it
to the root logger context so all child loggers inherit it.

### 2.5 brain.db Audit Strategy

**Canon**: brain.db operations that are audit-worthy MUST route through the dispatch layer
(MCP or CLI dispatch), which includes `createAudit()` middleware. These operations are
automatically audit-logged to `tasks.db.audit_log` with `domain='memory'`.

**Prohibition**: Direct `brain-accessor.ts` mutating calls from production (non-test) code
paths are PROHIBITED. Read-only operations are exempt.

**Terminology**: `brain_observations` in brain.db is a **cognitive persistence layer** —
it stores user/agent cognitive data objects. It is NOT an operational log. Do not conflate
the two.

**Enforcement**: A check in `admin.check` SHOULD validate that no production callers bypass
dispatch for brain write operations.

### 2.6 nexus.db Audit Strategy (forward-looking)

When nexus.db is implemented:

- nexus.db lives at system scope (`~/.cleo/nexus.db`)
- A `nexus_audit_log` table in nexus.db captures cross-project and registry operations
- Project-scoped operations remain in project `.cleo/tasks.db.audit_log`
- Physical data stores are NOT mixed — correlation happens at the query layer using shared
  correlation fields: `projectHash`, `requestId`, `sessionId`, `domain`, `operation`
- The nexus query layer MUST support cross-store join queries using these fields

### 2.7 Deduplication Contract (new section)

Every mutation produces exactly ONE canonical audit record. Write path authority:

| Writer | Authority | Columns |
|--------|-----------|---------|
| `createAudit()` middleware | Dispatch-level events | All 17 columns |
| `appendLog()` data accessor | Task CRUD state diff | Base 8 columns + before/after JSON |

When both writers produce an entry for the same operation (same `requestId`), the dispatch
entry is authoritative. The `appendLog()` entry provides the state diff (before/after JSON)
that dispatch does not capture. `requestId` links them.

## 3. Required Schema Changes

### 3.1 audit_log table (tasks.db)

New column: `project_hash TEXT` — added via drizzle migration.

### 3.2 LoggingConfig type

New fields: `auditRetentionDays: number`, `archiveBeforePrune: boolean`.

### 3.3 project-info.json

New field: `projectId: string` (UUID, immutable, generated at scaffold time).

## 4. Compliance Rules (extends ADR-019 §4)

- All new logging MUST use `getLogger(subsystem)` — unchanged
- `initLogger()` MUST be called at both CLI and MCP startup — **NEW**
- All audit entries MUST include `projectHash`, `requestId`, `sessionId` — **NEW**
- `audit_log` MUST have a configured retention policy — **NEW**
- `tasks-log.jsonl` and `todo-log.jsonl` read paths are PROHIBITED — **NEW**
- brain.db write operations MUST route through dispatch — **NEW**

## 5. Migration Checklist

- [ ] Add `projectId` to `project-info.json` scaffold template
- [ ] Add `project_hash` column to `audit_log` via drizzle migration
- [ ] Update `initLogger()` signature to accept `projectHash`
- [ ] Update `src/mcp/index.ts` to call `initLogger()` with config + projectHash
- [ ] Add `auditRetentionDays` / `archiveBeforePrune` to `CleoConfig.logging`
- [ ] Implement audit pruning + archive in `src/core/system/cleanup.ts`
- [ ] Rewrite `coreTaskHistory()` to query `audit_log` SQLite
- [ ] Remove `health.ts` `todo-log.jsonl` check; add logger + DB health checks
- [ ] Remove `systemLog()` JSONL fallback in `system-engine.ts`
- [ ] Remove legacy JSONL gitignore entries from `scaffold.ts`
- [ ] Add `admin.check` rule for brain accessor bypass detection

## 6. References

- [ADR-019](ADR-019-canonical-logging-architecture.md) — superseded sections
- [T5312 Research Matrix](.cleo/rcasd/T5318/T5312-research-matrix.md)
- [T5313 Consensus](.cleo/rcasd/T5318/T5313-consensus-decisions.md)
- T5284 Epic: Eliminate ALL tasks.json Legacy
```

---

## Review Notes

This ADR proposal does NOT change:
- The dual-write principle (Pino + SQLite)
- pino-roll rotation configuration
- The `domain:X` subsystem naming convention
- Grade-mode auditing of query operations

Primary risk: Adding `projectHash` as a required column means existing `audit_log` entries (pre-migration) will have a NULL `project_hash`. This is acceptable — existing entries predate the correlation requirement and remain valid for historical queries.

---

*Draft produced by Stream B agent (T5314), session ses_20260304165349_002b0c*
