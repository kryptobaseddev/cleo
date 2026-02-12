#!/usr/bin/env bash
###CLEO
# command: unarchive
# category: write
# synopsis: Restore archived tasks back to todo.json with status options
# relevance: medium
# flags: --format,--quiet,--dry-run,--status,--preserve-status,--json,--human
# exits: 0,1,2,3,4,6
# json-output: true
###END
# CLEO Unarchive Script
# Restore archived tasks back to todo.json
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source version library for proper version management
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/core/version.sh" ]]; then
    # shellcheck source=../lib/core/version.sh
    source "$LIB_DIR/core/version.sh"
fi

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
ARCHIVE_FILE="${ARCHIVE_FILE:-.cleo/todo-archive.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"
LOG_FILE="${LOG_FILE:-.cleo/todo-log.json}"

# Source logging library for should_use_color function
if [[ -f "$LIB_DIR/core/logging.sh" ]]; then
    # shellcheck source=../lib/core/logging.sh
    source "$LIB_DIR/core/logging.sh"
fi

# Source backup library for unified backup management
if [[ -f "$LIB_DIR/data/backup.sh" ]]; then
    # shellcheck source=../lib/data/backup.sh
    source "$LIB_DIR/data/backup.sh"
fi

# Source file-ops library for atomic writes with file locking
if [[ -f "$LIB_DIR/data/file-ops.sh" ]]; then
    # shellcheck source=../lib/data/file-ops.sh
    source "$LIB_DIR/data/file-ops.sh"
fi

# Source output formatting library
if [[ -f "$LIB_DIR/core/output-format.sh" ]]; then
    # shellcheck source=../lib/core/output-format.sh
    source "$LIB_DIR/core/output-format.sh"
fi

# Source error JSON library (includes exit-codes.sh)
if [[ -f "$LIB_DIR/core/error-json.sh" ]]; then
    # shellcheck source=../lib/core/error-json.sh
    source "$LIB_DIR/core/error-json.sh"
elif [[ -f "$LIB_DIR/core/exit-codes.sh" ]]; then
    # Fallback: source exit codes directly if error-json.sh not available
    # shellcheck source=../lib/core/exit-codes.sh
    source "$LIB_DIR/core/exit-codes.sh"
fi

# Source config library for unified config access (v0.24.0)
if [[ -f "$LIB_DIR/core/config.sh" ]]; then
    # shellcheck source=../lib/core/config.sh
    source "$LIB_DIR/core/config.sh"
fi

# Source centralized flag parsing
source "$LIB_DIR/ui/flags.sh"

# Colors (respects NO_COLOR and FORCE_COLOR environment variables per https://no-color.org)
if declare -f should_use_color >/dev/null 2>&1 && should_use_color; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' NC=''
fi

# Defaults
DRY_RUN=false
FORMAT=""
QUIET=false
STATUS_OVERRIDE=""
PRESERVE_STATUS=false
COMMAND_NAME="unarchive"
declare -a TASK_IDS=()

usage() {
    cat << EOF
Usage: cleo unarchive [OPTIONS] <TASK_IDS...>

Restore archived tasks back to todo.json.

Options:
  --status STATUS     Set status on restore (default: pending)
                      Valid values: pending, active, blocked
  --preserve-status   Keep original status from before archiving
  --dry-run           Preview without making changes
  -f, --format FMT    Output format: text, json (default: auto-detect)
  --human             Force human-readable text output
  --json              Force JSON output (shorthand for --format json)
  -q, --quiet         Suppress non-essential output
  -h, --help          Show this help

Behavior:
  - Tasks are removed from todo-archive.json
  - Tasks are added back to todo.json
  - Archive metadata (_archive field) is removed
  - Status defaults to 'pending' unless --preserve-status or --status used
  - completedAt timestamp is cleared (task is being reopened)
  - Original task ID is preserved

JSON Output (--format json):
  Returns structured JSON with restored task IDs, counts, and remaining
  archive statistics. Useful for LLM agent automation workflows.

Examples:
  cleo unarchive T001 T002      # Restore specific tasks
  cleo unarchive --dry-run T001 # Preview restoration
  cleo unarchive --status active T001  # Restore as active
  cleo unarchive --preserve-status T001  # Keep original status
EOF
    exit 0
}

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# Check dependencies
check_deps() {
    if ! command -v jq &> /dev/null; then
        if [[ "$FORMAT" == "json" ]]; then
            echo '{"success":false,"error":{"code":"E_DEPENDENCY_MISSING","message":"jq is required but not installed"}}'
        else
            log_error "jq is required but not installed"
        fi
        exit "${EXIT_DEPENDENCY_ERROR:-5}"
    fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --status)
            STATUS_OVERRIDE="$2"
            shift 2
            ;;
        --status=*)
            STATUS_OVERRIDE="${1#*=}"
            shift
            ;;
        --preserve-status)
            PRESERVE_STATUS=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -f|--format)
            FORMAT="$2"
            shift 2
            ;;
        --human)
            FORMAT="human"
            shift
            ;;
        --json)
            FORMAT="json"
            shift
            ;;
        -q|--quiet)
            QUIET=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        -*)
            log_error "Unknown option: $1"
            exit "${EXIT_INVALID_INPUT:-1}"
            ;;
        *)
            # Collect task IDs
            TASK_IDS+=("$1")
            shift
            ;;
    esac
done

# Resolve output format (CLI > env > config > TTY-aware default)
if declare -f resolve_format >/dev/null 2>&1; then
    FORMAT=$(resolve_format "$FORMAT")
else
    FORMAT="${FORMAT:-text}"
fi

check_deps

# Validate status if provided
if [[ -n "$STATUS_OVERRIDE" ]]; then
    case "$STATUS_OVERRIDE" in
        pending|active|blocked)
            # Valid status
            ;;
        done)
            if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
                output_error "E_INPUT_INVALID" "Cannot restore task as 'done' - use a different status or leave as default" "${EXIT_INVALID_INPUT:-1}" true "Use --status pending, active, or blocked"
            else
                log_error "Cannot restore task as 'done' - use a different status or leave as default"
            fi
            exit "${EXIT_INVALID_INPUT:-1}"
            ;;
        *)
            if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
                output_error "E_INPUT_INVALID" "Invalid status: $STATUS_OVERRIDE" "${EXIT_INVALID_INPUT:-1}" true "Valid values: pending, active, blocked"
            else
                log_error "Invalid status: $STATUS_OVERRIDE (valid: pending, active, blocked)"
            fi
            exit "${EXIT_INVALID_INPUT:-1}"
            ;;
    esac
fi

# Check for conflicting options
if [[ -n "$STATUS_OVERRIDE" && "$PRESERVE_STATUS" == true ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "E_INPUT_INVALID" "--status and --preserve-status cannot be used together" "${EXIT_INVALID_INPUT:-1}" true "Use one or the other, not both"
    else
        log_error "--status and --preserve-status cannot be used together"
    fi
    exit "${EXIT_INVALID_INPUT:-1}"
fi

# Require at least one task ID
if [[ ${#TASK_IDS[@]} -eq 0 ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "E_INPUT_MISSING" "At least one task ID is required" "${EXIT_INVALID_INPUT:-1}" true "Usage: cleo unarchive <TASK_IDS...>"
    else
        log_error "At least one task ID is required"
        echo "Usage: cleo unarchive <TASK_IDS...>" >&2
    fi
    exit "${EXIT_INVALID_INPUT:-1}"
fi

# Check files exist
if [[ ! -f "$TODO_FILE" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "E_FILE_NOT_FOUND" "$TODO_FILE not found" "${EXIT_FILE_ERROR:-3}" false "Run 'cleo init' to initialize project"
    else
        log_error "$TODO_FILE not found"
    fi
    exit "${EXIT_FILE_ERROR:-3}"
fi

if [[ ! -f "$ARCHIVE_FILE" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "E_FILE_NOT_FOUND" "$ARCHIVE_FILE not found - no archived tasks to restore" "${EXIT_FILE_ERROR:-3}" false "Archive file does not exist"
    else
        log_error "$ARCHIVE_FILE not found - no archived tasks to restore"
    fi
    exit "${EXIT_FILE_ERROR:-3}"
fi

# Convert task IDs array to JSON
TASK_IDS_JSON=$(printf '%s\n' "${TASK_IDS[@]}" | jq -R . | jq -s .)

# Idempotency check: Check if tasks are already active in todo.json (not in archive)
# Per spec Part 5.6: Re-unarchiving already-active tasks is a no-op
EXISTING_TODO_IDS=$(jq '[.tasks[].id]' "$TODO_FILE")
ALREADY_ACTIVE_IDS=$(echo "$TASK_IDS_JSON" "$EXISTING_TODO_IDS" | jq -s '
    .[0] as $requested | .[1] as $existing |
    [$requested[] | select(. as $id | $existing | index($id))]
')
ALREADY_ACTIVE_COUNT=$(echo "$ALREADY_ACTIVE_IDS" | jq 'length')

# If ALL requested tasks are already active, return no-change (idempotent)
if [[ "$ALREADY_ACTIVE_COUNT" -eq "${#TASK_IDS[@]}" ]]; then
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    if [[ "$FORMAT" == "json" ]]; then
        jq -nc \
            --arg ts "$TIMESTAMP" \
            --arg ver "${CLEO_VERSION:-$(get_version)}" \
            --argjson taskIds "$ALREADY_ACTIVE_IDS" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {"format": "json", "command": "unarchive", "timestamp": $ts, "version": $ver},
                "success": true,
                "noChange": true,
                "message": "All requested tasks are already active (not in archive)",
                "tasksAlreadyActive": $taskIds
            }'
    else
        [[ "$QUIET" != true ]] && log_info "No changes made - all requested tasks are already active"
        if [[ "$ALREADY_ACTIVE_COUNT" -eq 1 ]]; then
            [[ "$QUIET" != true ]] && echo "Task $(echo "$ALREADY_ACTIVE_IDS" | jq -r '.[0]') is already active (not in archive)"
        else
            [[ "$QUIET" != true ]] && echo "Tasks already active: $(echo "$ALREADY_ACTIVE_IDS" | jq -r 'join(", ")')"
        fi
    fi
    exit "${EXIT_NO_CHANGE:-102}"
fi

# If SOME tasks are already active, warn and filter them out
if [[ "$ALREADY_ACTIVE_COUNT" -gt 0 ]]; then
    if [[ "$QUIET" != true && "$FORMAT" != "json" ]]; then
        log_warn "Some tasks are already active and will be skipped:"
        echo "$ALREADY_ACTIVE_IDS" | jq -r '.[] | "  - \(.)"'
    fi
    # Filter out already-active IDs from requested IDs
    TASK_IDS_JSON=$(echo "$TASK_IDS_JSON" "$ALREADY_ACTIVE_IDS" | jq -s '.[0] - .[1]')
fi

# Find tasks in archive
TASKS_TO_RESTORE=$(jq --argjson ids "$TASK_IDS_JSON" '
    [.archivedTasks[] | select(.id as $id | $ids | index($id))]
' "$ARCHIVE_FILE")

FOUND_COUNT=$(echo "$TASKS_TO_RESTORE" | jq 'length')
REQUESTED_COUNT=$(echo "$TASK_IDS_JSON" | jq 'length')

# Check if all requested tasks were found
if [[ "$FOUND_COUNT" -eq 0 ]]; then
    if [[ "$FORMAT" == "json" ]]; then
        TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        jq -nc \
            --arg ts "$TIMESTAMP" \
            --arg ver "${CLEO_VERSION:-$(get_version)}" \
            --argjson requestedIds "$TASK_IDS_JSON" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {"format": "json", "command": "unarchive", "timestamp": $ts, "version": $ver},
                "success": false,
                "error": {
                    "code": "E_TASK_NOT_FOUND",
                    "message": "None of the specified tasks were found in archive",
                    "requestedIds": $requestedIds
                }
            }'
    else
        log_error "None of the specified tasks were found in archive"
        echo "Requested task IDs:" >&2
        printf '  - %s\n' "${TASK_IDS[@]}" >&2
    fi
    exit "${EXIT_NOT_FOUND:-4}"
fi

# Check for missing tasks (requested but not found)
FOUND_IDS=$(echo "$TASKS_TO_RESTORE" | jq '[.[].id]')
MISSING_IDS=$(echo "$TASK_IDS_JSON" "$FOUND_IDS" | jq -s '.[0] - .[1]')
MISSING_COUNT=$(echo "$MISSING_IDS" | jq 'length')

if [[ "$MISSING_COUNT" -gt 0 && "$QUIET" != true && "$FORMAT" != "json" ]]; then
    log_warn "Some tasks were not found in archive:"
    echo "$MISSING_IDS" | jq -r '.[] | "  - \(.)"'
fi

[[ "$QUIET" != true && "$FORMAT" != "json" ]] && log_info "Found $FOUND_COUNT of $REQUESTED_COUNT requested tasks in archive"

# Determine the status to use for restored tasks
RESTORE_STATUS="pending"
if [[ "$PRESERVE_STATUS" == true ]]; then
    RESTORE_STATUS="preserve"  # Will be handled per-task
elif [[ -n "$STATUS_OVERRIDE" ]]; then
    RESTORE_STATUS="$STATUS_OVERRIDE"
fi

# Prepare tasks for restoration
# - Remove _archive metadata
# - Set new status (unless preserving)
# - Clear completedAt
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [[ "$RESTORE_STATUS" == "preserve" ]]; then
    # Preserve original status, but handle 'done' -> 'pending'
    TASKS_PREPARED=$(echo "$TASKS_TO_RESTORE" | jq --arg ts "$TIMESTAMP" '
        map(
            del(._archive) |
            .updatedAt = $ts |
            del(.completedAt) |
            # If status was "done", change to pending (task is being reopened)
            if .status == "done" then .status = "pending" else . end
        )
    ')
else
    # Use specified status
    TASKS_PREPARED=$(echo "$TASKS_TO_RESTORE" | jq --arg ts "$TIMESTAMP" --arg status "$RESTORE_STATUS" '
        map(
            del(._archive) |
            .status = $status |
            .updatedAt = $ts |
            del(.completedAt)
        )
    ')
fi

RESTORED_IDS_JSON=$(echo "$TASKS_PREPARED" | jq '[.[].id]')

if [[ "$DRY_RUN" == true ]]; then
    if [[ "$FORMAT" == "json" ]]; then
        # Get current archive and todo counts
        ARCHIVE_TOTAL=$(jq '.archivedTasks | length' "$ARCHIVE_FILE")
        TODO_TOTAL=$(jq '.tasks | length' "$TODO_FILE")
        REMAINING_ARCHIVED=$((ARCHIVE_TOTAL - FOUND_COUNT))
        NEW_TODO_TOTAL=$((TODO_TOTAL + FOUND_COUNT))

        jq -nc \
            --arg ts "$TIMESTAMP" \
            --arg ver "${CLEO_VERSION:-$(get_version)}" \
            --arg status "$RESTORE_STATUS" \
            --argjson count "$FOUND_COUNT" \
            --argjson ids "$RESTORED_IDS_JSON" \
            --argjson missingIds "$MISSING_IDS" \
            --argjson missingCount "$MISSING_COUNT" \
            --argjson remainingArchived "$REMAINING_ARCHIVED" \
            --argjson newTodoTotal "$NEW_TODO_TOTAL" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {"format": "json", "command": "unarchive", "timestamp": $ts, "version": $ver},
                "success": true,
                "dryRun": true,
                "restored": {"count": $count, "taskIds": $ids, "status": $status},
                "missing": {"count": $missingCount, "taskIds": $missingIds},
                "remaining": {"archived": $remainingArchived, "todo": $newTodoTotal}
            }'
    else
        echo ""
        echo "DRY RUN - Would restore these tasks:"
        echo "$TASKS_PREPARED" | jq -r '.[] | "  - \(.id): \(.title) (status: \(.status))"'
        if [[ "$MISSING_COUNT" -gt 0 ]]; then
            echo ""
            echo "Tasks not found in archive:"
            echo "$MISSING_IDS" | jq -r '.[] | "  - \(.)"'
        fi
        echo ""
        echo "No changes made."
    fi
    exit "${EXIT_SUCCESS:-0}"
fi

# ATOMIC TRANSACTION: Generate all temp files, validate, then commit
ARCHIVE_TMP="${ARCHIVE_FILE}.tmp"
TODO_TMP="${TODO_FILE}.tmp"
LOG_TMP="${LOG_FILE}.tmp"

# Cleanup function for rollback on failure
cleanup_temp_files() {
    rm -f "$ARCHIVE_TMP" "$TODO_TMP" "$LOG_TMP"
}

# Trap to ensure cleanup on error
trap cleanup_temp_files EXIT

# Step 1: Remove restored tasks from archive
if ! jq --argjson ids "$RESTORED_IDS_JSON" --arg ts "$TIMESTAMP" '
    .archivedTasks = [.archivedTasks[] | select(.id as $id | $ids | index($id) | not)] |
    ._meta.totalArchived = (.archivedTasks | length) |
    ._meta.lastModified = $ts
' "$ARCHIVE_FILE" > "$ARCHIVE_TMP"; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "E_FILE_WRITE_ERROR" "Failed to generate archive update" "${EXIT_FILE_ERROR:-3}" false
    else
        log_error "Failed to generate archive update"
    fi
    exit "${EXIT_FILE_ERROR:-3}"
fi

# Step 2: Add restored tasks to todo.json
# Check for ID conflicts first
EXISTING_IDS=$(jq '[.tasks[].id]' "$TODO_FILE")
CONFLICT_IDS=$(echo "$RESTORED_IDS_JSON" "$EXISTING_IDS" | jq -s '.[0] as $restore | .[1] | map(select(. as $id | $restore | index($id)))')
CONFLICT_COUNT=$(echo "$CONFLICT_IDS" | jq 'length')

if [[ "$CONFLICT_COUNT" -gt 0 ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "E_ID_COLLISION" "Task IDs already exist in todo.json: $(echo "$CONFLICT_IDS" | jq -r 'join(", ")')" "${EXIT_VALIDATION_ERROR:-6}" true "Remove conflicting tasks first or use different IDs"
    else
        log_error "Task IDs already exist in todo.json:"
        echo "$CONFLICT_IDS" | jq -r '.[] | "  - \(.)"' >&2
    fi
    exit "${EXIT_VALIDATION_ERROR:-6}"
fi

# Build updated todo with restored tasks
if ! jq --slurpfile tasks <(echo "$TASKS_PREPARED") --arg ts "$TIMESTAMP" '
    .tasks += $tasks[0] |
    .lastUpdated = $ts |
    ._meta.checksum = ((.tasks | tojson) | @base64 | .[0:16])
' "$TODO_FILE" > "$TODO_TMP"; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "E_FILE_WRITE_ERROR" "Failed to generate todo update" "${EXIT_FILE_ERROR:-3}" false
    else
        log_error "Failed to generate todo update"
    fi
    exit "${EXIT_FILE_ERROR:-3}"
fi

# Step 3: Generate log entry
if [[ -f "$LOG_FILE" ]]; then
    LOG_ID="log_$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 12)"
    SESSION_ID=$(jq -r '._meta.activeSession // "system"' "$TODO_FILE")

    if ! jq --arg id "$LOG_ID" --arg ts "$TIMESTAMP" --arg sid "$SESSION_ID" \
        --argjson count "$FOUND_COUNT" --argjson ids "$RESTORED_IDS_JSON" \
        --arg status "$RESTORE_STATUS" '
        .entries += [{
            "id": $id,
            "timestamp": $ts,
            "sessionId": $sid,
            "action": "task_unarchived",
            "actor": "system",
            "taskId": null,
            "before": null,
            "after": null,
            "details": {"count": $count, "taskIds": $ids, "restoredStatus": $status}
        }] |
        ._meta.totalEntries += 1 |
        ._meta.lastEntry = $ts
    ' "$LOG_FILE" > "$LOG_TMP"; then
        # Log failure is non-fatal, just warn
        [[ "$QUIET" != true && "$FORMAT" != "json" ]] && log_warn "Failed to generate log entry (non-fatal)"
        rm -f "$LOG_TMP"
        LOG_TMP=""
    fi
fi

# Step 4: Validate ALL generated JSON files before committing
for temp_file in "$ARCHIVE_TMP" "$TODO_TMP" ${LOG_TMP:+"$LOG_TMP"}; do
    if [[ ! -f "$temp_file" ]]; then
        continue
    fi

    if ! jq empty "$temp_file" 2>/dev/null; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_VALIDATION_SCHEMA" "Generated invalid JSON: $temp_file" "${EXIT_VALIDATION_ERROR:-6}" false
        else
            log_error "Generated invalid JSON: $temp_file"
        fi
        exit "${EXIT_VALIDATION_ERROR:-6}"
    fi
done

# Step 5: Create backup before committing changes
if declare -f create_safety_backup >/dev/null 2>&1; then
    BACKUP_PATH=$(create_safety_backup 2>&1) || {
        [[ "$QUIET" != true && "$FORMAT" != "json" ]] && log_warn "Backup failed, proceeding anyway"
    }
    if [[ -n "$BACKUP_PATH" && "$QUIET" != true && "$FORMAT" != "json" ]]; then
        log_info "Safety backup created: $BACKUP_PATH"
    fi
else
    # Fallback backup
    BACKUP_SUFFIX=".backup.$(date +%s)"
    cp "$ARCHIVE_FILE" "${ARCHIVE_FILE}${BACKUP_SUFFIX}" 2>/dev/null || true
    cp "$TODO_FILE" "${TODO_FILE}${BACKUP_SUFFIX}" 2>/dev/null || true
fi

# Step 6: Atomic commit with file locking via save_json()
if declare -f save_json >/dev/null 2>&1; then
    # Use save_json for locked atomic writes
    ARCHIVE_CONTENT=$(cat "$ARCHIVE_TMP")
    if ! save_json "$ARCHIVE_FILE" "$ARCHIVE_CONTENT"; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_FILE_WRITE_ERROR" "Failed to save archive file with locking" "${EXIT_FILE_ERROR:-3}" false
        else
            log_error "Failed to save archive file with locking"
        fi
        exit "${EXIT_FILE_ERROR:-3}"
    fi
    rm -f "$ARCHIVE_TMP"

    TODO_CONTENT=$(cat "$TODO_TMP")
    if ! save_json "$TODO_FILE" "$TODO_CONTENT"; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_FILE_WRITE_ERROR" "Failed to save todo file with locking" "${EXIT_FILE_ERROR:-3}" false
        else
            log_error "Failed to save todo file with locking"
        fi
        exit "${EXIT_FILE_ERROR:-3}"
    fi
    rm -f "$TODO_TMP"

    if [[ -n "${LOG_TMP:-}" && -f "$LOG_TMP" ]]; then
        LOG_CONTENT=$(cat "$LOG_TMP")
        save_json "$LOG_FILE" "$LOG_CONTENT" 2>/dev/null || true
        rm -f "$LOG_TMP"
    fi
else
    # Fallback: direct mv if file-ops.sh not available
    mv "$ARCHIVE_TMP" "$ARCHIVE_FILE"
    mv "$TODO_TMP" "$TODO_FILE"
    [[ -n "${LOG_TMP:-}" && -f "$LOG_TMP" ]] && mv "$LOG_TMP" "$LOG_FILE"
fi

# Remove trap since we succeeded
trap - EXIT

# Get final counts for output
REMAINING_ARCHIVED=$(jq '.archivedTasks | length' "$ARCHIVE_FILE")
TODO_TOTAL=$(jq '.tasks | length' "$TODO_FILE")

if [[ "$FORMAT" == "json" ]]; then
    OUTPUT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq -nc \
        --arg ts "$OUTPUT_TIMESTAMP" \
        --arg ver "${CLEO_VERSION:-$(get_version)}" \
        --arg status "$RESTORE_STATUS" \
        --argjson count "$FOUND_COUNT" \
        --argjson ids "$RESTORED_IDS_JSON" \
        --argjson missingIds "$MISSING_IDS" \
        --argjson missingCount "$MISSING_COUNT" \
        --argjson skippedIds "$ALREADY_ACTIVE_IDS" \
        --argjson skippedCount "$ALREADY_ACTIVE_COUNT" \
        --argjson remainingArchived "$REMAINING_ARCHIVED" \
        --argjson todoTotal "$TODO_TOTAL" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {"format": "json", "command": "unarchive", "timestamp": $ts, "version": $ver},
            "success": true,
            "restored": {"count": $count, "taskIds": $ids, "status": $status},
            "skipped": {"count": $skippedCount, "taskIds": $skippedIds, "reason": "already active in todo.json"},
            "missing": {"count": $missingCount, "taskIds": $missingIds},
            "remaining": {"archived": $remainingArchived, "todo": $todoTotal}
        }'
else
    if [[ "$QUIET" != true ]]; then
        log_info "Restored $FOUND_COUNT tasks from archive"
        echo ""
        echo "Restored tasks:"
        echo "$TASKS_PREPARED" | jq -r '.[] | "  - \(.id): \(.title) (status: \(.status))"'

        if [[ "$ALREADY_ACTIVE_COUNT" -gt 0 ]]; then
            echo ""
            log_warn "Tasks already active (skipped): $ALREADY_ACTIVE_COUNT"
            echo "$ALREADY_ACTIVE_IDS" | jq -r '.[] | "  - \(.)"'
        fi

        if [[ "$MISSING_COUNT" -gt 0 ]]; then
            echo ""
            log_warn "Tasks not found in archive: $MISSING_COUNT"
            echo "$MISSING_IDS" | jq -r '.[] | "  - \(.)"'
        fi

        echo ""
        echo "Summary:"
        echo "  Remaining in archive: $REMAINING_ARCHIVED"
        echo "  Total tasks in todo: $TODO_TOTAL"
    fi
fi

exit "${EXIT_SUCCESS:-0}"
