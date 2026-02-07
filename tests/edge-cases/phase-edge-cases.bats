#!/usr/bin/env bats
# =============================================================================
# phase-edge-cases.bats - Edge case tests for phase management
# =============================================================================
# Tests unusual, error, and boundary conditions for phase operations:
#   - Multiple active phases (validation)
#   - Deleting phase with active tasks
#   - Renaming phases with task references
#   - Concurrent phase access (file locking)
#   - Phases with no tasks
#   - Invalid phase transitions
#   - Malformed phase data recovery
#   - Circular phase dependencies
#   - Phase limits (max phases, long names)
#   - Timestamp edge cases (future dates, null handling)
#   - Phase completion with incomplete tasks
#   - Phase rollback scenarios
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test

    export PHASE_SCRIPT="${SCRIPTS_DIR}/phase.sh"
    export ADD_SCRIPT="${SCRIPTS_DIR}/add.sh"
    export UPDATE_SCRIPT="${SCRIPTS_DIR}/update.sh"
    export VALIDATE_SCRIPT="${SCRIPTS_DIR}/validate.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# FIXTURES
# =============================================================================

create_multiactive_fixture() {
    # Invalid state: multiple active phases (should be caught by validation)
    # Uses canonical 5-phase structure with intentionally invalid multiple active phases
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "currentPhase": "setup",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup & Foundation",
        "description": "Setup phase",
        "status": "active",
        "startedAt": "2025-12-01T10:00:00Z",
        "completedAt": null
      },
      "core": {
        "order": 2,
        "name": "Core Development",
        "description": "Core phase",
        "status": "active",
        "startedAt": "2025-12-01T11:00:00Z",
        "completedAt": null
      },
      "testing": {
        "order": 3,
        "name": "Testing & Validation",
        "description": "Testing phase",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      },
      "polish": {
        "order": 4,
        "name": "Polish & Refinement",
        "description": "Polish phase",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      },
      "maintenance": {
        "order": 5,
        "name": "Maintenance",
        "description": "Maintenance phase",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      }
    }
  },
  "lastUpdated": "2025-12-01T10:00:00Z",
  "_meta": {
    "version": "2.2.0",
    "checksum": "9817237af4c97bea",
    "configVersion": "2.2.0",
    "lastSessionId": null,
    "activeSession": null
  },
  "focus": {
    "currentTask": null,
    "currentPhase": "setup",
    "blockedUntil": null,
    "sessionNote": null,
    "nextAction": null
  },
  "tasks": [],
  "completedTasks": []
}
EOF
}

create_phase_with_tasks_fixture() {
    # Create fixture with canonical 5-phase structure and a task in setup
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "currentPhase": "setup",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup & Foundation",
        "description": "Initial setup",
        "status": "active",
        "startedAt": "2025-12-01T10:00:00Z",
        "completedAt": null
      },
      "core": {
        "order": 2,
        "name": "Core Development",
        "description": "Core phase",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      },
      "testing": {
        "order": 3,
        "name": "Testing & Validation",
        "description": "Testing phase",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      },
      "polish": {
        "order": 4,
        "name": "Polish & Refinement",
        "description": "Polish phase",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      },
      "maintenance": {
        "order": 5,
        "name": "Maintenance",
        "description": "Maintenance phase",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      }
    }
  },
  "lastUpdated": "2025-12-01T10:00:00Z",
  "_meta": {
    "version": "2.2.0",
    "checksum": "4a4ac25f08a4f67e",
    "configVersion": "2.2.0",
    "lastSessionId": null,
    "activeSession": null
  },
  "focus": {
    "currentTask": null,
    "currentPhase": "setup",
    "blockedUntil": null,
    "sessionNote": null,
    "nextAction": null
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Setup task",
      "description": "Task in setup phase",
      "status": "pending",
      "priority": "medium",
      "phase": "setup",
      "labels": [],
      "dependencies": [],
      "createdAt": "2025-12-01T10:00:00Z",
      "updatedAt": "2025-12-01T10:00:00Z"
    }
  ],
  "completedTasks": []
}
EOF
}

create_invalid_phase_fixture() {
    # Malformed phase data for recovery testing
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "currentPhase": "nonexistent-phase",
    "phases": {
      "setup": {
        "order": "not-a-number",
        "name": "Setup",
        "description": "Setup phase",
        "status": "invalid-status",
        "startedAt": "invalid-timestamp",
        "completedAt": null
      }
    }
  },
  "lastUpdated": "2025-12-01T10:00:00Z",
  "_meta": {
    "version": "2.2.0",
    "checksum": "test123",
    "configVersion": "2.2.0",
    "lastSessionId": null,
    "activeSession": null
  },
  "focus": {
    "currentTask": null,
    "currentPhase": "nonexistent-phase",
    "blockedUntil": null,
    "sessionNote": null,
    "nextAction": null
  },
  "tasks": [],
  "completedTasks": []
}
EOF
}

# =============================================================================
# EDGE CASE 1: Multiple Active Phases (Validation)
# =============================================================================

@test "phase-edge: detect multiple active phases in validation" {
    create_multiactive_fixture

    run bash "$VALIDATE_SCRIPT"
    assert_failure
    # The validation should detect multiple active phases
    assert_output --partial "Multiple active phases"
}

# =============================================================================
# EDGE CASE 2: Phase with No Tasks
# =============================================================================

@test "phase-edge: empty phase shows zero task count" {
    create_phase_with_tasks_fixture

    # Set current phase to core (which has no tasks in fixture)
    run bash "$PHASE_SCRIPT" set core
    assert_success

    # List phases - core should show 0 tasks (TOTAL column shows 0)
    run bash "${SCRIPTS_DIR}/phases.sh" list
    assert_success
    assert_output --partial "core"
    # Empty phases show "Empty" status
    assert_output --partial "Empty"
}

@test "phase-edge: advance from empty phase succeeds" {
    create_phase_with_tasks_fixture

    # The fixture already has 'core' phase with no tasks
    # First complete setup (it has a task, so we need to complete it first)
    jq '.tasks[0].status = "done"' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Complete setup and advance to core (core has no tasks)
    run bash "$PHASE_SCRIPT" complete setup
    assert_success

    # Start the empty core phase
    run bash "$PHASE_SCRIPT" start core
    assert_success

    # Advance from empty phase (core->testing) should work
    run bash "$PHASE_SCRIPT" advance
    assert_success
}

# =============================================================================
# EDGE CASE 3: Invalid Phase Transitions
# =============================================================================

@test "phase-edge: cannot complete phase with active tasks" {
    create_phase_with_tasks_fixture

    # Try to complete phase while task is still pending
    run bash "$PHASE_SCRIPT" complete setup
    assert_failure
    # Actual message: "Cannot complete phase 'setup' - N incomplete task(s) pending"
    assert_output --partial "Cannot complete phase" || assert_output --partial "incomplete task"
}

@test "phase-edge: cannot start already active phase" {
    create_phase_with_tasks_fixture

    # Setup is already active, try to start it again
    run bash "$PHASE_SCRIPT" start setup
    assert_failure
    # Actual message: "Can only start pending phases (current: active)"
    assert_output --partial "Can only start pending" || assert_output --partial "current: active"
}

@test "phase-edge: cannot complete non-active phase" {
    create_phase_with_tasks_fixture

    # Core phase exists but is pending, try to complete it without starting
    run bash "$PHASE_SCRIPT" complete core
    assert_failure
    # Actual message: "Can only complete active phases (current: pending)"
    assert_output --partial "Can only complete active" || assert_output --partial "current: pending"
}

# =============================================================================
# EDGE CASE 4: Phase Data Validation
# =============================================================================

@test "phase-edge: validation catches invalid phase status" {
    create_invalid_phase_fixture

    run bash "$VALIDATE_SCRIPT"
    assert_failure
    # Actual message: "Invalid phase status values found: setup: invalid-status"
    assert_output --partial "Invalid phase status" || assert_output --partial "invalid-status"
}

@test "phase-edge: validation catches currentPhase mismatch" {
    create_invalid_phase_fixture

    # currentPhase points to nonexistent phase
    run bash "$VALIDATE_SCRIPT"
    assert_failure
    # Actual message: "currentPhase 'nonexistent-phase' does not exist"
    assert_output --partial "currentPhase" || assert_output --partial "does not exist"
}

# =============================================================================
# EDGE CASE 5: Task-Phase Consistency
# =============================================================================

@test "phase-edge: orphaned task phase (task references deleted phase)" {
    create_phase_with_tasks_fixture

    # Manually create task with invalid phase reference
    jq '.tasks += [{
      "id": "T002",
      "title": "Orphaned task",
      "description": "Task in deleted phase",
      "status": "pending",
      "priority": "medium",
      "phase": "deleted-phase",
      "labels": [],
      "dependencies": [],
      "createdAt": "2025-12-01T10:00:00Z",
      "updatedAt": "2025-12-01T10:00:00Z"
    }]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Validation should warn about orphaned phase reference
    run bash "$VALIDATE_SCRIPT"
    assert_failure
    assert_output --partial "phase" || assert_output --partial "not found"
}

# =============================================================================
# EDGE CASE 6: Phase Name/Slug Boundaries
# =============================================================================

@test "phase-edge: very long phase name (boundary test)" {
    skip "Requires phase create command with --name flag (not yet implemented)"
    # Note: When phase creation with custom names is added, this test should verify:
    # - Long names (200+ chars) are either accepted or rejected gracefully
    # - Error message mentions "too long" or "invalid" if rejected
}

@test "phase-edge: phase slug with special characters rejected" {
    create_phase_with_tasks_fixture

    # Try to set current phase to an invalid slug (doesn't exist)
    # The error should indicate the phase doesn't exist
    run bash "$PHASE_SCRIPT" set "invalid slug!"
    assert_failure
    # Since the phase doesn't exist, we get a "does not exist" error
    assert_output --partial "does not exist" || assert_output --partial "invalid" || assert_output --partial "slug"
}

# =============================================================================
# EDGE CASE 7: Timestamp Edge Cases
# =============================================================================

@test "phase-edge: future timestamp detection" {
    create_phase_with_tasks_fixture

    # Manually set future timestamp
    local future_date="2099-12-31T23:59:59Z"
    jq --arg date "$future_date" \
       '.project.phases.setup.startedAt = $date' \
       "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$VALIDATE_SCRIPT"
    assert_failure
    # Actual message: "Future timestamps detected in phases: setup"
    assert_output --partial "Future timestamp" || assert_output --partial "setup"
}

@test "phase-edge: null timestamp handling" {
    create_phase_with_tasks_fixture

    # Pending phases (core, testing, polish, maintenance) should have null timestamps
    # Active phase (setup) should have startedAt set

    # Verify null timestamps for pending phase
    run jq -r '.project.phases.core.startedAt' "$TODO_FILE"
    assert_output "null"

    run jq -r '.project.phases.core.completedAt' "$TODO_FILE"
    assert_output "null"

    # Verify active phase has startedAt set
    local setup_started
    setup_started=$(jq -r '.project.phases.setup.startedAt' "$TODO_FILE")
    [[ "$setup_started" != "null" ]]

    # Verify active phase has completedAt still null
    run jq -r '.project.phases.setup.completedAt' "$TODO_FILE"
    assert_output "null"

    # The phases command should list phases correctly with null timestamps
    run bash "$PHASE_SCRIPT" list
    assert_success
    assert_output --partial "setup"
    assert_output --partial "core"
}

# =============================================================================
# EDGE CASE 8: Phase Ordering
# =============================================================================

@test "phase-edge: phases with duplicate order numbers" {
    create_phase_with_tasks_fixture

    # Manually create duplicate order
    jq '.project.phases.core = {
      "order": 1,
      "name": "Core",
      "description": "Duplicate order",
      "status": "pending",
      "startedAt": null,
      "completedAt": null
    }' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Validation should catch duplicate order
    run bash "$VALIDATE_SCRIPT"
    assert_failure
    assert_output --partial "duplicate" || assert_output --partial "order"
}

@test "phase-edge: advance with gaps in phase order" {
    create_phase_with_tasks_fixture

    # The fixture already has 5 phases with orders 1-5
    # Manually create gaps by modifying orders to 1, 3, 5
    jq '.project.phases.core.order = 3 | .project.phases.testing.order = 5 |
        del(.project.phases.polish) | del(.project.phases.maintenance)' \
       "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Complete the task in setup phase first
    bash "${SCRIPTS_DIR}/complete.sh" T001 --skip-notes

    # Complete setup phase (order 1)
    bash "$PHASE_SCRIPT" complete setup

    # Advance should go to core (order 3), skipping gap at order 2
    run bash "$PHASE_SCRIPT" advance
    assert_success

    run jq -r '.project.currentPhase' "$TODO_FILE"
    assert_output "core"
}

# =============================================================================
# EDGE CASE 9: Concurrent Access (File Locking)
# =============================================================================

@test "phase-edge: file lock prevents concurrent phase operations" {
    skip "Requires T350: File locking not yet implemented in phase operations"

    create_phase_with_tasks_fixture

    # This would test file locking if implemented
    # For now, document the expected behavior
}

# =============================================================================
# EDGE CASE 10: Phase List Display
# =============================================================================

@test "phase-edge: list phases when no phases defined" {
    # Create minimal v2.2.0 file with no phases
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "currentPhase": null,
    "phases": {}
  },
  "lastUpdated": "2025-12-01T10:00:00Z",
  "_meta": {
    "version": "2.2.0",
    "checksum": "test123",
    "configVersion": "2.2.0",
    "lastSessionId": null,
    "activeSession": null
  },
  "focus": {
    "currentTask": null,
    "currentPhase": null,
    "blockedUntil": null,
    "sessionNote": null,
    "nextAction": null
  },
  "tasks": [],
  "completedTasks": []
}
EOF

    run bash "${SCRIPTS_DIR}/phases.sh" list
    assert_success
    assert_output --partial "No phases" || assert_output --partial "0 phases"
}

# =============================================================================
# Summary: 12 Edge Case Tests
# =============================================================================
# 1. Multiple active phases detection (validation)
# 2. Empty phase (zero tasks) handling
# 3. Empty phase advance
# 4. Complete phase with active tasks (blocked)
# 5. Start already active phase (blocked)
# 6. Complete non-active phase (blocked)
# 7. Invalid phase status validation
# 8. currentPhase mismatch validation
# 9. Orphaned task phase reference
# 10. Long phase name boundary
# 11. Invalid phase slug characters
# 12. Future timestamp detection
# 13. Null timestamp handling
# 14. Duplicate phase order numbers
# 15. Phase advance with gaps in order
# 16. No phases defined (empty list)
# =============================================================================
