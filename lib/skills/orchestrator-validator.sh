#!/usr/bin/env bash
# orchestrator-validator.sh - Protocol Compliance Validation
#
# LAYER: 3 (Domain Logic)
# DEPENDENCIES: exit-codes.sh, config.sh, research-manifest.sh, paths.sh
# PROVIDES: validate_subagent_output, validate_orchestrator_compliance,
#           validate_manifest_integrity, validate_protocol,
#           validate_return_message
#
# Validates compliance with the Orchestrator Protocol Specification.
# See: docs/specs/ORCHESTRATOR-PROTOCOL-SPEC.md
#
# Version: 1.0.0 (cleo v0.55.0)

#=== SOURCE GUARD ================================================
[[ -n "${_ORCHESTRATOR_VALIDATOR_LOADED:-}" ]] && return 0
declare -r _ORCHESTRATOR_VALIDATOR_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_OV_LIB_DIR="${BASH_SOURCE[0]%/*}/.."
[[ "$_OV_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _OV_LIB_DIR="."

# Source dependencies
# shellcheck source=lib/core/exit-codes.sh
source "${_OV_LIB_DIR}/core/exit-codes.sh"
# shellcheck source=lib/core/config.sh
source "${_OV_LIB_DIR}/core/config.sh"
# shellcheck source=lib/skills/research-manifest.sh
source "${_OV_LIB_DIR}/skills/research-manifest.sh"
# shellcheck source=lib/core/paths.sh
source "${_OV_LIB_DIR}/core/paths.sh"

# ============================================================================
# CONSTANTS
# ============================================================================

# Validation rules from spec
readonly _OV_KEY_FINDINGS_MIN=3
readonly _OV_KEY_FINDINGS_MAX=7
readonly _OV_CONTEXT_BUDGET="${_OV_CONTEXT_BUDGET:-10000}"
readonly _OV_MAX_FILE_READ_LINES=100

# Required manifest fields
readonly _OV_MANIFEST_REQUIRED_FIELDS='["id", "file", "title", "date", "status", "topics", "key_findings", "actionable", "needs_followup"]'

# Valid status values
readonly _OV_MANIFEST_VALID_STATUS='["complete", "partial", "blocked"]'

# Valid subagent return message patterns (ORC-005 compliance)
readonly _OV_VALID_RETURN_MESSAGES=(
    "Research complete. See MANIFEST.jsonl for summary."
    "Epic created. See MANIFEST.jsonl for summary."
    "Tests complete. See MANIFEST.jsonl for summary."
    "Documentation complete. See MANIFEST.jsonl for summary."
    "Task complete. See MANIFEST.jsonl for summary."
)

# ============================================================================
# RETURN MESSAGE VALIDATION
# ============================================================================

# Validate subagent return message format
# Args: $1 = actual return message
# Returns: 0 if valid, 1 if invalid (warning only - non-blocking)
#
# Protocol Reference: Subagents MUST return standardized completion messages
# per ORC-005 to ensure orchestrator can verify task completion.
validate_return_message() {
    local message="$1"

    # Handle empty message
    if [[ -z "$message" ]]; then
        echo "WARNING: Subagent return message is empty" >&2
        echo "  Expected: One of the standard completion messages" >&2
        return 1
    fi

    # Normalize message (trim leading/trailing whitespace)
    message=$(echo "$message" | xargs)

    # Check against valid patterns
    for pattern in "${_OV_VALID_RETURN_MESSAGES[@]}"; do
        if [[ "$message" == "$pattern" ]]; then
            return 0
        fi
    done

    # Warning: message doesn't match expected format
    echo "WARNING: Subagent return message does not match protocol" >&2
    echo "  Expected: One of the standard completion messages" >&2
    if [[ ${#message} -gt 100 ]]; then
        echo "  Got: ${message:0:100}..." >&2
    else
        echo "  Got: $message" >&2
    fi
    return 1
}

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

# Get research output directory
_ov_get_output_dir() {
    local dir
    dir=$(get_config_value "research.outputDir" "claudedocs/agent-outputs" 2>/dev/null || echo "claudedocs/agent-outputs")
    echo "$dir"
}

# Get manifest path
_ov_get_manifest_path() {
    local manifest_file output_dir
    manifest_file=$(get_config_value "research.manifestFile" "MANIFEST.jsonl" 2>/dev/null || echo "MANIFEST.jsonl")
    output_dir=$(_ov_get_output_dir)
    echo "${output_dir}/${manifest_file}"
}

# Get todo.json path
_ov_get_todo_file() {
    local cleo_dir
    cleo_dir=$(get_cleo_dir)
    echo "${cleo_dir}/todo.json"
}

# ============================================================================
# SUBAGENT OUTPUT VALIDATION
# ============================================================================

# validate_subagent_output - Validate a subagent's output compliance
# Args:
#   $1 - Research ID to validate
# Output: JSON with pass/fail and list of issues
# Returns: 0 if valid, 6 if validation errors
validate_subagent_output() {
    local research_id="$1"
    local issues=()
    local output_dir manifest_path

    output_dir=$(_ov_get_output_dir)
    manifest_path=$(_ov_get_manifest_path)

    if [[ -z "$research_id" ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "validate_subagent"
            },
            "success": false,
            "error": {
                "code": "E_INVALID_INPUT",
                "message": "Research ID required"
            }
        }'
        return "$EXIT_INVALID_INPUT"
    fi

    # Check 1: Manifest entry exists
    local entry=""
    if [[ -f "$manifest_path" ]]; then
        entry=$(grep "\"id\":\"$research_id\"" "$manifest_path" 2>/dev/null || echo "")
        if [[ -z "$entry" ]]; then
            # Try with spaces around colon
            entry=$(grep "\"id\": *\"$research_id\"" "$manifest_path" 2>/dev/null || echo "")
        fi
    fi

    if [[ -z "$entry" ]]; then
        issues+=("MANIFEST_ENTRY_MISSING: No manifest entry found for id=$research_id")
    else
        # Validate manifest entry schema
        local validation_result
        validation_result=$(echo "$entry" | jq --argjson required "$_OV_MANIFEST_REQUIRED_FIELDS" --argjson valid_status "$_OV_MANIFEST_VALID_STATUS" '
            . as $entry |
            {
                # Check required fields
                missing_fields: [$required[] | select(. as $f | $entry | has($f) | not)],

                # Check status enum
                invalid_status: (if $entry.status != null and ($valid_status | index($entry.status) == null) then $entry.status else null end),

                # Check key_findings count (3-7 items)
                key_findings_count: ($entry.key_findings | if type == "array" then length else 0 end),
                key_findings_invalid: (
                    if $entry.key_findings == null then "missing"
                    elif ($entry.key_findings | type) != "array" then "not_array"
                    elif ($entry.key_findings | length) < 3 then "too_few"
                    elif ($entry.key_findings | length) > 7 then "too_many"
                    else null
                    end
                ),

                # Check date format (YYYY-MM-DD)
                date_invalid: (if $entry.date != null and ($entry.date | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$") | not) then $entry.date else null end),

                # Check topics is array with at least 1 item
                topics_invalid: (
                    if $entry.topics == null then "missing"
                    elif ($entry.topics | type) != "array" then "not_array"
                    elif ($entry.topics | length) < 1 then "empty"
                    else null
                    end
                ),

                # Check needs_followup is array
                needs_followup_invalid: (
                    if $entry.needs_followup == null then "missing"
                    elif ($entry.needs_followup | type) != "array" then "not_array"
                    else null
                    end
                ),

                # Check actionable is boolean
                actionable_invalid: (
                    if $entry.actionable == null then "missing"
                    elif ($entry.actionable | type) != "boolean" then "not_boolean"
                    else null
                    end
                ),

                # Get file for existence check
                file: $entry.file
            }
        ' 2>/dev/null)

        if [[ -n "$validation_result" ]]; then
            # Extract validation issues
            local missing
            missing=$(echo "$validation_result" | jq -r '.missing_fields | if length > 0 then "MISSING_FIELDS: " + join(", ") else empty end')
            [[ -n "$missing" ]] && issues+=("$missing")

            local invalid_status
            invalid_status=$(echo "$validation_result" | jq -r 'if .invalid_status != null then "INVALID_STATUS: " + .invalid_status + " (must be complete|partial|blocked)" else empty end')
            [[ -n "$invalid_status" ]] && issues+=("$invalid_status")

            local kf_issue
            kf_issue=$(echo "$validation_result" | jq -r 'if .key_findings_invalid != null then "KEY_FINDINGS_" + (.key_findings_invalid | ascii_upcase) + ": count=" + (.key_findings_count | tostring) + " (must be 3-7)" else empty end')
            [[ -n "$kf_issue" ]] && issues+=("$kf_issue")

            local date_issue
            date_issue=$(echo "$validation_result" | jq -r 'if .date_invalid != null then "INVALID_DATE: " + .date_invalid + " (must be YYYY-MM-DD)" else empty end')
            [[ -n "$date_issue" ]] && issues+=("$date_issue")

            local topics_issue
            topics_issue=$(echo "$validation_result" | jq -r 'if .topics_invalid != null then "TOPICS_" + (.topics_invalid | ascii_upcase) else empty end')
            [[ -n "$topics_issue" ]] && issues+=("$topics_issue")

            local nf_issue
            nf_issue=$(echo "$validation_result" | jq -r 'if .needs_followup_invalid != null then "NEEDS_FOLLOWUP_" + (.needs_followup_invalid | ascii_upcase) else empty end')
            [[ -n "$nf_issue" ]] && issues+=("$nf_issue")

            local actionable_issue
            actionable_issue=$(echo "$validation_result" | jq -r 'if .actionable_invalid != null then "ACTIONABLE_" + (.actionable_invalid | ascii_upcase) else empty end')
            [[ -n "$actionable_issue" ]] && issues+=("$actionable_issue")

            # Check 2: Output file exists
            local file
            file=$(echo "$validation_result" | jq -r '.file // ""')
            if [[ -n "$file" ]]; then
                local file_path="${output_dir}/${file}"
                if [[ ! -f "$file_path" ]]; then
                    issues+=("FILE_NOT_FOUND: Expected file at $file_path")
                fi
            else
                issues+=("FILE_FIELD_MISSING: No file field in manifest entry")
            fi
        fi
    fi

    # Check 3: Validate needs_followup task IDs exist in CLEO
    if [[ -n "$entry" ]]; then
        local followup_tasks
        followup_tasks=$(echo "$entry" | jq -r '.needs_followup // [] | .[]' 2>/dev/null)
        local todo_file
        todo_file=$(_ov_get_todo_file)

        if [[ -n "$followup_tasks" && -f "$todo_file" ]]; then
            while IFS= read -r task_id; do
                # Skip BLOCKED: entries
                if [[ "$task_id" =~ ^BLOCKED: ]]; then
                    continue
                fi
                # Check if task exists
                local task_exists
                task_exists=$(jq --arg tid "$task_id" '[.tasks[] | select(.id == $tid)] | length' "$todo_file" 2>/dev/null || echo "0")
                if [[ "$task_exists" == "0" ]]; then
                    issues+=("FOLLOWUP_TASK_NOT_FOUND: $task_id does not exist in CLEO")
                fi
            done <<< "$followup_tasks"
        fi
    fi

    # Build result
    local passed=true
    local issue_count=${#issues[@]}
    if [[ $issue_count -gt 0 ]]; then
        passed=false
    fi

    local issues_json
    if [[ $issue_count -gt 0 ]]; then
        issues_json=$(printf '%s\n' "${issues[@]}" | jq -R . | jq -s .)
    else
        issues_json='[]'
    fi

    jq -n \
        --arg research_id "$research_id" \
        --argjson passed "$passed" \
        --argjson issue_count "$issue_count" \
        --argjson issues "$issues_json" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "validate_subagent"
            },
            "success": true,
            "result": {
                "researchId": $research_id,
                "passed": $passed,
                "issueCount": $issue_count,
                "issues": $issues,
                "checkedRules": [
                    "MANIFEST_ENTRY_EXISTS",
                    "REQUIRED_FIELDS_PRESENT",
                    "STATUS_VALID_ENUM",
                    "KEY_FINDINGS_COUNT_3_7",
                    "DATE_ISO_8601",
                    "TOPICS_ARRAY_NON_EMPTY",
                    "NEEDS_FOLLOWUP_ARRAY",
                    "ACTIONABLE_BOOLEAN",
                    "OUTPUT_FILE_EXISTS",
                    "FOLLOWUP_TASKS_EXIST"
                ]
            }
        }'

    [[ "$passed" == "true" ]] && return 0 || return "$EXIT_VALIDATION_ERROR"
}

# ============================================================================
# ORCHESTRATOR COMPLIANCE VALIDATION
# ============================================================================

# validate_orchestrator_compliance - Check orchestrator behavior compliance
# Args:
#   $1 - Epic ID to check (optional, checks current session if not provided)
# Output: JSON with violations and compliance score
# Returns: 0 if compliant, 6 if violations found
validate_orchestrator_compliance() {
    local epic_id="${1:-}"
    local violations=()
    local warnings=()

    local todo_file manifest_path output_dir
    todo_file=$(_ov_get_todo_file)
    manifest_path=$(_ov_get_manifest_path)
    output_dir=$(_ov_get_output_dir)

    # Rule ORC-004: Check if tasks were spawned in dependency order
    # We can only check this post-hoc by looking at completion timestamps
    if [[ -n "$epic_id" && -f "$todo_file" ]]; then
        local order_violations
        order_violations=$(jq --arg epic_id "$epic_id" '
            # Get tasks under epic
            [.tasks[] | select(.parentId == $epic_id and .status == "done")] |

            # Sort by completion time (use updatedAt as proxy)
            sort_by(.updatedAt) |

            # Check for dependency violations
            . as $completed |
            [range(0; length) as $i |
                $completed[$i] as $task |
                ($task.depends // []) as $deps |
                [$deps[] |
                    . as $dep |
                    ($completed | map(.id) | index($dep)) as $dep_idx |
                    select($dep_idx != null and $dep_idx >= $i) |
                    {task: $task.id, dep: $dep, task_idx: $i, dep_idx: $dep_idx}
                ][]
            ]
        ' "$todo_file" 2>/dev/null)

        if [[ -n "$order_violations" && "$order_violations" != "[]" ]]; then
            local violation_count
            violation_count=$(echo "$order_violations" | jq 'length')
            if [[ "$violation_count" -gt 0 ]]; then
                violations+=("ORC-004_DEPENDENCY_ORDER: $violation_count task(s) completed before their dependencies")
            fi
        fi
    fi

    # Rule ORC-005: Check if manifest is being used (has entries)
    if [[ ! -f "$manifest_path" ]]; then
        warnings+=("ORC-005_NO_MANIFEST: Manifest file not found at $manifest_path")
    else
        local manifest_count
        manifest_count=$(wc -l < "$manifest_path" 2>/dev/null || echo "0")
        if [[ "$manifest_count" -eq 0 ]]; then
            warnings+=("ORC-005_EMPTY_MANIFEST: Manifest exists but has no entries")
        fi
    fi

    # Context budget check (informational)
    local context_check
    context_check=$(cat "$(get_cleo_dir)/.context-state.json" 2>/dev/null || echo '{}')
    local current_tokens
    current_tokens=$(echo "$context_check" | jq -r '.usedTokens // 0')

    if [[ "$current_tokens" -gt "$_OV_CONTEXT_BUDGET" ]]; then
        violations+=("CTX_BUDGET_EXCEEDED: Using $current_tokens tokens (budget: $_OV_CONTEXT_BUDGET)")
    elif [[ "$current_tokens" -gt $(( _OV_CONTEXT_BUDGET * 70 / 100 )) ]]; then
        warnings+=("CTX_BUDGET_WARNING: Using $current_tokens tokens (70%+ of $_OV_CONTEXT_BUDGET budget)")
    fi

    # Build result
    local violation_count=${#violations[@]}
    local warning_count=${#warnings[@]}
    local compliant=true
    [[ $violation_count -gt 0 ]] && compliant=false

    local violations_json warnings_json
    if [[ $violation_count -gt 0 ]]; then
        violations_json=$(printf '%s\n' "${violations[@]}" | jq -R . | jq -s .)
    else
        violations_json='[]'
    fi
    if [[ $warning_count -gt 0 ]]; then
        warnings_json=$(printf '%s\n' "${warnings[@]}" | jq -R . | jq -s .)
    else
        warnings_json='[]'
    fi

    jq -n \
        --arg epic_id "$epic_id" \
        --argjson compliant "$compliant" \
        --argjson violation_count "$violation_count" \
        --argjson warning_count "$warning_count" \
        --argjson violations "$violations_json" \
        --argjson warnings "$warnings_json" \
        --argjson current_tokens "$current_tokens" \
        --argjson budget "$_OV_CONTEXT_BUDGET" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "validate_orchestrator"
            },
            "success": true,
            "result": {
                "epicId": (if $epic_id != "" then $epic_id else null end),
                "compliant": $compliant,
                "violationCount": $violation_count,
                "warningCount": $warning_count,
                "violations": $violations,
                "warnings": $warnings,
                "contextUsage": {
                    "current": $current_tokens,
                    "budget": $budget,
                    "percentUsed": (if $budget > 0 then (($current_tokens * 100) / $budget | floor) else 0 end)
                },
                "checkedRules": [
                    "ORC-004_DEPENDENCY_ORDER",
                    "ORC-005_MANIFEST_USAGE",
                    "CTX_BUDGET_LIMIT"
                ]
            }
        }'

    [[ "$compliant" == "true" ]] && return 0 || return "$EXIT_VALIDATION_ERROR"
}

# ============================================================================
# MANIFEST INTEGRITY VALIDATION
# ============================================================================

# validate_manifest_integrity - Check manifest file integrity
# Args: none
# Output: JSON with integrity check results
# Returns: 0 if valid, 6 if issues found
validate_manifest_integrity() {
    local issues=()
    local manifest_path output_dir
    manifest_path=$(_ov_get_manifest_path)
    output_dir=$(_ov_get_output_dir)

    if [[ ! -f "$manifest_path" ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "validate_manifest"
            },
            "success": true,
            "result": {
                "exists": false,
                "passed": true,
                "message": "Manifest does not exist yet (will be created on first research)",
                "issues": []
            }
        }'
        return 0
    fi

    local line_num=0
    local valid_entries=0
    local invalid_entries=0
    local seen_ids=()

    # Read manifest line by line
    while IFS= read -r line || [[ -n "$line" ]]; do
        line_num=$((line_num + 1))

        # Skip empty lines
        [[ -z "${line// /}" ]] && continue

        # Check 1: Valid JSON
        if ! echo "$line" | jq empty 2>/dev/null; then
            issues+=("LINE_${line_num}_INVALID_JSON: Parse error")
            invalid_entries=$((invalid_entries + 1))
            continue
        fi

        # Check 2: Has id field
        local entry_id
        entry_id=$(echo "$line" | jq -r '.id // ""')
        if [[ -z "$entry_id" ]]; then
            issues+=("LINE_${line_num}_MISSING_ID: No id field")
            invalid_entries=$((invalid_entries + 1))
            continue
        fi

        # Check 3: Duplicate ID
        if [[ " ${seen_ids[*]:-} " =~ " ${entry_id} " ]]; then
            issues+=("LINE_${line_num}_DUPLICATE_ID: $entry_id already exists")
            invalid_entries=$((invalid_entries + 1))
            continue
        fi
        seen_ids+=("$entry_id")

        # Check 4: Referenced file exists
        local file
        file=$(echo "$line" | jq -r '.file // ""')
        if [[ -n "$file" ]]; then
            local file_path="${output_dir}/${file}"
            if [[ ! -f "$file_path" ]]; then
                issues+=("LINE_${line_num}_FILE_MISSING: $file does not exist")
            fi
        fi

        valid_entries=$((valid_entries + 1))
    done < "$manifest_path"

    # Check 5: Validate needs_followup references exist in CLEO
    local todo_file
    todo_file=$(_ov_get_todo_file)
    if [[ -f "$todo_file" ]]; then
        local followup_check
        followup_check=$(jq -s --slurpfile tasks "$todo_file" '
            [.[] | .needs_followup // [] | .[] | select(startswith("BLOCKED:") | not)] |
            unique |
            . as $followups |
            ($tasks[0].tasks | map(.id)) as $task_ids |
            [$followups[] | select(. as $f | $task_ids | index($f) == null)]
        ' "$manifest_path" 2>/dev/null || echo '[]')

        if [[ "$followup_check" != "[]" ]]; then
            local missing_tasks
            missing_tasks=$(echo "$followup_check" | jq -r 'join(", ")')
            issues+=("FOLLOWUP_TASKS_MISSING: $missing_tasks not found in CLEO")
        fi
    fi

    # Build result
    local issue_count=${#issues[@]}
    local passed=true
    [[ $issue_count -gt 0 ]] && passed=false

    local issues_json
    if [[ $issue_count -gt 0 ]]; then
        issues_json=$(printf '%s\n' "${issues[@]}" | jq -R . | jq -s .)
    else
        issues_json='[]'
    fi

    jq -n \
        --argjson passed "$passed" \
        --argjson valid_entries "$valid_entries" \
        --argjson invalid_entries "$invalid_entries" \
        --argjson total_lines "$line_num" \
        --argjson issue_count "$issue_count" \
        --argjson issues "$issues_json" \
        --arg manifest_path "$manifest_path" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "validate_manifest"
            },
            "success": true,
            "result": {
                "exists": true,
                "passed": $passed,
                "manifestPath": $manifest_path,
                "stats": {
                    "totalLines": $total_lines,
                    "validEntries": $valid_entries,
                    "invalidEntries": $invalid_entries
                },
                "issueCount": $issue_count,
                "issues": $issues,
                "checkedRules": [
                    "VALID_JSON_SYNTAX",
                    "UNIQUE_IDS",
                    "FILES_EXIST",
                    "FOLLOWUP_TASKS_EXIST"
                ]
            }
        }'

    [[ "$passed" == "true" ]] && return 0 || return "$EXIT_VALIDATION_ERROR"
}

# ============================================================================
# FULL PROTOCOL VALIDATION
# ============================================================================

# validate_protocol - Run comprehensive protocol validation
# Args:
#   $1 - Epic ID (optional)
# Output: JSON with complete validation report
# Returns: 0 if all pass, 6 if any issues
validate_protocol() {
    local epic_id="${1:-}"

    # Run all validators (capture output regardless of exit code)
    local manifest_result orchestrator_result subagent_results

    # Note: these functions return non-zero exit codes when issues are found,
    # but still produce valid JSON output. We need to capture stdout regardless.
    manifest_result=$(validate_manifest_integrity 2>/dev/null) || true
    [[ -z "$manifest_result" ]] && manifest_result='{"result":{"passed":false}}'

    orchestrator_result=$(validate_orchestrator_compliance "$epic_id" 2>/dev/null) || true
    [[ -z "$orchestrator_result" ]] && orchestrator_result='{"result":{"compliant":false}}'

    # Validate all recent subagent outputs (last 10)
    local manifest_path
    manifest_path=$(_ov_get_manifest_path)
    local subagent_ids=()
    local subagent_validations=()

    if [[ -f "$manifest_path" ]]; then
        # Get last 10 research IDs
        while IFS= read -r id; do
            [[ -n "$id" ]] && subagent_ids+=("$id")
        done < <(tail -10 "$manifest_path" | jq -r '.id // empty' 2>/dev/null)

        for id in "${subagent_ids[@]}"; do
            local result
            result=$(validate_subagent_output "$id" 2>/dev/null) || true
            [[ -z "$result" ]] && result='{"result":{"passed":false}}'
            subagent_validations+=("$result")
        done
    fi

    # Aggregate results
    local manifest_passed orchestrator_compliant
    manifest_passed=$(echo "$manifest_result" | jq -r '.result.passed // false')
    orchestrator_compliant=$(echo "$orchestrator_result" | jq -r '.result.compliant // false')

    local subagent_pass_count=0
    local subagent_fail_count=0
    for result in "${subagent_validations[@]:-}"; do
        local passed
        passed=$(echo "$result" | jq -r '.result.passed // false')
        if [[ "$passed" == "true" ]]; then
            subagent_pass_count=$((subagent_pass_count + 1))
        else
            subagent_fail_count=$((subagent_fail_count + 1))
        fi
    done

    local all_passed=true
    [[ "$manifest_passed" != "true" ]] && all_passed=false
    [[ "$orchestrator_compliant" != "true" ]] && all_passed=false
    [[ $subagent_fail_count -gt 0 ]] && all_passed=false

    # Build subagent summary array
    local subagent_summary_json
    if [[ ${#subagent_validations[@]} -gt 0 ]]; then
        subagent_summary_json=$(for result in "${subagent_validations[@]}"; do
            echo "$result" | jq '{id: .result.researchId, passed: .result.passed, issueCount: .result.issueCount}'
        done | jq -s '.')
    else
        subagent_summary_json='[]'
    fi

    jq -n \
        --arg epic_id "$epic_id" \
        --argjson all_passed "$all_passed" \
        --argjson manifest_result "$manifest_result" \
        --argjson orchestrator_result "$orchestrator_result" \
        --argjson subagent_pass "$subagent_pass_count" \
        --argjson subagent_fail "$subagent_fail_count" \
        --argjson subagent_summary "$subagent_summary_json" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "validate_protocol"
            },
            "success": true,
            "result": {
                "epicId": (if $epic_id != "" then $epic_id else null end),
                "allPassed": $all_passed,
                "summary": {
                    "manifestIntegrity": $manifest_result.result.passed,
                    "orchestratorCompliance": $orchestrator_result.result.compliant,
                    "subagentsPassed": $subagent_pass,
                    "subagentsFailed": $subagent_fail
                },
                "details": {
                    "manifest": $manifest_result.result,
                    "orchestrator": $orchestrator_result.result,
                    "subagents": $subagent_summary
                }
            }
        }'

    [[ "$all_passed" == "true" ]] && return 0 || return "$EXIT_VALIDATION_ERROR"
}

# ============================================================================
# PRE-SPAWN COMPLIANCE VERIFICATION
# ============================================================================

# orchestrator_verify_compliance - Verify previous agent completed protocol compliance
#
# Called BEFORE spawning a NEW agent to verify the PREVIOUS agent's compliance.
# Ensures all agents follow the protocol chain: inject -> manifest -> return.
#
# This function implements the "trust but verify" pattern for multi-agent workflows.
# By verifying compliance before each spawn, we catch protocol violations early
# and prevent cascading failures in the orchestration chain.
#
# Args:
#   $1 - previous_task_id (required) - Task ID from the previous spawn
#   $2 - research_id (optional) - Expected research ID (auto-derived if not provided)
#   $3 - expected_return_message (optional) - Return message to validate
#
# Returns:
#   0 - All checks pass, safe to spawn next agent
#   EXIT_VALIDATION_ERROR (6) - One or more compliance checks failed
#   EXIT_MANIFEST_ENTRY_MISSING (62) - No manifest entry found
#
# Output: JSON with detailed compliance results including:
#   - manifestEntryExists: boolean
#   - researchLinkedToTask: boolean
#   - returnStatusValid: boolean (or null if not provided)
#   - violations: array of specific failures
#   - canSpawnNext: boolean (true only if ALL checks pass)
#
# Usage:
#   # Before spawning next agent, verify previous agent compliance
#   result=$(orchestrator_verify_compliance "T1234" "task-research-2026-01-26")
#   if [[ $(echo "$result" | jq -r '.result.canSpawnNext') == "true" ]]; then
#       # Safe to spawn next agent
#       orchestrator_spawn_for_task "T1235"
#   else
#       # Block spawn, handle violations
#       echo "$result" | jq '.result.violations'
#   fi
#
orchestrator_verify_compliance() {
    local previous_task_id="${1:-}"
    local research_id="${2:-}"
    local expected_return_message="${3:-}"
    local violations=()
    local warnings=()

    # Validate required input
    if [[ -z "$previous_task_id" ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "verify_compliance"
            },
            "success": false,
            "error": {
                "code": "E_INVALID_INPUT",
                "message": "previous_task_id is required",
                "fix": "Provide the task ID from the previous spawn operation"
            }
        }'
        return "$EXIT_INVALID_INPUT"
    fi

    local manifest_path output_dir todo_file
    manifest_path=$(_ov_get_manifest_path)
    output_dir=$(_ov_get_output_dir)
    todo_file=$(_ov_get_todo_file)

    # Initialize check results
    local manifest_entry_exists="false"
    local research_linked_to_task="false"
    local return_status_valid="null"
    local manifest_entry=""
    local linked_tasks=()

    # -------------------------------------------------------------------------
    # CHECK 1: Manifest entry exists for previous agent
    # -------------------------------------------------------------------------
    # If research_id not provided, search for entries linked to this task
    if [[ -f "$manifest_path" ]]; then
        if [[ -n "$research_id" ]]; then
            # Search by explicit research ID
            manifest_entry=$(jq -s --arg id "$research_id" '.[] | select(.id == $id)' "$manifest_path" 2>/dev/null || echo "")
        else
            # Search for any entry linked to this task
            manifest_entry=$(jq -s --arg tid "$previous_task_id" '
                [.[] | select(
                    (.linked_tasks // [] | any(. == $tid)) or
                    (.needs_followup // [] | any(. == $tid))
                )] | last // null
            ' "$manifest_path" 2>/dev/null || echo "null")

            # Also try to find by task ID pattern in research ID
            if [[ "$manifest_entry" == "null" || -z "$manifest_entry" ]]; then
                local task_num="${previous_task_id#T}"
                manifest_entry=$(jq -s --arg pattern ".*${task_num}.*" '
                    [.[] | select(.id | test($pattern; "i"))] | last // null
                ' "$manifest_path" 2>/dev/null || echo "null")
            fi
        fi

        if [[ -n "$manifest_entry" && "$manifest_entry" != "null" ]]; then
            manifest_entry_exists="true"

            # Extract actual research ID for downstream checks
            if [[ -z "$research_id" ]]; then
                research_id=$(echo "$manifest_entry" | jq -r '.id // ""')
            fi

            # Get linked_tasks array
            linked_tasks=$(echo "$manifest_entry" | jq -r '.linked_tasks // []')
        else
            violations+=("MANIFEST_ENTRY_MISSING: No manifest entry found for task $previous_task_id (searched id: ${research_id:-auto})")
        fi
    else
        violations+=("MANIFEST_FILE_NOT_FOUND: Manifest file does not exist at $manifest_path")
    fi

    # -------------------------------------------------------------------------
    # CHECK 2: Research is linked to task (bidirectional)
    # -------------------------------------------------------------------------
    if [[ "$manifest_entry_exists" == "true" ]]; then
        # Check if task is in linked_tasks array of manifest entry
        local task_in_manifest
        task_in_manifest=$(echo "$manifest_entry" | jq --arg tid "$previous_task_id" '
            (.linked_tasks // []) | any(. == $tid)
        ' 2>/dev/null || echo "false")

        # Also check if task references this research in its linkedResearch field
        local task_references_research="false"
        if [[ -f "$todo_file" && -n "$research_id" ]]; then
            task_references_research=$(jq --arg tid "$previous_task_id" --arg rid "$research_id" '
                [.tasks[] | select(.id == $tid)] |
                if length > 0 then
                    .[0].linkedResearch // [] | any(. == $rid)
                else
                    false
                end
            ' "$todo_file" 2>/dev/null || echo "false")
        fi

        if [[ "$task_in_manifest" == "true" || "$task_references_research" == "true" ]]; then
            research_linked_to_task="true"
        else
            # This is a warning, not a hard failure (task linking is recommended but not always required)
            warnings+=("RESEARCH_NOT_LINKED: Research entry exists but is not bidirectionally linked to task $previous_task_id")
        fi
    fi

    # -------------------------------------------------------------------------
    # CHECK 3: Return status is valid (if return message provided)
    # -------------------------------------------------------------------------
    if [[ -n "$expected_return_message" ]]; then
        # Use existing validate_return_message function
        if validate_return_message "$expected_return_message" >/dev/null 2>&1; then
            return_status_valid="true"
        else
            return_status_valid="false"
            violations+=("INVALID_RETURN_MESSAGE: Return message does not match protocol format")
        fi
    elif [[ "$manifest_entry_exists" == "true" ]]; then
        # Check status field in manifest entry (alternative validation)
        local entry_status
        entry_status=$(echo "$manifest_entry" | jq -r '.status // "unknown"')
        case "$entry_status" in
            complete|partial|blocked)
                return_status_valid="true"
                ;;
            *)
                return_status_valid="false"
                violations+=("INVALID_MANIFEST_STATUS: Manifest entry has invalid status: $entry_status")
                ;;
        esac
    fi

    # -------------------------------------------------------------------------
    # Build compliance result
    # -------------------------------------------------------------------------
    local violation_count=${#violations[@]}
    local warning_count=${#warnings[@]}
    local can_spawn_next="true"

    # Spawn is blocked if there are any violations
    if [[ $violation_count -gt 0 ]]; then
        can_spawn_next="false"
    fi

    # Build JSON arrays
    local violations_json warnings_json
    if [[ $violation_count -gt 0 ]]; then
        violations_json=$(printf '%s\n' "${violations[@]}" | jq -R . | jq -s .)
    else
        violations_json='[]'
    fi
    if [[ $warning_count -gt 0 ]]; then
        warnings_json=$(printf '%s\n' "${warnings[@]}" | jq -R . | jq -s .)
    else
        warnings_json='[]'
    fi

    # Get entry details for output (if exists)
    local entry_id entry_status entry_file
    if [[ "$manifest_entry_exists" == "true" ]]; then
        entry_id=$(echo "$manifest_entry" | jq -r '.id // ""')
        entry_status=$(echo "$manifest_entry" | jq -r '.status // ""')
        entry_file=$(echo "$manifest_entry" | jq -r '.file // ""')
    else
        entry_id=""
        entry_status=""
        entry_file=""
    fi

    jq -n \
        --arg previous_task_id "$previous_task_id" \
        --arg research_id "${research_id:-}" \
        --argjson manifest_entry_exists "$manifest_entry_exists" \
        --argjson research_linked "$research_linked_to_task" \
        --argjson return_valid "$return_status_valid" \
        --argjson can_spawn_next "$can_spawn_next" \
        --argjson violation_count "$violation_count" \
        --argjson warning_count "$warning_count" \
        --argjson violations "$violations_json" \
        --argjson warnings "$warnings_json" \
        --arg entry_id "$entry_id" \
        --arg entry_status "$entry_status" \
        --arg entry_file "$entry_file" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "verify_compliance"
            },
            "success": true,
            "result": {
                "previousTaskId": $previous_task_id,
                "researchId": (if $research_id != "" then $research_id else null end),
                "checks": {
                    "manifestEntryExists": $manifest_entry_exists,
                    "researchLinkedToTask": $research_linked,
                    "returnStatusValid": $return_valid
                },
                "canSpawnNext": $can_spawn_next,
                "violationCount": $violation_count,
                "warningCount": $warning_count,
                "violations": $violations,
                "warnings": $warnings,
                "manifestEntry": (
                    if $manifest_entry_exists then {
                        "id": $entry_id,
                        "status": $entry_status,
                        "file": $entry_file
                    } else null end
                ),
                "checkedRules": [
                    "MANIFEST_ENTRY_EXISTS",
                    "RESEARCH_TASK_BIDIRECTIONAL_LINK",
                    "VALID_RETURN_STATUS"
                ]
            }
        }'

    # Return appropriate exit code
    if [[ "$can_spawn_next" == "true" ]]; then
        return 0
    elif [[ "$manifest_entry_exists" == "false" ]]; then
        return "$EXIT_MANIFEST_ENTRY_MISSING"
    else
        return "$EXIT_VALIDATION_ERROR"
    fi
}

# ============================================================================
# EXPORT FUNCTIONS
# ============================================================================

export -f validate_subagent_output
export -f validate_orchestrator_compliance
export -f validate_manifest_integrity
export -f validate_protocol
export -f orchestrator_verify_compliance
