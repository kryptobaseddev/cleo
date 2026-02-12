#!/usr/bin/env bats
# =============================================================================
# sequence.bats - Unit tests for task ID sequence system (lib/core/sequence.sh)
# =============================================================================
# Tests the robust task ID generation system that provides O(1) ID generation
# and prevents ID reuse after archiving.
#
# Key functionality tested:
# - Sequence file creation and initialization
# - Atomic increment operations
# - Recovery from missing/corrupted files
# - Checksum validation
# - Concurrent access handling (limited in BATS)
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    common_setup_per_test

    # Determine project root from test file location
    TEST_FILE_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
    PROJECT_ROOT="$(cd "$TEST_FILE_DIR/../.." && pwd)"

    # Source required libraries (order matters)
    source "$PROJECT_ROOT/lib/core/exit-codes.sh"
    source "$PROJECT_ROOT/lib/core/platform-compat.sh"

    # Use BATS-managed temp directory (auto-cleaned)
    TEST_DIR="${BATS_TEST_TMPDIR}"
    CLEO_DIR="$TEST_DIR/.cleo"
    mkdir -p "$CLEO_DIR"

    # Set up environment variables
    export CLEO_DIR
    export TODO_FILE="$CLEO_DIR/todo.json"
    export ARCHIVE_FILE="$CLEO_DIR/todo-archive.json"

    # Create empty todo.json
    cat > "$CLEO_DIR/todo.json" << 'EOF'
{
  "_meta": {
    "schemaVersion": "2.6.0",
    "checksum": "d751713988987e93"
  },
  "tasks": []
}
EOF

    # Create empty archive
    cat > "$CLEO_DIR/todo-archive.json" << 'EOF'
{
  "_meta": {
    "schemaVersion": "2.6.0"
  },
  "archivedTasks": []
}
EOF

    # Change to test directory
    cd "$TEST_DIR"

    # Source sequence library
    source "$PROJECT_ROOT/lib/core/sequence.sh"
}

teardown() {
    common_teardown_per_test
    # Return to project root before cleanup
    cd "$PROJECT_ROOT" 2>/dev/null || true
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Initialization Tests
# =============================================================================

@test "init_sequence creates sequence file when missing" {
    # Ensure no sequence file exists
    rm -f "$CLEO_DIR/.sequence"
    [[ ! -f "$CLEO_DIR/.sequence" ]]

    # Initialize sequence
    run init_sequence
    [[ $status -eq 0 ]]

    # Sequence file should now exist
    [[ -f "$CLEO_DIR/.sequence" ]]
}

@test "init_sequence sets counter to 0 for empty project" {
    rm -f "$CLEO_DIR/.sequence"

    run init_sequence
    [[ $status -eq 0 ]]

    # Read counter value
    local counter
    counter=$(jq -r '.counter' "$CLEO_DIR/.sequence")
    [[ "$counter" -eq 0 ]]
}

@test "init_sequence scans existing tasks for max ID" {
    # Add some tasks to todo.json
    jq '.tasks = [
        {"id": "T001", "title": "Task 1"},
        {"id": "T042", "title": "Task 42"},
        {"id": "T015", "title": "Task 15"}
    ]' "$CLEO_DIR/todo.json" > "$CLEO_DIR/todo.json.tmp"
    mv "$CLEO_DIR/todo.json.tmp" "$CLEO_DIR/todo.json"

    rm -f "$CLEO_DIR/.sequence"

    run init_sequence
    [[ $status -eq 0 ]]

    # Counter should be max ID (42)
    local counter
    counter=$(jq -r '.counter' "$CLEO_DIR/.sequence")
    [[ "$counter" -eq 42 ]]
}

@test "init_sequence considers archived tasks" {
    # Add task to archive with higher ID
    jq '.archivedTasks = [
        {"id": "T100", "title": "Archived task"}
    ]' "$CLEO_DIR/todo-archive.json" > "$CLEO_DIR/todo-archive.json.tmp"
    mv "$CLEO_DIR/todo-archive.json.tmp" "$CLEO_DIR/todo-archive.json"

    # Add lower ID task to current todo
    jq '.tasks = [
        {"id": "T010", "title": "Current task"}
    ]' "$CLEO_DIR/todo.json" > "$CLEO_DIR/todo.json.tmp"
    mv "$CLEO_DIR/todo.json.tmp" "$CLEO_DIR/todo.json"

    rm -f "$CLEO_DIR/.sequence"

    run init_sequence
    [[ $status -eq 0 ]]

    # Counter should be max from archive (100)
    local counter
    counter=$(jq -r '.counter' "$CLEO_DIR/.sequence")
    [[ "$counter" -eq 100 ]]
}

# =============================================================================
# ID Generation Tests
# =============================================================================

@test "get_next_task_id returns T1 for empty project" {
    rm -f "$CLEO_DIR/.sequence"

    run get_next_task_id
    [[ $status -eq 0 ]]
    [[ "$output" == "T001" ]]
}

@test "get_next_task_id increments counter each call" {
    rm -f "$CLEO_DIR/.sequence"

    # First call
    run get_next_task_id
    [[ $status -eq 0 ]]
    [[ "$output" == "T001" ]]

    # Second call
    run get_next_task_id
    [[ $status -eq 0 ]]
    [[ "$output" == "T002" ]]

    # Third call
    run get_next_task_id
    [[ $status -eq 0 ]]
    [[ "$output" == "T003" ]]
}

@test "get_next_task_id continues from existing max ID" {
    # Set up project with existing tasks
    jq '.tasks = [
        {"id": "T050", "title": "Existing task"}
    ]' "$CLEO_DIR/todo.json" > "$CLEO_DIR/todo.json.tmp"
    mv "$CLEO_DIR/todo.json.tmp" "$CLEO_DIR/todo.json"

    rm -f "$CLEO_DIR/.sequence"

    run get_next_task_id
    [[ $status -eq 0 ]]
    [[ "$output" == "T051" ]]
}

@test "get_next_task_id never reuses archived IDs" {
    # Archive a task with ID T100
    jq '.archivedTasks = [
        {"id": "T100", "title": "Archived"}
    ]' "$CLEO_DIR/todo-archive.json" > "$CLEO_DIR/todo-archive.json.tmp"
    mv "$CLEO_DIR/todo-archive.json.tmp" "$CLEO_DIR/todo-archive.json"

    rm -f "$CLEO_DIR/.sequence"

    # New ID should be T101, not T1
    run get_next_task_id
    [[ $status -eq 0 ]]
    [[ "$output" == "T101" ]]
}

# =============================================================================
# Checksum Validation Tests
# =============================================================================

@test "write_sequence creates valid checksum" {
    run write_sequence 42
    [[ $status -eq 0 ]]

    # Verify checksum exists
    local checksum
    checksum=$(jq -r '.checksum' "$CLEO_DIR/.sequence")
    [[ -n "$checksum" ]]
    [[ "$checksum" != "null" ]]

    # Checksum should be 8 characters
    [[ ${#checksum} -eq 8 ]]
}

@test "read_sequence detects checksum mismatch" {
    # Write valid sequence
    write_sequence 42

    # Corrupt the counter without updating checksum
    jq '.counter = 999' "$CLEO_DIR/.sequence" > "$CLEO_DIR/.sequence.tmp"
    mv "$CLEO_DIR/.sequence.tmp" "$CLEO_DIR/.sequence"

    # Read should fail with checksum error
    run read_sequence
    [[ $status -eq $SEQ_CHECKSUM_MISMATCH ]]
}

@test "validate_sequence recovers from checksum mismatch" {
    # Add a task so recovery finds something
    jq '.tasks = [{"id": "T025", "title": "Task"}]' "$CLEO_DIR/todo.json" > "$CLEO_DIR/todo.json.tmp"
    mv "$CLEO_DIR/todo.json.tmp" "$CLEO_DIR/todo.json"

    # Write sequence and corrupt checksum
    write_sequence 10
    jq '.checksum = "invalid1"' "$CLEO_DIR/.sequence" > "$CLEO_DIR/.sequence.tmp"
    mv "$CLEO_DIR/.sequence.tmp" "$CLEO_DIR/.sequence"

    # Validate should recover
    run validate_sequence
    [[ $status -eq 0 ]]

    # Counter should now be 25 (from task scan)
    local counter
    counter=$(jq -r '.counter' "$CLEO_DIR/.sequence")
    [[ "$counter" -eq 25 ]]
}

# =============================================================================
# Recovery Tests
# =============================================================================

@test "recover_sequence creates file when missing" {
    rm -f "$CLEO_DIR/.sequence"

    run recover_sequence
    [[ $status -eq 0 ]]
    [[ -f "$CLEO_DIR/.sequence" ]]
}

@test "recover_sequence sets recoveredAt timestamp" {
    rm -f "$CLEO_DIR/.sequence"

    run recover_sequence
    [[ $status -eq 0 ]]

    local recovered_at
    recovered_at=$(jq -r '.recoveredAt' "$CLEO_DIR/.sequence")
    [[ "$recovered_at" != "null" ]]
    [[ "$recovered_at" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T ]]
}

@test "recover_sequence handles corrupted JSON" {
    # Write invalid JSON
    echo "not valid json {" > "$CLEO_DIR/.sequence"

    # Add task for reference
    jq '.tasks = [{"id": "T005", "title": "Task"}]' "$CLEO_DIR/todo.json" > "$CLEO_DIR/todo.json.tmp"
    mv "$CLEO_DIR/todo.json.tmp" "$CLEO_DIR/todo.json"

    run validate_sequence
    [[ $status -eq 0 ]]

    # Should have valid JSON now
    run jq empty "$CLEO_DIR/.sequence"
    [[ $status -eq 0 ]]

    # Counter should be 5
    local counter
    counter=$(jq -r '.counter' "$CLEO_DIR/.sequence")
    [[ "$counter" -eq 5 ]]
}

@test "get_next_task_id auto-recovers from missing sequence file" {
    rm -f "$CLEO_DIR/.sequence"

    # Add existing task
    jq '.tasks = [{"id": "T020", "title": "Task"}]' "$CLEO_DIR/todo.json" > "$CLEO_DIR/todo.json.tmp"
    mv "$CLEO_DIR/todo.json.tmp" "$CLEO_DIR/todo.json"

    # get_next_task_id should handle missing file
    run get_next_task_id
    [[ $status -eq 0 ]]
    [[ "$output" == "T021" ]]
}

# =============================================================================
# Counter Behind Detection Tests
# =============================================================================

@test "validate_sequence detects counter behind max ID" {
    # Set up sequence with low counter
    write_sequence 10

    # Add task with higher ID
    jq '.tasks = [{"id": "T050", "title": "Higher ID"}]' "$CLEO_DIR/todo.json" > "$CLEO_DIR/todo.json.tmp"
    mv "$CLEO_DIR/todo.json.tmp" "$CLEO_DIR/todo.json"

    run validate_sequence
    [[ $status -eq 0 ]]

    # Counter should be updated to 50
    local counter
    counter=$(jq -r '.counter' "$CLEO_DIR/.sequence")
    [[ "$counter" -eq 50 ]]
}

@test "get_next_task_id handles counter behind scenario" {
    # Set low counter
    write_sequence 5

    # Add higher ID task
    jq '.tasks = [{"id": "T030", "title": "Higher"}]' "$CLEO_DIR/todo.json" > "$CLEO_DIR/todo.json.tmp"
    mv "$CLEO_DIR/todo.json.tmp" "$CLEO_DIR/todo.json"

    # Should return T31, not T6
    run get_next_task_id
    [[ $status -eq 0 ]]
    [[ "$output" == "T031" ]]
}

# =============================================================================
# Sequence File Format Tests
# =============================================================================

@test "sequence file has correct JSON structure" {
    write_sequence 42

    # Verify all required fields exist
    run jq -e '.counter' "$CLEO_DIR/.sequence"
    [[ $status -eq 0 ]]

    run jq -e '.lastId' "$CLEO_DIR/.sequence"
    [[ $status -eq 0 ]]

    run jq -e '.checksum' "$CLEO_DIR/.sequence"
    [[ $status -eq 0 ]]

    run jq -e '.updatedAt' "$CLEO_DIR/.sequence"
    [[ $status -eq 0 ]]
}

@test "lastId field matches counter format" {
    write_sequence 123

    local last_id
    last_id=$(jq -r '.lastId' "$CLEO_DIR/.sequence")
    [[ "$last_id" == "T123" ]]
}

@test "updatedAt is valid ISO timestamp" {
    write_sequence 1

    local updated_at
    updated_at=$(jq -r '.updatedAt' "$CLEO_DIR/.sequence")
    [[ "$updated_at" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

# =============================================================================
# Helper Function Tests
# =============================================================================

@test "get_current_sequence returns 0 for missing file" {
    rm -f "$CLEO_DIR/.sequence"

    run get_current_sequence
    [[ $status -eq 0 ]]
    [[ "$output" == "0" ]]
}

@test "get_current_sequence returns counter value" {
    write_sequence 77

    run get_current_sequence
    [[ $status -eq 0 ]]
    [[ "$output" == "77" ]]
}

@test "_reset_sequence sets counter to specified value" {
    _reset_sequence 500

    local counter
    counter=$(jq -r '.counter' "$CLEO_DIR/.sequence")
    [[ "$counter" -eq 500 ]]
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "handles large task IDs correctly" {
    # Set up with large ID
    jq '.tasks = [{"id": "T99999", "title": "Large ID"}]' "$CLEO_DIR/todo.json" > "$CLEO_DIR/todo.json.tmp"
    mv "$CLEO_DIR/todo.json.tmp" "$CLEO_DIR/todo.json"

    rm -f "$CLEO_DIR/.sequence"

    run get_next_task_id
    [[ $status -eq 0 ]]
    [[ "$output" == "T100000" ]]
}

@test "handles mixed ID formats gracefully" {
    # Some projects might have varied ID formats
    jq '.tasks = [
        {"id": "T001", "title": "Padded"},
        {"id": "T42", "title": "Unpadded"},
        {"id": "T0100", "title": "More padding"}
    ]' "$CLEO_DIR/todo.json" > "$CLEO_DIR/todo.json.tmp"
    mv "$CLEO_DIR/todo.json.tmp" "$CLEO_DIR/todo.json"

    rm -f "$CLEO_DIR/.sequence"

    run get_next_task_id
    [[ $status -eq 0 ]]
    [[ "$output" == "T101" ]]
}

@test "handles empty tasks array" {
    jq '.tasks = []' "$CLEO_DIR/todo.json" > "$CLEO_DIR/todo.json.tmp"
    mv "$CLEO_DIR/todo.json.tmp" "$CLEO_DIR/todo.json"

    rm -f "$CLEO_DIR/.sequence"

    run get_next_task_id
    [[ $status -eq 0 ]]
    [[ "$output" == "T001" ]]
}

@test "handles missing todo.json gracefully" {
    rm -f "$CLEO_DIR/todo.json"
    rm -f "$CLEO_DIR/.sequence"

    # Should still work, returning T1
    run get_next_task_id
    [[ $status -eq 0 ]]
    [[ "$output" == "T001" ]]
}

# =============================================================================
# Locking Tests (Limited - BATS runs single-threaded)
# =============================================================================

@test "lock file is created during ID generation" {
    rm -f "$CLEO_DIR/.sequence"
    rm -f "$CLEO_DIR/.sequence.lock"

    # Generate an ID
    get_next_task_id >/dev/null

    # Lock file should exist (created by locking mechanism)
    [[ -f "$CLEO_DIR/.sequence.lock" ]]
}

@test "multiple sequential calls produce unique IDs" {
    rm -f "$CLEO_DIR/.sequence"

    local ids=()
    for i in {1..10}; do
        id=$(get_next_task_id)
        ids+=("$id")
    done

    # All IDs should be unique
    local unique_count
    unique_count=$(printf '%s\n' "${ids[@]}" | sort -u | wc -l)
    [[ $unique_count -eq 10 ]]

    # IDs should be T001 through T010
    [[ "${ids[0]}" == "T001" ]]
    [[ "${ids[9]}" == "T010" ]]
}
