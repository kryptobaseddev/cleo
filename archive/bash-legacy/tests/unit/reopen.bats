#!/usr/bin/env bats
# =============================================================================
# reopen.bats - Unit tests for scripts/reopen.sh
# =============================================================================
# Tests restoration of completed tasks back to pending status.
# Part of: Task Hierarchy Enhancement (reopen auto-completed epics)
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test
    export REOPEN_SCRIPT="${SCRIPTS_DIR}/reopen.sh"
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

@test "reopen script exists" {
    [ -f "$REOPEN_SCRIPT" ]
}

@test "reopen script is executable" {
    [ -x "$REOPEN_SCRIPT" ]
}

@test "reopen script passes syntax check" {
    run bash -n "$REOPEN_SCRIPT"
    assert_success
}

# =============================================================================
# Help and Usage Tests
# =============================================================================

@test "reopen --help shows usage" {
    run bash "$REOPEN_SCRIPT" --help
    assert_success
    assert_output --partial "Usage:"
    assert_output --partial "reopen"
    assert_output --partial "TASK_ID"
    assert_output --partial "--reason"
}

@test "reopen without task ID shows error" {
    run bash "$REOPEN_SCRIPT" --reason "test"
    assert_failure
    assert_output --partial "Task ID is required"
}

@test "reopen without --reason shows error" {
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
    run bash "$REOPEN_SCRIPT" T001
    assert_failure
    assert_output --partial "--reason is required"
}

@test "reopen with invalid task ID format shows error" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" "invalid" --reason "test"
    assert_failure
    assert_output --partial "Invalid task ID format"
}

# =============================================================================
# Task Not Found Tests
# =============================================================================

@test "reopen fails when task does not exist" {
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
    run bash "$REOPEN_SCRIPT" T999 --reason "test"
    assert_failure
    assert_output --partial "Task T999 not found"
}

# =============================================================================
# Status Validation Tests
# =============================================================================

@test "reopen fails for pending task (not done)" {
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
    run bash "$REOPEN_SCRIPT" T001 --reason "test"
    assert_failure
    assert_output --partial "not done"
    assert_output --partial "current status: pending"
}

@test "reopen fails for active task" {
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
    run bash "$REOPEN_SCRIPT" T001 --reason "test"
    assert_failure
    assert_output --partial "not done"
}

@test "reopen fails for cancelled task with suggestion" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Cancelled task", "status": "cancelled", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "test"
    assert_failure
    assert_output --partial "uncancel"
}

# =============================================================================
# Basic Reopen Tests
# =============================================================================

@test "reopen restores done task to pending" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "Need more work"
    assert_success
    assert_output --partial "reopened to pending"

    # Verify task status changed
    status=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    [ "$status" = "pending" ]
}

@test "reopen removes completedAt field" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "Need more work"
    assert_success

    # Verify completedAt is removed
    completed_at=$(jq -r '.tasks[] | select(.id == "T001") | .completedAt // "null"' "$TODO_FILE")
    [ "$completed_at" = "null" ]
}

@test "reopen preserves completion info in notes" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "Need more work"
    assert_success

    # Verify notes contain the original completion time
    notes=$(jq -r '.tasks[] | select(.id == "T001") | .notes // []' "$TODO_FILE")
    echo "$notes" | grep -q "2025-01-02"
}

@test "reopen includes reason in notes" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "Found a bug"
    assert_success

    # Verify notes contain the reason
    notes=$(jq -r '.tasks[] | select(.id == "T001") | .notes | .[-1]' "$TODO_FILE")
    echo "$notes" | grep -q "Found a bug"
}

# =============================================================================
# Target Status Tests
# =============================================================================

@test "reopen --status active sets task to active" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "Resuming work" --status active
    assert_success

    status=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    [ "$status" = "active" ]
}

@test "reopen --status blocked sets task to blocked" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "Waiting on dependency" --status blocked
    assert_success

    status=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    [ "$status" = "blocked" ]
}

@test "reopen --status done is rejected" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "test" --status done
    assert_failure
    assert_output --partial "Cannot reopen to 'done'"
}

@test "reopen --status invalid is rejected" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "test" --status invalid
    assert_failure
    assert_output --partial "Invalid status"
}

# =============================================================================
# Auto-Complete Detection Tests
# =============================================================================

@test "reopen detects auto-completed task" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Auto-completed epic", "status": "done", "priority": "medium", "type": "epic", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z", "notes": ["[AUTO-COMPLETED] All children done"]}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "Child incomplete"
    assert_success

    # Output should mention it was auto-completed
    assert_output --partial "auto-completed"
}

@test "reopen warns about epic with all children still done" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Epic", "status": "done", "priority": "medium", "type": "epic", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"},
        {"id": "T002", "title": "Child 1", "status": "done", "priority": "medium", "parentId": "T001", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"},
        {"id": "T003", "title": "Child 2", "status": "done", "priority": "medium", "parentId": "T001", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "Need additional work"
    assert_success

    # Should warn about potential auto-complete
    assert_output --partial "auto-complete again"
}

# =============================================================================
# Dry-Run Tests
# =============================================================================

@test "reopen --dry-run shows preview without changes" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "test" --dry-run
    assert_success
    assert_output --partial "DRY-RUN"
    assert_output --partial "Would reopen"

    # Verify task is still done
    status=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    [ "$status" = "done" ]
}

# =============================================================================
# JSON Output Tests
# =============================================================================

@test "reopen --json produces valid JSON output" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "Need more work" --json
    assert_success

    # Verify valid JSON
    echo "$output" | jq empty

    # Verify key fields
    success=$(echo "$output" | jq -r '.success')
    task_id=$(echo "$output" | jq -r '.taskId')
    new_status=$(echo "$output" | jq -r '.newStatus')
    reason=$(echo "$output" | jq -r '.reason')

    [ "$success" = "true" ]
    [ "$task_id" = "T001" ]
    [ "$new_status" = "pending" ]
    [ "$reason" = "Need more work" ]
}

@test "reopen --json includes previous completion time" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "test" --json
    assert_success

    prev_completed=$(echo "$output" | jq -r '.previousCompletedAt')
    [ "$prev_completed" = "2025-01-02T12:00:00Z" ]
}

@test "reopen --json --dry-run sets dryRun flag" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "test" --json --dry-run
    assert_success

    dry_run=$(echo "$output" | jq -r '.dryRun')
    [ "$dry_run" = "true" ]
}

@test "reopen --json includes wasAutoCompleted flag" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Auto-completed epic", "status": "done", "priority": "medium", "type": "epic", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z", "notes": ["[AUTO-COMPLETED] All children done"]}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "test" --json
    assert_success

    was_auto=$(echo "$output" | jq -r '.wasAutoCompleted')
    [ "$was_auto" = "true" ]
}

# =============================================================================
# Checksum Update Tests
# =============================================================================

@test "reopen updates checksum" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    old_checksum=$(jq -r '._meta.checksum' "$TODO_FILE")

    run bash "$REOPEN_SCRIPT" T001 --reason "test"
    assert_success

    new_checksum=$(jq -r '._meta.checksum' "$TODO_FILE")
    [ "$old_checksum" != "$new_checksum" ]
}

@test "reopen updates lastUpdated timestamp" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    old_timestamp=$(jq -r '.lastUpdated' "$TODO_FILE")

    run bash "$REOPEN_SCRIPT" T001 --reason "test"
    assert_success

    new_timestamp=$(jq -r '.lastUpdated' "$TODO_FILE")
    [ "$old_timestamp" != "$new_timestamp" ]
}

# =============================================================================
# Backup Creation Tests
# =============================================================================

@test "reopen creates safety backup" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-02T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$REOPEN_SCRIPT" T001 --reason "test"
    assert_success

    # Check backup was created (output should mention it)
    assert_output --partial "Backup"
}
