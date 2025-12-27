#!/usr/bin/env bash
# CLEO Reopen Script (Restore from Done)
# Restore completed tasks back to pending status
#
# This script implements the restore-from-done functionality.
# Completed tasks remain in todo.json with status="done" and can
# be restored to "pending" status via this command.
#
# Primary use case: Reopening auto-completed epics when child tasks
# were completed prematurely or need additional work.
#
# Version: 0.36.0
# Part of: Task Hierarchy Enhancement
# Related: TASK-HIERARCHY-SPEC.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"
LOG_SCRIPT="${SCRIPT_DIR}/log.sh"

# Command name for error-json library
COMMAND_NAME="reopen"

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
: "${E_TASK_NOT_DONE:=E_TASK_NOT_DONE}"

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
REASON=""
TARGET_STATUS="pending"
DRY_RUN=false
FORMAT=""
QUIET=false

# ============================================================================
# USAGE
# ============================================================================

usage() {
    cat << 'EOF'
Usage: cleo reopen TASK_ID --reason "..." [OPTIONS]

Restore a completed task back to pending (or other) status.

This is useful for:
  - Reopening auto-completed epics when work is incomplete
  - Restarting completed tasks that need additional work
  - Correcting premature completions

Arguments:
  TASK_ID               Task ID to reopen (e.g., T001)

Required:
  -r, --reason TEXT     Reason for reopening (required for audit trail)

Options:
  -s, --status STATUS   Target status: pending, active, blocked (default: pending)
  --dry-run             Preview changes without applying
  -f, --format FMT      Output format: text, json (default: auto-detect)
  --human               Force human-readable text output
  --json                Force JSON output
  -q, --quiet           Suppress non-essential output
  -h, --help            Show this help

Behavior:
  - Task status changes from 'done' to target status (default: pending)
  - completedAt timestamp is cleared
  - Original completion info is preserved in notes
  - Task remains in todo.json (no file moves needed)

Auto-Complete Warning:
  If reopening an epic where all children are still done, the epic may
  auto-complete again. Consider reopening a child task first, or disabling
  auto-complete via: cleo config set hierarchy.autoCompleteMode off

Exit Codes:
  0   = Success
  2   = Invalid input or arguments
  3   = File operation failure
  4   = Task not found
  6   = Task is not done (use update for other status changes)
  102 = No changes (dry-run)

JSON Output Structure:
  {
    "_meta": {"command": "reopen", "timestamp": "...", "version": "..."},
    "success": true,
    "taskId": "T001",
    "reopenedAt": "2025-12-24T10:00:00Z",
    "previousStatus": "done",
    "newStatus": "pending",
    "reason": "...",
    "wasAutoCompleted": true,
    "warning": "Epic may auto-complete again if all children remain done"
  }

Examples:
  cleo reopen T001 --reason "Child task incomplete"
  cleo reopen T001 --reason "Need more work" --status active
  cleo reopen T001 --reason "Testing" --dry-run
  cleo reopen T001 --reason "..." --json
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

# Check if task was auto-completed (look for auto-complete note)
was_auto_completed() {
    local task="$1"
    echo "$task" | jq -r '.notes // [] | .[]' 2>/dev/null | grep -qi "auto-completed" && return 0
    return 1
}

# Check if all children of a task are done
all_children_done() {
    local task_id="$1"
    local todo_file="$2"

    local child_count
    child_count=$(jq --arg id "$task_id" '[.tasks[] | select(.parentId == $id)] | length' "$todo_file")

    if [[ "$child_count" -eq 0 ]]; then
        return 1  # No children, not applicable
    fi

    local done_count
    done_count=$(jq --arg id "$task_id" '[.tasks[] | select(.parentId == $id and .status == "done")] | length' "$todo_file")

    [[ "$child_count" -eq "$done_count" ]]
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
        -r|--reason)
            REASON="${2:-}"
            if [[ -z "$REASON" ]]; then
                log_error "--reason requires a text argument"
                exit "$EXIT_INVALID_INPUT"
            fi
            shift 2
            ;;
        -s|--status)
            TARGET_STATUS="${2:-}"
            if [[ -z "$TARGET_STATUS" ]]; then
                log_error "--status requires an argument (pending, active, or blocked)"
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
        output_error "$E_INPUT_MISSING" "Task ID is required" "$EXIT_INVALID_INPUT" true "Provide task ID: cleo reopen TASK_ID --reason \"...\""
    else
        log_error "Task ID is required"
        echo "Usage: cleo reopen TASK_ID --reason \"...\"" >&2
        echo "Use --help for more information" >&2
    fi
    exit "$EXIT_INVALID_INPUT"
fi

# Validate reason is provided (required for audit trail)
if [[ -z "$REASON" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "$E_INPUT_MISSING" "--reason is required for reopening tasks" "$EXIT_INVALID_INPUT" true "Provide reason: cleo reopen $TASK_ID --reason \"Why reopening\""
    else
        log_error "--reason is required for reopening tasks"
        echo "Usage: cleo reopen TASK_ID --reason \"Why reopening\"" >&2
    fi
    exit "$EXIT_INVALID_INPUT"
fi

# Validate target status
case "$TARGET_STATUS" in
    pending|active|blocked)
        # Valid statuses
        ;;
    done)
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "$E_INPUT_INVALID" "Cannot reopen to 'done' status" "$EXIT_INVALID_INPUT" true "Use pending, active, or blocked"
        else
            log_error "Cannot reopen to 'done' status"
        fi
        exit "$EXIT_INVALID_INPUT"
        ;;
    *)
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "$E_INPUT_INVALID" "Invalid status: $TARGET_STATUS" "$EXIT_INVALID_INPUT" true "Use pending, active, or blocked"
        else
            log_error "Invalid status: $TARGET_STATUS (must be pending, active, or blocked)"
        fi
        exit "$EXIT_INVALID_INPUT"
        ;;
esac

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

# Get current status and metadata
CURRENT_STATUS=$(echo "$TASK" | jq -r '.status')
TASK_TITLE=$(echo "$TASK" | jq -r '.title')
TASK_TYPE=$(echo "$TASK" | jq -r '.type // "task"')
COMPLETED_AT=$(echo "$TASK" | jq -r '.completedAt // ""')

# Check if task is done (only done tasks can be reopened)
if [[ "$CURRENT_STATUS" != "done" ]]; then
    if [[ "$CURRENT_STATUS" == "cancelled" ]]; then
        SUGGESTION="Use 'cleo uncancel $TASK_ID' to restore cancelled tasks"
    else
        SUGGESTION="Use 'cleo update $TASK_ID --status ...' to change status of non-done tasks"
    fi

    if [[ "$FORMAT" == "json" ]]; then
        TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        jq -n \
            --arg version "${CLEO_VERSION:-unknown}" \
            --arg timestamp "$TIMESTAMP" \
            --arg taskId "$TASK_ID" \
            --arg currentStatus "$CURRENT_STATUS" \
            --arg suggestion "$SUGGESTION" \
            --argjson task "$TASK" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "command": "reopen",
                    "timestamp": $timestamp,
                    "version": $version
                },
                "success": false,
                "error": {
                    "code": "E_TASK_NOT_DONE",
                    "message": ("Task is not done (current status: " + $currentStatus + ")"),
                    "exitCode": 6,
                    "recoverable": true,
                    "suggestion": $suggestion
                },
                "taskId": $taskId,
                "currentStatus": $currentStatus,
                "task": $task
            }'
    else
        log_error "Task $TASK_ID is not done (current status: $CURRENT_STATUS)"
        log_info "Only completed tasks can be reopened"
        log_info "$SUGGESTION"
    fi
    exit "$EXIT_VALIDATION_ERROR"
fi

# ============================================================================
# AUTO-COMPLETE WARNING
# ============================================================================

WAS_AUTO_COMPLETED=false
AUTO_COMPLETE_WARNING=""

if was_auto_completed "$TASK"; then
    WAS_AUTO_COMPLETED=true
fi

# Check if this is an epic/parent with all children still done
if [[ "$TASK_TYPE" == "epic" ]] || jq -e --arg id "$TASK_ID" '.tasks[] | select(.parentId == $id)' "$TODO_FILE" >/dev/null 2>&1; then
    if all_children_done "$TASK_ID" "$TODO_FILE"; then
        AUTO_COMPLETE_WARNING="Epic may auto-complete again if all children remain done. Consider reopening a child task first."
        [[ "$FORMAT" != "json" ]] && log_warn "$AUTO_COMPLETE_WARNING"
    fi
fi

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
            --arg reason "$REASON" \
            --arg targetStatus "$TARGET_STATUS" \
            --arg completedAt "$COMPLETED_AT" \
            --argjson wasAutoCompleted "$WAS_AUTO_COMPLETED" \
            --arg warning "$AUTO_COMPLETE_WARNING" \
            --argjson task "$TASK" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "command": "reopen",
                    "timestamp": $timestamp,
                    "version": $version
                },
                "success": true,
                "dryRun": true,
                "wouldReopen": {
                    "taskId": $taskId,
                    "title": $task.title,
                    "reason": $reason,
                    "previousStatus": "done",
                    "newStatus": $targetStatus,
                    "completedAt": (if $completedAt == "" then null else $completedAt end),
                    "wasAutoCompleted": $wasAutoCompleted
                },
                "warning": (if $warning == "" then null else $warning end),
                "task": $task
            }'
    else
        echo -e "${YELLOW}[DRY-RUN]${NC} Would reopen task:"
        echo ""
        echo -e "${BLUE}Task:${NC} $TASK_TITLE"
        echo -e "${BLUE}ID:${NC} $TASK_ID"
        echo -e "${BLUE}Type:${NC} $TASK_TYPE"
        echo -e "${BLUE}Status:${NC} done -> $TARGET_STATUS"
        echo -e "${BLUE}Reason:${NC} $REASON"
        if [[ -n "$COMPLETED_AT" ]]; then
            echo -e "${BLUE}Was completed at:${NC} $COMPLETED_AT"
        fi
        if [[ "$WAS_AUTO_COMPLETED" == true ]]; then
            echo -e "${YELLOW}Note:${NC} This task was auto-completed"
        fi
        echo ""
        echo -e "${YELLOW}No changes made (dry-run mode)${NC}"
    fi
    exit 0
fi

# ============================================================================
# EXECUTE REOPEN
# ============================================================================

# Create safety backup before modification
if declare -f create_safety_backup >/dev/null 2>&1; then
    BACKUP_PATH=$(create_safety_backup "$TODO_FILE" "reopen" 2>&1) || {
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
BEFORE_STATE=$(echo "$TASK" | jq '{status, completedAt}')

# Build reopen note
REOPEN_NOTE="[REOPENED $TIMESTAMP] Reason: $REASON"
if [[ -n "$COMPLETED_AT" ]]; then
    REOPEN_NOTE="$REOPEN_NOTE | Was completed at: $COMPLETED_AT"
fi
if [[ "$WAS_AUTO_COMPLETED" == true ]]; then
    REOPEN_NOTE="$REOPEN_NOTE | (was auto-completed)"
fi

# Update task to target status
UPDATED_TODO=$(jq --arg id "$TASK_ID" \
    --arg ts "$TIMESTAMP" \
    --arg note "$REOPEN_NOTE" \
    --arg status "$TARGET_STATUS" '
    .tasks |= map(
        if .id == $id then
            .status = $status |
            del(.completedAt) |
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

# Log the operation
if [[ -f "$LOG_SCRIPT" ]]; then
    AFTER_STATE="{\"status\":\"$TARGET_STATUS\"}"
    "$LOG_SCRIPT" \
        --action "task_reopened" \
        --task-id "$TASK_ID" \
        --before "$BEFORE_STATE" \
        --after "$AFTER_STATE" \
        --details "{\"reason\":\"$REASON\",\"wasAutoCompleted\":$WAS_AUTO_COMPLETED,\"previousCompletedAt\":\"$COMPLETED_AT\"}" \
        --actor "system" >/dev/null 2>&1 || { [[ "$FORMAT" != "json" ]] && log_warn "Failed to write log entry"; }
fi

# Get updated task for output
REOPENED_TASK=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE")

# ============================================================================
# OUTPUT
# ============================================================================

if [[ "$FORMAT" == "json" ]]; then
    jq -n \
        --arg version "${CLEO_VERSION:-unknown}" \
        --arg timestamp "$TIMESTAMP" \
        --arg taskId "$TASK_ID" \
        --arg reason "$REASON" \
        --arg completedAt "$COMPLETED_AT" \
        --arg targetStatus "$TARGET_STATUS" \
        --argjson wasAutoCompleted "$WAS_AUTO_COMPLETED" \
        --arg warning "$AUTO_COMPLETE_WARNING" \
        --argjson task "$REOPENED_TASK" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "command": "reopen",
                "timestamp": $timestamp,
                "version": $version
            },
            "success": true,
            "taskId": $taskId,
            "reopenedAt": $timestamp,
            "previousStatus": "done",
            "newStatus": $targetStatus,
            "reason": $reason,
            "previousCompletedAt": (if $completedAt == "" then null else $completedAt end),
            "wasAutoCompleted": $wasAutoCompleted,
            "warning": (if $warning == "" then null else $warning end),
            "task": $task
        }'
else
    log_info "Task $TASK_ID reopened to $TARGET_STATUS"
    echo ""
    echo -e "${BLUE}Task:${NC} $TASK_TITLE"
    echo -e "${BLUE}ID:${NC} $TASK_ID"
    echo -e "${BLUE}Type:${NC} $TASK_TYPE"
    echo -e "${BLUE}Status:${NC} done -> $TARGET_STATUS"
    echo -e "${BLUE}Reason:${NC} $REASON"
    echo -e "${BLUE}Reopened:${NC} $TIMESTAMP"

    if [[ -n "$COMPLETED_AT" ]]; then
        echo ""
        echo -e "${BLUE}Was completed at:${NC} $COMPLETED_AT"
        echo -e "${YELLOW}(preserved in task notes)${NC}"
    fi

    if [[ "$WAS_AUTO_COMPLETED" == true ]]; then
        echo ""
        echo -e "${YELLOW}Note:${NC} This task was originally auto-completed"
    fi

    if [[ -n "$AUTO_COMPLETE_WARNING" ]]; then
        echo ""
        echo -e "${YELLOW}Warning:${NC} $AUTO_COMPLETE_WARNING"
    fi
fi

exit "$EXIT_SUCCESS"
