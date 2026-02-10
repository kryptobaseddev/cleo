# cleo_query Gateway

**Type**: Read Operations
**Operations**: 48 across 7 domains (46 spec + 2 system job ops)

---

## Overview

The `cleo_query` gateway provides read-only access to CLEO's state and analysis capabilities. All operations are **idempotent** and **cacheable** with no side effects.

### Characteristics

- **MUST NOT** modify any state
- Results **MAY** be cached
- Safe to retry without side effects
- Can be granted as read-only access
- All operations return within <500ms (typical <100ms)

### Use Cases

- Task discovery and search
- Status monitoring
- Dependency analysis
- Compliance reporting
- Health checks
- Context budget tracking

---

## Tool Schema

```json
{
  "name": "cleo_query",
  "description": "CLEO read operations: task discovery, status checks, analysis, validation, and compliance metrics. Never modifies state.",
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
          "system"
        ],
        "description": "Functional domain to query"
      },
      "operation": {
        "type": "string",
        "description": "Domain-specific read operation"
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

### tasks (9 operations)

Task discovery, analysis, and relationship queries.

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| [get](#tasksget) | Get single task details | `taskId` | Full task object |
| [list](#taskslist) | List tasks with filters | `parent?`, `status?`, `limit?` | Task array |
| [find](#tasksfind) | Fuzzy search tasks | `query`, `limit?` | Minimal task array |
| [exists](#tasksexists) | Check task existence | `taskId` | Boolean |
| [tree](#taskstree) | Hierarchical task view | `rootId?`, `depth?` | Tree structure |
| [blockers](#tasksblockers) | Get blocking tasks | `taskId` | Blocker array |
| [deps](#tasksdeps) | Get dependencies | `taskId`, `direction?` | Dependency graph |
| [analyze](#tasksanalyze) | Triage analysis | `epicId?` | Priority recommendations |
| [next](#tasksnext) | Next task suggestion | `epicId?`, `count?` | Suggested tasks |

### session (5 operations)

Session status and history queries.

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| [status](#sessionstatus) | Current session status | - | Session object |
| [list](#sessionlist) | List all sessions | `active?` | Session array |
| [show](#sessionshow) | Session details | `sessionId` | Full session object |
| [focus.get](#sessionfocusget) | Get focused task | - | Task ID or null |
| [history](#sessionhistory) | Session history | `limit?` | History array |

### orchestrate (7 operations)

Multi-agent coordination and context management.

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| [status](#orchestratestatus) | Orchestrator status | `epicId` | Orchestration state |
| [next](#orchestratenext) | Next task to spawn | `epicId` | Task + skill recommendation |
| [ready](#orchestrateready) | Parallel-safe tasks | `epicId` | Task IDs in current wave |
| [analyze](#orchestrateanalyze) | Dependency analysis | `epicId` | Wave structure + critical path |
| [context](#orchestratecontext) | Context usage check | `tokens?` | Context budget status |
| [waves](#orchestratewaves) | Wave computation | `epicId` | Parallel execution waves |
| [skill.list](#orchestrateskilllist) | Available skills | `filter?` | Skill definitions |

### research (6 operations)

Research entry and manifest queries.

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| [show](#researchshow) | Research entry details | `researchId` | Full entry |
| [list](#researchlist) | List research entries | `epicId?`, `status?` | Entry array |
| [query](#researchquery) | Search research | `query`, `confidence?` | Matched entries |
| [pending](#researchpending) | Pending research | `epicId?` | Entries needing follow-up |
| [stats](#researchstats) | Research statistics | `epicId?` | Aggregated metrics |
| [manifest.read](#researchmanifestread) | Read manifest entries | `filter?`, `limit?` | JSONL entries |

### lifecycle (5 operations)

RCSD-IVTR lifecycle stage and gate queries.

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| [check](#lifecyclecheck) | Check stage prerequisites | `taskId`, `targetStage` | Gate status |
| [status](#lifecyclestatus) | Current lifecycle state | `taskId` or `epicId` | Stage progression |
| [history](#lifecyclehistory) | Stage transition history | `taskId` | Transition log |
| [gates](#lifecyclegates) | All gate statuses | `taskId` | Gate status array |
| [prerequisites](#lifecycleprerequisites) | Required prior stages | `targetStage` | Prerequisite list |

### validate (9 operations)

Validation, compliance, and testing queries.

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| [schema](#validateschema) | JSON Schema validation | `fileType`, `filePath?` | Validation result |
| [protocol](#validateprotocol) | Protocol compliance | `taskId`, `protocolType` | Violations + score |
| [task](#validatetask) | Anti-hallucination check | `taskId`, `checkMode` | Rule violations |
| [manifest](#validatemanifest) | Manifest entry check | `entry` or `taskId` | Integrity status |
| [output](#validateoutput) | Output file validation | `taskId`, `filePath` | Content validation |
| [compliance.summary](#validatecompliancesummary) | Aggregated compliance | `scope?`, `since?` | Summary metrics |
| [compliance.violations](#validatecomplianceviolations) | List violations | `severity?`, `protocol?` | Violation array |
| [test.status](#validateteststatus) | Test suite status | `taskId?` | Pass/fail counts |
| [test.coverage](#validatetestcoverage) | Coverage metrics | `taskId?` | Coverage percentages |

### system (5 operations)

System information and health checks.

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| [version](#systemversion) | CLEO version | - | Version string |
| [doctor](#systemdoctor) | Health check | - | Health status |
| [config.get](#systemconfigget) | Get config value | `key` | Config value |
| [stats](#systemstats) | Project statistics | - | Task/session stats |
| [context](#systemcontext) | Context window info | - | Token usage |

---

## Detailed Operation Reference

### tasks.get

Get detailed information about a specific task.

**Parameters**:
- `taskId` (string, required) - Task ID (e.g., "T2908")

**Returns**:
```json
{
  "success": true,
  "data": {
    "task": {
      "id": "T2908",
      "title": "CLEO MCP Server Implementation",
      "description": "Create MCP server...",
      "status": "active",
      "priority": "high",
      "created": "2026-01-31T18:00:00Z",
      "updated": "2026-02-04T08:24:05Z",
      "parent": "T2900",
      "depends": ["T2905", "T2906"],
      "labels": ["mcp", "server"],
      "notes": []
    }
  }
}
```

**Example**:
```typescript
const result = await cleo_query({
  domain: "tasks",
  operation: "get",
  params: { taskId: "T2908" }
});
```

**Errors**:
- `E_NOT_FOUND` (4) - Task does not exist
- `E_INVALID_INPUT` (2) - Invalid task ID format

**See Also**: [tasks.exists](#tasksexists), [tasks.list](#taskslist)

---

### tasks.list

List tasks with optional filtering.

**Parameters**:
- `parent` (string, optional) - Filter by parent task ID
- `status` (enum, optional) - Filter by status: `pending`, `active`, `blocked`, `done`
- `priority` (enum, optional) - Filter by priority: `low`, `medium`, `high`
- `limit` (number, optional) - Maximum results (default: 50, max: 200)
- `offset` (number, optional) - Pagination offset (default: 0)

**Returns**:
```json
{
  "success": true,
  "data": {
    "tasks": [
      { "id": "T2908", "title": "...", "status": "active" },
      { "id": "T2909", "title": "...", "status": "pending" }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 127,
      "hasMore": true
    }
  }
}
```

**Example**:
```typescript
// List all pending tasks
const result = await cleo_query({
  domain: "tasks",
  operation: "list",
  params: { status: "pending" }
});

// List children of epic
const children = await cleo_query({
  domain: "tasks",
  operation: "list",
  params: { parent: "T2900" }
});
```

**Errors**:
- `E_INVALID_INPUT` (2) - Invalid filter parameters

**See Also**: [tasks.find](#tasksfind), [tasks.tree](#taskstree)

---

### tasks.find

Fuzzy search tasks by title, description, or labels. Returns minimal fields for context efficiency (99% less than `list`).

**Parameters**:
- `query` (string, required) - Search query
- `limit` (number, optional) - Maximum results (default: 10, max: 50)

**Returns**:
```json
{
  "success": true,
  "data": {
    "tasks": [
      {
        "id": "T2908",
        "title": "CLEO MCP Server Implementation",
        "status": "active",
        "score": 0.95
      }
    ]
  }
}
```

**Example**:
```typescript
const result = await cleo_query({
  domain: "tasks",
  operation: "find",
  params: { query: "mcp server" }
});
```

**Errors**:
- `E_INVALID_INPUT` (2) - Empty query string

**See Also**: [tasks.list](#taskslist), [tasks.get](#tasksget)

---

### tasks.exists

Check if a task exists (by ID or exact ID match).

**Parameters**:
- `taskId` (string, required) - Task ID to check

**Returns**:
```json
{
  "success": true,
  "data": {
    "exists": true,
    "taskId": "T2908"
  }
}
```

**Example**:
```typescript
const result = await cleo_query({
  domain: "tasks",
  operation: "exists",
  params: { taskId: "T2908" }
});

if (result.data.exists) {
  // Task exists
}
```

**Errors**: None (returns `exists: false` for missing tasks)

**See Also**: [tasks.get](#tasksget)

---

### session.status

Get current session status.

**Parameters**: None

**Returns**:
```json
{
  "success": true,
  "data": {
    "session": {
      "id": "session_20260203_223119_d64440",
      "name": "CLEO MCP Server",
      "scope": "epic:T2908",
      "status": "active",
      "focusedTask": "T2924",
      "startTime": "2026-02-03T22:31:19Z",
      "duration": 35046
    }
  }
}
```

**Example**:
```typescript
const result = await cleo_query({
  domain: "session",
  operation: "status"
});
```

**Errors**:
- `E_SESSION_DISCOVERY` (100) - No active session (not an error, discovery mode)

**See Also**: [session.list](#sessionlist), [session.show](#sessionshow)

---

## Performance Guidelines

### Response Times

| Operation Type | Typical | Maximum |
|----------------|---------|---------|
| Simple get/exists | <50ms | 100ms |
| List with filters | <100ms | 200ms |
| Complex analysis | <200ms | 500ms |
| Validation checks | <100ms | 300ms |

### Caching Strategy

```typescript
// Cache configuration
const config = {
  queryCache: true,
  queryCacheTtl: 30000,  // 30 seconds
  cacheKeys: ['domain', 'operation', 'params']
};

// Cache automatically invalidated on related mutate operations
```

### Rate Limits

- **Query operations**: 100 requests per minute
- **Burst allowance**: 20 requests in 10 seconds
- **Concurrent requests**: Max 10 simultaneous

---

## Security

### Read-Only Guarantee

All `cleo_query` operations are guaranteed to be read-only. The gateway enforces:

1. **CLI wrapper**: Only calls commands with `--dry-run` or no write operations
2. **File system**: No write operations performed
3. **Audit trail**: Query operations not logged (no audit bloat)
4. **Permissions**: Can be granted without write access

### Access Control

Grant read-only access by exposing only `cleo_query`:

```json
{
  "mcpServers": {
    "cleo-readonly": {
      "tools": ["cleo_query"]
    }
  }
}
```

---

## Next Steps

- **Write Operations**: [cleo_mutate Gateway](cleo_mutate.md)
- **Domain Reference**: [Tasks](../domains/tasks.md) | [Session](../domains/session.md) | [Orchestrate](../domains/orchestrate.md)
- **Examples**: [Task Management](../../examples/task-management.md)
