#!/usr/bin/env bash
# Standardized error JSON output for cleo
#
# LAYER: 1 (Core Infrastructure)
# DEPENDENCIES: exit-codes.sh, platform-compat.sh
# PROVIDES: output_error, output_error_json, output_error_actionable,
#           output_warning, output_session_error, get_session_error_suggestion,
#           get_session_error_message, E_SESSION_EXISTS, E_SESSION_NOT_FOUND,
#           E_SCOPE_CONFLICT, E_SCOPE_INVALID, E_TASK_NOT_IN_SCOPE,
#           E_TASK_CLAIMED, E_SESSION_REQUIRED, E_SESSION_CLOSE_BLOCKED,
#           E_FOCUS_REQUIRED, E_NOTES_REQUIRED
#
# Critical component for LLM-agent-first design:
# - Reliable error parsing in automation workflows
# - Structured error codes and recovery suggestions
# - Consistent error format across all commands

#=== SOURCE GUARD ================================================
[[ -n "${_ERROR_JSON_SH_LOADED:-}" ]] && return 0
declare -r _ERROR_JSON_SH_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_ERROR_JSON_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source exit codes
if [[ -f "$_ERROR_JSON_LIB_DIR/core/exit-codes.sh" ]]; then
    # shellcheck source=lib/core/exit-codes.sh
    source "$_ERROR_JSON_LIB_DIR/core/exit-codes.sh"
else
    echo "ERROR: Cannot find exit-codes.sh in $_ERROR_JSON_LIB_DIR" >&2
    exit 1
fi

# Source platform compatibility for get_iso_timestamp if available
if [[ -f "$_ERROR_JSON_LIB_DIR/core/platform-compat.sh" ]]; then
    # shellcheck source=lib/core/platform-compat.sh
    source "$_ERROR_JSON_LIB_DIR/core/platform-compat.sh"
fi

# ============================================================================
# VERSION
# ============================================================================

_CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

if [[ -f "$_CLEO_HOME/VERSION" ]]; then
    _ERROR_JSON_VERSION="$(head -n 1 "$_CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$_ERROR_JSON_LIB_DIR/../VERSION" ]]; then
    _ERROR_JSON_VERSION="$(head -n 1 "$_ERROR_JSON_LIB_DIR/../VERSION" | tr -d '[:space:]')"
else
    _ERROR_JSON_VERSION="0.16.0"
fi

# ============================================================================
# COLOR CODES (for text output)
# ============================================================================

# Only set colors if not already defined and terminal supports them
if [[ -z "${_ERROR_COLORS_SET:-}" ]]; then
    if [[ -t 2 ]] && [[ -z "${NO_COLOR:-}" ]]; then
        RED='\033[0;31m'
        YELLOW='\033[0;33m'
        DIM='\033[2m'
        NC='\033[0m'  # No Color
    else
        RED=''
        YELLOW=''
        DIM=''
        NC=''
    fi
    _ERROR_COLORS_SET=1
fi

# ============================================================================
# ERROR CONTEXT MINIMIZATION (Token Optimization)
# ============================================================================

# minimize_error_context - Smart context reduction with progressive disclosure
#
# LLM agents need enough context to make informed decisions, but not verbose
# debugging data. This function implements 3-level progressive disclosure:
#
#   Level 1: Counts only (fallback for unknown arrays)
#   Level 2: Smart summaries with decision-relevant fields (default)
#   Level 3: Full verbose output (CLEO_VERBOSE=1)
#
# Known array types get smart summaries:
#   - sessions: [{id, name, scope, focusedTask}] - enough to choose the right session
#   - epics: [{id, title, status, pendingCount}] - enough to pick an epic to work on
#   - tasks: [{id, title, status}] - enough to understand task state
#
# Arguments:
#   $1 - context_json : Full context JSON object
#
# Returns: Minimized context JSON via stdout (typically 80-90% smaller)
#
# Example:
#   Input:  {"activeSessions": 8, "sessions": [{full session objects...}]}
#   Output: {"activeSessions": 8, "sessions": [{id, name, scope, focusedTask}...]}
#
minimize_error_context() {
    local context_json="$1"

    # If null or empty, return as-is
    if [[ -z "$context_json" ]] || [[ "$context_json" == "null" ]]; then
        echo "null"
        return 0
    fi

    # Smart minimization: preserve decision-relevant fields, strip verbose data
    echo "$context_json" | jq -c '
        # Helper to summarize sessions (keep fields needed for agent decision-making)
        def summarize_session:
            {
                id: .id,
                name: .name,
                scope: (if .scope then "\(.scope.type):\(.scope.rootTaskId // "?")" else null end),
                focus: .focus.currentTask
            };

        # Helper to summarize epics (keep fields needed for selection)
        def summarize_epic:
            {
                id: .id,
                title: (.title | if length > 50 then .[:47] + "..." else . end),
                status: .status,
                pending: .pendingCount
            };

        # Helper to summarize tasks
        def summarize_task:
            {
                id: .id,
                title: (.title | if length > 40 then .[:37] + "..." else . end),
                status: .status
            };

        # Process each key
        . as $orig |
        reduce (keys[]) as $key (
            {};
            if $key == "sessions" and ($orig[$key] | type) == "array" then
                # Smart session summary
                . + {sessions: [$orig[$key][] | summarize_session]}
            elif $key == "epics" and ($orig[$key] | type) == "array" then
                # Smart epic summary
                . + {epics: [$orig[$key][] | summarize_epic]}
            elif $key == "tasks" and ($orig[$key] | type) == "array" then
                # Smart task summary
                . + {tasks: [$orig[$key][] | summarize_task]}
            elif ($orig[$key] | type) == "array" then
                # Unknown arrays: just keep count
                . + {($key + "Count"): ($orig[$key] | length)}
            elif ($orig[$key] | type) == "object" then
                # Nested objects: keep key count
                . + {($key + "Keys"): ($orig[$key] | keys | length)}
            else
                # Scalars: preserve as-is
                . + {($key): $orig[$key]}
            end
        ) + {_hint: "CLEO_VERBOSE=1 for full context"}
    ' 2>/dev/null || echo "$context_json"
}

# is_verbose_mode - Check if verbose error output is requested
#
# Returns 0 (true) if verbose mode is enabled, 1 (false) otherwise.
# Checks: CLEO_VERBOSE env var, or global VERBOSE flag
#
is_verbose_mode() {
    [[ "${CLEO_VERBOSE:-}" == "1" ]] || [[ "${CLEO_VERBOSE:-}" == "true" ]] || [[ "${VERBOSE:-}" == "true" ]]
}

# Export helper functions
export -f minimize_error_context
export -f is_verbose_mode

# ============================================================================
# ERROR JSON OUTPUT
# ============================================================================

# output_error_json - Output structured error as JSON
#
# Outputs a standardized JSON error envelope that LLM agents can reliably parse.
# This is the core function for structured error responses.
#
# Arguments:
#   $1 - error_code    : Error code string (e.g., "E_TASK_NOT_FOUND")
#   $2 - message       : Human-readable error message
#   $3 - exit_code     : Exit code number (default: 1)
#   $4 - recoverable   : Boolean string "true" or "false" (default: "false")
#   $5 - suggestion    : Recovery suggestion string (optional, empty for null)
#
# Output format:
#   {
#     "$schema": "https://cleo-dev.com/schemas/v1/error.schema.json",
#     "_meta": {
#       "format": "json",
#       "version": "<version>",
#       "command": "<command>",
#       "timestamp": "<ISO-8601>"
#     },
#     "success": false,
#     "error": {
#       "code": "<error_code>",
#       "message": "<message>",
#       "exitCode": <exit_code>,
#       "recoverable": <recoverable>,
#       "suggestion": "<suggestion>" | null
#     }
#   }
#
# Returns: Nothing (outputs to stdout)
output_error_json() {
    local error_code="$1"
    local message="$2"
    local exit_code="${3:-1}"
    local recoverable="${4:-false}"
    local suggestion="${5:-}"

    # Get context variables with defaults
    local command="${COMMAND_NAME:-unknown}"
    local version="${VERSION:-${_ERROR_JSON_VERSION}}"

    # Get timestamp (use platform-compat if available, otherwise date)
    local timestamp
    if command -v get_iso_timestamp &>/dev/null; then
        timestamp=$(get_iso_timestamp)
    else
        timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    fi

    # Convert recoverable to JSON boolean
    local recoverable_bool
    if [[ "$recoverable" == "true" ]]; then
        recoverable_bool="true"
    else
        recoverable_bool="false"
    fi

    # Always use compact JSON output (LLM-Agent-First principle)
    # - Agents parse JSON programmatically, formatting doesn't matter
    # - Compact prevents truncation issues ("+N lines")
    # - Humans can pipe through `| jq .` for pretty output
    local jq_opts="-c"

    # Build JSON using jq
    # shellcheck disable=SC2086
    jq -nc $jq_opts \
        --arg version "$version" \
        --arg command "$command" \
        --arg timestamp "$timestamp" \
        --arg code "$error_code" \
        --arg msg "$message" \
        --argjson exit "$exit_code" \
        --argjson rec "$recoverable_bool" \
        --arg sug "$suggestion" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/error.schema.json",
            "_meta": {
                "format": "json",
                "version": $version,
                "command": $command,
                "timestamp": $timestamp
            },
            "success": false,
            "error": {
                "code": $code,
                "message": $msg,
                "exitCode": $exit,
                "recoverable": $rec,
                "suggestion": (if $sug != "" then $sug else null end)
            }
        }'
}

# output_error - Format-aware error output
#
# Outputs an error in the appropriate format based on the FORMAT variable:
# - If FORMAT=json: outputs structured JSON via output_error_json()
# - Otherwise: outputs colored text to stderr
#
# This is the primary function commands should use for error reporting.
#
# Arguments:
#   $1 - error_code    : Error code string (e.g., "E_TASK_NOT_FOUND")
#   $2 - message       : Human-readable error message
#   $3 - exit_code     : Exit code number (default: 1)
#   $4 - recoverable   : Boolean string "true" or "false" (default: "false")
#   $5 - suggestion    : Recovery suggestion string (optional)
#
# Environment:
#   FORMAT - Output format ("json" for JSON, anything else for text)
#   COMMAND_NAME - Name of the current command (for _meta.command)
#   VERSION - Version string (for _meta.version)
#
# Returns: The exit_code value (for use with 'return' or checking)
#
# Example usage:
#   output_error "E_TASK_NOT_FOUND" "Task T999 not found" $EXIT_NOT_FOUND true "Run 'ct list' to see available tasks"
#   exit $?
#
output_error() {
    local error_code="$1"
    local message="$2"
    local exit_code="${3:-1}"
    local recoverable="${4:-false}"
    local suggestion="${5:-}"

    if [[ "${FORMAT:-text}" == "json" ]]; then
        # JSON output to stdout
        output_error_json "$error_code" "$message" "$exit_code" "$recoverable" "$suggestion"
    else
        # Text output to stderr
        echo -e "${RED}[ERROR]${NC} $message" >&2

        # Show suggestion if provided
        if [[ -n "$suggestion" ]]; then
            echo -e "${DIM}Suggestion: $suggestion${NC}" >&2
        fi
    fi

    return "$exit_code"
}

# output_error_actionable - Enhanced error with concrete fix commands (LLM-Agent-First)
#
# Outputs a structured error with actionable recovery commands that agents can execute.
# This is the preferred function for errors where automated recovery is possible.
#
# Arguments:
#   $1 - error_code    : Error code string (e.g., "E_DEPTH_EXCEEDED")
#   $2 - message       : Human-readable error message
#   $3 - exit_code     : Exit code number
#   $4 - recoverable   : Boolean string "true" or "false"
#   $5 - suggestion    : Human-readable suggestion
#   $6 - fix           : Primary fix command (copy-paste ready)
#   $7 - context_json  : JSON object with error context (optional)
#   $8 - alternatives_json : JSON array of {action, command} objects (optional)
#
# Example:
#   output_error_actionable "E_DEPTH_EXCEEDED" \
#     "Cannot add subtask: max depth exceeded" 11 true \
#     "T297 is a subtask (depth 2), cannot have children" \
#     "ct add \"$TITLE\" --type task" \
#     '{"parentId":"T297","parentType":"subtask","depth":2}' \
#     '[{"action":"Create as task","command":"ct add \"Task\" --type task"}]'
#
output_error_actionable() {
    local error_code="$1"
    local message="$2"
    local exit_code="${3:-1}"
    local recoverable="${4:-false}"
    local suggestion="${5:-}"
    local fix="${6:-}"
    local context_json="${7:-null}"
    local alternatives_json="${8:-"[]"}"

    # Get context variables with defaults
    local command="${COMMAND_NAME:-unknown}"
    local version="${VERSION:-${_ERROR_JSON_VERSION}}"

    # Get timestamp
    local timestamp
    if command -v get_iso_timestamp &>/dev/null; then
        timestamp=$(get_iso_timestamp)
    else
        timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    fi

    # Convert recoverable to JSON boolean
    local recoverable_bool="false"
    [[ "$recoverable" == "true" ]] && recoverable_bool="true"

    # Validate context_json is valid JSON, default to null if not
    if [[ "$context_json" != "null" ]] && ! echo "$context_json" | jq . >/dev/null 2>&1; then
        context_json="null"
    fi

    # TOKEN OPTIMIZATION: Minimize context by default for LLM efficiency
    # Large arrays (sessions, epics) waste tokens - agents only need counts + fix commands
    # Use CLEO_VERBOSE=1 or --verbose to get full context when debugging
    if [[ "$context_json" != "null" ]] && ! is_verbose_mode; then
        context_json=$(minimize_error_context "$context_json")
    fi

    # Validate alternatives_json is valid JSON array, default to empty if not
    if ! echo "$alternatives_json" | jq -e 'type == "array"' >/dev/null 2>&1; then
        alternatives_json="[]"
    fi

    # Always use compact JSON (LLM-Agent-First)
    local jq_opts="-c"

    if [[ "${FORMAT:-text}" == "json" ]]; then
        # Build enhanced JSON with fix and alternatives
        # shellcheck disable=SC2086
        jq -nc $jq_opts \
            --arg version "$version" \
            --arg command "$command" \
            --arg timestamp "$timestamp" \
            --arg code "$error_code" \
            --arg msg "$message" \
            --argjson exit "$exit_code" \
            --argjson rec "$recoverable_bool" \
            --arg sug "$suggestion" \
            --arg fix "$fix" \
            --argjson ctx "$context_json" \
            --argjson alts "$alternatives_json" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/error.schema.json",
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": $command,
                    "timestamp": $timestamp
                },
                "success": false,
                "error": {
                    "code": $code,
                    "message": $msg,
                    "exitCode": $exit,
                    "recoverable": $rec,
                    "suggestion": (if $sug != "" then $sug else null end),
                    "fix": (if $fix != "" then $fix else null end),
                    "alternatives": (if ($alts | length) > 0 then $alts else null end),
                    "context": (if $ctx != null then $ctx else null end)
                }
            }'
    else
        # Text output to stderr
        echo -e "${RED}[ERROR]${NC} $message" >&2
        if [[ -n "$suggestion" ]]; then
            echo -e "${DIM}Suggestion: $suggestion${NC}" >&2
        fi
        if [[ -n "$fix" ]]; then
            echo -e "${DIM}Fix: $fix${NC}" >&2
        fi
    fi

    return "$exit_code"
}

# Export the new function
export -f output_error_actionable

# output_warning - Format-aware warning output
#
# Similar to output_error but for non-fatal warnings.
# Does not set a return code since warnings don't cause exits.
#
# Arguments:
#   $1 - warning_code  : Warning code string (e.g., "W_DEPRECATED")
#   $2 - message       : Human-readable warning message
#   $3 - suggestion    : Suggestion string (optional)
#
# Returns: 0 (warnings don't affect exit status)
output_warning() {
    local warning_code="$1"
    local message="$2"
    local suggestion="${3:-}"

    if [[ "${FORMAT:-text}" == "json" ]]; then
        # For JSON format, warnings are typically included in the response
        # but don't replace success. Commands should handle this separately.
        # This outputs just the warning object for composition.
        local timestamp
        if command -v get_iso_timestamp &>/dev/null; then
            timestamp=$(get_iso_timestamp)
        else
            timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        fi

        jq -nc \
            --arg code "$warning_code" \
            --arg msg "$message" \
            --arg sug "$suggestion" \
            --arg ts "$timestamp" \
            '{
                "code": $code,
                "message": $msg,
                "suggestion": (if $sug != "" then $sug else null end),
                "timestamp": $ts
            }'
    else
        # Text output to stderr
        echo -e "${YELLOW}[WARNING]${NC} $message" >&2
        if [[ -n "$suggestion" ]]; then
            echo -e "${DIM}Suggestion: $suggestion${NC}" >&2
        fi
    fi

    return 0
}

# ============================================================================
# ERROR CODE CONSTANTS
# ============================================================================

# Standard error codes for consistent error classification
# Format: E_<CATEGORY>_<SPECIFIC>

# Task-related errors
readonly E_TASK_NOT_FOUND="E_TASK_NOT_FOUND"
readonly E_TASK_ALREADY_EXISTS="E_TASK_ALREADY_EXISTS"
readonly E_TASK_INVALID_ID="E_TASK_INVALID_ID"
readonly E_TASK_INVALID_STATUS="E_TASK_INVALID_STATUS"

# File-related errors
readonly E_FILE_NOT_FOUND="E_FILE_NOT_FOUND"
readonly E_FILE_READ_ERROR="E_FILE_READ_ERROR"
readonly E_FILE_WRITE_ERROR="E_FILE_WRITE_ERROR"
readonly E_FILE_PERMISSION="E_FILE_PERMISSION"

# Validation errors
readonly E_VALIDATION_SCHEMA="E_VALIDATION_SCHEMA"
readonly E_VALIDATION_CHECKSUM="E_VALIDATION_CHECKSUM"
readonly E_VALIDATION_REQUIRED="E_VALIDATION_REQUIRED"

# Input errors
readonly E_INPUT_MISSING="E_INPUT_MISSING"
readonly E_INPUT_INVALID="E_INPUT_INVALID"
readonly E_INPUT_FORMAT="E_INPUT_FORMAT"

# Dependency errors
readonly E_DEPENDENCY_MISSING="E_DEPENDENCY_MISSING"
readonly E_DEPENDENCY_VERSION="E_DEPENDENCY_VERSION"

# Phase-related errors
readonly E_PHASE_NOT_FOUND="E_PHASE_NOT_FOUND"
readonly E_PHASE_INVALID="E_PHASE_INVALID"

# Session errors (legacy single-session)
readonly E_SESSION_ACTIVE="E_SESSION_ACTIVE"
readonly E_SESSION_NOT_ACTIVE="E_SESSION_NOT_ACTIVE"

# Epic-Bound Session errors (see EPIC-SESSION-SPEC.md Part 7)
readonly E_SESSION_EXISTS="E_SESSION_EXISTS"
readonly E_SESSION_NOT_FOUND="E_SESSION_NOT_FOUND"
readonly E_SCOPE_CONFLICT="E_SCOPE_CONFLICT"
readonly E_SCOPE_INVALID="E_SCOPE_INVALID"
readonly E_TASK_NOT_IN_SCOPE="E_TASK_NOT_IN_SCOPE"
readonly E_TASK_CLAIMED="E_TASK_CLAIMED"
readonly E_SESSION_REQUIRED="E_SESSION_REQUIRED"
readonly E_SESSION_CLOSE_BLOCKED="E_SESSION_CLOSE_BLOCKED"
readonly E_FOCUS_REQUIRED="E_FOCUS_REQUIRED"
readonly E_NOTES_REQUIRED="E_NOTES_REQUIRED"

# Additional session errors for LLM-agent-first design
readonly E_SESSION_DISCOVERY_MODE="E_SESSION_DISCOVERY_MODE"
readonly E_SESSION_RESUME_ACTIVE="E_SESSION_RESUME_ACTIVE"

# General errors
readonly E_UNKNOWN="E_UNKNOWN"
readonly E_NOT_INITIALIZED="E_NOT_INITIALIZED"
readonly E_ALREADY_INITIALIZED="E_ALREADY_INITIALIZED"
readonly E_CONFIRMATION_REQUIRED="E_CONFIRMATION_REQUIRED"

# Hierarchy errors (see LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md Part 12)
readonly E_PARENT_NOT_FOUND="E_PARENT_NOT_FOUND"
readonly E_DEPTH_EXCEEDED="E_DEPTH_EXCEEDED"
readonly E_SIBLING_LIMIT="E_SIBLING_LIMIT"
readonly E_INVALID_PARENT_TYPE="E_INVALID_PARENT_TYPE"
readonly E_CIRCULAR_REFERENCE="E_CIRCULAR_REFERENCE"
readonly E_ORPHAN_DETECTED="E_ORPHAN_DETECTED"

# Deletion errors (task deletion system)
readonly E_HAS_CHILDREN="E_HAS_CHILDREN"
readonly E_TASK_COMPLETED="E_TASK_COMPLETED"
readonly E_CASCADE_FAILED="E_CASCADE_FAILED"
readonly E_CANCEL_REASON_REQUIRED="E_CANCEL_REASON_REQUIRED"

# Concurrency errors (multi-agent coordination)
readonly E_CHECKSUM_MISMATCH="E_CHECKSUM_MISMATCH"
readonly E_CONCURRENT_MODIFICATION="E_CONCURRENT_MODIFICATION"
readonly E_ID_COLLISION="E_ID_COLLISION"

# ============================================================================
# SESSION ERROR HELPERS
# ============================================================================

# get_session_error_suggestion - Get contextual suggestion for session errors
#
# Returns a human-readable suggestion for resolving session-related errors.
# These suggestions are designed to help both human users and LLM agents
# understand how to recover from common session error conditions.
#
# Arguments:
#   $1 - error_code : Error code string or exit code number
#   $2 - context    : Optional context string (e.g., session ID, task ID)
#
# Returns: Suggestion string via stdout
#
# Example:
#   suggestion=$(get_session_error_suggestion "E_SESSION_EXISTS" "session_abc123")
#
get_session_error_suggestion() {
    local error_code="$1"
    local context="${2:-}"

    case "$error_code" in
        E_SESSION_EXISTS|30)
            echo "Use 'cleo session resume <session-id>' to continue existing session, or 'cleo session end' first"
            ;;
        E_SESSION_NOT_FOUND|31)
            echo "Use 'cleo session list' to see available sessions"
            ;;
        E_SCOPE_CONFLICT|32)
            echo "Use 'cleo session list --status active' to see existing session scopes, or use disjoint scopes"
            ;;
        E_SCOPE_INVALID|33)
            echo "Specify a valid scope with --epic <task-id> where task is an epic or has subtasks"
            ;;
        E_TASK_NOT_IN_SCOPE|34)
            echo "Focus a task within your session scope, or start a new session for this task's epic"
            ;;
        E_TASK_CLAIMED|35)
            echo "Choose a different task or wait for the other agent to release focus"
            ;;
        E_SESSION_REQUIRED|36)
            echo "Start a session first: cleo session start --epic <task-id>"
            ;;
        E_SESSION_CLOSE_BLOCKED|37)
            echo "Complete all tasks in scope before closing, or use 'cleo session end' to end without closing"
            ;;
        E_FOCUS_REQUIRED|38)
            echo "Set focus first: cleo focus set <task-id>"
            ;;
        E_NOTES_REQUIRED|39)
            echo "Add notes with --note 'Your session summary'"
            ;;
        *)
            echo ""
            ;;
    esac
}

# get_session_error_message - Get human-readable message for session errors
#
# Returns a descriptive message for session error codes.
#
# Arguments:
#   $1 - error_code : Error code string or exit code number
#
# Returns: Error message string via stdout
#
get_session_error_message() {
    local error_code="$1"

    case "$error_code" in
        E_SESSION_EXISTS|30)
            echo "Session already active for this scope"
            ;;
        E_SESSION_NOT_FOUND|31)
            echo "Session not found"
            ;;
        E_SCOPE_CONFLICT|32)
            echo "Session scope conflicts with existing session"
            ;;
        E_SCOPE_INVALID|33)
            echo "Invalid session scope"
            ;;
        E_TASK_NOT_IN_SCOPE|34)
            echo "Task is not within session scope"
            ;;
        E_TASK_CLAIMED|35)
            echo "Task is already claimed by another agent"
            ;;
        E_SESSION_REQUIRED|36)
            echo "Operation requires an active session"
            ;;
        E_SESSION_CLOSE_BLOCKED|37)
            echo "Cannot close session with incomplete tasks"
            ;;
        E_FOCUS_REQUIRED|38)
            echo "Operation requires a focused task"
            ;;
        E_NOTES_REQUIRED|39)
            echo "Session notes are required for this operation"
            ;;
        *)
            echo "Unknown session error"
            ;;
    esac
}

# get_session_error_fix - Get copy-paste ready fix command for session errors
#
# Returns a concrete command that agents can execute to resolve the error.
# This is the primary actionable field for LLM-agent-first design.
#
# Arguments:
#   $1 - error_code : Error code string or exit code number
#   $2 - context    : Optional context (e.g., session ID, task ID)
#
# Returns: Fix command string via stdout (empty if no specific fix)
#
get_session_error_fix() {
    local error_code="$1"
    local context="${2:-}"

    case "$error_code" in
        E_SESSION_EXISTS|30)
            if [[ -n "$context" ]]; then
                echo "cleo session status"
            else
                echo "cleo session status"
            fi
            ;;
        E_SESSION_NOT_FOUND|31)
            echo "cleo session list"
            ;;
        E_SCOPE_CONFLICT|32)
            echo "cleo session list --status active"
            ;;
        E_SCOPE_INVALID|33)
            echo "cleo list --type epic"
            ;;
        E_TASK_NOT_IN_SCOPE|34)
            echo "cleo session status"
            ;;
        E_TASK_CLAIMED|35)
            echo "cleo session list --status active"
            ;;
        E_SESSION_REQUIRED|36)
            echo "cleo session start --scope epic:<EPIC_ID>"
            ;;
        E_SESSION_CLOSE_BLOCKED|37)
            echo "cleo list --status pending"
            ;;
        E_FOCUS_REQUIRED|38)
            echo "cleo focus set <task-id>"
            ;;
        E_NOTES_REQUIRED|39)
            echo "cleo session end --note 'Your session summary'"
            ;;
        E_SESSION_DISCOVERY_MODE|100)
            echo "cleo session status"
            ;;
        E_SESSION_RESUME_ACTIVE|30)
            echo "cleo session status"
            ;;
        *)
            echo ""
            ;;
    esac
}

# get_session_error_alternatives - Get alternative actions for session errors
#
# Returns a JSON array of {action, command} objects that agents can choose from.
# Provides multiple recovery paths for flexibility.
#
# Arguments:
#   $1 - error_code : Error code string or exit code number
#   $2 - context    : Optional context JSON (e.g., session ID, scope info)
#
# Returns: JSON array via stdout
#
get_session_error_alternatives() {
    local error_code="$1"
    local context="${2:-}"

    case "$error_code" in
        E_SESSION_EXISTS|E_SESSION_RESUME_ACTIVE|30)
            echo '[{"action":"Check session status","command":"cleo session status"},{"action":"Run command directly","command":"Session already active - run your command without session start/resume"},{"action":"List active sessions","command":"cleo session list --status active"}]'
            ;;
        E_SESSION_NOT_FOUND|31)
            echo '[{"action":"List all sessions","command":"cleo session list"},{"action":"List active sessions","command":"cleo session list --status active"},{"action":"Start new session","command":"cleo session start --scope epic:<EPIC_ID>"}]'
            ;;
        E_SCOPE_CONFLICT|32)
            echo '[{"action":"List active sessions","command":"cleo session list --status active"},{"action":"End conflicting session","command":"cleo session end --session <session-id>"},{"action":"Use different scope","command":"cleo session start --scope epic:<OTHER_EPIC>"}]'
            ;;
        E_SESSION_REQUIRED|36)
            echo '[{"action":"Start session","command":"cleo session start --scope epic:<EPIC_ID>"},{"action":"List available epics","command":"cleo list --type epic"}]'
            ;;
        E_FOCUS_REQUIRED|38)
            echo '[{"action":"Set focus","command":"cleo focus set <task-id>"},{"action":"List pending tasks","command":"cleo list --status pending"}]'
            ;;
        E_SESSION_DISCOVERY_MODE|100)
            echo '[{"action":"Check session status","command":"cleo session status"},{"action":"Run command directly","command":"Session already active - run your command without session start"},{"action":"List active sessions","command":"cleo session list --status active"}]'
            ;;
        *)
            echo '[]'
            ;;
    esac
}

# output_session_error - Output a session error with full context
#
# Convenience function for session errors that automatically includes
# the appropriate suggestion based on error code.
#
# Arguments:
#   $1 - error_code    : Session error code (e.g., E_SESSION_EXISTS)
#   $2 - message       : Specific error message (overrides default if provided)
#   $3 - exit_code     : Exit code number (default: derived from error_code)
#   $4 - context_json  : Optional JSON object with error context
#
# Example:
#   output_session_error "E_TASK_NOT_IN_SCOPE" \
#       "Task T050 is not in epic T001's scope" \
#       34 \
#       '{"taskId":"T050","epicId":"T001","sessionId":"session_abc"}'
#
output_session_error() {
    local error_code="$1"
    local message="${2:-$(get_session_error_message "$error_code")}"
    local exit_code="${3:-}"
    local context_json="${4:-null}"

    # Derive exit code from error code if not provided
    if [[ -z "$exit_code" ]]; then
        case "$error_code" in
            E_SESSION_EXISTS)        exit_code=30 ;;
            E_SESSION_RESUME_ACTIVE) exit_code=30 ;;
            E_SESSION_NOT_FOUND)     exit_code=31 ;;
            E_SCOPE_CONFLICT)        exit_code=32 ;;
            E_SCOPE_INVALID)         exit_code=33 ;;
            E_TASK_NOT_IN_SCOPE)     exit_code=34 ;;
            E_TASK_CLAIMED)          exit_code=35 ;;
            E_SESSION_REQUIRED)      exit_code=36 ;;
            E_SESSION_CLOSE_BLOCKED) exit_code=37 ;;
            E_FOCUS_REQUIRED)        exit_code=38 ;;
            E_NOTES_REQUIRED)        exit_code=39 ;;
            E_SESSION_DISCOVERY_MODE) exit_code=100 ;;
            *)                       exit_code=1 ;;
        esac
    fi

    # Get suggestion, fix, and alternatives for this error (LLM-agent-first)
    local suggestion fix alternatives
    suggestion=$(get_session_error_suggestion "$error_code")
    fix=$(get_session_error_fix "$error_code" "$context_json")
    alternatives=$(get_session_error_alternatives "$error_code" "$context_json")

    # Determine if recoverable (most session errors are recoverable by user action)
    local recoverable="true"
    [[ "$exit_code" -eq 37 ]] && recoverable="false"  # SESSION_CLOSE_BLOCKED

    # Use actionable error output with fix and alternatives
    output_error_actionable "$error_code" "$message" "$exit_code" "$recoverable" \
        "$suggestion" "$fix" "$context_json" "$alternatives"

    return "$exit_code"
}

# ============================================================================
# EXPORTS
# ============================================================================

# Export functions
export -f output_error_json
export -f output_error
export -f output_warning
export -f get_session_error_suggestion
export -f get_session_error_message
export -f get_session_error_fix
export -f get_session_error_alternatives
export -f output_session_error

# Export error code constants
export E_TASK_NOT_FOUND E_TASK_ALREADY_EXISTS E_TASK_INVALID_ID E_TASK_INVALID_STATUS
export E_FILE_NOT_FOUND E_FILE_READ_ERROR E_FILE_WRITE_ERROR E_FILE_PERMISSION
export E_VALIDATION_SCHEMA E_VALIDATION_CHECKSUM E_VALIDATION_REQUIRED
export E_INPUT_MISSING E_INPUT_INVALID E_INPUT_FORMAT
export E_DEPENDENCY_MISSING E_DEPENDENCY_VERSION
export E_PHASE_NOT_FOUND E_PHASE_INVALID
export E_SESSION_ACTIVE E_SESSION_NOT_ACTIVE
# Epic-Bound Session error codes
export E_SESSION_EXISTS E_SESSION_NOT_FOUND E_SCOPE_CONFLICT E_SCOPE_INVALID
export E_TASK_NOT_IN_SCOPE E_TASK_CLAIMED E_SESSION_REQUIRED
export E_SESSION_CLOSE_BLOCKED E_FOCUS_REQUIRED E_NOTES_REQUIRED
# Additional LLM-agent-first session error codes
export E_SESSION_DISCOVERY_MODE E_SESSION_RESUME_ACTIVE
export E_UNKNOWN E_NOT_INITIALIZED E_ALREADY_INITIALIZED E_CONFIRMATION_REQUIRED
# Hierarchy error codes
export E_PARENT_NOT_FOUND E_DEPTH_EXCEEDED E_SIBLING_LIMIT
export E_INVALID_PARENT_TYPE E_CIRCULAR_REFERENCE E_ORPHAN_DETECTED
# Deletion error codes
export E_HAS_CHILDREN E_TASK_COMPLETED E_CASCADE_FAILED E_CANCEL_REASON_REQUIRED
# Concurrency error codes
export E_CHECKSUM_MISMATCH E_CONCURRENT_MODIFICATION E_ID_COLLISION
