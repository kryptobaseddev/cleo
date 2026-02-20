# TODO.json Schema: Critical Analysis & Optimized Design

## Executive Summary

The provided schema is **over-engineered for LLM agent workflows** and contains several anti-patterns that will degrade agent performance. This document provides a critical analysis and presents an optimized alternative designed specifically for LLM-assisted development.

---

## Part 1: Critical Analysis of Provided Schema

### 🔴 Critical Issues

#### 1. Token Bloat from Computed Metrics
```json
"globalMetrics": {
  "totalTodos": 45,
  "completedTodos": 12,
  "inProgressTodos": 3,
  "notStartedTodos": 28,
  "blockedTodos": 2,
  "completionPercentage": 26.67,
  ...
}
```

**Problem**: These values are all computable from the task list. Storing them:
- Creates sync bugs when tasks change but metrics don't update
- Wastes tokens on every context load
- Requires maintenance logic to keep consistent

**Fix**: Compute on read, don't store.

---

#### 2. Phase-Coupled Task IDs
```json
"id": "P1-3"  // Pattern: P{phase}-{number}
```

**Problem**: Coupling task IDs to phases creates:
- ID collisions when tasks move between phases
- Inability to reorganize without breaking references
- Dependency tracking nightmares

**Fix**: Use UUIDs or sequential IDs like `T001`, `T002`.

---

#### 3. Deeply Nested Structure
```
phases → PHASE_1 → todos → [task objects]
```

**Problem**: 
- Harder for LLMs to parse and update
- Requires knowing phase before accessing task
- Flat structures are easier to query/filter

**Research shows**: LLMs perform better with flat, directly-addressable data.

---

#### 4. Unbounded Growth Sections
```json
"changelog": [...],  // Grows forever
"riskRegister": [...],  // Rarely pruned
"milestones": [...]  // Accumulates
```

**Problem**: These sections grow indefinitely, eventually dominating the file and wasting context window.

**Fix**: Move to separate files or auto-archive old entries.

---

#### 5. Irrelevant for LLM Workflows
```json
"teamMembers": [...],
"estimatedHours": 4,
"actualHours": 6.5,
"assignee": "John"
```

**Problem**: 
- Solo developers and LLM agents don't need team management
- Time tracking is notoriously inaccurate and rarely useful
- LLMs don't track time and can't use this information

---

#### 6. Missing Critical LLM Agent Features

The schema lacks:
- **Current focus indicator**: What should the agent work on NOW?
- **Session context**: What happened in the last session?
- **Next action hints**: What to do when unblocked?
- **Blocking chain visibility**: Which tasks block which?
- **Quick access to actionable items**: Filter for "ready to work"

---

### 🟡 Moderate Issues

#### 7. Overloaded Implementation Object
```json
"implementation": {
  "description": "...",
  "files": [...],
  "functions": [...],
  "commands": [...],
  "tests": [...],
  "documentation": [...],
  "enhanceFiles": [...],
  "newFiles": [...],
  "integrations": [...]
}
```

**Problem**: 9 sub-arrays is excessive. Most remain empty, adding noise.

**Fix**: Consolidate to essentials: `files`, `notes`, `verification`.

---

#### 8. Status Enum Overload
```json
"status": ["NOT_STARTED", "IN_PROGRESS", "IN_REVIEW", "COMPLETED", "BLOCKED", "CANCELLED"]
```

**Problem**: "IN_REVIEW" is workflow-specific and doesn't apply to solo/LLM work.

**Fix**: Simpler: `pending`, `active`, `blocked`, `done`.

---

#### 9. Configuration in Task File
```json
"configuration": {
  "defaultPriority": "MEDIUM",
  "workingDaysPerWeek": 5,
  "sprintLengthDays": 14,
  ...
}
```

**Problem**: Configuration changes rarely; mixing with tasks creates unnecessary updates.

**Fix**: Separate `todo-config.json` file.

---

### 🟢 Good Elements to Keep

✓ **Acceptance criteria** - Clear completion conditions
✓ **Dependencies array** - Explicit blocking relationships  
✓ **Labels/tags** - Flexible categorization
✓ **Notes array** - Context and decisions
✓ **Priority levels** - Clear ordering
✓ **Phase grouping concept** - Useful for organization (but should be flatter)

---

## Part 2: Design Principles for LLM-Optimized Task Tracking

### Principle 1: Flat Over Nested
LLMs parse flat structures more reliably. Direct task access beats traversing hierarchies.

### Principle 2: Computed Over Stored
Never store what can be computed. Eliminates sync bugs and saves tokens.

### Principle 3: Actionable Over Archival
Active file contains only actionable items. Archive completed/cancelled separately.

### Principle 4: Explicit Focus
Clear "what to work on next" signal. LLMs need direction.

### Principle 5: Minimal but Sufficient
Every field must earn its place. If it's rarely used, it's noise.

### Principle 6: Stable IDs
IDs must survive reorganization. Never couple to structure.

### Principle 7: Session Awareness
Track what happened last session for continuity.

### Principle 8: Separation of Concerns
- Active tasks: `todo.json`
- Completed tasks: `todo-archive.json`
- Configuration: `todo-config.json` (optional)
- History: `todo-log.json` (optional)

---

## Part 3: Optimized Schema Design

### File: `todo.json` (Primary - Always Loaded)

```json
{
  "$schema": "./todo-schema.json",
  "version": "2.0.0",
  "project": "my-project",
  "lastUpdated": "2024-12-05",
  
  "focus": {
    "currentTask": "T003",
    "blockedUntil": null,
    "sessionNote": "Implementing auth middleware, need to add JWT validation"
  },
  
  "tasks": [
    {
      "id": "T001",
      "title": "Set up database schema",
      "status": "done",
      "priority": "high",
      "phase": "foundation",
      "description": "Create initial Drizzle schema for users and sessions",
      "files": ["src/db/schema.ts", "src/db/migrations/"],
      "acceptance": [
        "Schema compiles without errors",
        "Migration runs successfully",
        "Can insert and query test user"
      ],
      "completedAt": "2024-12-03"
    },
    {
      "id": "T002",
      "title": "Implement user registration",
      "status": "done",
      "priority": "high",
      "phase": "auth",
      "description": "Email/password registration with validation",
      "files": ["src/routes/auth/register/+page.svelte", "src/lib/auth.ts"],
      "acceptance": [
        "Form validates email format",
        "Password meets strength requirements",
        "User created in database",
        "Confirmation email sent"
      ],
      "depends": ["T001"],
      "completedAt": "2024-12-04"
    },
    {
      "id": "T003",
      "title": "Add JWT authentication middleware",
      "status": "active",
      "priority": "high",
      "phase": "auth",
      "description": "Protect API routes with JWT validation",
      "files": ["src/hooks.server.ts", "src/lib/jwt.ts"],
      "acceptance": [
        "Middleware validates JWT on protected routes",
        "Invalid tokens return 401",
        "Expired tokens return 401 with refresh hint",
        "Valid tokens attach user to locals"
      ],
      "depends": ["T002"],
      "notes": [
        "Using jose library for JWT",
        "Token expiry: 15min access, 7d refresh"
      ]
    },
    {
      "id": "T004",
      "title": "Build login page",
      "status": "pending",
      "priority": "high",
      "phase": "auth",
      "description": "Login form with email/password",
      "files": ["src/routes/auth/login/+page.svelte"],
      "acceptance": [
        "Form submits credentials",
        "Success redirects to dashboard",
        "Failure shows error message",
        "Remember me option works"
      ],
      "depends": ["T003"]
    },
    {
      "id": "T005",
      "title": "Add password reset flow",
      "status": "blocked",
      "priority": "medium",
      "phase": "auth",
      "description": "Email-based password reset",
      "files": ["src/routes/auth/reset/"],
      "acceptance": [
        "Request form sends reset email",
        "Reset link valid for 1 hour",
        "New password meets requirements",
        "Old sessions invalidated"
      ],
      "depends": ["T002"],
      "blockedBy": "Waiting for email service configuration",
      "notes": ["Need to set up Resend or similar"]
    }
  ],
  
  "phases": {
    "foundation": { "order": 1, "name": "Foundation & Setup" },
    "auth": { "order": 2, "name": "Authentication System" },
    "core": { "order": 3, "name": "Core Features" },
    "polish": { "order": 4, "name": "Polish & Launch" }
  },
  
  "labels": {
    "bug": [],
    "feature": ["T002", "T003", "T004", "T005"],
    "security": ["T003", "T005"],
    "urgent": []
  }
}
```

---

### Schema Definition: `todo-schema.json`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "todo-schema-v2",
  "title": "LLM-Optimized TODO Schema",
  "description": "Minimal, flat task tracking optimized for LLM agent workflows",
  "type": "object",
  "required": ["version", "project", "lastUpdated", "tasks"],
  
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Schema version (semver)"
    },
    "project": {
      "type": "string",
      "minLength": 1,
      "description": "Project identifier"
    },
    "lastUpdated": {
      "type": "string",
      "format": "date",
      "description": "Last modification date"
    },
    
    "focus": {
      "type": "object",
      "description": "Current session focus - what the agent should work on",
      "properties": {
        "currentTask": {
          "type": ["string", "null"],
          "pattern": "^T\\d+$",
          "description": "Task ID currently being worked on"
        },
        "blockedUntil": {
          "type": ["string", "null"],
          "description": "If blocked, what's needed to proceed"
        },
        "sessionNote": {
          "type": ["string", "null"],
          "description": "Context from last session for continuity"
        }
      }
    },
    
    "tasks": {
      "type": "array",
      "items": { "$ref": "#/definitions/task" },
      "description": "All active tasks (completed tasks should be archived)"
    },
    
    "phases": {
      "type": "object",
      "description": "Phase definitions for grouping tasks",
      "patternProperties": {
        "^[a-z][a-z0-9-]*$": {
          "type": "object",
          "required": ["order", "name"],
          "properties": {
            "order": { "type": "integer", "minimum": 1 },
            "name": { "type": "string" }
          }
        }
      }
    },
    
    "labels": {
      "type": "object",
      "description": "Label-to-task-IDs mapping for quick filtering",
      "patternProperties": {
        "^[a-z][a-z0-9-]*$": {
          "type": "array",
          "items": { "type": "string", "pattern": "^T\\d+$" }
        }
      }
    }
  },
  
  "definitions": {
    "task": {
      "type": "object",
      "required": ["id", "title", "status", "priority"],
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^T\\d+$",
          "description": "Unique task ID (T001, T002, etc.)"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100,
          "description": "Brief, actionable task title"
        },
        "status": {
          "type": "string",
          "enum": ["pending", "active", "blocked", "done"],
          "description": "Current task status"
        },
        "priority": {
          "type": "string",
          "enum": ["critical", "high", "medium", "low"],
          "description": "Task priority"
        },
        "phase": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]*$",
          "description": "Phase this task belongs to"
        },
        "description": {
          "type": "string",
          "description": "Detailed task description"
        },
        "files": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Files to create or modify"
        },
        "acceptance": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Testable acceptance criteria"
        },
        "depends": {
          "type": "array",
          "items": { "type": "string", "pattern": "^T\\d+$" },
          "description": "Task IDs this depends on"
        },
        "blockedBy": {
          "type": "string",
          "description": "Reason task is blocked (if status=blocked)"
        },
        "notes": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Implementation notes, decisions, context"
        },
        "completedAt": {
          "type": "string",
          "format": "date",
          "description": "Completion date (when status=done)"
        }
      }
    }
  }
}
```

---

## Part 4: Usage Patterns for LLM Agents

### Pattern 1: Session Start
```
LLM reads todo.json
→ Checks focus.currentTask
→ If null, finds next actionable task (pending with no unmet dependencies)
→ Sets focus.currentTask
→ Reads task details and begins work
```

### Pattern 2: Task Completion
```
LLM completes task
→ Sets task.status = "done"
→ Sets task.completedAt = today
→ Updates focus.sessionNote with summary
→ Clears focus.currentTask
→ Optionally identifies next task
```

### Pattern 3: Getting Blocked
```
LLM encounters blocker
→ Sets task.status = "blocked"
→ Sets task.blockedBy = "description of blocker"
→ Updates focus.blockedUntil
→ Moves to different actionable task or reports to user
```

### Pattern 4: Session End
```
LLM pauses work
→ Updates focus.sessionNote with current state
→ Notes any partial progress
→ Saves todo.json
```

### Pattern 5: Archiving (Periodic)
```
Move tasks with status="done" older than X days
→ Append to todo-archive.json
→ Remove from todo.json
→ Keeps active file lean
```

---

## Part 5: CLAUDE.md Integration

Add to your CLAUDE.md:

```markdown
## Task Tracking

Project tasks are tracked in `todo.json`. When starting work:

1. Read `todo.json` to understand current state
2. Check `focus.currentTask` for active work
3. If no active task, find next actionable pending task
4. Update task status as you work
5. Before ending session, update `focus.sessionNote`

### Task Lifecycle
- `pending` → Ready to start (all dependencies met)
- `active` → Currently being worked on
- `blocked` → Cannot proceed (set blockedBy reason)
- `done` → Completed (set completedAt date)

### Rules
- Only one task should be `active` at a time
- Always set `focus.currentTask` when starting work
- Update `focus.sessionNote` with context for next session
- Keep completed tasks until periodic archive (manual or scripted)
```

---

## Part 6: Comparison Summary

| Aspect | Original Schema | Optimized Schema |
|--------|----------------|------------------|
| Structure | Deeply nested | Flat array |
| Task IDs | Phase-coupled (`P1-3`) | Stable (`T003`) |
| Metrics | Stored (sync bugs) | Computed on read |
| Status values | 6 options | 4 options |
| Time tracking | Full (hours) | None (rarely useful) |
| Team features | Included | Removed |
| Risk register | Included | Removed |
| Changelog | Embedded | Separate file |
| Config | Embedded | Separate file |
| Focus tracking | None | Explicit |
| Session context | None | Included |
| Typical size | 500+ lines | 50-150 lines |
| Token cost | High | Low |

---

## Part 7: Migration Guide

### From Original to Optimized

1. **Extract tasks from phases**
   - Flatten `phases.PHASE_N.todos` → `tasks`
   - Convert `P1-3` → `T003` (renumber sequentially)

2. **Simplify status**
   - `NOT_STARTED` → `pending`
   - `IN_PROGRESS` → `active`
   - `BLOCKED` → `blocked`
   - `COMPLETED` → `done`
   - `IN_REVIEW` → `active` (add note)
   - `CANCELLED` → Remove or archive

3. **Move completed tasks**
   - Tasks with `status: done` older than 7 days → `todo-archive.json`

4. **Extract configuration**
   - Move `configuration` → `todo-config.json`

5. **Remove unused sections**
   - Delete `globalMetrics` (compute instead)
   - Delete `teamMembers` (unless needed)
   - Delete `riskRegister` (overkill)
   - Move `changelog` → `todo-log.json`

6. **Add focus object**
   - Identify current active task
   - Add session context

---

## Conclusion

The original schema is designed for traditional project management with human teams. For LLM agent workflows, you need:

- **Lean context**: Every token counts
- **Flat access**: Direct task addressing
- **Clear focus**: What to work on NOW
- **Session continuity**: What happened last time
- **Computed metrics**: No sync bugs
- **Stable IDs**: Survive reorganization

The optimized schema reduces typical file size by 70-80% while adding features specifically valuable for LLM agents.
