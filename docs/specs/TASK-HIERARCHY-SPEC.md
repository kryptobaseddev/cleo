# Task Hierarchy Specification

**Version**: 2.0.0
**Status**: ACTIVE
**Effective**: v0.17.0+
**Last Updated**: 2025-12-20

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

## Part 5: CLI Requirements

### 5.1 Required Flags

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

### 5.2 Required Commands

The system MUST provide:

| Command | Description |
|---------|-------------|
| `tree [ID]` | Alias for `list --tree` |
| `reparent ID --to PARENT` | Move task to new parent |
| `promote ID` | Remove parent (make root-level) |

### 5.3 Output Format Requirements

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

### 5.4 Validation Messages (Agent-Friendly)

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

## Part 6: Automation Behaviors

### 6.1 Parent Auto-Complete

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

### 6.2 Blocked Task Auto-Activation

When all blockers complete, blocked tasks MUST transition to `pending` status automatically.

### 6.3 Orphan Detection

The `validate` command MUST detect and report:
- Tasks with invalid `parentId` references
- Options for repair: `--unlink` (remove parentId) or `--delete` (remove orphans)

---

## Part 7: Anti-Hallucination Guardrails

> **Cross-reference**: [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) Part 5 covers ID-specific anti-hallucination design.

### 7.1 Pre-Operation Validation

| Operation | Required Validations |
|-----------|---------------------|
| `add --parent` | Parent exists, parent type valid, depth limit, sibling limit |
| `complete` | Children status check (warn if incomplete) |
| `delete/archive` | No active children |
| `reparent` | New parent exists, no cycle created, depth valid |

### 7.2 Error Codes

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

## Part 8: Focus Integration

### 8.1 Focus on Hierarchy

When focusing on an epic, the system MUST:
- Show epic context with child summary
- Display children status counts
- Show visual hierarchy of children

When focusing on a child task, the system MUST:
- Show parent context
- Display sibling awareness

### 8.2 Next Task Suggestion

The `next` command MUST consider hierarchy:
- Prefer tasks in currently focused epic
- Unblocked leaf tasks score higher
- Respect phase and priority
- Suggest completing siblings before starting new epic

---

## Part 9: Design Decisions (Resolved)

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

## Version History

| Version | Date | Change |
|---------|------|--------|
| 1.0.0 | 2025-01-16 | Initial draft (as HIERARCHY-ENHANCEMENT-SPEC) |
| 1.1.0 | 2025-01-17 | APPROVED: Added ID spec references; resolved all open questions |
| 1.2.0 | 2025-01-17 | Version reconciliation: v0.15.0/v0.16.0 → v0.17.0/v0.18.0 |
| 1.3.0 | 2025-12-20 | LLM-Agent-First sibling limits: maxSiblings=20, done tasks excluded |
| 2.0.0 | 2025-12-20 | Renamed to TASK-HIERARCHY-SPEC; RFC 2119 compliance; separated implementation report |

---

## Related Specifications

| Document | Relationship |
|----------|--------------|
| **[SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md)** | **AUTHORITATIVE** for specification standards |
| **[LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md)** | **AUTHORITATIVE** for ID system design; this spec defers to it |
| **[LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md)** | LLM-first design principles underlying both specs |
| **[CONFIG-SYSTEM-SPEC.md](CONFIG-SYSTEM-SPEC.md)** | Hierarchy configuration settings |
| **[TASK-HIERARCHY-IMPLEMENTATION-REPORT.md](TASK-HIERARCHY-IMPLEMENTATION-REPORT.md)** | Tracks implementation status |

---

*End of Specification*
