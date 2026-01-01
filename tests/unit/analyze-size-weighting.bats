#!/usr/bin/env bats
# =============================================================================
# analyze-size-weighting.bats - Tests for size weighting functionality
# =============================================================================
# Tests the size weighting functionality for T1183:
# - Size weight calculation (quick-wins: 3/2/1, big-impact: 1/2/3, balanced: 1/1/1)
# - Integration with leverage scoring
# - Combination with phase boost multipliers
# - Config integration for strategy selection
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
    export ANALYZE_SCRIPT="${SCRIPTS_DIR}/analyze.sh"
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup
}

# ============================================================================
# Size Weighting Metadata Tests
# ============================================================================

@test "analyze includes sizeWeighting metadata with default strategy" {
    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check that sizeWeighting metadata exists
    strategy=$(echo "$output" | jq -r '._meta.sizeWeighting.strategy')
    assert_equal "$strategy" "balanced"
}

@test "analyze respects sizeStrategy config setting" {
    # Set quick-wins strategy
    jq '.project.analyze.sizeStrategy = "quick-wins"' "$TODO_FILE" > "$TODO_FILE.tmp"
    mv "$TODO_FILE.tmp" "$TODO_FILE"

    # Run analyze
    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check metadata reflects config
    strategy=$(echo "$output" | jq -r '._meta.sizeWeighting.strategy')
    assert_equal "$strategy" "quick-wins"
}

# ============================================================================
# Size Weight Calculation Tests
# ============================================================================

@test "balanced strategy assigns weight 1 to all sizes" {
    # Add tasks with different sizes
    add_task "Small task" '{"size": "small", "priority": "high"}'
    add_task "Medium task" '{"size": "medium", "priority": "high"}'
    add_task "Large task" '{"size": "large", "priority": "high"}'

    # Set balanced strategy
    jq '.project.analyze.sizeStrategy = "balanced"' "$TODO_FILE" > "$TODO_FILE.tmp"
    mv "$TODO_FILE.tmp" "$TODO_FILE"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Get all tasks with size weights
    weights=$(echo "$output" | jq '[.leverage[] | select(.size) | .size_weight] | unique')

    # All weights should be 1 for balanced
    assert_equal "$weights" "[1]"
}

@test "quick-wins strategy favors small tasks" {
    # Add tasks with different sizes
    add_task "Small task" '{"size": "small", "priority": "high"}'
    add_task "Medium task" '{"size": "medium", "priority": "high"}'
    add_task "Large task" '{"size": "large", "priority": "high"}'

    # Set quick-wins strategy
    jq '.project.analyze.sizeStrategy = "quick-wins"' "$TODO_FILE" > "$TODO_FILE.tmp"
    mv "$TODO_FILE.tmp" "$TODO_FILE"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check weight assignments
    small_weight=$(echo "$output" | jq -r '.leverage[] | select(.size == "small") | .size_weight' | head -1)
    medium_weight=$(echo "$output" | jq -r '.leverage[] | select(.size == "medium") | .size_weight' | head -1)
    large_weight=$(echo "$output" | jq -r '.leverage[] | select(.size == "large") | .size_weight' | head -1)

    assert_equal "$small_weight" "3"
    assert_equal "$medium_weight" "2"
    assert_equal "$large_weight" "1"
}

@test "big-impact strategy favors large tasks" {
    # Add tasks with different sizes
    add_task "Small task" '{"size": "small", "priority": "high"}'
    add_task "Medium task" '{"size": "medium", "priority": "high"}'
    add_task "Large task" '{"size": "large", "priority": "high"}'

    # Set big-impact strategy
    jq '.project.analyze.sizeStrategy = "big-impact"' "$TODO_FILE" > "$TODO_FILE.tmp"
    mv "$TODO_FILE.tmp" "$TODO_FILE"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check weight assignments
    small_weight=$(echo "$output" | jq -r '.leverage[] | select(.size == "small") | .size_weight' | head -1)
    medium_weight=$(echo "$output" | jq -r '.leverage[] | select(.size == "medium") | .size_weight' | head -1)
    large_weight=$(echo "$output" | jq -r '.leverage[] | select(.size == "large") | .size_weight' | head -1)

    assert_equal "$small_weight" "1"
    assert_equal "$medium_weight" "2"
    assert_equal "$large_weight" "3"
}

@test "tasks without size get default weight 1" {
    # Add task without size
    add_task "Task without size" '{"priority": "high"}'

    # Set quick-wins strategy
    jq '.project.analyze.sizeStrategy = "quick-wins"' "$TODO_FILE" > "$TODO_FILE.tmp"
    mv "$TODO_FILE.tmp" "$TODO_FILE"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Tasks without size should have weight 1 regardless of strategy
    no_size_weight=$(echo "$output" | jq -r '.leverage[] | select(.size == null) | .size_weight' | head -1)
    assert_equal "$no_size_weight" "1"
}

# ============================================================================
# Output Format Tests
# ============================================================================

@test "leverage array includes size and size_weight fields" {
    add_task "Test task" '{"size": "medium", "priority": "high"}'

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check first leverage item has required fields
    first_task=$(echo "$output" | jq '.leverage[0]')

    # Should have size field (may be null)
    echo "$first_task" | jq -e 'has("size")'

    # Should have size_weight field
    echo "$first_task" | jq -e 'has("size_weight")'
}

@test "tier tasks include size and size_weight fields" {
    # Add task that will appear in tier1
    add_task "Blocking task" '{"size": "medium", "priority": "high"}'
    t1_id=$(get_last_task_id)
    add_task "Blocked 1" "{\"depends\": [\"$t1_id\"]}"
    add_task "Blocked 2" "{\"depends\": [\"$t1_id\"]}"
    add_task "Blocked 3" "{\"depends\": [\"$t1_id\"]}"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check tier1_unblock tasks
    tier1_task=$(echo "$output" | jq '.tiers.tier1_unblock.tasks[0]')
    if [ "$tier1_task" != "null" ]; then
        echo "$tier1_task" | jq -e 'has("size")'
        echo "$tier1_task" | jq -e 'has("size_weight")'
    fi
}

# ============================================================================
# Strategy Validation Tests
# ============================================================================

@test "invalid strategy falls back to balanced" {
    # Set invalid strategy via direct config file edit
    jq '.project.analyze.sizeStrategy = "invalid-strategy"' "$TODO_FILE" > "$TODO_FILE.tmp"
    mv "$TODO_FILE.tmp" "$TODO_FILE"

    add_task "Test task" '{"size": "small", "priority": "high"}'

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Should use balanced (weight 1 for all)
    weights=$(echo "$output" | jq '[.leverage[] | select(.size) | .size_weight] | unique')
    assert_equal "$weights" "[1]"
}
