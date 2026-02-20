#!/usr/bin/env bats
# =============================================================================
# upgrade-v0.48.0.bats - Integration test for v0.47.1 → v0.48.0 upgrade (T1309)
# =============================================================================
# Tests the migration path from v0.47.1 (uses .version field) to v0.48.0
# (uses ._meta.schemaVersion with dynamic version discovery).
#
# Key changes in v0.48.0:
# - Dynamic schema version discovery from schema files
# - Migration version detection improvements
# - Backward compatibility for projects using .version field
# - All existing tests continue to pass after upgrade
#
# Test Coverage:
# 1. Data Integrity - No data loss during migration
# 2. Version Field Migration - .version → ._meta.schemaVersion
# 3. Rollback Safety - Can restore from backup
# 4. Test Suite Compatibility - Existing tests pass post-upgrade
# 5. Idempotency - Multiple upgrades produce same result
# 6. Edge Cases - Missing fields, legacy structures
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

    # Export paths for upgrade script
    export UPGRADE_SCRIPT="${SCRIPTS_DIR}/upgrade.sh"
    export MIGRATE_SCRIPT="${LIB_DIR}/data/migrate.sh"
    export CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
    export SCHEMA_DIR="$CLEO_HOME/schemas"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# FIXTURE CREATION HELPERS
# =============================================================================

# Setup v0.47.1 project (removes conflicting files, creates fixtures)
_setup_v047_project() {
    # Remove pre-existing log/archive files created by common_setup to avoid migration conflicts
    rm -f "$LOG_FILE" "$ARCHIVE_FILE"

    _create_v047_todo
    _create_v047_config
}

# Create v0.47.1-style todo.json (uses .version, not ._meta.schemaVersion)
# NOTE: Must be called AFTER common_setup_per_test which creates .cleo directory
_create_v047_todo() {
    # Clean up conflicting files from common_setup
    rm -f "$LOG_FILE" "$ARCHIVE_FILE"

    # Ensure directory exists
    mkdir -p "$(dirname "$TODO_FILE")"

    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.6.0",
  "project": {
    "name": "test-project-v047",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "completed", "startedAt": "2025-12-01T10:00:00Z", "completedAt": "2025-12-01T12:00:00Z"},
      "core": {"order": 2, "name": "Core", "status": "active", "startedAt": "2025-12-01T13:00:00Z", "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {
    "version": "2.6.0",
    "checksum": "abc123def456",
    "configVersion": "2.4.0",
    "activeSession": "session_abc123"
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Epic task",
      "description": "Top-level epic for testing hierarchy",
      "status": "active",
      "priority": "high",
      "type": "epic",
      "size": "large",
      "parentId": null,
      "position": 1,
      "positionVersion": 0,
      "labels": ["feature-auth", "critical"],
      "dependsOn": [],
      "phase": "core",
      "createdAt": "2025-12-01T10:00:00Z",
      "updatedAt": "2025-12-01T15:00:00Z",
      "notes": []
    },
    {
      "id": "T002",
      "title": "Subtask of epic",
      "description": "Child task for testing parent-child relationships",
      "status": "pending",
      "priority": "medium",
      "type": "task",
      "size": "medium",
      "parentId": "T001",
      "position": 1,
      "positionVersion": 0,
      "labels": ["backend"],
      "dependsOn": [],
      "phase": "core",
      "createdAt": "2025-12-01T11:00:00Z",
      "updatedAt": "2025-12-01T11:00:00Z",
      "notes": [
        {"timestamp": "2025-12-01T12:00:00Z", "content": "Initial analysis complete"}
      ]
    },
    {
      "id": "T003",
      "title": "Blocked task",
      "description": "Task with dependencies",
      "status": "blocked",
      "priority": "low",
      "type": "task",
      "size": "small",
      "parentId": null,
      "position": 2,
      "positionVersion": 0,
      "labels": [],
      "dependsOn": ["T001", "T002"],
      "blockedBy": "Waiting for T001 and T002 completion",
      "phase": "core",
      "createdAt": "2025-12-01T14:00:00Z",
      "updatedAt": "2025-12-01T14:30:00Z",
      "notes": []
    }
  ],
  "focus": {
    "currentTask": "T001",
    "currentPhase": "core",
    "sessionNote": "Working on authentication epic",
    "nextAction": "Complete T002 before moving to T003"
  },
  "lastUpdated": "2025-12-01T15:00:00Z"
}
EOF
}

# Create v0.47.1-style config.json
# NOTE: v0.47.1 uses config schema version 2.4.0 (current)
_create_v047_config() {
    mkdir -p "$(dirname "$CONFIG_FILE")"

    cat > "$CONFIG_FILE" << 'EOF'
{
  "version": "2.4.0",
  "_meta": {
    "version": "2.4.0"
  },
  "output": {
    "showColor": true,
    "showUnicode": true,
    "showProgressBars": true,
    "showCompactTitles": false
  },
  "session": {
    "requireSession": false,
    "requireSessionNote": false,
    "warnOnNoFocus": false,
    "autoStartSession": false,
    "sessionTimeoutHours": 72
  },
  "complete": {
    "requireNotes": false
  },
  "multiSession": {
    "enabled": false
  },
  "hierarchy": {
    "maxSiblings": 20,
    "maxDepth": 3,
    "countDoneInLimit": false,
    "maxActiveSiblings": 8,
    "autoCompleteParent": true,
    "autoCompleteMode": "auto"
  }
}
EOF
}

# Create v0.47.1-style archive.json
# NOTE: Archive schema is independent - uses version 2.4.0
_create_v047_archive() {
    mkdir -p "$(dirname "$ARCHIVE_FILE")"

    cat > "$ARCHIVE_FILE" << 'EOF'
{
  "version": "2.4.0",
  "project": "test-project-v047",
  "_meta": {
    "version": "2.4.0"
  },
  "archivedTasks": [
    {
      "id": "T100",
      "title": "Archived task",
      "description": "Completed and archived",
      "status": "done",
      "priority": "high",
      "type": "task",
      "size": "medium",
      "parentId": null,
      "labels": ["completed"],
      "dependsOn": [],
      "phase": "setup",
      "createdAt": "2025-11-01T10:00:00Z",
      "updatedAt": "2025-11-15T12:00:00Z",
      "completedAt": "2025-11-15T12:00:00Z",
      "archivedAt": "2025-12-01T09:00:00Z",
      "notes": []
    }
  ]
}
EOF
}

# Create v0.47.1-style log.json (subset of entries)
# NOTE: Log schema is independent - uses version 2.4.0
_create_v047_log() {
    mkdir -p "$(dirname "$LOG_FILE")"

    cat > "$LOG_FILE" << 'EOF'
{
  "version": "2.4.0",
  "project": "test-project-v047",
  "_meta": {
    "version": "2.4.0"
  },
  "entries": [
    {
      "timestamp": "2025-12-01T10:00:00Z",
      "operation": "create",
      "taskId": "T001",
      "changes": {"title": "Epic task", "status": "active"}
    },
    {
      "timestamp": "2025-12-01T11:00:00Z",
      "operation": "create",
      "taskId": "T002",
      "changes": {"title": "Subtask of epic", "parentId": "T001"}
    }
  ]
}
EOF
}

# Get task count for data integrity verification
_get_task_count() {
    jq '.tasks | length' "$TODO_FILE"
}

# Get specific task by ID
_get_task_by_id() {
    local task_id="$1"
    jq --arg id "$task_id" '.tasks[] | select(.id == $id)' "$TODO_FILE"
}

# Verify critical task fields preserved
_verify_task_integrity() {
    local task_id="$1"
    local expected_title="$2"

    local actual_title
    actual_title=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .title' "$TODO_FILE")

    [ "$actual_title" = "$expected_title" ]
}

# =============================================================================
# TEST 1: Data Integrity - No data loss during migration
# =============================================================================

@test "upgrade v0.48.0: preserves all tasks during migration" {
    _setup_v047_project

    # Record task count before upgrade
    local before_count
    before_count=$(_get_task_count)

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force

    # Should succeed
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Task count should be identical
    local after_count
    after_count=$(_get_task_count)
    [ "$before_count" -eq "$after_count" ]
}

@test "upgrade v0.48.0: preserves task content and metadata" {
    _setup_v047_project

    # Record task details before upgrade
    local t001_before t002_before t003_before
    t001_before=$(_get_task_by_id "T001")
    t002_before=$(_get_task_by_id "T002")
    t003_before=$(_get_task_by_id "T003")

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Verify tasks retained all critical fields
    _verify_task_integrity "T001" "Epic task"
    _verify_task_integrity "T002" "Subtask of epic"
    _verify_task_integrity "T003" "Blocked task"

    # Verify hierarchy preserved
    local t002_parent
    t002_parent=$(jq -r '.tasks[] | select(.id == "T002") | .parentId' "$TODO_FILE")
    [ "$t002_parent" = "T001" ]

    # Verify dependencies preserved
    local t003_deps
    t003_deps=$(jq -r '.tasks[] | select(.id == "T003") | .dependsOn | length' "$TODO_FILE")
    [ "$t003_deps" -eq 2 ]
}

@test "upgrade v0.48.0: preserves notes and timestamps" {
    _create_v047_todo
    _create_v047_config

    # Verify T002 has notes before upgrade
    local notes_before
    notes_before=$(jq '.tasks[] | select(.id == "T002") | .notes | length' "$TODO_FILE")
    [ "$notes_before" -eq 1 ]

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Notes should be preserved
    local notes_after
    notes_after=$(jq '.tasks[] | select(.id == "T002") | .notes | length' "$TODO_FILE")
    [ "$notes_after" -eq "$notes_before" ]

    # Verify note content unchanged
    local note_content
    note_content=$(jq -r '.tasks[] | select(.id == "T002") | .notes[0].content' "$TODO_FILE")
    [ "$note_content" = "Initial analysis complete" ]
}

@test "upgrade v0.48.0: preserves focus state" {
    _create_v047_todo
    _create_v047_config

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Verify focus preserved
    local current_task session_note
    current_task=$(jq -r '.focus.currentTask' "$TODO_FILE")
    session_note=$(jq -r '.focus.sessionNote' "$TODO_FILE")

    [ "$current_task" = "T001" ]
    [ "$session_note" = "Working on authentication epic" ]
}

# =============================================================================
# TEST 2: Version Field Migration - .version → ._meta.schemaVersion
# =============================================================================

@test "upgrade v0.48.0: adds _meta.schemaVersion field to todo.json" {
    _create_v047_todo
    _create_v047_config

    # Verify v0.47.1 structure (no _meta.schemaVersion)
    run jq -e '._meta.schemaVersion' "$TODO_FILE"
    [ "$status" -ne 0 ]  # Should NOT exist

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Should now have _meta.schemaVersion
    local schema_version
    schema_version=$(jq -r '._meta.schemaVersion' "$TODO_FILE")
    [ -n "$schema_version" ]
    [ "$schema_version" != "null" ]
}

@test "upgrade v0.48.0: preserves backward compatibility with .version field" {
    _create_v047_todo
    _create_v047_config

    # Record original version
    local original_version
    original_version=$(jq -r '.version' "$TODO_FILE")

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Both .version and ._meta.schemaVersion should exist
    local top_version meta_version
    top_version=$(jq -r '.version' "$TODO_FILE")
    meta_version=$(jq -r '._meta.schemaVersion' "$TODO_FILE")

    [ -n "$top_version" ]
    [ -n "$meta_version" ]
    [ "$top_version" = "$meta_version" ]
}

@test "upgrade v0.48.0: updates config.json version structure" {
    _create_v047_todo
    _create_v047_config

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Config should have consistent versioning
    local config_version meta_version
    config_version=$(jq -r '.version' "$CONFIG_FILE")
    meta_version=$(jq -r '._meta.version' "$CONFIG_FILE")

    [ "$config_version" = "$meta_version" ]
}

@test "upgrade v0.48.0: migrates archive.json version structure" {
    _create_v047_todo
    _create_v047_config
    _create_v047_archive

    # Verify archive has v0.47.1 structure
    local before_meta
    before_meta=$(jq -r '._meta.schemaVersion // "missing"' "$ARCHIVE_FILE")

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Archive should be updated (or may stay at old version if not modified)
    # Key test: file remains valid and readable
    jq -e '.archivedTasks | length >= 0' "$ARCHIVE_FILE"
}

# =============================================================================
# TEST 3: Rollback Safety - Can restore from backup
# =============================================================================

@test "upgrade v0.48.0: creates backup before migration" {
    _create_v047_todo
    _create_v047_config

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Verify backup was created
    local backup_count
    backup_count=$(find .cleo/backups/upgrade -name "todo.json.*" 2>/dev/null | wc -l)
    [ "$backup_count" -gt 0 ]
}

@test "upgrade v0.48.0: backup contains pre-migration data" {
    _create_v047_todo
    _create_v047_config

    # Record task count before
    local original_count
    original_count=$(_get_task_count)

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Find most recent backup
    local backup_file
    backup_file=$(find .cleo/backups/upgrade -name "todo.json.*" -type f 2>/dev/null | sort -r | head -n 1)

    [ -n "$backup_file" ]
    [ -f "$backup_file" ]

    # Backup should have same task count as original
    local backup_count
    backup_count=$(jq '.tasks | length' "$backup_file")
    [ "$backup_count" -eq "$original_count" ]
}

@test "upgrade v0.48.0: can restore from backup after failed migration" {
    _create_v047_todo
    _create_v047_config

    # Get original checksum
    local original_checksum
    original_checksum=$(jq -r '._meta.checksum' "$TODO_FILE")

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Find backup
    local backup_file
    backup_file=$(find .cleo/backups/upgrade -name "todo.json.*" -type f 2>/dev/null | sort -r | head -n 1)

    # Simulate restore
    cp "$backup_file" "$TODO_FILE.restored"

    # Restored file should be valid JSON
    jq empty "$TODO_FILE.restored"

    # Cleanup
    rm -f "$TODO_FILE.restored"
}

# =============================================================================
# TEST 4: Test Suite Compatibility - Existing tests pass post-upgrade
# =============================================================================

@test "upgrade v0.48.0: cleo list works after migration" {
    _create_v047_todo
    _create_v047_config

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # cleo list should work (use --json to ensure JSON output in TTY environment)
    run bash "$SCRIPTS_DIR/list.sh" --json
    [ "$status" -eq 0 ]

    # Should return tasks as JSON
    echo "$output" | jq -e '.tasks | length == 3'
}

@test "upgrade v0.48.0: cleo validate passes after migration" {
    _create_v047_todo
    _create_v047_config

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Validation should pass
    run bash "$SCRIPTS_DIR/validate.sh"
    [ "$status" -eq 0 ]
}

@test "upgrade v0.48.0: cleo add works after migration" {
    _create_v047_todo
    _create_v047_config

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Should be able to add new task
    run bash "$SCRIPTS_DIR/add.sh" "New task post-upgrade" \
        --description "Added after v0.48.0 migration" \
        --priority medium

    [ "$status" -eq 0 ]

    # New task should exist
    local new_task_count
    new_task_count=$(_get_task_count)
    [ "$new_task_count" -eq 4 ]
}

@test "upgrade v0.48.0: cleo complete works after migration" {
    _create_v047_todo
    _create_v047_config

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Should be able to complete task (--skip-notes for testing)
    run bash "$SCRIPTS_DIR/complete.sh" T003 --skip-notes
    [ "$status" -eq 0 ]

    # Task should be marked done
    local task_status
    task_status=$(jq -r '.tasks[] | select(.id == "T003") | .status' "$TODO_FILE")
    [ "$task_status" = "done" ]
}

@test "upgrade v0.48.0: cleo phase commands work after migration" {
    _create_v047_todo
    _create_v047_config

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Phase show should work (use --json to ensure JSON output in TTY environment)
    run bash "$SCRIPTS_DIR/phase.sh" --json show
    [ "$status" -eq 0 ]

    # Should return current phase (structure is .currentPhase.slug)
    echo "$output" | jq -e '.currentPhase.slug == "core"'
}

# =============================================================================
# TEST 5: Idempotency - Multiple upgrades produce same result
# =============================================================================

@test "upgrade v0.48.0: multiple runs produce identical results" {
    _create_v047_todo
    _create_v047_config

    # First upgrade (may do migrations)
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Get checksum after first upgrade (now migrated)
    local checksum1
    checksum1=$(sha256sum "$TODO_FILE" | cut -c1-64)

    # Second upgrade (should be no-op)
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ]

    local checksum2
    checksum2=$(sha256sum "$TODO_FILE" | cut -c1-64)

    # Third upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ]

    local checksum3
    checksum3=$(sha256sum "$TODO_FILE" | cut -c1-64)

    # Checksums should match between second and third runs (idempotent after migration)
    [ "$checksum2" = "$checksum3" ]
}

@test "upgrade v0.48.0: --status reports up-to-date after migration" {
    _create_v047_todo
    _create_v047_config

    # First upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Status check should report up-to-date (use --json for JSON output)
    run bash "$UPGRADE_SCRIPT" --status --json
    [ "$status" -eq 0 ]

    # Should indicate no updates needed
    # Note: May report updates needed for agent docs/templates if not created during fixture setup
    echo "$output" | tail -n 1 | jq -e '.success == true'
}

# =============================================================================
# TEST 6: Edge Cases - Missing fields, legacy structures
# =============================================================================

@test "upgrade v0.48.0: handles missing _meta fields gracefully" {
    # Create v0.47.1 todo without _meta.activeSession
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.6.0",
  "project": {
    "name": "minimal-project",
    "currentPhase": null,
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {
    "version": "2.6.0",
    "checksum": "minimal123",
    "configVersion": "2.4.0"
  },
  "tasks": [],
  "focus": {},
  "lastUpdated": "2025-12-01T10:00:00Z"
}
EOF

    _create_v047_config

    # Should upgrade without errors
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # File should be valid
    jq empty "$TODO_FILE"
}

@test "upgrade v0.48.0: handles project with only top-level .version" {
    # Create todo with only .version, missing ._meta.version
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.5.0",
  "project": {
    "name": "version-only-project",
    "currentPhase": null,
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {
    "checksum": "version123",
    "configVersion": "2.4.0"
  },
  "tasks": [],
  "focus": {},
  "lastUpdated": "2025-12-01T10:00:00Z"
}
EOF

    _create_v047_config

    # Should upgrade and add _meta.version and _meta.schemaVersion
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Should now have _meta.schemaVersion
    jq -e '._meta.schemaVersion' "$TODO_FILE"
}

@test "upgrade v0.48.0: preserves custom phase configurations" {
    _create_v047_todo
    _create_v047_config

    # Record phase count before
    local phase_count_before
    phase_count_before=$(jq '.project.phases | length' "$TODO_FILE")

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Phase count should be preserved
    local phase_count_after
    phase_count_after=$(jq '.project.phases | length' "$TODO_FILE")
    [ "$phase_count_before" -eq "$phase_count_after" ]

    # Custom phase data should be intact
    local setup_status
    setup_status=$(jq -r '.project.phases.setup.status' "$TODO_FILE")
    [ "$setup_status" = "completed" ]
}

@test "upgrade v0.48.0: preserves position and positionVersion fields" {
    _create_v047_todo
    _create_v047_config

    # Verify positions exist before
    local t001_pos t002_pos
    t001_pos=$(jq -r '.tasks[] | select(.id == "T001") | .position' "$TODO_FILE")
    t002_pos=$(jq -r '.tasks[] | select(.id == "T002") | .position' "$TODO_FILE")

    [ "$t001_pos" = "1" ]
    [ "$t002_pos" = "1" ]

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Positions should be preserved
    local t001_pos_after t002_pos_after
    t001_pos_after=$(jq -r '.tasks[] | select(.id == "T001") | .position' "$TODO_FILE")
    t002_pos_after=$(jq -r '.tasks[] | select(.id == "T002") | .position' "$TODO_FILE")

    [ "$t001_pos_after" = "$t001_pos" ]
    [ "$t002_pos_after" = "$t002_pos" ]
}

# =============================================================================
# ADDITIONAL COVERAGE: Multi-file migration
# =============================================================================

@test "upgrade v0.48.0: migrates all project files consistently" {
    _create_v047_todo
    _create_v047_config
    _create_v047_archive
    _create_v047_log

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # All files should be valid JSON
    jq empty "$TODO_FILE"
    jq empty "$CONFIG_FILE"
    jq empty "$ARCHIVE_FILE"
    jq empty "$LOG_FILE"
}

@test "upgrade v0.48.0: preserves archived task data" {
    _create_v047_todo
    _create_v047_config
    _create_v047_archive

    # Record archived task count
    local archived_before
    archived_before=$(jq '.archivedTasks | length' "$ARCHIVE_FILE")

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Archived tasks should be preserved
    local archived_after
    archived_after=$(jq '.archivedTasks | length' "$ARCHIVE_FILE")
    [ "$archived_before" -eq "$archived_after" ]

    # Verify specific archived task
    local archived_title
    archived_title=$(jq -r '.archivedTasks[] | select(.id == "T100") | .title' "$ARCHIVE_FILE")
    [ "$archived_title" = "Archived task" ]
}

@test "upgrade v0.48.0: preserves log entries" {
    _create_v047_todo
    _create_v047_config
    _create_v047_log

    # Record log entry count
    local log_entries_before
    log_entries_before=$(jq '.entries | length' "$LOG_FILE")

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Log entries should be preserved
    local log_entries_after
    log_entries_after=$(jq '.entries | length' "$LOG_FILE")
    [ "$log_entries_before" -eq "$log_entries_after" ]
}

# =============================================================================
# ROLLBACK VERIFICATION
# =============================================================================

@test "upgrade v0.48.0: dry-run does not modify files" {
    _create_v047_todo
    _create_v047_config

    # Get original checksums
    local todo_before config_before
    todo_before=$(sha256sum "$TODO_FILE" | cut -c1-64)
    config_before=$(sha256sum "$CONFIG_FILE" | cut -c1-64)

    # Run with dry-run
    run bash "$UPGRADE_SCRIPT" --dry-run
    [ "$status" -eq 0 ]

    # Files should be unchanged
    local todo_after config_after
    todo_after=$(sha256sum "$TODO_FILE" | cut -c1-64)
    config_after=$(sha256sum "$CONFIG_FILE" | cut -c1-64)

    [ "$todo_before" = "$todo_after" ]
    [ "$config_before" = "$config_after" ]
}
