#!/usr/bin/env bats
# =============================================================================
# next.bats - Unit tests for next.sh (next task suggestion)
# =============================================================================
# Tests next task suggestion algorithm, scoring, dependency checks, and
# output formats.
# =============================================================================

# =============================================================================
# File-Level Setup (runs once per test file)
# =============================================================================
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

# =============================================================================
# Per-Test Setup (runs before each test)
# =============================================================================
setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test

    # Set NEXT_SCRIPT path
    export NEXT_SCRIPT="${SCRIPTS_DIR}/next.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Help and Basic Command Tests
# =============================================================================

@test "next --help shows usage" {
    create_empty_todo
    run bash "$NEXT_SCRIPT" --help
    assert_success
    assert_output --partial "Usage:"
    assert_output --partial "cleo next"
}

@test "next -h shows usage" {
    create_empty_todo
    run bash "$NEXT_SCRIPT" -h
    assert_success
    assert_output --partial "Usage:"
}

@test "next without options shows single suggestion" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT"
    assert_success
    refute_output ""
}

# =============================================================================
# Basic Suggestion Tests
# =============================================================================

@test "next suggests a pending task" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT"
    assert_success
    assert_output_contains_any "T001" "T002" "T003"
}

@test "next suggests highest priority task first" {
    create_empty_todo
    # Add tasks with different priorities
    jq '.tasks = [
        {"id": "T001", "title": "Low priority", "description": "Low", "status": "pending", "priority": "low", "createdAt": "2025-12-01T10:00:00Z"},
        {"id": "T002", "title": "High priority", "description": "High", "status": "pending", "priority": "high", "createdAt": "2025-12-01T11:00:00Z"},
        {"id": "T003", "title": "Medium priority", "description": "Medium", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T12:00:00Z"}
    ]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$NEXT_SCRIPT"
    assert_success
    # Should suggest T002 (high priority)
    assert_output --partial "T002"
}

@test "next suggests critical priority over high priority" {
    create_empty_todo
    jq '.tasks = [
        {"id": "T001", "title": "Critical task", "description": "Critical", "status": "pending", "priority": "critical", "createdAt": "2025-12-01T10:00:00Z"},
        {"id": "T002", "title": "High task", "description": "High", "status": "pending", "priority": "high", "createdAt": "2025-12-01T11:00:00Z"}
    ]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$NEXT_SCRIPT"
    assert_success
    assert_output --partial "T001"
}

# =============================================================================
# --explain Flag Tests
# =============================================================================

@test "next --explain shows reasoning" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" --explain
    assert_success
    assert_output_contains_any "Analysis" "Score" "priority"
}

@test "next -e shows reasoning" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" -e
    assert_success
    assert_output_contains_any "Analysis" "Score"
}

@test "next --explain shows scoring breakdown" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" --explain
    assert_success
    assert_output_contains_any "Scoring" "Priority:"
}

@test "next --explain shows dependency information" {
    create_linear_chain
    run bash "$NEXT_SCRIPT" --explain
    assert_success
    assert_output_contains_any "Dependencies" "satisfied"
}

# =============================================================================
# --count Option Tests
# =============================================================================

@test "next --count 3 shows three suggestions" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" --count 3
    assert_success
    # Should show multiple task IDs
    assert_output_contains_any "T001" "T002" "T003"
}

@test "next -n 2 shows two suggestions" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" -n 2
    assert_success
    refute_output ""
}

@test "next --count 0 shows error" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" --count 0
    assert_failure
    assert_output --partial "ERROR"
}

@test "next --count invalid shows error" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" --count abc
    assert_failure
    assert_output --partial "ERROR"
}

# =============================================================================
# Dependency Handling Tests
# =============================================================================

@test "next respects task dependencies" {
    create_linear_chain
    # T001 <- T002 <- T003
    # Should suggest T001 first (no dependencies)
    run bash "$NEXT_SCRIPT"
    assert_success
    assert_output --partial "T001"
}

@test "next does not suggest tasks with unmet dependencies" {
    create_linear_chain
    # Mark T001 as done
    jq '(.tasks[] | select(.id == "T001") | .status) = "done"' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$NEXT_SCRIPT"
    assert_success
    # Should now suggest T002 (T001 is done)
    assert_output --partial "T002"
}

@test "next handles multiple dependencies correctly" {
    create_complex_deps
    # T003 depends on both T001 and T002
    run bash "$NEXT_SCRIPT"
    assert_success
    # Should suggest T001 or T002 (independent tasks)
    assert_output_contains_any "T001" "T002"
}

@test "next suggests task when all dependencies are done" {
    create_linear_chain
    # Mark all dependencies as done except the last
    jq '(.tasks[] | select(.id == "T001" or .id == "T002") | .status) = "done"' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$NEXT_SCRIPT"
    assert_success
    # Should suggest T003 now
    assert_output --partial "T003"
}

# =============================================================================
# JSON Output Format Tests
# =============================================================================

@test "next --format json produces valid JSON" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" --format json
    assert_success
    assert_valid_json
}

@test "next -f json produces valid JSON" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" -f json
    assert_success
    assert_valid_json
}

@test "next JSON output has _meta.format field" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" --format json
    assert_success
    assert_json_has_key "_meta"
    run jq -e '._meta.format == "json"' <<< "$output"
    assert_success
}

@test "next JSON output has suggestions array" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" --format json
    assert_success
    assert_json_has_key "suggestions"
    run jq -e '.suggestions | type == "array"' <<< "$output"
    assert_success
}

@test "next JSON output has recommendation" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" --format json
    assert_success
    assert_json_has_key "recommendation"
}

@test "next JSON output includes scoring information" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" --format json
    assert_success
    run jq -e '.suggestions[0].scoring.priorityScore' <<< "$output"
    assert_success
}

# =============================================================================
# No Tasks Available Tests
# =============================================================================

@test "next handles empty todo list" {
    create_empty_todo
    run bash "$NEXT_SCRIPT"
    assert_success
    assert_output --partial "No tasks available"
}

@test "next handles all tasks completed" {
    create_tasks_with_completed
    # Mark all remaining tasks as done
    jq '(.tasks[] | .status) = "done"' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$NEXT_SCRIPT"
    assert_success
    assert_output --partial "No tasks available"
}

@test "next handles all tasks blocked by dependencies" {
    create_linear_chain
    # Set all tasks except T001 to blocked status
    jq '(.tasks[] | select(.id != "T001") | .status) = "blocked"' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$NEXT_SCRIPT"
    assert_success
    # Should still suggest T001 (it's pending and has no dependencies)
    assert_output --partial "T001"
}

@test "next --format json handles no tasks available" {
    create_empty_todo
    run bash "$NEXT_SCRIPT" --format json
    assert_success
    assert_valid_json
    # Store output before next run command overwrites it
    local json_output="$output"
    run jq -e '.suggestions | length == 0' <<< "$json_output"
    assert_success
    run jq -e '.recommendation == null' <<< "$json_output"
    assert_success
}

# =============================================================================
# Priority Scoring Tests
# =============================================================================

@test "next scoring: critical priority gets highest score" {
    create_empty_todo
    jq '.tasks = [
        {"id": "T001", "title": "Critical", "description": "C", "status": "pending", "priority": "critical", "createdAt": "2025-12-01T10:00:00Z"},
        {"id": "T002", "title": "Low", "description": "L", "status": "pending", "priority": "low", "createdAt": "2025-12-01T09:00:00Z"}
    ]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$NEXT_SCRIPT" --format json
    assert_success
    # First suggestion should be T001
    run jq -e '.suggestions[0].taskId == "T001"' <<< "$output"
    assert_success
}

@test "next scoring: older tasks break ties" {
    create_empty_todo
    jq '.tasks = [
        {"id": "T001", "title": "Newer", "description": "N", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T12:00:00Z"},
        {"id": "T002", "title": "Older", "description": "O", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T10:00:00Z"}
    ]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$NEXT_SCRIPT" --format json
    assert_success
    # First suggestion should be T002 (older)
    run jq -e '.suggestions[0].taskId == "T002"' <<< "$output"
    assert_success
}

@test "next scoring: phase bonus applies when matching focus" {
    create_empty_todo
    jq '.phases = {"setup": {"name": "Setup", "order": 1}} |
        .tasks = [
        {"id": "T001", "title": "Setup task", "description": "S", "status": "pending", "priority": "medium", "phase": "setup", "createdAt": "2025-12-01T10:00:00Z"},
        {"id": "T002", "title": "Other task", "description": "O", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T09:00:00Z"}
    ] |
    .focus.currentTask = "T001"' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$NEXT_SCRIPT" --format json
    assert_success
    # Should show phase bonus in scoring
    run jq -e '.suggestions[] | select(.taskId == "T001") | .scoring.phaseBonus > 0' <<< "$output"
    assert_success
}

# =============================================================================
# Exit Code Tests
# =============================================================================

@test "next exits 0 when suggestions found" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT"
    assert_success
}

@test "next exits successfully when no tasks available" {
    create_empty_todo
    run bash "$NEXT_SCRIPT"
    assert_success
}

# =============================================================================
# Error Handling Tests
# =============================================================================

@test "next handles missing todo.json" {
    rm -f "$TODO_FILE"
    run bash "$NEXT_SCRIPT"
    assert_failure
    assert_output --partial "ERROR"
}

@test "next handles invalid format option" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" --format invalid
    assert_failure
    assert_output --partial "ERROR"
}

@test "next handles unknown option" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" --unknown-option
    assert_failure
    assert_output --partial "ERROR"
}

# =============================================================================
# Command Suggestion Tests
# =============================================================================

@test "next shows command to start working" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT"
    assert_success
    assert_output --partial "cleo focus set"
}

@test "next JSON includes command in recommendation" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" --format json
    assert_success
    run jq -e '.recommendation.command | startswith("cleo focus set")' <<< "$output"
    assert_success
}

# =============================================================================
# Context Information Tests
# =============================================================================

@test "next JSON output includes context" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" --format json
    assert_success
    assert_json_has_key "context"
    run jq -e '.context.totalPending' <<< "$output"
    assert_success
}

@test "next --explain shows pending task count" {
    create_independent_tasks
    run bash "$NEXT_SCRIPT" --explain
    assert_success
    assert_output --partial "pending tasks"
}

@test "next --explain shows tasks blocked by dependencies" {
    create_linear_chain
    run bash "$NEXT_SCRIPT" --explain
    assert_success
    # When explaining, should mention blocked tasks if any exist
    refute_output ""
}

# =============================================================================
# Hierarchy Awareness Tests (T346)
# =============================================================================

@test "next prefers tasks in focused epic" {
    create_empty_todo
    local epic1=$(bash "$ADD_SCRIPT" "Epic 1" --type epic -q)
    local epic2=$(bash "$ADD_SCRIPT" "Epic 2" --type epic -q)
    local task1=$(bash "$ADD_SCRIPT" "Task in E1" --parent "$epic1" --priority medium -q)
    local task2=$(bash "$ADD_SCRIPT" "Task in E2" --parent "$epic2" --priority medium -q)

    # Focus on epic1
    bash "$FOCUS_SCRIPT" set "$epic1"

    run bash "$NEXT_SCRIPT"
    assert_success
    # Should suggest task in same epic
    assert_output --partial "$task1"
}

@test "next prefers leaf tasks" {
    create_empty_todo
    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    local parent_task=$(bash "$ADD_SCRIPT" "Parent Task" --parent "$epic" --priority medium -q)
    local leaf_task=$(bash "$ADD_SCRIPT" "Leaf Task" --parent "$epic" --priority medium -q)
    bash "$ADD_SCRIPT" "Subtask" --parent "$parent_task" --type subtask

    run bash "$NEXT_SCRIPT"
    assert_success
    # Should prefer leaf task (no children)
    assert_output --partial "$leaf_task"
}

@test "next shows parent context" {
    create_empty_todo
    local epic=$(bash "$ADD_SCRIPT" "Auth Epic" --type epic -q)
    local task=$(bash "$ADD_SCRIPT" "Implement JWT" --parent "$epic" -q)

    run bash "$NEXT_SCRIPT"
    assert_success
    assert_output --partial "Parent:"
    assert_output --partial "Auth Epic"
}
