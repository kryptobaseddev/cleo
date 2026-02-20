#!/usr/bin/env bats
# =============================================================================
# analyze-epic-scoped.bats - Test suite for epic-scoped analyze command
# =============================================================================
# Tests the --parent flag functionality for analyzing epics and their children.
# Verifies: phase grouping, wave computation, inventory, execution plan, human output.
# =============================================================================

# =============================================================================
# File-Level Setup
# =============================================================================
setup_file() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    common_setup_file
    export ANALYZE_SCRIPT="${SCRIPTS_DIR}/analyze.sh"
}

setup() {
    load '../test_helper/common_setup'
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
# Fixture: Epic with multi-phase children
# =============================================================================
# E001 (epic)
#   ├── T001 [setup, done] (no deps)
#   ├── T002 [setup, done] (deps: T001)
#   ├── T003 [core, pending] (deps: T002) - ready
#   ├── T004 [core, pending] (deps: T003) - blocked
#   ├── T005 [testing, pending] (deps: T004) - blocked
#   └── T006 [polish, pending] (deps: T005) - blocked
create_epic_fixture() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "completed"},
      "core": {"order": 2, "name": "Core", "status": "active"},
      "testing": {"order": 3, "name": "Testing", "status": "pending"},
      "polish": {"order": 4, "name": "Polish", "status": "pending"}
    }
  },
  "_meta": {"version": "2.2.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "E001", "title": "Epic: Feature Implementation", "description": "Epic task", "status": "pending", "priority": "high", "type": "epic", "phase": "core", "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T001", "title": "Setup foundation", "description": "First setup task", "status": "done", "priority": "high", "type": "task", "phase": "setup", "parentId": "E001", "createdAt": "2025-12-01T10:00:00Z", "completedAt": "2025-12-01T11:00:00Z"},
    {"id": "T002", "title": "Configure system", "description": "Second setup task", "status": "done", "priority": "high", "type": "task", "phase": "setup", "parentId": "E001", "depends": ["T001"], "createdAt": "2025-12-01T11:00:00Z", "completedAt": "2025-12-01T12:00:00Z"},
    {"id": "T003", "title": "Implement core feature", "description": "Core implementation", "status": "pending", "priority": "high", "type": "task", "phase": "core", "parentId": "E001", "depends": ["T002"], "createdAt": "2025-12-01T12:00:00Z"},
    {"id": "T004", "title": "Add feature extension", "description": "Core extension", "status": "pending", "priority": "medium", "type": "task", "phase": "core", "parentId": "E001", "depends": ["T003"], "createdAt": "2025-12-01T13:00:00Z"},
    {"id": "T005", "title": "Write tests", "description": "Testing phase", "status": "pending", "priority": "medium", "type": "task", "phase": "testing", "parentId": "E001", "depends": ["T004"], "createdAt": "2025-12-01T14:00:00Z"},
    {"id": "T006", "title": "Update documentation", "description": "Polish phase", "status": "pending", "priority": "low", "type": "task", "phase": "polish", "parentId": "E001", "depends": ["T005"], "createdAt": "2025-12-01T15:00:00Z"}
  ],
  "focus": {},
  "labels": {},
  "lastUpdated": "2025-12-01T15:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# =============================================================================
# Basic --parent Flag Tests
# =============================================================================

@test "analyze --parent returns success with valid epic ID" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001
    assert_success
}

@test "analyze --parent returns error with invalid task ID" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent INVALID
    assert_failure
    assert_output --partial "not found"
}

@test "analyze --parent produces valid JSON output" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001
    assert_success

    # Validate JSON structure
    echo "$output" | jq -e '.epic' > /dev/null
    echo "$output" | jq -e '.phases' > /dev/null
    echo "$output" | jq -e '.inventory' > /dev/null
    echo "$output" | jq -e '.executionPlan' > /dev/null
}

# =============================================================================
# Epic Metadata Tests
# =============================================================================

@test "analyze --parent shows correct epic info" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001
    assert_success

    # Extract epic info
    local epic_id epic_title epic_type
    epic_id=$(echo "$output" | jq -r '.epic.id')
    epic_title=$(echo "$output" | jq -r '.epic.title')
    epic_type=$(echo "$output" | jq -r '.epic.type')

    assert_equal "$epic_id" "E001"
    assert_equal "$epic_title" "Epic: Feature Implementation"
    assert_equal "$epic_type" "epic"
}

@test "analyze --parent calculates correct progress" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001
    assert_success

    # Check progress: 2 done out of 6 children = 33%
    local done total percent
    done=$(echo "$output" | jq '.epic.progress.done')
    total=$(echo "$output" | jq '.epic.progress.total')
    percent=$(echo "$output" | jq '.epic.progress.percent')

    assert_equal "$done" "2"
    assert_equal "$total" "6"
    assert_equal "$percent" "33"
}

# =============================================================================
# Phase Grouping Tests
# =============================================================================

@test "analyze --parent groups tasks by phase" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001
    assert_success

    # Check we have 4 phases
    local phase_count
    phase_count=$(echo "$output" | jq '.phases | length')
    assert_equal "$phase_count" "4"

    # Check phase order
    local first_phase second_phase
    first_phase=$(echo "$output" | jq -r '.phases[0].phase')
    second_phase=$(echo "$output" | jq -r '.phases[1].phase')
    assert_equal "$first_phase" "setup"
    assert_equal "$second_phase" "core"
}

@test "analyze --parent calculates phase progress correctly" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001
    assert_success

    # Setup phase should be complete (2/2)
    local setup_done setup_total setup_status
    setup_done=$(echo "$output" | jq '.phases[0].progress.done')
    setup_total=$(echo "$output" | jq '.phases[0].progress.total')
    setup_status=$(echo "$output" | jq -r '.phases[0].status')

    assert_equal "$setup_done" "2"
    assert_equal "$setup_total" "2"
    assert_equal "$setup_status" "complete"

    # Core phase should be pending (0/2)
    local core_done core_total core_status
    core_done=$(echo "$output" | jq '.phases[1].progress.done')
    core_total=$(echo "$output" | jq '.phases[1].progress.total')
    core_status=$(echo "$output" | jq -r '.phases[1].status')

    assert_equal "$core_done" "0"
    assert_equal "$core_total" "2"
    assert_equal "$core_status" "pending"
}

# =============================================================================
# Inventory Tests
# =============================================================================

@test "analyze --parent categorizes ready tasks correctly" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001
    assert_success

    # T003 should be ready (T002 is done)
    local ready_count ready_id
    ready_count=$(echo "$output" | jq '.inventory.ready | length')
    assert [ "$ready_count" -ge 1 ]

    ready_id=$(echo "$output" | jq -r '.inventory.ready[0].id')
    assert_equal "$ready_id" "T003"
}

@test "analyze --parent categorizes blocked tasks correctly" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001
    assert_success

    # T004, T005, T006 should be blocked
    local blocked_count
    blocked_count=$(echo "$output" | jq '.inventory.blocked | length')
    assert_equal "$blocked_count" "3"

    # T004 should be waiting on T003
    local t004_waiting
    t004_waiting=$(echo "$output" | jq -r '.inventory.blocked[] | select(.id == "T004") | .waitingOn[0]')
    assert_equal "$t004_waiting" "T003"
}

@test "analyze --parent categorizes completed tasks correctly" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001
    assert_success

    # T001, T002 should be completed
    local completed_count
    completed_count=$(echo "$output" | jq '.inventory.completed | length')
    assert_equal "$completed_count" "2"
}

# =============================================================================
# Execution Plan Tests
# =============================================================================

@test "analyze --parent generates execution waves" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001
    assert_success

    # Should have at least one wave
    local wave_count
    wave_count=$(echo "$output" | jq '.executionPlan.waves | length')
    assert [ "$wave_count" -ge 1 ]

    # First wave should include ready tasks
    local wave1_tasks
    wave1_tasks=$(echo "$output" | jq -r '.executionPlan.waves[0].parallel | join(",")')
    assert_output --partial "T003"
}

@test "analyze --parent provides recommendation" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001
    assert_success

    # Should recommend a next task
    local next_task
    next_task=$(echo "$output" | jq -r '.executionPlan.recommendation.nextTask')
    assert [ -n "$next_task" ]
    assert [ "$next_task" != "null" ]
}

# =============================================================================
# Human Output Tests
# =============================================================================

@test "analyze --parent --human produces readable output" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001 --human
    assert_success

    # Check for expected sections
    assert_output --partial "EPIC ANALYSIS"
    assert_output --partial "PHASES"
    assert_output --partial "READY TO START"
}

@test "analyze --parent --human shows phase progress" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001 --human
    assert_success

    # Should show setup as complete (uppercase in new format)
    assert_output --partial "SETUP"
    assert_output --partial "2/2"
}

@test "analyze --parent --human shows recommendation" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001 --human
    assert_success

    assert_output --partial "RECOMMENDATION"
    assert_output --partial "ct focus set"
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "analyze --parent with epic having no children" {
    # Create epic with no children
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.2.0",
  "project": {"name": "test", "currentPhase": "core", "phases": {}},
  "_meta": {"version": "2.2.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "E001", "title": "Empty Epic", "description": "Epic with no children", "status": "pending", "priority": "high", "type": "epic", "phase": "core", "createdAt": "2025-12-01T10:00:00Z"}
  ],
  "focus": {},
  "labels": {},
  "lastUpdated": "2025-12-01T10:00:00Z"
}
EOF
    _update_fixture_checksum "$TODO_FILE"

    run bash "$ANALYZE_SCRIPT" --parent E001
    assert_success

    # Progress should be 0/0
    local total
    total=$(echo "$output" | jq '.epic.progress.total')
    assert_equal "$total" "0"
}

@test "analyze --parent with regular task (not epic type)" {
    create_epic_fixture "$TODO_FILE"
    # T001 is a regular task, not epic type - should still work
    run bash "$ANALYZE_SCRIPT" --parent T001
    assert_success
}

# =============================================================================
# Chain Visualization Tests (T1036)
# =============================================================================
# Chains are COMPUTED at render time (not stored) and shown in --human output.
# Tests verify: critical path display, entry points, computed note.

@test "analyze --parent --human shows DEPENDENCY CHAINS section" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001 --human
    assert_success

    # Should show the chains section header
    assert_output --partial "DEPENDENCY CHAINS"
    assert_output --partial "computed from depends"
}

@test "analyze --parent --human shows dependency chains" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001 --human
    assert_success

    # Should show CHAIN A with task info (new format shows chains by root)
    assert_output --partial "CHAIN A"
    # New format shows task count
    assert_output --partial "tasks)"
}

@test "analyze --parent --human shows ready task in chain" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001 --human
    assert_success

    # T003 should be listed in a chain since it's a pending task
    assert_output --partial "T003"
}

@test "analyze --parent --human displays chain computation note" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001 --human
    assert_success

    # Should include the design note about chains being computed
    assert_output --partial "Chains computed at render time"
    assert_output --partial "depends[]"
}

@test "analyze --parent JSON output has NO dependencyChains field" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001
    assert_success

    # JSON output should NOT contain dependencyChains (per consensus decision)
    local has_chains
    has_chains=$(echo "$output" | jq 'has("dependencyChains")')
    assert_equal "$has_chains" "false"

    # But should have executionPlan with criticalPath
    local has_critical
    has_critical=$(echo "$output" | jq '.executionPlan | has("criticalPath")')
    assert_equal "$has_critical" "true"
}

@test "analyze --parent --human shows chain arrows for dependency flow" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001 --human
    assert_success

    # Should show arrows between tasks in chains (linear or tree format)
    # The fixture has T001→T002→T003→T004→T005→T006 chain
    # Expect to see arrow notation in output
    assert_output --partial "→"
}

@test "analyze --parent --human shows status icons in chains" {
    create_epic_fixture "$TODO_FILE"
    run bash "$ANALYZE_SCRIPT" --parent E001 --human
    assert_success

    # Should show status icons: ✅ for done, ⏳ for pending
    # T001, T002 are done; T003-T006 are pending
    assert_output --partial "✅"
    assert_output --partial "⏳"
}
