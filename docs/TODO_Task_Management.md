# Task Management Instructions

Use `cleo` CLI for **all** task operations. Single source of truth for persistent task tracking.

## Data Integrity Rules

| Rule | Reason |
|------|--------|
| **CLI only** - Never read/edit `.cleo/*.json` directly | Prevents staleness in multi-writer environment; ensures validation, checksums |
| **One active task** - Use `focus set` (enforces single active) | Prevents context confusion (per-scope in multi-session mode) |
| **Verify state** - Use `list` before assuming task state | No stale data |
| **Session discipline** - Start/end sessions properly | Audit trail, recovery |
| **Scope discipline** - Use scoped sessions for parallel agents | Prevents task conflicts (v0.38.0+) |
| **Validate after errors** - Run `validate` if something fails | Integrity check |

**Note**: Direct file reads can lead to stale data when multiple writers (TodoWrite, cleo) modify the same files. CLI commands always read fresh data from disk.

**Multi-Session Note** (v0.38.0+): When `multiSession.enabled`, the "one active task" constraint is **per scope**, not global. Each session maintains isolated focus within its defined scope.

## Command Reference

### Core Operations
```bash
cleo add "Task title" [OPTIONS]     # Create task
cleo update <id> [OPTIONS]          # Update task fields
cleo complete <id>                  # Mark done
cleo list [--status STATUS]         # View tasks
cleo show <id>                      # View single task details
```

### Focus & Session
```bash
cleo focus set <id>                 # Set active task (marks active)
cleo focus show                     # Show current focus
cleo focus clear                    # Clear focus
cleo focus note "Progress text"     # Set session progress note
cleo focus next "Next action"       # Set suggested next action
cleo session start                  # Begin work session
cleo session end                    # End session (resumable)
cleo session suspend                # Pause session (resumable)
cleo session resume <id>            # Resume suspended/ended session
cleo session close <id>             # Permanently close (all tasks must be done)
cleo session status                 # Show session info
```

### Multi-Session (v0.41.0+)

> **Status**: Fully implemented with Epic-Bound Session Architecture. See [MULTI-SESSION-SPEC.md](specs/MULTI-SESSION-SPEC.md)

Enables multiple concurrent LLM agents to work on different task groups (epics, phases) simultaneously.

```bash
# Scoped session start
cleo session start --scope epic:T001        # Work on epic T001 and children
cleo session start --scope taskGroup:T005   # Work on T005 and direct children
cleo session start --scope epicPhase --root T001 --phase testing
cleo session start --name "Auth Work" --agent opus-1

# Session lifecycle
cleo session suspend --note "Waiting for review"
cleo session resume <session-id>
cleo session resume --last --scope epic:T001
cleo session end --note "Completed auth"

# Session management
cleo session list                    # All sessions
cleo session list --status active    # Filter by status
cleo session list --scope T001       # Sessions touching epic
cleo session show <session-id>       # Session details
cleo session switch <session-id>     # Switch active session

# Focus (session-aware)
cleo focus set T005 --session <id>   # Focus within specific session
```

**Scope Types**:
| Type | Definition | Example |
|------|------------|---------|
| `task` | Single task only | `--scope task:T005` |
| `taskGroup` | Parent + direct children | `--scope taskGroup:T005` |
| `subtree` | Parent + all descendants | `--scope subtree:T001` |
| `epicPhase` | Epic filtered by phase | `--scope epicPhase --root T001 --phase testing` |
| `epic` | Full epic tree | `--scope epic:T001` |

**Key Constraints**:
- One active task **per scope** (not global)
- Sessions cannot claim same task simultaneously
- Scope overlap configurable: `multiSession.allowScopeOverlap`

**Configuration** (`config.json`):
```json
{
  "multiSession": {
    "enabled": true,
    "maxConcurrentSessions": 5,
    "maxActiveTasksPerScope": 1,
    "scopeValidation": "strict"
  }
}
```

### TodoWrite Sync
```bash
cleo sync --inject                  # Prepare tasks for TodoWrite (session start)
cleo sync --inject --focused-only   # Inject only focused task
cleo sync --extract <file>          # Merge TodoWrite state back (session end)
cleo sync --extract --dry-run <file> # Preview changes without applying
cleo sync --status                  # Show sync session state
```

### Analysis & Planning
```bash
cleo analyze                        # Task triage with leverage scoring
cleo analyze --json                 # Machine-readable triage output
cleo analyze --auto-focus           # Analyze and auto-set focus to top task
cleo dash                           # Project dashboard overview
cleo dash --compact                 # Single-line status summary
cleo next                           # Suggest next task (priority + deps)
cleo next --explain                 # Show suggestion reasoning
cleo phases                         # List phases with progress bars
cleo phases show <phase>            # Tasks in specific phase
cleo phases stats                   # Detailed phase statistics
cleo labels                         # List all labels with counts
cleo labels show <label>            # Tasks with specific label
cleo deps                           # Dependency overview
cleo deps <id>                      # Dependencies for task
cleo deps tree                      # Full dependency tree
cleo blockers                       # Show blocked tasks
cleo blockers analyze               # Critical path analysis
```

### Research & Discovery (v0.23.0+)
```bash
cleo research "query"               # Multi-source web research
cleo research --library NAME -t X   # Library docs via Context7
cleo research --reddit "topic" -s S # Reddit discussions via Tavily
cleo research --url URL [URL...]    # Extract from specific URLs
cleo research -d deep               # Deep research (15-25 sources)
cleo research --link-task T001      # Link research to task
```

**Aliases**: `dig` → `research`

**Output**: Creates `.cleo/research/research_[id].json` + `.md` files with citations.

### Task Inspection
```bash
cleo show <id>                      # Full task details view
cleo show <id> --history            # Include task history from log
cleo show <id> --related            # Show related tasks (same labels)
cleo show <id> --include-archive    # Search archive if not found
cleo show <id> --format json        # JSON output for scripting
```

### Task Search (v0.19.2+)
```bash
cleo find <query>                   # Fuzzy search tasks by title/description
cleo find --id 37                   # Find tasks with ID prefix T37*
cleo find "exact title" --exact     # Exact match mode
cleo find "test" --status pending   # Filter by status
cleo find "api" --field title       # Search specific fields
cleo find "task" --format json      # JSON output for scripting
cleo find "old" --include-archive   # Include archived tasks
```

**Aliases**: `search` → `find`

### Hierarchy (v0.17.0+)
```bash
# Create with hierarchy
cleo add "Epic" --type epic --size large
cleo add "Task" --parent T001 --size medium
cleo add "Subtask" --parent T002 --type subtask --size small

# Modify hierarchy
cleo reparent T003 --to T001        # Move task to different parent
cleo reparent T003 --to ""          # Remove parent (make root)
cleo promote T003                   # Promote to root (same as reparent --to "")
cleo populate-hierarchy             # Infer parentId from naming conventions (T001.1 → parentId: T001)

# List with hierarchy filters
cleo list --type epic               # Filter by type (epic|task|subtask)
cleo list --parent T001             # Tasks with specific parent
cleo list --children T001           # Direct children of task
cleo list --tree                    # Hierarchical tree view
```

**Constraints**: max depth 3 (epic→task→subtask), unlimited siblings by default (configurable via `hierarchy.maxSiblings`).

### Task Cancellation (v0.32.0+)
```bash
# Cancel/delete tasks (soft-delete)
cleo delete <id> --reason "..."       # Cancel task with required reason
cleo cancel <id> --reason "..."       # Alias for delete
cleo delete <id> --children cascade   # Cancel task and all children
cleo delete <id> --children orphan    # Cancel task, orphan children
cleo delete <id> --children block     # Fail if has children (default)
cleo delete <id> --dry-run            # Preview without changes

# Restore cancelled tasks
cleo uncancel <id>                    # Restore cancelled task to pending
cleo uncancel <id> --cascade          # Restore parent and cancelled children
cleo uncancel <id> --notes "reason"   # Add restoration note
```

**Exit Codes**: `16` = has children (use --children), `17` = task completed (use archive), `102` = already cancelled/pending

**Aliases**: `cancel` → `delete`, `restore-cancelled` → `uncancel`

### Task Reopen (v0.36.0+)
```bash
# Reopen completed tasks (restore done → pending)
cleo reopen <id> --reason "..."        # Reopen with required reason
cleo reopen <id> --reason "..." --status active  # Reopen as active
cleo reopen <id> --reason "..." --dry-run        # Preview changes
```

**Use Case**: Reopening auto-completed epics when child tasks were completed prematurely.

**Warning**: When reopening an epic with all children still done, it may auto-complete again. Consider reopening a child task first or disabling auto-complete.

**Aliases**: `restore-done` → `reopen`

### Maintenance
```bash
cleo validate                       # Check file integrity
cleo validate --fix                 # Fix checksum issues
cleo exists <id>                    # Check if task ID exists (exit code 0/1)
cleo exists <id> --quiet            # Silent check for scripting
cleo exists <id> --include-archive  # Search archive too
cleo archive                        # Archive completed tasks
cleo stats                          # Show statistics
cleo backup                         # Create backup
cleo backup --list                  # List available backups
cleo restore [backup]               # Restore from backup
cleo migrate status                 # Check schema versions
cleo migrate run                    # Run schema migrations
cleo migrate-backups --detect       # List legacy backups
cleo migrate-backups --run          # Migrate to new taxonomy
cleo export --format todowrite      # Export to Claude Code format
cleo export --format csv            # Export to CSV
cleo init --update-claude-md        # Update CLAUDE.md injection (idempotent)
cleo config show                    # View current configuration
cleo config set <key> <value>       # Update configuration
cleo config get <key>               # Get specific config value
cleo log                            # View recent audit log entries
cleo log --limit 20                 # Limit entries shown
cleo log --operation create         # Filter by operation type
cleo log --task T001                # Filter by task ID
```

### History & Analytics
```bash
cleo history                        # Recent completion timeline (30 days)
cleo history --days 7               # Last week's completions
cleo history --since 2025-12-01     # Since specific date
cleo history --format json          # JSON output for scripting
```

## CLAUDE.md Integration

### Update CLAUDE.md Instructions
When cleo is upgraded, update your project's CLAUDE.md injection:

```bash
# Update existing CLAUDE.md injection to latest template
cleo init --update-claude-md
```

This command:
- Replaces content between `<!-- CLEO:START -->` and `<!-- CLEO:END -->`
- Adds injection if not present
- Safe to run anytime (idempotent)
- Does NOT re-initialize the project or touch `.cleo/` files

### When to Update
Run `init --update-claude-md` after:
- Upgrading cleo to a new version
- Template improvements are released
- You notice outdated instructions in CLAUDE.md

### Check Current Version
```bash
# Compare injection to installed template
diff <(sed -n '/CLEO:START/,/CLEO:END/p' CLAUDE.md) \
     ~/.cleo/templates/CLAUDE-INJECTION.md
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
cleo list --status pending          # Filter by status
cleo list --priority high           # Filter by priority
cleo list --label bug               # Filter by label
cleo list --phase core              # Filter by phase
cleo list --format json             # Output format (text|json|jsonl|markdown|table)
```

### LLM-Agent-First Output

**JSON is automatic** when piped (non-TTY). No `--format` flag needed:
```bash
cleo list | jq '.tasks[0]'      # Auto-JSON when piped
cleo analyze                     # JSON by default (use --human for text)
```

**Prefer native filters over jq** (fewer tokens, no shell quoting issues):
```bash
# ✅ NATIVE (recommended)
cleo list --status pending       # Built-in filter
cleo find "auth"                 # Fuzzy search (99% less context)
cleo list --label bug --phase core  # Combined filters

# ⚠️ JQ (only when native filters insufficient)
# Use SINGLE quotes to avoid shell interpretation
cleo list | jq '.tasks[] | select(.type != "epic")'
#                    ^ single quotes prevent bash ! expansion
```

**JSON envelope structure**: `{ "_meta": {...}, "summary": {...}, "tasks": [...] }`

## Session Protocol

### Core Concepts

**Sessions persist across Claude conversations.** When you end a Claude terminal session, cleo sessions remain. Resume them in your next conversation.

**Sessions are scoped to epics/tasks.** Each session defines what you're working on (an epic or task group) and tracks your progress within that scope.

**Sessions coexist.** You do NOT need to suspend one session to start another. Multiple sessions can be active simultaneously on different scopes.

### Workflow

#### START Phase (State Awareness)
```bash
cleo session list                   # Check existing sessions
cleo list                           # See current task state
cleo dash                           # Overview of project state
cleo focus show                     # Check current focus

# Resume existing or start new
cleo session resume <session-id>
# OR
cleo session start --scope epic:T001 --auto-focus --name "Feature Work"
```

#### WORK Phase (Operational Commands)
```bash
cleo focus set <task-id>            # Set active task (one per scope)
cleo next                           # Get task suggestion
cleo add "Subtask" --depends T005   # Add related tasks
cleo update T005 --notes "Progress" # Add task notes
cleo focus note "Working on X"      # Session-level progress note
cleo complete T005                  # Complete task
cleo focus set T006                 # Move to next task
```

#### END Phase (Cleanup)
```bash
cleo complete <task-id>             # Complete current work
cleo archive                        # Clean up old done tasks
cleo session end --note "Progress summary"
```

### Session States

| State | Meaning | Resumable |
|-------|---------|-----------|
| `active` | Currently working | N/A |
| `suspended` | Paused (explicit) | Yes |
| `ended` | Work complete for now | Yes |
| `closed` | Permanently archived | No |

### Multi-Session Concurrency

Multiple sessions can be active simultaneously on different scopes:

```bash
# Agent 1: Working on auth epic
cleo session start --scope epic:T001 --auto-focus

# Agent 2: Working on UI epic (NO CONFLICT - different scope)
cleo session start --scope epic:T050 --auto-focus

# Both sessions are ACTIVE simultaneously
cleo session list --status active
```

**Key insight:** Starting a new session does NOT affect other sessions. Each session is independent.

### Session Binding

When you start/resume a session, cleo writes to `.cleo/.current-session`. This **binds this terminal** to that session. All subsequent commands automatically use this session context.

```bash
# After session start, these commands know your session:
cleo focus show      # Shows YOUR session's focus
cleo focus set T005  # Sets focus within YOUR scope
```

To switch which session this terminal uses:
```bash
cleo session switch <other-session-id>
```

### Suspend vs End

| Action | State | Use When |
|--------|-------|----------|
| `suspend` | Paused | Waiting on external blocker (review, API, etc.) |
| `end` | Ended | Done for now, will resume later |
| `close` | Closed | All scope tasks complete, archive permanently |

### Useful Patterns

```bash
# Resume most recent session for a scope
cleo session resume --last --scope epic:T001

# Start with agent identifier
cleo session start --scope epic:T001 --auto-focus --agent opus-1

# Phase-filtered scope
cleo session start --scope epicPhase --root T001 --phase testing

# List tasks in current phase
cleo list --phase $(cleo phase show -q)
```

### Conflict Prevention

```bash
# Before starting, check scope availability
cleo session list --scope T001

# If scope conflict detected:
# ERROR (E_SCOPE_CONFLICT): Scope overlaps with session_...

# Use disjoint scopes for parallel work
Agent A: cleo session start --scope epicPhase --root T001 --phase testing
Agent B: cleo session start --scope epicPhase --root T001 --phase polish
```

## Task Organization

### Labels (Categorization)
Use labels for grouping and filtering:
```bash
# Feature tracking
cleo add "JWT middleware" --labels feature-auth,backend

# Find all auth tasks
cleo list --label feature-auth
cleo labels                         # See all labels with counts
cleo labels show feature-auth       # All tasks with label
```

### Phase Discipline
Phases provide workflow organization and context-aware task management. This section establishes behavioral expectations for LLM agents working with multi-phase projects.

**Session Protocol with Phase Awareness:**
```bash
# 1. Always check current phase before starting work
cleo phase show                     # Verify project context
cleo list --phase $(cleo phase show -q)  # Current phase tasks

# 2. Start session with phase context
cleo session start                  # Begin work session
cleo phase show                     # Confirm phase alignment
```

**Phase-Aware Task Creation:**
```bash
# Create tasks in appropriate phase
cleo add "Design API endpoints" --phase core --priority high
cleo add "Write unit tests" --phase testing --depends T001
cleo add "Update documentation" --phase polish --size medium

# Cross-phase dependencies (document rationale)
cleo add "Integration testing" --phase testing --depends T001,T002 \
  --notes "Cross-phase: validates core implementation before polish"
```

**Cross-Phase Work Guidelines:**
- **Same phase preferred** - Work within current phase when possible for focus
- **Intentional cross-phase** - Document rationale when crossing phase boundaries
- **Phase completion awareness** - Understand what triggers phase advancement
- **Context preservation** - Maintain phase relationships during task operations

**Five-Phase Workflow Structure:**
```bash
# Setup phase: Foundation and planning
cleo list --phase setup            # Foundation tasks

# Core phase: Main development and implementation  
cleo list --phase core             # Feature development

# Testing phase: Validation and quality assurance
cleo list --phase testing          # Testing and validation

# Polish phase: Refinement and documentation
cleo list --phase polish           # Documentation and refinement

# Maintenance phase: Ongoing support and fixes
cleo list --phase maintenance      # Bug fixes and support
```

**Phase Transition Patterns:**
```bash
# Review current phase completion
cleo phases                        # Progress overview
cleo analyze --phase $(cleo phase show -q)  # Current analysis

# Phase advancement (when current phase complete)
cleo phase complete                # Mark current phase done
cleo phase advance                 # Move to next phase
cleo phase set testing             # Explicit phase setting
```

**Anti-Hallucination Phase Validation:**
```bash
# Verify phase context before assumptions
cleo phase show                    # Current phase confirmation
cleo exists T001 --phase core      # Validate task-phase alignment
cleo list --phase core --status done  # Phase completion status

# Cross-reference project state
cleo dash                          # Project overview
cleo phases stats                  # Phase statistics
```

**Relationship Between project.currentPhase and task.phase:**
- `project.currentPhase` - Global project context setting workflow stage
- `task.phase` - Individual task assignment to specific workflow stage
- Phase discipline ensures alignment between global context and task operations
- Cross-phase work allowed but should be intentional and documented

**Configuration Options (Advanced):**
- `warnPhaseContext` - Warn when working outside current phase
- `enforcePhaseOrder` - Restrict task creation to current/previous phases
- Phase policies control behavior for different workflow patterns

### Dependencies (Task Ordering)
Block tasks until prerequisites complete:
```bash
cleo add "Write tests" --depends T001,T002
# Task stays pending until T001, T002 are done
cleo deps T001                      # What depends on T001
cleo blockers                       # What's blocking progress
cleo blockers analyze               # Critical path analysis
```

### Planning Pattern
```bash
# Phase 1 tasks
cleo add "Design API" --phase setup --priority high
cleo add "Create schema" --phase setup --depends T050

# Phase 2 tasks (blocked until phase 1)
cleo add "Implement endpoints" --phase core --depends T050,T051
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
cleo exists T001

# Silent check for scripting (no output)
if cleo exists T001 --quiet; then
  echo "Task exists"
fi

# Check archive too
cleo exists T001 --include-archive

# Get detailed info with verbose mode
cleo exists T001 --verbose
```

### Script Examples
```bash
# Validate before update
if cleo exists T042 --quiet; then
  cleo update T042 --priority high
else
  echo "ERROR: Task T042 not found"
  exit 1
fi

# Validate dependencies exist
DEPS=("T001" "T002" "T005")
for dep in "${DEPS[@]}"; do
  if ! cleo exists "$dep" --quiet; then
    echo "ERROR: Dependency $dep not found"
    exit 1
  fi
done

# JSON output for complex logic
EXISTS=$(cleo exists T001 --format json | jq -r '.exists')
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
| Checksum mismatch | `cleo validate --fix` |
| Task not found | `cleo list --all` (check archive) |
| Multiple active tasks | `cleo focus set <correct-id>` (resets others) |
| Corrupted JSON | `cleo restore` or `backup --list` then restore |
| Session already active | `cleo session status` then `session end` |
| Schema outdated | `cleo migrate run` |

## Command Aliases (v0.6.0+)

Built-in CLI aliases for faster workflows:
```bash
cleo ls              # list
cleo done T001       # complete T001
cleo new "Task"      # add "Task"
cleo edit T001       # update T001
cleo rm              # archive
cleo check           # validate
cleo tags            # labels
cleo overview        # dash
cleo dig "query"     # research
```

## Shell Aliases
```bash
ct              # cleo
ct-add          # cleo add
ct-list         # cleo list
ct-done         # cleo complete
ct-focus        # cleo focus
```

## Tab Completion (v0.28.0+)

Enable shell completion for faster command entry:

**Bash** (add to `~/.bashrc`):
```bash
source ~/.cleo/completions/bash-completion.sh
```

**Zsh** (add to `~/.zshrc`):
```bash
fpath=(~/.cleo/completions $fpath)
autoload -Uz compinit && compinit
```

**Features:**
- Context-aware `--parent` completion (shows epic/task only, not subtasks)
- All commands, subcommands, and flags
- Task ID completion with status filtering
- Phase, label, and priority value completion

**Full documentation**: [docs/commands/tab-completion.md](commands/tab-completion.md)

## Debug & Validation
```bash
cleo --validate      # Check CLI integrity
cleo --list-commands # Show all commands
cleo help <command>  # Detailed command help
```

### Command Discovery (v0.21.0+)
```bash
cleo commands                   # List all commands (JSON by default)
cleo commands --human           # Human-readable list
cleo commands -r critical       # Filter by agent relevance
cleo commands -c write          # Filter by category
cleo commands add               # Details for specific command
cleo commands --workflows       # Agent workflow sequences
cleo commands --lookup          # Intent-to-command mapping
```

**No jq required** - use native `--category` and `--relevance` filters instead.

## vs TodoWrite

| System | Purpose | Persistence |
|--------|---------|-------------|
| **cleo** | Durable task tracking | Survives sessions, full metadata |
| **TodoWrite** | Ephemeral session tasks | Session-only, simplified format |

**Workflows:**
- One-way export: `cleo export --format todowrite`
- Bidirectional sync: `cleo sync --inject` (start) and `sync --extract` (end)

---
*Full documentation: `cleo help <command>` or `~/.cleo/docs/`*
