# migrate Command

Schema version migration for cleo files.

## Usage

```bash
cleo migrate <command> [OPTIONS]
```

## Description

The `migrate` command handles schema version upgrades for cleo JSON files. When cleo is updated, your project files may need migration to work with new features.

Migration is safe and creates backups automatically before making changes.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `status` | Show version status of all files |
| `check` | Check if migration is needed (exit code 1 if needed) |
| `run` | Execute migration for all files |
| `file <path> <type>` | Migrate specific file |
| `repair` | Fix schema compliance issues without changing version |
| `rollback` | Revert from most recent migration backup |

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--dir PATH` | Project directory | Current directory |
| `--auto` | Auto-migrate without confirmation | `false` |
| `--backup` | Create backup before migration | `true` |
| `--no-backup` | Skip backup creation | |
| `--force` | Force migration even if versions match | `false` |
| `--help`, `-h` | Show help message | |

## Examples

### Check Migration Status

```bash
# Show version status of all files
cleo migrate status
```

Output:
```
Schema Migration Status
=======================

File                    Current    Expected   Status
----                    -------    --------   ------
todo.json               2.0.0      2.0.0      ✓ Current
config.json        1.5.0      2.0.0      ⚠ Upgrade needed
todo-archive.json       2.0.0      2.0.0      ✓ Current
todo-log.json           2.0.0      2.0.0      ✓ Current

1 file(s) need migration
```

### Check Migration Needed

```bash
# Check if migration needed (useful in scripts)
if ! cleo migrate check; then
  echo "Migration needed"
  cleo migrate run --auto
fi
```

### Run Migration

```bash
# Interactive migration (confirms before changes)
cleo migrate run

# Automatic migration (no confirmation)
cleo migrate run --auto
```

Output:
```
Schema Migration
================

Project: /path/to/project
Target versions:
  todo:    2.0.0
  config:  2.0.0
  archive: 2.0.0
  log:     2.0.0

This will migrate your todo files to the latest schema versions.

Continue? (y/N) y

Creating project backup...
✓ Backup created: .cleo/backups/migration/pre-migration-20251213-100000

Migrating config...
  - Added _meta.version field
  - Restructured archive settings
✓ config migrated successfully

✓ Migration completed successfully
```

### Migrate Specific File

```bash
# Migrate only the config file
cleo migrate file .cleo/config.json config

# Migrate todo file
cleo migrate file .cleo/todo.json todo
```

### Force Re-migration

```bash
# Force migration even if versions match
cleo migrate run --force
```

## File Types

| Type | File | Description |
|------|------|-------------|
| `todo` | `todo.json` | Active tasks |
| `config` | `config.json` | Configuration |
| `archive` | `todo-archive.json` | Archived tasks |
| `log` | `todo-log.json` | Audit log |

## Migration Safety

1. **Pre-migration backup**: Created automatically in `.cleo/backups/migration/`
2. **Validation**: Migrated files are validated before saving
3. **Atomic writes**: All-or-nothing updates prevent corruption
4. **Rollback possible**: Restore from backup if migration fails

## Version Compatibility

| Status | Meaning |
|--------|---------|
| `✓ Current` | File is at expected version |
| `⚠ Upgrade needed` | Migration available |
| `✗ Incompatible` | Major version mismatch (manual intervention) |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success / No migration needed |
| `1` | Migration needed (for `check` command) |
| `1` | Migration failed (for `run` command) |

## Repair Schema Compliance

The `repair` subcommand fixes schema compliance issues without changing version numbers. Use this when your files need structural corrections to match the canonical schema format.

### Usage

```bash
cleo migrate repair [OPTIONS]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--dry-run` | Show what would be repaired without making changes | `false` |
| `--auto` | Auto-repair without confirmation | `false` |
| `--backup` | Create backup before repair (always recommended) | `true` |
| `--dir PATH` | Project directory | Current directory |

### What It Fixes

The repair command ensures your todo.json matches the canonical schema structure:

1. **Phase Structure**
   - Adds missing phases from canonical template
   - Removes obsolete phases not in current schema
   - Fixes phase ordering to match template
   - Preserves existing status and timestamps

2. **Metadata Fields**
   - Ensures `_meta.schemaVersion` is present
   - Ensures `_meta.configVersion` is present
   - Ensures `_meta.checksum` field exists
   - Updates metadata without changing data

3. **Focus Fields**
   - Ensures `focus.sessionNote` field exists
   - Ensures `focus.nextAction` field exists
   - Initializes missing fields with null/defaults

4. **Project Structure**
   - Converts legacy string project to object format
   - Ensures `project.currentPhase` field exists
   - Maintains project name and settings

### Examples

#### Preview Repairs (Dry-Run)

```bash
# See what repairs are needed without making changes
cleo migrate repair --dry-run
```

Output:
```
Repair Preview
==============

File: /project/.cleo/todo.json

Phase Repairs:
  Add missing phases:
    + maintenance
  Fix phase ordering:
    ~ testing: order 2 → 3
    ~ polish: order 3 → 4

Meta Field Repairs:
  Add missing fields:
    + _meta.configVersion
    + _meta.checksum

Focus Field Repairs:
  Add missing fields:
    + focus.sessionNote
    + focus.nextAction

Run with --auto to apply these repairs
```

#### Interactive Repair

```bash
# Repair with confirmation prompt
cleo migrate repair
```

Output:
```
Schema Repair
=============

Project: /path/to/project
File: /path/to/project/.cleo/todo.json

Repair Preview
==============
...

Apply these repairs? (y/N) y

Applying repairs...
✓ Backup created: .cleo/backups/safety/safety_20251216_140000_pre_repair/todo.json
✓ Repair completed successfully
```

#### Auto-Repair

```bash
# Apply repairs automatically without confirmation
cleo migrate repair --auto
```

Output:
```
Schema Repair
=============

Project: /path/to/project
File: /path/to/project/.cleo/todo.json

Applying repairs...
✓ Backup created: .cleo/backups/safety/safety_20251216_140000_pre_repair/todo.json
✓ Repair completed successfully
```

### When to Use Repair

Use `migrate repair` when:

- File validation shows structural issues
- Phases don't match canonical template
- Metadata fields are missing
- You've manually edited todo.json and want to ensure compliance
- After upgrading cleo and schema structure changed

### Safety Features

1. **Automatic Backup**: Creates backup before any changes
2. **Dry-Run Mode**: Preview repairs without risk
3. **Verification**: Validates file after repair
4. **Rollback**: Can restore from backup if issues occur
5. **Idempotent**: Safe to run multiple times

### Repair vs Migration

| Feature | `migrate repair` | `migrate run` |
|---------|------------------|---------------|
| Changes version | No | Yes |
| Fixes structure | Yes | Yes |
| When to use | Schema compliance issues | Version upgrade needed |
| Creates backup | Yes | Yes |
| Idempotent | Yes | Yes (with --force) |

---

## Rollback from Migration

The `rollback` subcommand reverts files to a previous state using migration backups. This is useful if a migration causes issues or you need to return to a prior version.

### Usage

```bash
cleo migrate rollback [OPTIONS]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--backup-id ID` | Specific backup to restore from | Most recent |
| `--force` | Skip confirmation prompt | `false` |
| `--dir PATH` | Project directory | Current directory |

### How It Works

1. **Backup Selection**: Uses most recent migration backup or specified backup ID
2. **Safety Backup**: Creates pre-rollback backup before restoration
3. **File Restoration**: Restores all files from migration backup
4. **Validation**: Validates JSON integrity after restoration
5. **Version Report**: Shows current versions after rollback

### Examples

#### Rollback from Most Recent Backup

```bash
# Rollback from the most recent migration backup
cleo migrate rollback
```

Output:
```
Migration Rollback
==================

Backup: migration_v2.2.0_20251216_120000
Path:   .cleo/backups/migration/migration_v2.2.0_20251216_120000

Backup Information:
  Created: 2025-12-16T12:00:00Z
  Files:
    - todo.json
    - config.json
    - todo-archive.json
    - todo-log.json

⚠ WARNING: This will restore all files from the backup.
  Current files will be backed up before restoration.

Continue with rollback? (y/N) y

Creating safety backup before rollback...
✓ Safety backup created: .cleo/backups/safety/safety_20251216_140000_pre_rollback

Restoring files from backup...
✓ Restored todo.json
✓ Restored config.json
✓ Restored todo-archive.json
✓ Restored todo-log.json

Validating restored files...
✓ All files validated successfully

Current Schema Versions:
  todo: v2.1.0
  config: v2.0.0
  archive: v2.1.0
  log: v2.1.0

✓ Rollback completed successfully

Note: Safety backup of pre-rollback state available at:
  .cleo/backups/safety/safety_20251216_140000_pre_rollback
```

#### Rollback from Specific Backup

```bash
# List available migration backups
ls .cleo/backups/migration/

# Rollback from specific backup ID
cleo migrate rollback --backup-id migration_v2.1.0_20251215_100000
```

#### Force Rollback (No Confirmation)

```bash
# Skip confirmation prompt
cleo migrate rollback --force
```

### Backup ID Format

Migration backups use the naming pattern:
```
migration_v{VERSION}_{TIMESTAMP}
```

Examples:
- `migration_v2.2.0_20251216_120000`
- `migration_v2.1.0_20251215_100000`

Find available backups:
```bash
# List migration backups (newest first)
ls -lt .cleo/backups/migration/
```

### Safety Features

1. **Pre-Rollback Backup**: Creates safety backup before restoration
2. **JSON Validation**: Validates backup integrity before restore
3. **Post-Restore Validation**: Ensures restored files are valid JSON
4. **Error Handling**: Preserves safety backup if rollback fails
5. **Version Reporting**: Shows versions after rollback

### When to Use Rollback

Use `migrate rollback` when:

- Recent migration caused unexpected issues
- Need to test with older schema version
- Data was lost or corrupted during migration
- Want to return to known-good state
- Testing migration procedures

### Recovery Scenarios

#### Migration Failed Partway

```bash
# Rollback to pre-migration state
cleo migrate rollback
```

#### Testing Migration Strategy

```bash
# 1. Run migration
cleo migrate run

# 2. Test new version
# ... testing ...

# 3. Rollback if issues found
cleo migrate rollback
```

#### Specific Backup Restoration

```bash
# Restore from specific known-good backup
cleo migrate rollback --backup-id migration_v2.1.0_20251215_100000
```

### Backup Locations

| Type | Location | Purpose |
|------|----------|---------|
| Migration backup | `.cleo/backups/migration/` | Created before migrations |
| Safety backup | `.cleo/backups/safety/` | Created before rollback |
| Snapshot backup | `.cleo/backups/snapshot/` | Created by `backup` command |

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Rollback successful |
| `1` | Rollback failed (safety backup preserved) |
| `1` | No backup found |

---

## See Also

- [validate](validate.md) - Check file integrity
- [backup](backup.md) - Create manual backups
- [restore](restore.md) - Restore from backups
- [reorganize-backups](reorganize-backups.md) - Migrate legacy backup structure
