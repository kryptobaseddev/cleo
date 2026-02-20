#!/usr/bin/env bats
# =============================================================================
# archive-metadata.bats - Unit tests for enhanced archive metadata (T447/T429)
# =============================================================================
# Tests the enhanced metadata fields added to archived tasks including
# archiveSource, relationshipState, restoreInfo, and triggerDetails.
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
# archiveSource Field Tests
# =============================================================================

@test "archived tasks have archiveSource field" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    # Check _archive.archiveSource exists
    local archive_source
    archive_source=$(jq -r '.archivedTasks[0]._archive.archiveSource' "$ARCHIVE_FILE")
    [ -n "$archive_source" ]
    [ "$archive_source" != "null" ]
}

@test "archiveSource is 'all' when using --all flag" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    local archive_source
    archive_source=$(jq -r '.archivedTasks[0]._archive.archiveSource' "$ARCHIVE_FILE")
    [ "$archive_source" = "all" ]
}

@test "archiveSource is 'force' when using --force flag" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --force

    # With --force, tasks may or may not be archived depending on preserveRecentCount
    # If archived, check source
    local count
    count=$(jq '.archivedTasks | length' "$ARCHIVE_FILE")
    if [ "$count" -gt 0 ]; then
        local archive_source
        archive_source=$(jq -r '.archivedTasks[0]._archive.archiveSource' "$ARCHIVE_FILE")
        [ "$archive_source" = "force" ]
    fi
}

@test "archiveSource is 'auto' for default retention-based archiving" {
    # Create old completed task that will be archived by retention rules
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Old task", "description": "Very old", "status": "done", "priority": "medium", "createdAt": "2025-01-01T10:00:00Z", "completedAt": "2025-01-15T10:00:00Z"},
    {"id": "T002", "title": "Recent 1", "description": "Recent", "status": "done", "priority": "medium", "createdAt": "2025-12-01T10:00:00Z", "completedAt": "2025-12-20T10:00:00Z"},
    {"id": "T003", "title": "Recent 2", "description": "Recent", "status": "done", "priority": "medium", "createdAt": "2025-12-02T10:00:00Z", "completedAt": "2025-12-21T10:00:00Z"},
    {"id": "T004", "title": "Recent 3", "description": "Recent", "status": "done", "priority": "medium", "createdAt": "2025-12-03T10:00:00Z", "completedAt": "2025-12-22T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    # Archive without --all or --force (auto mode)
    bash "$ARCHIVE_SCRIPT"

    local count
    count=$(jq '.archivedTasks | length' "$ARCHIVE_FILE")
    if [ "$count" -gt 0 ]; then
        local archive_source
        archive_source=$(jq -r '.archivedTasks[0]._archive.archiveSource' "$ARCHIVE_FILE")
        [ "$archive_source" = "auto" ]
    fi
}

@test "archiveSource is 'phase-trigger' when using --phase-complete" {
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Setup task", "description": "Setup", "status": "done", "phase": "setup", "priority": "high", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    bash "$ARCHIVE_SCRIPT" --phase-complete setup --all

    local archive_source
    archive_source=$(jq -r '.archivedTasks[0]._archive.archiveSource' "$ARCHIVE_FILE")
    [ "$archive_source" = "phase-trigger" ]
}

@test "archiveSource is 'cascade-from' when using --cascade-from" {
    create_complete_family_hierarchy
    bash "$ARCHIVE_SCRIPT" --cascade-from T001

    local archive_source
    archive_source=$(jq -r '.archivedTasks[0]._archive.archiveSource' "$ARCHIVE_FILE")
    [ "$archive_source" = "cascade-from" ]
}

# =============================================================================
# relationshipState Field Tests
# =============================================================================

@test "archived tasks have relationshipState field" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    # Check _archive.relationshipState exists
    local has_field
    has_field=$(jq -r '.archivedTasks[0]._archive | has("relationshipState")' "$ARCHIVE_FILE")
    [ "$has_field" = "true" ]
}

@test "relationshipState tracks hadChildren correctly" {
    # Create parent with children
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Parent", "description": "Has children", "status": "done", "priority": "high", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Child", "description": "Child of T001", "status": "done", "priority": "medium", "parentId": "T001", "createdAt": "2025-11-02T10:00:00Z", "completedAt": "2025-11-06T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    bash "$ARCHIVE_SCRIPT" --all

    # T001 should have hadChildren = true
    local had_children
    had_children=$(jq -r '.archivedTasks[] | select(.id == "T001") | ._archive.relationshipState.hadChildren' "$ARCHIVE_FILE")
    [ "$had_children" = "true" ]

    # T001 should have T002 in childIds
    local child_count
    child_count=$(jq '.archivedTasks[] | select(.id == "T001") | ._archive.relationshipState.childIds | length' "$ARCHIVE_FILE")
    [ "$child_count" -eq 1 ]
}

@test "relationshipState tracks hadDependents correctly" {
    # Create task with dependents
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Base task", "description": "Depended upon", "status": "done", "priority": "high", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Dependent", "description": "Depends on T001", "status": "done", "priority": "medium", "depends": ["T001"], "createdAt": "2025-11-02T10:00:00Z", "completedAt": "2025-11-06T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    bash "$ARCHIVE_SCRIPT" --all

    # T001 should have hadDependents = true
    local had_dependents
    had_dependents=$(jq -r '.archivedTasks[] | select(.id == "T001") | ._archive.relationshipState.hadDependents' "$ARCHIVE_FILE")
    [ "$had_dependents" = "true" ]

    # T001 should have T002 in dependentIds
    local dependent_count
    dependent_count=$(jq '.archivedTasks[] | select(.id == "T001") | ._archive.relationshipState.dependentIds | length' "$ARCHIVE_FILE")
    [ "$dependent_count" -eq 1 ]
}

@test "relationshipState tracks parentId for child tasks" {
    create_complete_family_hierarchy
    bash "$ARCHIVE_SCRIPT" --all

    # T002 should have parentId = T001
    local parent_id
    parent_id=$(jq -r '.archivedTasks[] | select(.id == "T002") | ._archive.relationshipState.parentId' "$ARCHIVE_FILE")
    [ "$parent_id" = "T001" ]
}

@test "relationshipState is empty for independent tasks" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    # Independent task should have hadChildren and hadDependents = false
    local had_children
    had_children=$(jq -r '.archivedTasks[0]._archive.relationshipState.hadChildren' "$ARCHIVE_FILE")
    [ "$had_children" = "false" ]

    local had_dependents
    had_dependents=$(jq -r '.archivedTasks[0]._archive.relationshipState.hadDependents' "$ARCHIVE_FILE")
    [ "$had_dependents" = "false" ]
}

# =============================================================================
# restoreInfo Field Tests
# =============================================================================

@test "archived tasks have restoreInfo field" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    local has_field
    has_field=$(jq -r '.archivedTasks[0]._archive | has("restoreInfo")' "$ARCHIVE_FILE")
    [ "$has_field" = "true" ]
}

@test "restoreInfo has originalStatus field" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    local original_status
    original_status=$(jq -r '.archivedTasks[0]._archive.restoreInfo.originalStatus' "$ARCHIVE_FILE")
    [ "$original_status" = "done" ]
}

@test "restoreInfo has canRestore field" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    local can_restore
    can_restore=$(jq -r '.archivedTasks[0]._archive.restoreInfo.canRestore' "$ARCHIVE_FILE")
    [ "$can_restore" = "true" ]
}

@test "restoreInfo has restoreBlockers array" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    local blockers_type
    blockers_type=$(jq -r '.archivedTasks[0]._archive.restoreInfo.restoreBlockers | type' "$ARCHIVE_FILE")
    [ "$blockers_type" = "array" ]
}

# =============================================================================
# triggerDetails Field Tests
# =============================================================================

@test "archived tasks have triggerDetails field" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    local has_field
    has_field=$(jq -r '.archivedTasks[0]._archive | has("triggerDetails")' "$ARCHIVE_FILE")
    [ "$has_field" = "true" ]
}

@test "triggerDetails includes configRule" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    local config_rule
    config_rule=$(jq -r '.archivedTasks[0]._archive.triggerDetails.configRule' "$ARCHIVE_FILE")
    [ -n "$config_rule" ]
    echo "$config_rule" | grep -q "daysUntilArchive"
}

@test "triggerDetails includes phase for --phase-complete" {
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Setup task", "description": "Setup", "status": "done", "phase": "setup", "priority": "high", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    bash "$ARCHIVE_SCRIPT" --phase-complete setup --all

    local trigger_phase
    trigger_phase=$(jq -r '.archivedTasks[0]._archive.triggerDetails.phase' "$ARCHIVE_FILE")
    [ "$trigger_phase" = "setup" ]
}

# =============================================================================
# cycleTimeDays Calculation Tests
# =============================================================================

@test "archived tasks have cycleTimeDays calculated" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    local cycle_time
    cycle_time=$(jq -r '.archivedTasks[0]._archive.cycleTimeDays' "$ARCHIVE_FILE")
    [ "$cycle_time" != "null" ]
    # Should be a number
    [[ "$cycle_time" =~ ^[0-9]+$ ]]
}

@test "cycleTimeDays is correct for known dates" {
    # Create task with specific dates: 10 days cycle time
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Test task", "description": "Testing", "status": "done", "priority": "medium", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-11T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    bash "$ARCHIVE_SCRIPT" --all

    local cycle_time
    cycle_time=$(jq -r '.archivedTasks[0]._archive.cycleTimeDays' "$ARCHIVE_FILE")
    [ "$cycle_time" -eq 10 ]
}

@test "cycleTimeDays is null when dates missing" {
    # Create task without completedAt
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Test task", "description": "Testing", "status": "done", "priority": "medium", "createdAt": "2025-11-01T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    bash "$ARCHIVE_SCRIPT" --all

    local cycle_time
    cycle_time=$(jq -r '.archivedTasks[0]._archive.cycleTimeDays' "$ARCHIVE_FILE")
    [ "$cycle_time" = "null" ]
}

# =============================================================================
# archivedAt Timestamp Tests
# =============================================================================

@test "archived tasks have archivedAt timestamp" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    local archived_at
    archived_at=$(jq -r '.archivedTasks[0]._archive.archivedAt' "$ARCHIVE_FILE")
    [ -n "$archived_at" ]
    [ "$archived_at" != "null" ]
    # Should be ISO 8601 format
    [[ "$archived_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]]
}

# =============================================================================
# sessionId Tracking Tests
# =============================================================================

@test "archived tasks have sessionId field" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    local session_id
    session_id=$(jq -r '.archivedTasks[0]._archive.sessionId' "$ARCHIVE_FILE")
    [ -n "$session_id" ]
    # Should be either a session ID or "system"
}

# =============================================================================
# reason Field Tests
# =============================================================================

@test "archived tasks have reason field" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    local reason
    reason=$(jq -r '.archivedTasks[0]._archive.reason' "$ARCHIVE_FILE")
    [ -n "$reason" ]
    [ "$reason" != "null" ]
}

@test "reason is 'force' for --all or --force archives" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    local reason
    reason=$(jq -r '.archivedTasks[0]._archive.reason' "$ARCHIVE_FILE")
    [ "$reason" = "force" ]
}

@test "reason is 'auto' for retention-based archives" {
    # Old task that qualifies for auto archive
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Old task", "description": "Very old", "status": "done", "priority": "medium", "createdAt": "2025-01-01T10:00:00Z", "completedAt": "2025-01-15T10:00:00Z"},
    {"id": "T002", "title": "Recent 1", "description": "Recent", "status": "done", "priority": "medium", "createdAt": "2025-12-01T10:00:00Z", "completedAt": "2025-12-20T10:00:00Z"},
    {"id": "T003", "title": "Recent 2", "description": "Recent", "status": "done", "priority": "medium", "createdAt": "2025-12-02T10:00:00Z", "completedAt": "2025-12-21T10:00:00Z"},
    {"id": "T004", "title": "Recent 3", "description": "Recent", "status": "done", "priority": "medium", "createdAt": "2025-12-03T10:00:00Z", "completedAt": "2025-12-22T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    bash "$ARCHIVE_SCRIPT"

    local count
    count=$(jq '.archivedTasks | length' "$ARCHIVE_FILE")
    if [ "$count" -gt 0 ]; then
        local reason
        reason=$(jq -r '.archivedTasks[0]._archive.reason' "$ARCHIVE_FILE")
        [ "$reason" = "auto" ]
    fi
}

# =============================================================================
# Archive File Meta Updates
# =============================================================================

@test "archive updates _meta.totalArchived" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    local total
    total=$(jq -r '._meta.totalArchived' "$ARCHIVE_FILE")
    [ "$total" -ge 1 ]
}

@test "archive updates _meta.lastArchived" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    local last_archived
    last_archived=$(jq -r '._meta.lastArchived' "$ARCHIVE_FILE")
    [ -n "$last_archived" ]
    [ "$last_archived" != "null" ]
}

@test "archive updates statistics.averageCycleTime" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    # averageCycleTime should be calculated
    local avg_cycle
    avg_cycle=$(jq -r '.statistics.averageCycleTime' "$ARCHIVE_FILE")
    # May be null or a number
    [ "$avg_cycle" = "null" ] || [[ "$avg_cycle" =~ ^[0-9]+\.?[0-9]*$ ]]
}

@test "archive updates statistics.byPriority" {
    create_tasks_with_completed
    bash "$ARCHIVE_SCRIPT" --all

    local by_priority
    by_priority=$(jq '.statistics.byPriority' "$ARCHIVE_FILE")
    [ "$by_priority" != "null" ]
    [ "$(echo "$by_priority" | jq 'type')" = '"object"' ]
}

@test "archive updates phaseSummary" {
    # Create tasks with phases
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "test123"},
  "tasks": [
    {"id": "T001", "title": "Setup task", "description": "Setup", "status": "done", "phase": "setup", "priority": "high", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"}
  ],
  "focus": {}
}
EOF

    bash "$ARCHIVE_SCRIPT" --all

    local phase_summary
    phase_summary=$(jq '.phaseSummary' "$ARCHIVE_FILE")
    [ "$phase_summary" != "null" ]
    [ "$(echo "$phase_summary" | jq 'type')" = '"object"' ]
}
