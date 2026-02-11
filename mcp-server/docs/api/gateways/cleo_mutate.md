# cleo_mutate Gateway

**Type**: Write Operations
**Operations**: 48 across 8 domains (47 spec + 1 system job op)

---

## Overview

The `cleo_mutate` gateway provides state-modifying access to CLEO's task management, orchestration, and system operations. All operations **MUST** validate before committing, **MUST** log to the audit trail, and are **idempotent where possible**.

### Characteristics

- **MUST** validate before committing changes
- **MUST** log to audit trail
- **SHOULD** be idempotent where possible
- Requires appropriate permissions
- Changes are **never cached**
- Triggers cache invalidation for related queries

### Use Cases

- Creating and updating tasks
- Managing sessions and focus
- Spawning agents and orchestration
- Progressing lifecycle stages
- Executing releases
- System configuration and maintenance

---

## Tool Schema

```json
{
  "name": "cleo_mutate",
  "description": "CLEO write operations: create, update, complete tasks; manage sessions; spawn agents; progress lifecycle; execute releases. Modifies state with validation.",
  "inputSchema": {
    "type": "object",
    "required": ["domain", "operation"],
    "properties": {
      "domain": {
        "type": "string",
        "enum": [
          "tasks",
          "session",
          "orchestrate",
          "research",
          "lifecycle",
          "validate",
          "release",
          "system"
        ],
        "description": "Functional domain to mutate"
      },
      "operation": {
        "type": "string",
        "description": "Domain-specific write operation"
      },
      "params": {
        "type": "object",
        "description": "Operation-specific parameters",
        "additionalProperties": true
      }
    }
  }
}
```

---

## Operations by Domain

### tasks (10 operations)

Task creation, modification, and lifecycle management.

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| [create](#taskscreate) | Create new task | `title`, `description?`, `parent?`, `depends?`, `priority?`, `labels?` | Created task |
| [update](#tasksupdate) | Update task fields | `taskId`, `title?`, `description?`, `status?`, `priority?`, `labels?` | Updated task |
| [complete](#taskscomplete) | Mark task as done | `taskId`, `notes?` | Completion status |
| [delete](#tasksdelete) | Delete task | `taskId`, `force?` | Deletion status |
| [archive](#tasksarchive) | Archive completed tasks | `taskId?`, `before?` | Archived count |
| [unarchive](#tasksunarchive) | Restore from archive | `taskId` | Restored task |
| [reparent](#tasksreparent) | Change task parent | `taskId`, `newParent` | Updated hierarchy |
| [promote](#taskspromote) | Promote subtask to task | `taskId` | Promoted task |
| [reorder](#tasksreorder) | Reorder siblings | `taskId`, `position` | New order |
| [reopen](#tasksreopen) | Reopen completed task | `taskId` | Reopened task |

### session (7 operations)

Session lifecycle and focus management.

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| [start](#sessionstart) | Start new session | `scope`, `name?`, `autoFocus?`, `focus?` | Session object |
| [end](#sessionend) | End current session | `sessionId?`, `note?` | Session summary |
| [resume](#sessionresume) | Resume suspended session | `sessionId` | Resumed session |
| [suspend](#sessionsuspend) | Suspend session | `sessionId?`, `note?` | Suspended status |
| [focus.set](#sessionfocusset) | Set focused task | `taskId` | Focus confirmation |
| [focus.clear](#sessionfocusclear) | Clear focus | - | Clear confirmation |
| [gc](#sessiongc) | Garbage collect old sessions | `olderThan?` | Cleaned count |

### orchestrate (5 operations)

Multi-agent coordination and spawning.

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| [startup](#orchestratestartup) | Initialize orchestration | `epicId` | Startup state |
| [spawn](#orchestratespawn) | Generate spawn prompt | `taskId`, `skill?`, `model?` | Spawn prompt + metadata |
| [validate](#orchestratevalidate) | Validate spawn readiness | `taskId` | Validation result |
| [parallel.start](#orchestrateparallelstart) | Start parallel wave | `epicId`, `wave` | Wave tasks |
| [parallel.end](#orchestrateparallellend) | End parallel wave | `epicId`, `wave` | Wave completion |

### research (4 operations)

Research workflow and manifest management.

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| [inject](#researchinject) | Get protocol injection | `protocolType`, `taskId?`, `variant?` | Protocol block |
| [link](#researchlink) | Link research to task | `researchId`, `taskId`, `relationship?` | Link confirmation |
| [manifest.append](#researchmanifestappend) | Append manifest entry | `entry`, `validateFile?` | Entry confirmation |
| [manifest.archive](#researchmanifestarchive) | Archive old entries | `beforeDate?`, `moveFiles?` | Archive count |

### lifecycle (5 operations)

RCSD-IVTR lifecycle stage progression.

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| [progress](#lifecycleprogress) | Record stage completion | `taskId`, `stage`, `status`, `notes?` | Progress confirmation |
| [skip](#lifecycleskip) | Skip optional stage | `taskId`, `stage`, `reason` | Skip confirmation |
| [reset](#lifecyclereset) | Reset stage (emergency) | `taskId`, `stage`, `reason` | Reset confirmation |
| [gate.pass](#lifecyclegatepass) | Mark gate as passed | `taskId`, `gateName`, `agent`, `notes?` | Gate status |
| [gate.fail](#lifecyclegatefail) | Mark gate as failed | `taskId`, `gateName`, `reason` | Gate status |

### validate (2 operations)

Compliance recording and test execution.

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| [compliance.record](#validatecompliancerecord) | Record compliance check | `taskId`, `result` | Record confirmation |
| [test.run](#validatetestrun) | Execute test suite | `scope?`, `pattern?`, `parallel?` | Test results |

### release (7 operations)

Release workflow and version management.

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| [prepare](#releaseprepare) | Prepare release | `version`, `type` | Preparation status |
| [changelog](#releasechangelog) | Generate changelog | `version`, `sections?` | Changelog content |
| [commit](#releasecommit) | Create release commit | `version`, `files?` | Commit hash |
| [tag](#releasetag) | Create git tag | `version`, `message?` | Tag name |
| [push](#releasepush) | Push to remote | `version`, `remote?` | Push status |
| [gates.run](#releasegatesrun) | Run release gates | `gates?` | Gate results |
| [rollback](#releaserollback) | Rollback release | `version`, `reason` | Rollback status |

### system (7 operations)

System configuration and maintenance.

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| [init](#systeminit) | Initialize CLEO | `projectType?`, `detect?` | Init status |
| [config.set](#systemconfigset) | Set config value | `key`, `value`, `scope?` | Set confirmation |
| [backup](#systembackup) | Create backup | `type?`, `note?` | Backup metadata |
| [restore](#systemrestore) | Restore from backup | `backupId` | Restore status |
| [migrate](#systemmigrate) | Run migrations | `version?`, `dryRun?` | Migration result |
| [sync](#systemsync) | Sync with TodoWrite | `direction?` | Sync result |
| [cleanup](#systemcleanup) | Cleanup stale data | `type`, `olderThan?` | Cleanup count |

---

## Detailed Operation Reference

### tasks.create

Create a new task with optional parent, dependencies, and metadata.

**Parameters**:
- `title` (string, required) - Task title (3-200 characters)
- `description` (string, optional) - Task description (max 2000 characters)
- `parent` (string, optional) - Parent task ID (creates subtask)
- `depends` (string[], optional) - Task IDs this task depends on
- `priority` (enum, optional) - `low`, `medium`, `high`, `critical` (default: `medium`)
- `labels` (string[], optional) - Taxonomy labels
- `type` (enum, optional) - `task`, `epic`, `subtask` (inferred from parent)

**Returns**:
```json
{
  "success": true,
  "data": {
    "task": {
      "id": "T2926",
      "title": "Implement new feature",
      "description": "Add support for X with comprehensive tests",
      "status": "pending",
      "priority": "high",
      "type": "task",
      "parent": null,
      "depends": [],
      "labels": ["feature", "backend"],
      "created": "2026-02-10T21:45:00Z",
      "updated": "2026-02-10T21:45:00Z"
    }
  }
}
```

**Example**:
```typescript
const result = await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "Implement user authentication",
    description: "Add JWT-based authentication with refresh tokens",
    priority: "high",
    labels: ["security", "backend"]
  }
});
```

**Errors**:
- `E_VALIDATION_FAILED` (6) - Title/description validation failed
- `E_PARENT_NOT_FOUND` (10) - Parent task does not exist
- `E_DEPTH_EXCEEDED` (11) - Max hierarchy depth (3) exceeded
- `E_SIBLING_LIMIT` (12) - Parent already has 7 children
- `E_CIRCULAR_REFERENCE` (14) - Circular dependency detected

**Idempotency**: Duplicate detection based on title + description hash. Returns existing task if duplicate detected.

**See Also**: [tasks.update](#tasksupdate), [tasks.delete](#tasksdelete)

---

### tasks.update

Update task fields. Only specified fields are modified.

**Parameters**:
- `taskId` (string, required) - Task ID to update
- `title` (string, optional) - New title
- `description` (string, optional) - New description
- `status` (enum, optional) - `pending`, `active`, `blocked`, `done`, `cancelled`
- `priority` (enum, optional) - `low`, `medium`, `high`, `critical`
- `labels` (string[], optional) - Replace all labels
- `notes` (string, optional) - Append note to task notes array

**Returns**:
```json
{
  "success": true,
  "data": {
    "task": {
      "id": "T2926",
      "title": "Updated title",
      "description": "Updated description",
      "status": "active",
      "priority": "high",
      "updated": "2026-02-10T22:00:00Z"
    }
  }
}
```

**Example**:
```typescript
const result = await cleo_mutate({
  domain: "tasks",
  operation: "update",
  params: {
    taskId: "T2926",
    status: "active",
    notes: "Started implementation"
  }
});
```

**Errors**:
- `E_NOT_FOUND` (4) - Task does not exist
- `E_VALIDATION_FAILED` (6) - Field validation failed
- `E_LIFECYCLE_TRANSITION_INVALID` (78) - Invalid status transition

**Idempotency**: Last write wins. Same parameters produce same result.

**See Also**: [tasks.create](#taskscreate), [tasks.complete](#taskscomplete)

---

### tasks.complete

Mark a task as completed with optional completion notes.

**Parameters**:
- `taskId` (string, required) - Task ID to complete
- `notes` (string, optional) - Completion notes
- `archive` (boolean, optional) - Auto-archive after completion (default: false)

**Returns**:
```json
{
  "success": true,
  "data": {
    "task": {
      "id": "T2926",
      "status": "done",
      "completedAt": "2026-02-10T23:30:00Z",
      "notes": ["Implementation complete", "All tests passing"]
    }
  }
}
```

**Example**:
```typescript
const result = await cleo_mutate({
  domain: "tasks",
  operation: "complete",
  params: {
    taskId: "T2926",
    notes: "Implemented with full test coverage"
  }
});
```

**Errors**:
- `E_NOT_FOUND` (4) - Task does not exist
- `E_BLOCKED` (5) - Task has unresolved dependencies

**Idempotency**: Idempotent. Already completed tasks return success.

**See Also**: [tasks.reopen](#tasksreopen), [tasks.update](#tasksupdate)

---

### tasks.delete

Delete a task with optional force flag to bypass checks.

**Parameters**:
- `taskId` (string, required) - Task ID to delete
- `force` (boolean, optional) - Force deletion even if task has children (default: false)
- `strategy` (enum, optional) - `orphan`, `cascade`, `reparent` (default: `orphan`)

**Returns**:
```json
{
  "success": true,
  "data": {
    "deleted": ["T2926"],
    "orphaned": ["T2927", "T2928"],
    "strategy": "orphan"
  }
}
```

**Example**:
```typescript
const result = await cleo_mutate({
  domain: "tasks",
  operation: "delete",
  params: {
    taskId: "T2926",
    strategy: "cascade"
  }
});
```

**Errors**:
- `E_NOT_FOUND` (4) - Task does not exist
- `E_HAS_CHILDREN` (15) - Task has children (without force)

**Idempotency**: Not idempotent. Second delete fails with `E_NOT_FOUND`.

**See Also**: [tasks.archive](#tasksarchive)

---

### session.start

Start a new work session with specified scope.

**Parameters**:
- `scope` (string, required) - Session scope (e.g., "epic:T2908")
- `name` (string, optional) - Session name
- `autoFocus` (boolean, optional) - Auto-focus first pending task (default: false)
- `focus` (string, optional) - Specific task ID to focus

**Returns**:
```json
{
  "success": true,
  "data": {
    "session": {
      "id": "session_20260210_214500_a1b2c3",
      "name": "MCP Server Implementation",
      "scope": "epic:T2908",
      "status": "active",
      "focusedTask": "T2926",
      "startTime": "2026-02-10T21:45:00Z",
      "tasksInScope": ["T2924", "T2925", "T2926"]
    }
  }
}
```

**Example**:
```typescript
const result = await cleo_mutate({
  domain: "session",
  operation: "start",
  params: {
    scope: "epic:T2908",
    name: "MCP Server Implementation",
    autoFocus: true
  }
});
```

**Errors**:
- `E_SESSION_EXISTS` (30) - Session already active for scope
- `E_SCOPE_CONFLICT` (32) - Overlapping scope with other session
- `E_SCOPE_INVALID` (33) - Invalid scope specification

**Idempotency**: Scope-based deduplication. Returns existing session if scope matches.

**See Also**: [session.end](#sessionend), [session.focus.set](#sessionfocusset)

---

### session.focus.set

Set the focused task for the current session.

**Parameters**:
- `taskId` (string, required) - Task ID to focus

**Returns**:
```json
{
  "success": true,
  "data": {
    "sessionId": "session_20260210_214500_a1b2c3",
    "focusedTask": "T2926",
    "previousTask": "T2925",
    "timestamp": "2026-02-10T22:00:00Z"
  }
}
```

**Example**:
```typescript
const result = await cleo_mutate({
  domain: "session",
  operation: "focus.set",
  params: { taskId: "T2926" }
});
```

**Errors**:
- `E_SESSION_NOT_FOUND` (31) - No active session
- `E_TASK_NOT_IN_SCOPE` (34) - Task outside session scope
- `E_TASK_CLAIMED` (35) - Task claimed by another session

**See Also**: [session.focus.clear](#sessionfocusclear), [session.start](#sessionstart)

---

### orchestrate.spawn

Generate a spawn prompt for a subagent with skill resolution.

**Parameters**:
- `taskId` (string, required) - Task to spawn for
- `skill` (string, optional) - Override skill selection
- `model` (enum, optional) - Target model: `opus`, `sonnet`

**Returns**:
```json
{
  "success": true,
  "data": {
    "prompt": "# Task: T2926 - Implement user authentication...",
    "skill": "ct-task-executor",
    "taskId": "T2926",
    "tokenEstimate": 2500,
    "tokenResolution": {
      "fullyResolved": true,
      "unresolvedTokens": []
    },
    "constraints": {
      "maxContextTokens": 8000,
      "requiresSession": true,
      "requiresEpic": true
    }
  }
}
```

**Example**:
```typescript
const result = await cleo_mutate({
  domain: "orchestrate",
  operation: "spawn",
  params: {
    taskId: "T2926",
    skill: "ct-task-executor"
  }
});

// Use the prompt to spawn subagent
await spawnSubagent({
  type: "cleo-subagent",
  skill: result.data.skill,
  prompt: result.data.prompt
});
```

**Errors**:
- `E_NOT_FOUND` (4) - Task does not exist
- `E_LIFECYCLE_GATE_FAILED` (75) - Prerequisites not met
- `E_FOCUS_REQUIRED` (38) - No focused task in session

**See Also**: [orchestrate.startup](#orchestratestartup), [orchestrate.validate](#orchestratevalidate)

---

### lifecycle.progress

Record stage completion and progress to next RCSD-IVTR stage.

**Parameters**:
- `taskId` (string, required) - Task ID
- `stage` (enum, required) - Stage name: `research`, `consensus`, `specification`, `decomposition`, `implementation`, `validation`, `testing`, `release`
- `status` (enum, required) - `completed`, `skipped`, `blocked`
- `notes` (string, optional) - Progress notes
- `agent` (string, optional) - Agent ID completing the stage

**Returns**:
```json
{
  "success": true,
  "data": {
    "taskId": "T2926",
    "stage": "implementation",
    "status": "completed",
    "previousStage": "specification",
    "nextStage": "validation",
    "timestamp": "2026-02-10T23:00:00Z",
    "gateStatus": "passed"
  }
}
```

**Example**:
```typescript
const result = await cleo_mutate({
  domain: "lifecycle",
  operation: "progress",
  params: {
    taskId: "T2926",
    stage: "implementation",
    status: "completed",
    notes: "All requirements implemented"
  }
});
```

**Errors**:
- `E_NOT_FOUND` (4) - Task does not exist
- `E_LIFECYCLE_GATE_FAILED` (75) - Prerequisites not met
- `E_LIFECYCLE_TRANSITION_INVALID` (78) - Invalid state transition

**Idempotency**: Stage-based deduplication. Same stage progress returns existing status.

**See Also**: [lifecycle.skip](#lifecycleskip), [lifecycle.gate.pass](#lifecyclegatepass)

---

### release.prepare

Prepare a release with version bump and validation.

**Parameters**:
- `version` (string, required) - Target version (semver)
- `type` (enum, required) - `patch`, `minor`, `major`
- `dryRun` (boolean, optional) - Preview changes without applying (default: false)

**Returns**:
```json
{
  "success": true,
  "data": {
    "version": "1.1.0",
    "previousVersion": "1.0.0",
    "changes": {
      "versionFiles": ["VERSION", "README.md"],
      "changelogEntry": "## [1.1.0] - 2026-02-10...",
      "modifiedFiles": 3
    },
    "validation": {
      "testsPass": true,
      "lintPass": true,
      "securityPass": true
    }
  }
}
```

**Example**:
```typescript
const result = await cleo_mutate({
  domain: "release",
  operation: "prepare",
  params: {
    version: "1.1.0",
    type: "minor"
  }
});
```

**Errors**:
- `E_PROTOCOL_RELEASE` (66) - Invalid semver or missing changelog
- `E_TESTS_FAILED` (1) - Test suite failed
- `E_GATES_FAILED` (1) - Validation gates failed

**See Also**: [release.commit](#releasecommit), [release.tag](#releasetag)

---

### system.backup

Create a backup of the current CLEO state.

**Parameters**:
- `type` (enum, optional) - `snapshot`, `safety`, `archive`, `migration` (default: `snapshot`)
- `note` (string, optional) - Backup description
- `name` (string, optional) - Custom backup name

**Returns**:
```json
{
  "success": true,
  "data": {
    "backupId": "snap_20260210_220000_abc123",
    "type": "snapshot",
    "path": ".cleo/backups/snap_20260210_220000_abc123/",
    "size": 245760,
    "files": ["todo.json", "MANIFEST.jsonl", "config.json"],
    "timestamp": "2026-02-10T22:00:00Z",
    "note": "Pre-release backup"
  }
}
```

**Example**:
```typescript
const result = await cleo_mutate({
  domain: "system",
  operation: "backup",
  params: {
    type: "snapshot",
    note: "Before major refactoring"
  }
});
```

**Errors**:
- `E_FILE_ERROR` (3) - File system error
- `E_DISK_FULL` (5) - Insufficient disk space

**See Also**: [system.restore](#systemrestore), [system.cleanup](#systemcleanup)

---

## Performance Guidelines

### Response Times

| Operation Type | Typical | Maximum |
|----------------|---------|---------|
| Simple mutations | <100ms | 300ms |
| Task CRUD | <200ms | 500ms |
| Spawn generation | <500ms | 2000ms |
| Release operations | <1000ms | 5000ms |
| Backup/restore | <2000ms | 10000ms |

### Atomicity Guarantees

All `cleo_mutate` operations follow the atomic pattern:

1. **Validate** - Input validation and permission checks
2. **Temp Write** - Write to temporary file
3. **Validate Content** - Schema and semantic validation
4. **Backup** - Create safety backup of original
5. **Atomic Rename** - Rename temp to final path
6. **Audit Log** - Append to audit trail

### Cache Invalidation

Mutate operations automatically invalidate related query caches:

```typescript
// After task mutation
await cleo_mutate({ domain: "tasks", operation: "update", params: { taskId: "T2926" } });
// Automatically invalidates: tasks.get, tasks.list, tasks.find, session.status

// After session mutation
await cleo_mutate({ domain: "session", operation: "start", params: { scope: "epic:T2908" } });
// Automatically invalidates: session.status, session.list, system.stats
```

### Rate Limits

- **Mutate operations**: 30 requests per minute
- **Spawn operations**: 10 requests per minute
- **Release operations**: 5 requests per minute
- **Concurrent mutations**: Max 5 simultaneous

---

## Security

### Write Permission Requirements

All `cleo_mutate` operations require write permissions:

```json
{
  "mcpServers": {
    "cleo-full": {
      "tools": ["cleo_query", "cleo_mutate"]
    }
  }
}
```

### Audit Trail

All mutations are logged to `.cleo/audit.log`:

```json
{
  "timestamp": "2026-02-10T22:00:00Z",
  "gateway": "cleo_mutate",
  "domain": "tasks",
  "operation": "create",
  "params": { "title": "New task" },
  "result": "success",
  "taskId": "T2926"
}
```

### Validation Layers

1. **Schema Validation** - JSON Schema validation
2. **Semantic Validation** - Business rule validation
3. **Referential Validation** - Foreign key checks
4. **Protocol Validation** - RCSD-IVTR compliance

### Safety Mechanisms

- **Automatic backups** before destructive operations
- **Dry-run mode** available for most operations
- **Idempotency** where possible to prevent duplicates
- **Gate enforcement** for lifecycle transitions

---

## Error Recovery

### Retryable Errors

Some errors support retry with exponential backoff:

| Error Code | Retryable | Strategy |
|------------|-----------|----------|
| `E_RETRYABLE` (7) | Yes | Exponential backoff |
| `E_FILE_ERROR` (3) | Yes | 3 attempts |
| `E_LIFECYCLE_GATE_FAILED` (75) | No | Fix prerequisites first |

### Common Recovery Patterns

**Validation Failure**:
```typescript
const result = await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: { title: "A", description: "A" }  // Invalid: same content
});

if (!result.success && result.error.code === "E_VALIDATION_FAILED") {
  // Fix: Use suggested alternative
  await cleo_mutate({
    domain: "tasks",
    operation: "create",
    params: {
      title: "A",
      description: result.error.alternatives[0].suggestedDescription
    }
  });
}
```

**Lifecycle Gate Failure**:
```typescript
const result = await cleo_mutate({
  domain: "lifecycle",
  operation: "progress",
  params: { taskId: "T2926", stage: "implementation" }
});

if (!result.success && result.error.code === "E_LIFECYCLE_GATE_FAILED") {
  // Check what's missing
  const check = await cleo_query({
    domain: "lifecycle",
    operation: "check",
    params: { taskId: "T2926", targetStage: "implementation" }
  });
  
  // Complete missing prerequisites
  for (const prereq of check.data.missingPrerequisites) {
    await cleo_mutate({
      domain: "lifecycle",
      operation: "progress",
      params: { taskId: "T2926", stage: prereq }
    });
  }
}
```

---

## Next Steps

- **Read Operations**: [cleo_query Gateway](cleo_query.md)
- **Domain Reference**: [Tasks](../domains/tasks.md) | [Session](../domains/session.md) | [Orchestrate](../domains/orchestrate.md)
- **Examples**: [Task Management](../../examples/task-management.md)
- **Error Reference**: [Error Codes](../errors.md)
