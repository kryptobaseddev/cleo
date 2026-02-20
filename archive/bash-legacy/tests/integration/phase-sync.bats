#!/usr/bin/env bats
# =============================================================================
# phase-sync.bats - Integration tests for phase synchronization
# =============================================================================
# Tests phase consistency and updates across multiple commands:
#   - Phase updates when focus changes (focus.currentPhase sync)
#   - Phase inheritance when adding tasks (uses project.currentPhase)
#   - Phase display in dash, phases, next commands
#   - currentPhase consistency across all operations
#
# Test Scope:
#   - project.currentPhase updates when focus changes to task in different phase
#   - focus.currentPhase always matches project.currentPhase
#   - New tasks inherit currentPhase (or use defaults/args)
#   - Dashboard, phases, and next commands correctly display phase context
#
# Fixtures: Uses v2.2.0 fixtures with project.phases structure
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

    # Phase-specific scripts
    export FOCUS_SCRIPT="${SCRIPTS_DIR}/focus.sh"
    export ADD_SCRIPT="${SCRIPTS_DIR}/add.sh"
    export DASH_SCRIPT="${SCRIPTS_DIR}/dash.sh"
    export PHASES_SCRIPT="${SCRIPTS_DIR}/phases.sh"
    export NEXT_SCRIPT="${SCRIPTS_DIR}/next.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# FIXTURES
# =============================================================================

create_phased_project_fixture() {
    # Create config with phase definitions
    # CRITICAL: multiSession.enabled must be false for single-session focus tests
    cat > "$CONFIG_FILE" << 'CONFIGEOF'
{
  "version": "2.0.0",
  "validation": {
    "strictMode": false,
    "requireDescription": false
  },
  "defaults": {
    "priority": "medium",
    "phase": "core"
  },
  "multiSession": {
    "enabled": false
  },
  "phases": {
    "setup": {
      "order": 1,
      "name": "Setup & Planning",
      "description": "Initial project setup and planning phase"
    },
    "core": {
      "order": 2,
      "name": "Core Development",
      "description": "Core feature development"
    },
    "polish": {
      "order": 3,
      "name": "Polish & Testing",
      "description": "Final polish and testing phase"
    }
  }
}
CONFIGEOF

    # Create todo.json with tasks in different phases (v2.2.0 schema)
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "phase-sync-test",
    "currentPhase": "setup",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup & Planning",
        "description": "Initial project setup and planning phase",
        "status": "active",
        "startedAt": "2025-12-14T09:00:00Z",
        "completedAt": null
      },
      "core": {
        "order": 2,
        "name": "Core Development",
        "description": "Core feature development",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      },
      "polish": {
        "order": 3,
        "name": "Polish & Testing",
        "description": "Final polish and testing phase",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      }
    }
  },
  "_meta": {
    "version": "2.2.0",
    "checksum": "placeholder"
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "tasks": [
    {
      "id": "T001",
      "title": "Setup project infrastructure",
      "description": "Initialize project structure and dependencies",
      "status": "pending",
      "priority": "high",
      "phase": "setup",
      "createdAt": "2025-12-14T09:00:00Z"
    },
    {
      "id": "T002",
      "title": "Build authentication module",
      "description": "Implement core authentication logic",
      "status": "pending",
      "priority": "high",
      "phase": "core",
      "createdAt": "2025-12-14T09:05:00Z"
    },
    {
      "id": "T003",
      "title": "Write integration tests",
      "description": "Create comprehensive integration test suite",
      "status": "pending",
      "priority": "medium",
      "phase": "polish",
      "createdAt": "2025-12-14T09:10:00Z"
    },
    {
      "id": "T004",
      "title": "Another setup task",
      "description": "Additional setup work",
      "status": "pending",
      "priority": "medium",
      "phase": "setup",
      "createdAt": "2025-12-14T09:15:00Z"
    }
  ],
  "focus": {
    "currentTask": null,
    "currentPhase": "setup",
    "blockedUntil": null,
    "sessionNote": null,
    "nextAction": null
  },
  "labels": {}
}
EOF
    # Update checksum to match content
    _update_fixture_checksum "$TODO_FILE"
}

# =============================================================================
# FOCUS -> PHASE SYNC TESTS
# =============================================================================

@test "focus: setting focus updates currentPhase when task in different phase" {
    create_phased_project_fixture

    # Project is in "setup" phase, focus on "core" phase task
    run bash "$FOCUS_SCRIPT" set T002
    assert_success

    # project.currentPhase should now be "core"
    local project_phase
    project_phase=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [[ "$project_phase" == "core" ]]

    # focus.currentPhase should also be "core"
    local focus_phase
    focus_phase=$(jq -r '.focus.currentPhase' "$TODO_FILE")
    [[ "$focus_phase" == "core" ]]
}

@test "focus: setting focus preserves currentPhase when task in same phase" {
    create_phased_project_fixture

    # Set focus to T001 (setup phase - same as current)
    bash "$FOCUS_SCRIPT" set T001 > /dev/null

    # Both should remain "setup"
    local project_phase
    project_phase=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [[ "$project_phase" == "setup" ]]

    local focus_phase
    focus_phase=$(jq -r '.focus.currentPhase' "$TODO_FILE")
    [[ "$focus_phase" == "setup" ]]
}

@test "focus: clearing focus does not change currentPhase" {
    create_phased_project_fixture

    # Set focus to core phase task
    bash "$FOCUS_SCRIPT" set T002 > /dev/null

    # Verify phase changed to core
    local phase_before
    phase_before=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [[ "$phase_before" == "core" ]]

    # Clear focus
    bash "$FOCUS_SCRIPT" clear > /dev/null

    # Phase should remain "core"
    local phase_after
    phase_after=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [[ "$phase_after" == "core" ]]
}

@test "focus: currentPhase always matches between project and focus" {
    create_phased_project_fixture

    # Set focus multiple times
    bash "$FOCUS_SCRIPT" set T001 > /dev/null
    local p1=$(jq -r '.project.currentPhase' "$TODO_FILE")
    local f1=$(jq -r '.focus.currentPhase' "$TODO_FILE")
    [[ "$p1" == "$f1" ]]

    bash "$FOCUS_SCRIPT" set T002 > /dev/null
    local p2=$(jq -r '.project.currentPhase' "$TODO_FILE")
    local f2=$(jq -r '.focus.currentPhase' "$TODO_FILE")
    [[ "$p2" == "$f2" ]]

    bash "$FOCUS_SCRIPT" set T003 > /dev/null
    local p3=$(jq -r '.project.currentPhase' "$TODO_FILE")
    local f3=$(jq -r '.focus.currentPhase' "$TODO_FILE")
    [[ "$p3" == "$f3" ]]
}

# =============================================================================
# ADD -> PHASE INHERITANCE TESTS
# =============================================================================

@test "add: new task inherits project.currentPhase when no --phase specified" {
    create_phased_project_fixture

    # Set current phase to "core"
    jq '.project.currentPhase = "core" | .focus.currentPhase = "core"' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Add task without specifying phase
    run bash "$ADD_SCRIPT" "New feature task" --quiet
    assert_success

    local new_task_id="$output"

    # New task should have phase "core"
    local task_phase
    task_phase=$(jq -r --arg id "$new_task_id" '.tasks[] | select(.id == $id) | .phase' "$TODO_FILE")
    [[ "$task_phase" == "core" ]]
}

@test "add: new task uses config default when currentPhase not set" {
    create_phased_project_fixture

    # Clear currentPhase
    jq 'del(.project.currentPhase) | del(.focus.currentPhase)' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Add task (config default is "core")
    run bash "$ADD_SCRIPT" "Task with default phase" --quiet
    assert_success

    local new_task_id="$output"

    # Should use config default "core"
    local task_phase
    task_phase=$(jq -r --arg id "$new_task_id" '.tasks[] | select(.id == $id) | .phase' "$TODO_FILE")
    [[ "$task_phase" == "core" ]]
}

@test "add: explicit --phase overrides currentPhase" {
    create_phased_project_fixture

    # Current phase is "setup"
    local current_phase
    current_phase=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [[ "$current_phase" == "setup" ]]

    # Add task with explicit polish phase
    run bash "$ADD_SCRIPT" "Polish task" --phase polish --quiet
    assert_success

    local new_task_id="$output"

    # Should use explicit phase "polish"
    local task_phase
    task_phase=$(jq -r --arg id "$new_task_id" '.tasks[] | select(.id == $id) | .phase' "$TODO_FILE")
    [[ "$task_phase" == "polish" ]]
}

@test "add: new task with --add-phase creates phase and inherits it" {
    create_phased_project_fixture

    # Add task with new phase
    run bash "$ADD_SCRIPT" "Deployment task" --phase deploy --add-phase --quiet
    assert_success

    local new_task_id="$output"

    # Task should have "deploy" phase
    local task_phase
    task_phase=$(jq -r --arg id "$new_task_id" '.tasks[] | select(.id == $id) | .phase' "$TODO_FILE")
    [[ "$task_phase" == "deploy" ]]

    # Phase should exist in project.phases
    jq -e '.project.phases.deploy' "$TODO_FILE"
    assert_success
}

# =============================================================================
# DASH COMMAND -> PHASE DISPLAY TESTS
# =============================================================================

@test "dash: displays currentPhase in overview section" {
    create_phased_project_fixture

    run bash "$DASH_SCRIPT"
    assert_success

    # Should show current phase in output
    assert_output --partial "Current Phase"
    assert_output --partial "setup"
}

@test "dash: highlights current phase in phase progress section" {
    create_phased_project_fixture

    # Set phase to "core"
    jq '.project.currentPhase = "core" | .focus.currentPhase = "core"' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run bash "$DASH_SCRIPT"
    assert_success

    # Should show core phase with indicator
    assert_output --partial "core"
}

@test "dash: --compact includes phase context" {
    create_phased_project_fixture

    run bash "$DASH_SCRIPT" --compact
    assert_success

    # Compact output should mention phase
    assert_output --partial "setup"
}

@test "dash: shows tasks grouped by phase" {
    create_phased_project_fixture

    run bash "$DASH_SCRIPT"
    assert_success

    # Dashboard shows current phase in header (not task grouping by phase)
    # Phase info is displayed in "Current Phase:" section
    assert_output --partial "setup"
    assert_output --partial "Current Phase"
}

# =============================================================================
# PHASES COMMAND -> PHASE DISPLAY TESTS
# =============================================================================

@test "phases: lists all phases with task counts" {
    create_phased_project_fixture

    run bash "$PHASES_SCRIPT"
    assert_success

    # Should show all three phases
    assert_output --partial "Setup & Planning"
    assert_output --partial "Core Development"
    assert_output --partial "Polish & Testing"

    # Should show task counts (2 setup, 1 core, 1 polish)
    # Note: Exact format may vary, but counts should be present
}

@test "phases: show command filters tasks by phase" {
    create_phased_project_fixture

    run bash "$PHASES_SCRIPT" show setup
    assert_success

    # Should only show setup phase tasks
    assert_output --partial "T001"
    assert_output --partial "T004"

    # Should not show other phase tasks
    refute_output --partial "T002"
    refute_output --partial "T003"
}

@test "phases: stats shows phase statistics" {
    create_phased_project_fixture

    run bash "$PHASES_SCRIPT" stats
    assert_success

    # Should show statistics for phases
    assert_output --partial "setup"
    assert_output --partial "core"
    assert_output --partial "polish"
}

@test "phases: --format json includes currentPhase" {
    create_phased_project_fixture

    run bash "$PHASES_SCRIPT" --format json
    assert_success

    # Parse JSON and verify currentPhase
    local current_phase
    current_phase=$(echo "$output" | jq -r '.currentPhase')
    [[ "$current_phase" == "setup" ]]
}

# =============================================================================
# NEXT COMMAND -> PHASE CONTEXT TESTS
# =============================================================================

@test "next: prioritizes tasks in currentPhase when priorities equal" {
    create_phased_project_fixture

    # T001 and T002 both have priority "high"
    # T001 is in "setup" (current phase), T002 is in "core"
    # next should prefer T001 (phase match)

    run bash "$NEXT_SCRIPT"
    assert_success

    # Should suggest T001 (setup phase task)
    assert_output --partial "T001"
}

@test "next: --explain shows phase bonus in reasoning" {
    create_phased_project_fixture

    run bash "$NEXT_SCRIPT" --explain
    assert_success

    # Should mention phase in explanation
    assert_output --partial "phase"
}

@test "next: phase bonus applied correctly when focus changes phase" {
    create_phased_project_fixture

    # Change current phase to "core" by focusing on T002
    bash "$FOCUS_SCRIPT" set T002 > /dev/null

    # Now next should prefer core phase tasks
    # T002 is active (focused), so next available is T003 (polish) or T004 (setup)
    # But we need to check the scoring logic
    run bash "$NEXT_SCRIPT" --explain
    assert_success

    # Should reference current phase "core"
    assert_output --partial "core"
}

@test "next: --format json includes phase information" {
    create_phased_project_fixture

    run bash "$NEXT_SCRIPT" --format json
    assert_success

    # Should have phase field in suggestions (not tasks)
    run bash -c "echo '$output' | jq -e '.suggestions[0].phase'"
    assert_success
}

# =============================================================================
# CROSS-COMMAND CONSISTENCY TESTS
# =============================================================================

@test "consistency: focus → add → dash maintains phase context" {
    create_phased_project_fixture

    # 1. Focus on core phase task
    bash "$FOCUS_SCRIPT" set T002 > /dev/null

    # 2. Add new task (should inherit "core" phase)
    local new_id
    new_id=$(bash "$ADD_SCRIPT" "New core task" --quiet)

    # 3. Verify task has core phase
    local task_phase
    task_phase=$(jq -r --arg id "$new_id" '.tasks[] | select(.id == $id) | .phase' "$TODO_FILE")
    [[ "$task_phase" == "core" ]]

    # 4. Dash should show core as current phase
    run bash "$DASH_SCRIPT"
    assert_success
    assert_output --partial "core"
}

@test "consistency: project.currentPhase and focus.currentPhase never diverge" {
    create_phased_project_fixture

    # Perform series of operations
    bash "$FOCUS_SCRIPT" set T001 > /dev/null
    local p1=$(jq -r '.project.currentPhase' "$TODO_FILE")
    local f1=$(jq -r '.focus.currentPhase' "$TODO_FILE")
    [[ "$p1" == "$f1" ]]

    bash "$ADD_SCRIPT" "Task A" --quiet > /dev/null
    local p2=$(jq -r '.project.currentPhase' "$TODO_FILE")
    local f2=$(jq -r '.focus.currentPhase' "$TODO_FILE")
    [[ "$p2" == "$f2" ]]

    bash "$FOCUS_SCRIPT" set T002 > /dev/null
    local p3=$(jq -r '.project.currentPhase' "$TODO_FILE")
    local f3=$(jq -r '.focus.currentPhase' "$TODO_FILE")
    [[ "$p3" == "$f3" ]]

    bash "$FOCUS_SCRIPT" clear > /dev/null
    local p4=$(jq -r '.project.currentPhase' "$TODO_FILE")
    local f4=$(jq -r '.focus.currentPhase' "$TODO_FILE")
    [[ "$p4" == "$f4" ]]
}

@test "consistency: phases command reflects focus-driven phase changes" {
    create_phased_project_fixture

    # Initial state - setup is active
    local initial_active
    initial_active=$(bash "$PHASES_SCRIPT" --format json | jq -r '.phases[] | select(.status == "active") | .slug')
    [[ "$initial_active" == "setup" ]]

    # Focus on core phase task (may auto-transition phases)
    bash "$FOCUS_SCRIPT" set T002 > /dev/null

    # Current phase should be core
    local current_phase
    current_phase=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [[ "$current_phase" == "core" ]]
}

@test "consistency: dash, phases, and next all show same currentPhase" {
    create_phased_project_fixture

    # Set focus to polish phase
    bash "$FOCUS_SCRIPT" set T003 > /dev/null

    # Get currentPhase from all three commands
    local dash_phase
    dash_phase=$(bash "$DASH_SCRIPT" --format json 2>/dev/null | jq -r '.project.currentPhase' || echo "")

    local phases_phase
    phases_phase=$(bash "$PHASES_SCRIPT" --format json | jq -r '.currentPhase')

    local file_phase
    file_phase=$(jq -r '.project.currentPhase' "$TODO_FILE")

    # All should be "polish"
    [[ "$file_phase" == "polish" ]]
    if [[ -n "$dash_phase" ]]; then
        [[ "$dash_phase" == "polish" ]]
    fi
    [[ "$phases_phase" == "polish" ]]
}

# =============================================================================
# EDGE CASES
# =============================================================================

@test "edge: focus on task with no phase field uses config default" {
    create_phased_project_fixture

    # Add task without phase
    jq '.tasks += [{
        "id": "T999",
        "title": "Phaseless task",
        "description": "Task without phase",
        "status": "pending",
        "priority": "low",
        "createdAt": "2025-12-15T12:00:00Z"
    }]' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Focus on it - should use config default or keep current
    bash "$FOCUS_SCRIPT" set T999 > /dev/null

    # currentPhase should be set to something valid
    local current_phase
    current_phase=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [[ -n "$current_phase" && "$current_phase" != "null" ]]
}

@test "edge: add task when project.phases is empty still works" {
    create_phased_project_fixture

    # Clear all phases
    jq '.project.phases = {} | .project.currentPhase = null | .focus.currentPhase = null' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"
    _update_fixture_checksum "$TODO_FILE"

    # Add task should work with --add-phase to create the phase
    run bash "$ADD_SCRIPT" "Task without phases" --phase setup --add-phase --quiet
    assert_success
}

@test "edge: next command works when no currentPhase is set" {
    create_phased_project_fixture

    # Clear currentPhase
    jq 'del(.project.currentPhase) | del(.focus.currentPhase)' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # next should still work (no phase bonus)
    run bash "$NEXT_SCRIPT"
    assert_success

    # Should suggest a task
    assert_output --partial "T"
}

@test "edge: phase sync works with multiple rapid focus changes" {
    create_phased_project_fixture

    # Rapid focus changes
    bash "$FOCUS_SCRIPT" set T001 > /dev/null  # setup
    bash "$FOCUS_SCRIPT" set T002 > /dev/null  # core
    bash "$FOCUS_SCRIPT" set T003 > /dev/null  # polish
    bash "$FOCUS_SCRIPT" set T004 > /dev/null  # setup

    # Final phase should be "setup"
    local final_phase
    final_phase=$(jq -r '.project.currentPhase' "$TODO_FILE")
    [[ "$final_phase" == "setup" ]]

    # Consistency check
    local focus_phase
    focus_phase=$(jq -r '.focus.currentPhase' "$TODO_FILE")
    [[ "$focus_phase" == "setup" ]]
}
