#!/usr/bin/env bats
# =============================================================================
# json-output.bats - Unit tests for lib/core/json-output.sh
# =============================================================================
# Tests all exported functions: output_success, output_error_envelope,
# output_paginated, apply_pagination, get_pagination_meta, get_default_limit,
# compact_task, compact_session.
#
# @task T1450
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

    # Set a predictable version for tests
    export CLEO_VERSION="1.0.0-test"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Library Loading Tests
# =============================================================================

@test "json-output.sh exists" {
    [ -f "$LIB_DIR/core/json-output.sh" ]
}

@test "json-output.sh can be sourced" {
    run bash -c "source '$LIB_DIR/core/json-output.sh'"
    assert_success
}

@test "json-output.sh exports all declared functions" {
    declare -F output_success
    declare -F output_error_envelope
    declare -F output_paginated
    declare -F apply_pagination
    declare -F get_pagination_meta
    declare -F get_default_limit
    declare -F compact_task
    declare -F compact_session
}

@test "source guard prevents double loading" {
    run bash -c "source '$LIB_DIR/core/json-output.sh'; source '$LIB_DIR/core/json-output.sh'"
    assert_success
}

# =============================================================================
# output_success Tests
# =============================================================================

@test "output_success produces valid JSON" {
    run output_success "show" "task" '{"id":"T001","title":"Test"}'
    assert_success
    assert_valid_json
}

@test "output_success has correct schema field" {
    run output_success "show" "task" '{"id":"T001"}'
    assert_success

    local schema
    schema=$(echo "$output" | jq -r '.["$schema"]')
    [ "$schema" = "https://cleo-dev.com/schemas/v1/output.schema.json" ]
}

@test "output_success has correct _meta.command" {
    run output_success "list" "tasks" '[]'
    assert_success

    local cmd
    cmd=$(echo "$output" | jq -r '._meta.command')
    [ "$cmd" = "list" ]
}

@test "output_success has correct _meta.version" {
    run output_success "show" "task" '{"id":"T001"}'
    assert_success

    local ver
    ver=$(echo "$output" | jq -r '._meta.version')
    [ "$ver" = "1.0.0-test" ]
}

@test "output_success has _meta.timestamp in ISO format" {
    run output_success "show" "task" '{"id":"T001"}'
    assert_success

    local ts
    ts=$(echo "$output" | jq -r '._meta.timestamp')
    [[ "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

@test "output_success has _meta.format set to json" {
    run output_success "show" "task" '{"id":"T001"}'
    assert_success

    local fmt
    fmt=$(echo "$output" | jq -r '._meta.format')
    [ "$fmt" = "json" ]
}

@test "output_success has success=true" {
    run output_success "show" "task" '{"id":"T001"}'
    assert_success

    local success
    success=$(echo "$output" | jq -r '.success')
    [ "$success" = "true" ]
}

@test "output_success injects data under specified key" {
    run output_success "list" "tasks" '[{"id":"T001"},{"id":"T002"}]'
    assert_success

    local count
    count=$(echo "$output" | jq '.tasks | length')
    [ "$count" -eq 2 ]
}

@test "output_success handles object data" {
    run output_success "show" "task" '{"id":"T001","title":"My Task"}'
    assert_success

    local title
    title=$(echo "$output" | jq -r '.task.title')
    [ "$title" = "My Task" ]
}

@test "output_success handles empty array data" {
    run output_success "list" "tasks" '[]'
    assert_success

    local count
    count=$(echo "$output" | jq '.tasks | length')
    [ "$count" -eq 0 ]
}

@test "output_success handles string data" {
    run output_success "version" "version" '"1.0.0"'
    assert_success

    local ver
    ver=$(echo "$output" | jq -r '.version')
    [ "$ver" = "1.0.0" ]
}

@test "output_success handles numeric data" {
    run output_success "count" "total" '42'
    assert_success

    local total
    total=$(echo "$output" | jq '.total')
    [ "$total" -eq 42 ]
}

@test "output_success handles boolean data" {
    run output_success "exists" "exists" 'true'
    assert_success

    local exists
    exists=$(echo "$output" | jq '.exists')
    [ "$exists" = "true" ]
}

# =============================================================================
# output_error_envelope Tests
# =============================================================================

@test "output_error_envelope produces valid JSON" {
    run output_error_envelope "show" "E_TASK_NOT_FOUND" "Task T999 not found"
    assert_success
    assert_valid_json
}

@test "output_error_envelope has error schema" {
    run output_error_envelope "show" "E_TASK_NOT_FOUND" "Task T999 not found"
    assert_success

    local schema
    schema=$(echo "$output" | jq -r '.["$schema"]')
    [ "$schema" = "https://cleo-dev.com/schemas/v1/error.schema.json" ]
}

@test "output_error_envelope has success=false" {
    run output_error_envelope "show" "E_TASK_NOT_FOUND" "Task T999 not found"
    assert_success

    local success
    success=$(echo "$output" | jq -r '.success')
    [ "$success" = "false" ]
}

@test "output_error_envelope has correct error.code" {
    run output_error_envelope "show" "E_TASK_NOT_FOUND" "Task T999 not found"
    assert_success

    local code
    code=$(echo "$output" | jq -r '.error.code')
    [ "$code" = "E_TASK_NOT_FOUND" ]
}

@test "output_error_envelope has correct error.message" {
    run output_error_envelope "show" "E_TASK_NOT_FOUND" "Task T999 not found"
    assert_success

    local msg
    msg=$(echo "$output" | jq -r '.error.message')
    [ "$msg" = "Task T999 not found" ]
}

@test "output_error_envelope has correct _meta.command" {
    run output_error_envelope "find" "E_NO_RESULTS" "No results"
    assert_success

    local cmd
    cmd=$(echo "$output" | jq -r '._meta.command')
    [ "$cmd" = "find" ]
}

@test "output_error_envelope has _meta.timestamp" {
    run output_error_envelope "show" "E_TASK_NOT_FOUND" "Not found"
    assert_success

    local ts
    ts=$(echo "$output" | jq -r '._meta.timestamp')
    [[ "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]]
}

@test "output_error_envelope has _meta.version" {
    run output_error_envelope "show" "E_TASK_NOT_FOUND" "Not found"
    assert_success

    local ver
    ver=$(echo "$output" | jq -r '._meta.version')
    [ "$ver" = "1.0.0-test" ]
}

# =============================================================================
# output_paginated Tests
# =============================================================================

@test "output_paginated produces valid JSON" {
    run output_paginated "list" "tasks" '[{"id":"T001"}]' 10 5 0
    assert_success
    assert_valid_json
}

@test "output_paginated has pagination block" {
    run output_paginated "list" "tasks" '[{"id":"T001"}]' 10 5 0
    assert_success

    local has_pagination
    has_pagination=$(echo "$output" | jq 'has("pagination")')
    [ "$has_pagination" = "true" ]
}

@test "output_paginated has correct pagination.total" {
    run output_paginated "list" "tasks" '[{"id":"T001"}]' 150 50 0
    assert_success

    local total
    total=$(echo "$output" | jq '.pagination.total')
    [ "$total" -eq 150 ]
}

@test "output_paginated has correct pagination.limit" {
    run output_paginated "list" "tasks" '[{"id":"T001"}]' 150 50 0
    assert_success

    local limit
    limit=$(echo "$output" | jq '.pagination.limit')
    [ "$limit" -eq 50 ]
}

@test "output_paginated has correct pagination.offset" {
    run output_paginated "list" "tasks" '[{"id":"T001"}]' 150 50 25
    assert_success

    local offset
    offset=$(echo "$output" | jq '.pagination.offset')
    [ "$offset" -eq 25 ]
}

@test "output_paginated has hasMore=true when more items remain" {
    run output_paginated "list" "tasks" '[{"id":"T001"}]' 150 50 0
    assert_success

    local has_more
    has_more=$(echo "$output" | jq '.pagination.hasMore')
    [ "$has_more" = "true" ]
}

@test "output_paginated has hasMore=false when no more items" {
    run output_paginated "list" "tasks" '[{"id":"T001"}]' 10 50 0
    assert_success

    local has_more
    has_more=$(echo "$output" | jq '.pagination.hasMore')
    [ "$has_more" = "false" ]
}

@test "output_paginated has hasMore=false at exact boundary" {
    # offset(50) + limit(50) = 100 = total(100) => hasMore=false
    run output_paginated "list" "tasks" '[]' 100 50 50
    assert_success

    local has_more
    has_more=$(echo "$output" | jq '.pagination.hasMore')
    [ "$has_more" = "false" ]
}

@test "output_paginated has hasMore=true just before boundary" {
    # offset(49) + limit(50) = 99 < total(100) => hasMore=true
    run output_paginated "list" "tasks" '[]' 100 50 49
    assert_success

    local has_more
    has_more=$(echo "$output" | jq '.pagination.hasMore')
    [ "$has_more" = "true" ]
}

@test "output_paginated has success=true" {
    run output_paginated "list" "tasks" '[]' 0 50 0
    assert_success

    local success
    success=$(echo "$output" | jq '.success')
    [ "$success" = "true" ]
}

@test "output_paginated injects data under specified key" {
    run output_paginated "session list" "sessions" '[{"id":"s1"},{"id":"s2"}]' 5 10 0
    assert_success

    local count
    count=$(echo "$output" | jq '.sessions | length')
    [ "$count" -eq 2 ]
}

@test "output_paginated has correct _meta fields" {
    run output_paginated "list" "tasks" '[]' 0 50 0
    assert_success

    local cmd
    cmd=$(echo "$output" | jq -r '._meta.command')
    [ "$cmd" = "list" ]

    local fmt
    fmt=$(echo "$output" | jq -r '._meta.format')
    [ "$fmt" = "json" ]
}

# =============================================================================
# apply_pagination Tests
# =============================================================================

@test "apply_pagination slices from beginning with limit" {
    local items='[1,2,3,4,5,6,7,8,9,10]'
    run apply_pagination "$items" 5 0
    assert_success

    local result
    result=$(echo "$output" | jq 'length')
    [ "$result" -eq 5 ]

    local first
    first=$(echo "$output" | jq '.[0]')
    [ "$first" -eq 1 ]

    local last
    last=$(echo "$output" | jq '.[-1]')
    [ "$last" -eq 5 ]
}

@test "apply_pagination slices with offset" {
    local items='[1,2,3,4,5,6,7,8,9,10]'
    run apply_pagination "$items" 5 3
    assert_success

    local result
    result=$(echo "$output" | jq 'length')
    [ "$result" -eq 5 ]

    local first
    first=$(echo "$output" | jq '.[0]')
    [ "$first" -eq 4 ]

    local last
    last=$(echo "$output" | jq '.[-1]')
    [ "$last" -eq 8 ]
}

@test "apply_pagination returns all items when limit=0" {
    local items='[1,2,3,4,5]'
    run apply_pagination "$items" 0 0
    assert_success

    local result
    result=$(echo "$output" | jq 'length')
    [ "$result" -eq 5 ]
}

@test "apply_pagination returns remaining items when limit=0 with offset" {
    local items='[1,2,3,4,5]'
    run apply_pagination "$items" 0 2
    assert_success

    local result
    result=$(echo "$output" | jq 'length')
    [ "$result" -eq 3 ]

    local first
    first=$(echo "$output" | jq '.[0]')
    [ "$first" -eq 3 ]
}

@test "apply_pagination returns fewer items when limit exceeds remaining" {
    local items='[1,2,3,4,5]'
    run apply_pagination "$items" 10 0
    assert_success

    local result
    result=$(echo "$output" | jq 'length')
    [ "$result" -eq 5 ]
}

@test "apply_pagination returns empty array when offset exceeds total" {
    local items='[1,2,3,4,5]'
    run apply_pagination "$items" 5 10
    assert_success

    local result
    result=$(echo "$output" | jq 'length')
    [ "$result" -eq 0 ]
}

@test "apply_pagination handles empty array" {
    run apply_pagination '[]' 5 0
    assert_success

    local result
    result=$(echo "$output" | jq 'length')
    [ "$result" -eq 0 ]
}

@test "apply_pagination handles limit=1" {
    local items='[1,2,3]'
    run apply_pagination "$items" 1 0
    assert_success

    local result
    result=$(echo "$output" | jq 'length')
    [ "$result" -eq 1 ]

    local first
    first=$(echo "$output" | jq '.[0]')
    [ "$first" -eq 1 ]
}

@test "apply_pagination handles limit=1 with offset" {
    local items='[1,2,3]'
    run apply_pagination "$items" 1 2
    assert_success

    local result
    result=$(echo "$output" | jq 'length')
    [ "$result" -eq 1 ]

    local first
    first=$(echo "$output" | jq '.[0]')
    [ "$first" -eq 3 ]
}

@test "apply_pagination preserves JSON objects in array" {
    local items='[{"id":"T001","title":"First"},{"id":"T002","title":"Second"},{"id":"T003","title":"Third"}]'
    run apply_pagination "$items" 2 1
    assert_success

    local first_id
    first_id=$(echo "$output" | jq -r '.[0].id')
    [ "$first_id" = "T002" ]

    local last_id
    last_id=$(echo "$output" | jq -r '.[1].id')
    [ "$last_id" = "T003" ]
}

# =============================================================================
# get_pagination_meta Tests
# =============================================================================

@test "get_pagination_meta produces valid JSON" {
    run get_pagination_meta 100 50 0
    assert_success
    assert_valid_json
}

@test "get_pagination_meta has correct total" {
    run get_pagination_meta 150 50 0
    assert_success

    local total
    total=$(echo "$output" | jq '.total')
    [ "$total" -eq 150 ]
}

@test "get_pagination_meta has correct limit" {
    run get_pagination_meta 100 25 0
    assert_success

    local limit
    limit=$(echo "$output" | jq '.limit')
    [ "$limit" -eq 25 ]
}

@test "get_pagination_meta has correct offset" {
    run get_pagination_meta 100 50 75
    assert_success

    local offset
    offset=$(echo "$output" | jq '.offset')
    [ "$offset" -eq 75 ]
}

@test "get_pagination_meta hasMore=true when offset+limit < total" {
    run get_pagination_meta 100 50 0
    assert_success

    local has_more
    has_more=$(echo "$output" | jq '.hasMore')
    [ "$has_more" = "true" ]
}

@test "get_pagination_meta hasMore=false when offset+limit >= total" {
    run get_pagination_meta 100 50 50
    assert_success

    local has_more
    has_more=$(echo "$output" | jq '.hasMore')
    [ "$has_more" = "false" ]
}

@test "get_pagination_meta hasMore=false when offset+limit > total" {
    run get_pagination_meta 30 50 0
    assert_success

    local has_more
    has_more=$(echo "$output" | jq '.hasMore')
    [ "$has_more" = "false" ]
}

@test "get_pagination_meta hasMore=true one item before boundary" {
    # offset(0) + limit(99) = 99 < total(100) => true
    run get_pagination_meta 100 99 0
    assert_success

    local has_more
    has_more=$(echo "$output" | jq '.hasMore')
    [ "$has_more" = "true" ]
}

@test "get_pagination_meta with zero total" {
    run get_pagination_meta 0 50 0
    assert_success

    local has_more
    has_more=$(echo "$output" | jq '.hasMore')
    [ "$has_more" = "false" ]

    local total
    total=$(echo "$output" | jq '.total')
    [ "$total" -eq 0 ]
}

# =============================================================================
# get_default_limit Tests
# =============================================================================

@test "get_default_limit returns 50 for tasks" {
    run get_default_limit "tasks"
    assert_success
    assert_output "50"
}

@test "get_default_limit returns 50 for list" {
    run get_default_limit "list"
    assert_success
    assert_output "50"
}

@test "get_default_limit returns 10 for sessions" {
    run get_default_limit "sessions"
    assert_success
    assert_output "10"
}

@test "get_default_limit returns 10 for session" {
    run get_default_limit "session"
    assert_success
    assert_output "10"
}

@test "get_default_limit returns 10 for session list" {
    run get_default_limit "session list"
    assert_success
    assert_output "10"
}

@test "get_default_limit returns 10 for search" {
    run get_default_limit "search"
    assert_success
    assert_output "10"
}

@test "get_default_limit returns 10 for find" {
    run get_default_limit "find"
    assert_success
    assert_output "10"
}

@test "get_default_limit returns 20 for logs" {
    run get_default_limit "logs"
    assert_success
    assert_output "20"
}

@test "get_default_limit returns 20 for log" {
    run get_default_limit "log"
    assert_success
    assert_output "20"
}

@test "get_default_limit returns 25 for archive" {
    run get_default_limit "archive"
    assert_success
    assert_output "25"
}

@test "get_default_limit returns 25 for archives" {
    run get_default_limit "archives"
    assert_success
    assert_output "25"
}

@test "get_default_limit returns 50 for unknown command" {
    run get_default_limit "unknown"
    assert_success
    assert_output "50"
}

# =============================================================================
# compact_task Tests
# =============================================================================

@test "compact_task keeps essential fields" {
    local full_task='{"id":"T001","title":"Task","status":"pending","priority":"high","type":"task","parentId":null,"phase":"core","labels":["bug"],"depends":["T002"],"blockedBy":["T003"],"createdAt":"2025-01-01T00:00:00Z","completedAt":null,"notes":["note1","note2"],"description":"Long description","acceptance":"criteria","files":["file.sh"],"verification":{"status":"passed"},"_archive":{"reason":"test"}}'
    run compact_task "$full_task"
    assert_success
    assert_valid_json

    # Verify kept fields
    local id
    id=$(echo "$output" | jq -r '.id')
    [ "$id" = "T001" ]

    local title
    title=$(echo "$output" | jq -r '.title')
    [ "$title" = "Task" ]

    local status
    status=$(echo "$output" | jq -r '.status')
    [ "$status" = "pending" ]

    local priority
    priority=$(echo "$output" | jq -r '.priority')
    [ "$priority" = "high" ]

    local task_type
    task_type=$(echo "$output" | jq -r '.type')
    [ "$task_type" = "task" ]
}

@test "compact_task strips notes" {
    local task='{"id":"T001","title":"Task","status":"pending","notes":["note1","note2"]}'
    run compact_task "$task"
    assert_success

    local has_notes
    has_notes=$(echo "$output" | jq 'has("notes")')
    [ "$has_notes" = "false" ]
}

@test "compact_task strips description" {
    local task='{"id":"T001","title":"Task","status":"pending","description":"Long description here"}'
    run compact_task "$task"
    assert_success

    local has_desc
    has_desc=$(echo "$output" | jq 'has("description")')
    [ "$has_desc" = "false" ]
}

@test "compact_task strips files" {
    local task='{"id":"T001","title":"Task","status":"pending","files":["a.sh","b.sh"]}'
    run compact_task "$task"
    assert_success

    local has_files
    has_files=$(echo "$output" | jq 'has("files")')
    [ "$has_files" = "false" ]
}

@test "compact_task strips verification" {
    local task='{"id":"T001","title":"Task","status":"pending","verification":{"status":"passed"}}'
    run compact_task "$task"
    assert_success

    local has_verif
    has_verif=$(echo "$output" | jq 'has("verification")')
    [ "$has_verif" = "false" ]
}

@test "compact_task strips _archive" {
    local task='{"id":"T001","title":"Task","status":"pending","_archive":{"reason":"test"}}'
    run compact_task "$task"
    assert_success

    local has_archive
    has_archive=$(echo "$output" | jq 'has("_archive")')
    [ "$has_archive" = "false" ]
}

@test "compact_task omits null fields" {
    local task='{"id":"T001","title":"Task","status":"pending","parentId":null,"completedAt":null}'
    run compact_task "$task"
    assert_success

    local has_parentId
    has_parentId=$(echo "$output" | jq 'has("parentId")')
    [ "$has_parentId" = "false" ]

    local has_completedAt
    has_completedAt=$(echo "$output" | jq 'has("completedAt")')
    [ "$has_completedAt" = "false" ]
}

@test "compact_task keeps labels array" {
    local task='{"id":"T001","title":"Task","status":"pending","labels":["bug","feature"]}'
    run compact_task "$task"
    assert_success

    local label_count
    label_count=$(echo "$output" | jq '.labels | length')
    [ "$label_count" -eq 2 ]
}

@test "compact_task handles minimal task" {
    local task='{"id":"T001","title":"Task","status":"pending"}'
    run compact_task "$task"
    assert_success
    assert_valid_json

    local id
    id=$(echo "$output" | jq -r '.id')
    [ "$id" = "T001" ]
}

# =============================================================================
# compact_session Tests
# =============================================================================

@test "compact_session keeps essential fields" {
    local full_session='{"id":"session_001","name":"Work","status":"active","scope":{"type":"epic","taskId":"T001"},"focus":{"currentTask":"T002","history":["T001","T002"]},"startedAt":"2025-01-01T00:00:00Z","endedAt":null,"focusHistory":[{"task":"T001","at":"2025-01-01T00:00:00Z"}],"stats":{"tasksCompleted":5},"taskSnapshots":[],"notes":["note1"],"events":[]}'
    run compact_session "$full_session"
    assert_success
    assert_valid_json

    local id
    id=$(echo "$output" | jq -r '.id')
    [ "$id" = "session_001" ]

    local name
    name=$(echo "$output" | jq -r '.name')
    [ "$name" = "Work" ]

    local status
    status=$(echo "$output" | jq -r '.status')
    [ "$status" = "active" ]
}

@test "compact_session keeps scope" {
    local session='{"id":"s1","name":"Work","status":"active","scope":{"type":"epic","taskId":"T001"},"focus":{"currentTask":"T002"},"startedAt":"2025-01-01T00:00:00Z"}'
    run compact_session "$session"
    assert_success

    local scope_type
    scope_type=$(echo "$output" | jq -r '.scope.type')
    [ "$scope_type" = "epic" ]
}

@test "compact_session keeps only focus.currentTask" {
    local session='{"id":"s1","name":"Work","status":"active","focus":{"currentTask":"T002","history":["T001","T002"],"switchCount":5},"startedAt":"2025-01-01T00:00:00Z"}'
    run compact_session "$session"
    assert_success

    local current_task
    current_task=$(echo "$output" | jq -r '.focus.currentTask')
    [ "$current_task" = "T002" ]

    local has_history
    has_history=$(echo "$output" | jq '.focus | has("history")')
    [ "$has_history" = "false" ]
}

@test "compact_session strips focusHistory" {
    local session='{"id":"s1","name":"Work","status":"active","focusHistory":[{"task":"T001"}],"startedAt":"2025-01-01T00:00:00Z"}'
    run compact_session "$session"
    assert_success

    local has_fh
    has_fh=$(echo "$output" | jq 'has("focusHistory")')
    [ "$has_fh" = "false" ]
}

@test "compact_session strips stats" {
    local session='{"id":"s1","name":"Work","status":"active","stats":{"tasksCompleted":5,"focusSwitches":3},"startedAt":"2025-01-01T00:00:00Z"}'
    run compact_session "$session"
    assert_success

    local has_stats
    has_stats=$(echo "$output" | jq 'has("stats")')
    [ "$has_stats" = "false" ]
}

@test "compact_session strips taskSnapshots" {
    local session='{"id":"s1","name":"Work","status":"active","taskSnapshots":[{"id":"T001","status":"pending"}],"startedAt":"2025-01-01T00:00:00Z"}'
    run compact_session "$session"
    assert_success

    local has_ts
    has_ts=$(echo "$output" | jq 'has("taskSnapshots")')
    [ "$has_ts" = "false" ]
}

@test "compact_session strips events" {
    local session='{"id":"s1","name":"Work","status":"active","events":[{"type":"focus","at":"2025-01-01T00:00:00Z"}],"startedAt":"2025-01-01T00:00:00Z"}'
    run compact_session "$session"
    assert_success

    local has_events
    has_events=$(echo "$output" | jq 'has("events")')
    [ "$has_events" = "false" ]
}

@test "compact_session omits null endedAt" {
    local session='{"id":"s1","name":"Work","status":"active","startedAt":"2025-01-01T00:00:00Z","endedAt":null}'
    run compact_session "$session"
    assert_success

    local has_ended
    has_ended=$(echo "$output" | jq 'has("endedAt")')
    [ "$has_ended" = "false" ]
}

@test "compact_session keeps endedAt when set" {
    local session='{"id":"s1","name":"Work","status":"ended","startedAt":"2025-01-01T00:00:00Z","endedAt":"2025-01-01T12:00:00Z"}'
    run compact_session "$session"
    assert_success

    local ended
    ended=$(echo "$output" | jq -r '.endedAt')
    [ "$ended" = "2025-01-01T12:00:00Z" ]
}

@test "compact_session handles session without focus" {
    local session='{"id":"s1","name":"Work","status":"active","startedAt":"2025-01-01T00:00:00Z"}'
    run compact_session "$session"
    assert_success

    local has_focus
    has_focus=$(echo "$output" | jq 'has("focus")')
    [ "$has_focus" = "false" ]
}

@test "compact_session handles minimal session" {
    local session='{"id":"s1","status":"active"}'
    run compact_session "$session"
    assert_success
    assert_valid_json

    local id
    id=$(echo "$output" | jq -r '.id')
    [ "$id" = "s1" ]
}

# =============================================================================
# Version Fallback Tests
# =============================================================================

@test "version falls back to get_version function when CLEO_VERSION unset" {
    unset CLEO_VERSION
    # get_version from version.sh should be available
    run output_success "show" "task" '{"id":"T001"}'
    assert_success

    local ver
    ver=$(echo "$output" | jq -r '._meta.version')
    # Should have some version (not "unknown")
    [ -n "$ver" ]
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "output_success handles data with special characters" {
    run output_success "show" "task" '{"id":"T001","title":"Task with \"quotes\" and \\backslash"}'
    assert_success
    assert_valid_json
}

@test "apply_pagination with single-element array" {
    run apply_pagination '[42]' 5 0
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 1 ]
}

@test "apply_pagination offset=0 and limit=0 returns all" {
    local items='[1,2,3]'
    run apply_pagination "$items" 0 0
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    [ "$count" -eq 3 ]
}

@test "get_pagination_meta with large numbers" {
    run get_pagination_meta 1000000 500 999500
    assert_success
    assert_valid_json

    local has_more
    has_more=$(echo "$output" | jq '.hasMore')
    [ "$has_more" = "false" ]
}

@test "compact_task with empty labels array" {
    local task='{"id":"T001","title":"Task","status":"pending","labels":[]}'
    run compact_task "$task"
    assert_success

    # Empty array is not null, so it should be kept
    local has_labels
    has_labels=$(echo "$output" | jq 'has("labels")')
    [ "$has_labels" = "true" ]
}

@test "compact_session with null focus" {
    local session='{"id":"s1","name":"Work","status":"active","focus":null,"startedAt":"2025-01-01T00:00:00Z"}'
    run compact_session "$session"
    assert_success

    local has_focus
    has_focus=$(echo "$output" | jq 'has("focus")')
    [ "$has_focus" = "false" ]
}
