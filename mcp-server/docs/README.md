# CLEO MCP Server Documentation

**Version**: 1.0.0
**Status**: Production Ready

---

## Overview

The CLEO MCP Server exposes CLEO's task management capabilities through the Model Context Protocol (MCP), providing AI coding agents with structured access to the deployed gateway operation matrix across 8 functional domains.

### Key Features

- **Minimal Token Footprint**: 2 gateway tools (~1,800 tokens) vs 65 individual tools (~32,500 tokens) = 94% reduction
- **CQRS Pattern**: Separate read (`cleo_query`) and write (`cleo_mutate`) operations for safety
- **Protocol Enforcement**: Full RCSD-IVTR lifecycle with exit codes 60-70
- **Anti-Hallucination**: 4-layer validation (schema → semantic → referential → protocol)
- **Atomic Operations**: All writes use temp → validate → backup → rename pattern

### Architecture

```
┌─────────────────────────────────────┐
│     MCP TOOL LAYER (2 gateways)     │
│  cleo_query (56) | cleo_mutate (51) │
└─────────────────┬───────────────────┘
                  │
┌─────────────────▼───────────────────┐
│      DOMAIN ROUTER (8 domains)      │
│ tasks | session | orchestrate       │
│ research | lifecycle | validate      │
│ release | system                     │
└─────────────────┬───────────────────┘
                  │
┌─────────────────▼───────────────────┐
│    PROTOCOL ENFORCEMENT LAYER       │
│  RCSD-IVTR Lifecycle Gates          │
└─────────────────┬───────────────────┘
                  │
┌─────────────────▼───────────────────┐
│       CLI LAYER (65 commands)       │
└─────────────────┬───────────────────┘
                  │
┌─────────────────▼───────────────────┐
│    LIB LAYER (99 modules, 280+ fn)  │
└─────────────────────────────────────┘
```

---

## Quick Start

### Installation

```bash
# Install CLEO
./install.sh

# Configure MCP server
cat > ~/.claude/config.json <<'EOF'
{
  "mcpServers": {
    "cleo": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/index.js"],
      "env": {
        "CLEO_PROJECT_ROOT": "/path/to/project"
      }
    }
  }
}
EOF
```

### Basic Usage

```typescript
// Query operations (read-only)
const tasks = await cleo_query({
  domain: "tasks",
  operation: "list",
  params: { status: "pending" }
});

// Mutate operations (write)
const newTask = await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "Implement feature X",
    description: "Add support for feature X with tests"
  }
});
```

---

## Documentation Structure

### API Reference

- **[API Overview](api/overview.md)** - Gateway concepts, domains, operations
- **Gateways**
  - [cleo_query](api/gateways/cleo_query.md) - Read operations (63)
  - [cleo_mutate](api/gateways/cleo_mutate.md) - Write operations (60)
- **Domains**
  - [tasks](api/domains/tasks.md) - Task management (21 operations)
  - [session](api/domains/session.md) - Session management (12 operations)
  - [orchestrate](api/domains/orchestrate.md) - Multi-agent orchestration (12 operations)
  - [research](api/domains/research.md) - Research and manifest (10 operations)
  - [lifecycle](api/domains/lifecycle.md) - RCSD-IVTR lifecycle (10 operations)
  - [validate](api/domains/validate.md) - Validation and compliance (11 operations)
  - [release](api/domains/release.md) - Release management (7 operations)
  - [system](api/domains/system.md) - System operations (24 operations)
  - [issues](api/domains/issues.md) - Issue management (4 operations)
  - [skills](api/domains/skills.md) - Skill management (12 operations)
- **[Error Codes](api/errors.md)** - Complete error code reference
- **[Protocols](api/protocols.md)** - Protocol enforcement (exit 60-70)
- **[Lifecycle](api/lifecycle.md)** - RCSD-IVTR lifecycle gates

### Guides

- [Installation](guides/installation.md) - Setup and configuration
- [Configuration](guides/configuration.md) - MCP server configuration
- [Authentication](guides/authentication.md) - Permission model
- [Troubleshooting](guides/troubleshooting.md) - Common issues and solutions

### Examples

- [Task Management](examples/task-management.md) - Complete task workflows
- [Session Management](examples/session-management.md) - Session lifecycle
- [Orchestration](examples/orchestration.md) - Multi-agent coordination
- [Research Workflow](examples/research-workflow.md) - Research and manifest

---

## Core Concepts

### Two-Gateway Design

The MCP server uses **CQRS (Command Query Responsibility Segregation)**:

| Gateway | Purpose | Operations | Characteristics |
|---------|---------|------------|-----------------|
| `cleo_query` | Read operations | 56 | Idempotent, cacheable, no side effects |
| `cleo_mutate` | Write operations | 51 | Validated, logged, atomic |

**Benefits**:
- **Safety**: Read operations cannot modify state
- **Permissions**: Grant read-only access by exposing only `cleo_query`
- **Caching**: Query results can be cached safely
- **Audit**: All mutations logged for compliance

### Domain Routing

Operations are organized into 8 functional domains:

```typescript
interface MCPRequest {
  domain: 'tasks' | 'session' | 'orchestrate' | 'research' |
          'lifecycle' | 'validate' | 'release' | 'system';
  operation: string;  // Domain-specific operation
  params: object;     // Operation-specific parameters
}
```

**Example**:
```typescript
// Instead of calling "task_list" tool:
cleo_query({ domain: "tasks", operation: "list", params: {} })

// Instead of calling "task_create" tool:
cleo_mutate({ domain: "tasks", operation: "create", params: { title: "...", description: "..." } })
```

### Protocol Enforcement

CLEO enforces the **RCSD-IVTR lifecycle**:

```
SETUP (RCSD)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Research → Consensus → Specification → Decomposition
  (60)       (61)         (62)            (63)

EXECUTION (IVTR)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Implementation → Validation → Testing → Release
     (64)           (68)       (69/70)    (66)

CROSS-CUTTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Contribution (65) - Work attribution
```

Exit codes 60-70 indicate protocol violations. See [Protocols](api/protocols.md) for details.

### Response Format

All operations return a consistent envelope:

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
    // Operation-specific response
  }
}
```

**Error Response**:
```json
{
  "_meta": { /* ... */ },
  "success": false,
  "error": {
    "code": "E_VALIDATION_FAILED",
    "exitCode": 6,
    "message": "Title and description must be different",
    "fix": "Provide a unique description that differs from the title",
    "alternatives": [
      {
        "action": "Use generated description",
        "command": "..."
      }
    ]
  }
}
```

---

## Operation Matrix

### cleo_query (Read Operations - 56)

| Domain | Operations | Count |
|--------|------------|-------|
| tasks | get, list, find, exists, tree, blockers, deps, analyze, next | 9 |
| session | status, list, show, focus.get, history | 5 |
| orchestrate | status, next, ready, analyze, context, waves, skill.list | 7 |
| research | show, list, query, pending, stats, manifest.read | 6 |
| lifecycle | check, status, history, gates, prerequisites | 5 |
| validate | schema, protocol, task, manifest, output, compliance.summary, compliance.violations, test.status, test.coverage | 9 |
| system | version, doctor, config.get, stats, context | 5 |
| *system (job)* | *job.status, job.list* | *2* |

> **Note**: Implementation count is sourced from `src/gateways/query.ts` (`EXPECTED_QUERY_COUNT=56`).

### cleo_mutate (Write Operations - 51)

| Domain | Operations | Count |
|--------|------------|-------|
| tasks | create, update, complete, delete, archive, unarchive, reparent, promote, reorder, reopen | 10 |
| session | start, end, resume, suspend, focus.set, focus.clear, gc | 7 |
| orchestrate | startup, spawn, validate, parallel.start, parallel.end | 5 |
| research | inject, link, manifest.append, manifest.archive | 4 |
| lifecycle | progress, skip, reset, gate.pass, gate.fail | 5 |
| validate | compliance.record, test.run | 2 |
| release | prepare, changelog, commit, tag, push, gates.run, rollback | 7 |
| system | init, config.set, backup, restore, migrate, sync, cleanup | 7 |
| *system (job)* | *job.cancel* | *1* |

> **Note**: Implementation count is sourced from `src/gateways/mutate.ts` (`EXPECTED_MUTATE_COUNT=51`).

---

## Common Workflows

### Task Discovery & Execution

```typescript
// 1. Find tasks
const results = await cleo_query({
  domain: "tasks",
  operation: "find",
  params: { query: "authentication" }
});

// 2. Get task details
const task = await cleo_query({
  domain: "tasks",
  operation: "get",
  params: { taskId: "T2405" }
});

// 3. Set focus
await cleo_mutate({
  domain: "session",
  operation: "focus.set",
  params: { taskId: "T2405" }
});

// 4. Complete task
await cleo_mutate({
  domain: "tasks",
  operation: "complete",
  params: { taskId: "T2405", notes: "Implemented successfully" }
});
```

### Orchestrator Workflow

```typescript
// 1. Initialize orchestration
const startup = await cleo_mutate({
  domain: "orchestrate",
  operation: "startup",
  params: { epicId: "T2400" }
});

// 2. Check lifecycle prerequisites
const lifecycle = await cleo_query({
  domain: "lifecycle",
  operation: "check",
  params: { taskId: "T2405", targetStage: "implementation" }
});

// 3. Generate spawn prompt
const spawn = await cleo_mutate({
  domain: "orchestrate",
  operation: "spawn",
  params: { taskId: "T2405", skill: "ct-task-executor" }
});

// 4. Validate protocol compliance
const validation = await cleo_query({
  domain: "validate",
  operation: "protocol",
  params: { taskId: "T2405", protocolType: "implementation" }
});
```

---

## Performance & Limits

### Token Budget

| Approach | Tools | Tokens | % of 200K |
|----------|-------|--------|-----------|
| Flat CLI (65 commands) | 65 | ~32,500 | 16.3% |
| 8 Gateways | 8 | ~4,000 | 2.0% |
| **2 Gateways (MCP)** | **2** | **~1,800** | **0.9%** |

### Rate Limits (Recommended)

- Query operations: 100/minute
- Mutate operations: 30/minute
- Spawn operations: 10/minute

### Response Times

- Simple queries (get, exists): < 50ms
- Complex queries (tree, analyze): < 200ms
- Write operations (create, update): < 100ms
- Validation operations: < 500ms

---

## Security

### Permission Model

The two-gateway design enables permission separation:

- **Read-only access**: Grant `cleo_query` only
- **Full access**: Grant both `cleo_query` and `cleo_mutate`
- **Audit trail**: All mutations logged to `.cleo/todo-log.json`

### Input Validation

All inputs are validated:
- **Task IDs**: Pattern `^T[0-9]+$`
- **Paths**: No traversal (`..`), within project root
- **Content**: Size limits, no control characters
- **Enums**: Strict value checking

### Intentional Validation Differences (MCP vs CLI)

The MCP server intentionally applies stricter validation than the CLI in several areas to support anti-hallucination and agent safety:

- **Description always required**: `tasks.add`/`tasks.create` requires both `title` AND `description` (CLI makes description configurable)
- **Rate limiting**: MCP enforces per-minute limits on queries (100), mutations (30), and spawns (10)
- **Pre-flight verification**: Protocol compliance checked before operations execute (CLI checks at completion)
- **Session scope always required**: MCP agents must always specify scope when starting sessions

Canonical parity and validation policy is maintained in [`docs/specs/MCP-SERVER-SPECIFICATION.md`](../../docs/specs/MCP-SERVER-SPECIFICATION.md).

### Thread Safety

Concurrent operations are protected via flock:
- `.cleo/todo.json.lock`
- `.cleo/MANIFEST.jsonl.lock`

---

## Support & Resources

- **Specification**: [MCP Server Specification](../../docs/specs/MCP-SERVER-SPECIFICATION.md)
- **CLI Reference**: [CLEO CLI Commands](../../docs/CLI-REFERENCE.md)
- **Project Lifecycle**: [PROJECT-LIFECYCLE-SPEC](../../docs/specs/PROJECT-LIFECYCLE-SPEC.md)
- **Protocol Enforcement**: [Protocol Enforcement Guide](../../docs/guides/protocol-enforcement.md)

---

## Version History

### v1.1.0 (2026-02-10)

- Updated deployed operation counts to gateway source-of-truth (56 query + 51 mutate)
- Removed ad hoc validation-differences dependency in favor of canonical spec policy

### v1.0.0 (2026-02-04)

- Initial release
- Two-gateway CQRS design
- Initial operation matrix release
- Full RCSD-IVTR protocol coverage
- Complete error code mapping
- Manifest and verification gate systems
