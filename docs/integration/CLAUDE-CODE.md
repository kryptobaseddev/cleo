# Claude Code Integration Guide

> LLM-optimized reference for Claude Code sessions with cleo

---

## Anti-Hallucination Rules

**Critical Constraints** - Enforce these ALWAYS:

| Rule | Constraint | Violation Response |
|------|------------|-------------------|
| **Single Active Task** | Only ONE task may have `status: "active"` | Abort operation, report conflict |
| **Focus Consistency** | `focus.currentTask` MUST match the `active` task | Abort, fix mismatch |
| **ID Uniqueness** | Task IDs unique across todo.json + archive | Reject duplicate |
| **Status Enum** | Status is exactly: `pending | active | blocked | done` | Reject invalid status |
| **Timestamp Sanity** | `createdAt` not in future, `completedAt` after `createdAt` | Reject invalid timestamp |
| **Blocked State** | `status: "blocked"` requires `blockedBy` field | Reject incomplete blocked task |
| **Done State** | `status: "done"` requires `completedAt` timestamp | Auto-add timestamp |
| **Dependency Order** | Cannot activate task until all `depends[]` tasks are `done` | Reject activation |

**Validation Commands**:
```bash
cleo validate          # Standard validation
cleo validate --strict # Warnings are errors
cleo validate --fix    # Auto-fix simple issues
```

---

## Session Protocol

### Session Start

```
1. Read config.json
2. Read todo.json
3. Verify _meta.checksum (log if mismatch, don't block)
4. Generate session ID: session_YYYYMMDD_HHMMSS_<random>
5. Set _meta.activeSession
6. Log session_start to todo-log.json
7. Check focus.currentTask
   - If set: Resume that task
   - If null: Find highest priority actionable pending task
```

**CLI Command**:
```bash
cleo session start
```

### During Session

| Action | How To |
|--------|--------|
| Activate task | `cleo focus set <ID>` |
| Add progress note | `cleo update <ID> --notes "Progress text"` |
| Add new task | `cleo add "Task title" [options]` |
| Mark blocked | `cleo update <ID> --blocked-by "Reason"` |
| Complete task | `cleo complete <ID>` |
| Check status | `cleo list` or `cleo focus show` |

**Focus Object** (in todo.json):
```json
{
  "focus": {
    "currentTask": "T003",
    "blockedUntil": null,
    "sessionNote": "Implementing JWT validation, middleware complete",
    "nextAction": "Add token refresh endpoint"
  }
}
```

### Session End

```
1. Update focus.sessionNote (describe current state)
2. Set focus.nextAction (specific next step)
3. Recalculate and update _meta.checksum
4. Check archive eligibility (config.archive.archiveOnSessionEnd)
5. Log session_end to todo-log.json
6. Set _meta.activeSession = null
```

**CLI Command**:
```bash
cleo session end
```

---

## Task Lifecycle

### Status Transitions

```
                     ┌──────────────────────────────────────────┐
                     │                                          │
    create           │      blocked                             │
       │             ▼         │                                │
       ▼       ┌─────────┐     │       ┌─────────┐              │
  ┌─────────┐  │         │◄────┘       │         │              │
  │ pending │──►  active │─────────────►  done   │──► archive   │
  └─────────┘  │         │             │         │              │
       ▲       └─────────┘             └─────────┘              │
       │             │                      │                   │
       │             └──────────────────────┼───────────────────┘
       │                   (rollback)       │
       │                                    │
       └────────────────────────────────────┘
              (reopened - rare)
```

| From | To | Trigger | Validation |
|------|----|---------|------------|
| pending | active | Work starts | Check dependencies done, no other active task |
| active | done | Task complete | Auto-add completedAt timestamp |
| active | blocked | Impediment found | Requires blockedBy reason |
| blocked | active | Blocker resolved | Check no other active task |
| done | archived | After retention period | Auto via archive.sh |

### Task Creation

```bash
cleo add "Implement authentication" \
  --priority high \
  --labels "backend,security" \
  --description "Add JWT-based authentication" \
  --acceptance "Login endpoint works,Token refresh works"
```

**Required Fields**: `title`
**Auto-Generated**: `id`, `createdAt`, `status: pending`

### Task Completion

```bash
cleo complete T001
```

**Auto-Updates**: `status → done`, `completedAt → now`, clears `focus.currentTask`

---

## Checksum Protocol

### Purpose

Detect external modifications to todo.json. **Detection-only** - does not block operations.

**Why Detection-Only**: Both cleo CLI and TodoWrite modify todo.json. Blocking on mismatch would break normal Claude Code workflows.

### Calculate

```bash
jq -c '.tasks' todo.json | sha256sum | cut -c1-16
```

### Verify

```bash
STORED=$(jq -r '._meta.checksum' todo.json)
COMPUTED=$(jq -c '.tasks' todo.json | sha256sum | cut -c1-16)

if [[ "$STORED" != "$COMPUTED" ]]; then
  echo "Checksum mismatch - external modification detected"
fi
```

### When to Update

After ANY modification to tasks array:
1. Recalculate checksum
2. Update `_meta.checksum`
3. Update `_meta.lastUpdated`

---

## TodoWrite Integration

### Schema Mapping

**cleo (Persistent)** → **TodoWrite (Ephemeral)**

| cleo | TodoWrite | Notes |
|-------------|-----------|-------|
| `title` | `content` | Direct mapping |
| `status` | `status` | Value transformation (see below) |
| — | `activeForm` | Generated from title |
| `description` | — | Lost (persistent only) |
| `priority` | — | Lost (persistent only) |
| `files` | — | Lost (persistent only) |
| `acceptance` | — | Lost (persistent only) |
| `depends` | — | Lost (persistent only) |
| `labels` | — | Lost (persistent only) |

**Status Translation**:

| cleo | TodoWrite |
|-------------|-----------|
| `pending` | `pending` |
| `active` | `in_progress` |
| `blocked` | `pending` |
| `done` | `completed` |

### Export Command

```bash
# Generate TodoWrite-compatible JSON
cleo export --format todowrite

# Filter by status
cleo export --format todowrite --status pending,active

# Limit task count
cleo export --format todowrite --max 10
```

**Output Format**:
```json
{
  "todos": [
    {
      "content": "Implement authentication",
      "status": "in_progress",
      "activeForm": "Implementing authentication"
    }
  ]
}
```

### Grammar Transformation

Title (imperative) → activeForm (present continuous)

**Examples**:
| Title | activeForm |
|-------|------------|
| "Implement authentication" | "Implementing authentication" |
| "Fix login bug" | "Fixing login bug" |
| "Add user dashboard" | "Adding user dashboard" |
| "Set up CI/CD pipeline" | "Setting up CI/CD pipeline" |
| "Clean up codebase" | "Cleaning up codebase" |

**Implementation**: Lookup table (130+ verbs) + rule-based fallback

### Sync Strategy

**Hybrid Export + Manual Backflow**

```
┌─────────────────┐                    ┌─────────────────┐
│    cleo  │    One-Way Export  │    TodoWrite    │
│   (persistent)  │───────────────────►│   (ephemeral)   │
│                 │                    │                 │
│  todo.json      │◄───────────────────│  Session state  │
│                 │    Manual Backflow │                 │
└─────────────────┘    (on user cmd)   └─────────────────┘
```

1. **Session Start**: Export pending/active tasks to TodoWrite format
2. **During Session**: User works with ephemeral TodoWrite tasks
3. **Session End**: Optionally commit completions back to persistent store

**Why Not Bidirectional Sync**: Conflict resolution complexity, schema mismatch, anti-hallucination requirements.

---

## Quick Reference

### Essential Commands

```bash
# Task Management
cleo add "Task title"       # Create task
cleo list                   # View tasks
cleo complete <ID>          # Mark complete
cleo update <ID> [options]  # Update task

# Focus & Session
cleo focus set <ID>         # Set active task
cleo focus show             # Show current focus
cleo session start          # Start session
cleo session end            # End session

# Maintenance
cleo validate               # Check integrity
cleo archive                # Archive completed tasks
cleo export --format todowrite  # Export for Claude Code
```

### Status Values

| Status | Meaning | Can Transition To |
|--------|---------|-------------------|
| `pending` | Not started | `active` |
| `active` | Currently working (max 1) | `blocked`, `done` |
| `blocked` | Waiting on dependency | `active` |
| `done` | Completed | `archived` |

### Priority Values

| Priority | Usage |
|----------|-------|
| `critical` | Must fix immediately |
| `high` | Important, current sprint |
| `medium` | Standard priority (default) |
| `low` | Nice to have |

### Files

| File | Purpose | Modify Via |
|------|---------|------------|
| `todo.json` | Active tasks | cleo CLI |
| `todo-archive.json` | Completed tasks | archive command only |
| `config.json` | Configuration | Manual edit |
| `todo-log.json` | Audit trail | Automatic (append-only) |

---

## Validation Checks

| Check | Level | Description |
|-------|-------|-------------|
| JSON syntax | Schema | Valid JSON structure |
| Required fields | Schema | id, status, title present |
| Status enum | Schema | Valid status value |
| Timestamps | Schema | ISO 8601 format |
| Single active | Semantic | Only one active task |
| Focus match | Semantic | focus.currentTask matches active |
| Dependencies exist | Semantic | depends[] IDs exist |
| No circular deps | Semantic | No dependency loops |
| ID uniqueness | Cross-file | Unique across todo + archive |

---

## Logging

All operations logged to `todo-log.json`:

```bash
# Task events
log.sh --action task_created --task-id T005
log.sh --action status_changed --task-id T001 \
  --before '{"status":"pending"}' \
  --after '{"status":"active"}'

# Session events
log.sh --action session_start --session-id "session_20251205_..."
log.sh --action session_end --session-id "session_20251205_..."
```

**Operation Types**: `task_created`, `task_updated`, `status_changed`, `task_completed`, `task_archived`, `session_start`, `session_end`

---

## Configuration (Session-Related)

```json
{
  "session": {
    "requireSessionNote": true,
    "warnOnNoFocus": true,
    "autoStartSession": true,
    "sessionTimeoutHours": 24
  },
  "archive": {
    "archiveOnSessionEnd": true,
    "daysUntilArchive": 7,
    "maxCompletedTasks": 15,
    "preserveRecentCount": 3
  }
}
```

---

**See Also**:
- [Architecture](../architecture/ARCHITECTURE.md) - Complete system design
- [Command Reference](../reference/command-reference.md) - All CLI commands
- [Workflow Patterns](WORKFLOWS.md) - Best practices
