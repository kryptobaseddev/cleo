#!/usr/bin/env bats
# =============================================================================
# test-2.2.0-migration.bats - v2.2.0 migration tests
# =============================================================================
# Tests migration from v2.1.0 to v2.2.0, which converts project field from
# string to object with phases structure.
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    # Source migration library
    source "$LIB_DIR/migrate.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper: Create v2.1.0 fixtures with string project field
# =============================================================================

# Create v2.1.0 todo.json with string project field
create_v2_1_0_todo() {
    local project_name="${1:-test-project}"
    cat > "$TODO_FILE" << EOF
{
  "\$schema": "./schemas/todo.schema.json",
  "version": "2.1.0",
  "project": "$project_name",
  "lastUpdated": "2025-12-15T00:00:00Z",
  "_meta": {
    "version": "2.1.0",
    "checksum": "abc123def456",
    "configVersion": "2.1.0",
    "lastSessionId": null,
    "activeSession": null
  },
  "focus": {
    "currentTask": null,
    "currentPhase": null,
    "blockedUntil": null,
    "sessionNote": null,
    "nextAction": null
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Sample task",
      "description": "Test task for migration",
      "status": "pending",
      "priority": "medium",
      "createdAt": "2025-12-15T00:00:00Z"
    }
  ],
  "labels": {}
}
EOF
}

# Create v2.1.0 todo.json with empty project string
create_v2_1_0_empty_project() {
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.1.0",
  "project": "",
  "lastUpdated": "2025-12-15T00:00:00Z",
  "_meta": {
    "version": "2.1.0",
    "checksum": "test123",
    "configVersion": "2.1.0"
  },
  "focus": {},
  "tasks": [],
  "labels": {}
}
EOF
}

# Create v2.1.0 todo.json with null project (edge case)
create_v2_1_0_null_project() {
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.1.0",
  "project": null,
  "lastUpdated": "2025-12-15T00:00:00Z",
  "_meta": {
    "version": "2.1.0",
    "checksum": "test123",
    "configVersion": "2.1.0"
  },
  "focus": {},
  "tasks": []
}
EOF
}

# Create already-migrated v2.2.0 todo.json (for idempotency tests)
# Uses canonical 5-phase structure
create_v2_2_0_todo() {
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "migrated-project",
    "currentPhase": null,
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup & Foundation",
        "description": "Initial project setup, dependencies, and configuration",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      },
      "core": {
        "order": 2,
        "name": "Core Development",
        "description": "Build core functionality and features",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      },
      "testing": {
        "order": 3,
        "name": "Testing & Validation",
        "description": "Comprehensive testing, validation, and quality assurance",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      },
      "polish": {
        "order": 4,
        "name": "Polish & Refinement",
        "description": "UX improvements, optimization, and release preparation",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      },
      "maintenance": {
        "order": 5,
        "name": "Maintenance",
        "description": "Bug fixes, updates, and ongoing support",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      }
    }
  },
  "lastUpdated": "2025-12-15T00:00:00Z",
  "_meta": {
    "version": "2.2.0",
    "checksum": "test123",
    "configVersion": "2.1.0"
  },
  "focus": {},
  "tasks": []
}
EOF
}

# =============================================================================
# Detection Tests - verify v2.2.0 migration detection
# =============================================================================

@test "detect_file_version identifies v2.1.0 with string project" {
    create_v2_1_0_todo "my-project"

    run detect_file_version "$TODO_FILE"
    assert_success
    assert_output "2.1.0"
}

@test "detect_file_version identifies v2.2.0 with object project" {
    create_v2_2_0_todo

    run detect_file_version "$TODO_FILE"
    assert_success
    assert_output "2.2.0"
}

@test "migration check detects v2.1.0 needs migration" {
    create_v2_1_0_todo "test-project"

    run check_compatibility "$TODO_FILE" "todo"
    # Should return 1 (migration needed)
    assert_equal "$status" "1"
}

@test "migration check detects v2.2.0 is current" {
    create_v2_2_0_todo

    run check_compatibility "$TODO_FILE" "todo"
    # Should return 0 (compatible)
    assert_success
}

@test "show_migration_status shows v2.1.0 needs migration" {
    create_v2_1_0_todo "test-project"

    run show_migration_status "$TEST_TEMP_DIR/.claude"
    assert_success
    assert_output --partial "migration needed"
    assert_output --partial "2.1.0"
    assert_output --partial "2.2.0"
}

# =============================================================================
# Migration Execution Tests
# =============================================================================

@test "migrate_todo_to_2_2_0 converts string project to object" {
    create_v2_1_0_todo "my-awesome-project"

    run migrate_todo_to_2_2_0 "$TODO_FILE"
    assert_success

    # Verify project is now an object
    run jq -r '.project | type' "$TODO_FILE"
    assert_output "object"

    # Verify project name preserved
    run jq -r '.project.name' "$TODO_FILE"
    assert_output "my-awesome-project"
}

@test "migrate_todo_to_2_2_0 creates default phases" {
    create_v2_1_0_todo "test-project"

    migrate_todo_to_2_2_0 "$TODO_FILE"

    # Check all default phases exist (5 canonical phases)
    run jq -r '.project.phases | keys | length' "$TODO_FILE"
    assert_output "5"

    run jq -r '.project.phases | has("setup")' "$TODO_FILE"
    assert_output "true"

    run jq -r '.project.phases | has("core")' "$TODO_FILE"
    assert_output "true"

    run jq -r '.project.phases | has("testing")' "$TODO_FILE"
    assert_output "true"

    run jq -r '.project.phases | has("polish")' "$TODO_FILE"
    assert_output "true"

    run jq -r '.project.phases | has("maintenance")' "$TODO_FILE"
    assert_output "true"
}

@test "migrate_todo_to_2_2_0 sets correct phase properties" {
    create_v2_1_0_todo "test-project"

    migrate_todo_to_2_2_0 "$TODO_FILE"

    # Check setup phase properties
    run jq -r '.project.phases.setup.order' "$TODO_FILE"
    assert_output "1"

    run jq -r '.project.phases.setup.name' "$TODO_FILE"
    assert_output "Setup & Foundation"

    # Setup phase starts as "active" for new projects (from template)
    run jq -r '.project.phases.setup.status' "$TODO_FILE"
    assert_output "active"

    run jq -r '.project.phases.setup.startedAt' "$TODO_FILE"
    assert_output "null"

    run jq -r '.project.phases.setup.completedAt' "$TODO_FILE"
    assert_output "null"

    # Check core phase order
    run jq -r '.project.phases.core.order' "$TODO_FILE"
    assert_output "2"

    # Check testing phase order (new in 5-phase)
    run jq -r '.project.phases.testing.order' "$TODO_FILE"
    assert_output "3"

    # Check polish phase order
    run jq -r '.project.phases.polish.order' "$TODO_FILE"
    assert_output "4"

    # Check maintenance phase order (new in 5-phase)
    run jq -r '.project.phases.maintenance.order' "$TODO_FILE"
    assert_output "5"
}

@test "migrate_todo_to_2_2_0 updates version to 2.2.0" {
    create_v2_1_0_todo "test-project"

    migrate_todo_to_2_2_0 "$TODO_FILE"

    # Check top-level version
    run jq -r '.version' "$TODO_FILE"
    assert_output "2.2.0"

    # Check _meta.version
    run jq -r '._meta.version' "$TODO_FILE"
    assert_output "2.2.0"
}

@test "migrate_todo_to_2_2_0 preserves existing tasks" {
    create_v2_1_0_todo "test-project"

    # Get original task data
    local original_task_id
    original_task_id=$(jq -r '.tasks[0].id' "$TODO_FILE")
    local original_task_title
    original_task_title=$(jq -r '.tasks[0].title' "$TODO_FILE")

    migrate_todo_to_2_2_0 "$TODO_FILE"

    # Verify tasks preserved
    run jq -r '.tasks[0].id' "$TODO_FILE"
    assert_output "$original_task_id"

    run jq -r '.tasks[0].title' "$TODO_FILE"
    assert_output "$original_task_title"

    # Verify task count unchanged
    run jq -r '.tasks | length' "$TODO_FILE"
    assert_output "1"
}

@test "migrate_todo_to_2_2_0 preserves focus state" {
    create_v2_1_0_todo "test-project"

    # Add focus data
    jq '.focus.sessionNote = "Working on something"' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    migrate_todo_to_2_2_0 "$TODO_FILE"

    # Verify focus preserved
    run jq -r '.focus.sessionNote' "$TODO_FILE"
    assert_output "Working on something"
}

@test "migrate_todo_to_2_2_0 preserves labels" {
    create_v2_1_0_todo "test-project"

    # Add labels
    jq '.labels = {"bug": ["T001"], "feature": ["T001"]}' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    migrate_todo_to_2_2_0 "$TODO_FILE"

    # Verify labels preserved
    run jq -r '.labels.bug[0]' "$TODO_FILE"
    assert_output "T001"

    run jq -r '.labels | keys | length' "$TODO_FILE"
    assert_output "2"
}

@test "migrate_todo_to_2_2_0 sets currentPhase to null" {
    create_v2_1_0_todo "test-project"

    migrate_todo_to_2_2_0 "$TODO_FILE"

    run jq -r '.project.currentPhase' "$TODO_FILE"
    assert_output "null"
}

# =============================================================================
# Idempotency Tests - running migration twice should be safe
# =============================================================================

@test "migrate_todo_to_2_2_0 is idempotent - running twice is safe" {
    create_v2_1_0_todo "test-project"

    # Run migration twice
    migrate_todo_to_2_2_0 "$TODO_FILE"
    local first_result
    first_result=$(cat "$TODO_FILE")

    migrate_todo_to_2_2_0 "$TODO_FILE"
    local second_result
    second_result=$(cat "$TODO_FILE")

    # Results should be identical
    assert_equal "$first_result" "$second_result"
}

@test "migrate_todo_to_2_2_0 on v2.2.0 file does not break anything" {
    create_v2_2_0_todo

    # Run migration on already-migrated file
    run migrate_todo_to_2_2_0 "$TODO_FILE"
    assert_success

    # Verify still valid JSON
    run jq empty "$TODO_FILE"
    assert_success

    # Verify project structure intact
    run jq -r '.project | type' "$TODO_FILE"
    assert_output "object"

    # 5 canonical phases should be present
    run jq -r '.project.phases | keys | length' "$TODO_FILE"
    assert_output "5"
}

@test "multiple migrations preserve all phase fields" {
    create_v2_1_0_todo "test-project"

    # Run migration 3 times
    migrate_todo_to_2_2_0 "$TODO_FILE"
    migrate_todo_to_2_2_0 "$TODO_FILE"
    migrate_todo_to_2_2_0 "$TODO_FILE"

    # Verify all required phase fields exist (5 canonical phases)
    for phase in setup core testing polish maintenance; do
        run jq -r ".project.phases.$phase | has(\"order\")" "$TODO_FILE"
        assert_output "true"

        run jq -r ".project.phases.$phase | has(\"name\")" "$TODO_FILE"
        assert_output "true"

        run jq -r ".project.phases.$phase | has(\"status\")" "$TODO_FILE"
        assert_output "true"

        run jq -r ".project.phases.$phase | has(\"startedAt\")" "$TODO_FILE"
        assert_output "true"

        run jq -r ".project.phases.$phase | has(\"completedAt\")" "$TODO_FILE"
        assert_output "true"
    done
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "migration handles empty project string" {
    create_v2_1_0_empty_project

    run migrate_todo_to_2_2_0 "$TODO_FILE"
    assert_success

    # Should convert to object with empty name
    run jq -r '.project.name' "$TODO_FILE"
    assert_output ""

    run jq -r '.project | type' "$TODO_FILE"
    assert_output "object"
}

@test "migration handles null project field" {
    create_v2_1_0_null_project

    # Should handle gracefully (migration only runs on string type)
    run migrate_todo_to_2_2_0 "$TODO_FILE"

    # File should still be valid JSON
    run jq empty "$TODO_FILE"
    assert_success
}

@test "migration handles special characters in project name" {
    create_v2_1_0_todo "project-with-special-chars_123!@#"

    run migrate_todo_to_2_2_0 "$TODO_FILE"
    assert_success

    run jq -r '.project.name' "$TODO_FILE"
    assert_output "project-with-special-chars_123!@#"
}

@test "migration handles unicode in project name" {
    create_v2_1_0_todo "プロジェクト-名前"

    run migrate_todo_to_2_2_0 "$TODO_FILE"
    assert_success

    run jq -r '.project.name' "$TODO_FILE"
    assert_output "プロジェクト-名前"
}

@test "migration handles very long project name" {
    local long_name
    long_name=$(printf 'a%.0s' {1..500})
    create_v2_1_0_todo "$long_name"

    run migrate_todo_to_2_2_0 "$TODO_FILE"
    assert_success

    local result_name
    result_name=$(jq -r '.project.name' "$TODO_FILE")
    assert_equal "$result_name" "$long_name"
}

@test "migration preserves tasks with all statuses" {
    create_v2_1_0_todo "test-project"

    # Add tasks with different statuses
    jq '.tasks = [
        {"id": "T001", "title": "Pending", "description": "Pending task", "status": "pending", "priority": "medium", "createdAt": "2025-12-15T00:00:00Z"},
        {"id": "T002", "title": "Active", "description": "Active task", "status": "active", "priority": "high", "createdAt": "2025-12-15T00:00:00Z"},
        {"id": "T003", "title": "Blocked", "description": "Blocked task", "status": "blocked", "priority": "medium", "createdAt": "2025-12-15T00:00:00Z", "blockedBy": "Waiting"},
        {"id": "T004", "title": "Done", "description": "Done task", "status": "done", "priority": "low", "createdAt": "2025-12-15T00:00:00Z", "completedAt": "2025-12-15T01:00:00Z"}
    ]' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    migrate_todo_to_2_2_0 "$TODO_FILE"

    # Verify all tasks preserved
    run jq -r '.tasks | length' "$TODO_FILE"
    assert_output "4"

    # Verify statuses unchanged
    run jq -r '.tasks[0].status' "$TODO_FILE"
    assert_output "pending"

    run jq -r '.tasks[1].status' "$TODO_FILE"
    assert_output "active"

    run jq -r '.tasks[2].status' "$TODO_FILE"
    assert_output "blocked"

    run jq -r '.tasks[3].status' "$TODO_FILE"
    assert_output "done"
}

@test "migration preserves complex task dependencies" {
    create_v2_1_0_todo "test-project"

    # Add tasks with dependencies
    jq '.tasks = [
        {"id": "T001", "title": "Base", "description": "Base task", "status": "pending", "priority": "high", "createdAt": "2025-12-15T00:00:00Z"},
        {"id": "T002", "title": "Dep1", "description": "Depends on T001", "status": "pending", "priority": "medium", "createdAt": "2025-12-15T00:00:00Z", "depends": ["T001"]},
        {"id": "T003", "title": "Dep2", "description": "Depends on T001 and T002", "status": "pending", "priority": "low", "createdAt": "2025-12-15T00:00:00Z", "depends": ["T001", "T002"]}
    ]' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    migrate_todo_to_2_2_0 "$TODO_FILE"

    # Verify dependencies preserved
    run jq -r '.tasks[1].depends[0]' "$TODO_FILE"
    assert_output "T001"

    run jq -r '.tasks[2].depends | length' "$TODO_FILE"
    assert_output "2"

    run jq -r '.tasks[2].depends | contains(["T001", "T002"])' "$TODO_FILE"
    assert_output "true"
}

# =============================================================================
# Integration with migrate_file
# =============================================================================

@test "migrate_file executes v2.2.0 migration" {
    create_v2_1_0_todo "integration-test"

    run migrate_file "$TODO_FILE" "todo" "2.1.0" "2.2.0"
    assert_success

    # Verify migration completed
    run jq -r '.version' "$TODO_FILE"
    assert_output "2.2.0"

    run jq -r '.project | type' "$TODO_FILE"
    assert_output "object"
}

@test "ensure_compatible_version triggers v2.2.0 migration" {
    create_v2_1_0_todo "compatibility-test"

    run ensure_compatible_version "$TODO_FILE" "todo"
    assert_success
    assert_output --partial "Migration"

    # Verify migrated
    run jq -r '.version' "$TODO_FILE"
    assert_output "2.2.0"
}

# =============================================================================
# Rollback Capability Tests
# =============================================================================

@test "migration creates backup before migrating" {
    create_v2_1_0_todo "backup-test"

    # Track backup directory
    local backup_dir="${TEST_TEMP_DIR}/.cleo/backups"
    mkdir -p "$backup_dir"

    migrate_file "$TODO_FILE" "todo" "2.1.0" "2.2.0"

    # Verify backup was created (output mentions backup)
    # Note: actual backup location depends on backup_file implementation
}

@test "failed migration can be rolled back" {
    create_v2_1_0_todo "rollback-test"

    # Create backup manually
    local backup_file="${TODO_FILE}.backup"
    cp "$TODO_FILE" "$backup_file"

    # Corrupt the file mid-migration (simulate failure)
    echo "CORRUPT" > "$TODO_FILE"

    # Restore from backup
    run restore_file "$backup_file" "$TODO_FILE"
    assert_success

    # Verify restored
    run jq -r '.version' "$TODO_FILE"
    assert_output "2.1.0"

    run jq -r '.project | type' "$TODO_FILE"
    assert_output "string"
}

@test "migration preserves pre-migration state in backup" {
    create_v2_1_0_todo "state-preservation"

    local pre_migration_content
    pre_migration_content=$(cat "$TODO_FILE")

    # Create backup
    local backup_file="${TODO_FILE}.pre-migration"
    cp "$TODO_FILE" "$backup_file"

    migrate_todo_to_2_2_0 "$TODO_FILE"

    # Verify backup has old format
    run jq -r '.project | type' "$backup_file"
    assert_output "string"

    run jq -r '.version' "$backup_file"
    assert_output "2.1.0"
}

# =============================================================================
# JSON Validity Tests
# =============================================================================

@test "migrated file is valid JSON" {
    create_v2_1_0_todo "json-validity"

    migrate_todo_to_2_2_0 "$TODO_FILE"

    run jq empty "$TODO_FILE"
    assert_success
}

@test "migration produces properly formatted JSON" {
    create_v2_1_0_todo "formatting-test"

    migrate_todo_to_2_2_0 "$TODO_FILE"

    # Verify JSON can be parsed and reformatted
    run jq '.' "$TODO_FILE"
    assert_success

    # Verify key structure exists
    run jq 'has("version")' "$TODO_FILE"
    assert_output "true"

    run jq 'has("project")' "$TODO_FILE"
    assert_output "true"

    run jq 'has("tasks")' "$TODO_FILE"
    assert_output "true"

    run jq 'has("_meta")' "$TODO_FILE"
    assert_output "true"
}

@test "migration maintains JSON schema compliance" {
    create_v2_1_0_todo "schema-compliance"

    migrate_todo_to_2_2_0 "$TODO_FILE"

    # Verify required top-level fields
    run jq 'has("version") and has("project") and has("lastUpdated") and has("tasks") and has("_meta")' "$TODO_FILE"
    assert_output "true"

    # Verify project structure
    run jq '.project | has("name") and has("phases")' "$TODO_FILE"
    assert_output "true"
}

# =============================================================================
# Performance Tests
# =============================================================================

@test "migration handles large number of tasks" {
    create_v2_1_0_todo "large-dataset"

    # Add 100 tasks
    local tasks='[]'
    for i in {1..100}; do
        local task_id
        task_id=$(printf "T%03d" "$i")
        tasks=$(echo "$tasks" | jq --arg id "$task_id" \
            '. += [{"id": $id, "title": ("Task " + $id), "description": "Test", "status": "pending", "priority": "medium", "createdAt": "2025-12-15T00:00:00Z"}]')
    done
    jq --argjson tasks "$tasks" '.tasks = $tasks' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    run migrate_todo_to_2_2_0 "$TODO_FILE"
    assert_success

    # Verify all tasks preserved
    run jq -r '.tasks | length' "$TODO_FILE"
    assert_output "100"

    # Verify migration successful
    run jq -r '.version' "$TODO_FILE"
    assert_output "2.2.0"
}
