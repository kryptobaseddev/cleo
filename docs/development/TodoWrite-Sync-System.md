TodoWrite Sync System - Complete Investigation Report

  Confirmed Architecture Overview

  The sync system provides bidirectional synchronization between:
  - cleo: Durable, feature-rich task persistence (10+ fields per task)
  - TodoWrite: Claude Code's ephemeral session tracking (3 fields: content, status, activeForm)

  Core Design Principle: Lossy by design - only ID and status are round-trippable; full metadata preserved in cleo.

  ---
  1. Complete File Map (Confirmed)

  | File                              | Purpose                                 | Lines |
  |-----------------------------------|-----------------------------------------|-------|
  | scripts/sync-todowrite.sh         | Main orchestrator & subcommand router   | 337   |
  | scripts/inject-todowrite.sh       | Session start: cleo → TodoWrite  | 565   |
  | scripts/extract-todowrite.sh      | Session end: TodoWrite → cleo    | 654   |
  | lib/todowrite-integration.sh      | Grammar transformation & status mapping | 554   |
  | docs/specs/TODOWRITE-SYNC-SPEC.md | Authoritative specification             | 512   |

  ---
  2. Confirmed Session Workflow

  ┌─────────────────────────────────────────────────────────────────┐
  │                      SESSION START                               │
  ├─────────────────────────────────────────────────────────────────┤
  │  1. cleo session start        # Start durable session    │
  │  2. cleo sync --inject        # Export tasks → TodoWrite │
  │     → Creates .cleo/sync/todowrite-session.json              │
  │     → Outputs TodoWrite JSON with [T###] prefixes              │
  │  3. Claude Code receives JSON for TodoWrite tool               │
  └─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                      DURING SESSION                              │
  ├─────────────────────────────────────────────────────────────────┤
  │  • LLM uses TodoWrite for live progress updates                 │
  │  • Mark tasks in_progress when starting work                    │
  │  • Mark tasks completed when done                               │
  │  • Add new tasks discovered during work (no [T###] prefix)     │
  └─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                      SESSION END                                 │
  ├─────────────────────────────────────────────────────────────────┤
  │  1. Export TodoWrite state to file                              │
  │  2. cleo sync --extract <file>  # Merge → cleo    │
  │     → Parses [T###] prefixes to recover IDs                    │
  │     → Detects completed/progressed/new/removed tasks           │
  │     → Applies changes via complete-task.sh, update-task.sh     │
  │     → Deletes session state file                               │
  │  3. cleo session end            # End durable session    │
  └─────────────────────────────────────────────────────────────────┘

  ---
  3. Injection Flow (Confirmed)

  3.1 Task Selection Strategy (Tiered)

  Location: inject-todowrite.sh:273-294

  sort_by(
      if .id == $focus_id then 0                           # Tier 1: focused task
      elif (.depends // []) | any(. == $focus_id) then 1   # Tier 2: depends on focused
      elif .priority == "critical" then 2                   # Tier 3a: critical priority
      elif .priority == "high" then 3                       # Tier 3b: high priority
      elif .phase == $focus_phase then 4                    # Tier 3c: same phase
      else 5                                                # Tier 3d: everything else
      end
  )

  - Maximum tasks: 8 (configurable via --max-tasks)
  - Completed tasks excluded: status != "done" filter
  - Phase filtering: --phase flag > project.currentPhase > no filter

  3.2 Content Prefix Format (Confirmed)

  Location: inject-todowrite.sh:215-241

  Format: [T###] [markers...] <title>

  | Prefix    | Condition                        | Example          |
  |-----------|----------------------------------|------------------|
  | [T###]    | Always (required for round-trip) | [T001]           |
  | [!]       | priority == "high" OR "critical" | [T001] [!]       |
  | [BLOCKED] | status == "blocked"              | [T001] [BLOCKED] |
  | [phase]   | If task has phase                | [T001] [core]    |

  Full example: [T001] [!] [BLOCKED] [core] Implement authentication

  3.3 ActiveForm Generation (Confirmed)

  Location: lib/todowrite-integration.sh:208-309

  Algorithm (4 stages):
  1. Prefix detection: Labels like BUG:, T123: → "Working on: "
  2. Already -ing check: Words ending in -ing → use as-is
  3. Lookup table: 147 hand-verified verbs (e.g., implement → Implementing)
  4. Grammar rules:
    - ie → ying (tie → tying)
    - drop e, add ing (create → creating)
    - double consonant for CVC (run → running)
  5. Fallback: "Working on: " for non-verbs

  3.4 Status Mapping: cleo → TodoWrite (Confirmed)

  Location: lib/todowrite-integration.sh:177-182

  | cleo | TodoWrite   | Notes                         |
  |-------------|-------------|-------------------------------|
  | pending     | pending     | Direct                        |
  | active      | in_progress | Renamed                       |
  | blocked     | pending     | Downgraded + [BLOCKED] marker |
  | done        | (excluded)  | Not injected                  |

  3.5 Session State File (Confirmed)

  Location: .cleo/sync/todowrite-session.json

  {
    "session_id": "session_20251215_143022_a1b2c3",
    "injected_at": "2025-12-15T14:30:22Z",
    "injectedPhase": "core",
    "injected_tasks": ["T001", "T002", "T003"],
    "task_metadata": {
      "T001": {"phase": "core", "priority": "high", "status": "pending"},
      "T002": {"phase": "core", "priority": "medium", "status": "blocked"}
    },
    "snapshot": { "todos": [...] }
  }

  Purpose:
  - injected_tasks: Enables diff detection (what was sent vs what came back)
  - task_metadata: Phase inheritance for new tasks
  - injectedPhase: Detects phase changes during session

  ---
  4. Extraction Flow (Confirmed)

  4.1 Task ID Parsing (Confirmed)

  Location: extract-todowrite.sh:198-205

  # Regex: ^\[T([0-9]+)\]
  if [[ "$content" =~ ^\[T([0-9]+)\] ]]; then
      echo "T${BASH_REMATCH[1]}"
  fi

  4.2 Change Detection Categories (Confirmed)

  Location: extract-todowrite.sh:222-281

  | Category   | Detection                                     | Action                                         |
  |------------|-----------------------------------------------|------------------------------------------------|
  | completed  | status == "completed" in TodoWrite            | complete-task.sh <id> --skip-archive           |
  | progressed | status == "in_progress" (was pending/blocked) | update-task.sh <id> --status active            |
  | new_tasks  | No [T###] prefix in content                   | add-task.sh <title> --labels "session-created" |
  | removed    | Injected ID missing from TodoWrite            | Log only (no deletion)                         |

  4.3 Phase Inheritance for New Tasks (Confirmed)

  Location: extract-todowrite.sh:296-338

  Priority order:
  1. --default-phase flag (explicit override)
  2. Focused task's phase from task_metadata
  3. Most active phase (phase with most non-done tasks)
  4. project.currentPhase (via add-task.sh)
  5. config.defaults.phase (via add-task.sh)

  4.4 Conflict Resolution (Confirmed)

  | Conflict                                     | Resolution                            |
  |----------------------------------------------|---------------------------------------|
  | Task exists in cleo but not TodoWrite | Log as "removed", no action           |
  | Task in TodoWrite not in cleo         | Warn "task not found", skip           |
  | Task already done in cleo             | Log "already done" (idempotent), skip |
  | Status conflict                              | TodoWrite wins (session progress)     |

  Principle: Warn but don't fail on conflicts.

  4.5 Status Mapping: TodoWrite → cleo (Confirmed)

  Location: lib/todowrite-integration.sh:185-189

  | TodoWrite   | cleo | Notes                |
  |-------------|-------------|----------------------|
  | pending     | pending     | Direct               |
  | in_progress | active      | Renamed              |
  | completed   | done        | Via complete-task.sh |

  Note: blocked status cannot be restored - it's a one-way downgrade.

  ---
  5. CLI Command Structure (Confirmed)

  5.1 Subcommand Routing

  Location: sync-todowrite.sh:307-333

  case "$1" in
      --inject|-i)   handle_inject "$@"   ;;  # → inject-todowrite.sh
      --extract|-e)  handle_extract "$@"  ;;  # → extract-todowrite.sh
      --status|-s)   handle_status        ;;  # Inline handler
      --clear|-c)    handle_clear         ;;  # Inline handler
  esac

  5.2 Exit Codes (Confirmed)

  | Code | Meaning                           |
  |------|-----------------------------------|
  | 0    | Success                           |
  | 1    | Invalid arguments or missing file |
  | 2    | JSON parse error                  |
  | 3    | No tasks to inject                |

  5.3 Output Format Resolution

  Priority: CLI arg (--json) > CLEO_FORMAT env > config file > JSON default

  ---
  6. Export vs Sync (Confirmed Difference)

  | Aspect        | export --format todowrite | sync --inject          |
  |---------------|---------------------------|------------------------|
  | Purpose       | One-way export            | Bidirectional sync     |
  | Task IDs      | No ID embedding           | Embeds [T###] prefix   |
  | Session State | None                      | Saves to .cleo/sync/ |
  | Round-trip    | No                        | Yes                    |
  | Use Case      | Reports, external tools   | Claude Code sessions   |

  ---
  7. What's NOT Implemented (Confirmed Gaps)

  Per TODOWRITE-SYNC-IMPLEMENTATION-REPORT.md:

  | Feature                               | Status       | Spec Section |
  |---------------------------------------|--------------|--------------|
  | Full topological sort                 | PENDING      | 3.4          |
  | Blocker chain display [BLOCKED:T→T→T] | PENDING      | 3.5          |
  | New task confirmation workflow        | PLANNED (v2) | 8.1          |
  | Phase completion detection            | PLANNED (v2) | 8.2          |
  | Auto-advance mechanism                | PLANNED (v2) | 8.3          |

  ---
  8. Test Coverage (Confirmed)

  Location: tests/integration/todowrite-sync.bats

  - 23 tests covering:
    - Injection (8 tests): ID prefixes, priority markers, status mapping, activeForm
    - Extraction (6 tests): ID parsing, completion, new tasks, phase inheritance
    - Conflict resolution (2 tests): Idempotency, authoritative sources
    - Workflow (2 tests): Full inject→extract cycle
    - Status mapping (5 tests): All bidirectional mappings

  ---
  9. Key Design Decisions (Confirmed Rationale)

  | Decision                     | Rationale                                              |
  |------------------------------|--------------------------------------------------------|
  | Content prefix for ID [T###] | No schema coupling; survives TodoWrite version changes |
  | Maximum 8 tasks              | Cognitive load limit; TodoWrite UI constraints         |
  | Session state file           | Simple file I/O; crash recovery; no dependencies       |
  | Warn-don't-fail conflicts    | Robustness for real-world usage                        |
  | blocked → pending downgrade  | TodoWrite has no blocked status; marker preserves info |
  | Auto-create new tasks (v1)   | Lower friction; confirmation planned for v2            |

  ---
  10. Complete Data Flow Diagram

  ┌──────────────────────────────────────────────────────────────────────────┐
  │                         INJECTION FLOW                                    │
  ├──────────────────────────────────────────────────────────────────────────┤
  │                                                                          │
  │  .cleo/todo.json                                                       │
  │  ┌─────────────────────────────────────────┐                            │
  │  │ tasks: [                                │                            │
  │  │   {id: "T001", title: "Impl auth",      │                            │
  │  │    status: "active", priority: "high",  │                            │
  │  │    phase: "core", depends: [...]}       │                            │
  │  │ ]                                       │                            │
  │  │ focus: {currentTask: "T001"}            │                            │
  │  └─────────────────────────────────────────┘                            │
  │                     │                                                    │
  │                     ▼                                                    │
  │  ┌─────────────────────────────────────────┐                            │
  │  │ inject-todowrite.sh                     │                            │
  │  │ 1. Read focus.currentTask               │                            │
  │  │ 2. Tiered selection (max 8)             │                            │
  │  │ 3. Format: [T###] [!] [phase] title     │                            │
  │  │ 4. Generate activeForm                  │                            │
  │  │ 5. Map status → TodoWrite status        │                            │
  │  │ 6. Save session state                   │                            │
  │  └─────────────────────────────────────────┘                            │
  │                     │                                                    │
  │        ┌────────────┴────────────┐                                      │
  │        ▼                         ▼                                      │
  │  Session State              TodoWrite JSON                               │
  │  (.cleo/sync/)            (stdout)                                    │
  │  ┌──────────────┐           ┌──────────────────────────────┐            │
  │  │session_id    │           │{"todos": [                   │            │
  │  │injected_at   │           │  {"content": "[T001] [!]...  │            │
  │  │injectedPhase │           │   "status": "in_progress",   │            │
  │  │injected_tasks│           │   "activeForm": "Impl..."}   │            │
  │  │task_metadata │           │]}                            │            │
  │  │snapshot      │           └──────────────────────────────┘            │
  │  └──────────────┘                                                       │
  │                                                                          │
  └──────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────────┐
  │                         EXTRACTION FLOW                                   │
  ├──────────────────────────────────────────────────────────────────────────┤
  │                                                                          │
  │  TodoWrite Final State                 Session State                     │
  │  (from Claude session)                 (.cleo/sync/)                   │
  │  ┌──────────────────────────┐          ┌──────────────┐                 │
  │  │{"todos": [               │          │injected_tasks│                 │
  │  │  {"content": "[T001]..." │          │task_metadata │                 │
  │  │   "status": "completed"} │          └──────────────┘                 │
  │  │  {"content": "New task"  │                │                          │
  │  │   "status": "pending"}   │                │                          │
  │  │]}                        │                │                          │
  │  └──────────────────────────┘                │                          │
  │                     │                        │                          │
  │                     └──────────┬─────────────┘                          │
  │                                ▼                                        │
  │  ┌─────────────────────────────────────────┐                            │
  │  │ extract-todowrite.sh                    │                            │
  │  │ 1. Parse [T###] from content            │                            │
  │  │ 2. Compare injected vs found IDs        │                            │
  │  │ 3. Detect: completed, progressed,       │                            │
  │  │    new_tasks, removed                   │                            │
  │  │ 4. Apply via task scripts               │                            │
  │  │ 5. Delete session state                 │                            │
  │  └─────────────────────────────────────────┘                            │
  │                     │                                                    │
  │                     ▼                                                    │
  │  ┌─────────────────────────────────────────┐                            │
  │  │ .cleo/todo.json (updated)             │                            │
  │  │ - T001: status → done                   │                            │
  │  │ - T010: NEW (title: "New task",         │                            │
  │  │         labels: ["session-created"],    │                            │
  │  │         phase: inherited from focus)    │                            │
  │  └─────────────────────────────────────────┘                            │
  │                                                                          │
  └──────────────────────────────────────────────────────────────────────────┘

  ---
  Summary

  100% Confirmed:
  1. ✅ Bidirectional sync via inject/extract subcommands
  2. ✅ Task ID preservation via [T###] content prefix (not schema coupling)
  3. ✅ Tiered task selection prioritizing focused task and dependencies
  4. ✅ Session state file enables round-trip tracking and phase inheritance
  5. ✅ Status mapping with intentional blocked → pending downgrade
  6. ✅ ActiveForm generation via 147-verb lookup + grammar rules + fallback
  7. ✅ Change detection: completed, progressed, new_tasks, removed
  8. ✅ Conflict resolution: cleo authoritative for existence, TodoWrite for progress
  9. ✅ New tasks inherit phase from focused task metadata
  10. ✅ Comprehensive test coverage (23+ integration tests)

