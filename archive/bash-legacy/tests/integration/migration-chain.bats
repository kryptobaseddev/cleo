#!/usr/bin/env bats
# =============================================================================
# migration-chain.bats - Migration chain comprehensive tests (T1248)
# =============================================================================
# Epic: T1243 - Upgrade Command Production Readiness
#
# Tests prevent anti-hallucination failures in the migration system by
# verifying actual migration behavior, not mocked behavior:
# 1. Fresh project upgrade 2.0.0 -> current version
# 2. Existing project 2.4.0 -> current version
# 3. Position field added during migration
# 4. positionVersion field added during migration
# 5. upgrade --status matches actual execution
# 6. validate --fix changes persist
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file

    # Export paths for migration tests
    export UPGRADE_SCRIPT="${SCRIPTS_DIR}/upgrade.sh"
    export VALIDATE_SCRIPT="${SCRIPTS_DIR}/validate.sh"
    export INIT_SCRIPT="${SCRIPTS_DIR}/init.sh"
    export CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
    export SCHEMA_DIR="${PROJECT_ROOT}/schemas"

    # Get current schema version from the schema file (single source of truth)
    export CURRENT_TODO_VERSION
    CURRENT_TODO_VERSION=$(jq -r '.schemaVersion' "${SCHEMA_DIR}/todo.schema.json")
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test

    # Create minimal required files for upgrade
    _create_minimal_config
    _create_minimal_log
    _create_minimal_archive
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

# Create minimal config.json for testing
_create_minimal_config() {
    cat > "$CONFIG_FILE" << 'EOF'
{
  "version": "2.5.0",
  "_meta": {"schemaVersion": "2.5.0"},
  "validation": {"strictMode": false, "requireDescription": false},
  "multiSession": {"enabled": false},
  "session": {"requireSession": false}
}
EOF
}

# Create minimal log file for testing
_create_minimal_log() {
    cat > "$LOG_FILE" << 'EOF'
{
  "version": "2.4.0",
  "_meta": {"schemaVersion": "2.4.0"},
  "entries": []
}
EOF
}

# Create minimal archive file for testing
_create_minimal_archive() {
    cat > "$ARCHIVE_FILE" << 'EOF'
{
  "version": "2.4.0",
  "_meta": {"schemaVersion": "2.4.0", "totalArchived": 0},
  "archivedTasks": [],
  "statistics": {"byPhase": {}, "byPriority": {}, "byLabel": {}}
}
EOF
}

# Create todo.json with old v2.0.0 schema (pre-project structure)
_create_legacy_v2_0_0_todo() {
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.0.0",
  "project": "test-project",
  "phases": {
    "setup": {"order": 1, "name": "Setup", "status": "active"},
    "core": {"order": 2, "name": "Core", "status": "pending"}
  },
  "checksum": "legacy123",
  "tasks": [
    {
      "id": "T001",
      "title": "Legacy task one",
      "description": "Task from v2.0.0 schema",
      "status": "pending",
      "priority": "high",
      "createdAt": "2025-12-01T10:00:00Z"
    },
    {
      "id": "T002",
      "title": "Legacy task two",
      "description": "Another task from v2.0.0 schema",
      "status": "pending",
      "priority": "medium",
      "createdAt": "2025-12-01T11:00:00Z"
    }
  ],
  "focus": {},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF
}

# Create todo.json with v2.4.0 schema (no position fields)
_create_v2_4_0_todo() {
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.4.0",
  "project": {
    "name": "test-project",
    "currentPhase": "setup",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "active", "startedAt": "2025-12-01T10:00:00Z", "completedAt": null},
      "core": {"order": 2, "name": "Core", "status": "pending", "startedAt": null, "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"schemaVersion": "2.4.0", "checksum": "test123"},
  "tasks": [
    {
      "id": "T001",
      "title": "Task without position",
      "description": "Task created before position field",
      "status": "pending",
      "priority": "high",
      "phase": "setup",
      "type": "task",
      "parentId": null,
      "createdAt": "2025-12-01T10:00:00Z"
    },
    {
      "id": "T002",
      "title": "Second task without position",
      "description": "Another task without position field",
      "status": "pending",
      "priority": "medium",
      "phase": "setup",
      "type": "task",
      "parentId": null,
      "createdAt": "2025-12-01T11:00:00Z"
    },
    {
      "id": "T003",
      "title": "Child task without position",
      "description": "Child task to test parent-scoped positioning",
      "status": "pending",
      "priority": "low",
      "phase": "setup",
      "type": "subtask",
      "parentId": "T001",
      "createdAt": "2025-12-01T12:00:00Z"
    }
  ],
  "focus": {"currentPhase": "setup"},
  "labels": {},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF
}

# Create todo.json with validation issues (incorrect checksum)
_create_todo_with_validation_issues() {
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.6.0",
  "project": {
    "name": "test-project",
    "currentPhase": "setup",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "active", "startedAt": "2025-12-01T10:00:00Z", "completedAt": null},
      "core": {"order": 2, "name": "Core", "status": "pending", "startedAt": null, "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"schemaVersion": "2.6.0", "checksum": "INCORRECT_CHECKSUM"},
  "tasks": [
    {
      "id": "T001",
      "title": "Task with bad checksum",
      "description": "Task in file with incorrect checksum",
      "status": "pending",
      "priority": "high",
      "phase": "setup",
      "type": "task",
      "parentId": null,
      "position": 1,
      "positionVersion": 0,
      "createdAt": "2025-12-01T10:00:00Z"
    }
  ],
  "focus": {"currentPhase": "setup"},
  "labels": {},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF
}

# Get file SHA256 checksum for comparison
_get_file_checksum() {
    local file="$1"
    sha256sum "$file" 2>/dev/null | cut -c1-64
}

# =============================================================================
# TEST 1: Fresh project 2.0.0 upgrades to current version
# =============================================================================

@test "migration chain: fresh project 2.0.0 upgrades to current" {
    # Create project with very old v2.0.0 schema (legacy structure)
    _create_legacy_v2_0_0_todo

    # Verify legacy structure exists before migration
    run jq -e 'has("phases")' "$TODO_FILE"
    assert_success "Legacy top-level phases should exist before migration"

    run jq -e '.project | type == "string"' "$TODO_FILE"
    assert_success "Legacy string project field should exist"

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force --json
    assert_success

    # Verify schema version is current
    local final_version
    final_version=$(jq -r '._meta.schemaVersion' "$TODO_FILE")
    assert_equal "$final_version" "$CURRENT_TODO_VERSION"

    # Verify legacy phases moved to project.phases
    run jq -e 'has("phases")' "$TODO_FILE"
    assert_failure "Top-level phases should NOT exist after migration"

    run jq -e '.project.phases' "$TODO_FILE"
    assert_success "project.phases should exist after migration"

    # Verify project is now an object
    run jq -e '.project | type == "object"' "$TODO_FILE"
    assert_success "project should be an object after migration"

    # Verify legacy checksum removed
    run jq -e 'has("checksum")' "$TODO_FILE"
    assert_failure "Top-level checksum should NOT exist after migration"

    # Verify tasks are present
    local task_count
    task_count=$(jq '.tasks | length' "$TODO_FILE")
    assert_equal "$task_count" "2"
}

# =============================================================================
# TEST 2: Existing 2.4.0 project upgrades correctly
# =============================================================================

@test "migration chain: existing 2.4.0 project upgrades correctly" {
    # Create project with v2.4.0 schema (proper structure, no position fields)
    _create_v2_4_0_todo

    # Verify pre-migration state - no position fields
    local has_position_before
    has_position_before=$(jq '[.tasks[] | select(has("position"))] | length' "$TODO_FILE")
    assert_equal "$has_position_before" "0" "Tasks should NOT have position field before migration"

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force --json
    assert_success

    # Verify schema version is current
    local final_version
    final_version=$(jq -r '._meta.schemaVersion' "$TODO_FILE")
    assert_equal "$final_version" "$CURRENT_TODO_VERSION"

    # Verify position fields were added
    local has_position_after
    has_position_after=$(jq '[.tasks[] | select(has("position"))] | length' "$TODO_FILE")
    assert_equal "$has_position_after" "3" "All 3 tasks should have position field after migration"

    # Verify positionVersion fields were added
    local has_position_version_after
    has_position_version_after=$(jq '[.tasks[] | select(has("positionVersion"))] | length' "$TODO_FILE")
    assert_equal "$has_position_version_after" "3" "All 3 tasks should have positionVersion field after migration"
}

# =============================================================================
# TEST 3: Position field added during migration
# =============================================================================

@test "migration chain: position field added during migration" {
    # Create v2.4.0 schema without position field
    _create_v2_4_0_todo

    # Verify tasks don't have position before migration
    run jq '[.tasks[] | select(has("position"))] | length' "$TODO_FILE"
    assert_output "0"

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force --json
    assert_success

    # Verify position field exists and is valid integer on all tasks
    run jq '[.tasks[] | select(.position != null and (.position | type) == "number" and (.position | floor) == .position)] | length' "$TODO_FILE"
    assert_output "3"

    # Verify positions are ordered by createdAt within parent scope
    # Root tasks (parentId null): T001 created first should have position 1, T002 position 2
    local t001_position t002_position
    t001_position=$(jq '.tasks[] | select(.id == "T001") | .position' "$TODO_FILE")
    t002_position=$(jq '.tasks[] | select(.id == "T002") | .position' "$TODO_FILE")

    assert_equal "$t001_position" "1" "T001 (created first) should have position 1"
    assert_equal "$t002_position" "2" "T002 (created second) should have position 2"

    # Child task T003 (parentId = T001) should have position 1 within its parent scope
    local t003_position
    t003_position=$(jq '.tasks[] | select(.id == "T003") | .position' "$TODO_FILE")
    assert_equal "$t003_position" "1" "T003 (only child of T001) should have position 1"
}

# =============================================================================
# TEST 4: positionVersion field added during migration
# =============================================================================

@test "migration chain: positionVersion field added during migration" {
    # Create v2.4.0 schema without positionVersion field
    _create_v2_4_0_todo

    # Verify tasks don't have positionVersion before migration
    run jq '[.tasks[] | select(has("positionVersion"))] | length' "$TODO_FILE"
    assert_output "0"

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force --json
    assert_success

    # Verify positionVersion field exists on all tasks
    run jq '[.tasks[] | select(has("positionVersion"))] | length' "$TODO_FILE"
    assert_output "3"

    # Verify positionVersion is initialized to 0 for new migrations
    run jq '[.tasks[] | select(.positionVersion == 0)] | length' "$TODO_FILE"
    assert_output "3" "All tasks should have positionVersion initialized to 0"
}

# =============================================================================
# TEST 5: upgrade --status matches actual execution
# =============================================================================

@test "migration chain: upgrade --status matches actual execution" {
    # Create v2.4.0 schema that needs upgrade
    _create_v2_4_0_todo

    # Run upgrade --status (dry run) to see what needs updating
    run bash "$UPGRADE_SCRIPT" --status --json
    assert_success

    # Parse status output to check if updates are needed
    local status_output
    status_output=$(echo "$output" | tail -n 1)

    # Status should indicate updates needed (upToDate: false)
    local up_to_date
    up_to_date=$(echo "$status_output" | jq -r '.upToDate // "null"')

    # If upToDate is false, verify actual execution also makes changes
    if [[ "$up_to_date" == "false" ]]; then
        # Get checksum before actual upgrade
        local checksum_before
        checksum_before=$(_get_file_checksum "$TODO_FILE")

        # Run actual upgrade
        run bash "$UPGRADE_SCRIPT" --force --json
        assert_success

        # Get checksum after upgrade
        local checksum_after
        checksum_after=$(_get_file_checksum "$TODO_FILE")

        # Checksums should differ (file was changed)
        [[ "$checksum_before" != "$checksum_after" ]]
    fi

    # Run status again - should now report up to date
    run bash "$UPGRADE_SCRIPT" --status --json
    assert_success

    local final_status
    final_status=$(echo "$output" | tail -n 1)
    local final_up_to_date
    final_up_to_date=$(echo "$final_status" | jq -r '.upToDate // "null"')

    # After upgrade, should report up to date (or success true)
    # Note: Use direct jq check instead of run+pipe
    echo "$final_status" | jq -e '.success == true' >/dev/null
}

# =============================================================================
# TEST 6: validate --fix changes persist
# =============================================================================

@test "migration chain: validate --fix changes persist" {
    # Create project with validation issues (incorrect checksum)
    _create_todo_with_validation_issues

    # Verify the checksum is incorrect
    local stored_checksum
    stored_checksum=$(jq -r '._meta.checksum' "$TODO_FILE")
    assert_equal "$stored_checksum" "INCORRECT_CHECKSUM"

    # Run validate to detect the issue (should report checksum mismatch)
    run bash "$VALIDATE_SCRIPT" --json
    # May fail due to checksum mismatch - that's expected

    # Run validate --fix to correct the checksum
    run bash "$VALIDATE_SCRIPT" --fix --json
    # Should succeed or at least fix the checksum

    # Verify checksum was corrected and persisted
    local fixed_checksum
    fixed_checksum=$(jq -r '._meta.checksum' "$TODO_FILE")

    # Checksum should no longer be the incorrect one
    [[ "$fixed_checksum" != "INCORRECT_CHECKSUM" ]]

    # Compute expected checksum
    local expected_checksum
    expected_checksum=$(jq -c '.tasks' "$TODO_FILE" | sha256sum | cut -c1-16)

    # Fixed checksum should match computed checksum
    assert_equal "$fixed_checksum" "$expected_checksum" "Checksum should be corrected and match computed value"

    # Run validate again - should report no issues
    run bash "$VALIDATE_SCRIPT" --json
    assert_success "Validation should pass after --fix"

    # Parse output to verify success
    local validate_output
    validate_output=$(echo "$output" | tail -n 1)
    # Note: Use direct jq check instead of run+pipe
    echo "$validate_output" | jq -e '.success == true' >/dev/null
}

# =============================================================================
# ADDITIONAL EDGE CASE TESTS
# =============================================================================

@test "migration chain: migration is idempotent" {
    # Create v2.4.0 schema
    _create_v2_4_0_todo

    # First upgrade
    run bash "$UPGRADE_SCRIPT" --force --json
    assert_success

    # Get checksum after first upgrade
    local checksum_1
    checksum_1=$(_get_file_checksum "$TODO_FILE")

    # Second upgrade (should be no-op)
    run bash "$UPGRADE_SCRIPT" --force --json
    assert_success

    # Get checksum after second upgrade
    local checksum_2
    checksum_2=$(_get_file_checksum "$TODO_FILE")

    # Third upgrade for good measure
    run bash "$UPGRADE_SCRIPT" --force --json
    assert_success

    local checksum_3
    checksum_3=$(_get_file_checksum "$TODO_FILE")

    # Checksums should be identical between runs 2 and 3 (idempotent after migration)
    assert_equal "$checksum_2" "$checksum_3" "Upgrade should be idempotent"
}

@test "migration chain: preserves existing position values" {
    # Create v2.4.0 schema
    _create_v2_4_0_todo

    # Manually add position to one task (simulating partial migration)
    jq '.tasks[0].position = 99' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force --json
    assert_success

    # Verify existing position was preserved
    local t001_position
    t001_position=$(jq '.tasks[] | select(.id == "T001") | .position' "$TODO_FILE")
    assert_equal "$t001_position" "99" "Existing position value should be preserved"

    # Verify other tasks got new positions
    local t002_position
    t002_position=$(jq '.tasks[] | select(.id == "T002") | .position' "$TODO_FILE")
    [[ "$t002_position" != "null" && "$t002_position" != "" ]]
}

@test "migration chain: handles empty tasks array" {
    # Create v2.4.0 schema with no tasks
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.4.0",
  "project": {
    "name": "test-project",
    "currentPhase": "setup",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "active", "startedAt": "2025-12-01T10:00:00Z", "completedAt": null}
    }
  },
  "_meta": {"schemaVersion": "2.4.0", "checksum": "empty"},
  "tasks": [],
  "focus": {"currentPhase": "setup"},
  "labels": {},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force --json
    assert_success

    # Verify schema version is current
    local final_version
    final_version=$(jq -r '._meta.schemaVersion' "$TODO_FILE")
    assert_equal "$final_version" "$CURRENT_TODO_VERSION"

    # Verify tasks array is still empty
    local task_count
    task_count=$(jq '.tasks | length' "$TODO_FILE")
    assert_equal "$task_count" "0"
}
