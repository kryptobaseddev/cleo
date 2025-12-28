#!/usr/bin/env bats
# =============================================================================
# analyze-hierarchy.bats - Tests for hierarchy-aware dependency scoring
# =============================================================================
# Tests the hierarchy-aware leverage scoring algorithm introduced in T543:
# - Parent-child dependencies weighted at 0.3x
# - Cross-epic dependencies weighted at 1.0x
# - Cross-phase dependencies weighted at 1.5x
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
    export ANALYZE_SCRIPT="${SCRIPTS_DIR}/analyze.sh"
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test
}

@test "get_epic_ancestor returns epic ancestor" {
    create_empty_todo

    # Create epic and child task
    run bash "$ADD_SCRIPT" "Epic task" --type epic
    assert_success

    run bash "$ADD_SCRIPT" "Child task" --parent T001
    assert_success

    # Source hierarchy library and test function
    source "$LIB_DIR/hierarchy.sh"

    # Test get_epic_ancestor
    result=$(get_epic_ancestor "T002" "$TODO_FILE")
    [[ "$result" == "T001" ]]
}

@test "get_epic_ancestor returns null for root task" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Root task"
    assert_success

    source "$LIB_DIR/hierarchy.sh"

    result=$(get_epic_ancestor "T001" "$TODO_FILE")
    [[ "$result" == "null" ]]
}

@test "analyze uses hierarchy-aware algorithm" {
    create_empty_todo

    # Add at least one task
    run bash "$ADD_SCRIPT" "Test task"
    assert_success

    run bash "$ANALYZE_SCRIPT"
    assert_success

    algorithm=$(echo "$output" | jq -r '._meta.algorithm')
    [[ "$algorithm" == "hierarchy_aware_leverage" ]]
}

@test "analyze output includes weight configuration" {
    create_empty_todo

    run bash "$ADD_SCRIPT" "Test task"
    assert_success

    run bash "$ANALYZE_SCRIPT"
    assert_success

    weights=$(echo "$output" | jq '._meta.weights')

    parent_child=$(echo "$weights" | jq -r '.parentChild')
    cross_epic=$(echo "$weights" | jq -r '.crossEpic')
    cross_phase=$(echo "$weights" | jq -r '.crossPhase')

    [[ "$parent_child" == "0.3" ]]
    [[ "$cross_epic" == "1" ]] || [[ "$cross_epic" == "1.0" ]]
    [[ "$cross_phase" == "1.5" ]]
}

@test "analyze shows weighted_unlocks in leverage data" {
    create_empty_todo

    # Create tasks with dependencies
    run bash "$ADD_SCRIPT" "Blocking task"
    assert_success

    run bash "$ADD_SCRIPT" "Dependent task" --depends T001
    assert_success

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check that weighted_unlocks field exists in leverage data
    has_weighted=$(echo "$output" | jq '.leverage[0] | has("weighted_unlocks")')
    [[ "$has_weighted" == "true" ]]
}

@test "parent-child dependencies use lower weight (0.3x)" {
    create_empty_todo

    # Create epic with child that depends on epic
    run bash "$ADD_SCRIPT" "Epic" --type epic
    assert_success

    run bash "$ADD_SCRIPT" "Child" --parent T001 --depends T001
    assert_success

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Find the epic in leverage data
    epic_leverage=$(echo "$output" | jq '.leverage[] | select(.id == "T001")')

    if [[ -n "$epic_leverage" ]]; then
        weighted=$(echo "$epic_leverage" | jq '.weighted_unlocks')
        # weighted should be 0.3 due to 0.3x weight for parent-child
        [[ "$weighted" == "0.3" ]]
    fi
}

@test "cross-phase dependencies use higher weight (1.5x)" {
    create_empty_todo

    # Create tasks in different phases with dependency
    run bash "$ADD_SCRIPT" "Setup task" --phase setup
    assert_success

    run bash "$ADD_SCRIPT" "Core task" --phase core --depends T001
    assert_success

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Find the setup task in leverage data
    setup_leverage=$(echo "$output" | jq '.leverage[] | select(.id == "T001")')

    if [[ -n "$setup_leverage" ]]; then
        weighted=$(echo "$setup_leverage" | jq '.weighted_unlocks')
        # weighted should be 1.5 due to 1.5x weight for cross-phase
        [[ "$weighted" == "1.5" ]]
    fi
}

@test "same-epic dependencies use standard weight (1.0x)" {
    create_empty_todo

    # Create epic with two children, one depending on the other
    run bash "$ADD_SCRIPT" "Epic" --type epic
    assert_success

    run bash "$ADD_SCRIPT" "Child 1" --parent T001
    assert_success

    run bash "$ADD_SCRIPT" "Child 2" --parent T001 --depends T002
    assert_success

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Find Child 1 in leverage data (it blocks Child 2)
    child1_leverage=$(echo "$output" | jq '.leverage[] | select(.id == "T002")')

    if [[ -n "$child1_leverage" ]]; then
        weighted=$(echo "$child1_leverage" | jq '.weighted_unlocks')
        # weighted should be 1.0 due to same epic
        [[ "$weighted" == "1" ]] || [[ "$weighted" == "1.0" ]]
    fi
}

@test "bottlenecks include weighted_blocks field" {
    create_empty_todo

    # Create multiple dependent tasks
    run bash "$ADD_SCRIPT" "Bottleneck task"
    assert_success

    run bash "$ADD_SCRIPT" "Dep 1" --depends T001
    run bash "$ADD_SCRIPT" "Dep 2" --depends T001
    run bash "$ADD_SCRIPT" "Dep 3" --depends T001
    assert_success

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check bottlenecks have weighted_blocks
    has_weighted=$(echo "$output" | jq '.bottlenecks[0] | has("weighted_blocks")')
    [[ "$has_weighted" == "true" ]]
}

@test "tier1_unblock includes weighted_unlocks" {
    create_empty_todo

    # Create task that unblocks 3+ others (tier1 threshold)
    run bash "$ADD_SCRIPT" "High leverage task"
    assert_success

    run bash "$ADD_SCRIPT" "Dep 1" --depends T001
    run bash "$ADD_SCRIPT" "Dep 2" --depends T001
    run bash "$ADD_SCRIPT" "Dep 3" --depends T001
    assert_success

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check tier1_unblock tasks have weighted_unlocks
    tier1_tasks=$(echo "$output" | jq '.tiers.tier1_unblock.tasks')
    if [[ $(echo "$tier1_tasks" | jq 'length') -gt 0 ]]; then
        has_weighted=$(echo "$tier1_tasks" | jq '.[0] | has("weighted_unlocks")')
        [[ "$has_weighted" == "true" ]]
    fi
}

@test "leverage_score uses weighted calculation" {
    create_empty_todo

    # Create a cross-phase dependency (1.5x weight)
    run bash "$ADD_SCRIPT" "Setup blocker" --phase setup --priority high
    assert_success

    run bash "$ADD_SCRIPT" "Core dependent" --phase core --depends T001
    assert_success

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Get the blocker's leverage score
    leverage=$(echo "$output" | jq '.leverage[] | select(.id == "T001")')

    weighted=$(echo "$leverage" | jq '.weighted_unlocks')
    score=$(echo "$leverage" | jq '.leverage_score')
    priority=$(echo "$leverage" | jq -r '.priority')

    # weighted_unlocks = 1.5 (cross-phase)
    # priority_score = 75 (high)
    # leverage_score = floor(1.5 * 15) + 75 = 22 + 75 = 97
    [[ "$weighted" == "1.5" ]]
    [[ "$score" == "97" ]]
}
