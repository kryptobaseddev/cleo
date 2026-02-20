#!/usr/bin/env bats
# =============================================================================
# nexus.bats - Tests for CLEO Nexus global intelligence system (T2966)
# =============================================================================
# Tests the Nexus cross-project task coordination system:
# - nexus-registry.sh: Registration, unregistration, project management
# - nexus-query.sh: Query parsing, syntax validation, task resolution
# - nexus-permissions.sh: Permission levels, checks, enforcement
# - nexus-deps.sh: Cross-project dependencies, global graph operations
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

    # Use BATS temp directory (TEST_TEMP_DIR is set by common_setup)
    export TEST_DIR="${TEST_TEMP_DIR:-$BATS_TEST_TMPDIR}"

    # Create isolated Nexus environment (unified registry)
    export TEST_NEXUS_HOME="$TEST_DIR/.cleo/nexus"
    export NEXUS_HOME="$TEST_NEXUS_HOME"
    export NEXUS_REGISTRY_FILE="$TEST_DIR/.cleo/projects-registry.json"
    export NEXUS_CACHE_DIR="$TEST_NEXUS_HOME/cache"

    # Create mock projects
    mkdir -p "$TEST_DIR/project-a/.cleo"
    mkdir -p "$TEST_DIR/project-b/.cleo"
    mkdir -p "$TEST_DIR/project-c/.cleo"

    # Source Nexus libraries
    source "$LIB_DIR/data/nexus-registry.sh"
    source "$LIB_DIR/data/nexus-query.sh"
    source "$LIB_DIR/data/nexus-permissions.sh"
    source "$LIB_DIR/data/nexus-deps.sh"

    # Load multi-project fixture helper
    source "$BATS_TEST_DIRNAME/../fixtures/nexus/setup-multi-project.sh"
}

teardown() {
    # BATS manages TEST_TEMP_DIR cleanup automatically
    # Just clean up any Nexus-specific state
    unset NEXUS_HOME NEXUS_REGISTRY_FILE NEXUS_CACHE_DIR TEST_NEXUS_HOME
}

# =============================================================================
# nexus-registry.sh Tests
# =============================================================================

@test "nexus_init creates directory structure" {
    nexus_init
    [[ -d "$TEST_NEXUS_HOME" ]]
    [[ -f "$NEXUS_REGISTRY_FILE" ]]
    [[ -d "$NEXUS_CACHE_DIR" ]]
}

@test "nexus_init creates valid JSON registry" {
    nexus_init
    jq -e '.schemaVersion' "$NEXUS_REGISTRY_FILE"
    jq -e '.projects == {}' "$NEXUS_REGISTRY_FILE"
}

@test "nexus_register adds project to registry" {
    create_empty_todo "$TEST_DIR/project-a/.cleo/todo.json"
    nexus_init

    run nexus_register "$TEST_DIR/project-a" "project-a" "read"
    assert_success

    local result
    result=$(nexus_get_project "project-a")
    [[ -n "$result" && "$result" != "{}" ]]
}

@test "nexus_register returns project hash" {
    create_empty_todo "$TEST_DIR/project-a/.cleo/todo.json"
    nexus_init

    local hash
    hash=$(nexus_register "$TEST_DIR/project-a" "project-a" "read")

    [[ "$hash" =~ ^[a-f0-9]{12}$ ]]
}

@test "nexus_register rejects non-CLEO directory" {
    nexus_init
    mkdir -p "$TEST_DIR/not-cleo"

    run nexus_register "$TEST_DIR/not-cleo" "bad-project"
    assert_failure
    [[ "$status" -eq "$EXIT_NOT_FOUND" ]]
}

@test "nexus_register rejects duplicate project" {
    create_empty_todo "$TEST_DIR/project-a/.cleo/todo.json"
    nexus_init

    nexus_register "$TEST_DIR/project-a" "project-a" "read"

    run nexus_register "$TEST_DIR/project-a" "project-a" "read"
    assert_failure
    [[ "$status" -eq "$EXIT_NEXUS_PROJECT_EXISTS" ]]
}

@test "nexus_register rejects duplicate name" {
    create_empty_todo "$TEST_DIR/project-a/.cleo/todo.json"
    create_empty_todo "$TEST_DIR/project-b/.cleo/todo.json"
    nexus_init

    nexus_register "$TEST_DIR/project-a" "shared-name" "read"

    run nexus_register "$TEST_DIR/project-b" "shared-name" "read"
    assert_failure
    [[ "$status" -eq "$EXIT_VALIDATION_FAILED" ]]
}

@test "nexus_list returns all registered projects" {
    create_empty_todo "$TEST_DIR/project-a/.cleo/todo.json"
    create_empty_todo "$TEST_DIR/project-b/.cleo/todo.json"
    nexus_init

    nexus_register "$TEST_DIR/project-a" "project-a" "read"
    nexus_register "$TEST_DIR/project-b" "project-b" "write"

    local result
    result=$(nexus_list --json)
    local count
    count=$(echo "$result" | jq 'length')
    [[ "$count" -eq 2 ]]
}

@test "nexus_unregister removes project from registry" {
    create_empty_todo "$TEST_DIR/project-a/.cleo/todo.json"
    nexus_init

    nexus_register "$TEST_DIR/project-a" "project-a" "read"
    nexus_unregister "project-a"

    local result
    result=$(nexus_get_project "project-a")
    [[ "$result" == "{}" ]]
}

@test "nexus_project_exists returns true for registered project" {
    create_empty_todo "$TEST_DIR/project-a/.cleo/todo.json"
    nexus_init

    nexus_register "$TEST_DIR/project-a" "project-a" "read"

    run nexus_project_exists "project-a"
    assert_success
}

@test "nexus_project_exists returns false for unregistered project" {
    nexus_init

    run nexus_project_exists "nonexistent"
    assert_failure
}

@test "nexus_sync updates project metadata" {
    setup_multi_project_fixture

    # Add tasks to project-a
    cd "$TEST_DIR/project-a"
    bash "$ADD_SCRIPT" "New task" --labels "newlabel"

    # Sync and check updated count
    nexus_sync "project-a"

    local project
    project=$(nexus_get_project "project-a")
    local task_count
    task_count=$(echo "$project" | jq '.taskCount')
    [[ "$task_count" -gt 2 ]]
}

# =============================================================================
# nexus-query.sh Tests
# =============================================================================

@test "nexus_validate_syntax accepts valid queries" {
    run nexus_validate_syntax "project-a:T001"
    assert_success

    run nexus_validate_syntax ".:T001"
    assert_success

    run nexus_validate_syntax "*:T001"
    assert_success

    run nexus_validate_syntax "T001"
    assert_success
}

@test "nexus_validate_syntax rejects invalid queries" {
    run nexus_validate_syntax "project-a:"
    assert_failure
    [[ "$status" -eq "$EXIT_NEXUS_INVALID_SYNTAX" ]]

    run nexus_validate_syntax ":T001"
    assert_failure

    run nexus_validate_syntax "project-a:001"
    assert_failure
}

@test "nexus_parse_query extracts components from named project" {
    local result
    result=$(nexus_parse_query "project-a:T001")

    [[ "$(echo "$result" | jq -r '.project')" == "project-a" ]]
    [[ "$(echo "$result" | jq -r '.taskId')" == "T001" ]]
    [[ "$(echo "$result" | jq -r '.wildcard')" == "false" ]]
}

@test "nexus_parse_query handles wildcard" {
    local result
    result=$(nexus_parse_query "*:T001")

    [[ "$(echo "$result" | jq -r '.project')" == "*" ]]
    [[ "$(echo "$result" | jq -r '.wildcard')" == "true" ]]
}

@test "nexus_parse_query resolves current project" {
    export NEXUS_CURRENT_PROJECT="my-project"

    local result
    result=$(nexus_parse_query ".:T001")

    [[ "$(echo "$result" | jq -r '.project')" == "my-project" ]]
}

@test "nexus_parse_query handles implicit current project" {
    export NEXUS_CURRENT_PROJECT="my-project"

    local result
    result=$(nexus_parse_query "T001")

    [[ "$(echo "$result" | jq -r '.project')" == "my-project" ]]
}

@test "nexus_resolve_task finds task in registered project" {
    setup_multi_project_fixture

    local result
    result=$(nexus_resolve_task "project-a:T001")

    [[ "$(echo "$result" | jq -r '.id')" == "T001" ]]
    [[ "$(echo "$result" | jq -r '._project')" == "project-a" ]]
}

@test "nexus_resolve_task returns error for unregistered project" {
    setup_multi_project_fixture

    run nexus_resolve_task "nonexistent:T001"
    assert_failure
    [[ "$status" -eq "$EXIT_NEXUS_PROJECT_NOT_FOUND" ]]
}

@test "nexus_resolve_task handles wildcard search" {
    setup_multi_project_fixture

    local result
    result=$(nexus_resolve_task "*:T001")

    # Should return array with matches from both projects
    local count
    count=$(echo "$result" | jq 'length')
    [[ "$count" -ge 2 ]]
}

@test "nexus_query returns valid JSON" {
    setup_multi_project_fixture

    local result
    result=$(nexus_query "project-a:T001" --json)

    echo "$result" | jq -e '.' > /dev/null
    assert_success
}

# =============================================================================
# nexus-permissions.sh Tests
# =============================================================================

@test "nexus_permission_level returns correct values" {
    [[ "$(nexus_permission_level "read")" -eq 1 ]]
    [[ "$(nexus_permission_level "write")" -eq 2 ]]
    [[ "$(nexus_permission_level "execute")" -eq 3 ]]
    [[ "$(nexus_permission_level "invalid")" -eq 0 ]]
}

@test "nexus_get_permission returns project permission" {
    setup_multi_project_fixture

    local permission
    permission=$(nexus_get_permission "project-a")
    [[ "$permission" == "read" ]]
}

@test "nexus_set_permission updates permission" {
    setup_multi_project_fixture

    nexus_set_permission "project-a" "write"

    local permission
    permission=$(nexus_get_permission "project-a")
    [[ "$permission" == "write" ]]
}

@test "nexus_set_permission rejects invalid permission" {
    setup_multi_project_fixture

    run nexus_set_permission "project-a" "invalid"
    assert_failure
}

@test "nexus_check_permission enforces hierarchy" {
    setup_multi_project_fixture

    # project-a has read permission
    run nexus_check_permission "project-a" "read"
    assert_success

    run nexus_check_permission "project-a" "write"
    assert_failure
}

@test "nexus_check_permission allows higher permissions" {
    setup_multi_project_fixture

    nexus_set_permission "project-a" "execute"

    run nexus_check_permission "project-a" "read"
    assert_success

    run nexus_check_permission "project-a" "write"
    assert_success

    run nexus_check_permission "project-a" "execute"
    assert_success
}

@test "nexus_require_permission exits on denial" {
    setup_multi_project_fixture

    run nexus_require_permission "project-a" "execute" "test op"
    assert_failure
    [[ "$status" -eq "$EXIT_NEXUS_PERMISSION_DENIED" ]]
}

@test "nexus_can_read convenience function works" {
    setup_multi_project_fixture

    run nexus_can_read "project-a"
    assert_success

    run nexus_can_read "nonexistent"
    assert_failure
}

@test "nexus_can_write convenience function works" {
    setup_multi_project_fixture

    run nexus_can_write "project-a"
    assert_failure

    run nexus_can_write "project-b"
    assert_success
}

# =============================================================================
# nexus-deps.sh Tests - Cross-Project Discovery
# =============================================================================

@test "nexus_deps finds cross-project dependencies" {
    setup_multi_project_fixture

    # project-b:T002 depends on project-a:T002
    local result
    result=$(nexus_deps "project-b:T002" --json)

    local depends
    depends=$(echo "$result" | jq '.depends')
    [[ "$(echo "$depends" | jq 'length')" -gt 0 ]]
}

@test "nexus_deps respects permissions" {
    setup_multi_project_fixture

    # project-c is not registered, so dependencies should fail
    cd "$TEST_DIR/project-a"
    bash "$UPDATE_SCRIPT" T001 --depends "project-c:T001"

    local result
    result=$(nexus_deps "project-a:T001" --json)

    # Should have permission_denied or not_found status
    local status
    status=$(echo "$result" | jq -r '.depends[0].status')
    [[ "$status" == "permission_denied" || "$status" == "not_found" ]]
}

@test "nexus_resolve_cross_deps resolves dependencies" {
    setup_multi_project_fixture

    local deps='["T002","project-b:T001"]'
    local result
    result=$(nexus_resolve_cross_deps "$deps" "project-a")

    [[ "$(echo "$result" | jq 'length')" -eq 2 ]]
}

@test "nexus_build_global_graph creates unified graph" {
    setup_multi_project_fixture

    local graph
    graph=$(nexus_build_global_graph)

    # Should have nodes from both projects
    local node_count
    node_count=$(echo "$graph" | jq '.nodes | length')
    [[ "$node_count" -ge 4 ]]
}

@test "nexus_critical_path finds longest dependency chain" {
    setup_multi_project_fixture

    local result
    result=$(nexus_critical_path)

    # Should return valid critical path object
    echo "$result" | jq -e '.criticalPath' > /dev/null
    echo "$result" | jq -e '.length' > /dev/null
}

@test "nexus_blocking_analysis finds dependents" {
    setup_multi_project_fixture

    # project-a:T002 is a dependency of project-b:T002
    local result
    result=$(nexus_blocking_analysis "project-a:T002")

    local blocking
    blocking=$(echo "$result" | jq '.blocking')
    local count
    count=$(echo "$blocking" | jq 'length')
    [[ "$count" -ge 1 ]]
}

@test "nexus_orphan_detection finds broken references" {
    setup_multi_project_fixture

    # Add broken cross-project reference
    cd "$TEST_DIR/project-a"
    bash "$UPDATE_SCRIPT" T001 --depends "nonexistent:T999"

    local result
    result=$(nexus_orphan_detection)

    # Should find orphan
    local count
    count=$(echo "$result" | jq 'length')
    [[ "$count" -ge 1 ]]

    local reason
    reason=$(echo "$result" | jq -r '.[0].reason')
    [[ "$reason" == "project_not_registered" ]]
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "full workflow: register, query, analyze dependencies" {
    setup_multi_project_fixture

    # Query task from project-a
    local task
    task=$(nexus_query "project-a:T001" --json)
    [[ "$(echo "$task" | jq -r '.id')" == "T001" ]]

    # Analyze dependencies
    local deps
    deps=$(nexus_deps "project-b:T002" --json)
    [[ "$(echo "$deps" | jq '.depends | length')" -gt 0 ]]

    # Build global graph
    local graph
    graph=$(nexus_build_global_graph)
    [[ "$(echo "$graph" | jq '.nodes | length')" -ge 4 ]]
}

@test "permission enforcement blocks unauthorized access" {
    setup_multi_project_fixture

    # Remove read permission from project-a
    nexus_set_permission "project-a" "read"

    # Try to query task (should succeed with read)
    run nexus_query "project-a:T001" --json
    assert_success

    # Try to require write (should fail)
    run nexus_require_permission "project-a" "write" "test"
    assert_failure
}

@test "cache invalidation triggers rebuild" {
    setup_multi_project_fixture

    # Build initial graph
    local graph1
    graph1=$(nexus_build_global_graph)

    # Add task to project-a
    cd "$TEST_DIR/project-a"
    bash "$ADD_SCRIPT" "New task"
    nexus_sync "project-a"

    # Rebuild graph (should be different)
    _NEXUS_GLOBAL_GRAPH_VALID=false
    local graph2
    graph2=$(nexus_build_global_graph)

    local count1 count2
    count1=$(echo "$graph1" | jq '.nodes | length')
    count2=$(echo "$graph2" | jq '.nodes | length')
    [[ "$count2" -gt "$count1" ]]
}
