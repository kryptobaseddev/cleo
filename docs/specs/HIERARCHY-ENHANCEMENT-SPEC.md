# Hierarchy Enhancement Specification

**Version**: 1.0.0
**Status**: DRAFT → REVIEW
**Target**: v0.15.0 (Phase 1), v0.16.0 (Phase 2)

---

## Executive Summary

This specification defines hierarchical task management for claude-todo, designed for **LLM agents as primary users**. All design decisions optimize for agent cognition, context management, and anti-hallucination—NOT human time estimates.

### Core Principles

1. **NO TIME ESTIMATES** - Task sizing based on scope/complexity, never duration
2. **LLM-First Design** - Agents don't tire; size tasks by cognitive load and context
3. **HITL as Decision Maker** - Humans initiate and approve; agents execute and organize
4. **Always Be Shipping** - Smallest completable increment, continuous delivery
5. **Anti-Hallucination** - Every feature has validation guardrails

---

## Part 1: Task Type Taxonomy

### 1.1 Type Definitions

| Type | Definition | LLM Sizing Criteria |
|------|------------|---------------------|
| **Epic** | Strategic initiative requiring decomposition | Scope exceeds single-session context viability |
| **Task** | Primary work unit, completable with maintained focus | Fits within agent's working context without degradation |
| **Subtask** | Atomic operation, single concern | One tool call or minimal chain; trivial scope |

### 1.2 Why NOT "Feature" or "Story"

| Rejected Type | Reason |
|---------------|--------|
| **Feature** | SAFe/enterprise term; semantic overlap with Epic; creates classification ambiguity |
| **Story** | Scrum ceremony artifact; implies user-facing narrative; agents don't need personas |
| **Initiative** | Portfolio-level abstraction; outside scope of project-level tracking |

### 1.3 Type Selection Algorithm (for agents)

```
FUNCTION classify_work_item(scope):
    IF requires_decomposition(scope):
        RETURN "epic"
    ELSE IF is_atomic(scope):
        RETURN "subtask"
    ELSE:
        RETURN "task"

FUNCTION requires_decomposition(scope):
    RETURN (
        scope.file_count > 10 OR
        scope.component_count > 3 OR
        scope.reasoning_complexity == "high" OR
        scope.context_risk == "degradation_likely"
    )

FUNCTION is_atomic(scope):
    RETURN (
        scope.file_count <= 1 AND
        scope.change_type IN ["add_field", "fix_typo", "update_config"] AND
        scope.reasoning_complexity == "trivial"
    )
```

---

## Part 2: Task Sizing Model (LLM-Centric)

### 2.1 Sizing Dimensions

**PROHIBITED**: Hours, days, weeks, sprints, story points, time estimates

**REQUIRED**: Scope-based sizing using these dimensions:

| Dimension | Small | Medium | Large |
|-----------|-------|--------|-------|
| **File Scope** | 1-2 files | 3-7 files | 8+ files |
| **Component Scope** | Single component | Related components | Cross-cutting |
| **Reasoning Complexity** | Straightforward | Moderate decisions | Complex logic/architecture |
| **Context Risk** | Minimal | Contained | Degradation likely |
| **Dependency Chain** | None or 1 | 2-3 dependencies | 4+ or cross-epic |

### 2.2 Size Definitions

**Small**
- Scope: Single file or closely related files
- Complexity: Straightforward, pattern-following
- Context: Fits easily in working memory
- Risk: Low hallucination risk
- Example: "Add validation to input field", "Fix typo in error message"

**Medium**
- Scope: Multiple related files, single component area
- Complexity: Requires reasoning about interactions
- Context: Needs reference to related code
- Risk: Moderate; benefits from validation
- Example: "Implement new CLI command", "Add database migration"

**Large**
- Scope: Multiple components, cross-cutting concerns
- Complexity: Architectural decisions, multiple integration points
- Context: Exceeds comfortable working context
- Risk: High; requires decomposition
- Example: "Implement authentication system", "Add multi-agent support"
- **Action**: MUST decompose into Medium/Small tasks

### 2.3 Epic Decomposition Rule

```
IF task.size == "large":
    DECOMPOSE into tasks where:
        - Each child is Medium or Small
        - Each child is independently completable
        - Each child has clear acceptance criteria
        - Total children <= 7 (cognitive limit)
```

---

## Part 3: Hierarchy Structure

### 3.1 Maximum Depth

**Limit: 3 levels**

```
Level 0: Epic (strategic initiative)
Level 1: Task (primary work unit)
Level 2: Subtask (atomic operation)
```

**Rationale**:
- Deeper nesting increases navigation overhead
- Agents lose context tracking deep trees
- Research shows 3 levels optimal for comprehension

### 3.2 Maximum Siblings

**Limit: 7 children per parent**

**Rationale**:
- Cognitive science: 4-5 items in working memory
- 7 provides buffer without overwhelming
- Forces meaningful grouping

**Enforcement**:
```bash
# CLI rejects 8th child
claude-todo add "Task 8" --parent T001
ERROR: Parent T001 has 7 children (maximum reached)
Fix: Group related tasks under a new epic, or complete existing tasks
```

### 3.3 ID System

**Format**: Sequential flat IDs with visual hierarchy

**IDs**: `T001`, `T002`, `T003` (unchanged)

**Hierarchy**: Stored in `parentId` field, displayed via `--tree`

**Why NOT hierarchical IDs** (`T001.1.2`):
- Breaks when restructuring
- Complex to parse and validate
- Migration nightmare when moving tasks
- Flat IDs are stable references

```json
{
  "id": "T005",
  "parentId": "T001",
  "type": "task"
}
```

**Display**:
```
T001 [epic] Authentication System
├─ T002 [task] JWT middleware
├─ T003 [task] Password hashing
└─ T004 [task] Session management
    └─ T005 [subtask] Add session timeout config
```

---

## Part 4: Schema Changes

### 4.1 New Fields (todo.schema.json v2.3.0)

```json
{
  "definitions": {
    "task": {
      "properties": {
        "type": {
          "type": "string",
          "enum": ["epic", "task", "subtask"],
          "default": "task",
          "description": "Task classification in hierarchy. Epic requires decomposition, task is primary work unit, subtask is atomic."
        },
        "parentId": {
          "type": ["string", "null"],
          "pattern": "^T\\d{3,}$",
          "default": null,
          "description": "Parent task ID. Must exist in tasks array. Null for root-level tasks."
        },
        "size": {
          "type": ["string", "null"],
          "enum": ["small", "medium", "large", null],
          "default": null,
          "description": "Scope-based size classification. Large tasks should be decomposed."
        }
      }
    }
  }
}
```

### 4.2 Validation Rules

```json
{
  "hierarchyRules": {
    "parentMustExist": "parentId references existing task.id",
    "noOrphans": "Cannot delete/archive task with active children",
    "maxDepth": "Depth cannot exceed 3 (epic → task → subtask)",
    "maxSiblings": "Parent cannot have more than 7 children",
    "typeHierarchy": "subtask cannot have children",
    "noCircular": "Task cannot be ancestor of itself",
    "completionOrder": "Cannot complete parent with incomplete children (warn, allow override)"
  }
}
```

### 4.3 Migration

**From v2.2.0 → v2.3.0**:

```bash
claude-todo migrate run --auto

# Transforms:
# - Adds type="task" to all existing tasks (default)
# - Adds parentId=null to all existing tasks (root-level)
# - Labels "type:epic" → type="epic"
# - Labels "parent:T001" → parentId="T001"
# - Removes migrated labels from labels array
```

**Backward Compatibility**:
- Existing tasks remain valid (optional fields)
- Label conventions still work (deprecated with warning)
- Old projects function without migration (just can't use hierarchy)

---

## Part 5: CLI Changes

### 5.1 New Flags

**add command**:
```bash
claude-todo add "Task title" --type epic|task|subtask
claude-todo add "Subtask" --parent T001
claude-todo add "Task" --size small|medium|large
```

**list command**:
```bash
claude-todo list --tree                    # Hierarchical tree view
claude-todo list --tree --depth 2          # Limit tree depth
claude-todo list --flat                    # Current behavior (default for now)
claude-todo list --children T001           # Direct children only
claude-todo list --descendants T001        # All nested children
claude-todo list --root                    # Only root-level tasks
claude-todo list --leaf                    # Only tasks without children
claude-todo list --type epic               # Filter by type
```

**show command**:
```bash
claude-todo show T005
# Output includes:
#   Parent: T001 (Authentication System)
#   Depth: 2
#   Children: 0
#   Ancestors: T001
```

**New commands**:
```bash
claude-todo tree                           # Alias for list --tree
claude-todo tree T001                      # Show subtree rooted at T001
claude-todo reparent T005 --to T002        # Move task to new parent
claude-todo promote T005                   # Remove parent (make root-level)
```

### 5.2 Output Formats

**Tree View (default when --tree)**:
```
╭─ TASKS (tree view) ─────────────────────────────────────────────╮
│                                                                  │
│ T001 [epic] ◉ active  Authentication System                     │
│ ├─ T002 [task] ○ pending  JWT middleware                        │
│ ├─ T003 [task] ✓ done     Password hashing                      │
│ └─ T004 [task] ○ pending  Session management                    │
│     └─ T005 [subtask] ○ pending  Add timeout config             │
│                                                                  │
│ T006 [task] ○ pending  Update documentation                     │
│                                                                  │
╰──────────────────────────────────────────────────────────────────╯
```

**JSON Output**:
```json
{
  "_meta": { "format": "tree", "version": "0.15.0" },
  "tree": [
    {
      "id": "T001",
      "type": "epic",
      "title": "Authentication System",
      "status": "active",
      "depth": 0,
      "childCount": 3,
      "children": [
        {
          "id": "T002",
          "type": "task",
          "depth": 1,
          "childCount": 0,
          "children": []
        }
      ]
    }
  ]
}
```

### 5.3 Validation Messages (Agent-Friendly)

```bash
# Parent doesn't exist
claude-todo add "Task" --parent T999
ERROR: Parent T999 does not exist
Fix: Use 'claude-todo list --type epic' to find valid parents

# Depth exceeded
claude-todo add "Too deep" --parent T005  # T005 is depth 2
ERROR: Maximum hierarchy depth (3) would be exceeded
Fix: Create task under T001 (epic) or T004 (task) instead

# Too many siblings
claude-todo add "8th child" --parent T001  # T001 has 7 children
ERROR: Parent T001 has 7 children (maximum)
Fix: Complete or archive existing children, or create new epic

# Completing parent with incomplete children
claude-todo complete T001  # Has incomplete children
WARNING: T001 has 2 incomplete children: T002, T004
Options:
  --force         Complete anyway (children become orphaned)
  --cascade       Complete all children too
  --skip          Abort completion
```

---

## Part 6: Automation Behaviors

### 6.1 Parent Auto-Complete

**When all children complete → Parent auto-completes**

```bash
# Configuration (todo-config.json)
{
  "hierarchy": {
    "autoCompleteParent": true,      # default: true
    "autoCompleteMode": "suggest"    # "auto" | "suggest" | "off"
  }
}

# Behavior when completing last child:
claude-todo complete T004  # Last incomplete child of T001

# Mode: "auto"
[INFO] Task T004 completed
[INFO] All children of T001 complete - auto-completing parent
[INFO] Epic T001 marked complete

# Mode: "suggest" (default)
[INFO] Task T004 completed
[INFO] All children of T001 complete
Suggestion: Complete parent epic T001? (y/N)

# Mode: "off"
[INFO] Task T004 completed
```

### 6.2 Blocked Task Auto-Activation

**When all blockers complete → Blocked task becomes pending**

```bash
# Task T005 blocked by T002 and T003
claude-todo complete T003  # T002 already done

[INFO] Task T003 completed
[INFO] Task T005 unblocked (all dependencies satisfied)
[INFO] T005 status: blocked → pending
```

### 6.3 Orphan Detection

**On validation, detect tasks with missing parents**

```bash
claude-todo validate

[OK] JSON syntax valid
[OK] Schema version compatible
[WARN] Orphaned tasks detected:
  - T005 references parent T001, but T001 not found
  - T008 references parent T002, but T002 archived

Fix with: claude-todo validate --fix-orphans
  Options: --unlink (remove parentId) | --delete (remove orphans)
```

---

## Part 7: Anti-Hallucination Guardrails

### 7.1 Pre-Operation Validation

| Operation | Validations |
|-----------|-------------|
| **add --parent** | Parent exists, parent type valid, depth limit, sibling limit |
| **complete** | Children status check (warn if incomplete) |
| **delete/archive** | No active children |
| **reparent** | New parent exists, wouldn't create cycle, depth valid |

### 7.2 Error Codes

```bash
EXIT_PARENT_NOT_FOUND=10
EXIT_DEPTH_EXCEEDED=11
EXIT_SIBLING_LIMIT=12
EXIT_INVALID_PARENT_TYPE=13
EXIT_ORPHAN_PREVENTED=14
EXIT_CIRCULAR_REFERENCE=15
```

### 7.3 Structured Error Output

```json
{
  "error": "PARENT_NOT_FOUND",
  "code": 10,
  "message": "Parent task T999 does not exist",
  "context": { "requestedParent": "T999", "taskTitle": "New task" },
  "fix": {
    "action": "use_valid_parent",
    "command": "claude-todo list --type epic,task --format json"
  }
}
```

---

## Part 8: Focus Integration

### 8.1 Focus on Hierarchy

```bash
# Focus on epic focuses the epic (not children)
claude-todo focus set T001  # Epic

# Show focus with context
claude-todo focus show
Focus: T001 (epic) - Authentication System
Children: 3 (1 done, 2 pending)
  ├─ T002 ○ JWT middleware
  ├─ T003 ✓ Password hashing
  └─ T004 ○ Session management

# Focus on child shows parent context
claude-todo focus set T002

Focus: T002 (task) - JWT middleware
Parent: T001 - Authentication System
```

### 8.2 Next Task Suggestion

```bash
claude-todo next --explain

# Considers hierarchy:
# - Prefers tasks in currently focused epic
# - Unblocked leaf tasks score higher
# - Respects phase and priority
# - Suggests completing siblings before starting new epic

Suggested: T002 - JWT middleware
  Score: 95 (priority: 50, same-epic: 30, unblocked: 15)
  Parent: T001 - Authentication System
  Rationale: Unblocked task in active epic, high priority
```

---

## Part 9: Implementation Plan

### Phase 1: Core Hierarchy (v0.15.0)

**Scope**: Schema, validation, basic commands

**Deliverables**:
1. Schema v2.3.0 with `type`, `parentId`, `size` fields
2. Migration from v2.2.0 (label-based conventions)
3. Validation rules (depth, siblings, parent existence, orphans)
4. `add --type`, `add --parent`, `add --size` flags
5. `list --tree`, `list --children`, `list --type` flags
6. `show` enhanced with hierarchy context
7. `validate` enhanced with hierarchy checks
8. Anti-hallucination error messages

**Files to Create/Modify**:
```
schemas/todo.schema.json          # Add type, parentId, size
lib/hierarchy.sh                  # NEW: hierarchy validation functions
lib/validation.sh                 # Add hierarchy validation rules
lib/migrate.sh                    # Add v2.2.0 → v2.3.0 migration
scripts/add-task.sh               # Add --type, --parent, --size
scripts/list.sh                   # Add --tree, --children, --type
scripts/show.sh                   # Add hierarchy context
scripts/validate.sh               # Add hierarchy checks
tests/unit/test-hierarchy.bats    # NEW: hierarchy unit tests
tests/integration/hierarchy.bats  # NEW: hierarchy integration tests
docs/commands/hierarchy.md        # NEW: hierarchy documentation
```

### Phase 2: Automation & UX (v0.16.0)

**Scope**: Auto-behaviors, advanced commands, polish

**Deliverables**:
1. Auto-complete parent when children done
2. Auto-unblock when dependencies complete
3. Orphan detection and repair
4. `tree` command (alias)
5. `reparent` command
6. `promote` command
7. `next --explain` hierarchy awareness
8. `focus show` hierarchy context
9. Tab completion for `--parent`
10. Tree visualization polish

**Files to Create/Modify**:
```
lib/hierarchy.sh                  # Add auto-complete, orphan repair
lib/cache.sh                      # Add hierarchy index caching
scripts/complete-task.sh          # Add parent auto-complete
scripts/tree.sh                   # NEW: tree command
scripts/reparent.sh               # NEW: reparent command
scripts/promote.sh                # NEW: promote command
scripts/next.sh                   # Add hierarchy awareness
scripts/focus.sh                  # Add hierarchy context
completions/bash-completion.sh    # Add --parent completion
completions/zsh-completion.zsh    # Add --parent completion
tests/unit/test-auto-complete.bats
tests/integration/hierarchy-workflow.bats
docs/guides/hierarchy-workflow.md
```

### Patch Releases

**v0.15.1**: Bug fixes from Phase 1 feedback
**v0.15.2**: Performance optimization for large hierarchies
**v0.16.1**: Bug fixes from Phase 2 feedback

---

## Part 10: Success Criteria

### Phase 1 Complete When:
- [ ] All existing tests pass (1124+)
- [ ] New hierarchy tests pass (target: 100+)
- [ ] `claude-todo add --parent T001` works
- [ ] `claude-todo list --tree` displays hierarchy
- [ ] Validation catches invalid hierarchy operations
- [ ] Migration from v2.2.0 preserves all data
- [ ] Documentation updated

### Phase 2 Complete When:
- [ ] Parent auto-completes when children done
- [ ] Orphan detection works in validate
- [ ] `reparent` and `promote` commands work
- [ ] Tab completion for `--parent` works
- [ ] Focus shows hierarchy context
- [ ] Performance acceptable for 500+ tasks with hierarchy

### Production Ready When:
- [ ] Used successfully on claude-todo's own task tracking
- [ ] No data loss in any scenario
- [ ] All edge cases handled gracefully
- [ ] Documentation complete and accurate

---

## Part 11: Open Questions

### Resolved
- **Q**: Feature type needed? **A**: No, use labels
- **Q**: Hierarchical IDs? **A**: No, flat IDs + parentId
- **Q**: Max depth? **A**: 3 levels
- **Q**: Max siblings? **A**: 7

### To Discuss
1. **Hash IDs for multi-agent**: Defer to v1.0.0 or implement in Phase 2?
2. **Cascade delete**: When deleting epic, delete children or orphan them?
3. **Archive behavior**: Archive parent archives children?

---

## Appendix A: Migration Examples

### Label Convention to Schema

**Before (v2.2.0 with conventions)**:
```json
{
  "id": "T001",
  "title": "Auth System",
  "labels": ["type:epic", "security"]
}
{
  "id": "T002",
  "title": "JWT middleware",
  "labels": ["type:task", "parent:T001", "security"]
}
```

**After (v2.3.0)**:
```json
{
  "id": "T001",
  "title": "Auth System",
  "type": "epic",
  "parentId": null,
  "labels": ["security"]
}
{
  "id": "T002",
  "title": "JWT middleware",
  "type": "task",
  "parentId": "T001",
  "labels": ["security"]
}
```

### Fresh Project

```bash
# Initialize with hierarchy support
claude-todo init

# Create epic
claude-todo add "User Authentication" --type epic
# → T001 [epic]

# Add tasks under epic
claude-todo add "Implement JWT validation" --parent T001
# → T002 [task] under T001

claude-todo add "Add password hashing" --parent T001
# → T003 [task] under T001

# Add subtask
claude-todo add "Configure bcrypt rounds" --parent T003
# → T004 [subtask] under T003

# View hierarchy
claude-todo tree
T001 [epic] User Authentication
├─ T002 [task] Implement JWT validation
└─ T003 [task] Add password hashing
    └─ T004 [subtask] Configure bcrypt rounds
```

---

## Appendix B: Size Classification Examples

### Small Scope
- Add configuration option
- Fix typo in message
- Update dependency version
- Add single validation rule
- Write test for existing function

### Medium Scope
- Implement new CLI command
- Add database migration with 2-3 tables
- Refactor function with multiple callers
- Add new validation module
- Create documentation page

### Large Scope (→ Epic, requires decomposition)
- Implement authentication system
- Add multi-agent support
- Create web UI dashboard
- Major architectural refactor
- Add new storage backend

---

## Appendix C: Command Reference

```bash
# Type and parent
claude-todo add "Title" --type epic|task|subtask --parent TXXX

# Size classification
claude-todo add "Title" --size small|medium|large

# List variants
claude-todo list --tree [--depth N]
claude-todo list --children TXXX
claude-todo list --descendants TXXX
claude-todo list --root
claude-todo list --leaf
claude-todo list --type epic|task|subtask

# Hierarchy management
claude-todo tree [TXXX]
claude-todo reparent TXXX --to TYYY
claude-todo promote TXXX

# Validation
claude-todo validate --fix-orphans [--unlink|--delete]
```

---

*End of Specification*
