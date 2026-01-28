#!/usr/bin/env bash
# SessionStart hook: Auto-bind CLEO session to Claude Code terminal
# Part of CLEO universal subagent architecture (v0.70.0+)

set -euo pipefail

# Find cleo installation
CLEO_DIR="${HOME}/.cleo"
CLEO_BIN="${CLEO_DIR}/cleo"

# Only proceed if cleo is installed
if [[ ! -x "$CLEO_BIN" ]]; then
    exit 0
fi

# Check if .cleo project directory exists
if [[ ! -d ".cleo" ]]; then
    exit 0
fi

# Check if there's a current session
CURRENT_SESSION_FILE=".cleo/.current-session"
if [[ ! -f "$CURRENT_SESSION_FILE" ]]; then
    exit 0
fi

# Read current session ID
SESSION_ID=$(cat "$CURRENT_SESSION_FILE" 2>/dev/null || echo "")
if [[ -z "$SESSION_ID" ]]; then
    exit 0
fi

# Verify session exists and is active
SESSION_STATUS=$("$CLEO_BIN" session status --session "$SESSION_ID" --format json 2>/dev/null || echo "{}")
IS_ACTIVE=$(echo "$SESSION_STATUS" | jq -r '.session.status // "unknown"' 2>/dev/null || echo "unknown")

if [[ "$IS_ACTIVE" == "active" ]]; then
    # Export session to environment for all subsequent commands
    export CLEO_SESSION="$SESSION_ID"

    # Write to a file that can be sourced by the shell
    echo "export CLEO_SESSION=\"$SESSION_ID\"" > ".cleo/.session-env"

    # Optional: Display session info (visible in terminal)
    echo "✓ CLEO session bound: $SESSION_ID" >&2
fi

exit 0
