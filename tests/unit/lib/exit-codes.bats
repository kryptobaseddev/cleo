#!/usr/bin/env bats
# =============================================================================
# exit-codes.bats - Unit tests for lib/core/exit-codes.sh
# =============================================================================
# Tests all EXIT_* constants and helper functions defined in exit-codes.sh.
# Verifies constants have correct values, source guard prevents double-loading,
# and helper functions work correctly.
#
# Reference: lib/core/exit-codes.sh, LLM-AGENT-FIRST-SPEC.md Part 5.6
# =============================================================================

# =============================================================================
# File-Level Setup (runs once per test file)
# =============================================================================
setup_file() {
    # Load BATS assertion libraries once per file
    local lib_dir="${BATS_TEST_DIRNAME}/../../libs"
    load "${lib_dir}/bats-support/load"
    load "${lib_dir}/bats-assert/load"

    # Set up paths (exported for all tests)
    export PROJECT_ROOT="${BATS_TEST_DIRNAME}/../../.."
    export LIB_DIR="${PROJECT_ROOT}/lib"
}

# =============================================================================
# Per-Test Setup (runs before each test)
# =============================================================================
setup() {
    # Reload libs for per-test assertion scope
    local lib_dir="${BATS_TEST_DIRNAME}/../../libs"
    load "${lib_dir}/bats-support/load"
    load "${lib_dir}/bats-assert/load"
}

# =============================================================================
# Part 1: Success Code Constant
# =============================================================================

@test "EXIT_SUCCESS is defined and equals 0" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_SUCCESS:-}" ]]
    [[ "$EXIT_SUCCESS" -eq 0 ]]
}

# =============================================================================
# Part 2: General Error Codes (1-9)
# =============================================================================

@test "EXIT_GENERAL_ERROR is defined and equals 1" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_GENERAL_ERROR:-}" ]]
    [[ "$EXIT_GENERAL_ERROR" -eq 1 ]]
}

@test "EXIT_INVALID_INPUT is defined and equals 2" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_INVALID_INPUT:-}" ]]
    [[ "$EXIT_INVALID_INPUT" -eq 2 ]]
}

@test "EXIT_FILE_ERROR is defined and equals 3" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_FILE_ERROR:-}" ]]
    [[ "$EXIT_FILE_ERROR" -eq 3 ]]
}

@test "EXIT_NOT_FOUND is defined and equals 4" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_NOT_FOUND:-}" ]]
    [[ "$EXIT_NOT_FOUND" -eq 4 ]]
}

@test "EXIT_DEPENDENCY_ERROR is defined and equals 5" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_DEPENDENCY_ERROR:-}" ]]
    [[ "$EXIT_DEPENDENCY_ERROR" -eq 5 ]]
}

@test "EXIT_VALIDATION_ERROR is defined and equals 6" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_VALIDATION_ERROR:-}" ]]
    [[ "$EXIT_VALIDATION_ERROR" -eq 6 ]]
}

@test "EXIT_LOCK_TIMEOUT is defined and equals 7" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_LOCK_TIMEOUT:-}" ]]
    [[ "$EXIT_LOCK_TIMEOUT" -eq 7 ]]
}

@test "EXIT_CONFIG_ERROR is defined and equals 8" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_CONFIG_ERROR:-}" ]]
    [[ "$EXIT_CONFIG_ERROR" -eq 8 ]]
}

# =============================================================================
# Part 3: Hierarchy Error Codes (10-19)
# =============================================================================

@test "EXIT_PARENT_NOT_FOUND is defined and equals 10" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_PARENT_NOT_FOUND:-}" ]]
    [[ "$EXIT_PARENT_NOT_FOUND" -eq 10 ]]
}

@test "EXIT_DEPTH_EXCEEDED is defined and equals 11" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_DEPTH_EXCEEDED:-}" ]]
    [[ "$EXIT_DEPTH_EXCEEDED" -eq 11 ]]
}

@test "EXIT_SIBLING_LIMIT is defined and equals 12" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_SIBLING_LIMIT:-}" ]]
    [[ "$EXIT_SIBLING_LIMIT" -eq 12 ]]
}

@test "EXIT_INVALID_PARENT_TYPE is defined and equals 13" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_INVALID_PARENT_TYPE:-}" ]]
    [[ "$EXIT_INVALID_PARENT_TYPE" -eq 13 ]]
}

@test "EXIT_CIRCULAR_REFERENCE is defined and equals 14" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_CIRCULAR_REFERENCE:-}" ]]
    [[ "$EXIT_CIRCULAR_REFERENCE" -eq 14 ]]
}

@test "EXIT_ORPHAN_DETECTED is defined and equals 15" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_ORPHAN_DETECTED:-}" ]]
    [[ "$EXIT_ORPHAN_DETECTED" -eq 15 ]]
}

@test "EXIT_HAS_CHILDREN is defined and equals 16" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_HAS_CHILDREN:-}" ]]
    [[ "$EXIT_HAS_CHILDREN" -eq 16 ]]
}

@test "EXIT_TASK_COMPLETED is defined and equals 17" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_TASK_COMPLETED:-}" ]]
    [[ "$EXIT_TASK_COMPLETED" -eq 17 ]]
}

@test "EXIT_CASCADE_FAILED is defined and equals 18" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_CASCADE_FAILED:-}" ]]
    [[ "$EXIT_CASCADE_FAILED" -eq 18 ]]
}

@test "EXIT_HAS_DEPENDENTS is defined and equals 19" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_HAS_DEPENDENTS:-}" ]]
    [[ "$EXIT_HAS_DEPENDENTS" -eq 19 ]]
}

# =============================================================================
# Part 4: Concurrency Error Codes (20-29)
# =============================================================================

@test "EXIT_CHECKSUM_MISMATCH is defined and equals 20" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_CHECKSUM_MISMATCH:-}" ]]
    [[ "$EXIT_CHECKSUM_MISMATCH" -eq 20 ]]
}

@test "EXIT_CONCURRENT_MODIFICATION is defined and equals 21" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_CONCURRENT_MODIFICATION:-}" ]]
    [[ "$EXIT_CONCURRENT_MODIFICATION" -eq 21 ]]
}

@test "EXIT_ID_COLLISION is defined and equals 22" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_ID_COLLISION:-}" ]]
    [[ "$EXIT_ID_COLLISION" -eq 22 ]]
}

# =============================================================================
# Part 5: Special Codes (100+)
# =============================================================================

@test "EXIT_NO_DATA is defined and equals 100" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_NO_DATA:-}" ]]
    [[ "$EXIT_NO_DATA" -eq 100 ]]
}

@test "EXIT_ALREADY_EXISTS is defined and equals 101" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_ALREADY_EXISTS:-}" ]]
    [[ "$EXIT_ALREADY_EXISTS" -eq 101 ]]
}

@test "EXIT_NO_CHANGE is defined and equals 102" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [[ -n "${EXIT_NO_CHANGE:-}" ]]
    [[ "$EXIT_NO_CHANGE" -eq 102 ]]
}

# =============================================================================
# Part 6: Constant Count Verification
# =============================================================================

@test "exactly 25 EXIT_* constants are defined" {
    # Count all EXIT_* readonly declarations
    local count
    count=$(grep -c '^readonly EXIT_' "${LIB_DIR}/core/exit-codes.sh")
    [[ "$count" -eq 25 ]]
}

@test "all EXIT_* constants are exported" {
    local readonly_count export_count
    readonly_count=$(grep -c '^readonly EXIT_' "${LIB_DIR}/core/exit-codes.sh")
    export_count=$(grep -c '^export EXIT_' "${LIB_DIR}/core/exit-codes.sh")
    [[ "$readonly_count" -eq "$export_count" ]]
}

# =============================================================================
# Part 7: Source Guard Tests
# =============================================================================

@test "source guard prevents double loading via _EXIT_CODES_SH_LOADED" {
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        first=\"\$_EXIT_CODES_SH_LOADED\"
        source '${LIB_DIR}/core/exit-codes.sh'
        second=\"\$_EXIT_CODES_SH_LOADED\"
        [[ \"\$first\" == \"\$second\" ]] && echo 'guard works'
    "
    assert_success
    assert_output "guard works"
}

@test "source guard returns early on second source" {
    run bash -c "
        # First source - full load
        source '${LIB_DIR}/core/exit-codes.sh'

        # Track that constants are defined after first source
        [[ -n \"\$EXIT_SUCCESS\" ]] || exit 1
        [[ -n \"\$_EXIT_CODES_SH_LOADED\" ]] || exit 1

        # Second source - should return immediately via guard
        source '${LIB_DIR}/core/exit-codes.sh'

        # If we reach here without error, guard worked
        echo 'double source handled'
    "
    assert_success
    assert_output "double source handled"
}

@test "source guard detects EXIT_SUCCESS as alternate guard" {
    # The source guard has two checks - test the fallback check
    run bash -c "
        # Pre-set EXIT_SUCCESS to simulate already loaded
        readonly EXIT_SUCCESS=0
        source '${LIB_DIR}/core/exit-codes.sh'

        # If we get here without error, guard worked
        echo 'fallback guard works'
    "
    assert_success
    assert_output "fallback guard works"
}

# =============================================================================
# Part 8: No Side Effects Tests
# =============================================================================

@test "sourcing exit-codes.sh does not produce output" {
    run bash -c "source '${LIB_DIR}/core/exit-codes.sh'"
    assert_success
    assert_output ""
}

@test "sourcing exit-codes.sh does not modify PATH" {
    run bash -c "
        original_path=\"\$PATH\"
        source '${LIB_DIR}/core/exit-codes.sh'
        [[ \"\$PATH\" == \"\$original_path\" ]] && echo 'PATH unchanged'
    "
    assert_success
    assert_output "PATH unchanged"
}

@test "sourcing exit-codes.sh does not change directory" {
    run bash -c "
        original_pwd=\"\$(pwd)\"
        source '${LIB_DIR}/core/exit-codes.sh'
        [[ \"\$(pwd)\" == \"\$original_pwd\" ]] && echo 'pwd unchanged'
    "
    assert_success
    assert_output "pwd unchanged"
}

# =============================================================================
# Part 9: get_exit_code_name Function Tests
# =============================================================================

@test "get_exit_code_name returns SUCCESS for 0" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run get_exit_code_name 0
    assert_success
    assert_output "SUCCESS"
}

@test "get_exit_code_name returns GENERAL_ERROR for 1" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run get_exit_code_name 1
    assert_success
    assert_output "GENERAL_ERROR"
}

@test "get_exit_code_name returns NOT_FOUND for 4" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run get_exit_code_name 4
    assert_success
    assert_output "NOT_FOUND"
}

@test "get_exit_code_name returns PARENT_NOT_FOUND for 10" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run get_exit_code_name 10
    assert_success
    assert_output "PARENT_NOT_FOUND"
}

@test "get_exit_code_name returns HAS_CHILDREN for 16" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run get_exit_code_name 16
    assert_success
    assert_output "HAS_CHILDREN"
}

@test "get_exit_code_name returns CHECKSUM_MISMATCH for 20" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run get_exit_code_name 20
    assert_success
    assert_output "CHECKSUM_MISMATCH"
}

@test "get_exit_code_name returns NO_DATA for 100" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run get_exit_code_name 100
    assert_success
    assert_output "NO_DATA"
}

@test "get_exit_code_name returns NO_CHANGE for 102" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run get_exit_code_name 102
    assert_success
    assert_output "NO_CHANGE"
}

@test "get_exit_code_name returns UNKNOWN for undefined codes" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run get_exit_code_name 999
    assert_success
    assert_output "UNKNOWN"
}

@test "get_exit_code_name is exported" {
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        type -t get_exit_code_name
    "
    assert_success
    assert_output "function"
}

# =============================================================================
# Part 10: is_error_code Function Tests
# =============================================================================

@test "is_error_code returns true for codes 1-99" {
    source "${LIB_DIR}/core/exit-codes.sh"

    # Test boundaries and samples
    is_error_code 1 && is_error_code 50 && is_error_code 99
}

@test "is_error_code returns false for 0" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        is_error_code 0 && echo 'is error' || echo 'not error'
    "
    assert_output "not error"
}

@test "is_error_code returns false for codes >= 100" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        is_error_code 100 && echo 'is error' || echo 'not error'
    "
    assert_output "not error"
}

@test "is_error_code is exported" {
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        type -t is_error_code
    "
    assert_success
    assert_output "function"
}

# =============================================================================
# Part 11: is_recoverable_code Function Tests
# =============================================================================

@test "is_recoverable_code returns true for general errors" {
    source "${LIB_DIR}/core/exit-codes.sh"

    # Test recoverable general errors: 1,2,4,6,7,8
    is_recoverable_code 1
    is_recoverable_code 2
    is_recoverable_code 4
    is_recoverable_code 6
    is_recoverable_code 7
    is_recoverable_code 8
}

@test "is_recoverable_code returns false for file errors (3)" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        is_recoverable_code 3 && echo 'recoverable' || echo 'not recoverable'
    "
    assert_output "not recoverable"
}

@test "is_recoverable_code returns false for dependency errors (5)" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        is_recoverable_code 5 && echo 'recoverable' || echo 'not recoverable'
    "
    assert_output "not recoverable"
}

@test "is_recoverable_code returns false for circular reference (14)" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        is_recoverable_code 14 && echo 'recoverable' || echo 'not recoverable'
    "
    assert_output "not recoverable"
}

@test "is_recoverable_code returns false for cascade failed (18)" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        is_recoverable_code 18 && echo 'recoverable' || echo 'not recoverable'
    "
    assert_output "not recoverable"
}

@test "is_recoverable_code returns true for concurrency errors" {
    source "${LIB_DIR}/core/exit-codes.sh"

    # Concurrency errors are recoverable via retry
    is_recoverable_code 20
    is_recoverable_code 21
    is_recoverable_code 22
}

@test "is_recoverable_code is exported" {
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        type -t is_recoverable_code
    "
    assert_success
    assert_output "function"
}

# =============================================================================
# Part 12: is_no_change_code Function Tests
# =============================================================================

@test "is_no_change_code returns true for 102" {
    source "${LIB_DIR}/core/exit-codes.sh"
    is_no_change_code 102
}

@test "is_no_change_code returns false for 0" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        is_no_change_code 0 && echo 'is no-change' || echo 'not no-change'
    "
    assert_output "not no-change"
}

@test "is_no_change_code returns false for error codes" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        is_no_change_code 1 && echo 'is no-change' || echo 'not no-change'
    "
    assert_output "not no-change"
}

@test "is_no_change_code is exported" {
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        type -t is_no_change_code
    "
    assert_success
    assert_output "function"
}

# =============================================================================
# Part 13: is_success_code Function Tests
# =============================================================================

@test "is_success_code returns true for 0" {
    source "${LIB_DIR}/core/exit-codes.sh"
    is_success_code 0
}

@test "is_success_code returns true for special codes >= 100" {
    source "${LIB_DIR}/core/exit-codes.sh"

    is_success_code 100
    is_success_code 101
    is_success_code 102
}

@test "is_success_code returns false for error codes 1-99" {
    source "${LIB_DIR}/core/exit-codes.sh"
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        is_success_code 1 && echo 'is success' || echo 'not success'
    "
    assert_output "not success"
}

@test "is_success_code is exported" {
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        type -t is_success_code
    "
    assert_success
    assert_output "function"
}

# =============================================================================
# Part 14: Exit Code Range Verification
# =============================================================================

@test "error codes are in range 1-99" {
    source "${LIB_DIR}/core/exit-codes.sh"

    # Verify all error codes are in valid range
    [[ "$EXIT_GENERAL_ERROR" -ge 1 && "$EXIT_GENERAL_ERROR" -lt 100 ]]
    [[ "$EXIT_INVALID_INPUT" -ge 1 && "$EXIT_INVALID_INPUT" -lt 100 ]]
    [[ "$EXIT_FILE_ERROR" -ge 1 && "$EXIT_FILE_ERROR" -lt 100 ]]
    [[ "$EXIT_NOT_FOUND" -ge 1 && "$EXIT_NOT_FOUND" -lt 100 ]]
    [[ "$EXIT_CHECKSUM_MISMATCH" -ge 1 && "$EXIT_CHECKSUM_MISMATCH" -lt 100 ]]
}

@test "special codes are >= 100" {
    source "${LIB_DIR}/core/exit-codes.sh"

    [[ "$EXIT_NO_DATA" -ge 100 ]]
    [[ "$EXIT_ALREADY_EXISTS" -ge 100 ]]
    [[ "$EXIT_NO_CHANGE" -ge 100 ]]
}

@test "hierarchy codes are in range 10-19" {
    source "${LIB_DIR}/core/exit-codes.sh"

    [[ "$EXIT_PARENT_NOT_FOUND" -ge 10 && "$EXIT_PARENT_NOT_FOUND" -le 19 ]]
    [[ "$EXIT_DEPTH_EXCEEDED" -ge 10 && "$EXIT_DEPTH_EXCEEDED" -le 19 ]]
    [[ "$EXIT_SIBLING_LIMIT" -ge 10 && "$EXIT_SIBLING_LIMIT" -le 19 ]]
    [[ "$EXIT_INVALID_PARENT_TYPE" -ge 10 && "$EXIT_INVALID_PARENT_TYPE" -le 19 ]]
    [[ "$EXIT_CIRCULAR_REFERENCE" -ge 10 && "$EXIT_CIRCULAR_REFERENCE" -le 19 ]]
    [[ "$EXIT_ORPHAN_DETECTED" -ge 10 && "$EXIT_ORPHAN_DETECTED" -le 19 ]]
    [[ "$EXIT_HAS_CHILDREN" -ge 10 && "$EXIT_HAS_CHILDREN" -le 19 ]]
    [[ "$EXIT_TASK_COMPLETED" -ge 10 && "$EXIT_TASK_COMPLETED" -le 19 ]]
    [[ "$EXIT_CASCADE_FAILED" -ge 10 && "$EXIT_CASCADE_FAILED" -le 19 ]]
    [[ "$EXIT_HAS_DEPENDENTS" -ge 10 && "$EXIT_HAS_DEPENDENTS" -le 19 ]]
}

@test "concurrency codes are in range 20-29" {
    source "${LIB_DIR}/core/exit-codes.sh"

    [[ "$EXIT_CHECKSUM_MISMATCH" -ge 20 && "$EXIT_CHECKSUM_MISMATCH" -le 29 ]]
    [[ "$EXIT_CONCURRENT_MODIFICATION" -ge 20 && "$EXIT_CONCURRENT_MODIFICATION" -le 29 ]]
    [[ "$EXIT_ID_COLLISION" -ge 20 && "$EXIT_ID_COLLISION" -le 29 ]]
}

# =============================================================================
# Part 15: Constants Are Readonly Tests
# =============================================================================

@test "EXIT_SUCCESS is readonly" {
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        EXIT_SUCCESS=99 2>&1
    "
    assert_failure
    [[ "$output" == *"readonly"* ]]
}

@test "EXIT_GENERAL_ERROR is readonly" {
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        EXIT_GENERAL_ERROR=99 2>&1
    "
    assert_failure
    [[ "$output" == *"readonly"* ]]
}

@test "EXIT_NO_CHANGE is readonly" {
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        EXIT_NO_CHANGE=99 2>&1
    "
    assert_failure
    [[ "$output" == *"readonly"* ]]
}
