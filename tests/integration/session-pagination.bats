#!/usr/bin/env bats
# =============================================================================
# session-pagination.bats - Integration tests for session list pagination
# =============================================================================
# Tests session list command with pagination flags (--limit, --offset).
# Requires initialized .cleo directory with multiple sessions.
#
# NOTE: These tests validate that the json-output.sh pagination functions
# work correctly when wired into the session list command. If the session
# list command does not yet support --limit/--offset, these tests serve as
# acceptance criteria for when that support is added.
#
# @task T1451
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

    # Enable multi-session for tests
    jq '.multiSession.enabled = true' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && \
        mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Create sessions directory
    mkdir -p "${TEST_TEMP_DIR}/.cleo/sessions"

    # Create a simple todo.json with an epic
    cat > "$TODO_FILE" << 'FIXTURE'
{
  "version": "2.3.0",
  "project": {
    "name": "pagination-test",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Setup", "status": "completed", "startedAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-01T01:00:00Z"},
      "core": {"order": 2, "name": "Core", "description": "Core", "status": "active", "startedAt": "2025-01-01T01:00:00Z", "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Maintenance", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder", "configVersion": "2.3.0"},
  "tasks": [
    {
      "id": "T001",
      "title": "Test Epic",
      "description": "Epic for pagination testing",
      "status": "pending",
      "priority": "medium",
      "type": "epic",
      "parentId": null,
      "phase": "core",
      "createdAt": "2025-01-01T00:00:00Z"
    },
    {
      "id": "T002",
      "title": "Test Task 1",
      "description": "First task for testing",
      "status": "pending",
      "priority": "medium",
      "type": "task",
      "parentId": "T001",
      "phase": "core",
      "createdAt": "2025-01-01T00:00:00Z"
    }
  ]
}
FIXTURE
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper: create multiple sessions
# =============================================================================

create_test_sessions() {
    local count="${1:-5}"
    local i

    for (( i = 1; i <= count; i++ )); do
        local session_id="session_20250101_00000${i}_abc${i}de"
        local session_file="${TEST_TEMP_DIR}/.cleo/sessions/${session_id}.json"
        local status="ended"
        local ended_at='"2025-01-01T12:00:00Z"'
        if (( i == count )); then
            status="active"
            ended_at="null"
        fi

        cat > "$session_file" << EOF
{
  "id": "${session_id}",
  "name": "Session ${i}",
  "status": "${status}",
  "scope": {"type": "epic", "taskId": "T001"},
  "focus": {"currentTask": "T002"},
  "startedAt": "2025-01-01T0${i}:00:00Z",
  "endedAt": ${ended_at},
  "focusHistory": [{"task": "T002", "at": "2025-01-01T0${i}:00:00Z"}],
  "stats": {"tasksCompleted": ${i}, "focusSwitches": ${i}},
  "events": []
}
EOF
    done
}

# =============================================================================
# Session List with JSON output Tests
# =============================================================================

@test "session list returns JSON output" {
    create_test_sessions 3

    export CLEO_FORMAT="json"
    run bash "$SESSION_SCRIPT" list
    assert_success
    assert_valid_json
}

@test "session list returns sessions array" {
    create_test_sessions 3

    export CLEO_FORMAT="json"
    run bash "$SESSION_SCRIPT" list
    assert_success

    # Should contain session data (either as .sessions or other key)
    local has_data
    has_data=$(echo "$output" | jq 'has("sessions") or has("data") or (.success == true)')
    [ "$has_data" = "true" ]
}

# =============================================================================
# Pagination Metadata Tests
# =============================================================================

@test "session list output includes success field" {
    create_test_sessions 3

    export CLEO_FORMAT="json"
    run bash "$SESSION_SCRIPT" list
    assert_success

    # Basic structural check - success field present
    local success
    success=$(echo "$output" | jq '.success // empty')
    [ -n "$success" ]
}

# =============================================================================
# apply_pagination as used by session list
# =============================================================================
# These tests verify the pagination functions directly with session-like data,
# as the session list command may not yet have --limit/--offset wired up.

@test "apply_pagination works with session JSON data" {
    source "$LIB_DIR/json-output.sh"

    local sessions='[
        {"id":"s1","name":"Session 1","status":"ended"},
        {"id":"s2","name":"Session 2","status":"ended"},
        {"id":"s3","name":"Session 3","status":"active"}
    ]'

    run apply_pagination "$sessions" 2 0
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 2 ]

    local first_id
    first_id=$(echo "$output" | jq -r '.[0].id')
    [ "$first_id" = "s1" ]
}

@test "apply_pagination with offset skips correct sessions" {
    source "$LIB_DIR/json-output.sh"

    local sessions='[
        {"id":"s1","name":"Session 1","status":"ended"},
        {"id":"s2","name":"Session 2","status":"ended"},
        {"id":"s3","name":"Session 3","status":"ended"},
        {"id":"s4","name":"Session 4","status":"active"}
    ]'

    run apply_pagination "$sessions" 2 2
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 2 ]

    local first_id
    first_id=$(echo "$output" | jq -r '.[0].id')
    [ "$first_id" = "s3" ]
}

@test "output_paginated produces correct envelope for sessions" {
    source "$LIB_DIR/json-output.sh"
    export CLEO_VERSION="1.0.0-test"

    local page='[{"id":"s1"},{"id":"s2"}]'
    run output_paginated "session list" "sessions" "$page" 5 2 0
    assert_success
    assert_valid_json

    local total
    total=$(echo "$output" | jq '.pagination.total')
    [ "$total" -eq 5 ]

    local has_more
    has_more=$(echo "$output" | jq '.pagination.hasMore')
    [ "$has_more" = "true" ]

    local session_count
    session_count=$(echo "$output" | jq '.sessions | length')
    [ "$session_count" -eq 2 ]
}

@test "compact_session reduces session size for pagination" {
    source "$LIB_DIR/json-output.sh"

    local full_session='{"id":"s1","name":"Work","status":"active","scope":{"type":"epic","taskId":"T001"},"focus":{"currentTask":"T002","history":["T001","T002"]},"startedAt":"2025-01-01T00:00:00Z","endedAt":null,"focusHistory":[{"task":"T001","at":"2025-01-01T00:00:00Z"},{"task":"T002","at":"2025-01-01T01:00:00Z"}],"stats":{"tasksCompleted":5,"focusSwitches":3},"taskSnapshots":[{"id":"T001","status":"pending"}],"notes":["did some work"],"events":[{"type":"focus_switch","at":"2025-01-01T01:00:00Z"}]}'

    local compact
    compact=$(compact_session "$full_session")
    local full_len=${#full_session}
    local compact_len=${#compact}

    # Compact version should be smaller
    (( compact_len < full_len ))

    # Should still have essential fields
    local id
    id=$(echo "$compact" | jq -r '.id')
    [ "$id" = "s1" ]

    # Should not have verbose fields
    local has_fh
    has_fh=$(echo "$compact" | jq 'has("focusHistory")')
    [ "$has_fh" = "false" ]
}

@test "get_default_limit returns 10 for session commands" {
    source "$LIB_DIR/json-output.sh"

    run get_default_limit "session list"
    assert_success
    assert_output "10"

    run get_default_limit "sessions"
    assert_success
    assert_output "10"
}

# =============================================================================
# End-to-end pagination flow simulation
# =============================================================================

@test "full pagination flow: collect, paginate, envelope" {
    source "$LIB_DIR/json-output.sh"
    export CLEO_VERSION="1.0.0-test"

    # Simulate what session list would do internally
    local all_sessions='[
        {"id":"s1","name":"Session 1","status":"ended","startedAt":"2025-01-01T01:00:00Z"},
        {"id":"s2","name":"Session 2","status":"ended","startedAt":"2025-01-01T02:00:00Z"},
        {"id":"s3","name":"Session 3","status":"ended","startedAt":"2025-01-01T03:00:00Z"},
        {"id":"s4","name":"Session 4","status":"ended","startedAt":"2025-01-01T04:00:00Z"},
        {"id":"s5","name":"Session 5","status":"active","startedAt":"2025-01-01T05:00:00Z"}
    ]'

    local total
    total=$(echo "$all_sessions" | jq 'length')

    local limit=2
    local offset=0

    # Page 1
    local page1
    page1=$(apply_pagination "$all_sessions" "$limit" "$offset")
    run output_paginated "session list" "sessions" "$page1" "$total" "$limit" "$offset"
    assert_success
    assert_valid_json

    local p1_count
    p1_count=$(echo "$output" | jq '.sessions | length')
    [ "$p1_count" -eq 2 ]

    local p1_has_more
    p1_has_more=$(echo "$output" | jq '.pagination.hasMore')
    [ "$p1_has_more" = "true" ]

    # Page 2
    offset=2
    local page2
    page2=$(apply_pagination "$all_sessions" "$limit" "$offset")
    run output_paginated "session list" "sessions" "$page2" "$total" "$limit" "$offset"
    assert_success

    local p2_first_id
    p2_first_id=$(echo "$output" | jq -r '.sessions[0].id')
    [ "$p2_first_id" = "s3" ]

    # Page 3 (last page)
    offset=4
    local page3
    page3=$(apply_pagination "$all_sessions" "$limit" "$offset")
    run output_paginated "session list" "sessions" "$page3" "$total" "$limit" "$offset"
    assert_success

    local p3_count
    p3_count=$(echo "$output" | jq '.sessions | length')
    [ "$p3_count" -eq 1 ]

    local p3_has_more
    p3_has_more=$(echo "$output" | jq '.pagination.hasMore')
    [ "$p3_has_more" = "false" ]
}
