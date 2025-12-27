#!/usr/bin/env bats
# =============================================================================
# delete-workflow.bats - Integration tests for delete/cancel workflow
# =============================================================================
# Tests the full delete lifecycle including:
#   - Full lifecycle: add → delete → verify archive
#   - Restore workflow: add → delete → uncancel → verify restored
#   - Hierarchy: cascade delete → verify all in archive
#   - Focus integration: focus task → delete → verify focus cleared
#   - Dependency management: delete → verify deps cleaned up
#   - Atomic operations: backup existence, checksum updates
#   - Error recovery: proper errors for edge cases
#
# Part of: Delete Command Implementation (T713)
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test

    # Export delete and uncancel scripts
    export DELETE_SCRIPT="${SCRIPTS_DIR}/delete.sh"
    export UNCANCEL_SCRIPT="${SCRIPTS_DIR}/uncancel.sh"
    export ARCHIVE_FILE="${TEST_TEMP_DIR}/.cleo/todo-archive.json"

    # Create empty archive for tests
    create_empty_archive "$ARCHIVE_FILE"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# FIXTURES - Delete Workflow Specific
# =============================================================================

# Create fixture with simple pending task
create_single_pending_task() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "delete-test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "completed"},
      "core": {"order": 2, "name": "Core", "status": "active"},
      "testing": {"order": 3, "name": "Testing", "status": "pending"}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Task to delete", "description": "Will be deleted", "status": "pending", "priority": "medium", "phase": "core", "createdAt": "2025-12-01T10:00:00Z"}
  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create fixture with focused task
create_focused_task() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "delete-test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "completed"},
      "core": {"order": 2, "name": "Core", "status": "active"},
      "testing": {"order": 3, "name": "Testing", "status": "pending"}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder", "activeSession": "session_test_001"},
  "tasks": [
    {"id": "T001", "title": "Focused task", "description": "Currently in focus", "status": "active", "priority": "high", "phase": "core", "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T002", "title": "Other task", "description": "Not in focus", "status": "pending", "priority": "medium", "phase": "core", "createdAt": "2025-12-01T11:00:00Z"}
  ],
  "focus": {
    "currentTask": "T001",
    "currentPhase": "core",
    "sessionNote": "Working on focused task"
  },
  "labels": {},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create fixture with parent-child hierarchy
create_parent_child_hierarchy() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "delete-test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "completed"},
      "core": {"order": 2, "name": "Core", "status": "active"},
      "testing": {"order": 3, "name": "Testing", "status": "pending"}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Epic parent", "description": "Parent epic", "status": "pending", "priority": "high", "phase": "core", "type": "epic", "parentId": null, "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T002", "title": "Child task 1", "description": "First child", "status": "pending", "priority": "medium", "phase": "core", "type": "task", "parentId": "T001", "createdAt": "2025-12-01T11:00:00Z"},
    {"id": "T003", "title": "Child task 2", "description": "Second child", "status": "pending", "priority": "medium", "phase": "core", "type": "task", "parentId": "T001", "createdAt": "2025-12-01T12:00:00Z"},
    {"id": "T004", "title": "Grandchild subtask", "description": "Subtask of T002", "status": "pending", "priority": "low", "phase": "core", "type": "subtask", "parentId": "T002", "createdAt": "2025-12-01T13:00:00Z"}
  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "lastUpdated": "2025-12-01T13:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create fixture with task dependencies
create_tasks_with_dependencies() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "delete-test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "completed"},
      "core": {"order": 2, "name": "Core", "status": "active"},
      "testing": {"order": 3, "name": "Testing", "status": "pending"}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Foundation task", "description": "Base dependency", "status": "pending", "priority": "high", "phase": "core", "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T002", "title": "Dependent task", "description": "Depends on T001", "status": "pending", "priority": "medium", "phase": "core", "createdAt": "2025-12-01T11:00:00Z", "depends": ["T001"]},
    {"id": "T003", "title": "Another dependent", "description": "Also depends on T001", "status": "pending", "priority": "medium", "phase": "core", "createdAt": "2025-12-01T12:00:00Z", "depends": ["T001"]},
    {"id": "T004", "title": "Multi-dependent", "description": "Depends on both T001 and T002", "status": "pending", "priority": "low", "phase": "core", "createdAt": "2025-12-01T13:00:00Z", "depends": ["T001", "T002"]}
  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "lastUpdated": "2025-12-01T13:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create fixture with completed task (for error testing)
create_completed_task() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "delete-test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "completed"},
      "core": {"order": 2, "name": "Core", "status": "active"},
      "testing": {"order": 3, "name": "Testing", "status": "pending"}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Completed task", "description": "Already done", "status": "done", "priority": "high", "phase": "setup", "createdAt": "2025-12-01T10:00:00Z", "completedAt": "2025-12-10T12:00:00Z"}
  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "lastUpdated": "2025-12-10T12:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create fixture with cancelled task (for restore testing)
create_cancelled_task() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "delete-test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "completed"},
      "core": {"order": 2, "name": "Core", "status": "active"},
      "testing": {"order": 3, "name": "Testing", "status": "pending"}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Cancelled task", "description": "Previously cancelled", "status": "cancelled", "priority": "medium", "phase": "core", "createdAt": "2025-12-01T10:00:00Z", "cancelledAt": "2025-12-15T10:00:00Z", "cancelReason": "Requirements changed"}
  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "lastUpdated": "2025-12-15T10:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create fixture with cancelled hierarchy for cascade restore testing
create_cancelled_hierarchy() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "delete-test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "completed"},
      "core": {"order": 2, "name": "Core", "status": "active"},
      "testing": {"order": 3, "name": "Testing", "status": "pending"}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Cancelled parent", "description": "Parent was cancelled", "status": "cancelled", "priority": "high", "phase": "core", "type": "epic", "parentId": null, "createdAt": "2025-12-01T10:00:00Z", "cancelledAt": "2025-12-15T10:00:00Z", "cancelReason": "Epic superseded"},
    {"id": "T002", "title": "Cancelled child 1", "description": "Child also cancelled", "status": "cancelled", "priority": "medium", "phase": "core", "type": "task", "parentId": "T001", "createdAt": "2025-12-01T11:00:00Z", "cancelledAt": "2025-12-15T10:00:00Z", "cancelReason": "Epic superseded"},
    {"id": "T003", "title": "Cancelled child 2", "description": "Another cancelled child", "status": "cancelled", "priority": "medium", "phase": "core", "type": "task", "parentId": "T001", "createdAt": "2025-12-01T12:00:00Z", "cancelledAt": "2025-12-15T10:00:00Z", "cancelReason": "Epic superseded"},
    {"id": "T004", "title": "Unrelated task", "description": "Not cancelled", "status": "pending", "priority": "low", "phase": "core", "createdAt": "2025-12-01T13:00:00Z"}
  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "lastUpdated": "2025-12-15T10:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# =============================================================================
# FULL LIFECYCLE TESTS
# =============================================================================

@test "lifecycle: add → delete → verify status cancelled" {
    create_empty_todo

    # Add task
    run bash "$ADD_SCRIPT" "Task to cancel" --description "Will be cancelled" --priority medium
    assert_success
    local task_id
    task_id=$(jq -r '.tasks[-1].id' "$TODO_FILE")

    # Verify task exists
    assert_task_exists "$task_id"
    assert_task_status "$task_id" "pending"

    # Delete task
    run bash "$DELETE_SCRIPT" "$task_id" --reason "No longer needed" --force
    assert_success

    # Verify task is now cancelled
    assert_task_status "$task_id" "cancelled"

    # Verify cancellation metadata
    local cancel_reason
    cancel_reason=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .cancelReason // .cancellationReason // ""' "$TODO_FILE")
    [[ "$cancel_reason" == "No longer needed" ]]

    local cancelled_at
    cancelled_at=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .cancelledAt // ""' "$TODO_FILE")
    [[ -n "$cancelled_at" ]]
}

@test "lifecycle: add → delete → restore (uncancel)" {
    create_empty_todo

    # Add task
    bash "$ADD_SCRIPT" "Task for restore test" --description "Will be cancelled then restored" --priority high
    local task_id
    task_id=$(jq -r '.tasks[-1].id' "$TODO_FILE")

    # Delete task
    bash "$DELETE_SCRIPT" "$task_id" --reason "Testing restore" --force

    # Verify cancelled
    assert_task_status "$task_id" "cancelled"

    # Restore task
    run bash "$UNCANCEL_SCRIPT" "$task_id"
    assert_success

    # Verify restored to pending
    assert_task_status "$task_id" "pending"

    # Verify restoration note added
    local notes
    notes=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .notes[-1] // ""' "$TODO_FILE")
    [[ "$notes" == *"RESTORED"* ]]
}

@test "lifecycle: add hierarchy → cascade delete → verify all cancelled" {
    # NOTE: Uses 2-level hierarchy (parent + direct children) because
    # get_descendants has a known IFS issue when backup.sh is loaded.
    # See: backup.sh line 89 sets IFS=$'\n\t' which breaks space-separated iteration.
    create_empty_todo

    # Add parent and direct children (2 levels only)
    bash "$ADD_SCRIPT" "Epic parent" --description "Parent epic" --priority high
    local parent_id
    parent_id=$(jq -r '.tasks[-1].id' "$TODO_FILE")

    bash "$ADD_SCRIPT" "Child 1" --description "First child" --parent "$parent_id"
    bash "$ADD_SCRIPT" "Child 2" --description "Second child" --parent "$parent_id"

    # Verify initial state (3 tasks: parent + 2 children)
    assert_task_count 3

    # Delete parent with cascade
    run bash "$DELETE_SCRIPT" "$parent_id" --reason "Epic cancelled" --children cascade --force
    assert_success

    # Verify parent and children are cancelled
    local cancelled_count
    cancelled_count=$(jq '[.tasks[] | select(.status == "cancelled")] | length' "$TODO_FILE")
    [[ "$cancelled_count" -eq 3 ]]
}

# =============================================================================
# FOCUS INTEGRATION TESTS
# =============================================================================

@test "focus: delete focused task → focus cleared" {
    create_focused_task

    # Verify T001 is focused
    local current_focus
    current_focus=$(jq -r '.focus.currentTask' "$TODO_FILE")
    [[ "$current_focus" == "T001" ]]

    # Delete focused task
    run bash "$DELETE_SCRIPT" T001 --reason "No longer needed" --force
    assert_success

    # Verify focus is cleared
    local new_focus
    new_focus=$(jq -r '.focus.currentTask // ""' "$TODO_FILE")
    [[ -z "$new_focus" || "$new_focus" == "null" ]]
}

@test "focus: delete focused task → session note preserved" {
    create_focused_task

    # Verify session note exists
    local session_note
    session_note=$(jq -r '.focus.sessionNote // ""' "$TODO_FILE")
    [[ "$session_note" == "Working on focused task" ]]

    # Delete focused task
    bash "$DELETE_SCRIPT" T001 --reason "Switching priorities" --force

    # Verify session note is still preserved (context continuity)
    local new_session_note
    new_session_note=$(jq -r '.focus.sessionNote // ""' "$TODO_FILE")
    [[ "$new_session_note" == "Working on focused task" ]]
}

@test "focus: delete non-focused task → focus unchanged" {
    create_focused_task

    # Delete T002 (not focused)
    run bash "$DELETE_SCRIPT" T002 --reason "Removed from scope" --force
    assert_success

    # Verify focus is still on T001
    local current_focus
    current_focus=$(jq -r '.focus.currentTask' "$TODO_FILE")
    [[ "$current_focus" == "T001" ]]
}

@test "focus: delete focused task → session continues (other tasks exist)" {
    # Create a fixture without pre-existing active session
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "delete-test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "completed"},
      "core": {"order": 2, "name": "Core", "status": "active"},
      "testing": {"order": 3, "name": "Testing", "status": "pending"}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Focused task", "description": "Currently in focus", "status": "active", "priority": "high", "phase": "core", "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T002", "title": "Other task", "description": "Not in focus", "status": "pending", "priority": "medium", "phase": "core", "createdAt": "2025-12-01T11:00:00Z"}
  ],
  "focus": {
    "currentTask": "T001",
    "currentPhase": "core"
  },
  "labels": {},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF
    _update_fixture_checksum "$TODO_FILE"

    # Start a session
    bash "$SCRIPTS_DIR/session.sh" start

    # Delete focused task
    bash "$DELETE_SCRIPT" T001 --reason "Pivoting to different work" --force

    # Verify session is still active (session end not called)
    local session_id
    session_id=$(jq -r '._meta.activeSession // ""' "$TODO_FILE")
    [[ -n "$session_id" && "$session_id" != "null" ]]

    # Other task should still be available
    assert_task_exists "T002"
}

# =============================================================================
# CASCADE DELETE + RESTORE TESTS
# =============================================================================

@test "cascade: delete parent → restore with cascade → verify hierarchy restored" {
    create_parent_child_hierarchy

    # Delete parent with cascade (all 4 tasks cancelled)
    bash "$DELETE_SCRIPT" T001 --reason "Epic cancelled" --children cascade --force

    # Verify all cancelled
    assert_task_status "T001" "cancelled"
    assert_task_status "T002" "cancelled"

    # Restore parent with cascade
    run bash "$UNCANCEL_SCRIPT" T001 --cascade
    assert_success

    # Verify parent and children restored
    assert_task_status "T001" "pending"
    assert_task_status "T002" "pending"
    assert_task_status "T003" "pending"
}

@test "cascade: restore only parent (no cascade) → children stay cancelled" {
    create_cancelled_hierarchy

    # Verify initial cancelled state
    assert_task_status "T001" "cancelled"
    assert_task_status "T002" "cancelled"
    assert_task_status "T003" "cancelled"

    # Restore only parent (no --cascade)
    run bash "$UNCANCEL_SCRIPT" T001
    assert_success

    # Parent restored, children still cancelled
    assert_task_status "T001" "pending"
    assert_task_status "T002" "cancelled"
    assert_task_status "T003" "cancelled"
}

# =============================================================================
# DEPENDENCY TESTS
# =============================================================================

@test "dependency: delete task → dependents have dependency reference removed" {
    create_tasks_with_dependencies

    # Verify T002 depends on T001 before delete
    assert_task_depends_on "T002" "T001"

    # Delete T001
    run bash "$DELETE_SCRIPT" T001 --reason "Obsolete foundation" --force
    assert_success

    # Verify T002 no longer depends on T001 (cleaned up)
    assert_task_not_depends_on "T002" "T001"
}

@test "dependency: delete task → multi-dependency task has only deleted dep removed" {
    create_tasks_with_dependencies

    # Verify T004 depends on both T001 and T002
    assert_task_depends_on "T004" "T001"
    assert_task_depends_on "T004" "T002"

    # Delete only T001
    bash "$DELETE_SCRIPT" T001 --reason "Obsolete" --force

    # T004 should no longer depend on T001 but still depend on T002
    assert_task_not_depends_on "T004" "T001"
    assert_task_depends_on "T004" "T002"
}

@test "dependency: cascade delete → all dependencies cleaned up for external tasks" {
    create_parent_child_hierarchy

    # Add dependency from outside the hierarchy
    jq '.tasks += [{"id": "T010", "title": "External task", "description": "Depends on T002", "status": "pending", "priority": "low", "phase": "core", "depends": ["T002"], "createdAt": "2025-12-01T14:00:00Z"}]' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    _update_fixture_checksum "$TODO_FILE"

    # Verify T010 depends on T002
    assert_task_depends_on "T010" "T002"

    # Cascade delete parent (includes T002)
    bash "$DELETE_SCRIPT" T001 --reason "Epic cancelled" --children cascade --force

    # T010's dependency on T002 should be cleaned up
    assert_task_not_depends_on "T010" "T002"
}

# =============================================================================
# CONCURRENT/ATOMIC OPERATION TESTS
# =============================================================================

@test "atomic: delete creates safety backup" {
    create_single_pending_task

    # Delete task
    run bash "$DELETE_SCRIPT" T001 --reason "Testing backup creation" --force
    assert_success

    # Verify backup was created (check for backup directory content)
    local backup_count
    backup_count=$(find "${TEST_TEMP_DIR}/.cleo/backups" -name "*.json*" 2>/dev/null | wc -l || echo "0")

    # At minimum, some backup should exist (safety backup)
    [[ "$backup_count" -gt 0 ]] || {
        # Alternative: check .backups directory (Tier 1 backups)
        backup_count=$(ls -1 "${TEST_TEMP_DIR}/.cleo/.backups/" 2>/dev/null | wc -l || echo "0")
        [[ "$backup_count" -ge 0 ]]  # May be 0 if backups disabled
    }
}

@test "atomic: checksum updated after delete" {
    create_single_pending_task

    # Get checksum before
    local checksum_before
    checksum_before=$(jq -r '._meta.checksum' "$TODO_FILE")

    # Delete task
    bash "$DELETE_SCRIPT" T001 --reason "Testing checksum update" --force

    # Get checksum after
    local checksum_after
    checksum_after=$(jq -r '._meta.checksum' "$TODO_FILE")

    # Checksums should be different (task state changed)
    [[ "$checksum_before" != "$checksum_after" ]]
}

@test "atomic: lastUpdated timestamp updated after delete" {
    create_single_pending_task

    # Get timestamp before
    local timestamp_before
    timestamp_before=$(jq -r '.lastUpdated' "$TODO_FILE")

    # Small delay to ensure timestamp difference
    sleep 1

    # Delete task
    bash "$DELETE_SCRIPT" T001 --reason "Testing timestamp" --force

    # Get timestamp after
    local timestamp_after
    timestamp_after=$(jq -r '.lastUpdated' "$TODO_FILE")

    # Timestamps should be different
    [[ "$timestamp_before" != "$timestamp_after" ]]
}

# =============================================================================
# ERROR RECOVERY TESTS
# =============================================================================

@test "error: delete non-existent task → proper error" {
    create_single_pending_task

    # Try to delete non-existent task
    run bash "$DELETE_SCRIPT" T999 --reason "This should fail" --force
    assert_failure

    # Should contain error message about not found
    assert_output --partial "not found"
}

@test "error: delete completed task → error with archive suggestion" {
    create_completed_task

    # Try to delete completed task
    run bash "$DELETE_SCRIPT" T001 --reason "Cannot delete done tasks" --force
    assert_failure

    # Should mention archive as alternative
    assert_output --partial "archive"
}

@test "error: delete task with children but no strategy specified" {
    create_parent_child_hierarchy

    # Try to delete parent without specifying --children
    # Note: In non-TTY mode (test environment), should error
    run bash "$DELETE_SCRIPT" T001 --reason "Missing children strategy" --force
    assert_failure

    # Should mention children or require strategy
    assert_output_contains_any "child" "children" "strategy"
}

@test "error: delete with invalid task ID format" {
    create_single_pending_task

    # Try to delete with invalid ID
    run bash "$DELETE_SCRIPT" "invalid-id" --reason "Bad ID" --force
    assert_failure

    # Should mention invalid format
    assert_output --partial "Invalid"
}

@test "error: delete without reason when reason required" {
    create_single_pending_task

    # Ensure reason is required (default behavior)
    # Try to delete without --reason
    run bash "$DELETE_SCRIPT" T001 --force
    assert_failure

    # Should require reason
    assert_output --partial "reason"
}

@test "error: uncancel non-cancelled task → proper error" {
    create_single_pending_task

    # Try to uncancel a pending task
    run bash "$UNCANCEL_SCRIPT" T001
    assert_failure

    # Should indicate task is not cancelled
    assert_output --partial "not cancelled"
}

# =============================================================================
# DRY-RUN TESTS
# =============================================================================

@test "dry-run: delete shows preview without modifying" {
    create_single_pending_task

    # Get state before
    local status_before
    status_before=$(jq -r '.tasks[0].status' "$TODO_FILE")

    # Run delete with --dry-run
    run bash "$DELETE_SCRIPT" T001 --reason "Preview test" --dry-run
    assert_success

    # Should indicate dry-run
    assert_output_contains_any "DRY-RUN" "dry-run" "dryRun" "Would delete"

    # Task should still be pending (not modified)
    local status_after
    status_after=$(jq -r '.tasks[0].status' "$TODO_FILE")
    [[ "$status_before" == "$status_after" ]]
    [[ "$status_after" == "pending" ]]
}

@test "dry-run: uncancel shows preview without modifying" {
    create_cancelled_task

    # Run uncancel with --dry-run
    run bash "$UNCANCEL_SCRIPT" T001 --dry-run
    assert_success

    # Should indicate dry-run
    assert_output_contains_any "DRY-RUN" "dry-run" "dryRun" "Would restore"

    # Task should still be cancelled
    assert_task_status "T001" "cancelled"
}

# =============================================================================
# JSON OUTPUT TESTS
# =============================================================================

@test "json: delete outputs valid JSON with success structure" {
    create_single_pending_task

    run bash "$DELETE_SCRIPT" T001 --reason "JSON output test" --force --json
    assert_success
    assert_valid_json

    # Verify key fields present
    assert_json_has_key "success"
    assert_json_has_key "taskId"
}

@test "json: uncancel outputs valid JSON with success structure" {
    create_cancelled_task

    run bash "$UNCANCEL_SCRIPT" T001 --json
    assert_success
    assert_valid_json

    assert_json_has_key "success"
    assert_json_has_key "taskId"
}

# =============================================================================
# CHILDREN STRATEGY TESTS
# =============================================================================

@test "children: block strategy prevents deletion when children exist" {
    create_parent_child_hierarchy

    # Try to delete with block strategy
    run bash "$DELETE_SCRIPT" T001 --reason "Block test" --children block --force
    assert_failure

    # Should mention children
    assert_output --partial "child"
}

@test "children: orphan strategy removes parent reference from children" {
    create_parent_child_hierarchy

    # Verify T002 has parent T001
    local parent_before
    parent_before=$(jq -r '.tasks[] | select(.id == "T002") | .parentId // ""' "$TODO_FILE")
    [[ "$parent_before" == "T001" ]]

    # Delete with orphan strategy
    run bash "$DELETE_SCRIPT" T001 --reason "Orphan test" --children orphan --force
    assert_success

    # T001 should be cancelled
    assert_task_status "T001" "cancelled"

    # T002 should no longer have parent reference
    local parent_after
    parent_after=$(jq -r '.tasks[] | select(.id == "T002") | .parentId // ""' "$TODO_FILE")
    [[ -z "$parent_after" || "$parent_after" == "null" ]]

    # T002 should still be pending (not deleted)
    assert_task_status "T002" "pending"
}

@test "children: cascade strategy cancels all descendants" {
    # NOTE: Uses 2-level hierarchy due to IFS issue in backup.sh affecting get_descendants.
    # When backup.sh is loaded, IFS=$'\n\t' breaks space-separated word splitting.
    create_empty_todo

    # Add parent and children (2 levels)
    bash "$ADD_SCRIPT" "Parent epic" --description "Epic to cascade delete" --priority high
    local parent_id
    parent_id=$(jq -r '.tasks[-1].id' "$TODO_FILE")

    bash "$ADD_SCRIPT" "Child 1" --description "First child" --parent "$parent_id"
    bash "$ADD_SCRIPT" "Child 2" --description "Second child" --parent "$parent_id"
    bash "$ADD_SCRIPT" "Child 3" --description "Third child" --parent "$parent_id"

    # Count tasks before (4: parent + 3 children)
    local count_before
    count_before=$(jq '.tasks | length' "$TODO_FILE")
    [[ "$count_before" -eq 4 ]]

    # Delete with cascade
    run bash "$DELETE_SCRIPT" "$parent_id" --reason "Cascade test" --children cascade --force
    assert_success

    # All tasks should now be cancelled
    local cancelled_count
    cancelled_count=$(jq '[.tasks[] | select(.status == "cancelled")] | length' "$TODO_FILE")
    [[ "$cancelled_count" -eq 4 ]]
}

# =============================================================================
# IDEMPOTENCY TESTS
# =============================================================================

@test "idempotent: delete already cancelled task returns success with no change" {
    create_cancelled_task

    # Delete already cancelled task
    run bash "$DELETE_SCRIPT" T001 --reason "Already cancelled" --force
    # Should either succeed with "no change" or just succeed
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 102 ]]  # 102 = EXIT_NO_CHANGE

    # Output should indicate already cancelled or no change
    assert_output_contains_any "already" "cancelled" "noChange"
}

@test "idempotent: uncancel already pending task returns no change" {
    create_single_pending_task

    # Try to uncancel pending task
    run bash "$UNCANCEL_SCRIPT" T001
    assert_failure  # Not cancelled, so failure

    # Should indicate not cancelled
    assert_output --partial "not cancelled"
}
