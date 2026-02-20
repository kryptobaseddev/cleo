#!/usr/bin/env bats
# =============================================================================
# mock-helpers.bats - Tests for the mock-helpers test utilities
# =============================================================================
# Validates that mock helpers work correctly for testing isolation.
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
    load '../test_helper/mock-helpers'
    common_setup_per_test
}

teardown() {
    reset_mocks
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Environment Variable Injection Tests
# =============================================================================

@test "mock_timestamp sets CT_MOCK_TIMESTAMP environment variable" {
    mock_timestamp "2025-06-15T14:30:00Z"

    [[ "$CT_MOCK_TIMESTAMP" == "2025-06-15T14:30:00Z" ]]
}

@test "mock_timestamp uses default when no argument provided" {
    mock_timestamp

    [[ "$CT_MOCK_TIMESTAMP" == "2025-01-01T00:00:00Z" ]]
}

@test "mock_env_var sets arbitrary environment variable" {
    mock_env_var "MY_TEST_VAR" "test_value"

    [[ "$MY_TEST_VAR" == "test_value" ]]
}

@test "reset_mocked_env_vars clears all mocked variables" {
    mock_timestamp "2025-01-01T00:00:00Z"
    mock_session_id "test_session"
    mock_env_var "CUSTOM_VAR" "custom_value"

    reset_mocked_env_vars

    [[ -z "${CT_MOCK_TIMESTAMP:-}" ]]
    [[ -z "${CT_MOCK_SESSION_ID:-}" ]]
    [[ -z "${CUSTOM_VAR:-}" ]]
}

# =============================================================================
# Function Override Mock Tests
# =============================================================================

@test "mock_function replaces function implementation" {
    # Create a function to mock
    original_func() { echo "original"; }

    mock_function "original_func" 'echo "mocked"'

    result=$(original_func)
    [[ "$result" == "mocked" ]]
}

@test "reset_mocked_functions restores original implementation" {
    # Create a function to mock
    test_func() { echo "original"; }

    mock_function "test_func" 'echo "mocked"'

    # Verify mock is active
    result=$(test_func)
    [[ "$result" == "mocked" ]]

    # Reset and verify original is restored
    reset_mocked_functions

    result=$(test_func)
    [[ "$result" == "original" ]]
}

@test "mock_get_timestamp returns fixed timestamp" {
    # Mock the function (simulating what get_timestamp would be)
    get_timestamp() { echo "dynamic"; }

    mock_get_timestamp "2025-12-25T00:00:00Z"

    result=$(get_timestamp)
    [[ "$result" == "2025-12-25T00:00:00Z" ]]
}

# =============================================================================
# Logging Mock Tests
# =============================================================================

@test "mock_logging silences all logging functions" {
    # Create logging functions to mock
    log_info() { echo "info: $*"; }
    log_error() { echo "error: $*"; }
    log_debug() { echo "debug: $*"; }

    mock_logging

    # All should be silent (no output)
    result_info=$(log_info "test message")
    result_error=$(log_error "test error")
    result_debug=$(log_debug "test debug")

    [[ -z "$result_info" ]]
    [[ -z "$result_error" ]]
    [[ -z "$result_debug" ]]
}

@test "mock_logging_capture stores log messages" {
    mock_logging_capture

    log_info "test info message"
    log_error "test error message"

    logs=$(get_captured_logs)
    [[ "$logs" == *"[INFO] test info message"* ]]
    [[ "$logs" == *"[ERROR] test error message"* ]]
}

@test "clear_captured_logs empties the log buffer" {
    mock_logging_capture

    log_info "message before clear"
    clear_captured_logs

    logs=$(get_captured_logs)
    [[ -z "$logs" ]]
}

# =============================================================================
# PATH Manipulation Tests
# =============================================================================

@test "setup_mock_commands creates mock bin directory" {
    setup_mock_commands

    [[ -d "$MOCK_BIN" ]]
    [[ "$PATH" == "${MOCK_BIN}:"* ]]
}

@test "create_mock_command creates executable that outputs specified text" {
    setup_mock_commands
    create_mock_command "test_cmd" "mock output"

    result=$(test_cmd)
    [[ "$result" == "mock output" ]]
}

@test "create_mock_command supports custom exit codes" {
    setup_mock_commands
    create_mock_command "failing_cmd" "" 42

    run failing_cmd
    [[ "$status" -eq 42 ]]
}

@test "create_mock_command_with_capture records invocations" {
    setup_mock_commands
    create_mock_command_with_capture "captured_cmd" "output"

    captured_cmd arg1 arg2
    captured_cmd arg3

    calls=$(get_mock_command_calls "captured_cmd")
    [[ "$calls" == *"arg1 arg2"* ]]
    [[ "$calls" == *"arg3"* ]]
}

@test "reset_mock_commands restores original PATH" {
    local original_path="$PATH"

    setup_mock_commands
    [[ "$PATH" != "$original_path" ]]

    reset_mock_commands
    [[ "$PATH" == "$original_path" ]]
}

# =============================================================================
# File I/O Mock Tests
# =============================================================================

@test "mock_todo_file creates todo.json with specified content" {
    mock_todo_file '{"tasks": [{"id": "T001"}]}'

    [[ -f "$TODO_FILE" ]]
    result=$(jq '.tasks[0].id' "$TODO_FILE")
    [[ "$result" == '"T001"' ]]
}

@test "mock_empty_todo creates valid empty todo structure" {
    mock_empty_todo

    [[ -f "$TODO_FILE" ]]
    version=$(jq -r '.version' "$TODO_FILE")
    [[ "$version" == "2.3.0" ]]

    task_count=$(jq '.tasks | length' "$TODO_FILE")
    [[ "$task_count" -eq 0 ]]
}

@test "mock_todo_with_tasks creates specified number of tasks" {
    mock_todo_with_tasks 5

    task_count=$(jq '.tasks | length' "$TODO_FILE")
    [[ "$task_count" -eq 5 ]]

    # Verify task IDs
    first_id=$(jq -r '.tasks[0].id' "$TODO_FILE")
    [[ "$first_id" == "T001" ]]

    last_id=$(jq -r '.tasks[4].id' "$TODO_FILE")
    [[ "$last_id" == "T005" ]]
}

@test "mock_config_file creates config with specified content" {
    mock_config_file '{"validation": {"strictMode": true}}'

    [[ -f "$CONFIG_FILE" ]]
    strict_mode=$(jq '.validation.strictMode' "$CONFIG_FILE")
    [[ "$strict_mode" == "true" ]]
}

# =============================================================================
# Atomic Write Mock Tests
# =============================================================================

@test "mock_atomic_write captures write operations" {
    mock_atomic_write

    # Call the mocked function
    atomic_write "/test/path.json" '{"key": "value"}'

    path=$(get_mock_written_path)
    content=$(get_mock_written_content)

    [[ "$path" == "/test/path.json" ]]
    [[ "$content" == '{"key": "value"}' ]]
}

# =============================================================================
# Composite Pattern Tests
# =============================================================================

@test "mock_unit_test_isolation applies all isolation mocks" {
    # Create functions that would normally exist
    log_info() { echo "info"; }
    lock_file() { echo "locked"; }
    get_timestamp() { date -Iseconds; }

    mock_unit_test_isolation

    # Logging should be silent
    result=$(log_info "test")
    [[ -z "$result" ]]

    # Timestamp should be fixed
    ts=$(get_timestamp)
    [[ "$ts" == "2025-01-01T00:00:00Z" ]]
}

@test "mock_deterministic_state sets predictable values" {
    # Create functions that would normally exist
    get_timestamp() { date -Iseconds; }

    mock_deterministic_state

    [[ "$CT_MOCK_RANDOM_HEX" == "aabbccddeeff" ]]
    [[ "$CT_MOCK_SESSION_ID" == "test_session_deterministic" ]]

    ts=$(get_timestamp)
    [[ "$ts" == "2025-01-01T00:00:00Z" ]]
}

# =============================================================================
# Reset/Cleanup Tests
# =============================================================================

@test "reset_mocks clears all mock state" {
    # Set up various mocks
    mock_timestamp "2025-01-01T00:00:00Z"
    mock_logging_capture
    log_info "test message"
    setup_mock_commands
    create_mock_command "test_cmd" "output"

    reset_mocks

    # Environment should be cleared
    [[ -z "${CT_MOCK_TIMESTAMP:-}" ]]

    # Captured logs should be empty
    [[ "${#_CAPTURED_LOGS[@]}" -eq 0 ]]

    # Mock bin should be removed
    [[ -z "${MOCK_BIN:-}" ]]
}

# =============================================================================
# Assertion Helper Tests
# =============================================================================

@test "assert_log_contains finds matching log message" {
    mock_logging_capture
    log_info "Creating task T001"

    assert_log_contains "Creating task"
}

@test "assert_mock_command_called verifies command invocation" {
    setup_mock_commands
    create_mock_command_with_capture "git" ""

    git status --short

    assert_mock_command_called "git" "status"
}
