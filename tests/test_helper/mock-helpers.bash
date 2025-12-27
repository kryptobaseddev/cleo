#!/usr/bin/env bash
# =============================================================================
# mock-helpers.bash - Mock helpers for dependency injection in BATS tests
# =============================================================================
# Provides patterns for isolating library functions during testing:
#   - Environment variable injection for controlled test state
#   - Function override mocks (test doubles)
#   - PATH manipulation for external command mocks
#   - File I/O mocks for controlled filesystem state
#   - Reset/cleanup helpers for test isolation
#
# All mocks are composable - multiple patterns can be used together.
# =============================================================================

# Track mocked state for cleanup
declare -a _MOCKED_FUNCTIONS=()
declare -a _MOCKED_ENV_VARS=()
declare -g _ORIGINAL_PATH=""

# =============================================================================
# ENVIRONMENT VARIABLE INJECTION
# =============================================================================
# Override environment variables used by library functions for controlled testing.
# All injected variables are tracked for automatic cleanup.

# Mock timestamp for deterministic date/time testing
# Usage: mock_timestamp "2025-01-15T10:30:00Z"
# Effect: Sets CT_MOCK_TIMESTAMP which can be checked by get_iso_timestamp()
mock_timestamp() {
    local timestamp="${1:-2025-01-01T00:00:00Z}"
    export CT_MOCK_TIMESTAMP="$timestamp"
    _MOCKED_ENV_VARS+=("CT_MOCK_TIMESTAMP")
}

# Mock random hex generation for deterministic ID testing
# Usage: mock_random_hex "abcdef123456"
# Effect: Sets CT_MOCK_RANDOM_HEX for generate_random_hex()
mock_random_hex() {
    local hex="${1:-000000000000}"
    export CT_MOCK_RANDOM_HEX="$hex"
    _MOCKED_ENV_VARS+=("CT_MOCK_RANDOM_HEX")
}

# Mock session ID for session-based operation testing
# Usage: mock_session_id "test_session_001"
mock_session_id() {
    local session_id="${1:-mock_session_$(date +%s)}"
    export CT_MOCK_SESSION_ID="$session_id"
    _MOCKED_ENV_VARS+=("CT_MOCK_SESSION_ID")
}

# Mock project root path override
# Usage: mock_project_root "/tmp/test_project"
mock_project_root() {
    local path="${1:-$BATS_TEST_TMPDIR}"
    export CLAUDE_TODO_PROJECT_ROOT="$path"
    _MOCKED_ENV_VARS+=("CLAUDE_TODO_PROJECT_ROOT")
}

# Mock home directory for config testing
# Usage: mock_home_dir "/tmp/test_home"
mock_home_dir() {
    local path="${1:-$BATS_TEST_TMPDIR}"
    export CLAUDE_TODO_HOME="$path"
    _MOCKED_ENV_VARS+=("CLAUDE_TODO_HOME")
}

# Set arbitrary environment variable (tracked for cleanup)
# Usage: mock_env_var "MY_VAR" "my_value"
mock_env_var() {
    local var_name="$1"
    local var_value="$2"
    export "$var_name"="$var_value"
    _MOCKED_ENV_VARS+=("$var_name")
}

# =============================================================================
# FUNCTION OVERRIDE MOCKS
# =============================================================================
# Replace production functions with test doubles.
# Original implementations are preserved for restoration.

# Store original function implementation
# Usage: _save_original_function "log_info"
_save_original_function() {
    local func_name="$1"
    local backup_name="_original_${func_name}"

    # Only save if function exists and hasn't been saved
    if declare -f "$func_name" >/dev/null 2>&1; then
        if ! declare -f "$backup_name" >/dev/null 2>&1; then
            eval "$backup_name() { $(declare -f "$func_name" | tail -n +2); }"
        fi
    fi
}

# Restore original function implementation
# Usage: _restore_original_function "log_info"
_restore_original_function() {
    local func_name="$1"
    local backup_name="_original_${func_name}"

    if declare -f "$backup_name" >/dev/null 2>&1; then
        eval "$func_name() { $(declare -f "$backup_name" | tail -n +2); }"
        unset -f "$backup_name"
    fi
}

# Generic function mock - replaces any function with custom body
# Usage: mock_function "get_timestamp" "echo '2025-01-01T00:00:00Z'"
# Usage: mock_function "validate_json" "return 0"
mock_function() {
    local func_name="$1"
    local mock_body="$2"

    _save_original_function "$func_name"
    eval "${func_name}() { ${mock_body}; }"
    _MOCKED_FUNCTIONS+=("$func_name")
}

# Mock all logging functions to be silent (common pattern)
# Usage: mock_logging
# Effect: log_info, log_error, log_debug, log_warn all become no-ops
mock_logging() {
    for func in log_info log_error log_debug log_warn log_operation; do
        mock_function "$func" ":"
    done
}

# Mock logging to capture output instead of discarding
# Usage: mock_logging_capture
# Access captured logs via: ${_CAPTURED_LOGS[@]}
declare -a _CAPTURED_LOGS=()
mock_logging_capture() {
    _CAPTURED_LOGS=()

    mock_function "log_info" '_CAPTURED_LOGS+=("[INFO] $*")'
    mock_function "log_error" '_CAPTURED_LOGS+=("[ERROR] $*")'
    mock_function "log_debug" '_CAPTURED_LOGS+=("[DEBUG] $*")'
    mock_function "log_warn" '_CAPTURED_LOGS+=("[WARN] $*")'
}

# Get captured logs as array
# Usage: logs=($(get_captured_logs))
get_captured_logs() {
    printf '%s\n' "${_CAPTURED_LOGS[@]}"
}

# Clear captured logs
clear_captured_logs() {
    _CAPTURED_LOGS=()
}

# Mock timestamp function to return fixed value
# Usage: mock_get_timestamp "2025-01-01T00:00:00Z"
mock_get_timestamp() {
    local fixed_time="${1:-2025-01-01T00:00:00Z}"
    mock_function "get_timestamp" "echo '$fixed_time'"
    mock_function "get_iso_timestamp" "echo '$fixed_time'"
}

# Mock random ID generation for deterministic testing
# Usage: mock_id_generation "T999"
mock_id_generation() {
    local fixed_id="${1:-T999}"
    mock_function "generate_task_id" "echo '$fixed_id'"
    mock_function "generate_log_id" "echo 'log_${fixed_id#T}'"
}

# Mock validation to always pass
# Usage: mock_validation_pass
mock_validation_pass() {
    mock_function "validate_json" "return 0"
    mock_function "validate_task" "return 0"
    mock_function "validate_todo_schema" "return 0"
}

# Mock validation to always fail
# Usage: mock_validation_fail "Custom error message"
mock_validation_fail() {
    local error_msg="${1:-Mocked validation failure}"
    mock_function "validate_json" "echo '$error_msg' >&2; return 1"
    mock_function "validate_task" "echo '$error_msg' >&2; return 1"
    mock_function "validate_todo_schema" "echo '$error_msg' >&2; return 1"
}

# Mock file locking (useful when testing concurrent operations)
# Usage: mock_file_locking
mock_file_locking() {
    mock_function "lock_file" "return 0"
    mock_function "unlock_file" "return 0"
    mock_function "acquire_lock" "return 0"
    mock_function "release_lock" "return 0"
}

# Mock atomic write to skip actual file operations
# Usage: mock_atomic_write
# Note: Content is stored in _MOCK_WRITTEN_CONTENT for verification
declare -g _MOCK_WRITTEN_CONTENT=""
declare -g _MOCK_WRITTEN_PATH=""
mock_atomic_write() {
    mock_function "atomic_write" '_MOCK_WRITTEN_PATH="$1"; _MOCK_WRITTEN_CONTENT="$2"; return 0'
    mock_function "save_json" '_MOCK_WRITTEN_PATH="$1"; _MOCK_WRITTEN_CONTENT="$2"; return 0'
}

# Get last written content from mocked atomic_write
get_mock_written_content() {
    echo "$_MOCK_WRITTEN_CONTENT"
}

# Get last written path from mocked atomic_write
get_mock_written_path() {
    echo "$_MOCK_WRITTEN_PATH"
}

# =============================================================================
# PATH MANIPULATION FOR EXTERNAL COMMAND MOCKS
# =============================================================================
# Create mock executables that replace system commands.
# Useful for testing interactions with external tools like git, curl, etc.

# Initialize mock command directory and prepend to PATH
# Usage: setup_mock_commands
# Must be called before creating mock commands
setup_mock_commands() {
    export MOCK_BIN="${BATS_TEST_TMPDIR}/mock_bin"
    mkdir -p "$MOCK_BIN"

    # Save original PATH for restoration
    _ORIGINAL_PATH="${PATH}"
    export PATH="${MOCK_BIN}:${PATH}"
}

# Create a mock command that echoes specific output
# Usage: create_mock_command "git" "mock git output"
# Usage: create_mock_command "curl" '{"status": "ok"}'
create_mock_command() {
    local cmd="$1"
    local output="$2"
    local exit_code="${3:-0}"

    [[ -z "${MOCK_BIN:-}" ]] && setup_mock_commands

    cat > "${MOCK_BIN}/${cmd}" << EOF
#!/bin/bash
echo '$output'
exit $exit_code
EOF
    chmod +x "${MOCK_BIN}/${cmd}"
}

# Create a mock command that captures invocations for verification
# Usage: create_mock_command_with_capture "jq"
# Access captured calls via: cat "${MOCK_BIN}/.jq_calls"
create_mock_command_with_capture() {
    local cmd="$1"
    local output="${2:-}"
    local exit_code="${3:-0}"

    [[ -z "${MOCK_BIN:-}" ]] && setup_mock_commands

    cat > "${MOCK_BIN}/${cmd}" << EOF
#!/bin/bash
# Capture invocation
echo "\$@" >> "${MOCK_BIN}/.${cmd}_calls"
echo '$output'
exit $exit_code
EOF
    chmod +x "${MOCK_BIN}/${cmd}"
    # Initialize capture file
    : > "${MOCK_BIN}/.${cmd}_calls"
}

# Get captured calls for a mock command
# Usage: calls=$(get_mock_command_calls "jq")
get_mock_command_calls() {
    local cmd="$1"
    local capture_file="${MOCK_BIN}/.${cmd}_calls"

    if [[ -f "$capture_file" ]]; then
        cat "$capture_file"
    fi
}

# Create a mock command that reads from stdin and echoes it
# Useful for testing pipeline commands like jq
# Usage: create_mock_passthrough "jq"
create_mock_passthrough() {
    local cmd="$1"

    [[ -z "${MOCK_BIN:-}" ]] && setup_mock_commands

    cat > "${MOCK_BIN}/${cmd}" << 'EOF'
#!/bin/bash
cat
EOF
    chmod +x "${MOCK_BIN}/${cmd}"
}

# Create mock command that fails
# Usage: create_mock_command_fail "curl" "Connection refused" 1
create_mock_command_fail() {
    local cmd="$1"
    local error_msg="${2:-Command failed}"
    local exit_code="${3:-1}"

    create_mock_command "$cmd" "" "$exit_code"

    # Override to output error message to stderr
    cat > "${MOCK_BIN}/${cmd}" << EOF
#!/bin/bash
echo '$error_msg' >&2
exit $exit_code
EOF
    chmod +x "${MOCK_BIN}/${cmd}"
}

# =============================================================================
# FILE I/O MOCKS
# =============================================================================
# Create controlled filesystem state for testing file operations.

# Create temporary todo.json with specific content
# Usage: mock_todo_file '{"tasks": [], "_meta": {"version": "2.3.0"}}'
# Sets TODO_FILE environment variable
mock_todo_file() {
    local content="$1"
    local dest="${BATS_TEST_TMPDIR}/.cleo/todo.json"

    mkdir -p "$(dirname "$dest")"
    echo "$content" > "$dest"
    export TODO_FILE="$dest"
    _MOCKED_ENV_VARS+=("TODO_FILE")
}

# Create empty todo.json with valid schema structure
# Usage: mock_empty_todo
mock_empty_todo() {
    mock_todo_file '{
  "version": "2.3.0",
  "project": {"name": "test-project", "currentPhase": "setup"},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [],
  "focus": {},
  "labels": {},
  "lastUpdated": "2025-01-01T00:00:00Z"
}'
}

# Create todo.json with sample tasks
# Usage: mock_todo_with_tasks 3
mock_todo_with_tasks() {
    local count="${1:-3}"
    local tasks=""

    for ((i=1; i<=count; i++)); do
        local id=$(printf "T%03d" "$i")
        [[ -n "$tasks" ]] && tasks="$tasks,"
        tasks="$tasks{\"id\": \"$id\", \"title\": \"Task $i\", \"description\": \"Description $i\", \"status\": \"pending\", \"priority\": \"medium\", \"createdAt\": \"2025-01-01T10:00:00Z\"}"
    done

    mock_todo_file "{
  \"version\": \"2.3.0\",
  \"project\": {\"name\": \"test-project\", \"currentPhase\": \"setup\"},
  \"_meta\": {\"version\": \"2.3.0\", \"checksum\": \"placeholder\"},
  \"tasks\": [$tasks],
  \"focus\": {},
  \"labels\": {},
  \"lastUpdated\": \"2025-01-01T12:00:00Z\"
}"
}

# Create temporary config file with specific content
# Usage: mock_config_file '{"validation": {"strictMode": true}}'
mock_config_file() {
    local content="$1"
    local dest="${BATS_TEST_TMPDIR}/.cleo/config.json"

    mkdir -p "$(dirname "$dest")"
    echo "$content" > "$dest"
    export CONFIG_FILE="$dest"
    _MOCKED_ENV_VARS+=("CONFIG_FILE")
}

# Create default config file
# Usage: mock_default_config
mock_default_config() {
    mock_config_file '{
  "version": "2.2.0",
  "validation": {"strictMode": false, "requireDescription": false},
  "logging": {"enabled": true, "retentionDays": 30}
}'
}

# Create temporary log file with specific content
# Usage: mock_log_file '{"entries": [], "_meta": {"version": "2.1.0"}}'
mock_log_file() {
    local content="$1"
    local dest="${BATS_TEST_TMPDIR}/.cleo/todo-log.json"

    mkdir -p "$(dirname "$dest")"
    echo "$content" > "$dest"
    export LOG_FILE="$dest"
    _MOCKED_ENV_VARS+=("LOG_FILE")
}

# Create empty log file
# Usage: mock_empty_log
mock_empty_log() {
    mock_log_file '{
  "version": "0.32.4",
  "project": "test-project",
  "_meta": {"totalEntries": 0, "firstEntry": null, "lastEntry": null, "entriesPruned": 0},
  "entries": []
}'
}

# Create temporary archive file with specific content
# Usage: mock_archive_file '{"archivedTasks": []}'
mock_archive_file() {
    local content="$1"
    local dest="${BATS_TEST_TMPDIR}/.cleo/todo-archive.json"

    mkdir -p "$(dirname "$dest")"
    echo "$content" > "$dest"
    export ARCHIVE_FILE="$dest"
    _MOCKED_ENV_VARS+=("ARCHIVE_FILE")
}

# Create empty archive file
# Usage: mock_empty_archive
mock_empty_archive() {
    mock_archive_file '{
  "version": "2.3.0",
  "project": "test-project",
  "_meta": {"version": "2.3.0", "totalArchived": 0, "lastArchived": null},
  "archivedTasks": [],
  "phaseSummary": {},
  "statistics": {"byPhase": {}, "byPriority": {}, "byLabel": {}}
}'
}

# =============================================================================
# RESET AND CLEANUP HELPERS
# =============================================================================
# Restore original state after mocking.
# Should be called in teardown() to ensure test isolation.

# Reset all mocked functions to original implementations
# Usage: reset_mocked_functions
reset_mocked_functions() {
    for func in "${_MOCKED_FUNCTIONS[@]}"; do
        _restore_original_function "$func"
    done
    _MOCKED_FUNCTIONS=()
}

# Reset all mocked environment variables
# Usage: reset_mocked_env_vars
reset_mocked_env_vars() {
    for var in "${_MOCKED_ENV_VARS[@]}"; do
        unset "$var"
    done
    _MOCKED_ENV_VARS=()
}

# Reset PATH to original value (remove mock bin directory)
# Usage: reset_mock_commands
reset_mock_commands() {
    if [[ -n "${_ORIGINAL_PATH:-}" ]]; then
        export PATH="${_ORIGINAL_PATH}"
        _ORIGINAL_PATH=""
    fi

    # Clean up mock bin if it exists
    if [[ -n "${MOCK_BIN:-}" && -d "${MOCK_BIN}" ]]; then
        rm -rf "${MOCK_BIN}"
        unset MOCK_BIN
    fi
}

# Reset all mocks - comprehensive cleanup
# Usage: reset_mocks (call in teardown)
reset_mocks() {
    reset_mocked_functions
    reset_mocked_env_vars
    reset_mock_commands

    # Clear captured data
    _CAPTURED_LOGS=()
    _MOCK_WRITTEN_CONTENT=""
    _MOCK_WRITTEN_PATH=""
}

# =============================================================================
# COMPOSITE MOCK PATTERNS
# =============================================================================
# Pre-configured mock combinations for common testing scenarios.

# Mock for isolated unit testing - disable all side effects
# Usage: mock_unit_test_isolation
mock_unit_test_isolation() {
    mock_logging
    mock_file_locking
    mock_get_timestamp "2025-01-01T00:00:00Z"
}

# Mock for testing file operations without actual I/O
# Usage: mock_file_io_isolation
mock_file_io_isolation() {
    mock_logging
    mock_file_locking
    mock_atomic_write
    mock_validation_pass
}

# Mock for testing with deterministic IDs and timestamps
# Usage: mock_deterministic_state
mock_deterministic_state() {
    mock_get_timestamp "2025-01-01T00:00:00Z"
    mock_random_hex "aabbccddeeff"
    mock_session_id "test_session_deterministic"
}

# Mock for integration testing - only suppress logging
# Usage: mock_integration_test
mock_integration_test() {
    mock_logging
    mock_get_timestamp "2025-01-01T12:00:00Z"
}

# =============================================================================
# ASSERTION HELPERS FOR MOCKS
# =============================================================================
# Helper functions for verifying mock behavior in tests.

# Assert a function was called (requires mock_logging_capture)
# Usage: assert_log_contains "Creating task"
assert_log_contains() {
    local pattern="$1"
    local found=false

    for log in "${_CAPTURED_LOGS[@]}"; do
        if [[ "$log" == *"$pattern"* ]]; then
            found=true
            break
        fi
    done

    if [[ "$found" != "true" ]]; then
        echo "Expected log to contain: $pattern" >&2
        echo "Actual logs:" >&2
        printf '  %s\n' "${_CAPTURED_LOGS[@]}" >&2
        return 1
    fi
}

# Assert mock command was called with expected arguments
# Usage: assert_mock_command_called "git" "status"
assert_mock_command_called() {
    local cmd="$1"
    local expected_args="$2"
    local calls

    calls=$(get_mock_command_calls "$cmd")

    if [[ "$calls" != *"$expected_args"* ]]; then
        echo "Expected $cmd to be called with: $expected_args" >&2
        echo "Actual calls:" >&2
        echo "$calls" >&2
        return 1
    fi
}

# Assert written content matches expected JSON
# Usage: assert_written_json_equals '{"key": "value"}'
assert_written_json_equals() {
    local expected="$1"
    local actual

    actual=$(get_mock_written_content)

    # Compare normalized JSON
    local expected_norm actual_norm
    expected_norm=$(echo "$expected" | jq -cS '.')
    actual_norm=$(echo "$actual" | jq -cS '.')

    if [[ "$expected_norm" != "$actual_norm" ]]; then
        echo "Expected written JSON:" >&2
        echo "$expected" | jq '.' >&2
        echo "Actual written JSON:" >&2
        echo "$actual" | jq '.' >&2
        return 1
    fi
}
