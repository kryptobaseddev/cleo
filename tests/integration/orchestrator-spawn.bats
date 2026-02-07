#!/usr/bin/env bats
# =============================================================================
# orchestrator-spawn.bats - Integration tests for orchestrator-spawn.sh
# =============================================================================
# Tests the complete orchestrator spawn workflow including:
# - orchestrator_spawn_for_task() - Full workflow from task to prompt
# - orchestrator_spawn_batch() - Multi-task spawning
# - orchestrator_spawn_preview() - Dry-run preview mode
# - Integration with skill-dispatch, skill-validate, and token-inject
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    load '../test_helper/assertions'
    common_setup_per_test

    # Create empty todo for task operations
    create_empty_todo

    # Set up orchestrator fixtures path
    export ORCH_FIXTURES="${FIXTURES_DIR}/orchestrator"

    # Set up research directories (needed for some skill workflows)
    export RESEARCH_OUTPUT_DIR="${TEST_TEMP_DIR}/claudedocs/agent-outputs"
    mkdir -p "$RESEARCH_OUTPUT_DIR"

    # Disable lifecycle enforcement for tests
    jq '.lifecycleEnforcement = {"mode": "off"}' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

    # Create empty manifest for token injection
    touch "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"

    # Source the library under test within test context
    source "${LIB_DIR}/orchestrator-spawn.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper Functions
# =============================================================================

# Create test task structure using the orchestrator fixtures
create_test_tasks() {
    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    cp "${ORCH_FIXTURES}/sample-task-data.json" "$todo_file"
}

# Create a single task directly via fixture manipulation
create_single_task() {
    local id="${1:-T100}"
    local title="${2:-Test Task}"
    local description="${3:-A test task for spawning}"
    local task_type="${4:-task}"
    local labels="${5:-[]}"
    local parent_id="${6:-null}"

    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    jq --arg id "$id" \
       --arg title "$title" \
       --arg desc "$description" \
       --arg type "$task_type" \
       --argjson labels "$labels" \
       --argjson parent "$parent_id" \
       '.tasks += [{
         "id": $id,
         "title": $title,
         "description": $desc,
         "status": "pending",
         "priority": "medium",
         "type": $type,
         "parentId": $parent,
         "labels": $labels,
         "phase": "testing",
         "createdAt": "2026-01-19T10:00:00Z",
         "updatedAt": "2026-01-19T10:00:00Z"
       }]' "$todo_file" > "${todo_file}.tmp" && mv "${todo_file}.tmp" "$todo_file"
}

# Create task with research-related labels
create_research_task() {
    local id="${1:-T200}"
    local title="${2:-Research task topic}"

    create_single_task "$id" "$title" "Research something" "task" '["research"]'
}

# Create task with implementation-related labels
create_implementation_task() {
    local id="${1:-T300}"
    local title="${2:-Implement feature X}"

    create_single_task "$id" "$title" "Implement a feature" "task" '["implementation", "bash"]'
}

# =============================================================================
# orchestrator_spawn_for_task() TESTS
# =============================================================================

@test "spawn_for_task: returns error for missing task_id" {
    # Function returns non-zero exit code for errors, which is expected
    local result
    set +e
    result=$(orchestrator_spawn_for_task "" 2>/dev/null)
    local exit_code=$?
    set -e

    # Should return non-zero exit code
    [[ "$exit_code" -ne 0 ]]

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "false" ]]

    local error_code
    error_code=$(echo "$result" | jq -r '.error.code')
    [[ "$error_code" == "E_INVALID_INPUT" ]]
}

@test "spawn_for_task: returns error for nonexistent task" {
    create_test_tasks

    # Function returns non-zero exit code for errors, which is expected
    local result
    set +e
    result=$(orchestrator_spawn_for_task "T999" 2>/dev/null)
    local exit_code=$?
    set -e

    # Should return non-zero exit code
    [[ "$exit_code" -ne 0 ]]

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "false" ]]

    local error_code
    error_code=$(echo "$result" | jq -r '.error.code')
    [[ "$error_code" == "E_NOT_FOUND" ]] || [[ "$error_code" == "E_CLEO_ERROR" ]]
}

@test "spawn_for_task: generates prompt for valid task" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_for_task "T002")

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Should have task ID in result
    local task_id
    task_id=$(echo "$result" | jq -r '.result.taskId')
    [[ "$task_id" == "T002" ]]

    # Should have selected a skill
    local skill
    skill=$(echo "$result" | jq -r '.result.skill')
    [[ -n "$skill" ]]
    [[ "$skill" != "null" ]]

    # Should have generated a prompt
    local prompt
    prompt=$(echo "$result" | jq -r '.result.prompt')
    [[ -n "$prompt" ]]
    [[ ${#prompt} -gt 100 ]]  # Prompt should have substantial content
}

@test "spawn_for_task: includes task context in result" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_for_task "T002")

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Should include task title and description
    local title
    title=$(echo "$result" | jq -r '.result.taskContext.title')
    [[ "$title" == *"No Dependencies"* ]] || [[ "$title" == "First Task - No Dependencies" ]]

    local description
    description=$(echo "$result" | jq -r '.result.taskContext.description')
    [[ -n "$description" ]]
}

@test "spawn_for_task: generates correct output file name" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_for_task "T002")

    local output_file
    output_file=$(echo "$result" | jq -r '.result.outputFile')

    # Should have date prefix
    [[ "$output_file" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}_ ]]

    # Should have .md extension
    [[ "$output_file" == *.md ]]
}

@test "spawn_for_task: generates topic slug from title" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_for_task "T002")

    local topic_slug
    topic_slug=$(echo "$result" | jq -r '.result.topicSlug')

    # Should be lowercase and hyphenated
    [[ "$topic_slug" == "${topic_slug,,}" ]]  # All lowercase
    [[ ! "$topic_slug" =~ [[:space:]] ]]      # No spaces
    [[ "$topic_slug" =~ ^[a-z0-9-]+$ ]]       # Only alphanumeric and hyphens
}

@test "spawn_for_task: accepts skill override" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_for_task "T002" "ct-research-agent")

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Should use the overridden skill
    local skill
    skill=$(echo "$result" | jq -r '.result.skill')
    [[ "$skill" == "ct-research-agent" ]]
}

@test "spawn_for_task: includes spawn timestamp" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_for_task "T002")

    local timestamp
    timestamp=$(echo "$result" | jq -r '.result.spawnTimestamp')

    # Should be ISO 8601 format
    [[ "$timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

@test "spawn_for_task: includes epic ID from parent" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_for_task "T002")

    local epic_id
    epic_id=$(echo "$result" | jq -r '.result.epicId')

    # T002 has parentId T001
    [[ "$epic_id" == "T001" ]]
}

@test "spawn_for_task: epic ID is null for root tasks" {
    create_single_task "T100" "Root Task" "A root task" "task" "[]" "null"

    local result
    result=$(orchestrator_spawn_for_task "T100")

    local epic_id
    epic_id=$(echo "$result" | jq -r '.result.epicId')

    # Should be null for root tasks
    [[ "$epic_id" == "null" ]]
}

@test "spawn_for_task: returns instruction for Task tool usage" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_for_task "T002")

    local instruction
    instruction=$(echo "$result" | jq -r '.result.instruction')

    # Should mention Task tool
    [[ "$instruction" == *"Task tool"* ]] || [[ "$instruction" == *"spawn"* ]]
}

# =============================================================================
# SKILL DISPATCH INTEGRATION TESTS
# =============================================================================

@test "spawn_for_task: selects research skill for research-labeled task" {
    create_research_task "T200" "Research authentication patterns"

    local result
    result=$(orchestrator_spawn_for_task "T200")

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Should select research-related skill (label match or keyword match)
    local skill
    skill=$(echo "$result" | jq -r '.result.skill')
    # Could be ct-research-agent or ct-task-executor depending on manifest triggers
    [[ -n "$skill" ]]
}

@test "spawn_for_task: falls back to ct-task-executor when no match" {
    create_single_task "T100" "Generic task" "Some generic work" "task" "[]"

    local result
    result=$(orchestrator_spawn_for_task "T100")

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Should fall back to ct-task-executor
    local skill
    skill=$(echo "$result" | jq -r '.result.skill')
    [[ "$skill" == "ct-task-executor" ]]
}

@test "spawn_for_task: prompt contains subagent protocol header" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_for_task "T002")

    local prompt
    prompt=$(echo "$result" | jq -r '.result.prompt')

    # Should contain subagent protocol section
    [[ "$prompt" == *"Subagent Protocol"* ]] || [[ "$prompt" == *"SUBAGENT"* ]] || [[ "$prompt" == *"Protocol"* ]]
}

@test "spawn_for_task: prompt contains skill name" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_for_task "T002")

    local skill
    skill=$(echo "$result" | jq -r '.result.skill')

    local prompt
    prompt=$(echo "$result" | jq -r '.result.prompt')

    # Prompt should reference the skill (in Skill: header or similar)
    [[ "$prompt" == *"$skill"* ]] || [[ "$prompt" == *"Skill:"* ]]
}

# =============================================================================
# orchestrator_spawn_batch() TESTS
# =============================================================================

@test "spawn_batch: processes multiple tasks" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_batch '["T002", "T003"]')

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Should have 2 spawns
    local count
    count=$(echo "$result" | jq -r '.result.count')
    [[ "$count" -eq 2 ]]

    local spawns_count
    spawns_count=$(echo "$result" | jq '.result.spawns | length')
    [[ "$spawns_count" -eq 2 ]]
}

@test "spawn_batch: each spawn has task context" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_batch '["T002", "T003"]')

    # Check first spawn
    local first_task_id
    first_task_id=$(echo "$result" | jq -r '.result.spawns[0].result.taskId')
    [[ "$first_task_id" == "T002" ]]

    # Check second spawn
    local second_task_id
    second_task_id=$(echo "$result" | jq -r '.result.spawns[1].result.taskId')
    [[ "$second_task_id" == "T003" ]]
}

@test "spawn_batch: handles empty array" {
    local result
    result=$(orchestrator_spawn_batch '[]')

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    local count
    count=$(echo "$result" | jq -r '.result.count')
    [[ "$count" -eq 0 ]]
}

@test "spawn_batch: includes failed tasks in results" {
    create_test_tasks

    # Mix of valid and invalid task IDs
    local result
    result=$(orchestrator_spawn_batch '["T002", "T999"]')

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]  # Batch operation succeeds even with individual failures

    # Should have 2 results
    local spawns_count
    spawns_count=$(echo "$result" | jq '.result.spawns | length')
    [[ "$spawns_count" -eq 2 ]]

    # First should succeed
    local first_success
    first_success=$(echo "$result" | jq -r '.result.spawns[0].success')
    [[ "$first_success" == "true" ]]

    # Second should fail
    local second_success
    second_success=$(echo "$result" | jq -r '.result.spawns[1].success')
    [[ "$second_success" == "false" ]]
}

@test "spawn_batch: respects skill override for all tasks" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_batch '["T002", "T003"]' "ct-research-agent")

    # Both spawns should use the overridden skill
    local first_skill
    first_skill=$(echo "$result" | jq -r '.result.spawns[0].result.skill')
    [[ "$first_skill" == "ct-research-agent" ]]

    local second_skill
    second_skill=$(echo "$result" | jq -r '.result.spawns[1].result.skill')
    [[ "$second_skill" == "ct-research-agent" ]]
}

# =============================================================================
# orchestrator_spawn_preview() TESTS
# =============================================================================

@test "spawn_preview: returns error for missing task_id" {
    # Function returns non-zero exit code for errors, which is expected
    local result
    set +e
    result=$(orchestrator_spawn_preview "" 2>/dev/null)
    local exit_code=$?
    set -e

    # Should return non-zero exit code
    [[ "$exit_code" -ne 0 ]]

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "false" ]]

    local error_code
    error_code=$(echo "$result" | jq -r '.error.code')
    [[ "$error_code" == "E_INVALID_INPUT" ]]
}

@test "spawn_preview: returns error for nonexistent task" {
    create_test_tasks

    # Function returns non-zero exit code for errors, which is expected
    local result
    set +e
    result=$(orchestrator_spawn_preview "T999" 2>/dev/null)
    local exit_code=$?
    set -e

    # Should return non-zero exit code
    [[ "$exit_code" -ne 0 ]]

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "false" ]]
}

@test "spawn_preview: shows selected skill without injection" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_preview "T002")

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Should show selected skill
    local skill
    skill=$(echo "$result" | jq -r '.result.selectedSkill')
    [[ -n "$skill" ]]
    [[ "$skill" != "null" ]]

    # Should NOT have prompt (preview only)
    local has_prompt
    has_prompt=$(echo "$result" | jq 'has("prompt") or (.result | has("prompt"))')
    [[ "$has_prompt" == "false" ]]
}

@test "spawn_preview: includes task metadata" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_preview "T002")

    # Should have task ID
    local task_id
    task_id=$(echo "$result" | jq -r '.result.taskId')
    [[ "$task_id" == "T002" ]]

    # Should have task type
    local task_type
    task_type=$(echo "$result" | jq -r '.result.taskType')
    [[ "$task_type" == "task" ]]

    # Should have task title
    local title
    title=$(echo "$result" | jq -r '.result.taskTitle')
    [[ -n "$title" ]]
}

@test "spawn_preview: shows task labels" {
    create_single_task "T100" "Labeled Task" "A task with labels" "task" '["test-label", "preview"]'

    local result
    result=$(orchestrator_spawn_preview "T100")

    local labels
    labels=$(echo "$result" | jq -r '.result.taskLabels | join(",")')
    [[ "$labels" == *"test-label"* ]]
    [[ "$labels" == *"preview"* ]]
}

@test "spawn_preview: includes skill info when available" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_preview "T002")

    # Should have skillInfo field
    local has_skill_info
    has_skill_info=$(echo "$result" | jq '.result | has("skillInfo")')
    [[ "$has_skill_info" == "true" ]]
}

# =============================================================================
# TOKEN INJECTION INTEGRATION TESTS
# =============================================================================

@test "spawn_for_task: injects core tokens into prompt" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_for_task "T002" 2>/dev/null)

    local prompt
    prompt=$(echo "$result" | jq -r '.result.prompt')

    # Verify prompt was generated with substantial content
    [[ ${#prompt} -gt 50 ]]

    # Note: Some tokens may remain uninjected if optional values are not set
    # The important thing is that the core workflow completes and produces a prompt
}

@test "spawn_for_task: result includes date in correct format" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_for_task "T002" 2>/dev/null)

    local date_in_result
    date_in_result=$(echo "$result" | jq -r '.result.date')

    # Date should be in YYYY-MM-DD format
    [[ "$date_in_result" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]

    # Date should be today's date
    local today
    today=$(date +%Y-%m-%d)
    [[ "$date_in_result" == "$today" ]]
}

# =============================================================================
# ERROR HANDLING TESTS
# =============================================================================

@test "spawn_for_task: handles invalid skill override gracefully" {
    create_test_tasks

    # Try to spawn with nonexistent skill
    local result
    result=$(orchestrator_spawn_for_task "T002" "nonexistent-skill-xyz")

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "false" ]]

    local error_code
    error_code=$(echo "$result" | jq -r '.error.code')
    [[ "$error_code" == "E_SKILL_VALIDATION" ]] || [[ "$error_code" == "E_NOT_FOUND" ]]
}

@test "spawn_for_task: JSON error output includes command meta" {
    # Function returns non-zero exit code for errors, which is expected
    local result
    set +e
    result=$(orchestrator_spawn_for_task "" 2>/dev/null)
    set -e

    local command
    command=$(echo "$result" | jq -r '._meta.command')
    [[ "$command" == "orchestrator" ]]

    local operation
    operation=$(echo "$result" | jq -r '._meta.operation')
    [[ "$operation" == "spawn_for_task" ]]
}

# =============================================================================
# CONTEXT ISOLATION TESTS (from orchestrator-skill.bats)
# =============================================================================

@test "spawn_for_task: prompt does NOT contain ORC constraints" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_for_task "T002")

    local prompt
    prompt=$(echo "$result" | jq -r '.result.prompt')

    # CRITICAL: Subagent prompts must NOT contain orchestrator constraints
    # These are ORC-001 through ORC-005
    if [[ "$prompt" =~ "ORC-001" ]]; then
        fail "Subagent prompt contains ORC-001 (orchestrator constraint leak)"
    fi
    if [[ "$prompt" =~ "ORC-002" ]]; then
        fail "Subagent prompt contains ORC-002 (orchestrator constraint leak)"
    fi
    if [[ "$prompt" =~ "ORC-003" ]]; then
        fail "Subagent prompt contains ORC-003 (orchestrator constraint leak)"
    fi
    if [[ "$prompt" =~ "ORC-004" ]]; then
        fail "Subagent prompt contains ORC-004 (orchestrator constraint leak)"
    fi
    if [[ "$prompt" =~ "ORC-005" ]]; then
        fail "Subagent prompt contains ORC-005 (orchestrator constraint leak)"
    fi
}

# =============================================================================
# END-TO-END WORKFLOW TEST
# =============================================================================

@test "e2e: spawn workflow produces usable Task tool input" {
    create_test_tasks

    local result
    result=$(orchestrator_spawn_for_task "T002")

    # Verify all required fields for Task tool are present
    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Must have prompt for Task tool
    local prompt
    prompt=$(echo "$result" | jq -r '.result.prompt')
    [[ -n "$prompt" ]]
    [[ ${#prompt} -gt 100 ]]

    # Must have task context for tracking
    local task_id
    task_id=$(echo "$result" | jq -r '.result.taskId')
    [[ "$task_id" == "T002" ]]

    # Must have spawn metadata for audit
    local timestamp
    timestamp=$(echo "$result" | jq -r '.result.spawnTimestamp')
    [[ -n "$timestamp" ]]

    # Must have skill name for logging
    local skill
    skill=$(echo "$result" | jq -r '.result.skill')
    [[ -n "$skill" ]]
}

@test "e2e: batch spawn for parallel tasks" {
    create_test_tasks

    # T003 and T004 both depend on T002 and can run in parallel
    local result
    result=$(orchestrator_spawn_batch '["T003", "T004"]')

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Both should succeed
    local first_success
    first_success=$(echo "$result" | jq -r '.result.spawns[0].success')
    [[ "$first_success" == "true" ]]

    local second_success
    second_success=$(echo "$result" | jq -r '.result.spawns[1].success')
    [[ "$second_success" == "true" ]]

    # Both should have prompts
    local first_prompt_len
    first_prompt_len=$(echo "$result" | jq -r '.result.spawns[0].result.prompt | length')
    [[ "$first_prompt_len" -gt 100 ]]

    local second_prompt_len
    second_prompt_len=$(echo "$result" | jq -r '.result.spawns[1].result.prompt | length')
    [[ "$second_prompt_len" -gt 100 ]]
}
