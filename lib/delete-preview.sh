#!/usr/bin/env bash
# delete-preview.sh - Dry-run preview functions for task deletion
#
# LAYER: 3 (Domain Logic)
# DEPENDENCIES: hierarchy.sh
# PROVIDES: preview_delete, get_impact_warnings, format_preview_output,
#           SEVERITY_HIGH, SEVERITY_MEDIUM, SEVERITY_LOW

#=== SOURCE GUARD ================================================
[[ -n "${_DELETE_PREVIEW_SH_LOADED:-}" ]] && return 0
declare -r _DELETE_PREVIEW_SH_LOADED=1

#=== DEPENDENCIES ================================================
# Resolve lib directory for sourcing dependencies
_DELETE_PREVIEW_LIB_DIR="${_DELETE_PREVIEW_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

# Source dependencies (each has its own source guard)
# shellcheck source=hierarchy.sh
source "${_DELETE_PREVIEW_LIB_DIR}/hierarchy.sh"

# ============================================================================
# IMPACT SEVERITY LEVELS
# ============================================================================

# Severity constants for impact warnings
readonly SEVERITY_HIGH="high"
readonly SEVERITY_MEDIUM="medium"
readonly SEVERITY_LOW="low"

# ============================================================================
# CORE PREVIEW FUNCTIONS
# ============================================================================

# Calculate which tasks would be affected by a delete operation
#
# Args:
#   $1 - task_id: ID of the task to delete
#   $2 - strategy: Child handling strategy (cascade|orphan|block)
#   $3 - todo_file: Path to todo.json
#
# Returns:
#   JSON object with affected tasks structure
#
# Output format:
#   {
#     "primary": { "id": "T001", "title": "...", "status": "...", "type": "..." },
#     "children": [ { "id": "...", "title": "...", "status": "...", "type": "..." }, ... ],
#     "totalCount": 3
#   }
calculate_affected_tasks() {
    local task_id="$1"
    local strategy="$2"
    local todo_file="$3"

    # Get primary task details
    local primary_task
    primary_task=$(jq -r --arg id "$task_id" '
        .tasks[] | select(.id == $id) |
        {id, title, status, type, parentId, labels}
    ' "$todo_file" 2>/dev/null)

    if [[ -z "$primary_task" || "$primary_task" == "null" ]]; then
        echo '{"error": "Task not found", "primary": null, "children": [], "totalCount": 0}'
        return 0  # Return 0 but with error in JSON for proper handling
    fi

    local children_json="[]"
    local total_count=1

    # Calculate children based on strategy
    if [[ "$strategy" == "cascade" ]]; then
        # Get all descendants (children, grandchildren, etc.) using improved recursive query
        local descendants
        descendants=$(jq --arg pid "$task_id" '
            .tasks as $all |
            # Find direct children of a parent
            def get_children($parent_id):
                $all | map(select(.parentId == $parent_id));

            # Recursive function to get all descendants
            def get_all_descendants($parent_id):
                get_children($parent_id) as $children |
                if ($children | length) == 0 then
                    []
                else
                    $children + (
                        [$children[] | .id] | map(get_all_descendants(.)) | add // []
                    )
                end;

            get_all_descendants($pid) | map({id, title, status, type, parentId, labels})
        ' "$todo_file" 2>/dev/null)

        # Check for jq errors
        if [[ $? -ne 0 || -z "$descendants" ]]; then
            echo '{"error": "Failed to calculate descendants", "primary": null, "children": [], "totalCount": 0}'
            return 0
        fi

        if [[ "$descendants" != "null" && "$descendants" != "[]" ]]; then
            children_json="$descendants"
            local child_count
            child_count=$(echo "$descendants" | jq 'length')
            total_count=$((1 + child_count))
        fi
    fi

    # Build the result
    jq -n \
        --argjson primary "$primary_task" \
        --argjson children "$children_json" \
        --argjson total "$total_count" \
        '{
            "primary": $primary,
            "children": $children,
            "totalCount": $total
        }'
}

# Calculate impact of deletion on the task system
#
# Args:
#   $1 - affected_tasks_json: JSON from calculate_affected_tasks
#   $2 - todo_file: Path to todo.json
#
# Returns:
#   JSON object with impact analysis
#
# Output format:
#   {
#     "pendingLost": 1,
#     "activeLost": 2,
#     "blockedLost": 0,
#     "doneLost": 0,
#     "dependentsAffected": ["T010", "T011"]
#   }
calculate_impact() {
    local affected_tasks_json="$1"
    local todo_file="$2"

    # Extract affected task IDs
    local affected_ids
    affected_ids=$(echo "$affected_tasks_json" | jq -r '
        [.primary.id] + [.children[].id] |
        map(select(. != null))
    ')

    # Count tasks by status that would be lost
    local pending_lost=0
    local active_lost=0
    local blocked_lost=0
    local done_lost=0

    # Get status counts from affected tasks
    pending_lost=$(echo "$affected_tasks_json" | jq '
        ([.primary] + .children) |
        map(select(.status == "pending")) |
        length
    ')

    active_lost=$(echo "$affected_tasks_json" | jq '
        ([.primary] + .children) |
        map(select(.status == "active")) |
        length
    ')

    blocked_lost=$(echo "$affected_tasks_json" | jq '
        ([.primary] + .children) |
        map(select(.status == "blocked")) |
        length
    ')

    done_lost=$(echo "$affected_tasks_json" | jq '
        ([.primary] + .children) |
        map(select(.status == "done")) |
        length
    ')

    # Find tasks that depend on any of the affected tasks
    local dependents_affected
    dependents_affected=$(jq --argjson ids "$affected_ids" '
        .tasks |
        map(select(
            .depends != null and
            (.depends | length > 0) and
            (.depends | any(. as $dep | $ids | index($dep)))
        )) |
        map(select(.id as $tid | $ids | index($tid) | not)) |
        map(.id)
    ' "$todo_file" 2>/dev/null)

    if [[ -z "$dependents_affected" || "$dependents_affected" == "null" ]]; then
        dependents_affected="[]"
    fi

    # Build the impact result
    jq -n \
        --argjson pending "$pending_lost" \
        --argjson active "$active_lost" \
        --argjson blocked "$blocked_lost" \
        --argjson done "$done_lost" \
        --argjson dependents "$dependents_affected" \
        '{
            "pendingLost": $pending,
            "activeLost": $active,
            "blockedLost": $blocked,
            "doneLost": $done,
            "dependentsAffected": $dependents
        }'
}

# Generate warnings based on impact analysis
#
# Args:
#   $1 - affected_tasks_json: JSON from calculate_affected_tasks
#   $2 - impact_json: JSON from calculate_impact
#   $3 - strategy: Child handling strategy
#
# Returns:
#   JSON array of warning objects
#
# Output format:
#   [
#     { "severity": "high", "code": "W_ACTIVE_CANCELLED", "message": "2 active tasks would be cancelled" },
#     { "severity": "medium", "code": "W_BROKEN_DEPS", "message": "2 dependent tasks would lose dependencies" }
#   ]
generate_warnings() {
    local affected_tasks_json="$1"
    local impact_json="$2"
    local strategy="$3"

    local warnings="[]"

    # Extract impact values
    local active_lost
    active_lost=$(echo "$impact_json" | jq -r '.activeLost')

    local pending_lost
    pending_lost=$(echo "$impact_json" | jq -r '.pendingLost')

    local dependents_count
    dependents_count=$(echo "$impact_json" | jq '.dependentsAffected | length')

    local total_count
    total_count=$(echo "$affected_tasks_json" | jq '.totalCount')

    local children_count
    children_count=$(echo "$affected_tasks_json" | jq '.children | length')

    # HIGH severity: Active tasks being cancelled
    if [[ "$active_lost" -gt 0 ]]; then
        local msg="$active_lost active task(s) would be cancelled"
        warnings=$(echo "$warnings" | jq --arg sev "$SEVERITY_HIGH" \
            --arg code "W_ACTIVE_CANCELLED" \
            --arg msg "$msg" \
            '. + [{severity: $sev, code: $code, message: $msg}]')
    fi

    # HIGH severity: Many dependents affected (5+)
    if [[ "$dependents_count" -ge 5 ]]; then
        local msg="$dependents_count dependent tasks would lose dependencies"
        warnings=$(echo "$warnings" | jq --arg sev "$SEVERITY_HIGH" \
            --arg code "W_MANY_DEPENDENTS" \
            --arg msg "$msg" \
            '. + [{severity: $sev, code: $code, message: $msg}]')
    # MEDIUM severity: Some dependents affected (1-4)
    elif [[ "$dependents_count" -gt 0 ]]; then
        local msg="$dependents_count dependent task(s) would lose dependencies"
        warnings=$(echo "$warnings" | jq --arg sev "$SEVERITY_MEDIUM" \
            --arg code "W_BROKEN_DEPS" \
            --arg msg "$msg" \
            '. + [{severity: $sev, code: $code, message: $msg}]')
    fi

    # MEDIUM severity: Pending tasks being cancelled
    if [[ "$pending_lost" -gt 0 ]]; then
        local msg="$pending_lost pending task(s) would be cancelled"
        warnings=$(echo "$warnings" | jq --arg sev "$SEVERITY_MEDIUM" \
            --arg code "W_PENDING_CANCELLED" \
            --arg msg "$msg" \
            '. + [{severity: $sev, code: $code, message: $msg}]')
    fi

    # MEDIUM severity: Cascade deletion with children
    if [[ "$strategy" == "cascade" && "$children_count" -gt 0 ]]; then
        local msg="Cascade delete: $children_count child task(s) would be deleted with parent"
        warnings=$(echo "$warnings" | jq --arg sev "$SEVERITY_MEDIUM" \
            --arg code "W_CASCADE_DELETE" \
            --arg msg "$msg" \
            '. + [{severity: $sev, code: $code, message: $msg}]')
    fi

    # LOW severity: Task has focus
    local primary_status
    primary_status=$(echo "$affected_tasks_json" | jq -r '.primary.status')
    if [[ "$primary_status" == "active" ]]; then
        local msg="Task may have current focus (status is active)"
        warnings=$(echo "$warnings" | jq --arg sev "$SEVERITY_LOW" \
            --arg code "W_MAY_HAVE_FOCUS" \
            --arg msg "$msg" \
            '. + [{severity: $sev, code: $code, message: $msg}]')
    fi

    # LOW severity: Informational about total count
    if [[ "$total_count" -gt 1 ]]; then
        local msg="Total of $total_count task(s) would be affected"
        warnings=$(echo "$warnings" | jq --arg sev "$SEVERITY_LOW" \
            --arg code "W_TOTAL_AFFECTED" \
            --arg msg "$msg" \
            '. + [{severity: $sev, code: $code, message: $msg}]')
    fi

    echo "$warnings"
}

# Main preview function - coordinates all preview calculations
#
# Args:
#   $1 - task_id: ID of the task to delete
#   $2 - strategy: Child handling strategy (cascade|orphan|block)
#   $3 - reason: Reason for deletion
#   $4 - todo_file: Path to todo.json
#
# Returns:
#   JSON object with complete preview data (suitable for dry-run output)
#
# Output format:
#   {
#     "success": true,
#     "dryRun": true,
#     "wouldDelete": { ... },
#     "impact": { ... },
#     "warnings": [ ... ],
#     "strategy": "cascade",
#     "reason": "Duplicate task"
#   }
preview_delete() {
    local task_id="$1"
    local strategy="${2:-block}"
    local reason="${3:-}"
    local todo_file="$4"

    # Validate inputs
    if [[ -z "$task_id" ]]; then
        jq -n '{
            "success": false,
            "dryRun": true,
            "error": {
                "code": "E_MISSING_TASK_ID",
                "message": "Task ID is required"
            }
        }'
        return 0  # Return 0 so subshell doesn't fail with set -e
    fi

    if [[ ! -f "$todo_file" ]]; then
        jq -n --arg file "${todo_file:-<empty>}" '{
            "success": false,
            "dryRun": true,
            "error": {
                "code": "E_FILE_NOT_FOUND",
                "message": ("Todo file not found: " + $file)
            }
        }'
        return 0
    fi

    # Check if task exists
    local task_exists
    task_exists=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .id' "$todo_file" 2>/dev/null || true)

    if [[ -z "$task_exists" ]]; then
        jq -n --arg id "$task_id" '{
            "success": false,
            "dryRun": true,
            "error": {
                "code": "E_TASK_NOT_FOUND",
                "message": ("Task not found: " + $id)
            }
        }'
        return 0
    fi

    # Check if task is already completed (should use archive instead)
    local task_status
    task_status=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .status' "$todo_file" 2>/dev/null || true)

    if [[ "$task_status" == "done" ]]; then
        jq -n --arg id "$task_id" '{
            "success": false,
            "dryRun": true,
            "error": {
                "code": "E_TASK_COMPLETED",
                "message": ("Task is completed, use archive instead: " + $id),
                "suggestion": "Use \"cleo archive\" to archive completed tasks"
            }
        }'
        return 0
    fi

    # Check for children when strategy is 'block'
    if [[ "$strategy" == "block" ]]; then
        local has_children
        has_children=$(jq -r --arg id "$task_id" '.tasks | map(select(.parentId == $id)) | length' "$todo_file" 2>/dev/null || echo "0")

        if [[ "$has_children" -gt 0 ]]; then
            jq -n --arg id "$task_id" --argjson count "$has_children" '{
                "success": false,
                "dryRun": true,
                "error": {
                    "code": "E_HAS_CHILDREN",
                    "message": ("Task has " + ($count | tostring) + " child task(s). Use --children=cascade or --children=orphan"),
                    "childCount": $count
                }
            }'
            return 0
        fi
    fi

    # Calculate affected tasks
    local affected_tasks
    affected_tasks=$(calculate_affected_tasks "$task_id" "$strategy" "$todo_file")

    local calc_error
    calc_error=$(echo "$affected_tasks" | jq -r '.error // empty' 2>/dev/null || true)
    if [[ -n "$calc_error" ]]; then
        echo "$affected_tasks" | jq '{
            success: false,
            dryRun: true,
            error: {
                code: "E_CALCULATION_FAILED",
                message: .error
            }
        }'
        return 0
    fi

    # Calculate impact
    local impact
    impact=$(calculate_impact "$affected_tasks" "$todo_file")

    # Generate warnings
    local warnings
    warnings=$(generate_warnings "$affected_tasks" "$impact" "$strategy")

    # Build final preview result
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq -n \
        --arg ts "$timestamp" \
        --arg strat "$strategy" \
        --arg reason "$reason" \
        --argjson affected "$affected_tasks" \
        --argjson impact "$impact" \
        --argjson warnings "$warnings" \
        '{
            "success": true,
            "dryRun": true,
            "wouldDelete": $affected,
            "impact": $impact,
            "warnings": $warnings,
            "warningCount": ($warnings | length),
            "strategy": $strat,
            "reason": (if $reason == "" then null else $reason end),
            "timestamp": $ts
        }'
}

# Format preview for human-readable output
#
# Args:
#   $1 - preview_json: JSON from preview_delete
#   $2 - use_color: Whether to use ANSI colors (true/false)
#
# Outputs:
#   Human-readable text to stdout
format_preview_text() {
    local preview_json="$1"
    local use_color="${2:-false}"

    # Color codes
    local RED="" GREEN="" YELLOW="" CYAN="" BOLD="" NC=""
    if [[ "$use_color" == "true" ]]; then
        RED='\033[0;31m'
        GREEN='\033[0;32m'
        YELLOW='\033[1;33m'
        CYAN='\033[0;36m'
        BOLD='\033[1m'
        NC='\033[0m'
    fi

    # Check for errors
    local success
    success=$(echo "$preview_json" | jq -r '.success' 2>/dev/null || echo "false")

    if [[ "$success" != "true" ]]; then
        local error_msg
        error_msg=$(echo "$preview_json" | jq -r '.error.message // "Unknown error"' 2>/dev/null || echo "Failed to parse error")
        echo -e "${RED}[ERROR]${NC} $error_msg"
        return 0  # Return 0 but output indicates error
    fi

    echo ""
    echo -e "${BOLD}DRY RUN - Delete Preview${NC}"
    echo "========================"
    echo ""

    # Primary task
    echo -e "${CYAN}Primary Task:${NC}"
    local primary_id primary_title primary_status primary_type
    primary_id=$(echo "$preview_json" | jq -r '.wouldDelete.primary.id')
    primary_title=$(echo "$preview_json" | jq -r '.wouldDelete.primary.title')
    primary_status=$(echo "$preview_json" | jq -r '.wouldDelete.primary.status')
    primary_type=$(echo "$preview_json" | jq -r '.wouldDelete.primary.type // "task"')
    echo "  $primary_id: $primary_title [$primary_status, $primary_type]"

    # Children (if cascade)
    local child_count
    child_count=$(echo "$preview_json" | jq '.wouldDelete.children | length')

    if [[ "$child_count" -gt 0 ]]; then
        echo ""
        echo -e "${CYAN}Child Tasks (cascade):${NC}"
        echo "$preview_json" | jq -r '.wouldDelete.children[] | "  \(.id): \(.title) [\(.status)]"'
    fi

    # Impact summary
    echo ""
    echo -e "${CYAN}Impact Analysis:${NC}"
    local active_lost pending_lost blocked_lost dependents_count
    active_lost=$(echo "$preview_json" | jq -r '.impact.activeLost')
    pending_lost=$(echo "$preview_json" | jq -r '.impact.pendingLost')
    blocked_lost=$(echo "$preview_json" | jq -r '.impact.blockedLost')
    dependents_count=$(echo "$preview_json" | jq '.impact.dependentsAffected | length')

    echo "  Active tasks lost:   $active_lost"
    echo "  Pending tasks lost:  $pending_lost"
    echo "  Blocked tasks lost:  $blocked_lost"
    echo "  Dependents affected: $dependents_count"

    if [[ "$dependents_count" -gt 0 ]]; then
        echo ""
        echo "  Affected dependents:"
        echo "$preview_json" | jq -r '.impact.dependentsAffected[] | "    - \(.)"'
    fi

    # Warnings
    local warning_count
    warning_count=$(echo "$preview_json" | jq '.warningCount')

    if [[ "$warning_count" -gt 0 ]]; then
        echo ""
        echo -e "${CYAN}Warnings:${NC}"
        echo "$preview_json" | jq -r '.warnings[] |
            if .severity == "high" then "  [HIGH] \(.message)"
            elif .severity == "medium" then "  [MEDIUM] \(.message)"
            else "  [LOW] \(.message)"
            end'
    fi

    # Strategy and reason
    echo ""
    echo -e "${CYAN}Operation Details:${NC}"
    local strategy reason
    strategy=$(echo "$preview_json" | jq -r '.strategy')
    reason=$(echo "$preview_json" | jq -r '.reason // "Not specified"')
    echo "  Strategy: $strategy"
    echo "  Reason:   $reason"

    # Footer
    echo ""
    echo -e "${GREEN}No changes made.${NC}"
    echo "Run without --dry-run to execute deletion."
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f calculate_affected_tasks
export -f calculate_impact
export -f generate_warnings
export -f preview_delete
export -f format_preview_text

export SEVERITY_HIGH
export SEVERITY_MEDIUM
export SEVERITY_LOW
