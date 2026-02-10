# Task Management Examples

Complete workflows for task discovery, creation, execution, and completion using the CLEO MCP Server.

---

## Basic Task Workflow

### 1. Discovery - Finding Tasks

Use `tasks.find` for efficient fuzzy search (99% less context than `list`):

```typescript
// Fuzzy search for tasks
const results = await cleo_query({
  domain: "tasks",
  operation: "find",
  params: {
    query: "authentication",
    limit: 10
  }
});

// Results include minimal fields
results.data.tasks.forEach(task => {
  console.log(`${task.id}: ${task.title} (${task.status})`);
});
```

**Output**:
```
T2405: Implement JWT authentication (pending)
T2410: Add OAuth2 authentication (pending)
T2415: Authentication middleware (active)
```

### 2. Get Task Details

Once you've identified a task, get full details:

```typescript
const task = await cleo_query({
  domain: "tasks",
  operation: "get",
  params: { taskId: "T2405" }
});

console.log(task.data.task);
```

**Output**:
```json
{
  "id": "T2405",
  "title": "Implement JWT authentication",
  "description": "Add JWT token generation and verification for API authentication",
  "status": "pending",
  "priority": "high",
  "created": "2026-02-01T10:00:00Z",
  "updated": "2026-02-04T08:00:00Z",
  "parent": "T2400",
  "depends": ["T2401", "T2402"],
  "labels": ["authentication", "security", "api"],
  "notes": []
}
```

### 3. Set Focus

Before working on a task, set it as focused:

```typescript
await cleo_mutate({
  domain: "session",
  operation: "focus.set",
  params: { taskId: "T2405" }
});
```

### 4. Complete Task

When work is done:

```typescript
await cleo_mutate({
  domain: "tasks",
  operation: "complete",
  params: {
    taskId: "T2405",
    notes: "Implemented JWT token generation with HS256 algorithm. Added tests for token verification."
  }
});
```

---

## Creating Tasks

### Create Simple Task

```typescript
const newTask = await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "Add password reset endpoint",
    description: "Implement /auth/reset-password endpoint with email verification and token expiry"
  }
});

console.log(`Created: ${newTask.data.task.id}`);
```

### Create Task with Dependencies

```typescript
const task = await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "Implement OAuth2 flow",
    description: "Add complete OAuth2 authorization code flow with PKCE",
    parent: "T2400",
    depends: ["T2405", "T2410"],
    priority: "high",
    labels: ["authentication", "oauth2", "security"]
  }
});
```

### Create Subtask

```typescript
const subtask = await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "Write OAuth2 integration tests",
    description: "Add integration tests for OAuth2 authorization flow",
    parent: "T2420"  // Parent is the OAuth2 implementation task
  }
});
```

---

## Updating Tasks

### Update Single Field

```typescript
await cleo_mutate({
  domain: "tasks",
  operation: "update",
  params: {
    taskId: "T2405",
    status: "active"
  }
});
```

### Update Multiple Fields

```typescript
await cleo_mutate({
  domain: "tasks",
  operation: "update",
  params: {
    taskId: "T2405",
    status: "blocked",
    priority: "high",
    notes: "Blocked on security review of JWT implementation"
  }
});
```

### Add Note to Task

```typescript
await cleo_mutate({
  domain: "tasks",
  operation: "update",
  params: {
    taskId: "T2405",
    notes: "Security review complete. Approved to proceed with implementation."
  }
});
```

---

## Task Relationships

### Check Dependencies

```typescript
const deps = await cleo_query({
  domain: "tasks",
  operation: "deps",
  params: {
    taskId: "T2405",
    direction: "both"  // upstream, downstream, or both
  }
});

console.log("Depends on:", deps.data.upstream);
console.log("Blocks:", deps.data.downstream);
```

**Output**:
```json
{
  "upstream": [
    { "id": "T2401", "title": "Setup authentication database schema" },
    { "id": "T2402", "title": "Install JWT library" }
  ],
  "downstream": [
    { "id": "T2420", "title": "Implement OAuth2 flow" },
    { "id": "T2425", "title": "Add API authentication middleware" }
  ]
}
```

### Find Blockers

```typescript
const blockers = await cleo_query({
  domain: "tasks",
  operation: "blockers",
  params: { taskId: "T2420" }
});

if (blockers.data.blockers.length > 0) {
  console.log("Task blocked by:");
  blockers.data.blockers.forEach(task => {
    console.log(`  ${task.id}: ${task.title} (${task.status})`);
  });
}
```

### View Task Tree

```typescript
const tree = await cleo_query({
  domain: "tasks",
  operation: "tree",
  params: {
    rootId: "T2400",
    depth: 3
  }
});

// Hierarchical view
console.log(tree.data.tree);
```

**Output**:
```
T2400: Authentication System (epic)
├── T2405: Implement JWT authentication (done)
├── T2410: Add OAuth2 authentication (active)
│   ├── T2411: OAuth2 authorization endpoint (pending)
│   └── T2412: OAuth2 token endpoint (pending)
└── T2415: Authentication middleware (pending)
```

---

## Task Filtering & Search

### List by Status

```typescript
// Get all pending tasks
const pending = await cleo_query({
  domain: "tasks",
  operation: "list",
  params: { status: "pending" }
});

// Get all active tasks
const active = await cleo_query({
  domain: "tasks",
  operation: "list",
  params: { status: "active" }
});
```

### List by Parent

```typescript
// Get all tasks in an epic
const epicTasks = await cleo_query({
  domain: "tasks",
  operation: "list",
  params: { parent: "T2400" }
});
```

### Combined Filters

```typescript
// Get high-priority pending tasks
const urgent = await cleo_query({
  domain: "tasks",
  operation: "list",
  params: {
    status: "pending",
    priority: "high"
  }
});
```

### Pagination

```typescript
// Get first page
const page1 = await cleo_query({
  domain: "tasks",
  operation: "list",
  params: {
    status: "pending",
    limit: 10,
    offset: 0
  }
});

// Get next page if available
if (page1.data.pagination.hasMore) {
  const page2 = await cleo_query({
    domain: "tasks",
    operation: "list",
    params: {
      status: "pending",
      limit: 10,
      offset: 10
    }
  });
}
```

---

## Advanced Task Management

### Get Next Task Suggestion

```typescript
const suggestion = await cleo_query({
  domain: "tasks",
  operation: "next",
  params: {
    epicId: "T2400",
    count: 3
  }
});

console.log("Suggested tasks:");
suggestion.data.tasks.forEach((task, index) => {
  console.log(`${index + 1}. ${task.id}: ${task.title}`);
  console.log(`   Reason: ${task.reason}`);
});
```

**Output**:
```
Suggested tasks:
1. T2405: Implement JWT authentication
   Reason: All dependencies completed, high priority
2. T2415: Authentication middleware
   Reason: No blockers, medium priority
3. T2410: Add OAuth2 authentication
   Reason: Depends on T2405 (completed)
```

### Triage Analysis

```typescript
const analysis = await cleo_query({
  domain: "tasks",
  operation: "analyze",
  params: { epicId: "T2400" }
});

console.log("Triage Summary:");
console.log(`  Ready to start: ${analysis.data.ready.length}`);
console.log(`  Blocked: ${analysis.data.blocked.length}`);
console.log(`  In progress: ${analysis.data.active.length}`);
console.log(`  Completed: ${analysis.data.done.length}`);
```

---

## Task Hierarchy Management

### Reparent Task

Move a task to a different parent:

```typescript
await cleo_mutate({
  domain: "tasks",
  operation: "reparent",
  params: {
    taskId: "T2425",
    newParent: "T2430"
  }
});
```

### Promote Task

Promote a subtask to a task (move up one level):

```typescript
await cleo_mutate({
  domain: "tasks",
  operation: "promote",
  params: { taskId: "T2425" }
});
```

### Reorder Siblings

Change the order of tasks within a parent:

```typescript
await cleo_mutate({
  domain: "tasks",
  operation: "reorder",
  params: {
    taskId: "T2425",
    position: 1  // Move to second position (0-indexed)
  }
});
```

---

## Task Lifecycle

### Check if Task Exists

```typescript
const exists = await cleo_query({
  domain: "tasks",
  operation: "exists",
  params: { taskId: "T2405" }
});

if (exists.data.exists) {
  // Task exists, proceed
} else {
  // Task not found, handle error
}
```

### Reopen Completed Task

```typescript
await cleo_mutate({
  domain: "tasks",
  operation: "reopen",
  params: {
    taskId: "T2405",
    notes: "Reopening due to bug report in production"
  }
});
```

### Archive Completed Tasks

```typescript
// Archive specific task
await cleo_mutate({
  domain: "tasks",
  operation: "archive",
  params: { taskId: "T2405" }
});

// Archive all completed tasks older than date
await cleo_mutate({
  domain: "tasks",
  operation: "archive",
  params: {
    before: "2026-01-01T00:00:00Z"
  }
});
```

### Unarchive Task

```typescript
await cleo_mutate({
  domain: "tasks",
  operation: "unarchive",
  params: { taskId: "T2405" }
});
```

### Delete Task

```typescript
await cleo_mutate({
  domain: "tasks",
  operation: "delete",
  params: {
    taskId: "T2405",
    force: false  // Set true to delete with dependencies
  }
});
```

---

## Error Handling

### Handle Task Not Found

```typescript
try {
  const task = await cleo_query({
    domain: "tasks",
    operation: "get",
    params: { taskId: "T9999" }
  });
} catch (error) {
  if (error.exitCode === 4) {  // E_NOT_FOUND
    console.error("Task not found:", error.error.message);
    console.log("Fix:", error.error.fix);
  }
}
```

### Handle Validation Errors

```typescript
try {
  await cleo_mutate({
    domain: "tasks",
    operation: "create",
    params: {
      title: "Test Task",
      description: "Test Task"  // Same as title - violation
    }
  });
} catch (error) {
  if (error.exitCode === 6) {  // E_VALIDATION
    console.error("Validation failed:", error.error.message);
    console.log("Fix:", error.error.fix);

    // Use alternative approach
    if (error.error.alternatives) {
      console.log("Alternatives:");
      error.error.alternatives.forEach(alt => {
        console.log(`  ${alt.action}: ${alt.command}`);
      });
    }
  }
}
```

### Handle Hierarchy Limits

```typescript
try {
  await cleo_mutate({
    domain: "tasks",
    operation: "create",
    params: {
      title: "New Task",
      description: "Another task under parent",
      parent: "T2400"  // Already has 7 children
    }
  });
} catch (error) {
  if (error.exitCode === 12) {  // E_SIBLING_LIMIT
    console.error("Too many siblings:", error.error.message);
    console.log("Solution:", error.error.fix);

    // List existing siblings
    const siblings = await cleo_query({
      domain: "tasks",
      operation: "list",
      params: { parent: "T2400" }
    });
    console.log("Existing siblings:", siblings.data.tasks);
  }
}
```

---

## Complete Workflow Example

```typescript
async function completeTaskWorkflow() {
  // 1. Find tasks to work on
  const results = await cleo_query({
    domain: "tasks",
    operation: "find",
    params: { query: "authentication" }
  });

  // 2. Get next suggested task
  const suggestion = await cleo_query({
    domain: "tasks",
    operation: "next",
    params: { count: 1 }
  });

  const taskId = suggestion.data.tasks[0].id;

  // 3. Check if task exists and get details
  const task = await cleo_query({
    domain: "tasks",
    operation: "get",
    params: { taskId }
  });

  console.log(`Working on: ${task.data.task.title}`);

  // 4. Check dependencies
  const deps = await cleo_query({
    domain: "tasks",
    operation: "deps",
    params: { taskId, direction: "upstream" }
  });

  if (deps.data.upstream.some(d => d.status !== "done")) {
    console.log("Warning: Some dependencies not complete");
  }

  // 5. Set focus
  await cleo_mutate({
    domain: "session",
    operation: "focus.set",
    params: { taskId }
  });

  // 6. Update status to active
  await cleo_mutate({
    domain: "tasks",
    operation: "update",
    params: { taskId, status: "active" }
  });

  // ... do work ...

  // 7. Complete task
  await cleo_mutate({
    domain: "tasks",
    operation: "complete",
    params: {
      taskId,
      notes: "Implementation complete with tests"
    }
  });

  console.log("Task completed successfully!");
}
```

---

## Next Steps

- [Session Management](session-management.md) - Managing work sessions
- [Orchestration](orchestration.md) - Multi-agent coordination
- [Research Workflow](research-workflow.md) - Research and manifest
