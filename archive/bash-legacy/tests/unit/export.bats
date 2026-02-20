#!/usr/bin/env bats
# =============================================================================
# export.bats - Unit tests for export.sh
# =============================================================================
# Tests export functionality including TodoWrite, JSON, and Markdown formats.
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

@test "export script exists" {
    [ -f "$EXPORT_SCRIPT" ]
}

@test "export script is executable" {
    [ -x "$EXPORT_SCRIPT" ]
}

@test "todowrite integration library exists" {
    [ -f "$PROJECT_ROOT/lib/tasks/todowrite-integration.sh" ]
}

# =============================================================================
# Help and Usage Tests
# =============================================================================

@test "export --help shows usage" {
    run bash "$EXPORT_SCRIPT" --help
    assert_shows_help
}

@test "export -h shows usage" {
    run bash "$EXPORT_SCRIPT" -h
    assert_shows_help
}

@test "export help shows available formats" {
    run bash "$EXPORT_SCRIPT" --help
    assert_success
    assert_output_contains_any "todowrite" "json" "markdown"
}

# =============================================================================
# TodoWrite Format Tests
# =============================================================================

@test "export --format todowrite produces valid JSON" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format todowrite --quiet
    assert_success
    assert_valid_json
}

@test "export todowrite has todos array" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format todowrite --quiet
    assert_success

    local has_todos
    has_todos=$(echo "$output" | jq -e '.todos' > /dev/null 2>&1 && echo "yes" || echo "no")
    [ "$has_todos" = "yes" ]
}

@test "export todowrite todos have required fields" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format todowrite --quiet
    assert_success

    # Check first todo has content, activeForm, status
    local has_content has_activeform has_status
    has_content=$(echo "$output" | jq -e '.todos[0].content' > /dev/null 2>&1 && echo "yes" || echo "no")
    has_activeform=$(echo "$output" | jq -e '.todos[0].activeForm' > /dev/null 2>&1 && echo "yes" || echo "no")
    has_status=$(echo "$output" | jq -e '.todos[0].status' > /dev/null 2>&1 && echo "yes" || echo "no")

    [ "$has_content" = "yes" ]
    [ "$has_activeform" = "yes" ]
    [ "$has_status" = "yes" ]
}

@test "export todowrite applies grammar transformation" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format todowrite --quiet
    assert_success

    local content activeform
    content=$(echo "$output" | jq -r '.todos[0].content // empty')
    activeform=$(echo "$output" | jq -r '.todos[0].activeForm // empty')

    # activeForm should be different from content (grammar transformed)
    if [[ -n "$content" && -n "$activeform" ]]; then
        [ "$content" != "$activeform" ]
    fi
}

# =============================================================================
# JSON Format Tests
# =============================================================================

@test "export --format json produces valid JSON" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format json --quiet
    assert_success
    assert_valid_json
}

@test "export -f json short flag works" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" -f json --quiet
    assert_success
    assert_valid_json
}

# =============================================================================
# Markdown Format Tests
# =============================================================================

@test "export --format markdown produces markdown" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format markdown --quiet
    assert_success
    # Markdown should contain task markers or headers
    assert_output_contains_any "#" "-" "Task" "[" "]"
}

@test "export markdown includes task information" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format markdown --quiet
    assert_success
    # Should contain task titles or IDs
    assert_output_contains_any "T001" "T002" "First" "Second"
}

# =============================================================================
# Status Filter Tests
# =============================================================================

@test "export --status pending filters correctly" {
    create_tasks_with_completed
    run bash "$EXPORT_SCRIPT" --format todowrite --status pending --quiet
    assert_success

    # Should only have pending tasks
    local done_count
    done_count=$(echo "$output" | jq '[.todos[] | select(.status == "completed")] | length' 2>/dev/null || echo "0")
    [ "$done_count" -eq 0 ]
}

@test "export --status active filters correctly" {
    create_blocked_tasks
    run bash "$EXPORT_SCRIPT" --format todowrite --status active --quiet
    assert_success
}

@test "export multiple status filters work" {
    create_blocked_tasks
    run bash "$EXPORT_SCRIPT" --format todowrite --status pending,blocked --quiet
    assert_success
}

# =============================================================================
# Empty and Edge Cases
# =============================================================================

@test "export handles empty todo.json" {
    create_empty_todo
    run bash "$EXPORT_SCRIPT" --format todowrite --quiet
    assert_success

    local todos_count
    todos_count=$(echo "$output" | jq '.todos | length' 2>/dev/null || echo "0")
    [ "$todos_count" -eq 0 ]
}

@test "export handles missing todo.json" {
    rm -f "$TODO_FILE"
    run bash "$EXPORT_SCRIPT" --format json
    # Should handle gracefully
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
}

# =============================================================================
# Output Options Tests
# =============================================================================

@test "export --quiet suppresses informational output" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format json --quiet
    assert_success
    # Should only contain JSON, no info messages
}

@test "export to stdout by default" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format json --quiet
    assert_success
    # Output should be directly in $output
    [ -n "$output" ]
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "export preserves task relationships" {
    create_linear_chain
    run bash "$EXPORT_SCRIPT" --format json --quiet
    assert_success
    assert_valid_json
}

@test "export handles complex dependencies" {
    create_complex_deps
    run bash "$EXPORT_SCRIPT" --format todowrite --quiet
    assert_success
    assert_valid_json
}

@test "export success exit code for valid command" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format json --quiet
    assert_success
}

# =============================================================================
# CSV Format Tests
# =============================================================================

@test "export --format csv produces CSV output" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format csv --quiet
    assert_success
    refute_output ""
}

@test "export csv includes header row by default" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format csv --quiet
    assert_success
    assert_output --partial "id"
    assert_output --partial "status"
    assert_output --partial "title"
}

@test "export csv --no-header skips header row" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format csv --no-header --quiet
    assert_success
    # First line should be data, not header with quotes
    refute_output --partial '"id"'
}

@test "export csv quotes fields" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format csv --quiet
    assert_success
    # Should have quoted fields
    assert_output --partial '"'
}

@test "export csv custom delimiter works" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format csv --delimiter ';' --quiet
    assert_success
    assert_output --partial ";"
}

@test "export csv handles commas in content" {
    create_empty_todo
    jq '.tasks = [{"id": "T001", "title": "Task with, comma", "description": "D", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T10:00:00Z"}]' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$EXPORT_SCRIPT" --format csv --quiet
    assert_success
    # Comma should be inside quotes
    assert_output --partial "Task with, comma"
}

# =============================================================================
# TSV Format Tests
# =============================================================================

@test "export --format tsv produces tab-separated output" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format tsv --quiet
    assert_success
    refute_output ""
}

@test "export tsv includes header row by default" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format tsv --quiet
    assert_success
    # First line should be header with tabs
    local first_line=$(echo "$output" | head -1)
    [[ "$first_line" == *"id"*"status"*"title"* ]]
}

@test "export tsv --no-header skips header row" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format tsv --no-header --quiet
    assert_success
    # First line should start with task ID
    assert_output --regexp '^T[0-9]+'
}

# =============================================================================
# Max Tasks Option Tests
# =============================================================================

@test "export --max 1 limits to one task" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format json --max 1 --quiet
    assert_success
    # JSON export wraps output in _meta envelope, check .tasks length
    local count=$(echo "$output" | jq '.tasks | length')
    [[ "$count" -eq 1 ]]
}

@test "export --max 2 limits to two tasks" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format json --max 2 --quiet
    assert_success
    # JSON export wraps output in _meta envelope, check .tasks length
    local count=$(echo "$output" | jq '.tasks | length')
    [[ "$count" -le 2 ]]
}

# =============================================================================
# Output File Option Tests
# =============================================================================

@test "export --output writes to file" {
    create_independent_tasks
    local output_file="${TEST_TEMP_DIR}/export.json"
    run bash "$EXPORT_SCRIPT" --format json --output "$output_file" --quiet
    assert_success
    [[ -f "$output_file" ]]
}

@test "export --output file contains valid content" {
    create_independent_tasks
    local output_file="${TEST_TEMP_DIR}/export.json"
    run bash "$EXPORT_SCRIPT" --format json --output "$output_file" --quiet
    assert_success
    run jq '.' "$output_file"
    assert_success
}

# =============================================================================
# Status Mapping Tests (TodoWrite)
# =============================================================================

@test "export todowrite maps active to in_progress" {
    create_empty_todo
    jq '.tasks = [{"id": "T001", "title": "Active task", "description": "A", "status": "active", "priority": "medium", "createdAt": "2025-12-01T10:00:00Z"}]' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$EXPORT_SCRIPT" --format todowrite --status active --quiet
    assert_success
    run jq -e '.todos[] | select(.status == "in_progress")' <<< "$output"
    assert_success
}

@test "export todowrite maps done to completed" {
    create_tasks_with_completed
    run bash "$EXPORT_SCRIPT" --format todowrite --status done --quiet
    assert_success
    run jq -e '.todos[] | select(.status == "completed")' <<< "$output"
    assert_success
}

@test "export todowrite maps pending to pending" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format todowrite --quiet
    assert_success
    run jq -e '.todos[] | select(.status == "pending")' <<< "$output"
    assert_success
}

# =============================================================================
# Error Handling Tests
# =============================================================================

@test "export handles invalid format" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --format invalid
    assert_failure
    assert_output --partial "ERROR"
}

@test "export handles unknown option" {
    create_independent_tasks
    run bash "$EXPORT_SCRIPT" --unknown-option
    assert_failure
    assert_output --partial "ERROR"
}
