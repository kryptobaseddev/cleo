# LLM-Optimized TODO Schema v2.0

A minimal, flat task tracking schema designed specifically for LLM agent workflows like Claude Code. Optimized for token efficiency, clear focus tracking, and session continuity.

## Why This Schema?

Traditional project management schemas are designed for human teams with time tracking, risk registers, and complex metrics. LLM agents need something different:

| Need | Solution |
|------|----------|
| Token efficiency | Flat structure, no computed fields stored |
| Clear direction | `focus` object shows current task and next action |
| Session continuity | `sessionNote` preserves context between sessions |
| Stable references | IDs like `T001` don't change when tasks move |
| Quick filtering | `labels` mapping for instant categorization |
| Clean context | Archive completed tasks to separate file |

## Quick Start

### 1. Copy the files to your project

```
your-project/
├── todo.json          # Your active tasks (copy from todo-template.json)
├── todo-schema.json   # Schema for validation
├── todo-archive.json  # Created when archiving (optional)
└── CLAUDE.md          # Add task tracking instructions
```

### 2. Add to CLAUDE.md

```markdown
## Task Tracking

Tasks are tracked in `todo.json`. 

### Session Start
1. Read `todo.json`
2. Check `focus.currentTask` - resume if set
3. If no current task, find next actionable `pending` task
4. Set `focus.currentTask` and begin work

### During Work
- Update task `status` as you progress
- Add implementation notes to `notes` array
- If blocked, set `status: "blocked"` and `blockedBy` reason

### Session End
- Update `focus.sessionNote` with current state
- Set `focus.nextAction` for clear resumption
- If task complete: set `status: "done"` and `completedAt`

### Status Values
- `pending`: Ready to start (dependencies met)
- `active`: Currently working (only ONE task at a time)
- `blocked`: Cannot proceed (blockedBy required)
- `done`: Completed (completedAt required)
```

### 3. Start tracking!

```bash
# With Claude Code
claude

# Claude will read todo.json and understand your tasks
> What's the current task status?
> Start working on the next pending task
> Mark T003 as complete
```

## Schema Structure

### Root Level

```json
{
  "version": "2.0.0",
  "project": "my-app",
  "lastUpdated": "2024-12-05",
  "focus": { ... },      // Current session state
  "tasks": [ ... ],      // Active tasks array
  "phases": { ... },     // Phase definitions
  "labels": { ... },     // Label → task ID mapping
  "archived": { ... }    // Archive summary
}
```

### Focus Object (Critical for LLM Continuity)

```json
"focus": {
  "currentTask": "T003",           // Active task ID or null
  "blockedUntil": null,            // Global blocker if any
  "sessionNote": "Implementing...", // Context from last session
  "nextAction": "Add validation"    // Specific next step
}
```

**Why this matters**: LLMs lose context between sessions. The `focus` object tells the agent exactly where to resume and what to do next.

### Task Object

```json
{
  "id": "T003",
  "title": "Add JWT authentication middleware",
  "status": "active",
  "priority": "high",
  "phase": "auth",
  "description": "Protect API routes with JWT validation...",
  "files": ["src/hooks.server.ts", "src/lib/jwt.ts"],
  "acceptance": [
    "Protected routes return 401 without valid token",
    "Valid tokens attach user to event.locals"
  ],
  "depends": ["T001", "T002"],
  "blockedBy": null,
  "notes": ["Using jose library for JWT"],
  "labels": ["feature", "security"],
  "createdAt": "2024-12-04",
  "completedAt": null
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique ID: `T001`, `T002`, etc. |
| `title` | string | Brief, actionable title |
| `status` | enum | `pending`, `active`, `blocked`, `done` |
| `priority` | enum | `critical`, `high`, `medium`, `low` |

### Optional but Recommended

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Detailed what/why |
| `files` | array | Files to create/modify |
| `acceptance` | array | Testable completion criteria |
| `depends` | array | Blocking task IDs |
| `notes` | array | Implementation context |
| `labels` | array | Categorization tags |

### Conditional Requirements

- When `status: "blocked"` → `blockedBy` is required
- When `status: "done"` → `completedAt` is required

## Task Lifecycle

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│ pending  │────▶│  active  │────▶│   done   │
└──────────┘     └──────────┘     └──────────┘
      │                │
      │                ▼
      │          ┌──────────┐
      └─────────▶│ blocked  │
                 └──────────┘
                       │
                       ▼
                 (resolve blocker)
                       │
                       ▼
                 ┌──────────┐
                 │ pending  │
                 └──────────┘
```

## Common Operations

### Find Next Actionable Task

A task is actionable when:
1. Status is `pending`
2. All tasks in `depends` have status `done`
3. Priority: `critical` > `high` > `medium` > `low`

### Start Working on a Task

```json
// Update the task
{ "status": "active" }

// Update focus
{
  "focus": {
    "currentTask": "T003",
    "sessionNote": null,
    "nextAction": null
  }
}
```

### Complete a Task

```json
// Update the task
{
  "status": "done",
  "completedAt": "2024-12-05"
}

// Update focus
{
  "focus": {
    "currentTask": null,
    "sessionNote": "Completed JWT middleware. All tests passing.",
    "nextAction": "Start T004 (login page)"
  }
}
```

### Block a Task

```json
{
  "status": "blocked",
  "blockedBy": "Waiting for API key from third-party service"
}
```

### Add a Note

Notes are append-only. Never remove, only add:

```json
{
  "notes": [
    "Using jose library for JWT",
    "Decided on 15min access / 7d refresh token expiry",
    "Added rate limiting consideration - see T007"
  ]
}
```

## Archiving Completed Tasks

To keep `todo.json` lean, periodically archive completed tasks:

### Manual Archive

1. Move tasks with `status: "done"` to `todo-archive.json`
2. Update `archived.count` and `archived.lastArchived`
3. Keep recent completions (last 3-5) for context

### Archive File Structure

```json
// todo-archive.json
{
  "version": "2.0.0",
  "project": "my-app",
  "archivedTasks": [
    {
      "id": "T001",
      "title": "Set up database schema",
      "completedAt": "2024-12-02",
      "archivedAt": "2024-12-10"
    }
  ]
}
```

## Integration with Claude Code

### Recommended CLAUDE.md Section

```markdown
## Task Management

**Read `todo.json` at session start.**

### Workflow
1. Check `focus.currentTask` for active work
2. If null, find highest priority actionable pending task
3. Before starting: set `status: "active"` and `focus.currentTask`
4. During work: add notes, update files list
5. On completion: set `status: "done"`, `completedAt`, clear focus
6. Before ending: update `focus.sessionNote` and `focus.nextAction`

### Rules
- Only ONE task should be `active` at a time
- Check `depends` before starting a `pending` task
- If blocked, set `blockedBy` with specific reason
- Never delete notes, only append
- Update `lastUpdated` when modifying todo.json

### Quick Commands
- "What's the current task?" → Check focus.currentTask
- "What's next?" → Find highest priority actionable pending
- "I'm blocked on X" → Set status:blocked, blockedBy:X
- "Done with this" → Complete current task, update focus
```

### Slash Command Example

Create `.claude/commands/task-status.md`:

```markdown
Read todo.json and provide:
1. Current focus (task ID and session note)
2. Summary: X pending, Y blocked, Z done
3. Next actionable task recommendation
4. Any blockers that need attention
```

## Why Not...?

### Why not store computed metrics?

Storing `totalTodos`, `completedTodos`, etc. creates sync bugs. When tasks change, metrics must update. Better to compute on read.

### Why not phase-coupled IDs like `P1-3`?

When you move a task between phases, the ID becomes misleading. `T003` is stable regardless of which phase it's in.

### Why not time estimates?

LLMs don't track time effectively, and humans are notoriously bad at estimation. It's noise that wastes tokens.

### Why not a risk register?

For solo/LLM-assisted work, it's overkill. If you need risk tracking, put it in a separate file.

### Why flat instead of nested?

LLMs parse and update flat structures more reliably. Direct task access beats traversing `phases.PHASE_1.todos[2]`.

## Validation

The schema includes JSON Schema validation. Use it:

```bash
# With ajv-cli
npx ajv validate -s todo-schema.json -d todo.json

# With check-jsonschema
check-jsonschema --schemafile todo-schema.json todo.json
```

## Tips for Success

1. **Keep it small**: Archive aggressively. Active file should be 50-150 lines.

2. **Write good acceptance criteria**: LLMs use these to know when they're done.

3. **Update focus religiously**: This is your continuity mechanism.

4. **Use meaningful titles**: Start with verbs: "Add", "Implement", "Fix", "Update"

5. **Group with phases**: But don't over-complicate. 3-5 phases is plenty.

6. **Label sparingly**: 5-7 labels max. Too many = noise.

7. **Add notes as you go**: Context you capture now saves confusion later.

## License

MIT - Use freely in your projects.
