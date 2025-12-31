# sessions.json File Structure

Reference for the `.cleo/sessions.json` file used in multi-session mode.

## Overview

`sessions.json` stores all session data for multi-session mode. It is created automatically when multi-session is enabled.

**Location:** `.cleo/sessions.json`

## Top-Level Structure

```json
{
  "$schema": "./schemas/sessions.schema.json",
  "version": "1.0.0",
  "project": "my-project",
  "_meta": {
    "checksum": "abc123...",
    "lastModified": "2025-12-30T15:00:00Z",
    "totalSessionsCreated": 5
  },
  "config": {
    "maxConcurrentSessions": 5,
    "maxActiveTasksPerScope": 1,
    "scopeValidation": "strict",
    "allowNestedScopes": true,
    "allowScopeOverlap": false
  },
  "sessions": [...],
  "sessionHistory": [...]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Schema version |
| `project` | string | Project name |
| `_meta` | object | File metadata |
| `config` | object | Session configuration |
| `sessions` | array | Active/suspended/ended sessions |
| `sessionHistory` | array | Closed (archived) sessions |

## Session Entry Structure

Each session in the `sessions` array:

```json
{
  "id": "session_20251230_161248_81c3ce",
  "status": "active",
  "name": "Auth Implementation",
  "agentId": "claude-opus",
  "scope": {
    "type": "epic",
    "rootTaskId": "T001",
    "phaseFilter": null,
    "computedTaskIds": ["T001", "T002", "T003"]
  },
  "focus": {
    "currentTask": "T002",
    "currentPhase": "core",
    "previousTask": "T001",
    "sessionNote": "Working on JWT validation",
    "nextAction": "Add error handling",
    "focusHistory": [
      {"taskId": "T001", "timestamp": "...", "action": "focused"},
      {"taskId": "T001", "timestamp": "...", "action": "completed"},
      {"taskId": "T002", "timestamp": "...", "action": "focused"}
    ]
  },
  "startedAt": "2025-12-30T14:30:00Z",
  "lastActivity": "2025-12-30T15:45:00Z",
  "suspendedAt": null,
  "endedAt": null,
  "stats": {
    "tasksCompleted": 1,
    "focusChanges": 2,
    "suspendCount": 0,
    "resumeCount": 0
  }
}
```

### Session Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique session identifier |
| `status` | enum | `active`, `suspended`, `ended`, `closed` |
| `name` | string | Human-readable session name |
| `agentId` | string | Agent identifier (auto-detected or specified) |
| `scope` | object | Session scope definition |
| `focus` | object | Current focus state |
| `startedAt` | ISO8601 | Session start timestamp |
| `lastActivity` | ISO8601 | Last command timestamp |
| `suspendedAt` | ISO8601 | When suspended (null if not) |
| `endedAt` | ISO8601 | When ended (null if active) |
| `stats` | object | Session statistics |

### Scope Object

| Field | Type | Description |
|-------|------|-------------|
| `type` | enum | `epic`, `subtree`, `taskGroup`, `task`, `epicPhase`, `custom` |
| `rootTaskId` | string | Root task of scope |
| `phaseFilter` | string | Phase filter (for `epicPhase` type) |
| `computedTaskIds` | array | Cached list of task IDs in scope |

### Focus Object

| Field | Type | Description |
|-------|------|-------------|
| `currentTask` | string | Currently focused task ID |
| `currentPhase` | string | Current phase context |
| `previousTask` | string | Last focused task |
| `sessionNote` | string | Session progress note |
| `nextAction` | string | Suggested next action |
| `focusHistory` | array | Focus change history |

## Config Object

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxConcurrentSessions` | number | 5 | Max active sessions allowed |
| `maxActiveTasksPerScope` | number | 1 | Active tasks per scope |
| `scopeValidation` | enum | `strict` | `strict` or `warn` |
| `allowNestedScopes` | boolean | true | Allow nested scope sessions |
| `allowScopeOverlap` | boolean | false | Allow overlapping scopes |

## Session Status Transitions

```
(not exists) → start → ACTIVE
ACTIVE → suspend → SUSPENDED
ACTIVE → end → ENDED
SUSPENDED → resume → ACTIVE
ENDED → resume → ACTIVE
ACTIVE/ENDED → close → CLOSED (moved to sessionHistory)
```

## Related Files

| File | Purpose |
|------|---------|
| `.cleo/.current-session` | Current terminal's session binding |
| `.cleo/config.json` | Global multi-session configuration |
| `.cleo/todo.json` | Task data (shared across sessions) |

## See Also

- [session command](../commands/session.md) - Session management commands
- [Multi-Session Spec](../specs/MULTI-SESSION-SPEC.md) - Full architecture
