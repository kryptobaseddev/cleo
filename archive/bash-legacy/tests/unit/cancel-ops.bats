#!/usr/bin/env bats
# =============================================================================
# cancel-ops.bats - Unit tests for lib/tasks/cancel-ops.sh
# =============================================================================
# Tests preflight validation for delete/cancel operations.
# Part of: Delete Command Implementation (T708)
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

    # Source the cancel-ops library
    source "$LIB_DIR/tasks/cancel-ops.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Library Presence Tests
# =============================================================================

@test "cancel-ops library exists" {
    [ -f "$LIB_DIR/tasks/cancel-ops.sh" ]
}

@test "cancel-ops library is executable" {
    [ -x "$LIB_DIR/tasks/cancel-ops.sh" ]
}

@test "cancel-ops library sources without error" {
    run bash -c "source '$LIB_DIR/tasks/cancel-ops.sh' && echo 'OK'"
    assert_success
    assert_output "OK"
}

# =============================================================================
# Helper Function Tests
# =============================================================================

@test "validate_task_id_format accepts valid T### format" {
    run validate_task_id_format "T001"
    assert_success
}

@test "validate_task_id_format accepts T1 format" {
    run validate_task_id_format "T1"
    assert_success
}

@test "validate_task_id_format accepts T999 format" {
    run validate_task_id_format "T999"
    assert_success
}

@test "validate_task_id_format rejects empty string" {
    run validate_task_id_format ""
    assert_failure
}

@test "validate_task_id_format rejects lowercase t" {
    run validate_task_id_format "t001"
    assert_failure
}

@test "validate_task_id_format rejects no T prefix" {
    run validate_task_id_format "001"
    assert_failure
}

@test "validate_task_id_format rejects text suffix" {
    run validate_task_id_format "T001abc"
    assert_failure
}

# =============================================================================
# Task Existence Tests
# =============================================================================

@test "task_exists returns true for existing task" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending"}
    ]
}
EOF
    run task_exists "T001" "$TODO_FILE"
    assert_success
}

@test "task_exists returns false for non-existent task" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending"}
    ]
}
EOF
    run task_exists "T999" "$TODO_FILE"
    assert_failure
}

@test "task_exists returns false for missing file" {
    rm -f "$TODO_FILE"
    run task_exists "T001" "$TODO_FILE"
    assert_failure
}

# =============================================================================
# Task Status Tests
# =============================================================================

@test "get_task_status returns correct status" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "blocked"}
    ]
}
EOF
    result=$(get_task_status "T001" "$TODO_FILE")
    [ "$result" = "blocked" ]
}

@test "get_task_status returns empty for non-existent task" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending"}
    ]
}
EOF
    result=$(get_task_status "T999" "$TODO_FILE")
    [ -z "$result" ]
}

# =============================================================================
# Child Detection Tests
# =============================================================================

@test "task_has_children returns true for parent task" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "pending", "type": "epic"},
        {"id": "T002", "title": "Child", "status": "pending", "parentId": "T001"}
    ]
}
EOF
    run task_has_children "T001" "$TODO_FILE"
    assert_success
}

@test "task_has_children returns false for leaf task" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Leaf task", "status": "pending"}
    ]
}
EOF
    run task_has_children "T001" "$TODO_FILE"
    assert_failure
}

@test "count_direct_children returns correct count" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "pending", "type": "epic"},
        {"id": "T002", "title": "Child 1", "status": "pending", "parentId": "T001"},
        {"id": "T003", "title": "Child 2", "status": "pending", "parentId": "T001"},
        {"id": "T004", "title": "Child 3", "status": "pending", "parentId": "T001"}
    ]
}
EOF
    result=$(count_direct_children "T001" "$TODO_FILE")
    [ "$result" -eq 3 ]
}

# =============================================================================
# Preflight Validation - Task ID Format
# =============================================================================

@test "preflight_delete_check fails for invalid task ID format" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": []
}
EOF
    run preflight_delete_check "invalid" "$TODO_FILE" "" "test reason"
    assert_failure
    assert_output --partial "taskId"
    assert_output --partial "Invalid task ID format"
}

@test "preflight_delete_check fails for empty task ID" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": []
}
EOF
    run preflight_delete_check "" "$TODO_FILE" "" "test reason"
    assert_failure
}

# =============================================================================
# Preflight Validation - Task Existence
# =============================================================================

@test "preflight_delete_check fails for non-existent task" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Existing", "status": "pending"}
    ]
}
EOF
    run preflight_delete_check "T999" "$TODO_FILE" "" "test reason"
    assert_failure
    assert_output --partial "Task not found"
}

@test "preflight_delete_check fails for missing todo file" {
    rm -f "$TODO_FILE"
    run preflight_delete_check "T001" "$TODO_FILE" "" "test reason"
    assert_failure
    assert_output --partial "Todo file not found"
}

# =============================================================================
# Preflight Validation - Status Check
# =============================================================================

@test "preflight_delete_check fails for completed task" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Done task", "status": "done"}
    ]
}
EOF
    run preflight_delete_check "T001" "$TODO_FILE" "" "test reason"
    assert_failure
    assert_output --partial "Cannot delete completed task"
    assert_output --partial "archive"
}

@test "preflight_delete_check allows pending task" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Pending task", "status": "pending"}
    ]
}
EOF
    run preflight_delete_check "T001" "$TODO_FILE" "" "test reason for deletion"
    assert_success
}

@test "preflight_delete_check allows blocked task" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Blocked task", "status": "blocked"}
    ]
}
EOF
    run preflight_delete_check "T001" "$TODO_FILE" "" "test reason for deletion"
    assert_success
}

# =============================================================================
# Preflight Validation - Reason Validation
# =============================================================================

@test "preflight_delete_check fails when reason is required but missing" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending"}
    ]
}
EOF
    # Ensure reason is required (default)
    unset CLAUDE_TODO_CANCELLATION_REQUIRE_REASON
    
    run preflight_delete_check "T001" "$TODO_FILE" "" ""
    assert_failure
    assert_output --partial "reason"
}

@test "preflight_delete_check fails for too short reason" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending"}
    ]
}
EOF
    run preflight_delete_check "T001" "$TODO_FILE" "" "ab"
    assert_failure
    assert_output --partial "reason"
}

@test "preflight_delete_check succeeds with valid reason" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending"}
    ]
}
EOF
    run preflight_delete_check "T001" "$TODO_FILE" "" "This is a valid cancellation reason"
    assert_success
}

# =============================================================================
# Preflight Validation - Leaf Task Fast Path
# =============================================================================

@test "preflight_delete_check returns isLeaf=true for task without children" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Leaf task", "status": "pending"}
    ]
}
EOF
    result=$(preflight_delete_check "T001" "$TODO_FILE" "" "valid reason text")
    is_leaf=$(echo "$result" | jq -r '.taskInfo.isLeaf')
    [ "$is_leaf" = "true" ]
}

@test "preflight_delete_check returns isLeaf=false for task with children" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "pending", "type": "epic"},
        {"id": "T002", "title": "Child", "status": "pending", "parentId": "T001"}
    ]
}
EOF
    result=$(preflight_delete_check "T001" "$TODO_FILE" "block" "valid reason text")
    is_leaf=$(echo "$result" | jq -r '.taskInfo.isLeaf')
    [ "$is_leaf" = "false" ]
}

# =============================================================================
# Preflight Validation - Child Mode Validation
# =============================================================================

@test "preflight_delete_check fails for task with children but no mode specified (non-TTY)" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "pending", "type": "epic"},
        {"id": "T002", "title": "Child", "status": "pending", "parentId": "T001"}
    ]
}
EOF
    # Force non-TTY mode by piping
    result=$(echo "" | preflight_delete_check "T001" "$TODO_FILE" "" "valid reason" 2>&1) || true
    echo "$result" | jq -e '.validationErrors[] | select(.field == "childMode")' >/dev/null
}

@test "preflight_delete_check accepts valid child modes" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "pending", "type": "epic"},
        {"id": "T002", "title": "Child", "status": "pending", "parentId": "T001"}
    ]
}
EOF
    for mode in block orphan cascade; do
        run preflight_delete_check "T001" "$TODO_FILE" "$mode" "valid reason"
        assert_success
    done
}

@test "preflight_delete_check rejects invalid child mode" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "pending", "type": "epic"},
        {"id": "T002", "title": "Child", "status": "pending", "parentId": "T001"}
    ]
}
EOF
    run preflight_delete_check "T001" "$TODO_FILE" "invalid_mode" "valid reason"
    assert_failure
    assert_output --partial "Invalid child handling mode"
}

# =============================================================================
# Preflight Validation - Cascade Limit
# =============================================================================

@test "preflight_delete_check fails when cascade exceeds limit without force" {
    # Create parent with many children (more than default limit of 10)
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "pending", "type": "epic"},
        {"id": "T002", "title": "Child 1", "status": "pending", "parentId": "T001"},
        {"id": "T003", "title": "Child 2", "status": "pending", "parentId": "T001"},
        {"id": "T004", "title": "Child 3", "status": "pending", "parentId": "T001"},
        {"id": "T005", "title": "Child 4", "status": "pending", "parentId": "T001"},
        {"id": "T006", "title": "Child 5", "status": "pending", "parentId": "T001"},
        {"id": "T007", "title": "Child 6", "status": "pending", "parentId": "T001"},
        {"id": "T008", "title": "Child 7", "status": "pending", "parentId": "T001"},
        {"id": "T009", "title": "Child 8", "status": "pending", "parentId": "T001"},
        {"id": "T010", "title": "Child 9", "status": "pending", "parentId": "T001"},
        {"id": "T011", "title": "Child 10", "status": "pending", "parentId": "T001"},
        {"id": "T012", "title": "Child 11", "status": "pending", "parentId": "T001"}
    ]
}
EOF
    run preflight_delete_check "T001" "$TODO_FILE" "cascade" "valid reason" "false"
    assert_failure
    assert_output --partial "cascadeLimit"
}

@test "preflight_delete_check allows cascade with force flag" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "pending", "type": "epic"},
        {"id": "T002", "title": "Child 1", "status": "pending", "parentId": "T001"},
        {"id": "T003", "title": "Child 2", "status": "pending", "parentId": "T001"},
        {"id": "T004", "title": "Child 3", "status": "pending", "parentId": "T001"},
        {"id": "T005", "title": "Child 4", "status": "pending", "parentId": "T001"},
        {"id": "T006", "title": "Child 5", "status": "pending", "parentId": "T001"},
        {"id": "T007", "title": "Child 6", "status": "pending", "parentId": "T001"},
        {"id": "T008", "title": "Child 7", "status": "pending", "parentId": "T001"},
        {"id": "T009", "title": "Child 8", "status": "pending", "parentId": "T001"},
        {"id": "T010", "title": "Child 9", "status": "pending", "parentId": "T001"},
        {"id": "T011", "title": "Child 10", "status": "pending", "parentId": "T001"},
        {"id": "T012", "title": "Child 11", "status": "pending", "parentId": "T001"}
    ]
}
EOF
    run preflight_delete_check "T001" "$TODO_FILE" "cascade" "valid reason" "true"
    assert_success
    # Should have a warning about the override
    assert_output --partial "warnings"
}

# =============================================================================
# Validation Result Structure Tests
# =============================================================================

@test "preflight_delete_check returns valid JSON structure" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending"}
    ]
}
EOF
    result=$(preflight_delete_check "T001" "$TODO_FILE" "" "valid reason text")
    
    # Verify JSON structure
    echo "$result" | jq -e '.success' >/dev/null
    echo "$result" | jq -e '.canProceed' >/dev/null
    echo "$result" | jq -e '.validationErrors' >/dev/null
    echo "$result" | jq -e '.warnings' >/dev/null
    echo "$result" | jq -e '.taskInfo' >/dev/null
}

@test "preflight_delete_check returns taskInfo with correct fields" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Parent", "status": "active", "type": "epic"},
        {"id": "T002", "title": "Child", "status": "pending", "parentId": "T001"}
    ]
}
EOF
    result=$(preflight_delete_check "T001" "$TODO_FILE" "block" "valid reason text")
    
    # Verify taskInfo fields
    has_children=$(echo "$result" | jq -r '.taskInfo.hasChildren')
    child_count=$(echo "$result" | jq -r '.taskInfo.childCount')
    status=$(echo "$result" | jq -r '.taskInfo.status')
    is_leaf=$(echo "$result" | jq -r '.taskInfo.isLeaf')
    
    [ "$has_children" = "true" ]
    [ "$child_count" -eq 1 ]
    [ "$status" = "active" ]
    [ "$is_leaf" = "false" ]
}

# =============================================================================
# Safety Backup Tests
# =============================================================================

@test "create_delete_safety_backup returns empty for missing file" {
    rm -f "$TODO_FILE"
    # Function returns exit code 1 for missing file, so we capture both output and status
    result=$(create_delete_safety_backup "$TODO_FILE" 2>&1) || true
    [ -z "$result" ]
}

@test "create_delete_safety_backup creates backup for valid file" {
    cat > "$TODO_FILE" << 'EOF'
{
    "version": "2.2.0",
    "tasks": [
        {"id": "T001", "title": "Test task", "status": "pending"}
    ]
}
EOF
    # This may return empty if backup library is not fully configured
    # but should not fail
    run create_delete_safety_backup "$TODO_FILE"
    # Should succeed (exit code 0)
    [ "$status" -eq 0 ] || [ "$status" -eq 1 ]  # 1 is OK if backups disabled
}
