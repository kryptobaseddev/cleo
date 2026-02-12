#!/usr/bin/env bash
# protocol-validation-common.sh - Reusable validation utility functions
#
# @task T2734
# @epic T2724
# LAYER: 2 (Protocol Enforcement)
# DEPENDENCIES: exit-codes.sh
# PROVIDES: check_output_file_exists, check_return_message_format,
#           check_manifest_field_present, check_manifest_field_type,
#           check_documentation_sections, check_agent_type,
#           check_key_findings_count, check_status_valid,
#           check_linked_tasks_present, check_provenance_tags

#=== SOURCE GUARD ================================================
[[ -n "${_PROTOCOL_VALIDATION_COMMON_SH_LOADED:-}" ]] && return 0
declare -r _PROTOCOL_VALIDATION_COMMON_SH_LOADED=1

set -euo pipefail

# ============================================================================
# OUTPUT FILE VALIDATION
# ============================================================================

# Check if expected output file exists
# Args: task_id, expected_dir, expected_pattern (optional glob)
# Returns: 0 if exists, 1 if missing
# @task T2734
check_output_file_exists() {
    local task_id="$1"
    local expected_dir="$2"
    local pattern="${3:-${task_id}*.md}"

    # Check if directory exists
    [[ -d "$expected_dir" ]] || return 1

    # Check if matching files exist
    local matches
    matches=$(find "$expected_dir" -name "$pattern" -type f 2>/dev/null | head -1)
    [[ -n "$matches" ]]
}

# Check if file contains required sections
# Args: file_path, section_names... (space-separated)
# Returns: 0 if all sections found, 1 if any missing
# @task T2734
check_documentation_sections() {
    local file_path="$1"
    shift
    local sections=("$@")

    [[ -f "$file_path" ]] || return 1

    for section in "${sections[@]}"; do
        if ! grep -qE "^#+ .*${section}" "$file_path" 2>/dev/null; then
            return 1
        fi
    done
    return 0
}

# ============================================================================
# RETURN MESSAGE VALIDATION
# ============================================================================

# Check if return message follows protocol format
# Args: message, protocol_type
# Returns: 0 if valid, 1 if invalid
# Valid formats:
#   "Research complete. See MANIFEST.jsonl for summary."
#   "Implementation complete. See MANIFEST.jsonl for summary."
#   etc.
# @task T2734
check_return_message_format() {
    local message="$1"
    local protocol_type="$2"

    local valid_types="Research|Implementation|Validation|Testing|Specification|Consensus|Decomposition|Contribution|Release"
    local valid_statuses="complete|partial|blocked"

    # Check format: "<Type> <status>. See MANIFEST.jsonl for <detail>."
    if echo "$message" | grep -qE "^(${valid_types}) (${valid_statuses})\. See MANIFEST\.jsonl for (summary|details|blocker details)\.$"; then
        return 0
    fi

    return 1
}

# ============================================================================
# MANIFEST FIELD VALIDATION
# ============================================================================

# Check if manifest entry has a required field
# Args: manifest_entry (JSON), field_name
# Returns: 0 if present and non-empty, 1 if missing/empty
# @task T2734
check_manifest_field_present() {
    local manifest_entry="$1"
    local field_name="$2"

    local value
    value=$(echo "$manifest_entry" | jq -r ".${field_name} // empty" 2>/dev/null)
    [[ -n "$value" && "$value" != "null" ]]
}

# Check if manifest field has expected type
# Args: manifest_entry (JSON), field_name, expected_type (string|array|number|boolean|object)
# Returns: 0 if type matches, 1 if mismatch
# @task T2734
check_manifest_field_type() {
    local manifest_entry="$1"
    local field_name="$2"
    local expected_type="$3"

    local actual_type
    actual_type=$(echo "$manifest_entry" | jq -r ".${field_name} | type" 2>/dev/null)

    [[ "$actual_type" == "$expected_type" ]]
}

# Check if key_findings array has valid count (3-7)
# Args: manifest_entry (JSON)
# Returns: 0 if valid count, 1 if invalid
# @task T2734
check_key_findings_count() {
    local manifest_entry="$1"

    local count
    count=$(echo "$manifest_entry" | jq '.key_findings | length // 0' 2>/dev/null)

    [[ $count -ge 3 && $count -le 7 ]]
}

# Check if status is valid enum value
# Args: manifest_entry (JSON)
# Returns: 0 if valid, 1 if invalid
# @task T2734
check_status_valid() {
    local manifest_entry="$1"

    local status
    status=$(echo "$manifest_entry" | jq -r '.status // ""' 2>/dev/null)

    [[ "$status" == "complete" || "$status" == "partial" || "$status" == "blocked" ]]
}

# Check if agent_type matches expected value
# Args: manifest_entry (JSON), expected_type
# Returns: 0 if match, 1 if mismatch
# @task T2734
check_agent_type() {
    local manifest_entry="$1"
    local expected_type="$2"

    local actual_type
    actual_type=$(echo "$manifest_entry" | jq -r '.agent_type // ""' 2>/dev/null)

    [[ "$actual_type" == "$expected_type" ]]
}

# Check if linked_tasks array contains required task IDs
# Args: manifest_entry (JSON), required_ids... (space-separated)
# Returns: 0 if all present, 1 if any missing
# @task T2734
check_linked_tasks_present() {
    local manifest_entry="$1"
    shift
    local required_ids=("$@")

    for task_id in "${required_ids[@]}"; do
        if ! echo "$manifest_entry" | jq -e ".linked_tasks | index(\"$task_id\")" >/dev/null 2>&1; then
            return 1
        fi
    done
    return 0
}

# ============================================================================
# PROVENANCE VALIDATION
# ============================================================================

# Check if file contains @task provenance tag
# Args: file_path, task_id (optional - if provided, checks for specific ID)
# Returns: 0 if found, 1 if missing
# @task T2734
check_provenance_tags() {
    local file_path="$1"
    local task_id="${2:-}"

    [[ -f "$file_path" ]] || return 1

    if [[ -n "$task_id" ]]; then
        grep -q "@task ${task_id}" "$file_path" 2>/dev/null
    else
        grep -qE "@task T[0-9]+" "$file_path" 2>/dev/null
    fi
}

# Check if git diff contains @task tags in new code
# Args: task_id (optional)
# Returns: 0 if found, 1 if missing
# @task T2734
check_provenance_in_diff() {
    local task_id="${1:-}"

    local diff_output
    diff_output=$(git diff --cached 2>/dev/null || git diff HEAD 2>/dev/null || echo "")

    if [[ -z "$diff_output" ]]; then
        return 1  # No changes to check
    fi

    if [[ -n "$task_id" ]]; then
        echo "$diff_output" | grep -q "@task ${task_id}"
    else
        echo "$diff_output" | grep -qE "@task T[0-9]+"
    fi
}

# ============================================================================
# COMPOSITE VALIDATORS
# ============================================================================

# Validate common manifest requirements across all protocols
# Args: manifest_entry (JSON), protocol_type
# Returns: JSON with {valid, violations, score}
# @task T2734
validate_common_manifest_requirements() {
    local manifest_entry="$1"
    local protocol_type="$2"

    local violations=()
    local score=100

    # Check id field
    if ! check_manifest_field_present "$manifest_entry" "id"; then
        violations+=('{"requirement":"COMMON-001","severity":"error","message":"Missing id field","fix":"Add unique id to manifest entry"}')
        score=$((score - 20))
    fi

    # Check file field
    if ! check_manifest_field_present "$manifest_entry" "file"; then
        violations+=('{"requirement":"COMMON-002","severity":"error","message":"Missing file field","fix":"Add file path to manifest entry"}')
        score=$((score - 15))
    fi

    # Check status field
    if ! check_status_valid "$manifest_entry"; then
        violations+=('{"requirement":"COMMON-003","severity":"error","message":"Invalid status value","fix":"Set status to complete/partial/blocked"}')
        score=$((score - 15))
    fi

    # Check key_findings
    if ! check_manifest_field_present "$manifest_entry" "key_findings"; then
        violations+=('{"requirement":"COMMON-004","severity":"error","message":"Missing key_findings","fix":"Add key_findings array with 3-7 items"}')
        score=$((score - 15))
    elif ! check_key_findings_count "$manifest_entry"; then
        violations+=('{"requirement":"COMMON-005","severity":"warning","message":"key_findings should have 3-7 items","fix":"Adjust key_findings count"}')
        score=$((score - 5))
    fi

    # Check linked_tasks
    if ! check_manifest_field_present "$manifest_entry" "linked_tasks"; then
        violations+=('{"requirement":"COMMON-006","severity":"warning","message":"Missing linked_tasks","fix":"Add linked_tasks array with epic and task IDs"}')
        score=$((score - 5))
    fi

    # Build result JSON
    local violations_json="[]"
    if [[ ${#violations[@]} -gt 0 ]]; then
        violations_json=$(printf '%s\n' "${violations[@]}" | jq -s '.')
    fi

    local valid="true"
    [[ $score -lt 70 ]] && valid="false"

    jq -n \
        --argjson valid "$valid" \
        --argjson violations "$violations_json" \
        --argjson score "$score" \
        '{valid: $valid, violations: $violations, score: $score}'
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f check_output_file_exists
export -f check_documentation_sections
export -f check_return_message_format
export -f check_manifest_field_present
export -f check_manifest_field_type
export -f check_key_findings_count
export -f check_status_valid
export -f check_agent_type
export -f check_linked_tasks_present
export -f check_provenance_tags
export -f check_provenance_in_diff
export -f validate_common_manifest_requirements
