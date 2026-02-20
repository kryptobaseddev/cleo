# CLAUDE TODO System - Agent Instructions

You are assisting in the development of **CLAUDE-TODO**, a repeatable drop-in task management system optimized for LLM-assisted development workflows. This system is designed to be installed once and work across any project with minimal configuration.

---

## SYSTEM IDENTITY

**What we're building**: A standardized, portable task management system that integrates with Claude Code (and similar LLM agents) to provide:
- Persistent task tracking across sessions
- Clear focus and continuity mechanisms
- Minimal token overhead
- Zero-config drop-in installation

**Core philosophy**:
1. **Simplicity over features** - Every element must earn its place
2. **Flat over nested** - LLMs parse flat structures more reliably
3. **Computed over stored** - Never store what can be calculated
4. **Portable and self-contained** - Works in any project without external dependencies
5. **Human and LLM readable** - Both can understand and modify files

---

## SYSTEM ARCHITECTURE

### Directory Structure

```
~/.claude-todo/                    # Global system (installed once)
├── core/                          # Core system files (NEVER modify per-project)
│   ├── todo-schema.json           # JSON Schema for validation
│   └── VERSION                    # System version tracker
├── templates/                     # Templates copied to projects
│   ├── todo.template.json         # Starter todo.json
│   ├── CLAUDE.todo.md             # CLAUDE.md task integration snippet
│   └── commands/                  # Optional slash commands
│       └── task-status.md
└── bin/
    └── claude-todo-init           # Installation script

{project}/                         # Per-project files (created by init script)
├── todo.json                      # Active tasks (from template)
├── todo-archive.json              # Archived completed tasks (created when needed)
├── .claude-todo-version           # Tracks which system version initialized this project
└── CLAUDE.md                      # User's CLAUDE.md (append task integration)
```

### File Relationships

```
┌─────────────────────────────────────────────────────────────────┐
│                     ~/.claude-todo/                              │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ core/        │  │ templates/       │  │ bin/             │  │
│  │ todo-schema  │  │ todo.template    │  │ claude-todo-init │  │
│  │ VERSION      │  │ CLAUDE.todo.md   │  │                  │  │
│  └──────────────┘  └──────────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
           │                    │                    │
           │                    │                    │
           ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                     {any-project}/                               │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ todo.json    │◀─│ (copied from     │  │ CLAUDE.md        │  │
│  │              │  │  template)       │  │ (appended to)    │  │
│  └──────────────┘  └──────────────────┘  └──────────────────┘  │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────┐                                               │
│  │ todo-archive │ (created when archiving)                      │
│  └──────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## CORE FILES SPECIFICATION

### 1. todo-schema.json (Core - Never Modified)

**Purpose**: JSON Schema for validating todo.json files
**Location**: `~/.claude-todo/core/todo-schema.json`

Key constraints enforced:
- Task IDs: Pattern `^T\d{3,}$` (T001, T002, etc.)
- Status: Enum `["pending", "active", "blocked", "done"]`
- Priority: Enum `["critical", "high", "medium", "low"]`
- Phase keys: Pattern `^[a-z][a-z0-9-]*$`
- Conditional: `status: "blocked"` requires `blockedBy`
- Conditional: `status: "done"` requires `completedAt`

### 2. todo.template.json (Template - Copied to Projects)

**Purpose**: Starter todo.json with placeholder values
**Location**: `~/.claude-todo/templates/todo.template.json`

Structure:
```json
{
  "$schema": "~/.claude-todo/core/todo-schema.json",
  "version": "2.0.0",
  "project": "{{PROJECT_NAME}}",
  "lastUpdated": "{{DATE}}",
  "focus": {
    "currentTask": null,
    "blockedUntil": null,
    "sessionNote": null,
    "nextAction": null
  },
  "tasks": [],
  "phases": {
    "setup": { "order": 1, "name": "Setup & Foundation" },
    "core": { "order": 2, "name": "Core Features" },
    "polish": { "order": 3, "name": "Polish & Launch" }
  },
  "labels": {
    "feature": [],
    "bug": [],
    "security": []
  },
  "archived": {
    "count": 0,
    "lastArchived": null
  }
}
```

### 3. CLAUDE.todo.md (Template - Appended to CLAUDE.md)

**Purpose**: Task management instructions for Claude Code
**Location**: `~/.claude-todo/templates/CLAUDE.todo.md`

This snippet is appended to the project's existing CLAUDE.md (or creates one if missing).

### 4. VERSION (Core - System Version)

**Purpose**: Track system version for upgrades
**Location**: `~/.claude-todo/core/VERSION`
**Format**: Single line with semver, e.g., `2.0.0`

### 5. .claude-todo-version (Per-Project)

**Purpose**: Track which system version initialized this project
**Location**: `{project}/.claude-todo-version`
**Format**: Single line with semver

---

## INITIALIZATION SCRIPT SPECIFICATION

### Script: claude-todo-init

**Location**: `~/.claude-todo/bin/claude-todo-init`
**Purpose**: Initialize any project with the TODO system

**Behavior**:

```
claude-todo-init [project-name] [options]

Arguments:
  project-name    Name for the project (default: directory name)

Options:
  --force         Overwrite existing todo.json
  --no-claude-md  Don't modify CLAUDE.md
  --dry-run       Show what would be done without doing it
  --help          Show help
```

**Script Logic**:

1. **Check prerequisites**
   - Verify ~/.claude-todo exists
   - Verify we're in a valid project directory

2. **Check for existing installation**
   - If todo.json exists and --force not set, abort with message
   - If .claude-todo-version exists, warn about re-initialization

3. **Create todo.json**
   - Copy template
   - Replace `{{PROJECT_NAME}}` with argument or directory name
   - Replace `{{DATE}}` with current date (YYYY-MM-DD)

4. **Update CLAUDE.md** (unless --no-claude-md)
   - If CLAUDE.md exists, append task integration snippet
   - If not, create new CLAUDE.md with snippet
   - Add marker comment to prevent duplicate appends

5. **Create version marker**
   - Write system version to .claude-todo-version

6. **Report success**
   - List files created/modified
   - Print quick start instructions

**Idempotency markers**:
```markdown
<!-- CLAUDE-TODO:START -->
... task integration content ...
<!-- CLAUDE-TODO:END -->
```

If these markers exist in CLAUDE.md, the script skips appending (already initialized).

---

## TODO.JSON SPECIFICATION

### Focus Object (Critical)

```json
"focus": {
  "currentTask": "T003",      // ID of active task, or null
  "blockedUntil": null,       // Global blocker description, or null
  "sessionNote": "...",       // Context from last session
  "nextAction": "..."         // Specific next step to take
}
```

**Rules**:
- `currentTask` should match a task with `status: "active"`
- Update `sessionNote` at END of every session
- Update `nextAction` with concrete next step

### Task Object

```json
{
  "id": "T001",                        // REQUIRED: Unique, stable
  "title": "Implement feature X",      // REQUIRED: Brief, verb-first
  "status": "pending",                 // REQUIRED: pending|active|blocked|done
  "priority": "high",                  // REQUIRED: critical|high|medium|low
  "phase": "core",                     // Optional: phase slug
  "description": "...",                // Optional: detailed description
  "files": ["src/x.ts"],               // Optional: files to modify
  "acceptance": ["criterion 1"],       // Optional: completion criteria
  "depends": ["T001"],                 // Optional: blocking task IDs
  "blockedBy": "reason",               // Required if status=blocked
  "notes": ["note 1"],                 // Optional: append-only context
  "labels": ["feature"],               // Optional: categorization
  "createdAt": "2024-12-05",           // Optional: creation date
  "completedAt": "2024-12-06"          // Required if status=done
}
```

### Task Lifecycle

```
                    ┌──────────────┐
                    │   pending    │ ◀─── (create new task)
                    └──────────────┘
                           │
              (all depends done + start work)
                           │
                           ▼
                    ┌──────────────┐
         ┌─────────│    active    │─────────┐
         │         └──────────────┘         │
         │                                  │
    (encounter                         (complete all
     blocker)                          acceptance)
         │                                  │
         ▼                                  ▼
  ┌──────────────┐                   ┌──────────────┐
  │   blocked    │                   │     done     │
  └──────────────┘                   └──────────────┘
         │
   (blocker resolved)
         │
         ▼
  ┌──────────────┐
  │   pending    │
  └──────────────┘
```

### Actionable Task Definition

A task is "actionable" when:
1. `status === "pending"`
2. All task IDs in `depends` array have `status === "done"`
3. Prioritize by: critical > high > medium > low

---

## AGENT WORKFLOW PROTOCOL

### Session Start Protocol

```
1. READ todo.json
2. CHECK focus.currentTask
   ├── If set: Resume that task, read sessionNote for context
   └── If null: Find next actionable task
3. SET focus.currentTask to chosen task ID
4. SET task.status to "active"
5. UPDATE lastUpdated
6. BEGIN work
```

### During Work Protocol

```
- ADD notes to task.notes array as you work
- UPDATE task.files array when creating/modifying files
- IF blocked:
  └── SET task.status = "blocked"
  └── SET task.blockedBy = "specific reason"
  └── FIND next actionable task or REPORT to user
```

### Session End Protocol

```
1. UPDATE focus.sessionNote with current state/progress
2. SET focus.nextAction with specific next step
3. IF task complete:
   ├── SET task.status = "done"
   ├── SET task.completedAt = "YYYY-MM-DD"
   └── CLEAR focus.currentTask (set to null)
4. UPDATE lastUpdated
5. SAVE todo.json
```

### Archive Protocol (Periodic)

```
1. IDENTIFY tasks where:
   - status === "done"
   - completedAt is older than 7 days (configurable)
2. MOVE to todo-archive.json
3. UPDATE archived.count and archived.lastArchived
4. KEEP 3-5 recent completions for context
```

---

## CONSTRAINTS & RULES

### Absolute Rules (Never Violate)

1. **One active task** - Only ONE task should have `status: "active"` at any time
2. **Stable IDs** - Never change a task's ID after creation
3. **Sequential IDs** - New tasks get next available T### number
4. **Append-only notes** - Never delete from notes array, only append
5. **Required fields on status change**:
   - `blocked` requires `blockedBy`
   - `done` requires `completedAt`

### Design Constraints

1. **File size target**: Active todo.json should be 50-150 lines
2. **Task count target**: Archive when >15-20 completed tasks accumulate
3. **No computed storage**: Never store metrics that can be calculated
4. **No time tracking**: Don't track estimated/actual hours
5. **Flat structure**: Tasks in array, not nested in phases

### Naming Conventions

| Element | Pattern | Examples |
|---------|---------|----------|
| Task ID | `T\d{3,}` | T001, T002, T100 |
| Phase slug | `[a-z][a-z0-9-]*` | setup, core, phase-2 |
| Label slug | `[a-z][a-z0-9-]*` | feature, bug, urgent |
| Date | ISO 8601 | 2024-12-05 |

---

## DEVELOPMENT TASKS

When helping develop this system, prioritize:

1. **Core schema stability** - The schema should rarely change
2. **Template simplicity** - Templates should be minimal and obvious
3. **Script robustness** - Init script must handle edge cases gracefully
4. **Documentation clarity** - All files should be self-documenting

### Quality Checklist

Before finalizing any file:
- [ ] Is it the minimum necessary?
- [ ] Can an LLM parse and modify it reliably?
- [ ] Is it self-documenting?
- [ ] Does it work without external dependencies?
- [ ] Is it portable across operating systems?

---

## DELIVERABLES CHECKLIST

The complete CLAUDE-TODO system consists of:

```
~/.claude-todo/
├── core/
│   ├── todo-schema.json          [ ] Complete JSON Schema
│   └── VERSION                   [ ] Version file (2.0.0)
├── templates/
│   ├── todo.template.json        [ ] Starter template
│   ├── CLAUDE.todo.md            [ ] CLAUDE.md integration snippet
│   └── commands/
│       └── task-status.md        [ ] Status slash command
├── bin/
│   └── claude-todo-init          [ ] Bash init script
└── README.md                     [ ] System documentation
```

---

## RESPONSE GUIDELINES

When assisting with this system:

1. **Be concrete** - Provide actual file contents, not descriptions
2. **Be minimal** - Remove anything that doesn't serve a clear purpose
3. **Be portable** - Assume bash, no exotic dependencies
4. **Be explicit** - State assumptions and constraints clearly
5. **Test mentally** - Walk through how an LLM agent would use each file

When asked to create or modify files:
- Always show the complete file content
- Include comments explaining non-obvious elements
- Validate against the schema mentally
- Consider both human and LLM readability

---

## CONTEXT SUMMARY

You have been given:
1. The optimized todo-schema.json
2. A complete todo-example.json showing real usage
3. A todo-template.json starter
4. CLAUDE.md integration instructions
5. Analysis comparing old vs. new schema approaches

Your task is to help finalize and package this into a clean, installable system that any developer can drop into any project with a single command.

The end goal: `claude-todo-init` creates everything needed, and Claude Code (or any LLM agent) can immediately start managing tasks effectively.
