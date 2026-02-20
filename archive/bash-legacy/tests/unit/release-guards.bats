#!/usr/bin/env bats
# =============================================================================
# release-guards.bats - Unit tests for release guard functions
# =============================================================================
# Tests check_epic_completeness, check_double_listing, and their render
# functions from lib/release/release-guards.sh
#
# @task T4436
# @epic T4431
# =============================================================================

setup() {
    load '../test_helper/common_setup'
    common_setup_per_test

    export TEST_GUARDS_DIR="${BATS_TEST_TMPDIR}/release-guards-$$"
    mkdir -p "$TEST_GUARDS_DIR"

    # Source the library under test
    source "$PROJECT_ROOT/lib/release/release-guards.sh"

    # Create a minimal todo.json for testing
    create_test_todo
}

teardown() {
    common_teardown
    rm -rf "$TEST_GUARDS_DIR"
}

create_test_todo() {
    cat > "$TEST_GUARDS_DIR/todo.json" << 'JSONEOF'
{
    "tasks": [
        {"id": "T100", "type": "epic", "title": "Epic A", "status": "active", "parentId": null, "labels": [], "createdAt": "2026-01-01T00:00:00Z"},
        {"id": "T101", "type": "task", "title": "Task 1", "status": "done", "parentId": "T100", "labels": ["release"], "createdAt": "2026-01-01T00:00:00Z", "completedAt": "2026-02-10T00:00:00Z"},
        {"id": "T102", "type": "task", "title": "Task 2", "status": "done", "parentId": "T100", "labels": ["release"], "createdAt": "2026-01-01T00:00:00Z", "completedAt": "2026-02-10T00:00:00Z"},
        {"id": "T103", "type": "task", "title": "Task 3", "status": "active", "parentId": "T100", "labels": ["release"], "createdAt": "2026-01-01T00:00:00Z"},
        {"id": "T104", "type": "task", "title": "Task 4", "status": "pending", "parentId": "T100", "labels": ["release"], "createdAt": "2026-01-01T00:00:00Z"},
        {"id": "T200", "type": "epic", "title": "Epic B", "status": "active", "parentId": null, "labels": [], "createdAt": "2026-01-01T00:00:00Z"},
        {"id": "T201", "type": "task", "title": "Task 5", "status": "done", "parentId": "T200", "labels": ["release"], "createdAt": "2026-01-01T00:00:00Z", "completedAt": "2026-02-10T00:00:00Z"},
        {"id": "T202", "type": "task", "title": "Task 6", "status": "done", "parentId": "T200", "labels": ["release"], "createdAt": "2026-01-01T00:00:00Z", "completedAt": "2026-02-10T00:00:00Z"},
        {"id": "T300", "type": "task", "title": "Orphan Task", "status": "done", "parentId": null, "labels": ["release"], "createdAt": "2026-01-01T00:00:00Z", "completedAt": "2026-02-10T00:00:00Z"}
    ],
    "project": {
        "releases": [
            {"version": "v0.93.0", "status": "released", "tasks": ["T101"], "releasedAt": "2026-02-01T00:00:00Z", "createdAt": "2026-02-01T00:00:00Z"},
            {"version": "v0.94.0", "status": "planned", "tasks": ["T101", "T102", "T201", "T202", "T300"], "createdAt": "2026-02-10T00:00:00Z"}
        ]
    }
}
JSONEOF
}

# =============================================================================
# check_epic_completeness tests
# =============================================================================

@test "check_epic_completeness: fully complete epic shows no missing" {
    # Epic B (T200) has T201 and T202 both in the release — all children covered
    local task_ids='["T201","T202"]'
    local result
    result=$(check_epic_completeness "$task_ids" "$TEST_GUARDS_DIR/todo.json")

    # Epic B should have 0 missing
    local epic_b_missing
    epic_b_missing=$(echo "$result" | jq '[.epics[] | select(.epicId == "T200") | .missing | length] | .[0] // 0')
    [[ "$epic_b_missing" -eq 0 ]]
}

@test "check_epic_completeness: partially complete epic reports missing tasks" {
    # Epic A (T100) has T101, T102 done but T103 active and T104 pending
    # Only include T101 and T102
    local task_ids='["T101","T102"]'
    local result
    result=$(check_epic_completeness "$task_ids" "$TEST_GUARDS_DIR/todo.json")

    local has_incomplete
    has_incomplete=$(echo "$result" | jq -r '.hasIncomplete')
    [[ "$has_incomplete" == "true" ]]

    # Should report T103 and T104 as missing
    local missing_count
    missing_count=$(echo "$result" | jq '[.epics[] | select(.epicId == "T100") | .missing | length] | .[0]')
    [[ "$missing_count" -eq 2 ]]
}

@test "check_epic_completeness: missing tasks have correct status" {
    local task_ids='["T101","T102"]'
    local result
    result=$(check_epic_completeness "$task_ids" "$TEST_GUARDS_DIR/todo.json")

    # T103 should be active, T104 should be pending
    local active_count pending_count
    active_count=$(echo "$result" | jq '[.epics[] | select(.epicId == "T100") | .missing[] | select(.status == "active")] | length')
    pending_count=$(echo "$result" | jq '[.epics[] | select(.epicId == "T100") | .missing[] | select(.status == "pending")] | length')
    [[ "$active_count" -eq 1 ]]
    [[ "$pending_count" -eq 1 ]]
}

@test "check_epic_completeness: orphan tasks listed in orphanTasks" {
    # T300 has no parent
    local task_ids='["T300"]'
    local result
    result=$(check_epic_completeness "$task_ids" "$TEST_GUARDS_DIR/todo.json")

    local orphan_count
    orphan_count=$(echo "$result" | jq '.orphanTasks | length')
    [[ "$orphan_count" -eq 1 ]]

    local orphan_id
    orphan_id=$(echo "$result" | jq -r '.orphanTasks[0]')
    [[ "$orphan_id" == "T300" ]]
}

@test "check_epic_completeness: returns 0 exit code always" {
    local task_ids='["T101"]'
    run check_epic_completeness "$task_ids" "$TEST_GUARDS_DIR/todo.json"
    [[ "$status" -eq 0 ]]
}

@test "check_epic_completeness: empty task list returns no incomplete" {
    local task_ids='[]'
    local result
    result=$(check_epic_completeness "$task_ids" "$TEST_GUARDS_DIR/todo.json")

    local has_incomplete
    has_incomplete=$(echo "$result" | jq -r '.hasIncomplete')
    [[ "$has_incomplete" == "false" ]]
}

@test "check_epic_completeness: missing todo file returns safe default" {
    local task_ids='["T101"]'
    local result
    result=$(check_epic_completeness "$task_ids" "/nonexistent/path/todo.json")

    local has_incomplete
    has_incomplete=$(echo "$result" | jq -r '.hasIncomplete')
    [[ "$has_incomplete" == "false" ]]

    local orphan_count
    orphan_count=$(echo "$result" | jq '.orphanTasks | length')
    [[ "$orphan_count" -eq 0 ]]
}

@test "check_epic_completeness: multiple epics reported separately" {
    # Include tasks from both Epic A and Epic B
    local task_ids='["T101","T102","T201","T202"]'
    local result
    result=$(check_epic_completeness "$task_ids" "$TEST_GUARDS_DIR/todo.json")

    local epic_count
    epic_count=$(echo "$result" | jq '.epics | length')
    [[ "$epic_count" -eq 2 ]]

    # Epic B should be complete, Epic A incomplete
    local epic_a_missing epic_b_missing
    epic_a_missing=$(echo "$result" | jq '[.epics[] | select(.epicId == "T100") | .missing | length] | .[0]')
    epic_b_missing=$(echo "$result" | jq '[.epics[] | select(.epicId == "T200") | .missing | length] | .[0]')
    [[ "$epic_a_missing" -eq 2 ]]
    [[ "$epic_b_missing" -eq 0 ]]
}

@test "check_epic_completeness: outputs valid JSON" {
    local task_ids='["T101","T300"]'
    local result
    result=$(check_epic_completeness "$task_ids" "$TEST_GUARDS_DIR/todo.json")

    # Must be valid JSON
    echo "$result" | jq . >/dev/null 2>&1
    [[ $? -eq 0 ]]

    # Must have required top-level keys
    echo "$result" | jq -e '.hasIncomplete != null' >/dev/null
    echo "$result" | jq -e '.epics != null' >/dev/null
    echo "$result" | jq -e '.orphanTasks != null' >/dev/null
}

# =============================================================================
# check_double_listing tests
# =============================================================================

@test "check_double_listing: detects task in prior release" {
    # T101 is in v0.93.0 (released) AND we're including it in v0.94.0
    local task_ids='["T101","T102"]'
    local result
    result=$(check_double_listing "$task_ids" "v0.94.0" "$TEST_GUARDS_DIR/todo.json")

    local has_overlap
    has_overlap=$(echo "$result" | jq -r '.hasOverlap')
    [[ "$has_overlap" == "true" ]]

    local overlap_task
    overlap_task=$(echo "$result" | jq -r '.overlaps[0].taskId')
    [[ "$overlap_task" == "T101" ]]

    local prior_version
    prior_version=$(echo "$result" | jq -r '.overlaps[0].priorVersion')
    [[ "$prior_version" == "v0.93.0" ]]
}

@test "check_double_listing: no overlap when tasks are unique" {
    # T201 and T202 only appear in v0.94.0 (planned, not released prior)
    local task_ids='["T201","T202"]'
    local result
    result=$(check_double_listing "$task_ids" "v0.94.0" "$TEST_GUARDS_DIR/todo.json")

    local has_overlap
    has_overlap=$(echo "$result" | jq -r '.hasOverlap')
    [[ "$has_overlap" == "false" ]]
}

@test "check_double_listing: returns 0 exit code always" {
    local task_ids='["T101"]'
    run check_double_listing "$task_ids" "v0.94.0" "$TEST_GUARDS_DIR/todo.json"
    [[ "$status" -eq 0 ]]
}

@test "check_double_listing: missing todo file returns safe default" {
    local task_ids='["T101"]'
    local result
    result=$(check_double_listing "$task_ids" "v0.94.0" "/nonexistent/path/todo.json")

    local has_overlap
    has_overlap=$(echo "$result" | jq -r '.hasOverlap')
    [[ "$has_overlap" == "false" ]]
}

@test "check_double_listing: empty task list returns no overlap" {
    local task_ids='[]'
    local result
    result=$(check_double_listing "$task_ids" "v0.94.0" "$TEST_GUARDS_DIR/todo.json")

    local has_overlap
    has_overlap=$(echo "$result" | jq -r '.hasOverlap')
    [[ "$has_overlap" == "false" ]]
}

@test "check_double_listing: only checks released versions not planned" {
    # v0.94.0 is planned (not released), so tasks listed there should not trigger overlap
    # T201 appears in v0.94.0 planned but NOT in any released version
    local task_ids='["T201"]'
    local result
    result=$(check_double_listing "$task_ids" "v0.95.0" "$TEST_GUARDS_DIR/todo.json")

    local has_overlap
    has_overlap=$(echo "$result" | jq -r '.hasOverlap')
    [[ "$has_overlap" == "false" ]]
}

@test "check_double_listing: outputs valid JSON" {
    local task_ids='["T101"]'
    local result
    result=$(check_double_listing "$task_ids" "v0.94.0" "$TEST_GUARDS_DIR/todo.json")

    # Must be valid JSON
    echo "$result" | jq . >/dev/null 2>&1
    [[ $? -eq 0 ]]

    # Must have required top-level keys
    echo "$result" | jq -e '.hasOverlap != null' >/dev/null
    echo "$result" | jq -e '.overlaps != null' >/dev/null
}

# =============================================================================
# render_epic_completeness tests
# =============================================================================

@test "render_epic_completeness: text mode outputs to stderr" {
    local result='{"hasIncomplete":true,"epics":[{"epicId":"T100","epicTitle":"Epic A","totalChildren":4,"includedCount":2,"missing":[{"id":"T103","title":"Task 3","status":"active"}]}],"orphanTasks":[]}'

    # Capture stderr
    local stderr_output
    stderr_output=$(render_epic_completeness "$result" "text" 2>&1 >/dev/null)

    [[ "$stderr_output" == *"Epic Completeness"* ]]
    [[ "$stderr_output" == *"T100"* ]]
    [[ "$stderr_output" == *"T103"* ]]
}

@test "render_epic_completeness: json mode outputs to stdout" {
    local result='{"hasIncomplete":true,"epics":[{"epicId":"T100","epicTitle":"Epic A","totalChildren":4,"includedCount":2,"missing":[]}],"orphanTasks":[]}'

    local stdout_output
    stdout_output=$(render_epic_completeness "$result" "json")

    # Should be valid JSON
    echo "$stdout_output" | jq . >/dev/null 2>&1
    [[ $? -eq 0 ]]
}

@test "render_epic_completeness: skips when hasIncomplete is false and no epics" {
    local result='{"hasIncomplete":false,"epics":[],"orphanTasks":[]}'

    local stderr_output
    stderr_output=$(render_epic_completeness "$result" "text" 2>&1 >/dev/null)

    # Should produce no output when there are no epics at all
    [[ -z "$stderr_output" ]]
}

@test "render_epic_completeness: shows complete message when epics exist but all complete" {
    local result='{"hasIncomplete":false,"epics":[{"epicId":"T200","epicTitle":"Epic B","totalChildren":2,"includedCount":2,"missing":[]}],"orphanTasks":[]}'

    local stderr_output
    stderr_output=$(render_epic_completeness "$result" "text" 2>&1 >/dev/null)

    # Should show "all epics complete" or similar
    [[ "$stderr_output" == *"complete"* ]]
}

@test "render_epic_completeness: text mode shows orphan tasks" {
    # Orphan section only renders when hasIncomplete is true (inside the detailed output branch)
    local result='{"hasIncomplete":true,"epics":[{"epicId":"T100","epicTitle":"Epic A","totalChildren":4,"includedCount":2,"missing":[{"id":"T103","title":"Task 3","status":"active"}]}],"orphanTasks":["T300","T301"]}'

    local stderr_output
    stderr_output=$(render_epic_completeness "$result" "text" 2>&1 >/dev/null)

    [[ "$stderr_output" == *"T300"* ]]
    [[ "$stderr_output" == *"T301"* ]]
    [[ "$stderr_output" == *"Orphan"* ]]
}

@test "render_epic_completeness: returns 0 exit code" {
    local result='{"hasIncomplete":true,"epics":[{"epicId":"T100","epicTitle":"Epic A","totalChildren":4,"includedCount":2,"missing":[{"id":"T103","title":"Task 3","status":"active"}]}],"orphanTasks":[]}'

    run render_epic_completeness "$result" "text"
    [[ "$status" -eq 0 ]]
}

# =============================================================================
# render_double_listing tests
# =============================================================================

@test "render_double_listing: text mode shows overlap warning" {
    local result='{"hasOverlap":true,"overlaps":[{"taskId":"T101","priorVersion":"v0.93.0"}]}'

    local stderr_output
    stderr_output=$(render_double_listing "$result" "text" 2>&1 >/dev/null)

    [[ "$stderr_output" == *"T101"* ]]
    [[ "$stderr_output" == *"v0.93.0"* ]]
}

@test "render_double_listing: skips when hasOverlap is false" {
    local result='{"hasOverlap":false,"overlaps":[]}'

    local stderr_output
    stderr_output=$(render_double_listing "$result" "text" 2>&1 >/dev/null)

    [[ -z "$stderr_output" ]]
}

@test "render_double_listing: json mode outputs to stdout" {
    local result='{"hasOverlap":true,"overlaps":[{"taskId":"T101","priorVersion":"v0.93.0"}]}'

    local stdout_output
    stdout_output=$(render_double_listing "$result" "json")

    # Should be valid JSON
    echo "$stdout_output" | jq . >/dev/null 2>&1
    [[ $? -eq 0 ]]

    # Should contain overlap data
    echo "$stdout_output" | jq -e '.overlaps[0].taskId == "T101"' >/dev/null
}

@test "render_double_listing: multiple overlaps all shown" {
    local result='{"hasOverlap":true,"overlaps":[{"taskId":"T101","priorVersion":"v0.93.0"},{"taskId":"T102","priorVersion":"v0.92.0"}]}'

    local stderr_output
    stderr_output=$(render_double_listing "$result" "text" 2>&1 >/dev/null)

    [[ "$stderr_output" == *"T101"* ]]
    [[ "$stderr_output" == *"T102"* ]]
    [[ "$stderr_output" == *"v0.93.0"* ]]
    [[ "$stderr_output" == *"v0.92.0"* ]]
}

@test "render_double_listing: returns 0 exit code" {
    local result='{"hasOverlap":true,"overlaps":[{"taskId":"T101","priorVersion":"v0.93.0"}]}'

    run render_double_listing "$result" "text"
    [[ "$status" -eq 0 ]]
}
