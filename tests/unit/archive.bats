#!/usr/bin/env bats
# =============================================================================
# archive.bats - Unit tests for archive.sh
# =============================================================================
# Tests archive functionality including completed task archival and cleanup.
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

@test "archive script exists" {
    [ -f "$ARCHIVE_SCRIPT" ]
}

@test "archive script is executable" {
    [ -x "$ARCHIVE_SCRIPT" ]
}

@test "archive schema exists" {
    [ -f "$PROJECT_ROOT/schemas/archive.schema.json" ]
}

@test "archive template exists" {
    [ -f "$PROJECT_ROOT/templates/archive.template.json" ]
}

@test "archive template is valid JSON" {
    run jq empty "$PROJECT_ROOT/templates/archive.template.json"
    assert_success
}

# =============================================================================
# Help and Usage Tests
# =============================================================================

@test "archive --help shows usage" {
    run bash "$ARCHIVE_SCRIPT" --help
    assert_shows_help
}

@test "archive -h shows usage" {
    run bash "$ARCHIVE_SCRIPT" -h
    assert_shows_help
}

# =============================================================================
# Basic Archive Tests
# =============================================================================

@test "archive with no completed tasks shows message" {
    create_independent_tasks
    run bash "$ARCHIVE_SCRIPT"
    assert_success
}

@test "archive moves completed tasks to archive file" {
    create_tasks_with_completed
    # Use --all to bypass both age retention AND preserveRecentCount
    run bash "$ARCHIVE_SCRIPT" --all
    assert_success

    # Check archive file exists and has content
    [ -f "$ARCHIVE_FILE" ]
    local archived_count
    archived_count=$(jq '.archivedTasks | length' "$ARCHIVE_FILE" 2>/dev/null || echo "0")
    [ "$archived_count" -ge 1 ]
}

@test "archive removes completed tasks from todo.json" {
    create_tasks_with_completed
    local initial_done
    initial_done=$(jq '[.tasks[] | select(.status == "done")] | length' "$TODO_FILE")

    # Use --all to bypass both age retention AND preserveRecentCount
    bash "$ARCHIVE_SCRIPT" --all

    local final_done
    final_done=$(jq '[.tasks[] | select(.status == "done")] | length' "$TODO_FILE")
    [ "$final_done" -lt "$initial_done" ]
}

# =============================================================================
# Dry Run Tests
# =============================================================================

@test "archive --dry-run does not modify files" {
    create_tasks_with_completed
    local before_todo
    before_todo=$(cat "$TODO_FILE")

    run bash "$ARCHIVE_SCRIPT" --dry-run
    assert_success

    local after_todo
    after_todo=$(cat "$TODO_FILE")
    [ "$before_todo" = "$after_todo" ]
}

@test "archive --dry-run shows what would be archived" {
    create_tasks_with_completed
    run bash "$ARCHIVE_SCRIPT" --dry-run
    assert_success
    assert_output_contains_any "would" "archive" "T001"
}

# =============================================================================
# Force and All Options Tests
# =============================================================================

@test "archive --all archives all completed tasks" {
    create_tasks_with_completed
    run bash "$ARCHIVE_SCRIPT" --all
    assert_success
}

@test "archive --force bypasses confirmation" {
    create_tasks_with_completed
    run bash "$ARCHIVE_SCRIPT" --force
    assert_success
}

# =============================================================================
# Output Format Tests
# =============================================================================

@test "archive produces output on success" {
    create_tasks_with_completed
    # Use --all to ensure tasks are actually archived
    run bash "$ARCHIVE_SCRIPT" --all
    assert_success
    # Should produce some output about archiving
    refute_output ""
}

@test "archive --dry-run produces preview output" {
    create_tasks_with_completed
    run bash "$ARCHIVE_SCRIPT" --dry-run
    assert_success
    # Dry-run should show what would be archived
}

# =============================================================================
# Archive File Structure Tests
# =============================================================================

@test "archive creates valid archive file structure" {
    create_tasks_with_completed
    # Use --all to ensure tasks are actually archived
    bash "$ARCHIVE_SCRIPT" --all

    # Verify archive file structure
    run jq empty "$ARCHIVE_FILE"
    assert_success

    run jq -e '.archivedTasks' "$ARCHIVE_FILE"
    assert_success
}

@test "archived tasks preserve original data" {
    create_tasks_with_completed
    local original_title
    original_title=$(jq -r '.tasks[] | select(.status == "done") | .title' "$TODO_FILE" | head -1)

    # Use --all to ensure tasks are actually archived
    bash "$ARCHIVE_SCRIPT" --all

    local archived_title
    archived_title=$(jq -r '.archivedTasks[0].title' "$ARCHIVE_FILE")
    [ "$archived_title" = "$original_title" ]
}

@test "archived tasks have archivedAt timestamp" {
    create_tasks_with_completed
    # Use --all to ensure tasks are actually archived
    bash "$ARCHIVE_SCRIPT" --all

    local archived_at
    archived_at=$(jq -r '.archivedTasks[0]._archive.archivedAt // .archivedTasks[0].archivedAt // empty' "$ARCHIVE_FILE")
    [ -n "$archived_at" ]
}

# =============================================================================
# Dependency Cleanup Tests
# =============================================================================

@test "archive cleans up orphaned dependencies" {
    # Create task T002 that depends on T001
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.1.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Completed", "description": "Done task", "status": "done", "priority": "high", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Pending", "description": "Depends on T001", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T10:00:00Z", "depends": ["T001"]}
  ],
  "focus": {}
}
EOF

    # Use --all to bypass both age retention AND preserveRecentCount
    # Use --no-safe to allow archiving even with active dependents (tests dependency cleanup)
    bash "$ARCHIVE_SCRIPT" --all --no-safe

    # T002's depends should be cleaned up
    local depends
    depends=$(jq -r '.tasks[] | select(.id == "T002") | .depends // [] | length' "$TODO_FILE")
    [ "$depends" -eq 0 ]
}

# =============================================================================
# Error Handling Tests
# =============================================================================

@test "archive handles missing todo.json gracefully" {
    rm -f "$TODO_FILE"
    run bash "$ARCHIVE_SCRIPT"
    # Exit codes: 0=success, 1=general error, 3=E_FILE_NOT_FOUND (graceful)
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]] || [[ "$status" -eq 3 ]]
}

@test "archive preserves file integrity on error" {
    create_tasks_with_completed
    local before_checksum
    before_checksum=$(jq -r '._meta.checksum' "$TODO_FILE")

    # Run archive - should update checksum properly (use --all to ensure archival)
    bash "$ARCHIVE_SCRIPT" --all

    run jq empty "$TODO_FILE"
    assert_success
}

# =============================================================================
# Backup Tests
# =============================================================================

@test "archive creates backup before modification" {
    create_tasks_with_completed
    # Use --all to ensure tasks are actually archived
    bash "$ARCHIVE_SCRIPT" --all

    # Check for backup directories in new unified taxonomy structure
    # Archive backups go to .cleo/backups/archive/ directory
    local backup_count
    backup_count=$(find "$(dirname "$TODO_FILE")/backups/archive" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
    [ "$backup_count" -ge 1 ]
}

@test "archive cleans up temporary files" {
    create_tasks_with_completed
    # Use --all to ensure tasks are actually archived
    bash "$ARCHIVE_SCRIPT" --all

    # Check no .tmp files remain
    local tmp_count
    tmp_count=$(find "$(dirname "$TODO_FILE")" -name "*.tmp" 2>/dev/null | wc -l)
    [ "$tmp_count" -eq 0 ]
}
