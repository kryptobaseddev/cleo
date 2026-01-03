#!/usr/bin/env bats
# Tests for migration journal (recording and checksum validation)

# Setup test environment
setup() {
    # Load test helpers
    load '../test_helper/common_setup'
    load '../test_helper/assertions'

    # Setup paths
    export SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    export LIB_DIR="$SCRIPT_DIR/lib"
    export SCHEMA_DIR="$SCRIPT_DIR/schemas"
    export TEMPLATES_DIR="$SCRIPT_DIR/templates"

    # Create test directory
    export TEST_DIR="$(mktemp -d)"
    export TEST_CLEO_DIR="$TEST_DIR/.cleo"
    mkdir -p "$TEST_CLEO_DIR"

    # Source required libraries
    source "$LIB_DIR/migrate.sh"

    # Define a test migration function for checksum testing
    migrate_test_to_1_0_0() {
        local file="$1"
        jq '._meta.schemaVersion = "1.0.0"' "$file" > "$file.tmp"
        mv "$file.tmp" "$file"
    }
}

# Cleanup
teardown() {
    rm -rf "$TEST_DIR"
}

@test "init_migrations_journal creates valid journal file" {
    init_migrations_journal "$TEST_CLEO_DIR"

    # Check file exists
    [ -f "$TEST_CLEO_DIR/migrations.json" ]

    # Check valid JSON
    jq empty "$TEST_CLEO_DIR/migrations.json"

    # Check schema version is set
    local version
    version=$(jq -r '._meta.schemaVersion' "$TEST_CLEO_DIR/migrations.json")
    [ "$version" != "null" ]
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

@test "init_migrations_journal is idempotent" {
    init_migrations_journal "$TEST_CLEO_DIR"

    local first_content
    first_content=$(cat "$TEST_CLEO_DIR/migrations.json")

    # Run again
    init_migrations_journal "$TEST_CLEO_DIR"

    # Content should be unchanged
    local second_content
    second_content=$(cat "$TEST_CLEO_DIR/migrations.json")
    [ "$first_content" = "$second_content" ]
}

@test "get_migration_checksum returns SHA-256 hash" {
    local checksum
    checksum=$(get_migration_checksum "migrate_test_to_1_0_0")

    # Should be 64 hex characters (SHA-256)
    [[ "$checksum" =~ ^[a-f0-9]{64}$ ]]
}

@test "get_migration_checksum returns same hash for same function" {
    local checksum1
    checksum1=$(get_migration_checksum "migrate_test_to_1_0_0")

    local checksum2
    checksum2=$(get_migration_checksum "migrate_test_to_1_0_0")

    [ "$checksum1" = "$checksum2" ]
}

@test "get_migration_checksum returns zeros for nonexistent function" {
    local checksum
    checksum=$(get_migration_checksum "nonexistent_function" || true)

    # Should return all zeros even though function doesn't exist
    [ "$checksum" = "0000000000000000000000000000000000000000000000000000000000000000" ]
}

@test "record_migration_application creates journal if missing" {
    # Create dummy todo.json
    echo '{"_meta": {"schemaVersion": "1.0.0"}}' > "$TEST_CLEO_DIR/todo.json"

    record_migration_application \
        "$TEST_CLEO_DIR/todo.json" \
        "todo" \
        "1.0.0" \
        "0.9.0" \
        "migrate_test_to_1_0_0" \
        "success" \
        "100" \
        "null"

    # Journal should exist
    [ -f "$TEST_CLEO_DIR/migrations.json" ]
}

@test "record_migration_application appends entry" {
    init_migrations_journal "$TEST_CLEO_DIR"

    # Create dummy todo.json
    echo '{"_meta": {"schemaVersion": "1.0.0"}}' > "$TEST_CLEO_DIR/todo.json"

    # Record migration
    record_migration_application \
        "$TEST_CLEO_DIR/todo.json" \
        "todo" \
        "1.0.0" \
        "0.9.0" \
        "migrate_test_to_1_0_0" \
        "success" \
        "100" \
        "null"

    # Check entry was added
    local count
    count=$(jq '.appliedMigrations | length' "$TEST_CLEO_DIR/migrations.json")
    [ "$count" = "1" ]

    # Check entry fields
    local entry
    entry=$(jq '.appliedMigrations[0]' "$TEST_CLEO_DIR/migrations.json")

    # Version
    local version
    version=$(echo "$entry" | jq -r '.version')
    [ "$version" = "1.0.0" ]

    # File type
    local file_type
    file_type=$(echo "$entry" | jq -r '.fileType')
    [ "$file_type" = "todo" ]

    # Function name
    local fn
    fn=$(echo "$entry" | jq -r '.functionName')
    [ "$fn" = "migrate_test_to_1_0_0" ]

    # Status
    local status
    status=$(echo "$entry" | jq -r '.status')
    [ "$status" = "success" ]

    # Checksum (should be valid SHA-256)
    local checksum
    checksum=$(echo "$entry" | jq -r '.checksum')
    [[ "$checksum" =~ ^[a-f0-9]{64}$ ]]
}

@test "validate_applied_checksums succeeds when no journal exists" {
    validate_applied_checksums "$TEST_CLEO_DIR"
}

@test "validate_applied_checksums succeeds when checksums match" {
    init_migrations_journal "$TEST_CLEO_DIR"

    # Create dummy todo.json
    echo '{"_meta": {"schemaVersion": "1.0.0"}}' > "$TEST_CLEO_DIR/todo.json"

    # Record migration
    record_migration_application \
        "$TEST_CLEO_DIR/todo.json" \
        "todo" \
        "1.0.0" \
        "0.9.0" \
        "migrate_test_to_1_0_0" \
        "success" \
        "100" \
        "null"

    # Validate
    validate_applied_checksums "$TEST_CLEO_DIR"
}

@test "validate_applied_checksums detects modified migration" {
    init_migrations_journal "$TEST_CLEO_DIR"

    # Create dummy todo.json
    echo '{"_meta": {"schemaVersion": "1.0.0"}}' > "$TEST_CLEO_DIR/todo.json"

    # Record migration with correct checksum
    record_migration_application \
        "$TEST_CLEO_DIR/todo.json" \
        "todo" \
        "1.0.0" \
        "0.9.0" \
        "migrate_test_to_1_0_0" \
        "success" \
        "100" \
        "null"

    # Manually corrupt the checksum in the journal
    local corrupted
    corrupted=$(jq '.appliedMigrations[0].checksum = "0000000000000000000000000000000000000000000000000000000000000000"' \
        "$TEST_CLEO_DIR/migrations.json")
    echo "$corrupted" > "$TEST_CLEO_DIR/migrations.json"

    # Validate should fail
    ! validate_applied_checksums "$TEST_CLEO_DIR" 2>/dev/null
}

@test "validate_applied_checksums skips entries without function names" {
    init_migrations_journal "$TEST_CLEO_DIR"

    # Create dummy todo.json
    echo '{"_meta": {"schemaVersion": "1.0.0"}}' > "$TEST_CLEO_DIR/todo.json"

    # Create entry without function name (version-only bump)
    local entry
    entry=$(jq -nc \
        --arg ver "1.0.0" \
        --arg ft "todo" \
        '{
            version: $ver,
            fileType: $ft,
            functionName: null,
            checksum: "0000000000000000000000000000000000000000000000000000000000000000",
            appliedAt: "2026-01-03T00:00:00Z",
            status: "success",
            previousVersion: "0.9.0",
            executionTimeMs: 0
        }')

    local updated
    updated=$(jq --argjson entry "$entry" \
        '.appliedMigrations += [$entry]' \
        "$TEST_CLEO_DIR/migrations.json")
    echo "$updated" > "$TEST_CLEO_DIR/migrations.json"

    # Validate should succeed (skip this entry)
    validate_applied_checksums "$TEST_CLEO_DIR"
}

@test "record_migration_application updates lastChecked timestamp" {
    init_migrations_journal "$TEST_CLEO_DIR"

    # Create dummy todo.json
    echo '{"_meta": {"schemaVersion": "1.0.0"}}' > "$TEST_CLEO_DIR/todo.json"

    # Initial lastChecked should be null
    local before
    before=$(jq -r '._meta.lastChecked' "$TEST_CLEO_DIR/migrations.json")
    [ "$before" = "null" ]

    # Record migration
    record_migration_application \
        "$TEST_CLEO_DIR/todo.json" \
        "todo" \
        "1.0.0" \
        "0.9.0" \
        "migrate_test_to_1_0_0" \
        "success" \
        "100" \
        "null"

    # lastChecked should be set to ISO timestamp
    local after
    after=$(jq -r '._meta.lastChecked' "$TEST_CLEO_DIR/migrations.json")
    [ "$after" != "null" ]
    [[ "$after" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2} ]]
}
