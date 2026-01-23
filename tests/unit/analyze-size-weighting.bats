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
    load '../test_helper/fixtures'
    common_setup_per_test
}

teardown() {
    common_teardown_per_test
}

# =============================================================================
# Helper Functions for Direct Task Insertion
# =============================================================================

# Track the last assigned task ID for get_last_task_id
_LAST_TASK_ID=""

# Add a task directly to todo.json without using add-task.sh
# This bypasses session enforcement for testing purposes
# Args: $1=title, $2=extra_json (optional JSON object to merge)
add_task() {
    local title="$1"
    local default_json='{}'
    local extra_json="${2:-$default_json}"

    # Get next task ID
    local max_id
    max_id=$(jq -r '[.tasks[].id | ltrimstr("T") | tonumber] | max // 0' "$TODO_FILE")
    local new_id="T$(printf "%03d" $((max_id + 1)))"
    _LAST_TASK_ID="$new_id"

    # Merge extra JSON with base task structure
    jq --arg id "$new_id" \
       --arg title "$title" \
       --argjson extra "$extra_json" \
       '.tasks += [{
         "id": $id,
         "title": $title,
         "description": ($title + " description"),
         "status": "pending",
         "priority": "medium",
         "phase": "setup",
         "type": "task",
         "createdAt": "2025-12-01T10:00:00Z"
       } * $extra]' \
       "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Update checksum
    local checksum
    checksum=$(jq -c '.tasks // []' "$TODO_FILE" | sha256sum | cut -c1-16)
    jq --arg cs "$checksum" '._meta.checksum = $cs' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
}

# Get the last task ID created by add_task
get_last_task_id() {
    echo "$_LAST_TASK_ID"
}

# ============================================================================
# Size Weighting Metadata Tests
# ============================================================================

@test "analyze includes sizeWeighting metadata with default strategy" {
    create_empty_todo
    add_task "Test task" '{"priority": "high"}'

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check that sizeWeighting metadata exists
    strategy=$(echo "$output" | jq -r '._meta.sizeWeighting.strategy')
    assert_equal "$strategy" "balanced"
}

@test "analyze respects sizeStrategy config setting" {
    create_empty_todo
    add_task "Test task" '{"priority": "high"}'

    # Set quick-wins strategy in config file
    jq '.analyze.sizeStrategy = "quick-wins"' "$CONFIG_FILE" > "$CONFIG_FILE.tmp"
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

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
    create_empty_todo

    # Add tasks with different sizes
    add_task "Small task" '{"size": "small", "priority": "high"}'
    add_task "Medium task" '{"size": "medium", "priority": "high"}'
    add_task "Large task" '{"size": "large", "priority": "high"}'

    # Set balanced strategy in config file (default, but explicit)
    jq '.analyze.sizeStrategy = "balanced"' "$CONFIG_FILE" > "$CONFIG_FILE.tmp"
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Get all tasks with size weights from tier2_critical (high priority tasks go here)
    weights=$(echo "$output" | jq -c '[.tiers.tier2_critical.tasks[] | select(.size) | .size_weight] | unique')

    # All weights should be 1 for balanced
    assert_equal "$weights" "[1]"
}

@test "quick-wins strategy favors small tasks" {
    create_empty_todo

    # Add tasks with different sizes
    add_task "Small task" '{"size": "small", "priority": "high"}'
    add_task "Medium task" '{"size": "medium", "priority": "high"}'
    add_task "Large task" '{"size": "large", "priority": "high"}'

    # Set quick-wins strategy in config file
    jq '.analyze.sizeStrategy = "quick-wins"' "$CONFIG_FILE" > "$CONFIG_FILE.tmp"
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check weight assignments from tier2_critical (high priority tasks go here)
    small_weight=$(echo "$output" | jq -r '.tiers.tier2_critical.tasks[] | select(.size == "small") | .size_weight' | head -1)
    medium_weight=$(echo "$output" | jq -r '.tiers.tier2_critical.tasks[] | select(.size == "medium") | .size_weight' | head -1)
    large_weight=$(echo "$output" | jq -r '.tiers.tier2_critical.tasks[] | select(.size == "large") | .size_weight' | head -1)

    assert_equal "$small_weight" "3"
    assert_equal "$medium_weight" "2"
    assert_equal "$large_weight" "1"
}

@test "big-impact strategy favors large tasks" {
    create_empty_todo

    # Add tasks with different sizes
    add_task "Small task" '{"size": "small", "priority": "high"}'
    add_task "Medium task" '{"size": "medium", "priority": "high"}'
    add_task "Large task" '{"size": "large", "priority": "high"}'

    # Set big-impact strategy in config file
    jq '.analyze.sizeStrategy = "big-impact"' "$CONFIG_FILE" > "$CONFIG_FILE.tmp"
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check weight assignments from tier2_critical (high priority tasks go here)
    small_weight=$(echo "$output" | jq -r '.tiers.tier2_critical.tasks[] | select(.size == "small") | .size_weight' | head -1)
    medium_weight=$(echo "$output" | jq -r '.tiers.tier2_critical.tasks[] | select(.size == "medium") | .size_weight' | head -1)
    large_weight=$(echo "$output" | jq -r '.tiers.tier2_critical.tasks[] | select(.size == "large") | .size_weight' | head -1)

    assert_equal "$small_weight" "1"
    assert_equal "$medium_weight" "2"
    assert_equal "$large_weight" "3"
}

@test "tasks without size get default weight 1" {
    create_empty_todo

    # Add task without size
    add_task "Task without size" '{"priority": "high"}'

    # Set quick-wins strategy in config file
    jq '.analyze.sizeStrategy = "quick-wins"' "$CONFIG_FILE" > "$CONFIG_FILE.tmp"
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Tasks without size should have weight 1 regardless of strategy (check tier2_critical)
    no_size_weight=$(echo "$output" | jq -r '.tiers.tier2_critical.tasks[] | select(.size == null) | .size_weight' | head -1)
    assert_equal "$no_size_weight" "1"
}

# ============================================================================
# Output Format Tests
# ============================================================================

@test "tier tasks include size and size_weight fields" {
    create_empty_todo
    add_task "Test task" '{"size": "medium", "priority": "high"}'

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Check first tier2_critical task has required fields
    first_task=$(echo "$output" | jq '.tiers.tier2_critical.tasks[0]')

    # Should have size field (may be null)
    echo "$first_task" | jq -e 'has("size")'

    # Should have size_weight field
    echo "$first_task" | jq -e 'has("size_weight")'
}

@test "tier1_unblock tasks include size and size_weight fields" {
    create_empty_todo

    # Add task that will appear in tier1 (blocking other tasks)
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
    create_empty_todo

    # Add task first
    add_task "Test task" '{"size": "small", "priority": "high"}'

    # Set invalid strategy via config file edit
    jq '.analyze.sizeStrategy = "invalid-strategy"' "$CONFIG_FILE" > "$CONFIG_FILE.tmp"
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

    run bash "$ANALYZE_SCRIPT"
    assert_success

    # Should use balanced (weight 1 for all) - check tier2_critical
    weights=$(echo "$output" | jq -c '[.tiers.tier2_critical.tasks[] | select(.size) | .size_weight] | unique')
    assert_equal "$weights" "[1]"
}
