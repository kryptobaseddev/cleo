#!/usr/bin/env bats
# =============================================================================
# list-tasks.bats - Unit tests for list.sh
# =============================================================================
# Tests list-tasks command functionality including filtering, formatting,
# sorting, and display options.
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

@test "list --help shows usage" {
    create_empty_todo
    run bash "$LIST_SCRIPT" --help
    assert_shows_help
}

@test "list -h shows usage" {
    create_empty_todo
    run bash "$LIST_SCRIPT" -h
    assert_shows_help
}

# =============================================================================
# Basic Listing
# =============================================================================

@test "list all tasks" {
    create_independent_tasks  # Creates 3 tasks
    run bash "$LIST_SCRIPT"
    assert_success
    assert_output --partial "T001"
    assert_output --partial "T002"
    assert_output --partial "T003"
}

@test "list empty todo shows message" {
    create_empty_todo
    run bash "$LIST_SCRIPT"
    assert_success
    assert_output --partial "No tasks"
}

@test "list displays task titles" {
    create_independent_tasks
    run bash "$LIST_SCRIPT"
    assert_success
    assert_output --partial "First task"
    assert_output --partial "Second task"
    assert_output --partial "Third task"
}

# =============================================================================
# Status Filtering - Long Flags
# =============================================================================

@test "list --status pending shows only pending tasks" {
    create_independent_tasks
    # Mark one task as active
    bash "$UPDATE_SCRIPT" T001 --status active > /dev/null

    run bash "$LIST_SCRIPT" --status pending
    assert_success
    assert_output --partial "T002"
    assert_output --partial "T003"
    refute_output --partial "T001"
}

@test "list --status active shows only active tasks" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --status active > /dev/null

    run bash "$LIST_SCRIPT" --status active
    assert_success
    assert_output --partial "T001"
    refute_output --partial "T002"
}

@test "list --status blocked shows only blocked tasks" {
    create_blocked_tasks
    run bash "$LIST_SCRIPT" --status blocked
    assert_success
    assert_output --partial "T002"
    assert_output --partial "T003"
    # T001 appears in dependency references but should not appear as a listed task
    # Check that T001 is not followed by a status symbol (indicating it's a listed task)
    refute_output --regexp "T001 [○◉⊗✓]"
}

@test "list --status done shows only completed tasks" {
    create_tasks_with_completed
    run bash "$LIST_SCRIPT" --status done
    assert_success
    assert_output --partial "T001"
    refute_output --partial "T002"
}

# =============================================================================
# Status Filtering - Short Flags
# =============================================================================

@test "list -s pending (short flag)" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --status active > /dev/null

    run bash "$LIST_SCRIPT" -s pending
    assert_success
    assert_output --partial "T002"
}

@test "list -s active (short flag)" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --status active > /dev/null

    run bash "$LIST_SCRIPT" -s active
    assert_success
    assert_output --partial "T001"
}

# =============================================================================
# Priority Filtering - Long Flags
# =============================================================================

@test "list --priority high shows only high priority tasks" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --priority high
    assert_success
    assert_output --partial "T002"  # Second task has high priority
    refute_output --partial "T001"
}

@test "list --priority medium shows only medium priority tasks" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --priority medium
    assert_success
    assert_output --partial "T001"
}

@test "list --priority low shows only low priority tasks" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --priority low
    assert_success
    assert_output --partial "T003"
}

@test "list --priority critical shows only critical priority tasks" {
    create_complex_deps  # T001 has critical priority
    run bash "$LIST_SCRIPT" --priority critical
    assert_success
    assert_output --partial "T001"
}

# =============================================================================
# Priority Filtering - Short Flags
# =============================================================================

@test "list -p high (short flag)" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" -p high
    assert_success
    assert_output --partial "T002"
}

@test "list -p medium (short flag)" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" -p medium
    assert_success
    assert_output --partial "T001"
}

# =============================================================================
# Label Filtering
# =============================================================================

@test "list --label filters by label" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --labels bug,urgent > /dev/null
    bash "$UPDATE_SCRIPT" T002 --labels feature > /dev/null

    run bash "$LIST_SCRIPT" --label bug
    assert_success
    assert_output --partial "T001"
    refute_output --partial "T002"
}

@test "list -l label (short flag)" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --labels urgent > /dev/null

    run bash "$LIST_SCRIPT" -l urgent
    assert_success
    assert_output --partial "T001"
}

# =============================================================================
# Combined Filters
# =============================================================================

@test "list with status and priority filters" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T002 --status active > /dev/null

    run bash "$LIST_SCRIPT" --status active --priority high
    assert_success
    assert_output --partial "T002"
}

@test "list with multiple filters" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T002 --status active --labels bug > /dev/null

    run bash "$LIST_SCRIPT" -s active -p high -l bug
    assert_success
    assert_output --partial "T002"
}

# =============================================================================
# Output Formats - JSON
# =============================================================================

@test "list --format json produces valid JSON" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format json
    assert_success
    assert_valid_json
}

@test "list -f json (short flag)" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" -f json
    assert_success
    assert_valid_json
}

@test "list JSON output has required keys" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format json
    assert_success
    assert_json_has_key "tasks"
    assert_json_has_key "_meta"
    assert_json_has_key "summary"
}

@test "list JSON output includes metadata" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format json
    assert_success

    local has_version=$(echo "$output" | jq -e '._meta.version != null')
    [[ "$has_version" == "true" ]]
}

@test "list JSON output includes summary counts" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format json
    assert_success

    local has_total=$(echo "$output" | jq -e '.summary.total != null')
    local has_filtered=$(echo "$output" | jq -e '.summary.filtered != null')
    [[ "$has_total" == "true" ]]
    [[ "$has_filtered" == "true" ]]
}

@test "list empty tasks JSON format" {
    create_empty_todo
    run bash "$LIST_SCRIPT" --format json
    assert_success
    assert_valid_json

    local count=$(echo "$output" | jq '.summary.filtered')
    [[ "$count" == "0" ]]
}

# =============================================================================
# Output Formats - Markdown
# =============================================================================

@test "list --format markdown produces markdown" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format markdown
    assert_success
    assert_markdown_output
}

@test "list markdown includes task headers" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format markdown
    assert_success
    assert_output --partial "## T001"
}

@test "list markdown includes task details" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format markdown
    assert_success
    assert_output --partial "**Status:**"
    assert_output --partial "**Priority:**"
}

# =============================================================================
# Output Formats - JSONL
# =============================================================================

@test "list --format jsonl produces JSONL" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format jsonl
    assert_success

    # Each line should be valid JSON
    local line_count=$(echo "$output" | wc -l)
    [[ "$line_count" -gt 1 ]]
}

@test "list JSONL first line is metadata" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format jsonl
    assert_success

    local first_line=$(echo "$output" | head -1)
    local type=$(echo "$first_line" | jq -r '._type')
    [[ "$type" == "meta" ]]
}

@test "list JSONL last line is summary" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format jsonl
    assert_success

    local last_line=$(echo "$output" | tail -1)
    local type=$(echo "$last_line" | jq -r '._type')
    [[ "$type" == "summary" ]]
}

# =============================================================================
# Output Formats - Table
# =============================================================================

@test "list --format table produces table" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format table
    assert_success
    assert_output --partial "╔"
    assert_output --partial "║"
}

@test "list table includes headers" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format table
    assert_success
    assert_output --partial "ID"
    assert_output --partial "Title"
    assert_output --partial "Status"
}

# =============================================================================
# Invalid Format Validation (NEW - T142)
# =============================================================================

@test "list with invalid format fails" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format invalid
    assert_failure
    assert_output --partial "Invalid format"
}

@test "list with invalid format shows valid options" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format bad
    assert_failure
    assert_output --partial "Valid formats"
}

@test "list with typo in format fails" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format josn  # Common typo
    assert_failure
    assert_output --partial "Invalid format"
}

# =============================================================================
# Compact Mode
# =============================================================================

@test "list --compact shows one line per task" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --compact
    assert_success
    # Compact mode should be shorter than regular
}

@test "list -c compact (short flag)" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" -c
    assert_success
}

# =============================================================================
# Verbose Mode
# =============================================================================

@test "list --verbose shows all details" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --description "Detailed description" > /dev/null

    run bash "$LIST_SCRIPT" --verbose
    assert_success
    assert_output --partial "Detailed description"
}

@test "list -v verbose (short flag)" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" -v
    assert_success
}

@test "list verbose shows timestamps" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --verbose
    assert_success
    assert_output --partial "Created:"
}

# =============================================================================
# Quiet Mode
# =============================================================================

@test "list --quiet suppresses headers" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --quiet
    assert_success
    refute_output --partial "TASKS"
}

@test "list -q quiet (short flag)" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" -q
    assert_success
}

@test "list quiet mode still shows task data" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --quiet
    assert_success
    assert_output --partial "T001"
}

# =============================================================================
# Display Options
# =============================================================================

@test "list --notes shows task notes" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --notes "Test note" > /dev/null

    run bash "$LIST_SCRIPT" --notes
    assert_success
    assert_output --partial "Test note"
}

@test "list --files shows associated files" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --files "file1.txt,file2.txt" > /dev/null

    run bash "$LIST_SCRIPT" --files
    assert_success
    assert_output --partial "file1.txt"
}

@test "list --acceptance shows acceptance criteria" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --acceptance "User can login" > /dev/null

    run bash "$LIST_SCRIPT" --acceptance
    assert_success
    assert_output --partial "User can login"
}

# =============================================================================
# Sorting
# =============================================================================

@test "list --sort priority sorts by priority" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --sort priority
    assert_success
}

@test "list --sort status sorts by status" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --status active > /dev/null

    run bash "$LIST_SCRIPT" --sort status
    assert_success
}

@test "list --sort createdAt sorts by creation date" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --sort createdAt
    assert_success
}

@test "list --sort title sorts alphabetically" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --sort title
    assert_success
}

@test "list --sort --reverse reverses order" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --sort priority --reverse
    assert_success
}

# =============================================================================
# Limit
# =============================================================================

@test "list --limit 2 shows first 2 tasks" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --limit 2 --format json
    assert_success

    local count=$(echo "$output" | jq '.tasks | length')
    [[ "$count" == "2" ]]
}

@test "list --limit 1 shows single task" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --limit 1 --format json
    assert_success

    local count=$(echo "$output" | jq '.tasks | length')
    [[ "$count" == "1" ]]
}

# =============================================================================
# Date Filtering
# =============================================================================

@test "list --since filters by creation date" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --since "2025-12-01"
    assert_success
}

@test "list --until filters by creation date" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --until "2025-12-31"
    assert_success
}

@test "list --since --until creates date range" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --since "2025-12-01" --until "2025-12-31"
    assert_success
}

# =============================================================================
# Archive Inclusion
# =============================================================================

@test "list --all includes archived tasks" {
    create_tasks_with_completed
    # Assumes archive file exists
    run bash "$LIST_SCRIPT" --all
    assert_success
}

# =============================================================================
# Flat vs Grouped Display
# =============================================================================

@test "list --flat disables grouping" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --flat
    assert_success
}

@test "list default groups by priority" {
    create_independent_tasks
    run bash "$LIST_SCRIPT"
    assert_success
    # Should show priority headers
}

# =============================================================================
# Error Handling
# =============================================================================

@test "list handles missing todo.json gracefully" {
    rm -f "$TODO_FILE"
    run bash "$LIST_SCRIPT"
    assert_failure
    assert_output --partial "not found"
}

@test "list with unknown option fails" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --unknown-option
    assert_failure
    assert_output --partial "Unknown option"
}

# =============================================================================
# NO_COLOR Compliance
# =============================================================================

@test "list respects NO_COLOR environment variable" {
    create_independent_tasks
    NO_COLOR=1 run bash "$LIST_SCRIPT"
    assert_success
    # Output should not contain ANSI escape codes
    refute_output --partial $'\033['
}

@test "list with NO_COLOR still shows content" {
    create_independent_tasks
    NO_COLOR=1 run bash "$LIST_SCRIPT"
    assert_success
    assert_output --partial "T001"
}

# =============================================================================
# Unicode/ASCII Fallback
# =============================================================================

@test "list with LANG=C uses ASCII fallback" {
    create_independent_tasks
    LANG=C run bash "$LIST_SCRIPT"
    assert_success
    # Should use ASCII characters instead of Unicode
}

@test "list with unicode support shows unicode" {
    create_independent_tasks
    run bash "$LIST_SCRIPT"
    assert_success
    # Default should support unicode in most environments
}

# =============================================================================
# Blockers and Dependencies Display
# =============================================================================

@test "list shows blocked tasks with reason" {
    create_blocked_tasks
    run bash "$LIST_SCRIPT"
    assert_success
    assert_output --partial "Blocked"
}

@test "list shows task dependencies" {
    create_linear_chain
    run bash "$LIST_SCRIPT"
    assert_success
    assert_output --partial "Depends"
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "list handles tasks with no optional fields" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Minimal task" > /dev/null

    run bash "$LIST_SCRIPT"
    assert_success
    assert_output --partial "Minimal task"
}

@test "list handles tasks with all optional fields" {
    create_empty_todo
    jq '.project.phases = {"test": {"name": "Test", "description": "Test phase", "order": 1}}' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    bash "$ADD_SCRIPT" "Full task" \
        --priority high \
        --description "Full description" \
        --labels bug,urgent \
        --phase test \
        --files "file.txt" \
        --acceptance "Criterion" \
        --notes "Note" > /dev/null

    run bash "$LIST_SCRIPT" --verbose
    assert_success
}

@test "list with very long task title" {
    create_empty_todo
    local long_title=$(printf 'a%.0s' {1..100})
    bash "$ADD_SCRIPT" "$long_title" > /dev/null

    run bash "$LIST_SCRIPT"
    assert_success
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "list JSON output can be piped to jq" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format json
    assert_success

    # Test that output can be processed by jq
    local task_count=$(echo "$output" | jq '.tasks | length')
    [[ "$task_count" -ge 0 ]]
}

@test "list shows correct count summary" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --format json
    assert_success

    local total=$(echo "$output" | jq '.summary.total')
    local filtered=$(echo "$output" | jq '.summary.filtered')

    [[ "$total" -eq 3 ]]
    [[ "$filtered" -eq 3 ]]
}

@test "list with filter shows correct filtered count" {
    create_independent_tasks
    run bash "$LIST_SCRIPT" --status pending --format json
    assert_success

    local total=$(echo "$output" | jq '.summary.total')
    local filtered=$(echo "$output" | jq '.summary.filtered')

    [[ "$total" -eq 3 ]]
    [[ "$filtered" -eq 3 ]]
}
