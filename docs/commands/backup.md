# backup Command

Create timestamped backups of all todo system files with optional compression and retention management.

## Usage

```bash
cleo backup [OPTIONS]
cleo backup status [OPTIONS]
cleo backup verify <ID|PATH>
cleo backup find [OPTIONS]
cleo backup search [OPTIONS]    # Alias for find with enhanced options
cleo backup --auto              # Run scheduled backup if due
```

## Description

The `backup` command creates a complete snapshot of your todo system by copying all critical files to a timestamped backup directory. Each backup includes metadata tracking what was backed up, when, and validation status.

This command is essential for:
- Creating restore points before major changes
- Protecting against data loss or corruption
- Migrating data between systems
- Auditing historical task states
- Testing experimental workflows safely

All backups are validated during creation to ensure integrity, and automatic retention policies prevent unlimited storage consumption.

## Subcommands

### status
Show backup system health and overall status.

```bash
cleo backup status [--json|--human]
```

### verify
Verify backup integrity by recalculating and comparing checksums.

```bash
cleo backup verify <ID|PATH>
```

- `ID`: Backup ID (e.g., `snapshot_20251215`)
- `PATH`: Full path to backup directory

### find / search (v0.29.0+, enhanced v0.30.0+)
Search backups by date, type, name, content, or task ID.

```bash
cleo backup find [OPTIONS]
cleo backup search [OPTIONS]   # Alias with enhanced options
```

| Option | Description | Example |
|--------|-------------|---------|
| `--since DATE` | Backups created after DATE | `--since 7d`, `--since 2025-12-01` |
| `--until DATE` | Backups created before DATE | `--until 2025-12-15` |
| `--on DATE` | Backups from exact date (v0.30.0+) | `--on 2025-12-20`, `--on today` |
| `--type TYPE` | Filter by backup type | `--type snapshot` |
| `--name PATTERN` | Filter by name pattern (glob) | `--name "*session*"` |
| `--grep PATTERN` | Search backup content | `--grep "important"` |
| `--contains PATTERN` | Alias for `--grep` (v0.30.0+) | `--contains "error"` |
| `--task-id ID` | Find backups containing task (v0.30.0+) | `--task-id T045` |
| `--verbose` | Show matched content snippets (v0.30.0+) | `--task-id T001 --verbose` |
| `--limit N` | Limit results (default: 10) | `--limit 20` |

**Backup Types**: `snapshot`, `safety`, `archive`, `migration`, `incremental`

**Date Formats**:
- ISO 8601: `2025-12-01`, `2025-12-01T12:00:00Z`
- Relative: `7d` (7 days), `1w` (1 week), `2m` (2 months)
- Named: `today`, `yesterday`

### --auto (v0.30.0+)
Run scheduled backup if interval has elapsed.

```bash
cleo backup --auto [--json|--quiet]
```

Checks if a scheduled backup is due based on `backup.scheduled.intervalMinutes` configuration. If the interval has elapsed since the last backup, creates a snapshot backup.

Returns JSON with `performed: true/false` indicating whether a backup was created.

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--destination DIR` | | Custom backup location | `.cleo/backups` |
| `--compress` | | Create compressed tarball (.tar.gz) | `false` |
| `--name NAME` | `-n` | Custom name appended to timestamp | (none) |
| `--list` | `-l` | **List all available backups** | `false` |
| `--auto` | | **Run scheduled backup if due** (v0.30.0+) | `false` |
| `--verbose` | | **Show detailed debug output** | `false` |
| `--help` | `-h` | Show help message | |

## Backed Up Files

Each backup includes:

- `todo.json` - Active tasks and focus state
- `todo-archive.json` - Completed and archived tasks
- `config.json` - Configuration and settings
- `todo-log.json` - Audit trail and session history
- `backup-metadata.json` - Backup metadata (timestamp, file count, size)

## Backup Structure

### Standard Backup (Directory)

```
.cleo/backups/snapshot/
├── snapshot_20251213_120000/
│   ├── todo.json
│   ├── todo-archive.json
│   ├── config.json
│   ├── todo-log.json
│   └── backup-metadata.json
```

### Compressed Backup (Tarball)

```
.cleo/backups/snapshot/
└── snapshot_20251213_120000.tar.gz
```

### Named Backup

```
.cleo/backups/snapshot/
└── snapshot_20251213_120000_before-refactor/
    ├── todo.json
    ├── ...
```

## Examples

### Basic Backup

```bash
# Create standard timestamped backup
cleo backup
```

Output:
```
[INFO] Creating backup: snapshot_20251213_120000
[INFO] Backing up files...
[INFO] Validating backup integrity...
[INFO] Backup validation successful

╔══════════════════════════════════════════════════════════╗
║              BACKUP COMPLETED SUCCESSFULLY               ║
╚══════════════════════════════════════════════════════════╝

  Backup Location:
    .cleo/backups/snapshot/snapshot_20251213_120000

  Files Included:
    ✓ todo.json
    ✓ todo-archive.json
    ✓ config.json
    ✓ todo-log.json

  Total Size: 12.4KiB
```

### Named Backup

```bash
# Create backup with custom name for context
cleo backup --name "before-refactor"
```

Creates: `.cleo/backups/snapshot/snapshot_20251213_120000_before-refactor/`

Use cases:
- Before major refactoring
- Before archiving large batches
- Pre-migration snapshots
- Experimental workflow checkpoints

### Compressed Backup

```bash
# Create space-saving compressed tarball
cleo backup --compress
```

Output:
```
[INFO] Creating backup: snapshot_20251213_120000
[INFO] Backing up files...
[INFO] Validating backup integrity...
[INFO] Backup validation successful
[INFO] Compressing backup...
[INFO] Created compressed archive: .cleo/backups/snapshot/snapshot_20251213_120000.tar.gz (3.2KiB)

╔══════════════════════════════════════════════════════════╗
║              BACKUP COMPLETED SUCCESSFULLY               ║
╚══════════════════════════════════════════════════════════╝

  Backup Location:
    .cleo/backups/snapshot/snapshot_20251213_120000.tar.gz

  Files Included:
    ✓ todo.json
    ✓ todo-archive.json
    ✓ config.json
    ✓ todo-log.json

  Total Size: 12.4KiB
```

**Note**: Compressed backups save 60-80% disk space and are ideal for archival storage.

### List Available Backups

```bash
# Show all backups with metadata
cleo backup --list
```

Output:
```
╔══════════════════════════════════════════════════════════════════════════════╗
║                           AVAILABLE BACKUPS                                  ║
╚══════════════════════════════════════════════════════════════════════════════╝

  ▸ snapshot_20251213_120000
    Timestamp: 2025-12-13T12:00:00Z
    Files: 4 | Size: 12.4KiB
    Path: .cleo/backups/snapshot/snapshot_20251213_120000

  ▸ snapshot_20251213_093000_before-refactor
    Timestamp: 2025-12-13T09:30:00Z
    Files: 4 | Size: 11.8KiB
    Path: .cleo/backups/snapshot/snapshot_20251213_093000_before-refactor

  ▸ snapshot_20251212_180000.tar.gz (compressed)
    Modified: 2025-12-12 18:00:00
    Size: 3.2KiB
    Path: .cleo/backups/snapshot/snapshot_20251212_180000.tar.gz
```

**Use cases**:
- Find restore points by date or name
- Verify backup sizes and contents
- Audit backup history
- Identify old backups for cleanup

### Verbose Output

```bash
# Show detailed debug information
cleo backup --verbose
```

Output:
```
[INFO] Creating backup: snapshot_20251213_120000
[DEBUG] Created backup directory: .cleo/backups
[DEBUG] Created backup path: .cleo/backups/snapshot/snapshot_20251213_120000
[INFO] Backing up files...
[DEBUG] todo.json validated successfully
[DEBUG] Backed up todo.json (4.2KiB)
[DEBUG] todo-archive.json validated successfully
[DEBUG] Backed up todo-archive.json (3.8KiB)
[DEBUG] config.json validated successfully
[DEBUG] Backed up config.json (1.1KiB)
[DEBUG] todo-log.json validated successfully
[DEBUG] Backed up todo-log.json (3.3KiB)
[DEBUG] Created metadata file
[INFO] Validating backup integrity...
[INFO] Backup validation successful
[DEBUG] Checking backup retention (max: 10)
[DEBUG] Removed old backup: snapshot_20251203_140000

╔══════════════════════════════════════════════════════════╗
║              BACKUP COMPLETED SUCCESSFULLY               ║
╚══════════════════════════════════════════════════════════╝
```

**Use cases**:
- Troubleshooting backup failures
- Understanding retention behavior
- Verifying file validation logic
- Debugging custom backup scripts

### Combined Options

```bash
# Named, compressed, verbose backup to custom location
cleo backup \
  --name "migration-snapshot" \
  --compress \
  --destination ~/backups/cleo \
  --verbose
```

### Check Backup System Status

```bash
# Show backup system health
cleo backup status
```

Output:
```
╔══════════════════════════════════════════════════════════╗
║              BACKUP SYSTEM STATUS                        ║
╚══════════════════════════════════════════════════════════╝

  Health: HEALTHY
  Last Backup: 2025-12-23T12:00:00Z (2 hours ago)
  Total Backups: 15
  Storage Used: 45.2 MiB

  By Type:
    snapshot:  10 backups (32.1 MiB)
    safety:     3 backups (8.4 MiB)
    archive:    2 backups (4.7 MiB)
```

### Verify Backup Integrity

```bash
# Verify by backup ID
cleo backup verify snapshot_20251215

# Verify by full path
cleo backup verify .cleo/backups/safety/safety_20251215_120000
```

Output:
```
✓ Verifying backup: snapshot_20251215
✓ todo.json: checksum valid
✓ todo-archive.json: checksum valid
✓ config.json: checksum valid
✓ todo-log.json: checksum valid

Backup integrity: VERIFIED
```

### Search Backups (v0.29.0+, enhanced v0.30.0+)

```bash
# Find backups from last 7 days
cleo backup find --since 7d

# Find snapshots from last week
cleo backup find --since 1w --type snapshot

# Find backups by name pattern
cleo backup find --name "*session*"

# Search backup contents for a pattern
cleo backup search --contains "important"

# Find backups from exact date (v0.30.0+)
cleo backup search --on 2025-12-20

# Find backups containing specific task (v0.30.0+)
cleo backup search --task-id T045

# Combined filters with task search
cleo backup search --on today --task-id T001 --type snapshot

# Show matched content snippets (v0.30.0+)
cleo backup search --task-id T045 --verbose

# Combined search with limit
cleo backup find --since 30d --type safety --limit 5
```

Output:
```
Found 3 backups matching criteria:

  ▸ snapshot_20251223_100000
    Type: snapshot | Created: 2025-12-23T10:00:00Z
    Size: 12.4 KiB | Files: 4
    Path: .cleo/backups/snapshot/snapshot_20251223_100000

  ▸ safety_20251222_180000
    Type: safety | Created: 2025-12-22T18:00:00Z
    Size: 11.8 KiB | Files: 4
    Path: .cleo/backups/safety/safety_20251222_180000
```

## Restore Procedures

### Restore from Directory Backup

```bash
# 1. List available backups
cleo backup --list

# 2. Copy files from backup to restore
BACKUP_DIR=".cleo/backups/snapshot/snapshot_20251213_120000"
cp "$BACKUP_DIR/todo.json" .cleo/
cp "$BACKUP_DIR/todo-archive.json" .cleo/
cp "$BACKUP_DIR/config.json" .cleo/
cp "$BACKUP_DIR/todo-log.json" .cleo/

# 3. Validate restored files
cleo validate
```

### Restore from Compressed Backup

```bash
# 1. Extract tarball
cd .cleo/backups
tar -xzf snapshot_20251213_120000.tar.gz

# 2. Copy extracted files
cp snapshot_20251213_120000/*.json ../

# 3. Validate
cleo validate
```

### Selective Restore

```bash
# Restore only specific files
BACKUP_DIR=".cleo/backups/snapshot/snapshot_20251213_120000"

# Restore just active tasks
cp "$BACKUP_DIR/todo.json" .cleo/

# Restore just config
cp "$BACKUP_DIR/config.json" .cleo/

# Validate after partial restore
cleo validate
```

### Emergency Recovery

```bash
# If current files are corrupted, restore last good backup
LATEST_BACKUP=$(ls -td .cleo/backups/snapshot/snapshot_* | head -1)
cp "$LATEST_BACKUP"/*.json .cleo/
cleo validate
```

## Retention Policy

Automatic cleanup of old backups is controlled by configuration:

```bash
# View current retention setting
jq '.backups.maxBackups' .cleo/config.json
# Output: 10 (default)
```

### Configure Retention

```bash
# Update max backups kept
cleo config set backups.maxBackups 20

# Disable automatic cleanup (keep all backups)
cleo config set backups.maxBackups 0
```

### Retention Behavior

- **maxBackups > 0**: Keep only N most recent backups, auto-delete oldest
- **maxBackups = 0**: Keep all backups (manual cleanup required)
- **Default**: 10 backups

When retention limit is exceeded:
1. Counts all backups (directories + tarballs)
2. Sorts by modification time (oldest first)
3. Removes excess backups beyond maxBackups
4. Logs each removal with `--verbose`

**Example**:
```
maxBackups = 5
Current backups = 7

Action: Remove 2 oldest backups
Result: 5 backups remain
```

## Validation

Every backup performs two validation passes:

### Pre-Backup Validation

Validates source files before copying:
- Checks file exists
- Validates JSON syntax with `jq`
- Skips invalid files with warning
- Tracks validation errors in metadata

### Post-Backup Validation

Validates backed-up files after copying:
- Ensures all JSON files are well-formed
- Fails entire backup if corruption detected
- Prevents corrupt backups from being kept

**Validation Errors**:
```
[ERROR] todo.json has invalid JSON syntax
[ERROR] Backup validation failed for todo.json
[ERROR] Backup validation failed with 1 errors
```

## Metadata Format

Each backup includes `backup-metadata.json`:

```json
{
  "timestamp": "2025-12-13T12:00:00Z",
  "backupName": "snapshot_20251213_120000_before-refactor",
  "customName": "before-refactor",
  "files": [
    "todo.json",
    "todo-archive.json",
    "config.json",
    "todo-log.json"
  ],
  "totalSize": 12688,
  "validationErrors": 0,
  "compressed": false,
  "hostname": "dev-machine",
  "user": "developer"
}
```

**Fields**:
- `timestamp`: ISO 8601 UTC timestamp of backup creation
- `backupName`: Full backup directory/tarball name
- `customName`: Optional custom name (if `--name` used)
- `files`: Array of successfully backed up files
- `totalSize`: Total bytes of uncompressed data
- `validationErrors`: Count of source validation failures
- `compressed`: Whether backup was compressed
- `hostname`: Machine where backup was created
- `user`: User who created backup

## Use Cases

### Pre-Operation Checkpoints

```bash
# Before risky operations
cleo backup --name "before-bulk-delete"
# ... perform bulk operations ...
# Restore if needed
```

### Daily Snapshots

```bash
# Add to cron or systemd timer
0 0 * * * cd ~/projects/myapp && cleo backup --compress
```

### Migration Workflows

```bash
# Export from old system
cleo backup --compress --destination ~/export

# Transfer tarball to new system
scp ~/export/snapshot_*.tar.gz newhost:~/import/

# Import on new system
cd ~/new-project
tar -xzf ~/import/snapshot_*.tar.gz -C .cleo/backups/snapshot/
# Restore as needed
```

### Development Workflow

```bash
# Create restore point before experimental changes
alias ct-save='cleo backup --name "checkpoint"'
alias ct-restore='cp .cleo/backups/snapshot/snapshot_*_checkpoint/*.json .cleo/'

# Work session
ct-save
# ... make experimental changes ...
# Didn't work out? Restore
ct-restore
```

### Backup Verification

```bash
# List backups and verify integrity
cleo backup --list

# Check metadata for corruption indicators
jq '.validationErrors' .cleo/backups/snapshot/*/backup-metadata.json
# Should output 0 for all backups
```

## Troubleshooting

### Backup Fails with Validation Errors

```bash
# Use verbose mode to identify problematic files
cleo backup --verbose

# Output shows:
# [WARN] todo-archive.json not found, skipping
# [ERROR] todo.json has invalid JSON syntax
```

**Solution**: Fix source files before backup
```bash
# Validate current files
cleo validate --fix

# Retry backup
cleo backup
```

### Insufficient Disk Space

```bash
# Check backup directory size
du -sh .cleo/backups

# Reduce retention or use compression
cleo config set backups.maxBackups 5
cleo backup --compress
```

### Restore Doesn't Work

```bash
# Verify backup integrity
jq empty .cleo/backups/snapshot/snapshot_20251213_120000/*.json

# Check metadata
jq '.validationErrors' .cleo/backups/snapshot/snapshot_20251213_120000/backup-metadata.json

# If corrupted, try older backup
cleo backup --list
```

### Cannot Find Backups

```bash
# Check backup directory exists
ls -la .cleo/backups/snapshot/

# Verify correct directory
echo "$BACKUP_DIR"  # Should be .cleo/backups

# List with absolute path
cleo backup --list
```

## Automation Examples

### Pre-Commit Hook

```bash
#!/usr/bin/env bash
# .git/hooks/pre-commit

# Backup before committing todo changes
if git diff --cached --name-only | grep -q '.cleo/'; then
  echo "Backing up todo system..."
  cleo backup --name "pre-commit" --compress
fi
```

### Session Wrapper

```bash
#!/usr/bin/env bash
# ct-session - Wrapper for safe todo sessions

# Backup at session start
cleo backup --name "session-start-$(date +%H%M)" --compress

# Start session
cleo session start

# Interactive work
$SHELL

# Backup at session end
cleo backup --name "session-end-$(date +%H%M)" --compress
cleo session end
```

### Scheduled Rotation

```bash
#!/usr/bin/env bash
# Daily backup with rotation

# Create compressed daily backup
cleo backup --compress --name "daily-$(date +%A)"

# Keep only last 7 days (one per weekday)
find .cleo/backups -name "snapshot_*_daily-*" -mtime +7 -delete
```

## Color Output

The backup command respects standard color controls:

```bash
# Disable colors
NO_COLOR=1 cleo backup

# Force colors even in pipes
FORCE_COLOR=1 cleo backup | tee backup.log
```

## Related Commands

- `cleo validate` - Validate current todo system files
- `cleo archive` - Archive completed tasks (creates auto-backup)
- `cleo session start` - Begin work session (recommended to backup first)
- `cleo export` - Export tasks to other formats

## Tips

1. **Backup Before Major Changes**: Always create a named backup before bulk operations
2. **Use Compression for Archival**: Compressed backups save 60-80% disk space
3. **Set Appropriate Retention**: Balance disk space vs. recovery window needs
4. **Name Critical Backups**: Use `--name` for important restore points
5. **Verify After Restore**: Always run `cleo validate` after restoring
6. **Automate Daily Backups**: Set up cron/systemd timers for regular snapshots
7. **Test Restore Procedures**: Periodically practice restoring from backups
8. **Use Verbose for Debugging**: Enable `--verbose` when troubleshooting issues

## Best Practices

### Backup Frequency

| Scenario | Frequency | Method |
|----------|-----------|--------|
| Active development | Before each session | `backup --name "session-start"` |
| Daily operations | Once per day | Automated cron job with `--compress` |
| Before bulk changes | Immediately before | `backup --name "before-X"` |
| Long-term archival | Weekly/monthly | `backup --compress --destination external` |

### Naming Conventions

Use descriptive names for easy identification:

```bash
# Good naming
backup --name "before-refactor"
backup --name "migration-v1-to-v2"
backup --name "pre-archive-cleanup"

# Avoid generic names
backup --name "backup"
backup --name "temp"
```

### Storage Management

```bash
# Monitor backup disk usage
du -sh .cleo/backups

# Aggressive retention for space-constrained systems
cleo config set backups.maxBackups 3

# External backup location for critical data
cleo backup --compress --destination ~/Dropbox/cleo-backups
```

## Scheduled Backups (v0.30.0+)

Configure automatic backups via `config.json`:

```json
{
  "backup": {
    "scheduled": {
      "onArchive": true,
      "onSessionStart": false,
      "onSessionEnd": false,
      "intervalMinutes": 0
    }
  }
}
```

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `onArchive` | `true` | Create safety backup before archive operations |
| `onSessionStart` | `false` | Create snapshot backup when session starts |
| `onSessionEnd` | `false` | Create safety backup when session ends |
| `intervalMinutes` | `0` | Minutes between auto-backups (0 = disabled) |

### Using Scheduled Backups

```bash
# Run scheduled backup if due (based on intervalMinutes)
cleo backup --auto

# Check in CI/automation
if result=$(cleo backup --auto --json); then
  performed=$(echo "$result" | jq -r '.performed')
  echo "Backup performed: $performed"
fi
```

### Integration with Archive

When `onArchive` is `true` (default), the archive command automatically creates a safety backup before archiving completed tasks. This ensures you can recover tasks that were archived accidentally.

## Manifest Tracking (v0.30.0+)

Backups are tracked in a manifest file (`.cleo/backups/backup-manifest.json`) for O(1) lookups. The manifest is automatically maintained when backups are created, rotated, or pruned.

## Version History

- **v0.8.0**: Initial implementation with basic backup/restore
- **v0.8.2**: Added `--list` and `--verbose` options, metadata tracking
- **v0.9.0**: Enhanced list output with formatted display and size calculation
- **v0.29.0**: Added `status`, `verify`, and `find` subcommands; two-tier backup architecture
- **v0.30.0**: Added `search` subcommand, `--auto` flag, scheduled backups, manifest tracking, `--on`/`--task-id`/`--contains`/`--verbose` search options

## Security Considerations

Backups contain all task data including potentially sensitive information:

- **File Permissions**: Backups inherit source file permissions
- **Storage Location**: Default `.cleo/backups` in project directory
- **Compression**: `.tar.gz` files are not encrypted
- **Metadata**: Includes hostname and username

**Recommendations**:
- Set restrictive permissions: `chmod 700 .cleo/backups`
- Use encrypted external storage for sensitive projects
- Exclude `.cleo/backups/snapshot/` from version control (add to `.gitignore`)
- Consider encrypting compressed backups for archival storage
