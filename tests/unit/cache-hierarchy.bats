#!/usr/bin/env bats

# T348: Hierarchy Index Caching Tests

# =============================================================================
# File-Level Setup (runs once per test file)
# =============================================================================
setup_file() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_file
}

# =============================================================================
# Per-Test Setup (runs before each test)
# =============================================================================
setup() {
    # Re-load helper to access functions in per-test scope
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    common_setup_per_test
    source "$LIB_DIR/data/cache.sh"
    export CLAUDE_DIR="${BATS_TEST_TMPDIR}/.claude"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

@test "cache_init_hierarchy creates cache files" {
    create_empty_todo

    # Add some hierarchy
    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic" -q)

    # Force cache rebuild (returns 1 when rebuilt, 0 when already valid)
    cache_invalidate_hierarchy
    cache_init_hierarchy "$TODO_FILE" || true

    [ -f "$CLAUDE_DIR/.cache/hierarchy.index.json" ]
    [ -f "$CLAUDE_DIR/.cache/children.index.json" ]
    [ -f "$CLAUDE_DIR/.cache/depth.index.json" ]
}

@test "cache_get_parent returns correct parent" {
    create_empty_todo

    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic" -q)

    cache_invalidate_hierarchy
    cache_init_hierarchy "$TODO_FILE" || true

    local parent=$(cache_get_parent "$task")
    [ "$parent" == "$epic" ]
}

@test "cache_get_parent returns empty for root task" {
    create_empty_todo

    local task=$(bash "$ADD_SCRIPT" "Root Task" -q)

    cache_invalidate_hierarchy
    cache_init_hierarchy "$TODO_FILE" || true

    local parent=$(cache_get_parent "$task")
    [ -z "$parent" ]
}

@test "cache_get_children returns direct children" {
    create_empty_todo

    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    local task1=$(bash "$ADD_SCRIPT" "Task 1" --parent "$epic" -q)
    local task2=$(bash "$ADD_SCRIPT" "Task 2" --parent "$epic" -q)

    cache_invalidate_hierarchy
    cache_init_hierarchy "$TODO_FILE" || true

    local children=$(cache_get_children "$epic")
    [[ "$children" == *"$task1"* ]]
    [[ "$children" == *"$task2"* ]]
}

@test "cache_get_depth returns 0 for root task" {
    create_empty_todo

    local task=$(bash "$ADD_SCRIPT" "Root Task" -q)

    cache_invalidate_hierarchy
    cache_init_hierarchy "$TODO_FILE" || true

    local depth=$(cache_get_depth "$task")
    [ "$depth" == "0" ]
}

@test "cache_get_depth returns correct depth for nested task" {
    create_empty_todo

    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic" -q)
    local subtask=$(bash "$ADD_SCRIPT" "Subtask" --parent "$task" --type subtask -q)

    cache_invalidate_hierarchy
    cache_init_hierarchy "$TODO_FILE" || true

    local depth=$(cache_get_depth "$subtask")
    [ "$depth" == "2" ]
}

@test "cache_get_child_count returns correct count" {
    create_empty_todo

    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    bash "$ADD_SCRIPT" "Task 1" --parent "$epic"
    bash "$ADD_SCRIPT" "Task 2" --parent "$epic"
    bash "$ADD_SCRIPT" "Task 3" --parent "$epic"

    cache_invalidate_hierarchy
    cache_init_hierarchy "$TODO_FILE" || true

    local count=$(cache_get_child_count "$epic")
    [ "$count" == "3" ]
}

@test "cache_get_child_count returns 0 for leaf task" {
    create_empty_todo

    local task=$(bash "$ADD_SCRIPT" "Leaf Task" -q)

    cache_invalidate_hierarchy
    cache_init_hierarchy "$TODO_FILE" || true

    local count=$(cache_get_child_count "$task")
    [ "$count" == "0" ]
}

@test "cache_hierarchy_stats returns valid JSON" {
    create_empty_todo

    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic" -q)

    cache_invalidate_hierarchy
    cache_init_hierarchy "$TODO_FILE" || true

    local stats=$(cache_hierarchy_stats)
    echo "$stats" | jq -e '.taskCount'
    echo "$stats" | jq -e '.maxDepth'
}

@test "cache invalidation clears cache files" {
    create_empty_todo

    local task=$(bash "$ADD_SCRIPT" "Task" -q)

    cache_init_hierarchy "$TODO_FILE" || true
    [ -f "$CLAUDE_DIR/.cache/hierarchy.index.json" ]

    cache_invalidate_hierarchy
    [ ! -f "$CLAUDE_DIR/.cache/hierarchy.index.json" ]
}

@test "cache auto-rebuilds after invalidation" {
    create_empty_todo

    local task=$(bash "$ADD_SCRIPT" "Task" -q)

    cache_init_hierarchy "$TODO_FILE" || true
    cache_invalidate_hierarchy

    # This should trigger rebuild (via cache_get_depth calling cache_init_hierarchy)
    local depth=$(cache_get_depth "$task")
    [ -f "$CLAUDE_DIR/.cache/hierarchy.index.json" ]
}
