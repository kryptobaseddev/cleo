# session Command

Manage epic-bound work sessions with multi-session support for concurrent LLM agents.

## Usage

```bash
cleo session <subcommand> [OPTIONS]
```

## Core Concept

**Sessions are scoped to epics or task groups.** Each session defines:
- **What you're working on** (scope: an epic, task group, or subtree)
- **Your current focus** (which task within that scope)
- **Your progress** (notes, history, stats)

**Key insight: Sessions can coexist.** You do NOT need to suspend one session to start another. Multiple sessions can be active simultaneously on different scopes.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `start` | Start a new scoped session |
| `end` | End session (resumable later) |
| `suspend` | Pause session, preserve state |
| `resume` | Continue a suspended/ended session |
| `close` | Permanently archive session |
| `status` | Show current session context |
| `info` | Show detailed session information |
| `list` | List all sessions |
| `show` | Show specific session details |
| `switch` | Switch this conversation's session binding |
| (none) | Show help message |

## Session Lifecycle

```
                     start (--scope epic:T001)
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│                       ACTIVE                             │
│  - Work on tasks in scope                               │
│  - Focus, complete, add tasks                           │
│  - Multiple active sessions allowed (different scopes)  │
└────────┬────────────────────────────────────┬───────────┘
         │                                    │
         │ suspend                            │ end
         ▼                                    ▼
┌─────────────────────┐              ┌─────────────────────┐
│     SUSPENDED       │              │       ENDED         │
│  - State preserved  │              │  - State preserved  │
│  - Resumable        │              │  - Resumable        │
└─────────┬───────────┘              └──────────┬──────────┘
          │                                     │
          │ resume                              │ resume
          └─────────────┬───────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│                    ACTIVE (resumed)                      │
└─────────────────────────────────────────────────────────┘
                        │
                        │ close (all tasks done)
                        ▼
┌─────────────────────────────────────────────────────────┐
│                      CLOSED                              │
│  - Permanently archived                                  │
│  - NOT resumable                                         │
└─────────────────────────────────────────────────────────┘
```

## Start Options

| Option | Description |
|--------|-------------|
| `--scope TYPE:ID` | **Required.** Scope definition (see Scope Types) |
| `--focus ID` | Initial focus task (must be in scope) |
| `--auto-focus` | Auto-select highest priority pending task in scope |
| `--name TEXT` | Human-readable session name |
| `--agent ID` | Agent identifier (e.g., `--agent opus-1`) |
| `--phase SLUG` | Filter scope by phase |
| `--dry-run` | Preview without creating session |

**Note:** Either `--focus` or `--auto-focus` is required.

## Other Options

| Option | Subcommands | Description |
|--------|-------------|-------------|
| `--note TEXT` | end, suspend | Add a note when ending/suspending |
| `--last` | resume | Resume most recent session |
| `--status STATUS` | list | Filter by status (active/suspended/ended) |

## Scope Types

| Type | Syntax | Definition |
|------|--------|------------|
| `epic` | `--scope epic:T001` | Epic and all descendants |
| `subtree` | `--scope subtree:T005` | Task and all descendants |
| `taskGroup` | `--scope taskGroup:T005` | Task and direct children only |
| `task` | `--scope task:T010` | Single task only |
| `epicPhase` | `--scope epicPhase --root T001 --phase testing` | Epic filtered by phase |

## Session ID Format

```
session_YYYYMMDD_HHMMSS_<6hex>
```

Example: `session_20251230_161248_81c3ce`

## Workflow

### START Phase (State Awareness)

```bash
# Check existing sessions
cleo session list

# See current project state
cleo list                           # Current task state
cleo dash                           # Project overview

# Resume existing or start new
cleo session resume <session-id>
# OR
cleo session start --scope epic:T001 --auto-focus --name "Feature Work"
```

### WORK Phase (Operational Commands)

```bash
cleo focus show                     # Your current focus
cleo next                           # Get task suggestion
cleo complete T005                  # Complete task
cleo focus set T006                 # Move to next task
cleo add "Subtask" --depends T005   # Add related tasks
cleo update T005 --notes "Progress" # Add task notes
cleo focus note "Working on X"      # Session-level progress note
```

### END Phase (Cleanup)

```bash
cleo complete <task-id>             # Complete current work
cleo archive                        # Clean up old done tasks
cleo session end --note "Progress summary"
```

## Multiple Concurrent Sessions

Sessions on different scopes can run simultaneously:

```bash
# Agent 1: Working on auth epic
cleo session start --scope epic:T001 --auto-focus --name "Auth Work" --agent opus-1

# Agent 2: Working on UI epic (no conflict - different scope)
cleo session start --scope epic:T050 --auto-focus --name "UI Work" --agent haiku-1

# Both sessions are ACTIVE simultaneously
cleo session list --status active
```

**Key insight:** Starting a new session does NOT affect other sessions. Each session is independent.

## Session Binding

When you start a session, cleo writes the session ID to `.cleo/.current-session`. This **binds this terminal/conversation** to that session. All subsequent commands use this session context automatically.

```bash
# After session start, these commands know your session:
cleo focus show      # Shows YOUR session's focus
cleo focus set T005  # Sets focus within YOUR scope
```

**To switch which session this conversation uses:**
```bash
cleo session switch <other-session-id>
```

## Session Start Behavior

When starting a session:
1. Validates scope (root task exists, no conflicts)
2. Computes tasks in scope
3. Generates session ID
4. Sets initial focus task (from --focus or --auto-focus)
5. Logs session start to audit trail
6. Checks CLAUDE.md injection version (warns if outdated)
7. Writes `.current-session` binding file

## Session End Behavior

When ending a session:
1. Saves session note to focus state
2. Moves session to "ended" status (still resumable)
3. Logs session end to audit trail
4. Triggers log rotation if configured
5. Clears `.current-session` binding file

## Warning Messages

Session start may show warnings:
- **Session already active**: Another session is running in single-session mode
- **CLAUDE.md injection outdated**: Update recommended via `cleo init --update-claude-md`

## Session State Storage

### Multi-Session Mode (sessions.json)

```json
{
  "sessions": [{
    "id": "session_20251230_161248_81c3ce",
    "status": "active",
    "scope": {"type": "epic", "rootTaskId": "T001"},
    "focus": {"currentTask": "T005", "sessionNote": "..."}
  }]
}
```

See [sessions.json reference](../reference/sessions-json.md) for full structure.

### Single-Session Mode (todo.json)

```json
{
  "_meta": {
    "activeSession": "session_20251230_161248_81c3ce",
    "lastModified": "2025-12-30T16:12:48Z"
  },
  "focus": {
    "currentTask": "T005",
    "sessionNote": "Working on authentication",
    "nextAction": "Write tests"
  }
}
```

## Conflict Prevention

```bash
# Before starting, check scope availability
cleo session list --scope T001

# If scope conflict detected:
# ERROR (E_SCOPE_CONFLICT): Scope overlaps with session_...

# Use disjoint scopes for parallel work
cleo session start --scope epicPhase --root T001 --phase testing   # Agent A
cleo session start --scope epicPhase --root T001 --phase polish    # Agent B
```

## Exit Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | Success | Operation completed |
| 30 | `E_SESSION_EXISTS` | Session conflict (single-session mode) |
| 31 | `E_SESSION_NOT_FOUND` | Session ID not found |
| 32 | `E_SCOPE_CONFLICT` | Scope overlaps with existing session |
| 33 | `E_SCOPE_INVALID` | Scope empty or root task not found |
| 34 | `E_TASK_NOT_IN_SCOPE` | Focus task not in session scope |
| 35 | `E_TASK_CLAIMED` | Task already focused by another session |
| 36 | `E_SESSION_REQUIRED` | Operation requires session context |
| 37 | `E_SESSION_CLOSE_BLOCKED` | Cannot close: tasks incomplete |
| 38 | `E_FOCUS_REQUIRED` | Session start requires --focus or --auto-focus |

## Configuration

In `.cleo/config.json`:

```json
{
  "multiSession": {
    "enabled": true,
    "maxConcurrentSessions": 5,
    "maxActiveTasksPerScope": 1,
    "allowScopeOverlap": false,
    "allowNestedScopes": true
  }
}
```

## Common Misconceptions

| Wrong | Right |
|-------|-------|
| "Must suspend session A to start session B" | Sessions coexist on different scopes |
| "Only one session can be active" | Multiple active sessions allowed (multi-session mode) |
| "Sessions are per-terminal" | Sessions persist in cleo; terminals just bind to them |
| "End session deletes it" | End preserves state; use `close` to archive |

## See Also

- [focus](focus.md) - Manage task focus within session
- [list](list.md) - View tasks (session-aware filtering)
- [sessions.json reference](../reference/sessions-json.md) - File structure
- [Multi-Session Spec](../specs/MULTI-SESSION-SPEC.md) - Full architecture details
