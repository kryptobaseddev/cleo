# promote Command

Remove parent from a task, making it a root-level task.

## Usage

```bash
cleo promote TASK_ID [OPTIONS]
```

## Description

The `promote` command removes the parent relationship from a task, making it a root-level task. If the task was a subtask, its type is automatically changed to `task` unless `--no-type-update` is specified.

This command is equivalent to `cleo reparent TASK --to ""` but provides a simpler interface for the common operation of making tasks root-level.

## Arguments

| Argument | Description |
|----------|-------------|
| `TASK_ID` | Task to promote to root level (required) |

## Options

| Option | Description |
|--------|-------------|
| `--no-type-update` | Don't auto-update type (keep as subtask if applicable) |
| `--format FORMAT` | Output format: `text` (default) or `json` |
| `-q, --quiet` | Minimal output |
| `-h, --help` | Show help message |

## Examples

### Basic promotion
```bash
cleo promote T002       # Make T002 a root task
```

### Quiet promotion
```bash
cleo promote T005 -q    # Promote with minimal output
```

### Keep original type
```bash
cleo promote T003 --no-type-update  # Keep as subtask type
```

### JSON output
```bash
cleo promote T002 --format json
```

## Behavior

### Type Auto-Update
By default, if a subtask is promoted, its type is automatically changed from `subtask` to `task`. Use `--no-type-update` to preserve the original type.

### Root Task Handling
If the task is already a root task (no parent), the command succeeds with an informational message and makes no changes.

## JSON Output

When using `--format json`, the response includes:

```json
{
  "success": true,
  "taskId": "T002",
  "oldParent": "T001",
  "oldType": "subtask",
  "newType": "task"
}
```

For tasks that are already root level:

```json
{
  "success": true,
  "taskId": "T002",
  "message": "Task is already root-level"
}
```

## Error Conditions

The command will fail with appropriate error messages for:
- **Task not found**: Specified task ID doesn't exist
- **File operations**: Issues with reading/writing todo.json

## Exit Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | EXIT_SUCCESS | Success (including no-op for already root tasks) |
| 1 | EXIT_GENERAL_ERROR | Unknown option or general error |
| 2 | EXIT_INVALID_INPUT | Invalid input or arguments |
| 3 | EXIT_FILE_ERROR | File read/write error |
| 4 | EXIT_NOT_FOUND | Task not found |

## Integration with Other Commands

The `promote` command works seamlessly with:
- `reparent`: `promote T` is equivalent to `reparent T --to ""`
- `add-task`: Create tasks with parents, then promote as needed
- `focus`: Hierarchy context shows in focus display
- `next`: Hierarchy scoring affects task suggestions

## Comparison with reparent

| Operation | promote | reparent |
|-----------|---------|----------|
| Make root | `promote T` | `reparent T --to ""` |
| Change parent | Not available | `reparent T --to NEW_PARENT` |
| Interface | Simpler | More flexible |
| Type handling | Auto-updates subtask→task | Preserves type |

Use `promote` for simple root-level promotions, `reparent` for complex hierarchy changes.

## See Also

- [`reparent`](reparent.md) - Move task to different parent
- [`add-task`](add.md) - Create new tasks with parent relationships
- [`focus`](focus.md) - Show hierarchy context in focus display
- [`next`](next.md) - Hierarchy-aware task suggestions