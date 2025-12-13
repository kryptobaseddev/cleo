#!/usr/bin/env bash
# CLAUDE-TODO Add Task Script
# Add new task to todo.json with validation and logging
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TODO_FILE="${TODO_FILE:-.claude/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.claude/todo-config.json}"
LOG_FILE="${LOG_FILE:-.claude/todo-log.json}"

# Source logging library for should_use_color function
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/logging.sh" ]]; then
  # shellcheck source=../lib/logging.sh
  source "$LIB_DIR/logging.sh"
fi

# Source validation library for circular dependency check
if [[ -f "$LIB_DIR/validation.sh" ]]; then
  # shellcheck source=../lib/validation.sh
  source "$LIB_DIR/validation.sh"
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
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' NC=''
fi

# Defaults
STATUS="pending"
PRIORITY="medium"
DESCRIPTION=""
LABELS=""
PHASE=""
FILES=""
ACCEPTANCE=""
DEPENDS=""
NOTES=""
QUIET=false
ADD_PHASE=false

usage() {
  cat << 'EOF'
Usage: claude-todo add "Task Title" [OPTIONS]

Add a new task to todo.json with validation.

Arguments:
  TITLE                 Task title (required, action-oriented)

Options:
  -s, --status STATUS       Task status (pending|active|blocked|done)
                            Default: pending
  -p, --priority PRIORITY   Task priority (critical|high|medium|low)
                            Default: medium
  -d, --description DESC    Detailed description
  -l, --labels LABELS       Comma-separated labels (e.g., bug,security)
  -P, --phase PHASE         Phase slug (must exist in phases)
      --add-phase           Create new phase if it doesn't exist
      --files FILES         Comma-separated file paths
      --acceptance CRITERIA Comma-separated acceptance criteria
  -D, --depends IDS         Comma-separated task IDs (e.g., T001,T002)
      --notes NOTE          Initial note entry
  -q, --quiet               Suppress messages, output only task ID
  -h, --help                Show this help

Examples:
  claude-todo add "Implement authentication"
  claude-todo add "Fix login bug" -p high -l bug,security
  claude-todo add "Add tests" -D T001,T002 -P testing
  claude-todo add "Add tests" -P new-phase --add-phase
  claude-todo add "Implement auth" --acceptance "User can login,Session persists"
  claude-todo add "Quick task" -q  # Outputs only: T042

Exit Codes:
  0 = Success
  1 = Invalid arguments or validation failure
  2 = File operation failure
EOF
  exit 0
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1" >&2
}

log_warn() {
  if [[ "$QUIET" != "true" ]]; then
    echo -e "${YELLOW}[WARN]${NC} $1"
  fi
}

log_info() {
  if [[ "$QUIET" != "true" ]]; then
    echo -e "${GREEN}[INFO]${NC} $1"
  fi
}

check_deps() {
  if ! command -v jq &> /dev/null; then
    log_error "jq is required but not installed"
    echo "Install: sudo apt-get install jq  # Debian/Ubuntu" >&2
    echo "         brew install jq          # macOS" >&2
    exit 1
  fi
}

# Generate unique task ID with file locking to prevent race conditions
# Arguments:
#   $1 - lock_fd variable name (lock must be held by caller)
# Returns:
#   Task ID string (T###)
# Notes:
#   CRITICAL: Caller MUST hold lock on TODO_FILE before calling
#   This prevents concurrent ID generation race conditions
generate_task_id() {
  local existing_ids
  existing_ids=$(jq -r '[.tasks[].id] | @json' "$TODO_FILE" 2>/dev/null || echo '[]')

  local max_id
  max_id=$(echo "$existing_ids" | jq -r '.[] | ltrimstr("T") | tonumber' | sort -n | tail -1)

  if [[ -z "$max_id" ]] || [[ "$max_id" == "null" ]]; then
    max_id=0
  fi

  local next_id=$((max_id + 1))
  printf "T%03d" "$next_id"
}

# Validate task title (local wrapper - calls lib/validation.sh function)
validate_title_local() {
  local title="$1"

  # Call the shared validation function from lib/validation.sh
  if ! validate_title "$title"; then
    return 1
  fi

  # Check for duplicate title (warning only)
  if [[ -f "$TODO_FILE" ]]; then
    local duplicate_count
    duplicate_count=$(jq --arg title "$title" '[.tasks[] | select(.title == $title)] | length' "$TODO_FILE")
    if [[ "$duplicate_count" -gt 0 ]]; then
      log_warn "Duplicate title detected: '$title' already exists"
    fi
  fi

  return 0
}

# Validate status
validate_status() {
  local status="$1"
  case "$status" in
    pending|active|blocked|done)
      return 0
      ;;
    *)
      log_error "Invalid status: $status (must be pending|active|blocked|done)"
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

# Validate phase exists or create if --add-phase flag is set
validate_phase() {
  local phase="$1"

  if [[ -z "$phase" ]]; then
    return 0  # Phase is optional
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
      # If --add-phase flag is set, we'll create it later
      if [[ "$ADD_PHASE" == "true" ]]; then
        return 0
      fi

      # Get list of valid phases for error message
      local valid_phases
      valid_phases=$(jq -r '.phases | keys | join(", ")' "$TODO_FILE")

      if [[ -n "$valid_phases" && "$valid_phases" != "null" ]]; then
        log_error "Phase '$phase' not found. Valid phases: $valid_phases. Use --add-phase to create new."
      else
        log_error "Phase '$phase' not found. No phases defined yet. Use --add-phase to create new."
      fi
      return 1
    fi
  fi

  return 0
}

# Add a new phase to todo.json
add_new_phase() {
  local phase="$1"

  if [[ ! -f "$TODO_FILE" ]]; then
    return 0
  fi

  # Check if phase already exists
  local phase_exists
  phase_exists=$(jq --arg phase "$phase" '.phases | has($phase)' "$TODO_FILE")
  if [[ "$phase_exists" == "true" ]]; then
    return 0  # Already exists, nothing to do
  fi

  # Get next order number
  local next_order
  next_order=$(jq '[.phases[].order // 0] | max + 1' "$TODO_FILE")
  if [[ "$next_order" == "null" || -z "$next_order" ]]; then
    next_order=1
  fi

  # Create phase name from slug (capitalize first letter of each word)
  local phase_name
  phase_name=$(echo "$phase" | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) tolower(substr($i,2))}1')

  # Add phase to todo.json
  local updated_content
  updated_content=$(jq --arg phase "$phase" \
                       --arg name "$phase_name" \
                       --argjson order "$next_order" \
                       '.phases[$phase] = {name: $name, order: $order}' \
                       "$TODO_FILE")

  # Save using atomic write
  save_json "$TODO_FILE" "$updated_content"

  if [[ "$QUIET" != "true" ]]; then
    log_info "Created new phase: $phase ($phase_name)"
  fi
}

# Validate labels format
validate_labels() {
  local labels="$1"

  if [[ -z "$labels" ]]; then
    return 0
  fi

  IFS=',' read -ra label_array <<< "$labels"
  for label in "${label_array[@]}"; do
    label=$(echo "$label" | xargs)  # Trim whitespace
    if ! [[ "$label" =~ ^[a-z][a-z0-9.-]*$ ]]; then
      log_error "Invalid label format: '$label' (must be lowercase alphanumeric with hyphens/periods, e.g., bug, v0.5.0)"
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
    dep_id=$(echo "$dep_id" | xargs)  # Trim whitespace

    if ! [[ "$dep_id" =~ ^T[0-9]{3,}$ ]]; then
      log_error "Invalid dependency ID format: '$dep_id' (must be T### format)"
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

# Update checksum using library's save_json with file locking
update_checksum() {
  local file="$1"
  local checksum
  checksum=$(jq -c '.tasks' "$file" | sha256sum | cut -c1-16)

  local updated_content
  updated_content=$(jq --arg cs "$checksum" '._meta.checksum = $cs' "$file")

  save_json "$file" "$updated_content"
}

# Log operation to todo-log.json
log_operation() {
  local operation="$1"
  local task_id="$2"
  local details="$3"

  if [[ ! -f "$LOG_FILE" ]]; then
    echo '{"entries":[]}' > "$LOG_FILE"
  fi

  local log_id
  log_id="log-$(date +%s)-$(openssl rand -hex 3 2>/dev/null || echo $RANDOM)"

  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local log_entry
  log_entry=$(jq -n \
    --arg id "$log_id" \
    --arg ts "$timestamp" \
    --arg op "$operation" \
    --arg task_id "$task_id" \
    --argjson details "$details" \
    '{
      id: $id,
      timestamp: $ts,
      operation: $op,
      task_id: $task_id,
      user: "system",
      details: $details,
      before: null,
      after: $details
    }')

  local updated_log
  updated_log=$(jq --argjson entry "$log_entry" '.entries += [$entry]' "$LOG_FILE")

  echo "$updated_log" > "$LOG_FILE"
}

# Parse arguments
TITLE=""
while [[ $# -gt 0 ]]; do
  case $1 in
    -s|--status)
      STATUS="$2"
      shift 2
      ;;
    -p|--priority)
      PRIORITY="$2"
      shift 2
      ;;
    -d|--description)
      DESCRIPTION="$2"
      shift 2
      ;;
    -l|--labels)
      LABELS="$2"
      shift 2
      ;;
    -P|--phase)
      PHASE="$2"
      shift 2
      ;;
    --add-phase)
      ADD_PHASE=true
      shift
      ;;
    --files)
      FILES="$2"
      shift 2
      ;;
    --acceptance)
      ACCEPTANCE="$2"
      shift 2
      ;;
    -D|--depends)
      DEPENDS="$2"
      shift 2
      ;;
    --notes)
      NOTES="$2"
      shift 2
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
      echo "Use --help for usage information" >&2
      exit 1
      ;;
    *)
      if [[ -z "$TITLE" ]]; then
        TITLE="$1"
      else
        log_error "Multiple titles provided. Quote the title if it contains spaces."
        exit 1
      fi
      shift
      ;;
  esac
done

# Main execution
check_deps

# Validate required arguments
if [[ -z "$TITLE" ]]; then
  log_error "Task title is required"
  echo "Usage: claude-todo add \"Task Title\" [OPTIONS]" >&2
  echo "Use --help for more information" >&2
  exit 1
fi

# Normalize labels to remove duplicates
if [[ -n "$LABELS" ]]; then
  LABELS=$(normalize_labels "$LABELS")
fi

# Validate inputs
validate_title_local "$TITLE" || exit 1
validate_status "$STATUS" || exit 1
validate_priority "$PRIORITY" || exit 1
validate_phase "$PHASE" || exit 1
validate_labels "$LABELS" || exit 1
validate_depends "$DEPENDS" || exit 1

# Add new phase if --add-phase flag is set and phase doesn't exist
if [[ "$ADD_PHASE" == "true" ]] && [[ -n "$PHASE" ]]; then
  add_new_phase "$PHASE"
fi

# Check for circular dependencies if dependencies are specified
if [[ -n "$DEPENDS" ]]; then
  # Generate a temporary task ID for validation
  TEMP_TASK_ID=$(generate_task_id)
  if ! check_circular_dependencies "$TODO_FILE" "$TEMP_TASK_ID" "$DEPENDS"; then
    log_error "Cannot add task: would create circular dependency"
    exit 1
  fi
fi

# Check if blocked status has blocker reason
if [[ "$STATUS" == "blocked" ]] && [[ -z "$DESCRIPTION" ]]; then
  log_error "Blocked tasks require --description to specify blocker reason"
  exit 1
fi

# Check if todo.json exists
if [[ ! -f "$TODO_FILE" ]]; then
  log_error "Todo file not found: $TODO_FILE"
  echo "Run claude-todo init first to initialize the todo system" >&2
  exit 1
fi

# Check if active status and there's already an active task
if [[ "$STATUS" == "active" ]]; then
  active_count=$(jq '[.tasks[] | select(.status == "active")] | length' "$TODO_FILE")
  if [[ "$active_count" -gt 0 ]]; then
    log_error "Cannot create active task: only ONE active task allowed"
    echo "Current active task: $(jq -r '[.tasks[] | select(.status == "active")][0].id' "$TODO_FILE")" >&2
    exit 1
  fi
fi

# CRITICAL: Acquire lock BEFORE ID generation to prevent race conditions
# Lock protects the entire ID generation → task creation sequence
ADD_LOCK_FD=""
if ! lock_file "$TODO_FILE" ADD_LOCK_FD 30; then
  log_error "Cannot acquire lock for task creation (another process may be adding a task)"
  echo "Try again in a moment or check for stuck processes" >&2
  exit 2
fi

# Set up trap to ensure lock is released on exit/error
# shellcheck disable=SC2064
trap "unlock_file $ADD_LOCK_FD" EXIT ERR INT TERM

# Generate task ID (lock is now held, preventing concurrent ID collisions)
TASK_ID=$(generate_task_id)
log_info "Generated task ID: $TASK_ID"

# Create timestamp
CREATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build task object
TASK_JSON=$(jq -n \
  --arg id "$TASK_ID" \
  --arg title "$TITLE" \
  --arg status "$STATUS" \
  --arg priority "$PRIORITY" \
  --arg created "$CREATED_AT" \
  '{
    id: $id,
    title: $title,
    status: $status,
    priority: $priority,
    createdAt: $created
  }')

# Add optional fields
if [[ -n "$PHASE" ]]; then
  TASK_JSON=$(echo "$TASK_JSON" | jq --arg phase "$PHASE" '.phase = $phase')
fi

if [[ -n "$DESCRIPTION" ]]; then
  TASK_JSON=$(echo "$TASK_JSON" | jq --arg desc "$DESCRIPTION" '.description = $desc')
fi

if [[ -n "$LABELS" ]]; then
  IFS=',' read -ra label_array <<< "$LABELS"
  labels_json=$(printf '%s\n' "${label_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  TASK_JSON=$(echo "$TASK_JSON" | jq --argjson labels "$labels_json" '.labels = $labels')
fi

if [[ -n "$FILES" ]]; then
  IFS=',' read -ra files_array <<< "$FILES"
  files_json=$(printf '%s\n' "${files_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  TASK_JSON=$(echo "$TASK_JSON" | jq --argjson files "$files_json" '.files = $files')
fi

if [[ -n "$ACCEPTANCE" ]]; then
  IFS=',' read -ra acc_array <<< "$ACCEPTANCE"
  acc_json=$(printf '%s\n' "${acc_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  TASK_JSON=$(echo "$TASK_JSON" | jq --argjson acc "$acc_json" '.acceptance = $acc')
fi

if [[ -n "$DEPENDS" ]]; then
  IFS=',' read -ra dep_array <<< "$DEPENDS"
  dep_json=$(printf '%s\n' "${dep_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  TASK_JSON=$(echo "$TASK_JSON" | jq --argjson deps "$dep_json" '.depends = $deps')
fi

if [[ -n "$NOTES" ]]; then
  timestamp_note="$(date -u +"%Y-%m-%d %H:%M:%S UTC"): $NOTES"
  TASK_JSON=$(echo "$TASK_JSON" | jq --arg note "$timestamp_note" '.notes = [$note]')
fi

if [[ "$STATUS" == "blocked" ]]; then
  TASK_JSON=$(echo "$TASK_JSON" | jq --arg reason "$DESCRIPTION" '.blockedBy = $reason')
fi

if [[ "$STATUS" == "done" ]]; then
  TASK_JSON=$(echo "$TASK_JSON" | jq --arg completed "$CREATED_AT" '.completedAt = $completed')
fi

# Add task to todo.json and calculate checksum
# Calculate checksum before adding to JSON (while still holding lock)
CHECKSUM=$(jq -c --argjson task "$TASK_JSON" '.tasks + [$task]' "$TODO_FILE" | sha256sum | cut -c1-16)

# Add task with updated checksum and timestamp
UPDATED_TODO=$(jq \
  --argjson task "$TASK_JSON" \
  --arg cs "$CHECKSUM" \
  '.tasks += [$task] | ._meta.checksum = $cs | .lastUpdated = (now | strftime("%Y-%m-%dT%H:%M:%SZ"))' \
  "$TODO_FILE")

# Write atomically (we already hold the lock, so we can't use save_json which would deadlock)
# Instead, use the same atomic pattern save_json uses but without re-acquiring the lock
TEMP_FILE="${TODO_FILE}${TEMP_SUFFIX}"

# Validate JSON before writing
if ! echo "$UPDATED_TODO" | jq empty 2>/dev/null; then
  log_error "Generated invalid JSON content"
  unlock_file "$ADD_LOCK_FD"
  exit 2
fi

# Backup original file
BACKUP_FILE=""
if [[ -f "$TODO_FILE" ]]; then
  BACKUP_FILE=$(backup_file "$TODO_FILE")
  if [[ $? -ne 0 ]]; then
    log_error "Failed to backup original file"
    unlock_file "$ADD_LOCK_FD"
    exit 2
  fi
fi

# Write to temp file with pretty-printing
if ! echo "$UPDATED_TODO" | jq '.' > "$TEMP_FILE" 2>/dev/null; then
  log_error "Failed to write temp file"
  rm -f "$TEMP_FILE" 2>/dev/null || true
  unlock_file "$ADD_LOCK_FD"
  exit 2
fi

# Atomic rename
if ! mv "$TEMP_FILE" "$TODO_FILE" 2>/dev/null; then
  log_error "Failed to move temp file to target"
  # Attempt rollback
  if [[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]]; then
    cp "$BACKUP_FILE" "$TODO_FILE" 2>/dev/null || true
  fi
  rm -f "$TEMP_FILE" 2>/dev/null || true
  unlock_file "$ADD_LOCK_FD"
  exit 2
fi

# Set proper permissions
chmod 644 "$TODO_FILE" 2>/dev/null || true

# Release lock now that write is complete
unlock_file "$ADD_LOCK_FD"

# Clear the trap since we've manually released the lock
trap - EXIT ERR INT TERM

# Log operation
task_details=$(jq -n \
  --arg title "$TITLE" \
  --arg status "$STATUS" \
  --arg priority "$PRIORITY" \
  '{title: $title, status: $status, priority: $priority}')
log_operation "create" "$TASK_ID" "$task_details"

# Success output
if [[ "$QUIET" == "true" ]]; then
  echo "$TASK_ID"
else
  log_info "Task added successfully"
  echo ""
  echo "Task ID: $TASK_ID"
  echo "Title: $TITLE"
  echo "Status: $STATUS"
  echo "Priority: $PRIORITY"
  [[ -n "$PHASE" ]] && echo "Phase: $PHASE"
  [[ -n "$LABELS" ]] && echo "Labels: $LABELS"
  [[ -n "$DEPENDS" ]] && echo "Depends: $DEPENDS"
  echo ""
  echo "View with: jq '.tasks[] | select(.id == \"$TASK_ID\")' $TODO_FILE"
fi

exit 0
