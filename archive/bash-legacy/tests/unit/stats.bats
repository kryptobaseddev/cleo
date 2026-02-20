#!/usr/bin/env bats
# =============================================================================
# stats.bats - Unit tests for stats.sh (statistics and reporting)
# =============================================================================
# Tests statistics generation, period analysis, and output formats.
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

    # Set STATS_SCRIPT path
    export STATS_SCRIPT="${SCRIPTS_DIR}/stats.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# Helper to create log with activity
create_log_with_activity() {
    local log_file="${1:-$LOG_FILE}"
    cat > "$log_file" << 'EOF'
{
  "_meta": {"version": "2.1.0"},
  "entries": [
    {
      "timestamp": "2025-12-01T10:00:00Z",
      "operation": "create",
      "task_id": "T001",
      "details": {}
    },
    {
      "timestamp": "2025-12-01T11:00:00Z",
      "operation": "create",
      "task_id": "T002",
      "details": {}
    },
    {
      "timestamp": "2025-12-02T12:00:00Z",
      "operation": "complete",
      "task_id": "T001",
      "details": {}
    }
  ]
}
EOF
}

# =============================================================================
# Help and Basic Command Tests
# =============================================================================

@test "stats --help shows usage" {
    create_empty_todo
    run bash "$STATS_SCRIPT" --help
    assert_success
    assert_output --partial "Usage:"
    assert_output --partial "cleo stats"
}

@test "stats -h shows usage" {
    create_empty_todo
    run bash "$STATS_SCRIPT" -h
    assert_success
    assert_output --partial "Usage:"
}

@test "stats without options shows default statistics" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    refute_output ""
}

# =============================================================================
# Basic Statistics Output Tests
# =============================================================================

@test "stats displays current state section" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "CURRENT STATE"
}

@test "stats displays completion metrics section" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "COMPLETION METRICS"
}

@test "stats displays activity metrics section" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "ACTIVITY METRICS"
}

@test "stats displays archive statistics section" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "ARCHIVE"
}

@test "stats displays all-time statistics section" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "ALL-TIME"
}

# =============================================================================
# Current State Tests
# =============================================================================

@test "stats shows pending task count" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "Pending:"
}

@test "stats shows in progress task count" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "In Progress:"
}

@test "stats shows completed task count" {
    create_tasks_with_completed
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "Completed:"
}

@test "stats shows total active tasks" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "Total Active:"
}

# =============================================================================
# Period Option Tests
# =============================================================================

@test "stats --period 7 uses 7-day period" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" --period 7
    assert_success
    assert_output_contains_any "7 days" "Last 7"
}

@test "stats -p 14 uses 14-day period" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" -p 14
    assert_success
    assert_output_contains_any "14 days" "Last 14"
}

@test "stats --period 30 shows 30-day metrics (default)" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" --period 30
    assert_success
    assert_output_contains_any "30 days" "Last 30"
}

@test "stats --period invalid shows error" {
    create_independent_tasks
    run bash "$STATS_SCRIPT" --period abc
    assert_failure
    assert_output --partial "ERROR"
}

# =============================================================================
# JSON Output Format Tests
# =============================================================================

@test "stats --format json produces valid JSON" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" --format json
    assert_success
    assert_valid_json
}

@test "stats -f json produces valid JSON" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" -f json
    assert_success
    assert_valid_json
}

@test "stats JSON output has _meta.format field" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" --format json
    assert_success
    assert_json_has_key "_meta"
    run jq -e '._meta.format == "json"' <<< "$output"
    assert_success
}

@test "stats JSON output has data object" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" --format json
    assert_success
    assert_json_has_key "data"
}

@test "stats JSON output has current_state" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" --format json
    assert_success
    run jq -e '.data.current_state' <<< "$output"
    assert_success
}

@test "stats JSON output has completion_metrics" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" --format json
    assert_success
    run jq -e '.data.completion_metrics' <<< "$output"
    assert_success
}

@test "stats JSON output has activity_metrics" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" --format json
    assert_success
    run jq -e '.data.activity_metrics' <<< "$output"
    assert_success
}

@test "stats JSON output has archive_stats" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" --format json
    assert_success
    run jq -e '.data.archive_stats' <<< "$output"
    assert_success
}

@test "stats JSON output has all_time" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" --format json
    assert_success
    run jq -e '.data.all_time' <<< "$output"
    assert_success
}

# =============================================================================
# NO_COLOR Compliance Tests
# =============================================================================

@test "stats respects NO_COLOR environment variable" {
    create_independent_tasks
    create_log_with_activity
    NO_COLOR=1 run bash "$STATS_SCRIPT"
    assert_success
    # Should not contain ANSI escape sequences
    refute_output --regexp '\033\[[0-9;]*m'
}

@test "stats shows ASCII icons when NO_COLOR is set" {
    create_independent_tasks
    create_log_with_activity
    NO_COLOR=1 run bash "$STATS_SCRIPT"
    assert_success
    # Should show [STATS] instead of emoji
    assert_output_contains_any "[STATS]" "[STATUS]"
}

# =============================================================================
# Unicode Support Tests
# =============================================================================

@test "stats shows Unicode icons by default" {
    create_independent_tasks
    create_log_with_activity
    unset NO_COLOR
    LANG=en_US.UTF-8 run bash "$STATS_SCRIPT"
    assert_success
    # Should contain emoji or Unicode characters
    refute_output ""
}

@test "stats respects unicodeEnabled config" {
    create_independent_tasks
    create_log_with_activity
    # Set unicodeEnabled to false in config
    cat > "$CONFIG_FILE" << 'EOF'
{
  "version": "2.1.0",
  "output": {
    "unicodeEnabled": false
  },
  "validation": {
    "strictMode": false,
    "requireDescription": false
  }
}
EOF
    run bash "$STATS_SCRIPT"
    assert_success
    # Should show ASCII icons
    assert_output_contains_any "[STATS]" "[STATUS]"
}

# =============================================================================
# Pluralization Tests
# =============================================================================

@test "stats shows '1 task' for count of 1" {
    create_empty_todo
    jq '.tasks = [{"id": "T001", "title": "Single", "description": "One", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T10:00:00Z"}]' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    create_log_with_activity

    run bash "$STATS_SCRIPT"
    assert_success
    # Should contain "1" somewhere in the output
    refute_output ""
}

@test "stats shows 'tasks' for count > 1" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "Tasks"
}

# =============================================================================
# Empty State Tests
# =============================================================================

@test "stats handles empty todo list" {
    create_empty_todo
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    refute_output ""
}

@test "stats handles missing log file" {
    create_independent_tasks
    rm -f "$LOG_FILE"
    run bash "$STATS_SCRIPT"
    assert_success
    # Should still show current state stats
    assert_output --partial "CURRENT STATE"
}

@test "stats --format json handles empty todo list" {
    create_empty_todo
    create_log_with_activity
    run bash "$STATS_SCRIPT" --format json
    assert_success
    assert_valid_json
    run jq -e '.data.current_state.total_active == 0' <<< "$output"
    assert_success
}

# =============================================================================
# Completion Metrics Tests
# =============================================================================

@test "stats shows completion rate" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "Completion Rate:"
}

@test "stats shows tasks completed in period" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "Tasks Completed:"
}

@test "stats shows tasks created in period" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "Tasks Created:"
}

@test "stats shows average completion time" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "Avg Time to Complete:"
}

# =============================================================================
# Activity Metrics Tests
# =============================================================================

@test "stats shows busiest day" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "Busiest Day:"
}

@test "stats shows tasks archived in period" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "Archived:"
}

# =============================================================================
# Error Handling Tests
# =============================================================================

@test "stats handles missing .cleo directory" {
    rm -rf .cleo
    run bash "$STATS_SCRIPT"
    assert_failure
    assert_output --partial "ERROR"
}

@test "stats handles invalid format option" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" --format invalid
    assert_failure
    assert_output --partial "ERROR"
}

@test "stats handles unknown option" {
    create_independent_tasks
    run bash "$STATS_SCRIPT" --unknown-option
    assert_failure
    assert_output --partial "ERROR"
}

# =============================================================================
# Timestamp Display Tests
# =============================================================================

@test "stats displays generation timestamp" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT"
    assert_success
    assert_output --partial "Generated:"
}

@test "stats JSON includes timestamp in _meta" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" --format json
    assert_success
    run jq -e '._meta.timestamp' <<< "$output"
    assert_success
}

# =============================================================================
# Calculation Accuracy Tests
# =============================================================================

@test "stats calculates total active tasks correctly" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" --format json
    assert_success
    # Should match number of tasks in todo.json
    local expected=$(jq '.tasks | length' "$TODO_FILE")
    local actual=$(echo "$output" | jq '.data.current_state.total_active')
    [[ "$actual" -eq "$expected" ]]
}

@test "stats calculates pending count correctly" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" --format json
    assert_success
    local expected=$(jq '[.tasks[] | select(.status == "pending")] | length' "$TODO_FILE")
    local actual=$(echo "$output" | jq '.data.current_state.pending')
    [[ "$actual" -eq "$expected" ]]
}

# =============================================================================
# Period Days in Output Tests
# =============================================================================

@test "stats JSON includes period_days in _meta" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" --period 14 --format json
    assert_success
    run jq -e '._meta.period_days == 14' <<< "$output"
    assert_success
}

@test "stats text output shows correct period" {
    create_independent_tasks
    create_log_with_activity
    run bash "$STATS_SCRIPT" --period 14
    assert_success
    assert_output_contains_any "14 days" "Last 14"
}
