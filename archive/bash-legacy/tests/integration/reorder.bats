#!/usr/bin/env bats
# Integration tests for reorder commands (T805)

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test
    # Create temp directory for test files
    TEST_DIR="$(mktemp -d)"
    export CLEO_DIR="$TEST_DIR/.cleo"
    export TODO_FILE="$CLEO_DIR/todo.json"
    mkdir -p "$CLEO_DIR"

    # Copy schema for validation
    if [[ -d "$HOME/.cleo/schemas" ]]; then
        cp -r "$HOME/.cleo/schemas" "$CLEO_DIR/"
    fi

    # Initialize with test tasks
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.6.0",
  "project": { "name": "test" },
  "lastUpdated": "2026-01-01T00:00:00Z",
  "_meta": { "schemaVersion": "2.6.0", "checksum": "test123" },
  "tasks": [
    {"id":"T001","title":"First","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:00Z","position":1,"positionVersion":0},
    {"id":"T002","title":"Second","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:01Z","position":2,"positionVersion":0},
    {"id":"T003","title":"Third","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:02Z","position":3,"positionVersion":0},
    {"id":"T004","title":"Fourth","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:03Z","position":4,"positionVersion":0},
    {"id":"T005","title":"Fifth","status":"pending","priority":"medium","createdAt":"2026-01-01T00:00:04Z","position":5,"positionVersion":0}
  ]
}
EOF

    # Create config
    cat > "$CLEO_DIR/config.json" << 'EOF'
{
  "version": "2.2.0",
  "_meta": {"schemaVersion": "2.2.0"}
}
EOF
}

teardown() {
    rm -rf "$TEST_DIR"
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# Helper to get task position
get_position() {
    jq -r --arg id "$1" '.tasks[] | select(.id == $id) | .position' "$TODO_FILE"
}

# =============================================================================
# Reorder --position Tests
# =============================================================================

@test "reorder --position moves task and shuffles siblings (shuffle up)" {
    skip "requires installed reorder.sh"
    # Move T004 to position 2 (shuffle up)
    run cleo reorder T004 --position 2

    # T004 should be at position 2
    assert_equal "$(get_position T004)" "2"
    # T002 should shift to 3
    assert_equal "$(get_position T002)" "3"
    # T003 should shift to 4
    assert_equal "$(get_position T003)" "4"
    # T001 unchanged at 1
    assert_equal "$(get_position T001)" "1"
    # T005 unchanged at 5
    assert_equal "$(get_position T005)" "5"
}

@test "reorder --position moves task and shuffles siblings (shuffle down)" {
    skip "requires installed reorder.sh"
    # Move T002 to position 4 (shuffle down)
    run cleo reorder T002 --position 4

    # T002 should be at position 4
    assert_equal "$(get_position T002)" "4"
    # T003 should shift to 2
    assert_equal "$(get_position T003)" "2"
    # T004 should shift to 3
    assert_equal "$(get_position T004)" "3"
    # T001 unchanged at 1
    assert_equal "$(get_position T001)" "1"
    # T005 unchanged at 5
    assert_equal "$(get_position T005)" "5"
}

@test "reorder --top moves task to position 1" {
    skip "requires installed reorder.sh"
    run cleo reorder T003 --top

    assert_equal "$(get_position T003)" "1"
    assert_equal "$(get_position T001)" "2"
    assert_equal "$(get_position T002)" "3"
}

@test "reorder --bottom moves task to last position" {
    skip "requires installed reorder.sh"
    run cleo reorder T002 --bottom

    assert_equal "$(get_position T002)" "5"
    assert_equal "$(get_position T003)" "2"
    assert_equal "$(get_position T004)" "3"
    assert_equal "$(get_position T005)" "4"
}

@test "reorder same position is no-op" {
    skip "requires installed reorder.sh"
    run cleo reorder T003 --position 3
    assert_success
    # Positions unchanged
    assert_equal "$(get_position T003)" "3"
}

# =============================================================================
# Swap Tests
# =============================================================================

@test "swap exchanges positions of two tasks" {
    skip "requires installed reorder.sh"
    run cleo swap T002 T004

    assert_equal "$(get_position T002)" "4"
    assert_equal "$(get_position T004)" "2"
    # Others unchanged
    assert_equal "$(get_position T001)" "1"
    assert_equal "$(get_position T003)" "3"
    assert_equal "$(get_position T005)" "5"
}

@test "swap fails for tasks with different parents" {
    skip "requires installed reorder.sh"
    # Add a child task
    jq '.tasks += [{"id":"T010","title":"Child","status":"pending","priority":"medium","createdAt":"2026-01-01T01:00:00Z","parentId":"T001","position":1}]' \
        "$TODO_FILE" > "$TODO_FILE.tmp" && mv "$TODO_FILE.tmp" "$TODO_FILE"

    run cleo swap T002 T010
    assert_failure
}

# =============================================================================
# Add --position Tests
# =============================================================================

@test "add auto-assigns next position" {
    skip "requires installed add.sh with position"
    run cleo add "New Task" --format json
    assert_success

    # New task should have position 6
    new_pos=$(jq -r '.tasks[] | select(.title == "New Task") | .position' "$TODO_FILE")
    assert_equal "$new_pos" "6"
}

@test "add --position inserts at specified position and shuffles" {
    skip "requires installed add.sh with position"
    run cleo add "New Task" --position 2 --format json

    # New task at position 2
    new_pos=$(jq -r '.tasks[] | select(.title == "New Task") | .position' "$TODO_FILE")
    assert_equal "$new_pos" "2"

    # Others shifted
    assert_equal "$(get_position T002)" "3"
    assert_equal "$(get_position T003)" "4"
}

# =============================================================================
# Reparent Position Tests
# =============================================================================

@test "reparent assigns position in new parent scope" {
    skip "requires installed reparent.sh with position"
    # Create parent
    jq '.tasks += [{"id":"T020","title":"Epic","status":"pending","priority":"medium","createdAt":"2026-01-01T02:00:00Z","type":"epic","position":6}]' \
        "$TODO_FILE" > "$TODO_FILE.tmp" && mv "$TODO_FILE.tmp" "$TODO_FILE"

    run cleo reparent T003 --to T020

    # T003 should have position 1 in new parent
    t003_pos=$(jq -r '.tasks[] | select(.id == "T003") | .position' "$TODO_FILE")
    assert_equal "$t003_pos" "1"

    # Gap should be closed in old parent: T004 -> 3, T005 -> 4
    assert_equal "$(get_position T004)" "3"
    assert_equal "$(get_position T005)" "4"
}

# =============================================================================
# List --sort position Tests
# =============================================================================

@test "list --sort position orders by position" {
    skip "requires installed list.sh with position sort"
    # Shuffle positions
    jq '.tasks[0].position = 3 | .tasks[2].position = 1' "$TODO_FILE" > "$TODO_FILE.tmp" && mv "$TODO_FILE.tmp" "$TODO_FILE"

    run cleo list --sort position --format json
    assert_success

    # Verify order: position 1 first
    first_id=$(echo "$output" | jq -r '.tasks[0].id')
    assert_equal "$first_id" "T003"
}

# =============================================================================
# Tree Position Tests
# =============================================================================

@test "tree view shows children sorted by position" {
    skip "requires installed list.sh with position tree"
    # Add child tasks with positions
    jq '.tasks += [
        {"id":"T100","title":"Epic","status":"pending","priority":"medium","createdAt":"2026-01-01T03:00:00Z","type":"epic","position":6},
        {"id":"T101","title":"Child C","status":"pending","priority":"medium","createdAt":"2026-01-01T03:00:01Z","parentId":"T100","position":3},
        {"id":"T102","title":"Child A","status":"pending","priority":"medium","createdAt":"2026-01-01T03:00:02Z","parentId":"T100","position":1},
        {"id":"T103","title":"Child B","status":"pending","priority":"medium","createdAt":"2026-01-01T03:00:03Z","parentId":"T100","position":2}
    ]' "$TODO_FILE" > "$TODO_FILE.tmp" && mv "$TODO_FILE.tmp" "$TODO_FILE"

    run cleo list --tree --parent T100 --format json
    assert_success

    # Children should be in position order: T102, T103, T101
    first_child=$(echo "$output" | jq -r '.tree[0].children[0].id')
    second_child=$(echo "$output" | jq -r '.tree[0].children[1].id')
    third_child=$(echo "$output" | jq -r '.tree[0].children[2].id')

    assert_equal "$first_child" "T102"
    assert_equal "$second_child" "T103"
    assert_equal "$third_child" "T101"
}
