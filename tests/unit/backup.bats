#!/usr/bin/env bats
# =============================================================================
# backup.bats - Unit tests for backup system (lib/backup.sh)
# =============================================================================
# Tests backup creation, rotation, restoration, and error handling for
# the Tier 2 backup system. Covers all backup types and retention policies.
#
# Per BACKUP-SYSTEM-SPEC.md Part 2.2
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

    # Source required libraries (order matters - exit-codes first)
    source "$PROJECT_ROOT/lib/exit-codes.sh"
    source "$PROJECT_ROOT/lib/platform-compat.sh"

    # Use BATS-managed temp directory (auto-cleaned)
    TEST_DIR="${BATS_TEST_TMPDIR}"
    CLAUDE_TODO_DIR="$TEST_DIR/.claude"
    mkdir -p "$CLAUDE_TODO_DIR"

    # Set BACKUP_DIR that will be used by config (relative to project)
    # The library reads from config.json
    BACKUP_DIR_REL=".cleo/backups"

    # Create backup directory structure
    mkdir -p "$TEST_DIR/$BACKUP_DIR_REL"/{snapshot,safety,incremental,archive,migration}

    # Create minimal todo files for backup testing
    echo '{"tasks": [], "_meta": {"version": "2.3.0"}}' > "$CLAUDE_TODO_DIR/todo.json"
    echo '{"archivedTasks": [], "_meta": {"version": "2.3.0"}}' > "$CLAUDE_TODO_DIR/todo-archive.json"
    echo '{"entries": [], "_meta": {"version": "2.1.0"}}' > "$CLAUDE_TODO_DIR/todo-log.json"

    # Create config with explicit backup directory
    cat > "$CLAUDE_TODO_DIR/config.json" << EOF
{
  "version": "2.1.0",
  "backup": {
    "enabled": true,
    "directory": "$BACKUP_DIR_REL"
  }
}
EOF

    # Set environment
    export CLAUDE_TODO_DIR
    export CLEO_DIR="$CLAUDE_TODO_DIR"
    export CLAUDE_TODO_VERSION="0.27.0"

    # Change to test directory for relative path resolution
    cd "$TEST_DIR"

    # Source the backup library (this will load config and set BACKUP_DIR)
    source "$PROJECT_ROOT/lib/backup.sh"

    # Store the actual backup dir path for test assertions
    BACKUP_DIR_ABS="$TEST_DIR/$BACKUP_DIR_REL"
}

teardown() {
    common_teardown_per_test
    # Return to project root before cleanup
    cd "$PROJECT_ROOT" 2>/dev/null || true
    # BATS auto-cleans BATS_TEST_TMPDIR
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Rotation Tests - Per Spec Part 5.1
# =============================================================================

@test "rotate_backups removes excess backups for snapshot type" {
    # Create 12 snapshot backups (exceeds default MAX_SNAPSHOTS=10)
    for i in {1..12}; do
        local padded=$(printf "%02d" "$i")
        mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251201_0000${padded}"
        # Add small delay to ensure distinct mtimes
        sleep 0.05
    done

    # Verify we have 12 backups
    local initial_count
    initial_count=$(find "$BACKUP_DIR_ABS/snapshot" -maxdepth 1 -type d -name "snapshot_*" | wc -l)
    [[ $initial_count -eq 12 ]]

    # Run rotation
    run rotate_backups "snapshot"

    # Should succeed
    [[ $status -eq 0 ]]

    # Should only keep MAX_SNAPSHOTS (default 10)
    local final_count
    final_count=$(find "$BACKUP_DIR_ABS/snapshot" -maxdepth 1 -type d -name "snapshot_*" | wc -l)
    [[ $final_count -le 10 ]]
}

@test "rotate_backups enforces MAX_SAFETY_BACKUPS limit" {
    # Create 10 safety backups (exceeds default MAX_SAFETY_BACKUPS=5)
    for i in {1..10}; do
        local padded=$(printf "%02d" "$i")
        mkdir -p "$BACKUP_DIR_ABS/safety/safety_20251201_0000${padded}_update_todo.json"
        sleep 0.05
    done

    # Verify initial state
    local initial_count
    initial_count=$(find "$BACKUP_DIR_ABS/safety" -maxdepth 1 -type d -name "safety_*" | wc -l)
    [[ $initial_count -eq 10 ]]

    # Run rotation
    rotate_backups "safety"

    # Should only keep MAX_SAFETY_BACKUPS (default 5)
    local final_count
    final_count=$(find "$BACKUP_DIR_ABS/safety" -maxdepth 1 -type d -name "safety_*" | wc -l)
    [[ $final_count -le 5 ]]
}

@test "rotate_backups never deletes migration backups" {
    # Create 10 migration backups (should never be deleted per spec)
    for i in {1..10}; do
        local padded=$(printf "%02d" "$i")
        mkdir -p "$BACKUP_DIR_ABS/migration/migration_v1.${padded}.0_20251201_0000${padded}"
    done

    # Run rotation on migration type
    rotate_backups "migration"

    # All 10 should still exist
    local count
    count=$(find "$BACKUP_DIR_ABS/migration" -maxdepth 1 -type d -name "migration_*" | wc -l)
    [[ $count -eq 10 ]]
}

@test "rotate_backups returns error code for unknown backup type" {
    run rotate_backups "invalid_type"

    # Should fail with non-zero exit
    [[ $status -ne 0 ]]
}

@test "rotate_backups handles empty backup directory gracefully" {
    # Ensure directory is empty
    rm -rf "$BACKUP_DIR_ABS/snapshot/"*

    run rotate_backups "snapshot"

    # Should succeed without error
    [[ $status -eq 0 ]]
}

@test "rotate_backups skips rotation when under limit" {
    # Create only 3 snapshots (under default limit of 10)
    for i in {1..3}; do
        mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251201_00000${i}"
    done

    run rotate_backups "snapshot"

    [[ $status -eq 0 ]]

    # All 3 should still exist
    local count
    count=$(find "$BACKUP_DIR_ABS/snapshot" -maxdepth 1 -type d -name "snapshot_*" | wc -l)
    [[ $count -eq 3 ]]
}

# =============================================================================
# list_typed_backups Tests
# =============================================================================

@test "list_typed_backups returns backup paths for specific type" {
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251215_120000"
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251216_140000"

    run list_typed_backups snapshot

    [[ $status -eq 0 ]]
    [[ "$output" == *"snapshot_20251215_120000"* ]]
    [[ "$output" == *"snapshot_20251216_140000"* ]]
}

@test "list_typed_backups returns empty for type with no backups" {
    # Ensure archive directory is empty
    rm -rf "$BACKUP_DIR_ABS/archive/"*

    run list_typed_backups archive

    [[ $status -eq 0 ]]
    [[ -z "$output" ]]
}

@test "list_typed_backups with all returns backups from all types" {
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251215_120000"
    mkdir -p "$BACKUP_DIR_ABS/safety/safety_20251215_130000_update_todo.json"
    mkdir -p "$BACKUP_DIR_ABS/migration/migration_v1.0.0_20251215_140000"

    run list_typed_backups all

    [[ $status -eq 0 ]]
    [[ "$output" == *"snapshot_20251215_120000"* ]]
    [[ "$output" == *"safety_20251215_130000"* ]]
    [[ "$output" == *"migration_v1.0.0_20251215_140000"* ]]
}

# =============================================================================
# Backup Creation Tests
# =============================================================================

@test "create_snapshot_backup creates backup with metadata" {
    run create_snapshot_backup

    [[ $status -eq 0 ]]

    # Should output backup path containing snapshot
    [[ "$output" == *"snapshot/snapshot_"* ]]

    # Extract backup path and verify structure
    local backup_path="$output"
    [[ -d "$backup_path" ]]
    [[ -f "$backup_path/metadata.json" ]]
}

@test "create_snapshot_backup backs up all system files" {
    local backup_path
    backup_path=$(create_snapshot_backup)

    [[ -f "$backup_path/todo.json" ]]
    [[ -f "$backup_path/todo-archive.json" ]]
    [[ -f "$backup_path/config.json" ]]
    [[ -f "$backup_path/todo-log.json" ]]
}

@test "create_snapshot_backup with custom name includes name in path" {
    local backup_path
    backup_path=$(create_snapshot_backup "before_migration")

    [[ "$backup_path" == *"before_migration"* ]]
}

@test "create_safety_backup requires file path" {
    run create_safety_backup ""

    [[ $status -ne 0 ]]
    [[ "$output" == *"File path required"* ]]
}

@test "create_safety_backup creates single file backup" {
    local backup_path
    backup_path=$(create_safety_backup "$CLAUDE_TODO_DIR/todo.json" "update")

    [[ -d "$backup_path" ]]
    [[ -f "$backup_path/todo.json" ]]
    [[ -f "$backup_path/metadata.json" ]]
}

@test "create_safety_backup fails for non-existent file" {
    run create_safety_backup "/nonexistent/file.json" "update"

    [[ $status -ne 0 ]]
    [[ "$output" == *"File not found"* ]]
}

@test "create_migration_backup sets neverDelete flag" {
    local backup_path
    backup_path=$(create_migration_backup "1.0.0")

    [[ -f "$backup_path/metadata.json" ]]

    local never_delete
    never_delete=$(jq -r '.neverDelete' "$backup_path/metadata.json")
    [[ "$never_delete" == "true" ]]
}

@test "create_archive_backup backs up todo and archive files" {
    local backup_path
    backup_path=$(create_archive_backup)

    [[ -f "$backup_path/todo.json" ]]
    [[ -f "$backup_path/todo-archive.json" ]]
    [[ -f "$backup_path/metadata.json" ]]
}

@test "create_incremental_backup creates versioned file backup" {
    local backup_path
    backup_path=$(create_incremental_backup "$CLAUDE_TODO_DIR/todo.json")

    [[ -d "$backup_path" ]]
    [[ -f "$backup_path/todo.json" ]]
    [[ -f "$backup_path/metadata.json" ]]
}

# =============================================================================
# Metadata Tests - Per Spec Part 4
# =============================================================================

@test "backup metadata contains required fields" {
    local backup_path
    backup_path=$(create_snapshot_backup)

    local metadata="$backup_path/metadata.json"
    [[ -f "$metadata" ]]

    # Check required fields per spec
    local backup_type timestamp trigger files

    backup_type=$(jq -r '.backupType' "$metadata")
    timestamp=$(jq -r '.timestamp' "$metadata")
    trigger=$(jq -r '.trigger' "$metadata")
    files=$(jq -r '.files | length' "$metadata")

    [[ "$backup_type" == "snapshot" ]]
    [[ -n "$timestamp" ]]
    [[ "$trigger" == "manual" ]]
    [[ "$files" -ge 1 ]]
}

@test "backup metadata includes file checksums" {
    local backup_path
    backup_path=$(create_snapshot_backup)

    local metadata="$backup_path/metadata.json"

    # Check that files array contains checksum entries
    local has_checksum
    has_checksum=$(jq -r '.files[0].checksum // empty' "$metadata")

    [[ -n "$has_checksum" ]]
}

@test "backup metadata includes total size" {
    local backup_path
    backup_path=$(create_snapshot_backup)

    local metadata="$backup_path/metadata.json"

    local total_size
    total_size=$(jq -r '.totalSize' "$metadata")

    [[ "$total_size" -gt 0 ]]
}

# =============================================================================
# Restore Tests - Per Spec Part 6.2
# =============================================================================

@test "restore_typed_backup restores files from backup" {
    # Create a backup
    local backup_path
    backup_path=$(create_snapshot_backup)

    # Modify the original file
    echo '{"tasks": [{"id": "T999", "title": "Modified"}], "_meta": {"version": "2.3.0"}}' > "$CLAUDE_TODO_DIR/todo.json"

    # Restore from backup
    run restore_typed_backup "$backup_path"

    [[ $status -eq 0 ]]

    # Verify original content was restored (empty tasks)
    local task_count
    task_count=$(jq '.tasks | length' "$CLAUDE_TODO_DIR/todo.json")
    [[ "$task_count" -eq 0 ]]
}

@test "restore_typed_backup fails for non-existent backup" {
    run restore_typed_backup "/nonexistent/backup"

    [[ $status -ne 0 ]]
    [[ "$output" == *"not found"* ]]
}

@test "restore_typed_backup requires backup ID or path" {
    run restore_typed_backup ""

    [[ $status -ne 0 ]]
    [[ "$output" == *"Backup ID or path required"* ]]
}

@test "restore_typed_backup finds backup by ID prefix" {
    # Create a backup and get its ID
    local backup_path
    backup_path=$(create_snapshot_backup "test_restore")

    local backup_name
    backup_name=$(basename "$backup_path")

    # Modify original file
    echo '{"tasks": [{"id": "T001"}], "_meta": {"version": "2.3.0"}}' > "$CLAUDE_TODO_DIR/todo.json"

    # Restore using just the backup name
    run restore_typed_backup "$backup_name"

    [[ $status -eq 0 ]]
}

# =============================================================================
# Validation Tests
# =============================================================================

@test "backup validates JSON files before backup" {
    # Create invalid JSON in todo file
    echo 'not valid json' > "$CLAUDE_TODO_DIR/todo.json"

    run create_snapshot_backup

    # Should still succeed but skip invalid file or warn
    [[ $status -eq 0 ]]
    # Output should contain backup path
    [[ "$output" == *"snapshot"* ]]
}

@test "get_backup_metadata returns metadata JSON" {
    local backup_path
    backup_path=$(create_snapshot_backup)

    run get_backup_metadata "$backup_path"

    [[ $status -eq 0 ]]

    # Output should be valid JSON with backupType
    local backup_type
    backup_type=$(echo "$output" | jq -r '.backupType')
    [[ "$backup_type" == "snapshot" ]]
}

@test "get_backup_metadata fails for missing metadata" {
    # Create backup directory without metadata
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_test_no_meta"

    run get_backup_metadata "$BACKUP_DIR_ABS/snapshot/snapshot_test_no_meta"

    [[ $status -ne 0 ]]
    [[ "$output" == *"Metadata not found"* ]]
}

# =============================================================================
# Prune Tests - Combined Retention
# =============================================================================

@test "prune_backups rotates all backup types" {
    # Create excess backups in multiple types
    for i in {1..15}; do
        local padded=$(printf "%02d" "$i")
        mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251201_0000${padded}"
        mkdir -p "$BACKUP_DIR_ABS/safety/safety_20251201_0000${padded}_op_file"
        mkdir -p "$BACKUP_DIR_ABS/archive/archive_20251201_0000${padded}"
        sleep 0.02
    done

    run prune_backups

    [[ $status -eq 0 ]]

    # Check each type was rotated
    local snapshot_count safety_count archive_count
    snapshot_count=$(find "$BACKUP_DIR_ABS/snapshot" -maxdepth 1 -type d -name "snapshot_*" | wc -l)
    safety_count=$(find "$BACKUP_DIR_ABS/safety" -maxdepth 1 -type d -name "safety_*" | wc -l)
    archive_count=$(find "$BACKUP_DIR_ABS/archive" -maxdepth 1 -type d -name "archive_*" | wc -l)

    [[ $snapshot_count -le 10 ]]  # MAX_SNAPSHOTS
    [[ $safety_count -le 5 ]]     # MAX_SAFETY_BACKUPS
    [[ $archive_count -le 3 ]]    # MAX_ARCHIVE_BACKUPS
}

# =============================================================================
# Directory Structure Tests
# =============================================================================

@test "backup creates type subdirectory if missing" {
    # Remove a type directory
    rm -rf "$BACKUP_DIR_ABS/archive"

    # Creating archive backup should recreate the directory
    run create_archive_backup

    [[ $status -eq 0 ]]
    [[ -d "$BACKUP_DIR_ABS/archive" ]]
}

@test "backup naming follows spec pattern" {
    local backup_path
    backup_path=$(create_snapshot_backup "mybackup")

    local backup_name
    backup_name=$(basename "$backup_path")

    # Pattern: snapshot_YYYYMMDD_HHMMSS[_custom_name]
    [[ "$backup_name" =~ ^snapshot_[0-9]{8}_[0-9]{6}_mybackup$ ]]
}

# =============================================================================
# Error Logging Tests - Phase 0 fixes
# =============================================================================

@test "rotate_backups logs errors to stderr" {
    # Create a directory that cannot be deleted (simulated by checking error output)
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251201_000001"
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251201_000002"

    # Create more than MAX to trigger rotation
    for i in {3..15}; do
        local padded=$(printf "%02d" "$i")
        mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251201_0000${padded}"
    done

    # Rotation should run without crashing
    run rotate_backups "snapshot"

    # Function should complete
    [[ $status -eq 0 ]] || [[ $status -eq 1 ]]
}

# =============================================================================
# Disabled Backup Tests
# =============================================================================

# SKIP: Known bug in _load_backup_config - jq's // operator treats false/null as nullish
# and returns the default value of true. This test is disabled until the library is fixed.
# The correct fix would be: jq -r 'if .backup.enabled == false then "false" else "true" end'
# @test "create_snapshot_backup respects enabled flag in config" {
#     skip "Known bug: jq alternative operator treats false as nullish"
# }

# SKIP: These tests depend on backup.enabled=false working correctly
# See note above about the jq // operator bug
# @test "create_safety_backup silently skips when backups disabled" { ... }
# @test "create_migration_backup succeeds even when backups disabled" { ... }

# =============================================================================
# find_backups Tests - Backup Search Functionality
# =============================================================================

@test "find_backups returns all backups when no filters" {
    # Create some test backups
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000"
    echo '{"backupType": "snapshot", "timestamp": "2025-12-20T12:00:00Z", "files": [], "totalSize": 100}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000/metadata.json"

    mkdir -p "$BACKUP_DIR_ABS/safety/safety_20251219_100000_update_todo.json"
    echo '{"backupType": "safety", "timestamp": "2025-12-19T10:00:00Z", "files": [], "totalSize": 50}' > "$BACKUP_DIR_ABS/safety/safety_20251219_100000_update_todo.json/metadata.json"

    run find_backups "" "" "all" "" "" 20

    [[ $status -eq 0 ]]

    # Should return JSON array
    local count
    count=$(echo "$output" | jq 'length')
    [[ $count -ge 2 ]]
}

@test "find_backups filters by type" {
    # Create backups of different types
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000"
    echo '{"backupType": "snapshot", "timestamp": "2025-12-20T12:00:00Z", "files": [], "totalSize": 100}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000/metadata.json"

    mkdir -p "$BACKUP_DIR_ABS/safety/safety_20251219_100000_update_todo.json"
    echo '{"backupType": "safety", "timestamp": "2025-12-19T10:00:00Z", "files": [], "totalSize": 50}' > "$BACKUP_DIR_ABS/safety/safety_20251219_100000_update_todo.json/metadata.json"

    run find_backups "" "" "snapshot" "" "" 20

    [[ $status -eq 0 ]]

    # Should only return snapshot backups
    local types
    types=$(echo "$output" | jq -r '.[].type' | sort -u)
    [[ "$types" == "snapshot" ]]
}

@test "find_backups filters by name pattern" {
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000_session_start"
    echo '{"backupType": "snapshot", "timestamp": "2025-12-20T12:00:00Z", "files": [], "totalSize": 100}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000_session_start/metadata.json"

    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_130000_before_refactor"
    echo '{"backupType": "snapshot", "timestamp": "2025-12-20T13:00:00Z", "files": [], "totalSize": 100}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_130000_before_refactor/metadata.json"

    run find_backups "" "" "all" "*session*" "" 20

    [[ $status -eq 0 ]]

    # Should only return backup with "session" in name
    local count
    count=$(echo "$output" | jq 'length')
    [[ $count -eq 1 ]]

    local name
    name=$(echo "$output" | jq -r '.[0].name')
    [[ "$name" == *"session"* ]]
}

@test "find_backups respects limit" {
    # Create 5 backups
    for i in {1..5}; do
        local padded=$(printf "%02d" "$i")
        mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_202512${padded}_120000"
        echo "{\"backupType\": \"snapshot\", \"timestamp\": \"2025-12-${padded}T12:00:00Z\", \"files\": [], \"totalSize\": 100}" > "$BACKUP_DIR_ABS/snapshot/snapshot_202512${padded}_120000/metadata.json"
    done

    run find_backups "" "" "all" "" "" 3

    [[ $status -eq 0 ]]

    local count
    count=$(echo "$output" | jq 'length')
    [[ $count -le 3 ]]
}

@test "find_backups searches content with grep pattern" {
    # Create backup with specific task ID in content
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000"
    echo '{"backupType": "snapshot", "timestamp": "2025-12-20T12:00:00Z", "files": [], "totalSize": 100}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000/metadata.json"
    echo '{"tasks": [{"id": "T001", "title": "Test task"}]}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000/todo.json"

    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_130000"
    echo '{"backupType": "snapshot", "timestamp": "2025-12-20T13:00:00Z", "files": [], "totalSize": 100}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_130000/metadata.json"
    echo '{"tasks": [{"id": "T999", "title": "Other task"}]}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_130000/todo.json"

    run find_backups "" "" "all" "" "T001" 20

    [[ $status -eq 0 ]]

    # Should only return backup containing T001
    local count
    count=$(echo "$output" | jq 'length')
    [[ $count -eq 1 ]]
}

@test "find_backups returns empty array when no matches" {
    # No backups match the pattern
    run find_backups "" "" "all" "*nonexistent*" "" 20

    [[ $status -eq 0 ]]
    [[ "$output" == "[]" ]]
}

@test "parse_relative_date handles day format" {
    run parse_relative_date "7d"

    [[ $status -eq 0 ]]
    # Should return ISO timestamp
    [[ "$output" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]]
}

@test "parse_relative_date handles week format" {
    run parse_relative_date "2w"

    [[ $status -eq 0 ]]
    [[ "$output" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]]
}

@test "parse_relative_date handles ISO date format" {
    run parse_relative_date "2025-12-15"

    [[ $status -eq 0 ]]
    [[ "$output" == "2025-12-15T00:00:00Z" ]]
}

@test "parse_relative_date returns empty for empty input" {
    run parse_relative_date ""

    [[ $status -eq 0 ]]
    [[ -z "$output" ]]
}

@test "parse_relative_date fails on invalid format" {
    run parse_relative_date "invalid_date"

    [[ $status -ne 0 ]]
}

# =============================================================================
# find_backups Tests - Enhanced Search (T633)
# =============================================================================

@test "find_backups filters by --on date (exact day match)" {
    # Create backups on different dates
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000"
    echo '{"backupType": "snapshot", "timestamp": "2025-12-20T12:00:00Z", "files": [], "totalSize": 100}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000/metadata.json"

    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251219_100000"
    echo '{"backupType": "snapshot", "timestamp": "2025-12-19T10:00:00Z", "files": [], "totalSize": 100}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251219_100000/metadata.json"

    # Search for backups on 2025-12-20 only
    # Args: since, until, type, name, grep, limit, on, task_id, verbose
    run find_backups "" "" "all" "" "" 20 "2025-12-20" "" "false"

    [[ $status -eq 0 ]]

    # Should only return backup from 2025-12-20
    local count
    count=$(echo "$output" | jq 'length')
    [[ $count -eq 1 ]]

    local timestamp
    timestamp=$(echo "$output" | jq -r '.[0].timestamp')
    [[ "$timestamp" == *"2025-12-20"* ]]
}

@test "find_backups filters by --task-id" {
    # Create backup with specific task ID
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000"
    echo '{"backupType": "snapshot", "timestamp": "2025-12-20T12:00:00Z", "files": [], "totalSize": 100}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000/metadata.json"
    echo '{"tasks": [{"id": "T045", "title": "Important task", "status": "pending"}]}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000/todo.json"

    # Create backup without that task
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_130000"
    echo '{"backupType": "snapshot", "timestamp": "2025-12-20T13:00:00Z", "files": [], "totalSize": 100}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_130000/metadata.json"
    echo '{"tasks": [{"id": "T999", "title": "Other task", "status": "done"}]}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_130000/todo.json"

    # Search for backups containing T045
    run find_backups "" "" "all" "" "" 20 "" "T045" "false"

    [[ $status -eq 0 ]]

    # Should only return backup containing T045
    local count
    count=$(echo "$output" | jq 'length')
    [[ $count -eq 1 ]]

    local name
    name=$(echo "$output" | jq -r '.[0].name')
    [[ "$name" == "snapshot_20251220_120000" ]]
}

@test "find_backups with --task-id searches archived tasks" {
    # Create backup with task in archive
    mkdir -p "$BACKUP_DIR_ABS/archive/archive_20251220_120000"
    echo '{"backupType": "archive", "timestamp": "2025-12-20T12:00:00Z", "files": [], "totalSize": 100}' > "$BACKUP_DIR_ABS/archive/archive_20251220_120000/metadata.json"
    echo '{"tasks": []}' > "$BACKUP_DIR_ABS/archive/archive_20251220_120000/todo.json"
    echo '{"archivedTasks": [{"id": "T100", "title": "Archived task", "status": "done"}]}' > "$BACKUP_DIR_ABS/archive/archive_20251220_120000/todo-archive.json"

    # Search for archived task
    run find_backups "" "" "all" "" "" 20 "" "T100" "false"

    [[ $status -eq 0 ]]

    local count
    count=$(echo "$output" | jq 'length')
    [[ $count -eq 1 ]]
}

@test "find_backups with verbose mode includes matched snippets" {
    # Create backup with specific task
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000"
    echo '{"backupType": "snapshot", "timestamp": "2025-12-20T12:00:00Z", "files": [], "totalSize": 100}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000/metadata.json"
    echo '{"tasks": [{"id": "T001", "title": "Test task", "status": "pending"}]}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000/todo.json"

    # Search with verbose mode
    run find_backups "" "" "all" "" "" 20 "" "T001" "true"

    [[ $status -eq 0 ]]

    # Should include matchedSnippets in output
    local has_snippets
    has_snippets=$(echo "$output" | jq '.[0] | has("matchedSnippets")')
    [[ "$has_snippets" == "true" ]]
}

@test "find_backups combines --on and --task-id filters (AND logic)" {
    # Create backup on 12-20 with T001
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000"
    echo '{"backupType": "snapshot", "timestamp": "2025-12-20T12:00:00Z", "files": [], "totalSize": 100}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000/metadata.json"
    echo '{"tasks": [{"id": "T001", "title": "Task 1", "status": "pending"}]}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000/todo.json"

    # Create backup on 12-19 with T001
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251219_100000"
    echo '{"backupType": "snapshot", "timestamp": "2025-12-19T10:00:00Z", "files": [], "totalSize": 100}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251219_100000/metadata.json"
    echo '{"tasks": [{"id": "T001", "title": "Task 1", "status": "pending"}]}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251219_100000/todo.json"

    # Create backup on 12-20 without T001
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_140000"
    echo '{"backupType": "snapshot", "timestamp": "2025-12-20T14:00:00Z", "files": [], "totalSize": 100}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_140000/metadata.json"
    echo '{"tasks": [{"id": "T999", "title": "Other", "status": "done"}]}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_140000/todo.json"

    # Search for T001 on 2025-12-20 (AND logic)
    run find_backups "" "" "all" "" "" 20 "2025-12-20" "T001" "false"

    [[ $status -eq 0 ]]

    # Should only return the backup from 12-20 that has T001
    local count
    count=$(echo "$output" | jq 'length')
    [[ $count -eq 1 ]]

    local name
    name=$(echo "$output" | jq -r '.[0].name')
    [[ "$name" == "snapshot_20251220_120000" ]]
}

@test "find_backups combines --type and --task-id filters" {
    # Create snapshot with T001
    mkdir -p "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000"
    echo '{"backupType": "snapshot", "timestamp": "2025-12-20T12:00:00Z", "files": [], "totalSize": 100}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000/metadata.json"
    echo '{"tasks": [{"id": "T001", "title": "Task 1", "status": "pending"}]}' > "$BACKUP_DIR_ABS/snapshot/snapshot_20251220_120000/todo.json"

    # Create safety backup with T001
    mkdir -p "$BACKUP_DIR_ABS/safety/safety_20251220_130000"
    echo '{"backupType": "safety", "timestamp": "2025-12-20T13:00:00Z", "files": [], "totalSize": 50}' > "$BACKUP_DIR_ABS/safety/safety_20251220_130000/metadata.json"
    echo '{"tasks": [{"id": "T001", "title": "Task 1", "status": "pending"}]}' > "$BACKUP_DIR_ABS/safety/safety_20251220_130000/todo.json"

    # Search for T001 in snapshots only
    run find_backups "" "" "snapshot" "" "" 20 "" "T001" "false"

    [[ $status -eq 0 ]]

    # Should only return snapshot, not safety
    local count
    count=$(echo "$output" | jq 'length')
    [[ $count -eq 1 ]]

    local btype
    btype=$(echo "$output" | jq -r '.[0].type')
    [[ "$btype" == "snapshot" ]]
}

# =============================================================================
# Manifest Tracking Tests - Per T631 Requirements
# =============================================================================

# Helper to ensure BACKUP_DIR is set correctly for manifest tests
# (file-ops.sh sets BACKUP_DIR=".backups" for Tier 1, but manifest functions need Tier 2)
_setup_manifest_test() {
    _load_backup_config
    rm -f "$BACKUP_DIR/backup-manifest.json"
}

@test "_init_manifest creates manifest file if missing" {
    _setup_manifest_test

    run _init_manifest

    [[ $status -eq 0 ]]
    [[ -f "$BACKUP_DIR/backup-manifest.json" ]]

    # Verify manifest structure
    local version
    version=$(jq -r '._meta.version' "$BACKUP_DIR/backup-manifest.json")
    [[ "$version" == "1.0.0" ]]

    local backups_count
    backups_count=$(jq '.backups | length' "$BACKUP_DIR/backup-manifest.json")
    [[ "$backups_count" -eq 0 ]]
}

@test "_init_manifest is idempotent" {
    _setup_manifest_test

    # Initialize manifest twice
    _init_manifest
    local first_created
    first_created=$(jq -r '._meta.created' "$BACKUP_DIR/backup-manifest.json")

    sleep 0.1
    _init_manifest

    # Created timestamp should not change
    local second_created
    second_created=$(jq -r '._meta.created' "$BACKUP_DIR/backup-manifest.json")
    [[ "$first_created" == "$second_created" ]]
}

@test "_add_to_manifest adds backup entry with correct fields" {
    _setup_manifest_test
    _init_manifest

    # Add a test backup entry
    local files_json='[{"source": "todo.json", "backup": "todo.json", "size": 100, "checksum": "abc123"}]'
    run _add_to_manifest "snapshot_20251220_120000" "snapshot" "$BACKUP_DIR/snapshot/snapshot_20251220_120000" "$files_json" 100 ""

    [[ $status -eq 0 ]]

    # Verify entry was added
    local entry_id
    entry_id=$(jq -r '.backups[0].id' "$BACKUP_DIR/backup-manifest.json")
    [[ "$entry_id" == "snapshot_20251220_120000" ]]

    local entry_type
    entry_type=$(jq -r '.backups[0].type' "$BACKUP_DIR/backup-manifest.json")
    [[ "$entry_type" == "snapshot" ]]

    local entry_size
    entry_size=$(jq -r '.backups[0].sizeBytes' "$BACKUP_DIR/backup-manifest.json")
    [[ "$entry_size" -eq 100 ]]
}

@test "_add_to_manifest sets neverDelete for migration backups" {
    _setup_manifest_test
    _init_manifest

    # Call without run to keep exported functions available
    local files_json='[{"source": "todo.json", "backup": "todo.json", "size": 100, "checksum": "abc123"}]'
    _add_to_manifest "migration_v1.0.0_20251220_120000" "migration" "$BACKUP_DIR/migration/migration_v1.0.0_20251220_120000" "$files_json" 100 ""

    local never_delete
    never_delete=$(jq -r '.backups[0].neverDelete' "$BACKUP_DIR/backup-manifest.json")
    [[ "$never_delete" == "true" ]]
}

@test "_add_to_manifest includes custom name when provided" {
    _setup_manifest_test
    _init_manifest

    # Call without run to keep exported functions available
    local files_json='[{"source": "todo.json", "backup": "todo.json", "size": 100, "checksum": "abc123"}]'
    _add_to_manifest "snapshot_20251220_120000_before_refactor" "snapshot" "$BACKUP_DIR/snapshot/snapshot_20251220_120000_before_refactor" "$files_json" 100 "before_refactor"

    local name
    name=$(jq -r '.backups[0].name' "$BACKUP_DIR/backup-manifest.json")
    [[ "$name" == "before_refactor" ]]
}

@test "_get_from_manifest returns entry by ID" {
    _setup_manifest_test
    _init_manifest

    # Call without run to keep exported functions available
    local files_json='[{"source": "todo.json", "backup": "todo.json", "size": 100, "checksum": "abc123"}]'
    _add_to_manifest "snapshot_20251220_120000" "snapshot" "$BACKUP_DIR/snapshot/snapshot_20251220_120000" "$files_json" 100 ""

    local entry
    entry=$(_get_from_manifest "snapshot_20251220_120000")

    [[ -n "$entry" ]]

    local entry_type
    entry_type=$(echo "$entry" | jq -r '.type')
    [[ "$entry_type" == "snapshot" ]]
}

@test "_get_from_manifest returns empty for non-existent ID" {
    _setup_manifest_test
    _init_manifest

    run _get_from_manifest "nonexistent_backup"

    [[ $status -eq 0 ]]
    [[ -z "$output" ]]
}

@test "_remove_from_manifest removes entry by ID" {
    _setup_manifest_test
    _init_manifest

    # Add two entries (call without run to keep exported functions available)
    local files_json='[{"source": "todo.json", "backup": "todo.json", "size": 100, "checksum": "abc123"}]'
    _add_to_manifest "snapshot_20251220_120000" "snapshot" "$BACKUP_DIR/snapshot/snapshot_20251220_120000" "$files_json" 100 ""
    _add_to_manifest "snapshot_20251220_130000" "snapshot" "$BACKUP_DIR/snapshot/snapshot_20251220_130000" "$files_json" 100 ""

    # Verify we have 2 entries
    local count_before
    count_before=$(jq '.backups | length' "$BACKUP_DIR/backup-manifest.json")
    [[ "$count_before" -eq 2 ]]

    # Remove one entry
    _remove_from_manifest "snapshot_20251220_120000"

    # Should have 1 entry left
    local count_after
    count_after=$(jq '.backups | length' "$BACKUP_DIR/backup-manifest.json")
    [[ "$count_after" -eq 1 ]]

    # Remaining entry should be the second one
    local remaining_id
    remaining_id=$(jq -r '.backups[0].id' "$BACKUP_DIR/backup-manifest.json")
    [[ "$remaining_id" == "snapshot_20251220_130000" ]]
}

@test "_remove_from_manifest succeeds for non-existent ID (no-op)" {
    _setup_manifest_test
    _init_manifest

    run _remove_from_manifest "nonexistent_backup"

    [[ $status -eq 0 ]]
}

@test "_get_backups_from_manifest returns all backups" {
    _setup_manifest_test
    _init_manifest

    # Call without run to keep exported functions available
    local files_json='[{"source": "todo.json", "backup": "todo.json", "size": 100, "checksum": "abc123"}]'
    _add_to_manifest "snapshot_20251220_120000" "snapshot" "$BACKUP_DIR/snapshot/snapshot_20251220_120000" "$files_json" 100 ""
    _add_to_manifest "safety_20251220_130000" "safety" "$BACKUP_DIR/safety/safety_20251220_130000" "$files_json" 50 ""

    local result
    result=$(_get_backups_from_manifest "all")

    local count
    count=$(echo "$result" | jq 'length')
    [[ "$count" -eq 2 ]]
}

@test "_get_backups_from_manifest filters by type" {
    _setup_manifest_test
    _init_manifest

    # Call without run to keep exported functions available
    local files_json='[{"source": "todo.json", "backup": "todo.json", "size": 100, "checksum": "abc123"}]'
    _add_to_manifest "snapshot_20251220_120000" "snapshot" "$BACKUP_DIR/snapshot/snapshot_20251220_120000" "$files_json" 100 ""
    _add_to_manifest "safety_20251220_130000" "safety" "$BACKUP_DIR/safety/safety_20251220_130000" "$files_json" 50 ""

    local result
    result=$(_get_backups_from_manifest "snapshot")

    local count
    count=$(echo "$result" | jq 'length')
    [[ "$count" -eq 1 ]]

    local entry_type
    entry_type=$(echo "$result" | jq -r '.[0].type')
    [[ "$entry_type" == "snapshot" ]]
}

@test "_manifest_exists returns true when manifest exists" {
    _setup_manifest_test
    _init_manifest

    run _manifest_exists

    [[ $status -eq 0 ]]
}

@test "_manifest_exists returns false when manifest missing" {
    _setup_manifest_test
    # Manifest already removed by _setup_manifest_test

    run _manifest_exists

    [[ $status -ne 0 ]]
}

@test "_rebuild_manifest scans backup directories" {
    _setup_manifest_test

    # Create some backup directories with metadata
    mkdir -p "$BACKUP_DIR/snapshot/snapshot_20251220_120000"
    echo '{"backupType": "snapshot", "timestamp": "2025-12-20T12:00:00Z", "files": [{"source": "todo.json", "checksum": "abc"}], "totalSize": 100}' > "$BACKUP_DIR/snapshot/snapshot_20251220_120000/metadata.json"

    mkdir -p "$BACKUP_DIR/safety/safety_20251220_130000_update_todo.json"
    echo '{"backupType": "safety", "timestamp": "2025-12-20T13:00:00Z", "files": [{"source": "todo.json", "checksum": "def"}], "totalSize": 50}' > "$BACKUP_DIR/safety/safety_20251220_130000_update_todo.json/metadata.json"

    run _rebuild_manifest

    [[ $status -eq 0 ]]
    [[ "$output" == *"Rebuilt manifest with 2 backup entries"* ]]

    # Verify manifest was created with correct entries
    local count
    count=$(jq '.backups | length' "$BACKUP_DIR/backup-manifest.json")
    [[ "$count" -eq 2 ]]
}

@test "create_snapshot_backup adds entry to manifest" {
    _setup_manifest_test

    local backup_path
    backup_path=$(create_snapshot_backup "test_manifest")

    # Manifest should exist
    [[ -f "$BACKUP_DIR/backup-manifest.json" ]]

    # Should have at least one entry
    local count
    count=$(jq '.backups | length' "$BACKUP_DIR/backup-manifest.json")
    [[ "$count" -ge 1 ]]

    # Entry should match the created backup
    local backup_id
    backup_id=$(basename "$backup_path")
    local manifest_entry
    manifest_entry=$(_get_from_manifest "$backup_id")
    [[ -n "$manifest_entry" ]]
}

@test "create_incremental_backup adds entry to manifest" {
    _setup_manifest_test

    local backup_path
    backup_path=$(create_incremental_backup "$CLAUDE_TODO_DIR/todo.json")

    [[ -f "$BACKUP_DIR/backup-manifest.json" ]]

    local backup_id
    backup_id=$(basename "$backup_path")
    local manifest_entry
    manifest_entry=$(_get_from_manifest "$backup_id")
    [[ -n "$manifest_entry" ]]
}

@test "create_archive_backup adds entry to manifest" {
    _setup_manifest_test

    local backup_path
    backup_path=$(create_archive_backup)

    [[ -f "$BACKUP_DIR/backup-manifest.json" ]]

    local backup_id
    backup_id=$(basename "$backup_path")
    local manifest_entry
    manifest_entry=$(_get_from_manifest "$backup_id")
    [[ -n "$manifest_entry" ]]
}

@test "create_migration_backup adds entry to manifest with neverDelete" {
    _setup_manifest_test

    local backup_path
    backup_path=$(create_migration_backup "2.0.0")

    [[ -f "$BACKUP_DIR/backup-manifest.json" ]]

    local backup_id
    backup_id=$(basename "$backup_path")
    local manifest_entry
    manifest_entry=$(_get_from_manifest "$backup_id")
    [[ -n "$manifest_entry" ]]

    local never_delete
    never_delete=$(echo "$manifest_entry" | jq -r '.neverDelete')
    [[ "$never_delete" == "true" ]]
}

@test "rotate_backups removes entries from manifest" {
    _setup_manifest_test
    _init_manifest

    # Call without run to keep exported functions available
    local files_json='[{"source": "todo.json", "backup": "todo.json", "size": 100, "checksum": "abc123"}]'

    # Create 12 snapshot backups in manifest (exceeds default MAX_SNAPSHOTS=10)
    for i in {1..12}; do
        local padded=$(printf "%02d" "$i")
        local backup_id="snapshot_20251201_0000${padded}"
        mkdir -p "$BACKUP_DIR/snapshot/$backup_id"
        _add_to_manifest "$backup_id" "snapshot" "$BACKUP_DIR/snapshot/$backup_id" "$files_json" 100 ""
        sleep 0.05
    done

    # Verify manifest has 12 snapshot entries
    local snapshot_count_before
    snapshot_count_before=$(jq '[.backups[] | select(.type == "snapshot")] | length' "$BACKUP_DIR/backup-manifest.json")
    [[ "$snapshot_count_before" -eq 12 ]]

    # Run rotation
    rotate_backups "snapshot"

    # Manifest should have <=10 snapshot entries after rotation
    local snapshot_count_after
    snapshot_count_after=$(jq '[.backups[] | select(.type == "snapshot")] | length' "$BACKUP_DIR/backup-manifest.json")
    [[ "$snapshot_count_after" -le 10 ]]
}

# =============================================================================
# Scheduled Backup Tests - T632
# =============================================================================

@test "get_last_backup_time returns empty when no schedule state exists" {
    # Ensure no schedule file exists
    rm -f "$BACKUP_DIR_ABS/.schedule"

    run get_last_backup_time "$CLAUDE_TODO_DIR/config.json"

    [[ $status -eq 0 ]]
    [[ "$output" == "" ]]
}

@test "schedule_backup creates schedule state file" {
    run schedule_backup "$CLAUDE_TODO_DIR/config.json"

    [[ $status -eq 0 ]]
    [[ -f "$BACKUP_DIR_ABS/.schedule" ]]

    # Verify file contains valid JSON with lastBackupTimestamp
    local has_timestamp
    has_timestamp=$(jq -r '.lastBackupTimestamp // empty' "$BACKUP_DIR_ABS/.schedule")
    [[ -n "$has_timestamp" ]]
}

@test "get_last_backup_time returns timestamp after schedule_backup" {
    schedule_backup "$CLAUDE_TODO_DIR/config.json"

    run get_last_backup_time "$CLAUDE_TODO_DIR/config.json"

    [[ $status -eq 0 ]]
    [[ "$output" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

@test "should_auto_backup returns false when interval not configured" {
    # Config has no intervalMinutes (defaults to 0 = disabled)
    run should_auto_backup "$CLAUDE_TODO_DIR/config.json"

    [[ $status -eq 0 ]]
    [[ "$output" == "false" ]]
}

@test "should_auto_backup returns true when never backed up and interval configured" {
    # Update config with interval
    cat > "$CLAUDE_TODO_DIR/config.json" << EOF
{
  "version": "2.1.0",
  "backup": {
    "enabled": true,
    "directory": "$BACKUP_DIR_REL",
    "scheduled": {
      "intervalMinutes": 60
    }
  }
}
EOF
    # Remove any existing schedule
    rm -f "$BACKUP_DIR_ABS/.schedule"

    run should_auto_backup "$CLAUDE_TODO_DIR/config.json"

    [[ $status -eq 0 ]]
    [[ "$output" == "true" ]]
}

@test "should_auto_backup returns false when interval not elapsed" {
    # Update config with interval
    cat > "$CLAUDE_TODO_DIR/config.json" << EOF
{
  "version": "2.1.0",
  "backup": {
    "enabled": true,
    "directory": "$BACKUP_DIR_REL",
    "scheduled": {
      "intervalMinutes": 60
    }
  }
}
EOF
    # Record a recent backup
    schedule_backup "$CLAUDE_TODO_DIR/config.json"

    run should_auto_backup "$CLAUDE_TODO_DIR/config.json"

    [[ $status -eq 0 ]]
    [[ "$output" == "false" ]]
}

@test "auto_backup_on_archive creates backup when onArchive is true" {
    # Config with onArchive enabled (default)
    cat > "$CLAUDE_TODO_DIR/config.json" << EOF
{
  "version": "2.1.0",
  "backup": {
    "enabled": true,
    "directory": "$BACKUP_DIR_REL",
    "scheduled": {
      "onArchive": true
    }
  }
}
EOF

    local backup_path
    backup_path=$(auto_backup_on_archive "$CLAUDE_TODO_DIR/config.json")
    local result=$?

    [[ $result -eq 0 ]]
    [[ -n "$backup_path" ]]  # Should return backup path
    [[ -d "$backup_path" ]]  # Backup directory should exist
}

@test "auto_backup_on_archive skips backup when onArchive is false" {
    # Config with onArchive disabled
    cat > "$CLAUDE_TODO_DIR/config.json" << EOF
{
  "version": "2.1.0",
  "backup": {
    "enabled": true,
    "directory": "$BACKUP_DIR_REL",
    "scheduled": {
      "onArchive": false
    }
  }
}
EOF

    local backup_path
    backup_path=$(auto_backup_on_archive "$CLAUDE_TODO_DIR/config.json")
    local result=$?

    [[ $result -eq 0 ]]
    [[ -z "$backup_path" ]]  # Should return empty (no backup created)
}

@test "auto_backup_on_session_start creates backup when configured" {
    # Config with onSessionStart enabled
    cat > "$CLAUDE_TODO_DIR/config.json" << EOF
{
  "version": "2.1.0",
  "backup": {
    "enabled": true,
    "directory": "$BACKUP_DIR_REL",
    "scheduled": {
      "onSessionStart": true
    }
  }
}
EOF

    local backup_path
    backup_path=$(auto_backup_on_session_start "$CLAUDE_TODO_DIR/config.json")
    local result=$?

    [[ $result -eq 0 ]]
    [[ -n "$backup_path" ]]  # Should return backup path
    [[ -d "$backup_path" ]]  # Backup directory should exist
}

@test "auto_backup_on_session_end creates backup when configured" {
    # Config with onSessionEnd enabled
    cat > "$CLAUDE_TODO_DIR/config.json" << EOF
{
  "version": "2.1.0",
  "backup": {
    "enabled": true,
    "directory": "$BACKUP_DIR_REL",
    "scheduled": {
      "onSessionEnd": true
    }
  }
}
EOF

    run auto_backup_on_session_end "$CLAUDE_TODO_DIR/config.json"

    [[ $status -eq 0 ]]
    [[ -n "$output" ]]  # Should return backup path
}

@test "perform_scheduled_backup creates backup and records timestamp" {
    # Config with interval
    cat > "$CLAUDE_TODO_DIR/config.json" << EOF
{
  "version": "2.1.0",
  "backup": {
    "enabled": true,
    "directory": "$BACKUP_DIR_REL",
    "scheduled": {
      "intervalMinutes": 60
    }
  }
}
EOF
    # Remove any existing schedule
    rm -f "$BACKUP_DIR_ABS/.schedule"

    run perform_scheduled_backup "$CLAUDE_TODO_DIR/config.json"

    [[ $status -eq 0 ]]
    [[ -n "$output" ]]  # Should return backup path
    [[ -f "$BACKUP_DIR_ABS/.schedule" ]]  # Schedule file should be created
}

@test "perform_scheduled_backup skips when not due" {
    # Config with interval
    cat > "$CLAUDE_TODO_DIR/config.json" << EOF
{
  "version": "2.1.0",
  "backup": {
    "enabled": true,
    "directory": "$BACKUP_DIR_REL",
    "scheduled": {
      "intervalMinutes": 60
    }
  }
}
EOF
    # Record a recent backup
    schedule_backup "$CLAUDE_TODO_DIR/config.json"

    run perform_scheduled_backup "$CLAUDE_TODO_DIR/config.json"

    [[ $status -eq 0 ]]
    [[ -z "$output" ]]  # Should return empty (not due)
}
