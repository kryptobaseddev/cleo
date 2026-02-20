#!/usr/bin/env bash
# Project-level phase tracking for cleo
#
# LAYER: 3 (Domain Logic)
# DEPENDENCIES: file-ops.sh (transitive: platform-compat.sh)
# PROVIDES: get_current_phase, set_current_phase, get_all_phases, get_phase,
#           validate_phase_slug, update_phase_status, get_phase_progress,
#           get_phase_order, get_phase_distance

#=== SOURCE GUARD ================================================
[[ -n "${_PHASE_TRACKING_LOADED:-}" ]] && return 0
declare -r _PHASE_TRACKING_LOADED=1

set -euo pipefail

# Library dependencies
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$_LIB_DIR/data/file-ops.sh"

# ============================================================================
# CONSTANTS (guarded to prevent readonly collision on re-source)
# ============================================================================

# Valid phase statuses
if [[ -z "${VALID_PHASE_STATUSES:-}" ]]; then
    readonly VALID_PHASE_STATUSES=("pending" "active" "completed")
fi

# ============================================================================
# PHASE QUERY FUNCTIONS
# ============================================================================

# Get current project phase from todo.json
# Args: $1 = todo file path (optional, defaults to TODO_FILE)
# Returns: phase slug or empty string if not set
get_current_phase() {
    local todo_file="${1:-$TODO_FILE}"
    # Guard against missing file - jq hangs on stdin if file doesn't exist
    [[ -f "$todo_file" ]] || { echo ""; return 1; }
    jq -r '.project.currentPhase // empty' "$todo_file"
}

# Get all phase definitions
# Args: $1 = todo file path
# Returns: JSON object of phases
get_all_phases() {
    local todo_file="${1:-$TODO_FILE}"
    # Guard against missing file - jq hangs on stdin if file doesn't exist
    [[ -f "$todo_file" ]] || { echo "{}"; return 1; }
    jq '.project.phases // {}' "$todo_file"
}

# Get phase details by slug
# Args: $1 = phase slug, $2 = todo file path
# Returns: JSON phase object or null
get_phase() {
    local slug="$1"
    local todo_file="${2:-$TODO_FILE}"
    # Guard against missing file - jq hangs on stdin if file doesn't exist
    [[ -f "$todo_file" ]] || { echo "null"; return 1; }
    jq --arg slug "$slug" '.project.phases[$slug] // null' "$todo_file"
}

# Get phase status
# Args: $1 = phase slug, $2 = todo file path
# Returns: status string (pending|active|completed)
get_phase_status() {
    local slug="$1"
    local todo_file="${2:-$TODO_FILE}"
    # Guard against missing file - jq hangs on stdin if file doesn't exist
    [[ -f "$todo_file" ]] || { echo "pending"; return 1; }
    jq -r --arg slug "$slug" '.project.phases[$slug].status // "pending"' "$todo_file"
}

# Count phases by status
# Args: $1 = status, $2 = todo file path
# Returns: count
count_phases_by_status() {
    local status="$1"
    local todo_file="${2:-$TODO_FILE}"
    # Guard against missing file - jq hangs on stdin if file doesn't exist
    [[ -f "$todo_file" ]] || { echo "0"; return 1; }
    jq --arg status "$status" '[.project.phases | to_entries[] | select(.value.status == $status)] | length' "$todo_file"
}

# ============================================================================
# PHASE ORDER AND DISTANCE FUNCTIONS
# ============================================================================

# Get numeric order of a phase
# Args: $1 = phase slug, $2 = todo file path (optional)
# Returns: integer order or 0 if not found
get_phase_order() {
    local slug="$1"
    local todo_file="${2:-$TODO_FILE}"
    [[ -f "$todo_file" ]] || { echo "0"; return 1; }
    jq -r --arg slug "$slug" '.project.phases[$slug].order // 0' "$todo_file"
}

# Calculate distance between task phase and current project phase
# Args: $1 = task phase slug, $2 = current phase slug, $3 = todo file path (optional)
# Returns: integer distance (0 = same, 1 = adjacent, 2+ = distant)
get_phase_distance() {
    local task_phase="$1"
    local current_phase="$2"
    local todo_file="${3:-$TODO_FILE}"

    # Same phase = distance 0
    [[ "$task_phase" == "$current_phase" ]] && { echo "0"; return 0; }

    # Handle empty/missing phases
    [[ -z "$task_phase" || -z "$current_phase" ]] && { echo "0"; return 0; }

    # Get orders
    local task_order current_order
    task_order=$(get_phase_order "$task_phase" "$todo_file")
    current_order=$(get_phase_order "$current_phase" "$todo_file")

    # If either phase not found (order 0), return 0 distance
    [[ "$task_order" -eq 0 || "$current_order" -eq 0 ]] && { echo "0"; return 0; }

    # Calculate absolute difference
    local diff=$((task_order - current_order))
    [[ $diff -lt 0 ]] && diff=$((-diff))

    echo "$diff"
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

    # Validate phase exists
    if ! jq -e --arg slug "$slug" '.project.phases[$slug]' "$todo_file" >/dev/null 2>&1; then
        echo "ERROR: Phase '$slug' does not exist" >&2
        return 1
    fi

    local timestamp
    timestamp=$(get_iso_timestamp)

    local updated_content
    updated_content=$(jq --arg slug "$slug" --arg ts "$timestamp" '
        .project.currentPhase = $slug |
        .focus.currentPhase = $slug |
        .lastUpdated = $ts
    ' "$todo_file")

    save_json "$todo_file" "$updated_content"
}

# Start a phase (transition from pending to active)
# Args: $1 = phase slug, $2 = todo file path
# Returns: 0 on success, 1 on error
start_phase() {
    local slug="$1"
    local todo_file="${2:-$TODO_FILE}"
    local current_status

    current_status=$(get_phase_status "$slug" "$todo_file")

    if [[ "$current_status" != "pending" ]]; then
        echo "ERROR: Can only start pending phases (current: $current_status)" >&2
        return 1
    fi

    local timestamp
    timestamp=$(get_iso_timestamp)

    local updated_content
    updated_content=$(jq --arg slug "$slug" --arg ts "$timestamp" '
        .project.phases[$slug].status = "active" |
        .project.phases[$slug].startedAt = $ts |
        .project.currentPhase = $slug |
        .focus.currentPhase = $slug |
        .lastUpdated = $ts
    ' "$todo_file")

    save_json "$todo_file" "$updated_content"
}

# Complete a phase (transition from active to completed)
# Args: $1 = phase slug, $2 = todo file path, $3 = force (optional, "true" to skip validation)
# Returns: 0 on success, 1 on error
complete_phase() {
    local slug="$1"
    local todo_file="${2:-$TODO_FILE}"
    local force="${3:-false}"
    local current_status

    current_status=$(get_phase_status "$slug" "$todo_file")

    if [[ "$current_status" != "active" ]]; then
        echo "ERROR: Can only complete active phases (current: $current_status)" >&2
        return 1
    fi

    # Check for incomplete tasks in this phase (unless forced)
    if [[ "$force" != "true" ]]; then
        local incomplete_count
        incomplete_count=$(jq --arg phase "$slug" '
            [.tasks[] | select(.phase == $phase and .status != "done")] | length
        ' "$todo_file")

        if [[ "$incomplete_count" -gt 0 ]]; then
            echo "ERROR: Cannot complete phase '$slug' - $incomplete_count incomplete task(s) pending" >&2
            return 1
        fi
    fi

    local timestamp
    timestamp=$(get_iso_timestamp)

    local updated_content
    updated_content=$(jq --arg slug "$slug" --arg ts "$timestamp" '
        .project.phases[$slug].status = "completed" |
        .project.phases[$slug].completedAt = $ts |
        .lastUpdated = $ts
    ' "$todo_file")

    save_json "$todo_file" "$updated_content"
}

# Advance to next phase (complete current if needed, start next)
# Args: $1 = todo file path, $2 = force (optional, "true" to skip validation)
# Returns: 0 on success, 1 if no next phase
advance_phase() {
    local todo_file="${1:-$TODO_FILE}"
    local force="${2:-false}"
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
        complete_phase "$current_phase" "$todo_file" "$force" || return 1
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

# ============================================================================
# PHASE VALIDATION CONFIG FUNCTIONS
# ============================================================================

# Get phase validation config options
# Returns: JSON object with warnPhaseContext and enforcePhaseOrder
get_phase_validation_config() {
    local config_file="${CONFIG_FILE:-${CLEO_DIR:-.cleo}/config.json}"

    # Default values per PHASE-SYSTEM-SPEC.md (permissive by default)
    local warn_phase_context="false"
    local enforce_phase_order="false"

    if [[ -f "$config_file" ]]; then
        warn_phase_context=$(jq -r '.validation.phaseValidation.warnPhaseContext // false' "$config_file")
        enforce_phase_order=$(jq -r '.validation.phaseValidation.enforcePhaseOrder // false' "$config_file")
    fi

    echo "{\"warnPhaseContext\": $warn_phase_context, \"enforcePhaseOrder\": $enforce_phase_order}"
}

# Check if phase context warnings are enabled
# Returns: 0 (success) if enabled, 1 (failure) if disabled
is_phase_warning_enabled() {
    local config_file="${CONFIG_FILE:-${CLEO_DIR:-.cleo}/config.json}"

    if [[ -f "$config_file" ]]; then
        local warn_enabled
        warn_enabled=$(jq -r '.validation.phaseValidation.warnPhaseContext // false' "$config_file")
        [[ "$warn_enabled" == "true" ]]
    else
        # Default: warnings disabled (permissive)
        return 1
    fi
}

# Check if task phase matches project phase (warning only)
# Args: $1 = task phase, $2 = todo file path
# Returns: 0 if match or warnings disabled, 1 if mismatch (warning issued)
check_phase_context() {
    local task_phase="$1"
    local todo_file="${2:-$TODO_FILE}"

    # Check if warnings are enabled (permissive by default)
    if ! is_phase_warning_enabled; then
        return 0  # Silently pass if warnings disabled
    fi

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
# PHASE HISTORY FUNCTIONS
# ============================================================================

# Get phase history array from todo.json
# Args: $1 = todo file path
# Returns: JSON array of phase history entries
get_phase_history() {
    local todo_file="${1:-$TODO_FILE}"
    [[ -f "$todo_file" ]] || { echo "[]"; return 1; }
    jq '.project.phaseHistory // []' "$todo_file"
}

# Count tasks in a specific phase
# Args: $1 = phase slug, $2 = todo file path
# Returns: integer count
count_tasks_in_phase() {
    local phase_slug="$1"
    local todo_file="${2:-$TODO_FILE}"
    [[ -f "$todo_file" ]] || { echo "0"; return 1; }
    jq --arg phase "$phase_slug" '[.tasks[] | select(.phase == $phase)] | length' "$todo_file"
}

# Add a phase history entry
# Args: $1 = phase slug, $2 = transition type (started|completed|rollback),
#       $3 = todo file path, $4 = from_phase (optional, for rollback), $5 = reason (optional)
# Returns: 0 on success, 1 on failure
add_phase_history_entry() {
    local phase_slug="$1"
    local transition_type="$2"
    local todo_file="${3:-$TODO_FILE}"
    local from_phase="${4:-null}"
    local reason="${5:-}"

    [[ -f "$todo_file" ]] || return 1

    # Validate transition type
    case "$transition_type" in
        started|completed|rollback) ;;
        *) echo "Invalid transition type: $transition_type" >&2; return 1 ;;
    esac

    # Count tasks in phase
    local task_count
    task_count=$(count_tasks_in_phase "$phase_slug" "$todo_file")

    # Get current timestamp
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Build the history entry and append to phaseHistory
    local updated_content
    if ! updated_content=$(jq --arg phase "$phase_slug" \
          --arg type "$transition_type" \
          --arg ts "$timestamp" \
          --argjson count "$task_count" \
          --arg from "$from_phase" \
          --arg reason "$reason" '
        # Initialize phaseHistory if it does not exist
        .project.phaseHistory //= [] |
        # Build the entry
        .project.phaseHistory += [{
            phase: $phase,
            transitionType: $type,
            timestamp: $ts,
            taskCount: $count,
            fromPhase: (if $from == "null" or $from == "" then null else $from end),
            reason: (if $reason == "" then null else $reason end)
        } | with_entries(select(.value != null))]
    ' "$todo_file"); then
        return 1
    fi

    save_json "$todo_file" "$updated_content"
}

# Get last phase history entry for a specific phase
# Args: $1 = phase slug, $2 = todo file path
# Returns: JSON object of last entry or null
get_last_phase_history_entry() {
    local phase_slug="$1"
    local todo_file="${2:-$TODO_FILE}"
    [[ -f "$todo_file" ]] || { echo "null"; return 1; }
    jq --arg phase "$phase_slug" '
        [.project.phaseHistory // [] | .[] | select(.phase == $phase)] | last // null
    ' "$todo_file"
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f get_current_phase
export -f get_all_phases
export -f get_phase
export -f get_phase_status
export -f count_phases_by_status
export -f get_phase_order
export -f get_phase_distance
export -f set_current_phase
export -f start_phase
export -f complete_phase
export -f advance_phase
export -f validate_single_active_phase
export -f validate_current_phase_consistency
export -f get_phase_validation_config
export -f is_phase_warning_enabled
export -f check_phase_context
export -f get_phase_history
export -f count_tasks_in_phase
export -f add_phase_history_entry
export -f get_last_phase_history_entry
