# T5339 Prep Notes — pruneAuditLog() with archive-before-prune + startup wiring

**Prepared by**: impl-t5333 agent
**Date**: 2026-03-05

---

## 1. Does pruneAuditLog already exist?

**No.** Grep for `pruneAuditLog`, `prune.*audit`, `audit.*prune` across `src/` returns zero matches.

The existing `cleanupSystem()` in `src/core/system/cleanup.ts` has a `logs` case (lines 90-103) that only deletes old `audit-log-*.json` files from the `.cleo/` directory. It does NOT touch the SQLite `audit_log` table.

`archiveBeforePrune` and `auditRetentionDays` do not exist anywhere in `src/` yet. T5337 is adding them to `LoggingConfig` and config defaults.

---

## 2. Where in MCP startup should pruneAuditLog be called?

**After `initLogger()` (which T5336 is adding), before `initMcpDispatcher()` at line 79.**

Current MCP startup sequence (`src/mcp/index.ts`):
```
Line 70: const config = loadConfig();
          <-- T5336 inserts initLogger() here (between lines 75-77)
Line 79: initMcpDispatcher({ ... });
```

Prune call should be **fire-and-forget** immediately after initLogger:
```typescript
pruneAuditLog(process.cwd(), { auditRetentionDays: 90, archiveBeforePrune: true })
  .catch(err => getLogger('system:cleanup').warn({ err }, 'audit prune failed'));
```

For CLI, the prune should go in the `preAction` hook at `src/cli/index.ts:502-511`, after `initLogger()` at line 507. Same fire-and-forget pattern.

---

## 3. Archive target path

Per spec (T5315 section 8.2):
```
.cleo/backups/logs/audit-{YYYY-MM-DD}.jsonl.gz
```

- Format: JSONL (one JSON object per line), gzip compressed
- Use `node:zlib` createGzip() for compression
- Directory `.cleo/backups/logs/` must be created if missing (mkdir recursive)

---

## 4. DB query for pruneAuditLog

The `audit_log` table (defined in `src/store/schema.ts:344`) has a `timestamp` column (TEXT, ISO-8601 format). The `project_hash` column was added by T5334.

**Cutoff calculation**:
```typescript
const cutoff = new Date(Date.now() - config.auditRetentionDays * 86400000).toISOString();
```

**Archive query** (if archiveBeforePrune):
```typescript
const { getDb } = await import('../../store/sqlite.js');
const { auditLog } = await import('../../store/schema.js');
const { lt } = await import('drizzle-orm');

const db = await getDb(projectRoot);
const oldRows = db.select().from(auditLog).where(lt(auditLog.timestamp, cutoff)).all();
```

**Delete query**:
```typescript
db.delete(auditLog).where(lt(auditLog.timestamp, cutoff)).run();
```

**Key schema columns available for archive serialization** (from schema.ts:344-372):
`id`, `timestamp`, `action`, `taskId`, `actor`, `detailsJson`, `domain`, `operation`, `sessionId`, `requestId`, `durationMs`, `success`, `source`, `gateway`, `errorMessage`, `projectHash`

---

## 5. Error handling contract

Per spec: **NEVER throw** from pruneAuditLog. Log failures at `warn` level. Pruning must not block startup.

```typescript
export async function pruneAuditLog(
  projectRoot: string,
  config: { auditRetentionDays: number; archiveBeforePrune: boolean },
): Promise<{ rowsArchived: number; rowsDeleted: number }> {
  // ... implementation ...
  // On any error: log warn, return { rowsArchived: 0, rowsDeleted: 0 }
}
```

---

## 6. Trigger points summary

| Trigger | Location | Pattern |
|---------|----------|---------|
| MCP startup | `src/mcp/index.ts` (after initLogger, before dispatch init) | fire-and-forget |
| CLI startup | `src/cli/index.ts:502-511` preAction hook (after initLogger) | fire-and-forget |
| `cleo cleanup logs` | `src/core/system/cleanup.ts` logs case | await result, surface counts |

---

## 7. Dependencies

- **T5334** (DONE): `project_hash` column exists on audit_log
- **T5335** (DONE): `initLogger()` accepts projectHash, `getLogger()` works
- **T5336** (IN PROGRESS): MCP startup calls initLogger — prune insertion point depends on this
- **T5337** (IN PROGRESS): `auditRetentionDays` and `archiveBeforePrune` added to LoggingConfig/config defaults — pruneAuditLog needs these config values
