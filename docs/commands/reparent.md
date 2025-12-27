# reparent Command

Move a task to a different parent in the hierarchy.

## Usage

```bash
cleo reparent TASK_ID --to PARENT_ID [OPTIONS]
```

## Description

The `reparent` command moves a task to a different parent task within the hierarchy. This allows reorganizing task relationships while maintaining data integrity and hierarchy constraints.

The command validates:
- Source task exists
- Target parent exists (if specified)
- Target parent is not a subtask (subtasks cannot have children)
- Move doesn't exceed maximum hierarchy depth (3 levels)
- Move doesn't create circular references
- Target parent doesn't exceed maximum children limit

## Arguments

| Argument | Description |
|----------|-------------|
| `TASK_ID` | Task to move (required) |
| `--to PARENT_ID` | New parent task ID (use `""` to remove parent, make root) |

## Options

| Option | Description |
|--------|-------------|
| `--format FORMAT` | Output format: `text` (default) or `json` |
| `-q, --quiet` | Minimal output |
| `-h, --help` | Show help message |

## Examples

### Move task under different parent
```bash
cleo reparent T002 --to T001    # Move T002 under T001
```

### Remove parent (make root task)
```bash
cleo reparent T002 --to ""      # Make T002 a root task
```

### Move subtask to different parent
```bash
cleo reparent T005 --to T003    # Move subtask T005 under T003
```

### JSON output
```bash
cleo reparent T002 --to T001 --format json
```

## Error Conditions

The command will fail with appropriate error messages for:
- **Task not found**: Specified task ID doesn't exist
- **Parent not found**: Target parent ID doesn't exist
- **Invalid parent type**: Cannot reparent to a subtask
- **Hierarchy violation**: Move would exceed depth limit
- **Sibling limit**: Target parent has too many children
- **Circular reference**: Task cannot be its own parent

## Exit Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | EXIT_SUCCESS | Success |
| 1 | EXIT_GENERAL_ERROR | Unknown option or general error |
| 2 | EXIT_INVALID_INPUT | Invalid input or arguments |
| 3 | EXIT_FILE_ERROR | File read/write error |
| 4 | EXIT_NOT_FOUND | Task not found |
| 10 | EXIT_PARENT_NOT_FOUND | Parent task not found |
| 11 | EXIT_DEPTH_EXCEEDED | Maximum depth exceeded |
| 12 | EXIT_SIBLING_LIMIT | Maximum siblings exceeded |
| 13 | EXIT_INVALID_PARENT_TYPE | Cannot reparent to subtask |
| 14 | EXIT_CIRCULAR_REFERENCE | Would create circular reference |

## JSON Output

When using `--format json`, the response includes:

```json
{
  "success": true,
  "taskId": "T002",
  "oldParent": "T001",
  "newParent": "T003",
  "timestamp": "2025-12-22T18:45:23Z"
}
```

## Integration with Other Commands

The `reparent` command works seamlessly with:
- `add-task`: Use `--parent` when creating tasks
- `promote`: Equivalent to `reparent TASK --to ""`
- `focus`: Hierarchy context shows in focus display
- `next`: Hierarchy scoring affects task suggestions

## See Also

- [`promote`](promote.md) - Remove parent from task
- [`add-task`](add.md) - Create new tasks with parent relationships
- [`focus`](focus.md) - Show hierarchy context in focus display
- [`next`](next.md) - Hierarchy-aware task suggestions