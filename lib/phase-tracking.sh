#!/usr/bin/env bash
# phase-tracking.sh - Project-level phase tracking for claude-todo
# Part of the v2.2.0 phase management feature

set -euo pipefail

# Library dependencies
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_LIB_DIR/platform-compat.sh"
source "$_LIB_DIR/file-ops.sh"

# ============================================================================
# CONSTANTS
# ============================================================================

readonly VALID_PHASE_STATUSES=("pending" "active" "completed")

# ============================================================================
# PHASE QUERY FUNCTIONS
# ============================================================================

# Get current project phase from todo.json
# Args: $1 = todo file path (optional, defaults to TODO_FILE)
# Returns: phase slug or empty string if not set
get_current_phase() {
    local todo_file="${1:-$TODO_FILE}"
    jq -r '.project.currentPhase // empty' "$todo_file"
}

# Get all phase definitions
# Args: $1 = todo file path
# Returns: JSON object of phases
get_all_phases() {
    local todo_file="${1:-$TODO_FILE}"
    jq '.project.phases // {}' "$todo_file"
}

# Get phase details by slug
# Args: $1 = phase slug, $2 = todo file path
# Returns: JSON phase object or null
get_phase() {
    local slug="$1"
    local todo_file="${2:-$TODO_FILE}"
    jq --arg slug "$slug" '.project.phases[$slug] // null' "$todo_file"
}

# Get phase status
# Args: $1 = phase slug, $2 = todo file path
# Returns: status string (pending|active|completed)
get_phase_status() {
    local slug="$1"
    local todo_file="${2:-$TODO_FILE}"
    jq -r --arg slug "$slug" '.project.phases[$slug].status // "pending"' "$todo_file"
}

# Count phases by status
# Args: $1 = status, $2 = todo file path
# Returns: count
count_phases_by_status() {
    local status="$1"
    local todo_file="${2:-$TODO_FILE}"
    jq --arg status "$status" '[.project.phases | to_entries[] | select(.value.status == $status)] | length' "$todo_file"
}

# ============================================================================
# PHASE MODIFICATION FUNCTIONS
# ============================================================================

# Set current project phase
# Args: $1 = phase slug, $2 = todo file path
# Returns: 0 on success, 1 on error
set_current_phase() {
    local slug="$1"
    local todo_file="${2:-$TODO_FILE}"
    local temp_file

    # Validate phase exists
    if ! jq -e --arg slug "$slug" '.project.phases[$slug]' "$todo_file" >/dev/null 2>&1; then
        echo "ERROR: Phase '$slug' does not exist" >&2
        return 1
    fi

    temp_file=$(mktemp)
    local timestamp
    timestamp=$(get_iso_timestamp)

    jq --arg slug "$slug" --arg ts "$timestamp" '
        .project.currentPhase = $slug |
        .focus.currentPhase = $slug |
        .lastUpdated = $ts
    ' "$todo_file" > "$temp_file" && mv "$temp_file" "$todo_file"
}

# Start a phase (transition from pending to active)
# Args: $1 = phase slug, $2 = todo file path
# Returns: 0 on success, 1 on error
start_phase() {
    local slug="$1"
    local todo_file="${2:-$TODO_FILE}"
    local current_status
    local temp_file

    current_status=$(get_phase_status "$slug" "$todo_file")

    if [[ "$current_status" != "pending" ]]; then
        echo "ERROR: Can only start pending phases (current: $current_status)" >&2
        return 1
    fi

    temp_file=$(mktemp)
    local timestamp
    timestamp=$(get_iso_timestamp)

    jq --arg slug "$slug" --arg ts "$timestamp" '
        .project.phases[$slug].status = "active" |
        .project.phases[$slug].startedAt = $ts |
        .project.currentPhase = $slug |
        .focus.currentPhase = $slug |
        .lastUpdated = $ts
    ' "$todo_file" > "$temp_file" && mv "$temp_file" "$todo_file"
}

# Complete a phase (transition from active to completed)
# Args: $1 = phase slug, $2 = todo file path
# Returns: 0 on success, 1 on error
complete_phase() {
    local slug="$1"
    local todo_file="${2:-$TODO_FILE}"
    local current_status
    local temp_file

    current_status=$(get_phase_status "$slug" "$todo_file")

    if [[ "$current_status" != "active" ]]; then
        echo "ERROR: Can only complete active phases (current: $current_status)" >&2
        return 1
    fi

    # Check for incomplete tasks in this phase
    local incomplete_count
    incomplete_count=$(jq --arg phase "$slug" '
        [.tasks[] | select(.phase == $phase and .status != "done")] | length
    ' "$todo_file")

    if [[ "$incomplete_count" -gt 0 ]]; then
        echo "ERROR: Cannot complete phase '$slug' - $incomplete_count incomplete task(s) pending" >&2
        return 1
    fi

    temp_file=$(mktemp)
    local timestamp
    timestamp=$(get_iso_timestamp)

    jq --arg slug "$slug" --arg ts "$timestamp" '
        .project.phases[$slug].status = "completed" |
        .project.phases[$slug].completedAt = $ts |
        .lastUpdated = $ts
    ' "$todo_file" > "$temp_file" && mv "$temp_file" "$todo_file"
}

# Advance to next phase (complete current if needed, start next)
# Args: $1 = todo file path
# Returns: 0 on success, 1 if no next phase
advance_phase() {
    local todo_file="${1:-$TODO_FILE}"
    local current_phase
    local current_order
    local current_status
    local next_phase

    current_phase=$(get_current_phase "$todo_file")

    if [[ -z "$current_phase" ]]; then
        echo "ERROR: No current phase set" >&2
        return 1
    fi

    current_order=$(jq -r --arg slug "$current_phase" '.project.phases[$slug].order // 0' "$todo_file")
    current_status=$(get_phase_status "$current_phase" "$todo_file")

    # Find next phase by order
    next_phase=$(jq -r --argjson order "$current_order" '
        .project.phases | to_entries
        | sort_by(.value.order)
        | map(select(.value.order > $order))
        | first.key // empty
    ' "$todo_file")

    if [[ -z "$next_phase" ]]; then
        echo "INFO: No more phases after '$current_phase'" >&2
        return 1
    fi

    # Complete current phase if still active (skip if already completed)
    if [[ "$current_status" == "active" ]]; then
        complete_phase "$current_phase" "$todo_file" || return 1
    fi

    # Start next phase
    start_phase "$next_phase" "$todo_file" || return 1

    echo "Advanced from '$current_phase' to '$next_phase'"
}

# ============================================================================
# PHASE VALIDATION FUNCTIONS
# ============================================================================

# Validate only one phase is active
# Args: $1 = todo file path
# Returns: 0 if valid, 1 if multiple active
validate_single_active_phase() {
    local todo_file="${1:-$TODO_FILE}"
    local active_count

    active_count=$(count_phases_by_status "active" "$todo_file")

    if [[ "$active_count" -gt 1 ]]; then
        echo "ERROR: Multiple active phases detected ($active_count)" >&2
        return 1
    fi

    return 0
}

# Validate currentPhase matches an active phase
# Args: $1 = todo file path
# Returns: 0 if valid, 1 if mismatch
validate_current_phase_consistency() {
    local todo_file="${1:-$TODO_FILE}"
    local current_phase
    local phase_status

    current_phase=$(get_current_phase "$todo_file")

    if [[ -z "$current_phase" || "$current_phase" == "null" ]]; then
        return 0  # No current phase is valid
    fi

    phase_status=$(get_phase_status "$current_phase" "$todo_file")

    if [[ "$phase_status" != "active" ]]; then
        echo "ERROR: Current phase '$current_phase' has status '$phase_status', expected 'active'" >&2
        return 1
    fi

    return 0
}

# Check if task phase matches project phase (warning only)
# Args: $1 = task phase, $2 = todo file path
# Returns: 0 if match, 1 if mismatch (warning issued)
check_phase_context() {
    local task_phase="$1"
    local todo_file="${2:-$TODO_FILE}"
    local project_phase

    project_phase=$(get_current_phase "$todo_file")

    if [[ -z "$project_phase" || -z "$task_phase" ]]; then
        return 0  # No comparison possible
    fi

    if [[ "$task_phase" != "$project_phase" ]]; then
        echo "WARN: Task phase '$task_phase' differs from project phase '$project_phase'" >&2
        return 1
    fi

    return 0
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f get_current_phase
export -f get_all_phases
export -f get_phase
export -f get_phase_status
export -f count_phases_by_status
export -f set_current_phase
export -f start_phase
export -f complete_phase
export -f advance_phase
export -f validate_single_active_phase
export -f validate_current_phase_consistency
export -f check_phase_context
