#!/usr/bin/env bats
# =============================================================================
# paths-warnings.bats - Unit tests for paths.sh migration warning system
# =============================================================================
# Tests the once-per-session warning system for legacy installations.
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
    source "$PROJECT_ROOT/lib/core/paths.sh"

    # Reset warning state for each test
    reset_migration_warnings

    # Clear all environment variables
    unset CLEO_HOME CLEO_DIR CLEO_FORMAT CLEO_DEBUG
    unset CLAUDE_TODO_HOME CLAUDE_TODO_DIR CLAUDE_TODO_FORMAT CLAUDE_TODO_DEBUG
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Warning Function Existence Tests
# =============================================================================

@test "emit_migration_warning function exists" {
    run type -t emit_migration_warning
    assert_success
    assert_output "function"
}

@test "warn_if_legacy function exists" {
    run type -t warn_if_legacy
    assert_success
    assert_output "function"
}

@test "suppress_migration_warnings function exists" {
    run type -t suppress_migration_warnings
    assert_success
    assert_output "function"
}

@test "reset_migration_warnings function exists" {
    run type -t reset_migration_warnings
    assert_success
    assert_output "function"
}

# =============================================================================
# Once-Per-Session Tests
# =============================================================================

@test "emit_migration_warning shows message on first call" {
    run emit_migration_warning "global"
    assert_output --partial "[MIGRATION]"
    assert_output --partial "cleo claude-migrate"
}

@test "emit_migration_warning is silent on second call" {
    # First call
    emit_migration_warning "global" 2>/dev/null

    # Second call should be silent
    run emit_migration_warning "project"
    assert_output ""
}

@test "reset_migration_warnings allows warning again" {
    # First call
    emit_migration_warning "global" 2>/dev/null

    # Reset
    reset_migration_warnings

    # Should show warning again
    run emit_migration_warning "project"
    assert_output --partial "[MIGRATION]"
}

@test "suppress_migration_warnings prevents all warnings" {
    suppress_migration_warnings

    run emit_migration_warning "global"
    assert_output ""
}

# =============================================================================
# Warning Type Tests
# =============================================================================

@test "emit_migration_warning type=global mentions ~/.claude-todo" {
    run emit_migration_warning "global"
    assert_output --partial "~/.claude-todo"
    assert_output --partial "~/.cleo"
}

@test "emit_migration_warning type=project mentions .claude/" {
    run emit_migration_warning "project"
    assert_output --partial ".claude/"
    assert_output --partial ".cleo/"
}

@test "emit_migration_warning type=env mentions specific variable" {
    run emit_migration_warning "env" "CLAUDE_TODO_HOME"
    assert_output --partial "CLAUDE_TODO_HOME"
    assert_output --partial "CLEO_* variables"
}

@test "emit_migration_warning unknown type shows general message" {
    run emit_migration_warning "unknown"
    assert_output --partial "[MIGRATION]"
    assert_output --partial "cleo claude-migrate"
}

# =============================================================================
# Legacy Environment Variable Warning Tests
# =============================================================================

@test "check_legacy_env_vars warns on CLAUDE_TODO_HOME" {
    export CLAUDE_TODO_HOME="/some/path"
    run check_legacy_env_vars
    assert_output --partial "CLAUDE_TODO_HOME"
}

@test "check_legacy_env_vars warns on CLAUDE_TODO_DIR" {
    export CLAUDE_TODO_DIR=".legacy"
    run check_legacy_env_vars
    assert_output --partial "CLAUDE_TODO_DIR"
}

@test "check_legacy_env_vars warns on CLAUDE_TODO_FORMAT" {
    export CLAUDE_TODO_FORMAT="text"
    run check_legacy_env_vars
    assert_output --partial "CLAUDE_TODO_FORMAT"
}

@test "check_legacy_env_vars warns on CLAUDE_TODO_DEBUG" {
    export CLAUDE_TODO_DEBUG="true"
    run check_legacy_env_vars
    assert_output --partial "CLAUDE_TODO_DEBUG"
}

@test "check_legacy_env_vars silent when no legacy vars" {
    run check_legacy_env_vars
    assert_output ""
}

@test "check_legacy_env_vars only warns once for multiple legacy vars" {
    export CLAUDE_TODO_HOME="/path"
    export CLAUDE_TODO_DIR=".legacy"

    run check_legacy_env_vars
    # Should only mention first detected variable
    assert_output --partial "CLAUDE_TODO_HOME"
    refute_output --partial "CLAUDE_TODO_DIR"
}

# =============================================================================
# warn_if_legacy Integration Tests
# =============================================================================

@test "warn_if_legacy checks env vars first" {
    export CLAUDE_TODO_HOME="/legacy"
    run warn_if_legacy
    assert_output --partial "CLAUDE_TODO_HOME"
}

@test "warn_if_legacy only shows one warning per session" {
    export CLAUDE_TODO_HOME="/legacy"

    # First call
    warn_if_legacy 2>/dev/null

    # Even with legacy project dir, should be silent
    mkdir -p "$TEST_TEMP_DIR/.claude"
    cd "$TEST_TEMP_DIR"

    run warn_if_legacy
    assert_output ""
}

# =============================================================================
# Output Stream Tests
# =============================================================================

@test "emit_migration_warning outputs to stderr" {
    # Capture stderr only
    run bash -c 'source "$1/lib/core/paths.sh"; emit_migration_warning "global" 2>&1 >/dev/null' -- "$PROJECT_ROOT"
    assert_output --partial "[MIGRATION]"
}

@test "emit_migration_warning does not output to stdout" {
    # Capture stdout only (should be empty)
    result=$(emit_migration_warning "global" 2>/dev/null)
    assert_equal "$result" ""
}

# =============================================================================
# Migration Command Reference Tests
# =============================================================================

@test "all warning types mention cleo claude-migrate" {
    for type in global project env; do
        reset_migration_warnings
        run emit_migration_warning "$type" "TEST_VAR"
        assert_output --partial "cleo claude-migrate"
    done
}

@test "all warning types mention --help option" {
    for type in global project env; do
        reset_migration_warnings
        run emit_migration_warning "$type" "TEST_VAR"
        assert_output --partial "--help"
    done
}
