#!/usr/bin/env bats
# =============================================================================
# orchestrator-spawn-e2e.bats - E2E Test: Full orchestrator to subagent spawn flow
# =============================================================================
# Task: T2456
# Tests the complete orchestrator spawn flow from end to end:
# 1. orchestrator spawn command generates valid prompt
# 2. Prompt contains all required tokens injected
# 3. Simulates cleo-subagent execution
# 4. Manifest entry is created correctly
# 5. Return message follows protocol
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

    # Set up research directories
    export RESEARCH_OUTPUT_DIR="${TEST_TEMP_DIR}/claudedocs/agent-outputs"
    mkdir -p "$RESEARCH_OUTPUT_DIR"

    # Set up fixtures path
    export ORCH_FIXTURES="${FIXTURES_DIR}/orchestrator"
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

# Create test task structure with a simple task to spawn
create_test_task() {
    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"

    # Create a simple task structure
    jq '.tasks += [{
        "id": "T100",
        "title": "Test Implementation Task",
        "description": "A test task for E2E spawn validation",
        "status": "pending",
        "priority": "high",
        "type": "task",
        "labels": ["e2e-test", "implementation"],
        "phase": "testing",
        "createdAt": "2026-01-27T05:00:00Z",
        "updatedAt": "2026-01-27T05:00:00Z",
        "parentId": null
    }]' "$todo_file" > "${todo_file}.tmp"
    mv "${todo_file}.tmp" "$todo_file"
}

# Simulate subagent execution by creating expected outputs
simulate_subagent_execution() {
    local task_id="$1"
    local date="$2"
    local slug="$3"

    # Create output file
    local output_file="${RESEARCH_OUTPUT_DIR}/${date}_${slug}.md"
    cat > "$output_file" << EOF
# Implementation: Test Implementation Task

**Task**: ${task_id}
**Date**: ${date}
**Status**: complete
**Agent Type**: implementation

---

## Summary

E2E test implementation completed successfully. All protocol requirements met.

## Changes

### Files Modified

| File | Action | Description |
|------|--------|-------------|
| tests/integration/orchestrator-spawn-e2e.bats | Created | E2E test for orchestrator spawn flow |

## Validation

| Check | Status | Notes |
|-------|--------|-------|
| Protocol injection | PASS | All required tokens present |
| Manifest structure | PASS | Valid JSON entry |
| Return message | PASS | Follows protocol format |

## References

- Task: ${task_id}
- Protocol: implementation.md
EOF

    # Append manifest entry
    local manifest_file="${RESEARCH_OUTPUT_DIR}/MANIFEST.jsonl"
    cat >> "$manifest_file" << EOF
{"id":"${task_id}-e2e-test","file":"${date}_${slug}.md","title":"Implementation: Test Implementation Task","date":"${date}","status":"complete","agent_type":"implementation","topics":["e2e-test","implementation"],"key_findings":["Protocol injection validated","Manifest entry created","Return message correct"],"actionable":false,"needs_followup":[],"linked_tasks":["${task_id}"]}
EOF
}

# =============================================================================
# E2E WORKFLOW TESTS
# =============================================================================

@test "e2e: orchestrator spawn generates valid prompt" {
    create_test_task

    # Step 1: Generate spawn prompt
    local result
    result=$(cleo orchestrator spawn T100)

    # Verify success
    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Verify prompt was generated
    local prompt
    prompt=$(echo "$result" | jq -r '.result.prompt')
    [[ -n "$prompt" ]]
    [[ ${#prompt} -gt 100 ]]
}

@test "e2e: spawn prompt contains required protocol markers" {
    create_test_task

    local result
    result=$(cleo orchestrator spawn T100)

    local prompt
    prompt=$(echo "$result" | jq -r '.result.prompt')

    # Must contain subagent protocol marker
    [[ "$prompt" == *"SUBAGENT PROTOCOL"* ]] || [[ "$prompt" == *"Protocol"* ]]

    # Must contain output requirements section
    [[ "$prompt" == *"MUST write"* ]] || [[ "$prompt" == *"Output Requirements"* ]]

    # Must contain manifest requirement
    [[ "$prompt" == *"MANIFEST.jsonl"* ]]

    # Must contain completion requirement
    [[ "$prompt" == *"cleo complete"* ]] || [[ "$prompt" == *"complete"* ]]
}

@test "e2e: spawn prompt has all required tokens injected" {
    create_test_task

    local result
    result=$(cleo orchestrator spawn T100)

    local prompt
    prompt=$(echo "$result" | jq -r '.result.prompt')

    # Task ID should be injected
    [[ "$prompt" == *"T100"* ]]

    # Date should be injected (YYYY-MM-DD format)
    [[ "$prompt" =~ [0-9]{4}-[0-9]{2}-[0-9]{2} ]]

    # Output directory should be injected
    [[ "$prompt" == *"claudedocs/agent-outputs"* ]] || [[ "$prompt" == *"OUTPUT_DIR"* ]]

    # Should NOT contain unresolved tokens
    [[ "$prompt" != *"{{TASK_ID}}"* ]]
    [[ "$prompt" != *"{{DATE}}"* ]]
    [[ "$prompt" != *"{{OUTPUT_DIR}}"* ]]
}

@test "e2e: spawn result includes all metadata for execution" {
    create_test_task

    local result
    result=$(cleo orchestrator spawn T100)

    # Must have task ID
    local task_id
    task_id=$(echo "$result" | jq -r '.result.taskId')
    [[ "$task_id" == "T100" ]]

    # Must have skill
    local skill
    skill=$(echo "$result" | jq -r '.result.skill')
    [[ -n "$skill" ]]
    [[ "$skill" != "null" ]]

    # Must have output file name
    local output_file
    output_file=$(echo "$result" | jq -r '.result.outputFile')
    [[ -n "$output_file" ]]
    [[ "$output_file" == *.md ]]

    # Must have date
    local date
    date=$(echo "$result" | jq -r '.result.date')
    [[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]

    # Must have spawn timestamp
    local timestamp
    timestamp=$(echo "$result" | jq -r '.result.spawnTimestamp')
    [[ "$timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

@test "e2e: simulated subagent creates output file" {
    create_test_task

    local result
    result=$(cleo orchestrator spawn T100)

    # Extract metadata
    local date
    date=$(echo "$result" | jq -r '.result.date')
    local topic_slug
    topic_slug=$(echo "$result" | jq -r '.result.topicSlug')

    # Simulate subagent execution
    simulate_subagent_execution "T100" "$date" "$topic_slug"

    # Verify output file exists
    local output_file="${RESEARCH_OUTPUT_DIR}/${date}_${topic_slug}.md"
    [[ -f "$output_file" ]]

    # Verify output file has content
    local file_size
    file_size=$(wc -c < "$output_file")
    [[ "$file_size" -gt 100 ]]
}

@test "e2e: simulated subagent creates valid manifest entry" {
    create_test_task

    local result
    result=$(cleo orchestrator spawn T100)

    local date
    date=$(echo "$result" | jq -r '.result.date')
    local topic_slug
    topic_slug=$(echo "$result" | jq -r '.result.topicSlug')

    # Simulate subagent execution
    simulate_subagent_execution "T100" "$date" "$topic_slug"

    # Verify manifest file exists
    local manifest_file="${RESEARCH_OUTPUT_DIR}/MANIFEST.jsonl"
    [[ -f "$manifest_file" ]]

    # Verify manifest entry is valid JSON
    local last_entry
    last_entry=$(tail -n 1 "$manifest_file")
    echo "$last_entry" | jq empty  # Will fail if invalid JSON

    # Verify manifest entry has required fields
    local entry_id
    entry_id=$(echo "$last_entry" | jq -r '.id')
    [[ "$entry_id" == "T100-e2e-test" ]]

    local entry_status
    entry_status=$(echo "$last_entry" | jq -r '.status')
    [[ "$entry_status" == "complete" ]]

    local agent_type
    agent_type=$(echo "$last_entry" | jq -r '.agent_type')
    [[ "$agent_type" == "implementation" ]]
}

@test "e2e: manifest entry has correct structure and all required fields" {
    create_test_task

    local result
    result=$(cleo orchestrator spawn T100)

    local date
    date=$(echo "$result" | jq -r '.result.date')
    local topic_slug
    topic_slug=$(echo "$result" | jq -r '.result.topicSlug')

    simulate_subagent_execution "T100" "$date" "$topic_slug"

    local manifest_file="${RESEARCH_OUTPUT_DIR}/MANIFEST.jsonl"
    local last_entry
    last_entry=$(tail -n 1 "$manifest_file")

    # Required fields
    local has_id
    has_id=$(echo "$last_entry" | jq 'has("id")')
    [[ "$has_id" == "true" ]]

    local has_file
    has_file=$(echo "$last_entry" | jq 'has("file")')
    [[ "$has_file" == "true" ]]

    local has_title
    has_title=$(echo "$last_entry" | jq 'has("title")')
    [[ "$has_title" == "true" ]]

    local has_date
    has_date=$(echo "$last_entry" | jq 'has("date")')
    [[ "$has_date" == "true" ]]

    local has_status
    has_status=$(echo "$last_entry" | jq 'has("status")')
    [[ "$has_status" == "true" ]]

    local has_agent_type
    has_agent_type=$(echo "$last_entry" | jq 'has("agent_type")')
    [[ "$has_agent_type" == "true" ]]

    local has_topics
    has_topics=$(echo "$last_entry" | jq 'has("topics")')
    [[ "$has_topics" == "true" ]]

    local has_key_findings
    has_key_findings=$(echo "$last_entry" | jq 'has("key_findings")')
    [[ "$has_key_findings" == "true" ]]

    local has_linked_tasks
    has_linked_tasks=$(echo "$last_entry" | jq 'has("linked_tasks")')
    [[ "$has_linked_tasks" == "true" ]]
}

@test "e2e: manifest entry is linked to task" {
    create_test_task

    local result
    result=$(cleo orchestrator spawn T100)

    local date
    date=$(echo "$result" | jq -r '.result.date')
    local topic_slug
    topic_slug=$(echo "$result" | jq -r '.result.topicSlug')

    simulate_subagent_execution "T100" "$date" "$topic_slug"

    local manifest_file="${RESEARCH_OUTPUT_DIR}/MANIFEST.jsonl"
    local last_entry
    last_entry=$(tail -n 1 "$manifest_file")

    # Verify task is in linked_tasks array
    local has_task_link
    has_task_link=$(echo "$last_entry" | jq '.linked_tasks | any(. == "T100")')
    [[ "$has_task_link" == "true" ]]
}

@test "e2e: return message follows protocol format" {
    create_test_task

    local result
    result=$(cleo orchestrator spawn T100)

    local instruction
    instruction=$(echo "$result" | jq -r '.result.instruction')

    # Should reference return message format
    [[ "$instruction" == *"complete"* ]] || [[ "$instruction" == *"MANIFEST.jsonl"* ]]
}

@test "e2e: orchestrator validate detects compliant manifest entry" {
    create_test_task

    local result
    result=$(cleo orchestrator spawn T100)

    local date
    date=$(echo "$result" | jq -r '.result.date')
    local topic_slug
    topic_slug=$(echo "$result" | jq -r '.result.topicSlug')

    simulate_subagent_execution "T100" "$date" "$topic_slug"

    # Validate manifest integrity
    local validation_result
    validation_result=$(cleo orchestrator validate --manifest)

    local passed
    passed=$(echo "$validation_result" | jq -r '.result.passed')
    [[ "$passed" == "true" ]]
}

@test "e2e: spawn with skill override generates correct protocol" {
    create_test_task

    # Spawn with research skill override
    local result
    result=$(cleo orchestrator spawn T100 --template ct-research-agent)

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Verify skill was overridden
    local skill
    skill=$(echo "$result" | jq -r '.result.skill')
    [[ "$skill" == "ct-research-agent" ]]

    # Verify prompt contains research-specific content
    local prompt
    prompt=$(echo "$result" | jq -r '.result.prompt')
    [[ "$prompt" == *"research"* ]] || [[ "$prompt" == *"Research"* ]]
}

@test "e2e: full workflow from spawn to validation" {
    create_test_task

    # Step 1: Generate spawn prompt
    local spawn_result
    spawn_result=$(cleo orchestrator spawn T100)

    local spawn_success
    spawn_success=$(echo "$spawn_result" | jq -r '.success')
    [[ "$spawn_success" == "true" ]]

    # Step 2: Extract metadata
    local date
    date=$(echo "$spawn_result" | jq -r '.result.date')
    local topic_slug
    topic_slug=$(echo "$spawn_result" | jq -r '.result.topicSlug')

    # Step 3: Simulate subagent execution
    simulate_subagent_execution "T100" "$date" "$topic_slug"

    # Step 4: Validate manifest
    local validation_result
    validation_result=$(cleo orchestrator validate --manifest)

    local validation_passed
    validation_passed=$(echo "$validation_result" | jq -r '.result.passed')
    [[ "$validation_passed" == "true" ]]

    # Step 5: Verify output file exists and has correct structure
    local output_file="${RESEARCH_OUTPUT_DIR}/${date}_${topic_slug}.md"
    [[ -f "$output_file" ]]

    # Verify file has required sections
    grep -q "# Implementation:" "$output_file"
    grep -q "## Summary" "$output_file"
    grep -q "## Changes" "$output_file"
    grep -q "## Validation" "$output_file"
}

@test "e2e: spawn prompt can be parsed by protocol validator" {
    create_test_task

    local result
    result=$(cleo orchestrator spawn T100)

    local prompt
    prompt=$(echo "$result" | jq -r '.result.prompt')

    # Source the validation library
    source "${LIB_DIR}/skills/orchestrator-spawn.sh"

    # Validate protocol injection
    run orchestrator_verify_protocol_injection "$prompt"

    # Should pass validation
    [[ "$status" -eq 0 ]]
}

@test "e2e: spawn for multiple tasks generates unique output files" {
    # Create two tasks
    create_test_task

    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    jq '.tasks += [{
        "id": "T101",
        "title": "Second Test Task",
        "description": "Another test task",
        "status": "pending",
        "priority": "high",
        "type": "task",
        "labels": ["e2e-test"],
        "phase": "testing",
        "createdAt": "2026-01-27T05:00:00Z",
        "updatedAt": "2026-01-27T05:00:00Z",
        "parentId": null
    }]' "$todo_file" > "${todo_file}.tmp"
    mv "${todo_file}.tmp" "$todo_file"

    # Spawn both tasks
    local result1
    result1=$(cleo orchestrator spawn T100)
    local output1
    output1=$(echo "$result1" | jq -r '.result.outputFile')

    local result2
    result2=$(cleo orchestrator spawn T101)
    local output2
    output2=$(echo "$result2" | jq -r '.result.outputFile')

    # Output files must be different
    [[ "$output1" != "$output2" ]]
}

@test "e2e: manifest integrity check catches missing output file" {
    create_test_task

    local result
    result=$(cleo orchestrator spawn T100)

    local date
    date=$(echo "$result" | jq -r '.result.date')

    # Create manifest entry without corresponding file
    local manifest_file="${RESEARCH_OUTPUT_DIR}/MANIFEST.jsonl"
    cat > "$manifest_file" << EOF
{"id":"T100-missing-file","file":"2026-01-27_missing.md","title":"Missing File Test","date":"${date}","status":"complete","agent_type":"implementation","topics":["test"],"key_findings":["F1"],"actionable":false,"needs_followup":[],"linked_tasks":["T100"]}
EOF

    # Validate should fail
    local validation_result
    set +e
    validation_result=$(cleo orchestrator validate --manifest 2>/dev/null)
    set -e

    local passed
    passed=$(echo "$validation_result" | jq -r '.result.passed')
    [[ "$passed" == "false" ]]

    # Should report FILE_MISSING
    local has_file_issue
    has_file_issue=$(echo "$validation_result" | jq '[.result.issues[] | select(contains("FILE_MISSING"))] | length')
    [[ "$has_file_issue" -gt 0 ]]
}
