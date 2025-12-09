#!/usr/bin/env bash
# CLAUDE-TODO Update Task Script
# Update existing task fields with validation and logging
set -uo pipefail

TODO_FILE="${TODO_FILE:-.claude/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.claude/todo-config.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_SCRIPT="${SCRIPT_DIR}/log.sh"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Task ID (required)
TASK_ID=""

# Update fields (empty = no change)
NEW_TITLE=""
NEW_STATUS=""
NEW_PRIORITY=""
NEW_DESCRIPTION=""
NEW_PHASE=""
NEW_BLOCKED_BY=""

# Array operations: append (default) vs set (replace) vs clear
LABELS_TO_ADD=""
LABELS_TO_SET=""
CLEAR_LABELS=false

FILES_TO_ADD=""
FILES_TO_SET=""
CLEAR_FILES=false

ACCEPTANCE_TO_ADD=""
ACCEPTANCE_TO_SET=""
CLEAR_ACCEPTANCE=false

DEPENDS_TO_ADD=""
DEPENDS_TO_SET=""
CLEAR_DEPENDS=false

NOTE_TO_ADD=""

usage() {
  cat << 'EOF'
Usage: update-task.sh TASK_ID [OPTIONS]

Update an existing task's fields.

Arguments:
  TASK_ID               Task ID to update (e.g., T001)

Scalar Field Options:
  --title "New title"   Update task title
  --status STATUS       Change status (pending|active|blocked)
                        Note: Use 'complete-task.sh' for done status
  --priority PRIORITY   Update priority (critical|high|medium|low)
  --description DESC    Update description
  --phase PHASE         Update phase slug
  --blocked-by REASON   Set blocked reason (status becomes blocked)

Array Field Options (append by default):
  --labels LABELS       Append comma-separated labels
  --set-labels LABELS   Replace all labels with these
  --clear-labels        Remove all labels

  --files FILES         Append comma-separated file paths
  --set-files FILES     Replace all files with these
  --clear-files         Remove all files

  --acceptance CRIT     Append comma-separated acceptance criteria
  --set-acceptance CRIT Replace all acceptance criteria
  --clear-acceptance    Remove all acceptance criteria

  --depends IDS         Append comma-separated task IDs
  --set-depends IDS     Replace all dependencies
  --clear-depends       Remove all dependencies

  --notes NOTE          Add a timestamped note (appends only)

General Options:
  -h, --help            Show this help

Examples:
  update-task.sh T001 --priority high
  update-task.sh T002 --labels bug,urgent --status active
  update-task.sh T003 --set-labels "frontend,ui" --clear-files
  update-task.sh T004 --blocked-by "Waiting for API spec"
  update-task.sh T005 --notes "Started implementation"

Exit Codes:
  0 = Success
  1 = Invalid arguments or validation failure
  2 = File operation failure
EOF
  exit 0
}

log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }

check_deps() {
  if ! command -v jq &> /dev/null; then
    log_error "jq is required but not installed"
    exit 1
  fi
}

# Validate status
validate_status() {
  local status="$1"
  case "$status" in
    pending|active|blocked)
      return 0
      ;;
    done)
      log_error "Use 'complete-task.sh' to mark tasks as done"
      return 1
      ;;
    *)
      log_error "Invalid status: $status (must be pending|active|blocked)"
      return 1
      ;;
  esac
}

# Validate priority
validate_priority() {
  local priority="$1"
  case "$priority" in
    critical|high|medium|low)
      return 0
      ;;
    *)
      log_error "Invalid priority: $priority (must be critical|high|medium|low)"
      return 1
      ;;
  esac
}

# Validate title
validate_title() {
  local title="$1"
  if [[ -z "$title" ]]; then
    log_error "Task title cannot be empty"
    return 1
  fi
  if [[ ${#title} -gt 120 ]]; then
    log_error "Task title too long (max 120 chars, got ${#title})"
    return 1
  fi
  return 0
}

# Validate phase format
validate_phase() {
  local phase="$1"
  if [[ -z "$phase" ]]; then
    return 0
  fi
  if ! [[ "$phase" =~ ^[a-z][a-z0-9-]*$ ]]; then
    log_error "Invalid phase format: $phase (must be lowercase alphanumeric with hyphens)"
    return 1
  fi
  # Check if phase exists in todo.json
  if [[ -f "$TODO_FILE" ]]; then
    local phase_exists
    phase_exists=$(jq --arg phase "$phase" '.phases | has($phase)' "$TODO_FILE")
    if [[ "$phase_exists" != "true" ]]; then
      log_error "Phase '$phase' not found in phases definition"
      return 1
    fi
  fi
  return 0
}

# Validate labels format
validate_labels() {
  local labels="$1"
  if [[ -z "$labels" ]]; then
    return 0
  fi
  IFS=',' read -ra label_array <<< "$labels"
  for label in "${label_array[@]}"; do
    label=$(echo "$label" | xargs)
    if ! [[ "$label" =~ ^[a-z][a-z0-9-]*$ ]]; then
      log_error "Invalid label format: '$label' (must be lowercase alphanumeric with hyphens)"
      return 1
    fi
  done
  return 0
}

# Validate dependency IDs exist
validate_depends() {
  local depends="$1"
  if [[ -z "$depends" ]]; then
    return 0
  fi
  if [[ ! -f "$TODO_FILE" ]]; then
    log_error "Cannot validate dependencies: $TODO_FILE not found"
    return 1
  fi
  IFS=',' read -ra dep_array <<< "$depends"
  local existing_ids
  existing_ids=$(jq -r '[.tasks[].id] | @json' "$TODO_FILE")

  for dep_id in "${dep_array[@]}"; do
    dep_id=$(echo "$dep_id" | xargs)
    if ! [[ "$dep_id" =~ ^T[0-9]{3,}$ ]]; then
      log_error "Invalid dependency ID format: '$dep_id' (must be T### format)"
      return 1
    fi
    # Don't allow self-dependency
    if [[ "$dep_id" == "$TASK_ID" ]]; then
      log_error "Task cannot depend on itself: $dep_id"
      return 1
    fi
    local exists
    exists=$(echo "$existing_ids" | jq --arg id "$dep_id" 'index($id) != null')
    if [[ "$exists" != "true" ]]; then
      log_error "Dependency task not found: $dep_id"
      return 1
    fi
  done
  return 0
}

# Atomic file write with backup
atomic_write() {
  local file="$1"
  local content="$2"
  local backup_dir=".claude/.backups"

  mkdir -p "$backup_dir" || {
    log_error "Failed to create backup directory: $backup_dir"
    return 1
  }

  if [[ -f "$file" ]]; then
    local backup_file="${backup_dir}/$(basename "$file").$(date +%s).bak"
    cp "$file" "$backup_file" || {
      log_error "Failed to create backup: $backup_file"
      return 1
    }
    # Keep only last 10 backups
    local backup_count
    backup_count=$(find "$backup_dir" -name "$(basename "$file").*.bak" 2>/dev/null | wc -l)
    if [[ "$backup_count" -gt 10 ]]; then
      find "$backup_dir" -name "$(basename "$file").*.bak" -type f | sort | head -n -10 | xargs rm -f
    fi
  fi

  local temp_file="${file}.tmp"
  echo "$content" > "$temp_file" || {
    log_error "Failed to write temp file: $temp_file"
    return 1
  }

  if ! jq empty "$temp_file" 2>/dev/null; then
    log_error "Generated invalid JSON"
    rm -f "$temp_file"
    return 1
  fi

  mv "$temp_file" "$file" || {
    log_error "Failed to move temp file to $file"
    rm -f "$temp_file"
    return 1
  }

  return 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --title)
      NEW_TITLE="$2"
      shift 2
      ;;
    --status)
      NEW_STATUS="$2"
      shift 2
      ;;
    --priority)
      NEW_PRIORITY="$2"
      shift 2
      ;;
    --description)
      NEW_DESCRIPTION="$2"
      shift 2
      ;;
    --phase)
      NEW_PHASE="$2"
      shift 2
      ;;
    --blocked-by)
      NEW_BLOCKED_BY="$2"
      shift 2
      ;;
    # Labels
    --labels)
      LABELS_TO_ADD="$2"
      shift 2
      ;;
    --set-labels)
      LABELS_TO_SET="$2"
      shift 2
      ;;
    --clear-labels)
      CLEAR_LABELS=true
      shift
      ;;
    # Files
    --files)
      FILES_TO_ADD="$2"
      shift 2
      ;;
    --set-files)
      FILES_TO_SET="$2"
      shift 2
      ;;
    --clear-files)
      CLEAR_FILES=true
      shift
      ;;
    # Acceptance
    --acceptance)
      ACCEPTANCE_TO_ADD="$2"
      shift 2
      ;;
    --set-acceptance)
      ACCEPTANCE_TO_SET="$2"
      shift 2
      ;;
    --clear-acceptance)
      CLEAR_ACCEPTANCE=true
      shift
      ;;
    # Depends
    --depends)
      DEPENDS_TO_ADD="$2"
      shift 2
      ;;
    --set-depends)
      DEPENDS_TO_SET="$2"
      shift 2
      ;;
    --clear-depends)
      CLEAR_DEPENDS=true
      shift
      ;;
    # Notes
    --notes)
      NOTE_TO_ADD="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    -*)
      log_error "Unknown option: $1"
      echo "Use --help for usage information" >&2
      exit 1
      ;;
    *)
      if [[ -z "$TASK_ID" ]]; then
        TASK_ID="$1"
      else
        log_error "Unexpected argument: $1"
        exit 1
      fi
      shift
      ;;
  esac
done

# Main execution
check_deps

# Validate task ID provided
if [[ -z "$TASK_ID" ]]; then
  log_error "Task ID is required"
  echo "Usage: update-task.sh TASK_ID [OPTIONS]" >&2
  echo "Use --help for more information" >&2
  exit 1
fi

# Validate task ID format
if [[ ! "$TASK_ID" =~ ^T[0-9]{3,}$ ]]; then
  log_error "Invalid task ID format: $TASK_ID (must be T### format)"
  exit 1
fi

# Check todo file exists
if [[ ! -f "$TODO_FILE" ]]; then
  log_error "Todo file not found: $TODO_FILE"
  echo "Run init.sh first to initialize the todo system" >&2
  exit 1
fi

# Check task exists
TASK=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE")
if [[ -z "$TASK" ]]; then
  log_error "Task $TASK_ID not found"
  exit 1
fi

# Get current status for transition validation
CURRENT_STATUS=$(echo "$TASK" | jq -r '.status')

# Check if task is already done
if [[ "$CURRENT_STATUS" == "done" ]]; then
  log_error "Cannot update completed task $TASK_ID"
  log_info "Completed tasks are immutable. Create a new task if needed."
  exit 1
fi

# Validate inputs
[[ -n "$NEW_TITLE" ]] && { validate_title "$NEW_TITLE" || exit 1; }
[[ -n "$NEW_STATUS" ]] && { validate_status "$NEW_STATUS" || exit 1; }
[[ -n "$NEW_PRIORITY" ]] && { validate_priority "$NEW_PRIORITY" || exit 1; }
[[ -n "$NEW_PHASE" ]] && { validate_phase "$NEW_PHASE" || exit 1; }
[[ -n "$LABELS_TO_ADD" ]] && { validate_labels "$LABELS_TO_ADD" || exit 1; }
[[ -n "$LABELS_TO_SET" ]] && { validate_labels "$LABELS_TO_SET" || exit 1; }
[[ -n "$DEPENDS_TO_ADD" ]] && { validate_depends "$DEPENDS_TO_ADD" || exit 1; }
[[ -n "$DEPENDS_TO_SET" ]] && { validate_depends "$DEPENDS_TO_SET" || exit 1; }

# Check if any update requested
if [[ -z "$NEW_TITLE" && -z "$NEW_STATUS" && -z "$NEW_PRIORITY" && \
      -z "$NEW_DESCRIPTION" && -z "$NEW_PHASE" && -z "$NEW_BLOCKED_BY" && \
      -z "$LABELS_TO_ADD" && -z "$LABELS_TO_SET" && "$CLEAR_LABELS" == false && \
      -z "$FILES_TO_ADD" && -z "$FILES_TO_SET" && "$CLEAR_FILES" == false && \
      -z "$ACCEPTANCE_TO_ADD" && -z "$ACCEPTANCE_TO_SET" && "$CLEAR_ACCEPTANCE" == false && \
      -z "$DEPENDS_TO_ADD" && -z "$DEPENDS_TO_SET" && "$CLEAR_DEPENDS" == false && \
      -z "$NOTE_TO_ADD" ]]; then
  log_error "No updates specified"
  echo "Use --help to see available options" >&2
  exit 1
fi

# Check single active task constraint
if [[ "$NEW_STATUS" == "active" && "$CURRENT_STATUS" != "active" ]]; then
  active_count=$(jq '[.tasks[] | select(.status == "active")] | length' "$TODO_FILE")
  if [[ "$active_count" -gt 0 ]]; then
    log_error "Cannot set status to active: only ONE active task allowed"
    echo "Current active task: $(jq -r '[.tasks[] | select(.status == "active")][0].id' "$TODO_FILE")" >&2
    exit 1
  fi
fi

# Capture before state for logging
BEFORE_STATE=$(echo "$TASK" | jq '{
  title, status, priority, description, phase,
  labels, files, acceptance, depends, blockedBy
}')

# Build changes list for display
CHANGES=()

# Create timestamp
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build the jq update expression dynamically
JQ_UPDATES=""

# Scalar fields
if [[ -n "$NEW_TITLE" ]]; then
  JQ_UPDATES="$JQ_UPDATES | .title = \$new_title"
  CHANGES+=("title: '$(echo "$TASK" | jq -r '.title')' → '$NEW_TITLE'")
fi

if [[ -n "$NEW_STATUS" ]]; then
  JQ_UPDATES="$JQ_UPDATES | .status = \$new_status"
  CHANGES+=("status: $CURRENT_STATUS → $NEW_STATUS")
fi

if [[ -n "$NEW_PRIORITY" ]]; then
  OLD_PRIORITY=$(echo "$TASK" | jq -r '.priority // "medium"')
  JQ_UPDATES="$JQ_UPDATES | .priority = \$new_priority"
  CHANGES+=("priority: $OLD_PRIORITY → $NEW_PRIORITY")
fi

if [[ -n "$NEW_DESCRIPTION" ]]; then
  JQ_UPDATES="$JQ_UPDATES | .description = \$new_description"
  CHANGES+=("description: updated")
fi

if [[ -n "$NEW_PHASE" ]]; then
  OLD_PHASE=$(echo "$TASK" | jq -r '.phase // "(none)"')
  JQ_UPDATES="$JQ_UPDATES | .phase = \$new_phase"
  CHANGES+=("phase: $OLD_PHASE → $NEW_PHASE")
fi

if [[ -n "$NEW_BLOCKED_BY" ]]; then
  JQ_UPDATES="$JQ_UPDATES | .blockedBy = \$new_blocked_by | .status = \"blocked\""
  CHANGES+=("blockedBy: set to '$NEW_BLOCKED_BY'")
  CHANGES+=("status: $CURRENT_STATUS → blocked")
fi

# Labels array
if [[ "$CLEAR_LABELS" == true ]]; then
  JQ_UPDATES="$JQ_UPDATES | del(.labels)"
  CHANGES+=("labels: cleared")
elif [[ -n "$LABELS_TO_SET" ]]; then
  IFS=',' read -ra label_array <<< "$LABELS_TO_SET"
  labels_json=$(printf '%s\n' "${label_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  JQ_UPDATES="$JQ_UPDATES | .labels = $labels_json"
  CHANGES+=("labels: replaced with [$LABELS_TO_SET]")
elif [[ -n "$LABELS_TO_ADD" ]]; then
  IFS=',' read -ra label_array <<< "$LABELS_TO_ADD"
  labels_json=$(printf '%s\n' "${label_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  JQ_UPDATES="$JQ_UPDATES | .labels = ((.labels // []) + $labels_json | unique)"
  CHANGES+=("labels: added [$LABELS_TO_ADD]")
fi

# Files array
if [[ "$CLEAR_FILES" == true ]]; then
  JQ_UPDATES="$JQ_UPDATES | del(.files)"
  CHANGES+=("files: cleared")
elif [[ -n "$FILES_TO_SET" ]]; then
  IFS=',' read -ra files_array <<< "$FILES_TO_SET"
  files_json=$(printf '%s\n' "${files_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  JQ_UPDATES="$JQ_UPDATES | .files = $files_json"
  CHANGES+=("files: replaced")
elif [[ -n "$FILES_TO_ADD" ]]; then
  IFS=',' read -ra files_array <<< "$FILES_TO_ADD"
  files_json=$(printf '%s\n' "${files_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  JQ_UPDATES="$JQ_UPDATES | .files = ((.files // []) + $files_json | unique)"
  CHANGES+=("files: added [$FILES_TO_ADD]")
fi

# Acceptance array
if [[ "$CLEAR_ACCEPTANCE" == true ]]; then
  JQ_UPDATES="$JQ_UPDATES | del(.acceptance)"
  CHANGES+=("acceptance: cleared")
elif [[ -n "$ACCEPTANCE_TO_SET" ]]; then
  IFS=',' read -ra acc_array <<< "$ACCEPTANCE_TO_SET"
  acc_json=$(printf '%s\n' "${acc_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  JQ_UPDATES="$JQ_UPDATES | .acceptance = $acc_json"
  CHANGES+=("acceptance: replaced")
elif [[ -n "$ACCEPTANCE_TO_ADD" ]]; then
  IFS=',' read -ra acc_array <<< "$ACCEPTANCE_TO_ADD"
  acc_json=$(printf '%s\n' "${acc_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  JQ_UPDATES="$JQ_UPDATES | .acceptance = ((.acceptance // []) + $acc_json)"
  CHANGES+=("acceptance: added criteria")
fi

# Depends array
if [[ "$CLEAR_DEPENDS" == true ]]; then
  JQ_UPDATES="$JQ_UPDATES | del(.depends)"
  CHANGES+=("depends: cleared")
elif [[ -n "$DEPENDS_TO_SET" ]]; then
  IFS=',' read -ra dep_array <<< "$DEPENDS_TO_SET"
  dep_json=$(printf '%s\n' "${dep_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  JQ_UPDATES="$JQ_UPDATES | .depends = $dep_json"
  CHANGES+=("depends: replaced with [$DEPENDS_TO_SET]")
elif [[ -n "$DEPENDS_TO_ADD" ]]; then
  IFS=',' read -ra dep_array <<< "$DEPENDS_TO_ADD"
  dep_json=$(printf '%s\n' "${dep_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  JQ_UPDATES="$JQ_UPDATES | .depends = ((.depends // []) + $dep_json | unique)"
  CHANGES+=("depends: added [$DEPENDS_TO_ADD]")
fi

# Notes (always append with timestamp)
if [[ -n "$NOTE_TO_ADD" ]]; then
  timestamp_note="$(date -u +"%Y-%m-%d %H:%M:%S UTC"): $NOTE_TO_ADD"
  JQ_UPDATES="$JQ_UPDATES | .notes = ((.notes // []) + [\"$timestamp_note\"])"
  CHANGES+=("notes: added entry")
fi

# Strip leading pipe if present
JQ_UPDATES="${JQ_UPDATES# | }"

# Perform the update
UPDATED_TODO=$(jq --arg id "$TASK_ID" \
  --arg new_title "$NEW_TITLE" \
  --arg new_status "$NEW_STATUS" \
  --arg new_priority "$NEW_PRIORITY" \
  --arg new_description "$NEW_DESCRIPTION" \
  --arg new_phase "$NEW_PHASE" \
  --arg new_blocked_by "$NEW_BLOCKED_BY" \
  --arg ts "$TIMESTAMP" "
  .tasks |= map(
    if .id == \$id then
      $JQ_UPDATES
    else . end
  ) |
  .lastUpdated = \$ts
" "$TODO_FILE")

# Recalculate checksum
NEW_TASKS=$(echo "$UPDATED_TODO" | jq -c '.tasks')
NEW_CHECKSUM=$(echo "$NEW_TASKS" | sha256sum | cut -c1-16)

FINAL_JSON=$(echo "$UPDATED_TODO" | jq --arg checksum "$NEW_CHECKSUM" '
  ._meta.checksum = $checksum
')

# Atomic write
if ! atomic_write "$TODO_FILE" "$FINAL_JSON"; then
  log_error "Failed to write todo file"
  exit 2
fi

# Capture after state
AFTER_STATE=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | {
  title, status, priority, description, phase,
  labels, files, acceptance, depends, blockedBy
}' "$TODO_FILE")

# Log the operation
if [[ -f "$LOG_SCRIPT" ]]; then
  "$LOG_SCRIPT" \
    --action "task_updated" \
    --task-id "$TASK_ID" \
    --before "$BEFORE_STATE" \
    --after "$AFTER_STATE" \
    --details '{"operation":"update"}' \
    --actor "system" 2>/dev/null || log_warn "Failed to write log entry"
fi

# Success output
log_info "Task $TASK_ID updated successfully"
echo ""
echo -e "${BLUE}Task ID:${NC} $TASK_ID"
echo -e "${BLUE}Changes:${NC}"
for change in "${CHANGES[@]}"; do
  echo "  • $change"
done
echo ""
echo "View with: jq '.tasks[] | select(.id == \"$TASK_ID\")' $TODO_FILE"

exit 0
