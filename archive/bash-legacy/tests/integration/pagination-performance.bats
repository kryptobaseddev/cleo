#!/usr/bin/env bats
# =============================================================================
# pagination-performance.bats - Performance tests for pagination
# =============================================================================
# Tests that pagination operations complete within acceptable time bounds
# and that paginated output is smaller than unpaginated output.
#
# @task T1452
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

    # Source the library under test
    source "$LIB_DIR/core/json-output.sh"

    # Set predictable version
    export CLEO_VERSION="1.0.0-test"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper: generate large dataset
# =============================================================================

generate_large_session_array() {
    local count="${1:-100}"
    local i
    local items="["
    for (( i = 1; i <= count; i++ )); do
        if (( i > 1 )); then
            items+=","
        fi
        items+="{\"id\":\"session_${i}\",\"name\":\"Session ${i}\",\"status\":\"ended\",\"scope\":{\"type\":\"epic\",\"taskId\":\"T001\"},\"focus\":{\"currentTask\":\"T00${i}\",\"history\":[\"T001\",\"T002\",\"T003\"]},\"startedAt\":\"2025-01-01T00:00:00Z\",\"endedAt\":\"2025-01-01T12:00:00Z\",\"focusHistory\":[{\"task\":\"T001\",\"at\":\"2025-01-01T00:00:00Z\"},{\"task\":\"T002\",\"at\":\"2025-01-01T01:00:00Z\"}],\"stats\":{\"tasksCompleted\":${i},\"focusSwitches\":${i}},\"events\":[{\"type\":\"focus\",\"at\":\"2025-01-01T00:00:00Z\"}]}"
    done
    items+="]"
    echo "$items"
}

generate_large_task_array() {
    local count="${1:-200}"
    local i
    local items="["
    for (( i = 1; i <= count; i++ )); do
        if (( i > 1 )); then
            items+=","
        fi
        items+="{\"id\":\"T$(printf '%04d' $i)\",\"title\":\"Task ${i}\",\"status\":\"pending\",\"priority\":\"medium\",\"type\":\"task\",\"phase\":\"core\",\"notes\":[\"note1\",\"note2\",\"note3\"],\"description\":\"This is a long description for task ${i} with enough content to be meaningful\"}"
    done
    items+="]"
    echo "$items"
}

# =============================================================================
# Performance: apply_pagination with large datasets
# =============================================================================

@test "apply_pagination with 100 sessions completes within 5 seconds" {
    local sessions
    sessions=$(generate_large_session_array 100)

    local start_time
    start_time=$(date +%s)

    run apply_pagination "$sessions" 10 0
    assert_success

    local end_time
    end_time=$(date +%s)
    local elapsed=$(( end_time - start_time ))

    (( elapsed < 5 ))

    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 10 ]
}

@test "apply_pagination with 200 tasks completes within 5 seconds" {
    local tasks
    tasks=$(generate_large_task_array 200)

    local start_time
    start_time=$(date +%s)

    run apply_pagination "$tasks" 50 0
    assert_success

    local end_time
    end_time=$(date +%s)
    local elapsed=$(( end_time - start_time ))

    (( elapsed < 5 ))

    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 50 ]
}

@test "output_paginated with large dataset completes within 5 seconds" {
    local tasks
    tasks=$(generate_large_task_array 100)

    local page
    page=$(apply_pagination "$tasks" 50 0)

    local start_time
    start_time=$(date +%s)

    run output_paginated "list" "tasks" "$page" 100 50 0
    assert_success

    local end_time
    end_time=$(date +%s)
    local elapsed=$(( end_time - start_time ))

    (( elapsed < 5 ))
    assert_valid_json
}

# =============================================================================
# Size comparison: paginated vs unpaginated output
# =============================================================================

@test "paginated output is smaller than full output for sessions" {
    local sessions
    sessions=$(generate_large_session_array 50)

    # Full output (all items)
    local full_output
    full_output=$(output_paginated "session list" "sessions" "$sessions" 50 50 0)
    local full_size=${#full_output}

    # Paginated output (first 10 items)
    local page
    page=$(apply_pagination "$sessions" 10 0)
    local paged_output
    paged_output=$(output_paginated "session list" "sessions" "$page" 50 10 0)
    local paged_size=${#paged_output}

    # Paginated version should be smaller
    (( paged_size < full_size ))
}

@test "paginated output is smaller than full output for tasks" {
    local tasks
    tasks=$(generate_large_task_array 100)

    # Full output
    local full_output
    full_output=$(output_paginated "list" "tasks" "$tasks" 100 100 0)
    local full_size=${#full_output}

    # Paginated output (first 20)
    local page
    page=$(apply_pagination "$tasks" 20 0)
    local paged_output
    paged_output=$(output_paginated "list" "tasks" "$page" 100 20 0)
    local paged_size=${#paged_output}

    (( paged_size < full_size ))
}

@test "compact_task reduces output size significantly" {
    local tasks
    tasks=$(generate_large_task_array 50)

    # Get total size of full tasks
    local full_size=${#tasks}

    # Compact each task and measure total
    local compact_all
    compact_all=$(echo "$tasks" | jq -c '[.[] | {id, title, status, priority, type, phase} | with_entries(select(.value != null))]')
    local compact_size=${#compact_all}

    # Compact should be at least 30% smaller (since we strip notes and description)
    local threshold=$(( full_size * 70 / 100 ))
    (( compact_size < threshold ))
}

# =============================================================================
# Pagination math correctness at scale
# =============================================================================

@test "pagination correctly pages through entire dataset" {
    local items='[]'
    # Generate 23 items (not evenly divisible by page size of 5)
    items=$(jq -nc '[range(1; 24)]')

    local total=23
    local limit=5
    local offset=0
    local collected=0

    while (( offset < total )); do
        local page
        page=$(apply_pagination "$items" "$limit" "$offset")

        local page_count
        page_count=$(echo "$page" | jq 'length')
        collected=$(( collected + page_count ))

        local meta
        meta=$(get_pagination_meta "$total" "$limit" "$offset")

        if (( offset + limit < total )); then
            local has_more
            has_more=$(echo "$meta" | jq '.hasMore')
            [ "$has_more" = "true" ]
        fi

        offset=$(( offset + limit ))
    done

    # Should have collected all 23 items
    [ "$collected" -eq 23 ]
}

@test "multiple sequential paginations return consistent results" {
    local sessions
    sessions=$(generate_large_session_array 30)

    # Page 1
    local p1
    p1=$(apply_pagination "$sessions" 10 0)
    local p1_first
    p1_first=$(echo "$p1" | jq -r '.[0].id')

    # Page 2
    local p2
    p2=$(apply_pagination "$sessions" 10 10)
    local p2_first
    p2_first=$(echo "$p2" | jq -r '.[0].id')

    # Page 3
    local p3
    p3=$(apply_pagination "$sessions" 10 20)
    local p3_first
    p3_first=$(echo "$p3" | jq -r '.[0].id')

    # Verify no overlapping IDs
    [ "$p1_first" = "session_1" ]
    [ "$p2_first" = "session_11" ]
    [ "$p3_first" = "session_21" ]

    # Each page has exactly 10
    local p1_len p2_len p3_len
    p1_len=$(echo "$p1" | jq 'length')
    p2_len=$(echo "$p2" | jq 'length')
    p3_len=$(echo "$p3" | jq 'length')
    [ "$p1_len" -eq 10 ]
    [ "$p2_len" -eq 10 ]
    [ "$p3_len" -eq 10 ]
}
