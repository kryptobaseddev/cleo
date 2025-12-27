# restore Command

Restore todo system files from backups with automatic validation, safety backups, and rollback capability.

## Usage

```bash
cleo restore <backup-source> [OPTIONS]
```

## Description

The `restore` command safely restores your todo system from a previous backup, whether stored as a directory or compressed tarball. Every restore operation includes automatic safety measures to prevent data loss.

This command is essential for:
- Recovering from accidental data corruption or deletion
- Rolling back failed migrations or bulk operations
- Testing experimental workflows by reverting to known good state
- Migrating data between systems or environments
- Recovering specific files without a full restore

All restore operations create a pre-restore safety backup, validate file integrity before and after restoration, and automatically rollback if any validation fails.

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `<backup-source>` | **Required**: Path to backup directory or .tar.gz file | (none) |
| `--file FILE` | Restore only specific file (selective restore) | (restore all) |
| `--force` | Skip confirmation prompt (non-interactive mode) | `false` |
| `--verbose` | Show detailed debug output | `false` |
| `--help, -h` | Show help message | |

## Restorable Files

The restore command can restore any or all of these files:

- `todo.json` - Active tasks and focus state
- `todo-archive.json` - Completed and archived tasks
- `config.json` - Configuration and settings
- `todo-log.json` - Audit trail and session history

## Restore Process

The restore command follows a strict safety protocol:

1. **Validation**: Verify backup source exists and is valid
2. **Extraction**: Extract tarball if needed (for .tar.gz backups)
3. **Information Display**: Show backup metadata and file list
4. **Confirmation**: Prompt for user approval (unless `--force` used)
5. **Safety Backup**: Create pre-restore backup of current state
6. **File Restoration**: Copy files from backup with validation
7. **Post-Validation**: Verify all restored files are valid JSON
8. **Rollback on Failure**: Automatic revert if any step fails
9. **Success Report**: Display restored files and safety backup location

## Examples

### Basic Restore from Directory

```bash
# 1. List available backups
cleo backup --list

# 2. Restore from Tier 2 snapshot backup
cleo restore .cleo/backups/snapshot/snapshot_20251213_120000
```

Output:
```
╔══════════════════════════════════════════════════════════╗
║                  BACKUP INFORMATION                      ║
╚══════════════════════════════════════════════════════════╝

  Backup Name: snapshot_20251213_120000
  Timestamp: 2025-12-13T12:00:00Z
  Created By: developer@dev-machine

  Files:
    ✓ todo.json
    ✓ todo-archive.json
    ✓ config.json
    ✓ todo-log.json

⚠  WARNING: This will overwrite current todo system files!

Are you sure you want to restore from this backup? (yes/no): yes

[INFO] Creating safety backup before restore...
[INFO] Safety backup created: .cleo/backups/safety/pre-restore_20251213_143000
[INFO] Restoring files...
[INFO] ✓ Restored todo.json
[INFO] ✓ Restored todo-archive.json
[INFO] ✓ Restored config.json
[INFO] ✓ Restored todo-log.json
[INFO] Validating restored files...

╔══════════════════════════════════════════════════════════╗
║              RESTORE COMPLETED SUCCESSFULLY              ║
╚══════════════════════════════════════════════════════════╝

  Restored Files:
    ✓ todo.json
    ✓ todo-archive.json
    ✓ config.json
    ✓ todo-log.json

  Safety Backup:
    .cleo/backups/safety/pre-restore_20251213_143000
    (Can be removed if restore is satisfactory)
```

### Restore from Compressed Backup

```bash
# Restore from .tar.gz archive
cleo restore .cleo/backups/snapshot/snapshot_20251213_120000.tar.gz
```

The restore command automatically:
1. Detects the tarball format
2. Extracts to temporary directory
3. Validates extracted files
4. Performs standard restore process
5. Cleans up temporary extraction

Output includes same safety measures and validation as directory restore.

### Selective File Restoration

```bash
# Restore only active tasks, keep everything else
cleo restore .cleo/backups/snapshot/snapshot_20251213_120000 --file todo.json
```

Output:
```
╔══════════════════════════════════════════════════════════╗
║                  BACKUP INFORMATION                      ║
╚══════════════════════════════════════════════════════════╝

  Backup Location: .cleo/backups/snapshot/snapshot_20251213_120000

  Files:
    ✓ todo.json
    ✓ todo-archive.json
    ✓ config.json
    ✓ todo-log.json

⚠  WARNING: This will overwrite current todo system files!

Are you sure you want to restore from this backup? (yes/no): yes

[INFO] Creating safety backup before restore...
[INFO] Safety backup created: .cleo/backups/safety/pre-restore_20251213_143500
[INFO] Restoring files...
[INFO] ✓ Restored todo.json
[INFO] Validating restored files...

╔══════════════════════════════════════════════════════════╗
║              RESTORE COMPLETED SUCCESSFULLY              ║
╚══════════════════════════════════════════════════════════╝

  Restored Files:
    ✓ todo.json

  Safety Backup:
    .cleo/backups/safety/pre-restore_20251213_143500
    (Can be removed if restore is satisfactory)
```

**Valid file options**:
- `todo.json`
- `todo-archive.json`
- `config.json`
- `todo-log.json`

### Non-Interactive Restore

```bash
# Skip confirmation prompt for automation
cleo restore .cleo/backups/snapshot/snapshot_20251213_120000 --force
```

Use cases:
- Automated recovery scripts
- CI/CD pipeline restoration
- Emergency recovery procedures
- Testing environments

**Warning**: `--force` bypasses the confirmation prompt. Ensure you have verified the backup source before using this option.

### Verbose Restore

```bash
# Show detailed debug information
cleo restore .cleo/backups/snapshot/snapshot_20251213_120000 --verbose
```

Output:
```
[DEBUG] Valid directory backup detected
╔══════════════════════════════════════════════════════════╗
║                  BACKUP INFORMATION                      ║
╚══════════════════════════════════════════════════════════╝

  Backup Name: snapshot_20251213_120000
  Timestamp: 2025-12-13T12:00:00Z
  Created By: developer@dev-machine

  Files:
    ✓ todo.json
    ✓ todo-archive.json
    ✓ config.json
    ✓ todo-log.json

⚠  WARNING: This will overwrite current todo system files!

Are you sure you want to restore from this backup? (yes/no): yes

[INFO] Creating safety backup before restore...
[DEBUG] Backed up todo.json
[DEBUG] Backed up todo-archive.json
[DEBUG] Backed up config.json
[DEBUG] Backed up todo-log.json
[INFO] Safety backup created: .cleo/backups/safety/pre-restore_20251213_144000
[INFO] Restoring files...
[DEBUG] Created directory: .claude
[DEBUG] todo.json validated successfully
[INFO] ✓ Restored todo.json
[DEBUG] todo-archive.json validated successfully
[INFO] ✓ Restored todo-archive.json
[DEBUG] config.json validated successfully
[INFO] ✓ Restored config.json
[DEBUG] todo-log.json validated successfully
[INFO] ✓ Restored todo-log.json
[INFO] Validating restored files...
[DEBUG] todo.json validated successfully
[DEBUG] todo-archive.json validated successfully
[DEBUG] config.json validated successfully
[DEBUG] todo-log.json validated successfully

╔══════════════════════════════════════════════════════════╗
║              RESTORE COMPLETED SUCCESSFULLY              ║
╚══════════════════════════════════════════════════════════╝

  Restored Files:
    ✓ todo.json
    ✓ todo-archive.json
    ✓ config.json
    ✓ todo-log.json

  Safety Backup:
    .cleo/backups/safety/pre-restore_20251213_144000
    (Can be removed if restore is satisfactory)
```

**Use cases**:
- Troubleshooting restore failures
- Understanding validation process
- Debugging backup integrity issues
- Verifying safety backup creation

### Combined Options

```bash
# Non-interactive selective restore with verbose output
cleo restore \
  .cleo/backups/snapshot/snapshot_20251213_120000.tar.gz \
  --file todo.json \
  --force \
  --verbose
```

## Restore Procedures

### Emergency Recovery

When current files are corrupted or deleted:

```bash
# 1. Find latest backup
cleo backup --list

# 2. Restore immediately with force (skip confirmation)
cleo restore .cleo/backups/snapshot/snapshot_20251213_120000 --force

# 3. Validate restored system
cleo validate
cleo list
```

### Rollback After Failed Migration

```bash
# Before migration
cleo backup --name "before-migration"

# ... migration fails ...

# Restore to pre-migration state
cleo restore .cleo/backups/snapshot/snapshot_*_before-migration --force
cleo validate
```

### Selective Configuration Restore

```bash
# Restore only config, keep current tasks and log
cleo restore .cleo/backups/snapshot/snapshot_20251213_120000 --file config.json

# Verify configuration
jq '.' .cleo/config.json
```

### Cross-System Migration

```bash
# On source system
cleo backup --compress --name "migration"
scp .cleo/backups/snapshot/snapshot_*_migration.tar.gz newhost:~/

# On target system
mkdir -p .cleo/backups/snapshot
mv ~/backup_*_migration.tar.gz .cleo/backups/snapshot/
cleo restore .cleo/backups/snapshot/snapshot_*_migration.tar.gz --force
cleo validate
```

### Testing Workflow Recovery

```bash
# Create checkpoint before experimental changes
cleo backup --name "checkpoint"

# ... make experimental changes ...

# Changes didn't work? Restore checkpoint
cleo restore .cleo/backups/snapshot/snapshot_*_checkpoint --force

# Continue working from known good state
cleo list
```

### Restore from External Backup

```bash
# Restore from external backup location
cleo restore ~/Dropbox/backups/backup_20251213_120000.tar.gz

# Or from network storage
cleo restore /mnt/backup-server/cleo/backup_20251213_120000
```

## Safety Features

### Pre-Restore Safety Backup

Every restore operation automatically creates a safety backup before making any changes:

```bash
.cleo/backups/safety/pre-restore_YYYYMMDD_HHMMSS/
├── todo.json
├── todo-archive.json
├── config.json
└── todo-log.json
```

This allows you to:
- Undo the restore if needed
- Compare before/after states
- Recover if restore goes wrong
- Maintain audit trail

**Cleanup**: After verifying restore success, you can manually remove safety backups:
```bash
# List safety backups
ls -ld .cleo/backups/safety/pre-restore_*

# Remove after verification
rm -rf .cleo/backups/safety/pre-restore_20251213_143000
```

### Validation Pipeline

The restore command validates files at three checkpoints:

**1. Backup Source Validation**:
- Directory exists and contains JSON files
- Tarball is valid and extractable
- Required files are present

**2. Pre-Restore Validation**:
- Each backup file has valid JSON syntax
- File structure matches expected schema
- No corruption detected

**3. Post-Restore Validation**:
- All restored files have valid JSON
- Files are readable and complete
- Integrity checks pass

If any validation fails, the entire restore is rolled back.

### Automatic Rollback

When restore fails, automatic rollback preserves system integrity:

```bash
[ERROR] Backup file validation failed: todo.json
[ERROR] Restore failed with 1 errors
[WARN] Rolling back restore operation...
[DEBUG] Rolled back todo.json
[DEBUG] Rolled back todo-archive.json
[DEBUG] Rolled back config.json
[DEBUG] Rolled back todo-log.json
[INFO] Rollback completed successfully
[ERROR] Restore rolled back to original state
```

Rollback scenarios:
- Corrupted backup files
- JSON syntax errors
- Missing required files
- Validation failures
- File system errors

### Atomic Operations

Restore operations are atomic per file:
1. Validate source file completely
2. Copy to destination only if valid
3. Validate destination file
4. Rollback all changes on any failure

This prevents partial corruption and ensures system consistency.

## Recovery Scenarios

### Scenario 1: Accidental Task Deletion

**Problem**: Accidentally deleted all tasks with bulk operation

**Solution**:
```bash
# Find backup before deletion
cleo backup --list

# Restore from last good backup
cleo restore .cleo/backups/snapshot/snapshot_20251213_120000 --force

# Verify tasks recovered
cleo list
```

### Scenario 2: Corrupted Configuration

**Problem**: Manual edit broke config.json

**Solution**:
```bash
# Restore only configuration
cleo restore .cleo/backups/snapshot/snapshot_20251213_120000 --file config.json --force

# Verify configuration
cleo validate
jq '.' .cleo/config.json
```

### Scenario 3: Failed Archive Operation

**Problem**: Archive operation corrupted task data

**Solution**:
```bash
# Restore to pre-archive state
cleo restore .cleo/backups/snapshot/snapshot_*_before-archive --force

# Verify all tasks present
cleo list --status done
cleo stats
```

### Scenario 4: Lost Session History

**Problem**: Need to recover audit trail from previous week

**Solution**:
```bash
# Find backup from target date
cleo backup --list

# Restore only log file
cleo restore .cleo/backups/snapshot/snapshot_20251206_180000 --file todo-log.json

# Verify log entries
jq '.entries[] | select(.timestamp >= "2025-12-06")' .cleo/todo-log.json
```

### Scenario 5: Experimental Workflow Gone Wrong

**Problem**: Tried new workflow approach, broke task relationships

**Solution**:
```bash
# Created checkpoint before experiment
# Restore checkpoint
cleo restore .cleo/backups/snapshot/snapshot_*_experiment-checkpoint --force

# Validate dependencies restored
cleo deps tree
cleo validate
```

### Scenario 6: Complete System Corruption

**Problem**: All JSON files corrupted or deleted

**Solution**:
```bash
# Emergency restore from latest backup
LATEST=$(ls -td .cleo/backups/snapshot/snapshot_* | head -1)
cleo restore "$LATEST" --force

# Comprehensive validation
cleo validate
cleo list
cleo stats
```

## Troubleshooting

### Restore Fails: Backup Not Found

```bash
# Error message
[ERROR] Backup source does not exist: .cleo/backups/snapshot/snapshot_20251213_120000
```

**Solution**:
```bash
# Verify backup location
ls -la .cleo/backups/

# List available backups
cleo backup --list

# Use correct backup path
cleo restore .cleo/backups/snapshot/snapshot_20251213_120000
```

### Restore Fails: Invalid Tarball

```bash
# Error message
[ERROR] Invalid or corrupted tarball: backup_20251213_120000.tar.gz
```

**Solution**:
```bash
# Test tarball integrity
tar -tzf .cleo/backups/snapshot/snapshot_20251213_120000.tar.gz

# If corrupted, use different backup
cleo backup --list

# Try directory backup instead
cleo restore .cleo/backups/snapshot/snapshot_20251212_180000
```

### Restore Fails: Validation Error

```bash
# Error message
[ERROR] Backup file validation failed: todo.json
[ERROR] Restore failed with 1 errors
```

**Solution**:
```bash
# Check backup file integrity with verbose mode
cleo restore .cleo/backups/snapshot/snapshot_20251213_120000 --verbose

# Verify JSON syntax manually
jq empty .cleo/backups/snapshot/snapshot_20251213_120000/todo.json

# If backup is corrupt, use older backup
cleo backup --list
cleo restore .cleo/backups/snapshot/snapshot_20251212_180000
```

### Rollback Fails After Restore Error

```bash
# Error message
[ERROR] Rollback failed - manual intervention required
[ERROR] Safety backup available at: .cleo/backups/safety/pre-restore_20251213_143000
```

**Solution**:
```bash
# Manually restore from safety backup
SAFETY_BACKUP=".cleo/backups/safety/pre-restore_20251213_143000"
cp "$SAFETY_BACKUP"/*.json .cleo/

# Validate manually restored files
cleo validate

# If still broken, use known good backup
cleo restore .cleo/backups/snapshot/snapshot_20251212_180000 --force
```

### Permission Denied Errors

```bash
# Error message
[ERROR] Failed to restore todo.json
```

**Solution**:
```bash
# Check file permissions
ls -la .cleo/

# Fix permissions
chmod 755 .cleo/
chmod 644 .cleo/*.json

# Retry restore
cleo restore .cleo/backups/snapshot/snapshot_20251213_120000
```

### Restore from External Drive Not Recognized

```bash
# Error message
[ERROR] Backup source does not exist: /media/backup/backup_20251213_120000
```

**Solution**:
```bash
# Verify mount point
mount | grep /media/backup

# Check path exists
ls /media/backup/

# Use absolute path
cleo restore /media/backup/backup_20251213_120000
```

### Missing Files in Backup

```bash
# During restore
[WARN] todo-archive.json not found in backup, skipping
```

**Explanation**: Some backups may not contain all files (e.g., pre-archive backups without archive file)

**Solution**:
```bash
# This is normal - restore continues with available files
# Verify what was restored
cleo list
cleo validate

# If missing file is critical, restore from different backup
cleo backup --list
cleo restore .cleo/backups/snapshot/snapshot_20251213_150000
```

## Best Practices

### Verification After Restore

Always validate the restored system:

```bash
# After any restore operation
cleo validate          # Check file integrity
cleo list              # Verify tasks visible
cleo stats             # Check counts match expectations
cleo session status    # Verify session state
```

### Safety Backup Cleanup

Manage safety backups to avoid clutter:

```bash
# After verifying restore success, clean up safety backups
ls -ld .cleo/backups/safety/pre-restore_*

# Remove old safety backups (keep recent ones)
find .cleo/.backups -name "pre-restore_*" -mtime +7 -exec rm -rf {} \;
```

### Backup Before Restore

Create a current backup before restoring older state:

```bash
# Defensive restore procedure
cleo backup --name "before-restore"
cleo restore .cleo/backups/snapshot/snapshot_20251213_120000
cleo validate
```

### Test Restore Procedures

Periodically test restore capability:

```bash
# Monthly restore test in test directory
mkdir -p ~/test-restore
cd ~/test-restore

# Copy backup to test location
cp -r /path/to/project/.cleo/backups/snapshot/snapshot_latest .

# Test restore
cleo init
cleo restore backup_latest --force
cleo validate
```

### Document Restore Points

Add context to backups for easier recovery:

```bash
# Create well-named backups before major changes
cleo backup --name "before-sprint-12-changes"
cleo backup --name "before-refactor-dependencies"
cleo backup --name "working-state-2025-12-13"

# Makes finding correct restore point easier
cleo backup --list
```

### Selective Restore Strategy

Restore only what you need:

```bash
# Instead of full restore, restore specific files
cleo restore backup --file todo.json      # Just tasks
cleo restore backup --file config.json  # Just config

# Preserves other current data
```

### Automation Best Practices

For automated restore operations:

```bash
#!/usr/bin/env bash
# automated-restore.sh

# Always use --force for automation
# Always use --verbose for logging
# Always validate after restore

BACKUP_SOURCE="$1"

if [[ -z "$BACKUP_SOURCE" ]]; then
  echo "Usage: $0 <backup-source>"
  exit 1
fi

# Restore with logging
cleo restore "$BACKUP_SOURCE" --force --verbose 2>&1 | tee restore.log

# Validate results
if cleo validate; then
  echo "Restore successful and validated"
  exit 0
else
  echo "Restore validation failed"
  exit 1
fi
```

## Use Cases

### Development Workflow

```bash
# Safe experimental workflow
alias ct-checkpoint='cleo backup --name "checkpoint"'
alias ct-restore-checkpoint='cleo restore .cleo/backups/snapshot/snapshot_*_checkpoint --force'

# Work session
ct-checkpoint
# ... make experimental changes ...
# Didn't work? Restore
ct-restore-checkpoint
```

### CI/CD Pipeline

```bash
# Restore test environment from known good state
restore-test-env() {
  local backup_source="${1:-.cleo/backups/snapshot/test-baseline.tar.gz}"

  cleo restore "$backup_source" --force
  cleo validate || exit 1

  echo "Test environment ready"
}
```

### Data Migration

```bash
# Migrate from old to new system
# On old system
cleo backup --compress --destination ~/migration
scp ~/migration/backup_*.tar.gz newhost:~/

# On new system
cleo init
cleo restore ~/backup_*.tar.gz --force
cleo validate
cleo list
```

### Disaster Recovery

```bash
# Emergency recovery script
disaster-recovery() {
  # Find latest good backup
  LATEST=$(ls -td .cleo/backups/snapshot/snapshot_*.tar.gz | head -1)

  if [[ -z "$LATEST" ]]; then
    echo "No backups found!"
    exit 1
  fi

  echo "Restoring from: $LATEST"
  cleo restore "$LATEST" --force --verbose

  if cleo validate; then
    echo "System recovered successfully"
  else
    echo "Recovery validation failed - manual intervention needed"
  fi
}
```

### Backup Rotation Testing

```bash
# Test that backups can be restored
test-all-backups() {
  for backup in .cleo/backups/snapshot/snapshot_*; do
    echo "Testing restore: $backup"

    # Test in dry-run mode (create test directory)
    mkdir -p /tmp/restore-test
    cd /tmp/restore-test

    if cleo restore "$backup" --force; then
      echo "✓ $backup is restorable"
    else
      echo "✗ $backup failed restore test"
    fi

    cd - > /dev/null
    rm -rf /tmp/restore-test
  done
}
```

## Color Output

The restore command respects standard color controls:

```bash
# Disable colors
NO_COLOR=1 cleo restore backup_20251213_120000

# Force colors even in pipes
FORCE_COLOR=1 cleo restore backup_20251213_120000 | tee restore.log
```

## Related Commands

- `cleo backup` - Create backups for later restoration
- `cleo backup --list` - Find available restore points
- `cleo validate` - Verify restored files are intact
- `cleo session start` - Begin work after restore
- `cleo stats` - Verify task counts after restore

## Tips

1. **Always Validate After Restore**: Run `cleo validate` to ensure restored files are intact
2. **List Backups First**: Use `cleo backup --list` to find the correct restore point
3. **Use Named Backups**: Create named backups before major changes for easier identification
4. **Keep Safety Backups Temporarily**: Don't delete safety backups immediately after restore
5. **Test Selective Restore**: Use `--file` to restore individual files when possible
6. **Verify Backup Integrity**: Check backup metadata and file counts before restoring
7. **Use Force for Automation**: Add `--force` to scripts but verify backup source first
8. **Enable Verbose for Debugging**: Use `--verbose` when troubleshooting restore issues

## Security Considerations

Restoring backups can expose security concerns:

- **File Permissions**: Restored files inherit source permissions, may need adjustment
- **Sensitive Data**: Backups contain all task data including potentially sensitive information
- **Safety Backups**: Pre-restore backups remain on disk until manually removed
- **External Backups**: Verify backup source integrity before restoring from external media
- **Metadata Exposure**: backup-metadata.json contains hostname and username

**Recommendations**:
- Verify backup source authenticity before restoring
- Check restored file permissions: `chmod 600 .cleo/*.json`
- Remove safety backups after verification: `rm -rf .cleo/backups/safety/pre-restore_*`
- Use `--verbose` to audit restore operations
- Validate checksums for external backups before restore

## Version History

- **v0.8.0**: Initial restore implementation with safety backups
- **v0.8.2**: Enhanced validation and rollback capability
- **v0.9.0**: Added tarball support and selective file restoration

## See Also

- [backup.md](backup.md) - Creating backups for restoration
- [validate.md](validate.md) - File integrity verification
- [archive.md](archive.md) - Task archival operations
