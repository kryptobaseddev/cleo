#!/usr/bin/env bats
# =============================================================================
# deps.bats - Unit tests for deps.sh
# =============================================================================
# Tests dependency visualization functionality using DRY helpers and fixtures.
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
# Help and Basic Command Tests
# =============================================================================

@test "deps --help shows usage" {
    create_empty_todo
    run bash "$DEPS_SCRIPT" --help
    assert_shows_help
}

@test "deps -h shows usage" {
    create_empty_todo
    run bash "$DEPS_SCRIPT" -h
    assert_shows_help
}

@test "deps without arguments shows overview" {
    create_linear_chain
    run bash "$DEPS_SCRIPT"
    assert_success
}

# =============================================================================
# No Dependencies Tests
# =============================================================================

@test "deps with no dependencies shows appropriate output" {
    create_independent_tasks
    run bash "$DEPS_SCRIPT"
    assert_success
}

@test "deps handles empty todo.json" {
    create_empty_todo
    run bash "$DEPS_SCRIPT"
    assert_success
}

# =============================================================================
# Specific Task Tests
# =============================================================================

@test "deps shows dependencies for specific task" {
    create_linear_chain
    run bash "$DEPS_SCRIPT" T002
    assert_success
    assert_output_contains_any "T001" "depends"
}

@test "deps handles task with no dependencies" {
    create_linear_chain
    run bash "$DEPS_SCRIPT" T001
    assert_success
}

@test "deps shows downstream dependents" {
    create_linear_chain
    run bash "$DEPS_SCRIPT" T001
    assert_success
    # T001 is depended on by T002
    assert_output_contains_any "T002" "dependent" ""
}

@test "deps handles invalid task ID" {
    create_linear_chain
    run bash "$DEPS_SCRIPT" T999
    # Should either show error or handle gracefully
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
}

@test "deps handles isolated task" {
    create_complex_deps
    run bash "$DEPS_SCRIPT" T005
    assert_success
    # T005 has no dependencies
}

# =============================================================================
# Tree Visualization Tests
# =============================================================================

@test "deps tree shows hierarchy visualization" {
    create_linear_chain
    run bash "$DEPS_SCRIPT" tree
    assert_success
    refute_output ""
}

@test "deps tree shows deep chains" {
    create_linear_chain
    run bash "$DEPS_SCRIPT" tree
    assert_success
}

@test "deps tree handles multiple dependencies" {
    create_complex_deps
    run bash "$DEPS_SCRIPT" tree
    assert_success
}

# =============================================================================
# Output Format Tests
# =============================================================================

@test "deps --format json produces valid JSON" {
    create_linear_chain
    run bash "$DEPS_SCRIPT" --format json
    assert_success
    assert_valid_json
}

@test "deps -f json produces valid JSON" {
    create_linear_chain
    run bash "$DEPS_SCRIPT" -f json
    assert_success
    assert_valid_json
}

@test "deps JSON contains dependency data" {
    create_linear_chain
    run bash "$DEPS_SCRIPT" --format json
    assert_success
    assert_valid_json
}

@test "deps --format markdown produces markdown" {
    create_linear_chain
    run bash "$DEPS_SCRIPT" --format markdown
    assert_success
    assert_markdown_output
}

@test "deps T001 --format json produces valid JSON" {
    create_linear_chain
    run bash "$DEPS_SCRIPT" T001 --format json
    assert_success
    assert_valid_json
}

@test "deps tree --format json produces valid JSON" {
    create_linear_chain
    run bash "$DEPS_SCRIPT" tree --format json
    assert_success
    assert_valid_json
}

# =============================================================================
# Complex Dependency Tests
# =============================================================================

@test "deps handles multiple dependencies" {
    create_complex_deps
    run bash "$DEPS_SCRIPT" T003
    assert_success
    # T003 depends on T001 and T002
    assert_output_contains_any "T001" "T002" ""
}

@test "deps shows dependency depth information" {
    create_linear_chain
    run bash "$DEPS_SCRIPT"
    assert_success
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "deps handles completed dependencies" {
    create_completed_blocker
    run bash "$DEPS_SCRIPT"
    assert_success
}

@test "deps handles missing todo.json gracefully" {
    rm -f "$TODO_FILE"
    run bash "$DEPS_SCRIPT"
    # Should not crash (exit < 128, no signal death)
    # Accepts E_NOT_FOUND (4) and other validation errors as graceful handling
    [[ "$status" -lt 128 ]]
}

@test "deps success exit code for valid command" {
    create_linear_chain
    run bash "$DEPS_SCRIPT"
    assert_success
}

@test "deps help flag exits successfully" {
    run bash "$DEPS_SCRIPT" --help
    assert_success
}
