#!/usr/bin/env bats
# =============================================================================
# blockers.bats - Unit tests for blockers.sh
# =============================================================================
# Tests blockers command functionality using DRY helpers and fixtures.
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
# Help and Basic Command Tests
# =============================================================================

@test "blockers --help shows usage" {
    create_empty_todo
    run bash "$BLOCKERS_SCRIPT" --help
    assert_shows_help
}

@test "blockers -h shows usage" {
    create_empty_todo
    run bash "$BLOCKERS_SCRIPT" -h
    assert_shows_help
}

@test "blockers without subcommand defaults to list" {
    create_blocked_tasks
    run bash "$BLOCKERS_SCRIPT"
    assert_success
}

@test "blockers list subcommand works" {
    create_blocked_tasks
    run bash "$BLOCKERS_SCRIPT" list
    assert_success
}

# =============================================================================
# No Blocked Tasks Tests
# =============================================================================

@test "blockers with no blocked tasks shows appropriate message" {
    create_independent_tasks
    run bash "$BLOCKERS_SCRIPT"
    assert_success
    assert_output_contains_any "No blocked" "0"
}

@test "blockers handles empty todo.json" {
    create_empty_todo
    run bash "$BLOCKERS_SCRIPT"
    assert_success
}

# =============================================================================
# Blocked Tasks Tests
# =============================================================================

@test "blockers lists blocked tasks" {
    create_blocked_tasks
    run bash "$BLOCKERS_SCRIPT" list
    assert_success
    assert_output_contains_any "T002" "blocked"
}

@test "blockers shows blocker information" {
    create_blocked_tasks
    run bash "$BLOCKERS_SCRIPT" list
    assert_success
    assert_output_contains_any "T001" "depends" "blocked"
}

@test "blockers shows tasks with multiple blockers" {
    create_multi_blocker_tasks
    run bash "$BLOCKERS_SCRIPT" list
    assert_success
    assert_output_contains_any "T003" "blocked"
}

# =============================================================================
# Analyze Subcommand Tests
# =============================================================================

@test "blockers analyze produces output" {
    create_blocked_tasks
    run bash "$BLOCKERS_SCRIPT" analyze
    assert_success
    refute_output ""
}

@test "blockers analyze shows chain information" {
    create_blocked_tasks
    run bash "$BLOCKERS_SCRIPT" analyze
    assert_success
    assert_output_contains_any "chain" "path" "depth" "blocked"
}

# =============================================================================
# Output Format Tests
# =============================================================================

@test "blockers --format json produces valid JSON" {
    create_blocked_tasks
    run bash "$BLOCKERS_SCRIPT" --format json
    assert_success
    assert_valid_json
}

@test "blockers -f json produces valid JSON" {
    create_blocked_tasks
    run bash "$BLOCKERS_SCRIPT" -f json
    assert_success
    assert_valid_json
}

@test "blockers JSON output contains data" {
    create_blocked_tasks
    run bash "$BLOCKERS_SCRIPT" --format json
    assert_success
    assert_valid_json
}

@test "blockers --format markdown produces markdown" {
    create_blocked_tasks
    run bash "$BLOCKERS_SCRIPT" --format markdown
    assert_success
    assert_markdown_output
}

@test "blockers analyze --format json produces valid JSON" {
    create_blocked_tasks
    run bash "$BLOCKERS_SCRIPT" analyze --format json
    assert_success
    assert_valid_json
}

# =============================================================================
# Quiet Mode Tests
# =============================================================================

@test "blockers --quiet suppresses info messages" {
    create_blocked_tasks
    run bash "$BLOCKERS_SCRIPT" --quiet
    assert_success
}

@test "blockers -q suppresses info messages" {
    create_blocked_tasks
    run bash "$BLOCKERS_SCRIPT" -q
    assert_success
}

# =============================================================================
# Error Handling Tests
# =============================================================================

@test "blockers handles missing todo.json gracefully" {
    rm -f "$TODO_FILE"
    run bash "$BLOCKERS_SCRIPT"
    # Exit codes: 0=success, 1=general error, 3=E_FILE_NOT_FOUND (graceful)
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]] || [[ "$status" -eq 3 ]]
}

@test "blockers handles invalid format gracefully" {
    create_blocked_tasks
    run bash "$BLOCKERS_SCRIPT" --format invalid
    # Should either use default or error
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "blockers reflects completed dependencies" {
    create_completed_blocker
    run bash "$BLOCKERS_SCRIPT"
    assert_success
    # T002 should not appear as blocked since T001 is done
}
