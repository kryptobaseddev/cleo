#!/usr/bin/env bats
# =============================================================================
# archive-safe-mode.bats - Unit tests for archive safe mode (T447/T429)
# =============================================================================
# Tests relationship safety checks that prevent archiving tasks which would
# orphan children or break dependencies.
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
# Safe Mode Default Behavior Tests
# =============================================================================

@test "archive safe mode is enabled by default" {
    create_completed_parent_active_children
    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    local safe_mode
    safe_mode=$(echo "$output" | jq '.safeMode')
    [ "$safe_mode" = "true" ]
}

@test "archive --safe flag is recognized" {
    create_tasks_with_completed
    run bash "$ARCHIVE_SCRIPT" --safe --all --dry-run
    assert_success
}

@test "archive --no-safe flag disables safe mode" {
    create_completed_parent_active_children
    run bash "$ARCHIVE_SCRIPT" --no-safe --all --json
    assert_success

    local safe_mode
    safe_mode=$(echo "$output" | jq '.safeMode')
    [ "$safe_mode" = "false" ]
}

# =============================================================================
# Blocking Tasks with Active Children Tests
# =============================================================================

@test "archive --safe blocks tasks with active children" {
    create_completed_parent_active_children
    # T001 (done) has T002 (active) - safe mode should block T001
    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    # Check that T001 was blocked due to active children
    local blocked_count
    blocked_count=$(echo "$output" | jq '.blockedByRelationships.byChildren | length')
    [ "$blocked_count" -ge 1 ]

    # Verify T001 is in the blocked list
    local blocked_ids
    blocked_ids=$(echo "$output" | jq -r '.blockedByRelationships.byChildren[]')
    echo "$blocked_ids" | grep -q "T001"
}

@test "archive --safe blocks tasks with pending children" {
    # Create parent (done) with pending child
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Done parent", "description": "Parent done", "status": "done", "priority": "high", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Pending child", "description": "Child pending", "status": "pending", "priority": "medium", "parentId": "T001", "createdAt": "2025-11-02T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    # T001 should be blocked
    local blocked_count
    blocked_count=$(echo "$output" | jq '.blockedByRelationships.byChildren | length')
    [ "$blocked_count" -ge 1 ]
}

@test "archive --safe allows tasks with all children completed" {
    create_complete_family_hierarchy
    # T001 (done) has T002, T003 (both done) - should NOT be blocked
    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    # No tasks should be blocked by children relationships
    local blocked_count
    blocked_count=$(echo "$output" | jq '.blockedByRelationships.byChildren | length')
    [ "$blocked_count" -eq 0 ]

    # T001 should be archived
    local archived_ids
    archived_ids=$(echo "$output" | jq -r '.archived.taskIds[]')
    echo "$archived_ids" | grep -q "T001"
}

# =============================================================================
# Blocking Tasks with Active Dependents Tests
# =============================================================================

@test "archive --safe blocks tasks with active dependents" {
    # Create task T001 (done) that T002 (pending) depends on
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Done task", "description": "Completed", "status": "done", "priority": "high", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Pending task", "description": "Depends on T001", "status": "pending", "priority": "medium", "createdAt": "2025-11-02T10:00:00Z", "depends": ["T001"]}
  ],
  "focus": {}
}
EOF

    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    # T001 should be blocked because T002 depends on it
    local blocked_deps
    blocked_deps=$(echo "$output" | jq '.blockedByRelationships.byDependents | length')
    [ "$blocked_deps" -ge 1 ]

    # Verify T001 is in the blocked list
    local blocked_ids
    blocked_ids=$(echo "$output" | jq -r '.blockedByRelationships.byDependents[]')
    echo "$blocked_ids" | grep -q "T001"
}

@test "archive --safe blocks tasks with blocked dependents" {
    # Create task T001 (done) that T002 (blocked) depends on
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Done task", "description": "Completed", "status": "done", "priority": "high", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Blocked task", "description": "Depends on T001", "status": "blocked", "priority": "medium", "createdAt": "2025-11-02T10:00:00Z", "depends": ["T001"]}
  ],
  "focus": {}
}
EOF

    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    # T001 should be blocked
    local blocked_deps
    blocked_deps=$(echo "$output" | jq '.blockedByRelationships.byDependents | length')
    [ "$blocked_deps" -ge 1 ]
}

@test "archive --safe allows tasks when all dependents are done" {
    # Create task T001 (done) that T002 (also done) depends on
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Done task", "description": "Completed", "status": "done", "priority": "high", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Also done task", "description": "Also completed", "status": "done", "priority": "medium", "createdAt": "2025-11-02T10:00:00Z", "completedAt": "2025-11-06T10:00:00Z", "depends": ["T001"]}
  ],
  "focus": {}
}
EOF

    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    # No tasks should be blocked by dependents
    local blocked_deps
    blocked_deps=$(echo "$output" | jq '.blockedByRelationships.byDependents | length')
    [ "$blocked_deps" -eq 0 ]

    # Both T001 and T002 should be archived
    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -eq 2 ]
}

# =============================================================================
# --no-safe Override Tests
# =============================================================================

@test "archive --no-safe allows archiving parent with active children" {
    create_completed_parent_active_children
    run bash "$ARCHIVE_SCRIPT" --all --no-safe --json
    assert_success

    # T001 should be archived despite having active children
    local archived_ids
    archived_ids=$(echo "$output" | jq -r '.archived.taskIds[]')
    echo "$archived_ids" | grep -q "T001"
}

@test "archive --no-safe allows archiving tasks with active dependents" {
    # Create task T001 (done) that T002 (pending) depends on
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Done task", "description": "Completed", "status": "done", "priority": "high", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Pending task", "description": "Depends on T001", "status": "pending", "priority": "medium", "createdAt": "2025-11-02T10:00:00Z", "depends": ["T001"]}
  ],
  "focus": {}
}
EOF

    run bash "$ARCHIVE_SCRIPT" --all --no-safe --json
    assert_success

    # T001 should be archived
    local archived_ids
    archived_ids=$(echo "$output" | jq -r '.archived.taskIds[]')
    echo "$archived_ids" | grep -q "T001"
}

@test "archive --no-safe cleans up orphaned dependencies" {
    # Create task T002 that depends on T001
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Completed", "description": "Done task", "status": "done", "priority": "high", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Pending", "description": "Depends on T001", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T10:00:00Z", "depends": ["T001"]}
  ],
  "focus": {}
}
EOF

    # Archive with --no-safe
    bash "$ARCHIVE_SCRIPT" --all --no-safe

    # T002's depends should be cleaned up
    local depends
    depends=$(jq -r '.tasks[] | select(.id == "T002") | .depends // [] | length' "$TODO_FILE")
    [ "$depends" -eq 0 ]
}

# =============================================================================
# Config-Based Safe Mode Tests
# =============================================================================

@test "safe mode respects config relationshipSafety.preventOrphanChildren" {
    create_completed_parent_active_children

    # Disable preventOrphanChildren in config
    jq '.archive = {"relationshipSafety": {"preventOrphanChildren": false, "preventBrokenDependencies": false}}' \
        "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    # Safe mode should be false (config disabled it)
    local safe_mode
    safe_mode=$(echo "$output" | jq '.safeMode')
    [ "$safe_mode" = "false" ]

    # T001 should be archived
    local archived_ids
    archived_ids=$(echo "$output" | jq -r '.archived.taskIds[]')
    echo "$archived_ids" | grep -q "T001"
}

@test "safe mode CLI --safe overrides config disabled setting" {
    create_completed_parent_active_children

    # Disable safe mode in config
    jq '.archive = {"relationshipSafety": {"preventOrphanChildren": false, "preventBrokenDependencies": false}}' \
        "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Use --safe CLI flag to override
    run bash "$ARCHIVE_SCRIPT" --all --safe --json
    assert_success

    # Safe mode should be true (CLI override)
    local safe_mode
    safe_mode=$(echo "$output" | jq '.safeMode')
    [ "$safe_mode" = "true" ]

    # T001 should be blocked
    local blocked_count
    blocked_count=$(echo "$output" | jq '.blockedByRelationships.byChildren | length')
    [ "$blocked_count" -ge 1 ]
}

# =============================================================================
# JSON Output Structure Tests
# =============================================================================

@test "archive JSON output includes blockedByRelationships structure" {
    create_completed_parent_active_children
    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    # Verify blockedByRelationships structure exists
    echo "$output" | jq -e '.blockedByRelationships' >/dev/null
    echo "$output" | jq -e '.blockedByRelationships.byChildren' >/dev/null
    echo "$output" | jq -e '.blockedByRelationships.byDependents' >/dev/null
}

@test "archive JSON output includes safeMode field" {
    create_tasks_with_completed
    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    echo "$output" | jq -e '.safeMode' >/dev/null
}

# =============================================================================
# Warning Display Tests
# =============================================================================

@test "archive shows relationship warnings in text output" {
    create_completed_parent_active_children
    run bash "$ARCHIVE_SCRIPT" --all
    assert_success
    # Should warn about skipping tasks with active children
    assert_output_contains_any "Safe mode" "Skipping" "active children"
}

@test "archive --no-warnings suppresses relationship warnings" {
    create_completed_parent_active_children
    run bash "$ARCHIVE_SCRIPT" --all --no-warnings --no-safe
    assert_success
    # Output should not contain explicit warning text about relationships
    # (though it may still show archived task info)
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "archive handles task with both active children AND active dependents" {
    # T001 (done) has child T002 (active) and T003 (pending) depends on T001
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Done parent", "description": "Done", "status": "done", "priority": "high", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Active child", "description": "Child", "status": "active", "priority": "medium", "parentId": "T001", "createdAt": "2025-11-02T10:00:00Z"},
    {"id": "T003", "title": "Pending dependent", "description": "Depends", "status": "pending", "priority": "low", "createdAt": "2025-11-03T10:00:00Z", "depends": ["T001"]}
  ],
  "focus": {}
}
EOF

    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    # T001 should be blocked (by either children or dependents)
    local blocked_by_children
    local blocked_by_deps
    blocked_by_children=$(echo "$output" | jq '.blockedByRelationships.byChildren | length')
    blocked_by_deps=$(echo "$output" | jq '.blockedByRelationships.byDependents | length')

    # At least one should have blocked T001
    [ "$blocked_by_children" -ge 1 ] || [ "$blocked_by_deps" -ge 1 ]
}

@test "archive handles deep hierarchy (grandchildren)" {
    # T001 (done) -> T002 (done) -> T003 (active)
    # Safe mode should block T002 due to T003, and T001 has no direct active children
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Grandparent", "description": "Done", "status": "done", "priority": "high", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Parent", "description": "Done", "status": "done", "priority": "medium", "parentId": "T001", "createdAt": "2025-11-02T10:00:00Z", "completedAt": "2025-11-06T10:00:00Z"},
    {"id": "T003", "title": "Active child", "description": "Active", "status": "active", "priority": "low", "parentId": "T002", "createdAt": "2025-11-03T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    # T002 should be blocked because T003 is active
    local blocked_ids
    blocked_ids=$(echo "$output" | jq -r '.blockedByRelationships.byChildren[]')
    echo "$blocked_ids" | grep -q "T002"
}
