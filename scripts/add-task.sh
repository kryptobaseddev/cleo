#!/usr/bin/env bash
# CLEO Add Task Script
# Add new task to todo.json with validation and logging
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source paths.sh for path resolution functions
if [[ -f "$LIB_DIR/paths.sh" ]]; then
    source "$LIB_DIR/paths.sh"
fi

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"
LOG_FILE="${LOG_FILE:-.cleo/todo-log.json}"

# Source logging library for should_use_color function
if [[ -f "$LIB_DIR/version.sh" ]]; then
  # shellcheck source=../lib/version.sh
  source "$LIB_DIR/version.sh"
fi
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

# Source output formatting library for format-aware output
if [[ -f "$LIB_DIR/output-format.sh" ]]; then
  # shellcheck source=../lib/output-format.sh
  source "$LIB_DIR/output-format.sh"
fi

# Source error JSON library for structured error output (includes exit-codes.sh)
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  # shellcheck source=../lib/error-json.sh
  source "$LIB_DIR/error-json.sh"
elif [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  # Fallback: source exit codes directly if error-json.sh not available
  # shellcheck source=../lib/exit-codes.sh
  source "$LIB_DIR/exit-codes.sh"
fi

# Source hierarchy library for parent/type/depth validation (v0.17.0)
if [[ -f "$LIB_DIR/hierarchy.sh" ]]; then
  # shellcheck source=../lib/hierarchy.sh
  source "$LIB_DIR/hierarchy.sh"
fi

# Source config library for defaults resolution (v0.24.0)
if [[ -f "$LIB_DIR/config.sh" ]]; then
  # shellcheck source=../lib/config.sh
  source "$LIB_DIR/config.sh"
fi

# Source phase tracking library for phase context validation (v2.2.0)
if [[ -f "$LIB_DIR/phase-tracking.sh" ]]; then
  # shellcheck source=../lib/phase-tracking.sh
  source "$LIB_DIR/phase-tracking.sh"
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

# Defaults - empty values will be resolved from config after argument parsing
# This ensures CLI arguments override config defaults
STATUS=""
PRIORITY=""
DESCRIPTION=""
LABELS=""
PHASE=""
FILES=""
ACCEPTANCE=""
DEPENDS=""
NOTES=""
QUIET=false
ADD_PHASE=false
FORMAT=""
DRY_RUN=false
# Hierarchy fields (v0.17.0)
TASK_TYPE=""     # epic|task|subtask - inferred if not specified
PARENT_ID=""     # Parent task ID for hierarchy
SIZE=""          # small|medium|large - optional scope-based size (NOT time)

usage() {
  cat << 'EOF'
Usage: cleo add "Task Title" [OPTIONS]

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
                            Default: project.currentPhase or config default
      --add-phase           Create new phase if it doesn't exist
      --files FILES         Comma-separated file paths
      --acceptance CRITERIA Comma-separated acceptance criteria
  -D, --depends IDS         Comma-separated task IDs (e.g., T001,T002)
      --notes NOTE          Initial note entry

Hierarchy Options (v0.17.0):
  -t, --type TYPE           Task type: epic|task|subtask
                            Default: inferred from --parent (task if root)
      --parent ID           Parent task ID (e.g., T001) for hierarchy
                            Epics/tasks can have children, subtasks cannot
      --size SIZE           Scope-based size: small|medium|large (NOT time)
                            small=1-2 files, medium=3-7 files, large=8+ files

Output Options:
  -q, --quiet               Suppress messages, output only task ID
  -f, --format FORMAT       Output format: text|json (default: auto-detect)
      --human               Force human-readable text output
      --json                Force JSON output (for LLM agents)
      --dry-run             Show what would be created without making changes
  -h, --help                Show this help

Output Formats:
  text    Human-readable colored output (default for TTY)
  json    Machine-readable JSON with full task object (default for pipes/agents)

  When no format is specified:
    - Interactive terminal (TTY) → text format
    - Pipe/redirect/agent context → JSON format

Examples:
  cleo add "Implement authentication"
  cleo add "Fix login bug" -p high -l bug,security
  cleo add "Add tests" -D T001,T002 -P testing
  cleo add "Add tests" -P new-phase --add-phase
  cleo add "Implement auth" --acceptance "User can login,Session persists"
  cleo add "Quick task" -q  # Outputs only: T042
  cleo add "New task" --json  # JSON output with full task object

Hierarchy Examples (v0.17.0):
  cleo add "Auth System" --type epic --size large
  cleo add "Login endpoint" --parent T001 --size medium
  cleo add "Validate email" --parent T002 --type subtask --size small

Duplicate Detection (v0.31.0):
  Tasks with same title+phase created within 60s are detected as duplicates.
  Duplicate detection returns existing task with exit code 0 (success).
  Configurable: DUPLICATE_WINDOW=60 (seconds, env var)
  This prevents LLM agents from creating duplicates during retry loops.

Exit Codes:
  0  = Success (EXIT_SUCCESS)
  2  = Invalid input or arguments (EXIT_INVALID_INPUT)
  3  = File operation failure (EXIT_FILE_ERROR)
  4  = Resource not found (EXIT_NOT_FOUND)
  5  = Missing dependency (EXIT_DEPENDENCY_ERROR)
  6  = Validation error (EXIT_VALIDATION_ERROR)
  7  = Lock timeout (EXIT_LOCK_TIMEOUT)
  10 = Parent task not found (EXIT_PARENT_NOT_FOUND)
  11 = Max depth exceeded (EXIT_DEPTH_EXCEEDED)
  12 = Max siblings exceeded (EXIT_SIBLING_LIMIT)
  13 = Invalid parent type (EXIT_INVALID_PARENT_TYPE)
EOF
  exit "$EXIT_SUCCESS"
}

log_error() {
  # Use output_error from error-json.sh for format-aware error output
  # Default to E_UNKNOWN error code when called without specific code
  local error_code="${2:-$E_UNKNOWN}"
  output_error "$error_code" "$1"
}

log_warn() {
  # Suppress warning messages in quiet mode or JSON format
  if [[ "$QUIET" != "true" ]] && [[ "${FORMAT:-text}" != "json" ]]; then
    echo -e "${YELLOW}[WARN]${NC} $1"
  fi
}

log_info() {
  # Suppress info messages in quiet mode or JSON format
  if [[ "$QUIET" != "true" ]] && [[ "${FORMAT:-text}" != "json" ]]; then
    echo -e "${GREEN}[INFO]${NC} $1"
  fi
}

check_deps() {
  if ! command -v jq &> /dev/null; then
    log_error "jq is required but not installed"
    echo "Install: sudo apt-get install jq  # Debian/Ubuntu" >&2
    echo "         brew install jq          # macOS" >&2
    exit "${EXIT_DEPENDENCY_ERROR:-5}"
  fi
}

# Find recent duplicate task by title and phase within time window
# Arguments:
#   $1 - title: Task title to match
#   $2 - phase: Phase to match (can be empty)
#   $3 - window_seconds: Time window in seconds (default: 60)
# Returns:
#   JSON object of duplicate task if found, empty otherwise
# Notes:
#   Part of LLM-Agent-First Spec v3.0 (Part 5.6 - Idempotency)
#   Prevents duplicate task creation during agent retry loops
find_recent_duplicate() {
  local title="$1"
  local phase="${2:-}"
  local window_seconds="${3:-60}"

  if [[ ! -f "$TODO_FILE" ]]; then
    return 0
  fi

  # Get current timestamp in seconds since epoch
  local now
  now=$(date +%s)
  local cutoff=$((now - window_seconds))

  # Find matching task created within window using jq
  # Use 'first' to get only the first match and avoid multi-line output
  # Handle both ISO 8601 with and without milliseconds
  local result
  if [[ -n "$phase" ]]; then
    # Match title AND phase
    result=$(jq --arg title "$title" --arg phase "$phase" --argjson cutoff "$cutoff" '
      first(
        .tasks[] |
        select(.title == $title and .phase == $phase) |
        select(
          (.createdAt |
            gsub("\\.[0-9]+Z$"; "Z") |
            try (strptime("%Y-%m-%dT%H:%M:%SZ") | mktime) catch 0
          ) > $cutoff
        )
      )
    ' "$TODO_FILE" 2>/dev/null)
  else
    # Match title only when phase is empty, and task has no phase or empty phase
    result=$(jq --arg title "$title" --argjson cutoff "$cutoff" '
      first(
        .tasks[] |
        select(.title == $title and (.phase == null or .phase == "")) |
        select(
          (.createdAt |
            gsub("\\.[0-9]+Z$"; "Z") |
            try (strptime("%Y-%m-%dT%H:%M:%SZ") | mktime) catch 0
          ) > $cutoff
        )
      )
    ' "$TODO_FILE" 2>/dev/null)
  fi

  # Return first matching task (if any, and not null/empty)
  if [[ -n "$result" && "$result" != "null" ]]; then
    echo "$result"
  fi
}

# Output duplicate detection result in JSON format
# Arguments:
#   $1 - duplicate_task: JSON object of the duplicate task
#   $2 - seconds_ago: How long ago the duplicate was created
# Returns:
#   Formatted JSON output to stdout
output_duplicate_json() {
  local duplicate_task="$1"
  local seconds_ago="${2:-0}"

  local version="${CLEO_VERSION:-$(get_version 2>/dev/null || echo '0.30.0')}"
  local timestamp
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  jq -n \
    --arg version "$version" \
    --arg timestamp "$timestamp" \
    --argjson task "$duplicate_task" \
    --argjson seconds_ago "$seconds_ago" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "format": "json",
        "version": $version,
        "command": "add",
        "timestamp": $timestamp
      },
      "success": true,
      "duplicate": true,
      "message": ("Task with identical title" + (if $task.phase then " and phase" else "" end) + " was created \($seconds_ago) seconds ago"),
      "task": $task
    }'
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
    phase_exists=$(jq --arg phase "$phase" '(.project.phases // {}) | has($phase)' "$TODO_FILE")
    if [[ "$phase_exists" != "true" ]]; then
      # If --add-phase flag is set, we'll create it later
      if [[ "$ADD_PHASE" == "true" ]]; then
        return 0
      fi

      # Get list of valid phases for error message
      local valid_phases
      valid_phases=$(jq -r '(.project.phases // {}) | keys | join(", ")' "$TODO_FILE")

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
  next_order=$(jq '[.project.phases[].order // 0] | max + 1' "$TODO_FILE")
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
                       '.project.phases[$phase] = {name: $name, order: $order}' \
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

# Log operation to todo-log.json (with file locking for concurrency safety)
log_operation() {
  local operation="$1"
  local task_id="$2"
  local details="$3"

  # Acquire lock on log file before any writes
  local log_lock_fd=""
  if ! lock_file "$LOG_FILE" log_lock_fd 30; then
    echo "Warning: Could not acquire lock for log file, skipping log entry" >&2
    return 1
  fi

  # Ensure lock is released on function exit/error
  # shellcheck disable=SC2064
  trap "unlock_file $log_lock_fd" RETURN

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
    --arg action "$operation" \
    --arg task_id "$task_id" \
    --argjson details "$details" \
    '{
      id: $id,
      timestamp: $ts,
      action: $action,
      taskId: $task_id,
      actor: "system",
      details: $details,
      before: null,
      after: $details
    }')

  local updated_log
  updated_log=$(jq --argjson entry "$log_entry" '.entries += [$entry]' "$LOG_FILE")

  # Atomic write pattern (manual, since we already hold the lock - save_json would deadlock)
  local temp_file="${LOG_FILE}.tmp"

  # Validate JSON before writing
  if ! echo "$updated_log" | jq empty 2>/dev/null; then
    echo "Warning: Invalid JSON in log entry, skipping" >&2
    return 1
  fi

  # Write to temp file with pretty-printing
  if ! echo "$updated_log" | jq '.' > "$temp_file" 2>/dev/null; then
    echo "Warning: Failed to write temp log file" >&2
    rm -f "$temp_file" 2>/dev/null || true
    return 1
  fi

  # Atomic rename (we already hold the lock)
  if ! mv "$temp_file" "$LOG_FILE" 2>/dev/null; then
    echo "Warning: Failed to update log file" >&2
    rm -f "$temp_file" 2>/dev/null || true
    return 1
  fi
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
    -t|--type)
      TASK_TYPE="$2"
      shift 2
      ;;
    --parent)
      PARENT_ID="$2"
      shift 2
      ;;
    --size)
      SIZE="$2"
      shift 2
      ;;
    -q|--quiet)
      QUIET=true
      shift
      ;;
    -f|--format)
      FORMAT="$2"
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
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      ;;
    -*)
      log_error "Unknown option: $1"
      echo "Use --help for usage information" >&2
      exit "${EXIT_INVALID_INPUT:-2}"
      ;;
    *)
      if [[ -z "$TITLE" ]]; then
        TITLE="$1"
      else
        log_error "Multiple titles provided. Quote the title if it contains spaces."
        exit "${EXIT_INVALID_INPUT:-2}"
      fi
      shift
      ;;
  esac
done

# Main execution
check_deps

# Resolve output format (TTY-aware default)
FORMAT=$(resolve_format "$FORMAT")
COMMAND_NAME="add"



# Validate required arguments
if [[ -z "$TITLE" ]]; then
  log_error "Task title is required"
  echo "Usage: cleo add \"Task Title\" [OPTIONS]" >&2
  echo "Use --help for more information" >&2
  exit "${EXIT_INVALID_INPUT:-2}"
fi

# Normalize labels to remove duplicates
if [[ -n "$LABELS" ]]; then
  LABELS=$(normalize_labels "$LABELS")
fi

# ============================================================================
# RESOLVE DEFAULTS FROM CONFIG (v0.24.0)
# Priority: CLI arguments > config defaults > hardcoded defaults
# ============================================================================

# Resolve priority default if not provided via CLI
if [[ -z "$PRIORITY" ]]; then
  if declare -f get_config_value >/dev/null 2>&1; then
    PRIORITY=$(get_config_value "defaults.priority" "medium")
  else
    PRIORITY="medium"
  fi
fi

# Resolve status default if not provided via CLI
if [[ -z "$STATUS" ]]; then
  if declare -f get_config_value >/dev/null 2>&1; then
    STATUS=$(get_config_value "defaults.status" "pending")
  else
    STATUS="pending"
  fi
fi

# Phase inheritance: If no --phase specified, inherit from project.currentPhase or config
PHASE_SOURCE=""
if [[ -z "$PHASE" ]]; then
  # Try project.currentPhase first (v2.2.0+ feature)
  if [[ -f "$TODO_FILE" ]]; then
    PHASE=$(jq -r '.project.currentPhase // empty' "$TODO_FILE" 2>/dev/null)
    if [[ -n "$PHASE" && "$PHASE" != "null" ]]; then
      PHASE_SOURCE="project"
      log_info "Using project phase: $PHASE"
    fi
  fi

  # Fallback to config default if project phase not set
  if [[ -z "$PHASE" || "$PHASE" == "null" ]]; then
    if declare -f get_config_value >/dev/null 2>&1; then
      PHASE=$(get_config_value "defaults.phase" "")
    else
      PHASE=$(jq -r '.defaults.phase // empty' "$CONFIG_FILE" 2>/dev/null)
    fi
    if [[ -n "$PHASE" && "$PHASE" != "null" ]]; then
      PHASE_SOURCE="config"
    else
      PHASE=""  # Clear if only got "null" string
    fi
  fi
fi

# Validate inputs
validate_title_local "$TITLE" || exit "${EXIT_VALIDATION_ERROR:-6}"
validate_status "$STATUS" || exit "${EXIT_VALIDATION_ERROR:-6}"
validate_priority "$PRIORITY" || exit "${EXIT_VALIDATION_ERROR:-6}"
validate_phase "$PHASE" || exit "${EXIT_VALIDATION_ERROR:-6}"
validate_labels "$LABELS" || exit "${EXIT_VALIDATION_ERROR:-6}"
validate_depends "$DEPENDS" || exit "${EXIT_VALIDATION_ERROR:-6}"

# Validate field lengths (v0.20.0+)
if [[ -n "$DESCRIPTION" ]]; then
  validate_description "$DESCRIPTION" || exit "${EXIT_VALIDATION_ERROR:-6}"
fi
if [[ -n "$NOTES" ]]; then
  validate_note "$NOTES" || exit "${EXIT_VALIDATION_ERROR:-6}"
fi

# Check if description is required (configurable via validation.requireDescription)
REQUIRE_DESCRIPTION=true
if declare -f is_description_required >/dev/null 2>&1; then
  REQUIRE_DESCRIPTION=$(is_description_required)
fi
if [[ "$REQUIRE_DESCRIPTION" == "true" && -z "$DESCRIPTION" ]]; then
  output_error "$E_INPUT_MISSING" "Description is required (config: validation.requireDescription=true)" "${EXIT_VALIDATION_ERROR:-6}" "false" "Use --description to add task description, or set validation.requireDescription=false in config"
  exit "${EXIT_VALIDATION_ERROR:-6}"
fi

# Validate hierarchy fields (v0.17.0)
if [[ -n "$TASK_TYPE" ]]; then
  if ! validate_task_type "$TASK_TYPE" 2>/dev/null; then
    log_error "Invalid task type: $TASK_TYPE (must be epic|task|subtask)"
    exit "${EXIT_VALIDATION_ERROR:-6}"
  fi

  # Epic cannot have a parent (must be root-level)
  if [[ "$TASK_TYPE" == "epic" && -n "$PARENT_ID" ]]; then
    output_error "$E_INPUT_INVALID" "Epic tasks cannot have a parent - they must be root-level" "${EXIT_VALIDATION_ERROR:-6}" "false" "Remove --parent flag or change --type to task|subtask"
    exit "${EXIT_VALIDATION_ERROR:-6}"
  fi

  # Subtask requires a parent
  if [[ "$TASK_TYPE" == "subtask" && -z "$PARENT_ID" ]]; then
    output_error "$E_INPUT_INVALID" "Subtask tasks require a parent - specify with --parent" "${EXIT_VALIDATION_ERROR:-6}" "false" "Add --parent T### flag or change --type to task|epic"
    exit "${EXIT_VALIDATION_ERROR:-6}"
  fi
fi

if [[ -n "$SIZE" ]]; then
  if ! validate_task_size "$SIZE" 2>/dev/null; then
    log_error "Invalid size: $SIZE (must be small|medium|large)"
    exit "${EXIT_VALIDATION_ERROR:-6}"
  fi
fi

# Validate parent hierarchy constraints if parent specified
if [[ -n "$PARENT_ID" ]]; then
  # Validate parent ID format
  if ! [[ "$PARENT_ID" =~ ^T[0-9]{3,}$ ]]; then
    log_error "Invalid parent ID format: $PARENT_ID (must be T### format)"
    exit "${EXIT_INVALID_INPUT:-2}"
  fi

  # Validate hierarchy constraints using lib/hierarchy.sh
  if declare -f validate_hierarchy >/dev/null 2>&1; then
    if ! validate_parent_exists "$PARENT_ID" "$TODO_FILE"; then
      output_error "$E_PARENT_NOT_FOUND" "Parent task not found: $PARENT_ID" "${EXIT_PARENT_NOT_FOUND:-10}" "true" "Use 'ct exists $PARENT_ID' to verify task ID"
      exit "${EXIT_PARENT_NOT_FOUND:-10}"
    fi

    if ! validate_max_depth "$PARENT_ID" "$TODO_FILE"; then
      output_error "$E_DEPTH_EXCEEDED" "Cannot add child to $PARENT_ID: max hierarchy depth (3) would be exceeded" "${EXIT_DEPTH_EXCEEDED:-11}" "false" "Refactor task hierarchy to reduce nesting depth"
      exit "${EXIT_DEPTH_EXCEEDED:-11}"
    fi

    if ! validate_max_siblings "$PARENT_ID" "$TODO_FILE"; then
      max_sibs=$(get_max_siblings)
      output_error "$E_SIBLING_LIMIT" "Cannot add child to $PARENT_ID: max siblings ($max_sibs) exceeded" "${EXIT_SIBLING_LIMIT:-12}" "false" "Complete tasks, set hierarchy.maxSiblings=0 for unlimited, or group under new epic"
      exit "${EXIT_SIBLING_LIMIT:-12}"
    fi

    if ! validate_parent_type "$PARENT_ID" "$TODO_FILE"; then
      output_error "$E_INVALID_PARENT_TYPE" "Cannot add child to $PARENT_ID: subtasks cannot have children" "${EXIT_INVALID_PARENT_TYPE:-13}" "false" "Choose a task or epic as parent instead of a subtask"
      exit "${EXIT_INVALID_PARENT_TYPE:-13}"
    fi
  fi

  # Infer task type from parent if not explicitly set
  if [[ -z "$TASK_TYPE" ]]; then
    if declare -f infer_task_type >/dev/null 2>&1; then
      TASK_TYPE=$(infer_task_type "$PARENT_ID" "$TODO_FILE")
      log_info "Inferred task type: $TASK_TYPE (based on parent)"
    else
      TASK_TYPE="task"  # Fallback default
    fi
  fi
else
  # No parent - default to "task" type if not specified
  if [[ -z "$TASK_TYPE" ]]; then
    TASK_TYPE="task"
  fi
fi

# Add new phase if --add-phase flag is set and phase doesn't exist
if [[ "$ADD_PHASE" == "true" ]] && [[ -n "$PHASE" ]]; then
  add_new_phase "$PHASE"
fi

# Check for circular dependencies if dependencies are specified (configurable)
if [[ -n "$DEPENDS" ]]; then
  # Check if dependency validation is enabled
  VALIDATE_DEPS=true
  if declare -f is_dependency_validation_enabled >/dev/null 2>&1; then
    VALIDATE_DEPS=$(is_dependency_validation_enabled)
  fi

  if [[ "$VALIDATE_DEPS" == "true" ]]; then
    # Check if circular dependency detection is enabled
    DETECT_CIRCULAR=true
    if declare -f is_circular_dep_detection_enabled >/dev/null 2>&1; then
      DETECT_CIRCULAR=$(is_circular_dep_detection_enabled)
    fi

    if [[ "$DETECT_CIRCULAR" == "true" ]]; then
      # Generate a temporary task ID for validation
      TEMP_TASK_ID=$(generate_task_id)
      if ! check_circular_dependencies "$TODO_FILE" "$TEMP_TASK_ID" "$DEPENDS"; then
        log_error "Cannot add task: would create circular dependency"
        exit "${EXIT_VALIDATION_ERROR:-6}"
      fi
    fi
  fi
fi

# Check if blocked status has blocker reason
if [[ "$STATUS" == "blocked" ]] && [[ -z "$DESCRIPTION" ]]; then
  log_error "Blocked tasks require --description to specify blocker reason"
  exit "${EXIT_INVALID_INPUT:-2}"
fi

# Check if todo.json exists
if [[ ! -f "$TODO_FILE" ]]; then
  log_error "Todo file not found: $TODO_FILE"
  echo "Run cleo init first to initialize the todo system" >&2
  exit "${EXIT_NOT_FOUND:-4}"
fi

# Check if active status and there's already an active task
if [[ "$STATUS" == "active" ]]; then
  active_count=$(jq '[.tasks[] | select(.status == "active")] | length' "$TODO_FILE")
  if [[ "$active_count" -gt 0 ]]; then
    log_error "Cannot create active task: only ONE active task allowed"
    echo "Current active task: $(jq -r '[.tasks[] | select(.status == "active")][0].id' "$TODO_FILE")" >&2
    exit "${EXIT_VALIDATION_ERROR:-6}"
  fi
fi

# CRITICAL: Acquire lock BEFORE ID generation to prevent race conditions
# Lock protects the entire ID generation → task creation sequence
ADD_LOCK_FD=""
if ! lock_file "$TODO_FILE" ADD_LOCK_FD 30; then
  log_error "Cannot acquire lock for task creation (another process may be adding a task)"
  echo "Try again in a moment or check for stuck processes" >&2
  exit "${EXIT_LOCK_TIMEOUT:-7}"
fi

# Set up trap to ensure lock is released on exit/error
# shellcheck disable=SC2064
trap "unlock_file $ADD_LOCK_FD" EXIT ERR INT TERM

# ============================================================================
# DUPLICATE DETECTION (LLM-Agent-First Spec v3.0 Part 5.6)
# Check for recent duplicate before creating task - prevents agent retry loops
# from creating duplicates when retrying after network failures
# ============================================================================
DUPLICATE_WINDOW="${DUPLICATE_WINDOW:-60}"  # Configurable window in seconds
duplicate_task=$(find_recent_duplicate "$TITLE" "$PHASE" "$DUPLICATE_WINDOW")

if [[ -n "$duplicate_task" ]]; then
  # Calculate how long ago the duplicate was created
  duplicate_created=$(echo "$duplicate_task" | jq -r '.createdAt // empty')
  duplicate_id=$(echo "$duplicate_task" | jq -r '.id')
  seconds_ago=0

  if [[ -n "$duplicate_created" ]]; then
    # Parse timestamp and calculate age
    created_epoch=$(date -d "$duplicate_created" +%s 2>/dev/null || echo "0")
    now_epoch=$(date +%s)
    if [[ "$created_epoch" -gt 0 ]]; then
      seconds_ago=$((now_epoch - created_epoch))
    fi
  fi

  # Release lock early since we're not creating a task
  unlock_file "$ADD_LOCK_FD"
  trap - EXIT ERR INT TERM

  # Output duplicate detection result
  if [[ "$FORMAT" == "json" ]]; then
    output_duplicate_json "$duplicate_task" "$seconds_ago"
  elif [[ "$QUIET" == true ]]; then
    echo "$duplicate_id"
  else
    log_warn "Duplicate detected: $duplicate_id was created ${seconds_ago}s ago with same title${PHASE:+ and phase '$PHASE'}"
    echo ""
    echo "Existing task: $duplicate_id"
    echo "Title: $TITLE"
    [[ -n "$PHASE" ]] && echo "Phase: $PHASE"
    echo "Created: ${seconds_ago}s ago"
    echo ""
    echo -e "${YELLOW}No new task created (duplicate within ${DUPLICATE_WINDOW}s window)${NC}"
  fi

  # Exit SUCCESS - duplicate detection is helpful, not an error
  # This enables safe agent retry loops per LLM-Agent-First spec
  exit $EXIT_SUCCESS
fi

# Generate task ID (lock is now held, preventing concurrent ID collisions)
TASK_ID=$(generate_task_id)
log_info "Generated task ID: $TASK_ID"

# Create timestamp
CREATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build task object with hierarchy fields (v0.17.0)
TASK_JSON=$(jq -n \
  --arg id "$TASK_ID" \
  --arg title "$TITLE" \
  --arg status "$STATUS" \
  --arg priority "$PRIORITY" \
  --arg taskType "$TASK_TYPE" \
  --arg created "$CREATED_AT" \
  '{
    id: $id,
    title: $title,
    status: $status,
    priority: $priority,
    type: $taskType,
    parentId: null,
    createdAt: $created
  }')

# Add parentId if specified (hierarchy)
if [[ -n "$PARENT_ID" ]]; then
  TASK_JSON=$(echo "$TASK_JSON" | jq --arg pid "$PARENT_ID" '.parentId = $pid')
fi

# Add size if specified (scope-based, NOT time-based)
if [[ -n "$SIZE" ]]; then
  TASK_JSON=$(echo "$TASK_JSON" | jq --arg sz "$SIZE" '.size = $sz')
fi

# Add optional fields
if [[ -n "$PHASE" ]]; then
  TASK_JSON=$(echo "$TASK_JSON" | jq --arg phase "$PHASE" '.phase = $phase')

  # Phase context warning (permissive - warn only, never block creation)
  if declare -f check_phase_context >/dev/null 2>&1; then
    check_phase_context "$PHASE" "$TODO_FILE" || true  # Never block task creation
  fi
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

# DRY-RUN: Show what would be created without making changes
if [[ "$DRY_RUN" == true ]]; then
  # Release lock early since we're not writing
  unlock_file "$ADD_LOCK_FD"
  trap - EXIT ERR INT TERM

  if [[ "$FORMAT" == "json" ]]; then
    jq -n \
      --arg version "${CLEO_VERSION:-$(get_version)}" \
      --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --argjson task "$TASK_JSON" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $version,
          "command": "add",
          "timestamp": $timestamp
        },
        "success": true,
        "dryRun": true,
        "wouldCreate": $task
      }'
  elif [[ "$QUIET" == true ]]; then
    echo "$TASK_ID"
  else
    echo -e "${YELLOW}[DRY-RUN]${NC} Would create task:"
    echo ""
    echo "Task ID: $TASK_ID"
    echo "Title: $TITLE"
    echo "Status: $STATUS"
    echo "Priority: $PRIORITY"
    echo "Type: $TASK_TYPE"
    [[ -n "$PHASE" ]] && echo "Phase: $PHASE"
    [[ -n "$LABELS" ]] && echo "Labels: $LABELS"
    [[ -n "$DEPENDS" ]] && echo "Depends: $DEPENDS"
    [[ -n "$PARENT_ID" ]] && echo "Parent: $PARENT_ID"
    [[ -n "$SIZE" ]] && echo "Size: $SIZE"
    [[ -n "$DESCRIPTION" ]] && echo "Description: $DESCRIPTION"
    echo ""
    echo -e "${YELLOW}No changes made (dry-run mode)${NC}"
  fi
  exit $EXIT_SUCCESS
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
  exit "${EXIT_VALIDATION_ERROR:-6}"
fi

# Backup original file
BACKUP_FILE=""
if [[ -f "$TODO_FILE" ]]; then
  BACKUP_FILE=$(backup_file "$TODO_FILE")
  if [[ $? -ne 0 ]]; then
    log_error "Failed to backup original file"
    unlock_file "$ADD_LOCK_FD"
    exit "${EXIT_FILE_ERROR:-3}"
  fi
fi

# Write to temp file with pretty-printing
if ! echo "$UPDATED_TODO" | jq '.' > "$TEMP_FILE" 2>/dev/null; then
  log_error "Failed to write temp file"
  rm -f "$TEMP_FILE" 2>/dev/null || true
  unlock_file "$ADD_LOCK_FD"
  exit "${EXIT_FILE_ERROR:-3}"
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
  exit "${EXIT_FILE_ERROR:-3}"
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
log_operation "task_created" "$TASK_ID" "$task_details"

# Success output
if [[ "$FORMAT" == "json" ]]; then
  # Get the full created task as JSON
  TASK_JSON_OUTPUT=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE")

  jq -n \
    --arg version "${CLEO_VERSION:-$(get_version)}" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson task "$TASK_JSON_OUTPUT" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "format": "json",
        "version": $version,
        "command": "add",
        "timestamp": $timestamp
      },
      "success": true,
      "task": $task
    }'
elif [[ "$QUIET" == true ]]; then
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

exit $EXIT_SUCCESS
