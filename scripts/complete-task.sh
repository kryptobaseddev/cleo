#!/usr/bin/env bash
# CLAUDE-TODO Complete Task Script
# Mark a task as complete and optionally trigger archive
set -euo pipefail

TODO_FILE="${TODO_FILE:-.claude/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.claude/todo-config.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_SCRIPT="${SCRIPT_DIR}/log.sh"
ARCHIVE_SCRIPT="${SCRIPT_DIR}/archive.sh"

# Source logging library for should_use_color function
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/logging.sh" ]]; then
  # shellcheck source=../lib/logging.sh
  source "$LIB_DIR/logging.sh"
fi

# Source file operations library for atomic writes with locking
if [[ -f "$LIB_DIR/file-ops.sh" ]]; then
  # shellcheck source=../lib/file-ops.sh
  source "$LIB_DIR/file-ops.sh"
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

usage() {
  cat << EOF
Usage: claude-todo complete TASK_ID [OPTIONS]

Mark a task as complete (status='done') and set completedAt timestamp.

Arguments:
  TASK_ID                 Task ID to complete (e.g., T001)

Options:
  -n, --notes TEXT        Completion notes describing what was done (required)
  --skip-notes            Skip notes requirement (use for quick completions)
  --skip-archive          Don't trigger auto-archive even if configured
  -h, --help              Show this help

Notes Requirement:
  Completion notes are required by default for better task tracking and audit trails.
  Use --skip-notes to bypass this for quick completions.

  Good notes describe: what was done, how it was verified, and any relevant references
  (commit hashes, PR numbers, documentation links).

Examples:
  claude-todo complete T001 --notes "Implemented auth middleware. Tested with unit tests."
  claude-todo complete T042 --notes "Fixed bug #123. PR merged."
  claude-todo complete T042 --skip-notes --skip-archive

After completion, if auto_archive_on_complete is enabled in config,
the archive script will run automatically.
EOF
  exit 0
}

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# Check dependencies
check_deps() {
  if ! command -v jq &> /dev/null; then
    log_error "jq is required but not installed"
    exit 1
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
    -n|--notes)
      NOTES="${2:-}"
      if [[ -z "$NOTES" ]]; then
        log_error "--notes requires a text argument"
        exit 1
      fi
      shift 2
      ;;
    --skip-notes) SKIP_NOTES=true; shift ;;
    --skip-archive) SKIP_ARCHIVE=true; shift ;;
    -*) log_error "Unknown option: $1"; exit 1 ;;
    *) TASK_ID="$1"; shift ;;
  esac
done

# Require notes unless --skip-notes is provided
if [[ -z "$NOTES" && "$SKIP_NOTES" == false ]]; then
  log_error "Completion notes required. Use --notes 'description' or --skip-notes to bypass."
  echo "" >&2
  echo "Example:" >&2
  echo "  claude-todo complete $TASK_ID --notes 'Implemented feature. Tests passing.'" >&2
  echo "  claude-todo complete $TASK_ID --skip-notes" >&2
  exit 1
fi

check_deps

# Validate task ID format
if [[ ! "$TASK_ID" =~ ^T[0-9]{3,}$ ]]; then
  log_error "Invalid task ID format: $TASK_ID (must be T### format)"
  exit 1
fi

# Check files exist
if [[ ! -f "$TODO_FILE" ]]; then
  log_error "$TODO_FILE not found. Run claude-todo init first."
  exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  log_error "$CONFIG_FILE not found. Run claude-todo init first."
  exit 1
fi

# Check for external modifications (informational, not blocking)
# Note: Checksum verification is for audit/detection, not write-gating.
# In multi-writer scenarios (TodoWrite + CLI), external modifications are expected.
CURRENT_CHECKSUM=$(jq -r '._meta.checksum // ""' "$TODO_FILE")
CURRENT_TASKS=$(jq -c '.tasks' "$TODO_FILE")
CALCULATED_CHECKSUM=$(echo "$CURRENT_TASKS" | sha256sum | cut -c1-16)

if [[ -n "$CURRENT_CHECKSUM" && "$CURRENT_CHECKSUM" != "$CALCULATED_CHECKSUM" ]]; then
  log_info "External modification detected (checksum: $CURRENT_CHECKSUM → $CALCULATED_CHECKSUM)"
fi

# Check task exists
TASK=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE")

if [[ -z "$TASK" ]]; then
  log_error "Task $TASK_ID not found"
  exit 1
fi

# Check current status
CURRENT_STATUS=$(echo "$TASK" | jq -r '.status')

if [[ "$CURRENT_STATUS" == "done" ]]; then
  log_warn "Task $TASK_ID is already completed"
  TASK_TITLE=$(echo "$TASK" | jq -r '.title')
  COMPLETED_AT=$(echo "$TASK" | jq -r '.completedAt')
  echo ""
  echo "Task: $TASK_TITLE"
  echo "Completed at: $COMPLETED_AT"
  exit 0
fi

# Validate status transition (pending/active/blocked → done)
if [[ ! "$CURRENT_STATUS" =~ ^(pending|active|blocked)$ ]]; then
  log_error "Invalid status transition: $CURRENT_STATUS → done"
  exit 1
fi

# Create backup before modification
BACKUP_DIR=".claude/.backups"
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="${BACKUP_DIR}/todo.json.$(date +%Y%m%d_%H%M%S)"
cp "$TODO_FILE" "$BACKUP_FILE"
log_info "Backup created: $BACKUP_FILE"

# Rotate old backups (keep max 10)
MAX_COMPLETE_BACKUPS=10
BACKUP_COUNT=$(find "$BACKUP_DIR" -maxdepth 1 -name "todo.json.*" -type f 2>/dev/null | wc -l)

if [[ $BACKUP_COUNT -gt $MAX_COMPLETE_BACKUPS ]]; then
  DELETE_COUNT=$((BACKUP_COUNT - MAX_COMPLETE_BACKUPS))
  log_info "Rotating $DELETE_COUNT old backup(s) (keeping $MAX_COMPLETE_BACKUPS most recent)"

  # Delete oldest backups by modification time
  # Try GNU find first (Linux), fall back to stat-based sorting (macOS)
  if find "$BACKUP_DIR" -maxdepth 1 -name "todo.json.*" -type f -printf '%T@ %p\n' 2>/dev/null | sort -n | head -n "$DELETE_COUNT" | cut -d' ' -f2- | xargs rm -f 2>/dev/null; then
    : # Success with GNU find
  else
    # macOS fallback using stat
    find "$BACKUP_DIR" -maxdepth 1 -name "todo.json.*" -type f 2>/dev/null | while read -r f; do
      echo "$(stat -f %m "$f" 2>/dev/null || echo 0) $f"
    done | sort -n | head -n "$DELETE_COUNT" | cut -d' ' -f2- | xargs rm -f 2>/dev/null || true
  fi
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
    exit 1
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
    exit 1
  }
fi

# Verify UPDATED_TASKS is valid JSON and not empty
if [[ -z "$UPDATED_TASKS" ]]; then
  log_error "Generated empty JSON structure"
  exit 1
fi

if ! echo "$UPDATED_TASKS" | jq empty 2>/dev/null; then
  log_error "Generated invalid JSON structure"
  echo "DEBUG: UPDATED_TASKS content:" >&2
  echo "$UPDATED_TASKS" >&2
  exit 1
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
  exit 1
fi

# Verify task was actually updated
VERIFY_STATUS=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
if [[ "$VERIFY_STATUS" != '"done"' ]]; then
  log_error "Failed to update task status."
  exit 1
fi

# Capture after state
AFTER_STATE=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | {status, completedAt}' "$TODO_FILE")

# Get task details for display
TASK_TITLE=$(jq --arg id "$TASK_ID" -r '.tasks[] | select(.id == $id) | .title' "$TODO_FILE")

log_info "Task $TASK_ID marked as complete"
echo ""
echo -e "${BLUE}Task:${NC} $TASK_TITLE"
echo -e "${BLUE}ID:${NC} $TASK_ID"
echo -e "${BLUE}Status:${NC} $CURRENT_STATUS → done"
echo -e "${BLUE}Completed:${NC} $TIMESTAMP"
if [[ -n "$NOTES" ]]; then
  echo -e "${BLUE}Notes:${NC} $NOTES"
fi

# Log the operation
if [[ -f "$LOG_SCRIPT" ]]; then
  "$LOG_SCRIPT" \
    --action "status_changed" \
    --task-id "$TASK_ID" \
    --before "$BEFORE_STATE" \
    --after "$AFTER_STATE" \
    --details "{\"field\":\"status\",\"operation\":\"complete\"}" \
    --actor "system" 2>/dev/null || log_warn "Failed to write log entry"
fi

# Check if current focus was this task and clear it
CURRENT_FOCUS=$(jq -r '.focus.currentTask // ""' "$TODO_FILE")
if [[ "$CURRENT_FOCUS" == "$TASK_ID" ]]; then
  log_info "Clearing focus from completed task"
  jq '.focus.currentTask = null' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
fi

# Check auto-archive configuration
if [[ "$SKIP_ARCHIVE" == false ]]; then
  AUTO_ARCHIVE=$(jq -r '.archive.auto_archive_on_complete // false' "$CONFIG_FILE")

  if [[ "$AUTO_ARCHIVE" == "true" ]]; then
    echo ""
    log_info "Auto-archive is enabled, checking archive policy..."

    if [[ -f "$ARCHIVE_SCRIPT" ]]; then
      # Run archive script
      "$ARCHIVE_SCRIPT" 2>&1 | sed 's/^/  /' || log_warn "Archive script encountered issues"
    else
      log_warn "Archive script not found at $ARCHIVE_SCRIPT"
    fi
  fi
fi

echo ""
log_info "✓ Task completion successful"
