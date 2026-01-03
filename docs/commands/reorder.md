# reorder / swap Commands

Manage task position ordering within sibling groups.

## Synopsis

```bash
cleo reorder TASK_ID [OPTIONS]
cleo swap TASK_ID1 TASK_ID2
```

## Description

The `reorder` command changes the display position of a task within its sibling group (tasks with the same parent). The `swap` command exchanges positions of two sibling tasks.

Positions are per-parent scope: each parent (including root level) has its own independent sequence starting at 1.

## Options

### reorder

| Option | Description |
|--------|-------------|
| `--position N` | Move task to position N (shuffles other siblings) |
| `--before TASK_ID` | Move task before the specified sibling |
| `--after TASK_ID` | Move task after the specified sibling |
| `--top` | Move task to position 1 (first) |
| `--bottom` | Move task to last position |
| `--format FORMAT` | Output format: text\|json (default: auto-detect) |
| `-q, --quiet` | Minimal output |

### swap

Exchanges positions of exactly two tasks. Both tasks must share the same parent.

## Position Shuffle Rules

When moving a task to a new position:

- **SHUFFLE_UP** (target < current): Siblings at positions target..current-1 shift down (+1)
- **SHUFFLE_DOWN** (target > current): Siblings at positions current+1..target shift up (-1)
- **NO_OP** (target == current): No changes made

## Examples

### Basic Reordering

```bash
# Move T005 to position 1 (first in its sibling group)
cleo reorder T005 --position 1

# Move T005 before T002
cleo reorder T005 --before T002

# Move T005 after T003
cleo reorder T005 --after T003

# Move to first/last position shortcuts
cleo reorder T005 --top
cleo reorder T005 --bottom
```

### Swapping Positions

```bash
# Exchange positions of T001 and T003
cleo swap T001 T003
```

### Position with Add Command

```bash
# Add new task at specific position (shuffles existing)
cleo add "New Task" --position 2

# Add new task at end (default)
cleo add "New Task"  # Gets position = max + 1
```

### Viewing Positions

```bash
# List tasks sorted by position
cleo list --sort position

# Tree view shows children in position order
cleo list --tree --parent T001
```

## Output

### JSON Format

```json
{
  "success": true,
  "operation": "reorder",
  "task": {
    "id": "T005",
    "oldPosition": 5,
    "newPosition": 2,
    "parentId": null
  },
  "affectedSiblings": 3
}
```

### Swap Output

```json
{
  "success": true,
  "operation": "swap",
  "changes": [
    {"id": "T001", "oldPosition": 1, "newPosition": 3},
    {"id": "T003", "oldPosition": 3, "newPosition": 1}
  ]
}
```

## Position Invariants

1. Within any parent, positions form continuous sequence [1, 2, 3, ..., N]
2. No two siblings share the same position
3. Moving a parent does not alter children's position values
4. Position changes are atomic (all affected siblings updated together)

## Migration

Existing tasks without positions are automatically assigned positions:

```bash
# Check migration status
cleo migrate status

# Run position migration (assigns by createdAt order)
cleo migrate run
```

## Related Commands

- `cleo reparent` - Move task to different parent (updates positions in both scopes)
- `cleo list --sort position` - View tasks ordered by position
- `cleo list --tree` - Hierarchical view with position ordering

## See Also

- [add.md](add.md) - Task creation with --position
- [reparent.md](reparent.md) - Cross-parent moves
