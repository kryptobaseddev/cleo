# Log Viewing Commands

The `cleo log` command provides subcommands for viewing and analyzing log entries.

## Commands

### `log list` - List Log Entries

List log entries with filtering and formatting options.

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

**Examples:**

```bash
# Last 20 entries (default)
cleo log list

# Last 50 entries
cleo log list --limit 50

# All entries
cleo log list --limit 0

# Filter by action type
cleo log list --action task_created
cleo log list --action status_changed

# Filter by task
cleo log list --task-id T001

# Filter by actor
cleo log list --actor system
cleo log list --actor claude

# Filter by date
cleo log list --since "2025-12-13"

# JSON output
cleo log list --format json

# Combined filters
cleo log list --action task_created --since "2025-12-13" --limit 10
```

**Text Output Format:**

```
[2025-12-14 00:27:34] session_end - (no task) by system
[2025-12-14 00:34:51] task_created - T182 by system
  title: "Enhance dashboard to show archived tasks"
  details: {"title":"Enhance dashboard...","status":"pending","priority":"medium"}
```

**JSON Output Format:**

```json
[
  {
    "id": "log_abc123",
    "timestamp": "2025-12-14T00:27:34Z",
    "sessionId": "session_20251213_162436_1e8640",
    "action": "session_end",
    "actor": "system",
    "taskId": null,
    "before": null,
    "after": null,
    "details": null
  }
]
```

### `log show` - Show Log Entry Details

Display detailed information about a specific log entry.

```bash
cleo log show <log-id>
```

**Examples:**

```bash
# Show specific log entry
cleo log show log_abc123

# Find and show recent task creation
LOG_ID=$(cleo log list --action task_created --format json | jq -r '.[0].id')
cleo log show $LOG_ID
```

**Output Format:**

```
Log Entry: log_0522c2e2b2a9
Timestamp:  2025-12-13 08:08:21
Action:     status_changed
Actor:      system
Task ID:    T058

Before:
{"status":"pending","completedAt":null}

After:
{"status":"done","completedAt":"2025-12-13T08:08:21Z"}

Details:
{"field":"status","operation":"complete"}
```

## Action Types

Valid action types for filtering:

- `session_start` - Session initiated
- `session_end` - Session terminated
- `task_created` - New task added
- `task_updated` - Task modified
- `status_changed` - Task status changed
- `task_archived` - Task moved to archive
- `focus_changed` - Focus changed to different task
- `config_changed` - Configuration modified
- `validation_run` - Validation executed
- `checksum_updated` - Checksum recalculated
- `error_occurred` - Error logged
- `system_initialized` - System initialized for project

## Common Workflows

### Audit Task History

View all changes to a specific task:

```bash
cleo log list --task-id T001 --limit 0
```

### Session Review

View all actions in a specific session:

```bash
# Get session ID from todo.json
SESSION_ID=$(jq -r '._meta.activeSession // ._meta.lastSession' .cleo/todo.json)

# Filter log by session (requires jq)
cleo log list --format json | jq --arg sid "$SESSION_ID" '.[] | select(.sessionId == $sid)'
```

### Daily Activity Report

View all activity for a specific day:

```bash
cleo log list --since "2025-12-13" --limit 0
```

### Task Creation Timeline

View when tasks were created:

```bash
cleo log list --action task_created --limit 0
```

### Debug Status Changes

Find status change entries with before/after state:

```bash
cleo log list --action status_changed --format json | \
  jq '.[] | select(.before != null and .after != null)'
```

## Integration with Other Commands

### Export to CSV

```bash
cleo log list --format json | \
  jq -r '.[] | [.timestamp, .action, .taskId // "", .actor] | @csv' > log.csv
```

### Count Actions by Type

```bash
cleo log list --limit 0 --format json | \
  jq -r '.[].action' | sort | uniq -c | sort -rn
```

### Find Recent Errors

```bash
cleo log list --action error_occurred --limit 10
```

## See Also

- [Task Management](../usage.md)
- [Session Management](./session.md)
- [Log Schema](../architecture/log-schema.md)
