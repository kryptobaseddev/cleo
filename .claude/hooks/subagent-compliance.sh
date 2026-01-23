#!/bin/bash
# .claude/hooks/subagent-compliance.sh
# SubagentStop hook for CLEO compliance tracking
# T1993: Automatic compliance checking for subagents
# T1999: Restored full functionality with proper error handling

set -uo pipefail
# Note: NOT using set -e because we need fine-grained error handling

METRICS_DIR="${CLAUDE_PROJECT_DIR:-.}/.cleo/metrics"
COMPLIANCE_LOG="$METRICS_DIR/COMPLIANCE.jsonl"
RESEARCH_MANIFEST="${CLAUDE_PROJECT_DIR:-.}/claudedocs/research-outputs/MANIFEST.jsonl"

EXIT_SUCCESS=0

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

timestamp() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# Check if agent type requires research manifest entry
requires_manifest_entry() {
    local agent_type="$1"
    case "$agent_type" in
        deep-research-agent|Explore|research-*|Plan)
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

    # Check for entry created recently with matching source
    if tail -20 "$RESEARCH_MANIFEST" 2>/dev/null | grep -q '"source":"subagent"'; then
        return 0
    fi

    return 1
}

# Validate manifest entry schema
validate_manifest_schema() {
    local manifest_file="$1"

    [[ ! -f "$manifest_file" ]] && return 1

    local last_entry
    last_entry=$(tail -1 "$manifest_file" 2>/dev/null) || return 1

    # Check required fields exist
    if echo "$last_entry" | jq -e '.id and .status' >/dev/null 2>&1; then
        return 0
    fi

    return 1
}

# Check if research is linked to task
check_research_link() {
    local manifest_file="$1"

    [[ ! -f "$manifest_file" ]] && return 1

    local last_entry
    last_entry=$(tail -1 "$manifest_file" 2>/dev/null) || return 1

    # Check for linked_tasks or task_ids
    if echo "$last_entry" | jq -e '.linkedTasks or .linked_tasks or .task_ids' >/dev/null 2>&1; then
        local linked
        linked=$(echo "$last_entry" | jq -r '.linkedTasks // .linked_tasks // .task_ids // []')
        if [[ "$linked" != "[]" && "$linked" != "null" && -n "$linked" ]]; then
            return 0
        fi
    fi

    return 1
}

# Log compliance in metrics schema format
log_compliance() {
    local status="$1"
    local agent_id="$2"
    local agent_type="$3"
    local violation_count="${4:-0}"
    local input_tokens="${5:-0}"
    local output_tokens="${6:-0}"
    local context_util="${7:-0}"
    local token_util_rate="${8:-0}"

    mkdir -p "$METRICS_DIR"

    local pass_rate adherence severity
    case "$status" in
        pass)
            pass_rate="1.0"
            adherence="1.0"
            severity="none"
            ;;
        warn)
            pass_rate="0.5"
            adherence="0.7"
            severity="medium"
            ;;
        fail)
            pass_rate="0.0"
            adherence="0.3"
            severity="high"
            ;;
        *)
            pass_rate="0.5"
            adherence="0.5"
            severity="low"
            ;;
    esac

    jq -nc \
        --arg ts "$(timestamp)" \
        --arg source_id "$agent_id" \
        --arg source_type "subagent" \
        --arg agent_type "$agent_type" \
        --argjson pass_rate "$pass_rate" \
        --argjson adherence "$adherence" \
        --argjson violation_count "$violation_count" \
        --arg severity "$severity" \
        --argjson input_tokens "$input_tokens" \
        --argjson output_tokens "$output_tokens" \
        --argjson context_util "$context_util" \
        --argjson token_util_rate "$token_util_rate" \
        '{
            timestamp: $ts,
            source_id: $source_id,
            source_type: $source_type,
            compliance: {
                compliance_pass_rate: $pass_rate,
                rule_adherence_score: $adherence,
                violation_count: $violation_count,
                violation_severity: $severity,
                manifest_integrity: "valid"
            },
            efficiency: {
                input_tokens: $input_tokens,
                output_tokens: $output_tokens,
                context_utilization: $context_util,
                token_utilization_rate: $token_util_rate
            },
            _context: { agent_type: $agent_type }
        }' >> "$COMPLIANCE_LOG"
}

# Create violation issue in CLEO (optional - only for critical violations)
create_violation_issue() {
    local agent_id="$1"
    local agent_type="$2"
    local violation="$3"

    # Only create if cleo is available and epic exists
    command -v cleo &>/dev/null || return 0
    cleo exists T1955 --quiet 2>/dev/null || return 0

    local title="ISSUE: Subagent compliance violation ($agent_type)"
    local description="Agent ID: $agent_id
Agent Type: $agent_type
Violation: $violation
Timestamp: $(timestamp)"

    cleo add "$title" --parent T1955 --labels "compliance,violation,automated" \
        --description "$description" --priority medium >/dev/null 2>&1 || true
}

# ============================================================================
# MAIN HOOK LOGIC
# ============================================================================

main() {
    local input
    input=$(cat)

    local hook_event
    hook_event=$(echo "$input" | jq -r '.hook_event_name // ""')

    # Only process SubagentStop events
    if [[ "$hook_event" != "SubagentStop" ]]; then
        echo '{"continue": true}'
        exit $EXIT_SUCCESS
    fi

    # Extract agent details
    local agent_id agent_type agent_transcript
    agent_id=$(echo "$input" | jq -r '.agent_id // "unknown"')
    agent_type=$(echo "$input" | jq -r '.agent_type // "unknown"')
    agent_transcript=$(echo "$input" | jq -r '.agent_transcript_path // ""')

    # Initialize compliance tracking
    local compliance_status="pass"
    local violation_count=0

    # ========================================
    # Check 1: Manifest entry for research agents
    # ========================================
    if requires_manifest_entry "$agent_type"; then
        if ! check_manifest_entry "$agent_id" "$agent_type"; then
            compliance_status="warn"
            ((violation_count++)) || true
        fi
    fi

    # ========================================
    # Check 2: Manifest schema validation
    # ========================================
    if [[ -f "$RESEARCH_MANIFEST" ]]; then
        if ! validate_manifest_schema "$RESEARCH_MANIFEST"; then
            compliance_status="warn"
            ((violation_count++)) || true
        fi
    fi

    # ========================================
    # Check 3: Research link (for research agents)
    # ========================================
    if requires_manifest_entry "$agent_type"; then
        if ! check_research_link "$RESEARCH_MANIFEST"; then
            compliance_status="warn"
            ((violation_count++)) || true
        fi
    fi

    # ========================================
    # Check 4: Extract metrics from transcript
    # ========================================
    local input_tokens=0 output_tokens=0 tool_calls=0 errors=0
    if [[ -n "$agent_transcript" && -f "$agent_transcript" ]]; then
        tool_calls=$(jq -s '[.[] | select(.type=="tool_use")] | length' "$agent_transcript" 2>/dev/null) || tool_calls=0
        errors=$(jq -s '[.[] | select(.type=="tool_error" or .type=="error")] | length' "$agent_transcript" 2>/dev/null) || errors=0
        input_tokens=$(jq -s '[.[] | select(.usage) | .usage.input_tokens // 0] | add // 0' "$agent_transcript" 2>/dev/null) || input_tokens=0
        output_tokens=$(jq -s '[.[] | select(.usage) | .usage.output_tokens // 0] | add // 0' "$agent_transcript" 2>/dev/null) || output_tokens=0
    fi

    # ========================================
    # Check 5: Get context utilization
    # ========================================
    local context_util=0 token_util_rate=0
    local state_file="${CLAUDE_PROJECT_DIR:-.}/.cleo/.context-state.json"

    # Try session-specific state file first
    if [[ -f "${CLAUDE_PROJECT_DIR:-.}/.cleo/.current-session" ]]; then
        local current_session
        current_session=$(cat "${CLAUDE_PROJECT_DIR:-.}/.cleo/.current-session" 2>/dev/null | tr -d '\n') || true
        if [[ -n "$current_session" ]]; then
            local session_state="${CLAUDE_PROJECT_DIR:-.}/.cleo/context-states/context-state-${current_session}.json"
            [[ -f "$session_state" ]] && state_file="$session_state"
        fi
    fi

    if [[ -f "$state_file" ]]; then
        local current max
        current=$(jq -r '.contextWindow.currentTokens // 0' "$state_file" 2>/dev/null) || current=0
        max=$(jq -r '.contextWindow.maxTokens // 200000' "$state_file" 2>/dev/null) || max=200000
        if [[ "$max" -gt 0 ]]; then
            context_util=$(awk "BEGIN {printf \"%.4f\", $current / $max}")
        fi
    fi

    # Calculate token utilization rate
    local total_io=$((input_tokens + output_tokens))
    if [[ "$total_io" -gt 0 ]]; then
        token_util_rate=$(awk "BEGIN {printf \"%.4f\", $output_tokens / $total_io}")
    fi

    # ========================================
    # Log compliance result
    # ========================================
    log_compliance "$compliance_status" "$agent_id" "$agent_type" \
        "$violation_count" "$input_tokens" "$output_tokens" "$context_util" "$token_util_rate"

    # ========================================
    # Create violation issue if critical
    # ========================================
    if [[ "$compliance_status" == "fail" && "$violation_count" -ge 3 ]]; then
        create_violation_issue "$agent_id" "$agent_type" "Multiple compliance violations ($violation_count)"
    fi

    # Return success (don't block subagent completion)
    echo '{"continue": true}'
    exit $EXIT_SUCCESS
}

# Run main if not sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main
fi
