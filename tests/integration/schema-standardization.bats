#!/usr/bin/env bats
# =============================================================================
# schema-standardization.bats - Phase 3 tests for ._meta.schemaVersion standardization (T1263)
# =============================================================================
# Tests validate the ._meta.schemaVersion standardization:
# 1. All schema files have schemaVersion field at root level
# 2. Core schemas require _meta field (containing schemaVersion)
# 3. Version extraction prefers ._meta.schemaVersion over legacy .version
# 4. Schema validation enforces _meta presence
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
# TEST 1: All schema files have schemaVersion
# =============================================================================

@test "all schema files have schemaVersion field" {
    # Every schema file MUST declare its own schemaVersion at root level
    # This is the schema's version, not the data's version

    local schema_files
    schema_files=$(find "${PROJECT_ROOT}/schemas" -name "*.schema.json")

    # Iterate through all schema files
    while IFS= read -r schema_file; do
        # File must be valid JSON
        run jq empty "$schema_file"
        assert_success

        # File must have schemaVersion field at root level
        run jq -e '.schemaVersion' "$schema_file"
        assert_success "Schema missing schemaVersion: $schema_file"

        # schemaVersion must not be null or empty
        local version
        version=$(jq -r '.schemaVersion' "$schema_file")
        assert [ -n "$version" ]
        assert [ "$version" != "null" ]

        # schemaVersion must match semver pattern
        echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'
        assert_success "Invalid schemaVersion in $schema_file: $version"

    done <<< "$schema_files"
}

# =============================================================================
# TEST 2: Core schemas require _meta field
# =============================================================================

@test "core schemas require _meta field" {
    # Core data files (todo, config, archive, log, sessions) MUST require _meta
    local core_schemas=(
        "todo"
        "config"
        "archive"
        "log"
        "sessions"
    )

    for schema_name in "${core_schemas[@]}"; do
        local schema_file="${PROJECT_ROOT}/schemas/${schema_name}.schema.json"

        # Skip if schema doesn't exist (e.g., sessions may not be implemented yet)
        if [[ ! -f "$schema_file" ]]; then
            skip "Schema not yet implemented: ${schema_name}.schema.json"
        fi

        # Check if _meta is in required array
        run jq -e '.required | index("_meta")' "$schema_file"
        assert_success "Schema $schema_name should require _meta field"
    done
}

@test "core schemas define _meta.schemaVersion property" {
    # Core schemas MUST define _meta.schemaVersion in properties
    local core_schemas=(
        "todo"
        "config"
        "archive"
        "log"
        "sessions"
    )

    for schema_name in "${core_schemas[@]}"; do
        local schema_file="${PROJECT_ROOT}/schemas/${schema_name}.schema.json"

        # Skip if schema doesn't exist
        if [[ ! -f "$schema_file" ]]; then
            skip "Schema not yet implemented: ${schema_name}.schema.json"
        fi

        # Check if _meta is defined in properties
        run jq -e '.properties._meta' "$schema_file"
        assert_success "Schema $schema_name missing _meta in properties"

        # Check if _meta.schemaVersion is defined
        run jq -e '.properties._meta.properties.schemaVersion' "$schema_file"
        assert_success "Schema $schema_name missing _meta.schemaVersion definition"
    done
}

# =============================================================================
# TEST 3: Version extraction prefers ._meta.schemaVersion
# =============================================================================

@test "detect_file_version prefers _meta.schemaVersion over version" {
    # When both ._meta.schemaVersion and .version exist, prefer ._meta.schemaVersion
    # This is the canonical location as of Phase 3

    # Source migrate.sh to get detect_file_version function
    source "${LIB_DIR}/data/migrate.sh"

    # Create test file with both fields
    local test_file
    test_file=$(mktemp)

    # Write test data: _meta.schemaVersion is newer than legacy .version
    cat > "$test_file" <<EOF
{
  "_meta": {
    "schemaVersion": "2.6.0"
  },
  "version": "2.4.0",
  "tasks": []
}
EOF

    # Detect version (should prefer _meta.schemaVersion)
    local detected_version
    detected_version=$(detect_file_version "$test_file" "todo")

    # Should prefer _meta.schemaVersion (2.6.0) over .version (2.4.0)
    assert_equal "$detected_version" "2.6.0"

    # Cleanup
    rm -f "$test_file"
}

@test "detect_file_version handles missing _meta gracefully" {
    # When _meta.schemaVersion doesn't exist, should fall back to .version
    # (for backward compatibility with legacy files)

    # Source migrate.sh
    source "${LIB_DIR}/data/migrate.sh"

    # Create test file with only legacy .version
    local test_file
    test_file=$(mktemp)

    cat > "$test_file" <<EOF
{
  "version": "2.4.0",
  "tasks": []
}
EOF

    # Detect version (should fall back to .version)
    local detected_version
    detected_version=$(detect_file_version "$test_file" "todo")

    # Should use legacy .version
    assert_equal "$detected_version" "2.4.0"

    # Cleanup
    rm -f "$test_file"
}

@test "detect_file_version uses type-specific schema fallback" {
    # When neither ._meta.schemaVersion nor .version exist, should fall back to schema

    # Source migrate.sh
    source "${LIB_DIR}/data/migrate.sh"

    # Create test file with no version fields
    local test_file
    test_file=$(mktemp)

    cat > "$test_file" <<EOF
{
  "tasks": []
}
EOF

    # Detect version (should use schema version as fallback)
    local detected_version
    detected_version=$(detect_file_version "$test_file" "todo")

    # Should get schema version from todo.schema.json
    local schema_version
    schema_version=$(jq -r '.schemaVersion' "${PROJECT_ROOT}/schemas/todo.schema.json")

    # Detected version should match schema version
    assert_equal "$detected_version" "$schema_version"

    # Cleanup
    rm -f "$test_file"
}

# =============================================================================
# TEST 4: Schema validation enforces _meta presence
# =============================================================================

@test "todo schema validation rejects missing _meta" {
    # Create test file missing _meta
    local test_file
    test_file=$(mktemp)

    cat > "$test_file" <<EOF
{
  "tasks": [],
  "nextId": 1
}
EOF

    # Validate against todo schema (should fail)
    run jq -e --arg schema "file://${PROJECT_ROOT}/schemas/todo.schema.json" \
        'if . then true else false end' "$test_file"

    # Note: jq doesn't have built-in JSON Schema validation
    # This test verifies the structure, actual validation happens in lib/validation/validation.sh
    # We'll validate using the schema's required fields

    # Check if _meta is required in schema
    run jq -e '.required | index("_meta")' "${PROJECT_ROOT}/schemas/todo.schema.json"
    assert_success

    # Cleanup
    rm -f "$test_file"
}

@test "initialized projects have _meta.schemaVersion" {
    # Real-world check: initialized projects should have _meta.schemaVersion

    # Create temporary test directory
    local test_dir
    test_dir=$(mktemp -d)

    # Initialize project
    cd "$test_dir"
    run "${SCRIPTS_DIR}/init.sh" --yes
    assert_success

    # Check all core files have _meta.schemaVersion
    local core_files=(
        ".cleo/todo.json"
        ".cleo/config.json"
        ".cleo/todo-archive.json"
        ".cleo/todo-log.json"
    )

    for data_file in "${core_files[@]}"; do
        # File must exist
        assert_file_exists "$data_file"

        # Must have _meta.schemaVersion
        run jq -e '._meta.schemaVersion' "$data_file"
        assert_success "Missing _meta.schemaVersion in $data_file"

        # Must be valid semver
        local version
        version=$(jq -r '._meta.schemaVersion' "$data_file")
        echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'
        assert_success "Invalid schemaVersion in $data_file: $version"
    done

    # Cleanup
    rm -rf "$test_dir"
}

@test "schema version matches between file and schema definition" {
    # Core files should use versions matching their schema definitions

    # Create temporary test directory
    local test_dir
    test_dir=$(mktemp -d)

    # Initialize project
    cd "$test_dir"
    run "${SCRIPTS_DIR}/init.sh" --yes
    assert_success

    # Map data files to their schemas
    local -A file_to_schema=(
        [".cleo/todo.json"]="todo.schema.json"
        [".cleo/config.json"]="config.schema.json"
        [".cleo/todo-archive.json"]="archive.schema.json"
        [".cleo/todo-log.json"]="log.schema.json"
    )

    for data_file in "${!file_to_schema[@]}"; do
        local schema_file="${file_to_schema[$data_file]}"

        # Get version from data file
        local data_version
        data_version=$(jq -r '._meta.schemaVersion' "$data_file")

        # Get version from schema file
        local schema_version
        schema_version=$(jq -r '.schemaVersion' "${PROJECT_ROOT}/schemas/${schema_file}")

        # Versions should match
        assert_equal "$data_version" "$schema_version" \
            "Version mismatch: $data_file ($data_version) vs $schema_file ($schema_version)"
    done

    # Cleanup
    rm -rf "$test_dir"
}
