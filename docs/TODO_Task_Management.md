# Task Management Instructions

Use `claude-todo` CLI for **all** task operations. Single source of truth for persistent task tracking.

## Data Integrity Rules

| Rule | Reason |
|------|--------|
| **CLI only** - Never read/edit `.claude/*.json` directly | Prevents staleness in multi-writer environment; ensures validation, checksums |
| **One active task** - Use `focus set` (enforces single active) | Prevents context confusion |
| **Verify state** - Use `list` before assuming task state | No stale data |
| **Session discipline** - Start/end sessions properly | Audit trail, recovery |
| **Validate after errors** - Run `validate` if something fails | Integrity check |

**Note**: Direct file reads can lead to stale data when multiple writers (TodoWrite, claude-todo) modify the same files. CLI commands always read fresh data from disk.

## Command Reference

### Core Operations
```bash
claude-todo add "Task title" [OPTIONS]     # Create task
claude-todo update <id> [OPTIONS]          # Update task fields
claude-todo complete <id>                  # Mark done
claude-todo list [--status STATUS]         # View tasks
claude-todo show <id>                      # View single task details
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

### TodoWrite Sync
```bash
claude-todo sync --inject                  # Prepare tasks for TodoWrite (session start)
claude-todo sync --inject --focused-only   # Inject only focused task
claude-todo sync --extract <file>          # Merge TodoWrite state back (session end)
claude-todo sync --extract --dry-run <file> # Preview changes without applying
claude-todo sync --status                  # Show sync session state
```

### Analysis & Planning
```bash
claude-todo analyze                        # Task triage with leverage scoring
claude-todo analyze --json                 # Machine-readable triage output
claude-todo analyze --auto-focus           # Analyze and auto-set focus to top task
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

### Research & Discovery (v0.23.0+)
```bash
claude-todo research "query"               # Multi-source web research
claude-todo research --library NAME -t X   # Library docs via Context7
claude-todo research --reddit "topic" -s S # Reddit discussions via Tavily
claude-todo research --url URL [URL...]    # Extract from specific URLs
claude-todo research -d deep               # Deep research (15-25 sources)
claude-todo research --link-task T001      # Link research to task
```

**Aliases**: `dig` → `research`

**Output**: Creates `.claude/research/research_[id].json` + `.md` files with citations.

### Task Inspection
```bash
claude-todo show <id>                      # Full task details view
claude-todo show <id> --history            # Include task history from log
claude-todo show <id> --related            # Show related tasks (same labels)
claude-todo show <id> --include-archive    # Search archive if not found
claude-todo show <id> --format json        # JSON output for scripting
```

### Task Search (v0.19.2+)
```bash
claude-todo find <query>                   # Fuzzy search tasks by title/description
claude-todo find --id 37                   # Find tasks with ID prefix T37*
claude-todo find "exact title" --exact     # Exact match mode
claude-todo find "test" --status pending   # Filter by status
claude-todo find "api" --field title       # Search specific fields
claude-todo find "task" --format json      # JSON output for scripting
claude-todo find "old" --include-archive   # Include archived tasks
```

**Aliases**: `search` → `find`

### Hierarchy (v0.17.0+)
```bash
# Create with hierarchy
claude-todo add "Epic" --type epic --size large
claude-todo add "Task" --parent T001 --size medium
claude-todo add "Subtask" --parent T002 --type subtask --size small

# List with hierarchy filters
claude-todo list --type epic               # Filter by type (epic|task|subtask)
claude-todo list --parent T001             # Tasks with specific parent
claude-todo list --children T001           # Direct children of task
claude-todo list --tree                    # Hierarchical tree view
```

**Constraints**: max depth 3 (epic→task→subtask), max 7 siblings per parent.

### Maintenance
```bash
claude-todo validate                       # Check file integrity
claude-todo validate --fix                 # Fix checksum issues
claude-todo exists <id>                    # Check if task ID exists (exit code 0/1)
claude-todo exists <id> --quiet            # Silent check for scripting
claude-todo exists <id> --include-archive  # Search archive too
claude-todo archive                        # Archive completed tasks
claude-todo stats                          # Show statistics
claude-todo backup                         # Create backup
claude-todo backup --list                  # List available backups
claude-todo restore [backup]               # Restore from backup
claude-todo migrate status                 # Check schema versions
claude-todo migrate run                    # Run schema migrations
claude-todo migrate-backups --detect       # List legacy backups
claude-todo migrate-backups --run          # Migrate to new taxonomy
claude-todo export --format todowrite      # Export to Claude Code format
claude-todo export --format csv            # Export to CSV
claude-todo init --update-claude-md        # Update CLAUDE.md injection (idempotent)
claude-todo config show                    # View current configuration
claude-todo config set <key> <value>       # Update configuration
claude-todo config get <key>               # Get specific config value
claude-todo log                            # View recent audit log entries
claude-todo log --limit 20                 # Limit entries shown
claude-todo log --operation create         # Filter by operation type
claude-todo log --task T001                # Filter by task ID
```

### History & Analytics
```bash
claude-todo history                        # Recent completion timeline (30 days)
claude-todo history --days 7               # Last week's completions
claude-todo history --since 2025-12-01     # Since specific date
claude-todo history --format json          # JSON output for scripting
```

## CLAUDE.md Integration

### Update CLAUDE.md Instructions
When claude-todo is upgraded, update your project's CLAUDE.md injection:

```bash
# Update existing CLAUDE.md injection to latest template
claude-todo init --update-claude-md
```

This command:
- Replaces content between `<!-- CLAUDE-TODO:START -->` and `<!-- CLAUDE-TODO:END -->`
- Adds injection if not present
- Safe to run anytime (idempotent)
- Does NOT re-initialize the project or touch `.claude/` files

### When to Update
Run `init --update-claude-md` after:
- Upgrading claude-todo to a new version
- Template improvements are released
- You notice outdated instructions in CLAUDE.md

### Check Current Version
```bash
# Compare injection to installed template
diff <(sed -n '/CLAUDE-TODO:START/,/CLAUDE-TODO:END/p' CLAUDE.md) \
     ~/.claude-todo/templates/CLAUDE-INJECTION.md
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

### LLM-Agent-First Output

**JSON is automatic** when piped (non-TTY). No `--format` flag needed:
```bash
claude-todo list | jq '.tasks[0]'      # Auto-JSON when piped
claude-todo analyze                     # JSON by default (use --human for text)
```

**Prefer native filters over jq** (fewer tokens, no shell quoting issues):
```bash
# ✅ NATIVE (recommended)
claude-todo list --status pending       # Built-in filter
claude-todo find "auth"                 # Fuzzy search (99% less context)
claude-todo list --label bug --phase core  # Combined filters

# ⚠️ JQ (only when native filters insufficient)
# Use SINGLE quotes to avoid shell interpretation
claude-todo list | jq '.tasks[] | select(.type != "epic")'
#                    ^ single quotes prevent bash ! expansion
```

**JSON envelope structure**: `{ "_meta": {...}, "summary": {...}, "tasks": [...] }`

## Session Protocol

### START
```bash
claude-todo session start
claude-todo list                           # See current task state
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
Use labels for grouping and filtering:
```bash
# Feature tracking
claude-todo add "JWT middleware" --labels feature-auth,backend

# Find all auth tasks
claude-todo list --label feature-auth
claude-todo labels                         # See all labels with counts
claude-todo labels show feature-auth       # All tasks with label
```

### Phases (Workflow Stages)
Predefined project phases (setup → core → polish):
```bash
claude-todo add "Implement API" --phase core
claude-todo list --phase core              # Filter by phase
claude-todo phases                         # See phase progress
claude-todo phases stats                   # Detailed breakdown
```

### Dependencies (Task Ordering)
Block tasks until prerequisites complete:
```bash
claude-todo add "Write tests" --depends T001,T002
# Task stays pending until T001, T002 are done
claude-todo deps T001                      # What depends on T001
claude-todo blockers                       # What's blocking progress
claude-todo blockers analyze               # Critical path analysis
```

### Planning Pattern
```bash
# Phase 1 tasks
claude-todo add "Design API" --phase setup --priority high
claude-todo add "Create schema" --phase setup --depends T050

# Phase 2 tasks (blocked until phase 1)
claude-todo add "Implement endpoints" --phase core --depends T050,T051
```

## Notes: focus.note vs update --notes

| Command | Purpose | Storage |
|---------|---------|---------|
| `focus note "text"` | Session-level progress | `.focus.sessionNote` (replaces) |
| `update T001 --notes "text"` | Task-specific notes | `.tasks[].notes[]` (appends with timestamp) |

## Task Validation & Scripting

### Check Task Existence
Use `exists` command for validation in scripts and automation:

```bash
# Basic check (exit code 0 = exists, 1 = not found)
claude-todo exists T001

# Silent check for scripting (no output)
if claude-todo exists T001 --quiet; then
  echo "Task exists"
fi

# Check archive too
claude-todo exists T001 --include-archive

# Get detailed info with verbose mode
claude-todo exists T001 --verbose
```

### Script Examples
```bash
# Validate before update
if claude-todo exists T042 --quiet; then
  claude-todo update T042 --priority high
else
  echo "ERROR: Task T042 not found"
  exit 1
fi

# Validate dependencies exist
DEPS=("T001" "T002" "T005")
for dep in "${DEPS[@]}"; do
  if ! claude-todo exists "$dep" --quiet; then
    echo "ERROR: Dependency $dep not found"
    exit 1
  fi
done

# JSON output for complex logic
EXISTS=$(claude-todo exists T001 --format json | jq -r '.exists')
if [[ "$EXISTS" == "true" ]]; then
  # Process task
fi
```

### Exit Codes
| Code | Meaning | Use Case |
|------|---------|----------|
| `0` | Task exists | Success condition |
| `1` | Task not found | Expected failure |
| `2` | Invalid task ID format | Input validation error |
| `3` | File read error | System error |

## Error Recovery

| Problem | Solution |
|---------|----------|
| Checksum mismatch | `claude-todo validate --fix` |
| Task not found | `claude-todo list --all` (check archive) |
| Multiple active tasks | `claude-todo focus set <correct-id>` (resets others) |
| Corrupted JSON | `claude-todo restore` or `backup --list` then restore |
| Session already active | `claude-todo session status` then `session end` |
| Schema outdated | `claude-todo migrate run` |

## Command Aliases (v0.6.0+)

Built-in CLI aliases for faster workflows:
```bash
claude-todo ls              # list
claude-todo done T001       # complete T001
claude-todo new "Task"      # add "Task"
claude-todo edit T001       # update T001
claude-todo rm              # archive
claude-todo check           # validate
claude-todo tags            # labels
claude-todo overview        # dash
claude-todo dig "query"     # research
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

### Command Discovery (v0.21.0+)
```bash
claude-todo commands                   # List all commands (JSON by default)
claude-todo commands --human           # Human-readable list
claude-todo commands -r critical       # Filter by agent relevance
claude-todo commands -c write          # Filter by category
claude-todo commands add               # Details for specific command
claude-todo commands --workflows       # Agent workflow sequences
claude-todo commands --lookup          # Intent-to-command mapping
```

**No jq required** - use native `--category` and `--relevance` filters instead.

## vs TodoWrite

| System | Purpose | Persistence |
|--------|---------|-------------|
| **claude-todo** | Durable task tracking | Survives sessions, full metadata |
| **TodoWrite** | Ephemeral session tasks | Session-only, simplified format |

**Workflows:**
- One-way export: `claude-todo export --format todowrite`
- Bidirectional sync: `claude-todo sync --inject` (start) and `sync --extract` (end)

---
*Full documentation: `claude-todo help <command>` or `~/.claude-todo/docs/`*
