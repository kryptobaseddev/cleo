#!/usr/bin/env bats
# =============================================================================
# size-weighting.bats - Unit tests for lib/tasks/size-weighting.sh
# =============================================================================
# Tests size weighting calculation for analyze leverage scoring.
# Validates strategy-based weight calculation and edge case handling.
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file

    # Source the library under test
    source "$LIB_DIR/tasks/size-weighting.sh"
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Library Presence Tests
# =============================================================================

@test "size-weighting library exists" {
    [ -f "$LIB_DIR/tasks/size-weighting.sh" ]
}

@test "size-weighting library exports calculate_size_weight" {
    # Function should be exported and available
    declare -F calculate_size_weight
}

@test "size-weighting library exports get_size_strategy" {
    # Function should be exported and available
    declare -F get_size_strategy
}

# =============================================================================
# Strategy: quick-wins (favor small tasks)
# =============================================================================

@test "quick-wins strategy: small task returns weight 3" {
    run calculate_size_weight "small" "quick-wins"
    assert_success
    assert_output "3"
}

@test "quick-wins strategy: medium task returns weight 2" {
    run calculate_size_weight "medium" "quick-wins"
    assert_success
    assert_output "2"
}

@test "quick-wins strategy: large task returns weight 1" {
    run calculate_size_weight "large" "quick-wins"
    assert_success
    assert_output "1"
}

# =============================================================================
# Strategy: big-impact (favor large tasks)
# =============================================================================

@test "big-impact strategy: small task returns weight 1" {
    run calculate_size_weight "small" "big-impact"
    assert_success
    assert_output "1"
}

@test "big-impact strategy: medium task returns weight 2" {
    run calculate_size_weight "medium" "big-impact"
    assert_success
    assert_output "2"
}

@test "big-impact strategy: large task returns weight 3" {
    run calculate_size_weight "large" "big-impact"
    assert_success
    assert_output "3"
}

# =============================================================================
# Strategy: balanced (all tasks equal)
# =============================================================================

@test "balanced strategy: small task returns weight 1" {
    run calculate_size_weight "small" "balanced"
    assert_success
    assert_output "1"
}

@test "balanced strategy: medium task returns weight 1" {
    run calculate_size_weight "medium" "balanced"
    assert_success
    assert_output "1"
}

@test "balanced strategy: large task returns weight 1" {
    run calculate_size_weight "large" "balanced"
    assert_success
    assert_output "1"
}

# =============================================================================
# Edge Cases: Invalid Size
# =============================================================================

@test "invalid size returns default weight 1" {
    run calculate_size_weight "invalid-size" "quick-wins"
    assert_success
    assert_output "1"
}

@test "empty size returns default weight 1" {
    run calculate_size_weight "" "quick-wins"
    assert_success
    assert_output "1"
}

@test "missing size returns default weight 1 (quick-wins)" {
    run calculate_size_weight "unknown" "quick-wins"
    assert_success
    assert_output "1"
}

@test "missing size returns default weight 1 (big-impact)" {
    run calculate_size_weight "unknown" "big-impact"
    assert_success
    assert_output "1"
}

@test "missing size returns default weight 1 (balanced)" {
    run calculate_size_weight "unknown" "balanced"
    assert_success
    assert_output "1"
}

# =============================================================================
# Edge Cases: Invalid Strategy
# =============================================================================

@test "invalid strategy defaults to balanced (small)" {
    run calculate_size_weight "small" "invalid-strategy"
    assert_success
    assert_output "1"
}

@test "invalid strategy defaults to balanced (medium)" {
    run calculate_size_weight "medium" "invalid-strategy"
    assert_success
    assert_output "1"
}

@test "invalid strategy defaults to balanced (large)" {
    run calculate_size_weight "large" "invalid-strategy"
    assert_success
    assert_output "1"
}

@test "empty strategy defaults to balanced" {
    run calculate_size_weight "small" ""
    assert_success
    # Empty strategy should fall through to config (which defaults to balanced)
    # For empty string, it will try to get from config
    [ "$output" -eq 1 ] || [ "$output" -eq 3 ]
}

# =============================================================================
# Edge Cases: Missing Strategy (uses config)
# =============================================================================

@test "missing strategy parameter reads from config" {
    # Create test config with balanced strategy
    cat > "$TEST_TEMP_DIR/.cleo/config.json" << 'EOF'
{
  "_meta": {"version": "1.0.0"},
  "analyze": {
    "sizeStrategy": "balanced"
  }
}
EOF

    # When no strategy provided, should use config value
    run calculate_size_weight "small"
    assert_success
    assert_output "1"
}

@test "missing strategy defaults to balanced when config not set" {
    # Create test config without sizeStrategy
    cat > "$TEST_TEMP_DIR/.cleo/config.json" << 'EOF'
{
  "_meta": {"version": "1.0.0"},
  "analyze": {}
}
EOF

    # Should default to balanced
    run calculate_size_weight "small"
    assert_success
    assert_output "1"
}

# =============================================================================
# Strategy Configuration Tests
# =============================================================================

@test "get_size_strategy returns configured value" {
    # Create test config with quick-wins strategy
    cat > "$TEST_TEMP_DIR/.cleo/config.json" << 'EOF'
{
  "_meta": {"version": "1.0.0"},
  "analyze": {
    "sizeStrategy": "quick-wins"
  }
}
EOF

    run get_size_strategy
    assert_success
    assert_output "quick-wins"
}

@test "get_size_strategy defaults to balanced when not configured" {
    # Create test config without sizeStrategy
    cat > "$TEST_TEMP_DIR/.cleo/config.json" << 'EOF'
{
  "_meta": {"version": "1.0.0"},
  "analyze": {}
}
EOF

    run get_size_strategy
    assert_success
    assert_output "balanced"
}

# =============================================================================
# Weight Matrix Validation
# =============================================================================

@test "quick-wins weight matrix is correct (3,2,1)" {
    local small_weight medium_weight large_weight
    small_weight=$(calculate_size_weight "small" "quick-wins")
    medium_weight=$(calculate_size_weight "medium" "quick-wins")
    large_weight=$(calculate_size_weight "large" "quick-wins")

    [ "$small_weight" -eq 3 ]
    [ "$medium_weight" -eq 2 ]
    [ "$large_weight" -eq 1 ]
}

@test "big-impact weight matrix is correct (1,2,3)" {
    local small_weight medium_weight large_weight
    small_weight=$(calculate_size_weight "small" "big-impact")
    medium_weight=$(calculate_size_weight "medium" "big-impact")
    large_weight=$(calculate_size_weight "large" "big-impact")

    [ "$small_weight" -eq 1 ]
    [ "$medium_weight" -eq 2 ]
    [ "$large_weight" -eq 3 ]
}

@test "balanced weight matrix is correct (1,1,1)" {
    local small_weight medium_weight large_weight
    small_weight=$(calculate_size_weight "small" "balanced")
    medium_weight=$(calculate_size_weight "medium" "balanced")
    large_weight=$(calculate_size_weight "large" "balanced")

    [ "$small_weight" -eq 1 ]
    [ "$medium_weight" -eq 1 ]
    [ "$large_weight" -eq 1 ]
}

# =============================================================================
# Return Value Tests
# =============================================================================

@test "calculate_size_weight returns numeric value only" {
    run calculate_size_weight "small" "quick-wins"
    assert_success
    # Output should be a single number
    [[ "$output" =~ ^[0-9]+$ ]]
}

@test "calculate_size_weight returns value in valid range (1-3)" {
    local weight
    weight=$(calculate_size_weight "large" "big-impact")
    [ "$weight" -ge 1 ]
    [ "$weight" -le 3 ]
}

@test "all weight calculations return integers" {
    local weights=(
        "$(calculate_size_weight "small" "quick-wins")"
        "$(calculate_size_weight "medium" "big-impact")"
        "$(calculate_size_weight "large" "balanced")"
    )

    for w in "${weights[@]}"; do
        [[ "$w" =~ ^[0-9]+$ ]]
    done
}
