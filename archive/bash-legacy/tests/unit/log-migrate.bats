#!/usr/bin/env bats
# Test suite for log migration (claude-todo log migrate)

# =============================================================================
# File-Level Setup (runs once per test file)
# =============================================================================
setup_file() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_file
}

# =============================================================================
# Per-Test Setup (runs before each test)
# =============================================================================
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

# ============================================================================
# Basic Migration Tests
# ============================================================================

@test "migrate: successfully migrates old schema entries" {
  # Create log file with old schema entries
  cat > .cleo/todo-log.json << 'EOF'
{
  "version": "2.1.0",
  "project": "test-project",
  "_meta": {
    "totalEntries": 3,
    "firstEntry": "2025-12-13T07:00:00Z",
    "lastEntry": "2025-12-13T07:02:00Z",
    "entriesPruned": 0
  },
  "entries": [
    {
      "id": "log-001",
      "timestamp": "2025-12-13T07:00:00Z",
      "operation": "create",
      "task_id": "T001",
      "user": "system",
      "details": {"title": "Test task"},
      "before": null,
      "after": {"title": "Test task", "status": "pending"}
    },
    {
      "id": "log-002",
      "timestamp": "2025-12-13T07:01:00Z",
      "operation": "update",
      "task_id": "T001",
      "user": "claude",
      "details": {"field": "priority"},
      "before": {"priority": "medium"},
      "after": {"priority": "high"}
    },
    {
      "id": "log-003",
      "timestamp": "2025-12-13T07:02:00Z",
      "operation": "system_initialized",
      "task_id": null,
      "user": "system",
      "details": "System started",
      "before": null,
      "after": null
    }
  ]
}
EOF

  run bash "$LOG_SCRIPT" migrate
  assert_success
  assert_output --partial "Found 3 entries to migrate"
  assert_output --partial "Successfully migrated 3 entries"

  # Verify no old schema fields remain
  run jq '[.entries[] | select(has("operation"))] | length' .cleo/todo-log.json
  assert_output "0"

  # Verify new schema fields exist
  run jq '[.entries[] | select(has("action") and has("actor") and has("taskId"))] | length' .cleo/todo-log.json
  assert_output "3"

  # Verify action value mapping
  run jq '.entries[0].action' .cleo/todo-log.json
  assert_output '"task_created"'

  run jq '.entries[1].action' .cleo/todo-log.json
  assert_output '"task_updated"'

  run jq '.entries[2].action' .cleo/todo-log.json
  assert_output '"config_changed"'

  # Verify actor mapping
  run jq '.entries[0].actor' .cleo/todo-log.json
  assert_output '"system"'

  run jq '.entries[1].actor' .cleo/todo-log.json
  assert_output '"claude"'

  # Verify taskId mapping
  run jq '.entries[0].taskId' .cleo/todo-log.json
  assert_output '"T001"'

  run jq '.entries[2].taskId' .cleo/todo-log.json
  assert_output "null"
}

@test "migrate: preserves all data during migration" {
  # Create log with detailed data
  cat > .cleo/todo-log.json << 'EOF'
{
  "version": "2.1.0",
  "project": "test-project",
  "_meta": {
    "totalEntries": 1,
    "firstEntry": "2025-12-13T07:00:00Z",
    "lastEntry": "2025-12-13T07:00:00Z"
  },
  "entries": [
    {
      "id": "log-001",
      "timestamp": "2025-12-13T07:00:00Z",
      "sessionId": "session-123",
      "operation": "create",
      "task_id": "T001",
      "user": "claude",
      "details": {
        "title": "Complex task",
        "nested": {"data": "value"}
      },
      "before": null,
      "after": {
        "title": "Complex task",
        "status": "pending",
        "priority": "high"
      }
    }
  ]
}
EOF

  run bash "$LOG_SCRIPT" migrate
  assert_success

  # Verify all fields preserved
  run jq '.entries[0].id' .cleo/todo-log.json
  assert_output '"log-001"'

  run jq '.entries[0].timestamp' .cleo/todo-log.json
  assert_output '"2025-12-13T07:00:00Z"'

  run jq '.entries[0].sessionId' .cleo/todo-log.json
  assert_output '"session-123"'

  run jq '.entries[0].details.nested.data' .cleo/todo-log.json
  assert_output '"value"'

  run jq '.entries[0].after.priority' .cleo/todo-log.json
  assert_output '"high"'
}

@test "migrate: creates backup before migration" {
  # Create simple log
  cat > .cleo/todo-log.json << 'EOF'
{
  "version": "2.1.0",
  "project": "test-project",
  "_meta": {"totalEntries": 1, "firstEntry": null, "lastEntry": null},
  "entries": [
    {
      "id": "log-001",
      "timestamp": "2025-12-13T07:00:00Z",
      "operation": "create",
      "task_id": "T001",
      "user": "system",
      "details": null,
      "before": null,
      "after": null
    }
  ]
}
EOF

  run bash "$LOG_SCRIPT" migrate
  assert_success
  assert_output --partial "Created backup:"

  # Verify backup exists
  run bash -c 'ls -1 .cleo/todo-log.json.pre-migration.* | wc -l'
  assert_output --partial "1"

  # Verify backup contains old schema
  local backup_file
  backup_file=$(ls .cleo/todo-log.json.pre-migration.* | head -1)
  run jq '[.entries[] | select(has("operation"))] | length' "$backup_file"
  assert_output "1"
}

@test "migrate: idempotent - safe to run multiple times" {
  # Create log with old schema
  cat > .cleo/todo-log.json << 'EOF'
{
  "version": "2.1.0",
  "project": "test-project",
  "_meta": {"totalEntries": 1, "firstEntry": null, "lastEntry": null},
  "entries": [
    {
      "id": "log-001",
      "timestamp": "2025-12-13T07:00:00Z",
      "operation": "create",
      "task_id": "T001",
      "user": "system",
      "details": null,
      "before": null,
      "after": null
    }
  ]
}
EOF

  # First migration
  run bash "$LOG_SCRIPT" migrate
  assert_success
  assert_output --partial "Successfully migrated 1 entries"

  # Second migration (should be no-op)
  run bash "$LOG_SCRIPT" migrate
  assert_success
  assert_output --partial "No entries need migration"

  # Verify only one entry exists
  run jq '.entries | length' .cleo/todo-log.json
  assert_output "1"

  # Verify new schema
  run jq '.entries[0].action' .cleo/todo-log.json
  assert_output '"task_created"'
}

@test "migrate: handles empty log file" {
  # Create empty log
  cat > .cleo/todo-log.json << 'EOF'
{
  "version": "2.1.0",
  "project": "test-project",
  "_meta": {
    "totalEntries": 0,
    "firstEntry": null,
    "lastEntry": null
  },
  "entries": []
}
EOF

  run bash "$LOG_SCRIPT" migrate
  assert_success
  assert_output --partial "No entries need migration"
}

@test "migrate: handles mixed old and new schema entries" {
  # Create log with both schemas
  cat > .cleo/todo-log.json << 'EOF'
{
  "version": "2.1.0",
  "project": "test-project",
  "_meta": {"totalEntries": 3, "firstEntry": null, "lastEntry": null},
  "entries": [
    {
      "id": "log-001",
      "timestamp": "2025-12-13T07:00:00Z",
      "operation": "create",
      "task_id": "T001",
      "user": "system",
      "details": null,
      "before": null,
      "after": null
    },
    {
      "id": "log-002",
      "timestamp": "2025-12-13T07:01:00Z",
      "sessionId": null,
      "action": "task_updated",
      "actor": "claude",
      "taskId": "T001",
      "before": null,
      "after": null,
      "details": null
    },
    {
      "id": "log-003",
      "timestamp": "2025-12-13T07:02:00Z",
      "operation": "update",
      "task_id": "T002",
      "user": "claude",
      "details": null,
      "before": null,
      "after": null
    }
  ]
}
EOF

  run bash "$LOG_SCRIPT" migrate
  assert_success
  assert_output --partial "Found 2 entries to migrate"

  # Verify all entries now use new schema
  run jq '[.entries[] | select(has("action"))] | length' .cleo/todo-log.json
  assert_output "3"

  run jq '[.entries[] | select(has("operation"))] | length' .cleo/todo-log.json
  assert_output "0"
}

# ============================================================================
# Error Handling Tests
# ============================================================================

@test "migrate: fails gracefully if log file doesn't exist" {
  rm -f .cleo/todo-log.json

  run bash "$LOG_SCRIPT" migrate
  assert_failure
  assert_output --partial "does not exist"
}

@test "migrate: validates JSON after migration" {
  # This is implicitly tested by all successful migrations
  # as they all call jq to validate the result
  cat > .cleo/todo-log.json << 'EOF'
{
  "version": "2.1.0",
  "project": "test-project",
  "_meta": {"totalEntries": 1, "firstEntry": null, "lastEntry": null},
  "entries": [
    {
      "id": "log-001",
      "timestamp": "2025-12-13T07:00:00Z",
      "operation": "create",
      "task_id": "T001",
      "user": "system",
      "details": null,
      "before": null,
      "after": null
    }
  ]
}
EOF

  run bash "$LOG_SCRIPT" migrate
  assert_success

  # Verify result is valid JSON
  run jq empty .cleo/todo-log.json
  assert_success
}

# ============================================================================
# Integration Tests
# ============================================================================

@test "migrate: works with actual log structure from fixtures" {
  # Test with realistic log data
  cat > .cleo/todo-log.json << 'EOF'
{
  "version": "2.1.0",
  "project": "claude-todo",
  "_meta": {
    "totalEntries": 5,
    "firstEntry": "2025-12-13T07:00:00Z",
    "lastEntry": "2025-12-13T07:04:00Z"
  },
  "entries": [
    {
      "id": "log-1765610263-e85aba",
      "timestamp": "2025-12-13T07:00:00Z",
      "operation": "create",
      "task_id": "T001",
      "user": "system",
      "details": {"title": "Test task", "status": "pending", "priority": "medium"},
      "before": null,
      "after": {"title": "Test task", "status": "pending", "priority": "medium"}
    },
    {
      "id": "log-1765610326-330a76",
      "timestamp": "2025-12-13T07:01:00Z",
      "operation": "create",
      "task_id": "T002",
      "user": "system",
      "details": {"title": "Verify format field"},
      "before": null,
      "after": {"title": "Verify format field", "status": "pending"}
    },
    {
      "id": "log_383efdffcc0f",
      "timestamp": "2025-12-13T07:02:00Z",
      "sessionId": null,
      "action": "session_start",
      "actor": "system",
      "taskId": null,
      "before": null,
      "after": null,
      "details": "Session started"
    },
    {
      "id": "log-1765610500-abc123",
      "timestamp": "2025-12-13T07:03:00Z",
      "operation": "status_changed",
      "task_id": "T001",
      "user": "claude",
      "details": null,
      "before": {"status": "pending"},
      "after": {"status": "active"}
    },
    {
      "id": "log_999efdffcc0f",
      "timestamp": "2025-12-13T07:04:00Z",
      "sessionId": "session-123",
      "action": "task_archived",
      "actor": "system",
      "taskId": "T999",
      "before": null,
      "after": null,
      "details": null
    }
  ]
}
EOF

  run bash "$LOG_SCRIPT" migrate
  assert_success

  # Should migrate 3 old schema entries
  assert_output --partial "Found 3 entries to migrate"

  # Verify all 5 entries now use new schema
  run jq '.entries | length' .cleo/todo-log.json
  assert_output "5"

  run jq '[.entries[] | select(has("action"))] | length' .cleo/todo-log.json
  assert_output "5"

  run jq '[.entries[] | select(has("operation"))] | length' .cleo/todo-log.json
  assert_output "0"
}
