#!/usr/bin/env bats
# =============================================================================
# session-auto-end-stale.bats - Unit tests for session_auto_end_stale()
# =============================================================================
# Tests the automatic ending of stale active sessions based on retention config.
# Function: lib/session/sessions.sh::session_auto_end_stale()
# Task: T2338
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

    # Source the sessions library for direct function access
    source "$LIB_DIR/session/sessions.sh"

    # Create sessions.json file location
    SESSIONS_FILE="${TEST_TEMP_DIR}/.cleo/sessions.json"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper Functions
# =============================================================================

# Create a sessions.json with configurable session data
# Args: $1 - JSON sessions array content
create_sessions_file() {
    local sessions_content="$1"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    cat > "$SESSIONS_FILE" << EOF
{
  "version": "1.0.0",
  "_meta": {
    "version": "1.0.0",
    "lastModified": "$timestamp"
  },
  "sessions": $sessions_content
}
EOF
}

# Create a session entry JSON
# Args: $1=id, $2=status, $3=lastActivity (ISO timestamp)
create_session_entry() {
    local id="$1"
    local status="$2"
    local last_activity="$3"

    cat << EOF
{
  "id": "$id",
  "status": "$status",
  "createdAt": "2025-01-01T10:00:00Z",
  "lastActivity": "$last_activity",
  "scope": {"type": "task", "taskId": "T001"},
  "focus": {}
}
EOF
}

# Get timestamp N days ago in ISO format
get_days_ago_timestamp() {
    local days="$1"
    # Try GNU date first, fall back to BSD date
    date -u -d "$days days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
    date -u -v-${days}d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null
}

# Get timestamp N days from now (for fresh sessions)
get_recent_timestamp() {
    local hours_ago="${1:-1}"
    # Try GNU date first, fall back to BSD date
    date -u -d "$hours_ago hours ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
    date -u -v-${hours_ago}H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null
}

# =============================================================================
# Basic Functionality Tests
# =============================================================================

@test "session_auto_end_stale returns 0 when no sessions file exists" {
    rm -f "$SESSIONS_FILE"

    run session_auto_end_stale
    assert_success
    assert_output "0"
}

@test "session_auto_end_stale returns 0 for empty sessions array" {
    create_sessions_file "[]"

    run session_auto_end_stale
    assert_success
    assert_output "0"
}

# =============================================================================
# Stale Session Detection Tests
# =============================================================================

@test "stale active session (>7 days) gets auto-ended" {
    # Create tasks fixture for session operations
    create_independent_tasks

    local stale_time
    stale_time=$(get_days_ago_timestamp 10)

    local session_json
    session_json=$(create_session_entry "session_stale_001" "active" "$stale_time")

    create_sessions_file "[$session_json]"

    run session_auto_end_stale
    assert_success
    assert_output "1"

    # Verify session status changed to ended
    local status
    status=$(jq -r '.sessions[0].status' "$SESSIONS_FILE")
    [ "$status" = "ended" ]
}

@test "multiple stale sessions get auto-ended" {
    create_independent_tasks

    local stale_time_1 stale_time_2
    stale_time_1=$(get_days_ago_timestamp 10)
    stale_time_2=$(get_days_ago_timestamp 15)

    local session_1 session_2
    session_1=$(create_session_entry "session_stale_001" "active" "$stale_time_1")
    session_2=$(create_session_entry "session_stale_002" "active" "$stale_time_2")

    create_sessions_file "[$session_1, $session_2]"

    run session_auto_end_stale
    assert_success
    assert_output "2"

    # Verify both sessions changed to ended
    local count_ended
    count_ended=$(jq '[.sessions[] | select(.status == "ended")] | length' "$SESSIONS_FILE")
    [ "$count_ended" -eq 2 ]
}

# =============================================================================
# Fresh Session Tests (Should NOT Be Ended)
# =============================================================================

@test "fresh active session (<7 days) is NOT ended" {
    create_independent_tasks

    local fresh_time
    fresh_time=$(get_recent_timestamp 24)  # 24 hours ago

    local session_json
    session_json=$(create_session_entry "session_fresh_001" "active" "$fresh_time")

    create_sessions_file "[$session_json]"

    run session_auto_end_stale
    assert_success
    assert_output "0"

    # Verify session is still active
    local status
    status=$(jq -r '.sessions[0].status' "$SESSIONS_FILE")
    [ "$status" = "active" ]
}

@test "session exactly at 7-day threshold is NOT ended" {
    create_independent_tasks

    # 7 days minus 1 hour should NOT be ended
    local threshold_time
    threshold_time=$(get_days_ago_timestamp 6)

    local session_json
    session_json=$(create_session_entry "session_threshold_001" "active" "$threshold_time")

    create_sessions_file "[$session_json]"

    run session_auto_end_stale
    assert_success
    assert_output "0"

    # Verify session is still active
    local status
    status=$(jq -r '.sessions[0].status' "$SESSIONS_FILE")
    [ "$status" = "active" ]
}

# =============================================================================
# Non-Active Session Tests (Should Be Ignored)
# =============================================================================

@test "ended sessions are ignored regardless of age" {
    create_independent_tasks

    local stale_time
    stale_time=$(get_days_ago_timestamp 30)

    local session_json
    session_json=$(jq -n \
        --arg id "session_ended_001" \
        --arg ts "$stale_time" \
        '{
            id: $id,
            status: "ended",
            createdAt: "2025-01-01T10:00:00Z",
            lastActivity: $ts,
            scope: {type: "task", taskId: "T001"},
            focus: {}
        }')

    create_sessions_file "[$session_json]"

    run session_auto_end_stale
    assert_success
    assert_output "0"

    # Verify session status unchanged
    local status
    status=$(jq -r '.sessions[0].status' "$SESSIONS_FILE")
    [ "$status" = "ended" ]
}

@test "suspended sessions are ignored regardless of age" {
    create_independent_tasks

    local stale_time
    stale_time=$(get_days_ago_timestamp 30)

    local session_json
    session_json=$(jq -n \
        --arg id "session_suspended_001" \
        --arg ts "$stale_time" \
        '{
            id: $id,
            status: "suspended",
            createdAt: "2025-01-01T10:00:00Z",
            lastActivity: $ts,
            scope: {type: "task", taskId: "T001"},
            focus: {}
        }')

    create_sessions_file "[$session_json]"

    run session_auto_end_stale
    assert_success
    assert_output "0"

    # Verify session status unchanged
    local status
    status=$(jq -r '.sessions[0].status' "$SESSIONS_FILE")
    [ "$status" = "suspended" ]
}

@test "closed sessions are ignored regardless of age" {
    create_independent_tasks

    local stale_time
    stale_time=$(get_days_ago_timestamp 60)

    local session_json
    session_json=$(jq -n \
        --arg id "session_closed_001" \
        --arg ts "$stale_time" \
        '{
            id: $id,
            status: "closed",
            createdAt: "2025-01-01T10:00:00Z",
            lastActivity: $ts,
            scope: {type: "task", taskId: "T001"},
            focus: {}
        }')

    create_sessions_file "[$session_json]"

    run session_auto_end_stale
    assert_success
    assert_output "0"
}

# =============================================================================
# Mixed Session Tests
# =============================================================================

@test "only stale active sessions are ended in mixed set" {
    create_independent_tasks

    local stale_time fresh_time
    stale_time=$(get_days_ago_timestamp 10)
    fresh_time=$(get_recent_timestamp 12)

    # Create mix: 1 stale active, 1 fresh active, 1 stale ended, 1 stale suspended
    local sessions_json
    sessions_json=$(jq -n \
        --arg stale "$stale_time" \
        --arg fresh "$fresh_time" \
        '[
            {id: "session_stale_active", status: "active", createdAt: "2025-01-01T10:00:00Z", lastActivity: $stale, scope: {type: "task", taskId: "T001"}, focus: {}},
            {id: "session_fresh_active", status: "active", createdAt: "2025-01-01T10:00:00Z", lastActivity: $fresh, scope: {type: "task", taskId: "T002"}, focus: {}},
            {id: "session_stale_ended", status: "ended", createdAt: "2025-01-01T10:00:00Z", lastActivity: $stale, scope: {type: "task", taskId: "T003"}, focus: {}},
            {id: "session_stale_suspended", status: "suspended", createdAt: "2025-01-01T10:00:00Z", lastActivity: $stale, scope: {type: "task", taskId: "T004"}, focus: {}}
        ]')

    create_sessions_file "$sessions_json"

    run session_auto_end_stale
    assert_success
    assert_output "1"

    # Verify only stale active was ended
    local stale_active_status fresh_active_status ended_status suspended_status
    stale_active_status=$(jq -r '.sessions[] | select(.id == "session_stale_active") | .status' "$SESSIONS_FILE")
    fresh_active_status=$(jq -r '.sessions[] | select(.id == "session_fresh_active") | .status' "$SESSIONS_FILE")
    ended_status=$(jq -r '.sessions[] | select(.id == "session_stale_ended") | .status' "$SESSIONS_FILE")
    suspended_status=$(jq -r '.sessions[] | select(.id == "session_stale_suspended") | .status' "$SESSIONS_FILE")

    [ "$stale_active_status" = "ended" ]
    [ "$fresh_active_status" = "active" ]
    [ "$ended_status" = "ended" ]
    [ "$suspended_status" = "suspended" ]
}

# =============================================================================
# Configuration Tests
# =============================================================================

@test "respects custom retention.autoEndActiveAfterDays config" {
    create_independent_tasks

    # Set custom retention to 3 days
    jq '.retention = {"autoEndActiveAfterDays": 3}' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && \
        mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Create session 5 days old (should be ended with 3-day config)
    local stale_time
    stale_time=$(get_days_ago_timestamp 5)

    local session_json
    session_json=$(create_session_entry "session_custom_001" "active" "$stale_time")

    create_sessions_file "[$session_json]"

    run session_auto_end_stale
    assert_success
    assert_output "1"

    # Verify session was ended
    local status
    status=$(jq -r '.sessions[0].status' "$SESSIONS_FILE")
    [ "$status" = "ended" ]
}

@test "session just under custom threshold is NOT ended" {
    create_independent_tasks

    # Set custom retention to 10 days
    jq '.retention = {"autoEndActiveAfterDays": 10}' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && \
        mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Create session 8 days old (should NOT be ended with 10-day config)
    local stale_time
    stale_time=$(get_days_ago_timestamp 8)

    local session_json
    session_json=$(create_session_entry "session_under_threshold" "active" "$stale_time")

    create_sessions_file "[$session_json]"

    run session_auto_end_stale
    assert_success
    assert_output "0"

    # Verify session is still active
    local status
    status=$(jq -r '.sessions[0].status' "$SESSIONS_FILE")
    [ "$status" = "active" ]
}

# =============================================================================
# Dry Run Tests
# =============================================================================

@test "dry run mode reports but does not end sessions" {
    create_independent_tasks

    local stale_time
    stale_time=$(get_days_ago_timestamp 10)

    local session_json
    session_json=$(create_session_entry "session_dryrun_001" "active" "$stale_time")

    create_sessions_file "[$session_json]"

    run session_auto_end_stale "true"
    assert_success
    assert_output --partial "Would auto-end session"
    assert_output --partial "session_dryrun_001"

    # Verify session status unchanged
    local status
    status=$(jq -r '.sessions[0].status' "$SESSIONS_FILE")
    [ "$status" = "active" ]
}

@test "dry run returns correct count of would-be-ended sessions" {
    create_independent_tasks

    local stale_time
    stale_time=$(get_days_ago_timestamp 10)

    local session_1 session_2 session_3
    session_1=$(create_session_entry "session_dr_001" "active" "$stale_time")
    session_2=$(create_session_entry "session_dr_002" "active" "$stale_time")
    session_3=$(create_session_entry "session_dr_003" "active" "$stale_time")

    create_sessions_file "[$session_1, $session_2, $session_3]"

    # Capture full output including dry run messages
    run session_auto_end_stale "true"
    assert_success

    # The last line should be the count
    local last_line
    last_line=$(echo "$output" | tail -1)
    [ "$last_line" = "3" ]
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "handles session with missing lastActivity field - treats as stale" {
    create_independent_tasks

    # Session without lastActivity field - should be treated as stale
    # In jq, null < "timestamp" evaluates to true, so missing lastActivity = stale
    local session_json
    session_json='{"id": "session_no_activity", "status": "active", "createdAt": "2025-01-01T10:00:00Z", "scope": {"type": "task", "taskId": "T001"}, "focus": {}}'

    create_sessions_file "[$session_json]"

    run session_auto_end_stale
    assert_success
    # Session without lastActivity is treated as infinitely old (null < any_timestamp = true in jq)
    assert_output "1"

    # Verify session was ended
    local status
    status=$(jq -r '.sessions[0].status' "$SESSIONS_FILE")
    [ "$status" = "ended" ]
}

@test "handles malformed lastActivity timestamp gracefully" {
    create_independent_tasks

    # Session with invalid timestamp
    local session_json
    session_json='{"id": "session_bad_ts", "status": "active", "createdAt": "2025-01-01T10:00:00Z", "lastActivity": "not-a-timestamp", "scope": {"type": "task", "taskId": "T001"}, "focus": {}}'

    create_sessions_file "[$session_json]"

    run session_auto_end_stale
    assert_success
    # Invalid timestamps should not cause crashes
    assert_output "0"
}

@test "handles empty sessions object gracefully" {
    cat > "$SESSIONS_FILE" << 'EOF'
{
  "version": "1.0.0",
  "_meta": {"version": "1.0.0"},
  "sessions": []
}
EOF

    run session_auto_end_stale
    assert_success
    assert_output "0"
}
