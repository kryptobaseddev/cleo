---
title: "deps"
description: "Dependency management and graph analysis"
icon: "diagram-project"
---

# deps Command

**Alias**: `dependencies`

Visualize task dependencies, analyze dependency graphs, and identify critical paths. Features O(1) lookups through cached dependency graphs.

## Usage

```bash
cleo deps [SUBCOMMAND|TASK_ID] [OPTIONS]
```

## Description

The `deps` command provides comprehensive dependency visualization and analysis. It uses a cached dependency graph for O(1) lookups, delivering 90x performance improvement over naive iteration.

### Core Capabilities

| Feature | Description |
|---------|-------------|
| **Overview** | Summary of all dependency relationships |
| **Task Details** | Upstream/downstream dependencies for specific task |
| **Tree View** | ASCII visualization of dependency chains |
| **Graph Cache** | Automatic caching with checksum-based invalidation |

## Subcommands

### deps (no arguments)

Show overview of all tasks with dependencies.

```bash
cleo deps
```

**Output:**
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

### deps TASK_ID

Show dependencies for a specific task.

```bash
cleo deps T005
```

**Output:**
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

### deps tree

Show full dependency tree visualization.

```bash
cleo deps tree
```

**Output:**
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

### deps tree TASK_ID

Show tree starting from specific task.

```bash
cleo deps T001 tree
```

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--format FORMAT` | `-f` | Output format: `text`, `json`, `markdown` | `text` |
| `--rebuild-cache` | | Force cache rebuild before operation | `false` |
| `--quiet` | `-q` | Suppress non-essential output | `false` |
| `--help` | `-h` | Show help message | |

## Output Formats

### JSON Output

```bash
cleo deps --format json
```

```json
{
  "_meta": {
    "version": "0.67.0",
    "timestamp": "2026-01-23T10:30:00Z",
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

### Markdown Output

```bash
cleo deps --format markdown
```

Generates documentation-friendly markdown tables.

## Performance

The deps command uses a cached dependency graph for O(1) lookups.

### Cache System

| Metric | Without Cache | With Cache | Improvement |
|--------|---------------|------------|-------------|
| Lookup time | O(n^2) | O(1) | 90x faster |
| 789 tasks | ~18s | <200ms | 90x |
| Memory | Per-query | Pre-computed | Constant |

### Cache Behavior

- **Location**: `.cleo/.deps-cache/`
- **Files**: `forward.json`, `reverse.json`, `checksum`, `metadata.json`
- **Invalidation**: Automatic via checksum comparison with `todo.json._meta.checksum`
- **Rebuild**: Triggered on first access after `todo.json` modification

### Force Cache Rebuild

```bash
# Rebuild cache before querying
cleo deps --rebuild-cache

# Verify cache state
cleo deps --format json | jq '._meta.cacheStatus'
```

## Understanding Dependencies

### Upstream vs Downstream

```
         UPSTREAM                     DOWNSTREAM
    (what T005 needs)            (what needs T005)
    
    T001 ──┐
           ├──► T003 ──► T005 ──► T008
    T002 ──┘
    
    T005.depends = ["T003"]       T008.depends = ["T005"]
```

| Direction | Meaning | Query |
|-----------|---------|-------|
| **Upstream** | Tasks that must complete before this task | `deps T005` shows T003, T001, T002 |
| **Downstream** | Tasks waiting for this task | `deps T005` shows T008 |

### Dependency Depth

Depth measures the longest path to root tasks:

```
Depth 0: T001, T002 (no dependencies)
Depth 1: T003 (depends on T001, T002)
Depth 2: T005 (depends on T003)
Depth 3: T008 (depends on T005)
```

## Integration Examples

### With blockers command

```bash
# View dependency tree
cleo deps tree

# Analyze blocking chains
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

### With orchestrator

```bash
# Get parallelizable task groups
cleo orchestrator analyze T001
```

## Best Practices

1. **Review before starting**: Run `deps tree` to understand the full picture
2. **Work bottom-up**: Complete leaf nodes (tasks with no dependencies) first
3. **Check dependents**: Before completing a task, see what it unblocks with `deps T001`
4. **Avoid deep chains**: Keep dependency chains under 4 levels when possible
5. **Use cache**: The graph cache makes repeated queries fast; don't bypass it

## Troubleshooting

### Empty dependency output

If `deps` shows no dependencies:
- Check tasks have `depends` field set: `cleo show T001 | jq '.depends'`
- Verify task IDs are valid: `cleo exists T001`
- Run `cleo list` to confirm tasks exist

### Circular Dependency Detection

The `deps` command does not detect circular dependencies directly.
Use `cleo validate` to identify and resolve them:

```bash
# Check for circular dependencies
cleo validate

# If cycles found, remove problematic dependency
cleo update T001 --depends ""
```

### Cache Issues

If dependencies seem stale:

```bash
# Force cache rebuild
cleo deps --rebuild-cache

# Verify cache state
ls -la .cleo/.deps-cache/

# Check cache metadata
cat .cleo/.deps-cache/metadata.json
```

### Missing task in tree

If a task doesn't appear in the tree:
- Task might be independent (no dependencies or dependents)
- Check if task exists: `cleo exists T001`
- Verify task hasn't been archived: `cleo show T001 --include-archive`

## See Also

- [blockers](blockers.md) - Analyze blocked tasks
- [next](next.md) - Intelligent next task suggestions
- [dash](dash.md) - Project dashboard
- [validate](validate.md) - Circular dependency detection
- [DEPENDENCY-GRAPHS Guide](../guides/DEPENDENCY-GRAPHS.md) - Architecture details
