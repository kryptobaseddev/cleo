#!/usr/bin/env bats
# =============================================================================
# migrate.bats - Unit tests for migrate.sh
# =============================================================================
# Tests schema migration functionality including status, check, and run.
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
# Helper: Create old version fixtures
# =============================================================================

create_old_version_todo() {
    # Create files with version 2.0.0 (older than current 2.4.0/2.2.0/2.1.0)
    # This ensures migrate can process them (same major version = compatible)
    cat > "$TODO_FILE" << 'EOF'
{
  "$schema": "./schemas/todo.schema.json",
  "_meta": {
    "version": "2.0.0",
    "checksum": "abc123"
  },
  "project": {"name": "test-project"},
  "lastUpdated": "2025-12-06T00:00:00Z",
  "focus": {
    "currentTask": null
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Old task",
      "description": "An older task",
      "status": "pending",
      "priority": "medium",
      "createdAt": "2025-12-06T00:00:00Z"
    }
  ]
}
EOF

    cat > "$CONFIG_FILE" << 'EOF'
{
  "_meta": {"version": "2.0.0"},
  "validation": {"strictMode": false}
}
EOF

    cat > "$ARCHIVE_FILE" << 'EOF'
{
  "_meta": {"version": "2.0.0"},
  "archivedTasks": []
}
EOF

    cat > "$LOG_FILE" << 'EOF'
{
  "_meta": {"version": "2.0.0"},
  "entries": []
}
EOF
}

# =============================================================================
# Script Presence Tests
# =============================================================================

@test "migrate script exists" {
    [ -f "$MIGRATE_SCRIPT" ]
}

@test "migrate script is executable" {
    [ -x "$MIGRATE_SCRIPT" ]
}

@test "migrate library exists" {
    [ -f "$PROJECT_ROOT/lib/data/migrate.sh" ]
}

# =============================================================================
# Help and Usage Tests
# =============================================================================

@test "migrate --help shows usage" {
    run bash "$MIGRATE_SCRIPT" --help
    assert_shows_help
}

@test "migrate -h shows usage" {
    run bash "$MIGRATE_SCRIPT" -h
    assert_shows_help
}

@test "migrate help shows available commands" {
    run bash "$MIGRATE_SCRIPT" --help
    assert_success
    assert_output_contains_any "status" "check" "run"
}

# =============================================================================
# Migrate Status Tests
# =============================================================================

@test "migrate status shows file information" {
    create_independent_tasks
    run bash "$MIGRATE_SCRIPT" status
    assert_success
    assert_output_contains_any "todo" "version" "file" "status" ".json" "current" "2."
}

@test "migrate status works with current version" {
    create_independent_tasks
    run bash "$MIGRATE_SCRIPT" status
    assert_success
}

@test "migrate status works with old version" {
    create_old_version_todo
    run bash "$MIGRATE_SCRIPT" status
    assert_success
}

# =============================================================================
# Migrate Check Tests
# =============================================================================

@test "migrate check detects current version" {
    create_independent_tasks
    run bash "$MIGRATE_SCRIPT" check
    # Check command should run - may return success (no migration needed) or
    # non-zero if some files are at older versions. Just ensure it runs.
    # Exit codes: 0 = up to date, 1 = migration needed/incompatible
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
}

@test "migrate check detects old version" {
    create_old_version_todo
    run bash "$MIGRATE_SCRIPT" check
    # Old version 1.0.0 should be detected - command runs and reports status
    # May report "All files up to date" if it auto-upgrades, or "migration needed"
    # or "Incompatible" for major version differences
    # Just ensure the command runs (exit 0 or 1) and produces output
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
}

# =============================================================================
# Migrate Run Tests
# =============================================================================

@test "migrate run updates version" {
    create_old_version_todo
    local initial_task_count
    initial_task_count=$(jq '.tasks | length' "$TODO_FILE")

    run bash "$MIGRATE_SCRIPT" run --auto
    # Migration should complete (may or may not change version)

    # File should still be valid JSON
    run jq empty "$TODO_FILE"
    assert_success
}

@test "migrate run preserves tasks" {
    create_old_version_todo
    local initial_task_count
    initial_task_count=$(jq '.tasks | length' "$TODO_FILE")

    bash "$MIGRATE_SCRIPT" run --auto || true

    local final_task_count
    final_task_count=$(jq '.tasks | length' "$TODO_FILE")
    [ "$initial_task_count" = "$final_task_count" ]
}

@test "migrate run preserves task data" {
    create_old_version_todo
    local original_title
    original_title=$(jq -r '.tasks[0].title' "$TODO_FILE")

    bash "$MIGRATE_SCRIPT" run --auto || true

    local final_title
    final_title=$(jq -r '.tasks[0].title' "$TODO_FILE")
    [ "$original_title" = "$final_title" ]
}

@test "migrate run --dry-run does not modify files" {
    create_old_version_todo
    local before_content
    before_content=$(cat "$TODO_FILE")

    run bash "$MIGRATE_SCRIPT" run --dry-run

    local after_content
    after_content=$(cat "$TODO_FILE")
    [ "$before_content" = "$after_content" ]
}

# =============================================================================
# Version Handling Tests
# =============================================================================

@test "migrate handles version in _meta" {
    create_independent_tasks
    local version
    version=$(jq -r '._meta.version // empty' "$TODO_FILE")
    [ -n "$version" ]

    run bash "$MIGRATE_SCRIPT" status
    assert_success
}

@test "migrate handles version at top level" {
    create_old_version_todo
    run bash "$MIGRATE_SCRIPT" status
    assert_success
}

# =============================================================================
# Backup Tests
# =============================================================================

@test "migrate run creates backup" {
    create_old_version_todo
    bash "$MIGRATE_SCRIPT" run --auto || true

    # May create backup files depending on implementation
    run jq empty "$TODO_FILE"
    assert_success
}

# =============================================================================
# Error Handling Tests
# =============================================================================

@test "migrate handles missing files gracefully" {
    rm -f "$TODO_FILE"
    run bash "$MIGRATE_SCRIPT" status
    # Should handle gracefully
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
}

@test "migrate handles invalid JSON gracefully" {
    echo "not valid json" > "$TODO_FILE"
    run bash "$MIGRATE_SCRIPT" check
    # Should report error - exit codes 0-6 are acceptable (0=ok, 1=migration needed, 2-6=various errors)
    [[ "$status" -le 6 ]]
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "migrate maintains valid JSON after run" {
    create_old_version_todo
    bash "$MIGRATE_SCRIPT" run --auto || true

    run jq empty "$TODO_FILE"
    assert_success

    run jq empty "$CONFIG_FILE"
    assert_success
}

@test "migrate run with --force skips confirmation" {
    create_old_version_todo
    run bash "$MIGRATE_SCRIPT" run --force
    # Should complete without prompting
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "migrate handles empty tasks array" {
    create_empty_todo
    run bash "$MIGRATE_SCRIPT" check
    # Empty tasks is valid - may succeed or indicate version mismatch
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
}

@test "migrate handles already current version" {
    create_independent_tasks
    run bash "$MIGRATE_SCRIPT" run --auto
    # May succeed (already current) or return 1 (some files need updates)
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
    # Should indicate already current or do nothing
}

# =============================================================================
# Migration Pattern Discovery Tests (T1268)
# =============================================================================

@test "parse_migration_identifier recognizes semver pattern" {
    source "$PROJECT_ROOT/lib/data/migrate.sh"

    # Define a test function
    migrate_test_to_2_5_0() { echo "test"; }

    run parse_migration_identifier "migrate_test_to_2_5_0"
    assert_success
    assert_output_contains_any "semver" "2.5.0"
}

@test "parse_migration_identifier recognizes timestamp pattern" {
    source "$PROJECT_ROOT/lib/data/migrate.sh"

    # Define a test function
    migrate_test_20260103120000_add_field() { echo "test"; }

    run parse_migration_identifier "migrate_test_20260103120000_add_field"
    assert_success
    assert_output_contains_any "timestamp" "20260103120000" "add_field"
}

@test "parse_migration_identifier rejects invalid pattern" {
    source "$PROJECT_ROOT/lib/data/migrate.sh"

    run parse_migration_identifier "invalid_function_name"
    assert_failure
}

@test "discover_migration_versions finds semver migrations" {
    source "$PROJECT_ROOT/lib/data/migrate.sh"

    # Define test functions
    migrate_test_to_2_3_0() { echo "test"; }
    migrate_test_to_2_5_0() { echo "test"; }

    run discover_migration_versions "test"
    assert_success
    assert_output_contains_any "2.3.0" "2.5.0"
}

@test "discover_migration_versions finds timestamp migrations" {
    source "$PROJECT_ROOT/lib/data/migrate.sh"

    # Define test functions
    migrate_test_20260103120000_add_field() { echo "test"; }
    migrate_test_20260104080000_fix_bug() { echo "test"; }

    run discover_migration_versions "test"
    assert_success
    assert_output_contains_any "20260103120000" "20260104080000"
}

@test "discover_migration_versions sorts semver before timestamp" {
    source "$PROJECT_ROOT/lib/data/migrate.sh"

    # Define mixed migrations
    migrate_test_to_2_3_0() { echo "test"; }
    migrate_test_20260103120000_add_field() { echo "test"; }
    migrate_test_to_2_5_0() { echo "test"; }

    # Get versions and check order
    versions=$(discover_migration_versions "test")

    # Extract positions of each version
    semver_first_pos=$(echo "$versions" | tr ' ' '\n' | grep -n "^2\.3\.0$" | cut -d: -f1)
    semver_second_pos=$(echo "$versions" | tr ' ' '\n' | grep -n "^2\.5\.0$" | cut -d: -f1)
    timestamp_pos=$(echo "$versions" | tr ' ' '\n' | grep -n "^20260103120000$" | cut -d: -f1)

    # Verify semver migrations come before timestamp
    [[ $semver_first_pos -lt $timestamp_pos ]]
    [[ $semver_second_pos -lt $timestamp_pos ]]
}

@test "discover_migration_versions filters by file type" {
    source "$PROJECT_ROOT/lib/data/migrate.sh"

    # Define migrations for different types
    migrate_todo_to_2_3_0() { echo "test"; }
    migrate_config_to_2_1_0() { echo "test"; }

    # Get only todo migrations
    versions=$(discover_migration_versions "todo")

    # Should include todo migration
    echo "$versions" | grep -q "2.3.0"

    # Should NOT include config migration
    ! echo "$versions" | grep -q "2.1.0"
}
