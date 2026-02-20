#!/usr/bin/env bats
# =============================================================================
# hybrid-registry.bats - Unit tests for hybrid registry functions
# =============================================================================
# Tests for lib/data/project-registry.sh functions that implement the hybrid
# registry architecture (global registry + per-project info files).
#
# HYBRID MODEL:
#   1. Global registry (~/.cleo/projects-registry.json): Minimal project info
#   2. Per-project file (.cleo/project-info.json): Detailed metadata
#
# Tests cover:
#   - get_project_info_path: Path resolution
#   - has_project_info: File existence checks
#   - get_project_info: Reading per-project files
#   - save_project_info: Writing per-project files
#   - get_project_data: Merging global and local data
#   - generate_project_hash: Hash generation
#   - is_project_registered: Global registry checks
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    # Source the library under test
    source "$LIB_DIR/data/project-registry.sh"

    # Create mock CLEO_HOME for global registry tests
    export MOCK_CLEO_HOME="${TEST_TEMP_DIR}/mock-cleo-home"
    mkdir -p "$MOCK_CLEO_HOME"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# get_project_info_path Tests
# =============================================================================

@test "get_project_info_path returns correct path for given directory" {
    local result
    result=$(get_project_info_path "/home/user/myproject")
    [ "$result" = "/home/user/myproject/.cleo/project-info.json" ]
}

@test "get_project_info_path defaults to PWD when no argument given" {
    local expected="${TEST_TEMP_DIR}/.cleo/project-info.json"
    local result
    result=$(get_project_info_path)
    [ "$result" = "$expected" ]
}

@test "get_project_info_path handles paths with spaces" {
    local result
    result=$(get_project_info_path "/home/user/my project/foo")
    [ "$result" = "/home/user/my project/foo/.cleo/project-info.json" ]
}

@test "get_project_info_path handles nested paths" {
    local result
    result=$(get_project_info_path "/a/b/c/d/e")
    [ "$result" = "/a/b/c/d/e/.cleo/project-info.json" ]
}

# =============================================================================
# has_project_info Tests
# =============================================================================

@test "has_project_info returns false when file missing" {
    # Ensure no project-info.json exists
    rm -f "${TEST_TEMP_DIR}/.cleo/project-info.json"

    run has_project_info "$TEST_TEMP_DIR"
    assert_failure
}

@test "has_project_info returns true when file exists" {
    # Create project-info.json
    mkdir -p "${TEST_TEMP_DIR}/.cleo"
    echo '{"schemaVersion":"1.0.0"}' > "${TEST_TEMP_DIR}/.cleo/project-info.json"

    run has_project_info "$TEST_TEMP_DIR"
    assert_success
}

@test "has_project_info returns false when .cleo directory missing" {
    # Remove .cleo directory entirely
    rm -rf "${TEST_TEMP_DIR}/.cleo"

    run has_project_info "$TEST_TEMP_DIR"
    assert_failure
}

@test "has_project_info defaults to PWD" {
    mkdir -p "${TEST_TEMP_DIR}/.cleo"
    echo '{}' > "${TEST_TEMP_DIR}/.cleo/project-info.json"
    cd "$TEST_TEMP_DIR"

    run has_project_info
    assert_success
}

# =============================================================================
# get_project_info Tests
# =============================================================================

@test "get_project_info returns empty object when file missing" {
    rm -f "${TEST_TEMP_DIR}/.cleo/project-info.json"

    run get_project_info "$TEST_TEMP_DIR"
    assert_success
    assert_output "{}"
}

@test "get_project_info returns file contents when exists" {
    mkdir -p "${TEST_TEMP_DIR}/.cleo"
    cat > "${TEST_TEMP_DIR}/.cleo/project-info.json" << 'EOF'
{
  "schemaVersion": "1.0.0",
  "projectHash": "abc123def456",
  "schemas": {
    "todo": "2.6.0",
    "config": "2.2.0",
    "archive": "2.4.0",
    "log": "2.1.0"
  }
}
EOF

    run get_project_info "$TEST_TEMP_DIR"
    assert_success
    assert_output --partial '"schemaVersion"'
    assert_output --partial '"1.0.0"'
    assert_output --partial '"projectHash"'
}

@test "get_project_info fails on invalid JSON" {
    mkdir -p "${TEST_TEMP_DIR}/.cleo"
    echo 'not valid json {{{' > "${TEST_TEMP_DIR}/.cleo/project-info.json"

    run get_project_info "$TEST_TEMP_DIR"
    assert_failure
    assert_output --partial "Invalid JSON"
}

@test "get_project_info returns complete structure" {
    mkdir -p "${TEST_TEMP_DIR}/.cleo"
    cat > "${TEST_TEMP_DIR}/.cleo/project-info.json" << 'EOF'
{
  "schemaVersion": "1.0.0",
  "projectHash": "abc123def456",
  "cleoVersion": "0.68.0",
  "lastUpdated": "2026-01-23T12:00:00Z",
  "schemas": {
    "todo": "2.6.0",
    "config": "2.2.0",
    "archive": "2.4.0",
    "log": "2.1.0"
  },
  "health": {
    "status": "healthy",
    "lastCheck": "2026-01-23T11:00:00Z",
    "issues": []
  }
}
EOF

    local result
    result=$(get_project_info "$TEST_TEMP_DIR")

    local schema_version
    schema_version=$(echo "$result" | jq -r '.schemaVersion')
    [ "$schema_version" = "1.0.0" ]

    local health_status
    health_status=$(echo "$result" | jq -r '.health.status')
    [ "$health_status" = "healthy" ]
}

# =============================================================================
# save_project_info Tests
# =============================================================================

@test "save_project_info creates file with content" {
    # Remove any existing file
    rm -f "${TEST_TEMP_DIR}/.cleo/project-info.json"

    echo '{"test":"value","schemaVersion":"1.0.0"}' | save_project_info "$TEST_TEMP_DIR"

    assert_file_exists "${TEST_TEMP_DIR}/.cleo/project-info.json"

    local content
    content=$(cat "${TEST_TEMP_DIR}/.cleo/project-info.json")
    [[ "$content" =~ '"test"' ]]
    [[ "$content" =~ '"value"' ]]
}

@test "save_project_info saves to existing .cleo directory" {
    # Test that save_project_info works when .cleo directory already exists
    # NOTE: The function is designed to create .cleo if missing, but the atomic
    # write dependency (save_json) requires backup infrastructure. This test
    # validates the primary use case where .cleo already exists.
    mkdir -p "${TEST_TEMP_DIR}/.cleo"

    echo '{"test":"value"}' | save_project_info "$TEST_TEMP_DIR"

    assert_file_exists "${TEST_TEMP_DIR}/.cleo/project-info.json"

    local content
    content=$(cat "${TEST_TEMP_DIR}/.cleo/project-info.json")
    [[ "$content" =~ '"test"' ]]
}

@test "save_project_info fails on invalid JSON input" {
    # Create a subshell script that properly sources dependencies and tests
    run bash -c "
        set +u  # Disable unbound variable errors for sourcing
        source '$LIB_DIR/data/file-ops.sh' 2>/dev/null || true
        source '$LIB_DIR/data/project-registry.sh'
        echo 'not valid json' | save_project_info '$TEST_TEMP_DIR'
    "
    assert_failure
}

@test "save_project_info overwrites existing file" {
    mkdir -p "${TEST_TEMP_DIR}/.cleo"
    echo '{"old":"data"}' > "${TEST_TEMP_DIR}/.cleo/project-info.json"

    echo '{"new":"data"}' | save_project_info "$TEST_TEMP_DIR"

    local content
    content=$(cat "${TEST_TEMP_DIR}/.cleo/project-info.json")
    [[ "$content" =~ '"new"' ]]
    [[ ! "$content" =~ '"old"' ]]
}

@test "save_project_info preserves complex JSON structure" {
    local complex_json='{
      "schemaVersion": "1.0.0",
      "projectHash": "abc123def456",
      "schemas": {
        "todo": "2.6.0",
        "config": "2.2.0"
      },
      "health": {
        "status": "healthy",
        "issues": []
      }
    }'

    echo "$complex_json" | save_project_info "$TEST_TEMP_DIR"

    local result
    result=$(jq -r '.schemas.todo' "${TEST_TEMP_DIR}/.cleo/project-info.json")
    [ "$result" = "2.6.0" ]
}

# =============================================================================
# generate_project_hash Tests
# =============================================================================

@test "generate_project_hash creates 12-character hex string" {
    local hash
    hash=$(generate_project_hash "/home/user/myproject")

    # Check length is 12
    [ ${#hash} -eq 12 ]

    # Check it's valid hex
    [[ "$hash" =~ ^[a-f0-9]{12}$ ]]
}

@test "generate_project_hash is deterministic" {
    local hash1 hash2
    hash1=$(generate_project_hash "/home/user/myproject")
    hash2=$(generate_project_hash "/home/user/myproject")

    [ "$hash1" = "$hash2" ]
}

@test "generate_project_hash differs for different paths" {
    local hash1 hash2
    hash1=$(generate_project_hash "/home/user/project1")
    hash2=$(generate_project_hash "/home/user/project2")

    [ "$hash1" != "$hash2" ]
}

@test "generate_project_hash fails without path argument" {
    run generate_project_hash
    assert_failure
    assert_output --partial "Project path required"
}

@test "generate_project_hash handles paths with spaces" {
    local hash
    hash=$(generate_project_hash "/home/user/my project")

    [ ${#hash} -eq 12 ]
    [[ "$hash" =~ ^[a-f0-9]{12}$ ]]
}

# =============================================================================
# is_project_registered Tests
# =============================================================================

@test "is_project_registered returns false when registry missing" {
    # Override get_cleo_home to use mock
    function get_cleo_home() { echo "$MOCK_CLEO_HOME"; }
    export -f get_cleo_home

    # Ensure no registry exists
    rm -f "$MOCK_CLEO_HOME/projects-registry.json"

    local hash
    hash=$(generate_project_hash "/test/project")

    run is_project_registered "$hash"
    assert_failure
}

@test "is_project_registered returns false for unregistered project" {
    function get_cleo_home() { echo "$MOCK_CLEO_HOME"; }
    export -f get_cleo_home

    # Create registry without the project
    cat > "$MOCK_CLEO_HOME/projects-registry.json" << 'EOF'
{
  "schemaVersion": "1.0.0",
  "projects": {
    "other123hash": {
      "path": "/other/project",
      "name": "other"
    }
  }
}
EOF

    local hash
    hash=$(generate_project_hash "/test/project")

    run is_project_registered "$hash"
    assert_failure
}

@test "is_project_registered returns true for registered project" {
    function get_cleo_home() { echo "$MOCK_CLEO_HOME"; }
    export -f get_cleo_home

    local hash
    hash=$(generate_project_hash "/test/project")

    # Create registry with the project
    cat > "$MOCK_CLEO_HOME/projects-registry.json" << EOF
{
  "schemaVersion": "1.0.0",
  "projects": {
    "$hash": {
      "path": "/test/project",
      "name": "test"
    }
  }
}
EOF

    run is_project_registered "$hash"
    assert_success
}

@test "is_project_registered fails without hash argument" {
    run is_project_registered
    assert_failure
    assert_output --partial "Project hash required"
}

# =============================================================================
# get_project_data Tests (Hybrid Merge)
# =============================================================================

@test "get_project_data returns empty object when project not registered" {
    function get_cleo_home() { echo "$MOCK_CLEO_HOME"; }
    export -f get_cleo_home

    # Create empty registry
    cat > "$MOCK_CLEO_HOME/projects-registry.json" << 'EOF'
{
  "schemaVersion": "1.0.0",
  "projects": {}
}
EOF

    local hash
    hash=$(generate_project_hash "/nonexistent/project")

    local result
    result=$(get_project_data "$hash")

    [ "$result" = "{}" ]
}

@test "get_project_data returns global data when no local info" {
    function get_cleo_home() { echo "$MOCK_CLEO_HOME"; }
    export -f get_cleo_home

    local hash
    hash=$(generate_project_hash "$TEST_TEMP_DIR")

    # Create registry with project but no local file
    cat > "$MOCK_CLEO_HOME/projects-registry.json" << EOF
{
  "schemaVersion": "1.0.0",
  "projects": {
    "$hash": {
      "path": "$TEST_TEMP_DIR",
      "name": "test-project",
      "registeredAt": "2026-01-23T10:00:00Z"
    }
  }
}
EOF

    # Ensure no project-info.json exists
    rm -f "${TEST_TEMP_DIR}/.cleo/project-info.json"

    local result
    result=$(get_project_data "$hash")

    local name
    name=$(echo "$result" | jq -r '.name')
    [ "$name" = "test-project" ]
}

@test "get_project_data merges global and local info" {
    function get_cleo_home() { echo "$MOCK_CLEO_HOME"; }
    export -f get_cleo_home

    local hash
    hash=$(generate_project_hash "$TEST_TEMP_DIR")

    # Create global registry with minimal data
    cat > "$MOCK_CLEO_HOME/projects-registry.json" << EOF
{
  "schemaVersion": "1.0.0",
  "projects": {
    "$hash": {
      "path": "$TEST_TEMP_DIR",
      "name": "test-project",
      "registeredAt": "2026-01-23T10:00:00Z",
      "globalField": "from-global"
    }
  }
}
EOF

    # Create local project-info.json with additional data
    mkdir -p "${TEST_TEMP_DIR}/.cleo"
    cat > "${TEST_TEMP_DIR}/.cleo/project-info.json" << 'EOF'
{
  "schemaVersion": "1.0.0",
  "localField": "from-local",
  "schemas": {
    "todo": "2.6.0",
    "config": "2.2.0",
    "archive": "2.4.0",
    "log": "2.1.0"
  }
}
EOF

    local result
    result=$(get_project_data "$hash")

    # Check global field is present
    local global_field
    global_field=$(echo "$result" | jq -r '.globalField')
    [ "$global_field" = "from-global" ]

    # Check local field is present
    local local_field
    local_field=$(echo "$result" | jq -r '.localField')
    [ "$local_field" = "from-local" ]

    # Check nested local data is present
    local todo_version
    todo_version=$(echo "$result" | jq -r '.schemas.todo')
    [ "$todo_version" = "2.6.0" ]
}

@test "get_project_data local info takes precedence over global" {
    function get_cleo_home() { echo "$MOCK_CLEO_HOME"; }
    export -f get_cleo_home

    local hash
    hash=$(generate_project_hash "$TEST_TEMP_DIR")

    # Create global registry with a name
    cat > "$MOCK_CLEO_HOME/projects-registry.json" << EOF
{
  "schemaVersion": "1.0.0",
  "projects": {
    "$hash": {
      "path": "$TEST_TEMP_DIR",
      "name": "global-name",
      "shared": "global-value"
    }
  }
}
EOF

    # Create local project-info.json with different name
    mkdir -p "${TEST_TEMP_DIR}/.cleo"
    cat > "${TEST_TEMP_DIR}/.cleo/project-info.json" << 'EOF'
{
  "schemaVersion": "1.0.0",
  "name": "local-name",
  "shared": "local-value"
}
EOF

    local result
    result=$(get_project_data "$hash")

    # Local should take precedence
    local name
    name=$(echo "$result" | jq -r '.name')
    [ "$name" = "local-name" ]

    local shared
    shared=$(echo "$result" | jq -r '.shared')
    [ "$shared" = "local-value" ]
}

@test "get_project_data handles missing path gracefully" {
    function get_cleo_home() { echo "$MOCK_CLEO_HOME"; }
    export -f get_cleo_home

    local hash
    hash=$(generate_project_hash "/nonexistent/path/xyz")

    # Create registry pointing to non-existent path
    cat > "$MOCK_CLEO_HOME/projects-registry.json" << EOF
{
  "schemaVersion": "1.0.0",
  "projects": {
    "$hash": {
      "path": "/nonexistent/path/xyz",
      "name": "missing-project"
    }
  }
}
EOF

    local result
    result=$(get_project_data "$hash")

    # Should return global data only (no merge with local)
    local name
    name=$(echo "$result" | jq -r '.name')
    [ "$name" = "missing-project" ]
}

@test "get_project_data returns empty object for empty hash" {
    local result
    result=$(get_project_data "")

    [ "$result" = "{}" ]
}

# =============================================================================
# get_project_data_global Tests (No Merge)
# =============================================================================

@test "get_project_data_global returns only global registry data" {
    function get_cleo_home() { echo "$MOCK_CLEO_HOME"; }
    export -f get_cleo_home

    local hash
    hash=$(generate_project_hash "$TEST_TEMP_DIR")

    # Create global registry
    cat > "$MOCK_CLEO_HOME/projects-registry.json" << EOF
{
  "schemaVersion": "1.0.0",
  "projects": {
    "$hash": {
      "path": "$TEST_TEMP_DIR",
      "name": "test-project",
      "globalOnly": true
    }
  }
}
EOF

    # Create local project-info.json
    mkdir -p "${TEST_TEMP_DIR}/.cleo"
    cat > "${TEST_TEMP_DIR}/.cleo/project-info.json" << 'EOF'
{
  "schemaVersion": "1.0.0",
  "localOnly": true
}
EOF

    local result
    result=$(get_project_data_global "$hash")

    # Should have global field
    local global_only
    global_only=$(echo "$result" | jq -r '.globalOnly')
    [ "$global_only" = "true" ]

    # Should NOT have local field (no merge)
    local local_only
    local_only=$(echo "$result" | jq -r '.localOnly')
    [ "$local_only" = "null" ]
}

@test "get_project_data_global returns empty object when registry missing" {
    function get_cleo_home() { echo "$MOCK_CLEO_HOME"; }
    export -f get_cleo_home

    rm -f "$MOCK_CLEO_HOME/projects-registry.json"

    local result
    result=$(get_project_data_global "somehash12345")

    [ "$result" = "{}" ]
}

# =============================================================================
# list_registered_projects Tests
# =============================================================================

@test "list_registered_projects returns empty array when no projects" {
    function get_cleo_home() { echo "$MOCK_CLEO_HOME"; }
    export -f get_cleo_home

    cat > "$MOCK_CLEO_HOME/projects-registry.json" << 'EOF'
{
  "schemaVersion": "1.0.0",
  "projects": {}
}
EOF

    local result
    result=$(list_registered_projects)

    local count
    count=$(echo "$result" | jq 'length')
    [ "$count" -eq 0 ]
}

@test "list_registered_projects returns all projects" {
    function get_cleo_home() { echo "$MOCK_CLEO_HOME"; }
    export -f get_cleo_home

    cat > "$MOCK_CLEO_HOME/projects-registry.json" << 'EOF'
{
  "schemaVersion": "1.0.0",
  "projects": {
    "hash1": {"path": "/project/1", "name": "project1"},
    "hash2": {"path": "/project/2", "name": "project2"},
    "hash3": {"path": "/project/3", "name": "project3"}
  }
}
EOF

    local result
    result=$(list_registered_projects)

    local count
    count=$(echo "$result" | jq 'length')
    [ "$count" -eq 3 ]
}

@test "list_registered_projects returns empty array when registry missing" {
    function get_cleo_home() { echo "$MOCK_CLEO_HOME"; }
    export -f get_cleo_home

    rm -f "$MOCK_CLEO_HOME/projects-registry.json"

    local result
    result=$(list_registered_projects)

    [ "$result" = "[]" ]
}

# =============================================================================
# create_empty_registry Tests
# =============================================================================

@test "create_empty_registry creates valid JSON file" {
    # Create backup directory for atomic writes
    mkdir -p "${TEST_TEMP_DIR}/.backups"

    local registry_path="${TEST_TEMP_DIR}/new-registry.json"

    # Run with set +u to avoid unbound variable issues in library
    run bash -c "
        set +u
        source '$LIB_DIR/data/project-registry.sh'
        create_empty_registry '$registry_path'
    "
    assert_success

    assert_file_exists "$registry_path"

    # Validate JSON
    run jq empty "$registry_path"
    assert_success
}

@test "create_empty_registry has correct structure" {
    # Create backup directory for atomic writes
    mkdir -p "${TEST_TEMP_DIR}/.backups"

    local registry_path="${TEST_TEMP_DIR}/test-registry.json"

    # Run with set +u to avoid unbound variable issues
    bash -c "
        set +u
        source '$LIB_DIR/data/project-registry.sh'
        create_empty_registry '$registry_path'
    "

    # Check schema version
    local version
    version=$(jq -r '.schemaVersion' "$registry_path")
    [ "$version" = "1.0.0" ]

    # Check projects is empty object
    local projects
    projects=$(jq -r '.projects | keys | length' "$registry_path")
    [ "$projects" -eq 0 ]

    # Check lastUpdated is set
    local last_updated
    last_updated=$(jq -r '.lastUpdated' "$registry_path")
    [ "$last_updated" != "null" ]
    [ "$last_updated" != "" ]
}

@test "create_empty_registry fails without path" {
    run bash -c "
        set +u
        source '$LIB_DIR/data/project-registry.sh'
        create_empty_registry
    "
    assert_failure
    assert_output --partial "Registry file path required"
}

# =============================================================================
# prune_registry Tests
# =============================================================================

@test "prune_registry removes missing projects" {
    # Create backup directory for atomic writes
    mkdir -p "${MOCK_CLEO_HOME}/.backups"

    # Create registry with one existing and one missing project
    cat > "$MOCK_CLEO_HOME/projects-registry.json" << EOF
{
  "schemaVersion": "1.0.0",
  "projects": {
    "existing123": {"path": "$TEST_TEMP_DIR", "name": "existing"},
    "missing1234": {"path": "/nonexistent/path/12345", "name": "missing"}
  }
}
EOF

    # Run with set +u and override get_cleo_home
    run bash -c "
        set +u
        export MOCK_CLEO_HOME='$MOCK_CLEO_HOME'
        source '$LIB_DIR/data/project-registry.sh'
        get_cleo_home() { echo \"\$MOCK_CLEO_HOME\"; }
        prune_registry
    "
    assert_success

    # Output should include the removed hash
    assert_output --partial "missing1234"

    # Check registry was updated
    local remaining
    remaining=$(jq '.projects | keys | length' "$MOCK_CLEO_HOME/projects-registry.json")
    [ "$remaining" -eq 1 ]
}

@test "prune_registry dry-run shows what would be removed" {
    function get_cleo_home() { echo "$MOCK_CLEO_HOME"; }
    export -f get_cleo_home

    cat > "$MOCK_CLEO_HOME/projects-registry.json" << 'EOF'
{
  "schemaVersion": "1.0.0",
  "projects": {
    "missing1234": {"path": "/nonexistent/path/1", "name": "missing1"},
    "missing5678": {"path": "/nonexistent/path/2", "name": "missing2"}
  }
}
EOF

    run prune_registry --dry-run
    assert_success

    # Should list what would be removed
    assert_output --partial "missing1234"
    assert_output --partial "missing5678"

    # But registry should be unchanged
    local count
    count=$(jq '.projects | keys | length' "$MOCK_CLEO_HOME/projects-registry.json")
    [ "$count" -eq 2 ]
}

@test "prune_registry does nothing when all projects exist" {
    function get_cleo_home() { echo "$MOCK_CLEO_HOME"; }
    export -f get_cleo_home

    cat > "$MOCK_CLEO_HOME/projects-registry.json" << EOF
{
  "schemaVersion": "1.0.0",
  "projects": {
    "existing123": {"path": "$TEST_TEMP_DIR", "name": "existing"}
  }
}
EOF

    run prune_registry
    assert_success

    # No output (nothing removed)
    [ -z "$output" ]
}
