# cleo setup-agents

Setup global agent configuration files.

## Synopsis

```bash
cleo setup-agents [OPTIONS]
```

## Description

The `setup-agents` command creates or updates global agent configuration files (`~/.claude/CLAUDE.md`, `~/.claude/AGENTS.md`, etc.) with CLEO task management instructions using `@` reference syntax.

This command is typically run once after installation or when updating global agent configuration. Project-level injection is handled automatically by `cleo init` and `cleo upgrade`.

## Options

| Option | Description |
|--------|-------------|
| `--dry-run` | Show what would be done without making changes |
| `--force` | Overwrite existing content outside CLEO markers |
| `--update` | Update existing CLEO injection blocks |
| `--format <format>` | Output format: text (default) or json |
| `--json` | Shortcut for `--format json` |
| `--human` | Shortcut for `--format text` |
| `--quiet` | Suppress non-essential output |
| `--help` | Show help message |

## Agent Config Files

The command manages these files:

| File | Purpose |
|------|---------|
| `~/.claude/CLAUDE.md` | Global Claude Code instructions |
| `~/.claude/AGENTS.md` | Multi-agent system instructions |
| `~/.claude/GEMINI.md` | Gemini AI agent instructions |
| `~/.claude/PRINCIPLES.md` | Engineering principles reference |

## Injection Format

Content is injected between markers:

```markdown
<!-- CLEO:START -->
@~/.cleo/docs/TODO_Task_Management.md
<!-- CLEO:END -->
```

The `@` reference syntax allows the agent to load the full task management instructions dynamically.

## Examples

```bash
# Initial setup
cleo setup-agents

# Preview changes without applying
cleo setup-agents --dry-run

# Force update (overwrite existing)
cleo setup-agents --force

# Update existing injections only
cleo setup-agents --update

# JSON output for scripting
cleo setup-agents --json
```

## When to Run

- **After fresh install**: Run once to set up global configs
- **After CLEO update**: Run with `--update` to refresh injections
- **Troubleshooting**: Run with `--force` if agents aren't seeing instructions

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | File write error |
| 2 | Invalid arguments |

## Verification

After running, verify with:

```bash
cleo doctor --global
```

## See Also

- `cleo init` - Initialize project (handles project-level injection)
- `cleo upgrade` - Update project (refreshes injections)
- `cleo doctor` - Verify agent configurations
