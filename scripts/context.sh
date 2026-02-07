#!/usr/bin/env bash
###CLEO
# command: context
# category: read
# synopsis: Monitor context window usage for agent safeguard system
# relevance: high
# flags: --format,--json,--human,--session
# exits: 0,50,51,52,53,54
# json-output: true
# subcommands: status,check,list,watch
# note: Part of Context Safeguard System - check context limits before operations
###END
# CLEO Context Command
# Monitor context window usage for agent safeguard system
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source libraries
source "$LIB_DIR/exit-codes.sh"
[[ -f "$LIB_DIR/output-format.sh" ]] && source "$LIB_DIR/output-format.sh"
[[ -f "$LIB_DIR/error-json.sh" ]] && source "$LIB_DIR/error-json.sh"

# Source centralized flag parsing
[[ -f "$LIB_DIR/flags.sh" ]] && source "$LIB_DIR/flags.sh"

TODO_DIR="${TODO_DIR:-.cleo}"
COMMAND_NAME="context"

# Determine which state file to use (session-specific or global)
get_state_file() {
    local session_id="${1:-}"

    # If session specified, use that
    if [[ -n "$session_id" ]]; then
        echo "$TODO_DIR/.context-state-${session_id}.json"
        return
    fi

    # Check for current session binding
    if [[ -f "$TODO_DIR/.current-session" ]]; then
        local current_session=$(cat "$TODO_DIR/.current-session" 2>/dev/null | tr -d '\n')
        if [[ -n "$current_session" ]] && [[ -f "$TODO_DIR/.context-state-${current_session}.json" ]]; then
            echo "$TODO_DIR/.context-state-${current_session}.json"
            return
        fi
    fi

    # Fall back to global state file
    echo "$TODO_DIR/.context-state.json"
}

STATE_FILE=""  # Set dynamically based on session

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
  list      List all context state files (multi-session)
  watch     Continuous monitoring mode (planned)

Options:
  --session <id>      Check specific CLEO session (default: current or global)
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

Session Binding:
  With active CLEO session: reads session-specific state file
  Without session: reads global .context-state.json
  Multi-session: each agent has isolated context tracking

Examples:
  cleo context                    # Show status (current session or global)
  cleo context status --json      # JSON output
  cleo context check              # Exit code for scripting
  cleo context list               # List all context state files
  cleo context --session abc123   # Check specific session

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

# List all context state files
list_sessions() {
    local format="$1"
    local files=()
    local data=()

    # Find all context state files
    for f in "$TODO_DIR"/.context-state*.json; do
        [[ -f "$f" ]] || continue
        files+=("$f")
    done

    if [[ ${#files[@]} -eq 0 ]]; then
        if [[ "$format" == "json" ]]; then
            jq -nc '{success: true, sessions: [], message: "No context state files found"}'
        else
            echo "No context state files found"
        fi
        return 0
    fi

    if [[ "$format" == "json" ]]; then
        local sessions="[]"
        for f in "${files[@]}"; do
            local state=$(cat "$f")
            local filename=$(basename "$f")
            local session_id=$(echo "$state" | jq -r '.sessionId // ""')
            sessions=$(echo "$sessions" | jq --arg fn "$filename" --argjson state "$state" '. + [($state + {file: $fn})]')
        done
        # Use --slurpfile with process substitution to avoid ARG_MAX limits
        jq -nc --slurpfile sessions <(echo "$sessions") '{success: true, sessions: $sessions[0]}'
    else
        echo "Context state files:"
        for f in "${files[@]}"; do
            local state=$(cat "$f")
            local filename=$(basename "$f")
            local pct=$(echo "$state" | jq -r '.contextWindow.percentage')
            local status=$(echo "$state" | jq -r '.status')
            local session=$(echo "$state" | jq -r '.sessionId // "global"')
            local ts=$(echo "$state" | jq -r '.timestamp')
            printf "  %-40s %3s%% %-10s %s\n" "$filename" "$pct" "$status" "$ts"
        done
    fi
}

main() {
    local subcommand="status"
    local format=""
    local session_id=""
    local QUIET=false

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            status|check|watch|list)
                subcommand="$1"
                ;;
            --session)
                session_id="$2"
                shift
                ;;
            -q|--quiet)
                QUIET=true
                ;;
            --json)
                format="json"
                ;;
            --human)
                format="human"
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

    # Set state file based on session
    STATE_FILE=$(get_state_file "$session_id")

    # Resolve format with TTY-aware defaults
    format=$(resolve_format "$format")

    case "$subcommand" in
        status)
            show_status "$format"
            ;;
        check)
            do_check
            ;;
        list)
            list_sessions "$format"
            ;;
        watch)
            echo "Watch mode not yet implemented" >&2
            exit 1
            ;;
    esac
}

main "$@"
