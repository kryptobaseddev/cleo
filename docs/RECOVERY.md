# CLEO Data Recovery Procedures

> Reference document for tasks.db wipe recovery. Born from the T724 incident (2026-04-15).

---

## Quick Reference: Did tasks.db get wiped?

**Symptom**: `cleo dash` shows 0 tasks. `cleo stats` returns all zeros.

**Confirm**:
```bash
cleo doctor
# Look for: WIPE ALERT in tasks_wipe_guard check
# Or manually:
sqlite3 .cleo/tasks.db "SELECT COUNT(*) FROM tasks;"
# If output is 0 and you had tasks, proceed with recovery below.
```

---

## Recovery Procedure

### Step 1: Stop all concurrent cleo processes

Concurrent writes during recovery can corrupt the restored DB.

```bash
# Kill any running cleo agent workers
pkill -f "cleo " 2>/dev/null || true
# Verify nothing is writing
lsof .cleo/tasks.db 2>/dev/null
```

### Step 2: List available backups

```bash
cleo backup list
# Or directly:
ls -lth .cleo/backups/sqlite/tasks-*.db
```

Backups are created at:
- Every `cleo session end` (auto via `vacuumIntoBackupAll`)
- Every time a new cleo process opens tasks.db (via `createSafetyBackup` in `runMigrations`)
- On demand via `cleo backup add`

### Step 3: Verify the backup has data

```bash
# Check row count in the candidate backup before restoring
sqlite3 .cleo/backups/sqlite/tasks-YYYYMMDD-HHmmss.db "SELECT COUNT(*) FROM tasks;"
```

Choose the newest backup with a non-zero count.

### Step 4: Remove stale WAL/SHM files

SQLite WAL sidecars can conflict with a restored main DB file.

```bash
rm -f .cleo/tasks.db-wal .cleo/tasks.db-shm
```

### Step 5: Restore

**Using cleo CLI (recommended)**:
```bash
cleo restore backup --file tasks.db
# Prompts you to choose a backup if multiple exist
```

**Manual restore (if CLI is not available)**:
```bash
# Atomic: copy to temp, rename into place
cp .cleo/backups/sqlite/tasks-YYYYMMDD-HHmmss.db .cleo/tasks.db.tmp
mv .cleo/tasks.db.tmp .cleo/tasks.db
```

### Step 6: Verify restore

```bash
sqlite3 .cleo/tasks.db "SELECT COUNT(*) FROM tasks;"
# Should match the count you verified in Step 3

cleo dash
# Should show the expected task summary
```

### Step 7: Create a fresh backup

```bash
cleo backup add
# Creates a new snapshot of the restored DB
```

---

## T724 Incident Summary (2026-04-15)

**What happened**: At approximately 14:06 LOCAL (21:06 UTC) on 2026-04-15, `tasks.db` was
wiped from 720 tasks (12MB) to empty while multiple concurrent agent workers (STDP Wave 3:
T690, T694, T695 plus T718 worker) were active.

**Forensic findings**:
- Last cleo audit log entry before wipe: `gate.set` at 21:04:34 UTC (T718 verification gate)
- No cleo CLI audit entry for the wipe operation itself (happened outside audit trail)
- No git commits, npm installs, or explicit `cleo init --force` in the window
- Three concurrent safety backups created at 21:04:33-35 (three simultaneous processes)
- Railway CLI process [PID 3497212] crashed with SIGABRT at 14:07:23, indicating system resource pressure
- The `autoRecoverFromBackup` mechanism in `sqlite.ts` auto-restored from the 21:04:35 backup when the next cleo process started

**Probable root cause**: SQLite WAL corruption under concurrent multi-process access. Three
worker processes opened `tasks.db` simultaneously within 2 seconds. Under resource pressure
(indicated by Railway CLI crash), one process may have exited mid-transaction or failed to
complete WAL checkpointing, leaving the main DB file empty while WAL sidecars held the real
data. When a subsequent process opened the DB, the WAL could not be applied (WAL files may
have been partially written), resulting in an effectively empty database.

**Contributing rule violation**: The T718 worker used `sqlite3` CLI directly to verify data
(`sqlite3 /mnt/projects/cleocode/.cleo/tasks.db "SELECT ..."`) in violation of ADR-013 §9.
While the queries were read-only and did not cause the wipe, direct sqlite3 access creates
additional concurrent readers that compound WAL contention. NEVER use sqlite3 on CLEO DBs.

**Recovery**: The `autoRecoverFromBackup` mechanism in `sqlite.ts` automatically detected the
empty DB and restored from the most recent backup (21:04:35). The first cleo operation after
the wipe (T718 complete at 21:09:18) succeeded because the auto-recovery had already run.

---

## Safeguards Added (T724)

### 1. `cleo doctor` Zero-Task Wipe Guard

`cleo doctor` now checks if `tasks.db` has 0 tasks while backups exist. If detected:
- Status: `FAIL` with a `WIPE ALERT` message
- Shows the latest backup name and timestamp
- Provides the restore command

```bash
cleo doctor
# Example output:
# ✗ tasks_wipe_guard  WIPE ALERT: tasks.db has 0 tasks but 3 backup(s) exist.
#   Latest: tasks-20260415-140435.db (2026-04-15T21:04:35.000Z)
#   Restore: cleo restore backup --file tasks.db
```

### 2. Auto-Recovery on DB Open

`sqlite.ts` `getDb()` includes `autoRecoverFromBackup()` which fires automatically
whenever a cleo process opens a tasks.db with 0 rows but a backup with data exists.
This was already in place for T5188 (WAL/git-tracking data loss) and worked correctly
during the T724 incident.

### 3. Safety Backup on Migration

`runMigrations` calls `createSafetyBackup` at startup, creating `tasks.db.bak` once
per process lifecycle. These backups are visible to `autoRecoverFromBackup`.

### 4. Session-End Automatic Snapshots

Every `cleo session end` triggers `vacuumIntoBackupAll` which writes
`tasks-YYYYMMDD-HHmmss.db` to `.cleo/backups/sqlite/` (10 snapshots, oldest rotated out).

---

## Prevention Checklist for Agent Workers

1. **NEVER use `sqlite3` CLI directly on CLEO DBs** — use cleo CLI only (ADR-013 §9)
2. **NEVER run `cleo init --force`** without explicit owner approval
3. **NEVER run `cleo restore`** without verifying the backup count first
4. **Run `cleo doctor` before and after** any major operation to detect wipe conditions
5. **Report 0-task dashboard immediately** — do not proceed with work that would write new tasks to an empty DB

---

## Handling Concurrent Agent Activity During Recovery

If multiple agent workers are running during a detected wipe:

1. **All workers must pause** before restore is attempted (conflicting writes can corrupt recovery)
2. **Restore to a temp file first**: `cp backup.db tasks.db.tmp && mv tasks.db.tmp tasks.db`
3. **Verify immediately**: `sqlite3 .cleo/tasks.db "SELECT COUNT(*) FROM tasks;"`
4. **Resume workers only after verification passes**

The `autoRecoverFromBackup` in `sqlite.ts` handles the simplest case (single-process access
post-wipe). For multi-process recovery, follow the manual steps above.
