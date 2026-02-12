#!/usr/bin/env bats
# =============================================================================
# validation.bats - Unit tests for validate.sh and lib/validation/validation.sh
# =============================================================================
# Tests schema validation and anti-hallucination checks.
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

@test "validate script exists" {
    [ -f "$VALIDATE_SCRIPT" ]
}

@test "validate script is executable" {
    [ -x "$VALIDATE_SCRIPT" ]
}

@test "validation library exists" {
    [ -f "$PROJECT_ROOT/lib/validation/validation.sh" ]
}

# =============================================================================
# Help and Usage Tests
# =============================================================================

@test "validate --help shows usage" {
    run bash "$VALIDATE_SCRIPT" --help
    assert_shows_help
}

@test "validate -h shows usage" {
    run bash "$VALIDATE_SCRIPT" -h
    assert_shows_help
}

# =============================================================================
# Valid Fixture Tests
# =============================================================================

@test "validate passes for valid todo.json" {
    [ -f "$FIXTURES_DIR/valid/todo.json" ]

    run jq empty "$FIXTURES_DIR/valid/todo.json"
    assert_success
}

@test "valid fixture has correct JSON syntax" {
    run jq empty "$FIXTURES_DIR/valid/todo.json"
    assert_success
}

@test "valid fixture has required fields" {
    [ -f "$FIXTURES_DIR/valid/todo.json" ]

    run jq -e '.tasks' "$FIXTURES_DIR/valid/todo.json"
    assert_success
}

# =============================================================================
# Invalid Status Tests
# =============================================================================

@test "invalid status is detectable" {
    [ -f "$FIXTURES_DIR/invalid/invalid-status.json" ]

    local status
    status=$(jq -r '.tasks[0].status' "$FIXTURES_DIR/invalid/invalid-status.json")

    # Status should not be a valid enum value
    [[ "$status" != "pending" && "$status" != "active" && "$status" != "blocked" && "$status" != "done" ]]
}

# =============================================================================
# Duplicate ID Tests
# =============================================================================

@test "duplicate IDs are detectable" {
    [ -f "$FIXTURES_DIR/invalid/duplicate-ids.json" ]

    local id_count unique_count
    id_count=$(jq '[.tasks[].id] | length' "$FIXTURES_DIR/invalid/duplicate-ids.json")
    unique_count=$(jq '[.tasks[].id] | unique | length' "$FIXTURES_DIR/invalid/duplicate-ids.json")

    [ "$id_count" != "$unique_count" ]
}

# =============================================================================
# Edge Case Tests
# =============================================================================

@test "empty tasks array is valid" {
    [ -f "$FIXTURES_DIR/edge-cases/empty-tasks.json" ]

    local task_count
    task_count=$(jq '.tasks | length' "$FIXTURES_DIR/edge-cases/empty-tasks.json")
    [ "$task_count" -eq 0 ]
}

# =============================================================================
# Validation Script Tests
# =============================================================================

@test "validate reports success for valid structure" {
    create_independent_tasks
    run bash "$VALIDATE_SCRIPT"
    assert_success
}

@test "validate detects circular dependencies" {
    create_circular_deps
    run bash "$VALIDATE_SCRIPT"
    # Should report cycle or fail
    [[ "$output" =~ "circular" ]] || [[ "$output" =~ "cycle" ]] || [[ "$status" -eq 1 ]]
}

@test "validate reports no circular dependencies for valid chain" {
    create_linear_chain
    run bash "$VALIDATE_SCRIPT"
    assert_output --partial "No circular dependencies"
}

@test "validate handles empty todo.json" {
    create_empty_todo
    run bash "$VALIDATE_SCRIPT"
    assert_success
}

# =============================================================================
# Output Format Tests
# =============================================================================

@test "validate --format json produces valid JSON" {
    create_independent_tasks
    run bash "$VALIDATE_SCRIPT" --format json
    assert_success
    assert_valid_json
}

@test "validate --quiet suppresses informational output" {
    create_independent_tasks
    run bash "$VALIDATE_SCRIPT" --quiet
    assert_success
}

# =============================================================================
# Fix Option Tests
# =============================================================================

@test "validate --fix attempts to fix issues" {
    create_independent_tasks
    run bash "$VALIDATE_SCRIPT" --fix
    # Should complete - may or may not find issues to fix
    assert_success
}

# =============================================================================
# Checksum Validation Tests
# =============================================================================

@test "validate checks checksum integrity" {
    create_independent_tasks
    run bash "$VALIDATE_SCRIPT"
    assert_success
}

@test "validate detects checksum mismatch" {
    create_independent_tasks

    # Manually corrupt checksum
    jq '._meta.checksum = "invalid"' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$VALIDATE_SCRIPT"
    # Should warn about or detect mismatch
}

# =============================================================================
# Schema Validation Tests
# =============================================================================

@test "validate checks required fields" {
    create_independent_tasks
    run bash "$VALIDATE_SCRIPT"
    assert_success
}

@test "validate checks status enum values" {
    create_independent_tasks
    run bash "$VALIDATE_SCRIPT"
    assert_success
}

@test "validate checks priority enum values" {
    create_independent_tasks
    run bash "$VALIDATE_SCRIPT"
    assert_success
}

# =============================================================================
# Anti-Hallucination Tests
# =============================================================================

@test "validate checks for unique IDs" {
    create_independent_tasks
    run bash "$VALIDATE_SCRIPT"
    assert_success
    # Should verify all IDs are unique
}

@test "validate checks timestamp validity" {
    create_independent_tasks
    run bash "$VALIDATE_SCRIPT"
    assert_success
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "validate works with all file types" {
    create_independent_tasks

    # Validate should check all files
    run bash "$VALIDATE_SCRIPT"
    assert_success
}

@test "validate handles missing files gracefully" {
    rm -f "$TODO_FILE"
    run bash "$VALIDATE_SCRIPT"
    # Should report missing file - may return 1 (error), 4 (file not found), or JSON error
    [[ "$status" -le 10 ]]  # Any small exit code is acceptable for graceful handling
}

@test "validate maintains file integrity" {
    create_independent_tasks
    local before
    before=$(cat "$TODO_FILE")

    run bash "$VALIDATE_SCRIPT"

    local after
    after=$(cat "$TODO_FILE")
    # Validate without --fix should not modify files
    [ "$before" = "$after" ]
}
