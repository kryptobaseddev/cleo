#!/usr/bin/env bats
# =============================================================================
# analyze-staleness.bats - Integration tests for stale task detection in analyze
# =============================================================================
# Tests stale task output in the analyze command:
# - JSON output: staleTasks array, staleCount field
# - Human output: STALE TASKS warning section
# - Config interaction: enabled/disabled toggle, custom thresholds
# - Epic scoping: stale tasks filtered to epic scope
# =============================================================================

# Load test helpers using file-level setup pattern
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file

    # Pre-calculate date values for stale task fixtures
    export NOW_EPOCH=$(date +%s)
    export SECONDS_PER_DAY=86400

    # Calculate epochs for different staleness scenarios
    export RECENT_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 2))          # 2 days ago (fresh)
    export OLD_PENDING_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 35))    # 35 days ago (stale pending)
    export NO_UPDATE_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 16))      # 16 days ago (stale no_updates)
    export LONG_BLOCKED_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 10))   # 10 days ago (stale blocked)
    export URGENT_NEGLECTED_EPOCH=$((NOW_EPOCH - SECONDS_PER_DAY * 9)) # 9 days ago (stale urgent)
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    common_setup_per_test

    # Export scripts needed for tests
    export ANALYZE_SCRIPT="${SCRIPTS_DIR}/analyze.sh"

    # Create archive file
    create_empty_archive
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper Functions
# =============================================================================

# Convert epoch to ISO8601 format
_epoch_to_iso() {
    local epoch="$1"
    date -u -d "@$epoch" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
        date -u -r "$epoch" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null
}

# Create todo.json with stale tasks of various types
create_stale_tasks_fixture() {
    local dest="${1:-$TODO_FILE}"
    local recent_iso old_pending_iso no_update_iso blocked_iso urgent_iso

    recent_iso=$(_epoch_to_iso "$RECENT_EPOCH")
    old_pending_iso=$(_epoch_to_iso "$OLD_PENDING_EPOCH")
    no_update_iso=$(_epoch_to_iso "$NO_UPDATE_EPOCH")
    blocked_iso=$(_epoch_to_iso "$LONG_BLOCKED_EPOCH")
    urgent_iso=$(_epoch_to_iso "$URGENT_NEGLECTED_EPOCH")

    cat > "$dest" << EOF
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "completed"},
      "core": {"order": 2, "name": "Core", "status": "active"},
      "testing": {"order": 3, "name": "Testing", "status": "pending"},
      "polish": {"order": 4, "name": "Polish", "status": "pending"},
      "maintenance": {"order": 5, "name": "Maintenance", "status": "pending"}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Fresh task", "description": "Recent task", "status": "pending", "priority": "medium", "phase": "core", "createdAt": "${recent_iso}"},
    {"id": "T002", "title": "Old pending task", "description": "Created long ago", "status": "pending", "priority": "low", "phase": "core", "createdAt": "${old_pending_iso}"},
    {"id": "T003", "title": "No updates task", "description": "No recent activity", "status": "active", "priority": "medium", "phase": "core", "createdAt": "${no_update_iso}"},
    {"id": "T004", "title": "Long blocked task", "description": "Blocked too long", "status": "blocked", "priority": "medium", "phase": "core", "createdAt": "${blocked_iso}", "blockedBy": "External dependency"},
    {"id": "T005", "title": "Urgent neglected task", "description": "High priority ignored", "status": "pending", "priority": "critical", "phase": "core", "createdAt": "${urgent_iso}"}
  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "lastUpdated": "${recent_iso}"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create todo.json with only fresh tasks (no stale)
create_fresh_tasks_fixture() {
    local dest="${1:-$TODO_FILE}"
    local recent_iso
    recent_iso=$(_epoch_to_iso "$RECENT_EPOCH")

    cat > "$dest" << EOF
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "completed"},
      "core": {"order": 2, "name": "Core", "status": "active"},
      "testing": {"order": 3, "name": "Testing", "status": "pending"},
      "polish": {"order": 4, "name": "Polish", "status": "pending"},
      "maintenance": {"order": 5, "name": "Maintenance", "status": "pending"}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Fresh task 1", "description": "Recent", "status": "pending", "priority": "medium", "phase": "core", "createdAt": "${recent_iso}"},
    {"id": "T002", "title": "Fresh task 2", "description": "Also recent", "status": "active", "priority": "high", "phase": "core", "createdAt": "${recent_iso}"}
  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "lastUpdated": "${recent_iso}"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create epic with stale and fresh child tasks
create_epic_with_stale_tasks() {
    local dest="${1:-$TODO_FILE}"
    local recent_iso old_pending_iso
    recent_iso=$(_epoch_to_iso "$RECENT_EPOCH")
    old_pending_iso=$(_epoch_to_iso "$OLD_PENDING_EPOCH")

    cat > "$dest" << EOF
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "completed"},
      "core": {"order": 2, "name": "Core", "status": "active"},
      "testing": {"order": 3, "name": "Testing", "status": "pending"},
      "polish": {"order": 4, "name": "Polish", "status": "pending"},
      "maintenance": {"order": 5, "name": "Maintenance", "status": "pending"}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Test Epic", "description": "Parent epic", "status": "pending", "priority": "high", "phase": "core", "type": "epic", "parentId": null, "createdAt": "${recent_iso}"},
    {"id": "T002", "title": "Epic child fresh", "description": "Fresh child", "status": "pending", "priority": "medium", "phase": "core", "type": "task", "parentId": "T001", "createdAt": "${recent_iso}"},
    {"id": "T003", "title": "Epic child stale", "description": "Stale child", "status": "pending", "priority": "low", "phase": "core", "type": "task", "parentId": "T001", "createdAt": "${old_pending_iso}"},
    {"id": "T004", "title": "Outside epic stale", "description": "Stale but not in epic", "status": "pending", "priority": "low", "phase": "core", "type": "task", "parentId": null, "createdAt": "${old_pending_iso}"}
  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "lastUpdated": "${recent_iso}"
}
EOF
    _update_fixture_checksum "$dest"
}

# Configure stale detection in config.json
set_stale_detection_config() {
    local enabled="${1:-true}"
    local pending_days="${2:-30}"
    local no_update_days="${3:-14}"
    local blocked_days="${4:-7}"
    local urgent_days="${5:-7}"

    jq --argjson enabled "$enabled" \
       --argjson pending "$pending_days" \
       --argjson noUpdate "$no_update_days" \
       --argjson blocked "$blocked_days" \
       --argjson urgent "$urgent_days" \
       '.analyze.staleDetection = {
         enabled: $enabled,
         pendingDays: $pending,
         noUpdateDays: $noUpdate,
         blockedDays: $blocked,
         urgentNeglectedDays: $urgent
       }' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
}

# =============================================================================
# JSON Output Tests
# =============================================================================

@test "analyze JSON: includes staleTasks array when stale tasks exist" {
    create_stale_tasks_fixture

    run bash "$ANALYZE_SCRIPT" --json
    assert_success

    # Should have staleTasks array
    echo "$output" | jq -e '.staleTasks' > /dev/null

    # Should be a non-empty array
    local stale_count
    stale_count=$(echo "$output" | jq '.staleTasks | length')
    [[ "$stale_count" -gt 0 ]]
}

@test "analyze JSON: staleTasks excludes fresh tasks" {
    create_stale_tasks_fixture

    run bash "$ANALYZE_SCRIPT" --json
    assert_success

    # T001 (fresh task) should NOT be in staleTasks
    local has_fresh
    has_fresh=$(echo "$output" | jq '[.staleTasks[] | select(.taskId == "T001")] | length')
    [[ "$has_fresh" -eq 0 ]]
}

@test "analyze JSON: staleCount field matches staleTasks array length" {
    create_stale_tasks_fixture

    run bash "$ANALYZE_SCRIPT" --json
    assert_success

    local stale_count array_length
    stale_count=$(echo "$output" | jq '.staleCount')
    array_length=$(echo "$output" | jq '.staleTasks | length')

    [[ "$stale_count" -eq "$array_length" ]]
}

@test "analyze JSON: staleTasks array has correct structure" {
    create_stale_tasks_fixture

    run bash "$ANALYZE_SCRIPT" --json
    assert_success

    # Each stale task should have required fields
    echo "$output" | jq -e '.staleTasks[0] | has("taskId")' > /dev/null
    echo "$output" | jq -e '.staleTasks[0] | has("title")' > /dev/null
    echo "$output" | jq -e '.staleTasks[0] | has("priority")' > /dev/null
    echo "$output" | jq -e '.staleTasks[0] | has("staleness")' > /dev/null

    # Staleness object should have type and reason
    echo "$output" | jq -e '.staleTasks[0].staleness | has("type")' > /dev/null
    echo "$output" | jq -e '.staleTasks[0].staleness | has("reason")' > /dev/null
}

@test "analyze JSON: staleTasks sorted by severity (urgent_neglected first)" {
    create_stale_tasks_fixture

    run bash "$ANALYZE_SCRIPT" --json
    assert_success

    # First stale task should be urgent_neglected (T005 is critical priority)
    local first_type
    first_type=$(echo "$output" | jq -r '.staleTasks[0].staleness.type')
    [[ "$first_type" == "urgent_neglected" ]]
}

@test "analyze JSON: empty staleTasks when no stale tasks" {
    create_fresh_tasks_fixture

    run bash "$ANALYZE_SCRIPT" --json
    assert_success

    local stale_count
    stale_count=$(echo "$output" | jq '.staleTasks | length')
    [[ "$stale_count" -eq 0 ]]

    local stale_count_field
    stale_count_field=$(echo "$output" | jq '.staleCount')
    [[ "$stale_count_field" -eq 0 ]]
}

@test "analyze JSON: staleTasks excluded when disabled in config" {
    create_stale_tasks_fixture
    set_stale_detection_config false

    run bash "$ANALYZE_SCRIPT" --json
    assert_success

    # staleTasks and staleCount should not be present when disabled
    local has_stale_tasks
    has_stale_tasks=$(echo "$output" | jq 'has("staleTasks")')
    [[ "$has_stale_tasks" == "false" ]]
}

# =============================================================================
# Human Output Tests
# =============================================================================

@test "analyze human: shows STALE TASKS section when stale tasks exist" {
    create_stale_tasks_fixture

    run bash "$ANALYZE_SCRIPT" --human
    assert_success

    assert_output --partial "STALE TASKS"
}

@test "analyze human: stale section shows task IDs and reasons" {
    create_stale_tasks_fixture

    run bash "$ANALYZE_SCRIPT" --human
    assert_success

    # Should show at least one stale task ID
    assert_output --regexp "T00[2-5]"
}

@test "analyze human: no STALE TASKS section when no stale tasks" {
    create_fresh_tasks_fixture

    run bash "$ANALYZE_SCRIPT" --human
    assert_success

    refute_output --partial "STALE TASKS"
}

@test "analyze human: no STALE TASKS section when disabled" {
    create_stale_tasks_fixture
    set_stale_detection_config false

    run bash "$ANALYZE_SCRIPT" --human
    assert_success

    refute_output --partial "STALE TASKS"
}

@test "analyze human: stale section shows count" {
    create_stale_tasks_fixture

    run bash "$ANALYZE_SCRIPT" --human
    assert_success

    # Should show count like "(need review - N total)"
    assert_output --partial "total)"
}

# =============================================================================
# Config Interaction Tests
# =============================================================================

@test "config: default thresholds detect stale tasks" {
    create_stale_tasks_fixture
    # Don't modify config - use defaults

    run bash "$ANALYZE_SCRIPT" --json
    assert_success

    # With default thresholds:
    # - T002 (35 days old) should be old_pending
    # - T003 (16 days old) should be no_updates
    # - T004 (10 days blocked) should be long_blocked
    # - T005 (9 days, critical) should be urgent_neglected
    local stale_count
    stale_count=$(echo "$output" | jq '.staleCount')
    [[ "$stale_count" -ge 3 ]]
}

@test "config: custom pendingDays threshold respected" {
    create_stale_tasks_fixture
    # Set very high threshold (100 days) - T002 (35 days) should NOT be old_pending
    set_stale_detection_config true 100 14 7 7

    run bash "$ANALYZE_SCRIPT" --json
    assert_success

    # T002 should not be marked as old_pending with 100-day threshold
    local old_pending_count
    old_pending_count=$(echo "$output" | jq '[.staleTasks[] | select(.staleness.type == "old_pending" and .taskId == "T002")] | length')
    [[ "$old_pending_count" -eq 0 ]]
}

@test "config: custom noUpdateDays threshold respected" {
    create_stale_tasks_fixture
    # Set very high no_update threshold (100 days)
    set_stale_detection_config true 30 100 7 7

    run bash "$ANALYZE_SCRIPT" --json
    assert_success

    # With 100-day no_update threshold, T003 (16 days) should not be stale via no_updates
    # (may still be stale via other rules)
    local no_update_count
    no_update_count=$(echo "$output" | jq '[.staleTasks[] | select(.staleness.type == "no_updates" and .taskId == "T003")] | length')
    [[ "$no_update_count" -eq 0 ]]
}

@test "config: enabled=false disables all stale detection" {
    create_stale_tasks_fixture
    set_stale_detection_config false

    run bash "$ANALYZE_SCRIPT" --json
    assert_success

    # staleTasks should not exist in output
    local has_stale
    has_stale=$(echo "$output" | jq 'has("staleTasks")')
    [[ "$has_stale" == "false" ]]
}

# =============================================================================
# Epic-Scoped Analysis Tests
# =============================================================================

@test "epic analysis JSON: staleTasks scoped to epic children only" {
    create_epic_with_stale_tasks

    run bash "$ANALYZE_SCRIPT" --parent T001 --json
    assert_success

    # Should have staleTasks array
    echo "$output" | jq -e '.staleTasks' > /dev/null

    # Should include T003 (stale child of epic)
    local has_t003
    has_t003=$(echo "$output" | jq '[.staleTasks[] | select(.taskId == "T003")] | length')
    [[ "$has_t003" -eq 1 ]]

    # Should NOT include T004 (stale but outside epic)
    local has_t004
    has_t004=$(echo "$output" | jq '[.staleTasks[] | select(.taskId == "T004")] | length')
    [[ "$has_t004" -eq 0 ]]
}

@test "epic analysis JSON: staleCount only counts epic children" {
    create_epic_with_stale_tasks

    run bash "$ANALYZE_SCRIPT" --parent T001 --json
    assert_success

    # Should only count T003 (not T004 which is outside epic)
    local stale_count
    stale_count=$(echo "$output" | jq '.staleCount')
    [[ "$stale_count" -eq 1 ]]
}

@test "epic analysis human: STALE TASKS shows scoped count" {
    create_epic_with_stale_tasks

    run bash "$ANALYZE_SCRIPT" --parent T001 --human
    assert_success

    # Should show stale tasks section with "in this epic" context
    assert_output --partial "STALE TASKS"
    assert_output --partial "epic"
}

@test "epic analysis: no stale section when epic has no stale children" {
    local recent_iso
    recent_iso=$(_epoch_to_iso "$RECENT_EPOCH")

    # Create epic with only fresh children
    cat > "$TODO_FILE" << EOF
{
  "version": "2.3.0",
  "project": {"name": "test", "currentPhase": "core", "phases": {}},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Test Epic", "description": "Epic", "status": "pending", "priority": "high", "phase": "core", "type": "epic", "parentId": null, "createdAt": "${recent_iso}"},
    {"id": "T002", "title": "Fresh child", "description": "Fresh", "status": "pending", "priority": "medium", "phase": "core", "type": "task", "parentId": "T001", "createdAt": "${recent_iso}"}
  ],
  "focus": {}
}
EOF
    _update_fixture_checksum "$TODO_FILE"

    run bash "$ANALYZE_SCRIPT" --parent T001 --human
    assert_success

    refute_output --partial "STALE TASKS"
}

# =============================================================================
# Full Output Mode Tests
# =============================================================================

@test "analyze full: includes STALE TASKS in detailed output" {
    create_stale_tasks_fixture

    run bash "$ANALYZE_SCRIPT" --full
    assert_success

    assert_output --partial "STALE TASKS"
}

# =============================================================================
# Staleness Type Detection Tests
# =============================================================================

@test "staleness: detects old_pending type correctly" {
    create_stale_tasks_fixture

    run bash "$ANALYZE_SCRIPT" --json
    assert_success

    # T002 is 35 days old pending - should be old_pending
    local t002_type
    t002_type=$(echo "$output" | jq -r '.staleTasks[] | select(.taskId == "T002") | .staleness.type')
    [[ "$t002_type" == "old_pending" ]]
}

@test "staleness: detects long_blocked type correctly" {
    create_stale_tasks_fixture

    run bash "$ANALYZE_SCRIPT" --json
    assert_success

    # T004 is blocked for 10 days - should be long_blocked
    local t004_type
    t004_type=$(echo "$output" | jq -r '.staleTasks[] | select(.taskId == "T004") | .staleness.type')
    [[ "$t004_type" == "long_blocked" ]]
}

@test "staleness: detects urgent_neglected type correctly" {
    create_stale_tasks_fixture

    run bash "$ANALYZE_SCRIPT" --json
    assert_success

    # T005 is critical priority, 9 days old - should be urgent_neglected
    local t005_type
    t005_type=$(echo "$output" | jq -r '.staleTasks[] | select(.taskId == "T005") | .staleness.type')
    [[ "$t005_type" == "urgent_neglected" ]]
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "edge case: done tasks never marked as stale" {
    local old_iso
    old_iso=$(_epoch_to_iso "$OLD_PENDING_EPOCH")

    cat > "$TODO_FILE" << EOF
{
  "version": "2.3.0",
  "project": {"name": "test", "currentPhase": "core", "phases": {}},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Old done task", "description": "Completed", "status": "done", "priority": "critical", "phase": "core", "createdAt": "${old_iso}", "completedAt": "${old_iso}"}
  ],
  "focus": {}
}
EOF
    _update_fixture_checksum "$TODO_FILE"

    run bash "$ANALYZE_SCRIPT" --json

    # Should have empty staleTasks (done tasks excluded)
    local stale_count
    stale_count=$(echo "$output" | jq '.staleCount // 0')
    [[ "$stale_count" -eq 0 ]]
}

@test "edge case: cancelled tasks never marked as stale" {
    local old_iso
    old_iso=$(_epoch_to_iso "$OLD_PENDING_EPOCH")

    cat > "$TODO_FILE" << EOF
{
  "version": "2.3.0",
  "project": {"name": "test", "currentPhase": "core", "phases": {}},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Old cancelled task", "description": "Cancelled", "status": "cancelled", "priority": "critical", "phase": "core", "createdAt": "${old_iso}"}
  ],
  "focus": {}
}
EOF
    _update_fixture_checksum "$TODO_FILE"

    run bash "$ANALYZE_SCRIPT" --json

    local stale_count
    stale_count=$(echo "$output" | jq '.staleCount // 0')
    [[ "$stale_count" -eq 0 ]]
}

@test "edge case: task with recent notes avoids no_updates staleness" {
    # Task created 16 days ago (within pending threshold) but with no recent notes
    # would be "no_updates". With recent notes, it should not be stale.
    local no_update_iso recent_note_ts
    no_update_iso=$(_epoch_to_iso "$NO_UPDATE_EPOCH")
    recent_note_ts=$(date -u -d "@$RECENT_EPOCH" "+%Y-%m-%d %H:%M:%S UTC" 2>/dev/null || \
        date -u -r "$RECENT_EPOCH" "+%Y-%m-%d %H:%M:%S UTC" 2>/dev/null)

    cat > "$TODO_FILE" << EOF
{
  "version": "2.3.0",
  "project": {"name": "test", "currentPhase": "core", "phases": {}},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Task with recent note", "description": "Has activity", "status": "active", "priority": "medium", "phase": "core", "createdAt": "${no_update_iso}", "notes": ["${recent_note_ts}: Recent progress update"]}
  ],
  "focus": {}
}
EOF
    _update_fixture_checksum "$TODO_FILE"

    run bash "$ANALYZE_SCRIPT" --json

    # Task has recent note, should NOT be marked as no_updates
    # Handle case where staleTasks might be null or empty
    local no_updates_count
    no_updates_count=$(echo "$output" | jq '[(.staleTasks // [])[] | select(.staleness.type == "no_updates" and .taskId == "T001")] | length')
    [[ "$no_updates_count" -eq 0 ]]
}

@test "edge case: empty tasks array handles gracefully" {
    create_empty_todo

    run bash "$ANALYZE_SCRIPT" --json
    # Should succeed with exit 100 (no data) or 0

    # Should not crash, output should be valid JSON
    echo "$output" | jq -e '.' > /dev/null
}
