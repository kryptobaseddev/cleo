#!/usr/bin/env bash
# CLEO Context Command
# Monitor context window usage for agent safeguard system
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source libraries
source "$LIB_DIR/exit-codes.sh"
[[ -f "$LIB_DIR/output-format.sh" ]] && source "$LIB_DIR/output-format.sh"
[[ -f "$LIB_DIR/error-json.sh" ]] && source "$LIB_DIR/error-json.sh"

TODO_DIR="${TODO_DIR:-.cleo}"
STATE_FILE="$TODO_DIR/.context-state.json"
COMMAND_NAME="context"

# Exit codes are defined in lib/exit-codes.sh:
# EXIT_CONTEXT_OK (0), EXIT_CONTEXT_WARNING (50), EXIT_CONTEXT_CAUTION (51),
# EXIT_CONTEXT_CRITICAL (52), EXIT_CONTEXT_EMERGENCY (53), EXIT_CONTEXT_STALE (54)

usage() {
    cat << EOF
Usage: cleo context [SUBCOMMAND] [OPTIONS]

Monitor context window usage for agent safeguard system.

Subcommands:
  status    Show current context state (default)
  check     Check threshold, return exit code for scripting
  watch     Continuous monitoring mode (planned)

Options:
  --format <format>   Output format: text (default) or json
  --json              Shortcut for --format json
  --human             Shortcut for --format text
  --help              Show this help message

Exit Codes (for 'check' subcommand):
  0   OK (<70%)
  50  Warning (70-84%)
  51  Caution (85-89%)
  52  Critical (90-94%)
  53  Emergency (95%+)
  54  Stale/no data

Examples:
  cleo context                    # Show status
  cleo context status --json      # JSON output
  cleo context check              # Exit code for scripting

  # Use in agent loop
  if ! cleo context check; then
    cleo safestop --reason "context-limit"
  fi
EOF
}

# Check if state file is stale
is_stale() {
    local timestamp="$1"
    local stale_ms="${2:-5000}"

    local file_time=$(date -d "$timestamp" +%s 2>/dev/null || echo 0)
    local now=$(date +%s)
    local diff_ms=$(( (now - file_time) * 1000 ))

    [[ "$diff_ms" -gt "$stale_ms" ]]
}

# Get status exit code using standard library codes
status_to_exit_code() {
    local status="$1"
    case "$status" in
        ok)        echo "$EXIT_SUCCESS" ;;
        warning)   echo "$EXIT_CONTEXT_WARNING" ;;
        caution)   echo "$EXIT_CONTEXT_CAUTION" ;;
        critical)  echo "$EXIT_CONTEXT_CRITICAL" ;;
        emergency) echo "$EXIT_CONTEXT_EMERGENCY" ;;
        *)         echo "$EXIT_CONTEXT_STALE" ;;
    esac
}

# Main status display
show_status() {
    local format="$1"

    if [[ ! -f "$STATE_FILE" ]]; then
        if [[ "$format" == "json" ]]; then
            jq -nc '{success: false, error: "No context state file", hint: "Ensure status line integration is configured"}'
        else
            echo "No context data available"
            echo "Hint: Configure Claude Code status line with CLEO integration"
        fi
        return "$EXIT_CONTEXT_STALE"
    fi

    local state=$(cat "$STATE_FILE")
    local timestamp=$(echo "$state" | jq -r '.timestamp')
    local stale_ms=$(echo "$state" | jq -r '.staleAfterMs // 5000')
    local percentage=$(echo "$state" | jq -r '.contextWindow.percentage')
    local current=$(echo "$state" | jq -r '.contextWindow.currentTokens')
    local max=$(echo "$state" | jq -r '.contextWindow.maxTokens')
    local status=$(echo "$state" | jq -r '.status')

    # Check staleness
    if is_stale "$timestamp" "$stale_ms"; then
        status="stale"
    fi

    if [[ "$format" == "json" ]]; then
        echo "$state" | jq --arg status "$status" '.status = $status | .success = true'
    else
        local icon
        case "$status" in
            ok)        icon="🟢" ;;
            warning)   icon="🟡" ;;
            caution)   icon="🟠" ;;
            critical)  icon="🔴" ;;
            emergency) icon="🚨" ;;
            stale)     icon="⏰" ;;
            *)         icon="❓" ;;
        esac

        echo "Context: $icon $status"
        echo "Usage: ${percentage}% (${current} / ${max} tokens)"
        echo "Updated: $timestamp"

        if [[ "$status" == "stale" ]]; then
            echo "⚠️  Data is stale - status line may not be running"
        fi
    fi

    return $(status_to_exit_code "$status")
}

# Check subcommand (silent, exit code only)
do_check() {
    if [[ ! -f "$STATE_FILE" ]]; then
        return "$EXIT_CONTEXT_STALE"
    fi

    local state=$(cat "$STATE_FILE")
    local timestamp=$(echo "$state" | jq -r '.timestamp')
    local stale_ms=$(echo "$state" | jq -r '.staleAfterMs // 5000')
    local status=$(echo "$state" | jq -r '.status')

    if is_stale "$timestamp" "$stale_ms"; then
        return "$EXIT_CONTEXT_STALE"
    fi

    return $(status_to_exit_code "$status")
}

main() {
    local subcommand="status"
    local format=""

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            status|check|watch)
                subcommand="$1"
                ;;
            --json)
                format="json"
                ;;
            --human)
                format="text"
                ;;
            --format)
                format="$2"
                shift
                ;;
            --help|-h)
                usage
                exit 0
                ;;
            *)
                echo "Unknown option: $1" >&2
                usage >&2
                exit 2
                ;;
        esac
        shift
    done

    # Resolve format
    if [[ -z "$format" ]]; then
        if [[ -t 1 ]]; then
            format="text"
        else
            format="json"
        fi
    fi

    case "$subcommand" in
        status)
            show_status "$format"
            ;;
        check)
            do_check
            ;;
        watch)
            echo "Watch mode not yet implemented" >&2
            exit 1
            ;;
    esac
}

main "$@"
