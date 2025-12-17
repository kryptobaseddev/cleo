# init Command

Initialize a new claude-todo project or update existing configuration.

## Usage

```bash
claude-todo init [OPTIONS]
```

## Description

The `init` command sets up a new project for claude-todo by creating the `.claude/` directory structure and required JSON files. It can also update an existing project's CLAUDE.md injection to the latest version.

This command is idempotent - running it multiple times on an initialized project will not overwrite existing data.

## Arguments

| Argument | Description | Required |
|----------|-------------|----------|
| `PROJECT_NAME` | Optional project name (for display) | No |

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--force` | Overwrite existing configuration files | `false` |
| `--no-claude-md` | Skip CLAUDE.md integration | `false` |
| `--update-claude-md` | Only update CLAUDE.md injection (no other changes) | `false` |
| `--help`, `-h` | Show help message | |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (directory creation failed, file write failed, validation failed) |

## Examples

### New Project Setup

```bash
# Initialize in current directory
cd my-project
claude-todo init

# Initialize with project name
claude-todo init "my-project"
```

Output:
```
[INFO] Initializing claude-todo in /path/to/project
[INFO] Created .claude/ directory
[INFO] Created .claude/todo.json
[INFO] Created .claude/todo-config.json
[INFO] Created .claude/todo-archive.json
[INFO] Created .claude/todo-log.json
[INFO] Updated CLAUDE.md with task management injection

claude-todo initialized successfully!

Next steps:
  1. Add your first task: claude-todo add "Your first task"
  2. Set focus: claude-todo focus set T001
  3. Start a session: claude-todo session start
```

### Update CLAUDE.md Injection

```bash
# Update CLAUDE.md injection to latest version
claude-todo init --update-claude-md
```

Output:
```
[INFO] Updating CLAUDE.md injection (v0.12.5 -> v0.12.6)
[INFO] CLAUDE.md updated successfully

Note: Only the task management section was updated.
      Project files (.claude/) were not modified.
```

### Force Reinitialize

```bash
# Overwrite existing config (use with caution)
claude-todo init --force
```

## Files Created

| File | Description |
|------|-------------|
| `.claude/todo.json` | Active tasks with metadata |
| `.claude/todo-config.json` | Project configuration |
| `.claude/todo-archive.json` | Archived completed tasks |
| `.claude/todo-log.json` | Audit log of all operations |
| `CLAUDE.md` (updated) | Task management injection added |

## Directory Structure

```
project/
├── .claude/
│   ├── todo.json          # Active tasks
│   ├── todo-config.json   # Configuration
│   ├── todo-archive.json  # Archived tasks
│   └── todo-log.json      # Audit log
└── CLAUDE.md              # Updated with injection
```

## CLAUDE.md Injection

The init command adds a task management section to CLAUDE.md:

```markdown
<!-- CLAUDE-TODO:START v0.12.6 -->
## Task Management (claude-todo)

Use `ct` (alias for `claude-todo`) for all task operations.
...
<!-- CLAUDE-TODO:END -->
```

This section:
- Provides essential command reference for AI assistants
- Auto-updates when `--update-claude-md` is run
- Preserves content outside the markers

## Idempotency

| Scenario | Behavior |
|----------|----------|
| First init | Creates all files |
| Repeated init | Skips existing files (no overwrites) |
| `--update-claude-md` | Only touches CLAUDE.md |
| `--force` | Overwrites config files (not task data) |

## Configuration Defaults

Created `todo-config.json` includes:

```json
{
  "_meta": {
    "version": "2.0.0"
  },
  "phases": {
    "setup": { "name": "Setup", "order": 1 },
    "core": { "name": "Core", "order": 2 },
    "polish": { "name": "Polish", "order": 3 }
  },
  "archive": {
    "daysUntilArchive": 7,
    "maxCompletedTasks": 15,
    "preserveRecentCount": 3
  }
}
```

## See Also

- [validate](validate.md) - Check project integrity
- [migrate](migrate.md) - Schema version migration
- [session](session.md) - Start working
