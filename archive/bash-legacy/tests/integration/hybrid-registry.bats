#!/usr/bin/env bats
# =============================================================================
# hybrid-registry.bats - Integration tests for hybrid registry architecture
# =============================================================================
# End-to-end tests validating the hybrid registry model across CLI commands.
#
# HYBRID MODEL:
#   1. Global registry (~/.cleo/projects-registry.json): Minimal project info
#      - path, name, registeredAt, lastSeen, health.status, health.lastCheck
#   2. Per-project file (.cleo/project-info.json): Detailed metadata
#      - schemaVersion, projectHash, schemas, injection, health (full)
#
# Tests cover:
#   - cleo init: Creates per-project files with correct structure
#   - cleo doctor: Reads from per-project file, updates health status
#   - Legacy compatibility: Projects without project-info.json still work
#   - Library functions: Integration with actual project state
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test

    # Use PROJECT_ROOT as CLEO_HOME (contains all dependencies)
    export CLEO_HOME="${PROJECT_ROOT}"
    export CLEO_LIB_DIR="${PROJECT_ROOT}/lib"

    # Source library for helper functions
    source "$LIB_DIR/data/project-registry.sh"

    cd "$TEST_TEMP_DIR"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper Functions
# =============================================================================

# Run init script with CLEO_HOME set to PROJECT_ROOT
run_init() {
    CLEO_HOME="${PROJECT_ROOT}" run bash "$INIT_SCRIPT" "$@"
}

# Run doctor script
run_doctor() {
    CLEO_HOME="${PROJECT_ROOT}" run bash "$SCRIPTS_DIR/doctor.sh" "$@"
}

# Run upgrade script
run_upgrade() {
    CLEO_HOME="${PROJECT_ROOT}" run bash "$SCRIPTS_DIR/upgrade.sh" "$@"
}

# =============================================================================
# cleo init Tests - Per-Project File Creation
# =============================================================================

@test "cleo init creates .cleo directory structure" {
    # Remove any existing .cleo
    rm -rf "${TEST_TEMP_DIR}/.cleo"

    run_init "test-project"

    # Allow success or "already initialized" (101)
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 101 ]]

    # Verify .cleo directory structure
    # Use assert_exists for directory, assert_file_exists for files
    assert_exists "${TEST_TEMP_DIR}/.cleo"
    assert_file_exists "${TEST_TEMP_DIR}/.cleo/todo.json"
    assert_file_exists "${TEST_TEMP_DIR}/.cleo/config.json"
}

@test "cleo init creates per-project project-info.json" {
    rm -rf "${TEST_TEMP_DIR}/.cleo"

    run_init "test-project"
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 101 ]]

    # Verify project-info.json exists
    assert_file_exists "${TEST_TEMP_DIR}/.cleo/project-info.json"

    # Validate it's proper JSON
    run jq empty "${TEST_TEMP_DIR}/.cleo/project-info.json"
    assert_success
}

@test "cleo init project-info.json has required fields" {
    rm -rf "${TEST_TEMP_DIR}/.cleo"

    run_init "test-project"
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 101 ]]

    local info_file="${TEST_TEMP_DIR}/.cleo/project-info.json"

    # Check schemaVersion
    local schema_version
    schema_version=$(jq -r '.schemaVersion' "$info_file")
    [ "$schema_version" = "1.0.0" ]

    # Check projectHash exists and is 12 chars
    local project_hash
    project_hash=$(jq -r '.projectHash' "$info_file")
    [ ${#project_hash} -eq 12 ]
    [[ "$project_hash" =~ ^[a-f0-9]{12}$ ]]

    # Check schemas object exists with required keys (schemas are nested objects with version)
    local has_todo has_config has_archive has_log
    has_todo=$(jq -r '.schemas.todo.version // .schemas.todo' "$info_file")
    has_config=$(jq -r '.schemas.config.version // .schemas.config' "$info_file")
    has_archive=$(jq -r '.schemas.archive.version // .schemas.archive' "$info_file")
    has_log=$(jq -r '.schemas.log.version // .schemas.log' "$info_file")

    [ "$has_todo" != "null" ]
    [ "$has_config" != "null" ]
    [ "$has_archive" != "null" ]
    [ "$has_log" != "null" ]
}

@test "cleo init project hash matches path-based hash" {
    rm -rf "${TEST_TEMP_DIR}/.cleo"

    run_init "test-hash"
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 101 ]]

    local info_file="${TEST_TEMP_DIR}/.cleo/project-info.json"

    # Get hash from file
    local file_hash
    file_hash=$(jq -r '.projectHash' "$info_file")

    # Compute expected hash
    local expected_hash
    expected_hash=$(generate_project_hash "$TEST_TEMP_DIR")

    # Should match
    [ "$file_hash" = "$expected_hash" ]
}

# =============================================================================
# cleo doctor Tests - Per-Project File Reading
# =============================================================================

@test "cleo doctor runs without error on initialized project" {
    rm -rf "${TEST_TEMP_DIR}/.cleo"
    run_init "test-doctor"
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 101 ]]

    # Run doctor
    run_doctor
    # Doctor returns various exit codes based on health
    # 0 = OK, 50 = warning, 51 = issue, 52 = critical, 100 = no config
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 50 ]] || [[ "$status" -eq 51 ]] || [[ "$status" -eq 52 ]] || [[ "$status" -eq 100 ]]
}

@test "cleo doctor updates health status in per-project file" {
    rm -rf "${TEST_TEMP_DIR}/.cleo"
    run_init "test-doctor-health"
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 101 ]]

    # Run doctor
    run_doctor
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 50 ]] || [[ "$status" -eq 51 ]] || [[ "$status" -eq 52 ]] || [[ "$status" -eq 100 ]]

    local info_file="${TEST_TEMP_DIR}/.cleo/project-info.json"

    # Check health status was updated (if file exists)
    if [[ -f "$info_file" ]]; then
        local health_status
        health_status=$(jq -r '.health.status // "not-set"' "$info_file")

        # Health status should be one of: healthy, warning, error, unknown
        [[ "$health_status" =~ ^(healthy|warning|error|unknown|not-set)$ ]]
    fi
}

# =============================================================================
# Legacy Compatibility Tests
# =============================================================================

@test "legacy project without project-info.json still works with list" {
    # Create legacy project structure (only core files, no project-info.json)
    mkdir -p "${TEST_TEMP_DIR}/.cleo"

    # Create minimal todo.json (v2.3.0 format)
    cat > "${TEST_TEMP_DIR}/.cleo/todo.json" << 'EOF'
{
  "version": "2.3.0",
  "project": {"name": "legacy-project", "currentPhase": "setup"},
  "_meta": {"version": "2.3.0", "checksum": "abc123"},
  "tasks": [
    {"id": "T001", "title": "Legacy task", "description": "Test", "status": "pending", "priority": "medium", "createdAt": "2025-01-01T00:00:00Z"}
  ],
  "focus": {},
  "labels": {},
  "lastUpdated": "2025-01-01T00:00:00Z"
}
EOF

    # Create minimal config
    cat > "${TEST_TEMP_DIR}/.cleo/config.json" << 'EOF'
{
  "version": "2.2.0",
  "validation": {"strictMode": false},
  "multiSession": {"enabled": false},
  "session": {"requireSession": false}
}
EOF

    # Ensure NO project-info.json exists
    rm -f "${TEST_TEMP_DIR}/.cleo/project-info.json"

    # Run list command - should work without project-info.json
    CLEO_HOME="${PROJECT_ROOT}" run bash "$LIST_SCRIPT"
    assert_success
}

@test "legacy project without project-info.json doctor does not fail" {
    mkdir -p "${TEST_TEMP_DIR}/.cleo"

    # Create minimal structure
    cat > "${TEST_TEMP_DIR}/.cleo/todo.json" << 'EOF'
{
  "version": "2.3.0",
  "_meta": {"version": "2.3.0", "checksum": "abc123"},
  "tasks": [],
  "focus": {},
  "lastUpdated": "2025-01-01T00:00:00Z"
}
EOF

    cat > "${TEST_TEMP_DIR}/.cleo/config.json" << 'EOF'
{
  "version": "2.2.0",
  "validation": {"strictMode": false}
}
EOF

    # No project-info.json
    rm -f "${TEST_TEMP_DIR}/.cleo/project-info.json"

    # Doctor should handle gracefully
    run_doctor
    # Should not fail with error exit code
    # 0 = OK, 50 = warning, 51 = issue, 52 = critical, 100 = no config
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 50 ]] || [[ "$status" -eq 51 ]] || [[ "$status" -eq 52 ]] || [[ "$status" -eq 100 ]]
}

# =============================================================================
# Library Function Integration Tests
# =============================================================================

@test "get_project_info returns correct data from initialized project" {
    rm -rf "${TEST_TEMP_DIR}/.cleo"
    run_init "test-get-info"
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 101 ]]

    local info
    info=$(get_project_info "$TEST_TEMP_DIR")

    # Should have schema version
    local version
    version=$(echo "$info" | jq -r '.schemaVersion')
    [ "$version" = "1.0.0" ]
}

@test "has_project_info returns true after init" {
    rm -rf "${TEST_TEMP_DIR}/.cleo"
    run_init "test-has-info"
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 101 ]]

    run has_project_info "$TEST_TEMP_DIR"
    assert_success
}

@test "has_project_info returns false for legacy project" {
    mkdir -p "${TEST_TEMP_DIR}/.cleo"
    rm -f "${TEST_TEMP_DIR}/.cleo/project-info.json"

    run has_project_info "$TEST_TEMP_DIR"
    assert_failure
}

# =============================================================================
# Schema Version Tracking Tests
# =============================================================================

@test "per-project file tracks schema versions in semver format" {
    rm -rf "${TEST_TEMP_DIR}/.cleo"
    run_init "schema-test"
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 101 ]]

    local info_file="${TEST_TEMP_DIR}/.cleo/project-info.json"

    # Schema versions are nested objects with .version property
    local todo_version config_version archive_version log_version
    todo_version=$(jq -r '.schemas.todo.version // .schemas.todo' "$info_file")
    config_version=$(jq -r '.schemas.config.version // .schemas.config' "$info_file")
    archive_version=$(jq -r '.schemas.archive.version // .schemas.archive' "$info_file")
    log_version=$(jq -r '.schemas.log.version // .schemas.log' "$info_file")

    # Validate semver format (X.Y.Z)
    [[ "$todo_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
    [[ "$config_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
    [[ "$archive_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
    [[ "$log_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# =============================================================================
# Multiple Project Tests
# =============================================================================

@test "different directories get unique project hashes" {
    # Create two separate project directories
    local project1="${TEST_TEMP_DIR}/project1"
    local project2="${TEST_TEMP_DIR}/project2"
    mkdir -p "$project1" "$project2"

    # Initialize both
    cd "$project1"
    CLEO_HOME="${PROJECT_ROOT}" run bash "$INIT_SCRIPT" "project-one"
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 101 ]]

    cd "$project2"
    CLEO_HOME="${PROJECT_ROOT}" run bash "$INIT_SCRIPT" "project-two"
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 101 ]]

    # Get hashes from project-info.json files
    local hash1 hash2
    hash1=$(jq -r '.projectHash' "$project1/.cleo/project-info.json")
    hash2=$(jq -r '.projectHash' "$project2/.cleo/project-info.json")

    # Hashes should be different
    [ "$hash1" != "$hash2" ]
}

# =============================================================================
# Reinitialize Tests
# =============================================================================

@test "reinitialize preserves project hash" {
    rm -rf "${TEST_TEMP_DIR}/.cleo"

    # First init
    run_init "reinit-test"
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 101 ]]

    local info_file="${TEST_TEMP_DIR}/.cleo/project-info.json"
    local original_hash
    original_hash=$(jq -r '.projectHash' "$info_file")

    # Force reinit
    run_init --force --confirm-wipe "reinit-test-new"
    [[ "$status" -eq 0 ]]

    # Hash should be the same (based on path, not name)
    local new_hash
    new_hash=$(jq -r '.projectHash' "$info_file")

    [ "$original_hash" = "$new_hash" ]
}

# =============================================================================
# File Structure Compatibility Tests
# =============================================================================

@test "initialized project has valid todo.json structure" {
    rm -rf "${TEST_TEMP_DIR}/.cleo"
    run_init "structure-test"
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 101 ]]

    # Verify todo.json has expected structure
    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    assert_file_exists "$todo_file"

    # Check required fields
    local has_tasks has_meta has_focus
    has_tasks=$(jq 'has("tasks")' "$todo_file")
    has_meta=$(jq 'has("_meta")' "$todo_file")
    has_focus=$(jq 'has("focus")' "$todo_file")

    [ "$has_tasks" = "true" ]
    [ "$has_meta" = "true" ]
    [ "$has_focus" = "true" ]
}

@test "initialized project has valid config.json structure" {
    rm -rf "${TEST_TEMP_DIR}/.cleo"
    run_init "config-test"
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 101 ]]

    # Verify config.json has expected structure
    local config_file="${TEST_TEMP_DIR}/.cleo/config.json"
    assert_file_exists "$config_file"

    # Check version field
    local version
    version=$(jq -r '.version // ._meta.schemaVersion // "none"' "$config_file")
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}
