# export-tasks Command

> Export tasks to portable JSON package for cross-project transfer

## Usage

```bash
cleo export-tasks [TASK_IDS] [OPTIONS]
```

**Arguments:**
- `TASK_IDS` - Comma or space-separated task IDs (e.g., T001,T002). Omit to export by filter or full project.

**Output:** JSON by default (non-TTY), human-readable with `--human`

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--output FILE` | `-o` | Output file path (use .cleo-export.json extension) | stdout |
| `--subtree` | | Include all descendants of specified task(s) | false |
| `--filter KEY=VALUE` | | Filter tasks by criteria (repeatable) | - |
| `--include-deps` | | Auto-include task dependencies | false |
| `--interactive` | | Interactive task selection UI (uses fzf if available) | false |
| `--dry-run` | | Preview selection without creating export file | false |
| `--format FORMAT` | `-f` | Output format: json\|human | json (non-TTY) |
| `--json` | | Force JSON output | |
| `--human` | | Force human-readable output | |
| `--quiet` | `-q` | Suppress informational messages | false |
| `--help` | `-h` | Show help message | |

### Filter Options

The `--filter` option is repeatable and supports:
- `status=X` - Filter by status (pending, active, blocked, done)
- `phase=X` - Filter by project phase
- `labels=X` - Filter by labels (comma-separated for OR logic)
- `priority=X` - Filter by priority (critical, high, medium, low)
- `type=X` - Filter by type (epic, task, subtask)

**Example:** `--filter status=pending --filter phase=core`

## Export Modes

| Mode | Trigger | Description |
|------|---------|-------------|
| `single` | TASK_IDS provided | Export specific task IDs only (no children) |
| `subtree` | TASK_IDS + `--subtree` | Export task(s) and all descendants |
| `filter` | `--filter` provided | Export tasks matching filter criteria |
| `full` | No IDs or filters | Export entire project (use with caution) |

## Examples

### Export Single Task

```bash
cleo export-tasks T001 --output auth-task.cleo-export.json
```

### Export Task and All Children

```bash
cleo export-tasks T001 --subtree --output auth-epic.cleo-export.json
```

This preserves the full hierarchy:
- Epic (T001)
  - Tasks (T002, T003)
    - Subtasks (T004, T005)

### Export Multiple Specific Tasks

```bash
cleo export-tasks T001,T005,T010 --output selected.cleo-export.json
```

Or with space-separated IDs:
```bash
cleo export-tasks T001 T005 T010 --output selected.cleo-export.json
```

### Export by Filter

Filter by status and phase:
```bash
cleo export-tasks --filter status=pending --filter phase=core --output core.cleo-export.json
```

Filter by multiple statuses (OR logic):
```bash
cleo export-tasks --filter status=pending,active --output active-tasks.cleo-export.json
```

Filter by labels:
```bash
cleo export-tasks --filter labels=bug,security --output security-bugs.cleo-export.json
```

### Export with Dependencies Auto-Included

```bash
cleo export-tasks T003 --include-deps --output task-with-deps.cleo-export.json
```

This automatically includes all tasks that T003 depends on.

### Interactive Selection

```bash
cleo export-tasks --interactive
```

Uses fzf for multi-select UI if available, falls back to numbered list.

### Preview Before Export (Dry Run)

```bash
cleo export-tasks T001 --subtree --dry-run
```

Shows:
- Export mode
- Task count
- Task IDs
- Output path (if specified)

### Export to stdout

```bash
cleo export-tasks T001 --subtree
```

Useful for piping to other tools or inspecting output.

### Combine Filters with Subtree

```bash
cleo export-tasks --filter type=epic --subtree --output all-epics.cleo-export.json
```

Exports all epics and their complete descendant trees.

## Package Format

Exports create `.cleo-export.json` packages containing:
- **Full task objects** - All fields preserved (title, description, status, labels, etc.)
- **ID mapping** - Original IDs tracked for relationship preservation
- **Relationship graph** - Hierarchy (parentId) and dependencies (depends)
- **Source metadata** - Project name, version, export timestamp
- **Checksum** - Integrity verification for import validation

Use `cleo import-tasks` to import packages into target project.

## Exit Codes

| Code | Meaning |
|:----:|---------|
| 0 | Success (EXIT_SUCCESS) |
| 2 | Invalid input or arguments (EXIT_INVALID_INPUT) |
| 3 | File operation failure (EXIT_FILE_ERROR) |
| 4 | Resource not found - task ID doesn't exist (EXIT_NOT_FOUND) |
| 5 | Missing dependency - jq not installed (EXIT_DEPENDENCY_ERROR) |
| 6 | Validation error - no tasks match selection (EXIT_VALIDATION_ERROR) |

**Exit code 4** occurs when:
- Specified task ID doesn't exist in todo.json
- Check with `cleo exists <id>` before exporting

**Exit code 6** occurs when:
- No tasks match filter criteria
- Empty selection after applying filters

## Related Commands

- [`import-tasks`](import-tasks.md) - Import tasks from .cleo-export.json package
- [`list`](list.md) - View tasks (useful for finding IDs to export)
- [`show`](show.md) - Inspect task details before export
- [`tree`](tree.md) - Visualize hierarchy before subtree export
- [`find`](find.md) - Search tasks by query before export

## Use Cases

### Share Feature Work Across Projects

```bash
# Export feature epic from prototype
cd ~/projects/prototype
cleo export-tasks T015 --subtree --output feature-x.cleo-export.json

# Import to production project
cd ~/projects/production
cleo import-tasks ~/projects/prototype/feature-x.cleo-export.json
```

### Archive Completed Phase

```bash
cleo export-tasks --filter phase=setup --filter status=done --output setup-archive.cleo-export.json
```

### Template Creation

Export clean task structure for reuse:
```bash
cleo export-tasks T100 --subtree --output onboarding-template.cleo-export.json
```

### Backup Critical Tasks

```bash
cleo export-tasks --filter priority=critical --output critical-backup.cleo-export.json
```

## See Also

- [Cross-Project Export/Import Guide](../export-import.md) - Full user guide
- [Export Package Specification](../../claudedocs/IMPORT-EXPORT-SPEC.md) - Technical spec
- [Export Package Schema](../../schemas/export-package.schema.json) - JSON Schema definition
