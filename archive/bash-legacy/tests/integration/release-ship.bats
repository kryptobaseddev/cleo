#!/usr/bin/env bats
# =============================================================================
# release-ship.bats - Integration tests for release ship command
# =============================================================================
# Tests cleo release ship command with changelog generation
# Validates full workflow: task discovery, changelog generation, validations
#
# Task: T2623
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    load '../test_helper/assertions'
    common_setup_per_test

    # Determine project root from test file location
    TEST_FILE_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
    PROJECT_ROOT="$(cd "$TEST_FILE_DIR/../.." && pwd)"

    # Use BATS-managed temp directory
    TEST_DIR="${BATS_TEST_TMPDIR}"
    CLEO_DIR="$TEST_DIR/.cleo"
    mkdir -p "$CLEO_DIR"

    # Set environment variables
    export TODO_FILE="$CLEO_DIR/todo.json"
    export CHANGELOG_FILE="$TEST_DIR/CHANGELOG.md"
    export RELEASE_SCRIPT="$PROJECT_ROOT/scripts/release.sh"

    # Create minimal config
    cat > "$CLEO_DIR/config.json" << 'EOF'
{
  "version": "2.1.0",
  "project": {
    "name": "test-project"
  }
}
EOF

    # Mock cleo command to pass validation
    cat > "$TEST_DIR/cleo" << 'EOF'
#!/bin/bash
exit 0
EOF
    chmod +x "$TEST_DIR/cleo"
    export PATH="$TEST_DIR:$PATH"

    # Mock test runner
    mkdir -p "$TEST_DIR/tests"
    cat > "$TEST_DIR/tests/run-all-tests.sh" << 'EOF'
#!/bin/bash
exit 0
EOF
    chmod +x "$TEST_DIR/tests/run-all-tests.sh"

    # Initialize git repo (release ship does git commit)
    git -C "$TEST_DIR" init -q
    git -C "$TEST_DIR" config user.email "test@test.com"
    git -C "$TEST_DIR" config user.name "Test"
    # Create initial commit so git operations work
    git -C "$TEST_DIR" add -A
    git -C "$TEST_DIR" commit -q -m "initial" --allow-empty
}

teardown() {
    common_teardown
}

# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

# Create test todo.json with release and tasks
create_test_release_data() {
    cat > "$TODO_FILE" << 'EOF'
{
  "tasks": [
    {
      "id": "T001",
      "title": "Feature: Add user authentication",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-15T10:00:00Z",
      "labels": ["v0.65.0", "feature"],
      "priority": "high",
      "description": "Implement JWT authentication"
    },
    {
      "id": "T002",
      "title": "Fix: Memory leak in parser",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-16T12:00:00Z",
      "labels": ["v0.65.0", "changelog", "fix"],
      "priority": "critical",
      "description": "Fixed buffer overflow"
    },
    {
      "id": "T003",
      "title": "Docs: Update API reference",
      "type": "task",
      "status": "done",
      "completedAt": "2026-01-17T14:00:00Z",
      "labels": ["v0.65.0", "docs"],
      "priority": "medium",
      "description": "Updated OpenAPI spec"
    }
  ],
  "project": {
    "releases": [
      {
        "version": "v0.64.0",
        "status": "released",
        "releasedAt": "2026-01-10T00:00:00Z",
        "tasks": []
      },
      {
        "version": "v0.65.0",
        "status": "planned",
        "createdAt": "2026-01-19T00:00:00Z",
        "targetDate": "2026-01-20T00:00:00Z",
        "tasks": []
      }
    ]
  }
}
EOF
}

# Create release data with no tasks
create_release_with_no_tasks() {
    cat > "$TODO_FILE" << 'EOF'
{
  "tasks": [],
  "project": {
    "releases": [
      {
        "version": "v0.65.0",
        "status": "planned",
        "createdAt": "2026-01-19T00:00:00Z",
        "tasks": []
      }
    ]
  }
}
EOF
}

# =============================================================================
# TESTS: Basic Ship Functionality
# =============================================================================

@test "ship command should discover tasks and update release status" {
    create_test_release_data

    run bash "$RELEASE_SCRIPT" ship v0.65.0
    assert_success

    # Verify release was marked as released
    local status
    status=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .status' "$TODO_FILE")
    [[ "$status" == "released" ]]

    # Verify releasedAt timestamp was set
    local released_at
    released_at=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .releasedAt' "$TODO_FILE")
    [[ "$released_at" != "null" && -n "$released_at" ]]

    # Verify tasks were populated (3 tasks: T001, T002, T003)
    local task_count
    task_count=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | length' "$TODO_FILE")
    [[ "$task_count" -eq 3 ]]
}

@test "ship command should write changelog to CHANGELOG.md" {
    create_test_release_data

    run bash "$RELEASE_SCRIPT" ship v0.65.0
    assert_success

    # Verify CHANGELOG.md was created
    [[ -f "$CHANGELOG_FILE" ]]

    # Verify changelog contains version header (without 'v' per Keep a Changelog standard)
    grep -q "^## \[0.65.0\]" "$CHANGELOG_FILE"

    # Verify changelog contains sections
    grep -q "### Features" "$CHANGELOG_FILE"
    grep -q "### Bug Fixes" "$CHANGELOG_FILE"
    grep -q "### Documentation" "$CHANGELOG_FILE"

    # Verify tasks are listed with IDs
    grep -q "T001" "$CHANGELOG_FILE"
    grep -q "T002" "$CHANGELOG_FILE"
    grep -q "T003" "$CHANGELOG_FILE"
}

@test "ship command should populate tasks before generating changelog" {
    create_test_release_data

    run bash "$RELEASE_SCRIPT" ship v0.65.0
    assert_success

    # Verify tasks array was populated
    local tasks
    tasks=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | sort | join(",")' "$TODO_FILE")
    [[ "$tasks" == "T001,T002,T003" ]]
}

@test "ship command should preserve pre-planned tasks when auto-discovering" {
    create_test_release_data

    # Seed a manual planned link and keep one discovered task already present
    jq '.tasks += [{
          "id": "T999",
          "title": "Manual planned task",
          "type": "task",
          "status": "pending",
          "labels": []
        }] |
        .project.releases = (.project.releases | map(
          if .version == "v0.65.0" then
            .tasks = ["T999", "T001"]
          else
            .
          end
        ))' "$TODO_FILE" > "$TODO_FILE.tmp"
    mv "$TODO_FILE.tmp" "$TODO_FILE"

    run bash "$RELEASE_SCRIPT" ship v0.65.0
    assert_success

    local tasks_csv
    tasks_csv=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .tasks | join(",")' "$TODO_FILE")
    [[ "$tasks_csv" == "T999,T001,T002,T003" ]]

    local t001_count
    t001_count=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | [.tasks[] | select(. == "T001")] | length' "$TODO_FILE")
    [[ "$t001_count" -eq 1 ]]
}

@test "ship command should normalize version (with or without v prefix)" {
    create_test_release_data

    # Ship without v prefix
    run bash "$RELEASE_SCRIPT" ship 0.65.0
    assert_success

    # Verify release was marked as released (with v prefix in storage)
    local status
    status=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .status' "$TODO_FILE")
    [[ "$status" == "released" ]]
}

# =============================================================================
# TESTS: Validation Gates
# =============================================================================

@test "ship command should fail if release does not exist" {
    create_test_release_data

    run bash "$RELEASE_SCRIPT" ship v0.99.0
    assert_failure
    assert_output --partial "Release v0.99.0 not found"
}

@test "ship command should fail if release is already released" {
    create_test_release_data

    # Ship first time
    bash "$RELEASE_SCRIPT" ship v0.65.0 >/dev/null 2>&1

    # Try to ship again
    run bash "$RELEASE_SCRIPT" ship v0.65.0
    assert_failure
    assert_output --partial "already released"
}

@test "ship command should fail validation if changelog is empty" {
    create_release_with_no_tasks

    # Attempt to ship (will generate empty changelog)
    run bash "$RELEASE_SCRIPT" ship v0.65.0
    assert_failure
    assert_output --partial "Changelog entry is empty"
}

# =============================================================================
# TESTS: Changelog Integration
# =============================================================================

@test "ship command should append to existing CHANGELOG.md" {
    create_test_release_data

    # Create existing CHANGELOG.md with header
    cat > "$CHANGELOG_FILE" << 'EOF'
# Changelog

All notable changes to this project will be documented in this file.

## [v0.64.0] - 2026-01-10

### Features
- Previous feature (T000)

EOF

    run bash "$RELEASE_SCRIPT" ship v0.65.0
    assert_success

    # Verify v0.65.0 was prepended (appears before v0.64.0)
    local v65_line v64_line
    v65_line=$(grep -n "^\## \[v0.65.0\]" "$CHANGELOG_FILE" | cut -d: -f1)
    v64_line=$(grep -n "^\## \[v0.64.0\]" "$CHANGELOG_FILE" | cut -d: -f1)

    [[ "$v65_line" -lt "$v64_line" ]]

    # Verify header is still present
    grep -q "^# Changelog" "$CHANGELOG_FILE"
}

@test "ship command should preserve existing changelog content" {
    create_test_release_data

    # Create existing CHANGELOG.md
    cat > "$CHANGELOG_FILE" << 'EOF'
# Changelog

## [v0.64.0] - 2026-01-10

### Features
- Previous feature (T000)

EOF

    run bash "$RELEASE_SCRIPT" ship v0.65.0
    assert_success

    # Verify previous content is preserved
    grep -q "Previous feature (T000)" "$CHANGELOG_FILE"
}

# =============================================================================
# TESTS: Release Notes
# =============================================================================

@test "ship command should accept --notes flag" {
    create_test_release_data

    run bash "$RELEASE_SCRIPT" ship v0.65.0 --notes "Major security release"
    assert_success

    # Verify notes were saved
    local notes
    notes=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .notes' "$TODO_FILE")
    [[ "$notes" == "Major security release" ]]
}

# =============================================================================
# TESTS: JSON Output Format
# =============================================================================

@test "ship command with --json should output valid JSON" {
    create_test_release_data

    run bash "$RELEASE_SCRIPT" ship v0.65.0 --json
    assert_success

    # Extract JSON from output (may include log lines before JSON object)
    local json_output
    json_output=$(echo "$output" | sed -n '/^{/,/^}/p' | tail -n +1)

    # Verify valid JSON
    local success action version status
    success=$(jq -r '.success' <<< "$json_output")
    action=$(jq -r '.action' <<< "$json_output")
    version=$(jq -r '.release.version' <<< "$json_output")
    status=$(jq -r '.release.status' <<< "$json_output")

    [[ "$success" == "true" ]]
    [[ "$action" == "shipped" ]]
    [[ "$version" == "v0.65.0" ]]
    [[ "$status" == "released" ]]
}

# =============================================================================
# TESTS: Error Conditions
# =============================================================================

@test "ship command should fail gracefully with invalid version format" {
    create_test_release_data

    run bash "$RELEASE_SCRIPT" ship "invalid-version"
    assert_failure
}

@test "ship command should preserve data on validation failure" {
    create_release_with_no_tasks

    # Try to ship (will fail validation)
    run bash "$RELEASE_SCRIPT" ship v0.65.0
    assert_failure

    # Verify release status was not changed (still planned)
    local status
    status=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .status' "$TODO_FILE")
    [[ "$status" == "planned" ]]
}

# =============================================================================
# TESTS: Information Output
# =============================================================================

@test "ship command output should be informative" {
    create_test_release_data

    run bash "$RELEASE_SCRIPT" ship v0.65.0
    assert_success

    # Should contain success message
    assert_output --partial "Shipped release v0.65.0"

    # Should show timestamp
    assert_output --partial "Released at:"
}

# =============================================================================
# TESTS: Release Guards Integration
# @task T4436 @epic T4431
# =============================================================================

@test "ship --preview shows task list and exits cleanly" {
    create_test_release_data

    run bash "$RELEASE_SCRIPT" ship v0.65.0 --preview --format json
    assert_success

    # Extract JSON from output (may include log lines before JSON)
    local json_output
    json_output=$(echo "$output" | sed -n '/^{/,/^}/p' | tail -n +1)

    # Should have preview: true in output
    echo "$json_output" | jq -e '.preview == true' >/dev/null

    # Should have tasks array
    echo "$json_output" | jq -e '.tasks' >/dev/null
}

@test "ship --dry-run shows task preview in output" {
    create_test_release_data

    run bash "$RELEASE_SCRIPT" ship v0.65.0 --dry-run --format json
    assert_success

    # Extract JSON from output
    local json_output
    json_output=$(echo "$output" | sed -n '/^{/,/^}/p' | tail -n +1)

    # Should have dryRun: true
    echo "$json_output" | jq -e '.dryRun == true' >/dev/null

    # Should have tasks array
    echo "$json_output" | jq -e '.tasks' >/dev/null
}

@test "ship --preview does not modify release state" {
    create_test_release_data

    # Get status before
    local status_before
    status_before=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .status' "$TODO_FILE")

    # Run preview
    run bash "$RELEASE_SCRIPT" ship v0.65.0 --preview --format json
    assert_success

    # Status should still be planned
    local status_after
    status_after=$(jq -r '.project.releases[] | select(.version == "v0.65.0") | .status' "$TODO_FILE")
    [[ "$status_before" == "$status_after" ]]
    [[ "$status_after" == "planned" ]]
}

@test "ship --preview includes guard check results" {
    create_test_release_data

    run bash "$RELEASE_SCRIPT" ship v0.65.0 --preview --format json
    assert_success

    # Extract JSON from output
    local json_output
    json_output=$(echo "$output" | sed -n '/^{/,/^}/p' | tail -n +1)

    # Should have epicCompleteness and doubleListing guard results
    echo "$json_output" | jq -e '.epicCompleteness' >/dev/null
    echo "$json_output" | jq -e '.doubleListing' >/dev/null
}
