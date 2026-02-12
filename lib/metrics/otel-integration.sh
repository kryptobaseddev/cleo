#!/usr/bin/env bash
# otel-integration.sh - OpenTelemetry Integration for Claude Code Metrics
#
# LAYER: 2 (Services - depends on Layer 1)
# DEPENDENCIES: exit-codes.sh
# PROVIDES:
#   setup_otel_capture        - Configure Claude Code for telemetry capture
#   parse_token_metrics       - Parse OTel token usage data
#   get_session_tokens        - Get aggregated token counts
#   get_api_request_tokens    - Get per-request token data
#   compare_sessions          - Compare token usage between sessions
#
# Claude Code tracks actual token usage via OpenTelemetry:
#   - claude_code.token.usage: Aggregated token counts
#   - claude_code.api_request: Per-request input/output tokens
#
# This library captures and parses that data for CLEO metrics.
#
# @task T2833
# @epic T2724
# @why Need ACTUAL token data, not estimates, to prove CLEO value
# @what OTel integration to capture real Claude Code token metrics

#=== SOURCE GUARD ================================================
[[ -n "${_OTEL_INTEGRATION_LOADED:-}" ]] && return 0
declare -r _OTEL_INTEGRATION_LOADED=1

set -euo pipefail

# Determine library directory
_OI_LIB_DIR="${BASH_SOURCE[0]%/*}/.."
[[ "$_OI_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _OI_LIB_DIR="."

# Source dependencies
# shellcheck source=lib/core/exit-codes.sh
source "${_OI_LIB_DIR}/core/exit-codes.sh"

# Metrics directories
_OI_OTEL_DIR="${OTEL_METRICS_DIR:-.cleo/metrics/otel}"
_OI_TOKEN_METRICS="${_OI_OTEL_DIR}/token_metrics.jsonl"

# ============================================================================
# INTERNAL HELPERS
# ============================================================================

_oi_debug() {
    [[ -n "${OTEL_INTEGRATION_DEBUG:-}" ]] && echo "[otel-integration] DEBUG: $1" >&2
    return 0
}

_oi_error() {
    echo "[otel-integration] ERROR: $1" >&2
}

_oi_ensure_dirs() {
    mkdir -p "$_OI_OTEL_DIR" 2>/dev/null || true
}

# ============================================================================
# SETUP FUNCTIONS
# ============================================================================

# setup_otel_capture - Configure environment for OTel capture
# Args: $1 = mode (console|file|prometheus)
# Returns: Environment variable export commands
# Usage: eval "$(setup_otel_capture file)"
setup_otel_capture() {
    local mode="${1:-file}"

    _oi_ensure_dirs

    case "$mode" in
        console)
            cat << 'EOF'
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=console
export OTEL_METRIC_EXPORT_INTERVAL=5000
EOF
            ;;
        file)
            cat << EOF
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=file://${_OI_OTEL_DIR}/
EOF
            ;;
        prometheus)
            cat << 'EOF'
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=prometheus
# Metrics available at localhost:9464/metrics
EOF
            ;;
        *)
            _oi_error "Unknown mode: $mode. Use console, file, or prometheus."
            return 1
            ;;
    esac
}

# is_otel_enabled - Check if OTel telemetry is enabled
# Returns: 0 if enabled, 1 if not
is_otel_enabled() {
    [[ "${CLAUDE_CODE_ENABLE_TELEMETRY:-}" == "1" ]]
}

# ============================================================================
# PARSING FUNCTIONS
# ============================================================================

# parse_token_metrics - Parse OTel token metrics from collected data
# Args: $1 = optional: specific file to parse (default: latest in otel dir)
# Returns: JSON lines with token type and count
parse_token_metrics() {
    local input_file="${1:-}"

    # Find input file if not specified
    if [[ -z "$input_file" ]]; then
        input_file=$(find "$_OI_OTEL_DIR" -name "*.json" -type f 2>/dev/null | \
                     xargs ls -t 2>/dev/null | head -1)
    fi

    if [[ -z "$input_file" || ! -f "$input_file" ]]; then
        _oi_debug "No OTel metrics file found"
        echo '{"error":"No metrics file found"}'
        return 1
    fi

    _oi_debug "Parsing metrics from: $input_file"

    # Parse OTel format - handle different export formats
    if jq -e '.resourceMetrics' "$input_file" >/dev/null 2>&1; then
        # Standard OTel JSON format
        jq -c '
            .resourceMetrics[]?.scopeMetrics[]?.metrics[]? |
            select(.name == "claude_code.token.usage") |
            .sum.dataPoints[]? |
            {
                timestamp: .timeUnixNano,
                type: (.attributes[]? | select(.key == "type") | .value.stringValue),
                model: (.attributes[]? | select(.key == "model") | .value.stringValue),
                tokens: (.asInt // .asDouble | floor)
            }
        ' "$input_file" 2>/dev/null
    elif jq -e '.name' "$input_file" >/dev/null 2>&1; then
        # Simple metrics format
        jq -c '
            select(.name == "claude_code.token.usage") |
            .dataPoints[]? |
            {
                timestamp: .timeUnixNano,
                type: (.attributes.type // "unknown"),
                model: (.attributes.model // "unknown"),
                tokens: (.value // 0)
            }
        ' "$input_file" 2>/dev/null
    else
        _oi_debug "Unknown metrics format"
        echo '{"error":"Unknown metrics format"}'
        return 1
    fi
}

# parse_api_requests - Parse API request events for detailed token data
# Args: $1 = optional: specific file to parse
# Returns: JSON lines with per-request token data
parse_api_requests() {
    local input_file="${1:-}"

    if [[ -z "$input_file" ]]; then
        input_file=$(find "$_OI_OTEL_DIR" -name "*.json" -type f 2>/dev/null | \
                     xargs ls -t 2>/dev/null | head -1)
    fi

    if [[ -z "$input_file" || ! -f "$input_file" ]]; then
        echo '{"error":"No metrics file found"}'
        return 1
    fi

    # Parse API request events
    jq -c '
        .resourceLogs[]?.scopeLogs[]?.logRecords[]? |
        select(.body.stringValue | contains("api_request")) |
        {
            timestamp: .timeUnixNano,
            input_tokens: .attributes.input_tokens,
            output_tokens: .attributes.output_tokens,
            cache_read_tokens: .attributes.cache_read_tokens,
            cache_creation_tokens: .attributes.cache_creation_tokens,
            model: .attributes.model
        }
    ' "$input_file" 2>/dev/null
}

# ============================================================================
# AGGREGATION FUNCTIONS
# ============================================================================

# get_session_tokens - Get aggregated token counts from OTel data
# Args: $1 = optional: session_id to filter by
# Returns: JSON with aggregated token counts
get_session_tokens() {
    local session_id="${1:-}"

    local input=0 output=0 cache_read=0 cache_create=0 total_requests=0

    # Parse all token metrics
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        [[ "$line" == *"error"* ]] && continue

        local type tokens
        type=$(echo "$line" | jq -r '.type // "unknown"')
        tokens=$(echo "$line" | jq -r '.tokens // 0')

        case "$type" in
            input) input=$((input + tokens)) ;;
            output) output=$((output + tokens)) ;;
            cacheRead) cache_read=$((cache_read + tokens)) ;;
            cacheCreation) cache_create=$((cache_create + tokens)) ;;
        esac
    done < <(parse_token_metrics 2>/dev/null)

    # Count API requests
    total_requests=$(parse_api_requests 2>/dev/null | wc -l || echo 0)

    jq -nc \
        --arg session_id "$session_id" \
        --argjson input "$input" \
        --argjson output "$output" \
        --argjson cache_read "$cache_read" \
        --argjson cache_create "$cache_create" \
        --argjson requests "$total_requests" \
        '{
            session_id: (if $session_id == "" then null else $session_id end),
            tokens: {
                input: $input,
                output: $output,
                cache_read: $cache_read,
                cache_creation: $cache_create,
                total: ($input + $output),
                effective: ($input + $output - $cache_read)
            },
            api_requests: $requests,
            source: "otel"
        }'
}

# ============================================================================
# COMPARISON FUNCTIONS
# ============================================================================

# record_session_start - Record token counts at session start
# Args: $1 = session_id
# Returns: Snapshot JSON
record_session_start() {
    local session_id="$1"

    _oi_ensure_dirs

    local snapshot
    snapshot=$(get_session_tokens "$session_id")

    # Add timestamp and save
    local entry
    entry=$(echo "$snapshot" | jq -c \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg event "session_start" \
        '. + {timestamp: $ts, event: $event}')

    echo "$entry" >> "$_OI_TOKEN_METRICS"
    echo "$entry"
}

# record_session_end - Record token counts at session end
# Args: $1 = session_id
# Returns: Session summary with delta
record_session_end() {
    local session_id="$1"

    _oi_ensure_dirs

    # Get current counts
    local current
    current=$(get_session_tokens "$session_id")

    # Find session start
    local start_data
    start_data=$(grep "\"session_id\":\"$session_id\"" "$_OI_TOKEN_METRICS" 2>/dev/null | \
                 grep "session_start" | tail -1)

    local delta_input=0 delta_output=0 delta_total=0

    if [[ -n "$start_data" ]]; then
        local start_input start_output
        start_input=$(echo "$start_data" | jq -r '.tokens.input // 0')
        start_output=$(echo "$start_data" | jq -r '.tokens.output // 0')

        local current_input current_output
        current_input=$(echo "$current" | jq -r '.tokens.input // 0')
        current_output=$(echo "$current" | jq -r '.tokens.output // 0')

        delta_input=$((current_input - start_input))
        delta_output=$((current_output - start_output))
        delta_total=$((delta_input + delta_output))
    fi

    # Build summary
    local summary
    summary=$(jq -nc \
        --arg session_id "$session_id" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson delta_input "$delta_input" \
        --argjson delta_output "$delta_output" \
        --argjson delta_total "$delta_total" \
        --argjson current "$current" \
        '{
            session_id: $session_id,
            timestamp: $ts,
            event: "session_end",
            session_tokens: {
                input: $delta_input,
                output: $delta_output,
                total: $delta_total
            },
            cumulative: $current.tokens
        }')

    echo "$summary" >> "$_OI_TOKEN_METRICS"
    echo "$summary"
}

# compare_sessions - Compare token usage between two sessions
# Args: $1 = session_id_a (e.g., "with_subagents")
#       $2 = session_id_b (e.g., "direct_implementation")
# Returns: Comparison JSON
compare_sessions() {
    local session_a="$1"
    local session_b="$2"

    # Get end data for both sessions
    local a_data b_data
    a_data=$(grep "\"session_id\":\"$session_a\"" "$_OI_TOKEN_METRICS" 2>/dev/null | \
             grep "session_end" | tail -1)
    b_data=$(grep "\"session_id\":\"$session_b\"" "$_OI_TOKEN_METRICS" 2>/dev/null | \
             grep "session_end" | tail -1)

    if [[ -z "$a_data" || -z "$b_data" ]]; then
        echo '{"error":"One or both sessions not found"}'
        return 1
    fi

    local a_total b_total
    a_total=$(echo "$a_data" | jq -r '.session_tokens.total // 0')
    b_total=$(echo "$b_data" | jq -r '.session_tokens.total // 0')

    local difference savings_percent
    difference=$((b_total - a_total))

    if [[ $b_total -gt 0 ]]; then
        savings_percent=$(( (difference * 100) / b_total ))
    else
        savings_percent=0
    fi

    jq -nc \
        --arg session_a "$session_a" \
        --arg session_b "$session_b" \
        --argjson a_total "$a_total" \
        --argjson b_total "$b_total" \
        --argjson difference "$difference" \
        --argjson savings "$savings_percent" \
        '{
            comparison: {
                session_a: {
                    id: $session_a,
                    total_tokens: $a_total
                },
                session_b: {
                    id: $session_b,
                    total_tokens: $b_total
                }
            },
            difference: $difference,
            savings_percent: $savings,
            winner: (if $a_total < $b_total then $session_a else $session_b end),
            verdict: (
                if $savings >= 50 then "Significant savings"
                elif $savings >= 20 then "Moderate savings"
                elif $savings >= 0 then "Minimal difference"
                else "Session A used more tokens"
                end
            )
        }'
}

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

# get_token_stats - Get statistics about token usage
# Returns: Statistics JSON
get_token_stats() {
    if [[ ! -f "$_OI_TOKEN_METRICS" ]]; then
        echo '{"error":"No token metrics recorded"}'
        return 0
    fi

    local total_sessions avg_tokens min_tokens max_tokens

    # Calculate stats from session_end events
    total_sessions=$(grep "session_end" "$_OI_TOKEN_METRICS" | wc -l)

    if [[ $total_sessions -eq 0 ]]; then
        echo '{"sessions":0,"avg_tokens":0,"min_tokens":0,"max_tokens":0}'
        return 0
    fi

    local sum=0 min=999999999 max=0
    while IFS= read -r line; do
        local tokens
        tokens=$(echo "$line" | jq -r '.session_tokens.total // 0')
        sum=$((sum + tokens))
        [[ $tokens -lt $min ]] && min=$tokens
        [[ $tokens -gt $max ]] && max=$tokens
    done < <(grep "session_end" "$_OI_TOKEN_METRICS")

    avg_tokens=$((sum / total_sessions))

    jq -nc \
        --argjson sessions "$total_sessions" \
        --argjson avg "$avg_tokens" \
        --argjson min "$min" \
        --argjson max "$max" \
        --argjson total "$sum" \
        '{
            sessions_tracked: $sessions,
            total_tokens_all_sessions: $total,
            avg_tokens_per_session: $avg,
            min_tokens_session: $min,
            max_tokens_session: $max
        }'
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f setup_otel_capture
export -f is_otel_enabled
export -f parse_token_metrics
export -f parse_api_requests
export -f get_session_tokens
export -f record_session_start
export -f record_session_end
export -f compare_sessions
export -f get_token_stats
