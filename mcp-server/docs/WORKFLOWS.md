# CLEO MCP Server Workflows

**Real-world scenarios and best practices**

---

## Table of Contents

1. [Task Management Workflows](#1-task-management-workflows)
2. [Session Workflows](#2-session-workflows)
3. [Epic Orchestration Workflows](#3-epic-orchestration-workflows)
4. [Research Workflows](#4-research-workflows)
5. [Lifecycle Management Workflows](#5-lifecycle-management-workflows)
6. [Release Workflows](#6-release-workflows)
7. [Best Practices](#7-best-practices)

---

## 1. Task Management Workflows

### 1.1 Complete Task Lifecycle

**Scenario**: Create, work on, and complete a task with proper tracking.

```typescript
// 1. Search for existing task
const existing = await cleo_query({
  domain: "tasks",
  operation: "find",
  params: { query: "API documentation" }
});

if (existing.data.length > 0) {
  console.log("Task already exists:", existing.data[0].id);
  // Use existing task...
} else {
  // 2. Create new task
  const task = await cleo_mutate({
    domain: "tasks",
    operation: "add",
    params: {
      title: "Update API documentation",
      description: "Document cleo_query and cleo_mutate operations with comprehensive examples",
      priority: 1
    }
  });

  const taskId = task.data.taskId;
  console.log("Created:", taskId);

  // 3. Get full task details
  const details = await cleo_query({
    domain: "tasks",
    operation: "show",
    params: { taskId }
  });

  // 4. Start work - set focus
  await cleo_mutate({
    domain: "tasks",
    operation: "start",
    params: { taskId }
  });

  // 5. Update status to active
  await cleo_mutate({
    domain: "tasks",
    operation: "update",
    params: {
      taskId,
      status: "active",
      notes: "Started documentation work"
    }
  });

  // 6. Do work...
  console.log("Working on task...");

  // 7. Add progress notes
  await cleo_mutate({
    domain: "tasks",
    operation: "update",
    params: {
      taskId,
      notes: "Completed cleo_query examples"
    }
  });

  // 8. Complete task
  await cleo_mutate({
    domain: "tasks",
    operation: "complete",
    params: {
      taskId,
      notes: "API documentation complete with 25 examples",
      archive: true
    }
  });

  console.log("Task complete!");
}
```

### 1.2 Epic with Subtasks

**Scenario**: Create an epic with dependent tasks.

```typescript
// 1. Create epic
const epic = await cleo_mutate({
  domain: "tasks",
    operation: "add",
    params: {
      title: "Authentication System",
      description: "Complete JWT-based authentication with refresh tokens and session management"
  }
});

const epicId = epic.data.taskId;

// 2. Create research task
const research = await cleo_mutate({
  domain: "tasks",
    operation: "add",
    params: {
      title: "Research auth best practices",
      description: "Research JWT standards, refresh token patterns, and security best practices",
    parent: epicId
  }
});

// 3. Create specification task (depends on research)
const spec = await cleo_mutate({
  domain: "tasks",
    operation: "add",
    params: {
      title: "Auth system specification",
      description: "Write RFC-style specification for authentication system",
    parent: epicId,
    depends: [research.data.taskId]
  }
});

// 4. Create implementation tasks (depend on spec)
const impl1 = await cleo_mutate({
  domain: "tasks",
    operation: "add",
    params: {
      title: "Implement JWT generation",
      description: "Create JWT token generation and validation functions",
    parent: epicId,
    depends: [spec.data.taskId]
  }
});

const impl2 = await cleo_mutate({
  domain: "tasks",
    operation: "add",
    params: {
      title: "Implement refresh token flow",
      description: "Add refresh token rotation and storage",
    parent: epicId,
    depends: [spec.data.taskId]
  }
});

// 5. Create testing task (depends on all implementations)
const test = await cleo_mutate({
  domain: "tasks",
    operation: "add",
    params: {
      title: "Auth system tests",
      description: "Write comprehensive test suite for authentication",
    parent: epicId,
    depends: [impl1.data.taskId, impl2.data.taskId]
  }
});

// 6. View task tree
const tree = await cleo_query({
  domain: "tasks",
  operation: "tree",
  params: {
    rootId: epicId,
    depth: 3
  }
});

console.log(JSON.stringify(tree.data, null, 2));
```

### 1.3 Dependency Management

**Scenario**: Check and manage task dependencies.

```typescript
// 1. Check if task is blocked
const blockers = await cleo_query({
  domain: "tasks",
  operation: "blockers",
  params: { taskId: "T2950" }
});

if (blockers.data.length > 0) {
  console.log("Task blocked by:", blockers.data.map(b => b.id));

  // Complete blocking tasks first
  for (const blocker of blockers.data) {
    if (blocker.status !== "done") {
      console.log(`Complete ${blocker.id}: ${blocker.title}`);
    }
  }
} else {
  console.log("Task ready to start!");
}

// 2. View full dependency graph
  const deps = await cleo_query({
    domain: "tasks",
    operation: "depends",
    params: {
      taskId: "T2950",
      direction: "both"  // upstream and downstream
  }
});

console.log("Dependencies:", deps.data);

// 3. Check for circular dependencies
try {
  await cleo_mutate({
    domain: "tasks",
    operation: "update",
    params: {
      taskId: "T2950",
      depends: ["T2951"]  // If T2951 depends on T2950
    }
  });
} catch (error) {
  if (error.exitCode === 13) {
    console.error("Circular dependency detected!");
    console.error(error.details.cycle);
  }
}
```

### 1.4 Task Prioritization

**Scenario**: Analyze and prioritize tasks.

```typescript
// 1. Analyze epic for priority recommendations
const analysis = await cleo_query({
  domain: "tasks",
  operation: "analyze",
  params: { epicId: "T2908" }
});

console.log("Priority recommendations:", analysis.data);

// 2. Get next suggested task
const next = await cleo_query({
  domain: "tasks",
  operation: "next",
  params: {
    epicId: "T2908",
    count: 3
  }
});

console.log("Top 3 next tasks:", next.data);

// 3. Update priorities based on analysis
for (const task of analysis.data.recommendations) {
  await cleo_mutate({
    domain: "tasks",
    operation: "update",
    params: {
      taskId: task.id,
      priority: task.suggestedPriority
    }
  });
}
```

---

## 2. Session Workflows

### 2.1 Single Session Workflow

**Scenario**: Simple single-session work session.

```typescript
// 1. List existing sessions
const sessions = await cleo_query({
  domain: "session",
  operation: "list",
  params: { active: true }
});

if (sessions.data.length > 0) {
  console.log("Active session exists:", sessions.data[0].id);

  // Resume existing session
  await cleo_mutate({
    domain: "session",
    operation: "resume",
    params: { sessionId: sessions.data[0].id }
  });

} else {
  // 2. Start new session
  await cleo_mutate({
    domain: "session",
    operation: "start",
    params: {
      scope: "epic:T2908",
      name: "MCP Server Documentation",
      autoStart: true
    }
  });
}

// 3. Check current status
const status = await cleo_query({
  domain: "session",
  operation: "status"
});

console.log("Current session:", status.data);
console.log("Focused task:", status.data.focusedTask);

// 4. Work on tasks...
// (create, update, complete operations)

// 5. End session
await cleo_mutate({
  domain: "session",
  operation: "end",
  params: {
    notes: "Completed USAGE-GUIDE.md, QUICK-START.md, and WORKFLOWS.md"
  }
});

console.log("Session ended");
```

### 2.2 Multi-Session Workflow

**Scenario**: Switch between multiple active sessions.

```typescript
// 1. List all sessions
const allSessions = await cleo_query({
  domain: "session",
  operation: "list"
});

console.log("All sessions:", allSessions.data);

// 2. Start documentation session
const docSession = await cleo_mutate({
  domain: "session",
  operation: "start",
  params: {
    scope: "epic:T2908",
    name: "Documentation Work"
  }
});

// 3. Work on documentation task
  await cleo_mutate({
    domain: "tasks",
    operation: "start",
    params: { taskId: "T2938" }
  });

  // Do documentation work...

  // 4. Suspend documentation session
await cleo_mutate({
  domain: "session",
  operation: "suspend",
  params: {
    notes: "Pausing for code review"
  }
});

// 5. Start review session
await cleo_mutate({
  domain: "session",
  operation: "start",
  params: {
    scope: "epic:T2900",
    name: "Code Review",
      autoStart: true
    }
  });

  // Do code review...

// 6. End review session
await cleo_mutate({
  domain: "session",
  operation: "end",
  params: {
    notes: "Code review complete"
  }
});

// 7. Resume documentation session
await cleo_mutate({
  domain: "session",
  operation: "resume",
  params: { sessionId: docSession.data.sessionId }
});

// Continue documentation work...

// 8. End documentation session
await cleo_mutate({
  domain: "session",
  operation: "end",
  params: {
    notes: "Documentation complete"
  }
});
```

### 2.3 Focus Management

**Scenario**: Manage task focus during work session.

```typescript
// 1. Get current focus
const currentFocus = await cleo_query({
  domain: "tasks",
  operation: "current"
});

if (currentFocus.data) {
  console.log("Currently focused:", currentFocus.data);
} else {
  console.log("No focus set");
}

// 2. Set focus to new task
await cleo_mutate({
  domain: "tasks",
  operation: "start",
  params: { taskId: "T2938" }
});

// 3. Work on focused task...

// 4. Switch focus to next task
await cleo_mutate({
  domain: "tasks",
  operation: "start",
  params: { taskId: "T2939" }
});

// 5. Clear focus temporarily
await cleo_mutate({
  domain: "tasks",
  operation: "stop"
});

// 6. View focus history
const history = await cleo_query({
  domain: "session",
  operation: "history",
  params: { limit: 10 }
});

console.log("Recent focus changes:", history.data);
```

---

## 3. Epic Orchestration Workflows

### 3.1 Orchestrator Initialization

**Scenario**: Initialize and analyze epic for orchestration.

```typescript
// 1. Initialize orchestration
const startup = await cleo_mutate({
  domain: "orchestrate",
  operation: "start",
  params: { epicId: "T2908" }
});

console.log("Epic:", startup.data.epic);
console.log("Total tasks:", startup.data.totalTasks);
console.log("Ready tasks:", startup.data.readyTasks);
console.log("Waves:", startup.data.waves);

// 2. Analyze dependency structure
const analysis = await cleo_query({
  domain: "orchestrate",
  operation: "analyze",
  params: { epicId: "T2908" }
});

console.log("Wave structure:", analysis.data.waves);
console.log("Critical path:", analysis.data.criticalPath);
console.log("Parallelization potential:", analysis.data.parallelTasks);

// 3. Check context budget
const context = await cleo_query({
  domain: "orchestrate",
  operation: "context",
  params: { tokens: 200000 }
});

console.log("Context status:", context.data.status);
console.log("Available:", context.data.available);
console.log("Used:", context.data.used);

if (context.data.status === "critical") {
  console.warn("Context budget critical!");
}

// 4. List available skills
const skills = await cleo_query({
  domain: "orchestrate",
  operation: "skill.list",
  params: { filter: "implementation" }
});

console.log("Available skills:", skills.data);
```

### 3.2 Sequential Task Spawning

**Scenario**: Spawn tasks one at a time with validation.

```typescript
async function spawnSequential(epicId) {
  while (true) {
    // 1. Get next task
    const next = await cleo_query({
      domain: "orchestrate",
      operation: "next",
      params: { epicId }
    });

    if (!next.data) {
      console.log("No more tasks to spawn");
      break;
    }

    const taskId = next.data.taskId;
    console.log(`Next task: ${taskId} - ${next.data.title}`);

    // 2. Check lifecycle prerequisites
    const lifecycle = await cleo_query({
      domain: "lifecycle",
      operation: "validate",
      params: {
        taskId,
        targetStage: "implementation"
      }
    });

    if (!lifecycle.data.passed) {
      console.error("Lifecycle gate failed!");
      console.error("Missing:", lifecycle.data.missingPrerequisites);

      // Complete prerequisites first
      for (const stage of lifecycle.data.missingPrerequisites) {
        await cleo_mutate({
          domain: "lifecycle",
          operation: "record",
          params: {
            taskId,
            stage,
            status: "completed",
            notes: `Completed ${stage} stage`
          }
        });
      }

      // Retry gate check
      continue;
    }

    // 3. Validate spawn readiness
    const validation = await cleo_mutate({
      domain: "orchestrate",
      operation: "validate",
      params: { taskId }
    });

    if (!validation.data.ready) {
      console.error("Spawn validation failed:", validation.data.issues);
      break;
    }

    // 4. Generate spawn prompt
    const spawn = await cleo_mutate({
      domain: "orchestrate",
      operation: "spawn",
      params: {
        taskId,
        skill: next.data.recommendedSkill,
        model: "sonnet"
      }
    });

    console.log("Spawn prompt generated");
    console.log("Skill:", spawn.data.metadata.skill);
    console.log("Tokens:", spawn.data.metadata.tokenCount);

    // 5. Spawn subagent (using Task tool)
    // ... spawn implementation ...

    // 6. Wait for completion...
    console.log("Waiting for subagent completion...");
  }
}

// Run orchestration
await spawnSequential("T2908");
```

### 3.3 Parallel Wave Execution

**Scenario**: Execute tasks in parallel waves.

```typescript
async function spawnParallel(epicId) {
  // 1. Get wave structure
  const waves = await cleo_query({
    domain: "orchestrate",
    operation: "waves",
    params: { epicId }
  });

  console.log(`Total waves: ${waves.data.length}`);

  for (let i = 0; i < waves.data.length; i++) {
    const wave = waves.data[i];
    console.log(`\nWave ${i + 1}: ${wave.tasks.length} tasks`);

    // 2. Start parallel wave
    await cleo_mutate({
      domain: "orchestrate",
      operation: "parallel.start",
      params: {
        epicId,
        wave: i + 1
      }
    });

    // 3. Get parallel-safe tasks
    const ready = await cleo_query({
      domain: "orchestrate",
      operation: "ready",
      params: { epicId }
    });

    console.log("Ready tasks:", ready.data.taskIds);

    // 4. Spawn all tasks in parallel
    const spawnPromises = ready.data.taskIds.map(async (taskId) => {
      // Check lifecycle
      const lifecycle = await cleo_query({
        domain: "lifecycle",
        operation: "validate",
        params: { taskId, targetStage: "implementation" }
      });

      if (!lifecycle.data.passed) {
        console.warn(`Skipping ${taskId}: lifecycle gate failed`);
        return null;
      }

      // Generate spawn prompt
      const spawn = await cleo_mutate({
        domain: "orchestrate",
        operation: "spawn",
        params: { taskId }
      });

      console.log(`Spawned: ${taskId}`);
      return spawn.data;
    });

    const spawned = await Promise.all(spawnPromises);
    const validSpawns = spawned.filter(s => s !== null);

    console.log(`Spawned ${validSpawns.length} tasks in parallel`);

    // 5. Wait for all to complete...
    console.log("Waiting for wave completion...");

    // 6. End parallel wave
    await cleo_mutate({
      domain: "orchestrate",
      operation: "parallel.end",
      params: {
        epicId,
        wave: i + 1
      }
    });

    console.log(`Wave ${i + 1} complete`);
  }

  console.log("\nAll waves complete!");
}

// Run parallel orchestration
await spawnParallel("T2908");
```

---

## 4. Research Workflows

### 4.1 Research Entry Management

**Scenario**: Create and link research to tasks.

```typescript
// 1. Query existing research
const existing = await cleo_query({
  domain: "research",
  operation: "find",
  params: {
    query: "MCP server architecture",
    confidence: 0.7
  }
});

if (existing.data.length > 0) {
  console.log("Found existing research:", existing.data);
} else {
  console.log("No existing research found");
}

// 2. Show research details
const entry = await cleo_query({
  domain: "research",
  operation: "show",
  params: {
    researchId: existing.data[0].id
  }
});

console.log("Research entry:", entry.data);
console.log("Key findings:", entry.data.key_findings);

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

console.log("Research linked to task");

// 4. Get research statistics
const stats = await cleo_query({
  domain: "research",
  operation: "stats",
  params: { epicId: "T2908" }
});

console.log("Research stats:", stats.data);
console.log("Total entries:", stats.data.total);
console.log("Average confidence:", stats.data.avgConfidence);
```

### 4.2 Manifest Management

**Scenario**: Append and manage manifest entries.

```typescript
// 1. Append new manifest entry
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
      topics: ["mcp", "documentation", "usage", "workflows"],
      key_findings: [
        "Created comprehensive 8-section usage guide",
        "Documented all 96 operations across 8 domains",
        "Provided 15+ real-world workflow examples",
        "Included complete troubleshooting guide"
      ],
      actionable: true,
      needs_followup: [],
      linked_tasks: ["T2908", "T2938"]
    },
    validateFile: true
  }
});

console.log("Manifest entry appended");

// 2. Read manifest entries
const manifest = await cleo_query({
  domain: "research",
  operation: "manifest.read",
  params: {
    filter: { status: "complete" },
    limit: 10
  }
});

console.log("Recent manifest entries:", manifest.data);

// 3. Get pending research (needs follow-up)
const pending = await cleo_query({
  domain: "research",
  operation: "pending",
  params: { epicId: "T2908" }
});

if (pending.data.length > 0) {
  console.log("Pending research:", pending.data);

  for (const item of pending.data) {
    console.log(`Follow up: ${item.id} - ${item.needs_followup.join(", ")}`);
  }
}

// 4. Archive old entries
await cleo_mutate({
  domain: "research",
  operation: "manifest.archive",
  params: {
    beforeDate: "2026-01-01",
    moveFiles: true
  }
});

console.log("Old entries archived");
```

---

## 5. Lifecycle Management Workflows

### 5.1 RCSD Pipeline

**Scenario**: Complete RCSD stages (Research, Consensus, Specification, Decomposition).

```typescript
const taskId = "T2945";

// 1. Research stage
await cleo_mutate({
  domain: "lifecycle",
  operation: "record",
  params: {
    taskId,
    stage: "research",
    status: "completed",
    notes: "Reviewed MCP spec, CLEO architecture, and existing implementations"
  }
});

// 2. Consensus stage (skip for single-agent)
await cleo_mutate({
  domain: "lifecycle",
  operation: "skip",
  params: {
    taskId,
    stage: "consensus",
    reason: "Single-agent task, no multi-agent consensus required"
  }
});

// 3. Specification stage
await cleo_mutate({
  domain: "lifecycle",
  operation: "record",
  params: {
    taskId,
    stage: "specification",
    status: "completed",
    notes: "Created RFC-style specification with MUST/SHOULD/MAY requirements"
  }
});

// 4. Decomposition stage
await cleo_mutate({
  domain: "lifecycle",
  operation: "record",
  params: {
    taskId,
    stage: "decomposition",
    status: "completed",
    notes: "Broke down into 5 atomic tasks with clear dependencies"
  }
});

// 5. Check RCSD status
const status = await cleo_query({
  domain: "lifecycle",
  operation: "status",
  params: { taskId }
});

console.log("RCSD stages:", status.data.rcsd);
console.log("All complete:", status.data.rcsd.every(s => s.status === "completed" || s.status === "skipped"));
```

### 5.2 IVTR Pipeline

**Scenario**: Complete IVTR stages (Implementation, Validation, Testing, Release).

```typescript
const taskId = "T2945";

// 1. Check RCSD prerequisites
const lifecycle = await cleo_query({
  domain: "lifecycle",
  operation: "validate",
  params: {
    taskId,
    targetStage: "implementation"
  }
});

if (!lifecycle.data.passed) {
  console.error("RCSD not complete!");
  return;
}

// 2. Implementation stage
await cleo_mutate({
  domain: "lifecycle",
  operation: "record",
  params: {
    taskId,
    stage: "implementation",
    status: "completed",
    notes: "Implemented with @task provenance tags"
  }
});

// 3. Mark implementation gate passed
await cleo_mutate({
  domain: "lifecycle",
  operation: "gate.pass",
  params: {
    taskId,
    gateName: "implemented",
    agent: "cleo-subagent",
    notes: "Code complete with provenance"
  }
});

// 4. Validation stage
await cleo_mutate({
  domain: "lifecycle",
  operation: "record",
  params: {
    taskId,
    stage: "validation",
    status: "completed",
    notes: "Protocol compliance validated"
  }
});

// 5. Testing stage
await cleo_mutate({
  domain: "lifecycle",
  operation: "record",
  params: {
    taskId,
    stage: "testing",
    status: "completed",
    notes: "All tests passing, 100% coverage"
  }
});

// 6. Mark test gate passed
await cleo_mutate({
  domain: "lifecycle",
  operation: "gate.pass",
  params: {
    taskId,
    gateName: "testsPassed",
    agent: "test-agent",
    notes: "25/25 tests passing"
  }
});

// 7. Check all gates
const gates = await cleo_query({
  domain: "lifecycle",
  operation: "gates",
  params: { taskId }
});

console.log("Gate status:", gates.data);

// 8. View lifecycle history
const history = await cleo_query({
  domain: "lifecycle",
  operation: "history",
  params: { taskId }
});

console.log("Lifecycle transitions:", history.data);
```

### 5.3 Emergency Reset

**Scenario**: Reset lifecycle stage in emergency.

```typescript
// EMERGENCY ONLY - Use with caution

const taskId = "T2945";

// 1. Check current state
const status = await cleo_query({
  domain: "lifecycle",
  operation: "status",
  params: { taskId }
});

console.log("Current state:", status.data);

// 2. Reset implementation stage (e.g., due to critical bug)
await cleo_mutate({
  domain: "lifecycle",
  operation: "reset",
  params: {
    taskId,
    stage: "implementation",
    reason: "Critical security vulnerability found, must re-implement"
  }
});

console.log("Stage reset - all downstream gates also reset");

// 3. Re-implement...

// 4. Progress through stages again
await cleo_mutate({
  domain: "lifecycle",
  operation: "record",
  params: {
    taskId,
    stage: "implementation",
    status: "completed",
    notes: "Re-implemented with security fix"
  }
});
```

---

## 6. Release Workflows

### 6.1 Complete Release Process

**Scenario**: Prepare and execute a version release.

```typescript
const version = "1.1.0";

// 1. Run release gates
const gates = await cleo_mutate({
  domain: "release",
  operation: "gates.run",
  params: {
    gates: ["tests", "lint", "security", "build"]
  }
});

if (!gates.data.passed) {
  console.error("Release gates failed:", gates.data.failed);
  return;
}

// 2. Prepare release
await cleo_mutate({
  domain: "release",
  operation: "prepare",
  params: {
    version,
    type: "minor"
  }
});

// 3. Generate changelog
const changelog = await cleo_mutate({
  domain: "release",
  operation: "changelog",
  params: {
    version,
    sections: ["features", "fixes", "breaking"]
  }
});

console.log("Changelog:", changelog.data);

// 4. Create release commit
await cleo_mutate({
  domain: "release",
  operation: "commit",
  params: {
    version,
    files: ["VERSION", "CHANGELOG.md", "package.json"]
  }
});

// 5. Create git tag
await cleo_mutate({
  domain: "release",
  operation: "tag",
  params: {
    version,
    message: `Release v${version}`
  }
});

// 6. Push to remote
await cleo_mutate({
  domain: "release",
  operation: "push",
  params: {
    version,
    remote: "origin"
  }
});

console.log(`Release ${version} complete!`);
```

### 6.2 Rollback Release

**Scenario**: Rollback a failed release.

```typescript
const version = "1.1.0";

// Rollback release
await cleo_mutate({
  domain: "release",
  operation: "rollback",
  params: {
    version,
    reason: "Critical bug in production"
  }
});

console.log(`Release ${version} rolled back`);
```

---

## 7. Best Practices

### 7.1 Error Handling

```typescript
async function safeOperation(operation) {
  try {
    const result = await operation();

    if (!result.success) {
      console.error('Error:', result.error.message);
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
    console.error('Exception:', error);
    throw error;
  }
}
```

### 7.2 Context Management

```typescript
// Check context before expensive operations
const context = await cleo_query({
  domain: "orchestrate",
  operation: "context",
  params: { tokens: 200000 }
});

if (context.data.status === "critical") {
  console.warn("Context critical - optimize queries");
}

// Use find instead of list for discovery
const tasks = await cleo_query({
  domain: "tasks",
  operation: "find",  // Minimal fields
  params: { query: "auth" }
});

// Then get full details only for selected task
const task = await cleo_query({
  domain: "tasks",
  operation: "show",  // Full details
  params: { taskId: tasks.data[0].id }
});
```

### 7.3 Validation Before Mutation

```typescript
// Always validate before expensive mutations

// 1. Check task exists
const exists = await cleo_query({
  domain: "tasks",
  operation: "exists",
  params: { taskId: "T2950" }
});

if (!exists.data) {
  console.error("Task not found");
  return;
}

// 2. Check lifecycle gates
const lifecycle = await cleo_query({
  domain: "lifecycle",
  operation: "validate",
  params: {
    taskId: "T2950",
    targetStage: "implementation"
  }
});

if (!lifecycle.data.passed) {
  console.error("Prerequisites not met");
  return;
}

// 3. Safe to proceed
await cleo_mutate({
  domain: "orchestrate",
  operation: "spawn",
  params: { taskId: "T2950" }
});
```

### 7.4 Batch Operations

```typescript
// Process multiple tasks efficiently
const tasks = await cleo_query({
  domain: "tasks",
  operation: "list",
  params: {
    parent: "T2908",
    status: "pending"
  }
});

// Process in parallel
await Promise.all(
  tasks.data.map(task =>
    cleo_mutate({
      domain: "tasks",
      operation: "update",
      params: {
        taskId: task.id,
        priority: calculatePriority(task)
      }
    })
  )
);
```

---

## Next Steps

- **[Complete Usage Guide](USAGE-GUIDE.md)** - Full documentation
- **[Quick Start](QUICK-START.md)** - 5-minute setup
- **[API Reference](docs/api/overview.md)** - All operations
- **[Error Codes](docs/api/errors.md)** - Error reference
