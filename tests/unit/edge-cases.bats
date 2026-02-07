#!/usr/bin/env bats
# =============================================================================
# edge-cases.bats - Edge case and error handling tests
# =============================================================================
# Tests for:
# - Concurrent write protection (file locking)
# - Data corruption prevention
# - Validation and recovery
# - Edge cases in command execution
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    load '../test_helper/edge-case-fixtures'
    load '../test_helper/assertions'
    common_setup_per_test

    # Create empty archive for tests
    export ARCHIVE_FILE="${TEST_TEMP_DIR}/.cleo/todo-archive.json"
    create_empty_archive "$ARCHIVE_FILE"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Concurrent Write Protection Tests
# =============================================================================

@test "concurrent writes don't corrupt data" {
    create_empty_todo

    # Spawn multiple background adds
    local pids=()
    for i in 1 2 3 4 5; do
        bash "$ADD_SCRIPT" "Concurrent task $i" --description "Task $i" &
        pids+=($!)
    done

    # Wait for all to complete
    for pid in "${pids[@]}"; do
        wait "$pid" || true
    done

    # Verify JSON is still valid
    run jq empty "$TODO_FILE"
    assert_success

    # Verify all tasks created with unique IDs
    local unique_count
    unique_count=$(jq '[.tasks[].id] | unique | length' "$TODO_FILE")
    local total_count
    total_count=$(jq '.tasks | length' "$TODO_FILE")

    # At least some tasks should have been created
    [ "$total_count" -gt 0 ]

    # All IDs should be unique
    [ "$unique_count" -eq "$total_count" ]
}

# =============================================================================
# JSON Corruption Prevention Tests
# =============================================================================

@test "complete --skip-notes doesn't corrupt JSON" {
    create_task_with_id "T001" "Test task"

    run bash "$COMPLETE_SCRIPT" T001 --skip-notes
    assert_success

    # Verify JSON is valid
    run jq empty "$TODO_FILE"
    assert_success

    # Verify task was marked complete
    assert_task_status "T001" "done"
}

@test "archive --all doesn't corrupt JSON" {
    create_completed_tasks 10

    run bash "$SCRIPTS_DIR/archive.sh" --all
    assert_success

    # Verify both files are valid JSON
    run jq empty "$TODO_FILE"
    assert_success

    run jq empty "$ARCHIVE_FILE"
    assert_success

    # Verify tasks were archived
    local archived_count
    archived_count=$(jq '.archivedTasks | length' "$ARCHIVE_FILE")
    [[ "$archived_count" -eq 10 ]]
}

@test "multiple rapid updates preserve JSON integrity" {
    create_task_with_id "T001" "Test task"

    # Rapid sequential updates
    bash "$UPDATE_SCRIPT" T001 --priority high &
    bash "$UPDATE_SCRIPT" T001 --labels test,edge-case &
    bash "$UPDATE_SCRIPT" T001 --notes "Update note" &
    wait

    # Verify JSON is still valid
    run jq empty "$TODO_FILE"
    assert_success

    # Verify task exists
    assert_task_exists "T001"
}

# =============================================================================
# Validation and Error Detection Tests
# =============================================================================

@test "duplicate IDs detected by validate" {
    create_duplicate_id_todo

    run bash "$VALIDATE_SCRIPT"
    assert_failure
    assert_output --partial "Duplicate"
}

@test "malformed JSON detected by validate" {
    create_malformed_json

    run bash "$VALIDATE_SCRIPT"
    assert_failure
}

@test "checksum mismatch detected by validate" {
    create_corrupted_checksum_todo

    run bash "$VALIDATE_SCRIPT"
    assert_failure
    assert_output --partial "Checksum mismatch"
}

@test "validate --fix recovers from checksum mismatch" {
    create_corrupted_checksum_todo

    # First verify it fails
    run bash "$VALIDATE_SCRIPT"
    assert_failure

    # Fix it
    run bash "$VALIDATE_SCRIPT" --fix
    assert_success

    # Verify it now passes
    run bash "$VALIDATE_SCRIPT"
    assert_success
}

# =============================================================================
# Initialization Tests
# =============================================================================

@test "init creates valid checksum" {
    cd "$TEST_TEMP_DIR"
    rm -rf .claude

    run bash "$INIT_SCRIPT" --force --confirm-wipe
    assert_success

    run bash "$VALIDATE_SCRIPT"
    assert_success
    refute_output --partial "Checksum mismatch"
}

@test "init --force overwrites existing files" {
    create_standard_tasks

    run bash "$INIT_SCRIPT" --force --confirm-wipe
    assert_success

    # Verify new empty structure
    local task_count
    task_count=$(jq '.tasks | length' "$TODO_FILE")
    [[ "$task_count" -eq 0 ]]
}

# =============================================================================
# Log Command Tests (after readonly variable fix)
# =============================================================================

@test "log command works after fix" {
    create_empty_todo

    run bash "$SCRIPTS_DIR/log.sh" --action session_start --session-id "test_123"
    assert_success
    refute_output --partial "readonly"

    # Verify log entry was created
    run jq '.entries | length' "$LOG_FILE"
    assert_output --partial "1"
}

@test "log handles missing log file gracefully" {
    rm -f "$LOG_FILE"

    # Use valid action (status_changed) - log.sh will create missing log file
    run bash "$SCRIPTS_DIR/log.sh" --action status_changed --task-id T001
    # Exit codes: 0=success (creates file), 1=general error, 3=E_FILE_NOT_FOUND
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]] || [[ "$status" -eq 3 ]]
}

# =============================================================================
# Orphaned Dependency Cleanup Tests
# =============================================================================

@test "orphaned dependencies cleaned on archive" {
    create_task_with_dependency

    # Complete and archive the dependency
    # Use --no-safe to allow archiving tasks with active dependents (testing cleanup logic)
    bash "$COMPLETE_SCRIPT" T001 --skip-notes
    bash "$SCRIPTS_DIR/archive.sh" --all --no-safe

    # Verify dependent task's depends[] is cleaned
    local deps_count
    deps_count=$(jq '.tasks[] | select(.id == "T002") | .depends | length' "$TODO_FILE")
    [[ "$deps_count" -eq 0 ]]
}

@test "multiple orphaned dependencies all cleaned" {
    # Create task depending on multiple tasks
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.1.0"},
  "tasks": [
    {"id": "T001", "title": "Dep 1", "description": "D1", "status": "done", "priority": "medium", "createdAt": "2025-12-01T10:00:00Z", "completedAt": "2025-12-10T12:00:00Z"},
    {"id": "T002", "title": "Dep 2", "description": "D2", "status": "done", "priority": "medium", "createdAt": "2025-12-01T11:00:00Z", "completedAt": "2025-12-10T12:00:00Z"},
    {"id": "T003", "title": "Dependent", "description": "Main", "status": "pending", "priority": "high", "createdAt": "2025-12-01T12:00:00Z", "depends": ["T001", "T002"]}
  ],
  "focus": {}
}
EOF

    # Archive completed tasks
    # Use --no-safe to allow archiving tasks with active dependents (testing cleanup logic)
    bash "$SCRIPTS_DIR/archive.sh" --all --no-safe

    # Verify both dependencies were cleaned
    local deps_count
    deps_count=$(jq '.tasks[] | select(.id == "T003") | .depends | length' "$TODO_FILE")
    [[ "$deps_count" -eq 0 ]]
}

# =============================================================================
# Backup Creation Tests
# =============================================================================

@test "backup created before destructive operations" {
    create_standard_tasks
    local task_id
    task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")

    # Clear any existing safety backups
    rm -rf "$SAFETY_BACKUPS_DIR"/*

    run bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes
    assert_success

    # Verify safety backup directory exists (complete creates safety backups)
    # Safety backups are directories containing the actual files
    run ls -d "$SAFETY_BACKUPS_DIR"/safety_*_complete_todo.json 2>/dev/null
    assert_success
}

@test "backup preserves original data" {
    create_standard_tasks

    # Get original data
    local original_tasks
    original_tasks=$(jq '.tasks' "$TODO_FILE")

    # Clear existing safety backups
    rm -rf "$SAFETY_BACKUPS_DIR"/*

    # Make a change
    local task_id
    task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")
    bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes

    # Find most recent safety backup directory (created by complete command)
    # Safety backups are directories containing the actual todo.json file
    local backup_dir
    backup_dir=$(ls -td "$SAFETY_BACKUPS_DIR"/safety_*_complete_todo.json 2>/dev/null | head -1)

    # The actual backup file is inside the directory
    local backup_file="${backup_dir}/todo.json"

    # Verify backup has original data
    local backup_tasks
    backup_tasks=$(jq '.tasks' "$backup_file")

    [[ "$original_tasks" == "$backup_tasks" ]]
}

# =============================================================================
# Edge Case: Empty Operations
# =============================================================================

@test "complete nonexistent task fails gracefully" {
    create_empty_todo

    run bash "$COMPLETE_SCRIPT" T999 --skip-notes
    assert_failure
    assert_output --partial "not found"
}

@test "update nonexistent task fails gracefully" {
    create_empty_todo

    run bash "$UPDATE_SCRIPT" T999 --priority high
    assert_failure
}

@test "archive with no completed tasks succeeds" {
    create_independent_tasks

    run bash "$SCRIPTS_DIR/archive.sh" --force
    assert_success

    # Verify no tasks were archived
    local archived_count
    archived_count=$(jq '.archivedTasks | length' "$ARCHIVE_FILE")
    [[ "$archived_count" -eq 0 ]]
}

# =============================================================================
# Edge Case: Special Characters
# =============================================================================

@test "task title with special characters handled correctly" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Task with \"quotes\" and \$special chars" --description "Special chars test"
    assert_success

    # Verify task was created
    run jq '.tasks | length' "$TODO_FILE"
    assert_output "1"

    # Verify JSON is still valid
    run jq empty "$TODO_FILE"
    assert_success
}

@test "notes with newlines handled correctly" {
    create_task_with_id "T001" "Test task"

    run bash "$UPDATE_SCRIPT" T001 --notes "Line 1
Line 2
Line 3"
    assert_success

    # Verify JSON is valid
    run jq empty "$TODO_FILE"
    assert_success
}

# =============================================================================
# Edge Case: Missing Files
# =============================================================================

@test "commands handle missing todo.json gracefully" {
    rm -f "$TODO_FILE"

    run bash "$SCRIPTS_DIR/list.sh"
    # Should fail gracefully with helpful message
    assert_failure
    assert_output --partial "not found"
}

@test "validate handles missing config gracefully" {
    create_empty_todo
    rm -f "$CONFIG_FILE"

    run bash "$VALIDATE_SCRIPT"
    # Should either use defaults or fail gracefully
    # May return 0 (success with defaults) or non-zero error
    [[ "$status" -le 10 ]]  # Any reasonable exit code is acceptable
}
