---
title: "session"
description: "Manage epic-bound work sessions with multi-session support"
icon: "clock"
---

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
| `archive` | Move ended/suspended session to archived (read-only) |
| `close` | Permanently archive session |
| `status` | Show current session context |
| `info` | Show detailed session information |
| `list` | List all sessions |
| `show` | Show specific session details |
| `switch` | Switch this conversation's session binding |
| `gc` | Garbage collect session artifacts |
| `doctor` | Diagnose session binding and state issues |
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
│  - Archivable       │              │  - Archivable       │
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

     From SUSPENDED or ENDED:
     ┌─────────────────────┐
     │  archive            │
     ▼                     │
┌─────────────────────────────────────────────────────────┐
│                     ARCHIVED                             │
│  - Read-only (audit trail)                               │
│  - NOT resumable                                         │
│  - Reduces sessions.json size                            │
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

## Archive Options

| Option | Description |
|--------|-------------|
| `<session-id>` | Archive specific session |
| `--all-ended` | Archive all ended/suspended sessions |
| `--older-than DAYS` | Only archive sessions inactive for N+ days |
| `--reason TEXT` | Add reason for archival |
| `--dry-run` | Preview without changes |

**Examples:**
```bash
# Archive a single session
cleo session archive session_20251230_161248_81c3ce

# Archive all ended sessions
cleo session archive --all-ended

# Archive sessions inactive for 30+ days
cleo session archive --all-ended --older-than 30

# Preview what would be archived
cleo session archive --all-ended --dry-run
```

## Other Options

| Option | Subcommands | Description |
|--------|-------------|-------------|
| `--note TEXT` | end, suspend | Add a note when ending/suspending |
| `--last` | resume | Resume most recent session |
| `--status STATUS` | list | Filter by status (active/suspended/ended/archived) |

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

## Session Binding (Hybrid Resolution)

Session binding determines which session context is used for commands. CLEO uses a **hybrid binding** system with the following resolution priority:

### Resolution Priority (highest to lowest)

1. **`--session` flag** - Explicit session ID on command line
2. **`CLEO_SESSION` env var** - Environment variable override
3. **TTY binding** - Per-terminal binding in `.cleo/tty-bindings/`
4. **`.current-session` file** - Legacy single-session fallback

### TTY Binding (Multi-Terminal Support)

Each terminal gets its own session binding, enabling multiple agents to work simultaneously from different terminals:

```bash
# Terminal 1 (Agent opus-1)
cleo session start --scope epic:T001 --auto-focus
# Creates: .cleo/tty-bindings/tty-<device-id>.json

# Terminal 2 (Agent haiku-1)
cleo session start --scope epic:T050 --auto-focus
# Creates different binding file for this terminal
```

### CLEO_SESSION Environment Variable

Override session binding for a shell session or subagent:

```bash
# Set session for this shell
export CLEO_SESSION="session_20251230_161248_81c3ce"

# Or inline for single command
CLEO_SESSION=session_abc cleo focus show
```

### Legacy Binding

For backward compatibility, `.cleo/.current-session` still works when TTY binding is unavailable:

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
- **CLAUDE.md injection outdated**: Update recommended via `cleo upgrade`

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
  },
  "retention": {
    "maxSessionsInMemory": 100,
    "maxArchivedSessions": 100,
    "autoArchiveEndedAfterDays": 30,
    "autoDeleteArchivedAfterDays": 90
  }
}
```

### Retention Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `retention.maxSessionsInMemory` | 100 | Maximum sessions in sessions.json before auto-archiving oldest ended sessions |
| `retention.maxArchivedSessions` | 100 | Maximum archived sessions before permanent deletion |
| `retention.autoArchiveEndedAfterDays` | 30 | Days before ended sessions are auto-archived |
| `retention.autoDeleteArchivedAfterDays` | 90 | Days before archived sessions are deleted (0 disables) |

## Common Misconceptions

| Wrong | Right |
|-------|-------|
| "Must suspend session A to start session B" | Sessions coexist on different scopes |
| "Only one session can be active" | Multiple active sessions allowed (multi-session mode) |
| "Sessions are per-terminal" | Sessions persist in cleo; terminals just bind to them |
| "End session deletes it" | End preserves state; use `close` to archive |

## Garbage Collection (gc)

Clean up session artifacts including archived sessions, stale TTY bindings, and orphaned context state files:

```bash
# Preview what would be cleaned
cleo session gc --dry-run

# Run garbage collection
cleo session gc

# With verbose output showing each item
cleo session gc --verbose

# JSON output for automation
cleo session gc --json
```

### gc --include-active

By default, `session gc` only archives ended/suspended sessions. Use `--include-active` to also auto-end stale active sessions:

```bash
cleo session gc --include-active           # End stale active + archive ended
cleo session gc --include-active --dry-run # Preview changes
```

Active sessions are considered stale after `retention.autoEndActiveAfterDays` (default: 7) of inactivity. The flag will:
1. Auto-end active sessions that exceed the inactivity threshold
2. Then proceed with normal gc (archiving ended sessions, cleaning bindings, etc.)

**What gets cleaned:**

| Artifact | Criteria |
|----------|----------|
| Stale active sessions | No activity for `retention.autoEndActiveAfterDays` (default: 7) - **requires `--include-active`** |
| Archived sessions | Older than `retention.autoDeleteArchivedAfterDays` (default: 90) |
| Excess archived | More than `retention.maxArchivedSessions` (default: 100) |
| Stale TTY bindings | Older than `multiSession.ttyBinding.maxAgeHours` (default: 168) |
| Orphan bindings | Session no longer exists in sessions.json |
| Orphaned context states | Session no longer exists |

## Diagnostics (doctor)

Diagnose session binding and state issues:

```bash
# Run diagnostics
cleo session doctor

# JSON output
cleo session doctor --json
```

**Output includes:**

- **Resolution Chain**: Shows all binding sources and which is active
- **Session Counts**: Active, suspended, ended, archived sessions
- **Context State Files**: Per-session and orphaned file counts
- **TTY Bindings**: Total and stale binding counts
- **Warnings**: Binding conflicts, invalid sessions, cleanup recommendations

**Example output:**
```
Session Diagnostics
===================

Multi-Session Mode: ENABLED

Resolution Chain:
  --session flag:     (not used in doctor)
  CLEO_SESSION:       (not set)
  TTY binding:        session_abc123
  .current-session:   session_old456

Active Session: session_abc123 (via TTY binding)

Session Counts:
  Active:    2
  Suspended: 1
  Ended:     5
  Archived:  127
  Total:     135

Context State Files:
  Per-session: 8
  Orphaned:    3

TTY Bindings:
  Total:  4
  Stale:  1

Warnings:
  - 3 orphaned context state file(s) found
  - 1 stale TTY binding(s) found
```

## See Also

- [focus](focus.md) - Manage task focus within session
- [list](list.md) - View tasks (session-aware filtering)
- [sessions.json reference](../reference/sessions-json.md) - File structure
- [Multi-Session Spec](../specs/MULTI-SESSION-SPEC.md) - Full architecture details
