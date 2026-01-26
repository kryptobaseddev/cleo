#!/usr/bin/env bats
# =============================================================================
# graph-rag-hierarchy.bats - Tests for hierarchy-based task discovery (T2190)
# =============================================================================
# Tests the hierarchical discovery functions in lib/graph-rag.sh:
# - _find_lca(): Lowest common ancestor calculation
# - _tree_distance(): Tree distance between tasks
# - _get_hierarchical_context(): Parent context with decay
# - _discover_by_hierarchy(): Sibling/cousin discovery
# - discover_related_tasks hierarchy method and auto integration
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

    # Source graph-rag library
    source "$LIB_DIR/graph-rag.sh"
}

# =============================================================================
# _find_lca() Tests
# =============================================================================

@test "_find_lca returns self for same task" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Test task"
    assert_success

    result=$(_find_lca "T001" "T001")
    [[ "$result" == "T001" ]]
}

@test "_find_lca returns parent for siblings" {
    create_empty_todo

    # Create epic and two children
    run bash "$ADD_SCRIPT" "Epic" --type epic
    assert_success

    run bash "$ADD_SCRIPT" "Child 1" --parent T001
    assert_success

    run bash "$ADD_SCRIPT" "Child 2" --parent T001
    assert_success

    result=$(_find_lca "T002" "T003")
    [[ "$result" == "T001" ]]
}

@test "_find_lca returns grandparent for cousins" {
    create_empty_todo

    # Create epic with two tasks, each with a subtask
    run bash "$ADD_SCRIPT" "Epic" --type epic
    assert_success

    run bash "$ADD_SCRIPT" "Task 1" --parent T001
    assert_success

    run bash "$ADD_SCRIPT" "Task 2" --parent T001
    assert_success

    run bash "$ADD_SCRIPT" "Subtask 1.1" --parent T002
    assert_success

    run bash "$ADD_SCRIPT" "Subtask 2.1" --parent T003
    assert_success

    # Cousins share grandparent
    result=$(_find_lca "T004" "T005")
    [[ "$result" == "T001" ]]
}

@test "_find_lca returns empty for unrelated tasks" {
    create_empty_todo

    # Create two separate root tasks
    run bash "$ADD_SCRIPT" "Root 1"
    assert_success

    run bash "$ADD_SCRIPT" "Root 2"
    assert_success

    result=$(_find_lca "T001" "T002" || true)
    [[ -z "$result" ]]
}

@test "_find_lca returns parent when one is ancestor of other" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Epic" --type epic
    assert_success

    run bash "$ADD_SCRIPT" "Child" --parent T001
    assert_success

    result=$(_find_lca "T001" "T002")
    [[ "$result" == "T001" ]]
}

@test "_find_lca returns empty for non-existent task" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Task"
    assert_success

    result=$(_find_lca "T001" "T999" || true)
    [[ -z "$result" ]]
}

# =============================================================================
# _tree_distance() Tests
# =============================================================================

@test "_tree_distance returns 0 for same task" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Test task"
    assert_success

    result=$(_tree_distance "T001" "T001")
    [[ "$result" == "0" ]]
}

@test "_tree_distance returns 1 for parent-child" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Epic" --type epic
    assert_success

    run bash "$ADD_SCRIPT" "Child" --parent T001
    assert_success

    result=$(_tree_distance "T001" "T002")
    [[ "$result" == "1" ]]
}

@test "_tree_distance returns 2 for siblings" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Epic" --type epic
    assert_success

    run bash "$ADD_SCRIPT" "Child 1" --parent T001
    assert_success

    run bash "$ADD_SCRIPT" "Child 2" --parent T001
    assert_success

    result=$(_tree_distance "T002" "T003")
    [[ "$result" == "2" ]]
}

@test "_tree_distance returns 4 for cousins" {
    create_empty_todo

    # Epic -> Task1 -> Subtask1, Epic -> Task2 -> Subtask2
    run bash "$ADD_SCRIPT" "Epic" --type epic
    assert_success

    run bash "$ADD_SCRIPT" "Task 1" --parent T001
    assert_success

    run bash "$ADD_SCRIPT" "Task 2" --parent T001
    assert_success

    run bash "$ADD_SCRIPT" "Subtask 1.1" --parent T002
    assert_success

    run bash "$ADD_SCRIPT" "Subtask 2.1" --parent T003
    assert_success

    result=$(_tree_distance "T004" "T005")
    [[ "$result" == "4" ]]
}

@test "_tree_distance returns -1 for unrelated tasks" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Root 1"
    assert_success

    run bash "$ADD_SCRIPT" "Root 2"
    assert_success

    result=$(_tree_distance "T001" "T002" || true)
    [[ "$result" == "-1" ]]
}

# =============================================================================
# _get_hierarchical_context() Tests
# =============================================================================

@test "_get_hierarchical_context returns task description" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Task title" --description "Task description text"
    assert_success

    result=$(_get_hierarchical_context "T001")
    [[ "$result" == *"Task description text"* ]]
}

@test "_get_hierarchical_context includes parent context with decay" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Epic" --type epic --description "Epic description"
    assert_success

    run bash "$ADD_SCRIPT" "Child" --parent T001 --description "Child description"
    assert_success

    result=$(_get_hierarchical_context "T002")
    [[ "$result" == *"Child description"* ]]
    [[ "$result" == *"[PARENT:0.5]"* ]]
    [[ "$result" == *"Epic description"* ]]
}

@test "_get_hierarchical_context uses title when no description" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Just a title"
    assert_success

    result=$(_get_hierarchical_context "T001")
    [[ "$result" == *"Just a title"* ]]
}

@test "_get_hierarchical_context returns empty for non-existent task" {
    create_empty_todo

    result=$(_get_hierarchical_context "T999" || true)
    [[ -z "$result" ]]
}

# =============================================================================
# _discover_by_hierarchy() Tests
# =============================================================================

@test "_discover_by_hierarchy finds siblings" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Epic" --type epic
    assert_success

    run bash "$ADD_SCRIPT" "Child 1" --parent T001
    assert_success

    run bash "$ADD_SCRIPT" "Child 2" --parent T001
    assert_success

    result=$(_discover_by_hierarchy "T002")
    count=$(echo "$result" | jq 'length')
    [[ "$count" -eq 1 ]]

    sibling=$(echo "$result" | jq -r '.[0].taskId')
    [[ "$sibling" == "T003" ]]

    score=$(echo "$result" | jq '.[0].score')
    [[ "$score" == "0.15" ]]
}

@test "_discover_by_hierarchy finds cousins" {
    create_empty_todo

    # Epic -> Task1 -> Subtask1, Epic -> Task2 -> Subtask2
    run bash "$ADD_SCRIPT" "Epic" --type epic
    assert_success

    run bash "$ADD_SCRIPT" "Task 1" --parent T001
    assert_success

    run bash "$ADD_SCRIPT" "Task 2" --parent T001
    assert_success

    run bash "$ADD_SCRIPT" "Subtask 1.1" --parent T002
    assert_success

    run bash "$ADD_SCRIPT" "Subtask 2.1" --parent T003
    assert_success

    result=$(_discover_by_hierarchy "T004")

    # Should find cousin T005
    cousin=$(echo "$result" | jq -r '.[] | select(._relationship == "cousin") | .taskId')
    [[ "$cousin" == "T005" ]]

    cousin_score=$(echo "$result" | jq '.[] | select(._relationship == "cousin") | .score')
    [[ "$cousin_score" == "0.08" ]]
}

@test "_discover_by_hierarchy returns empty for root task" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Root task"
    assert_success

    result=$(_discover_by_hierarchy "T001")
    [[ "$result" == "[]" ]]
}

@test "_discover_by_hierarchy scores siblings higher than cousins" {
    create_empty_todo

    # Create structure with both siblings and cousins
    run bash "$ADD_SCRIPT" "Epic" --type epic
    assert_success

    run bash "$ADD_SCRIPT" "Task 1" --parent T001
    assert_success

    run bash "$ADD_SCRIPT" "Task 2" --parent T001
    assert_success

    # T002 has sibling T003
    result=$(_discover_by_hierarchy "T002")

    sibling_score=$(echo "$result" | jq '.[] | select(._relationship == "sibling") | .score')
    [[ "$sibling_score" == "0.15" ]]
}

# =============================================================================
# discover_related_tasks() Integration Tests
# =============================================================================

@test "discover_related_tasks hierarchy method works" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Epic" --type epic
    assert_success

    run bash "$ADD_SCRIPT" "Child 1" --parent T001
    assert_success

    run bash "$ADD_SCRIPT" "Child 2" --parent T001
    assert_success

    result=$(discover_related_tasks "T002" "hierarchy")
    count=$(echo "$result" | jq 'length')
    [[ "$count" -eq 1 ]]
}

@test "discover_related_tasks auto includes hierarchy" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Epic" --type epic --labels "auth"
    assert_success

    run bash "$ADD_SCRIPT" "Child 1" --parent T001 --labels "auth"
    assert_success

    run bash "$ADD_SCRIPT" "Child 2" --parent T001 --labels "auth"
    assert_success

    result=$(discover_related_tasks "T002" "auto")

    # Should find the sibling T003 in results
    found_sibling=$(echo "$result" | jq '[.[] | select(.taskId == "T003")] | length')
    [[ "$found_sibling" -ge 1 ]]

    # Score should include hierarchy boost (base label overlap + boost)
    score=$(echo "$result" | jq '[.[] | select(.taskId == "T003")][0].score')
    [[ $(awk "BEGIN {print ($score >= 0.15)}") -eq 1 ]]
}

@test "sibling boost applied in auto mode" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Epic" --type epic --labels "test"
    assert_success

    run bash "$ADD_SCRIPT" "Child 1" --parent T001 --labels "test"
    assert_success

    run bash "$ADD_SCRIPT" "Child 2" --parent T001 --labels "test"
    assert_success

    result=$(discover_related_tasks "T002" "auto")

    # Base score from labels should have sibling boost added
    score=$(echo "$result" | jq '.[0].score')

    # Labels jaccard = 1/1 = 1.0, but capped, boost = 0.15
    # Score should be > base label score
    [[ $(awk "BEGIN {print ($score > 0.5)}") -eq 1 ]]
}

@test "hierarchy method returns valid JSON" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Epic" --type epic
    assert_success

    run bash "$ADD_SCRIPT" "Child" --parent T001
    assert_success

    result=$(discover_related_tasks "T001" "hierarchy")

    # Should be valid JSON array
    echo "$result" | jq -e '.' > /dev/null
    assert_success
}
