# cleo unarchive

Restore archived tasks back to the active todo list.

## Synopsis

```bash
cleo unarchive <TASK_ID> [OPTIONS]
```

## Description

The `unarchive` command moves a task from the archive (`todo-archive.json`) back to the active todo list (`todo.json`). This is useful when work needs to resume on a previously completed and archived task.

## Arguments

| Argument | Description |
|----------|-------------|
| `<TASK_ID>` | ID of the archived task to restore |

## Options

| Option | Description |
|--------|-------------|
| `--status <status>` | Set status on restore (default: pending) |
| `--preserve-status` | Keep the archived task's original status |
| `--dry-run` | Show what would be done without making changes |
| `--format <format>` | Output format: text (default) or json |
| `--json` | Shortcut for `--format json` |
| `--human` | Shortcut for `--format text` |
| `--quiet` | Suppress non-essential output |
| `--help` | Show help message |

## Status Options

When restoring, the task status can be:

| Status | Description |
|--------|-------------|
| `pending` | Default - task needs work |
| `active` | Task is currently being worked |
| `blocked` | Task is waiting on something |
| `done` | Keep as completed (unusual) |

## Examples

```bash
# Restore task as pending (default)
cleo unarchive T1234

# Restore task as active
cleo unarchive T1234 --status active

# Preserve original archived status
cleo unarchive T1234 --preserve-status

# Preview restoration
cleo unarchive T1234 --dry-run

# JSON output
cleo unarchive T1234 --json
```

## Use Cases

1. **Incomplete work**: Task was marked done prematurely
2. **Regression**: Issue resurfaced and needs rework
3. **Reactivation**: Feature disabled but now needed again
4. **Error correction**: Task was archived by mistake

## Notes

- The task's archive metadata is removed
- `updatedAt` is set to current timestamp
- Original `completedAt` is preserved in notes
- Task ID remains the same

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Task not found in archive |
| 2 | Invalid arguments |
| 3 | File access error |
| 4 | Task ID format invalid |
| 6 | Validation error |

## See Also

- `cleo archive` - Archive completed tasks
- `cleo archive-stats` - Archive analytics
- `cleo reopen` - Reopen completed (non-archived) tasks
