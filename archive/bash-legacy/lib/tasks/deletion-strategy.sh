#!/usr/bin/env bash
# deletion-strategy.sh - Strategy Pattern for child handling during task deletion/cancellation
#
# LAYER: 3 (Domain Logic)
# DEPENDENCIES: hierarchy.sh, file-ops.sh
# NOTE: exit-codes.sh available transitively via hierarchy.sh
# NOTE: config.sh functions available transitively via hierarchy.sh and file-ops.sh
# PROVIDES: handle_children, handle_children_block, handle_children_cascade,
#           handle_children_orphan, DELETION_STRATEGIES, VALID_CHILD_STRATEGIES
#
# Strategies: block (fail if has children), cascade (cancel all), orphan (remove parent ref)

#=== SOURCE GUARD ================================================
[[ -n "${_DELETION_STRATEGY_SH_LOADED:-}" ]] && return 0
declare -r _DELETION_STRATEGY_SH_LOADED=1

#=== DEPENDENCIES ================================================
# Get lib directory for sourcing dependencies
_DELETION_STRATEGY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source dependencies (each has its own source guard)
# NOTE: exit-codes.sh provided transitively via hierarchy.sh
source "$_DELETION_STRATEGY_LIB_DIR/tasks/hierarchy.sh"   # Also provides exit-codes.sh and config.sh transitively
source "$_DELETION_STRATEGY_LIB_DIR/data/file-ops.sh"    # Also provides config.sh transitively

# =============================================================================
# Logging Callback (Dependency Injection Pattern)
# =============================================================================
# Allows parent scripts to inject their own logging implementation
# without creating a hard dependency on logging.sh
#
# Usage: Set _DS_LOG_FN to the name of your log function before sourcing
#        Example: _DS_LOG_FN="log_operation" source deletion-strategy.sh
#
_ds_log_operation() {
    # Default no-op; override by setting: _DS_LOG_FN=your_log_function
    if [[ -n "${_DS_LOG_FN:-}" ]] && declare -f "$_DS_LOG_FN" >/dev/null 2>&1; then
        "$_DS_LOG_FN" "$@"
    fi
    # Silent success if no log function configured
    return 0
}

# =============================================================================
# Locking Wrappers (Thin wrappers around file-ops.sh lock_file/unlock_file)
# =============================================================================
# These wrap the file-ops.sh locking primitives with task-specific semantics

# _ds_acquire_task_lock - Acquire lock on todo file before modification
# Args: $1 - Path to todo.json, $2 - Timeout (optional, default 30)
# Returns: File descriptor number via stdout
# Exit code: 0 on success, EXIT_LOCK_TIMEOUT on failure
_ds_acquire_task_lock() {
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

# _ds_release_task_lock - Release lock on todo file
# Args: $1 - File descriptor to release
_ds_release_task_lock() {
    local lock_fd="$1"
    if [[ -n "$lock_fd" ]] && declare -f unlock_file >/dev/null 2>&1; then
        unlock_file "$lock_fd"
    fi
}

# =============================================================================
# Strategy Registry (Open/Closed Principle)
# =============================================================================
# New strategies can be added by registering them here
# No need to modify existing strategy code

declare -A DELETION_STRATEGIES=(
    ["block"]="handle_children_block"
    ["cascade"]="handle_children_cascade"
    ["orphan"]="handle_children_orphan"
)

# Valid strategy names for validation
VALID_CHILD_STRATEGIES="block cascade orphan"

# =============================================================================
# Strategy Dispatcher
# =============================================================================

# handle_children - Dispatch to appropriate strategy handler
#
# Arguments:
#   $1 - task_id: The task ID to handle children for
#   $2 - strategy: The strategy to use (block, cascade, orphan)
#   $3 - todo_file: Path to the todo.json file
#   $4 - force: Whether to skip confirmation prompts ("true" or "false")
#
# Returns:
#   0 on success
#   EXIT_INVALID_INPUT (2) if strategy is invalid
#   Strategy-specific exit codes on failure
#
# Output:
#   JSON result with affected task IDs on stdout
#
handle_children() {
    local task_id="$1"
    local strategy="$2"
    local todo_file="$3"
    local force="${4:-false}"

    # Validate strategy is registered
    if [[ -z "${DELETION_STRATEGIES[$strategy]:-}" ]]; then
        echo "{\"success\":false,\"error\":{\"code\":\"E_INVALID_STRATEGY\",\"message\":\"Unknown child handling strategy: $strategy\",\"validStrategies\":[\"block\",\"cascade\",\"orphan\"]}}" >&2
        return $EXIT_INVALID_INPUT
    fi

    # Call the registered strategy function
    local handler="${DELETION_STRATEGIES[$strategy]}"
    "$handler" "$task_id" "$todo_file" "$force"
}

# =============================================================================
# Strategy: block (Safety-first default)
# =============================================================================

# handle_children_block - Fail if task has any children
#
# This is the safety-first default strategy. If the task has any children,
# the operation fails with a clear error message suggesting alternatives.
#
# Arguments:
#   $1 - task_id: The task ID to check
#   $2 - todo_file: Path to the todo.json file
#   $3 - force: Ignored for block strategy
#
# Returns:
#   0 if task has no children
#   EXIT_HAS_CHILDREN (16) if task has children
#
# Output:
#   JSON result on stdout
#
handle_children_block() {
    local task_id="$1"
    local todo_file="$2"
    # force parameter ignored for block strategy

    # Fast-path: Check if task has any children
    local children
    children=$(get_children "$task_id" "$todo_file")

    if [[ -n "$children" ]]; then
        # Count children for error message
        local child_count
        child_count=$(echo "$children" | wc -w | tr -d ' ')

        # Get child IDs as JSON array
        local child_ids_json
        child_ids_json=$(echo "$children" | tr ' ' '\n' | jq -R . | jq -s .)

        # Return error JSON
        jq -nc \
            --arg task_id "$task_id" \
            --argjson count "$child_count" \
            --argjson children "$child_ids_json" \
            '{
                "success": false,
                "error": {
                    "code": "E_HAS_CHILDREN",
                    "message": "Task \($task_id) has \($count) child task(s) and cannot be deleted",
                    "taskId": $task_id,
                    "childCount": $count,
                    "childIds": $children,
                    "suggestion": "Use --children=cascade to cancel children or --children=orphan to make them root tasks"
                }
            }'
        return $EXIT_HAS_CHILDREN
    fi

    # No children - success
    jq -nc \
        --arg task_id "$task_id" \
        '{
            "success": true,
            "strategy": "block",
            "taskId": $task_id,
            "affectedTasks": [],
            "message": "Task has no children"
        }'
    return 0
}

# =============================================================================
# Strategy: cascade (Recursive cancellation)
# =============================================================================

# handle_children_cascade - Cancel all descendants recursively
#
# This strategy cancels all descendants of the task. It includes safety checks:
#   - Verifies cascade is allowed in config
#   - Checks count against cascade threshold
#   - Requires --force if threshold exceeded
#
# Arguments:
#   $1 - task_id: The task ID to cascade from
#   $2 - todo_file: Path to the todo.json file
#   $3 - force: Whether to skip threshold confirmation ("true" or "false")
#
# Returns:
#   0 on success
#   EXIT_HAS_CHILDREN (16) if threshold exceeded and not forced
#   EXIT_CASCADE_FAILED (18) if cascade operation fails
#
# Output:
#   JSON result with affected task IDs on stdout
#
handle_children_cascade() {
    local task_id="$1"
    local todo_file="$2"
    local force="${3:-false}"
    local lock_fd=""

    # Acquire lock before reading/modifying file
    if ! lock_fd=$(_ds_acquire_task_lock "$todo_file"); then
        jq -nc \
            --arg task_id "$task_id" \
            '{
                "success": false,
                "error": {
                    "code": "E_LOCK_FAILED",
                    "message": "Failed to acquire lock on todo file",
                    "taskId": $task_id
                }
            }'
        return $EXIT_LOCK_TIMEOUT
    fi

    # Fast-path: Check if task has any children at all
    local children
    children=$(get_children "$task_id" "$todo_file")

    if [[ -z "$children" ]]; then
        # Leaf task - no children to cascade
        _ds_release_task_lock "$lock_fd"
        jq -nc \
            --arg task_id "$task_id" \
            '{
                "success": true,
                "strategy": "cascade",
                "taskId": $task_id,
                "affectedTasks": [],
                "message": "Task has no children (leaf task)"
            }'
        return 0
    fi

    # Check if cascade is allowed
    local allow_cascade
    allow_cascade=$(get_allow_cascade)
    if [[ "$allow_cascade" != "true" ]]; then
        _ds_release_task_lock "$lock_fd"
        jq -nc \
            --arg task_id "$task_id" \
            '{
                "success": false,
                "error": {
                    "code": "E_CASCADE_DISABLED",
                    "message": "Cascade cancellation is disabled in configuration",
                    "taskId": $task_id,
                    "suggestion": "Set cancellation.allowCascade=true in config or use --children=orphan"
                }
            }'
        return $EXIT_CASCADE_FAILED
    fi

    # Get all descendants (recursive)
    local descendants
    descendants=$(get_descendants "$task_id" "$todo_file")

    # Count descendants
    local descendant_count=0
    if [[ -n "$descendants" ]]; then
        descendant_count=$(echo "$descendants" | wc -w | tr -d ' ')
    fi

    # Check against cascade threshold
    local threshold
    threshold=$(get_cascade_threshold)

    if [[ "$descendant_count" -gt "$threshold" && "$force" != "true" ]]; then
        # Get descendant IDs as JSON array
        local descendant_ids_json
        descendant_ids_json=$(echo "$descendants" | tr ' ' '\n' | jq -R . | jq -s .)

        _ds_release_task_lock "$lock_fd"
        jq -nc \
            --arg task_id "$task_id" \
            --argjson count "$descendant_count" \
            --argjson threshold "$threshold" \
            --argjson descendants "$descendant_ids_json" \
            '{
                "success": false,
                "error": {
                    "code": "E_CASCADE_THRESHOLD_EXCEEDED",
                    "message": "Cascade would affect \($count) tasks, exceeding threshold of \($threshold)",
                    "taskId": $task_id,
                    "descendantCount": $count,
                    "threshold": $threshold,
                    "descendantIds": $descendants,
                    "suggestion": "Use --force to proceed or reduce the cascade threshold in config"
                }
            }'
        return $EXIT_HAS_CHILDREN
    fi

    # Perform cascade cancellation atomically
    local affected_ids=()
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Build list of all affected IDs (including direct children and all descendants)
    for id in $descendants; do
        affected_ids+=("$id")
    done

    # Cancel all descendants in a single jq operation (atomic)
    local updated_json
    local descendant_pattern
    descendant_pattern=$(echo "$descendants" | tr ' ' '\n' | jq -R . | jq -s 'join("|")')
    descendant_pattern="${descendant_pattern//\"/}"  # Remove quotes

    updated_json=$(jq \
        --arg pattern "$descendant_pattern" \
        --arg timestamp "$timestamp" \
        --arg reason "Parent task cancelled (cascade)" \
        '
        .tasks = [.tasks[] |
            if (.id | test("^(" + $pattern + ")$")) then
                .status = "cancelled" |
                .cancelledAt = $timestamp |
                .cancellationReason = $reason
            else
                .
            end
        ]
        ' "$todo_file")

    if [[ $? -ne 0 ]]; then
        _ds_release_task_lock "$lock_fd"
        jq -nc \
            --arg task_id "$task_id" \
            '{
                "success": false,
                "error": {
                    "code": "E_CASCADE_FAILED",
                    "message": "Failed to cancel descendant tasks",
                    "taskId": $task_id
                }
            }'
        return $EXIT_CASCADE_FAILED
    fi

    # Save atomically
    if ! save_json "$todo_file" "$updated_json"; then
        _ds_release_task_lock "$lock_fd"
        jq -nc \
            --arg task_id "$task_id" \
            '{
                "success": false,
                "error": {
                    "code": "E_CASCADE_SAVE_FAILED",
                    "message": "Failed to save cascade changes",
                    "taskId": $task_id
                }
            }'
        return $EXIT_CASCADE_FAILED
    fi

    # Release lock after successful save
    _ds_release_task_lock "$lock_fd"

    # Log the cascade operation
    local details
    details=$(jq -nc \
        --arg task_id "$task_id" \
        --argjson count "$descendant_count" \
        --argjson ids "$(echo "${affected_ids[@]}" | tr ' ' '\n' | jq -R . | jq -s .)" \
        '{
            "operation": "cascade_cancel",
            "parentTaskId": $task_id,
            "affectedCount": $count,
            "affectedIds": $ids
        }')

    _ds_log_operation "task_cascade_cancelled" "system" "$task_id" "null" "null" "$details"

    # Return success with affected tasks
    jq -nc \
        --arg task_id "$task_id" \
        --argjson count "$descendant_count" \
        --argjson affected "$(echo "${affected_ids[@]}" | tr ' ' '\n' | jq -R . | jq -s .)" \
        '{
            "success": true,
            "strategy": "cascade",
            "taskId": $task_id,
            "affectedCount": $count,
            "affectedTasks": $affected,
            "message": "Successfully cancelled \($count) descendant task(s)"
        }'
    return 0
}

# =============================================================================
# Strategy: orphan (Remove parent reference)
# =============================================================================

# handle_children_orphan - Make direct children root tasks
#
# This strategy removes the parentId from direct children, making them
# root-level tasks. This preserves the children but breaks the hierarchy.
#
# Arguments:
#   $1 - task_id: The task ID whose children will be orphaned
#   $2 - todo_file: Path to the todo.json file
#   $3 - force: Ignored for orphan strategy
#
# Returns:
#   0 on success
#   EXIT_CASCADE_FAILED (18) if orphan operation fails
#
# Output:
#   JSON result with orphaned task IDs on stdout
#
handle_children_orphan() {
    local task_id="$1"
    local todo_file="$2"
    # force parameter ignored for orphan strategy
    local lock_fd=""

    # Acquire lock before reading/modifying file
    if ! lock_fd=$(_ds_acquire_task_lock "$todo_file"); then
        jq -nc \
            --arg task_id "$task_id" \
            '{
                "success": false,
                "error": {
                    "code": "E_LOCK_FAILED",
                    "message": "Failed to acquire lock on todo file",
                    "taskId": $task_id
                }
            }'
        return $EXIT_LOCK_TIMEOUT
    fi

    # Get direct children only (not recursive)
    local children
    children=$(get_children "$task_id" "$todo_file")

    if [[ -z "$children" ]]; then
        # No children to orphan
        _ds_release_task_lock "$lock_fd"
        jq -nc \
            --arg task_id "$task_id" \
            '{
                "success": true,
                "strategy": "orphan",
                "taskId": $task_id,
                "affectedTasks": [],
                "message": "Task has no children to orphan"
            }'
        return 0
    fi

    # Count children
    local child_count
    child_count=$(echo "$children" | wc -w | tr -d ' ')

    # Orphan children in a single jq operation (atomic)
    local updated_json
    local child_pattern
    child_pattern=$(echo "$children" | tr ' ' '\n' | jq -R . | jq -s 'join("|")')
    child_pattern="${child_pattern//\"/}"  # Remove quotes

    updated_json=$(jq \
        --arg pattern "$child_pattern" \
        '
        .tasks = [.tasks[] |
            if (.id | test("^(" + $pattern + ")$")) then
                .parentId = null
            else
                .
            end
        ]
        ' "$todo_file")

    if [[ $? -ne 0 ]]; then
        _ds_release_task_lock "$lock_fd"
        jq -nc \
            --arg task_id "$task_id" \
            '{
                "success": false,
                "error": {
                    "code": "E_ORPHAN_FAILED",
                    "message": "Failed to orphan child tasks",
                    "taskId": $task_id
                }
            }'
        return $EXIT_CASCADE_FAILED
    fi

    # Save atomically
    if ! save_json "$todo_file" "$updated_json"; then
        _ds_release_task_lock "$lock_fd"
        jq -nc \
            --arg task_id "$task_id" \
            '{
                "success": false,
                "error": {
                    "code": "E_ORPHAN_SAVE_FAILED",
                    "message": "Failed to save orphan changes",
                    "taskId": $task_id
                }
            }'
        return $EXIT_CASCADE_FAILED
    fi

    # Release lock after successful save
    _ds_release_task_lock "$lock_fd"

    # Build affected IDs array
    local affected_ids=()
    for id in $children; do
        affected_ids+=("$id")
    done

    # Log the orphan operation
    local details
    details=$(jq -nc \
        --arg task_id "$task_id" \
        --argjson count "$child_count" \
        --argjson ids "$(echo "${affected_ids[@]}" | tr ' ' '\n' | jq -R . | jq -s .)" \
        '{
            "operation": "orphan_children",
            "parentTaskId": $task_id,
            "orphanedCount": $count,
            "orphanedIds": $ids
        }')

    _ds_log_operation "task_children_orphaned" "system" "$task_id" "null" "null" "$details"

    # Return success with orphaned tasks
    jq -nc \
        --arg task_id "$task_id" \
        --argjson count "$child_count" \
        --argjson affected "$(echo "${affected_ids[@]}" | tr ' ' '\n' | jq -R . | jq -s .)" \
        '{
            "success": true,
            "strategy": "orphan",
            "taskId": $task_id,
            "affectedCount": $count,
            "affectedTasks": $affected,
            "message": "Successfully orphaned \($count) child task(s)"
        }'
    return 0
}

# =============================================================================
# Helper Functions
# =============================================================================

# get_task_children - Wrapper for hierarchy.sh get_children returning JSON
#
# Arguments:
#   $1 - task_id: The task ID to get children for
#   $2 - todo_file: Path to the todo.json file
#
# Output:
#   JSON array of child task IDs
#
get_task_children() {
    local task_id="$1"
    local todo_file="$2"

    local children
    children=$(get_children "$task_id" "$todo_file")

    if [[ -z "$children" ]]; then
        echo "[]"
    else
        echo "$children" | tr ' ' '\n' | jq -R . | jq -s .
    fi
}

# get_task_descendants - Wrapper for hierarchy.sh get_descendants returning JSON
#
# Arguments:
#   $1 - task_id: The task ID to get descendants for
#   $2 - todo_file: Path to the todo.json file
#
# Output:
#   JSON array of descendant task IDs (flat list)
#
get_task_descendants() {
    local task_id="$1"
    local todo_file="$2"

    local descendants
    descendants=$(get_descendants "$task_id" "$todo_file")

    if [[ -z "$descendants" ]]; then
        echo "[]"
    else
        echo "$descendants" | tr ' ' '\n' | jq -R . | jq -s .
    fi
}

# validate_strategy - Check if a strategy name is valid
#
# Arguments:
#   $1 - strategy: The strategy name to validate
#
# Returns:
#   0 if valid, 1 if invalid
#
validate_strategy() {
    local strategy="$1"

    for valid in $VALID_CHILD_STRATEGIES; do
        if [[ "$strategy" == "$valid" ]]; then
            return 0
        fi
    done
    return 1
}

# get_registered_strategies - Get list of registered strategy names
#
# Output:
#   Space-separated list of strategy names
#
get_registered_strategies() {
    echo "${!DELETION_STRATEGIES[@]}"
}

# =============================================================================
# Exports
# =============================================================================

export -f handle_children
export -f handle_children_block
export -f handle_children_cascade
export -f handle_children_orphan
export -f get_task_children
export -f get_task_descendants
export -f validate_strategy
export -f get_registered_strategies
