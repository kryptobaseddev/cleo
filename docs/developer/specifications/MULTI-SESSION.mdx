# Multi-Session Architecture Specification

**Version**: 1.0.0
**Status**: DRAFT
**Created**: 2025-12-27
**Related**: FILE-LOCKING-SPEC.md, LLM-AGENT-FIRST-SPEC.md

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174].

---

## Executive Summary

This specification defines the multi-session architecture for cleo, enabling multiple concurrent LLM agents to work on different task groups within the same project. Each session maintains isolated focus state and scope boundaries while sharing the underlying task data.

### Key Capabilities

| Capability | Description |
|------------|-------------|
| **Concurrent Sessions** | Multiple agents work simultaneously on different task groups |
| **Scoped Isolation** | Each session owns a defined subset of tasks (epic, taskGroup, phase) |
| **Per-Scope Validation** | Active task constraint applies per-scope, not globally |
| **Session Lifecycle** | Start, suspend, resume, end with full state preservation |
| **Conflict Detection** | Prevent scope overlaps and task contention |
| **Audit Trail** | Session-aware logging for debugging and accountability |

---

## Part 1: Architecture Overview

### 1.1 File Structure

```
.cleo/
├── todo.json              # Tasks (shared across sessions)
├── sessions.json          # Session registry (NEW)
├── config.json       # Configuration
├── todo-log.json          # Audit log (session-aware)
├── todo-archive.json      # Archived tasks
└── .current-session       # Optional: current session hint file
```

### 1.2 Data Ownership

| File | Owner | Locking |
|------|-------|---------|
| `sessions.json` | Session lifecycle operations | Exclusive per operation |
| `todo.json` | Task operations | Exclusive per operation |
| Both | Focus changes, task completion | Sequential (sessions → todo) |

### 1.3 Mode Selection

```
multiSession.enabled = false (default)
  └── Classic single-session behavior
  └── ._meta.activeSession in todo.json
  └── .focus in todo.json

multiSession.enabled = true
  └── sessions.json created and used
  └── ._meta.multiSessionEnabled = true
  └── .focus.primarySession for default context
  └── Per-session focus in sessions.json
```

---

## Part 2: Session Scope Model

### 2.1 Scope Types

| Type | Definition | Use Case |
|------|------------|----------|
| `task` | Single task only | Atomic work unit |
| `taskGroup` | Parent + direct children | Typical workflow unit |
| `subtree` | Parent + all descendants | Large feature work |
| `epicPhase` | Epic filtered by phase | Parallel phase work |
| `epic` | Full epic tree | Broadest scope |
| `custom` | Explicit task list | Maximum flexibility |

### 2.2 Scope Definition

```json
{
  "type": "epicPhase",
  "rootTaskId": "T001",
  "phaseFilter": "testing",
  "labelFilter": ["auth"],
  "includeDescendants": true,
  "maxDepth": 3,
  "excludeTaskIds": ["T007"]
}
```

### 2.3 Scope Computation

Tasks in scope are computed by:

1. Start with `rootTaskId`
2. If `type` includes descendants: traverse hierarchy
3. Apply `phaseFilter`: include only matching phases
4. Apply `labelFilter`: include only tasks with ALL labels
5. Apply `maxDepth`: limit hierarchy depth
6. Apply `excludeTaskIds`: remove explicit exclusions
7. Cache result in `computedTaskIds`

### 2.4 Scope Validation

Before session start, validate:

1. `rootTaskId` exists in todo.json
2. Computed scope is non-empty
3. No HARD conflicts with existing sessions
4. SOFT conflicts handled per `scopeValidation` config

---

## Part 3: Conflict Detection

### 3.1 Conflict Types

| Type | Condition | Behavior |
|------|-----------|----------|
| **HARD** | Same task claimed as `currentTask` by two sessions | BLOCK always |
| **IDENTICAL** | Two sessions with identical scope | BLOCK always |
| **NESTED** | One scope is subset of another | ALLOW if `allowNestedScopes` |
| **PARTIAL** | Scopes overlap but neither is subset | ALLOW if `allowScopeOverlap` |
| **NONE** | Scopes are disjoint | ALLOW always |

### 3.2 Validation Algorithm

```
validate_new_session(new_scope):
  for session in active_sessions:
    overlap = compute_overlap(new_scope, session.scope)

    switch overlap.type:
      case "hard":
        ERROR: "Task {id} already focused by session {session.id}"

      case "identical":
        ERROR: "Scope identical to session {session.id}"

      case "nested":
        if not config.allowNestedScopes:
          ERROR: "Scope nested within session {session.id}"
        else:
          WARN: "Scope nested within session {session.id}"
          # Parent session auto-excludes nested tasks

      case "partial":
        if not config.allowScopeOverlap:
          ERROR: "Scope overlaps with session {session.id}"
        else:
          WARN: "Scope overlaps with session {session.id}"

      case "none":
        OK: proceed
```

### 3.3 Task Focus Validation

When setting focus within a session:

1. Lock sessions.json
2. Verify task is in session's `computedTaskIds`
3. Verify no OTHER session has task as `currentTask`
4. Set `session.focus.currentTask`
5. Lock todo.json
6. Set `task.status = "active"`
7. Reset other active tasks in scope to "pending"
8. Save both files
9. Unlock in reverse order

---

## Part 4: Session Lifecycle

### 4.1 State Diagram

```
                    ┌──────────────────┐
                    │   (not exists)   │
                    └────────┬─────────┘
                             │ session start
                             ▼
┌─────────────────────────────────────────────────────┐
│                      ACTIVE                          │
│  - Can modify tasks in scope                        │
│  - Can set/clear focus                              │
│  - lastActivity updated on operations               │
└───────┬──────────────────────────────┬──────────────┘
        │                              │
        │ suspend                      │ end
        │ (or timeout)                 │
        ▼                              │
┌───────────────────┐                  │
│    SUSPENDED      │                  │
│  - Preserves state│                  │
│  - Can resume     │                  │
│  - No active ops  │                  │
└───────┬───────────┘                  │
        │                              │
        │ resume                       │
        ├──────────────────────────────┤
        ▼                              ▼
┌───────────────────┐         ┌────────────────────┐
│      ACTIVE       │         │  sessionHistory    │
│   (resumed)       │         │  - Ended sessions  │
└───────────────────┘         │  - Resumable flag  │
                              │  - Stats preserved │
                              └────────────────────┘
```

### 4.2 Session Start

A session MUST have a focused task to start. This ensures every session has a clear purpose and trackable work context.

```bash
# Explicit focus (REQUIRED: one of these)
cleo session start --scope epic:T001 --focus T005 --name "Auth impl"

# Auto-focus: picks highest priority pending task in scope
cleo session start --scope epic:T001 --auto-focus --name "Auth impl"

# ERROR: No focus specified
cleo session start --scope epic:T001
# → ERROR (E_FOCUS_REQUIRED): Session requires --focus <task-id> or --auto-focus
```

**Focus Requirement Rationale**:
- Sessions track "what is being worked on" - a session without focus has no purpose
- Enables session-to-task attribution in logs and audit trails
- Prevents orphaned sessions that consume scope but do nothing
- Allows resumption with clear context ("pick up where you left off")

**Auto-Focus Selection** (when `--auto-focus` specified):
1. Filter tasks in scope with status = "pending"
2. Sort by: priority (critical > high > medium > low), then createdAt (oldest first)
3. Select first task
4. If no pending tasks in scope: ERROR (E_SCOPE_EMPTY)

Operations:
1. Lock sessions.json
2. Validate scope (no conflicts)
3. Compute `computedTaskIds`
4. **Validate focus task exists and is in scope**
5. **If `--auto-focus`: select focus task per algorithm above**
6. Generate session ID
7. Create session entry with status="active" and `focus.currentTask` set
8. Update `_meta.totalSessionsCreated`
9. Lock todo.json
10. **Set focused task status = "active"**
11. Save both files
12. Update todo.json `_meta.activeSessionCount`
13. Log `session_start` with scope and focus context
14. Unlock both

### 4.3 Session Suspend

```bash
cleo session suspend --note "Waiting for API review"
```

Operations:
1. Lock sessions.json
2. Set `status = "suspended"`, `suspendedAt = now()`
3. Preserve focus state (not cleared)
4. Increment `stats.suspendCount`
5. Save sessions.json
6. Log `session_suspended`
7. Unlock

### 4.4 Session Resume

```bash
cleo session resume <session-id>
cleo session resume --last --scope epic:T001
```

Operations:
1. Lock sessions.json
2. Validate session exists and is resumable
3. Re-validate scope (tasks still exist)
4. Set `status = "active"`, clear `suspendedAt`
5. Increment `resumeCount`
6. Restore focus from preserved state
7. Save sessions.json
8. Log `session_resumed`
9. Unlock

### 4.5 Session End

```bash
cleo session end --note "Completed auth middleware"
```

Operations:
1. Lock sessions.json
2. Create `sessionHistoryEntry` from session
3. Remove from `sessions` array
4. Add to `sessionHistory` array
5. Clear focus in todo.json if needed
6. Reset active task to "pending" if needed
7. Update `_meta.activeSessionCount`
8. Save both files
9. Log `session_end`
10. Unlock

---

## Part 5: Focus Management

### 5.1 Per-Session Focus

Each session maintains independent focus:

```json
{
  "focus": {
    "currentTask": "T005",
    "currentPhase": "testing",
    "previousTask": "T003",
    "sessionNote": "Working on auth middleware",
    "nextAction": "Add JWT validation",
    "focusHistory": [
      {"taskId": "T003", "timestamp": "...", "action": "completed"},
      {"taskId": "T005", "timestamp": "...", "action": "focused"}
    ]
  }
}
```

### 5.2 Focus Commands

```bash
# Set focus (uses current session or env var)
cleo focus set T005

# Explicit session
cleo focus set T005 --session session_20251227_...

# Clear focus
cleo focus clear

# Show focus (session-aware)
cleo focus show
```

### 5.3 Active Task Constraint

**Single-Session Mode**: One active task globally
**Multi-Session Mode**: One active task per scope

```bash
# Per-scope validation
validate_single_active_per_scope(session_id):
  session = get_session(session_id)
  scope_tasks = session.scope.computedTaskIds

  active_count = count(
    task for task in todo.tasks
    if task.id in scope_tasks and task.status == "active"
  )

  return active_count <= config.maxActiveTasksPerScope
```

---

## Part 6: Locking Strategy

### 6.1 Lock Files

| File | Lock File | FD Range |
|------|-----------|----------|
| sessions.json | sessions.json.lock | 200-202 |
| todo.json | todo.json.lock | 203-205 |
| todo-log.json | todo-log.json.lock | 206-208 |

### 6.2 Lock Order

To prevent deadlock, ALWAYS acquire locks in this order:

```
sessions.json → todo.json → todo-log.json
```

### 6.3 Multi-File Transactions

```bash
# New helper functions (lib/file-ops.sh)

lock_multi_file() {
  local files=("$@")
  local fds=()
  for file in "${files[@]}"; do
    local fd
    if ! lock_file "$file" fd; then
      unlock_multi_file "${fds[@]}"
      return 1
    fi
    fds+=("$fd")
  done
  printf '%s\n' "${fds[@]}"
}

unlock_multi_file() {
  for fd in "$@"; do
    unlock_file "$fd"
  done
}
```

### 6.4 Transaction Pattern

```bash
# Example: Set focus (requires both files)
set_focus_multi_session() {
  local session_id="$1"
  local task_id="$2"

  # Lock in order
  local sessions_fd todo_fd
  lock_file "$SESSIONS_FILE" sessions_fd || return $E_LOCK_FAILED
  lock_file "$TODO_FILE" todo_fd || { unlock_file "$sessions_fd"; return $E_LOCK_FAILED; }

  trap "unlock_file '$todo_fd'; unlock_file '$sessions_fd'" EXIT

  # Validate and update
  validate_task_in_scope "$session_id" "$task_id" || return $E_SCOPE_ERROR
  validate_task_not_claimed "$task_id" "$session_id" || return $E_CONFLICT

  # Update session
  update_session_focus "$session_id" "$task_id"
  save_json "$SESSIONS_FILE" "$sessions_content"

  # Update task
  set_task_status "$task_id" "active"
  save_json "$TODO_FILE" "$todo_content"

  # Cleanup
  unlock_file "$todo_fd"
  unlock_file "$sessions_fd"
  trap - EXIT
}
```

---

## Part 7: Backup Integration

### 7.1 Files to Backup

```bash
BACKUP_FILES=(
  "$TODO_FILE"
  "$ARCHIVE_FILE"
  "$LOG_FILE"
  "$CONFIG_FILE"
  "$SESSIONS_FILE"  # NEW
)
```

### 7.2 Session-Triggered Backups

| Event | Backup Type | Condition |
|-------|-------------|-----------|
| Session start | safety | `backupOnSessionEvents = true` |
| Session suspend | safety | `backupOnSessionEvents = true` |
| Session end | safety | `backupOnSessionEvents = true` |
| Session resume | none | State preserved in sessions.json |

### 7.3 Session Backup Metadata

```json
{
  "type": "session",
  "timestamp": "2025-12-27T14:30:22Z",
  "sessionId": "session_20251227_143022_abc123",
  "event": "start",
  "scope": {
    "type": "epic",
    "rootTaskId": "T001",
    "taskCount": 15
  },
  "activeTask": "T005",
  "checksum": "abc123def456..."
}
```

---

## Part 8: CLI Commands

### 8.1 Session Management

```bash
# Start with scope
cleo session start --scope epic:T001
cleo session start --scope taskGroup:T005
cleo session start --scope phase:testing --root T001
cleo session start --scope custom:T003,T005,T007
cleo session start --name "Auth Implementation"

# List sessions
cleo session list
cleo session list --status active
cleo session list --status suspended
cleo session list --scope T001

# Show session details
cleo session show
cleo session show <session-id>
cleo session show --json

# Suspend
cleo session suspend
cleo session suspend --note "Waiting for API review"

# Resume
cleo session resume <session-id>
cleo session resume --last
cleo session resume --last --scope epic:T001
cleo session resume --pick  # Interactive

# End
cleo session end
cleo session end --note "Completed auth middleware"

# Switch (for single-user multi-scope)
cleo session switch <session-id>

# Validate
cleo session validate
cleo session validate --fix-orphans

# Cleanup
cleo session cleanup --ended-before 30d

# History
cleo session history
cleo session history --scope T001
```

### 8.2 Focus (Session-Aware)

```bash
# Uses current session (from env or .current-session)
cleo focus set T005
cleo focus show
cleo focus clear
cleo focus note "Progress update"
cleo focus next "Add validation"

# Explicit session
cleo focus set T005 --session <id>
cleo focus show --session <id>
```

### 8.3 Environment Variables

```bash
# Set current session for CLI commands
export CLEO_SESSION=session_20251227_143022_abc123

# Or use .current-session file
echo "session_20251227_143022_abc123" > .cleo/.current-session
```

---

## Part 9: Migration

### 9.1 Enable Multi-Session

```bash
cleo config set multiSession.enabled true
```

### 9.2 Migration Steps

1. Create sessions.json with empty sessions array
2. If `._meta.activeSession` exists:
   - Create session entry with `scope: { type: "epic", rootTaskId: null }` (full project)
   - Move `.focus` contents to `session.focus`
3. Set `._meta.multiSessionEnabled = true`
4. Clear `._meta.activeSession`
5. Set `._meta.activeSessionCount = 1` (if migrated session)

### 9.3 Backward Compatibility

- Single-session mode remains default
- Existing projects work unchanged
- Multi-session is opt-in via config
- `.focus` in todo.json preserved for fallback

---

## Part 10: Error Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `E_SUCCESS` | Operation completed |
| 8 | `E_LOCK_FAILED` | Lock acquisition failed |
| 30 | `E_SESSION_EXISTS` | Session already active (single-session mode) |
| 31 | `E_SESSION_NOT_FOUND` | Session ID not found |
| 32 | `E_SCOPE_CONFLICT` | Scope overlaps with existing session |
| 33 | `E_SCOPE_INVALID` | Scope definition invalid or empty |
| 34 | `E_TASK_NOT_IN_SCOPE` | Task not within session scope |
| 35 | `E_TASK_CLAIMED` | Task already claimed by another session |
| 36 | `E_SESSION_SUSPENDED` | Operation requires active session |
| 37 | `E_MAX_SESSIONS` | Maximum concurrent sessions reached |

---

## Part 11: Implementation Phases

### Phase 1: Schema & Config
- [x] Create sessions.schema.json
- [x] Add multiSession section to config.schema.json
- [x] Update todo.schema.json with multi-session fields
- [x] Update log.schema.json with new actions

### Phase 2: Core Library
- [ ] Create lib/sessions.sh
- [ ] Add scope computation functions
- [ ] Add conflict detection functions
- [ ] Add lock_multi_file / unlock_multi_file to lib/file-ops.sh

### Phase 3: Session Lifecycle
- [ ] Update scripts/session.sh for multi-session
- [ ] Implement session start with scope
- [ ] Implement session suspend/resume
- [ ] Implement session list/show/history

### Phase 4: Focus Integration
- [ ] Update scripts/focus.sh for session-awareness
- [ ] Implement per-scope active task validation
- [ ] Update lib/validation.sh

### Phase 5: Backup & Logging
- [ ] Update lib/backup.sh for sessions.json
- [ ] Update lib/logging.sh for scope context
- [ ] Implement session-triggered backups

### Phase 6: Migration & Testing
- [ ] Create migration script
- [ ] Unit tests for scope computation
- [ ] Integration tests for concurrent sessions
- [ ] Documentation updates

---

## Appendix A: Example Scenarios

### A.1 Two Agents on Different Epics

```bash
# Agent 1: Works on authentication epic
cleo session start --scope epic:T001 --name "Auth Work" --agent opus-1

# Agent 2: Works on UI epic (different scope, no conflict)
cleo session start --scope epic:T050 --name "UI Work" --agent haiku-1

# Both can work simultaneously
# Each has own focus, own active task
```

### A.2 Parallel Phase Work Within Epic

```bash
# Agent 1: Testing phase of auth epic
cleo session start --scope epicPhase:T001 --phase testing

# Agent 2: Documentation phase of same epic
cleo session start --scope epicPhase:T001 --phase polish

# Different phases = disjoint scopes = no conflict
```

### A.3 Nested Task Groups

```bash
# Agent 1: Works on full epic
cleo session start --scope epic:T001

# Agent 2: Works on specific task group within epic
# With allowNestedScopes=true, parent auto-excludes
cleo session start --scope taskGroup:T005

# T005 and children excluded from Agent 1's scope
```

---

## Appendix B: Schema Quick Reference

### sessions.json Structure

```json
{
  "version": "1.0.0",
  "project": "my-project",
  "_meta": {
    "checksum": "abc123...",
    "lastModified": "2025-12-27T15:00:00Z",
    "totalSessionsCreated": 5
  },
  "config": {
    "maxConcurrentSessions": 5,
    "maxActiveTasksPerScope": 1
  },
  "sessions": [
    {
      "id": "session_20251227_143022_abc123",
      "status": "active",
      "agentId": "opus-1",
      "name": "Auth Implementation",
      "scope": {
        "type": "epic",
        "rootTaskId": "T001",
        "computedTaskIds": ["T001", "T002", "T003"]
      },
      "focus": {
        "currentTask": "T002",
        "sessionNote": "Working on JWT validation"
      },
      "startedAt": "2025-12-27T14:30:22Z",
      "lastActivity": "2025-12-27T15:45:00Z"
    }
  ],
  "sessionHistory": []
}
```

---

*End of Specification*
