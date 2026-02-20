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
    REPARENT_SCRIPT="${SCRIPTS_DIR}/reparent.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

@test "reparent moves task to new parent" {
    create_empty_todo
    local epic1=$(bash "$ADD_SCRIPT" "Epic 1" --type epic -q)
    local epic2=$(bash "$ADD_SCRIPT" "Epic 2" --type epic -q)
    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic1" -q)

    run bash "$REPARENT_SCRIPT" "$task" --to "$epic2"
    assert_success

    local new_parent=$(jq -r --arg id "$task" '.tasks[] | select(.id == $id) | .parentId' "$TODO_FILE")
    [[ "$new_parent" == "$epic2" ]]
}

@test "reparent --to empty removes parent" {
    create_empty_todo
    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic" -q)

    run bash "$REPARENT_SCRIPT" "$task" --to ""
    assert_success

    local parent=$(jq -r --arg id "$task" '.tasks[] | select(.id == $id) | .parentId // "null"' "$TODO_FILE")
    [[ "$parent" == "null" ]]
}

@test "reparent fails for non-existent task" {
    create_empty_todo
    run bash "$REPARENT_SCRIPT" "T999" --to "T001"
    assert_failure
    assert_output --partial "not found"
}

@test "reparent fails when target is subtask" {
    create_empty_todo
    local epic=$(bash "$ADD_SCRIPT" "Epic" --type epic -q)
    local task=$(bash "$ADD_SCRIPT" "Task" --parent "$epic" -q)
    local subtask=$(bash "$ADD_SCRIPT" "Subtask" --parent "$task" --type subtask -q)
    local other=$(bash "$ADD_SCRIPT" "Other" -q)

    run bash "$REPARENT_SCRIPT" "$other" --to "$subtask"
    assert_failure
    assert_output --partial "subtask"
}

@test "reparent fails on circular reference" {
    create_empty_todo
    local task=$(bash "$ADD_SCRIPT" "Task" -q)

    run bash "$REPARENT_SCRIPT" "$task" --to "$task"
    assert_failure
    assert_output --partial "own parent"
}
