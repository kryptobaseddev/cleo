#!/usr/bin/env bash
# Token Metrics Tracking for CLEO
# Usage: cleo otel <on|off|status|summary>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SCRIPT_DIR/lib/logging.sh" 2>/dev/null || true

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
Usage: cleo otel <command>

Commands:
  status   Show token tracking status and recent activity
  summary  Show token usage summary (savings, totals)
  clear    Clear token tracking data (with backup)

Examples:
  cleo otel status   # Check tracking status
  cleo otel summary  # View token savings
  cleo otel clear    # Reset tracking data
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

otel_summary() {
    local token_file="$TOKEN_FILE"

    if [[ ! -f "$token_file" ]] || [[ ! -s "$token_file" ]]; then
        echo '{"success":true,"message":"No token tracking data yet","events":0}'
        return 0
    fi

    # Calculate summary stats
    local stats
    stats=$(jq -s '
        {
            total_events: length,
            total_tokens: (map(.estimated_tokens // 0) | add),
            by_type: (group_by(.event_type) | map({
                type: .[0].event_type,
                count: length,
                tokens: (map(.estimated_tokens // 0) | add)
            })),
            recent: (sort_by(.timestamp) | reverse | .[0:5] | map({
                event: .event_type,
                tokens: .estimated_tokens,
                source: (.source | split("/") | last)
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

case "${1:-}" in
    status)  otel_status ;;
    summary) otel_summary ;;
    clear)   otel_clear ;;
    -h|--help|"") show_usage ;;
    *)       echo '{"success":false,"error":"Unknown command: '"$1"'"}'; exit 1 ;;
esac
