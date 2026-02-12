#!/usr/bin/env bats
# =============================================================================
# changelog-association.bats - Unit tests for task association logic
# =============================================================================
# Tests populate_release_tasks() function from lib/ui/changelog.sh
# Validates hybrid date+label discovery, epic exclusion, edge cases
#
# Task: T2622
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    common_setup_per_test

    # Determine project root from test file location
    TEST_FILE_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
    PROJECT_ROOT="$(cd "$TEST_FILE_DIR/../.." && pwd)"

    # Source required libraries
    source "$PROJECT_ROOT/lib/core/exit-codes.sh"
    source "$PROJECT_ROOT/lib/core/platform-compat.sh"
    source "$PROJECT_ROOT/lib/ui/changelog.sh"

    # Use BATS-managed temp directory (auto-cleaned)
    TEST_DIR="${BATS_TEST_TMPDIR}"
    CLEO_DIR="$TEST_DIR/.cleo"
    mkdir -p "$CLEO_DIR"

    # Set environment variables
    export TODO_FILE="$CLEO_DIR/todo.json"
    export CHANGELOG_FILE="$TEST_DIR/CHANGELOG.md"
}

teardown() {
    common_teardown
}

# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

# Create test todo.json with sample data
create_test_todo() {
    cat > "$TODO_FILE" << 'EOF'
{
  "tasks": [
    {
      "id": "T001",
      "title": "Feature task",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-15T10:00:00Z",
      "labels": ["v0.65.0", "feature"]
    },
    {
      "id": "T002",
      "title": "Bug fix task",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-16T12:00:00Z",
      "labels": ["changelog", "fix"]
    },
    {
      "id": "T003",
      "title": "Epic should be excluded",
      "type": "epic",
      "status": "done",
      "completedAt": "2026-01-17T14:00:00Z",
      "labels": ["v0.65.0"]
    },
    {
      "id": "T004",
      "title": "Task without labels",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-18T16:00:00Z",
      "labels": []
    },
    {
      "id": "T005",
      "title": "Task before window",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-01T08:00:00Z",
      "labels": ["v0.65.0"]
    },
    {
      "id": "T006",
      "title": "Task after window",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-25T20:00:00Z",
      "labels": ["v0.65.0"]
    },
    {
      "id": "T007",
      "title": "Pending task",
      "type": "task",
      "status": "pending",
      "labels": ["v0.65.0"]
    },
    {
      "id": "T008",
      "title": "Release label task",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-19T10:00:00Z",
      "labels": ["release"]
    }
  ],
  "project": {
    "releases": [
      {
        "version": "v0.64.0",
        "releasedAt": "2026-01-10T00:00:00Z",
        "tasks": []
      },
      {
        "version": "v0.65.0",
        "releasedAt": "2026-01-20T00:00:00Z",
        "tasks": []
      }
    ]
  }
}
EOF
}

# =============================================================================
# TESTS: Basic Functionality
# =============================================================================

@test "populate_release_tasks should discover tasks in date window with version label" {
    create_test_todo

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # Check that tasks array was populated
    local task_count
    task_count=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | length' "$TODO_FILE")

    # Should find T001 (has v0.65.0 label, in window)
    # Should find T002 (has changelog label, in window)
    # Should find T008 (has release label, in window)
    # Should NOT find T003 (epic)
    # Should NOT find T004 (no relevant labels)
    # Should NOT find T005 (before window)
    # Should NOT find T006 (after window)
    # Should NOT find T007 (pending, no completedAt)
    [[ "$task_count" -eq 3 ]]
}

@test "populate_release_tasks should find tasks with normalized version (no v prefix)" {
    create_test_todo

    run populate_release_tasks "0.65.0" "$TODO_FILE"
    assert_success

    local task_count
    task_count=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | length' "$TODO_FILE")
    [[ "$task_count" -eq 3 ]]
}

@test "populate_release_tasks should exclude epics" {
    create_test_todo

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # Verify T003 (epic) is NOT in the list
    local has_epic
    has_epic=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | index("T003")' "$TODO_FILE")
    [[ "$has_epic" == "null" ]]
}

@test "populate_release_tasks should include tasks with changelog label" {
    create_test_todo

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # Verify T002 (changelog label) is in the list
    local has_changelog_task
    has_changelog_task=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | index("T002")' "$TODO_FILE")
    [[ "$has_changelog_task" != "null" ]]
}

@test "populate_release_tasks should include tasks with release label" {
    create_test_todo

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # Verify T008 (release label) is in the list
    local has_release_task
    has_release_task=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | index("T008")' "$TODO_FILE")
    [[ "$has_release_task" != "null" ]]
}

# =============================================================================
# TESTS: Date Window Filtering
# =============================================================================

@test "populate_release_tasks should exclude tasks before date window" {
    create_test_todo

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # Verify T005 (before window) is NOT in the list
    local has_early_task
    has_early_task=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | index("T005")' "$TODO_FILE")
    [[ "$has_early_task" == "null" ]]
}

@test "populate_release_tasks should exclude tasks after date window" {
    create_test_todo

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # Verify T006 (after window) is NOT in the list
    local has_late_task
    has_late_task=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | index("T006")' "$TODO_FILE")
    [[ "$has_late_task" == "null" ]]
}

@test "populate_release_tasks should handle tasks at exact boundary timestamps" {
    # Create test data with exact boundary matches
    cat > "$TODO_FILE" << 'EOF'
{
  "tasks": [
    {
      "id": "T100",
      "title": "Task at prev release time",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-10T00:00:00Z",
      "labels": ["v0.65.0"]
    },
    {
      "id": "T101",
      "title": "Task at current release time",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-20T00:00:00Z",
      "labels": ["v0.65.0"]
    }
  ],
  "project": {
    "releases": [
      {
        "version": "v0.64.0",
        "releasedAt": "2026-01-10T00:00:00Z",
        "tasks": []
      },
      {
        "version": "v0.65.0",
        "releasedAt": "2026-01-20T00:00:00Z",
        "tasks": []
      }
    ]
  }
}
EOF

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # Should include both boundary tasks (>= prev, <= current)
    local task_count
    task_count=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | length' "$TODO_FILE")
    [[ "$task_count" -eq 2 ]]
}

# =============================================================================
# TESTS: Label Filtering
# =============================================================================

@test "populate_release_tasks should require relevant labels" {
    create_test_todo

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # Verify T004 (no relevant labels) is NOT in the list
    local has_unlabeled
    has_unlabeled=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | index("T004")' "$TODO_FILE")
    [[ "$has_unlabeled" == "null" ]]
}

@test "populate_release_tasks should accept version with or without v prefix in labels" {
    cat > "$TODO_FILE" << 'EOF'
{
  "tasks": [
    {
      "id": "T200",
      "title": "Task with v prefix",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-15T10:00:00Z",
      "labels": ["v0.65.0"]
    },
    {
      "id": "T201",
      "title": "Task without v prefix",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-15T11:00:00Z",
      "labels": ["0.65.0"]
    }
  ],
  "project": {
    "releases": [
      {
        "version": "v0.65.0",
        "releasedAt": "2026-01-20T00:00:00Z",
        "tasks": []
      }
    ]
  }
}
EOF

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # Both should be found
    local task_count
    task_count=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | length' "$TODO_FILE")
    [[ "$task_count" -eq 2 ]]
}

# =============================================================================
# TESTS: Edge Cases
# =============================================================================

@test "populate_release_tasks should handle missing completedAt field" {
    create_test_todo

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # Verify T007 (pending, no completedAt) is NOT in the list
    local has_pending
    has_pending=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | index("T007")' "$TODO_FILE")
    [[ "$has_pending" == "null" ]]
}

@test "populate_release_tasks should error on non-existent version" {
    create_test_todo

    run populate_release_tasks "v0.99.0" "$TODO_FILE"
    assert_failure
    assert_output --partial "ERROR: Release v0.99.0 not found"
}

@test "populate_release_tasks should handle empty labels array" {
    cat > "$TODO_FILE" << 'EOF'
{
  "tasks": [
    {
      "id": "T300",
      "title": "Task with empty labels",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-15T10:00:00Z",
      "labels": []
    }
  ],
  "project": {
    "releases": [
      {
        "version": "v0.65.0",
        "releasedAt": "2026-01-20T00:00:00Z",
        "tasks": []
      }
    ]
  }
}
EOF

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # Should find 0 tasks (no relevant labels)
    local task_count
    task_count=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | length' "$TODO_FILE")
    [[ "$task_count" -eq 0 ]]
}

@test "populate_release_tasks should handle missing labels field" {
    cat > "$TODO_FILE" << 'EOF'
{
  "tasks": [
    {
      "id": "T400",
      "title": "Task without labels field",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-15T10:00:00Z"
    }
  ],
  "project": {
    "releases": [
      {
        "version": "v0.65.0",
        "releasedAt": "2026-01-20T00:00:00Z",
        "tasks": []
      }
    ]
  }
}
EOF

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # Should handle missing labels gracefully (no relevant labels = not included)
    local task_count
    task_count=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | length' "$TODO_FILE")
    [[ "$task_count" -eq 0 ]]
}

@test "populate_release_tasks should handle first release (no previous release)" {
    cat > "$TODO_FILE" << 'EOF'
{
  "tasks": [
    {
      "id": "T500",
      "title": "Task for first release",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-01T10:00:00Z",
      "labels": ["v0.1.0"]
    }
  ],
  "project": {
    "releases": [
      {
        "version": "v0.1.0",
        "releasedAt": "2026-01-05T00:00:00Z",
        "tasks": []
      }
    ]
  }
}
EOF

    run populate_release_tasks "v0.1.0" "$TODO_FILE"
    assert_success

    # Should find task (uses epoch as fallback)
    local task_count
    task_count=$(jq -r '.project.releases[] | select(.version == "v0.1.0") | .tasks | length' "$TODO_FILE")
    [[ "$task_count" -eq 1 ]]
}

# =============================================================================
# TESTS: Type Filtering
# =============================================================================

@test "populate_release_tasks should include subtasks if they have labels" {
    cat > "$TODO_FILE" << 'EOF'
{
  "tasks": [
    {
      "id": "T600",
      "title": "Subtask with label",
      "type": "subtask",
      "status": "done",
      "completedAt": "2026-01-15T10:00:00Z",
      "labels": ["v0.65.0"]
    }
  ],
  "project": {
    "releases": [
      {
        "version": "v0.65.0",
        "releasedAt": "2026-01-20T00:00:00Z",
        "tasks": []
      }
    ]
  }
}
EOF

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # Should include subtask
    local has_subtask
    has_subtask=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | index("T600")' "$TODO_FILE")
    [[ "$has_subtask" != "null" ]]
}

@test "populate_release_tasks should exclude only epics, not all parent tasks" {
    cat > "$TODO_FILE" << 'EOF'
{
  "tasks": [
    {
      "id": "T700",
      "title": "Regular task",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-15T10:00:00Z",
      "labels": ["v0.65.0"]
    },
    {
      "id": "T701",
      "title": "Epic task",
      "type": "epic",
      "status": "done",
      "completedAt": "2026-01-15T11:00:00Z",
      "labels": ["v0.65.0"]
    }
  ],
  "project": {
    "releases": [
      {
        "version": "v0.65.0",
        "releasedAt": "2026-01-20T00:00:00Z",
        "tasks": []
      }
    ]
  }
}
EOF

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # Should find only T700 (task), not T701 (epic)
    local task_ids
    task_ids=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | join(",")' "$TODO_FILE")
    [[ "$task_ids" == "T700" ]]
}

# =============================================================================
# TESTS: Multiple Releases
# =============================================================================

@test "populate_release_tasks should only update specified release" {
    cat > "$TODO_FILE" << 'EOF'
{
  "tasks": [
    {
      "id": "T800",
      "title": "Task for v0.65.0",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-15T10:00:00Z",
      "labels": ["v0.65.0"]
    },
    {
      "id": "T801",
      "title": "Task for v0.66.0",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-25T10:00:00Z",
      "labels": ["v0.66.0"]
    }
  ],
  "project": {
    "releases": [
      {
        "version": "v0.65.0",
        "releasedAt": "2026-01-20T00:00:00Z",
        "tasks": []
      },
      {
        "version": "v0.66.0",
        "releasedAt": "2026-01-30T00:00:00Z",
        "tasks": ["existing"]
      }
    ]
  }
}
EOF

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # v0.65.0 should have T800
    local v65_tasks
    v65_tasks=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | join(",")' "$TODO_FILE")
    [[ "$v65_tasks" == "T800" ]]

    # v0.66.0 should still have "existing"
    local v66_tasks
    v66_tasks=$(jq -r '.project.releases[] | select(.version == "v0.66.0") | .tasks | join(",")' "$TODO_FILE")
    [[ "$v66_tasks" == "existing" ]]
}

# =============================================================================
# TESTS: Data Integrity
# =============================================================================

@test "populate_release_tasks should preserve other release fields" {
    cat > "$TODO_FILE" << 'EOF'
{
  "tasks": [
    {
      "id": "T900",
      "title": "Test task",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-15T10:00:00Z",
      "labels": ["v0.65.0"]
    }
  ],
  "project": {
    "releases": [
      {
        "version": "v0.65.0",
        "releasedAt": "2026-01-20T00:00:00Z",
        "createdAt": "2026-01-19T00:00:00Z",
        "notes": "Important release notes",
        "customField": "should be preserved",
        "tasks": []
      }
    ]
  }
}
EOF

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # Verify other fields preserved
    local notes
    notes=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .notes' "$TODO_FILE")
    [[ "$notes" == "Important release notes" ]]

    local custom
    custom=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .customField' "$TODO_FILE")
    [[ "$custom" == "should be preserved" ]]
}

@test "populate_release_tasks should not modify tasks array" {
    create_test_todo

    # Get initial task count
    local initial_count
    initial_count=$(jq -r '.tasks | length' "$TODO_FILE")

    run populate_release_tasks "v0.65.0" "$TODO_FILE"
    assert_success

    # Verify tasks array unchanged
    local final_count
    final_count=$(jq -r '.tasks | length' "$TODO_FILE")
    [[ "$initial_count" -eq "$final_count" ]]
}
