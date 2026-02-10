# API Overview

**Version**: 1.0.0

---

## Introduction

The CLEO MCP Server API uses a **two-gateway design** based on CQRS (Command Query Responsibility Segregation) principles. This architecture separates read operations (`cleo_query`) from write operations (`cleo_mutate`) for safety, performance, and permission control.

---

## Gateway Design

### Two-Gateway Architecture

```
┌─────────────────────────────────────────┐
│           MCP TOOL LAYER                │
│                                         │
│  ┌──────────────────┐  ┌──────────────┐ │
│  │   cleo_query     │  │ cleo_mutate  │ │
│  │ (48 operations)  │  │(48 operations)│ │
│  │                  │  │              │ │
│  │ • Idempotent     │  │ • Validated  │ │
│  │ • Cacheable      │  │ • Logged     │ │
│  │ • Read-only      │  │ • Atomic     │ │
│  └──────────────────┘  └──────────────┘ │
└─────────────────────────────────────────┘
```

### cleo_query - Read Operations

**Purpose**: All read-only operations for discovery, status, analysis, and validation checks.

**Characteristics**:
- **MUST NOT** modify any state
- Results **MAY** be cached
- Safe to retry without side effects
- Can be granted as read-only access

**Use Cases**:
- Task discovery and search
- Status checks
- Dependency analysis
- Compliance reporting
- Health monitoring

### cleo_mutate - Write Operations

**Purpose**: All state-modifying operations for task management, orchestration, and system changes.

**Characteristics**:
- **MUST** be idempotent where possible
- **MUST** validate before committing
- **MUST** log to audit trail
- Requires appropriate permissions

**Use Cases**:
- Creating and updating tasks
- Managing sessions
- Spawning agents
- Progressing lifecycle stages
- Executing releases

---

## Request Format

All requests follow this structure:

```typescript
interface MCPRequest {
  domain: Domain;
  operation: string;
  params?: Record<string, any>;
}

type Domain =
  | 'tasks'
  | 'session'
  | 'orchestrate'
  | 'research'
  | 'lifecycle'
  | 'validate'
  | 'release'
  | 'system';
```

### Example Requests

**Query Example**:
```json
{
  "domain": "tasks",
  "operation": "get",
  "params": {
    "taskId": "T2405"
  }
}
```

**Mutate Example**:
```json
{
  "domain": "tasks",
  "operation": "create",
  "params": {
    "title": "Implement feature X",
    "description": "Add support for feature X with comprehensive tests",
    "priority": "high"
  }
}
```

---

## Response Format

### Success Response

```json
{
  "_meta": {
    "gateway": "cleo_query|cleo_mutate",
    "domain": "tasks",
    "operation": "get",
    "version": "1.0.0",
    "timestamp": "2026-02-04T08:24:05Z",
    "duration_ms": 45
  },
  "success": true,
  "data": {
    // Operation-specific response data
  }
}
```

**Metadata Fields**:
- `gateway`: Which gateway processed the request
- `domain`: Functional domain
- `operation`: Specific operation
- `version`: API version (semantic versioning)
- `timestamp`: ISO 8601 timestamp
- `duration_ms`: Operation duration in milliseconds

### Error Response

```json
{
  "_meta": {
    "gateway": "cleo_mutate",
    "domain": "tasks",
    "operation": "create",
    "version": "1.0.0",
    "timestamp": "2026-02-04T08:24:05Z"
  },
  "success": false,
  "error": {
    "code": "E_VALIDATION_FAILED",
    "exitCode": 6,
    "message": "Title and description must be different",
    "details": {
      "field": "description",
      "value": "Same as title",
      "constraint": "must differ from title"
    },
    "fix": "Provide a unique description that differs from the title",
    "alternatives": [
      {
        "action": "Use generated description",
        "command": "cleo_mutate tasks create --title \"...\" --description \"Implementation of ...\""
      }
    ]
  }
}
```

**Error Fields**:
- `code`: Machine-readable error constant (e.g., `E_VALIDATION_FAILED`)
- `exitCode`: Numeric exit code (see [Error Codes](errors.md))
- `message`: Human-readable error message
- `details`: Additional context (field-specific)
- `fix`: Suggested fix command or action
- `alternatives`: Array of alternative approaches

### Partial Success Response

For batch operations that partially succeed:

```json
{
  "_meta": { /* ... */ },
  "success": true,
  "partial": true,
  "data": {
    "succeeded": [
      { "taskId": "T2405", "status": "completed" },
      { "taskId": "T2406", "status": "completed" }
    ],
    "failed": [
      {
        "taskId": "T2407",
        "error": {
          "code": "E_BLOCKED",
          "message": "Task has unresolved dependencies"
        }
      }
    ]
  }
}
```

---

## Domain Routing

Operations are organized into 8 functional domains:

### Domain Overview

| Domain | Purpose | Query Ops | Mutate Ops |
|--------|---------|-----------|------------|
| [tasks](domains/tasks.md) | Task management | 9 | 10 |
| [session](domains/session.md) | Session management | 5 | 7 |
| [orchestrate](domains/orchestrate.md) | Multi-agent orchestration | 7 | 5 |
| [research](domains/research.md) | Research and manifest | 6 | 4 |
| [lifecycle](domains/lifecycle.md) | RCSD-IVTR lifecycle | 5 | 5 |
| [validate](domains/validate.md) | Validation and compliance | 9 | 2 |
| [release](domains/release.md) | Release management | 0 | 7 |
| [system](domains/system.md) | System operations | 5 | 7 |

### Domain Selection Guide

**When to use each domain**:

- **tasks**: Creating, updating, querying, completing tasks
- **session**: Managing work sessions and focus
- **orchestrate**: Multi-agent coordination, spawning, dependency analysis
- **research**: Research workflows, manifest management
- **lifecycle**: RCSD-IVTR stage progression and gate checking
- **validate**: Protocol compliance, schema validation, testing
- **release**: Version management, changelog, git tagging
- **system**: Configuration, initialization, health checks

---

## Operation Naming Conventions

Operations follow consistent patterns:

### CRUD Operations

| Pattern | Example | Description |
|---------|---------|-------------|
| `get` | `tasks.get` | Retrieve single resource by ID |
| `list` | `tasks.list` | Retrieve multiple resources with filters |
| `create` | `tasks.create` | Create new resource |
| `update` | `tasks.update` | Modify existing resource |
| `delete` | `tasks.delete` | Remove resource |

### Query Operations

| Pattern | Example | Description |
|---------|---------|-------------|
| `find` | `tasks.find` | Fuzzy search |
| `exists` | `tasks.exists` | Check existence |
| `analyze` | `tasks.analyze` | Perform analysis |
| `stats` | `research.stats` | Aggregate statistics |

### State Operations

| Pattern | Example | Description |
|---------|---------|-------------|
| `start` | `session.start` | Begin process |
| `end` | `session.end` | Complete process |
| `resume` | `session.resume` | Restart suspended process |
| `suspend` | `session.suspend` | Pause process |

### Hierarchical Operations

| Pattern | Example | Description |
|---------|---------|-------------|
| `focus.get` | `session.focus.get` | Retrieve nested resource |
| `focus.set` | `session.focus.set` | Update nested resource |
| `manifest.read` | `research.manifest.read` | Read nested collection |
| `compliance.record` | `validate.compliance.record` | Record nested data |

---

## Parameters

### Common Parameters

Many operations support common parameters:

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `taskId` | string | Task identifier | `"T2405"` |
| `epicId` | string | Epic identifier | `"T2400"` |
| `status` | enum | Task status | `"pending"`, `"active"`, `"done"` |
| `limit` | number | Result limit | `10` |
| `offset` | number | Pagination offset | `0` |

### Parameter Validation

All parameters are validated:

- **Type checking**: Ensures correct types
- **Range validation**: Numeric limits enforced
- **Enum validation**: Only allowed values accepted
- **Format validation**: Patterns for IDs, dates, etc.
- **Required checks**: Missing required parameters rejected

---

## Pagination

Large result sets support pagination:

```typescript
// Page 1 (first 10)
cleo_query({
  domain: "tasks",
  operation: "list",
  params: { limit: 10, offset: 0 }
})

// Page 2 (next 10)
cleo_query({
  domain: "tasks",
  operation: "list",
  params: { limit: 10, offset: 10 }
})
```

**Response includes pagination metadata**:
```json
{
  "_meta": { /* ... */ },
  "success": true,
  "data": {
    "tasks": [ /* ... */ ],
    "pagination": {
      "limit": 10,
      "offset": 0,
      "total": 42,
      "hasMore": true
    }
  }
}
```

---

## Filtering

Many operations support filtering:

```typescript
// Filter by status
cleo_query({
  domain: "tasks",
  operation: "list",
  params: { status: "pending" }
})

// Filter by parent
cleo_query({
  domain: "tasks",
  operation: "list",
  params: { parent: "T2400" }
})

// Multiple filters
cleo_query({
  domain: "tasks",
  operation: "list",
  params: {
    status: "active",
    parent: "T2400",
    priority: "high"
  }
})
```

---

## Idempotency

### Query Operations

All `cleo_query` operations are **naturally idempotent** - calling the same query multiple times returns the same result (state permitting).

### Mutate Operations

`cleo_mutate` operations implement idempotency where possible:

| Operation | Idempotency Strategy |
|-----------|---------------------|
| `tasks.create` | Duplicate detection (title + description) |
| `tasks.update` | Last write wins (with validation) |
| `tasks.complete` | Idempotent (already done = success) |
| `session.start` | Scope-based deduplication |
| `lifecycle.progress` | Stage-based deduplication |

**Non-idempotent operations** (use caution):
- `tasks.delete` - Repeat deletes fail with `E_NOT_FOUND`
- `release.commit` - Creates new git commit each time
- `release.tag` - Fails if tag already exists

---

## Caching

### Cacheable Operations

All `cleo_query` operations are **cacheable**:

```typescript
// Cache configuration example
const cacheConfig = {
  queryCache: true,
  queryCacheTtl: 30000,  // 30 seconds
};
```

**Cache keys** include:
- Gateway name
- Domain
- Operation
- Serialized parameters

**Cache invalidation**:
- Automatic on relevant `cleo_mutate` operations
- Manual via `system.cleanup` operation
- Time-based expiration (TTL)

### Non-Cacheable Operations

All `cleo_mutate` operations are **never cached**.

---

## Rate Limiting

Recommended rate limits by operation type:

| Operation Type | Limit | Window |
|----------------|-------|--------|
| Query operations | 100 | 1 minute |
| Mutate operations | 30 | 1 minute |
| Spawn operations | 10 | 1 minute |
| Validation operations | 50 | 1 minute |

**Rate limit exceeded response**:
```json
{
  "_meta": { /* ... */ },
  "success": false,
  "error": {
    "code": "E_RATE_LIMIT_EXCEEDED",
    "exitCode": 7,
    "message": "Rate limit exceeded: 100 requests per minute",
    "retryAfter": 45
  }
}
```

---

## Versioning

The API uses **semantic versioning**:

```
MAJOR.MINOR.PATCH
1.0.0
```

- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes (backward compatible)

**Version negotiation**:
```json
{
  "_meta": {
    "version": "1.0.0",
    "minVersion": "1.0.0",
    "maxVersion": "1.9.0"
  }
}
```

---

## Next Steps

- **Gateway Reference**: [cleo_query](gateways/cleo_query.md) | [cleo_mutate](gateways/cleo_mutate.md)
- **Domain Reference**: [tasks](domains/tasks.md) | [session](domains/session.md) | [orchestrate](domains/orchestrate.md)
- **Error Handling**: [Error Codes](errors.md)
- **Examples**: [Task Management](../examples/task-management.md)
