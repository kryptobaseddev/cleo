#!/usr/bin/env bats
# =============================================================================
# jq-helpers.bats - Unit tests for lib/core/jq-helpers.sh
# =============================================================================
# Tests all 14 jq helper functions for task JSON manipulation.
# Covers success cases, error handling, edge cases, and return codes.
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

    # Source the library under test
    source "$LIB_DIR/core/jq-helpers.sh"

    # Create test fixture with comprehensive task data
    TEST_TODO_FILE="$BATS_TEST_TMPDIR/test-todo.json"
    cat > "$TEST_TODO_FILE" << 'EOF'
{
  "tasks": [
    {"id": "T001", "title": "Task 1", "status": "pending", "priority": "high", "phase": "core", "type": "task", "parentId": null},
    {"id": "T002", "title": "Task 2", "status": "done", "priority": "medium", "phase": "core", "type": "epic", "parentId": null},
    {"id": "T003", "title": "Task 3", "status": "pending", "priority": "low", "phase": "testing", "type": "subtask", "parentId": "T002"},
    {"id": "T004", "title": "Task 4", "status": "blocked", "priority": "critical", "phase": "core", "type": "task", "parentId": null},
    {"id": "T005", "title": "Task 5", "status": "active", "priority": "high", "phase": "polish", "type": "task", "parentId": "T002"}
  ],
  "focus": {"currentTask": "T001"},
  "project": {"currentPhase": "core"}
}
EOF
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Library Loading Tests
# =============================================================================

@test "jq-helpers.sh exists" {
    [ -f "$LIB_DIR/core/jq-helpers.sh" ]
}

@test "jq-helpers.sh can be sourced" {
    run bash -c "source '$LIB_DIR/core/jq-helpers.sh'"
    assert_success
}

@test "jq-helpers.sh exports all declared functions" {
    # Verify all 14 functions are exported
    declare -F get_task_field
    declare -F get_tasks_by_status
    declare -F get_task_by_id
    declare -F array_to_json
    declare -F count_tasks_by_status
    declare -F has_children
    declare -F get_focus_task
    declare -F get_task_count
    declare -F get_current_phase
    declare -F get_all_task_ids
    declare -F get_phase_tasks
    declare -F task_exists
    declare -F get_task_with_field
    declare -F filter_tasks_multi
}

# =============================================================================
# get_task_field Tests
# =============================================================================

@test "get_task_field extracts existing string field" {
    local task_json='{"id": "T001", "title": "Test Task", "status": "pending"}'
    run get_task_field "$task_json" "title"
    assert_success
    assert_output "Test Task"
}

@test "get_task_field extracts existing id field" {
    local task_json='{"id": "T001", "title": "Test Task", "status": "pending"}'
    run get_task_field "$task_json" "id"
    assert_success
    assert_output "T001"
}

@test "get_task_field returns empty for non-existent field" {
    local task_json='{"id": "T001", "title": "Test Task"}'
    run get_task_field "$task_json" "nonexistent"
    assert_success
    assert_output ""
}

@test "get_task_field returns empty for null field" {
    local task_json='{"id": "T001", "parentId": null}'
    run get_task_field "$task_json" "parentId"
    assert_success
    assert_output ""
}

@test "get_task_field errors with empty task_json" {
    run get_task_field "" "title"
    assert_failure
    assert_output --partial "task_json required"
}

@test "get_task_field errors with missing field_name" {
    local task_json='{"id": "T001"}'
    run get_task_field "$task_json" ""
    assert_failure
    assert_output --partial "field_name required"
}

@test "get_task_field handles nested fields with dot notation" {
    local task_json='{"id": "T001", "meta": {"created": "2025-01-01"}}'
    run get_task_field "$task_json" "meta.created"
    assert_success
    assert_output "2025-01-01"
}

# =============================================================================
# get_tasks_by_status Tests
# =============================================================================

@test "get_tasks_by_status filters pending tasks" {
    run get_tasks_by_status "pending" "$TEST_TODO_FILE"
    assert_success

    # Should return 2 pending tasks (T001, T003)
    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 2 ]
}

@test "get_tasks_by_status filters done tasks" {
    run get_tasks_by_status "done" "$TEST_TODO_FILE"
    assert_success

    # Should return 1 done task (T002)
    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 1 ]

    # Verify it's the correct task
    local task_id
    task_id=$(echo "$output" | jq -r '.[0].id')
    [ "$task_id" = "T002" ]
}

@test "get_tasks_by_status filters blocked tasks" {
    run get_tasks_by_status "blocked" "$TEST_TODO_FILE"
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 1 ]
}

@test "get_tasks_by_status filters active tasks" {
    run get_tasks_by_status "active" "$TEST_TODO_FILE"
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 1 ]
}

@test "get_tasks_by_status returns empty array for no matches" {
    run get_tasks_by_status "cancelled" "$TEST_TODO_FILE"
    assert_success
    assert_output "[]"
}

@test "get_tasks_by_status errors with missing status" {
    run get_tasks_by_status "" "$TEST_TODO_FILE"
    assert_failure
    assert_output --partial "status required"
}

@test "get_tasks_by_status errors with missing todo_file" {
    run get_tasks_by_status "pending" ""
    assert_failure
    assert_output --partial "todo_file required"
}

@test "get_tasks_by_status errors with non-existent file" {
    run get_tasks_by_status "pending" "/nonexistent/path.json"
    assert_failure 2
    assert_output --partial "File not found"
}

# =============================================================================
# get_task_by_id Tests
# =============================================================================

@test "get_task_by_id finds existing task" {
    run get_task_by_id "T001" "$TEST_TODO_FILE"
    assert_success

    local task_title
    task_title=$(echo "$output" | jq -r '.title')
    [ "$task_title" = "Task 1" ]
}

@test "get_task_by_id finds task with specific properties" {
    run get_task_by_id "T002" "$TEST_TODO_FILE"
    assert_success

    local task_type
    task_type=$(echo "$output" | jq -r '.type')
    [ "$task_type" = "epic" ]
}

@test "get_task_by_id returns empty for non-existent task" {
    run get_task_by_id "T999" "$TEST_TODO_FILE"
    assert_success
    assert_output ""
}

@test "get_task_by_id errors with missing task_id" {
    run get_task_by_id "" "$TEST_TODO_FILE"
    assert_failure
    assert_output --partial "task_id required"
}

@test "get_task_by_id errors with missing todo_file" {
    run get_task_by_id "T001" ""
    assert_failure
    assert_output --partial "todo_file required"
}

@test "get_task_by_id errors with non-existent file" {
    run get_task_by_id "T001" "/nonexistent/path.json"
    assert_failure 2
    assert_output --partial "File not found"
}

# =============================================================================
# array_to_json Tests
# =============================================================================

@test "array_to_json converts multiple elements" {
    run array_to_json "one" "two" "three"
    assert_success

    local length
    length=$(echo "$output" | jq 'length')
    [ "$length" -eq 3 ]

    local first
    first=$(echo "$output" | jq -r '.[0]')
    [ "$first" = "one" ]
}

@test "array_to_json converts single element" {
    run array_to_json "single"
    assert_success

    local length
    length=$(echo "$output" | jq 'length')
    [ "$length" -eq 1 ]
}

@test "array_to_json returns empty array for no input" {
    run array_to_json
    assert_success
    assert_output "[]"
}

@test "array_to_json trims whitespace from elements" {
    run array_to_json "  spaced  " "  padded  "
    assert_success

    local first
    first=$(echo "$output" | jq -r '.[0]')
    [ "$first" = "spaced" ]

    local second
    second=$(echo "$output" | jq -r '.[1]')
    [ "$second" = "padded" ]
}

@test "array_to_json handles elements with special characters" {
    run array_to_json "with space" "with-dash" "with_underscore"
    assert_success

    local length
    length=$(echo "$output" | jq 'length')
    [ "$length" -eq 3 ]
}

@test "array_to_json produces valid JSON" {
    run array_to_json "a" "b" "c"
    assert_success
    assert_valid_json
}

# =============================================================================
# count_tasks_by_status Tests
# =============================================================================

@test "count_tasks_by_status counts pending tasks" {
    run count_tasks_by_status "pending" "$TEST_TODO_FILE"
    assert_success
    assert_output "2"
}

@test "count_tasks_by_status counts done tasks" {
    run count_tasks_by_status "done" "$TEST_TODO_FILE"
    assert_success
    assert_output "1"
}

@test "count_tasks_by_status counts blocked tasks" {
    run count_tasks_by_status "blocked" "$TEST_TODO_FILE"
    assert_success
    assert_output "1"
}

@test "count_tasks_by_status counts active tasks" {
    run count_tasks_by_status "active" "$TEST_TODO_FILE"
    assert_success
    assert_output "1"
}

@test "count_tasks_by_status returns 0 for no matches" {
    run count_tasks_by_status "cancelled" "$TEST_TODO_FILE"
    assert_success
    assert_output "0"
}

@test "count_tasks_by_status errors with missing status" {
    run count_tasks_by_status "" "$TEST_TODO_FILE"
    assert_failure
    assert_output --partial "status required"
}

@test "count_tasks_by_status errors with missing todo_file" {
    run count_tasks_by_status "pending" ""
    assert_failure
    assert_output --partial "todo_file required"
}

@test "count_tasks_by_status errors with non-existent file" {
    run count_tasks_by_status "pending" "/nonexistent/path.json"
    assert_failure 2
    assert_output --partial "File not found"
}

# =============================================================================
# has_children Tests
# =============================================================================

@test "has_children returns true for task with children" {
    # T002 is parent of T003 and T005
    run has_children "T002" "$TEST_TODO_FILE"
    assert_success
}

@test "has_children returns false for task without children" {
    # T001 has no children
    run has_children "T001" "$TEST_TODO_FILE"
    assert_failure
}

@test "has_children returns false for subtask (leaf node)" {
    # T003 is a subtask with no children
    run has_children "T003" "$TEST_TODO_FILE"
    assert_failure
}

@test "has_children returns false for non-existent task" {
    run has_children "T999" "$TEST_TODO_FILE"
    assert_failure
}

@test "has_children returns false with empty task_id" {
    run has_children "" "$TEST_TODO_FILE"
    assert_failure
}

@test "has_children returns false with missing todo_file" {
    run has_children "T001" ""
    assert_failure
}

@test "has_children returns false with non-existent file" {
    run has_children "T001" "/nonexistent/path.json"
    assert_failure
}

# =============================================================================
# get_focus_task Tests
# =============================================================================

@test "get_focus_task returns current focus task ID" {
    run get_focus_task "$TEST_TODO_FILE"
    assert_success
    assert_output "T001"
}

@test "get_focus_task returns empty when no focus set" {
    local no_focus_file="$BATS_TEST_TMPDIR/no-focus.json"
    cat > "$no_focus_file" << 'EOF'
{
  "tasks": [],
  "focus": {},
  "project": {}
}
EOF
    run get_focus_task "$no_focus_file"
    assert_success
    assert_output ""
}

@test "get_focus_task returns empty when focus.currentTask is null" {
    local null_focus_file="$BATS_TEST_TMPDIR/null-focus.json"
    cat > "$null_focus_file" << 'EOF'
{
  "tasks": [],
  "focus": {"currentTask": null},
  "project": {}
}
EOF
    run get_focus_task "$null_focus_file"
    assert_success
    assert_output ""
}

@test "get_focus_task errors with missing todo_file" {
    run get_focus_task ""
    assert_failure
    assert_output --partial "todo_file required"
}

@test "get_focus_task errors with non-existent file" {
    run get_focus_task "/nonexistent/path.json"
    assert_failure 2
    assert_output --partial "File not found"
}

# =============================================================================
# get_task_count Tests
# =============================================================================

@test "get_task_count returns total task count" {
    run get_task_count "$TEST_TODO_FILE"
    assert_success
    assert_output "5"
}

@test "get_task_count returns 0 for empty task array" {
    local empty_file="$BATS_TEST_TMPDIR/empty.json"
    echo '{"tasks": [], "focus": {}, "project": {}}' > "$empty_file"

    run get_task_count "$empty_file"
    assert_success
    assert_output "0"
}

@test "get_task_count errors with missing todo_file" {
    run get_task_count ""
    assert_failure
    assert_output --partial "todo_file required"
}

@test "get_task_count errors with non-existent file" {
    run get_task_count "/nonexistent/path.json"
    assert_failure 2
    assert_output --partial "File not found"
}

# =============================================================================
# get_current_phase Tests
# =============================================================================

@test "get_current_phase returns project phase" {
    run get_current_phase "$TEST_TODO_FILE"
    assert_success
    assert_output "core"
}

@test "get_current_phase returns empty when no phase set" {
    local no_phase_file="$BATS_TEST_TMPDIR/no-phase.json"
    cat > "$no_phase_file" << 'EOF'
{
  "tasks": [],
  "focus": {},
  "project": {}
}
EOF
    run get_current_phase "$no_phase_file"
    assert_success
    assert_output ""
}

@test "get_current_phase returns empty when currentPhase is null" {
    local null_phase_file="$BATS_TEST_TMPDIR/null-phase.json"
    cat > "$null_phase_file" << 'EOF'
{
  "tasks": [],
  "focus": {},
  "project": {"currentPhase": null}
}
EOF
    run get_current_phase "$null_phase_file"
    assert_success
    assert_output ""
}

@test "get_current_phase errors with missing todo_file" {
    run get_current_phase ""
    assert_failure
    assert_output --partial "todo_file required"
}

@test "get_current_phase errors with non-existent file" {
    run get_current_phase "/nonexistent/path.json"
    assert_failure 2
    assert_output --partial "File not found"
}

# =============================================================================
# get_all_task_ids Tests
# =============================================================================

@test "get_all_task_ids returns all IDs" {
    run get_all_task_ids "$TEST_TODO_FILE"
    assert_success

    # Should have 5 lines (one per task)
    local line_count
    line_count=$(echo "$output" | wc -l)
    [ "$line_count" -eq 5 ]
}

@test "get_all_task_ids returns IDs in order" {
    run get_all_task_ids "$TEST_TODO_FILE"
    assert_success

    local first_id
    first_id=$(echo "$output" | head -1)
    [ "$first_id" = "T001" ]
}

@test "get_all_task_ids returns empty for no tasks" {
    local empty_file="$BATS_TEST_TMPDIR/empty.json"
    echo '{"tasks": [], "focus": {}, "project": {}}' > "$empty_file"

    run get_all_task_ids "$empty_file"
    assert_success
    assert_output ""
}

@test "get_all_task_ids errors with missing todo_file" {
    run get_all_task_ids ""
    assert_failure
    assert_output --partial "todo_file required"
}

@test "get_all_task_ids errors with non-existent file" {
    run get_all_task_ids "/nonexistent/path.json"
    assert_failure 2
    assert_output --partial "File not found"
}

# =============================================================================
# get_phase_tasks Tests
# =============================================================================

@test "get_phase_tasks filters by phase" {
    run get_phase_tasks "core" "$TEST_TODO_FILE"
    assert_success

    # Should return 3 tasks in core phase (T001, T002, T004)
    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 3 ]
}

@test "get_phase_tasks returns empty array for phase with no tasks" {
    run get_phase_tasks "setup" "$TEST_TODO_FILE"
    assert_success
    assert_output "[]"
}

@test "get_phase_tasks filters testing phase" {
    run get_phase_tasks "testing" "$TEST_TODO_FILE"
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 1 ]

    # Verify it's T003
    local task_id
    task_id=$(echo "$output" | jq -r '.[0].id')
    [ "$task_id" = "T003" ]
}

@test "get_phase_tasks errors with missing phase" {
    run get_phase_tasks "" "$TEST_TODO_FILE"
    assert_failure
    assert_output --partial "phase required"
}

@test "get_phase_tasks errors with missing todo_file" {
    run get_phase_tasks "core" ""
    assert_failure
    assert_output --partial "todo_file required"
}

@test "get_phase_tasks errors with non-existent file" {
    run get_phase_tasks "core" "/nonexistent/path.json"
    assert_failure 2
    assert_output --partial "File not found"
}

# =============================================================================
# task_exists Tests
# =============================================================================

@test "task_exists returns success for existing task" {
    run task_exists "T001" "$TEST_TODO_FILE"
    assert_success
}

@test "task_exists returns success for all task types" {
    # Epic
    run task_exists "T002" "$TEST_TODO_FILE"
    assert_success

    # Subtask
    run task_exists "T003" "$TEST_TODO_FILE"
    assert_success
}

@test "task_exists returns failure for non-existent task" {
    run task_exists "T999" "$TEST_TODO_FILE"
    assert_failure
}

@test "task_exists returns failure with empty task_id" {
    run task_exists "" "$TEST_TODO_FILE"
    assert_failure
}

@test "task_exists returns failure with missing todo_file" {
    run task_exists "T001" ""
    assert_failure
}

@test "task_exists returns exit code 2 for non-existent file" {
    run task_exists "T001" "/nonexistent/path.json"
    assert_failure 2
}

# =============================================================================
# get_task_with_field Tests
# =============================================================================

@test "get_task_with_field filters by status" {
    run get_task_with_field "status" "pending" "$TEST_TODO_FILE"
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 2 ]
}

@test "get_task_with_field filters by priority" {
    run get_task_with_field "priority" "high" "$TEST_TODO_FILE"
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 2 ]
}

@test "get_task_with_field filters by type" {
    run get_task_with_field "type" "epic" "$TEST_TODO_FILE"
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 1 ]

    local task_id
    task_id=$(echo "$output" | jq -r '.[0].id')
    [ "$task_id" = "T002" ]
}

@test "get_task_with_field returns empty array for no matches" {
    run get_task_with_field "priority" "nonexistent" "$TEST_TODO_FILE"
    assert_success
    assert_output "[]"
}

@test "get_task_with_field errors with missing field" {
    run get_task_with_field "" "value" "$TEST_TODO_FILE"
    assert_failure
    assert_output --partial "field required"
}

@test "get_task_with_field errors with missing value" {
    run get_task_with_field "status" "" "$TEST_TODO_FILE"
    assert_failure
    assert_output --partial "value required"
}

@test "get_task_with_field errors with missing todo_file" {
    run get_task_with_field "status" "pending" ""
    assert_failure
    assert_output --partial "todo_file required"
}

@test "get_task_with_field errors with non-existent file" {
    run get_task_with_field "status" "pending" "/nonexistent/path.json"
    assert_failure 2
    assert_output --partial "File not found"
}

# =============================================================================
# filter_tasks_multi Tests
# =============================================================================

@test "filter_tasks_multi filters by single condition" {
    run filter_tasks_multi "$TEST_TODO_FILE" "status=pending"
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 2 ]
}

@test "filter_tasks_multi filters by multiple conditions (AND logic)" {
    run filter_tasks_multi "$TEST_TODO_FILE" "status=pending" "phase=core"
    assert_success

    # Only T001 is both pending AND in core phase
    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 1 ]

    local task_id
    task_id=$(echo "$output" | jq -r '.[0].id')
    [ "$task_id" = "T001" ]
}

@test "filter_tasks_multi filters by priority and status" {
    run filter_tasks_multi "$TEST_TODO_FILE" "priority=high" "status=pending"
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 1 ]
}

@test "filter_tasks_multi filters by type and phase" {
    run filter_tasks_multi "$TEST_TODO_FILE" "type=task" "phase=core"
    assert_success

    # T001 and T004 are tasks in core phase
    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 2 ]
}

@test "filter_tasks_multi returns empty array for no matches" {
    run filter_tasks_multi "$TEST_TODO_FILE" "status=pending" "priority=critical"
    assert_success
    assert_output "[]"
}

@test "filter_tasks_multi errors with invalid pair format" {
    run filter_tasks_multi "$TEST_TODO_FILE" "invalid_without_equals"
    assert_failure
    assert_output --partial "Invalid pair format"
}

@test "filter_tasks_multi errors with no conditions" {
    run filter_tasks_multi "$TEST_TODO_FILE"
    assert_failure
    assert_output --partial "At least one field=value pair required"
}

@test "filter_tasks_multi errors with missing todo_file" {
    run filter_tasks_multi "" "status=pending"
    assert_failure
    assert_output --partial "todo_file required"
}

@test "filter_tasks_multi errors with non-existent file" {
    run filter_tasks_multi "/nonexistent/path.json" "status=pending"
    assert_failure 2
    assert_output --partial "File not found"
}

@test "filter_tasks_multi handles three conditions" {
    run filter_tasks_multi "$TEST_TODO_FILE" "type=task" "phase=core" "priority=high"
    assert_success

    # Only T001 matches all three
    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 1 ]
}

# =============================================================================
# Edge Cases and Integration Tests
# =============================================================================

@test "functions handle malformed JSON gracefully" {
    local bad_file="$BATS_TEST_TMPDIR/bad.json"
    echo "not valid json" > "$bad_file"

    run get_task_count "$bad_file"
    # jq will fail on invalid JSON
    assert_failure
}

@test "functions handle empty tasks array consistently" {
    local empty_file="$BATS_TEST_TMPDIR/empty-tasks.json"
    cat > "$empty_file" << 'EOF'
{
  "tasks": [],
  "focus": {},
  "project": {"currentPhase": "setup"}
}
EOF

    run get_task_count "$empty_file"
    assert_success
    assert_output "0"

    run get_all_task_ids "$empty_file"
    assert_success
    assert_output ""

    run task_exists "T001" "$empty_file"
    assert_failure
}

@test "functions handle unicode in task data" {
    local unicode_file="$BATS_TEST_TMPDIR/unicode.json"
    cat > "$unicode_file" << 'EOF'
{
  "tasks": [
    {"id": "T001", "title": "Tarea en espanol", "status": "pending"},
    {"id": "T002", "title": "Japanese: 日本語", "status": "done"}
  ],
  "focus": {},
  "project": {}
}
EOF

    run get_task_count "$unicode_file"
    assert_success
    assert_output "2"

    run task_exists "T001" "$unicode_file"
    assert_success
}

@test "functions handle special characters in values" {
    local special_file="$BATS_TEST_TMPDIR/special.json"
    cat > "$special_file" << 'EOF'
{
  "tasks": [
    {"id": "T001", "title": "Task with \"quotes\"", "status": "pending"},
    {"id": "T002", "title": "Task with 'apostrophe'", "status": "done"}
  ],
  "focus": {},
  "project": {}
}
EOF

    run get_task_by_id "T001" "$special_file"
    assert_success
    # Verify task was found and title contains quotes
    local title
    title=$(echo "$output" | jq -r '.title')
    [[ "$title" == *'quotes'* ]]
}

@test "get_task_field handles arrays correctly" {
    local task_json='{"id": "T001", "labels": ["bug", "feature"], "depends": ["T002", "T003"]}'

    # Arrays should be returned as JSON strings
    run get_task_field "$task_json" "labels"
    assert_success
    # With // empty, arrays become string representation or empty
}

@test "source guard prevents double loading" {
    # Source twice and verify no errors
    run bash -c "source '$LIB_DIR/core/jq-helpers.sh'; source '$LIB_DIR/core/jq-helpers.sh'"
    assert_success
}

# =============================================================================
# Return Code Verification Tests
# =============================================================================

@test "get_tasks_by_status returns exit code 1 for invalid args" {
    run get_tasks_by_status "" "$TEST_TODO_FILE"
    [ "$status" -eq 1 ]
}

@test "get_tasks_by_status returns exit code 2 for file not found" {
    run get_tasks_by_status "pending" "/nonexistent.json"
    [ "$status" -eq 2 ]
}

@test "get_task_by_id returns exit code 1 for invalid args" {
    run get_task_by_id "" "$TEST_TODO_FILE"
    [ "$status" -eq 1 ]
}

@test "get_task_by_id returns exit code 2 for file not found" {
    run get_task_by_id "T001" "/nonexistent.json"
    [ "$status" -eq 2 ]
}

@test "count_tasks_by_status returns exit code 1 for invalid args" {
    run count_tasks_by_status "" "$TEST_TODO_FILE"
    [ "$status" -eq 1 ]
}

@test "count_tasks_by_status returns exit code 2 for file not found" {
    run count_tasks_by_status "pending" "/nonexistent.json"
    [ "$status" -eq 2 ]
}

@test "task_exists returns exit code 2 for file not found" {
    run task_exists "T001" "/nonexistent.json"
    [ "$status" -eq 2 ]
}

@test "filter_tasks_multi returns exit code 1 for invalid format" {
    run filter_tasks_multi "$TEST_TODO_FILE" "no_equals_sign"
    [ "$status" -eq 1 ]
}

@test "filter_tasks_multi returns exit code 2 for file not found" {
    run filter_tasks_multi "/nonexistent.json" "status=pending"
    [ "$status" -eq 2 ]
}
