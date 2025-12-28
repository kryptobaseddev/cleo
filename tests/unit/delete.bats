#!/usr/bin/env bats
# =============================================================================
# delete.bats - Comprehensive unit tests for scripts/delete.sh
# =============================================================================
# Tests task deletion/cancellation with child handling strategies, reason
# validation, status checks, and JSON output format verification.
# Part of: Delete Command Implementation (T712)
#
# Test Coverage (25+ tests):
# - Argument validation (reason required, length, metacharacters)
# - Status validation (done, cancelled, pending, active, blocked)
# - Child handling (block, cascade, orphan strategies)
# - JSON output format (_meta, success, taskId, deletedAt, affectedTasks)
# - Edge cases (special chars in reason, max length, leaf tasks)
# =============================================================================

# =============================================================================
# File-Level Setup (runs once per test file)
# =============================================================================
setup_file() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_file
}

# =============================================================================
# Per-Test Setup (runs before each test)
# =============================================================================
setup() {
    # Re-load helper to access functions in per-test scope
    load '../test_helper/common_setup'
    common_setup_per_test

    export DELETE_SCRIPT="${SCRIPTS_DIR}/delete.sh"

    # Source exit codes for test assertions
    source "$LIB_DIR/exit-codes.sh"
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

@test "delete script exists" {
    [ -f "$DELETE_SCRIPT" ]
}

@test "delete script is executable" {
    [ -x "$DELETE_SCRIPT" ]
}

@test "delete script passes syntax check" {
    run bash -n "$DELETE_SCRIPT"
    assert_success
}

# =============================================================================
# Help and Usage Tests
# =============================================================================

@test "delete --help shows usage" {
    run bash "$DELETE_SCRIPT" --help
    assert_success
    assert_output --partial "Usage:"
    assert_output --partial "delete"
    assert_output --partial "--reason"
}

@test "delete without task ID shows error" {
    run bash "$DELETE_SCRIPT"
    assert_failure
    assert_output --partial "Task ID is required"
}

# =============================================================================
# Argument Validation Tests - Reason Required
# =============================================================================

@test "delete fails when --reason not provided" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001
    assert_failure
    assert_output --partial "reason"
}

@test "delete fails when --reason is empty string" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason ""
    assert_failure
    # Empty string is handled by shell before reaching validation
    assert_output --partial "reason"
}

# =============================================================================
# Argument Validation Tests - Reason Length
# =============================================================================

@test "delete fails when reason is less than 5 characters" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "abc"
    assert_failure
    assert_output --partial "5-300"
}

@test "delete fails when reason is exactly 4 characters" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "abcd"
    assert_failure
    assert_output --partial "5-300"
}

@test "delete succeeds with reason at minimum length (5 chars)" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "abcde" --force
    assert_success
}

@test "delete fails when reason exceeds 300 characters" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    # Generate 301 character reason
    LONG_REASON=$(printf 'x%.0s' {1..301})
    run bash "$DELETE_SCRIPT" T001 --reason "$LONG_REASON"
    assert_failure
    assert_output --partial "5-300"
}

# =============================================================================
# Argument Validation Tests - Invalid Task ID Format
# =============================================================================

@test "delete fails with invalid task ID format (no T prefix)" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" "001" --reason "test reason"
    assert_failure
    assert_output --partial "Invalid task ID format"
}

@test "delete fails with lowercase task ID" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" "t001" --reason "test reason"
    assert_failure
    assert_output --partial "Invalid task ID format"
}

# =============================================================================
# Status Validation Tests
# =============================================================================

@test "delete fails for done task with EXIT_TASK_COMPLETED (17)" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "test reason"
    assert_failure
    [ "$status" -eq 17 ]  # EXIT_TASK_COMPLETED
    assert_output --partial "completed"
    assert_output --partial "archive"
}

@test "delete for already-cancelled task returns EXIT_NO_CHANGE (102)" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Cancelled task", "status": "cancelled", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancelReason": "Already cancelled"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "test reason"
    [ "$status" -eq 102 ]  # EXIT_NO_CHANGE (idempotent)
    assert_output --partial "already cancelled"
}

@test "delete succeeds for pending task" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Pending task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    # Create empty archive file
    echo '{"archivedTasks": [], "_meta": {"totalArchived": 0}}' > "$ARCHIVE_FILE"

    run bash "$DELETE_SCRIPT" T001 --reason "No longer needed" --force
    assert_success

    # Verify task is removed from todo.json and archived
    task_in_todo=$(jq -r '.tasks[] | select(.id == "T001") | .id' "$TODO_FILE")
    [ -z "$task_in_todo" ]

    # Verify task is in archive with cancelled status
    status=$(jq -r '.archivedTasks[] | select(.id == "T001") | .status' "$ARCHIVE_FILE")
    [ "$status" = "cancelled" ]
}

@test "delete succeeds for active task" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Active task", "status": "active", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    echo '{"archivedTasks": [], "_meta": {"totalArchived": 0}}' > "$ARCHIVE_FILE"
    run bash "$DELETE_SCRIPT" T001 --reason "Stopping this task" --force
    assert_success

    # Verify task is archived with cancelled status
    status=$(jq -r '.archivedTasks[] | select(.id == "T001") | .status' "$ARCHIVE_FILE")
    [ "$status" = "cancelled" ]
}

@test "delete succeeds for blocked task" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Blocked task", "status": "blocked", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "blockedBy": "External dependency"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    echo '{"archivedTasks": [], "_meta": {"totalArchived": 0}}' > "$ARCHIVE_FILE"
    run bash "$DELETE_SCRIPT" T001 --reason "Blocker resolved differently" --force
    assert_success

    # Verify task is archived with cancelled status
    status=$(jq -r '.archivedTasks[] | select(.id == "T001") | .status' "$ARCHIVE_FILE")
    [ "$status" = "cancelled" ]
}

# =============================================================================
# Child Handling Tests - Block Strategy
# =============================================================================

@test "delete --children block fails when task has children (EXIT_HAS_CHILDREN=16)" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "pending", "priority": "medium", "type": "epic", "createdAt": "2025-01-01T00:00:00Z"},
        {"id": "T002", "title": "Child", "status": "pending", "priority": "medium", "parentId": "T001", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "test reason" --children block --force
    assert_failure
    [ "$status" -eq 16 ]  # EXIT_HAS_CHILDREN
    assert_output --partial "child"
}

@test "delete with default strategy (block) fails when task has children" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "pending", "priority": "medium", "type": "epic", "createdAt": "2025-01-01T00:00:00Z"},
        {"id": "T002", "title": "Child", "status": "pending", "priority": "medium", "parentId": "T001", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    # No --children specified, should default to block
    run bash "$DELETE_SCRIPT" T001 --reason "test reason" --force
    assert_failure
    [ "$status" -eq 16 ]  # EXIT_HAS_CHILDREN
}

# =============================================================================
# Child Handling Tests - Cascade Strategy
# =============================================================================

@test "delete --children cascade deletes all descendants" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "pending", "priority": "medium", "type": "epic", "createdAt": "2025-01-01T00:00:00Z"},
        {"id": "T002", "title": "Child 1", "status": "pending", "priority": "medium", "parentId": "T001", "createdAt": "2025-01-01T00:00:00Z"},
        {"id": "T003", "title": "Child 2", "status": "pending", "priority": "medium", "parentId": "T001", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "Epic cancelled" --children cascade --force
    assert_success

    # Verify all tasks are cancelled and archived
    status1=$(jq -r '.archivedTasks[] | select(.id == "T001") | .status' "$ARCHIVE_FILE")
    status2=$(jq -r '.archivedTasks[] | select(.id == "T002") | .status' "$ARCHIVE_FILE")
    status3=$(jq -r '.archivedTasks[] | select(.id == "T003") | .status' "$ARCHIVE_FILE")

    [ "$status1" = "cancelled" ]
    [ "$status2" = "cancelled" ]
    [ "$status3" = "cancelled" ]
}

@test "delete --children cascade includes grandchildren" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Epic", "status": "pending", "priority": "medium", "type": "epic", "createdAt": "2025-01-01T00:00:00Z"},
        {"id": "T002", "title": "Task", "status": "pending", "priority": "medium", "type": "task", "parentId": "T001", "createdAt": "2025-01-01T00:00:00Z"},
        {"id": "T003", "title": "Subtask", "status": "pending", "priority": "medium", "type": "subtask", "parentId": "T002", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "Full hierarchy cancelled" --children cascade --force
    assert_success

    # Verify all tasks including grandchild are cancelled and archived
    status3=$(jq -r '.archivedTasks[] | select(.id == "T003") | .status' "$ARCHIVE_FILE")
    [ "$status3" = "cancelled" ]
}

# =============================================================================
# Child Handling Tests - Orphan Strategy
# =============================================================================

@test "delete --children orphan sets children parentId to null" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "pending", "priority": "medium", "type": "epic", "createdAt": "2025-01-01T00:00:00Z"},
        {"id": "T002", "title": "Child", "status": "pending", "priority": "medium", "parentId": "T001", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "Orphaning children" --children orphan --force
    assert_success

    # Verify parent is cancelled and archived
    status1=$(jq -r '.archivedTasks[] | select(.id == "T001") | .status' "$ARCHIVE_FILE")
    [ "$status1" = "cancelled" ]

    # Verify child's parentId is null (child remains in todo.json)
    parent_id=$(jq -r '.tasks[] | select(.id == "T002") | .parentId // "null"' "$TODO_FILE")
    [ "$parent_id" = "null" ]

    # Verify child is still pending (not cancelled)
    status2=$(jq -r '.tasks[] | select(.id == "T002") | .status' "$TODO_FILE")
    [ "$status2" = "pending" ]
}

# =============================================================================
# JSON Output Format Tests
# =============================================================================

@test "delete --json includes _meta section" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "JSON test" --force --json
    assert_success

    # Verify valid JSON
    echo "$output" | jq empty

    # Verify _meta section
    has_meta=$(echo "$output" | jq 'has("_meta")')
    [ "$has_meta" = "true" ]

    # Verify _meta fields
    command=$(echo "$output" | jq -r '._meta.command')
    [ "$command" = "delete" ]

    timestamp=$(echo "$output" | jq -r '._meta.timestamp')
    [ -n "$timestamp" ]
}

@test "delete --json includes success field" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "JSON test" --force --json
    assert_success

    success=$(echo "$output" | jq -r '.success')
    [ "$success" = "true" ]
}

@test "delete --json includes taskId field" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "JSON test" --force --json
    assert_success

    task_id=$(echo "$output" | jq -r '.taskId')
    [ "$task_id" = "T001" ]
}

@test "delete --json includes deletedAt field" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "JSON test" --force --json
    assert_success

    deleted_at=$(echo "$output" | jq -r '.deletedAt')
    # Verify it's an ISO timestamp format
    [[ "$deleted_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

@test "delete --json includes affectedTasks array" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "JSON test" --force --json
    assert_success

    # Verify affectedTasks is an array containing T001
    affected=$(echo "$output" | jq -r '.affectedTasks | type')
    [ "$affected" = "array" ]

    first_affected=$(echo "$output" | jq -r '.affectedTasks[0]')
    [ "$first_affected" = "T001" ]
}

@test "delete --json cascade shows all affected tasks" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "pending", "priority": "medium", "type": "epic", "createdAt": "2025-01-01T00:00:00Z"},
        {"id": "T002", "title": "Child", "status": "pending", "priority": "medium", "parentId": "T001", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    # Use --quiet to suppress INFO messages that would interfere with JSON parsing
    run bash "$DELETE_SCRIPT" T001 --reason "Cascade test" --children cascade --force --json --quiet
    assert_success

    # Verify affectedTasks contains both T001 and T002
    affected_count=$(echo "$output" | jq '.affectedTasks | length')
    [ "$affected_count" -eq 2 ]
}

# =============================================================================
# Edge Case Tests
# =============================================================================

@test "delete accepts special characters in reason (non-metachar)" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    echo '{"archivedTasks": [], "_meta": {"totalArchived": 0}}' > "$ARCHIVE_FILE"
    # Valid special characters that are not shell metacharacters
    run bash "$DELETE_SCRIPT" T001 --reason "Task cancelled: scope changed (see notes) - priority shift" --force
    assert_success

    # Verify reason was stored in archive
    reason=$(jq -r '.archivedTasks[] | select(.id == "T001") | .cancellationReason' "$ARCHIVE_FILE")
    [[ "$reason" == *"scope changed"* ]]
}

@test "delete succeeds with 300-character reason (max length)" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    # Generate exactly 300 character reason
    MAX_REASON=$(printf 'x%.0s' {1..300})
    run bash "$DELETE_SCRIPT" T001 --reason "$MAX_REASON" --force
    assert_success
}

@test "delete succeeds for leaf task with no children" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Leaf task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    echo '{"archivedTasks": [], "_meta": {"totalArchived": 0}}' > "$ARCHIVE_FILE"
    run bash "$DELETE_SCRIPT" T001 --reason "Leaf deletion" --force
    assert_success

    # Verify task is in archive with cancelled status
    status=$(jq -r '.archivedTasks[] | select(.id == "T001") | .status' "$ARCHIVE_FILE")
    [ "$status" = "cancelled" ]
}

@test "delete fails for non-existent task" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Existing", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T999 --reason "test reason"
    assert_failure
    [ "$status" -eq 4 ]  # EXIT_NOT_FOUND
    assert_output --partial "not found"
}

# =============================================================================
# Dry-Run Tests
# =============================================================================

@test "delete --dry-run shows preview without changes" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "Dry run test" --dry-run
    assert_success
    assert_output --partial "DRY-RUN"

    # Verify task is still pending
    status=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    [ "$status" = "pending" ]
}

@test "delete --dry-run --json sets dryRun flag" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "Dry run JSON" --dry-run --json
    assert_success

    dry_run=$(echo "$output" | jq -r '.dryRun')
    [ "$dry_run" = "true" ]
}

# =============================================================================
# Cancellation Metadata Tests
# =============================================================================

@test "delete sets cancelledAt timestamp" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    echo '{"archivedTasks": [], "_meta": {"totalArchived": 0}}' > "$ARCHIVE_FILE"
    run bash "$DELETE_SCRIPT" T001 --reason "Timestamp test" --force
    assert_success

    # Check cancelledAt in archive
    cancelled_at=$(jq -r '.archivedTasks[] | select(.id == "T001") | .cancelledAt' "$ARCHIVE_FILE")
    # Verify it's an ISO timestamp
    [[ "$cancelled_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

@test "delete stores cancelReason field" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    echo '{"archivedTasks": [], "_meta": {"totalArchived": 0}}' > "$ARCHIVE_FILE"
    run bash "$DELETE_SCRIPT" T001 --reason "Feature deprecated" --force
    assert_success

    # Check cancellationReason in archive (field renamed in archive format)
    reason=$(jq -r '.archivedTasks[] | select(.id == "T001") | .cancellationReason' "$ARCHIVE_FILE")
    [ "$reason" = "Feature deprecated" ]
}

@test "delete adds cancellation note to notes array" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "notes": ["Previous note"]}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    echo '{"archivedTasks": [], "_meta": {"totalArchived": 0}}' > "$ARCHIVE_FILE"
    run bash "$DELETE_SCRIPT" T001 --reason "Cancelled note test" --force
    assert_success

    # Verify note was preserved (check in archive)
    notes=$(jq -r '.archivedTasks[] | select(.id == "T001") | .notes | last' "$ARCHIVE_FILE")
    [[ "$notes" == *"CANCELLED"* ]]
    [[ "$notes" == *"Cancelled note test"* ]]
}

# =============================================================================
# Checksum and Integrity Tests
# =============================================================================

@test "delete updates checksum" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    old_checksum=$(jq -r '._meta.checksum' "$TODO_FILE")

    run bash "$DELETE_SCRIPT" T001 --reason "Checksum test" --force
    assert_success

    new_checksum=$(jq -r '._meta.checksum' "$TODO_FILE")
    [ "$old_checksum" != "$new_checksum" ]
}

@test "delete updates lastUpdated timestamp" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    old_timestamp=$(jq -r '.lastUpdated' "$TODO_FILE")

    run bash "$DELETE_SCRIPT" T001 --reason "Timestamp update test" --force
    assert_success

    new_timestamp=$(jq -r '.lastUpdated' "$TODO_FILE")
    [ "$old_timestamp" != "$new_timestamp" ]
}

# =============================================================================
# Invalid Children Strategy Tests
# =============================================================================

@test "delete fails with invalid children strategy" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$DELETE_SCRIPT" T001 --reason "test" --children invalid_strategy
    assert_failure
    assert_output --partial "block|orphan|cascade"
}
