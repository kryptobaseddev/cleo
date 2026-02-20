#!/usr/bin/env bats
# =============================================================================
# migration-journal.bats - Phase 4 tests for migration journal infrastructure (T1266)
# =============================================================================
# Tests validate the migration journal system:
# 1. migrations.schema.json exists and is valid
# 2. migrations.template.json exists with proper placeholders
# 3. New projects create migrations.json with correct structure
# 4. Migration application records entries in journal
# 5. Checksum validation detects modified migrations
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# TEST 1: migrations.schema.json exists and is valid
# =============================================================================

@test "migrations schema exists" {
    local schema_file="${PROJECT_ROOT}/schemas/migrations.schema.json"

    # File must exist
    assert_file_exists "$schema_file"

    # Must be valid JSON
    run jq empty "$schema_file"
    assert_success

    # Must have schemaVersion (all schemas require this)
    run jq -e '.schemaVersion' "$schema_file"
    assert_success

    # schemaVersion must be valid semver
    local version
    version=$(jq -r '.schemaVersion' "$schema_file")
    echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'
    assert_success
}

@test "migrations schema defines required fields" {
    local schema_file="${PROJECT_ROOT}/schemas/migrations.schema.json"

    # Schema must require _meta
    run jq -e '.required | index("_meta")' "$schema_file"
    assert_success

    # Schema must require appliedMigrations
    run jq -e '.required | index("appliedMigrations")' "$schema_file"
    assert_success

    # appliedMigrations must be defined as array
    run jq -e '.properties.appliedMigrations.type == "array"' "$schema_file"
    assert_success
}

@test "migrations schema defines appliedMigrations structure" {
    local schema_file="${PROJECT_ROOT}/schemas/migrations.schema.json"

    # appliedMigrations items must have required fields
    local required_fields=(
        "migrationId"
        "version"
        "appliedAt"
        "checksum"
    )

    for field in "${required_fields[@]}"; do
        run jq -e ".properties.appliedMigrations.items.required | index(\"$field\")" "$schema_file"
        assert_success "appliedMigrations items missing required field: $field"
    done
}

# =============================================================================
# TEST 2: migrations.template.json exists with proper placeholders
# =============================================================================

@test "migrations template exists" {
    local template_file="${TEMPLATES_DIR}/migrations.template.json"

    # File must exist
    assert_file_exists "$template_file"

    # Must be valid JSON
    run jq empty "$template_file"
    assert_success
}

@test "migrations template uses MIGRATIONS placeholder" {
    local template_file="${TEMPLATES_DIR}/migrations.template.json"

    # Must contain {{SCHEMA_VERSION_MIGRATIONS}} placeholder
    run grep '{{SCHEMA_VERSION_MIGRATIONS}}' "$template_file"
    assert_success

    # Must NOT contain hardcoded semver
    local version_pattern='"schemaVersion"[[:space:]]*:[[:space:]]*"[0-9]\+\.[0-9]\+\.[0-9]\+"'
    run grep "$version_pattern" "$template_file"
    assert_failure
}

@test "migrations template has appliedMigrations array" {
    local template_file="${TEMPLATES_DIR}/migrations.template.json"

    # Must have appliedMigrations field
    run jq -e '.appliedMigrations' "$template_file"
    assert_success

    # appliedMigrations must be an array
    run jq -e '.appliedMigrations | type == "array"' "$template_file"
    assert_success

    # appliedMigrations should be empty in template
    local array_length
    array_length=$(jq '.appliedMigrations | length' "$template_file")
    assert_equal "$array_length" "0"
}

# =============================================================================
# TEST 3: New projects create migrations.json with correct structure
# =============================================================================

@test "init creates migrations.json" {
    # Create temporary test directory
    local test_dir
    test_dir=$(mktemp -d)

    # Initialize project
    cd "$test_dir"
    run "${SCRIPTS_DIR}/init.sh" --yes
    assert_success

    # migrations.json must exist
    assert_file_exists ".cleo/migrations.json"

    # Cleanup
    rm -rf "$test_dir"
}

@test "initialized migrations.json has valid structure" {
    # Create temporary test directory
    local test_dir
    test_dir=$(mktemp -d)

    # Initialize project
    cd "$test_dir"
    run "${SCRIPTS_DIR}/init.sh" --yes
    assert_success

    # Must be valid JSON
    run jq empty .cleo/migrations.json
    assert_success

    # Must have _meta.schemaVersion
    run jq -e '._meta.schemaVersion' .cleo/migrations.json
    assert_success

    # schemaVersion must be valid semver
    local version
    version=$(jq -r '._meta.schemaVersion' .cleo/migrations.json)
    echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'
    assert_success

    # Must have appliedMigrations array
    run jq -e '.appliedMigrations | type == "array"' .cleo/migrations.json
    assert_success

    # Cleanup
    rm -rf "$test_dir"
}

@test "initialized migrations.json has no placeholders" {
    # Create temporary test directory
    local test_dir
    test_dir=$(mktemp -d)

    # Initialize project
    cd "$test_dir"
    run "${SCRIPTS_DIR}/init.sh" --yes
    assert_success

    # Should NOT contain any placeholders
    run grep '{{SCHEMA_VERSION' .cleo/migrations.json
    assert_failure

    # Cleanup
    rm -rf "$test_dir"
}

# =============================================================================
# TEST 4: Migration application records entries in journal (FUTURE)
# =============================================================================

@test "migration application creates journal entry" {
    # NOTE: This test requires Phase 4 migration application logic to be implemented
    # Marked as skip until migration application is complete

    skip "Migration application not yet implemented (Phase 4 in progress)"

    # When implemented, this test should:
    # 1. Initialize a project with old schema version
    # 2. Run migration
    # 3. Verify migrations.json contains entry with:
    #    - migrationId
    #    - version
    #    - appliedAt timestamp
    #    - checksum
}

@test "journal entry has required fields" {
    skip "Migration application not yet implemented (Phase 4 in progress)"

    # When implemented, verify journal entry structure:
    # - migrationId: unique identifier
    # - version: target version
    # - appliedAt: ISO 8601 timestamp
    # - checksum: SHA256 hash
    # - optional: duration, status
}

# =============================================================================
# TEST 5: Checksum validation detects modified migrations (FUTURE)
# =============================================================================

@test "checksum validation detects modified migration" {
    skip "Checksum validation not yet implemented (Phase 4 in progress)"

    # When implemented, this test should:
    # 1. Initialize project
    # 2. Apply migration (creates journal entry with checksum)
    # 3. Modify migration file
    # 4. Attempt to re-run migration
    # 5. Verify error is raised about checksum mismatch
}

@test "checksum validation allows unmodified re-runs" {
    skip "Checksum validation not yet implemented (Phase 4 in progress)"

    # When implemented, this test should:
    # 1. Initialize project
    # 2. Apply migration (creates journal entry)
    # 3. Attempt to re-run same migration without modifications
    # 4. Verify migration is skipped (already applied)
    # 5. Verify no error raised
}

# =============================================================================
# TEST 6: Journal persistence and integrity
# =============================================================================

@test "journal survives multiple init calls" {
    # Create temporary test directory
    local test_dir
    test_dir=$(mktemp -d)

    # Initialize project
    cd "$test_dir"
    run "${SCRIPTS_DIR}/init.sh" --yes
    assert_success

    # Verify migrations.json exists
    assert_file_exists ".cleo/migrations.json"

    # Get original content
    local original_content
    original_content=$(cat .cleo/migrations.json)

    # Run init again (should be idempotent)
    run "${SCRIPTS_DIR}/init.sh" --yes
    assert_success

    # Verify migrations.json still exists
    assert_file_exists ".cleo/migrations.json"

    # Content should be unchanged (init should not recreate existing journal)
    local current_content
    current_content=$(cat .cleo/migrations.json)
    assert_equal "$current_content" "$original_content"

    # Cleanup
    rm -rf "$test_dir"
}

@test "journal validates against schema" {
    # Create temporary test directory
    local test_dir
    test_dir=$(mktemp -d)

    # Initialize project
    cd "$test_dir"
    run "${SCRIPTS_DIR}/init.sh" --yes
    assert_success

    # Source validation library
    source "${LIB_DIR}/validation/validation.sh"

    # Validate migrations.json against schema
    run validate_file .cleo/migrations.json "${PROJECT_ROOT}/schemas/migrations.schema.json"
    assert_success

    # Cleanup
    rm -rf "$test_dir"
}
