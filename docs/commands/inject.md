# cleo inject

Inject/prepare tasks for TodoWrite format.

## Synopsis

```bash
cleo inject [OPTIONS]
cleo sync --inject
```

## Description

The `inject` command prepares CLEO tasks for use with Claude Code's TodoWrite tool. This is typically used at the start of a session to make tasks available in TodoWrite format.

> **Note**: This command is usually invoked via `cleo sync --inject`. See [sync.md](./sync.md) for the full sync workflow.

## Options

| Option | Description |
|--------|-------------|
| `--focused-only` | Only inject the currently focused task |
| `--dry-run` | Show what would be injected without writing |
| `--format <format>` | Output format: text (default) or json |
| `--quiet` | Suppress non-essential output |

## Examples

```bash
# Inject all pending tasks
cleo inject

# Inject only focused task
cleo inject --focused-only

# Preview injection
cleo inject --dry-run

# Via sync command (recommended)
cleo sync --inject
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 3 | File access error |

## See Also

- [sync.md](./sync.md) - Full sync workflow
- [extract.md](./extract.md) - Extract from TodoWrite
