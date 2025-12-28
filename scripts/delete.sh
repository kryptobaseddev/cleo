#!/usr/bin/env bash
# CLEO Delete Task Script (Cancel/Delete)
# Cancel and archive tasks with configurable child handling strategies
#
# This script implements the task deletion/cancellation system per
# TASK-DELETION-SPEC.md. Terminology: "delete" in UI, "cancel" internally.
#
# Version: 0.32.0
# Part of: Task Deletion Enhancement

set -euo pipefail

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
ARCHIVE_FILE="${ARCHIVE_FILE:-.cleo/todo-archive.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_SCRIPT="${SCRIPT_DIR}/log.sh"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Command name for error-json library
COMMAND_NAME="delete"

# ============================================================================
# LIBRARY LOADING
# ============================================================================

LIB_DIR="${SCRIPT_DIR}/../lib"

# Source version library
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

# Source config library for unified config access
if [[ -f "$LIB_DIR/config.sh" ]]; then
    # shellcheck source=../lib/config.sh
    source "$LIB_DIR/config.sh"
fi

# Source validation library for input validation
if [[ -f "$LIB_DIR/validation.sh" ]]; then
    # shellcheck source=../lib/validation.sh
    source "$LIB_DIR/validation.sh"
fi

# Source hierarchy library for child/parent operations
if [[ -f "$LIB_DIR/hierarchy.sh" ]]; then
    # shellcheck source=../lib/hierarchy.sh
    source "$LIB_DIR/hierarchy.sh"
fi

# Source cancel-ops library for focus impact analysis
if [[ -f "$LIB_DIR/cancel-ops.sh" ]]; then
    # shellcheck source=../lib/cancel-ops.sh
    source "$LIB_DIR/cancel-ops.sh"
fi

# Source archive-cancel library for immediate archival
if [[ -f "$LIB_DIR/archive-cancel.sh" ]]; then
    # shellcheck source=../lib/archive-cancel.sh
    source "$LIB_DIR/archive-cancel.sh"
fi

# Fallback exit codes if libraries not loaded
: "${EXIT_SUCCESS:=0}"
: "${EXIT_INVALID_INPUT:=2}"
: "${EXIT_FILE_ERROR:=3}"
: "${EXIT_NOT_FOUND:=4}"
: "${EXIT_VALIDATION_ERROR:=6}"
: "${EXIT_HAS_CHILDREN:=16}"
: "${EXIT_TASK_COMPLETED:=17}"
: "${EXIT_CASCADE_FAILED:=18}"
: "${EXIT_NO_CHANGE:=102}"

# Fallback error codes
: "${E_INPUT_MISSING:=E_INPUT_MISSING}"
: "${E_INPUT_INVALID:=E_INPUT_INVALID}"
: "${E_TASK_NOT_FOUND:=E_TASK_NOT_FOUND}"
: "${E_TASK_INVALID_ID:=E_TASK_INVALID_ID}"
: "${E_NOT_INITIALIZED:=E_NOT_INITIALIZED}"
: "${E_HAS_CHILDREN:=E_HAS_CHILDREN}"
: "${E_TASK_COMPLETED:=E_TASK_COMPLETED}"
: "${E_CASCADE_FAILED:=E_CASCADE_FAILED}"
: "${E_CANCEL_REASON_REQUIRED:=E_CANCEL_REASON_REQUIRED}"

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
CHILDREN_STRATEGY=""  # Empty = use config default
CASCADE_LIMIT=""      # Empty = use config default
DRY_RUN=false
FORCE=false
FORMAT=""
QUIET=false

# ============================================================================
# USAGE
# ============================================================================

usage() {
    cat << 'EOF'
Usage: cleo delete TASK_ID --reason "..." [OPTIONS]

Cancel/delete a task and optionally handle child tasks.

Note: This command "cancels" tasks (sets status=cancelled, moves to archive).
      Tasks are NOT permanently deleted - they remain in the archive for recovery.

Arguments:
  TASK_ID               Task ID to delete/cancel (e.g., T001)

Required Options:
  --reason TEXT         Reason for cancellation (5-300 chars)
                        Can be skipped with --skip-reason if config allows

Child Task Strategies:
  --children MODE       How to handle child tasks:
                        - block:   Prevent deletion if children exist (default)
                        - orphan:  Remove parent reference from children
                        - cascade: Delete task and all descendants

  --limit N             Max tasks to delete in cascade mode (default: 10)
                        Safety limit to prevent accidental mass deletion

Flags:
  --dry-run             Preview changes without applying
  --force               Skip confirmation prompts (for scripting)
  --skip-reason         Skip reason requirement (if config allows)
  -f, --format FMT      Output format: text, json (default: auto-detect)
  --human               Force human-readable text output
  --json                Force JSON output
  -q, --quiet           Suppress non-essential output
  -h, --help            Show this help

Configuration (from config.json):
  - cancellation.requireReason: Require reason (default: true)
  - cancellation.defaultChildStrategy: Default strategy (default: "block")
  - cancellation.cascadeConfirmThreshold: Confirm above N tasks (default: 10)
  - cancellation.allowCascade: Allow cascade strategy (default: true)
  - cancellation.daysUntilArchive: Days before auto-archive (default: 7)

Exit Codes:
  0   = Success
  2   = Invalid input or arguments
  3   = File operation failure
  4   = Task not found
  6   = Validation error
  16  = Task has children (when using block strategy)
  17  = Task already completed (use archive instead)
  18  = Cascade deletion failed (partial failure)
  102 = No changes (dry-run or already cancelled)

JSON Output Structure:
  {
    "_meta": {"command": "delete", "timestamp": "...", "version": "..."},
    "success": true,
    "taskId": "T001",
    "deletedAt": "2025-12-17T10:00:00Z",
    "reason": "...",
    "affectedTasks": ["T001", "T002"],
    "childStrategy": "cascade",
    "archived": true,
    "focusCleared": false
  }

Examples:
  cleo delete T001 --reason "Requirements changed"
  cleo delete T001 --reason "Superseded" --children orphan
  cleo delete T001 --reason "Epic cancelled" --children cascade --limit 20
  cleo delete T001 --reason "Testing" --dry-run
  cleo delete T001 --reason "Script" --force --json

Aliases:
  cleo cancel T001 --reason "..."
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

# Get cancellation config value with default fallback
get_cancel_config() {
    local key="$1"
    local default="$2"

    if declare -f get_config_value >/dev/null 2>&1; then
        get_config_value "cancellation.$key" "$default"
    else
        echo "$default"
    fi
}

# Validate reason text (5-300 characters)
validate_reason() {
    local reason="$1"
    local len=${#reason}

    if [[ $len -lt 5 ]]; then
        return 1
    fi
    if [[ $len -gt 300 ]]; then
        return 1
    fi
    return 0
}

# ============================================================================
# ARGUMENT PARSING
# ============================================================================

SKIP_REASON=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            usage
            ;;
        -q|--quiet)
            QUIET=true
            shift
            ;;
        --reason)
            REASON="${2:-}"
            if [[ -z "$REASON" ]]; then
                log_error "--reason requires a text argument"
                exit "$EXIT_INVALID_INPUT"
            fi
            shift 2
            ;;
        --children)
            CHILDREN_STRATEGY="${2:-}"
            if [[ -z "$CHILDREN_STRATEGY" ]]; then
                log_error "--children requires an argument (block|orphan|cascade)"
                exit "$EXIT_INVALID_INPUT"
            fi
            shift 2
            ;;
        --limit)
            CASCADE_LIMIT="${2:-}"
            if [[ -z "$CASCADE_LIMIT" ]]; then
                log_error "--limit requires a numeric argument"
                exit "$EXIT_INVALID_INPUT"
            fi
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --skip-reason)
            SKIP_REASON=true
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
    if [[ "$FORMAT" == "json" ]]; then
        output_error "$E_INPUT_MISSING" "Task ID is required" "$EXIT_INVALID_INPUT" true "Provide task ID: cleo delete TASK_ID --reason '...'"
    else
        log_error "Task ID is required"
        echo "Usage: cleo delete TASK_ID --reason '...'" >&2
        echo "Use --help for more information" >&2
    fi
    exit "$EXIT_INVALID_INPUT"
fi

# Validate task ID format
if [[ ! "$TASK_ID" =~ ^T[0-9]{3,}$ ]]; then
    if [[ "$FORMAT" == "json" ]]; then
        output_error "$E_TASK_INVALID_ID" "Invalid task ID format: $TASK_ID (must be T### format)" "$EXIT_INVALID_INPUT" true "Use format T### (e.g., T001, T042)"
    else
        log_error "Invalid task ID format: $TASK_ID (must be T### format)"
    fi
    exit "$EXIT_INVALID_INPUT"
fi

# Check todo file exists
if [[ ! -f "$TODO_FILE" ]]; then
    if [[ "$FORMAT" == "json" ]]; then
        output_error "$E_NOT_INITIALIZED" "Todo file not found: $TODO_FILE" "$EXIT_FILE_ERROR" true "Run 'cleo init' first"
    else
        log_error "Todo file not found: $TODO_FILE"
        echo "Run cleo init first to initialize the todo system" >&2
    fi
    exit "$EXIT_FILE_ERROR"
fi

# Load configuration defaults
REQUIRE_REASON=$(get_cancel_config "requireReason" "true")
DEFAULT_CHILD_STRATEGY=$(get_cancel_config "defaultChildStrategy" "block")
CASCADE_CONFIRM_THRESHOLD=$(get_cancel_config "cascadeConfirmThreshold" "10")
ALLOW_CASCADE=$(get_cancel_config "allowCascade" "true")

# Apply defaults from config
[[ -z "$CHILDREN_STRATEGY" ]] && CHILDREN_STRATEGY="$DEFAULT_CHILD_STRATEGY"
[[ -z "$CASCADE_LIMIT" ]] && CASCADE_LIMIT="$CASCADE_CONFIRM_THRESHOLD"

# Validate children strategy
case "$CHILDREN_STRATEGY" in
    block|orphan|cascade)
        ;;
    *)
        if [[ "$FORMAT" == "json" ]]; then
            output_error "$E_INPUT_INVALID" "Invalid children strategy: $CHILDREN_STRATEGY (must be block|orphan|cascade)" "$EXIT_INVALID_INPUT" true "Valid strategies: block, orphan, cascade"
        else
            log_error "Invalid children strategy: $CHILDREN_STRATEGY (must be block|orphan|cascade)"
        fi
        exit "$EXIT_INVALID_INPUT"
        ;;
esac

# Check cascade is allowed
if [[ "$CHILDREN_STRATEGY" == "cascade" && "$ALLOW_CASCADE" != "true" ]]; then
    if [[ "$FORMAT" == "json" ]]; then
        output_error "$E_INPUT_INVALID" "Cascade deletion is disabled in configuration" "$EXIT_VALIDATION_ERROR" false "Enable with: cleo config set cancellation.allowCascade true"
    else
        log_error "Cascade deletion is disabled in configuration"
        log_info "Enable with: cleo config set cancellation.allowCascade true"
    fi
    exit "$EXIT_VALIDATION_ERROR"
fi

# Validate reason requirement
if [[ -z "$REASON" ]]; then
    if [[ "$SKIP_REASON" == true ]]; then
        # Check if config allows skipping
        if [[ "$REQUIRE_REASON" == "true" ]]; then
            if [[ "$FORMAT" == "json" ]]; then
                output_error "$E_CANCEL_REASON_REQUIRED" "Reason is required (config: cancellation.requireReason=true)" "$EXIT_VALIDATION_ERROR" true "Provide --reason 'explanation' or set cancellation.requireReason=false in config"
            else
                log_error "Reason is required (config: cancellation.requireReason=true)"
            fi
            exit "$EXIT_VALIDATION_ERROR"
        fi
        REASON="No reason provided"
    else
        if [[ "$FORMAT" == "json" ]]; then
            output_error "$E_CANCEL_REASON_REQUIRED" "Cancellation reason required" "$EXIT_INVALID_INPUT" true "Use --reason 'explanation' or --skip-reason if allowed"
        else
            log_error "Cancellation reason required"
            echo "Use --reason 'explanation' to provide a reason" >&2
        fi
        exit "$EXIT_INVALID_INPUT"
    fi
fi

# Validate reason length
if ! validate_reason "$REASON"; then
    if [[ "$FORMAT" == "json" ]]; then
        output_error "$E_INPUT_INVALID" "Reason must be 5-300 characters (provided: ${#REASON})" "$EXIT_INVALID_INPUT" true "Provide a reason between 5 and 300 characters"
    else
        log_error "Reason must be 5-300 characters (provided: ${#REASON})"
    fi
    exit "$EXIT_INVALID_INPUT"
fi

# Validate cascade limit is numeric
if ! [[ "$CASCADE_LIMIT" =~ ^[0-9]+$ ]]; then
    if [[ "$FORMAT" == "json" ]]; then
        output_error "$E_INPUT_INVALID" "Cascade limit must be a number: $CASCADE_LIMIT" "$EXIT_INVALID_INPUT" true "Use --limit with a numeric value"
    else
        log_error "Cascade limit must be a number: $CASCADE_LIMIT"
    fi
    exit "$EXIT_INVALID_INPUT"
fi

# ============================================================================
# TASK LOOKUP AND VALIDATION
# ============================================================================

# Check task exists
TASK=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE")
if [[ -z "$TASK" ]]; then
    if [[ "$FORMAT" == "json" ]]; then
        output_error "$E_TASK_NOT_FOUND" "Task $TASK_ID not found" "$EXIT_NOT_FOUND" true "Use 'cleo list' to see available tasks or 'cleo exists $TASK_ID --include-archive' to check archive"
    else
        log_error "Task $TASK_ID not found"
    fi
    exit "$EXIT_NOT_FOUND"
fi

# Get current status
CURRENT_STATUS=$(echo "$TASK" | jq -r '.status')
TASK_TITLE=$(echo "$TASK" | jq -r '.title')

# Check if task is already completed (use archive instead)
if [[ "$CURRENT_STATUS" == "done" ]]; then
    COMPLETED_AT=$(echo "$TASK" | jq -r '.completedAt // "unknown"')
    if [[ "$FORMAT" == "json" ]]; then
        TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        jq -n \
            --arg version "${CLEO_VERSION:-unknown}" \
            --arg timestamp "$TIMESTAMP" \
            --arg taskId "$TASK_ID" \
            --arg completedAt "$COMPLETED_AT" \
            --argjson task "$TASK" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "command": "delete",
                    "timestamp": $timestamp,
                    "version": $version
                },
                "success": false,
                "error": {
                    "code": "E_TASK_COMPLETED",
                    "message": "Task is already completed - use archive instead",
                    "exitCode": 17,
                    "recoverable": true,
                    "suggestion": "Use '\''cleo archive'\'' to archive completed tasks"
                },
                "taskId": $taskId,
                "completedAt": $completedAt,
                "task": $task
            }'
    else
        log_error "Task $TASK_ID is already completed"
        log_info "Completed at: $COMPLETED_AT"
        log_info "Use 'cleo archive' to archive completed tasks"
    fi
    exit "$EXIT_TASK_COMPLETED"
fi

# Check if task is already cancelled (idempotent)
if [[ "$CURRENT_STATUS" == "cancelled" ]]; then
    CANCELLED_AT=$(echo "$TASK" | jq -r '.cancelledAt // "unknown"')
    if [[ "$FORMAT" == "json" ]]; then
        TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        jq -n \
            --arg version "${CLEO_VERSION:-unknown}" \
            --arg timestamp "$TIMESTAMP" \
            --arg taskId "$TASK_ID" \
            --arg cancelledAt "$CANCELLED_AT" \
            --argjson task "$TASK" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "command": "delete",
                    "timestamp": $timestamp,
                    "version": $version
                },
                "success": true,
                "noChange": true,
                "taskId": $taskId,
                "message": "Task already cancelled",
                "cancelledAt": $cancelledAt,
                "task": $task
            }'
    else
        log_warn "Task $TASK_ID is already cancelled"
        echo "Cancelled at: $CANCELLED_AT"
    fi
    exit "$EXIT_NO_CHANGE"
fi

# ============================================================================
# CHILD TASK HANDLING
# ============================================================================

# Get child tasks
CHILDREN_JSON="[]"
CHILDREN_COUNT=0
if declare -f get_children >/dev/null 2>&1; then
    CHILDREN_IDS=$(get_children "$TASK_ID" "$TODO_FILE")
    if [[ -n "$CHILDREN_IDS" ]]; then
        # Convert space-separated IDs to JSON array
        CHILDREN_JSON=$(echo "$CHILDREN_IDS" | tr ' ' '\n' | jq -R . | jq -s .)
        CHILDREN_COUNT=$(echo "$CHILDREN_JSON" | jq 'length')
    fi
else
    # Fallback: direct jq query for children
    CHILDREN_JSON=$(jq --arg pid "$TASK_ID" '[.tasks[] | select(.parentId == $pid) | .id]' "$TODO_FILE")
    CHILDREN_COUNT=$(echo "$CHILDREN_JSON" | jq 'length')
fi

# Handle children based on strategy
AFFECTED_TASKS="[\"$TASK_ID\"]"
CASCADE_TASKS="[]"

if [[ "$CHILDREN_COUNT" -gt 0 ]]; then
    case "$CHILDREN_STRATEGY" in
        block)
            # Block deletion if children exist
            CHILDREN_LIST=$(echo "$CHILDREN_JSON" | jq -r 'join(", ")')
            if [[ "$FORMAT" == "json" ]]; then
                output_error "$E_HAS_CHILDREN" "Task $TASK_ID has $CHILDREN_COUNT child task(s): $CHILDREN_LIST" "$EXIT_HAS_CHILDREN" true "Use --children orphan to unlink children, or --children cascade to delete all"
            else
                log_error "Task $TASK_ID has $CHILDREN_COUNT child task(s)"
                echo "Children: $CHILDREN_LIST" >&2
                echo "" >&2
                echo "Options:" >&2
                echo "  --children orphan   Remove parent reference from children" >&2
                echo "  --children cascade  Delete task and all descendants" >&2
            fi
            exit "$EXIT_HAS_CHILDREN"
            ;;
        orphan)
            # Will remove parent reference from children (handled during execution)
            log_info "Will orphan $CHILDREN_COUNT child task(s)"
            ;;
        cascade)
            # Get all descendants for cascade deletion
            if declare -f get_descendants >/dev/null 2>&1; then
                DESCENDANTS=$(get_descendants "$TASK_ID" "$TODO_FILE")
                if [[ -n "$DESCENDANTS" ]]; then
                    CASCADE_TASKS=$(echo "$DESCENDANTS" | tr ' ' '\n' | jq -R . | jq -s .)
                fi
            else
                # Fallback: use children only (not recursive)
                CASCADE_TASKS="$CHILDREN_JSON"
            fi

            CASCADE_COUNT=$(echo "$CASCADE_TASKS" | jq 'length')
            TOTAL_AFFECTED=$((CASCADE_COUNT + 1))  # Include parent

            # Check against cascade limit
            if [[ "$TOTAL_AFFECTED" -gt "$CASCADE_LIMIT" ]]; then
                if [[ "$FORCE" != true ]]; then
                    if [[ "$FORMAT" == "json" ]]; then
                        output_error "$E_INPUT_INVALID" "Cascade would delete $TOTAL_AFFECTED tasks (limit: $CASCADE_LIMIT)" "$EXIT_VALIDATION_ERROR" true "Use --limit $TOTAL_AFFECTED or --force to override"
                    else
                        log_error "Cascade would delete $TOTAL_AFFECTED tasks (limit: $CASCADE_LIMIT)"
                        log_info "Use --limit $TOTAL_AFFECTED or --force to override"
                    fi
                    exit "$EXIT_VALIDATION_ERROR"
                fi
            fi

            # Build affected tasks list - combine parent with cascade tasks
            AFFECTED_TASKS=$(jq -n --arg parent "$TASK_ID" --argjson cascade "$CASCADE_TASKS" '[$parent] + $cascade')

            log_info "Will cascade delete $TOTAL_AFFECTED task(s)"
            ;;
    esac
fi

# Check for dependent tasks (tasks that depend on this task) - informational warning
# This helps users understand the impact of deletion beyond just children
if declare -f get_dependent_tasks >/dev/null 2>&1; then
    DEPENDENTS=$(get_dependent_tasks "$TASK_ID" "$TODO_FILE")
    if [[ -n "$DEPENDENTS" ]]; then
        DEPENDENT_LIST=$(echo "$DEPENDENTS" | tr ' ' ',')
        DEPENDENT_CNT=$(echo "$DEPENDENTS" | wc -w | tr -d ' ')
        if [[ "$FORMAT" != "json" ]]; then
            log_warn "Task $TASK_ID is referenced as a dependency by $DEPENDENT_CNT task(s): $DEPENDENT_LIST"
            log_info "These tasks will have their dependency references cleaned up automatically"
        fi
    fi
fi

# ============================================================================
# TTY INTERACTIVE MODE
# ============================================================================

# Interactive prompts for TTY (non-JSON, non-force mode)
# Check both stdin (-t 0) and stdout (-t 1) for consistency with is_interactive()
if [[ -t 0 && -t 1 && "$FORMAT" != "json" && "$FORCE" != true ]]; then
    # Prompt for children strategy if not specified and has children
    if [[ "$CHILDREN_COUNT" -gt 0 && -z "${CHILDREN_STRATEGY:-}" ]]; then
        echo ""
        echo "Task $TASK_ID has $CHILDREN_COUNT child task(s)."
        echo ""
        echo "How should child tasks be handled?"
        echo "  1) block   - Cancel operation (default)"
        echo "  2) orphan  - Remove parent reference from children"
        echo "  3) cascade - Delete task and all descendants"
        echo ""
        read -r -p "Select strategy [1-3]: " strategy_choice
        case "$strategy_choice" in
            2|orphan)  CHILDREN_STRATEGY="orphan" ;;
            3|cascade) CHILDREN_STRATEGY="cascade" ;;
            *)         CHILDREN_STRATEGY="block" ;;
        esac

        if [[ "$CHILDREN_STRATEGY" == "block" ]]; then
            log_info "Operation cancelled"
            exit "$EXIT_HAS_CHILDREN"
        fi
    fi

    # Confirm cascade if over threshold
    if [[ "$CHILDREN_STRATEGY" == "cascade" ]]; then
        CASCADE_COUNT=$(echo "$CASCADE_TASKS" | jq 'length')
        TOTAL_AFFECTED=$((CASCADE_COUNT + 1))

        if [[ "$TOTAL_AFFECTED" -gt "$CASCADE_CONFIRM_THRESHOLD" ]]; then
            echo ""
            log_warn "This will delete $TOTAL_AFFECTED tasks!"
            read -r -p "Are you sure? (yes/no): " confirm
            if [[ "$confirm" != "yes" ]]; then
                log_info "Operation cancelled"
                exit 0
            fi
        fi
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
            --arg strategy "$CHILDREN_STRATEGY" \
            --argjson affected "$AFFECTED_TASKS" \
            --argjson childCount "$CHILDREN_COUNT" \
            --argjson task "$TASK" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "command": "delete",
                    "timestamp": $timestamp,
                    "version": $version
                },
                "success": true,
                "dryRun": true,
                "wouldDelete": {
                    "taskId": $taskId,
                    "title": $task.title,
                    "reason": $reason,
                    "childStrategy": $strategy,
                    "childCount": $childCount,
                    "affectedTasks": $affected,
                    "totalAffected": ($affected | length)
                },
                "task": $task
            }'
    else
        echo -e "${YELLOW}[DRY-RUN]${NC} Would delete task:"
        echo ""
        echo -e "${BLUE}Task:${NC} $TASK_TITLE"
        echo -e "${BLUE}ID:${NC} $TASK_ID"
        echo -e "${BLUE}Status:${NC} $CURRENT_STATUS -> cancelled"
        echo -e "${BLUE}Reason:${NC} $REASON"
        if [[ "$CHILDREN_COUNT" -gt 0 ]]; then
            echo -e "${BLUE}Children:${NC} $CHILDREN_COUNT (strategy: $CHILDREN_STRATEGY)"
            TOTAL=$(echo "$AFFECTED_TASKS" | jq 'length')
            echo -e "${BLUE}Total affected:${NC} $TOTAL task(s)"
        fi
        echo ""
        echo -e "${YELLOW}No changes made (dry-run mode)${NC}"
    fi
    exit 0
fi

# ============================================================================
# EXECUTE DELETION
# ============================================================================

# Create safety backup before modification
if declare -f create_safety_backup >/dev/null 2>&1; then
    BACKUP_PATH=$(create_safety_backup "$TODO_FILE" "delete" 2>&1) || {
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
BEFORE_STATE=$(echo "$TASK" | jq '{status, cancelledAt: null}')

# Build cancellation note
CANCEL_NOTE="[CANCELLED $TIMESTAMP] $REASON"

# Execute based on strategy
DELETED_TASKS="[]"
ORPHANED_TASKS="[]"
FAILED_TASKS="[]"
DEPENDENTS_AFFECTED="[]"

case "$CHILDREN_STRATEGY" in
    block)
        # No children, just cancel the task
        DELETED_TASKS="[\"$TASK_ID\"]"

        # Clean up dependency references from other tasks
        if declare -f cleanup_dependencies >/dev/null 2>&1; then
            CLEANUP_RESULT=$(cleanup_dependencies "$TASK_ID" "$TODO_FILE")
            CLEANUP_SUCCESS=$(echo "$CLEANUP_RESULT" | jq -r '.success // false')
            if [[ "$CLEANUP_SUCCESS" == "true" ]]; then
                DEPENDENTS_AFFECTED=$(echo "$CLEANUP_RESULT" | jq -r '.dependentsAffected // []')
                AFFECTED_COUNT=$(echo "$DEPENDENTS_AFFECTED" | jq 'length')
                if [[ "$AFFECTED_COUNT" -gt 0 ]]; then
                    [[ "$FORMAT" != "json" ]] && log_info "Cleaned up $AFFECTED_COUNT dependent task(s)"
                    # Log each dependency removal for audit trail
                    if declare -f log_dependency_removed >/dev/null 2>&1; then
                        for dep_task in $(echo "$DEPENDENTS_AFFECTED" | jq -r '.[]'); do
                            log_dependency_removed "$dep_task" "$TASK_ID" "task_cancelled" 2>/dev/null || true
                        done
                    fi
                fi
            fi
        fi
        ;;
    orphan)
        # Orphan children first, then cancel parent
        if [[ "$CHILDREN_COUNT" -gt 0 ]]; then
            UPDATED_TODO=$(jq --arg pid "$TASK_ID" '
                .tasks |= map(
                    if .parentId == $pid then
                        .parentId = null
                    else . end
                )
            ' "$TODO_FILE")
            if ! save_json "$TODO_FILE" "$UPDATED_TODO"; then
                if [[ "$FORMAT" == "json" ]]; then
                    output_error "$E_CASCADE_FAILED" "Failed to orphan children" "$EXIT_CASCADE_FAILED" false "Check file permissions and disk space"
                else
                    log_error "Failed to orphan children"
                fi
                exit "$EXIT_CASCADE_FAILED"
            fi
            ORPHANED_TASKS="$CHILDREN_JSON"
            [[ "$FORMAT" != "json" ]] && log_info "Orphaned $CHILDREN_COUNT child task(s)"
        fi
        DELETED_TASKS="[\"$TASK_ID\"]"

        # Clean up dependency references from other tasks
        if declare -f cleanup_dependencies >/dev/null 2>&1; then
            CLEANUP_RESULT=$(cleanup_dependencies "$TASK_ID" "$TODO_FILE")
            CLEANUP_SUCCESS=$(echo "$CLEANUP_RESULT" | jq -r '.success // false')
            if [[ "$CLEANUP_SUCCESS" == "true" ]]; then
                DEPENDENTS_AFFECTED=$(echo "$CLEANUP_RESULT" | jq -r '.dependentsAffected // []')
                AFFECTED_COUNT=$(echo "$DEPENDENTS_AFFECTED" | jq 'length')
                if [[ "$AFFECTED_COUNT" -gt 0 ]]; then
                    [[ "$FORMAT" != "json" ]] && log_info "Cleaned up $AFFECTED_COUNT dependent task(s)"
                    # Log each dependency removal for audit trail
                    if declare -f log_dependency_removed >/dev/null 2>&1; then
                        for dep_task in $(echo "$DEPENDENTS_AFFECTED" | jq -r '.[]'); do
                            log_dependency_removed "$dep_task" "$TASK_ID" "task_cancelled" 2>/dev/null || true
                        done
                    fi
                fi
            fi
        fi
        ;;
    cascade)
        # Cancel all affected tasks
        CASCADE_IDS=$(echo "$CASCADE_TASKS" | jq -r '.[]')
        ALL_IDS="$TASK_ID"
        [[ -n "$CASCADE_IDS" ]] && ALL_IDS="$TASK_ID $CASCADE_IDS"

        DELETED_TASKS="$AFFECTED_TASKS"

        # Clean up external dependency references (tasks outside the cascade that depend on deleted tasks)
        if declare -f cleanup_dependencies_for_ids >/dev/null 2>&1; then
            CLEANUP_RESULT=$(cleanup_dependencies_for_ids "$DELETED_TASKS" "$TODO_FILE")
            CLEANUP_SUCCESS=$(echo "$CLEANUP_RESULT" | jq -r '.success // false')
            if [[ "$CLEANUP_SUCCESS" == "true" ]]; then
                DEPENDENTS_AFFECTED=$(echo "$CLEANUP_RESULT" | jq -r '.dependentsAffected // []')
                AFFECTED_COUNT=$(echo "$DEPENDENTS_AFFECTED" | jq 'length')
                if [[ "$AFFECTED_COUNT" -gt 0 ]]; then
                    [[ "$FORMAT" != "json" ]] && log_info "Cleaned up $AFFECTED_COUNT external dependent task(s)"
                    # Log each dependency removal for audit trail
                    if declare -f log_dependency_removed >/dev/null 2>&1; then
                        for dep_task in $(echo "$DEPENDENTS_AFFECTED" | jq -r '.[]'); do
                            # For cascade, the removed dependency could be any of the deleted tasks
                            # Log with the primary task as the removed dep for simplicity
                            log_dependency_removed "$dep_task" "$TASK_ID" "task_cascade_cancelled" 2>/dev/null || true
                        done
                    fi
                fi
            fi
        fi
        ;;
esac

# Check focus impact using cancel-ops library (before file is modified)
FOCUS_CLEARED=false
PHASE_CLEARED=false
PREVIOUS_FOCUS=""
FOCUS_WARNING=""

if declare -f check_focus_impact >/dev/null 2>&1; then
    FOCUS_IMPACT=$(check_focus_impact "$DELETED_TASKS" "$TODO_FILE")
    FOCUS_CLEARED=$(echo "$FOCUS_IMPACT" | jq -r '.focusCleared')
    PHASE_CLEARED=$(echo "$FOCUS_IMPACT" | jq -r '.phaseCleared')
    PREVIOUS_FOCUS=$(echo "$FOCUS_IMPACT" | jq -r '.currentFocus // ""')
    FOCUS_WARNING=$(echo "$FOCUS_IMPACT" | jq -r '.warning // ""')
else
    # Fallback: basic focus check without phase analysis
    CURRENT_FOCUS=$(jq -r '.focus.currentTask // ""' "$TODO_FILE")
    if [[ -n "$CURRENT_FOCUS" ]]; then
        DELETED_IDS_CHECK=$(echo "$DELETED_TASKS" | jq -r '.[]')
        for deleted_id in $DELETED_IDS_CHECK; do
            if [[ "$CURRENT_FOCUS" == "$deleted_id" ]]; then
                FOCUS_CLEARED=true
                PREVIOUS_FOCUS="$CURRENT_FOCUS"
                FOCUS_WARNING="Active focused task was cancelled"
                break
            fi
        done
    fi
fi

# Update task(s) to cancelled status AND clear focus/phase if needed (single atomic operation)
# NOTE: Session note (.focus.sessionNote) is intentionally preserved for context continuity
UPDATED_TODO=$(jq --argjson ids "$DELETED_TASKS" \
    --arg ts "$TIMESTAMP" \
    --arg reason "$REASON" \
    --arg note "$CANCEL_NOTE" \
    --argjson clearFocus "$FOCUS_CLEARED" \
    --argjson clearPhase "$PHASE_CLEARED" '
    .tasks |= map(
        if ([.id] | inside($ids)) then
            .status = "cancelled" |
            .cancelledAt = $ts |
            .cancelReason = $reason |
            .notes = ((.notes // []) + [$note])
        else . end
    ) |
    if $clearFocus then
        .focus.currentTask = null
    else . end |
    if $clearPhase then
        .focus.currentPhase = null
    else . end
' "$TODO_FILE")

# Recalculate checksum
NEW_TASKS=$(echo "$UPDATED_TODO" | jq -c '.tasks')
NEW_CHECKSUM=$(echo "$NEW_TASKS" | sha256sum | cut -c1-16)

FINAL_JSON=$(echo "$UPDATED_TODO" | jq --arg checksum "$NEW_CHECKSUM" --arg ts "$TIMESTAMP" '
    ._meta.checksum = $checksum |
    .lastUpdated = $ts
')

# Atomic write
if ! save_json "$TODO_FILE" "$FINAL_JSON"; then
    if [[ "$FORMAT" == "json" ]]; then
        output_error "$E_CASCADE_FAILED" "Failed to save todo file" "$EXIT_CASCADE_FAILED" false "Check file permissions and disk space"
    else
        log_error "Failed to save todo file"
    fi
    exit "$EXIT_CASCADE_FAILED"
fi

# Log focus clearing if it happened
if [[ "$FOCUS_CLEARED" == true ]]; then
    [[ "$FORMAT" != "json" ]] && log_info "Cleared focus from cancelled task"
    if [[ "$PHASE_CLEARED" == true && "$FORMAT" != "json" ]]; then
        log_info "Cleared phase (no remaining tasks in phase)"
    fi
fi

# Log the operation
if [[ -f "$LOG_SCRIPT" ]]; then
    AFTER_STATE="{\"status\":\"cancelled\",\"cancelledAt\":\"$TIMESTAMP\"}"
    if [[ "$FORMAT" == "json" ]]; then
        "$LOG_SCRIPT" \
            --action "task_cancelled" \
            --task-id "$TASK_ID" \
            --before "$BEFORE_STATE" \
            --after "$AFTER_STATE" \
            --details "{\"reason\":\"$REASON\",\"childStrategy\":\"$CHILDREN_STRATEGY\",\"affectedCount\":$(echo "$DELETED_TASKS" | jq 'length')}" \
            --actor "system" >/dev/null 2>&1 || true
    else
        "$LOG_SCRIPT" \
            --action "task_cancelled" \
            --task-id "$TASK_ID" \
            --before "$BEFORE_STATE" \
            --after "$AFTER_STATE" \
            --details "{\"reason\":\"$REASON\",\"childStrategy\":\"$CHILDREN_STRATEGY\"}" \
            --actor "system" 2>/dev/null || log_warn "Failed to write log entry"
    fi
fi

# ============================================================================
# ARCHIVE CANCELLED TASKS
# ============================================================================

# Immediately archive cancelled tasks (they are now moved to archive)
ARCHIVED=false
ARCHIVE_RESULT=""

if declare -f archive_cancelled_tasks >/dev/null 2>&1; then
    ARCHIVE_RESULT=$(archive_cancelled_tasks "$DELETED_TASKS" "$TODO_FILE" "$ARCHIVE_FILE" "delete-command" 2>/dev/null)
    ARCHIVE_SUCCESS=$(echo "$ARCHIVE_RESULT" | jq -r '.success // false')
    if [[ "$ARCHIVE_SUCCESS" == "true" ]]; then
        ARCHIVED=true
        ARCHIVED_COUNT=$(echo "$ARCHIVE_RESULT" | jq -r '.archivedCount // 0')
        [[ "$FORMAT" != "json" && "$QUIET" != true ]] && log_info "Archived $ARCHIVED_COUNT cancelled task(s)"
    else
        [[ "$FORMAT" != "json" ]] && log_warn "Failed to archive cancelled tasks"
    fi
fi

# Get cancelled task for output (from archive if archived, otherwise from todo)
DELETED_COUNT=$(echo "$DELETED_TASKS" | jq 'length')

if [[ "$ARCHIVED" == "true" ]]; then
    # Task is now in archive, get it from there
    CANCELLED_TASK=$(jq --arg id "$TASK_ID" '.archivedTasks[] | select(.id == $id)' "$ARCHIVE_FILE" 2>/dev/null || echo '{}')
else
    # Task still in todo.json (fallback if archive failed)
    CANCELLED_TASK=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE")
fi

# ============================================================================
# OUTPUT
# ============================================================================

if [[ "$FORMAT" == "json" ]]; then
    jq -n \
        --arg version "${CLEO_VERSION:-unknown}" \
        --arg timestamp "$TIMESTAMP" \
        --arg taskId "$TASK_ID" \
        --arg reason "$REASON" \
        --arg strategy "$CHILDREN_STRATEGY" \
        --argjson affected "$DELETED_TASKS" \
        --argjson orphaned "$ORPHANED_TASKS" \
        --argjson dependents "$DEPENDENTS_AFFECTED" \
        --argjson focusCleared "$FOCUS_CLEARED" \
        --argjson archived "$ARCHIVED" \
        --argjson task "$CANCELLED_TASK" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "command": "delete",
                "timestamp": $timestamp,
                "version": $version
            },
            "success": true,
            "taskId": $taskId,
            "deletedAt": $timestamp,
            "reason": $reason,
            "childStrategy": $strategy,
            "affectedTasks": $affected,
            "orphanedTasks": $orphaned,
            "dependentsAffected": $dependents,
            "focusCleared": $focusCleared,
            "archived": $archived,
            "task": $task
        }'
else
    if [[ "$ARCHIVED" == "true" ]]; then
        log_info "Task $TASK_ID cancelled and archived"
    else
        log_info "Task $TASK_ID cancelled"
    fi
    echo ""
    echo -e "${BLUE}Task:${NC} $TASK_TITLE"
    echo -e "${BLUE}ID:${NC} $TASK_ID"
    echo -e "${BLUE}Status:${NC} $CURRENT_STATUS -> cancelled"
    echo -e "${BLUE}Reason:${NC} $REASON"
    echo -e "${BLUE}Cancelled:${NC} $TIMESTAMP"
    if [[ "$ARCHIVED" == "true" ]]; then
        echo -e "${BLUE}Archived:${NC} yes"
    fi

    if [[ "$DELETED_COUNT" -gt 1 ]]; then
        echo ""
        echo -e "${BLUE}Affected tasks:${NC}"
        echo "$DELETED_TASKS" | jq -r '.[]' | while read -r tid; do
            echo "  - $tid"
        done
    fi

    ORPHAN_COUNT=$(echo "$ORPHANED_TASKS" | jq 'length')
    if [[ "$ORPHAN_COUNT" -gt 0 ]]; then
        echo ""
        echo -e "${BLUE}Orphaned tasks:${NC}"
        echo "$ORPHANED_TASKS" | jq -r '.[]' | while read -r tid; do
            echo "  - $tid"
        done
    fi

    DEPENDENT_COUNT=$(echo "$DEPENDENTS_AFFECTED" | jq 'length')
    if [[ "$DEPENDENT_COUNT" -gt 0 ]]; then
        echo ""
        echo -e "${BLUE}Dependents updated (removed dependency):${NC}"
        echo "$DEPENDENTS_AFFECTED" | jq -r '.[]' | while read -r tid; do
            echo "  - $tid"
        done
    fi

    if [[ "$FOCUS_CLEARED" == true ]]; then
        echo ""
        log_info "Focus cleared from cancelled task"
    fi
fi

exit "$EXIT_SUCCESS"
