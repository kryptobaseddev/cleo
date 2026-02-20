#!/usr/bin/env bats
# =============================================================================
# backfill-releases.bats - Integration tests for backfill-releases.sh
# =============================================================================
# Tests backfill script with real data
# Validates task ID extraction from CHANGELOG.md, dry-run, actual updates
#
# Task: T2625
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

    # Determine project root
    TEST_FILE_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
    PROJECT_ROOT="$(cd "$TEST_FILE_DIR/../.." && pwd)"

    # Use BATS temp directory
    TEST_DIR="${BATS_TEST_TMPDIR}"
    CLEO_DIR="$TEST_DIR/.cleo"
    mkdir -p "$CLEO_DIR"

    # Set environment variables
    export TODO_FILE="$CLEO_DIR/todo.json"
    export CHANGELOG_FILE="$TEST_DIR/CHANGELOG.md"
    export BACKFILL_SCRIPT="$PROJECT_ROOT/dev/backfill-releases.sh"
}

teardown() {
    common_teardown
}

# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

# Create test todo.json with releases (no tasks)
create_test_releases() {
    cat > "$TODO_FILE" << 'EOF'
{
  "tasks": [
    {"id": "T001", "title": "Feature 1"},
    {"id": "T002", "title": "Bug fix 1"},
    {"id": "T003", "title": "Docs update"}
  ],
  "project": {
    "releases": [
      {"version": "v0.1.0", "status": "released", "releasedAt": "2025-01-01T00:00:00Z", "tasks": []},
      {"version": "v0.2.0", "status": "released", "releasedAt": "2025-02-01T00:00:00Z", "tasks": []},
      {"version": "v0.3.0", "status": "released", "releasedAt": "2025-03-01T00:00:00Z", "tasks": []}
    ]
  }
}
EOF
}

# Create test CHANGELOG.md
create_test_changelog() {
    cat > "$CHANGELOG_FILE" << 'EOF'
# Changelog

## [v0.3.0] - 2025-03-01

### Features
- New feature (T001)

### Documentation
- Updated docs (T003)

## [v0.2.0] - 2025-02-01

### Bug Fixes
- Fixed critical bug (T002)

## [v0.1.0] - 2025-01-01

### Features
- Initial release

EOF
}

# =============================================================================
# TESTS: Dry Run Mode
# =============================================================================

@test "backfill should show what would be done in dry-run mode" {
    create_test_releases
    create_test_changelog

    run bash "$BACKFILL_SCRIPT" --dry-run --changelog "$CHANGELOG_FILE" --todo "$TODO_FILE"
    assert_success

    # Should indicate dry-run mode
    assert_output --partial "DRY-RUN MODE"
    assert_output --partial "No changes will be made"

    # Verify no actual changes to todo.json
    local v030_tasks
    v030_tasks=$(jq -r '.project.releases[] | select(.version == "v0.3.0") | .tasks | length' "$TODO_FILE")
    [[ "$v030_tasks" -eq 0 ]]
}

@test "backfill dry-run should report which releases would be updated" {
    create_test_releases
    create_test_changelog

    run bash "$BACKFILL_SCRIPT" --dry-run --changelog "$CHANGELOG_FILE" --todo "$TODO_FILE"
    assert_success

    # Should show which versions would be updated
    assert_output --partial "v0.3.0"
    assert_output --partial "v0.2.0"

    # v0.1.0 has no task IDs in changelog, so should be skipped
    assert_output --partial "Skipped"
}

# =============================================================================
# TESTS: Task Extraction
# =============================================================================

@test "backfill should extract task IDs from changelog sections" {
    create_test_releases
    create_test_changelog

    run bash "$BACKFILL_SCRIPT" --changelog "$CHANGELOG_FILE" --todo "$TODO_FILE"
    assert_success

    # v0.3.0 should have T001 and T003
    local v030_tasks
    v030_tasks=$(jq -r '.project.releases[] | select(.version == "v0.3.0") | .tasks | sort | join(",")' "$TODO_FILE")
    [[ "$v030_tasks" == "T001,T003" ]]

    # v0.2.0 should have T002
    local v020_tasks
    v020_tasks=$(jq -r '.project.releases[] | select(.version == "v0.2.0") | .tasks | join(",")' "$TODO_FILE")
    [[ "$v020_tasks" == "T002" ]]

    # v0.1.0 should be empty (no task IDs in changelog)
    local v010_tasks
    v010_tasks=$(jq -r '.project.releases[] | select(.version == "v0.1.0") | .tasks | length' "$TODO_FILE")
    [[ "$v010_tasks" -eq 0 ]]
}

@test "backfill should skip releases that already have tasks" {
    create_test_releases
    create_test_changelog

    # Pre-populate v0.3.0 with tasks
    local updated_json
    updated_json=$(jq '.project.releases[2].tasks = ["T999"]' "$TODO_FILE")
    echo "$updated_json" > "$TODO_FILE"

    run bash "$BACKFILL_SCRIPT" --changelog "$CHANGELOG_FILE" --todo "$TODO_FILE"
    assert_success

    # v0.3.0 should still have T999 (not updated)
    local v030_tasks
    v030_tasks=$(jq -r '.project.releases[] | select(.version == "v0.3.0") | .tasks | join(",")' "$TODO_FILE")
    [[ "$v030_tasks" == "T999" ]]

    # v0.2.0 should be updated (had no tasks)
    local v020_tasks
    v020_tasks=$(jq -r '.project.releases[] | select(.version == "v0.2.0") | .tasks | join(",")' "$TODO_FILE")
    [[ "$v020_tasks" == "T002" ]]
}

# =============================================================================
# TESTS: Version Filtering
# =============================================================================

@test "backfill with --version should process only that version" {
    create_test_releases
    create_test_changelog

    run bash "$BACKFILL_SCRIPT" --version v0.2.0 --changelog "$CHANGELOG_FILE" --todo "$TODO_FILE"
    assert_success

    # v0.2.0 should be updated
    local v020_tasks
    v020_tasks=$(jq -r '.project.releases[] | select(.version == "v0.2.0") | .tasks | join(",")' "$TODO_FILE")
    [[ "$v020_tasks" == "T002" ]]

    # v0.3.0 should NOT be updated
    local v030_tasks
    v030_tasks=$(jq -r '.project.releases[] | select(.version == "v0.3.0") | .tasks | length' "$TODO_FILE")
    [[ "$v030_tasks" -eq 0 ]]
}

@test "backfill with --from and --to should process range" {
    create_test_releases
    create_test_changelog

    run bash "$BACKFILL_SCRIPT" --from v0.2.0 --to v0.3.0 --changelog "$CHANGELOG_FILE" --todo "$TODO_FILE"
    assert_success

    # v0.2.0 and v0.3.0 should be updated
    local v020_tasks v030_tasks
    v020_tasks=$(jq -r '.project.releases[] | select(.version == "v0.2.0") | .tasks | join(",")' "$TODO_FILE")
    v030_tasks=$(jq -r '.project.releases[] | select(.version == "v0.3.0") | .tasks | join(",")' "$TODO_FILE")

    [[ "$v020_tasks" == "T002" ]]
    [[ "$v030_tasks" == "T001,T003" ]]

    # v0.1.0 should NOT be updated (before range)
    local v010_tasks
    v010_tasks=$(jq -r '.project.releases[] | select(.version == "v0.1.0") | .tasks | length' "$TODO_FILE")
    [[ "$v010_tasks" -eq 0 ]]
}

# =============================================================================
# TESTS: Error Handling
# =============================================================================

@test "backfill should validate CHANGELOG.md exists" {
    create_test_releases

    run bash "$BACKFILL_SCRIPT" --changelog /nonexistent/CHANGELOG.md --todo "$TODO_FILE"
    assert_failure
    assert_output --partial "CHANGELOG.md not found"
}

@test "backfill should validate todo.json exists" {
    create_test_changelog

    run bash "$BACKFILL_SCRIPT" --changelog "$CHANGELOG_FILE" --todo /nonexistent/todo.json
    assert_failure
    assert_output --partial "todo.json not found"
}

@test "backfill should validate todo.json is valid JSON" {
    create_test_changelog

    # Create invalid JSON
    echo "{ invalid json" > "$TODO_FILE"

    run bash "$BACKFILL_SCRIPT" --changelog "$CHANGELOG_FILE" --todo "$TODO_FILE"
    assert_failure
    assert_output --partial "not valid JSON"
}

# =============================================================================
# TESTS: Edge Cases
# =============================================================================

@test "backfill should handle changelog with no task IDs" {
    create_test_releases

    # Create changelog with no task IDs
    cat > "$CHANGELOG_FILE" << 'EOF'
# Changelog

## [v0.1.0] - 2025-01-01

### Features
- Initial release (no task IDs)

EOF

    run bash "$BACKFILL_SCRIPT" --changelog "$CHANGELOG_FILE" --todo "$TODO_FILE"
    assert_success

    # Should skip (no task IDs found)
    assert_output --partial "No task IDs found"
}

@test "backfill should handle task IDs not in todo.json" {
    create_test_releases

    # Create changelog with non-existent task ID
    cat > "$CHANGELOG_FILE" << 'EOF'
# Changelog

## [v0.1.0] - 2025-01-01

### Features
- Feature with invalid task (T9999)

EOF

    run bash "$BACKFILL_SCRIPT" --changelog "$CHANGELOG_FILE" --todo "$TODO_FILE"
    assert_success

    # Should warn about missing task
    assert_output --partial "not found in todo.json"

    # Should not add invalid task
    local v010_tasks
    v010_tasks=$(jq -r '.project.releases[] | select(.version == "v0.1.0") | .tasks | length' "$TODO_FILE")
    [[ "$v010_tasks" -eq 0 ]]
}

@test "backfill should handle multiple task IDs in single line" {
    create_test_releases

    cat > "$CHANGELOG_FILE" << 'EOF'
# Changelog

## [v0.1.0] - 2025-01-01

### Features
- Multiple fixes (T001) (T002) (T003)

EOF

    run bash "$BACKFILL_SCRIPT" --changelog "$CHANGELOG_FILE" --todo "$TODO_FILE"
    assert_success

    # Should extract all three task IDs
    local v010_tasks
    v010_tasks=$(jq -r '.project.releases[] | select(.version == "v0.1.0") | .tasks | length' "$TODO_FILE")
    [[ "$v010_tasks" -eq 3 ]]
}

# =============================================================================
# TESTS: Summary Output
# =============================================================================

@test "backfill should show summary statistics" {
    create_test_releases
    create_test_changelog

    run bash "$BACKFILL_SCRIPT" --changelog "$CHANGELOG_FILE" --todo "$TODO_FILE"
    assert_success

    # Should show summary
    assert_output --partial "Backfill complete"
    assert_output --partial "Processed:"
    assert_output --partial "Updated:"
    assert_output --partial "Skipped:"
}

# =============================================================================
# TESTS: Real Data Validation
# =============================================================================

@test "backfill with --verbose should show detailed progress" {
    create_test_releases
    create_test_changelog

    run bash "$BACKFILL_SCRIPT" --verbose --changelog "$CHANGELOG_FILE" --todo "$TODO_FILE"
    assert_success

    # Should show debug output
    assert_output --partial "Extracting task IDs"
    assert_output --partial "Found valid task"
}
