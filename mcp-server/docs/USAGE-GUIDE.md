# CLEO MCP Server Usage Guide

**Version**: 1.0.0
**Status**: ACTIVE
**Date**: 2026-02-04

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Installation](#2-installation)
3. [Configuration](#3-configuration)
4. [Quick Start](#4-quick-start)
5. [Common Workflows](#5-common-workflows)
6. [Advanced Usage](#6-advanced-usage)
7. [Troubleshooting](#7-troubleshooting)
8. [Reference](#8-reference)

---

## 1. Introduction

### 1.1 What is CLEO MCP Server?

CLEO MCP Server provides a Model Context Protocol interface for CLEO's task management system. It exposes all 65 CLI commands and 280+ library functions through two gateway tools using a CQRS (Command Query Responsibility Segregation) pattern.

**Key Benefits**:
- **94% Token Reduction**: 2 tools (~1,800 tokens) vs 65 tools (~32,500 tokens)
- **Full Capability**: All 123 operations across 10 domains accessible
- **Safety by Design**: Read operations cannot mutate state
- **Protocol Enforcement**: RCSD-IVTR lifecycle with automated validation
- **Anti-Hallucination**: 4-layer validation prevents invalid operations

### 1.2 Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│         MCP LAYER (2 Gateway Tools)                 │
│                                                     │
│  ┌──────────────────┐    ┌──────────────────┐      │
│  │   cleo_query     │    │   cleo_mutate    │      │
│  │  (Read-Only)     │    │  (Write Ops)     │      │
│  └────────┬─────────┘    └────────┬─────────┘      │
└───────────┼──────────────────────┼─────────────────┘
            │                      │
            ▼                      ▼
┌─────────────────────────────────────────────────────┐
│         DOMAIN ROUTER (8 Domains)                   │
│  tasks | session | orchestrate | research |         │
│  lifecycle | validate | release | system            │
└─────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────┐
│         PROTOCOL ENFORCEMENT LAYER                  │
│  RCSD-IVTR lifecycle with exit codes 60-70          │
└─────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────┐
│         CLI LAYER (65 commands)                     │
└─────────────────────────────────────────────────────┘
```

**2-Gateway CQRS Design**:
- **cleo_query**: 48 read operations (discovery, status, analysis, validation)
- **cleo_mutate**: 48 write operations (create, update, lifecycle, release)

### 1.3 Key Concepts

**Domains**: Functional groups of operations
- `tasks` - Task management (CRUD operations)
- `session` - Session and focus management
- `orchestrate` - Multi-agent coordination
- `research` - Research entry and manifest management
- `lifecycle` - RCSD-IVTR stage tracking
- `validate` - Protocol compliance and testing
- `release` - Version management and deployment
- `system` - Configuration and maintenance

**Protocols**: RCSD-IVTR lifecycle stages enforced via exit codes 60-70
- RCSD Pipeline: Research → Consensus → Specification → Decomposition
- IVTR Pipeline: Implementation → Validation → Testing → Release
- Cross-cutting: Contribution (work attribution)

**Lifecycle Gates**: Prerequisites enforced before spawning agents
- Gates check that prior stages are `completed` or `skipped`
- Exit code 75 blocks operations when gates fail
- Configurable enforcement modes: `strict`, `advisory`, `off`

---

## 2. Installation

### 2.1 Prerequisites

**Required**:
- Node.js >= 18.0.0
- CLEO v0.70.0+ installed and initialized
- Claude Desktop or MCP-compatible client

**Verify CLEO Installation**:
```bash
cleo version
# Expected: 0.70.0 or higher

cleo --validate
# Expected: All checks pass
```

### 2.2 npm Installation

**Install globally**:
```bash
npm install -g @cleocode/mcp-server
```

**Install locally in project**:
```bash
cd /path/to/your-project
npm install @cleocode/mcp-server
```

**Verify installation**:
```bash
cleo-server --version
# Expected: 1.0.0 or higher
```

### 2.3 Claude Desktop Configuration

**Config file location**:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

**Add CLEO server (global installation)**:
```json
{
  "mcpServers": {
    "cleo": {
      "command": "npx",
      "args": ["-y", "@cleocode/mcp-server"]
    }
  }
}
```

**Add CLEO server (local installation)**:
```json
{
  "mcpServers": {
    "cleo": {
      "command": "node",
      "args": ["/absolute/path/to/cleo-todo/mcp-server/dist/index.js"]
    }
  }
}
```

**Development mode (watch for changes)**:
```json
{
  "mcpServers": {
    "cleo": {
      "command": "node",
      "args": ["/path/to/cleo-todo/mcp-server/dist/index.js"],
      "env": {
        "CLEO_DEBUG": "true"
      }
    }
  }
}
```

### 2.4 Verification

**1. Restart Claude Desktop** after editing config

**2. Check MCP Tools** in Claude Desktop:
- Open a conversation
- Click the tools icon (🔧)
- Verify `cleo_query` and `cleo_mutate` are listed

**3. Test query operation**:
```typescript
// In Claude Desktop conversation
await cleo_query({
  domain: "system",
  operation: "version"
});
```

**Expected response**:
```json
{
  "_meta": {
    "gateway": "cleo_query",
    "domain": "system",
    "operation": "version",
    "version": "1.0.0",
    "timestamp": "2026-02-04T08:31:00Z"
  },
  "success": true,
  "data": {
    "version": "0.80.1",
    "mcp_version": "1.0.0"
  }
}
```

---

## 3. Configuration

### 3.1 .cleo/config.json

Create or edit `.cleo/config.json` in your project root:

```json
{
  "mcp": {
    "enabled": true,
    "transport": "stdio",
    "version": "1.0.0",
    "features": {
      "queryCache": true,
      "queryCacheTtl": 30000,
      "auditLog": true,
      "strictValidation": true
    }
  },
  "lifecycleEnforcement": {
    "mode": "strict",
    "allowSkip": ["consensus"],
    "emergencyBypass": false
  },
  "protocolValidation": {
    "strictMode": true,
    "blockOnViolation": true,
    "logViolations": true
  }
}
```

### 3.2 MCP Server Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `mcp.enabled` | boolean | true | Enable/disable MCP server |
| `mcp.transport` | string | "stdio" | Transport protocol (stdio only) |
| `mcp.features.queryCache` | boolean | true | Cache query results |
| `mcp.features.queryCacheTtl` | integer | 30000 | Cache TTL in milliseconds |
| `mcp.features.auditLog` | boolean | true | Log all operations |
| `mcp.features.strictValidation` | boolean | true | Enforce strict validation |

### 3.3 Lifecycle Enforcement

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `lifecycleEnforcement.mode` | enum | "strict" | `strict`, `advisory`, or `off` |
| `lifecycleEnforcement.allowSkip` | array | [] | Stages that can be skipped |
| `lifecycleEnforcement.emergencyBypass` | boolean | false | Allow emergency bypass |

**Enforcement Modes**:
- **strict**: Blocks spawn when prerequisites not met (exit 75)
- **advisory**: Warns but allows operation to proceed
- **off**: Skips all lifecycle checks (emergency only)

### 3.4 Protocol Validation

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `protocolValidation.strictMode` | boolean | true | Strict protocol checking |
| `protocolValidation.blockOnViolation` | boolean | true | Block on protocol violations |
| `protocolValidation.logViolations` | boolean | true | Log all violations |

### 3.5 Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `CLEO_DEBUG` | Enable debug logging | `true` |
| `CLEO_CONFIG_PATH` | Override config location | `/path/to/config.json` |
| `CLEO_PROJECT_ROOT` | Override project root | `/path/to/project` |

---

## 4. Quick Start

### 4.1 First Query (cleo_query)

**Discover available tasks**:
```typescript
const result = await cleo_query({
  domain: "tasks",
  operation: "find",
  params: {
    query: "authentication"
  }
});

// Result: Minimal task fields for efficient discovery
console.log(result.data);
```

**Get full task details**:
```typescript
const task = await cleo_query({
  domain: "tasks",
  operation: "get",
  params: {
    taskId: "T2908"
  }
});

console.log(task.data);
```

### 4.2 First Mutation (cleo_mutate)

**Create a new task**:
```typescript
const newTask = await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "Implement user authentication",
    description: "Add JWT-based authentication system with refresh tokens",
    priority: 1
  }
});

console.log(newTask.data.taskId);  // e.g., "T2950"
```

**Update task**:
```typescript
await cleo_mutate({
  domain: "tasks",
  operation: "update",
  params: {
    taskId: "T2950",
    status: "active",
    notes: "Started implementation"
  }
});
```

**Complete task**:
```typescript
await cleo_mutate({
  domain: "tasks",
  operation: "complete",
  params: {
    taskId: "T2950",
    notes: "Authentication system implemented and tested"
  }
});
```

### 4.3 Basic Session Workflow

**1. Check existing sessions**:
```typescript
const sessions = await cleo_query({
  domain: "session",
  operation: "list",
  params: {
    active: true
  }
});
```

**2. Start new session**:
```typescript
await cleo_mutate({
  domain: "session",
  operation: "start",
  params: {
    scope: "epic:T2908",
    name: "MCP Server Implementation",
    autoFocus: true
  }
});
```

**3. Set focus**:
```typescript
await cleo_mutate({
  domain: "session",
  operation: "focus.set",
  params: {
    taskId: "T2938"
  }
});
```

**4. Work on task** (create, update, complete)

**5. End session**:
```typescript
await cleo_mutate({
  domain: "session",
  operation: "end",
  params: {
    notes: "Created USAGE-GUIDE.md, QUICK-START.md, and WORKFLOWS.md"
  }
});
```

---

## 5. Common Workflows

### 5.1 Task Management

#### Complete Task Lifecycle

```typescript
// 1. Search for existing task
const found = await cleo_query({
  domain: "tasks",
  operation: "find",
  params: { query: "documentation" }
});

// 2. Create new task if not found
const task = await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "Update API documentation",
    description: "Document new cleo_query and cleo_mutate operations",
    priority: 2
  }
});

const taskId = task.data.taskId;

// 3. Set focus
await cleo_mutate({
  domain: "session",
  operation: "focus.set",
  params: { taskId }
});

// 4. Update progress
await cleo_mutate({
  domain: "tasks",
  operation: "update",
  params: {
    taskId,
    status: "active",
    notes: "Started API documentation"
  }
});

// 5. Complete task
await cleo_mutate({
  domain: "tasks",
  operation: "complete",
  params: {
    taskId,
    notes: "API documentation complete with examples"
  }
});

// 6. Archive completed tasks
await cleo_mutate({
  domain: "tasks",
  operation: "archive"
});
```

#### Task Dependencies

```typescript
// Create parent epic
const epic = await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "Authentication System",
    description: "Complete authentication implementation"
  }
});

// Create dependent tasks
const task1 = await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "Design auth flow",
    description: "Design JWT authentication flow",
    parent: epic.data.taskId
  }
});

const task2 = await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "Implement auth endpoints",
    description: "Create login, logout, refresh endpoints",
    parent: epic.data.taskId,
    depends: [task1.data.taskId]
  }
});

// Check dependencies
const deps = await cleo_query({
  domain: "tasks",
  operation: "deps",
  params: {
    taskId: task2.data.taskId,
    direction: "upstream"
  }
});
```

### 5.2 Session Management

#### Full Session Workflow

```typescript
// 1. List existing sessions
const sessions = await cleo_query({
  domain: "session",
  operation: "list"
});

// 2. Resume or start new
if (sessions.data.length > 0) {
  await cleo_mutate({
    domain: "session",
    operation: "resume",
    params: { sessionId: sessions.data[0].id }
  });
} else {
  await cleo_mutate({
    domain: "session",
    operation: "start",
    params: {
      scope: "epic:T2908",
      name: "MCP Implementation",
      autoFocus: true
    }
  });
}

// 3. Check current status
const status = await cleo_query({
  domain: "session",
  operation: "status"
});

console.log(status.data);

// 4. Get focused task
const focus = await cleo_query({
  domain: "session",
  operation: "focus.get"
});

// 5. Work on tasks...

// 6. Suspend session (don't end)
await cleo_mutate({
  domain: "session",
  operation: "suspend",
  params: {
    notes: "Pausing for code review"
  }
});

// 7. Resume later
await cleo_mutate({
  domain: "session",
  operation: "resume",
  params: { sessionId: status.data.sessionId }
});

// 8. End session when complete
await cleo_mutate({
  domain: "session",
  operation: "end",
  params: {
    notes: "MCP server implementation complete"
  }
});
```

### 5.3 Epic Orchestration

#### Orchestrator Startup

```typescript
// 1. Initialize orchestration for epic
const startup = await cleo_mutate({
  domain: "orchestrate",
  operation: "startup",
  params: {
    epicId: "T2908"
  }
});

// Response includes:
// - Full task tree
// - Dependency waves
// - Context budget status
// - Ready tasks
console.log(startup.data);

// 2. Analyze dependencies
const analysis = await cleo_query({
  domain: "orchestrate",
  operation: "analyze",
  params: { epicId: "T2908" }
});

// Shows:
// - Parallel execution waves
// - Critical path
// - Estimated context usage
console.log(analysis.data);

// 3. Get next task to spawn
const next = await cleo_query({
  domain: "orchestrate",
  operation: "next",
  params: { epicId: "T2908" }
});

console.log(next.data.taskId);
console.log(next.data.recommendedSkill);

// 4. Check lifecycle prerequisites
const lifecycle = await cleo_query({
  domain: "lifecycle",
  operation: "check",
  params: {
    taskId: next.data.taskId,
    targetStage: "implementation"
  }
});

if (!lifecycle.data.passed) {
  console.error("Lifecycle gate failed:", lifecycle.data.missingPrerequisites);
}

// 5. Generate spawn prompt
const spawn = await cleo_mutate({
  domain: "orchestrate",
  operation: "spawn",
  params: {
    taskId: next.data.taskId,
    skill: next.data.recommendedSkill,
    model: "sonnet"
  }
});

// Use spawn.data.prompt to spawn subagent
console.log(spawn.data.prompt);
console.log(spawn.data.metadata);
```

#### Parallel Wave Execution

```typescript
// 1. Get parallel-safe tasks
const ready = await cleo_query({
  domain: "orchestrate",
  operation: "ready",
  params: { epicId: "T2908" }
});

console.log(ready.data.taskIds);  // Tasks safe to run in parallel

// 2. Start parallel wave
await cleo_mutate({
  domain: "orchestrate",
  operation: "parallel.start",
  params: {
    epicId: "T2908",
    wave: 1
  }
});

// 3. Spawn agents for each task in wave
for (const taskId of ready.data.taskIds) {
  const spawn = await cleo_mutate({
    domain: "orchestrate",
    operation: "spawn",
    params: { taskId }
  });

  // Spawn subagent with spawn.data.prompt
}

// 4. Wait for all agents to complete...

// 5. End parallel wave
await cleo_mutate({
  domain: "orchestrate",
  operation: "parallel.end",
  params: {
    epicId: "T2908",
    wave: 1
  }
});
```

### 5.4 Research Linking

#### Link Research to Task

```typescript
// 1. Query research entries
const research = await cleo_query({
  domain: "research",
  operation: "query",
  params: {
    query: "MCP server architecture",
    confidence: 0.8
  }
});

// 2. Show research details
const entry = await cleo_query({
  domain: "research",
  operation: "show",
  params: {
    researchId: research.data[0].id
  }
});

// 3. Link research to task
await cleo_mutate({
  domain: "research",
  operation: "link",
  params: {
    researchId: entry.data.id,
    taskId: "T2938",
    relationship: "informs"
  }
});

// 4. Append manifest entry
await cleo_mutate({
  domain: "research",
  operation: "manifest.append",
  params: {
    entry: {
      id: "T2938-usage-guide",
      file: "mcp-server/docs/USAGE-GUIDE.md",
      title: "CLEO MCP Server Usage Guide",
      date: "2026-02-04",
      status: "complete",
      agent_type: "implementation",
      topics: ["mcp", "documentation", "usage"],
      key_findings: [
        "Created comprehensive usage guide",
        "Documented all 96 operations",
        "Provided workflow examples"
      ],
      actionable: true,
      linked_tasks: ["T2908", "T2938"]
    }
  }
});
```

### 5.5 Lifecycle Tracking

#### Record Stage Progression

```typescript
// 1. Check current lifecycle state
const status = await cleo_query({
  domain: "lifecycle",
  operation: "status",
  params: { taskId: "T2938" }
});

console.log(status.data);  // Current RCSD-IVTR stages

// 2. Record research completion
await cleo_mutate({
  domain: "lifecycle",
  operation: "progress",
  params: {
    taskId: "T2938",
    stage: "research",
    status: "completed",
    notes: "Reviewed MCP specification and CLEO docs"
  }
});

// 3. Skip optional stage
await cleo_mutate({
  domain: "lifecycle",
  operation: "skip",
  params: {
    taskId: "T2938",
    stage: "consensus",
    reason: "Single-agent task, no consensus needed"
  }
});

// 4. Check all gates
const gates = await cleo_query({
  domain: "lifecycle",
  operation: "gates",
  params: { taskId: "T2938" }
});

console.log(gates.data);

// 5. Mark gate passed
await cleo_mutate({
  domain: "lifecycle",
  operation: "gate.pass",
  params: {
    taskId: "T2938",
    gateName: "implemented",
    agent: "cleo-subagent",
    notes: "Documentation complete"
  }
});
```

---

## 6. Advanced Usage

### 6.1 Protocol Enforcement

#### Validate Protocol Compliance

```typescript
// 1. Check protocol compliance after completion
const validation = await cleo_query({
  domain: "validate",
  operation: "protocol",
  params: {
    taskId: "T2938",
    protocolType: "implementation"
  }
});

if (!validation.data.passed) {
  console.error("Protocol violations:", validation.data.violations);

  // Each violation includes:
  // - rule: Rule ID (e.g., IMPL-003)
  // - level: MUST, SHOULD, MAY
  // - message: Description
  // - fix: Suggested fix
}

// 2. Get compliance summary
const summary = await cleo_query({
  domain: "validate",
  operation: "compliance.summary",
  params: {
    scope: "epic:T2908",
    since: "2026-02-01"
  }
});

console.log(summary.data);
// - Total checks
// - Pass rate
// - Violations by protocol
// - Trends
```

#### Record Compliance Check

```typescript
await cleo_mutate({
  domain: "validate",
  operation: "compliance.record",
  params: {
    taskId: "T2938",
    result: {
      protocol: "implementation",
      passed: true,
      score: 1.0,
      violations: [],
      timestamp: new Date().toISOString()
    }
  }
});
```

### 6.2 Lifecycle Gates

#### Gate Validation Before Spawn

```typescript
// 1. Check if ready to spawn implementation
const gateCheck = await cleo_query({
  domain: "lifecycle",
  operation: "check",
  params: {
    taskId: "T2945",
    targetStage: "implementation"
  }
});

if (!gateCheck.data.passed) {
  console.error("Cannot spawn - missing prerequisites:");
  console.error(gateCheck.data.missingPrerequisites);

  // Complete missing stages first
  for (const stage of gateCheck.data.missingPrerequisites) {
    console.log(`Need to complete: ${stage}`);
  }

  return;
}

// 2. Safe to spawn
const spawn = await cleo_mutate({
  domain: "orchestrate",
  operation: "spawn",
  params: { taskId: "T2945" }
});
```

#### Emergency Bypass (Use Sparingly)

```typescript
// EMERGENCY ONLY - Temporarily disable enforcement
// Edit .cleo/config.json:
{
  "lifecycleEnforcement": {
    "mode": "off"  // or "advisory"
  }
}

// Or use environment variable
process.env.LIFECYCLE_ENFORCEMENT_MODE = "off";

// REMEMBER: Restore strict mode after emergency
```

### 6.3 Audit Logging

All `cleo_mutate` operations are automatically logged to audit trail:

```typescript
// Audit log location: .cleo/todo-log.json

// Query audit history (through system)
const logs = await cleo_query({
  domain: "system",
  operation: "stats",
  params: {}
});

// Shows:
// - Total operations
// - Operations by type
// - Recent activity
```

### 6.4 Error Handling Patterns

#### Comprehensive Error Handling

```typescript
async function safeOperation(operation) {
  try {
    const result = await operation();

    if (!result.success) {
      // Operation returned error (didn't throw)
      console.error('Operation failed:', result.error.message);
      console.error('Fix:', result.error.fix);

      if (result.error.alternatives) {
        console.log('Alternatives:');
        result.error.alternatives.forEach(alt => {
          console.log(`- ${alt.action}: ${alt.command}`);
        });
      }

      return null;
    }

    return result.data;

  } catch (error) {
    // Exception thrown (network error, etc.)
    console.error('Exception:', error.message);
    throw error;
  }
}

// Usage
const task = await safeOperation(() =>
  cleo_mutate({
    domain: "tasks",
    operation: "create",
    params: { /* ... */ }
  })
);

if (task) {
  console.log('Task created:', task.taskId);
}
```

#### Retry Logic for Transient Errors

```typescript
async function retryableOperation(operation, maxAttempts = 3) {
  const retryableCodes = [7, 20, 21, 22, 60, 61, 62, 63];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await operation();

      if (result.success) {
        return result.data;
      }

      const isRetryable = retryableCodes.includes(result.error?.exitCode);
      const isLastAttempt = attempt === maxAttempts;

      if (!isRetryable || isLastAttempt) {
        throw new Error(result.error.message);
      }

      const delay = Math.pow(2, attempt) * 1000;
      await sleep(delay);

    } catch (error) {
      if (attempt === maxAttempts) throw error;
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }
}

// Usage
const task = await retryableOperation(() =>
  cleo_mutate({
    domain: "tasks",
    operation: "create",
    params: { /* ... */ }
  })
);
```

---

## 7. Troubleshooting

### 7.1 Common Errors

#### E_NOT_FOUND (4) - Task Not Found

**Symptom**: `Task not found: T9999`

**Cause**: Task ID doesn't exist

**Fix**:
```typescript
// Verify task exists
const exists = await cleo_query({
  domain: "tasks",
  operation: "exists",
  params: { taskId: "T9999" }
});

// Or search for task
const found = await cleo_query({
  domain: "tasks",
  operation: "find",
  params: { query: "keyword" }
});
```

#### E_VALIDATION_FAILED (6) - Validation Error

**Symptom**: `Title and description must be different`

**Cause**: Anti-hallucination check failed

**Fix**:
```typescript
// Provide unique description
await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "Implement feature X",
    description: "Add feature X with Y functionality to support Z use case"
  }
});
```

#### E_SIBLING_LIMIT (12) - Too Many Children

**Symptom**: `Cannot add task: parent T001 already has 7 children`

**Cause**: Parent has 7 siblings (max limit)

**Fix**:
```typescript
// Create new parent to group related work
const newParent = await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "Additional Features",
    description: "Group of related features",
    parent: "T001"  // Same grandparent
  }
});

// Add new task under new parent
await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "New feature",
    description: "Feature description",
    parent: newParent.data.taskId
  }
});
```

#### E_FOCUS_REQUIRED (38) - No Focus Set

**Symptom**: `No task focused. Set focus before continuing.`

**Cause**: Session requires focus but none set

**Fix**:
```typescript
// Set focus
await cleo_mutate({
  domain: "session",
  operation: "focus.set",
  params: { taskId: "T2938" }
});

// Or start session with auto-focus
await cleo_mutate({
  domain: "session",
  operation: "start",
  params: {
    scope: "epic:T2908",
    autoFocus: true
  }
});
```

#### E_LIFECYCLE_GATE_FAILED (75) - Prerequisites Not Met

**Symptom**: `SPAWN BLOCKED: Lifecycle prerequisites not met`

**Cause**: Missing RCSD stages before implementation

**Fix**:
```typescript
// Check current state
const status = await cleo_query({
  domain: "lifecycle",
  operation: "status",
  params: { taskId: "T2945" }
});

console.log("Completed stages:", status.data.completed);
console.log("Pending stages:", status.data.pending);

// Complete missing stages first
await cleo_mutate({
  domain: "lifecycle",
  operation: "progress",
  params: {
    taskId: "T2945",
    stage: "research",
    status: "completed"
  }
});

// Or skip optional stage
await cleo_mutate({
  domain: "lifecycle",
  operation: "skip",
  params: {
    taskId: "T2945",
    stage: "consensus",
    reason: "Single-agent task"
  }
});
```

### 7.2 Exit Code Reference

| Code | Constant | Description | Retryable |
|------|----------|-------------|-----------|
| 0 | SUCCESS | Operation successful | N/A |
| 4 | E_NOT_FOUND | Resource not found | No |
| 6 | E_VALIDATION_FAILED | Validation error | No |
| 7 | E_RETRYABLE | Transient error | Yes |
| 10 | E_PARENT_NOT_FOUND | Parent doesn't exist | No |
| 11 | E_DEPTH_EXCEEDED | Hierarchy too deep | No |
| 12 | E_SIBLING_LIMIT | Too many siblings | No |
| 13 | E_CIRCULAR_DEP | Circular dependency | No |
| 38 | E_FOCUS_REQUIRED | Focus not set | No |
| 60-70 | E_PROTOCOL_* | Protocol violations | Some |
| 75 | E_LIFECYCLE_GATE_FAILED | Gate failed | No |
| 100 | E_SESSION_DISCOVERY | Discovery mode | N/A |

**See**: [Complete Error Reference](docs/api/errors.md)

### 7.3 Debug Mode

Enable debug logging:

```bash
# Environment variable
export CLEO_DEBUG=true

# Or in Claude Desktop config
{
  "mcpServers": {
    "cleo": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "CLEO_DEBUG": "true"
      }
    }
  }
}
```

Debug output shows:
- Request parameters
- CLI command executed
- Raw CLI output
- Response formatting
- Timing information

### 7.4 FAQ

**Q: Why do I get "SPAWN BLOCKED" errors?**

A: Lifecycle gates are enforced. Complete or skip prerequisite RCSD stages (research, consensus, specification, decomposition) before implementation.

**Q: Can I bypass lifecycle gates?**

A: Yes, but only for emergencies. Set `lifecycleEnforcement.mode` to `"advisory"` or `"off"` in `.cleo/config.json`. Remember to restore `"strict"` mode afterward.

**Q: Why does task creation fail with validation errors?**

A: CLEO enforces anti-hallucination rules. Ensure title and description are different, unique, and within length limits (title: 5-100, description: 10-1000 chars).

**Q: How do I check MCP server is running?**

A: Use `cleo_query system version` in Claude Desktop. If it responds, the server is connected.

**Q: Can I use cleo_query and cleo_mutate outside Claude Desktop?**

A: Yes, with any MCP-compatible client. The server uses standard stdio transport.

**Q: What's the difference between `find` and `list` operations?**

A: `find` returns minimal fields for discovery (99% less context). `list` returns full task objects. Always use `find` for discovery, then `get` for details.

---

## 8. Reference

### 8.1 All Operations Summary

#### cleo_query Operations (48)

**tasks** (9):
- `get`, `list`, `find`, `exists`, `tree`, `blockers`, `deps`, `analyze`, `next`

**session** (5):
- `status`, `list`, `show`, `focus.get`, `history`

**orchestrate** (7):
- `status`, `next`, `ready`, `analyze`, `context`, `waves`, `skill.list`

**research** (6):
- `show`, `list`, `query`, `pending`, `stats`, `manifest.read`

**lifecycle** (5):
- `check`, `status`, `history`, `gates`, `prerequisites`

**validate** (9):
- `schema`, `protocol`, `task`, `manifest`, `output`, `compliance.summary`, `compliance.violations`, `test.status`, `test.coverage`

**system** (5):
- `version`, `doctor`, `config.get`, `stats`, `context`

#### cleo_mutate Operations (48)

**tasks** (10):
- `create`, `update`, `complete`, `delete`, `archive`, `unarchive`, `reparent`, `promote`, `reorder`, `reopen`

**session** (7):
- `start`, `end`, `resume`, `suspend`, `focus.set`, `focus.clear`, `gc`

**orchestrate** (5):
- `startup`, `spawn`, `validate`, `parallel.start`, `parallel.end`

**research** (4):
- `inject`, `link`, `manifest.append`, `manifest.archive`

**lifecycle** (5):
- `progress`, `skip`, `reset`, `gate.pass`, `gate.fail`

**validate** (2):
- `compliance.record`, `test.run`

**release** (7):
- `prepare`, `changelog`, `commit`, `tag`, `push`, `gates.run`, `rollback`

**system** (7):
- `init`, `config.set`, `backup`, `restore`, `migrate`, `sync`, `cleanup`

### 8.2 Exit Codes (0-100)

**See**: [Complete Error Code Reference](docs/api/errors.md)

| Range | Category |
|-------|----------|
| 0 | Success |
| 1-9 | General errors |
| 10-19 | Hierarchy errors |
| 20-29 | Dependency errors |
| 30-39 | Session errors |
| 40-49 | Gate errors |
| 50-59 | Context errors |
| 60-70 | Protocol violations |
| 75-79 | Lifecycle errors |
| 100+ | Special codes |

### 8.3 Links to API Docs

- **[API Overview](docs/api/overview.md)** - Gateway architecture
- **[Gateways](docs/api/gateways/)** - cleo_query, cleo_mutate
- **[Domains](docs/api/domains/)** - All 8 domain references
- **[Protocols](docs/api/protocols.md)** - RCSD-IVTR enforcement
- **[Errors](docs/api/errors.md)** - Complete error reference
- **[Lifecycle](docs/api/lifecycle.md)** - Lifecycle gates
- **[Examples](docs/examples/)** - Workflow examples

### 8.4 External Resources

- [MCP Server Specification](https://github.com/cleo-dev/cleo-todo/blob/main/docs/specs/MCP-SERVER-SPECIFICATION.md)
- [CLEO Documentation](https://github.com/cleo-dev/cleo-todo)
- [Model Context Protocol](https://modelcontextprotocol.io/specification)
- [CLEO CLAUDE.md](https://github.com/cleo-dev/cleo-todo/blob/main/CLAUDE.md)

---

**Next Steps**:
- [Quick Start Guide](QUICK-START.md) - 5-minute getting started
- [Workflow Examples](WORKFLOWS.md) - Real-world scenarios
- [API Reference](docs/api/overview.md) - Complete operation details
