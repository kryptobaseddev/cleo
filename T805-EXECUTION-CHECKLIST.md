# T805: Explicit Positional Ordering System - Execution Checklist

**Epic**: T805
**Status**: Ready for execution
**Total Tasks**: 21 (6 tasks, 15 subtasks)

---

## Execution Order

Tasks are ordered by dependencies. Complete each task before moving to dependent tasks.
Parallel tasks (same indentation level with no dependency between them) can be worked simultaneously.

---

## Phase 1: Research & Design (T1210) ✅

### Step 1: Research
- [x] **T1211**: Research existing ordering patterns
  - Study phase.order implementation in cleo
  - Research external patterns (Linear, Notion, Kanban boards)
  - Document findings in task notes

### Step 2: Design Decisions (parallel)
- [x] **T1212**: Document position scope decision *(depends: T1211)*
  - DECISION: Per-Parent Scope (Option A)
  - Document rationale: matches hierarchy, small numbers, proven pattern

- [x] **T1213**: Document enforcement strategy *(depends: T1211)*
  - DECISION: Hybrid (Option 3)
  - Auto-assign pos=max+1, allow --position override, warn on gaps

### Step 3: Design Specifications
- [x] **T1214**: Design schema specification *(depends: T1212, T1213)*
  - Define position field: integer, 1-indexed, per-parent scope
  - Add positionVersion for optimistic locking
  - Define validation rules and constraints

- [x] **T1215**: Design command interface *(depends: T1212)*
  - Define: `ct reorder T### --position N | --before T### | --after T###`
  - Define: `ct swap T### T###`
  - Define --position flag for add command

### Step 4: Mark Design Complete
- [x] **T1210**: Research & Design Position System *(auto-completes when children done)*

---

## Phase 2: Schema Implementation (T1216) ✅

- [x] **T1216**: Implement Position Schema *(depends: T1210)*
  - Add position field to `schemas/todo.schema.json`
  - Integer, 1-indexed, required
  - Add positionVersion for optimistic locking
  - Update `lib/validation.sh` for position constraints

---

## Phase 3: Implementation (Parallel Tracks) ✅

After T1216 completes, three tracks can proceed in parallel:

### Track A: Reorder Commands (T1217) ✅

#### Step 5: Core Reorder
- [x] **T1218**: Implement reorder command
  - Create `scripts/reorder.sh`
  - Support --position N, --before T###, --after T###
  - Implement shuffle_up and shuffle_down cascade logic
  - Return change manifest with all affected items

#### Step 6: Additional Commands (parallel after T1218)
- [x] **T1219**: Implement swap command *(depends: T1218)*
  - Add swap subcommand: `ct swap T001 T002`
  - Exchange positions of two siblings
  - Validate same parent scope
  - Atomic operation

- [x] **T1220**: Integrate position in add command *(depends: T1218)*
  - Modify `scripts/add-task.sh`
  - Auto-assign position = max_sibling_position + 1
  - Support --position N override for manual placement
  - Shuffle existing if inserting

- [x] **T1221**: Handle position on reparent *(depends: T1218)*
  - Modify `scripts/reparent.sh`
  - Step 1: Close gap in old parent (shift up)
  - Step 2: Make room in new parent (shift down)
  - Preserve subtask positions

#### Step 7: Mark Commands Complete
- [x] **T1217**: Implement Reorder Commands *(auto-completes when children done)*

---

### Track B: Display Updates (T1222) ✅

#### Step 5: List Sort
- [x] **T1223**: Add --sort position to list command
  - Modify `scripts/list-tasks.sh`
  - Add position to sort options
  - Sort by position ASC within parent scope
  - Null positions sort last

#### Step 6: Tree and Formatting (parallel after T1223)
- [x] **T1224**: Update tree command for position order *(depends: T1223)*
  - Modify `scripts/tree.sh`
  - Children ordered by position within parent
  - Add --ordered flag
  - Display position numbers [1], [2], [3] inline

- [x] **T1225**: Add dependency-aware display formatting *(depends: T1223)*
  - Show blocked-by: and depends: inline in list/tree output
  - Visual format per T805 notes mockup
  - Clear execution sequence visibility for LLM agents

#### Step 7: Mark Display Complete
- [x] **T1222**: Update Display for Position Ordering *(auto-completes when children done)*

---

### Track C: Migration (T1226) ✅

- [x] **T1226**: Implement Position Migration *(depends: T1216)*
  - Auto-assign positions to existing tasks without position field
  - Order by createdAt within each parent scope
  - Idempotent operation
  - Create backup before migration

---

## Phase 4: Testing & Documentation (T1227) ✅

*(Depends on: T1217, T1222, T1226 - all three tracks complete)*

### Step 8: Unit Tests
- [x] **T1228**: Unit tests for position shuffle logic
  - `tests/unit/position-shuffle.bats`
  - Test shuffle_up, shuffle_down
  - Test gap normalization
  - Test boundary conditions
  - Test invariant validation

### Step 9: Integration Tests
- [x] **T1229**: Integration tests for reorder commands *(depends: T1228)*
  - `tests/integration/reorder.bats`
  - Test `ct reorder --position/--before/--after`
  - Test `ct swap`
  - Test `ct add --position`
  - Test `ct reparent` position handling
  - Verify cascade changes

### Step 10: Documentation
- [x] **T1230**: Update command documentation *(depends: T1229)*
  - `docs/commands/reorder.md`: Document reorder/swap commands
  - Update CLAUDE.md with position workflow section
  - Add examples for common operations

### Step 11: Mark Tests Complete
- [x] **T1227**: Add Tests and Documentation *(auto-completes when children done)*

---

## Phase 5: Epic Completion ✅

- [x] **T805**: Explicit Positional Ordering System *(COMPLETED)*

---

## Quick Reference: Dependency Graph

```
T1211 (Research)
   │
   ├── T1212 (Scope) ────┬── T1214 (Schema Design) ──┐
   │                     │                           │
   └── T1213 (Enforce) ──┘                           │
                         │                           │
                         └── T1215 (Cmd Design) ─────┤
                                                     │
                                                     ▼
                                              T1210 (Design)
                                                     │
                                                     ▼
                                              T1216 (Schema)
                                                     │
              ┌──────────────────┬──────────────────┼──────────────────┐
              ▼                  ▼                  ▼                  │
         T1218 (reorder)    T1223 (list sort)   T1226 (Migration)     │
              │                  │                                     │
    ┌────┬────┼────┐      ┌─────┴─────┐                               │
    ▼    ▼    ▼    ▼      ▼           ▼                               │
 T1219 T1220 T1221      T1224      T1225                              │
              │           │                                            │
              ▼           ▼                                            │
         T1217 (Cmds)  T1222 (Display)                                │
              │           │                                            │
              └─────┬─────┴────────────────────────────────────────────┘
                    ▼
              T1227 (Tests)
                    │
                    ▼
              T1228 (Unit)
                    │
                    ▼
              T1229 (Integration)
                    │
                    ▼
              T1230 (Docs)
                    │
                    ▼
              T805 COMPLETE
```

---

## Key Design Decisions (Reference)

### Position Scope: Per-Parent (Option A)
- Each parent has its own position sequence 1..N
- Epic children: pos 1,2,3 | Task children: pos 1,2,3 (independent)

### Enforcement: Hybrid (Option 3)
- Auto-assign position = max_sibling + 1 on creation
- Allow --position override
- Warn if gaps exist
- Backward migration for existing tasks (by createdAt)

### Shuffle Rules
- **SHUFFLE_UP** (target < current): siblings WHERE pos >= target AND pos < current → pos + 1
- **SHUFFLE_DOWN** (target > current): siblings WHERE pos > current AND pos <= target → pos - 1

### Invariants
1. Within any parent, positions form continuous sequence [1,2,3,...,N]
2. No two siblings share same position
3. Global ID never changes regardless of position changes
4. Moving parent does not alter children's position values
5. SUM of position changes in any shuffle = 0 (conservation)

---

*Generated: 2026-01-02*
