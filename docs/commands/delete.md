# delete Command

**Alias**: `cancel`

Cancel/soft-delete a task with configurable child handling strategies.

## Synopsis

```bash
cleo delete TASK_ID --reason "..." [OPTIONS]
cleo cancel TASK_ID --reason "..." [OPTIONS]  # alias
```

## Description

The `delete` command cancels a task by setting its status to `cancelled` and moves it to the archive. This is a **soft delete** - tasks are not permanently removed and can be restored using `uncancel`.

The command provides configurable child handling strategies:
- **block**: Prevent deletion if children exist (safe default)
- **orphan**: Remove parent reference from children, keeping them active
- **cascade**: Delete the task and all its descendants

Cancelled tasks retain their cancellation reason and timestamp for audit purposes.

## Arguments

| Argument | Description | Required |
|----------|-------------|----------|
| `TASK_ID` | Task ID to delete/cancel (e.g., T001) | Yes |

## Options

### Required Options

| Option | Description |
|--------|-------------|
| `--reason TEXT` | Reason for cancellation (5-300 characters). Can be skipped with `--skip-reason` if config allows. |

### Child Task Strategies

| Option | Description | Default |
|--------|-------------|---------|
| `--children MODE` | How to handle child tasks: `block`, `orphan`, or `cascade` | `block` |
| `--limit N` | Maximum tasks to delete in cascade mode (safety limit) | `10` |

### Flags

| Option | Short | Description |
|--------|-------|-------------|
| `--dry-run` | | Preview changes without applying |
| `--force` | | Skip confirmation prompts (for scripting) |
| `--skip-reason` | | Skip reason requirement (if config allows) |
| `--format FMT` | `-f` | Output format: `text` or `json` (default: auto-detect) |
| `--human` | | Force human-readable text output |
| `--json` | | Force JSON output |
| `--quiet` | `-q` | Suppress non-essential output |
| `--help` | `-h` | Show help message |

## Child Handling Strategies

### block (default)

Prevents deletion if the task has any children. This is the safest option and requires explicitly handling children first.

```bash
cleo delete T001 --reason "No longer needed" --children block
# ERROR: Task T001 has 3 child task(s)
```

### orphan

Removes the parent reference from all children, making them root-level tasks. Children remain active and workable.

```bash
cleo delete T001 --reason "Scope reduced" --children orphan
# Task T001 cancelled, children T002, T003 are now root tasks
```

### cascade

Deletes the task and all its descendants. Subject to the cascade limit for safety.

```bash
cleo delete T001 --reason "Epic cancelled" --children cascade
# Task T001 and all descendants cancelled
```

**Cascade Limit**: By default, cascade is limited to 10 tasks. Use `--limit N` to override or `--force` to bypass.

```bash
# Cascade with higher limit
cleo delete T001 --reason "Full cleanup" --children cascade --limit 25

# Force cascade (bypasses limit)
cleo delete T001 --reason "Full cleanup" --children cascade --force
```

## Configuration

Configure cancellation behavior in `.cleo/config.json`:

```json
{
  "cancellation": {
    "requireReason": true,
    "defaultChildStrategy": "block",
    "cascadeConfirmThreshold": 10,
    "allowCascade": true,
    "daysUntilArchive": 7
  }
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `requireReason` | Require cancellation reason | `true` |
| `defaultChildStrategy` | Default child handling strategy | `"block"` |
| `cascadeConfirmThreshold` | Confirm cascade above this count | `10` |
| `allowCascade` | Allow cascade strategy | `true` |
| `daysUntilArchive` | Days before auto-archive of cancelled tasks | `7` |

## Exit Codes

| Code | Name | Description | Recoverable |
|------|------|-------------|:-----------:|
| `0` | SUCCESS | Task deleted successfully | N/A |
| `2` | INVALID_INPUT | Invalid arguments or task ID format | No |
| `3` | FILE_ERROR | File operation failure | No |
| `4` | NOT_FOUND | Task not found | No |
| `6` | VALIDATION_ERROR | Validation failed (e.g., cascade disabled) | No |
| `16` | HAS_CHILDREN | Task has children, use `--children` strategy | **Yes** |
| `17` | TASK_COMPLETED | Task already completed, use `archive` instead | **Yes** |
| `18` | CASCADE_FAILED | Partial cascade failure | No |
| `102` | NO_CHANGE | Already cancelled (idempotent) | N/A |

### Handling Exit Code 16 (HAS_CHILDREN)

When a task has children and `--children block` (default) is used:

```bash
# First attempt fails
cleo delete T001 --reason "Scope change"
# Exit code 16: Task T001 has 3 child task(s)

# Resolve by choosing a strategy
cleo delete T001 --reason "Scope change" --children orphan
# or
cleo delete T001 --reason "Scope change" --children cascade
```

### Handling Exit Code 17 (TASK_COMPLETED)

Completed tasks cannot be deleted - use archive instead:

```bash
# Attempt to delete completed task
cleo delete T001 --reason "Cleanup"
# Exit code 17: Task is already completed - use archive instead

# Use archive for completed tasks
cleo archive
```

## Examples

### Basic Deletion

```bash
# Delete a single task with reason
cleo delete T042 --reason "Requirements changed after sprint planning"
```

### Cascade Deletion

```bash
# Delete epic and all children
cleo delete T001 --reason "Epic cancelled by stakeholder" --children cascade

# Delete with higher cascade limit
cleo delete T001 --reason "Project cancelled" --children cascade --limit 50
```

### Orphan Children

```bash
# Remove parent but keep children as independent tasks
cleo delete T010 --reason "Reorganizing task structure" --children orphan
```

### Dry-Run Preview

```bash
# Preview what would be deleted
cleo delete T001 --reason "Testing" --children cascade --dry-run
```

Output:
```
[DRY-RUN] Would delete task:

Task: Setup authentication system
ID: T001
Status: active -> cancelled
Reason: Testing
Children: 3 (strategy: cascade)
Total affected: 4 task(s)

No changes made (dry-run mode)
```

### JSON Output for Scripting

```bash
# Force JSON output for agent workflows
cleo delete T001 --reason "Automated cleanup" --force --json
```

## JSON Output

### Success Response

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "command": "delete",
    "timestamp": "2025-12-23T10:00:00Z",
    "version": "0.32.0"
  },
  "success": true,
  "taskId": "T001",
  "deletedAt": "2025-12-23T10:00:00Z",
  "reason": "Requirements changed",
  "childStrategy": "cascade",
  "affectedTasks": ["T001", "T002", "T003"],
  "orphanedTasks": [],
  "dependentsAffected": ["T010"],
  "focusCleared": false,
  "archived": false,
  "task": {
    "id": "T001",
    "title": "Setup authentication",
    "status": "cancelled",
    "cancelledAt": "2025-12-23T10:00:00Z",
    "cancelReason": "Requirements changed"
  }
}
```

### Error Response (Has Children)

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "command": "delete",
    "timestamp": "2025-12-23T10:00:00Z",
    "version": "0.32.0"
  },
  "success": false,
  "error": {
    "code": "E_HAS_CHILDREN",
    "message": "Task T001 has 3 child task(s): T002, T003, T004",
    "exitCode": 16,
    "recoverable": true,
    "suggestion": "Use --children orphan to unlink children, or --children cascade to delete all"
  }
}
```

### Dry-Run Response

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "command": "delete",
    "timestamp": "2025-12-23T10:00:00Z",
    "version": "0.32.0"
  },
  "success": true,
  "dryRun": true,
  "wouldDelete": {
    "taskId": "T001",
    "title": "Setup authentication",
    "reason": "Testing deletion",
    "childStrategy": "cascade",
    "childCount": 3,
    "affectedTasks": ["T001", "T002", "T003", "T004"],
    "totalAffected": 4
  },
  "task": {
    "id": "T001",
    "title": "Setup authentication",
    "status": "active"
  }
}
```

### Already Cancelled (Idempotent)

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "command": "delete",
    "timestamp": "2025-12-23T10:00:00Z",
    "version": "0.32.0"
  },
  "success": true,
  "noChange": true,
  "taskId": "T001",
  "message": "Task already cancelled",
  "cancelledAt": "2025-12-22T15:30:00Z"
}
```

## Agent Workflow Examples

### Basic Delete Workflow

```bash
# 1. Verify task exists and check for children
cleo show T042 --format json | jq '.task.childCount // 0'

# 2. Delete the task
cleo delete T042 --reason "Superseded by T100" --force --json

# 3. Verify deletion
cleo exists T042 --quiet || echo "Task deleted"
```

### Cascade Delete with Validation

```bash
# 1. Preview cascade scope
COUNT=$(cleo delete T001 --reason "test" --children cascade --dry-run --json \
  | jq '.wouldDelete.totalAffected')

# 2. Proceed if acceptable
if [[ "$COUNT" -le 20 ]]; then
  cleo delete T001 --reason "Epic cancelled" --children cascade --force --json
fi
```

### Handle Children Strategy Selection

```bash
# Check for children and select strategy
RESULT=$(cleo delete T001 --reason "Cleanup" --json 2>&1)
EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 16 ]]; then
  # Has children - use orphan strategy
  cleo delete T001 --reason "Cleanup" --children orphan --force --json
fi
```

## Safety Features

- **Backup Creation**: Automatic backup before modification
- **Atomic Writes**: All-or-nothing file operations
- **Cascade Limit**: Prevents accidental mass deletion
- **Confirmation Prompts**: Interactive confirmation for large cascades (TTY mode)
- **Dependency Cleanup**: Automatically removes orphaned dependency references
- **Focus Clearing**: Clears focus if the deleted task was focused
- **Audit Logging**: All deletions logged to `todo-log.json`

## Side Effects

1. **Sets `cancelledAt`**: ISO 8601 timestamp
2. **Sets `cancelReason`**: Provided reason text
3. **Adds cancellation note**: Timestamped entry in notes array
4. **Clears focus**: If deleted task was the current focus
5. **Updates dependents**: Removes dependency references from other tasks
6. **Orphans children**: If using `orphan` strategy
7. **Logs operation**: Entry in `todo-log.json`

## See Also

- [uncancel](uncancel.md) - Restore cancelled tasks to pending status
- [archive](archive.md) - Archive completed tasks
- [complete](complete.md) - Mark tasks as done
- [update](update.md) - Modify task fields
- [show](show.md) - View task details
