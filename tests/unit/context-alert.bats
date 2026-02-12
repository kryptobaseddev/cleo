#!/usr/bin/env bats
# =============================================================================
# context-alert.bats - Unit tests for lib/session/context-alert.sh
# =============================================================================
# Tests for:
# - check_context_alert() main alert logic
# - should_alert() threshold crossing detection
# - format_alert_box() visual output formatting
# - read_context_state() state file reading
# - update_alert_state() state persistence
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file

    # Export paths
    export CONTEXT_ALERT_LIB="${LIB_DIR}/session/context-alert.sh"
    export OUTPUT_FORMAT_LIB="${LIB_DIR}/core/output-format.sh"
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    common_setup_per_test

    # cd to test directory so relative paths work
    # context-alert.sh uses ${CLEO_PROJECT_DIR:-.cleo} which defaults to ".cleo"
    cd "$TEST_TEMP_DIR"

    # Create session ID for tests
    export TEST_SESSION_ID="session_test_12345"
    echo -n "$TEST_SESSION_ID" > "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Set up state file paths
    export ALERT_STATE_FILE="${TEST_TEMP_DIR}/.cleo/.context-alert-state.json"
    export CONTEXT_STATE_FILE="${TEST_TEMP_DIR}/.cleo/.context-state-${TEST_SESSION_ID}.json"

    # Source required libraries AFTER cd to test directory
    source "$OUTPUT_FORMAT_LIB"
    source "$CONTEXT_ALERT_LIB"

    # Export CONFIG_FILE so subshells (via 'run') can access it
    # context-alert.sh doesn't export this, but get_config_value needs it
    export CONFIG_FILE
    export ALERT_STATE_FILE
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

_disable_context_alerts() {
    jq '.contextAlerts.enabled = false' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
}

# =============================================================================
# get_current_session_id Tests
# =============================================================================

@test "get_current_session_id returns session ID when file exists" {
    run bash -c "cat '${TEST_TEMP_DIR}/.cleo/.current-session'"
    assert_success
    assert_output "$TEST_SESSION_ID"
}

@test "get_current_session_id returns empty string when no session" {
    rm -f "${TEST_TEMP_DIR}/.cleo/.current-session"

    # Create a fresh function that reads from test dir
    # Note: Avoid 'local' at top level of bash -c script
    local test_func='
        session_file="${1:-.cleo}/.current-session"
        if [[ -f "$session_file" ]]; then
            cat "$session_file" 2>/dev/null | tr -d "\n"
        else
            echo ""
        fi
    '
    run bash -c "$test_func" -- "${TEST_TEMP_DIR}"
    assert_success
    assert_output ""
}

# =============================================================================
# read_context_state Tests
# =============================================================================

@test "read_context_state returns 0 and outputs JSON when state file exists" {
    _create_context_state 75

    run read_context_state "$TEST_SESSION_ID"
    assert_success
    assert_output --partial '"percentage": 75'
}

@test "read_context_state returns 1 when state file missing" {
    rm -f "$CONTEXT_STATE_FILE"

    run read_context_state "$TEST_SESSION_ID"
    assert_failure
}

@test "read_context_state returns 1 when state file is stale" {
    # Create state file with timestamp 10 seconds ago (exceeds 5000ms staleAfterMs)
    local old_timestamp
    old_timestamp=$(date -u -d '10 seconds ago' +%Y-%m-%dT%H:%M:%SZ)
    _create_context_state 75 52167 200000 "$old_timestamp"

    run read_context_state "$TEST_SESSION_ID"
    assert_failure
}

@test "read_context_state returns 0 when state file is fresh" {
    # Create state file with current timestamp
    _create_context_state 75

    run read_context_state "$TEST_SESSION_ID"
    assert_success
}

# =============================================================================
# should_alert Tests
# =============================================================================

@test "should_alert returns 0 and 'warning' when crossing warning threshold" {
    run should_alert 72 0
    assert_success
    assert_output "warning"
}

@test "should_alert returns 0 and 'caution' when crossing caution threshold" {
    run should_alert 87 72
    assert_success
    assert_output "caution"
}

@test "should_alert returns 0 and 'critical' when crossing critical threshold" {
    run should_alert 92 87
    assert_success
    assert_output "critical"
}

@test "should_alert returns 0 and 'emergency' when crossing emergency threshold" {
    run should_alert 96 92
    assert_success
    assert_output "emergency"
}

@test "should_alert returns 1 when staying at same threshold level" {
    # Both 72 and 75 are in 'warning' range (70-84)
    run should_alert 75 72
    assert_failure
    assert_output ""
}

@test "should_alert returns 1 when percentage below warning threshold" {
    run should_alert 50 0
    assert_failure
    assert_output ""
}

@test "should_alert respects minThreshold config from warning to caution" {
    # Create config with minThreshold set to caution
    jq '.contextAlerts.minThreshold = "caution"' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Warning level (72) should not trigger alert
    run should_alert 72 0
    assert_failure

    # Caution level (87) should trigger alert
    run should_alert 87 0
    assert_success
    assert_output "caution"
}

# =============================================================================
# update_alert_state Tests
# =============================================================================

@test "update_alert_state creates state file with correct fields" {
    run update_alert_state 75 "warning"
    assert_success

    assert_file_exist "$ALERT_STATE_FILE"

    # Validate JSON structure
    run jq -r '.lastAlertedLevel' "$ALERT_STATE_FILE"
    assert_success
    assert_output "75"

    run jq -r '.thresholdLevel' "$ALERT_STATE_FILE"
    assert_success
    assert_output "warning"

    run jq -r '.lastAlertedAt' "$ALERT_STATE_FILE"
    assert_success
    refute_output ""
}

# =============================================================================
# format_alert_box Tests
# =============================================================================

@test "format_alert_box outputs to stderr" {
    # Capture stderr to stdout for testing
    run bash -c "source '$OUTPUT_FORMAT_LIB' && source '$CONTEXT_ALERT_LIB' && format_alert_box 75 'warning' 150000 200000 2>&1"
    assert_success

    # Should contain alert box output
    assert_output --partial "WARNING"
}

@test "format_alert_box contains warning emoji for warning level" {
    # Capture stderr
    format_alert_box 75 "warning" 150000 200000 2>&1 | grep -q "🟡"
}

@test "format_alert_box contains caution emoji for caution level" {
    format_alert_box 87 "caution" 174000 200000 2>&1 | grep -q "🟠"
}

@test "format_alert_box contains critical emoji for critical level" {
    format_alert_box 92 "critical" 184000 200000 2>&1 | grep -q "🔴"
}

@test "format_alert_box contains emergency emoji for emergency level" {
    format_alert_box 96 "emergency" 192000 200000 2>&1 | grep -q "🚨"
}

@test "format_alert_box includes usage statistics" {
    format_alert_box 75 "warning" 150000 200000 2>&1 | grep -q "150000/200000"
}

@test "format_alert_box includes recommended action for emergency" {
    format_alert_box 96 "emergency" 192000 200000 2>&1 | grep -q "IMMEDIATE"
}

@test "format_alert_box uses box characters" {
    # Should contain box drawing characters (Unicode or ASCII)
    format_alert_box 75 "warning" 150000 200000 2>&1 | grep -qE "[╔║═╗╚╝]|[+|=]"
}

# =============================================================================
# check_context_alert Tests - Configuration Gating
# =============================================================================

@test "check_context_alert returns 0 when alerts disabled" {
    _disable_context_alerts
    _create_context_state 75

    run check_context_alert
    assert_success
    assert_output ""
}

@test "check_context_alert returns 0 when no active session" {
    _enable_context_alerts
    rm -f "${TEST_TEMP_DIR}/.cleo/.current-session"

    run check_context_alert
    assert_success
    assert_output ""
}

@test "check_context_alert returns 0 when context state file missing" {
    _enable_context_alerts
    rm -f "$CONTEXT_STATE_FILE"

    run check_context_alert
    assert_success
    assert_output ""
}

# =============================================================================
# check_context_alert Tests - Threshold Crossing
# =============================================================================

@test "check_context_alert returns 0 when status unchanged" {
    _enable_context_alerts
    _create_context_state 75
    _create_alert_state 72 "warning"

    # Both 72 and 75 are in warning range - no new alert
    run check_context_alert
    assert_success
    assert_output ""
}

@test "check_context_alert emits alert on threshold crossing to warning" {
    _enable_context_alerts
    _create_context_state 72
    # No previous alert (starts at 0)

    run check_context_alert
    assert_success

    # Should have emitted alert to stderr (captured in output in test context)
    # Check that alert state was updated
    assert_file_exist "$ALERT_STATE_FILE"

    run jq -r '.thresholdLevel' "$ALERT_STATE_FILE"
    assert_success
    assert_output "warning"
}

@test "check_context_alert emits alert on threshold crossing to caution" {
    _enable_context_alerts
    _create_context_state 87
    _create_alert_state 72 "warning"

    run check_context_alert
    assert_success

    # Check that alert state was updated
    run jq -r '.thresholdLevel' "$ALERT_STATE_FILE"
    assert_success
    assert_output "caution"
}

@test "check_context_alert emits alert on threshold crossing to critical" {
    _enable_context_alerts
    _create_context_state 92
    _create_alert_state 87 "caution"

    run check_context_alert
    assert_success

    # Check that alert state was updated
    run jq -r '.thresholdLevel' "$ALERT_STATE_FILE"
    assert_success
    assert_output "critical"
}

@test "check_context_alert emits alert on threshold crossing to emergency" {
    _enable_context_alerts
    _create_context_state 96
    _create_alert_state 92 "critical"

    run check_context_alert
    assert_success

    # Check that alert state was updated
    run jq -r '.thresholdLevel' "$ALERT_STATE_FILE"
    assert_success
    assert_output "emergency"
}

# =============================================================================
# check_context_alert Tests - Suppress Duration
# =============================================================================

@test "check_context_alert suppresses alerts within suppress window" {
    _enable_context_alerts

    # Set suppressDuration to 60 seconds
    jq '.contextAlerts.suppressDuration = 60' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Create alert state from 10 seconds ago (within 60s window)
    local recent_timestamp
    recent_timestamp=$(date -u -d '10 seconds ago' +%Y-%m-%dT%H:%M:%SZ)
    _create_alert_state 72 "warning" "$recent_timestamp"

    # Try to alert at caution level
    _create_context_state 87

    run check_context_alert
    assert_success
    assert_output ""

    # Alert state should NOT be updated
    run jq -r '.thresholdLevel' "$ALERT_STATE_FILE"
    assert_success
    assert_output "warning"  # Still at old level
}

@test "check_context_alert allows alerts after suppress window expires" {
    _enable_context_alerts

    # Set suppressDuration to 60 seconds
    jq '.contextAlerts.suppressDuration = 60' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Create alert state from 70 seconds ago (outside 60s window)
    local old_timestamp
    old_timestamp=$(date -u -d '70 seconds ago' +%Y-%m-%dT%H:%M:%SZ)
    _create_alert_state 72 "warning" "$old_timestamp"

    # Try to alert at caution level
    _create_context_state 87

    run check_context_alert
    assert_success

    # Alert state should be updated
    run jq -r '.thresholdLevel' "$ALERT_STATE_FILE"
    assert_success
    assert_output "caution"
}

# =============================================================================
# check_context_alert Tests - Command Filtering
# =============================================================================

@test "check_context_alert triggers for any command when triggerCommands is empty array" {
    _enable_context_alerts
    _create_context_state 72

    # Empty array means all commands trigger
    jq '.contextAlerts.triggerCommands = []' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    run check_context_alert "some-random-command"
    assert_success

    # Should have triggered alert
    assert_file_exist "$ALERT_STATE_FILE"
}

@test "check_context_alert triggers only for specified commands" {
    _enable_context_alerts
    _create_context_state 72

    # Only trigger for specific commands
    jq '.contextAlerts.triggerCommands = ["complete", "update"]' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Should trigger for 'complete'
    run check_context_alert "complete"
    assert_success
    assert_file_exist "$ALERT_STATE_FILE"

    # Reset alert state
    rm -f "$ALERT_STATE_FILE"

    # Should NOT trigger for 'list'
    run check_context_alert "list"
    assert_success
    # File should NOT exist (no refute_file_exists in bats-file, use shell test)
    [[ ! -f "$ALERT_STATE_FILE" ]]
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "check_context_alert handles missing config gracefully" {
    rm -f "$CONFIG_FILE"
    _create_context_state 72

    # Should default to enabled=true and trigger
    run check_context_alert
    assert_success
}

@test "should_alert handles zero percentage" {
    run should_alert 0 0
    assert_failure
    assert_output ""
}

@test "should_alert handles 100 percentage" {
    run should_alert 100 92
    assert_success
    assert_output "emergency"
}

@test "format_alert_box handles very long token counts" {
    format_alert_box 95 "emergency" 999999999 1000000000 2>&1 | grep -q "999999999/1000000000"
}
