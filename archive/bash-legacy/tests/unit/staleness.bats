#!/usr/bin/env bats
# =============================================================================
# staleness.bats - Unit tests for lib/tasks/staleness.sh
# =============================================================================
# Tests for:
# - is_task_stale() - Check if task is stale (returns exit code)
# - categorize_staleness() - Determine staleness type
# - get_staleness_metadata() - Get detailed staleness info
# - get_stale_tasks() - Find all stale tasks from a todo file
# - Configuration getters for staleness thresholds
# =============================================================================

# Load test helpers using file-level setup pattern (BATS-OPTIMIZATION-SPEC)
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file

    # Source staleness library
    export STALENESS_LIB="${LIB_DIR}/tasks/staleness.sh"

    # Pre-calculate date values for fixtures
    # These will be used to generate dynamic test data
    export NOW_EPOCH=$(date +%s)

    # Date calculations (in seconds)
    export SECONDS_PER_DAY=86400
    export RECENT_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 2))  # 2 days ago
    export WEEK_AGO_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 7))
    export TWO_WEEKS_AGO_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 14))
    export MONTH_AGO_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 35))
    export OLD_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 45))  # 45 days ago

    # Threshold boundaries
    export PENDING_THRESHOLD_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 30))  # Exactly 30 days
    export JUST_UNDER_PENDING_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 29))  # 29 days
    export BLOCKED_THRESHOLD_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 7))  # Exactly 7 days
    export JUST_UNDER_BLOCKED_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 6))  # 6 days
    export NO_UPDATE_THRESHOLD_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 14))  # Exactly 14 days
    export JUST_UNDER_NO_UPDATE_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 13))  # 13 days
    export URGENT_THRESHOLD_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 7))  # Exactly 7 days
    export JUST_UNDER_URGENT_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 6))  # 6 days
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    common_setup_per_test

    # Source the staleness library for each test
    source "$STALENESS_LIB"

    # Create staleness fixtures directory
    export STALENESS_FIXTURES="${TEST_TEMP_DIR}/staleness"
    mkdir -p "$STALENESS_FIXTURES"
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

# Convert epoch to ISO8601 format
_epoch_to_iso() {
    local epoch="$1"
    date -u -d "@$epoch" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
        date -u -r "$epoch" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null
}

# Convert epoch to note timestamp format (YYYY-MM-DD HH:MM:SS UTC)
_epoch_to_note() {
    local epoch="$1"
    date -u -d "@$epoch" "+%Y-%m-%d %H:%M:%S UTC" 2>/dev/null || \
        date -u -r "$epoch" "+%Y-%m-%d %H:%M:%S UTC" 2>/dev/null
}

# Create a simple task JSON for testing
_make_task() {
    local id="${1:-T001}"
    local status="${2:-pending}"
    local priority="${3:-medium}"
    local created_epoch="${4:-$RECENT_EPOCH}"
    local last_note_epoch="${5:-}"

    local created_at
    created_at=$(_epoch_to_iso "$created_epoch")

    local notes="[]"
    if [[ -n "$last_note_epoch" ]]; then
        local note_ts
        note_ts=$(_epoch_to_note "$last_note_epoch")
        notes="[\"${note_ts}: Some progress note\"]"
    fi

    jq -nc \
        --arg id "$id" \
        --arg status "$status" \
        --arg priority "$priority" \
        --arg createdAt "$created_at" \
        --argjson notes "$notes" \
        '{
            id: $id,
            title: "Test task",
            description: "Test description",
            status: $status,
            priority: $priority,
            createdAt: $createdAt,
            notes: $notes
        }'
}

# Create a todo file with tasks for get_stale_tasks testing
_make_todo_file() {
    local file="$1"
    shift
    local tasks=()

    for task in "$@"; do
        tasks+=("$task")
    done

    # Build JSON array from tasks
    local tasks_json
    tasks_json=$(printf '%s\n' "${tasks[@]}" | jq -s '.')

    jq -nc --argjson tasks "$tasks_json" '{
        version: "1.0.0",
        tasks: $tasks
    }' > "$file"
}

# Custom config JSON for threshold testing
_make_config() {
    local pending="${1:-30}"
    local no_update="${2:-14}"
    local blocked="${3:-7}"
    local urgent="${4:-7}"

    jq -nc \
        --argjson pending "$pending" \
        --argjson noUpdate "$no_update" \
        --argjson blocked "$blocked" \
        --argjson urgent "$urgent" \
        '{
            pendingDays: $pending,
            noUpdateDays: $noUpdate,
            blockedDays: $blocked,
            urgentNeglectedDays: $urgent
        }'
}

# =============================================================================
# is_task_stale() Tests
# =============================================================================

@test "is_task_stale: returns 0 (stale) for task created 31 days ago" {
    local task
    task=$(_make_task "T001" "pending" "medium" "$OLD_EPOCH")

    run is_task_stale "$task"
    assert_success  # Exit 0 means stale
}

@test "is_task_stale: returns 0 (stale) for task created 29 days ago (no_updates)" {
    # Note: Task at 29 days with no notes has 29 days since update > 14 days threshold
    # So it IS stale via no_updates, even if not old_pending
    local task
    task=$(_make_task "T001" "pending" "medium" "$JUST_UNDER_PENDING_EPOCH")

    run is_task_stale "$task"
    assert_success  # Stale via no_updates
}

@test "is_task_stale: returns 1 (not stale) for task created 10 days ago with recent note" {
    # Task within all thresholds with recent activity
    local task
    local ten_days_ago=$((NOW_EPOCH - SECONDS_PER_DAY * 10))
    task=$(_make_task "T001" "pending" "medium" "$ten_days_ago" "$RECENT_EPOCH")

    run is_task_stale "$task"
    assert_failure 1  # Exit 1 means not stale
}

@test "is_task_stale: returns 0 (stale) for task with no notes for 15 days" {
    local task
    local old_note_epoch=$((NOW_EPOCH - SECONDS_PER_DAY * 15))
    task=$(_make_task "T001" "active" "medium" "$MONTH_AGO_EPOCH" "$old_note_epoch")

    run is_task_stale "$task"
    assert_success  # Stale due to no_updates
}

@test "is_task_stale: returns 1 (not stale) for task with recent notes" {
    local task
    task=$(_make_task "T001" "active" "medium" "$MONTH_AGO_EPOCH" "$RECENT_EPOCH")

    run is_task_stale "$task"
    assert_failure 1  # Not stale - has recent activity
}

@test "is_task_stale: returns 0 (stale) for blocked task for 8 days" {
    local task
    local blocked_note_epoch=$((NOW_EPOCH - SECONDS_PER_DAY * 8))
    task=$(_make_task "T001" "blocked" "medium" "$TWO_WEEKS_AGO_EPOCH" "$blocked_note_epoch")

    run is_task_stale "$task"
    assert_success  # Stale - long_blocked
}

@test "is_task_stale: returns 1 (not stale) for blocked task for 6 days" {
    local task
    task=$(_make_task "T001" "blocked" "medium" "$TWO_WEEKS_AGO_EPOCH" "$JUST_UNDER_BLOCKED_EPOCH")

    run is_task_stale "$task"
    assert_failure 1  # Not stale yet
}

@test "is_task_stale: returns 0 (stale) for high priority untouched 8 days" {
    local task
    local old_note_epoch=$((NOW_EPOCH - SECONDS_PER_DAY * 8))
    task=$(_make_task "T001" "active" "high" "$TWO_WEEKS_AGO_EPOCH" "$old_note_epoch")

    run is_task_stale "$task"
    assert_success  # Stale - urgent_neglected
}

@test "is_task_stale: returns 0 (stale) for critical priority untouched 8 days" {
    local task
    local old_note_epoch=$((NOW_EPOCH - SECONDS_PER_DAY * 8))
    task=$(_make_task "T001" "pending" "critical" "$TWO_WEEKS_AGO_EPOCH" "$old_note_epoch")

    run is_task_stale "$task"
    assert_success  # Stale - urgent_neglected
}

@test "is_task_stale: returns 1 (not stale) for low priority untouched 8 days (not urgent_neglected)" {
    local task
    local old_note_epoch=$((NOW_EPOCH - SECONDS_PER_DAY * 8))
    # Low priority should NOT trigger urgent_neglected, but might trigger no_updates
    # At 8 days, it's under the 14-day no_updates threshold
    task=$(_make_task "T001" "active" "low" "$WEEK_AGO_EPOCH" "$old_note_epoch")

    run is_task_stale "$task"
    assert_failure 1  # Not stale - low priority doesn't trigger urgent_neglected
}

@test "is_task_stale: returns 1 (not stale) for completed task" {
    local task
    task=$(jq -nc '{
        id: "T001",
        title: "Done task",
        description: "Completed",
        status: "done",
        priority: "high",
        createdAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-06-01T00:00:00Z"
    }')

    run is_task_stale "$task"
    assert_failure 1  # Completed tasks are never stale
}

@test "is_task_stale: returns 1 (not stale) for cancelled task" {
    local task
    task=$(jq -nc '{
        id: "T001",
        title: "Cancelled task",
        description: "Cancelled",
        status: "cancelled",
        priority: "critical",
        createdAt: "2024-01-01T00:00:00Z",
        cancelledAt: "2024-06-01T00:00:00Z"
    }')

    run is_task_stale "$task"
    assert_failure 1  # Cancelled tasks are never stale
}

@test "is_task_stale: returns 2 on invalid JSON input" {
    run is_task_stale "not valid json"
    assert_failure 2  # Error exit code
}

@test "is_task_stale: returns 2 on empty input" {
    run is_task_stale ""
    assert_failure 2  # Error exit code
}

# =============================================================================
# categorize_staleness() Tests
# =============================================================================

@test "categorize_staleness: returns old_pending for old pending tasks" {
    local task
    task=$(_make_task "T001" "pending" "medium" "$OLD_EPOCH")

    run categorize_staleness "$task"
    assert_success
    assert_output "old_pending"
}

@test "categorize_staleness: returns no_updates for tasks without recent updates" {
    local task
    local old_note_epoch=$((NOW_EPOCH - SECONDS_PER_DAY * 16))
    task=$(_make_task "T001" "active" "low" "$MONTH_AGO_EPOCH" "$old_note_epoch")

    run categorize_staleness "$task"
    assert_success
    assert_output "no_updates"
}

@test "categorize_staleness: returns long_blocked for long-blocked tasks" {
    local task
    local old_note_epoch=$((NOW_EPOCH - SECONDS_PER_DAY * 10))
    task=$(_make_task "T001" "blocked" "medium" "$TWO_WEEKS_AGO_EPOCH" "$old_note_epoch")

    run categorize_staleness "$task"
    assert_success
    assert_output "long_blocked"
}

@test "categorize_staleness: returns urgent_neglected for neglected high-priority tasks" {
    local task
    local old_note_epoch=$((NOW_EPOCH - SECONDS_PER_DAY * 10))
    task=$(_make_task "T001" "active" "high" "$TWO_WEEKS_AGO_EPOCH" "$old_note_epoch")

    run categorize_staleness "$task"
    assert_success
    assert_output "urgent_neglected"
}

@test "categorize_staleness: returns null for fresh tasks" {
    local task
    task=$(_make_task "T001" "pending" "medium" "$RECENT_EPOCH")

    run categorize_staleness "$task"
    assert_success
    assert_output "null"
}

@test "categorize_staleness: returns most severe (urgent_neglected over old_pending)" {
    # Task that is both old pending AND urgent neglected (high priority)
    # Should return urgent_neglected as it's most severe
    local task
    local old_note_epoch=$((NOW_EPOCH - SECONDS_PER_DAY * 10))
    task=$(_make_task "T001" "pending" "critical" "$OLD_EPOCH" "$old_note_epoch")

    run categorize_staleness "$task"
    assert_success
    assert_output "urgent_neglected"
}

@test "categorize_staleness: returns most severe (long_blocked over old_pending)" {
    # Blocked task that is also old
    local task
    local old_note_epoch=$((NOW_EPOCH - SECONDS_PER_DAY * 10))
    task=$(_make_task "T001" "blocked" "medium" "$OLD_EPOCH" "$old_note_epoch")

    run categorize_staleness "$task"
    assert_success
    assert_output "long_blocked"
}

@test "categorize_staleness: respects custom config thresholds" {
    local task
    # Task 5 days old - normally not stale with 30-day threshold
    local five_days_ago=$((NOW_EPOCH - SECONDS_PER_DAY * 5))
    task=$(_make_task "T001" "pending" "medium" "$five_days_ago")

    # Custom config with 3-day pending threshold
    local config
    config=$(_make_config 3 14 7 7)

    run categorize_staleness "$task" "$config"
    assert_success
    assert_output "old_pending"
}

@test "categorize_staleness: task at exactly 30 days with no notes is no_updates" {
    # Task at exactly 30 days uses > comparison, so NOT old_pending (30 > 30 = false)
    # But with no notes, 30 days since update > 14 days threshold = no_updates
    local task
    task=$(_make_task "T001" "pending" "medium" "$PENDING_THRESHOLD_EPOCH")

    run categorize_staleness "$task"
    assert_success
    # Returns no_updates because 30 days > 14 days no_update threshold
    assert_output "no_updates"
}

@test "categorize_staleness: task at exactly 30 days with recent note is not stale" {
    # Task at exactly 30 days pending with recent activity should NOT be stale
    local task
    task=$(_make_task "T001" "pending" "medium" "$PENDING_THRESHOLD_EPOCH" "$RECENT_EPOCH")

    run categorize_staleness "$task"
    assert_success
    assert_output "null"
}

@test "categorize_staleness: task at 31 days is stale" {
    local task
    local thirty_one_days=$((NOW_EPOCH - SECONDS_PER_DAY * 31))
    task=$(_make_task "T001" "pending" "medium" "$thirty_one_days")

    run categorize_staleness "$task"
    assert_success
    assert_output "old_pending"
}

@test "categorize_staleness: returns null for done tasks" {
    local task
    task=$(jq -nc '{
        id: "T001",
        status: "done",
        priority: "high",
        createdAt: "2024-01-01T00:00:00Z"
    }')

    run categorize_staleness "$task"
    assert_success
    assert_output "null"
}

@test "categorize_staleness: returns null for cancelled tasks" {
    local task
    task=$(jq -nc '{
        id: "T001",
        status: "cancelled",
        priority: "critical",
        createdAt: "2024-01-01T00:00:00Z"
    }')

    run categorize_staleness "$task"
    assert_success
    assert_output "null"
}

@test "categorize_staleness: returns error on invalid JSON" {
    run categorize_staleness "invalid json"
    assert_failure 1
    assert_output --partial "ERROR"
}

# =============================================================================
# get_staleness_metadata() Tests
# =============================================================================

@test "get_staleness_metadata: returns null for fresh task" {
    local task
    task=$(_make_task "T001" "pending" "medium" "$RECENT_EPOCH")

    run get_staleness_metadata "$task"
    assert_success
    assert_output "null"
}

@test "get_staleness_metadata: returns metadata for stale task" {
    local task
    task=$(_make_task "T001" "pending" "medium" "$OLD_EPOCH")

    run get_staleness_metadata "$task"
    assert_success

    # Verify JSON structure
    echo "$output" | jq -e '.type == "old_pending"' > /dev/null
    echo "$output" | jq -e 'has("daysSinceCreated")' > /dev/null
    echo "$output" | jq -e 'has("daysSinceUpdate")' > /dev/null
    echo "$output" | jq -e 'has("reason")' > /dev/null
}

@test "get_staleness_metadata: reason message includes days for old_pending" {
    local task
    task=$(_make_task "T001" "pending" "medium" "$OLD_EPOCH")

    run get_staleness_metadata "$task"
    assert_success

    echo "$output" | jq -e '.reason | contains("days ago")' > /dev/null
}

@test "get_staleness_metadata: reason message includes priority for urgent_neglected" {
    local task
    local old_note_epoch=$((NOW_EPOCH - SECONDS_PER_DAY * 10))
    task=$(_make_task "T001" "active" "critical" "$TWO_WEEKS_AGO_EPOCH" "$old_note_epoch")

    run get_staleness_metadata "$task"
    assert_success

    echo "$output" | jq -e '.type == "urgent_neglected"' > /dev/null
    echo "$output" | jq -e '.reason | contains("CRITICAL")' > /dev/null
}

@test "get_staleness_metadata: reason message for long_blocked mentions blocked" {
    local task
    local old_note_epoch=$((NOW_EPOCH - SECONDS_PER_DAY * 10))
    task=$(_make_task "T001" "blocked" "medium" "$TWO_WEEKS_AGO_EPOCH" "$old_note_epoch")

    run get_staleness_metadata "$task"
    assert_success

    echo "$output" | jq -e '.type == "long_blocked"' > /dev/null
    echo "$output" | jq -e '.reason | contains("Blocked")' > /dev/null
}

@test "get_staleness_metadata: returns null for done task" {
    local task
    task=$(jq -nc '{
        id: "T001",
        status: "done",
        priority: "high",
        createdAt: "2024-01-01T00:00:00Z"
    }')

    run get_staleness_metadata "$task"
    assert_success
    assert_output "null"
}

@test "get_staleness_metadata: returns error on invalid input" {
    run get_staleness_metadata ""
    assert_failure 1
    assert_output --partial "ERROR"
}

# =============================================================================
# get_stale_tasks() Tests
# =============================================================================

@test "get_stale_tasks: returns empty array when no stale tasks" {
    local task1 task2
    task1=$(_make_task "T001" "pending" "medium" "$RECENT_EPOCH")
    task2=$(_make_task "T002" "active" "high" "$WEEK_AGO_EPOCH" "$RECENT_EPOCH")

    local todo_file="${STALENESS_FIXTURES}/no-stale.json"
    _make_todo_file "$todo_file" "$task1" "$task2"

    run get_stale_tasks "$todo_file"
    assert_success

    # Should be empty array
    local count
    count=$(echo "$output" | jq 'length')
    [[ "$count" -eq 0 ]]
}

@test "get_stale_tasks: returns all stale tasks with metadata" {
    local task1 task2 task3
    task1=$(_make_task "T001" "pending" "medium" "$RECENT_EPOCH")  # Fresh
    task2=$(_make_task "T002" "pending" "low" "$OLD_EPOCH")  # Stale - old_pending
    task3=$(_make_task "T003" "blocked" "medium" "$TWO_WEEKS_AGO_EPOCH" "$((NOW_EPOCH - SECONDS_PER_DAY * 10))")  # Stale - long_blocked

    local todo_file="${STALENESS_FIXTURES}/mixed.json"
    _make_todo_file "$todo_file" "$task1" "$task2" "$task3"

    run get_stale_tasks "$todo_file"
    assert_success

    # Should have 2 stale tasks
    local count
    count=$(echo "$output" | jq 'length')
    [[ "$count" -eq 2 ]]

    # Verify structure
    echo "$output" | jq -e '.[0] | has("taskId")' > /dev/null
    echo "$output" | jq -e '.[0] | has("staleness")' > /dev/null
    echo "$output" | jq -e '.[0].staleness | has("type")' > /dev/null
}

@test "get_stale_tasks: respects custom config thresholds" {
    local task1 task2
    local three_days_ago=$((NOW_EPOCH - SECONDS_PER_DAY * 3))
    task1=$(_make_task "T001" "pending" "medium" "$three_days_ago")  # 3 days old
    task2=$(_make_task "T002" "pending" "low" "$RECENT_EPOCH")  # Fresh

    local todo_file="${STALENESS_FIXTURES}/custom-config.json"
    _make_todo_file "$todo_file" "$task1" "$task2"

    # With custom config: 2-day pending threshold
    local config
    config=$(_make_config 2 14 7 7)

    run get_stale_tasks "$todo_file" "$config"
    assert_success

    # T001 should now be stale (3 days > 2 days)
    local count
    count=$(echo "$output" | jq 'length')
    [[ "$count" -eq 1 ]]

    echo "$output" | jq -e '.[0].taskId == "T001"' > /dev/null
}

@test "get_stale_tasks: sorts by severity (urgent_neglected first)" {
    local task1 task2 task3
    local old_note_epoch=$((NOW_EPOCH - SECONDS_PER_DAY * 10))
    task1=$(_make_task "T001" "pending" "low" "$OLD_EPOCH")  # old_pending
    task2=$(_make_task "T002" "active" "critical" "$TWO_WEEKS_AGO_EPOCH" "$old_note_epoch")  # urgent_neglected
    task3=$(_make_task "T003" "blocked" "medium" "$TWO_WEEKS_AGO_EPOCH" "$old_note_epoch")  # long_blocked

    local todo_file="${STALENESS_FIXTURES}/sorted.json"
    _make_todo_file "$todo_file" "$task1" "$task2" "$task3"

    run get_stale_tasks "$todo_file"
    assert_success

    # urgent_neglected should be first
    echo "$output" | jq -e '.[0].staleness.type == "urgent_neglected"' > /dev/null
    # long_blocked should be second
    echo "$output" | jq -e '.[1].staleness.type == "long_blocked"' > /dev/null
    # old_pending should be last
    echo "$output" | jq -e '.[2].staleness.type == "old_pending"' > /dev/null
}

@test "get_stale_tasks: excludes done tasks" {
    local task1 task2
    task1=$(jq -nc '{
        id: "T001",
        title: "Done old task",
        description: "Should not appear",
        status: "done",
        priority: "critical",
        createdAt: "2024-01-01T00:00:00Z"
    }')
    task2=$(_make_task "T002" "pending" "medium" "$OLD_EPOCH")  # Stale

    local todo_file="${STALENESS_FIXTURES}/with-done.json"
    _make_todo_file "$todo_file" "$task1" "$task2"

    run get_stale_tasks "$todo_file"
    assert_success

    # Only T002 should be in results
    local count
    count=$(echo "$output" | jq 'length')
    [[ "$count" -eq 1 ]]

    echo "$output" | jq -e '.[0].taskId == "T002"' > /dev/null
}

@test "get_stale_tasks: excludes cancelled tasks" {
    local task1 task2
    task1=$(jq -nc '{
        id: "T001",
        title: "Cancelled old task",
        description: "Should not appear",
        status: "cancelled",
        priority: "critical",
        createdAt: "2024-01-01T00:00:00Z"
    }')
    task2=$(_make_task "T002" "pending" "medium" "$OLD_EPOCH")  # Stale

    local todo_file="${STALENESS_FIXTURES}/with-cancelled.json"
    _make_todo_file "$todo_file" "$task1" "$task2"

    run get_stale_tasks "$todo_file"
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    [[ "$count" -eq 1 ]]
}

@test "get_stale_tasks: returns error for missing file" {
    run get_stale_tasks "/nonexistent/file.json"
    assert_failure 1
    assert_output --partial "ERROR"
}

@test "get_stale_tasks: handles missing timestamps gracefully" {
    # Task with no createdAt - should use now as fallback
    local task
    task=$(jq -nc '{
        id: "T001",
        title: "No timestamp task",
        description: "Missing createdAt",
        status: "pending",
        priority: "medium",
        notes: []
    }')

    local todo_file="${STALENESS_FIXTURES}/no-timestamp.json"
    _make_todo_file "$todo_file" "$task"

    run get_stale_tasks "$todo_file"
    assert_success

    # Should return empty since task uses "now" as createdAt fallback
    local count
    count=$(echo "$output" | jq 'length')
    [[ "$count" -eq 0 ]]
}

@test "get_stale_tasks: handles null createdAt gracefully" {
    local task
    task=$(jq -nc '{
        id: "T001",
        title: "Null timestamp task",
        description: "Null createdAt",
        status: "pending",
        priority: "medium",
        createdAt: null,
        notes: []
    }')

    local todo_file="${STALENESS_FIXTURES}/null-timestamp.json"
    _make_todo_file "$todo_file" "$task"

    run get_stale_tasks "$todo_file"
    assert_success

    # Should not crash - uses now as fallback
    local count
    count=$(echo "$output" | jq 'length')
    [[ "$count" -eq 0 ]]
}

@test "get_stale_tasks: handles empty notes array" {
    local task
    task=$(_make_task "T001" "pending" "medium" "$OLD_EPOCH")

    local todo_file="${STALENESS_FIXTURES}/empty-notes.json"
    _make_todo_file "$todo_file" "$task"

    run get_stale_tasks "$todo_file"
    assert_success

    # Task with empty notes should use createdAt as last update
    local count
    count=$(echo "$output" | jq 'length')
    [[ "$count" -eq 1 ]]
}

@test "get_stale_tasks: handles object-format notes with timestamp" {
    local created_at updated_at
    created_at=$(_epoch_to_iso "$MONTH_AGO_EPOCH")
    updated_at=$(_epoch_to_iso "$RECENT_EPOCH")

    local task
    task=$(jq -nc \
        --arg createdAt "$created_at" \
        --arg updatedAt "$updated_at" \
        '{
            id: "T001",
            title: "Object notes task",
            description: "Has object notes",
            status: "active",
            priority: "medium",
            createdAt: $createdAt,
            notes: [{
                timestamp: $updatedAt,
                content: "Recent update"
            }]
        }')

    local todo_file="${STALENESS_FIXTURES}/object-notes.json"
    _make_todo_file "$todo_file" "$task"

    run get_stale_tasks "$todo_file"
    assert_success

    # Task has recent update via object note - should not be stale
    local count
    count=$(echo "$output" | jq 'length')
    [[ "$count" -eq 0 ]]
}

# =============================================================================
# Configuration Getter Tests
# =============================================================================

@test "get_stale_pending_days: returns default 30" {
    run get_stale_pending_days
    assert_success
    assert_output "30"
}

@test "get_stale_no_update_days: returns default 14" {
    run get_stale_no_update_days
    assert_success
    assert_output "14"
}

@test "get_stale_blocked_days: returns default 7" {
    run get_stale_blocked_days
    assert_success
    assert_output "7"
}

@test "get_stale_urgent_neglected_days: returns default 7" {
    run get_stale_urgent_neglected_days
    assert_success
    assert_output "7"
}

@test "get_stale_detection_enabled: returns true by default" {
    run get_stale_detection_enabled
    assert_success
    assert_output "true"
}

@test "get_stale_detection_config: returns complete config object" {
    run get_stale_detection_config
    assert_success

    # Verify all fields present
    echo "$output" | jq -e 'has("enabled")' > /dev/null
    echo "$output" | jq -e 'has("pendingDays")' > /dev/null
    echo "$output" | jq -e 'has("noUpdateDays")' > /dev/null
    echo "$output" | jq -e 'has("blockedDays")' > /dev/null
    echo "$output" | jq -e 'has("urgentNeglectedDays")' > /dev/null

    # Verify default values
    echo "$output" | jq -e '.enabled == true' > /dev/null
    echo "$output" | jq -e '.pendingDays == 30' > /dev/null
    echo "$output" | jq -e '.noUpdateDays == 14' > /dev/null
    echo "$output" | jq -e '.blockedDays == 7' > /dev/null
    echo "$output" | jq -e '.urgentNeglectedDays == 7' > /dev/null
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "edge case: blocked high-priority task is long_blocked not urgent_neglected" {
    # Blocked tasks should be long_blocked, not urgent_neglected
    # Even if they're high priority
    local task
    local old_note_epoch=$((NOW_EPOCH - SECONDS_PER_DAY * 10))
    task=$(_make_task "T001" "blocked" "high" "$TWO_WEEKS_AGO_EPOCH" "$old_note_epoch")

    run categorize_staleness "$task"
    assert_success
    assert_output "long_blocked"  # NOT urgent_neglected
}

@test "edge case: mixed note formats in single task" {
    local created_at old_note_ts recent_ts
    created_at=$(_epoch_to_iso "$MONTH_AGO_EPOCH")
    old_note_ts=$(_epoch_to_note "$OLD_EPOCH")
    recent_ts=$(_epoch_to_iso "$RECENT_EPOCH")

    local task
    task=$(jq -nc \
        --arg createdAt "$created_at" \
        --arg oldNote "${old_note_ts}: Old string note" \
        --arg recentTs "$recent_ts" \
        '{
            id: "T001",
            title: "Mixed notes task",
            description: "Both string and object notes",
            status: "active",
            priority: "medium",
            createdAt: $createdAt,
            notes: [
                $oldNote,
                {
                    timestamp: $recentTs,
                    content: "Recent object note"
                }
            ]
        }')

    run is_task_stale "$task"
    # Should find the most recent note (object format) and not be stale
    assert_failure 1  # Not stale
}

@test "edge case: very old task with very recent update is not stale" {
    local task
    # Task created 100 days ago but updated yesterday
    local very_old=$((NOW_EPOCH - SECONDS_PER_DAY * 100))
    local yesterday=$((NOW_EPOCH - SECONDS_PER_DAY * 1))
    task=$(_make_task "T001" "active" "medium" "$very_old" "$yesterday")

    run is_task_stale "$task"
    assert_failure 1  # Not stale due to recent update
}

@test "edge case: active task without notes uses createdAt for last_update" {
    local task
    # Old task with no notes - should be stale via no_updates
    task=$(_make_task "T001" "active" "medium" "$OLD_EPOCH")

    run categorize_staleness "$task"
    assert_success
    # Old active task with no notes should be no_updates (not old_pending since it's active)
    assert_output "no_updates"
}

# =============================================================================
# Performance Tests (optional - skip in CI if needed)
# =============================================================================

@test "performance: get_stale_tasks handles 100 tasks efficiently" {
    # Create 100 tasks
    local tasks=()
    for i in $(seq 1 100); do
        local status="pending"
        local priority="medium"
        local created_epoch="$RECENT_EPOCH"

        # Make every 10th task stale
        if (( i % 10 == 0 )); then
            created_epoch="$OLD_EPOCH"
        fi

        local task
        task=$(_make_task "T$(printf '%03d' $i)" "$status" "$priority" "$created_epoch")
        tasks+=("$task")
    done

    local todo_file="${STALENESS_FIXTURES}/large.json"
    _make_todo_file "$todo_file" "${tasks[@]}"

    # Should complete in reasonable time
    local start_time
    start_time=$(date +%s)

    run get_stale_tasks "$todo_file"
    assert_success

    local end_time
    end_time=$(date +%s)
    local duration=$((end_time - start_time))

    # Should complete in under 5 seconds
    [[ "$duration" -lt 5 ]]

    # Should have 10 stale tasks
    local count
    count=$(echo "$output" | jq 'length')
    [[ "$count" -eq 10 ]]
}
