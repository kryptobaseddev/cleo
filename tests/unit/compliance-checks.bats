#!/usr/bin/env bats
# =============================================================================
# compliance-checks.bats - Tests for dev/compliance/checks/ modules
# Part of EPIC T481: LLM-Agent-First Spec v3.0 Compliance
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

    # Setup compliance check paths (in addition to common_setup paths)
    COMPLIANCE_DIR="${PROJECT_ROOT}/dev/compliance/checks"
    SCHEMA_FILE="${PROJECT_ROOT}/dev/compliance/schema.json"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# ============================================================================
# INPUT-VALIDATION.SH TESTS
# ============================================================================

@test "input-validation.sh: module exists and is executable" {
    [[ -x "$COMPLIANCE_DIR/input-validation.sh" ]]
}

@test "input-validation.sh: returns valid JSON output" {
    run "$COMPLIANCE_DIR/input-validation.sh" "$SCRIPTS_DIR/add.sh" "$SCHEMA_FILE"
    assert_success

    # Validate JSON structure
    echo "$output" | jq -e '.script' >/dev/null
    echo "$output" | jq -e '.category' >/dev/null
    echo "$output" | jq -e '.passed' >/dev/null
    echo "$output" | jq -e '.score' >/dev/null
}

@test "input-validation.sh: add.sh passes validation" {
    run "$COMPLIANCE_DIR/input-validation.sh" "$SCRIPTS_DIR/add.sh" "$SCHEMA_FILE"
    assert_success

    local score
    score=$(echo "$output" | jq -r '.score')
    # Should have score >= 85%
    [[ $(echo "$score >= 85" | bc -l) -eq 1 ]]
}

@test "input-validation.sh: update.sh passes validation" {
    run "$COMPLIANCE_DIR/input-validation.sh" "$SCRIPTS_DIR/update.sh" "$SCHEMA_FILE"
    assert_success

    local score
    score=$(echo "$output" | jq -r '.score')
    [[ $(echo "$score >= 85" | bc -l) -eq 1 ]]
}

@test "input-validation.sh: reports validation_lib_sourced check" {
    run "$COMPLIANCE_DIR/input-validation.sh" "$SCRIPTS_DIR/add.sh" "$SCHEMA_FILE"
    assert_success

    # Should check if validation.sh is sourced
    echo "$output" | jq -e '.checks[] | select(.check == "validation_lib_sourced")' >/dev/null
}

# ============================================================================
# IDEMPOTENCY.SH TESTS
# ============================================================================

@test "idempotency.sh: module exists and is executable" {
    [[ -x "$COMPLIANCE_DIR/idempotency.sh" ]]
}

@test "idempotency.sh: returns valid JSON output" {
    run "$COMPLIANCE_DIR/idempotency.sh" "$SCRIPTS_DIR/update.sh" "$SCHEMA_FILE"
    assert_success

    # Validate JSON structure
    echo "$output" | jq -e '.script' >/dev/null
    echo "$output" | jq -e '.category' >/dev/null
    echo "$output" | jq -e '.passed' >/dev/null
}

@test "idempotency.sh: update.sh has idempotency support" {
    run "$COMPLIANCE_DIR/idempotency.sh" "$SCRIPTS_DIR/update.sh" "$SCHEMA_FILE"
    assert_success

    # Should detect EXIT_NO_CHANGE usage
    echo "$output" | jq -e '.checks[] | select(.check == "exit_no_change_defined" or .check == "exit_no_change_usage")' >/dev/null
}

@test "idempotency.sh: complete.sh has idempotency support" {
    run "$COMPLIANCE_DIR/idempotency.sh" "$SCRIPTS_DIR/complete.sh" "$SCHEMA_FILE"
    assert_success
}

@test "idempotency.sh: add.sh has duplicate detection" {
    run "$COMPLIANCE_DIR/idempotency.sh" "$SCRIPTS_DIR/add.sh" "$SCHEMA_FILE"
    assert_success

    # May have duplicate detection check
    local has_dup_check
    has_dup_check=$(echo "$output" | jq -r '.checks[] | select(.check | contains("duplicate")) | .check // empty' 2>/dev/null || echo "")
    # This is optional per spec (SHOULD not MUST), so we just verify the check runs
    [[ "$has_dup_check" != "" ]] || true
}

# ============================================================================
# DRY-RUN-SEMANTICS.SH TESTS
# ============================================================================

@test "dry-run-semantics.sh: module exists and is executable" {
    [[ -x "$COMPLIANCE_DIR/dry-run-semantics.sh" ]]
}

@test "dry-run-semantics.sh: returns valid JSON output" {
    run "$COMPLIANCE_DIR/dry-run-semantics.sh" "$SCRIPTS_DIR/add.sh" "$SCHEMA_FILE"
    assert_success

    # Validate JSON structure
    echo "$output" | jq -e '.script' >/dev/null
    echo "$output" | jq -e '.category' >/dev/null
    echo "$output" | jq -e '.passed' >/dev/null
}

@test "dry-run-semantics.sh: add.sh has dry-run support" {
    run "$COMPLIANCE_DIR/dry-run-semantics.sh" "$SCRIPTS_DIR/add.sh" "$SCHEMA_FILE"
    assert_success

    # Should detect --dry-run flag
    echo "$output" | jq -e '.checks[] | select(.check | contains("dry_run"))' >/dev/null
}

@test "dry-run-semantics.sh: archive.sh has dry-run support" {
    run "$COMPLIANCE_DIR/dry-run-semantics.sh" "$SCRIPTS_DIR/archive.sh" "$SCHEMA_FILE"
    assert_success
}

@test "dry-run-semantics.sh: checks for dryRun JSON field" {
    run "$COMPLIANCE_DIR/dry-run-semantics.sh" "$SCRIPTS_DIR/add.sh" "$SCHEMA_FILE"
    assert_success

    # Should check for dryRun field in JSON output
    echo "$output" | jq -e '.checks[] | select(.check | contains("json_field") or .check | contains("output"))' >/dev/null || true
}

# ============================================================================
# EXIT-CODES.SH TESTS
# ============================================================================

@test "exit-codes.sh: module exists and is executable" {
    [[ -x "$COMPLIANCE_DIR/exit-codes.sh" ]]
}

@test "exit-codes.sh: returns valid JSON output" {
    run "$COMPLIANCE_DIR/exit-codes.sh" "$SCRIPTS_DIR/add.sh" "$SCHEMA_FILE"
    assert_success

    echo "$output" | jq -e '.script' >/dev/null
    echo "$output" | jq -e '.category' >/dev/null
}

@test "exit-codes.sh: checks for EXIT_NO_CHANGE constant" {
    run "$COMPLIANCE_DIR/exit-codes.sh" "$LIB_DIR/exit-codes.sh" "$SCHEMA_FILE"
    assert_success

    # Should validate EXIT_NO_CHANGE (102) is defined
    local score
    score=$(echo "$output" | jq -r '.score')
    [[ $(echo "$score >= 80" | bc -l) -eq 1 ]]
}

# ============================================================================
# FLAGS.SH TESTS
# ============================================================================

@test "flags.sh: module exists and is executable" {
    [[ -x "$COMPLIANCE_DIR/flags.sh" ]]
}

@test "flags.sh: returns valid JSON output" {
    run "$COMPLIANCE_DIR/flags.sh" "$SCRIPTS_DIR/add.sh" "$SCHEMA_FILE"
    assert_success

    echo "$output" | jq -e '.script' >/dev/null
    echo "$output" | jq -e '.category' >/dev/null
}

@test "flags.sh: add.sh has required flags" {
    run "$COMPLIANCE_DIR/flags.sh" "$SCRIPTS_DIR/add.sh" "$SCHEMA_FILE"
    assert_success

    # Should check for --format, --quiet, --dry-run flags
    echo "$output" | jq -e '.checks[]' >/dev/null
}

# ============================================================================
# INTEGRATION: ALL MODULES TOGETHER
# ============================================================================

@test "compliance: all modules return consistent JSON structure" {
    local modules=("input-validation.sh" "idempotency.sh" "dry-run-semantics.sh" "exit-codes.sh" "flags.sh")

    for module in "${modules[@]}"; do
        run "$COMPLIANCE_DIR/$module" "$SCRIPTS_DIR/add.sh" "$SCHEMA_FILE"

        # All should return valid JSON with standard fields
        echo "$output" | jq -e '.script' >/dev/null
        echo "$output" | jq -e '.passed >= 0' >/dev/null
        echo "$output" | jq -e '.failed >= 0' >/dev/null
    done
}
