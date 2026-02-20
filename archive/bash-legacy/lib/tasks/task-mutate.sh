#!/usr/bin/env bash
# lib/tasks/task-mutate.sh - Centralized task mutation functions
#
# LAYER: 2 (Data Layer)
# DEPENDENCIES: file-ops.sh, logging.sh
# PROVIDES: set_task_updated, apply_task_mutation, get_task, task_exists,
#           set_task_field, append_task_note, mutate_with_timestamp
#
# Design: All task modifications MUST flow through this library to ensure:
#   1. updatedAt timestamp is always set on mutations
#   2. Consistent mutation patterns across all scripts
#   3. Centralized validation and error handling
#
# CRITICAL: Scripts that modify tasks MUST use these functions instead of
#           raw jq mutations to maintain data integrity per schema v2.8.0+.

#=== SOURCE GUARD ================================================
[[ -n "${_TASK_MUTATE_LOADED:-}" ]] && return 0
declare -r _TASK_MUTATE_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_TM_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source file operations library for atomic writes
if [[ -f "$_TM_LIB_DIR/data/file-ops.sh" ]]; then
    # shellcheck source=lib/data/file-ops.sh
    source "$_TM_LIB_DIR/data/file-ops.sh"
fi

# Source logging library for consistent logging
if [[ -f "$_TM_LIB_DIR/core/logging.sh" ]]; then
    # shellcheck source=lib/core/logging.sh
    source "$_TM_LIB_DIR/core/logging.sh"
fi

# ============================================================================
# TIMESTAMP FUNCTIONS
# ============================================================================

#######################################
# Get current ISO 8601 UTC timestamp
# Arguments:
#   None
# Outputs:
#   ISO 8601 timestamp to stdout (e.g., 2026-01-23T07:00:00Z)
# Returns:
#   0 on success
#######################################
get_current_timestamp() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# ============================================================================
# TASK QUERY FUNCTIONS
# ============================================================================

#######################################
# Get a task by ID from JSON content
# Arguments:
#   $1 - JSON content (todo.json content as string)
#   $2 - Task ID (e.g., T001)
# Outputs:
#   Task JSON object to stdout, or empty if not found
# Returns:
#   0 on success, 1 if not found
#######################################
get_task() {
    local json="$1"
    local task_id="$2"

    if [[ -z "$json" || -z "$task_id" ]]; then
        return 1
    fi

    local task
    task=$(echo "$json" | jq -e --arg id "$task_id" '.tasks[] | select(.id == $id)' 2>/dev/null)

    if [[ -z "$task" || "$task" == "null" ]]; then
        return 1
    fi

    echo "$task"
    return 0
}

#######################################
# Get a task by ID from a file
# Arguments:
#   $1 - Task ID (e.g., T001)
#   $2 - File path (default: .cleo/todo.json)
# Outputs:
#   Task JSON object to stdout, or empty if not found
# Returns:
#   0 on success, 1 if not found, 2 if file not found
#######################################
get_task_from_file() {
    local task_id="$1"
    local file="${2:-.cleo/todo.json}"

    if [[ ! -f "$file" ]]; then
        return 2
    fi

    local json
    json=$(cat "$file")
    get_task "$json" "$task_id"
}

#######################################
# Check if a task exists in JSON content
# Arguments:
#   $1 - JSON content (todo.json content as string)
#   $2 - Task ID (e.g., T001)
# Returns:
#   0 if task exists, 1 if not
#######################################
task_exists() {
    local json="$1"
    local task_id="$2"

    local count
    count=$(echo "$json" | jq --arg id "$task_id" '[.tasks[] | select(.id == $id)] | length' 2>/dev/null)

    [[ "$count" -gt 0 ]]
}

#######################################
# Check if a task exists in a file
# Arguments:
#   $1 - Task ID (e.g., T001)
#   $2 - File path (default: .cleo/todo.json)
# Returns:
#   0 if task exists, 1 if not, 2 if file not found
#######################################
task_exists_in_file() {
    local task_id="$1"
    local file="${2:-.cleo/todo.json}"

    if [[ ! -f "$file" ]]; then
        return 2
    fi

    local json
    json=$(cat "$file")
    task_exists "$json" "$task_id"
}

# ============================================================================
# CORE MUTATION FUNCTIONS
# ============================================================================

#######################################
# Set updatedAt timestamp on a task
# Arguments:
#   $1 - JSON content (todo.json content as string)
#   $2 - Task ID (e.g., T001)
#   $3 - Timestamp (optional, defaults to current time)
# Outputs:
#   Updated JSON content to stdout
# Returns:
#   0 on success, 1 on error
# Notes:
#   MUST be called after any task modification to maintain data integrity.
#   This is the single source of truth for updatedAt timestamps.
#######################################
set_task_updated() {
    local json="$1"
    local task_id="$2"
    local timestamp="${3:-$(get_current_timestamp)}"

    if [[ -z "$json" || -z "$task_id" ]]; then
        echo "ERROR: set_task_updated requires json and task_id" >&2
        return 1
    fi

    # Verify task exists
    if ! task_exists "$json" "$task_id"; then
        echo "ERROR: Task $task_id not found" >&2
        return 1
    fi

    echo "$json" | jq --arg id "$task_id" --arg ts "$timestamp" '
        .tasks = [.tasks[] |
            if .id == $id then .updatedAt = $ts else . end
        ]
    '
}

#######################################
# Apply a jq mutation to a task with automatic updatedAt
# Arguments:
#   $1 - JSON content (todo.json content as string)
#   $2 - Task ID (e.g., T001)
#   $3 - jq mutation expression (e.g., '.status = "active"')
#   $4 - Timestamp (optional, defaults to current time)
# Outputs:
#   Updated JSON content to stdout
# Returns:
#   0 on success, 1 on error
# Notes:
#   This is the PRIMARY function for task mutations.
#   It ensures updatedAt is always set after any change.
#######################################
apply_task_mutation() {
    local json="$1"
    local task_id="$2"
    local mutation="$3"
    local timestamp="${4:-$(get_current_timestamp)}"

    if [[ -z "$json" || -z "$task_id" || -z "$mutation" ]]; then
        echo "ERROR: apply_task_mutation requires json, task_id, and mutation" >&2
        return 1
    fi

    # Verify task exists
    if ! task_exists "$json" "$task_id"; then
        echo "ERROR: Task $task_id not found" >&2
        return 1
    fi

    # Apply the mutation first
    local mutated_json
    mutated_json=$(echo "$json" | jq --arg id "$task_id" "
        .tasks = [.tasks[] |
            if .id == \$id then $mutation else . end
        ]
    ") || {
        echo "ERROR: jq mutation failed" >&2
        return 1
    }

    # Then set updatedAt
    set_task_updated "$mutated_json" "$task_id" "$timestamp"
}

#######################################
# Set a specific field on a task with automatic updatedAt
# Arguments:
#   $1 - JSON content (todo.json content as string)
#   $2 - Task ID (e.g., T001)
#   $3 - Field name (e.g., "status", "priority")
#   $4 - Field value (string value)
#   $5 - Timestamp (optional)
# Outputs:
#   Updated JSON content to stdout
# Returns:
#   0 on success, 1 on error
# Notes:
#   Convenience wrapper for common single-field updates.
#######################################
set_task_field() {
    local json="$1"
    local task_id="$2"
    local field="$3"
    local value="$4"
    local timestamp="${5:-$(get_current_timestamp)}"

    if [[ -z "$field" ]]; then
        echo "ERROR: set_task_field requires field name" >&2
        return 1
    fi

    # Build mutation expression with proper quoting
    local mutation=".${field} = \$value"

    echo "$json" | jq --arg id "$task_id" --arg value "$value" --arg ts "$timestamp" "
        .tasks = [.tasks[] |
            if .id == \$id then
                .${field} = \$value |
                .updatedAt = \$ts
            else . end
        ]
    "
}

#######################################
# Set a numeric field on a task with automatic updatedAt
# Arguments:
#   $1 - JSON content (todo.json content as string)
#   $2 - Task ID (e.g., T001)
#   $3 - Field name (e.g., "position")
#   $4 - Field value (numeric)
#   $5 - Timestamp (optional)
# Outputs:
#   Updated JSON content to stdout
# Returns:
#   0 on success, 1 on error
#######################################
set_task_field_numeric() {
    local json="$1"
    local task_id="$2"
    local field="$3"
    local value="$4"
    local timestamp="${5:-$(get_current_timestamp)}"

    if [[ -z "$field" ]]; then
        echo "ERROR: set_task_field_numeric requires field name" >&2
        return 1
    fi

    echo "$json" | jq --arg id "$task_id" --argjson value "$value" --arg ts "$timestamp" "
        .tasks = [.tasks[] |
            if .id == \$id then
                .${field} = \$value |
                .updatedAt = \$ts
            else . end
        ]
    "
}

#######################################
# Set a boolean field on a task with automatic updatedAt
# Arguments:
#   $1 - JSON content (todo.json content as string)
#   $2 - Task ID (e.g., T001)
#   $3 - Field name (e.g., "noAutoComplete")
#   $4 - Field value ("true" or "false")
#   $5 - Timestamp (optional)
# Outputs:
#   Updated JSON content to stdout
# Returns:
#   0 on success, 1 on error
#######################################
set_task_field_bool() {
    local json="$1"
    local task_id="$2"
    local field="$3"
    local value="$4"
    local timestamp="${5:-$(get_current_timestamp)}"

    if [[ -z "$field" ]]; then
        echo "ERROR: set_task_field_bool requires field name" >&2
        return 1
    fi

    # Convert string to JSON boolean
    local json_bool="false"
    [[ "$value" == "true" ]] && json_bool="true"

    echo "$json" | jq --arg id "$task_id" --argjson value "$json_bool" --arg ts "$timestamp" "
        .tasks = [.tasks[] |
            if .id == \$id then
                .${field} = \$value |
                .updatedAt = \$ts
            else . end
        ]
    "
}

#######################################
# Append a note to a task with automatic updatedAt
# Arguments:
#   $1 - JSON content (todo.json content as string)
#   $2 - Task ID (e.g., T001)
#   $3 - Note text (will be timestamped)
#   $4 - Timestamp (optional)
# Outputs:
#   Updated JSON content to stdout
# Returns:
#   0 on success, 1 on error
# Notes:
#   Notes are automatically prefixed with timestamp.
#######################################
append_task_note() {
    local json="$1"
    local task_id="$2"
    local note="$3"
    local timestamp="${4:-$(get_current_timestamp)}"

    if [[ -z "$note" ]]; then
        echo "ERROR: append_task_note requires note text" >&2
        return 1
    fi

    # Format note with timestamp
    local formatted_note
    formatted_note="$(date -u +"%Y-%m-%d %H:%M:%S UTC"): $note"

    echo "$json" | jq --arg id "$task_id" --arg note "$formatted_note" --arg ts "$timestamp" '
        .tasks = [.tasks[] |
            if .id == $id then
                .notes = ((.notes // []) + [$note]) |
                .updatedAt = $ts
            else . end
        ]
    '
}

#######################################
# Delete a field from a task with automatic updatedAt
# Arguments:
#   $1 - JSON content (todo.json content as string)
#   $2 - Task ID (e.g., T001)
#   $3 - Field name to delete (e.g., "blockedBy")
#   $4 - Timestamp (optional)
# Outputs:
#   Updated JSON content to stdout
# Returns:
#   0 on success, 1 on error
#######################################
delete_task_field() {
    local json="$1"
    local task_id="$2"
    local field="$3"
    local timestamp="${4:-$(get_current_timestamp)}"

    if [[ -z "$field" ]]; then
        echo "ERROR: delete_task_field requires field name" >&2
        return 1
    fi

    echo "$json" | jq --arg id "$task_id" --arg ts "$timestamp" "
        .tasks = [.tasks[] |
            if .id == \$id then
                del(.${field}) |
                .updatedAt = \$ts
            else . end
        ]
    "
}

# ============================================================================
# BATCH MUTATION FUNCTIONS
# ============================================================================

#######################################
# Apply mutations to multiple tasks with automatic updatedAt
# Arguments:
#   $1 - JSON content (todo.json content as string)
#   $2 - jq filter expression to select tasks (e.g., '.status == "pending"')
#   $3 - jq mutation expression (e.g., '.priority = "high"')
#   $4 - Timestamp (optional)
# Outputs:
#   Updated JSON content to stdout
# Returns:
#   0 on success, 1 on error
# Notes:
#   Use with caution - modifies all tasks matching the filter.
#######################################
apply_batch_mutation() {
    local json="$1"
    local filter="$2"
    local mutation="$3"
    local timestamp="${4:-$(get_current_timestamp)}"

    if [[ -z "$filter" || -z "$mutation" ]]; then
        echo "ERROR: apply_batch_mutation requires filter and mutation" >&2
        return 1
    fi

    echo "$json" | jq --arg ts "$timestamp" "
        .tasks = [.tasks[] |
            if $filter then
                $mutation |
                .updatedAt = \$ts
            else . end
        ]
    "
}

# ============================================================================
# HIGH-LEVEL MUTATION WRAPPERS
# ============================================================================

#######################################
# Complete a task (set status=done, add completedAt)
# Arguments:
#   $1 - JSON content (todo.json content as string)
#   $2 - Task ID (e.g., T001)
#   $3 - Completion note (optional)
#   $4 - Timestamp (optional)
# Outputs:
#   Updated JSON content to stdout
# Returns:
#   0 on success, 1 on error
#######################################
complete_task_mutation() {
    local json="$1"
    local task_id="$2"
    local note="${3:-}"
    local timestamp="${4:-$(get_current_timestamp)}"

    # Build the mutation
    local mutation=".status = \"done\" | .completedAt = \$ts | del(.blockedBy)"

    # Add note if provided
    if [[ -n "$note" ]]; then
        local formatted_note="[COMPLETED $timestamp] $note"
        mutation="$mutation | .notes = ((.notes // []) + [\"$formatted_note\"])"
    fi

    echo "$json" | jq --arg id "$task_id" --arg ts "$timestamp" "
        .tasks = [.tasks[] |
            if .id == \$id then
                $mutation |
                .updatedAt = \$ts
            else . end
        ]
    "
}

#######################################
# Set task status with automatic updatedAt
# Arguments:
#   $1 - JSON content (todo.json content as string)
#   $2 - Task ID (e.g., T001)
#   $3 - New status (pending|active|blocked|done)
#   $4 - Timestamp (optional)
# Outputs:
#   Updated JSON content to stdout
# Returns:
#   0 on success, 1 on error
#######################################
set_task_status() {
    local json="$1"
    local task_id="$2"
    local status="$3"
    local timestamp="${4:-$(get_current_timestamp)}"

    # Validate status
    case "$status" in
        pending|active|blocked|done) ;;
        *)
            echo "ERROR: Invalid status: $status" >&2
            return 1
            ;;
    esac

    set_task_field "$json" "$task_id" "status" "$status" "$timestamp"
}

#######################################
# Set task priority with automatic updatedAt
# Arguments:
#   $1 - JSON content (todo.json content as string)
#   $2 - Task ID (e.g., T001)
#   $3 - New priority (critical|high|medium|low)
#   $4 - Timestamp (optional)
# Outputs:
#   Updated JSON content to stdout
# Returns:
#   0 on success, 1 on error
#######################################
set_task_priority() {
    local json="$1"
    local task_id="$2"
    local priority="$3"
    local timestamp="${4:-$(get_current_timestamp)}"

    # Validate priority
    case "$priority" in
        critical|high|medium|low) ;;
        *)
            echo "ERROR: Invalid priority: $priority" >&2
            return 1
            ;;
    esac

    set_task_field "$json" "$task_id" "priority" "$priority" "$timestamp"
}

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

#######################################
# Update lastUpdated timestamp on todo.json root
# Arguments:
#   $1 - JSON content (todo.json content as string)
#   $2 - Timestamp (optional)
# Outputs:
#   Updated JSON content to stdout
# Returns:
#   0 on success
#######################################
set_last_updated() {
    local json="$1"
    local timestamp="${2:-$(get_current_timestamp)}"

    echo "$json" | jq --arg ts "$timestamp" '.lastUpdated = $ts'
}

#######################################
# Recalculate checksum after mutations
# Arguments:
#   $1 - JSON content (todo.json content as string)
# Outputs:
#   Updated JSON content with new checksum to stdout
# Returns:
#   0 on success
#######################################
recalculate_checksum() {
    local json="$1"

    local tasks_json
    tasks_json=$(echo "$json" | jq -c '.tasks')

    local checksum
    checksum=$(echo "$tasks_json" | sha256sum | cut -c1-16)

    echo "$json" | jq --arg cs "$checksum" '._meta.checksum = $cs'
}

#######################################
# Finalize mutations: update lastUpdated and checksum
# Arguments:
#   $1 - JSON content (todo.json content as string)
#   $2 - Timestamp (optional)
# Outputs:
#   Updated JSON content with checksum and lastUpdated to stdout
# Returns:
#   0 on success
# Notes:
#   Call this after all mutations are complete, before saving.
#######################################
finalize_mutations() {
    local json="$1"
    local timestamp="${2:-$(get_current_timestamp)}"

    # Update lastUpdated
    json=$(set_last_updated "$json" "$timestamp")

    # Recalculate checksum
    recalculate_checksum "$json"
}

# Export functions
export -f get_current_timestamp
export -f get_task
export -f get_task_from_file
export -f task_exists
export -f task_exists_in_file
export -f set_task_updated
export -f apply_task_mutation
export -f set_task_field
export -f set_task_field_numeric
export -f set_task_field_bool
export -f append_task_note
export -f delete_task_field
export -f apply_batch_mutation
export -f complete_task_mutation
export -f set_task_status
export -f set_task_priority
export -f set_last_updated
export -f recalculate_checksum
export -f finalize_mutations
