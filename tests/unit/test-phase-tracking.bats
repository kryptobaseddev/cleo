#!/usr/bin/env bats
# =============================================================================
# test-phase-tracking.bats - Unit tests for lib/tasks/phase-tracking.sh
# =============================================================================
# Tests project-level phase tracking including status transitions, validation,
# and phase advancement logic.
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

    # Source the phase tracking library
    source "$LIB_DIR/tasks/phase-tracking.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Library Presence Tests
# =============================================================================

@test "phase tracking library exists" {
    [ -f "$LIB_DIR/tasks/phase-tracking.sh" ]
}

@test "phase tracking library is sourceable" {
    # Library already sourced in setup()
    # Verify exported functions are available
    declare -F get_current_phase >/dev/null
    declare -F start_phase >/dev/null
    declare -F complete_phase >/dev/null
}

# =============================================================================
# Test Fixtures
# =============================================================================

# Create v2.2.0 todo.json with project.phases structure
create_phase_fixture() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "_meta": {"version": "2.2.0", "checksum": "test123"},
  "project": {
    "name": "test-project",
    "currentPhase": null,
    "phases": {
      "setup": {
        "name": "Project Setup",
        "description": "Initial project configuration",
        "order": 1,
        "status": "pending"
      },
      "core": {
        "name": "Core Development",
        "description": "Main feature implementation",
        "order": 2,
        "status": "pending"
      },
      "polish": {
        "name": "Polish & Testing",
        "description": "Final refinements",
        "order": 3,
        "status": "pending"
      }
    }
  },
  "tasks": [],
  "focus": {
    "currentTask": null,
    "currentPhase": null
  },
  "lastUpdated": "2025-12-15T12:00:00Z"
}
EOF
}

# Create fixture with active phase
create_active_phase_fixture() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "_meta": {"version": "2.2.0"},
  "project": {
    "name": "test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {
        "name": "Project Setup",
        "order": 1,
        "status": "completed",
        "startedAt": "2025-12-01T10:00:00Z",
        "completedAt": "2025-12-05T16:00:00Z"
      },
      "core": {
        "name": "Core Development",
        "order": 2,
        "status": "active",
        "startedAt": "2025-12-05T16:00:00Z"
      },
      "polish": {
        "name": "Polish & Testing",
        "order": 3,
        "status": "pending"
      }
    }
  },
  "tasks": [],
  "focus": {
    "currentTask": null,
    "currentPhase": "core"
  },
  "lastUpdated": "2025-12-05T16:00:00Z"
}
EOF
}

# Create fixture with multiple active phases (invalid state)
create_multi_active_phases() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "_meta": {"version": "2.2.0"},
  "project": {
    "currentPhase": "core",
    "phases": {
      "setup": {
        "order": 1,
        "status": "active",
        "startedAt": "2025-12-01T10:00:00Z"
      },
      "core": {
        "order": 2,
        "status": "active",
        "startedAt": "2025-12-05T16:00:00Z"
      }
    }
  },
  "tasks": [],
  "focus": {},
  "lastUpdated": "2025-12-05T16:00:00Z"
}
EOF
}

# Create fixture with completed project (all phases done)
create_completed_phases() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "_meta": {"version": "2.2.0"},
  "project": {
    "currentPhase": null,
    "phases": {
      "setup": {
        "order": 1,
        "status": "completed",
        "completedAt": "2025-12-01T10:00:00Z"
      },
      "core": {
        "order": 2,
        "status": "completed",
        "completedAt": "2025-12-05T16:00:00Z"
      },
      "polish": {
        "order": 3,
        "status": "completed",
        "completedAt": "2025-12-10T12:00:00Z"
      }
    }
  },
  "tasks": [],
  "focus": {},
  "lastUpdated": "2025-12-10T12:00:00Z"
}
EOF
}

# =============================================================================
# get_current_phase Tests
# =============================================================================

@test "get_current_phase returns current phase" {
    create_active_phase_fixture
    run get_current_phase "$TODO_FILE"
    assert_success
    assert_output "core"
}

@test "get_current_phase returns empty when no phase set" {
    create_phase_fixture
    run get_current_phase "$TODO_FILE"
    assert_success
    assert_output ""
}

@test "get_current_phase handles null currentPhase" {
    create_completed_phases
    run get_current_phase "$TODO_FILE"
    assert_success
    assert_output ""
}

# =============================================================================
# get_all_phases Tests
# =============================================================================

@test "get_all_phases returns phases object" {
    create_phase_fixture
    run get_all_phases "$TODO_FILE"
    assert_success

    # Validate it's a JSON object
    echo "$output" | jq -e 'type == "object"'
}

@test "get_all_phases includes all phase slugs" {
    create_phase_fixture
    local phases
    phases=$(get_all_phases "$TODO_FILE")

    echo "$phases" | jq -e '.setup'
    echo "$phases" | jq -e '.core'
    echo "$phases" | jq -e '.polish'
}

@test "get_all_phases returns empty object when no phases" {
    create_empty_todo
    run get_all_phases "$TODO_FILE"
    assert_success
    [ "$(echo "$output" | jq -r 'type')" = "object" ]
}

# =============================================================================
# get_phase Tests
# =============================================================================

@test "get_phase returns phase details" {
    create_phase_fixture
    run get_phase "setup" "$TODO_FILE"
    assert_success

    local name
    name=$(echo "$output" | jq -r '.name')
    [ "$name" = "Project Setup" ]
}

@test "get_phase returns null for non-existent phase" {
    create_phase_fixture
    run get_phase "nonexistent" "$TODO_FILE"
    assert_success
    assert_output "null"
}

@test "get_phase includes status field" {
    create_active_phase_fixture
    local phase
    phase=$(get_phase "core" "$TODO_FILE")

    local status
    status=$(echo "$phase" | jq -r '.status')
    [ "$status" = "active" ]
}

# =============================================================================
# get_phase_status Tests
# =============================================================================

@test "get_phase_status returns current status" {
    create_active_phase_fixture
    run get_phase_status "core" "$TODO_FILE"
    assert_success
    assert_output "active"
}

@test "get_phase_status returns pending for new phase" {
    create_phase_fixture
    run get_phase_status "setup" "$TODO_FILE"
    assert_success
    assert_output "pending"
}

@test "get_phase_status returns completed for done phase" {
    create_active_phase_fixture
    run get_phase_status "setup" "$TODO_FILE"
    assert_success
    assert_output "completed"
}

@test "get_phase_status defaults to pending for missing status" {
    create_phase_fixture
    run get_phase_status "core" "$TODO_FILE"
    assert_success
    assert_output "pending"
}

# =============================================================================
# count_phases_by_status Tests
# =============================================================================

@test "count_phases_by_status counts pending phases" {
    create_phase_fixture
    run count_phases_by_status "pending" "$TODO_FILE"
    assert_success
    assert_output "3"
}

@test "count_phases_by_status counts active phases" {
    create_active_phase_fixture
    run count_phases_by_status "active" "$TODO_FILE"
    assert_success
    assert_output "1"
}

@test "count_phases_by_status counts completed phases" {
    create_active_phase_fixture
    run count_phases_by_status "completed" "$TODO_FILE"
    assert_success
    assert_output "1"
}

@test "count_phases_by_status returns 0 when none match" {
    create_phase_fixture
    run count_phases_by_status "completed" "$TODO_FILE"
    assert_success
    assert_output "0"
}

# =============================================================================
# set_current_phase Tests
# =============================================================================

@test "set_current_phase sets currentPhase" {
    create_phase_fixture
    run set_current_phase "setup" "$TODO_FILE"
    assert_success

    local current
    current=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [ "$current" = "setup" ]
}

@test "set_current_phase updates focus.currentPhase" {
    create_phase_fixture
    set_current_phase "setup" "$TODO_FILE"

    local focus_phase
    focus_phase=$(jq -r '.focus.currentPhase' "$TODO_FILE")
    [ "$focus_phase" = "setup" ]
}

@test "set_current_phase fails for non-existent phase" {
    create_phase_fixture
    run set_current_phase "nonexistent" "$TODO_FILE"
    assert_failure
    assert_output --partial "does not exist"
}

@test "set_current_phase updates lastUpdated timestamp" {
    create_phase_fixture
    local before
    before=$(jq -r '.lastUpdated' "$TODO_FILE")

    sleep 1
    set_current_phase "setup" "$TODO_FILE"

    local after
    after=$(jq -r '.lastUpdated' "$TODO_FILE")
    [ "$before" != "$after" ]
}

# =============================================================================
# start_phase Tests
# =============================================================================

@test "start_phase transitions pending to active" {
    create_phase_fixture
    run start_phase "setup" "$TODO_FILE"
    assert_success

    local status
    status=$(get_phase_status "setup" "$TODO_FILE")
    [ "$status" = "active" ]
}

@test "start_phase sets startedAt timestamp" {
    create_phase_fixture
    start_phase "setup" "$TODO_FILE"

    local started_at
    started_at=$(jq -r '.project.phases.setup.startedAt' "$TODO_FILE")
    [ -n "$started_at" ]
    [ "$started_at" != "null" ]
}

@test "start_phase updates currentPhase" {
    create_phase_fixture
    start_phase "setup" "$TODO_FILE"

    local current
    current=$(get_current_phase "$TODO_FILE")
    [ "$current" = "setup" ]
}

@test "start_phase updates focus.currentPhase" {
    create_phase_fixture
    start_phase "setup" "$TODO_FILE"

    local focus_phase
    focus_phase=$(jq -r '.focus.currentPhase' "$TODO_FILE")
    [ "$focus_phase" = "setup" ]
}

@test "start_phase fails if phase not pending" {
    create_active_phase_fixture
    run start_phase "core" "$TODO_FILE"
    assert_failure
    assert_output --partial "Can only start pending phases"
}

@test "start_phase fails for completed phase" {
    create_active_phase_fixture
    run start_phase "setup" "$TODO_FILE"
    assert_failure
    assert_output --partial "pending"
}

# =============================================================================
# complete_phase Tests
# =============================================================================

@test "complete_phase transitions active to completed" {
    create_active_phase_fixture
    run complete_phase "core" "$TODO_FILE"
    assert_success

    local status
    status=$(get_phase_status "core" "$TODO_FILE")
    [ "$status" = "completed" ]
}

@test "complete_phase sets completedAt timestamp" {
    create_active_phase_fixture
    complete_phase "core" "$TODO_FILE"

    local completed_at
    completed_at=$(jq -r '.project.phases.core.completedAt' "$TODO_FILE")
    [ -n "$completed_at" ]
    [ "$completed_at" != "null" ]
}

@test "complete_phase fails if phase not active" {
    create_phase_fixture
    run complete_phase "setup" "$TODO_FILE"
    assert_failure
    assert_output --partial "Can only complete active phases"
}

@test "complete_phase fails for pending phase" {
    create_phase_fixture
    run complete_phase "core" "$TODO_FILE"
    assert_failure
    assert_output --partial "active"
}

@test "complete_phase updates lastUpdated" {
    create_active_phase_fixture
    local before
    before=$(jq -r '.lastUpdated' "$TODO_FILE")

    sleep 1
    complete_phase "core" "$TODO_FILE"

    local after
    after=$(jq -r '.lastUpdated' "$TODO_FILE")
    [ "$before" != "$after" ]
}

# =============================================================================
# advance_phase Tests
# =============================================================================

@test "advance_phase completes current and starts next" {
    # Create fixture with setup as active
    create_phase_fixture
    start_phase "setup" "$TODO_FILE"

    run advance_phase "$TODO_FILE"
    assert_success
    assert_output --partial "Advanced from 'setup' to 'core'"

    # Verify setup is completed
    local setup_status
    setup_status=$(get_phase_status "setup" "$TODO_FILE")
    [ "$setup_status" = "completed" ]

    # Verify core is active
    local core_status
    core_status=$(get_phase_status "core" "$TODO_FILE")
    [ "$core_status" = "active" ]

    # Verify currentPhase is updated
    local current
    current=$(get_current_phase "$TODO_FILE")
    [ "$current" = "core" ]
}

@test "advance_phase finds next phase by order" {
    create_phase_fixture
    start_phase "setup" "$TODO_FILE"

    advance_phase "$TODO_FILE"

    local current
    current=$(get_current_phase "$TODO_FILE")
    [ "$current" = "core" ]
}

@test "advance_phase fails when no current phase" {
    create_phase_fixture
    run advance_phase "$TODO_FILE"
    assert_failure
    assert_output --partial "No current phase"
}

@test "advance_phase fails when no next phase exists" {
    create_phase_fixture
    start_phase "polish" "$TODO_FILE"

    run advance_phase "$TODO_FILE"
    assert_failure
    assert_output --partial "No more phases"
}

@test "advance_phase follows order field" {
    # Ensure phases are advanced in order: 1 -> 2 -> 3
    create_phase_fixture
    start_phase "setup" "$TODO_FILE"
    advance_phase "$TODO_FILE"

    local current
    current=$(get_current_phase "$TODO_FILE")
    [ "$current" = "core" ]

    advance_phase "$TODO_FILE"
    current=$(get_current_phase "$TODO_FILE")
    [ "$current" = "polish" ]
}

# =============================================================================
# validate_single_active_phase Tests
# =============================================================================

@test "validate_single_active_phase passes with one active" {
    create_active_phase_fixture
    run validate_single_active_phase "$TODO_FILE"
    assert_success
}

@test "validate_single_active_phase passes with zero active" {
    create_phase_fixture
    run validate_single_active_phase "$TODO_FILE"
    assert_success
}

@test "validate_single_active_phase fails with multiple active" {
    create_multi_active_phases
    run validate_single_active_phase "$TODO_FILE"
    assert_failure
    assert_output --partial "Multiple active phases"
}

@test "validate_single_active_phase reports correct count" {
    create_multi_active_phases
    run validate_single_active_phase "$TODO_FILE"
    assert_failure
    assert_output --partial "2"
}

# =============================================================================
# validate_current_phase_consistency Tests
# =============================================================================

@test "validate_current_phase_consistency passes when current is active" {
    create_active_phase_fixture
    run validate_current_phase_consistency "$TODO_FILE"
    assert_success
}

@test "validate_current_phase_consistency passes when no current phase" {
    create_phase_fixture
    run validate_current_phase_consistency "$TODO_FILE"
    assert_success
}

@test "validate_current_phase_consistency fails when current is not active" {
    create_phase_fixture
    set_current_phase "setup" "$TODO_FILE"
    # currentPhase is set but phase status is still pending

    run validate_current_phase_consistency "$TODO_FILE"
    assert_failure
    assert_output --partial "expected 'active'"
}

@test "validate_current_phase_consistency fails when current is completed" {
    create_active_phase_fixture
    complete_phase "core" "$TODO_FILE"
    # currentPhase is still 'core' but status is now 'completed'

    run validate_current_phase_consistency "$TODO_FILE"
    assert_failure
    assert_output --partial "expected 'active'"
}

# =============================================================================
# Phase Validation Config Tests
# =============================================================================

@test "get_phase_validation_config returns defaults when no config" {
    rm -f "$CONFIG_FILE"
    run get_phase_validation_config
    assert_success
    assert_output --partial '"warnPhaseContext": false'
    assert_output --partial '"enforcePhaseOrder": false'
}

@test "get_phase_validation_config reads warnPhaseContext from config" {
    echo '{"validation":{"phaseValidation":{"warnPhaseContext":true}}}' > "$CONFIG_FILE"
    run get_phase_validation_config
    assert_success
    assert_output --partial '"warnPhaseContext": true'
}

@test "get_phase_validation_config reads enforcePhaseOrder from config" {
    echo '{"validation":{"phaseValidation":{"enforcePhaseOrder":true}}}' > "$CONFIG_FILE"
    run get_phase_validation_config
    assert_success
    assert_output --partial '"enforcePhaseOrder": true'
}

@test "is_phase_warning_enabled returns false by default" {
    rm -f "$CONFIG_FILE"
    run is_phase_warning_enabled
    assert_failure  # Returns non-zero when disabled
}

@test "is_phase_warning_enabled returns true when config enabled" {
    echo '{"validation":{"phaseValidation":{"warnPhaseContext":true}}}' > "$CONFIG_FILE"
    run is_phase_warning_enabled
    assert_success  # Returns zero when enabled
}

@test "is_phase_warning_enabled returns false when config explicitly disabled" {
    echo '{"validation":{"phaseValidation":{"warnPhaseContext":false}}}' > "$CONFIG_FILE"
    run is_phase_warning_enabled
    assert_failure  # Returns non-zero when disabled
}

# =============================================================================
# check_phase_context Tests
# =============================================================================

@test "check_phase_context passes when phases match with warnings enabled" {
    create_active_phase_fixture
    echo '{"validation":{"phaseValidation":{"warnPhaseContext":true}}}' > "$CONFIG_FILE"
    run check_phase_context "core" "$TODO_FILE"
    assert_success
}

@test "check_phase_context warns when phases differ and warnings enabled" {
    create_active_phase_fixture
    echo '{"validation":{"phaseValidation":{"warnPhaseContext":true}}}' > "$CONFIG_FILE"
    run check_phase_context "setup" "$TODO_FILE"
    assert_failure
    assert_output --partial "WARN"
    assert_output --partial "differs from"
}

@test "check_phase_context silent when warnPhaseContext disabled" {
    create_active_phase_fixture
    # Ensure no config (defaults to disabled)
    rm -f "$CONFIG_FILE"
    run check_phase_context "setup" "$TODO_FILE"
    assert_success  # Should pass silently even with mismatch
    refute_output --partial "WARN"
}

@test "check_phase_context silent with explicit warnPhaseContext false" {
    create_active_phase_fixture
    echo '{"validation":{"phaseValidation":{"warnPhaseContext":false}}}' > "$CONFIG_FILE"
    run check_phase_context "setup" "$TODO_FILE"
    assert_success  # Should pass silently even with mismatch
    refute_output --partial "WARN"
}

@test "check_phase_context passes when no project phase" {
    create_phase_fixture
    echo '{"validation":{"phaseValidation":{"warnPhaseContext":true}}}' > "$CONFIG_FILE"
    run check_phase_context "setup" "$TODO_FILE"
    assert_success
}

@test "check_phase_context passes when no task phase" {
    create_active_phase_fixture
    echo '{"validation":{"phaseValidation":{"warnPhaseContext":true}}}' > "$CONFIG_FILE"
    run check_phase_context "" "$TODO_FILE"
    assert_success
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "full phase lifecycle: start -> complete -> advance" {
    create_phase_fixture

    # Start setup phase
    start_phase "setup" "$TODO_FILE"
    local status
    status=$(get_phase_status "setup" "$TODO_FILE")
    [ "$status" = "active" ]

    # Advance to core (completes setup, starts core)
    advance_phase "$TODO_FILE"
    status=$(get_phase_status "setup" "$TODO_FILE")
    [ "$status" = "completed" ]
    status=$(get_phase_status "core" "$TODO_FILE")
    [ "$status" = "active" ]

    # Advance to polish
    advance_phase "$TODO_FILE"
    status=$(get_phase_status "polish" "$TODO_FILE")
    [ "$status" = "active" ]

    # Complete polish
    complete_phase "polish" "$TODO_FILE"
    status=$(get_phase_status "polish" "$TODO_FILE")
    [ "$status" = "completed" ]
}

@test "phase transitions maintain JSON validity" {
    create_phase_fixture

    start_phase "setup" "$TODO_FILE"
    run jq empty "$TODO_FILE"
    assert_success

    advance_phase "$TODO_FILE"
    run jq empty "$TODO_FILE"
    assert_success

    complete_phase "core" "$TODO_FILE"
    run jq empty "$TODO_FILE"
    assert_success
}

@test "phase operations preserve other data" {
    create_phase_fixture

    # Add task data
    jq '.tasks += [{"id": "T001", "title": "Test"}]' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    start_phase "setup" "$TODO_FILE"

    # Verify task still exists
    local task_count
    task_count=$(jq '.tasks | length' "$TODO_FILE")
    [ "$task_count" -eq 1 ]
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "handles empty phases object gracefully" {
    create_empty_todo
    # Add minimal project structure with no phases
    jq '.project = {"phases": {}}' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run get_all_phases "$TODO_FILE"
    assert_success
    assert_output "{}"
}

@test "handles missing project.phases field" {
    # Create todo without project.phases field (legacy v2.1 format)
    create_empty_todo_legacy
    run get_all_phases "$TODO_FILE"
    assert_success
    assert_output "{}"
}

@test "phase status validation enforces enum" {
    # Valid statuses: pending, active, completed
    create_phase_fixture

    # Valid statuses work
    for status in "pending" "active" "completed"; do
        local count
        count=$(count_phases_by_status "$status" "$TODO_FILE")
        [[ "$count" =~ ^[0-9]+$ ]]
    done
}

@test "timestamps are ISO 8601 format" {
    create_phase_fixture
    start_phase "setup" "$TODO_FILE"

    local timestamp
    timestamp=$(jq -r '.project.phases.setup.startedAt' "$TODO_FILE")

    # Basic ISO 8601 check (YYYY-MM-DDTHH:MM:SSZ)
    [[ "$timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

@test "phase names are preserved across operations" {
    create_phase_fixture
    local original_name
    original_name=$(jq -r '.project.phases.setup.name' "$TODO_FILE")

    start_phase "setup" "$TODO_FILE"
    complete_phase "setup" "$TODO_FILE"

    local final_name
    final_name=$(jq -r '.project.phases.setup.name' "$TODO_FILE")
    [ "$original_name" = "$final_name" ]
}

# =============================================================================
# Error Handling
# =============================================================================

@test "functions fail gracefully with missing file" {
    rm -f "$TODO_FILE"

    run get_current_phase "$TODO_FILE"
    assert_failure
}

@test "functions handle malformed JSON" {
    echo "invalid json" > "$TODO_FILE"

    run get_current_phase "$TODO_FILE"
    assert_failure
}

@test "set_current_phase validates phase exists before writing" {
    create_phase_fixture
    local original
    original=$(cat "$TODO_FILE")

    run set_current_phase "invalid-phase" "$TODO_FILE"
    assert_failure

    # File should be unchanged after failed operation
    local after
    after=$(cat "$TODO_FILE")
    [ "$original" = "$after" ]
}
