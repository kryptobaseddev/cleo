# LLM Task ID System Design Specification

**Version**: 1.0.0 FINAL
**Status**: IMMUTABLE
**Effective**: v0.17.0+ (reconciled from original v0.15.0 target)
**Supersedes**: All prior ID discussions, RFC-001, ad-hoc conventions

---

## Preamble: Why This Document Exists

This specification establishes the **permanent, immutable design** for task identification in cleo. Every decision has been validated through:

1. **Round-robin adversarial analysis** - Devil's advocate challenges
2. **Industry pattern research** - Linear, Jira, Git, file systems
3. **Database architecture review** - Normalization, integrity, queries
4. **LLM agent usability testing** - Hallucination resistance, error recovery
5. **Migration risk assessment** - Backward compatibility, rollback safety

**This document is the authoritative source.** Deviations require explicit versioned amendments.

---

## Part 1: The Immutable ID Contract

### 1.1 ID Format

```
ID ::= "T" + DIGITS
DIGITS ::= [0-9]{3,}
```

**Examples**: `T001`, `T042`, `T999`, `T1234`

**Regex Pattern**: `^T\d{3,}$`

### 1.2 The Six Guarantees

| # | Guarantee | Rationale |
|---|-----------|-----------|
| 1 | **UNIQUE** | No two tasks ever share an ID |
| 2 | **IMMUTABLE** | ID never changes after creation |
| 3 | **STABLE** | ID remains valid regardless of hierarchy changes |
| 4 | **SEQUENTIAL** | IDs increment monotonically (no gaps required) |
| 5 | **REFERENCEABLE** | Safe to use in git commits, docs, external systems |
| 6 | **RECOVERABLE** | Archive lookup always resolves historical IDs |

### 1.3 What IDs Are NOT

| Anti-Pattern | Why Rejected |
|--------------|--------------|
| **NOT hierarchical** | `T001.1.2` violates stability guarantee |
| **NOT semantic** | `AUTH-001` couples identity to categorization |
| **NOT random** | UUIDs are LLM-hostile (hallucination risk) |
| **NOT reusable** | Deleted IDs are retired permanently |
| **NOT zero-padded variably** | Always minimum 3 digits, expand as needed |

---

## Part 2: The Decisive Rejection of Hierarchical IDs

### 2.1 The Temptation

Hierarchical IDs (`T001.1.2`) appear beneficial:
- Instant visual hierarchy
- Self-documenting references
- O(1) ancestry lookup via string parsing

### 2.2 Why We Reject Them

**Finding 1: Violates Stability Guarantee**

```
# Day 1: Create hierarchy
T001 (Epic: Auth)
  └─ T001.1 (Task: JWT)
       └─ T001.1.1 (Subtask: Validation)

# Day 5: Restructure - move T001.1.1 under new parent T002
T001.1.1 must become... T002.1? T002.1.1?

# All existing references break:
# - Git: "Fixes T001.1.1" → orphaned
# - Docs: "See T001.1.1" → broken link
# - Scripts: grep T001.1.1 → no matches
```

**Finding 2: Violates Database Normalization**

Hierarchical IDs encode hierarchy in identity, violating 1NF:
- Multiple facts in single field (parent chain + position)
- Update anomalies cascade
- Data duplication (path repeated in every descendant)

**Finding 3: LLM Hallucination Risk**

```
Flat IDs: Bounded space (T001-T999 = 999 patterns)
Hierarchical: Unbounded space (T001.1.1.1.1... = infinite patterns)

LLM hallucinating "T001.5.3" vs "T999":
- T999: Easy to validate (exists check)
- T001.5.3: Must validate T001 exists, has child .5, which has child .3
```

**Finding 4: Multi-Agent Coordination Failure**

```
Agent A creates child of T001: → T001.3
Agent B creates child of T001: → T001.3 (CONFLICT!)

vs. Flat IDs:
Agent A creates child: → T055
Agent B creates child: → T056 (No conflict - single counter)
```

### 2.3 The Linear Precedent

Linear defeated Jira with flat IDs (`PROJ-123`).
Linear's success validates: **IDs identify, relationships describe.**

---

## Part 3: Hierarchy Via parentId Field

### 3.1 The Design

```json
{
  "id": "T042",
  "parentId": "T001",
  "type": "task"
}
```

**Hierarchy is a relationship, not identity.**

### 3.2 Schema Definition

```json
{
  "parentId": {
    "type": ["string", "null"],
    "pattern": "^T\\d{3,}$",
    "default": null,
    "description": "Parent task ID. Null for root-level. Must reference existing task."
  }
}
```

### 3.3 Hierarchy Operations

| Operation | Flat ID + parentId | Hierarchical ID |
|-----------|-------------------|-----------------|
| Get parent | `task.parentId` | `id.split('.').slice(0,-1).join('.')` |
| Move task | `update parentId` | **Rename ID + all descendants** |
| Delete parent | Orphan detection | **ID invalidation cascade** |
| Reference stability | 100% | 0% on restructure |
| Migration | Optional field add | **Breaking change** |

### 3.4 Display Hierarchy (CLI Sugar)

```bash
cleo list --tree

T001 [epic] Authentication System
├─ T002 [task] JWT middleware
├─ T003 [task] Password hashing
└─ T004 [task] Session management
    └─ T005 [subtask] Add timeout config
```

**Visual hierarchy achieved without encoding in ID.**

---

## Part 4: Schema v2.3.0 Changes

### 4.1 New Task Fields

```json
{
  "definitions": {
    "task": {
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^T\\d{3,}$",
          "description": "Unique stable ID. NEVER changes. NEVER reused."
        },
        "type": {
          "type": "string",
          "enum": ["epic", "task", "subtask"],
          "default": "task",
          "description": "Classification. Epic requires decomposition. Task is primary unit. Subtask is atomic."
        },
        "parentId": {
          "type": ["string", "null"],
          "pattern": "^T\\d{3,}$",
          "default": null,
          "description": "Parent task ID. Null for root. Must exist in tasks array."
        },
        "size": {
          "type": ["string", "null"],
          "enum": ["small", "medium", "large", null],
          "default": null,
          "description": "Scope-based size. Large must decompose. NO TIME ESTIMATES."
        }
      }
    }
  }
}
```

### 4.2 Hierarchy Validation Rules

```json
{
  "hierarchyRules": [
    {
      "rule": "PARENT_EXISTS",
      "description": "parentId must reference existing task.id",
      "errorCode": 10,
      "severity": "error"
    },
    {
      "rule": "MAX_DEPTH",
      "description": "Maximum 3 levels: epic(0) → task(1) → subtask(2)",
      "errorCode": 11,
      "severity": "error"
    },
    {
      "rule": "MAX_SIBLINGS",
      "description": "Maximum 7 children per parent",
      "errorCode": 12,
      "severity": "error"
    },
    {
      "rule": "TYPE_HIERARCHY",
      "description": "subtask cannot have children",
      "errorCode": 13,
      "severity": "error"
    },
    {
      "rule": "NO_CIRCULAR",
      "description": "Task cannot be ancestor of itself",
      "errorCode": 14,
      "severity": "error"
    },
    {
      "rule": "NO_ORPHANS",
      "description": "parentId must resolve or be null",
      "errorCode": 15,
      "severity": "warning"
    }
  ]
}
```

### 4.3 Full Schema Diff (v2.2.0 → v2.3.0)

```diff
  "definitions": {
    "task": {
      "properties": {
        "id": { ... },
        "title": { ... },
        "status": { ... },
        "priority": { ... },
+       "type": {
+         "type": "string",
+         "enum": ["epic", "task", "subtask"],
+         "default": "task"
+       },
+       "parentId": {
+         "type": ["string", "null"],
+         "pattern": "^T\\d{3,}$",
+         "default": null
+       },
+       "size": {
+         "type": ["string", "null"],
+         "enum": ["small", "medium", "large", null],
+         "default": null
+       },
        "phase": { ... },
        "description": { ... },
        ...
      }
    }
  }
```

---

## Part 5: Anti-Hallucination Design

### 5.1 Bounded ID Space

```
Valid IDs: T001, T002, ..., T999, T1000, T1001, ...
Invalid: T0, T00, T1, TXXX, t001, 001, T001.1
```

**Single simple pattern = minimal hallucination surface.**

### 5.2 Existence Validation

```bash
# Before ANY operation on ID, validate exists
cleo exists T042 --quiet && cleo complete T042
```

**Agent protocol**: NEVER reference ID without prior confirmation.

### 5.3 Error Messages (Agent-Optimized)

```json
{
  "error": "TASK_NOT_FOUND",
  "code": 1,
  "requestedId": "T999",
  "validIdRange": {"min": "T001", "max": "T042"},
  "suggestion": "Use 'cleo list --format json' to get valid IDs",
  "recoveryCommand": "cleo list --status pending"
}
```

### 5.4 Reference Validation in Commits

```bash
# Git pre-commit hook (optional)
#!/bin/bash
TASK_IDS=$(git diff --cached | grep -oE 'T[0-9]{3,}' | sort -u)
for id in $TASK_IDS; do
  if ! cleo exists "$id" --quiet --include-archive; then
    echo "WARNING: Referenced task $id not found in cleo"
  fi
done
```

---

## Part 6: Multi-Agent Coordination

### 6.1 The Problem

Multiple LLM agents working on same project:
- Agent A creates task → T043
- Agent B creates task → T043 (CONFLICT!)

### 6.2 Solution: Centralized Counter

```json
{
  "_meta": {
    "nextId": 44,
    "checksum": "abc123..."
  }
}
```

**Atomic ID generation**:
```bash
# file-ops.sh::get_next_id()
1. Acquire file lock
2. Read _meta.nextId
3. Increment and write
4. Release lock
5. Return T{padded_id}
```

### 6.3 Conflict Resolution

If collision detected (checksum mismatch):
```bash
1. Re-read file (fresh state)
2. Regenerate ID with new counter
3. Retry operation
4. Max 3 retries, then fail with CONCURRENT_MODIFICATION
```

### 6.4 Future: Agent Namespacing (Deferred to v1.0.0)

```json
{
  "id": "T042",
  "createdByAgent": "agent_abc123",
  "agentSession": "session_20250117_143022"
}
```

Namespacing provides audit trail without affecting ID format.

---

## Part 7: Migration Simplicity

### 7.1 Migration Path: v2.2.0 → v2.3.0

```bash
cleo migrate run --auto

# Transforms:
# 1. Add type="task" to all existing tasks (default)
# 2. Add parentId=null to all existing tasks (root-level)
# 3. No ID changes whatsoever
```

### 7.2 Zero Breaking Changes

| What | Before | After |
|------|--------|-------|
| Task T042 | `{"id": "T042", ...}` | `{"id": "T042", "type": "task", "parentId": null, ...}` |
| Git refs | `"Fixes T042"` | Still valid |
| Scripts | `grep T042` | Still works |
| External links | `project.dev/T042` | Still resolves |

### 7.3 Rollback Capability

```bash
# If hierarchy feature fails:
jq '.tasks[] | del(.type, .parentId, .size)' todo.json > todo-flat.json

# All IDs remain valid
# All references preserved
# Zero data loss
```

### 7.4 Contrast: Hierarchical ID Migration

```
# Would require:
# 1. Compute new hierarchical IDs
# 2. Update all tasks with new IDs
# 3. Update all depends arrays
# 4. Update all external references (IMPOSSIBLE for git commits)
# 5. Maintain old→new mapping forever
# 6. No rollback possible without permanent reference rot
```

---

## Part 8: Reference Stability

### 8.1 The Eternal Reference Promise

```
Any T{NNN} ID created by cleo will ALWAYS resolve to the same task entity,
regardless of:
- Hierarchy changes (reparenting, promoting)
- Phase transitions
- Status changes
- Archive/restore cycles
- Project restructuring
```

### 8.2 ID Lifecycle

```
Created → Active → Completed → Archived → Lookup-able
    │                              │
    └── ID never changes ──────────┘
```

### 8.3 Archive Resolution

```bash
cleo show T001 --include-archive

# If T001 is archived:
# Searches todo.json → not found
# Searches todo-archive.json → found
# Returns task data with archive context
```

### 8.4 External System Integration

| System | Reference Pattern | Stability |
|--------|-------------------|-----------|
| Git commits | `"Fixes T042"` | Eternal |
| Documentation | `See [T042]` | Eternal |
| URLs | `/tasks/T042` | Eternal |
| Jira links | `EXT-123 → T042` | Eternal |
| Slack/Discord | `working on T042` | Eternal |

---

## Part 9: Task Type Taxonomy

### 9.1 Three Types Only

| Type | Definition | Can Have Children | Can Have Parent |
|------|------------|-------------------|-----------------|
| **epic** | Strategic initiative requiring decomposition | Yes (7 max) | No |
| **task** | Primary work unit | Yes (7 max) | Yes |
| **subtask** | Atomic operation | No | Yes |

### 9.2 Type Selection Algorithm

```python
def classify_work(scope):
    if requires_decomposition(scope):
        return "epic"
    elif is_atomic(scope):
        return "subtask"
    else:
        return "task"

def requires_decomposition(scope):
    return (
        scope.file_count > 10 or
        scope.component_count > 3 or
        scope.complexity == "high" or
        scope.context_risk == "degradation_likely"
    )

def is_atomic(scope):
    return (
        scope.file_count <= 1 and
        scope.change_type in ["config", "fix_typo", "add_field"] and
        scope.complexity == "trivial"
    )
```

### 9.3 Why NOT Feature/Story

| Rejected | Rationale |
|----------|-----------|
| **Feature** | SAFe/enterprise artifact; semantic overlap with Epic |
| **Story** | Scrum ceremony; implies user personas; agents don't need personas |
| **Initiative** | Portfolio-level; outside project scope |

---

## Part 10: Size Model (LLM-Centric)

### 10.1 PROHIBITED

```
NEVER USE:
- Hours, days, weeks
- Story points
- T-shirt sizes mapped to time
- Sprint capacities
- Time-based estimates of any kind
```

### 10.2 Size Dimensions

| Size | File Scope | Complexity | Context Risk |
|------|------------|------------|--------------|
| **small** | 1-2 files | Straightforward | Minimal |
| **medium** | 3-7 files | Moderate decisions | Contained |
| **large** | 8+ files | Architectural | High → **MUST DECOMPOSE** |

### 10.3 Large Triggers Decomposition

```bash
cleo add "Implement auth system" --size large
WARNING: Large scope detected
Action: Decompose into medium/small tasks before proceeding

# Forced workflow:
1. Create epic: cleo add "Auth system" --type epic
2. Add children: cleo add "JWT validation" --parent T001 --size medium
3. No single task remains "large"
```

---

## Part 11: Constraints and Limits

### 11.1 Hard Limits

| Constraint | Value | Rationale |
|------------|-------|-----------|
| Max depth | 3 | Organizational; deeper = navigation overhead |
| Max siblings | 0 (unlimited) | LLM agents don't need cognitive limits |
| Min ID digits | 3 | `T001` not `T1` |
| ID pattern | `^T\d{3,}$` | Simple, bounded, unmistakable |

### 11.2 Soft Limits (Warnings)

| Constraint | Threshold | Action |
|------------|-----------|--------|
| Tasks in epic | >7 | Warning: "Consider splitting epic" |
| Pending tasks | >50 | Warning: "Review and archive stale tasks" |
| Active tasks | >1 | Error: "Only ONE active task allowed" |

---

## Part 12: Error Codes

> **Cross-reference**: [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) Part 3.1 contains the full `lib/exit-codes.sh` implementation including general error codes (1-9).

### Exit Codes (Numeric)

```bash
# General Errors (1-9) - see LLM-AGENT-FIRST-SPEC
EXIT_NOT_FOUND=4              # Task not found (general)

# Hierarchy Errors (10-19)
EXIT_PARENT_NOT_FOUND=10      # parentId references non-existent task
EXIT_DEPTH_EXCEEDED=11        # Max hierarchy depth (3) exceeded
EXIT_SIBLING_LIMIT=12         # Max siblings exceeded (if configured)
EXIT_INVALID_PARENT_TYPE=13   # subtask cannot have children
EXIT_CIRCULAR_REFERENCE=14    # Task would be ancestor of itself
EXIT_ORPHAN_DETECTED=15       # Task has invalid parentId

# Concurrency Errors (20-29)
EXIT_CHECKSUM_MISMATCH=20     # File modified externally
EXIT_CONCURRENT_MODIFICATION=21  # Multi-agent conflict
EXIT_ID_COLLISION=22          # ID generation conflict
```

### Error Codes (String - for JSON output)

All JSON error responses use `E_` prefix convention:

| Exit Code | String Code | Description |
|-----------|-------------|-------------|
| 4 | `E_TASK_NOT_FOUND` | Task ID does not exist |
| 10 | `E_PARENT_NOT_FOUND` | Parent task does not exist |
| 11 | `E_DEPTH_EXCEEDED` | Would exceed max depth (3) |
| 12 | `E_SIBLING_LIMIT` | Parent has max children (7) |
| 13 | `E_INVALID_PARENT_TYPE` | Subtask cannot have children |
| 14 | `E_CIRCULAR_REFERENCE` | Would create ancestry loop |
| 15 | `E_ORPHAN_DETECTED` | parentId points to missing task |
| 20 | `E_CHECKSUM_MISMATCH` | Stale data detected |
| 21 | `E_CONCURRENT_MODIFICATION` | Multi-agent conflict |
| 22 | `E_ID_COLLISION` | ID already exists |

---

## Part 13: CLI Reference

### 13.1 ID-Related Flags

```bash
# Task creation
cleo add "Title" --type epic|task|subtask
cleo add "Title" --parent T001
cleo add "Title" --size small|medium|large

# Task queries
cleo show T042
cleo show T042 --ancestors
cleo exists T042 --quiet

# Hierarchy views
cleo list --tree
cleo list --tree --depth 2
cleo list --children T001
cleo list --descendants T001
cleo list --root
cleo list --type epic

# Hierarchy operations
cleo reparent T042 --to T005
cleo promote T042
```

### 13.2 JSON Output (Agent-Friendly)

```bash
cleo show T042 --format json
```

```json
{
  "task": {
    "id": "T042",
    "title": "Implement JWT validation",
    "type": "task",
    "parentId": "T001",
    "status": "pending"
  },
  "hierarchy": {
    "depth": 1,
    "ancestors": ["T001"],
    "childCount": 0,
    "siblingCount": 2
  },
  "context": {
    "parentTitle": "Authentication System",
    "parentStatus": "active"
  }
}
```

---

## Part 14: Implementation Reference

> **Implementation tracking is maintained separately from this specification.**
>
> See **[LLM-TASK-ID-SYSTEM-DESIGN-IMPLEMENTATION-REPORT.md](LLM-TASK-ID-SYSTEM-DESIGN-IMPLEMENTATION-REPORT.md)** for current status, phase tracking, and completion metrics.

This specification defines WHAT MUST be implemented. The Implementation Report tracks progress toward compliance.

---

## Part 15: Appendices

### A. Adversarial Analysis Summary

| Perspective | Finding | Impact on Design |
|-------------|---------|------------------|
| Devil's Advocate | Hierarchical IDs provide instant visual context | Mitigated by `--tree` display |
| Linear Advocate | IDs should identify, not encode | Confirmed: flat IDs |
| Database Architect | Hierarchical violates 1NF, creates anomalies | Confirmed: flat + parentId |
| LLM Expert | Bounded ID space reduces hallucination | Confirmed: `T\d{3,}` pattern |
| Migration Specialist | Hierarchical = breaking change | Confirmed: additive fields only |

### B. Industry Precedents

| System | ID Pattern | Hierarchy Method | Success |
|--------|------------|------------------|---------|
| Linear | PROJ-123 | Parent field | Beat Jira |
| GitHub | #123 | Flat | Industry standard |
| Git | SHA (40 char) | Parent commits | Universal |
| Jira | PROJ-123 | Complex hierarchy | Declining |

### C. Rejected Alternatives

| Alternative | Why Rejected |
|-------------|--------------|
| UUIDs | LLM-hostile, high hallucination risk |
| Hash IDs | Unpredictable, requires lookup |
| Hierarchical IDs | Violates stability, complex migration |
| Semantic IDs | Couples identity to categorization |
| Zero-padded variable | Inconsistent pattern |

### D. Version History

| Version | Date | Author | Change |
|---------|------|--------|--------|
| 1.0.0 FINAL | 2025-01-17 | LLM Research Panel | Initial immutable spec |

---

## Conclusion

This specification establishes the **permanent ID system** for cleo:

1. **Flat sequential IDs** (`T001`, `T002`, `T003`)
2. **Hierarchy via `parentId` field**, not encoded in ID
3. **Six guarantees**: Unique, Immutable, Stable, Sequential, Referenceable, Recoverable
4. **Three types**: Epic → Task → Subtask (max depth 3)
5. **Scope-based sizing**: Small/Medium/Large (NEVER time)
6. **Anti-hallucination**: Bounded pattern, existence validation
7. **Multi-agent safe**: Centralized counter, checksum verification
8. **Migration simple**: Additive fields, zero breaking changes
9. **Reference stability**: IDs eternal, archive-recoverable

**This design is FINAL. Deviations require versioned amendments.**

---

## Related Specifications

| Document | Relationship |
|----------|--------------|
| **[SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md)** | **AUTHORITATIVE** for specification standards |
| **[TASK-HIERARCHY-SPEC.md](TASK-HIERARCHY-SPEC.md)** | Hierarchy features; defers to this spec for ID design |
| **[LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md)** | CLI output formats, JSON envelopes, exit codes implementation |
| **[LLM-TASK-ID-SYSTEM-DESIGN-IMPLEMENTATION-REPORT.md](LLM-TASK-ID-SYSTEM-DESIGN-IMPLEMENTATION-REPORT.md)** | Tracks implementation status against this spec |

---

*End of Specification*
