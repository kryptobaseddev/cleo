# cleo populate-hierarchy

Auto-populate parent relationships from naming conventions.

## Synopsis

```bash
cleo populate-hierarchy [OPTIONS]
```

## Description

The `populate-hierarchy` command infers and sets `parentId` relationships based on task naming conventions and dependency patterns. Useful for organizing flat task lists into hierarchies.

## Inference Rules

1. **Naming convention**: `T001.1` → parent is `T001`
2. **Dependency pattern**: Task depending only on an epic → child of that epic
3. **Title patterns**: "Subtask of X" or "[T001]" prefixes

## Options

| Option | Description |
|--------|-------------|
| `--dry-run` | Show inferred relationships without applying |
| `--format <format>` | Output format: text (default) or json |
| `--json` | Shortcut for `--format json` |
| `--human` | Shortcut for `--format text` |
| `--quiet` | Suppress non-essential output |

## Examples

```bash
# Preview hierarchy changes
cleo populate-hierarchy --dry-run

# Apply inferred hierarchy
cleo populate-hierarchy

# JSON output
cleo populate-hierarchy --json
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Invalid arguments |
| 3 | File access error |
| 6 | Validation error |

## See Also

- [hierarchy.md](./hierarchy.md) - Full hierarchy documentation
- [reparent.md](./reparent.md) - Manual parent changes
- [promote.md](./promote.md) - Remove parent relationship
