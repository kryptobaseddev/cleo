# uncancel Command

**Alias**: `restore-cancelled`

Restore cancelled tasks back to pending status.

## Synopsis

```bash
cleo uncancel TASK_ID [OPTIONS]
cleo restore-cancelled TASK_ID [OPTIONS]  # alias
```

## Description

The `uncancel` command restores a cancelled task back to `pending` status. This reverses the effect of the `delete` (cancel) command. The original cancellation reason is preserved in the task notes for audit purposes.

Key behaviors:
- Restored tasks always get `pending` status (not their original status)
- Original `cancellationReason` is added to notes: `[RESTORED timestamp] Originally cancelled: reason`
- `cancelledAt` and `cancellationReason` fields are removed from the task
- Supports `--cascade` to restore parent and all cancelled children together

## Options

### Required

| Option | Description |
|--------|-------------|
| `TASK_ID` | The ID of the cancelled task to restore (e.g., `T001`) |

### Optional

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--cascade` | | Also restore cancelled child tasks | false |
| `--notes TEXT` | `-n` | Add custom note explaining restoration | none |
| `--dry-run` | | Preview changes without applying | false |
| `--format FORMAT` | `-f` | Output format: `json`, `text` | auto-detect |
| `--json` | | Force JSON output | false |
| `--human` | | Force human-readable output | false |
| `--quiet` | `-q` | Suppress informational messages | false |
| `--help` | `-h` | Show help message | |

## Exit Codes

| Code | Name | Description | Recoverable |
|------|------|-------------|-------------|
| 0 | SUCCESS | Task restored successfully | N/A |
| 2 | INVALID_INPUT | Invalid task ID or arguments | Yes |
| 4 | NOT_FOUND | Task not found | No |
| 6 | VALIDATION_ERROR | Task is not cancelled | Yes |
| 102 | NO_CHANGE | Task already pending (idempotent) | N/A |

## JSON Output

### Success

```json
{
  "_meta": {
    "format": "json",
    "command": "uncancel",
    "timestamp": "2025-12-24T00:00:00Z",
    "version": "0.32.0"
  },
  "success": true,
  "taskId": "T001",
  "restoredAt": "2025-12-24T00:00:00Z",
  "previousStatus": "cancelled",
  "newStatus": "pending",
  "originalReason": "No longer needed",
  "restoredTasks": ["T001"],
  "cascadeRestored": false,
  "cascadeCount": 0,
  "task": {
    "id": "T001",
    "title": "Example task",
    "status": "pending"
  }
}
```

### Error (Task Not Cancelled)

```json
{
  "_meta": {
    "format": "json",
    "command": "uncancel",
    "timestamp": "2025-12-24T00:00:00Z",
    "version": "0.32.0"
  },
  "success": false,
  "error": {
    "code": "E_VALIDATION_ERROR",
    "message": "Task T001 is not cancelled (current status: pending)",
    "exitCode": 6,
    "recoverable": true,
    "suggestion": "Use 'cleo update T001 --status ...' to change task status"
  }
}
```

## Examples

### Basic Restore

```bash
# Restore a cancelled task
cleo uncancel T001

# With custom note
cleo uncancel T001 --notes "Re-opening per team decision"
```

### Cascade Restore

```bash
# Restore parent and all cancelled children
cleo uncancel T100 --cascade
```

### Dry-run Preview

```bash
# Preview what would be restored
cleo uncancel T001 --dry-run

# Cascade dry-run
cleo uncancel T100 --cascade --dry-run
```

### Agent Workflow

```bash
# Check if task is cancelled, then restore
TASK_STATUS=$(cleo show T001 | jq -r '.task.status')
if [[ "$TASK_STATUS" == "cancelled" ]]; then
    cleo uncancel T001 --notes "Automated restoration"
fi
```

## Related Commands

- **[delete](delete.md)** - Cancel/soft-delete a task (reverse operation)
- **[restore](restore.md)** - Restore from backup files
- **[archive](archive.md)** - Archive completed tasks
- **[update](update.md)** - Update task fields including status

## Notes

- Tasks are restored to `pending` status regardless of their original status before cancellation
- The cancellation reason is preserved in notes for audit trail
- If a cancelled task has been archived, it must first be retrieved from the archive
- Use `--cascade` carefully - it restores ALL cancelled children, not just directly cancelled ones
