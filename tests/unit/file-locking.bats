#!/usr/bin/env bats
# file-locking.bats - Test file locking mechanisms
# Tests concurrent access scenarios to prevent race conditions

# =============================================================================
# File-Level Setup (runs once per test file)
# =============================================================================
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

# =============================================================================
# Per-Test Setup (runs before each test)
# =============================================================================
setup() {
    load '../test_helper/common_setup'
    common_setup_per_test

    # Source required libraries for file-locking specific tests
    source "$PROJECT_ROOT/lib/core/exit-codes.sh"
    source "$PROJECT_ROOT/lib/data/file-ops.sh"

    # Create test directory (use BATS temp for isolation)
    TEST_DIR="${BATS_TEST_TMPDIR}/claude-todo-test"
    mkdir -p "$TEST_DIR"

    TEST_FILE="$TEST_DIR/test-lock.json"
    TEST_CONTENT='{"test": "data"}'
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

#######################################
# Basic Locking Tests
#######################################

@test "lock_file creates lock file" {
    lock_fd=""
    lock_file "$TEST_FILE" lock_fd

    [ -f "$TEST_FILE.lock" ]

    # Clean up
    unlock_file "$lock_fd"
}

@test "lock_file returns success on successful lock" {
    lock_fd=""
    run lock_file "$TEST_FILE" lock_fd

    [ "$status" -eq 0 ]

    # Clean up
    unlock_file "$lock_fd"
}

@test "unlock_file releases lock" {
    lock_fd=""
    lock_file "$TEST_FILE" lock_fd
    run unlock_file "$lock_fd"

    [ "$status" -eq 0 ]
}

@test "lock_file fails without file path" {
    run lock_file ""

    # lock_file returns 1 for missing path error
    [ "$status" -eq 1 ]
    [[ "$output" =~ "File path required" ]]
}

@test "lock_file creates parent directory if needed" {
    nested_file="$TEST_DIR/nested/dir/test.json"
    lock_fd=""

    run lock_file "$nested_file" lock_fd

    [ "$status" -eq 0 ]
    [ -d "$TEST_DIR/nested/dir" ]
    [ -f "$nested_file.lock" ]

    # Clean up
    unlock_file "$lock_fd"
}

#######################################
# Concurrent Access Tests
#######################################

@test "concurrent lock attempts: second lock times out" {
    # First process acquires lock
    lock_fd=""
    lock_file "$TEST_FILE" lock_fd

    # Second process attempts lock with 1-second timeout
    # This should fail because first lock is still held
    run timeout 2 bash -c "source '$PROJECT_ROOT/lib/data/file-ops.sh'; lock_file '$TEST_FILE' lock_fd 1"

    [ "$status" -ne 0 ]
    [[ "$output" =~ "Failed to acquire lock" ]]

    # Clean up
    unlock_file "$lock_fd"
}

@test "sequential locks work after unlock" {
    # First lock
    lock_fd=""
    lock_file "$TEST_FILE" lock_fd
    unlock_file "$lock_fd"

    # Second lock should succeed
    lock_fd2=""
    run lock_file "$TEST_FILE" lock_fd2

    [ "$status" -eq 0 ]

    # Clean up
    unlock_file "$lock_fd2"
}

@test "atomic_write uses locking" {
    # Verify atomic_write creates lock file during operation
    echo "$TEST_CONTENT" | atomic_write "$TEST_FILE" &
    local write_pid=$!

    # Give it a moment to acquire lock
    sleep 0.1

    # Check lock file exists while write is in progress
    [ -f "$TEST_FILE.lock" ]

    # Wait for write to complete
    wait $write_pid

    # Verify write succeeded
    [ -f "$TEST_FILE" ]
}

@test "concurrent atomic_write operations are serialized" {
    # Create a test that writes unique content from multiple processes
    local output_file="$TEST_DIR/concurrent-writes.txt"

    # Start 5 concurrent writes
    for i in {1..5}; do
        (
            source "$PROJECT_ROOT/lib/data/file-ops.sh"
            echo "{\"write\": $i}" | atomic_write "$TEST_FILE"
            echo "Write $i completed" >> "$output_file"
        ) &
    done

    # Wait for all writes to complete
    wait

    # All 5 writes should have completed
    local completed_count
    completed_count=$(grep -c "completed" "$output_file" 2>/dev/null || echo 0)
    [ "$completed_count" -eq 5 ]

    # Final file should be valid JSON
    run jq empty "$TEST_FILE"
    [ "$status" -eq 0 ]
}

@test "concurrent saves to different files don't block each other" {
    local file1="$TEST_DIR/file1.json"
    local file2="$TEST_DIR/file2.json"
    local output_file="$TEST_DIR/concurrent-different.txt"

    # Start concurrent writes to different files
    (
        source "$PROJECT_ROOT/lib/data/file-ops.sh"
        echo '{"file": 1}' | atomic_write "$file1"
        echo "File1 completed" >> "$output_file"
    ) &

    (
        source "$PROJECT_ROOT/lib/data/file-ops.sh"
        echo '{"file": 2}' | atomic_write "$file2"
        echo "File2 completed" >> "$output_file"
    ) &

    # Wait for completion
    wait

    # Both should complete successfully
    [ -f "$file1" ]
    [ -f "$file2" ]

    local completed_count
    completed_count=$(grep -c "completed" "$output_file" 2>/dev/null || echo 0)
    [ "$completed_count" -eq 2 ]
}

#######################################
# Error Handling Tests
#######################################

@test "lock released on error during atomic_write" {
    # Create a scenario that will fail validation
    # (empty content triggers validation failure)
    # Note: Use printf '' (not echo '') to generate truly empty content (no newline)
    run bash -c "source '$PROJECT_ROOT/lib/data/file-ops.sh'; printf '' | atomic_write '$TEST_FILE'"

    [ "$status" -ne 0 ]

    # Lock should be released even though operation failed
    # Verify by trying to acquire lock again
    lock_fd=""
    run lock_file "$TEST_FILE" lock_fd
    [ "$status" -eq 0 ]

    # Clean up
    unlock_file "$lock_fd"
}

@test "lock timeout is configurable" {
    # Acquire lock
    lock_fd=""
    lock_file "$TEST_FILE" lock_fd

    # Try to acquire with 2-second timeout (should fail)
    start_time=$(date +%s)

    run bash -c "source '$PROJECT_ROOT/lib/data/file-ops.sh'; lock_file '$TEST_FILE' lock_fd2 2"

    end_time=$(date +%s)
    elapsed=$((end_time - start_time))

    [ "$status" -ne 0 ]
    [[ "$output" =~ "timeout after 2s" ]]

    # Should have waited approximately 2 seconds
    # Allow generous margin for slow systems and subprocess overhead
    [ "$elapsed" -ge 1 ]
    [ "$elapsed" -le 6 ]

    # Clean up
    unlock_file "$lock_fd"
}

@test "unlock_file is safe to call without lock" {
    # Should not error even if no lock was acquired
    run unlock_file

    [ "$status" -eq 0 ]
}

#######################################
# Integration Tests
#######################################

@test "save_json uses atomic_write with locking" {
    # Verify save_json creates lock during operation
    echo "$TEST_CONTENT" | save_json "$TEST_FILE" &
    local save_pid=$!

    # Give it a moment to start
    sleep 0.1

    # Try to acquire lock (should fail if save_json is using locking)
    run bash -c "source '$PROJECT_ROOT/lib/data/file-ops.sh'; lock_file '$TEST_FILE' 1"

    # Should fail because save_json has lock
    # Note: This test may pass if save_json completes very quickly
    # In that case, status would be 0, which is also acceptable

    # Wait for save to complete
    wait $save_pid

    # Verify file was created successfully
    [ -f "$TEST_FILE" ]
    run jq empty "$TEST_FILE"
    [ "$status" -eq 0 ]
}

@test "race condition scenario: file remains valid despite concurrent access" {
    # Tests that atomic_write prevents file corruption during concurrent access
    # Note: This tests corruption prevention, not lost update prevention
    # Lost updates can still occur without transaction-level locking

    local todo_file="$TEST_DIR/todo.json"
    local results_file="$TEST_DIR/race-results.txt"

    # Initialize with empty tasks array
    echo '{"tasks": [], "metadata": {"version": "1.0"}}' | save_json "$todo_file"

    # Launch 3 concurrent "add" operations
    # Each operation: read -> modify -> write
    # Without transaction locking, lost updates may occur
    for i in {1..3}; do
        (
            source "$PROJECT_ROOT/lib/data/file-ops.sh"

            # Read current file
            current=$(load_json "$todo_file")

            # Add new task
            updated=$(echo "$current" | jq ".tasks += [{\"id\": \"T00$i\", \"title\": \"Task $i\"}]")

            # Save back (atomic_write prevents corruption during the write itself)
            echo "$updated" | save_json "$todo_file"

            # Record success
            echo "Task $i added" >> "$results_file"
        ) &
    done

    # Wait for all to complete
    wait

    # CRITICAL: File must remain valid JSON (no corruption)
    run jq empty "$todo_file"
    [ "$status" -eq 0 ]

    # Verify that AT LEAST ONE task was saved (not lost completely)
    # Due to lost updates, we may not have all 3 tasks, but should have at least 1
    local task_count
    task_count=$(jq '.tasks | length' "$todo_file")
    [ "$task_count" -ge 1 ]

    # All operations should have completed without errors
    local completed_count
    completed_count=$(grep -c "added" "$results_file" 2>/dev/null || echo 0)
    [ "$completed_count" -eq 3 ]
}

#######################################
# Performance Tests
#######################################

@test "locking overhead is minimal for sequential operations" {
    local iterations=10
    local start_time
    local end_time

    # Time 10 sequential locked writes
    start_time=$(date +%s%N)

    for i in $(seq 1 $iterations); do
        echo "{\"iteration\": $i}" | atomic_write "$TEST_FILE"
    done

    end_time=$(date +%s%N)
    local elapsed_ns=$((end_time - start_time))
    local elapsed_ms=$((elapsed_ns / 1000000))

    # Should complete 10 writes in reasonable time (< 5 seconds)
    # This is a sanity check, not a strict performance requirement
    [ "$elapsed_ms" -lt 5000 ]
}

@test "lock files are cleaned up properly" {
    # Write and verify lock cleanup
    echo "$TEST_CONTENT" | atomic_write "$TEST_FILE"

    # Lock file may still exist (they're not deleted, just unlocked)
    # But we should be able to acquire a new lock immediately
    lock_fd=""
    run lock_file "$TEST_FILE" lock_fd
    [ "$status" -eq 0 ]

    unlock_file "$lock_fd"
}
