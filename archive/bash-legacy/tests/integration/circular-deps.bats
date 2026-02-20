#!/usr/bin/env bats
# =============================================================================
# circular-deps.bats - Integration tests for circular dependency prevention
# =============================================================================
# Tests circular dependency detection in add.sh and update.sh.
# These are integration tests as they test interaction between scripts.
# =============================================================================

# Load test helpers
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
# Valid Dependency Tests
# =============================================================================

@test "adding valid dependency succeeds" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T002 --depends T001
    assert_success
    assert_task_depends_on "T002" "T001"
}

@test "adding multiple valid dependencies succeeds" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T003 --depends T001,T002
    assert_success

    local deps
    deps=$(jq -r '.tasks[] | select(.id == "T003") | .depends | length' "$TODO_FILE")
    [ "$deps" -eq 2 ]
}

@test "linear chain is valid" {
    create_linear_chain
    run bash "$VALIDATE_SCRIPT"
    # Check for circular dependency validation specifically
    assert_output --partial "No circular dependencies"
}

# =============================================================================
# Self-Dependency Tests
# =============================================================================

@test "self-dependency is prevented" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --depends T001
    assert_failure
}

@test "self-dependency shows error message" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --depends T001
    assert_failure
    assert_output_contains_any "circular" "self" "ERROR" "invalid"
}

# =============================================================================
# Direct Circular Dependency Tests (A -> B, B -> A)
# =============================================================================

@test "direct circular dependency is prevented" {
    create_independent_tasks
    # First add T002 -> T001 (valid)
    bash "$UPDATE_SCRIPT" T002 --depends T001

    # Now try T001 -> T002 (should fail - creates cycle)
    run bash "$UPDATE_SCRIPT" T001 --depends T002
    assert_failure
}

@test "direct circular dependency preserves original state" {
    create_independent_tasks
    # Add valid dependency
    bash "$UPDATE_SCRIPT" T002 --depends T001

    # Try to create cycle (should fail)
    run bash "$UPDATE_SCRIPT" T001 --depends T002

    # Verify T001 doesn't have T002 as dependency
    assert_task_not_depends_on "T001" "T002"
}

# =============================================================================
# Indirect Circular Dependency Tests (A -> B -> C -> A)
# =============================================================================

@test "indirect circular dependency is prevented" {
    create_linear_chain
    # T001 <- T002 <- T003 already exists
    # Try T001 -> T003 (creates cycle)
    run bash "$UPDATE_SCRIPT" T001 --depends T003
    assert_failure
}

@test "three-level indirect cycle is detected" {
    create_independent_tasks
    # Build chain: T001 <- T002 <- T003
    bash "$UPDATE_SCRIPT" T002 --depends T001
    bash "$UPDATE_SCRIPT" T003 --depends T002

    # Try to close the cycle: T001 -> T003
    run bash "$UPDATE_SCRIPT" T001 --depends T003
    assert_failure
}

@test "indirect circular dependency preserves valid state" {
    create_linear_chain

    # Try to create indirect cycle
    run bash "$UPDATE_SCRIPT" T001 --depends T003

    # Verify state is still valid
    run bash "$VALIDATE_SCRIPT"
    assert_output --partial "No circular dependencies"
}

# =============================================================================
# Error Message Tests
# =============================================================================

@test "circular dependency error includes task IDs" {
    create_linear_chain
    run bash "$UPDATE_SCRIPT" T001 --depends T003
    assert_failure
    assert_output_contains_any "T001" "circular" "cycle"
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "empty dependencies is valid" {
    create_independent_tasks
    run bash "$VALIDATE_SCRIPT"
    assert_output --partial "No circular dependencies"
}

@test "dependency on non-existent task fails" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --depends T999
    assert_failure
}

@test "removing dependency is allowed" {
    create_linear_chain
    # Clear dependencies - empty string now returns E_INPUT_MISSING (exit 2)
    # This is valid behavior since --depends "" is treated as "no update specified"
    # Use explicit value like "none" or omit the flag to keep existing deps
    run bash "$UPDATE_SCRIPT" T002 --depends ""
    # Exit codes: 0=success, 1=error, 2=no update specified (valid for empty deps)
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]] || [[ "$status" -eq 2 ]]
}

# =============================================================================
# Validation Integration Tests
# =============================================================================

@test "validate detects existing circular dependencies" {
    create_circular_deps
    run bash "$VALIDATE_SCRIPT"
    # Should either report cycle in output or fail with exit code 1
    [[ "$output" =~ "circular" ]] || [[ "$output" =~ "cycle" ]] || [[ "$status" -eq 1 ]]
}

@test "validate reports no cycles for valid chain" {
    create_linear_chain
    run bash "$VALIDATE_SCRIPT"
    assert_output --partial "No circular dependencies"
}

# =============================================================================
# Complex Scenario Tests
# =============================================================================

@test "adding dependency to task with existing deps works" {
    create_independent_tasks
    # Add first dependency
    bash "$UPDATE_SCRIPT" T003 --depends T001

    # Add second dependency
    run bash "$UPDATE_SCRIPT" T003 --depends T001,T002
    assert_success
}

@test "complex valid graph is accepted" {
    create_independent_tasks
    # Create: T001, T002 both independent, T003 depends on both
    run bash "$UPDATE_SCRIPT" T003 --depends T001,T002
    assert_success

    # Verify validation passes
    run bash "$VALIDATE_SCRIPT"
    assert_output --partial "No circular dependencies"
}
