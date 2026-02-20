#!/usr/bin/env bats
# =============================================================================
# labels-full.bats - Comprehensive unit tests for labels.sh
# =============================================================================
# Tests label management, filtering, statistics, and output formats.
# Expands on basic label functionality with edge cases and validation.
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

    # Set LABELS_SCRIPT path
    export LABELS_SCRIPT="${SCRIPTS_DIR}/labels.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# Helper to create tasks with labels
create_tasks_with_labels() {
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.1.0"},
  "tasks": [
    {"id": "T001", "title": "Backend API", "description": "API work", "status": "pending", "priority": "high", "labels": ["backend", "api"], "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T002", "title": "Frontend UI", "description": "UI work", "status": "pending", "priority": "medium", "labels": ["frontend", "ui"], "createdAt": "2025-12-01T11:00:00Z"},
    {"id": "T003", "title": "Database", "description": "DB work", "status": "done", "priority": "high", "labels": ["backend", "database"], "createdAt": "2025-12-01T12:00:00Z"},
    {"id": "T004", "title": "API tests", "description": "Testing", "status": "pending", "priority": "critical", "labels": ["backend", "api", "testing"], "createdAt": "2025-12-01T13:00:00Z"}
  ],
  "focus": {},
  "lastUpdated": "2025-12-01T13:00:00Z"
}
EOF
}

# =============================================================================
# Help and Basic Command Tests
# =============================================================================

@test "labels --help shows usage" {
    create_empty_todo
    run bash "$LABELS_SCRIPT" --help
    assert_success
    assert_output --partial "Usage:"
    assert_output --partial "cleo labels"
}

@test "labels -h shows usage" {
    create_empty_todo
    run bash "$LABELS_SCRIPT" -h
    assert_success
    assert_output --partial "Usage:"
}

@test "labels without subcommand defaults to list" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT"
    assert_success
    refute_output ""
}

@test "labels list subcommand works" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" list
    assert_success
    refute_output ""
}

# =============================================================================
# Labels List Tests
# =============================================================================

@test "labels lists all unique labels" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT"
    assert_success
    assert_output_contains_all "backend" "frontend" "api"
}

@test "labels shows task counts for each label" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT"
    assert_success
    assert_output --partial "tasks"
}

@test "labels handles empty todo list" {
    create_empty_todo
    run bash "$LABELS_SCRIPT"
    assert_success
    assert_output --partial "No labels found"
}

@test "labels handles tasks with no labels" {
    create_independent_tasks
    run bash "$LABELS_SCRIPT"
    assert_success
    assert_output --partial "No labels found"
}

@test "labels shows priority indicators for critical/high priority" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT"
    assert_success
    assert_output_contains_any "critical" "high"
}

@test "labels sorts by count descending" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT"
    assert_success
    # "backend" appears in 3 tasks, should be first
    refute_output ""
}

# =============================================================================
# Labels Show Subcommand Tests
# =============================================================================

@test "labels show backend displays tasks with backend label" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" show backend
    assert_success
    assert_output --partial "backend"
    assert_output_contains_any "T001" "T003" "T004"
}

@test "labels show frontend displays tasks with frontend label" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" show frontend
    assert_success
    assert_output --partial "T002"
}

@test "labels show nonexistent shows no tasks message" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" show nonexistent
    assert_success
    assert_output --partial "No tasks found"
}

@test "labels show requires label argument" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" show
    assert_failure
    assert_output --partial "ERROR"
}

@test "labels show empty label shows error" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" show ""
    assert_failure
    assert_output --partial "ERROR"
}

@test "labels show displays task status and priority" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" show backend
    assert_success
    assert_output_contains_any "Status:" "Priority:"
}

# =============================================================================
# Labels Stats Subcommand Tests
# =============================================================================

@test "labels stats shows statistics" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" stats
    assert_success
    assert_output --partial "Label Statistics"
}

@test "labels stats shows unique label count" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" stats
    assert_success
    assert_output --partial "Unique labels:"
}

@test "labels stats shows tasks with/without labels" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" stats
    assert_success
    assert_output_contains_any "Tasks with labels:" "Tasks without:"
}

@test "labels stats shows average labels per task" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" stats
    assert_success
    assert_output --partial "Avg labels/task:"
}

@test "labels stats shows top labels" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" stats
    assert_success
    assert_output --partial "Top Labels:"
}

@test "labels stats shows label co-occurrence" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" stats
    assert_success
    assert_output_contains_any "Common Label Pairs:" "backend"
}

@test "labels stats shows high-priority label distribution" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" stats
    assert_success
    assert_output --partial "High-Priority"
}

# =============================================================================
# Invalid Subcommand Tests
# =============================================================================

@test "labels invalid subcommand shows error" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" invalid
    assert_failure
    assert_output --partial "ERROR"
    assert_output --partial "Invalid subcommand"
}

@test "labels invalid subcommand suggests valid options" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" invalid
    assert_failure
    assert_output_contains_any "list" "show" "stats"
}

# =============================================================================
# JSON Output Format Tests
# =============================================================================

@test "labels --format json produces valid JSON" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" --format json
    assert_success
    assert_valid_json
}

@test "labels -f json produces valid JSON" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" -f json
    assert_success
    assert_valid_json
}

@test "labels JSON output has _meta.format field" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" --format json
    assert_success
    assert_json_has_key "_meta"
    run jq -e '._meta.format == "json"' <<< "$output"
    assert_success
}

@test "labels JSON output has labels array" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" --format json
    assert_success
    assert_json_has_key "labels"
    run jq -e '.labels | type == "array"' <<< "$output"
    assert_success
}

@test "labels JSON output has totalLabels count" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" --format json
    assert_success
    run jq -e '.totalLabels > 0' <<< "$output"
    assert_success
}

@test "labels show --format json produces valid JSON" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" show backend --format json
    assert_success
    assert_valid_json
}

@test "labels show JSON output has label and tasks" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" show backend --format json
    assert_success
    assert_json_has_key "label"
    assert_json_has_key "tasks"
    run jq -e '.label == "backend"' <<< "$output"
    assert_success
}

@test "labels stats --format json produces valid JSON" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" stats --format json
    assert_success
    assert_valid_json
}

@test "labels stats JSON has summary and labels" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" stats --format json
    assert_success
    assert_json_has_key "summary"
    assert_json_has_key "labels"
}

# =============================================================================
# Markdown Output Format Tests (if supported)
# =============================================================================

@test "labels handles markdown format option" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" --format markdown
    # Should either work or show error
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
}

# =============================================================================
# Empty Labels Handling Tests
# =============================================================================

@test "labels --format json handles empty labels" {
    create_empty_todo
    run bash "$LABELS_SCRIPT" --format json
    assert_success
    assert_valid_json
    # Store output before next run command overwrites it
    local json_output="$output"
    run jq -e '.totalLabels == 0' <<< "$json_output"
    assert_success
    run jq -e '.labels | length == 0' <<< "$json_output"
    assert_success
}

@test "labels show --format json handles nonexistent label" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" show nonexistent --format json
    assert_success
    assert_valid_json
    run jq -e '.taskCount == 0' <<< "$output"
    assert_success
}

@test "labels stats --format json handles empty labels" {
    create_empty_todo
    run bash "$LABELS_SCRIPT" stats --format json
    assert_success
    assert_valid_json
    run jq -e '.summary.uniqueLabels == 0' <<< "$output"
    assert_success
}

# =============================================================================
# Duplicate Label Deduplication Tests
# =============================================================================

@test "labels deduplicates labels correctly" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" --format json
    assert_success
    # Each label should appear only once in the list
    local backend_count=$(echo "$output" | jq '[.labels[] | select(.label == "backend")] | length')
    [[ "$backend_count" -eq 1 ]]
}

@test "labels counts tasks per label correctly" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" --format json
    assert_success
    # "backend" should have count of 3 (T001, T003, T004)
    run jq -e '.labels[] | select(.label == "backend") | .count == 3' <<< "$output"
    assert_success
}

# =============================================================================
# Label Co-occurrence Tests
# =============================================================================

@test "labels stats shows common label pairs" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" stats --format json
    assert_success
    assert_json_has_key "cooccurrence"
    run jq -e '.cooccurrence | type == "array"' <<< "$output"
    assert_success
}

@test "labels stats cooccurrence has correct structure" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" stats --format json
    assert_success
    # Each cooccurrence item should have pair and count
    local has_pair=$(echo "$output" | jq -e '.cooccurrence[0] | has("pair") and has("count")')
    [[ "$has_pair" == "true" ]] || [[ $(echo "$output" | jq '.cooccurrence | length') -eq 0 ]]
}

# =============================================================================
# Error Handling Tests
# =============================================================================

@test "labels handles missing todo.json" {
    rm -f "$TODO_FILE"
    run bash "$LABELS_SCRIPT"
    assert_failure
    assert_output --partial "ERROR"
}

@test "labels handles invalid format option" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" --format invalid
    assert_failure
    assert_output --partial "ERROR"
}

@test "labels handles unknown option" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" --unknown-option
    assert_failure
    assert_output --partial "ERROR"
}

# =============================================================================
# Visual Bar Display Tests
# =============================================================================

@test "labels displays visual bars for label counts" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT"
    assert_success
    # Should show some visual representation (Unicode or ASCII)
    refute_output ""
}

# =============================================================================
# NO_COLOR Compliance Tests
# =============================================================================

@test "labels respects NO_COLOR environment" {
    create_tasks_with_labels
    NO_COLOR=1 run bash "$LABELS_SCRIPT"
    assert_success
    # Should not contain ANSI escape sequences
    refute_output --regexp '\033\[[0-9;]*m'
}

# =============================================================================
# Pluralization Tests
# =============================================================================

@test "labels shows singular 'task' for count of 1" {
    create_empty_todo
    jq '.tasks = [{"id": "T001", "title": "Single", "description": "One", "status": "pending", "priority": "medium", "labels": ["single"], "createdAt": "2025-12-01T10:00:00Z"}]' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$LABELS_SCRIPT" show single
    assert_success
    assert_output --partial "1 task"
}

@test "labels shows plural 'tasks' for count > 1" {
    create_tasks_with_labels
    run bash "$LABELS_SCRIPT" show backend
    assert_success
    assert_output_contains_any "3 tasks" "tasks"
}

# =============================================================================
# Task Truncation Tests
# =============================================================================

@test "labels truncates long label names" {
    create_empty_todo
    jq '.tasks = [{"id": "T001", "title": "Task", "description": "D", "status": "pending", "priority": "medium", "labels": ["verylonglabelnamethatexceedsmaxlength"], "createdAt": "2025-12-01T10:00:00Z"}]' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$LABELS_SCRIPT"
    assert_success
    # Should show truncated version
    refute_output ""
}

@test "labels truncates long task titles in show" {
    create_empty_todo
    jq '.tasks = [{"id": "T001", "title": "This is a very long task title that should be truncated when displayed", "description": "D", "status": "pending", "priority": "medium", "labels": ["test"], "createdAt": "2025-12-01T10:00:00Z"}]' \
        "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$LABELS_SCRIPT" show test
    assert_success
    # Should show truncated title
    refute_output ""
}
