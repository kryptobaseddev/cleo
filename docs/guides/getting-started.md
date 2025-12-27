# CLEO Getting Started Guide

A comprehensive guide to setting up CLEO task management for AI coding agents.

## What is CLEO?

CLEO (Command Line Entity Orchestrator) is a task management system designed for AI coding agents and solo developers. It provides:

- **Anti-hallucination validation** - Every operation is validated before execution
- **Context persistence** - State maintained across sessions with immutable audit trails
- **Structured output** - JSON by default for agent consumption
- **Atomic operations** - All writes use temp file → validate → backup → rename pattern

## Prerequisites

Before installing, ensure you have:

1. **Bash 4.0+**
   ```bash
   bash --version
   ```

2. **jq (JSON processor)**
   ```bash
   jq --version
   # Install if missing: apt install jq / brew install jq
   ```

## Fresh Installation

### 1. Clone and Install

```bash
git clone https://github.com/kryptobaseddev/cleo.git
cd cleo
./install.sh
```

This installs to `~/.cleo/` and creates symlinks in `~/.local/bin/`.

### 2. Initialize Your Project

```bash
cd /path/to/your/project
cleo init
```

Creates `.cleo/` directory with:
- `todo.json` - Active tasks
- `todo-archive.json` - Completed tasks
- `config.json` - Configuration
- `todo-log.json` - Change history

### 3. Inject Agent Instructions

```bash
# For Claude Code (default)
cleo init --update-claude-md

# For other agents
cleo init --target AGENTS.md
cleo init --target GEMINI.md
```

This injects CLEO instructions into your agent's documentation file.

### 4. Verify Installation

```bash
cleo version
cleo validate
```

## Migration from claude-todo

If you have existing claude-todo installations:

### Check Migration Status

```bash
cleo claude-migrate --check
```

### Migrate Global Installation

```bash
cleo claude-migrate --global
# Moves ~/.claude-todo/ → ~/.cleo/
```

### Migrate Project Data

```bash
cleo claude-migrate --project
# Moves .claude/ → .cleo/ (preserves all data)
```

### Migrate Everything

```bash
cleo claude-migrate --all
# Runs both --global and --project
```

## Essential Commands

### Task Management

```bash
cleo add "Task title"              # Create task
cleo list                          # View tasks
cleo complete <id>                 # Mark done
cleo update <id> --notes "..."     # Add notes
```

### Focus Management

```bash
cleo focus set <id>                # Set active task (one at a time)
cleo focus show                    # Show current focus
cleo focus clear                   # Clear focus
```

### Session Protocol

```bash
# Start of work
cleo session start
cleo list --status pending
cleo focus set <task-id>

# During work
cleo add "Discovered task"
cleo update <id> --notes "Progress"
cleo complete <id>

# End of work
cleo archive
cleo session end
```

## Agent-Specific Setup

### Claude Code

CLEO is designed primarily for Claude Code. After installation:

```bash
cleo init --update-claude-md
```

This injects CLEO instructions between `<!-- CLEO:START -->` and `<!-- CLEO:END -->` markers.

### Other AI Agents

For agents using AGENTS.md or other documentation files:

```bash
cleo init --target AGENTS.md
```

The same CLEO template is injected into the specified file.

## Configuration

Edit `.cleo/config.json`:

```json
{
  "validation": {
    "maxActiveTasks": 1,          // Enforce single focus
    "requireDescription": false    // Optional descriptions
  },
  "defaults": {
    "priority": "medium",
    "phase": "core"
  },
  "archive": {
    "daysUntilArchive": 7
  }
}
```

## Aliases

CLEO provides shell aliases for faster workflows:

```bash
ct          # cleo
ct-add      # cleo add
ct-list     # cleo list
ct-done     # cleo complete
ct-focus    # cleo focus
```

## Next Steps

- **Full Command Reference**: `~/.cleo/docs/TODO_Task_Management.md`
- **Architecture**: See `docs/architecture/ARCHITECTURE.md`
- **Configuration**: See `docs/reference/configuration.md`
- **Quick Reference**: Run `cleo help`

## Support

- **Documentation**: `~/.cleo/docs/`
- **Command Help**: `cleo <command> --help`
- **Validation**: `cleo validate --fix`
