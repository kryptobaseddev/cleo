#!/usr/bin/env bats
# =============================================================================
# protocol-stack.bats - Integration tests for Protocol Stack
# =============================================================================
# Tests the complete protocol stack including:
# - Protocol file validation (all 7 protocols exist with required sections)
# - Protocol trigger detection (keyword-based activation)
# - Protocol combination tests (max 3 active)
# - Output validation tests (required sections per protocol)
# - Base protocol integration
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file

    # Set up protocol directory path
    export PROTOCOLS_DIR="${PROJECT_ROOT}/protocols"
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    load '../test_helper/assertions'
    common_setup_per_test

    # Create empty todo for task operations
    create_empty_todo

    # RCSD protocols that must have standard sections
    # agent-protocol.md is a meta-protocol, not an RCSD protocol
    RCSD_PROTOCOLS=(
        "research.md" "consensus.md" "specification.md"
        "decomposition.md" "implementation.md" "contribution.md" "release.md"
    )
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

# Check if a protocol file contains a specific section
protocol_has_section() {
    local protocol_file="$1"
    local section_name="$2"
    grep -qi "## ${section_name}" "$protocol_file"
}

# Extract trigger keywords from a protocol file
get_trigger_keywords() {
    local protocol_file="$1"
    # Extract keywords from the Trigger Conditions table
    grep -A 50 "## Trigger Conditions" "$protocol_file" | \
        grep -E '^\|[^-]' | \
        sed 's/|/\n/g' | \
        grep -E '"[^"]*"' | \
        tr -d '"' | \
        sort -u
}

# Check if protocol file defines max active protocols
protocol_has_max_active() {
    local protocol_file="$1"
    grep -qi "Max Active.*3 protocols" "$protocol_file"
}

# =============================================================================
# PROTOCOL FILE VALIDATION TESTS
# =============================================================================

@test "protocol files: all 7 protocol files exist in protocols directory" {
    local expected_protocols=(
        "research.md"
        "consensus.md"
        "contribution.md"
        "specification.md"
        "decomposition.md"
        "implementation.md"
        "release.md"
    )

    for protocol in "${expected_protocols[@]}"; do
        [[ -f "${PROTOCOLS_DIR}/${protocol}" ]]
    done
}

@test "protocol files: each protocol has Trigger Conditions section" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        protocol_has_section "$protocol_file" "Trigger Conditions"
    done
}

@test "protocol files: each protocol has Requirements section" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        # Check for "Requirements (RFC 2119)" section
        grep -qi "## Requirements" "$protocol_file"
    done
}

@test "protocol files: each protocol has Output Format section" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        protocol_has_section "$protocol_file" "Output Format"
    done
}

@test "protocol files: each protocol has Integration Points section" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        protocol_has_section "$protocol_file" "Integration Points"
    done
}

@test "protocol files: each protocol has Anti-Patterns section" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        protocol_has_section "$protocol_file" "Anti-Patterns"
    done
}

@test "protocol files: each protocol declares Max Active: 3 protocols" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        protocol_has_max_active "$protocol_file"
    done
}

@test "protocol files: each protocol has version number" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        grep -qi "Version.*1\.0\.0" "$protocol_file"
    done
}

@test "protocol files: each protocol has Manifest Entry format" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        grep -qi "Manifest Entry" "$protocol_file"
    done
}

# =============================================================================
# PROTOCOL TRIGGER DETECTION TESTS
# =============================================================================

@test "trigger detection: research protocol triggers on 'investigate' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/research.md"
    grep -qi "investigate" "$protocol_file"
}

@test "trigger detection: research protocol triggers on 'research' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/research.md"
    grep -qi '"research"' "$protocol_file"
}

@test "trigger detection: research protocol triggers on 'explore' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/research.md"
    grep -qi "explore" "$protocol_file"
}

@test "trigger detection: implementation protocol triggers on 'build' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/implementation.md"
    grep -qi '"build"' "$protocol_file"
}

@test "trigger detection: implementation protocol triggers on 'implement' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/implementation.md"
    grep -qi '"implement"' "$protocol_file"
}

@test "trigger detection: implementation protocol triggers on 'fix' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/implementation.md"
    grep -qi '"fix"' "$protocol_file"
}

@test "trigger detection: decomposition protocol triggers on 'break down' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/decomposition.md"
    grep -qi "break down" "$protocol_file"
}

@test "trigger detection: decomposition protocol triggers on 'decompose' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/decomposition.md"
    grep -qi '"decompose"' "$protocol_file"
}

@test "trigger detection: decomposition protocol triggers on 'epic' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/decomposition.md"
    grep -qi '"epic"' "$protocol_file"
}

@test "trigger detection: release protocol triggers on 'version' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/release.md"
    grep -qi '"version"' "$protocol_file"
}

@test "trigger detection: release protocol triggers on 'release' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/release.md"
    grep -qi '"release"' "$protocol_file"
}

@test "trigger detection: release protocol triggers on 'changelog' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/release.md"
    grep -qi '"changelog"' "$protocol_file"
}

@test "trigger detection: specification protocol triggers on 'spec' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/specification.md"
    grep -qi '"spec"' "$protocol_file"
}

@test "trigger detection: specification protocol triggers on 'design' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/specification.md"
    grep -qi '"design"' "$protocol_file"
}

@test "trigger detection: consensus protocol triggers on 'vote' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/consensus.md"
    grep -qi '"vote"' "$protocol_file"
}

@test "trigger detection: consensus protocol triggers on 'decide' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/consensus.md"
    grep -qi '"decide"' "$protocol_file"
}

@test "trigger detection: contribution protocol triggers on 'pull request' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/contribution.md"
    grep -qi "pull request" "$protocol_file"
}

@test "trigger detection: contribution protocol triggers on 'PR' keyword" {
    local protocol_file="${PROTOCOLS_DIR}/contribution.md"
    grep -qi '"PR"' "$protocol_file"
}

@test "trigger detection: each protocol has explicit override flag documented" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        grep -qi "Explicit Override.*--protocol" "$protocol_file"
    done
}

# =============================================================================
# PROTOCOL COMBINATION TESTS
# =============================================================================

@test "protocol combination: research + specification protocols can combine" {
    local research="${PROTOCOLS_DIR}/research.md"
    local specification="${PROTOCOLS_DIR}/specification.md"

    # Both protocols document interaction with each other
    grep -qi "specification" "$research"
    grep -qi "research" "$specification"
}

@test "protocol combination: implementation + contribution protocols can combine" {
    local implementation="${PROTOCOLS_DIR}/implementation.md"
    local contribution="${PROTOCOLS_DIR}/contribution.md"

    # Implementation mentions contribution
    grep -qi "contribution" "$implementation"
    # Contribution mentions implementation
    grep -qi "implementation" "$contribution"
}

@test "protocol combination: research + consensus protocols can combine" {
    local research="${PROTOCOLS_DIR}/research.md"
    local consensus="${PROTOCOLS_DIR}/consensus.md"

    # Research mentions consensus
    grep -qi "consensus" "$research"
    # Consensus mentions research
    grep -qi "research" "$consensus"
}

@test "protocol combination: decomposition + implementation protocols can combine" {
    local decomposition="${PROTOCOLS_DIR}/decomposition.md"
    local implementation="${PROTOCOLS_DIR}/implementation.md"

    # Decomposition mentions implementation
    grep -qi "implementation" "$decomposition"
}

@test "protocol combination: specification + implementation protocols can combine" {
    local specification="${PROTOCOLS_DIR}/specification.md"
    local implementation="${PROTOCOLS_DIR}/implementation.md"

    # Specification mentions implementation
    grep -qi "implementation" "$specification"
}

@test "protocol combination: contribution + release protocols can combine" {
    local contribution="${PROTOCOLS_DIR}/contribution.md"
    local release="${PROTOCOLS_DIR}/release.md"

    # Release mentions contribution
    grep -qi "contribution" "$release"
}

@test "protocol combination: max 3 protocols enforced in all protocol files" {
    local count=0
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        if protocol_has_max_active "$protocol_file"; then
            count=$((count + 1))
        fi
    done

    # All 7 protocols should declare max 3
    [[ "$count" -eq 7 ]]
}

@test "protocol combination: Protocol Interactions table exists in each protocol" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        grep -qi "Protocol Interactions" "$protocol_file"
    done
}

# =============================================================================
# OUTPUT VALIDATION TESTS
# =============================================================================

@test "output validation: research output includes Sources section" {
    local protocol_file="${PROTOCOLS_DIR}/research.md"
    grep -qi "## Sources" "$protocol_file"
}

@test "output validation: research output includes Findings section" {
    local protocol_file="${PROTOCOLS_DIR}/research.md"
    grep -qi "## Findings" "$protocol_file"
}

@test "output validation: research output includes Recommendations section" {
    local protocol_file="${PROTOCOLS_DIR}/research.md"
    grep -qi "## Recommendations" "$protocol_file"
}

@test "output validation: implementation output includes Tests section" {
    local protocol_file="${PROTOCOLS_DIR}/implementation.md"
    grep -qi "## Tests" "$protocol_file"
}

@test "output validation: implementation output includes Validation section" {
    local protocol_file="${PROTOCOLS_DIR}/implementation.md"
    grep -qi "## Validation" "$protocol_file"
}

@test "output validation: implementation output includes Changes section" {
    local protocol_file="${PROTOCOLS_DIR}/implementation.md"
    grep -qi "## Changes" "$protocol_file"
}

@test "output validation: release output includes Changelog section" {
    local protocol_file="${PROTOCOLS_DIR}/release.md"
    grep -qi "Changelog" "$protocol_file"
}

@test "output validation: release output includes Validation Gates" {
    local protocol_file="${PROTOCOLS_DIR}/release.md"
    grep -qi "Validation Gates" "$protocol_file"
}

@test "output validation: release output includes Release Checklist" {
    local protocol_file="${PROTOCOLS_DIR}/release.md"
    grep -qi "Release Checklist" "$protocol_file"
}

@test "output validation: consensus output includes Voting structure" {
    local protocol_file="${PROTOCOLS_DIR}/consensus.md"
    grep -qi "Voting" "$protocol_file"
}

@test "output validation: consensus output includes Verdict thresholds" {
    local protocol_file="${PROTOCOLS_DIR}/consensus.md"
    grep -qi "Verdict" "$protocol_file"
}

@test "output validation: consensus output includes Conflict structure" {
    local protocol_file="${PROTOCOLS_DIR}/consensus.md"
    grep -qi "Conflict" "$protocol_file"
}

@test "output validation: specification output includes RFC 2119 declaration" {
    local protocol_file="${PROTOCOLS_DIR}/specification.md"
    grep -qi "RFC 2119" "$protocol_file"
}

@test "output validation: specification output includes Version semantics" {
    local protocol_file="${PROTOCOLS_DIR}/specification.md"
    grep -qi "Version Semantics" "$protocol_file"
}

@test "output validation: specification output includes Conformance section" {
    local protocol_file="${PROTOCOLS_DIR}/specification.md"
    grep -qi "Conformance" "$protocol_file"
}

@test "output validation: decomposition output includes Hierarchy structure" {
    local protocol_file="${PROTOCOLS_DIR}/decomposition.md"
    grep -qi "Hierarchy" "$protocol_file"
}

@test "output validation: decomposition output includes Wave analysis" {
    local protocol_file="${PROTOCOLS_DIR}/decomposition.md"
    grep -qi "Wave" "$protocol_file"
}

@test "output validation: decomposition output includes Atomicity criteria" {
    local protocol_file="${PROTOCOLS_DIR}/decomposition.md"
    grep -qi "Atomicity" "$protocol_file"
}

@test "output validation: contribution output includes Commit message format" {
    local protocol_file="${PROTOCOLS_DIR}/contribution.md"
    grep -qi "Commit Message" "$protocol_file"
}

@test "output validation: contribution output includes Provenance tag format" {
    local protocol_file="${PROTOCOLS_DIR}/contribution.md"
    grep -qi "Provenance" "$protocol_file"
}

@test "output validation: contribution output includes Validation gates" {
    local protocol_file="${PROTOCOLS_DIR}/contribution.md"
    grep -qi "Validation Gates" "$protocol_file"
}

# =============================================================================
# BASE PROTOCOL INTEGRATION TESTS
# =============================================================================

@test "base protocol: all protocols inherit task lifecycle" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        # Check for mention of task lifecycle
        grep -qi "task lifecycle" "$protocol_file" || \
        grep -qi "focus.*execute.*complete" "$protocol_file"
    done
}

@test "base protocol: all protocols inherit manifest append requirement" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        grep -qi "manifest append" "$protocol_file" || \
        grep -qi "append.*manifest" "$protocol_file"
    done
}

@test "base protocol: all protocols inherit error handling patterns" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        grep -qi "error handling" "$protocol_file"
    done
}

@test "base protocol: manifest format consistent across protocols" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        # All protocols should have manifest entry with required fields
        grep -q '"id"' "$protocol_file"
        grep -q '"file"' "$protocol_file"
        grep -q '"title"' "$protocol_file"
        grep -q '"date"' "$protocol_file"
        grep -q '"status"' "$protocol_file"
        grep -q '"key_findings"' "$protocol_file"
    done
}

@test "base protocol: all protocols specify agent_type in manifest" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        grep -qi "agent_type" "$protocol_file"
    done
}

# =============================================================================
# AGENT TYPE VALIDATION TESTS
# =============================================================================

@test "agent type: research protocol sets agent_type to research" {
    local protocol_file="${PROTOCOLS_DIR}/research.md"
    grep -qi 'agent_type.*research' "$protocol_file"
}

@test "agent type: implementation protocol sets agent_type to implementation" {
    local protocol_file="${PROTOCOLS_DIR}/implementation.md"
    grep -qi 'agent_type.*implementation' "$protocol_file"
}

@test "agent type: consensus protocol sets agent_type to analysis" {
    local protocol_file="${PROTOCOLS_DIR}/consensus.md"
    grep -qi 'agent_type.*analysis' "$protocol_file"
}

@test "agent type: decomposition protocol sets agent_type to analysis" {
    local protocol_file="${PROTOCOLS_DIR}/decomposition.md"
    grep -qi 'agent_type.*analysis' "$protocol_file"
}

@test "agent type: specification protocol sets agent_type to specification" {
    local protocol_file="${PROTOCOLS_DIR}/specification.md"
    grep -qi 'agent_type.*specification' "$protocol_file"
}

@test "agent type: contribution protocol sets agent_type to implementation" {
    local protocol_file="${PROTOCOLS_DIR}/contribution.md"
    grep -qi 'agent_type.*implementation' "$protocol_file"
}

@test "agent type: release protocol sets agent_type to documentation" {
    local protocol_file="${PROTOCOLS_DIR}/release.md"
    grep -qi 'agent_type.*documentation' "$protocol_file"
}

# =============================================================================
# REQUIREMENT LEVEL TESTS (RFC 2119)
# =============================================================================

@test "rfc2119: all protocols have MUST requirements" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        grep -q "MUST" "$protocol_file"
    done
}

@test "rfc2119: all protocols have SHOULD requirements" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        grep -q "SHOULD" "$protocol_file"
    done
}

@test "rfc2119: all protocols have MAY requirements" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        grep -q "MAY" "$protocol_file"
    done
}

@test "rfc2119: requirements are formatted in tables" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        # Check for requirement table format (pipe-delimited)
        grep -E '^\| [A-Z]{4}-[0-9]{3}' "$protocol_file" >/dev/null || \
        grep -E '^\| REQ-[0-9]{3}' "$protocol_file" >/dev/null || \
        grep -E '^\| IMPL-[0-9]{3}|RSCH-[0-9]{3}|CONS-[0-9]{3}|SPEC-[0-9]{3}|DCMP-[0-9]{3}|CONT-[0-9]{3}|RLSE-[0-9]{3}' "$protocol_file" >/dev/null
    done
}

# =============================================================================
# EXAMPLE SECTION TESTS
# =============================================================================

@test "examples: all protocols have Example section" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        grep -qi "## Example" "$protocol_file"
    done
}

@test "examples: all examples include Task ID reference" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        grep -q "T[0-9]" "$protocol_file"
    done
}

@test "examples: all examples include manifest entry JSON" {
    for _proto in "${RCSD_PROTOCOLS[@]}"; do protocol_file="${PROTOCOLS_DIR}/${_proto}"
        # Look for manifest entry in JSON format
        grep -A 10 "Manifest Entry" "$protocol_file" | grep -q '"id"'
    done
}

# =============================================================================
# HANDOFF PATTERN TESTS
# =============================================================================

@test "handoff: research protocol defines handoff patterns" {
    local protocol_file="${PROTOCOLS_DIR}/research.md"
    grep -qi "Handoff" "$protocol_file"
}

@test "handoff: consensus protocol defines HITL escalation" {
    local protocol_file="${PROTOCOLS_DIR}/consensus.md"
    grep -qi "HITL" "$protocol_file"
}

@test "handoff: decomposition protocol integrates with CLEO" {
    local protocol_file="${PROTOCOLS_DIR}/decomposition.md"
    grep -qi "CLEO Integration" "$protocol_file" || \
    grep -qi "cleo add" "$protocol_file"
}

@test "handoff: implementation protocol defines workflow sequence" {
    local protocol_file="${PROTOCOLS_DIR}/implementation.md"
    grep -qi "Workflow Sequence" "$protocol_file"
}

@test "handoff: release protocol defines release workflow" {
    local protocol_file="${PROTOCOLS_DIR}/release.md"
    grep -qi "Release Workflow" "$protocol_file"
}
