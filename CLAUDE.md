# CLAUDE-TODO System

Task management system for Claude Code with anti-hallucination validation, auto-archiving, and audit trails.

## Stack
- Bash scripts (primary implementation)
- JSON Schema (validation)
- jq (JSON manipulation)

## Commands
```bash
./install.sh                        # Global installation to ~/.claude-todo/
claude-todo init                    # Initialize project (.claude/ directory)
claude-todo add "Task"              # Create task
claude-todo update <id> [OPTIONS]   # Update existing task
claude-todo complete <id>           # Mark complete
claude-todo list                    # Display tasks
claude-todo focus set <id>          # Set focus to task (marks active)
claude-todo focus show              # Show current focus
claude-todo session start           # Start work session
claude-todo session end             # End work session
claude-todo export --format todowrite  # Export to TodoWrite format
claude-todo archive                 # Archive completed tasks
claude-todo validate                # Validate all JSON files
claude-todo stats                   # Show statistics
claude-todo help                    # Show all commands
```

## Structure
```
schemas/          # JSON Schema definitions
templates/        # Starter templates for new projects
scripts/          # User-facing operational scripts
lib/              # Shared functions (validation, logging, file-ops)
tests/            # Test suite with fixtures
docs/             # Documentation
```

## Key Files
- Schema definitions: `schemas/todo.schema.json`
- Library core: `lib/validation.sh`, `lib/file-ops.sh`, `lib/logging.sh`
- Main scripts: `scripts/add-task.sh`, `scripts/update-task.sh`, `scripts/complete-task.sh`

## Rules
- **CRITICAL**: All write operations MUST use atomic pattern (temp file → validate → backup → rename)
- **CRITICAL**: Every task requires both `title` AND `description` fields (anti-hallucination)
- **IMPORTANT**: Run `validate.sh` after any manual JSON edits
- Status enum is strict: `pending | active | blocked | done` only
- Task IDs must be unique across todo.json AND todo-archive.json
- All operations log to todo-log.json (append-only)

## Anti-Hallucination Checks
Before any task operation, validate:
1. ID uniqueness (no duplicates)
2. Status is valid enum value
3. Timestamps not in future
4. title/description both present and different
5. No duplicate task descriptions

## Time Estimates — PROHIBITED
**DO NOT** estimate hours, days, or duration for any task. Ever.
You cannot accurately predict time. Estimates create false precision and bad decisions.
**Instead**: Describe scope, complexity, and dependencies. Use relative sizing if pressed (small/medium/large). If a user insists on time estimates, state clearly that you cannot provide accurate predictions and redirect to scope-based planning.

## Docs
- Architecture: @docs/ARCHITECTURE.md
- Design Summary: @docs/SYSTEM-DESIGN-SUMMARY.md
- Installation: @docs/installation.md
- Usage: @docs/usage.md

<!-- CLAUDE-TODO:START -->
## Task Management (claude-todo CLI)

Use the `claude-todo` CLI for **all** task operations. Never read or edit `.claude/*.json` files directly.

### Quick Reference
```bash
claude-todo list                    # View tasks
claude-todo add "Task title"        # Create task
claude-todo update <task-id> [opts] # Update task fields
claude-todo complete <task-id>      # Mark done
claude-todo focus set <task-id>     # Set focus (marks active)
claude-todo focus show              # Show current focus
claude-todo session start           # Start session
claude-todo session end             # End session
claude-todo export --format todowrite  # Export for Claude Code
claude-todo validate                # Check file integrity
claude-todo archive                 # Archive completed tasks
claude-todo stats                   # Show statistics
claude-todo log --action <type>     # Add log entry
claude-todo help                    # All commands
```

### Session Protocol

**START**:
```bash
claude-todo session start           # Logs session, shows context
claude-todo list                    # See pending tasks
claude-todo focus show              # Check last focus/notes
```

**WORK**:
```bash
claude-todo focus set <task-id>     # Set focus (one task only)
claude-todo add "Subtask"           # Add new tasks as needed
claude-todo update <task-id> --notes "Progress"  # Add notes to task
claude-todo focus note "Progress"   # Update session note
```

**END**:
```bash
claude-todo complete <task-id>      # Complete finished tasks
claude-todo archive                 # Clean up completed tasks
claude-todo session end             # End session
```

### Anti-Hallucination Rules

- **CLI only** - Never read/edit `.claude/*.json` files directly
- **One active task** - Use `claude-todo focus set` (enforces single active)
- **Verify state** - Use `claude-todo list` to confirm, don't assume
- **Session discipline** - Start/end sessions properly

### Aliases (installed automatically)
```bash
ct          # claude-todo
ct-add      # claude-todo add
ct-list     # claude-todo list
ct-done     # claude-todo complete
ct-focus    # claude-todo focus
```
<!-- CLAUDE-TODO:END -->
