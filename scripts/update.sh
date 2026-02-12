#!/usr/bin/env bash
###CLEO
# command: update
# category: write
# synopsis: Modify existing task fields (status, priority, labels, notes, etc.)
# relevance: critical
# flags: --format,--quiet,--dry-run,--status,--priority,--labels,--notes,--description,--phase,--blocked-by,--depends
# exits: 0,1,2,3,4,6,10,11,12,13,102
# json-output: true
###END
# CLEO Update Task Script
# Update existing task fields with validation and logging
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
LOG_SCRIPT="${SCRIPT_DIR}/log.sh"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source paths.sh for path resolution functions
if [[ -f "$LIB_DIR/core/paths.sh" ]]; then
    source "$LIB_DIR/core/paths.sh"
fi

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"

# Source version library for proper version management
if [[ -f "$CLEO_HOME/lib/core/version.sh" ]]; then
  source "$CLEO_HOME/lib/core/version.sh"
elif [[ -f "$LIB_DIR/core/version.sh" ]]; then
  source "$LIB_DIR/core/version.sh"
fi

# Command name for JSON output
COMMAND_NAME="update"

# Source logging library for should_use_color function
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/core/logging.sh" ]]; then
  # shellcheck source=../lib/core/logging.sh
  source "$LIB_DIR/core/logging.sh"
fi

# Source validation library for circular dependency check
if [[ -f "$LIB_DIR/validation/validation.sh" ]]; then
  # shellcheck source=../lib/validation/validation.sh
  source "$LIB_DIR/validation/validation.sh"
fi

# Source file operations library for atomic writes with locking
if [[ -f "$LIB_DIR/data/file-ops.sh" ]]; then
  # shellcheck source=../lib/data/file-ops.sh
  source "$LIB_DIR/data/file-ops.sh"
fi

# Source output formatting library
if [[ -f "$LIB_DIR/core/output-format.sh" ]]; then
  # shellcheck source=../lib/core/output-format.sh
  source "$LIB_DIR/core/output-format.sh"
fi

# Source exit codes library (after validation.sh due to shared EXIT_SUCCESS)
if [[ -f "$LIB_DIR/core/exit-codes.sh" ]]; then
  # shellcheck source=../lib/core/exit-codes.sh
  source "$LIB_DIR/core/exit-codes.sh"
fi

# Source error JSON library
if [[ -f "$LIB_DIR/core/error-json.sh" ]]; then
  # shellcheck source=../lib/core/error-json.sh
  source "$LIB_DIR/core/error-json.sh"
fi

# Source config library for validation settings
# IMPORTANT: Must be sourced BEFORE hierarchy.sh so config functions are available
if [[ -f "$LIB_DIR/core/config.sh" ]]; then
  # shellcheck source=../lib/core/config.sh
  source "$LIB_DIR/core/config.sh"
fi

# Source hierarchy library for type/parent/size validation
if [[ -f "$LIB_DIR/tasks/hierarchy.sh" ]]; then
  # shellcheck source=../lib/tasks/hierarchy.sh
  source "$LIB_DIR/tasks/hierarchy.sh"
fi

# Source session enforcement for Epic-Bound Sessions (v0.40.0)
if [[ -f "$LIB_DIR/session/session-enforcement.sh" ]]; then
  # shellcheck source=../lib/session/session-enforcement.sh
  source "$LIB_DIR/session/session-enforcement.sh"
fi

# Source jq-helpers library for reusable jq wrapper functions
if [[ -f "$LIB_DIR/core/jq-helpers.sh" ]]; then
  # shellcheck source=../lib/core/jq-helpers.sh
  source "$LIB_DIR/core/jq-helpers.sh"
fi

# Source files-detect library for auto-detecting files from notes (v0.64.0+)
if [[ -f "$LIB_DIR/data/files-detect.sh" ]]; then
  # shellcheck source=../lib/data/files-detect.sh
  source "$LIB_DIR/data/files-detect.sh"
fi

# Source crossref-extract library for auto-detecting task references from notes (v0.65.0+)
if [[ -f "$LIB_DIR/tasks/crossref-extract.sh" ]]; then
  # shellcheck source=../lib/tasks/crossref-extract.sh
  source "$LIB_DIR/tasks/crossref-extract.sh"
fi

# Source task-mutate library for centralized mutations with updatedAt (T2067)
if [[ -f "$LIB_DIR/tasks/task-mutate.sh" ]]; then
  # shellcheck source=../lib/tasks/task-mutate.sh
  source "$LIB_DIR/tasks/task-mutate.sh"
fi

# Source protocol validation library for protocol enforcement (T2695)
if [[ -f "$LIB_DIR/validation/protocol-validation.sh" ]]; then
  # shellcheck source=../lib/validation/protocol-validation.sh
  source "$LIB_DIR/validation/protocol-validation.sh"
fi

# Source centralized flag parsing
source "$LIB_DIR/ui/flags.sh"

# Fallback exit codes if libraries not loaded (for robustness)
: "${EXIT_SUCCESS:=0}"
: "${EXIT_INVALID_INPUT:=2}"
: "${EXIT_FILE_ERROR:=3}"
: "${EXIT_NOT_FOUND:=4}"
: "${EXIT_DEPENDENCY_ERROR:=5}"
: "${EXIT_VALIDATION_ERROR:=6}"
: "${EXIT_NO_CHANGE:=102}"
# Hierarchy exit codes
: "${EXIT_PARENT_NOT_FOUND:=10}"
: "${EXIT_DEPTH_EXCEEDED:=11}"
: "${EXIT_SIBLING_LIMIT:=12}"
: "${EXIT_INVALID_PARENT_TYPE:=13}"

# Fallback error codes if error-json.sh not loaded
: "${E_INPUT_MISSING:=E_INPUT_MISSING}"
: "${E_TASK_NOT_FOUND:=E_TASK_NOT_FOUND}"
: "${E_TASK_INVALID_ID:=E_TASK_INVALID_ID}"
: "${E_TASK_INVALID_STATUS:=E_TASK_INVALID_STATUS}"
: "${E_NOT_INITIALIZED:=E_NOT_INITIALIZED}"
: "${E_VALIDATION_REQUIRED:=E_VALIDATION_REQUIRED}"
: "${E_VALIDATION_SCHEMA:=E_VALIDATION_SCHEMA}"
: "${E_FILE_WRITE_ERROR:=E_FILE_WRITE_ERROR}"
# Hierarchy error codes
: "${E_PARENT_NOT_FOUND:=E_PARENT_NOT_FOUND}"
: "${E_DEPTH_EXCEEDED:=E_DEPTH_EXCEEDED}"
: "${E_SIBLING_LIMIT:=E_SIBLING_LIMIT}"
: "${E_INVALID_PARENT_TYPE:=E_INVALID_PARENT_TYPE}"
: "${E_INPUT_INVALID:=E_INPUT_INVALID}"

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

# Task ID (required)
TASK_ID=""

# Update fields (empty = no change)
NEW_TITLE=""
NEW_STATUS=""
NEW_PRIORITY=""
NEW_DESCRIPTION=""
NEW_PHASE=""
NEW_BLOCKED_BY=""

# Hierarchy fields (v0.20.0+)
NEW_TYPE=""       # epic|task|subtask
NEW_PARENT_ID=""  # Parent task ID for hierarchy
NEW_SIZE=""       # small|medium|large - scope-based size
NEW_NOAUTOCOMPLETE=""  # true|false - prevent auto-complete

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
ADD_PHASE=false

# Output control
FORMAT=""
QUIET=false
DRY_RUN=false

usage() {
  cat << 'EOF'
Usage: cleo update TASK_ID [OPTIONS]

Update an existing task's fields.

Arguments:
  TASK_ID                   Task ID to update (e.g., T001)

Scalar Field Options:
  -t, --title "New title"   Update task title
  -s, --status STATUS       Change status (pending|active|blocked)
                            Note: Use 'cleo complete' for done status
  -p, --priority PRIORITY   Update priority (critical|high|medium|low)
  -d, --description DESC    Update description
  -P, --phase PHASE         Update phase slug
      --add-phase           Create new phase if it doesn't exist
      --blocked-by REASON   Set blocked reason (status becomes blocked)

Hierarchy Options (v0.20.0+):
      --type TYPE           Change task type: epic|task|subtask
                            Note: epic cannot have parent, subtask requires parent
      --parent ID           Set/change parent task ID (e.g., T001)
                            Use --parent "" to remove parent (make root task)
      --size SIZE           Set scope-based size: small|medium|large (NOT time)
      --no-auto-complete BOOL  Prevent auto-completion: true|false
                            When true, this task won't auto-complete when children done

Completed Task Updates:
  Completed tasks allow metadata corrections only:
    - Allowed: --type, --parent, --size, --labels (hierarchy/classification)
    - Blocked: --title, --description, --status, --priority, --notes (work fields)
  This enables hierarchy restructuring without losing completion history.

Array Field Options (append by default):
  -l, --labels LABELS       Append comma-separated labels
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

  -n, --notes NOTE          Add a timestamped note (appends only)

Output Options:
      --format FORMAT       Output format: text, json (default: auto-detect)
      --human               Force human-readable text output
      --json                Force JSON output (for agent integration)
  -q, --quiet               Suppress non-essential output
      --dry-run             Preview changes without applying

General Options:
  -h, --help                Show this help

Examples:
  cleo update T001 --priority high
  cleo update T002 --labels bug,urgent --status active
  cleo update T003 --set-labels "frontend,ui" --clear-files
  cleo update T004 --phase new-phase --add-phase
  cleo update T004 --blocked-by "Waiting for API spec"
  cleo update T005 --notes "Started implementation"
  cleo update T001 --json               # JSON output for agents
  cleo update T001 --dry-run            # Preview changes
  cleo update T001 --type epic          # Convert task to epic
  cleo update T042 --parent T001        # Set parent (make child of T001)
  cleo update T042 --parent ""          # Remove parent (make root task)
  cleo update T001 --size large         # Set scope-based size

Exit Codes:
  0   = Success
  2   = Invalid input or arguments
  3   = File operation failure
  4   = Task not found
  6   = Validation error
  10  = Parent task not found
  11  = Max hierarchy depth exceeded
  12  = Max siblings limit exceeded
  13  = Invalid parent type (subtask cannot have children)
  102 = No changes (dry-run or no-op)
EOF
  exit "$EXIT_SUCCESS"
}

log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }

check_deps() {
  if ! command -v jq &> /dev/null; then
    log_error "jq is required but not installed"
    exit "$EXIT_DEPENDENCY_ERROR"
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
      log_error "Use 'cleo complete' to mark tasks as done"
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

# Validate title (local wrapper - calls lib/validation/validation.sh function)
validate_title_local() {
  local title="$1"

  # Call the shared validation function from lib/validation/validation.sh
  if ! validate_title "$title"; then
    return 1
  fi

  return 0
}

# Validate phase format or create if --add-phase flag is set
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
    phase_exists=$(jq --arg phase "$phase" '((if (.project | type) == "object" then .project.phases else null end) // {}) | has($phase)' "$TODO_FILE")
    if [[ "$phase_exists" != "true" ]]; then
      # If --add-phase flag is set, we'll create it later
      if [[ "$ADD_PHASE" == "true" ]]; then
        return 0
      fi

      # Get list of valid phases for error message
      local valid_phases
      valid_phases=$(jq -r '((if (.project | type) == "object" then .project.phases else null end) // {}) | keys | join(", ")' "$TODO_FILE")

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

  log_info "Created new phase: $phase ($phase_name)"
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

# Note: atomic_write function removed - now using library's save_json directly
# which includes file locking to prevent race conditions

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -t|--title)
      NEW_TITLE="$2"
      shift 2
      ;;
    -s|--status)
      NEW_STATUS="$2"
      shift 2
      ;;
    -p|--priority)
      NEW_PRIORITY="$2"
      shift 2
      ;;
    -d|--description)
      NEW_DESCRIPTION="$2"
      shift 2
      ;;
    -P|--phase)
      NEW_PHASE="$2"
      shift 2
      ;;
    --add-phase)
      ADD_PHASE=true
      shift
      ;;
    --blocked-by)
      NEW_BLOCKED_BY="$2"
      shift 2
      ;;
    # Hierarchy fields (v0.20.0+)
    --type)
      NEW_TYPE="$2"
      shift 2
      ;;
    --parent)
      NEW_PARENT_ID="$2"
      shift 2
      ;;
    --size)
      NEW_SIZE="$2"
      shift 2
      ;;
    --no-auto-complete)
      NEW_NOAUTOCOMPLETE="$2"
      shift 2
      ;;
    # Labels
    -l|--labels)
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
    # Files (long-form only to avoid conflict with --format)
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
    -n|--notes)
      NOTE_TO_ADD="$2"
      shift 2
      ;;
    # Output control
    --format)
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

# Main execution
check_deps

# Resolve output format (CLI > env > config > TTY-aware default)
if declare -f resolve_format >/dev/null 2>&1; then
  FORMAT=$(resolve_format "$FORMAT" "true" "text,json")
else
  # Fallback if library not loaded
  FORMAT="${FORMAT:-text}"
fi

# Validate task ID provided
if [[ -z "$TASK_ID" ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    output_error "$E_INPUT_MISSING" "Task ID is required" "$EXIT_INVALID_INPUT" true "Provide task ID: cleo update TASK_ID [OPTIONS]"
  else
    log_error "Task ID is required"
    echo "Usage: cleo update TASK_ID [OPTIONS]" >&2
    echo "Use --help for more information" >&2
  fi
  exit "${EXIT_INVALID_INPUT:-2}"
fi

# Validate task ID format
if [[ ! "$TASK_ID" =~ ^T[0-9]{3,}$ ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    output_error "$E_TASK_INVALID_ID" "Invalid task ID format: $TASK_ID (must be T### format)" "$EXIT_INVALID_INPUT" true "Use format T### (e.g., T001, T042)"
  else
    log_error "Invalid task ID format: $TASK_ID (must be T### format)"
  fi
  exit "${EXIT_INVALID_INPUT:-2}"
fi

# ============================================================================
# SESSION ENFORCEMENT (Epic-Bound Sessions v0.40.0)
# Require active session for write operations when multiSession.enabled=true
# EXCEPTION: Notes-only updates are allowed without session (T2863)
# ============================================================================
is_notes_only_update() {
  # Check if ONLY notes are being updated (no other fields)
  # Use ${VAR:-} to handle potentially unset variables
  [[ -n "${NOTE_TO_ADD:-}" ]] && \
  [[ -z "${NEW_TITLE:-}" ]] && \
  [[ -z "${NEW_STATUS:-}" ]] && \
  [[ -z "${NEW_PRIORITY:-}" ]] && \
  [[ -z "${NEW_DESCRIPTION:-}" ]] && \
  [[ -z "${NEW_PHASE:-}" ]] && \
  [[ -z "${NEW_TYPE:-}" ]] && \
  [[ -z "${NEW_PARENT_ID:-}" ]] && \
  [[ -z "${NEW_SIZE:-}" ]] && \
  [[ -z "${LABELS_TO_ADD:-}" ]] && \
  [[ -z "${LABELS_TO_REMOVE:-}" ]] && \
  [[ -z "${DEPENDS_TO_ADD:-}" ]] && \
  [[ -z "${DEPENDS_TO_REMOVE:-}" ]]
}

if declare -f require_active_session >/dev/null 2>&1; then
  if is_notes_only_update; then
    : # Notes-only update - bypassing session requirement (T2863)
  elif ! require_active_session "update" "$FORMAT"; then
    exit $?
  fi
fi

# Check todo file exists
if [[ ! -f "$TODO_FILE" ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    output_error "$E_NOT_INITIALIZED" "Todo file not found: $TODO_FILE" "$EXIT_FILE_ERROR" true "Run 'cleo init' first"
  else
    log_error "Todo file not found: $TODO_FILE"
    echo "Run cleo init first to initialize the todo system" >&2
  fi
  exit "${EXIT_FILE_ERROR:-3}"
fi

# Check task exists (use jq-helper if available)
if declare -f get_task_by_id >/dev/null 2>&1; then
  TASK=$(get_task_by_id "$TASK_ID" "$TODO_FILE")
else
  TASK=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE")
fi
if [[ -z "$TASK" ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    output_error "$E_TASK_NOT_FOUND" "Task $TASK_ID not found" "$EXIT_NOT_FOUND" true "Run 'cleo list' to see available tasks"
  else
    log_error "Task $TASK_ID not found"
  fi
  exit "${EXIT_NOT_FOUND:-4}"
fi

# Get current status for transition validation (use jq-helper if available)
if declare -f get_task_field >/dev/null 2>&1; then
  CURRENT_STATUS=$(get_task_field "$TASK" "status")
else
  CURRENT_STATUS=$(echo "$TASK" | jq -r '.status')
fi

# Check if task is already done - allow metadata-only updates
# Notes are ALLOWED on completed tasks for post-completion info (T2863)
if [[ "$CURRENT_STATUS" == "done" ]]; then
  # Work fields are immutable for completed tasks (except notes)
  BLOCKED_FIELDS=()
  [[ -n "$NEW_TITLE" ]] && BLOCKED_FIELDS+=("--title")
  [[ -n "$NEW_DESCRIPTION" ]] && BLOCKED_FIELDS+=("--description")
  [[ -n "$NEW_STATUS" ]] && BLOCKED_FIELDS+=("--status")
  [[ -n "$NEW_PRIORITY" ]] && BLOCKED_FIELDS+=("--priority")
  # Notes are allowed - removed from blocked fields (T2863)
  [[ -n "$NEW_PHASE" ]] && BLOCKED_FIELDS+=("--phase")
  [[ -n "$NEW_BLOCKED_BY" ]] && BLOCKED_FIELDS+=("--blocked-by")
  [[ -n "$FILES_TO_ADD" || -n "$FILES_TO_SET" || "$CLEAR_FILES" == true ]] && BLOCKED_FIELDS+=("--files")
  [[ -n "$ACCEPTANCE_TO_ADD" || -n "$ACCEPTANCE_TO_SET" || "$CLEAR_ACCEPTANCE" == true ]] && BLOCKED_FIELDS+=("--acceptance")
  [[ -n "$DEPENDS_TO_ADD" || -n "$DEPENDS_TO_SET" || "$CLEAR_DEPENDS" == true ]] && BLOCKED_FIELDS+=("--depends")

  if [[ ${#BLOCKED_FIELDS[@]} -gt 0 ]]; then
    BLOCKED_LIST=$(IFS=', '; echo "${BLOCKED_FIELDS[*]}")
    if [[ "$FORMAT" == "json" ]]; then
      output_error "$E_TASK_INVALID_STATUS" "Cannot update work fields on completed task $TASK_ID: $BLOCKED_LIST" "$EXIT_VALIDATION_ERROR" false "Completed tasks allow: --notes, --type, --parent, --size, --labels"
    else
      log_error "Cannot update work fields on completed task $TASK_ID"
      log_info "Blocked fields: $BLOCKED_LIST"
      log_info "Allowed for completed tasks: --type, --parent, --size, --labels (metadata corrections)"
    fi
    exit "${EXIT_VALIDATION_ERROR:-6}"
  fi
  # Metadata-only updates allowed: type, parentId, size, labels
fi

# Normalize labels to remove duplicates
if [[ -n "$LABELS_TO_ADD" ]]; then
  LABELS_TO_ADD=$(normalize_labels "$LABELS_TO_ADD")
fi
if [[ -n "$LABELS_TO_SET" ]]; then
  LABELS_TO_SET=$(normalize_labels "$LABELS_TO_SET")
fi

# Validate inputs
[[ -n "$NEW_TITLE" ]] && { validate_title_local "$NEW_TITLE" || exit "$EXIT_VALIDATION_ERROR"; }
[[ -n "$NEW_STATUS" ]] && { validate_status "$NEW_STATUS" || exit "$EXIT_VALIDATION_ERROR"; }
[[ -n "$NEW_PRIORITY" ]] && { validate_priority "$NEW_PRIORITY" || exit "$EXIT_VALIDATION_ERROR"; }
[[ -n "$NEW_PHASE" ]] && { validate_phase "$NEW_PHASE" || exit "$EXIT_VALIDATION_ERROR"; }
[[ -n "$LABELS_TO_ADD" ]] && { validate_labels "$LABELS_TO_ADD" || exit "$EXIT_VALIDATION_ERROR"; }
[[ -n "$LABELS_TO_SET" ]] && { validate_labels "$LABELS_TO_SET" || exit "$EXIT_VALIDATION_ERROR"; }
[[ -n "$DEPENDS_TO_ADD" ]] && { validate_depends "$DEPENDS_TO_ADD" || exit "$EXIT_VALIDATION_ERROR"; }
[[ -n "$DEPENDS_TO_SET" ]] && { validate_depends "$DEPENDS_TO_SET" || exit "$EXIT_VALIDATION_ERROR"; }

# Validate field lengths (v0.20.0+)
[[ -n "$NEW_DESCRIPTION" ]] && { validate_description "$NEW_DESCRIPTION" || exit "$EXIT_VALIDATION_ERROR"; }
[[ -n "$NOTE_TO_ADD" ]] && { validate_note "$NOTE_TO_ADD" || exit "$EXIT_VALIDATION_ERROR"; }
[[ -n "$NEW_BLOCKED_BY" ]] && { validate_blocked_by "$NEW_BLOCKED_BY" || exit "$EXIT_VALIDATION_ERROR"; }

# Validate hierarchy fields (v0.20.0+)
if [[ -n "$NEW_TYPE" ]]; then
  if ! validate_task_type "$NEW_TYPE" 2>/dev/null; then
    if [[ "$FORMAT" == "json" ]]; then
      output_error "$E_INPUT_INVALID" "Invalid task type: $NEW_TYPE (must be epic|task|subtask)" "$EXIT_INVALID_INPUT" true "Valid types: epic, task, subtask"
    else
      log_error "Invalid task type: $NEW_TYPE (must be epic|task|subtask)"
    fi
    exit "${EXIT_INVALID_INPUT:-2}"
  fi
fi

if [[ -n "$NEW_SIZE" ]]; then
  if ! validate_task_size "$NEW_SIZE" 2>/dev/null; then
    if [[ "$FORMAT" == "json" ]]; then
      output_error "$E_INPUT_INVALID" "Invalid size: $NEW_SIZE (must be small|medium|large)" "$EXIT_INVALID_INPUT" true "Valid sizes: small, medium, large"
    else
      log_error "Invalid size: $NEW_SIZE (must be small|medium|large)"
    fi
    exit "${EXIT_INVALID_INPUT:-2}"
  fi
fi

# Validate parent ID and hierarchy constraints
if [[ -n "$NEW_PARENT_ID" ]]; then
  # Empty string means remove parent (make root task)
  if [[ "$NEW_PARENT_ID" != "" ]]; then
    # Validate parent ID format
    if ! [[ "$NEW_PARENT_ID" =~ ^T[0-9]{3,}$ ]]; then
      if [[ "$FORMAT" == "json" ]]; then
        output_error "$E_INPUT_INVALID" "Invalid parent ID format: $NEW_PARENT_ID (must be T### format)" "$EXIT_INVALID_INPUT" true "Use format T### (e.g., T001, T042)"
      else
        log_error "Invalid parent ID format: $NEW_PARENT_ID (must be T### format)"
      fi
      exit "${EXIT_INVALID_INPUT:-2}"
    fi

    # Can't set self as parent
    if [[ "$NEW_PARENT_ID" == "$TASK_ID" ]]; then
      if [[ "$FORMAT" == "json" ]]; then
        output_error "$E_INPUT_INVALID" "Task cannot be its own parent" "$EXIT_INVALID_INPUT" false "Choose a different task as parent"
      else
        log_error "Task cannot be its own parent"
      fi
      exit "${EXIT_INVALID_INPUT:-2}"
    fi

    # Validate parent exists
    if ! validate_parent_exists "$NEW_PARENT_ID" "$TODO_FILE"; then
      if [[ "$FORMAT" == "json" ]]; then
        output_error "$E_PARENT_NOT_FOUND" "Parent task not found: $NEW_PARENT_ID" "$EXIT_PARENT_NOT_FOUND" true "Use 'ct exists $NEW_PARENT_ID' to verify task ID"
      else
        log_error "Parent task not found: $NEW_PARENT_ID"
      fi
      exit "${EXIT_PARENT_NOT_FOUND:-10}"
    fi

    # Validate max depth (would this exceed 3 levels?)
    if ! validate_max_depth "$NEW_PARENT_ID" "$TODO_FILE"; then
      if [[ "$FORMAT" == "json" ]]; then
        output_error "$E_DEPTH_EXCEEDED" "Cannot set parent to $NEW_PARENT_ID: max hierarchy depth (3) would be exceeded" "$EXIT_DEPTH_EXCEEDED" false "Refactor task hierarchy to reduce nesting depth"
      else
        log_error "Cannot set parent to $NEW_PARENT_ID: max hierarchy depth (3) would be exceeded"
      fi
      exit "${EXIT_DEPTH_EXCEEDED:-11}"
    fi

    # Validate max siblings
    if ! validate_max_siblings "$NEW_PARENT_ID" "$TODO_FILE"; then
      max_sibs=$(get_max_siblings)
      if [[ "$FORMAT" == "json" ]]; then
        output_error "$E_SIBLING_LIMIT" "Cannot set parent to $NEW_PARENT_ID: max siblings ($max_sibs) exceeded" "$EXIT_SIBLING_LIMIT" false "Complete tasks, set hierarchy.maxSiblings=0 for unlimited, or group under new epic"
      else
        log_error "Cannot set parent to $NEW_PARENT_ID: max siblings ($max_sibs) exceeded"
        log_info "Tip: Set hierarchy.maxSiblings in config, or use 0 for unlimited"
      fi
      exit "${EXIT_SIBLING_LIMIT:-12}"
    fi

    # Validate parent type (subtasks can't have children)
    if ! validate_parent_type "$NEW_PARENT_ID" "$TODO_FILE"; then
      if [[ "$FORMAT" == "json" ]]; then
        output_error "$E_INVALID_PARENT_TYPE" "Cannot set parent to $NEW_PARENT_ID: subtasks cannot have children" "$EXIT_INVALID_PARENT_TYPE" false "Choose a task or epic as parent instead of a subtask"
      else
        log_error "Cannot set parent to $NEW_PARENT_ID: subtasks cannot have children"
      fi
      exit "${EXIT_INVALID_PARENT_TYPE:-13}"
    fi
  fi
fi

# Cross-validate type and parent constraints (use jq-helpers if available)
if declare -f get_task_field >/dev/null 2>&1; then
  CURRENT_TYPE=$(get_task_field "$TASK" "type")
  [[ -z "$CURRENT_TYPE" ]] && CURRENT_TYPE="task"
  CURRENT_PARENT=$(get_task_field "$TASK" "parentId")
else
  CURRENT_TYPE=$(echo "$TASK" | jq -r '.type // "task"')
  CURRENT_PARENT=$(echo "$TASK" | jq -r '.parentId // ""')
fi
FINAL_TYPE="${NEW_TYPE:-$CURRENT_TYPE}"
FINAL_PARENT="${NEW_PARENT_ID:-$CURRENT_PARENT}"

# Epic cannot have parent
if [[ "$FINAL_TYPE" == "epic" && -n "$FINAL_PARENT" && "$FINAL_PARENT" != "" ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    output_error "$E_INPUT_INVALID" "Epic tasks cannot have a parent - they must be root-level" "$EXIT_VALIDATION_ERROR" false "Remove --parent flag or change --type to task|subtask"
  else
    log_error "Epic tasks cannot have a parent - they must be root-level"
  fi
  exit "${EXIT_VALIDATION_ERROR:-6}"
fi

# Subtask requires parent
if [[ "$FINAL_TYPE" == "subtask" && ( -z "$FINAL_PARENT" || "$FINAL_PARENT" == "" ) ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    output_error "$E_INPUT_INVALID" "Subtask tasks require a parent - specify with --parent" "$EXIT_VALIDATION_ERROR" false "Add --parent T### flag or change --type to task|epic"
  else
    log_error "Subtask tasks require a parent"
  fi
  exit "${EXIT_VALIDATION_ERROR:-6}"
fi

# Add new phase if --add-phase flag is set and phase doesn't exist
if [[ "$ADD_PHASE" == "true" ]] && [[ -n "$NEW_PHASE" ]]; then
  add_new_phase "$NEW_PHASE"
fi

# Check for circular dependencies when updating dependencies (configurable)
if [[ -n "$DEPENDS_TO_ADD" || -n "$DEPENDS_TO_SET" ]]; then
  # Check if dependency validation is enabled
  VALIDATE_DEPS=true
  if declare -f is_dependency_validation_enabled >/dev/null 2>&1; then
    VALIDATE_DEPS=$(is_dependency_validation_enabled)
  fi

  if [[ "$VALIDATE_DEPS" == "true" ]]; then
    # Get current dependencies
    CURRENT_DEPS=$(echo "$TASK" | jq -r '.depends // [] | join(",")')

    # Determine final dependencies after update
    FINAL_DEPS=""
    if [[ -n "$DEPENDS_TO_SET" ]]; then
      FINAL_DEPS="$DEPENDS_TO_SET"
    elif [[ -n "$DEPENDS_TO_ADD" ]]; then
      if [[ -n "$CURRENT_DEPS" ]]; then
        FINAL_DEPS="$CURRENT_DEPS,$DEPENDS_TO_ADD"
      else
        FINAL_DEPS="$DEPENDS_TO_ADD"
      fi
    fi

    if [[ -n "$FINAL_DEPS" ]]; then
      # Check if circular dependency detection is enabled
      DETECT_CIRCULAR=true
      if declare -f is_circular_dep_detection_enabled >/dev/null 2>&1; then
        DETECT_CIRCULAR=$(is_circular_dep_detection_enabled)
      fi

      if [[ "$DETECT_CIRCULAR" == "true" ]]; then
        if ! check_circular_dependencies "$TODO_FILE" "$TASK_ID" "$FINAL_DEPS"; then
          if [[ "$FORMAT" == "json" ]]; then
            output_error "$E_VALIDATION_SCHEMA" "Cannot update task: would create circular dependency" "$EXIT_VALIDATION_ERROR" true "Review dependency chain and remove circular references"
          else
            log_error "Cannot update task: would create circular dependency"
          fi
          exit "${EXIT_VALIDATION_ERROR:-6}"
        fi
      fi
    fi
  fi
fi

# Check if any update requested
if [[ -z "$NEW_TITLE" && -z "$NEW_STATUS" && -z "$NEW_PRIORITY" && \
      -z "$NEW_DESCRIPTION" && -z "$NEW_PHASE" && -z "$NEW_BLOCKED_BY" && \
      -z "$NEW_TYPE" && -z "$NEW_PARENT_ID" && -z "$NEW_SIZE" && \
      -z "$NEW_NOAUTOCOMPLETE" && \
      -z "$LABELS_TO_ADD" && -z "$LABELS_TO_SET" && "$CLEAR_LABELS" == false && \
      -z "$FILES_TO_ADD" && -z "$FILES_TO_SET" && "$CLEAR_FILES" == false && \
      -z "$ACCEPTANCE_TO_ADD" && -z "$ACCEPTANCE_TO_SET" && "$CLEAR_ACCEPTANCE" == false && \
      -z "$DEPENDS_TO_ADD" && -z "$DEPENDS_TO_SET" && "$CLEAR_DEPENDS" == false && \
      -z "$NOTE_TO_ADD" ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    output_error "$E_INPUT_MISSING" "No updates specified" "$EXIT_INVALID_INPUT" true "Provide at least one update option (--title, --status, --priority, etc.)"
  else
    log_error "No updates specified"
    echo "Use --help to see available options" >&2
  fi
  exit "${EXIT_INVALID_INPUT:-2}"
fi

# Check single active task constraint
if [[ "$NEW_STATUS" == "active" && "$CURRENT_STATUS" != "active" ]]; then
  # Check if parallel agents are allowed (skip constraint entirely)
  allow_parallel=$(jq -r '.session.allowParallelAgents // false' "$CONFIG_FILE" 2>/dev/null || echo "false")

  if [[ "$allow_parallel" != "true" ]]; then
    # Check if multi-session mode is enabled
    multi_session_enabled=$(jq -r '.multiSession.enabled // false' "$CONFIG_FILE" 2>/dev/null || echo "false")

    if [[ "$multi_session_enabled" == "true" ]]; then
      # Multi-session mode: check active tasks within current session scope only
      session_info=""
      if declare -f get_active_session_info >/dev/null 2>&1; then
        session_info=$(get_active_session_info 2>/dev/null) || session_info=""
      fi

      if [[ -n "$session_info" ]]; then
        # Get computed task IDs from session scope and check for active tasks within scope
        active_count=$(echo "$session_info" | jq -r '.scope.computedTaskIds // []' | \
          jq --slurpfile todo "$TODO_FILE" '
            . as $scope |
            $todo[0].tasks | map(select(.status == "active" and (.id as $id | $scope | index($id)))) | length
          ')
      else
        # No active session - fall back to global check (use jq-helper if available)
        if declare -f count_tasks_by_status >/dev/null 2>&1; then
          active_count=$(count_tasks_by_status "active" "$TODO_FILE")
        else
          active_count=$(jq '[.tasks[] | select(.status == "active")] | length' "$TODO_FILE")
        fi
      fi
    else
      # Single-session mode: global check (use jq-helper if available)
      if declare -f count_tasks_by_status >/dev/null 2>&1; then
        active_count=$(count_tasks_by_status "active" "$TODO_FILE")
      else
        active_count=$(jq '[.tasks[] | select(.status == "active")] | length' "$TODO_FILE")
      fi
    fi

    if [[ "$active_count" -gt 0 ]]; then
      current_active=$(jq -r '[.tasks[] | select(.status == "active")][0].id' "$TODO_FILE")
      if [[ "$FORMAT" == "json" ]]; then
        output_error "$E_VALIDATION_REQUIRED" "Cannot set status to active: only ONE active task allowed (current: $current_active)" "$EXIT_VALIDATION_ERROR" true "Use 'cleo focus set $TASK_ID' to change active task"
      else
        log_error "Cannot set status to active: only ONE active task allowed"
        echo "Current active task: $current_active" >&2
      fi
      exit "${EXIT_VALIDATION_ERROR:-6}"
    fi
  fi
fi

# Capture before state for logging and JSON output
BEFORE_STATE=$(echo "$TASK" | jq '{
  title, status, priority, description, phase,
  labels, files, acceptance, depends, blockedBy
}')

# Build changes list for display
CHANGES=()

# Initialize JSON changes object for structured output
CHANGES_JSON="{}"

# Create timestamp
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build the jq update expression dynamically
JQ_UPDATES=""

# Scalar fields
if [[ -n "$NEW_TITLE" ]]; then
  OLD_TITLE=$(echo "$TASK" | jq -r '.title')
  JQ_UPDATES="$JQ_UPDATES | .title = \$new_title"
  CHANGES+=("title: '$OLD_TITLE' → '$NEW_TITLE'")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --arg before "$OLD_TITLE" --arg after "$NEW_TITLE" '.title = {before: $before, after: $after}')
fi

if [[ -n "$NEW_STATUS" ]]; then
  JQ_UPDATES="$JQ_UPDATES | .status = \$new_status"
  CHANGES+=("status: $CURRENT_STATUS → $NEW_STATUS")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --arg before "$CURRENT_STATUS" --arg after "$NEW_STATUS" '.status = {before: $before, after: $after}')
fi

if [[ -n "$NEW_PRIORITY" ]]; then
  OLD_PRIORITY=$(echo "$TASK" | jq -r '.priority // "medium"')
  JQ_UPDATES="$JQ_UPDATES | .priority = \$new_priority"
  CHANGES+=("priority: $OLD_PRIORITY → $NEW_PRIORITY")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --arg before "$OLD_PRIORITY" --arg after "$NEW_PRIORITY" '.priority = {before: $before, after: $after}')
fi

if [[ -n "$NEW_DESCRIPTION" ]]; then
  OLD_DESCRIPTION=$(echo "$TASK" | jq -r '.description // ""')
  JQ_UPDATES="$JQ_UPDATES | .description = \$new_description"
  CHANGES+=("description: updated")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --arg before "$OLD_DESCRIPTION" --arg after "$NEW_DESCRIPTION" '.description = {before: $before, after: $after}')
fi

if [[ -n "$NEW_PHASE" ]]; then
  OLD_PHASE=$(echo "$TASK" | jq -r '.phase // null')
  OLD_PHASE_DISPLAY=$(echo "$TASK" | jq -r '.phase // "(none)"')
  JQ_UPDATES="$JQ_UPDATES | .phase = \$new_phase"
  CHANGES+=("phase: $OLD_PHASE_DISPLAY → $NEW_PHASE")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --arg before "$OLD_PHASE" --arg after "$NEW_PHASE" '.phase = {before: (if $before == "null" then null else $before end), after: $after}')
fi

if [[ -n "$NEW_BLOCKED_BY" ]]; then
  OLD_BLOCKED_BY=$(echo "$TASK" | jq -r '.blockedBy // null')
  JQ_UPDATES="$JQ_UPDATES | .blockedBy = \$new_blocked_by | .status = \"blocked\""
  CHANGES+=("blockedBy: set to '$NEW_BLOCKED_BY'")
  CHANGES+=("status: $CURRENT_STATUS → blocked")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --arg before "$OLD_BLOCKED_BY" --arg after "$NEW_BLOCKED_BY" '.blockedBy = {before: (if $before == "null" then null else $before end), after: $after}')
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --arg before "$CURRENT_STATUS" '.status = {before: $before, after: "blocked"}')
fi

# Hierarchy fields (v0.20.0+)
if [[ -n "$NEW_TYPE" ]]; then
  OLD_TYPE=$(echo "$TASK" | jq -r '.type // "task"')
  JQ_UPDATES="$JQ_UPDATES | .type = \$new_type"
  CHANGES+=("type: $OLD_TYPE → $NEW_TYPE")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --arg before "$OLD_TYPE" --arg after "$NEW_TYPE" '.type = {before: $before, after: $after}')
fi

if [[ -n "$NEW_PARENT_ID" ]]; then
  OLD_PARENT=$(echo "$TASK" | jq -r '.parentId // null')
  OLD_PARENT_DISPLAY="${OLD_PARENT:-"(none)"}"
  if [[ "$NEW_PARENT_ID" == "" ]]; then
    # Remove parent (make root task)
    JQ_UPDATES="$JQ_UPDATES | del(.parentId)"
    CHANGES+=("parentId: $OLD_PARENT_DISPLAY → (removed)")
    CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --arg before "$OLD_PARENT" '.parentId = {before: (if $before == "null" then null else $before end), after: null, action: "removed"}')
  else
    JQ_UPDATES="$JQ_UPDATES | .parentId = \$new_parent_id"
    CHANGES+=("parentId: $OLD_PARENT_DISPLAY → $NEW_PARENT_ID")
    CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --arg before "$OLD_PARENT" --arg after "$NEW_PARENT_ID" '.parentId = {before: (if $before == "null" then null else $before end), after: $after}')
  fi
fi

if [[ -n "$NEW_SIZE" ]]; then
  OLD_SIZE=$(echo "$TASK" | jq -r '.size // null')
  OLD_SIZE_DISPLAY="${OLD_SIZE:-"(none)"}"
  JQ_UPDATES="$JQ_UPDATES | .size = \$new_size"
  CHANGES+=("size: $OLD_SIZE_DISPLAY → $NEW_SIZE")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --arg before "$OLD_SIZE" --arg after "$NEW_SIZE" '.size = {before: (if $before == "null" then null else $before end), after: $after}')
fi

# noAutoComplete field (T1984)
if [[ -n "$NEW_NOAUTOCOMPLETE" ]]; then
  OLD_NOAUTOCOMPLETE=$(echo "$TASK" | jq -r '.noAutoComplete // null')
  OLD_NOAUTOCOMPLETE_DISPLAY="${OLD_NOAUTOCOMPLETE:-"(none)"}"
  if [[ "$NEW_NOAUTOCOMPLETE" == "true" ]]; then
    JQ_UPDATES="$JQ_UPDATES | .noAutoComplete = true"
    CHANGES+=("noAutoComplete: $OLD_NOAUTOCOMPLETE_DISPLAY → true")
  elif [[ "$NEW_NOAUTOCOMPLETE" == "false" ]]; then
    JQ_UPDATES="$JQ_UPDATES | del(.noAutoComplete)"
    CHANGES+=("noAutoComplete: $OLD_NOAUTOCOMPLETE_DISPLAY → (removed)")
  else
    log_error "Invalid --no-auto-complete value: $NEW_NOAUTOCOMPLETE (must be true|false)"
    exit "$EXIT_INVALID_INPUT"
  fi
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --arg before "$OLD_NOAUTOCOMPLETE" --arg after "$NEW_NOAUTOCOMPLETE" '.noAutoComplete = {before: (if $before == "null" then null else ($before | test("true")) end), after: ($after == "true")}')
fi

# Labels array
if [[ "$CLEAR_LABELS" == true ]]; then
  OLD_LABELS=$(echo "$TASK" | jq -c '.labels // []')
  JQ_UPDATES="$JQ_UPDATES | del(.labels)"
  CHANGES+=("labels: cleared")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --argjson before "$OLD_LABELS" '.labels = {before: $before, after: [], action: "cleared"}')
elif [[ -n "$LABELS_TO_SET" ]]; then
  OLD_LABELS=$(echo "$TASK" | jq -c '.labels // []')
  IFS=',' read -ra label_array <<< "$LABELS_TO_SET"
  labels_json=$(printf '%s\n' "${label_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  JQ_UPDATES="$JQ_UPDATES | .labels = $labels_json"
  CHANGES+=("labels: replaced with [$LABELS_TO_SET]")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --argjson before "$OLD_LABELS" --argjson after "$labels_json" '.labels = {before: $before, after: $after, action: "replaced"}')
elif [[ -n "$LABELS_TO_ADD" ]]; then
  OLD_LABELS=$(echo "$TASK" | jq -c '.labels // []')
  IFS=',' read -ra label_array <<< "$LABELS_TO_ADD"
  labels_json=$(printf '%s\n' "${label_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  JQ_UPDATES="$JQ_UPDATES | .labels = ((.labels // []) + $labels_json | unique)"
  CHANGES+=("labels: added [$LABELS_TO_ADD]")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --argjson before "$OLD_LABELS" --argjson added "$labels_json" '.labels = {before: $before, added: $added, action: "appended"}')
fi

# Files array
if [[ "$CLEAR_FILES" == true ]]; then
  OLD_FILES=$(echo "$TASK" | jq -c '.files // []')
  JQ_UPDATES="$JQ_UPDATES | del(.files)"
  CHANGES+=("files: cleared")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --argjson before "$OLD_FILES" '.files = {before: $before, after: [], action: "cleared"}')
elif [[ -n "$FILES_TO_SET" ]]; then
  OLD_FILES=$(echo "$TASK" | jq -c '.files // []')
  IFS=',' read -ra files_array <<< "$FILES_TO_SET"
  files_json=$(printf '%s\n' "${files_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  JQ_UPDATES="$JQ_UPDATES | .files = $files_json"
  CHANGES+=("files: replaced")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --argjson before "$OLD_FILES" --argjson after "$files_json" '.files = {before: $before, after: $after, action: "replaced"}')
elif [[ -n "$FILES_TO_ADD" ]]; then
  OLD_FILES=$(echo "$TASK" | jq -c '.files // []')
  IFS=',' read -ra files_array <<< "$FILES_TO_ADD"
  files_json=$(printf '%s\n' "${files_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  JQ_UPDATES="$JQ_UPDATES | .files = ((.files // []) + $files_json | unique)"
  CHANGES+=("files: added [$FILES_TO_ADD]")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --argjson before "$OLD_FILES" --argjson added "$files_json" '.files = {before: $before, added: $added, action: "appended"}')
fi

# Acceptance array
if [[ "$CLEAR_ACCEPTANCE" == true ]]; then
  OLD_ACCEPTANCE=$(echo "$TASK" | jq -c '.acceptance // []')
  JQ_UPDATES="$JQ_UPDATES | del(.acceptance)"
  CHANGES+=("acceptance: cleared")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --argjson before "$OLD_ACCEPTANCE" '.acceptance = {before: $before, after: [], action: "cleared"}')
elif [[ -n "$ACCEPTANCE_TO_SET" ]]; then
  OLD_ACCEPTANCE=$(echo "$TASK" | jq -c '.acceptance // []')
  IFS=',' read -ra acc_array <<< "$ACCEPTANCE_TO_SET"
  acc_json=$(printf '%s\n' "${acc_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  JQ_UPDATES="$JQ_UPDATES | .acceptance = $acc_json"
  CHANGES+=("acceptance: replaced")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --argjson before "$OLD_ACCEPTANCE" --argjson after "$acc_json" '.acceptance = {before: $before, after: $after, action: "replaced"}')
elif [[ -n "$ACCEPTANCE_TO_ADD" ]]; then
  OLD_ACCEPTANCE=$(echo "$TASK" | jq -c '.acceptance // []')
  IFS=',' read -ra acc_array <<< "$ACCEPTANCE_TO_ADD"
  acc_json=$(printf '%s\n' "${acc_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  JQ_UPDATES="$JQ_UPDATES | .acceptance = ((.acceptance // []) + $acc_json)"
  CHANGES+=("acceptance: added criteria")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --argjson before "$OLD_ACCEPTANCE" --argjson added "$acc_json" '.acceptance = {before: $before, added: $added, action: "appended"}')
fi

# Depends array
if [[ "$CLEAR_DEPENDS" == true ]]; then
  OLD_DEPENDS=$(echo "$TASK" | jq -c '.depends // []')
  JQ_UPDATES="$JQ_UPDATES | del(.depends)"
  CHANGES+=("depends: cleared")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --argjson before "$OLD_DEPENDS" '.depends = {before: $before, after: [], action: "cleared"}')
elif [[ -n "$DEPENDS_TO_SET" ]]; then
  OLD_DEPENDS=$(echo "$TASK" | jq -c '.depends // []')
  IFS=',' read -ra dep_array <<< "$DEPENDS_TO_SET"
  dep_json=$(printf '%s\n' "${dep_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  JQ_UPDATES="$JQ_UPDATES | .depends = $dep_json"
  CHANGES+=("depends: replaced with [$DEPENDS_TO_SET]")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --argjson before "$OLD_DEPENDS" --argjson after "$dep_json" '.depends = {before: $before, after: $after, action: "replaced"}')
elif [[ -n "$DEPENDS_TO_ADD" ]]; then
  OLD_DEPENDS=$(echo "$TASK" | jq -c '.depends // []')
  IFS=',' read -ra dep_array <<< "$DEPENDS_TO_ADD"
  dep_json=$(printf '%s\n' "${dep_array[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
  JQ_UPDATES="$JQ_UPDATES | .depends = ((.depends // []) + $dep_json | unique)"
  CHANGES+=("depends: added [$DEPENDS_TO_ADD]")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --argjson before "$OLD_DEPENDS" --argjson added "$dep_json" '.depends = {before: $before, added: $added, action: "appended"}')
fi

# Notes (always append with timestamp)
if [[ -n "$NOTE_TO_ADD" ]]; then
  timestamp_note="$(date -u +"%Y-%m-%d %H:%M:%S UTC"): $NOTE_TO_ADD"
  OLD_NOTES_COUNT=$(echo "$TASK" | jq 'if .notes then .notes | length else 0 end')
  JQ_UPDATES="$JQ_UPDATES | .notes = ((.notes // []) + [\"$timestamp_note\"])"
  CHANGES+=("notes: added entry")
  CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --arg note "$timestamp_note" --argjson before_count "$OLD_NOTES_COUNT" '.notes = {added: $note, beforeCount: $before_count, action: "appended"}')

  # Auto-detect files from note content (v0.64.0+)
  # Only if files-detect library is available and no explicit file operations requested
  if declare -f detect_files_from_text >/dev/null 2>&1; then
    if [[ -z "$FILES_TO_ADD" && -z "$FILES_TO_SET" && "$CLEAR_FILES" != true ]]; then
      DETECTED_FILES=$(detect_files_from_text "$NOTE_TO_ADD")
      DETECTED_COUNT=$(echo "$DETECTED_FILES" | jq 'length')

      if [[ "$DETECTED_COUNT" -gt 0 ]]; then
        OLD_FILES=$(echo "$TASK" | jq -c '.files // []')
        # Merge detected files with existing files
        MERGED_FILES=$(merge_files_arrays "$OLD_FILES" "$DETECTED_FILES")
        ADDED_FILES_COUNT=$(echo "$MERGED_FILES" | jq --argjson old "$OLD_FILES" '. - $old | length')

        if [[ "$ADDED_FILES_COUNT" -gt 0 ]]; then
          JQ_UPDATES="$JQ_UPDATES | .files = $MERGED_FILES"
          CHANGES+=("files: auto-detected $ADDED_FILES_COUNT from notes")
          CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --argjson before "$OLD_FILES" --argjson detected "$DETECTED_FILES" --argjson after "$MERGED_FILES" '.filesAutoDetected = {before: $before, detected: $detected, after: $after, action: "auto-merged"}')
        fi
      fi
    fi
  fi

  # Auto-extract cross-references from note content (v0.65.0+)
  # Detects task IDs mentioned in notes and adds to relates array
  if declare -f extract_task_refs >/dev/null 2>&1; then
    DETECTED_REFS=$(extract_task_refs "$NOTE_TO_ADD" "$TASK_ID")
    DETECTED_REFS_COUNT=$(echo "$DETECTED_REFS" | jq 'length')

    if [[ "$DETECTED_REFS_COUNT" -gt 0 ]]; then
      # Create relates entries for detected task refs (type: relates-to, auto-detected)
      DETECTED_RELATES=$(create_relates_entries "$DETECTED_REFS" "relates-to")
      OLD_RELATES=$(echo "$TASK" | jq -c '.relates // []')

      # Merge with existing relates entries (existing take precedence)
      MERGED_RELATES=$(merge_relates_arrays "$OLD_RELATES" "$DETECTED_RELATES")
      ADDED_RELATES_COUNT=$(echo "$MERGED_RELATES" | jq --argjson old "$OLD_RELATES" '. | length - ($old | length)')

      if [[ "$ADDED_RELATES_COUNT" -gt 0 ]]; then
        JQ_UPDATES="$JQ_UPDATES | .relates = $MERGED_RELATES"
        CHANGES+=("relates: auto-detected $ADDED_RELATES_COUNT from notes")
        CHANGES_JSON=$(echo "$CHANGES_JSON" | jq --argjson before "$OLD_RELATES" --argjson detected "$DETECTED_RELATES" --argjson after "$MERGED_RELATES" '.relatesAutoDetected = {before: $before, detected: $detected, after: $after, action: "auto-merged"}')
      fi
    fi
  fi
fi

# Strip leading pipe if present
JQ_UPDATES="${JQ_UPDATES# | }"

# Add updatedAt timestamp to all mutations (T2067 - centralized mutation support)
# This ensures every task update sets the updatedAt field per schema v2.8.0+
if [[ -n "$JQ_UPDATES" ]]; then
  JQ_UPDATES="$JQ_UPDATES | .updatedAt = \$ts"
fi

# ============================================================================
# IDEMPOTENCY CHECK: Detect if any actual changes would be made
# Per LLM-AGENT-FIRST-SPEC.md Part 5.6 - Idempotency Requirements
# ============================================================================

# Check if all requested changes match current values (no-op scenario)
# This enables safe retry behavior for agents - retrying an update that already
# succeeded returns EXIT_NO_CHANGE (102) instead of writing duplicate data
check_idempotent_no_change() {
    local has_actual_change=false

    # Scalar fields - compare before vs requested values
    if [[ -n "$NEW_TITLE" ]]; then
        local current_title
        current_title=$(echo "$TASK" | jq -r '.title')
        [[ "$current_title" != "$NEW_TITLE" ]] && has_actual_change=true
    fi

    if [[ -n "$NEW_STATUS" ]]; then
        [[ "$CURRENT_STATUS" != "$NEW_STATUS" ]] && has_actual_change=true
    fi

    if [[ -n "$NEW_PRIORITY" ]]; then
        local current_priority
        current_priority=$(echo "$TASK" | jq -r '.priority // "medium"')
        [[ "$current_priority" != "$NEW_PRIORITY" ]] && has_actual_change=true
    fi

    if [[ -n "$NEW_DESCRIPTION" ]]; then
        local current_description
        current_description=$(echo "$TASK" | jq -r '.description // ""')
        [[ "$current_description" != "$NEW_DESCRIPTION" ]] && has_actual_change=true
    fi

    if [[ -n "$NEW_PHASE" ]]; then
        local current_phase
        current_phase=$(echo "$TASK" | jq -r '.phase // ""')
        [[ "$current_phase" != "$NEW_PHASE" ]] && has_actual_change=true
    fi

    if [[ -n "$NEW_BLOCKED_BY" ]]; then
        local current_blocked_by
        current_blocked_by=$(echo "$TASK" | jq -r '.blockedBy // ""')
        [[ "$current_blocked_by" != "$NEW_BLOCKED_BY" ]] && has_actual_change=true
    fi

    # Hierarchy fields
    if [[ -n "$NEW_TYPE" ]]; then
        local current_type
        current_type=$(echo "$TASK" | jq -r '.type // "task"')
        [[ "$current_type" != "$NEW_TYPE" ]] && has_actual_change=true
    fi

    if [[ -n "$NEW_PARENT_ID" ]]; then
        local current_parent
        current_parent=$(echo "$TASK" | jq -r '.parentId // ""')
        # Handle removal case (empty string means remove parent)
        if [[ "$NEW_PARENT_ID" == "" ]]; then
            [[ -n "$current_parent" && "$current_parent" != "null" ]] && has_actual_change=true
        else
            [[ "$current_parent" != "$NEW_PARENT_ID" ]] && has_actual_change=true
        fi
    fi

    if [[ -n "$NEW_SIZE" ]]; then
        local current_size
        current_size=$(echo "$TASK" | jq -r '.size // ""')
        [[ "$current_size" != "$NEW_SIZE" ]] && has_actual_change=true
    fi

    if [[ -n "$NEW_NOAUTOCOMPLETE" ]]; then
        local current_noautocomplete
        current_noautocomplete=$(echo "$TASK" | jq -r '.noAutoComplete // "null"')
        # Convert to comparable format
        if [[ "$NEW_NOAUTOCOMPLETE" == "true" ]]; then
            [[ "$current_noautocomplete" != "true" ]] && has_actual_change=true
        elif [[ "$NEW_NOAUTOCOMPLETE" == "false" ]]; then
            [[ "$current_noautocomplete" == "true" ]] && has_actual_change=true
        fi
    fi

    # Array operations - clear and set always checked for actual effect
    if [[ "$CLEAR_LABELS" == true ]]; then
        # Only a change if there are labels to clear
        local label_count
        label_count=$(echo "$TASK" | jq '.labels // [] | length')
        [[ "$label_count" -gt 0 ]] && has_actual_change=true
    elif [[ -n "$LABELS_TO_SET" ]]; then
        # Check if new labels differ from current
        local current_labels new_labels
        current_labels=$(echo "$TASK" | jq -c '.labels // [] | sort')
        IFS=',' read -ra label_arr <<< "$LABELS_TO_SET"
        new_labels=$(printf '%s\n' "${label_arr[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";"")) | sort')
        [[ "$current_labels" != "$new_labels" ]] && has_actual_change=true
    elif [[ -n "$LABELS_TO_ADD" ]]; then
        # Check if labels to add are already present
        local current_labels new_label_exists
        current_labels=$(echo "$TASK" | jq -c '.labels // []')
        IFS=',' read -ra add_labels_arr <<< "$LABELS_TO_ADD"
        for lbl in "${add_labels_arr[@]}"; do
            lbl=$(echo "$lbl" | xargs)
            new_label_exists=$(echo "$current_labels" | jq --arg l "$lbl" 'index($l) != null')
            [[ "$new_label_exists" != "true" ]] && has_actual_change=true
        done
    fi

    if [[ "$CLEAR_FILES" == true ]]; then
        local file_count
        file_count=$(echo "$TASK" | jq '.files // [] | length')
        [[ "$file_count" -gt 0 ]] && has_actual_change=true
    elif [[ -n "$FILES_TO_SET" ]]; then
        local current_files new_files
        current_files=$(echo "$TASK" | jq -c '.files // [] | sort')
        IFS=',' read -ra file_arr <<< "$FILES_TO_SET"
        new_files=$(printf '%s\n' "${file_arr[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";"")) | sort')
        [[ "$current_files" != "$new_files" ]] && has_actual_change=true
    elif [[ -n "$FILES_TO_ADD" ]]; then
        local current_files new_file_exists
        current_files=$(echo "$TASK" | jq -c '.files // []')
        IFS=',' read -ra add_files_arr <<< "$FILES_TO_ADD"
        for f in "${add_files_arr[@]}"; do
            f=$(echo "$f" | xargs)
            new_file_exists=$(echo "$current_files" | jq --arg f "$f" 'index($f) != null')
            [[ "$new_file_exists" != "true" ]] && has_actual_change=true
        done
    fi

    if [[ "$CLEAR_ACCEPTANCE" == true ]]; then
        local acc_count
        acc_count=$(echo "$TASK" | jq '.acceptance // [] | length')
        [[ "$acc_count" -gt 0 ]] && has_actual_change=true
    elif [[ -n "$ACCEPTANCE_TO_SET" ]]; then
        local current_acc new_acc
        current_acc=$(echo "$TASK" | jq -c '.acceptance // []')
        IFS=',' read -ra acc_arr <<< "$ACCEPTANCE_TO_SET"
        new_acc=$(printf '%s\n' "${acc_arr[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";""))')
        [[ "$current_acc" != "$new_acc" ]] && has_actual_change=true
    elif [[ -n "$ACCEPTANCE_TO_ADD" ]]; then
        # Adding acceptance criteria is always a change (they append, don't dedupe)
        has_actual_change=true
    fi

    if [[ "$CLEAR_DEPENDS" == true ]]; then
        local dep_count
        dep_count=$(echo "$TASK" | jq '.depends // [] | length')
        [[ "$dep_count" -gt 0 ]] && has_actual_change=true
    elif [[ -n "$DEPENDS_TO_SET" ]]; then
        local current_deps new_deps
        current_deps=$(echo "$TASK" | jq -c '.depends // [] | sort')
        IFS=',' read -ra dep_arr <<< "$DEPENDS_TO_SET"
        new_deps=$(printf '%s\n' "${dep_arr[@]}" | jq -R . | jq -s 'map(gsub("^\\s+|\\s+$";"")) | sort')
        [[ "$current_deps" != "$new_deps" ]] && has_actual_change=true
    elif [[ -n "$DEPENDS_TO_ADD" ]]; then
        local current_deps new_dep_exists
        current_deps=$(echo "$TASK" | jq -c '.depends // []')
        IFS=',' read -ra add_deps_arr <<< "$DEPENDS_TO_ADD"
        for dep in "${add_deps_arr[@]}"; do
            dep=$(echo "$dep" | xargs)
            new_dep_exists=$(echo "$current_deps" | jq --arg d "$dep" 'index($d) != null')
            [[ "$new_dep_exists" != "true" ]] && has_actual_change=true
        done
    fi

    # Notes always add (append-only), so they always constitute a change
    [[ -n "$NOTE_TO_ADD" ]] && has_actual_change=true

    echo "$has_actual_change"
}

HAS_CHANGES=$(check_idempotent_no_change)

if [[ "$HAS_CHANGES" == "false" ]]; then
    # No actual changes - return idempotent success
    if [[ "$FORMAT" == "json" ]]; then
        jq -nc \
            --arg version "${CLEO_VERSION:-$(get_version)}" \
            --arg command "$COMMAND_NAME" \
            --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
            --arg task_id "$TASK_ID" \
            --argjson task "$TASK" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "command": $command,
                    "timestamp": $timestamp,
                    "version": $version
                },
                "success": true,
                "noChange": true,
                "taskId": $task_id,
                "task": $task,
                "message": "No changes needed - task already has these values"
            }'
    else
        [[ "$QUIET" != true ]] && log_info "No changes needed for $TASK_ID - task already has these values"
    fi
    exit "${EXIT_NO_CHANGE:-102}"
fi

# ============================================================================
# END IDEMPOTENCY CHECK
# ============================================================================

# Calculate what the updated task would look like (for dry-run and JSON output)
UPDATED_TODO=$(jq --arg id "$TASK_ID" \
  --arg new_title "$NEW_TITLE" \
  --arg new_status "$NEW_STATUS" \
  --arg new_priority "$NEW_PRIORITY" \
  --arg new_description "$NEW_DESCRIPTION" \
  --arg new_phase "$NEW_PHASE" \
  --arg new_blocked_by "$NEW_BLOCKED_BY" \
  --arg new_type "$NEW_TYPE" \
  --arg new_parent_id "$NEW_PARENT_ID" \
  --arg new_size "$NEW_SIZE" \
  --arg ts "$TIMESTAMP" "
  .tasks |= map(
    if .id == \$id then
      $JQ_UPDATES
    else . end
  ) |
  .lastUpdated = \$ts
" "$TODO_FILE")

# Get the updated task for output
UPDATED_TASK=$(echo "$UPDATED_TODO" | jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)')

# Handle dry-run mode
if [[ "$DRY_RUN" == true ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    # JSON dry-run output (LLM-Agent-First Spec v3.0 compliant)
    jq -nc \
      --arg version "${CLEO_VERSION:-$(get_version)}" \
      --arg command "$COMMAND_NAME" \
      --arg timestamp "$TIMESTAMP" \
      --arg task_id "$TASK_ID" \
      --argjson changes "$CHANGES_JSON" \
      --argjson task "$UPDATED_TASK" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "command": $command,
          "timestamp": $timestamp,
          "version": $version
        },
        "success": true,
        "dryRun": true,
        "wouldUpdate": {
          "taskId": $task_id,
          "changes": $changes,
          "resultingTask": $task
        }
      }'
  else
    # Text dry-run output
    if [[ "$QUIET" != true ]]; then
      log_info "[DRY RUN] Would update task $TASK_ID"
      echo ""
      echo -e "${BLUE}Task ID:${NC} $TASK_ID"
      echo -e "${BLUE}Changes (not applied):${NC}"
      for change in "${CHANGES[@]}"; do
        echo "  • $change"
      done
      echo ""
      echo "Use without --dry-run to apply changes."
    fi
  fi
  exit "${EXIT_NO_CHANGE:-102}"
fi

# Recalculate checksum
NEW_TASKS=$(echo "$UPDATED_TODO" | jq -c '.tasks')
NEW_CHECKSUM=$(echo "$NEW_TASKS" | sha256sum | cut -c1-16)

FINAL_JSON=$(echo "$UPDATED_TODO" | jq --arg checksum "$NEW_CHECKSUM" '
  ._meta.checksum = $checksum
')

# Atomic write using library's save_json with file locking
if ! save_json "$TODO_FILE" "$FINAL_JSON"; then
  if [[ "$FORMAT" == "json" ]]; then
    output_error "$E_FILE_WRITE_ERROR" "Failed to write todo file" "$EXIT_FILE_ERROR" false "Check file permissions and disk space"
  else
    log_error "Failed to write todo file"
  fi
  exit "${EXIT_FILE_ERROR:-3}"
fi

# Capture after state (re-read from file to get actual saved state)
AFTER_STATE=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | {
  title, status, priority, description, phase,
  labels, files, acceptance, depends, blockedBy
}' "$TODO_FILE")

# Get full updated task for JSON output
FINAL_TASK=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE")

# Log the operation (suppress output in JSON mode to keep stdout clean)
if [[ -f "$LOG_SCRIPT" ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    "$LOG_SCRIPT" \
      --action "task_updated" \
      --task-id "$TASK_ID" \
      --before "$BEFORE_STATE" \
      --after "$AFTER_STATE" \
      --details '{"operation":"update"}' \
      --actor "system" >/dev/null 2>&1 || true
  else
    "$LOG_SCRIPT" \
      --action "task_updated" \
      --task-id "$TASK_ID" \
      --before "$BEFORE_STATE" \
      --after "$AFTER_STATE" \
      --details '{"operation":"update"}' \
      --actor "system" 2>/dev/null || log_warn "Failed to write log entry"
  fi
fi

# Success output
if [[ "$FORMAT" == "json" ]]; then
  # JSON success output
  jq -nc \
    --arg version "${CLEO_VERSION:-$(get_version)}" \
    --arg command "$COMMAND_NAME" \
    --arg timestamp "$TIMESTAMP" \
    --arg task_id "$TASK_ID" \
    --argjson changes "$CHANGES_JSON" \
    --argjson task "$FINAL_TASK" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "format": "json",
        "command": $command,
        "timestamp": $timestamp,
        "version": $version
      },
      "success": true,
      "taskId": $task_id,
      "changes": $changes,
      "task": $task
    }'
else
  # Text success output
  if [[ "$QUIET" != true ]]; then
    log_info "Task $TASK_ID updated successfully"
    echo ""
    echo -e "${BLUE}Task ID:${NC} $TASK_ID"
    echo -e "${BLUE}Changes:${NC}"
    for change in "${CHANGES[@]}"; do
      echo "  • $change"
    done
    echo ""
    echo "View with: jq '.tasks[] | select(.id == \"$TASK_ID\")' $TODO_FILE"
  fi
fi

exit "${EXIT_SUCCESS:-0}"
