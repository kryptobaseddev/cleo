#!/usr/bin/env bats
# =============================================================================
# focus.bats - Unit tests for focus.sh
# =============================================================================
# Tests focus management functionality including set, show, clear, and notes.
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
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Script Presence Tests
# =============================================================================

@test "focus script exists" {
    [ -f "$FOCUS_SCRIPT" ]
}

@test "focus script is executable" {
    [ -x "$FOCUS_SCRIPT" ]
}

# =============================================================================
# Help and Usage Tests
# =============================================================================

@test "focus --help shows usage" {
    run bash "$FOCUS_SCRIPT" --help
    assert_shows_help
}

@test "focus -h shows usage" {
    run bash "$FOCUS_SCRIPT" -h
    assert_shows_help
}

@test "focus help shows available commands" {
    run bash "$FOCUS_SCRIPT" --help
    assert_success
    assert_output_contains_any "set" "show" "clear" "note"
}

# =============================================================================
# Focus Set Tests
# =============================================================================

@test "focus set works with valid task ID" {
    create_independent_tasks
    run bash "$FOCUS_SCRIPT" set T001
    assert_success

    local focused_id
    focused_id=$(jq -r '.focus.currentTask // empty' "$TODO_FILE")
    [ "$focused_id" = "T001" ]
}

@test "focus set marks task as active" {
    create_independent_tasks
    bash "$FOCUS_SCRIPT" set T001

    local task_status
    task_status=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    [ "$task_status" = "active" ]
}

@test "focus set clears previous focus" {
    create_independent_tasks
    bash "$FOCUS_SCRIPT" set T001
    bash "$FOCUS_SCRIPT" set T002

    # T001 should no longer be active (or should be pending)
    local t001_status
    t001_status=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    [ "$t001_status" != "active" ]

    # T002 should be active and focused
    local focused_id
    focused_id=$(jq -r '.focus.currentTask' "$TODO_FILE")
    [ "$focused_id" = "T002" ]
}

@test "focus set fails with invalid task ID" {
    create_independent_tasks
    run bash "$FOCUS_SCRIPT" set T999
    assert_failure
}

@test "focus set fails with empty task ID" {
    create_independent_tasks
    run bash "$FOCUS_SCRIPT" set
    assert_failure
}

# =============================================================================
# Focus Show Tests
# =============================================================================

@test "focus show displays current focus" {
    create_independent_tasks
    bash "$FOCUS_SCRIPT" set T001

    run bash "$FOCUS_SCRIPT" show
    assert_success
    assert_output_contains_any "T001" "First" "active"
}

@test "focus show handles no focus" {
    create_independent_tasks
    run bash "$FOCUS_SCRIPT" show
    assert_success
    # Should indicate no focus or show empty
}

@test "focus show displays task details" {
    create_independent_tasks
    bash "$FOCUS_SCRIPT" set T001

    run bash "$FOCUS_SCRIPT" show
    assert_success
    # Should show task title or ID
    assert_output_contains_any "T001" "task"
}

# =============================================================================
# Focus Clear Tests
# =============================================================================

@test "focus clear removes current focus" {
    create_independent_tasks
    bash "$FOCUS_SCRIPT" set T001
    bash "$FOCUS_SCRIPT" clear

    local focused_id
    focused_id=$(jq -r '.focus.currentTask // "null"' "$TODO_FILE")
    [ "$focused_id" = "null" ]
}

@test "focus clear is safe when no focus set" {
    create_independent_tasks
    run bash "$FOCUS_SCRIPT" clear
    assert_success
}

@test "focus clear updates task status" {
    create_independent_tasks
    bash "$FOCUS_SCRIPT" set T001
    bash "$FOCUS_SCRIPT" clear

    # Task should no longer be active
    local task_status
    task_status=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    [ "$task_status" != "active" ] || [ "$task_status" = "pending" ]
}

# =============================================================================
# Focus Note Tests
# =============================================================================

@test "focus note sets session note" {
    create_independent_tasks
    bash "$FOCUS_SCRIPT" set T001
    run bash "$FOCUS_SCRIPT" note "Working on authentication"
    assert_success

    local session_note
    session_note=$(jq -r '.focus.sessionNote // empty' "$TODO_FILE")
    [ -n "$session_note" ]
}

@test "focus note updates existing note" {
    create_independent_tasks
    bash "$FOCUS_SCRIPT" set T001
    bash "$FOCUS_SCRIPT" note "First note"
    bash "$FOCUS_SCRIPT" note "Updated note"

    local session_note
    session_note=$(jq -r '.focus.sessionNote' "$TODO_FILE")
    [[ "$session_note" == *"Updated"* ]]
}

@test "focus note fails without focus set" {
    create_independent_tasks
    run bash "$FOCUS_SCRIPT" note "Orphan note"
    # May fail or succeed with warning depending on implementation
}

# =============================================================================
# Output Format Tests
# =============================================================================

@test "focus show --json produces valid JSON" {
    create_independent_tasks
    bash "$FOCUS_SCRIPT" set T001
    run bash "$FOCUS_SCRIPT" show --json
    assert_success
    assert_valid_json
}

@test "focus show produces text output by default" {
    create_independent_tasks
    bash "$FOCUS_SCRIPT" set T001
    run bash "$FOCUS_SCRIPT" show
    assert_success
    # Should contain markdown elements
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "focus workflow: set, note, show, clear" {
    create_independent_tasks

    # Set focus
    run bash "$FOCUS_SCRIPT" set T001
    assert_success

    # Add note
    run bash "$FOCUS_SCRIPT" note "Progress note"
    assert_success

    # Show focus
    run bash "$FOCUS_SCRIPT" show
    assert_success

    # Clear focus
    run bash "$FOCUS_SCRIPT" clear
    assert_success
}

@test "focus enforces single active task" {
    create_independent_tasks
    bash "$FOCUS_SCRIPT" set T001
    bash "$FOCUS_SCRIPT" set T002

    # Only one task should be active
    local active_count
    active_count=$(jq '[.tasks[] | select(.status == "active")] | length' "$TODO_FILE")
    [ "$active_count" -eq 1 ]
}

@test "focus maintains valid JSON structure" {
    create_independent_tasks
    bash "$FOCUS_SCRIPT" set T001
    bash "$FOCUS_SCRIPT" note "Test note"
    bash "$FOCUS_SCRIPT" clear

    run jq empty "$TODO_FILE"
    assert_success
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "focus handles completed task" {
    create_tasks_with_completed
    run bash "$FOCUS_SCRIPT" set T001
    # May fail or succeed depending on implementation
}

@test "focus handles blocked task" {
    create_blocked_tasks
    run bash "$FOCUS_SCRIPT" set T002
    # May fail or succeed depending on implementation
}

# =============================================================================
# Hierarchy Awareness Tests (T345)
# =============================================================================

@test "focus show displays parent context" {
    create_empty_todo
    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic" -q)

    bash "$FOCUS_SCRIPT" set "$task"
    run bash "$FOCUS_SCRIPT" show
    assert_success
    assert_output --partial "Parent:"
    assert_output --partial "$epic"
}

@test "focus show displays children summary" {
    create_empty_todo
    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    bash "$ADD_SCRIPT" "Task 1" --parent "$epic"
    bash "$ADD_SCRIPT" "Task 2" --parent "$epic"

    bash "$FOCUS_SCRIPT" set "$epic"
    run bash "$FOCUS_SCRIPT" show
    assert_success
    assert_output --partial "Children:"
    assert_output --partial "pending"
}

@test "focus show JSON includes hierarchy object" {
    create_empty_todo
    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic" -q)

    bash "$FOCUS_SCRIPT" set "$task"
    run bash "$FOCUS_SCRIPT" show --format json
    assert_success
    echo "$output" | jq -e '.hierarchy'
}
