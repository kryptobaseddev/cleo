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

# Phase 3 Commands (v0.8.2)
claude-todo dash                    # Comprehensive dashboard overview
claude-todo dash --compact          # Single-line summary
claude-todo labels                  # List all labels with counts
claude-todo labels show <label>     # Show tasks with specific label
claude-todo next                    # Get next task suggestion
claude-todo next --explain          # Show reasoning for suggestion

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
- Main Index for docs: docs/INDEX.md
- Quick Reference for Claude-TODO: docs/QUICK-REFERENCE.md
### 
- Architecture: docs/architecture/ARCHITECTURE.md
- Data Flows: docs/architecture/DATA-FLOWS.md
- Installation: docs/reference/installation.md
- Usage: docs/usage.md


<!-- CLAUDE-TODO:START v0.12.2 -->
## Task Management (claude-todo)

Use `ct` (alias for `claude-todo`) for all task operations. Full docs: `~/.claude-todo/docs/TODO_Task_Management.md`

### Essential Commands
```bash
ct list                    # View tasks
ct add "Task"              # Create task
ct done <id>               # Complete task
ct focus set <id>          # Set active task
ct focus show              # Show current focus
ct session start|end       # Session lifecycle
ct exists <id>             # Verify task exists
ct dash                    # Project overview
```

### Anti-Hallucination
- **CLI only** - Never edit `.claude/*.json` directly
- **Verify state** - Use `ct list` before assuming
- **Session discipline** - Start/end sessions properly
<!-- CLAUDE-TODO:END -->
