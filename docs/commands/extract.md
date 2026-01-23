# cleo extract

Extract/merge TodoWrite state back to CLEO.

## Synopsis

```bash
cleo extract <file> [OPTIONS]
cleo sync --extract <file>
```

## Description

The `extract` command merges TodoWrite format task state back into CLEO's todo.json. This is typically used at the end of a session to sync changes made via Claude Code's TodoWrite tool.

> **Note**: This command is usually invoked via `cleo sync --extract`. See [sync.md](./sync.md) for the full sync workflow.

## Arguments

| Argument | Description |
|----------|-------------|
| `<file>` | Path to TodoWrite JSON file to extract from |

## Options

| Option | Description |
|--------|-------------|
| `--dry-run` | Show what would change without applying |
| `--format <format>` | Output format: text (default) or json |
| `--quiet` | Suppress non-essential output |

## Examples

```bash
# Extract from TodoWrite file
cleo extract ~/.claude/todos/project.json

# Preview changes
cleo extract ~/.claude/todos/project.json --dry-run

# Via sync command (recommended)
cleo sync --extract ~/.claude/todos/project.json
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Invalid arguments |
| 3 | File not found |
| 6 | Validation error |

## See Also

- [sync.md](./sync.md) - Full sync workflow
- [inject.md](./inject.md) - Inject tasks to TodoWrite
