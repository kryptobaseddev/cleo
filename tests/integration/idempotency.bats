#!/usr/bin/env bats
# =============================================================================
# idempotency.bats - Integration tests for command idempotency (Part 5.6)
# Part of EPIC T481: LLM-Agent-First Spec v3.0 Compliance
# =============================================================================
# Tests EXIT_NO_CHANGE (102) behavior for update, complete, archive, restore
# =============================================================================

# Load test helpers
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

# Helper to create a task with specific status
_create_task() {
    local title="$1"
    local status="${2:-pending}"
    local priority="${3:-medium}"

    cat > "$TODO_FILE" << EOF
{
  "\$schema": "../schemas/todo.schema.json",
  "_meta": {
    "version": "2.1.0",
    "checksum": "test123"
  },
  "tasks": [
    {
      "id": "T001",
      "title": "$title",
      "description": "Test description",
      "status": "$status",
      "priority": "$priority",
      "createdAt": "2025-12-01T10:00:00Z"
    }
  ],
  "focus": {},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF
}

# ============================================================================
# UPDATE COMMAND IDEMPOTENCY
# ============================================================================

@test "update: same priority returns EXIT_NO_CHANGE (102)" {
    # Create task with medium priority
    _create_task "Test task" "pending" "medium"

    # First update changes it to high
    run bash "$UPDATE_SCRIPT" T001 --priority high --format json
    assert_success
    local changes_output="$output"
    echo "$changes_output" | jq -e '.changes.priority' >/dev/null

    # Second update with same value should return 102
    run bash "$UPDATE_SCRIPT" T001 --priority high --format json
    [ "$status" -eq 102 ]

    # Should have noChange: true in output
    echo "$output" | jq -e '.noChange == true' >/dev/null
    echo "$output" | jq -e '.success == true' >/dev/null
}

@test "update: same status returns EXIT_NO_CHANGE (102)" {
    _create_task "Test task" "pending" "medium"

    # Set to active
    run bash "$UPDATE_SCRIPT" T001 --status active --format json
    assert_success

    # Same status again should return 102
    run bash "$UPDATE_SCRIPT" T001 --status active --format json
    [ "$status" -eq 102 ]
    echo "$output" | jq -e '.noChange == true' >/dev/null
}

@test "update: actual change returns EXIT_SUCCESS (0)" {
    _create_task "Test task" "pending" "low"

    # First real change
    run bash "$UPDATE_SCRIPT" T001 --priority high --format json
    assert_success
    [ "$status" -eq 0 ]

    # Output should NOT have noChange
    echo "$output" | jq -e 'has("noChange") | not' >/dev/null || \
    echo "$output" | jq -e '.noChange != true' >/dev/null
}

# ============================================================================
# COMPLETE COMMAND IDEMPOTENCY
# ============================================================================

@test "complete: already-done task returns EXIT_NO_CHANGE (102)" {
    _create_task "Test task" "done"

    # Complete already-done task
    run bash "$COMPLETE_SCRIPT" T001 --skip-notes --format json
    [ "$status" -eq 102 ]

    # Should have noChange: true
    echo "$output" | jq -e '.noChange == true' >/dev/null
    echo "$output" | jq -e '.success == true' >/dev/null
}

@test "complete: pending task returns EXIT_SUCCESS (0)" {
    _create_task "Test task" "pending"

    run bash "$COMPLETE_SCRIPT" T001 --skip-notes --format json
    assert_success
    [ "$status" -eq 0 ]

    # Should have completedAt
    echo "$output" | jq -e '.completedAt' >/dev/null
}

@test "complete: active task returns EXIT_SUCCESS (0)" {
    _create_task "Test task" "active"

    run bash "$COMPLETE_SCRIPT" T001 --skip-notes --format json
    assert_success
    [ "$status" -eq 0 ]
}

# ============================================================================
# ARCHIVE COMMAND IDEMPOTENCY
# ============================================================================

@test "archive: already-archived task returns success with 0 archived" {
    # Create done task
    _create_task "Test task" "done"

    # Archive it
    run bash "$ARCHIVE_SCRIPT" T001 --format json
    assert_success

    # Archive again - should succeed with 0 archived (idempotent)
    run bash "$ARCHIVE_SCRIPT" T001 --format json
    # Accept either 0 (no tasks to archive) or 102 (no change)
    [ "$status" -eq 0 ] || [ "$status" -eq 102 ]

    # Should have archived.count == 0
    local count
    count=$(echo "$output" | jq -r '.archived.count // 0')
    [ "$count" -eq 0 ]
}

@test "archive: done task returns EXIT_SUCCESS (0)" {
    _create_task "Test task" "done"

    run bash "$ARCHIVE_SCRIPT" T001 --format json
    assert_success
    [ "$status" -eq 0 ]
}

# ============================================================================
# RESTORE COMMAND IDEMPOTENCY
# ============================================================================

@test "restore: non-archived task returns appropriate error" {
    # Create active task
    _create_task "Test task" "pending"

    # Try to restore a task that's not in archive
    run bash "${SCRIPTS_DIR}/restore.sh" T001 --format json
    # Should fail since task is not in archive (various exit codes acceptable)
    # Exit 4 = NOT_FOUND, Exit 1 = error, Exit 2 = invalid input
    [ "$status" -ne 0 ]
}

# ============================================================================
# JSON OUTPUT FORMAT VERIFICATION
# ============================================================================

@test "idempotency: noChange response has correct JSON structure" {
    _create_task "Test task" "done"

    run bash "$COMPLETE_SCRIPT" T001 --skip-notes --format json
    [ "$status" -eq 102 ]

    # Verify JSON structure
    echo "$output" | jq -e '."$schema"' >/dev/null
    echo "$output" | jq -e '._meta' >/dev/null
    echo "$output" | jq -e '.success == true' >/dev/null
    echo "$output" | jq -e '.noChange == true' >/dev/null
    echo "$output" | jq -e '.message' >/dev/null
}

@test "idempotency: noChange message is descriptive" {
    _create_task "Test task" "done"

    run bash "$COMPLETE_SCRIPT" T001 --skip-notes --format json
    [ "$status" -eq 102 ]

    # Message should mention the task ID and explain why no change
    local message
    message=$(echo "$output" | jq -r '.message')
    [[ "$message" == *"T001"* ]] || [[ "$message" == *"already"* ]]
}

# ============================================================================
# DUPLICATE DETECTION (add command - SHOULD behavior)
# ============================================================================

@test "add: duplicate detection within 60s window (SHOULD)" {
    create_empty_todo

    # First add
    run bash "$ADD_SCRIPT" "Duplicate test task" --phase core --format json
    assert_success
    local first_id
    first_id=$(echo "$output" | jq -r '.task.id')

    # Second add with same title+phase within window
    run bash "$ADD_SCRIPT" "Duplicate test task" --phase core --format json

    # Per spec, SHOULD return existing task with duplicate: true
    # If implemented, should have success and duplicate flag
    if echo "$output" | jq -e '.duplicate == true' >/dev/null 2>&1; then
        local second_id
        second_id=$(echo "$output" | jq -r '.task.id')
        [ "$first_id" == "$second_id" ]
    fi
    # If not implemented, this test just verifies add still works
    assert_success
}

# ============================================================================
# EXIT CODE CONSTANT VERIFICATION
# ============================================================================

@test "EXIT_NO_CHANGE constant is defined as 102" {
    source "${LIB_DIR}/core/exit-codes.sh"
    [ "$EXIT_NO_CHANGE" -eq 102 ]
}

@test "EXIT_NO_CHANGE is not classified as error" {
    source "${LIB_DIR}/core/exit-codes.sh"

    # If is_error_code function exists, verify 102 is not an error
    if declare -f is_error_code >/dev/null 2>&1; then
        run is_error_code 102
        [ "$status" -ne 0 ]  # Should return false (non-zero)
    fi
}
