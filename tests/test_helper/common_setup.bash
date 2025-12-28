#!/usr/bin/env bash
# =============================================================================
# common_setup.bash - Shared setup/teardown for BATS tests
# =============================================================================
# Single source of truth for test configuration and environment setup.
# All test files should load this for consistent behavior.
#
# Two usage patterns are supported:
#
# PATTERN 1: Legacy (per-test setup) - backward compatible
#   setup() {
#       load '../test_helper/common_setup'
#       load '../test_helper/fixtures'
#       common_setup
#   }
#
# PATTERN 2: Optimized (file-level setup) - reduces library loading overhead
#   setup_file() {
#       load '../test_helper/common_setup'
#       load '../test_helper/fixtures'
#       common_setup_file
#   }
#   setup() {
#       common_setup_per_test
#   }
#   teardown() {
#       common_teardown_per_test
#   }
#   teardown_file() {
#       common_teardown_file
#   }
# =============================================================================

# Load external BATS libraries
_load_libs() {
    # Handle both tests/foo.bats and tests/unit/foo.bats paths
    local lib_dir
    if [[ -d "${BATS_TEST_DIRNAME}/libs" ]]; then
        lib_dir="${BATS_TEST_DIRNAME}/libs"
    else
        lib_dir="${BATS_TEST_DIRNAME}/../libs"
    fi

    # bats-support must be loaded first (provides common functions)
    load "${lib_dir}/bats-support/load"
    load "${lib_dir}/bats-assert/load"
    load "${lib_dir}/bats-file/load"
}

# Project paths - single source of truth
_setup_paths() {
    # Handle both tests/foo.bats and tests/unit/foo.bats paths
    if [[ -d "${BATS_TEST_DIRNAME}/libs" ]]; then
        # Test file is directly in tests/
        export PROJECT_ROOT="${BATS_TEST_DIRNAME}/.."
        export FIXTURES_DIR="${BATS_TEST_DIRNAME}/fixtures"
    else
        # Test file is in a subdirectory like tests/unit/
        export PROJECT_ROOT="${BATS_TEST_DIRNAME}/../.."
        export FIXTURES_DIR="${BATS_TEST_DIRNAME}/../fixtures"
    fi

    export SCRIPTS_DIR="${PROJECT_ROOT}/scripts"
    export LIB_DIR="${PROJECT_ROOT}/lib"

    # Use BATS auto-cleaned temp directories
    export TEST_TEMP_DIR="${BATS_TEST_TMPDIR}"
    export TEST_FILE_TEMP_DIR="${BATS_FILE_TMPDIR:-$BATS_TEST_TMPDIR}"
}

# Create standard test project structure in temp directory
_create_test_project() {
    local base_dir="${1:-$TEST_TEMP_DIR}"

    # Create both old and new backup directory structures for test compatibility
    mkdir -p "${base_dir}/.cleo/.backups"
    mkdir -p "${base_dir}/.cleo/backups/operational"
    mkdir -p "${base_dir}/.cleo/backups/safety"
    mkdir -p "${base_dir}/.cleo/backups/snapshot"
    mkdir -p "${base_dir}/.cleo/backups/archive"

    export TODO_FILE="${base_dir}/.cleo/todo.json"
    export CONFIG_FILE="${base_dir}/.cleo/config.json"
    export LOG_FILE="${base_dir}/.cleo/todo-log.json"
    export ARCHIVE_FILE="${base_dir}/.cleo/todo-archive.json"
    # Use new backup path (Tier 1 operational backups)
    export BACKUPS_DIR="${base_dir}/.cleo/backups/operational"
    export SAFETY_BACKUPS_DIR="${base_dir}/.cleo/backups/safety"

    # Create minimal config (version must match SCHEMA_VERSION_CONFIG in lib/migrate.sh)
    cat > "$CONFIG_FILE" << 'EOF'
{
  "version": "2.2.0",
  "validation": {
    "strictMode": false,
    "requireDescription": false
  }
}
EOF

    # Create empty log
    echo '{"entries": [], "_meta": {"version": "2.1.0"}}' > "$LOG_FILE"

    # Create empty archive file (needed for delete's immediate archiving)
    cat > "$ARCHIVE_FILE" << 'EOF'
{
  "version": "2.4.0",
  "project": "test",
  "_meta": {"totalArchived": 0, "lastArchived": null},
  "archivedTasks": [],
  "statistics": {"byPhase": {}, "byPriority": {"critical":0,"high":0,"medium":0,"low":0}, "byLabel": {}, "cancelled": 0}
}
EOF

    # Change to test directory so scripts find .cleo/
    cd "$base_dir"
}

# Export script paths for easy access
_setup_scripts() {
    export BLOCKERS_SCRIPT="${SCRIPTS_DIR}/blockers-command.sh"
    export DEPS_SCRIPT="${SCRIPTS_DIR}/deps-command.sh"
    export ADD_SCRIPT="${SCRIPTS_DIR}/add-task.sh"
    export UPDATE_SCRIPT="${SCRIPTS_DIR}/update-task.sh"
    export COMPLETE_SCRIPT="${SCRIPTS_DIR}/complete-task.sh"
    export VALIDATE_SCRIPT="${SCRIPTS_DIR}/validate.sh"
    export LIST_SCRIPT="${SCRIPTS_DIR}/list-tasks.sh"
    export INIT_SCRIPT="${SCRIPTS_DIR}/init.sh"
    export ARCHIVE_SCRIPT="${SCRIPTS_DIR}/archive.sh"
    export SESSION_SCRIPT="${SCRIPTS_DIR}/session.sh"
    export FOCUS_SCRIPT="${SCRIPTS_DIR}/focus.sh"
    export LOG_SCRIPT="${SCRIPTS_DIR}/log.sh"
    export EXPORT_SCRIPT="${SCRIPTS_DIR}/export.sh"
    export DASH_SCRIPT="${SCRIPTS_DIR}/dash.sh"
    export NEXT_SCRIPT="${SCRIPTS_DIR}/next.sh"
    export LABELS_SCRIPT="${SCRIPTS_DIR}/labels.sh"
    export STATS_SCRIPT="${SCRIPTS_DIR}/stats.sh"
    export MIGRATE_SCRIPT="${SCRIPTS_DIR}/migrate.sh"
    export BACKUP_SCRIPT="${SCRIPTS_DIR}/backup.sh"
    export RESTORE_SCRIPT="${SCRIPTS_DIR}/restore.sh"
    export PHASE_SCRIPT="${SCRIPTS_DIR}/phase.sh"
    export FIND_SCRIPT="${SCRIPTS_DIR}/find.sh"
    export SHOW_SCRIPT="${SCRIPTS_DIR}/show.sh"
    export EXISTS_SCRIPT="${SCRIPTS_DIR}/exists.sh"
    # Dispatcher (install.sh wrapper script)
    export DISPATCHER_SCRIPT="${PROJECT_ROOT}/install.sh"
}

# Standard setup every test file uses
common_setup() {
    _load_libs
    _setup_paths
    _setup_scripts
    _create_test_project

    # Force text output format for tests (LLM-Agent-First defaults to JSON in non-TTY)
    export CLAUDE_TODO_FORMAT="text"
}

# Optional: common teardown
common_teardown() {
    # Return to original directory
    cd "${PROJECT_ROOT}" 2>/dev/null || true
}

# =============================================================================
# File-Level Setup Functions (setup_file pattern)
# =============================================================================
# Use these for tests that can share common setup across all tests in a file.
# Library loading and script paths only need to happen once per file.
# =============================================================================

# File-level setup (runs once per test file)
# Call this in setup_file() to load libs and set up paths once per file
common_setup_file() {
    _load_libs
    _setup_paths
    _setup_scripts
}

# Per-test setup when using setup_file pattern
# Call this in setup() after common_setup_file() has run in setup_file()
common_setup_per_test() {
    # Load libs again for per-test scope (assertions need to be available)
    _load_libs
    # Re-setup paths for per-test scope (BATS_TEST_TMPDIR changes per test)
    _setup_paths
    _setup_scripts
    _create_test_project
    export CLAUDE_TODO_FORMAT="text"
}

# Per-test teardown
common_teardown_per_test() {
    cd "${PROJECT_ROOT}" 2>/dev/null || true
}

# File-level teardown
common_teardown_file() {
    :  # BATS auto-cleans BATS_FILE_TMPDIR
}
