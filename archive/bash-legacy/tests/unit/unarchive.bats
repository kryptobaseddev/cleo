#!/usr/bin/env bats
# =============================================================================
# unarchive.bats - Unit tests for unarchive command (T447/T429)
# =============================================================================
# Tests the unarchive functionality for restoring archived tasks back to
# todo.json, including status handling and metadata cleanup.
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

    # Set up script path for unarchive
    export UNARCHIVE_SCRIPT="${SCRIPTS_DIR}/unarchive.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper: Create archive with tasks
# =============================================================================

create_archive_with_tasks() {
    local dest="${1:-$ARCHIVE_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": "test-project",
  "_meta": {"totalArchived": 3, "lastArchived": "2025-12-15T10:00:00Z"},
  "archivedTasks": [
    {
      "id": "T001",
      "title": "Archived task 1",
      "description": "First archived",
      "status": "done",
      "priority": "high",
      "phase": "setup",
      "createdAt": "2025-11-01T10:00:00Z",
      "completedAt": "2025-11-10T10:00:00Z",
      "_archive": {
        "archivedAt": "2025-12-01T10:00:00Z",
        "reason": "auto",
        "archiveSource": "auto",
        "sessionId": "session-123",
        "cycleTimeDays": 9,
        "relationshipState": {"hadChildren": false, "childIds": [], "hadDependents": false, "dependentIds": [], "parentId": null},
        "restoreInfo": {"originalStatus": "done", "canRestore": true, "restoreBlockers": []}
      }
    },
    {
      "id": "T002",
      "title": "Archived task 2",
      "description": "Second archived",
      "status": "done",
      "priority": "medium",
      "phase": "core",
      "labels": ["feature"],
      "createdAt": "2025-11-05T10:00:00Z",
      "completedAt": "2025-11-15T10:00:00Z",
      "_archive": {
        "archivedAt": "2025-12-05T10:00:00Z",
        "reason": "manual",
        "archiveSource": "manual",
        "sessionId": "session-456",
        "cycleTimeDays": 10,
        "relationshipState": {"hadChildren": false, "childIds": [], "hadDependents": false, "dependentIds": [], "parentId": null},
        "restoreInfo": {"originalStatus": "done", "canRestore": true, "restoreBlockers": []}
      }
    },
    {
      "id": "T003",
      "title": "Archived task 3",
      "description": "Third archived",
      "status": "done",
      "priority": "low",
      "phase": "testing",
      "createdAt": "2025-11-10T10:00:00Z",
      "completedAt": "2025-11-20T10:00:00Z",
      "_archive": {
        "archivedAt": "2025-12-10T10:00:00Z",
        "reason": "force",
        "archiveSource": "force",
        "sessionId": "session-789"
      }
    }
  ],
  "phaseSummary": {},
  "statistics": {"byPhase": {}, "byPriority": {}, "byLabel": {}}
}
EOF
}

# =============================================================================
# Script Presence Tests
# =============================================================================

@test "unarchive script exists" {
    [ -f "$UNARCHIVE_SCRIPT" ]
}

@test "unarchive script is executable" {
    [ -x "$UNARCHIVE_SCRIPT" ]
}

# =============================================================================
# Help and Usage Tests
# =============================================================================

@test "unarchive --help shows usage" {
    run bash "$UNARCHIVE_SCRIPT" --help
    assert_success
    assert_output --partial "Usage:"
    assert_output_contains_any "unarchive" "restore"
}

@test "unarchive -h shows usage" {
    run bash "$UNARCHIVE_SCRIPT" -h
    assert_success
    assert_output --partial "Usage:"
}

@test "unarchive with no arguments shows error" {
    create_empty_todo
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT"
    assert_failure

    # Should show error about missing task ID
    assert_output_contains_any "required" "task ID" "TASK_ID"
}

# =============================================================================
# Basic Restore Tests
# =============================================================================

@test "unarchive restores task to todo.json" {
    create_empty_todo
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT" T001 --json
    assert_success

    # Check task is in todo.json
    local task_exists
    task_exists=$(jq '.tasks[] | select(.id == "T001") | .id' "$TODO_FILE")
    [ "$task_exists" = '"T001"' ]
}

@test "unarchive removes task from archive" {
    create_empty_todo
    create_archive_with_tasks

    bash "$UNARCHIVE_SCRIPT" T001

    # Check task is NOT in archive
    local task_in_archive
    task_in_archive=$(jq '[.archivedTasks[] | select(.id == "T001")] | length' "$ARCHIVE_FILE")
    [ "$task_in_archive" -eq 0 ]
}

@test "unarchive removes _archive metadata" {
    create_empty_todo
    create_archive_with_tasks

    bash "$UNARCHIVE_SCRIPT" T001

    # Check _archive field is removed
    local has_archive
    has_archive=$(jq '.tasks[] | select(.id == "T001") | has("_archive")' "$TODO_FILE")
    [ "$has_archive" = "false" ]
}

@test "unarchive can restore multiple tasks" {
    create_empty_todo
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT" T001 T002 --json
    assert_success

    local restored_count
    restored_count=$(echo "$output" | jq '.restored.count')
    [ "$restored_count" -eq 2 ]

    # Both tasks should be in todo.json
    local count_in_todo
    count_in_todo=$(jq '.tasks | length' "$TODO_FILE")
    [ "$count_in_todo" -eq 2 ]
}

# =============================================================================
# Status Handling Tests
# =============================================================================

@test "unarchive --status sets status on restore" {
    create_empty_todo
    create_archive_with_tasks

    bash "$UNARCHIVE_SCRIPT" T001 --status active

    local status
    status=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    [ "$status" = "active" ]
}

@test "unarchive defaults to pending status" {
    create_empty_todo
    create_archive_with_tasks

    bash "$UNARCHIVE_SCRIPT" T001

    local status
    status=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    [ "$status" = "pending" ]
}

@test "unarchive --preserve-status keeps original status" {
    create_empty_todo
    create_archive_with_tasks

    # Note: original status was "done", but --preserve-status should convert done to pending
    # since we're reopening the task
    bash "$UNARCHIVE_SCRIPT" T001 --preserve-status

    # Status should be pending (since original was done, and done -> pending on reopen)
    local status
    status=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    [ "$status" = "pending" ]
}

@test "unarchive --status blocked works" {
    create_empty_todo
    create_archive_with_tasks

    bash "$UNARCHIVE_SCRIPT" T001 --status blocked

    local status
    status=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    [ "$status" = "blocked" ]
}

@test "unarchive --status done is rejected" {
    create_empty_todo
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT" T001 --status done
    assert_failure

    # Should show error about invalid status
    assert_output_contains_any "Cannot restore" "done" "invalid"
}

@test "unarchive --status and --preserve-status conflict" {
    create_empty_todo
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT" T001 --status active --preserve-status
    assert_failure

    assert_output_contains_any "cannot be used together" "conflict"
}

# =============================================================================
# Dry Run Tests
# =============================================================================

@test "unarchive --dry-run previews changes" {
    create_empty_todo
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT" T001 --dry-run --json
    assert_success

    local dry_run
    dry_run=$(echo "$output" | jq '.dryRun')
    [ "$dry_run" = "true" ]
}

@test "unarchive --dry-run does not modify files" {
    create_empty_todo
    create_archive_with_tasks

    local before_todo before_archive
    before_todo=$(cat "$TODO_FILE")
    before_archive=$(cat "$ARCHIVE_FILE")

    bash "$UNARCHIVE_SCRIPT" T001 --dry-run

    local after_todo after_archive
    after_todo=$(cat "$TODO_FILE")
    after_archive=$(cat "$ARCHIVE_FILE")

    [ "$before_todo" = "$after_todo" ]
    [ "$before_archive" = "$after_archive" ]
}

@test "unarchive --dry-run shows preview in text output" {
    create_empty_todo
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT" T001 --dry-run
    assert_success

    assert_output_contains_any "DRY RUN" "Would restore" "preview"
}

# =============================================================================
# Error Handling Tests
# =============================================================================

@test "unarchive handles missing archive file" {
    create_empty_todo
    rm -f "$ARCHIVE_FILE"

    run bash "$UNARCHIVE_SCRIPT" T001
    assert_failure

    assert_output_contains_any "not found" "archive"
}

@test "unarchive handles task not in archive" {
    create_empty_todo
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT" T999 --json
    assert_failure

    assert_output_contains_any "not found" "T999"
}

@test "unarchive handles partial matches (some found, some not)" {
    create_empty_todo
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT" T001 T999 --json
    assert_success

    # T001 should be restored
    local restored_count
    restored_count=$(echo "$output" | jq '.restored.count')
    [ "$restored_count" -eq 1 ]

    # T999 should be in missing list
    local missing_count
    missing_count=$(echo "$output" | jq '.missing.count')
    [ "$missing_count" -eq 1 ]
}

@test "unarchive handles ID collision with existing task" {
    # Create todo with existing T001
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Existing task", "description": "Already here", "status": "pending", "priority": "high", "createdAt": "2025-12-01T10:00:00Z"}
  ],
  "focus": {}
}
EOF
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT" T001 --json
    # This is the idempotent case - task already exists
    # Should report as already active, not error
    [ "$status" -eq 0 ] || [ "$status" -eq 102 ]  # 0 or EXIT_NO_CHANGE
}

# =============================================================================
# Idempotency Tests
# =============================================================================

@test "unarchive is idempotent for already-active tasks" {
    # Create todo with T001 already active
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Already active", "description": "Not in archive", "status": "active", "priority": "high", "createdAt": "2025-12-01T10:00:00Z"}
  ],
  "focus": {}
}
EOF
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT" T001 --json
    # Should indicate no change needed
    [ "$status" -eq 0 ] || [ "$status" -eq 102 ]

    # Check noChange or tasksAlreadyActive in output
    local no_change
    no_change=$(echo "$output" | jq '.noChange // .skipped.count')
    [ "$no_change" = "true" ] || [ "$no_change" = "1" ]
}

# =============================================================================
# JSON Output Tests
# =============================================================================

@test "unarchive JSON output has correct structure" {
    create_empty_todo
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT" T001 --json
    assert_success

    # Check required fields
    echo "$output" | jq -e '.success' >/dev/null
    echo "$output" | jq -e '.restored' >/dev/null
    echo "$output" | jq -e '.restored.count' >/dev/null
    echo "$output" | jq -e '.restored.taskIds' >/dev/null
    echo "$output" | jq -e '.remaining' >/dev/null
}

@test "unarchive JSON shows restored status" {
    create_empty_todo
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT" T001 --status active --json
    assert_success

    local restored_status
    restored_status=$(echo "$output" | jq -r '.restored.status')
    [ "$restored_status" = "active" ]
}

@test "unarchive JSON shows remaining counts" {
    create_empty_todo
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT" T001 --json
    assert_success

    # Should show remaining in archive (was 3, now 2)
    local remaining_archived
    remaining_archived=$(echo "$output" | jq '.remaining.archived')
    [ "$remaining_archived" -eq 2 ]

    # Should show todo count (now 1)
    local todo_total
    todo_total=$(echo "$output" | jq '.remaining.todo')
    [ "$todo_total" -eq 1 ]
}

# =============================================================================
# Text Output Tests
# =============================================================================

@test "unarchive text output shows restored tasks" {
    create_empty_todo
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT" T001
    assert_success

    assert_output_contains_any "Restored" "T001"
}

@test "unarchive --human forces text output" {
    create_empty_todo
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT" T001 --human
    assert_success

    # Should NOT be JSON
    ! echo "$output" | jq . >/dev/null 2>&1 || \
        assert_output_contains_any "Restored" "INFO"
}

# =============================================================================
# Clears completedAt Tests
# =============================================================================

@test "unarchive clears completedAt timestamp" {
    create_empty_todo
    create_archive_with_tasks

    bash "$UNARCHIVE_SCRIPT" T001

    local completed_at
    completed_at=$(jq -r '.tasks[] | select(.id == "T001") | .completedAt // "null"' "$TODO_FILE")
    [ "$completed_at" = "null" ]
}

@test "unarchive sets updatedAt timestamp" {
    create_empty_todo
    create_archive_with_tasks

    bash "$UNARCHIVE_SCRIPT" T001

    local updated_at
    updated_at=$(jq -r '.tasks[] | select(.id == "T001") | .updatedAt' "$TODO_FILE")
    [ -n "$updated_at" ]
    [ "$updated_at" != "null" ]
}

# =============================================================================
# Archive Meta Update Tests
# =============================================================================

@test "unarchive updates archive _meta.totalArchived" {
    create_empty_todo
    create_archive_with_tasks

    local before_count
    before_count=$(jq '._meta.totalArchived' "$ARCHIVE_FILE")

    bash "$UNARCHIVE_SCRIPT" T001

    local after_count
    after_count=$(jq '._meta.totalArchived' "$ARCHIVE_FILE")
    [ "$after_count" -eq 2 ]  # Was 3, now 2
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "unarchive preserves task labels" {
    create_empty_todo
    create_archive_with_tasks

    bash "$UNARCHIVE_SCRIPT" T002  # T002 has labels

    local labels
    labels=$(jq -r '.tasks[] | select(.id == "T002") | .labels | join(",")' "$TODO_FILE")
    echo "$labels" | grep -q "feature"
}

@test "unarchive preserves task phase" {
    create_empty_todo
    create_archive_with_tasks

    bash "$UNARCHIVE_SCRIPT" T002  # T002 has phase: "core"

    local phase
    phase=$(jq -r '.tasks[] | select(.id == "T002") | .phase' "$TODO_FILE")
    [ "$phase" = "core" ]
}

@test "unarchive works with --quiet flag" {
    create_empty_todo
    create_archive_with_tasks

    run bash "$UNARCHIVE_SCRIPT" T001 --quiet
    assert_success

    # Should produce minimal output
    [ ${#output} -lt 50 ] || [ -z "$output" ]
}
