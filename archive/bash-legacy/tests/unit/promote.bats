#!/usr/bin/env bats

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test
    PROMOTE_SCRIPT="${SCRIPTS_DIR}/promote.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

@test "promote removes parent from task" {
    create_empty_todo
    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic" -q)

    run bash "$PROMOTE_SCRIPT" "$task"
    assert_success

    local parent=$(jq -r --arg id "$task" '.tasks[] | select(.id == $id) | .parentId // "null"' "$TODO_FILE")
    [[ "$parent" == "null" ]]
}

@test "promote changes subtask type to task" {
    create_empty_todo
    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic" -q)
    local subtask=$(bash "$ADD_SCRIPT" "Subtask" --parent "$task" --type subtask -q)

    run bash "$PROMOTE_SCRIPT" "$subtask"
    assert_success

    local type=$(jq -r --arg id "$subtask" '.tasks[] | select(.id == $id) | .type' "$TODO_FILE")
    [[ "$type" == "task" ]]
}

@test "promote --no-type-update keeps subtask type" {
    create_empty_todo
    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic" -q)
    local subtask=$(bash "$ADD_SCRIPT" "Subtask" --parent "$task" --type subtask -q)

    run bash "$PROMOTE_SCRIPT" "$subtask" --no-type-update
    assert_success

    local type=$(jq -r --arg id "$subtask" '.tasks[] | select(.id == $id) | .type' "$TODO_FILE")
    [[ "$type" == "subtask" ]]
}

@test "promote on root task is no-op" {
    create_empty_todo
    local task=$(bash "$ADD_SCRIPT" "Task" -q)

    run bash "$PROMOTE_SCRIPT" "$task"
    assert_success
    assert_output --partial "already"
}
