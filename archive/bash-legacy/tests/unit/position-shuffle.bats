#!/usr/bin/env bats
# Unit tests for position shuffle logic (T805)

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test
    # Create temp directory for test files
    TEST_DIR="$(mktemp -d)"
    export CLEO_DIR="$TEST_DIR/.cleo"
    export TODO_FILE="$CLEO_DIR/todo.json"
    mkdir -p "$CLEO_DIR"

    # Initialize with basic structure
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.6.0",
  "project": { "name": "test" },
  "lastUpdated": "2026-01-01T00:00:00Z",
  "_meta": { "schemaVersion": "2.6.0", "checksum": "test123" },
  "tasks": []
}
EOF

    # Source hierarchy functions for position helpers
    source "${BATS_TEST_DIRNAME}/../../lib/tasks/hierarchy.sh"
}

teardown() {
    rm -rf "$TEST_DIR"
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Position Helper Functions Tests
# =============================================================================

@test "get_max_position returns 0 for empty parent" {
    run get_max_position "null" "$TODO_FILE"
    assert_success
    assert_output "0"
}

@test "get_max_position returns correct max for root tasks" {
    # Add tasks with positions
    jq '.tasks = [
        {"id":"T001","title":"First","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:00Z","position":1},
        {"id":"T002","title":"Second","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:01Z","position":2},
        {"id":"T003","title":"Third","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:02Z","position":3}
    ]' "$TODO_FILE" > "$TODO_FILE.tmp" && mv "$TODO_FILE.tmp" "$TODO_FILE"

    run get_max_position "null" "$TODO_FILE"
    assert_success
    assert_output "3"
}

@test "get_max_position returns correct max for child tasks" {
    jq '.tasks = [
        {"id":"T001","title":"Epic","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:00Z","type":"epic","position":1},
        {"id":"T002","title":"Child 1","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:01Z","parentId":"T001","position":1},
        {"id":"T003","title":"Child 2","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:02Z","parentId":"T001","position":2}
    ]' "$TODO_FILE" > "$TODO_FILE.tmp" && mv "$TODO_FILE.tmp" "$TODO_FILE"

    run get_max_position "T001" "$TODO_FILE"
    assert_success
    assert_output "2"
}

@test "get_next_position returns 1 for empty parent" {
    run get_next_position "null" "$TODO_FILE"
    assert_success
    assert_output "1"
}

@test "get_next_position returns max+1 for existing tasks" {
    jq '.tasks = [
        {"id":"T001","title":"First","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:00Z","position":1},
        {"id":"T002","title":"Second","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:01Z","position":2}
    ]' "$TODO_FILE" > "$TODO_FILE.tmp" && mv "$TODO_FILE.tmp" "$TODO_FILE"

    run get_next_position "null" "$TODO_FILE"
    assert_success
    assert_output "3"
}

@test "get_task_position returns position for task with position" {
    jq '.tasks = [
        {"id":"T001","title":"First","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:00Z","position":5}
    ]' "$TODO_FILE" > "$TODO_FILE.tmp" && mv "$TODO_FILE.tmp" "$TODO_FILE"

    run get_task_position "T001" "$TODO_FILE"
    assert_success
    assert_output "5"
}

@test "get_task_position returns null for task without position" {
    jq '.tasks = [
        {"id":"T001","title":"First","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:00Z"}
    ]' "$TODO_FILE" > "$TODO_FILE.tmp" && mv "$TODO_FILE.tmp" "$TODO_FILE"

    run get_task_position "T001" "$TODO_FILE"
    assert_success
    assert_output "null"
}

@test "get_siblings_with_positions returns sorted siblings" {
    jq '.tasks = [
        {"id":"T003","title":"Third","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:02Z","position":3},
        {"id":"T001","title":"First","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:00Z","position":1},
        {"id":"T002","title":"Second","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:01Z","position":2}
    ]' "$TODO_FILE" > "$TODO_FILE.tmp" && mv "$TODO_FILE.tmp" "$TODO_FILE"

    run get_siblings_with_positions "null" "$TODO_FILE"
    assert_success

    # Verify order: T001 (pos 1), T002 (pos 2), T003 (pos 3)
    first_id=$(echo "$output" | jq -r '.[0].id')
    second_id=$(echo "$output" | jq -r '.[1].id')
    third_id=$(echo "$output" | jq -r '.[2].id')

    assert_equal "$first_id" "T001"
    assert_equal "$second_id" "T002"
    assert_equal "$third_id" "T003"
}

@test "validate_position_sequence passes for valid sequence" {
    jq '.tasks = [
        {"id":"T001","title":"First","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:00Z","position":1},
        {"id":"T002","title":"Second","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:01Z","position":2},
        {"id":"T003","title":"Third","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:02Z","position":3}
    ]' "$TODO_FILE" > "$TODO_FILE.tmp" && mv "$TODO_FILE.tmp" "$TODO_FILE"

    run validate_position_sequence "null" "$TODO_FILE"
    assert_success
}

@test "validate_position_sequence fails for gap in sequence" {
    jq '.tasks = [
        {"id":"T001","title":"First","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:00Z","position":1},
        {"id":"T003","title":"Third","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:02Z","position":3}
    ]' "$TODO_FILE" > "$TODO_FILE.tmp" && mv "$TODO_FILE.tmp" "$TODO_FILE"

    run validate_position_sequence "null" "$TODO_FILE"
    assert_failure
}

@test "validate_position_sequence fails for duplicate positions" {
    jq '.tasks = [
        {"id":"T001","title":"First","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:00Z","position":1},
        {"id":"T002","title":"Second","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:01Z","position":1}
    ]' "$TODO_FILE" > "$TODO_FILE.tmp" && mv "$TODO_FILE.tmp" "$TODO_FILE"

    run validate_position_sequence "null" "$TODO_FILE"
    assert_failure
}

# =============================================================================
# Position Invariant Tests
# =============================================================================

@test "positions are per-parent scope (independent sequences)" {
    jq '.tasks = [
        {"id":"T001","title":"Epic 1","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:00Z","type":"epic","position":1},
        {"id":"T002","title":"Epic 2","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:01Z","type":"epic","position":2},
        {"id":"T003","title":"Child 1 of E1","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:02Z","parentId":"T001","position":1},
        {"id":"T004","title":"Child 2 of E1","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:03Z","parentId":"T001","position":2},
        {"id":"T005","title":"Child 1 of E2","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:04Z","parentId":"T002","position":1}
    ]' "$TODO_FILE" > "$TODO_FILE.tmp" && mv "$TODO_FILE.tmp" "$TODO_FILE"

    # Root level should have max 2
    run get_max_position "null" "$TODO_FILE"
    assert_output "2"

    # T001 children should have max 2
    run get_max_position "T001" "$TODO_FILE"
    assert_output "2"

    # T002 children should have max 1
    run get_max_position "T002" "$TODO_FILE"
    assert_output "1"
}
