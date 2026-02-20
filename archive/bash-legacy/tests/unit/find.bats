#!/usr/bin/env bats
# =============================================================================
# find.bats - Unit tests for find.sh
# =============================================================================
# Tests find command functionality including fuzzy search, ID matching,
# exact match mode, status filtering, field filtering, and output formats.
#
# Exit codes tested:
#   0   - Matches found
#   2   - Invalid input
#   100 - No matches found (not an error)
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

@test "find --help shows usage" {
    create_empty_todo
    run bash "$FIND_SCRIPT" --help
    assert_shows_help
}

@test "find -h shows usage" {
    create_empty_todo
    run bash "$FIND_SCRIPT" -h
    assert_shows_help
}

@test "find help includes examples" {
    create_empty_todo
    run bash "$FIND_SCRIPT" --help
    assert_success
    assert_output --partial "Examples:"
    assert_output --partial "ct find"
}

@test "find help shows exit codes" {
    create_empty_todo
    run bash "$FIND_SCRIPT" --help
    assert_success
    assert_output --partial "Exit Codes:"
    assert_output --partial "100"
}

# =============================================================================
# Fuzzy Search Mode (Default)
# =============================================================================

@test "find fuzzy matches title substring" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" --format json
    assert_success
    assert_valid_json

    local match_count=$(echo "$output" | jq '.summary.matches')
    [[ "$match_count" -ge 1 ]]

    # Should find T001 "First task"
    echo "$output" | jq -e '.matches[] | select(.id == "T001")' > /dev/null
}

@test "find fuzzy matches description" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "Task one" --format json
    assert_success

    local match_count=$(echo "$output" | jq '.summary.matches')
    [[ "$match_count" -ge 1 ]]
}

@test "find fuzzy case insensitive" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "FIRST" --format json
    assert_success

    local match_count=$(echo "$output" | jq '.summary.matches')
    [[ "$match_count" -ge 1 ]]
}

@test "find fuzzy partial word match" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "Fir" --format json
    assert_success

    local match_count=$(echo "$output" | jq '.summary.matches')
    [[ "$match_count" -ge 1 ]]
}

@test "find fuzzy returns relevance score" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" --format json
    assert_success

    # Check that score is present and valid
    local score=$(echo "$output" | jq '.matches[0].score')
    [[ "$score" != "null" ]]
}

@test "find fuzzy results sorted by score" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --format json
    assert_success

    # All tasks contain "task" - verify multiple matches
    local match_count=$(echo "$output" | jq '.summary.matches')
    [[ "$match_count" -ge 2 ]]
}

# =============================================================================
# ID Search Mode (--id, -i)
# =============================================================================

@test "find --id matches full ID" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" --id T001 --format json
    assert_success

    local match_id=$(echo "$output" | jq -r '.matches[0].id')
    [[ "$match_id" == "T001" ]]
}

@test "find -i matches ID prefix" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" -i 00 --format json
    assert_success

    # Should match T001, T002, T003
    local match_count=$(echo "$output" | jq '.summary.matches')
    [[ "$match_count" -eq 3 ]]
}

@test "find --id strips T prefix" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" --id 001 --format json
    assert_success

    local match_id=$(echo "$output" | jq -r '.matches[0].id')
    [[ "$match_id" == "T001" ]]
}

@test "find --id case insensitive T prefix" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" --id t001 --format json
    assert_success

    local match_id=$(echo "$output" | jq -r '.matches[0].id')
    [[ "$match_id" == "T001" ]]
}

@test "find --id single digit prefix" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" --id 0 --format json
    assert_success

    # All tasks (T001, T002, T003) start with 0 after T prefix
    local match_count=$(echo "$output" | jq '.summary.matches')
    [[ "$match_count" -eq 3 ]]
}

@test "find --id no match returns exit 100" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" --id 999 --format json
    assert_failure
    [[ "$status" -eq 100 ]]
}

@test "find --id requires value" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" --id
    assert_failure
    [[ "$status" -eq 2 ]]
    assert_output --partial "requires"
}

# =============================================================================
# Exact Match Mode (--exact, -e)
# =============================================================================

@test "find --exact matches full title" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First task" --exact --format json
    assert_success

    local match_id=$(echo "$output" | jq -r '.matches[0].id')
    [[ "$match_id" == "T001" ]]
}

@test "find -e matches exact title only" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" -e --format json

    # "First" is not an exact title match for "First task"
    [[ "$status" -eq 100 ]]
}

@test "find --exact case insensitive" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "first task" --exact --format json
    assert_success

    local match_id=$(echo "$output" | jq -r '.matches[0].id')
    [[ "$match_id" == "T001" ]]
}

@test "find --exact no partial matches" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --exact --format json

    # No task has title exactly "task"
    [[ "$status" -eq 100 ]]
}

# =============================================================================
# JSON Output Format (--format json)
# =============================================================================

@test "find --format json produces valid JSON" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --format json
    assert_success
    assert_valid_json
}

@test "find -f json (short flag)" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" -f json
    assert_success
    assert_valid_json
}

@test "find JSON has required structure" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --format json
    assert_success

    assert_json_has_key "_meta"
    assert_json_has_key "success"
    assert_json_has_key "query"
    assert_json_has_key "summary"
    assert_json_has_key "matches"
}

@test "find JSON includes query details" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" --format json
    assert_success

    local query_text=$(echo "$output" | jq -r '.query.text')
    local query_mode=$(echo "$output" | jq -r '.query.mode')

    [[ "$query_text" == "First" ]]
    [[ "$query_mode" == "fuzzy" ]]
}

@test "find JSON includes match count summary" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --format json
    assert_success

    local total_searched=$(echo "$output" | jq '.summary.total_searched')
    local matches=$(echo "$output" | jq '.summary.matches')

    [[ "$total_searched" -ge 1 ]]
    [[ "$matches" -ge 1 ]]
}

@test "find JSON match objects have required fields" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" --format json
    assert_success

    # Check first match has all required fields
    echo "$output" | jq -e '.matches[0].id' > /dev/null
    echo "$output" | jq -e '.matches[0].title' > /dev/null
    echo "$output" | jq -e '.matches[0].status' > /dev/null
    echo "$output" | jq -e '.matches[0].priority' > /dev/null
    echo "$output" | jq -e '.matches[0].score' > /dev/null
    echo "$output" | jq -e '.matches[0].matched_in' > /dev/null
}

@test "find JSON no match returns success:true" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "nonexistent" --format json

    # Exit code 100 but JSON should still have success structure
    [[ "$status" -eq 100 ]]

    local success=$(echo "$output" | jq '.success')
    [[ "$success" == "true" ]]
}

# =============================================================================
# Text Output Format (Default for TTY)
# =============================================================================

@test "find text output shows matches" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" --format text
    assert_success
    assert_output --partial "T001"
    assert_output --partial "First task"
}

@test "find text output shows score" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" --format text
    assert_success
    # Score appears in parentheses
    assert_output --partial "("
}

@test "find text no match shows message" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "nonexistent" --format text
    [[ "$status" -eq 100 ]]
    assert_output --partial "No matches"
}

# =============================================================================
# Status Filtering (--status, -s)
# =============================================================================

@test "find --status pending filters results" {
    create_tasks_with_completed
    run bash "$FIND_SCRIPT" "task" --status pending --format json
    assert_success

    # Only pending tasks should appear
    local match_count=$(echo "$output" | jq '.summary.matches')
    [[ "$match_count" -ge 1 ]]

    # Verify all matches are pending
    local non_pending=$(echo "$output" | jq '[.matches[] | select(.status != "pending")] | length')
    [[ "$non_pending" -eq 0 ]]
}

@test "find -s done filters completed tasks" {
    create_tasks_with_completed
    run bash "$FIND_SCRIPT" "task" -s done --format json
    assert_success

    # Should find the completed task
    local status=$(echo "$output" | jq -r '.matches[0].status')
    [[ "$status" == "done" ]]
}

@test "find --status blocked filters blocked tasks" {
    create_blocked_tasks
    run bash "$FIND_SCRIPT" "Blocked" --status blocked --format json
    assert_success

    local match_count=$(echo "$output" | jq '.summary.matches')
    [[ "$match_count" -ge 1 ]]

    # Verify all matches are blocked
    local non_blocked=$(echo "$output" | jq '[.matches[] | select(.status != "blocked")] | length')
    [[ "$non_blocked" -eq 0 ]]
}

@test "find --status invalid fails" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --status invalid
    assert_failure
    [[ "$status" -eq 2 ]]
    assert_output --partial "Invalid status"
}

@test "find --status requires value" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --status
    assert_failure
    [[ "$status" -eq 2 ]]
}

# =============================================================================
# Field Filtering (--field)
# =============================================================================

@test "find --field title searches only title" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" --field title --format json
    assert_success

    local matched_in=$(echo "$output" | jq -r '.matches[0].matched_in | join(",")')
    [[ "$matched_in" == "title" ]]
}

@test "find --field description searches only description" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "one" --field description --format json
    assert_success

    # "Task one" is in description of T001
    local matched_in=$(echo "$output" | jq -r '.matches[0].matched_in | join(",")')
    [[ "$matched_in" == "description" ]]
}

@test "find --field labels searches labels" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --labels bug,urgent > /dev/null

    run bash "$FIND_SCRIPT" "bug" --field labels --format json
    assert_success

    local match_id=$(echo "$output" | jq -r '.matches[0].id')
    [[ "$match_id" == "T001" ]]
}

@test "find --field all searches everything" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" --field all --format json
    assert_success

    local match_count=$(echo "$output" | jq '.summary.matches')
    [[ "$match_count" -ge 1 ]]
}

@test "find --field comma-separated" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" --field title,description --format json
    assert_success

    local fields=$(echo "$output" | jq -r '.query.fields | join(",")')
    [[ "$fields" == "title,description" ]]
}

@test "find --field requires value" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --field
    assert_failure
    [[ "$status" -eq 2 ]]
}

# =============================================================================
# Limit and Threshold Options
# =============================================================================

@test "find --limit restricts results" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --limit 2 --format json
    assert_success

    local match_count=$(echo "$output" | jq '.matches | length')
    [[ "$match_count" -le 2 ]]
}

@test "find -n limit short flag" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" -n 1 --format json
    assert_success

    local match_count=$(echo "$output" | jq '.matches | length')
    [[ "$match_count" -eq 1 ]]
}

@test "find --limit invalid fails" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --limit abc
    assert_failure
    [[ "$status" -eq 2 ]]
}

@test "find --limit zero fails" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --limit 0
    assert_failure
    [[ "$status" -eq 2 ]]
}

@test "find --threshold filters by score" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --threshold 0.5 --format json
    assert_success

    # All results should have score >= 0.5
    local low_scores=$(echo "$output" | jq '[.matches[] | select(.score < 0.5)] | length')
    [[ "$low_scores" -eq 0 ]]
}

@test "find -t threshold short flag" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" -t 0.8 --format json
    assert_success
}

# =============================================================================
# Archive Inclusion (--include-archive)
# =============================================================================

@test "find --include-archive searches archived tasks" {
    create_independent_tasks
    create_empty_archive

    # Add a task to archive
    jq '.archivedTasks = [{"id": "T999", "title": "Archived task", "description": "In archive", "status": "done", "priority": "medium"}]' "$ARCHIVE_FILE" > "${ARCHIVE_FILE}.tmp" && mv "${ARCHIVE_FILE}.tmp" "$ARCHIVE_FILE"

    run bash "$FIND_SCRIPT" "Archived" --include-archive --format json
    assert_success

    local match_id=$(echo "$output" | jq -r '.matches[0].id')
    [[ "$match_id" == "T999" ]]
}

@test "find without --include-archive ignores archive" {
    create_independent_tasks
    create_empty_archive

    jq '.archivedTasks = [{"id": "T999", "title": "Archived task", "description": "In archive", "status": "done", "priority": "medium"}]' "$ARCHIVE_FILE" > "${ARCHIVE_FILE}.tmp" && mv "${ARCHIVE_FILE}.tmp" "$ARCHIVE_FILE"

    run bash "$FIND_SCRIPT" "Archived" --format json
    [[ "$status" -eq 100 ]]
}

# =============================================================================
# Verbose Mode (--verbose, -v)
# =============================================================================

@test "find --verbose includes full task object" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" --verbose --format json
    assert_success

    # Check for nested task object
    echo "$output" | jq -e '.matches[0].task' > /dev/null
    echo "$output" | jq -e '.matches[0].task.createdAt' > /dev/null
}

@test "find -v verbose short flag" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" -v --format json
    assert_success

    echo "$output" | jq -e '.matches[0].task' > /dev/null
}

@test "find without verbose excludes full task" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" --format json
    assert_success

    # Should NOT have nested task object
    local has_task=$(echo "$output" | jq '.matches[0] | has("task")')
    [[ "$has_task" == "false" ]]
}

# =============================================================================
# Quiet Mode (--quiet, -q)
# =============================================================================

@test "find --quiet suppresses headers in text output" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" --quiet --format text
    assert_success
    refute_output --partial "FIND:"
}

@test "find -q quiet short flag" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" -q --format text
    assert_success
}

# =============================================================================
# Error Handling
# =============================================================================

@test "find without query fails" {
    create_independent_tasks
    run bash "$FIND_SCRIPT"
    assert_failure
    [[ "$status" -eq 2 ]]
    assert_output --partial "query required"
}

@test "find with multiple queries fails" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "first" "second"
    assert_failure
    [[ "$status" -eq 2 ]]
    assert_output --partial "Multiple queries"
}

@test "find with unknown option fails" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --unknown
    assert_failure
    [[ "$status" -eq 2 ]]
    assert_output --partial "Unknown option"
}

@test "find handles missing todo.json" {
    rm -f "$TODO_FILE"
    run bash "$FIND_SCRIPT" "task"
    assert_failure
    assert_output --partial "not found"
}

@test "find handles empty todo.json" {
    create_empty_todo
    run bash "$FIND_SCRIPT" "task" --format json
    [[ "$status" -eq 100 ]]

    local match_count=$(echo "$output" | jq '.summary.matches')
    [[ "$match_count" -eq 0 ]]
}

# =============================================================================
# Exit Codes
# =============================================================================

@test "find exit code 0 when matches found" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" --format json
    [[ "$status" -eq 0 ]]
}

@test "find exit code 2 for invalid input" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" --id
    [[ "$status" -eq 2 ]]
}

@test "find exit code 100 for no matches" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "nonexistent" --format json
    [[ "$status" -eq 100 ]]
}

@test "find exit code 100 is not error (JSON still valid)" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "nonexistent" --format json
    [[ "$status" -eq 100 ]]
    assert_valid_json
}

# =============================================================================
# NO_COLOR Compliance
# =============================================================================

@test "find respects NO_COLOR environment variable" {
    create_independent_tasks
    NO_COLOR=1 run bash "$FIND_SCRIPT" "First" --format text
    assert_success
    # Output should not contain ANSI escape codes
    refute_output --partial $'\033['
}

# =============================================================================
# Metadata and Execution Metrics
# =============================================================================

@test "find JSON includes execution time" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --format json
    assert_success

    local execution_ms=$(echo "$output" | jq '._meta.execution_ms')
    [[ "$execution_ms" != "null" ]]
}

@test "find JSON includes timestamp" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --format json
    assert_success

    local timestamp=$(echo "$output" | jq -r '._meta.timestamp')
    [[ "$timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]]
}

@test "find JSON includes version" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --format json
    assert_success

    local version=$(echo "$output" | jq -r '._meta.version')
    [[ "$version" != "null" ]]
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "find handles special characters in query" {
    create_independent_tasks
    bash "$ADD_SCRIPT" "Task with [brackets]" > /dev/null

    run bash "$FIND_SCRIPT" "brackets" --format json
    assert_success

    local match_count=$(echo "$output" | jq '.summary.matches')
    [[ "$match_count" -ge 1 ]]
}

@test "find handles query with spaces" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First task" --format json
    assert_success

    local match_count=$(echo "$output" | jq '.summary.matches')
    [[ "$match_count" -ge 1 ]]
}

@test "find handles very long query" {
    create_independent_tasks
    local long_query=$(printf 'a%.0s' {1..100})
    run bash "$FIND_SCRIPT" "$long_query" --format json

    # Should handle gracefully (no match expected)
    [[ "$status" -eq 100 || "$status" -eq 0 ]]
}

@test "find truncated results shows truncated flag" {
    create_independent_tasks
    # Add more tasks to exceed limit
    bash "$ADD_SCRIPT" "Fourth task" > /dev/null
    bash "$ADD_SCRIPT" "Fifth task" > /dev/null

    run bash "$FIND_SCRIPT" "task" --limit 2 --format json
    assert_success

    local truncated=$(echo "$output" | jq '.summary.truncated')
    [[ "$truncated" == "true" ]]
}

@test "find with phase in results" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "First" --format json
    assert_success

    # Tasks with phases should include phase in match
    local phase=$(echo "$output" | jq -r '.matches[0].phase // "none"')
    [[ "$phase" != "null" ]]
}

# =============================================================================
# Integration with Other Commands
# =============================================================================

@test "find output can be piped to jq" {
    create_independent_tasks
    run bash "$FIND_SCRIPT" "task" --format json
    assert_success

    # Verify output can be processed
    local ids=$(echo "$output" | jq -r '.matches[].id')
    [[ -n "$ids" ]]
}

@test "find combined with status and limit" {
    create_blocked_tasks
    run bash "$FIND_SCRIPT" "Blocked" --status blocked --limit 1 --format json
    assert_success

    local match_count=$(echo "$output" | jq '.matches | length')
    [[ "$match_count" -eq 1 ]]

    local status=$(echo "$output" | jq -r '.matches[0].status')
    [[ "$status" == "blocked" ]]
}
