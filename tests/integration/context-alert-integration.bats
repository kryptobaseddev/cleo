#!/usr/bin/env bats
# =============================================================================
# context-alert-integration.bats - End-to-end tests for context alerts
# =============================================================================
# Tests for:
# - Context alerts integrated into cleo commands
# - Alert output ordering (stderr before stdout JSON)
# - Real-world command scenarios with threshold crossings
# - Multi-session context state handling
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file

    export CONTEXT_ALERT_LIB="${LIB_DIR}/session/context-alert.sh"
    export OUTPUT_FORMAT_LIB="${LIB_DIR}/core/output-format.sh"
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    common_setup_per_test

    # Create empty todo file
    create_empty_todo "$TODO_FILE"

    # Override CLEO_PROJECT_DIR to point to test directory
    export CLEO_PROJECT_DIR="${TEST_TEMP_DIR}/.cleo"

    # Create a test session
    export TEST_SESSION_ID="session_test_integration"
    mkdir -p "${CLEO_PROJECT_DIR}"
    echo -n "$TEST_SESSION_ID" > "${CLEO_PROJECT_DIR}/.current-session"

    # Set up state file paths
    export CONTEXT_STATE_FILE="${CLEO_PROJECT_DIR}/.context-state-${TEST_SESSION_ID}.json"
    export ALERT_STATE_FILE="${CLEO_PROJECT_DIR}/.context-alert-state.json"

    # Enable context alerts
    _enable_context_alerts

    # These tests check JSON output structure
    export CLEO_FORMAT="json"
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
    local current_tokens="${2:-52167}"
    local max_tokens="${3:-200000}"
    local timestamp="${4:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

    cat > "$CONTEXT_STATE_FILE" << EOF
{
  "timestamp": "$timestamp",
  "contextWindow": {
    "percentage": $percentage,
    "currentTokens": $current_tokens,
    "maxTokens": $max_tokens
  },
  "staleAfterMs": 5000
}
EOF
}

_create_alert_state() {
    local last_alerted_pct="$1"
    local threshold_level="$2"
    local timestamp="${3:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

    cat > "$ALERT_STATE_FILE" << EOF
{
  "lastAlertedLevel": $last_alerted_pct,
  "thresholdLevel": "$threshold_level",
  "lastAlertedAt": "$timestamp"
}
EOF
}

_enable_context_alerts() {
    jq '.contextAlerts = {
        "enabled": true,
        "minThreshold": "warning",
        "suppressDuration": 0,
        "triggerCommands": []
    }' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
}

_add_test_task() {
    local title="${1:-Test task}"
    bash "$ADD_SCRIPT" "$title" --description "Test description"
}

# =============================================================================
# Integration Tests - cleo complete
# =============================================================================

@test "cleo complete triggers context alert when threshold crossed" {
    # Add a task to complete
    _add_test_task "Task to complete"
    local task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")

    # Set up context state at warning level (first crossing)
    _create_context_state 72

    # Complete the task - should trigger alert
    run bash "$COMPLETE_SCRIPT" "$task_id" --notes "Test" --notes "Test completion"
    assert_success

    # Should contain JSON output in stdout
    echo "$output" | grep -oE '\{.*\}' | tail -1 | jq -e '.success == true' >/dev/null

    # Alert state should be created
    assert_file_exist "$ALERT_STATE_FILE"
    run jq -r '.thresholdLevel' "$ALERT_STATE_FILE"
    assert_success
    assert_output "warning"
}

@test "cleo complete does not alert when threshold unchanged" {
    # Add a task to complete
    _add_test_task "Task to complete"
    local task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")

    # Set up context state at warning level
    _create_context_state 75
    # Set previous alert at warning level
    _create_alert_state 72 "warning"

    # Complete the task - should NOT trigger alert
    run bash "$COMPLETE_SCRIPT" "$task_id" --notes "Test"
    assert_success

    # Should contain JSON output
    echo "$output" | grep -oE '\{.*\}' | tail -1 | jq -e '.success == true' >/dev/null

    # Alert state should remain at warning
    run jq -r '.thresholdLevel' "$ALERT_STATE_FILE"
    assert_success
    assert_output "warning"
}

@test "cleo complete alert appears before JSON output" {
    # Add a task to complete
    _add_test_task "Task to complete"
    local task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")

    # Set up context state at critical level (will trigger alert)
    _create_context_state 92
    _create_alert_state 87 "caution"

    # Run complete and capture both stdout and stderr
    run bash "$COMPLETE_SCRIPT" "$task_id" --notes "Test" 2>&1
    assert_success

    # Output should contain both alert (from stderr) and JSON (from stdout)
    # Alert indicators should appear before JSON
    echo "$output" | grep -oE '\{.*\}' | tail -1 | jq -e '.success == true' >/dev/null
}

# =============================================================================
# Integration Tests - cleo update
# =============================================================================

@test "cleo update triggers context alert when threshold crossed" {
    # Add a task to update
    _add_test_task "Task to update"
    local task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")

    # Set up context state at caution level
    _create_context_state 87
    _create_alert_state 72 "warning"

    # Update the task - should trigger alert
    run bash "$UPDATE_SCRIPT" "$task_id" --priority high
    assert_success

    # Should contain JSON output
    echo "$output" | grep -oE '\{.*\}' | tail -1 | jq -e '.success == true' >/dev/null

    # Alert state should be updated to caution
    run jq -r '.thresholdLevel' "$ALERT_STATE_FILE"
    assert_success
    assert_output "caution"
}

# =============================================================================
# Integration Tests - cleo add
# =============================================================================

@test "cleo add triggers context alert when threshold crossed" {
    # Set up context state at emergency level
    _create_context_state 96
    _create_alert_state 92 "critical"

    # Add a task - should trigger alert
    run bash "$ADD_SCRIPT" "New task" --description "New description"
    assert_success

    # Should contain JSON output
    echo "$output" | grep -oE '\{.*\}' | tail -1 | jq -e '.success == true' >/dev/null

    # Alert state should be updated to emergency
    run jq -r '.thresholdLevel' "$ALERT_STATE_FILE"
    assert_success
    assert_output "emergency"
}

# =============================================================================
# Integration Tests - Multi-Session Context State
# =============================================================================

@test "context alerts use session-specific state file" {
    # Set up context state for test session
    _create_context_state 75

    # Verify the state file is session-specific
    assert_file_exist "$CONTEXT_STATE_FILE"
    assert_file_exist "${CLEO_PROJECT_DIR}/.context-state-${TEST_SESSION_ID}.json"

    # Complete a task - should read from session-specific file
    _add_test_task "Test task"
    local task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")

    run bash "$COMPLETE_SCRIPT" "$task_id" --notes "Test"
    assert_success
}

@test "context alerts handle missing session gracefully" {
    # Remove session file
    rm -f "${CLEO_PROJECT_DIR}/.current-session"

    # Set up context state (but no session active)
    _create_context_state 75

    # Add a task - should not trigger alert (no active session)
    run bash "$ADD_SCRIPT" "Test task" --description "Test description"
    assert_success

    # No alert state should be created
    assert_file_not_exist "$ALERT_STATE_FILE"
}

# =============================================================================
# Integration Tests - Disabled Alerts
# =============================================================================

@test "commands work normally when context alerts disabled" {
    # Disable alerts
    jq '.contextAlerts.enabled = false' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Set up context state at critical level
    _create_context_state 92

    # Add a task - should NOT trigger alert
    run bash "$ADD_SCRIPT" "Test task" --description "Test description"
    assert_success

    # No alert state should be created
    assert_file_not_exist "$ALERT_STATE_FILE"
}

# =============================================================================
# Integration Tests - Command Filtering
# =============================================================================

@test "context alerts respect triggerCommands configuration" {
    # Only trigger for complete and update
    jq '.contextAlerts.triggerCommands = ["complete", "update"]' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Set up context state
    _create_context_state 72

    # Add task should NOT trigger (not in list)
    run bash "$ADD_SCRIPT" "Test task" --description "Test description"
    assert_success
    assert_file_not_exist "$ALERT_STATE_FILE"

    # Complete SHOULD trigger (in list)
    local task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")
    run bash "$COMPLETE_SCRIPT" "$task_id" --notes "Test"
    assert_success
    assert_file_exist "$ALERT_STATE_FILE"
}

# =============================================================================
# Integration Tests - Alert Levels and Actions
# =============================================================================

@test "warning level alert contains appropriate message" {
    _add_test_task "Test task"
    local task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")

    _create_context_state 72

    # Capture stderr
    bash "$COMPLETE_SCRIPT" "$task_id" --notes "Test" 2>&1 | grep -q "WARNING"
}

@test "caution level alert contains appropriate message" {
    _add_test_task "Test task"
    local task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")

    _create_context_state 87
    _create_alert_state 72 "warning"

    # Capture stderr
    bash "$COMPLETE_SCRIPT" "$task_id" --notes "Test" 2>&1 | grep -q "CAUTION"
}

@test "critical level alert contains recommended action" {
    _add_test_task "Test task"
    local task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")

    _create_context_state 92
    _create_alert_state 87 "caution"

    # Capture stderr - should contain recommended action
    bash "$COMPLETE_SCRIPT" "$task_id" --notes "Test" 2>&1 | grep -q "Recommended"
}

@test "emergency level alert contains immediate action" {
    _add_test_task "Test task"
    local task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")

    _create_context_state 96
    _create_alert_state 92 "critical"

    # Capture stderr - should contain immediate action
    bash "$COMPLETE_SCRIPT" "$task_id" --notes "Test" 2>&1 | grep -q "IMMEDIATE"
}

# =============================================================================
# Integration Tests - Stale State Handling
# =============================================================================

@test "context alerts skip when state file is stale" {
    # Create stale context state (10 seconds old, staleAfterMs=5000)
    local old_timestamp
    old_timestamp=$(date -u -d '10 seconds ago' +%Y-%m-%dT%H:%M:%SZ)
    _create_context_state 92 184000 200000 "$old_timestamp"

    # Add a task - should NOT trigger alert (stale state)
    run bash "$ADD_SCRIPT" "Test task" --description "Test description"
    assert_success

    # No alert state should be created
    assert_file_not_exist "$ALERT_STATE_FILE"
}

# =============================================================================
# Integration Tests - Real-World Scenarios
# =============================================================================

@test "progressive alerts as context window fills" {
    _add_test_task "Task 1"

    # First: cross warning threshold
    _create_context_state 72
    bash "$COMPLETE_SCRIPT" "T001"  --notes "Test" 2>&1 | grep -q "WARNING"

    # Second: stay in warning (no alert)
    _add_test_task "Task 2"
    _create_context_state 75
    bash "$COMPLETE_SCRIPT" "T002"  --notes "Test" 2>&1 | grep -qv "WARNING"

    # Third: cross to caution
    _add_test_task "Task 3"
    _create_context_state 87
    bash "$COMPLETE_SCRIPT" "T003"  --notes "Test" 2>&1 | grep -q "CAUTION"

    # Fourth: cross to critical
    _add_test_task "Task 4"
    _create_context_state 92
    bash "$COMPLETE_SCRIPT" "T004"  --notes "Test" 2>&1 | grep -q "CRITICAL"

    # Fifth: cross to emergency
    _add_test_task "Task 5"
    _create_context_state 96
    bash "$COMPLETE_SCRIPT" "T005"  --notes "Test" 2>&1 | grep -q "EMERGENCY"
}

@test "alerts work across multiple commands in session" {
    # Start with warning
    _create_context_state 72
    run bash "$ADD_SCRIPT" "Task 1" --description "Description 1"
    assert_success
    assert_file_exist "$ALERT_STATE_FILE"

    # Update state to caution
    _create_context_state 87
    run bash "$ADD_SCRIPT" "Task 2" --description "Description 2"
    assert_success

    # Verify state progression
    run jq -r '.thresholdLevel' "$ALERT_STATE_FILE"
    assert_success
    assert_output "caution"
}
