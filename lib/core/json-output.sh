#!/usr/bin/env bash
# json-output.sh - Centralized JSON output formatting with pagination support
#
# LAYER: 1 (Core Infrastructure)
# DEPENDENCIES: version.sh, platform-compat.sh
# PROVIDES: output_success, output_error_envelope, output_paginated,
#           apply_pagination, get_pagination_meta, get_default_limit,
#           compact_task, compact_session
#
# Centralizes the JSON envelope pattern used across all CLEO commands.
# Every command builds the same envelope structure inline today; this
# library extracts that into reusable functions with built-in pagination.
#
# Envelope format:
#   {
#     "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
#     "_meta": {
#       "format": "json",
#       "command": "<command>",
#       "timestamp": "<ISO8601>",
#       "version": "<CLEO_VERSION>"
#     },
#     "success": true,
#     "pagination": { ... },   // optional, only for paginated output
#     "<data_key>": ...
#   }
#
# @task T1435 T1437

#=== SOURCE GUARD ================================================
[[ -n "${_JSON_OUTPUT_LOADED:-}" ]] && return 0
declare -r _JSON_OUTPUT_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_JSON_OUTPUT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source version management (Layer 0)
if [[ -f "$_JSON_OUTPUT_LIB_DIR/core/version.sh" ]]; then
    # shellcheck source=lib/core/version.sh
    source "$_JSON_OUTPUT_LIB_DIR/core/version.sh"
fi

# Source platform compatibility for get_iso_timestamp (Layer 0)
if [[ -f "$_JSON_OUTPUT_LIB_DIR/core/platform-compat.sh" ]]; then
    # shellcheck source=lib/core/platform-compat.sh
    source "$_JSON_OUTPUT_LIB_DIR/core/platform-compat.sh"
fi

# ============================================================================
# INTERNAL HELPERS
# ============================================================================

# _json_output_version - Get CLEO version string
#
# Uses CLEO_VERSION if set, falls back to get_version(), then VERSION, then "unknown"
#
# Returns: Version string via stdout
_json_output_version() {
    if [[ -n "${CLEO_VERSION:-}" ]]; then
        echo "$CLEO_VERSION"
    elif declare -f get_version >/dev/null 2>&1; then
        get_version
    elif [[ -n "${VERSION:-}" ]]; then
        echo "$VERSION"
    else
        echo "unknown"
    fi
}

# _json_output_timestamp - Get ISO 8601 timestamp
#
# Uses platform-compat get_iso_timestamp if available, falls back to date.
#
# Returns: ISO 8601 timestamp string via stdout
_json_output_timestamp() {
    if declare -f get_iso_timestamp >/dev/null 2>&1; then
        get_iso_timestamp
    else
        date -u +"%Y-%m-%dT%H:%M:%SZ"
    fi
}

# ============================================================================
# CORE ENVELOPE BUILDERS
# ============================================================================

# output_success - Build a standard JSON success envelope
#
# Constructs the canonical CLEO JSON output envelope with success=true.
# The data is injected under the specified key.
#
# Arguments:
#   $1 - command    : Command name (e.g., "list", "find", "show")
#   $2 - data_key   : Key name for the data payload (e.g., "tasks", "task", "matches")
#   $3 - data_value  : JSON value for the data payload (string, object, or array)
#
# Optional environment variables:
#   COMMAND_NAME - Falls back to $1 if not set
#
# Output: JSON envelope to stdout
#
# Example:
#   output_success "show" "task" "$task_json"
#
output_success() {
    local command="$1"
    local data_key="$2"
    local data_value="$3"

    local version timestamp
    version=$(_json_output_version)
    timestamp=$(_json_output_timestamp)

    jq -nc \
        --arg version "$version" \
        --arg command "$command" \
        --arg timestamp "$timestamp" \
        --arg data_key "$data_key" \
        --argjson data_value "$data_value" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "command": $command,
                "timestamp": $timestamp,
                "version": $version
            },
            "success": true,
            ($data_key): $data_value
        }'
}

# output_error_envelope - Build a standard JSON error envelope
#
# Constructs the canonical CLEO JSON error envelope with success=false.
# For richer error output with fix/alternatives, use error-json.sh instead.
#
# Arguments:
#   $1 - command  : Command name (e.g., "list", "find")
#   $2 - code     : Error code string (e.g., "E_TASK_NOT_FOUND")
#   $3 - message  : Human-readable error message
#
# Output: JSON error envelope to stdout
#
# Example:
#   output_error_envelope "show" "E_TASK_NOT_FOUND" "Task T999 not found"
#
output_error_envelope() {
    local command="$1"
    local code="$2"
    local message="$3"

    local version timestamp
    version=$(_json_output_version)
    timestamp=$(_json_output_timestamp)

    jq -nc \
        --arg version "$version" \
        --arg command "$command" \
        --arg timestamp "$timestamp" \
        --arg code "$code" \
        --arg message "$message" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/error.schema.json",
            "_meta": {
                "format": "json",
                "command": $command,
                "timestamp": $timestamp,
                "version": $version
            },
            "success": false,
            "error": {
                "code": $code,
                "message": $message
            }
        }'
}

# output_paginated - Build a paginated JSON success envelope
#
# Constructs the CLEO JSON envelope with pagination metadata.
# The pagination object follows the MCP schema at
# mcp-server/schemas/common/pagination.schema.json.
#
# Arguments:
#   $1 - command    : Command name (e.g., "list", "find")
#   $2 - data_key   : Key name for the data payload (e.g., "tasks", "sessions")
#   $3 - items_json  : JSON array of items (already sliced to the current page)
#   $4 - total       : Total count of items before pagination
#   $5 - limit       : Page size limit
#   $6 - offset      : Current page offset
#
# Output: JSON envelope with pagination to stdout
#
# Example:
#   output_paginated "list" "tasks" "$page_items" 150 50 0
#
output_paginated() {
    local command="$1"
    local data_key="$2"
    local items_json="$3"
    local total="$4"
    local limit="$5"
    local offset="$6"

    local version timestamp has_more
    version=$(_json_output_version)
    timestamp=$(_json_output_timestamp)

    # Calculate hasMore
    if (( offset + limit < total )); then
        has_more="true"
    else
        has_more="false"
    fi

    jq -nc \
        --arg version "$version" \
        --arg command "$command" \
        --arg timestamp "$timestamp" \
        --arg data_key "$data_key" \
        --argjson items "$items_json" \
        --argjson total "$total" \
        --argjson limit "$limit" \
        --argjson offset "$offset" \
        --argjson has_more "$has_more" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "command": $command,
                "timestamp": $timestamp,
                "version": $version
            },
            "success": true,
            "pagination": {
                "total": $total,
                "limit": $limit,
                "offset": $offset,
                "hasMore": $has_more
            },
            ($data_key): $items
        }'
}

# ============================================================================
# PAGINATION HELPERS
# ============================================================================

# apply_pagination - Slice a JSON array with limit and offset
#
# Takes a full JSON array and returns the subset defined by limit/offset.
# If limit is 0 or empty, returns all items from offset onward.
#
# Arguments:
#   $1 - items_json : JSON array to paginate
#   $2 - limit      : Maximum items to return (0 = unlimited)
#   $3 - offset     : Number of items to skip (default: 0)
#
# Output: JSON array (sliced) to stdout
#
# Example:
#   page=$(apply_pagination "$all_tasks" 50 0)
#
apply_pagination() {
    local items_json="$1"
    local limit="${2:-0}"
    local offset="${3:-0}"

    if [[ "$limit" -gt 0 ]]; then
        echo "$items_json" | jq -c \
            --argjson limit "$limit" \
            --argjson offset "$offset" \
            '.[$offset:($offset + $limit)]'
    elif [[ "$offset" -gt 0 ]]; then
        echo "$items_json" | jq -c \
            --argjson offset "$offset" \
            '.[$offset:]'
    else
        echo "$items_json"
    fi
}

# get_pagination_meta - Generate pagination metadata object
#
# Builds a pagination JSON object compatible with the MCP pagination schema.
#
# Arguments:
#   $1 - total  : Total items available
#   $2 - limit  : Page size
#   $3 - offset : Current offset
#
# Output: JSON pagination object to stdout
#
# Example:
#   meta=$(get_pagination_meta 150 50 0)
#   # {"total":150,"limit":50,"offset":0,"hasMore":true}
#
get_pagination_meta() {
    local total="$1"
    local limit="$2"
    local offset="$3"

    local has_more
    if (( offset + limit < total )); then
        has_more="true"
    else
        has_more="false"
    fi

    jq -nc \
        --argjson total "$total" \
        --argjson limit "$limit" \
        --argjson offset "$offset" \
        --argjson has_more "$has_more" \
        '{
            "total": $total,
            "limit": $limit,
            "offset": $offset,
            "hasMore": $has_more
        }'
}

# get_default_limit - Get smart default page size for a command type
#
# Returns appropriate default limits based on command/data type.
# These defaults balance context efficiency with usefulness.
#
# Arguments:
#   $1 - command_name : Command or data type name
#
# Output: Integer limit to stdout
#
# Defaults:
#   tasks    -> 50
#   sessions -> 10
#   search   -> 10
#   find     -> 10
#   logs     -> 20
#   archive  -> 25
#   *        -> 50
#
get_default_limit() {
    local command_name="$1"

    case "$command_name" in
        list|tasks)     echo 50 ;;
        session*|sessions) echo 10 ;;
        search|find)    echo 10 ;;
        log|logs)       echo 20 ;;
        archive*)       echo 25 ;;
        *)              echo 50 ;;
    esac
}

# ============================================================================
# COMPACT OUTPUT HELPERS
# ============================================================================

# compact_task - Strip verbose fields from a task for list views
#
# Removes notes, full descriptions, acceptance criteria, and other
# verbose fields that bloat list output. Keeps fields needed for
# task identification and status assessment.
#
# Arguments:
#   $1 - task_json : Full task JSON object
#
# Output: Compact task JSON to stdout
#
# Kept fields: id, title, status, priority, type, parentId, phase,
#              labels, depends, blockedBy, createdAt, completedAt
# Removed: notes, description, acceptance, files, verification, _archive
#
compact_task() {
    local task_json="$1"

    echo "$task_json" | jq -c '{
        id,
        title,
        status,
        priority,
        type,
        parentId,
        phase,
        labels,
        depends,
        blockedBy,
        createdAt,
        completedAt
    } | with_entries(select(.value != null))'
}

# compact_session - Strip verbose fields from a session for list views
#
# Removes focusHistory, detailed stats, and other verbose fields.
# Keeps fields needed for session identification and status.
#
# Arguments:
#   $1 - session_json : Full session JSON object
#
# Output: Compact session JSON to stdout
#
# Kept fields: id, name, status, scope, focus.currentTask, startedAt, endedAt
# Removed: focusHistory, stats, taskSnapshots, notes (full), events
#
compact_session() {
    local session_json="$1"

    echo "$session_json" | jq -c '{
        id,
        name,
        status,
        scope,
        focus: (if .focus then {currentTask: .focus.currentTask} else null end),
        startedAt,
        endedAt
    } | with_entries(select(.value != null))'
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f _json_output_version
export -f _json_output_timestamp
export -f output_success
export -f output_error_envelope
export -f output_paginated
export -f apply_pagination
export -f get_pagination_meta
export -f get_default_limit
export -f compact_task
export -f compact_session
