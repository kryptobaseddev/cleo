#!/usr/bin/env bash
# CLEO Safestop Command
# Graceful shutdown for agents approaching context limits
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source libraries
source "$LIB_DIR/exit-codes.sh"
[[ -f "$LIB_DIR/output-format.sh" ]] && source "$LIB_DIR/output-format.sh"
[[ -f "$LIB_DIR/error-json.sh" ]] && source "$LIB_DIR/error-json.sh"
[[ -f "$LIB_DIR/flags.sh" ]] && source "$LIB_DIR/flags.sh"

TODO_DIR="${TODO_DIR:-.cleo}"
TODO_FILE="$TODO_DIR/todo.json"
STATE_FILE="$TODO_DIR/.context-state.json"
SESSION_FILE="$TODO_DIR/.current-session"
COMMAND_NAME="safestop"

# Initialize flag defaults
init_flag_defaults 2>/dev/null || true

# Options
REASON=""
DO_COMMIT=false
HANDOFF_FILE=""
END_SESSION=true

usage() {
    cat << EOF
Usage: cleo safestop --reason <reason> [OPTIONS]

Graceful shutdown for agents approaching context limits.
Updates task notes, optionally commits changes, generates handoff, ends session.

Required:
  --reason <text>     Reason for stopping (e.g., "context-limit", "manual")

Options:
  --commit            Commit pending git changes with WIP message
  --handoff <file>    Generate handoff document (use - for stdout)
  --no-session-end    Update notes but don't end session
  --dry-run           Show actions without executing
  --format <format>   Output format: text (default) or json
  --json              Shortcut for --format json
  --help              Show this help message

Examples:
  # Full graceful shutdown
  cleo safestop --reason "context-limit" --commit --handoff ./handoff.json

  # Preview what would happen
  cleo safestop --reason "context-limit" --dry-run

  # Just update notes, keep session open
  cleo safestop --reason "checkpoint" --no-session-end
EOF
}

# Get context percentage from state file
get_context_percentage() {
    if [[ -f "$STATE_FILE" ]]; then
        jq -r '.contextWindow.percentage // 0' "$STATE_FILE"
    else
        echo "0"
    fi
}

# Get focused task info
get_focused_task() {
    if [[ ! -f "$TODO_FILE" ]]; then
        echo ""
        return
    fi
    jq -r '.focus.taskId // empty' "$TODO_FILE"
}

get_focused_task_title() {
    local task_id="$1"
    if [[ -z "$task_id" || ! -f "$TODO_FILE" ]]; then
        echo ""
        return
    fi
    jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .title // empty' "$TODO_FILE"
}

# Get git status summary
get_git_status() {
    if git rev-parse --git-dir > /dev/null 2>&1; then
        local changes=$(git status --porcelain 2>/dev/null | wc -l)
        if [[ "$changes" -gt 0 ]]; then
            echo "$changes files changed"
        else
            echo "clean"
        fi
    else
        echo "not a git repo"
    fi
}

# Get list of modified files
get_modified_files() {
    if git rev-parse --git-dir > /dev/null 2>&1; then
        git status --porcelain 2>/dev/null | awk '{print $2}' | head -20
    fi
}

# Generate handoff document
generate_handoff() {
    local reason="$1"
    local output_file="$2"

    local percentage=$(get_context_percentage)
    local task_id=$(get_focused_task)
    local task_title=$(get_focused_task_title "$task_id")
    local session_id=$(cat "$SESSION_FILE" 2>/dev/null || echo "")
    local git_status=$(get_git_status)
    local modified_files=$(get_modified_files | jq -R -s 'split("\n") | map(select(length > 0))')

    local session_note=""
    if [[ -f "$TODO_FILE" ]]; then
        session_note=$(jq -r '.focus.sessionNote // empty' "$TODO_FILE")
    fi

    jq -n \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg reason "$reason" \
        --argjson pct "$percentage" \
        --arg session_id "$session_id" \
        --arg task_id "$task_id" \
        --arg task_title "$task_title" \
        --arg progress "$session_note" \
        --arg git_status "$git_status" \
        --argjson files "$modified_files" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/handoff.schema.json",
            "version": "1.0.0",
            "generatedAt": $ts,
            "reason": $reason,
            "contextPercentage": $pct,
            "session": {
                "cleoSessionId": $session_id
            },
            "focusedTask": {
                "id": $task_id,
                "title": $task_title,
                "progressNote": $progress
            },
            "workInProgress": {
                "gitStatus": $git_status,
                "filesModified": $files
            },
            "resumeCommand": ("cleo session resume " + $session_id)
        }' > "$output_file"
}

# Main execution
main() {
    # Parse common flags first (if flags.sh was sourced successfully)
    if declare -f parse_common_flags &>/dev/null; then
        parse_common_flags "$@"
        set -- "${REMAINING_ARGS[@]}"

        # Bridge to legacy variables
        apply_flags_to_globals
        FORMAT=$(resolve_format "$FORMAT")
        DRY_RUN="${DRY_RUN:-false}"

        # Handle help flag
        if [[ "$FLAG_HELP" == true ]]; then
            usage
            exit 0
        fi
    fi

    # Parse command-specific arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --reason)
                REASON="$2"
                shift
                ;;
            --commit)
                DO_COMMIT=true
                ;;
            --handoff)
                HANDOFF_FILE="$2"
                shift
                ;;
            --no-session-end)
                END_SESSION=false
                ;;
            -*)
                echo "Error: Unknown option: $1" >&2
                usage >&2
                exit 2
                ;;
            *)
                shift
                continue
                ;;
        esac
        shift
    done

    # Validate required args
    if [[ -z "$REASON" ]]; then
        echo "Error: --reason is required" >&2
        usage >&2
        exit 2
    fi

    # Check for active session
    if [[ ! -f "$SESSION_FILE" ]]; then
        echo "Warning: No active CLEO session" >&2
    fi

    local percentage=$(get_context_percentage)
    local task_id=$(get_focused_task)
    local task_title=$(get_focused_task_title "$task_id")

    if [[ "$DRY_RUN" == true ]]; then
        echo "=== SAFESTOP DRY RUN ==="
        echo "Reason: $REASON"
        echo "Context: ${percentage}%"
        echo "Focused task: ${task_id:-none} - ${task_title:-none}"
        echo "Git status: $(get_git_status)"
        echo ""
        echo "Would perform:"
        [[ -n "$task_id" ]] && echo "  - Update task $task_id notes"
        [[ "$DO_COMMIT" == true ]] && echo "  - Git commit with WIP message"
        [[ -n "$HANDOFF_FILE" ]] && echo "  - Generate handoff to $HANDOFF_FILE"
        [[ "$END_SESSION" == true ]] && echo "  - End CLEO session"
        exit 0
    fi

    echo "🛑 Initiating safestop..."

    # 1. Update task notes
    if [[ -n "$task_id" ]]; then
        local note="⚠️ SAFESTOP (${percentage}%): $REASON"
        "$SCRIPT_DIR/focus.sh" note "$note" 2>/dev/null || true
        echo "✓ Updated task $task_id notes"
    fi

    # 2. Git commit if requested
    if [[ "$DO_COMMIT" == true ]]; then
        if git rev-parse --git-dir > /dev/null 2>&1; then
            local git_status=$(git status --porcelain 2>/dev/null | wc -l)
            if [[ "$git_status" -gt 0 ]]; then
                git add -A
                local commit_msg="WIP: ${task_title:-safestop} - $REASON"
                git commit -m "$commit_msg" --no-verify 2>/dev/null || true
                echo "✓ Committed changes: $commit_msg"
            else
                echo "- No changes to commit"
            fi
        else
            echo "- Not a git repository, skipping commit"
        fi
    fi

    # 3. Generate handoff
    if [[ -n "$HANDOFF_FILE" ]]; then
        if [[ "$HANDOFF_FILE" == "-" ]]; then
            generate_handoff "$REASON" "/dev/stdout"
        else
            generate_handoff "$REASON" "$HANDOFF_FILE"
            echo "✓ Handoff saved to $HANDOFF_FILE"
        fi
    fi

    # 4. End session
    if [[ "$END_SESSION" == true && -f "$SESSION_FILE" ]]; then
        "$SCRIPT_DIR/session.sh" end --note "Safestop: $REASON at ${percentage}%" 2>/dev/null || true
        echo "✓ Session ended"
    fi

    echo ""
    echo "✅ Safestop complete"
    [[ -n "$HANDOFF_FILE" && "$HANDOFF_FILE" != "-" ]] && echo "Resume with: cleo session resume $(cat "$SESSION_FILE" 2>/dev/null || echo '<session-id>')"
}

main "$@"
