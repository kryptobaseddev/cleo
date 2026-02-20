#!/usr/bin/env bash
###CLEO
# command: reorder
# category: write
# synopsis: Change task position within sibling group (move to position, before/after, top/bottom)
# relevance: medium
# flags: --position,--before,--after,--top,--bottom,--format,--quiet
# exits: 0,2,4
# json-output: true
###END
# reorder.sh - Change the position of a task within its sibling group
#
# Usage:
#   cleo reorder T002 --position 1      # Move to position 1
#   cleo reorder T002 --before T003     # Move before T003
#   cleo reorder T002 --after T001      # Move after T001
#   cleo reorder T002 --top             # Move to first position
#   cleo reorder T002 --bottom          # Move to last position
#   cleo swap T001 T002                 # Swap positions of two tasks
#
# Part of: Explicit Positional Ordering System (T805)

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

# Source version library
if [[ -f "$LIB_DIR/core/version.sh" ]]; then
  source "$LIB_DIR/core/version.sh"
fi

# Configuration
CLEO_DIR="${CLEO_DIR:-$(pwd)/.cleo}"
TODO_FILE="${TODO_FILE:-$CLEO_DIR/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-$CLEO_DIR/config.json}"
LOG_SCRIPT="${SCRIPT_DIR}/log.sh"

# Command name for output
COMMAND_NAME="reorder"

# Arguments
TASK_ID=""
TARGET_POSITION=""
BEFORE_ID=""
AFTER_ID=""
SWAP_ID=""
MOVE_TOP=false
MOVE_BOTTOM=false

# Initialize flag defaults
init_flag_defaults

usage() {
    cat << 'EOF'
reorder - Change the position of a task within its sibling group

Usage: cleo reorder TASK_ID [OPTIONS]
       cleo swap TASK_ID1 TASK_ID2    # Swap positions of two tasks

Options:
  --position N        Move task to position N (1-indexed)
  --before TASK_ID    Move task before the specified task
  --after TASK_ID     Move task after the specified task
  --top               Move task to position 1 (first)
  --bottom            Move task to last position
  --format FORMAT     Output format: text|json (default: auto-detect)
  -q, --quiet         Minimal output
  -h, --help          Show this help

Position Shuffle Rules:
  When moving a task to position N:
  - SHUFFLE_UP (N < current): siblings at pos N..current-1 shift +1
  - SHUFFLE_DOWN (N > current): siblings at pos current+1..N shift -1
  - Target task gets position N

Examples:
  cleo reorder T005 --position 1       # Move T005 to first position
  cleo reorder T005 --before T002      # Move T005 before T002
  cleo reorder T005 --after T003       # Move T005 after T003
  cleo reorder T005 --top              # Move T005 to first position
  cleo reorder T005 --bottom           # Move T005 to last position
  cleo swap T001 T003                  # Swap positions of T001 and T003
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
        --position) TARGET_POSITION="$2"; shift 2 ;;
        --before) BEFORE_ID="$2"; shift 2 ;;
        --after) AFTER_ID="$2"; shift 2 ;;
        --top) MOVE_TOP=true; shift ;;
        --bottom) MOVE_BOTTOM=true; shift ;;
        T[0-9]*)
            if [[ -z "$TASK_ID" ]]; then
                TASK_ID="$1"
            elif [[ -z "$SWAP_ID" ]]; then
                SWAP_ID="$1"
            fi
            shift
            ;;
        -*)
            echo "Unknown option: $1" >&2
            exit "$EXIT_INVALID_INPUT"
            ;;
        *) shift ;;
    esac
done

# Resolve format
FORMAT=$(resolve_format "$FORMAT")

# Validate task ID provided
if [[ -z "$TASK_ID" ]]; then
    echo "ERROR: Task ID required" >&2
    exit "$EXIT_INVALID_INPUT"
fi

# Validate file exists
if [[ ! -f "$TODO_FILE" ]]; then
    echo "ERROR: Todo file not found: $TODO_FILE" >&2
    exit "$EXIT_FILE_ERROR"
fi

# Get task info
TASK_JSON=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE" 2>/dev/null)
if [[ -z "$TASK_JSON" || "$TASK_JSON" == "null" ]]; then
    echo "ERROR: Task $TASK_ID not found" >&2
    exit "$EXIT_NOT_FOUND"
fi

PARENT_ID=$(echo "$TASK_JSON" | jq -r '.parentId // "null"')
CURRENT_POSITION=$(echo "$TASK_JSON" | jq -r '.position // 0')

# Handle swap operation
if [[ -n "$SWAP_ID" ]]; then
    # Validate swap target exists
    SWAP_JSON=$(jq --arg id "$SWAP_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE" 2>/dev/null)
    if [[ -z "$SWAP_JSON" || "$SWAP_JSON" == "null" ]]; then
        echo "ERROR: Task $SWAP_ID not found" >&2
        exit "$EXIT_NOT_FOUND"
    fi

    # Validate same parent
    SWAP_PARENT=$(echo "$SWAP_JSON" | jq -r '.parentId // "null"')
    if [[ "$PARENT_ID" != "$SWAP_PARENT" ]]; then
        echo "ERROR: Cannot swap tasks with different parents" >&2
        echo "  $TASK_ID parent: $PARENT_ID" >&2
        echo "  $SWAP_ID parent: $SWAP_PARENT" >&2
        exit "$EXIT_INVALID_INPUT"
    fi

    SWAP_POSITION=$(echo "$SWAP_JSON" | jq -r '.position // 0')

    # Perform swap
    # Note: updatedAt is set on swapped tasks for data integrity (T2071)
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    UPDATED_CONTENT=$(jq --arg id1 "$TASK_ID" --arg id2 "$SWAP_ID" \
        --argjson pos1 "$CURRENT_POSITION" --argjson pos2 "$SWAP_POSITION" \
        --arg ts "$TIMESTAMP" '
        .tasks = [.tasks[] |
            if .id == $id1 then
                .position = $pos2 |
                .positionVersion = ((.positionVersion // 0) + 1) |
                .updatedAt = $ts
            elif .id == $id2 then
                .position = $pos1 |
                .positionVersion = ((.positionVersion // 0) + 1) |
                .updatedAt = $ts
            else .
            end
        ] |
        .lastUpdated = $ts
    ' "$TODO_FILE")

    # Save
    save_json "$TODO_FILE" "$UPDATED_CONTENT"

    # Log
    if [[ -x "$LOG_SCRIPT" ]]; then
        "$LOG_SCRIPT" "swap" "$TASK_ID" "Swapped position with $SWAP_ID ($CURRENT_POSITION <-> $SWAP_POSITION)" 2>/dev/null || true
    fi

    # Output
    if [[ "$FORMAT" == "json" ]]; then
        jq -nc --arg id1 "$TASK_ID" --arg id2 "$SWAP_ID" \
            --argjson pos1 "$SWAP_POSITION" --argjson pos2 "$CURRENT_POSITION" \
            --argjson oldPos1 "$CURRENT_POSITION" --argjson oldPos2 "$SWAP_POSITION" '{
            success: true,
            operation: "swap",
            changes: [
                {id: $id1, oldPosition: $oldPos1, newPosition: $pos1},
                {id: $id2, oldPosition: $oldPos2, newPosition: $pos2}
            ]
        }'
    elif [[ "$QUIET" != true ]]; then
        echo "Swapped $TASK_ID (pos $CURRENT_POSITION -> $SWAP_POSITION) with $SWAP_ID (pos $SWAP_POSITION -> $CURRENT_POSITION)"
    fi

    exit "$EXIT_SUCCESS"
fi

# Determine target position
if [[ "$MOVE_TOP" == true ]]; then
    TARGET_POSITION=1
elif [[ "$MOVE_BOTTOM" == true ]]; then
    MAX_POS=$(get_max_position "$PARENT_ID" "$TODO_FILE")
    TARGET_POSITION="$MAX_POS"
elif [[ -n "$BEFORE_ID" ]]; then
    # Get position of target task
    BEFORE_POSITION=$(jq -r --arg id "$BEFORE_ID" '.tasks[] | select(.id == $id) | .position // 0' "$TODO_FILE")
    if [[ "$BEFORE_POSITION" == "0" || -z "$BEFORE_POSITION" ]]; then
        echo "ERROR: Task $BEFORE_ID not found or has no position" >&2
        exit "$EXIT_NOT_FOUND"
    fi
    # Validate same parent
    BEFORE_PARENT=$(jq -r --arg id "$BEFORE_ID" '.tasks[] | select(.id == $id) | .parentId // "null"' "$TODO_FILE")
    if [[ "$PARENT_ID" != "$BEFORE_PARENT" ]]; then
        echo "ERROR: Cannot reorder relative to task with different parent" >&2
        exit "$EXIT_INVALID_INPUT"
    fi
    TARGET_POSITION="$BEFORE_POSITION"
elif [[ -n "$AFTER_ID" ]]; then
    # Get position of target task
    AFTER_POSITION=$(jq -r --arg id "$AFTER_ID" '.tasks[] | select(.id == $id) | .position // 0' "$TODO_FILE")
    if [[ "$AFTER_POSITION" == "0" || -z "$AFTER_POSITION" ]]; then
        echo "ERROR: Task $AFTER_ID not found or has no position" >&2
        exit "$EXIT_NOT_FOUND"
    fi
    # Validate same parent
    AFTER_PARENT=$(jq -r --arg id "$AFTER_ID" '.tasks[] | select(.id == $id) | .parentId // "null"' "$TODO_FILE")
    if [[ "$PARENT_ID" != "$AFTER_PARENT" ]]; then
        echo "ERROR: Cannot reorder relative to task with different parent" >&2
        exit "$EXIT_INVALID_INPUT"
    fi
    TARGET_POSITION=$((AFTER_POSITION + 1))
fi

# Validate target position provided
if [[ -z "$TARGET_POSITION" ]]; then
    echo "ERROR: No position specified. Use --position, --before, --after, --top, or --bottom" >&2
    exit "$EXIT_INVALID_INPUT"
fi

# Validate position is positive
if [[ "$TARGET_POSITION" -lt 1 ]]; then
    TARGET_POSITION=1
fi

# Clamp to max position
MAX_POS=$(get_max_position "$PARENT_ID" "$TODO_FILE")
if [[ "$TARGET_POSITION" -gt "$MAX_POS" ]]; then
    TARGET_POSITION="$MAX_POS"
fi

# No-op check
if [[ "$CURRENT_POSITION" -eq "$TARGET_POSITION" ]]; then
    if [[ "$FORMAT" == "json" ]]; then
        jq -nc --arg id "$TASK_ID" --argjson pos "$CURRENT_POSITION" '{
            success: true,
            operation: "reorder",
            noChange: true,
            task: {id: $id, position: $pos}
        }'
    elif [[ "$QUIET" != true ]]; then
        echo "Task $TASK_ID already at position $TARGET_POSITION"
    fi
    exit "$EXIT_NO_CHANGE"
fi

# Build shuffle expression based on direction
# Note: updatedAt is set on all affected tasks for data integrity (T2071)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [[ "$TARGET_POSITION" -lt "$CURRENT_POSITION" ]]; then
    # SHUFFLE_UP: Move up, shift affected siblings down (+1)
    # Affected: siblings WHERE pos >= target AND pos < current
    if [[ "$PARENT_ID" == "null" ]]; then
        UPDATED_CONTENT=$(jq --arg id "$TASK_ID" \
            --argjson target "$TARGET_POSITION" \
            --argjson current "$CURRENT_POSITION" \
            --arg ts "$TIMESTAMP" '
            .tasks = [.tasks[] |
                if .id == $id then
                    .position = $target |
                    .positionVersion = ((.positionVersion // 0) + 1) |
                    .updatedAt = $ts
                elif (.parentId == null or .parentId == "null") and
                     (.position // 0) >= $target and (.position // 0) < $current then
                    .position = (.position + 1) |
                    .positionVersion = ((.positionVersion // 0) + 1) |
                    .updatedAt = $ts
                else .
                end
            ] |
            .lastUpdated = $ts
        ' "$TODO_FILE")
    else
        UPDATED_CONTENT=$(jq --arg id "$TASK_ID" --arg pid "$PARENT_ID" \
            --argjson target "$TARGET_POSITION" \
            --argjson current "$CURRENT_POSITION" \
            --arg ts "$TIMESTAMP" '
            .tasks = [.tasks[] |
                if .id == $id then
                    .position = $target |
                    .positionVersion = ((.positionVersion // 0) + 1) |
                    .updatedAt = $ts
                elif .parentId == $pid and
                     (.position // 0) >= $target and (.position // 0) < $current then
                    .position = (.position + 1) |
                    .positionVersion = ((.positionVersion // 0) + 1) |
                    .updatedAt = $ts
                else .
                end
            ] |
            .lastUpdated = $ts
        ' "$TODO_FILE")
    fi
else
    # SHUFFLE_DOWN: Move down, shift affected siblings up (-1)
    # Affected: siblings WHERE pos > current AND pos <= target
    if [[ "$PARENT_ID" == "null" ]]; then
        UPDATED_CONTENT=$(jq --arg id "$TASK_ID" \
            --argjson target "$TARGET_POSITION" \
            --argjson current "$CURRENT_POSITION" \
            --arg ts "$TIMESTAMP" '
            .tasks = [.tasks[] |
                if .id == $id then
                    .position = $target |
                    .positionVersion = ((.positionVersion // 0) + 1) |
                    .updatedAt = $ts
                elif (.parentId == null or .parentId == "null") and
                     (.position // 0) > $current and (.position // 0) <= $target then
                    .position = (.position - 1) |
                    .positionVersion = ((.positionVersion // 0) + 1) |
                    .updatedAt = $ts
                else .
                end
            ] |
            .lastUpdated = $ts
        ' "$TODO_FILE")
    else
        UPDATED_CONTENT=$(jq --arg id "$TASK_ID" --arg pid "$PARENT_ID" \
            --argjson target "$TARGET_POSITION" \
            --argjson current "$CURRENT_POSITION" \
            --arg ts "$TIMESTAMP" '
            .tasks = [.tasks[] |
                if .id == $id then
                    .position = $target |
                    .positionVersion = ((.positionVersion // 0) + 1) |
                    .updatedAt = $ts
                elif .parentId == $pid and
                     (.position // 0) > $current and (.position // 0) <= $target then
                    .position = (.position - 1) |
                    .positionVersion = ((.positionVersion // 0) + 1) |
                    .updatedAt = $ts
                else .
                end
            ] |
            .lastUpdated = $ts
        ' "$TODO_FILE")
    fi
fi

# Save
save_json "$TODO_FILE" "$UPDATED_CONTENT"

# Log
if [[ -x "$LOG_SCRIPT" ]]; then
    "$LOG_SCRIPT" "reorder" "$TASK_ID" "Position changed from $CURRENT_POSITION to $TARGET_POSITION" 2>/dev/null || true
fi

# Calculate affected count
if [[ "$TARGET_POSITION" -lt "$CURRENT_POSITION" ]]; then
    AFFECTED_COUNT=$((CURRENT_POSITION - TARGET_POSITION))
else
    AFFECTED_COUNT=$((TARGET_POSITION - CURRENT_POSITION))
fi

# Output
if [[ "$FORMAT" == "json" ]]; then
    jq -nc --arg id "$TASK_ID" \
        --argjson oldPos "$CURRENT_POSITION" \
        --argjson newPos "$TARGET_POSITION" \
        --argjson affected "$AFFECTED_COUNT" \
        --arg parent "$PARENT_ID" '{
        success: true,
        operation: "reorder",
        task: {
            id: $id,
            oldPosition: $oldPos,
            newPosition: $newPos,
            parentId: (if $parent == "null" then null else $parent end)
        },
        affectedSiblings: $affected
    }'
elif [[ "$QUIET" != true ]]; then
    echo "Moved $TASK_ID from position $CURRENT_POSITION to $TARGET_POSITION ($AFFECTED_COUNT siblings shifted)"
fi

exit "$EXIT_SUCCESS"
