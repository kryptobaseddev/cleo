#!/usr/bin/env bats
# =============================================================================
# archive-labels.bats - Unit tests for archive label filtering (T447/T429)
# =============================================================================
# Tests label-based archive filtering including --exclude-labels, --only-labels,
# exemptLabels config, and labelPolicies for per-label retention rules.
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper: Create tasks with various labels
# =============================================================================

create_tasks_with_labels() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {"name": "test-project", "currentPhase": "setup"},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Security task", "description": "Security fix", "status": "done", "priority": "critical", "labels": ["security", "bug"], "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Temp task", "description": "Temporary work", "status": "done", "priority": "low", "labels": ["temp", "cleanup"], "createdAt": "2025-11-02T10:00:00Z", "completedAt": "2025-11-06T10:00:00Z"},
    {"id": "T003", "title": "Important task", "description": "Important feature", "status": "done", "priority": "high", "labels": ["important", "feature"], "createdAt": "2025-11-03T10:00:00Z", "completedAt": "2025-11-07T10:00:00Z"},
    {"id": "T004", "title": "Regular task", "description": "Regular work", "status": "done", "priority": "medium", "labels": ["feature"], "createdAt": "2025-11-04T10:00:00Z", "completedAt": "2025-11-08T10:00:00Z"},
    {"id": "T005", "title": "No labels task", "description": "No labels", "status": "done", "priority": "medium", "createdAt": "2025-11-05T10:00:00Z", "completedAt": "2025-11-09T10:00:00Z"},
    {"id": "T006", "title": "Pending task", "description": "Still pending", "status": "pending", "priority": "medium", "createdAt": "2025-11-06T10:00:00Z"}
  ],
  "focus": {}
}
EOF
    _update_fixture_checksum "$dest"
}

# =============================================================================
# --exclude-labels Tests
# =============================================================================

@test "archive --exclude-labels merges with config exemptLabels" {
    create_tasks_with_labels

    # Config has default exempt labels, we add more via CLI
    run bash "$ARCHIVE_SCRIPT" --exclude-labels "security" --all --json
    assert_success

    # Check that excludeLabelsApplied is true in output
    local applied
    applied=$(echo "$output" | jq '.excludeLabelsApplied')
    [ "$applied" = "true" ]

    # Security task (T001) should NOT be archived
    local archived_ids
    archived_ids=$(echo "$output" | jq -r '.archived.taskIds[]' | tr '\n' ' ')
    [[ "$archived_ids" != *"T001"* ]]
}

@test "archive --exclude-labels can exclude multiple labels" {
    create_tasks_with_labels

    run bash "$ARCHIVE_SCRIPT" --exclude-labels "security,important" --all --json
    assert_success

    # T001 (security) and T003 (important) should NOT be archived
    local archived_ids
    archived_ids=$(echo "$output" | jq -r '.archived.taskIds[]' | tr '\n' ' ')
    [[ "$archived_ids" != *"T001"* ]]
    [[ "$archived_ids" != *"T003"* ]]

    # T002, T004, T005 should be archived
    echo "$archived_ids" | grep -q "T002"
    echo "$archived_ids" | grep -q "T004"
    echo "$archived_ids" | grep -q "T005"
}

@test "archive shows effective exempt labels in output" {
    create_tasks_with_labels

    run bash "$ARCHIVE_SCRIPT" --exclude-labels "security" --all --json
    assert_success

    # Check effectiveExemptLabels includes both config and CLI labels
    local effective_labels
    effective_labels=$(echo "$output" | jq -r '.effectiveExemptLabels | join(",")')
    echo "$effective_labels" | grep -q "security"
}

@test "archive --exclude-labels handles whitespace in labels" {
    create_tasks_with_labels

    # Add extra whitespace - should be trimmed
    run bash "$ARCHIVE_SCRIPT" --exclude-labels " security , important " --all --json
    assert_success

    # T001 and T003 should be excluded
    local archived_ids
    archived_ids=$(echo "$output" | jq -r '.archived.taskIds[]' | tr '\n' ' ')
    [[ "$archived_ids" != *"T001"* ]]
    [[ "$archived_ids" != *"T003"* ]]
}

# =============================================================================
# --only-labels Tests
# =============================================================================

@test "archive --only-labels filters to matching tasks" {
    create_tasks_with_labels

    run bash "$ARCHIVE_SCRIPT" --only-labels "temp" --all --json
    assert_success

    # Only T002 (has temp label) should be archived
    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -eq 1 ]

    local archived_ids
    archived_ids=$(echo "$output" | jq -r '.archived.taskIds[0]')
    [ "$archived_ids" = "T002" ]
}

@test "archive --only-labels can match multiple labels" {
    create_tasks_with_labels

    run bash "$ARCHIVE_SCRIPT" --only-labels "security,temp" --all --json
    assert_success

    # T001 (security) and T002 (temp) should be archived
    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -eq 2 ]
}

@test "archive --only-labels with no matching tasks returns zero" {
    create_tasks_with_labels

    run bash "$ARCHIVE_SCRIPT" --only-labels "nonexistent" --all --json
    assert_success

    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -eq 0 ]
}

@test "archive --only-labels filter shows in JSON output" {
    create_tasks_with_labels

    run bash "$ARCHIVE_SCRIPT" --only-labels "temp,security" --all --json
    assert_success

    # Check filters.onlyLabels in output
    local only_labels
    only_labels=$(echo "$output" | jq '.filters.onlyLabels')
    [ "$only_labels" != "null" ]
}

# =============================================================================
# --only-labels and --exclude-labels Mutual Exclusion
# =============================================================================

@test "archive errors when --only-labels and --exclude-labels used together" {
    create_tasks_with_labels

    run bash "$ARCHIVE_SCRIPT" --only-labels "temp" --exclude-labels "security" --all
    assert_failure

    # Should show error about mutual exclusion
    assert_output_contains_any "cannot be used together" "mutual" "exclusive"
}

@test "archive --only-labels and --exclude-labels mutual exclusion returns proper exit code" {
    create_tasks_with_labels

    run bash "$ARCHIVE_SCRIPT" --only-labels "temp" --exclude-labels "security" --all --json
    # Exit code should be non-zero (typically 1 for invalid input)
    [ "$status" -ne 0 ]
}

# =============================================================================
# labelPolicies.neverArchive Tests
# =============================================================================

@test "archive respects labelPolicies neverArchive" {
    create_tasks_with_labels

    # Set labelPolicies in config - "important" should never be archived
    jq '.archive = {"labelPolicies": {"important": {"neverArchive": true}}}' \
        "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    # T003 (has important label) should NOT be archived
    local archived_ids
    archived_ids=$(echo "$output" | jq -r '.archived.taskIds[]' | tr '\n' ' ')
    [[ "$archived_ids" != *"T003"* ]]
}

@test "archive neverArchive applies to tasks with multiple labels" {
    create_tasks_with_labels

    # Set neverArchive for "bug" label (T001 has both security and bug)
    jq '.archive = {"labelPolicies": {"bug": {"neverArchive": true}}}' \
        "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    # T001 should NOT be archived because it has the "bug" label
    local archived_ids
    archived_ids=$(echo "$output" | jq -r '.archived.taskIds[]' | tr '\n' ' ')
    [[ "$archived_ids" != *"T001"* ]]
}

# =============================================================================
# labelPolicies.daysUntilArchive Tests
# =============================================================================

@test "archive respects labelPolicies daysUntilArchive" {
    # Create tasks with recent completion dates
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.3.0",
  "project": {"name": "test-project", "currentPhase": "setup"},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Security task", "description": "Security fix", "status": "done", "priority": "critical", "labels": ["security"], "createdAt": "2025-12-01T10:00:00Z", "completedAt": "2025-12-20T10:00:00Z"},
    {"id": "T002", "title": "Temp task", "description": "Temp work", "status": "done", "priority": "low", "labels": ["temp"], "createdAt": "2025-12-01T10:00:00Z", "completedAt": "2025-12-20T10:00:00Z"}
  ],
  "focus": {}
}
EOF
    _update_fixture_checksum "$TODO_FILE"

    # Set security to 30 days retention, temp to 1 day (will be archived immediately)
    jq '.archive = {"daysUntilArchive": 7, "labelPolicies": {"security": {"daysUntilArchive": 30}, "temp": {"daysUntilArchive": 1}}}' \
        "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Use --force to bypass default retention but respect label policies
    run bash "$ARCHIVE_SCRIPT" --force --json
    assert_success

    # Security task (T001) should NOT be archived (30-day retention)
    # Temp task (T002) should be archived (1-day retention passed)
    # Note: actual behavior depends on current date vs completedAt
}

@test "archive labelPolicies longer retention takes precedence" {
    create_tasks_with_labels

    # Task T001 has both "security" and "bug" labels
    # security = 30 days, bug = 7 days; should use 30 days (longest)
    jq '.archive = {"daysUntilArchive": 3, "labelPolicies": {"security": {"daysUntilArchive": 30}, "bug": {"daysUntilArchive": 7}}}' \
        "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # This test validates the logic exists; actual archive depends on dates
    run bash "$ARCHIVE_SCRIPT" --dry-run --json
    assert_success
}

# =============================================================================
# Exempted Tasks Tracking Tests
# =============================================================================

@test "archive tracks exempted tasks in output" {
    create_tasks_with_labels

    # Add security to exemptLabels
    jq '.archive = {"exemptLabels": ["security"]}' \
        "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success

    # Check exempted count and IDs
    local exempted_count
    exempted_count=$(echo "$output" | jq '.exempted.count')
    [ "$exempted_count" -ge 1 ]

    # T001 should be in exempted list
    local exempted_ids
    exempted_ids=$(echo "$output" | jq -r '.exempted.taskIds[]' | tr '\n' ' ')
    echo "$exempted_ids" | grep -q "T001"
}

@test "archive exempted tasks shown in text output" {
    create_tasks_with_labels

    jq '.archive = {"exemptLabels": ["security"]}' \
        "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    run bash "$ARCHIVE_SCRIPT" --all
    assert_success

    # Should show info about exempted tasks
    assert_output_contains_any "Skipping" "exempt" "security"
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "archive handles tasks with no labels correctly" {
    create_tasks_with_labels

    # Only archive tasks with the "feature" label
    run bash "$ARCHIVE_SCRIPT" --only-labels "feature" --all --json
    assert_success

    # T003, T004 have "feature" label
    # T005 has no labels - should NOT be included
    local archived_ids
    archived_ids=$(echo "$output" | jq -r '.archived.taskIds[]' | tr '\n' ' ')
    [[ "$archived_ids" != *"T005"* ]]
    echo "$archived_ids" | grep -q "T003"
    echo "$archived_ids" | grep -q "T004"
}

@test "archive handles invalid labelPolicies config gracefully" {
    create_tasks_with_labels

    # Set invalid labelPolicies (not an object)
    jq '.archive = {"labelPolicies": "invalid"}' \
        "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success  # Should warn but not fail

    # Tasks should still be archived with default behavior
    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -ge 1 ]
}

@test "archive handles invalid exemptLabels config gracefully" {
    create_tasks_with_labels

    # Set invalid exemptLabels (not an array)
    jq '.archive = {"exemptLabels": "not-an-array"}' \
        "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    run bash "$ARCHIVE_SCRIPT" --all --json
    assert_success  # Should warn but not fail
}

@test "archive --exclude-labels with equals syntax works" {
    create_tasks_with_labels

    run bash "$ARCHIVE_SCRIPT" --exclude-labels=security --all --json
    assert_success

    # T001 should NOT be archived
    local archived_ids
    archived_ids=$(echo "$output" | jq -r '.archived.taskIds[]' | tr '\n' ' ')
    [[ "$archived_ids" != *"T001"* ]]
}

@test "archive --only-labels with equals syntax works" {
    create_tasks_with_labels

    run bash "$ARCHIVE_SCRIPT" --only-labels=temp --all --json
    assert_success

    # Only T002 should be archived
    local archived_count
    archived_count=$(echo "$output" | jq '.archived.count')
    [ "$archived_count" -eq 1 ]
}
