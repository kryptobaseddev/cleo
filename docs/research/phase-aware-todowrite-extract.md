# Phase-Aware TodoWrite Extract Integration

**Research Document** | **Date**: 2025-12-15 | **Author**: Backend Architect Agent

## Executive Summary

This document analyzes integration of project-level phase management with TodoWrite extract operations. Current implementation preserves existing task phases but has no phase-awareness for new tasks, phase completion detection, or auto-advancement. Proposed design adds intelligent phase assignment, completion tracking, and optional workflow progression.

## Current State Analysis

### Existing Phase Infrastructure

**Schema Support** (todo.schema.json):
- Task-level: `.tasks[].phase` (optional string, must match phase slug)
- Project-level: `.phases` object with phase definitions (order, name, description)
- Focus context: `.focus.currentTask` tracks active task
- No concept of "current project phase" or active workflow stage

**Phase Operations**:
- `phases.sh`: List phases, show phase tasks, statistics
- `next.sh`: Phase bonus (+10 score) for tasks matching focused task's phase
- `add-task.sh`: `--phase` flag with optional `--add-phase` for new phase creation
- Phase filtering in `list.sh`: `--phase` filter

### TodoWrite Extract Current Behavior

**File**: `scripts/extract-todowrite.sh`

**New Task Creation** (line 308-323):
```bash
# New tasks get:
--labels "session-created"
--description "Created during TodoWrite session"
# NO --phase assignment
```

**Existing Task Updates**:
- Completed tasks: Mark done, preserve phase
- Progressed tasks: Update to active, preserve phase
- Phase field is read-only during extract

**No Phase Logic**:
- No phase completion detection
- No auto-advance phase when phase tasks complete
- No inherited phase for new tasks
- No phase statistics in extract summary

### TodoWrite Inject Behavior

**File**: `scripts/inject-todowrite.sh`

**Tiered Selection** (line 209-229):
```jq
# Tier 1: Focused task
# Tier 2: Tasks depending on focused
# Tier 3a: Critical priority
# Tier 3b: High priority
# Tier 3c: Same phase as focused task
```

**Phase Usage**:
- Phase used for tier 3c bonus (same phase as focus)
- Focus phase determined from `.tasks[] | select(.id == $focus_id) | .phase`
- No concept of "project current phase"

## Gap Analysis

### 1. No Current Phase Concept

**Problem**: No canonical "current project phase" field in schema.

**Current Workaround**: Infer phase from focused task.

**Limitations**:
- No focused task = no phase context
- Focused task without phase = no context
- Cannot track phase independently of focus

**Impact**: Cannot assign phase to new tasks when:
- No task is focused
- Focused task has no phase
- User wants explicit phase override

### 2. New Tasks Have No Phase

**Problem**: Extract creates tasks with `session-created` label but no phase.

**User Experience Issues**:
- New tasks appear in "no phase" filter
- Requires manual phase assignment post-session
- Breaks phase-based workflow continuity

**Potential Logic**:
- Inherit from focused task's phase?
- Use most recent phase (highest order)?
- Leave null and require manual assignment?

### 3. No Phase Completion Detection

**Problem**: Extract doesn't check if phase is fully complete.

**Missed Opportunities**:
- Could report "Phase 'core' is now 100% complete" in summary
- Could suggest phase advancement
- Could auto-archive phase-specific notes

**Business Value**: Clear milestone visibility for multi-phase projects.

### 4. No Auto-Advance Mechanism

**Problem**: No workflow progression automation.

**Comparison to Similar Tools**:
- Jira/Linear: Manual transition gates
- GitHub Projects: Automation rules (but manual trigger)
- TaskWarrior: No phase concept
- Claude Code TodoWrite: No phases

**Considerations**:
- Auto-advance = risk of premature progression
- Manual-only = friction for obvious transitions
- Opt-in flag = best of both worlds?

### 5. Audit Trail Gaps

**Problem**: Phase changes not logged to audit trail.

**Current Logging**:
- Task completion logged (T227 marked done)
- Status changes logged (T227 pending → active)
- Phase changes NOT logged

**Should Log**:
- "Task T227 phase changed: null → core (inherited from T225)"
- "Phase 'setup' completed (10/10 tasks done)"
- "Phase auto-advanced: setup → core (--auto-advance)"

## Proposed Design

### A. Schema Extensions (Optional)

**Option 1: Add `.project.currentPhase`**

```json
{
  "project": "cleo",
  "projectMetadata": {
    "currentPhase": "core",
    "phaseHistory": [
      {"phase": "setup", "startedAt": "2025-12-01", "completedAt": "2025-12-05"},
      {"phase": "core", "startedAt": "2025-12-05"}
    ]
  }
}
```

Pros:
- Explicit phase tracking independent of focus
- Clear audit trail for phase transitions
- Supports phase-based reporting

Cons:
- Schema change (migration required)
- More complex state management
- Potential conflict with task-level phases

**Option 2: No Schema Change (Inferred Phase)**

Use heuristic to determine "current phase":
1. If focus.currentTask exists → use focused task's phase
2. Else if phases exist → use phase with most active/pending tasks
3. Else → null (no phase context)

Pros:
- No schema migration
- Zero state management overhead
- Backward compatible

Cons:
- Heuristic may be surprising
- No explicit phase control
- Cannot override inferred phase

**RECOMMENDATION**: Option 2 (inferred phase) for v1, Option 1 (explicit) for future enhancement.

### B. New Task Phase Assignment

**Algorithm**:

```bash
get_session_phase() {
  # 1. Try focus task's phase
  focus_phase=$(jq -r '
    (.focus.currentTask // "") as $fid |
    if $fid != "" then
      (.tasks[] | select(.id == $fid) | .phase // "")
    else "" end
  ' "$TODO_FILE")

  if [[ -n "$focus_phase" ]]; then
    echo "$focus_phase"
    return
  fi

  # 2. Try most active phase (most non-done tasks)
  active_phase=$(jq -r '
    [.tasks[] | select(.status != "done") | .phase // empty] |
    group_by(.) | max_by(length) | .[0] // ""
  ' "$TODO_FILE")

  if [[ -n "$active_phase" ]]; then
    echo "$active_phase"
    return
  fi

  # 3. No phase context
  echo ""
}

# In extract-todowrite.sh
new_task_phase=$(get_session_phase)
if [[ -n "$new_task_phase" ]]; then
  new_id=$("$SCRIPT_DIR/add-task.sh" "$title" \
    --labels "session-created" \
    --phase "$new_task_phase" \
    --description "Created during TodoWrite session" \
    --quiet)
  log_info "Created: $new_id - $title (phase: $new_task_phase)"
else
  # Fallback to no phase (current behavior)
  new_id=$("$SCRIPT_DIR/add-task.sh" "$title" \
    --labels "session-created" \
    --description "Created during TodoWrite session" \
    --quiet)
  log_info "Created: $new_id - $title (no phase context)"
fi
```

**Edge Cases**:

| Scenario | Behavior |
|----------|----------|
| No focused task, no phases defined | No phase assigned (null) |
| Focused task has null phase | Use most active phase heuristic |
| All tasks in phase A are done | Heuristic selects phase B (most pending) |
| Multi-phase session (focus changes) | Each new task gets phase from context at creation time |

### C. Phase Completion Detection

**Function**: `check_phase_completion()`

```bash
check_phase_completion() {
  local todo_file="$1"
  local completed_task_ids="$2"  # newline-separated

  local completed_phases=()

  # Get all phases that just became 100% complete
  while IFS= read -r task_id; do
    [[ -z "$task_id" ]] && continue

    # Get task's phase
    task_phase=$(jq -r --arg id "$task_id" \
      '.tasks[] | select(.id == $id) | .phase // ""' "$todo_file")

    [[ -z "$task_phase" ]] && continue

    # Check if ALL tasks in this phase are now done
    phase_complete=$(jq -r --arg phase "$task_phase" '
      [.tasks[] | select(.phase == $phase)] as $phase_tasks |
      ($phase_tasks | length) > 0 and
      ($phase_tasks | all(.status == "done"))
    ' "$todo_file")

    if [[ "$phase_complete" == "true" ]]; then
      # Check if already in array
      if [[ ! " ${completed_phases[*]} " =~ " ${task_phase} " ]]; then
        completed_phases+=("$task_phase")
      fi
    fi
  done <<< "$completed_task_ids"

  # Return completed phases
  printf '%s\n' "${completed_phases[@]}"
}
```

**Integration Point**: After applying completions in extract (line 278)

```bash
# After completing tasks
if [[ "$changes_made" -gt 0 ]]; then
  # Check for phase completions
  completed_phases=$(check_phase_completion "$TODO_FILE" "$completed")

  while IFS= read -r phase; do
    [[ -z "$phase" ]] && continue
    log_info "Phase '$phase' is now complete (all tasks done)"

    # Log to audit trail
    # (Implementation in phase completion reporting section)
  done <<< "$completed_phases"
fi
```

### D. Auto-Advance Behavior

**Design Decision**: Opt-in flag, not default behavior.

**Rationale**:
- Phase transitions are workflow milestones (should be intentional)
- Auto-advance could skip review/testing gates
- User may want to add more tasks to completed phase
- Conservative default = safer

**Implementation**:

```bash
# Command flag
cleo sync --extract --auto-advance

# Config option (.cleo/config.json)
{
  "sync": {
    "autoAdvancePhase": false,  # default
    "phaseProgressionOrder": ["setup", "core", "polish"]
  }
}

# Auto-advance logic
auto_advance_phase() {
  local completed_phase="$1"

  # Get next phase in order
  next_phase=$(jq -r --arg current "$completed_phase" '
    .phases | to_entries |
    sort_by(.value.order) |
    map(.key) as $ordered |
    ($ordered | index($current)) as $idx |
    if $idx != null and ($idx + 1) < ($ordered | length) then
      $ordered[$idx + 1]
    else
      ""
    end
  ' "$TODO_FILE")

  if [[ -z "$next_phase" ]]; then
    log_info "No next phase after '$completed_phase' (project complete?)"
    return
  fi

  # Move all pending tasks in completed phase to next phase
  # OR update project.currentPhase (if schema extended)
  log_info "Auto-advanced from '$completed_phase' → '$next_phase'"

  # Audit log
  # ...
}
```

**User Workflows**:

```bash
# Conservative (manual phase management)
ct sync --extract
# Output: Phase 'setup' is now complete. Use 'ct phases' to review.

# Aggressive (auto-advance)
ct sync --extract --auto-advance
# Output: Phase 'setup' complete. Auto-advanced to 'core'.

# Config-driven
ct config set sync.autoAdvancePhase true
ct sync --extract  # Now auto-advances by default
```

### E. Phase Statistics in Extract Output

**Enhanced Summary**:

```bash
# Current output (line 379)
log_info "Changes detected: $completed_count completed, $progressed_count progressed, ..."

# Enhanced output
log_info "Changes detected: $completed_count completed, $progressed_count progressed, ..."

# Add phase breakdown
if [[ "$completed_count" -gt 0 ]]; then
  # Group completions by phase
  phase_breakdown=$(echo "$completed" | while read -r task_id; do
    jq -r --arg id "$task_id" \
      '.tasks[] | select(.id == $id) | .phase // "no-phase"' "$TODO_FILE"
  done | sort | uniq -c | sort -rn)

  echo ""
  echo "Completions by phase:"
  while read -r count phase; do
    printf "  %2d tasks in phase: %s\n" "$count" "$phase"
  done <<< "$phase_breakdown"
fi

# Add phase completion alerts
if [[ -n "$completed_phases" ]]; then
  echo ""
  echo -e "${GREEN}Phase milestones:${NC}"
  while IFS= read -r phase; do
    [[ -z "$phase" ]] && continue
    echo "  ✓ Phase '$phase' completed (all tasks done)"
  done <<< "$completed_phases"
fi
```

**JSON Format Output** (for scripting):

```json
{
  "_meta": { "command": "extract", "timestamp": "..." },
  "changes": {
    "completed": ["T001", "T002"],
    "progressed": ["T003"],
    "newTasks": ["T010"],
    "removed": []
  },
  "phaseImpact": {
    "completionsByPhase": {
      "core": 2,
      "setup": 0
    },
    "completedPhases": ["setup"],
    "suggestedPhase": "core"
  },
  "summary": {
    "totalChanges": 3,
    "phasesCompleted": 1
  }
}
```

### F. Audit Logging Enhancements

**New Log Events**:

```json
{
  "timestamp": "2025-12-15T10:30:00Z",
  "operation": "todowrite_extract",
  "eventType": "phase_inherited",
  "taskId": "T010",
  "details": {
    "phase": "core",
    "inheritedFrom": "focus_task",
    "focusTaskId": "T009"
  }
}

{
  "timestamp": "2025-12-15T10:30:00Z",
  "operation": "todowrite_extract",
  "eventType": "phase_completed",
  "details": {
    "phase": "setup",
    "completedTasks": ["T001", "T002", "T003"],
    "totalTasks": 3
  }
}

{
  "timestamp": "2025-12-15T10:30:00Z",
  "operation": "todowrite_extract",
  "eventType": "phase_auto_advanced",
  "details": {
    "fromPhase": "setup",
    "toPhase": "core",
    "trigger": "phase_completion"
  }
}
```

**Integration**: Extend existing logging calls in extract-todowrite.sh

## Edge Cases & Conflict Resolution

### Edge Case 1: Multi-Phase Session

**Scenario**: User works on tasks in different phases during same session.

```
Session start: Focus on T001 (phase: setup)
TodoWrite: Complete T001
TodoWrite: Create "New task A"  → phase: setup (inherited)
User changes focus: T002 (phase: core)
TodoWrite: Create "New task B"  → phase: core (inherited)
```

**Resolution**: Phase assignment is dynamic per creation time. Each new task inherits phase context at moment of creation.

**Audit Trail**: Log shows two different inherited phases for same session.

### Edge Case 2: Phase Deleted During Session

**Scenario**: User deletes phase definition while session active.

```
Session start: Focus T001 (phase: testing)
External change: Admin removes "testing" from phases object
Extract: T001 still has phase="testing" (orphaned)
```

**Resolution**:
- Allow orphaned phases (schema doesn't enforce FK constraint)
- Warn during extract if new task would inherit orphaned phase
- `phases.sh` shows orphaned phases with warning icon

### Edge Case 3: Circular Phase Dependencies

**Scenario**: User tries auto-advance but phase order is ambiguous.

```
phases: {
  "core": {"order": 2},
  "setup": {"order": 1},
  "polish": {"order": 2}  # Duplicate order!
}
```

**Resolution**:
- Auto-advance uses stable sort (alphabetical tie-breaker)
- Warn about duplicate orders
- `phases.sh stats` shows order conflicts

### Edge Case 4: All Phases Complete

**Scenario**: User completes last phase.

```
Extract: Phase 'polish' completed
Auto-advance: No next phase
```

**Resolution**:
- Log special event: "project_completed"
- Suggest archiving or creating new phases
- Do NOT error or fail

### Edge Case 5: No Phases Defined

**Scenario**: Project has no `.phases` object.

```
Extract: New task created
get_session_phase(): No phases exist
```

**Resolution**:
- New task gets null phase (same as current behavior)
- No phase completion checks run
- Phase statistics section skipped in output

## Performance Considerations

### Additional jq Queries

**Impact Analysis**:

| Operation | Current | Proposed | Overhead |
|-----------|---------|----------|----------|
| Extract completion | 1 jq call per task | +1 jq call (phase completion check) | ~10ms for 100 tasks |
| New task creation | 1 jq call | +1 jq call (get session phase) | ~5ms per task |
| Phase statistics | 0 | +1 jq call per extract | ~10ms |

**Total Overhead**: <50ms for typical session (5 completions, 2 new tasks).

**Mitigation**: Batch jq queries where possible.

### File I/O

**Current**: Read todo.json once at start.

**Proposed**: Same (no additional reads).

**Audit Logging**: Append-only (same as current).

### Memory

**Negligible**: Phase arrays stored in bash variables (max ~100 bytes).

## Configuration Options

**New Section**: `.cleo/config.json`

```json
{
  "sync": {
    "phaseAssignment": {
      "enabled": true,
      "strategy": "focus_task",  // or "most_active" or "none"
      "fallback": "most_active"
    },
    "phaseCompletion": {
      "detection": true,
      "reporting": "verbose",  // or "quiet" or "none"
      "autoAdvance": false
    },
    "phaseAuditLog": {
      "logInheritance": true,
      "logCompletion": true,
      "logAutoAdvance": true
    }
  }
}
```

**Defaults** (if config not present):

| Setting | Default | Rationale |
|---------|---------|-----------|
| `phaseAssignment.enabled` | true | Useful for most users |
| `phaseAssignment.strategy` | "focus_task" | Most intuitive |
| `phaseCompletion.detection` | true | Low overhead, high value |
| `phaseCompletion.autoAdvance` | false | Conservative (manual gates) |
| `phaseAuditLog.*` | true | Full transparency |

## Implementation Phases

### Phase 1: Foundation (No Schema Change)

**Deliverables**:
- `get_session_phase()` function in extract-todowrite.sh
- New task phase assignment with inheritance
- Phase statistics in extract summary
- Basic audit logging

**Tests**:
- New task inherits focus task's phase
- New task inherits most active phase if no focus
- New task gets null phase if no context
- Extract summary shows phase breakdown

**Effort**: 2-3 days

### Phase 2: Phase Completion Detection

**Deliverables**:
- `check_phase_completion()` function
- Phase milestone reporting in extract output
- Enhanced audit log events

**Tests**:
- Detect single phase completion
- Detect multiple phase completions in one extract
- Handle no phase completions gracefully
- Audit log contains completion events

**Effort**: 1-2 days

### Phase 3: Auto-Advance (Optional)

**Deliverables**:
- `--auto-advance` flag for extract command
- `sync.autoAdvancePhase` config option
- Auto-advance logic with next phase detection
- Enhanced audit logging for phase transitions

**Tests**:
- Auto-advance to next phase on completion
- Handle last phase completion (no next)
- Respect manual override (no auto-advance if disabled)
- Config option works correctly

**Effort**: 2 days

### Phase 4: Enhanced Reporting

**Deliverables**:
- JSON output format for phase impact
- Phase-aware diff summaries
- Integration with `dash` command

**Tests**:
- JSON format valid and complete
- Dash shows recent phase completions
- Extract summary includes all phase data

**Effort**: 1 day

### Phase 5: Schema Extension (Future)

**Deliverables**:
- Add `.project.currentPhase` field
- Migration script for existing projects
- Explicit phase management commands

**Tests**:
- Schema validation passes
- Migration preserves existing data
- New projects initialize with phase tracking

**Effort**: 3-4 days (includes migration tooling)

## Testing Strategy

### Unit Tests

**File**: `tests/unit/phase-extract.bats`

```bash
@test "get_session_phase returns focus task phase" {
  # Setup: Focus task with phase
  # Assert: Returns correct phase
}

@test "get_session_phase returns most active phase when no focus" {
  # Setup: No focus, tasks in multiple phases
  # Assert: Returns phase with most pending tasks
}

@test "check_phase_completion detects single phase" {
  # Setup: Complete last task in phase
  # Assert: Returns phase slug
}

@test "check_phase_completion handles multiple phases" {
  # Setup: Complete tasks in 2 phases simultaneously
  # Assert: Returns both phase slugs
}
```

### Integration Tests

**File**: `tests/integration/todowrite-phase-sync.bats`

```bash
@test "extract assigns phase to new tasks" {
  # Setup: Session with focused task in 'core' phase
  # Create: TodoWrite state with new task (no ID prefix)
  # Extract: Run extract-todowrite.sh
  # Assert: New task has phase='core'
}

@test "extract reports phase completion" {
  # Setup: Phase with 1 pending task
  # Create: TodoWrite state marking task complete
  # Extract: Run extract
  # Assert: Output contains phase completion message
}

@test "extract auto-advances with flag" {
  # Setup: Last task in 'setup' phase
  # Create: TodoWrite state marking complete
  # Extract: Run extract --auto-advance
  # Assert: Project phase advanced to 'core'
}
```

### Golden File Tests

**Directory**: `tests/golden/extract-phase/`

```
extract-phase-completion.golden
extract-phase-stats.golden
extract-auto-advance.golden
extract-multi-phase.golden
```

### Manual Test Scenarios

1. **Scenario: New task inherits phase**
   - Start session with focus on T001 (phase: core)
   - Create new task in TodoWrite
   - Extract and verify task has phase: core

2. **Scenario: Phase completion milestone**
   - Complete last 3 tasks in "setup" phase
   - Extract and verify completion message shown

3. **Scenario: Multi-phase workflow**
   - Work on tasks in setup, core, polish
   - Extract and verify statistics show all phases

## Backward Compatibility

**Guaranteed**:
- Existing tasks without phases continue to work
- Extract without new flags behaves identically to current
- No schema changes in Phases 1-4

**Optional Features**:
- `--auto-advance` is opt-in
- Config options have safe defaults
- Enhanced logging can be disabled

**Migration Path**:
- Phase 5 (schema extension) requires migration
- Migration script handles existing data
- Old format still readable (deprecated warning)

## Security Considerations

**No New Attack Surface**:
- No external inputs (TodoWrite state is user-created)
- No privilege escalation (same user context)
- No network operations

**Audit Trail**:
- All phase changes logged
- Reversible operations (no destructive auto-advance)

## Documentation Requirements

**New Docs**:
- `docs/commands/sync.md` - Add phase-aware extract documentation
- `docs/workflows/phase-based-development.md` - Phase workflow guide
- `docs/architecture/phase-lifecycle.md` - Phase state machine

**Updated Docs**:
- `docs/commands/phases.md` - Add phase completion detection
- `TODO_Task_Management.md` - Add phase assignment in extract
- `QUICK-REFERENCE.md` - Add phase-aware sync examples

## Metrics & Success Criteria

**Success Metrics**:
- New tasks get appropriate phase ≥90% of time
- Phase completion detection accuracy: 100%
- Extract performance overhead: <10% increase
- Zero regressions in existing sync tests

**User Satisfaction**:
- Reduces manual phase assignment by ≥50%
- Phase milestone visibility improves workflow awareness
- No user complaints about auto-advance (if opt-in)

## Open Questions

1. **Phase Inheritance Priority**: Should focus task phase override most-active phase, or vice versa?
   - **Recommendation**: Focus task takes priority (more intentional)

2. **Auto-Advance Scope**: Should it move tasks or just update project.currentPhase?
   - **Recommendation**: Phase 1-4 no auto-advance, Phase 5 updates currentPhase only

3. **Phase Completion Threshold**: 100% done, or allow configurable (e.g., 90%)?
   - **Recommendation**: 100% only (clear milestone)

4. **Phase Rename Handling**: What if phase slug changes during session?
   - **Recommendation**: Treat as orphaned phase, warn user

5. **Multi-Project Sessions**: Does this work with nested projects?
   - **Recommendation**: Out of scope (current todo.json is single-project)

## Recommendations

### Immediate Implementation (v0.15.0)

**Phase 1 + Phase 2**:
- New task phase assignment (focus/most-active heuristic)
- Phase completion detection and reporting
- Enhanced audit logging
- NO auto-advance (too risky without explicit phase management)

**Rationale**: Provides 80% of value with 20% of risk.

### Future Enhancements (v0.16.0+)

**Phase 3 + Phase 4**:
- Auto-advance as opt-in feature
- JSON output formats for scripting
- Dashboard integration

**Phase 5** (v2.0.0):
- Explicit project.currentPhase schema field
- Phase lifecycle management commands
- Phase history tracking

### Configuration Defaults

**Recommended**:
```json
{
  "sync": {
    "phaseAssignment": {
      "enabled": true,
      "strategy": "focus_task",
      "fallback": "most_active"
    },
    "phaseCompletion": {
      "detection": true,
      "reporting": "verbose",
      "autoAdvance": false  // Conservative default
    }
  }
}
```

## Conclusion

Phase-aware TodoWrite extract provides significant workflow improvements without requiring schema changes or risky automation. The proposed implementation is:

- **Safe**: Opt-in auto-advance, conservative defaults
- **Backward Compatible**: No breaking changes
- **Performant**: <10% overhead
- **Testable**: Comprehensive test coverage
- **Incremental**: Phased rollout reduces risk

**Next Steps**:
1. Stakeholder review of this design document
2. Create implementation tasks (T239-T243)
3. Begin Phase 1 development
4. Integration testing with real workflows
5. Documentation and user feedback

---

**Document Status**: Draft for Review
**Last Updated**: 2025-12-15
**Review Deadline**: 2025-12-20
**Implementation Target**: v0.15.0 (January 2026)
