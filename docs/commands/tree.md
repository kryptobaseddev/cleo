# cleo tree

Display task hierarchy as a tree.

## Synopsis

```bash
cleo tree [OPTIONS]
cleo list --tree [OPTIONS]
```

## Description

The `tree` command displays tasks in a hierarchical tree view, showing parent-child relationships visually. It is an alias for `cleo list --tree`.

## Options

All options from `cleo list` are supported:

| Option | Description |
|--------|-------------|
| `--parent <ID>` | Show tree starting from specific task |
| `--status <status>` | Filter by status |
| `--priority <priority>` | Filter by priority |
| `--phase <phase>` | Filter by phase |
| `--label <label>` | Filter by label |
| `--type <type>` | Filter by type (epic, task, subtask) |
| `--format <format>` | Output format: text (default) or json |
| `--quiet` | Suppress non-essential output |

## Examples

```bash
# Full task tree
cleo tree

# Tree from specific epic
cleo tree --parent T1975

# Tree filtered by status
cleo tree --status pending

# Equivalent using list
cleo list --tree --parent T1975
```

## Output Format

```
T1975 [epic] Development Tooling
├── T1976 [task] Add missing scripts
├── T1977 [task] Create documentation
│   └── T1978 [subtask] Write examples
└── T1979 [task] CI integration
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Invalid arguments |
| 100 | No tasks match filters |

## See Also

- [list.md](./list.md) - Full list command documentation
- [hierarchy.md](./hierarchy.md) - Hierarchy concepts
