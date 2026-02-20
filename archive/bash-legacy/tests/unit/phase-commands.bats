#!/usr/bin/env bats
# =============================================================================
# phase-commands.bats - Unit tests for phase.sh (phase command)
# =============================================================================
# Tests phase management functionality including show, set, start, complete,
# advance, and list subcommands with v2.2.0 project.phases structure.
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test

    # Set PHASE_SCRIPT path
    export PHASE_SCRIPT="${SCRIPTS_DIR}/phase.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Test Helper: Create v2.2.0 fixture with project.phases
# =============================================================================

# Create todo.json with proper v2.2.0 phase structure
create_phase_fixture() {
    local current_phase="${1:-setup}"
    local setup_status="${2:-active}"

    local started_at='null'
    local completed_at='null'

    if [[ "$setup_status" != "pending" ]]; then
        started_at='"2025-12-01T10:00:00Z"'
    fi
    if [[ "$setup_status" == "completed" ]]; then
        completed_at='"2025-12-10T12:00:00Z"'
    fi

    cat > "$TODO_FILE" << EOF
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "currentPhase": "$current_phase",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup & Foundation",
        "description": "Initial project setup",
        "status": "$setup_status",
        "startedAt": $started_at,
        "completedAt": $completed_at
      },
      "core": {
        "order": 2,
        "name": "Core Development",
        "description": "Build core functionality",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      },
      "polish": {
        "order": 3,
        "name": "Polish & Launch",
        "description": "Refinement and testing",
        "status": "pending",
        "startedAt": null,
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
    "currentPhase": "$current_phase",
    "blockedUntil": null,
    "sessionNote": null,
    "nextAction": null
  },
  "tasks": [],
  "labels": {}
}
EOF
}

# =============================================================================
# Script Presence Tests
# =============================================================================

@test "phase script exists" {
    [ -f "$PHASE_SCRIPT" ]
}

@test "phase script is executable" {
    [ -x "$PHASE_SCRIPT" ]
}

# =============================================================================
# Help and Usage Tests
# =============================================================================

@test "phase --help shows usage" {
    create_phase_fixture
    run bash "$PHASE_SCRIPT" --human --help
    assert_success
    assert_output --partial "Usage:"
    assert_output --partial "cleo phase"
}

@test "phase -h shows usage" {
    create_phase_fixture
    run bash "$PHASE_SCRIPT" --human -h
    assert_success
    assert_output --partial "Usage:"
}

@test "phase help shows all subcommands" {
    create_phase_fixture
    run bash "$PHASE_SCRIPT" --human --help
    assert_success
    assert_output_contains_all "show" "set" "start" "complete" "advance" "list"
}

@test "phase without arguments shows usage" {
    create_phase_fixture
    run bash "$PHASE_SCRIPT" --human
    assert_failure
    assert_output --partial "Usage:"
}

@test "phase with unknown subcommand shows error" {
    create_phase_fixture
    run bash "$PHASE_SCRIPT" --human unknown
    assert_failure
    assert_output --partial "ERROR"
    assert_output --partial "Unknown subcommand"
}

# =============================================================================
# phase show Tests
# =============================================================================

@test "phase show displays current phase" {
    create_phase_fixture "setup" "active"
    run bash "$PHASE_SCRIPT" --human show
    assert_success
    assert_output --partial "Current Phase: setup"
    assert_output --partial "Setup & Foundation"
}

@test "phase show displays phase status" {
    create_phase_fixture "setup" "active"
    run bash "$PHASE_SCRIPT" --human show
    assert_success
    assert_output --partial "Status: active"
}

@test "phase show displays started timestamp" {
    create_phase_fixture "setup" "active"
    run bash "$PHASE_SCRIPT" --human show
    assert_success
    assert_output --partial "Started:"
}

@test "phase show handles no current phase" {
    create_phase_fixture "null" "pending"
    # Manually set currentPhase to null
    jq '.project.currentPhase = null' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$PHASE_SCRIPT" --human show
    assert_failure
    assert_output --partial "No current phase set"
}

# =============================================================================
# phase set Tests
# =============================================================================

@test "phase set changes current phase" {
    create_phase_fixture "setup" "active"
    run bash "$PHASE_SCRIPT" --human set core
    assert_success
    assert_output --partial "Phase set to: core"

    # Verify change in file
    local current_phase
    current_phase=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [[ "$current_phase" == "core" ]]
}

@test "phase set updates focus.currentPhase" {
    create_phase_fixture "setup" "active"
    bash "$PHASE_SCRIPT" set core

    local focus_phase
    focus_phase=$(jq -r '.focus.currentPhase' "$TODO_FILE")
    [[ "$focus_phase" == "core" ]]
}

@test "phase set requires phase slug argument" {
    create_phase_fixture
    run bash "$PHASE_SCRIPT" --human set
    assert_failure
    assert_output --partial "ERROR"
    assert_output --partial "Phase slug required"
}

@test "phase set validates phase exists" {
    create_phase_fixture
    run bash "$PHASE_SCRIPT" --human set nonexistent
    assert_failure
    assert_output --partial "ERROR"
    assert_output --partial "does not exist"
}

@test "phase set does not change phase status" {
    create_phase_fixture "setup" "active"
    bash "$PHASE_SCRIPT" set core

    # Core should still be pending
    local core_status
    core_status=$(jq -r '.project.phases.core.status' "$TODO_FILE")
    [[ "$core_status" == "pending" ]]
}

# =============================================================================
# phase start Tests
# =============================================================================

@test "phase start activates pending phase" {
    create_phase_fixture "setup" "active"
    run bash "$PHASE_SCRIPT" --human start core
    assert_success
    assert_output --partial "Started phase: core"

    # Verify status changed
    local core_status
    core_status=$(jq -r '.project.phases.core.status' "$TODO_FILE")
    [[ "$core_status" == "active" ]]
}

@test "phase start sets startedAt timestamp" {
    create_phase_fixture "setup" "active"
    bash "$PHASE_SCRIPT" start core

    local started_at
    started_at=$(jq -r '.project.phases.core.startedAt' "$TODO_FILE")
    [[ "$started_at" != "null" && -n "$started_at" ]]
}

@test "phase start sets phase as current" {
    create_phase_fixture "setup" "active"
    bash "$PHASE_SCRIPT" start core

    local current_phase
    current_phase=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [[ "$current_phase" == "core" ]]
}

@test "phase start updates focus.currentPhase" {
    create_phase_fixture "setup" "active"
    bash "$PHASE_SCRIPT" start core

    local focus_phase
    focus_phase=$(jq -r '.focus.currentPhase' "$TODO_FILE")
    [[ "$focus_phase" == "core" ]]
}

@test "phase start requires phase slug argument" {
    create_phase_fixture
    run bash "$PHASE_SCRIPT" --human start
    assert_failure
    assert_output --partial "ERROR"
    assert_output --partial "Phase slug required"
}

@test "phase start only works on pending phases" {
    create_phase_fixture "setup" "active"
    run bash "$PHASE_SCRIPT" --human start setup
    assert_failure
    assert_output --partial "ERROR"
    assert_output --partial "Can only start pending phases"
}

@test "phase start rejects completed phases" {
    create_phase_fixture "setup" "completed"
    run bash "$PHASE_SCRIPT" --human start setup
    assert_failure
    assert_output --partial "ERROR"
    assert_output --partial "Can only start pending phases"
}

# =============================================================================
# phase complete Tests
# =============================================================================

@test "phase complete marks active phase as completed" {
    create_phase_fixture "setup" "active"
    run bash "$PHASE_SCRIPT" --human complete setup
    assert_success
    assert_output --partial "Completed phase: setup"

    # Verify status changed
    local setup_status
    setup_status=$(jq -r '.project.phases.setup.status' "$TODO_FILE")
    [[ "$setup_status" == "completed" ]]
}

@test "phase complete sets completedAt timestamp" {
    create_phase_fixture "setup" "active"
    bash "$PHASE_SCRIPT" complete setup

    local completed_at
    completed_at=$(jq -r '.project.phases.setup.completedAt' "$TODO_FILE")
    [[ "$completed_at" != "null" && -n "$completed_at" ]]
}

@test "phase complete requires phase slug argument" {
    create_phase_fixture
    run bash "$PHASE_SCRIPT" --human complete
    assert_failure
    assert_output --partial "ERROR"
    assert_output --partial "Phase slug required"
}

@test "phase complete only works on active phases" {
    create_phase_fixture "setup" "active"
    run bash "$PHASE_SCRIPT" --human complete core
    assert_failure
    assert_output --partial "ERROR"
    assert_output --partial "Can only complete active phases"
}

@test "phase complete rejects pending phases" {
    create_phase_fixture "setup" "active"
    run bash "$PHASE_SCRIPT" --human complete core
    assert_failure
    assert_output --partial "Can only complete active phases"
    assert_output --partial "current: pending"
}

@test "phase complete rejects already completed phases" {
    create_phase_fixture "setup" "completed"
    run bash "$PHASE_SCRIPT" --human complete setup
    assert_failure
    assert_output --partial "Can only complete active phases"
}

# =============================================================================
# phase advance Tests
# =============================================================================

@test "phase advance completes current and starts next" {
    create_phase_fixture "setup" "active"
    run bash "$PHASE_SCRIPT" --human advance
    assert_success
    assert_output --partial "Advanced from 'setup' to 'core'"

    # Verify setup is completed
    local setup_status
    setup_status=$(jq -r '.project.phases.setup.status' "$TODO_FILE")
    [[ "$setup_status" == "completed" ]]

    # Verify core is active
    local core_status
    core_status=$(jq -r '.project.phases.core.status' "$TODO_FILE")
    [[ "$core_status" == "active" ]]
}

@test "phase advance updates currentPhase" {
    create_phase_fixture "setup" "active"
    bash "$PHASE_SCRIPT" advance

    local current_phase
    current_phase=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [[ "$current_phase" == "core" ]]
}

@test "phase advance updates focus.currentPhase" {
    create_phase_fixture "setup" "active"
    bash "$PHASE_SCRIPT" advance

    local focus_phase
    focus_phase=$(jq -r '.focus.currentPhase' "$TODO_FILE")
    [[ "$focus_phase" == "core" ]]
}

@test "phase advance fails if no next phase exists" {
    create_phase_fixture "polish" "active"
    run bash "$PHASE_SCRIPT" --human advance
    assert_failure
    assert_output --partial "No more phases"
}

@test "phase advance requires current phase to be set" {
    create_phase_fixture "null" "pending"
    jq '.project.currentPhase = null' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$PHASE_SCRIPT" --human advance
    assert_failure
    assert_output --partial "ERROR"
    assert_output --partial "No current phase set"
}

@test "phase advance follows phase order" {
    # Create fixture with core already active
    create_phase_fixture "core" "pending"
    # Manually set core to active
    jq '.project.phases.core.status = "active" |
        .project.phases.core.startedAt = "2025-12-05T10:00:00Z"' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    bash "$PHASE_SCRIPT" advance

    local current_phase
    current_phase=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [[ "$current_phase" == "polish" ]]
}

# =============================================================================
# phase list Tests
# =============================================================================

@test "phase list displays all phases" {
    create_phase_fixture "setup" "active"
    run bash "$PHASE_SCRIPT" --human list
    assert_success
    assert_output --partial "Project Phases:"
    assert_output_contains_all "setup" "core" "polish"
}

@test "phase list shows phase names" {
    create_phase_fixture "setup" "active"
    run bash "$PHASE_SCRIPT" --human list
    assert_success
    assert_output --partial "Setup & Foundation"
    assert_output --partial "Core Development"
    assert_output --partial "Polish & Launch"
}

@test "phase list shows phase status" {
    create_phase_fixture "setup" "active"
    run bash "$PHASE_SCRIPT" --human list
    assert_success
    assert_output --partial "(active)"
    assert_output --partial "(pending)"
}

@test "phase list marks current phase with star" {
    create_phase_fixture "setup" "active"
    run bash "$PHASE_SCRIPT" --human list
    assert_success
    # Current phase should have star marker
    assert_output --regexp "★.*setup"
}

@test "phase list shows phases in order" {
    create_phase_fixture "setup" "active"
    run bash "$PHASE_SCRIPT" --human list
    assert_success
    assert_output --partial "[1]"
    assert_output --partial "[2]"
    assert_output --partial "[3]"
}

@test "phase list highlights different statuses" {
    # Create fixture with mixed statuses
    create_phase_fixture "core" "pending"
    # Set setup to completed, core to active
    jq '.project.phases.setup.status = "completed" |
        .project.phases.core.status = "active" |
        .project.phases.core.startedAt = "2025-12-05T10:00:00Z"' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$PHASE_SCRIPT" --human list
    assert_success
    assert_output --partial "(completed)"
    assert_output --partial "(active)"
    assert_output --partial "(pending)"
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "phase workflow: start -> complete -> advance" {
    create_phase_fixture "setup" "pending"

    # Start setup phase
    run bash "$PHASE_SCRIPT" --human start setup
    assert_success

    # Complete setup phase
    run bash "$PHASE_SCRIPT" --human complete setup
    assert_success

    # Start core phase
    run bash "$PHASE_SCRIPT" --human start core
    assert_success

    # Verify final state
    local setup_status core_status
    setup_status=$(jq -r '.project.phases.setup.status' "$TODO_FILE")
    core_status=$(jq -r '.project.phases.core.status' "$TODO_FILE")
    [[ "$setup_status" == "completed" ]]
    [[ "$core_status" == "active" ]]
}

@test "phase workflow: advance multiple times" {
    create_phase_fixture "setup" "active"

    # Advance from setup to core
    bash "$PHASE_SCRIPT" advance

    # Advance from core to polish
    bash "$PHASE_SCRIPT" advance

    # Verify final state
    local current_phase
    current_phase=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [[ "$current_phase" == "polish" ]]

    local polish_status
    polish_status=$(jq -r '.project.phases.polish.status' "$TODO_FILE")
    [[ "$polish_status" == "active" ]]
}

@test "phase operations maintain valid JSON" {
    create_phase_fixture "setup" "active"

    bash "$PHASE_SCRIPT" set core
    bash "$PHASE_SCRIPT" start core
    bash "$PHASE_SCRIPT" complete core

    run jq empty "$TODO_FILE"
    assert_success
}

@test "phase operations update lastUpdated timestamp" {
    create_phase_fixture "setup" "active"

    local before_timestamp
    before_timestamp=$(jq -r '.lastUpdated' "$TODO_FILE")

    sleep 1
    bash "$PHASE_SCRIPT" set core

    local after_timestamp
    after_timestamp=$(jq -r '.lastUpdated' "$TODO_FILE")

    [[ "$after_timestamp" != "$before_timestamp" ]]
}

# =============================================================================
# Edge Cases and Error Handling
# =============================================================================

@test "phase handles missing todo.json" {
    rm -f "$TODO_FILE"
    run bash "$PHASE_SCRIPT" show
    assert_failure
}

@test "phase handles malformed JSON" {
    create_phase_fixture
    echo "invalid json" > "$TODO_FILE"
    run bash "$PHASE_SCRIPT" show
    assert_failure
}

@test "phase handles missing project.phases" {
    # TODO: T294 - This test needs proper fix, not bandaid
    # Current behavior: create_empty_todo now has phases, so this test
    # should either use a specific no-phases fixture or test migration behavior
    # For now, skip this test until T294 is addressed
    skip "Requires T294: Proper handling of missing phases scenario"
}

@test "phase set handles phase with special characters" {
    create_phase_fixture
    # Add phase with hyphens (valid)
    jq '.project.phases["pre-setup"] = {
        "order": 0,
        "name": "Pre-Setup",
        "description": "Before setup",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
    }' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Moving to lower-order phase requires --rollback flag (Scenario 6: Rollback Detection)
    run bash "$PHASE_SCRIPT" --human set pre-setup --rollback --force
    assert_success
}

@test "phase complete preserves startedAt timestamp" {
    create_phase_fixture "setup" "active"

    local started_at_before
    started_at_before=$(jq -r '.project.phases.setup.startedAt' "$TODO_FILE")

    bash "$PHASE_SCRIPT" complete setup

    local started_at_after
    started_at_after=$(jq -r '.project.phases.setup.startedAt' "$TODO_FILE")

    [[ "$started_at_before" == "$started_at_after" ]]
}

@test "phase advance sets timestamps correctly" {
    create_phase_fixture "setup" "active"
    bash "$PHASE_SCRIPT" advance

    # Setup should have completedAt
    local setup_completed
    setup_completed=$(jq -r '.project.phases.setup.completedAt' "$TODO_FILE")
    [[ "$setup_completed" != "null" ]]

    # Core should have startedAt
    local core_started
    core_started=$(jq -r '.project.phases.core.startedAt' "$TODO_FILE")
    [[ "$core_started" != "null" ]]
}

# =============================================================================
# Validation Tests
# =============================================================================

@test "phase start validates phase exists" {
    # Scenario 7: Phase operations validate phase exists before proceeding
    create_phase_fixture
    run bash "$PHASE_SCRIPT" --human start new-phase
    assert_failure
    assert_output --partial "does not exist"
}

@test "phase complete validates phase exists before completing" {
    create_phase_fixture
    run bash "$PHASE_SCRIPT" --human complete invalid-phase
    assert_failure
}

@test "phase operations handle null timestamps" {
    create_phase_fixture "setup" "pending"

    # Verify null startedAt before start
    local started_at
    started_at=$(jq -r '.project.phases.setup.startedAt' "$TODO_FILE")
    [[ "$started_at" == "null" ]]

    # Start phase
    bash "$PHASE_SCRIPT" start setup

    # Verify timestamp is set
    started_at=$(jq -r '.project.phases.setup.startedAt' "$TODO_FILE")
    [[ "$started_at" != "null" ]]
}

# =============================================================================
# Rollback Detection Tests (Scenario 6)
# =============================================================================

@test "phase set detects rollback to lower-order phase" {
    create_phase_fixture "core" "active"
    # Update setup to have lower order and make core active
    jq '.project.phases.core.status = "active" | .project.phases.core.startedAt = "2025-12-01T10:00:00Z"' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Set current phase to core (order 2), try to go back to setup (order 1)
    run bash "$PHASE_SCRIPT" --human set setup
    assert_failure
    assert_output --partial "rollback"
    assert_output --partial "--rollback flag"
}

@test "phase set allows rollback with --rollback flag" {
    create_phase_fixture "core" "active"
    jq '.project.phases.core.status = "active" | .project.currentPhase = "core"' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$PHASE_SCRIPT" --human set setup --rollback --force
    assert_success

    # Verify phase changed
    local current_phase
    current_phase=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [[ "$current_phase" == "setup" ]]
}

@test "phase set rollback requires confirmation in interactive mode" {
    create_phase_fixture "core" "active"
    jq '.project.phases.core.status = "active" | .project.currentPhase = "core"' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Without --force, should prompt (but in non-interactive, should fail)
    run bash "$PHASE_SCRIPT" --json set setup --rollback
    assert_failure
    assert_output --partial "E_PHASE_ROLLBACK_REQUIRES_FORCE"
}

# =============================================================================
# Phase Advance --force Tests (Scenario 4)
# =============================================================================

@test "phase advance blocks with incomplete tasks" {
    create_phase_fixture "setup" "active"
    # Add an incomplete task in setup phase
    jq '.tasks += [{"id": "T001", "title": "Test task", "status": "pending", "phase": "setup", "priority": "medium"}]' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$PHASE_SCRIPT" --human advance
    assert_failure
    assert_output --partial "Cannot advance"
    assert_output --partial "incomplete"
}

@test "phase advance --force skips incomplete task check" {
    create_phase_fixture "setup" "active"
    # Add an incomplete task in setup phase
    jq '.tasks += [{"id": "T001", "title": "Test task", "status": "pending", "phase": "setup", "priority": "medium"}]' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$PHASE_SCRIPT" --human advance --force
    assert_success

    # Verify advanced to core
    local current_phase
    current_phase=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [[ "$current_phase" == "core" ]]
}

@test "phase advance blocks on critical tasks even with --force" {
    create_phase_fixture "setup" "active"
    # Add a critical incomplete task
    jq '.tasks += [{"id": "T001", "title": "Critical task", "status": "pending", "phase": "setup", "priority": "critical"}]' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$PHASE_SCRIPT" --human advance --force
    assert_failure
    assert_output --partial "critical"
}

# =============================================================================
# Phase Rename Tests (Scenario 7)
# =============================================================================

@test "phase rename updates phase definition" {
    create_phase_fixture "setup" "active"

    run bash "$PHASE_SCRIPT" --human rename setup foundation
    assert_success
    assert_output --partial "renamed successfully"

    # Verify old phase gone, new phase exists
    local old_exists new_exists
    old_exists=$(jq -r '.project.phases.setup // "null"' "$TODO_FILE")
    new_exists=$(jq -r '.project.phases.foundation.name' "$TODO_FILE")
    [[ "$old_exists" == "null" ]]
    [[ "$new_exists" == "Setup & Foundation" ]]
}

@test "phase rename updates all task references" {
    create_phase_fixture "setup" "active"
    # Add tasks with setup phase
    jq '.tasks = [
        {"id": "T001", "title": "Task 1", "status": "pending", "phase": "setup"},
        {"id": "T002", "title": "Task 2", "status": "done", "phase": "setup"},
        {"id": "T003", "title": "Task 3", "status": "active", "phase": "core"}
    ]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$PHASE_SCRIPT" --human rename setup foundation
    assert_success

    # Verify task phases updated
    local setup_count foundation_count core_count
    setup_count=$(jq '[.tasks[] | select(.phase == "setup")] | length' "$TODO_FILE")
    foundation_count=$(jq '[.tasks[] | select(.phase == "foundation")] | length' "$TODO_FILE")
    core_count=$(jq '[.tasks[] | select(.phase == "core")] | length' "$TODO_FILE")
    [[ "$setup_count" == "0" ]]
    [[ "$foundation_count" == "2" ]]
    [[ "$core_count" == "1" ]]
}

@test "phase rename updates currentPhase" {
    create_phase_fixture "setup" "active"

    bash "$PHASE_SCRIPT" rename setup foundation

    local current_phase
    current_phase=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [[ "$current_phase" == "foundation" ]]
}

@test "phase rename rejects duplicate name" {
    create_phase_fixture "setup" "active"

    run bash "$PHASE_SCRIPT" --human rename setup core
    assert_failure
    assert_output --partial "already exists"
}

@test "phase rename rejects non-existent phase" {
    create_phase_fixture "setup" "active"

    run bash "$PHASE_SCRIPT" --human rename nonexistent newname
    assert_failure
    assert_output --partial "does not exist"
}

@test "phase rename validates new name format" {
    create_phase_fixture "setup" "active"

    run bash "$PHASE_SCRIPT" --human rename setup "Invalid Name"
    assert_failure
    assert_output --partial "Invalid phase name"
}

# =============================================================================
# Phase Delete Tests (Scenario 7)
# =============================================================================

@test "phase delete requires --force flag" {
    create_phase_fixture "core" "active"
    jq '.project.currentPhase = "core"' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$PHASE_SCRIPT" --human delete setup
    assert_failure
    assert_output --partial "--force"
}

@test "phase delete removes empty phase" {
    create_phase_fixture "core" "active"
    jq '.project.currentPhase = "core"' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$PHASE_SCRIPT" --human delete polish --force
    assert_success
    assert_output --partial "deleted"

    # Verify phase removed
    local phase_exists
    phase_exists=$(jq -r '.project.phases.polish // "null"' "$TODO_FILE")
    [[ "$phase_exists" == "null" ]]
}

@test "phase delete blocks when tasks exist without reassignment" {
    create_phase_fixture "core" "active"
    jq '.project.currentPhase = "core" | .tasks = [
        {"id": "T001", "title": "Task", "status": "pending", "phase": "setup"}
    ]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$PHASE_SCRIPT" --human delete setup --force
    assert_failure
    assert_output --partial "orphaned"
    assert_output --partial "--reassign-to"
}

@test "phase delete with --reassign-to moves tasks" {
    create_phase_fixture "core" "active"
    jq '.project.currentPhase = "core" | .tasks = [
        {"id": "T001", "title": "Task 1", "status": "pending", "phase": "setup"},
        {"id": "T002", "title": "Task 2", "status": "done", "phase": "setup"}
    ]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$PHASE_SCRIPT" --human delete setup --reassign-to core --force
    assert_success

    # Verify tasks moved to core
    local core_count
    core_count=$(jq '[.tasks[] | select(.phase == "core")] | length' "$TODO_FILE")
    [[ "$core_count" == "2" ]]

    # Verify setup phase removed
    local phase_exists
    phase_exists=$(jq -r '.project.phases.setup // "null"' "$TODO_FILE")
    [[ "$phase_exists" == "null" ]]
}

@test "phase delete rejects deleting current phase" {
    create_phase_fixture "setup" "active"

    run bash "$PHASE_SCRIPT" --human delete setup --force
    assert_failure
    assert_output --partial "current project phase"
}

@test "phase delete validates reassign target exists" {
    create_phase_fixture "core" "active"
    jq '.project.currentPhase = "core" | .tasks = [
        {"id": "T001", "title": "Task", "status": "pending", "phase": "setup"}
    ]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$PHASE_SCRIPT" --human delete setup --reassign-to nonexistent --force
    assert_failure
    assert_output --partial "does not exist"
}
