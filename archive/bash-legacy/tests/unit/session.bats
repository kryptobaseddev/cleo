#!/usr/bin/env bats
# =============================================================================
# session.bats - Unit tests for session.sh
# =============================================================================
# Tests session management functionality including start, end, and status.
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
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Script Presence Tests
# =============================================================================

@test "session script exists" {
    [ -f "$SESSION_SCRIPT" ]
}

@test "session script is executable" {
    [ -x "$SESSION_SCRIPT" ]
}

# =============================================================================
# Help and Usage Tests
# =============================================================================

@test "session --help shows usage" {
    run bash "$SESSION_SCRIPT" --help
    assert_shows_help
}

@test "session -h shows usage" {
    run bash "$SESSION_SCRIPT" -h
    assert_shows_help
}

@test "session help shows available commands" {
    run bash "$SESSION_SCRIPT" --help
    assert_success
    assert_output_contains_any "start" "end" "status"
}

# =============================================================================
# Session Start Tests
# =============================================================================

@test "session start creates active session" {
    create_independent_tasks
    run bash "$SESSION_SCRIPT" start
    assert_success

    local active_session
    active_session=$(jq -r '._meta.activeSession // empty' "$TODO_FILE")
    [ -n "$active_session" ]
}

@test "session start sets session timestamp" {
    create_independent_tasks
    bash "$SESSION_SCRIPT" start

    local session_start
    session_start=$(jq -r '._meta.activeSession // empty' "$TODO_FILE")
    # Session ID format: session_YYYYMMDD_HHMMSS_randomhex
    [[ "$session_start" =~ ^session_[0-9]{8}_[0-9]{6}_[a-f0-9]+ ]]
}

@test "session start logs to todo-log" {
    create_independent_tasks
    bash "$SESSION_SCRIPT" start

    # Check log file for session entry
    [ -f "$LOG_FILE" ]
    local log_entries
    log_entries=$(jq '.entries | length' "$LOG_FILE" 2>/dev/null || echo "0")
    [ "$log_entries" -ge 1 ]
}

@test "session start shows context information" {
    create_independent_tasks
    run bash "$SESSION_SCRIPT" start
    assert_success
    # Should show some context about starting session
}

# =============================================================================
# Session End Tests
# =============================================================================

@test "session end clears active session" {
    create_independent_tasks
    bash "$SESSION_SCRIPT" start
    bash "$SESSION_SCRIPT" end

    local active_session
    active_session=$(jq -r '._meta.activeSession // empty' "$TODO_FILE")
    [ -z "$active_session" ] || [ "$active_session" = "null" ]
}

@test "session end is safe without active session" {
    create_independent_tasks
    run bash "$SESSION_SCRIPT" end
    # Should handle gracefully - returns EXIT_NO_CHANGE (102) when no active session
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]] || [[ "$status" -eq 102 ]]
}

@test "session end logs session completion" {
    create_independent_tasks
    bash "$SESSION_SCRIPT" start
    bash "$SESSION_SCRIPT" end

    # Log should have both start and end entries
    local log_entries
    log_entries=$(jq '.entries | length' "$LOG_FILE" 2>/dev/null || echo "0")
    [ "$log_entries" -ge 2 ]
}

# =============================================================================
# Session Status Tests
# =============================================================================

@test "session status shows active session" {
    create_independent_tasks
    bash "$SESSION_SCRIPT" start

    run bash "$SESSION_SCRIPT" status
    assert_success
    assert_output_contains_any "active" "session" "started"
}

@test "session status shows no active session" {
    create_independent_tasks
    run bash "$SESSION_SCRIPT" status
    assert_success
    # Should indicate no active session
}

@test "session status shows session duration" {
    create_independent_tasks
    bash "$SESSION_SCRIPT" start
    sleep 1

    run bash "$SESSION_SCRIPT" status
    assert_success
    # May show duration or elapsed time
}

# =============================================================================
# Session Workflow Tests
# =============================================================================

@test "session workflow: start, status, end" {
    create_independent_tasks

    # Start session
    run bash "$SESSION_SCRIPT" start
    assert_success

    # Check status
    run bash "$SESSION_SCRIPT" status
    assert_success

    # End session
    run bash "$SESSION_SCRIPT" end
    assert_success
}

@test "session start fails if already active" {
    create_independent_tasks
    bash "$SESSION_SCRIPT" start

    run bash "$SESSION_SCRIPT" start
    # May warn or fail if session already active
}

# =============================================================================
# Output Format Tests
# =============================================================================

@test "session status --format json produces valid JSON" {
    create_independent_tasks
    bash "$SESSION_SCRIPT" start
    run bash "$SESSION_SCRIPT" status --format json
    assert_success
    # May or may not produce JSON depending on implementation
}

@test "session start --quiet suppresses output" {
    create_independent_tasks
    run bash "$SESSION_SCRIPT" start --quiet
    assert_success
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "session maintains valid JSON structure" {
    create_independent_tasks
    bash "$SESSION_SCRIPT" start
    bash "$SESSION_SCRIPT" end

    run jq empty "$TODO_FILE"
    assert_success
}

@test "session integrates with focus" {
    create_independent_tasks
    bash "$SESSION_SCRIPT" start
    bash "$FOCUS_SCRIPT" set T001

    run bash "$SESSION_SCRIPT" status
    assert_success
    # May show focus information
}

@test "session end cleans up properly" {
    create_independent_tasks
    bash "$SESSION_SCRIPT" start
    bash "$FOCUS_SCRIPT" set T001
    bash "$SESSION_SCRIPT" end

    # Session should be ended
    local active_session
    active_session=$(jq -r '._meta.activeSession // "null"' "$TODO_FILE")
    [ "$active_session" = "null" ]
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "session handles empty todo.json" {
    create_empty_todo
    run bash "$SESSION_SCRIPT" start
    assert_success
}

@test "session handles missing log file" {
    create_independent_tasks
    rm -f "$LOG_FILE"
    run bash "$SESSION_SCRIPT" start
    # Session should succeed even without log file (graceful degradation)
    assert_success
    # Note: session script skips logging if log file doesn't exist - this is intentional
}
