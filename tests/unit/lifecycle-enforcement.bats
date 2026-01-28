#!/usr/bin/env bats

# @task T2720
# Lifecycle Gate Enforcement Tests
# Tests for lib/lifecycle.sh RCSD state tracking and gate enforcement

load '../libs/bats-support/load'
load '../libs/bats-assert/load'

# Setup and teardown
setup() {
    export TEST_DIR="$(mktemp -d)"
    export CLEO_ROOT="$TEST_DIR"
    export CLEO_HOME="$TEST_DIR/.cleo"

    mkdir -p "$TEST_DIR/.cleo/rcsd"
    mkdir -p "$TEST_DIR/.cleo"

    # Copy required libraries
    cp "$BATS_TEST_DIRNAME/../../lib/lifecycle.sh" "$TEST_DIR/"
    cp "$BATS_TEST_DIRNAME/../../lib/exit-codes.sh" "$TEST_DIR/"

    # Source the library
    cd "$TEST_DIR"
    source "$TEST_DIR/lifecycle.sh"
}

teardown() {
    rm -rf "$TEST_DIR"
}

# ============================================================================
# RCSD State Tracking Tests
# ============================================================================

@test "get_rcsd_stage_status returns pending for missing manifest" {
    local result
    result=$(get_rcsd_stage_status "T1234" "research")
    assert_equal "$result" "pending"
}

@test "get_rcsd_stage_status returns completed for completed stage" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234"
    echo '{"status":{"research":{"state":"completed","completedAt":"2026-01-28T00:00:00Z"}}}' > "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json"

    local result
    result=$(get_rcsd_stage_status "T1234" "research")
    assert_equal "$result" "completed"
}

@test "get_rcsd_stage_status returns skipped for skipped stage" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234"
    echo '{"status":{"consensus":{"state":"skipped","completedAt":"2026-01-28T00:00:00Z"}}}' > "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json"

    local result
    result=$(get_rcsd_stage_status "T1234" "consensus")
    assert_equal "$result" "skipped"
}

@test "get_rcsd_stage_status returns in_progress for active stage" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234"
    echo '{"status":{"specification":{"state":"in_progress"}}}' > "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json"

    local result
    result=$(get_rcsd_stage_status "T1234" "specification")
    assert_equal "$result" "in_progress"
}

@test "record_rcsd_stage_completion creates manifest directory" {
    record_rcsd_stage_completion "T1234" "research" "completed"

    assert [ -d "$TEST_DIR/.cleo/rcsd/T1234" ]
}

@test "record_rcsd_stage_completion creates manifest file" {
    record_rcsd_stage_completion "T1234" "research" "completed"

    assert [ -f "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json" ]
}

@test "record_rcsd_stage_completion sets correct state" {
    record_rcsd_stage_completion "T1234" "research" "completed"

    local state
    state=$(jq -r '.status.research.state' "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json")
    assert_equal "$state" "completed"
}

@test "record_rcsd_stage_completion includes timestamp" {
    record_rcsd_stage_completion "T1234" "research" "completed"

    local timestamp
    timestamp=$(jq -r '.status.research.completedAt' "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json")
    assert_not_equal "$timestamp" "null"
    assert_not_equal "$timestamp" ""
}

@test "record_rcsd_stage_completion updates existing manifest" {
    # Create initial manifest
    record_rcsd_stage_completion "T1234" "research" "completed"

    # Update with new stage
    record_rcsd_stage_completion "T1234" "consensus" "completed"

    local research_state
    local consensus_state
    research_state=$(jq -r '.status.research.state' "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json")
    consensus_state=$(jq -r '.status.consensus.state' "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json")

    assert_equal "$research_state" "completed"
    assert_equal "$consensus_state" "completed"
}

@test "record_rcsd_stage_completion supports skipped status" {
    record_rcsd_stage_completion "T1234" "consensus" "skipped"

    local state
    state=$(jq -r '.status.consensus.state' "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json")
    assert_equal "$state" "skipped"
}

# ============================================================================
# Gate Enforcement Tests - Scenario 1: Block without research
# ============================================================================

@test "query_rcsd_prerequisite_status fails for implementation without research" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234"
    echo '{"status":{}}' > "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json"

    run query_rcsd_prerequisite_status "T1234" "implementation"
    assert_failure
}

@test "query_rcsd_prerequisite_status returns exit code 75 on failure" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234"
    echo '{"status":{}}' > "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json"

    run query_rcsd_prerequisite_status "T1234" "implementation"
    assert_equal "$status" 75
}

@test "query_rcsd_prerequisite_status fails when only research completed" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234"
    echo '{"status":{"research":{"state":"completed"}}}' > "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json"

    run query_rcsd_prerequisite_status "T1234" "implementation"
    assert_failure
}

@test "query_rcsd_prerequisite_status fails when intermediate stages missing" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234"
    cat > "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json" << 'EOF'
{
  "status": {
    "research": {"state": "completed"},
    "consensus": {"state": "pending"},
    "specification": {"state": "completed"}
  }
}
EOF

    run query_rcsd_prerequisite_status "T1234" "implementation"
    assert_failure
}

# ============================================================================
# Gate Enforcement Tests - Scenario 2: Allow correct progression
# ============================================================================

@test "query_rcsd_prerequisite_status passes when all prerequisites completed" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234"
    cat > "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json" << 'EOF'
{
  "status": {
    "research": {"state": "completed"},
    "consensus": {"state": "completed"},
    "specification": {"state": "completed"},
    "decomposition": {"state": "completed"}
  }
}
EOF

    run query_rcsd_prerequisite_status "T1234" "implementation"
    assert_success
}

@test "query_rcsd_prerequisite_status passes with skipped stages" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234"
    cat > "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json" << 'EOF'
{
  "status": {
    "research": {"state": "completed"},
    "consensus": {"state": "skipped"},
    "specification": {"state": "completed"},
    "decomposition": {"state": "skipped"}
  }
}
EOF

    run query_rcsd_prerequisite_status "T1234" "implementation"
    assert_success
}

@test "query_rcsd_prerequisite_status passes with mixed completed and skipped" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234"
    cat > "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json" << 'EOF'
{
  "status": {
    "research": {"state": "completed"},
    "consensus": {"state": "completed"},
    "specification": {"state": "skipped"},
    "decomposition": {"state": "completed"}
  }
}
EOF

    run query_rcsd_prerequisite_status "T1234" "implementation"
    assert_success
}

# ============================================================================
# Gate Enforcement Tests - Scenario 3: Advisory mode warns but proceeds
# ============================================================================

@test "get_lifecycle_enforcement_mode returns strict by default" {
    # No config file
    local mode
    mode=$(get_lifecycle_enforcement_mode)
    assert_equal "$mode" "strict"
}

@test "get_lifecycle_enforcement_mode returns advisory when configured" {
    echo '{"lifecycleEnforcement":{"mode":"advisory"}}' > "$TEST_DIR/.cleo/config.json"

    local mode
    mode=$(get_lifecycle_enforcement_mode)
    assert_equal "$mode" "advisory"
}

@test "get_lifecycle_enforcement_mode handles missing config file" {
    rm -f "$TEST_DIR/.cleo/config.json"

    local mode
    mode=$(get_lifecycle_enforcement_mode)
    assert_equal "$mode" "strict"
}

@test "get_lifecycle_enforcement_mode handles empty config file" {
    echo '{}' > "$TEST_DIR/.cleo/config.json"

    local mode
    mode=$(get_lifecycle_enforcement_mode)
    assert_equal "$mode" "strict"
}

@test "get_lifecycle_enforcement_mode handles missing lifecycleEnforcement key" {
    echo '{"otherConfig":true}' > "$TEST_DIR/.cleo/config.json"

    local mode
    mode=$(get_lifecycle_enforcement_mode)
    assert_equal "$mode" "strict"
}

# ============================================================================
# Gate Enforcement Tests - Scenario 4: Off mode skips checks
# ============================================================================

@test "get_lifecycle_enforcement_mode returns off when configured" {
    echo '{"lifecycleEnforcement":{"mode":"off"}}' > "$TEST_DIR/.cleo/config.json"

    local mode
    mode=$(get_lifecycle_enforcement_mode)
    assert_equal "$mode" "off"
}

@test "get_lifecycle_enforcement_mode defaults to strict on invalid mode" {
    echo '{"lifecycleEnforcement":{"mode":"invalid"}}' > "$TEST_DIR/.cleo/config.json"

    local mode
    mode=$(get_lifecycle_enforcement_mode)
    assert_equal "$mode" "strict"
}

@test "get_lifecycle_enforcement_mode defaults to strict on null mode" {
    echo '{"lifecycleEnforcement":{"mode":null}}' > "$TEST_DIR/.cleo/config.json"

    local mode
    mode=$(get_lifecycle_enforcement_mode)
    assert_equal "$mode" "strict"
}

@test "get_lifecycle_enforcement_mode is case-sensitive" {
    echo '{"lifecycleEnforcement":{"mode":"STRICT"}}' > "$TEST_DIR/.cleo/config.json"

    local mode
    mode=$(get_lifecycle_enforcement_mode)
    # Should default to strict since STRICT is not valid
    assert_equal "$mode" "strict"
}

# ============================================================================
# Edge Cases
# ============================================================================

@test "research stage has no prerequisites" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234"
    echo '{"status":{}}' > "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json"

    run query_rcsd_prerequisite_status "T1234" "research"
    assert_success
}

@test "consensus requires only research" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234"
    echo '{"status":{"research":{"state":"completed"}}}' > "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json"

    run query_rcsd_prerequisite_status "T1234" "consensus"
    assert_success
}

@test "specification requires research and consensus" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234"
    cat > "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json" << 'EOF'
{
  "status": {
    "research": {"state": "completed"},
    "consensus": {"state": "completed"}
  }
}
EOF

    run query_rcsd_prerequisite_status "T1234" "specification"
    assert_success
}

@test "decomposition requires all RCSD stages" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234"
    cat > "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json" << 'EOF'
{
  "status": {
    "research": {"state": "completed"},
    "consensus": {"state": "completed"},
    "specification": {"state": "completed"}
  }
}
EOF

    run query_rcsd_prerequisite_status "T1234" "decomposition"
    assert_success
}

@test "query_rcsd_prerequisite_status handles missing manifest as all pending" {
    # No manifest file exists
    run query_rcsd_prerequisite_status "T1234" "research"
    assert_success
}

@test "query_rcsd_prerequisite_status fails for unknown stage" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234"
    echo '{"status":{}}' > "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json"

    run query_rcsd_prerequisite_status "T1234" "unknown_stage"
    assert_failure
    assert_equal "$status" 75
}

@test "get_rcsd_stage_status handles deeply nested task IDs" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234.5.6"
    echo '{"status":{"research":{"state":"completed"}}}' > "$TEST_DIR/.cleo/rcsd/T1234.5.6/_manifest.json"

    local result
    result=$(get_rcsd_stage_status "T1234.5.6" "research")
    assert_equal "$result" "completed"
}

# ============================================================================
# Integration Tests - Full Lifecycle Progression
# ============================================================================

@test "full RCSD progression records all stages" {
    # Research
    record_rcsd_stage_completion "T1234" "research" "completed"
    run query_rcsd_prerequisite_status "T1234" "consensus"
    assert_success

    # Consensus
    record_rcsd_stage_completion "T1234" "consensus" "completed"
    run query_rcsd_prerequisite_status "T1234" "specification"
    assert_success

    # Specification
    record_rcsd_stage_completion "T1234" "specification" "completed"
    run query_rcsd_prerequisite_status "T1234" "decomposition"
    assert_success

    # Decomposition
    record_rcsd_stage_completion "T1234" "decomposition" "completed"
    run query_rcsd_prerequisite_status "T1234" "implementation"
    assert_success
}

@test "skipping stages allows progression" {
    # Research
    record_rcsd_stage_completion "T1234" "research" "completed"

    # Skip consensus
    record_rcsd_stage_completion "T1234" "consensus" "skipped"

    # Specification
    record_rcsd_stage_completion "T1234" "specification" "completed"

    # Skip decomposition
    record_rcsd_stage_completion "T1234" "decomposition" "skipped"

    # Should be able to proceed to implementation
    run query_rcsd_prerequisite_status "T1234" "implementation"
    assert_success
}

@test "failed stage blocks progression" {
    record_rcsd_stage_completion "T1234" "research" "completed"
    record_rcsd_stage_completion "T1234" "consensus" "failed"

    run query_rcsd_prerequisite_status "T1234" "specification"
    assert_failure
}

@test "get_epic_rcsd_state returns empty object for missing manifest" {
    run get_epic_rcsd_state "T1234"
    assert_failure
    assert_equal "$status" 4  # EXIT_NOT_FOUND
}

@test "get_epic_rcsd_state returns status object for existing manifest" {
    mkdir -p "$TEST_DIR/.cleo/rcsd/T1234"
    cat > "$TEST_DIR/.cleo/rcsd/T1234/_manifest.json" << 'EOF'
{
  "taskId": "T1234",
  "status": {
    "research": {"state": "completed"},
    "consensus": {"state": "skipped"}
  }
}
EOF

    run get_epic_rcsd_state "T1234"
    assert_success

    # Check that we get a JSON object
    local research_state
    research_state=$(echo "$output" | jq -r '.research.state')
    assert_equal "$research_state" "completed"
}
