#!/usr/bin/env bats
# export-tasks-cli.bats - Integration tests for export-tasks.sh CLI

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

    # Create test project with tasks
    cat > "$TODO_FILE" <<'EOF'
{
  "tasks": [
    {
      "id": "T001",
      "title": "Epic Task",
      "description": "Main epic",
      "status": "active",
      "priority": "high",
      "type": "epic",
      "parentId": null,
      "depends": [],
      "labels": ["feature"],
      "phase": "core",
      "createdAt": "2026-01-01T00:00:00Z"
    },
    {
      "id": "T002",
      "title": "Child Task",
      "description": "Child of epic",
      "status": "pending",
      "priority": "medium",
      "type": "task",
      "parentId": "T001",
      "depends": ["T001"],
      "labels": ["feature"],
      "phase": "core",
      "createdAt": "2026-01-01T01:00:00Z"
    },
    {
      "id": "T003",
      "title": "Subtask",
      "description": "Subtask of child",
      "status": "pending",
      "priority": "low",
      "type": "subtask",
      "parentId": "T002",
      "depends": ["T002"],
      "labels": ["feature"],
      "phase": "core",
      "createdAt": "2026-01-01T02:00:00Z"
    },
    {
      "id": "T010",
      "title": "Unrelated Task",
      "description": "Not part of epic",
      "status": "pending",
      "priority": "medium",
      "type": "task",
      "parentId": null,
      "depends": [],
      "labels": ["bug"],
      "phase": "testing",
      "createdAt": "2026-01-01T03:00:00Z"
    }
  ],
  "project": {
    "name": "test-project",
    "phases": [
      {"slug": "core", "name": "Core"},
      {"slug": "testing", "name": "Testing"}
    ]
  }
}
EOF
}

teardown() {
    common_teardown_per_test
}

# =============================================================================
# Basic CLI Tests
# =============================================================================

@test "export-tasks.sh exists and is executable" {
    [[ -x "$PROJECT_ROOT/scripts/export-tasks.sh" ]]
}

@test "export-tasks requires task ID argument" {
    run "$PROJECT_ROOT/scripts/export-tasks.sh"
    assert_failure
    assert_output --partial "Usage:"
}

@test "export-tasks shows help with --help" {
    run "$PROJECT_ROOT/scripts/export-tasks.sh" --help
    assert_success
    assert_output --partial "Usage:"
    assert_output --partial "export-tasks"
}

@test "export-tasks shows version with --version" {
    run "$PROJECT_ROOT/scripts/export-tasks.sh" --version
    assert_success
    assert_output --partial "0.48"
}

# =============================================================================
# Single Task Export Tests
# =============================================================================

@test "export-tasks exports single task" {
    local output_file="$TEST_TEMP_DIR/export.json"

    run "$PROJECT_ROOT/scripts/export-tasks.sh" T010 --output "$output_file"
    assert_success

    # Verify file created
    [[ -f "$output_file" ]]

    # Verify structure
    local meta_format=$(jq -r '._meta.format' "$output_file")
    [[ "$meta_format" == "cleo-export" ]]

    # Verify task exported
    local task_count=$(jq '.tasks | length' "$output_file")
    [[ "$task_count" -eq 1 ]]

    local task_id=$(jq -r '.tasks[0].id' "$output_file")
    [[ "$task_id" == "T010" ]]
}

@test "export-tasks fails for non-existent task" {
    run "$PROJECT_ROOT/scripts/export-tasks.sh" T999 --output "$TEST_TEMP_DIR/export.json"
    assert_failure
    assert_output --partial "not found"
}

# =============================================================================
# Subtree Export Tests
# =============================================================================

@test "export-tasks exports subtree with --subtree" {
    local output_file="$TEST_TEMP_DIR/export.json"

    run "$PROJECT_ROOT/scripts/export-tasks.sh" T001 --subtree --output "$output_file"
    assert_success

    # Verify file created
    [[ -f "$output_file" ]]

    # Verify all tasks in subtree exported
    local task_count=$(jq '.tasks | length' "$output_file")
    [[ "$task_count" -eq 3 ]]

    # Verify epic, task, and subtask present
    local has_epic=$(jq '.tasks[] | select(.id == "T001")' "$output_file")
    local has_task=$(jq '.tasks[] | select(.id == "T002")' "$output_file")
    local has_subtask=$(jq '.tasks[] | select(.id == "T003")' "$output_file")

    [[ -n "$has_epic" ]]
    [[ -n "$has_task" ]]
    [[ -n "$has_subtask" ]]

    # Verify unrelated task NOT exported
    local has_unrelated=$(jq '.tasks[] | select(.id == "T010")' "$output_file")
    [[ -z "$has_unrelated" ]]
}

@test "export-tasks subtree preserves hierarchy" {
    local output_file="$TEST_TEMP_DIR/export.json"

    "$PROJECT_ROOT/scripts/export-tasks.sh" T001 --subtree --output "$output_file"

    # Verify parent relationships
    local t002_parent=$(jq -r '.tasks[] | select(.id == "T002") | .parentId' "$output_file")
    local t003_parent=$(jq -r '.tasks[] | select(.id == "T003") | .parentId' "$output_file")

    [[ "$t002_parent" == "T001" ]]
    [[ "$t003_parent" == "T002" ]]
}

@test "export-tasks subtree preserves dependencies" {
    local output_file="$TEST_TEMP_DIR/export.json"

    "$PROJECT_ROOT/scripts/export-tasks.sh" T001 --subtree --output "$output_file"

    # Verify dependencies
    local t002_deps=$(jq -r '.tasks[] | select(.id == "T002") | .depends[0]' "$output_file")
    local t003_deps=$(jq -r '.tasks[] | select(.id == "T003") | .depends[0]' "$output_file")

    [[ "$t002_deps" == "T001" ]]
    [[ "$t003_deps" == "T002" ]]
}

# =============================================================================
# Multiple Tasks Export Tests
# =============================================================================

@test "export-tasks exports multiple tasks" {
    local output_file="$TEST_TEMP_DIR/export.json"

    run "$PROJECT_ROOT/scripts/export-tasks.sh" T002 T010 --output "$output_file"
    assert_success

    # Verify both tasks exported
    local task_count=$(jq '.tasks | length' "$output_file")
    [[ "$task_count" -eq 2 ]]

    local has_t002=$(jq '.tasks[] | select(.id == "T002")' "$output_file")
    local has_t010=$(jq '.tasks[] | select(.id == "T010")' "$output_file")

    [[ -n "$has_t002" ]]
    [[ -n "$has_t010" ]]
}

@test "export-tasks with multiple tasks and --subtree exports all subtrees" {
    local output_file="$TEST_TEMP_DIR/export.json"

    run "$PROJECT_ROOT/scripts/export-tasks.sh" T001 T010 --subtree --output "$output_file"
    assert_success

    # Should have T001 subtree (3 tasks) + T010 (1 task) = 4 tasks
    local task_count=$(jq '.tasks | length' "$output_file")
    [[ "$task_count" -eq 4 ]]
}

# =============================================================================
# Output Options Tests
# =============================================================================

@test "export-tasks writes to stdout when no --output specified" {
    run "$PROJECT_ROOT/scripts/export-tasks.sh" T010
    assert_success

    # Output should be valid JSON
    echo "$output" | jq . >/dev/null

    # Verify structure
    local meta_format=$(echo "$output" | jq -r '._meta.format')
    [[ "$meta_format" == "cleo-export" ]]
}

@test "export-tasks creates parent directories for output file" {
    local output_file="$TEST_TEMP_DIR/nested/dir/export.json"

    run "$PROJECT_ROOT/scripts/export-tasks.sh" T010 --output "$output_file"
    assert_success

    [[ -f "$output_file" ]]
}

@test "export-tasks overwrites existing output file" {
    local output_file="$TEST_TEMP_DIR/export.json"

    # Create existing file
    echo '{"old": "data"}' > "$output_file"

    # Export should overwrite
    "$PROJECT_ROOT/scripts/export-tasks.sh" T010 --output "$output_file"

    # Verify new content
    local meta_format=$(jq -r '._meta.format' "$output_file")
    [[ "$meta_format" == "cleo-export" ]]
}

# =============================================================================
# Metadata Tests
# =============================================================================

@test "export-tasks includes correct metadata" {
    local output_file="$TEST_TEMP_DIR/export.json"

    "$PROJECT_ROOT/scripts/export-tasks.sh" T010 --output "$output_file"

    # Verify metadata
    local format=$(jq -r '._meta.format' "$output_file")
    local version=$(jq -r '._meta.version' "$output_file")
    local exported_at=$(jq -r '._meta.exportedAt' "$output_file")
    local source_project=$(jq -r '._meta.sourceProject' "$output_file")

    [[ "$format" == "cleo-export" ]]
    [[ "$version" == "1.0.0" ]]
    [[ -n "$exported_at" ]]
    [[ "$source_project" == "test-project" ]]
}

@test "export-tasks includes task statistics" {
    local output_file="$TEST_TEMP_DIR/export.json"

    "$PROJECT_ROOT/scripts/export-tasks.sh" T001 --subtree --output "$output_file"

    # Verify stats
    local total=$(jq '._meta.stats.total' "$output_file")
    [[ "$total" -eq 3 ]]
}

# =============================================================================
# Validation Tests
# =============================================================================

@test "export-tasks validates output against schema" {
    local output_file="$TEST_TEMP_DIR/export.json"

    "$PROJECT_ROOT/scripts/export-tasks.sh" T010 --output "$output_file"

    # Verify schema validation (if schema exists)
    if [[ -f "$PROJECT_ROOT/schemas/export.schema.json" ]]; then
        run jq -e '._meta.format == "cleo-export"' "$output_file"
        assert_success
    fi
}

@test "export-tasks includes all required task fields" {
    local output_file="$TEST_TEMP_DIR/export.json"

    "$PROJECT_ROOT/scripts/export-tasks.sh" T001 --output "$output_file"

    # Verify required fields
    local task=$(jq '.tasks[0]' "$output_file")

    local has_id=$(echo "$task" | jq 'has("id")')
    local has_title=$(echo "$task" | jq 'has("title")')
    local has_status=$(echo "$task" | jq 'has("status")')
    local has_priority=$(echo "$task" | jq 'has("priority")')
    local has_type=$(echo "$task" | jq 'has("type")')

    [[ "$has_id" == "true" ]]
    [[ "$has_title" == "true" ]]
    [[ "$has_status" == "true" ]]
    [[ "$has_priority" == "true" ]]
    [[ "$has_type" == "true" ]]
}

# =============================================================================
# Error Handling Tests
# =============================================================================

@test "export-tasks fails gracefully on invalid todo.json" {
    echo "invalid json" > "$TODO_FILE"

    run "$PROJECT_ROOT/scripts/export-tasks.sh" T001 --output "$TEST_TEMP_DIR/export.json"
    assert_failure
}

@test "export-tasks provides helpful error for missing todo.json" {
    rm -f "$TODO_FILE"

    run "$PROJECT_ROOT/scripts/export-tasks.sh" T001 --output "$TEST_TEMP_DIR/export.json"
    assert_failure
    assert_output --partial "todo.json"
}

@test "export-tasks handles permission errors gracefully" {
    local output_file="/root/export.json"  # Unwritable location

    run "$PROJECT_ROOT/scripts/export-tasks.sh" T010 --output "$output_file"
    assert_failure
}
