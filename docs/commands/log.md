# Log Command (`cleo log`)

Manage todo-log.json entries with listing, filtering, and schema migrations.

## Overview

The `log` command provides four main functions:
1. **List log entries** - View audit log entries with filtering
2. **Show entry details** - View a specific log entry
3. **Add log entries** - Manually add entries to the audit log
4. **Migrate schema** - Migrate old log schema entries to the current schema

## Subcommands

### `list` - List Log Entries

List log entries with flexible filtering options.

**Usage:**
```bash
cleo log list [OPTIONS]
```

**Options:**
- `--limit N` - Show last N entries (default: 20, 0 = all)
- `--action ACTION` - Filter by action type
- `--task-id ID` - Filter by task ID
- `--actor ACTOR` - Filter by actor (human|claude|system)
- `--since DATE` - Show entries since date (YYYY-MM-DD)
- `--format FORMAT` - Output format: text|json (default: text)

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (validation failed, file not found, invalid operation) |

**Examples:**
```bash
# List last 20 entries
cleo log list

# List last 50 entries
cleo log list --limit 50

# Filter by action type
cleo log list --action task_created

# Filter by task ID
cleo log list --task-id T001

# Filter by date
cleo log list --since "2025-12-13"

# JSON output for scripting
cleo log list --format json
```

### `show` - Show Entry Details

Show details of a specific log entry by ID.

**Usage:**
```bash
cleo log show <log-id>
```

**Examples:**
```bash
# Show specific log entry
cleo log show log_abc123def456
```

### `migrate` - Schema Migration

Migrates old log entries to the current schema format.

**Transformations:**
- Field name changes: `operation` → `action`, `user` → `actor`, `task_id` → `taskId`
- Action value mapping: `create` → `task_created`, `update` → `task_updated`, `system_initialized` → `config_changed`

**Usage:**
```bash
cleo log migrate
```

**What it does:**
1. Scans `todo-log.json` for entries using old schema
2. Creates timestamped backup before migration
3. Transforms old entries to new schema
4. Validates migrated JSON
5. Atomically replaces log file
6. Logs the migration operation itself

**Output:**
```
[INFO] Starting log migration...
Found 50 entries to migrate (49 schema changes, 1 action mappings)
Created backup: .cleo/todo-log.json.pre-migration.20251213-164257
Successfully migrated 50 entries
[INFO] Migration completed successfully
```

**Safety:**
- Creates backup before migration: `.cleo/todo-log.json.pre-migration.<timestamp>`
- Atomic file replacement (temp → validate → rename)
- Validates JSON after migration
- Idempotent (safe to run multiple times)

### `add` - Add Log Entry

Manually add an entry to the audit log. Most log entries are created automatically by other commands.

**Usage:**
```bash
cleo log --action ACTION [OPTIONS]
```

**Required:**
- `--action ACTION` - One of: `session_start`, `session_end`, `task_created`, `task_updated`, `status_changed`, `task_archived`, `focus_changed`, `config_changed`, `validation_run`, `checksum_updated`, `error_occurred`

**Options:**
- `--task-id ID` - Task ID (for task-related actions)
- `--session-id ID` - Session ID (auto-detected from todo.json if not provided)
- `--before JSON` - State before change
- `--after JSON` - State after change
- `--details JSON` - Additional details
- `--actor ACTOR` - Who performed the action: `human`, `claude`, or `system` (default: `claude`)

**Examples:**

```bash
# Log session start
cleo log --action session_start --session-id "session_20251213_164257"

# Log status change
cleo log --action status_changed --task-id T001 \
  --before '{"status":"pending"}' \
  --after '{"status":"active"}'

# Log task creation
cleo log --action task_created --task-id T005 \
  --after '{"title":"New feature"}' \
  --actor human
```

## Log Schema

### Current Schema (v2.1)

**Entry structure:**
```json
{
  "id": "log_<12-hex-chars>",
  "timestamp": "ISO-8601 datetime",
  "sessionId": "string or null",
  "action": "enum value",
  "actor": "human|claude|system",
  "taskId": "string or null (T### format)",
  "before": "object or null",
  "after": "object or null",
  "details": "object/string/null"
}
```

**Valid actions:**
- `session_start` - Work session started
- `session_end` - Work session ended
- `task_created` - New task added
- `task_updated` - Task fields modified
- `status_changed` - Task status changed
- `task_archived` - Task archived
- `focus_changed` - Focus changed to different task
- `config_changed` - Configuration or system change
- `validation_run` - Validation executed
- `checksum_updated` - File checksum updated
- `error_occurred` - Error logged

### Legacy Schema

**Old field names:**
- `operation` → now `action`
- `user` → now `actor`
- `task_id` → now `taskId`

**Old action values:**
- `create` → now `task_created`
- `update` → now `task_updated`
- `system_initialized` → now `config_changed`

## When to Migrate

You should run `cleo log migrate` if:

1. **After upgrading** from versions before v0.10.2
2. **Schema validation fails** with old field names
3. **You see warnings** about deprecated log format
4. **Manual inspection** shows entries with `operation`, `user`, or `task_id` fields

## Migration Safety

**What's preserved:**
- All log entry data (id, timestamp, details, before/after states)
- Entry order (chronological)
- Total entry count
- Session IDs

**What's transformed:**
- Field names (operation → action, etc.)
- Action values (create → task_created, etc.)

**Backup location:**
```
.cleo/todo-log.json.pre-migration.YYYYMMDD-HHMMSS
```

**Recovery:**
If migration fails or produces incorrect results:
```bash
# Find latest backup
ls -lt .cleo/todo-log.json.pre-migration.*

# Restore from backup
cp .cleo/todo-log.json.pre-migration.YYYYMMDD-HHMMSS .cleo/todo-log.json

# Verify
cleo validate
```

## Implementation Details

**Library function:** `lib/logging.sh::migrate_log_entries()`

**Script:** `scripts/log.sh`

**Migration logic:**
1. Count entries needing migration (schema + action mapping)
2. Create timestamped backup
3. Use jq to transform entries:
   - Map field names
   - Map action values
   - Preserve all other data
4. Validate transformed JSON
5. Atomic file replacement
6. Log migration operation itself

**Atomic pattern:**
```bash
temp_file=$(create_temp_file)
jq 'transformation' log.json > temp_file
validate temp_file
mv temp_file log.json  # atomic on same filesystem
```

## Related Commands

- [`cleo validate`](../reference/validation.md) - Includes log schema validation
- [`cleo backup`](backup.md) - Creates full backups (includes logs)
- [`cleo restore`](restore.md) - Restore from backup (includes logs)

## Troubleshooting

**"No entries need migration" but validation fails:**
- Check schema version: `jq '.version' .cleo/todo-log.json`
- Manually inspect entries: `jq '.entries[0:3]' .cleo/todo-log.json`
- May be a different validation issue

**Migration fails with "Invalid JSON":**
- Check original file: `jq empty .cleo/todo-log.json`
- If corrupted, restore from backup: `cleo restore`
- Or restore from pre-migration backup (see above)

**Want to see what will be migrated:**
```bash
# Count old schema entries
jq '[.entries[] | select(has("operation"))] | length' .cleo/todo-log.json

# Count old action values
jq '[.entries[] | select(.action == "create" or .action == "update" or .action == "system_initialized")] | length' .cleo/todo-log.json
```

## See Also

- [Log Schema](../architecture/DATA-FLOWS.md#logging)
- [Anti-Hallucination Design](../architecture/ARCHITECTURE.md#anti-hallucination)
- [File Operations](../architecture/DATA-FLOWS.md#atomic-operations)
