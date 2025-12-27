# deps Command

**Alias**: `dependencies`

Visualize task dependency relationships with tree views, upstream dependencies, and downstream dependents.

## Usage

```bash
cleo deps [TASK_ID|tree] [OPTIONS]
```

## Description

The `deps` command provides comprehensive visualization of task dependencies. It shows which tasks depend on others (upstream dependencies) and which tasks are waiting on a given task (downstream dependents).

This command is ideal for:
- Understanding task relationships before starting work
- Identifying dependency chains and their depth
- Visualizing the full dependency tree
- Planning work order based on dependencies

## Arguments

| Argument | Description |
|----------|-------------|
| `TASK_ID` | Show dependencies for a specific task (e.g., T001) |
| `tree` | Show full dependency tree visualization |
| (none) | Show overview of all tasks with dependencies |

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--format FORMAT` | `-f` | Output format: `text`, `json`, or `markdown` | `text` |
| `--help` | `-h` | Show help message | |

## Examples

### Overview of All Dependencies

```bash
# Show all tasks with dependencies
cleo deps
```

Output:
```
DEPENDENCY OVERVIEW
===================

Tasks with dependencies:
  T003 - Set up authentication
    Depends on: T001, T002

  T005 - Implement login page
    Depends on: T003

  T008 - Deploy to production
    Depends on: T005, T007

Independent tasks: 4
Tasks with dependencies: 3
Total dependency relationships: 6
```

> **Note**: Arguments can appear in any order. Both `deps T001 tree` and `deps tree T001` are valid.

### Dependencies for Specific Task

```bash
# Show deps for T005
cleo deps T005
```

Output:
```
DEPENDENCIES FOR T005: Implement login page
==========================================

Upstream Dependencies (what T005 needs):
  T003 - Set up authentication [pending]
    T001 - Create database schema [done]
    T002 - Configure server [done]

Downstream Dependents (what needs T005):
  T008 - Deploy to production [blocked]

Dependency depth: 2 levels
```

### Tree Visualization

```bash
# Show full dependency tree
cleo deps tree
```

Output:
```
DEPENDENCY TREE
===============

T001 - Create database schema [done]
  T003 - Set up authentication [pending]
    T005 - Implement login page [blocked]
      T008 - Deploy to production [blocked]

T002 - Configure server [done]
  T003 - Set up authentication [pending]
    ...

T007 - Add tests [pending]
  T008 - Deploy to production [blocked]

Independent:
  T004 - Write documentation [pending]
  T006 - Update README [pending]
```

### Output Formats

```bash
# JSON output for scripting
cleo deps --format json

# Markdown for documentation
cleo deps --format markdown

# JSON for specific task
cleo deps T005 --format json
```

JSON output example:
```json
{
  "_meta": {
    "version": "0.9.0",
    "timestamp": "2025-12-12T10:30:00Z",
    "command": "deps"
  },
  "overview": {
    "total_tasks": 8,
    "tasks_with_deps": 3,
    "independent_tasks": 5,
    "total_relationships": 6
  },
  "dependencies": [
    {
      "task_id": "T005",
      "title": "Implement login page",
      "depends_on": ["T003"],
      "depended_by": ["T008"],
      "depth": 2
    }
  ]
}
```

### Tree with Specific Root

```bash
# Show tree starting from T001
cleo deps T001 tree
```

## Understanding Dependency Direction

### Upstream Dependencies
Tasks that must be completed **before** a given task can start.

```
T003 depends on T001
     ^                ^
     |                |
   child           parent (upstream)
```

### Downstream Dependents
Tasks that are **waiting for** a given task to complete.

```
T001 is needed by T003
     ^                 ^
     |                 |
  parent          child (downstream)
```

## Integration with Other Commands

### With blockers command

```bash
# See which tasks are blocked
cleo deps tree

# Then analyze blocking chains
cleo blockers analyze
```

### With update command

```bash
# Add a dependency
cleo update T005 --depends T003

# Verify the dependency
cleo deps T005
```

### With validate command

```bash
# Check for circular dependencies
cleo validate
```

## Best Practices

1. **Review before starting**: Run `deps tree` to understand the full picture
2. **Work bottom-up**: Complete leaf nodes (tasks with no dependencies) first
3. **Check dependents**: Before completing a task, see what it unblocks with `deps T001`
4. **Avoid deep chains**: Try to keep dependency chains under 4 levels

## Troubleshooting

### Empty dependency output

If `deps` shows no dependencies:
- Check tasks have `depends` field set
- Verify task IDs are valid
- Run `cleo list` to confirm tasks exist

### Circular Dependency Detection

The `deps` command does not detect circular dependencies directly.
Use `cleo validate` to identify and resolve circular dependencies:

```bash
# Check for circular dependencies
cleo validate

# If cycles found, review and fix the depends fields
cleo update T001 --depends ""  # Remove problematic dependency
```

### Missing task in tree

If a task doesn't appear in the tree:
- Task might be independent (no dependencies or dependents)
- Check if task exists: `cleo list | grep T001`
- Verify task hasn't been archived

## See Also

- [blockers](blockers.md) - Analyze blocked tasks
- [next](next.md) - Get intelligent next task suggestions
- [dash](dash.md) - Full project dashboard
