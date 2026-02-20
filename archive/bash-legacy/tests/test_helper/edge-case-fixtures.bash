#!/usr/bin/env bash
# =============================================================================
# edge-case-fixtures.bash - Edge case test data generators
# =============================================================================
# Fixtures for testing error conditions, recovery, and edge cases.
# =============================================================================

# Create duplicate ID todo (invalid state)
create_duplicate_id_todo() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "_meta": {"version": "2.1.0", "checksum": "invalid"},
  "tasks": [
    {
      "id": "T001",
      "title": "First task",
      "description": "First",
      "status": "pending",
      "priority": "medium",
      "createdAt": "2025-12-01T10:00:00Z"
    },
    {
      "id": "T001",
      "title": "Duplicate ID task",
      "description": "Duplicate",
      "status": "pending",
      "priority": "high",
      "createdAt": "2025-12-01T11:00:00Z"
    }
  ],
  "focus": {},
  "lastUpdated": "2025-12-01T11:00:00Z"
}
EOF
}

# Create task with dependency (for testing orphaned dependency cleanup)
create_task_with_dependency() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "_meta": {"version": "2.1.0", "checksum": "test123"},
  "tasks": [
    {
      "id": "T001",
      "title": "Dependency task",
      "description": "Will be archived",
      "status": "pending",
      "priority": "high",
      "createdAt": "2025-12-01T10:00:00Z"
    },
    {
      "id": "T002",
      "title": "Dependent task",
      "description": "Depends on T001",
      "status": "pending",
      "priority": "medium",
      "createdAt": "2025-12-01T11:00:00Z",
      "depends": ["T001"]
    }
  ],
  "focus": {},
  "lastUpdated": "2025-12-01T11:00:00Z"
}
EOF
}

# Create multiple completed tasks for archive testing
create_completed_tasks() {
    local count="${1:-10}"
    local dest="${2:-$TODO_FILE}"

    cat > "$dest" << 'EOF'
{
  "_meta": {"version": "2.1.0", "checksum": "test123"},
  "tasks": [
EOF

    for i in $(seq 1 "$count"); do
        local id_num=$(printf "%03d" "$i")
        cat >> "$dest" << EOF
    {
      "id": "T${id_num}",
      "title": "Completed task ${i}",
      "description": "Task number ${i}",
      "status": "done",
      "priority": "medium",
      "createdAt": "2025-12-01T10:00:00Z",
      "completedAt": "2025-12-10T12:00:00Z"
    }$([ "$i" -lt "$count" ] && echo ",")
EOF
    done

    cat >> "$dest" << 'EOF'
  ],
  "focus": {},
  "lastUpdated": "2025-12-10T12:00:00Z"
}
EOF
}

# Create todo with corrupted checksum
create_corrupted_checksum_todo() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "_meta": {"schemaVersion": "2.8.0", "checksum": "invalid_checksum_12345"},
  "tasks": [
    {
      "id": "T001",
      "title": "Valid task",
      "description": "Task with corrupted checksum",
      "status": "pending",
      "priority": "medium",
      "size": "medium",
      "createdAt": "2025-12-01T10:00:00Z"
    }
  ],
  "focus": {},
  "lastUpdated": "2025-12-01T10:00:00Z"
}
EOF
}

# Create standard tasks for testing (various states)
create_standard_tasks() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "_meta": {"version": "2.1.0", "checksum": "test123"},
  "tasks": [
    {
      "id": "T001",
      "title": "Pending task",
      "description": "Ready to work",
      "status": "pending",
      "priority": "high",
      "createdAt": "2025-12-01T10:00:00Z"
    },
    {
      "id": "T002",
      "title": "Active task",
      "description": "Currently working",
      "status": "active",
      "priority": "critical",
      "createdAt": "2025-12-01T11:00:00Z"
    },
    {
      "id": "T003",
      "title": "Blocked task",
      "description": "Waiting for T001",
      "status": "blocked",
      "priority": "medium",
      "createdAt": "2025-12-01T12:00:00Z",
      "depends": ["T001"],
      "blockedBy": "Waiting for T001"
    }
  ],
  "focus": {
    "currentTask": "T002",
    "sessionNote": "Working on active task"
  },
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF
}

# Create task with specific ID (utility function)
create_task_with_id() {
    local id="$1"
    local title="$2"
    local status="${3:-pending}"
    local dest="${4:-$TODO_FILE}"

    cat > "$dest" << EOF
{
  "_meta": {"version": "2.1.0", "checksum": "test123"},
  "tasks": [
    {
      "id": "$id",
      "title": "$title",
      "description": "$title description",
      "status": "$status",
      "priority": "medium",
      "createdAt": "2025-12-01T10:00:00Z"
    }
  ],
  "focus": {},
  "lastUpdated": "2025-12-01T10:00:00Z"
}
EOF
}

# Create empty archive file
create_empty_archive() {
    local dest="${1:-$ARCHIVE_FILE}"
    cat > "$dest" << 'EOF'
{
  "_meta": {"version": "2.1.0", "checksum": "test123"},
  "archivedTasks": [],
  "lastArchived": null
}
EOF
}

# Create malformed JSON (for validation testing)
create_malformed_json() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "_meta": {"version": "2.1.0"},
  "tasks": [
    {
      "id": "T001",
      "title": "Broken task"
      "status": "pending"
    }
  ]
EOF
    # Note: intentionally missing closing brace
}

# Create task with future timestamps (invalid)
create_future_timestamp_task() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "_meta": {"version": "2.1.0"},
  "tasks": [
    {
      "id": "T001",
      "title": "Future task",
      "description": "Task from the future",
      "status": "pending",
      "priority": "medium",
      "createdAt": "2099-12-31T23:59:59Z"
    }
  ],
  "focus": {},
  "lastUpdated": "2025-12-01T10:00:00Z"
}
EOF
}

# Create session state for testing
create_active_session() {
    local log_file="${1:-$LOG_FILE}"
    cat > "$log_file" << 'EOF'
{
  "_meta": {"version": "2.1.0"},
  "entries": [
    {
      "timestamp": "2025-12-01T10:00:00Z",
      "action": "session_start",
      "sessionId": "test_session_123",
      "message": "Session started"
    }
  ]
}
EOF
}
