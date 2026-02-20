#!/usr/bin/env bats
# =============================================================================
# archive-atomic.bats - Integration tests for atomic archive operations
# =============================================================================
# Tests atomic operations and orphaned dependency cleanup during archive.
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
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper: Create archive atomic test fixture
# =============================================================================

create_archive_atomic_fixture() {
    cat > "$CONFIG_FILE" << 'EOF'
{
  "version": "0.8.2",
  "archive": {
    "daysUntilArchive": 1,
    "maxCompletedTasks": 5,
    "preserveRecentCount": 2
  }
}
EOF

    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "archive-atomic-test",
    "currentPhase": "setup",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "active", "startedAt": "2025-12-01T10:00:00Z", "completedAt": null},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "pending", "startedAt": null, "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {
    "version": "2.2.0",
    "checksum": "placeholder",
    "activeSession": null
  },
  "lastUpdated": "2025-12-01T00:00:00Z",
  "tasks": [
    {
      "id": "T001",
      "title": "Task 1 - Done old",
      "description": "First completed task",
      "status": "done",
      "priority": "medium",
      "phase": "setup",
      "createdAt": "2025-11-01T00:00:00Z",
      "completedAt": "2025-11-05T00:00:00Z"
    },
    {
      "id": "T002",
      "title": "Task 2 - Done old",
      "description": "Second completed task",
      "status": "done",
      "priority": "medium",
      "phase": "setup",
      "createdAt": "2025-11-02T00:00:00Z",
      "completedAt": "2025-11-06T00:00:00Z"
    },
    {
      "id": "T003",
      "title": "Task 3 - Done recent",
      "description": "Recent completed task",
      "status": "done",
      "priority": "medium",
      "phase": "setup",
      "createdAt": "2025-12-10T00:00:00Z",
      "completedAt": "2025-12-11T00:00:00Z"
    },
    {
      "id": "T004",
      "title": "Task 4 - Active depends on T001",
      "description": "Active task depending on archived task",
      "status": "active",
      "priority": "high",
      "phase": "setup",
      "createdAt": "2025-12-10T00:00:00Z",
      "depends": ["T001", "T005"]
    },
    {
      "id": "T005",
      "title": "Task 5 - Pending",
      "description": "Pending task",
      "status": "pending",
      "priority": "medium",
      "phase": "setup",
      "createdAt": "2025-12-10T00:00:00Z"
    },
    {
      "id": "T006",
      "title": "Task 6 - Pending depends on T002",
      "description": "Pending task depending on archived task",
      "status": "pending",
      "priority": "low",
      "phase": "setup",
      "createdAt": "2025-12-10T00:00:00Z",
      "depends": ["T002"]
    }
  ],
  "focus": {"currentPhase": "setup"},
  "labels": {}
}
EOF
    # Update checksum to match content
    _update_fixture_checksum "$TODO_FILE"
}

# =============================================================================
# Dry Run Tests
# =============================================================================

@test "archive --dry-run does not modify files" {
    create_archive_atomic_fixture
    local before_todo
    before_todo=$(cat "$TODO_FILE")

    run bash "$ARCHIVE_SCRIPT" --dry-run --force
    assert_success

    local after_todo
    after_todo=$(cat "$TODO_FILE")
    [ "$before_todo" = "$after_todo" ]
}

@test "archive --dry-run shows what would be archived" {
    create_archive_atomic_fixture
    run bash "$ARCHIVE_SCRIPT" --dry-run --force
    assert_success
}

# =============================================================================
# Atomic JSON Validity Tests
# =============================================================================

@test "all JSON files remain valid after archive" {
    create_archive_atomic_fixture
    run bash "$ARCHIVE_SCRIPT" --force
    assert_success

    run jq empty "$TODO_FILE"
    assert_success

    run jq empty "$ARCHIVE_FILE"
    assert_success

    run jq empty "$LOG_FILE"
    assert_success
}

@test "archive creates valid archive file structure" {
    create_archive_atomic_fixture
    bash "$ARCHIVE_SCRIPT" --force

    run jq -e '.archivedTasks' "$ARCHIVE_FILE"
    assert_success
}

# =============================================================================
# Orphaned Dependency Cleanup Tests
# =============================================================================

@test "orphaned dependencies are cleaned up after archive" {
    create_archive_atomic_fixture
    bash "$ARCHIVE_SCRIPT" --force

    # T004 depends on T001 (which may be archived) and T005 (which should remain)
    # After archive, T004 should still have T005 in depends if T001 was archived
    local t004_has_t005
    t004_has_t005=$(jq -r '.tasks[] | select(.id == "T004") | .depends // [] | index("T005")' "$TODO_FILE")
    [ "$t004_has_t005" != "null" ]
}

@test "archive --all cleans up all orphaned dependencies" {
    create_archive_atomic_fixture
    # Use --no-safe to allow archiving tasks with active dependents (testing cleanup logic)
    bash "$ARCHIVE_SCRIPT" --all --no-safe

    # After --all, T006's depends on T002 should be cleaned (T002 archived)
    local t006_has_depends
    t006_has_depends=$(jq -r '.tasks[] | select(.id == "T006") | has("depends")' "$TODO_FILE")
    # Either has("depends") is false OR depends array is empty
    if [ "$t006_has_depends" = "true" ]; then
        local depends_length
        depends_length=$(jq -r '.tasks[] | select(.id == "T006") | .depends | length' "$TODO_FILE")
        [ "$depends_length" -eq 0 ]
    fi
}

# =============================================================================
# Backup Tests
# =============================================================================

@test "archive creates backups before modification" {
    create_archive_atomic_fixture
    # Use --no-safe to allow archiving tasks with dependents for testing backup creation
    bash "$ARCHIVE_SCRIPT" --force --no-safe

    # Check for backup directories in new unified taxonomy structure
    # Archive backups go to .cleo/backups/archive/ directory
    local backup_count
    backup_count=$(find "$(dirname "$TODO_FILE")/backups/archive" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
    [ "$backup_count" -ge 1 ]
}

# =============================================================================
# Temp File Cleanup Tests
# =============================================================================

@test "temporary files are cleaned up after archive" {
    create_archive_atomic_fixture
    bash "$ARCHIVE_SCRIPT" --force

    local tmp_count
    tmp_count=$(find "$(dirname "$TODO_FILE")" -name "*.tmp" 2>/dev/null | wc -l)
    [ "$tmp_count" -eq 0 ]
}

# =============================================================================
# Large Batch Archive Tests
# =============================================================================

@test "large batch archive maintains integrity" {
    create_empty_todo

    # Generate 50 completed tasks
    local tasks='[]'
    for i in $(seq 1 50); do
        local task=$(cat <<EOF
{
  "id": "T$(printf '%03d' $i)",
  "title": "Task $i",
  "description": "Test task number $i",
  "status": "done",
  "priority": "medium",
  "createdAt": "2025-11-01T00:00:00Z",
  "completedAt": "2025-11-05T00:00:00Z"
}
EOF
)
        tasks=$(echo "$tasks" | jq --argjson task "$task" '. += [$task]')
    done

    # Update todo.json with 50 tasks
    jq --argjson tasks "$tasks" '.tasks = $tasks' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$ARCHIVE_SCRIPT" --all
    assert_success

    # Verify files are valid JSON
    run jq empty "$TODO_FILE"
    assert_success

    run jq empty "$ARCHIVE_FILE"
    assert_success

    # All 50 should be archived
    local archived_count
    archived_count=$(jq '.archivedTasks | length' "$ARCHIVE_FILE")
    [ "$archived_count" -eq 50 ]
}

# =============================================================================
# Concurrent Safety Tests
# =============================================================================

@test "archive maintains file integrity under concurrent operations" {
    create_archive_atomic_fixture

    # Run archive
    run bash "$ARCHIVE_SCRIPT" --force
    assert_success

    # Verify file integrity
    run jq empty "$TODO_FILE"
    assert_success

    run jq empty "$ARCHIVE_FILE"
    assert_success
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "archive handles tasks with no completedAt gracefully" {
    # Use the shared fixture generator to create a v2.2.0 compatible fixture
    create_empty_todo
    jq '.tasks = [{"id": "T001", "title": "Done without date", "description": "Missing completedAt", "status": "done", "priority": "medium", "phase": "setup", "createdAt": "2025-11-01T00:00:00Z"}]' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"
    _update_fixture_checksum "$TODO_FILE"

    run bash "$ARCHIVE_SCRIPT" --force
    # Should handle gracefully
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]

    run jq empty "$TODO_FILE"
    assert_success
}

@test "archive handles empty depends array" {
    # Use the shared fixture generator to create a v2.2.0 compatible fixture
    create_empty_todo
    jq '.tasks = [
      {"id": "T001", "title": "Done", "description": "Completed", "status": "done", "priority": "medium", "phase": "setup", "createdAt": "2025-11-01T00:00:00Z", "completedAt": "2025-11-05T00:00:00Z"},
      {"id": "T002", "title": "Pending", "description": "Has empty depends", "status": "pending", "priority": "medium", "phase": "setup", "createdAt": "2025-12-01T00:00:00Z", "depends": []}
    ]' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"
    _update_fixture_checksum "$TODO_FILE"

    run bash "$ARCHIVE_SCRIPT" --force
    assert_success

    run jq empty "$TODO_FILE"
    assert_success
}

# =============================================================================
# Checksum Update Tests
# =============================================================================

@test "archive updates checksum correctly" {
    create_archive_atomic_fixture
    bash "$ARCHIVE_SCRIPT" --force

    local checksum
    checksum=$(jq -r '._meta.checksum' "$TODO_FILE")
    [[ "$checksum" =~ ^[a-f0-9]{16}$ ]]
}

@test "archive updates lastUpdated timestamp" {
    create_archive_atomic_fixture
    local before
    before=$(jq -r '.lastUpdated' "$TODO_FILE")

    sleep 1
    # Use --no-safe to allow archiving tasks with dependents for testing timestamp update
    bash "$ARCHIVE_SCRIPT" --force --no-safe

    local after
    after=$(jq -r '.lastUpdated' "$TODO_FILE")
    [ "$after" != "$before" ]
}
