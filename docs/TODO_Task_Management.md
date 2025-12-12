# Task Management Instructions

Use `claude-todo` CLI for **all** task operations. Single source of truth for persistent task tracking.

## Anti-Hallucination Rules

| Rule | Reason |
|------|--------|
| **CLI only** - Never read/edit `.claude/*.json` directly | Atomic writes, validation, checksums |
| **One active task** - Use `focus set` (enforces single active) | Prevents context confusion |
| **Verify state** - Use `list` before assuming task state | No stale data |
| **Session discipline** - Start/end sessions properly | Audit trail, recovery |
| **Validate after errors** - Run `validate` if something fails | Integrity check |

## Command Reference

### Core Operations
```bash
claude-todo add "Task title" [OPTIONS]     # Create task
claude-todo update <id> [OPTIONS]          # Update task fields
claude-todo complete <id>                  # Mark done
claude-todo list [--status STATUS]         # View tasks
```

### Focus & Session
```bash
claude-todo focus set <id>                 # Set active task (marks active)
claude-todo focus show                     # Show current focus
claude-todo focus note "Progress text"     # Set session progress note
claude-todo session start                  # Begin work session
claude-todo session end                    # End session
```

### Maintenance
```bash
claude-todo validate                       # Check file integrity
claude-todo archive                        # Archive completed tasks
claude-todo stats                          # Show statistics
claude-todo export --format todowrite      # Export to Claude Code format
```

## Task Options

### Add/Update Options
| Option | Values | Purpose |
|--------|--------|---------|
| `--status` | pending, active, blocked | Task state (use focus for active) |
| `--priority` | critical, high, medium, low | Urgency level |
| `--labels` | comma-separated | Tags: `bug,security,sprint-12` |
| `--depends` | task IDs | Dependencies: `T001,T002` |
| `--description` | text | Detailed description |
| `--notes` | text | Add timestamped note to task |
| `--phase` | slug | Project phase: `core`, `testing` |
| `--blocked-by` | reason | Why blocked (sets status=blocked) |

### List Filters
```bash
claude-todo list --status pending          # Filter by status
claude-todo list --priority high           # Filter by priority
claude-todo list --label bug               # Filter by label
claude-todo list --format json             # Output format (text|json|markdown)
```

## Session Protocol

### START
```bash
claude-todo session start
claude-todo list
claude-todo focus show
```

### WORK
```bash
claude-todo focus set <task-id>            # ONE task only
claude-todo add "Subtask" --depends T045   # Add related tasks
claude-todo update T045 --notes "Progress" # Add task notes
claude-todo focus note "Working on X"      # Update session note
```

### END
```bash
claude-todo complete <task-id>
claude-todo archive                        # Optional: clean up old done tasks
claude-todo session end
```

## Task Organization

### Labels (Categorization)
Use labels for grouping and filtering:
```bash
# Feature tracking
claude-todo add "JWT middleware" --labels feature-auth,backend

# Find all auth tasks
claude-todo list --label feature-auth
```

### Phases (Workflow Stages)
Predefined project phases (setup → core → polish):
```bash
claude-todo add "Implement API" --phase core
claude-todo list --phase core
```

### Dependencies (Task Ordering)
Block tasks until prerequisites complete:
```bash
claude-todo add "Write tests" --depends T001,T002
# Task stays pending until T001, T002 are done
```

### Planning Pattern
```bash
# Phase 1 tasks
claude-todo add "Design API" --phase setup --priority high
claude-todo add "Create schema" --phase setup --depends T050

# Phase 2 tasks (blocked until phase 1)
claude-todo add "Implement endpoints" --phase core --depends T050,T051
```

## Error Recovery

| Problem | Solution |
|---------|----------|
| Checksum mismatch | `claude-todo validate --fix` |
| Task not found | `claude-todo list --all` (check archive) |
| Multiple active tasks | `claude-todo focus set <correct-id>` (resets others) |
| Corrupted JSON | Restore: `cp .claude/.backups/todo.json.*.bak .claude/todo.json` |
| Session already active | `claude-todo session status` then `session end` |

## Notes: focus.note vs update --notes

| Command | Purpose | Storage |
|---------|---------|---------|
| `focus note "text"` | Session-level progress | `.focus.sessionNote` (replaces) |
| `update T001 --notes "text"` | Task-specific notes | `.tasks[].notes[]` (appends with timestamp) |

## Command Aliases (v0.6.0+)

Built-in CLI aliases for faster workflows:
```bash
claude-todo ls              # list
claude-todo done T001       # complete T001
claude-todo new "Task"      # add "Task"
claude-todo edit T001       # update T001
claude-todo rm              # archive
claude-todo check           # validate
```

## Shell Aliases
```bash
ct              # claude-todo
ct-add          # claude-todo add
ct-list         # claude-todo list
ct-done         # claude-todo complete
ct-focus        # claude-todo focus
```

## Debug & Validation
```bash
claude-todo --validate      # Check CLI integrity
claude-todo --list-commands # Show all commands
```

## vs TodoWrite

| System | Purpose | Persistence |
|--------|---------|-------------|
| **claude-todo** | Durable task tracking | Survives sessions, full metadata |
| **TodoWrite** | Ephemeral session tasks | Session-only, simplified format |

Use `claude-todo export --format todowrite` to generate TodoWrite snapshot from persistent tasks.

---
*Full documentation: `claude-todo help <command>` or see `~/.claude-todo/docs/`*
