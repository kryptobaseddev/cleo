#!/usr/bin/env bash
# Cancellation/deletion operations library for cleo
#
# LAYER: 3 (Domain Logic)
# DEPENDENCIES: validation.sh, backup.sh
# PROVIDES: preflight_delete_check, cancel_task, is_leaf_task,
#           get_cascade_candidates, validate_cancel_reason
#
# NOTE: hierarchy.sh and config.sh are NOT directly sourced here because
# validation.sh already sources them. This reduces dependency count from 5 to 3
# per LIBRARY-ARCHITECTURE-SPEC.md (max 3 deps for Layer 3).

#=== SOURCE GUARD ================================================
[[ -n "${_CANCEL_OPS_LOADED:-}" ]] && return 0
declare -r _CANCEL_OPS_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_CANCEL_OPS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source validation library for validation functions
# NOTE: validation.sh transitively provides hierarchy.sh and config.sh
# so we don't need to source them directly here
if [[ -f "$_CANCEL_OPS_LIB_DIR/validation.sh" ]]; then
    # shellcheck source=lib/validation.sh
    source "$_CANCEL_OPS_LIB_DIR/validation.sh"
fi

# Source backup library for pre-operation safety backups
if [[ -f "$_CANCEL_OPS_LIB_DIR/backup.sh" ]]; then
    # shellcheck source=lib/backup.sh
    source "$_CANCEL_OPS_LIB_DIR/backup.sh"
fi

# ============================================================================
# CONSTANTS
# ============================================================================

# Default cascade limit (can be overridden via config)
readonly DEFAULT_CASCADE_LIMIT=10

# Valid child handling modes
readonly VALID_CHILD_MODES="block orphan cascade fail"

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

# Get the cascade limit from config or default
# Returns: integer
get_cascade_limit() {
    if declare -f get_cascade_threshold >/dev/null 2>&1; then
        get_cascade_threshold
    else
        echo "$DEFAULT_CASCADE_LIMIT"
    fi
}

# Check if require_reason is enabled in config
# Returns: "true" or "false"
is_reason_required() {
    if declare -f get_require_reason >/dev/null 2>&1; then
        get_require_reason
    else
        echo "true"
    fi
}

# Check if cascade mode is allowed in config
# Returns: "true" or "false"
is_cascade_allowed() {
    if declare -f get_allow_cascade >/dev/null 2>&1; then
        get_allow_cascade
    else
        echo "true"
    fi
}

# Validate task ID format
# Args: $1 = task ID
# Returns: 0 if valid, 1 if invalid
validate_task_id_format() {
    local task_id="$1"

    # Check for empty
    if [[ -z "$task_id" ]]; then
        return 1
    fi

    # Task ID format: T followed by digits (e.g., T001, T123)
    if [[ ! "$task_id" =~ ^T[0-9]+$ ]]; then
        return 1
    fi

    return 0
}

# Check if task exists in todo.json
# Args: $1 = task ID, $2 = todo file path
# Returns: 0 if exists, 1 if not
task_exists() {
    local task_id="$1"
    local todo_file="$2"

    if [[ ! -f "$todo_file" ]]; then
        return 1
    fi

    local exists
    exists=$(jq -r --arg id "$task_id" '[.tasks[].id] | index($id) != null' "$todo_file" 2>/dev/null)

    [[ "$exists" == "true" ]]
}

# Get task status
# Args: $1 = task ID, $2 = todo file path
# Returns: status string or empty
get_task_status() {
    local task_id="$1"
    local todo_file="$2"

    jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .status // empty' "$todo_file" 2>/dev/null
}

# Check if task has children
# Args: $1 = task ID, $2 = todo file path
# Returns: 0 if has children, 1 if no children
task_has_children() {
    local task_id="$1"
    local todo_file="$2"

    local child_count
    child_count=$(jq --arg id "$task_id" '[.tasks[] | select(.parentId == $id)] | length' "$todo_file" 2>/dev/null || echo "0")

    [[ "$child_count" -gt 0 ]]
}

# Count direct children of a task
# Args: $1 = task ID, $2 = todo file path
# Returns: integer count
count_direct_children() {
    local task_id="$1"
    local todo_file="$2"

    jq --arg id "$task_id" '[.tasks[] | select(.parentId == $id)] | length' "$todo_file" 2>/dev/null || echo "0"
}

# Count all descendants of a task (recursive)
# Args: $1 = task ID, $2 = todo file path
# Returns: integer count
count_all_descendants() {
    local task_id="$1"
    local todo_file="$2"

    if declare -f get_descendants >/dev/null 2>&1; then
        local descendants
        descendants=$(get_descendants "$task_id" "$todo_file")
        # Count space-separated IDs
        if [[ -n "$descendants" ]]; then
            echo "$descendants" | tr ' ' '\n' | grep -c . || echo "0"
        else
            echo "0"
        fi
    else
        # Fallback: just count direct children
        count_direct_children "$task_id" "$todo_file"
    fi
}

# Check if running in TTY (interactive) mode
# Returns: 0 if TTY, 1 if non-TTY
is_interactive() {
    [[ -t 0 && -t 1 ]]
}

# ============================================================================
# VALIDATION RESULT BUILDER
# ============================================================================

# Build a validation result JSON object
# Args: $1 = success (true/false), $2 = canProceed (true/false),
#       $3 = errors JSON array, $4 = warnings JSON array, $5 = taskInfo JSON object
build_validation_result() {
    local success="${1:-false}"
    local can_proceed="${2:-false}"
    local errors="${3:-"[]"}"
    local warnings="${4:-"[]"}"
    local task_info="${5:-"{}"}"

    jq -n \
        --argjson success "$success" \
        --argjson canProceed "$can_proceed" \
        --argjson validationErrors "$errors" \
        --argjson warnings "$warnings" \
        --argjson taskInfo "$task_info" \
        '{
            success: $success,
            canProceed: $canProceed,
            validationErrors: $validationErrors,
            warnings: $warnings,
            taskInfo: $taskInfo
        }'
}

# Build a validation error object
# Args: $1 = field, $2 = error message, $3 = suggestion (optional)
build_validation_error() {
    local field="$1"
    local message="$2"
    local suggestion="${3:-}"

    if [[ -n "$suggestion" ]]; then
        jq -n \
            --arg field "$field" \
            --arg message "$message" \
            --arg suggestion "$suggestion" \
            '{field: $field, message: $message, suggestion: $suggestion}'
    else
        jq -n \
            --arg field "$field" \
            --arg message "$message" \
            '{field: $field, message: $message}'
    fi
}

# ============================================================================
# PREFLIGHT VALIDATION
# ============================================================================

# preflight_delete_check - Fail-fast validation for delete/cancel operations
#
# Validates in order (fail-fast on first error):
#   1. Task ID format validation
#   2. Task exists in todo.json
#   3. Task status is not "done" (use archive for completed tasks)
#   4. Reason validation (if required by config)
#   5. Child handling mode validation
#   6. Cascade limit check
#
# Args:
#   $1 - Task ID (e.g., "T001")
#   $2 - Path to todo.json
#   $3 - Child handling mode: "block", "orphan", "cascade", "fail", or empty
#   $4 - Cancellation reason (optional if config allows)
#   $5 - Force flag: "true" to bypass cascade limit warning (optional)
#
# Returns: JSON object with validation result
#   {
#     "success": true/false,
#     "canProceed": true/false,
#     "validationErrors": [...],
#     "warnings": [...],
#     "taskInfo": {
#       "hasChildren": bool,
#       "childCount": N,
#       "descendantCount": N,
#       "status": "pending|active|blocked|cancelled",
#       "isLeaf": bool
#     }
#   }
#
# Exit codes (for non-JSON error paths):
#   EXIT_INVALID_INPUT (2) - Invalid task ID format
#   EXIT_NOT_FOUND (4) - Task not found
#   EXIT_TASK_COMPLETED (17) - Task is done, use archive
#   EXIT_VALIDATION_ERROR (6) - Reason validation failed
#   EXIT_HAS_CHILDREN (16) - Task has children and no mode specified
preflight_delete_check() {
    local task_id="$1"
    local todo_file="$2"
    local child_mode="${3:-}"
    local reason="${4:-}"
    local force="${5:-false}"

    local errors="[]"
    local warnings="[]"
    local task_info='{}'

    # =========================================================================
    # 1. Task ID format validation
    # =========================================================================
    if ! validate_task_id_format "$task_id"; then
        local error
        error=$(build_validation_error "taskId" "Invalid task ID format: '$task_id'" "Use format T### (e.g., T001, T123)")
        errors=$(echo "$errors" | jq --argjson err "$error" '. + [$err]')
        echo "$(build_validation_result false false "$errors" "$warnings" "$task_info")"
        return "${EXIT_INVALID_INPUT:-2}"
    fi

    # =========================================================================
    # 2. Task exists check
    # =========================================================================
    if [[ ! -f "$todo_file" ]]; then
        local error
        error=$(build_validation_error "todoFile" "Todo file not found: $todo_file" "Ensure .cleo/todo.json exists")
        errors=$(echo "$errors" | jq --argjson err "$error" '. + [$err]')
        echo "$(build_validation_result false false "$errors" "$warnings" "$task_info")"
        return "${EXIT_FILE_ERROR:-3}"
    fi

    if ! task_exists "$task_id" "$todo_file"; then
        local error
        error=$(build_validation_error "taskId" "Task not found: $task_id" "Check task ID with 'cleo list'")
        errors=$(echo "$errors" | jq --argjson err "$error" '. + [$err]')
        echo "$(build_validation_result false false "$errors" "$warnings" "$task_info")"
        return "${EXIT_NOT_FOUND:-4}"
    fi

    # =========================================================================
    # 3. Status check - cannot delete completed tasks
    # =========================================================================
    local status
    status=$(get_task_status "$task_id" "$todo_file")

    if [[ "$status" == "done" ]]; then
        local error
        error=$(build_validation_error "status" "Cannot delete completed task: $task_id" "Use 'cleo archive' for completed tasks")
        errors=$(echo "$errors" | jq --argjson err "$error" '. + [$err]')
        echo "$(build_validation_result false false "$errors" "$warnings" "$task_info")"
        return "${EXIT_TASK_COMPLETED:-17}"
    fi

    # =========================================================================
    # Gather task info (needed for remaining validations)
    # =========================================================================
    local has_children=false
    local child_count=0
    local descendant_count=0
    local is_leaf=true

    if task_has_children "$task_id" "$todo_file"; then
        has_children=true
        is_leaf=false
        child_count=$(count_direct_children "$task_id" "$todo_file")
        descendant_count=$(count_all_descendants "$task_id" "$todo_file")
    fi

    task_info=$(jq -n \
        --argjson hasChildren "$has_children" \
        --argjson childCount "$child_count" \
        --argjson descendantCount "$descendant_count" \
        --arg status "$status" \
        --argjson isLeaf "$is_leaf" \
        '{
            hasChildren: $hasChildren,
            childCount: $childCount,
            descendantCount: $descendantCount,
            status: $status,
            isLeaf: $isLeaf
        }')

    # =========================================================================
    # FAST-PATH: Leaf task optimization
    # If task has no children, skip child-related checks entirely
    # =========================================================================
    if [[ "$is_leaf" == "true" ]]; then
        # Only need to validate reason for leaf tasks
        # =====================================================================
        # 4. Reason validation (for leaf tasks)
        # =====================================================================
        local require_reason
        require_reason=$(is_reason_required)

        if [[ "$require_reason" == "true" ]]; then
            if [[ -z "$reason" ]]; then
                local error
                error=$(build_validation_error "reason" "Cancellation reason is required" "Provide --reason 'explanation'")
                errors=$(echo "$errors" | jq --argjson err "$error" '. + [$err]')
                echo "$(build_validation_result false false "$errors" "$warnings" "$task_info")"
                return "${EXIT_VALIDATION_ERROR:-6}"
            fi

            # Validate reason content using validate_cancel_reason from validation.sh
            if declare -f validate_cancel_reason >/dev/null 2>&1; then
                if ! validate_cancel_reason "$reason" 2>/dev/null; then
                    local error
                    error=$(build_validation_error "reason" "Invalid cancellation reason" "Reason must be 5-300 characters, no special characters")
                    errors=$(echo "$errors" | jq --argjson err "$error" '. + [$err]')
                    echo "$(build_validation_result false false "$errors" "$warnings" "$task_info")"
                    return "${EXIT_VALIDATION_ERROR:-6}"
                fi
            else
                # Fallback validation: check length only
                local reason_len=${#reason}
                if [[ $reason_len -lt 5 ]]; then
                    local error
                    error=$(build_validation_error "reason" "Cancellation reason too short ($reason_len/5 minimum)" "Provide a more detailed reason")
                    errors=$(echo "$errors" | jq --argjson err "$error" '. + [$err]')
                    echo "$(build_validation_result false false "$errors" "$warnings" "$task_info")"
                    return "${EXIT_VALIDATION_ERROR:-6}"
                fi
                if [[ $reason_len -gt 300 ]]; then
                    local error
                    error=$(build_validation_error "reason" "Cancellation reason too long ($reason_len/300 maximum)" "Shorten the reason")
                    errors=$(echo "$errors" | jq --argjson err "$error" '. + [$err]')
                    echo "$(build_validation_result false false "$errors" "$warnings" "$task_info")"
                    return "${EXIT_VALIDATION_ERROR:-6}"
                fi
            fi
        fi

        # Leaf task - all validations passed
        echo "$(build_validation_result true true "$errors" "$warnings" "$task_info")"
        return 0
    fi

    # =========================================================================
    # Non-leaf task: Continue with full validation
    # =========================================================================

    # =========================================================================
    # 4. Reason validation (for tasks with children)
    # =========================================================================
    local require_reason
    require_reason=$(is_reason_required)

    if [[ "$require_reason" == "true" ]]; then
        if [[ -z "$reason" ]]; then
            local error
            error=$(build_validation_error "reason" "Cancellation reason is required" "Provide --reason 'explanation'")
            errors=$(echo "$errors" | jq --argjson err "$error" '. + [$err]')
            echo "$(build_validation_result false false "$errors" "$warnings" "$task_info")"
            return "${EXIT_VALIDATION_ERROR:-6}"
        fi

        # Validate reason content
        if declare -f validate_cancel_reason >/dev/null 2>&1; then
            if ! validate_cancel_reason "$reason" 2>/dev/null; then
                local error
                error=$(build_validation_error "reason" "Invalid cancellation reason" "Reason must be 5-300 characters, no special characters")
                errors=$(echo "$errors" | jq --argjson err "$error" '. + [$err]')
                echo "$(build_validation_result false false "$errors" "$warnings" "$task_info")"
                return "${EXIT_VALIDATION_ERROR:-6}"
            fi
        fi
    fi

    # =========================================================================
    # 5. Child handling mode validation
    # =========================================================================
    if [[ "$has_children" == "true" ]]; then
        # Task has children - must specify a child handling mode
        if [[ -z "$child_mode" ]]; then
            # In non-TTY mode, this is an error
            if ! is_interactive; then
                local error
                error=$(build_validation_error "childMode" "Task has $child_count children but no --children mode specified" "Use --children=block|orphan|cascade")
                errors=$(echo "$errors" | jq --argjson err "$error" '. + [$err]')
                echo "$(build_validation_result false false "$errors" "$warnings" "$task_info")"
                return "${EXIT_HAS_CHILDREN:-16}"
            else
                # In TTY mode, we can prompt interactively - add warning
                local warning
                warning=$(jq -n --argjson count "$child_count" \
                    '{type: "interactive_prompt_needed", message: ("Task has " + ($count | tostring) + " children - will prompt for action")}')
                warnings=$(echo "$warnings" | jq --argjson warn "$warning" '. + [$warn]')
            fi
        else
            # Validate child mode is valid
            # Note: Using case statement instead of for loop because IFS may be
            # modified by other libraries (e.g., backup.sh sets IFS=$'\n\t')
            local valid_mode=false
            case "$child_mode" in
                block|orphan|cascade|fail)
                    valid_mode=true
                    ;;
            esac

            if [[ "$valid_mode" == "false" ]]; then
                local error
                error=$(build_validation_error "childMode" "Invalid child handling mode: '$child_mode'" "Use one of: $VALID_CHILD_MODES")
                errors=$(echo "$errors" | jq --argjson err "$error" '. + [$err]')
                echo "$(build_validation_result false false "$errors" "$warnings" "$task_info")"
                return "${EXIT_INVALID_INPUT:-2}"
            fi

            # Check if cascade mode is allowed
            if [[ "$child_mode" == "cascade" ]]; then
                local cascade_allowed
                cascade_allowed=$(is_cascade_allowed)

                if [[ "$cascade_allowed" != "true" ]]; then
                    local error
                    error=$(build_validation_error "childMode" "Cascade mode is disabled in configuration" "Use --children=block or --children=orphan")
                    errors=$(echo "$errors" | jq --argjson err "$error" '. + [$err]')
                    echo "$(build_validation_result false false "$errors" "$warnings" "$task_info")"
                    return "${EXIT_VALIDATION_ERROR:-6}"
                fi
            fi
        fi
    fi

    # =========================================================================
    # 6. Cascade limit check
    # =========================================================================
    if [[ "$child_mode" == "cascade" && "$has_children" == "true" ]]; then
        local cascade_limit
        cascade_limit=$(get_cascade_limit)

        if [[ "$descendant_count" -gt "$cascade_limit" ]]; then
            if [[ "$force" != "true" ]]; then
                local error
                error=$(build_validation_error "cascadeLimit" \
                    "Cascade would delete $descendant_count tasks (limit: $cascade_limit)" \
                    "Use --force to override or choose a different --children mode")
                errors=$(echo "$errors" | jq --argjson err "$error" '. + [$err]')
                echo "$(build_validation_result false false "$errors" "$warnings" "$task_info")"
                return "${EXIT_VALIDATION_ERROR:-6}"
            else
                # Force flag is set - add warning but allow
                local warning
                warning=$(jq -n --argjson count "$descendant_count" --argjson limit "$cascade_limit" \
                    '{type: "cascade_limit_override", message: ("Force flag set - will delete " + ($count | tostring) + " descendants (limit was " + ($limit | tostring) + ")")}')
                warnings=$(echo "$warnings" | jq --argjson warn "$warning" '. + [$warn]')
            fi
        fi
    fi

    # =========================================================================
    # All validations passed
    # =========================================================================
    echo "$(build_validation_result true true "$errors" "$warnings" "$task_info")"
    return 0
}

# ============================================================================
# PRE-OPERATION SAFETY BACKUP
# ============================================================================

# create_delete_safety_backup - Create safety backup before delete operation
#
# Creates a Tier 2 safety backup of todo.json before any deletion.
# Allows rollback if operation fails.
#
# Args:
#   $1 - Path to todo.json
#   $2 - Operation description (optional, defaults to "delete")
#
# Returns: Backup path on success, empty on failure/disabled
# Exit code: 0 on success, 1 on failure
create_delete_safety_backup() {
    local todo_file="$1"
    local operation="${2:-delete}"

    if [[ ! -f "$todo_file" ]]; then
        echo ""
        return 1
    fi

    # Use create_safety_backup from lib/backup.sh if available
    if declare -f create_safety_backup >/dev/null 2>&1; then
        local backup_path
        backup_path=$(create_safety_backup "$todo_file" "$operation" 2>/dev/null)
        local result=$?

        if [[ $result -eq 0 && -n "$backup_path" ]]; then
            echo "$backup_path"
            return 0
        fi
    fi

    # Fallback: backups disabled or function not available
    echo ""
    return 0
}

# ============================================================================
# LOCK-BEFORE-VALIDATE PATTERN
# ============================================================================

# acquire_task_lock - Acquire lock on todo file before validation
#
# Ensures task state doesn't change between validation and operation.
# Returns file descriptor that must be closed to release lock.
#
# Args:
#   $1 - Path to todo.json
#   $2 - Timeout in seconds (optional, default 30)
#
# Returns: File descriptor number via stdout
# Exit code: 0 on success, EXIT_LOCK_TIMEOUT on failure
acquire_task_lock() {
    local todo_file="$1"
    local timeout="${2:-30}"
    local lock_fd=""

    if declare -f lock_file >/dev/null 2>&1; then
        if lock_file "$todo_file" lock_fd "$timeout"; then
            echo "$lock_fd"
            return 0
        else
            return "${EXIT_LOCK_TIMEOUT:-7}"
        fi
    fi

    # Fallback: no locking available
    echo ""
    return 0
}

# release_task_lock - Release lock on todo file
#
# Args:
#   $1 - File descriptor to release
release_task_lock() {
    local lock_fd="$1"

    if [[ -n "$lock_fd" ]] && declare -f unlock_file >/dev/null 2>&1; then
        unlock_file "$lock_fd"
    fi
}

# ============================================================================
# FOCUS IMPACT ANALYSIS
# ============================================================================

# check_focus_impact - Analyze impact on focus system when deleting tasks
#
# Checks if any tasks being deleted affect the current focus state and
# determines if phase should be cleared (when no other active tasks remain
# in the same phase).
#
# Args:
#   $1 - JSON array of task IDs being deleted (e.g., '["T001", "T002"]')
#   $2 - Path to todo.json
#
# Returns: JSON object with focus impact analysis
#   {
#     "focusCleared": bool,
#     "phaseCleared": bool,
#     "currentFocus": "T001" | null,
#     "currentPhase": "core" | null,
#     "warning": "Active focused task was cancelled" | null
#   }
#
# Note: Session note is intentionally NOT cleared to allow context continuity.
check_focus_impact() {
    local deleted_ids_json="$1"
    local todo_file="$2"

    # Get current focus state
    local current_focus
    local current_phase
    current_focus=$(jq -r '.focus.currentTask // ""' "$todo_file" 2>/dev/null)
    current_phase=$(jq -r '.focus.currentPhase // ""' "$todo_file" 2>/dev/null)

    local focus_cleared=false
    local phase_cleared=false
    local warning=""

    # Check if current focus is in deleted list
    if [[ -n "$current_focus" ]]; then
        local focus_in_deleted
        focus_in_deleted=$(echo "$deleted_ids_json" | jq --arg focus "$current_focus" 'index($focus) != null')

        if [[ "$focus_in_deleted" == "true" ]]; then
            focus_cleared=true
            warning="Active focused task was cancelled"
        fi
    fi

    # Check if phase should be cleared
    # Only clear phase if:
    # 1. There is a current phase set
    # 2. After deletion, no other active/pending tasks remain in that phase
    if [[ -n "$current_phase" && "$current_phase" != "null" && "$focus_cleared" == "true" ]]; then
        # Count remaining active/pending tasks in the same phase (excluding deleted tasks)
        local remaining_in_phase
        remaining_in_phase=$(jq --arg phase "$current_phase" --argjson deleted "$deleted_ids_json" '
            [.tasks[] |
                select(
                    .phase == $phase and
                    (.status == "active" or .status == "pending") and
                    ([.id] | inside($deleted) | not)
                )
            ] | length
        ' "$todo_file" 2>/dev/null || echo "0")

        if [[ "$remaining_in_phase" -eq 0 ]]; then
            phase_cleared=true
        fi
    fi

    # Build result JSON
    jq -n \
        --argjson focusCleared "$focus_cleared" \
        --argjson phaseCleared "$phase_cleared" \
        --arg currentFocus "$current_focus" \
        --arg currentPhase "$current_phase" \
        --arg warning "$warning" \
        '{
            focusCleared: $focusCleared,
            phaseCleared: $phaseCleared,
            currentFocus: (if $currentFocus == "" then null else $currentFocus end),
            currentPhase: (if $currentPhase == "" then null else $currentPhase end),
            warning: (if $warning == "" then null else $warning end)
        }'
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f get_cascade_limit
export -f is_reason_required
export -f is_cascade_allowed
export -f validate_task_id_format
export -f task_exists
export -f get_task_status
export -f task_has_children
export -f count_direct_children
export -f count_all_descendants
export -f is_interactive
export -f build_validation_result
export -f build_validation_error
export -f preflight_delete_check
export -f create_delete_safety_backup
export -f acquire_task_lock
export -f release_task_lock
export -f check_focus_impact
