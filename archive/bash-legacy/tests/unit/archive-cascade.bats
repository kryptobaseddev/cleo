#!/usr/bin/env bats
# =============================================================================
# archive-cascade.bats - Unit tests for archive cascade functionality (T436)
# =============================================================================
# Tests relationship-aware archive logic and cascade mode for archiving
# complete parent-child families together.
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
# Cascade Flag Tests
# =============================================================================

@test "archive --cascade flag is recognized" {
    create_complete_family_hierarchy
    run bash "$ARCHIVE_SCRIPT" --cascade --dry-run
    assert_success
}

@test "archive --help shows cascade option" {
    run bash "$ARCHIVE_SCRIPT" --help
    assert_success
    assert_output_contains_any "cascade" "--cascade"
}

# =============================================================================
# Complete Family Cascade Tests
# =============================================================================

@test "archive --cascade archives complete family together" {
    create_complete_family_hierarchy
    # Use --all to bypass age retention
    run bash "$ARCHIVE_SCRIPT" --cascade --all --json
    assert_success

    # Parse JSON output
    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    # Should archive T001 (parent) + T002, T003 (children) = 3 tasks
    [ "$archived_count" -eq 3 ]
}

@test "archive --cascade sets cascadeApplied to true when families archived" {
    create_complete_family_hierarchy
    run bash "$ARCHIVE_SCRIPT" --cascade --all --json
    assert_success

    local cascade_applied
    cascade_applied=$(echo "$output" | jq '.cascadeApplied')
    [ "$cascade_applied" = "true" ]
}

@test "archive --cascade includes cascadedFamilies in JSON output" {
    create_complete_family_hierarchy
    run bash "$ARCHIVE_SCRIPT" --cascade --all --json
    assert_success

    # Check cascadedFamilies structure
    local family_count
    family_count=$(echo "$output" | jq '.cascadedFamilies | length')
    [ "$family_count" -ge 1 ]

    # Verify parent T001 is in cascaded families
    local parent_id
    parent_id=$(echo "$output" | jq -r '.cascadedFamilies[0].parent')
    [ "$parent_id" = "T001" ]

    # Verify children are listed
    local children_count
    children_count=$(echo "$output" | jq '.cascadedFamilies[0].children | length')
    [ "$children_count" -eq 2 ]
}

@test "archive --cascade dry-run shows cascade families" {
    create_complete_family_hierarchy
    run bash "$ARCHIVE_SCRIPT" --cascade --all --dry-run
    assert_success
    # Should mention cascade families in output
    assert_output_contains_any "Cascade" "cascade" "families"
}

# =============================================================================
# Incomplete Family Cascade Tests
# =============================================================================

@test "archive --cascade skips incomplete families" {
    create_incomplete_family_hierarchy
    # T001 (done) has T002 (done) and T003 (pending)
    # Cascade should skip because T003 is not done
    run bash "$ARCHIVE_SCRIPT" --cascade --all --json
    assert_success

    # Only T001 and T002 should be archived (both done)
    # T003 is pending so not archived
    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    # Should only archive done tasks without cascade benefit
    [ "$archived_count" -le 2 ]
}

@test "archive --cascade warns about incomplete families" {
    create_incomplete_family_hierarchy
    run bash "$ARCHIVE_SCRIPT" --cascade --all
    # Should warn that family was skipped
    assert_output_contains_any "skipped" "incomplete" "not done"
}

# =============================================================================
# Safe Mode with Cascade Tests
# =============================================================================

@test "archive --safe blocks orphaning active children (default behavior)" {
    create_completed_parent_active_children
    # T001 (done) has T002 (active) - safe mode should block T001
    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    # Check that T001 was blocked
    local blocked_count
    blocked_count=$(echo "$output" | jq '.blockedByRelationships.byChildren | length')
    [ "$blocked_count" -ge 1 ]
}

@test "archive --no-safe allows archiving parent with active children" {
    create_completed_parent_active_children
    run bash "$ARCHIVE_SCRIPT" --all --no-safe --json
    assert_success

    # T001 should be archived despite having active children
    local archived_ids
    archived_ids=$(echo "$output" | jq -r '.archived.taskIds[]')
    echo "$archived_ids" | grep -q "T001"
}

@test "archive safe mode is enabled by default" {
    create_completed_parent_active_children
    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    local safe_mode
    safe_mode=$(echo "$output" | jq '.safeMode')
    [ "$safe_mode" = "true" ]
}

# =============================================================================
# Dependency-Based Safe Mode Tests
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
}

# =============================================================================
# JSON Output Structure Tests
# =============================================================================

@test "archive JSON output includes all cascade fields" {
    create_complete_family_hierarchy
    run bash "$ARCHIVE_SCRIPT" --cascade --all --json
    assert_success

    # Verify all cascade-related fields exist
    echo "$output" | jq -e '.cascadeApplied' >/dev/null
    echo "$output" | jq -e '.cascadedFamilies' >/dev/null
    echo "$output" | jq -e '.safeMode' >/dev/null
    echo "$output" | jq -e '.blockedByRelationships' >/dev/null
}

@test "archive without cascade still includes cascade fields (false/empty)" {
    create_tasks_with_completed
    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    local cascade_applied
    cascade_applied=$(echo "$output" | jq '.cascadeApplied')
    [ "$cascade_applied" = "false" ]

    local families_count
    families_count=$(echo "$output" | jq '.cascadedFamilies | length')
    [ "$families_count" -eq 0 ]
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "archive --cascade with no families acts normally" {
    create_independent_tasks
    # Complete one task
    jq '.tasks[0].status = "done" | .tasks[0].completedAt = "2025-11-01T10:00:00Z"' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$ARCHIVE_SCRIPT" --cascade --all --json
    assert_success

    # Should still work, cascadeApplied should be false
    local cascade_applied
    cascade_applied=$(echo "$output" | jq '.cascadeApplied')
    [ "$cascade_applied" = "false" ]
}

@test "archive --cascade --dry-run does not modify files" {
    create_complete_family_hierarchy
    local before_todo
    before_todo=$(cat "$TODO_FILE")

    run bash "$ARCHIVE_SCRIPT" --cascade --all --dry-run
    assert_success

    local after_todo
    after_todo=$(cat "$TODO_FILE")
    [ "$before_todo" = "$after_todo" ]
}

# =============================================================================
# --cascade-from Tests (T447/T429)
# =============================================================================

@test "archive --cascade-from validates task exists" {
    create_complete_family_hierarchy

    run bash "$ARCHIVE_SCRIPT" --cascade-from T999 --json
    assert_failure

    # Should show error about task not found
    assert_output_contains_any "not found" "T999"
}

@test "archive --cascade-from validates task is completed" {
    # Create task that is NOT done
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Pending task", "description": "Not done", "status": "pending", "priority": "high", "createdAt": "2025-11-01T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    run bash "$ARCHIVE_SCRIPT" --cascade-from T001 --json
    assert_failure

    # Should show error about task not completed
    assert_output_contains_any "not completed" "pending"
}

@test "archive --cascade-from finds all descendants" {
    # Create 3-level hierarchy: T001 -> T002 -> T003 (all done)
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Root epic", "description": "Root", "status": "done", "priority": "high", "type": "epic", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-10T10:00:00Z"},
    {"id": "T002", "title": "Child task", "description": "Child", "status": "done", "priority": "medium", "parentId": "T001", "createdAt": "2025-11-02T10:00:00Z", "completedAt": "2025-11-08T10:00:00Z"},
    {"id": "T003", "title": "Grandchild", "description": "Grandchild", "status": "done", "priority": "low", "parentId": "T002", "createdAt": "2025-11-03T10:00:00Z", "completedAt": "2025-11-07T10:00:00Z"},
    {"id": "T004", "title": "Unrelated", "description": "Different tree", "status": "done", "priority": "low", "createdAt": "2025-11-04T10:00:00Z", "completedAt": "2025-11-09T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    run bash "$ARCHIVE_SCRIPT" --cascade-from T001 --json
    assert_success

    # Should archive T001, T002, T003 (but NOT T004)
    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -eq 3 ]

    # Verify T004 is NOT archived
    local archived_ids
    archived_ids=$(echo "$output" | jq -r '.archived.taskIds[]' | tr '\n' ' ')
    [[ "$archived_ids" != *"T004"* ]]
    echo "$archived_ids" | grep -q "T001"
    echo "$archived_ids" | grep -q "T002"
    echo "$archived_ids" | grep -q "T003"
}

@test "archive --cascade-from only archives completed descendants" {
    # Create hierarchy with mixed completion status
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Root epic", "description": "Root", "status": "done", "priority": "high", "type": "epic", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-10T10:00:00Z"},
    {"id": "T002", "title": "Done child", "description": "Done", "status": "done", "priority": "medium", "parentId": "T001", "createdAt": "2025-11-02T10:00:00Z", "completedAt": "2025-11-08T10:00:00Z"},
    {"id": "T003", "title": "Pending child", "description": "Pending", "status": "pending", "priority": "low", "parentId": "T001", "createdAt": "2025-11-03T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    run bash "$ARCHIVE_SCRIPT" --cascade-from T001 --json
    assert_success

    # Should archive T001, T002 (done) but NOT T003 (pending)
    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -eq 2 ]

    local archived_ids
    archived_ids=$(echo "$output" | jq -r '.archived.taskIds[]' | tr '\n' ' ')
    echo "$archived_ids" | grep -q "T001"
    echo "$archived_ids" | grep -q "T002"
    [[ "$archived_ids" != *"T003"* ]]
}

@test "archive --cascade-from includes cascadeFrom info in JSON output" {
    create_complete_family_hierarchy

    run bash "$ARCHIVE_SCRIPT" --cascade-from T001 --json
    assert_success

    # Check cascadeFrom structure exists
    echo "$output" | jq -e '.cascadeFrom' >/dev/null

    local root_task
    root_task=$(echo "$output" | jq -r '.cascadeFrom.rootTask')
    [ "$root_task" = "T001" ]

    # Check descendant counts
    local total_descendants
    total_descendants=$(echo "$output" | jq '.cascadeFrom.totalDescendants')
    [ "$total_descendants" -eq 2 ]  # T002, T003
}

@test "archive --cascade-from warns about incomplete descendants" {
    # Create hierarchy with pending descendant
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Root epic", "description": "Root", "status": "done", "priority": "high", "type": "epic", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-10T10:00:00Z"},
    {"id": "T002", "title": "Pending child", "description": "Pending", "status": "pending", "priority": "medium", "parentId": "T001", "createdAt": "2025-11-02T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    run bash "$ARCHIVE_SCRIPT" --cascade-from T001
    assert_success

    # Should warn about incomplete descendants
    assert_output_contains_any "not completed" "pending" "incomplete"
}

@test "archive --cascade-from tracks incompleteDescendants in JSON" {
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Root epic", "description": "Root", "status": "done", "priority": "high", "type": "epic", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-10T10:00:00Z"},
    {"id": "T002", "title": "Done child", "description": "Done", "status": "done", "priority": "medium", "parentId": "T001", "createdAt": "2025-11-02T10:00:00Z", "completedAt": "2025-11-08T10:00:00Z"},
    {"id": "T003", "title": "Pending child", "description": "Pending", "status": "pending", "priority": "low", "parentId": "T001", "createdAt": "2025-11-03T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    run bash "$ARCHIVE_SCRIPT" --cascade-from T001 --json
    assert_success

    local incomplete_count
    incomplete_count=$(echo "$output" | jq '.cascadeFrom.incompleteDescendants')
    [ "$incomplete_count" -eq 1 ]
}

@test "archive --cascade-from with equals syntax works" {
    create_complete_family_hierarchy

    run bash "$ARCHIVE_SCRIPT" --cascade-from=T001 --json
    assert_success

    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -ge 1 ]
}

@test "archive --cascade-from bypasses normal retention rules" {
    # Create task with very recent completion
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Recent epic", "description": "Just completed", "status": "done", "priority": "high", "type": "epic", "createdAt": "2025-12-20T10:00:00Z", "completedAt": "2025-12-21T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    # Without --all or --force, but with --cascade-from
    run bash "$ARCHIVE_SCRIPT" --cascade-from T001 --json
    assert_success

    # Should still archive (cascade-from bypasses retention)
    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -eq 1 ]
}

@test "archive --cascade-from dry-run shows cascade info" {
    create_complete_family_hierarchy

    run bash "$ARCHIVE_SCRIPT" --cascade-from T001 --dry-run
    assert_success

    # Should show cascade-from info
    assert_output_contains_any "Cascade from" "T001" "descendants"
}

@test "archive --cascade-from sets archiveSource correctly" {
    create_complete_family_hierarchy

    bash "$ARCHIVE_SCRIPT" --cascade-from T001

    # Check archived tasks have correct archiveSource
    local archive_source
    archive_source=$(jq -r '.archivedTasks[0]._archive.archiveSource' "$ARCHIVE_FILE")
    [ "$archive_source" = "cascade-from" ]
}
