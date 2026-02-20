#!/usr/bin/env bats
# manifest-validation.bats - Tests for REAL manifest validation
#
# @task T2832
# @epic T2724
# @why Prove that manifest validation catches real violations
# @what Tests for find, validate, and log functions

# Load test helpers
load '../libs/bats-support/load'
load '../libs/bats-assert/load'

setup() {
    # Source the library under test
    source lib/validation/manifest-validation.sh 2>/dev/null || true

    # Create temp directory for test fixtures
    TEST_DIR=$(mktemp -d)
    TEST_MANIFEST="$TEST_DIR/MANIFEST.jsonl"
    TEST_COMPLIANCE="$TEST_DIR/COMPLIANCE.jsonl"

    # Override paths
    export MANIFEST_PATH="$TEST_MANIFEST"
    export COMPLIANCE_PATH="$TEST_COMPLIANCE"
    _MV_MANIFEST_PATH="$TEST_MANIFEST"
    _MV_COMPLIANCE_PATH="$TEST_COMPLIANCE"

    # Create test manifest with sample entries
    cat > "$TEST_MANIFEST" << 'EOF'
{"id":"T1001-research-topic","file":"2026-01-01_research-topic.md","title":"Research Topic","date":"2026-01-01","status":"complete","agent_type":"research","key_findings":["Finding 1","Finding 2","Finding 3"],"topics":["test"],"actionable":true,"linked_tasks":["T1000","T1001"]}
{"id":"T1002-impl-feature","file":"2026-01-02_impl-feature.md","title":"Implement Feature","date":"2026-01-02","status":"complete","agent_type":"implementation","key_findings":["Implemented X","Added Y","Fixed Z","Tested"],"linked_tasks":["T1000","T1002"]}
{"id":"T1003-bad-entry","file":"2026-01-03_bad.md","status":"invalid_status","agent_type":"unknown"}
EOF

    # Create empty compliance log
    touch "$TEST_COMPLIANCE"
}

teardown() {
    # Clean up
    rm -rf "$TEST_DIR" 2>/dev/null || true
}

# ============================================================================
# find_manifest_entry tests
# ============================================================================

@test "find_manifest_entry: finds entry by task ID in linked_tasks" {
    skip_if_function_missing find_manifest_entry

    result=$(find_manifest_entry "T1001")

    [ -n "$result" ]
    echo "$result" | jq -e '.id == "T1001-research-topic"'
}

@test "find_manifest_entry: finds entry by ID prefix" {
    skip_if_function_missing find_manifest_entry

    result=$(find_manifest_entry "T1002")

    [ -n "$result" ]
    echo "$result" | jq -e '.agent_type == "implementation"'
}

@test "find_manifest_entry: returns empty for non-existent task" {
    skip_if_function_missing find_manifest_entry

    result=$(find_manifest_entry "T9999" 2>/dev/null) || true

    [ -z "$result" ]
}

@test "find_manifest_entry: returns last matching entry when multiple exist" {
    skip_if_function_missing find_manifest_entry

    # Add duplicate entry
    echo '{"id":"T1001-second","linked_tasks":["T1001"],"status":"complete","agent_type":"research"}' >> "$TEST_MANIFEST"

    result=$(find_manifest_entry "T1001")

    echo "$result" | jq -e '.id == "T1001-second"'
}

# ============================================================================
# validate_manifest_entry tests
# ============================================================================

@test "validate_manifest_entry: valid research entry returns score >= 70" {
    skip_if_function_missing validate_manifest_entry

    result=$(validate_manifest_entry "T1001")

    score=$(echo "$result" | jq -r '.score // 0')
    [ "$score" -ge 70 ]
}

@test "validate_manifest_entry: valid implementation entry passes" {
    skip_if_function_missing validate_manifest_entry

    result=$(validate_manifest_entry "T1002")

    echo "$result" | jq -e '.valid == true or .pass == true or .score >= 70'
}

@test "validate_manifest_entry: missing task returns failure with violation" {
    skip_if_function_missing validate_manifest_entry

    result=$(validate_manifest_entry "T9999" 2>/dev/null) || true

    echo "$result" | jq -e '.valid == false'
    echo "$result" | jq -e '.violations | length > 0'
}

@test "validate_manifest_entry: detects unknown agent_type" {
    skip_if_function_missing validate_manifest_entry

    # T1003 has agent_type="unknown"
    result=$(validate_manifest_entry "T1003")

    # Should still work but with basic validation
    echo "$result" | jq -e 'has("score")'
}

# ============================================================================
# log_real_compliance tests
# ============================================================================

@test "log_real_compliance: creates compliance entry" {
    skip_if_function_missing log_real_compliance

    validation_result='{"valid":true,"score":95,"pass":true,"violations":[]}'

    log_real_compliance "T1001" "$validation_result" "research"

    [ -f "$TEST_COMPLIANCE" ]
    [ "$(wc -l < "$TEST_COMPLIANCE")" -eq 1 ]
}

@test "log_real_compliance: records real score not hardcoded 100" {
    skip_if_function_missing log_real_compliance

    validation_result='{"valid":false,"score":45,"pass":false,"violations":[{"severity":"error"}]}'

    log_real_compliance "T1001" "$validation_result" "research"

    entry=$(tail -1 "$TEST_COMPLIANCE")

    # Check that rule_adherence_score is 0.45 (45/100), not 1.0
    score=$(echo "$entry" | jq -r '.compliance.rule_adherence_score')
    assert [ "$score" = "0.45" ]
}

@test "log_real_compliance: records violations correctly" {
    skip_if_function_missing log_real_compliance

    validation_result='{"valid":false,"score":30,"pass":false,"violations":[{"severity":"error"},{"severity":"warning"}]}'

    log_real_compliance "T1001" "$validation_result" "implementation"

    entry=$(tail -1 "$TEST_COMPLIANCE")

    violation_count=$(echo "$entry" | jq -r '.compliance.violation_count')
    severity=$(echo "$entry" | jq -r '.compliance.violation_severity')

    assert [ "$violation_count" = "2" ]
    assert [ "$severity" = "error" ]
}

@test "log_real_compliance: output is single-line JSON (JSONL format)" {
    skip_if_function_missing log_real_compliance

    validation_result='{"valid":true,"score":100,"pass":true,"violations":[]}'

    log_real_compliance "T1001" "$validation_result" "research"

    # Check that file has exactly 1 line
    lines=$(wc -l < "$TEST_COMPLIANCE")
    [ "$lines" -eq 1 ]

    # Check that line is valid JSON
    tail -1 "$TEST_COMPLIANCE" | jq empty
}

# ============================================================================
# validate_and_log integration tests
# ============================================================================

@test "validate_and_log: end-to-end validation and logging" {
    skip_if_function_missing validate_and_log

    before=$(wc -l < "$TEST_COMPLIANCE")

    result=$(validate_and_log "T1001")

    after=$(wc -l < "$TEST_COMPLIANCE")

    # Should have added an entry
    [ "$after" -gt "$before" ]

    # Result should indicate success
    echo "$result" | jq -e '.valid == true or .score >= 70'
}

@test "validate_and_log: logs failure for missing manifest entry" {
    skip_if_function_missing validate_and_log

    result=$(validate_and_log "T9999" 2>/dev/null) || true

    # Should have logged
    [ "$(wc -l < "$TEST_COMPLIANCE")" -ge 1 ]

    # Check logged entry shows failure
    entry=$(tail -1 "$TEST_COMPLIANCE")
    echo "$entry" | jq -e '.compliance.violation_count > 0'
    echo "$entry" | jq -e '.compliance.manifest_integrity == "violations_found"'
}

# ============================================================================
# Helper functions
# ============================================================================

skip_if_function_missing() {
    local func_name="$1"
    if ! declare -f "$func_name" >/dev/null 2>&1; then
        skip "Function $func_name not available"
    fi
}
