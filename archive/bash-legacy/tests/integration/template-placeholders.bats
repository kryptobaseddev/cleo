#!/usr/bin/env bats
# =============================================================================
# template-placeholders.bats - Phase 2 tests for template placeholder system (T1261)
# =============================================================================
# Tests validate the template placeholder system:
# 1. Templates use {{SCHEMA_VERSION_*}} placeholders, not hardcoded versions
# 2. Templates contain proper placeholder syntax for all core files
# 3. init.sh replaces placeholders correctly with actual versions
# 4. No placeholders remain in initialized projects
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
# TEST 1: Templates do not contain hardcoded version literals
# =============================================================================

@test "templates do not contain hardcoded semver literals" {
    # Templates should NOT have hardcoded versions like "2.4.0"
    # They should use placeholders like {{SCHEMA_VERSION_TODO}}

    # Pattern: JSON string value containing semver (e.g., "schemaVersion": "2.4.0")
    local version_pattern='"schemaVersion"[[:space:]]*:[[:space:]]*"[0-9]\+\.[0-9]\+\.[0-9]\+"'

    # Search all template files
    run grep -rn "$version_pattern" "${TEMPLATES_DIR}/"

    # Should NOT find any matches (exit code 1 means no matches)
    assert_failure

    # Ensure empty output
    assert_output ""
}

# =============================================================================
# TEST 2: Templates contain placeholder syntax
# =============================================================================

@test "templates contain SCHEMA_VERSION placeholders" {
    # Templates MUST have placeholder syntax like {{SCHEMA_VERSION_TODO}}
    local placeholder_pattern='{{SCHEMA_VERSION_'

    # Search all template files
    run grep -l "$placeholder_pattern" "${TEMPLATES_DIR}"/*.template.json

    # Should find matches (exit code 0)
    assert_success

    # Should find at least the core templates (todo, config, archive, log)
    # Count lines in output (each line is a file)
    local file_count
    file_count=$(echo "$output" | wc -l)

    # Should have at least 4 template files with placeholders
    assert [ "$file_count" -ge 4 ]
}

@test "todo template uses TODO placeholder" {
    local template="${TEMPLATES_DIR}/todo.template.json"

    # File must exist
    assert_file_exists "$template"

    # Must contain {{SCHEMA_VERSION_TODO}} placeholder
    run grep '{{SCHEMA_VERSION_TODO}}' "$template"
    assert_success
}

@test "config template uses CONFIG placeholder" {
    local template="${TEMPLATES_DIR}/config.template.json"

    # File must exist
    assert_file_exists "$template"

    # Must contain {{SCHEMA_VERSION_CONFIG}} placeholder
    run grep '{{SCHEMA_VERSION_CONFIG}}' "$template"
    assert_success
}

@test "archive template uses ARCHIVE placeholder" {
    local template="${TEMPLATES_DIR}/archive.template.json"

    # File must exist
    assert_file_exists "$template"

    # Must contain {{SCHEMA_VERSION_ARCHIVE}} placeholder
    run grep '{{SCHEMA_VERSION_ARCHIVE}}' "$template"
    assert_success
}

@test "log template uses LOG placeholder" {
    local template="${TEMPLATES_DIR}/log.template.json"

    # File must exist
    assert_file_exists "$template"

    # Must contain {{SCHEMA_VERSION_LOG}} placeholder
    run grep '{{SCHEMA_VERSION_LOG}}' "$template"
    assert_success
}

# =============================================================================
# TEST 3: init.sh replaces placeholders correctly
# =============================================================================

@test "init replaces placeholders with actual versions" {
    # Create temporary test directory
    local test_dir
    test_dir=$(mktemp -d)

    # Initialize project
    cd "$test_dir"
    run "${SCRIPTS_DIR}/init.sh" --yes
    assert_success

    # Verify no placeholders remain in generated files
    run grep -r '{{SCHEMA_VERSION' .cleo/

    # Should NOT find any placeholders (exit code 1)
    assert_failure

    # Ensure empty output
    assert_output ""

    # Cleanup
    rm -rf "$test_dir"
}

@test "init generates valid schemaVersion in todo.json" {
    # Create temporary test directory
    local test_dir
    test_dir=$(mktemp -d)

    # Initialize project
    cd "$test_dir"
    run "${SCRIPTS_DIR}/init.sh" --yes
    assert_success

    # Verify schemaVersion exists and is valid semver
    run jq -e '._meta.schemaVersion' .cleo/todo.json
    assert_success

    # Extract version
    local version
    version=$(jq -r '._meta.schemaVersion' .cleo/todo.json)

    # Must be non-empty
    assert [ -n "$version" ]

    # Must match semver pattern
    echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'
    assert_success

    # Cleanup
    rm -rf "$test_dir"
}

@test "init generates valid schemaVersion in config.json" {
    # Create temporary test directory
    local test_dir
    test_dir=$(mktemp -d)

    # Initialize project
    cd "$test_dir"
    run "${SCRIPTS_DIR}/init.sh" --yes
    assert_success

    # Verify schemaVersion exists and is valid semver
    run jq -e '._meta.schemaVersion' .cleo/config.json
    assert_success

    # Extract version
    local version
    version=$(jq -r '._meta.schemaVersion' .cleo/config.json)

    # Must be non-empty
    assert [ -n "$version" ]

    # Must match semver pattern
    echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'
    assert_success

    # Cleanup
    rm -rf "$test_dir"
}

@test "init generates matching versions across core files" {
    # Create temporary test directory
    local test_dir
    test_dir=$(mktemp -d)

    # Initialize project
    cd "$test_dir"
    run "${SCRIPTS_DIR}/init.sh" --yes
    assert_success

    # Extract versions from each core file
    local todo_version config_version archive_version log_version
    todo_version=$(jq -r '._meta.schemaVersion' .cleo/todo.json)
    config_version=$(jq -r '._meta.schemaVersion' .cleo/config.json)
    archive_version=$(jq -r '._meta.schemaVersion' .cleo/todo-archive.json)
    log_version=$(jq -r '._meta.schemaVersion' .cleo/todo-log.jsonl)

    # Verify all schemas define their versions
    assert [ -n "$todo_version" ]
    assert [ -n "$config_version" ]
    assert [ -n "$archive_version" ]
    assert [ -n "$log_version" ]

    # Get schema versions from schema files
    local schema_todo schema_config schema_archive schema_log
    schema_todo=$(jq -r '.schemaVersion' "${PROJECT_ROOT}/schemas/todo.schema.json")
    schema_config=$(jq -r '.schemaVersion' "${PROJECT_ROOT}/schemas/config.schema.json")
    schema_archive=$(jq -r '.schemaVersion' "${PROJECT_ROOT}/schemas/archive.schema.json")
    schema_log=$(jq -r '.schemaVersion' "${PROJECT_ROOT}/schemas/log.schema.json")

    # Verify generated versions match schema versions
    assert_equal "$todo_version" "$schema_todo"
    assert_equal "$config_version" "$schema_config"
    assert_equal "$archive_version" "$schema_archive"
    assert_equal "$log_version" "$schema_log"

    # Cleanup
    rm -rf "$test_dir"
}
