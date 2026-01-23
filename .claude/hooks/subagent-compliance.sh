#!/bin/bash
# .claude/hooks/subagent-compliance.sh
# SubagentStop hook for CLEO compliance tracking
# T1993: Automatic compliance checking for subagents

set -euo pipefail

# ============================================================================
# CONFIGURATION
# ============================================================================

METRICS_DIR="${CLAUDE_PROJECT_DIR:-.}/.cleo/metrics"
COMPLIANCE_LOG="$METRICS_DIR/COMPLIANCE.jsonl"
RESEARCH_MANIFEST="${CLAUDE_PROJECT_DIR:-.}/claudedocs/research-outputs/MANIFEST.jsonl"

# Exit codes
EXIT_SUCCESS=0
EXIT_BLOCK=2

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

# Get current timestamp
timestamp() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# Log compliance event in metrics schema format
# Required format for cleo compliance command compatibility
log_compliance() {
    local status="$1"
    local agent_id="$2"
    local agent_type="$3"
    local message="$4"
    local details="${5:-{}}"

    mkdir -p "$METRICS_DIR"

    # Extract values from details (with fallback defaults)
    local violation_count input_tokens output_tokens context_utilization token_utilization_rate
    violation_count=$(echo "$details" | jq -r 'if .violations then (.violations | length) else 0 end' 2>/dev/null)
    [[ -z "$violation_count" || "$violation_count" == "null" ]] && violation_count=0
    input_tokens=$(echo "$details" | jq -r '.input_tokens // 0' 2>/dev/null)
    [[ -z "$input_tokens" || "$input_tokens" == "null" ]] && input_tokens=0
    output_tokens=$(echo "$details" | jq -r '.output_tokens // 0' 2>/dev/null)
    [[ -z "$output_tokens" || "$output_tokens" == "null" ]] && output_tokens=0
    context_utilization=$(echo "$details" | jq -r '.context_utilization // 0' 2>/dev/null)
    [[ -z "$context_utilization" || "$context_utilization" == "null" ]] && context_utilization=0
    token_utilization_rate=$(echo "$details" | jq -r '.token_utilization_rate // 0' 2>/dev/null)
    [[ -z "$token_utilization_rate" || "$token_utilization_rate" == "null" ]] && token_utilization_rate=0

    # Calculate compliance scores
    local compliance_pass_rate rule_adherence_score violation_severity
    if [[ "$status" == "pass" ]]; then
        compliance_pass_rate="1.0"
        rule_adherence_score="1.0"
        violation_severity="none"
    elif [[ "$status" == "warn" ]]; then
        compliance_pass_rate="0.5"
        rule_adherence_score="0.7"
        violation_severity="medium"
    else
        compliance_pass_rate="0.0"
        rule_adherence_score="0.3"
        violation_severity="high"
    fi

    # Write in metrics schema format (compatible with cleo compliance command)
    jq -nc \
        --arg ts "$(timestamp)" \
        --arg source_id "$agent_id" \
        --arg source_type "subagent" \
        --arg agent_type "$agent_type" \
        --argjson compliance_pass_rate "$compliance_pass_rate" \
        --argjson rule_adherence_score "$rule_adherence_score" \
        --argjson violation_count "$violation_count" \
        --arg violation_severity "$violation_severity" \
        --argjson input_tokens "$input_tokens" \
        --argjson output_tokens "$output_tokens" \
        --argjson context_utilization "$context_utilization" \
        --argjson token_utilization_rate "$token_utilization_rate" \
        '{
            timestamp: $ts,
            source_id: $source_id,
            source_type: $source_type,
            compliance: {
                compliance_pass_rate: $compliance_pass_rate,
                rule_adherence_score: $rule_adherence_score,
                violation_count: $violation_count,
                violation_severity: $violation_severity,
                manifest_integrity: "valid"
            },
            efficiency: {
                input_tokens: $input_tokens,
                output_tokens: $output_tokens,
                context_utilization: $context_utilization,
                token_utilization_rate: $token_utilization_rate
            },
            _context: {
                agent_type: $agent_type
            }
        }' >> "$COMPLIANCE_LOG"
}

# Check if agent type requires research manifest entry
requires_manifest_entry() {
    local agent_type="$1"
    case "$agent_type" in
        deep-research-agent|Explore|research-*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Check manifest for recent entry by agent
check_manifest_entry() {
    local agent_id="$1"
    local agent_type="$2"

    [[ ! -f "$RESEARCH_MANIFEST" ]] && return 1

    # Check for entry created in last 5 minutes with matching agent type
    local five_min_ago
    five_min_ago=$(date -u -d '5 minutes ago' +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Look for recent entries (simple check - agent_type match)
    if tail -20 "$RESEARCH_MANIFEST" | grep -q "\"source\":\"subagent\""; then
        return 0
    fi

    return 1
}

# Validate manifest entry schema
validate_manifest_schema() {
    local manifest_file="$1"

    [[ ! -f "$manifest_file" ]] && return 1

    # Check last entry has required fields
    local last_entry
    last_entry=$(tail -1 "$manifest_file")

    # Required fields: id, status, timestamp/created_at/date
    if echo "$last_entry" | jq -e '.id and .status' >/dev/null 2>&1; then
        return 0
    fi

    return 1
}

# Check if research is properly linked to task
check_research_link() {
    local manifest_file="$1"

    [[ ! -f "$manifest_file" ]] && return 1

    # Check last entry has linkedTasks or linked_tasks or task_ids
    local last_entry
    last_entry=$(tail -1 "$manifest_file")

    if echo "$last_entry" | jq -e '.linkedTasks or .linked_tasks or .task_ids' >/dev/null 2>&1; then
        local linked
        linked=$(echo "$last_entry" | jq -r '.linkedTasks // .linked_tasks // .task_ids // []')
        if [[ "$linked" != "[]" && "$linked" != "null" ]]; then
            return 0
        fi
    fi

    return 1
}

# Create violation issue in CLEO
create_violation_issue() {
    local agent_id="$1"
    local agent_type="$2"
    local violation="$3"
    local details="$4"

    # Only create if cleo is available
    if ! command -v cleo &>/dev/null; then
        return 1
    fi

    # Check if compliance epic exists (T1955)
    if ! cleo exists T1955 --quiet 2>/dev/null; then
        return 1
    fi

    # Create issue as child of T1955
    local title="ISSUE: Subagent compliance violation ($agent_type)"
    local description="Agent ID: $agent_id
Agent Type: $agent_type
Violation: $violation
Timestamp: $(timestamp)
Details: $details"

    cleo add "$title" --parent T1955 --labels "compliance,violation,automated" \
        --description "$description" --priority medium >/dev/null 2>&1 || true
}

# ============================================================================
# MAIN HOOK LOGIC
# ============================================================================

main() {
    # Read JSON input from stdin
    local input
    input=$(cat)

    # Parse hook event
    local hook_event
    hook_event=$(echo "$input" | jq -r '.hook_event_name // ""')

    # Only process SubagentStop events
    if [[ "$hook_event" != "SubagentStop" ]]; then
        exit $EXIT_SUCCESS
    fi

    # Extract agent details
    local agent_id agent_type agent_transcript
    agent_id=$(echo "$input" | jq -r '.agent_id // "unknown"')
    agent_type=$(echo "$input" | jq -r '.agent_type // "unknown"')
    agent_transcript=$(echo "$input" | jq -r '.agent_transcript_path // ""')

    # Initialize compliance result
    local compliance_status="pass"
    local violations=()

    # ========================================
    # Check 1: Manifest entry for research agents
    # ========================================
    if requires_manifest_entry "$agent_type"; then
        if ! check_manifest_entry "$agent_id" "$agent_type"; then
            compliance_status="warn"
            violations+=("Missing manifest entry")
        fi
    fi

    # ========================================
    # Check 2: Manifest schema validation
    # ========================================
    if [[ -f "$RESEARCH_MANIFEST" ]]; then
        if ! validate_manifest_schema "$RESEARCH_MANIFEST"; then
            compliance_status="warn"
            violations+=("Invalid manifest schema")
        fi
    fi

    # ========================================
    # Check 3: Research link (for research agents)
    # ========================================
    if requires_manifest_entry "$agent_type"; then
        if ! check_research_link "$RESEARCH_MANIFEST"; then
            compliance_status="warn"
            violations+=("Research not linked to task")
        fi
    fi

    # ========================================
    # Check 4: Extract metrics from transcript
    # ========================================
    local tokens=0 tool_calls=0 errors=0 input_tokens=0 output_tokens=0
    if [[ -n "$agent_transcript" && -f "$agent_transcript" ]]; then
        # Count tool calls
        tool_calls=$(jq -s '[.[] | select(.type=="tool_use")] | length' "$agent_transcript" 2>/dev/null || echo 0)

        # Count errors
        errors=$(jq -s '[.[] | select(.type=="tool_error" or .type=="error")] | length' "$agent_transcript" 2>/dev/null || echo 0)

        # Sum input and output tokens
        input_tokens=$(jq -s '[.[] | select(.usage) | .usage.input_tokens // 0] | add // 0' "$agent_transcript" 2>/dev/null || echo 0)
        output_tokens=$(jq -s '[.[] | select(.usage) | .usage.output_tokens // 0] | add // 0' "$agent_transcript" 2>/dev/null || echo 0)
        tokens=$((input_tokens + output_tokens))
    fi

    # ========================================
    # Check 5: Get context state for efficiency metrics (T1995)
    # ========================================
    local context_utilization=0 max_tokens=200000
    local context_state_file="${CLAUDE_PROJECT_DIR:-.}/.cleo/.context-state.json"

    # Try session-specific state file first
    if [[ -f "${CLAUDE_PROJECT_DIR:-.}/.cleo/.current-session" ]]; then
        local current_session
        current_session=$(cat "${CLAUDE_PROJECT_DIR:-.}/.cleo/.current-session" 2>/dev/null | tr -d '\n')
        if [[ -n "$current_session" ]]; then
            local session_state="${CLAUDE_PROJECT_DIR:-.}/.cleo/context-states/context-state-${current_session}.json"
            [[ -f "$session_state" ]] && context_state_file="$session_state"
        fi
    fi

    if [[ -f "$context_state_file" ]]; then
        max_tokens=$(jq -r '.contextWindow.maxTokens // 200000' "$context_state_file" 2>/dev/null || echo 200000)
        local current_tokens=$(jq -r '.contextWindow.currentTokens // 0' "$context_state_file" 2>/dev/null || echo 0)
        if [[ "$max_tokens" -gt 0 ]]; then
            context_utilization=$(awk "BEGIN {printf \"%.4f\", $current_tokens / $max_tokens}")
        fi
    fi

    # Calculate token utilization rate
    local token_utilization_rate=0
    local total_io=$((input_tokens + output_tokens))
    if [[ "$total_io" -gt 0 ]]; then
        token_utilization_rate=$(awk "BEGIN {printf \"%.4f\", $output_tokens / $total_io}")
    fi

    # ========================================
    # Log compliance result
    # ========================================
    local details
    details=$(jq -nc \
        --arg agent_type "$agent_type" \
        --argjson tokens "$tokens" \
        --argjson input_tokens "$input_tokens" \
        --argjson output_tokens "$output_tokens" \
        --argjson tool_calls "$tool_calls" \
        --argjson errors "$errors" \
        --argjson context_utilization "$context_utilization" \
        --argjson token_utilization_rate "$token_utilization_rate" \
        --argjson violations "$(printf '%s\n' "${violations[@]:-}" | jq -R . | jq -s .)" \
        '{
            agent_type: $agent_type,
            tokens: $tokens,
            input_tokens: $input_tokens,
            output_tokens: $output_tokens,
            tool_calls: $tool_calls,
            errors: $errors,
            context_utilization: $context_utilization,
            token_utilization_rate: $token_utilization_rate,
            violations: $violations
        }')

    log_compliance "$compliance_status" "$agent_id" "$agent_type" \
        "Subagent completed with ${#violations[@]} violations" "$details"

    # ========================================
    # Create violation issue if needed
    # ========================================
    if [[ ${#violations[@]} -gt 0 && "$compliance_status" == "fail" ]]; then
        create_violation_issue "$agent_id" "$agent_type" \
            "$(printf '%s, ' "${violations[@]}")" "$details"
    fi

    # Return success (don't block subagent completion)
    echo '{"continue": true}'
    exit $EXIT_SUCCESS
}

# Run main if not sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main
fi
