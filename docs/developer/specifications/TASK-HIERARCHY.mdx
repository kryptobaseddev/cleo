# Task Hierarchy Specification

**Version**: 3.1.0
**Status**: ACTIVE
**Effective**: v0.42.0+
**Last Updated**: 2025-12-30

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [BCP 14](https://www.rfc-editor.org/info/bcp14) [[RFC2119](https://www.rfc-editor.org/rfc/rfc2119)] [[RFC8174](https://www.rfc-editor.org/rfc/rfc8174)] when, and only when, they appear in all capitals.

---

## Authoritative References

> **IMPORTANT**: This specification defines hierarchy FEATURES (types, parent-child relationships, automation).
> For ID SYSTEM DESIGN (format, guarantees, anti-hallucination), see the authoritative source:
>
> **[LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md)** - The immutable ID system bible
>
> Any conflict between this document and the ID spec: **ID spec wins**.

---

## Executive Summary

This specification defines hierarchical task management for cleo, designed for **LLM agents as primary users**. All design decisions optimize for agent cognition, context management, and anti-hallucination—NOT human time estimates.

### Core Principles

| Principle | Requirement Level |
|-----------|------------------|
| **NO TIME ESTIMATES** | MUST NOT use hours, days, or duration-based sizing |
| **LLM-First Design** | MUST optimize for agent context, not human cognitive limits |
| **HITL as Decision Maker** | Humans SHOULD initiate and approve; agents execute and organize |
| **Always Be Shipping** | SHOULD use smallest completable increment |
| **Anti-Hallucination** | MUST have validation guardrails for all features |
| **Flat ID Stability** | IDs MUST NOT change; hierarchy via `parentId` field |

### Quick Reference

| Concept | Stored? | Purpose | Example |
|---------|---------|---------|---------|
| Epic | `type: "epic"` | Container for related work | T998: Session System |
| Task | `type: "task"` | Discrete deliverable | T1022: Fix session end |
| Subtask | `type: "subtask"` | Atomic work item | T1014: Research agents |
| Phase | `phase: "core"` | Lifecycle stage | setup→core→testing→polish |
| Wave | COMPUTED | Parallel execution group | Wave 0, 1, 2... |
| Depends | `depends: [...]` | Ordering constraint | T1017 depends on T1022 |

**Key Distinction**:
- **Phase** = Schema field (stored) — WHEN in lifecycle
- **Wave** = Computed from deps — EXECUTION ORDER within phase

---

## Part 1: Task Type Taxonomy

### 1.1 Type Definitions

The system MUST support exactly three task types:

| Type | Definition | LLM Sizing Criteria |
|------|------------|---------------------|
| **Epic** | Strategic initiative requiring decomposition | Scope exceeds single-session context viability |
| **Task** | Primary work unit, completable with maintained focus | Fits within agent's working context without degradation |
| **Subtask** | Atomic operation, single concern | One tool call or minimal chain; trivial scope |

### 1.2 Rejected Type Names

The following type names MUST NOT be used:

| Rejected Type | Reason |
|---------------|--------|
| **Feature** | SAFe/enterprise term; semantic overlap with Epic; creates classification ambiguity |
| **Story** | Scrum ceremony artifact; implies user-facing narrative; agents don't need personas |
| **Initiative** | Portfolio-level abstraction; outside scope of project-level tracking |

### 1.3 Type Selection Algorithm

Implementations SHOULD use this algorithm for type inference:

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
- **Action**: Large tasks MUST be decomposed into Medium/Small tasks

### 2.3 Epic Decomposition Rule

When `task.size == "large"`, the system MUST enforce decomposition:
- Each child MUST be Medium or Small
- Each child MUST be independently completable
- Each child SHOULD have clear acceptance criteria
- Total children MUST NOT exceed configured `maxSiblings` limit

---

## Part 3: Hierarchy Structure

### 3.1 Maximum Depth

**Limit: 3 levels** (MUST NOT be exceeded)

```
Level 0: Epic (strategic initiative)
Level 1: Task (primary work unit)
Level 2: Subtask (atomic operation)
```

**Rationale**:
- Deeper nesting increases navigation overhead
- Agents lose context tracking deep trees
- Research shows 3 levels optimal for comprehension

### 3.2 Maximum Siblings (Configurable)

**Default: 20 children per parent** (configurable, 0 = unlimited)

> **Configuration**: See [CONFIG-SYSTEM-SPEC.md](CONFIG-SYSTEM-SPEC.md) for hierarchy settings.

#### LLM-Agent-First Design Rationale

The sibling limit is designed for **LLM agents as primary users**, not human cognitive limits:

| Factor | Humans | LLM Agents |
|--------|--------|------------|
| Working memory | 4-5 items (Miller's 7±2) | 200K+ token context window |
| Cognitive fatigue | Yes, degrades with list size | No fatigue, consistent processing |
| List processing | Serial, tires quickly | Parallel, no degradation |
| Context switching | High cost | Minimal overhead |

**Key Insight**: The original 7-sibling limit was based on Miller's 7±2 law for human short-term memory. However:
- LLM agents don't have 4-5 item working memory limits
- Agents benefit from hierarchy for **organization**, not cognitive load management
- Restricting to 7 created unnecessary friction for large projects

#### Configuration Options

| Setting | Default | Description |
|---------|---------|-------------|
| `hierarchy.maxSiblings` | `0` | Total children limit (0 = unlimited, recommended) |
| `hierarchy.countDoneInLimit` | `false` | Whether done tasks count toward limit |
| `hierarchy.maxActiveSiblings` | `8` | Active (non-done) children limit |
| `hierarchy.maxDepth` | `3` | Maximum hierarchy depth |

#### Active vs Done Task Distinction

- **Done tasks**: Historical record, don't consume agent context. Excluded from limit by default.
- **Active tasks**: Current work, benefit from context focus. Limited by `maxActiveSiblings`.

This allows organizing unlimited completed work under an epic while maintaining focus on active tasks.

### 3.3 ID System

> **See [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) for complete ID system design.**

**Summary** (authoritative details in ID spec):

| Aspect | Design | Rationale |
|--------|--------|-----------|
| **Format** | `T001`, `T002`, `T003` | Simple, bounded pattern for anti-hallucination |
| **Hierarchy** | `parentId` field | Decouples identity from structure |
| **Guarantees** | Unique, Immutable, Stable, Sequential, Referenceable, Recoverable | See ID spec Part 1.2 |
| **NOT** | `T001.1.2` hierarchical IDs | Violates stability; breaks references on restructure |

**Example**:
```json
{
  "id": "T005",
  "parentId": "T001",
  "type": "task"
}
```

**Display** (visual hierarchy without changing IDs):
```
T001 [epic] Authentication System
├─ T002 [task] JWT middleware
├─ T003 [task] Password hashing
└─ T004 [task] Session management
    └─ T005 [subtask] Add session timeout config
```

**Key Insight**: Reparenting T005 to T002 changes `parentId`, NOT the ID itself. All external references (`"Fixes T005"`) remain valid.

---

## Part 4: Schema Requirements

> **Cross-reference**: [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) Part 4 contains the authoritative schema diff and validation rules.

### 4.1 Required Fields

The task schema MUST include these hierarchy fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `enum["epic", "task", "subtask"]` | `"task"` | Task classification in hierarchy |
| `parentId` | `string \| null` | `null` | Parent task ID (pattern: `^T\d{3,}$`) |
| `size` | `enum["small", "medium", "large"] \| null` | `null` | Scope-based size classification |

### 4.2 Validation Rules

The system MUST enforce these hierarchy rules:

| Rule | Error Code | Severity | Description |
|------|------------|----------|-------------|
| `PARENT_EXISTS` | 10 | error | `parentId` MUST reference existing task.id |
| `MAX_DEPTH` | 11 | error | Depth MUST NOT exceed configured `maxDepth` |
| `MAX_SIBLINGS` | 12 | error | Parent MUST NOT exceed configured `maxSiblings` |
| `TYPE_HIERARCHY` | 13 | error | Subtask MUST NOT have children |
| `NO_CIRCULAR` | 14 | error | Task MUST NOT be ancestor of itself |
| `NO_ORPHANS` | 15 | warning | `parentId` MUST resolve or be null |
| `COMPLETION_ORDER` | N/A | warning | Parent with incomplete children triggers warning |

### 4.3 Migration Requirements

Migration from pre-hierarchy schema MUST:
- Add `type="task"` to all existing tasks (default)
- Add `parentId=null` to all existing tasks (root-level)
- Transform label conventions (`type:epic` → `type="epic"`)
- Transform label conventions (`parent:T001` → `parentId="T001"`)
- Remove migrated labels from labels array
- Preserve all existing data without modification

---

## Part 5: Phase Integration

> **Cross-reference**: [PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md) is the authoritative source for phase lifecycle management.
> This section covers task-level phase assignment and cross-phase dependencies.

### 5.1 Task Phase Assignment

Each task MUST have a `phase` field indicating its lifecycle stage:

| Phase | Purpose | Examples |
|-------|---------|----------|
| `setup` | Research, design, architecture, planning | Design API, Research libraries |
| `core` | Main implementation, feature development | Implement endpoint, Fix bug |
| `testing` | Test creation, validation, QA | Write unit tests, Integration tests |
| `polish` | Documentation, refactoring, cleanup | Update README, Code review |
| `maintenance` | Ongoing support, post-release fixes | Hotfix, Security patch |

**Phase Flow** (typical progression):
```
setup ──→ core ──→ testing ──→ polish ──→ maintenance
  │         │         │          │
  │         │         │          └── Docs, cleanup
  │         │         └── Validation, QA
  │         └── Implementation
  └── Research, design
```

**Schema**:
```json
{
  "phase": "core"  // enum: setup|core|testing|polish|maintenance
}
```

### 5.2 Phase vs. Status

| Concept | Purpose | Example |
|---------|---------|---------|
| **Phase** | WHEN in lifecycle (categorization) | `phase: "core"` |
| **Status** | WHAT state (progress) | `status: "pending"` |

A task can be `phase: "testing"` with `status: "pending"` (test task not yet started).

### 5.3 Cross-Phase Dependencies

Dependencies MAY cross phases. The system MUST handle cross-phase dependencies as follows:

```
setup:T1032 ──→ core:T1035 (design must complete before implementation)
core:T1039 ──→ testing:T1040 (implementation before tests)
testing:T1040 ──→ polish:T1041 (tests before docs)
```

**Resolution Rules**:

| Dependency State | Effect on Dependent Task |
|-----------------|--------------------------|
| In earlier phase, `done` | Satisfied; dependent task can proceed |
| In earlier phase, NOT `done` | Blocked until dependency completes |
| In same phase | Affects wave calculation (see Part 6) |
| In later phase | Configuration error; SHOULD warn |

---

## Part 6: Wave Computation

### 6.1 Wave Definition

> **IMMUTABLE PRINCIPLE**: Waves are COMPUTED from dependency depth, NOT stored in the schema.

Waves represent parallel execution order within a scope:
- **Wave 0**: Tasks with no unsatisfied dependencies (entry points)
- **Wave N**: Tasks whose maximum dependency wave is N-1

Tasks in the same wave MAY execute in PARALLEL.

### 6.2 Wave Calculation Algorithm

The system MUST use this algorithm:

```
FUNCTION computeWave(task, scoped_tasks, memo):
    IF task.id IN memo:
        RETURN memo[task.id]

    IF task.status == "done":
        RETURN -1  // Completed tasks excluded

    deps = task.depends OR []
    scoped_deps = FILTER deps WHERE dep IN scoped_tasks
    active_deps = FILTER scoped_deps WHERE dep.status != "done"

    IF length(active_deps) == 0:
        wave = 0  // No blocking dependencies = entry point
    ELSE:
        max_dep_wave = MAX(active_deps.map(d => computeWave(d, scoped_tasks, memo)))
        wave = max_dep_wave + 1

    memo[task.id] = wave
    RETURN wave
```

**Formula** (simplified):
```
wave(task) = max(deps.filter(d => d.status != "done").map(d => wave(d))) + 1
wave(task with no active deps) = 0
```

### 6.3 Scope Filtering

Wave computation MUST respect the analysis scope:

| Scope Type | Tasks Considered |
|------------|------------------|
| Project-wide | All non-done tasks |
| Epic-scoped (`--parent T001`) | Epic and all descendants |
| Phase-scoped | Tasks in specified phase |

**Dependency filtering within scope**:
- Dependencies INSIDE scope: Affect wave calculation
- Dependencies OUTSIDE scope but `done`: Treated as satisfied
- Dependencies OUTSIDE scope but NOT `done`: Task is BLOCKED (not in waves)

### 6.4 Cycle Detection

Circular dependencies MUST be detected and handled:

```
A depends on B, B depends on A  // Circular
```

**Handling**: Implementations MUST either:
1. Treat cyclic tasks as Wave 0 (allow progress), OR
2. Mark cyclic tasks as validation errors

The system SHOULD warn when cycles are detected.

### 6.5 Wave Visualization

For `--human` output, waves SHOULD be displayed grouped:

```
PHASE: core
├─ Wave 0: T1022, T1019 (no dependencies)
├─ Wave 1: T1017, T1025, T1026 (depends on Wave 0)
├─ Wave 2: T1018, T1023 (depends on Wave 1)
└─ Wave 3: T1020, T1021 (depends on Wave 2)
```

### 6.6 Agent Execution Model

For LLM agents and parallel workers, the system SHOULD support this execution pattern:

**Workflow**:
1. Query current phase focus
2. Get Wave 0 tasks in that phase (ready to start)
3. Execute Wave 0 tasks in parallel
4. When Wave 0 complete, Wave 1 becomes ready
5. Repeat until phase complete
6. Move to next phase

**Example Session**:
```
Agent A: "Starting session on epic:T1028"

> cleo analyze --parent T1028

Ready (Wave 0): T1029, T1030

Agent A: Works on T1029
Agent B: Works on T1030 (parallel)

Both complete → Wave 1 unlocks: T1031, T1033

Agent A: Works on T1031
Agent B: Works on T1033 (parallel)

... continues through waves and phases ...
```

**Integration with Multi-Session**:
- Each agent SHOULD scope to a specific epic or subtree
- Agents in the same scope coordinate via wave ordering
- Cross-scope dependencies are handled by the ready/blocked calculation

---

## Part 7: Ready/Blocked Calculation

### 7.1 Ready Task Formula

A task is **READY** when it can be started immediately:

```
ready(task) =
    task.status IN ["pending", "active"] AND
    (task.depends == [] OR
     task.depends.every(d => getTask(d).status == "done"))
```

**Ready conditions**:
- Status is `pending` or `active` (not `blocked` or `done`)
- Has no dependencies, OR
- All dependencies have `status: "done"`

### 7.2 Blocked Task Detection

A task is **BLOCKED** when it cannot proceed:

```
blocked(task) =
    task.depends.some(d => getTask(d).status != "done")
```

**Blocked conditions**:
- Has dependencies
- At least one dependency has `status != "done"`

### 7.3 Inventory Categories

For epic analysis, tasks MUST be categorized:

| Category | Criteria | LLM Action |
|----------|----------|------------|
| `completed` | `status == "done"` | Reference only |
| `ready` | Ready formula = true | Can start immediately |
| `blocked` | Blocked formula = true | Wait for blockers |

### 7.4 Phase Status Derivation

Phase status MUST be computed from task states:

| Phase Status | Condition |
|--------------|-----------|
| `complete` | All tasks in phase have `status: "done"` |
| `in_progress` | Some tasks `done`, some not |
| `blocked` | Has tasks with unmet dependencies from other phases |
| `pending` | No tasks started (`done` count = 0) |

---

## Part 8: Chain Visualization

### 8.1 Core Principle

> **IMMUTABLE**: Dependency chains are COMPUTED at render time, NOT stored in the schema.

The dependency graph (stored as `depends[]` on each task) contains all information
needed to derive chains. Explicit chain storage would create:
- Sync burden (chains change as tasks complete)
- Redundancy (derivable from edges)
- Schema complexity (no value for LLM agents)

**Principle**: Store EDGES (`depends[]`), Compute PATHS (chains).

### 8.2 Chain Definition

A **dependency chain** is a connected component in the task dependency graph:

- **Root**: Task with no dependencies within the scoped task set
- **Chain membership**: All tasks reachable from a root via dependency edges
- **Independent chains**: Disjoint connected components (no shared tasks)

### 8.3 Chain Detection Algorithm

Implementations SHOULD use this algorithm for `--human` visualization:

```
FUNCTION findChains(scoped_tasks):
    // Build bidirectional adjacency (deps are directed, but for
    // component detection treat as undirected)
    adjacency = buildBidirectionalAdjacency(scoped_tasks)

    // Find connected components via BFS/DFS
    components = findConnectedComponents(adjacency)

    // For each component, find root(s)
    FOR component IN components:
        roots = tasks WHERE (depends ∩ component) == ∅
        component.root = min(roots)  // Lowest ID for determinism

    // Label by root ID order
    SORT components BY component.root
    FOR i, component IN enumerate(components):
        component.id = chr(65 + i)  // A, B, C...

    RETURN components
```

### 8.4 Chain Identification Format

| Context | Format | Example |
|---------|--------|---------|
| JSON output | NOT INCLUDED | Chains not in JSON; use waves/criticalPath |
| Human output ID | Letter (A, B, C) | `CHAIN A:` |
| Human output name | Generated from root title | `"Fix session end..." (6 tasks)` |
| Programmatic reference | `chain-T{root_id}` | `chain-T1022` |

### 8.5 What LLM Agents MUST Use Instead

Agents MUST NOT rely on chain data in JSON output. Instead:

| Need | Use This |
|------|----------|
| Execution order | `executionPlan.waves[]` |
| Longest path | `executionPlan.criticalPath` |
| Ready tasks | `inventory.ready[]` |
| Blocked tasks | `inventory.blocked[].waitingOn` |
| Work distribution | Multi-session scopes |

### 8.6 Human Visualization Only

Chain visualization is a **presentation concern** for `--human` output only:

```bash
cleo analyze --parent T998 --human   # Shows chain visualization
cleo analyze --parent T998           # JSON output, NO chains field
```

The renderer MUST:
1. Compute chains from `depends[]` at display time
2. Label chains by root task ID order (A, B, C...)
3. Generate descriptive names from entry task titles
4. Render ASCII visualization with phase/wave/chain hierarchy

---

## Part 9: CLI Requirements

### 9.1 Required Flags

The `add` command MUST support:

| Flag | Values | Description |
|------|--------|-------------|
| `--type` | `epic\|task\|subtask` | Task type classification |
| `--parent` | Task ID | Parent task for hierarchy |
| `--size` | `small\|medium\|large` | Scope-based size |

The `list` command MUST support:

| Flag | Description |
|------|-------------|
| `--tree` | Hierarchical tree view |
| `--depth N` | Limit tree depth |
| `--flat` | Flat list (default) |
| `--children ID` | Direct children only |
| `--descendants ID` | All nested children |
| `--root` | Only root-level tasks |
| `--leaf` | Only tasks without children |
| `--type TYPE` | Filter by type |

### 9.2 Required Commands

The system MUST provide:

| Command | Description |
|---------|-------------|
| `tree [ID]` | Alias for `list --tree` |
| `reparent ID --to PARENT` | Move task to new parent |
| `promote ID` | Remove parent (make root-level) |

### 9.3 Output Format Requirements

**Tree View** MUST display:
```
T001 [epic] ◉ active  Authentication System
├─ T002 [task] ○ pending  JWT middleware
├─ T003 [task] ✓ done     Password hashing
└─ T004 [task] ○ pending  Session management
    └─ T005 [subtask] ○ pending  Add timeout config
```

**JSON Output** MUST include hierarchy metadata:
```json
{
  "_meta": { "format": "tree", "version": "0.17.0" },
  "tree": [
    {
      "id": "T001",
      "type": "epic",
      "depth": 0,
      "childCount": 3,
      "children": [...]
    }
  ]
}
```

### 9.4 Validation Messages (Agent-Friendly)

Error messages MUST be structured for agent recovery:

```json
{
  "error": "PARENT_NOT_FOUND",
  "code": 10,
  "message": "Parent task T999 does not exist",
  "context": { "requestedParent": "T999", "taskTitle": "New task" },
  "fix": {
    "action": "use_valid_parent",
    "command": "cleo list --type epic,task --format json"
  }
}
```

---

## Part 10: Automation Behaviors

### 10.1 Parent Auto-Complete

When all children complete, the system SHOULD auto-complete the parent based on configuration:

| Mode | Behavior |
|------|----------|
| `auto` | Parent auto-completes without prompt |
| `suggest` | Prompt user to complete parent (default) |
| `off` | No automatic behavior |

Configuration:
```json
{
  "hierarchy": {
    "autoCompleteParent": true,
    "autoCompleteMode": "suggest"
  }
}
```

### 10.2 Blocked Task Auto-Activation

When all blockers complete, blocked tasks MUST transition to `pending` status automatically.

### 10.3 Orphan Detection

The `validate` command MUST detect and report:
- Tasks with invalid `parentId` references
- Options for repair: `--unlink` (remove parentId) or `--delete` (remove orphans)

---

## Part 11: Anti-Hallucination Guardrails

> **Cross-reference**: [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) Part 5 covers ID-specific anti-hallucination design.

### 11.1 Pre-Operation Validation

| Operation | Required Validations |
|-----------|---------------------|
| `add --parent` | Parent exists, parent type valid, depth limit, sibling limit |
| `complete` | Children status check (warn if incomplete) |
| `delete/archive` | No active children |
| `reparent` | New parent exists, no cycle created, depth valid |

### 11.2 Error Codes

Hierarchy operations MUST use these exit codes:

| Code | Constant | Description |
|------|----------|-------------|
| 10 | `EXIT_PARENT_NOT_FOUND` | Parent task does not exist |
| 11 | `EXIT_DEPTH_EXCEEDED` | Maximum depth would be exceeded |
| 12 | `EXIT_SIBLING_LIMIT` | Maximum siblings would be exceeded |
| 13 | `EXIT_INVALID_PARENT_TYPE` | Subtask cannot have children |
| 14 | `EXIT_CIRCULAR_REFERENCE` | Would create cycle |
| 15 | `EXIT_ORPHAN_DETECTED` | Task has invalid parentId |

---

## Part 12: Focus Integration

### 12.1 Focus on Hierarchy

When focusing on an epic, the system MUST:
- Show epic context with child summary
- Display children status counts
- Show visual hierarchy of children

When focusing on a child task, the system MUST:
- Show parent context
- Display sibling awareness

### 12.2 Next Task Suggestion

The `next` command MUST consider hierarchy:
- Prefer tasks in currently focused epic
- Unblocked leaf tasks score higher
- Respect phase and priority
- Suggest completing siblings before starting new epic

---

## Part 13: Design Decisions (Resolved)

All major design questions have been resolved. See [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) for ID system rationale.

### ID System (RESOLVED - see ID spec)

| Question | Decision | Rationale |
|----------|----------|-----------|
| Hierarchical IDs (`T001.1.2`)? | **NO** | Violates stability; breaks references on restructure |
| Flat IDs (`T001`)? | **YES** | Simple, bounded, stable, LLM-friendly |
| Hierarchy storage? | `parentId` field | Decouples identity from structure |
| Hash IDs for multi-agent? | **DEFERRED to v1.0.0** | Flat sequential IDs sufficient with checksum-based coordination |

### Hierarchy Features (RESOLVED)

| Question | Decision | Rationale |
|----------|----------|-----------|
| Feature type needed? | **NO** | Use labels; avoids classification ambiguity |
| Max depth? | **3 levels** | Organizational; deeper = navigation overhead |
| Max siblings? | **20 (configurable)** | LLM-first design; 0 = unlimited; done tasks excluded |
| Story type needed? | **NO** | Scrum artifact; agents don't need personas |

### Operational Behaviors (RESOLVED)

| Question | Decision | Rationale |
|----------|----------|-----------|
| Cascade delete epic? | **NO** - orphan children | Preserve work; user decides cleanup |
| Archive parent archives children? | **NO** - warn only | Children may still be relevant |
| Auto-complete parent? | **YES** - configurable mode | `auto` / `suggest` / `off` in config |
| Orphan handling? | **Detect + repair options** | `--unlink` (flatten) or `--delete` |

---

## Appendix A: Migration Examples

### Label Convention to Schema

**Before (pre-hierarchy)**:
```json
{
  "id": "T001",
  "title": "Auth System",
  "labels": ["type:epic", "security"]
}
```

**After (with hierarchy)**:
```json
{
  "id": "T001",
  "title": "Auth System",
  "type": "epic",
  "parentId": null,
  "labels": ["security"]
}
```

### Fresh Project Example

```bash
# Create epic
cleo add "User Authentication" --type epic
# → T001 [epic]

# Add tasks under epic
cleo add "Implement JWT validation" --parent T001
# → T002 [task] under T001

# Add subtask
cleo add "Configure bcrypt rounds" --parent T003
# → T004 [subtask] under T003

# View hierarchy
cleo tree
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
cleo add "Title" --type epic|task|subtask --parent TXXX

# Size classification
cleo add "Title" --size small|medium|large

# List variants
cleo list --tree [--depth N]
cleo list --children TXXX
cleo list --descendants TXXX
cleo list --root
cleo list --leaf
cleo list --type epic|task|subtask

# Hierarchy management
cleo tree [TXXX]
cleo reparent TXXX --to TYYY
cleo promote TXXX

# Validation
cleo validate --fix-orphans [--unlink|--delete]
```

---

## Appendix D: Conceptual Summary

| Concept | Purpose |
|---------|---------|
| **EPIC** | Container — groups related work |
| **TASK** | Work unit — discrete deliverable |
| **SUBTASK** | Atomic unit — smallest trackable work |
| **PHASE** | Workflow stage — when in lifecycle (schema field) |
| **WAVE** | Execution order — parallel groups (computed from deps) |
| **depends** | Ordering constraint — what must complete first |
| **parentId** | Hierarchy — structural containment |

**Key Insight**:
- **Hierarchy** (Epic/Task/Subtask) = WHAT to organize
- **Phase** = WHEN in lifecycle
- **Wave** = ORDER of execution (computed, not stored)
- **Dependencies** = CONSTRAINTS between tasks

---

## Version History

| Version | Date | Change |
|---------|------|--------|
| 1.0.0 | 2025-01-16 | Initial draft (as HIERARCHY-ENHANCEMENT-SPEC) |
| 1.1.0 | 2025-01-17 | APPROVED: Added ID spec references; resolved all open questions |
| 1.2.0 | 2025-01-17 | Version reconciliation: v0.15.0/v0.16.0 → v0.17.0/v0.18.0 |
| 1.3.0 | 2025-12-20 | LLM-Agent-First sibling limits: maxSiblings=20, done tasks excluded |
| 2.0.0 | 2025-12-20 | Renamed to TASK-HIERARCHY-SPEC; RFC 2119 compliance; separated implementation report |
| 3.0.0 | 2025-12-29 | Added Parts 5-8: Phase Integration, Wave Computation, Ready/Blocked, Chain Visualization (computed, not stored). Merged content from CLEO-TASK-ORGANIZATION-SPEC.md. Renumbered parts 5-9 → 9-13. |
| 3.1.0 | 2025-12-30 | Merged remaining content from T1028-CLEO-TASK-ORGANIZATION.md: Quick Reference table, Phase Flow diagram, Agent Execution Model (6.6), Conceptual Summary (Appendix D). |

---

## Related Specifications

| Document | Relationship |
|----------|--------------|
| **[SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md)** | **AUTHORITATIVE** for specification standards |
| **[LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md)** | **AUTHORITATIVE** for ID system design; this spec defers to it |
| **[PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md)** | **AUTHORITATIVE** for phase lifecycle; Part 5 cross-references |
| **[LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md)** | LLM-first design principles underlying both specs |
| **[CONFIG-SYSTEM-SPEC.md](CONFIG-SYSTEM-SPEC.md)** | Hierarchy configuration settings |
| **[CHAIN-VISUALIZATION-SPEC.md](CHAIN-VISUALIZATION-SPEC.md)** | **AUTHORITATIVE** for chain visualization; extends Part 8 |
| **[TASK-HIERARCHY-IMPLEMENTATION-REPORT.md](TASK-HIERARCHY-IMPLEMENTATION-REPORT.md)** | Tracks implementation status |

### Archived (Content Merged)

| Document | Disposition |
|----------|-------------|
| `CLEO-TASK-ORGANIZATION-SPEC.md` | Content merged into Parts 5-8; archived to `archive/specs/` |
| `claudedocs/T1028-CLEO-TASK-ORGANIZATION.md` | Content merged into v3.1.0; archived to `claudedocs/archive/` |
| `claudedocs/T1028-EPIC-Enhanced-Epic.md` | Historical T1028 analysis; archived to `claudedocs/archive/` |

### Design References

| Document | Purpose |
|----------|---------|
| `claudedocs/T1028-DEFINITIVE-WORK-MAP.md` | Consensus decisions for chain visualization (computed, not stored) |
| `claudedocs/T1032-WAVE-COMPUTATION-ALGORITHM.md` | Detailed wave algorithm implementation |
| `claudedocs/T1028-Subgraph-Detection-Algorithm-ASCII-Render.md` | Chain detection algorithm for --human output |

---

*End of Specification*
