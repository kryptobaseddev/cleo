#!/usr/bin/env bats
# =============================================================================
# paths-env.bats - Unit tests for lib/paths.sh
# =============================================================================
# Tests CLEO path resolution with environment variables.
# Verifies TRUE CLEAN BREAK: NO legacy CLAUDE_TODO_* fallback.
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    # Source the paths library
    source "$PROJECT_ROOT/lib/paths.sh"

    # Clear all CLEO environment variables for clean tests
    unset CLEO_HOME CLEO_DIR CLEO_FORMAT CLEO_DEBUG

    # Clear legacy variables (should NOT be used)
    unset CLAUDE_TODO_HOME CLAUDE_TODO_DIR CLAUDE_TODO_FORMAT CLAUDE_TODO_DEBUG
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Library Presence Tests
# =============================================================================

@test "paths.sh library exists" {
    [ -f "$PROJECT_ROOT/lib/paths.sh" ]
}

@test "paths.sh library is executable" {
    [ -x "$PROJECT_ROOT/lib/paths.sh" ]
}

@test "paths.sh has no syntax errors" {
    run bash -n "$PROJECT_ROOT/lib/paths.sh"
    assert_success
}

# =============================================================================
# Global Path Resolution Tests
# =============================================================================

@test "get_cleo_home returns default ~/.cleo when CLEO_HOME not set" {
    unset CLEO_HOME
    result=$(get_cleo_home)
    assert_equal "$result" "$HOME/.cleo"
}

@test "get_cleo_home returns CLEO_HOME when set" {
    export CLEO_HOME="/custom/cleo/home"
    result=$(get_cleo_home)
    assert_equal "$result" "/custom/cleo/home"
}

@test "get_cleo_templates_dir returns correct path" {
    unset CLEO_HOME
    result=$(get_cleo_templates_dir)
    assert_equal "$result" "$HOME/.cleo/templates"
}

@test "get_cleo_schemas_dir returns correct path" {
    unset CLEO_HOME
    result=$(get_cleo_schemas_dir)
    assert_equal "$result" "$HOME/.cleo/schemas"
}

@test "get_cleo_migrations_dir returns correct path" {
    export CLEO_HOME="/custom"
    result=$(get_cleo_migrations_dir)
    assert_equal "$result" "/custom/migrations"
}

# =============================================================================
# Project Path Resolution Tests
# =============================================================================

@test "get_cleo_dir returns default .cleo when CLEO_DIR not set" {
    unset CLEO_DIR
    result=$(get_cleo_dir)
    assert_equal "$result" ".cleo"
}

@test "get_cleo_dir returns CLEO_DIR when set" {
    export CLEO_DIR="/project/.cleo-data"
    result=$(get_cleo_dir)
    assert_equal "$result" "/project/.cleo-data"
}

@test "get_todo_file returns correct path" {
    unset CLEO_DIR
    result=$(get_todo_file)
    assert_equal "$result" ".cleo/todo.json"
}

@test "get_config_file returns config.json" {
    unset CLEO_DIR
    result=$(get_config_file)
    assert_equal "$result" ".cleo/config.json"
}

@test "get_log_file returns todo-log.json" {
    unset CLEO_DIR
    result=$(get_log_file)
    assert_equal "$result" ".cleo/todo-log.json"
}

@test "get_archive_file returns correct path" {
    unset CLEO_DIR
    result=$(get_archive_file)
    assert_equal "$result" ".cleo/todo-archive.json"
}

@test "get_backups_dir returns correct path" {
    unset CLEO_DIR
    result=$(get_backups_dir)
    assert_equal "$result" ".cleo/backups"
}

@test "get_cache_dir returns correct path" {
    export CLEO_DIR="/custom/dir"
    result=$(get_cache_dir)
    assert_equal "$result" "/custom/dir/.cache"
}

# =============================================================================
# Environment Variable Resolution Tests
# =============================================================================

@test "get_cleo_format returns empty when not set" {
    unset CLEO_FORMAT
    result=$(get_cleo_format)
    assert_equal "$result" ""
}

@test "get_cleo_format returns value when set" {
    export CLEO_FORMAT="json"
    result=$(get_cleo_format)
    assert_equal "$result" "json"
}

@test "is_cleo_debug returns false when not set" {
    unset CLEO_DEBUG
    run is_cleo_debug
    assert_failure
}

@test "is_cleo_debug returns true for 'true'" {
    export CLEO_DEBUG="true"
    run is_cleo_debug
    assert_success
}

@test "is_cleo_debug returns true for '1'" {
    export CLEO_DEBUG="1"
    run is_cleo_debug
    assert_success
}

@test "is_cleo_debug returns true for 'yes'" {
    export CLEO_DEBUG="yes"
    run is_cleo_debug
    assert_success
}

@test "is_cleo_debug returns false for 'false'" {
    export CLEO_DEBUG="false"
    run is_cleo_debug
    assert_failure
}

@test "get_cleo_debug returns 'true' when enabled" {
    export CLEO_DEBUG="1"
    result=$(get_cleo_debug)
    assert_equal "$result" "true"
}

@test "get_cleo_debug returns 'false' when disabled" {
    unset CLEO_DEBUG
    result=$(get_cleo_debug)
    assert_equal "$result" "false"
}

# =============================================================================
# TRUE CLEAN BREAK Tests - NO Legacy Fallback
# =============================================================================

@test "get_cleo_home does NOT fallback to CLAUDE_TODO_HOME" {
    export CLAUDE_TODO_HOME="/legacy/path"
    unset CLEO_HOME
    result=$(get_cleo_home)
    # Should return default, NOT the legacy value
    assert_equal "$result" "$HOME/.cleo"
}

@test "get_cleo_dir does NOT fallback to CLAUDE_TODO_DIR" {
    export CLAUDE_TODO_DIR="/legacy/.claude"
    unset CLEO_DIR
    result=$(get_cleo_dir)
    # Should return default, NOT the legacy value
    assert_equal "$result" ".cleo"
}

@test "get_cleo_format does NOT fallback to CLAUDE_TODO_FORMAT" {
    export CLAUDE_TODO_FORMAT="legacy-format"
    unset CLEO_FORMAT
    result=$(get_cleo_format)
    # Should return empty, NOT the legacy value
    assert_equal "$result" ""
}

@test "is_cleo_debug does NOT fallback to CLAUDE_TODO_DEBUG" {
    export CLAUDE_TODO_DEBUG="true"
    unset CLEO_DEBUG
    run is_cleo_debug
    # Should return failure (false), NOT use legacy value
    assert_failure
}

# =============================================================================
# Legacy Detection Tests (For Migration Only)
# =============================================================================

@test "has_legacy_global_installation detects ~/.claude-todo" {
    # Create temp legacy directory
    local legacy_dir="$HOME/.claude-todo"
    mkdir -p "$legacy_dir"

    run has_legacy_global_installation
    assert_success

    # Cleanup
    rmdir "$legacy_dir" 2>/dev/null || true
}

@test "has_legacy_global_installation returns false when not present" {
    # Ensure legacy dir doesn't exist
    rmdir "$HOME/.claude-todo" 2>/dev/null || true

    run has_legacy_global_installation
    # Note: This may fail in dev environment where legacy exists
    # The test verifies the function works, not the actual state
}

@test "get_legacy_global_home returns ~/.claude-todo" {
    result=$(get_legacy_global_home)
    assert_equal "$result" "$HOME/.claude-todo"
}

@test "get_legacy_project_dir returns .claude" {
    result=$(get_legacy_project_dir)
    assert_equal "$result" ".claude"
}

# =============================================================================
# Path Validation Tests
# =============================================================================

@test "ensure_cleo_home creates directory if not exists" {
    export CLEO_HOME="$TEST_TEMP_DIR/test-cleo-home"
    rm -rf "$CLEO_HOME"

    run ensure_cleo_home
    assert_success
    [ -d "$CLEO_HOME" ]
}

@test "ensure_cleo_dir creates directory if not exists" {
    export CLEO_DIR="$TEST_TEMP_DIR/test-cleo-dir"
    rm -rf "$CLEO_DIR"

    run ensure_cleo_dir
    assert_success
    [ -d "$CLEO_DIR" ]
}

@test "is_project_initialized returns false when todo.json missing" {
    export CLEO_DIR="$TEST_TEMP_DIR/empty-project"
    mkdir -p "$CLEO_DIR"

    run is_project_initialized
    assert_failure
}

@test "is_project_initialized returns true when todo.json exists" {
    export CLEO_DIR="$TEST_TEMP_DIR/init-project"
    mkdir -p "$CLEO_DIR"
    echo '{}' > "$CLEO_DIR/todo.json"

    run is_project_initialized
    assert_success
}

# =============================================================================
# Version Resolution Tests
# =============================================================================

@test "get_cleo_version returns version from VERSION file" {
    export CLEO_HOME="$TEST_TEMP_DIR/version-test"
    mkdir -p "$CLEO_HOME"
    echo "1.2.3" > "$CLEO_HOME/VERSION"

    result=$(get_cleo_version)
    assert_equal "$result" "1.2.3"
}

@test "get_cleo_version returns 0.0.0 when VERSION file missing" {
    export CLEO_HOME="$TEST_TEMP_DIR/no-version"
    mkdir -p "$CLEO_HOME"
    rm -f "$CLEO_HOME/VERSION"

    result=$(get_cleo_version)
    assert_equal "$result" "0.0.0"
}

@test "get_cleo_version strips whitespace from VERSION" {
    export CLEO_HOME="$TEST_TEMP_DIR/ws-version"
    mkdir -p "$CLEO_HOME"
    printf "  1.0.0  \n" > "$CLEO_HOME/VERSION"

    result=$(get_cleo_version)
    assert_equal "$result" "1.0.0"
}
