# Hierarchy System

Task hierarchy support for organizing work into Epic, Task, and Subtask levels.

## Overview

The hierarchy system (v0.17.0+) enables structured task organization with a three-level hierarchy:

```
Epic (strategic initiative)
  └── Task (primary work unit)
        └── Subtask (atomic operation)
```

This structure allows breaking down large initiatives into manageable pieces while maintaining relationships and enabling progress tracking at multiple levels.

## Schema Fields (v2.3.0)

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `type` | string | `epic`, `task`, `subtask` | Task classification in hierarchy |
| `parentId` | string | Task ID (e.g., `T001`) or `null` | Parent task reference |
| `size` | string | `small`, `medium`, `large` | Scope-based sizing (NOT time) |

### Type Definitions

| Type | Description | Can Have Parent | Can Have Children |
|------|-------------|-----------------|-------------------|
| `epic` | Strategic initiative requiring decomposition | No | Yes (tasks) |
| `task` | Primary work unit | Yes (epic) | Yes (subtasks) |
| `subtask` | Atomic operation | Yes (task) | No |

### Size Definitions

Size represents **scope**, not time. Time estimates are prohibited.

| Size | Scope | Typical File Count | Guidance |
|------|-------|-------------------|----------|
| `small` | Narrow scope | 1-2 files | Single-file change, minor fix |
| `medium` | Moderate scope | 3-7 files | Feature component, module update |
| `large` | Broad scope | 8+ files | Should likely decompose further |

## Constraints

The hierarchy system enforces strict constraints for maintainability:

| Constraint | Value | Rationale |
|------------|-------|-----------|
| Maximum depth | 3 levels | Prevents over-decomposition |
| Maximum siblings | 7 per parent | Cognitive load management |
| Subtask children | Not allowed | Enforces atomic operations |
| Epic parent | Not allowed | Epics must be root-level |

## Commands

### Creating Hierarchical Tasks

Use `add` command with hierarchy options:

```bash
cleo add "Task Title" [--type TYPE] [--parent ID] [--size SIZE]
```

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--type TYPE` | `-t` | Task type: `epic`, `task`, `subtask` | Inferred from parent |
| `--parent ID` | | Parent task ID (e.g., `T001`) | `null` (root-level) |
| `--size SIZE` | | Scope: `small`, `medium`, `large` | `null` |

### Listing with Hierarchy Filters

Use `list` command with hierarchy filters:

```bash
cleo list [--type TYPE] [--parent ID] [--children ID] [--tree]
```

| Option | Short | Description |
|--------|-------|-------------|
| `--type TYPE` | `-t` | Filter by type: `epic`, `task`, `subtask` |
| `--parent ID` | | Filter tasks with specified parent |
| `--children ID` | | Show direct children of task ID |
| `--tree` | | Display hierarchical tree view |

### Tree Alias

For convenience, the `tree` command provides direct access to hierarchical tree view:

```bash
cleo tree              # Same as: cleo list --tree
ct tree                       # Short form
ct tree --status pending      # Tree with status filter
ct tree --type epic           # Show only epics in tree format
ct tree --parent T001         # Show subtree rooted at T001
```

The `tree` alias accepts all `list` command filters and options.

### Viewing Task Details

The `show` command displays hierarchy context:

```bash
cleo show T001
```

Output includes:
- Task type
- Parent task (if any)
- Children count (if any)
- Task depth in hierarchy

## Examples

### Creating an Epic with Tasks and Subtasks

```bash
# Create the epic
cleo add "User Authentication System" --type epic --size large
# Created: T001

# Create tasks under the epic
cleo add "Implement login endpoint" --parent T001 --size medium
# Created: T002 (type inferred as "task")

cleo add "Implement logout endpoint" --parent T001 --size small
# Created: T003 (type inferred as "task")

# Create subtasks under a task
cleo add "Validate email format" --parent T002 --size small
# Created: T004 (type inferred as "subtask")

cleo add "Hash password securely" --parent T002 --size small
# Created: T005 (type inferred as "subtask")
```

Result:
```
T001 [epic] User Authentication System
  ├── T002 [task] Implement login endpoint
  │     ├── T004 [subtask] Validate email format
  │     └── T005 [subtask] Hash password securely
  └── T003 [task] Implement logout endpoint
```

### Filtering by Type

```bash
# List only epics
cleo list --type epic

# List only subtasks
cleo list --type subtask

# List tasks (excludes epics and subtasks)
cleo list --type task
```

### Viewing Children of a Task

```bash
# Show all children of T001
cleo list --children T001

# Equivalent: filter by parent
cleo list --parent T001
```

### Tree View Display

```bash
# Display full hierarchy tree
cleo list --tree
```

Output:
```
TASKS (Tree View)
=================

T001 [epic] User Authentication System
  ├── T002 [task] Implement login endpoint
  │     ├── T004 [subtask] Validate email format
  │     └── T005 [subtask] Hash password securely
  └── T003 [task] Implement logout endpoint

T010 [task] Fix navigation bug
  └── T011 [subtask] Update CSS selectors
```

### Combining Filters

```bash
# High-priority tasks under a specific epic
cleo list --parent T001 --priority high

# Pending subtasks with a specific label
cleo list --type subtask --status pending --label backend
```

## Type Inference

When `--type` is not specified, it is inferred from context:

| Scenario | Inferred Type |
|----------|---------------|
| No parent specified | `task` |
| Parent is `epic` | `task` |
| Parent is `task` | `subtask` |

```bash
# Type inferred as "task" (no parent)
cleo add "Standalone task"

# Type inferred as "task" (parent is epic)
cleo add "Feature work" --parent T001  # T001 is epic

# Type inferred as "subtask" (parent is task)
cleo add "Small fix" --parent T002  # T002 is task
```

## Validation Errors

### Parent Not Found (Exit Code 10)

```bash
cleo add "Task" --parent T999
# ERROR: Parent task T999 not found
```

**Fix**: Verify the parent task ID exists with `cleo exists T999`.

### Maximum Depth Exceeded (Exit Code 11)

```bash
# T005 is already a subtask (depth 2)
cleo add "Too deep" --parent T005
# ERROR: Maximum hierarchy depth (3) exceeded
```

**Fix**: Subtasks cannot have children. Restructure to add under a task instead.

### Maximum Siblings Exceeded (Exit Code 12)

```bash
# T001 already has 7 children
cleo add "Eighth child" --parent T001
# ERROR: Maximum siblings (7) exceeded for parent T001
```

**Fix**: Consider creating a new epic or grouping related tasks.

### Invalid Parent Type (Exit Code 13)

```bash
# T005 is a subtask
cleo add "Child of subtask" --parent T005
# ERROR: Subtask T005 cannot have children
```

**Fix**: Subtasks are atomic and cannot have children. Add under a task instead.

### Epic Cannot Have Parent (Validation Error)

```bash
cleo add "Nested epic" --type epic --parent T001
# ERROR: Epics cannot have a parent (must be root-level)
```

**Fix**: Remove `--parent` option for epics.

## JSON Output

When using `--format json`, hierarchy fields are included:

```json
{
  "_meta": {
    "format": "json",
    "version": "0.17.0",
    "command": "list"
  },
  "tasks": [
    {
      "id": "T001",
      "title": "User Authentication System",
      "status": "pending",
      "priority": "high",
      "type": "epic",
      "parentId": null,
      "size": "large"
    },
    {
      "id": "T002",
      "title": "Implement login endpoint",
      "status": "active",
      "priority": "high",
      "type": "task",
      "parentId": "T001",
      "size": "medium"
    }
  ]
}
```

### JSON Parsing Examples

```bash
# Get all epics
cleo list -f json | jq '.tasks[] | select(.type == "epic")'

# Get children of a specific parent
cleo list -f json | jq '.tasks[] | select(.parentId == "T001")'

# Count tasks by type
cleo list -f json | jq '.tasks | group_by(.type) | map({type: .[0].type, count: length})'
```

## Best Practices

### When to Use Epics

- Strategic initiatives spanning multiple work sessions
- Features requiring decomposition into discrete tasks
- Work requiring coordination across multiple areas

### When to Use Subtasks

- Atomic operations that must complete together
- Checklist items within a larger task
- Implementation steps that should not be tracked independently

### Sizing Guidelines

| If... | Consider... |
|-------|-------------|
| Size is "large" | Decomposing into smaller tasks |
| Subtask seems "large" | Promoting to task level |
| Epic has 7+ direct children | Grouping related tasks under intermediary tasks |

### Hierarchy Depth

Keep hierarchies shallow when possible:

- **Good**: Epic with 3-5 tasks, each with 0-3 subtasks
- **Avoid**: Deep nesting where tasks at depth 2 always have subtasks

## Migration

To upgrade an existing project to schema v2.3.0 with hierarchy support:

```bash
# Check current schema version
cleo migrate status

# Run migration (adds type/parentId/size fields)
cleo migrate run
```

Existing tasks receive default values:
- `type`: `"task"`
- `parentId`: `null`
- `size`: `null`

## Library Functions

The hierarchy system is implemented in `lib/hierarchy.sh`:

| Function | Purpose |
|----------|---------|
| `get_task_type` | Get type of a task |
| `get_task_parent` | Get parentId of a task |
| `get_task_depth` | Calculate depth in hierarchy |
| `get_children` | Get direct children of a task |
| `get_descendants` | Get all descendants recursively |
| `count_siblings` | Count tasks with same parent |
| `validate_hierarchy` | Run all hierarchy validations |
| `infer_task_type` | Infer type from parent |
| `detect_orphans` | Find tasks with invalid parentId |

## Exit Codes

| Code | Meaning | Cause |
|------|---------|-------|
| `10` | Parent not found | `--parent` references non-existent task |
| `11` | Depth exceeded | Would create 4th level |
| `12` | Sibling limit | Parent already has 7 children |
| `13` | Invalid parent type | Subtask cannot have children |

## Populating Hierarchy (v0.23.2+)

The `populate-hierarchy` command automatically sets `parentId` for existing tasks based on conventions:

```bash
cleo populate-hierarchy [OPTIONS]
```

### Detection Strategies

| Strategy | Example | Result |
|----------|---------|--------|
| **Naming convention** | Title `T328.1: Schema update` | parentId → `T328` |
| **Depends on epic** | `depends: ["T328"]` where T328.type=epic | parentId → `T328` |

### Options

| Option | Short | Description |
|--------|-------|-------------|
| `--dry-run` | | Preview changes without applying |
| `--format` | `-f` | Output format: `text`, `json` |
| `--json` | | Force JSON output |
| `--human` | | Force human-readable output |
| `--quiet` | `-q` | Suppress non-essential output |

### Examples

```bash
# Preview changes
cleo populate-hierarchy --dry-run

# Apply changes
cleo populate-hierarchy

# JSON output for agents
cleo populate-hierarchy --json
```

### JSON Output

```json
{
  "_meta": {"command": "populate-hierarchy", "version": "0.23.2"},
  "success": true,
  "dryRun": false,
  "summary": {
    "totalChanges": 47,
    "byNamingConvention": 39,
    "byDependsOnEpic": 8,
    "skippedAlreadyHasParent": 0
  },
  "changes": [
    {"taskId": "T329", "title": "T328.1: ...", "newParentId": "T328", "source": "naming"}
  ]
}
```

## Hierarchy Management Commands (v0.26.0+)

### Reparent

Move a task to a different parent:

```bash
cleo reparent TASK_ID --to PARENT_ID
```

| Option | Description |
|--------|-------------|
| `--to PARENT_ID` | New parent task ID (required) |
| `--to ""` | Remove parent (make root task) |
| `--format` | Output format: `text`, `json` |
| `-q, --quiet` | Minimal output |

**Examples:**
```bash
# Move task under different epic
cleo reparent T005 --to T001

# Remove parent (make root)
cleo reparent T005 --to ""
```

**Validation:**
- Target parent must exist
- Target parent cannot be a subtask
- Move cannot exceed max depth (3)
- Move cannot create circular references

### Promote

Remove parent from a task, making it root-level:

```bash
cleo promote TASK_ID [OPTIONS]
```

| Option | Description |
|--------|-------------|
| `--no-type-update` | Don't auto-update type (keep as subtask if applicable) |
| `--format` | Output format: `text`, `json` |
| `-q, --quiet` | Minimal output |

**Examples:**
```bash
# Make task root-level
cleo promote T005

# Promote but keep subtask type
cleo promote T005 --no-type-update
```

**Behavior:**
- Subtasks are auto-promoted to `task` type
- Already root-level tasks return success with no changes

### Comparison

| Operation | promote | reparent |
|-----------|---------|----------|
| Make root | `promote T` | `reparent T --to ""` |
| Change parent | Not available | `reparent T --to NEW_PARENT` |
| Type handling | Auto-updates subtask→task | Preserves type |

## Parent Auto-Complete (v0.24.0+)

When all children of a parent task are completed, the parent can automatically complete.

### Configuration

```bash
cleo config set hierarchy.autoCompleteParent true
cleo config set hierarchy.autoCompleteMode auto
```

| Setting | Values | Description |
|---------|--------|-------------|
| `hierarchy.autoCompleteParent` | `true`, `false` | Enable/disable auto-complete |
| `hierarchy.autoCompleteMode` | `auto`, `suggest`, `off` | Behavior mode |

### Modes

| Mode | Behavior |
|------|----------|
| `auto` | Silent completion when all children done |
| `suggest` | Prompt user before completing (future) |
| `off` | Disabled (default) |

### Behavior

- Triggered when completing the last pending child
- Adds system note: `[AUTO-COMPLETED] All child tasks completed`
- Works recursively (completing subtask can cascade to task then epic)
- JSON output includes `autoCompletedParents` array

### Example

```bash
# Enable auto-complete
cleo config set hierarchy.autoCompleteParent true
cleo config set hierarchy.autoCompleteMode auto

# Create hierarchy
cleo add "Feature Epic" --type epic
cleo add "Task 1" --parent T001
cleo add "Task 2" --parent T001

# Complete children - parent auto-completes after last child
cleo complete T002
cleo complete T003  # T001 auto-completes

# Verify
cleo show T001 --format json | jq '.task.status'
# "done"
```

## Orphan Detection and Repair (v0.24.0+)

Detect and repair tasks with invalid parent references.

### Detection

```bash
# Check for orphaned tasks
cleo validate --check-orphans
```

Orphaned tasks have a `parentId` that references a non-existent task.

### Repair Options

```bash
# Unlink orphans (remove invalid parentId, make root)
cleo validate --fix-orphans unlink

# Delete orphans (remove the orphaned tasks entirely)
cleo validate --fix-orphans delete
```

| Mode | Effect |
|------|--------|
| `unlink` | Sets `parentId` to null, preserves tasks |
| `delete` | Removes orphaned tasks entirely |

### Library Functions

| Function | Purpose |
|----------|---------|
| `detect_orphans` | Returns JSON array of orphan details |
| `repair_orphan_unlink` | Remove invalid parent references |
| `repair_orphan_delete` | Delete orphaned tasks |

## See Also

- [add](add.md) - Task creation with hierarchy options
- [list](list.md) - Task listing with hierarchy filters
- [show](show.md) - Task details with hierarchy context
- [update](update.md) - Modify task hierarchy (reparenting)
- [promote](promote.md) - Remove parent from task
- [reparent](reparent.md) - Move task to different parent
- [HIERARCHY-ENHANCEMENT-SPEC.md](../specs/HIERARCHY-ENHANCEMENT-SPEC.md) - Full specification
- [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](../specs/LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) - ID system design
