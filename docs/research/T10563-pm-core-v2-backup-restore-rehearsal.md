# T10563 PM-Core V2 backup/restore rehearsal

Task: T10563
Saga: T10538 PM-Core V2

This runbook documents the backup/restore rehearsal that must pass before any real PM-Core V2 migration apply against a live tasks database.

## Rehearsal command

Use the core-owned rehearsal utility:

```bash
node scripts/t10563-pm-core-v2-backup-restore-rehearsal.mjs \
  --source-db <tasks.db> \
  --backup-db <fresh-pre-apply-backup.db> \
  --restore-db <isolated-restore-smoke.db> \
  --write-evidence
```

The default evidence path is:

```text
.cleo/agent-outputs/T10563-pm-core-v2-backup-restore-rehearsal.evidence.json
```

## Required sequence before real apply

1. Stop or quiesce CLEO writers for the target tasks database.
2. Run the T10563 rehearsal utility against the target database.
3. Confirm the evidence status is `pass`.
4. Confirm the fresh backup file exists and its sha256/size match the source DB snapshot captured before apply.
5. Confirm `timeline.backupBeforeApply` is `true` and `timeline.realApplyExecuted` is `false` in rehearsal evidence.
6. Only after the backup evidence is captured may an owner-approved PM-Core V2 real migration apply proceed.

## Restore smoke test

The rehearsal restores the fresh backup to an isolated smoke database, not to the live database. The smoke DB must satisfy all of these checks:

- restored DB is a separate inode from the backup;
- restored DB sha256/size match the backup before any smoke mutation;
- `PRAGMA foreign_key_check` returns zero rows on the restored DB;
- a restore-only probe table `t10563_restore_smoke_probe` can be created and read back with exactly one row;
- the source DB sha256/size/inode are unchanged after the rehearsal.

## Failure handling

If any rehearsal check fails, do not run the real PM-Core V2 apply. Keep the failed evidence JSON, inspect the foreign-key violation rows or file identity mismatch, and create follow-up work before retrying.

If a later real apply fails after owner approval, stop CLEO, restore the verified pre-apply backup to the live DB path, rerun `PRAGMA foreign_key_check`, then reopen CLEO only after the check returns zero rows.
