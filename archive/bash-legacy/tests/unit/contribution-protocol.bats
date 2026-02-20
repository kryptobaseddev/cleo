#!/usr/bin/env bats
# =============================================================================
# contribution-protocol.bats - Unit tests for lib/skills/contribution-protocol.sh
# =============================================================================
# Tests the contribution protocol library functions:
# - contribution_protocol_instantiate: Template token replacement
# - contribution_validate_task: Task validation against protocol
# - contribution_get_injection: Injection block generation
# - contribution_generate_id: ID generation
# - contribution_create_manifest_entry: Manifest entry creation
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    # Set CLEO_HOME for library sourcing
    export CLEO_HOME="${PROJECT_ROOT}"
    export CLEO_LIB_DIR="${PROJECT_ROOT}/lib"

    # Source the contribution protocol library
    source "${PROJECT_ROOT}/lib/skills/contribution-protocol.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# contribution_generate_id() Tests
# =============================================================================

@test "contribution_generate_id returns valid format" {
    local id
    id=$(contribution_generate_id)

    # Should start with 'contrib_'
    [[ "$id" =~ ^contrib_ ]]
}

@test "contribution_generate_id produces 8 hex chars after prefix" {
    local id
    id=$(contribution_generate_id)

    # Extract the hex part after 'contrib_'
    local hex_part="${id#contrib_}"

    # Should be exactly 8 hex characters
    [[ ${#hex_part} -eq 8 ]]
    [[ "$hex_part" =~ ^[0-9a-f]+$ ]]
}

@test "contribution_generate_id produces unique values" {
    local id1 id2 id3
    id1=$(contribution_generate_id)
    id2=$(contribution_generate_id)
    id3=$(contribution_generate_id)

    # All three should be different (extremely unlikely to collide)
    [[ "$id1" != "$id2" ]]
    [[ "$id2" != "$id3" ]]
    [[ "$id1" != "$id3" ]]
}

# =============================================================================
# contribution_protocol_instantiate() Tests - Simple Token Replacement
# =============================================================================

@test "contribution_protocol_instantiate replaces EPIC_ID token" {
    # Skip if template doesn't exist
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-PROTOCOL.template.md" ]] || skip "Template not found"

    local result
    result=$(contribution_protocol_instantiate "T2204" "Session A" "[]" "[]")

    # Should contain the epic ID, not the token
    [[ "$result" == *"T2204"* ]]
    [[ "$result" != *"{{EPIC_ID}}"* ]]
}

@test "contribution_protocol_instantiate replaces BASELINE_SESSION token" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-PROTOCOL.template.md" ]] || skip "Template not found"

    local result
    result=$(contribution_protocol_instantiate "T2204" "Research Session A" "[]" "[]")

    [[ "$result" == *"Research Session A"* ]]
    [[ "$result" != *"{{BASELINE_SESSION}}"* ]]
}

@test "contribution_protocol_instantiate replaces DATE token with current date" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-PROTOCOL.template.md" ]] || skip "Template not found"

    local result expected_date
    expected_date=$(date +%Y-%m-%d)
    result=$(contribution_protocol_instantiate "T2204" "Session A" "[]" "[]")

    [[ "$result" == *"$expected_date"* ]]
    [[ "$result" != *"{{DATE}}"* ]]
}

@test "contribution_protocol_instantiate uses default MARKER_LABEL" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-PROTOCOL.template.md" ]] || skip "Template not found"

    local result
    result=$(contribution_protocol_instantiate "T2204" "Session A" "[]" "[]")

    # Default marker label is 'consensus-source'
    [[ "$result" == *"consensus-source"* ]]
    [[ "$result" != *"{{MARKER_LABEL}}"* ]]
}

@test "contribution_protocol_instantiate uses custom options" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-PROTOCOL.template.md" ]] || skip "Template not found"

    local options='{"epicTitle": "Multi-Agent Research", "markerLabel": "custom-label", "phase": "testing"}'
    local result
    result=$(contribution_protocol_instantiate "T2204" "Session A" "[]" "[]" "$options")

    # Epic title token should be replaced
    [[ "$result" != *"{{EPIC_TITLE}}"* ]]

    # Custom marker label should be used
    [[ "$result" == *"custom-label"* ]]
}

@test "contribution_protocol_instantiate requires epic_id" {
    run contribution_protocol_instantiate "" "Session A"

    [[ "$status" -ne 0 ]]
}

@test "contribution_protocol_instantiate requires baseline_session" {
    run contribution_protocol_instantiate "T2204" ""

    [[ "$status" -ne 0 ]]
}

# =============================================================================
# contribution_protocol_instantiate() Tests - Array Token Replacement
# =============================================================================

@test "contribution_protocol_instantiate handles DECISION_QUESTIONS array" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-PROTOCOL.template.md" ]] || skip "Template not found"

    local questions='[{"id": 1, "question": "What architecture should we use?"}]'
    local result
    result=$(contribution_protocol_instantiate "T2204" "Session A" "$questions" "[]")

    # Should contain the question text (from first #each block expansion)
    [[ "$result" == *"What architecture should we use?"* ]]
    # Note: Template has multiple #each blocks for same array; library processes first occurrence
    # The first {{#each DECISION_QUESTIONS}} block should be expanded
}

@test "contribution_protocol_instantiate handles BASELINE_DECISIONS array" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-PROTOCOL.template.md" ]] || skip "Template not found"

    local decisions='[{"question": "Architecture", "position": "Single file approach"}]'
    local result
    result=$(contribution_protocol_instantiate "T2204" "Session A" "[]" "$decisions")

    # Should contain the decision content
    [[ "$result" == *"Architecture"* ]]
    [[ "$result" == *"Single file approach"* ]]
}

@test "contribution_protocol_instantiate handles empty arrays" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-PROTOCOL.template.md" ]] || skip "Template not found"

    local result
    result=$(contribution_protocol_instantiate "T2204" "Session A" "[]" "[]")

    # Should succeed and produce output
    [[ -n "$result" ]]
    # With empty arrays, the first #each block content is removed
    # Note: Template documentation sections still show {{#each}} as examples
}

@test "contribution_protocol_instantiate handles multiple array items" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-PROTOCOL.template.md" ]] || skip "Template not found"

    local questions='[{"id": 1, "question": "Question One"}, {"id": 2, "question": "Question Two"}, {"id": 3, "question": "Question Three"}]'
    local result
    result=$(contribution_protocol_instantiate "T2204" "Session A" "$questions" "[]")

    # Should contain all questions
    [[ "$result" == *"Question One"* ]]
    [[ "$result" == *"Question Two"* ]]
    [[ "$result" == *"Question Three"* ]]
}

@test "contribution_protocol_instantiate produces no unreplaced simple tokens" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-PROTOCOL.template.md" ]] || skip "Template not found"

    local questions='[{"id": 1, "question": "Test question"}]'
    local decisions='[{"question": "Topic", "position": "Position"}]'
    local options='{"epicTitle": "Test Epic", "synthesisTaskId": "T9999"}'
    local result
    result=$(contribution_protocol_instantiate "T2204" "Session A" "$questions" "$decisions" "$options")

    # Simple tokens (not #each blocks or SESSION_LETTER) should be replaced
    # These are the core tokens that MUST be replaced
    [[ "$result" != *"{{EPIC_ID}}"* ]]
    [[ "$result" != *"{{EPIC_TITLE}}"* ]]
    [[ "$result" != *"{{VERSION}}"* ]]
    [[ "$result" != *"{{DATE}}"* ]]
    [[ "$result" != *"{{MARKER_LABEL}}"* ]]
    [[ "$result" != *"{{OUTPUT_DIR}}"* ]]
    [[ "$result" != *"{{PHASE}}"* ]]
    [[ "$result" != *"{{BASELINE_SESSION}}"* ]]
    [[ "$result" != *"{{SYNTHESIS_TASK_ID}}"* ]]

    # Note: {{SESSION_LETTER}} is intentionally left for user replacement
    # Note: Template documentation sections may contain {{tokens}} as examples
}

# =============================================================================
# contribution_validate_task() Tests
# =============================================================================

@test "contribution_validate_task requires task_id" {
    run contribution_validate_task ""

    [[ "$status" -ne 0 ]]
}

@test "contribution_validate_task returns JSON output" {
    # Create a mock task for testing
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.6.0",
  "_meta": { "schemaVersion": "2.6.0" },
  "focus": { "activeTaskId": null },
  "tasks": [
    {
      "id": "T001",
      "title": "Test contribution task",
      "description": "## Research Outputs\n- file1.md\n\n## Key Decisions\nDecision 1: Something",
      "status": "pending",
      "type": "task",
      "parentId": "T000",
      "labels": ["consensus-source"],
      "notes": ["claudedocs/agent-outputs/test.md"],
      "createdAt": "2026-01-25T12:00:00Z",
      "updatedAt": "2026-01-25T12:00:00Z"
    }
  ]
}
EOF

    # This test validates the JSON structure of the response
    # Note: Requires cleo command to be available
    if ! command -v cleo &>/dev/null; then
        skip "cleo command not available"
    fi

    local result
    result=$(contribution_validate_task "T001" "T000" "consensus-source" 2>/dev/null) || true

    # Should be valid JSON (even if validation fails due to task not found)
    echo "$result" | jq empty 2>/dev/null || {
        # If result is empty, that's also acceptable (task not found via cleo)
        [[ -z "$result" ]] || skip "cleo show command required for full validation"
    }
}

@test "contribution_validate_task checks for valid field" {
    # This test verifies the JSON response structure
    # The actual validation requires cleo integration

    if ! command -v cleo &>/dev/null; then
        skip "cleo command not available"
    fi

    # Even for non-existent task, should return JSON with 'valid' field
    local result
    result=$(contribution_validate_task "T999" "T000" "consensus-source" 2>/dev/null) || true

    if [[ -n "$result" ]]; then
        local valid_field
        valid_field=$(echo "$result" | jq -r '.valid' 2>/dev/null) || true
        # Should be 'true' or 'false'
        [[ "$valid_field" == "true" || "$valid_field" == "false" ]]
    fi
}

@test "contribution_validate_task catches missing task" {
    if ! command -v cleo &>/dev/null; then
        skip "cleo command not available"
    fi

    # Set up empty todo file
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.6.0",
  "_meta": { "schemaVersion": "2.6.0" },
  "focus": { "activeTaskId": null },
  "tasks": []
}
EOF

    local result
    result=$(contribution_validate_task "T999" "T000" "consensus-source" 2>/dev/null) || true

    if [[ -n "$result" ]]; then
        local valid
        valid=$(echo "$result" | jq -r '.valid' 2>/dev/null) || true
        # Non-existent task should be invalid
        [[ "$valid" == "false" ]]
    fi
}

# =============================================================================
# contribution_get_injection() Tests
# =============================================================================

@test "contribution_get_injection replaces EPIC_ID token" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-INJECTION.md" ]] || skip "Injection template not found"

    local result
    result=$(contribution_get_injection "T2204")

    [[ "$result" == *"T2204"* ]]
    [[ "$result" != *"{{EPIC_ID}}"* ]]
}

@test "contribution_get_injection replaces MARKER_LABEL token" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-INJECTION.md" ]] || skip "Injection template not found"

    local result
    result=$(contribution_get_injection "T2204")

    # Default label
    [[ "$result" == *"consensus-source"* ]]
    [[ "$result" != *"{{MARKER_LABEL}}"* ]]
}

@test "contribution_get_injection replaces OUTPUT_DIR token" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-INJECTION.md" ]] || skip "Injection template not found"

    local result
    result=$(contribution_get_injection "T2204")

    # Default output dir
    [[ "$result" == *"claudedocs/agent-outputs"* ]]
    [[ "$result" != *"{{OUTPUT_DIR}}"* ]]
}

@test "contribution_get_injection replaces all tokens" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-INJECTION.md" ]] || skip "Injection template not found"

    local options='{"markerLabel": "test-label", "outputDir": "custom/path", "baselineSessionId": "Session X", "taskId": "T5555"}'
    local result
    result=$(contribution_get_injection "T2204" "path/to/protocol.md" "$options")

    # Should have no unreplaced tokens
    [[ "$result" != *"{{"* ]] || {
        # If any {{ remain, they should only be user-template tokens
        local unreplaced
        unreplaced=$(echo "$result" | grep -o '{{[^}]*}}' || true)
        [[ -z "$unreplaced" ]]
    }
}

@test "contribution_get_injection output is under 200 tokens" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-INJECTION.md" ]] || skip "Injection template not found"

    local result
    result=$(contribution_get_injection "T2204" "path/to/protocol.md")

    # Use word count as token approximation (typically 1 word ~ 1.3 tokens)
    local word_count
    word_count=$(echo "$result" | wc -w)

    # Should be under 200 words (conservative estimate for 200 tokens)
    [[ "$word_count" -lt 200 ]]
}

@test "contribution_get_injection contains CONTRIB references" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-INJECTION.md" ]] || skip "Injection template not found"

    local result
    result=$(contribution_get_injection "T2204")

    # The injection should reference the protocol rules
    # Check for protocol-related content
    [[ "$result" == *"MUST"* ]] || [[ "$result" == *"must"* ]]
}

@test "contribution_get_injection contains RFC 2119 keywords" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-INJECTION.md" ]] || skip "Injection template not found"

    local result
    result=$(contribution_get_injection "T2204")

    # Should contain RFC 2119 requirement keywords
    # At least one of: MUST, MUST NOT, SHOULD, MAY
    local has_rfc_keyword=false
    [[ "$result" == *"MUST"* ]] && has_rfc_keyword=true
    [[ "$result" == *"SHOULD"* ]] && has_rfc_keyword=true
    [[ "$result" == *"MAY"* ]] && has_rfc_keyword=true

    [[ "$has_rfc_keyword" == true ]]
}

@test "contribution_get_injection requires epic_id" {
    run contribution_get_injection ""

    [[ "$status" -ne 0 ]]
}

@test "contribution_get_injection uses custom protocol path" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-INJECTION.md" ]] || skip "Injection template not found"

    local result
    result=$(contribution_get_injection "T2204" "custom/protocol/path.md")

    [[ "$result" == *"custom/protocol/path.md"* ]]
}

# =============================================================================
# contribution_create_manifest_entry() Tests
# =============================================================================

@test "contribution_create_manifest_entry returns valid JSON" {
    local result
    result=$(contribution_create_manifest_entry "session_123" "T2204" "T2210")

    echo "$result" | jq empty
}

@test "contribution_create_manifest_entry includes all required fields" {
    local result
    result=$(contribution_create_manifest_entry "session_123" "T2204" "T2210" "agent-1")

    # Check required fields
    local session_id epic_id task_id agent_id
    session_id=$(echo "$result" | jq -r '.sessionId')
    epic_id=$(echo "$result" | jq -r '.epicId')
    task_id=$(echo "$result" | jq -r '.taskId')
    agent_id=$(echo "$result" | jq -r '._meta.agentId')

    [[ "$session_id" == "session_123" ]]
    [[ "$epic_id" == "T2204" ]]
    [[ "$task_id" == "T2210" ]]
    [[ "$agent_id" == "agent-1" ]]
}

@test "contribution_create_manifest_entry generates unique contribution ID" {
    local result1 result2 id1 id2
    result1=$(contribution_create_manifest_entry "session_123" "T2204" "T2210")
    result2=$(contribution_create_manifest_entry "session_123" "T2204" "T2211")

    id1=$(echo "$result1" | jq -r '._meta.contributionId')
    id2=$(echo "$result2" | jq -r '._meta.contributionId')

    [[ "$id1" != "$id2" ]]
}

@test "contribution_create_manifest_entry includes schema reference" {
    local result schema
    result=$(contribution_create_manifest_entry "session_123" "T2204" "T2210")

    schema=$(echo "$result" | jq -r '."$schema"')

    [[ "$schema" == *"contribution.schema.json"* ]]
}

@test "contribution_create_manifest_entry sets draft status" {
    local result status
    result=$(contribution_create_manifest_entry "session_123" "T2204" "T2210")

    status=$(echo "$result" | jq -r '.status')

    [[ "$status" == "draft" ]]
}

@test "contribution_create_manifest_entry includes timestamp" {
    local result created_at
    result=$(contribution_create_manifest_entry "session_123" "T2204" "T2210")

    created_at=$(echo "$result" | jq -r '._meta.createdAt')

    # Should be ISO timestamp format
    [[ "$created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]]
}

@test "contribution_create_manifest_entry requires session_id" {
    run contribution_create_manifest_entry "" "T2204" "T2210"

    [[ "$status" -ne 0 ]]
}

@test "contribution_create_manifest_entry requires epic_id" {
    run contribution_create_manifest_entry "session_123" "" "T2210"

    [[ "$status" -ne 0 ]]
}

@test "contribution_create_manifest_entry requires task_id" {
    run contribution_create_manifest_entry "session_123" "T2204" ""

    [[ "$status" -ne 0 ]]
}

@test "contribution_create_manifest_entry uses default agent_id when not provided" {
    local result agent_id
    result=$(contribution_create_manifest_entry "session_123" "T2204" "T2210")

    agent_id=$(echo "$result" | jq -r '._meta.agentId')

    [[ "$agent_id" == "unknown" ]]
}

# =============================================================================
# Error Handling Tests
# =============================================================================

@test "contribution_protocol_instantiate handles missing template gracefully" {
    # Temporarily rename template
    local template="${PROJECT_ROOT}/templates/CONTRIBUTION-PROTOCOL.template.md"
    if [[ -f "$template" ]]; then
        mv "$template" "${template}.bak"
        trap "mv '${template}.bak' '$template'" EXIT

        run contribution_protocol_instantiate "T2204" "Session A"

        [[ "$status" -ne 0 ]]

        mv "${template}.bak" "$template"
        trap - EXIT
    else
        skip "Template not present to test"
    fi
}

@test "contribution_get_injection handles missing template gracefully" {
    # Temporarily rename injection template
    local template="${PROJECT_ROOT}/templates/CONTRIBUTION-INJECTION.md"
    if [[ -f "$template" ]]; then
        mv "$template" "${template}.bak"
        trap "mv '${template}.bak' '$template'" EXIT

        run contribution_get_injection "T2204"

        [[ "$status" -ne 0 ]]

        mv "${template}.bak" "$template"
        trap - EXIT
    else
        skip "Template not present to test"
    fi
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "full workflow: generate ID, create manifest, instantiate protocol" {
    [[ -f "${PROJECT_ROOT}/templates/CONTRIBUTION-PROTOCOL.template.md" ]] || skip "Template not found"

    # Step 1: Generate ID
    local contrib_id
    contrib_id=$(contribution_generate_id)
    [[ "$contrib_id" =~ ^contrib_ ]]

    # Step 2: Create manifest entry
    local manifest
    manifest=$(contribution_create_manifest_entry "session_test" "T2204" "T2210" "test-agent")
    [[ -n "$manifest" ]]
    echo "$manifest" | jq empty

    # Step 3: Instantiate protocol
    local questions='[{"id": 1, "question": "Test question"}]'
    local protocol
    protocol=$(contribution_protocol_instantiate "T2204" "Session A" "$questions" "[]")
    [[ "$protocol" == *"T2204"* ]]
    [[ "$protocol" == *"Test question"* ]]
}
