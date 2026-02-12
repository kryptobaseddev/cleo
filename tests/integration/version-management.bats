#!/usr/bin/env bats
# =============================================================================
# version-management.bats - CI validation for version constant consistency (T1252)
# =============================================================================
# Tests enforce the schema version single-source-of-truth pattern:
# 1. SCHEMA_VERSION constants do not exist (removed in T1250)
# 2. discover_migration_versions finds all migrations
# 3. Schema files are parseable and have schemaVersion field
# 4. No fallback patterns exist (removed in T1251)
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
# TEST 1: SCHEMA_VERSION constants do not exist (T1250)
# =============================================================================

@test "SCHEMA_VERSION constants do not exist in lib/" {
    # These constants were removed in T1250 - ensure they don't come back
    # We're looking for bare constant declarations (not prefixed like UPG_SCHEMA_VERSION_TODO)
    # Pattern: start of line or after whitespace, then SCHEMA_VERSION_XXX=
    local patterns=(
        '^SCHEMA_VERSION_TODO='
        '[[:space:]]SCHEMA_VERSION_TODO='
        '^SCHEMA_VERSION_CONFIG='
        '[[:space:]]SCHEMA_VERSION_CONFIG='
        '^SCHEMA_VERSION_ARCHIVE='
        '[[:space:]]SCHEMA_VERSION_ARCHIVE='
        '^SCHEMA_VERSION_LOG='
        '[[:space:]]SCHEMA_VERSION_LOG='
    )

    # Search lib/ directory only (scripts can have local prefixed versions)
    for pattern in "${patterns[@]}"; do
        run grep -rE "${pattern}" "${LIB_DIR}/"

        # Should NOT find any matches (exit code 1 from grep means no matches)
        assert_failure

        # Ensure empty output
        assert_output ""
    done
}

# =============================================================================
# TEST 2: discover_migration_versions finds all migrations
# =============================================================================

@test "discover_migration_versions finds all migrations" {
    # Source migrate.sh to get access to discover_migration_versions
    source "${LIB_DIR}/data/migrate.sh"

    # Get discovered versions
    run discover_migration_versions
    assert_success

    # Capture discovered versions
    local discovered_versions="$output"

    # Get actual migration function names using declare -F
    local actual_functions
    actual_functions=$(declare -F | grep -oE "migrate_.+_to_[0-9]+_[0-9]+_[0-9]+" | sort -u)

    # Extract version numbers from function names
    # Example: "migrate_todo_to_2_5_0" -> "2.5.0"
    local expected_versions
    expected_versions=$(echo "$actual_functions" | \
        sed -E 's/.*_to_([0-9]+)_([0-9]+)_([0-9]+)/\1.\2.\3/' | \
        sort -uV)

    # Compare discovered vs expected
    # Convert to arrays for comparison
    local -a discovered_array expected_array
    mapfile -t discovered_array <<< "$discovered_versions"
    mapfile -t expected_array <<< "$expected_versions"

    # Check lengths match
    assert_equal "${#discovered_array[@]}" "${#expected_array[@]}"

    # Check each version is discovered
    for expected_version in "${expected_array[@]}"; do
        # Check if this version appears in discovered list
        echo "$discovered_versions" | grep -q "^${expected_version}$"
        assert_success
    done
}

# =============================================================================
# TEST 3: Schema files are parseable and have schemaVersion
# =============================================================================

@test "schema files parseable and have schemaVersion" {
    # Determine schema directory (use project schemas, not SCHEMA_DIR which may be unset in tests)
    local schema_dir="${PROJECT_ROOT}/schemas"

    # These are the core schema files that MUST have schemaVersion
    local schema_files=(
        "${schema_dir}/todo.schema.json"
        "${schema_dir}/config.schema.json"
        "${schema_dir}/archive.schema.json"
        "${schema_dir}/log.schema.json"
    )

    for schema_file in "${schema_files[@]}"; do
        # File must exist
        assert_file_exists "$schema_file"

        # File must be valid JSON
        run jq empty "$schema_file"
        assert_success

        # File must have schemaVersion field
        run jq -e '.schemaVersion' "$schema_file"
        assert_success

        # schemaVersion must not be null or empty
        local version
        version=$(jq -r '.schemaVersion' "$schema_file")
        assert [ -n "$version" ]
        assert [ "$version" != "null" ]

        # schemaVersion must match semver pattern (X.Y.Z)
        echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'
        assert_success
    done
}

# =============================================================================
# TEST 4: No fallback patterns exist (T1251)
# =============================================================================

@test "no fallback patterns exist in lib/ or scripts/" {
    # Fallback patterns like ${VAR:-2.4.0} were removed in T1251
    # Pattern: :-followed-by-semver (e.g., ":-2.4.0")
    local fallback_pattern=':-[0-9]\+\.[0-9]\+\.[0-9]\+'

    # Search lib/ directory
    run grep -rn "$fallback_pattern" "${LIB_DIR}/"

    # Should NOT find any matches (exit code 1 from grep means no matches)
    assert_failure

    # Ensure empty output
    assert_output ""

    # Search scripts/ directory
    run grep -rn "$fallback_pattern" "${SCRIPTS_DIR}/"

    # Should NOT find any matches
    assert_failure

    # Ensure empty output
    assert_output ""
}
