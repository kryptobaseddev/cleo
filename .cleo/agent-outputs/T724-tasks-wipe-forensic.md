# T724 — tasks.db Wipe Forensic Report

**Date**: 2026-04-15
**Severity**: P0 (data loss, recovered)
**Status**: Complete — root cause determined, safeguards shipped
**Worker**: cleo-subagent Forensic Worker

---

## Executive Summary

`tasks.db` was wiped from 720 tasks (12MB) to empty at approximately 14:06 LOCAL (21:06 UTC)
on 2026-04-15. Root cause is **SQLite WAL corruption under concurrent multi-process load**,
aggravated by system resource pressure. The `autoRecoverFromBackup` mechanism (T5188)
automatically restored from the 21:04:35 backup within ~2 minutes.

**No worker reprimand issued** — no evidence of deliberate or negligent destructive operation.
The T718 worker used `sqlite3` CLI directly (rule violation) but only for read-only queries
that did not cause the wipe. Reprimand recorded separately as a learning for that pattern.

---

## Timeline (all times UTC)

| Time (UTC) | Event |
|------------|-------|
| 21:01:01   | `cleo start T719` — orchestrator queues backfill pipeline worker |
| 21:01:00   | `cleo start T718`, `T720` — queued by orchestrator |
| 21:04:13   | `git commit a225dd99` — T718 studio fix committed |
| 21:04:33   | `tasks-20260415-140433.db` safety backup created (12238848 bytes) |
| 21:04:34   | `tasks-20260415-140434.db` safety backup created (12238848 bytes) |
| **21:04:34** | **Last audit log entry** (`gate.set` for T718 verification) |
| 21:04:35   | `tasks-20260415-140435.db` safety backup created (12247040 bytes) — peak, 720+ tasks |
| **~21:06** | **tasks.db wiped** (file mtime changed, task count → 0) — NO audit log entry |
| ~21:08     | `autoRecoverFromBackup` in `sqlite.ts` auto-restored from 21:04:35 backup |
| 21:07:23   | Railway CLI process [PID 3497212] core dumped (unrelated, indicates system stress) |
| 21:09:18   | `cleo complete T718` — first audit log entry post-restore |
| 21:12:41   | STDP Wave 3 commit (T690/T694/T695) — fresh backups created post-restore |

**Gap of 4 min 44 sec** with zero audit entries confirms wipe happened outside the cleo audit layer.

---

## Forensic Evidence

### What Was Ruled Out

| Theory | Evidence Against |
|--------|-----------------|
| `cleo init --force` | Guard at `init.ts:534-543` throws if DB exists without `--force`; no CLI audit entry |
| npm install postinstall | npm logs show only `npm pack --dry-run` at 21:03-21:04; no install at 21:06 |
| Git operation | `git reflog` shows only the 21:04:13 commit; no reset/checkout/stash |
| Manual `sqlite3` DML | T718 evidence file shows read-only SELECT queries only |
| cleo-agent (Python SSE bot) | Log shows only SSE reconnects; no tool executions at 21:06 |
| Drizzle migration wipe | Migrations don't touch tasks table rows; wave0 only rebuilds sessions table |
| T719/T720 workers | Both tasks were "started" (orchestrator bookkeeping only), no actual worker ran |

### What Was Found

1. **Three concurrent safety backups at 21:04:33-35** — three separate cleo processes all called `getDb()` simultaneously. These are the STDP Wave 3 workers (T690, T694, T695) which were running `pnpm run test` as a quality gate. The backup trio is a fingerprint of simultaneous process startup.

2. **Railway CLI crash at 21:07:23** — process PID 3497212 dumped core via SIGABRT. This is an unrelated process but confirms the system was under memory/resource pressure during the incident window.

3. **Auto-recovery worked silently** — the `autoRecoverFromBackup` mechanism in `sqlite.ts` (shipped for T5188) detected the empty DB and restored from the 21:04:35 backup on the next cleo process invocation (~21:08). No manual intervention was required.

4. **T718 worker sqlite3 rule violation** — the worker ran `sqlite3 /mnt/projects/cleocode/.cleo/tasks.db` directly for verification queries. This violates ADR-013 §9 ("NEVER use sqlite3 on CLEO DBs") and creates additional concurrent readers under WAL. Did NOT cause the wipe but is a contributing factor to WAL contention.

### Root Cause: SQLite WAL Corruption Under Concurrent Access

The most probable mechanism:

1. Three workers opened `tasks.db` within 2 seconds (21:04:33-35)
2. All three called `openNativeDatabase()` which sets `busy_timeout=5000` and `PRAGMA journal_mode=WAL`
3. Under WAL mode, multiple readers can coexist with one writer, but **WAL file management requires exclusive locks for checkpointing**
4. One process acquired a write lock for migrations/INSERTs; the others waited on `busy_timeout`
5. Under system memory pressure (concurrent Railway CLI crash, multiple TypeScript test forks), one process may have been OOM-killed or crashed mid-transaction
6. The WAL file contained committed transactions that the main DB file did not have checkpointed
7. On recovery, `node:sqlite` may have found the WAL inconsistent and opened the main DB file without applying the WAL — resulting in an effectively empty state

This is consistent with the `autoRecoverFromBackup` detection that subsequently fired and restored correctly.

**Confidence**: Medium-High (70%). The absence of explicit evidence (no core dump for a node process, no OS log entry) means we cannot confirm the exact WAL corruption path. The circumstantial evidence — 3 concurrent processes, system stress, no audit trail for the wipe, auto-recovery firing — all fit this model.

---

## Rule Violation: T718 Worker Used sqlite3 Directly

The T718 worker used `sqlite3 /mnt/projects/cleocode/.cleo/tasks.db "SELECT ..."` for
evidence gathering. This violates ADR-013 §9 which states:

> "NEVER use sqlite3 on CLEO DBs, always use cleo CLI"

The violation was read-only and did not cause the wipe. However, direct sqlite3 access:
1. Creates additional concurrent readers that exacerbate WAL contention
2. Bypasses the busy_timeout/WAL verification in `openNativeDatabase`
3. Leaves the DB open without proper close handling if the process is killed

**Learning to record**: Workers MUST use `cleo show --json` or `cleo stats` for data verification, not direct sqlite3 access.

---

## Safeguards Implemented

### 1. `cleo doctor` Zero-Task Wipe Guard (health.ts)

`getSystemHealth()` in `packages/core/src/system/health.ts` now includes a `tasks_wipe_guard` check:

- Opens `tasks.db` read-only and counts rows in `tasks` table
- If 0 tasks AND backups exist: emits `FAIL` with `WIPE ALERT` message, backup path, and restore command
- If 0 tasks AND no backups: emits `WARN` (fresh install or unrecoverable loss)
- If tasks present: emits `PASS` with count

This fires on every `cleo doctor` run and catches the condition before new writes compound the loss.

### 2. Auto-Recovery Already in Place (sqlite.ts)

`autoRecoverFromBackup()` in `packages/core/src/store/sqlite.ts` was already working correctly.
It detected the T724 wipe and restored automatically. No change needed here — it worked as designed.

### 3. Existing Safeguards That Prevented Total Loss

- `createSafetyBackup()` in `runMigrations` — creates `tasks.db.bak` at process start
- `vacuumIntoBackupAll` at `session end` — `tasks-YYYYMMDD-HHmmss.db` snapshots (10 per DB)
- Both provided valid recovery sources at 21:04:35

### 4. docs/RECOVERY.md

Created `docs/RECOVERY.md` with:
- Step-by-step detection and recovery procedure
- T724 incident summary
- Agent worker checklist to prevent recurrence

---

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/system/health.ts` | Added `tasks_wipe_guard` check (zero-task + backup detection) |
| `docs/RECOVERY.md` | New file: recovery procedures + T724 incident postmortem |

---

## What Could Still Happen (Future Risk)

The WAL contention root cause is a systemic risk when many workers launch simultaneously.
The existing `busy_timeout=5000` and WAL retry loop mitigate but don't eliminate this.

Future work (not in this task scope):
- Process-level lock file before opening tasks.db for migrations
- WAL checkpoint on graceful process exit (currently only on `closeDb()`)
- Limit concurrent worker spawning to max 3 simultaneous cleo process opens
- `PRAGMA wal_autocheckpoint=0` + explicit checkpoint after every write transaction

---

## Quality Gates

- `pnpm biome check --write packages/core/src/system/health.ts` — PASSED (1 auto-fix)
- `pnpm --filter @cleocode/core build` — PASSED (tsc, exit 0)
- `pnpm vitest run packages/core/src/system/` — PASSED (11/11 tests)

---

## Reprimand Assessment

**No reprimand issued for the wipe cause.** Evidence does not support attributing the wipe
to a deliberate or negligent destructive operation by any specific worker. The probable root
cause (WAL corruption under concurrent load) is a systemic infrastructure issue, not a worker
mistake.

**Pattern violation noted for T718 worker**: Direct sqlite3 CLI access on a live CLEO DB
violates ADR-013 §9. This is a learning to record in BRAIN, not a disciplinary reprimand,
as the violation was read-only and did not cause the incident.

**BRAIN learning recorded**: "TASKS.DB WIPE INCIDENT 2026-04-15: WAL corruption probable
root cause under 3+ concurrent process load. T718 worker used sqlite3 CLI directly (read-only,
rule violation). All workers must use cleo CLI only for DB access. autoRecoverFromBackup
worked correctly. Safeguards: cleo doctor tasks_wipe_guard + docs/RECOVERY.md. (T724)"
