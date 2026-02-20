#!/usr/bin/env bats
# =============================================================================
# error-codes.bats - Unit tests for error code constants and JSON error output
# =============================================================================
# Tests all 29 E_* error codes defined in lib/core/error-json.sh and validates
# that commands produce proper JSON error envelopes when errors occur.
#
# Reference: LLM-AGENT-FIRST-SPEC.md Part 3.2 (Error Code Standard)
# =============================================================================

# =============================================================================
# File-Level Setup (runs once per test file)
# =============================================================================
setup_file() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_file
}

# =============================================================================
# Per-Test Setup (runs before each test)
# =============================================================================
setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    common_setup_per_test

    # Source error-json.sh for direct testing
    source "${LIB_DIR}/core/error-json.sh"
    source "${LIB_DIR}/core/exit-codes.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Part 1: Error Code Constants Verification
# =============================================================================
# Verify all 29 E_* error codes are defined and exported

@test "E_TASK_NOT_FOUND is defined" {
    [[ -n "$E_TASK_NOT_FOUND" ]]
    [[ "$E_TASK_NOT_FOUND" == "E_TASK_NOT_FOUND" ]]
}

@test "E_TASK_ALREADY_EXISTS is defined" {
    [[ -n "$E_TASK_ALREADY_EXISTS" ]]
    [[ "$E_TASK_ALREADY_EXISTS" == "E_TASK_ALREADY_EXISTS" ]]
}

@test "E_TASK_INVALID_ID is defined" {
    [[ -n "$E_TASK_INVALID_ID" ]]
    [[ "$E_TASK_INVALID_ID" == "E_TASK_INVALID_ID" ]]
}

@test "E_TASK_INVALID_STATUS is defined" {
    [[ -n "$E_TASK_INVALID_STATUS" ]]
    [[ "$E_TASK_INVALID_STATUS" == "E_TASK_INVALID_STATUS" ]]
}

@test "E_FILE_NOT_FOUND is defined" {
    [[ -n "$E_FILE_NOT_FOUND" ]]
    [[ "$E_FILE_NOT_FOUND" == "E_FILE_NOT_FOUND" ]]
}

@test "E_FILE_READ_ERROR is defined" {
    [[ -n "$E_FILE_READ_ERROR" ]]
    [[ "$E_FILE_READ_ERROR" == "E_FILE_READ_ERROR" ]]
}

@test "E_FILE_WRITE_ERROR is defined" {
    [[ -n "$E_FILE_WRITE_ERROR" ]]
    [[ "$E_FILE_WRITE_ERROR" == "E_FILE_WRITE_ERROR" ]]
}

@test "E_FILE_PERMISSION is defined" {
    [[ -n "$E_FILE_PERMISSION" ]]
    [[ "$E_FILE_PERMISSION" == "E_FILE_PERMISSION" ]]
}

@test "E_VALIDATION_SCHEMA is defined" {
    [[ -n "$E_VALIDATION_SCHEMA" ]]
    [[ "$E_VALIDATION_SCHEMA" == "E_VALIDATION_SCHEMA" ]]
}

@test "E_VALIDATION_CHECKSUM is defined" {
    [[ -n "$E_VALIDATION_CHECKSUM" ]]
    [[ "$E_VALIDATION_CHECKSUM" == "E_VALIDATION_CHECKSUM" ]]
}

@test "E_VALIDATION_REQUIRED is defined" {
    [[ -n "$E_VALIDATION_REQUIRED" ]]
    [[ "$E_VALIDATION_REQUIRED" == "E_VALIDATION_REQUIRED" ]]
}

@test "E_INPUT_MISSING is defined" {
    [[ -n "$E_INPUT_MISSING" ]]
    [[ "$E_INPUT_MISSING" == "E_INPUT_MISSING" ]]
}

@test "E_INPUT_INVALID is defined" {
    [[ -n "$E_INPUT_INVALID" ]]
    [[ "$E_INPUT_INVALID" == "E_INPUT_INVALID" ]]
}

@test "E_INPUT_FORMAT is defined" {
    [[ -n "$E_INPUT_FORMAT" ]]
    [[ "$E_INPUT_FORMAT" == "E_INPUT_FORMAT" ]]
}

@test "E_DEPENDENCY_MISSING is defined" {
    [[ -n "$E_DEPENDENCY_MISSING" ]]
    [[ "$E_DEPENDENCY_MISSING" == "E_DEPENDENCY_MISSING" ]]
}

@test "E_DEPENDENCY_VERSION is defined" {
    [[ -n "$E_DEPENDENCY_VERSION" ]]
    [[ "$E_DEPENDENCY_VERSION" == "E_DEPENDENCY_VERSION" ]]
}

@test "E_PHASE_NOT_FOUND is defined" {
    [[ -n "$E_PHASE_NOT_FOUND" ]]
    [[ "$E_PHASE_NOT_FOUND" == "E_PHASE_NOT_FOUND" ]]
}

@test "E_PHASE_INVALID is defined" {
    [[ -n "$E_PHASE_INVALID" ]]
    [[ "$E_PHASE_INVALID" == "E_PHASE_INVALID" ]]
}

@test "E_SESSION_ACTIVE is defined" {
    [[ -n "$E_SESSION_ACTIVE" ]]
    [[ "$E_SESSION_ACTIVE" == "E_SESSION_ACTIVE" ]]
}

@test "E_SESSION_NOT_ACTIVE is defined" {
    [[ -n "$E_SESSION_NOT_ACTIVE" ]]
    [[ "$E_SESSION_NOT_ACTIVE" == "E_SESSION_NOT_ACTIVE" ]]
}

@test "E_UNKNOWN is defined" {
    [[ -n "$E_UNKNOWN" ]]
    [[ "$E_UNKNOWN" == "E_UNKNOWN" ]]
}

@test "E_NOT_INITIALIZED is defined" {
    [[ -n "$E_NOT_INITIALIZED" ]]
    [[ "$E_NOT_INITIALIZED" == "E_NOT_INITIALIZED" ]]
}

@test "E_PARENT_NOT_FOUND is defined" {
    [[ -n "$E_PARENT_NOT_FOUND" ]]
    [[ "$E_PARENT_NOT_FOUND" == "E_PARENT_NOT_FOUND" ]]
}

@test "E_DEPTH_EXCEEDED is defined" {
    [[ -n "$E_DEPTH_EXCEEDED" ]]
    [[ "$E_DEPTH_EXCEEDED" == "E_DEPTH_EXCEEDED" ]]
}

@test "E_SIBLING_LIMIT is defined" {
    [[ -n "$E_SIBLING_LIMIT" ]]
    [[ "$E_SIBLING_LIMIT" == "E_SIBLING_LIMIT" ]]
}

@test "E_INVALID_PARENT_TYPE is defined" {
    [[ -n "$E_INVALID_PARENT_TYPE" ]]
    [[ "$E_INVALID_PARENT_TYPE" == "E_INVALID_PARENT_TYPE" ]]
}

@test "E_CIRCULAR_REFERENCE is defined" {
    [[ -n "$E_CIRCULAR_REFERENCE" ]]
    [[ "$E_CIRCULAR_REFERENCE" == "E_CIRCULAR_REFERENCE" ]]
}

@test "E_ORPHAN_DETECTED is defined" {
    [[ -n "$E_ORPHAN_DETECTED" ]]
    [[ "$E_ORPHAN_DETECTED" == "E_ORPHAN_DETECTED" ]]
}

@test "E_CHECKSUM_MISMATCH is defined" {
    [[ -n "$E_CHECKSUM_MISMATCH" ]]
    [[ "$E_CHECKSUM_MISMATCH" == "E_CHECKSUM_MISMATCH" ]]
}

@test "E_CONCURRENT_MODIFICATION is defined" {
    [[ -n "$E_CONCURRENT_MODIFICATION" ]]
    [[ "$E_CONCURRENT_MODIFICATION" == "E_CONCURRENT_MODIFICATION" ]]
}

@test "E_ID_COLLISION is defined" {
    [[ -n "$E_ID_COLLISION" ]]
    [[ "$E_ID_COLLISION" == "E_ID_COLLISION" ]]
}

# =============================================================================
# Part 2: Error Code Count Verification
# =============================================================================

@test "exactly 49 E_* error codes are defined" {
    # Count all E_* exports (29 base + 8 hierarchy/cancel/checksum + 12 session codes)
    local count
    count=$(grep -c '^readonly E_' "${LIB_DIR}/core/error-json.sh")
    [[ "$count" -eq 49 ]]
}

# =============================================================================
# Part 3: output_error_json Structure Tests
# =============================================================================

@test "output_error_json produces valid JSON" {
    COMMAND_NAME="test"
    VERSION="0.21.0"
    local result
    result=$(output_error_json "E_TASK_NOT_FOUND" "Task not found" 4 "true" "Use ct list")
    run jq empty <<< "$result"
    assert_success
}

@test "output_error_json includes \$schema field" {
    COMMAND_NAME="test"
    VERSION="0.21.0"
    local result
    result=$(output_error_json "E_TASK_NOT_FOUND" "Task not found" 4)
    run jq -e '."$schema"' <<< "$result"
    assert_success
    assert_output '"https://cleo-dev.com/schemas/v1/error.schema.json"'
}

@test "output_error_json includes _meta.command" {
    COMMAND_NAME="show"
    VERSION="0.21.0"
    local result
    result=$(output_error_json "E_TASK_NOT_FOUND" "Task not found" 4)
    run jq -r '._meta.command' <<< "$result"
    assert_success
    assert_output "show"
}

@test "output_error_json includes _meta.version" {
    COMMAND_NAME="test"
    VERSION="1.2.3"
    local result
    result=$(output_error_json "E_TASK_NOT_FOUND" "Task not found" 4)
    run jq -r '._meta.version' <<< "$result"
    assert_success
    assert_output "1.2.3"
}

@test "output_error_json includes _meta.timestamp in ISO-8601 format" {
    COMMAND_NAME="test"
    VERSION="0.21.0"
    local result
    result=$(output_error_json "E_TASK_NOT_FOUND" "Task not found" 4)
    run jq -r '._meta.timestamp' <<< "$result"
    assert_success
    # Check ISO-8601 format: YYYY-MM-DDTHH:MM:SSZ
    [[ "$output" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

@test "output_error_json includes success: false" {
    COMMAND_NAME="test"
    VERSION="0.21.0"
    local result
    result=$(output_error_json "E_TASK_NOT_FOUND" "Task not found" 4)
    run jq -e '.success == false' <<< "$result"
    assert_success
}

@test "output_error_json includes error.code" {
    COMMAND_NAME="test"
    VERSION="0.21.0"
    local result
    result=$(output_error_json "E_FILE_READ_ERROR" "Cannot read file" 3)
    run jq -r '.error.code' <<< "$result"
    assert_success
    assert_output "E_FILE_READ_ERROR"
}

@test "output_error_json includes error.message" {
    COMMAND_NAME="test"
    VERSION="0.21.0"
    local result
    result=$(output_error_json "E_INPUT_MISSING" "Title is required" 2)
    run jq -r '.error.message' <<< "$result"
    assert_success
    assert_output "Title is required"
}

@test "output_error_json includes error.exitCode" {
    COMMAND_NAME="test"
    VERSION="0.21.0"
    local result
    result=$(output_error_json "E_NOT_FOUND" "Not found" 4)
    run jq -r '.error.exitCode' <<< "$result"
    assert_success
    assert_output "4"
}

@test "output_error_json includes error.recoverable" {
    COMMAND_NAME="test"
    VERSION="0.21.0"
    local result
    result=$(output_error_json "E_LOCK_TIMEOUT" "Lock timeout" 7 "true")
    run jq -e '.error.recoverable == true' <<< "$result"
    assert_success
}

@test "output_error_json includes error.suggestion when provided" {
    COMMAND_NAME="test"
    VERSION="0.21.0"
    local result
    result=$(output_error_json "E_TASK_NOT_FOUND" "Task T999 not found" 4 "false" "Use 'ct list' to see tasks")
    run jq -r '.error.suggestion' <<< "$result"
    assert_success
    assert_output "Use 'ct list' to see tasks"
}

@test "output_error_json sets suggestion to null when not provided" {
    COMMAND_NAME="test"
    VERSION="0.21.0"
    local result
    result=$(output_error_json "E_UNKNOWN" "Unknown error" 1)
    run jq -e '.error.suggestion == null' <<< "$result"
    assert_success
}

# =============================================================================
# Part 4: Command Error Scenario Tests
# =============================================================================
# Test that actual commands produce correct error JSON

@test "show non-existent task returns E_TASK_NOT_FOUND" {
    create_empty_todo
    run bash "$SHOW_SCRIPT" T999 --format json
    assert_failure
    [[ "$status" -eq 4 ]]
    run jq -r '.error.code' <<< "$output"
    assert_output "E_TASK_NOT_FOUND"
}

@test "complete non-existent task returns E_TASK_NOT_FOUND" {
    create_empty_todo
    run bash "$COMPLETE_SCRIPT" T999 --skip-notes --format json
    assert_failure
    # Complete returns E_TASK_NOT_FOUND when task doesn't exist
    run jq -r '.error.code' <<< "$output"
    assert_output "E_TASK_NOT_FOUND"
}

@test "update non-existent task returns E_TASK_NOT_FOUND" {
    create_empty_todo
    run bash "$UPDATE_SCRIPT" T999 --priority high --format json
    assert_failure
    [[ "$status" -eq 4 ]]
    run jq -r '.error.code' <<< "$output"
    assert_output "E_TASK_NOT_FOUND"
}

@test "add task without title returns error with E_* code" {
    create_empty_todo
    run bash "$ADD_SCRIPT" --format json
    assert_failure
    # Verify error code follows E_* pattern (currently returns E_UNKNOWN)
    # TODO: Should return E_INPUT_MISSING per spec
    run jq -r '.error.code' <<< "$output"
    [[ "$output" =~ ^E_[A-Z_]+$ ]]
}

@test "add task with invalid parent returns E_PARENT_NOT_FOUND" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Test task" --parent T999 --format json
    assert_failure
    [[ "$status" -eq 10 ]]
    run jq -r '.error.code' <<< "$output"
    assert_output "E_PARENT_NOT_FOUND"
}

@test "update with invalid status returns error" {
    create_empty_todo
    # First create a task to update
    bash "$ADD_SCRIPT" "Test task for update" --format json > /dev/null
    local task_id
    task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")
    run bash "$UPDATE_SCRIPT" "$task_id" --status invalid_status --format json
    assert_failure
    # TODO: update.sh should use output_error() for this case
    # Currently outputs text error instead of JSON
    [[ "$output" =~ "Invalid status" ]] || [[ "$output" =~ "E_" ]]
}

@test "focus set on non-existent task returns E_TASK_NOT_FOUND" {
    create_empty_todo
    run bash "$FOCUS_SCRIPT" set T999 --format json
    assert_failure
    run jq -r '.error.code' <<< "$output"
    assert_output "E_TASK_NOT_FOUND"
}

@test "exists on non-existent task returns exists: false" {
    create_empty_todo
    run bash "$EXISTS_SCRIPT" T999 --format json
    # exists command returns exit 1 for not found, but with valid JSON
    # It's a query command, not an error condition
    run jq -e '.exists == false' <<< "$output"
    assert_success
}

# =============================================================================
# Part 5: Exit Code Mapping Tests
# =============================================================================
# Verify error codes map to correct exit codes per spec

@test "E_TASK_NOT_FOUND maps to exit code 4" {
    create_empty_todo
    run bash "$SHOW_SCRIPT" T999 --format json
    [[ "$status" -eq 4 ]]
}

@test "add without title returns non-zero exit code" {
    create_empty_todo
    run bash "$ADD_SCRIPT" --format json
    assert_failure
    # TODO: Should return exit code 2 (E_INPUT_MISSING) per spec
}

@test "E_PARENT_NOT_FOUND maps to exit code 10" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Test" --parent T999 --format json
    [[ "$status" -eq 10 ]]
}

# =============================================================================
# Part 6: Error JSON Schema Compliance Tests
# =============================================================================

@test "error JSON matches error.schema.json structure" {
    create_empty_todo
    run bash "$SHOW_SCRIPT" T999 --format json
    assert_failure

    # Save output for multiple checks
    local error_json="$output"

    # Verify required fields exist
    run jq -e '."$schema" and ._meta and .success == false and .error' <<< "$error_json"
    assert_success

    # Verify _meta structure
    run jq -e '._meta.command and ._meta.timestamp and ._meta.version' <<< "$error_json"
    assert_success

    # Verify error structure
    run jq -e '.error.code and .error.message and .error.exitCode' <<< "$error_json"
    assert_success
}

@test "error code follows E_* naming pattern" {
    create_empty_todo
    run bash "$SHOW_SCRIPT" T999 --format json
    assert_failure

    local code
    code=$(jq -r '.error.code' <<< "$output")
    [[ "$code" =~ ^E_[A-Z_]+$ ]]
}
