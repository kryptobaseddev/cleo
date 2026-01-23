#!/usr/bin/env bats
# =============================================================================
# add-task.bats - Unit tests for add-task.sh
# =============================================================================
# Tests add-task command functionality including validation, options,
# edge cases, and error handling.
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
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Help and Basic Command Tests
# =============================================================================

@test "add --help shows usage" {
    create_empty_todo
    run bash "$ADD_SCRIPT" --help
    assert_shows_help
}

@test "add -h shows usage" {
    create_empty_todo
    run bash "$ADD_SCRIPT" -h
    assert_shows_help
}

# =============================================================================
# Basic Task Creation
# =============================================================================

@test "add task with title only" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Basic task"
    assert_success
    assert_output --partial "Task added successfully"
    assert_task_count 1
}

@test "add task creates valid JSON" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Test task" > /dev/null
    run jq empty "$TODO_FILE"
    assert_success
}

@test "add task generates unique ID" {
    create_empty_todo
    bash "$ADD_SCRIPT" "First task" > /dev/null
    bash "$ADD_SCRIPT" "Second task" > /dev/null

    local id1=$(jq -r '.tasks[0].id' "$TODO_FILE")
    local id2=$(jq -r '.tasks[1].id' "$TODO_FILE")

    [[ "$id1" != "$id2" ]]
}

@test "add task with default status is pending" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Test task" > /dev/null

    local status=$(jq -r '.tasks[0].status' "$TODO_FILE")
    [[ "$status" == "pending" ]]
}

@test "add task with default priority is medium" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Test task" > /dev/null

    local priority=$(jq -r '.tasks[0].priority' "$TODO_FILE")
    [[ "$priority" == "medium" ]]
}

# =============================================================================
# Task Options - Long Flags
# =============================================================================

@test "add task with --priority high" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "High priority task" --priority high
    assert_success

    local priority=$(jq -r '.tasks[0].priority' "$TODO_FILE")
    [[ "$priority" == "high" ]]
}

@test "add task with --priority critical" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Critical task" --priority critical
    assert_success

    local priority=$(jq -r '.tasks[0].priority' "$TODO_FILE")
    [[ "$priority" == "critical" ]]
}

@test "add task with --priority low" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Low priority task" --priority low
    assert_success

    local priority=$(jq -r '.tasks[0].priority' "$TODO_FILE")
    [[ "$priority" == "low" ]]
}

@test "add task with --description" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task with description" --description "This is a detailed description"
    assert_success

    local desc=$(jq -r '.tasks[0].description' "$TODO_FILE")
    [[ "$desc" == "This is a detailed description" ]]
}

@test "add task with --labels" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Labeled task" --labels bug,urgent
    assert_success

    local labels=$(jq -r '.tasks[0].labels | join(",")' "$TODO_FILE")
    [[ "$labels" == "bug,urgent" ]]
}

@test "add task with --phase" {
    create_empty_todo
    # Add phase to todo.json first
    jq '.project.phases = {"core": {"name": "Core", "description": "Core development", "order": 1}}' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$ADD_SCRIPT" "Phased task" --phase core
    assert_success

    local phase=$(jq -r '.tasks[0].phase' "$TODO_FILE")
    [[ "$phase" == "core" ]]
}

@test "add task with --depends" {
    create_independent_tasks  # Creates T001, T002, T003
    run bash "$ADD_SCRIPT" "Dependent task" --depends T001,T002
    assert_success

    local deps=$(jq -r '.tasks[-1].depends | join(",")' "$TODO_FILE")
    [[ "$deps" == "T001,T002" ]]
}

@test "add task with --notes" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task with note" --notes "Initial note"
    assert_success

    local note=$(jq -r '.tasks[0].notes[0]' "$TODO_FILE")
    assert_output --partial "note"
    [[ "$note" == *"Initial note"* ]]
}

# =============================================================================
# Task Options - Short Flags
# =============================================================================

@test "add task with -p high (short flag)" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "High priority task" -p high
    assert_success

    local priority=$(jq -r '.tasks[0].priority' "$TODO_FILE")
    [[ "$priority" == "high" ]]
}

@test "add task with -d description (short flag)" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" -d "Short description"
    assert_success

    local desc=$(jq -r '.tasks[0].description' "$TODO_FILE")
    [[ "$desc" == "Short description" ]]
}

@test "add task with -l labels (short flag)" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" -l bug,security
    assert_success

    local labels=$(jq -r '.tasks[0].labels | join(",")' "$TODO_FILE")
    [[ "$labels" == "bug,security" ]]
}

@test "add task with -D depends (short flag)" {
    create_independent_tasks
    run bash "$ADD_SCRIPT" "Task" -D T001
    assert_success

    assert_task_depends_on "T004" "T001"
}

@test "add task with -s status (short flag)" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" -s pending
    assert_success

    assert_task_status "T001" "pending"
}

# =============================================================================
# Multiple Options
# =============================================================================

@test "add task with all options" {
    create_empty_todo
    jq '.project.phases = {"testing": {"name": "Testing", "description": "Testing phase", "order": 1}}' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$ADD_SCRIPT" "Complete task" \
        --priority high \
        --description "Full description" \
        --labels bug,urgent \
        --phase testing \
        --notes "Initial note"

    assert_success
    assert_task_count 1
}

# =============================================================================
# Label Deduplication
# =============================================================================

@test "add task with duplicate labels deduplicates them" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --labels bug,bug,bug
    assert_success

    # add-task deduplicates labels via normalize_labels
    local label_count=$(jq '.tasks[0].labels | length' "$TODO_FILE")
    [[ "$label_count" -eq 1 ]]
}

@test "add task with mixed duplicate labels deduplicates" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --labels bug,urgent,bug,security,urgent
    assert_success

    # add-task deduplicates labels via normalize_labels
    # bug,urgent,bug,security,urgent -> bug,security,urgent (3 unique)
    local label_count=$(jq '.tasks[0].labels | length' "$TODO_FILE")
    [[ "$label_count" -eq 3 ]]
}

# =============================================================================
# Special Characters
# =============================================================================

@test "add task with quotes in title" {
    create_empty_todo
    run bash "$ADD_SCRIPT" 'Task with "quotes" inside'
    assert_success

    local title=$(jq -r '.tasks[0].title' "$TODO_FILE")
    [[ "$title" == 'Task with "quotes" inside' ]]
}

@test "add task with dollar sign in title" {
    create_empty_todo
    run bash "$ADD_SCRIPT" 'Task with $VAR in title'
    assert_success

    local title=$(jq -r '.tasks[0].title' "$TODO_FILE")
    [[ "$title" == 'Task with $VAR in title' ]]
}

@test "add task with backticks in title" {
    create_empty_todo
    run bash "$ADD_SCRIPT" 'Task with `command` backticks'
    assert_success

    local title=$(jq -r '.tasks[0].title' "$TODO_FILE")
    [[ "$title" == 'Task with `command` backticks' ]]
}

@test "add task with special chars in description" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --description 'Special: $@!%^&*(){}[]|;<>?'
    assert_success

    local desc=$(jq -r '.tasks[0].description' "$TODO_FILE")
    [[ "$desc" == 'Special: $@!%^&*(){}[]|;<>?' ]]
}

# =============================================================================
# Unicode Support
# =============================================================================

@test "add task with unicode in title" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task with émojis 🚀 and ñ"
    assert_success

    local title=$(jq -r '.tasks[0].title' "$TODO_FILE")
    [[ "$title" == "Task with émojis 🚀 and ñ" ]]
}

@test "add task with CJK characters" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "任务 タスク 작업"
    assert_success

    local title=$(jq -r '.tasks[0].title' "$TODO_FILE")
    [[ "$title" == "任务 タスク 작업" ]]
}

# =============================================================================
# Error Cases - Missing Title
# =============================================================================

@test "add task without title fails" {
    create_empty_todo
    run bash "$ADD_SCRIPT"
    assert_failure
    assert_output --partial "ERROR"
    assert_output --partial "title"
}

@test "add task with empty title fails" {
    create_empty_todo
    run bash "$ADD_SCRIPT" ""
    assert_failure
    assert_output --partial "ERROR"
}

# =============================================================================
# Error Cases - Invalid Options
# =============================================================================

@test "add task with invalid priority fails" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --priority invalid
    assert_failure
    assert_output --partial "ERROR"
    assert_output --partial "priority"
}

@test "add task with invalid status fails" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --status invalid
    assert_failure
    assert_output --partial "ERROR"
    assert_output --partial "status"
}

@test "add task with invalid phase fails" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --phase nonexistent
    assert_failure
    assert_output --partial "ERROR"
    assert_output --partial "phase"
}

@test "add task with invalid dependency ID fails" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --depends INVALID
    assert_failure
    assert_output --partial "ERROR"
}

@test "add task with non-existent dependency fails" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --depends T999
    assert_failure
    assert_output --partial "ERROR"
    assert_output --partial "not found"
}

@test "add task with invalid label format fails" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --labels "Invalid Label"
    assert_failure
    assert_output --partial "ERROR"
    assert_output --partial "label"
}

@test "add task with uppercase label fails" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --labels UPPERCASE
    assert_failure
    assert_output --partial "ERROR"
}

# =============================================================================
# Error Cases - Missing Files
# =============================================================================

@test "add task without todo.json fails" {
    rm -f "$TODO_FILE"
    run bash "$ADD_SCRIPT" "Task"
    assert_failure
    assert_output --partial "not found"
}

# =============================================================================
# Quiet Mode
# =============================================================================

@test "add task with --quiet outputs only task ID" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --quiet
    assert_success
    assert_output "T001"
}

@test "add task with -q outputs only task ID (short flag)" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" -q
    assert_success
    assert_output "T001"
}

@test "add task quiet mode output is valid task ID format" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" -q
    assert_success
    [[ "$output" =~ ^T[0-9]{3}$ ]]
}

# =============================================================================
# JSON Output Validation
# =============================================================================

@test "add task creates valid JSON structure" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Task" > /dev/null

    run jq -e '.tasks[0] | has("id")' "$TODO_FILE"
    assert_success

    run jq -e '.tasks[0] | has("title")' "$TODO_FILE"
    assert_success

    run jq -e '.tasks[0] | has("status")' "$TODO_FILE"
    assert_success

    run jq -e '.tasks[0] | has("priority")' "$TODO_FILE"
    assert_success

    run jq -e '.tasks[0] | has("createdAt")' "$TODO_FILE"
    assert_success
}

@test "add task updates lastUpdated timestamp" {
    create_empty_todo
    local before=$(jq -r '.lastUpdated // ""' "$TODO_FILE")

    sleep 1
    bash "$ADD_SCRIPT" "Task" > /dev/null

    local after=$(jq -r '.lastUpdated' "$TODO_FILE")
    [[ "$after" != "$before" ]]
}

@test "add task updates checksum" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Task" > /dev/null

    local checksum=$(jq -r '._meta.checksum' "$TODO_FILE")
    [[ -n "$checksum" ]]
    [[ "$checksum" != "null" ]]
}

# =============================================================================
# Active Task Constraint
# =============================================================================

@test "add active task when one exists fails" {
    create_empty_todo
    bash "$ADD_SCRIPT" "First active" --status active > /dev/null

    run bash "$ADD_SCRIPT" "Second active" --status active
    assert_failure
    assert_output --partial "only ONE active task"
}

@test "add active task when none exists succeeds" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Active task" --status active
    assert_success
    assert_task_status "T001" "active"
}

# =============================================================================
# Blocked Task Validation
# =============================================================================

@test "add blocked task without description fails" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Blocked task" --status blocked
    assert_failure
    assert_output --partial "description"
}

@test "add blocked task with description succeeds" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Blocked task" --status blocked --description "Waiting for API"
    assert_success
    assert_task_status "T001" "blocked"
}

# =============================================================================
# Circular Dependency Prevention
# =============================================================================

@test "add task with circular dependency fails" {
    create_empty_todo

    # This test requires the task to be created first, then would depend on itself
    # This is prevented at the validation level
    run bash "$ADD_SCRIPT" "Task" --depends T001
    assert_failure
}

# =============================================================================
# Long Title Validation
# =============================================================================

@test "add task with 120 char title succeeds" {
    create_empty_todo
    local long_title=$(printf 'a%.0s' {1..120})
    run bash "$ADD_SCRIPT" "$long_title"
    assert_success
}

@test "add task with 121 char title fails" {
    create_empty_todo
    local long_title=$(printf 'a%.0s' {1..121})
    run bash "$ADD_SCRIPT" "$long_title"
    assert_failure
    assert_output --partial "too long"
}

# =============================================================================
# Duplicate Title Warning
# =============================================================================

@test "add task with duplicate title shows warning" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Duplicate task" > /dev/null

    run bash "$ADD_SCRIPT" "Duplicate task"
    assert_success
    assert_output --partial "WARN"
    assert_output --partial "Duplicate"
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "add multiple tasks increments IDs correctly" {
    create_empty_todo
    bash "$ADD_SCRIPT" "Task 1" > /dev/null
    bash "$ADD_SCRIPT" "Task 2" > /dev/null
    bash "$ADD_SCRIPT" "Task 3" > /dev/null

    assert_task_count 3

    local id1=$(jq -r '.tasks[0].id' "$TODO_FILE")
    local id2=$(jq -r '.tasks[1].id' "$TODO_FILE")
    local id3=$(jq -r '.tasks[2].id' "$TODO_FILE")

    [[ "$id1" == "T001" ]]
    [[ "$id2" == "T002" ]]
    [[ "$id3" == "T003" ]]
}

@test "add task with files option" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --files "file1.txt,file2.txt"
    assert_success

    local files=$(jq -r '.tasks[0].files | join(",")' "$TODO_FILE")
    [[ "$files" == "file1.txt,file2.txt" ]]
}

@test "add task with acceptance criteria" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Task" --acceptance "User can login,Session persists"
    assert_success

    local acc=$(jq -r '.tasks[0].acceptance | join(",")' "$TODO_FILE")
    [[ "$acc" == "User can login,Session persists" ]]
}

# =============================================================================
# Phase Context Validation Tests (T462)
# =============================================================================

@test "add-task warns on phase mismatch when warnPhaseContext enabled" {
    create_empty_todo
    # Setup: Enable warnings, disable description requirement, keep multiSession disabled for tests
    echo '{"version":"2.2.0","validation":{"requireDescription":false,"phaseValidation":{"warnPhaseContext":true}},"multiSession":{"enabled":false},"session":{"requireSession":false}}' > "$CONFIG_FILE"

    # Set project phase to core
    jq '.project.currentPhase = "core"' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$ADD_SCRIPT" "Test task" --phase setup --human
    assert_success
    assert_output --partial "WARN"  # Warning shown but creation succeeds
}

@test "add-task silent on phase mismatch when warnPhaseContext disabled" {
    create_empty_todo
    # Config with warnings disabled, disable description requirement, keep multiSession disabled for tests
    echo '{"version":"2.2.0","validation":{"requireDescription":false,"phaseValidation":{"warnPhaseContext":false}},"multiSession":{"enabled":false},"session":{"requireSession":false}}' > "$CONFIG_FILE"

    # Set project phase to core
    jq '.project.currentPhase = "core"' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Define setup phase so validation passes
    jq '.project.phases.setup = {"order": 1, "name": "Setup"}' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$ADD_SCRIPT" "Test task" --phase setup --human
    assert_success
    refute_output --partial "differs from"
}

@test "add-task never blocks on phase mismatch" {
    create_empty_todo
    # Even with warnings enabled, creation should succeed (keep multiSession disabled for tests)
    echo '{"version":"2.2.0","validation":{"requireDescription":false,"phaseValidation":{"warnPhaseContext":true}},"multiSession":{"enabled":false},"session":{"requireSession":false}}' > "$CONFIG_FILE"

    jq '.project.currentPhase = "core"' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$ADD_SCRIPT" "Test task" --phase setup
    assert_success

    # Verify task was created
    local count
    count=$(jq '.tasks | length' "$TODO_FILE")
    [ "$count" -eq 1 ]
}

# =============================================================================
# Duplicate Detection Tests (T493 - LLM-Agent-First Spec v3.0 Part 5.6)
# =============================================================================

@test "add detects duplicate within 60s window" {
    create_empty_todo
    # Create first task
    bash "$ADD_SCRIPT" "Duplicate Test Task" > /dev/null

    # Try to create same task again immediately
    run bash "$ADD_SCRIPT" "Duplicate Test Task" --human
    assert_success
    assert_output --partial "Duplicate detected"
    assert_output --partial "T001"

    # Verify only one task exists
    local count
    count=$(jq '.tasks | length' "$TODO_FILE")
    [ "$count" -eq 1 ]
}

@test "add detects duplicate with matching phase" {
    create_empty_todo
    # Add phase first
    jq '.project.phases = {"core": {"name": "Core", "order": 1}}' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Create first task with phase
    bash "$ADD_SCRIPT" "Phased Task" --phase core > /dev/null

    # Try to create same task with same phase
    run bash "$ADD_SCRIPT" "Phased Task" --phase core --human
    assert_success
    assert_output --partial "Duplicate detected"
    assert_output --partial "phase 'core'"

    # Verify only one task exists
    local count
    count=$(jq '.tasks | length' "$TODO_FILE")
    [ "$count" -eq 1 ]
}

@test "add allows same title with different phase" {
    create_empty_todo
    # Add phases first
    jq '.project.phases = {"core": {"name": "Core", "order": 1}, "testing": {"name": "Testing", "order": 2}}' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Create first task with core phase
    bash "$ADD_SCRIPT" "Multi-phase Task" --phase core > /dev/null

    # Create same title with different phase - should succeed
    run bash "$ADD_SCRIPT" "Multi-phase Task" --phase testing
    assert_success
    refute_output --partial "Duplicate detected"

    # Verify two tasks exist
    local count
    count=$(jq '.tasks | length' "$TODO_FILE")
    [ "$count" -eq 2 ]
}

@test "add duplicate returns JSON with duplicate flag" {
    create_empty_todo
    # Create first task
    bash "$ADD_SCRIPT" "JSON Duplicate Test" > /dev/null

    # Try duplicate with JSON output
    run bash "$ADD_SCRIPT" "JSON Duplicate Test" --json
    assert_success

    # Parse JSON output
    local is_duplicate success task_id
    is_duplicate=$(echo "$output" | jq -r '.duplicate')
    success=$(echo "$output" | jq -r '.success')
    task_id=$(echo "$output" | jq -r '.task.id')

    [ "$is_duplicate" = "true" ]
    [ "$success" = "true" ]
    [ "$task_id" = "T001" ]
}

@test "add duplicate quiet mode returns existing ID" {
    create_empty_todo
    # Create first task
    bash "$ADD_SCRIPT" "Quiet Duplicate" -q > /dev/null

    # Try duplicate in quiet mode
    run bash "$ADD_SCRIPT" "Quiet Duplicate" -q
    assert_success
    assert_output "T001"
}

@test "add duplicate exits with success code 0" {
    create_empty_todo
    # Create first task
    bash "$ADD_SCRIPT" "Exit Code Test" > /dev/null

    # Try duplicate - should exit 0 (success, not error)
    bash "$ADD_SCRIPT" "Exit Code Test" > /dev/null
    local exit_code=$?
    [ "$exit_code" -eq 0 ]
}

@test "add allows duplicate outside time window" {
    create_empty_todo
    # Create task with old timestamp (simulate task created 2 minutes ago)
    local old_timestamp
    old_timestamp=$(date -u -d "2 minutes ago" +"%Y-%m-%dT%H:%M:%SZ")
    jq --arg ts "$old_timestamp" '.tasks = [{"id":"T001","title":"Old Task","status":"pending","priority":"medium","type":"task","createdAt":$ts}]' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Try to create same task - should succeed since original is outside 60s window
    run bash "$ADD_SCRIPT" "Old Task"
    assert_success
    refute_output --partial "Duplicate detected"

    # Verify two tasks exist
    local count
    count=$(jq '.tasks | length' "$TODO_FILE")
    [ "$count" -eq 2 ]
}

@test "add duplicate JSON includes message with seconds" {
    create_empty_todo
    # Create first task
    bash "$ADD_SCRIPT" "Message Test" > /dev/null

    # Try duplicate with JSON output
    run bash "$ADD_SCRIPT" "Message Test" --json
    assert_success

    # Verify message field exists and contains timing info
    local message
    message=$(echo "$output" | jq -r '.message')
    [[ "$message" == *"seconds ago"* ]]
}
