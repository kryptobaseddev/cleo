# T5313 Consensus: Canonical Logging Boundaries and Responsibilities

**Task**: T5313 — C: Consensus on canonical logging boundaries
**Epic**: T5284 / Package T5318 (Stream B)
**HITL Gate**: PASSED — decisions confirmed by user
**Date**: 2026-03-04
**Session**: ses_20260304165349_002b0c

---

## Decision Summary

Six consensus decisions were reached following user review of the T5312 research matrix.

---

### D1 — MCP Pino Initialization

**Chosen**: Option A — MCP and CLI both initialize logger from shared core bootstrap.

**Decision**: MCP server (`src/mcp/index.ts`) MUST call `initLogger()` at startup, using the same `CleoConfig.logging` configuration as the CLI. Pino MUST write to a log file during MCP operation, not rely on stderr fallback.

**Rationale**: Same core, same observability contract. No mode-specific blind spots. Eliminates the gap where all MCP-path Pino log entries silently go to stderr (which is discarded in normal operation).

**Guardrail**: stderr fallback (current behavior when `rootLogger = null`) is RETAINED for pre-init and fatal bootstrap errors only. It is NOT the production logging path.

**Impact**:
- `src/mcp/index.ts` needs `initLogger()` call added to `main()`
- Config resolution must happen before `initLogger()` is called
- MCP startup `console.error()` messages SHOULD be migrated to Pino after logger is initialized

---

### D2 — Legacy JSONL Fallback Removal

**Chosen**: Option A — Remove legacy JSONL read paths; use SQLite exclusively.

**Decision**:
- `coreTaskHistory()` in `src/core/tasks/task-ops.ts` MUST be rewritten to query `audit_log` SQLite instead of reading `tasks-log.jsonl`
- `health.ts` `log_file` check MUST be updated to validate structured logger + DB health (not `todo-log.jsonl` existence)
- `scaffold.ts` MUST remove `tasks-log.jsonl` and `todo-log.jsonl` from `.gitignore` scaffold entries
- `systemLog()` JSONL fallback in `system-engine.ts` MUST be removed (the ADR-019 note calling for future removal is now a directive)

**Rationale**: Canonical runtime must not have split-brain logging sources. Legacy JSONL files create dual-source ambiguity for operators and agents.

**Migration path**: `upgrade.ts` migration of `tasks-log.jsonl` → `audit_log` is already implemented. Once migration runs, the JSONL files become orphaned. The read paths should be removed in the same PR that removes the write paths.

**Open question (non-blocking)**: Whether to run a one-time migration for any remaining JSONL entries on existing installs before removing the read paths. Decision: yes — the existing `upgrade.ts` migration handles this; validate it covers the `todo-log.jsonl` → `audit_log` path as well.

---

### D3 — audit_log Retention Policy

**Chosen**: Option C — Configurable retention with strong defaults.

**Decision**: Add `auditRetentionDays` to `CleoConfig.logging`:

```typescript
interface LoggingConfig {
  level: LogLevel;
  filePath: string;
  maxFileSize: number;
  maxFiles: number;
  auditRetentionDays: number;      // NEW — default: 90
  archiveBeforePrune: boolean;     // NEW — default: true
}
```

**Pruning behavior**:
- Pruning runs on CLI startup (preAction hook) and MCP startup — non-blocking, fire-and-forget
- Before pruning: if `archiveBeforePrune: true`, export rows older than `auditRetentionDays` to compressed JSONL snapshots under `.cleo/backups/logs/audit-YYYY-MM-DD.jsonl.gz`
- After archiving: DELETE rows with `timestamp < (NOW - auditRetentionDays days)` from `audit_log`
- `cleo cleanup logs` command MUST trigger pruning explicitly

**Defaults**: `auditRetentionDays: 90`, `archiveBeforePrune: true`

---

### D4 — projectHash Correlation Field

**Chosen**: Option A — Add immutable `projectHash` to Pino logs and `audit_log`.

**Decision**:
- Source of truth: `project-info.json` (immutable once set; generated at scaffold time)
- `projectHash` = SHA-256 of the canonical project root path (or a UUID stored in `project-info.json`)
- Add `project_hash` column to `audit_log` table (new drizzle migration required)
- Pino logs MUST include `projectHash` in the root logger context (set once at `initLogger()` time)
- `requestId`, `sessionId`, `taskId`, `projectHash` are the four mandatory correlation fields

**Why now**: Essential for cross-project and nexus-level analysis. Also required for the nexus.db query layer to join audit data across projects.

---

### D5 — brain.db Audit Strategy

**Chosen**: Option A — Mandate dispatch/core audited path; no direct accessor logging.

**Decision**:
- **Canonical rule**: All brain.db operations that require an audit trail MUST flow through the dispatch layer, which includes `createAudit()` middleware
- Direct `brain-accessor.ts` calls from production code paths (non-test) are PROHIBITED unless they are read-only operations
- Mutating brain operations (`observe`, `link`, etc.) MUST route through MCP or CLI dispatch to receive audit coverage

**Enforcement mechanism**:
- Add a lint/check rule or comment-enforcement pattern to `brain-accessor.ts` noting the prohibition
- The `admin.check` or a future `admin.audit` operation can validate that no direct mutating accessor calls exist outside dispatch

**Migration plan for existing gaps**: Audit which internal non-test callers currently bypass dispatch → route them through core services that go through dispatch. Tracked as T5316 decomposition output.

**Brain.db observations as cognitive persistence**: `brain_observations` table (used by `memory.observe`) IS the cognitive persistence layer — it is NOT a logging mechanism. This distinction is canonical. Brain observations are data objects, not operational log entries.

---

### D6 — nexus.db Audit Strategy

**Chosen**: Option B — Separate `nexus_audit_log` in `~/.cleo/nexus.db`; unified via query layer.

**Decision**:
- nexus.db lives at system scope (`~/.cleo/nexus.db`), not per-project
- `nexus_audit_log` table in `nexus.db` captures cross-project and registry operations
- Project-level operations remain in project `.cleo/tasks.db.audit_log`
- Unification: query layer uses shared correlation fields (`projectHash`, `requestId`, `sessionId`, `domain.operation`) to join/correlate across stores — NOT by physically mixing data
- This matches portability + separation of concerns at system vs. project scope

**Correlation contract**: All audit entries across `tasks.db`, `brain.db` (if added later), and `nexus.db` MUST include `projectHash`, `requestId`, `sessionId` to enable cross-store correlation.

---

## Deduplication Contract

**Canonical channel roles** (no overlap in authority):

| Channel | Role | Authority |
|---------|------|-----------|
| **Pino** | Operational telemetry stream | Startup, runtime, errors, performance context |
| **SQLite audit_log** | Authoritative action ledger | Queryable, compliance, session grading |

**Deduplication rule**: Every mutation produces exactly ONE canonical audit record in `audit_log`. The dispatch middleware `createAudit()` is the single writer for dispatch-layer events. `appendLog()` in `sqlite-data-accessor.ts` writes base columns for task CRUD — this is NOT a duplicate; it is complementary enrichment (before/after JSON for task state). Where both paths write for the same operation, `domain` + `operation` + `requestId` allows correlation.

**Canonical writer hierarchy**:
1. `createAudit()` middleware — dispatch-level events (ALL MCP/CLI operations through dispatch)
2. `appendLog()` — task CRUD base columns (before/after state; no dispatch columns)

If there is overlap (same operation, same `requestId`), the dispatch entry is authoritative. The `appendLog()` entry provides the state diff (before/after JSON) that the dispatch middleware doesn't capture.

---

## Open Questions (Non-Blocking for T5314)

| # | Question | Impact |
|---|----------|--------|
| OQ1 | Exact `projectHash` derivation — path hash vs. stored UUID in `project-info.json`? | Spec detail |
| OQ2 | Should domain error logs get correlation fields injected automatically via a logging wrapper, or per-handler? | Implementation approach |
| OQ3 | Pruning trigger: startup-hook (silent) vs. explicit `cleo cleanup logs` only? | UX decision |
| OQ4 | Should `MigrationLogger` be replaced with a `getLogger('migration')` child, or kept as a bespoke class? | Consistency |

---

## What This Consensus Does NOT Change

- ADR-019's dual-write architecture (Pino + SQLite) is CONFIRMED canonical
- pino-roll for Pino file rotation is CONFIRMED
- `CLEO_LOG_LEVEL` / `CLEO_LOG_FILE` env overrides are CONFIRMED
- Subsystem naming convention (`domain:X`) is CONFIRMED
- Grade-mode conditional auditing of query operations is CONFIRMED

---

*Consensus produced by Stream B agent (T5313), HITL approved by user 2026-03-04*
