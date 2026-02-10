# CLEO MCP Server Quick Start

**Get started with CLEO MCP Server in 5 minutes**

---

## Installation

```bash
# Install globally
npm install -g @cleocode/mcp-server

# Verify installation
cleo-server --version
```

---

## Configuration

Add to Claude Desktop config (`claude_desktop_config.json`):

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

**Config locations**:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

**Restart Claude Desktop** after editing config.

---

## First Steps

### 1. Check Version

```typescript
await cleo_query({
  domain: "system",
  operation: "version"
});
```

**Expected**:
```json
{
  "success": true,
  "data": {
    "version": "0.80.1",
    "mcp_version": "1.0.0"
  }
}
```

### 2. Find Tasks

```typescript
await cleo_query({
  domain: "tasks",
  operation: "find",
  params: {
    query: "documentation"
  }
});
```

### 3. Create Task

```typescript
await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "Write API documentation",
    description: "Document all cleo_query and cleo_mutate operations with examples"
  }
});
```

### 4. Start Session

```typescript
await cleo_mutate({
  domain: "session",
  operation: "start",
  params: {
    scope: "epic:T2908",
    name: "Documentation Work",
    autoFocus: true
  }
});
```

### 5. Complete Task

```typescript
await cleo_mutate({
  domain: "tasks",
  operation: "complete",
  params: {
    taskId: "T2938",
    notes: "Documentation complete"
  }
});
```

---

## Gateway Overview

### cleo_query (Read-Only)

**Purpose**: Discovery, status checks, analysis

**Format**:
```typescript
await cleo_query({
  domain: "tasks" | "session" | "orchestrate" | "research" | "lifecycle" | "validate" | "system",
  operation: "operation_name",
  params: { /* operation-specific */ }
});
```

**Key Operations**:
- `tasks find` - Search tasks
- `tasks get` - Get task details
- `session status` - Current session
- `lifecycle check` - Gate validation

### cleo_mutate (Write Operations)

**Purpose**: Create, update, complete, lifecycle management

**Format**:
```typescript
await cleo_mutate({
  domain: "tasks" | "session" | "orchestrate" | "research" | "lifecycle" | "validate" | "release" | "system",
  operation: "operation_name",
  params: { /* operation-specific */ }
});
```

**Key Operations**:
- `tasks create` - Create task
- `tasks complete` - Complete task
- `session start` - Start session
- `orchestrate spawn` - Generate spawn prompt

---

## Basic Workflow

```typescript
// 1. List existing sessions
const sessions = await cleo_query({
  domain: "session",
  operation: "list"
});

// 2. Start session (if none active)
if (sessions.data.filter(s => s.active).length === 0) {
  await cleo_mutate({
    domain: "session",
    operation: "start",
    params: {
      scope: "epic:T2908",
      autoFocus: true
    }
  });
}

// 3. Find task to work on
const tasks = await cleo_query({
  domain: "tasks",
  operation: "find",
  params: { query: "high priority" }
});

// 4. Set focus
await cleo_mutate({
  domain: "session",
  operation: "focus.set",
  params: { taskId: tasks.data[0].id }
});

// 5. Update task
await cleo_mutate({
  domain: "tasks",
  operation: "update",
  params: {
    taskId: tasks.data[0].id,
    status: "active",
    notes: "Started work"
  }
});

// 6. Complete task
await cleo_mutate({
  domain: "tasks",
  operation: "complete",
  params: {
    taskId: tasks.data[0].id,
    notes: "Task complete"
  }
});

// 7. End session
await cleo_mutate({
  domain: "session",
  operation: "end",
  params: {
    notes: "Work session complete"
  }
});
```

---

## Common Patterns

### Discovery → Details

```typescript
// 1. Use find for discovery (minimal fields)
const found = await cleo_query({
  domain: "tasks",
  operation: "find",
  params: { query: "auth" }
});

// 2. Use get for full details
const task = await cleo_query({
  domain: "tasks",
  operation: "get",
  params: { taskId: found.data[0].id }
});
```

### Error Handling

```typescript
const result = await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: { /* ... */ }
});

if (!result.success) {
  console.error(result.error.message);
  console.error('Fix:', result.error.fix);
  return;
}

// Use result.data
```

### Retry Transient Errors

```typescript
async function retryOperation(operation, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await operation();
      if (result.success) return result.data;
    } catch (error) {
      if (error.exitCode !== 7 || attempt === maxAttempts) {
        throw error;
      }
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }
}
```

---

## Troubleshooting

### Server Not Connected

**Symptom**: Tools not available in Claude Desktop

**Fix**:
1. Verify config file location and syntax
2. Restart Claude Desktop
3. Check server is installed: `cleo-server --version`

### Task Not Found (Exit 4)

```typescript
// Verify task exists first
await cleo_query({
  domain: "tasks",
  operation: "exists",
  params: { taskId: "T9999" }
});
```

### Validation Failed (Exit 6)

```typescript
// Ensure title and description are different
await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "Implement feature",
    description: "Add feature with comprehensive error handling and tests"
  }
});
```

### Lifecycle Gate Failed (Exit 75)

```typescript
// Check current lifecycle state
await cleo_query({
  domain: "lifecycle",
  operation: "status",
  params: { taskId: "T2945" }
});

// Complete or skip missing stages
await cleo_mutate({
  domain: "lifecycle",
  operation: "progress",
  params: {
    taskId: "T2945",
    stage: "research",
    status: "completed"
  }
});
```

---

## Next Steps

- **[Complete Usage Guide](USAGE-GUIDE.md)** - Comprehensive documentation
- **[Workflow Examples](WORKFLOWS.md)** - Real-world scenarios
- **[API Reference](docs/api/overview.md)** - All operations
- **[Error Codes](docs/api/errors.md)** - Complete error reference

---

## Quick Reference

### Essential Operations

```typescript
// Discovery
cleo_query tasks find {query: "..."}
cleo_query tasks get {taskId: "T####"}

// Task management
cleo_mutate tasks create {title: "...", description: "..."}
cleo_mutate tasks update {taskId: "T####", status: "active"}
cleo_mutate tasks complete {taskId: "T####", notes: "..."}

// Session
cleo_mutate session start {scope: "epic:T####", autoFocus: true}
cleo_mutate session focus.set {taskId: "T####"}
cleo_mutate session end {notes: "..."}

// Orchestration
cleo_mutate orchestrate startup {epicId: "T####"}
cleo_query orchestrate next {epicId: "T####"}
cleo_mutate orchestrate spawn {taskId: "T####"}

// System
cleo_query system version
cleo_query system stats
```

### Exit Codes

| Code | Meaning | Action |
|------|---------|--------|
| 0 | Success | Continue |
| 4 | Not found | Verify ID |
| 6 | Validation failed | Fix input |
| 7 | Retryable error | Retry with backoff |
| 75 | Gate failed | Complete prerequisites |

### Configuration

**Minimal config** (`.cleo/config.json`):
```json
{
  "mcp": {
    "enabled": true
  }
}
```

**Recommended config**:
```json
{
  "mcp": {
    "enabled": true,
    "features": {
      "queryCache": true,
      "auditLog": true
    }
  },
  "lifecycleEnforcement": {
    "mode": "strict"
  }
}
```

---

## Support

- **Issues**: [GitHub Issues](https://github.com/cleo-dev/cleo-todo/issues)
- **Specification**: [MCP Server Spec](https://github.com/cleo-dev/cleo-todo/blob/main/docs/specs/MCP-SERVER-SPECIFICATION.md)
- **CLEO Docs**: [Documentation](https://github.com/cleo-dev/cleo-todo/tree/main/docs)
