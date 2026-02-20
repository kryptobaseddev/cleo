#!/usr/bin/env bats
# =============================================================================
# sessionstart-hook.bats - Unit tests for SessionStart hook script
# =============================================================================
# Tests Claude Code SessionStart hook functionality for CLEO session binding
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test

    # Define hook paths (relative to PROJECT_ROOT which is set by common_setup)
    export HOOK_SCRIPT="${PROJECT_ROOT}/.claude-plugin/hooks/scripts/session-start.sh"
    export HOOKS_JSON="${PROJECT_ROOT}/.claude-plugin/hooks/hooks.json"
    export SESSION_ENV_FILE="${TEST_TEMP_DIR}/.cleo/.session-env"
    export CURRENT_SESSION_FILE="${TEST_TEMP_DIR}/.cleo/.current-session"
}

teardown() {
    # Clean up session env file
    rm -f "$SESSION_ENV_FILE"
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Script Presence Tests
# =============================================================================

@test "session-start hook script exists" {
    [ -f "$HOOK_SCRIPT" ]
}

@test "session-start hook script is executable" {
    [ -x "$HOOK_SCRIPT" ]
}

@test "hooks.json configuration file exists" {
    [ -f "$HOOKS_JSON" ]
}

@test "hooks.json is valid JSON" {
    run jq empty "$HOOKS_JSON"
    assert_success
}

@test "hooks.json contains SessionStart hook definition" {
    run jq -r '.SessionStart' "$HOOKS_JSON"
    assert_success
    refute_output "null"
}

@test "hooks.json references session-start.sh script" {
    run jq -r '.SessionStart[0].hooks[0].command' "$HOOKS_JSON"
    assert_success
    assert_output --partial "session-start.sh"
}

# =============================================================================
# Environment Binding Tests
# =============================================================================

@test "session-start binds CLEO_SESSION env var when active session exists" {
    skip "Test requires active session state - verified via integration testing"
    # This test requires complex session state setup with sessions.json
    # The functionality is verified through integration tests.
}

@test "session-start writes session info to stderr when session is active" {
    skip "Test requires active session validation - verified via integration testing"
    # This test is skipped because verifying active session status requires
    # complex session state setup. The functionality is verified through
    # integration tests and manual testing.
}

@test "session-start does not bind if session is not active" {
    create_independent_tasks

    # Create session and immediately end it (suspended/ended status)
    bash "$SESSION_SCRIPT" start
    local session_id
    session_id=$(jq -r '._meta.activeSession' "$TODO_FILE")
    bash "$SESSION_SCRIPT" end

    # Write ended session ID to .current-session file
    echo "$session_id" > ".cleo/.current-session"

    # Run hook script
    run bash "$HOOK_SCRIPT"
    assert_success

    # Verify .session-env file was NOT created
    [ ! -f ".cleo/.session-env" ]
}

# =============================================================================
# Graceful Degradation Tests
# =============================================================================

@test "session-start handles missing cleo installation gracefully" {
    # Temporarily rename cleo binary
    local cleo_backup="${HOME}/.cleo/cleo.backup"
    if [ -x "${HOME}/.cleo/cleo" ]; then
        mv "${HOME}/.cleo/cleo" "$cleo_backup"
    fi

    # Run hook script
    run bash "$HOOK_SCRIPT"
    assert_success

    # Restore cleo binary
    if [ -f "$cleo_backup" ]; then
        mv "$cleo_backup" "${HOME}/.cleo/cleo"
    fi
}

@test "session-start handles missing .cleo directory gracefully" {
    # Run from non-cleo project directory
    local temp_dir
    temp_dir=$(mktemp -d)
    local original_dir="$PWD"
    cd "$temp_dir"

    run bash "$HOOK_SCRIPT"
    assert_success

    # Cleanup
    cd "$original_dir"
    rm -rf "$temp_dir"
}

@test "session-start handles missing .current-session file gracefully" {
    create_independent_tasks

    # Ensure .current-session file does not exist
    rm -f ".cleo/.current-session"

    # Run hook script
    run bash "$HOOK_SCRIPT"
    assert_success

    # No session env file should be created
    [ ! -f ".cleo/.session-env" ]
}

@test "session-start handles empty .current-session file gracefully" {
    create_independent_tasks

    # Create empty .current-session file
    touch ".cleo/.current-session"

    # Run hook script
    run bash "$HOOK_SCRIPT"
    assert_success

    # No session env file should be created
    [ ! -f ".cleo/.session-env" ]
}

@test "session-start handles invalid session ID gracefully" {
    create_independent_tasks

    # Write invalid session ID
    echo "invalid_session_id" > ".cleo/.current-session"

    # Run hook script
    run bash "$HOOK_SCRIPT"
    assert_success

    # No session env file should be created
    [ ! -f ".cleo/.session-env" ]
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "session-start works with existing active session workflow" {
    skip "Test requires active session state - verified via integration testing"
    # Full workflow testing requires proper session state in sessions.json
}

@test "session-start respects timeout setting in hooks.json" {
    # Verify timeout is configured
    run jq -r '.SessionStart[0].hooks[0].timeout' "$HOOKS_JSON"
    assert_success
    assert_output "10"
}

@test "session-start script has proper shebang and error handling" {
    # Verify shebang
    run head -n1 "$HOOK_SCRIPT"
    assert_success
    assert_output --partial "#!/usr/bin/env bash"

    # Verify error handling (set -euo pipefail)
    run grep -n "set -euo pipefail" "$HOOK_SCRIPT"
    assert_success
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "session-start handles concurrent session start race condition" {
    skip "Test requires active session state - verified via integration testing"
    # Concurrent execution testing requires proper session state setup
}

@test "session-start does not interfere with non-cleo projects" {
    # Create temporary non-cleo directory
    local temp_dir
    temp_dir=$(mktemp -d)
    local original_dir="$PWD"
    cd "$temp_dir"

    # Run hook (should exit gracefully with no .cleo directory)
    run bash "$HOOK_SCRIPT"
    assert_success

    # Cleanup
    cd "$original_dir"
    rm -rf "$temp_dir"
}
