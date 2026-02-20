#!/usr/bin/env bash
# compliance-check.sh - Orchestrator Compliance Checking Functions
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: exit-codes.sh, metrics-enums.sh, research-manifest.sh
# PROVIDES: check_manifest_entry, check_research_link, check_return_format,
#           score_subagent_compliance, log_compliance_metrics, log_violation
#
# Implements compliance validation for orchestrator subagent outputs.
# Validates MANIFEST.jsonl entries, research links, and return format adherence.
# Generates compliance metrics conforming to schemas/metrics.schema.json.

#=== SOURCE GUARD ================================================
[[ -n "${_COMPLIANCE_CHECK_SH_LOADED:-}" ]] && return 0
declare -r _COMPLIANCE_CHECK_SH_LOADED=1

set -euo pipefail

# Determine library directory
_CC_LIB_DIR="${BASH_SOURCE[0]%/*}/.."
[[ "$_CC_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _CC_LIB_DIR="."

# Source dependencies
# shellcheck source=lib/core/exit-codes.sh
source "${_CC_LIB_DIR}/core/exit-codes.sh"
# shellcheck source=lib/metrics/metrics-enums.sh
source "${_CC_LIB_DIR}/metrics/metrics-enums.sh"
# shellcheck source=lib/skills/research-manifest.sh
source "${_CC_LIB_DIR}/skills/research-manifest.sh"
# shellcheck source=lib/metrics/metrics-common.sh
source "${_CC_LIB_DIR}/metrics/metrics-common.sh"
# shellcheck source=lib/data/file-ops.sh
source "${_CC_LIB_DIR}/data/file-ops.sh"
# shellcheck source=lib/core/paths.sh
source "${_CC_LIB_DIR}/core/paths.sh"

# ============================================================================
# CONFIGURATION
# ============================================================================

# Compliance metrics output directory
_CC_METRICS_DIR="claudedocs/metrics"

# Compliance JSONL file
_CC_COMPLIANCE_FILE="COMPLIANCE.jsonl"

# Expected return message pattern
_CC_RETURN_PATTERN="Research complete\. See MANIFEST\.jsonl"

# T1954 epic ID for violation tracking (self-improvement & compliance)
_CC_VIOLATION_EPIC="T1954"

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

# @task T2753 - Migrated to metrics-common.sh
# Use ensure_metrics_dir, get_compliance_path, iso_timestamp from metrics-common.sh

# _cc_ensure_metrics_dir - Wrapper for ensure_metrics_dir
# Returns: 0 on success, 3 on failure
_cc_ensure_metrics_dir() {
    ensure_metrics_dir "$_CC_METRICS_DIR" >/dev/null
    return $?
}

# _cc_get_compliance_path - Get full path to compliance metrics file
_cc_get_compliance_path() {
    get_compliance_path "$_CC_METRICS_DIR"
}

# _cc_iso_timestamp - Generate ISO 8601 timestamp
_cc_iso_timestamp() {
    iso_timestamp
}

# ============================================================================
# PUBLIC API
# ============================================================================

# check_manifest_entry - Verify MANIFEST.jsonl has valid entry for task
# Args: $1 = task_id (e.g., "T1234")
# Returns: MANIFEST_INTEGRITY_* enum value via stdout
# Exit codes: 0 = success, 4 = not found
#
# Checks:
#   - Entry exists in MANIFEST.jsonl with linked_tasks containing task_id
#   - Entry has required fields (key_findings array, linked_tasks, etc.)
#   - Entry schema validation passes
check_manifest_entry() {
    local task_id="$1"
    local manifest_path
    manifest_path=$(_rm_get_manifest_path)

    # Check manifest exists
    if [[ ! -f "$manifest_path" ]]; then
        echo "$MANIFEST_INTEGRITY_MISSING"
        return "$EXIT_NOT_FOUND"
    fi

    # Search for entries linked to this task
    local entry
    entry=$(jq -s --arg tid "$task_id" '
        [.[] | select(
            (.linked_tasks // [] | any(. == $tid)) or
            (.task_ids // [] | any(. == $tid))
        )] | .[0] // null
    ' "$manifest_path" 2>/dev/null)

    # No entry found
    if [[ "$entry" == "null" || -z "$entry" ]]; then
        echo "$MANIFEST_INTEGRITY_MISSING"
        return "$EXIT_NOT_FOUND"
    fi

    # Validate required fields
    local missing_fields=()
    local has_id has_title has_status has_key_findings

    has_id=$(echo "$entry" | jq -e 'has("id") or has("research_id")' 2>/dev/null || echo "false")
    has_title=$(echo "$entry" | jq -e 'has("title")' 2>/dev/null || echo "false")
    has_status=$(echo "$entry" | jq -e 'has("status")' 2>/dev/null || echo "false")
    has_key_findings=$(echo "$entry" | jq -e 'has("key_findings") or has("findings_summary")' 2>/dev/null || echo "false")

    [[ "$has_id" != "true" ]] && missing_fields+=("id")
    [[ "$has_title" != "true" ]] && missing_fields+=("title")
    [[ "$has_status" != "true" ]] && missing_fields+=("status")
    [[ "$has_key_findings" != "true" ]] && missing_fields+=("key_findings")

    # Determine integrity status
    if [[ ${#missing_fields[@]} -eq 0 ]]; then
        # All required fields present - check array types
        local findings_valid linked_valid
        findings_valid=$(echo "$entry" | jq -e '
            (.key_findings | type == "array") or
            (.findings_summary | type == "string")
        ' 2>/dev/null || echo "false")
        linked_valid=$(echo "$entry" | jq -e '
            (.linked_tasks | type == "array") or
            (.task_ids | type == "array")
        ' 2>/dev/null || echo "false")

        if [[ "$findings_valid" == "true" && "$linked_valid" == "true" ]]; then
            echo "$MANIFEST_INTEGRITY_VALID"
            return 0
        else
            echo "$MANIFEST_INTEGRITY_PARTIAL"
            return 0
        fi
    elif [[ ${#missing_fields[@]} -lt 3 ]]; then
        echo "$MANIFEST_INTEGRITY_PARTIAL"
        return 0
    else
        echo "$MANIFEST_INTEGRITY_INVALID"
        return 0
    fi
}

# check_research_link - Verify task has researchLinks in cleo show output
# Args: $1 = task_id (e.g., "T1234")
# Returns: "true" or "false" via stdout
# Exit codes: 0 always (check output for result)
check_research_link() {
    local task_id="$1"

    # Use cleo show to get task details
    local task_output
    if ! task_output=$(cleo show "$task_id" --format json 2>/dev/null); then
        echo "false"
        return 0
    fi

    # Check for researchLinks field (non-empty array)
    local has_links
    has_links=$(echo "$task_output" | jq -r '
        .result.task.researchLinks // [] | length > 0
    ' 2>/dev/null || echo "false")

    echo "$has_links"
    return 0
}

# check_return_format - Verify response matches expected return format
# Args: $1 = response text from subagent
# Returns: "true" or "false" via stdout
# Exit codes: 0 always (check output for result)
#
# Expected format: "Research complete. See MANIFEST.jsonl..."
check_return_format() {
    local response="$1"

    # Check if response matches expected pattern
    if [[ "$response" =~ $_CC_RETURN_PATTERN ]]; then
        echo "true"
    else
        echo "false"
    fi
    return 0
}

# score_subagent_compliance - Calculate comprehensive compliance score
# Args: $1 = task_id, $2 = agent_id, $3 = response text
# Returns: JSON metrics object conforming to metrics.schema.json via stdout
# Exit codes: 0 on success
#
# Calculates:
#   - manifest_integrity: VALID|PARTIAL|INVALID|MISSING
#   - rule_adherence_score: 0.0-1.0
#   - compliance_pass_rate: 0.0-1.0
#   - violation_count: integer
#   - violation_severity: low|medium|high|critical
score_subagent_compliance() {
    local task_id="$1"
    local agent_id="$2"
    local response="${3:-}"

    local timestamp
    timestamp=$(_cc_iso_timestamp)

    # Run all checks
    local manifest_integrity research_linked return_format_valid
    manifest_integrity=$(check_manifest_entry "$task_id" 2>/dev/null || echo "$MANIFEST_INTEGRITY_MISSING")
    research_linked=$(check_research_link "$task_id")
    return_format_valid=$(check_return_format "$response")

    # Calculate scores
    local rules_passed=0
    local total_rules=3
    local violation_count=0
    local violation_severity="$SEVERITY_LOW"

    # Rule 1: Manifest entry exists and is valid
    case "$manifest_integrity" in
        "$MANIFEST_INTEGRITY_VALID")
            rules_passed=$((rules_passed + 1))
            ;;
        "$MANIFEST_INTEGRITY_PARTIAL")
            rules_passed=$((rules_passed + 1))  # Partial counts as pass
            violation_count=$((violation_count + 1))
            ;;
        "$MANIFEST_INTEGRITY_INVALID")
            violation_count=$((violation_count + 1))
            [[ "$violation_severity" == "$SEVERITY_LOW" ]] && violation_severity="$SEVERITY_MEDIUM"
            ;;
        "$MANIFEST_INTEGRITY_MISSING")
            violation_count=$((violation_count + 1))
            violation_severity="$SEVERITY_HIGH"
            ;;
    esac

    # Rule 2: Research link exists
    if [[ "$research_linked" == "true" ]]; then
        rules_passed=$((rules_passed + 1))
    else
        violation_count=$((violation_count + 1))
        [[ "$violation_severity" == "$SEVERITY_LOW" ]] && violation_severity="$SEVERITY_MEDIUM"
    fi

    # Rule 3: Return format is correct
    if [[ "$return_format_valid" == "true" ]]; then
        rules_passed=$((rules_passed + 1))
    else
        violation_count=$((violation_count + 1))
        # Return format violation is lower severity
    fi

    # Calculate rates
    local rule_adherence_score compliance_pass_rate
    rule_adherence_score=$(awk "BEGIN {printf \"%.2f\", $rules_passed / $total_rules}")

    # Compliance pass rate: 1.0 if zero violations, 0.0 otherwise
    if [[ $violation_count -eq 0 ]]; then
        compliance_pass_rate="1.0"
    else
        compliance_pass_rate="0.0"
    fi

    # Build metrics JSON
    jq -n \
        --arg timestamp "$timestamp" \
        --arg category "$METRIC_CATEGORY_COMPLIANCE" \
        --arg source "$METRIC_SOURCE_AGENT" \
        --arg source_id "$agent_id" \
        --arg period "$AGGREGATION_PERIOD_INSTANT" \
        --argjson compliance_pass_rate "$compliance_pass_rate" \
        --argjson rule_adherence_score "$rule_adherence_score" \
        --argjson violation_count "$violation_count" \
        --arg violation_severity "$violation_severity" \
        --arg manifest_integrity "$manifest_integrity" \
        --arg task_id "$task_id" \
        --arg research_linked "$research_linked" \
        --arg return_format_valid "$return_format_valid" \
        '{
            "timestamp": $timestamp,
            "category": $category,
            "source": $source,
            "source_id": $source_id,
            "period": $period,
            "compliance": {
                "compliance_pass_rate": $compliance_pass_rate,
                "rule_adherence_score": $rule_adherence_score,
                "violation_count": $violation_count,
                "violation_severity": $violation_severity,
                "manifest_integrity": $manifest_integrity
            },
            "tags": ["subagent-compliance", "orchestrator"],
            "_context": {
                "task_id": $task_id,
                "research_linked": ($research_linked == "true"),
                "return_format_valid": ($return_format_valid == "true")
            }
        }'

    return 0
}

# log_compliance_metrics - Append metrics to COMPLIANCE.jsonl
# Args: $1 = JSON metrics object (from score_subagent_compliance)
# Returns: JSON result wrapped in CLEO envelope via stdout
# Exit codes: 0 on success, 3 on file error, 6 on validation error
# @task T3152 - Applied atomic_jsonl_append for flock protection
# @epic T3147 - Manifest Bash Foundation and Protocol Updates
log_compliance_metrics() {
    local metrics_json="$1"
    local compliance_path

    # Ensure metrics directory exists
    if ! _cc_ensure_metrics_dir; then
        jq -n '{
            "_meta": {"command": "compliance-check", "operation": "log_metrics"},
            "success": false,
            "error": {
                "code": "E_FILE_ERROR",
                "message": "Failed to create metrics directory"
            }
        }'
        return "$EXIT_FILE_ERROR"
    fi

    compliance_path=$(_cc_get_compliance_path)

    # Validate JSON input
    if ! echo "$metrics_json" | jq empty 2>/dev/null; then
        jq -n '{
            "_meta": {"command": "compliance-check", "operation": "log_metrics"},
            "success": false,
            "error": {
                "code": "E_VALIDATION",
                "message": "Invalid JSON metrics input"
            }
        }'
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Use atomic JSONL append (handles compaction, locking, validation)
    if ! atomic_jsonl_append "$compliance_path" "$metrics_json"; then
        jq -n '{
            "_meta": {"command": "compliance-check", "operation": "log_metrics"},
            "success": false,
            "error": {
                "code": "E_LOCK_FAILED",
                "message": "Failed to append to compliance metrics"
            }
        }'
        return 8
    fi

    local source_id
    source_id=$(echo "$metrics_json" | jq -r '.source_id // "unknown"')

    jq -n \
        --arg file "$compliance_path" \
        --arg source_id "$source_id" \
        '{
            "_meta": {"command": "compliance-check", "operation": "log_metrics"},
            "success": true,
            "result": {
                "metricsFile": $file,
                "sourceId": $source_id,
                "action": "appended"
            }
        }'

    return 0
}

# log_violation - Create issue task under T1954 epic for compliance violation
# Args: $1 = epic_id (usually T1954), $2 = violation_details (JSON or text)
# Returns: JSON result with created task ID via stdout
# Exit codes: 0 on success, various on cleo errors
#
# Creates task: "ISSUE: [violation summary]" with labels compliance-violation
log_violation() {
    local epic_id="${1:-$_CC_VIOLATION_EPIC}"
    local violation_details="$2"

    local timestamp
    timestamp=$(_cc_iso_timestamp)

    # Extract summary from violation details
    local summary agent_id task_id severity
    if echo "$violation_details" | jq empty 2>/dev/null; then
        # JSON format
        summary=$(echo "$violation_details" | jq -r '.summary // "Compliance violation detected"')
        agent_id=$(echo "$violation_details" | jq -r '.agent_id // "unknown"')
        task_id=$(echo "$violation_details" | jq -r '.task_id // "unknown"')
        severity=$(echo "$violation_details" | jq -r '.severity // "medium"')
    else
        # Plain text
        summary="$violation_details"
        agent_id="unknown"
        task_id="unknown"
        severity="medium"
    fi

    # Build task title
    local title="ISSUE: $summary"
    # Truncate if too long
    [[ ${#title} -gt 100 ]] && title="${title:0:97}..."

    # Build description
    local description
    description="Compliance violation detected at $timestamp

**Agent:** $agent_id
**Task:** $task_id
**Severity:** $severity

**Details:**
$violation_details"

    # Create task under epic with cleo
    local create_result
    if create_result=$(cleo add "$title" \
        --parent "$epic_id" \
        --labels "compliance-violation,auto-generated" \
        --priority "medium" \
        --description "$description" \
        --format json 2>&1); then

        local created_id
        created_id=$(echo "$create_result" | jq -r '.result.id // .id // "unknown"')

        jq -n \
            --arg epic_id "$epic_id" \
            --arg task_id "$created_id" \
            --arg summary "$summary" \
            '{
                "_meta": {"command": "compliance-check", "operation": "log_violation"},
                "success": true,
                "result": {
                    "epicId": $epic_id,
                    "createdTaskId": $task_id,
                    "summary": $summary,
                    "action": "issue_created"
                }
            }'
        return 0
    else
        jq -n \
            --arg error "$create_result" \
            --arg epic_id "$epic_id" \
            '{
                "_meta": {"command": "compliance-check", "operation": "log_violation"},
                "success": false,
                "error": {
                    "code": "E_TASK_CREATE_FAILED",
                    "message": $error,
                    "epicId": $epic_id
                }
            }'
        return "$EXIT_GENERAL_ERROR"
    fi
}

# ============================================================================
# CONVENIENCE FUNCTIONS
# ============================================================================

# validate_and_log_compliance - Combined validation and logging
# Args: $1 = task_id, $2 = agent_id, $3 = response
# Returns: JSON metrics via stdout, logs to COMPLIANCE.jsonl
# Exit codes: 0 on success
validate_and_log_compliance() {
    local task_id="$1"
    local agent_id="$2"
    local response="${3:-}"

    # Score compliance
    local metrics
    metrics=$(score_subagent_compliance "$task_id" "$agent_id" "$response")

    # Log to file
    log_compliance_metrics "$metrics" >/dev/null 2>&1 || true

    # Check for violations needing escalation
    local violation_count severity
    violation_count=$(echo "$metrics" | jq -r '.compliance.violation_count // 0')
    severity=$(echo "$metrics" | jq -r '.compliance.violation_severity // "low"')

    # Log violation issue if high/critical severity
    if [[ "$severity" == "$SEVERITY_HIGH" || "$severity" == "$SEVERITY_CRITICAL" ]]; then
        local violation_json
        violation_json=$(jq -n \
            --arg summary "Subagent compliance failure: $severity severity" \
            --arg agent_id "$agent_id" \
            --arg task_id "$task_id" \
            --arg severity "$severity" \
            --argjson violation_count "$violation_count" \
            '{
                summary: $summary,
                agent_id: $agent_id,
                task_id: $task_id,
                severity: $severity,
                violation_count: $violation_count
            }')
        log_violation "$_CC_VIOLATION_EPIC" "$violation_json" >/dev/null 2>&1 || true
    fi

    # Output metrics
    echo "$metrics"
    return 0
}

# get_compliance_summary - Get summary of compliance metrics
# Args: [--since DATE] [--agent AGENT_ID]
# Returns: JSON summary via stdout
get_compliance_summary() {
    local since="" agent_filter=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --since)
                since="$2"
                shift 2
                ;;
            --agent)
                agent_filter="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    local compliance_path
    compliance_path=$(_cc_get_compliance_path)

    if [[ ! -f "$compliance_path" ]]; then
        jq -n '{
            "_meta": {"command": "compliance-check", "operation": "summary"},
            "success": true,
            "result": {
                "totalEntries": 0,
                "averagePassRate": 0,
                "averageAdherence": 0,
                "totalViolations": 0
            }
        }'
        return 0
    fi

    # Build jq filter
    local jq_filter="."
    if [[ -n "$since" ]]; then
        jq_filter="${jq_filter} | select(.timestamp >= \"$since\")"
    fi
    if [[ -n "$agent_filter" ]]; then
        jq_filter="${jq_filter} | select(.source_id == \"$agent_filter\")"
    fi

    # Calculate summary stats
    local summary
    summary=$(cat "$compliance_path" | jq -s "
        [.[] | $jq_filter] |
        {
            totalEntries: length,
            averagePassRate: (if length > 0 then ([.[].compliance.compliance_pass_rate] | add / length) else 0 end),
            averageAdherence: (if length > 0 then ([.[].compliance.rule_adherence_score] | add / length) else 0 end),
            totalViolations: ([.[].compliance.violation_count] | add // 0),
            bySeverity: (group_by(.compliance.violation_severity) | map({key: .[0].compliance.violation_severity, value: length}) | from_entries)
        }
    " 2>/dev/null || echo '{"totalEntries":0}')

    jq -n \
        --argjson summary "$summary" \
        '{
            "_meta": {"command": "compliance-check", "operation": "summary"},
            "success": true,
            "result": $summary
        }'

    return 0
}

# ============================================================================
# TOKEN TRACKING FUNCTIONS (T1995)
# ============================================================================

# get_context_state - Read current context state from session state file
# Args: $1 = session_id (optional, uses current session if not provided)
# Returns: JSON context state or empty object
get_context_state() {
    local session_id="${1:-}"
    local cleo_dir="${CLEO_DIR:-.cleo}"
    local state_file

    repair_errant_context_state_paths "$cleo_dir" >/dev/null 2>&1 || true

    # Determine state file path
    if [[ -n "$session_id" ]]; then
        # Per-session state file
        state_file=$(get_context_state_file_path "$session_id" "$cleo_dir" "context-state-{sessionId}.json")
    else
        # Try to get current session
        if [[ -f "${cleo_dir}/.current-session" ]]; then
            local current_session
            current_session=$(cat "${cleo_dir}/.current-session" 2>/dev/null | tr -d '\n')
            if [[ -n "$current_session" ]]; then
                state_file=$(get_context_state_file_path "$current_session" "$cleo_dir" "context-state-{sessionId}.json")
            fi
        fi
        # Fallback to singleton
        [[ -z "$state_file" ]] && state_file="$(get_context_state_file_path "" "$cleo_dir")"
    fi

    # Read state file if it exists
    if [[ -f "$state_file" ]]; then
        cat "$state_file" 2>/dev/null
    else
        echo '{}'
    fi
}

# extract_token_metrics - Extract token metrics from context state
# Args: $1 = context state JSON
# Returns: JSON object with token metrics
extract_token_metrics() {
    local context_state="$1"

    echo "$context_state" | jq '{
        input_tokens: (.contextWindow.breakdown.inputTokens // 0),
        output_tokens: (.contextWindow.breakdown.outputTokens // 0),
        cache_creation_tokens: (.contextWindow.breakdown.cacheCreationTokens // 0),
        cache_read_tokens: (.contextWindow.breakdown.cacheReadTokens // 0),
        total_tokens: (.contextWindow.currentTokens // 0),
        max_tokens: (.contextWindow.maxTokens // 200000),
        percentage: (.contextWindow.percentage // 0),
        status: (.status // "unknown"),
        timestamp: (.timestamp // null)
    }' 2>/dev/null || echo '{"input_tokens":0,"output_tokens":0,"total_tokens":0,"max_tokens":200000,"percentage":0}'
}

# calculate_token_efficiency - Calculate token efficiency metrics
# Args: $1 = tokens_used, $2 = max_tokens, $3 = tasks_completed, $4 = input_tokens, $5 = output_tokens
# Returns: JSON object with efficiency metrics
calculate_token_efficiency() {
    local tokens_used="${1:-0}"
    local max_tokens="${2:-200000}"
    local tasks_completed="${3:-0}"
    local input_tokens="${4:-0}"
    local output_tokens="${5:-0}"

    # Avoid division by zero
    [[ "$tokens_used" -eq 0 ]] && tokens_used=1
    [[ "$max_tokens" -eq 0 ]] && max_tokens=200000

    # Calculate metrics
    local context_utilization token_utilization_rate context_efficiency

    # Context utilization: percentage of context window used
    context_utilization=$(awk "BEGIN {printf \"%.4f\", $tokens_used / $max_tokens}")

    # Token utilization rate: output / total (higher = more productive)
    local total_io=$((input_tokens + output_tokens))
    [[ "$total_io" -eq 0 ]] && total_io=1
    token_utilization_rate=$(awk "BEGIN {printf \"%.4f\", $output_tokens / $total_io}")

    # Context efficiency: tasks completed per 10% context used
    # (tasks_completed / (context_utilization * 10))
    if (( $(echo "$context_utilization > 0.01" | bc -l) )); then
        context_efficiency=$(awk "BEGIN {printf \"%.4f\", $tasks_completed / ($context_utilization * 10)}")
    else
        context_efficiency="0"
    fi

    jq -n \
        --argjson tokens_used "$tokens_used" \
        --argjson max_tokens "$max_tokens" \
        --argjson tasks_completed "$tasks_completed" \
        --argjson input_tokens "$input_tokens" \
        --argjson output_tokens "$output_tokens" \
        --argjson context_utilization "$context_utilization" \
        --argjson token_utilization_rate "$token_utilization_rate" \
        --argjson context_efficiency "$context_efficiency" \
        '{
            tokens_used: $tokens_used,
            max_tokens: $max_tokens,
            tasks_completed: $tasks_completed,
            context_utilization: $context_utilization,
            token_utilization_rate: $token_utilization_rate,
            context_efficiency: $context_efficiency,
            input_tokens: $input_tokens,
            output_tokens: $output_tokens
        }'
}

# score_subagent_with_tokens - Score subagent with token metrics
# Args: $1 = task_id, $2 = agent_id, $3 = response, $4 = token_metrics JSON (optional)
# Returns: Extended compliance metrics JSON
score_subagent_with_tokens() {
    local task_id="$1"
    local agent_id="$2"
    local response="${3:-}"
    # Note: Use quoted default to avoid Bash 5.3+ brace expansion bug
    local token_metrics="${4:-'{}'}"

    # Get base compliance score
    local base_metrics
    base_metrics=$(score_subagent_compliance "$task_id" "$agent_id" "$response")

    # Extract token values
    local input_tokens output_tokens total_tokens context_utilization
    input_tokens=$(echo "$token_metrics" | jq -r '.input_tokens // 0')
    output_tokens=$(echo "$token_metrics" | jq -r '.output_tokens // 0')
    total_tokens=$(echo "$token_metrics" | jq -r '.total_tokens // 0')
    context_utilization=$(echo "$token_metrics" | jq -r '.context_utilization // 0')

    # Add token metrics to compliance data
    echo "$base_metrics" | jq \
        --argjson input_tokens "$input_tokens" \
        --argjson output_tokens "$output_tokens" \
        --argjson total_tokens "$total_tokens" \
        --argjson context_utilization "$context_utilization" \
        '. + {
            "efficiency": {
                "input_tokens": $input_tokens,
                "output_tokens": $output_tokens,
                "total_tokens": $total_tokens,
                "context_utilization": $context_utilization
            }
        }'
}

# calculate_orchestration_overhead - Calculate orchestration overhead metrics
# Args: $1 = orchestrator_tokens, $2 = total_subagent_tokens, $3 = num_subagents
# Returns: JSON object with overhead metrics
calculate_orchestration_overhead() {
    local orchestrator_tokens="${1:-0}"
    local total_subagent_tokens="${2:-0}"
    local num_subagents="${3:-1}"

    [[ "$num_subagents" -eq 0 ]] && num_subagents=1

    local total_tokens=$((orchestrator_tokens + total_subagent_tokens))
    [[ "$total_tokens" -eq 0 ]] && total_tokens=1

    # Overhead ratio: orchestrator tokens / total tokens
    local overhead_ratio
    overhead_ratio=$(awk "BEGIN {printf \"%.4f\", $orchestrator_tokens / $total_tokens}")

    # Tokens per subagent
    local tokens_per_subagent
    tokens_per_subagent=$(awk "BEGIN {printf \"%.0f\", $total_subagent_tokens / $num_subagents}")

    jq -n \
        --argjson orchestrator_tokens "$orchestrator_tokens" \
        --argjson total_subagent_tokens "$total_subagent_tokens" \
        --argjson num_subagents "$num_subagents" \
        --argjson overhead_ratio "$overhead_ratio" \
        --argjson tokens_per_subagent "$tokens_per_subagent" \
        '{
            orchestrator_tokens: $orchestrator_tokens,
            total_subagent_tokens: $total_subagent_tokens,
            num_subagents: $num_subagents,
            overhead_ratio: $overhead_ratio,
            tokens_per_subagent: $tokens_per_subagent
        }'
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f check_manifest_entry
export -f check_research_link
export -f check_return_format
export -f score_subagent_compliance
export -f log_compliance_metrics
export -f log_violation
export -f validate_and_log_compliance
export -f get_compliance_summary
export -f get_context_state
export -f extract_token_metrics
export -f calculate_token_efficiency
export -f score_subagent_with_tokens
export -f calculate_orchestration_overhead
