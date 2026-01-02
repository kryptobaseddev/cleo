#!/usr/bin/env bats
# hierarchy-automation.bats - Integration tests for Hierarchy Phase 2
# Tests: T340 (auto-complete), T341 (orphan detection), T342 (tree command)

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    load '../test_helper/assertions'
    common_setup_per_test

    # Create empty todo.json file for the tests
    create_empty_todo
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Parent Auto-Complete Integration Tests (T340)
# =============================================================================

@test "integration: completing all children auto-completes parent epic" {
    # Create epic with 3 children
    local epic_id=$(bash "$ADD_SCRIPT" "Feature Epic" --type epic -q)
    local t1=$(bash "$ADD_SCRIPT" "Task 1" --parent "$epic_id" -q)
    local t2=$(bash "$ADD_SCRIPT" "Task 2" --parent "$epic_id" -q)
    local t3=$(bash "$ADD_SCRIPT" "Task 3" --parent "$epic_id" -q)

    # Enable auto-complete and disable verification requirement (T1160)
    # This test focuses on hierarchy auto-complete, not verification gates
    jq '.hierarchy.autoCompleteParent = true | .hierarchy.autoCompleteMode = "auto" | .verification.requireForParentAutoComplete = false' "$CONFIG_FILE" > tmp && mv tmp "$CONFIG_FILE"

    # Complete all children
    bash "$COMPLETE_SCRIPT" "$t1" --skip-notes
    bash "$COMPLETE_SCRIPT" "$t2" --skip-notes
    run bash "$COMPLETE_SCRIPT" "$t3" --skip-notes
    assert_success

    # Epic should be auto-completed
    local epic_status=$(jq -r --arg id "$epic_id" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
    [[ "$epic_status" == "done" ]]
}

@test "integration: nested hierarchy auto-completes correctly" {
    # Create: epic -> task -> subtask
    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic" -q)
    local subtask=$(bash "$ADD_SCRIPT" "Subtask" --parent "$task" --type subtask -q)

    # Enable auto-complete and disable verification requirement (T1160)
    jq '.hierarchy.autoCompleteParent = true | .hierarchy.autoCompleteMode = "auto" | .verification.requireForParentAutoComplete = false' "$CONFIG_FILE" > tmp && mv tmp "$CONFIG_FILE"

    # Complete subtask - should auto-complete task, then epic
    run bash "$COMPLETE_SCRIPT" "$subtask" --skip-notes
    assert_success

    # Both task and epic should be done
    local task_status=$(jq -r --arg id "$task" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
    local epic_status=$(jq -r --arg id "$epic" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")

    [[ "$task_status" == "done" ]]
    [[ "$epic_status" == "done" ]]
}

@test "integration: auto-complete respects configuration modes" {
    # Test off mode - create fresh tasks
    local epic_off=$(bash "$ADD_SCRIPT" "Epic Off" --type epic -q)
    local task_off=$(bash "$ADD_SCRIPT" "Task Off" --parent "$epic_off" -q)

    jq '.hierarchy.autoCompleteParent = true | .hierarchy.autoCompleteMode = "off"' "$CONFIG_FILE" > tmp && mv tmp "$CONFIG_FILE"
    bash "$COMPLETE_SCRIPT" "$task_off" --skip-notes
    
    local epic_status=$(jq -r --arg id "$epic_off" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
    [[ "$epic_status" != "done" ]]

    # Test auto mode - create fresh tasks (disable verification requirement for this test)
    local epic_auto=$(bash "$ADD_SCRIPT" "Epic Auto" --type epic -q)
    local task_auto=$(bash "$ADD_SCRIPT" "Task Auto" --parent "$epic_auto" -q)

    jq '.hierarchy.autoCompleteMode = "auto" | .verification.requireForParentAutoComplete = false' "$CONFIG_FILE" > tmp && mv tmp "$CONFIG_FILE"
    run bash "$COMPLETE_SCRIPT" "$task_auto" --skip-notes
    assert_success

    epic_status=$(jq -r --arg id "$epic_auto" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
    [[ "$epic_status" == "done" ]]
}

@test "integration: T1160 - parent auto-complete blocked when children not verified" {
    # Create epic with children
    local epic=$(bash "$ADD_SCRIPT" "Verification Epic" --type epic -q)
    local t1=$(bash "$ADD_SCRIPT" "Task 1" --parent "$epic" -q)
    local t2=$(bash "$ADD_SCRIPT" "Task 2" --parent "$epic" -q)

    # Enable auto-complete WITH verification requirement (default)
    jq '.hierarchy.autoCompleteParent = true | .hierarchy.autoCompleteMode = "auto" | .verification.requireForParentAutoComplete = true' "$CONFIG_FILE" > tmp && mv tmp "$CONFIG_FILE"

    # Complete children - they will have verification.passed = false (only implemented gate set)
    bash "$COMPLETE_SCRIPT" "$t1" --skip-notes
    bash "$COMPLETE_SCRIPT" "$t2" --skip-notes

    # Epic should NOT be auto-completed because children aren't verified
    local epic_status=$(jq -r --arg id "$epic" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
    [[ "$epic_status" != "done" ]]

    # Verify children have verification.passed = false
    local t1_verified=$(jq -r --arg id "$t1" '.tasks[] | select(.id == $id) | .verification.passed' "$TODO_FILE")
    local t2_verified=$(jq -r --arg id "$t2" '.tasks[] | select(.id == $id) | .verification.passed' "$TODO_FILE")
    [[ "$t1_verified" == "false" ]]
    [[ "$t2_verified" == "false" ]]
}

@test "integration: T1160 - parent auto-completes when children are verified" {
    # Create epic with two children
    local epic=$(bash "$ADD_SCRIPT" "Verified Epic" --type epic -q)
    local t1=$(bash "$ADD_SCRIPT" "Task 1" --parent "$epic" -q)
    local t2=$(bash "$ADD_SCRIPT" "Task 2" --parent "$epic" -q)

    # Enable auto-complete WITH verification requirement
    jq '.hierarchy.autoCompleteParent = true | .hierarchy.autoCompleteMode = "auto" | .verification.requireForParentAutoComplete = true' "$CONFIG_FILE" > tmp && mv tmp "$CONFIG_FILE"

    # Complete first child - parent shouldn't auto-complete (second child pending)
    bash "$COMPLETE_SCRIPT" "$t1" --skip-notes

    # Set t1 as verified (all required gates to true)
    jq --arg id "$t1" '(.tasks[] | select(.id == $id) | .verification) |= (.passed = true | .gates.implemented = true | .gates.testsPassed = true | .gates.qaPassed = true | .gates.securityPassed = true | .gates.documented = true)' "$TODO_FILE" > tmp && mv tmp "$TODO_FILE"

    # At this point, only t1 is done+verified, t2 is still pending
    # Complete t2 - parent shouldn't auto-complete yet (t2 just got completed with passed=false)
    bash "$COMPLETE_SCRIPT" "$t2" --skip-notes

    local epic_status=$(jq -r --arg id "$epic" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
    [[ "$epic_status" != "done" ]]

    # Now set t2 as verified
    jq --arg id "$t2" '(.tasks[] | select(.id == $id) | .verification) |= (.passed = true | .gates.implemented = true | .gates.testsPassed = true | .gates.qaPassed = true | .gates.securityPassed = true | .gates.documented = true)' "$TODO_FILE" > tmp && mv tmp "$TODO_FILE"

    # Create a third child with all gates pre-set (so compute_passed returns true)
    local t3=$(bash "$ADD_SCRIPT" "Task 3" --parent "$epic" -q)

    # Pre-set ALL gates on t3 so compute_passed will return true after completion
    jq --arg id "$t3" '(.tasks[] | select(.id == $id)) |= . + {"verification": {"passed": false, "round": 0, "gates": {"implemented": true, "testsPassed": true, "qaPassed": true, "cleanupDone": true, "securityPassed": true, "documented": true}, "lastAgent": null, "lastUpdated": "2026-01-01T00:00:00Z", "failureLog": []}}' "$TODO_FILE" > tmp && mv tmp "$TODO_FILE"

    # Complete t3 - compute_passed will see all gates=true and set passed=true
    # Then auto-complete should trigger since all children are done+verified
    run bash "$COMPLETE_SCRIPT" "$t3" --skip-notes
    assert_success

    # Now epic should be auto-completed (all children done + verified)
    epic_status=$(jq -r --arg id "$epic" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
    [[ "$epic_status" == "done" ]]
}

@test "integration: T1156 - epic lifecycle transitions to review when children verified" {
    # Create epic with epicLifecycle = active
    local epic=$(bash "$ADD_SCRIPT" "Epic for Review" --type epic -q)

    # Set epicLifecycle to 'active'
    jq --arg id "$epic" '(.tasks[] | select(.id == $id)) |= . + {"epicLifecycle": "active"}' "$TODO_FILE" > tmp && mv tmp "$TODO_FILE"

    # Create two children
    local t1=$(bash "$ADD_SCRIPT" "Task 1" --parent "$epic" -q)
    local t2=$(bash "$ADD_SCRIPT" "Task 2" --parent "$epic" -q)

    # Complete first child with all gates (so passed=true)
    jq --arg id "$t1" '(.tasks[] | select(.id == $id)) |= . + {"verification": {"passed": false, "round": 0, "gates": {"implemented": true, "testsPassed": true, "qaPassed": true, "cleanupDone": true, "securityPassed": true, "documented": true}, "lastAgent": null, "lastUpdated": "2026-01-01T00:00:00Z", "failureLog": []}}' "$TODO_FILE" > tmp && mv tmp "$TODO_FILE"
    bash "$COMPLETE_SCRIPT" "$t1" --skip-notes

    # Epic should still be 'active' (not all children done+verified)
    local lifecycle=$(jq -r --arg id "$epic" '.tasks[] | select(.id == $id) | .epicLifecycle' "$TODO_FILE")
    [[ "$lifecycle" == "active" ]]

    # Complete second child with all gates (so passed=true)
    jq --arg id "$t2" '(.tasks[] | select(.id == $id)) |= . + {"verification": {"passed": false, "round": 0, "gates": {"implemented": true, "testsPassed": true, "qaPassed": true, "cleanupDone": true, "securityPassed": true, "documented": true}, "lastAgent": null, "lastUpdated": "2026-01-01T00:00:00Z", "failureLog": []}}' "$TODO_FILE" > tmp && mv tmp "$TODO_FILE"
    run bash "$COMPLETE_SCRIPT" "$t2" --skip-notes
    assert_success

    # Epic should now be 'review' (all children done+verified)
    lifecycle=$(jq -r --arg id "$epic" '.tasks[] | select(.id == $id) | .epicLifecycle' "$TODO_FILE")
    [[ "$lifecycle" == "review" ]]
}

@test "integration: T1156 - epic lifecycle only transitions from active state" {
    # Create epic with epicLifecycle = planning (not active)
    local epic=$(bash "$ADD_SCRIPT" "Planning Epic" --type epic -q)

    # Set epicLifecycle to 'planning' (not active)
    jq --arg id "$epic" '(.tasks[] | select(.id == $id)) |= . + {"epicLifecycle": "planning"}' "$TODO_FILE" > tmp && mv tmp "$TODO_FILE"

    # Create one child
    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic" -q)

    # Complete child with all gates (so passed=true)
    jq --arg id "$task" '(.tasks[] | select(.id == $id)) |= . + {"verification": {"passed": false, "round": 0, "gates": {"implemented": true, "testsPassed": true, "qaPassed": true, "cleanupDone": true, "securityPassed": true, "documented": true}, "lastAgent": null, "lastUpdated": "2026-01-01T00:00:00Z", "failureLog": []}}' "$TODO_FILE" > tmp && mv tmp "$TODO_FILE"
    bash "$COMPLETE_SCRIPT" "$task" --skip-notes

    # Epic should still be 'planning' (not active, so no transition)
    local lifecycle=$(jq -r --arg id "$epic" '.tasks[] | select(.id == $id) | .epicLifecycle' "$TODO_FILE")
    [[ "$lifecycle" == "planning" ]]
}

@test "integration: T1156 - nested hierarchy transitions grandparent epic" {
    # Create: epic -> task -> subtask
    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    jq --arg id "$epic" '(.tasks[] | select(.id == $id)) |= . + {"epicLifecycle": "active"}' "$TODO_FILE" > tmp && mv tmp "$TODO_FILE"

    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic" -q)
    local subtask=$(bash "$ADD_SCRIPT" "Subtask" --parent "$task" --type subtask -q)

    # Disable parent auto-complete to focus on lifecycle transition
    jq '.hierarchy.autoCompleteParent = false' "$CONFIG_FILE" > tmp && mv tmp "$CONFIG_FILE"

    # Complete subtask with all gates
    jq --arg id "$subtask" '(.tasks[] | select(.id == $id)) |= . + {"verification": {"passed": false, "round": 0, "gates": {"implemented": true, "testsPassed": true, "qaPassed": true, "cleanupDone": true, "securityPassed": true, "documented": true}, "lastAgent": null, "lastUpdated": "2026-01-01T00:00:00Z", "failureLog": []}}' "$TODO_FILE" > tmp && mv tmp "$TODO_FILE"
    bash "$COMPLETE_SCRIPT" "$subtask" --skip-notes

    # Task still pending - epic should still be active
    local lifecycle=$(jq -r --arg id "$epic" '.tasks[] | select(.id == $id) | .epicLifecycle' "$TODO_FILE")
    [[ "$lifecycle" == "active" ]]

    # Complete task with all gates
    jq --arg id "$task" '(.tasks[] | select(.id == $id)) |= . + {"verification": {"passed": false, "round": 0, "gates": {"implemented": true, "testsPassed": true, "qaPassed": true, "cleanupDone": true, "securityPassed": true, "documented": true}, "lastAgent": null, "lastUpdated": "2026-01-01T00:00:00Z", "failureLog": []}}' "$TODO_FILE" > tmp && mv tmp "$TODO_FILE"
    run bash "$COMPLETE_SCRIPT" "$task" --skip-notes
    assert_success

    # Now epic should be 'review' (task is direct child, and it's verified)
    lifecycle=$(jq -r --arg id "$epic" '.tasks[] | select(.id == $id) | .epicLifecycle' "$TODO_FILE")
    [[ "$lifecycle" == "review" ]]
}

# =============================================================================
# Orphan Detection Integration Tests (T341)
# =============================================================================

@test "integration: validate detects and fixes orphans" {
    # Create valid parent-child
    local parent=$(bash "$ADD_SCRIPT" "Parent" --type epic -q)
    local child=$(bash "$ADD_SCRIPT" "Child" --parent "$parent" -q)

    # Manually corrupt: set child's parentId to non-existent
    jq --arg id "$child" '.tasks |= map(if .id == $id then .parentId = "T999" else . end)' "$TODO_FILE" > tmp && mv tmp "$TODO_FILE"
    
    # Update checksum after manual modification
    local checksum=$(jq -c '.tasks' "$TODO_FILE" | sha256sum | cut -c1-16)
    jq --arg cs "$checksum" '._meta.checksum = $cs' "$TODO_FILE" > tmp && mv tmp "$TODO_FILE"

    # Validate should detect orphan
    run bash "$VALIDATE_SCRIPT" --check-orphans
    assert_output --partial "orphan"

    # Fix with unlink
    run bash "$VALIDATE_SCRIPT" --fix-orphans unlink
    assert_success

    # Child should now have null parentId
    local new_parent=$(jq -r --arg id "$child" '.tasks[] | select(.id == $id) | .parentId // "null"' "$TODO_FILE")
    [[ "$new_parent" == "null" ]]
}

@test "integration: orphan detection with delete mode" {
    local parent=$(bash "$ADD_SCRIPT" "Parent" --type epic -q)
    local child=$(bash "$ADD_SCRIPT" "Child" --parent "$parent" -q)

    # Corrupt parentId
    jq --arg id "$child" '.tasks |= map(if .id == $id then .parentId = "T999" else . end)' "$TODO_FILE" > tmp && mv tmp "$TODO_FILE"
    
    # Update checksum after manual modification
    local checksum=$(jq -c '.tasks' "$TODO_FILE" | sha256sum | cut -c1-16)
    jq --arg cs "$checksum" '._meta.checksum = $cs' "$TODO_FILE" > tmp && mv tmp "$TODO_FILE"

    # Fix with delete
    run bash "$VALIDATE_SCRIPT" --fix-orphans delete
    assert_success

    # Child should be deleted
    local child_exists=$(jq --arg id "$child" '.tasks | any(.id == $id)' "$TODO_FILE")
    [[ "$child_exists" == "false" ]]
}

# =============================================================================
# Tree Command Integration Tests (T342)
# =============================================================================

@test "integration: tree shows correct hierarchy" {
    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic" -q)
    local subtask=$(bash "$ADD_SCRIPT" "Subtask" --parent "$task" --type subtask -q)

    run bash "$LIST_SCRIPT" --tree
    assert_success
    assert_output --partial "Epic"
    assert_output --partial "Task"
    assert_output --partial "Subtask"
}

@test "integration: tree with root filter" {
    local epic1=$(bash "$ADD_SCRIPT" "Epic 1" --type epic -q)
    local epic2=$(bash "$ADD_SCRIPT" "Epic 2" --type epic -q)
    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic1" -q)

    # Use regular list with parent filter to show children of epic1
    run bash "$LIST_SCRIPT" --parent "$epic1"
    assert_success
    assert_output --partial "Task"
    refute_output --partial "Epic 1"
    refute_output --partial "Epic 2"
}

@test "integration: tree with status filter" {
    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    local task1=$(bash "$ADD_SCRIPT" "Task 1" --parent "$epic" -q)
    local task2=$(bash "$ADD_SCRIPT" "Task 2" --parent "$epic" -q)

    # Complete task1
    bash "$COMPLETE_SCRIPT" "$task1" --skip-notes

    run bash "$LIST_SCRIPT" --tree --status pending
    assert_success
    assert_output --partial "Epic"
    assert_output --partial "Task 2"
    refute_output --partial "Task 1"
}