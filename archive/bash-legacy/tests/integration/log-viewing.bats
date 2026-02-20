#!/usr/bin/env bats
# =============================================================================
# log-viewing.bats - Integration tests for log viewing commands
# =============================================================================
# Tests log list and log show commands with filtering and formatting
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    load '../test_helper/assertions'
    common_setup_per_test
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

@test "log list: should display recent entries with default limit" {
  create_empty_todo

  # Create some log entries
  run bash "$ADD_SCRIPT" "First task" --description "First test" --priority high
  assert_success
  run bash "$ADD_SCRIPT" "Second task" --description "Second test" --priority medium
  assert_success
  run bash "$COMPLETE_SCRIPT" T001 --skip-notes
  assert_success

  # List entries
  run bash "$SCRIPTS_DIR/log.sh" list --limit 5
  assert_success
  assert_output --partial "task_created"
  assert_output --partial "status_changed"
}

@test "log list: should filter by action type" {
  create_empty_todo

  # Create tasks
  run bash "$ADD_SCRIPT" "Task one" --description "Test one"
  assert_success
  run bash "$ADD_SCRIPT" "Task two" --description "Test two"
  assert_success
  run bash "$COMPLETE_SCRIPT" T001 --skip-notes
  assert_success

  # Filter by task_created
  run bash "$SCRIPTS_DIR/log.sh" list --action task_created
  assert_success
  assert_output --partial "task_created"
  refute_output --partial "status_changed"
}

@test "log list: should filter by task ID" {
  create_empty_todo

  # Create and modify tasks
  run bash "$ADD_SCRIPT" "Target task" --description "Target test"
  assert_success
  run bash "$ADD_SCRIPT" "Other task" --description "Other test"
  assert_success
  run bash "$COMPLETE_SCRIPT" T001 --skip-notes
  assert_success

  # Filter by T001
  run bash "$SCRIPTS_DIR/log.sh" list --task-id T001
  assert_success
  assert_output --partial "T001"
  refute_output --partial "T002"
}

@test "log list: should output JSON format" {
  create_empty_todo

  run bash "$ADD_SCRIPT" "JSON test task" --description "JSON test"
  assert_success

  # Request JSON output
  run bash "$SCRIPTS_DIR/log.sh" list --action task_created --format json
  assert_success

  # Verify JSON envelope structure using jq
  echo "$output" | jq -e '._meta.command' >/dev/null
  echo "$output" | jq -e '.success' >/dev/null
  echo "$output" | jq -e '.entries[].id' >/dev/null
  echo "$output" | jq -e '.entries[].timestamp' >/dev/null
  echo "$output" | jq -e '.entries[].action' >/dev/null
}

@test "log show: should display specific log entry details" {
  create_empty_todo

  # Create task to generate log entry
  run bash "$ADD_SCRIPT" "Show test task" --description "Show test"
  assert_success

  # Get the log ID of the most recent task_created entry
  LOG_ID=$(jq -r '.entries[] | select(.action == "task_created") | .id' "$LOG_FILE" | tail -n 1)

  # Show specific entry
  run bash "$SCRIPTS_DIR/log.sh" show "$LOG_ID"
  assert_success
  assert_output --partial "Log Entry: $LOG_ID"
  assert_output --partial "Action:     task_created"
  assert_output --partial "Actor:      system"
}

@test "log show: should display before/after for status changes" {
  create_empty_todo

  # Create and complete task
  run bash "$ADD_SCRIPT" "Status change test" --description "Status test"
  assert_success
  run bash "$COMPLETE_SCRIPT" T001 --skip-notes
  assert_success

  # Get the status_changed log entry
  LOG_ID=$(jq -r '.entries[] | select(.action == "status_changed" and .taskId == "T001") | .id' "$LOG_FILE" | tail -n 1)

  # Show entry with before/after
  run bash "$SCRIPTS_DIR/log.sh" show "$LOG_ID"
  assert_success
  assert_output --partial "Before:"
  assert_output --partial "After:"
}

@test "log show: should error on non-existent log ID" {
  create_empty_todo

  run bash "$SCRIPTS_DIR/log.sh" show log_nonexistent123
  assert_failure
  assert_output --partial "Log entry not found"
}

@test "log list: should handle empty log file" {
  create_empty_todo

  # Remove log file
  rm -f "$LOG_FILE"

  run bash "$SCRIPTS_DIR/log.sh" list
  assert_failure
  assert_output --partial "Log file not found"
}

@test "log list: text format should be human-readable" {
  create_empty_todo

  run bash "$ADD_SCRIPT" "Human readable test" --description "Human test"
  assert_success

  # Explicitly request text format (tests run in non-TTY context where default is JSON)
  run bash "$SCRIPTS_DIR/log.sh" list --action task_created --limit 1 --format text
  assert_success

  # Check for readable timestamp format (YYYY-MM-DD HH:MM:SS)
  assert_output --regexp '\[20[0-9]{2}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\]'

  # Check for human-readable parts
  assert_output --partial "task_created"
  assert_output --partial "by system"
  assert_output --partial "title:"
}
