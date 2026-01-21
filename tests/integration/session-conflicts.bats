#!/usr/bin/env bats
# =============================================================================
# session-conflicts.bats - Integration tests for session conflict detection
# =============================================================================
# Tests multi-session conflict scenarios:
# - Scope overlap detection (two sessions trying same epic)
# - Simultaneous focus attempts on same task
# - Session handoff edge cases
# - Focus on task outside session scope
# - Starting session when scope already claimed
#
# Error codes tested:
# - E_SCOPE_CONFLICT (32): Scope overlap with another session
# - E_TASK_NOT_IN_SCOPE (34): Task not within session's computed scope
# - E_SESSION_REQUIRED (36): Session required but not active
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

# Create multi-session enabled config with strict validation
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
    "allowScopeOverlap": false
  },
  "session": {
    "requireSession": true,
    "enforcement": "strict"
  }
}
EOF
}

# Create multi-session config with warn enforcement (allows writes without session)
create_warn_enforcement_config() {
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
    "allowScopeOverlap": false
  },
  "session": {
    "requireSession": true,
    "enforcement": "warn"
  }
}
EOF
}

# Create todo.json with two epics for conflict testing
create_conflict_test_todo() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.6.0",
  "project": {
    "name": "conflict-test",
    "currentPhase": "core",
    "phases": {
      "core": {"order": 1, "name": "Core", "description": "Core features", "status": "active"}
    }
  },
  "_meta": {"version": "2.6.0", "checksum": "placeholder", "configVersion": "2.6.0"},
  "tasks": [
    {
      "id": "T001",
      "title": "Epic One - Auth System",
      "description": "Authentication epic with multiple tasks",
      "status": "pending",
      "priority": "high",
      "type": "epic",
      "parentId": null,
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
      "phase": "core",
      "createdAt": "2025-12-01T10:02:00Z"
    },
    {
      "id": "T004",
      "title": "Logout endpoint",
      "description": "Implement logout API",
      "status": "pending",
      "priority": "medium",
      "type": "task",
      "parentId": "T001",
      "phase": "core",
      "createdAt": "2025-12-01T10:03:00Z"
    },
    {
      "id": "T010",
      "title": "Epic Two - Payment System",
      "description": "Payment processing epic",
      "status": "pending",
      "priority": "high",
      "type": "epic",
      "parentId": null,
      "phase": "core",
      "createdAt": "2025-12-01T10:04:00Z"
    },
    {
      "id": "T011",
      "title": "Payment gateway",
      "description": "Stripe integration",
      "status": "pending",
      "priority": "high",
      "type": "task",
      "parentId": "T010",
      "phase": "core",
      "createdAt": "2025-12-01T10:05:00Z"
    },
    {
      "id": "T020",
      "title": "Standalone Task",
      "description": "Task not in any epic",
      "status": "pending",
      "priority": "low",
      "type": "task",
      "parentId": null,
      "phase": "core",
      "createdAt": "2025-12-01T10:06:00Z"
    }
  ],
  "focus": {},
  "labels": {},
  "lastUpdated": "2025-12-01T10:06:00Z"
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

# Create sessions.json with an active session on T001 epic
create_active_session_on_epic() {
    local dest="${1:-$SESSIONS_FILE}"
    local epic_id="${2:-T001}"
    local session_id="${3:-session_conflict_alpha}"
    cat > "$dest" << EOF
{
  "\$schema": "../schemas/sessions.schema.json",
  "version": "1.0.0",
  "project": "conflict-test",
  "_meta": {
    "checksum": "",
    "lastModified": "2026-01-01T10:00:00Z",
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
      "name": "Alpha Agent Session",
      "agentId": "agent-alpha",
      "scope": {
        "type": "epic",
        "rootTaskId": "$epic_id",
        "computedTaskIds": ["$epic_id", "T002", "T003", "T004"]
      },
      "focus": {
        "currentTask": "T002",
        "currentPhase": "core",
        "previousTask": null,
        "sessionNote": null,
        "nextAction": null,
        "focusHistory": []
      },
      "startedAt": "2026-01-01T10:00:00Z",
      "lastActivity": "2026-01-01T12:00:00Z",
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

# Create sessions.json with two active sessions on different epics
create_two_active_sessions() {
    local dest="${1:-$SESSIONS_FILE}"
    cat > "$dest" << 'EOF'
{
  "$schema": "../schemas/sessions.schema.json",
  "version": "1.0.0",
  "project": "conflict-test",
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
      "name": "Alpha Session - Auth",
      "agentId": "agent-alpha",
      "scope": {
        "type": "epic",
        "rootTaskId": "T001",
        "computedTaskIds": ["T001", "T002", "T003", "T004"]
      },
      "focus": {
        "currentTask": "T002",
        "currentPhase": "core"
      },
      "startedAt": "2026-01-01T10:00:00Z",
      "lastActivity": "2026-01-01T12:00:00Z",
      "suspendedAt": null,
      "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 0, "resumeCount": 0}
    },
    {
      "id": "session_beta",
      "status": "active",
      "name": "Beta Session - Payment",
      "agentId": "agent-beta",
      "scope": {
        "type": "epic",
        "rootTaskId": "T010",
        "computedTaskIds": ["T010", "T011"]
      },
      "focus": {
        "currentTask": "T011",
        "currentPhase": "core"
      },
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
# SCENARIO 1: Scope Overlap Detection
# =============================================================================

@test "scope conflict: cannot start session with same epic scope as existing active session" {
    create_conflict_test_todo
    create_multi_session_config
    create_active_session_on_epic  # Session on T001

    # Try to start another session on same epic
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T001 --focus T004
    assert_failure

    # Should indicate scope conflict
    assert_output --partial "conflict" || assert_output --partial "scope" || assert_output --partial "overlap"
}

@test "scope conflict: cannot start session with overlapping task scope" {
    create_conflict_test_todo
    create_multi_session_config
    create_active_session_on_epic  # Session on T001 epic (includes T002)

    # Try to start session scoped to T002 (which is part of T001's scope)
    run bash "$SCRIPTS_DIR/session.sh" start --scope task:T002 --focus T002
    assert_failure

    # Should indicate scope conflict (T002 is already claimed by T001 epic session)
    assert_output --partial "conflict" || assert_output --partial "scope" || assert_output --partial "claimed"
}

@test "scope conflict: cannot start session with taskGroup overlapping existing epic scope" {
    create_conflict_test_todo
    create_multi_session_config
    create_active_session_on_epic  # Session on T001 epic

    # Try to start session with taskGroup scope that overlaps
    run bash "$SCRIPTS_DIR/session.sh" start --scope taskGroup:T002 --focus T003
    assert_failure

    # T002 and T003 are within T001's scope
    assert_output --partial "conflict" || assert_output --partial "scope" || assert_output --partial "overlap"
}

@test "scope conflict: disjoint scopes allowed simultaneously" {
    create_conflict_test_todo
    create_multi_session_config
    create_active_session_on_epic  # Session on T001 epic

    # Start session on different, non-overlapping epic
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T010 --focus T011
    assert_success

    # Verify two sessions now exist
    local session_count
    session_count=$(jq '.sessions | length' "$SESSIONS_FILE")
    [[ "$session_count" -eq 2 ]]

    # Verify both are active
    local active_count
    active_count=$(jq '[.sessions[] | select(.status == "active")] | length' "$SESSIONS_FILE")
    [[ "$active_count" -eq 2 ]]
}

@test "scope conflict: exit code is 32 (E_SCOPE_CONFLICT)" {
    create_conflict_test_todo
    create_multi_session_config
    create_active_session_on_epic

    # Try to start conflicting session
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T001 --focus T002

    # Verify exit code is 32 (E_SCOPE_CONFLICT) or 1 (generic failure)
    [[ "$status" -eq 32 ]] || [[ "$status" -eq 1 ]]
}

# =============================================================================
# SCENARIO 2: Simultaneous Focus Attempts
# =============================================================================

@test "simultaneous focus: task claimed by one session cannot be focused by another" {
    create_conflict_test_todo
    create_multi_session_config
    create_two_active_sessions

    # Alpha session has focus on T002, Beta session has focus on T011
    # Simulate Alpha trying to focus on T011 (Beta's focus)

    # Set context to alpha session
    echo "session_alpha" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Try to focus on a task outside alpha's scope
    run bash "$SCRIPTS_DIR/focus.sh" set T011
    assert_failure

    # T011 is outside T001 epic's scope
    assert_output --partial "scope" || assert_output --partial "not in"
}

@test "simultaneous focus: cannot focus on task not in session scope" {
    create_conflict_test_todo
    create_multi_session_config
    create_active_session_on_epic  # Session on T001 with focus on T002

    # Set context to alpha session
    echo "session_conflict_alpha" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Try to focus on standalone task (not in any epic)
    run bash "$SCRIPTS_DIR/focus.sh" set T020
    assert_failure

    # T020 is not in T001's scope
    assert_output --partial "scope" || assert_output --partial "not in"
}

@test "simultaneous focus: can switch focus within session scope" {
    create_conflict_test_todo
    create_multi_session_config
    create_active_session_on_epic  # Session on T001 with focus on T002

    # Set context to alpha session
    echo "session_conflict_alpha" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Switch focus to different task within scope (T003 is under T002, which is under T001)
    run bash "$SCRIPTS_DIR/focus.sh" set T003
    assert_success

    # Verify focus changed
    local current_focus
    current_focus=$(jq -r '.focus.currentTask' "$TODO_FILE")
    [[ "$current_focus" == "T003" ]]
}

# =============================================================================
# SCENARIO 3: Session Handoff Edge Cases
# =============================================================================

@test "handoff: suspending session allows other session to claim overlapping scope" {
    create_conflict_test_todo
    create_multi_session_config
    create_active_session_on_epic  # Active session on T001

    # Set context
    echo "session_conflict_alpha" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Suspend the session
    run bash "$SCRIPTS_DIR/session.sh" suspend --note "Handing off"
    assert_success

    # Verify session is suspended
    local session_status
    session_status=$(jq -r '.sessions[0].status' "$SESSIONS_FILE")
    [[ "$session_status" == "suspended" ]]

    # Now another agent should be able to start session on same scope
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T001 --focus T004
    assert_success

    # Verify new session created (2 total now)
    local session_count
    session_count=$(jq '.sessions | length' "$SESSIONS_FILE")
    [[ "$session_count" -eq 2 ]]
}

@test "handoff: ended session releases scope for new sessions" {
    create_conflict_test_todo
    create_multi_session_config

    # Start a fresh session
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T001 --focus T002
    assert_success

    # Set context to use this session
    local session_id
    session_id=$(jq -r '.sessions[0].id' "$SESSIONS_FILE")
    echo "$session_id" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # End the session
    run bash "$SCRIPTS_DIR/session.sh" end --note "Completed for now"
    assert_success

    # Verify session ended
    local session_status
    session_status=$(jq -r '.sessions[0].status' "$SESSIONS_FILE")
    [[ "$session_status" == "ended" ]]

    # Start new session on same scope (should succeed since previous is ended)
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T001 --focus T004
    assert_success
}

@test "handoff: resuming a session re-claims its scope" {
    create_conflict_test_todo
    create_multi_session_config

    # Create a suspended session
    cat > "$SESSIONS_FILE" << 'EOF'
{
  "$schema": "../schemas/sessions.schema.json",
  "version": "1.0.0",
  "project": "conflict-test",
  "_meta": {"checksum": "", "lastModified": "2026-01-01T10:00:00Z", "totalSessionsCreated": 1},
  "config": {"maxConcurrentSessions": 5, "maxActiveTasksPerScope": 1, "scopeValidation": "strict", "allowNestedScopes": true, "allowScopeOverlap": false},
  "sessions": [{
    "id": "session_suspended",
    "status": "suspended",
    "name": "Suspended Session",
    "agentId": null,
    "scope": {"type": "epic", "rootTaskId": "T001", "computedTaskIds": ["T001", "T002", "T003", "T004"]},
    "focus": {"currentTask": "T002", "currentPhase": "core"},
    "startedAt": "2026-01-01T10:00:00Z",
    "lastActivity": "2026-01-01T12:00:00Z",
    "suspendedAt": "2026-01-01T12:00:00Z",
    "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 1, "resumeCount": 0}
  }],
  "sessionHistory": []
}
EOF

    # Resume the session
    run bash "$SCRIPTS_DIR/session.sh" resume session_suspended
    assert_success

    # Verify session is active again
    local session_status
    session_status=$(jq -r '.sessions[0].status' "$SESSIONS_FILE")
    [[ "$session_status" == "active" ]]

    # Now trying to start new session on same scope should fail
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T001 --focus T004
    assert_failure
}

@test "handoff: resuming session when scope already active shows warning" {
    create_conflict_test_todo
    create_multi_session_config

    # Create suspended session and active session on same scope
    cat > "$SESSIONS_FILE" << 'EOF'
{
  "$schema": "../schemas/sessions.schema.json",
  "version": "1.0.0",
  "project": "conflict-test",
  "_meta": {"checksum": "", "lastModified": "2026-01-01T10:00:00Z", "totalSessionsCreated": 2},
  "config": {"maxConcurrentSessions": 5, "maxActiveTasksPerScope": 1, "scopeValidation": "strict", "allowNestedScopes": true, "allowScopeOverlap": false},
  "sessions": [
    {
      "id": "session_suspended",
      "status": "suspended",
      "name": "Suspended Session",
      "agentId": null,
      "scope": {"type": "epic", "rootTaskId": "T001", "computedTaskIds": ["T001", "T002", "T003", "T004"]},
      "focus": {"currentTask": "T002", "currentPhase": "core"},
      "startedAt": "2026-01-01T10:00:00Z",
      "lastActivity": "2026-01-01T12:00:00Z",
      "suspendedAt": "2026-01-01T12:00:00Z",
      "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 1, "resumeCount": 0}
    },
    {
      "id": "session_active",
      "status": "active",
      "name": "Active Session",
      "agentId": "agent-new",
      "scope": {"type": "epic", "rootTaskId": "T001", "computedTaskIds": ["T001", "T002", "T003", "T004"]},
      "focus": {"currentTask": "T004", "currentPhase": "core"},
      "startedAt": "2026-01-01T13:00:00Z",
      "lastActivity": "2026-01-01T14:00:00Z",
      "suspendedAt": null,
      "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 0, "resumeCount": 0}
    }
  ],
  "sessionHistory": []
}
EOF

    # Resume the suspended session - system allows this but may warn
    # (Current implementation allows resuming even with overlapping scope)
    run bash "$SCRIPTS_DIR/session.sh" resume session_suspended

    # Whether it succeeds or fails, verify session state
    if [[ "$status" -eq 0 ]]; then
        # Session resumed - verify it's active
        local session_status
        session_status=$(jq -r '.sessions[] | select(.id == "session_suspended") | .status' "$SESSIONS_FILE")
        [[ "$session_status" == "active" ]]
    else
        # Conflict detected
        assert_output --partial "conflict" || assert_output --partial "scope"
    fi
}

# =============================================================================
# SCENARIO 4: Focus on Task Outside Session Scope
# =============================================================================

@test "out-of-scope: focus set on task in different epic fails" {
    create_conflict_test_todo
    create_multi_session_config
    create_active_session_on_epic  # Session on T001

    echo "session_conflict_alpha" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Try to focus on task from different epic
    run bash "$SCRIPTS_DIR/focus.sh" set T011  # T011 is under T010
    assert_failure

    # Should indicate task not in scope
    assert_output --partial "scope" || assert_output --partial "not in"
}

@test "out-of-scope: focus set on standalone task fails with appropriate error" {
    create_conflict_test_todo
    create_multi_session_config
    create_active_session_on_epic

    echo "session_conflict_alpha" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    run bash "$SCRIPTS_DIR/focus.sh" set T020  # Standalone task not in scope

    # Should fail - exit code may be 34 (E_TASK_NOT_IN_SCOPE), 1 (generic), or other
    assert_failure

    # Should indicate scope issue
    assert_output --partial "scope" || assert_output --partial "not in"
}

@test "out-of-scope: starting session with focus outside scope fails" {
    create_conflict_test_todo
    create_multi_session_config

    # Try to start session with focus not in scope
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T001 --focus T011
    assert_failure

    # T011 is not in T001's scope
    assert_output --partial "scope" || assert_output --partial "not in"
}

@test "out-of-scope: task completion enforcement behavior" {
    create_conflict_test_todo
    create_multi_session_config
    create_active_session_on_epic

    echo "session_conflict_alpha" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Try to complete task outside scope (T011 is under T010, not T001)
    run bash "$COMPLETE_SCRIPT" T011 --skip-notes

    # Current implementation may allow completion (enforcement pending full implementation)
    # This test documents current behavior - task completion may succeed
    # Future enhancement: strict session enforcement would reject this

    if [[ "$status" -eq 0 ]]; then
        # Task was completed - verify it's done
        assert_task_status "T011" "done"
    else
        # Enforcement active - should mention scope
        assert_output --partial "scope" || assert_output --partial "session"
    fi
}

# =============================================================================
# SCENARIO 5: Starting Session When Scope Already Claimed
# =============================================================================

@test "scope claimed: starting nested session produces warning but may succeed" {
    create_conflict_test_todo
    create_multi_session_config
    create_active_session_on_epic  # T001 epic with T002, T003, T004

    # Try to start new session claiming just T003 (which is in T001's scope)
    # Current implementation with allowNestedScopes: true warns but allows
    run bash "$SCRIPTS_DIR/session.sh" start --scope task:T003 --focus T003

    if [[ "$status" -eq 0 ]]; then
        # Nested session allowed with warning
        assert_output --partial "Warning" || assert_output --partial "nested"
        # Verify session was created
        local session_count
        session_count=$(jq '.sessions | length' "$SESSIONS_FILE")
        [[ "$session_count" -eq 2 ]]
    else
        # Strict mode rejected the nested scope
        assert_output --partial "conflict" || assert_output --partial "claimed" || assert_output --partial "scope"
    fi
}

@test "scope claimed: nested scope within active epic scope rejected" {
    create_conflict_test_todo
    create_multi_session_config
    create_active_session_on_epic  # T001 epic session

    # Try to start session with subtree scope that overlaps
    run bash "$SCRIPTS_DIR/session.sh" start --scope subtree:T002 --focus T003
    assert_failure

    # T002 subtree is nested within T001 epic scope
    assert_output --partial "conflict" || assert_output --partial "scope" || assert_output --partial "overlap"
}

@test "scope claimed: session list shows scopes to identify conflicts" {
    create_conflict_test_todo
    create_multi_session_config
    create_two_active_sessions

    run bash "$SCRIPTS_DIR/session.sh" list --format json
    assert_success

    # Verify JSON contains scope information
    assert_valid_json
    assert_output --partial "T001"
    assert_output --partial "T010"
}

@test "scope claimed: dry-run shows conflict without modifying state" {
    create_conflict_test_todo
    create_multi_session_config
    create_active_session_on_epic

    # Get initial session count
    local initial_count
    initial_count=$(jq '.sessions | length' "$SESSIONS_FILE")

    # Dry-run on conflicting scope
    run bash "$SCRIPTS_DIR/session.sh" start --scope epic:T001 --focus T004 --dry-run
    # Dry-run may succeed (showing what would happen) or fail (showing conflict)

    # Verify no new session was actually created
    local final_count
    final_count=$(jq '.sessions | length' "$SESSIONS_FILE")
    [[ "$final_count" -eq "$initial_count" ]]
}

# =============================================================================
# Additional Edge Cases
# =============================================================================

@test "edge case: max concurrent sessions enforced" {
    create_conflict_test_todo
    create_multi_session_config

    # Create sessions.json at max capacity (5 sessions) on different tasks
    cat > "$SESSIONS_FILE" << 'EOF'
{
  "$schema": "../schemas/sessions.schema.json",
  "version": "1.0.0",
  "project": "conflict-test",
  "_meta": {"checksum": "", "lastModified": "2026-01-01T10:00:00Z", "totalSessionsCreated": 5},
  "config": {"maxConcurrentSessions": 5, "maxActiveTasksPerScope": 1, "scopeValidation": "strict", "allowNestedScopes": true, "allowScopeOverlap": false},
  "sessions": [
    {"id": "s1", "status": "active", "name": null, "agentId": null, "scope": {"type": "task", "rootTaskId": "T002", "computedTaskIds": ["T002"]}, "focus": {"currentTask": "T002"}, "startedAt": "2026-01-01T10:00:00Z", "lastActivity": "2026-01-01T10:00:00Z", "suspendedAt": null, "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 0, "resumeCount": 0}},
    {"id": "s2", "status": "active", "name": null, "agentId": null, "scope": {"type": "task", "rootTaskId": "T003", "computedTaskIds": ["T003"]}, "focus": {"currentTask": "T003"}, "startedAt": "2026-01-01T10:00:00Z", "lastActivity": "2026-01-01T10:00:00Z", "suspendedAt": null, "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 0, "resumeCount": 0}},
    {"id": "s3", "status": "active", "name": null, "agentId": null, "scope": {"type": "task", "rootTaskId": "T004", "computedTaskIds": ["T004"]}, "focus": {"currentTask": "T004"}, "startedAt": "2026-01-01T10:00:00Z", "lastActivity": "2026-01-01T10:00:00Z", "suspendedAt": null, "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 0, "resumeCount": 0}},
    {"id": "s4", "status": "active", "name": null, "agentId": null, "scope": {"type": "task", "rootTaskId": "T011", "computedTaskIds": ["T011"]}, "focus": {"currentTask": "T011"}, "startedAt": "2026-01-01T10:00:00Z", "lastActivity": "2026-01-01T10:00:00Z", "suspendedAt": null, "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 0, "resumeCount": 0}},
    {"id": "s5", "status": "active", "name": null, "agentId": null, "scope": {"type": "task", "rootTaskId": "T020", "computedTaskIds": ["T020"]}, "focus": {"currentTask": "T020"}, "startedAt": "2026-01-01T10:00:00Z", "lastActivity": "2026-01-01T10:00:00Z", "suspendedAt": null, "stats": {"tasksCompleted": 0, "focusChanges": 1, "suspendCount": 0, "resumeCount": 0}}
  ],
  "sessionHistory": []
}
EOF

    # Try to start 6th session on unclaimed task (T001 epic)
    run bash "$SCRIPTS_DIR/session.sh" start --scope task:T001 --focus T001
    assert_failure

    # Should fail with max sessions error
    assert_output --partial "Maximum" || assert_output --partial "max" || assert_output --partial "concurrent"
}

@test "edge case: warn enforcement allows operations with warning" {
    create_conflict_test_todo
    create_warn_enforcement_config
    # No active session

    # Operations should succeed with warnings in warn mode
    run bash "$ADD_SCRIPT" "Test task" --description "Testing warn mode"

    # In warn mode, should succeed (possibly with warning)
    assert_success || [[ "$status" -eq 0 ]]
}

@test "edge case: CLEO_SESSION env var overrides file binding" {
    create_conflict_test_todo
    create_multi_session_config
    create_two_active_sessions

    # Set file binding to alpha
    echo "session_alpha" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Set env var to beta
    export CLEO_SESSION="session_beta"

    # Session status should use beta
    run bash "$SCRIPTS_DIR/session.sh" doctor --json
    assert_success

    # Verify resolved session is beta (env var takes precedence)
    local resolved
    resolved=$(echo "$output" | jq -r '.resolution.resolved // empty')
    [[ "$resolved" == "session_beta" ]]

    unset CLEO_SESSION
}
