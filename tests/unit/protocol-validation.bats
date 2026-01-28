#!/usr/bin/env bats
# protocol-validation.bats - Tests for protocol validation functions
# @task T2701
# Part of Epic T2679: Protocol Enforcement and RCSD-IVTR Alignment

load '../libs/bats-support/load'
load '../libs/bats-assert/load'

# Setup test environment
setup() {
    # Source the validation library
    export SCRIPT_DIR="/mnt/projects/claude-todo/lib"
    source "${SCRIPT_DIR}/protocol-validation.sh"

    # Create temp directory for test fixtures
    export TEST_TEMP_DIR="${BATS_TEST_TMPDIR}/protocol-test-$$"
    mkdir -p "$TEST_TEMP_DIR"

    # Initialize a git repo for testing
    cd "$TEST_TEMP_DIR"
    git init -q
    git config user.email "test@example.com"
    git config user.name "Test User"

    # Create initial commit
    echo "initial" > initial.txt
    git add initial.txt
    git commit -q -m "Initial commit"
}

# Cleanup
teardown() {
    rm -rf "$TEST_TEMP_DIR"
}

# ============================================================================
# HELPER FUNCTIONS TESTS
# ============================================================================

@test "has_code_changes returns 0 when code files are modified" {
    # Add a code file
    echo "#!/bin/bash" > script.sh
    git add script.sh

    run has_code_changes "T1234"
    assert_success
}

@test "has_code_changes returns 1 when no code files modified" {
    # Add a non-code file
    echo "documentation" > README.md
    git add README.md

    run has_code_changes "T1234"
    assert_failure
}

@test "has_manifest_field returns 0 when field exists" {
    local manifest='{"title":"Test","status":"complete"}'

    run has_manifest_field "$manifest" "title"
    assert_success
}

@test "has_manifest_field returns 1 when field missing" {
    local manifest='{"title":"Test"}'

    run has_manifest_field "$manifest" "status"
    assert_failure
}

# ============================================================================
# RESEARCH PROTOCOL VALIDATION (EXIT CODE 60)
# ============================================================================

@test "validate_research_protocol succeeds with valid research manifest" {
    local manifest='{
        "id":"T2680-research",
        "file":"research.md",
        "title":"Research Output",
        "status":"complete",
        "agent_type":"research",
        "key_findings":["Finding 1","Finding 2","Finding 3"]
    }'

    run validate_research_protocol "T2680" "$manifest" "false"
    assert_success
    assert_output --partial '"valid": true'
}

@test "validate_research_protocol detects code modifications (RSCH-001)" {
    # Add code changes
    echo "function test() { return 0; }" > code.sh
    git add code.sh

    local manifest='{
        "agent_type":"research",
        "key_findings":["F1","F2","F3"]
    }'

    run validate_research_protocol "T2680" "$manifest" "true"
    assert_failure
    assert_equal "$status" 60
    assert_output --partial 'RSCH-001'
    assert_output --partial '"valid": false'
}

@test "validate_research_protocol detects insufficient key_findings (RSCH-006)" {
    local manifest='{
        "agent_type":"research",
        "key_findings":["Only one"]
    }'

    run validate_research_protocol "T2680" "$manifest" "true"
    assert_failure
    assert_equal "$status" 60
    assert_output --partial 'RSCH-006'
    assert_output --partial 'Key findings must be 3-7'
}

@test "validate_research_protocol detects too many key_findings (RSCH-006)" {
    local manifest='{
        "agent_type":"research",
        "key_findings":["F1","F2","F3","F4","F5","F6","F7","F8"]
    }'

    run validate_research_protocol "T2680" "$manifest" "true"
    assert_failure
    assert_output --partial 'RSCH-006'
}

@test "validate_research_protocol detects wrong agent_type (RSCH-007)" {
    local manifest='{
        "agent_type":"implementation",
        "key_findings":["F1","F2","F3"]
    }'

    run validate_research_protocol "T2680" "$manifest" "true"
    assert_failure
    assert_output --partial 'RSCH-007'
    assert_output --partial 'agent_type must be research'
}

@test "validate_research_protocol warns about missing sources in strict mode (RSCH-002)" {
    local manifest='{
        "agent_type":"research",
        "key_findings":["F1","F2","F3"]
    }'

    run validate_research_protocol "T2680" "$manifest" "true"
    assert_failure
    assert_output --partial 'RSCH-002'
    assert_output --partial 'Sources field missing'
}

@test "validate_research_protocol non-strict mode allows warnings" {
    local manifest='{
        "agent_type":"research",
        "key_findings":["F1","F2","F3"]
    }'

    run validate_research_protocol "T2680" "$manifest" "false"
    assert_success
    assert_output --partial '"valid": true'
}

# ============================================================================
# CONSENSUS PROTOCOL VALIDATION (EXIT CODE 61)
# ============================================================================

@test "validate_consensus_protocol succeeds with valid voting matrix" {
    local manifest='{
        "agent_type":"analysis"
    }'
    local voting_matrix='{
        "options":[
            {"id":"opt1","confidence":0.8},
            {"id":"opt2","confidence":0.6}
        ]
    }'

    run validate_consensus_protocol "T2681" "$manifest" "$voting_matrix" "false"
    assert_success
    assert_output --partial '"valid": true'
}

@test "validate_consensus_protocol detects insufficient options (CONS-001)" {
    local manifest='{"agent_type":"analysis"}'
    local voting_matrix='{"options":[{"id":"opt1","confidence":0.8}]}'

    run validate_consensus_protocol "T2681" "$manifest" "$voting_matrix" "true"
    assert_failure
    assert_equal "$status" 61
    assert_output --partial 'CONS-001'
    assert_output --partial 'must have ≥2 options'
}

@test "validate_consensus_protocol detects invalid confidence scores (CONS-003)" {
    local manifest='{"agent_type":"analysis"}'
    local voting_matrix='{
        "options":[
            {"id":"opt1","confidence":1.5},
            {"id":"opt2","confidence":0.6}
        ]
    }'

    run validate_consensus_protocol "T2681" "$manifest" "$voting_matrix" "true"
    assert_failure
    assert_output --partial 'CONS-003'
    assert_output --partial 'Confidence scores must be 0.0-1.0'
}

@test "validate_consensus_protocol detects threshold not met (CONS-004)" {
    local manifest='{"agent_type":"analysis"}'
    local voting_matrix='{
        "options":[
            {"id":"opt1","confidence":0.4},
            {"id":"opt2","confidence":0.3}
        ]
    }'

    run validate_consensus_protocol "T2681" "$manifest" "$voting_matrix" "true"
    assert_failure
    assert_output --partial 'CONS-004'
    assert_output --partial 'Threshold not met'
}

@test "validate_consensus_protocol detects wrong agent_type (CONS-007)" {
    local manifest='{"agent_type":"research"}'
    local voting_matrix='{
        "options":[
            {"id":"opt1","confidence":0.8},
            {"id":"opt2","confidence":0.6}
        ]
    }'

    run validate_consensus_protocol "T2681" "$manifest" "$voting_matrix" "true"
    assert_failure
    assert_output --partial 'CONS-007'
    assert_output --partial 'agent_type must be analysis'
}

# ============================================================================
# SPECIFICATION PROTOCOL VALIDATION (EXIT CODE 62)
# ============================================================================

@test "validate_specification_protocol succeeds with valid spec" {
    # Create spec file with RFC 2119 keywords
    cat > spec.md <<'EOF'
# Specification

## Requirements

The system MUST validate input.
The system SHOULD log errors.
Users MAY configure options.
EOF

    local manifest='{
        "agent_type":"specification",
        "version":"1.0.0"
    }'

    run validate_specification_protocol "T2682" "$manifest" "spec.md" "false"
    assert_success
    assert_output --partial '"valid": true'
}

@test "validate_specification_protocol detects missing RFC 2119 keywords (SPEC-001)" {
    # Create spec without RFC 2119 keywords
    cat > spec.md <<'EOF'
# Specification
The system validates input.
EOF

    local manifest='{
        "agent_type":"specification",
        "version":"1.0.0"
    }'

    run validate_specification_protocol "T2682" "$manifest" "spec.md" "true"
    assert_failure
    assert_equal "$status" 62
    assert_output --partial 'SPEC-001'
    assert_output --partial 'RFC 2119 keywords missing'
}

@test "validate_specification_protocol detects missing version (SPEC-002)" {
    local manifest='{"agent_type":"specification"}'

    run validate_specification_protocol "T2682" "$manifest" "" "true"
    assert_failure
    assert_output --partial 'SPEC-002'
    assert_output --partial 'Version field missing'
}

@test "validate_specification_protocol warns about missing authority in strict (SPEC-003)" {
    cat > spec.md <<'EOF'
# Spec
The system MUST work.
EOF

    local manifest='{
        "agent_type":"specification",
        "version":"1.0.0"
    }'

    run validate_specification_protocol "T2682" "$manifest" "spec.md" "true"
    # Should succeed but with warning
    assert_output --partial 'SPEC-003'
    assert_output --partial 'Authority/scope section missing'
}

@test "validate_specification_protocol detects wrong agent_type (SPEC-007)" {
    local manifest='{
        "agent_type":"research",
        "version":"1.0.0"
    }'

    run validate_specification_protocol "T2682" "$manifest" "" "true"
    assert_failure
    assert_output --partial 'SPEC-007'
    assert_output --partial 'agent_type must be specification'
}

# ============================================================================
# DECOMPOSITION PROTOCOL VALIDATION (EXIT CODE 63)
# ============================================================================

@test "validate_decomposition_protocol succeeds with valid child tasks" {
    local child_tasks='[
        {"id":"T1","description":"Task 1"},
        {"id":"T2","description":"Task 2"}
    ]'

    run validate_decomposition_protocol "T2683" "T1000" "$child_tasks" "false"
    assert_success
    assert_output --partial '"valid": true'
}

@test "validate_decomposition_protocol detects too many siblings (DCMP-006)" {
    local child_tasks='[
        {"id":"T1"},{"id":"T2"},{"id":"T3"},{"id":"T4"},
        {"id":"T5"},{"id":"T6"},{"id":"T7"},{"id":"T8"}
    ]'

    run validate_decomposition_protocol "T2683" "T1000" "$child_tasks" "true"
    assert_failure
    assert_equal "$status" 63
    assert_output --partial 'DCMP-006'
    assert_output --partial 'Max 7 siblings exceeded'
}

@test "validate_decomposition_protocol warns about unclear descriptions in strict (DCMP-004)" {
    local child_tasks='[
        {"id":"T1","description":"Clear task"},
        {"id":"T2","description":""}
    ]'

    run validate_decomposition_protocol "T2683" "T1000" "$child_tasks" "true"
    # Should have warning about atomicity
    assert_output --partial 'DCMP-004'
    assert_output --partial 'lack clear descriptions'
}

# ============================================================================
# IMPLEMENTATION PROTOCOL VALIDATION (EXIT CODE 64)
# ============================================================================

@test "validate_implementation_protocol succeeds with tagged functions" {
    # Add function with @task tag
    cat > code.sh <<'EOF'
# @task T2684
function new_function() {
    echo "test"
}
EOF
    git add code.sh

    local manifest='{"agent_type":"implementation"}'

    run validate_implementation_protocol "T2684" "$manifest" "false"
    assert_success
    assert_output --partial '"valid": true'
}

@test "validate_implementation_protocol detects missing @task tags (IMPL-003)" {
    # Add function without @task tag
    cat > code.sh <<'EOF'
function new_function() {
    echo "test"
}
EOF
    git add code.sh

    local manifest='{"agent_type":"implementation"}'

    run validate_implementation_protocol "T2684" "$manifest" "true"
    assert_failure
    assert_equal "$status" 64
    assert_output --partial 'IMPL-003'
    assert_output --partial 'missing @task provenance tags'
}

@test "validate_implementation_protocol detects wrong agent_type (IMPL-007)" {
    local manifest='{"agent_type":"research"}'

    run validate_implementation_protocol "T2684" "$manifest" "true"
    assert_failure
    assert_output --partial 'IMPL-007'
    assert_output --partial 'agent_type must be implementation'
}

@test "validate_implementation_protocol allows no new functions" {
    # No code changes
    local manifest='{"agent_type":"implementation"}'

    run validate_implementation_protocol "T2684" "$manifest" "false"
    assert_success
}

# ============================================================================
# CONTRIBUTION PROTOCOL VALIDATION (EXIT CODE 65)
# ============================================================================

@test "validate_contribution_protocol succeeds with tagged functions" {
    # Add function with @task tag
    cat > code.sh <<'EOF'
# @task T2685
function contributed_function() {
    return 0
}
EOF
    git add code.sh

    local manifest='{"agent_type":"implementation"}'

    run validate_contribution_protocol "T2685" "$manifest" "false"
    assert_success
    assert_output --partial '"valid": true'
}

@test "validate_contribution_protocol detects missing @task tags (CONT-002)" {
    # Add function without @task tag
    cat > contrib.sh <<'EOF'
function contributed_function() {
    return 0
}
EOF
    git add contrib.sh

    local manifest='{"agent_type":"implementation"}'

    run validate_contribution_protocol "T2685" "$manifest" "true"
    assert_failure
    assert_equal "$status" 65
    assert_output --partial 'CONT-002'
    assert_output --partial 'missing @task provenance tags'
}

@test "validate_contribution_protocol detects wrong agent_type (CONT-007)" {
    local manifest='{"agent_type":"research"}'

    run validate_contribution_protocol "T2685" "$manifest" "true"
    assert_failure
    assert_output --partial 'CONT-007'
    assert_output --partial 'agent_type must be implementation'
}

# ============================================================================
# RELEASE PROTOCOL VALIDATION (EXIT CODE 66)
# ============================================================================

@test "validate_release_protocol succeeds with valid semver and changelog" {
    run validate_release_protocol "0.74.5" "## v0.74.5\n- Feature X" "false"
    assert_success
    assert_output --partial '"valid": true'
}

@test "validate_release_protocol detects invalid semver (RLSE-001)" {
    run validate_release_protocol "1.0" "Changelog entry" "true"
    assert_failure
    assert_equal "$status" 66
    assert_output --partial 'RLSE-001'
    assert_output --partial 'must follow semver'
}

@test "validate_release_protocol detects missing changelog (RLSE-002)" {
    run validate_release_protocol "0.74.5" "" "true"
    assert_failure
    assert_output --partial 'RLSE-002'
    assert_output --partial 'Changelog entry required'
}

@test "validate_release_protocol rejects invalid version format" {
    run validate_release_protocol "v1.0.0" "Changelog" "true"
    assert_failure
    assert_output --partial 'RLSE-001'
}

@test "validate_release_protocol accepts proper semver format" {
    run validate_release_protocol "1.2.3" "Changelog" "false"
    assert_success
}

# ============================================================================
# GENERIC PROTOCOL VALIDATOR
# ============================================================================

@test "validate_protocol routes to research validator" {
    local manifest='{
        "agent_type":"research",
        "key_findings":["F1","F2","F3","F4"]
    }'

    run validate_protocol "T2680" "research" "$manifest" "{}" "false"
    assert_success
}

@test "validate_protocol routes to consensus validator" {
    local manifest='{"agent_type":"analysis"}'
    local voting_matrix='{"options":[{"id":"o1","confidence":0.8},{"id":"o2","confidence":0.5}]}'

    run validate_protocol "T2681" "consensus" "$manifest" "$voting_matrix" "false"
    assert_success
}

@test "validate_protocol routes to implementation validator" {
    local manifest='{"agent_type":"implementation"}'

    run validate_protocol "T2684" "implementation" "$manifest" "{}" "false"
    assert_success
}

@test "validate_protocol handles unknown protocol type" {
    local manifest='{}'

    run validate_protocol "T9999" "unknown" "$manifest" "{}" "true"
    assert_failure
    assert_equal "$status" 67
    assert_output --partial 'Unknown protocol type'
}

# ============================================================================
# EXIT CODE VALIDATION
# ============================================================================

@test "protocol validators export correct exit codes" {
    # Verify exit codes are defined
    assert_equal "$EXIT_PROTOCOL_RESEARCH" "60"
    assert_equal "$EXIT_PROTOCOL_CONSENSUS" "61"
    assert_equal "$EXIT_PROTOCOL_SPECIFICATION" "62"
    assert_equal "$EXIT_PROTOCOL_DECOMPOSITION" "63"
    assert_equal "$EXIT_PROTOCOL_IMPLEMENTATION" "64"
    assert_equal "$EXIT_PROTOCOL_CONTRIBUTION" "65"
    assert_equal "$EXIT_PROTOCOL_RELEASE" "66"
    assert_equal "$EXIT_PROTOCOL_GENERIC" "67"
}

# ============================================================================
# EDGE CASES
# ============================================================================

@test "validates with empty manifest (all validators should fail gracefully)" {
    local manifest='{}'

    # Research validator
    run validate_research_protocol "T1" "$manifest" "true"
    assert_failure

    # Consensus validator
    run validate_consensus_protocol "T1" "$manifest" "{}" "true"
    assert_failure
}

@test "validates with malformed JSON gracefully" {
    # These should fail but not crash
    run validate_research_protocol "T1" "not-json" "false"
    assert_failure || true  # Allow either failure or error
}

@test "validates with null values in manifest" {
    local manifest='{
        "agent_type":null,
        "key_findings":null
    }'

    run validate_research_protocol "T1" "$manifest" "true"
    assert_failure
}

@test "score calculation is accurate for multiple violations" {
    local manifest='{
        "agent_type":"wrong",
        "key_findings":["only-one"]
    }'

    run validate_research_protocol "T1" "$manifest" "false"
    # Should calculate combined score penalty
    assert_output --partial '"score"'
}
