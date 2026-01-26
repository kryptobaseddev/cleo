# Configuration Reference

CLEO uses a hierarchical configuration system allowing customization at multiple levels while maintaining sensible defaults.

## Config Command (v0.18.0+)

Use the `config` command to view and modify settings:

```bash
# View configuration
cleo config show               # Show all config
cleo config show output        # Show section
cleo config get output.defaultFormat  # Get single value

# Modify configuration
cleo config set output.defaultFormat json  # Update project config
cleo config set KEY VALUE --global        # Update global config

# Other operations
cleo config list               # List all keys/values
cleo config edit               # Interactive menu editor
cleo config validate           # Validate config against schema
cleo config reset              # Reset to defaults
```

For full command documentation, see [commands/config.md](../commands/config.md).

## Configuration Files

### Default Configuration Template
Location: `~/.cleo/templates/config.template.json`

This file contains the default configuration that serves as the starting point for all projects.

### Global Configuration (Optional)
Location: `~/.cleo/config.json`

Create this file to override defaults across all projects. Useful for personal preferences like logging levels or display settings.

### Project Configuration
Location: `.cleo/config.json`

Project-specific configuration. Created automatically during initialization from the default template.

## Configuration Override Hierarchy

Configuration values are resolved in this order (later overrides earlier):

1. **Defaults** - Built-in defaults from schema
2. **Global** - `~/.cleo/config.json` (if exists)
3. **Project** - `.cleo/config.json`
4. **Environment** - `CLEO_*` environment variables
5. **CLI Flags** - Command-line arguments (highest priority)

## Configuration Schema

### Complete Configuration Structure

```json
{
  "version": "2.1.0",
  "archive": {
    "enabled": true,
    "daysUntilArchive": 7,
    "maxCompletedTasks": 15,
    "preserveRecentCount": 3,
    "archiveOnSessionEnd": true
  },
  "logging": {
    "enabled": true,
    "retentionDays": 30,
    "level": "standard",
    "logSessionEvents": true
  },
  "validation": {
    "strictMode": false,
    "checksumEnabled": true,
    "enforceAcceptance": true,
    "requireDescription": false,
    "maxActiveTasks": 1,
    "validateDependencies": true,
    "detectCircularDeps": true
  },
  "defaults": {
    "priority": "medium",
    "phase": "core",
    "labels": []
  },
  "session": {
    "requireSessionNote": true,
    "warnOnNoFocus": true,
    "autoStartSession": true,
    "sessionTimeoutHours": 72
  },
  "display": {
    "showArchiveCount": true,
    "showLogSummary": true,
    "warnStaleDays": 30
  },
  "backup": {
    "enabled": true,
    "directory": ".cleo/backups",
    "maxSnapshots": 10,
    "maxSafetyBackups": 5,
    "maxIncremental": 10,
    "maxArchiveBackups": 3,
    "safetyRetentionDays": 7
  }
}
```

## Configuration Sections

### Archive Settings

Controls automatic archiving behavior for completed tasks.

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `enabled` | boolean | `true` | - | Enable automatic archiving |
| `daysUntilArchive` | integer | `7` | 1-365 | Days after completion before eligible for archive |
| `maxCompletedTasks` | integer | `15` | 1-100 | Maximum completed tasks before triggering archive |
| `preserveRecentCount` | integer | `3` | 0-20 | Number of recent completed tasks to always keep |
| `archiveOnSessionEnd` | boolean | `true` | - | Check archive eligibility when session ends |
| `autoArchiveOnComplete` | boolean | `false` | - | Archive immediately when task completed (if eligible) |

**Archive Trigger Logic:**
- Tasks become eligible for archive after `daysUntilArchive` days
- Archive runs when completed tasks exceed `maxCompletedTasks`
- Most recent `preserveRecentCount` completed tasks are always preserved
- Can be triggered:
  - Manually via `cleo archive`
  - At session end (if `archiveOnSessionEnd: true`)
  - Immediately on task completion (if `autoArchiveOnComplete: true`)

**Examples:**
```json
// Conservative: Keep tasks longer, preserve more context
{
  "archive": {
    "enabled": true,
    "daysUntilArchive": 14,
    "maxCompletedTasks": 30,
    "preserveRecentCount": 5,
    "archiveOnSessionEnd": false
  }
}

// Aggressive: Archive quickly, minimal history
{
  "archive": {
    "enabled": true,
    "daysUntilArchive": 1,
    "maxCompletedTasks": 5,
    "preserveRecentCount": 0,
    "archiveOnSessionEnd": true,
    "autoArchiveOnComplete": true
  }
}

// Manual-only: Disable automatic archiving
{
  "archive": {
    "enabled": false
  }
}
```

### Logging Settings

Controls change history logging to `todo-log.json`.

| Field | Type | Default | Options | Description |
|-------|------|---------|---------|-------------|
| `enabled` | boolean | `true` | - | Enable change logging |
| `retentionDays` | integer | `30` | 1-365 | Days to retain log entries |
| `level` | string | `"standard"` | `minimal`, `standard`, `verbose` | Detail level of logging |
| `logSessionEvents` | boolean | `true` | - | Log session start/end events |

**Logging Levels:**
- **minimal**: Only status changes (pending → active → done)
- **standard**: Status changes plus notes and priority changes
- **verbose**: All field changes including labels, dependencies

**Examples:**
```json
// Detailed audit trail
{
  "logging": {
    "enabled": true,
    "retentionDays": 90,
    "level": "verbose",
    "logSessionEvents": true
  }
}

// Minimal logging for performance
{
  "logging": {
    "enabled": true,
    "retentionDays": 7,
    "level": "minimal",
    "logSessionEvents": false
  }
}

// Disable logging (not recommended)
{
  "logging": {
    "enabled": false
  }
}
```

### Validation Settings

Controls data integrity checks and anti-hallucination mechanisms.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `strictMode` | boolean | `false` | Treat warnings as errors, block operations on any issue |
| `checksumEnabled` | boolean | `true` | **CRITICAL** - Enable checksum verification for anti-hallucination |
| `enforceAcceptance` | boolean | `true` | Require acceptance criteria for high/critical priority tasks |
| `requireDescription` | boolean | `false` | Require description field for all tasks |
| `maxActiveTasks` | integer | `1` | Maximum number of in_progress tasks (1-1) |
| `validateDependencies` | boolean | `true` | Verify all dependency references exist |
| `detectCircularDeps` | boolean | `true` | Detect and block circular dependency chains |

**Important Notes:**
- `checksumEnabled` should **always** be `true` - disabling removes critical anti-hallucination protection
- `maxActiveTasks` is intentionally limited to 1 to enforce focus (see ARCHITECTURE.md)
- `strictMode` is useful during initial setup or troubleshooting, but may be too restrictive for normal use

**Examples:**
```json
// Strict validation (recommended for teams)
{
  "validation": {
    "strictMode": true,
    "checksumEnabled": true,
    "enforceAcceptance": true,
    "requireDescription": true,
    "maxActiveTasks": 1,
    "validateDependencies": true,
    "detectCircularDeps": true
  }
}

// Relaxed validation (personal use)
{
  "validation": {
    "strictMode": false,
    "checksumEnabled": true,
    "enforceAcceptance": false,
    "requireDescription": false,
    "maxActiveTasks": 1,
    "validateDependencies": true,
    "detectCircularDeps": true
  }
}

// DANGER: Minimal validation (not recommended)
{
  "validation": {
    "strictMode": false,
    "checksumEnabled": true,  // Never disable this!
    "enforceAcceptance": false,
    "requireDescription": false,
    "maxActiveTasks": 1,
    "validateDependencies": false,
    "detectCircularDeps": false
  }
}
```

### Defaults Settings

Default values applied to new tasks.

| Field | Type | Default | Options | Description |
|-------|------|---------|---------|-------------|
| `priority` | string | `"medium"` | `critical`, `high`, `medium`, `low` | Default task priority |
| `phase` | string | `"core"` | Pattern: `^[a-z][a-z0-9-]*$` | Default project phase |
| `labels` | array | `[]` | Array of strings | Default labels for new tasks |

**Examples:**
```json
// Backend project defaults
{
  "defaults": {
    "priority": "high",
    "phase": "backend",
    "labels": ["api", "backend"]
  }
}

// Frontend project defaults
{
  "defaults": {
    "priority": "medium",
    "phase": "frontend",
    "labels": ["ui", "react"]
  }
}

// Research project defaults
{
  "defaults": {
    "priority": "low",
    "phase": "research",
    "labels": ["exploration", "documentation"]
  }
}
```

### Session Settings

Controls session behavior and warnings.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `requireSessionNote` | boolean | `true` | Warn if session ends without updating sessionNote |
| `warnOnNoFocus` | boolean | `true` | Warn if no task is active at session start |
| `autoStartSession` | boolean | `true` | Automatically log session_start on first read |
| `sessionTimeoutHours` | integer | `72` | Hours before orphaned session warning (1-168) |

**Examples:**
```json
// Strict session management (recommended)
{
  "session": {
    "requireSessionNote": true,
    "warnOnNoFocus": true,
    "autoStartSession": true,
    "sessionTimeoutHours": 12
  }
}

// Relaxed session management
{
  "session": {
    "requireSessionNote": false,
    "warnOnNoFocus": false,
    "autoStartSession": true,
    "sessionTimeoutHours": 48
  }
}

// Manual session management
{
  "session": {
    "requireSessionNote": false,
    "warnOnNoFocus": false,
    "autoStartSession": false,
    "sessionTimeoutHours": 72
  }
}
```

### Display Settings

Controls output formatting and notifications.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `showArchiveCount` | boolean | `true` | Display archived task count in status output |
| `showLogSummary` | boolean | `true` | Display recent log activity summary |
| `warnStaleDays` | integer | `30` | Warn about pending tasks older than this (days) |

**Examples:**
```json
// Detailed display (recommended)
{
  "display": {
    "showArchiveCount": true,
    "showLogSummary": true,
    "warnStaleDays": 14
  }
}

// Minimal display
{
  "display": {
    "showArchiveCount": false,
    "showLogSummary": false,
    "warnStaleDays": 60
  }
}

// Alert on stale tasks quickly
{
  "display": {
    "showArchiveCount": true,
    "showLogSummary": true,
    "warnStaleDays": 7
  }
}
```

### CLI Settings (v0.6.0+)

Controls CLI behavior, command aliases, and plugin discovery.

#### Aliases

| Alias | Target | Description |
|-------|--------|-------------|
| `ls` | `list` | List tasks |
| `done` | `complete` | Complete a task |
| `new` | `add` | Add new task |
| `edit` | `update` | Update existing task |
| `rm` | `archive` | Archive completed tasks |
| `check` | `validate` | Validate todo files |

**Custom Aliases:**
```json
{
  "cli": {
    "aliases": {
      "ls": "list",
      "done": "complete",
      "new": "add",
      "edit": "update",
      "rm": "archive",
      "check": "validate",
      "s": "stats",          // Custom: short for stats
      "f": "focus"           // Custom: short for focus
    }
  }
}
```

#### Plugins

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable plugin discovery |
| `directories` | array | `["~/.cleo/plugins", "./.cleo/plugins"]` | Plugin search paths |
| `autoDiscover` | boolean | `true` | Auto-discover plugins on startup |

**Plugin Configuration:**
```json
{
  "cli": {
    "plugins": {
      "enabled": true,
      "directories": [
        "~/.cleo/plugins",
        "./.cleo/plugins"
      ],
      "autoDiscover": true
    }
  }
}
```

#### Debug Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable debug mode globally |
| `validateMappings` | boolean | `true` | Validate command-to-script mappings |
| `checksumVerify` | boolean | `true` | Verify script checksums |
| `showTimings` | boolean | `false` | Show command execution times |

**Debug Configuration:**
```json
{
  "cli": {
    "debug": {
      "enabled": false,
      "validateMappings": true,
      "checksumVerify": true,
      "showTimings": false
    }
  }
}
```

**Debug Mode Usage:**
```bash
# Run debug validation
cleo --validate

# Enable debug for single command
CLEO_DEBUG=1 cleo list

# List all available commands
cleo --list-commands
```

### Backup Settings (v0.9.8+)

Controls the backup system for task data protection and recovery.

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `enabled` | boolean | `true` | - | Enable backup system globally |
| `directory` | string | `".cleo/backups"` | - | Root directory for all backup types |
| `maxSnapshots` | integer | `10` | 0-100 | Maximum snapshot backups (count-based retention) |
| `maxSafetyBackups` | integer | `5` | 0-50 | Maximum safety backups (count + time retention) |
| `maxIncremental` | integer | `10` | 0-100 | Maximum incremental backups (count-based retention) |
| `maxArchiveBackups` | integer | `3` | 0-20 | Maximum archive backups (count-based retention) |
| `safetyRetentionDays` | integer | `7` | 0-365 | Safety backup time retention (works with maxSafetyBackups) |

**Backup Types:**

1. **Snapshot** - Full state before risky operations (pre-migration, bulk changes)
2. **Safety** - Automatic before all write operations (atomic pattern protection)
3. **Incremental** - Changed files only (performance optimization)
4. **Archive** - Long-term storage of todo.json + todo-archive.json
5. **Migration** - Schema version changes (NEVER auto-deleted)

**Retention Policies:**
- **Snapshot**: Count-based using `maxSnapshots` (oldest deleted first)
- **Safety**: Hybrid - both time-based (`safetyRetentionDays`) AND count-based (`maxSafetyBackups`)
- **Incremental**: Count-based using `maxIncremental`
- **Archive**: Count-based using `maxArchiveBackups`
- **Migration**: PERMANENT - never auto-deleted

**Examples:**
```json
// Conservative: Keep more backups for safety
{
  "backup": {
    "enabled": true,
    "directory": ".cleo/backups",
    "maxSnapshots": 20,
    "maxSafetyBackups": 10,
    "maxIncremental": 20,
    "maxArchiveBackups": 5,
    "safetyRetentionDays": 14
  }
}

// Aggressive: Minimal disk usage
{
  "backup": {
    "enabled": true,
    "directory": ".cleo/backups",
    "maxSnapshots": 3,
    "maxSafetyBackups": 2,
    "maxIncremental": 5,
    "maxArchiveBackups": 1,
    "safetyRetentionDays": 3
  }
}

// Performance: Optimize for speed
{
  "backup": {
    "enabled": true,
    "directory": ".cleo/backups",
    "maxSnapshots": 5,
    "maxSafetyBackups": 3,
    "maxIncremental": 15,  // Use incremental more
    "maxArchiveBackups": 2,
    "safetyRetentionDays": 7
  }
}

// Disable backups (NOT RECOMMENDED - removes safety net)
{
  "backup": {
    "enabled": false
  }
}
```

**Backup System Integration:**

The backup system is integrated into all write operations:
- **Automatic**: Safety backups created before all file modifications
- **Manual**: Use `cleo backup` command
- **Recovery**: Use `cleo restore [backup]` command
- **Listing**: Use `cleo backup --list` command

**Disk Usage Considerations:**

Typical backup sizes:
- Safety backup: ~10-50 KB per backup
- Snapshot backup: ~50-200 KB (full state)
- Incremental backup: ~5-20 KB (changed files only)
- Archive backup: ~20-100 KB

With defaults (10 snapshots, 5 safety, 10 incremental, 3 archive):
- Expected total: 1-5 MB
- Cleanup runs automatically based on retention policies

**Important Notes:**
- Migration backups are NEVER deleted (rollback protection)
- Setting retention to 0 disables that backup type
- Safety backups use BOTH time and count retention (whichever triggers first)
- Backup directory can be absolute or relative to `.cleo/`

### Retention Settings (v0.70.0+)

Controls session lifecycle management and garbage collection for sessions.json.

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `maxSessionsInMemory` | integer | `100` | 10-1000 | Maximum sessions in sessions.json before auto-archiving |
| `maxArchivedSessions` | integer | `100` | 10-1000 | Maximum archived sessions before permanent deletion |
| `autoArchiveEndedAfterDays` | integer | `30` | 1-365 | Days before ended sessions are auto-archived |
| `autoDeleteArchivedAfterDays` | integer | `90` | 0-730 | Days before archived sessions are deleted (0 disables) |
| `autoEndActiveAfterDays` | integer | `7` | 1-365 | Days before stale active sessions are auto-ended |
| `contextStateRetentionDays` | integer | `7` | 1-90 | Days to retain orphaned context state files |
| `cleanupOnSessionEnd` | boolean | `true` | - | Run cleanup when sessions end |
| `dryRunByDefault` | boolean | `true` | - | Default to dry-run mode for cleanup operations |

**Session Lifecycle:**
1. **Active** - Session in use
2. **Ended** - Session completed but retained in sessions.json
3. **Archived** - Moved to archive (read-only, audit trail)
4. **Deleted** - Permanently removed

**Retention Triggers:**
- After `autoEndActiveAfterDays` without activity, active sessions are automatically ended
- When session count exceeds `maxSessionsInMemory`, `session gc` auto-archives oldest ended sessions
- After `autoArchiveEndedAfterDays`, ended sessions become archive candidates
- After `autoDeleteArchivedAfterDays`, archived sessions are permanently deleted
- Archived sessions beyond `maxArchivedSessions` are deleted (oldest first)

**Examples:**
```json
// Default: Balance between retention and performance
{
  "retention": {
    "maxSessionsInMemory": 100,
    "maxArchivedSessions": 100,
    "autoEndActiveAfterDays": 7,
    "autoArchiveEndedAfterDays": 30,
    "autoDeleteArchivedAfterDays": 90
  }
}

// Aggressive cleanup: Minimal session retention
{
  "retention": {
    "maxSessionsInMemory": 20,
    "maxArchivedSessions": 50,
    "autoEndActiveAfterDays": 3,
    "autoArchiveEndedAfterDays": 7,
    "autoDeleteArchivedAfterDays": 30
  }
}

// Long retention: Keep session history
{
  "retention": {
    "maxSessionsInMemory": 500,
    "maxArchivedSessions": 500,
    "autoEndActiveAfterDays": 14,
    "autoArchiveEndedAfterDays": 90,
    "autoDeleteArchivedAfterDays": 365
  }
}
```

## Environment Variables

Override configuration using environment variables with `CLEO_` prefix:

```bash
# Archive settings
export CLEO_ARCHIVE_ENABLED=true
export CLEO_ARCHIVE_DAYS_UNTIL_ARCHIVE=14
export CLEO_ARCHIVE_MAX_COMPLETED_TASKS=20
export CLEO_ARCHIVE_PRESERVE_RECENT_COUNT=5

# Logging settings
export CLEO_LOGGING_ENABLED=true
export CLEO_LOGGING_LEVEL=verbose
export CLEO_LOGGING_RETENTION_DAYS=60

# Validation settings
export CLEO_VALIDATION_STRICT_MODE=true
export CLEO_VALIDATION_CHECKSUM_ENABLED=true
export CLEO_VALIDATION_MAX_ACTIVE_TASKS=1

# Session settings
export CLEO_SESSION_REQUIRE_SESSION_NOTE=true
export CLEO_SESSION_AUTO_START_SESSION=true

# Display settings
export CLEO_DISPLAY_WARN_STALE_DAYS=7

# Backup settings
export CLEO_BACKUP_ENABLED=true
export CLEO_BACKUP_DIRECTORY=".cleo/backups"
export CLEO_BACKUP_MAX_SNAPSHOTS=10
export CLEO_BACKUP_MAX_SAFETY_BACKUPS=5
export CLEO_BACKUP_MAX_INCREMENTAL=10
export CLEO_BACKUP_MAX_ARCHIVE_BACKUPS=3
export CLEO_BACKUP_SAFETY_RETENTION_DAYS=7
```

**Environment Variable Naming Convention:**
- Prefix: `CLEO_`
- Section: Uppercase section name (e.g., `ARCHIVE`, `LOGGING`)
- Field: Uppercase field name with underscores (e.g., `DAYS_UNTIL_ARCHIVE`)
- Values: `true`/`false` for booleans, numbers for integers, strings for text

## CLI Flag Overrides

Most configuration values can be overridden via command-line flags:

```bash
# Override archive settings
cleo add --no-archive-on-complete "Task description"

# Override validation settings
cleo add --no-strict "Task description"
cleo complete --allow-multiple-active T001

# Override logging settings
cleo add --log-level=verbose "Task description"

# Override display settings
cleo list --no-show-archive-count
```

See individual command documentation for available flags.

## Common Configuration Scenarios

### Solo Developer - Focused Work

```json
{
  "version": "2.1.0",
  "archive": {
    "enabled": true,
    "daysUntilArchive": 7,
    "maxCompletedTasks": 10,
    "preserveRecentCount": 3,
    "archiveOnSessionEnd": true
  },
  "validation": {
    "strictMode": false,
    "checksumEnabled": true,
    "maxActiveTasks": 1,
    "enforceAcceptance": false
  },
  "session": {
    "requireSessionNote": true,
    "warnOnNoFocus": true,
    "autoStartSession": true
  }
}
```

### Team Project - Strict Standards

```json
{
  "version": "2.1.0",
  "archive": {
    "enabled": true,
    "daysUntilArchive": 14,
    "maxCompletedTasks": 30,
    "preserveRecentCount": 5
  },
  "logging": {
    "enabled": true,
    "retentionDays": 90,
    "level": "verbose",
    "logSessionEvents": true
  },
  "validation": {
    "strictMode": true,
    "checksumEnabled": true,
    "enforceAcceptance": true,
    "requireDescription": true,
    "maxActiveTasks": 1,
    "validateDependencies": true,
    "detectCircularDeps": true
  },
  "display": {
    "warnStaleDays": 7
  }
}
```

### Research/Exploration - Minimal Constraints

```json
{
  "version": "2.1.0",
  "archive": {
    "enabled": false
  },
  "logging": {
    "level": "minimal"
  },
  "validation": {
    "strictMode": false,
    "checksumEnabled": true,
    "enforceAcceptance": false,
    "requireDescription": false,
    "maxActiveTasks": 1
  },
  "session": {
    "requireSessionNote": false,
    "warnOnNoFocus": false
  },
  "display": {
    "warnStaleDays": 60
  }
}
```

### Long-Running Project - Comprehensive Tracking

```json
{
  "version": "2.1.0",
  "archive": {
    "enabled": true,
    "daysUntilArchive": 30,
    "maxCompletedTasks": 50,
    "preserveRecentCount": 10,
    "archiveOnSessionEnd": false
  },
  "logging": {
    "enabled": true,
    "retentionDays": 180,
    "level": "verbose",
    "logSessionEvents": true
  },
  "validation": {
    "strictMode": false,
    "checksumEnabled": true,
    "enforceAcceptance": true,
    "validateDependencies": true,
    "detectCircularDeps": true,
    "maxActiveTasks": 1
  },
  "display": {
    "showArchiveCount": true,
    "showLogSummary": true,
    "warnStaleDays": 14
  }
}
```

## Configuration Validation

Configuration files are validated against `config.schema.json` during:
- Project initialization (`cleo init`)
- Manual validation (`cleo validate`)
- Command execution (if validation enabled)

### Valid Value Ranges

| Field | Valid Range | Notes |
|-------|-------------|-------|
| `version` | Semantic version (e.g., `2.1.0`) | Must match pattern `^\d+\.\d+\.\d+$` |
| `daysUntilArchive` | 1-365 | Realistic timeframes for archiving |
| `maxCompletedTasks` | 1-100 | Prevents excessive todo.json size |
| `preserveRecentCount` | 0-20 | Balance between context and clutter |
| `retentionDays` | 1-365 | Log retention period |
| `level` | `minimal`, `standard`, `verbose` | Logging detail level |
| `maxActiveTasks` | 1-1 | Enforces single-task focus (by design) |
| `priority` | `critical`, `high`, `medium`, `low` | Task priority levels |
| `phase` | Pattern: `^[a-z][a-z0-9-]*$` | Lowercase with hyphens |
| `sessionTimeoutHours` | 1-168 | Reasonable session duration |
| `warnStaleDays` | 1-999 | Task staleness threshold |
| `maxSnapshots` | 0-100 | Snapshot backup retention count |
| `maxSafetyBackups` | 0-50 | Safety backup retention count |
| `maxIncremental` | 0-100 | Incremental backup retention count |
| `maxArchiveBackups` | 0-20 | Archive backup retention count |
| `safetyRetentionDays` | 0-365 | Safety backup time retention |

### Schema Reference

For complete schema definition including all constraints and validation rules:
```bash
cat ~/.cleo/schemas/config.schema.json
```

See also: [schema-reference.md](../architecture/SCHEMAS.md)

## Troubleshooting Configuration

### Configuration Not Taking Effect

**Check override hierarchy:**
```bash
# Verify project config exists
cat .cleo/config.json

# Check environment variables
env | grep CLEO_

# Test with explicit CLI flags
cleo list --help
```

**Validate configuration:**
```bash
cleo validate .cleo/config.json
```

### Invalid Configuration Values

**Error: "Invalid configuration value"**
- Check value ranges in schema
- Ensure correct data types (boolean vs string)
- Verify enum values match exactly (case-sensitive)

**Error: "Missing required field: version"**
- Add version field: `"version": "2.1.0"`

**Error: "Unknown field"**
- Check for typos in field names
- Verify field exists in schema (additionalProperties: false)

### Performance Issues

If operations are slow:
- Reduce `logging.level` to `minimal`
- Increase `archive.maxCompletedTasks` threshold
- Disable `logSessionEvents` if not needed
- Consider shorter `retentionDays` for logs

### Configuration Migration

When upgrading between versions:
```bash
# Backup current config
cp .cleo/config.json .cleo/todo-config.backup.json

# Re-initialize to get new defaults (preserves existing data)
cleo init --force

# Validate migrated config
cleo validate .cleo/config.json
```

> **Note**: For automated schema migrations, see the [Migration Guide](migration-guide.md). The `cleo migrate` command handles version upgrades automatically with backup and rollback support.

## Best Practices

1. **Start with defaults** - Only customize what you need
2. **Use project config** - Keep global config minimal for personal preferences
3. **Enable checksums** - Never disable `checksumEnabled` (anti-hallucination protection)
4. **Enforce focus** - Keep `maxActiveTasks: 1` unless you have compelling reason
5. **Regular archiving** - Set reasonable `daysUntilArchive` (7-14 days typical)
6. **Log appropriately** - Use `standard` logging unless you need `verbose` for auditing
7. **Version control** - Commit `.cleo/config.json` to share team standards
8. **Test changes** - Validate configuration after editing
9. **Document overrides** - Comment why you changed defaults (JSON doesn't support comments, use separate docs)
10. **Review periodically** - Adjust settings as project needs evolve

## See Also

- [Installation Guide](installation.md) - Setting up CLEO
- [Usage Guide](../usage.md) - Working with tasks
- [Schema Reference](../architecture/SCHEMAS.md) - Complete schema documentation
- [Troubleshooting](troubleshooting.md) - Common issues and solutions
- [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) - System design and rationale
