#!/usr/bin/env bats
# =============================================================================
# orchestrator-context.bats - Unit tests for orchestrator context tracking
# =============================================================================
# Tests for:
# - orchestrator_should_pause() threshold checking and pause decisions
# - orchestrator_pre_spawn_check() pre-spawn validation
# - _os_get_context_state() session-aware context state reading
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file

    # Export paths
    export ORCH_LIB="${LIB_DIR}/skills/orchestrator-startup.sh"
    export OUTPUT_FORMAT_LIB="${LIB_DIR}/core/output-format.sh"
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    common_setup_per_test

    # cd to test directory so relative paths work
    cd "$TEST_TEMP_DIR"

    # Create session ID for tests
    export TEST_SESSION_ID="session_test_orch_12345"
    echo -n "$TEST_SESSION_ID" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Set up context state file paths
    export CONTEXT_STATE_FILE="${TEST_TEMP_DIR}/.cleo/.context-state-${TEST_SESSION_ID}.json"

    # Source required libraries AFTER cd to test directory
    source "$OUTPUT_FORMAT_LIB"
    source "$ORCH_LIB"

    # Export CONFIG_FILE so subshells (via 'run') can access it
    export CONFIG_FILE
    export CONTEXT_STATE_FILE
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper Functions
# =============================================================================

_create_context_state() {
    local percentage="$1"
    local current_tokens="${2:-100000}"
    local max_tokens="${3:-200000}"
    local timestamp="${4:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

    # Determine status based on percentage
    local status="ok"
    if [[ "$percentage" -ge 95 ]]; then
        status="emergency"
    elif [[ "$percentage" -ge 90 ]]; then
        status="critical"
    elif [[ "$percentage" -ge 85 ]]; then
        status="caution"
    elif [[ "$percentage" -ge 70 ]]; then
        status="warning"
    fi

    cat > "$CONTEXT_STATE_FILE" << EOF
{
  "timestamp": "$timestamp",
  "staleAfterMs": 5000,
  "contextWindow": {
    "percentage": $percentage,
    "currentTokens": $current_tokens,
    "maxTokens": $max_tokens
  },
  "status": "$status"
}
EOF
}

_create_stale_context_state() {
    local percentage="$1"
    # 10 seconds ago (well past 5s stale threshold)
    local old_timestamp=$(date -u -d '10 seconds ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-10S +%Y-%m-%dT%H:%M:%SZ)
    _create_context_state "$percentage" 100000 200000 "$old_timestamp"
}

_set_orchestrator_thresholds() {
    local warning="${1:-70}"
    local critical="${2:-80}"

    jq --argjson w "$warning" --argjson c "$critical" '
        .orchestrator = {
            "contextThresholds": {
                "warning": $w,
                "critical": $c
            },
            "autoStopOnCritical": true
        }
    ' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
}

_create_test_task() {
    local task_id="$1"
    local status="${2:-pending}"
    local title="${3:-Test Task}"

    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"

    # Create empty todo.json if it doesn't exist
    if [[ ! -f "$todo_file" ]]; then
        cat > "$todo_file" << 'EOF'
{
  "_meta": {
    "schemaVersion": "2.6.0"
  },
  "tasks": []
}
EOF
    fi

    jq --arg id "$task_id" --arg status "$status" --arg title "$title" '
        .tasks += [{
            "id": $id,
            "title": $title,
            "status": $status,
            "priority": "medium",
            "createdAt": "2026-01-20T00:00:00Z",
            "updatedAt": "2026-01-20T00:00:00Z"
        }]
    ' "$todo_file" > "${todo_file}.tmp" && mv "${todo_file}.tmp" "$todo_file"
}

# =============================================================================
# _os_get_context_state Tests
# =============================================================================

@test "_os_get_context_state returns context values when state file exists" {
    _create_context_state 65

    local result
    result=$(_os_get_context_state "$TEST_SESSION_ID")

    # Check JSON structure
    local percentage
    percentage=$(echo "$result" | jq -r '.percentage')
    [[ "$percentage" == "65" ]]
}

@test "_os_get_context_state returns stale:true when file is old" {
    _create_stale_context_state 50

    # Function returns exit 1 for stale, but still outputs JSON
    local result
    result=$(_os_get_context_state "$TEST_SESSION_ID" || true)

    local is_stale
    is_stale=$(echo "$result" | jq -r '.stale')
    [[ "$is_stale" == "true" ]]
}

@test "_os_get_context_state returns default values when no state file" {
    rm -f "$CONTEXT_STATE_FILE"
    rm -f "${TEST_TEMP_DIR}/.cleo/.context-state.json"

    # Function returns exit 1 for missing, but still outputs JSON
    local result
    result=$(_os_get_context_state "$TEST_SESSION_ID" || true)

    local stale
    stale=$(echo "$result" | jq -r '.stale')
    [[ "$stale" == "true" ]]

    local percentage
    percentage=$(echo "$result" | jq -r '.percentage')
    [[ "$percentage" == "0" ]]
}

@test "_os_get_context_state falls back to singleton state file" {
    rm -f "$CONTEXT_STATE_FILE"

    # Create singleton state file
    cat > "${TEST_TEMP_DIR}/.cleo/.context-state.json" << 'EOF'
{
  "timestamp": "2026-01-26T12:00:00Z",
  "staleAfterMs": 999999999,
  "contextWindow": {
    "percentage": 42,
    "currentTokens": 84000,
    "maxTokens": 200000
  },
  "status": "ok"
}
EOF

    local result
    result=$(_os_get_context_state)

    local percentage
    percentage=$(echo "$result" | jq -r '.percentage')
    [[ "$percentage" == "42" ]]
}

# =============================================================================
# orchestrator_should_pause Tests
# =============================================================================

@test "orchestrator_should_pause returns 0 (continue) when context below warning" {
    _create_context_state 50
    _set_orchestrator_thresholds 70 80

    run orchestrator_should_pause
    assert_success

    local pause_status
    pause_status=$(echo "$output" | jq -r '.result.pauseStatus')
    [[ "$pause_status" == "ok" ]]
}

@test "orchestrator_should_pause returns 1 (warning) when context at warning threshold" {
    _create_context_state 75
    _set_orchestrator_thresholds 70 80

    run orchestrator_should_pause
    [[ "$status" -eq 1 ]]

    local pause_status
    pause_status=$(echo "$output" | jq -r '.result.pauseStatus')
    [[ "$pause_status" == "warning" ]]

    local should_wrap_up
    should_wrap_up=$(echo "$output" | jq -r '.result.shouldWrapUp')
    [[ "$should_wrap_up" == "true" ]]
}

@test "orchestrator_should_pause returns 2 (critical) when context at critical threshold" {
    _create_context_state 85
    _set_orchestrator_thresholds 70 80

    run orchestrator_should_pause
    [[ "$status" -eq 2 ]]

    local pause_status
    pause_status=$(echo "$output" | jq -r '.result.pauseStatus')
    [[ "$pause_status" == "critical" ]]

    local should_pause
    should_pause=$(echo "$output" | jq -r '.result.shouldPause')
    [[ "$should_pause" == "true" ]]
}

@test "orchestrator_should_pause uses config-driven thresholds" {
    _create_context_state 65
    _set_orchestrator_thresholds 60 70  # Lower thresholds

    run orchestrator_should_pause
    [[ "$status" -eq 1 ]]  # Should be warning at 65% with 60% threshold

    local warning_threshold
    warning_threshold=$(echo "$output" | jq -r '.result.warningThreshold')
    [[ "$warning_threshold" == "60" ]]
}

@test "orchestrator_should_pause includes autoStopOnCritical flag" {
    _create_context_state 50
    _set_orchestrator_thresholds 70 80

    run orchestrator_should_pause
    assert_success

    local auto_stop
    auto_stop=$(echo "$output" | jq -r '.result.autoStopOnCritical')
    [[ "$auto_stop" == "true" ]]
}

# =============================================================================
# orchestrator_pre_spawn_check Tests
# =============================================================================

@test "orchestrator_pre_spawn_check returns canSpawn:true when context healthy" {
    _create_context_state 50
    _set_orchestrator_thresholds 70 80

    run orchestrator_pre_spawn_check
    assert_success

    local can_spawn
    can_spawn=$(echo "$output" | jq -r '.result.canSpawn')
    [[ "$can_spawn" == "true" ]]

    local recommendation
    recommendation=$(echo "$output" | jq -r '.result.recommendation')
    [[ "$recommendation" == "continue" ]]
}

@test "orchestrator_pre_spawn_check returns canSpawn:true but wrap_up at warning" {
    _create_context_state 75
    _set_orchestrator_thresholds 70 80

    run orchestrator_pre_spawn_check
    assert_success  # Still returns 0 because canSpawn is true

    local can_spawn
    can_spawn=$(echo "$output" | jq -r '.result.canSpawn')
    [[ "$can_spawn" == "true" ]]

    local recommendation
    recommendation=$(echo "$output" | jq -r '.result.recommendation')
    [[ "$recommendation" == "wrap_up" ]]

    local spawn_status
    spawn_status=$(echo "$output" | jq -r '.result.spawnStatus')
    [[ "$spawn_status" == "warning" ]]
}

@test "orchestrator_pre_spawn_check returns canSpawn:false at critical threshold" {
    _create_context_state 85
    _set_orchestrator_thresholds 70 80

    run orchestrator_pre_spawn_check
    assert_failure  # Returns non-zero when canSpawn is false

    local can_spawn
    can_spawn=$(echo "$output" | jq -r '.result.canSpawn')
    [[ "$can_spawn" == "false" ]]

    local recommendation
    recommendation=$(echo "$output" | jq -r '.result.recommendation')
    [[ "$recommendation" == "stop" ]]
}

@test "orchestrator_pre_spawn_check includes context details" {
    _create_context_state 60 120000 200000
    _set_orchestrator_thresholds 70 80

    run orchestrator_pre_spawn_check
    assert_success

    local percentage
    percentage=$(echo "$output" | jq -r '.result.context.percentage')
    [[ "$percentage" == "60" ]]

    local current_tokens
    current_tokens=$(echo "$output" | jq -r '.result.context.currentTokens')
    [[ "$current_tokens" == "120000" ]]

    local max_tokens
    max_tokens=$(echo "$output" | jq -r '.result.context.maxTokens')
    [[ "$max_tokens" == "200000" ]]
}

@test "orchestrator_pre_spawn_check validates task exists when task_id provided" {
    _create_context_state 50
    _set_orchestrator_thresholds 70 80
    _create_test_task "T001" "pending" "Test Task"

    run orchestrator_pre_spawn_check "T001"
    assert_success

    local task_exists
    task_exists=$(echo "$output" | jq -r '.result.taskValidation.exists')
    [[ "$task_exists" == "true" ]]

    local spawnable
    spawnable=$(echo "$output" | jq -r '.result.taskValidation.spawnable')
    [[ "$spawnable" == "true" ]]
}

@test "orchestrator_pre_spawn_check blocks spawn for non-pending task" {
    _create_context_state 50
    _set_orchestrator_thresholds 70 80
    _create_test_task "T001" "done" "Completed Task"

    run orchestrator_pre_spawn_check "T001"
    assert_failure

    local can_spawn
    can_spawn=$(echo "$output" | jq -r '.result.canSpawn')
    [[ "$can_spawn" == "false" ]]

    local reason_code
    reason_code=$(echo "$output" | jq -r '.result.reasons[0].code')
    [[ "$reason_code" == "TASK_NOT_PENDING" ]]
}

@test "orchestrator_pre_spawn_check blocks spawn for non-existent task" {
    _create_context_state 50
    _set_orchestrator_thresholds 70 80

    # Create todo.json with a different task (so T999 doesn't exist)
    _create_test_task "T001" "pending" "Some Other Task"

    run orchestrator_pre_spawn_check "T999"
    assert_failure

    local can_spawn
    can_spawn=$(echo "$output" | jq -r '.result.canSpawn')
    [[ "$can_spawn" == "false" ]]

    local reason_code
    reason_code=$(echo "$output" | jq -r '.result.reasons[0].code')
    [[ "$reason_code" == "TASK_NOT_FOUND" ]]
}

@test "orchestrator_pre_spawn_check handles stale context state gracefully" {
    _create_stale_context_state 50
    _set_orchestrator_thresholds 70 80

    run orchestrator_pre_spawn_check
    assert_success  # Should still allow spawn but indicate stale

    local spawn_status
    spawn_status=$(echo "$output" | jq -r '.result.spawnStatus')
    [[ "$spawn_status" == "stale" ]]

    local reason_code
    reason_code=$(echo "$output" | jq -r '.result.reasons[0].code')
    [[ "$reason_code" == "CONTEXT_STALE" ]]
}

@test "orchestrator_pre_spawn_check returns multiple reasons when applicable" {
    _create_context_state 85  # Critical threshold
    _set_orchestrator_thresholds 70 80
    _create_test_task "T001" "done" "Completed Task"

    run orchestrator_pre_spawn_check "T001"
    assert_failure

    local reason_count
    reason_count=$(echo "$output" | jq '.result.reasons | length')
    [[ "$reason_count" -ge 2 ]]  # Context critical + task not pending
}

# =============================================================================
# Integration with orchestrator_context_check Tests
# =============================================================================

# Note: orchestrator_context_check uses ORCHESTRATOR_CONTEXT_BUDGET (10000 tokens)
# for percentage calculation, not the max tokens from context state file.
# It reads currentTokens from context state, then calculates % against budget.

@test "orchestrator_context_check uses session-aware context state" {
    # Create context state with 7500 tokens (75% of 10000 budget)
    _create_context_state 75 7500 200000
    _set_orchestrator_thresholds 70 80

    run orchestrator_context_check
    assert_success

    local status
    status=$(echo "$output" | jq -r '.result.status')
    [[ "$status" == "warning" ]]
}

@test "orchestrator_context_check returns critical at threshold" {
    # Create context state with 8500 tokens (85% of 10000 budget)
    _create_context_state 85 8500 200000
    _set_orchestrator_thresholds 70 80

    run orchestrator_context_check
    [[ "$status" -eq 52 ]]  # EXIT_CONTEXT_CRITICAL

    local check_status
    check_status=$(echo "$output" | jq -r '.result.status')
    [[ "$check_status" == "critical" ]]
}

# =============================================================================
# generate_hitl_summary Tests (T2383)
# =============================================================================

@test "generate_hitl_summary returns structured JSON with progress" {
    # Create epic and child tasks
    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    cat > "$todo_file" << 'EOF'
{
  "_meta": { "schemaVersion": "2.6.0" },
  "tasks": [
    {"id": "T001", "title": "Test Epic", "status": "active", "type": "epic"},
    {"id": "T002", "title": "Task 1", "status": "done", "parentId": "T001", "priority": "high"},
    {"id": "T003", "title": "Task 2", "status": "pending", "parentId": "T001", "priority": "medium"},
    {"id": "T004", "title": "Task 3", "status": "pending", "parentId": "T001", "priority": "low"}
  ]
}
EOF

    run generate_hitl_summary "T001" "context-limit"
    assert_success

    # Check structure
    local operation
    operation=$(echo "$output" | jq -r '._meta.operation')
    [[ "$operation" == "hitl_summary" ]]

    # Check progress counts
    local completed pending
    completed=$(echo "$output" | jq -r '.result.progress.completed')
    pending=$(echo "$output" | jq -r '.result.progress.pending')
    [[ "$completed" == "1" ]]
    [[ "$pending" == "2" ]]
}

@test "generate_hitl_summary includes resume command" {
    # Create minimal todo for testing
    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    cat > "$todo_file" << 'EOF'
{
  "_meta": { "schemaVersion": "2.6.0" },
  "tasks": []
}
EOF

    run generate_hitl_summary "T001" "test-reason"
    assert_success

    local resume_cmd
    resume_cmd=$(echo "$output" | jq -r '.result.handoff.resumeCommand')
    # When no session exists, should suggest starting new session with scope
    [[ "$resume_cmd" == *"epic:T001"* ]] || [[ "$resume_cmd" == *"session"* ]]
}

@test "generate_hitl_summary includes remaining tasks sorted by priority" {
    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    cat > "$todo_file" << 'EOF'
{
  "_meta": { "schemaVersion": "2.6.0" },
  "tasks": [
    {"id": "T001", "title": "Epic", "status": "active", "type": "epic"},
    {"id": "T002", "title": "Low Task", "status": "pending", "parentId": "T001", "priority": "low"},
    {"id": "T003", "title": "Critical Task", "status": "pending", "parentId": "T001", "priority": "critical"},
    {"id": "T004", "title": "High Task", "status": "pending", "parentId": "T001", "priority": "high"}
  ]
}
EOF

    run generate_hitl_summary "T001"
    assert_success

    # First remaining task should be critical priority
    local first_priority
    first_priority=$(echo "$output" | jq -r '.result.remainingTasks[0].priority')
    [[ "$first_priority" == "critical" ]]

    # Second should be high
    local second_priority
    second_priority=$(echo "$output" | jq -r '.result.remainingTasks[1].priority')
    [[ "$second_priority" == "high" ]]
}

# =============================================================================
# orchestrator_auto_stop Tests (T2383)
# =============================================================================

@test "orchestrator_auto_stop returns stopped:false when autoStopOnCritical disabled" {
    # Disable autoStopOnCritical in config
    jq '.orchestrator.autoStopOnCritical = false' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    run orchestrator_auto_stop "T001"

    local stopped
    stopped=$(echo "$output" | jq -r '.result.stopped')
    [[ "$stopped" == "false" ]]

    local reason
    reason=$(echo "$output" | jq -r '.result.reason')
    [[ "$reason" == *"disabled"* ]]
}

@test "orchestrator_auto_stop returns stopped:true when enabled" {
    _set_orchestrator_thresholds 70 80

    # Create minimal todo
    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    cat > "$todo_file" << 'EOF'
{
  "_meta": { "schemaVersion": "2.6.0" },
  "tasks": []
}
EOF

    run orchestrator_auto_stop "T001" "test-reason"
    assert_success

    local stopped
    stopped=$(echo "$output" | jq -r '.result.stopped')
    [[ "$stopped" == "true" ]]

    local stop_reason
    stop_reason=$(echo "$output" | jq -r '.result.stopReason')
    [[ "$stop_reason" == "test-reason" ]]
}

@test "orchestrator_auto_stop includes HITL summary when enabled" {
    _set_orchestrator_thresholds 70 80

    # Enable hitlSummaryOnPause (default is true)
    jq '.orchestrator.hitlSummaryOnPause = true' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    cat > "$todo_file" << 'EOF'
{
  "_meta": { "schemaVersion": "2.6.0" },
  "tasks": [
    {"id": "T001", "title": "Epic", "status": "active", "type": "epic"},
    {"id": "T002", "title": "Task", "status": "pending", "parentId": "T001"}
  ]
}
EOF

    run orchestrator_auto_stop "T001"
    assert_success

    local hitl_generated
    hitl_generated=$(echo "$output" | jq -r '.result.hitlSummaryGenerated')
    [[ "$hitl_generated" == "true" ]]

    # HITL summary should be embedded
    local hitl_progress
    hitl_progress=$(echo "$output" | jq -r '.result.hitlSummary.progress.pending // "null"')
    [[ "$hitl_progress" != "null" ]]
}

@test "orchestrator_auto_stop skips HITL summary when disabled" {
    _set_orchestrator_thresholds 70 80

    # Disable hitlSummaryOnPause
    jq '.orchestrator.hitlSummaryOnPause = false' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    cat > "$todo_file" << 'EOF'
{
  "_meta": { "schemaVersion": "2.6.0" },
  "tasks": []
}
EOF

    run orchestrator_auto_stop "T001"
    assert_success

    local hitl_generated
    hitl_generated=$(echo "$output" | jq -r '.result.hitlSummaryGenerated')
    [[ "$hitl_generated" == "false" ]]

    local hitl_summary
    hitl_summary=$(echo "$output" | jq -r '.result.hitlSummary')
    [[ "$hitl_summary" == "null" ]]
}

# =============================================================================
# orchestrator_check_and_stop Tests (T2383)
# =============================================================================

@test "orchestrator_check_and_stop continues when context below critical" {
    _create_context_state 50  # Well below threshold
    _set_orchestrator_thresholds 70 80

    run orchestrator_check_and_stop "T001"
    assert_success  # Exit 0 = continue

    local action
    action=$(echo "$output" | jq -r '.result.action')
    [[ "$action" == "continue" ]]
}

@test "orchestrator_check_and_stop stops when context at critical" {
    _create_context_state 85  # Above critical threshold (80)
    _set_orchestrator_thresholds 70 80

    # Create todo for auto-stop
    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    cat > "$todo_file" << 'EOF'
{
  "_meta": { "schemaVersion": "2.6.0" },
  "tasks": []
}
EOF

    run orchestrator_check_and_stop "T001"
    [[ "$status" -eq 2 ]]  # Exit 2 = stopped

    local action
    action=$(echo "$output" | jq -r '.result.action')
    [[ "$action" == "stopped" ]]

    # Should include auto-stop result
    local stopped
    stopped=$(echo "$output" | jq -r '.result.autoStop.stopped')
    [[ "$stopped" == "true" ]]
}

@test "orchestrator_check_and_stop includes pause check details" {
    _create_context_state 60
    _set_orchestrator_thresholds 70 80

    run orchestrator_check_and_stop
    assert_success

    local pause_status
    pause_status=$(echo "$output" | jq -r '.result.pauseCheck.pauseStatus')
    [[ "$pause_status" == "ok" ]]

    local context_pct
    context_pct=$(echo "$output" | jq -r '.result.pauseCheck.contextPercentage')
    [[ "$context_pct" == "60" ]]
}

# =============================================================================
# Threshold Configuration Edge Cases (T2384)
# =============================================================================

@test "threshold defaults are 70% warning and 80% critical when no config present" {
    # Remove orchestrator config section to test defaults
    jq 'del(.orchestrator)' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Reset the cached thresholds by unsetting them (triggers re-initialization on next call)
    ORCHESTRATOR_CONTEXT_WARNING=""
    ORCHESTRATOR_CONTEXT_CRITICAL=""

    # Create context at 65% - should be below default warning of 70%
    _create_context_state 65

    run orchestrator_should_pause
    assert_success  # 0 = continue

    local warning_threshold critical_threshold
    warning_threshold=$(echo "$output" | jq -r '.result.warningThreshold')
    critical_threshold=$(echo "$output" | jq -r '.result.criticalThreshold')

    [[ "$warning_threshold" == "70" ]]
    [[ "$critical_threshold" == "80" ]]
}

@test "threshold fallback to defaults when warning >= critical (invalid config)" {
    # Set invalid thresholds where warning >= critical
    jq '.orchestrator = {
        "contextThresholds": {
            "warning": 85,
            "critical": 80
        }
    }' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Reset the cached thresholds (triggers re-initialization on next call)
    ORCHESTRATOR_CONTEXT_WARNING=""
    ORCHESTRATOR_CONTEXT_CRITICAL=""

    # Create context at 75% - should be warning with defaults (70%)
    _create_context_state 75

    run orchestrator_should_pause
    [[ "$status" -eq 1 ]]  # Warning level

    # Should have fallen back to defaults
    local warning_threshold critical_threshold
    warning_threshold=$(echo "$output" | jq -r '.result.warningThreshold')
    critical_threshold=$(echo "$output" | jq -r '.result.criticalThreshold')

    [[ "$warning_threshold" == "70" ]]
    [[ "$critical_threshold" == "80" ]]
}

@test "threshold fallback to defaults when values are non-numeric" {
    # Set non-numeric thresholds
    jq '.orchestrator = {
        "contextThresholds": {
            "warning": "high",
            "critical": "very-high"
        }
    }' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Reset the cached thresholds (triggers re-initialization on next call)
    ORCHESTRATOR_CONTEXT_WARNING=""
    ORCHESTRATOR_CONTEXT_CRITICAL=""

    _create_context_state 75

    run orchestrator_should_pause
    [[ "$status" -eq 1 ]]  # Should use default warning of 70%

    # Should have fallen back to defaults
    local warning_threshold
    warning_threshold=$(echo "$output" | jq -r '.result.warningThreshold')
    [[ "$warning_threshold" == "70" ]]
}

@test "get_orchestrator_warning_threshold returns configured value" {
    _set_orchestrator_thresholds 65 85

    # Reset cached values
    ORCHESTRATOR_CONTEXT_WARNING=""
    ORCHESTRATOR_CONTEXT_CRITICAL=""

    local threshold
    threshold=$(get_orchestrator_warning_threshold)
    [[ "$threshold" == "65" ]]
}

@test "get_orchestrator_critical_threshold returns configured value" {
    _set_orchestrator_thresholds 60 90

    # Reset cached values
    ORCHESTRATOR_CONTEXT_WARNING=""
    ORCHESTRATOR_CONTEXT_CRITICAL=""

    local threshold
    threshold=$(get_orchestrator_critical_threshold)
    [[ "$threshold" == "90" ]]
}

@test "orchestrator_pre_spawn_check uses config-driven thresholds" {
    _create_context_state 72
    _set_orchestrator_thresholds 75 85  # Custom: 75% warning, 85% critical

    # Reset cached values
    ORCHESTRATOR_CONTEXT_WARNING=""
    ORCHESTRATOR_CONTEXT_CRITICAL=""

    run orchestrator_pre_spawn_check
    assert_success  # 72% is below warning threshold of 75%

    local spawn_status warning_threshold
    spawn_status=$(echo "$output" | jq -r '.result.spawnStatus')
    warning_threshold=$(echo "$output" | jq -r '.result.context.warningThreshold')

    [[ "$spawn_status" == "ok" ]]
    [[ "$warning_threshold" == "75" ]]
}

@test "orchestrator_context_check uses config-driven thresholds" {
    # Set custom thresholds
    _set_orchestrator_thresholds 60 75

    # Reset cached values
    ORCHESTRATOR_CONTEXT_WARNING=""
    ORCHESTRATOR_CONTEXT_CRITICAL=""

    # 65% of 10000 = 6500 tokens
    run orchestrator_context_check 6500
    [[ "$status" -eq 0 ]]  # Not critical (75%)

    local status_field warning_threshold critical_threshold
    status_field=$(echo "$output" | jq -r '.result.status')
    warning_threshold=$(echo "$output" | jq -r '.result.warningThreshold')
    critical_threshold=$(echo "$output" | jq -r '.result.criticalThreshold')

    [[ "$status_field" == "warning" ]]  # 65% exceeds 60% warning
    [[ "$warning_threshold" == "60" ]]
    [[ "$critical_threshold" == "75" ]]
}

# =============================================================================
# HITL Summary Validation Tests (T2384)
# =============================================================================

@test "generate_hitl_summary handoff includes proper resume instructions" {
    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    cat > "$todo_file" << 'EOF'
{
  "_meta": { "schemaVersion": "2.6.0" },
  "tasks": [
    {"id": "T001", "title": "Epic", "status": "active", "type": "epic"},
    {"id": "T002", "title": "Task 1", "status": "done", "parentId": "T001"},
    {"id": "T003", "title": "Task 2", "status": "pending", "parentId": "T001"}
  ]
}
EOF

    run generate_hitl_summary "T001" "context-limit"
    assert_success

    # Check handoff structure
    local next_steps_count
    next_steps_count=$(echo "$output" | jq -r '.result.handoff.nextSteps | length')
    [[ "$next_steps_count" -ge 3 ]]

    # Should include resume command
    local has_resume_cmd
    has_resume_cmd=$(echo "$output" | jq -r '.result.handoff.nextSteps[0] | contains("session")')
    [[ "$has_resume_cmd" == "true" ]]

    # Should include list command
    local has_list_cmd
    has_list_cmd=$(echo "$output" | jq -r '.result.handoff.nextSteps[1] | contains("list")')
    [[ "$has_list_cmd" == "true" ]]

    # Should include dash command
    local has_dash_cmd
    has_dash_cmd=$(echo "$output" | jq -r '.result.handoff.nextSteps[2] | contains("dash")')
    [[ "$has_dash_cmd" == "true" ]]
}

@test "generate_hitl_summary includes readyToSpawn list for next agent" {
    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    cat > "$todo_file" << 'EOF'
{
  "_meta": { "schemaVersion": "2.6.0" },
  "tasks": [
    {"id": "T001", "title": "Epic", "status": "active", "type": "epic"},
    {"id": "T002", "title": "First Task", "status": "done", "parentId": "T001"},
    {"id": "T003", "title": "Second Task", "status": "pending", "parentId": "T001", "priority": "high"},
    {"id": "T004", "title": "Third Task", "status": "pending", "parentId": "T001", "depends": ["T003"]}
  ]
}
EOF

    run generate_hitl_summary "T001"
    assert_success

    # T003 should be ready (no unmet deps)
    local ready_count first_ready
    ready_count=$(echo "$output" | jq -r '.result.readyToSpawn | length')
    [[ "$ready_count" -ge 1 ]]

    first_ready=$(echo "$output" | jq -r '.result.readyToSpawn[0].id')
    [[ "$first_ready" == "T003" ]]
}

@test "orchestrator_auto_stop includes session resume command in output" {
    _set_orchestrator_thresholds 70 80

    # Create a session file to simulate active session
    local sessions_file="${TEST_TEMP_DIR}/.cleo/sessions.json"
    cat > "$sessions_file" << 'EOF'
{
  "sessions": [
    {"id": "session_test_12345", "status": "active", "scope": {"rootId": "T001"}}
  ]
}
EOF
    echo -n "session_test_12345" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    cat > "$todo_file" << 'EOF'
{
  "_meta": { "schemaVersion": "2.6.0" },
  "tasks": []
}
EOF

    run orchestrator_auto_stop "T001"
    assert_success

    local resume_cmd
    resume_cmd=$(echo "$output" | jq -r '.result.resumeCommand')
    [[ "$resume_cmd" == *"session_test_12345"* ]]
}

# =============================================================================
# Session Pause and Resume Flow Tests (T2384)
# =============================================================================

@test "orchestrator_check_and_stop action is 'stopped' at critical threshold" {
    _create_context_state 90
    _set_orchestrator_thresholds 70 80

    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    cat > "$todo_file" << 'EOF'
{
  "_meta": { "schemaVersion": "2.6.0" },
  "tasks": [
    {"id": "T001", "title": "Epic", "status": "active", "type": "epic"}
  ]
}
EOF

    run orchestrator_check_and_stop "T001"
    [[ "$status" -eq 2 ]]

    local action stopped
    action=$(echo "$output" | jq -r '.result.action')
    stopped=$(echo "$output" | jq -r '.result.autoStop.stopped')

    [[ "$action" == "stopped" ]]
    [[ "$stopped" == "true" ]]
}

@test "orchestrator_check_and_stop action is 'continue' at warning threshold" {
    _create_context_state 75
    _set_orchestrator_thresholds 70 80

    run orchestrator_check_and_stop
    assert_success  # Returns 0 for continue

    local action should_wrap_up
    action=$(echo "$output" | jq -r '.result.action')
    should_wrap_up=$(echo "$output" | jq -r '.result.pauseCheck.shouldWrapUp')

    [[ "$action" == "continue" ]]
    [[ "$should_wrap_up" == "true" ]]
}

@test "orchestrator_check_and_stop respects autoStopOnCritical=false" {
    _create_context_state 90
    _set_orchestrator_thresholds 70 80

    # Disable auto-stop
    jq '.orchestrator.autoStopOnCritical = false' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    cat > "$todo_file" << 'EOF'
{
  "_meta": { "schemaVersion": "2.6.0" },
  "tasks": []
}
EOF

    run orchestrator_check_and_stop
    # Still returns exit 2 for critical, but auto_stop.stopped should be false
    [[ "$status" -eq 2 ]]

    local stopped
    stopped=$(echo "$output" | jq -r '.result.autoStop.stopped')
    [[ "$stopped" == "false" ]]
}
