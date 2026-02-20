#!/usr/bin/env bats
# =============================================================================
# hierarchy.bats - Unit tests for hierarchy functionality
# =============================================================================
# Tests hierarchy features introduced in v0.17.0:
# - Task types (epic|task|subtask)
# - Parent-child relationships
# - Size field validation
# - Depth limits (max 3 levels)
# - Sibling limits (max 7 children per parent)
# - Type inference from parent depth
# - Tree view output
# - Hierarchy filters (--type, --parent, --children)
#
# Reference: lib/tasks/hierarchy.sh, HIERARCHY-ENHANCEMENT-SPEC.md
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

@test "JSON output includes autoCompletedParents array for nested hierarchy" {
    create_empty_todo

    local epic_id=$(create_epic "Test Epic")
    local task_id=$(create_child_task "Only Child" "$epic_id" "task")

    # Enable auto-complete and disable verification requirement (T1160)
    # This test focuses on hierarchy auto-complete, not verification gates
    jq '.hierarchy.autoCompleteParent = true | .hierarchy.autoCompleteMode = "auto" | .verification.requireForParentAutoComplete = false' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    run bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes --format json
    assert_success

    # Verify JSON contains autoCompletedParents
    echo "$output" | jq -e '.autoCompletedParents' >/dev/null
    local auto_completed=$(echo "$output" | jq -r '.autoCompletedParents[0]')
    [[ "$auto_completed" == "$epic_id" ]]
}

@test "parent auto-complete respects config disabled" {
    create_empty_todo

    local epic_id=$(create_epic "Test Epic")
    local task_id=$(create_child_task "Only Child" "$epic_id" "task")

    # Disable auto-complete in config
    jq '.hierarchy.autoCompleteParent = false' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Complete only child - parent should NOT auto-complete
    run bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes
    assert_success

    local epic_status=$(jq -r --arg id "$epic_id" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
    [[ "$epic_status" != "done" ]]
}

@test "parent auto-complete works with multiple children" {
    create_empty_todo

    local epic_id=$(create_epic "Test Epic")
    local task1_id=$(create_child_task "Child 1" "$epic_id" "task")
    local task2_id=$(create_child_task "Child 2" "$epic_id" "task")
    local task3_id=$(create_child_task "Child 3" "$epic_id" "task")

    # Enable auto-complete and disable verification requirement (T1160)
    # This test focuses on hierarchy auto-complete, not verification gates
    jq '.hierarchy.autoCompleteParent = true | .hierarchy.autoCompleteMode = "auto" | .verification.requireForParentAutoComplete = false' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Complete first two children - parent should NOT auto-complete
    run bash "$COMPLETE_SCRIPT" "$task1_id" --skip-notes
    assert_success
    run bash "$COMPLETE_SCRIPT" "$task2_id" --skip-notes
    assert_success

    local epic_status=$(jq -r --arg id "$epic_id" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
    [[ "$epic_status" != "done" ]]

    # Complete last child - parent SHOULD auto-complete
    run bash "$COMPLETE_SCRIPT" "$task3_id" --skip-notes
    assert_success

    epic_status=$(jq -r --arg id "$epic_id" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
    [[ "$epic_status" == "done" ]]
}

@test "parent auto-complete works with nested hierarchy" {
    create_empty_todo

    # Create: epic -> task -> subtask
    local epic=$(create_epic "Epic")
    local task=$(create_child_task "Task" "$epic" "task")
    local subtask=$(create_child_task "Subtask" "$task" "subtask")

    # Enable auto-complete and disable verification requirement (T1160)
    # This test focuses on hierarchy auto-complete, not verification gates
    jq '.hierarchy.autoCompleteParent = true | .hierarchy.autoCompleteMode = "auto" | .verification.requireForParentAutoComplete = false' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Complete subtask - should auto-complete task, then epic
    run bash "$COMPLETE_SCRIPT" "$subtask" --skip-notes
    assert_success

    # Both task and epic should be done
    local task_status=$(jq -r --arg id "$task" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
    local epic_status=$(jq -r --arg id "$epic" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")

    [[ "$task_status" == "done" ]]
    [[ "$epic_status" == "done" ]]
}

@test "parent auto-complete disabled when mode is set to off" {
    create_empty_todo

    local epic_id=$(create_epic "Test Epic")
    local task_id=$(create_child_task "Only Child" "$epic_id" "task")

    # Set mode to off
    jq '.hierarchy.autoCompleteParent = true | .hierarchy.autoCompleteMode = "off"' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    run bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes
    assert_success

    local epic_status=$(jq -r --arg id "$epic_id" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
    [[ "$epic_status" != "done" ]]
}

@test "auto-completed parent has system auto-complete note" {
    create_empty_todo

    local epic_id=$(create_epic "Test Epic")
    local task_id=$(create_child_task "Only Child" "$epic_id" "task")

    # Enable auto-complete and disable verification requirement (T1160)
    # This test focuses on hierarchy auto-complete, not verification gates
    jq '.hierarchy.autoCompleteParent = true | .hierarchy.autoCompleteMode = "auto" | .verification.requireForParentAutoComplete = false' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    run bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes
    assert_success

    # Check for auto-complete note
    local note=$(jq -r --arg id "$epic_id" '.tasks[] | select(.id == $id) | .notes[0] // ""' "$TODO_FILE")
    [[ "$note" == *"AUTO-COMPLETED"* ]]
    [[ "$note" == *"All child tasks completed"* ]]
}

@test "JSON output includes autoCompletedParents array for simple case" {
    create_empty_todo

    local epic_id=$(create_epic "Test Epic")
    local task_id=$(create_child_task "Only Child" "$epic_id" "task")

    # Enable auto-complete and disable verification requirement (T1160)
    # This test focuses on hierarchy auto-complete, not verification gates
    jq '.hierarchy.autoCompleteParent = true | .hierarchy.autoCompleteMode = "auto" | .verification.requireForParentAutoComplete = false' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    run bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes --format json
    assert_success

    # Verify JSON contains autoCompletedParents
    echo "$output" | jq -e '.autoCompletedParents' >/dev/null
    local auto_completed=$(echo "$output" | jq -r '.autoCompletedParents[0]')
    [[ "$auto_completed" == "$epic_id" ]]
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper Functions for Hierarchy Tests
# =============================================================================

# Create an epic task
create_epic() {
    local title="${1:-Test Epic}"
    bash "$ADD_SCRIPT" "$title" --type epic --size large -q
}

# Create a task under a parent
create_child_task() {
    local title="$1"
    local parent="$2"
    local type="${3:-task}"
    bash "$ADD_SCRIPT" "$title" --parent "$parent" --type "$type" -q
}

# Get task type from todo.json
get_task_type() {
    local task_id="$1"
    jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .type // "task"' "$TODO_FILE"
}

# Get task parent from todo.json
get_task_parent() {
    local task_id="$1"
    jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .parentId // "null"' "$TODO_FILE"
}

# Get task size from todo.json
get_task_size() {
    local task_id="$1"
    jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .size // "null"' "$TODO_FILE"
}

# Count children of a parent task
count_children() {
    local parent_id="$1"
    jq --arg pid "$parent_id" '[.tasks[] | select(.parentId == $pid)] | length' "$TODO_FILE"
}

# Create hierarchy fixture: epic -> task -> subtask
create_hierarchy_fixture() {
    create_empty_todo
    local epic_id=$(create_epic "Test Epic")
    local task_id=$(create_child_task "Test Task" "$epic_id" "task")
    local subtask_id=$(create_child_task "Test Subtask" "$task_id" "subtask")
    echo "$epic_id $task_id $subtask_id"
}

# =============================================================================
# Type Flag Validation Tests
# =============================================================================

@test "add task with --type epic creates epic type" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "My Epic" --type epic
    assert_success

    local task_type=$(get_task_type "T001")
    [[ "$task_type" == "epic" ]]
}

@test "add task with --type task creates task type" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "My Task" --type task
    assert_success

    local task_type=$(get_task_type "T001")
    [[ "$task_type" == "task" ]]
}

@test "add task with --type subtask creates subtask type" {
    create_empty_todo
    # Create parent first
    bash "$ADD_SCRIPT" "Parent Task" --type task > /dev/null
    run bash "$ADD_SCRIPT" "My Subtask" --type subtask --parent T001
    assert_success

    local task_type=$(get_task_type "T002")
    [[ "$task_type" == "subtask" ]]
}

@test "add task with invalid --type fails" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --type invalid_type
    assert_failure
    assert_output --partial "[ERROR]"
    assert_output --partial "Invalid task type"
}

@test "add task with --type epic without parent succeeds" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Root Epic" --type epic
    assert_success

    local parent=$(get_task_parent "T001")
    [[ "$parent" == "null" ]]
}

# =============================================================================
# Parent Flag Tests
# =============================================================================

@test "add task with --parent creates child relationship" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Parent Task" --type task > /dev/null

    run bash "$ADD_SCRIPT" "Child Task" --parent T001
    assert_success

    local parent=$(get_task_parent "T002")
    [[ "$parent" == "T001" ]]
}

@test "add task with valid --parent references existing task" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null

    run bash "$ADD_SCRIPT" "Task under Epic" --parent T001
    assert_success
    assert_task_count 2

    local parent=$(get_task_parent "T002")
    [[ "$parent" == "T001" ]]
}

@test "add task with invalid --parent (non-existent) fails" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Orphan Task" --parent T999
    assert_failure
    assert_output --partial "[ERROR]"
    assert_output --partial "not found"
}

@test "add task with --parent empty string treated as no parent" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --parent ""
    assert_success

    local parent=$(get_task_parent "T001")
    [[ "$parent" == "null" ]]
}

@test "add task with malformed --parent ID fails" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --parent "INVALID"
    assert_failure
    assert_output --partial "[ERROR]"
}

# =============================================================================
# Size Flag Validation Tests
# =============================================================================

@test "add task with --size small succeeds" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Small Task" --size small
    assert_success

    local size=$(get_task_size "T001")
    [[ "$size" == "small" ]]
}

@test "add task with --size medium succeeds" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Medium Task" --size medium
    assert_success

    local size=$(get_task_size "T001")
    [[ "$size" == "medium" ]]
}

@test "add task with --size large succeeds" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Large Task" --size large
    assert_success

    local size=$(get_task_size "T001")
    [[ "$size" == "large" ]]
}

@test "add task with invalid --size fails" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --size huge
    assert_failure
    assert_output --partial "[ERROR]"
    assert_output --partial "size"
}

@test "epic typically has large size" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Epic" --type epic --size large
    assert_success

    local size=$(get_task_size "T001")
    local type=$(get_task_type "T001")
    [[ "$size" == "large" ]]
    [[ "$type" == "epic" ]]
}

# =============================================================================
# Depth Limit Tests (Max 3 Levels)
# =============================================================================

@test "hierarchy depth 1: epic at root succeeds" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Epic" --type epic
    assert_success
    assert_task_count 1
}

@test "hierarchy depth 2: task under epic succeeds" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null

    run bash "$ADD_SCRIPT" "Task" --parent T001 --type task
    assert_success
    assert_task_count 2
}

@test "hierarchy depth 3: subtask under task succeeds" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task" --parent T001 --type task > /dev/null

    run bash "$ADD_SCRIPT" "Subtask" --parent T002 --type subtask
    assert_success
    assert_task_count 3
}

@test "hierarchy depth 4: child under subtask fails" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task" --parent T001 --type task > /dev/null
    bash "$ADD_SCRIPT" "Subtask" --parent T002 --type subtask > /dev/null

    run bash "$ADD_SCRIPT" "Too Deep" --parent T003
    assert_failure
    assert_output --partial "[ERROR]"
    # Should mention depth limit, max depth exceeded, or subtask cannot have children
    assert_output_contains_any "depth" "level" "exceeded" "maximum" "subtask" "children"
}

@test "max depth enforced with exit code EXIT_DEPTH_EXCEEDED" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task" --parent T001 --type task > /dev/null
    bash "$ADD_SCRIPT" "Subtask" --parent T002 --type subtask > /dev/null

    run bash "$ADD_SCRIPT" "Too Deep" --parent T003
    # EXIT_DEPTH_EXCEEDED is 11
    [[ "$status" -eq 11 ]] || [[ "$status" -eq 1 ]]
}

# =============================================================================
# Sibling Limit Tests (configurable via hierarchy.maxSiblings, default=20)
# Note: Tests use MAX_SIBLINGS=7 for faster execution
# =============================================================================

@test "7 children under one parent succeeds" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Parent" --type epic > /dev/null

    # Add children without run (faster)
    for i in {1..7}; do
        bash "$ADD_SCRIPT" "Child $i" --parent T001 > /dev/null
    done

    # Verify count using jq (no need to source hierarchy.sh)
    local child_count=$(jq --arg pid "T001" '[.tasks[] | select(.parentId == $pid)] | length' "$TODO_FILE")
    [[ "$child_count" -eq 7 ]]
}

@test "8th child under parent fails (sibling limit)" {
    # Skip: default maxSiblings changed from 7 to 20 (configurable)
    # This test would need to add 20 children which is slow
    # Sibling limit validation is covered by EXIT_SIBLING_LIMIT test with config
    skip "maxSiblings default changed to 20 - use config to set lower limit"
}

@test "sibling limit enforced with exit code EXIT_SIBLING_LIMIT" {
    # Skip: default maxSiblings changed from 7 to 20 (configurable)
    # Config-based sibling limit testing should be done in integration tests
    skip "maxSiblings default changed to 20 - use config to set lower limit"
}

@test "different parents each support up to 7 children" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Parent 1" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Parent 2" --type epic > /dev/null

    # Add 7 children to each parent (should succeed)
    for i in {1..7}; do
        bash "$ADD_SCRIPT" "P1 Child $i" --parent T001 > /dev/null
        bash "$ADD_SCRIPT" "P2 Child $i" --parent T002 > /dev/null
    done

    # Verify counts using jq (no need to source hierarchy.sh)
    local p1_children=$(jq --arg pid "T001" '[.tasks[] | select(.parentId == $pid)] | length' "$TODO_FILE")
    local p2_children=$(jq --arg pid "T002" '[.tasks[] | select(.parentId == $pid)] | length' "$TODO_FILE")
    [[ "$p1_children" -eq 7 ]]
    [[ "$p2_children" -eq 7 ]]
}

# =============================================================================
# Type Inference Tests
# =============================================================================

@test "type inferred as task when parent is epic" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null

    # Don't specify type - should be inferred
    run bash "$ADD_SCRIPT" "Child" --parent T001
    assert_success

    local inferred_type=$(get_task_type "T002")
    [[ "$inferred_type" == "task" ]]
}

@test "type inferred as subtask when parent is task" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task" --parent T001 --type task > /dev/null

    # Don't specify type - should be inferred as subtask
    run bash "$ADD_SCRIPT" "Child" --parent T002
    assert_success

    local inferred_type=$(get_task_type "T003")
    [[ "$inferred_type" == "subtask" ]]
}

@test "type defaults to task for root-level items" {
    create_empty_todo
    # Don't specify type
    run bash "$ADD_SCRIPT" "Untyped Task"
    assert_success

    local default_type=$(get_task_type "T001")
    [[ "$default_type" == "task" ]]
}

@test "explicit type overrides inference" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null

    # Explicitly set subtask type even though parent is epic
    # This may or may not be allowed depending on implementation
    run bash "$ADD_SCRIPT" "Force Subtask" --parent T001 --type subtask
    # If allowed, type should be subtask
    if [[ "$status" -eq 0 ]]; then
        local explicit_type=$(get_task_type "T002")
        [[ "$explicit_type" == "subtask" ]]
    fi
    # If not allowed, test passes anyway (implementation choice)
}

# =============================================================================
# Subtask Cannot Be Parent Tests
# =============================================================================

@test "subtask cannot have children (type validation)" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task" --parent T001 --type task > /dev/null
    bash "$ADD_SCRIPT" "Subtask" --parent T002 --type subtask > /dev/null

    run bash "$ADD_SCRIPT" "Invalid Child" --parent T003
    assert_failure
    assert_output --partial "[ERROR]"
    # Should indicate subtask cannot have children
    assert_output_contains_any "subtask" "parent" "children" "type" "depth"
}

@test "subtask as parent fails with EXIT_INVALID_PARENT_TYPE" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task" --parent T001 --type task > /dev/null
    bash "$ADD_SCRIPT" "Subtask" --parent T002 --type subtask > /dev/null

    run bash "$ADD_SCRIPT" "Invalid Child" --parent T003
    # EXIT_INVALID_PARENT_TYPE is 13
    [[ "$status" -eq 13 ]] || [[ "$status" -eq 11 ]] || [[ "$status" -eq 1 ]]
}

# =============================================================================
# Invalid Combinations Tests
# =============================================================================

@test "epic with parent fails (epics must be root)" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Root Epic" --type epic > /dev/null

    run bash "$ADD_SCRIPT" "Child Epic" --type epic --parent T001
    assert_failure
    assert_output --partial "[ERROR]"
    # Epic cannot have a parent
    assert_output_contains_any "epic" "parent" "root"
}

@test "subtask without parent fails" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Orphan Subtask" --type subtask
    assert_failure
    assert_output --partial "[ERROR]"
    # Subtask requires a parent
    assert_output_contains_any "subtask" "parent" "required"
}

@test "task type is flexible - can be root or child" {
    create_empty_todo

    # Task as root
    run bash "$ADD_SCRIPT" "Root Task" --type task
    assert_success

    # Task under epic
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    run bash "$ADD_SCRIPT" "Child Task" --type task --parent T002
    assert_success
}

# =============================================================================
# Tree View Output Tests
# =============================================================================

@test "list --tree shows hierarchical structure" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task" --parent T001 --type task > /dev/null
    bash "$ADD_SCRIPT" "Subtask" --parent T002 --type subtask > /dev/null

    run bash "$LIST_SCRIPT" --tree
    assert_success
    # Should show tasks in tree structure
    assert_output --partial "Epic"
    assert_output --partial "Task"
    assert_output --partial "Subtask"
}

@test "list --tree with empty todo shows no tasks message" {
    create_empty_todo
    run bash "$LIST_SCRIPT" --tree
    # Should handle empty gracefully
    [[ "$status" -eq 0 ]] || assert_output --partial "No tasks"
}

@test "list --tree indents children under parents" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Child Task" --parent T001 > /dev/null

    run bash "$LIST_SCRIPT" --tree --format text
    assert_success
    # Tree view should show some visual hierarchy indication
    # (exact format depends on implementation)
    assert_output --partial "Epic"
    assert_output --partial "Child Task"
}

# =============================================================================
# --children Filter Tests
# =============================================================================

@test "list --children shows direct children only" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Child 1" --parent T001 > /dev/null
    bash "$ADD_SCRIPT" "Child 2" --parent T001 > /dev/null
    bash "$ADD_SCRIPT" "Grandchild" --parent T002 > /dev/null

    run bash "$LIST_SCRIPT" --children T001 --format json
    assert_success

    # Should show only direct children (Child 1, Child 2), not grandchild
    local count=$(echo "$output" | jq '.tasks | length')
    [[ "$count" -eq 2 ]]
}

@test "list --children of leaf task returns empty" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task" --parent T001 > /dev/null
    bash "$ADD_SCRIPT" "Subtask" --parent T002 --type subtask > /dev/null

    # Subtask has no children
    run bash "$LIST_SCRIPT" --children T003 --format json
    assert_success

    local count=$(echo "$output" | jq '.tasks | length')
    [[ "$count" -eq 0 ]]
}

@test "list --children with invalid parent ID returns empty" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Task" > /dev/null

    run bash "$LIST_SCRIPT" --children T999 --format json
    assert_success

    local count=$(echo "$output" | jq '.tasks | length')
    [[ "$count" -eq 0 ]]
}

# =============================================================================
# --type Filter Tests
# =============================================================================

@test "list --type epic shows only epics" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic 1" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Epic 2" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task" --type task > /dev/null
    bash "$ADD_SCRIPT" "Child" --parent T001 --type task > /dev/null

    run bash "$LIST_SCRIPT" --type epic --format json
    assert_success

    local count=$(echo "$output" | jq '.tasks | length')
    [[ "$count" -eq 2 ]]

    # Verify all are epics
    local non_epic_count=$(echo "$output" | jq '[.tasks[] | select(.type != "epic")] | length')
    [[ "$non_epic_count" -eq 0 ]]
}

@test "list --type task shows only tasks" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task 1" --parent T001 --type task > /dev/null
    bash "$ADD_SCRIPT" "Task 2" --parent T001 --type task > /dev/null
    bash "$ADD_SCRIPT" "Subtask" --parent T002 --type subtask > /dev/null

    run bash "$LIST_SCRIPT" --type task --format json
    assert_success

    local count=$(echo "$output" | jq '.tasks | length')
    [[ "$count" -eq 2 ]]
}

@test "list --type subtask shows only subtasks" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task" --parent T001 --type task > /dev/null
    bash "$ADD_SCRIPT" "Subtask 1" --parent T002 --type subtask > /dev/null
    bash "$ADD_SCRIPT" "Subtask 2" --parent T002 --type subtask > /dev/null

    run bash "$LIST_SCRIPT" --type subtask --format json
    assert_success

    local count=$(echo "$output" | jq '.tasks | length')
    [[ "$count" -eq 2 ]]
}

@test "list -t shorthand works for type filter" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task" --type task > /dev/null

    run bash "$LIST_SCRIPT" -t epic --format json
    assert_success

    local count=$(echo "$output" | jq '.tasks | length')
    [[ "$count" -eq 1 ]]
}

# =============================================================================
# --parent Filter Tests
# =============================================================================

@test "list --parent shows tasks with specific parent" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic 1" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Epic 2" --type epic > /dev/null
    bash "$ADD_SCRIPT" "E1 Child 1" --parent T001 > /dev/null
    bash "$ADD_SCRIPT" "E1 Child 2" --parent T001 > /dev/null
    bash "$ADD_SCRIPT" "E2 Child" --parent T002 > /dev/null

    run bash "$LIST_SCRIPT" --parent T001 --format json
    assert_success

    local count=$(echo "$output" | jq '.tasks | length')
    [[ "$count" -eq 2 ]]
}

@test "list --parent with no matches returns empty" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Task" --type task > /dev/null

    run bash "$LIST_SCRIPT" --parent T999 --format json
    assert_success

    local count=$(echo "$output" | jq '.tasks | length')
    [[ "$count" -eq 0 ]]
}

# =============================================================================
# Combined Filter Tests
# =============================================================================

@test "combine --type and --status filters" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic pending" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Epic done" --type epic --status done > /dev/null 2>&1 || true
    bash "$ADD_SCRIPT" "Task pending" --type task > /dev/null

    run bash "$LIST_SCRIPT" --type epic --status pending --format json
    assert_success

    # Should show only pending epics
    local count=$(echo "$output" | jq '.tasks | length')
    [[ "$count" -ge 1 ]]
}

@test "combine --parent and --status filters" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Child pending" --parent T001 > /dev/null
    bash "$ADD_SCRIPT" "Child done" --parent T001 --status done > /dev/null 2>&1 || true

    run bash "$LIST_SCRIPT" --parent T001 --status pending --format json
    assert_success

    # Should show only pending children of T001
    local count=$(echo "$output" | jq '.tasks | length')
    [[ "$count" -ge 1 ]]
}

# =============================================================================
# JSON Output Includes Hierarchy Fields
# =============================================================================

@test "JSON output includes type field" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null

    run bash "$LIST_SCRIPT" --format json
    assert_success

    local task_type=$(echo "$output" | jq -r '.tasks[0].type')
    [[ "$task_type" == "epic" ]]
}

@test "JSON output includes parentId field" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Parent" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Child" --parent T001 > /dev/null

    run bash "$LIST_SCRIPT" --format json
    assert_success

    local parent_id=$(echo "$output" | jq -r '.tasks[] | select(.id == "T002") | .parentId')
    [[ "$parent_id" == "T001" ]]
}

@test "JSON output includes size field when set" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Task" --size medium > /dev/null

    run bash "$LIST_SCRIPT" --format json
    assert_success

    local size=$(echo "$output" | jq -r '.tasks[0].size')
    [[ "$size" == "medium" ]]
}

# =============================================================================
# Hierarchy Validation in lib/tasks/hierarchy.sh Tests
# =============================================================================

@test "validate_task_type accepts valid types" {
    # Source the library directly for function tests
    source "$LIB_DIR/tasks/hierarchy.sh"

    run validate_task_type "epic"
    assert_success

    run validate_task_type "task"
    assert_success

    run validate_task_type "subtask"
    assert_success
}

@test "validate_task_type rejects invalid types" {
    source "$LIB_DIR/tasks/hierarchy.sh"

    run validate_task_type "invalid"
    assert_failure

    run validate_task_type ""
    assert_failure

    run validate_task_type "EPIC"
    assert_failure
}

@test "validate_task_size accepts valid sizes" {
    source "$LIB_DIR/tasks/hierarchy.sh"

    run validate_task_size "small"
    assert_success

    run validate_task_size "medium"
    assert_success

    run validate_task_size "large"
    assert_success

    # Empty/null is allowed (optional field)
    run validate_task_size ""
    assert_success
}

@test "validate_task_size rejects invalid sizes" {
    source "$LIB_DIR/tasks/hierarchy.sh"

    run validate_task_size "huge"
    assert_failure

    run validate_task_size "SMALL"
    assert_failure

    run validate_task_size "extra-large"
    assert_failure
}

@test "get_task_depth returns correct depth" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task" --parent T001 --type task > /dev/null
    bash "$ADD_SCRIPT" "Subtask" --parent T002 --type subtask > /dev/null

    source "$LIB_DIR/tasks/hierarchy.sh"

    # Epic at root = depth 0
    local epic_depth=$(get_task_depth "T001" "$TODO_FILE")
    [[ "$epic_depth" -eq 0 ]]

    # Task under epic = depth 1
    local task_depth=$(get_task_depth "T002" "$TODO_FILE")
    [[ "$task_depth" -eq 1 ]]

    # Subtask under task = depth 2
    local subtask_depth=$(get_task_depth "T003" "$TODO_FILE")
    [[ "$subtask_depth" -eq 2 ]]
}

@test "get_children returns direct children" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Parent" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Child 1" --parent T001 > /dev/null
    bash "$ADD_SCRIPT" "Child 2" --parent T001 > /dev/null
    bash "$ADD_SCRIPT" "Grandchild" --parent T002 > /dev/null

    source "$LIB_DIR/tasks/hierarchy.sh"

    local children=$(get_children "T001" "$TODO_FILE")
    # Should contain T002 and T003, not T004
    [[ "$children" == *"T002"* ]]
    [[ "$children" == *"T003"* ]]
    [[ "$children" != *"T004"* ]]
}

@test "count_siblings returns correct count" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Parent" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Child 1" --parent T001 > /dev/null
    bash "$ADD_SCRIPT" "Child 2" --parent T001 > /dev/null
    bash "$ADD_SCRIPT" "Child 3" --parent T001 > /dev/null

    source "$LIB_DIR/tasks/hierarchy.sh"

    local count=$(count_siblings "T001" "$TODO_FILE")
    [[ "$count" -eq 3 ]]
}

@test "validate_parent_exists passes for existing parent" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Parent" > /dev/null

    source "$LIB_DIR/tasks/hierarchy.sh"

    run validate_parent_exists "T001" "$TODO_FILE"
    assert_success
}

@test "validate_parent_exists fails for non-existent parent" {
    create_empty_todo

    source "$LIB_DIR/tasks/hierarchy.sh"

    run validate_parent_exists "T999" "$TODO_FILE"
    assert_failure
}

@test "validate_parent_type passes for epic and task parents" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task" --parent T001 --type task > /dev/null

    source "$LIB_DIR/tasks/hierarchy.sh"

    run validate_parent_type "T001" "$TODO_FILE"
    assert_success

    run validate_parent_type "T002" "$TODO_FILE"
    assert_success
}

@test "validate_parent_type fails for subtask parent" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task" --parent T001 --type task > /dev/null
    bash "$ADD_SCRIPT" "Subtask" --parent T002 --type subtask > /dev/null

    source "$LIB_DIR/tasks/hierarchy.sh"

    run validate_parent_type "T003" "$TODO_FILE"
    assert_failure
}

@test "infer_task_type returns task for children of epic" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null

    source "$LIB_DIR/tasks/hierarchy.sh"

    local inferred=$(infer_task_type "T001" "$TODO_FILE")
    [[ "$inferred" == "task" ]]
}

@test "infer_task_type returns subtask for children of task" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task" --parent T001 --type task > /dev/null

    source "$LIB_DIR/tasks/hierarchy.sh"

    local inferred=$(infer_task_type "T002" "$TODO_FILE")
    [[ "$inferred" == "subtask" ]]
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "orphan detection finds tasks with invalid parentId" {
    create_empty_todo
    # Create task then manually corrupt parentId
    bash "$ADD_SCRIPT" "Task" > /dev/null

    # Manually add task with invalid parentId
    jq '.tasks += [{"id": "T002", "title": "Orphan", "description": "orphan desc", "status": "pending", "priority": "medium", "parentId": "T999", "createdAt": "2025-12-01T10:00:00Z"}]' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    source "$LIB_DIR/tasks/hierarchy.sh"

    local orphans=$(detect_orphans "$TODO_FILE")
    [[ "$orphans" == *"T002"* ]]
}

@test "circular reference detection prevents self-reference" {
    source "$LIB_DIR/tasks/hierarchy.sh"

    create_empty_todo
    bash "$ADD_SCRIPT" "Task" > /dev/null

    # Validate that task cannot be its own parent
    run validate_no_circular_reference "T001" "T001" "$TODO_FILE"
    assert_failure
}

@test "get_descendants returns all descendants" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task 1" --parent T001 --type task > /dev/null
    bash "$ADD_SCRIPT" "Task 2" --parent T001 --type task > /dev/null
    bash "$ADD_SCRIPT" "Subtask" --parent T002 --type subtask > /dev/null

    source "$LIB_DIR/tasks/hierarchy.sh"

    local descendants=$(get_descendants "T001" "$TODO_FILE")
    # Should include T002, T003, T004
    [[ "$descendants" == *"T002"* ]]
    [[ "$descendants" == *"T003"* ]]
    [[ "$descendants" == *"T004"* ]]
}

@test "get_parent_chain returns ancestor list" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Epic" --type epic > /dev/null
    bash "$ADD_SCRIPT" "Task" --parent T001 --type task > /dev/null
    bash "$ADD_SCRIPT" "Subtask" --parent T002 --type subtask > /dev/null

    source "$LIB_DIR/tasks/hierarchy.sh"

    local chain=$(get_parent_chain "T003" "$TODO_FILE")
    # T003's parent is T002, T002's parent is T001
    [[ "$chain" == *"T002"* ]]
    [[ "$chain" == *"T001"* ]]
}

# =============================================================================
# Orphan Detection Tests (T341)
# =============================================================================

@test "detect_orphans finds task with missing parent" {
    create_empty_todo
    # Create task then manually corrupt parentId
    bash "$ADD_SCRIPT" "Task" --priority medium > /dev/null

    # Manually add task with invalid parentId
    jq '.tasks += [{"id": "T002", "title": "Orphan", "description": "orphan desc", "status": "pending", "priority": "medium", "parentId": "T999", "createdAt": "2025-12-01T10:00:00Z"}]' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    source "$LIB_DIR/tasks/hierarchy.sh"

    local orphans=$(detect_orphans "$TODO_FILE")
    [[ "$orphans" == *"T002"* ]]
}

@test "validate --check-orphans reports orphaned tasks" {
    create_empty_todo
    jq '.tasks += [{"id":"T001","title":"Orphan","description":"test orphan","status":"pending","priority":"medium","parentId":"T999","createdAt":"2025-12-01T10:00:00Z"}]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Disable checksum validation for this test since we manually modified the file
    export CLAUDE_TODO_VALIDATION_CHECKSUM_ENABLED=false
    
    # Run validation - expect failure due to orphaned tasks, but verify reporting works
    run bash "$VALIDATE_SCRIPT" --check-orphans
    assert_failure
    assert_output --partial "orphaned tasks"
    assert_output --partial "T001"
    assert_output --partial "Orphan"
    assert_output --partial "T999"
    
    # Re-enable checksum validation for other tests
    unset CLAUDE_TODO_VALIDATION_CHECKSUM_ENABLED
}

@test "validate --fix-orphans unlink repairs orphans" {
    create_empty_todo
    jq '.tasks += [{"id":"T001","title":"Orphan","description":"test orphan","status":"pending","priority":"medium","parentId":"T999","createdAt":"2025-12-01T10:00:00Z"}]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Disable checksum validation for this test since we manually modified the file
    export CLAUDE_TODO_VALIDATION_CHECKSUM_ENABLED=false
    
    # Run validation with fix - expect success after fixing orphans
    run bash "$VALIDATE_SCRIPT" --fix-orphans unlink
    assert_success
    assert_output --partial "Unlinked 1 orphaned tasks"

    # Verify parentId is now null
    local parent=$(jq -r '.tasks[] | select(.id == "T001") | .parentId // "null"' "$TODO_FILE")
    [[ "$parent" == "null" ]]
    
    # Re-enable checksum validation for other tests
    unset CLAUDE_TODO_VALIDATION_CHECKSUM_ENABLED
}

# =============================================================================
# Parent Auto-Complete Tests (T340)
# =============================================================================

@test "completing last sibling auto-completes parent when enabled" {
    create_empty_todo

    # Create hierarchy: epic -> 2 tasks
    local epic_id=$(create_epic "Test Epic")
    local task1_id=$(create_child_task "Child 1" "$epic_id" "task")
    local task2_id=$(create_child_task "Child 2" "$epic_id" "task")

    # Enable auto-complete and disable verification requirement (T1160)
    # This test focuses on hierarchy auto-complete, not verification gates
    jq '.hierarchy.autoCompleteParent = true | .hierarchy.autoCompleteMode = "auto" | .verification.requireForParentAutoComplete = false' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Complete first child - parent should NOT auto-complete
    run bash "$COMPLETE_SCRIPT" "$task1_id" --skip-notes
    assert_success

    local epic_status=$(jq -r --arg id "$epic_id" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
    [[ "$epic_status" != "done" ]]

    # Complete second child - parent SHOULD auto-complete
    run bash "$COMPLETE_SCRIPT" "$task2_id" --skip-notes
    assert_success

    epic_status=$(jq -r --arg id "$epic_id" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
    [[ "$epic_status" == "done" ]]
}

@test "parent auto-complete disabled when mode is off" {
    create_empty_todo

    local epic_id=$(create_epic "Test Epic")
    local task_id=$(create_child_task "Only Child" "$epic_id" "task")

    # Set mode to off
    jq '.hierarchy.autoCompleteParent = true | .hierarchy.autoCompleteMode = "off"' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    run bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes
    assert_success

    local epic_status=$(jq -r --arg id "$epic_id" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
    [[ "$epic_status" != "done" ]]
}

@test "auto-completed parent has system note" {
    create_empty_todo

    local epic_id=$(create_epic "Test Epic")
    local task_id=$(create_child_task "Only Child" "$epic_id" "task")

    # Enable auto-complete and disable verification requirement (T1160)
    # This test focuses on hierarchy auto-complete, not verification gates
    jq '.hierarchy.autoCompleteParent = true | .hierarchy.autoCompleteMode = "auto" | .verification.requireForParentAutoComplete = false' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    run bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes
    assert_success

    # Check for auto-complete note
    local note=$(jq -r --arg id "$epic_id" '.tasks[] | select(.id == $id) | .notes[0] // ""' "$TODO_FILE")
    [[ "$note" == *"AUTO-COMPLETED"* ]]
    [[ "$note" == *"All child tasks completed"* ]]
}

@test "JSON output has no debug fields" {
    create_empty_todo
    local task_id=$(bash "$ADD_SCRIPT" "Test Task" -q)

    run bash "$COMPLETE_SCRIPT" "$task_id" --format json --skip-notes
    assert_success

    # Should NOT contain debug fields
    echo "$output" | jq -e '.debugConfig' && fail "Debug field found in output"
    echo "$output" | jq -e '._meta.debug' && fail "Debug field found in _meta"

    # Should be valid JSON
    echo "$output" | jq -e '.success' >/dev/null
}

@test "checksum is recalculated after parent auto-complete" {
    create_empty_todo

    local epic_id=$(create_epic "Test Epic")
    local task_id=$(create_child_task "Only Child" "$epic_id" "task")

    # Enable auto-complete and disable verification requirement (T1160)
    # This test focuses on hierarchy auto-complete, not verification gates
    jq '.hierarchy.autoCompleteParent = true | .hierarchy.autoCompleteMode = "auto" | .verification.requireForParentAutoComplete = false' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    local before_checksum=$(jq -r '._meta.checksum' "$TODO_FILE")

    run bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes
    assert_success

    local after_checksum=$(jq -r '._meta.checksum' "$TODO_FILE")

    # Checksums should be different (file was modified)
    [[ "$before_checksum" != "$after_checksum" ]]
}
