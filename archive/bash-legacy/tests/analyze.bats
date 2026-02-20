#!/usr/bin/env bats
# =============================================================================
# analyze.bats - Test suite for claude-todo analyze command
# =============================================================================
# Tests leverage scoring, bottleneck detection, tier assignment, output formats,
# and auto-focus integration for intelligent task prioritization.
# =============================================================================

# =============================================================================
# File-Level Setup (runs once per test file)
# =============================================================================
setup_file() {
    load 'test_helper/common_setup'
    load 'test_helper/fixtures'
    common_setup_file
}

# =============================================================================
# Per-Test Setup (runs before each test)
# =============================================================================
setup() {
    # Re-load helpers for per-test scope
    load 'test_helper/common_setup'
    load 'test_helper/fixtures'
    common_setup_per_test

    # Use BATS-managed temp directory (auto-cleaned)
    export CLAUDE_TODO_DIR="${BATS_TEST_TMPDIR}/.claude"
    mkdir -p "$CLAUDE_TODO_DIR"

    # Set file paths
    export TODO_FILE="${CLAUDE_TODO_DIR}/todo.json"
    export FOCUS_FILE="${CLAUDE_TODO_DIR}/focus.json"
    export ARCHIVE_FILE="${CLAUDE_TODO_DIR}/todo-archive.json"

    # Create empty archive
    create_empty_archive "$ARCHIVE_FILE"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Fixture Generator for Analysis Testing
# =============================================================================

# Create fixture with known dependency structure for leverage testing:
# T001 (blocks T002, T003, T004) - high leverage (3 dependents)
# T002 (blocks T005) - medium leverage (1 dependent)
# T003 (no deps) - low leverage (0 dependents)
# T004 (no deps) - low leverage (0 dependents)
# T005 (no deps) - low leverage (0 dependents)
create_analysis_fixture() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "completed", "startedAt": "2025-12-01T09:00:00Z", "completedAt": "2025-12-01T10:00:00Z"},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "active", "startedAt": "2025-12-01T10:00:00Z", "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"version": "2.2.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Foundation task", "description": "High leverage task blocking 3 others", "status": "pending", "priority": "critical", "phase": "core", "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T002", "title": "Depends on T001", "description": "Medium leverage task", "status": "pending", "priority": "high", "phase": "core", "createdAt": "2025-12-01T11:00:00Z", "depends": ["T001"]},
    {"id": "T003", "title": "Also depends on T001", "description": "Low leverage task", "status": "pending", "priority": "medium", "phase": "core", "createdAt": "2025-12-01T12:00:00Z", "depends": ["T001"]},
    {"id": "T004", "title": "Another T001 dependent", "description": "Low leverage task", "status": "pending", "priority": "medium", "phase": "core", "createdAt": "2025-12-01T13:00:00Z", "depends": ["T001"]},
    {"id": "T005", "title": "Depends on T002", "description": "Lowest leverage task", "status": "pending", "priority": "low", "phase": "testing", "createdAt": "2025-12-01T14:00:00Z", "depends": ["T002"]}
  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "lastUpdated": "2025-12-01T14:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create fixture with bottleneck tasks (3+ dependents)
create_bottleneck_fixture() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "completed", "startedAt": "2025-12-01T09:00:00Z", "completedAt": "2025-12-01T10:00:00Z"},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "active", "startedAt": "2025-12-01T10:00:00Z", "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"version": "2.2.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Bottleneck task", "description": "Task blocking 4 others", "status": "pending", "priority": "high", "phase": "core", "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T002", "title": "Normal task", "description": "Task blocking 1 other", "status": "pending", "priority": "medium", "phase": "core", "createdAt": "2025-12-01T11:00:00Z"},
    {"id": "T003", "title": "Dependent 1", "description": "Blocked by T001", "status": "pending", "priority": "medium", "phase": "core", "createdAt": "2025-12-01T12:00:00Z", "depends": ["T001"]},
    {"id": "T004", "title": "Dependent 2", "description": "Blocked by T001", "status": "pending", "priority": "medium", "phase": "core", "createdAt": "2025-12-01T13:00:00Z", "depends": ["T001"]},
    {"id": "T005", "title": "Dependent 3", "description": "Blocked by T001", "status": "pending", "priority": "medium", "phase": "core", "createdAt": "2025-12-01T14:00:00Z", "depends": ["T001"]},
    {"id": "T006", "title": "Dependent 4", "description": "Blocked by T001", "status": "pending", "priority": "medium", "phase": "core", "createdAt": "2025-12-01T15:00:00Z", "depends": ["T001"]},
    {"id": "T007", "title": "Dependent of T002", "description": "Blocked by T002", "status": "pending", "priority": "low", "phase": "testing", "createdAt": "2025-12-01T16:00:00Z", "depends": ["T002"]}
  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "lastUpdated": "2025-12-01T16:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# =============================================================================
# Basic Execution Tests
# =============================================================================

@test "analyze: runs without error on valid project" {
    create_analysis_fixture
    run claude-todo analyze
    [ "$status" -eq 0 ]
}

@test "analyze: displays help with --help flag" {
    run claude-todo analyze --help
    [ "$status" -eq 0 ]
    [[ "$output" =~ "Usage:" ]]
    [[ "$output" =~ "analyze" ]]
}

@test "analyze: displays help with -h flag" {
    run claude-todo analyze -h
    [ "$status" -eq 0 ]
    [[ "$output" =~ "Usage:" ]]
}

@test "analyze: outputs valid JSON with --json flag" {
    create_analysis_fixture
    run claude-todo analyze --json
    [ "$status" -eq 0 ]
    # Validate JSON structure (batched jq assertion)
    echo "$output" | jq -e 'has("leverage") and has("bottlenecks") and has("tiers")' > /dev/null
}

@test "analyze: fails gracefully on uninitialized project" {
    rm -rf "$CLAUDE_TODO_DIR"
    run claude-todo analyze
    [ "$status" -ne 0 ]
    [[ "$output" =~ "not initialized" || "$output" =~ "todo.json not found" ]]
}

# =============================================================================
# Leverage Scoring Tests
# =============================================================================

@test "analyze: task blocking 3 others scores higher than task blocking 1" {
    create_analysis_fixture
    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    # T001 blocks 3 tasks (T002, T003, T004), T002 blocks 1 task (T005)
    t001_score=$(echo "$output" | jq -r '.leverage[] | select(.id == "T001") | .score')
    t002_score=$(echo "$output" | jq -r '.leverage[] | select(.id == "T002") | .score')

    # T001 should have higher score than T002
    [ "$(echo "$t001_score > $t002_score" | bc)" -eq 1 ]
}

@test "analyze: critical priority tasks get higher leverage scores" {
    create_analysis_fixture
    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    # T001 is critical priority, T002 is high priority
    t001_score=$(echo "$output" | jq -r '.leverage[] | select(.id == "T001") | .score')
    t002_score=$(echo "$output" | jq -r '.leverage[] | select(.id == "T002") | .score')

    # Critical priority should contribute to higher score
    [ "$(echo "$t001_score > $t002_score" | bc)" -eq 1 ]
}

@test "analyze: empty project returns empty leverage array" {
    create_empty_todo
    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    leverage_count=$(echo "$output" | jq '.leverage | length')
    [ "$leverage_count" -eq 0 ]
}

@test "analyze: leverage array is sorted by score descending" {
    create_analysis_fixture
    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    # Extract scores and verify descending order
    scores=$(echo "$output" | jq -r '.leverage[].score')
    prev_score=""
    while IFS= read -r score; do
        if [ -n "$prev_score" ]; then
            [ "$(echo "$prev_score >= $score" | bc)" -eq 1 ]
        fi
        prev_score="$score"
    done <<< "$scores"
}

# =============================================================================
# Bottleneck Detection Tests
# =============================================================================

@test "analyze: task with 3+ dependents identified as bottleneck" {
    create_bottleneck_fixture
    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    # T001 has 4 dependents, should be flagged as bottleneck
    bottleneck_ids=$(echo "$output" | jq -r '.bottlenecks[].id')
    [[ "$bottleneck_ids" =~ "T001" ]]
}

@test "analyze: task with 0-1 dependents not flagged as bottleneck" {
    create_bottleneck_fixture
    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    # T002 has only 1 dependent, should not be flagged
    bottleneck_ids=$(echo "$output" | jq -r '.bottlenecks[].id')
    [[ ! "$bottleneck_ids" =~ "T002" ]]
}

@test "analyze: completed tasks not flagged as bottlenecks" {
    create_tasks_with_completed
    # Add dependencies to make completed task look like bottleneck
    jq '.tasks[1].depends = ["T001"]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    jq '.tasks += [{"id": "T003", "title": "Test", "description": "Test task", "status": "pending", "priority": "medium", "phase": "setup", "createdAt": "2025-12-01T12:00:00Z", "depends": ["T001"]}]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    jq '.tasks += [{"id": "T004", "title": "Test2", "description": "Test task 2", "status": "pending", "priority": "medium", "phase": "setup", "createdAt": "2025-12-01T13:00:00Z", "depends": ["T001"]}]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    _update_fixture_checksum "$TODO_FILE"

    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    # T001 is done, should not be flagged as bottleneck even with 3 dependents
    bottleneck_ids=$(echo "$output" | jq -r '.bottlenecks[].id')
    [[ ! "$bottleneck_ids" =~ "T001" ]]
}

@test "analyze: bottleneck includes dependent count" {
    create_bottleneck_fixture
    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    # T001 should show 4 dependents
    t001_deps=$(echo "$output" | jq -r '.bottlenecks[] | select(.id == "T001") | .dependentCount')
    [ "$t001_deps" -eq 4 ]
}

@test "analyze: empty project has no bottlenecks" {
    create_empty_todo
    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    bottleneck_count=$(echo "$output" | jq '.bottlenecks | length')
    [ "$bottleneck_count" -eq 0 ]
}

# =============================================================================
# Tier Assignment Tests
# =============================================================================

@test "analyze: high-leverage tasks assigned to Tier 1" {
    create_analysis_fixture
    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    # T001 has highest leverage, should be in Tier 1
    tier1_ids=$(echo "$output" | jq -r '.tiers.tier1[].id')
    [[ "$tier1_ids" =~ "T001" ]]
}

@test "analyze: critical priority tasks appear in early tiers" {
    create_analysis_fixture
    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    # T001 is critical, should be in tier1 or tier2
    tier1_ids=$(echo "$output" | jq -r '.tiers.tier1[].id')
    tier2_ids=$(echo "$output" | jq -r '.tiers.tier2[].id')
    [[ "$tier1_ids" =~ "T001" || "$tier2_ids" =~ "T001" ]]
}

@test "analyze: blocked tasks in lower tiers" {
    create_blocked_tasks
    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    # T002 and T003 are blocked, should not be in tier1
    tier1_ids=$(echo "$output" | jq -r '.tiers.tier1[].id')
    [[ ! "$tier1_ids" =~ "T002" ]]
    [[ ! "$tier1_ids" =~ "T003" ]]
}

@test "analyze: tiers contain all pending tasks" {
    create_analysis_fixture
    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    # Count pending tasks
    pending_count=$(jq '[.tasks[] | select(.status == "pending")] | length' "$TODO_FILE")

    # Count tasks across all tiers
    tier_count=$(echo "$output" | jq '[.tiers.tier1[], .tiers.tier2[], .tiers.tier3[]] | length')

    [ "$tier_count" -eq "$pending_count" ]
}

@test "analyze: empty project has empty tiers" {
    create_empty_todo
    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    # Batched jq assertion for all tier counts
    echo "$output" | jq -e '
        (.tiers.tier1 | length) == 0 and
        (.tiers.tier2 | length) == 0 and
        (.tiers.tier3 | length) == 0
    ' > /dev/null
}

# =============================================================================
# Output Format Tests
# =============================================================================

@test "analyze: brief mode shows expected sections" {
    create_analysis_fixture
    run claude-todo analyze --brief
    [ "$status" -eq 0 ]

    # Should have high-leverage and bottleneck sections
    [[ "$output" =~ "High-Leverage" || "$output" =~ "HIGH LEVERAGE" ]]
    [[ "$output" =~ "Bottleneck" || "$output" =~ "BOTTLENECK" ]]
}

@test "analyze: JSON mode is valid and parseable" {
    create_analysis_fixture
    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    # Must be valid JSON
    echo "$output" | jq . > /dev/null
}

@test "analyze: JSON output has required top-level keys" {
    create_analysis_fixture
    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    # Batched jq assertion for all required keys
    echo "$output" | jq -e 'has("leverage") and has("bottlenecks") and has("tiers") and has("recommendation")' > /dev/null
}

@test "analyze: full mode includes all sections" {
    create_analysis_fixture
    run claude-todo analyze
    [ "$status" -eq 0 ]

    # Full mode should show leverage, bottlenecks, tiers
    [[ "$output" =~ "Leverage" || "$output" =~ "LEVERAGE" ]]
    [[ "$output" =~ "Bottleneck" || "$output" =~ "BOTTLENECK" ]]
    [[ "$output" =~ "Tier" || "$output" =~ "TIER" ]]
}

@test "analyze: output includes recommendation" {
    create_analysis_fixture
    run claude-todo analyze
    [ "$status" -eq 0 ]

    [[ "$output" =~ "Recommend" || "$output" =~ "RECOMMEND" || "$output" =~ "suggested" ]]
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "analyze: handles empty project gracefully" {
    create_empty_todo
    run claude-todo analyze
    [ "$status" -eq 0 ]
    [[ "$output" =~ "No tasks" || "$output" =~ "empty" || "$output" =~ "0 tasks" ]]
}

@test "analyze: handles all tasks completed" {
    create_tasks_with_completed
    # Mark all tasks as done
    jq '.tasks[].status = "done"' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    _update_fixture_checksum "$TODO_FILE"

    run claude-todo analyze
    [ "$status" -eq 0 ]
    [[ "$output" =~ "No pending tasks" || "$output" =~ "All tasks complete" || "$output" =~ "0 pending" ]]
}

@test "analyze: handles circular dependencies without crash" {
    create_circular_deps
    run claude-todo analyze
    # Should not crash, even if results are undefined
    [ "$status" -eq 0 ] || [ "$status" -eq 1 ]
}

@test "analyze: handles single task project" {
    create_empty_todo
    add_task_to_fixture "T001" "Only task" "pending"

    run claude-todo analyze --json
    [ "$status" -eq 0 ]

    # Single task should be recommended
    recommendation=$(echo "$output" | jq -r '.recommendation.id')
    [ "$recommendation" = "T001" ]
}

@test "analyze: handles project with only blocked tasks" {
    create_blocked_tasks
    run claude-todo analyze
    [ "$status" -eq 0 ]

    # Should recommend the unblocked root task
    [[ "$output" =~ "T001" ]]
}

# =============================================================================
# Auto-focus Integration Tests
# =============================================================================

@test "analyze: --auto-focus sets focus to recommended task" {
    create_analysis_fixture
    run claude-todo analyze --auto-focus
    [ "$status" -eq 0 ]

    # Focus should be set
    [ -f "$FOCUS_FILE" ]

    # Should be the highest-leverage task (T001)
    focused_id=$(jq -r '.taskId' "$FOCUS_FILE")
    [ "$focused_id" = "T001" ]
}

@test "analyze: --auto-focus updates focus.json correctly" {
    create_analysis_fixture
    run claude-todo analyze --auto-focus
    [ "$status" -eq 0 ]

    # Batched jq assertion for focus.json structure
    jq -e 'has("taskId") and has("startedAt")' "$FOCUS_FILE" > /dev/null
}

@test "analyze: --auto-focus with empty project does not create focus" {
    create_empty_todo
    run claude-todo analyze --auto-focus
    [ "$status" -eq 0 ]

    # No focus should be created for empty project
    if [ -f "$FOCUS_FILE" ]; then
        focused_id=$(jq -r '.taskId' "$FOCUS_FILE")
        [ "$focused_id" = "null" ]
    fi
}

@test "analyze: --auto-focus shows confirmation message" {
    create_analysis_fixture
    run claude-todo analyze --auto-focus
    [ "$status" -eq 0 ]

    [[ "$output" =~ "Focus set" || "$output" =~ "Focused on" || "$output" =~ "T001" ]]
}
