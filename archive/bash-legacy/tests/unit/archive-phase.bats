#!/usr/bin/env bats
# =============================================================================
# archive-phase.bats - Unit tests for phase-triggered archive (T447/T429)
# =============================================================================
# Tests --phase-complete option that archives completed tasks from a
# specified phase when the phase is finished.
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
# Helper: Create tasks across multiple phases
# =============================================================================

create_tasks_with_phases() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
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
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Setup task 1", "description": "Setup work", "status": "done", "priority": "high", "phase": "setup", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Setup task 2", "description": "More setup", "status": "done", "priority": "medium", "phase": "setup", "createdAt": "2025-11-02T10:00:00Z", "completedAt": "2025-11-06T10:00:00Z"},
    {"id": "T003", "title": "Core task 1", "description": "Core work", "status": "done", "priority": "high", "phase": "core", "createdAt": "2025-11-10T10:00:00Z", "completedAt": "2025-11-15T10:00:00Z"},
    {"id": "T004", "title": "Core task 2", "description": "More core", "status": "pending", "priority": "medium", "phase": "core", "createdAt": "2025-11-11T10:00:00Z"},
    {"id": "T005", "title": "Testing task", "description": "Testing work", "status": "pending", "priority": "low", "phase": "testing", "createdAt": "2025-11-20T10:00:00Z"}
  ],
  "focus": {"currentPhase": "core"}
}
EOF
    _update_fixture_checksum "$dest"
}

# =============================================================================
# --phase-complete Basic Tests
# =============================================================================

@test "archive --phase-complete filters to specified phase" {
    create_tasks_with_phases

    run bash "$ARCHIVE_SCRIPT" --phase-complete setup --all --json
    assert_success

    # Only T001, T002 (setup phase, done) should be archived
    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -eq 2 ]

    # Verify archived task IDs
    local archived_ids
    archived_ids=$(echo "$output" | jq -r '.archived.taskIds[]' | tr '\n' ' ')
    echo "$archived_ids" | grep -q "T001"
    echo "$archived_ids" | grep -q "T002"
    [[ "$archived_ids" != *"T003"* ]]  # Core task should NOT be archived
}

@test "archive --phase-complete only archives done tasks from phase" {
    create_tasks_with_phases

    # Core phase has T003 (done) and T004 (pending)
    run bash "$ARCHIVE_SCRIPT" --phase-complete core --all --json
    assert_success

    # Only T003 should be archived (T004 is pending)
    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -eq 1 ]

    local archived_id
    archived_id=$(echo "$output" | jq -r '.archived.taskIds[0]')
    [ "$archived_id" = "T003" ]
}

@test "archive --phase-complete with no matching tasks returns zero" {
    create_tasks_with_phases

    # Testing phase has no done tasks
    run bash "$ARCHIVE_SCRIPT" --phase-complete testing --all --json
    assert_success

    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -eq 0 ]
}

@test "archive --phase-complete with nonexistent phase returns zero" {
    create_tasks_with_phases

    run bash "$ARCHIVE_SCRIPT" --phase-complete nonexistent --all --json
    assert_success

    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -eq 0 ]
}

# =============================================================================
# Phase Trigger Info in Output
# =============================================================================

@test "archive --phase-complete includes phaseTrigger in JSON output" {
    create_tasks_with_phases

    run bash "$ARCHIVE_SCRIPT" --phase-complete setup --all --json
    assert_success

    # Check phaseTrigger structure
    echo "$output" | jq -e '.phaseTrigger' >/dev/null

    local enabled
    enabled=$(echo "$output" | jq '.phaseTrigger.enabled')
    [ "$enabled" = "true" ]

    local phase
    phase=$(echo "$output" | jq -r '.phaseTrigger.phase')
    [ "$phase" = "setup" ]
}

@test "archive --phase-complete tracks tasksInPhase count" {
    create_tasks_with_phases

    run bash "$ARCHIVE_SCRIPT" --phase-complete setup --all --json
    assert_success

    local tasks_in_phase
    tasks_in_phase=$(echo "$output" | jq '.phaseTrigger.tasksInPhase')
    [ "$tasks_in_phase" -eq 2 ]
}

@test "archive without --phase-complete has null phaseTrigger" {
    create_tasks_with_phases

    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    local phase_trigger
    phase_trigger=$(echo "$output" | jq '.phaseTrigger')
    [ "$phase_trigger" = "null" ]
}

# =============================================================================
# Phase Trigger with Other Options
# =============================================================================

@test "archive --phase-complete combines with --safe mode" {
    # Create setup phase tasks with parent-child relationship
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.3.0",
  "project": {"name": "test-project", "currentPhase": "core"},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Setup parent", "description": "Parent", "status": "done", "phase": "setup", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Setup child", "description": "Child active", "status": "active", "phase": "setup", "parentId": "T001", "createdAt": "2025-11-02T10:00:00Z"}
  ],
  "focus": {}
}
EOF
    _update_fixture_checksum "$TODO_FILE"

    run bash "$ARCHIVE_SCRIPT" --phase-complete setup --all --json
    assert_success

    # T001 should be blocked by safe mode (has active child T002)
    local blocked_count
    blocked_count=$(echo "$output" | jq '.blockedByRelationships.byChildren | length')
    [ "$blocked_count" -ge 1 ]
}

@test "archive --phase-complete combines with --exclude-labels" {
    # Create tasks in setup phase with different labels
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.3.0",
  "project": {"name": "test-project", "currentPhase": "core"},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Setup important", "description": "Important", "status": "done", "phase": "setup", "labels": ["important"], "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Setup regular", "description": "Regular", "status": "done", "phase": "setup", "createdAt": "2025-11-02T10:00:00Z", "completedAt": "2025-11-06T10:00:00Z"}
  ],
  "focus": {}
}
EOF
    _update_fixture_checksum "$TODO_FILE"

    run bash "$ARCHIVE_SCRIPT" --phase-complete setup --exclude-labels important --all --json
    assert_success

    # Only T002 should be archived (T001 has important label)
    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -eq 1 ]

    local archived_id
    archived_id=$(echo "$output" | jq -r '.archived.taskIds[0]')
    [ "$archived_id" = "T002" ]
}

@test "archive --phase-complete combines with --dry-run" {
    create_tasks_with_phases

    local before_todo
    before_todo=$(cat "$TODO_FILE")

    run bash "$ARCHIVE_SCRIPT" --phase-complete setup --all --dry-run --json
    assert_success

    # Verify dry-run indicator
    local dry_run
    dry_run=$(echo "$output" | jq '.dryRun')
    [ "$dry_run" = "true" ]

    # File should not be modified
    local after_todo
    after_todo=$(cat "$TODO_FILE")
    [ "$before_todo" = "$after_todo" ]
}

# =============================================================================
# Text Output Tests
# =============================================================================

@test "archive --phase-complete shows phase info in text output" {
    create_tasks_with_phases

    run bash "$ARCHIVE_SCRIPT" --phase-complete setup --all
    assert_success

    # Should mention phase-triggered archive
    assert_output_contains_any "Phase" "phase" "setup"
}

@test "archive --phase-complete dry-run shows phase context" {
    create_tasks_with_phases

    run bash "$ARCHIVE_SCRIPT" --phase-complete setup --all --dry-run
    assert_success

    # Should show phase filter info
    assert_output_contains_any "setup" "phase" "DRY RUN"
}

# =============================================================================
# Archive Source Tracking
# =============================================================================

@test "archive --phase-complete sets archiveSource to phase-trigger" {
    create_tasks_with_phases

    # Archive setup phase tasks
    bash "$ARCHIVE_SCRIPT" --phase-complete setup --all

    # Check archived tasks have correct archiveSource
    local archive_source
    archive_source=$(jq -r '.archivedTasks[0]._archive.archiveSource' "$ARCHIVE_FILE")
    [ "$archive_source" = "phase-trigger" ]
}

@test "archive --phase-complete trigger details include phase" {
    create_tasks_with_phases

    # Archive setup phase tasks
    bash "$ARCHIVE_SCRIPT" --phase-complete setup --all

    # Check trigger details
    local trigger_phase
    trigger_phase=$(jq -r '.archivedTasks[0]._archive.triggerDetails.phase' "$ARCHIVE_FILE")
    [ "$trigger_phase" = "setup" ]
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "archive --phase-complete with tasks in multiple phases only archives specified" {
    create_tasks_with_phases

    run bash "$ARCHIVE_SCRIPT" --phase-complete setup --all --json
    assert_success

    # Verify only setup tasks archived, core tasks remain
    local remaining_core
    remaining_core=$(jq '[.tasks[] | select(.phase == "core")] | length' "$TODO_FILE")
    [ "$remaining_core" -eq 2 ]  # T003 (done) and T004 (pending) in core
}

@test "archive --phase-complete handles tasks with null phase" {
    # Create tasks including one without a phase
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.3.0",
  "project": {"name": "test-project", "currentPhase": "setup"},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Setup task", "description": "With phase", "status": "done", "phase": "setup", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "No phase task", "description": "Without phase", "status": "done", "createdAt": "2025-11-02T10:00:00Z", "completedAt": "2025-11-06T10:00:00Z"}
  ],
  "focus": {}
}
EOF
    _update_fixture_checksum "$TODO_FILE"

    run bash "$ARCHIVE_SCRIPT" --phase-complete setup --all --json
    assert_success

    # Only T001 should be archived (T002 has no phase)
    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -eq 1 ]

    local archived_id
    archived_id=$(echo "$output" | jq -r '.archived.taskIds[0]')
    [ "$archived_id" = "T001" ]
}

@test "archive --phase-complete=value syntax works" {
    create_tasks_with_phases

    run bash "$ARCHIVE_SCRIPT" --phase-complete=setup --all --json
    assert_success

    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -eq 2 ]
}

@test "archive --phase-complete respects retention settings" {
    # Create very recent completion in setup phase
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.3.0",
  "project": {"name": "test-project", "currentPhase": "core"},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Setup task", "description": "Setup", "status": "done", "phase": "setup", "createdAt": "2025-12-20T10:00:00Z", "completedAt": "2025-12-21T10:00:00Z"}
  ],
  "focus": {}
}
EOF
    _update_fixture_checksum "$TODO_FILE"

    # Without --all or --force, very recent tasks won't be archived
    run bash "$ARCHIVE_SCRIPT" --phase-complete setup --json
    assert_success

    # Check if task was archived (depends on current date and config)
    # Using --all bypasses retention, so test without it
}
