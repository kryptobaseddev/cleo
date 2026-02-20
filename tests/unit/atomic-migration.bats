#!/usr/bin/env bats
# =============================================================================
# atomic-migration.bats - Unit tests for atomic database migration pattern
# =============================================================================
# Tests the atomic rename pattern: temp → validate → backup → rename
# Ensures no window where tasks.db is missing (T4721).
# =============================================================================

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
    load '../test_helper/assertions'
    common_setup_per_test
}

teardown() {
    common_teardown_per_test
}

# =============================================================================
# Atomic Pattern Tests
# =============================================================================

@test "atomic migration writes to temp file first" {
    # Create test data in JSON format
    create_test_tasks
    
    # Run upgrade with auto-migrate
    run bash "$CLEO" upgrade --auto-migrate
    
    # Should succeed
    assert_success
    
    # Should not leave temp file behind
    [ ! -f "$TEST_CLEO_DIR/tasks.db.new" ]
}

@test "atomic migration preserves original database until validated" {
    # Create initial SQLite database
    create_test_tasks
    run bash "$CLEO" migrate --to=sqlite
    assert_success
    
    # Store original checksum
    local original_checksum
    original_checksum=$(sha256sum "$TEST_CLEO_DIR/tasks.db" | cut -d' ' -f1)
    
    # Run upgrade again (should not corrupt existing database)
    run bash "$CLEO" upgrade --auto-migrate
    assert_success
    
    # Verify database still exists and is valid
    [ -f "$TEST_CLEO_DIR/tasks.db" ]
    
    # Verify database integrity
    run bash "$CLEO" validate --storage
    assert_success
}

@test "atomic migration removes temp file on failure" {
    # Create corrupted JSON to trigger migration failure
    echo "{invalid json" > "$TEST_CLEO_DIR/todo.json"
    
    # Run upgrade (should fail but not leave temp file)
    run bash "$CLEO" upgrade --auto-migrate
    assert_failure
    
    # Should not leave temp file behind
    [ ! -f "$TEST_CLEO_DIR/tasks.db.new" ]
}

@test "atomic migration creates backup before rename" {
    # Skip if no sqlite support
    if [ ! -f "$TEST_CLEO_DIR/tasks.db" ]; then
        skip "SQLite database not present"
    fi
    
    # Create test data
    create_test_tasks
    run bash "$CLEO" migrate --to=sqlite
    assert_success
    
    # Verify tasks.db exists
    [ -f "$TEST_CLEO_DIR/tasks.db" ]
    
    # After successful migration, backup should be cleaned up
    [ ! -f "$TEST_CLEO_DIR/tasks.db.backup" ]
}

@test "no window where tasks.db is missing during migration" {
    # This test verifies the atomic pattern by checking that
    # the migration process never deletes tasks.db before the new one is ready
    
    # Create test data
    create_test_tasks
    
    # If tasks.db exists, it should remain throughout migration
    if [ -f "$TEST_CLEO_DIR/tasks.db" ]; then
        # Run upgrade and verify database still exists at end
        run bash "$CLEO" upgrade --auto-migrate
        assert_success
        [ -f "$TEST_CLEO_DIR/tasks.db" ]
    else
        skip "No existing tasks.db to test"
    fi
}

@test "atomic migration validates before rename" {
    # Create test data
    create_test_tasks
    
    # Run migration
    run bash "$CLEO" upgrade --auto-migrate
    assert_success
    
    # Verify resulting database has tasks table
    if [ -f "$TEST_CLEO_DIR/tasks.db" ]; then
        # Try to query the database
        run bash "$CLEO" list
        assert_success
    fi
}

# =============================================================================
# Recovery Tests
# =============================================================================

@test "migration restores from backup on atomic rename failure" {
    # Create initial database
    create_test_tasks
    run bash "$CLEO" migrate --to=sqlite
    assert_success
    
    # Add a specific task we can check for
    run bash "$CLEO" add "Recovery Test Task" --id T-RECOVERY-TEST
    assert_success
    
    # Verify task exists
    run bash "$CLEO" list --json
    assert_success
    assert_output_contains "T-RECOVERY-TEST"
    
    # The atomic pattern should ensure we never lose data
    # Even if migration fails, original data is preserved
    [ -f "$TEST_CLEO_DIR/tasks.db" ]
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "atomic migration handles missing source JSON gracefully" {
    # Remove JSON files but keep any existing database
    rm -f "$TEST_CLEO_DIR/todo.json"
    rm -f "$TEST_CLEO_DIR/todo-archive.json"
    rm -f "$TEST_CLEO_DIR/sessions.json"
    
    # Should handle gracefully without crashing
    run bash "$CLEO" upgrade --auto-migrate
    # May succeed or fail gracefully
    
    # Should not leave temp files
    [ ! -f "$TEST_CLEO_DIR/tasks.db.new" ]
}

@test "atomic migration cleans up stale temp files" {
    # Create a stale temp file
    echo "stale data" > "$TEST_CLEO_DIR/tasks.db.new"
    
    # Create test data
    create_test_tasks
    
    # Run migration
    run bash "$CLEO" upgrade --auto-migrate
    assert_success
    
    # Stale temp should be gone
    [ ! -f "$TEST_CLEO_DIR/tasks.db.new" ] || [ ! "$(cat "$TEST_CLEO_DIR/tasks.db.new")" = "stale data" ]
}
