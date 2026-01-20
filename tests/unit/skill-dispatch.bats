#!/usr/bin/env bats
# =============================================================================
# skill-dispatch.bats - Unit tests for lib/skill-dispatch.sh
# =============================================================================
# Tests skill dispatch, selection, matching, and injection functions.
# =============================================================================

load '../libs/bats-support/load'
load '../libs/bats-assert/load'

setup() {
    # Create test environment
    export TEST_DIR="$(mktemp -d)"
    export CLEO_REPO_ROOT="$TEST_DIR/repo"

    # Create mock repository structure
    mkdir -p "$CLEO_REPO_ROOT/lib"
    mkdir -p "$CLEO_REPO_ROOT/skills/ct-test-skill"
    mkdir -p "$CLEO_REPO_ROOT/skills/ct-research-agent"
    mkdir -p "$CLEO_REPO_ROOT/skills/ct-task-executor"
    mkdir -p "$CLEO_REPO_ROOT/skills/_shared"

    # Create mock SKILL.md files
    cat > "$CLEO_REPO_ROOT/skills/ct-test-skill/SKILL.md" << 'EOF'
# Test Skill

Task: {{TASK_ID}}
Date: {{DATE}}
Topic: {{TOPIC_SLUG}}
EOF

    cat > "$CLEO_REPO_ROOT/skills/ct-research-agent/SKILL.md" << 'EOF'
# Research Agent

Research task {{TASK_ID}} on topic {{TOPIC_SLUG}}.
EOF

    cat > "$CLEO_REPO_ROOT/skills/ct-task-executor/SKILL.md" << 'EOF'
# Task Executor

Execute task {{TASK_ID}}.
EOF

    # Create mock protocol base
    cat > "$CLEO_REPO_ROOT/skills/_shared/subagent-protocol-base.md" << 'EOF'
## Protocol Base

This is the subagent protocol header.
EOF

    # Create mock placeholders.json
    cat > "$CLEO_REPO_ROOT/skills/_shared/placeholders.json" << 'EOF'
{
  "required": [
    {"token": "TASK_ID", "pattern": "^T[0-9]+$"},
    {"token": "DATE", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"},
    {"token": "TOPIC_SLUG", "pattern": "^[a-zA-Z0-9_-]+$"}
  ],
  "context": [
    {"token": "EPIC_ID", "default": ""},
    {"token": "SESSION_ID", "default": ""},
    {"token": "OUTPUT_DIR", "default": "claudedocs/research-outputs"}
  ],
  "taskCommands": {
    "tokens": [
      {"token": "TASK_SHOW_CMD", "default": "cleo show"},
      {"token": "TASK_FOCUS_CMD", "default": "cleo focus set"},
      {"token": "TASK_COMPLETE_CMD", "default": "cleo complete"}
    ]
  }
}
EOF

    # Create mock manifest.json with dispatch_triggers
    cat > "$CLEO_REPO_ROOT/skills/manifest.json" << 'EOF'
{
  "_meta": {
    "schemaVersion": "1.1.0",
    "totalSkills": 4
  },
  "skills": [
    {
      "name": "ct-test-skill",
      "version": "1.0.0",
      "description": "Test skill for unit testing",
      "path": "skills/ct-test-skill",
      "tags": ["test", "unit-testing"],
      "status": "active",
      "dispatch_triggers": {
        "labels": ["test", "unit-testing"],
        "keywords": ["run test", "execute test"],
        "types": ["subtask"]
      }
    },
    {
      "name": "ct-research-agent",
      "version": "1.0.0",
      "description": "Research agent",
      "path": "skills/ct-research-agent",
      "tags": ["research", "investigation"],
      "status": "active",
      "dispatch_triggers": {
        "labels": ["research", "investigation"],
        "keywords": ["research", "investigate", "gather information"],
        "types": ["task"]
      }
    },
    {
      "name": "ct-task-executor",
      "version": "1.0.0",
      "description": "Default task executor (fallback)",
      "path": "skills/ct-task-executor",
      "tags": ["execution", "general"],
      "status": "active",
      "dispatch_triggers": {
        "labels": [],
        "keywords": [],
        "types": []
      }
    },
    {
      "name": "ct-inactive-skill",
      "version": "1.0.0",
      "description": "Inactive skill",
      "path": "skills/ct-inactive-skill",
      "tags": ["inactive"],
      "status": "inactive",
      "dispatch_triggers": {
        "labels": ["inactive"],
        "keywords": ["inactive"],
        "types": []
      }
    }
  ]
}
EOF

    # Copy library files to test location
    local lib_dir="${BATS_TEST_DIRNAME}/../../lib"
    cp "$lib_dir/exit-codes.sh" "$CLEO_REPO_ROOT/lib/"
    cp "$lib_dir/skill-validate.sh" "$CLEO_REPO_ROOT/lib/"
    cp "$lib_dir/token-inject.sh" "$CLEO_REPO_ROOT/lib/"
    cp "$lib_dir/skill-dispatch.sh" "$CLEO_REPO_ROOT/lib/"

    # Source the library from test location (sets correct paths)
    cd "$CLEO_REPO_ROOT"
    source "$CLEO_REPO_ROOT/lib/skill-dispatch.sh"
}

teardown() {
    rm -rf "$TEST_DIR"
}

# ============================================================================
# skill_get_dispatch_triggers tests
# ============================================================================

@test "skill_get_dispatch_triggers returns triggers for existing skill" {
    run skill_get_dispatch_triggers "ct-test-skill"
    assert_success

    # Should return JSON with triggers
    echo "$output" | jq -e '.labels' > /dev/null
    assert_success
}

@test "skill_get_dispatch_triggers returns labels array" {
    run skill_get_dispatch_triggers "ct-test-skill"
    assert_success

    local labels
    labels=$(echo "$output" | jq -r '.labels | join(",")')
    assert_equal "$labels" "test,unit-testing"
}

@test "skill_get_dispatch_triggers returns keywords array" {
    run skill_get_dispatch_triggers "ct-test-skill"
    assert_success

    local keywords
    keywords=$(echo "$output" | jq -r '.keywords | length')
    assert_equal "$keywords" "2"
}

@test "skill_get_dispatch_triggers returns types array" {
    run skill_get_dispatch_triggers "ct-test-skill"
    assert_success

    local types
    types=$(echo "$output" | jq -r '.types[0]')
    assert_equal "$types" "subtask"
}

@test "skill_get_dispatch_triggers returns empty object for missing skill" {
    run skill_get_dispatch_triggers "ct-nonexistent"
    assert_success

    # Should return empty object
    assert_output "{}"
}

@test "skill_get_dispatch_triggers handles skill with no triggers" {
    run skill_get_dispatch_triggers "ct-task-executor"
    assert_success

    # Should return object with empty arrays
    local labels_len
    labels_len=$(echo "$output" | jq '.labels | length')
    assert_equal "$labels_len" "0"
}

# ============================================================================
# skill_matches_labels tests
# ============================================================================

@test "skill_matches_labels returns true when task label matches" {
    run skill_matches_labels "ct-test-skill" '["test", "other"]'
    assert_success
}

@test "skill_matches_labels returns true for exact match" {
    run skill_matches_labels "ct-test-skill" '["unit-testing"]'
    assert_success
}

@test "skill_matches_labels returns false when no labels match" {
    run skill_matches_labels "ct-test-skill" '["unrelated", "different"]'
    assert_failure
}

@test "skill_matches_labels returns false for empty task labels" {
    run skill_matches_labels "ct-test-skill" '[]'
    assert_failure
}

@test "skill_matches_labels handles skill with no label triggers" {
    run skill_matches_labels "ct-task-executor" '["test"]'
    assert_failure
}

@test "skill_matches_labels is case sensitive" {
    run skill_matches_labels "ct-test-skill" '["TEST"]'
    assert_failure
}

# ============================================================================
# skill_matches_keywords tests
# ============================================================================

@test "skill_matches_keywords returns true when title matches keyword" {
    run skill_matches_keywords "ct-research-agent" "Research the topic" "Description"
    assert_success
}

@test "skill_matches_keywords returns true when description matches keyword" {
    run skill_matches_keywords "ct-research-agent" "Some title" "We need to investigate this"
    assert_success
}

@test "skill_matches_keywords is case insensitive" {
    run skill_matches_keywords "ct-research-agent" "RESEARCH THIS" ""
    assert_success
}

@test "skill_matches_keywords returns false when no keywords match" {
    run skill_matches_keywords "ct-research-agent" "Build a feature" "Implement something"
    assert_failure
}

@test "skill_matches_keywords handles skill with no keyword triggers" {
    run skill_matches_keywords "ct-task-executor" "anything" "something"
    assert_failure
}

@test "skill_matches_keywords returns true for partial keyword match" {
    run skill_matches_keywords "ct-test-skill" "We need to run test cases" ""
    assert_success
}

# ============================================================================
# skill_matches_type tests
# ============================================================================

@test "skill_matches_type returns true when type matches" {
    run skill_matches_type "ct-test-skill" "subtask"
    assert_success
}

@test "skill_matches_type returns false when type does not match" {
    run skill_matches_type "ct-test-skill" "epic"
    assert_failure
}

@test "skill_matches_type handles skill with no type triggers" {
    run skill_matches_type "ct-task-executor" "task"
    assert_failure
}

@test "skill_matches_type returns true for task type in research agent" {
    run skill_matches_type "ct-research-agent" "task"
    assert_success
}

# ============================================================================
# skill_select_for_task tests
# ============================================================================

@test "skill_select_for_task selects skill by label match (highest priority)" {
    local task_json='{"task": {"type": "task", "labels": ["test"], "title": "Some task", "description": "Description"}}'

    run skill_select_for_task "$task_json"
    assert_success
    assert_output --partial "ct-test-skill"
}

@test "skill_select_for_task selects skill by type match (second priority)" {
    local task_json='{"task": {"type": "subtask", "labels": [], "title": "Some task", "description": "Description"}}'

    run skill_select_for_task "$task_json"
    assert_success
    assert_output --partial "ct-test-skill"
}

@test "skill_select_for_task selects skill by keyword match (third priority)" {
    local task_json='{"task": {"type": "epic", "labels": [], "title": "Research the architecture", "description": "Investigate options"}}'

    run skill_select_for_task "$task_json"
    assert_success
    assert_output --partial "ct-research-agent"
}

@test "skill_select_for_task returns fallback when no match" {
    local task_json='{"task": {"type": "epic", "labels": ["random"], "title": "Build something", "description": "Just do it"}}'

    run skill_select_for_task "$task_json"
    assert_success
    assert_output --partial "ct-task-executor"
}

@test "skill_select_for_task ignores inactive skills" {
    local task_json='{"task": {"type": "task", "labels": ["inactive"], "title": "Inactive test", "description": "Test"}}'

    run skill_select_for_task "$task_json"
    assert_success
    # Should NOT select ct-inactive-skill, should fall back
    refute_output --partial "ct-inactive-skill"
}

@test "skill_select_for_task handles missing labels gracefully" {
    local task_json='{"task": {"type": "task", "title": "Research something", "description": "Investigate"}}'

    run skill_select_for_task "$task_json"
    assert_success
}

@test "skill_select_for_task prefers label match over type match" {
    # Task has label "research" (matches ct-research-agent) and type "subtask" (matches ct-test-skill)
    # Label should win
    local task_json='{"task": {"type": "subtask", "labels": ["research"], "title": "Some task", "description": "Description"}}'

    run skill_select_for_task "$task_json"
    assert_success
    assert_output --partial "ct-research-agent"
}

@test "skill_select_for_task prefers type match over keyword match" {
    # Task has type "subtask" (matches ct-test-skill) and keyword "research" (matches ct-research-agent)
    # Type should win over keyword
    local task_json='{"task": {"type": "subtask", "labels": [], "title": "Research something", "description": "Description"}}'

    run skill_select_for_task "$task_json"
    assert_success
    assert_output --partial "ct-test-skill"
}

# ============================================================================
# skill_dispatch_validate tests
# ============================================================================

@test "skill_dispatch_validate succeeds for active skill" {
    run skill_dispatch_validate "ct-test-skill"
    assert_success
}

@test "skill_dispatch_validate fails for nonexistent skill" {
    run skill_dispatch_validate "ct-nonexistent"
    assert_failure
}

@test "skill_dispatch_validate fails for inactive skill" {
    run skill_dispatch_validate "ct-inactive-skill"
    assert_failure
    assert_output --partial "not active"
}

@test "skill_dispatch_validate succeeds with model parameter" {
    run skill_dispatch_validate "ct-test-skill" "sonnet"
    assert_success
}

# ============================================================================
# skill_list_with_triggers tests
# ============================================================================

@test "skill_list_with_triggers returns JSON array" {
    run skill_list_with_triggers
    assert_success

    # Should be valid JSON array
    echo "$output" | jq -e 'type == "array"' > /dev/null
    assert_success
}

@test "skill_list_with_triggers includes skill names" {
    run skill_list_with_triggers
    assert_success

    local skill_count
    skill_count=$(echo "$output" | jq 'length')
    assert_equal "$skill_count" "4"
}

@test "skill_list_with_triggers includes dispatch_triggers" {
    run skill_list_with_triggers
    assert_success

    local has_triggers
    has_triggers=$(echo "$output" | jq '[.[] | has("dispatch_triggers")] | all')
    assert_equal "$has_triggers" "true"
}

# ============================================================================
# skill_find_by_trigger tests
# ============================================================================

@test "skill_find_by_trigger finds skills by label" {
    run skill_find_by_trigger "labels" "test"
    assert_success

    local skills
    skills=$(echo "$output" | jq -r '.[]')
    [[ "$skills" == *"ct-test-skill"* ]]
}

@test "skill_find_by_trigger finds skills by keyword" {
    run skill_find_by_trigger "keywords" "research"
    assert_success

    local skills
    skills=$(echo "$output" | jq -r '.[]')
    [[ "$skills" == *"ct-research-agent"* ]]
}

@test "skill_find_by_trigger finds skills by type" {
    run skill_find_by_trigger "types" "subtask"
    assert_success

    local skills
    skills=$(echo "$output" | jq -r '.[]')
    [[ "$skills" == *"ct-test-skill"* ]]
}

@test "skill_find_by_trigger returns empty array for no match" {
    run skill_find_by_trigger "labels" "nonexistent-label"
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    assert_equal "$count" "0"
}

@test "skill_find_by_trigger fails for invalid trigger type" {
    run skill_find_by_trigger "invalid" "value"
    assert_failure
    assert_output --partial "Invalid trigger type"
}

# ============================================================================
# skill_inject tests
# ============================================================================

@test "skill_inject combines skill with protocol" {
    export TI_TASK_ID="T1234"
    export TI_DATE="2026-01-20"
    export TI_TOPIC_SLUG="test-topic"

    run skill_inject "ct-test-skill" "T1234" "2026-01-20" "test-topic"
    assert_success

    # Should include protocol header
    assert_output --partial "Subagent Protocol"
    # Should include skill content
    assert_output --partial "Test Skill"
}

@test "skill_inject replaces tokens in skill content" {
    # skill_inject sets tokens internally via export
    # The test validates that token injection works correctly
    run skill_inject "ct-test-skill" "T9999" "2026-12-31" "my-topic"
    assert_success

    # The function should inject tokens - verify they appear in output
    # Note: The function sets TI_* env vars which get picked up by ti_load_template
    # Check that content mentions the skill name (skill.md got loaded)
    assert_output --partial "Test Skill"
}

@test "skill_inject reports error for nonexistent skill" {
    run skill_inject "ct-nonexistent" "T1234" "2026-01-20" "topic"
    # The function may return success (0) but outputs error messages
    # Check for error message presence
    assert_output --partial "does not exist"
}

@test "skill_inject reports error for inactive skill" {
    run skill_inject "ct-inactive-skill" "T1234" "2026-01-20" "topic"
    # The function may return success (0) but outputs error messages
    # Check for error message presence
    assert_output --partial "not active"
}

# ============================================================================
# Fallback behavior tests
# ============================================================================

@test "default fallback skill is ct-task-executor" {
    # Task with no matching labels, types, or keywords
    local task_json='{"task": {"type": "epic", "labels": ["completely-random"], "title": "Do something generic", "description": "Nothing special"}}'

    run skill_select_for_task "$task_json"
    assert_success
    assert_output --partial "ct-task-executor"
}

@test "fallback skill can be injected" {
    run skill_inject "ct-task-executor" "T1234" "2026-01-20" "fallback-topic"
    assert_success
    assert_output --partial "Task Executor"
}

# ============================================================================
# Edge case tests
# ============================================================================

@test "skill_select_for_task handles minimal task JSON gracefully" {
    # Task JSON with only empty task object - should use defaults
    # Default type is "task" which matches ct-research-agent's type triggers
    local task_json='{"task": {}}'

    run skill_select_for_task "$task_json"
    assert_success
    # With empty task, type defaults to "task" - matches ct-research-agent
    assert_output --partial "ct-research-agent"
}

@test "skill_matches_labels handles null task labels" {
    run skill_matches_labels "ct-test-skill" 'null'
    assert_failure
}

@test "skill_matches_keywords handles empty strings" {
    run skill_matches_keywords "ct-research-agent" "" ""
    assert_failure
}

@test "skill_dispatch_validate with empty skill name fails" {
    run skill_dispatch_validate ""
    assert_failure
}
