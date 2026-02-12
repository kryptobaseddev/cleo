#!/usr/bin/env bash
###CLEO
# command: reparent
# category: write
# synopsis: Move task to different parent in hierarchy
# relevance: medium
# flags: --format,--quiet,--to
# exits: 0,1,2,3,4,10,11,12,13,14
# json-output: true
###END
# reparent.sh - Move a task to a different parent
#
# Usage:
#   cleo reparent T002 --to T001    # Move T002 under T001
#   cleo reparent T002 --to ""      # Remove parent (make root)
#
# Validates:
#   - Source task exists
#   - Target parent exists (if specified)
#   - Target has valid type (not subtask)
#   - Move doesn't exceed depth limit (3 levels)
#   - Move doesn't create circular reference
#   - Target doesn't exceed sibling limit
#
# Part of: Hierarchy Enhancement Phase 2 (T343)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source dependencies
source "${LIB_DIR}/core/exit-codes.sh"
source "${LIB_DIR}/core/output-format.sh"
source "${LIB_DIR}/validation/validation.sh"
source "${LIB_DIR}/tasks/hierarchy.sh"
source "${LIB_DIR}/data/file-ops.sh"
source "${LIB_DIR}/core/logging.sh"
source "${LIB_DIR}/ui/flags.sh"

# Source version library for proper version management
if [[ -f "$LIB_DIR/core/version.sh" ]]; then
  source "$LIB_DIR/core/version.sh"
fi

# Configuration
CLEO_DIR="${CLEO_DIR:-$(pwd)/.cleo}"
TODO_FILE="${TODO_FILE:-$CLEO_DIR/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-$CLEO_DIR/config.json}"
LOG_SCRIPT="${SCRIPT_DIR}/log.sh"

# Command name for error-json library
COMMAND_NAME="reparent"

# Arguments
TASK_ID=""
NEW_PARENT=""

# Initialize flag defaults
init_flag_defaults

usage() {
    cat << 'EOF'
reparent - Move a task to a different parent

Usage: cleo reparent TASK_ID --to PARENT_ID [OPTIONS]

Arguments:
  TASK_ID               Task to move
  --to PARENT_ID        New parent task ID (use "" to remove parent)

Options:
  --format FORMAT       Output format: text|json (default: text)
  -q, --quiet           Minimal output
  -h, --help            Show this help

Examples:
  cleo reparent T002 --to T001    # Move T002 under T001
  cleo reparent T002 --to ""      # Make T002 a root task
  cleo reparent T005 --to T003    # Move subtask to different parent

Validations performed:
  - Source task must exist
  - Target parent must exist (if specified)
  - Target cannot be a subtask (subtasks cannot have children)
  - Move cannot exceed max depth (3 levels)
  - Move cannot create circular reference
  - Target cannot exceed max siblings limit
EOF
    exit 0
}

# Parse common flags first
parse_common_flags "$@"
set -- "${REMAINING_ARGS[@]}"

# Bridge to legacy variables
apply_flags_to_globals
FORMAT="${FORMAT:-}"
QUIET="${QUIET:-false}"

# Handle help flag
if [[ "$FLAG_HELP" == true ]]; then
    usage
fi

# Parse command-specific arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --to) NEW_PARENT="$2"; shift 2 ;;
        T[0-9]*) TASK_ID="$1"; shift ;;
        -*)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
        *) shift ;;
    esac
done

# Resolve format
FORMAT=$(resolve_format "$FORMAT")

# Validate required arguments
if [[ -z "$TASK_ID" ]]; then
    echo "ERROR: Task ID required" >&2
    exit "$EXIT_INVALID_INPUT"
fi

if [[ -z "${NEW_PARENT+set}" ]]; then
    echo "ERROR: --to PARENT_ID required (use --to \"\" to remove parent)" >&2
    exit "$EXIT_INVALID_INPUT"
fi

# Validate source task exists
if ! jq -e --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE" >/dev/null 2>&1; then
    echo "ERROR: Task $TASK_ID not found" >&2
    exit "$EXIT_NOT_FOUND"
fi

# Get current task data
TASK_DATA=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE")
OLD_PARENT=$(echo "$TASK_DATA" | jq -r '.parentId // ""')
TASK_TYPE=$(echo "$TASK_DATA" | jq -r '.type // "task"')

# If new parent specified, validate it
if [[ -n "$NEW_PARENT" ]]; then
    # Check parent exists
    if ! jq -e --arg id "$NEW_PARENT" '.tasks[] | select(.id == $id)' "$TODO_FILE" >/dev/null 2>&1; then
        echo "ERROR: Parent task $NEW_PARENT not found" >&2
        exit "$EXIT_PARENT_NOT_FOUND"
    fi

    # Check parent is not a subtask
    PARENT_TYPE=$(jq -r --arg id "$NEW_PARENT" '.tasks[] | select(.id == $id) | .type // "task"' "$TODO_FILE")
    if [[ "$PARENT_TYPE" == "subtask" ]]; then
        echo "ERROR: Cannot reparent to a subtask (subtasks cannot have children)" >&2
        exit "$EXIT_INVALID_PARENT_TYPE"
    fi

    # Check for circular reference
    if [[ "$NEW_PARENT" == "$TASK_ID" ]]; then
        echo "ERROR: Task cannot be its own parent" >&2
        exit "$EXIT_CIRCULAR_REFERENCE"
    fi

    # Check depth limit (validate_max_depth from lib/tasks/hierarchy.sh)
    if ! validate_max_depth "$NEW_PARENT" "$TODO_FILE"; then
        echo "ERROR: Move would exceed maximum hierarchy depth (3 levels)" >&2
        exit "$EXIT_DEPTH_EXCEEDED"
    fi

    # Check sibling limit
    if ! validate_max_siblings "$NEW_PARENT" "$TODO_FILE"; then
        echo "ERROR: Target parent has reached maximum children limit" >&2
        exit "$EXIT_SIBLING_LIMIT"
    fi
fi

# Perform the reparent with position handling (T805)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Get current position of task being moved
OLD_POSITION=$(echo "$TASK_DATA" | jq -r '.position // 0')

# Calculate new position in target parent (append at end)
if [[ -n "$NEW_PARENT" ]]; then
    NEW_POSITION=$(get_next_position "$NEW_PARENT" "$TODO_FILE" 2>/dev/null || echo 1)
else
    NEW_POSITION=$(get_next_position "null" "$TODO_FILE" 2>/dev/null || echo 1)
fi

# Build the jq update that:
# 1. Closes gap in old parent (shift siblings with pos > old_pos down by 1)
# 2. Sets new parent and position on the moved task
# Note: updatedAt is set on moved task for data integrity (T2071)
if [[ -n "$OLD_PARENT" ]]; then
    # Moving from a parent (non-root)
    UPDATED_JSON=$(jq --arg id "$TASK_ID" --arg parent "$NEW_PARENT" --arg ts "$TIMESTAMP" \
        --arg old_parent "$OLD_PARENT" --argjson old_pos "$OLD_POSITION" \
        --argjson new_pos "$NEW_POSITION" '
        .tasks = [.tasks[] |
            if .id == $id then
                # Move the task
                (if $parent == "" then del(.parentId) else .parentId = $parent end) |
                .position = $new_pos |
                .positionVersion = ((.positionVersion // 0) + 1) |
                .updatedAt = $ts
            elif .parentId == $old_parent and (.position // 0) > $old_pos then
                # Close gap in old parent
                .position = (.position - 1) |
                .positionVersion = ((.positionVersion // 0) + 1) |
                .updatedAt = $ts
            else .
            end
        ] |
        .lastUpdated = $ts
    ' "$TODO_FILE")
else
    # Moving from root level
    UPDATED_JSON=$(jq --arg id "$TASK_ID" --arg parent "$NEW_PARENT" --arg ts "$TIMESTAMP" \
        --argjson old_pos "$OLD_POSITION" --argjson new_pos "$NEW_POSITION" '
        .tasks = [.tasks[] |
            if .id == $id then
                # Move the task
                (if $parent == "" then del(.parentId) else .parentId = $parent end) |
                .position = $new_pos |
                .positionVersion = ((.positionVersion // 0) + 1) |
                .updatedAt = $ts
            elif (.parentId == null or .parentId == "null") and (.position // 0) > $old_pos then
                # Close gap in old parent (root level)
                .position = (.position - 1) |
                .positionVersion = ((.positionVersion // 0) + 1) |
                .updatedAt = $ts
            else .
            end
        ] |
        .lastUpdated = $ts
    ' "$TODO_FILE")
fi

# Save with file locking
if save_json "$TODO_FILE" "$UPDATED_JSON"; then
    # Log the operation
    if [[ -f "$LOG_SCRIPT" ]]; then
        "$LOG_SCRIPT" \
            --action "reparent" \
            --task-id "$TASK_ID" \
            --before "{\"parentId\":\"$OLD_PARENT\"}" \
            --after "{\"parentId\":\"$NEW_PARENT\"}" \
            --actor "user" >/dev/null 2>&1 || true
    fi

    # Output
    if [[ "$FORMAT" == "json" ]]; then
        jq -nc \
            --arg version "${CLEO_VERSION:-$(get_version)}" \
            --arg taskId "$TASK_ID" \
            --arg oldParent "$OLD_PARENT" \
            --arg newParent "$NEW_PARENT" \
            --arg timestamp "$TIMESTAMP" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": { "format": "json", "command": "reparent", "version": $version, "timestamp": $timestamp },
                "success": true,
                "taskId": $taskId,
                "oldParent": (if $oldParent == "" then null else $oldParent end),
                "newParent": (if $newParent == "" then null else $newParent end)
            }'
    elif [[ "$QUIET" != true ]]; then
        if [[ -n "$NEW_PARENT" ]]; then
            echo "Moved $TASK_ID under $NEW_PARENT"
        else
            echo "Removed parent from $TASK_ID (now root task)"
        fi
    fi
else
    echo "ERROR: Failed to save changes" >&2
    exit "$EXIT_FILE_ERROR"
fi