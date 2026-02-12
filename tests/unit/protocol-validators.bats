#!/usr/bin/env bats
# protocol-validators.bats - Tests for protocol validation functions
# @task T2730
# @epic T2724

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    # Source the validation library
    source "${BATS_TEST_DIRNAME}/../../lib/validation/protocol-validation.sh"
}

# ============================================================================
# validate_validation_protocol() tests
# ============================================================================

@test "validate_validation_protocol: valid manifest entry passes" {
    local manifest='{"id":"test","status":"complete","validation_result":"pass","test_execution":"bats","key_findings":["test"],"title":"Validation test","agent_type":"validation"}'
    run validate_validation_protocol "T001" "$manifest" "false"
    assert_success
    # Check score >= 70
    local score=$(echo "$output" | jq '.score')
    [[ $score -ge 70 ]]
}

@test "validate_validation_protocol: missing validation_result fails VALID-001" {
    local manifest='{"id":"test","status":"complete","key_findings":["test"],"title":"Validation test","agent_type":"validation"}'
    run validate_validation_protocol "T001" "$manifest" "false"
    assert_success  # Non-strict mode doesn't exit
    assert_output --partial "VALID-001"
}

@test "validate_validation_protocol: missing test_execution warns VALID-002" {
    local manifest='{"id":"test","status":"complete","validation_result":"pass","key_findings":["test"],"title":"Validation test","agent_type":"validation"}'
    run validate_validation_protocol "T001" "$manifest" "false"
    assert_success
    assert_output --partial "VALID-002"
}

@test "validate_validation_protocol: invalid status fails VALID-003" {
    local manifest='{"id":"test","status":"unknown","validation_result":"pass","key_findings":["test"],"title":"Validation test","agent_type":"validation"}'
    run validate_validation_protocol "T001" "$manifest" "false"
    assert_success
    assert_output --partial "VALID-003"
}

@test "validate_validation_protocol: missing key_findings fails VALID-004" {
    local manifest='{"id":"test","status":"complete","validation_result":"pass","title":"Validation test","agent_type":"validation"}'
    run validate_validation_protocol "T001" "$manifest" "false"
    assert_success
    assert_output --partial "VALID-004"
}

@test "validate_validation_protocol: non-validation title warns VALID-005" {
    local manifest='{"id":"test","status":"complete","validation_result":"pass","key_findings":["test"],"title":"Some task","agent_type":"validation"}'
    run validate_validation_protocol "T001" "$manifest" "false"
    assert_success
    assert_output --partial "VALID-005"
}

@test "validate_validation_protocol: wrong agent_type fails VALID-006" {
    local manifest='{"id":"test","status":"complete","validation_result":"pass","key_findings":["test"],"title":"Validation","agent_type":"research"}'
    run validate_validation_protocol "T001" "$manifest" "false"
    assert_success
    assert_output --partial "VALID-006"
}

@test "validate_validation_protocol: partial status without needs_followup warns VALID-007" {
    local manifest='{"id":"test","status":"partial","validation_result":"partial","key_findings":["test"],"title":"Validation","agent_type":"validation"}'
    run validate_validation_protocol "T001" "$manifest" "false"
    assert_success
    assert_output --partial "VALID-007"
}

@test "validate_validation_protocol: strict mode exits 68 on invalid" {
    local manifest='{"id":"test","status":"complete","agent_type":"research"}'
    run validate_validation_protocol "T001" "$manifest" "true"
    assert_failure
    [[ $status -eq 68 ]]
}

@test "validate_validation_protocol: score calculation accuracy" {
    # Perfect entry - score should be 100
    local manifest='{"id":"test","status":"complete","validation_result":"pass","test_execution":"bats","key_findings":["test"],"title":"Validation test","agent_type":"validation"}'
    run validate_validation_protocol "T001" "$manifest" "false"
    assert_success
    local score=$(echo "$output" | jq '.score')
    [[ $score -eq 100 ]]
}

@test "validate_validation_protocol: multiple violations deduct correctly" {
    # Missing validation_result (-20), test_execution (-10), wrong agent_type (-15), missing key_findings (-20)
    local manifest='{"id":"test","status":"complete","title":"Validation test","agent_type":"research"}'
    run validate_validation_protocol "T001" "$manifest" "false"
    assert_success
    local score=$(echo "$output" | jq '.score')
    # Should be 100 - 20 - 10 - 15 - 20 = 35
    [[ $score -eq 35 ]]
}

# ============================================================================
# validate_testing_protocol() tests
# ============================================================================

@test "validate_testing_protocol: valid manifest entry passes" {
    local manifest='{"id":"test","file":"tests/unit/test.bats","status":"complete","key_findings":["all pass"],"coverage_summary":"100%","agent_type":"testing"}'
    run validate_testing_protocol "T001" "$manifest" "false"
    assert_success
    local score=$(echo "$output" | jq '.score')
    [[ $score -ge 70 ]]
}

@test "validate_testing_protocol: non-bats file warns TEST-001" {
    local manifest='{"id":"test","file":"src/test.js","status":"complete","key_findings":["pass"],"agent_type":"testing"}'
    run validate_testing_protocol "T001" "$manifest" "false"
    assert_success
    assert_output --partial "TEST-001"
}

@test "validate_testing_protocol: bats file extension passes TEST-001" {
    local manifest='{"id":"test","file":"my-tests.bats","status":"complete","key_findings":["pass"],"coverage_summary":"100%","agent_type":"testing"}'
    run validate_testing_protocol "T001" "$manifest" "false"
    assert_success
    # Should not have TEST-001 violation
    ! echo "$output" | grep -q "TEST-001"
}

@test "validate_testing_protocol: low pass rate fails TEST-004" {
    local manifest='{"id":"test","file":"tests/test.bats","status":"complete","key_findings":["pass"],"test_results":{"pass_rate":0.85},"agent_type":"testing"}'
    run validate_testing_protocol "T001" "$manifest" "false"
    assert_success
    assert_output --partial "TEST-004"
}

@test "validate_testing_protocol: 100% pass rate passes TEST-004" {
    local manifest='{"id":"test","file":"tests/test.bats","status":"complete","key_findings":["pass"],"test_results":{"pass_rate":1.0},"coverage_summary":"100%","agent_type":"testing"}'
    run validate_testing_protocol "T001" "$manifest" "false"
    assert_success
    # Should not have TEST-004 violation
    ! echo "$output" | grep -q "TEST-004"
}

@test "validate_testing_protocol: missing coverage_summary warns TEST-005" {
    local manifest='{"id":"test","file":"tests/test.bats","status":"complete","key_findings":["pass"],"agent_type":"testing"}'
    run validate_testing_protocol "T001" "$manifest" "false"
    assert_success
    assert_output --partial "TEST-005"
}

@test "validate_testing_protocol: missing key_findings fails TEST-006" {
    local manifest='{"id":"test","file":"tests/test.bats","status":"complete","agent_type":"testing"}'
    run validate_testing_protocol "T001" "$manifest" "false"
    assert_success
    assert_output --partial "TEST-006"
}

@test "validate_testing_protocol: wrong agent_type fails TEST-007" {
    local manifest='{"id":"test","file":"tests/test.bats","status":"complete","key_findings":["pass"],"agent_type":"implementation"}'
    run validate_testing_protocol "T001" "$manifest" "false"
    assert_success
    assert_output --partial "TEST-007"
}

@test "validate_testing_protocol: strict mode exits 69 on mild failure (score 60-70)" {
    # Score: 100 - 10 (TEST-001) - 10 (TEST-005) - 15 (TEST-007) = 65
    local manifest='{"id":"test","file":"src/test.js","status":"complete","key_findings":["pass"],"agent_type":"implementation"}'
    run validate_testing_protocol "T001" "$manifest" "true"
    assert_failure
    [[ $status -eq 69 ]]
}

@test "validate_testing_protocol: strict mode exits 70 on severe failure (score < 50)" {
    # Score: 100 - 30 (TEST-004) - 20 (TEST-006) - 15 (TEST-007) = 35
    local manifest='{"id":"test","file":"tests/test.bats","status":"complete","test_results":{"pass_rate":0.5},"agent_type":"implementation"}'
    run validate_testing_protocol "T001" "$manifest" "true"
    assert_failure
    [[ $status -eq 70 ]]
}

@test "validate_testing_protocol: score calculation accuracy" {
    # Perfect entry - score should be 100
    local manifest='{"id":"test","file":"tests/unit/test.bats","status":"complete","key_findings":["all pass"],"coverage_summary":"100%","test_results":{"pass_rate":1.0},"agent_type":"testing"}'
    run validate_testing_protocol "T001" "$manifest" "false"
    assert_success
    local score=$(echo "$output" | jq '.score')
    [[ $score -eq 100 ]]
}

@test "validate_testing_protocol: multiple violations deduct correctly" {
    # Missing coverage (-10), missing key_findings (-20), wrong agent_type (-15)
    local manifest='{"id":"test","file":"tests/test.bats","status":"complete","agent_type":"research"}'
    run validate_testing_protocol "T001" "$manifest" "false"
    assert_success
    local score=$(echo "$output" | jq '.score')
    # Should be 100 - 10 - 20 - 15 = 55
    [[ $score -eq 55 ]]
}

# ============================================================================
# Integration tests - JSON output structure
# ============================================================================

@test "validate_validation_protocol: returns valid JSON structure" {
    local manifest='{"id":"test","status":"complete","validation_result":"pass","key_findings":["test"],"title":"Validation","agent_type":"validation"}'
    run validate_validation_protocol "T001" "$manifest" "false"
    assert_success
    # Verify JSON has required fields
    echo "$output" | jq -e '.valid' >/dev/null
    echo "$output" | jq -e '.violations' >/dev/null
    echo "$output" | jq -e '.score' >/dev/null
}

@test "validate_testing_protocol: returns valid JSON structure" {
    local manifest='{"id":"test","file":"tests/test.bats","status":"complete","key_findings":["pass"],"coverage_summary":"100%","agent_type":"testing"}'
    run validate_testing_protocol "T001" "$manifest" "false"
    assert_success
    # Verify JSON has required fields
    echo "$output" | jq -e '.valid' >/dev/null
    echo "$output" | jq -e '.violations' >/dev/null
    echo "$output" | jq -e '.score' >/dev/null
}

@test "validate_validation_protocol: violations array contains requirement IDs" {
    local manifest='{"id":"test","status":"complete","agent_type":"research"}'
    run validate_validation_protocol "T001" "$manifest" "false"
    assert_success
    # Check violations have requirement field
    local violations=$(echo "$output" | jq '.violations | length')
    [[ $violations -gt 0 ]]
    echo "$output" | jq -e '.violations[0].requirement' >/dev/null
}

@test "validate_testing_protocol: violations array contains severity levels" {
    local manifest='{"id":"test","file":"src/test.js","status":"complete","agent_type":"testing"}'
    run validate_testing_protocol "T001" "$manifest" "false"
    assert_success
    # Check violations have severity field
    echo "$output" | jq -e '.violations[0].severity' >/dev/null
}

# ============================================================================
# Edge cases and error handling
# ============================================================================

@test "validate_validation_protocol: handles empty manifest gracefully" {
    local manifest='{}'
    run validate_validation_protocol "T001" "$manifest" "false"
    assert_success
    # Should have multiple violations
    local score=$(echo "$output" | jq '.score')
    [[ $score -lt 70 ]]
}

@test "validate_testing_protocol: handles empty manifest gracefully" {
    local manifest='{}'
    run validate_testing_protocol "T001" "$manifest" "false"
    assert_success
    # Should have multiple violations
    local score=$(echo "$output" | jq '.score')
    [[ $score -lt 70 ]]
}

@test "validate_validation_protocol: handles null fields" {
    local manifest='{"id":"test","status":null,"validation_result":null,"agent_type":null}'
    run validate_validation_protocol "T001" "$manifest" "false"
    assert_success
    # Should have violations for null fields
    local score=$(echo "$output" | jq '.score')
    [[ $score -lt 70 ]]
}

@test "validate_testing_protocol: handles missing file field" {
    local manifest='{"id":"test","status":"complete","key_findings":["pass"],"agent_type":"testing"}'
    run validate_testing_protocol "T001" "$manifest" "false"
    assert_success
    # Should still process without file field
    local score=$(echo "$output" | jq '.score')
    [[ $score -ge 0 ]]
}
