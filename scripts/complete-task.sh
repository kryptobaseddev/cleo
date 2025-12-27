#!/usr/bin/env bash
# CLEO Complete Task Script
# Mark a task as complete and optionally trigger archive
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
LOG_SCRIPT="${SCRIPT_DIR}/log.sh"
ARCHIVE_SCRIPT="${SCRIPT_DIR}/archive.sh"

# Source paths.sh for path resolution functions
if [[ -f "$LIB_DIR/paths.sh" ]]; then
    source "$LIB_DIR/paths.sh"
fi

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"

# Command name for error-json library
COMMAND_NAME="complete"

# Source logging library for should_use_color function
if [[ -f "$LIB_DIR/version.sh" ]]; then
  # shellcheck source=../lib/version.sh
  source "$LIB_DIR/version.sh"
fi
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
# Note: error-json.sh sources exit-codes.sh, so we don't source it separately
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  # shellcheck source=../lib/error-json.sh
  source "$LIB_DIR/error-json.sh"
elif [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  # Fallback: source exit codes directly if error-json.sh not available
  # shellcheck source=../lib/exit-codes.sh
  source "$LIB_DIR/exit-codes.sh"
fi

# Source config library for unified config access (v0.24.0)
if [[ -f "$LIB_DIR/config.sh" ]]; then
  # shellcheck source=../lib/config.sh
  source "$LIB_DIR/config.sh"
fi

# Source phase tracking library for phase context validation (v2.2.0)
if [[ -f "$LIB_DIR/phase-tracking.sh" ]]; then
  # shellcheck source=../lib/phase-tracking.sh
  source "$LIB_DIR/phase-tracking.sh"
fi

# Source validation library for input validation (Part 5.3 compliance)
if [[ -f "$LIB_DIR/validation.sh" ]]; then
  # shellcheck source=../lib/validation.sh
  source "$LIB_DIR/validation.sh"
fi

# Colors (respects NO_COLOR and FORCE_COLOR environment variables per https://no-color.org)
if declare -f should_use_color >/dev/null 2>&1 && should_use_color; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' NC=''
fi

# Defaults
TASK_ID=""
SKIP_ARCHIVE=false
NOTES=""
SKIP_NOTES=false
FORMAT=""
DRY_RUN=false
QUIET=false

usage() {
  cat << EOF
Usage: cleo complete TASK_ID [OPTIONS]

Mark a task as complete (status='done') and set completedAt timestamp.

Arguments:
  TASK_ID                 Task ID to complete (e.g., T001)

Options:
  -n, --notes TEXT        Completion notes describing what was done (required)
  --skip-notes            Skip notes requirement (use for quick completions)
  --skip-archive          Don't trigger auto-archive even if configured
  -f, --format FORMAT     Output format: text (default) or json
  --human                 Force human-readable text output (same as --format text)
  --json                  Force JSON output (same as --format json)
  --dry-run               Show what would be completed without making changes
  -q, --quiet             Suppress informational messages
  -h, --help              Show this help

Notes Requirement:
  Completion notes are required by default for better task tracking and audit trails.
  Use --skip-notes to bypass this for quick completions.

  Good notes describe: what was done, how it was verified, and any relevant references
  (commit hashes, PR numbers, documentation links).

Output Formats:
  text    Human-readable output with colors and status messages (default for TTY)
  json    Machine-readable JSON with full task data (default for pipes/agents)

JSON Output Structure:
  {
    "_meta": {"command": "complete", "timestamp": "...", "version": "..."},
    "success": true,
    "taskId": "T042",
    "completedAt": "2025-12-17T10:00:00Z",
    "cycleTimeDays": 3.5,
    "archived": false,
    "task": { /* full completed task */ }
  }

Examples:
  cleo complete T001 --notes "Implemented auth middleware. Tested with unit tests."
  cleo complete T042 --notes "Fixed bug #123. PR merged."
  cleo complete T042 --skip-notes --skip-archive
  cleo complete T001 --json --notes "Done"     # JSON output for agents
  cleo complete T001 --format json             # Same as --json

After completion, if autoArchiveOnComplete is enabled in config,
the archive script will run automatically.
EOF
  exit "$EXIT_SUCCESS"
}

log_info()  { [[ "$QUIET" != true ]] && echo -e "${GREEN}[INFO]${NC} $1" || true; }
log_warn()  { [[ "$QUIET" != true ]] && echo -e "${YELLOW}[WARN]${NC} $1" || true; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# Check dependencies
check_deps() {
  if ! command -v jq &> /dev/null; then
    log_error "jq is required but not installed"
    exit "$EXIT_DEPENDENCY_ERROR"
  fi
}

# Parse arguments
if [[ $# -eq 0 ]]; then
  log_error "Task ID required"
  usage
fi

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help) usage ;;
    -q|--quiet) QUIET=true; shift ;;
    -n|--notes)
      NOTES="${2:-}"
      if [[ -z "$NOTES" ]]; then
        log_error "--notes requires a text argument"
        exit "$EXIT_INVALID_INPUT"
      fi
      shift 2
      ;;
    -f|--format)
      FORMAT="${2:-}"
      if [[ -z "$FORMAT" ]]; then
        log_error "--format requires an argument (text or json)"
        exit "$EXIT_INVALID_INPUT"
      fi
      shift 2
      ;;
    --human) FORMAT="text"; shift ;;
    --json) FORMAT="json"; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --skip-notes) SKIP_NOTES=true; shift ;;
    --skip-archive) SKIP_ARCHIVE=true; shift ;;
    -*) log_error "Unknown option: $1"; exit "$EXIT_INVALID_INPUT" ;;
    *) TASK_ID="$1"; shift ;;
  esac
done

# Resolve format (CLI > env > config > TTY-aware default)
if declare -f resolve_format >/dev/null 2>&1; then
  FORMAT=$(resolve_format "$FORMAT" true "text,json")
else
  # Fallback if output-format.sh not available
  FORMAT="${FORMAT:-text}"
fi

# Require notes unless --skip-notes is provided
if [[ -z "$NOTES" && "$SKIP_NOTES" == false ]]; then
  if declare -f output_error >/dev/null 2>&1; then
    output_error "$E_INPUT_MISSING" "Completion notes required. Use --notes 'description' or --skip-notes to bypass." \
      "${EXIT_INVALID_INPUT:-2}" true "Example: cleo complete $TASK_ID --notes 'Implemented feature. Tests passing.'"
    exit "${EXIT_INVALID_INPUT:-2}"
  else
    log_error "Completion notes required. Use --notes 'description' or --skip-notes to bypass."
    echo "" >&2
    echo "Example:" >&2
    echo "  cleo complete $TASK_ID --notes 'Implemented feature. Tests passing.'" >&2
    echo "  cleo complete $TASK_ID --skip-notes" >&2
    exit "$EXIT_INVALID_INPUT"
  fi
fi

check_deps

# Validate task ID format
if [[ ! "$TASK_ID" =~ ^T[0-9]{3,}$ ]]; then
  if declare -f output_error >/dev/null 2>&1; then
    output_error "$E_TASK_INVALID_ID" "Invalid task ID format: $TASK_ID (must be T### format)" \
      "${EXIT_INVALID_INPUT:-2}" false "Task IDs must be in T### format (e.g., T001, T042)"
    exit "${EXIT_INVALID_INPUT:-2}"
  else
    log_error "Invalid task ID format: $TASK_ID (must be T### format)"
    exit "$EXIT_INVALID_INPUT"
  fi
fi

# Check files exist
if [[ ! -f "$TODO_FILE" ]]; then
  if declare -f output_error >/dev/null 2>&1; then
    output_error "$E_NOT_INITIALIZED" "$TODO_FILE not found. Run cleo init first." \
      "${EXIT_FILE_ERROR:-3}" true "Run 'cleo init' to initialize the project"
    exit "${EXIT_FILE_ERROR:-3}"
  else
    log_error "$TODO_FILE not found. Run cleo init first."
    exit "$EXIT_FILE_ERROR"
  fi
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  if declare -f output_error >/dev/null 2>&1; then
    output_error "$E_NOT_INITIALIZED" "$CONFIG_FILE not found. Run cleo init first." \
      "${EXIT_FILE_ERROR:-3}" true "Run 'cleo init' to initialize the project"
    exit "${EXIT_FILE_ERROR:-3}"
  else
    log_error "$CONFIG_FILE not found. Run cleo init first."
    exit "$EXIT_FILE_ERROR"
  fi
fi

# Check for external modifications (informational, not blocking)
# Note: Checksum verification is for audit/detection, not write-gating.
# In multi-writer scenarios (TodoWrite + CLI), external modifications are expected.
CURRENT_CHECKSUM=$(jq -r '._meta.checksum // ""' "$TODO_FILE")
CURRENT_TASKS=$(jq -c '.tasks' "$TODO_FILE")
CALCULATED_CHECKSUM=$(echo "$CURRENT_TASKS" | sha256sum | cut -c1-16)

if [[ -n "$CURRENT_CHECKSUM" && "$CURRENT_CHECKSUM" != "$CALCULATED_CHECKSUM" ]]; then
  [[ "$FORMAT" != "json" ]] && log_info "External modification detected (checksum: $CURRENT_CHECKSUM → $CALCULATED_CHECKSUM)"
fi

# Check task exists
TASK=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE")

if [[ -z "$TASK" ]]; then
  if declare -f output_error >/dev/null 2>&1; then
    output_error "$E_TASK_NOT_FOUND" "Task $TASK_ID not found" \
      "${EXIT_NOT_FOUND:-4}" true "Use 'cleo list' to see available tasks or 'cleo exists $TASK_ID --include-archive' to check archive"
    exit "${EXIT_NOT_FOUND:-4}"
  else
    log_error "Task $TASK_ID not found"
    exit "$EXIT_NOT_FOUND"
  fi
fi

# Check current status
CURRENT_STATUS=$(echo "$TASK" | jq -r '.status')

# Capture createdAt for cycle time calculation
CREATED_AT=$(echo "$TASK" | jq -r '.createdAt // empty')

# Idempotency check: Per LLM-AGENT-FIRST-SPEC.md Part 5.6
# Completing already-done task returns EXIT_NO_CHANGE (102)
# Agents should treat EXIT_NO_CHANGE as success, not retry
if [[ "$CURRENT_STATUS" == "done" ]]; then
  TASK_TITLE=$(echo "$TASK" | jq -r '.title')
  COMPLETED_AT=$(echo "$TASK" | jq -r '.completedAt')

  if [[ "$FORMAT" == "json" ]]; then
    # JSON output with noChange: true per spec Part 5.6
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq -n \
      --arg version "${CLEO_VERSION:-unknown}" \
      --arg timestamp "$TIMESTAMP" \
      --arg taskId "$TASK_ID" \
      --arg completedAt "$COMPLETED_AT" \
      --arg message "Task $TASK_ID is already complete" \
      --argjson task "$TASK" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "command": "complete",
          "timestamp": $timestamp,
          "version": $version
        },
        "success": true,
        "noChange": true,
        "taskId": $taskId,
        "message": $message,
        "completedAt": $completedAt,
        "task": $task
      }'
    exit "${EXIT_NO_CHANGE:-102}"
  else
    log_warn "Task $TASK_ID is already completed"
    echo ""
    echo "Task: $TASK_TITLE"
    echo "Completed at: $COMPLETED_AT"
    exit "${EXIT_NO_CHANGE:-102}"
  fi
fi

# Debug output for parent auto-complete (remove after testing)
# Debug output removed - functionality verified

# Validate status transition (pending/active/blocked → done)
if [[ ! "$CURRENT_STATUS" =~ ^(pending|active|blocked)$ ]]; then
  if declare -f output_error >/dev/null 2>&1; then
    output_error "$E_TASK_INVALID_STATUS" "Invalid status transition: $CURRENT_STATUS → done" \
      "${EXIT_VALIDATION_ERROR:-6}" false "Tasks can only be completed from pending, active, or blocked status"
    exit "${EXIT_VALIDATION_ERROR:-6}"
  else
    log_error "Invalid status transition: $CURRENT_STATUS → done"
    exit "$EXIT_VALIDATION_ERROR"
  fi
fi

# DRY-RUN: Show what would be completed without making changes
if [[ "$DRY_RUN" == true ]]; then
  TASK_TITLE=$(echo "$TASK" | jq -r '.title')
  DRY_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Calculate cycle time for dry-run preview
  DRY_CYCLE_TIME=""
  if [[ -n "$CREATED_AT" ]]; then
    CREATED_EPOCH=$(date -d "$CREATED_AT" +%s 2>/dev/null || echo "")
    DRY_EPOCH=$(date -d "$DRY_TIMESTAMP" +%s 2>/dev/null || echo "")
    if [[ -n "$CREATED_EPOCH" && -n "$DRY_EPOCH" ]]; then
      DIFF_SECONDS=$((DRY_EPOCH - CREATED_EPOCH))
      DRY_CYCLE_TIME=$(awk "BEGIN {printf \"%.1f\", $DIFF_SECONDS / 86400}")
    fi
  fi

  if [[ "$FORMAT" == "json" ]]; then
    jq -n \
      --arg version "${CLEO_VERSION:-unknown}" \
      --arg timestamp "$DRY_TIMESTAMP" \
      --arg taskId "$TASK_ID" \
      --arg completedAt "$DRY_TIMESTAMP" \
      --arg cycleTime "${DRY_CYCLE_TIME:-null}" \
      --arg currentStatus "$CURRENT_STATUS" \
      --argjson task "$TASK" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "command": "complete",
          "timestamp": $timestamp,
          "version": $version
        },
        "success": true,
        "dryRun": true,
        "wouldComplete": {
          "taskId": $taskId,
          "title": $task.title,
          "currentStatus": $currentStatus,
          "completedAt": $completedAt,
          "cycleTimeDays": (if $cycleTime == "null" then null else ($cycleTime | tonumber) end)
        },
        "task": $task
      }'
  else
    echo -e "${YELLOW}[DRY-RUN]${NC} Would complete task:"
    echo ""
    echo -e "${BLUE}Task:${NC} $TASK_TITLE"
    echo -e "${BLUE}ID:${NC} $TASK_ID"
    echo -e "${BLUE}Status:${NC} $CURRENT_STATUS → done"
    echo -e "${BLUE}Would Complete:${NC} $DRY_TIMESTAMP"
    if [[ -n "$NOTES" ]]; then
      echo -e "${BLUE}Notes:${NC} $NOTES"
    fi
    if [[ -n "$DRY_CYCLE_TIME" ]]; then
      echo -e "${BLUE}Cycle Time:${NC} ${DRY_CYCLE_TIME} days"
    fi
    echo ""
    echo -e "${YELLOW}No changes made (dry-run mode)${NC}"
  fi
  exit "$EXIT_SUCCESS"
fi

# Create safety backup before modification using unified backup library
if declare -f create_safety_backup >/dev/null 2>&1; then
  BACKUP_PATH=$(create_safety_backup "$TODO_FILE" "complete" 2>&1) || {
    [[ "$FORMAT" != "json" ]] && log_warn "Backup library failed, using fallback backup method"
    # Fallback to inline backup if library fails
    BACKUP_DIR=".cleo/backups/safety"
    mkdir -p "$BACKUP_DIR"
    BACKUP_FILE="${BACKUP_DIR}/todo.json.$(date +%Y%m%d_%H%M%S)"
    cp "$TODO_FILE" "$BACKUP_FILE"
    BACKUP_PATH="$BACKUP_FILE"
  }
  [[ "$FORMAT" != "json" ]] && log_info "Backup created: $BACKUP_PATH"
else
  # Fallback if backup library not available
  BACKUP_DIR=".cleo/backups/safety"
  mkdir -p "$BACKUP_DIR"
  BACKUP_FILE="${BACKUP_DIR}/todo.json.$(date +%Y%m%d_%H%M%S)"
  cp "$TODO_FILE" "$BACKUP_FILE"
  [[ "$FORMAT" != "json" ]] && log_info "Backup created: $BACKUP_FILE"
fi

# Capture before state
BEFORE_STATE=$(echo "$TASK" | jq '{status, completedAt}')

# Update task with completion
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SESSION_ID=$(jq -r '._meta.activeSession // "system"' "$TODO_FILE")

# Update task: set status=done, add completedAt, clear blockedBy, and add completion note
if [[ -n "$NOTES" ]]; then
  COMPLETION_NOTE="[COMPLETED $TIMESTAMP] $NOTES"
  UPDATED_TASKS=$(jq --arg id "$TASK_ID" --arg ts "$TIMESTAMP" --arg note "$COMPLETION_NOTE" '
    .tasks |= map(
      if .id == $id then
        .status = "done" |
        .completedAt = $ts |
        del(.blockedBy) |
        .notes = ((.notes // []) + [$note])
      else . end
    )
  ' "$TODO_FILE") || {
    log_error "jq failed to update tasks (with notes)"
    exit "$EXIT_FILE_ERROR"
  }
else
  UPDATED_TASKS=$(jq --arg id "$TASK_ID" --arg ts "$TIMESTAMP" '
    .tasks |= map(
      if .id == $id then
        .status = "done" |
        .completedAt = $ts |
        del(.blockedBy)
      else . end
    )
  ' "$TODO_FILE") || {
    log_error "jq failed to update tasks (no notes)"
    exit "$EXIT_FILE_ERROR"
  }
fi

# Verify UPDATED_TASKS is valid JSON and not empty
if [[ -z "$UPDATED_TASKS" ]]; then
  log_error "Generated empty JSON structure"
  exit "$EXIT_FILE_ERROR"
fi

if ! echo "$UPDATED_TASKS" | jq empty 2>/dev/null; then
  log_error "Generated invalid JSON structure"
  exit "$EXIT_FILE_ERROR"
fi

# Recalculate checksum
NEW_TASKS=$(echo "$UPDATED_TASKS" | jq -c '.tasks')
NEW_CHECKSUM=$(echo "$NEW_TASKS" | sha256sum | cut -c1-16)

# Update file with new checksum and lastUpdated
FINAL_JSON=$(echo "$UPDATED_TASKS" | jq --arg checksum "$NEW_CHECKSUM" --arg ts "$TIMESTAMP" '
  ._meta.checksum = $checksum |
  .lastUpdated = $ts
')

# Atomic write with file locking (prevents race conditions)
# Using save_json from lib/file-ops.sh which includes:
# - File locking to prevent concurrent writes
# - Atomic write with backup
# - JSON validation
# - Proper error handling
if ! save_json "$TODO_FILE" "$FINAL_JSON"; then
  log_error "Failed to write todo file. Rolling back."
  exit "$EXIT_FILE_ERROR"
fi

# Verify task was actually updated
VERIFY_STATUS=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
if [[ "$VERIFY_STATUS" != '"done"' ]]; then
  log_error "Failed to update task status."
  exit "$EXIT_FILE_ERROR"
fi

# Capture after state
AFTER_STATE=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | {status, completedAt}' "$TODO_FILE")

# Get full completed task for output
COMPLETED_TASK=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE")
TASK_TITLE=$(echo "$COMPLETED_TASK" | jq -r '.title')

# Phase context check (permissive - warn only, never block completion)
if declare -f check_phase_context >/dev/null 2>&1; then
  TASK_PHASE=$(echo "$COMPLETED_TASK" | jq -r '.phase // empty')
  if [[ -n "$TASK_PHASE" ]]; then
    check_phase_context "$TASK_PHASE" "$TODO_FILE" || true  # Never block completion
  fi
fi

# Calculate cycle time (days between created and completed)
CYCLE_TIME_DAYS=""
if [[ -n "$CREATED_AT" ]]; then
  # Calculate using date epoch conversion
  CREATED_EPOCH=$(date -d "$CREATED_AT" +%s 2>/dev/null || echo "")
  COMPLETED_EPOCH=$(date -d "$TIMESTAMP" +%s 2>/dev/null || echo "")

  if [[ -n "$CREATED_EPOCH" && -n "$COMPLETED_EPOCH" ]]; then
    # Calculate days with one decimal precision
    DIFF_SECONDS=$((COMPLETED_EPOCH - CREATED_EPOCH))
    # Use awk for floating point division
    CYCLE_TIME_DAYS=$(awk "BEGIN {printf \"%.1f\", $DIFF_SECONDS / 86400}")
  fi
fi

# Log the operation (before output, so log entry is created regardless of format)
if [[ -f "$LOG_SCRIPT" ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    # Suppress all log output in JSON mode
    "$LOG_SCRIPT" \
      --action "status_changed" \
      --task-id "$TASK_ID" \
      --before "$BEFORE_STATE" \
      --after "$AFTER_STATE" \
      --details "{\"field\":\"status\",\"operation\":\"complete\"}" \
      --actor "system" >/dev/null 2>&1 || true
  else
    "$LOG_SCRIPT" \
      --action "status_changed" \
      --task-id "$TASK_ID" \
      --before "$BEFORE_STATE" \
      --after "$AFTER_STATE" \
      --details "{\"field\":\"status\",\"operation\":\"complete\"}" \
      --actor "system" 2>/dev/null || log_warn "Failed to write log entry"
  fi
fi

# Check if current focus was this task and clear it
FOCUS_CLEARED=false
CURRENT_FOCUS=$(jq -r '.focus.currentTask // ""' "$TODO_FILE")
if [[ "$CURRENT_FOCUS" == "$TASK_ID" ]]; then
  updated_todo=$(jq '.focus.currentTask = null' "$TODO_FILE")
  save_json "$TODO_FILE" "$updated_todo"
  FOCUS_CLEARED=true
  [[ "$FORMAT" != "json" ]] && log_info "Clearing focus from completed task"
fi

# Check auto-archive configuration using config.sh library for priority resolution
ARCHIVED=false
if [[ "$SKIP_ARCHIVE" == false ]]; then
  if declare -f get_config_value >/dev/null 2>&1; then
    AUTO_ARCHIVE=$(get_config_value "archive.autoArchiveOnComplete" "false")
  else
    # Fallback to direct jq if config.sh not available
    AUTO_ARCHIVE=$(jq -r '.archive.autoArchiveOnComplete // false' "$CONFIG_FILE")
  fi

  if [[ "$AUTO_ARCHIVE" == "true" ]]; then
    if [[ "$FORMAT" != "json" ]]; then
      echo ""
      log_info "Auto-archive is enabled, checking archive policy..."
    fi

    if [[ -f "$ARCHIVE_SCRIPT" ]]; then
      # Run archive script (suppress output for JSON mode)
      if [[ "$FORMAT" == "json" ]]; then
        "$ARCHIVE_SCRIPT" >/dev/null 2>&1 && ARCHIVED=true
      else
        "$ARCHIVE_SCRIPT" 2>&1 | sed 's/^/  /' || log_warn "Archive script encountered issues"
        ARCHIVED=true
      fi
    else
      [[ "$FORMAT" != "json" ]] && log_warn "Archive script not found at $ARCHIVE_SCRIPT"
    fi
  fi
fi

# Check for parent auto-complete functionality
AUTO_COMPLETED_PARENTS=()

# Read configuration with proper fallback
AUTO_COMPLETE_PARENT="false"
AUTO_COMPLETE_MODE="off"

# Check if config.sh library is available and loaded
if declare -f get_config_value >/dev/null 2>&1; then
  # Use config library (preferred method)
  AUTO_COMPLETE_PARENT=$(get_config_value "hierarchy.autoCompleteParent" "false")
  AUTO_COMPLETE_MODE=$(get_config_value "hierarchy.autoCompleteMode" "off")
elif [[ -f "$CONFIG_FILE" ]]; then
  # Fallback: direct JSON reading
  AUTO_COMPLETE_PARENT=$(jq -r '.hierarchy.autoCompleteParent // false' "$CONFIG_FILE")
  AUTO_COMPLETE_MODE=$(jq -r '.hierarchy.autoCompleteMode // "off"' "$CONFIG_FILE")
fi

# === SOLID/DRY REFACTOR: Parent Auto-Complete Functions ===

# Check if all siblings of a task are completed
# Args: $1 - parentId, $2 - currentTaskId, $3 - todoFile
# Returns: 0 if all siblings completed, 1 if any incomplete
all_siblings_completed() {
  local parent_id="$1"
  local current_task_id="$2"
  local todo_file="$3"
  
  # Check if any siblings are incomplete (pending, active, or blocked)
  local incomplete_siblings
  incomplete_siblings=$(jq --arg parentId "$parent_id" --arg currentId "$current_task_id" '
    .tasks[] | 
    select(.parentId == $parentId and .id != $currentId and 
           (.status == "pending" or .status == "active" or .status == "blocked"))
  ' "$todo_file")
  
  [[ -z "$incomplete_siblings" ]]
}

# Generate completion note based on auto-complete mode
# Args: $1 - mode (auto/suggest/off), $2 - timestamp, $3 - userConfirmed (optional)
# Returns: completion note or empty string
generate_completion_note() {
  local mode="$1"
  local timestamp="$2"
  local user_confirmed="${3:-false}"
  
  case "$mode" in
    "auto")
      echo "[AUTO-COMPLETED $timestamp] All child tasks completed"
      ;;
    "suggest")
      if [[ "$user_confirmed" == "true" ]]; then
        echo "[AUTO-COMPLETED $timestamp] All child tasks completed (user confirmed)"
      else
        # In suggest mode without confirmation, return empty to skip completion
        echo ""
      fi
      ;;
    "off")
      echo ""
      ;;
    *)
      echo ""
      ;;
  esac
}

# Prompt user for parent auto-complete confirmation (for suggest mode)
# Args: $1 - parentId, $2 - parentTitle, $3 - format
# Returns: 0 if user confirms, 1 if user declines
prompt_parent_completion() {
  local parent_id="$1"
  local parent_title="$2"
  local format="$3"
  
  # Skip prompting in JSON mode
  if [[ "$format" == "json" ]]; then
    return 0
  fi
  
  echo ""
  log_info "Parent task $parent_id is ready for completion (all children done)"
  echo -e "${BLUE}Parent:${NC} $parent_title"
  echo -e "${YELLOW}Auto-complete parent?${NC} [Y/n] "
  
  read -r -p "" response
  [[ ! "$response" =~ ^[Nn]$ ]]
}

# Complete a parent task and update the todo file
# Args: $1 - parentId, $2 - completionNote, $3 - timestamp, $4 - todoFile, $5 - format
# Returns: 0 on success, 1 on failure
complete_parent_task() {
  local parent_id="$1"
  local completion_note="$2"
  local timestamp="$3"
  local todo_file="$4"
  local format="$5"
  
  # Update parent task
  local updated_tasks
  updated_tasks=$(jq --arg id "$parent_id" --arg ts "$timestamp" --arg note "$completion_note" '
    .tasks |= map(
      if .id == $id then
        .status = "done" |
        .completedAt = $ts |
        del(.blockedBy) |
        .notes = ((.notes // []) + [$note])
      else . end
    )
  ' "$todo_file") || {
    [[ "$format" != "json" ]] && log_warn "Failed to auto-complete parent task $parent_id"
    return 1
  }
  
  # Verify updated tasks is valid JSON
  if [[ -z "$updated_tasks" ]] || ! echo "$updated_tasks" | jq empty 2>/dev/null; then
    [[ "$format" != "json" ]] && log_warn "Generated invalid JSON for parent task $parent_id"
    return 1
  fi
  
  # Generate fresh checksum for parent update
  local parent_tasks_json
  parent_tasks_json=$(echo "$updated_tasks" | jq -c '.tasks')
  local parent_checksum
  parent_checksum=$(echo "$parent_tasks_json" | sha256sum | cut -c1-16)
  
  # Update file with new checksum and lastUpdated
  local final_json
  final_json=$(echo "$updated_tasks" | jq --arg checksum "$parent_checksum" --arg ts "$timestamp" '
    ._meta.checksum = $checksum |
    .lastUpdated = $ts
  ')
  
  # Save the updated file
  if save_json "$todo_file" "$final_json"; then
    return 0
  else
    [[ "$format" != "json" ]] && log_warn "Failed to save updated todo file for parent $parent_id"
    return 1
  fi
}

# Log parent auto-completion operation
# Args: $1 - parentId, $2 - parentTask (JSON), $3 - timestamp, $4 - logScript
log_parent_completion() {
  local parent_id="$1"
  local parent_task="$2"
  local timestamp="$3"
  local log_script="$4"
  
  if [[ -f "$log_script" ]]; then
    local parent_before_state
    parent_before_state=$(echo "$parent_task" | jq '{status, completedAt}')
    local parent_after_state
    parent_after_state=$(echo "$parent_task" | jq --arg ts "$timestamp" '{status: "done", completedAt: $ts}')
    
    "$log_script" \
      --action "status_changed" \
      --task-id "$parent_id" \
      --before "$parent_before_state" \
      --after "$parent_after_state" \
      --details "{\"field\":\"status\",\"operation\":\"auto_complete\"}" \
      --actor "system" >/dev/null 2>&1 || true
  fi
}

# Handle auto-complete for a single parent task (non-recursive)
# Args: $1 - parentId, $2 - completedTaskId, $3 - todoFile, $4 - format, $5 - autoCompleteMode, $6 - timestamp
# Returns: 0 if parent was auto-completed, 1 if not
handle_single_parent_auto_complete() {
  local parent_id="$1"
  local completed_task_id="$2"
  local todo_file="$3"
  local format="$4"
  local auto_complete_mode="$5"
  local timestamp="$6"
  
  # Get parent task
  local parent_task
  parent_task=$(jq --arg id "$parent_id" '.tasks[] | select(.id == $id)' "$todo_file")
  
  # Return if parent doesn't exist
  [[ -z "$parent_task" ]] && return 1
  
  local parent_status
  parent_status=$(echo "$parent_task" | jq -r '.status')
  
  # Return if parent is already completed
  [[ ! "$parent_status" =~ ^(pending|active|blocked)$ ]] && return 1
  
  # Check if all siblings are completed
  if ! all_siblings_completed "$parent_id" "$completed_task_id" "$todo_file"; then
    return 1
  fi
  
  # All conditions met, prepare for auto-completion
  local parent_title
  parent_title=$(echo "$parent_task" | jq -r '.title')
  local user_confirmed="false"
  local completion_note=""
  
  # Handle different modes
  if [[ "$auto_complete_mode" == "suggest" ]]; then
    # Prompt user for confirmation (skip in JSON mode)
    if [[ "$format" == "json" ]]; then
      user_confirmed="true"
    else
      if prompt_parent_completion "$parent_id" "$parent_title" "$format"; then
        user_confirmed="true"
      else
        # User declined, skip auto-complete
        [[ "$format" != "json" ]] && log_info "Parent auto-complete skipped by user"
        return 1
      fi
    fi
  elif [[ "$auto_complete_mode" == "auto" ]]; then
    user_confirmed="true"
  else
    # Mode is off, skip auto-complete
    return 1
  fi
  
  # Generate completion note
  completion_note=$(generate_completion_note "$auto_complete_mode" "$timestamp" "$user_confirmed")
  
  # Skip if no completion note (e.g., suggest mode without confirmation)
  [[ -z "$completion_note" ]] && return 1
  
  # Complete the parent task
  if complete_parent_task "$parent_id" "$completion_note" "$timestamp" "$todo_file" "$format"; then
    # Log the operation
    log_parent_completion "$parent_id" "$parent_task" "$timestamp" "$LOG_SCRIPT"
    
    # Output success message
    [[ "$format" != "json" ]] && log_info "Auto-completed parent task: $parent_id - $parent_title"
    
    # Return success
    return 0
  else
    return 1
  fi
}

# Recursive function to handle parent auto-complete with cascade
# Args: $1 - taskId, $2 - todoFile, $3 - format, $4 - autoCompleteMode, $5 - timestamp, $6 - autoCompletedParentsArrayName
# Returns: 0 on success, updates autoCompletedParents array
cascade_parent_auto_complete() {
  local task_id="$1"
  local todo_file="$2"
  local format="$3"
  local auto_complete_mode="$4"
  local timestamp="$5"
  local auto_completed_parents_array="$6"
  
  # Get parent ID of the current task
  local parent_id
  parent_id=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .parentId // ""' "$todo_file")
  
  # Return if no parent
  [[ -z "$parent_id" || "$parent_id" == "null" ]] && return 0
  
  # Try to auto-complete the parent
  if handle_single_parent_auto_complete "$parent_id" "$task_id" "$todo_file" "$format" "$auto_complete_mode" "$timestamp"; then
    # Add parent to auto-completed list
    eval "$auto_completed_parents_array+=(\"$parent_id\")"
    
    # Recursively check if the grandparent can also be auto-completed
    cascade_parent_auto_complete "$parent_id" "$todo_file" "$format" "$auto_complete_mode" "$timestamp" "$auto_completed_parents_array"
  fi
  
  return 0
}

# Handle parent auto-complete with recursive cascade using SOLID/DRY functions
if [[ "$AUTO_COMPLETE_PARENT" == "true" && "$AUTO_COMPLETE_MODE" != "off" ]]; then
  # Use recursive cascade function to handle all levels of hierarchy
  cascade_parent_auto_complete "$TASK_ID" "$TODO_FILE" "$FORMAT" "$AUTO_COMPLETE_MODE" "$TIMESTAMP" "AUTO_COMPLETED_PARENTS"
fi
# End of refactored parent auto-complete section

# Output based on format
if [[ "$FORMAT" == "json" ]]; then
  # Build JSON output with all completion details
  AUTO_COMPLETED_JSON=$(printf '%s\n' "${AUTO_COMPLETED_PARENTS[@]}" | jq -R . | jq -s .)
  
  jq -n \
    --arg version "${CLEO_VERSION:-unknown}" \
    --arg timestamp "$TIMESTAMP" \
    --arg taskId "$TASK_ID" \
    --arg completedAt "$TIMESTAMP" \
    --arg cycleTime "${CYCLE_TIME_DAYS:-null}" \
    --argjson archived "$ARCHIVED" \
    --argjson focusCleared "$FOCUS_CLEARED" \
    --argjson task "$COMPLETED_TASK" \
    --argjson autoCompletedParents "$AUTO_COMPLETED_JSON" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "format": "json",
        "command": "complete",
        "timestamp": $timestamp,
        "version": $version
      },
      "success": true,
      "taskId": $taskId,
      "completedAt": $completedAt,
      "cycleTimeDays": (if $cycleTime == "null" then null else ($cycleTime | tonumber) end),
      "archived": $archived,
      "focusCleared": $focusCleared,
      "autoCompletedParents": $autoCompletedParents,
      "task": $task
    }'
else
  # Human-readable text output
  log_info "Task $TASK_ID marked as complete"
  echo ""
  echo -e "${BLUE}Task:${NC} $TASK_TITLE"
  echo -e "${BLUE}ID:${NC} $TASK_ID"
  echo -e "${BLUE}Status:${NC} $CURRENT_STATUS → done"
  echo -e "${BLUE}Completed:${NC} $TIMESTAMP"
  if [[ -n "$NOTES" ]]; then
    echo -e "${BLUE}Notes:${NC} $NOTES"
  fi
  if [[ -n "$CYCLE_TIME_DAYS" ]]; then
    echo -e "${BLUE}Cycle Time:${NC} ${CYCLE_TIME_DAYS} days"
  fi
  
  # Show auto-completed parents if any
  if [[ ${#AUTO_COMPLETED_PARENTS[@]} -gt 0 ]]; then
    echo ""
    log_info "Auto-completed parent tasks:"
    for parent_id in "${AUTO_COMPLETED_PARENTS[@]}"; do
      PARENT_TASK=$(jq --arg id "$parent_id" '.tasks[] | select(.id == $id)' "$TODO_FILE")
      PARENT_TITLE=$(echo "$PARENT_TASK" | jq -r '.title')
      echo -e "  ${GREEN}✓${NC} $parent_id - $PARENT_TITLE"
    done
  fi
fi
