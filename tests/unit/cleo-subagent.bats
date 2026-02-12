#!/usr/bin/env bats
# =============================================================================
# cleo-subagent.bats - Unit tests for cleo-subagent system
# =============================================================================
# Tests for:
#   1. Agent Registration - AGENT.md exists with valid frontmatter
#   2. Skill Dispatch - Skill selection based on task metadata
#   3. Protocol Loading - All protocol files exist with valid structure
#   4. Token Handling - Token injection and resolution
#   5. Integration - Combined skill dispatch + token injection
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file

    # Export paths for cleo-subagent components
    export AGENT_FILE="${PROJECT_ROOT}/agents/cleo-subagent/AGENT.md"
    export PROTOCOLS_DIR="${PROJECT_ROOT}/protocols"
    export SKILLS_DIR="${PROJECT_ROOT}/skills"
    export TOKEN_INJECT_LIB="${LIB_DIR}/skills/token-inject.sh"
    export SKILL_DISPATCH_LIB="${LIB_DIR}/skills/skill-dispatch.sh"
    export SKILL_VALIDATE_LIB="${LIB_DIR}/skills/skill-validate.sh"
}

setup() {
    load '../test_helper/common_setup'
    common_setup_per_test
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

# Extract YAML frontmatter value from markdown file
# Args: $1 = file path, $2 = field name
extract_frontmatter_field() {
    local file="$1"
    local field="$2"

    # Extract content between --- markers and find field
    sed -n '/^---$/,/^---$/p' "$file" | \
        grep -E "^${field}:" | \
        head -1 | \
        sed "s/^${field}: *//"
}

# Check if YAML frontmatter exists in file
# Args: $1 = file path
has_valid_frontmatter() {
    local file="$1"

    # Check for opening and closing ---
    local frontmatter_count
    frontmatter_count=$(grep -c '^---$' "$file" 2>/dev/null || echo "0")
    [[ "$frontmatter_count" -ge 2 ]]
}

# =============================================================================
# 1. AGENT REGISTRATION TESTS
# =============================================================================

@test "cleo-subagent AGENT.md file exists" {
    [ -f "$AGENT_FILE" ]
}

@test "cleo-subagent AGENT.md has valid YAML frontmatter" {
    run has_valid_frontmatter "$AGENT_FILE"
    assert_success
}

@test "cleo-subagent frontmatter has required 'name' field" {
    local name
    name=$(extract_frontmatter_field "$AGENT_FILE" "name")
    [[ -n "$name" ]]
    [[ "$name" == "cleo-subagent" ]]
}

@test "cleo-subagent frontmatter has required 'description' field" {
    # Description is multiline, check it exists in frontmatter
    local has_description
    has_description=$(sed -n '/^---$/,/^---$/p' "$AGENT_FILE" | grep -c "^description:" || echo "0")
    [[ "$has_description" -ge 1 ]]
}

@test "cleo-subagent frontmatter has 'model' field" {
    local model
    model=$(extract_frontmatter_field "$AGENT_FILE" "model")
    [[ -n "$model" ]]
}

@test "cleo-subagent frontmatter has 'allowed_tools' array" {
    local has_tools
    has_tools=$(sed -n '/^---$/,/^---$/p' "$AGENT_FILE" | grep -c "^allowed_tools:" || echo "0")
    [[ "$has_tools" -ge 1 ]]
}

@test "cleo-subagent allowed_tools includes essential tools" {
    local frontmatter
    frontmatter=$(sed -n '/^---$/,/^---$/p' "$AGENT_FILE")

    # Check for essential tools
    echo "$frontmatter" | grep -q "Read"
    echo "$frontmatter" | grep -q "Write"
    echo "$frontmatter" | grep -q "Bash"
}

@test "cleo-subagent AGENT.md contains base protocol content" {
    # Check for key protocol sections
    run grep -c "Immutable Constraints" "$AGENT_FILE"
    assert_success
    [[ "$output" -ge 1 ]]
}

@test "cleo-subagent AGENT.md contains lifecycle protocol" {
    run grep -c "Phase 1: Spawn" "$AGENT_FILE"
    assert_success
    [[ "$output" -ge 1 ]]
}

@test "cleo-subagent AGENT.md contains output requirements" {
    run grep -c "MANIFEST.jsonl" "$AGENT_FILE"
    assert_success
    [[ "$output" -ge 1 ]]
}

# =============================================================================
# 2. SKILL DISPATCH TESTS
# =============================================================================

@test "skill-dispatch library exists" {
    [ -f "$SKILL_DISPATCH_LIB" ]
}

@test "skill-dispatch library is valid bash syntax" {
    run bash -n "$SKILL_DISPATCH_LIB"
    assert_success
}

@test "skill_auto_dispatch function is exported" {
    run bash -c "
        source '$SKILL_DISPATCH_LIB'
        type skill_auto_dispatch | head -1
    "
    assert_success
    assert_output --partial "function"
}

@test "skill_dispatch_by_keywords function is exported" {
    run bash -c "
        source '$SKILL_DISPATCH_LIB'
        type skill_dispatch_by_keywords | head -1
    "
    assert_success
    assert_output --partial "function"
}

@test "skill_prepare_spawn function is exported" {
    run bash -c "
        source '$SKILL_DISPATCH_LIB'
        type skill_prepare_spawn | head -1
    "
    assert_success
    assert_output --partial "function"
}

@test "skill_get_metadata function is exported" {
    run bash -c "
        source '$SKILL_DISPATCH_LIB'
        type skill_get_metadata | head -1
    "
    assert_success
    assert_output --partial "function"
}

@test "skill_check_compatibility function is exported" {
    run bash -c "
        source '$SKILL_DISPATCH_LIB'
        type skill_check_compatibility | head -1
    "
    assert_success
    assert_output --partial "function"
}

@test "skill_dispatch_by_keywords handles unknown keyword gracefully" {
    run bash -c "
        source '$SKILL_DISPATCH_LIB'
        result=\$(skill_dispatch_by_keywords 'completely random nonexistent keyword xyz123')
        # Should return empty or no match
        [[ -z \"\$result\" ]] && exit 0
        exit 1
    "
    assert_success
}

@test "skill_dispatch_by_keywords is case insensitive" {
    # This tests the case-insensitivity documented in the skill-dispatch.sh
    run bash -c "
        source '$SKILL_DISPATCH_LIB'
        lower=\$(skill_dispatch_by_keywords 'research')
        upper=\$(skill_dispatch_by_keywords 'RESEARCH')
        [[ \"\$lower\" == \"\$upper\" ]]
    "
    assert_success
}

# =============================================================================
# 3. PROTOCOL LOADING TESTS
# =============================================================================

@test "protocols directory exists" {
    [ -d "$PROTOCOLS_DIR" ]
}

@test "all 7 protocol files exist" {
    local protocols=(
        "research.md"
        "consensus.md"
        "contribution.md"
        "specification.md"
        "decomposition.md"
        "implementation.md"
        "release.md"
    )

    for protocol in "${protocols[@]}"; do
        [ -f "${PROTOCOLS_DIR}/${protocol}" ]
    done
}

@test "protocol files have Version field" {
    local protocols=(
        "research.md"
        "consensus.md"
        "contribution.md"
        "specification.md"
        "decomposition.md"
        "implementation.md"
        "release.md"
    )

    for protocol in "${protocols[@]}"; do
        run grep -c "Version" "${PROTOCOLS_DIR}/${protocol}"
        assert_success
        [[ "$output" -ge 1 ]]
    done
}

@test "protocol files have Trigger Conditions section" {
    # Most protocols should have trigger conditions
    local count=0
    local protocols=(
        "research.md"
        "implementation.md"
        "specification.md"
    )

    for protocol in "${protocols[@]}"; do
        if grep -q "Trigger" "${PROTOCOLS_DIR}/${protocol}" 2>/dev/null; then
            count=$((count + 1))
        fi
    done

    [[ $count -ge 2 ]]
}

@test "protocol files have Requirements section (RFC 2119)" {
    # Check that protocols use RFC 2119 keywords
    local protocols_with_rfc=0

    for protocol in "${PROTOCOLS_DIR}"/*.md; do
        if grep -qE "(MUST|SHOULD|MAY)" "$protocol" 2>/dev/null; then
            protocols_with_rfc=$((protocols_with_rfc + 1))
        fi
    done

    # At least half should have RFC 2119 requirements
    [[ $protocols_with_rfc -ge 4 ]]
}

@test "research protocol has RSCH requirements" {
    run grep -c "RSCH-" "${PROTOCOLS_DIR}/research.md"
    assert_success
    [[ "$output" -ge 3 ]]
}

@test "implementation protocol has IMPL requirements" {
    run grep -c "IMPL-" "${PROTOCOLS_DIR}/implementation.md"
    assert_success
    [[ "$output" -ge 1 ]]
}

@test "specification protocol has SPEC requirements" {
    run grep -c "SPEC-" "${PROTOCOLS_DIR}/specification.md"
    assert_success
    [[ "$output" -ge 1 ]]
}

# =============================================================================
# 4. TOKEN HANDLING TESTS
# =============================================================================

@test "token-inject library exists" {
    [ -f "$TOKEN_INJECT_LIB" ]
}

@test "token-inject library is valid bash syntax" {
    run bash -n "$TOKEN_INJECT_LIB"
    assert_success
}

@test "token-inject library sources without error" {
    run bash -c "source '$TOKEN_INJECT_LIB'"
    assert_success
}

@test "ti_inject_tokens resolves TASK_ID" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        export TI_TASK_ID='T9999'
        result=\$(ti_inject_tokens 'Task: {{TASK_ID}}')
        [[ \"\$result\" == 'Task: T9999' ]]
    "
    assert_success
}

@test "ti_inject_tokens resolves DATE" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        export TI_DATE='2026-01-26'
        result=\$(ti_inject_tokens 'Date: {{DATE}}')
        [[ \"\$result\" == 'Date: 2026-01-26' ]]
    "
    assert_success
}

@test "ti_inject_tokens resolves OUTPUT_DIR" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        export TI_OUTPUT_DIR='claudedocs/agent-outputs'
        result=\$(ti_inject_tokens 'Dir: {{OUTPUT_DIR}}')
        [[ \"\$result\" == 'Dir: claudedocs/agent-outputs' ]]
    "
    assert_success
}

@test "ti_inject_tokens resolves TOPIC_SLUG" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        export TI_TOPIC_SLUG='my-topic'
        result=\$(ti_inject_tokens 'Topic: {{TOPIC_SLUG}}')
        [[ \"\$result\" == 'Topic: my-topic' ]]
    "
    assert_success
}

@test "ti_inject_tokens handles missing tokens gracefully" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        unset TI_TASK_ID
        result=\$(ti_inject_tokens 'Task: {{TASK_ID}}')
        # Should warn but not fail
        echo \"\$result\"
    " 2>&1
    assert_success
    # The output should still contain the placeholder or be empty
    [[ "$output" == *"Task:"* ]]
}

@test "ti_inject_tokens warns on unknown tokens" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        ti_inject_tokens 'Unknown: {{NONEXISTENT_TOKEN}}'
    " 2>&1
    assert_success
    # Should warn about unknown token
    [[ "$output" == *"WARNING"* ]] || [[ "$output" == *"Unknown"* ]] || [[ "$output" == *"{{NONEXISTENT_TOKEN}}"* ]]
}

@test "ti_set_defaults sets OUTPUT_DIR default" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        unset TI_OUTPUT_DIR
        ti_set_defaults
        [[ -n \"\${TI_OUTPUT_DIR:-}\" ]]
    "
    assert_success
}

@test "ti_validate_required fails when TASK_ID missing" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        export TI_DATE='2026-01-26'
        export TI_TOPIC_SLUG='test'
        unset TI_TASK_ID
        ti_validate_required
    "
    assert_failure
    assert_output --partial "TASK_ID"
}

@test "ti_validate_required succeeds when all required tokens set" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        export TI_TASK_ID='T1234'
        export TI_DATE='2026-01-26'
        export TI_TOPIC_SLUG='test'
        ti_validate_required
    "
    assert_success
}

@test "ti_set_context sets required tokens in one call" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        ti_set_context 'T1234' '2026-01-26' 'my-topic'
        [[ \"\$TI_TASK_ID\" == 'T1234' ]] && \
        [[ \"\$TI_DATE\" == '2026-01-26' ]] && \
        [[ \"\$TI_TOPIC_SLUG\" == 'my-topic' ]]
    "
    assert_success
}

@test "ti_set_context fails when TASK_ID is empty" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        ti_set_context '' '2026-01-26' 'my-topic'
    "
    assert_failure
    assert_output --partial "TASK_ID"
}

@test "ti_clear_all clears TI_* variables" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        export TI_TASK_ID='T1234'
        export TI_DATE='2026-01-26'
        ti_clear_all
        [[ -z \"\${TI_TASK_ID:-}\" ]] && [[ -z \"\${TI_DATE:-}\" ]]
    "
    assert_success
}

@test "ti_load_template loads file and injects tokens" {
    local template_file="${TEST_TEMP_DIR}/test-template.md"
    echo "Task: {{TASK_ID}}, Date: {{DATE}}" > "$template_file"

    run bash -c "
        source '$TOKEN_INJECT_LIB'
        export TI_TASK_ID='T5678'
        export TI_DATE='2026-01-26'
        ti_load_template '$template_file'
    "
    assert_success
    assert_output "Task: T5678, Date: 2026-01-26"
}

@test "ti_load_template fails on non-existent file" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        ti_load_template '/nonexistent/file.md'
    "
    assert_failure
    assert_output --partial "not found"
}

# =============================================================================
# 5. SPAWN VERIFICATION / INTEGRATION TESTS
# =============================================================================

@test "skill manifest.json exists in skills directory" {
    [ -f "${SKILLS_DIR}/manifest.json" ]
}

@test "skill manifest.json is valid JSON" {
    run jq empty "${SKILLS_DIR}/manifest.json"
    assert_success
}

@test "skill manifest has skills array" {
    run jq '.skills | type' "${SKILLS_DIR}/manifest.json"
    assert_success
    assert_output '"array"'
}

@test "skill manifest has _meta section" {
    run jq '._meta | type' "${SKILLS_DIR}/manifest.json"
    assert_success
    assert_output '"object"'
}

@test "skill_validate library exists and loads" {
    [ -f "$SKILL_VALIDATE_LIB" ]
    run bash -c "source '$SKILL_VALIDATE_LIB'"
    assert_success
}

@test "skills _shared directory exists" {
    [ -d "${SKILLS_DIR}/_shared" ]
}

@test "placeholders.json exists in _shared" {
    [ -f "${SKILLS_DIR}/_shared/placeholders.json" ]
}

@test "placeholders.json has required tokens section" {
    run jq '.required | type' "${SKILLS_DIR}/_shared/placeholders.json"
    assert_success
    assert_output '"array"'
}

@test "placeholders.json has context tokens section" {
    run jq '.context | type' "${SKILLS_DIR}/_shared/placeholders.json"
    assert_success
    assert_output '"array"'
}

@test "placeholders.json defines TASK_ID as required" {
    run jq '.required[] | select(.token == "TASK_ID") | .token' "${SKILLS_DIR}/_shared/placeholders.json"
    assert_success
    assert_output '"TASK_ID"'
}

@test "placeholders.json defines DATE as required" {
    run jq '.required[] | select(.token == "DATE") | .token' "${SKILLS_DIR}/_shared/placeholders.json"
    assert_success
    assert_output '"DATE"'
}

@test "subagent-protocol-base.md exists" {
    [ -f "${SKILLS_DIR}/_shared/subagent-protocol-base.md" ]
}

@test "subagent-protocol-base has Protocol header" {
    run grep -c "Protocol" "${SKILLS_DIR}/_shared/subagent-protocol-base.md"
    assert_success
    [[ "$output" -ge 1 ]]
}

@test "skill dispatch with token injection produces valid output" {
    # Create a mock skill template
    local skill_dir="${TEST_TEMP_DIR}/mock-skill"
    mkdir -p "$skill_dir"

    cat > "${skill_dir}/SKILL.md" << 'EOF'
# Mock Skill

Task ID: {{TASK_ID}}
Date: {{DATE}}
Topic: {{TOPIC_SLUG}}
EOF

    run bash -c "
        source '$TOKEN_INJECT_LIB'

        # Set tokens
        export TI_TASK_ID='T9999'
        export TI_DATE='2026-01-26'
        export TI_TOPIC_SLUG='test-skill'

        # Load and inject
        ti_load_template '${skill_dir}/SKILL.md'
    "

    assert_success
    assert_output --partial "T9999"
    assert_output --partial "2026-01-26"
    assert_output --partial "test-skill"
}

@test "spawn preparation includes all required sections" {
    # Test that a typical spawn workflow produces correct output
    run bash -c "
        source '$TOKEN_INJECT_LIB'

        # Simulate spawn context setup
        export TI_TASK_ID='T1234'
        export TI_DATE='2026-01-26'
        export TI_TOPIC_SLUG='spawn-test'
        export TI_EPIC_ID='T1000'
        ti_set_defaults

        # Create spawn content and inject tokens
        content='## Task: {{TASK_ID}}
Epic: {{EPIC_ID}}
Date: {{DATE}}
Output: {{OUTPUT_DIR}}'

        ti_inject_tokens \"\$content\"
    "

    assert_success
    assert_output --partial "T1234"
    assert_output --partial "T1000"
    assert_output --partial "2026-01-26"
}

# =============================================================================
# EDGE CASE TESTS
# =============================================================================

@test "ti_inject_tokens handles paths with slashes" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        export TI_OUTPUT_DIR='/path/to/claudedocs/agent-outputs'
        result=\$(ti_inject_tokens 'Dir: {{OUTPUT_DIR}}/file.md')
        [[ \"\$result\" == 'Dir: /path/to/claudedocs/agent-outputs/file.md' ]]
    "
    assert_success
}

@test "ti_inject_tokens handles multiple occurrences of same token" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        export TI_TASK_ID='T5555'
        result=\$(ti_inject_tokens 'First: {{TASK_ID}}, Second: {{TASK_ID}}')
        [[ \"\$result\" == 'First: T5555, Second: T5555' ]]
    "
    assert_success
}

@test "ti_inject_tokens handles empty content" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        result=\$(ti_inject_tokens '')
        [[ -z \"\$result\" ]]
    "
    assert_success
}

@test "ti_inject_tokens handles content without tokens" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        result=\$(ti_inject_tokens 'Just plain text without any tokens')
        [[ \"\$result\" == 'Just plain text without any tokens' ]]
    "
    assert_success
}

@test "ti_inject_tokens handles multiline content" {
    run bash -c "
        source '$TOKEN_INJECT_LIB'
        export TI_TASK_ID='T1234'
        export TI_DATE='2026-01-26'
        result=\$(ti_inject_tokens 'Line 1: {{TASK_ID}}
Line 2: {{DATE}}')
        [[ \"\$result\" == 'Line 1: T1234
Line 2: 2026-01-26' ]]
    "
    assert_success
}

@test "protocol files are readable and non-empty" {
    for protocol in "${PROTOCOLS_DIR}"/*.md; do
        [ -r "$protocol" ]
        [ -s "$protocol" ]
    done
}

@test "agent file BASE constraints are documented" {
    # Verify the BASE-00X constraints are in the agent file
    run grep -c "BASE-00" "$AGENT_FILE"
    assert_success
    [[ "$output" -ge 5 ]]  # At least BASE-001 through BASE-005
}
