#!/usr/bin/env bats
# =============================================================================
# verification.bats - Verification gates system unit tests
# =============================================================================
# Tests for lib/validation/verification.sh:
# - Gate validation (validate_gate_name, validate_agent_name)
# - Gate ordering (get_gate_order, get_gate_index, get_downstream_gates)
# - Verification object management (init_verification, update_gate)
# - State computation (compute_passed, check_all_gates_passed)
# - Round management (increment_round)
# - Failure logging (log_failure)
# - Status functions (get_verification_status, is_verification_complete)
# - Reset operations (reset_downstream_gates)
# - Utility functions (get_missing_gates, get_gate_summary)
# =============================================================================

# Load test helpers using file-level setup pattern
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file

    # Export library path
    export VERIFICATION_LIB="${LIB_DIR}/validation/verification.sh"
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    common_setup_per_test

    # Source the verification library
    source "$VERIFICATION_LIB"

    # Create test config with verification settings
    _create_test_config_with_verification
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper Functions
# =============================================================================

# Create a test config file with verification settings
_create_test_config_with_verification() {
    cat > "$CONFIG_FILE" << 'EOF'
{
  "version": "2.3.0",
  "verification": {
    "enabled": true,
    "maxRounds": 5,
    "requiredGates": ["implemented", "testsPassed", "qaPassed", "securityPassed", "documented"],
    "autoSetImplementedOnComplete": true,
    "requireForParentAutoComplete": true,
    "allowManualOverride": true
  },
  "output": {
    "defaultFormat": "json"
  }
}
EOF
}

# Create a sample verification object
_create_sample_verification() {
    cat << 'EOF'
{
  "passed": false,
  "round": 0,
  "gates": {
    "implemented": null,
    "testsPassed": null,
    "qaPassed": null,
    "cleanupDone": null,
    "securityPassed": null,
    "documented": null
  },
  "lastAgent": null,
  "lastUpdated": "2026-01-01T00:00:00Z",
  "failureLog": []
}
EOF
}

# =============================================================================
# Gate Validation Tests
# =============================================================================

@test "validate_gate_name: accepts valid gate 'implemented'" {
    run validate_gate_name "implemented"
    assert_success
}

@test "validate_gate_name: accepts valid gate 'testsPassed'" {
    run validate_gate_name "testsPassed"
    assert_success
}

@test "validate_gate_name: accepts valid gate 'qaPassed'" {
    run validate_gate_name "qaPassed"
    assert_success
}

@test "validate_gate_name: accepts valid gate 'cleanupDone'" {
    run validate_gate_name "cleanupDone"
    assert_success
}

@test "validate_gate_name: accepts valid gate 'securityPassed'" {
    run validate_gate_name "securityPassed"
    assert_success
}

@test "validate_gate_name: accepts valid gate 'documented'" {
    run validate_gate_name "documented"
    assert_success
}

@test "validate_gate_name: rejects invalid gate name" {
    run validate_gate_name "invalidGate"
    assert_failure
    assert_equal "$status" 42  # EXIT_INVALID_GATE
}

@test "validate_gate_name: rejects empty gate name" {
    run validate_gate_name ""
    assert_failure
}

@test "validate_agent_name: accepts valid agent 'coder'" {
    run validate_agent_name "coder"
    assert_success
}

@test "validate_agent_name: accepts valid agent 'testing'" {
    run validate_agent_name "testing"
    assert_success
}

@test "validate_agent_name: accepts null agent" {
    run validate_agent_name "null"
    assert_success
}

@test "validate_agent_name: accepts empty agent" {
    run validate_agent_name ""
    assert_success
}

@test "validate_agent_name: rejects invalid agent name" {
    run validate_agent_name "invalidAgent"
    assert_failure
    assert_equal "$status" 43  # EXIT_INVALID_AGENT
}

# =============================================================================
# Gate Order Tests
# =============================================================================

@test "get_gate_order: returns all gates in order" {
    run get_gate_order
    assert_success
    assert_output "implemented testsPassed qaPassed cleanupDone securityPassed documented"
}

@test "get_gate_index: returns 0 for 'implemented'" {
    run get_gate_index "implemented"
    assert_success
    assert_output "0"
}

@test "get_gate_index: returns 1 for 'testsPassed'" {
    run get_gate_index "testsPassed"
    assert_success
    assert_output "1"
}

@test "get_gate_index: returns 5 for 'documented'" {
    run get_gate_index "documented"
    assert_success
    assert_output "5"
}

@test "get_gate_index: fails for invalid gate" {
    run get_gate_index "invalidGate"
    assert_failure
}

@test "get_downstream_gates: from 'implemented' returns all downstream" {
    run get_downstream_gates "implemented"
    assert_success
    result=$(echo "$output" | jq -r '. | length')
    assert_equal "$result" 5
}

@test "get_downstream_gates: from 'testsPassed' returns 4 gates" {
    run get_downstream_gates "testsPassed"
    assert_success
    result=$(echo "$output" | jq -r '. | length')
    assert_equal "$result" 4
}

@test "get_downstream_gates: from 'documented' returns empty array" {
    run get_downstream_gates "documented"
    assert_success
    assert_output "[]"
}

# =============================================================================
# Verification Object Tests
# =============================================================================

@test "init_verification: creates valid verification object" {
    run init_verification
    assert_success

    # Verify structure
    passed=$(echo "$output" | jq -r '.passed')
    round=$(echo "$output" | jq -r '.round')
    gates_count=$(echo "$output" | jq -r '.gates | keys | length')

    assert_equal "$passed" "false"
    assert_equal "$round" "0"
    assert_equal "$gates_count" "6"
}

@test "init_verification: all gates start as null" {
    run init_verification
    assert_success

    for gate in implemented testsPassed qaPassed cleanupDone securityPassed documented; do
        value=$(echo "$output" | jq -r ".gates.$gate")
        assert_equal "$value" "null"
    done
}

@test "init_verification: includes failureLog as empty array" {
    run init_verification
    assert_success

    failure_log=$(echo "$output" | jq -r '.failureLog | length')
    assert_equal "$failure_log" "0"
}

# =============================================================================
# Gate Update Tests
# =============================================================================

@test "update_gate: sets gate to true" {
    local v
    v=$(_create_sample_verification)

    run update_gate "$v" "implemented" "true" "coder"
    assert_success

    gate_value=$(echo "$output" | jq -r '.gates.implemented')
    assert_equal "$gate_value" "true"
}

@test "update_gate: sets gate to false" {
    local v
    v=$(_create_sample_verification)

    run update_gate "$v" "implemented" "false" "coder"
    assert_success

    gate_value=$(echo "$output" | jq -r '.gates.implemented')
    assert_equal "$gate_value" "false"
}

@test "update_gate: sets gate to null" {
    local v
    v=$(_create_sample_verification)
    v=$(update_gate "$v" "implemented" "true" "coder")

    run update_gate "$v" "implemented" "null"
    assert_success

    gate_value=$(echo "$output" | jq -r '.gates.implemented')
    assert_equal "$gate_value" "null"
}

@test "update_gate: updates lastAgent" {
    local v
    v=$(_create_sample_verification)

    run update_gate "$v" "testsPassed" "true" "testing"
    assert_success

    last_agent=$(echo "$output" | jq -r '.lastAgent')
    assert_equal "$last_agent" "testing"
}

@test "update_gate: updates lastUpdated timestamp" {
    local v
    v=$(_create_sample_verification)

    run update_gate "$v" "implemented" "true" "coder"
    assert_success

    last_updated=$(echo "$output" | jq -r '.lastUpdated')
    # Should be a recent ISO timestamp
    [[ "$last_updated" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T ]]
}

@test "update_gate: fails for invalid gate" {
    local v
    v=$(_create_sample_verification)

    run update_gate "$v" "invalidGate" "true" "coder"
    assert_failure
    assert_equal "$status" 42
}

@test "update_gate: fails for invalid agent" {
    local v
    v=$(_create_sample_verification)

    run update_gate "$v" "implemented" "true" "invalidAgent"
    assert_failure
    assert_equal "$status" 43
}

# =============================================================================
# Compute Passed Tests
# =============================================================================

@test "compute_passed: returns false when no gates set" {
    local v
    v=$(_create_sample_verification)

    run compute_passed "$v"
    assert_success
    assert_output "false"
}

@test "compute_passed: returns false when some required gates missing" {
    local v
    v=$(_create_sample_verification)
    v=$(update_gate "$v" "implemented" "true")
    v=$(update_gate "$v" "testsPassed" "true")

    run compute_passed "$v"
    assert_success
    assert_output "false"
}

@test "compute_passed: returns true when all required gates pass" {
    local v
    v=$(_create_sample_verification)
    v=$(update_gate "$v" "implemented" "true")
    v=$(update_gate "$v" "testsPassed" "true")
    v=$(update_gate "$v" "qaPassed" "true")
    v=$(update_gate "$v" "securityPassed" "true")
    v=$(update_gate "$v" "documented" "true")

    run compute_passed "$v"
    assert_success
    assert_output "true"
}

@test "compute_passed: ignores non-required gates (cleanupDone)" {
    local v
    v=$(_create_sample_verification)
    v=$(update_gate "$v" "implemented" "true")
    v=$(update_gate "$v" "testsPassed" "true")
    v=$(update_gate "$v" "qaPassed" "true")
    v=$(update_gate "$v" "securityPassed" "true")
    v=$(update_gate "$v" "documented" "true")
    # cleanupDone is NOT in requiredGates, so we don't set it

    run compute_passed "$v"
    assert_success
    assert_output "true"
}

# =============================================================================
# Verification Status Tests
# =============================================================================

@test "get_verification_status: returns 'pending' for null verification" {
    run get_verification_status "null"
    assert_success
    assert_output "pending"
}

@test "get_verification_status: returns 'pending' for empty verification" {
    run get_verification_status ""
    assert_success
    assert_output "pending"
}

@test "get_verification_status: returns 'in-progress' when gates are set" {
    local v
    v=$(_create_sample_verification)
    v=$(update_gate "$v" "implemented" "true")

    run get_verification_status "$v"
    assert_success
    assert_output "in-progress"
}

@test "get_verification_status: returns 'passed' when passed is true" {
    local v
    v=$(_create_sample_verification)
    v=$(echo "$v" | jq '.passed = true')

    run get_verification_status "$v"
    assert_success
    assert_output "passed"
}

@test "get_verification_status: returns 'failed' when failures logged" {
    local v
    v=$(_create_sample_verification)
    v=$(log_failure "$v" "testsPassed" "testing" "Tests failed")

    run get_verification_status "$v"
    assert_success
    assert_output "failed"
}

# =============================================================================
# Round Management Tests
# =============================================================================

@test "increment_round: increments from 0 to 1" {
    local v
    v=$(_create_sample_verification)

    run increment_round "$v"
    assert_success

    round=$(echo "$output" | jq -r '.round')
    assert_equal "$round" "1"
}

@test "increment_round: increments from 4 to 5" {
    local v
    v=$(_create_sample_verification)
    v=$(echo "$v" | jq '.round = 4')

    run increment_round "$v"
    assert_success

    round=$(echo "$output" | jq -r '.round')
    assert_equal "$round" "5"
}

@test "increment_round: fails when exceeding maxRounds" {
    local v
    v=$(_create_sample_verification)
    v=$(echo "$v" | jq '.round = 5')

    run increment_round "$v"
    assert_failure
    assert_equal "$status" 44  # EXIT_MAX_ROUNDS_EXCEEDED
}

# =============================================================================
# Failure Logging Tests
# =============================================================================

@test "log_failure: adds entry to failureLog" {
    local v
    v=$(_create_sample_verification)

    run log_failure "$v" "testsPassed" "testing" "Tests failed: 3 errors"
    assert_success

    failure_count=$(echo "$output" | jq -r '.failureLog | length')
    assert_equal "$failure_count" "1"
}

@test "log_failure: includes gate, agent, and reason" {
    local v
    v=$(_create_sample_verification)

    run log_failure "$v" "testsPassed" "testing" "Tests failed"
    assert_success

    gate=$(echo "$output" | jq -r '.failureLog[0].gate')
    agent=$(echo "$output" | jq -r '.failureLog[0].agent')
    reason=$(echo "$output" | jq -r '.failureLog[0].reason')

    assert_equal "$gate" "testsPassed"
    assert_equal "$agent" "testing"
    assert_equal "$reason" "Tests failed"
}

@test "log_failure: includes timestamp and round" {
    local v
    v=$(_create_sample_verification)
    v=$(echo "$v" | jq '.round = 2')

    run log_failure "$v" "testsPassed" "testing" "Tests failed"
    assert_success

    round=$(echo "$output" | jq -r '.failureLog[0].round')
    timestamp=$(echo "$output" | jq -r '.failureLog[0].timestamp')

    assert_equal "$round" "2"
    [[ "$timestamp" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T ]]
}

@test "log_failure: appends multiple failures" {
    local v
    v=$(_create_sample_verification)
    v=$(log_failure "$v" "testsPassed" "testing" "First failure")
    v=$(log_failure "$v" "qaPassed" "qa" "Second failure")

    failure_count=$(echo "$v" | jq -r '.failureLog | length')
    assert_equal "$failure_count" "2"
}

# =============================================================================
# Reset Downstream Gates Tests
# =============================================================================

@test "reset_downstream_gates: resets gates after specified gate" {
    local v
    v=$(_create_sample_verification)
    v=$(update_gate "$v" "implemented" "true")
    v=$(update_gate "$v" "testsPassed" "true")
    v=$(update_gate "$v" "qaPassed" "true")
    v=$(update_gate "$v" "securityPassed" "true")

    run reset_downstream_gates "$v" "testsPassed"
    assert_success

    # implemented and testsPassed should remain
    implemented=$(echo "$output" | jq -r '.gates.implemented')
    testsPassed=$(echo "$output" | jq -r '.gates.testsPassed')
    assert_equal "$implemented" "true"
    assert_equal "$testsPassed" "true"

    # qaPassed and beyond should be null
    qaPassed=$(echo "$output" | jq -r '.gates.qaPassed')
    securityPassed=$(echo "$output" | jq -r '.gates.securityPassed')
    assert_equal "$qaPassed" "null"
    assert_equal "$securityPassed" "null"
}

@test "reset_downstream_gates: from 'implemented' resets all downstream" {
    local v
    v=$(_create_sample_verification)
    v=$(update_gate "$v" "implemented" "true")
    v=$(update_gate "$v" "testsPassed" "true")
    v=$(update_gate "$v" "qaPassed" "true")

    run reset_downstream_gates "$v" "implemented"
    assert_success

    # implemented should remain
    implemented=$(echo "$output" | jq -r '.gates.implemented')
    assert_equal "$implemented" "true"

    # All others should be null
    testsPassed=$(echo "$output" | jq -r '.gates.testsPassed')
    qaPassed=$(echo "$output" | jq -r '.gates.qaPassed')
    assert_equal "$testsPassed" "null"
    assert_equal "$qaPassed" "null"
}

@test "reset_downstream_gates: from 'documented' resets nothing" {
    local v
    v=$(_create_sample_verification)
    v=$(update_gate "$v" "implemented" "true")
    v=$(update_gate "$v" "documented" "true")

    run reset_downstream_gates "$v" "documented"
    assert_success

    # All should remain unchanged
    implemented=$(echo "$output" | jq -r '.gates.implemented')
    documented=$(echo "$output" | jq -r '.gates.documented')
    assert_equal "$implemented" "true"
    assert_equal "$documented" "true"
}

# =============================================================================
# Utility Function Tests
# =============================================================================

@test "get_missing_gates: returns all required when none set" {
    local v
    v=$(_create_sample_verification)

    run get_missing_gates "$v"
    assert_success

    count=$(echo "$output" | jq -r '. | length')
    assert_equal "$count" "5"  # 5 required gates
}

@test "get_missing_gates: returns only missing gates" {
    local v
    v=$(_create_sample_verification)
    v=$(update_gate "$v" "implemented" "true")
    v=$(update_gate "$v" "testsPassed" "true")

    run get_missing_gates "$v"
    assert_success

    count=$(echo "$output" | jq -r '. | length')
    assert_equal "$count" "3"  # qaPassed, securityPassed, documented
}

@test "get_missing_gates: returns empty when all required pass" {
    local v
    v=$(_create_sample_verification)
    v=$(update_gate "$v" "implemented" "true")
    v=$(update_gate "$v" "testsPassed" "true")
    v=$(update_gate "$v" "qaPassed" "true")
    v=$(update_gate "$v" "securityPassed" "true")
    v=$(update_gate "$v" "documented" "true")

    run get_missing_gates "$v"
    assert_success
    assert_output "[]"
}

@test "should_require_verification: returns true for task type" {
    run should_require_verification "task"
    assert_success
}

@test "should_require_verification: returns true for subtask type" {
    run should_require_verification "subtask"
    assert_success
}

@test "should_require_verification: returns false for epic type" {
    run should_require_verification "epic"
    assert_failure
}

@test "is_verification_complete: returns false for null" {
    run is_verification_complete "null"
    assert_failure
}

@test "is_verification_complete: returns false when passed is false" {
    local v
    v=$(_create_sample_verification)

    run is_verification_complete "$v"
    assert_failure
}

@test "is_verification_complete: returns true when passed is true" {
    local v
    v=$(_create_sample_verification)
    v=$(echo "$v" | jq '.passed = true')

    run is_verification_complete "$v"
    assert_success
}

@test "check_all_gates_passed: returns true when all required pass" {
    local v
    v=$(_create_sample_verification)
    v=$(update_gate "$v" "implemented" "true")
    v=$(update_gate "$v" "testsPassed" "true")
    v=$(update_gate "$v" "qaPassed" "true")
    v=$(update_gate "$v" "securityPassed" "true")
    v=$(update_gate "$v" "documented" "true")

    run check_all_gates_passed "$v"
    assert_success
}

@test "check_all_gates_passed: returns false when some missing" {
    local v
    v=$(_create_sample_verification)
    v=$(update_gate "$v" "implemented" "true")

    run check_all_gates_passed "$v"
    assert_failure
}

@test "get_gate_summary: returns summary object" {
    local v
    v=$(_create_sample_verification)
    v=$(update_gate "$v" "implemented" "true" "coder")

    run get_gate_summary "$v"
    assert_success

    passed=$(echo "$output" | jq -r '.passed')
    round=$(echo "$output" | jq -r '.round')
    lastAgent=$(echo "$output" | jq -r '.lastAgent')

    assert_equal "$passed" "false"
    assert_equal "$round" "0"
    assert_equal "$lastAgent" "coder"
}
