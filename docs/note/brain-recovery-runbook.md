---
slug: brain-recovery-runbook
type: note
task: T10304
epic: T10286
saga: T10281
description: "Operator runbook: brain.db recovery procedure"
---

# Brain.db Recovery Runbook

**Task**: T10304
**Epic**: T10286 E5-BRAIN-P0-HOTFIX
**Saga**: T10281 SG-BRAIN-DB-RESILIENCE
**Verb**: `cleo backup recover brain`
**Producer task**: T10303 (pipeline wired into `getBrainDb()` chokepoint)

## When this verb is needed

Run `cleo backup recover brain` when ANY of these signals appear:

- `cleo memory observe ...` returns `E_BRAIN_OBSERVE` with the cause chain
  containing `ERR_SQLITE_ERROR errcode=11`.
- `sqlite3 .cleo/brain.db 'PRAGMA integrity_check;'` returns
  `malformed database schema (...) (11)` or anything other than `ok`.
- `sqlite3 .cleo/brain.db 'PRAGMA quick_check;'` returns a row with a value
  other than `ok`.
- Agent sessions silently fail to persist learnings/decisions/observations
  while every other CLEO command works fine.
- `cleo doctor` flags brain.db with `E_DB_MALFORMED` (T10282 follow-up).

The brain.db open chokepoint (`packages/core/src/store/memory-sqlite.ts:getBrainDb`)
already auto-recovers on the next open via the same pipeline. This verb
exists for two scenarios the chokepoint does NOT cover:

1. **Pre-emptive recovery** before the next session-start so the next agent
   doesn't lose its memory writes between detection and the next open.
2. **Pinned restore** via `--from-snapshot <iso>` when the auto-recovery
   picked a snapshot that is also poisoned.

## Pre-conditions

The recovery pipeline tries three candidate sources in order. At least ONE
must be present:

| Source              | Path                                                                                                  | Created by                          |
|---------------------|-------------------------------------------------------------------------------------------------------|-------------------------------------|
| System snapshot     | `.cleo/backups/snapshot/brain.db.snapshot-<ISO>`                                                      | `cleo backup add`                   |
| VACUUM INTO         | `.cleo/backups/sqlite/brain-YYYYMMDD-HHmmss.db`                                                       | `cleo session end` (debounced hook) |
| PRE-DUP-FIX legacy  | `.cleo/brain.db.PRE-DUP-FIX-<n>`                                                                      | T9685 one-shot migration            |

Verify pre-conditions:

```bash
ls -lt .cleo/backups/snapshot/brain.db.snapshot-* 2>/dev/null | head -5
ls -lt .cleo/backups/sqlite/brain-*.db 2>/dev/null | head -5
ls -lt .cleo/brain.db.PRE-DUP-FIX-* 2>/dev/null | head -5
```

If all three return empty, the verb will exit with `E_NO_SNAPSHOT` (4) and
you must follow the manual fallback below.

## Usage

### Step 1: Preview with `--dry-run`

```bash
cleo backup recover brain --dry-run
```

The plan envelope shows:

- `restoredFrom` — absolute path of the snapshot that would be restored.
- `dataLossWindowHours` — approximate hours between snapshot and now.
- `rowsRecovered.observations` / `decisions` / `learnings` — counts probed
  from the snapshot.
- `integrityOK: true` — the chosen snapshot passes `PRAGMA quick_check`.
- `quarantinedTo: ""` — empty in dry-run mode (no files touched).
- `dryRun: true` — confirms this was a plan, NOT a mutation record.

If `dataLossWindowHours` is too high (e.g. > 24h) and you have an older
snapshot you trust, pin it with `--from-snapshot`.

### Step 2: Execute recovery

```bash
cleo backup recover brain
```

On success the envelope shows:

- `restoredFrom` — the snapshot that was actually restored.
- `quarantinedTo` — absolute path to the directory where the corrupt DB
  plus its `-wal` / `-shm` sidecars were moved.
- `integrityOK: true` — restored DB passes `PRAGMA quick_check`.
- `dryRun: false`.

### Step 3: Verify

```bash
sqlite3 .cleo/brain.db 'PRAGMA integrity_check; SELECT COUNT(*) FROM brain_observations;'
cleo memory find "<recent topic>"
```

### Optional flags

| Flag                       | Purpose                                                                                                     |
|----------------------------|-------------------------------------------------------------------------------------------------------------|
| `--dry-run`                | Print plan envelope without quarantining or copying. Default `false`.                                       |
| `--from-snapshot <pin>`    | Pin recovery to a specific snapshot — accepts an absolute path OR an ISO timestamp prefix (`2026-05-23`).   |
| `--no-delta`               | Skip the `sqlite3 .recover` delta-merge step. Default `false`. NOTE: the current pipeline does not perform delta-merge because T10300 found schema-page corruption makes it unreliable. The flag is plumbed end-to-end for forward-compat when delta-merge becomes opt-in. |
| `--force`                  | Bypass safety prompts. Reserved — currently a no-op.                                                        |

## Exit codes

| Code | Name                 | Meaning                                                                                       |
|------|----------------------|-----------------------------------------------------------------------------------------------|
| 0    | SUCCESS              | Snapshot restored OR dry-run plan emitted.                                                    |
| 1    | E_RECOVERY_FAILED    | Pipeline ran but restored DB failed final integrity check, or unexpected runtime error.       |
| 4    | E_NO_SNAPSHOT        | No snapshots present in any of the three candidate sources.                                   |
| 4    | E_NO_SNAPSHOT_MATCH  | `--from-snapshot <pin>` did not match any candidate.                                          |
| 6    | E_VALIDATION         | Missing required arg (`corruptPath` empty). Programmer error — file a bug.                    |
| 78   | E_NO_VALID_SNAPSHOT  | Every available snapshot is itself corrupt — none pass `PRAGMA quick_check`.                  |

## Data-loss expectations

The recovery pipeline restores the freshest validated snapshot, so memory
writes that occurred between the snapshot's timestamp and the malformation
event are LOST. The envelope's `dataLossWindowHours` quantifies this for
the operator. There is no rollback.

- System snapshots are written manually via `cleo backup add` (rare).
- VACUUM INTO snapshots are written on `cleo session end` debounced hooks
  (every session end, rotated to 10 retained per DB). These are typically
  the freshest source and the one most often chosen.
- PRE-DUP-FIX artifacts are last-resort legacy snapshots and may be days
  or weeks old.

To minimize data-loss windows in the future:

```bash
# Run this any time before a high-risk operation:
cleo backup add
```

## Manual fallback (when the verb fails)

If `cleo backup recover brain` exits with `E_NO_VALID_SNAPSHOT` or
`E_RECOVERY_FAILED`, follow the manual procedure executed in Saga T10281
Wave 0 AC1:

```bash
# 1. Move the corrupt DB out of the way.
mkdir -p .cleo/quarantine/brain-malformed-$(date -u +%Y%m%dT%H%M%SZ)
mv .cleo/brain.db .cleo/quarantine/brain-malformed-*/brain.db.malformed
mv .cleo/brain.db-wal .cleo/quarantine/brain-malformed-*/brain.db-wal 2>/dev/null
mv .cleo/brain.db-shm .cleo/quarantine/brain-malformed-*/brain.db-shm 2>/dev/null

# 2. List candidate snapshots, sorted newest-first.
ls -1t .cleo/backups/snapshot/brain.db.snapshot-* \
       .cleo/backups/sqlite/brain-*.db \
       .cleo/brain.db.PRE-DUP-FIX-* 2>/dev/null

# 3. Probe each candidate manually for integrity.
for f in $(ls -1t .cleo/backups/snapshot/brain.db.snapshot-* 2>/dev/null); do
  echo "=== $f ==="
  sqlite3 "$f" 'PRAGMA quick_check;'
done

# 4. Copy the freshest `ok` candidate into place.
cp .cleo/backups/snapshot/brain.db.snapshot-<chosen-iso> .cleo/brain.db

# 5. Final verification.
sqlite3 .cleo/brain.db 'PRAGMA integrity_check;'

# 6. Re-attempt the failed operation.
cleo memory observe "post-recovery smoke test" --title "T10304 manual recovery"
```

If NO snapshot probes clean, escalate to the owner — the corruption pre-dates
all available snapshots and the BRAIN must be restored from external backup
(`cleo backup import <bundle>`).

## Related

- T10303 (sister task) — wires the pipeline into the brain.db open
  chokepoint for automatic detection + recovery.
- T10282 (sibling Epic E1-DB-INVENTORY) — adds `cleo doctor` checks for
  `PRAGMA integrity_check` failures on every CLEO DB.
- T10284 (sibling Epic E3-BACKUP-RECOVERY) — broader backup/recovery
  hardening across all CLEO DBs.
- ADR-068 (DB Open Guard) — every recovery probe flows through
  `openNativeDatabase()` so pragma SSoT (`specs/sqlite-pragmas.json`) stays
  in force.
