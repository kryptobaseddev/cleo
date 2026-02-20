#!/usr/bin/env bash
# =============================================================================
# assertions.bash - Custom assertions for claude-todo BATS tests
# =============================================================================
# DRY: Encapsulate repeated assertion patterns specific to claude-todo.
# Depends on bats-assert and bats-support being loaded.
# =============================================================================

# Assert command produces valid JSON
assert_valid_json() {
    local input="${1:-$output}"
    echo "$input" | jq . > /dev/null 2>&1 || {
        batslib_print_kv_single_or_multi 8 "output" "$input"
        fail "Expected valid JSON"
    }
}

# Assert output contains all patterns
assert_output_contains_all() {
    local pattern
    for pattern in "$@"; do
        assert_output --partial "$pattern"
    done
}

# Assert output contains any of the patterns
assert_output_contains_any() {
    local pattern
    local found=false
    for pattern in "$@"; do
        if [[ "$output" =~ $pattern ]]; then
            found=true
            break
        fi
    done
    if [[ "$found" != "true" ]]; then
        batslib_print_kv_single_or_multi 8 "output" "$output"
        fail "Expected output to contain one of: $*"
    fi
}

# Assert task exists in todo.json
assert_task_exists() {
    local task_id="$1"
    local todo_file="${2:-$TODO_FILE}"

    local exists
    exists=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .id' "$todo_file" 2>/dev/null)

    if [[ "$exists" != "$task_id" ]]; then
        fail "Task $task_id does not exist in $todo_file"
    fi
}

# Assert task has specific status
# For cancelled status, also checks archive since delete now immediately archives
assert_task_status() {
    local task_id="$1"
    local expected_status="$2"
    local todo_file="${3:-$TODO_FILE}"

    local actual_status
    actual_status=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .status' "$todo_file" 2>/dev/null)

    # If checking for cancelled and not found in todo, check archive
    if [[ "$expected_status" == "cancelled" && -z "$actual_status" ]]; then
        local archive_file="${ARCHIVE_FILE:-.cleo/todo-archive.json}"
        actual_status=$(jq -r --arg id "$task_id" '.archivedTasks[] | select(.id == $id) | .status' "$archive_file" 2>/dev/null)
    fi

    if [[ "$actual_status" != "$expected_status" ]]; then
        fail "Task $task_id status: expected '$expected_status', got '$actual_status'"
    fi
}

# Assert task has specific dependencies
assert_task_depends_on() {
    local task_id="$1"
    local expected_dep="$2"
    local todo_file="${3:-$TODO_FILE}"

    local deps
    deps=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .depends // [] | join(",")' "$todo_file" 2>/dev/null)

    if [[ "$deps" != *"$expected_dep"* ]]; then
        fail "Task $task_id does not depend on $expected_dep (has: $deps)"
    fi
}

# Assert task does NOT have specific dependency
assert_task_not_depends_on() {
    local task_id="$1"
    local unwanted_dep="$2"
    local todo_file="${3:-$TODO_FILE}"

    local deps
    deps=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .depends // [] | join(",")' "$todo_file" 2>/dev/null)

    if [[ "$deps" == *"$unwanted_dep"* ]]; then
        fail "Task $task_id should not depend on $unwanted_dep (has: $deps)"
    fi
}

# Assert task count in todo.json
assert_task_count() {
    local expected="$1"
    local todo_file="${2:-$TODO_FILE}"

    local actual
    actual=$(jq '.tasks | length' "$todo_file" 2>/dev/null)

    if [[ "$actual" != "$expected" ]]; then
        fail "Expected $expected tasks, got $actual"
    fi
}

# Assert blocked task count
assert_blocked_count() {
    local expected="$1"
    local todo_file="${2:-$TODO_FILE}"

    local actual
    actual=$(jq '[.tasks[] | select(.status == "blocked")] | length' "$todo_file" 2>/dev/null)

    if [[ "$actual" != "$expected" ]]; then
        fail "Expected $expected blocked tasks, got $actual"
    fi
}

# Assert circular dependency check passes
assert_no_circular_deps() {
    run bash "$VALIDATE_SCRIPT"
    assert_output --partial "No circular dependencies"
}

# Assert help output is shown
assert_shows_help() {
    assert_success
    assert_output --partial "Usage:"
}

# Assert command handles missing todo.json gracefully
assert_handles_missing_todo() {
    rm -f "$TODO_FILE"
    run "$@"
    # Should either exit 0 with message or exit 1 with error
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
}

# Assert JSON output has expected structure
assert_json_has_key() {
    local key="$1"
    local json="${2:-$output}"

    local has_key
    has_key=$(echo "$json" | jq "has(\"$key\")" 2>/dev/null)

    if [[ "$has_key" != "true" ]]; then
        batslib_print_kv_single_or_multi 8 "json" "$json"
        fail "JSON missing key: $key"
    fi
}

# Assert output format is markdown (has common markdown elements)
assert_markdown_output() {
    assert_output_contains_any "#" "-" "*" "|"
}
