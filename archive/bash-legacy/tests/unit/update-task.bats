#!/usr/bin/env bats
# =============================================================================
# update-task.bats - Unit tests for update.sh
# =============================================================================
# Tests update-task command functionality including field updates,
# array operations, validation, and error handling.
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

@test "update --help shows usage" {
    create_empty_todo
    run bash "$UPDATE_SCRIPT" --help
    assert_shows_help
}

@test "update -h shows usage" {
    create_empty_todo
    run bash "$UPDATE_SCRIPT" -h
    assert_shows_help
}

# =============================================================================
# Single Field Updates
# =============================================================================

@test "update task title" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --title "Updated title"
    assert_success
    assert_output --partial "updated successfully"

    local title=$(jq -r '.tasks[0].title' "$TODO_FILE")
    [[ "$title" == "Updated title" ]]
}

@test "update task status" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --status active
    assert_success
    assert_task_status "T001" "active"
}

@test "update task priority" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --priority high
    assert_success

    local priority=$(jq -r '.tasks[0].priority' "$TODO_FILE")
    [[ "$priority" == "high" ]]
}

@test "update task description" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --description "New description"
    assert_success

    local desc=$(jq -r '.tasks[0].description' "$TODO_FILE")
    [[ "$desc" == "New description" ]]
}

@test "update task phase" {
    create_independent_tasks
    jq '.project.phases = {"testing": {"name": "Testing", "description": "Testing phase", "order": 1}}' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$UPDATE_SCRIPT" T001 --phase testing
    assert_success

    local phase=$(jq -r '.tasks[0].phase' "$TODO_FILE")
    [[ "$phase" == "testing" ]]
}

# =============================================================================
# Short Flags
# =============================================================================

@test "update task with -s status (short flag)" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 -s blocked -d "Waiting"
    assert_success
    assert_task_status "T001" "blocked"
}

@test "update task with -p priority (short flag)" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 -p critical
    assert_success

    local priority=$(jq -r '.tasks[0].priority' "$TODO_FILE")
    [[ "$priority" == "critical" ]]
}

@test "update task with -t title (short flag)" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 -t "New title"
    assert_success

    local title=$(jq -r '.tasks[0].title' "$TODO_FILE")
    [[ "$title" == "New title" ]]
}

@test "update task with -d description (short flag)" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 -d "New desc"
    assert_success

    local desc=$(jq -r '.tasks[0].description' "$TODO_FILE")
    [[ "$desc" == "New desc" ]]
}

@test "update task with -n notes (short flag)" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 -n "Progress note"
    assert_success

    local note=$(jq -r '.tasks[0].notes[0]' "$TODO_FILE")
    [[ "$note" == *"Progress note"* ]]
}

# =============================================================================
# Multiple Field Updates
# =============================================================================

@test "update multiple fields at once" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 \
        --title "Multi-update" \
        --priority high \
        --status active \
        --description "Multiple changes"
    assert_success

    local title=$(jq -r '.tasks[0].title' "$TODO_FILE")
    local priority=$(jq -r '.tasks[0].priority' "$TODO_FILE")
    local status=$(jq -r '.tasks[0].status' "$TODO_FILE")
    local desc=$(jq -r '.tasks[0].description' "$TODO_FILE")

    [[ "$title" == "Multi-update" ]]
    [[ "$priority" == "high" ]]
    [[ "$status" == "active" ]]
    [[ "$desc" == "Multiple changes" ]]
}

# =============================================================================
# Labels Array Operations
# =============================================================================

@test "update task append labels" {
    create_independent_tasks
    # First add initial labels
    bash "$UPDATE_SCRIPT" T001 --labels bug,urgent > /dev/null

    # Then append more
    run bash "$UPDATE_SCRIPT" T001 --labels security
    assert_success

    local labels=$(jq -r '.tasks[0].labels | sort | join(",")' "$TODO_FILE")
    [[ "$labels" == "bug,security,urgent" ]]
}

@test "update task set labels (replace)" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --labels bug,urgent > /dev/null

    run bash "$UPDATE_SCRIPT" T001 --set-labels frontend,ui
    assert_success

    local labels=$(jq -r '.tasks[0].labels | join(",")' "$TODO_FILE")
    [[ "$labels" == "frontend,ui" ]]
}

@test "update task clear labels" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --labels bug,urgent > /dev/null

    run bash "$UPDATE_SCRIPT" T001 --clear-labels
    assert_success

    local labels=$(jq -r '.tasks[0].labels // []' "$TODO_FILE")
    [[ "$labels" == "[]" ]]
}

@test "update task labels with -l short flag" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 -l bug,urgent
    assert_success

    local labels=$(jq -r '.tasks[0].labels | join(",")' "$TODO_FILE")
    [[ "$labels" == "bug,urgent" ]]
}

# =============================================================================
# Files Array Operations
# =============================================================================

@test "update task append files" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --files file1.txt > /dev/null

    run bash "$UPDATE_SCRIPT" T001 --files file2.txt
    assert_success

    local files=$(jq -r '.tasks[0].files | join(",")' "$TODO_FILE")
    [[ "$files" == "file1.txt,file2.txt" ]]
}

@test "update task set files (replace)" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --files file1.txt,file2.txt > /dev/null

    run bash "$UPDATE_SCRIPT" T001 --set-files file3.txt
    assert_success

    local files=$(jq -r '.tasks[0].files | join(",")' "$TODO_FILE")
    [[ "$files" == "file3.txt" ]]
}

@test "update task clear files" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --files file1.txt > /dev/null

    run bash "$UPDATE_SCRIPT" T001 --clear-files
    assert_success

    local files=$(jq -r '.tasks[0].files // []' "$TODO_FILE")
    [[ "$files" == "[]" ]]
}

# =============================================================================
# Acceptance Criteria Array Operations
# =============================================================================

@test "update task append acceptance criteria" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --acceptance "User can login" > /dev/null

    run bash "$UPDATE_SCRIPT" T001 --acceptance "Session persists"
    assert_success

    local acc_count=$(jq '.tasks[0].acceptance | length' "$TODO_FILE")
    [[ "$acc_count" -eq 2 ]]
}

@test "update task set acceptance (replace)" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --acceptance "Criterion 1,Criterion 2" > /dev/null

    run bash "$UPDATE_SCRIPT" T001 --set-acceptance "New criterion"
    assert_success

    local acc=$(jq -r '.tasks[0].acceptance | join(",")' "$TODO_FILE")
    [[ "$acc" == "New criterion" ]]
}

@test "update task clear acceptance" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --acceptance "Criterion" > /dev/null

    run bash "$UPDATE_SCRIPT" T001 --clear-acceptance
    assert_success

    local acc=$(jq -r '.tasks[0].acceptance // []' "$TODO_FILE")
    [[ "$acc" == "[]" ]]
}

# =============================================================================
# Dependencies Array Operations
# =============================================================================

@test "update task append dependencies" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T003 --depends T001 > /dev/null

    run bash "$UPDATE_SCRIPT" T003 --depends T002
    assert_success

    assert_task_depends_on "T003" "T001"
    assert_task_depends_on "T003" "T002"
}

@test "update task set dependencies (replace)" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T003 --depends T001,T002 > /dev/null

    run bash "$UPDATE_SCRIPT" T003 --set-depends T001
    assert_success

    local deps=$(jq -r '.tasks[2].depends | join(",")' "$TODO_FILE")
    [[ "$deps" == "T001" ]]
}

@test "update task clear dependencies" {
    create_linear_chain  # T001 <- T002 <- T003
    run bash "$UPDATE_SCRIPT" T002 --clear-depends
    assert_success

    assert_task_not_depends_on "T002" "T001"
}

# =============================================================================
# Notes Operations
# =============================================================================

@test "update task add notes" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --notes "First note"
    assert_success

    local note=$(jq -r '.tasks[0].notes[0]' "$TODO_FILE")
    [[ "$note" == *"First note"* ]]
}

@test "update task notes are timestamped" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --notes "Timestamped note" > /dev/null

    local note=$(jq -r '.tasks[0].notes[0]' "$TODO_FILE")
    [[ "$note" == *"UTC"* ]]
}

@test "update task multiple notes append" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --notes "Note 1" > /dev/null
    bash "$UPDATE_SCRIPT" T001 --notes "Note 2" > /dev/null

    local count=$(jq '.tasks[0].notes | length' "$TODO_FILE")
    [[ "$count" -eq 2 ]]
}

# =============================================================================
# Blocked By
# =============================================================================

@test "update task with --blocked-by sets status to blocked" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --blocked-by "Waiting for API spec"
    assert_success

    assert_task_status "T001" "blocked"
    local blocked=$(jq -r '.tasks[0].blockedBy' "$TODO_FILE")
    [[ "$blocked" == "Waiting for API spec" ]]
}

# =============================================================================
# Error Cases - Invalid Task ID
# =============================================================================

@test "update non-existent task fails" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T999 --priority high
    assert_failure
    assert_output --partial "not found"
}

@test "update without task ID fails" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" --priority high
    assert_failure
    assert_output --partial "Task ID is required"
}

@test "update with invalid task ID format fails" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" INVALID --priority high
    assert_failure
    assert_output --partial "Invalid task ID format"
}

# =============================================================================
# Error Cases - Invalid Values
# =============================================================================

@test "update with invalid status fails" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --status invalid
    assert_failure
    assert_output --partial "Invalid status"
}

@test "update with invalid priority fails" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --priority invalid
    assert_failure
    assert_output --partial "Invalid priority"
}

@test "update with invalid phase fails" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --phase nonexistent
    assert_failure
    assert_output --partial "phase"
}

@test "update with invalid label format fails" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --labels "Invalid Label"
    assert_failure
    assert_output --partial "label"
}

@test "update with invalid dependency fails" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --depends T999
    assert_failure
    assert_output --partial "not found"
}

@test "update with self-dependency fails" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --depends T001
    assert_failure
    assert_output --partial "cannot depend on itself"
}

# =============================================================================
# Error Cases - Status Transitions
# =============================================================================

@test "update status to done fails (use complete command instead)" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --status done
    assert_failure
    # Should direct users to use the complete command
    assert_output --partial "complete"
}

@test "update completed task fails" {
    create_tasks_with_completed
    run bash "$UPDATE_SCRIPT" T001 --priority high
    assert_failure
    # Work fields (priority, title, etc.) are blocked on completed tasks
    # Only metadata fields (type, parentId, size, labels) are allowed
    assert_output --partial "Cannot update work fields on completed task"
}

# =============================================================================
# Error Cases - Active Task Constraint
# =============================================================================

@test "update to active when another is active fails" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --status active > /dev/null

    run bash "$UPDATE_SCRIPT" T002 --status active
    assert_failure
    assert_output --partial "only ONE active task"
}

@test "update already active task to active succeeds" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --status active > /dev/null

    run bash "$UPDATE_SCRIPT" T001 --priority high
    assert_success
}

# =============================================================================
# Error Cases - No Updates Specified
# =============================================================================

@test "update without any changes fails" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001
    assert_failure
    assert_output --partial "No updates specified"
}

# =============================================================================
# Error Cases - Missing Files
# =============================================================================

@test "update handles missing todo.json gracefully" {
    rm -f "$TODO_FILE"
    run bash "$UPDATE_SCRIPT" T001 --priority high
    assert_failure
    assert_output --partial "not found"
}

# =============================================================================
# Circular Dependency Prevention
# =============================================================================

@test "update creating circular dependency fails" {
    create_linear_chain  # T001 <- T002 <- T003
    run bash "$UPDATE_SCRIPT" T001 --depends T003
    assert_failure
    assert_output --partial "circular"
}

@test "update with circular dependency via intermediate fails" {
    create_linear_chain  # T001 <- T002 <- T003
    run bash "$UPDATE_SCRIPT" T001 --depends T002
    assert_failure
    assert_output --partial "circular"
}

# =============================================================================
# JSON Validation
# =============================================================================

@test "update produces valid JSON" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --priority high > /dev/null

    run jq empty "$TODO_FILE"
    assert_success
}

@test "update updates lastUpdated timestamp" {
    create_independent_tasks
    local before=$(jq -r '.lastUpdated' "$TODO_FILE")

    sleep 1
    bash "$UPDATE_SCRIPT" T001 --priority high > /dev/null

    local after=$(jq -r '.lastUpdated' "$TODO_FILE")
    [[ "$after" != "$before" ]]
}

@test "update updates checksum" {
    create_independent_tasks
    local before=$(jq -r '._meta.checksum' "$TODO_FILE")

    bash "$UPDATE_SCRIPT" T001 --priority high > /dev/null

    local after=$(jq -r '._meta.checksum' "$TODO_FILE")
    [[ "$after" != "$before" ]]
}

# =============================================================================
# Output Format
# =============================================================================

@test "update shows changes made" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --priority high
    assert_success
    assert_output --partial "Changes:"
    assert_output --partial "priority"
}

@test "update shows task ID in output" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --priority high
    assert_success
    assert_output --partial "T001"
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "update empty title fails" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --title ""
    assert_failure
    # Empty title is treated as no update specified
    assert_output --partial "No updates specified"
}

@test "update title too long fails" {
    create_independent_tasks
    local long_title=$(printf 'a%.0s' {1..121})
    run bash "$UPDATE_SCRIPT" T001 --title "$long_title"
    assert_failure
    assert_output --partial "too long"
}

@test "update with special characters in description" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --description 'Special: $@!%^&*(){}[]|;<>?'
    assert_success

    local desc=$(jq -r '.tasks[0].description' "$TODO_FILE")
    [[ "$desc" == 'Special: $@!%^&*(){}[]|;<>?' ]]
}

@test "update with unicode characters" {
    create_independent_tasks
    run bash "$UPDATE_SCRIPT" T001 --title "Unicode: 🚀 émoji ñ"
    assert_success

    local title=$(jq -r '.tasks[0].title' "$TODO_FILE")
    [[ "$title" == "Unicode: 🚀 émoji ñ" ]]
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "update preserves other task fields" {
    create_independent_tasks
    local original_created=$(jq -r '.tasks[0].createdAt' "$TODO_FILE")

    bash "$UPDATE_SCRIPT" T001 --priority high > /dev/null

    local after_created=$(jq -r '.tasks[0].createdAt' "$TODO_FILE")
    [[ "$original_created" == "$after_created" ]]
}

@test "update does not affect other tasks" {
    create_independent_tasks
    local original_t2=$(jq -c '.tasks[1]' "$TODO_FILE")

    bash "$UPDATE_SCRIPT" T001 --priority high > /dev/null

    local after_t2=$(jq -c '.tasks[1]' "$TODO_FILE")
    [[ "$original_t2" == "$after_t2" ]]
}

# =============================================================================
# Idempotency Tests (LLM-Agent-First Spec v3.0, Part 5.6)
# =============================================================================

@test "idempotent update same priority returns EXIT_NO_CHANGE (102)" {
    create_independent_tasks
    # First update to set priority
    bash "$UPDATE_SCRIPT" T001 --priority high > /dev/null

    # Second update with same value should return 102
    run bash "$UPDATE_SCRIPT" T001 --priority high
    [ "$status" -eq 102 ]
    assert_output --partial "No changes needed"
}

@test "idempotent update same status returns EXIT_NO_CHANGE (102)" {
    create_independent_tasks
    # Task is already pending
    run bash "$UPDATE_SCRIPT" T001 --status pending
    [ "$status" -eq 102 ]
}

@test "idempotent update JSON output includes noChange flag" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --priority high > /dev/null

    run bash "$UPDATE_SCRIPT" T001 --priority high --json
    [ "$status" -eq 102 ]

    local no_change=$(echo "$output" | jq -r '.noChange')
    [[ "$no_change" == "true" ]]

    local success=$(echo "$output" | jq -r '.success')
    [[ "$success" == "true" ]]

    local message=$(echo "$output" | jq -r '.message')
    [[ "$message" == *"No changes needed"* ]]
}

@test "idempotent update with actual changes returns success (0)" {
    create_independent_tasks
    # Update to different priority
    run bash "$UPDATE_SCRIPT" T001 --priority high --json
    assert_success

    # Verify output shows change was made (noChange should not be present or be false)
    local no_change=$(echo "$output" | jq -r '.noChange // "absent"')
    [[ "$no_change" == "absent" || "$no_change" == "false" ]]
}

@test "idempotent update add existing label returns EXIT_NO_CHANGE" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --labels bug > /dev/null

    # Adding same label again should return 102
    run bash "$UPDATE_SCRIPT" T001 --labels bug
    [ "$status" -eq 102 ]
}

@test "idempotent update add new label returns success" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --labels bug > /dev/null

    # Adding different label should succeed
    run bash "$UPDATE_SCRIPT" T001 --labels feature
    assert_success

    local labels=$(jq -c '.tasks[0].labels | sort' "$TODO_FILE")
    [[ "$labels" == '["bug","feature"]' ]]
}

@test "idempotent update clear empty array returns EXIT_NO_CHANGE" {
    create_independent_tasks
    # Task has no labels initially

    # Clearing non-existent labels should return 102
    run bash "$UPDATE_SCRIPT" T001 --clear-labels
    [ "$status" -eq 102 ]
}

@test "idempotent update clear populated array returns success" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --labels bug > /dev/null

    # Clearing existing labels should succeed
    run bash "$UPDATE_SCRIPT" T001 --clear-labels
    assert_success
}

@test "idempotent update same title returns EXIT_NO_CHANGE" {
    create_independent_tasks
    local current_title=$(jq -r '.tasks[0].title' "$TODO_FILE")

    run bash "$UPDATE_SCRIPT" T001 --title "$current_title"
    [ "$status" -eq 102 ]
}

@test "idempotent update same description returns EXIT_NO_CHANGE" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --description "Test description" > /dev/null

    run bash "$UPDATE_SCRIPT" T001 --description "Test description"
    [ "$status" -eq 102 ]
}

@test "idempotent update notes always returns success (append-only)" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --notes "First note" > /dev/null

    # Adding same note should still succeed (notes are append-only, never idempotent)
    run bash "$UPDATE_SCRIPT" T001 --notes "First note"
    assert_success

    local count=$(jq '.tasks[0].notes | length' "$TODO_FILE")
    [[ "$count" -eq 2 ]]
}

@test "idempotent update same type returns EXIT_NO_CHANGE" {
    create_independent_tasks
    # Default type is "task"
    run bash "$UPDATE_SCRIPT" T001 --type task
    [ "$status" -eq 102 ]
}

@test "idempotent update same size returns EXIT_NO_CHANGE" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --size medium > /dev/null

    run bash "$UPDATE_SCRIPT" T001 --size medium
    [ "$status" -eq 102 ]
}

@test "idempotent update quiet mode suppresses output" {
    create_independent_tasks
    bash "$UPDATE_SCRIPT" T001 --priority high > /dev/null

    run bash "$UPDATE_SCRIPT" T001 --priority high --quiet
    [ "$status" -eq 102 ]
    assert_output ""
}
