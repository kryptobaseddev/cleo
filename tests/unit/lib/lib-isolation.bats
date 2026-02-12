#!/usr/bin/env bats
# =============================================================================
# lib-isolation.bats - Verify libraries can be sourced in isolation
# =============================================================================
# Tests that each library file can be sourced independently without errors,
# following the documented layer hierarchy and dependency requirements.
#
# Library Layers:
#   Layer 0 (Foundation): exit-codes.sh, platform-compat.sh, version.sh
#   Layer 1 (Core Infrastructure): config.sh, output-format.sh, error-json.sh,
#                                   atomic-write.sh, dependency-check.sh, jq-helpers.sh
#   Layer 2 (Core Services): file-ops.sh, validation.sh, logging.sh, backup.sh,
#                            hierarchy.sh, cache.sh, migrate.sh
#   Layer 3 (Domain Logic): phase-tracking.sh, analysis.sh, cancel-ops.sh,
#                           archive-cancel.sh, delete-preview.sh, deletion-strategy.sh,
#                           todowrite-integration.sh
# =============================================================================

# =============================================================================
# File-Level Setup (runs once per test file)
# =============================================================================
setup_file() {
    # Load BATS assertion libraries once per file
    load '../../libs/bats-support/load'
    load '../../libs/bats-assert/load'

    # Set up paths (exported for all tests)
    TEST_FILE_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
    export PROJECT_ROOT="$(cd "$TEST_FILE_DIR/../../.." && pwd)"
    export LIB_DIR="$PROJECT_ROOT/lib"
}

# =============================================================================
# Per-Test Setup (runs before each test)
# =============================================================================
setup() {
    # Reload libs for per-test assertion scope
    load '../../libs/bats-support/load'
    load '../../libs/bats-assert/load'

    # Use BATS-managed temp directory (auto-cleaned)
    TEST_DIR="${BATS_TEST_TMPDIR}"
    export CLAUDE_TODO_DIR="$TEST_DIR/.claude"
    mkdir -p "$CLAUDE_TODO_DIR"

    # Create minimal config and todo files for libraries that need them
    echo '{}' > "$CLAUDE_TODO_DIR/config.json"
    echo '{"tasks": [], "_meta": {"schemaVersion": "2.4.0"}}' > "$CLAUDE_TODO_DIR/todo.json"
    echo '{"entries": []}' > "$CLAUDE_TODO_DIR/todo-log.json"

    # Set environment variables
    export CLAUDE_TODO_HOME="$PROJECT_ROOT"
    export TODO_FILE="$CLAUDE_TODO_DIR/todo.json"
}

# No teardown needed - BATS auto-cleans BATS_TEST_TMPDIR

# =============================================================================
# LAYER 0 TESTS - Foundation (Zero Dependencies)
# =============================================================================
# These libraries MUST source with absolutely no dependencies

@test "Layer 0: exit-codes.sh sources in complete isolation" {
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        echo \"guard=\${_EXIT_CODES_SH_LOADED:-unset}\"
        echo \"EXIT_SUCCESS=\${EXIT_SUCCESS:-unset}\"
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "EXIT_SUCCESS=0"
}

@test "Layer 0: platform-compat.sh sources in complete isolation" {
    run bash -c "
        source '${LIB_DIR}/core/platform-compat.sh'
        echo \"guard=\${_PLATFORM_COMPAT_LOADED:-unset}\"
        echo \"PLATFORM=\${PLATFORM:-unset}\"
    "
    assert_success
    assert_output --partial "guard=1"
    # PLATFORM should be linux, macos, or windows
    assert_output --regexp "PLATFORM=(linux|macos|windows|unknown)"
}

@test "Layer 0: version.sh sources in complete isolation" {
    run bash -c "
        source '${LIB_DIR}/core/version.sh'
        echo \"guard=\${_VERSION_LOADED:-unset}\"
        # Version should be set (may be 'unknown' if VERSION file not found)
        echo \"version_defined=yes\"
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "version_defined=yes"
}

# =============================================================================
# LAYER 1 TESTS - Core Infrastructure
# =============================================================================
# These libraries may depend on Layer 0 libraries

@test "Layer 1: config.sh sources with Layer 0 deps" {
    run bash -c "
        source '${LIB_DIR}/core/config.sh'
        echo \"guard=\${_CONFIG_SH_LOADED:-unset}\"
        # Verify get_config_value function is defined
        if declare -f get_config_value > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 1: output-format.sh sources in isolation (no Layer 0 deps)" {
    run bash -c "
        source '${LIB_DIR}/core/output-format.sh'
        echo \"guard=\${_OUTPUT_FORMAT_LOADED:-unset}\"
        # Verify key functions are defined (load_output_config is the main entry point)
        if declare -f load_output_config > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 1: error-json.sh sources with Layer 0 deps" {
    run bash -c "
        source '${LIB_DIR}/core/error-json.sh'
        echo \"guard=\${_ERROR_JSON_SH_LOADED:-unset}\"
        # Verify output_error function is defined
        if declare -f output_error > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 1: atomic-write.sh sources with Layer 0 deps" {
    run bash -c "
        source '${LIB_DIR}/data/atomic-write.sh'
        echo \"guard=\${_ATOMIC_WRITE_LOADED:-unset}\"
        # Verify aw_atomic_write function is defined
        if declare -f aw_atomic_write > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 1: dependency-check.sh sources with optional Layer 0 deps" {
    run bash -c "
        source '${LIB_DIR}/tasks/dependency-check.sh'
        echo \"guard=\${_DEPENDENCY_CHECK_LOADED:-unset}\"
        # Verify check_jq function is defined (main entry point for dependency checking)
        if declare -f check_jq > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 1: jq-helpers.sh sources in isolation (no deps)" {
    run bash -c "
        source '${LIB_DIR}/core/jq-helpers.sh'
        echo \"guard=\${_JQ_HELPERS_LOADED:-unset}\"
        # Verify get_task_field function is defined
        if declare -f get_task_field > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

# =============================================================================
# LAYER 2 TESTS - Core Services
# =============================================================================
# These libraries depend on Layer 0 and Layer 1 libraries

@test "Layer 2: file-ops.sh sources with required deps" {
    run bash -c "
        source '${LIB_DIR}/data/file-ops.sh'
        echo \"guard=\${_FILE_OPS_LOADED:-unset}\"
        # Verify atomic_write function is defined
        if declare -f atomic_write > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 2: validation.sh sources with required deps" {
    run bash -c "
        export CLAUDE_TODO_HOME='${PROJECT_ROOT}'
        source '${LIB_DIR}/validation/validation.sh'
        echo \"guard=\${_VALIDATION_SH_LOADED:-unset}\"
        # Verify is_strict_mode function is defined (a config validation function)
        if declare -f is_strict_mode > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 2: logging.sh sources with required deps" {
    run bash -c "
        export CLAUDE_TODO_DIR='${CLAUDE_TODO_DIR}'
        source '${LIB_DIR}/core/logging.sh'
        echo \"guard=\${_LOGGING_LOADED:-unset}\"
        # Verify log_operation function is defined
        if declare -f log_operation > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 2: hierarchy.sh sources with required deps" {
    run bash -c "
        source '${LIB_DIR}/tasks/hierarchy.sh'
        echo \"guard=\${_HIERARCHY_LOADED:-unset}\"
        # Verify get_children function is defined
        if declare -f get_children > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 2: cache.sh sources with required deps" {
    run bash -c "
        export CLAUDE_DIR='${CLAUDE_TODO_DIR}'
        source '${LIB_DIR}/data/cache.sh'
        echo \"guard=\${_CACHE_LOADED:-unset}\"
        # Verify cache_init function is defined
        if declare -f cache_init > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 2: backup.sh sources with required deps" {
    run bash -c "
        export CLAUDE_TODO_DIR='${CLAUDE_TODO_DIR}'
        cd '${TEST_DIR}'
        source '${LIB_DIR}/data/backup.sh'
        echo \"guard=\${_BACKUP_LOADED:-unset}\"
        # Verify create_snapshot_backup function is defined
        if declare -f create_snapshot_backup > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 2: migrate.sh sources with required deps" {
    run bash -c "
        export CLAUDE_TODO_DIR='${CLAUDE_TODO_DIR}'
        export CLAUDE_TODO_HOME='${PROJECT_ROOT}'
        source '${LIB_DIR}/data/migrate.sh'
        echo \"guard=\${_MIGRATE_SH_LOADED:-unset}\"
        # Verify needs_migration function is defined (core migration check function)
        if declare -f needs_migration > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

# =============================================================================
# LAYER 3 TESTS - Domain Logic
# =============================================================================
# These libraries depend on lower layer libraries

@test "Layer 3: phase-tracking.sh sources with required deps" {
    run bash -c "
        export TODO_FILE='${TODO_FILE}'
        source '${LIB_DIR}/tasks/phase-tracking.sh'
        echo \"guard=\${_PHASE_TRACKING_LOADED:-unset}\"
        # Verify get_current_phase function is defined
        if declare -f get_current_phase > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 3: analysis.sh sources with required deps" {
    run bash -c "
        export CLAUDE_TODO_HOME='${PROJECT_ROOT}'
        source '${LIB_DIR}/tasks/analysis.sh'
        echo \"guard=\${_ANALYSIS_LOADED:-unset}\"
        # Verify calculate_leverage_scores function is defined
        if declare -f calculate_leverage_scores > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 3: cancel-ops.sh sources with required deps" {
    run bash -c "
        export CLAUDE_TODO_DIR='${CLAUDE_TODO_DIR}'
        source '${LIB_DIR}/tasks/cancel-ops.sh'
        echo \"guard=\${_CANCEL_OPS_LOADED:-unset}\"
        # Verify preflight_delete_check function is defined
        if declare -f preflight_delete_check > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 3: archive-cancel.sh sources with required deps" {
    run bash -c "
        export CLAUDE_TODO_DIR='${CLAUDE_TODO_DIR}'
        source '${LIB_DIR}/tasks/archive-cancel.sh'
        echo \"guard=\${_ARCHIVE_CANCEL_LOADED:-unset}\"
        # Verify archive_cancelled_task function is defined
        if declare -f archive_cancelled_task > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 3: delete-preview.sh sources with required deps" {
    run bash -c "
        source '${LIB_DIR}/tasks/delete-preview.sh'
        echo \"guard=\${_DELETE_PREVIEW_SH_LOADED:-unset}\"
        # Verify calculate_affected_tasks function is defined
        if declare -f calculate_affected_tasks > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 3: deletion-strategy.sh sources with required deps" {
    run bash -c "
        export CLAUDE_TODO_DIR='${CLAUDE_TODO_DIR}'
        source '${LIB_DIR}/tasks/deletion-strategy.sh'
        echo \"guard=\${_DELETION_STRATEGY_SH_LOADED:-unset}\"
        # Verify handle_children function is defined
        if declare -f handle_children > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

@test "Layer 3: todowrite-integration.sh sources in isolation (no deps)" {
    run bash -c "
        source '${LIB_DIR}/tasks/todowrite-integration.sh'
        echo \"guard=\${_TODOWRITE_INTEGRATION_LOADED:-unset}\"
        # Verify convert_to_active_form function is defined
        if declare -f convert_to_active_form > /dev/null 2>&1; then
            echo 'func=defined'
        else
            echo 'func=missing'
        fi
    "
    assert_success
    assert_output --partial "guard=1"
    assert_output --partial "func=defined"
}

# =============================================================================
# SOURCE GUARD TESTS
# =============================================================================
# Verify that double-sourcing is prevented by source guards

@test "Source guard: exit-codes.sh prevents double sourcing" {
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        first_load=\$_EXIT_CODES_SH_LOADED
        source '${LIB_DIR}/core/exit-codes.sh'
        second_load=\$_EXIT_CODES_SH_LOADED
        # Both should be 1, proving guard worked
        [[ \$first_load == '1' && \$second_load == '1' ]] && echo 'guard_works'
    "
    assert_success
    assert_output "guard_works"
}

@test "Source guard: platform-compat.sh prevents double sourcing" {
    run bash -c "
        source '${LIB_DIR}/core/platform-compat.sh'
        first_load=\$_PLATFORM_COMPAT_LOADED
        source '${LIB_DIR}/core/platform-compat.sh'
        second_load=\$_PLATFORM_COMPAT_LOADED
        [[ \$first_load == '1' && \$second_load == '1' ]] && echo 'guard_works'
    "
    assert_success
    assert_output "guard_works"
}

@test "Source guard: config.sh prevents double sourcing" {
    run bash -c "
        source '${LIB_DIR}/core/config.sh'
        first_load=\$_CONFIG_SH_LOADED
        source '${LIB_DIR}/core/config.sh'
        second_load=\$_CONFIG_SH_LOADED
        [[ \$first_load == '1' && \$second_load == '1' ]] && echo 'guard_works'
    "
    assert_success
    assert_output "guard_works"
}

@test "Source guard: file-ops.sh prevents double sourcing" {
    run bash -c "
        source '${LIB_DIR}/data/file-ops.sh'
        first_load=\$_FILE_OPS_LOADED
        source '${LIB_DIR}/data/file-ops.sh'
        second_load=\$_FILE_OPS_LOADED
        [[ \$first_load == '1' && \$second_load == '1' ]] && echo 'guard_works'
    "
    assert_success
    assert_output "guard_works"
}

# =============================================================================
# FULL STACK TEST
# =============================================================================
# Test that all libraries can be loaded together without conflicts

@test "Full stack: all libraries load together without errors" {
    run bash -c "
        export CLAUDE_TODO_DIR='${CLAUDE_TODO_DIR}'
        export CLAUDE_TODO_HOME='${PROJECT_ROOT}'
        export TODO_FILE='${TODO_FILE}'
        export CLAUDE_DIR='${CLAUDE_TODO_DIR}'
        cd '${TEST_DIR}'

        # Source in layer order (0 -> 1 -> 2 -> 3)
        # Layer 0
        source '${LIB_DIR}/core/exit-codes.sh'
        source '${LIB_DIR}/core/platform-compat.sh'
        source '${LIB_DIR}/core/version.sh'

        # Layer 1
        source '${LIB_DIR}/core/config.sh'
        source '${LIB_DIR}/core/output-format.sh'
        source '${LIB_DIR}/core/error-json.sh'
        source '${LIB_DIR}/data/atomic-write.sh'
        source '${LIB_DIR}/tasks/dependency-check.sh'
        source '${LIB_DIR}/core/jq-helpers.sh'

        # Layer 2
        source '${LIB_DIR}/data/file-ops.sh'
        source '${LIB_DIR}/validation/validation.sh'
        source '${LIB_DIR}/core/logging.sh'
        source '${LIB_DIR}/tasks/hierarchy.sh'
        source '${LIB_DIR}/data/cache.sh'
        source '${LIB_DIR}/data/backup.sh'
        source '${LIB_DIR}/data/migrate.sh'

        # Layer 3
        source '${LIB_DIR}/tasks/phase-tracking.sh'
        source '${LIB_DIR}/tasks/analysis.sh'
        source '${LIB_DIR}/tasks/cancel-ops.sh'
        source '${LIB_DIR}/tasks/archive-cancel.sh'
        source '${LIB_DIR}/tasks/delete-preview.sh'
        source '${LIB_DIR}/tasks/deletion-strategy.sh'
        source '${LIB_DIR}/tasks/todowrite-integration.sh'

        echo 'All libraries loaded successfully'
    "
    assert_success
    assert_output --partial "All libraries loaded successfully"
}

@test "Full stack: reverse order sourcing works due to internal dependency resolution" {
    # Libraries should handle their own dependencies when sourced out of order
    run bash -c "
        export CLAUDE_TODO_DIR='${CLAUDE_TODO_DIR}'
        export CLAUDE_TODO_HOME='${PROJECT_ROOT}'
        export TODO_FILE='${TODO_FILE}'
        export CLAUDE_DIR='${CLAUDE_TODO_DIR}'
        cd '${TEST_DIR}'

        # Source a Layer 3 library first - it should pull in its deps
        source '${LIB_DIR}/tasks/phase-tracking.sh'

        # Verify lower layer guards are set (deps were pulled in)
        [[ -n \"\${_PLATFORM_COMPAT_LOADED:-}\" ]] || { echo 'platform-compat not loaded'; exit 1; }
        [[ -n \"\${_FILE_OPS_LOADED:-}\" ]] || { echo 'file-ops not loaded'; exit 1; }

        echo 'Dependency resolution works'
    "
    assert_success
    assert_output --partial "Dependency resolution works"
}

# =============================================================================
# LIBRARY ENUMERATION TEST
# =============================================================================
# Ensure all .sh files in lib/ are accounted for in tests

@test "All lib/*.sh files have source guard variables" {
    local missing=""

    for lib_file in "${LIB_DIR}"/*.sh; do
        # Check for source guard pattern: [[ -n "${_..._LOADED:-}" ]]
        if ! grep -qE '^\[\[ -n "\$\{_[A-Z_]+_LOADED:-\}"' "$lib_file" 2>/dev/null; then
            missing="${missing}$(basename "$lib_file")\n"
        fi
    done

    if [[ -n "$missing" ]]; then
        echo "Libraries missing source guards:"
        echo -e "$missing"
        false
    fi
}

@test "All lib/*.sh files are tested in this suite" {
    # List of all library files expected
    local tested_libs=(
        "exit-codes.sh"
        "platform-compat.sh"
        "version.sh"
        "config.sh"
        "output-format.sh"
        "error-json.sh"
        "atomic-write.sh"
        "dependency-check.sh"
        "jq-helpers.sh"
        "file-ops.sh"
        "validation.sh"
        "logging.sh"
        "hierarchy.sh"
        "cache.sh"
        "backup.sh"
        "migrate.sh"
        "phase-tracking.sh"
        "analysis.sh"
        "cancel-ops.sh"
        "archive-cancel.sh"
        "delete-preview.sh"
        "deletion-strategy.sh"
        "todowrite-integration.sh"
    )

    local untested=""

    for lib_file in "${LIB_DIR}"/*.sh; do
        local basename_lib=$(basename "$lib_file")
        local found=false

        for tested in "${tested_libs[@]}"; do
            if [[ "$tested" == "$basename_lib" ]]; then
                found=true
                break
            fi
        done

        if [[ "$found" == "false" ]]; then
            untested="${untested}${basename_lib}\n"
        fi
    done

    if [[ -n "$untested" ]]; then
        echo "Libraries not covered by tests:"
        echo -e "$untested"
        echo ""
        echo "Add tests for these libraries to ensure isolation compliance."
        false
    fi
}

# =============================================================================
# READONLY PROTECTION TESTS
# =============================================================================
# Verify readonly variables don't cause errors on re-source

@test "Readonly variables: exit-codes.sh constants are readonly-safe" {
    run bash -c "
        source '${LIB_DIR}/core/exit-codes.sh'
        # Attempt to re-source (should not error due to readonly collision)
        source '${LIB_DIR}/core/exit-codes.sh'
        echo 'readonly_safe'
    "
    assert_success
    assert_output "readonly_safe"
}

@test "Readonly variables: platform-compat.sh PLATFORM is readonly-safe" {
    run bash -c "
        source '${LIB_DIR}/core/platform-compat.sh'
        source '${LIB_DIR}/core/platform-compat.sh'
        echo 'readonly_safe'
    "
    assert_success
    assert_output "readonly_safe"
}
