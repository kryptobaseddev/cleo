# Migration Recovery Runbook

## Quick Reference

### Migration Failed - What to Check

1. **Check migration state**:

   ```bash
   cat .cleo/.migration-state.json
   ```

2. **Check latest log**:

   ```bash
   ls -la .cleo/logs/migration-*.jsonl | tail -1
   ```

3. **Check for backup**:

   ```bash
   ls -la .cleo/backups/safety/tasks.db.*
   ```

## Scenarios

### Scenario 1: Migration Failed, Backup Exists

**Symptoms**: Migration error, tasks.db may be corrupted or missing

**Recovery**:

```bash
# 1. Stop any running migration
# 2. Restore from backup
cp .cleo/backups/safety/tasks.db.pre-migration.<timestamp> .cleo/tasks.db

# 3. Verify restore
 cleo validate

# 4. Retry migration with verification
 cleo migrate-storage --to-sqlite --verify
```

### Scenario 2: Migration Interrupted

**Symptoms**: Process killed, migration incomplete

**Recovery**:

```bash
# 1. Check state
 cat .cleo/.migration-state.json

# 2. If phase is not 'complete', resume
 cleo migrate-storage --to-sqlite --resume

# 3. If resume fails, restore and retry
# (follow Scenario 1)
```

### Scenario 3: Concurrent Migration Conflict

**Symptoms**: "Lock acquisition failed" error

**Recovery**:

```bash
# 1. Check if another process is running
 ps aux | grep cleo

# 2. Wait for other process to complete
# OR kill if stuck

# 3. Retry migration
 cleo migrate-storage --to-sqlite
```

### Scenario 4: JSON Corruption Detected

**Symptoms**: "Parse error" in validation phase

**Recovery**:

```bash
# 1. Check which JSON file is corrupted
 cat .cleo/.migration-state.json | grep error

# 2. Fix or restore the JSON file from git/git backup
 git checkout .cleo/todo.json

# 3. Retry migration
 cleo migrate-storage --to-sqlite
```

### Scenario 5: Checksum Mismatch

**Symptoms**: "Checksum mismatch" error

**Recovery**:

```bash
# This indicates backup corruption
# 1. Check backup integrity
 sha256sum .cleo/backups/safety/tasks.db.pre-migration.*

# 2. If backup is corrupted, check if original DB still exists
 ls -la .cleo/tasks.db

# 3. If original exists, retry without --force
# If original is gone, restore from numbered backups
 cleo restore <backup-id>
```

## Prevention

### Before Migration

- Always run with --dry-run first
- Ensure backups exist: `cleo backup --list`
- Check JSON validity: `cleo validate`

### During Migration

- Don't interrupt the process
- Watch for warnings
- Check logs if issues arise

### After Migration

- Verify with: `cleo validate --full`
- Check task counts match
- Keep backups until verified

## Emergency Contacts

- CLEO issues: File at https://github.com/anomalyco/opencode/issues
- Data recovery: Check .cleo/backups/ directory
