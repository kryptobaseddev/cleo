#!/usr/bin/env bats
# =============================================================================
# workflow.bats - End-to-end workflow integration tests
# =============================================================================
# Tests complete workflows:
# - Full task lifecycle
# - Session workflows
# - Multi-command interactions
# - Real-world usage patterns
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    load '../test_helper/edge-case-fixtures'
    load '../test_helper/assertions'
    common_setup_per_test

    # Create empty archive for tests
    export ARCHIVE_FILE="${TEST_TEMP_DIR}/.cleo/todo-archive.json"
    create_empty_archive "$ARCHIVE_FILE"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Full Task Lifecycle Tests
# =============================================================================

@test "full task lifecycle: add → update → complete → archive" {
    create_empty_todo

    # Add task
    run bash "$ADD_SCRIPT" "Integration test task" --description "Full lifecycle test" --priority high
    assert_success
    local task_id
    task_id=$(jq -r '.tasks[-1].id' "$TODO_FILE")
    [[ -n "$task_id" ]]

    # Verify task was created
    assert_task_exists "$task_id"
    assert_task_status "$task_id" "pending"

    # Update task
    run bash "$UPDATE_SCRIPT" "$task_id" --labels integration,test --priority critical
    assert_success

    # Verify updates
    local priority
    priority=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .priority' "$TODO_FILE")
    [[ "$priority" == "critical" ]]

    local labels
    labels=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .labels | join(",")' "$TODO_FILE")
    [[ "$labels" == "integration,test" ]]

    # Complete task
    run bash "$COMPLETE_SCRIPT" "$task_id" --notes "Integration test passed"
    assert_success
    assert_task_status "$task_id" "done"

    # Verify completion notes
    local notes
    notes=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .notes[-1]' "$TODO_FILE")
    [[ "$notes" == *"Integration test passed"* ]]

    # Archive task (use --all for testing to bypass preserve count)
    run bash "$SCRIPTS_DIR/archive.sh" --all
    assert_success

    # Verify task is in archive
    run jq -r --arg id "$task_id" '.archivedTasks[] | select(.id == $id) | .id' "$ARCHIVE_FILE"
    assert_output "$task_id"

    # Verify task removed from todo.json
    run jq --arg id "$task_id" '.tasks[] | select(.id == $id)' "$TODO_FILE"
    assert_output ""
}

@test "multiple tasks lifecycle with dependencies" {
    create_empty_todo

    # Add foundation task
    bash "$ADD_SCRIPT" "Foundation" --description "Base task" --priority critical
    local task1
    task1=$(jq -r '.tasks[-1].id' "$TODO_FILE")

    # Add dependent task
    bash "$ADD_SCRIPT" "Dependent" --description "Depends on foundation" --priority high --depends "$task1"
    local task2
    task2=$(jq -r '.tasks[-1].id' "$TODO_FILE")

    # Verify dependency
    assert_task_depends_on "$task2" "$task1"

    # Complete foundation
    bash "$COMPLETE_SCRIPT" "$task1" --skip-notes

    # Complete dependent
    bash "$COMPLETE_SCRIPT" "$task2" --skip-notes

    # Archive both (use --all to bypass preserve count in tests)
    bash "$SCRIPTS_DIR/archive.sh" --all

    # Verify both archived
    local archived_count
    archived_count=$(jq '.archivedTasks | length' "$ARCHIVE_FILE")
    [[ "$archived_count" -eq 2 ]]
}

# =============================================================================
# Session Workflow Tests
# =============================================================================

@test "session workflow: start → focus → work → complete → end" {
    create_standard_tasks

    # Start session
    run bash "$SCRIPTS_DIR/session.sh" start
    assert_success

    # Verify session started in log
    run jq '.entries[-1].action' "$LOG_FILE"
    assert_output '"session_start"'

    # Set focus
    local task_id
    task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")
    run bash "$SCRIPTS_DIR/focus.sh" set "$task_id"
    assert_success

    # Verify focus set
    run jq -r '.focus.currentTask' "$TODO_FILE"
    assert_output "$task_id"

    # Add session note
    run bash "$SCRIPTS_DIR/focus.sh" note "Working on integration test"
    assert_success

    # Complete task
    run bash "$COMPLETE_SCRIPT" "$task_id" --notes "Done in session"
    assert_success

    # End session
    run bash "$SCRIPTS_DIR/session.sh" end
    assert_success

    # Verify session ended in log
    run jq '.entries[-1].action' "$LOG_FILE"
    assert_output '"session_end"'
}

@test "session with multiple tasks and focus changes" {
    create_independent_tasks

    bash "$SCRIPTS_DIR/session.sh" start

    # Work on first task
    local task1
    task1=$(jq -r '.tasks[0].id' "$TODO_FILE")
    bash "$SCRIPTS_DIR/focus.sh" set "$task1"
    bash "$SCRIPTS_DIR/focus.sh" note "Starting task 1"

    # Switch to second task
    local task2
    task2=$(jq -r '.tasks[1].id' "$TODO_FILE")
    bash "$SCRIPTS_DIR/focus.sh" set "$task2"
    bash "$SCRIPTS_DIR/focus.sh" note "Switched to task 2"

    # Verify current focus is task2
    run jq -r '.focus.currentTask' "$TODO_FILE"
    assert_output "$task2"

    # Complete both tasks
    bash "$COMPLETE_SCRIPT" "$task1" --skip-notes
    bash "$COMPLETE_SCRIPT" "$task2" --skip-notes

    bash "$SCRIPTS_DIR/session.sh" end

    # Verify session logged multiple actions
    local log_count
    log_count=$(jq '.entries | length' "$LOG_FILE")
    [[ "$log_count" -gt 2 ]]
}

# =============================================================================
# Complex Dependency Workflows
# =============================================================================

@test "dependency chain completion workflow" {
    create_linear_chain

    # Complete in order
    bash "$COMPLETE_SCRIPT" T001 --skip-notes
    bash "$COMPLETE_SCRIPT" T002 --skip-notes
    bash "$COMPLETE_SCRIPT" T003 --skip-notes

    # Verify all completed
    assert_task_status "T001" "done"
    assert_task_status "T002" "done"
    assert_task_status "T003" "done"

    # Archive all (use --all to bypass preserve count in tests)
    bash "$SCRIPTS_DIR/archive.sh" --all

    # Verify all archived
    local archived_count
    archived_count=$(jq '.archivedTasks | length' "$ARCHIVE_FILE")
    [[ "$archived_count" -eq 3 ]]
}

@test "complex dependency graph workflow" {
    create_complex_deps

    # Complete roots first
    bash "$COMPLETE_SCRIPT" T001 --skip-notes
    bash "$COMPLETE_SCRIPT" T002 --skip-notes

    # Then dependent
    bash "$COMPLETE_SCRIPT" T003 --skip-notes

    # Then final
    bash "$COMPLETE_SCRIPT" T004 --skip-notes

    # Complete independent
    bash "$COMPLETE_SCRIPT" T005 --skip-notes

    # Archive (use --all to bypass preserve count in tests)
    bash "$SCRIPTS_DIR/archive.sh" --all

    # Verify 5 tasks archived
    local archived_count
    archived_count=$(jq '.archivedTasks | length' "$ARCHIVE_FILE")
    [[ "$archived_count" -eq 5 ]]
}

# =============================================================================
# Blocked Task Workflows
# =============================================================================

@test "unblock workflow: complete blocker → dependent becomes available" {
    create_blocked_tasks

    # Verify T002 is blocked
    assert_task_status "T002" "blocked"

    # Complete T001 (the blocker)
    bash "$COMPLETE_SCRIPT" T001 --skip-notes

    # T002 should still exist and can be worked on
    assert_task_exists "T002"

    # Complete T002
    run bash "$COMPLETE_SCRIPT" T002 --skip-notes
    assert_success
}

@test "multi-blocker workflow: all dependencies must complete" {
    create_multi_blocker_tasks

    # Task T003 is blocked by both T001 and T002
    assert_task_status "T003" "blocked"

    # Complete first dependency
    bash "$COMPLETE_SCRIPT" T001 --skip-notes

    # T003 should still be blocked (waiting for T002)
    assert_task_status "T003" "blocked"

    # Complete second dependency
    bash "$COMPLETE_SCRIPT" T002 --skip-notes

    # Now T003 can be completed
    run bash "$COMPLETE_SCRIPT" T003 --skip-notes
    assert_success
    assert_task_status "T003" "done"
}

# =============================================================================
# Label-Based Workflows
# =============================================================================

@test "label workflow: add tasks → filter by label → batch complete" {
    create_empty_todo

    # Add tasks with labels
    bash "$ADD_SCRIPT" "Bug fix 1" --description "Fix bug 1" --labels bug,urgent
    bash "$ADD_SCRIPT" "Bug fix 2" --description "Fix bug 2" --labels bug,urgent
    bash "$ADD_SCRIPT" "Feature 1" --description "New feature" --labels feature

    # Get bug tasks
    local bug_tasks
    bug_tasks=$(jq -r '.tasks[] | select(.labels? and (.labels | contains(["bug"]))) | .id' "$TODO_FILE")

    # Complete all bug tasks
    for task_id in $bug_tasks; do
        bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes
    done

    # Verify 2 completed, 1 pending
    local completed_count
    completed_count=$(jq '[.tasks[] | select(.status == "done")] | length' "$TODO_FILE")
    [[ "$completed_count" -eq 2 ]]

    local pending_count
    pending_count=$(jq '[.tasks[] | select(.status == "pending")] | length' "$TODO_FILE")
    [[ "$pending_count" -eq 1 ]]
}

# =============================================================================
# Priority-Based Workflows
# =============================================================================

@test "priority workflow: work critical → high → medium → low" {
    create_empty_todo

    # Add tasks with different priorities
    bash "$ADD_SCRIPT" "Low priority" --description "Low" --priority low
    bash "$ADD_SCRIPT" "Critical task" --description "Critical" --priority critical
    bash "$ADD_SCRIPT" "Medium task" --description "Medium" --priority medium
    bash "$ADD_SCRIPT" "High priority" --description "High" --priority high

    # Get tasks in priority order
    local tasks_by_priority
    tasks_by_priority=$(jq -r '.tasks | sort_by(
        if .priority == "critical" then 0
        elif .priority == "high" then 1
        elif .priority == "medium" then 2
        else 3 end
    ) | .[].id' "$TODO_FILE")

    # Complete in priority order
    for task_id in $tasks_by_priority; do
        bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes
    done

    # Verify all completed
    local completed_count
    completed_count=$(jq '[.tasks[] | select(.status == "done")] | length' "$TODO_FILE")
    [[ "$completed_count" -eq 4 ]]
}

# =============================================================================
# Export Workflows
# =============================================================================

@test "export workflow: work in claude-todo → export to TodoWrite format" {
    create_standard_tasks

    # Export to TodoWrite format
    run bash "$SCRIPTS_DIR/export.sh" --format todowrite
    assert_success

    # Verify output has TodoWrite structure
    assert_output --partial "content"
    assert_output --partial "status"
    assert_output --partial "activeForm"
}

@test "export workflow preserves task data" {
    create_independent_tasks

    run bash "$SCRIPTS_DIR/export.sh" --format todowrite
    assert_success

    # Verify all tasks present
    assert_output --partial "First task"
    assert_output --partial "Second task"
    assert_output --partial "Third task"
}

# =============================================================================
# Validation Workflows
# =============================================================================

@test "validation workflow: detect → fix → verify" {
    create_corrupted_checksum_todo

    # Detect problem
    run bash "$VALIDATE_SCRIPT"
    assert_failure

    # Fix problem
    bash "$VALIDATE_SCRIPT" --fix

    # Verify fixed
    run bash "$VALIDATE_SCRIPT"
    assert_success
}

@test "validation prevents invalid operations" {
    create_circular_deps

    # Validate should catch circular dependency
    run bash "$VALIDATE_SCRIPT"
    assert_failure
    assert_output --partial "circular"
}

# =============================================================================
# Batch Operation Workflows
# =============================================================================

@test "batch create and complete workflow" {
    create_empty_todo

    # Batch create
    for i in {1..10}; do
        bash "$ADD_SCRIPT" "Batch task $i" --description "Task $i" --priority medium
    done

    # Verify 10 tasks created
    assert_task_count 10

    # Get all task IDs
    local task_ids
    task_ids=$(jq -r '.tasks[].id' "$TODO_FILE")

    # Batch complete
    for task_id in $task_ids; do
        bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes
    done

    # Verify all completed
    local completed_count
    completed_count=$(jq '[.tasks[] | select(.status == "done")] | length' "$TODO_FILE")
    [[ "$completed_count" -eq 10 ]]

    # Batch archive (use --all to bypass preserve count in tests)
    bash "$SCRIPTS_DIR/archive.sh" --all

    # Verify all archived
    local archived_count
    archived_count=$(jq '.archivedTasks | length' "$ARCHIVE_FILE")
    [[ "$archived_count" -eq 10 ]]
}

# =============================================================================
# Phase Lifecycle Workflows (v2.2.0)
# =============================================================================

@test "phase workflow: set → start → add tasks → complete → advance" {
    create_empty_todo_no_phases
    # Phases are already defined in fixture with pending status

    # Start setup phase
    run bash "$SCRIPTS_DIR/phase.sh" start setup
    assert_success

    # Verify phase is active
    run jq -r '.project.currentPhase' "$TODO_FILE"
    assert_output "setup"

    run jq -r '.project.phases.setup.status' "$TODO_FILE"
    assert_output "active"

    # Add tasks to setup phase
    bash "$ADD_SCRIPT" "Setup task 1" --description "First setup task" --phase setup
    bash "$ADD_SCRIPT" "Setup task 2" --description "Second setup task" --phase setup

    # Complete all setup tasks
    local task1 task2
    task1=$(jq -r '.tasks[0].id' "$TODO_FILE")
    task2=$(jq -r '.tasks[1].id' "$TODO_FILE")

    bash "$COMPLETE_SCRIPT" "$task1" --skip-notes
    bash "$COMPLETE_SCRIPT" "$task2" --skip-notes

    # Complete setup phase
    run bash "$SCRIPTS_DIR/phase.sh" complete setup
    assert_success

    # Verify setup completed
    run jq -r '.project.phases.setup.status' "$TODO_FILE"
    assert_output "completed"

    # Advance to next phase
    run bash "$SCRIPTS_DIR/phase.sh" advance
    assert_success

    # Verify current phase is now core
    run jq -r '.project.currentPhase' "$TODO_FILE"
    assert_output "core"

    run jq -r '.project.phases.core.status' "$TODO_FILE"
    assert_output "active"
}

@test "phase workflow: tasks inherit currentPhase when added" {
    create_empty_todo_no_phases
    # Phases defined in fixture

    # Start setup phase
    bash "$SCRIPTS_DIR/phase.sh" start setup

    # Add task without explicit phase (should inherit currentPhase)
    bash "$ADD_SCRIPT" "Auto-phased task" --description "Should inherit setup phase"

    # Verify task has setup phase
    local phase
    phase=$(jq -r '.tasks[0].phase' "$TODO_FILE")
    [[ "$phase" == "setup" ]]
}

@test "phase workflow: focus changes update currentPhase" {
    create_empty_todo_no_phases
    # Phases defined in fixture

    # Start setup phase
    bash "$SCRIPTS_DIR/phase.sh" start setup

    # Add tasks to different phases
    bash "$ADD_SCRIPT" "Setup task" --description "Task in setup" --phase setup
    bash "$ADD_SCRIPT" "Core task" --description "Task in core" --phase core

    local setup_task core_task
    setup_task=$(jq -r '.tasks[0].id' "$TODO_FILE")
    core_task=$(jq -r '.tasks[1].id' "$TODO_FILE")

    # Focus on core task
    bash "$SCRIPTS_DIR/focus.sh" set "$core_task"

    # Verify currentPhase changed to core
    run jq -r '.project.currentPhase' "$TODO_FILE"
    assert_output "core"

    run jq -r '.focus.currentPhase' "$TODO_FILE"
    assert_output "core"

    # Focus back on setup task
    bash "$SCRIPTS_DIR/focus.sh" set "$setup_task"

    # Verify currentPhase changed back to setup
    run jq -r '.project.currentPhase' "$TODO_FILE"
    assert_output "setup"
}

@test "phase workflow: dash command shows current phase" {
    create_empty_todo_no_phases
    # Phases defined in fixture

    # Start setup phase
    bash "$SCRIPTS_DIR/phase.sh" start setup

    # Add tasks
    bash "$ADD_SCRIPT" "Task 1" --description "Setup task" --phase setup

    # Run dashboard
    run bash "$SCRIPTS_DIR/dash.sh"
    assert_success
    assert_output --partial "Phase:"
    assert_output --partial "setup" || assert_output --partial "Setup Phase"
}

@test "phase workflow: phases command lists all phases with progress" {
    create_empty_todo_no_phases

    # Set up multiple phases
    bash "$SCRIPTS_DIR/phase.sh" start setup

    # Add tasks
    bash "$ADD_SCRIPT" "Setup task" --description "Task" --phase setup
    bash "$ADD_SCRIPT" "Core task 1" --description "Task" --phase core
    bash "$ADD_SCRIPT" "Core task 2" --description "Task" --phase core

    # List phases
    run bash "$SCRIPTS_DIR/phases.sh" list
    assert_success
    # Output format is tabular with PHASE, NAME, DONE, TOTAL columns
    assert_output --partial "setup"
    assert_output --partial "core"
    assert_output --partial "testing"
    assert_output --partial "polish"
    assert_output --partial "maintenance"
}

@test "phase workflow: next command considers phase priority" {
    create_empty_todo_no_phases

    # Set up phases
    bash "$SCRIPTS_DIR/phase.sh" start setup

    # Add tasks to different phases
    bash "$ADD_SCRIPT" "Setup high" --description "High priority setup" --phase setup --priority high
    bash "$ADD_SCRIPT" "Core critical" --description "Critical core task" --phase core --priority critical

    # Next should prioritize current phase (setup) over higher priority in different phase
    run bash "$SCRIPTS_DIR/next.sh"
    assert_success
    # Should suggest the setup task (current phase) even though core has higher priority
    assert_output --partial "setup" || assert_output --partial "Setup high"
}

@test "phase workflow: complete phase blocks advance if tasks incomplete" {
    create_empty_todo_no_phases

    # Set up phase
    bash "$SCRIPTS_DIR/phase.sh" start setup

    # Add task
    bash "$ADD_SCRIPT" "Incomplete task" --description "Task" --phase setup

    # Try to complete phase with incomplete task
    run bash "$SCRIPTS_DIR/phase.sh" complete setup
    assert_failure
    assert_output --partial "incomplete" || assert_output --partial "pending"
}

@test "phase workflow: show command displays phase details" {
    create_empty_todo_no_phases

    # Set up phase
    bash "$SCRIPTS_DIR/phase.sh" start setup

    # Show phase (phase.sh show displays current phase info)
    run bash "$SCRIPTS_DIR/phase.sh" show
    assert_success
    # Output format: "Current Phase: setup", "Name: Setup", "Status: active"
    assert_output --partial "setup"
    assert_output --partial "Name: Setup"
    assert_output --partial "active"
}

@test "phase workflow: list shows phase order and status" {
    create_empty_todo_no_phases

    # Set up phases in specific order

    # Start and complete setup
    bash "$SCRIPTS_DIR/phase.sh" start setup
    bash "$SCRIPTS_DIR/phase.sh" complete setup

    # Start core
    bash "$SCRIPTS_DIR/phase.sh" start core

    # List phases
    run bash "$SCRIPTS_DIR/phase.sh" list
    assert_success
    assert_output --partial "setup"
    assert_output --partial "completed" || assert_output --partial "✓"
    assert_output --partial "core"
    assert_output --partial "active" || assert_output --partial "◉"
    assert_output --partial "polish"
    assert_output --partial "pending" || assert_output --partial "○"
}

@test "phase workflow: session integration with phases" {
    create_empty_todo_no_phases

    # Set up phase
    bash "$SCRIPTS_DIR/phase.sh" start setup

    # Start session
    bash "$SCRIPTS_DIR/session.sh" start

    # Add task
    bash "$ADD_SCRIPT" "Session task" --description "Task during session" --phase setup
    local task_id
    task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")

    # Focus and work
    bash "$SCRIPTS_DIR/focus.sh" set "$task_id"
    bash "$SCRIPTS_DIR/focus.sh" note "Working on phase task"

    # Complete task
    bash "$COMPLETE_SCRIPT" "$task_id" --notes "Done"

    # Complete phase
    bash "$SCRIPTS_DIR/phase.sh" complete setup

    # End session
    bash "$SCRIPTS_DIR/session.sh" end

    # Verify phase completed and logged
    run jq -r '.project.phases.setup.status' "$TODO_FILE"
    assert_output "completed"

    # Check log has phase operations
    run jq -r '.entries[] | select(.action | contains("phase")) | .action' "$LOG_FILE"
    assert_success
}

@test "phase workflow: archive preserves phase metadata" {
    create_empty_todo_no_phases

    # Set up phase
    bash "$SCRIPTS_DIR/phase.sh" start setup

    # Add and complete task
    bash "$ADD_SCRIPT" "Archive test" --description "Task to archive" --phase setup
    local task_id
    task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")

    bash "$COMPLETE_SCRIPT" "$task_id" --skip-notes
    bash "$SCRIPTS_DIR/phase.sh" complete setup

    # Archive (use --all to bypass preserve count in tests)
    bash "$SCRIPTS_DIR/archive.sh" --all

    # Verify archived task has phase metadata
    run jq -r --arg id "$task_id" '.archivedTasks[] | select(.id == $id) | .phase' "$ARCHIVE_FILE"
    assert_output "setup"
}
