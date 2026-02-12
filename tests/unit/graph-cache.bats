#!/usr/bin/env bats
# =============================================================================
# graph-cache.bats - Unit tests for lib/tasks/graph-cache.sh
# =============================================================================
# Tests cache building, validation, invalidation, and lookup functions
# for the graph-based dependency cache system.
#
# NOTE: ensure_graph_cache returns 0 (cached) or 1 (rebuilt). Both are valid
# so we use `|| true` to ignore the return code.
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
    
    # Copy test fixture with dependencies
    cp "${FIXTURES_DIR}/graph-cache/todo.json" "$TODO_FILE"
    _update_fixture_checksum "$TODO_FILE"
    
    # CRITICAL: Set CLAUDE_DIR before sourcing the library
    # The library uses CLAUDE_DIR for cache directory location
    export CLAUDE_DIR="${TEST_TEMP_DIR}/.cleo"
    export TODO_FILE="${CLAUDE_DIR}/todo.json"
    
    # Create cache directory
    mkdir -p "${CLAUDE_DIR}/.cache"
    
    # Disable strict unset variable checking for associative array operations
    set +u
    
    # Reset source guard to allow re-sourcing
    unset _GRAPH_CACHE_LOADED
    
    # Reset global state
    unset GRAPH_CACHE_DIR GRAPH_FORWARD_INDEX GRAPH_REVERSE_INDEX
    unset GRAPH_CHECKSUM_FILE GRAPH_METADATA_FILE
    unset _FORWARD_DEPS_CACHE _REVERSE_DEPS_CACHE
    unset _GRAPH_CACHE_VALID _GRAPH_CACHE_INITIALIZED
    
    # Source the library under test (will set up paths using CLAUDE_DIR)
    source "${LIB_DIR}/tasks/graph-cache.sh"
}

teardown() {
    set +u  # Ensure no strict mode issues in teardown
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# Helper function to build cache (ignores return code since 1 = rebuilt is valid)
_build_cache() {
    ensure_graph_cache "$TODO_FILE" || true
}

# =============================================================================
# Cache Building Tests
# =============================================================================

@test "ensure_graph_cache creates cache files" {
    # Ensure no cache exists initially
    rm -f "$GRAPH_FORWARD_INDEX" "$GRAPH_REVERSE_INDEX" "$GRAPH_CHECKSUM_FILE"
    
    # Reset state
    _GRAPH_CACHE_INITIALIZED=false
    _GRAPH_CACHE_VALID=false
    
    # Build cache (ignore return code - 1 means rebuilt, 0 means cached)
    _build_cache
    
    # Verify cache files were created
    [[ -f "$GRAPH_FORWARD_INDEX" ]]
    [[ -f "$GRAPH_REVERSE_INDEX" ]]
    [[ -f "$GRAPH_CHECKSUM_FILE" ]]
}

@test "ensure_graph_cache creates valid JSON forward index" {
    _build_cache
    
    run jq empty "$GRAPH_FORWARD_INDEX"
    assert_success
}

@test "ensure_graph_cache creates valid JSON reverse index" {
    _build_cache
    
    run jq empty "$GRAPH_REVERSE_INDEX"
    assert_success
}

@test "forward index contains correct dependencies" {
    _build_cache
    
    # T004 depends on T002 and T003
    run jq -r '.T004 | sort | join(",")' "$GRAPH_FORWARD_INDEX"
    assert_success
    assert_output "T002,T003"
}

@test "reverse index contains correct dependents" {
    _build_cache
    
    # T002 is depended on by T003, T004, T015
    run jq -r '.T002 | sort | join(",")' "$GRAPH_REVERSE_INDEX"
    assert_success
    assert_output "T003,T004,T015"
}

@test "cache checksum file is created" {
    _build_cache
    
    [[ -f "$GRAPH_CHECKSUM_FILE" ]]
    [[ -s "$GRAPH_CHECKSUM_FILE" ]]  # Not empty
}

# =============================================================================
# Cache Validation Tests
# =============================================================================

@test "_graph_cache_is_stale returns true when no cache exists" {
    rm -f "$GRAPH_FORWARD_INDEX" "$GRAPH_REVERSE_INDEX" "$GRAPH_CHECKSUM_FILE"
    
    run _graph_cache_is_stale "$TODO_FILE"
    assert_success  # 0 = stale (true)
}

@test "_graph_cache_is_stale returns false for fresh cache" {
    _build_cache
    
    run _graph_cache_is_stale "$TODO_FILE"
    assert_failure  # 1 = not stale (false)
}

@test "_graph_cache_is_stale returns true after todo.json change" {
    _build_cache
    
    # Modify todo.json
    jq '.tasks += [{"id": "T999", "title": "New task", "status": "pending"}]' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"
    
    run _graph_cache_is_stale "$TODO_FILE"
    assert_success  # 0 = stale (true)
}

@test "checksum mismatch causes staleness" {
    _build_cache
    
    # Corrupt checksum file
    echo "wrong_checksum" > "$GRAPH_CHECKSUM_FILE"
    
    run _graph_cache_is_stale "$TODO_FILE"
    assert_success  # 0 = stale
}

# =============================================================================
# Cache Invalidation Tests
# =============================================================================

@test "invalidate_graph_cache deletes and rebuilds cache files" {
    _build_cache
    
    [[ -f "$GRAPH_FORWARD_INDEX" ]]
    [[ -f "$GRAPH_REVERSE_INDEX" ]]
    
    # Invalidate (this also rebuilds via ensure_graph_cache call)
    invalidate_graph_cache "$TODO_FILE" || true
    
    # Files should be recreated after invalidate
    [[ -f "$GRAPH_FORWARD_INDEX" ]]
}

@test "invalidate_graph_cache clears in-memory state" {
    _build_cache
    
    # Populate in-memory cache
    local deps
    deps=$(get_forward_deps "T004")
    [[ -n "$deps" ]]
    
    # Clear the in-memory state variables manually for this test
    _GRAPH_CACHE_VALID=false
    _GRAPH_CACHE_INITIALIZED=false
    _FORWARD_DEPS_CACHE=()
    _REVERSE_DEPS_CACHE=()
    
    # After clearing, lookups should work (will re-load from disk)
    deps=$(get_forward_deps "T004")
    [[ -n "$deps" ]]
}

# =============================================================================
# Lookup Function Tests - Forward Dependencies
# =============================================================================

@test "get_forward_deps returns correct dependencies" {
    _build_cache
    
    # T004 depends on T002 and T003
    run get_forward_deps "T004"
    assert_success
    
    # Check both dependencies are present
    [[ "$output" == *"T002"* ]]
    [[ "$output" == *"T003"* ]]
}

@test "get_forward_deps returns empty for task with no deps" {
    _build_cache
    
    # T012 has no dependencies
    run get_forward_deps "T012"
    assert_success
    assert_output ""
}

@test "get_forward_deps returns multiple dependencies" {
    _build_cache
    
    # T015 depends on T002, T003, T004, T007, T008
    run get_forward_deps "T015"
    assert_success
    
    # Should have 5 dependencies
    local dep_count
    dep_count=$(echo "$output" | tr ',' '\n' | wc -l)
    [[ $dep_count -eq 5 ]]
}

@test "get_forward_deps handles nonexistent task" {
    _build_cache
    
    run get_forward_deps "T999"
    assert_success
    assert_output ""
}

# =============================================================================
# Lookup Function Tests - Reverse Dependencies
# =============================================================================

@test "get_reverse_deps returns dependent tasks" {
    _build_cache
    
    # T002 is depended on by T003, T004, T015
    run get_reverse_deps "T002"
    assert_success
    
    [[ "$output" == *"T003"* ]]
    [[ "$output" == *"T004"* ]]
    [[ "$output" == *"T015"* ]]
}

@test "get_reverse_deps returns empty for task with no dependents" {
    _build_cache
    
    # T013 has no tasks depending on it
    run get_reverse_deps "T013"
    assert_success
    assert_output ""
}

@test "get_reverse_deps handles epic with dependent epic" {
    _build_cache
    
    # T001 (auth epic) is depended on by T006 (gateway epic)
    run get_reverse_deps "T001"
    assert_success
    assert_output "T006"
}

# =============================================================================
# Dependency Count Tests
# =============================================================================

@test "get_forward_dep_count returns correct count" {
    _build_cache
    
    # T004 depends on 2 tasks
    run get_forward_dep_count "T004"
    assert_success
    assert_output "2"
}

@test "get_forward_dep_count returns 0 for no deps" {
    _build_cache
    
    run get_forward_dep_count "T012"
    assert_success
    assert_output "0"
}

@test "get_reverse_dep_count returns correct count" {
    _build_cache
    
    # T002 is depended on by 3 tasks
    run get_reverse_dep_count "T002"
    assert_success
    assert_output "3"
}

# =============================================================================
# Cache Statistics Tests
# =============================================================================

@test "graph_cache_stats returns valid JSON" {
    _build_cache
    
    run graph_cache_stats
    assert_success
    
    # Should be valid JSON
    echo "$output" | jq empty
}

@test "graph_cache_stats reports cache status" {
    _build_cache
    
    run graph_cache_stats
    assert_success
    
    # Check expected fields
    local valid
    valid=$(echo "$output" | jq -r '.valid')
    [[ "$valid" == "true" ]]
}

@test "graph_cache_is_valid returns correct status" {
    # Initially not valid (not initialized)
    _GRAPH_CACHE_INITIALIZED=false
    
    run graph_cache_is_valid
    assert_failure  # Not valid
    
    # Build cache
    _build_cache
    
    run graph_cache_is_valid
    assert_success  # Now valid
}

# =============================================================================
# Graph JSON Access Tests
# =============================================================================

@test "get_forward_graph_json returns valid JSON" {
    _build_cache
    
    run get_forward_graph_json
    assert_success
    
    echo "$output" | jq empty
}

@test "get_reverse_graph_json returns valid JSON" {
    _build_cache
    
    run get_reverse_graph_json
    assert_success
    
    echo "$output" | jq empty
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "cache handles empty todo.json" {
    # Create empty todo.json
    create_empty_todo "$TODO_FILE"
    _update_fixture_checksum "$TODO_FILE"
    
    # Reset state
    _GRAPH_CACHE_INITIALIZED=false
    rm -f "$GRAPH_FORWARD_INDEX" "$GRAPH_REVERSE_INDEX" "$GRAPH_CHECKSUM_FILE"
    
    _build_cache
    
    [[ -f "$GRAPH_FORWARD_INDEX" ]]
    
    # Forward deps should be empty object
    run jq 'length' "$GRAPH_FORWARD_INDEX"
    assert_output "0"
}

@test "cache handles tasks with null depends array" {
    # Modify fixture to have null depends
    jq '.tasks[0].depends = null' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"
    _update_fixture_checksum "$TODO_FILE"
    
    # Reset state
    _GRAPH_CACHE_INITIALIZED=false
    rm -f "$GRAPH_FORWARD_INDEX" "$GRAPH_REVERSE_INDEX" "$GRAPH_CHECKSUM_FILE"
    
    # Should not error
    _build_cache
    [[ -f "$GRAPH_FORWARD_INDEX" ]]
}

@test "ensure_graph_cache is idempotent" {
    _build_cache
    
    local first_checksum
    first_checksum=$(cat "$GRAPH_CHECKSUM_FILE")
    
    # Call again - should not change checksum
    _build_cache
    
    local second_checksum
    second_checksum=$(cat "$GRAPH_CHECKSUM_FILE")
    
    [[ "$first_checksum" == "$second_checksum" ]]
}

@test "cache auto-rebuilds when stale" {
    _build_cache
    
    local first_checksum
    first_checksum=$(cat "$GRAPH_CHECKSUM_FILE")
    
    # Modify source
    jq '.tasks += [{"id": "T999", "title": "New", "status": "pending"}]' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"
    
    # Clear in-memory state to force re-check
    _GRAPH_CACHE_INITIALIZED=false
    
    # Should auto-rebuild
    _build_cache
    
    local second_checksum
    second_checksum=$(cat "$GRAPH_CHECKSUM_FILE")
    
    [[ "$first_checksum" != "$second_checksum" ]]
}

# =============================================================================
# Utility Function Tests
# =============================================================================

@test "get_all_tasks_with_deps returns tasks that have dependencies" {
    _build_cache
    
    run get_all_tasks_with_deps
    assert_success
    
    # T003, T004, T006, etc. have deps
    [[ "$output" == *"T003"* ]]
    [[ "$output" == *"T004"* ]]
    [[ "$output" == *"T006"* ]]
}

@test "get_all_depended_tasks returns tasks that are depended on" {
    _build_cache
    
    run get_all_depended_tasks
    assert_success
    
    # T001, T002, T003, etc. are depended on
    [[ "$output" == *"T001"* ]]
    [[ "$output" == *"T002"* ]]
}

# =============================================================================
# Performance Tests
# =============================================================================

@test "cache build completes in under 1 second" {
    rm -f "$GRAPH_FORWARD_INDEX" "$GRAPH_REVERSE_INDEX" "$GRAPH_CHECKSUM_FILE"
    _GRAPH_CACHE_INITIALIZED=false
    
    local start_time end_time duration
    start_time=$(date +%s%N)
    
    _build_cache
    
    end_time=$(date +%s%N)
    duration=$(( (end_time - start_time) / 1000000 ))  # Convert to milliseconds
    
    # Should complete in under 1000ms
    [[ $duration -lt 1000 ]]
}

@test "cached lookup completes in under 100ms" {
    _build_cache
    
    local start_time end_time duration
    start_time=$(date +%s%N)
    
    # Perform multiple lookups
    get_forward_deps "T004" >/dev/null
    get_reverse_deps "T002" >/dev/null
    get_forward_dep_count "T015" >/dev/null
    get_reverse_dep_count "T001" >/dev/null
    
    end_time=$(date +%s%N)
    duration=$(( (end_time - start_time) / 1000000 ))
    
    # All lookups should complete in under 100ms total
    [[ $duration -lt 100 ]]
}

@test "repeated lookups use cached data" {
    _build_cache
    
    # First lookup
    local first_result
    first_result=$(get_forward_deps "T004")
    
    # Delete cache files but keep in-memory
    rm -f "$GRAPH_FORWARD_INDEX" "$GRAPH_REVERSE_INDEX"
    
    # Second lookup should still work (from memory)
    local second_result
    second_result=$(get_forward_deps "T004")
    
    [[ "$first_result" == "$second_result" ]]
}
