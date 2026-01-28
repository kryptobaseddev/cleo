# TodoWrite Sync Integration Specification

**Version**: 1.0.0
**Status**: ACTIVE
**Effective**: v0.14.0+
**Last Updated**: 2025-12-18

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [BCP 14](https://www.rfc-editor.org/info/bcp14) [[RFC2119](https://www.rfc-editor.org/rfc/rfc2119)] [[RFC8174](https://www.rfc-editor.org/rfc/rfc8174)] when, and only when, they appear in all capitals.

---

## Preamble

This specification defines the bidirectional synchronization system between cleo's persistent task storage and Claude Code's ephemeral TodoWrite tool. The design accepts **intentionally lossy transformation** since full metadata lives in cleo (the durable system of record).

> **AUTHORITATIVE SOURCE**: This document defines the TodoWrite sync integration system.
> For task ID handling, defer to [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md).
> For phase system behavior, defer to [PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md).

---

## Executive Summary

### Mission

Enable seamless task management across Claude Code sessions by providing bidirectional synchronization between:
- **cleo**: Durable, feature-rich task persistence (10+ fields per task)
- **TodoWrite**: Ephemeral session tracking (3 fields: content, status, activeForm)

### Core Principles

1. **Lossy by Design**: Only ID and status are round-trippable; full metadata preserved in cleo
2. **Session-Scoped**: Sync operations bounded by session lifecycle (start → work → end)
3. **ID Preservation**: Task IDs embedded in content via `[T###]` prefix for round-trip tracking
4. **Conflict Resolution**: cleo authoritative for existence; TodoWrite authoritative for session progress
5. **Phase-Aware**: Respects project phase context for task selection and inheritance

### Key Decisions

| Decision | Rationale |
|----------|-----------|
| Content prefix for ID | No schema coupling; works with any TodoWrite version |
| Tiered selection | Focused work > dependencies > priority (max 8 tasks) |
| Session state file | Enables diff detection and recovery |
| Warn-don't-fail conflicts | Robustness over strict consistency |

---

## Part 1: Schema Mapping

### 1.1 Field Mapping

The synchronization system maps between two fundamentally different schemas:

| cleo Field | TodoWrite Field | Sync Direction | Notes |
|-------------------|-----------------|----------------|-------|
| `id` | `content` prefix `[T###]` | Bidirectional | Embedded in content string |
| `title` | `content` (after prefix) | Inject only | Stripped on extract |
| `status` | `status` | Bidirectional | With mapping table |
| `priority` | `content` marker `[!]` | Inject only | High/critical → `[!]` |
| `phase` | `content` marker `[phase]` | Inject only | Optional |
| `blockedBy`/blocked | `content` marker `[BLOCKED]` | Inject only | Status indicator |
| - | `activeForm` | Inject only | Generated from title |
| `description` | - | Not synced | Lives in cleo only |
| `labels` | - | Not synced | Lives in cleo only |
| `depends` | - | Not synced | Lives in cleo only |
| `notes` | - | Not synced | Lives in cleo only |
| timestamps | - | Not synced | Lives in cleo only |

### 1.2 Status Mapping

The system MUST map statuses bidirectionally:

| cleo → TodoWrite | TodoWrite → cleo |
|-------------------------|-------------------------|
| `pending` → `pending` | `pending` → `pending` |
| `active` → `in_progress` | `in_progress` → `active` |
| `blocked` → `pending` + `[BLOCKED]` | `completed` → `done` |
| `done` → (excluded from injection) | |

### 1.3 Content Prefix Format

Injected task content MUST follow this format:

```
[T###] [markers...] <title>
```

**Required Elements:**
- `[T###]` - Task ID prefix (REQUIRED for round-trip)

**Optional Markers (in order):**
- `[!]` - High or critical priority
- `[BLOCKED]` or `[BLOCKED:T###→T###]` - Blocked status with optional chain
- `[phase-slug]` - Task's phase

**Examples:**
```
[T001] [!] [core] Implement authentication
[T002] [BLOCKED:T001] Write auth tests
[T003] [!] [BLOCKED:T002→T001] [core] Deploy auth module
```

---

## Part 2: Session Workflow

### 2.1 Session Lifecycle

The sync system operates within session boundaries:

```
┌─────────────────────────────────────────────────────────────────┐
│                      SESSION START                               │
├─────────────────────────────────────────────────────────────────┤
│  1. cleo session start        # Start durable session    │
│  2. cleo sync --inject        # Export tasks → TodoWrite │
│  3. TodoWrite tool receives JSON                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      DURING SESSION                              │
├─────────────────────────────────────────────────────────────────┤
│  • LLM uses TodoWrite for live progress updates                 │
│  • Mark tasks in_progress when starting work                    │
│  • Mark tasks completed when done                               │
│  • Add new tasks discovered during work                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SESSION END                                 │
├─────────────────────────────────────────────────────────────────┤
│  1. Export TodoWrite state to file                              │
│  2. cleo sync --extract <file>  # Merge → cleo    │
│  3. cleo session end            # End durable session    │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Session State File

The system MUST create a session state file at `.cleo/sync/todowrite-session.json`:

```json
{
  "session_id": "session_20251215_143022_a1b2c3",
  "injected_at": "2025-12-15T14:30:22Z",
  "injected_tasks": ["T001", "T002", "T003"],
  "task_metadata": {
    "T001": {"phase": "core", "priority": "high", "status": "pending"},
    "T002": {"phase": "core", "priority": "medium", "status": "blocked"}
  },
  "snapshot": { ... }
}
```

**Required Fields:**
- `session_id` - Unique identifier for session correlation
- `injected_at` - ISO 8601 timestamp of injection
- `injected_tasks` - Array of task IDs that were injected
- `task_metadata` - Per-task context for extraction phase
- `snapshot` - Copy of injected TodoWrite JSON

---

## Part 3: Injection Requirements

### 3.1 Task Selection Strategy

The injection system MUST use tiered selection with maximum task limit:

**Tier 1** (Always Included):
- Current focused task (from `.focus.currentTask`)

**Tier 2** (Include if capacity):
- Direct dependencies of focused task (tasks in focused task's `depends` array)

**Tier 3** (Fill remaining capacity):
- High/critical priority tasks in same phase as focused task
- Ordered by priority (critical > high > medium > low)

**Constraints:**
- Maximum tasks: 8 (default, configurable via `--max-tasks`)
- Completed tasks (`status: done`) MUST be excluded

### 3.2 Phase Filtering

The system MUST support phase-based filtering with this priority order:

1. `--phase <slug>` - Explicit phase override (highest priority)
2. `project.currentPhase` - Project-level phase setting
3. Focused task's phase - Inferred from `.focus.currentTask`
4. No filter (default) - All phases included

### 3.3 ActiveForm Generation

The system MUST generate `activeForm` from task titles:

**Requirements:**
- Transform imperative titles to present continuous form
- Use verb lookup table for common verbs (150+ mappings)
- Apply grammar rules for unlisted verbs:
  - Verbs ending in 'e' → drop 'e', add 'ing'
  - Verbs ending in 'ie' → replace with 'ying'
  - CVC pattern → double final consonant, add 'ing'
  - Default → add 'ing'
- Fallback: "Working on: <title>" for non-verb titles

**Examples:**
| Title | ActiveForm |
|-------|------------|
| Implement auth | Implementing auth |
| Fix login bug | Fixing login bug |
| Create tests | Creating tests |
| Core feature A | Working on: Core feature A |

### 3.4 Dependency Ordering

The system SHOULD order tasks so dependencies appear before dependents:

**Algorithm**: Topological sort (Kahn's algorithm)

1. Build adjacency list from task `depends` fields
2. Calculate in-degree for each task
3. Process tasks with in-degree 0 first
4. On cycle detection: warn and return partial order

### 3.5 Blocker Chain Display

For blocked tasks, the system SHOULD display the full blocker chain:

**Format**: `[BLOCKED:T003→T002→T001]`

**Requirements:**
- Maximum chain depth: 5 levels
- Truncate longer chains with `...` indicator
- Handle cycles gracefully (partial chain)

---

## Part 4: Extraction Requirements

### 4.1 Change Detection

The extraction system MUST detect these change categories:

| Category | Detection | Action |
|----------|-----------|--------|
| `completed` | `status: completed` in TodoWrite | Mark task done in cleo |
| `progressed` | `status: in_progress` (was pending) | Update to active in cleo |
| `new_tasks` | No `[T###]` prefix in content | Create new task (see 4.2) |
| `removed` | Injected ID missing from TodoWrite | Log only (no deletion) |

### 4.2 New Task Handling

For tasks discovered during session (no `[T###]` prefix):

**Current Behavior** (v1.0):
- Auto-create with `--labels "session-created"`
- Inherit phase from session context

**Phase Inheritance Priority**:
1. `--default-phase` flag (explicit override)
2. Focused task's phase from session metadata
3. Most active phase (phase with most non-done tasks)
4. `project.currentPhase` from schema
5. `config.defaults.phase` (final fallback)

**Future Behavior** (v2.0):
- Collect pending tasks without creating
- Output in `pending_tasks` array
- Require user confirmation via AskUserQuestion

### 4.3 Conflict Resolution

The system MUST follow these conflict resolution rules:

| Conflict | Resolution |
|----------|------------|
| Task exists in cleo but not TodoWrite | Log as "removed", no action |
| Task in TodoWrite not in cleo | Warn "task not found", skip |
| Task already done in cleo | Log "already done", skip |
| Status conflict | TodoWrite wins (session progress) |

**Principle**: Warn but don't fail on conflicts.

### 4.4 Idempotency

The extraction system MUST be idempotent:
- Running extraction twice with same input produces same result
- Already-completed tasks remain completed
- Already-created new tasks are not duplicated

---

## Part 5: Command Interface

### 5.1 Sync Command Structure

```bash
cleo sync --inject [OPTIONS]    # Session start
cleo sync --extract [FILE]      # Session end
cleo sync --status              # Show sync state
cleo sync --clear               # Clear state without merge
```

### 5.2 Inject Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--max-tasks` | integer | 8 | Maximum tasks to inject |
| `--focused-only` | flag | false | Only inject focused task |
| `--phase` | string | - | Filter to specific phase |
| `--output` | path | stdout | Write JSON to file |
| `--no-save-state` | flag | false | Skip session state creation |
| `--quiet`, `-q` | flag | false | Suppress info messages |
| `--dry-run` | flag | false | Preview without saving state |

### 5.3 Extract Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--dry-run` | flag | false | Preview changes without applying |
| `--default-phase` | string | - | Override phase for new tasks |
| `--quiet`, `-q` | flag | false | Suppress info messages |

### 5.4 Exit Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | EXIT_SUCCESS | Operation completed successfully |
| 1 | EXIT_INVALID_ARGS | Invalid arguments or missing file |
| 2 | EXIT_JSON_ERROR | JSON parse error |
| 3 | EXIT_NO_TASKS | No tasks to inject |

---

## Part 6: Output Formats

### 6.1 Injection Output (TodoWrite JSON)

```json
{
  "todos": [
    {
      "content": "[T001] [!] [core] Implement authentication",
      "status": "in_progress",
      "activeForm": "Implementing authentication"
    },
    {
      "content": "[T002] [BLOCKED:T001] Write auth tests",
      "status": "pending",
      "activeForm": "Writing auth tests"
    }
  ]
}
```

### 6.2 Extraction Output (JSON Format)

```json
{
  "$schema": "https://cleo.dev/schemas/v1/sync-extract-output.json",
  "_meta": {
    "command": "sync --extract",
    "version": "0.19.2",
    "timestamp": "2025-12-18T10:30:00Z"
  },
  "changes": {
    "completed": ["T001", "T002"],
    "progressed": ["T003"],
    "new_tasks": [{"id": "T010", "title": "New task"}],
    "removed": []
  },
  "phase_impact": {
    "completions_by_phase": {"core": 2, "setup": 0},
    "completed_phases": [],
    "suggested_phase": "core"
  },
  "summary": {
    "total_changes": 3,
    "success": true
  }
}
```

### 6.3 Status Output

```json
{
  "$schema": "https://cleo.dev/schemas/v1/sync-status-output.json",
  "_meta": { ... },
  "session": {
    "active": true,
    "session_id": "session_20251215_143022_a1b2c3",
    "injected_at": "2025-12-15T14:30:22Z",
    "task_count": 5,
    "tasks": ["T001", "T002", "T003", "T004", "T005"],
    "phase_distribution": {"core": 3, "setup": 2}
  },
  "success": true
}
```

---

## Part 7: Error Handling

### 7.1 Error Categories

| Category | Behavior | Recovery |
|----------|----------|----------|
| Invalid JSON input | Fail with exit code 2 | User fixes input file |
| Missing session state | Warn, continue without diff | Manual review of changes |
| Task not found | Warn, skip task | No action needed |
| File permission error | Fail with exit code 1 | User fixes permissions |
| Cycle in dependencies | Warn, partial order | Accept partial ordering |

### 7.2 Recovery Mechanisms

**Stale Session Recovery:**
```bash
cleo sync --status    # Check if stale state exists
cleo sync --clear     # Remove without merging
```

**Corrupt State Recovery:**
```bash
rm .cleo/sync/todowrite-session.json  # Manual removal
cleo validate --fix               # Validate project files
```

---

## Part 8: Future Enhancements

This section documents planned enhancements NOT YET REQUIRED for compliance:

### 8.1 New Task Confirmation Workflow

**Requirement**: New tasks discovered during session SHOULD require user confirmation rather than auto-creation.

**Design**:
- Collect pending tasks in `pending_tasks` array
- Output confirmation prompt format for AskUserQuestion
- Support CONFIRM/REJECT/MODIFY actions

### 8.2 Phase Completion Detection

**Requirement**: The system SHOULD detect when all tasks in a phase are complete.

**Design**:
- Check phase completion after applying changes
- Report "Phase 'X' is now complete" in summary
- Optionally log to audit trail

### 8.3 Auto-Advance Mechanism

**Requirement**: The system MAY support automatic phase advancement.

**Design**:
- Opt-in via `--auto-advance` flag or config
- Advance to next phase in order when current completes
- Log phase transition to audit trail

---

## Appendix A: Decision Rationale

| Decision | Alternatives Considered | Why Chosen |
|----------|------------------------|------------|
| Content prefix for ID | Custom TodoWrite schema, separate mapping file | No TodoWrite schema coupling; survives tool changes |
| Maximum 8 tasks | Unlimited, user-configured | Cognitive load limit; TodoWrite UI constraints |
| Session state file | In-memory only, database | Simple file I/O; crash recovery; no dependencies |
| Warn-don't-fail | Strict failure, ignore conflicts | Robustness for real-world usage; visibility of issues |
| Auto-create new tasks (v1) | Always require confirmation | Lower friction for v1; confirmation planned for v2 |

## Appendix B: Industry Precedents

| System | Pattern | Our Adoption |
|--------|---------|--------------|
| Jira ↔ Slack sync | ID embedding in messages | `[T###]` prefix pattern |
| Linear webhooks | Lossy sync with source of truth | cleo as authoritative |
| GitHub Issues ↔ Projects | Status mapping tables | Bidirectional status mapping |
| Notion databases | Schema-coupled sync | Avoided (fragile) |

## Appendix C: Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-12-18 | Initial ACTIVE release, consolidated from research docs |

---

## Related Specifications

| Document | Relationship |
|----------|--------------|
| [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) | AUTHORITATIVE for task ID format |
| [PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md) | AUTHORITATIVE for phase lifecycle |
| [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) | Output format requirements |
| [TODOWRITE-SYNC-IMPLEMENTATION-REPORT.md](TODOWRITE-SYNC-IMPLEMENTATION-REPORT.md) | Tracks implementation status |

---

*End of Specification*
