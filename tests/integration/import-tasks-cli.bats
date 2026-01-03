#!/usr/bin/env bats
# =============================================================================
# Integration Tests: import-tasks CLI
# =============================================================================
# Tests for cleo import-tasks command scaffold (T1283)
#
# Test Categories:
#   - Argument parsing (valid/invalid flag combinations)
#   - Input validation (file existence, schema validation)
#   - Error handling (missing file, invalid options)
#   - Dry-run mode (no writes to filesystem)
#   - Output format (JSON vs text based on TTY)
#
# Note: These tests cover CLI scaffold only. Full import logic tests
#       will be added when T1280-T1282 are implemented.
# =============================================================================

load '../libs/bats-support/load'
load '../libs/bats-assert/load'

# Setup test environment
setup() {
    export TEST_DIR="${BATS_TEST_TMPDIR}/import-cli-test-$$"
    mkdir -p "$TEST_DIR/.cleo"
    cd "$TEST_DIR"

    # Initialize basic todo.json
    cat > .cleo/todo.json << 'EOF'
{
  "_meta": {
    "version": "1.0.0",
    "checksum": "abc123",
    "lastUpdated": "2026-01-03T00:00:00Z"
  },
  "project": {
    "name": "test-project",
    "phases": {
      "core": {"order": 1, "name": "Core"},
      "testing": {"order": 2, "name": "Testing"}
    }
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Existing Task",
      "status": "pending",
      "priority": "medium",
      "type": "task",
      "createdAt": "2026-01-01T00:00:00Z"
    }
  ]
}
EOF

    # Create valid export package
    cat > valid-export.cleo-export.json << 'EOF'
{
  "$schema": "https://cleo-dev.com/schemas/v1/export-package.schema.json",
  "_meta": {
    "format": "cleo-export",
    "version": "1.0.0",
    "exportedAt": "2026-01-03T00:00:00Z",
    "source": {
      "project": "source-project",
      "cleo_version": "0.48.0"
    },
    "checksum": "def456",
    "taskCount": 2
  },
  "selection": {
    "mode": "subtree",
    "rootTaskIds": ["T001"],
    "includeChildren": true
  },
  "idMap": {
    "T001": {"title": "Epic Task", "type": "epic"},
    "T002": {"title": "Child Task", "type": "task", "parentId": "T001"}
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Epic Task",
      "type": "epic",
      "status": "pending",
      "priority": "high",
      "createdAt": "2026-01-01T00:00:00Z"
    },
    {
      "id": "T002",
      "title": "Child Task",
      "type": "task",
      "status": "pending",
      "priority": "medium",
      "parentId": "T001",
      "createdAt": "2026-01-01T00:00:00Z"
    }
  ],
  "relationshipGraph": {
    "hierarchy": {
      "T001": ["T002"]
    },
    "dependencies": {},
    "roots": ["T001"]
  }
}
EOF

    # Create invalid export package (wrong format)
    cat > invalid-format.json << 'EOF'
{
  "_meta": {
    "format": "wrong-format",
    "version": "1.0.0"
  },
  "tasks": []
}
EOF
}

# Cleanup
teardown() {
    cd /
    rm -rf "$TEST_DIR"
}

# =============================================================================
# Help and Usage Tests
# =============================================================================

@test "import-tasks --help shows usage" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" --help
    assert_success
    assert_output --partial "Usage: cleo import-tasks"
    assert_output --partial "Import tasks from .cleo-export.json"
}

@test "import-tasks -h shows usage" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" -h
    assert_success
    assert_output --partial "Usage: cleo import-tasks"
}

# =============================================================================
# Required Arguments Tests
# =============================================================================

@test "import-tasks without export file fails" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh"
    assert_failure
    assert_output --partial "Export file is required"
}

@test "import-tasks with multiple export files fails" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" file1.json file2.json
    assert_failure
    assert_output --partial "Multiple export files"
}

# =============================================================================
# File Validation Tests
# =============================================================================

@test "import-tasks with missing file fails" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" nonexistent.json
    assert_failure
    assert_output --partial "Export file not found"
}

@test "import-tasks with invalid JSON fails" {
    echo "not valid json" > invalid.json
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" invalid.json
    assert_failure
    assert_output --partial "not valid JSON"
}

@test "import-tasks with wrong format fails" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" invalid-format.json
    assert_failure
    assert_output --partial "Invalid export format"
}

@test "import-tasks with valid export file succeeds (stub)" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json
    assert_success
    # Since import is stubbed, just verify it doesn't crash
}

# =============================================================================
# Argument Parsing Tests
# =============================================================================

@test "import-tasks --dry-run flag parsed correctly" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --dry-run --human
    assert_success
    assert_output --partial "Dry run"
}

@test "import-tasks --parent with valid ID accepted" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --parent T001 --dry-run
    assert_success
}

@test "import-tasks --parent with invalid ID format fails" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --parent INVALID
    assert_failure
    assert_output --partial "Invalid parent ID format"
}

@test "import-tasks --parent with nonexistent ID fails" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --parent T999
    assert_failure
    assert_output --partial "Parent task not found"
}

@test "import-tasks --phase with valid phase accepted" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --phase core --dry-run
    assert_success
}

@test "import-tasks --phase with invalid format fails" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --phase "Invalid Phase"
    assert_failure
    assert_output --partial "Invalid phase format"
}

@test "import-tasks --phase with nonexistent phase fails" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --phase nonexistent
    assert_failure
    assert_output --partial "Phase 'nonexistent' not found"
}

@test "import-tasks --add-label with valid label accepted" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --add-label imported-2026 --dry-run
    assert_success
}

@test "import-tasks --add-label with invalid format fails" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --add-label "Invalid Label"
    assert_failure
    assert_output --partial "Invalid label format"
}

@test "import-tasks --reset-status with valid status accepted" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --reset-status pending --dry-run
    assert_success
}

@test "import-tasks --reset-status with invalid status fails" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --reset-status invalid
    assert_failure
    assert_output --partial "Invalid status"
}

@test "import-tasks --on-conflict with valid modes accepted" {
    for mode in duplicate rename skip fail; do
        run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --on-conflict $mode --dry-run
        assert_success
    done
}

@test "import-tasks --on-conflict with invalid mode fails" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --on-conflict invalid
    assert_failure
    assert_output --partial "Invalid --on-conflict mode"
}

@test "import-tasks --on-missing-dep with valid modes accepted" {
    for mode in strip placeholder fail; do
        run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --on-missing-dep $mode --dry-run
        assert_success
    done
}

@test "import-tasks --on-missing-dep with invalid mode fails" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --on-missing-dep invalid
    assert_failure
    assert_output --partial "Invalid --on-missing-dep mode"
}

@test "import-tasks --force flag accepted" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --force --dry-run
    assert_success
}

@test "import-tasks unknown option fails" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --unknown-option
    assert_failure
    assert_output --partial "Unknown option"
}

# =============================================================================
# Dry-Run Mode Tests
# =============================================================================

@test "import-tasks --dry-run does not modify todo.json" {
    local checksum_before
    checksum_before=$(jq -r '._meta.checksum' .cleo/todo.json)

    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --dry-run
    assert_success

    local checksum_after
    checksum_after=$(jq -r '._meta.checksum' .cleo/todo.json)

    [[ "$checksum_before" == "$checksum_after" ]]
}

@test "import-tasks --dry-run shows preview" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --dry-run --human
    assert_success
    assert_output --partial "Dry run"
    assert_output --partial "Would import"
}

# =============================================================================
# Output Format Tests
# =============================================================================

@test "import-tasks --json outputs valid JSON" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --json --dry-run
    assert_success

    # Validate JSON structure
    echo "$output" | jq empty
}

@test "import-tasks --human outputs text format" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --human --dry-run
    assert_success
    refute_output --partial '"$schema"'
}

# =============================================================================
# Combined Flags Tests
# =============================================================================

@test "import-tasks with multiple transformation flags" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" \
        valid-export.cleo-export.json \
        --parent T001 \
        --phase core \
        --add-label imported \
        --reset-status pending \
        --dry-run

    assert_success
}

@test "import-tasks with conflict resolution flags" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" \
        valid-export.cleo-export.json \
        --on-conflict rename \
        --on-missing-dep strip \
        --dry-run

    assert_success
}

# =============================================================================
# Error Message Quality Tests
# =============================================================================

@test "import-tasks error messages use structured format" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" nonexistent.json
    assert_failure
    # In JSON mode (piped), errors are JSON objects with "error" field
    # In human mode, they'd show "ERROR" prefix
    assert_output --regexp "error|ERROR"
}

@test "import-tasks validation errors provide suggestions" {
    run bash "$BATS_TEST_DIRNAME/../../scripts/import-tasks.sh" valid-export.cleo-export.json --parent INVALID
    assert_failure
    # Should provide fix suggestion
    assert_output --partial "format"
}
