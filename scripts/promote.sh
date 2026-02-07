#!/usr/bin/env bash
###CLEO
# command: promote
# category: write
# synopsis: Remove parent from task, making it root-level
# relevance: medium
# flags: --format,--quiet,--no-type-update
# exits: 0,1,2,3,4
# json-output: true
###END
# promote.sh - Remove parent from a task (make it root-level)
#
# Usage:
#   cleo promote T002    # Remove parent, make T002 root task
#
# Optionally updates type if was subtask -> task
#
# Part of: Hierarchy Enhancement Phase 2 (T344)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

source "${LIB_DIR}/exit-codes.sh"
source "${LIB_DIR}/output-format.sh"
source "${LIB_DIR}/file-ops.sh"
source "${LIB_DIR}/logging.sh"
source "${LIB_DIR}/flags.sh"

# Source version library for proper version management
if [[ -f "$LIB_DIR/version.sh" ]]; then
  source "$LIB_DIR/version.sh"
fi

CLEO_DIR="${CLEO_DIR:-$(pwd)/.cleo}"
TODO_FILE="${TODO_FILE:-$CLEO_DIR/todo.json}"
LOG_SCRIPT="${SCRIPT_DIR}/log.sh"

# Command name for error-json library
COMMAND_NAME="promote"

TASK_ID=""
UPDATE_TYPE=true  # Auto-update type if subtask

# Initialize flag defaults
init_flag_defaults

usage() {
    cat << 'EOF'
promote - Remove parent from a task (make root-level)

Usage: cleo promote TASK_ID [OPTIONS]

Arguments:
  TASK_ID               Task to promote to root level

Options:
  --no-type-update      Don't auto-update type (keep as subtask)
  --format FORMAT       Output format: text|json (default: text)
  -q, --quiet           Minimal output
  -h, --help            Show this help

Examples:
  cleo promote T002       # Make T002 a root task
  cleo promote T005 -q    # Quiet promotion

Notes:
  - If task was a subtask, type is automatically changed to 'task'
  - Use --no-type-update to keep original type
  - Equivalent to: cleo reparent T002 --to ""
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
        --no-type-update) UPDATE_TYPE=false; shift ;;
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

if [[ -z "$TASK_ID" ]]; then
    echo "ERROR: Task ID required" >&2
    exit "$EXIT_INVALID_INPUT"
fi

# Validate task exists
if ! jq -e --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE" >/dev/null 2>&1; then
    echo "ERROR: Task $TASK_ID not found" >&2
    exit "$EXIT_NOT_FOUND"
fi

# Get current data
TASK_DATA=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE")
OLD_PARENT=$(echo "$TASK_DATA" | jq -r '.parentId // ""')
OLD_TYPE=$(echo "$TASK_DATA" | jq -r '.type // "task"')

# Check if already root
if [[ -z "$OLD_PARENT" ]]; then
    if [[ "$FORMAT" == "json" ]]; then
        jq -nc --arg id "$TASK_ID" '{"success": true, "taskId": $id, "message": "Task is already root-level"}'
    else
        [[ "$QUIET" != true ]] && echo "$TASK_ID is already a root task"
    fi
    exit 0
fi

# Determine new type
NEW_TYPE="$OLD_TYPE"
if [[ "$UPDATE_TYPE" == true && "$OLD_TYPE" == "subtask" ]]; then
    NEW_TYPE="task"
fi

# Perform promotion
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

UPDATED_JSON=$(jq --arg id "$TASK_ID" --arg type "$NEW_TYPE" --arg ts "$TIMESTAMP" '
    .tasks |= map(
        if .id == $id then
            del(.parentId) |
            .type = $type
        else . end
    ) |
    .lastUpdated = $ts
' "$TODO_FILE")

if save_json "$TODO_FILE" "$UPDATED_JSON"; then
    # Log operation
    if [[ -f "$LOG_SCRIPT" ]]; then
        "$LOG_SCRIPT" \
            --action "promote" \
            --task-id "$TASK_ID" \
            --before "{\"parentId\":\"$OLD_PARENT\",\"type\":\"$OLD_TYPE\"}" \
            --after "{\"parentId\":null,\"type\":\"$NEW_TYPE\"}" \
            --actor "user" >/dev/null 2>&1 || true
    fi

    if [[ "$FORMAT" == "json" ]]; then
        jq -nc \
            --arg version "${CLEO_VERSION:-$(get_version)}" \
            --arg taskId "$TASK_ID" \
            --arg oldParent "$OLD_PARENT" \
            --arg oldType "$OLD_TYPE" \
            --arg newType "$NEW_TYPE" \
            --arg timestamp "$TIMESTAMP" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": { "format": "json", "command": "promote", "version": $version, "timestamp": $timestamp },
                "success": true,
                "taskId": $taskId,
                "oldParent": $oldParent,
                "oldType": $oldType,
                "newType": $newType
            }'
    elif [[ "$QUIET" != true ]]; then
        if [[ "$OLD_TYPE" != "$NEW_TYPE" ]]; then
            echo "Promoted $TASK_ID to root (type: $OLD_TYPE -> $NEW_TYPE)"
        else
            echo "Promoted $TASK_ID to root"
        fi
    fi
else
    echo "ERROR: Failed to save changes" >&2
    exit "$EXIT_FILE_ERROR"
fi