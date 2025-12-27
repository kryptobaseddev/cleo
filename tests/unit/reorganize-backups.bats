#!/usr/bin/env bats
# Tests for reorganize-backups.sh
# Validates legacy backup migration to new taxonomy

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test

    # Set script path
    export MIGRATE_BACKUPS_SCRIPT="${SCRIPTS_DIR}/reorganize-backups.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

@test "reorganize-backups: shows help" {
    run bash "$MIGRATE_BACKUPS_SCRIPT" --help
    assert_success
    assert_output --partial "Migrate legacy backups to new unified taxonomy"
    assert_output --partial "--detect"
    assert_output --partial "--dry-run"
    assert_output --partial "--run"
    assert_output --partial "--cleanup"
}

@test "reorganize-backups: detects no backups in empty directory" {
    run bash "$MIGRATE_BACKUPS_SCRIPT" --detect
    assert_success
    assert_output --partial "No legacy backups found"
}

@test "reorganize-backups: classifies safety backup (YYYYMMDD_HHMMSS)" {
    mkdir -p .cleo/.backups

    # Create safety backup
    echo '{"version":"0.9.0","tasks":[]}' > .cleo/.backups/todo.json.20241201_120000

    run bash "$MIGRATE_BACKUPS_SCRIPT" --detect
    assert_success
    assert_output --partial "[safety backups]"
    assert_output --partial "todo.json.20241201_120000"
    assert_output --partial "2024-12-01T12:00:00Z"
}

@test "reorganize-backups: classifies archive backup (.backup.TIMESTAMP)" {
    mkdir -p .cleo/.backups

    # Create archive backup
    echo '{"version":"0.9.0","tasks":[]}' > .cleo/.backups/todo.json.backup.1234567890

    run bash "$MIGRATE_BACKUPS_SCRIPT" --detect
    assert_success
    assert_output --partial "[archive backups]"
    assert_output --partial "todo.json.backup.1234567890"
}

@test "reorganize-backups: classifies snapshot backup (backup_TIMESTAMP)" {
    mkdir -p .cleo/.backups/backup_1234567890

    # Create snapshot backup directory
    echo '{"version":"0.9.0","tasks":[]}' > .cleo/.backups/backup_1234567890/todo.json

    run bash "$MIGRATE_BACKUPS_SCRIPT" --detect
    assert_success
    assert_output --partial "[snapshot backups]"
    assert_output --partial "backup_1234567890"
}

@test "reorganize-backups: classifies migration backup (pre-migration-*)" {
    mkdir -p .cleo/.backups/pre-migration-v0.8.0

    # Create migration backup directory
    echo '{"version":"0.8.0","tasks":[]}' > .cleo/.backups/pre-migration-v0.8.0/todo.json

    run bash "$MIGRATE_BACKUPS_SCRIPT" --detect
    assert_success
    assert_output --partial "[migration backups]"
    assert_output --partial "pre-migration-v0.8.0"
}

@test "reorganize-backups: classifies numbered safety backups" {
    mkdir -p .cleo/.backups

    # Create numbered backups (from file-ops.sh)
    echo '{"version":"0.9.0","tasks":[]}' > .cleo/.backups/todo.json.1
    echo '{"version":"0.9.0","tasks":[]}' > .cleo/.backups/todo.json.2

    run bash "$MIGRATE_BACKUPS_SCRIPT" --detect
    assert_success
    assert_output --partial "[safety backups]"
    assert_output --partial "todo.json.1"
    assert_output --partial "todo.json.2"
}

@test "reorganize-backups: dry-run shows migration plan without changes" {
    mkdir -p .cleo/.backups

    # Create test backup
    echo '{"version":"0.9.0","tasks":[]}' > .cleo/.backups/todo.json.20241201_120000

    # Record state before dry-run (common_setup creates backup dirs)
    local safety_count_before
    safety_count_before=$(find .cleo/backups/safety -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)

    run bash "$MIGRATE_BACKUPS_SCRIPT" --dry-run
    assert_success
    assert_output --partial "DRY RUN MODE"
    assert_output --partial "WOULD MIGRATE"
    assert_output --partial "todo.json.20241201_120000"

    # Verify no new backups were created (dir may exist from common_setup)
    local safety_count_after
    safety_count_after=$(find .cleo/backups/safety -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
    [ "$safety_count_before" -eq "$safety_count_after" ]

    # Original backup should still exist in legacy location
    [ -f ".cleo/.backups/todo.json.20241201_120000" ]
}

@test "reorganize-backups: actual migration creates new backup structure" {
    mkdir -p .cleo/.backups

    # Create test backup
    echo '{"version":"0.9.0","tasks":[]}' > .cleo/.backups/todo.json.20241201_120000

    run bash "$MIGRATE_BACKUPS_SCRIPT" --run
    assert_success
    assert_output --partial "MIGRATED:"
    assert_output --partial "Migrated: 1"

    # Verify new structure was created
    [ -d ".cleo/backups/safety" ]

    # Verify metadata was created
    local backup_dir=$(find .cleo/backups/safety -type d -name "safety_*" | head -1)
    [ -f "$backup_dir/metadata.json" ]

    # Verify metadata contains migration flag
    run jq -r '.migrated' "$backup_dir/metadata.json"
    assert_output "true"
}

@test "reorganize-backups: preserves file integrity during migration" {
    mkdir -p .cleo/.backups

    # Create test backup with known content
    local test_content='{"version":"0.9.0","tasks":[{"id":"T001","title":"Test"}]}'
    echo "$test_content" > .cleo/.backups/todo.json.20241201_120000

    # Get original checksum
    local original_checksum=$(sha256sum .cleo/.backups/todo.json.20241201_120000 | cut -d' ' -f1)

    run bash "$MIGRATE_BACKUPS_SCRIPT" --run
    assert_success

    # Find migrated file
    local migrated_file=$(find .cleo/backups/safety -name "todo.json" | head -1)

    # Verify checksum matches
    local migrated_checksum=$(sha256sum "$migrated_file" | cut -d' ' -f1)
    [ "$original_checksum" = "$migrated_checksum" ]
}

@test "reorganize-backups: cleanup requires confirmation when backups remain" {
    mkdir -p .cleo/.backups

    # Create test backup but don't migrate
    echo '{"version":"0.9.0","tasks":[]}' > .cleo/.backups/todo.json.20241201_120000

    # Cleanup should fail without migration first
    run bash -c "echo 'no' | bash $MIGRATE_BACKUPS_SCRIPT --cleanup"
    assert_failure
    assert_output --partial "Run migration first before cleanup"

    # Directory should still exist
    [ -d ".cleo/.backups" ]
}

@test "reorganize-backups: metadata includes original timestamp and path" {
    mkdir -p .cleo/.backups

    # Create test backup
    echo '{"version":"0.9.0","tasks":[]}' > .cleo/.backups/todo.json.20241201_120000

    run bash "$MIGRATE_BACKUPS_SCRIPT" --run
    assert_success

    # Find metadata
    local backup_dir=$(find .cleo/backups/safety -type d -name "safety_*" | head -1)
    local metadata_file="$backup_dir/metadata.json"

    # Verify metadata fields
    run jq -r '.originalTimestamp' "$metadata_file"
    assert_output "2024-12-01T12:00:00Z"

    run jq -r '.originalPath' "$metadata_file"
    assert_output --partial "todo.json.20241201_120000"

    run jq -r '.operation' "$metadata_file"
    assert_output "migrate_legacy"
}

@test "reorganize-backups: migration backups get neverDelete flag" {
    mkdir -p .cleo/.backups/pre-migration-v0.8.0

    # Create migration backup
    echo '{"version":"0.8.0","tasks":[]}' > .cleo/.backups/pre-migration-v0.8.0/todo.json

    run bash "$MIGRATE_BACKUPS_SCRIPT" --run
    assert_success

    # Find metadata
    local backup_dir=$(find .cleo/backups/migration -type d -name "migration_*" | head -1)
    local metadata_file="$backup_dir/metadata.json"

    # Verify neverDelete flag
    run jq -r '.neverDelete' "$metadata_file"
    assert_output "true"
}

@test "reorganize-backups: skips unknown backup types" {
    mkdir -p .cleo/.backups

    # Create unrecognized backup
    echo "random content" > .cleo/.backups/unknown_file.txt

    run bash "$MIGRATE_BACKUPS_SCRIPT" --run
    assert_success
    assert_output --partial "Skipped (unknown): 1"
}

@test "reorganize-backups: handles multiple backup types in single run" {
    mkdir -p .cleo/.backups/backup_1234567890
    mkdir -p .cleo/.backups/pre-migration-v0.8.0

    # Create different backup types
    echo '{"version":"0.9.0","tasks":[]}' > .cleo/.backups/todo.json.20241201_120000  # safety
    echo '{"version":"0.9.0","tasks":[]}' > .cleo/.backups/backup_1234567890/todo.json  # snapshot
    echo '{"version":"0.8.0","tasks":[]}' > .cleo/.backups/pre-migration-v0.8.0/todo.json  # migration

    run bash "$MIGRATE_BACKUPS_SCRIPT" --run
    assert_success
    assert_output --partial "Migrated: 3"

    # Verify all types were created
    [ -d ".cleo/backups/safety" ]
    [ -d ".cleo/backups/snapshot" ]
    [ -d ".cleo/backups/migration" ]
}
