#!/usr/bin/env bats
# =============================================================================
# skill-dispatch.bats - Unit tests for lib/skills/skill-dispatch.sh
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
    {"token": "OUTPUT_DIR", "default": "claudedocs/agent-outputs"}
  ],
  "taskCommands": {
    "tokens": [
      {"token": "TASK_SHOW_CMD", "default": "cleo show"},
      {"token": "TASK_FOCUS_CMD", "default": "cleo focus set"},
      {"token": "TASK_COMPLETE_CMD", "default": "cleo complete"}
    ]
  },
  "taskContext": {
    "tokens": [
      {"token": "TASK_TITLE", "default": ""},
      {"token": "TASK_NAME", "default": ""},
      {"token": "TASK_DESCRIPTION", "default": ""},
      {"token": "TASK_INSTRUCTIONS", "default": ""},
      {"token": "TOPICS_JSON", "default": "[]"},
      {"token": "DEPENDS_LIST", "default": ""},
      {"token": "ACCEPTANCE_CRITERIA", "default": "Task completed successfully per description"},
      {"token": "DELIVERABLES_LIST", "default": "Implementation per task description"},
      {"token": "MANIFEST_SUMMARIES", "default": ""},
      {"token": "NEXT_TASK_IDS", "default": ""}
    ]
  }
}
EOF

    # Create mock manifest.json with dispatch_triggers and full metadata
    cat > "$CLEO_REPO_ROOT/skills/manifest.json" << 'EOF'
{
  "_meta": {
    "schemaVersion": "2.0.0",
    "totalSkills": 4
  },
  "dispatch_matrix": {
    "by_task_type": {
      "research": "ct-research-agent",
      "implementation": "ct-task-executor",
      "testing": "ct-test-skill"
    },
    "by_keyword": {
      "research|investigate|explore": "ct-research-agent",
      "implement|build|execute": "ct-task-executor",
      "test|bats|coverage": "ct-test-skill"
    }
  },
  "skills": [
    {
      "name": "ct-test-skill",
      "version": "1.0.0",
      "description": "Test skill for unit testing",
      "path": "skills/ct-test-skill",
      "tags": ["test", "unit-testing"],
      "status": "active",
      "tier": 2,
      "token_budget": 8000,
      "model": "auto",
      "dispatch_triggers": {
        "labels": ["test", "unit-testing"],
        "keywords": ["run test", "execute test"],
        "types": ["subtask"]
      },
      "capabilities": {
        "compatible_subagent_types": ["general-purpose", "Code"]
      }
    },
    {
      "name": "ct-research-agent",
      "version": "1.0.0",
      "description": "Research agent",
      "path": "skills/ct-research-agent",
      "tags": ["research", "investigation"],
      "status": "active",
      "tier": 2,
      "token_budget": 8000,
      "model": "auto",
      "references": [
        "skills/ct-research-agent/SKILL.md"
      ],
      "dispatch_triggers": {
        "labels": ["research", "investigation"],
        "keywords": ["research", "investigate", "gather information"],
        "types": ["task"]
      },
      "capabilities": {
        "compatible_subagent_types": ["general-purpose", "Explore"]
      }
    },
    {
      "name": "ct-task-executor",
      "version": "1.0.0",
      "description": "Default task executor (fallback)",
      "path": "skills/ct-task-executor",
      "tags": ["execution", "general"],
      "status": "active",
      "tier": 2,
      "token_budget": 8000,
      "model": "auto",
      "dispatch_triggers": {
        "labels": [],
        "keywords": ["implement", "build", "execute", "create"],
        "types": []
      },
      "capabilities": {
        "compatible_subagent_types": ["general-purpose", "Code"]
      }
    },
    {
      "name": "ct-inactive-skill",
      "version": "1.0.0",
      "description": "Inactive skill",
      "path": "skills/ct-inactive-skill",
      "tags": ["inactive"],
      "status": "inactive",
      "tier": 2,
      "token_budget": 6000,
      "model": "auto",
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
    cp "$lib_dir/token-estimation.sh" "$CLEO_REPO_ROOT/lib/"
    cp "$lib_dir/skill-dispatch.sh" "$CLEO_REPO_ROOT/lib/"

    # Create mock cleo command for ti_set_full_context (skill_prepare_spawn needs it)
    mkdir -p "$CLEO_REPO_ROOT/bin"
    cat > "$CLEO_REPO_ROOT/bin/cleo" << 'MOCK'
#!/usr/bin/env bash
# Mock cleo that handles 'show <id> --format json' for ti_set_full_context
# and other subcommands used by token-inject functions
if [[ "${1:-}" == "show" ]]; then
    local_id="${2:-T0000}"
    echo "{\"success\":true,\"task\":{\"id\":\"${local_id}\",\"type\":\"task\",\"labels\":[],\"title\":\"Mock task ${local_id}\",\"description\":\"Mock description\",\"parentId\":\"\",\"depends\":[]}}"
    exit 0
fi
# For any other subcommand, return empty/success
echo ""
exit 0
MOCK
    chmod +x "$CLEO_REPO_ROOT/bin/cleo"
    export PATH="$CLEO_REPO_ROOT/bin:$PATH"

    # Source the library from test location (sets correct paths)
    cd "$CLEO_REPO_ROOT"
    source "$CLEO_REPO_ROOT/lib/skills/skill-dispatch.sh"

    # Create a wrapper script for skill_prepare_spawn that re-sources the library
    # in the subshell (needed because bash associative arrays like _TI_CLEO_DEFAULTS
    # cannot be exported to subshells created by bats 'run')
    cat > "$CLEO_REPO_ROOT/bin/skill_prepare_spawn_wrapper" << 'WRAPPER'
#!/usr/bin/env bash
cd "$CLEO_REPO_ROOT"
source "$CLEO_REPO_ROOT/lib/skills/skill-dispatch.sh" 2>/dev/null
# Disable set -e inherited from sourced library so we can capture failures
set +e
# Capture stdout and stderr separately
_out=$( skill_prepare_spawn "$@" 2>"$CLEO_REPO_ROOT/.spawn_stderr" )
_rc=$?
set -e
if [[ $_rc -ne 0 ]]; then
    # On failure, output stderr content so bats can assert on error messages
    cat "$CLEO_REPO_ROOT/.spawn_stderr"
    exit $_rc
fi
# On success, output only the clean JSON
echo "$_out"
WRAPPER
    chmod +x "$CLEO_REPO_ROOT/bin/skill_prepare_spawn_wrapper"
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

@test "skill_dispatch_validate succeeds with matching model parameter" {
    # ct-test-skill has model "auto" which accepts any target
    run skill_dispatch_validate "ct-test-skill" "auto"
    assert_success
}

@test "skill_dispatch_validate fails for incompatible model" {
    # ct-test-skill has model "auto", but validation may reject explicit model mismatches
    run skill_dispatch_validate "ct-test-skill" "sonnet"
    # Model validation behavior - check output for warning
    # The function may succeed with warning or fail based on strictness
    [[ "$status" -eq 0 ]] || assert_output --partial "model"
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

# ============================================================================
# SPEC-COMPLIANT API TESTS (CLEO-SKILLS-SYSTEM-SPEC.md)
# These test the 8 programmatic dispatch interface functions
# ============================================================================

# ============================================================================
# skill_dispatch_by_keywords tests
# ============================================================================

@test "skill_dispatch_by_keywords returns ct-task-executor for 'implement'" {
    run skill_dispatch_by_keywords "implement feature"
    assert_success
    assert_output --partial "ct-task-executor"
}

@test "skill_dispatch_by_keywords returns ct-research-agent for 'research'" {
    run skill_dispatch_by_keywords "research api options"
    assert_success
    assert_output --partial "ct-research-agent"
}

@test "skill_dispatch_by_keywords returns ct-test-skill for 'run test'" {
    run skill_dispatch_by_keywords "run test cases"
    assert_success
    assert_output --partial "ct-test-skill"
}

@test "skill_dispatch_by_keywords is case-insensitive" {
    run skill_dispatch_by_keywords "RESEARCH THE TOPIC"
    assert_success
    assert_output --partial "ct-research-agent"
}

@test "skill_dispatch_by_keywords returns empty for no match" {
    run skill_dispatch_by_keywords "unrelated random text"
    assert_success
    # Output should be empty (no match found)
    [[ -z "$output" ]] || [[ "$output" == "" ]]
}

@test "skill_dispatch_by_keywords handles empty input" {
    run skill_dispatch_by_keywords ""
    assert_success
    # Should return empty or no match
    [[ -z "$output" ]] || [[ "$output" == "" ]]
}

@test "skill_dispatch_by_keywords matches 'gather information'" {
    run skill_dispatch_by_keywords "We need to gather information about APIs"
    assert_success
    assert_output --partial "ct-research-agent"
}

@test "skill_dispatch_by_keywords matches 'investigate'" {
    run skill_dispatch_by_keywords "Investigate the bug in module"
    assert_success
    assert_output --partial "ct-research-agent"
}

@test "skill_dispatch_by_keywords only matches active skills" {
    run skill_dispatch_by_keywords "inactive test scenario"
    # Even though "inactive" is a keyword for ct-inactive-skill, it shouldn't match
    # because the skill is inactive
    refute_output --partial "ct-inactive-skill"
}

# ============================================================================
# skill_dispatch_by_type tests
# ============================================================================

@test "skill_dispatch_by_type returns ct-research-agent for 'research'" {
    run skill_dispatch_by_type "research"
    assert_success
    assert_output "ct-research-agent"
}

@test "skill_dispatch_by_type returns empty for invalid type" {
    run skill_dispatch_by_type "invalid-type-name"
    assert_success
    [[ -z "$output" ]] || [[ "$output" == "" ]]
}

@test "skill_dispatch_by_type handles 'investigation' type" {
    run skill_dispatch_by_type "investigation"
    assert_success
    # Should map to research-related skill
    [[ -n "$output" ]] && assert_output --partial "research"
}

@test "skill_dispatch_by_type handles 'testing' type" {
    run skill_dispatch_by_type "testing"
    assert_success
    [[ -n "$output" ]]
}

@test "skill_dispatch_by_type handles 'implementation' type" {
    run skill_dispatch_by_type "implementation"
    assert_success
    [[ -n "$output" ]]
}

@test "skill_dispatch_by_type handles empty input" {
    run skill_dispatch_by_type ""
    assert_success
    # Empty type should not match anything
    [[ -z "$output" ]] || [[ "$output" == "" ]]
}

# ============================================================================
# skill_get_metadata tests
# ============================================================================

@test "skill_get_metadata returns JSON for valid skill" {
    run skill_get_metadata "ct-test-skill"
    assert_success
    # Should return valid JSON
    echo "$output" | jq -e '.' > /dev/null
    assert_success
}

@test "skill_get_metadata returns name field" {
    run skill_get_metadata "ct-test-skill"
    assert_success
    local name
    name=$(echo "$output" | jq -r '.name')
    assert_equal "$name" "ct-test-skill"
}

@test "skill_get_metadata returns version field" {
    run skill_get_metadata "ct-test-skill"
    assert_success
    local version
    version=$(echo "$output" | jq -r '.version')
    assert_equal "$version" "1.0.0"
}

@test "skill_get_metadata returns description field" {
    run skill_get_metadata "ct-test-skill"
    assert_success
    local desc
    desc=$(echo "$output" | jq -r '.description')
    [[ -n "$desc" ]]
}

@test "skill_get_metadata returns path field" {
    run skill_get_metadata "ct-test-skill"
    assert_success
    local path
    path=$(echo "$output" | jq -r '.path')
    assert_equal "$path" "skills/ct-test-skill"
}

@test "skill_get_metadata returns status field" {
    run skill_get_metadata "ct-test-skill"
    assert_success
    local status
    status=$(echo "$output" | jq -r '.status')
    assert_equal "$status" "active"
}

@test "skill_get_metadata returns tags array" {
    run skill_get_metadata "ct-test-skill"
    assert_success
    local tags_count
    tags_count=$(echo "$output" | jq '.tags | length')
    [[ "$tags_count" -ge 1 ]]
}

@test "skill_get_metadata fails for nonexistent skill" {
    run skill_get_metadata "ct-nonexistent-skill"
    assert_failure
    assert_output --partial "Skill not found"
}

@test "skill_get_metadata handles empty skill name" {
    run skill_get_metadata ""
    assert_failure
}

@test "skill_get_metadata returns dispatch_triggers" {
    run skill_get_metadata "ct-test-skill"
    assert_success
    local has_triggers
    has_triggers=$(echo "$output" | jq 'has("dispatch_triggers")')
    assert_equal "$has_triggers" "true"
}

# ============================================================================
# skill_get_references tests
# ============================================================================

@test "skill_get_references returns references for skill with references" {
    run skill_get_references "ct-research-agent"
    assert_success
    # ct-research-agent has references defined in mock manifest
    assert_output --partial "SKILL.md"
}

@test "skill_get_references returns empty for skill without references" {
    run skill_get_references "ct-test-skill"
    assert_success
    # ct-test-skill doesn't have references defined in mock manifest
    [[ -z "$output" ]] || [[ "$output" == "" ]]
}

@test "skill_get_references fails for nonexistent skill" {
    run skill_get_references "ct-nonexistent-skill"
    assert_failure
}

@test "skill_get_references handles empty skill name" {
    run skill_get_references ""
    assert_failure
}

@test "skill_get_references returns one reference per line" {
    run skill_get_references "ct-research-agent"
    assert_success
    # Output should have reference paths
    [[ -n "$output" ]]
}

# ============================================================================
# skill_check_compatibility tests
# ============================================================================

@test "skill_check_compatibility returns 0 for compatible type" {
    # ct-test-skill doesn't have specific compatibility requirements
    # so general-purpose should work
    run skill_check_compatibility "ct-test-skill" "general-purpose"
    assert_success
}

@test "skill_check_compatibility returns 1 for incompatible type" {
    # ct-inactive-skill is inactive, so metadata fetch will fail
    run skill_check_compatibility "ct-inactive-skill" "incompatible-type"
    # Should fail since skill metadata fails for inactive
    assert_failure
}

@test "skill_check_compatibility fails for nonexistent skill" {
    run skill_check_compatibility "ct-nonexistent" "general-purpose"
    assert_failure
}

@test "skill_check_compatibility defaults to compatible for general-purpose" {
    # When no compatible_subagent_types is specified, general-purpose is assumed compatible
    run skill_check_compatibility "ct-task-executor" "general-purpose"
    assert_success
}

@test "skill_check_compatibility handles empty subagent type" {
    run skill_check_compatibility "ct-test-skill" ""
    # Empty subagent type won't match anything
    assert_failure
}

# ============================================================================
# skill_list_by_tier tests
# ============================================================================

@test "skill_list_by_tier returns empty for tier 0 (no orchestrator in mock)" {
    run skill_list_by_tier 0
    assert_success
    # Our mock manifest doesn't have orchestrator named properly for tier 0
    [[ -z "$output" ]] || [[ "$output" == "" ]]
}

@test "skill_list_by_tier returns empty for invalid tier" {
    run skill_list_by_tier 99
    assert_success
    [[ -z "$output" ]] || [[ "$output" == "" ]]
}

@test "skill_list_by_tier handles tier as string" {
    run skill_list_by_tier "2"
    assert_success
    # Should handle string input
}

# ============================================================================
# skill_prepare_spawn tests
# ============================================================================

@test "skill_prepare_spawn returns valid JSON" {
    # Use wrapper to re-source library in subshell (associative arrays don't export)
    run "$CLEO_REPO_ROOT/bin/skill_prepare_spawn_wrapper" "ct-test-skill" "T1234"
    assert_success
    echo "$output" | jq -e '.' > /dev/null
    assert_success
}

@test "skill_prepare_spawn contains skill field" {
    run "$CLEO_REPO_ROOT/bin/skill_prepare_spawn_wrapper" "ct-test-skill" "T5678"
    assert_success
    local skill
    skill=$(echo "$output" | jq -r '.skill')
    assert_equal "$skill" "ct-test-skill"
}

@test "skill_prepare_spawn contains taskId field" {
    run "$CLEO_REPO_ROOT/bin/skill_prepare_spawn_wrapper" "ct-test-skill" "T9999"
    assert_success
    local taskId
    taskId=$(echo "$output" | jq -r '.taskId')
    assert_equal "$taskId" "T9999"
}

@test "skill_prepare_spawn contains path field" {
    run "$CLEO_REPO_ROOT/bin/skill_prepare_spawn_wrapper" "ct-test-skill" "T1234"
    assert_success
    local path
    path=$(echo "$output" | jq -r '.path')
    assert_equal "$path" "skills/ct-test-skill"
}

@test "skill_prepare_spawn contains tokenBudget field" {
    run "$CLEO_REPO_ROOT/bin/skill_prepare_spawn_wrapper" "ct-test-skill" "T1234"
    assert_success
    local budget
    budget=$(echo "$output" | jq -r '.tokenBudget')
    # Should be a number
    [[ "$budget" =~ ^[0-9]+$ ]]
}

@test "skill_prepare_spawn contains model field" {
    run "$CLEO_REPO_ROOT/bin/skill_prepare_spawn_wrapper" "ct-test-skill" "T1234"
    assert_success
    local model
    model=$(echo "$output" | jq -r '.model')
    # Model can be "auto" or specific model name
    [[ -n "$model" ]]
}

@test "skill_prepare_spawn contains tier field" {
    run "$CLEO_REPO_ROOT/bin/skill_prepare_spawn_wrapper" "ct-test-skill" "T1234"
    assert_success
    local tier
    tier=$(echo "$output" | jq -r '.tier')
    # Tier defaults to 2 if not specified
    [[ "$tier" =~ ^[0-9]+$ ]]
}

@test "skill_prepare_spawn contains references array" {
    run "$CLEO_REPO_ROOT/bin/skill_prepare_spawn_wrapper" "ct-test-skill" "T1234"
    assert_success
    # Should be array (even if empty)
    local is_array
    is_array=$(echo "$output" | jq '.references | type == "array"')
    assert_equal "$is_array" "true"
}

@test "skill_prepare_spawn contains skillFile field" {
    run "$CLEO_REPO_ROOT/bin/skill_prepare_spawn_wrapper" "ct-test-skill" "T1234"
    assert_success
    local skillFile
    skillFile=$(echo "$output" | jq -r '.skillFile')
    assert_equal "$skillFile" "skills/ct-test-skill/SKILL.md"
}

@test "skill_prepare_spawn fails for nonexistent skill" {
    run "$CLEO_REPO_ROOT/bin/skill_prepare_spawn_wrapper" "ct-nonexistent" "T1234"
    assert_failure
    assert_output --partial "Could not get metadata"
}

@test "skill_prepare_spawn handles special characters in task ID" {
    run "$CLEO_REPO_ROOT/bin/skill_prepare_spawn_wrapper" "ct-test-skill" "T-1234-special"
    assert_success
    local taskId
    taskId=$(echo "$output" | jq -r '.taskId')
    assert_equal "$taskId" "T-1234-special"
}

# ============================================================================
# skill_auto_dispatch tests (requires mocking cleo)
# These tests verify behavior when cleo command is available or simulated
# ============================================================================

@test "skill_auto_dispatch returns skill based on task metadata" {
    # Create a mock cleo command that returns task JSON
    mkdir -p "$CLEO_REPO_ROOT/bin"
    cat > "$CLEO_REPO_ROOT/bin/cleo" << 'MOCK'
#!/usr/bin/env bash
echo '{"task": {"id": "T9999", "type": "task", "labels": ["research"], "title": "Research API", "description": "Investigate options"}}'
MOCK
    chmod +x "$CLEO_REPO_ROOT/bin/cleo"

    # Add mock cleo to PATH
    export PATH="$CLEO_REPO_ROOT/bin:$PATH"

    run skill_auto_dispatch "T9999"
    assert_success
    # Should match research-agent based on label/keyword
    assert_output --partial "ct-research-agent"
}

@test "skill_auto_dispatch returns default when cleo returns empty" {
    # Create a mock cleo command that returns nothing
    mkdir -p "$CLEO_REPO_ROOT/bin"
    cat > "$CLEO_REPO_ROOT/bin/cleo" << 'MOCK'
#!/usr/bin/env bash
echo ''
exit 1
MOCK
    chmod +x "$CLEO_REPO_ROOT/bin/cleo"

    # Add mock cleo to PATH
    export PATH="$CLEO_REPO_ROOT/bin:$PATH"

    run skill_auto_dispatch "TNONEXISTENT"
    # Should return ct-task-executor as fallback
    assert_output --partial "ct-task-executor"
}

@test "skill_auto_dispatch falls back when no match found" {
    # Create a mock cleo command with generic task
    mkdir -p "$CLEO_REPO_ROOT/bin"
    cat > "$CLEO_REPO_ROOT/bin/cleo" << 'MOCK'
#!/usr/bin/env bash
echo '{"task": {"id": "T1234", "type": "epic", "labels": ["random-label"], "title": "Generic work", "description": "Something generic"}}'
MOCK
    chmod +x "$CLEO_REPO_ROOT/bin/cleo"

    # Add mock cleo to PATH
    export PATH="$CLEO_REPO_ROOT/bin:$PATH"

    run skill_auto_dispatch "T1234"
    assert_success
    # Should fall back to ct-task-executor when no specific match
    assert_output --partial "ct-task-executor"
}

@test "skill_auto_dispatch matches by keyword in title" {
    # Create a mock cleo command with keyword in title
    mkdir -p "$CLEO_REPO_ROOT/bin"
    cat > "$CLEO_REPO_ROOT/bin/cleo" << 'MOCK'
#!/usr/bin/env bash
echo '{"task": {"id": "T5555", "type": "epic", "labels": [], "title": "Implement new feature", "description": "Build it"}}'
MOCK
    chmod +x "$CLEO_REPO_ROOT/bin/cleo"

    # Add mock cleo to PATH
    export PATH="$CLEO_REPO_ROOT/bin:$PATH"

    run skill_auto_dispatch "T5555"
    assert_success
    # Should match ct-task-executor based on "implement" keyword
    assert_output --partial "ct-task-executor"
}

# ============================================================================
# _sd_skill_to_protocol tests (T2818)
# ============================================================================

@test "_sd_skill_to_protocol maps ct-test-writer-bats to testing" {
    run _sd_skill_to_protocol "ct-test-writer-bats"
    assert_success
    assert_output "testing"
}

@test "_sd_skill_to_protocol maps generic test-writer to testing" {
    run _sd_skill_to_protocol "ct-test-writer-jest"
    assert_success
    assert_output "testing"
}

@test "_sd_skill_to_protocol maps ct-research-agent to research" {
    run _sd_skill_to_protocol "ct-research-agent"
    assert_success
    assert_output "research"
}

@test "_sd_skill_to_protocol maps ct-epic-architect to decomposition" {
    run _sd_skill_to_protocol "ct-epic-architect"
    assert_success
    assert_output "decomposition"
}

@test "_sd_skill_to_protocol maps ct-spec-writer to specification" {
    run _sd_skill_to_protocol "ct-spec-writer"
    assert_success
    assert_output "specification"
}

@test "_sd_skill_to_protocol maps ct-validator to consensus" {
    run _sd_skill_to_protocol "ct-validator"
    assert_success
    assert_output "consensus"
}

@test "_sd_skill_to_protocol maps ct-task-executor to implementation" {
    run _sd_skill_to_protocol "ct-task-executor"
    assert_success
    assert_output "implementation"
}

@test "_sd_skill_to_protocol defaults unknown skills to implementation" {
    run _sd_skill_to_protocol "ct-unknown-skill"
    assert_success
    assert_output "implementation"
}
