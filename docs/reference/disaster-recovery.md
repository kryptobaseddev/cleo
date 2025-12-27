# Disaster Recovery Guide

This guide provides step-by-step recovery procedures for various failure scenarios in the cleo system. All procedures are designed to restore your task management data with minimal loss.

---

## Overview

The cleo backup system implements a **two-tier architecture** for comprehensive data protection:

| Tier | Location | Purpose | Trigger |
|------|----------|---------|---------|
| **Tier 1 (Operational)** | `.cleo/.backups/` | Atomic write rollback | Automatic on every write |
| **Tier 2 (Recovery)** | `.cleo/backups/{type}/` | Point-in-time snapshots | Manual, scheduled, or pre-operation |

This separation provides **defense in depth**: Tier 1 protects against individual operation failures, while Tier 2 enables full system recovery.

---

## Backup Tiers Quick Reference

### Tier 1: Operational Backups

Located in `.cleo/.backups/`, these are numbered backups created automatically before every write operation:

```
.cleo/.backups/
├── todo.json.1          # Most recent (newest)
├── todo.json.2
├── todo.json.3          # Oldest
├── config.json.1
└── ...
```

- **Retention**: Last 10 backups per file (configurable)
- **Use Case**: Quick rollback from recent write failures
- **Recovery**: Manual copy (`cp .cleo/.backups/todo.json.1 .cleo/todo.json`)

### Tier 2: Typed Backups

Located in `.cleo/backups/{type}/`, these are structured backups with metadata:

```
.cleo/backups/
├── snapshot/            # Manual user snapshots
├── safety/              # Pre-destructive operation backups
├── archive/             # Pre-archive operation backups
└── migration/           # Pre-schema migration backups (never deleted)
```

Each backup directory contains:
- `metadata.json` - Backup info, checksums, timestamps
- `todo.json` - Active tasks
- `todo-archive.json` - Archived tasks
- `config.json` - Configuration
- `todo-log.json` - Audit log

---

## Recovery Scenarios

### Scenario 1: Corrupted todo.json

The most common failure is a corrupted or malformed `todo.json` file, typically caused by interrupted writes, manual editing errors, or disk issues.

#### Symptoms

- Commands fail with: `[ERROR] Invalid JSON in .cleo/todo.json`
- `jq` parsing errors when viewing the file
- `cleo list` returns JSON syntax error
- Validation shows: `JSON syntax error at line X`

#### Diagnosis

```bash
# Step 1: Check if JSON is parseable
jq empty .cleo/todo.json
# If error, JSON is corrupted

# Step 2: Identify corruption location
jq . .cleo/todo.json 2>&1 | head -5
# Shows line number and character position

# Step 3: Check file integrity
cleo validate --verbose
```

#### Recovery Steps

**Option A: Restore from Tier 1 (fastest, for recent corruption)**

```bash
# 1. List available Tier 1 backups
ls -la .cleo/.backups/todo.json.*

# 2. Validate backup is intact
jq empty .cleo/.backups/todo.json.1

# 3. Create safety copy of corrupted file
cp .cleo/todo.json .cleo/todo.json.corrupted

# 4. Restore from most recent backup
cp .cleo/.backups/todo.json.1 .cleo/todo.json

# 5. Verify restoration
cleo validate
cleo list
```

**Option B: Restore from Tier 2 (for older or comprehensive recovery)**

```bash
# 1. List available Tier 2 backups
cleo backup --list

# 2. Verify backup integrity
jq empty .cleo/backups/snapshot/snapshot_20251213_120000/todo.json

# 3. Restore from selected backup
cleo restore .cleo/backups/snapshot/snapshot_20251213_120000

# 4. Verify restoration
cleo validate
```

**Option C: Automated fix (for minor issues)**

```bash
# Try automated repair
cleo validate --fix

# If successful, verify
cleo list
```

#### Verification

```bash
# Confirm all checks pass
cleo validate

# Verify task count matches expectations
cleo stats

# Check recent log entries
cleo log --limit 10
```

#### Prevention

- Always use CLI commands instead of manual file edits
- Enable automatic backups (default behavior)
- Run `cleo validate` after any manual modifications
- Keep `maxOperationalBackups` at 10 or higher

---

### Scenario 2: Accidental Task Deletion

Tasks were inadvertently deleted through bulk operations, incorrect filtering, or user error.

#### Symptoms

- Expected tasks missing from `cleo list`
- Task count lower than expected in `cleo stats`
- Recent log shows unexpected `delete` or `complete` operations

#### Diagnosis

```bash
# Step 1: Check current task count
cleo stats

# Step 2: Review recent operations
cleo log --limit 20

# Step 3: Look for the missing task in archive
cleo list --include-archive | grep "task-title"

# Step 4: Check if task was completed (not deleted)
jq '.tasks[] | select(.title | contains("task-name"))' .cleo/todo-archive.json
```

#### Recovery Steps

**Option A: Restore from Tier 2 backup (recommended)**

```bash
# 1. Find backup from before deletion
cleo backup --list
# Look for timestamp before the deletion occurred

# 2. Preview backup contents
jq '.tasks | length' .cleo/backups/snapshot/snapshot_YYYYMMDD_HHMMSS/todo.json
jq '.tasks[].title' .cleo/backups/snapshot/snapshot_YYYYMMDD_HHMMSS/todo.json

# 3. Create current state backup
cleo backup --name "before-restore"

# 4. Restore specific file (tasks only, preserve config)
cleo restore .cleo/backups/snapshot/snapshot_YYYYMMDD_HHMMSS --file todo.json

# 5. Verify task restored
cleo list
cleo find "task-name"
```

**Option B: Selective extraction from backup**

If you only need specific tasks without full restore:

```bash
# 1. Extract task from backup
jq '.tasks[] | select(.title | contains("task-name"))' \
  .cleo/backups/snapshot/snapshot_YYYYMMDD_HHMMSS/todo.json > /tmp/task.json

# 2. Get task title
TITLE=$(jq -r '.title' /tmp/task.json)

# 3. Recreate task with original details
cleo add "$TITLE" \
  --priority $(jq -r '.priority' /tmp/task.json) \
  --status $(jq -r '.status' /tmp/task.json)
```

**Option C: Restore from Tier 1 (for very recent deletion)**

```bash
# If deletion just happened
cp .cleo/.backups/todo.json.1 .cleo/todo.json
cleo validate
```

#### Verification

```bash
# Confirm task is present
cleo find "task-name"

# Verify task count
cleo stats

# Check task details
cleo show TASK_ID
```

#### Prevention

- Create named backups before bulk operations: `cleo backup --name "before-cleanup"`
- Use `--dry-run` flags when available
- Review operations in log after bulk changes

---

### Scenario 3: Schema Migration Failure

A schema migration failed partway through, leaving data in an inconsistent state.

#### Symptoms

- Error message: `Schema version mismatch`
- Commands fail with: `Incompatible schema version`
- `cleo migrate status` shows version mismatch
- Validation errors about missing or invalid fields

#### Diagnosis

```bash
# Step 1: Check current schema version
jq '.version' .cleo/todo.json
jq '.version' .cleo/config.json

# Step 2: Check expected version
cleo migrate status

# Step 3: Identify migration backups
ls -la .cleo/backups/migration/
```

#### Recovery Steps

**Option A: Restore from migration backup (recommended)**

Migration backups are created automatically before every schema migration and are **never automatically deleted**.

```bash
# 1. List migration backups
ls -la .cleo/backups/migration/
# Example: migration_v2.1.0_to_v2.2.0_20251213_120000/

# 2. Find the pre-migration backup
# Look for the version you want to restore to

# 3. Restore from migration backup
cleo restore .cleo/backups/migration/migration_v2.1.0_to_v2.2.0_20251213_120000

# 4. Verify restoration
cleo validate

# 5. Check version is correct
jq '.version' .cleo/todo.json

# 6. Retry migration if desired
cleo migrate run --auto
```

**Option B: Repair current schema**

```bash
# 1. Create safety backup
cleo backup --name "before-repair"

# 2. Attempt automated repair
cleo migrate repair --auto

# 3. If repair fails, try fix validation
cleo validate --fix

# 4. Verify
cleo validate
```

**Option C: Manual schema fix**

For advanced users when automated tools fail:

```bash
# 1. Backup current state
cp .cleo/todo.json .cleo/todo.json.backup

# 2. Update version field manually
jq '.version = "2.2.0"' .cleo/todo.json > .cleo/todo.json.tmp
mv .cleo/todo.json.tmp .cleo/todo.json

# 3. Add missing required fields
cleo validate --fix

# 4. Verify
cleo validate
```

#### Verification

```bash
# Confirm schema version is correct
cleo migrate status

# Run full validation
cleo validate --verbose

# Test core functionality
cleo list
cleo stats
```

#### Prevention

- Always run `cleo migrate run --auto` for automated migrations
- Never manually edit version fields
- Keep migration backups indefinitely (default behavior)
- Test migrations in a copy of the project first

---

### Scenario 4: Complete Data Loss

All `.cleo/` data files are missing, corrupted beyond repair, or accidentally deleted.

#### Symptoms

- `.cleo/` directory is empty or missing
- All `todo*.json` files are gone
- `cleo list` shows no tasks or fails
- No Tier 1 backups available

#### Diagnosis

```bash
# Step 1: Check if .claude directory exists
ls -la .cleo/

# Step 2: Check for any remaining files
find .cleo/ -name "*.json" 2>/dev/null

# Step 3: Check for Tier 2 backups
ls -la .cleo/backups/ 2>/dev/null
```

#### Recovery Steps

**Option A: Restore from Tier 2 backup**

```bash
# 1. Find available backups
# Check standard location
ls -la .cleo/backups/snapshot/
ls -la .cleo/backups/migration/

# 2. If backup directory exists, list backups
cleo backup --list

# 3. Find most recent viable backup
LATEST=$(ls -td .cleo/backups/snapshot/snapshot_* 2>/dev/null | head -1)

# 4. Restore full system
cleo restore "$LATEST" --force

# 5. Verify restoration
cleo validate
cleo list
cleo stats
```

**Option B: Restore from external backup**

If you have backups stored externally (cloud, external drive):

```bash
# 1. Copy backup to local system
cp /path/to/external/backup_20251213_120000.tar.gz .cleo/backups/snapshot/

# 2. Extract if compressed
cd .cleo/backups/snapshot/
tar -xzf backup_20251213_120000.tar.gz

# 3. Restore
cleo restore .cleo/backups/snapshot/backup_20251213_120000 --force

# 4. Verify
cleo validate
```

**Option C: Reinitialize with fresh system**

If no backups are available:

```bash
# 1. Save any recoverable data
mkdir -p ~/todo-recovery
cp .cleo/*.json ~/todo-recovery/ 2>/dev/null || true

# 2. Remove corrupted directory
mv .claude .claude.corrupted

# 3. Reinitialize fresh system
cleo init

# 4. Manually recreate critical tasks
# Extract any readable task titles from corrupted files
jq -r '.tasks[]?.title // empty' ~/todo-recovery/todo.json 2>/dev/null | while read -r title; do
  [[ -n "$title" ]] && cleo add "$title"
done
```

#### Verification

```bash
# Comprehensive verification
cleo validate --verbose
cleo list
cleo stats
cleo session status
```

#### Prevention

- Configure external backup destination: `cleo backup --compress --destination ~/Dropbox/cleo`
- Schedule regular backups via cron
- Keep multiple generations of backups
- Test restore procedures periodically

---

### Scenario 5: Backup Corruption

Backup files themselves are corrupted, making restoration impossible from that backup.

#### Symptoms

- `cleo restore` fails with checksum mismatch
- `jq` cannot parse backup files
- Metadata.json shows verification errors
- Compressed tarballs fail to extract

#### Diagnosis

```bash
# Step 1: Verify backup integrity
cleo backup verify .cleo/backups/snapshot/snapshot_20251213_120000

# Step 2: Test JSON parsing
jq empty .cleo/backups/snapshot/snapshot_20251213_120000/todo.json

# Step 3: Check metadata checksums
jq '.checksums' .cleo/backups/snapshot/snapshot_20251213_120000/metadata.json

# Step 4: Recalculate checksum and compare
sha256sum .cleo/backups/snapshot/snapshot_20251213_120000/todo.json
```

#### Recovery Steps

**Option A: Use different backup**

```bash
# 1. List all available backups
cleo backup --list

# 2. Test each backup until finding valid one
for backup in .cleo/backups/snapshot/snapshot_*; do
  echo "Testing: $backup"
  if jq empty "$backup/todo.json" 2>/dev/null; then
    echo "Valid: $backup"
    break
  fi
done

# 3. Restore from valid backup
cleo restore .cleo/backups/snapshot/snapshot_VALID --force
```

**Option B: Skip checksum verification (use with caution)**

If the data appears valid but checksums don't match:

```bash
# 1. Manually verify backup data looks correct
jq '.tasks | length' .cleo/backups/snapshot/snapshot_20251213_120000/todo.json
jq '.tasks[0]' .cleo/backups/snapshot/snapshot_20251213_120000/todo.json

# 2. Manual restore (bypassing checksum)
cleo backup --name "before-manual-restore"
cp .cleo/backups/snapshot/snapshot_20251213_120000/*.json .cleo/

# 3. Validate restored files
cleo validate --fix

# 4. Verify
cleo list
```

**Option C: Partial recovery from corrupted backup**

```bash
# 1. Try to extract what's readable
# Some JSON files may be valid even if others are not
for file in todo.json todo-archive.json config.json; do
  if jq empty ".cleo/backups/snapshot/snapshot_20251213_120000/$file" 2>/dev/null; then
    echo "Extracting valid file: $file"
    cp ".cleo/backups/snapshot/snapshot_20251213_120000/$file" ".cleo/$file"
  fi
done

# 2. Initialize missing files
cleo validate --fix

# 3. Verify partial recovery
cleo validate
```

**Option D: Recover from compressed backup**

```bash
# 1. Test tarball integrity
tar -tzf .cleo/backups/snapshot/snapshot_20251213_120000.tar.gz

# 2. If listing works, extract
mkdir -p /tmp/backup-test
tar -xzf .cleo/backups/snapshot/snapshot_20251213_120000.tar.gz -C /tmp/backup-test

# 3. Verify extracted files
jq empty /tmp/backup-test/*.json

# 4. Copy valid files
cp /tmp/backup-test/*.json .cleo/

# 5. Validate
cleo validate
```

#### Verification

```bash
# After any recovery
cleo validate --verbose
cleo list
cleo stats
```

#### Prevention

- Run `cleo backup verify` periodically
- Keep multiple backup copies (default: 5 snapshots)
- Use `--compress` for long-term archival
- Store backups on different physical media
- Test restore procedures quarterly

---

## Recovery Commands Reference

### Backup Management

| Command | Description |
|---------|-------------|
| `cleo backup` | Create manual snapshot backup |
| `cleo backup --name NAME` | Create named snapshot for context |
| `cleo backup --list` | List all available Tier 2 backups |
| `cleo backup --list --type snapshot` | List only snapshot backups |
| `cleo backup --compress` | Create compressed tarball backup |
| `cleo backup verify BACKUP_PATH` | Verify backup integrity |

### Restoration

| Command | Description |
|---------|-------------|
| `cleo restore BACKUP_PATH` | Restore from backup with confirmation |
| `cleo restore BACKUP_PATH --force` | Restore without confirmation |
| `cleo restore BACKUP_PATH --file FILE` | Restore only specific file |
| `cleo restore BACKUP_PATH --verbose` | Show detailed restore progress |

### Validation and Repair

| Command | Description |
|---------|-------------|
| `cleo validate` | Check file integrity and schema |
| `cleo validate --verbose` | Detailed validation output |
| `cleo validate --fix` | Attempt automated repairs |
| `cleo migrate status` | Check schema version status |
| `cleo migrate run --auto` | Run pending migrations |
| `cleo migrate repair --auto` | Repair schema structure |

### Tier 1 Manual Recovery

| Command | Description |
|---------|-------------|
| `ls -la .cleo/.backups/` | List Tier 1 operational backups |
| `cp .cleo/.backups/todo.json.1 .cleo/todo.json` | Manual restore from Tier 1 |
| `jq empty .cleo/.backups/todo.json.1` | Validate Tier 1 backup |

### Diagnosis

| Command | Description |
|---------|-------------|
| `jq empty .cleo/todo.json` | Test JSON syntax |
| `jq '.version' .cleo/todo.json` | Check schema version |
| `cleo stats` | View task counts |
| `cleo log --limit 20` | View recent operations |

---

## Prevention Best Practices

### Backup Schedule

| Scenario | Frequency | Method |
|----------|-----------|--------|
| Active development | Before each session | `cleo backup --name "session-start"` |
| Daily operations | Once per day | Automated cron with `--compress` |
| Before bulk changes | Immediately before | `cleo backup --name "before-X"` |
| Long-term archival | Weekly/monthly | `--compress --destination external` |

### Backup Verification

```bash
# Weekly verification script
#!/usr/bin/env bash
for backup in .cleo/backups/snapshot/snapshot_*; do
  if [[ -d "$backup" ]]; then
    echo "Verifying: $backup"
    for file in "$backup"/*.json; do
      if ! jq empty "$file" 2>/dev/null; then
        echo "CORRUPT: $file"
      fi
    done
  fi
done
```

### Configuration Recommendations

```bash
# Set appropriate retention
cleo config set backup.maxSnapshots 10
cleo config set backup.maxSafetyBackups 5
cleo config set backup.safetyRetentionDays 14

# Verify settings
cleo config get backup
```

### External Backup Strategy

```bash
# Daily external backup (add to cron)
0 2 * * * cd /path/to/project && cleo backup --compress --destination ~/Dropbox/backups/cleo/

# Monthly offsite backup
0 3 1 * * cd /path/to/project && cleo backup --compress --name "monthly-$(date +%Y%m)" --destination /mnt/external/
```

---

## Troubleshooting

### Common Issues During Recovery

#### Issue: "Backup source does not exist"

**Cause**: Incorrect path or backup was deleted by retention policy.

**Solution**:
```bash
# Verify correct path
ls -la .cleo/backups/snapshot/

# List available backups
cleo backup --list

# Check backup directory exists
ls -la .cleo/backups/
```

#### Issue: "Checksum verification failed"

**Cause**: Backup file was modified or corrupted after creation.

**Solution**:
```bash
# Recalculate and compare checksums
sha256sum .cleo/backups/snapshot/snapshot_*/todo.json
jq '.checksums."todo.json"' .cleo/backups/snapshot/snapshot_*/metadata.json

# If mismatch but data looks valid, manual restore:
cp .cleo/backups/snapshot/snapshot_VALID/*.json .cleo/
cleo validate --fix
```

#### Issue: "Permission denied" during restore

**Cause**: File or directory permissions are too restrictive.

**Solution**:
```bash
# Fix directory permissions
chmod 755 .cleo/
chmod 644 .cleo/*.json

# Fix backup directory permissions
chmod 755 .cleo/backups/
chmod 755 .cleo/backups/snapshot/
chmod 644 .cleo/backups/snapshot/*/*.json
```

#### Issue: "Restore rolled back" after failure

**Cause**: Post-restore validation detected issues.

**Solution**:
```bash
# Check what caused the rollback
cleo restore BACKUP_PATH --verbose

# If backup has issues, use different backup
cleo backup --list

# Check safety backup created during restore attempt
ls -la .cleo/backups/safety/pre-restore_*
```

#### Issue: No backups available

**Cause**: Backups disabled, retention deleted them, or first-time use.

**Solution**:
```bash
# Check if backups are enabled
cleo config get backup.enabled

# Check Tier 1 backups (always created)
ls -la .cleo/.backups/

# If all else fails, reinitialize
cleo init
```

---

## Related Documentation

- [Troubleshooting Guide](troubleshooting.md) - General troubleshooting procedures
- [Backup Command Reference](../commands/backup.md) - Detailed backup command documentation
- [Restore Command Reference](../commands/restore.md) - Detailed restore command documentation
- [Validate Command Reference](../commands/validate.md) - Validation and repair procedures
- [Backup System Specification](../specs/BACKUP-SYSTEM-SPEC.md) - Technical specification

---

## Emergency Contacts

If automated recovery fails:

1. **Save current state**: `cp -r .claude ~/claude-emergency-backup/`
2. **Collect diagnostics**: `cleo validate --verbose 2>&1 > ~/diagnostic.log`
3. **Check logs**: `cleo log --limit 50 > ~/recent-operations.log`
4. **Report issue**: Include diagnostic output and steps to reproduce

---

**Last Updated**: 2025-12-22
