#!/usr/bin/env bash
###CLEO
# command: otel
# category: read
# synopsis: Token metrics tracking - view status, summary, and manage tracking data
# relevance: medium
# exits: 0,1
# json-output: true
###END
# Token Metrics Tracking for CLEO
# Usage: cleo otel <on|off|status|summary>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SCRIPT_DIR/lib/core/logging.sh" 2>/dev/null || true
source "$SCRIPT_DIR/lib/metrics/token-estimation.sh" 2>/dev/null || true

# Find project root (where .cleo/config.json exists)
find_project_root() {
    local dir="$PWD"
    while [[ "$dir" != "/" ]]; do
        if [[ -f "$dir/.cleo/config.json" ]]; then
            echo "$dir"
            return 0
        fi
        dir="$(dirname "$dir")"
    done
    echo "$PWD"
}

PROJECT_ROOT="$(find_project_root)"
METRICS_DIR="$PROJECT_ROOT/.cleo/metrics"
TOKEN_FILE="$METRICS_DIR/TOKEN_USAGE.jsonl"

show_usage() {
    cat << 'EOF'
Usage: cleo otel <command> [options]

Commands:
  status             Show token tracking status and recent activity
  summary            Show combined token usage summary (sessions + spawns)
  sessions [opts]    Show session-level token data
  spawns [opts]      Show spawn-level token data
  real [opts]        Show REAL token usage from Claude Code API (T2949)
  clear              Clear token tracking data (with backup)

Options:
  --session <id>     Filter by session ID
  --task <id>        Filter by task ID
  --epic <id>        Filter by epic ID
  --format json      Output as JSON (default: table)
  --since <ISO>      Filter events since timestamp (for real command)

Examples:
  cleo otel status                    # Check tracking status
  cleo otel summary                   # View combined overview
  cleo otel sessions                  # Show all sessions
  cleo otel sessions --session session_20260131_234218_189265
  cleo otel spawns --task T2906       # Show spawns for specific task
  cleo otel spawns --format json      # JSON output
  cleo otel real                      # Show real API token usage
  cleo otel real --session <id>       # Real tokens for specific session
  cleo otel real --since 2026-01-31T00:00:00Z  # Real tokens since timestamp
  cleo otel clear                     # Reset tracking data
EOF
}

otel_status() {
    local token_file="$TOKEN_FILE"
    local event_count=0
    local total_tokens=0
    local manifest_tokens=0
    local full_file_tokens=0

    if [[ -f "$token_file" ]]; then
        event_count=$(wc -l < "$token_file" 2>/dev/null || echo 0)

        # Sum tokens by type
        if [[ $event_count -gt 0 ]]; then
            total_tokens=$(jq -s 'map(.estimated_tokens // 0) | add' "$token_file" 2>/dev/null || echo 0)
            manifest_tokens=$(jq -s 'map(select(.event_type == "manifest_read" or .event_type == "manifest_query") | .estimated_tokens // 0) | add // 0' "$token_file" 2>/dev/null || echo 0)
            full_file_tokens=$(jq -s 'map(select(.event_type == "full_file_read") | .estimated_tokens // 0) | add // 0' "$token_file" 2>/dev/null || echo 0)
        fi
    fi

    cat << EOF
{
  "success": true,
  "tracking": {
    "file": "$token_file",
    "events": $event_count,
    "total_tokens": $total_tokens
  },
  "breakdown": {
    "manifest_reads": $manifest_tokens,
    "full_file_reads": $full_file_tokens,
    "other": $((total_tokens - manifest_tokens - full_file_tokens))
  }
}
EOF
}

otel_sessions() {
    local token_file="$TOKEN_FILE"
    local session_filter=""
    local task_filter=""
    local format="table"

    # Parse options
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --session) session_filter="$2"; shift 2 ;;
            --task) task_filter="$2"; shift 2 ;;
            --format) format="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    if [[ ! -f "$token_file" ]] || [[ ! -s "$token_file" ]]; then
        echo '{"success":true,"message":"No session data yet","sessions":[]}'
        return 0
    fi

    # Build jq filter
    local jq_filter='select(.event_type == "session_start")'
    [[ -n "$session_filter" ]] && jq_filter="$jq_filter | select(.context.session_id == \"$session_filter\")"
    [[ -n "$task_filter" ]] && jq_filter="$jq_filter | select(.task_id == \"$task_filter\")"

    # Get session data
    local sessions
    sessions=$(jq -s "map($jq_filter) | sort_by(.timestamp) | reverse" "$token_file" 2>/dev/null)

    if [[ "$format" == "json" ]]; then
        echo "$sessions" | jq '{success: true, sessions: .}'
    else
        # Table format
        echo "SESSION DATA"
        echo "============"
        echo ""
        printf "%-30s %-10s %-15s %12s\n" "SESSION_ID" "TASK" "TIMESTAMP" "TOKENS"
        echo "$(printf '%0.s-' {1..75})"
        echo "$sessions" | jq -r '.[] | [.context.session_id, .task_id, .timestamp, .estimated_tokens] | @tsv' | \
            while IFS=$'\t' read -r sid tid ts tok; do
                printf "%-30s %-10s %-15s %12s\n" "$sid" "$tid" "${ts:0:16}" "$tok"
            done
        echo ""
        echo "Total sessions: $(echo "$sessions" | jq 'length')"
        echo "Total tokens: $(echo "$sessions" | jq 'map(.estimated_tokens // 0) | add // 0')"
    fi
}

otel_spawns() {
    local token_file="$TOKEN_FILE"
    local task_filter=""
    local epic_filter=""
    local format="table"

    # Parse options
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --task) task_filter="$2"; shift 2 ;;
            --epic) epic_filter="$2"; shift 2 ;;
            --format) format="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    if [[ ! -f "$token_file" ]] || [[ ! -s "$token_file" ]]; then
        echo '{"success":true,"message":"No spawn data yet","spawns":[]}'
        return 0
    fi

    # Build jq filter for spawn-related events (skill_inject, manifest reads, etc.)
    local jq_filter='select(.event_type != "session_start")'
    [[ -n "$task_filter" ]] && jq_filter="$jq_filter | select(.task_id == \"$task_filter\")"

    # Get spawn data
    local spawns
    spawns=$(jq -s "map($jq_filter) | sort_by(.timestamp) | reverse" "$token_file" 2>/dev/null)

    if [[ "$format" == "json" ]]; then
        echo "$spawns" | jq '{success: true, spawns: .}'
    else
        # Table format
        echo "SPAWN DATA"
        echo "=========="
        echo ""
        printf "%-20s %-10s %-15s %-40s %12s\n" "EVENT_TYPE" "TASK" "TIMESTAMP" "SOURCE" "TOKENS"
        echo "$(printf '%0.s-' {1..105})"
        echo "$spawns" | jq -r '.[] | [.event_type, .task_id, .timestamp, .source, .estimated_tokens] | @tsv' | \
            while IFS=$'\t' read -r evt tid ts src tok; do
                # Truncate source path
                src_short="${src##*/}"
                [[ ${#src_short} -gt 38 ]] && src_short="${src_short:0:35}..."
                printf "%-20s %-10s %-15s %-40s %12s\n" "$evt" "$tid" "${ts:0:16}" "$src_short" "$tok"
            done
        echo ""
        echo "Total spawn events: $(echo "$spawns" | jq 'length')"
        echo "Total tokens: $(echo "$spawns" | jq 'map(.estimated_tokens // 0) | add // 0')"
        echo ""
        # Breakdown by event type
        echo "By event type:"
        echo "$spawns" | jq -r 'group_by(.event_type) | map({type: .[0].event_type, count: length, tokens: (map(.estimated_tokens // 0) | add)}) | .[] | "  \(.type): \(.count) events, \(.tokens) tokens"'
    fi
}

otel_summary() {
    local token_file="$TOKEN_FILE"

    if [[ ! -f "$token_file" ]] || [[ ! -s "$token_file" ]]; then
        echo '{"success":true,"message":"No token tracking data yet","events":0}'
        return 0
    fi

    # Calculate summary stats with session/spawn breakdown
    local stats
    stats=$(jq -s '
        {
            total_events: length,
            total_tokens: (map(.estimated_tokens // 0) | add),
            sessions: {
                count: (map(select(.event_type == "session_start")) | length),
                tokens: (map(select(.event_type == "session_start") | .estimated_tokens // 0) | add // 0)
            },
            spawns: {
                count: (map(select(.event_type != "session_start")) | length),
                tokens: (map(select(.event_type != "session_start") | .estimated_tokens // 0) | add // 0)
            },
            by_type: (group_by(.event_type) | map({
                type: .[0].event_type,
                count: length,
                tokens: (map(.estimated_tokens // 0) | add)
            })),
            recent: (sort_by(.timestamp) | reverse | .[0:5] | map({
                event: .event_type,
                tokens: .estimated_tokens,
                source: (.source | split("/") | last),
                task: .task_id
            }))
        }
    ' "$token_file" 2>/dev/null)

    echo "$stats" | jq --arg file "$token_file" '. + {success: true, file: $file}'
}

otel_clear() {
    local token_file="$TOKEN_FILE"

    if [[ -f "$token_file" ]]; then
        # Backup before clearing
        local backup="${token_file}.backup-$(date +%Y%m%d-%H%M%S)"
        cp "$token_file" "$backup"
        > "$token_file"
        echo "{\"success\":true,\"message\":\"Token tracking cleared\",\"backup\":\"$backup\"}"
    else
        echo '{"success":true,"message":"No token file to clear"}'
    fi
}

otel_real() {
    local session_filter=""
    local since_filter=""
    local format="table"

    # Parse options
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --session) session_filter="$2"; shift 2 ;;
            --since) since_filter="$2"; shift 2 ;;
            --format) format="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    # Call the token estimation library function
    local real_data
    real_data=$(get_real_token_usage "$session_filter" "$since_filter")

    if [[ "$format" == "json" ]]; then
        echo "$real_data" | jq '. + {success: true}'
    else
        # Table format
        echo "REAL TOKEN USAGE (from Claude Code API)"
        echo "========================================"
        echo ""

        local error
        error=$(echo "$real_data" | jq -r '.error // empty')
        if [[ -n "$error" ]]; then
            echo "Error: $error"
            return 1
        fi

        local input output cache_read cache_creation total messages project_dir
        input=$(echo "$real_data" | jq -r '.input_tokens')
        output=$(echo "$real_data" | jq -r '.output_tokens')
        cache_read=$(echo "$real_data" | jq -r '.cache_read_tokens')
        cache_creation=$(echo "$real_data" | jq -r '.cache_creation_tokens')
        total=$(echo "$real_data" | jq -r '.total')
        messages=$(echo "$real_data" | jq -r '.messages')
        project_dir=$(echo "$real_data" | jq -r '.project_dir')

        printf "%-30s %15s\n" "Metric" "Tokens"
        echo "$(printf '%0.s-' {1..47})"
        printf "%-30s %15s\n" "Input tokens" "$input"
        printf "%-30s %15s\n" "Output tokens" "$output"
        printf "%-30s %15s\n" "Cache read tokens" "$cache_read"
        printf "%-30s %15s\n" "Cache creation tokens" "$cache_creation"
        echo "$(printf '%0.s-' {1..47})"
        printf "%-30s %15s\n" "Total" "$total"
        echo ""
        printf "Messages processed: %s\n" "$messages"
        printf "Project directory: %s\n" "$project_dir"

        # Compare with estimated data if available
        if [[ -f "$TOKEN_FILE" ]] && [[ -s "$TOKEN_FILE" ]]; then
            echo ""
            echo "COMPARISON: Real vs Estimated"
            echo "=============================="
            echo ""

            local estimated_total
            estimated_total=$(jq -s 'map(.estimated_tokens // 0) | add // 0' "$TOKEN_FILE" 2>/dev/null || echo 0)

            printf "%-30s %15s\n" "Real total (API)" "$total"
            printf "%-30s %15s\n" "Estimated total (CLEO)" "$estimated_total"

            if [[ $total -gt 0 ]]; then
                local accuracy
                accuracy=$(( (estimated_total * 100) / total ))
                printf "%-30s %14s%%\n" "Estimation accuracy" "$accuracy"

                if [[ $accuracy -lt 50 ]]; then
                    echo ""
                    echo "⚠ Estimation is significantly lower than real usage"
                    echo "This is expected - estimates don't include system prompts, tool calls, etc."
                elif [[ $accuracy -gt 150 ]]; then
                    echo ""
                    echo "⚠ Estimation is significantly higher than real usage"
                    echo "This may indicate inefficiencies in the estimation model"
                fi
            fi
        fi

        echo ""
    fi
}

case "${1:-}" in
    status)  otel_status ;;
    summary) otel_summary ;;
    sessions) shift; otel_sessions "$@" ;;
    spawns)  shift; otel_spawns "$@" ;;
    real)    shift; otel_real "$@" ;;
    clear)   otel_clear ;;
    -h|--help|"") show_usage ;;
    *)       echo '{"success":false,"error":"Unknown command: '"$1"'"}'; exit 1 ;;
esac
