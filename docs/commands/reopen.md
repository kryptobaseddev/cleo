# reopen

Restore a completed task back to pending (or other) status.

## Overview

The `reopen` command reverses task completion, allowing you to reopen tasks that were:
- Completed prematurely
- Auto-completed when child tasks finished
- Need additional work after initial completion

**Primary Use Case**: Reopening auto-completed epics when child tasks were marked done but work is actually incomplete.

## Usage

```bash
cleo reopen <TASK_ID> --reason "Why reopening" [OPTIONS]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `TASK_ID` | Task ID to reopen (e.g., T001) |

### Required Options

| Option | Description |
|--------|-------------|
| `-r, --reason TEXT` | Reason for reopening (required for audit trail) |

### Optional Options

| Option | Description | Default |
|--------|-------------|---------|
| `-s, --status STATUS` | Target status: `pending`, `active`, `blocked` | `pending` |
| `--dry-run` | Preview changes without applying | - |
| `-f, --format FMT` | Output format: `text`, `json` | auto-detect |
| `--human` | Force human-readable text output | - |
| `--json` | Force JSON output | - |
| `-q, --quiet` | Suppress non-essential output | - |
| `-h, --help` | Show help | - |

## Examples

### Basic Usage

```bash
# Reopen a completed task
cleo reopen T001 --reason "Child task was incomplete"

# Reopen and immediately make active
cleo reopen T001 --reason "Resuming work now" --status active

# Preview what would happen
cleo reopen T001 --reason "Testing" --dry-run
```

### JSON Output

```bash
# Get structured output
cleo reopen T001 --reason "Need more work" --json
```

Output:
```json
{
  "_meta": {
    "format": "json",
    "command": "reopen",
    "timestamp": "2025-12-24T10:00:00Z",
    "version": "0.36.0"
  },
  "success": true,
  "taskId": "T001",
  "reopenedAt": "2025-12-24T10:00:00Z",
  "previousStatus": "done",
  "newStatus": "pending",
  "reason": "Need more work",
  "previousCompletedAt": "2025-12-23T15:30:00Z",
  "wasAutoCompleted": true,
  "warning": null,
  "task": { ... }
}
```

## Behavior

### What Gets Changed

1. **Status**: Changes from `done` to target status (default: `pending`)
2. **completedAt**: Timestamp is cleared
3. **notes**: Completion info is preserved as a note:
   ```
   [REOPENED 2025-12-24T10:00:00Z] Reason: Child incomplete | Was completed at: 2025-12-23T15:30:00Z
   ```
4. **updatedAt**: Updated to current timestamp

### Auto-Complete Detection

The command automatically detects if the task was auto-completed (by the hierarchy system when all children finished). If so:
- Output indicates `wasAutoCompleted: true`
- The note includes `(was auto-completed)`

### Auto-Complete Warning

When reopening an epic where **all children are still done**, the command warns:

```
[WARN] Epic may auto-complete again if all children remain done.
       Consider reopening a child task first.
```

**To prevent re-auto-completion**, either:
1. Reopen a child task first using `reopen`
2. Disable auto-complete: `cleo config set hierarchy.autoCompleteMode off`

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Invalid input or arguments |
| 3 | File operation failure |
| 4 | Task not found |
| 6 | Task is not done (wrong status) |
| 102 | No changes (dry-run) |

## Status Requirements

| Current Status | Can Reopen? | Alternative |
|----------------|-------------|-------------|
| `done` | ✅ Yes | - |
| `pending` | ❌ No | Use `update --status` |
| `active` | ❌ No | Use `update --status` |
| `blocked` | ❌ No | Use `update --status` |
| `cancelled` | ❌ No | Use `uncancel` |
| `archived` | ❌ No | Use `unarchive` |

## Related Commands

| Command | Purpose |
|---------|---------|
| `complete` | Mark a task as done |
| `uncancel` | Restore cancelled tasks |
| `unarchive` | Restore archived tasks |
| `update --status` | Change status of non-done tasks |

## Aliases

- `restore-done` → `reopen`

## Best Practices

1. **Always provide a meaningful reason** - The reason is logged for audit trail
2. **Check for auto-complete risk** - If reopening an epic, verify child tasks
3. **Use dry-run first** - Preview changes before applying
4. **Consider disabling auto-complete** - If frequently reopening the same epic

## Version History

- **v0.36.0**: Initial implementation
