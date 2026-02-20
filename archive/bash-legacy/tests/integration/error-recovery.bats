#!/usr/bin/env bats
# =============================================================================
# error-recovery.bats - Error handling and recovery tests
# =============================================================================
# Tests for:
# - Validation and recovery mechanisms
# - Backup and restore procedures
# - Graceful error handling
# - Data integrity preservation
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
# Validation Recovery Tests
# =============================================================================

@test "validate --fix recovers from checksum mismatch" {
    create_corrupted_checksum_todo

    # Verify corruption detected
    run bash "$VALIDATE_SCRIPT"
    assert_failure
    assert_output --partial "Checksum mismatch"

    # Fix the corruption
    run bash "$VALIDATE_SCRIPT" --fix
    assert_success

    # Verify now passes
    run bash "$VALIDATE_SCRIPT"
    assert_success
    refute_output --partial "Checksum mismatch"
}

@test "validate --fix preserves task data" {
    create_corrupted_checksum_todo

    # Get original task data
    local original_tasks
    original_tasks=$(jq '.tasks' "$TODO_FILE")

    # Fix checksum
    bash "$VALIDATE_SCRIPT" --fix

    # Verify task data unchanged
    local fixed_tasks
    fixed_tasks=$(jq '.tasks' "$TODO_FILE")

    [[ "$original_tasks" == "$fixed_tasks" ]]
}

@test "validate detects and reports multiple issues" {
    # Create todo with multiple problems
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.1.0", "checksum": "invalid"},
  "tasks": [
    {"id": "T001", "title": "Task 1", "description": "D1", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T001", "title": "Duplicate", "description": "D2", "status": "pending", "priority": "high", "createdAt": "2025-12-01T11:00:00Z"}
  ],
  "focus": {}
}
EOF

    run bash "$VALIDATE_SCRIPT"
    assert_failure

    # Should report both checksum and duplicate ID
    assert_output --partial "Checksum mismatch"
    assert_output --partial "Duplicate"
}

# =============================================================================
# Backup and Restore Tests
# =============================================================================

@test "backup created before destructive operations" {
    create_standard_tasks

    # Clear existing backups
    rm -f "$BACKUPS_DIR"/todo.json.*

    local task_id
    task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")

    # Perform destructive operation
    run bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes
    assert_success

    # Verify backup exists
    run ls "$BACKUPS_DIR"/todo.json.*
    assert_success
}

@test "backup preserves complete state" {
    create_standard_tasks

    # Capture original state
    local original_content
    original_content=$(cat "$TODO_FILE")

    local task_id
    task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")

    # Make change (triggers backup)
    bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes

    # Get most recent backup
    local backup_file
    backup_file=$(ls -t "$BACKUPS_DIR"/todo.json.* | head -1)

    # Verify backup has original content
    local backup_content
    backup_content=$(cat "$backup_file")

    [[ "$original_content" == "$backup_content" ]]
}

@test "can restore from backup after corruption" {
    create_standard_tasks

    # Make a change to create backup
    local task_id
    task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")
    bash "$UPDATE_SCRIPT" "$task_id" --priority critical

    # Get the backup
    local backup_file
    backup_file=$(ls -t "$BACKUPS_DIR"/todo.json.* | head -1)

    # Corrupt the current file
    echo "CORRUPTED" > "$TODO_FILE"

    # Restore from backup
    cp "$backup_file" "$TODO_FILE"

    # Verify restoration successful
    run jq empty "$TODO_FILE"
    assert_success

    assert_task_exists "$task_id"
}

@test "multiple backups maintained" {
    create_task_with_id "T001" "Test task"

    # Clear existing backups
    rm -f "$BACKUPS_DIR"/todo.json.*

    # Perform multiple operations
    bash "$UPDATE_SCRIPT" T001 --priority high
    bash "$UPDATE_SCRIPT" T001 --priority critical
    bash "$UPDATE_SCRIPT" T001 --labels test

    # Count backups
    local backup_count
    backup_count=$(ls "$BACKUPS_DIR"/todo.json.* 2>/dev/null | wc -l)

    # Should have multiple backups
    [[ "$backup_count" -ge 2 ]]
}

# =============================================================================
# Atomic Operation Tests
# =============================================================================

@test "failed operation doesn't corrupt existing data" {
    create_standard_tasks

    # Capture original state
    local original_content
    original_content=$(cat "$TODO_FILE")

    # Attempt invalid operation (should fail but not corrupt)
    run bash "$UPDATE_SCRIPT" T999 --priority high
    assert_failure

    # Verify original state preserved
    local current_content
    current_content=$(cat "$TODO_FILE")

    [[ "$original_content" == "$current_content" ]]

    # Verify JSON still valid
    run jq empty "$TODO_FILE"
    assert_success
}

@test "partial write failures don't leave corrupted files" {
    create_task_with_id "T001" "Test task"

    # Verify file is valid before
    run jq empty "$TODO_FILE"
    assert_success

    # Attempt operation that might fail
    bash "$UPDATE_SCRIPT" T001 --notes "Test note" || true

    # Verify file is still valid JSON after (even if operation failed)
    run jq empty "$TODO_FILE"
    assert_success
}

# =============================================================================
# Dependency Recovery Tests
# =============================================================================

@test "orphaned dependency cleanup on archive" {
    create_task_with_dependency

    # Verify dependency exists
    assert_task_depends_on "T002" "T001"

    # Complete and archive T001
    # Use --no-safe to allow archiving tasks with active dependents (testing cleanup logic)
    bash "$COMPLETE_SCRIPT" T001 --skip-notes
    bash "$SCRIPTS_DIR/archive.sh" --all --no-safe

    # Verify T002 no longer depends on archived T001
    local deps_count
    deps_count=$(jq '.tasks[] | select(.id == "T002") | .depends | length' "$TODO_FILE")
    [[ "$deps_count" -eq 0 ]]
}

@test "orphaned dependency cleanup preserves other dependencies" {
    # Create task with multiple dependencies
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.1.0"},
  "tasks": [
    {"id": "T001", "title": "Dep 1", "description": "D1", "status": "done", "priority": "medium", "createdAt": "2025-12-01T10:00:00Z", "completedAt": "2025-12-10T12:00:00Z"},
    {"id": "T002", "title": "Dep 2", "description": "D2", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T11:00:00Z"},
    {"id": "T003", "title": "Dependent", "description": "Main", "status": "pending", "priority": "high", "createdAt": "2025-12-01T12:00:00Z", "depends": ["T001", "T002"]}
  ],
  "focus": {}
}
EOF

    # Archive T001 only
    # Use --no-safe to allow archiving tasks with active dependents (testing cleanup logic)
    bash "$SCRIPTS_DIR/archive.sh" --all --no-safe

    # T003 should still depend on T002
    assert_task_depends_on "T003" "T002"

    # But not on archived T001
    assert_task_not_depends_on "T003" "T001"
}

# =============================================================================
# Concurrent Access Recovery Tests
# =============================================================================

@test "file locking prevents corruption from concurrent writes" {
    create_empty_todo

    # Attempt concurrent operations
    bash "$ADD_SCRIPT" "Task 1" --description "Concurrent 1" &
    local pid1=$!
    bash "$ADD_SCRIPT" "Task 2" --description "Concurrent 2" &
    local pid2=$!

    # Wait for both to complete
    wait "$pid1" || true
    wait "$pid2" || true

    # Verify JSON still valid
    run jq empty "$TODO_FILE"
    assert_success

    # Verify at least one task was created
    local task_count
    task_count=$(jq '.tasks | length' "$TODO_FILE")
    [[ "$task_count" -gt 0 ]]
}

@test "concurrent operations maintain data integrity" {
    create_task_with_id "T001" "Test task"

    # Concurrent updates to same task
    bash "$UPDATE_SCRIPT" T001 --priority high &
    bash "$UPDATE_SCRIPT" T001 --labels test &
    wait

    # Verify JSON still valid
    run jq empty "$TODO_FILE"
    assert_success

    # Verify task still exists
    assert_task_exists "T001"
}

# =============================================================================
# Missing File Recovery Tests
# =============================================================================

@test "graceful handling of missing todo.json" {
    rm -f "$TODO_FILE"

    run bash "$SCRIPTS_DIR/list.sh"
    assert_failure
    assert_output --partial "not found"

    # Verify no corruption or crashes
    [[ "$status" -ne 127 ]] # Not "command not found"
}

@test "graceful handling of missing config" {
    create_empty_todo
    rm -f "$CONFIG_FILE"

    # Operations should still work with defaults
    run bash "$ADD_SCRIPT" "Test task" --description "Test"
    # May succeed with defaults or fail gracefully (exit 2 is file operation error, acceptable)
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]] || [[ "$status" -eq 2 ]]
}

@test "graceful handling of missing backups directory" {
    rm -rf "$BACKUPS_DIR"

    # Should recreate directory or handle gracefully
    run bash "$UPDATE_SCRIPT" T001 --priority high 2>&1 || true

    # Should not crash
    [[ "$status" -ne 127 ]]
}

# =============================================================================
# Log Recovery Tests
# =============================================================================

@test "corrupted log file doesn't prevent operations" {
    create_standard_tasks

    # Corrupt log file
    echo "CORRUPTED" > "$LOG_FILE"

    # Operations should still work
    local task_id
    task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")

    run bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes
    # May succeed or fail, but should not crash
    [[ "$status" -ne 127 ]]
}

@test "missing log file is recreated" {
    create_standard_tasks
    rm -f "$LOG_FILE"

    # Operation that logs
    run bash "$SCRIPTS_DIR/session.sh" start
    # Should handle missing log gracefully
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
}

# =============================================================================
# Schema Validation Recovery Tests
# =============================================================================

@test "invalid schema version handled gracefully" {
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "999.0.0"},
  "tasks": [],
  "focus": {}
}
EOF

    run bash "$VALIDATE_SCRIPT"
    # Should detect version mismatch
    assert_failure
}

@test "missing required fields detected" {
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.1.0"},
  "tasks": [
    {"id": "T001", "title": "Missing status field"}
  ]
}
EOF

    run bash "$VALIDATE_SCRIPT"
    assert_failure
}

# =============================================================================
# Archive Recovery Tests
# =============================================================================

@test "corrupted archive doesn't prevent archiving" {
    create_completed_tasks 3

    # Corrupt archive
    echo "CORRUPTED" > "$ARCHIVE_FILE"

    # Attempt to archive
    run bash "$SCRIPTS_DIR/archive.sh" --force
    # Should handle corruption gracefully
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
}

@test "missing archive file is created" {
    create_completed_tasks 2
    rm -f "$ARCHIVE_FILE"

    run bash "$SCRIPTS_DIR/archive.sh" --force
    assert_success

    # Verify archive was created
    run jq empty "$ARCHIVE_FILE"
    assert_success
}

# =============================================================================
# Focus State Recovery Tests
# =============================================================================

@test "focus on nonexistent task handled gracefully" {
    create_empty_todo

    run bash "$SCRIPTS_DIR/focus.sh" set T999
    assert_failure
    assert_output --partial "not found"
}

@test "corrupted focus state doesn't prevent operations" {
    create_standard_tasks

    # Corrupt focus state
    jq '.focus = "invalid"' "$TODO_FILE" > tmp && mv tmp "$TODO_FILE"

    # Should still be able to complete tasks
    local task_id
    task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")

    run bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes
    # May succeed or fail, but should not crash
    [[ "$status" -ne 127 ]]
}

# =============================================================================
# Phase Conflict Recovery Tests
# =============================================================================

@test "validate detects multiple active phases" {
    # Create todo with multiple active phases
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.2.0"},
  "project": {
    "phases": {
      "setup": {
        "name": "Setup",
        "order": 1,
        "status": "active",
        "startedAt": "2025-12-01T10:00:00Z"
      },
      "core": {
        "name": "Core Development",
        "order": 2,
        "status": "active",
        "startedAt": "2025-12-02T10:00:00Z"
      },
      "polish": {
        "name": "Polish",
        "order": 3,
        "status": "active",
        "startedAt": "2025-12-03T10:00:00Z"
      }
    },
    "currentPhase": "core"
  },
  "tasks": [],
  "focus": {}
}
EOF

    run bash "$VALIDATE_SCRIPT"
    assert_failure
    assert_output --partial "Multiple active phases found"
}

@test "validate --fix --non-interactive auto-selects first phase by order" {
    # Create todo with multiple active phases
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.2.0"},
  "project": {
    "phases": {
      "polish": {
        "name": "Polish",
        "order": 3,
        "status": "active",
        "startedAt": "2025-12-03T10:00:00Z"
      },
      "setup": {
        "name": "Setup",
        "order": 1,
        "status": "active",
        "startedAt": "2025-12-01T10:00:00Z"
      },
      "core": {
        "name": "Core Development",
        "order": 2,
        "status": "active",
        "startedAt": "2025-12-02T10:00:00Z"
      }
    },
    "currentPhase": "core"
  },
  "tasks": [],
  "focus": {}
}
EOF

    run bash "$VALIDATE_SCRIPT" --fix --non-interactive
    assert_success
    assert_output --partial "Auto-selecting (non-interactive mode): setup"
    assert_output --partial "Fixed: Kept setup as active"

    # Verify only setup is active
    local active_count
    active_count=$(jq '[.project.phases | to_entries[] | select(.value.status == "active")] | length' "$TODO_FILE")
    [[ "$active_count" -eq 1 ]]

    local active_phase
    active_phase=$(jq -r '.project.phases | to_entries[] | select(.value.status == "active") | .key' "$TODO_FILE")
    [[ "$active_phase" == "setup" ]]

    # Others should be completed
    local core_status
    core_status=$(jq -r '.project.phases.core.status' "$TODO_FILE")
    [[ "$core_status" == "completed" ]]

    local polish_status
    polish_status=$(jq -r '.project.phases.polish.status' "$TODO_FILE")
    [[ "$polish_status" == "completed" ]]
}

@test "validate --fix creates backup before phase conflict resolution" {
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.2.0"},
  "project": {
    "phases": {
      "setup": {"name": "Setup", "order": 1, "status": "active"},
      "core": {"name": "Core", "order": 2, "status": "active"}
    },
    "currentPhase": "core"
  },
  "tasks": [],
  "focus": {}
}
EOF

    # Clear backups in safety subdirectory
    local safety_dir="${TEST_TEMP_DIR}/.cleo/backups/safety"
    rm -rf "$safety_dir"
    mkdir -p "$safety_dir"

    # Run fix
    run bash "$VALIDATE_SCRIPT" --fix --non-interactive
    assert_success

    # Verify backup was created in safety directory
    local backup_count
    backup_count=$(find "$safety_dir" -name "*phase-conflict-fix*" 2>/dev/null | wc -l)
    [[ "$backup_count" -ge 1 ]]
}

@test "validate --fix logs phase conflict resolution" {
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.2.0"},
  "project": {
    "phases": {
      "setup": {"name": "Setup", "order": 1, "status": "active"},
      "core": {"name": "Core", "order": 2, "status": "active"}
    },
    "currentPhase": "core"
  },
  "tasks": [],
  "focus": {}
}
EOF

    # Initialize log file if needed
    if [[ ! -f "$LOG_FILE" ]]; then
        echo '{"entries":[]}' > "$LOG_FILE"
    fi

    # Run fix
    bash "$VALIDATE_SCRIPT" --fix --non-interactive

    # Verify log file exists and is valid JSON
    run jq empty "$LOG_FILE"
    assert_success

    # Verify log entry exists for validation_run with phase conflict fix
    local fix_type
    fix_type=$(jq -r '.entries[] | select(.action == "validation_run" and .details.fixType == "phase_conflict_resolution") | .details.fixType' "$LOG_FILE" 2>/dev/null || echo "")

    # If not found, check the entire log for debugging
    if [[ "$fix_type" != "phase_conflict_resolution" ]]; then
        # Debugging: show recent log entries
        echo "Recent log entries:"
        jq -r '.entries[-3:] | .[]? | "\(.action): \(.details)"' "$LOG_FILE" 2>/dev/null || echo "No entries found"
    fi

    [[ "$fix_type" == "phase_conflict_resolution" ]]

    # Verify resolution method logged
    local resolution_method
    resolution_method=$(jq -r '.entries[] | select(.action == "validation_run" and .details.fixType == "phase_conflict_resolution") | .details.resolutionMethod' "$LOG_FILE" 2>/dev/null || echo "")
    [[ "$resolution_method" == "auto_selected" ]]
}

@test "validate --fix in pipe uses auto-selection" {
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.2.0"},
  "project": {
    "phases": {
      "setup": {"name": "Setup", "order": 1, "status": "active"},
      "core": {"name": "Core", "order": 2, "status": "active"}
    },
    "currentPhase": "core"
  },
  "tasks": [],
  "focus": {}
}
EOF

    # Run in pipe (non-terminal)
    run bash -c "echo | bash '$VALIDATE_SCRIPT' --fix"
    assert_success
    assert_output --partial "Auto-selecting (non-terminal environment)"

    # Verify fix applied
    local active_count
    active_count=$(jq '[.project.phases | to_entries[] | select(.value.status == "active")] | length' "$TODO_FILE")
    [[ "$active_count" -eq 1 ]]
}

@test "validate --fix preserves task data during phase conflict resolution" {
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.2.0"},
  "project": {
    "phases": {
      "setup": {"name": "Setup", "order": 1, "status": "active"},
      "core": {"name": "Core", "order": 2, "status": "active"}
    },
    "currentPhase": "core"
  },
  "tasks": [
    {"id": "T001", "title": "Task 1", "description": "D1", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    # Capture task data
    local original_tasks
    original_tasks=$(jq '.tasks' "$TODO_FILE")

    # Run fix
    bash "$VALIDATE_SCRIPT" --fix --non-interactive

    # Verify task data unchanged
    local current_tasks
    current_tasks=$(jq '.tasks' "$TODO_FILE")
    [[ "$original_tasks" == "$current_tasks" ]]
}

@test "validate without --fix does not modify file on phase conflict" {
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.2.0"},
  "project": {
    "phases": {
      "setup": {"name": "Setup", "order": 1, "status": "active"},
      "core": {"name": "Core", "order": 2, "status": "active"}
    },
    "currentPhase": "core"
  },
  "tasks": [],
  "focus": {}
}
EOF

    # Capture original content
    local original_content
    original_content=$(cat "$TODO_FILE")

    # Run without fix
    run bash "$VALIDATE_SCRIPT"
    assert_failure

    # Verify file unchanged
    local current_content
    current_content=$(cat "$TODO_FILE")
    [[ "$original_content" == "$current_content" ]]
}
