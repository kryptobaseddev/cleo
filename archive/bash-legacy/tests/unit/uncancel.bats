#!/usr/bin/env bats
# =============================================================================
# uncancel.bats - Unit tests for scripts/uncancel.sh
# =============================================================================
# Tests restoration of cancelled tasks back to pending status.
# Part of: Delete Command Implementation (T710)
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    export UNCANCEL_SCRIPT="${SCRIPTS_DIR}/uncancel.sh"
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

@test "uncancel script exists" {
    [ -f "$UNCANCEL_SCRIPT" ]
}

@test "uncancel script is executable" {
    [ -x "$UNCANCEL_SCRIPT" ]
}

@test "uncancel script passes syntax check" {
    run bash -n "$UNCANCEL_SCRIPT"
    assert_success
}

# =============================================================================
# Help and Usage Tests
# =============================================================================

@test "uncancel --help shows usage" {
    run bash "$UNCANCEL_SCRIPT" --help
    assert_success
    assert_output --partial "Usage:"
    assert_output --partial "uncancel"
    assert_output --partial "TASK_ID"
}

@test "uncancel without task ID shows error" {
    run bash "$UNCANCEL_SCRIPT"
    assert_failure
    assert_output --partial "Task ID is required"
}

@test "uncancel with invalid task ID format shows error" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$UNCANCEL_SCRIPT" "invalid"
    assert_failure
    assert_output --partial "Invalid task ID format"
}

# =============================================================================
# Task Not Found Tests
# =============================================================================

@test "uncancel fails when task does not exist" {
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
    run bash "$UNCANCEL_SCRIPT" T999
    assert_failure
    assert_output --partial "Task T999 not found"
}

# =============================================================================
# Status Validation Tests
# =============================================================================

@test "uncancel fails for pending task (not cancelled)" {
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
    run bash "$UNCANCEL_SCRIPT" T001
    assert_failure
    assert_output --partial "not cancelled"
    assert_output --partial "current status: pending"
}

@test "uncancel fails for active task" {
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
    run bash "$UNCANCEL_SCRIPT" T001
    assert_failure
    assert_output --partial "not cancelled"
}

@test "uncancel fails for done task" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "completedAt": "2025-01-01T12:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$UNCANCEL_SCRIPT" T001
    assert_failure
    assert_output --partial "not cancelled"
}

# =============================================================================
# Basic Uncancel Tests
# =============================================================================

@test "uncancel restores cancelled task to pending" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Cancelled task", "status": "cancelled", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Feature deprecated"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$UNCANCEL_SCRIPT" T001
    assert_success
    assert_output --partial "restored to pending"

    # Verify task status changed
    status=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    [ "$status" = "pending" ]
}

@test "uncancel removes cancelledAt field" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Cancelled task", "status": "cancelled", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Feature deprecated"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$UNCANCEL_SCRIPT" T001
    assert_success

    # Verify cancelledAt is removed
    cancelled_at=$(jq -r '.tasks[] | select(.id == "T001") | .cancelledAt // "null"' "$TODO_FILE")
    [ "$cancelled_at" = "null" ]
}

@test "uncancel removes cancellationReason field" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Cancelled task", "status": "cancelled", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Feature deprecated"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$UNCANCEL_SCRIPT" T001
    assert_success

    # Verify cancellationReason is removed
    reason=$(jq -r '.tasks[] | select(.id == "T001") | .cancellationReason // "null"' "$TODO_FILE")
    [ "$reason" = "null" ]
}

@test "uncancel preserves original cancellation reason in notes" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Cancelled task", "status": "cancelled", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Feature deprecated"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$UNCANCEL_SCRIPT" T001
    assert_success

    # Verify notes contain the original reason
    notes=$(jq -r '.tasks[] | select(.id == "T001") | .notes // []' "$TODO_FILE")
    echo "$notes" | grep -q "Feature deprecated"
}

# =============================================================================
# Notes Option Tests
# =============================================================================

@test "uncancel with --notes adds custom note" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Cancelled task", "status": "cancelled", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Old reason"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$UNCANCEL_SCRIPT" T001 --notes "Reviving for v2.0"
    assert_success

    # Verify notes contain the custom text
    notes=$(jq -r '.tasks[] | select(.id == "T001") | .notes | .[-1]' "$TODO_FILE")
    echo "$notes" | grep -q "Reviving for v2.0"
}

# =============================================================================
# Dry-Run Tests
# =============================================================================

@test "uncancel --dry-run shows preview without changes" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Cancelled task", "status": "cancelled", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Feature deprecated"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$UNCANCEL_SCRIPT" T001 --dry-run
    assert_success
    assert_output --partial "DRY-RUN"
    assert_output --partial "Would restore"

    # Verify task is still cancelled
    status=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    [ "$status" = "cancelled" ]
}

# =============================================================================
# Cascade Tests
# =============================================================================

@test "uncancel --cascade restores cancelled children" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "cancelled", "priority": "medium", "type": "epic", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Epic cancelled"},
        {"id": "T002", "title": "Child 1", "status": "cancelled", "priority": "medium", "parentId": "T001", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Parent cancelled"},
        {"id": "T003", "title": "Child 2", "status": "cancelled", "priority": "medium", "parentId": "T001", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Parent cancelled"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$UNCANCEL_SCRIPT" T001 --cascade
    assert_success

    # Verify all tasks are pending
    status1=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    status2=$(jq -r '.tasks[] | select(.id == "T002") | .status' "$TODO_FILE")
    status3=$(jq -r '.tasks[] | select(.id == "T003") | .status' "$TODO_FILE")

    [ "$status1" = "pending" ]
    [ "$status2" = "pending" ]
    [ "$status3" = "pending" ]
}

@test "uncancel without --cascade only restores parent" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "cancelled", "priority": "medium", "type": "epic", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Epic cancelled"},
        {"id": "T002", "title": "Child", "status": "cancelled", "priority": "medium", "parentId": "T001", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Parent cancelled"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$UNCANCEL_SCRIPT" T001
    assert_success

    # Parent should be pending, child should still be cancelled
    status1=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    status2=$(jq -r '.tasks[] | select(.id == "T002") | .status' "$TODO_FILE")

    [ "$status1" = "pending" ]
    [ "$status2" = "cancelled" ]
}

@test "uncancel --cascade only restores cancelled children (not pending)" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "cancelled", "priority": "medium", "type": "epic", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Epic cancelled"},
        {"id": "T002", "title": "Cancelled child", "status": "cancelled", "priority": "medium", "parentId": "T001", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Parent cancelled"},
        {"id": "T003", "title": "Pending child", "status": "pending", "priority": "medium", "parentId": "T001", "createdAt": "2025-01-01T00:00:00Z"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$UNCANCEL_SCRIPT" T001 --cascade
    assert_success

    # All should be pending (T003 was already pending, should remain)
    status1=$(jq -r '.tasks[] | select(.id == "T001") | .status' "$TODO_FILE")
    status2=$(jq -r '.tasks[] | select(.id == "T002") | .status' "$TODO_FILE")
    status3=$(jq -r '.tasks[] | select(.id == "T003") | .status' "$TODO_FILE")

    [ "$status1" = "pending" ]
    [ "$status2" = "pending" ]
    [ "$status3" = "pending" ]
}

# =============================================================================
# JSON Output Tests
# =============================================================================

@test "uncancel --json produces valid JSON output" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Cancelled task", "status": "cancelled", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Feature deprecated"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$UNCANCEL_SCRIPT" T001 --json
    assert_success

    # Verify valid JSON
    echo "$output" | jq empty

    # Verify key fields
    success=$(echo "$output" | jq -r '.success')
    task_id=$(echo "$output" | jq -r '.taskId')
    new_status=$(echo "$output" | jq -r '.newStatus')

    [ "$success" = "true" ]
    [ "$task_id" = "T001" ]
    [ "$new_status" = "pending" ]
}

@test "uncancel --json includes original cancellation reason" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Cancelled task", "status": "cancelled", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Feature deprecated"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$UNCANCEL_SCRIPT" T001 --json
    assert_success

    original_reason=$(echo "$output" | jq -r '.originalReason')
    [ "$original_reason" = "Feature deprecated" ]
}

@test "uncancel --json --dry-run sets dryRun flag" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Cancelled task", "status": "cancelled", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Feature deprecated"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$UNCANCEL_SCRIPT" T001 --json --dry-run
    assert_success

    dry_run=$(echo "$output" | jq -r '.dryRun')
    [ "$dry_run" = "true" ]
}

# =============================================================================
# Checksum Update Tests
# =============================================================================

@test "uncancel updates checksum" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Cancelled task", "status": "cancelled", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Feature deprecated"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    old_checksum=$(jq -r '._meta.checksum' "$TODO_FILE")

    run bash "$UNCANCEL_SCRIPT" T001
    assert_success

    new_checksum=$(jq -r '._meta.checksum' "$TODO_FILE")
    [ "$old_checksum" != "$new_checksum" ]
}

@test "uncancel updates lastUpdated timestamp" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Cancelled task", "status": "cancelled", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Feature deprecated"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    old_timestamp=$(jq -r '.lastUpdated' "$TODO_FILE")

    run bash "$UNCANCEL_SCRIPT" T001
    assert_success

    new_timestamp=$(jq -r '.lastUpdated' "$TODO_FILE")
    [ "$old_timestamp" != "$new_timestamp" ]
}

# =============================================================================
# Backup Creation Tests
# =============================================================================

@test "uncancel creates safety backup" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "project": {"name": "test", "phases": {}},
    "lastUpdated": "2025-01-01T00:00:00Z",
    "tasks": [
        {"id": "T001", "title": "Cancelled task", "status": "cancelled", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z", "cancelledAt": "2025-01-02T00:00:00Z", "cancellationReason": "Feature deprecated"}
    ],
    "_meta": {"checksum": "abc123", "configVersion": "2.2.0"}
}
EOF
    run bash "$UNCANCEL_SCRIPT" T001
    assert_success

    # Check backup was created (output should mention it)
    assert_output --partial "Backup"
}
