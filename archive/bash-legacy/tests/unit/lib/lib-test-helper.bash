#!/usr/bin/env bash
# =============================================================================
# lib-test-helper.bash - Isolated testing helper for library unit tests
# =============================================================================
# Provides utilities for testing individual lib/*.sh files in isolation,
# without sourcing the full production stack (common.sh).
#
# Key Features:
#   - load_lib_in_isolation() - Source a single lib file in clean environment
#   - Mock function helpers for dependency injection
#   - Environment isolation to prevent pollution between tests
#   - Minimal required environment setup (LIB_DIR, PROJECT_ROOT)
#
# Usage in .bats files:
#   load '../lib/lib-test-helper'
#
#   setup() {
#       lib_test_setup
#       load_lib_in_isolation "exit-codes.sh"
#   }
#
#   teardown() {
#       lib_test_teardown
#   }
# =============================================================================

#=== SOURCE GUARD ================================================
[[ -n "${_LIB_TEST_HELPER_LOADED:-}" ]] && return 0
declare -r _LIB_TEST_HELPER_LOADED=1

# =============================================================================
# PATH SETUP
# =============================================================================

# Compute paths relative to this helper's location
# tests/unit/lib/lib-test-helper.bash -> tests/unit/lib -> tests/unit -> tests -> project root
_LIB_TEST_HELPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_LIB_TEST_PROJECT_ROOT="$(cd "${_LIB_TEST_HELPER_DIR}/../../.." && pwd)"
_LIB_TEST_LIB_DIR="${_LIB_TEST_PROJECT_ROOT}/lib"
_LIB_TEST_BATS_LIBS_DIR="${_LIB_TEST_PROJECT_ROOT}/tests/libs"

# =============================================================================
# BATS LIBRARY LOADING
# =============================================================================

# Load BATS helper libraries (bats-support, bats-assert, bats-file)
# Call this in setup() if you need assertion helpers
load_bats_libs() {
    if [[ -d "${_LIB_TEST_BATS_LIBS_DIR}/bats-support" ]]; then
        load "${_LIB_TEST_BATS_LIBS_DIR}/bats-support/load"
        load "${_LIB_TEST_BATS_LIBS_DIR}/bats-assert/load"
        load "${_LIB_TEST_BATS_LIBS_DIR}/bats-file/load"
    fi
}

# =============================================================================
# ENVIRONMENT ISOLATION
# =============================================================================

# Store original environment for restoration
# Using simple file-based storage to avoid bash associative array quoting issues in BATS
declare -a _LIB_TEST_MOCK_FUNCTIONS=()
_LIB_TEST_SAVED_ENV_FILE=""

# Save current value of a variable for later restoration
# Args: $1 = variable name
_save_var() {
    local var_name="$1"

    # Create temp file for saving env on first call
    if [[ -z "$_LIB_TEST_SAVED_ENV_FILE" ]]; then
        _LIB_TEST_SAVED_ENV_FILE="${BATS_TEST_TMPDIR:-/tmp}/.lib_test_saved_env.$$"
        : > "$_LIB_TEST_SAVED_ENV_FILE"
    fi

    # Save variable state to file
    if [[ -v "$var_name" ]]; then
        printf '%s=%s\n' "$var_name" "${!var_name}" >> "$_LIB_TEST_SAVED_ENV_FILE"
    else
        printf '%s=__UNSET__\n' "$var_name" >> "$_LIB_TEST_SAVED_ENV_FILE"
    fi
}

# Restore all saved variables to their original state
_restore_vars() {
    [[ -z "$_LIB_TEST_SAVED_ENV_FILE" ]] && return 0
    [[ ! -f "$_LIB_TEST_SAVED_ENV_FILE" ]] && return 0

    local line var_name saved_value
    while IFS='=' read -r var_name saved_value; do
        if [[ "$saved_value" == "__UNSET__" ]]; then
            unset "$var_name" 2>/dev/null || true
        else
            export "$var_name"="$saved_value"
        fi
    done < "$_LIB_TEST_SAVED_ENV_FILE"

    rm -f "$_LIB_TEST_SAVED_ENV_FILE"
    _LIB_TEST_SAVED_ENV_FILE=""
}

# Unset all mock functions created during test
_restore_functions() {
    for func_name in "${_LIB_TEST_MOCK_FUNCTIONS[@]}"; do
        unset -f "$func_name" 2>/dev/null || true
    done
    _LIB_TEST_MOCK_FUNCTIONS=()
}

# =============================================================================
# CORE SETUP/TEARDOWN
# =============================================================================

# Standard setup for library tests - call in BATS setup()
# Sets up minimal environment required by library files
lib_test_setup() {
    # Load BATS assertion libraries
    load_bats_libs

    # Save and set required environment variables
    _save_var "LIB_DIR"
    _save_var "PROJECT_ROOT"
    _save_var "SCRIPTS_DIR"
    _save_var "CLAUDE_TODO_HOME"

    export LIB_DIR="${_LIB_TEST_LIB_DIR}"
    export PROJECT_ROOT="${_LIB_TEST_PROJECT_ROOT}"
    export SCRIPTS_DIR="${_LIB_TEST_PROJECT_ROOT}/scripts"
    export CLAUDE_TODO_HOME="${BATS_TEST_TMPDIR:-/tmp}/claude-todo-test"

    # Create temp directory for test artifacts
    export LIB_TEST_TEMP_DIR="${BATS_TEST_TMPDIR:-$(mktemp -d)}"
    mkdir -p "$LIB_TEST_TEMP_DIR"

    # Track loaded libraries for isolation verification
    export _LIB_TEST_LOADED_LIBS=""
}

# Standard teardown for library tests - call in BATS teardown()
lib_test_teardown() {
    _restore_functions
    _restore_vars

    # Clean up temp directory if we created it (not managed by BATS)
    if [[ -z "${BATS_TEST_TMPDIR:-}" && -n "${LIB_TEST_TEMP_DIR:-}" ]]; then
        rm -rf "$LIB_TEST_TEMP_DIR" 2>/dev/null || true
    fi
}

# =============================================================================
# LIBRARY LOADING
# =============================================================================

# Load a single library file in isolation
# Clears source guards to allow fresh loading
# Args: $1 = library filename (e.g., "exit-codes.sh")
#       $2 = (optional) "skip_guard_clear" to preserve source guards
load_lib_in_isolation() {
    local lib_name="$1"
    local skip_guard_clear="${2:-}"
    local lib_path="${_LIB_TEST_LIB_DIR}/${lib_name}"

    if [[ ! -f "$lib_path" ]]; then
        echo "ERROR: Library not found: $lib_path" >&2
        return 1
    fi

    # Clear source guards unless explicitly skipped
    # This allows re-sourcing libraries in different tests
    if [[ "$skip_guard_clear" != "skip_guard_clear" ]]; then
        _clear_source_guards "$lib_name"
    fi

    # Source the library
    # shellcheck source=/dev/null
    source "$lib_path"

    # Track loaded library
    _LIB_TEST_LOADED_LIBS="${_LIB_TEST_LOADED_LIBS}${lib_name}:"
}

# Load multiple libraries in order (respecting dependencies)
# Args: $@ = library filenames in dependency order
load_libs_in_order() {
    for lib_name in "$@"; do
        load_lib_in_isolation "$lib_name" "skip_guard_clear"
    done
}

# Clear source guards for a library to allow fresh loading
# Args: $1 = library filename
_clear_source_guards() {
    local lib_name="$1"

    # Map library names to their source guard variable names
    case "$lib_name" in
        "exit-codes.sh")
            unset _EXIT_CODES_SH_LOADED EXIT_SUCCESS 2>/dev/null || true
            ;;
        "version.sh")
            unset _VERSION_LOADED 2>/dev/null || true
            ;;
        "platform-compat.sh")
            unset _PLATFORM_COMPAT_LOADED 2>/dev/null || true
            ;;
        "config.sh")
            unset _CONFIG_SH_LOADED 2>/dev/null || true
            ;;
        "error-json.sh")
            unset _ERROR_JSON_LOADED 2>/dev/null || true
            ;;
        "output-format.sh")
            unset _OUTPUT_FORMAT_LOADED 2>/dev/null || true
            ;;
        "jq-helpers.sh")
            unset _JQ_HELPERS_LOADED 2>/dev/null || true
            ;;
        "file-ops.sh")
            unset _FILE_OPS_LOADED 2>/dev/null || true
            ;;
        "atomic-write.sh")
            unset _ATOMIC_WRITE_LOADED 2>/dev/null || true
            ;;
        "logging.sh")
            unset _LOGGING_SH_LOADED 2>/dev/null || true
            ;;
        "validation.sh")
            unset _VALIDATION_SH_LOADED 2>/dev/null || true
            ;;
        "hierarchy.sh")
            unset _HIERARCHY_SH_LOADED 2>/dev/null || true
            ;;
        "phase-tracking.sh")
            unset _PHASE_TRACKING_LOADED 2>/dev/null || true
            ;;
        "cache.sh")
            unset _CACHE_SH_LOADED 2>/dev/null || true
            ;;
        "backup.sh")
            unset _BACKUP_SH_LOADED 2>/dev/null || true
            ;;
        "analysis.sh")
            unset _ANALYSIS_SH_LOADED 2>/dev/null || true
            ;;
        "migrate.sh")
            unset _MIGRATE_SH_LOADED 2>/dev/null || true
            ;;
        "dependency-check.sh")
            unset _DEPENDENCY_CHECK_LOADED 2>/dev/null || true
            ;;
        "cancel-ops.sh")
            unset _CANCEL_OPS_LOADED 2>/dev/null || true
            ;;
        "archive-cancel.sh")
            unset _ARCHIVE_CANCEL_LOADED 2>/dev/null || true
            ;;
        "delete-preview.sh")
            unset _DELETE_PREVIEW_LOADED 2>/dev/null || true
            ;;
        "deletion-strategy.sh")
            unset _DELETION_STRATEGY_LOADED 2>/dev/null || true
            ;;
        "todowrite-integration.sh")
            unset _TODOWRITE_INTEGRATION_LOADED 2>/dev/null || true
            ;;
        *)
            # Generic pattern: try common guard variable names
            local guard_name
            guard_name="_$(echo "${lib_name%.sh}" | tr '[:lower:]-' '[:upper:]_')_LOADED"
            unset "$guard_name" 2>/dev/null || true
            ;;
    esac
}

# =============================================================================
# MOCK FUNCTION HELPERS
# =============================================================================

# Create a mock function that returns a fixed value
# Args: $1 = function name
#       $2 = return value (exit code, default 0)
#       $3 = stdout output (optional)
mock_function() {
    local func_name="$1"
    local return_val="${2:-0}"
    local stdout_val="${3:-}"

    # Track for cleanup
    _LIB_TEST_MOCK_FUNCTIONS+=("$func_name")

    # Create the mock function
    eval "${func_name}() {
        [[ -n \"$stdout_val\" ]] && echo \"$stdout_val\"
        return $return_val
    }"

    export -f "$func_name"
}

# Create a mock function that captures its arguments
# Args: $1 = function name
#       $2 = variable name to store captured args (default: ${func_name}_ARGS)
mock_function_capture_args() {
    local func_name="$1"
    local capture_var="${2:-${func_name}_ARGS}"

    # Track for cleanup
    _LIB_TEST_MOCK_FUNCTIONS+=("$func_name")

    # Initialize capture variable
    eval "export ${capture_var}=''"

    # Create the mock function that captures args
    eval "${func_name}() {
        ${capture_var}=\"\$*\"
        export ${capture_var}
        return 0
    }"

    export -f "$func_name"
}

# Create a mock function that executes custom code
# Args: $1 = function name
#       $2 = function body (bash code)
mock_function_custom() {
    local func_name="$1"
    local func_body="$2"

    # Track for cleanup
    _LIB_TEST_MOCK_FUNCTIONS+=("$func_name")

    # Create the mock function with custom body
    eval "${func_name}() {
        $func_body
    }"

    export -f "$func_name"
}

# Create a mock function that returns different values on each call
# Args: $1 = function name
#       $@ = return values for each successive call
mock_function_sequence() {
    local func_name="$1"
    shift
    local -a values=("$@")

    # Track for cleanup
    _LIB_TEST_MOCK_FUNCTIONS+=("$func_name")

    # Store sequence in a variable
    local seq_var="${func_name}_SEQ"
    local idx_var="${func_name}_IDX"
    eval "export ${seq_var}='${values[*]}'"
    eval "export ${idx_var}=0"

    # Create the mock function
    eval "${func_name}() {
        local -a seq=(\${${seq_var}})
        local idx=\${${idx_var}}
        local val=\"\${seq[\$idx]:-\${seq[-1]}}\"
        (( ${idx_var}++ )) || true
        export ${idx_var}
        echo \"\$val\"
        return 0
    }"

    export -f "$func_name"
}

# =============================================================================
# ASSERTION HELPERS
# =============================================================================

# Assert that a function is defined
# Args: $1 = function name
assert_function_defined() {
    local func_name="$1"
    if ! declare -F "$func_name" >/dev/null 2>&1; then
        echo "FAIL: Function '$func_name' is not defined" >&2
        return 1
    fi
}

# Assert that a variable is defined and exported
# Args: $1 = variable name
# Note: Handles both regular exports (-x) and readonly exports (-rx)
assert_var_exported() {
    local var_name="$1"
    local decl_output
    decl_output="$(declare -p "$var_name" 2>/dev/null)" || {
        echo "FAIL: Variable '$var_name' is not defined" >&2
        return 1
    }
    # Check for export flag (-x) in any position (handles -x, -rx, -xr, etc.)
    if ! echo "$decl_output" | grep -qE '^declare -[a-z]*x'; then
        echo "FAIL: Variable '$var_name' is not exported (got: $decl_output)" >&2
        return 1
    fi
}

# Assert that a variable has a specific value
# Args: $1 = variable name
#       $2 = expected value
assert_var_equals() {
    local var_name="$1"
    local expected="$2"
    local actual="${!var_name:-}"

    if [[ "$actual" != "$expected" ]]; then
        echo "FAIL: Variable '$var_name' expected '$expected' but got '$actual'" >&2
        return 1
    fi
}

# Assert that only specific libraries have been loaded (isolation check)
# Args: $@ = expected library names
assert_only_loaded() {
    local expected_libs="$*"
    local loaded="${_LIB_TEST_LOADED_LIBS}"

    for lib in $expected_libs; do
        if [[ "$loaded" != *"${lib}:"* ]]; then
            echo "FAIL: Expected library '$lib' to be loaded" >&2
            return 1
        fi
    done
}

# =============================================================================
# TEST DATA HELPERS
# =============================================================================

# Create a minimal todo.json for testing
# Args: $1 = output file path
create_minimal_todo() {
    local output_file="$1"
    cat > "$output_file" << 'EOF'
{
  "version": "2.4.0",
  "tasks": [],
  "focus": null,
  "_meta": {
    "lastModified": "2025-01-01T00:00:00Z",
    "checksum": "test"
  }
}
EOF
}

# Create a todo.json with sample tasks
# Args: $1 = output file path
create_sample_todo() {
    local output_file="$1"
    cat > "$output_file" << 'EOF'
{
  "version": "2.4.0",
  "tasks": [
    {
      "id": "T001",
      "title": "Test Task 1",
      "description": "First test task for unit testing",
      "status": "pending",
      "priority": "medium",
      "createdAt": "2025-01-01T00:00:00Z"
    },
    {
      "id": "T002",
      "title": "Test Task 2",
      "description": "Second test task for unit testing",
      "status": "active",
      "priority": "high",
      "createdAt": "2025-01-01T00:00:00Z"
    }
  ],
  "focus": null,
  "_meta": {
    "lastModified": "2025-01-01T00:00:00Z",
    "checksum": "test"
  }
}
EOF
}

# Create a minimal config file for testing
# Args: $1 = output file path
create_minimal_config() {
    local output_file="$1"
    cat > "$output_file" << 'EOF'
{
  "version": "2.2.0",
  "validation": {
    "strictMode": false,
    "requireDescription": false
  }
}
EOF
}

# =============================================================================
# EXPORTS
# =============================================================================

export -f lib_test_setup
export -f lib_test_teardown
export -f load_lib_in_isolation
export -f load_libs_in_order
export -f load_bats_libs
export -f mock_function
export -f mock_function_capture_args
export -f mock_function_custom
export -f mock_function_sequence
export -f assert_function_defined
export -f assert_var_exported
export -f assert_var_equals
export -f assert_only_loaded
export -f create_minimal_todo
export -f create_sample_todo
export -f create_minimal_config
