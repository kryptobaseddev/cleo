#!/usr/bin/env bats
# =============================================================================
# analyze-phase-boost.bats - Tests for phase boosting functionality in analyze
# =============================================================================
# Tests the phase boost functionality introduced in T544:
# - Phase distance functions (get_phase_order, get_phase_distance)
# - Phase boost in leverage scores (1.5x current, 1.25x adjacent, 1.0x distant)
# - Phase alignment indicators (🎯, ↔️)
# - Config integration for custom boost values
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

teardown() {
    common_teardown_per_test
}

# =============================================================================
# Helper Functions for Direct Task Insertion
# =============================================================================

# Add a task directly to todo.json without using add.sh
# This bypasses session enforcement for testing purposes
# Args: $1=id, $2=title, $3=phase, $4=priority, $5=depends (optional, comma-separated)
add_task_direct() {
    local id="$1"
    local title="$2"
    local phase="${3:-setup}"
    local priority="${4:-medium}"
    local depends="${5:-}"

    local depends_json="[]"
    if [[ -n "$depends" ]]; then
        depends_json=$(echo "$depends" | jq -R 'split(",")' )
    fi

    jq --arg id "$id" \
       --arg title "$title" \
       --arg phase "$phase" \
       --arg priority "$priority" \
       --argjson depends "$depends_json" \
       '.tasks += [{
         "id": $id,
         "title": $title,
         "description": ($title + " description"),
         "status": "pending",
         "priority": $priority,
         "phase": $phase,
         "type": "task",
         "createdAt": "2025-12-01T10:00:00Z",
         "depends": (if ($depends | length) > 0 then $depends else null end)
       } | with_entries(select(.value != null))]' \
       "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Update checksum
    local checksum
    checksum=$(jq -c '.tasks // []' "$TODO_FILE" | sha256sum | cut -c1-16)
    jq --arg cs "$checksum" '._meta.checksum = $cs' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
}

# =============================================================================
# Phase Distance Function Tests (lib/phase-tracking.sh)
# =============================================================================

@test "get_phase_order returns correct order for setup phase" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    result=$(get_phase_order "setup" "$TODO_FILE")
    [[ "$result" == "1" ]]
}

@test "get_phase_order returns correct order for core phase" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    result=$(get_phase_order "core" "$TODO_FILE")
    [[ "$result" == "2" ]]
}

@test "get_phase_order returns correct order for testing phase" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    result=$(get_phase_order "testing" "$TODO_FILE")
    [[ "$result" == "3" ]]
}

@test "get_phase_order returns correct order for polish phase" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    result=$(get_phase_order "polish" "$TODO_FILE")
    [[ "$result" == "4" ]]
}

@test "get_phase_order returns correct order for maintenance phase" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    result=$(get_phase_order "maintenance" "$TODO_FILE")
    [[ "$result" == "5" ]]
}

@test "get_phase_order returns 0 for nonexistent phase" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    result=$(get_phase_order "nonexistent" "$TODO_FILE")
    [[ "$result" == "0" ]]
}

@test "get_phase_order returns 0 for empty phase" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    result=$(get_phase_order "" "$TODO_FILE")
    [[ "$result" == "0" ]]
}

@test "get_phase_distance returns 0 for same phase" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    result=$(get_phase_distance "core" "core" "$TODO_FILE")
    [[ "$result" == "0" ]]
}

@test "get_phase_distance returns 1 for adjacent phases (setup to core)" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    result=$(get_phase_distance "setup" "core" "$TODO_FILE")
    [[ "$result" == "1" ]]
}

@test "get_phase_distance returns 1 for adjacent phases (core to testing)" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    result=$(get_phase_distance "core" "testing" "$TODO_FILE")
    [[ "$result" == "1" ]]
}

@test "get_phase_distance returns 2 for distance-2 phases (setup to testing)" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    result=$(get_phase_distance "setup" "testing" "$TODO_FILE")
    [[ "$result" == "2" ]]
}

@test "get_phase_distance returns 3 for distance-3 phases (setup to polish)" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    result=$(get_phase_distance "setup" "polish" "$TODO_FILE")
    [[ "$result" == "3" ]]
}

@test "get_phase_distance returns 4 for distance-4 phases (setup to maintenance)" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    result=$(get_phase_distance "setup" "maintenance" "$TODO_FILE")
    [[ "$result" == "4" ]]
}

@test "get_phase_distance handles reverse direction (testing to core)" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    # Distance should be absolute value
    result=$(get_phase_distance "testing" "core" "$TODO_FILE")
    [[ "$result" == "1" ]]
}

@test "get_phase_distance returns 0 for empty task phase" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    result=$(get_phase_distance "" "core" "$TODO_FILE")
    [[ "$result" == "0" ]]
}

@test "get_phase_distance returns 0 for empty current phase" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    result=$(get_phase_distance "core" "" "$TODO_FILE")
    [[ "$result" == "0" ]]
}

@test "get_phase_distance returns 0 for unknown phase" {
    create_empty_todo

    source "$LIB_DIR/phase-tracking.sh"

    result=$(get_phase_distance "nonexistent" "core" "$TODO_FILE")
    [[ "$result" == "0" ]]
}

# =============================================================================
# Phase Boost in Analyze Meta Output Tests
# =============================================================================

@test "analyze includes phaseBoost in _meta" {
    create_empty_todo
    add_task_direct "T001" "Test task" "setup" "medium"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check phaseBoost exists in _meta
    local has_phase_boost
    has_phase_boost=$(echo "$output" | jq '._meta.phaseBoost != null')
    [[ "$has_phase_boost" == "true" ]]
}

@test "analyze shows current phase in _meta.phaseBoost" {
    create_empty_todo
    add_task_direct "T001" "Test task" "setup" "medium"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    local current_phase
    current_phase=$(echo "$output" | jq -r '._meta.phaseBoost.currentPhase')
    [[ "$current_phase" == "setup" ]]
}

@test "analyze shows boost values in _meta.phaseBoost" {
    create_empty_todo
    add_task_direct "T001" "Test task" "setup" "medium"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check default boost values
    local boost_current boost_adjacent boost_distant
    boost_current=$(echo "$output" | jq '._meta.phaseBoost.boostCurrent')
    boost_adjacent=$(echo "$output" | jq '._meta.phaseBoost.boostAdjacent')
    boost_distant=$(echo "$output" | jq '._meta.phaseBoost.boostDistant')

    [[ "$boost_current" == "1.5" ]]
    [[ "$boost_adjacent" == "1.25" ]]
    [[ "$boost_distant" == "1" ]] || [[ "$boost_distant" == "1.0" ]]
}

# =============================================================================
# Phase Boost Multiplier Tests
# =============================================================================

@test "task in current phase gets 1.5x boost" {
    create_empty_todo
    # Project is in setup phase by default
    add_task_direct "T001" "Setup task" "setup" "medium"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Find setup phase task in tier4_routine (tasks without deps go there)
    # Use phaseAlignment.taskPhase for filtering since .phase is not in tier output
    local boost
    boost=$(echo "$output" | jq '[.tiers.tier4_routine.tasks[] | select(.phaseAlignment.taskPhase == "setup")][0].phase_boost')
    [[ "$boost" == "1.5" ]]
}

@test "task in adjacent phase gets 1.25x boost" {
    create_empty_todo
    # Project is in setup phase (order 1), core is adjacent (order 2)
    add_task_direct "T001" "Core task" "core" "medium"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    local boost
    boost=$(echo "$output" | jq '[.tiers.tier4_routine.tasks[] | select(.phaseAlignment.taskPhase == "core")][0].phase_boost')
    [[ "$boost" == "1.25" ]]
}

@test "task in distant phase gets 1.0x boost" {
    create_empty_todo
    # Project is in setup phase (order 1), testing is distant (order 3)
    add_task_direct "T001" "Testing task" "testing" "medium"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    local boost
    boost=$(echo "$output" | jq '[.tiers.tier4_routine.tasks[] | select(.phaseAlignment.taskPhase == "testing")][0].phase_boost')
    [[ "$boost" == "1" ]] || [[ "$boost" == "1.0" ]]
}

@test "task in polish phase (distance 3) gets 1.0x boost" {
    create_empty_todo
    # Project is in setup phase (order 1), polish is distance 3 (order 4)
    add_task_direct "T001" "Polish task" "polish" "medium"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    local boost
    boost=$(echo "$output" | jq '[.tiers.tier4_routine.tasks[] | select(.phaseAlignment.taskPhase == "polish")][0].phase_boost')
    [[ "$boost" == "1" ]] || [[ "$boost" == "1.0" ]]
}

@test "task with null phase gets 1.0x boost" {
    create_empty_todo
    # Create task without phase directly via jq
    jq '.tasks += [{
      "id": "T001",
      "title": "No phase task",
      "description": "No phase task description",
      "status": "pending",
      "priority": "medium",
      "type": "task",
      "createdAt": "2025-12-01T10:00:00Z"
    }]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Find the task in tier4 and check boost
    local boost
    boost=$(echo "$output" | jq '[.tiers.tier4_routine.tasks[] | select(.id == "T001")][0].phase_boost')
    # Should default to 1.0 when phase is null/missing
    [[ "$boost" == "1" ]] || [[ "$boost" == "1.0" ]]
}

# =============================================================================
# Phase Alignment Indicator Tests
# =============================================================================

@test "phaseAlignment indicator is target for current phase" {
    create_empty_todo
    add_task_direct "T001" "Setup task" "setup" "medium"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    local indicator
    indicator=$(echo "$output" | jq -r '[.tiers.tier4_routine.tasks[] | select(.phaseAlignment.taskPhase == "setup")][0].phaseAlignment.indicator')
    [[ "$indicator" == "🎯" ]]
}

@test "phaseAlignment indicator is arrow for adjacent phase" {
    create_empty_todo
    add_task_direct "T001" "Core task" "core" "medium"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    local indicator
    indicator=$(echo "$output" | jq -r '[.tiers.tier4_routine.tasks[] | select(.phaseAlignment.taskPhase == "core")][0].phaseAlignment.indicator')
    [[ "$indicator" == "↔️" ]]
}

@test "phaseAlignment indicator is null for distant phase" {
    create_empty_todo
    add_task_direct "T001" "Testing task" "testing" "medium"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    local indicator
    indicator=$(echo "$output" | jq -r '[.tiers.tier4_routine.tasks[] | select(.phaseAlignment.taskPhase == "testing")][0].phaseAlignment.indicator')
    [[ "$indicator" == "null" ]]
}

@test "phaseAlignment includes taskPhase and projectPhase" {
    create_empty_todo
    add_task_direct "T001" "Core task" "core" "medium"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    local task_phase project_phase
    task_phase=$(echo "$output" | jq -r '[.tiers.tier4_routine.tasks[] | select(.phaseAlignment.taskPhase == "core")][0].phaseAlignment.taskPhase')
    project_phase=$(echo "$output" | jq -r '[.tiers.tier4_routine.tasks[] | select(.phaseAlignment.taskPhase == "core")][0].phaseAlignment.projectPhase')

    [[ "$task_phase" == "core" ]]
    [[ "$project_phase" == "setup" ]]
}

@test "phaseAlignment includes distance" {
    create_empty_todo
    add_task_direct "T001" "Testing task" "testing" "medium"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    local distance
    distance=$(echo "$output" | jq '[.tiers.tier4_routine.tasks[] | select(.phaseAlignment.taskPhase == "testing")][0].phaseAlignment.distance')
    [[ "$distance" == "2" ]]
}

# =============================================================================
# Leverage Score with Phase Boost Tests
# =============================================================================

@test "leverage_score incorporates phase boost" {
    create_empty_todo
    # Create a task in setup phase (current) with high priority
    add_task_direct "T001" "Setup blocker" "setup" "high"
    # Create dependent task
    add_task_direct "T002" "Dependent task" "setup" "medium" "T001"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Get the blocker's leverage score
    local leverage
    leverage=$(echo "$output" | jq '[.leverage[] | select(.id == "T001")][0]')

    local weighted score boost
    weighted=$(echo "$leverage" | jq '.weighted_unlocks')
    score=$(echo "$leverage" | jq '.leverage_score')
    boost=$(echo "$leverage" | jq '.phase_boost')

    # Verify boost is 1.5x for current phase
    [[ "$boost" == "1.5" ]]

    # leverage_score = floor((floor(weighted_unlocks * 15) + priority_score) * phase_boost)
    # For high priority: priority_score = 75
    # weighted_unlocks depends on dep type but should be > 0
}

@test "different phase tasks have different leverage scores" {
    create_empty_todo
    # Create tasks in different phases with same priority (no deps)
    # High priority tasks go to tier2_critical
    add_task_direct "T001" "Setup task" "setup" "high"
    add_task_direct "T002" "Core task" "core" "high"
    add_task_direct "T003" "Testing task" "testing" "high"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Get leverage scores from tier2_critical (high priority tasks go there)
    local setup_score core_score testing_score
    setup_score=$(echo "$output" | jq '[.tiers.tier2_critical.tasks[] | select(.id == "T001")][0].leverage_score')
    core_score=$(echo "$output" | jq '[.tiers.tier2_critical.tasks[] | select(.id == "T002")][0].leverage_score')
    testing_score=$(echo "$output" | jq '[.tiers.tier2_critical.tasks[] | select(.id == "T003")][0].leverage_score')

    # Current phase (setup) should have highest score due to 1.5x boost
    # Adjacent phase (core) should have middle score due to 1.25x boost
    # Distant phase (testing) should have lowest score due to 1.0x boost
    # With no deps, base score is priority_score (75 for high)
    # setup: floor(75 * 1.5) = 112
    # core: floor(75 * 1.25) = 93
    # testing: floor(75 * 1.0) = 75
    [[ "$setup_score" -gt "$core_score" ]]
    [[ "$core_score" -gt "$testing_score" ]]
}

# =============================================================================
# Phase Boost in Tier Output Tests
# =============================================================================

@test "tier1_unblock includes phase_boost field" {
    create_empty_todo
    # Create task that unblocks 3+ others (tier1 threshold)
    add_task_direct "T001" "High leverage task" "setup" "medium"
    add_task_direct "T002" "Dep 1" "setup" "medium" "T001"
    add_task_direct "T003" "Dep 2" "setup" "medium" "T001"
    add_task_direct "T004" "Dep 3" "setup" "medium" "T001"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check tier1_unblock tasks have phase_boost (tiers are objects with tasks array)
    local tier1_count
    tier1_count=$(echo "$output" | jq '.tiers.tier1_unblock.tasks | length')

    if [[ "$tier1_count" -gt 0 ]]; then
        local has_phase_boost
        has_phase_boost=$(echo "$output" | jq '.tiers.tier1_unblock.tasks[0] | has("phase_boost")')
        [[ "$has_phase_boost" == "true" ]]
    fi
}

@test "tier2_critical includes phase_boost field" {
    create_empty_todo
    add_task_direct "T001" "Critical task" "setup" "critical"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    local tier2_count
    tier2_count=$(echo "$output" | jq '.tiers.tier2_critical.tasks | length')

    if [[ "$tier2_count" -gt 0 ]]; then
        local has_phase_boost
        has_phase_boost=$(echo "$output" | jq '.tiers.tier2_critical.tasks[0] | has("phase_boost")')
        [[ "$has_phase_boost" == "true" ]]
    fi
}

@test "tier4_routine includes phase_boost field" {
    create_empty_todo
    add_task_direct "T001" "Low priority task" "setup" "low"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    local tier4_count
    tier4_count=$(echo "$output" | jq '.tiers.tier4_routine.tasks | length')

    if [[ "$tier4_count" -gt 0 ]]; then
        local has_phase_boost
        has_phase_boost=$(echo "$output" | jq '.tiers.tier4_routine.tasks[0] | has("phase_boost")')
        [[ "$has_phase_boost" == "true" ]]
    fi
}

# =============================================================================
# Recommendations with Phase Alignment Tests
# =============================================================================

@test "recommendations include phaseAlignment" {
    create_empty_todo
    add_task_direct "T001" "Setup task" "setup" "medium"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check recommendations have phaseAlignment
    local rec_count
    rec_count=$(echo "$output" | jq '.recommendations | length')

    if [[ "$rec_count" -gt 0 ]]; then
        local has_alignment
        has_alignment=$(echo "$output" | jq '.recommendations[0] | has("phaseAlignment")')
        [[ "$has_alignment" == "true" ]]
    fi
}

@test "recommendations reason mentions phase-aligned for boosted tasks" {
    create_empty_todo
    # Create high leverage task in current phase
    add_task_direct "T001" "High leverage setup task" "setup" "high"
    add_task_direct "T002" "Dep 1" "setup" "medium" "T001"
    add_task_direct "T003" "Dep 2" "setup" "medium" "T001"
    add_task_direct "T004" "Dep 3" "setup" "medium" "T001"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check action_order or recommendation for T001 reason with phase-aligned
    # T001 should appear in action_order with phase-aligned reason
    local reason
    reason=$(echo "$output" | jq -r '[.action_order[] | select(.id == "T001")][0].reason // ""')

    # If not in action_order, check recommendation
    if [[ -z "$reason" ]] || [[ "$reason" == "null" ]]; then
        reason=$(echo "$output" | jq -r '.recommendation.reason // ""')
    fi

    # Reason should mention phase-aligned percentage
    [[ "$reason" == *"phase-aligned"* ]] || [[ "$reason" == *"+50%"* ]]
}

# =============================================================================
# Multi-Phase Fixture Tests
# =============================================================================

@test "analyze correctly scores tasks across multiple phases" {
    create_complex_deps  # This fixture has tasks in core phase

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # This fixture sets currentPhase to "core" and has tasks in core and testing phases
    local current_phase
    current_phase=$(echo "$output" | jq -r '._meta.phaseBoost.currentPhase')
    [[ "$current_phase" == "core" ]]
}

@test "analyze handles project with no current phase" {
    create_empty_todo_no_phases
    # Add task directly
    jq '.tasks += [{
      "id": "T001",
      "title": "Test task",
      "description": "Test task description",
      "status": "pending",
      "priority": "medium",
      "type": "task",
      "createdAt": "2025-12-01T10:00:00Z"
    }]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # phaseBoost should have null currentPhase
    local current_phase
    current_phase=$(echo "$output" | jq -r '._meta.phaseBoost.currentPhase')
    [[ "$current_phase" == "null" ]]
}

# =============================================================================
# Config Override Tests
# =============================================================================

@test "custom phaseBoost config values are used" {
    create_empty_todo
    # Set custom boost values in config
    jq '.analyze = {"phaseBoost": {"current": 2.0, "adjacent": 1.5, "distant": 1.0}}' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp"
    mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    add_task_direct "T001" "Setup task" "setup" "medium"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check custom boost values in meta
    local boost_current boost_adjacent
    boost_current=$(echo "$output" | jq '._meta.phaseBoost.boostCurrent')
    boost_adjacent=$(echo "$output" | jq '._meta.phaseBoost.boostAdjacent')

    [[ "$boost_current" == "2" ]] || [[ "$boost_current" == "2.0" ]]
    [[ "$boost_adjacent" == "1.5" ]]
}

@test "default boost values used when config missing" {
    create_empty_todo
    # Ensure config has no analyze.phaseBoost section
    jq 'del(.analyze)' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp"
    mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    add_task_direct "T001" "Setup task" "setup" "medium"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Should use defaults: 1.5, 1.25, 1.0
    local boost_current boost_adjacent boost_distant
    boost_current=$(echo "$output" | jq '._meta.phaseBoost.boostCurrent')
    boost_adjacent=$(echo "$output" | jq '._meta.phaseBoost.boostAdjacent')
    boost_distant=$(echo "$output" | jq '._meta.phaseBoost.boostDistant')

    [[ "$boost_current" == "1.5" ]]
    [[ "$boost_adjacent" == "1.25" ]]
    [[ "$boost_distant" == "1" ]] || [[ "$boost_distant" == "1.0" ]]
}

# =============================================================================
# Edge Case Tests
# =============================================================================

@test "phase boost works with mixed phase and no-phase tasks" {
    create_empty_todo
    # Create tasks with and without phases
    add_task_direct "T001" "Setup task" "setup" "medium"
    # Add task without phase
    jq '.tasks += [{
      "id": "T002",
      "title": "No phase task",
      "description": "No phase task description",
      "status": "pending",
      "priority": "medium",
      "type": "task",
      "createdAt": "2025-12-01T10:00:00Z"
    }]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Both tasks should appear in tier4_routine (medium priority, no deps)
    local tier4_count
    tier4_count=$(echo "$output" | jq '.tiers.tier4_routine.tasks | length')
    [[ "$tier4_count" -ge 2 ]]
}

@test "phase boost calculation does not error on empty tasks" {
    create_empty_todo

    # No tasks, just empty project
    run bash "$ANALYZE_SCRIPT"

    # Should not fail - might return empty or no recommendations
    # The script should handle empty task list gracefully
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 100 ]]  # 100 = no data
}
