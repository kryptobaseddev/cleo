#!/usr/bin/env bash
# CLEO Uncancel Script (Restore from Cancelled)
# Restore cancelled tasks back to pending status
#
# This script implements the restore-from-cancelled functionality.
# Cancelled tasks remain in todo.json with status="cancelled" and can
# be restored to "pending" status via this command.
#
# Version: 0.32.0
# Part of: Task Deletion Enhancement (T710)
# Spec: TASK-DELETION-SPEC.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"
LOG_SCRIPT="${SCRIPT_DIR}/log.sh"

# Command name for error-json library
COMMAND_NAME="uncancel"

# ============================================================================
# LIBRARY LOADING
# ============================================================================

LIB_DIR="${SCRIPT_DIR}/../lib"

# Source version library for proper version management
if [[ -f "$LIB_DIR/version.sh" ]]; then
    # shellcheck source=../lib/version.sh
    source "$LIB_DIR/version.sh"
fi

# Source logging library for should_use_color function
if [[ -f "$LIB_DIR/logging.sh" ]]; then
    # shellcheck source=../lib/logging.sh
    source "$LIB_DIR/logging.sh"
fi

# Source file operations library for atomic writes with locking
if [[ -f "$LIB_DIR/file-ops.sh" ]]; then
    # shellcheck source=../lib/file-ops.sh
    source "$LIB_DIR/file-ops.sh"
fi

# Source backup library for unified backup management
if [[ -f "$LIB_DIR/backup.sh" ]]; then
    # shellcheck source=../lib/backup.sh
    source "$LIB_DIR/backup.sh"
fi

# Source output formatting library for format resolution
if [[ -f "$LIB_DIR/output-format.sh" ]]; then
    # shellcheck source=../lib/output-format.sh
    source "$LIB_DIR/output-format.sh"
fi

# Source error JSON library (includes exit-codes.sh)
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
    # shellcheck source=../lib/error-json.sh
    source "$LIB_DIR/error-json.sh"
elif [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
    # Fallback: source exit codes directly
    # shellcheck source=../lib/exit-codes.sh
    source "$LIB_DIR/exit-codes.sh"
fi

# Source hierarchy library for child operations
if [[ -f "$LIB_DIR/hierarchy.sh" ]]; then
    # shellcheck source=../lib/hierarchy.sh
    source "$LIB_DIR/hierarchy.sh"
fi

# Source config library for unified config access
if [[ -f "$LIB_DIR/config.sh" ]]; then
    # shellcheck source=../lib/config.sh
    source "$LIB_DIR/config.sh"
fi

# Fallback exit codes if libraries not loaded
: "${EXIT_SUCCESS:=0}"
: "${EXIT_INVALID_INPUT:=2}"
: "${EXIT_FILE_ERROR:=3}"
: "${EXIT_NOT_FOUND:=4}"
: "${EXIT_VALIDATION_ERROR:=6}"
: "${EXIT_NO_CHANGE:=102}"

# Fallback error codes
: "${E_INPUT_MISSING:=E_INPUT_MISSING}"
: "${E_INPUT_INVALID:=E_INPUT_INVALID}"
: "${E_TASK_NOT_FOUND:=E_TASK_NOT_FOUND}"
: "${E_TASK_INVALID_ID:=E_TASK_INVALID_ID}"
: "${E_NOT_INITIALIZED:=E_NOT_INITIALIZED}"
: "${E_TASK_NOT_CANCELLED:=E_TASK_NOT_CANCELLED}"

# ============================================================================
# COLOR SETUP
# ============================================================================

if declare -f should_use_color >/dev/null 2>&1 && should_use_color; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' BLUE='' NC=''
fi

# ============================================================================
# DEFAULTS
# ============================================================================

TASK_ID=""
NOTES=""
CASCADE=false
DRY_RUN=false
FORMAT=""
QUIET=false

# ============================================================================
# USAGE
# ============================================================================

usage() {
    cat << 'EOF'
Usage: cleo uncancel TASK_ID [OPTIONS]

Restore a cancelled task back to pending status.

Arguments:
  TASK_ID               Task ID to restore (e.g., T001)

Options:
  --cascade             Also restore cancelled child tasks
  --notes TEXT          Add note explaining why task was restored
  --dry-run             Preview changes without applying
  -f, --format FMT      Output format: text, json (default: auto-detect)
  --human               Force human-readable text output
  --json                Force JSON output
  -q, --quiet           Suppress non-essential output
  -h, --help            Show this help

Behavior:
  - Task status changes from 'cancelled' to 'pending'
  - Original cancellation reason is preserved in notes
  - cancelledAt and cancellationReason fields are cleared
  - Task remains in todo.json (no file moves needed)

Exit Codes:
  0   = Success
  2   = Invalid input or arguments
  3   = File operation failure
  4   = Task not found
  6   = Task is not cancelled (use update for other status changes)
  102 = No changes (already pending or dry-run)

JSON Output Structure:
  {
    "_meta": {"command": "uncancel", "timestamp": "...", "version": "..."},
    "success": true,
    "taskId": "T001",
    "restoredAt": "2025-12-17T10:00:00Z",
    "previousStatus": "cancelled",
    "newStatus": "pending",
    "restoredTasks": ["T001"],
    "cascadeRestored": false,
    "originalReason": "..."
  }

Examples:
  cleo uncancel T001                    # Restore single task
  cleo uncancel T001 --cascade          # Restore with children
  cleo uncancel T001 --notes "Reviving" # Add restoration note
  cleo uncancel T001 --dry-run          # Preview changes
  cleo uncancel T001 --json             # JSON output
EOF
    exit 0
}

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

log_info()  { [[ "$QUIET" != true ]] && echo -e "${GREEN}[INFO]${NC} $1" || true; }
log_warn()  { [[ "$QUIET" != true ]] && echo -e "${YELLOW}[WARN]${NC} $1" || true; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

check_deps() {
    if ! command -v jq &> /dev/null; then
        log_error "jq is required but not installed"
        exit 1
    fi
}

# ============================================================================
# ARGUMENT PARSING
# ============================================================================

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            usage
            ;;
        -q|--quiet)
            QUIET=true
            shift
            ;;
        --cascade)
            CASCADE=true
            shift
            ;;
        --notes)
            NOTES="${2:-}"
            if [[ -z "$NOTES" ]]; then
                log_error "--notes requires a text argument"
                exit "$EXIT_INVALID_INPUT"
            fi
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -f|--format)
            FORMAT="${2:-}"
            if [[ -z "$FORMAT" ]]; then
                log_error "--format requires an argument (text or json)"
                exit "$EXIT_INVALID_INPUT"
            fi
            shift 2
            ;;
        --human)
            FORMAT="text"
            shift
            ;;
        --json)
            FORMAT="json"
            shift
            ;;
        -*)
            log_error "Unknown option: $1"
            echo "Use --help for usage information" >&2
            exit "$EXIT_INVALID_INPUT"
            ;;
        *)
            if [[ -z "$TASK_ID" ]]; then
                TASK_ID="$1"
            else
                log_error "Unexpected argument: $1"
                exit "$EXIT_INVALID_INPUT"
            fi
            shift
            ;;
    esac
done

# ============================================================================
# MAIN EXECUTION
# ============================================================================

check_deps

# Resolve output format (CLI > env > config > TTY-aware default)
if declare -f resolve_format >/dev/null 2>&1; then
    FORMAT=$(resolve_format "$FORMAT" true "text,json")
else
    FORMAT="${FORMAT:-text}"
fi

# Validate task ID provided
if [[ -z "$TASK_ID" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "$E_INPUT_MISSING" "Task ID is required" "$EXIT_INVALID_INPUT" true "Provide task ID: cleo uncancel TASK_ID"
    else
        log_error "Task ID is required"
        echo "Usage: cleo uncancel TASK_ID" >&2
        echo "Use --help for more information" >&2
    fi
    exit "$EXIT_INVALID_INPUT"
fi

# Validate task ID format
if [[ ! "$TASK_ID" =~ ^T[0-9]{3,}$ ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "$E_TASK_INVALID_ID" "Invalid task ID format: $TASK_ID (must be T### format)" "$EXIT_INVALID_INPUT" true "Use format T### (e.g., T001, T042)"
    else
        log_error "Invalid task ID format: $TASK_ID (must be T### format)"
    fi
    exit "$EXIT_INVALID_INPUT"
fi

# Check todo file exists
if [[ ! -f "$TODO_FILE" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "$E_NOT_INITIALIZED" "Todo file not found: $TODO_FILE" "$EXIT_FILE_ERROR" true "Run 'cleo init' first"
    else
        log_error "Todo file not found: $TODO_FILE"
        echo "Run cleo init first to initialize the todo system" >&2
    fi
    exit "$EXIT_FILE_ERROR"
fi

# ============================================================================
# TASK LOOKUP AND VALIDATION
# ============================================================================

# Check task exists
TASK=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE")
if [[ -z "$TASK" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "$E_TASK_NOT_FOUND" "Task $TASK_ID not found" "$EXIT_NOT_FOUND" true "Use 'cleo list' to see available tasks"
    else
        log_error "Task $TASK_ID not found"
    fi
    exit "$EXIT_NOT_FOUND"
fi

# Get current status
CURRENT_STATUS=$(echo "$TASK" | jq -r '.status')
TASK_TITLE=$(echo "$TASK" | jq -r '.title')
ORIGINAL_REASON=$(echo "$TASK" | jq -r '.cancellationReason // .cancelReason // ""')
CANCELLED_AT=$(echo "$TASK" | jq -r '.cancelledAt // ""')

# Check if task is cancelled (only cancelled tasks can be uncancelled)
if [[ "$CURRENT_STATUS" != "cancelled" ]]; then
    if [[ "$FORMAT" == "json" ]]; then
        TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        jq -n \
            --arg version "${CLEO_VERSION:-unknown}" \
            --arg timestamp "$TIMESTAMP" \
            --arg taskId "$TASK_ID" \
            --arg currentStatus "$CURRENT_STATUS" \
            --argjson task "$TASK" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "command": "uncancel",
                    "timestamp": $timestamp,
                    "version": $version
                },
                "success": false,
                "error": {
                    "code": "E_TASK_NOT_CANCELLED",
                    "message": ("Task is not cancelled (current status: " + $currentStatus + ")"),
                    "exitCode": 6,
                    "recoverable": true,
                    "suggestion": "Use '\''cleo update'\'' to change status of non-cancelled tasks"
                },
                "taskId": $taskId,
                "currentStatus": $currentStatus,
                "task": $task
            }'
    else
        log_error "Task $TASK_ID is not cancelled (current status: $CURRENT_STATUS)"
        log_info "Only cancelled tasks can be uncancelled"
        log_info "Use 'cleo update' to change status of other tasks"
    fi
    exit "$EXIT_VALIDATION_ERROR"
fi

# Check if task is already pending (idempotent - should not happen but handle gracefully)
if [[ "$CURRENT_STATUS" == "pending" ]]; then
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    if [[ "$FORMAT" == "json" ]]; then
        jq -n \
            --arg version "${CLEO_VERSION:-unknown}" \
            --arg timestamp "$TIMESTAMP" \
            --arg taskId "$TASK_ID" \
            --argjson task "$TASK" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "command": "uncancel",
                    "timestamp": $timestamp,
                    "version": $version
                },
                "success": true,
                "noChange": true,
                "taskId": $taskId,
                "message": "Task is already pending",
                "task": $task
            }'
    else
        log_warn "Task $TASK_ID is already pending"
    fi
    exit "$EXIT_NO_CHANGE"
fi

# ============================================================================
# CASCADE HANDLING
# ============================================================================

# Collect tasks to restore
TASKS_TO_RESTORE="[\"$TASK_ID\"]"
CASCADE_CHILDREN="[]"
CASCADE_COUNT=0

if [[ "$CASCADE" == true ]]; then
    # Get all descendants that are also cancelled
    if declare -f get_descendants >/dev/null 2>&1; then
        DESCENDANTS=$(get_descendants "$TASK_ID" "$TODO_FILE")
        if [[ -n "$DESCENDANTS" ]]; then
            # Filter to only cancelled descendants
            CANCELLED_CHILDREN=$(jq --arg descendants "$DESCENDANTS" '
                ($descendants | split(" ")) as $desc_ids |
                [.tasks[] | select(.id as $id | $desc_ids | index($id)) | select(.status == "cancelled") | .id]
            ' "$TODO_FILE")
            CASCADE_COUNT=$(echo "$CANCELLED_CHILDREN" | jq 'length')

            if [[ "$CASCADE_COUNT" -gt 0 ]]; then
                CASCADE_CHILDREN="$CANCELLED_CHILDREN"
                TASKS_TO_RESTORE=$(jq -n --arg parent "$TASK_ID" --argjson children "$CANCELLED_CHILDREN" '[$parent] + $children')
                log_info "Will restore $CASCADE_COUNT cancelled child task(s)"
            fi
        fi
    else
        # Fallback: direct jq query for cancelled children
        CANCELLED_CHILDREN=$(jq --arg pid "$TASK_ID" '
            [.tasks[] | select(.parentId == $pid and .status == "cancelled") | .id]
        ' "$TODO_FILE")
        CASCADE_COUNT=$(echo "$CANCELLED_CHILDREN" | jq 'length')

        if [[ "$CASCADE_COUNT" -gt 0 ]]; then
            CASCADE_CHILDREN="$CANCELLED_CHILDREN"
            TASKS_TO_RESTORE=$(jq -n --arg parent "$TASK_ID" --argjson children "$CANCELLED_CHILDREN" '[$parent] + $children')
            log_info "Will restore $CASCADE_COUNT cancelled child task(s)"
        fi
    fi
fi

TOTAL_RESTORE=$(echo "$TASKS_TO_RESTORE" | jq 'length')

# ============================================================================
# DRY-RUN MODE
# ============================================================================

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [[ "$DRY_RUN" == true ]]; then
    if [[ "$FORMAT" == "json" ]]; then
        jq -n \
            --arg version "${CLEO_VERSION:-unknown}" \
            --arg timestamp "$TIMESTAMP" \
            --arg taskId "$TASK_ID" \
            --arg originalReason "$ORIGINAL_REASON" \
            --argjson restoredTasks "$TASKS_TO_RESTORE" \
            --argjson cascadeCount "$CASCADE_COUNT" \
            --argjson task "$TASK" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "command": "uncancel",
                    "timestamp": $timestamp,
                    "version": $version
                },
                "success": true,
                "dryRun": true,
                "wouldRestore": {
                    "taskId": $taskId,
                    "title": $task.title,
                    "originalReason": $originalReason,
                    "restoredTasks": $restoredTasks,
                    "cascadeCount": $cascadeCount,
                    "newStatus": "pending"
                },
                "task": $task
            }'
    else
        echo -e "${YELLOW}[DRY-RUN]${NC} Would restore task:"
        echo ""
        echo -e "${BLUE}Task:${NC} $TASK_TITLE"
        echo -e "${BLUE}ID:${NC} $TASK_ID"
        echo -e "${BLUE}Status:${NC} cancelled -> pending"
        if [[ -n "$ORIGINAL_REASON" ]]; then
            echo -e "${BLUE}Original cancellation reason:${NC} $ORIGINAL_REASON"
        fi
        if [[ "$CASCADE_COUNT" -gt 0 ]]; then
            echo ""
            echo -e "${BLUE}Would also restore $CASCADE_COUNT cancelled child task(s):${NC}"
            echo "$CASCADE_CHILDREN" | jq -r '.[]' | while read -r tid; do
                echo "  - $tid"
            done
        fi
        echo ""
        echo -e "${YELLOW}No changes made (dry-run mode)${NC}"
    fi
    exit 0
fi

# ============================================================================
# EXECUTE RESTORATION
# ============================================================================

# Create safety backup before modification
if declare -f create_safety_backup >/dev/null 2>&1; then
    BACKUP_PATH=$(create_safety_backup "$TODO_FILE" "uncancel" 2>&1) || {
        [[ "$FORMAT" != "json" ]] && log_warn "Backup library failed, using fallback"
        BACKUP_DIR=".cleo/backups/safety"
        mkdir -p "$BACKUP_DIR"
        BACKUP_PATH="${BACKUP_DIR}/todo.json.$(date +%Y%m%d_%H%M%S)"
        cp "$TODO_FILE" "$BACKUP_PATH"
    }
    [[ "$FORMAT" != "json" ]] && log_info "Backup created: $BACKUP_PATH"
else
    BACKUP_DIR=".cleo/backups/safety"
    mkdir -p "$BACKUP_DIR"
    BACKUP_PATH="${BACKUP_DIR}/todo.json.$(date +%Y%m%d_%H%M%S)"
    cp "$TODO_FILE" "$BACKUP_PATH"
    [[ "$FORMAT" != "json" ]] && log_info "Backup created: $BACKUP_PATH"
fi

# Capture before state for logging
BEFORE_STATE=$(echo "$TASK" | jq '{status, cancelledAt, cancellationReason}')

# Build restoration note
RESTORE_NOTE="[RESTORED $TIMESTAMP]"
if [[ -n "$ORIGINAL_REASON" ]]; then
    RESTORE_NOTE="$RESTORE_NOTE Originally cancelled: $ORIGINAL_REASON"
fi
if [[ -n "$NOTES" ]]; then
    RESTORE_NOTE="$RESTORE_NOTE | Restored because: $NOTES"
fi

# Update task(s) to pending status
UPDATED_TODO=$(jq --argjson ids "$TASKS_TO_RESTORE" \
    --arg ts "$TIMESTAMP" \
    --arg note "$RESTORE_NOTE" '
    .tasks |= map(
        if ([.id] | inside($ids)) then
            .status = "pending" |
            del(.cancelledAt) |
            del(.cancellationReason) |
            del(.cancelReason) |
            .notes = ((.notes // []) + [$note]) |
            .updatedAt = $ts
        else . end
    )
' "$TODO_FILE")

# Recalculate checksum
NEW_TASKS=$(echo "$UPDATED_TODO" | jq -c '.tasks')
NEW_CHECKSUM=$(echo "$NEW_TASKS" | sha256sum | cut -c1-16)

FINAL_JSON=$(echo "$UPDATED_TODO" | jq --arg checksum "$NEW_CHECKSUM" --arg ts "$TIMESTAMP" '
    ._meta.checksum = $checksum |
    .lastUpdated = $ts
')

# Atomic write
if declare -f save_json >/dev/null 2>&1; then
    if ! save_json "$TODO_FILE" "$FINAL_JSON"; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_FILE_WRITE_ERROR" "Failed to save todo file" "$EXIT_FILE_ERROR" false "Check file permissions and disk space"
        else
            log_error "Failed to save todo file"
        fi
        exit "$EXIT_FILE_ERROR"
    fi
else
    echo "$FINAL_JSON" > "$TODO_FILE"
fi

# Log the operation using log_task_restored if available
if declare -f log_task_restored >/dev/null 2>&1; then
    SESSION_ID=$(jq -r '._meta.activeSession // "null"' "$TODO_FILE")
    log_task_restored "$TASK_ID" "$ORIGINAL_REASON" "pending" "$SESSION_ID" 2>/dev/null || true
elif [[ -f "$LOG_SCRIPT" ]]; then
    AFTER_STATE="{\"status\":\"pending\"}"
    "$LOG_SCRIPT" \
        --action "task_restored_from_cancelled" \
        --task-id "$TASK_ID" \
        --before "$BEFORE_STATE" \
        --after "$AFTER_STATE" \
        --details "{\"originalReason\":\"$ORIGINAL_REASON\",\"cascade\":$CASCADE,\"restoredCount\":$TOTAL_RESTORE}" \
        --actor "system" 2>/dev/null || log_warn "Failed to write log entry"
fi

# Get updated task for output
RESTORED_TASK=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE")

# ============================================================================
# OUTPUT
# ============================================================================

if [[ "$FORMAT" == "json" ]]; then
    jq -n \
        --arg version "${CLEO_VERSION:-unknown}" \
        --arg timestamp "$TIMESTAMP" \
        --arg taskId "$TASK_ID" \
        --arg originalReason "$ORIGINAL_REASON" \
        --arg cancelledAt "$CANCELLED_AT" \
        --argjson restoredTasks "$TASKS_TO_RESTORE" \
        --argjson cascadeRestored "$CASCADE" \
        --argjson cascadeCount "$CASCADE_COUNT" \
        --argjson task "$RESTORED_TASK" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "command": "uncancel",
                "timestamp": $timestamp,
                "version": $version
            },
            "success": true,
            "taskId": $taskId,
            "restoredAt": $timestamp,
            "previousStatus": "cancelled",
            "newStatus": "pending",
            "originalReason": (if $originalReason == "" then null else $originalReason end),
            "originalCancelledAt": (if $cancelledAt == "" then null else $cancelledAt end),
            "restoredTasks": $restoredTasks,
            "cascadeRestored": $cascadeRestored,
            "cascadeCount": $cascadeCount,
            "task": $task
        }'
else
    log_info "Task $TASK_ID restored to pending"
    echo ""
    echo -e "${BLUE}Task:${NC} $TASK_TITLE"
    echo -e "${BLUE}ID:${NC} $TASK_ID"
    echo -e "${BLUE}Status:${NC} cancelled -> pending"
    echo -e "${BLUE}Restored:${NC} $TIMESTAMP"

    if [[ -n "$ORIGINAL_REASON" ]]; then
        echo ""
        echo -e "${BLUE}Original cancellation reason:${NC} $ORIGINAL_REASON"
        echo -e "${YELLOW}(preserved in task notes)${NC}"
    fi

    if [[ "$CASCADE_COUNT" -gt 0 ]]; then
        echo ""
        echo -e "${BLUE}Also restored $CASCADE_COUNT cancelled child task(s):${NC}"
        echo "$CASCADE_CHILDREN" | jq -r '.[]' | while read -r tid; do
            echo "  - $tid"
        done
    fi
fi

exit "$EXIT_SUCCESS"
