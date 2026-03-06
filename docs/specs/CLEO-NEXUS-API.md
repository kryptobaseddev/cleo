# CLEO-NEXUS API Specification

**Version**: 1.0.0  
**Status**: Canonical Specification  
**Date**: 2026-03-05  
**Epic**: T4284 (CLEO Nexus Command Center WebUI), T4820 (BRAIN Network / NEXUS)  
**Base Specification**: [CLEO-API.md](./CLEO-API.md)  
**Related**: CLEO-WEB-API.md (HTTP adapter), LAFS Protocol v1.0.0  

---

## 1. Overview

The **CLEO-NEXUS API** is the cross-project coordination interface for the CLEO ecosystem. It enables agent-to-agent (A2A) communication, multi-project task discovery, dependency analysis, and distributed work coordination across registered CLEO projects.

### Purpose

This specification defines the canonical API contract for:

1. **Cross-project task discovery** — Find related work across project boundaries
2. **Global dependency graph** — Track dependencies spanning multiple repositories
3. **Agent-to-agent communication** — A2A-compliant message exchange
4. **Project registry management** — Register, sync, and manage multi-project configurations
5. **Distributed coordination** — Critical path analysis, blocking detection, orphan resolution

### A2A Compliance

NEXUS API is fully compliant with the **Agent-to-Agent (A2A)** protocol standards:

- **LAFS Envelope** — All responses use LAFS (LLM-Agent-First Specification) envelope format
- **Capability Discovery** — Agents can query available operations via `nexus.status`
- **Structured Communication** — Type-safe, schema-validated request/response cycles
- **Context Preservation** — Cross-project correlation IDs for distributed tracing

---

## 2. Architecture

### 2.1 System Context

```
┌─────────────────────────────────────────────────────────────┐
│                     EXTERNAL SYSTEMS                        │
│  (Other Agents, Web UIs, CLI Tools, IDE Plugins)           │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP / MCP / CLI
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                  CLEO DISPATCH LAYER                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   MCP GW     │  │  HTTP GW     │  │   CLI GW     │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
└─────────┼─────────────────┼─────────────────┼──────────────┘
          │                 │                 │
          └─────────────────┼─────────────────┘
                            ▼
               ┌──────────────────────┐
               │     DISPATCHER       │
               │  (CQRS Pipeline)     │
               └──────────┬───────────┘
                          │
                          ▼
               ┌──────────────────────┐
               │   NEXUS HANDLER      │
               │  src/dispatch/       │
               │   domains/nexus.ts   │
               └──────────┬───────────┘
                          │
                          ▼
               ┌──────────────────────┐
               │   NEXUS CORE         │
               │  src/core/nexus/     │
               └──────────┬───────────┘
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
    ┌──────────────────┐   ┌──────────────────┐
    │   nexus.db       │   │  Project tasks.db │
    │  (Global Reg)    │   │  (Per-project)    │
    └──────────────────┘   └──────────────────┘
```

### 2.2 LAFS Protocol Integration

NEXUS API uses the **LAFS Protocol** (LLM-Agent-First Specification) for all communication:

**LAFS Envelope Structure**:

```json
{
  "$schema": "https://cleo.dev/schemas/v1/nexus-envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-03-05T00:00:00Z",
    "operation": "nexus.query",
    "requestId": "req_abc123",
    "sessionId": "sess_xyz789",
    "transport": "http",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 1,
    "gateway": "query",
    "domain": "nexus",
    "durationMs": 42,
    "exitCode": 0
  },
  "success": true,
  "result": { /* operation-specific data */ },
  "error": null,
  "page": null
}
```

**Envelope Invariants**:

| Field | Required | Description |
|-------|----------|-------------|
| `$schema` | Yes | Schema URI for validation |
| `_meta` | Yes | Metadata object with operation context |
| `success` | Yes | Boolean indicating operation success |
| `result` | Conditional | Present when `success=true` |
| `error` | Conditional | Present when `success=false` |
| `page` | Optional | Pagination info for list operations |

---

## 3. Transport Adapters

NEXUS API is transport-agnostic. The same operations are available via:

| Transport | Entry Point | Envelope Mode | Best For |
|-----------|-------------|---------------|----------|
| **MCP** | `query` / `mutate` tools | Full envelope in body | AI agents, Claude Code |
| **HTTP** | `POST /api/query` / `POST /api/mutate` | Headers + body (default) | Web UIs, external systems |
| **CLI** | `cleo nexus <command>` | No envelope (formatted output) | Human users, scripts |

### 3.1 MCP Transport

```json
// Request
{
  "gateway": "query",
  "domain": "nexus",
  "operation": "status",
  "params": {}
}

// Response (full LAFS envelope)
{
  "_meta": { /* ... */ },
  "success": true,
  "result": { "initialized": true, "projectCount": 5 }
}
```

### 3.2 HTTP Transport

**Default Mode** (unwrapped body + headers):

```http
POST /api/query
Content-Type: application/json

{
  "domain": "nexus",
  "operation": "status",
  "params": {}
}
```

Response:
```http
HTTP/1.1 200 OK
X-Cleo-Request-Id: req_abc123
X-Cleo-Domain: nexus
X-Cleo-Operation: status
X-Cleo-Exit-Code: 0
Content-Type: application/json

{ "initialized": true, "projectCount": 5 }
```

**LAFS Mode** (full envelope):

```http
POST /api/query
Content-Type: application/json
Accept: application/vnd.lafs+json

{ /* same request */ }
```

Response:
```http
HTTP/1.1 200 OK
Content-Type: application/vnd.lafs+json

{ "_meta": { /* ... */ }, "success": true, "result": { /* ... */ } }
```

### 3.3 CLI Transport

```bash
# Query
$ cleo nexus status --format json
{ "initialized": true, "projectCount": 5 }

# Exit code reflects operation success
$ echo $?  # 0 on success, non-zero on error
```

---

## 4. Operations Reference

All 24 NEXUS operations are organized by functional area:

### 4.1 Registry Operations

Manage the global project registry stored in `~/.cleo/nexus.db`.

#### `nexus.init` (mutate)

Initialize NEXUS, creating the global registry and required directories.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "init",
  "params": {}
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.init", "exitCode": 0 },
  "success": true,
  "result": {
    "message": "NEXUS initialized successfully",
    "registryPath": "~/.cleo/nexus.db",
    "created": true
  }
}
```

**Exit Codes**:
- `0` — Success
- `76` — Registry corrupt (requires manual cleanup)

---

#### `nexus.status` (query)

Get overall NEXUS health and registry status.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "status",
  "params": {}
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.status", "exitCode": 0 },
  "success": true,
  "result": {
    "initialized": true,
    "projectCount": 5,
    "lastUpdated": "2026-03-05T10:30:00Z",
    "version": "1.0.0"
  }
}
```

**Exit Codes**:
- `0` — Success
- `71` — Nexus not initialized (call `nexus.init` first)

---

#### `nexus.register` (mutate)

Register a project in the NEXUS global registry.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "register",
  "params": {
    "path": "/home/user/projects/my-app",
    "name": "my-app",
    "permission": "read"
  }
}
```

**Parameters**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Absolute path to project root |
| `name` | string | No | Human-readable name (defaults to directory name) |
| `permission` | enum | No | `read` (default), `write`, or `execute` |

**Response**:
```json
{
  "_meta": { "operation": "nexus.register", "exitCode": 0 },
  "success": true,
  "result": {
    "hash": "a1b2c3d4e5f6",
    "message": "Project registered with hash: a1b2c3d4e5f6"
  }
}
```

**Exit Codes**:
- `0` — Success
- `2` — Invalid input (missing path)
- `77` — Project already registered

---

#### `nexus.unregister` (mutate)

Remove a project from the NEXUS registry.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "unregister",
  "params": {
    "name": "my-app"
  }
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.unregister", "exitCode": 0 },
  "success": true,
  "result": {
    "message": "Project unregistered: my-app"
  }
}
```

**Exit Codes**:
- `0` — Success
- `2` — Invalid input (missing name)
- `72` — Project not found in registry

---

#### `nexus.list` (query)

List all registered projects.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "list",
  "params": {}
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.list", "exitCode": 0 },
  "success": true,
  "result": {
    "projects": [
      {
        "hash": "a1b2c3d4e5f6",
        "path": "/home/user/projects/my-app",
        "name": "my-app",
        "permissions": "read",
        "taskCount": 42,
        "labels": ["backend", "api"],
        "registeredAt": "2026-03-01T10:00:00Z",
        "lastSeen": "2026-03-05T10:30:00Z",
        "lastSync": "2026-03-05T10:30:00Z",
        "healthStatus": "healthy"
      }
    ],
    "count": 5
  }
}
```

---

#### `nexus.show` (query)

Show details for a specific project.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "show",
  "params": {
    "name": "my-app"
  }
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.show", "exitCode": 0 },
  "success": true,
  "result": {
    "hash": "a1b2c3d4e5f6",
    "path": "/home/user/projects/my-app",
    "name": "my-app",
    "permissions": "read",
    "taskCount": 42,
    "labels": ["backend", "api"],
    "registeredAt": "2026-03-01T10:00:00Z",
    "lastSeen": "2026-03-05T10:30:00Z",
    "lastSync": "2026-03-05T10:30:00Z",
    "healthStatus": "healthy"
  }
}
```

**Exit Codes**:
- `0` — Success
- `2` — Invalid input (missing name)
- `72` — Project not found

---

#### `nexus.sync` (mutate)

Sync project metadata (task count, labels) from a registered project.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "sync",
  "params": {
    "name": "my-app"
  }
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.sync", "exitCode": 0 },
  "success": true,
  "result": {
    "message": "Project synced: my-app",
    "taskCount": 42,
    "labels": ["backend", "api"],
    "syncedAt": "2026-03-05T10:30:00Z"
  }
}
```

---

#### `nexus.sync.all` (mutate)

Sync metadata for all registered projects.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "sync.all",
  "params": {}
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.sync.all", "exitCode": 0 },
  "success": true,
  "result": {
    "synced": 5,
    "failed": 0,
    "results": [
      { "name": "my-app", "success": true, "taskCount": 42 },
      { "name": "other-project", "success": true, "taskCount": 15 }
    ]
  }
}
```

---

#### `nexus.permission.set` (mutate)

Update permissions for a registered project.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "permission.set",
  "params": {
    "name": "my-app",
    "level": "write"
  }
}
```

**Parameters**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | Yes | Project name |
| `level` | enum | Yes | `read`, `write`, or `execute` |

**Response**:
```json
{
  "_meta": { "operation": "nexus.permission.set", "exitCode": 0 },
  "success": true,
  "result": {
    "message": "Permission for 'my-app' set to 'write'",
    "previousLevel": "read",
    "newLevel": "write"
  }
}
```

**Exit Codes**:
- `0` — Success
- `2` — Invalid input
- `73` — Permission denied (attempting to elevate beyond own permissions)

---

#### `nexus.reconcile` (mutate)

Reconcile project identity with global NEXUS registry (auto-detect and sync).

**Request**:
```json
{
  "domain": "nexus",
  "operation": "reconcile",
  "params": {
    "projectRoot": "/home/user/projects/my-app"
  }
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.reconcile", "exitCode": 0 },
  "success": true,
  "result": {
    "action": "registered",
    "project": {
      "hash": "a1b2c3d4e5f6",
      "name": "my-app",
      "path": "/home/user/projects/my-app"
    }
  }
}
```

---

### 4.2 Query Operations

Cross-project task resolution and discovery.

#### `nexus.query` (query)

Resolve a cross-project `project:taskId` query.

**Query Syntax**:

| Syntax | Meaning |
|--------|---------|
| `my-app:T001` | Task T001 in project "my-app" |
| `.:T001` | Task T001 in current project |
| `*:T001` | Search T001 across all projects (wildcard) |
| `T001` | Implicit current project |

**Request**:
```json
{
  "domain": "nexus",
  "operation": "query",
  "params": {
    "query": "my-app:T001",
    "currentProject": "."
  }
}
```

**Response (single task)**:
```json
{
  "_meta": { "operation": "nexus.query", "exitCode": 0 },
  "success": true,
  "result": {
    "id": "T001",
    "title": "Implement login flow",
    "status": "active",
    "priority": "high",
    "description": "Add OAuth2 authentication",
    "_project": "my-app",
    "_projectPath": "/home/user/projects/my-app"
  }
}
```

**Response (wildcard - multiple tasks)**:
```json
{
  "_meta": { "operation": "nexus.query", "exitCode": 0 },
  "success": true,
  "result": [
    { "id": "T001", "title": "Task in project A", "_project": "project-a" },
    { "id": "T001", "title": "Task in project B", "_project": "project-b" }
  ]
}
```

**Exit Codes**:
- `0` — Success
- `2` — Invalid syntax
- `72` — Project not found
- `4` — Task not found

---

#### `nexus.search` (query)

Search for patterns across all registered projects.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "search",
  "params": {
    "pattern": "authentication",
    "project": "my-app",
    "limit": 20
  }
}
```

**Parameters**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pattern` | string | Yes | Search pattern (supports wildcards with `*`) |
| `project` | string | No | Filter to specific project |
| `limit` | number | No | Max results (default: 20) |

**Response**:
```json
{
  "_meta": { "operation": "nexus.search", "exitCode": 0 },
  "success": true,
  "result": {
    "pattern": "authentication",
    "resultCount": 3,
    "results": [
      {
        "id": "T001",
        "title": "Implement OAuth2 authentication",
        "status": "active",
        "priority": "high",
        "description": "Add OAuth2 login flow",
        "_project": "my-app"
      }
    ]
  }
}
```

---

#### `nexus.discover` (query)

Discover related tasks across registered projects using similarity algorithms.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "discover",
  "params": {
    "query": "my-app:T001",
    "method": "auto",
    "limit": 10
  }
}
```

**Parameters**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Source task (e.g., `my-app:T001`) |
| `method` | enum | No | `labels`, `description`, `hierarchy`, or `auto` (default) |
| `limit` | number | No | Max results (default: 10) |

**Response**:
```json
{
  "_meta": { "operation": "nexus.discover", "exitCode": 0 },
  "success": true,
  "result": {
    "query": "my-app:T001",
    "method": "auto",
    "total": 5,
    "results": [
      {
        "project": "other-project",
        "taskId": "T015",
        "title": "Related authentication work",
        "score": 0.85,
        "type": "labels",
        "reason": "Shared labels: authentication, oauth"
      }
    ]
  }
}
```

---

### 4.3 Dependency Operations

Cross-project dependency graph analysis.

#### `nexus.deps` (query)

Analyze cross-project dependencies for a task.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "deps",
  "params": {
    "query": "my-app:T001",
    "direction": "forward"
  }
}
```

**Parameters**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Task to analyze (e.g., `my-app:T001`) |
| `direction` | enum | No | `forward` (default) or `reverse` |

**Response**:
```json
{
  "_meta": { "operation": "nexus.deps", "exitCode": 0 },
  "success": true,
  "result": {
    "query": "my-app:T001",
    "direction": "forward",
    "dependencies": [
      {
        "taskId": "backend:T015",
        "project": "backend",
        "title": "API authentication endpoint",
        "status": "done"
      }
    ],
    "blockedBy": ["backend:T015"],
    "blocks": ["frontend:T042"]
  }
}
```

---

#### `nexus.graph` (query)

Get the global dependency graph across all registered projects.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "graph",
  "params": {}
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.graph", "exitCode": 0 },
  "success": true,
  "result": {
    "nodes": [
      { "id": "T001", "project": "my-app", "status": "active", "title": "Task 1" },
      { "id": "T015", "project": "backend", "status": "done", "title": "API auth" }
    ],
    "edges": [
      { "from": "T001", "fromProject": "my-app", "to": "T015", "toProject": "backend" }
    ],
    "cacheChecksum": "abc123def456"
  }
}
```

---

#### `nexus.path.show` / `nexus.critical-path` (query)

Show the critical dependency path across all projects.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "path.show",
  "params": {}
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.path.show", "exitCode": 0 },
  "success": true,
  "result": {
    "path": [
      { "id": "backend:T001", "project": "backend", "title": "Foundation", "status": "done" },
      { "id": "my-app:T001", "project": "my-app", "title": "Build on foundation", "status": "active" }
    ],
    "length": 2,
    "bottleneck": "my-app:T001"
  }
}
```

---

#### `nexus.blockers.show` / `nexus.blocking` (query)

Show blocking impact analysis for a task.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "blockers.show",
  "params": {
    "query": "backend:T015"
  }
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.blockers.show", "exitCode": 0 },
  "success": true,
  "result": {
    "query": "backend:T015",
    "blocking": [
      { "id": "frontend:T042", "project": "frontend", "title": "UI login", "status": "blocked" },
      { "id": "my-app:T001", "project": "my-app", "title": "Integration", "status": "blocked" }
    ],
    "totalBlocked": 2,
    "impactScore": 0.8
  }
}
```

---

#### `nexus.orphans.list` / `nexus.orphans` (query)

List orphaned cross-project dependencies (broken references).

**Request**:
```json
{
  "domain": "nexus",
  "operation": "orphans.list",
  "params": {}
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.orphans.list", "exitCode": 0 },
  "success": true,
  "result": {
    "orphans": [
      {
        "from": "my-app:T001",
        "fromProject": "my-app",
        "to": "old-project:T999",
        "toProject": "old-project",
        "reason": "Project 'old-project' not in registry"
      }
    ],
    "count": 1
  }
}
```

---

### 4.4 Sharing Operations

Multi-contributor collaboration features.

#### `nexus.share.status` (query)

Get sharing status for the current project.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "share.status",
  "params": {}
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.share.status", "exitCode": 0 },
  "success": true,
  "result": {
    "shared": true,
    "remoteCount": 1,
    "remotes": ["origin"],
    "lastPush": "2026-03-05T09:00:00Z",
    "lastPull": "2026-03-05T08:00:00Z"
  }
}
```

---

#### `nexus.share.remotes` (query)

List configured remotes.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "share.remotes",
  "params": {}
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.share.remotes", "exitCode": 0 },
  "success": true,
  "result": {
    "remotes": [
      { "name": "origin", "url": "git@github.com:user/repo.git" }
    ]
  }
}
```

---

#### `nexus.share.sync.status` (query)

Get sync status with a remote.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "share.sync.status",
  "params": {
    "remote": "origin"
  }
}
```

**Response**:
```json
{
  "_meta": { "operation": "share.sync.status", "exitCode": 0 },
  "success": true,
  "result": {
    "remote": "origin",
    "ahead": 2,
    "behind": 0,
    "synced": false,
    "lastSync": "2026-03-05T08:00:00Z"
  }
}
```

---

#### `nexus.share.snapshot.export` (mutate)

Export project snapshot for sharing.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "share.snapshot.export",
  "params": {
    "outputPath": "/path/to/snapshot.json"
  }
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.share.snapshot.export", "exitCode": 0 },
  "success": true,
  "result": {
    "path": "/path/to/snapshot.json",
    "taskCount": 42,
    "checksum": "sha256:abc123..."
  }
}
```

---

#### `nexus.share.snapshot.import` (mutate)

Import project snapshot.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "share.snapshot.import",
  "params": {
    "inputPath": "/path/to/snapshot.json"
  }
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.share.snapshot.import", "exitCode": 0 },
  "success": true,
  "result": {
    "imported": 42,
    "merged": 5,
    "conflicts": 0,
    "message": "Successfully imported 42 tasks"
  }
}
```

---

#### `nexus.share.sync.gitignore` (mutate)

Sync `.gitignore` for `.cleo/` directory.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "share.sync.gitignore",
  "params": {}
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.share.sync.gitignore", "exitCode": 0 },
  "success": true,
  "result": {
    "updated": true,
    "entriesAdded": [".cleo/brain/", ".cleo/logs/"],
    "message": "Added 2 entries to .gitignore"
  }
}
```

---

#### `nexus.share.remote.add` (mutate)

Add a remote for collaboration.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "share.remote.add",
  "params": {
    "url": "git@github.com:user/repo.git",
    "name": "origin"
  }
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.share.remote.add", "exitCode": 0 },
  "success": true,
  "result": {
    "name": "origin",
    "url": "git@github.com:user/repo.git"
  }
}
```

---

#### `nexus.share.remote.remove` (mutate)

Remove a remote.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "share.remote.remove",
  "params": {
    "name": "origin"
  }
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.share.remote.remove", "exitCode": 0 },
  "success": true,
  "result": {
    "name": "origin",
    "removed": true
  }
}
```

---

#### `nexus.share.push` (mutate)

Push `.cleo/` data to remote.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "share.push",
  "params": {
    "remote": "origin",
    "force": false,
    "setUpstream": true
  }
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.share.push", "exitCode": 0 },
  "success": true,
  "result": {
    "remote": "origin",
    "pushed": true,
    "commits": 3,
    "branch": "cleo-sync"
  }
}
```

---

#### `nexus.share.pull` (mutate)

Pull `.cleo/` data from remote.

**Request**:
```json
{
  "domain": "nexus",
  "operation": "share.pull",
  "params": {
    "remote": "origin"
  }
}
```

**Response**:
```json
{
  "_meta": { "operation": "nexus.share.pull", "exitCode": 0 },
  "success": true,
  "result": {
    "remote": "origin",
    "pulled": true,
    "commits": 2,
    "merged": true
  }
}
```

---

## 5. Error Handling

### 5.1 NEXUS-Specific Exit Codes (70-79)

| Code | Name | Description |
|------|------|-------------|
| `71` | `NEXUS_NOT_INITIALIZED` | Nexus not set up (run `nexus.init` first) |
| `72` | `NEXUS_PROJECT_NOT_FOUND` | Project not in registry |
| `73` | `NEXUS_PERMISSION_DENIED` | Insufficient permissions for operation |
| `74` | `NEXUS_INVALID_SYNTAX` | Bad query format (e.g., invalid `project:taskId`) |
| `75` | `NEXUS_SYNC_FAILED` | Metadata sync failed |
| `76` | `NEXUS_REGISTRY_CORRUPT` | Registry file corrupt |
| `77` | `NEXUS_PROJECT_EXISTS` | Project already registered |
| `78` | `NEXUS_QUERY_FAILED` | Query execution failed |
| `79` | `NEXUS_GRAPH_ERROR` | Graph operation failed |

### 5.2 Error Response Format

```json
{
  "_meta": {
    "operation": "nexus.register",
    "requestId": "req_abc123",
    "exitCode": 77,
    "durationMs": 15
  },
  "success": false,
  "error": {
    "code": "E_NEXUS_PROJECT_EXISTS",
    "message": "Project 'my-app' is already registered",
    "details": {
      "existingProject": {
        "hash": "a1b2c3d4e5f6",
        "path": "/home/user/projects/my-app",
        "registeredAt": "2026-03-01T10:00:00Z"
      }
    },
    "fix": "Use 'nexus.sync' to update existing project or 'nexus.unregister' to remove it first",
    "alternatives": [
      { "operation": "nexus.sync", "params": { "name": "my-app" } },
      { "operation": "nexus.unregister", "params": { "name": "my-app" } }
    ]
  }
}
```

---

## 6. A2A (Agent-to-Agent) Compliance

### 6.1 Capability Discovery

Agents can discover NEXUS capabilities via the `nexus.status` operation:

```json
{
  "domain": "nexus",
  "operation": "status",
  "params": { "includeCapabilities": true }
}
```

Response includes:
```json
{
  "result": {
    "initialized": true,
    "capabilities": {
      "query": ["status", "list", "show", "query", "deps", "graph", "..."],
      "mutate": ["init", "register", "unregister", "sync", "..."],
      "version": "1.0.0",
      "a2aCompliant": true
    }
  }
}
```

### 6.2 Cross-Agent Correlation

All NEXUS operations support distributed tracing:

| Header/Field | Purpose |
|--------------|---------|
| `X-Cleo-Request-Id` | Unique request identifier |
| `X-Cleo-Session-Id` | Session context for multi-turn operations |
| `_meta.contextVersion` | Incrementing context version for optimistic concurrency |

### 6.3 Structured Negotiation

Agents can negotiate MVI (Minimum Verbosity Indicator) levels:

```json
{
  "domain": "nexus",
  "operation": "list",
  "params": {},
  "_mvi": "minimal"  // Response includes only essential fields
}
```

MVI Levels:
- `minimal` — ID, name, status only
- `standard` — Full project metadata (default)
- `full` — Complete project details with computed fields
- `custom` — Field selection via `_fields` array

---

## 7. Dynamic API Generation

### 7.1 From OperationRegistry

The NEXUS API contract is machine-readable via the OperationRegistry:

```typescript
// src/dispatch/registry.ts
const nexusOperations = OperationRegistry.filter(
  op => op.domain === 'nexus'
);

// Generate OpenAPI spec
const openApiSpec = generateOpenApiFromRegistry(nexusOperations);

// Generate typed client
const typedClient = generateTypedClient(nexusOperations);
```

### 7.2 Code Generation Scripts

**Generate OpenAPI Specification**:

```bash
npm run generate:openapi -- --domain nexus --output docs/specs/cleo-nexus-openapi.json
```

**Generate TypeScript Client**:

```bash
npm run generate:client -- --domain nexus --output src/clients/nexus-client.ts
```

### 7.3 Runtime Introspection

```json
// Get all supported operations at runtime
{
  "domain": "admin",
  "operation": "help",
  "params": { "domain": "nexus" }
}
```

Response:
```json
{
  "result": {
    "domain": "nexus",
    "operations": [
      { "name": "status", "gateway": "query", "description": "..." },
      { "name": "register", "gateway": "mutate", "description": "..." }
    ],
    "total": 24
  }
}
```

---

## 8. Data Models

### 8.1 Project Registry Entry

```typescript
interface NexusProject {
  hash: string;              // 12-char hex (SHA-256 of path)
  path: string;              // Absolute filesystem path
  name: string;              // Unique human-readable name
  permissions: 'read' | 'write' | 'execute';
  taskCount: number;
  labels: string[];
  registeredAt: string;      // ISO 8601
  lastSeen: string;
  lastSync: string;
  healthStatus: 'unknown' | 'healthy' | 'degraded' | 'unreachable';
  healthLastCheck?: string;
}
```

### 8.2 Cross-Project Task Reference

```typescript
interface CrossProjectTask {
  id: string;
  title: string;
  status: 'pending' | 'active' | 'blocked' | 'done';
  priority?: 'critical' | 'high' | 'medium' | 'low';
  description?: string;
  _project: string;          // Project name
  _projectPath: string;      // Project filesystem path
}
```

### 8.3 Dependency Graph

```typescript
interface NexusGraph {
  nodes: Array<{
    id: string;
    project: string;
    status: string;
    title: string;
  }>;
  edges: Array<{
    from: string;
    fromProject: string;
    to: string;
    toProject: string;
  }>;
  cacheChecksum: string;
}
```

---

## 9. Integration Examples

### 9.1 TypeScript Client Usage

```typescript
import { createCleoClient } from '@cleo/sdk';

const client = createCleoClient('http://localhost:34567');

// Register a project
await client.nexus.register({
  path: '/home/user/projects/my-app',
  name: 'my-app',
  permission: 'write'
});

// Query across projects
const task = await client.nexus.query({ query: 'backend:T001' });

// Search for related work
const related = await client.nexus.discover({
  query: 'my-app:T001',
  method: 'auto',
  limit: 10
});
```

### 9.2 Python Client Usage

```python
import requests

def nexus_query(query: str):
    response = requests.post('http://localhost:34567/api/query', json={
        'domain': 'nexus',
        'operation': 'query',
        'params': {'query': query}
    })
    return response.json()

# Find task across projects
result = nexus_query('my-app:T001')
print(result['result']['title'])
```

### 9.3 curl Examples

```bash
# Initialize nexus
curl -X POST http://localhost:34567/api/mutate \
  -H "Content-Type: application/json" \
  -d '{"domain": "nexus", "operation": "init"}'

# Register project
curl -X POST http://localhost:34567/api/mutate \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "nexus",
    "operation": "register",
    "params": {"path": "/path/to/project", "name": "my-app"}
  }'

# Query task across projects
curl -X POST http://localhost:34567/api/query \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "nexus",
    "operation": "query",
    "params": {"query": "my-app:T001"}
  }'
```

---

## 10. Security Model

### 10.1 Permission Tiers

| Level | Numeric | Capabilities |
|-------|---------|--------------|
| `read` | 1 | Query tasks, discover relationships, view graph |
| `write` | 2 | read + modify task fields, add relations |
| `execute` | 3 | write + create/delete tasks, run commands |

### 10.2 Same-Project Exception

Operations within the current project always have full permissions regardless of registry entry:

```typescript
// In /home/user/projects/my-app
const canExecute = checkPermission('my-app', 'execute');
// Returns true even if registry says 'read' only
```

### 10.3 Cross-Project Access Control

```json
// Attempting to modify project with 'read' permission
{
  "domain": "nexus",
  "operation": "share.push",
  "params": {"remote": "origin"}
}

// Response
{
  "success": false,
  "error": {
    "code": "E_NEXUS_PERMISSION_DENIED",
    "message": "Project 'other-project' has 'read' permission. 'execute' required for push.",
    "exitCode": 73
  }
}
```

---

## 11. Related Specifications

| Document | Purpose |
|----------|---------|
| [CLEO-NEXUS-API-CAPABILITIES.md](./CLEO-NEXUS-API-CAPABILITIES.md) | **Start here** - Architecture, use cases, integration patterns |
| [CLEO-WEB-API.md](./CLEO-WEB-API.md) | HTTP adapter implementation |
| [CLEO-NEXUS-ARCHITECTURE.md](./CLEO-NEXUS-ARCHITECTURE.md) | Original NEXUS architecture |
| [ADR-006](../.cleo/adrs/ADR-006-canonical-sqlite-storage.md) | SQLite storage architecture |
| [LAFS Protocol](https://github.com/kryptobaseddev/lafs-protocol) | LLM-Agent-First Specification |
| [CLEO-VISION.md](../concepts/CLEO-VISION.md) | Overall system vision |

---

## Appendix A: Complete Operation Matrix

| Operation | Gateway | Params | Returns |
|-----------|---------|--------|---------|
| `nexus.init` | mutate | `{}` | `{ message, registryPath, created }` |
| `nexus.status` | query | `{}` | `{ initialized, projectCount, lastUpdated }` |
| `nexus.register` | mutate | `{ path, name?, permission? }` | `{ hash, message }` |
| `nexus.unregister` | mutate | `{ name }` | `{ message }` |
| `nexus.list` | query | `{}` | `{ projects[], count }` |
| `nexus.show` | query | `{ name }` | `NexusProject` |
| `nexus.sync` | mutate | `{ name }` | `{ message, taskCount, labels[] }` |
| `nexus.sync.all` | mutate | `{}` | `{ synced, failed, results[] }` |
| `nexus.permission.set` | mutate | `{ name, level }` | `{ message, previousLevel, newLevel }` |
| `nexus.reconcile` | mutate | `{ projectRoot? }` | `{ action, project }` |
| `nexus.query` | query | `{ query, currentProject? }` | `CrossProjectTask \| CrossProjectTask[]` |
| `nexus.search` | query | `{ pattern, project?, limit? }` | `{ pattern, results[], resultCount }` |
| `nexus.discover` | query | `{ query, method?, limit? }` | `{ query, method, results[], total }` |
| `nexus.deps` | query | `{ query, direction? }` | `{ query, direction, dependencies[], blockedBy[], blocks[] }` |
| `nexus.graph` | query | `{}` | `NexusGraph` |
| `nexus.path.show` | query | `{}` | `{ path[], length, bottleneck }` |
| `nexus.blockers.show` | query | `{ query }` | `{ query, blocking[], totalBlocked, impactScore }` |
| `nexus.orphans.list` | query | `{}` | `{ orphans[], count }` |
| `nexus.share.status` | query | `{}` | `{ shared, remoteCount, remotes[], lastPush?, lastPull? }` |
| `nexus.share.remotes` | query | `{}` | `{ remotes[] }` |
| `nexus.share.sync.status` | query | `{ remote? }` | `{ remote, ahead, behind, synced, lastSync? }` |
| `nexus.share.snapshot.export` | mutate | `{ outputPath? }` | `{ path, taskCount, checksum }` |
| `nexus.share.snapshot.import` | mutate | `{ inputPath }` | `{ imported, merged, conflicts, message }` |
| `nexus.share.sync.gitignore` | mutate | `{}` | `{ updated, entriesAdded[], message }` |
| `nexus.share.remote.add` | mutate | `{ url, name? }` | `{ name, url }` |
| `nexus.share.remote.remove` | mutate | `{ name? }` | `{ name, removed }` |
| `nexus.share.push` | mutate | `{ remote?, force?, setUpstream? }` | `{ remote, pushed, commits, branch }` |
| `nexus.share.pull` | mutate | `{ remote? }` | `{ remote, pulled, commits, merged }` |

---

**Specification Version**: 1.0.0  
**Last Updated**: 2026-03-05  
**Schema**: https://cleo.dev/schemas/v1/nexus-api-spec.schema.json
