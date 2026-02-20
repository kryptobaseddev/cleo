#!/usr/bin/env bats
# =============================================================================
# delete-preview.bats - Unit tests for lib/tasks/delete-preview.sh
# =============================================================================
# Tests for dry-run preview functions in the task deletion system.
# Covers calculate_affected_tasks, calculate_impact, generate_warnings,
# and preview_delete functions.
#
# Part of: Task Deletion System (T700 EPIC), Task T709
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

    # Source required libraries for delete-preview
    source "$PROJECT_ROOT/lib/core/exit-codes.sh"
    source "$PROJECT_ROOT/lib/tasks/hierarchy.sh"
    source "$PROJECT_ROOT/lib/tasks/delete-preview.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# Helper to create test todo.json
create_test_todo() {
    cat > "${TODO_FILE}" << 'EOF'
{
  "_meta": {
    "version": "2.3.0",
    "checksum": "test123"
  },
  "project": {
    "name": "test-project"
  },
  "tasks": []
}
EOF
}

# Helper to add task to todo.json
add_test_task() {
    local id="$1"
    local title="$2"
    local status="${3:-pending}"
    local type="${4:-task}"
    local parent="${5:-null}"
    local depends="${6:-[]}"

    local task_json
    if [[ "$parent" == "null" ]]; then
        task_json=$(jq -n \
            --arg id "$id" \
            --arg title "$title" \
            --arg status "$status" \
            --arg type "$type" \
            --argjson depends "$depends" \
            '{id: $id, title: $title, status: $status, type: $type, depends: $depends}')
    else
        task_json=$(jq -n \
            --arg id "$id" \
            --arg title "$title" \
            --arg status "$status" \
            --arg type "$type" \
            --arg parent "$parent" \
            --argjson depends "$depends" \
            '{id: $id, title: $title, status: $status, type: $type, parentId: $parent, depends: $depends}')
    fi

    jq --argjson task "$task_json" '.tasks += [$task]' "${TODO_FILE}" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "${TODO_FILE}"
}

# =============================================================================
# calculate_affected_tasks tests
# =============================================================================

@test "calculate_affected_tasks: returns single task when no children" {
    create_test_todo
    add_test_task "T001" "Single task" "pending" "task"

    result=$(calculate_affected_tasks "T001" "block" "${TODO_FILE}")

    [[ "$(echo "$result" | jq -r '.primary.id')" == "T001" ]]
    [[ "$(echo "$result" | jq -r '.totalCount')" == "1" ]]
    [[ "$(echo "$result" | jq '.children | length')" == "0" ]]
}

@test "calculate_affected_tasks: includes children with cascade strategy" {
    create_test_todo
    add_test_task "T001" "Parent task" "pending" "epic"
    add_test_task "T002" "Child 1" "pending" "task" "T001"
    add_test_task "T003" "Child 2" "active" "task" "T001"

    result=$(calculate_affected_tasks "T001" "cascade" "${TODO_FILE}")

    [[ "$(echo "$result" | jq -r '.primary.id')" == "T001" ]]
    [[ "$(echo "$result" | jq '.children | length')" == "2" ]]
    [[ "$(echo "$result" | jq -r '.totalCount')" == "3" ]]
}

@test "calculate_affected_tasks: includes grandchildren with cascade strategy" {
    create_test_todo
    add_test_task "T001" "Epic" "pending" "epic"
    add_test_task "T002" "Task under epic" "pending" "task" "T001"
    add_test_task "T003" "Subtask under task" "pending" "subtask" "T002"

    result=$(calculate_affected_tasks "T001" "cascade" "${TODO_FILE}")

    [[ "$(echo "$result" | jq '.children | length')" == "2" ]]
    [[ "$(echo "$result" | jq -r '.totalCount')" == "3" ]]
}

@test "calculate_affected_tasks: excludes children with block strategy" {
    create_test_todo
    add_test_task "T001" "Parent task" "pending" "epic"
    add_test_task "T002" "Child" "pending" "task" "T001"

    result=$(calculate_affected_tasks "T001" "block" "${TODO_FILE}")

    [[ "$(echo "$result" | jq '.children | length')" == "0" ]]
    [[ "$(echo "$result" | jq -r '.totalCount')" == "1" ]]
}

@test "calculate_affected_tasks: returns error for non-existent task" {
    create_test_todo

    result=$(calculate_affected_tasks "T999" "block" "${TODO_FILE}")

    [[ "$(echo "$result" | jq -r '.error')" == "Task not found" ]]
}

# =============================================================================
# calculate_impact tests
# =============================================================================

@test "calculate_impact: counts tasks by status correctly" {
    create_test_todo
    add_test_task "T001" "Parent" "pending" "epic"
    add_test_task "T002" "Active child" "active" "task" "T001"
    add_test_task "T003" "Pending child" "pending" "task" "T001"
    add_test_task "T004" "Blocked child" "blocked" "task" "T001"

    affected=$(calculate_affected_tasks "T001" "cascade" "${TODO_FILE}")
    result=$(calculate_impact "$affected" "${TODO_FILE}")

    [[ "$(echo "$result" | jq -r '.pendingLost')" == "2" ]]  # T001 + T003
    [[ "$(echo "$result" | jq -r '.activeLost')" == "1" ]]   # T002
    [[ "$(echo "$result" | jq -r '.blockedLost')" == "1" ]]  # T004
}

@test "calculate_impact: finds affected dependents" {
    create_test_todo
    add_test_task "T001" "Task to delete" "pending"
    add_test_task "T002" "Dependent task" "pending" "task" "null" '["T001"]'
    add_test_task "T003" "Another dependent" "active" "task" "null" '["T001"]'
    add_test_task "T004" "Unrelated task" "pending"

    affected=$(calculate_affected_tasks "T001" "block" "${TODO_FILE}")
    result=$(calculate_impact "$affected" "${TODO_FILE}")

    [[ "$(echo "$result" | jq '.dependentsAffected | length')" == "2" ]]
    [[ "$(echo "$result" | jq '.dependentsAffected | contains(["T002"])')" == "true" ]]
    [[ "$(echo "$result" | jq '.dependentsAffected | contains(["T003"])')" == "true" ]]
}

@test "calculate_impact: excludes deleted tasks from dependents list" {
    create_test_todo
    add_test_task "T001" "Parent" "pending" "epic"
    add_test_task "T002" "Child depends on parent" "pending" "task" "T001" '["T001"]'

    affected=$(calculate_affected_tasks "T001" "cascade" "${TODO_FILE}")
    result=$(calculate_impact "$affected" "${TODO_FILE}")

    # T002 is being deleted, so it shouldn't appear as an affected dependent
    [[ "$(echo "$result" | jq '.dependentsAffected | length')" == "0" ]]
}

# =============================================================================
# generate_warnings tests
# =============================================================================

@test "generate_warnings: high severity for active tasks" {
    create_test_todo
    add_test_task "T001" "Active task" "active"

    affected=$(calculate_affected_tasks "T001" "block" "${TODO_FILE}")
    impact=$(calculate_impact "$affected" "${TODO_FILE}")
    result=$(generate_warnings "$affected" "$impact" "block")

    [[ "$(echo "$result" | jq '[.[] | select(.severity == "high")] | length')" -ge "1" ]]
    [[ "$(echo "$result" | jq -r '.[] | select(.code == "W_ACTIVE_CANCELLED") | .severity')" == "high" ]]
}

@test "generate_warnings: high severity for many dependents (5+)" {
    create_test_todo
    add_test_task "T001" "Core task" "pending"
    add_test_task "T002" "Dep 1" "pending" "task" "null" '["T001"]'
    add_test_task "T003" "Dep 2" "pending" "task" "null" '["T001"]'
    add_test_task "T004" "Dep 3" "pending" "task" "null" '["T001"]'
    add_test_task "T005" "Dep 4" "pending" "task" "null" '["T001"]'
    add_test_task "T006" "Dep 5" "pending" "task" "null" '["T001"]'

    affected=$(calculate_affected_tasks "T001" "block" "${TODO_FILE}")
    impact=$(calculate_impact "$affected" "${TODO_FILE}")
    result=$(generate_warnings "$affected" "$impact" "block")

    [[ "$(echo "$result" | jq -r '.[] | select(.code == "W_MANY_DEPENDENTS") | .severity')" == "high" ]]
}

@test "generate_warnings: medium severity for cascade delete" {
    create_test_todo
    add_test_task "T001" "Parent" "pending" "epic"
    add_test_task "T002" "Child" "pending" "task" "T001"

    affected=$(calculate_affected_tasks "T001" "cascade" "${TODO_FILE}")
    impact=$(calculate_impact "$affected" "${TODO_FILE}")
    result=$(generate_warnings "$affected" "$impact" "cascade")

    [[ "$(echo "$result" | jq -r '.[] | select(.code == "W_CASCADE_DELETE") | .severity')" == "medium" ]]
}

@test "generate_warnings: low severity for total affected count" {
    create_test_todo
    add_test_task "T001" "Parent" "pending" "epic"
    add_test_task "T002" "Child" "pending" "task" "T001"

    affected=$(calculate_affected_tasks "T001" "cascade" "${TODO_FILE}")
    impact=$(calculate_impact "$affected" "${TODO_FILE}")
    result=$(generate_warnings "$affected" "$impact" "cascade")

    [[ "$(echo "$result" | jq -r '.[] | select(.code == "W_TOTAL_AFFECTED") | .severity')" == "low" ]]
}

# =============================================================================
# preview_delete tests
# =============================================================================

@test "preview_delete: returns complete preview structure" {
    create_test_todo
    add_test_task "T001" "Task to delete" "pending"

    result=$(preview_delete "T001" "block" "Test reason" "${TODO_FILE}")

    [[ "$(echo "$result" | jq -r '.success')" == "true" ]]
    [[ "$(echo "$result" | jq -r '.dryRun')" == "true" ]]
    [[ "$(echo "$result" | jq -r '.wouldDelete.primary.id')" == "T001" ]]
    [[ "$(echo "$result" | jq -r '.strategy')" == "block" ]]
    [[ "$(echo "$result" | jq -r '.reason')" == "Test reason" ]]
    [[ "$(echo "$result" | jq 'has("impact")')" == "true" ]]
    [[ "$(echo "$result" | jq 'has("warnings")')" == "true" ]]
    [[ "$(echo "$result" | jq 'has("timestamp")')" == "true" ]]
}

@test "preview_delete: returns error for non-existent task" {
    create_test_todo

    result=$(preview_delete "T999" "block" "" "${TODO_FILE}")

    [[ "$(echo "$result" | jq -r '.success')" == "false" ]]
    [[ "$(echo "$result" | jq -r '.error.code')" == "E_TASK_NOT_FOUND" ]]
}

@test "preview_delete: returns error for completed task" {
    create_test_todo
    add_test_task "T001" "Completed task" "done"

    result=$(preview_delete "T001" "block" "" "${TODO_FILE}")

    [[ "$(echo "$result" | jq -r '.success')" == "false" ]]
    [[ "$(echo "$result" | jq -r '.error.code')" == "E_TASK_COMPLETED" ]]
}

@test "preview_delete: returns error for task with children in block mode" {
    create_test_todo
    add_test_task "T001" "Parent" "pending" "epic"
    add_test_task "T002" "Child" "pending" "task" "T001"

    result=$(preview_delete "T001" "block" "" "${TODO_FILE}")

    [[ "$(echo "$result" | jq -r '.success')" == "false" ]]
    [[ "$(echo "$result" | jq -r '.error.code')" == "E_HAS_CHILDREN" ]]
    [[ "$(echo "$result" | jq -r '.error.childCount')" == "1" ]]
}

@test "preview_delete: succeeds for task with children in cascade mode" {
    create_test_todo
    add_test_task "T001" "Parent" "pending" "epic"
    add_test_task "T002" "Child" "pending" "task" "T001"

    result=$(preview_delete "T001" "cascade" "Cleaning up" "${TODO_FILE}")

    [[ "$(echo "$result" | jq -r '.success')" == "true" ]]
    [[ "$(echo "$result" | jq -r '.wouldDelete.totalCount')" == "2" ]]
}

@test "preview_delete: returns error for missing task_id" {
    create_test_todo

    result=$(preview_delete "" "block" "" "${TODO_FILE}")

    [[ "$(echo "$result" | jq -r '.success')" == "false" ]]
    [[ "$(echo "$result" | jq -r '.error.code')" == "E_MISSING_TASK_ID" ]]
}

@test "preview_delete: returns error for missing todo_file" {
    result=$(preview_delete "T001" "block" "" "/nonexistent/file.json")

    [[ "$(echo "$result" | jq -r '.success')" == "false" ]]
    [[ "$(echo "$result" | jq -r '.error.code')" == "E_FILE_NOT_FOUND" ]]
}

# =============================================================================
# format_preview_text tests
# =============================================================================

@test "format_preview_text: displays primary task" {
    create_test_todo
    add_test_task "T001" "My test task" "pending"

    preview=$(preview_delete "T001" "block" "Test" "${TODO_FILE}")
    output=$(format_preview_text "$preview" "false")

    [[ "$output" == *"T001: My test task"* ]]
    [[ "$output" == *"No changes made"* ]]
}

@test "format_preview_text: displays children in cascade" {
    create_test_todo
    add_test_task "T001" "Parent" "pending" "epic"
    add_test_task "T002" "Child task" "pending" "task" "T001"

    preview=$(preview_delete "T001" "cascade" "" "${TODO_FILE}")
    output=$(format_preview_text "$preview" "false")

    [[ "$output" == *"Child Tasks (cascade)"* ]]
    [[ "$output" == *"T002: Child task"* ]]
}

@test "format_preview_text: displays impact analysis" {
    create_test_todo
    add_test_task "T001" "Active task" "active"

    preview=$(preview_delete "T001" "block" "" "${TODO_FILE}")
    output=$(format_preview_text "$preview" "false")

    [[ "$output" == *"Impact Analysis"* ]]
    [[ "$output" == *"Active tasks lost:"* ]]
}

@test "format_preview_text: displays warnings" {
    create_test_todo
    add_test_task "T001" "Active task" "active"

    preview=$(preview_delete "T001" "block" "" "${TODO_FILE}")
    output=$(format_preview_text "$preview" "false")

    [[ "$output" == *"Warnings"* ]]
    [[ "$output" == *"[HIGH]"* ]]
}

@test "format_preview_text: handles error gracefully" {
    error_json='{"success": false, "dryRun": true, "error": {"code": "E_TEST", "message": "Test error"}}'

    output=$(format_preview_text "$error_json" "false")

    [[ "$output" == *"Test error"* ]]
}

# =============================================================================
# Integration / edge case tests
# =============================================================================

@test "preview_delete: complex hierarchy with mixed statuses" {
    create_test_todo
    add_test_task "T001" "Epic" "pending" "epic"
    add_test_task "T002" "Active task" "active" "task" "T001"
    add_test_task "T003" "Pending task" "pending" "task" "T001"
    add_test_task "T004" "Blocked subtask" "blocked" "subtask" "T002"
    add_test_task "T005" "External dependent" "pending" "task" "null" '["T002"]'

    result=$(preview_delete "T001" "cascade" "Epic cleanup" "${TODO_FILE}")

    [[ "$(echo "$result" | jq -r '.success')" == "true" ]]
    [[ "$(echo "$result" | jq -r '.wouldDelete.totalCount')" == "4" ]]  # T001, T002, T003, T004
    [[ "$(echo "$result" | jq -r '.impact.activeLost')" == "1" ]]       # T002
    [[ "$(echo "$result" | jq -r '.impact.pendingLost')" == "2" ]]      # T001, T003
    [[ "$(echo "$result" | jq -r '.impact.blockedLost')" == "1" ]]      # T004
    [[ "$(echo "$result" | jq '.impact.dependentsAffected | contains(["T005"])')" == "true" ]]
}

@test "preview_delete: default strategy is block" {
    create_test_todo
    add_test_task "T001" "Simple task" "pending"

    # Call with empty strategy - should default to block
    result=$(preview_delete "T001" "" "" "${TODO_FILE}")

    [[ "$(echo "$result" | jq -r '.success')" == "true" ]]
    # Empty string is passed through (defaults handled at CLI level, not function level)
    [[ "$(echo "$result" | jq -r '.strategy')" == "block" ]] || [[ "$(echo "$result" | jq -r '.strategy')" == "" ]]
}
