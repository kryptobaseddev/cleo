# Phase System Specification

**Status**: ACTIVE
**Version**: v2.2.2
**Last Updated**: 2025-12-30
**Schema Version**: 2.2.0

---

## 1. Overview

The Phase System provides **project-level phase lifecycle management** for cleo, enabling tracking of which workflow stage a project is in while maintaining task-level phase categorization.

### 1.1 Design Philosophy

The system follows these core principles:

| Principle | Implementation |
|-----------|---------------|
| **Permissive by Default** | Cross-phase work allowed without blocking |
| **Explicit Intent** | Rollbacks require `--rollback` flag |
| **Data Integrity** | Atomic operations with validation |
| **Audit Trail** | Complete history of all phase transitions |
| **Graceful Degradation** | Commands work without project phase set |

### 1.2 Dual-Level Phase Model

```
PROJECT LEVEL (lifecycle)          TASK LEVEL (categorization)
┌─────────────────────────┐        ┌─────────────────────────┐
│ project.currentPhase    │        │ task.phase              │
│ project.phases[].status │        │ (string field)          │
│ project.phaseHistory[]  │        │                         │
│                         │        │                         │
│ Tracks: "Where is the   │        │ Tracks: "What category  │
│  project right now?"    │        │  is this task?"         │
└─────────────────────────┘        └─────────────────────────┘
```

---

## 2. Schema Specification

### 2.1 Project Object

**Location**: `todo.json → project`

```json
{
  "project": {
    "name": "string (required)",
    "currentPhase": "string | null",
    "phases": { "<slug>": PhaseDefinition },
    "phaseHistory": [ PhaseHistoryEntry ]
  }
}
```

### 2.2 Phase Definition Object

**Location**: `project.phases.<slug>`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `order` | integer | **Yes** | Display/transition order (min: 1) |
| `name` | string | **Yes** | Human-readable name (max 50 chars) |
| `description` | string | No | Phase description (max 200 chars) |
| `status` | enum | **Yes** | `pending` \| `active` \| `completed` |
| `startedAt` | ISO 8601 | No | When phase became active |
| `completedAt` | ISO 8601 | No | When phase was completed |

**Constraints**:
- Slug pattern: `^[a-z][a-z0-9-]*$` (lowercase, alphanumeric, hyphens)
- **Only ONE phase** may have `status: "active"` at any time
- `startedAt` required when `status: "active"` or `status: "completed"`
- `completedAt` required when `status: "completed"`

**Example**:
```json
{
  "phases": {
    "setup": {
      "order": 1,
      "name": "Setup & Foundation",
      "status": "completed",
      "startedAt": "2025-12-01T10:00:00Z",
      "completedAt": "2025-12-05T18:30:00Z"
    },
    "core": {
      "order": 2,
      "name": "Core Development",
      "status": "active",
      "startedAt": "2025-12-05T18:30:00Z"
    },
    "polish": {
      "order": 3,
      "name": "Polish & Refinement",
      "status": "pending"
    }
  }
}
```

### 2.3 Phase History Entry Object

**Location**: `project.phaseHistory[]`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `phase` | string | **Yes** | Phase slug |
| `transitionType` | enum | **Yes** | `started` \| `completed` \| `rollback` |
| `timestamp` | ISO 8601 | **Yes** | When transition occurred |
| `taskCount` | integer | **Yes** | Tasks in phase at transition time (min: 0) |
| `fromPhase` | string | Conditional | Previous phase (required for `rollback`) |
| `reason` | string | No | Context for transition (max 500 chars) |

**Example**:
```json
{
  "phaseHistory": [
    {
      "phase": "setup",
      "transitionType": "started",
      "timestamp": "2025-12-01T10:00:00Z",
      "taskCount": 14,
      "reason": "Phase started via 'phase start'"
    },
    {
      "phase": "setup",
      "transitionType": "completed",
      "timestamp": "2025-12-05T18:30:00Z",
      "taskCount": 14
    },
    {
      "phase": "core",
      "transitionType": "started",
      "timestamp": "2025-12-05T18:30:00Z",
      "taskCount": 63,
      "fromPhase": "setup",
      "reason": "Phase started via 'phase advance' from setup"
    }
  ]
}
```

### 2.4 Focus Integration

The focus object syncs with project phase:

```json
{
  "focus": {
    "currentTask": "T001",
    "currentPhase": "core"  // Synced with project.currentPhase
  }
}
```

---

## 3. Phase Lifecycle States

### 3.1 State Diagram

```
                    phase start
    ┌──────────┐ ──────────────► ┌──────────┐
    │ PENDING  │                 │  ACTIVE  │
    └──────────┘                 └──────────┘
         ▲                            │
         │                            │ phase complete
         │ phase set --rollback       │
         │                            ▼
         │                       ┌──────────┐
         └────────────────────── │COMPLETED │
                                 └──────────┘
```

### 3.2 Valid Transitions

| From | To | Command | Constraints |
|------|----|---------|-------------|
| `pending` | `active` | `phase start` | Only one active phase |
| `active` | `completed` | `phase complete` | All tasks must be done (configurable) |
| `completed` | `active` | `phase set --rollback` | Explicit rollback flag required |
| Any | (current) | `phase set` | Sets `project.currentPhase` pointer |

### 3.3 Invariants

1. **Single Active Phase**: At most ONE phase can have `status: "active"`
2. **Timestamp Ordering**: `startedAt < completedAt` when both present
3. **Current Phase Consistency**: `project.currentPhase` must match a phase with `status: "active"` (when set)
4. **History Immutability**: Phase history entries are append-only

---

## 4. Command Specification

### 4.1 Phase Commands

| Command | Description | Flags |
|---------|-------------|-------|
| `phase show` | Display current project phase | `--format`, `--json` |
| `phase set <slug>` | Set current phase pointer | `--rollback`, `--force`, `--format` |
| `phase start <slug>` | Transition pending → active | `--format` |
| `phase complete <slug>` | Transition active → completed | `--format` |
| `phase advance` | Complete current + start next | `--force`, `--format` |
| `phase list` | List all phases with status | `--format` |
| `phase rename <old> <new>` | Rename phase atomically | `--format` |
| `phase delete <slug>` | Delete phase with protection | `--reassign-to`, `--force`, `--format` |

### 4.2 Rollback Behavior

**Detection**: Rollback detected when `new_phase.order < current_phase.order`

**Workflow**:
```bash
# Without flag: BLOCKED
ct phase set setup
# ERROR: Rolling back from 'core' (order 2) to 'setup' (order 1) requires --rollback flag

# With flag: INTERACTIVE CONFIRMATION
ct phase set setup --rollback
# WARNING: This will rollback from 'core' to 'setup'. Continue? [y/N]

# With force: IMMEDIATE
ct phase set setup --rollback --force
# Phase rolled back to: setup (from core)
```

**Audit Trail**: Rollbacks are logged with:
- `log_phase_rollback()` in todo-log.json
- `add_phase_history_entry()` with `transitionType: "rollback"` and `fromPhase`

### 4.3 Phase Advance Behavior

**Configurable Thresholds**:

```json
{
  "validation": {
    "phaseValidation": {
      "enforcePhaseOrder": false,
      "phaseAdvanceThreshold": 90,
      "blockOnCriticalTasks": true,
      "warnPhaseContext": false
    }
  }
}
```

**Behavior**:
1. **Critical Task Blocking**: If `blockOnCriticalTasks: true` and critical priority tasks are incomplete, advancement is BLOCKED (even with `--force`)
2. **Threshold Check**: If completion < `phaseAdvanceThreshold`%, advancement requires `--force`
3. **Interactive Prompt**: Shows incomplete task breakdown by priority
4. **Logging**: Records both completion and start transitions in phase history

### 4.4 Rename Operation

**Atomic Multi-Step**:
1. Create new phase definition with new name
2. Update all `task.phase` references
3. Update `project.currentPhase` if matches
4. Update `focus.currentPhase` if matches
5. Delete old phase definition
6. Backup created before operation
7. Rollback on any failure

```bash
ct phase rename core development
# Updated 63 task(s)
# Updated project.currentPhase
# Renamed phase: core → development
```

### 4.5 Delete Operation

**Protection Levels**:
1. **Current Phase**: Cannot delete active project phase
2. **Tasks Exist**: Blocked unless `--reassign-to <phase>` provided
3. **Force Required**: Always requires `--force` flag

```bash
# Delete with reassignment
ct phase delete old-phase --reassign-to setup --force
# Reassigned 5 task(s) to 'setup'
# Deleted phase: old-phase

# Delete empty phase
ct phase delete old-phase --force
# Deleted phase: old-phase (no tasks affected)
```

---

## 5. Behavioral Specifications

### 5.1 No Project Phase Set (Graceful Degradation)

When `project.currentPhase` is null:
- All commands function normally
- `phase show` reports "No current phase set"
- Dashboard shows phase distribution without highlighting
- New tasks use `defaults.phase` from config (if set)
- No phase-based filtering applied

### 5.2 Task Phase vs Project Phase Mismatch

**Default Behavior**: Permissive mode
- Working on tasks outside current project phase is ALLOWED
- No warnings by default
- Optional: Set `validation.warnPhaseContext: true` for warnings

**Example**:
```bash
# Project in core, working on polish task
ct focus set T099  # phase: polish
# Works without error (permissive mode)
```

### 5.3 Phaseless Tasks

Tasks with `phase: null` are treated as **phase-agnostic**:
- Visible in all phase views
- Never block phase advancement
- Listed with `[no-phase]` indicator
- Not affected by project.currentPhase

### 5.4 Multiple Active Phases Detection

**Validation**: `ct validate` checks for multiple phases with `status: "active"`

**Recovery with --fix**:
1. Interactive prompt asks which phase to keep
2. Non-interactive mode selects first by order
3. Backup created before fix
4. Other phases set to `status: "completed"`
5. Action logged to todo-log.json

---

## 6. Integration Specifications

### 6.1 TodoWrite Sync

**Injection** (`sync --inject`):
- Saves `project.currentPhase` in session state file
- Uses current phase for tier-based task filtering
- Phase metadata preserved in session

**Extraction** (`sync --extract`):
- Detects if project phase changed during session
- Warns if phase mismatch detected
- New tasks inherit phase from focused task or `defaults.phase`
- Override with `--default-phase <phase>` flag

### 6.2 Archive Integration

**Statistics Updated on Archive**:

```json
{
  "phaseSummary": {
    "setup": {
      "totalTasks": 14,
      "firstCompleted": "2025-12-01T...",
      "lastCompleted": "2025-12-05T..."
    }
  },
  "statistics": {
    "byPhase": { "setup": 14, "core": 63 },
    "byPriority": { "critical": 5, "high": 20, "medium": 40, "low": 10 },
    "byLabel": { "bug": 12, "feature": 45 },
    "averageCycleTime": 3.5
  }
}
```

### 6.3 Dashboard Display

**Phase Section**:
```
┌─────────────────────────────────────────┐
│  PROJECT DASHBOARD                      │
│  my-project                             │
│  Current Phase: Core Development (core) │
├─────────────────────────────────────────┤
│  PHASES                                 │
│    Setup      ████████████  14/14  ✓    │
│  ★ Core Dev   ████████░░░░   8/63       │
│    Polish     ░░░░░░░░░░░░   0/22       │
└─────────────────────────────────────────┘
```

- Current phase marked with ★
- Progress bars show completion
- Completed phases show ✓

### 6.4 Task Creation

**Phase Assignment Priority**:
1. Explicit `--phase <slug>` flag (highest)
2. `project.currentPhase` (if set)
3. `defaults.phase` from config
4. No phase (if none of above)

---

## 7. Validation Rules

### 7.1 Schema Validation

| Rule | Check | Error Code |
|------|-------|------------|
| Single active phase | `count(status=active) <= 1` | `E_MULTIPLE_ACTIVE_PHASES` |
| Current phase exists | `currentPhase in phases.keys()` | `E_INVALID_CURRENT_PHASE` |
| Timestamp ordering | `startedAt < completedAt` | `E_INVALID_PHASE_TIMESTAMPS` |
| Required timestamps | Active requires startedAt | `E_MISSING_STARTED_AT` |
| Slug pattern | `^[a-z][a-z0-9-]*$` | `E_INVALID_PHASE_SLUG` |

### 7.2 Phase History Validation

| Rule | Check | Error Code |
|------|-------|------------|
| Phase exists | `history.phase in phases.keys()` | `E_INVALID_HISTORY_PHASE` |
| Valid transition | `transitionType in [started,completed,rollback]` | `E_INVALID_TRANSITION_TYPE` |
| No future timestamps | `timestamp <= now` | `E_FUTURE_TIMESTAMP` |
| Rollback has fromPhase | `rollback → fromPhase required` | `E_MISSING_FROM_PHASE` |

### 7.3 Validation Command

```bash
# Check phase integrity
ct validate

# Output includes:
# [OK] Single active phase: core
# [OK] Phase status values valid
# [OK] currentPhase references existing phase
# [OK] No future timestamps in phases
# [OK] Phase history entries: 5
```

---

## 8. Logging Specification

### 8.1 Phase-Related Log Actions

| Action | Trigger | Details Captured |
|--------|---------|-----------------|
| `phase_changed` | `phase set` (forward) | fromPhase, toPhase |
| `phase_started` | `phase start` | phase, timestamp |
| `phase_completed` | `phase complete` | phase, duration, startedAt |
| `phase_rollback` | `phase set --rollback` | fromPhase, toPhase, reason |
| `phase_deleted` | `phase delete` | phase, reassignedTo, taskCount |

### 8.2 Log Entry Format

```json
{
  "timestamp": "2025-12-17T10:30:00Z",
  "action": "phase_rollback",
  "actor": "human",
  "before": { "currentPhase": "core" },
  "after": { "currentPhase": "setup" },
  "details": {
    "transitionType": "rollback",
    "fromPhase": "core",
    "toPhase": "setup",
    "reason": "Manual rollback via phase set --rollback"
  }
}
```

---

## 9. Error Codes

| Code | Description | Resolution |
|------|-------------|------------|
| `E_PHASE_NOT_FOUND` | Phase slug doesn't exist | Check phase name with `phase list` |
| `E_PHASE_NOT_SET` | No current phase set | Use `phase set <slug>` or `phase start <slug>` |
| `E_PHASE_NOT_ACTIVE` | Cannot complete non-active phase | Start phase first |
| `E_PHASE_INCOMPLETE_TASKS` | Tasks remain incomplete | Complete tasks or use `--force` |
| `E_PHASE_ROLLBACK_FORBIDDEN` | Rollback without flag | Add `--rollback` flag |
| `E_PHASE_IS_CURRENT` | Cannot delete current phase | Change phase first |
| `E_PHASE_HAS_TASKS` | Tasks assigned to phase | Use `--reassign-to` |
| `E_PHASE_ALREADY_EXISTS` | Rename target exists | Choose different name |
| `E_MULTIPLE_ACTIVE_PHASES` | Data integrity violation | Run `validate --fix` |
| `E_FORCE_REQUIRED` | Destructive operation | Add `--force` flag |

---

## 10. Configuration Options

### 10.1 Phase Validation Config

**Location**: `config.json → validation.phaseValidation`

```json
{
  "validation": {
    "phaseValidation": {
      "enforcePhaseOrder": false,
      "phaseAdvanceThreshold": 90,
      "blockOnCriticalTasks": true,
      "warnPhaseContext": false
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enforcePhaseOrder` | boolean | `false` | Warn on cross-phase work |
| `phaseAdvanceThreshold` | integer | `90` | % completion required to advance |
| `blockOnCriticalTasks` | boolean | `true` | Critical tasks always block advance |
| `warnPhaseContext` | boolean | `false` | Warn when task phase != project phase |

### 10.2 Default Phase Config

**Location**: `config.json → defaults.phase`

```json
{
  "defaults": {
    "phase": "core"
  }
}
```

---

## 11. Concurrency & Safety

### 11.1 Locking

- All phase operations use file locking (`flock`)
- Lock scope: `.cleo/todo.json`
- Lock timeout: 5 seconds

### 11.2 Atomic Operations

Phase-modifying commands follow this pattern:
1. Acquire file lock
2. Read current state
3. Validate operation
4. Create backup
5. Generate new state to temp file
6. Validate temp file
7. Atomic rename (temp → actual)
8. Release lock

### 11.3 Checksum Verification

- Task checksum verified before write
- Phase operations don't invalidate task checksum
- Project-level changes tracked in `_meta`

---

## 12. Migration

### 12.1 Schema v2.1 → v2.2 Migration

**Changes**:
- `project` string → `project` object with `name`, `phases`, `currentPhase`, `phaseHistory`
- Added `phaseHistory` array

**Automatic Migration**:
```bash
ct migrate run
# Migrating schema: v2.1.0 → v2.2.0
# - Converting project field to object
# - Adding phases structure
# - Initializing phaseHistory array
# Migration complete
```

### 12.2 Backward Compatibility

- Old tasks without `phase` field continue to work
- `project.currentPhase: null` is valid
- Empty `phaseHistory: []` is valid

---

## 13. Library Functions

### 13.1 Phase Tracking Library

**Location**: `lib/phase-tracking.sh`

| Function | Description |
|----------|-------------|
| `get_current_phase <file>` | Get project.currentPhase |
| `get_all_phases <file>` | Get all phase definitions |
| `get_phase <slug> <file>` | Get specific phase |
| `get_phase_status <slug> <file>` | Get phase status |
| `count_phases_by_status <status> <file>` | Count by status |
| `set_current_phase <slug> <file>` | Update currentPhase |
| `start_phase <slug> <file>` | pending → active |
| `complete_phase <slug> <file>` | active → completed |
| `advance_phase <file>` | Complete current, start next |
| `validate_single_active_phase <file>` | Check constraint |
| `get_phase_history <file>` | Get history array |
| `add_phase_history_entry <...>` | Append to history |
| `count_tasks_in_phase <slug> <file>` | Count tasks |

### 13.2 Logging Library

**Location**: `lib/logging.sh`

| Function | Description |
|----------|-------------|
| `log_phase_changed <from> <to>` | Log phase change |
| `log_phase_started <slug>` | Log phase start |
| `log_phase_completed <slug> <startedAt>` | Log completion |
| `log_phase_rollback <from> <to> <reason>` | Log rollback |
| `log_phase_deleted <slug> <reassign> <count>` | Log deletion |

---

## 14. Test Coverage

### 14.1 Required Test Scenarios

| Scenario | Test File | Description |
|----------|-----------|-------------|
| No phase set | `phase-commands.bats` | Commands work without phase |
| Phase mismatch | `phase-sync.bats` | Cross-phase work allowed |
| Phaseless tasks | `phase-sync.bats` | Tasks without phase visible |
| Advance incomplete | `phase-commands.bats` | Warning and threshold check |
| Multi-active detection | `phase-edge-cases.bats` | Validation catches error |
| Rollback | `phase-commands.bats` | Flag required, history logged |
| Rename atomic | `phase-commands.bats` | All refs updated |
| Delete protected | `phase-commands.bats` | Force + reassign required |
| Sync preservation | `todowrite-sync.bats` | Phase state preserved |
| Archive stats | `archive.bats` | phaseSummary populated |

### 14.2 Test Count

- **Phase Commands**: 54 tests
- **Phase Sync**: 26 tests
- **Phase Edge Cases**: 16 tests
- **Phase Workflow E2E**: 7 tests
- **Phase Tracking Library**: 66 tests
- **Total**: 169+ phase-related tests

---

## 15. Revision History

| Version | Date | Changes |
|---------|------|---------|
| v2.2.0 | 2025-12-15 | Initial phase system implementation |
| v2.2.1 | 2025-12-17 | Added phaseHistory, rollback logging, archive stats |
| v2.2.2 | 2025-12-30 | Added Appendix C (wave computation cross-reference), updated Related Specifications with TASK-HIERARCHY-SPEC Parts 5-6 and CHAIN-VISUALIZATION-SPEC |

---

## Appendix A: Quick Reference

### Phase Commands Cheatsheet

```bash
# View current phase
ct phase show

# Start a phase (pending → active)
ct phase start core

# Complete current phase
ct phase complete core

# Advance to next phase
ct phase advance
ct phase advance --force

# Rollback to earlier phase
ct phase set setup --rollback
ct phase set setup --rollback --force

# Rename a phase
ct phase rename core development

# Delete a phase
ct phase delete old-phase --reassign-to setup --force

# List all phases
ct phase list
ct phases  # Alternative command
```

### Status Transitions

```
pending ─── phase start ───► active ─── phase complete ───► completed
                                │
                                │ phase set --rollback
                                ▼
                            (any phase)
```

---

## Appendix B: JSON Schema Reference

The complete JSON Schema for phase-related fields is defined in `schemas/todo.schema.json` version 2.2.0.

Key definitions:
- `#/properties/project/properties/phases`
- `#/properties/project/properties/currentPhase`
- `#/properties/project/properties/phaseHistory`
- `#/definitions/phaseDefinition`

---

## Related Specifications

| Document | Relationship |
|----------|--------------|
| [SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md) | **AUTHORITATIVE** for specification standards |
| [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) | Related: LLM-first command design principles |
| [TASK-HIERARCHY-SPEC.md](TASK-HIERARCHY-SPEC.md) | Related: Wave computation algorithm (Part 6); task hierarchy complements phase lifecycle |
| [CHAIN-VISUALIZATION-SPEC.md](CHAIN-VISUALIZATION-SPEC.md) | Related: Chain visualization across phases (computed at render time) |
| [CONFIG-SYSTEM-SPEC.md](CONFIG-SYSTEM-SPEC.md) | Related: Configuration system authority |
| [RCSD-PIPELINE-SPEC.md](RCSD-PIPELINE-SPEC.md) | Related: Defines phase context for RCSD pipeline stages (Research→setup, Decompose→core) |
| PHASE-SYSTEM-IMPLEMENTATION-REPORT.md | Tracks implementation status (pending creation) |

---

## Appendix C: Wave Computation Cross-Reference

### C.1 Phases vs Waves

| Concept | Storage | Purpose |
|---------|---------|---------|
| **Phase** | `task.phase` (stored) | Workflow lifecycle stage (setup → core → testing → polish) |
| **Wave** | COMPUTED | Execution order within scope based on dependency depth |

Phases represent **WHEN** in the project lifecycle. Waves represent **WHAT ORDER** to execute tasks based on dependencies.

### C.2 Wave Computation Algorithm

> **See**: [TASK-HIERARCHY-SPEC.md Part 6](TASK-HIERARCHY-SPEC.md) for the complete wave computation specification.

**Summary**:
```
wave(task) =
  if task.status == "done" then -1 (excluded)
  else if task.depends is empty then 0
  else max(task.depends.filter(in_scope).map(d => wave(d))) + 1
```

- **Wave 0**: Tasks with no in-scope, non-done dependencies (can start immediately)
- **Wave N**: Tasks whose deepest dependency is at Wave N-1
- **Scope filtering**: Only dependencies within the analysis scope are considered

### C.3 Cross-Phase Dependencies

Tasks MAY depend on tasks in different phases. The wave computation handles cross-phase dependencies by:

1. Including all scoped dependencies regardless of phase
2. Computing wave depth across the entire dependency graph
3. Allowing parallel execution within the same wave, even across phases

**Example**: A `testing` phase task depending on a `core` phase task will have wave = core_task_wave + 1.

---

**End of Specification**
