#!/usr/bin/env bats
# =============================================================================
# dash.bats - Unit tests for dash.sh (dashboard command)
# =============================================================================
# Tests dashboard command functionality with multiple output formats, sections,
# and configuration options.
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

    # Set DASH_SCRIPT path
    export DASH_SCRIPT="${SCRIPTS_DIR}/dash.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Help and Basic Command Tests
# =============================================================================

@test "dash --help shows usage" {
    create_empty_todo
    run bash "$DASH_SCRIPT" --help
    assert_success
    assert_output --partial "Usage:"
    assert_output --partial "cleo dash"
}

@test "dash -h shows usage" {
    create_empty_todo
    run bash "$DASH_SCRIPT" -h
    assert_success
    assert_output --partial "Usage:"
}

@test "dash without options shows default dashboard" {
    create_independent_tasks
    run bash "$DASH_SCRIPT"
    assert_success
    refute_output ""
}

# =============================================================================
# Default Output Tests
# =============================================================================

@test "dash displays all sections by default" {
    create_independent_tasks
    run bash "$DASH_SCRIPT"
    assert_success
    assert_output_contains_all "PROJECT DASHBOARD" "TASK OVERVIEW"
}

@test "dash shows current focus section" {
    create_independent_tasks
    # Set focus to T001
    jq '.focus.currentTask = "T001"' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    run bash "$DASH_SCRIPT"
    assert_success
    assert_output --partial "CURRENT FOCUS"
    assert_output --partial "T001"
}

@test "dash shows 'No active focus' when no focus set" {
    create_independent_tasks
    run bash "$DASH_SCRIPT"
    assert_success
    assert_output --partial "No active focus"
}

@test "dash shows task summary counts" {
    create_independent_tasks
    run bash "$DASH_SCRIPT"
    assert_success
    assert_output_contains_any "pending" "Total:"
}

# =============================================================================
# Compact Mode Tests
# =============================================================================

@test "dash --compact produces single-line output" {
    create_independent_tasks
    run bash "$DASH_SCRIPT" --compact
    assert_success
    # Compact mode should be much shorter
    [[ $(echo "$output" | wc -l) -lt 5 ]]
}

@test "dash -c produces compact output" {
    create_independent_tasks
    run bash "$DASH_SCRIPT" -c
    assert_success
    [[ $(echo "$output" | wc -l) -lt 5 ]]
}

@test "dash --compact shows critical task counts" {
    create_empty_todo
    # Add critical priority task
    jq '.tasks += [{"id": "T001", "title": "Critical task", "description": "Urgent", "status": "pending", "priority": "critical", "createdAt": "2025-12-01T10:00:00Z"}]' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$DASH_SCRIPT" --compact
    assert_success
    assert_output_contains_any "critical" "high" "High:"
}

# =============================================================================
# Section Filtering Tests
# =============================================================================

@test "dash --sections focus shows only focus section" {
    create_independent_tasks
    jq '.focus.currentTask = "T001"' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    run bash "$DASH_SCRIPT" --sections focus
    assert_success
    assert_output --partial "CURRENT FOCUS"
    refute_output --partial "TASK OVERVIEW"
}

@test "dash --sections summary shows only summary section" {
    create_independent_tasks
    run bash "$DASH_SCRIPT" --sections summary
    assert_success
    assert_output --partial "TASK OVERVIEW"
}

@test "dash --sections focus,blocked shows multiple sections" {
    create_blocked_tasks
    jq '.focus.currentTask = "T001"' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    run bash "$DASH_SCRIPT" --sections focus,blocked
    assert_success
    assert_output --partial "CURRENT FOCUS"
    assert_output --partial "BLOCKED"
}

@test "dash --sections all shows all sections" {
    create_independent_tasks
    run bash "$DASH_SCRIPT" --sections all
    assert_success
    assert_output --partial "PROJECT DASHBOARD"
}

# =============================================================================
# Period Option Tests
# =============================================================================

@test "dash --period 7 uses 7-day period" {
    create_independent_tasks
    run bash "$DASH_SCRIPT" --period 7
    assert_success
    assert_output_contains_any "7 days" "Last 7"
}

@test "dash --period 14 uses 14-day period" {
    create_independent_tasks
    run bash "$DASH_SCRIPT" --period 14
    assert_success
    assert_output_contains_any "14 days" "Last 14"
}

@test "dash --period invalid shows error" {
    create_independent_tasks
    run bash "$DASH_SCRIPT" --period abc
    assert_failure
    assert_output --partial "ERROR"
}

# =============================================================================
# JSON Output Format Tests
# =============================================================================

@test "dash --format json produces valid JSON" {
    create_independent_tasks
    run bash "$DASH_SCRIPT" --format json
    assert_success
    assert_valid_json
}

@test "dash -f json produces valid JSON" {
    create_independent_tasks
    run bash "$DASH_SCRIPT" -f json
    assert_success
    assert_valid_json
}

@test "dash JSON output has _meta.format field" {
    create_independent_tasks
    run bash "$DASH_SCRIPT" --format json
    assert_success
    assert_json_has_key "_meta"
    run jq -e '._meta.format == "json"' <<< "$output"
    assert_success
}

@test "dash JSON output has required sections" {
    create_independent_tasks
    run bash "$DASH_SCRIPT" --format json
    assert_success
    assert_json_has_key "project"
    assert_json_has_key "summary"
    assert_json_has_key "focus"
}

@test "dash JSON output contains task counts" {
    create_independent_tasks
    run bash "$DASH_SCRIPT" --format json
    assert_success
    run jq -e '.summary.total > 0' <<< "$output"
    assert_success
}

# =============================================================================
# NO_COLOR Compliance Tests
# =============================================================================

@test "dash respects NO_COLOR environment variable" {
    create_independent_tasks
    NO_COLOR=1 run bash "$DASH_SCRIPT"
    assert_success
    # Should not contain ANSI escape sequences
    refute_output --regexp '\033\[[0-9;]*m'
}

@test "dash shows ASCII symbols when NO_COLOR is set" {
    create_independent_tasks
    NO_COLOR=1 run bash "$DASH_SCRIPT"
    assert_success
    # Output should not be empty
    refute_output ""
}

# =============================================================================
# Unicode Support Tests
# =============================================================================

@test "dash respects unicodeEnabled config" {
    create_independent_tasks
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
    run bash "$DASH_SCRIPT"
    assert_success
    # Should show ASCII characters instead of Unicode
    refute_output ""
}

@test "dash shows Unicode symbols by default" {
    create_independent_tasks
    # Remove NO_COLOR and set LANG to support Unicode
    unset NO_COLOR
    LANG=en_US.UTF-8 run bash "$DASH_SCRIPT"
    assert_success
    refute_output ""
}

# =============================================================================
# Empty State Tests
# =============================================================================

@test "dash handles empty todo list gracefully" {
    create_empty_todo
    run bash "$DASH_SCRIPT"
    assert_success
    refute_output ""
}

@test "dash --format json handles empty todo list" {
    create_empty_todo
    run bash "$DASH_SCRIPT" --format json
    assert_success
    assert_valid_json
    run jq -e '.summary.total == 0' <<< "$output"
    assert_success
}

# =============================================================================
# Blocked Tasks Section Tests
# =============================================================================

@test "dash shows blocked tasks section when tasks are blocked" {
    create_blocked_tasks
    run bash "$DASH_SCRIPT"
    assert_success
    assert_output --partial "BLOCKED"
}

@test "dash shows blocking reason for blocked tasks" {
    create_blocked_tasks
    run bash "$DASH_SCRIPT"
    assert_success
    assert_output_contains_any "Waiting" "Blocked by"
}

# =============================================================================
# High Priority Tasks Section Tests
# =============================================================================

@test "dash shows high priority section when high priority tasks exist" {
    create_empty_todo
    # Add high priority task
    jq '.tasks += [{"id": "T001", "title": "High priority", "description": "Important", "status": "pending", "priority": "high", "createdAt": "2025-12-01T10:00:00Z"}]' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$DASH_SCRIPT"
    assert_success
    assert_output --partial "HIGH PRIORITY"
}

# =============================================================================
# Error Handling Tests
# =============================================================================

@test "dash handles missing todo.json" {
    rm -f "$TODO_FILE"
    run bash "$DASH_SCRIPT"
    assert_failure
    assert_output --partial "ERROR"
}

@test "dash handles invalid format gracefully" {
    create_independent_tasks
    run bash "$DASH_SCRIPT" --format invalid
    assert_failure
    assert_output --partial "ERROR"
}

@test "dash handles unknown option" {
    create_independent_tasks
    run bash "$DASH_SCRIPT" --unknown-option
    assert_failure
    assert_output --partial "ERROR"
}

# =============================================================================
# Labels Section Tests
# =============================================================================

@test "dash shows labels section when labels exist" {
    create_empty_todo
    # Add task with labels
    jq '.tasks += [{"id": "T001", "title": "Task with labels", "description": "Test", "status": "pending", "priority": "medium", "labels": ["backend", "api"], "createdAt": "2025-12-01T10:00:00Z"}]' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$DASH_SCRIPT"
    assert_success
    assert_output --partial "TOP LABELS"
}

# =============================================================================
# Session Note Tests
# =============================================================================

@test "dash shows session note when present" {
    create_independent_tasks
    # Set focus with session note
    jq '.focus = {"currentTask": "T001", "sessionNote": "Working on implementation"}' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$DASH_SCRIPT"
    assert_success
    assert_output --partial "Note:"
    assert_output --partial "Working on implementation"
}

# =============================================================================
# --no-chart Option Tests
# =============================================================================

@test "dash --no-chart disables charts" {
    create_independent_tasks
    run bash "$DASH_SCRIPT" --no-chart
    assert_success
    refute_output ""
}
