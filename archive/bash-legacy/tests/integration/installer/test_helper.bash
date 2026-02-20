#!/usr/bin/env bash
# =============================================================================
# test_helper.bash - Shared setup/teardown for installer BATS tests
# =============================================================================
# Task: T1870
# Provides isolated test environment for installer module testing.
# =============================================================================

# Load BATS libraries
_installer_load_libs() {
    local lib_dir="${BATS_TEST_DIRNAME}/../../libs"
    load "${lib_dir}/bats-support/load"
    load "${lib_dir}/bats-assert/load"
    load "${lib_dir}/bats-file/load"
}

# Setup installer paths
_installer_setup_paths() {
    export PROJECT_ROOT="${BATS_TEST_DIRNAME}/../../.."
    export INSTALLER_DIR="${PROJECT_ROOT}/installer"
    export INSTALLER_LIB_DIR="${INSTALLER_DIR}/lib"
    export INSTALLER_SCRIPT="${INSTALLER_DIR}/install.sh"

    # Test-specific temp directories
    export TEST_INSTALL_DIR="${BATS_TEST_TMPDIR}/cleo_test_install"
    export TEST_HOME_DIR="${BATS_TEST_TMPDIR}/home"
    export TEST_BIN_DIR="${TEST_HOME_DIR}/.local/bin"

    # Override CLEO paths for testing
    export CLEO_HOME="${TEST_INSTALL_DIR}"
    export HOME="${TEST_HOME_DIR}"
}

# Create isolated test environment
_installer_create_test_env() {
    mkdir -p "${TEST_INSTALL_DIR}"
    mkdir -p "${TEST_HOME_DIR}"
    mkdir -p "${TEST_BIN_DIR}"

    # Create mock shell profile
    export TEST_PROFILE="${TEST_HOME_DIR}/.bashrc"
    touch "${TEST_PROFILE}"

    # Set CLEO_HOME before loading installer libs so INSTALL_DIR uses our test path
    export CLEO_HOME="${TEST_INSTALL_DIR}"
}

# Clean up installer state between tests
_installer_cleanup() {
    # Remove test installation
    rm -rf "${TEST_INSTALL_DIR}" 2>/dev/null || true
    rm -rf "${TEST_HOME_DIR}" 2>/dev/null || true
}

# Load a specific installer library for testing
load_installer_lib() {
    local lib_name="$1"
    local lib_path="${INSTALLER_LIB_DIR}/${lib_name}.sh"

    if [[ ! -f "$lib_path" ]]; then
        fail "Installer library not found: $lib_path"
    fi

    # Initialize associative arrays before sourcing deps.sh
    if [[ "$lib_name" == "deps" ]]; then
        declare -gA DEPS_STATUS=()
        declare -gA DEPS_VERSION=()
    fi

    # Initialize recovery arrays before sourcing recover.sh
    if [[ "$lib_name" == "recover" ]]; then
        declare -gA RECOVERY_ACTIONS=()
        declare -gA RECOVERY_LEVELS=()
    fi

    source "$lib_path"
}

# Reset installer constants for testing (call after sourcing libs)
reset_installer_constants() {
    # Unset the guard variables to allow re-sourcing
    unset _INSTALLER_CORE_LOADED
    unset _INSTALLER_DEPS_LOADED
    unset _INSTALLER_VALIDATE_LOADED
    unset _INSTALLER_SOURCE_LOADED
    unset _INSTALLER_LINK_LOADED
    unset _INSTALLER_RECOVER_LOADED
    unset _INSTALLER_PROFILE_LOADED

    # Note: INSTALL_DIR and other readonly constants cannot be unset
    # Tests that need custom paths should set CLEO_HOME before loading libs
}

# Setup functions for tests
installer_setup_file() {
    _installer_load_libs
    _installer_setup_paths
}

installer_setup_per_test() {
    _installer_load_libs
    _installer_setup_paths
    _installer_create_test_env

    # Reset globals
    reset_installer_constants
}

installer_teardown_per_test() {
    _installer_cleanup
    cd "${PROJECT_ROOT}" 2>/dev/null || true
}

installer_teardown_file() {
    :  # BATS auto-cleans BATS_FILE_TMPDIR
}

# =============================================================================
# Mock Functions for Testing
# =============================================================================

# Mock GitHub API responses for offline testing
mock_github_api() {
    local response="${1:-}"

    # Create mock curl that returns our response
    function curl() {
        echo "$response"
        return 0
    }
    export -f curl
}

# Mock network unavailable
mock_network_unavailable() {
    function curl() {
        return 1
    }
    function wget() {
        return 1
    }
    export -f curl wget
}

# Create a minimal valid CLEO repo structure for testing
create_mock_repo() {
    local repo_dir="${1:-${BATS_TEST_TMPDIR}/mock_repo}"

    mkdir -p "${repo_dir}"/{lib,scripts,schemas,templates,docs,skills}

    # Create required files
    echo "0.55.0" > "${repo_dir}/VERSION"
    echo "# License" > "${repo_dir}/LICENSE"
    echo "# README" > "${repo_dir}/README.md"

    # Create mock library files
    cat > "${repo_dir}/lib/validation.sh" << 'EOF'
#!/usr/bin/env bash
validate_json() { echo "mock"; }
EOF

    cat > "${repo_dir}/lib/file-ops.sh" << 'EOF'
#!/usr/bin/env bash
atomic_write() { echo "mock"; }
EOF

    cat > "${repo_dir}/lib/config.sh" << 'EOF'
#!/usr/bin/env bash
get_config() { echo "mock"; }
EOF

    # Create mock script
    cat > "${repo_dir}/scripts/add.sh" << 'EOF'
#!/usr/bin/env bash
echo "mock add-task"
EOF
    chmod +x "${repo_dir}/scripts/add.sh"

    # Create mock schema
    cat > "${repo_dir}/schemas/todo.schema.json" << 'EOF'
{"$schema": "http://json-schema.org/draft-07/schema#", "type": "object"}
EOF

    # Create CLI wrapper
    cat > "${repo_dir}/cleo" << 'EOF'
#!/usr/bin/env bash
echo "CLEO CLI v0.55.0"
EOF
    chmod +x "${repo_dir}/cleo"

    echo "$repo_dir"
}

# Create an invalid (incomplete) repo structure
create_invalid_repo() {
    local repo_dir="${1:-${BATS_TEST_TMPDIR}/invalid_repo}"

    mkdir -p "${repo_dir}"
    # Missing required directories and files
    echo "0.55.0" > "${repo_dir}/VERSION"

    echo "$repo_dir"
}

# Create mock state file for recovery testing
create_mock_state() {
    local state="${1:-INIT}"
    local state_dir="${2:-${TEST_INSTALL_DIR}/.install-state}"

    mkdir -p "${state_dir}/markers" "${state_dir}/backups"

    cat > "${state_dir}/current" << EOF
{
    "state": "${state}",
    "previous_state": "",
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "version": "0.55.0",
    "source_dir": "${BATS_TEST_TMPDIR}/mock_repo",
    "install_dir": "${TEST_INSTALL_DIR}",
    "backup_path": null,
    "temp_dir": null,
    "options": {},
    "completed": [],
    "pending": ["INIT","PREPARE","VALIDATE","BACKUP","INSTALL","LINK","PROFILE","VERIFY","CLEANUP","COMPLETE"]
}
EOF

    echo "${state_dir}"
}

# Create mock backup for recovery testing
create_mock_backup() {
    local backup_dir="${1:-${TEST_INSTALL_DIR}/.install-state/backups}/$(date +%Y%m%d%H%M%S)"

    mkdir -p "$backup_dir"
    echo "0.54.0" > "$backup_dir/VERSION"
    mkdir -p "$backup_dir"/{lib,scripts,schemas}

    echo "$backup_dir"
}

# =============================================================================
# Interruption Testing Helpers (T1872)
# =============================================================================

# Simulate interruption at specific state
# Args: state [temp_dir] [backup_path]
simulate_interrupt_at_state() {
    local state="$1"
    local temp_dir="${2:-}"
    local backup_path="${3:-}"

    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "${state_dir}/markers" "${state_dir}/backups"

    # Build completed and pending arrays based on state
    local completed=()
    local pending=()
    local found=false

    local all_states=(INIT PREPARE VALIDATE BACKUP INSTALL LINK PROFILE VERIFY CLEANUP COMPLETE)
    for s in "${all_states[@]}"; do
        if [[ "$found" == "false" ]]; then
            if [[ "$s" == "$state" ]]; then
                found=true
                pending+=("$s")
            else
                completed+=("$s")
            fi
        else
            pending+=("$s")
        fi
    done

    # Build JSON arrays
    local completed_json pending_json prev_state
    if [[ ${#completed[@]} -eq 0 ]]; then
        completed_json="[]"
        prev_state=""
    else
        completed_json=$(printf '%s\n' "${completed[@]}" | jq -R . | jq -s .)
        prev_state="${completed[-1]}"
    fi
    pending_json=$(printf '%s\n' "${pending[@]}" | jq -R . | jq -s .)

    # Build JSON-safe values for optional fields
    local temp_dir_json backup_path_json
    if [[ -n "$temp_dir" ]]; then
        temp_dir_json="\"$temp_dir\""
    else
        temp_dir_json="null"
    fi
    if [[ -n "$backup_path" ]]; then
        backup_path_json="\"$backup_path\""
    else
        backup_path_json="null"
    fi

    # Create state file
    cat > "${state_dir}/current" << EOF
{
    "state": "${state}",
    "previous_state": "${prev_state}",
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "version": "0.55.0",
    "source_dir": "${BATS_TEST_TMPDIR}/mock_repo",
    "install_dir": "${TEST_INSTALL_DIR}",
    "backup_path": ${backup_path_json},
    "temp_dir": ${temp_dir_json},
    "options": {},
    "completed": ${completed_json},
    "pending": ${pending_json}
}
EOF
}

# Verify state is clean (no recovery needed)
assert_clean_state() {
    [[ ! -f "${TEST_INSTALL_DIR}/.install-state/current" ]] || {
        echo "State file still exists" >&2
        return 1
    }
    [[ ! -d "${TEST_INSTALL_DIR}/.install-state/temp" ]] || {
        echo "Temp directory still exists" >&2
        return 1
    }
}

# Verify state can be cleaned (for auto-recoverable states)
assert_clean_state_possible() {
    # State file may exist but should be in auto-recoverable state
    if [[ -f "${TEST_INSTALL_DIR}/.install-state/current" ]]; then
        local state
        state=$(jq -r '.state // "UNKNOWN"' "${TEST_INSTALL_DIR}/.install-state/current")
        # Auto-recoverable states: INIT, PREPARE, VALIDATE, VERIFY, CLEANUP, COMPLETE
        case "$state" in
            INIT|PREPARE|VALIDATE|VERIFY|CLEANUP|COMPLETE)
                return 0
                ;;
            *)
                echo "State $state is not auto-recoverable" >&2
                return 1
                ;;
        esac
    fi
    return 0
}

# Verify backup exists
assert_backup_exists() {
    [[ -d "${TEST_INSTALL_DIR}/.install-state/backups" ]] || {
        echo "Backups directory does not exist" >&2
        return 1
    }
    [[ -n "$(ls -A "${TEST_INSTALL_DIR}/.install-state/backups" 2>/dev/null)" ]] || {
        echo "Backups directory is empty" >&2
        return 1
    }
}

# Verify backup contains expected files
assert_backup_contains() {
    local backup_dir="$1"
    shift
    local files=("$@")

    for file in "${files[@]}"; do
        [[ -e "${backup_dir}/${file}" ]] || {
            echo "Backup missing: ${file}" >&2
            return 1
        }
    done
}

# Create a lock file for testing
create_test_lock() {
    local pid="${1:-$$}"
    local timestamp="${2:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
    local host="${3:-$(hostname)}"

    local lock_file="${TEST_INSTALL_DIR}/.install-state/.install.lock"
    mkdir -p "${TEST_INSTALL_DIR}/.install-state"
    echo "${pid}:${timestamp}:${host}" > "$lock_file"
    echo "$lock_file"
}

# Verify lock file state
assert_lock_exists() {
    [[ -f "${TEST_INSTALL_DIR}/.install-state/lock" ]] || {
        echo "Lock file does not exist" >&2
        return 1
    }
}

assert_lock_not_exists() {
    [[ ! -f "${TEST_INSTALL_DIR}/.install-state/lock" ]] || {
        echo "Lock file still exists" >&2
        return 1
    }
}
