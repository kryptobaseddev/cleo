#!/usr/bin/env bash
# protocol-validation.sh - Protocol enforcement validation functions
#
# @task T2692
# LAYER: 2 (Protocol Enforcement)
# DEPENDENCIES: exit-codes.sh, file-ops.sh
# PROVIDES: validate_research_protocol, validate_consensus_protocol,
#           validate_specification_protocol, validate_decomposition_protocol,
#           validate_implementation_protocol, validate_contribution_protocol,
#           validate_release_protocol
#
# Part of Epic T2679: Protocol Enforcement and RCSD-IVTR Alignment
# Implements PROTOCOL-ENFORCEMENT-SPEC.md validation functions (Part 3)

#=== SOURCE GUARD ================================================
[[ -n "${_PROTOCOL_VALIDATION_SH_LOADED:-}" ]] && return 0
declare -r _PROTOCOL_VALIDATION_SH_LOADED=1

set -euo pipefail

# Source dependencies
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/exit-codes.sh"

# ============================================================================
# PROTOCOL VIOLATION EXIT CODES (60-67)
# Per PROTOCOL-ENFORCEMENT-SPEC.md Part 3.3
# ============================================================================

readonly EXIT_PROTOCOL_RESEARCH=60
readonly EXIT_PROTOCOL_CONSENSUS=61
readonly EXIT_PROTOCOL_SPECIFICATION=62
readonly EXIT_PROTOCOL_DECOMPOSITION=63
readonly EXIT_PROTOCOL_IMPLEMENTATION=64
readonly EXIT_PROTOCOL_CONTRIBUTION=65
readonly EXIT_PROTOCOL_RELEASE=66
readonly EXIT_PROTOCOL_GENERIC=67

# ============================================================================
# VALIDATION HELPER FUNCTIONS
# ============================================================================

# Check if git diff shows code changes
# Returns: 0 if code changes detected, 1 if clean
has_code_changes() {
    local task_id="$1"

    # Get list of code files changed
    local changed_files
    changed_files=$(git diff --name-only HEAD 2>/dev/null | grep -E '\.(sh|js|py|ts|go|rb|java|c|cpp|rs)$' || true)

    [[ -n "$changed_files" ]]
}

# Check if manifest entry has required field
# Args: manifest_entry (JSON), field_name
# Returns: 0 if present, 1 if missing
has_manifest_field() {
    local manifest_entry="$1"
    local field_name="$2"

    local value
    value=$(echo "$manifest_entry" | jq -r ".${field_name} // empty")
    [[ -n "$value" ]]
}

# ============================================================================
# RESEARCH PROTOCOL VALIDATION (RSCH-*)
# Per protocols/research.md and PROTOCOL-ENFORCEMENT-SPEC.md Part 4.1
# ============================================================================

# Validate research protocol compliance
# Args: task_id, manifest_entry (JSON), [strict mode]
# Returns: JSON with {valid, violations, score}
# Exit: 0 if valid, 60 if violations and strict mode
validate_research_protocol() {
    local task_id="$1"
    local manifest_entry="$2"
    local strict="${3:-false}"

    local violations=()
    local score=100

    # RSCH-001: MUST NOT implement code
    if has_code_changes "$task_id"; then
        violations+=('{"requirement":"RSCH-001","severity":"error","message":"Research task modified code","fix":"Revert code changes, research is read-only"}')
        score=$((score - 30))
    fi

    # RSCH-004: MUST append to MANIFEST.jsonl (checked by caller, file existence)
    # We assume if we got manifest_entry, this passed

    # RSCH-006: MUST include 3-7 key findings
    local findings_count
    findings_count=$(echo "$manifest_entry" | jq '.key_findings | length // 0')
    if [[ $findings_count -lt 3 || $findings_count -gt 7 ]]; then
        violations+=('{"requirement":"RSCH-006","severity":"error","message":"Key findings must be 3-7, got '"$findings_count"'","fix":"Add/remove findings in manifest entry"}')
        score=$((score - 20))
    fi

    # RSCH-007: MUST set agent_type: research
    local agent_type
    agent_type=$(echo "$manifest_entry" | jq -r '.agent_type // empty')
    if [[ "$agent_type" != "research" ]]; then
        violations+=('{"requirement":"RSCH-007","severity":"error","message":"agent_type must be research, got '"$agent_type"'","fix":"Update manifest entry agent_type field"}')
        score=$((score - 15))
    fi

    # RSCH-002: SHOULD document sources (warning only)
    if ! has_manifest_field "$manifest_entry" "sources"; then
        if [[ "$strict" == "true" ]]; then
            violations+=('{"requirement":"RSCH-002","severity":"warning","message":"Sources field missing","fix":"Add sources array to manifest"}')
            score=$((score - 10))
        fi
    fi

    # Build result JSON
    local valid="true"
    if [[ ${#violations[@]} -gt 0 ]]; then
        valid="false"
    fi

    local violations_json
    if [[ ${#violations[@]} -gt 0 ]]; then
        violations_json=$(printf '%s\n' "${violations[@]}" | jq -s '.')
    else
        violations_json='[]'
    fi

    local result
    result=$(jq -n \
        --argjson valid "$valid" \
        --argjson violations "$violations_json" \
        --argjson score "$score" \
        '{valid: $valid, violations: $violations, score: $score}')

    echo "$result"

    # Exit code
    if [[ "$valid" == "false" && "$strict" == "true" ]]; then
        return $EXIT_PROTOCOL_RESEARCH
    fi

    return 0
}

# ============================================================================
# CONSENSUS PROTOCOL VALIDATION (CONS-*)
# Per protocols/consensus.md and PROTOCOL-ENFORCEMENT-SPEC.md Part 4.2
# ============================================================================

# Validate consensus protocol compliance
# Args: task_id, manifest_entry (JSON), [voting_matrix (JSON)], [strict mode]
# Returns: JSON with {valid, violations, score}
# Exit: 0 if valid, 61 if violations and strict mode
validate_consensus_protocol() {
    local task_id="$1"
    local manifest_entry="$2"
    local voting_matrix="${3:-{}}"
    local strict="${4:-false}"

    local violations=()
    local score=100

    # CONS-001: MUST have voting matrix with ≥2 options
    local options_count
    options_count=$(echo "$voting_matrix" | jq '.options | length // 0')
    if [[ $options_count -lt 2 ]]; then
        violations+=('{"requirement":"CONS-001","severity":"error","message":"Voting matrix must have ≥2 options, got '"$options_count"'","fix":"Add more options to voting matrix"}')
        score=$((score - 25))
    fi

    # CONS-003: MUST have confidence scores (0.0-1.0)
    if [[ $options_count -gt 0 ]]; then
        local invalid_confidence
        invalid_confidence=$(echo "$voting_matrix" | jq '[.options[] | select(.confidence < 0.0 or .confidence > 1.0)] | length')
        if [[ $invalid_confidence -gt 0 ]]; then
            violations+=('{"requirement":"CONS-003","severity":"error","message":"Confidence scores must be 0.0-1.0","fix":"Fix confidence values in voting matrix"}')
            score=$((score - 20))
        fi
    fi

    # CONS-004: MUST meet threshold (50% by default per PROTOCOL-MISALIGNMENT-CORRECTIONS.md)
    local top_confidence
    top_confidence=$(echo "$voting_matrix" | jq '[.options[].confidence] | max // 0')
    if (( $(echo "$top_confidence < 0.5" | bc -l) )); then
        violations+=('{"requirement":"CONS-004","severity":"error","message":"Threshold not met (50% required, got '"$top_confidence"')","fix":"Increase confidence or add more supporting rationale"}')
        score=$((score - 30))
    fi

    # CONS-007: MUST set agent_type: analysis
    local agent_type
    agent_type=$(echo "$manifest_entry" | jq -r '.agent_type // empty')
    if [[ "$agent_type" != "analysis" ]]; then
        violations+=('{"requirement":"CONS-007","severity":"error","message":"agent_type must be analysis, got '"$agent_type"'","fix":"Update manifest entry agent_type field"}')
        score=$((score - 15))
    fi

    # Build result JSON
    local valid="true"
    if [[ ${#violations[@]} -gt 0 ]]; then
        valid="false"
    fi

    local violations_json
    if [[ ${#violations[@]} -gt 0 ]]; then
        violations_json=$(printf '%s\n' "${violations[@]}" | jq -s '.')
    else
        violations_json='[]'
    fi

    local result
    result=$(jq -n \
        --argjson valid "$valid" \
        --argjson violations "$violations_json" \
        --argjson score "$score" \
        '{valid: $valid, violations: $violations, score: $score}')

    echo "$result"

    # Exit code
    if [[ "$valid" == "false" && "$strict" == "true" ]]; then
        return $EXIT_PROTOCOL_CONSENSUS
    fi

    return 0
}

# ============================================================================
# SPECIFICATION PROTOCOL VALIDATION (SPEC-*)
# Per protocols/specification.md and PROTOCOL-ENFORCEMENT-SPEC.md Part 4.3
# ============================================================================

# Validate specification protocol compliance
# Args: task_id, manifest_entry (JSON), [spec_file path], [strict mode]
# Returns: JSON with {valid, violations, score}
# Exit: 0 if valid, 62 if violations and strict mode
validate_specification_protocol() {
    local task_id="$1"
    local manifest_entry="$2"
    local spec_file="${3:-}"
    local strict="${4:-false}"

    local violations=()
    local score=100

    # SPEC-001: MUST include RFC 2119 keywords
    if [[ -n "$spec_file" && -f "$spec_file" ]]; then
        if ! grep -qE '(MUST|SHOULD|MAY|MUST NOT|SHOULD NOT|MAY NOT)' "$spec_file"; then
            violations+=('{"requirement":"SPEC-001","severity":"error","message":"RFC 2119 keywords missing","fix":"Add MUST/SHOULD/MAY requirements to specification"}')
            score=$((score - 25))
        fi
    fi

    # SPEC-002: MUST have version field
    if ! has_manifest_field "$manifest_entry" "version"; then
        violations+=('{"requirement":"SPEC-002","severity":"error","message":"Version field missing","fix":"Add version field to manifest entry"}')
        score=$((score - 20))
    fi

    # SPEC-003: SHOULD include authority section (downgraded from MUST per PROTOCOL-MISALIGNMENT-CORRECTIONS.md)
    if [[ "$strict" == "true" && -n "$spec_file" && -f "$spec_file" ]]; then
        if ! grep -qiE '(authority|scope)' "$spec_file"; then
            violations+=('{"requirement":"SPEC-003","severity":"warning","message":"Authority/scope section missing","fix":"Add authority section defining specification scope"}')
            score=$((score - 10))
        fi
    fi

    # SPEC-007: MUST set agent_type: specification
    local agent_type
    agent_type=$(echo "$manifest_entry" | jq -r '.agent_type // empty')
    if [[ "$agent_type" != "specification" ]]; then
        violations+=('{"requirement":"SPEC-007","severity":"error","message":"agent_type must be specification, got '"$agent_type"'","fix":"Update manifest entry agent_type field"}')
        score=$((score - 15))
    fi

    # Build result JSON
    local valid="true"
    # Only error severity violations count as invalid
    local error_count
    error_count=$(printf '%s\n' "${violations[@]}" | jq -r 'select(.severity == "error")' | wc -l)
    if [[ $error_count -gt 0 ]]; then
        valid="false"
    fi

    local violations_json
    if [[ ${#violations[@]} -gt 0 ]]; then
        violations_json=$(printf '%s\n' "${violations[@]}" | jq -s '.')
    else
        violations_json='[]'
    fi

    local result
    result=$(jq -n \
        --argjson valid "$valid" \
        --argjson violations "$violations_json" \
        --argjson score "$score" \
        '{valid: $valid, violations: $violations, score: $score}')

    echo "$result"

    # Exit code
    if [[ "$valid" == "false" && "$strict" == "true" ]]; then
        return $EXIT_PROTOCOL_SPECIFICATION
    fi

    return 0
}

# ============================================================================
# DECOMPOSITION PROTOCOL VALIDATION (DCMP-*)
# Per protocols/decomposition.md and PROTOCOL-ENFORCEMENT-SPEC.md Part 4.4
# ============================================================================

# Validate decomposition protocol compliance
# Args: task_id, epic_id, [child_tasks JSON array], [strict mode]
# Returns: JSON with {valid, violations, score}
# Exit: 0 if valid, 63 if violations and strict mode
validate_decomposition_protocol() {
    local task_id="$1"
    local epic_id="$2"
    local child_tasks="${3:-[]}"
    local strict="${4:-false}"

    local violations=()
    local score=100

    # DCMP-002: MUST have valid dependency graph (no cycles)
    # This is checked by hierarchy validation, assume passed if we got here

    # DCMP-003: MUST enforce max depth 3 (epic→task→subtask)
    # This is enforced by lib/hierarchy.sh, assume passed

    # DCMP-006: MUST enforce max 7 siblings per parent
    local sibling_count
    sibling_count=$(echo "$child_tasks" | jq 'length // 0')
    if [[ $sibling_count -gt 7 ]]; then
        violations+=('{"requirement":"DCMP-006","severity":"error","message":"Max 7 siblings exceeded, got '"$sibling_count"'","fix":"Break epic into smaller sub-epics or reduce task count"}')
        score=$((score - 25))
    fi

    # DCMP-007: MUST set agent_type: specification
    # (Decomposition uses specification agent type)
    # Validated separately via manifest_entry in other contexts

    # DCMP-004: Atomicity test (6 criteria) - advisory only
    if [[ "$strict" == "true" ]]; then
        # Basic atomicity heuristic: check if tasks have clear descriptions
        local unclear_tasks
        unclear_tasks=$(echo "$child_tasks" | jq '[.[] | select(.description == null or .description == "")] | length')
        if [[ $unclear_tasks -gt 0 ]]; then
            violations+=('{"requirement":"DCMP-004","severity":"warning","message":"'"$unclear_tasks"' tasks lack clear descriptions (atomicity check)","fix":"Add clear acceptance criteria to task descriptions"}')
            score=$((score - 10))
        fi
    fi

    # Build result JSON
    local valid="true"
    local error_count
    error_count=$(printf '%s\n' "${violations[@]}" | jq -r 'select(.severity == "error")' | wc -l 2>/dev/null || echo "0")
    if [[ $error_count -gt 0 ]]; then
        valid="false"
    fi

    local violations_json
    if [[ ${#violations[@]} -gt 0 ]]; then
        violations_json=$(printf '%s\n' "${violations[@]}" | jq -s '.')
    else
        violations_json='[]'
    fi

    local result
    result=$(jq -n \
        --argjson valid "$valid" \
        --argjson violations "$violations_json" \
        --argjson score "$score" \
        '{valid: $valid, violations: $violations, score: $score}')

    echo "$result"

    # Exit code
    if [[ "$valid" == "false" && "$strict" == "true" ]]; then
        return $EXIT_PROTOCOL_DECOMPOSITION
    fi

    return 0
}

# ============================================================================
# IMPLEMENTATION PROTOCOL VALIDATION (IMPL-*)
# Per protocols/implementation.md and PROTOCOL-ENFORCEMENT-SPEC.md Part 4.5
# ============================================================================

# Validate implementation protocol compliance
# Args: task_id, manifest_entry (JSON), [strict mode]
# Returns: JSON with {valid, violations, score}
# Exit: 0 if valid, 64 if violations and strict mode
validate_implementation_protocol() {
    local task_id="$1"
    local manifest_entry="$2"
    local strict="${3:-false}"

    local violations=()
    local score=100

    # IMPL-003: MUST have provenance tags @task T#### in new code
    # Check git diff for @task tags in added lines
    local added_functions
    added_functions=$(git diff --cached --unified=0 | grep '^+' | grep -E '(function |def |class )' | wc -l || echo "0")
    added_functions=$(echo "$added_functions" | tr -d ' \n')

    if [[ $added_functions -gt 0 ]]; then
        local tagged_functions
        tagged_functions=$(git diff --cached | grep '@task T[0-9]' | wc -l || echo "0")
        tagged_functions=$(echo "$tagged_functions" | tr -d ' \n')

        if [[ $tagged_functions -eq 0 ]]; then
            violations+=('{"requirement":"IMPL-003","severity":"error","message":"New functions missing @task provenance tags","fix":"Add @task '"$task_id"' comment above new functions"}')
            score=$((score - 30))
        fi
    fi

    # IMPL-007: MUST set agent_type: implementation
    local agent_type
    agent_type=$(echo "$manifest_entry" | jq -r '.agent_type // empty')
    if [[ "$agent_type" != "implementation" ]]; then
        violations+=('{"requirement":"IMPL-007","severity":"error","message":"agent_type must be implementation, got '"$agent_type"'","fix":"Update manifest entry agent_type field"}')
        score=$((score - 15))
    fi

    # IMPL-004: Tests must pass (delegated to CI/pre-commit)
    # IMPL-006: Style validation (delegated to shellcheck/linters)

    # Build result JSON
    local valid="true"
    if [[ ${#violations[@]} -gt 0 ]]; then
        valid="false"
    fi

    local violations_json
    if [[ ${#violations[@]} -gt 0 ]]; then
        violations_json=$(printf '%s\n' "${violations[@]}" | jq -s '.')
    else
        violations_json='[]'
    fi

    local result
    result=$(jq -n \
        --argjson valid "$valid" \
        --argjson violations "$violations_json" \
        --argjson score "$score" \
        '{valid: $valid, violations: $violations, score: $score}')

    echo "$result"

    # Exit code
    if [[ "$valid" == "false" && "$strict" == "true" ]]; then
        return $EXIT_PROTOCOL_IMPLEMENTATION
    fi

    return 0
}

# ============================================================================
# CONTRIBUTION PROTOCOL VALIDATION (CONT-*)
# Per protocols/contribution.md and PROTOCOL-ENFORCEMENT-SPEC.md Part 4.6
# ============================================================================

# Validate contribution protocol compliance
# Args: task_id, manifest_entry (JSON), [strict mode]
# Returns: JSON with {valid, violations, score}
# Exit: 0 if valid, 65 if violations and strict mode
validate_contribution_protocol() {
    local task_id="$1"
    local manifest_entry="$2"
    local strict="${3:-false}"

    local violations=()
    local score=100

    # CONT-002: MUST have provenance tags (same as IMPL-003)
    local added_functions
    added_functions=$(git diff --cached --unified=0 | grep '^+' | grep -E '(function |def |class )' | wc -l || echo "0")
    added_functions=$(echo "$added_functions" | tr -d ' \n')

    if [[ $added_functions -gt 0 ]]; then
        local tagged_functions
        tagged_functions=$(git diff --cached | grep '@task T[0-9]' | wc -l || echo "0")
        tagged_functions=$(echo "$tagged_functions" | tr -d ' \n')

        if [[ $tagged_functions -eq 0 ]]; then
            violations+=('{"requirement":"CONT-002","severity":"error","message":"New functions missing @task provenance tags","fix":"Add @task '"$task_id"' comment above new functions"}')
            score=$((score - 30))
        fi
    fi

    # CONT-007: MUST set agent_type: implementation
    local agent_type
    agent_type=$(echo "$manifest_entry" | jq -r '.agent_type // empty')
    if [[ "$agent_type" != "implementation" ]]; then
        violations+=('{"requirement":"CONT-007","severity":"error","message":"agent_type must be implementation, got '"$agent_type"'","fix":"Update manifest entry agent_type field"}')
        score=$((score - 15))
    fi

    # CONT-003: Tests must pass (delegated to CI)

    # Build result JSON
    local valid="true"
    if [[ ${#violations[@]} -gt 0 ]]; then
        valid="false"
    fi

    local violations_json
    if [[ ${#violations[@]} -gt 0 ]]; then
        violations_json=$(printf '%s\n' "${violations[@]}" | jq -s '.')
    else
        violations_json='[]'
    fi

    local result
    result=$(jq -n \
        --argjson valid "$valid" \
        --argjson violations "$violations_json" \
        --argjson score "$score" \
        '{valid: $valid, violations: $violations, score: $score}')

    echo "$result"

    # Exit code
    if [[ "$valid" == "false" && "$strict" == "true" ]]; then
        return $EXIT_PROTOCOL_CONTRIBUTION
    fi

    return 0
}

# ============================================================================
# RELEASE PROTOCOL VALIDATION (RLSE-*)
# Per protocols/release.md and PROTOCOL-ENFORCEMENT-SPEC.md Part 4.7
# ============================================================================

# Validate release protocol compliance
# Args: version, [changelog_entry], [strict mode]
# Returns: JSON with {valid, violations, score}
# Exit: 0 if valid, 66 if violations and strict mode
validate_release_protocol() {
    local version="$1"
    local changelog_entry="${2:-}"
    local strict="${3:-false}"

    local violations=()
    local score=100

    # RLSE-001: MUST follow semver (major.minor.patch)
    if ! echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        violations+=('{"requirement":"RLSE-001","severity":"error","message":"Version must follow semver (major.minor.patch), got '"$version"'","fix":"Use format X.Y.Z (e.g., 0.74.5)"}')
        score=$((score - 30))
    fi

    # RLSE-002: MUST have changelog entry
    if [[ -z "$changelog_entry" ]]; then
        violations+=('{"requirement":"RLSE-002","severity":"error","message":"Changelog entry required for version '"$version"'","fix":"Add entry to CHANGELOG.md"}')
        score=$((score - 25))
    fi

    # RLSE-004: Git tag must match version (checked by release script)
    # RLSE-003: Tests must pass (delegated to CI)

    # Build result JSON
    local valid="true"
    if [[ ${#violations[@]} -gt 0 ]]; then
        valid="false"
    fi

    local violations_json
    if [[ ${#violations[@]} -gt 0 ]]; then
        violations_json=$(printf '%s\n' "${violations[@]}" | jq -s '.')
    else
        violations_json='[]'
    fi

    local result
    result=$(jq -n \
        --argjson valid "$valid" \
        --argjson violations "$violations_json" \
        --argjson score "$score" \
        '{valid: $valid, violations: $violations, score: $score}')

    echo "$result"

    # Exit code
    if [[ "$valid" == "false" && "$strict" == "true" ]]; then
        return $EXIT_PROTOCOL_RELEASE
    fi

    return 0
}

# ============================================================================
# GENERIC PROTOCOL VALIDATOR
# Routes to appropriate protocol validator based on task labels/type
# ============================================================================

# Validate protocol compliance (auto-detect protocol type)
# Args: task_id, protocol_type, manifest_entry (JSON), [additional_data], [strict mode]
# Returns: JSON with {valid, violations, score, protocol}
# Exit: 0 if valid, 60-67 if violations and strict mode
validate_protocol() {
    local task_id="$1"
    local protocol_type="$2"
    local manifest_entry="$3"
    local additional_data="${4:-{}}"
    local strict="${5:-false}"

    case "$protocol_type" in
        research)
            validate_research_protocol "$task_id" "$manifest_entry" "$strict"
            ;;
        consensus)
            validate_consensus_protocol "$task_id" "$manifest_entry" "$additional_data" "$strict"
            ;;
        specification)
            local spec_file
            spec_file=$(echo "$additional_data" | jq -r '.spec_file // empty')
            validate_specification_protocol "$task_id" "$manifest_entry" "$spec_file" "$strict"
            ;;
        decomposition)
            local epic_id
            local child_tasks
            epic_id=$(echo "$additional_data" | jq -r '.epic_id // empty')
            child_tasks=$(echo "$additional_data" | jq -r '.child_tasks // []')
            validate_decomposition_protocol "$task_id" "$epic_id" "$child_tasks" "$strict"
            ;;
        implementation)
            validate_implementation_protocol "$task_id" "$manifest_entry" "$strict"
            ;;
        contribution)
            validate_contribution_protocol "$task_id" "$manifest_entry" "$strict"
            ;;
        release)
            local version
            local changelog_entry
            version=$(echo "$additional_data" | jq -r '.version // empty')
            changelog_entry=$(echo "$additional_data" | jq -r '.changelog_entry // empty')
            validate_release_protocol "$version" "$changelog_entry" "$strict"
            ;;
        *)
            # Unknown protocol type
            local result
            result=$(jq -n \
                --arg protocol "$protocol_type" \
                '{valid: false, violations: [{"requirement": "UNKNOWN", "severity": "error", "message": "Unknown protocol type: " + $protocol}], score: 0}')
            echo "$result"
            return $EXIT_PROTOCOL_GENERIC
            ;;
    esac
}

# ============================================================================
# EXPORTS
# ============================================================================

export EXIT_PROTOCOL_RESEARCH
export EXIT_PROTOCOL_CONSENSUS
export EXIT_PROTOCOL_SPECIFICATION
export EXIT_PROTOCOL_DECOMPOSITION
export EXIT_PROTOCOL_IMPLEMENTATION
export EXIT_PROTOCOL_CONTRIBUTION
export EXIT_PROTOCOL_RELEASE
export EXIT_PROTOCOL_GENERIC

export -f has_code_changes
export -f has_manifest_field
export -f validate_research_protocol
export -f validate_consensus_protocol
export -f validate_specification_protocol
export -f validate_decomposition_protocol
export -f validate_implementation_protocol
export -f validate_contribution_protocol
export -f validate_release_protocol
export -f validate_protocol
