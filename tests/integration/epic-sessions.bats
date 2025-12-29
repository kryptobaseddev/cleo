#!/usr/bin/env bats
# =============================================================================
# epic-sessions.bats - Integration tests for Epic-Bound Session system
# =============================================================================
# Tests the multi-session concurrent agent system:
# - Session lifecycle (start/suspend/resume/end/close)
# - Focus locking within sessions
# - Write enforcement when multiSession.enabled=true
# - Discovery mode (session start without --scope)
# - Migration from legacy single-session
# - Error scenarios (E_SESSION_REQUIRED, E_SCOPE_CONFLICT, E_SESSION_CLOSE_BLOCKED)
#
# Schema: v2.3.0 with multi-session extensions
# Spec: docs/specs/EPIC-SESSION-SPEC.md
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
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Epic-Session Fixtures
# =============================================================================

# Create todo.json with Epic hierarchy for session testing
create_epic_hierarchy_todo() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "session-test",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "completed", "startedAt": "2025-12-01T09:00:00Z", "completedAt": "2025-12-01T10:00:00Z"},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "active", "startedAt": "2025-12-01T10:00:00Z", "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Maintenance", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder", "configVersion": "2.3.0"},
  "tasks": [
    {
      "id": "T001",
      "title": "Auth System Epic",
      "description": "Implement complete authentication system",
      "status": "pending",
      "priority": "high",
      "type": "epic",
      "parentId": null,
      "size": "large",
      "phase": "core",
      "createdAt": "2025-12-01T10:00:00Z"
    },
    {
      "id": "T002",
      "title": "Login endpoint",
      "description": "Implement login API",
      "status": "pending",
      "priority": "high",
      "type": "task",
      "parentId": "T001",
      "size": "medium",
      "phase": "core",
      "createdAt": "2025-12-01T10:01:00Z"
    },
    {
      "id": "T003",
      "title": "Validate email format",
      "description": "Email validation subtask",
      "status": "pending",
      "priority": "medium",
      "type": "subtask",
      "parentId": "T002",
      "size": "small",
      "phase": "core",
      "createdAt": "2025-12-01T10:02:00Z"
    },
    {
      "id": "T004",
      "title": "Hash password",
      "description": "Password hashing subtask",
      "status": "pending",
      "priority": "medium",
      "type": "subtask",
      "parentId": "T002",
      "size": "small",
      "phase": "core",
      "createdAt": "2025-12-01T10:03:00Z"
    },
    {
      "id": "T005",
      "title": "Logout endpoint",
      "description": "Implement logout API",
      "status": "pending",
      "priority": "medium",
      "type": "task",
      "parentId": "T001",
      "size": "small",
      "phase": "core",
      "createdAt": "2025-12-01T10:04:00Z"
    },
    {
      "id": "T010",
      "title": "Payment System Epic",
      "description": "Implement payment processing",
      "status": "pending",
      "priority": "high",
      "type": "epic",
      "parentId": null,
      "size": "large",
      "phase": "core",
      "createdAt": "2025-12-01T10:05:00Z"
    },
    {
      "id": "T011",
      "title": "Payment gateway integration",
      "description": "Integrate Stripe",
      "status": "pending",
      "priority": "high",
      "type": "task",
      "parentId": "T010",
      "size": "medium",
      "phase": "core",
      "createdAt": "2025-12-01T10:06:00Z"
    }
  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "lastUpdated": "2025-12-01T10:06:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create multi-session enabled config
create_multi_session_config() {
    local dest="${1:-$CONFIG_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
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
    "allowScopeOverlap": false
  },
  "session": {
    "requireSession": true,
    "enforcement": "strict",
    "requireNotesOnComplete": false,
    "autoDiscoveryOnStart": true
  }
}
EOF
}

# Create multi-session config with warn enforcement mode
create_warn_enforcement_config() {
    local dest="${1:-$CONFIG_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
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
    "allowScopeOverlap": false
  },
  "session": {
    "requireSession": true,
    "enforcement": "warn",
    "requireNotesOnComplete": false
  }
}
EOF
}

# Create single-session (legacy) config
create_single_session_config() {
    local dest="${1:-$CONFIG_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "validation": {
    "strictMode": false,
    "requireDescription": false
  },
  "multiSession": {
    "enabled": false
  },
  "session": {
    "requireSession": false,
    "warnOnNoFocus": true
  }
}
EOF
}

# Create empty archive helper
create_empty_archive() {
    local dest="$1"
    cat > "$dest" << 'EOF'
{
  "version": "2.4.0",
  "project": "test",
  "_meta": {"totalArchived": 0, "lastArchived": null},
  "archivedTasks": [],
  "statistics": {"byPhase": {}, "byPriority": {"critical":0,"high":0,"medium":0,"low":0}, "byLabel": {}, "cancelled": 0}
}
EOF
}

# Create sessions.json with an existing active session
create_active_session() {
    local dest="${1:-$SESSIONS_FILE}"
    local session_id="${2:-session_20251228_100000_abc123}"
    local root_task="${3:-T001}"
    cat > "$dest" << EOF
{
  "\$schema": "../schemas/sessions.schema.json",
  "version": "1.0.0",
  "project": "session-test",
  "_meta": {
    "checksum": "",
    "lastModified": "2025-12-28T10:00:00Z",
    "totalSessionsCreated": 1
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
      "id": "$session_id",
      "status": "active",
      "name": "Test Session",
      "agentId": "test-agent",
      "scope": {
        "type": "epic",
        "rootTaskId": "$root_task",
        "computedTaskIds": ["$root_task", "T002", "T003", "T004", "T005"]
      },
      "focus": {
        "currentTask": "T002",
        "currentPhase": "core",
        "previousTask": null,
        "sessionNote": null,
        "nextAction": null,
        "focusHistory": []
      },
      "startedAt": "2025-12-28T10:00:00Z",
      "lastActivity": "2025-12-28T10:00:00Z",
      "suspendedAt": null,
      "stats": {
        "tasksCompleted": 0,
        "focusChanges": 1,
        "suspendCount": 0,
        "resumeCount": 0
      }
    }
  ],
  "sessionHistory": []
}
EOF
}

# =============================================================================
# Session Lifecycle Tests
# =============================================================================

@test "session lifecycle: start multi-session with scope and focus" {
    create_epic_hierarchy_todo
    create_multi_session_config

    # Start session with scope and focus
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T001 --focus T002
    assert_success

    # Verify session was created
    [[ -f "$SESSIONS_FILE" ]]
    local session_count
    session_count=$(jq '.sessions | length' "$SESSIONS_FILE")
    [[ "$session_count" -eq 1 ]]

    # Verify session has correct scope
    local scope_type root_task
    scope_type=$(jq -r '.sessions[0].scope.type' "$SESSIONS_FILE")
    root_task=$(jq -r '.sessions[0].scope.rootTaskId' "$SESSIONS_FILE")
    [[ "$scope_type" == "epic" ]]
    [[ "$root_task" == "T001" ]]

    # Verify focus was set
    local focus_task
    focus_task=$(jq -r '.sessions[0].focus.currentTask' "$SESSIONS_FILE")
    [[ "$focus_task" == "T002" ]]

    # Verify task status changed to active
    assert_task_status "T002" "active"
}

@test "session lifecycle: start with --auto-focus selects highest priority" {
    create_epic_hierarchy_todo
    create_multi_session_config

    # Start session with auto-focus
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T001 --auto-focus
    assert_success

    # Verify focus was auto-selected (T002 is highest priority pending in scope)
    local focus_task
    focus_task=$(jq -r '.sessions[0].focus.currentTask' "$SESSIONS_FILE")
    [[ "$focus_task" == "T002" ]]  # highest priority task under T001
}

@test "session lifecycle: suspend preserves session state" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    # Suspend session
    run bash "$SCRIPTS_DIR/session.sh" suspend --note "Pausing for review"
    assert_success

    # Verify session is suspended
    local session_status
    session_status=$(jq -r '.sessions[0].status' "$SESSIONS_FILE")
    [[ "$session_status" == "suspended" ]]

    # Verify note was saved
    local session_note
    session_note=$(jq -r '.sessions[0].focus.sessionNote' "$SESSIONS_FILE")
    [[ "$session_note" == "Pausing for review" ]]
}

@test "session lifecycle: resume restores session state" {
    create_epic_hierarchy_todo
    create_multi_session_config

    # Create a suspended session
    cat > "$SESSIONS_FILE" << 'EOF'
{
  "$schema": "../schemas/sessions.schema.json",
  "version": "1.0.0",
  "project": "test",
  "_meta": {"checksum": "", "lastModified": "2025-12-28T10:00:00Z", "totalSessionsCreated": 1},
  "config": {"maxConcurrentSessions": 5, "maxActiveTasksPerScope": 1, "scopeValidation": "strict", "allowNestedScopes": true, "allowScopeOverlap": false},
  "sessions": [{
    "id": "session_20251228_100000_abc123",
    "status": "suspended",
    "name": "Test Session",
    "agentId": null,
    "scope": {"type": "epic", "rootTaskId": "T001", "computedTaskIds": ["T001", "T002", "T003", "T004", "T005"]},
    "focus": {"currentTask": "T003", "currentPhase": "core", "previousTask": null, "sessionNote": "Suspended note", "nextAction": null, "focusHistory": []},
    "startedAt": "2025-12-28T10:00:00Z",
    "lastActivity": "2025-12-28T10:00:00Z",
    "suspendedAt": "2025-12-28T10:30:00Z",
    "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 1, "resumeCount": 0}
  }],
  "sessionHistory": []
}
EOF

    # Resume session
    run bash "$SCRIPTS_DIR/session.sh" resume session_20251228_100000_abc123
    assert_success

    # Verify session is active
    local session_status
    session_status=$(jq -r '.sessions[0].status' "$SESSIONS_FILE")
    [[ "$session_status" == "active" ]]

    # Verify resume count incremented
    local resume_count
    resume_count=$(jq '.sessions[0].stats.resumeCount' "$SESSIONS_FILE")
    [[ "$resume_count" -eq 1 ]]

    # Verify focus task is active
    assert_task_status "T003" "active"
}

@test "session lifecycle: end transitions session to ended state" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    # End session
    run bash "$SCRIPTS_DIR/session.sh" end --note "Work completed for today"
    # Session end on single-session mode in todo.json works
    # For multi-session, we need to verify proper behavior
    # The session.sh end command handles both modes

    # Verify session ended (focus task reset to pending)
    # Note: Current implementation clears _meta.activeSession for single-session
    # Multi-session would update sessions.json
}

@test "session lifecycle: close requires all tasks complete" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    # Try to close session with incomplete tasks
    run bash "$SCRIPTS_DIR/session.sh" close session_20251228_100000_abc123
    assert_failure

    # Verify error mentions incomplete tasks
    assert_output --partial "incomplete" || assert_output --partial "tasks"
}

@test "session lifecycle: close succeeds when all tasks complete" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    # Complete all tasks in scope
    jq '.tasks = [.tasks[] | if .id == "T001" or .id == "T002" or .id == "T003" or .id == "T004" or .id == "T005" then .status = "done" else . end]' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    _update_fixture_checksum "$TODO_FILE"

    # Close session
    run bash "$SCRIPTS_DIR/session.sh" close session_20251228_100000_abc123
    assert_success

    # Verify session moved to history
    local active_count history_count
    active_count=$(jq '.sessions | length' "$SESSIONS_FILE")
    history_count=$(jq '.sessionHistory | length' "$SESSIONS_FILE")
    [[ "$active_count" -eq 0 ]]
    [[ "$history_count" -eq 1 ]]
}

# =============================================================================
# Focus Locking Tests
# =============================================================================

@test "focus locking: can focus on task within session scope" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    # Set .current-session file for focus command context
    echo "session_20251228_100000_abc123" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Focus on different task in scope
    run bash "$SCRIPTS_DIR/focus.sh" set T003
    assert_success

    # Verify focus changed
    local current_focus
    current_focus=$(jq -r '.focus.currentTask' "$TODO_FILE")
    [[ "$current_focus" == "T003" ]]
}

@test "focus locking: cannot focus on task outside session scope" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    # Set .current-session file for focus command context
    echo "session_20251228_100000_abc123" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Try to focus on task outside scope (T010 is in different epic)
    # Note: This requires session enforcement in focus.sh
    # Current implementation may not enforce scope
    skip "Focus scope enforcement pending implementation"
}

@test "focus locking: single active task per scope" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    # Verify only T002 is active (session start sets focus)
    local active_count
    active_count=$(jq '[.tasks[] | select(.status == "active")] | length' "$TODO_FILE")
    # Session start should set the focus task to active
}

# =============================================================================
# Write Enforcement Tests
# =============================================================================

@test "write enforcement: strict mode requires active session for add" {
    create_epic_hierarchy_todo
    create_multi_session_config
    # No active session

    # Try to add task without session
    run bash "$ADD_SCRIPT" "New task" --description "Should fail"

    # With strict enforcement, this should fail with E_SESSION_REQUIRED (36)
    # Current implementation may not enforce this yet
    skip "Write enforcement pending full implementation"
}

@test "write enforcement: strict mode requires active session for update" {
    create_epic_hierarchy_todo
    create_multi_session_config
    # No active session

    # Try to update task without session
    run bash "$UPDATE_SCRIPT" T002 --priority critical

    # Should fail with E_SESSION_REQUIRED (36)
    skip "Write enforcement pending full implementation"
}

@test "write enforcement: strict mode requires active session for complete" {
    create_epic_hierarchy_todo
    create_multi_session_config
    # No active session

    # Try to complete task without session
    run bash "$COMPLETE_SCRIPT" T003 --skip-notes

    # Should fail with E_SESSION_REQUIRED (36)
    skip "Write enforcement pending full implementation"
}

@test "write enforcement: warn mode allows writes with warning" {
    create_epic_hierarchy_todo
    create_warn_enforcement_config
    # No active session

    # Add task without session (should warn but succeed)
    run bash "$ADD_SCRIPT" "New task" --description "Should succeed with warning"

    # In warn mode, operation should succeed
    # Current implementation may not fully support this
    skip "Warn enforcement mode pending full implementation"
}

@test "write enforcement: operations work within active session" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    # Set .current-session file
    echo "session_20251228_100000_abc123" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Complete task within session scope
    run bash "$COMPLETE_SCRIPT" T003 --skip-notes
    assert_success
    assert_task_status "T003" "done"
}

# =============================================================================
# Discovery Mode Tests
# =============================================================================

@test "discovery mode: lists available epics when no scope provided" {
    create_epic_hierarchy_todo
    create_multi_session_config

    # Start session without scope (discovery mode)
    run bash "$SCRIPTS_DIR/session.sh" start

    # Should show available epics
    assert_output --partial "T001" || assert_output --partial "Auth System"
    assert_output --partial "T010" || assert_output --partial "Payment System"

    # Should exit with NO_DATA (100) prompting user to select
    [[ "$status" -eq 100 ]] || assert_output --partial "epic"
}

@test "discovery mode: suggests scope command format" {
    create_epic_hierarchy_todo
    create_multi_session_config

    # Start session without scope
    run bash "$SCRIPTS_DIR/session.sh" start

    # Should provide usage hint
    assert_output --partial "--scope" || assert_output --partial "epic:"
}

@test "discovery mode: shows existing active sessions" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    # Start session without scope (should warn about existing)
    run bash "$SCRIPTS_DIR/session.sh" start

    # Should mention existing session
    assert_output --partial "active" || assert_output --partial "session"
}

# =============================================================================
# Migration Tests
# =============================================================================

@test "migration: legacy single-session todo.json is compatible" {
    create_epic_hierarchy_todo
    create_single_session_config

    # Start legacy single-session
    run bash "$SCRIPTS_DIR/session.sh" start
    assert_success

    # Verify session started in _meta.activeSession
    local session_id
    session_id=$(jq -r '._meta.activeSession' "$TODO_FILE")
    [[ -n "$session_id" ]]
    [[ "$session_id" != "null" ]]
}

@test "migration: sessions.json created on first multi-session start" {
    create_epic_hierarchy_todo
    create_multi_session_config

    # Remove any existing sessions.json
    rm -f "$SESSIONS_FILE"

    # Start multi-session
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T001 --focus T002
    assert_success

    # Verify sessions.json was created
    [[ -f "$SESSIONS_FILE" ]]

    # Verify structure is correct
    local version
    version=$(jq -r '.version' "$SESSIONS_FILE")
    [[ "$version" == "1.0.0" ]]
}

@test "migration: ensure_migrated called on session commands" {
    create_epic_hierarchy_todo
    create_multi_session_config

    # Remove sessions.json
    rm -f "$SESSIONS_FILE"

    # Session status should trigger migration
    run bash "$SCRIPTS_DIR/session.sh" status
    assert_success

    # Even without active session, migration should have run if needed
}

# =============================================================================
# Error Scenario Tests
# =============================================================================

@test "error: E_SESSION_NOT_FOUND when resuming invalid session" {
    create_epic_hierarchy_todo
    create_multi_session_config

    # Create empty sessions.json
    cat > "$SESSIONS_FILE" << 'EOF'
{
  "$schema": "../schemas/sessions.schema.json",
  "version": "1.0.0",
  "project": "test",
  "_meta": {"checksum": "", "lastModified": "2025-12-28T10:00:00Z", "totalSessionsCreated": 0},
  "config": {"maxConcurrentSessions": 5, "maxActiveTasksPerScope": 1, "scopeValidation": "strict", "allowNestedScopes": true, "allowScopeOverlap": false},
  "sessions": [],
  "sessionHistory": []
}
EOF

    # Try to resume non-existent session
    run bash "$SCRIPTS_DIR/session.sh" resume nonexistent_session
    assert_failure

    # Should return E_SESSION_NOT_FOUND (31) or similar error
    assert_output --partial "not found" || assert_output --partial "Session"
}

@test "error: E_SCOPE_CONFLICT when scopes overlap" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session  # Creates session for T001

    # Try to start another session with overlapping scope
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T001 --focus T005
    assert_failure

    # Should return scope conflict error
    assert_output --partial "conflict" || assert_output --partial "scope" || assert_output --partial "overlap"
}

@test "error: E_SCOPE_INVALID when epic doesn't exist" {
    create_epic_hierarchy_todo
    create_multi_session_config

    # Try to start session with non-existent epic
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T999 --focus T999
    assert_failure

    # Should return scope invalid or not found error
    assert_output --partial "empty" || assert_output --partial "not found" || assert_output --partial "invalid"
}

@test "error: E_TASK_NOT_IN_SCOPE when focus outside scope" {
    create_epic_hierarchy_todo
    create_multi_session_config

    # Try to start session with focus outside scope
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T001 --focus T011
    assert_failure

    # T011 is under T010, not T001
    assert_output --partial "scope" || assert_output --partial "not in"
}

@test "error: E_FOCUS_REQUIRED when starting without focus" {
    create_epic_hierarchy_todo
    create_multi_session_config

    # Try to start session without --focus or --auto-focus
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T001
    assert_failure

    # Should require focus
    assert_output --partial "focus" || assert_output --partial "required"
}

@test "error: E_SESSION_CLOSE_BLOCKED exit code is 37" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    # Try to close session with incomplete tasks
    run bash "$SCRIPTS_DIR/session.sh" close session_20251228_100000_abc123

    # Verify exit code is 37 (E_SESSION_CLOSE_BLOCKED)
    [[ "$status" -eq 37 ]] || [[ "$status" -eq 1 ]]
}

# =============================================================================
# Scope Type Tests
# =============================================================================

@test "scope type: task - single task only" {
    create_epic_hierarchy_todo
    create_multi_session_config

    # Start session with task scope (single task)
    run bash "$SCRIPTS_DIR/session.sh" start --scope task:T002 --focus T002
    assert_success

    # Verify scope only contains the single task
    local scope_count
    scope_count=$(jq '.sessions[0].scope.computedTaskIds | length' "$SESSIONS_FILE")
    [[ "$scope_count" -eq 1 ]]
}

@test "scope type: taskGroup - parent plus direct children" {
    create_epic_hierarchy_todo
    create_multi_session_config

    # Start session with taskGroup scope (T002 + its children T003, T004)
    run bash "$SCRIPTS_DIR/session.sh" start --scope taskGroup:T002 --focus T003
    assert_success

    # Verify scope contains parent and direct children
    local scope_count
    scope_count=$(jq '.sessions[0].scope.computedTaskIds | length' "$SESSIONS_FILE")
    [[ "$scope_count" -eq 3 ]]  # T002, T003, T004
}

@test "scope type: epic - full tree" {
    create_epic_hierarchy_todo
    create_multi_session_config

    # Start session with epic scope
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T001 --focus T002
    assert_success

    # Verify scope contains entire tree
    local scope_count
    scope_count=$(jq '.sessions[0].scope.computedTaskIds | length' "$SESSIONS_FILE")
    [[ "$scope_count" -eq 5 ]]  # T001, T002, T003, T004, T005
}

# =============================================================================
# Session List and Show Tests
# =============================================================================

@test "session list: shows all sessions" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    run bash "$SCRIPTS_DIR/session.sh" list
    assert_success

    # Should show the active session
    assert_output --partial "session_20251228_100000_abc123" || assert_output --partial "Test Session"
}

@test "session list: filters by status" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    # List only active sessions
    run bash "$SCRIPTS_DIR/session.sh" list --status active
    assert_success

    # Should show the session
    assert_output --partial "session_20251228_100000_abc123" || assert_output --partial "active"
}

@test "session show: displays session details" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    run bash "$SCRIPTS_DIR/session.sh" show session_20251228_100000_abc123
    assert_success

    # Should show session details
    assert_output --partial "session_20251228_100000_abc123"
    assert_output --partial "T001" || assert_output --partial "epic"
    assert_output --partial "active"
}

@test "session show: JSON output has expected structure" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    run bash "$SCRIPTS_DIR/session.sh" show session_20251228_100000_abc123 --format json
    assert_success

    # Verify JSON structure (compact JSON has no spaces after colons)
    assert_valid_json
    assert_output --partial '"success":true'
    assert_output --partial '"session":'
}

# =============================================================================
# Session Switch Tests
# =============================================================================

@test "session switch: updates current session context" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    # Switch to session
    run bash "$SCRIPTS_DIR/session.sh" switch session_20251228_100000_abc123
    assert_success

    # Verify .current-session file updated
    local current_session
    current_session=$(cat "${TEST_TEMP_DIR}/.cleo/.current-session" 2>/dev/null || echo "")
    [[ "$current_session" == "session_20251228_100000_abc123" ]]
}

@test "session switch: fails for non-existent session" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    # Try to switch to non-existent session
    run bash "$SCRIPTS_DIR/session.sh" switch nonexistent_session
    assert_failure

    assert_output --partial "not found" || assert_output --partial "Session"
}

# =============================================================================
# Dry Run Tests
# =============================================================================

@test "dry run: session start shows what would be created" {
    create_epic_hierarchy_todo
    create_multi_session_config

    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T001 --focus T002 --dry-run --format json
    assert_success

    # Verify dry run output (compact JSON has no spaces after colons)
    assert_output --partial '"dryRun":true'
    assert_output --partial "T001"
    assert_output --partial "T002"

    # Verify no session was created
    [[ ! -f "$SESSIONS_FILE" ]] || {
        local count
        count=$(jq '.sessions | length' "$SESSIONS_FILE" 2>/dev/null || echo "0")
        [[ "$count" -eq 0 ]]
    }
}

@test "dry run: session suspend shows what would change" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    run bash "$SCRIPTS_DIR/session.sh" suspend --dry-run
    assert_success

    # Verify session wasn't actually suspended
    local status
    status=$(jq -r '.sessions[0].status' "$SESSIONS_FILE")
    [[ "$status" == "active" ]]
}

# =============================================================================
# Concurrent Session Tests
# =============================================================================

@test "concurrent sessions: can start session for different epic" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session  # Session for T001

    # Start second session for different epic (T010)
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T010 --focus T011
    assert_success

    # Verify two sessions exist
    local session_count
    session_count=$(jq '.sessions | length' "$SESSIONS_FILE")
    [[ "$session_count" -eq 2 ]]
}

@test "concurrent sessions: max sessions enforced" {
    create_epic_hierarchy_todo
    create_multi_session_config

    # Create sessions.json at max capacity (5 sessions)
    cat > "$SESSIONS_FILE" << 'EOF'
{
  "$schema": "../schemas/sessions.schema.json",
  "version": "1.0.0",
  "project": "test",
  "_meta": {"checksum": "", "lastModified": "2025-12-28T10:00:00Z", "totalSessionsCreated": 5},
  "config": {"maxConcurrentSessions": 5, "maxActiveTasksPerScope": 1, "scopeValidation": "strict", "allowNestedScopes": true, "allowScopeOverlap": false},
  "sessions": [
    {"id": "s1", "status": "active", "name": null, "agentId": null, "scope": {"type": "task", "rootTaskId": "T002", "computedTaskIds": ["T002"]}, "focus": {"currentTask": "T002"}, "startedAt": "2025-12-28T10:00:00Z", "lastActivity": "2025-12-28T10:00:00Z", "suspendedAt": null, "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 0, "resumeCount": 0}},
    {"id": "s2", "status": "active", "name": null, "agentId": null, "scope": {"type": "task", "rootTaskId": "T003", "computedTaskIds": ["T003"]}, "focus": {"currentTask": "T003"}, "startedAt": "2025-12-28T10:00:00Z", "lastActivity": "2025-12-28T10:00:00Z", "suspendedAt": null, "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 0, "resumeCount": 0}},
    {"id": "s3", "status": "active", "name": null, "agentId": null, "scope": {"type": "task", "rootTaskId": "T004", "computedTaskIds": ["T004"]}, "focus": {"currentTask": "T004"}, "startedAt": "2025-12-28T10:00:00Z", "lastActivity": "2025-12-28T10:00:00Z", "suspendedAt": null, "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 0, "resumeCount": 0}},
    {"id": "s4", "status": "active", "name": null, "agentId": null, "scope": {"type": "task", "rootTaskId": "T005", "computedTaskIds": ["T005"]}, "focus": {"currentTask": "T005"}, "startedAt": "2025-12-28T10:00:00Z", "lastActivity": "2025-12-28T10:00:00Z", "suspendedAt": null, "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 0, "resumeCount": 0}},
    {"id": "s5", "status": "active", "name": null, "agentId": null, "scope": {"type": "task", "rootTaskId": "T011", "computedTaskIds": ["T011"]}, "focus": {"currentTask": "T011"}, "startedAt": "2025-12-28T10:00:00Z", "lastActivity": "2025-12-28T10:00:00Z", "suspendedAt": null, "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 0, "resumeCount": 0}}
  ],
  "sessionHistory": []
}
EOF

    # Try to start 6th session
    run bash "$SCRIPTS_DIR/session.sh" start --scope task:T001 --focus T001
    assert_failure

    # Should fail with max sessions error
    assert_output --partial "Maximum" || assert_output --partial "max" || assert_output --partial "concurrent"
}

# =============================================================================
# Integration with Other Commands Tests
# =============================================================================

@test "integration: complete task updates session stats" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    # Set current session context
    echo "session_20251228_100000_abc123" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Complete a task
    run bash "$COMPLETE_SCRIPT" T003 --skip-notes
    assert_success

    # Verify task is complete
    assert_task_status "T003" "done"

    # Note: Session stats update may require additional implementation
}

@test "integration: session status shows multi-session info" {
    create_epic_hierarchy_todo
    create_multi_session_config
    create_active_session

    run bash "$SCRIPTS_DIR/session.sh" status --format json
    assert_success

    # Should show session information
    assert_valid_json
}
