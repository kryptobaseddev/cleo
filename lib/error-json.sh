#!/usr/bin/env bash
# Standardized error JSON output for cleo
#
# LAYER: 1 (Core Infrastructure)
# DEPENDENCIES: exit-codes.sh, platform-compat.sh
# PROVIDES: output_error, output_error_with_context, format_error_json,
#           add_error_context, get_error_code_name
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

_ERROR_JSON_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source exit codes
if [[ -f "$_ERROR_JSON_LIB_DIR/exit-codes.sh" ]]; then
    # shellcheck source=lib/exit-codes.sh
    source "$_ERROR_JSON_LIB_DIR/exit-codes.sh"
else
    echo "ERROR: Cannot find exit-codes.sh in $_ERROR_JSON_LIB_DIR" >&2
    exit 1
fi

# Source platform compatibility for get_iso_timestamp if available
if [[ -f "$_ERROR_JSON_LIB_DIR/platform-compat.sh" ]]; then
    # shellcheck source=lib/platform-compat.sh
    source "$_ERROR_JSON_LIB_DIR/platform-compat.sh"
fi

# ============================================================================
# VERSION
# ============================================================================

_CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

if [[ -f "$_CLEO_HOME/VERSION" ]]; then
    _ERROR_JSON_VERSION="$(cat "$_CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$_ERROR_JSON_LIB_DIR/../VERSION" ]]; then
    _ERROR_JSON_VERSION="$(cat "$_ERROR_JSON_LIB_DIR/../VERSION" | tr -d '[:space:]')"
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

    # Build JSON using jq
    jq -n \
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

        jq -n \
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

# Session errors
readonly E_SESSION_ACTIVE="E_SESSION_ACTIVE"
readonly E_SESSION_NOT_ACTIVE="E_SESSION_NOT_ACTIVE"

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
# EXPORTS
# ============================================================================

# Export functions
export -f output_error_json
export -f output_error
export -f output_warning

# Export error code constants
export E_TASK_NOT_FOUND E_TASK_ALREADY_EXISTS E_TASK_INVALID_ID E_TASK_INVALID_STATUS
export E_FILE_NOT_FOUND E_FILE_READ_ERROR E_FILE_WRITE_ERROR E_FILE_PERMISSION
export E_VALIDATION_SCHEMA E_VALIDATION_CHECKSUM E_VALIDATION_REQUIRED
export E_INPUT_MISSING E_INPUT_INVALID E_INPUT_FORMAT
export E_DEPENDENCY_MISSING E_DEPENDENCY_VERSION
export E_PHASE_NOT_FOUND E_PHASE_INVALID
export E_SESSION_ACTIVE E_SESSION_NOT_ACTIVE
export E_UNKNOWN E_NOT_INITIALIZED E_ALREADY_INITIALIZED E_CONFIRMATION_REQUIRED
# Hierarchy error codes
export E_PARENT_NOT_FOUND E_DEPTH_EXCEEDED E_SIBLING_LIMIT
export E_INVALID_PARENT_TYPE E_CIRCULAR_REFERENCE E_ORPHAN_DETECTED
# Deletion error codes
export E_HAS_CHILDREN E_TASK_COMPLETED E_CASCADE_FAILED E_CANCEL_REASON_REQUIRED
# Concurrency error codes
export E_CHECKSUM_MISMATCH E_CONCURRENT_MODIFICATION E_ID_COLLISION
