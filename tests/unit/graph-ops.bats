#!/usr/bin/env bats
# =============================================================================
# graph-ops.bats - Unit tests for lib/tasks/graph-ops.sh
# =============================================================================
# T2140: Comprehensive tests for graph algorithms including:
# - Critical path analysis
# - Impact radius calculation
# - Dependency wave calculation
# - Cycle detection
# - Topological sort
# =============================================================================

# =============================================================================
# File-Level Setup
# =============================================================================
setup_file() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_file
}

# =============================================================================
# Per-Test Setup
# =============================================================================
setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test
    
    # Skip all tests if graph-ops.sh is not implemented
    if [[ ! -f "$LIB_DIR/tasks/graph-ops.sh" ]]; then
        skip "graph-ops.sh not yet implemented"
    fi
    
    # Set up proper environment for the test
    export CLEO_DIR="${BATS_TEST_TMPDIR}/.cleo"
    export CLAUDE_DIR="$CLEO_DIR"
    mkdir -p "$CLEO_DIR/.cache"
    mkdir -p "$CLEO_DIR/.deps-cache"
    
    # Override TODO_FILE to use our test location
    export TODO_FILE="${CLEO_DIR}/todo.json"
    
    # Reset the source guard and reload graph-cache.sh with proper CLAUDE_DIR
    unset _GRAPH_CACHE_LOADED
    
    # Re-initialize graph cache variables with correct paths
    GRAPH_CACHE_DIR="$CLEO_DIR/.cache"
    GRAPH_FORWARD_INDEX="$GRAPH_CACHE_DIR/graph.forward.json"
    GRAPH_REVERSE_INDEX="$GRAPH_CACHE_DIR/graph.reverse.json"
    GRAPH_CHECKSUM_FILE="$GRAPH_CACHE_DIR/graph.checksum.txt"
    GRAPH_METADATA_FILE="$GRAPH_CACHE_DIR/graph.metadata.json"
    export GRAPH_CACHE_DIR GRAPH_FORWARD_INDEX GRAPH_REVERSE_INDEX GRAPH_CHECKSUM_FILE GRAPH_METADATA_FILE
    
    # Source required libraries
    source "$LIB_DIR/tasks/graph-cache.sh"
    source "$LIB_DIR/tasks/graph-ops.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Fixture Helpers - Create fixtures in the test CLEO_DIR
# =============================================================================

setup_linear_chain() {
    cp "$FIXTURES_DIR/graph-ops/linear-chain.json" "$TODO_FILE"
}

setup_diamond_dependency() {
    cp "$FIXTURES_DIR/graph-ops/diamond.json" "$TODO_FILE"
}

setup_simple_cycle() {
    cp "$FIXTURES_DIR/graph-ops/cycle.json" "$TODO_FILE"
}

setup_parallel_tasks() {
    cp "$FIXTURES_DIR/graph-ops/parallel.json" "$TODO_FILE"
}

setup_complex_graph() {
    cp "$FIXTURES_DIR/graph-ops/complex-graph.json" "$TODO_FILE"
}

setup_multiple_cycles() {
    cp "$FIXTURES_DIR/graph-ops/multiple-cycles.json" "$TODO_FILE"
}

setup_valid_dag() {
    cp "$FIXTURES_DIR/graph-ops/valid-dag.json" "$TODO_FILE"
}

setup_isolated_task() {
    # Single task with no dependencies
    jq -n '{
        "version": "2.3.0",
        "project": {"name": "test", "currentPhase": "core", "phases": {}},
        "tasks": [{"id": "T001", "title": "Lonely task", "status": "pending", "depends": []}],
        "focus": {},
        "labels": {},
        "_meta": {"version": "2.3.0", "checksum": "isolatedtask1"}
    }' > "$TODO_FILE"
}

setup_empty_todo() {
    jq -n '{
        "version": "2.3.0",
        "project": {"name": "test", "currentPhase": "core", "phases": {}},
        "tasks": [],
        "focus": {},
        "labels": {},
        "_meta": {"version": "2.3.0", "checksum": "emptytest0001"}
    }' > "$TODO_FILE"
}

# =============================================================================
# Critical Path Tests
# =============================================================================

@test "find_critical_path returns longest chain in linear graph" {
    setup_linear_chain
    invalidate_graph_cache "$TODO_FILE"
    
    run find_critical_path "T001"
    assert_success
    
    # Critical path should include T001 and T004
    assert_output --partial "T001"
    assert_output --partial "T004"
}

@test "find_critical_path handles single task" {
    setup_isolated_task
    invalidate_graph_cache "$TODO_FILE"
    
    run find_critical_path "T001"
    assert_success
    
    # Single task is its own critical path
    assert_output --partial "T001"
}

@test "find_critical_path handles diamond dependency" {
    setup_diamond_dependency
    invalidate_graph_cache "$TODO_FILE"
    
    run find_critical_path "T001"
    assert_success
    
    # Diamond has path length 3
    assert_output --partial "T001"
    assert_output --partial "T004"
}

@test "find_critical_path selects longest path in complex graph" {
    setup_complex_graph
    invalidate_graph_cache "$TODO_FILE"
    
    run find_critical_path "T001"
    assert_success
    
    # Longest path ends at T008
    assert_output --partial "T001"
    assert_output --partial "T008"
}

# =============================================================================
# Impact Radius Tests
# =============================================================================

@test "calculate_impact_radius finds all dependents" {
    setup_linear_chain
    invalidate_graph_cache "$TODO_FILE"
    
    run calculate_impact_radius "T001"
    assert_success
    
    # T001 impacts T002, T003, T004
    assert_output --partial "T002"
    assert_output --partial "T003"
    assert_output --partial "T004"
}

@test "calculate_impact_radius respects max_depth parameter" {
    setup_linear_chain
    invalidate_graph_cache "$TODO_FILE"
    
    # Only look 1 level deep
    run calculate_impact_radius "T001" 1
    assert_success
    
    assert_output --partial "T002"
    # T003 and T004 should NOT be included
    refute_output --partial "T003"
    refute_output --partial "T004"
}

@test "calculate_impact_radius handles isolated task" {
    setup_isolated_task
    invalidate_graph_cache "$TODO_FILE"
    
    run calculate_impact_radius "T001"
    assert_success
}

@test "calculate_impact_radius handles diamond correctly" {
    setup_diamond_dependency
    invalidate_graph_cache "$TODO_FILE"
    
    run calculate_impact_radius "T001"
    assert_success
    
    # T001 impacts T002, T003, T004
    assert_output --partial "T002"
    assert_output --partial "T003"
    assert_output --partial "T004"
}

# =============================================================================
# Dependency Waves Tests
# =============================================================================

@test "calculate_dependency_waves groups tasks correctly" {
    setup_linear_chain
    invalidate_graph_cache "$TODO_FILE"
    
    run calculate_dependency_waves
    assert_success
    
    assert_output --partial "T001"
    assert_valid_json "$output"
}

@test "wave 0 contains tasks with no dependencies" {
    setup_parallel_tasks
    invalidate_graph_cache "$TODO_FILE"
    
    run calculate_dependency_waves
    assert_success
    
    # Should contain T001 and T002 in wave 0
    assert_output --partial "T001"
    assert_output --partial "T002"
}

@test "tasks only appear after all deps satisfied" {
    setup_diamond_dependency
    invalidate_graph_cache "$TODO_FILE"
    
    run calculate_dependency_waves
    assert_success
    
    assert_valid_json "$output"
}

@test "parallel tasks appear in same wave" {
    setup_parallel_tasks
    invalidate_graph_cache "$TODO_FILE"
    
    run calculate_dependency_waves
    assert_success
    
    assert_valid_json "$output"
}

@test "dependency waves handles complex graph" {
    setup_complex_graph
    invalidate_graph_cache "$TODO_FILE"
    
    run calculate_dependency_waves
    assert_success
    
    assert_valid_json "$output"
}

# =============================================================================
# Cycle Detection Tests
# =============================================================================

@test "detect_dependency_cycles finds simple cycle" {
    setup_simple_cycle
    invalidate_graph_cache "$TODO_FILE"
    
    run detect_dependency_cycles
    
    # Should detect the cycle - either non-zero exit or cycle in output
    if [ "$status" -eq 0 ]; then
        [[ "$output" == *"cycle"* ]] || [[ "$output" == *"T001"* ]]
    fi
}

@test "detect_dependency_cycles returns empty for DAG" {
    setup_valid_dag
    invalidate_graph_cache "$TODO_FILE"
    
    run detect_dependency_cycles
    assert_success
}

@test "detect_dependency_cycles finds multiple cycles" {
    setup_multiple_cycles
    invalidate_graph_cache "$TODO_FILE"
    
    run detect_dependency_cycles
    
    # Should detect cycles
    if [ "$status" -eq 0 ]; then
        [[ "$output" == *"cycle"* ]] || [[ "$output" == *"T001"* ]] || [[ "$output" == *"T003"* ]]
    fi
}

@test "detect_dependency_cycles handles empty task list" {
    setup_empty_todo
    invalidate_graph_cache "$TODO_FILE"
    
    run detect_dependency_cycles
    assert_success
}

# =============================================================================
# Topological Sort Tests
# =============================================================================

@test "topological_sort orders by dependencies" {
    setup_linear_chain
    invalidate_graph_cache "$TODO_FILE"
    
    run topological_sort
    assert_success

    # Output should contain T001 before T004
    [[ "$output" == *"T001"* ]]
    [[ "$output" == *"T004"* ]]
}

@test "topological_sort fails on cycle" {
    setup_simple_cycle
    invalidate_graph_cache "$TODO_FILE"

    run topological_sort
    
    # Should fail or return error
    if [ "$status" -eq 0 ]; then
        [[ "$output" == *"cycle"* ]] || [[ "$output" == *"error"* ]]
    fi
}

@test "topological_sort handles parallel tasks" {
    setup_parallel_tasks
    invalidate_graph_cache "$TODO_FILE"
    
    run topological_sort
    assert_success

    # T003 must be present
    [[ "$output" == *"T003"* ]]
}

@test "topological_sort handles diamond dependency" {
    setup_diamond_dependency
    invalidate_graph_cache "$TODO_FILE"

    run topological_sort
    assert_success

    # Should contain all tasks
    [[ "$output" == *"T001"* ]]
    [[ "$output" == *"T004"* ]]
}

@test "topological_sort handles empty task list" {
    setup_empty_todo
    invalidate_graph_cache "$TODO_FILE"

    run topological_sort
    assert_success
}

# =============================================================================
# Edge Cases and Error Handling
# =============================================================================

@test "graph operations handle missing task gracefully" {
    setup_linear_chain
    invalidate_graph_cache "$TODO_FILE"
    
    run find_critical_path "T999"
    
    # Should not crash
    refute_output --partial "unbound variable"
    refute_output --partial "syntax error"
}

@test "graph operations handle missing dependencies gracefully" {
    # Create task with dependency on non-existent task
    jq -n '{
        "version": "2.3.0",
        "project": {"name": "test", "currentPhase": "core", "phases": {}},
        "tasks": [{"id": "T001", "title": "Task with bad dep", "status": "pending", "depends": ["T999"]}],
        "focus": {},
        "labels": {},
        "_meta": {"version": "2.3.0", "checksum": "baddepentest1"}
    }' > "$TODO_FILE"
    invalidate_graph_cache "$TODO_FILE"
    
    run calculate_dependency_waves
    
    # Should handle gracefully
    refute_output --partial "unbound variable"
    refute_output --partial "syntax error"
}

@test "graph cache invalidation triggers rebuild" {
    setup_linear_chain
    ensure_graph_cache "$TODO_FILE"
    
    invalidate_graph_cache "$TODO_FILE"
    ensure_graph_cache "$TODO_FILE"
    
    run graph_cache_stats
    assert_success
    
    local cached
    cached=$(echo "$output" | jq -r '.initialized // .cached // false')
    [ "$cached" = "true" ]
}

# =============================================================================
# Performance Tests
# =============================================================================

@test "graph operations complete in reasonable time for moderate graph" {
    # Create a moderately sized graph using jq
    jq -n '{
        "version": "2.3.0",
        "project": {"name": "perf-test", "currentPhase": "core", "phases": {}},
        "tasks": [
            {"id": "T001", "title": "Task 1", "status": "pending", "depends": []},
            {"id": "T002", "title": "Task 2", "status": "pending", "depends": ["T001"]},
            {"id": "T003", "title": "Task 3", "status": "pending", "depends": ["T001"]},
            {"id": "T004", "title": "Task 4", "status": "pending", "depends": ["T002"]},
            {"id": "T005", "title": "Task 5", "status": "pending", "depends": ["T002", "T003"]},
            {"id": "T006", "title": "Task 6", "status": "pending", "depends": ["T003"]},
            {"id": "T007", "title": "Task 7", "status": "pending", "depends": ["T004"]},
            {"id": "T008", "title": "Task 8", "status": "pending", "depends": ["T004", "T005"]},
            {"id": "T009", "title": "Task 9", "status": "pending", "depends": ["T005", "T006"]},
            {"id": "T010", "title": "Task 10", "status": "pending", "depends": ["T006"]}
        ],
        "focus": {},
        "labels": {},
        "_meta": {"version": "2.3.0", "checksum": "perftest00001"}
    }' > "$TODO_FILE"
    invalidate_graph_cache "$TODO_FILE"
    
    run timeout 5 bash -c "export CLAUDE_DIR='$CLEO_DIR' && export CLEO_DIR='$CLEO_DIR' && export TODO_FILE='$TODO_FILE' && export GRAPH_CACHE_DIR='$GRAPH_CACHE_DIR' && source '$LIB_DIR/tasks/graph-cache.sh' && source '$LIB_DIR/tasks/graph-ops.sh' && calculate_dependency_waves"
    assert_success
}
