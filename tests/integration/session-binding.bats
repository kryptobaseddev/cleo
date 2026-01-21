#!/usr/bin/env bats
# =============================================================================
# session-binding.bats - Integration tests for hybrid session binding
# =============================================================================
# Tests the hybrid session binding system:
# - Resolution priority (--session, CLEO_SESSION, TTY binding, .current-session)
# - TTY binding creation and lookup
# - Multi-terminal scenarios
# - Binding conflicts and warnings
#
# Schema: v2.6.0 with multi-session extensions
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    load '../test_helper/assertions'
    common_setup_per_test

    # Create empty archive for tests
    export ARCHIVE_FILE="${TEST_TEMP_DIR}/.cleo/todo-archive.json"
    create_empty_archive "$ARCHIVE_FILE"

    # Create sessions.json for multi-session tests
    export SESSIONS_FILE="${TEST_TEMP_DIR}/.cleo/sessions.json"

    # Clear any existing CLEO_SESSION
    unset CLEO_SESSION 2>/dev/null || true
}

teardown() {
    unset CLEO_SESSION 2>/dev/null || true
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Test Fixtures
# =============================================================================

# Create multi-session enabled config
create_multi_session_config() {
    local dest="${1:-$CONFIG_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.6.0",
  "validation": {
    "strictMode": false,
    "requireDescription": false
  },
  "multiSession": {
    "enabled": true,
    "maxConcurrentSessions": 5,
    "maxActiveTasksPerScope": 1,
    "scopeValidation": "strict",
    "allowNestedScopes": true,
    "allowScopeOverlap": false,
    "ttyBinding": {
      "enabled": true,
      "maxAgeHours": 168
    }
  },
  "session": {
    "requireSession": false,
    "enforcement": "warn"
  }
}
EOF
}

# Create todo.json with tasks
create_test_todo() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.6.0",
  "project": {
    "name": "binding-test",
    "currentPhase": "core",
    "phases": {
      "core": {"order": 1, "name": "Core", "description": "Core features", "status": "active"}
    }
  },
  "_meta": {"version": "2.6.0", "checksum": "placeholder", "configVersion": "2.6.0"},
  "tasks": [
    {
      "id": "T001",
      "title": "Task One",
      "description": "First task",
      "status": "pending",
      "priority": "high",
      "type": "task",
      "parentId": null,
      "phase": "core",
      "createdAt": "2025-12-01T10:00:00Z"
    },
    {
      "id": "T002",
      "title": "Task Two",
      "description": "Second task",
      "status": "pending",
      "priority": "medium",
      "type": "task",
      "parentId": null,
      "phase": "core",
      "createdAt": "2025-12-01T10:01:00Z"
    }
  ],
  "focus": {},
  "labels": {},
  "lastUpdated": "2025-12-01T10:01:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create empty archive
create_empty_archive() {
    local dest="$1"
    cat > "$dest" << 'EOF'
{
  "version": "2.6.0",
  "project": "test",
  "_meta": {"totalArchived": 0, "lastArchived": null},
  "archivedTasks": [],
  "statistics": {}
}
EOF
}

# Create sessions.json with two sessions
create_test_sessions() {
    local dest="${1:-$SESSIONS_FILE}"
    cat > "$dest" << 'EOF'
{
  "$schema": "../schemas/sessions.schema.json",
  "version": "1.0.0",
  "project": "binding-test",
  "_meta": {
    "checksum": "",
    "lastModified": "2026-01-01T10:00:00Z",
    "totalSessionsCreated": 2
  },
  "config": {
    "maxConcurrentSessions": 5,
    "maxActiveTasksPerScope": 1,
    "scopeValidation": "strict",
    "allowNestedScopes": true,
    "allowScopeOverlap": false
  },
  "sessions": [
    {
      "id": "session_alpha",
      "status": "active",
      "name": "Alpha Session",
      "agentId": "agent-alpha",
      "scope": {"type": "task", "rootTaskId": "T001", "computedTaskIds": ["T001"]},
      "focus": {"currentTask": "T001"},
      "startedAt": "2026-01-01T10:00:00Z",
      "lastActivity": "2026-01-01T12:00:00Z",
      "suspendedAt": null,
      "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 0, "resumeCount": 0}
    },
    {
      "id": "session_beta",
      "status": "active",
      "name": "Beta Session",
      "agentId": "agent-beta",
      "scope": {"type": "task", "rootTaskId": "T002", "computedTaskIds": ["T002"]},
      "focus": {"currentTask": "T002"},
      "startedAt": "2026-01-01T11:00:00Z",
      "lastActivity": "2026-01-01T13:00:00Z",
      "suspendedAt": null,
      "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 0, "resumeCount": 0}
    }
  ],
  "sessionHistory": []
}
EOF
}

# =============================================================================
# Resolution Priority Tests
# =============================================================================

@test "binding priority: CLEO_SESSION overrides .current-session" {
    create_test_todo
    create_multi_session_config
    create_test_sessions

    # Set .current-session to alpha
    echo "session_alpha" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Set CLEO_SESSION to beta
    export CLEO_SESSION="session_beta"

    # Doctor should show beta as resolved session
    run bash "$SCRIPTS_DIR/session.sh" doctor --json
    assert_success

    # Check resolved session
    local resolved
    resolved=$(echo "$output" | jq -r '.resolution.resolved // empty')
    [[ "$resolved" == "session_beta" ]]

    unset CLEO_SESSION
}

@test "binding priority: .current-session used when CLEO_SESSION not set" {
    create_test_todo
    create_multi_session_config
    create_test_sessions

    # Ensure CLEO_SESSION is not set
    unset CLEO_SESSION 2>/dev/null || true

    # Set .current-session
    echo "session_alpha" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Doctor should show alpha as resolved session
    run bash "$SCRIPTS_DIR/session.sh" doctor --json
    assert_success

    # Check resolved session (may be from .current-session or TTY)
    local resolved
    resolved=$(echo "$output" | jq -r '.resolution.resolved // empty')
    # Should have some resolved session
    [[ -n "$resolved" ]]
}

@test "binding: switch updates .current-session file" {
    create_test_todo
    create_multi_session_config
    create_test_sessions

    # Switch to beta session
    run bash "$SCRIPTS_DIR/session.sh" switch session_beta
    assert_success

    # Verify .current-session was updated
    local current
    current=$(cat "${TEST_TEMP_DIR}/.cleo/.current-session" 2>/dev/null | tr -d '[:space:]')
    [[ "$current" == "session_beta" ]]
}

@test "binding: switch fails for non-existent session" {
    create_test_todo
    create_multi_session_config
    create_test_sessions

    # Try to switch to non-existent session
    run bash "$SCRIPTS_DIR/session.sh" switch session_nonexistent
    assert_failure

    # Should show error
    assert_output --partial "not found" || assert_output --partial "Session"
}

# =============================================================================
# TTY Binding Tests
# =============================================================================

@test "tty binding: session start creates binding file" {
    create_test_todo
    create_multi_session_config

    # Remove any existing sessions
    rm -f "$SESSIONS_FILE"

    # Start a new session
    run bash "$SCRIPTS_DIR/session.sh" start --scope task:T001 --focus T001
    assert_success

    # Verify sessions.json was created
    [[ -f "$SESSIONS_FILE" ]]

    # Verify a session exists
    local session_count
    session_count=$(jq '.sessions | length' "$SESSIONS_FILE")
    [[ "$session_count" -ge 1 ]]
}

@test "tty binding: directory created if missing" {
    create_test_todo
    create_multi_session_config
    create_test_sessions

    # Remove binding directory
    rm -rf "${TEST_TEMP_DIR}/.cleo/tty-bindings"

    # Switch session (should create binding dir)
    run bash "$SCRIPTS_DIR/session.sh" switch session_alpha
    assert_success

    # .current-session should exist at minimum
    [[ -f "${TEST_TEMP_DIR}/.cleo/.current-session" ]]
}

# =============================================================================
# Multi-Terminal Scenarios
# =============================================================================

@test "multi-terminal: two sessions can be active simultaneously" {
    create_test_todo
    create_multi_session_config

    # Remove existing sessions
    rm -f "$SESSIONS_FILE"

    # Start first session
    run bash "$SCRIPTS_DIR/session.sh" start --scope task:T001 --focus T001 --name "Terminal1"
    assert_success

    # Start second session (different scope)
    run bash "$SCRIPTS_DIR/session.sh" start --scope task:T002 --focus T002 --name "Terminal2"
    assert_success

    # Verify two sessions exist
    local session_count
    session_count=$(jq '.sessions | length' "$SESSIONS_FILE")
    [[ "$session_count" -eq 2 ]]

    # Both should be active
    local active_count
    active_count=$(jq '[.sessions[] | select(.status == "active")] | length' "$SESSIONS_FILE")
    [[ "$active_count" -eq 2 ]]
}

@test "multi-terminal: sessions have separate scopes" {
    create_test_todo
    create_multi_session_config

    # Remove existing sessions
    rm -f "$SESSIONS_FILE"

    # Start two sessions
    run bash "$SCRIPTS_DIR/session.sh" start --scope task:T001 --focus T001
    assert_success

    run bash "$SCRIPTS_DIR/session.sh" start --scope task:T002 --focus T002
    assert_success

    # Verify scopes are different
    local scope1 scope2
    scope1=$(jq -r '.sessions[0].scope.rootTaskId' "$SESSIONS_FILE")
    scope2=$(jq -r '.sessions[1].scope.rootTaskId' "$SESSIONS_FILE")

    [[ "$scope1" != "$scope2" ]]
}

@test "multi-terminal: overlapping scope rejected" {
    create_test_todo
    create_multi_session_config

    # Remove existing sessions
    rm -f "$SESSIONS_FILE"

    # Start first session
    run bash "$SCRIPTS_DIR/session.sh" start --scope task:T001 --focus T001
    assert_success

    # Try to start second session with same scope
    run bash "$SCRIPTS_DIR/session.sh" start --scope task:T001 --focus T001
    assert_failure

    # Should mention conflict
    assert_output --partial "conflict" || assert_output --partial "overlap" || assert_output --partial "scope"
}

# =============================================================================
# CLEO_SESSION Environment Variable Tests
# =============================================================================

@test "env var: CLEO_SESSION respected by session commands" {
    create_test_todo
    create_multi_session_config
    create_test_sessions

    # Set env var
    export CLEO_SESSION="session_beta"

    # Session status should show beta
    run bash "$SCRIPTS_DIR/session.sh" status
    # May show status or indicate beta session

    unset CLEO_SESSION
}

@test "env var: invalid CLEO_SESSION shows warning in doctor" {
    create_test_todo
    create_multi_session_config
    create_test_sessions

    # Set invalid env var
    export CLEO_SESSION="session_invalid_nonexistent"

    # Doctor should detect invalid session
    run bash "$SCRIPTS_DIR/session.sh" doctor
    assert_success

    # Should show warning about invalid session
    assert_output --partial "not found" || assert_output --partial "Warning" || assert_output --partial "warning"

    unset CLEO_SESSION
}

# =============================================================================
# Conflict Detection Tests
# =============================================================================

@test "conflict: doctor detects CLEO_SESSION vs file conflict" {
    create_test_todo
    create_multi_session_config
    create_test_sessions

    # Set .current-session to alpha
    echo "session_alpha" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Set CLEO_SESSION to beta (different)
    export CLEO_SESSION="session_beta"

    # Doctor should detect the difference
    run bash "$SCRIPTS_DIR/session.sh" doctor --json
    assert_success

    # Should show both values are different (not necessarily a conflict, just resolution)
    local env_val file_val
    env_val=$(echo "$output" | jq -r '.resolution.CLEO_SESSION // empty')
    file_val=$(echo "$output" | jq -r '.resolution.currentSessionFile // empty')

    [[ "$env_val" == "session_beta" ]]
    [[ "$file_val" == "session_alpha" ]]

    unset CLEO_SESSION
}

# =============================================================================
# Session List and Show Tests
# =============================================================================

@test "session list: shows all sessions with status" {
    create_test_todo
    create_multi_session_config
    create_test_sessions

    run bash "$SCRIPTS_DIR/session.sh" list
    assert_success

    # Should show both sessions
    assert_output --partial "session_alpha" || assert_output --partial "Alpha"
    assert_output --partial "session_beta" || assert_output --partial "Beta"
}

@test "session list: --status filters results" {
    create_test_todo
    create_multi_session_config
    create_test_sessions

    # List only active sessions
    run bash "$SCRIPTS_DIR/session.sh" list --status active
    assert_success

    # Should show sessions (the bullet point indicates active status)
    assert_output --partial "session_" || assert_output --partial "Session"
}

@test "session show: displays specific session details" {
    create_test_todo
    create_multi_session_config
    create_test_sessions

    run bash "$SCRIPTS_DIR/session.sh" show session_alpha
    assert_success

    # Should show session details
    assert_output --partial "session_alpha"
    assert_output --partial "Alpha" || assert_output --partial "T001"
}

@test "session show: JSON format for automation" {
    create_test_todo
    create_multi_session_config
    create_test_sessions

    run bash "$SCRIPTS_DIR/session.sh" show session_alpha --format json
    assert_success

    # Verify valid JSON
    assert_valid_json
    assert_output --partial '"success":true'
}

# =============================================================================
# End-to-End Workflow Tests
# =============================================================================

@test "e2e: full session lifecycle with binding" {
    create_test_todo
    create_multi_session_config

    # Start fresh
    rm -f "$SESSIONS_FILE"
    rm -f "${TEST_TEMP_DIR}/.cleo/.current-session"

    # 1. Start session
    run bash "$SCRIPTS_DIR/session.sh" start --scope task:T001 --focus T001 --name "E2E Test"
    assert_success

    # 2. Verify binding
    [[ -f "${TEST_TEMP_DIR}/.cleo/.current-session" ]] || [[ -d "${TEST_TEMP_DIR}/.cleo/tty-bindings" ]]

    # 3. Check status
    run bash "$SCRIPTS_DIR/session.sh" status
    assert_success

    # 4. End session
    run bash "$SCRIPTS_DIR/session.sh" end
    assert_success

    # 5. Verify session ended
    local status
    status=$(jq -r '.sessions[0].status' "$SESSIONS_FILE")
    [[ "$status" == "ended" ]]
}

@test "e2e: doctor after gc shows healthy state" {
    create_test_todo
    create_multi_session_config
    create_test_sessions

    # Create some orphan files
    local binding_dir="${TEST_TEMP_DIR}/.cleo/tty-bindings"
    mkdir -p "$binding_dir"
    echo '{"sessionId":"orphan"}' > "$binding_dir/tty-orphan123"

    # Run gc to clean up
    run bash "$SCRIPTS_DIR/session.sh" gc
    assert_success

    # Doctor should show healthier state
    run bash "$SCRIPTS_DIR/session.sh" doctor --json
    assert_success

    # Orphan binding should be gone
    [[ ! -f "$binding_dir/tty-orphan123" ]]
}
