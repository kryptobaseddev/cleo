#!/usr/bin/env bash
# CLEO PreCompact Hook - Emergency Safestop Fallback
# Triggers when Claude Code auto-compact fires (95% context usage)
#
# INSTALLATION:
#   Copy to ~/.claude/hooks/ or configure in ~/.claude/settings.json:
#   {
#     "hooks": {
#       "PreCompact": [{
#         "type": "command",
#         "command": "~/.cleo/hooks/precompact-safestop.sh",
#         "timeout": 30
#       }]
#     }
#   }
#
# This hook provides emergency fallback when an agent doesn't self-stop
# at the critical (90%) threshold. At 95%, Claude Code triggers PreCompact,
# and this hook ensures CLEO session state is properly saved.

set -euo pipefail

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
SESSION_FILE="${CLEO_DIR:-.cleo}/.current-session"
LOG_FILE="${CLEO_DIR:-.cleo}/safestop.log"

log_message() {
    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    echo "[$timestamp] $1" >> "$LOG_FILE" 2>/dev/null || true
    echo "[CLEO] $1" >&2
}

# Check if CLEO session is active
if [[ -n "$CLEO_DIR" && -f "$SESSION_FILE" ]]; then
    SESSION_ID=$(cat "$SESSION_FILE" 2>/dev/null || echo "")

    if [[ -n "$SESSION_ID" ]]; then
        log_message "PreCompact triggered - initiating emergency safestop"

        # Find cleo command
        CLEO_CMD="${CLEO_HOME:-$HOME/.cleo}/bin/cleo"
        if [[ ! -x "$CLEO_CMD" ]]; then
            CLEO_CMD=$(which cleo 2>/dev/null || echo "")
        fi

        if [[ -n "$CLEO_CMD" && -x "$CLEO_CMD" ]]; then
            # Run safestop with emergency flag
            HANDOFF_FILE="${CLEO_DIR}/handoff-emergency-$(date +%s).json"

            "$CLEO_CMD" safestop \
                --reason "precompact-emergency" \
                --commit \
                --handoff "$HANDOFF_FILE" \
                2>&1 | tee -a "$LOG_FILE" || true

            log_message "Emergency safestop completed. Handoff: $HANDOFF_FILE"

            # Signal to Claude that safestop was performed
            echo ""
            echo "⚠️ CLEO Emergency Safestop executed at PreCompact (95% context)."
            echo "Session ended. Handoff saved to: $HANDOFF_FILE"
            echo "Resume with: cleo session resume $SESSION_ID"
        else
            log_message "ERROR: cleo command not found, cannot perform safestop"
            echo "⚠️ PreCompact triggered but cleo command not found" >&2
        fi
    else
        log_message "PreCompact triggered but session file empty"
    fi
else
    # No active CLEO session - just log
    if [[ -n "$CLEO_DIR" ]]; then
        log_message "PreCompact triggered but no active CLEO session"
    fi
    # Silent exit - don't interfere with normal Claude Code operation
fi
