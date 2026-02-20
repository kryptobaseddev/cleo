#!/usr/bin/env bash
# protocol-validation.sh - Protocol enforcement validation functions
#
# @task T2692
# LAYER: 2 (Protocol Enforcement)
# DEPENDENCIES: exit-codes.sh, file-ops.sh
# PROVIDES: validate_research_protocol, validate_consensus_protocol,
#           validate_specification_protocol, validate_decomposition_protocol,
#           validate_implementation_protocol, validate_contribution_protocol,
#           validate_release_protocol, validate_validation_protocol,
#           validate_testing_protocol
#
# Part of Epic T2679: Protocol Enforcement and RCSD-IVTR Alignment
# Implements PROTOCOL-ENFORCEMENT-SPEC.md validation functions (Part 3)

#=== SOURCE GUARD ================================================
[[ -n "${_PROTOCOL_VALIDATION_SH_LOADED:-}" ]] && return 0
declare -r _PROTOCOL_VALIDATION_SH_LOADED=1

set -euo pipefail

# Source dependencies
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${SCRIPT_DIR}/core/exit-codes.sh"
source "${SCRIPT_DIR}/validation/protocol-validation-common.sh"
source "${SCRIPT_DIR}/core/config.sh"

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
readonly EXIT_PROTOCOL_VALIDATION=68
readonly EXIT_TESTS_SKIPPED=69
readonly EXIT_COVERAGE_INSUFFICIENT=70

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
    # @task T2749 - Use common library
    if ! check_key_findings_count "$manifest_entry"; then
        local findings_count
        findings_count=$(echo "$manifest_entry" | jq '.key_findings | length // 0')
        violations+=('{"requirement":"RSCH-006","severity":"error","message":"Key findings must be 3-7, got '"$findings_count"'","fix":"Add/remove findings in manifest entry"}')
        score=$((score - 20))
    fi

    # RSCH-007: MUST set agent_type: research
    # @task T2749 - Use common library
    if ! check_agent_type "$manifest_entry" "research"; then
        local agent_type
        agent_type=$(echo "$manifest_entry" | jq -r '.agent_type // empty')
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
    # @task T2749 - Use common library
    if ! check_agent_type "$manifest_entry" "analysis"; then
        local agent_type
        agent_type=$(echo "$manifest_entry" | jq -r '.agent_type // empty')
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
    # @task T2749 - Use common library
    if ! check_manifest_field_present "$manifest_entry" "version"; then
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
    # @task T2749 - Use common library
    if ! check_agent_type "$manifest_entry" "specification"; then
        local agent_type
        agent_type=$(echo "$manifest_entry" | jq -r '.agent_type // empty')
        violations+=('{"requirement":"SPEC-007","severity":"error","message":"agent_type must be specification, got '"$agent_type"'","fix":"Update manifest entry agent_type field"}')
        score=$((score - 15))
    fi

    # @task T2750 - Add missing SPEC checks

    # SPEC-004: Conformance criteria section
    local file_path
    file_path=$(echo "$manifest_entry" | jq -r '.file // ""')
    if [[ -n "$file_path" && -f "$file_path" ]]; then
        if ! grep -qiE "conformance|compliance|requirements" "$file_path" 2>/dev/null; then
            violations+=('{"requirement":"SPEC-004","severity":"warning","message":"Spec should include conformance criteria section","fix":"Add Conformance or Requirements section"}')
            score=$((score - 10))
        fi
    fi

    # SPEC-005: Related specs documented
    if ! check_manifest_field_present "$manifest_entry" "related_specs" && \
       ! check_manifest_field_present "$manifest_entry" "references"; then
        # Check in file for References section
        if [[ -n "$file_path" && -f "$file_path" ]]; then
            if ! grep -qE "^#+ .*References|^#+ .*Related" "$file_path" 2>/dev/null; then
                violations+=('{"requirement":"SPEC-005","severity":"warning","message":"Spec should document related specifications","fix":"Add References or Related Specs section"}')
                score=$((score - 5))
            fi
        fi
    fi

    # SPEC-006: Structured format (tables or code blocks)
    if [[ -n "$file_path" && -f "$file_path" ]]; then
        if ! grep -qE '^\|.*\|$|^```' "$file_path" 2>/dev/null; then
            violations+=('{"requirement":"SPEC-006","severity":"warning","message":"Spec should use structured format (tables/code blocks)","fix":"Add tables or code examples"}')
            score=$((score - 5))
        fi
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
    # This is enforced by lib/tasks/hierarchy.sh, assume passed

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

    # @task T2750 - Add missing DCMP checks

    # DCMP-001: MECE validation (basic heuristic)
    # Check that tasks don't have overlapping descriptions
    local tasks_json
    tasks_json=$(echo "$child_tasks" | jq -c '.')
    if [[ "$tasks_json" != "[]" && -n "$tasks_json" ]]; then
        local task_count
        task_count=$(echo "$child_tasks" | jq 'length')
        local unique_count
        unique_count=$(echo "$child_tasks" | jq '[.[].title] | unique | length')
        if [[ $task_count -ne $unique_count ]]; then
            violations+=('{"requirement":"DCMP-001","severity":"warning","message":"Decomposition may have overlapping tasks (MECE violation)","fix":"Ensure tasks are mutually exclusive"}')
            score=$((score - 10))
        fi
    fi

    # DCMP-005: No time estimates
    # Check manifest entry for time estimates (requires manifest_entry parameter, but this function doesn't receive it)
    # We can check child_tasks for time estimates in their descriptions
    if [[ "$tasks_json" != "[]" && -n "$tasks_json" ]]; then
        local tasks_with_estimates
        tasks_with_estimates=$(echo "$child_tasks" | jq '[.[] | select(.description // "" | test("[0-9]+ ?(hour|day|week|minute|hr|min)s?|takes? (about|around|roughly)"; "i")) | select(.title // "" | test("[0-9]+ ?(hour|day|week|minute|hr|min)s?|takes? (about|around|roughly)"; "i"))] | length')
        if [[ $tasks_with_estimates -gt 0 ]]; then
            violations+=('{"requirement":"DCMP-005","severity":"error","message":"Time estimates prohibited in decomposition","fix":"Remove time estimates, use relative sizing"}')
            score=$((score - 20))
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
    # @task T2749 - Use common library
    if ! check_agent_type "$manifest_entry" "implementation"; then
        local agent_type
        agent_type=$(echo "$manifest_entry" | jq -r '.agent_type // empty')
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
    # @task T2749 - Use common library
    if ! check_agent_type "$manifest_entry" "implementation"; then
        local agent_type
        agent_type=$(echo "$manifest_entry" | jq -r '.agent_type // empty')
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
# Args: version, [changelog_entry], [manifest_entry], [strict mode]
# Returns: JSON with {valid, violations, score}
# Exit: 0 if valid, 66 if violations and strict mode
validate_release_protocol() {
    local version="$1"
    local changelog_entry="${2:-}"
    local manifest_entry="${3:-{}}"
    local strict="${4:-false}"

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

    # @task T2750 - Add missing RLSE checks
    # Note: This function signature doesn't include manifest_entry, so we need to be careful
    # Some checks are difficult without manifest_entry, but we can add what we can

    # RLSE-005: Breaking changes documented (if major version bump)
    # We can check this if we have access to the changelog or manifest
    if [[ "$version" =~ ^[0-9]+\.0\.0$ ]] && [[ -n "$changelog_entry" ]]; then
        # Major version - check for breaking changes keywords
        if ! echo "$changelog_entry" | grep -qiE "breaking|break|incompatible|migration"; then
            violations+=('{"requirement":"RLSE-005","severity":"warning","message":"Major release should document breaking changes","fix":"Add breaking changes section to changelog"}')
            score=$((score - 10))
        fi
    fi

    # RLSE-006: Version consistency (check VERSION file matches)
    local version_file=""
    # Try common VERSION file locations
    for vfile in "VERSION" "../VERSION" "../../VERSION"; do
        if [[ -f "$vfile" ]]; then
            version_file="$vfile"
            break
        fi
    done

    if [[ -n "$version_file" && -f "$version_file" ]]; then
        local file_version
        file_version=$(cat "$version_file" 2>/dev/null | tr -d '[:space:]')
        if [[ -n "$file_version" && "$version" != "$file_version" ]]; then
            violations+=('{"requirement":"RLSE-006","severity":"error","message":"Version mismatch: release '"$version"' vs VERSION file '"$file_version"'","fix":"Sync versions before release"}')
            score=$((score - 15))
        fi
    fi

    # RLSE-007: agent_type = "documentation" or "release"
    if [[ "$manifest_entry" != "{}" ]]; then
        if ! check_agent_type "$manifest_entry" "documentation" && ! check_agent_type "$manifest_entry" "release"; then
            violations+=('{"requirement":"RLSE-007","severity":"warning","message":"agent_type should be documentation or release","fix":"Set agent_type appropriately"}')  
            score=$((score - 5))
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
        return $EXIT_PROTOCOL_RELEASE
    fi

    return 0
}

# ============================================================================
# VALIDATION PROTOCOL VALIDATION (VALID-*)
# Per protocols/validation.md and PROTOCOL-ENFORCEMENT-SPEC.md Part 4.8
# ============================================================================

# @task T2727
# @epic T2724
# Validate validation protocol compliance
# Args: task_id, manifest_entry (JSON), [strict mode]
# Returns: JSON with {valid, violations, score}
# Exit: 0 if valid, 68 if violations and strict mode
validate_validation_protocol() {
    local task_id="$1"
    local manifest_entry="$2"
    local strict="${3:-false}"

    local violations=()
    local score=100

    # VALID-001: MUST verify output matches spec requirements
    # Check manifest has validation_result field
    # @task T2749 - Use common library
    if ! check_manifest_field_present "$manifest_entry" "validation_result"; then
        violations+=('{"requirement":"VALID-001","severity":"error","message":"Missing validation_result in manifest","fix":"Add validation_result field with pass/fail"}')
        score=$((score - 20))
    fi

    # VALID-002: MUST execute test suite
    # Check for test_execution field
    # @task T2749 - Use common library
    if ! check_manifest_field_present "$manifest_entry" "test_execution"; then
        violations+=('{"requirement":"VALID-002","severity":"warning","message":"No test execution documented","fix":"Add test_execution field"}')
        score=$((score - 10))
    fi

    # VALID-003: MUST check protocol compliance
    # Verify status field
    # @task T2749 - Use common library
    if ! check_status_valid "$manifest_entry"; then
        local status
        status=$(echo "$manifest_entry" | jq -r '.status // "unknown"')
        violations+=('{"requirement":"VALID-003","severity":"error","message":"Invalid status: '"$status"'","fix":"Set status to complete/partial/blocked"}')
        score=$((score - 15))
    fi

    # VALID-004: MUST document pass/fail with evidence
    # @task T2749 - Use common library
    if ! check_manifest_field_present "$manifest_entry" "key_findings"; then
        violations+=('{"requirement":"VALID-004","severity":"error","message":"Missing key_findings","fix":"Add key_findings array"}')
        score=$((score - 20))
    fi

    # VALID-005: MUST include validation summary
    # Check title contains validation-related keywords
    local title
    title=$(echo "$manifest_entry" | jq -r '.title // ""')
    if ! echo "$title" | grep -qiE 'valid|verify|check|compliance'; then
        violations+=('{"requirement":"VALID-005","severity":"warning","message":"Title should indicate validation task","fix":"Include validation/verify in title"}')
        score=$((score - 5))
    fi

    # VALID-006: MUST set agent_type = "validation"
    # @task T2749 - Use common library
    if ! check_agent_type "$manifest_entry" "validation"; then
        local agent_type
        agent_type=$(echo "$manifest_entry" | jq -r '.agent_type // ""')
        violations+=('{"requirement":"VALID-006","severity":"error","message":"agent_type must be validation, got '"$agent_type"'","fix":"Set agent_type to validation"}')
        score=$((score - 15))
    fi

    # VALID-007: Critical validations MUST block progression
    # This is enforced by lifecycle gates, just verify manifest has blocking_issues if partial
    local status
    status=$(echo "$manifest_entry" | jq -r '.status // ""')
    if [[ "$status" == "partial" ]]; then
        # @task T2749 - Use common library
        if ! check_manifest_field_present "$manifest_entry" "needs_followup"; then
            violations+=('{"requirement":"VALID-007","severity":"warning","message":"Partial status requires needs_followup","fix":"Add needs_followup array with blocking items"}')
            score=$((score - 5))
        fi
    fi

    # Build result JSON
    local violations_json="[]"
    if [[ ${#violations[@]} -gt 0 ]]; then
        violations_json=$(printf '%s\n' "${violations[@]}" | jq -s '.')
    fi

    local valid="true"
    [[ $score -lt 70 ]] && valid="false"

    local result
    result=$(jq -n \
        --argjson valid "$valid" \
        --argjson violations "$violations_json" \
        --argjson score "$score" \
        '{valid: $valid, violations: $violations, score: $score}')

    echo "$result"

    # Exit with protocol error if strict and invalid
    if [[ "$strict" == "true" && "$valid" == "false" ]]; then
        return $EXIT_PROTOCOL_VALIDATION
    fi

    return 0
}

# ============================================================================
# TESTING PROTOCOL VALIDATION (TEST-*)
# Per protocols/testing.md and PROTOCOL-ENFORCEMENT-SPEC.md Part 4.9
# ============================================================================

# @task T2727
# @epic T2724
# Validate testing protocol compliance
# Args: task_id, manifest_entry (JSON), [strict mode]
# Returns: JSON with {valid, violations, score}
# Exit: 0 if valid, 69/70 if violations and strict mode
validate_testing_protocol() {
    local task_id="$1"
    local manifest_entry="$2"
    local strict="${3:-false}"

    local violations=()
    local score=100

    # TEST-001: MUST use configured test framework
    # Now framework-agnostic - reads from config instead of hardcoding BATS
    local file
    file=$(echo "$manifest_entry" | jq -r '.file // ""')

    # Get configured framework and file extension
    local configured_framework configured_extension test_dir
    configured_framework=$(get_test_framework)
    configured_extension=$(get_test_file_extension)
    test_dir=$(get_test_directory)

    # Build regex pattern for configured framework
    # Remove leading dot from extension for regex
    local ext_pattern="${configured_extension#.}"
    local test_pattern="\\.${ext_pattern}\$|${test_dir}/"

    if [[ -n "$file" ]] && ! echo "$file" | grep -qE "$test_pattern"; then
        violations+=("{\"requirement\":\"TEST-001\",\"severity\":\"warning\",\"message\":\"Test output not in ${test_dir}/ or ${configured_extension} file (framework: ${configured_framework})\",\"fix\":\"Place tests in ${test_dir}/ directory with ${configured_extension} extension\"}")
        score=$((score - 10))
    fi

    # TEST-002: MUST place unit tests in tests/unit/
    # Advisory - just check if mentioned

    # TEST-003: MUST place integration tests in tests/integration/
    # Advisory - just check if mentioned

    # TEST-004: MUST achieve 100% pass rate before release
    local test_results
    test_results=$(echo "$manifest_entry" | jq -r '.test_results // empty')
    if [[ -n "$test_results" ]]; then
        local pass_rate
        pass_rate=$(echo "$test_results" | jq -r '.pass_rate // 0')
        if [[ $(echo "$pass_rate < 1.0" | bc -l 2>/dev/null || echo 1) -eq 1 ]] && [[ "$pass_rate" != "1.0" && "$pass_rate" != "1" ]]; then
            violations+=('{"requirement":"TEST-004","severity":"error","message":"Pass rate '"$pass_rate"' below 100%","fix":"Fix failing tests before completion"}')
            score=$((score - 30))
        fi
    fi

    # TEST-005: MUST cover all MUST requirements
    # Check for coverage field
    # @task T2749 - Use common library
    if ! check_manifest_field_present "$manifest_entry" "coverage_summary"; then
        violations+=('{"requirement":"TEST-005","severity":"warning","message":"No coverage summary provided","fix":"Add coverage_summary field"}')
        score=$((score - 10))
    fi

    # TEST-006: MUST include test summary in manifest
    # @task T2749 - Use common library
    if ! check_manifest_field_present "$manifest_entry" "key_findings"; then
        violations+=('{"requirement":"TEST-006","severity":"error","message":"Missing key_findings for test summary","fix":"Add key_findings array with test results"}')
        score=$((score - 20))
    fi

    # TEST-007: MUST set agent_type = "testing"
    # @task T2749 - Use common library
    if ! check_agent_type "$manifest_entry" "testing"; then
        local agent_type
        agent_type=$(echo "$manifest_entry" | jq -r '.agent_type // ""')
        violations+=('{"requirement":"TEST-007","severity":"error","message":"agent_type must be testing, got '"$agent_type"'","fix":"Set agent_type to testing"}')
        score=$((score - 15))
    fi

    # Build result JSON
    local violations_json="[]"
    if [[ ${#violations[@]} -gt 0 ]]; then
        violations_json=$(printf '%s\n' "${violations[@]}" | jq -s '.')
    fi

    local valid="true"
    [[ $score -lt 70 ]] && valid="false"

    local result
    result=$(jq -n \
        --argjson valid "$valid" \
        --argjson violations "$violations_json" \
        --argjson score "$score" \
        '{valid: $valid, violations: $violations, score: $score}')

    echo "$result"

    # Exit with test-specific error codes if strict and invalid
    if [[ "$strict" == "true" && "$valid" == "false" ]]; then
        if [[ $score -lt 50 ]]; then
            return $EXIT_COVERAGE_INSUFFICIENT
        else
            return $EXIT_TESTS_SKIPPED
        fi
    fi

    return 0
}

# ============================================================================
# ARTIFACT PUBLISH PROTOCOL VALIDATOR
# Per protocols/artifact-publish.md
# ============================================================================

validate_artifact_publish_protocol() {
    local task_id="$1"
    local manifest_entry="$2"
    local strict="${3:-false}"

    local violations=()
    local score=100

    # ARTP-001: MUST validate artifact configuration before build
    # Check that key_findings mention validation
    if ! check_manifest_field_present "$manifest_entry" "key_findings"; then
        violations+=('{"requirement":"ARTP-001","severity":"error","message":"Missing key_findings (must document validation results)","fix":"Add key_findings array with validation and publish results"}')
        score=$((score - 20))
    fi

    # ARTP-003: MUST follow handler interface contract
    # Check that topics include artifact-related keywords
    local topics
    topics=$(echo "$manifest_entry" | jq -r '.topics // [] | join(",")' 2>/dev/null)
    if [[ -z "$topics" ]] || ! echo "$topics" | grep -qiE "artifact|publish|package|registry|docker|npm|pypi|cargo|gem"; then
        violations+=('{"requirement":"ARTP-003","severity":"warning","message":"Topics should include artifact-related keywords","fix":"Add artifact type to topics array (e.g., npm-package, docker-image)"}')
        score=$((score - 10))
    fi

    # ARTP-004: MUST generate SHA-256 checksums
    local findings
    findings=$(echo "$manifest_entry" | jq -r '.key_findings // [] | join(",")' 2>/dev/null)
    if [[ -n "$findings" ]] && ! echo "$findings" | grep -qiE "checksum|sha.?256|digest|verified"; then
        violations+=('{"requirement":"ARTP-004","severity":"warning","message":"key_findings should mention checksum verification","fix":"Include checksum verification status in key_findings"}')
        score=$((score - 10))
    fi

    # ARTP-005: MUST record provenance metadata
    if [[ -n "$findings" ]] && ! echo "$findings" | grep -qiE "provenance|recorded"; then
        violations+=('{"requirement":"ARTP-005","severity":"warning","message":"key_findings should mention provenance recording","fix":"Include provenance recording status in key_findings"}')
        score=$((score - 10))
    fi

    # ARTP-007: MUST set agent_type = "artifact-publish"
    if ! check_agent_type "$manifest_entry" "artifact-publish"; then
        local agent_type
        agent_type=$(echo "$manifest_entry" | jq -r '.agent_type // ""')
        violations+=('{"requirement":"ARTP-007","severity":"error","message":"agent_type must be artifact-publish, got '"$agent_type"'","fix":"Set agent_type to artifact-publish"}')
        score=$((score - 15))
    fi

    # ARTP-008: MUST NOT store credentials in output
    local file_path
    file_path=$(echo "$manifest_entry" | jq -r '.file // ""')
    if [[ -n "$file_path" && -f "$file_path" ]]; then
        if grep -qiE "token|password|secret|api.?key|credential" "$file_path" 2>/dev/null; then
            violations+=('{"requirement":"ARTP-008","severity":"error","message":"Output file may contain credential references","fix":"Remove all credential values from output file"}')
            score=$((score - 30))
        fi
    fi

    # Build result JSON
    local violations_json="[]"
    if [[ ${#violations[@]} -gt 0 ]]; then
        violations_json=$(printf '%s\n' "${violations[@]}" | jq -s '.')
    fi

    local valid="true"
    [[ $score -lt 70 ]] && valid="false"

    local result
    result=$(jq -n \
        --argjson valid "$valid" \
        --argjson violations "$violations_json" \
        --argjson score "$score" \
        '{valid: $valid, violations: $violations, score: $score}')

    echo "$result"

    if [[ "$strict" == "true" && "$valid" == "false" ]]; then
        return ${EXIT_ARTIFACT_PUBLISH_FAILED:-88}
    fi

    return 0
}

# ============================================================================
# PROVENANCE PROTOCOL VALIDATOR
# Per protocols/provenance.md
# ============================================================================

validate_provenance_protocol() {
    local task_id="$1"
    local manifest_entry="$2"
    local strict="${3:-false}"

    local violations=()
    local score=100

    # PROV-001: MUST record provenance chain
    if ! check_manifest_field_present "$manifest_entry" "key_findings"; then
        violations+=('{"requirement":"PROV-001","severity":"error","message":"Missing key_findings (must document provenance chain)","fix":"Add key_findings array with provenance chain status"}')
        score=$((score - 20))
    fi

    # PROV-002: MUST compute SHA-256 digest
    local findings
    findings=$(echo "$manifest_entry" | jq -r '.key_findings // [] | join(",")' 2>/dev/null)
    if [[ -n "$findings" ]] && ! echo "$findings" | grep -qiE "sha.?256|digest|checksum|hash"; then
        violations+=('{"requirement":"PROV-002","severity":"warning","message":"key_findings should mention SHA-256 digest computation","fix":"Include digest verification status in key_findings"}')
        score=$((score - 10))
    fi

    # PROV-003: MUST generate attestation in in-toto format
    local topics
    topics=$(echo "$manifest_entry" | jq -r '.topics // [] | join(",")' 2>/dev/null)
    if [[ -z "$topics" ]] || ! echo "$topics" | grep -qiE "provenance|attestation|slsa|supply.?chain"; then
        violations+=('{"requirement":"PROV-003","severity":"warning","message":"Topics should include provenance-related keywords","fix":"Add provenance, attestation, or slsa to topics array"}')
        score=$((score - 10))
    fi

    # PROV-004: MUST record SLSA Build Level
    if [[ -n "$findings" ]] && ! echo "$findings" | grep -qiE "slsa|level|L[1-4]"; then
        violations+=('{"requirement":"PROV-004","severity":"warning","message":"key_findings should mention SLSA compliance level","fix":"Include SLSA level achieved in key_findings"}')
        score=$((score - 10))
    fi

    # PROV-005: MUST store in releases.json
    if [[ -n "$findings" ]] && ! echo "$findings" | grep -qiE "recorded|stored|releases"; then
        violations+=('{"requirement":"PROV-005","severity":"warning","message":"key_findings should mention provenance recording","fix":"Include recording status in key_findings"}')
        score=$((score - 5))
    fi

    # PROV-006: MUST verify chain integrity
    if [[ -n "$findings" ]] && ! echo "$findings" | grep -qiE "verified|chain|integrity"; then
        violations+=('{"requirement":"PROV-006","severity":"warning","message":"key_findings should mention chain verification","fix":"Include chain verification status in key_findings"}')
        score=$((score - 10))
    fi

    # PROV-007: MUST set agent_type = "provenance"
    if ! check_agent_type "$manifest_entry" "provenance"; then
        local agent_type
        agent_type=$(echo "$manifest_entry" | jq -r '.agent_type // ""')
        violations+=('{"requirement":"PROV-007","severity":"error","message":"agent_type must be provenance, got '"$agent_type"'","fix":"Set agent_type to provenance"}')
        score=$((score - 15))
    fi

    # Build result JSON
    local violations_json="[]"
    if [[ ${#violations[@]} -gt 0 ]]; then
        violations_json=$(printf '%s\n' "${violations[@]}" | jq -s '.')
    fi

    local valid="true"
    [[ $score -lt 70 ]] && valid="false"

    local result
    result=$(jq -n \
        --argjson valid "$valid" \
        --argjson violations "$violations_json" \
        --argjson score "$score" \
        '{valid: $valid, violations: $violations, score: $score}')

    echo "$result"

    if [[ "$strict" == "true" && "$valid" == "false" ]]; then
        return ${EXIT_PROVENANCE_CONFIG_INVALID:-90}
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
            validate_release_protocol "$version" "$changelog_entry" "$manifest_entry" "$strict"
            ;;
        validation)
            validate_validation_protocol "$task_id" "$manifest_entry" "$strict"
            ;;
        testing)
            validate_testing_protocol "$task_id" "$manifest_entry" "$strict"
            ;;
        artifact-publish)
            validate_artifact_publish_protocol "$task_id" "$manifest_entry" "$strict"
            ;;
        provenance)
            validate_provenance_protocol "$task_id" "$manifest_entry" "$strict"
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
export EXIT_PROTOCOL_VALIDATION
export EXIT_TESTS_SKIPPED
export EXIT_COVERAGE_INSUFFICIENT

export -f has_code_changes
export -f has_manifest_field
export -f validate_research_protocol
export -f validate_consensus_protocol
export -f validate_specification_protocol
export -f validate_decomposition_protocol
export -f validate_implementation_protocol
export -f validate_contribution_protocol
export -f validate_release_protocol
export -f validate_validation_protocol
export -f validate_testing_protocol
export -f validate_protocol
