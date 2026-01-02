#!/usr/bin/env bash
# CLEO Context Monitor - Status Line Integration
# Reads Claude Code context window JSON and writes state for CLEO commands
#
# USAGE: Configure in ~/.claude/settings.json:
#   { "statusLine": { "type": "command", "command": "~/.cleo/bin/cleo-statusline" } }
#
# INPUT: JSON via stdin with context_window object
# OUTPUT: Compact status line string for display

set -euo pipefail

# Source guard pattern
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    # Script is being executed directly
    :
fi

# Find CLEO project directory
find_cleo_dir() {
    local dir="$PWD"
    while [[ "$dir" != "/" ]]; do
        if [[ -d "$dir/.cleo" ]]; then
            echo "$dir/.cleo"
            return 0
        fi
        dir="$(dirname "$dir")"
    done
    echo ""
}

CLEO_DIR="${CLEO_PROJECT_DIR:-$(find_cleo_dir)}"
STATE_FILE="${CLEO_DIR:-.cleo}/.context-state.json"

# Read JSON from stdin
input=$(cat)

# Extract context window data
CONTEXT_SIZE=$(echo "$input" | jq -r '.context_window.context_window_size // 200000')
CURRENT_USAGE=$(echo "$input" | jq -r '.context_window.current_usage // {}')

if [[ "$CURRENT_USAGE" != "{}" && "$CURRENT_USAGE" != "null" ]]; then
    INPUT_TOKENS=$(echo "$CURRENT_USAGE" | jq -r '.input_tokens // 0')
    OUTPUT_TOKENS=$(echo "$CURRENT_USAGE" | jq -r '.output_tokens // 0')
    CACHE_CREATE=$(echo "$CURRENT_USAGE" | jq -r '.cache_creation_input_tokens // 0')
    CACHE_READ=$(echo "$CURRENT_USAGE" | jq -r '.cache_read_input_tokens // 0')

    TOTAL_TOKENS=$((INPUT_TOKENS + OUTPUT_TOKENS + CACHE_CREATE))
    PERCENTAGE=$((TOTAL_TOKENS * 100 / CONTEXT_SIZE))

    # Determine status based on thresholds
    if [[ "$PERCENTAGE" -ge 95 ]]; then
        STATUS="emergency"
        ICON="🚨"
    elif [[ "$PERCENTAGE" -ge 90 ]]; then
        STATUS="critical"
        ICON="🔴"
    elif [[ "$PERCENTAGE" -ge 85 ]]; then
        STATUS="caution"
        ICON="🟠"
    elif [[ "$PERCENTAGE" -ge 70 ]]; then
        STATUS="warning"
        ICON="🟡"
    else
        STATUS="ok"
        ICON="🟢"
    fi

    # Write state file if CLEO directory exists
    if [[ -n "$CLEO_DIR" && -d "$CLEO_DIR" ]]; then
        jq -n \
            --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --argjson max "$CONTEXT_SIZE" \
            --argjson current "$TOTAL_TOKENS" \
            --argjson pct "$PERCENTAGE" \
            --argjson input "$INPUT_TOKENS" \
            --argjson output "$OUTPUT_TOKENS" \
            --argjson cache_create "$CACHE_CREATE" \
            --argjson cache_read "$CACHE_READ" \
            --arg status "$STATUS" \
            --arg claude_session "${CLAUDE_SESSION_ID:-}" \
            --arg cleo_session "$(cat "$CLEO_DIR/.current-session" 2>/dev/null || echo '')" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/context-state.schema.json",
                "version": "1.0.0",
                "timestamp": $ts,
                "staleAfterMs": 5000,
                "contextWindow": {
                    "maxTokens": $max,
                    "currentTokens": $current,
                    "percentage": $pct,
                    "breakdown": {
                        "inputTokens": $input,
                        "outputTokens": $output,
                        "cacheCreationTokens": $cache_create,
                        "cacheReadTokens": $cache_read
                    }
                },
                "thresholds": {
                    "warning": 70,
                    "caution": 85,
                    "critical": 90,
                    "emergency": 95
                },
                "status": $status,
                "claudeSessionId": $claude_session,
                "cleoSessionId": $cleo_session
            }' > "$STATE_FILE"
    fi

    # Output status line
    echo "$ICON ${PERCENTAGE}% | ${TOTAL_TOKENS}/${CONTEXT_SIZE}"
else
    echo "📊 --"
fi
