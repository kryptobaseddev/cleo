#!/usr/bin/env bats
# round-trip.bats - Round-trip integration tests for export → import workflow

# =============================================================================
# Test Setup
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    common_setup_per_test

    # Create source project with tasks
    cat > "$TODO_FILE" <<'EOF'
{
  "tasks": [
    {
      "id": "T001",
      "title": "Auth Epic",
      "description": "Authentication system",
      "status": "active",
      "priority": "high",
      "type": "epic",
      "parentId": null,
      "depends": [],
      "labels": ["auth", "feature"],
      "phase": "core",
      "createdAt": "2026-01-01T00:00:00Z"
    },
    {
      "id": "T002",
      "title": "JWT Middleware",
      "description": "Implement JWT middleware",
      "status": "pending",
      "priority": "medium",
      "type": "task",
      "parentId": "T001",
      "depends": ["T001"],
      "labels": ["auth", "backend"],
      "phase": "core",
      "createdAt": "2026-01-01T01:00:00Z"
    },
    {
      "id": "T003",
      "title": "Write JWT Tests",
      "description": "Unit tests for JWT",
      "status": "pending",
      "priority": "low",
      "type": "subtask",
      "parentId": "T002",
      "depends": ["T002"],
      "labels": ["auth", "testing"],
      "phase": "testing",
      "createdAt": "2026-01-01T02:00:00Z"
    }
  ],
  "project": {
    "name": "source-project",
    "phases": [
      {"slug": "core", "name": "Core"},
      {"slug": "testing", "name": "Testing"}
    ]
  }
}
EOF

    # Create target project (empty initially)
    TARGET_DIR="$TEST_TEMP_DIR/target"
    mkdir -p "$TARGET_DIR/.cleo"
    TARGET_TODO="$TARGET_DIR/.cleo/todo.json"

    cat > "$TARGET_TODO" <<'EOF'
{
  "tasks": [],
  "project": {
    "name": "target-project",
    "phases": [
      {"slug": "core", "name": "Core Development"},
      {"slug": "testing", "name": "Testing & QA"}
    ]
  }
}
EOF
}

teardown() {
    common_teardown_per_test
}

# =============================================================================
# Round-Trip Tests
# =============================================================================

@test "round-trip: export single task, import into empty project" {
    local export_file="$TEST_TEMP_DIR/export.json"

    # Export T002 from source
    run "$PROJECT_ROOT/scripts/export-tasks.sh" T002 --output "$export_file"

    # Import into target (must set TODO_FILE to target so import writes there)
    cd "$TARGET_DIR" || exit 1
    run env TODO_FILE="$TARGET_TODO" "$PROJECT_ROOT/scripts/import-tasks.sh" "$export_file"
    assert_success

    # Verify task imported with new ID
    local task_count=$(jq '.tasks | length' "$TARGET_TODO")
    [[ "$task_count" -eq 1 ]]

    local imported_title=$(jq -r '.tasks[0].title' "$TARGET_TODO")
    [[ "$imported_title" == "JWT Middleware" ]]
}

@test "round-trip: export subtree, import preserves hierarchy" {
    local export_file="$TEST_TEMP_DIR/export.json"

    # Export T001 subtree from source
    "$PROJECT_ROOT/scripts/export-tasks.sh" T001 --subtree --output "$export_file" || exit 1

    # Verify export has all 3 tasks
    local export_count=$(jq '.tasks | length' "$export_file")
    [[ "$export_count" -eq 3 ]]

    # Import into target
    cd "$TARGET_DIR" || exit 1
    env TODO_FILE="$TARGET_TODO" "$PROJECT_ROOT/scripts/import-tasks.sh" "$export_file" || exit 1

    # Verify all tasks imported
    local import_count=$(jq '.tasks | length' "$TARGET_TODO")
    [[ "$import_count" -eq 3 ]]

    # Verify hierarchy preserved (IDs will be different)
    local epic_id=$(jq -r '.tasks[] | select(.title == "Auth Epic") | .id' "$TARGET_TODO")
    local task_id=$(jq -r '.tasks[] | select(.title == "JWT Middleware") | .id' "$TARGET_TODO")
    local subtask_id=$(jq -r '.tasks[] | select(.title == "Write JWT Tests") | .id' "$TARGET_TODO")

    local task_parent=$(jq -r ".tasks[] | select(.id == \"$task_id\") | .parentId" "$TARGET_TODO")
    local subtask_parent=$(jq -r ".tasks[] | select(.id == \"$subtask_id\") | .parentId" "$TARGET_TODO")

    [[ "$task_parent" == "$epic_id" ]]
    [[ "$subtask_parent" == "$task_id" ]]
}

@test "round-trip: export preserves metadata, import uses it" {
    local export_file="$TEST_TEMP_DIR/export.json"

    # Export T001
    "$PROJECT_ROOT/scripts/export-tasks.sh" T001 --output "$export_file" || exit 1

    # Verify metadata in export
    local source_project=$(jq -r '._meta.source.project' "$export_file")
    [[ "$source_project" == "source-project" ]]

    # Import
    cd "$TARGET_DIR" || exit 1
    env TODO_FILE="$TARGET_TODO" "$PROJECT_ROOT/scripts/import-tasks.sh" "$export_file" || exit 1

    # Verify task attributes preserved
    local status=$(jq -r '.tasks[0].status' "$TARGET_TODO")
    local priority=$(jq -r '.tasks[0].priority' "$TARGET_TODO")

    [[ "$status" == "active" ]]
    [[ "$priority" == "high" ]]
}

@test "round-trip: export dependencies, import remaps correctly" {
    local export_file="$TEST_TEMP_DIR/export.json"

    # Export subtree with dependencies
    "$PROJECT_ROOT/scripts/export-tasks.sh" T001 --subtree --output "$export_file" || exit 1

    # Import
    cd "$TARGET_DIR" || exit 1
    env TODO_FILE="$TARGET_TODO" "$PROJECT_ROOT/scripts/import-tasks.sh" "$export_file" || exit 1

    # Get new IDs
    local epic_id=$(jq -r '.tasks[] | select(.title == "Auth Epic") | .id' "$TARGET_TODO")
    local task_id=$(jq -r '.tasks[] | select(.title == "JWT Middleware") | .id' "$TARGET_TODO")
    local subtask_id=$(jq -r '.tasks[] | select(.title == "Write JWT Tests") | .id' "$TARGET_TODO")

    # Verify dependencies remapped
    local task_deps=$(jq -r ".tasks[] | select(.id == \"$task_id\") | .depends[0]" "$TARGET_TODO")
    local subtask_deps=$(jq -r ".tasks[] | select(.id == \"$subtask_id\") | .depends[0]" "$TARGET_TODO")

    [[ "$task_deps" == "$epic_id" ]]
    [[ "$subtask_deps" == "$task_id" ]]
}

@test "round-trip: export to non-empty project, IDs don't conflict" {
    local export_file="$TEST_TEMP_DIR/export.json"

    # Add existing task to target
    jq '.tasks += [{
      "id": "T010",
      "title": "Existing Task",
      "status": "pending",
      "priority": "medium",
      "type": "task",
      "parentId": null,
      "depends": [],
      "createdAt": "2026-01-02T00:00:00Z"
    }]' "$TARGET_TODO" > "$TARGET_TODO.tmp" && mv "$TARGET_TODO.tmp" "$TARGET_TODO"

    # Export from source
    "$PROJECT_ROOT/scripts/export-tasks.sh" T001 --output "$export_file" || exit 1

    # Import
    cd "$TARGET_DIR" || exit 1
    env TODO_FILE="$TARGET_TODO" "$PROJECT_ROOT/scripts/import-tasks.sh" "$export_file" || exit 1

    # Verify both tasks exist
    local task_count=$(jq '.tasks | length' "$TARGET_TODO")
    [[ "$task_count" -eq 2 ]]

    # Verify imported task has different ID
    local imported_id=$(jq -r '.tasks[] | select(.title == "Auth Epic") | .id' "$TARGET_TODO")
    [[ "$imported_id" != "T001" ]]
    [[ "$imported_id" != "T010" ]]
}

@test "round-trip: export labels, import preserves them" {
    local export_file="$TEST_TEMP_DIR/export.json"

    # Export task with labels
    "$PROJECT_ROOT/scripts/export-tasks.sh" T002 --output "$export_file" || exit 1

    # Import
    cd "$TARGET_DIR" || exit 1
    env TODO_FILE="$TARGET_TODO" "$PROJECT_ROOT/scripts/import-tasks.sh" "$export_file" || exit 1

    # Verify labels preserved
    local labels=$(jq -r '.tasks[0].labels | join(",")' "$TARGET_TODO")
    [[ "$labels" == "auth,backend" ]]
}

@test "round-trip: export phase, import maps to target phase" {
    local export_file="$TEST_TEMP_DIR/export.json"

    # Export task with phase
    "$PROJECT_ROOT/scripts/export-tasks.sh" T002 --output "$export_file" || exit 1

    # Import
    cd "$TARGET_DIR" || exit 1
    env TODO_FILE="$TARGET_TODO" "$PROJECT_ROOT/scripts/import-tasks.sh" "$export_file" || exit 1

    # Verify phase exists in target
    local phase=$(jq -r '.tasks[0].phase' "$TARGET_TODO")
    [[ "$phase" == "core" ]]
}

@test "round-trip: multiple exports to same target accumulate correctly" {
    local export1="$TEST_TEMP_DIR/export1.json"
    local export2="$TEST_TEMP_DIR/export2.json"

    # Export T001
    "$PROJECT_ROOT/scripts/export-tasks.sh" T001 --output "$export1" || exit 1

    # Export T002
    "$PROJECT_ROOT/scripts/export-tasks.sh" T002 --output "$export2" || exit 1

    # Import both
    cd "$TARGET_DIR" || exit 1
    env TODO_FILE="$TARGET_TODO" "$PROJECT_ROOT/scripts/import-tasks.sh" "$export1" || exit 1
    env TODO_FILE="$TARGET_TODO" "$PROJECT_ROOT/scripts/import-tasks.sh" "$export2" || exit 1

    # Verify both imported
    local task_count=$(jq '.tasks | length' "$TARGET_TODO")
    [[ "$task_count" -eq 2 ]]

    # Verify titles
    local has_epic=$(jq '.tasks[] | select(.title == "Auth Epic")' "$TARGET_TODO")
    local has_task=$(jq '.tasks[] | select(.title == "JWT Middleware")' "$TARGET_TODO")

    [[ -n "$has_epic" ]]
    [[ -n "$has_task" ]]
}

@test "round-trip: dry-run doesn't modify target" {
    local export_file="$TEST_TEMP_DIR/export.json"

    # Export
    "$PROJECT_ROOT/scripts/export-tasks.sh" T001 --output "$export_file" || exit 1

    # Get initial state
    local initial_count=$(jq '.tasks | length' "$TARGET_TODO")

    # Dry-run import
    cd "$TARGET_DIR" || exit 1
    env TODO_FILE="$TARGET_TODO" "$PROJECT_ROOT/scripts/import-tasks.sh" "$export_file" --dry-run || exit 1

    # Verify no change
    local final_count=$(jq '.tasks | length' "$TARGET_TODO")
    [[ "$final_count" -eq "$initial_count" ]]
}

@test "round-trip: re-export imported tasks produces equivalent package" {
    local export1="$TEST_TEMP_DIR/export1.json"
    local export2="$TEST_TEMP_DIR/export2.json"

    # Export from source
    "$PROJECT_ROOT/scripts/export-tasks.sh" T001 --output "$export1" || exit 1

    # Import to target
    cd "$TARGET_DIR" || exit 1
    env TODO_FILE="$TARGET_TODO" "$PROJECT_ROOT/scripts/import-tasks.sh" "$export1" || exit 1

    # Get imported task ID
    local imported_id=$(jq -r '.tasks[0].id' "$TARGET_TODO")

    # Re-export from target
    "$PROJECT_ROOT/scripts/export-tasks.sh" "$imported_id" --output "$export2" || exit 1

    # Verify both exports have same structure (excluding IDs and metadata)
    local original_title=$(jq -r '.tasks[0].title' "$export1")
    local reexport_title=$(jq -r '.tasks[0].title' "$export2")

    [[ "$original_title" == "$reexport_title" ]]
}
