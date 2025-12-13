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
claude-todo focus clear                    # Clear focus
claude-todo focus note "Progress text"     # Set session progress note
claude-todo focus next "Next action"       # Set suggested next action
claude-todo session start                  # Begin work session
claude-todo session end                    # End session
claude-todo session status                 # Show session info
```

### Analysis & Planning
```bash
claude-todo dash                           # Project dashboard overview
claude-todo dash --compact                 # Single-line status summary
claude-todo next                           # Suggest next task (priority + deps)
claude-todo next --explain                 # Show suggestion reasoning
claude-todo phases                         # List phases with progress bars
claude-todo phases show <phase>            # Tasks in specific phase
claude-todo phases stats                   # Detailed phase statistics
claude-todo labels                         # List all labels with counts
claude-todo labels show <label>            # Tasks with specific label
claude-todo deps                           # Dependency overview
claude-todo deps <id>                      # Dependencies for task
claude-todo deps tree                      # Full dependency tree
claude-todo blockers                       # Show blocked tasks
claude-todo blockers analyze               # Critical path analysis
```

### Maintenance
```bash
claude-todo validate                       # Check file integrity
claude-todo validate --fix                 # Fix checksum issues
claude-todo archive                        # Archive completed tasks
claude-todo stats                          # Show statistics
claude-todo backup                         # Create backup
claude-todo backup --list                  # List available backups
claude-todo restore [backup]               # Restore from backup
claude-todo migrate status                 # Check schema versions
claude-todo migrate run                    # Run schema migrations
claude-todo export --format todowrite      # Export to Claude Code format
claude-todo export --format csv            # Export to CSV
```

## Task Options

### Add/Update Options
| Option | Values | Purpose |
|--------|--------|---------|
| `--status` | pending, active, blocked, done | Task state (use focus for active) |
| `--priority` | critical, high, medium, low | Urgency level |
| `--labels` | comma-separated | Tags: `bug,security,sprint-12` |
| `--depends` | task IDs | Dependencies: `T001,T002` |
| `--description` | text | Detailed description |
| `--notes` | text | Add timestamped note to task |
| `--phase` | slug | Project phase: `setup`, `core`, `polish` |
| `--blocked-by` | reason | Why blocked (sets status=blocked) |

### List Filters
```bash
claude-todo list --status pending          # Filter by status
claude-todo list --priority high           # Filter by priority
claude-todo list --label bug               # Filter by label
claude-todo list --phase core              # Filter by phase
claude-todo list --format json             # Output format (text|json|jsonl|markdown|table)
```

## Session Protocol

### START
```bash
claude-todo session start
claude-todo dash                           # Overview of project state
claude-todo focus show                     # Check current focus
```

### WORK
```bash
claude-todo focus set <task-id>            # ONE task only
claude-todo next                           # Get task suggestion
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
```bash
claude-todo add "JWT middleware" --labels feature-auth,backend
claude-todo list --label feature-auth      # Filter tasks
claude-todo labels                         # See all labels with counts
claude-todo labels show feature-auth       # All tasks with label
```

### Phases (Workflow Stages)
```bash
claude-todo add "Implement API" --phase core
claude-todo list --phase core              # Filter by phase
claude-todo phases                         # See phase progress
claude-todo phases stats                   # Detailed breakdown
```

### Dependencies (Task Ordering)
```bash
claude-todo add "Write tests" --depends T001,T002
claude-todo deps T001                      # What depends on T001
claude-todo blockers                       # What's blocking progress
claude-todo blockers analyze               # Critical path analysis
```

## Error Recovery

| Problem | Solution |
|---------|----------|
| Checksum mismatch | `claude-todo validate --fix` |
| Task not found | `claude-todo list --all` (check archive) |
| Multiple active tasks | `claude-todo focus set <correct-id>` (resets others) |
| Corrupted JSON | `claude-todo restore` or `backup --list` then restore |
| Session already active | `claude-todo session status` then `session end` |
| Schema outdated | `claude-todo migrate run` |

## Command Aliases

```bash
claude-todo ls              # list
claude-todo done T001       # complete T001
claude-todo new "Task"      # add "Task"
claude-todo edit T001       # update T001
claude-todo rm              # archive
claude-todo check           # validate
claude-todo tags            # labels
claude-todo overview        # dash
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
claude-todo help <command>  # Detailed command help
```

## vs TodoWrite

| System | Purpose | Persistence |
|--------|---------|-------------|
| **claude-todo** | Durable task tracking | Survives sessions, full metadata |
| **TodoWrite** | Ephemeral session tasks | Session-only, simplified format |

Use `claude-todo export --format todowrite` to sync persistent tasks to TodoWrite.

---
*Full documentation: `claude-todo help <command>` or `~/.claude-todo/docs/`*
