# claude-migrate Command

Detect and migrate legacy claude-todo installations to CLEO format.

## Usage

```bash
cleo claude-migrate --check              # Detect legacy installations (read-only)
cleo claude-migrate --global             # Migrate global: ~/.claude-todo → ~/.cleo
cleo claude-migrate --project            # Migrate project: .claude → .cleo
cleo claude-migrate --all                # Migrate both global and project
```

## Description

The `claude-migrate` command helps users transition from the legacy `claude-todo` installation to the new CLEO format. It detects legacy installations, creates backups before migration, and performs safe atomic migrations.

**Key Features**:
- **Safe Detection**: Use `--check` first to see what needs migration
- **Automatic Backups**: Creates backups before any migration
- **Atomic Operations**: All migrations are atomic (complete or rollback)
- **File Renaming**: Renames `todo-config.json` → `config.json`
- **Gitignore Updates**: Updates `.gitignore` from `.claude` to `.cleo`
- **Marker Updates**: Updates `CLAUDE-TODO:` markers to `CLEO:` in CLAUDE.md

## Modes

### --check

Detect legacy installations without making changes.

```bash
cleo claude-migrate --check
```

Detects:
- Global installation: `~/.claude-todo/`
- Project directory: `.claude/`
- Environment variables: `CLAUDE_TODO_*`

**Exit Codes** (check mode):
| Code | Meaning |
|------|---------|
| 0 | Legacy installation found (migration needed) |
| 1 | No legacy installation (already clean) |
| 2 | Error during detection |

### --global

Migrate global installation from `~/.claude-todo` to `~/.cleo`.

```bash
cleo claude-migrate --global
```

**Steps performed**:
1. Create backup of `~/.claude-todo`
2. Move directory to `~/.cleo`
3. Rename `todo-config.json` → `config.json`
4. Verify migration

### --project

Migrate project directory from `.claude` to `.cleo`.

```bash
cleo claude-migrate --project
```

**Steps performed**:
1. Create backup of `.claude`
2. Move directory to `.cleo`
3. Rename `todo-config.json` → `config.json`
4. Update `.gitignore` entries
5. Update `CLAUDE-TODO:` markers in `CLAUDE.md`

### --all

Run both global and project migrations.

```bash
cleo claude-migrate --all
```

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--check` | | Detect legacy installations (read-only) | |
| `--global` | | Migrate global installation | |
| `--project` | | Migrate project directory | |
| `--all` | | Migrate both global and project | |
| `--format FORMAT` | | Output format: text, json | auto-detect |
| `--verbose` | `-v` | Show detailed output | `false` |
| `--help` | `-h` | Show help message | |

## Exit Codes (Migration Modes)

| Code | Meaning |
|------|---------|
| 0 | Migration successful |
| 1 | No legacy installation found (nothing to migrate) |
| 2 | Backup creation failed |
| 3 | Move/rename operation failed |
| 4 | Validation failed |

## Examples

### Check for Legacy Installations

```bash
# Human-readable output
cleo claude-migrate --check

# JSON output for scripting
cleo claude-migrate --check --format json
```

**Text Output**:
```
CLEO Migration Check
====================

✗ Global: ~/.claude-todo/ found (legacy)
✗ Project: .claude/ found (legacy)
✓ Environment: Clean (no legacy vars)

Migration needed. Run: cleo claude-migrate --all
```

**JSON Output**:
```json
{
  "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
  "_meta": {
    "command": "claude-migrate --check",
    "timestamp": "2025-12-27T12:00:00Z",
    "version": "1.0.0"
  },
  "success": true,
  "migrationNeeded": true,
  "global": {"found": true, "path": "~/.claude-todo", "fileCount": 15},
  "project": {"found": true, "path": ".claude", "fileCount": 8},
  "environment": {"found": false, "count": 0, "variables": []}
}
```

### Migrate Global Installation

```bash
cleo claude-migrate --global
```

**Output**:
```
CLEO Global Migration
=====================

Step 1/4: Creating backup...
  ✓ Backup created: /tmp/cleo_migration_backup_20251227_120000.tar.gz

Step 2/4: Moving files...
  ✓ Moved: ~/.claude-todo → ~/.cleo

Step 3/4: Renaming config files...
  ✓ Renamed 1 config files

Step 4/4: Verifying and finalizing...
  ✓ Verified: 15 files migrated

Migration Complete!

Summary:
  Source: ~/.claude-todo (removed)
  Target: ~/.cleo
  Files:  15
  Backup: ~/.cleo/backups/migration/cleo_migration_backup_20251227_120000.tar.gz

To restore if needed:
  rm -rf ~/.cleo
  tar -xzf ~/.cleo/backups/migration/cleo_migration_backup_20251227_120000.tar.gz -C $HOME
```

### Migrate Project Directory

```bash
cleo claude-migrate --project
```

**Output**:
```
CLEO Project Migration
======================

Step 1/5: Creating backup...
  ✓ Backup created: /tmp/cleo_project_backup_20251227_120000.tar.gz

Step 2/5: Moving files...
  ✓ Moved: .claude → .cleo

Step 3/5: Renaming config files...
  ✓ Renamed 1 config files

Step 4/5: Updating .gitignore...
  ✓ Updated .gitignore

Step 5/5: Updating injection markers...
  ✓ Updated CLAUDE.md markers

Migration Complete!

Summary:
  Source: .claude (removed)
  Target: .cleo
  Files:  8
  Config files renamed: 1
  .gitignore updated: true
  Markers updated: true
  Backup: .cleo/backups/migration/cleo_project_backup_20251227_120000.tar.gz
```

### Migrate Everything

```bash
cleo claude-migrate --all
```

### Verbose Mode

```bash
cleo claude-migrate --check --verbose
```

Shows additional details including:
- Full file paths
- Suggested next commands
- Environment variable values detected

## File Transformations

### Config File Renaming

| Legacy | CLEO |
|--------|------|
| `todo-config.json` | `config.json` |
| `todo-log.json` | `todo-log.json` (unchanged) |
| `todo.json` | `todo.json` (unchanged) |
| `todo-archive.json` | `todo-archive.json` (unchanged) |

### Directory Moves

| Legacy | CLEO |
|--------|------|
| `~/.claude-todo/` | `~/.cleo/` |
| `.claude/` | `.cleo/` |

### .gitignore Updates

```diff
- .claude/
- .claude/*.json
+ .cleo/
+ .cleo/*.json
```

### CLAUDE.md Marker Updates

```diff
- <!-- CLAUDE-TODO:START -->
- <!-- CLAUDE-TODO:END -->
+ <!-- CLEO:START -->
+ <!-- CLEO:END -->
```

## Backup Strategy

### Backup Location

1. **During Migration**: Backup created in `/tmp/` first
2. **After Migration**: Backup moved to `{target}/backups/migration/`

This ensures the backup directory is created after the migration succeeds, preventing creation of the target directory before the move.

### Backup Format

Backups are created as `.tar.gz` archives:
- `cleo_migration_backup_{timestamp}.tar.gz` (global)
- `cleo_project_backup_{timestamp}.tar.gz` (project)

### Restore Procedure

```bash
# Restore global installation
rm -rf ~/.cleo
tar -xzf ~/.cleo/backups/migration/cleo_migration_backup_*.tar.gz -C $HOME

# Restore project installation
rm -rf .cleo
tar -xzf path/to/backup.tar.gz
```

## Environment Variables

The command detects legacy environment variables:

| Legacy Variable | CLEO Equivalent |
|-----------------|-----------------|
| `CLAUDE_TODO_HOME` | `CLEO_HOME` |
| `CLAUDE_TODO_DIR` | `CLEO_DIR` |
| `CLAUDE_TODO_FORMAT` | `CLEO_FORMAT` |
| `CLAUDE_TODO_DEBUG` | `CLEO_DEBUG` |

**Note**: Environment variables cannot be migrated automatically. Users must update their shell configuration.

## Troubleshooting

### Target Already Exists

```
Error: Target ~/.cleo already exists
```

**Solution**: The target directory already has data. Either:
1. Remove or backup the existing target manually
2. Use the existing installation

### Backup Failed

```
Error: Failed to create backup
```

**Solution**: Check disk space and permissions in `/tmp/`

### Move Failed

```
Error: Failed to move ~/.claude-todo → ~/.cleo
```

**Solution**:
- Check disk permissions
- Ensure no files are in use
- Restore from backup if needed

## Related Commands

- `cleo validate` - Validate data files after migration
- `cleo backup` - Create additional backups
- `cleo config show` - Verify configuration after migration

## Version History

- **v1.0.0** (CLEO v1.0.0): Initial implementation with --check, --global, --project, --all modes
