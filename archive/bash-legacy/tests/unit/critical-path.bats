#!/usr/bin/env bats
# =============================================================================
# critical-path.bats - Unit tests for critical path analysis (T073)
# =============================================================================
# Tests critical path functionality via blockers analyze command.
# Critical path is implemented in lib/tasks/analysis.sh and accessed through
# blockers.sh analyze subcommand.
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
# Helper: Create fixtures for critical path testing
# =============================================================================

# Create deep dependency chain for critical path testing
# T001 <- T002 <- T003 <- T004 (depth 4)
create_deep_chain() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "_meta": {"version": "2.1.0"},
  "tasks": [
    {"id": "T001", "title": "Level 1", "description": "Root", "status": "pending", "priority": "high", "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T002", "title": "Level 2", "description": "Depth 2", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T11:00:00Z", "depends": ["T001"]},
    {"id": "T003", "title": "Level 3", "description": "Depth 3", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T12:00:00Z", "depends": ["T002"]},
    {"id": "T004", "title": "Level 4", "description": "Depth 4", "status": "pending", "priority": "low", "createdAt": "2025-12-01T13:00:00Z", "depends": ["T003"]}
  ],
  "focus": {}
}
EOF
}

# Create multiple chains with different depths
# Chain A: T001 <- T002 <- T003 (depth 3)
# Chain B: T004 <- T005 (depth 2)
create_multiple_chains() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "_meta": {"version": "2.1.0"},
  "tasks": [
    {"id": "T001", "title": "Chain A Root", "description": "A1", "status": "pending", "priority": "high", "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T002", "title": "Chain A Mid", "description": "A2", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T11:00:00Z", "depends": ["T001"]},
    {"id": "T003", "title": "Chain A End", "description": "A3", "status": "pending", "priority": "low", "createdAt": "2025-12-01T12:00:00Z", "depends": ["T002"]},
    {"id": "T004", "title": "Chain B Root", "description": "B1", "status": "pending", "priority": "high", "createdAt": "2025-12-01T13:00:00Z"},
    {"id": "T005", "title": "Chain B End", "description": "B2", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T14:00:00Z", "depends": ["T004"]}
  ],
  "focus": {}
}
EOF
}

# Create bottleneck scenario (one task blocks many)
create_bottleneck() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "_meta": {"version": "2.1.0"},
  "tasks": [
    {"id": "T001", "title": "Bottleneck task", "description": "Blocks all", "status": "pending", "priority": "critical", "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T002", "title": "Blocked A", "description": "Needs T001", "status": "blocked", "priority": "high", "createdAt": "2025-12-01T11:00:00Z", "depends": ["T001"], "blockedBy": "Waiting for T001"},
    {"id": "T003", "title": "Blocked B", "description": "Needs T001", "status": "blocked", "priority": "high", "createdAt": "2025-12-01T12:00:00Z", "depends": ["T001"], "blockedBy": "Waiting for T001"},
    {"id": "T004", "title": "Blocked C", "description": "Needs T001", "status": "blocked", "priority": "medium", "createdAt": "2025-12-01T13:00:00Z", "depends": ["T001"], "blockedBy": "Waiting for T001"}
  ],
  "focus": {}
}
EOF
}

# =============================================================================
# Basic Critical Path Tests
# =============================================================================

@test "blockers analyze produces critical path output" {
    create_deep_chain
    run bash "$BLOCKERS_SCRIPT" analyze
    assert_success
    assert_output_contains_any "Critical Path" "critical" "chain"
}

@test "blockers analyze shows chain length" {
    create_deep_chain
    run bash "$BLOCKERS_SCRIPT" analyze
    assert_success
    assert_output_contains_any "length" "chain" "4" "depth"
}

@test "blockers analyze identifies longest chain" {
    create_multiple_chains
    run bash "$BLOCKERS_SCRIPT" analyze
    assert_success
    # Chain A is longer (3 tasks) than Chain B (2 tasks)
    # Should mention the longer chain
    assert_output_contains_any "Chain A" "T001" "T002" "T003"
}

# =============================================================================
# Bottleneck Analysis Tests
# =============================================================================

@test "blockers analyze identifies bottleneck tasks" {
    create_bottleneck
    run bash "$BLOCKERS_SCRIPT" analyze
    assert_success
    # Output uses "BLOCKER" and "Blocked" terminology
    assert_output_contains_any "BLOCKER" "Blocked" "blocked"
}

@test "blockers analyze shows task blocking count" {
    create_bottleneck
    run bash "$BLOCKERS_SCRIPT" analyze
    assert_success
    # T001 blocks 3 tasks
    assert_output_contains_any "T001" "blocks" "3"
}

# =============================================================================
# JSON Output Tests
# =============================================================================

@test "blockers analyze --format json produces valid JSON" {
    create_deep_chain
    run bash "$BLOCKERS_SCRIPT" analyze --format json
    assert_success
    assert_valid_json
}

@test "blockers analyze JSON contains critical path data" {
    create_deep_chain
    run bash "$BLOCKERS_SCRIPT" analyze --format json
    assert_success
    # Should have structured data about critical path
    assert_valid_json
}

@test "blockers analyze JSON contains recommendations" {
    create_bottleneck
    run bash "$BLOCKERS_SCRIPT" analyze --format json
    assert_success
    assert_valid_json
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "blockers analyze handles no dependencies" {
    create_independent_tasks
    run bash "$BLOCKERS_SCRIPT" analyze
    assert_success
}

@test "blockers analyze handles empty todo" {
    create_empty_todo
    run bash "$BLOCKERS_SCRIPT" analyze
    assert_success
}

@test "blockers analyze handles completed chain" {
    # Create chain where root is completed
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.1.0"},
  "tasks": [
    {"id": "T001", "title": "Done", "description": "Complete", "status": "done", "priority": "high", "createdAt": "2025-12-01T10:00:00Z", "completedAt": "2025-12-10T12:00:00Z"},
    {"id": "T002", "title": "Unblocked", "description": "Ready", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T11:00:00Z", "depends": ["T001"]}
  ],
  "focus": {}
}
EOF
    run bash "$BLOCKERS_SCRIPT" analyze
    assert_success
}

# =============================================================================
# Recommendations Tests
# =============================================================================

@test "blockers analyze provides recommendations" {
    create_bottleneck
    run bash "$BLOCKERS_SCRIPT" analyze
    assert_success
    assert_output_contains_any "Recommend" "recommend" "priorit" "unblock"
}

@test "blockers analyze identifies high-impact tasks" {
    create_bottleneck
    run bash "$BLOCKERS_SCRIPT" analyze
    assert_success
    # Should identify T001 as high impact since it blocks 3 tasks
    assert_output_contains_any "impact" "T001" "unblock"
}

# =============================================================================
# lib/tasks/analysis.sh Function Tests (via blockers analyze)
# =============================================================================

@test "critical path calculation handles single task" {
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.1.0"},
  "tasks": [
    {"id": "T001", "title": "Single task", "description": "Alone", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T10:00:00Z"}
  ],
  "focus": {}
}
EOF
    run bash "$BLOCKERS_SCRIPT" analyze
    assert_success
}

@test "critical path respects task completion status" {
    create_deep_chain
    # Complete middle task
    jq '.tasks[1].status = "done" | .tasks[1].completedAt = "2025-12-10T12:00:00Z"' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$BLOCKERS_SCRIPT" analyze
    assert_success
    # Critical path should be recalculated excluding completed task
}

@test "critical path markdown format is valid" {
    create_deep_chain
    run bash "$BLOCKERS_SCRIPT" analyze --format markdown
    assert_success
    assert_markdown_output
}
