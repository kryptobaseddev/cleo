#!/usr/bin/env bash
# session-enforcement.sh - Write operation session enforcement for Epic-Bound Sessions
#
# LAYER: 2 (Data Layer)
# DEPENDENCIES: exit-codes.sh, error-json.sh, sessions.sh, config.sh, paths.sh
# PROVIDES: require_active_session, validate_task_in_scope, is_session_enforcement_enabled,
#           get_enforcement_mode, get_active_session_info
#
# Design: Enforces that write operations (add, update, complete) require an active
# session when multi-session mode is enabled. This is part of the Epic-Bound Session
# architecture defined in EPIC-SESSION-SPEC.md Part 5.
#
# Version: 1.0.0 (cleo v0.40.0)
# Spec: docs/specs/EPIC-SESSION-SPEC.md

#=== SOURCE GUARD ================================================
[[ -n "${_SESSION_ENFORCEMENT_SH_LOADED:-}" ]] && return 0
declare -r _SESSION_ENFORCEMENT_SH_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_SESSION_ENFORCEMENT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source exit codes (foundational)
if [[ -f "$_SESSION_ENFORCEMENT_LIB_DIR/exit-codes.sh" ]]; then
    source "$_SESSION_ENFORCEMENT_LIB_DIR/exit-codes.sh"
fi

# Source error-json for structured error output
if [[ -f "$_SESSION_ENFORCEMENT_LIB_DIR/error-json.sh" ]]; then
    source "$_SESSION_ENFORCEMENT_LIB_DIR/error-json.sh"
fi

# Source paths for directory resolution
if [[ -f "$_SESSION_ENFORCEMENT_LIB_DIR/paths.sh" ]]; then
    source "$_SESSION_ENFORCEMENT_LIB_DIR/paths.sh"
fi

# Source config for settings access
if [[ -f "$_SESSION_ENFORCEMENT_LIB_DIR/config.sh" ]]; then
    source "$_SESSION_ENFORCEMENT_LIB_DIR/config.sh"
fi

# Source sessions library for session operations
if [[ -f "$_SESSION_ENFORCEMENT_LIB_DIR/sessions.sh" ]]; then
    source "$_SESSION_ENFORCEMENT_LIB_DIR/sessions.sh"
fi

# ============================================================================
# CONSTANTS
# ============================================================================

# Enforcement modes (see EPIC-SESSION-SPEC.md Part 5.2)
readonly ENFORCEMENT_MODE_STRICT="strict"
readonly ENFORCEMENT_MODE_WARN="warn"
readonly ENFORCEMENT_MODE_NONE="none"

# Default enforcement mode when multi-session is enabled
readonly DEFAULT_ENFORCEMENT_MODE="strict"

# ============================================================================
# CONFIGURATION HELPERS
# ============================================================================

# Check if session enforcement is enabled
# This depends on both multiSession.enabled AND session.enforcement settings
# Args: $1 - config file path (optional)
# Returns: 0 if enforcement is enabled, 1 if disabled
is_session_enforcement_enabled() {
    local config_file="${1:-}"

    # Determine config file path
    if [[ -z "$config_file" ]]; then
        if declare -f get_config_file >/dev/null 2>&1; then
            config_file=$(get_config_file)
        else
            config_file="${CONFIG_FILE:-.cleo/config.json}"
        fi
    fi

    if [[ ! -f "$config_file" ]]; then
        return 1
    fi

    # Check if multi-session is enabled
    # Note: Using explicit null check instead of // operator because
    # jq's // treats false as falsy (false // true = true, which is wrong)
    local multi_session_enabled
    multi_session_enabled=$(jq -r 'if .multiSession.enabled == null then true else .multiSession.enabled end' "$config_file" 2>/dev/null)

    if [[ "$multi_session_enabled" != "true" ]]; then
        return 1
    fi

    # Check enforcement mode
    local enforcement_mode
    enforcement_mode=$(get_enforcement_mode "$config_file")

    # Enforcement is enabled unless mode is explicitly "none"
    [[ "$enforcement_mode" != "$ENFORCEMENT_MODE_NONE" ]]
}

# Get the current enforcement mode
# Args: $1 - config file path (optional)
# Returns: Enforcement mode string (strict|warn|none)
get_enforcement_mode() {
    local config_file="${1:-}"

    # Determine config file path
    if [[ -z "$config_file" ]]; then
        if declare -f get_config_file >/dev/null 2>&1; then
            config_file=$(get_config_file)
        else
            config_file="${CONFIG_FILE:-.cleo/config.json}"
        fi
    fi

    if [[ ! -f "$config_file" ]]; then
        echo "$DEFAULT_ENFORCEMENT_MODE"
        return 0
    fi

    local mode
    mode=$(jq -r '.session.enforcement // "strict"' "$config_file" 2>/dev/null)

    # Validate mode (accept common aliases)
    case "$mode" in
        strict|warn|none)
            echo "$mode"
            ;;
        off|disabled|false)
            # Accept common aliases for 'none'
            echo "none"
            ;;
        *)
            echo "WARNING: Invalid session.enforcement value '$mode', using '$DEFAULT_ENFORCEMENT_MODE'" >&2
            echo "$DEFAULT_ENFORCEMENT_MODE"
            ;;
    esac
}

# ============================================================================
# SESSION STATE HELPERS
# ============================================================================

# Get active session information for current context
# Checks CLEO_SESSION env var, then .current-session file
# Args: $1 - sessions file path (optional)
# Returns: JSON object with session info or empty
get_active_session_info() {
    local sessions_file="${1:-}"

    # Determine sessions file path
    if [[ -z "$sessions_file" ]]; then
        if declare -f get_sessions_file >/dev/null 2>&1; then
            sessions_file=$(get_sessions_file)
        else
            sessions_file="${CLEO_DIR:-.cleo}/sessions.json"
        fi
    fi

    if [[ ! -f "$sessions_file" ]]; then
        return 1
    fi

    # Get current session ID
    local session_id=""

    # Check environment variable first
    if [[ -n "${CLEO_SESSION:-}" ]]; then
        session_id="$CLEO_SESSION"
    else
        # Check .current-session file
        local current_session_file
        if declare -f get_cleo_dir >/dev/null 2>&1; then
            current_session_file="$(get_cleo_dir)/.current-session"
        else
            current_session_file="${CLEO_DIR:-.cleo}/.current-session"
        fi

        if [[ -f "$current_session_file" ]]; then
            session_id=$(cat "$current_session_file" | tr -d '[:space:]')
        fi
    fi

    if [[ -z "$session_id" ]]; then
        return 1
    fi

    # Get session info
    local session_info
    session_info=$(jq -c --arg id "$session_id" '
        .sessions[] | select(.id == $id and .status == "active")
    ' "$sessions_file" 2>/dev/null)

    if [[ -z "$session_info" || "$session_info" == "null" ]]; then
        return 1
    fi

    echo "$session_info"
    return 0
}

# ============================================================================
# ENFORCEMENT FUNCTIONS
# ============================================================================

# Require an active session for write operations
# This is the main enforcement check called by add/update/complete scripts
#
# Args: $1 - operation name (for error messages, e.g., "add", "update", "complete")
#       $2 - format (json|text, default: text)
#
# Returns: 0 if session is active or enforcement disabled
#          EXIT_SESSION_REQUIRED (36) if session required but not active
#
# Side effects: Outputs error message if check fails (JSON or text based on format)
require_active_session() {
    local operation="${1:-write}"
    local format="${2:-text}"

    # Check if enforcement is enabled
    if ! is_session_enforcement_enabled; then
        return 0
    fi

    local enforcement_mode
    enforcement_mode=$(get_enforcement_mode)

    # Get active session
    local session_info
    session_info=$(get_active_session_info 2>/dev/null) || session_info=""

    if [[ -n "$session_info" ]]; then
        # Session is active - allow operation
        return 0
    fi

    # No active session
    case "$enforcement_mode" in
        strict)
            # Strict mode: block the operation
            if [[ "$format" == "json" ]]; then
                if declare -f output_session_error >/dev/null 2>&1; then
                    output_session_error "$E_SESSION_REQUIRED" \
                        "Operation '$operation' requires an active session" \
                        "${EXIT_SESSION_REQUIRED:-36}" \
                        "{\"operation\":\"$operation\",\"enforcementMode\":\"strict\"}"
                else
                    jq -nc \
                        --arg op "$operation" \
                        '{
                            "success": false,
                            "error": {
                                "code": "E_SESSION_REQUIRED",
                                "message": ("Operation \($op) requires an active session"),
                                "exitCode": 36,
                                "recoverable": true,
                                "suggestion": "Start a session first: cleo session start --epic <task-id>"
                            }
                        }'
                fi
            else
                echo "[ERROR] Operation '$operation' requires an active session." >&2
                echo "" >&2
                echo "Write operations require an active session when multi-session mode is enabled." >&2
                echo "" >&2
                echo "To start a session:" >&2
                echo "  cleo session start --epic <task-id>     # Start session for an epic" >&2
                echo "  cleo session resume <session-id>        # Resume existing session" >&2
                echo "  cleo session list                       # List available sessions" >&2
            fi
            return "${EXIT_SESSION_REQUIRED:-36}"
            ;;
        warn)
            # Warn mode: warn but allow
            if [[ "$format" != "json" ]]; then
                echo "[WARN] Operation '$operation' without active session (session.enforcement=warn)" >&2
            fi
            return 0
            ;;
        none)
            # No enforcement
            return 0
            ;;
    esac

    return 0
}

# Validate that a task is within the current session's scope
# This prevents operations on tasks outside the session's epic
#
# Args: $1 - task ID to validate
#       $2 - format (json|text, default: text)
#       $3 - sessions file path (optional)
#
# Returns: 0 if task is in scope or enforcement disabled
#          EXIT_TASK_NOT_IN_SCOPE (34) if task is outside session scope
#
# Side effects: Outputs error message if check fails
validate_task_in_scope() {
    local task_id="$1"
    local format="${2:-text}"
    local sessions_file="${3:-}"

    # Check if enforcement is enabled
    if ! is_session_enforcement_enabled; then
        return 0
    fi

    local enforcement_mode
    enforcement_mode=$(get_enforcement_mode)

    # In "none" mode, skip validation
    if [[ "$enforcement_mode" == "$ENFORCEMENT_MODE_NONE" ]]; then
        return 0
    fi

    # Get active session
    local session_info
    session_info=$(get_active_session_info "$sessions_file" 2>/dev/null) || session_info=""

    if [[ -z "$session_info" ]]; then
        # No active session - require_active_session should have caught this
        # but we handle it here for safety
        return 0
    fi

    # Get computed task IDs from session scope
    local scope_task_ids
    scope_task_ids=$(echo "$session_info" | jq -c '.scope.computedTaskIds // []')

    # Check if task is in scope
    local in_scope
    in_scope=$(echo "$scope_task_ids" | jq --arg id "$task_id" 'index($id) != null')

    if [[ "$in_scope" == "true" ]]; then
        return 0
    fi

    # Task not in scope
    local session_id epic_id
    session_id=$(echo "$session_info" | jq -r '.id')
    epic_id=$(echo "$session_info" | jq -r '.scope.rootTaskId // "unknown"')

    case "$enforcement_mode" in
        strict)
            if [[ "$format" == "json" ]]; then
                if declare -f output_session_error >/dev/null 2>&1; then
                    output_session_error "$E_TASK_NOT_IN_SCOPE" \
                        "Task $task_id is not within session scope (Epic: $epic_id)" \
                        "${EXIT_TASK_NOT_IN_SCOPE:-34}" \
                        "{\"taskId\":\"$task_id\",\"sessionId\":\"$session_id\",\"epicId\":\"$epic_id\"}"
                else
                    jq -nc \
                        --arg tid "$task_id" \
                        --arg sid "$session_id" \
                        --arg eid "$epic_id" \
                        '{
                            "success": false,
                            "error": {
                                "code": "E_TASK_NOT_IN_SCOPE",
                                "message": ("Task \($tid) is not within session scope (Epic: \($eid))"),
                                "exitCode": 34,
                                "recoverable": true,
                                "suggestion": "Focus a task within your session scope, or start a new session for this task'"'"'s epic"
                            }
                        }'
                fi
            else
                echo "[ERROR] Task $task_id is not within session scope." >&2
                echo "" >&2
                echo "Current session: $session_id (Epic: $epic_id)" >&2
                echo "" >&2
                echo "To work on this task:" >&2
                echo "  1. End current session: cleo session end" >&2
                echo "  2. Start new session for task's epic" >&2
            fi
            return "${EXIT_TASK_NOT_IN_SCOPE:-34}"
            ;;
        warn)
            if [[ "$format" != "json" ]]; then
                echo "[WARN] Task $task_id is outside session scope (Epic: $epic_id)" >&2
            fi
            return 0
            ;;
        *)
            return 0
            ;;
    esac
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f is_session_enforcement_enabled
export -f get_enforcement_mode
export -f get_active_session_info
export -f require_active_session
export -f validate_task_in_scope

# Export constants
export ENFORCEMENT_MODE_STRICT
export ENFORCEMENT_MODE_WARN
export ENFORCEMENT_MODE_NONE
export DEFAULT_ENFORCEMENT_MODE
