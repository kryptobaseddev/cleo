#!/usr/bin/env bash
# CLEO Validate Script
# Validate todo.json against schema and business rules
set -euo pipefail
# Note: Not using -e because we track errors manually

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
SCHEMA_DIR="${SCHEMA_DIR:-$CLEO_HOME/schemas}"
LOG_FILE="${LOG_FILE:-.cleo/todo-log.json}"

# Command name for error-json library
COMMAND_NAME="validate"

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

# Source backup library for creating safety backups
if [[ -f "$LIB_DIR/backup.sh" ]]; then
  # shellcheck source=../lib/backup.sh
  source "$LIB_DIR/backup.sh"
fi

# Source file-ops library for atomic writes with locking
if [[ -f "$LIB_DIR/file-ops.sh" ]]; then
  # shellcheck source=../lib/file-ops.sh
  source "$LIB_DIR/file-ops.sh"
fi

# Source output formatting library
if [[ -f "$LIB_DIR/output-format.sh" ]]; then
  # shellcheck source=../lib/output-format.sh
  source "$LIB_DIR/output-format.sh"
fi

# Source error JSON library (includes exit-codes.sh)
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  # shellcheck source=../lib/error-json.sh
  source "$LIB_DIR/error-json.sh"
elif [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  # Fallback: source exit codes directly if error-json.sh not available
  # shellcheck source=../lib/exit-codes.sh
  source "$LIB_DIR/exit-codes.sh"
fi

# Source injection libraries for agent documentation validation
if [[ -f "$LIB_DIR/injection-config.sh" ]]; then
  # shellcheck source=../lib/injection-config.sh
  source "$LIB_DIR/injection-config.sh"
fi

if [[ -f "$LIB_DIR/injection.sh" ]]; then
  # shellcheck source=../lib/injection.sh
  source "$LIB_DIR/injection.sh"
fi

# Source config library for validation settings
if [[ -f "$LIB_DIR/config.sh" ]]; then
  # shellcheck source=../lib/config.sh
  source "$LIB_DIR/config.sh"
fi

# Source hierarchy library for orphan detection (T341)
if [[ -f "$LIB_DIR/hierarchy.sh" ]]; then
  # shellcheck source=../lib/hierarchy.sh
  source "$LIB_DIR/hierarchy.sh"
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

# Source version library for app version
if [[ -f "$LIB_DIR/version.sh" ]]; then
  # shellcheck source=../lib/version.sh
  source "$LIB_DIR/version.sh"
fi
# VERSION from central location (compliant pattern)
if [[ -f "$CLEO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLEO_HOME/VERSION" 2>/dev/null | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(cat "$SCRIPT_DIR/../VERSION" 2>/dev/null | tr -d '[:space:]')"
else
  VERSION="${CLEO_VERSION:-unknown}"
fi

# Defaults
STRICT=""  # Empty means use config, explicit true/false overrides
FIX=false
JSON_OUTPUT=false
QUIET=false
FORMAT=""
NON_INTERACTIVE=false
CHECK_ORPHANS=""  # Empty means use config, explicit true/false overrides
FIX_ORPHANS=""    # Empty means no fix, "unlink" or "delete" for repair mode

# Track validation results
ERRORS=0
WARNINGS=0

# Track validation details for JSON output
declare -a DETAILS_JSON=()

# Helper to add a check result to details
# Uses jq for proper JSON escaping (handles newlines, quotes, control chars)
add_detail() {
  local check="$1"
  local status="$2"  # ok, error, warning, fixed
  local message="$3"
  DETAILS_JSON+=("$(jq -nc --arg check "$check" --arg status "$status" --arg message "$message" \
    '{check:$check,status:$status,message:$message}')")
}

usage() {
  cat << EOF
Usage: cleo validate [OPTIONS]

Validate todo.json against schema and business rules.

Options:
  --strict            Treat warnings as errors
  --fix               Auto-fix simple issues (interactive for conflicts)
  --non-interactive   Use auto-selection for conflict resolution (with --fix)
  --json              Output as JSON (same as --format json)
  --format, -f        Output format: text (default) or json
  --quiet, -q         Suppress info messages (show only errors/warnings)
  -h, --help          Show this help

Validations:
  - JSON syntax
  - No duplicate task IDs (in todo.json, archive, and cross-file)
  - Only ONE active task
  - Only ONE active phase
  - All depends[] references exist
  - No circular dependencies
  - blocked tasks have blockedBy
  - done tasks have completedAt
  - focus.currentTask matches active task
  - Checksum integrity
EOF
  exit "${EXIT_SUCCESS:-0}"
}

log_error() {
  local check_name="${2:-unknown}"
  # In JSON mode, don't output intermediate messages - only final summary
  if [[ "$JSON_OUTPUT" != true ]]; then
    echo -e "${RED}[ERROR]${NC} $1"
  fi
  add_detail "$check_name" "error" "$1"
  ERRORS=$((ERRORS + 1))
}

# output_fatal - For critical errors that should stop execution immediately
# Uses output_error from error-json.sh for format-aware error output
# Callers must pass EXIT_* constant as third parameter for compliance
output_fatal() {
  local error_code="${1:-$E_UNKNOWN}"
  local message="$2"
  local exit_with="${3:-${EXIT_GENERAL_ERROR:-1}}"
  # Use || true to prevent set -e from exiting before our explicit exit
  output_error "$error_code" "$message" || true
  exit "$exit_with"
}

log_warn() {
  local check_name="${2:-unknown}"
  # In JSON mode, don't output intermediate messages - only final summary
  if [[ "$JSON_OUTPUT" != true ]]; then
    echo -e "${YELLOW}[WARN]${NC} $1"
  fi
  add_detail "$check_name" "warning" "$1"
  WARNINGS=$((WARNINGS + 1))
}

log_info() {
  local check_name="${2:-unknown}"
  if [[ "$QUIET" == true ]]; then
    # Still add to details even in quiet mode
    add_detail "$check_name" "ok" "$1"
    return
  fi
  if [[ "$JSON_OUTPUT" != true ]]; then
    echo -e "${GREEN}[OK]${NC} $1"
  fi
  add_detail "$check_name" "ok" "$1"
}

#######################################
# Perform atomic JSON write with file locking
# Uses save_json from file-ops.sh if available, falls back to basic atomic write
# Arguments:
#   $1 - File path
#   $2 - jq filter to apply
# Returns:
#   0 on success, non-zero on error
#######################################
safe_json_write() {
  local file="$1"
  local jq_filter="$2"
  local jq_args=("${@:3}")
  local new_content

  # Generate new content
  if ! new_content=$(jq "${jq_args[@]}" "$jq_filter" "$file" 2>/dev/null); then
    return 1
  fi

  # Use save_json if available (includes locking via atomic_write)
  if declare -f save_json >/dev/null 2>&1; then
    if ! echo "$new_content" | save_json "$file"; then
      return 1
    fi
  else
    # Fallback: basic atomic write with manual locking
    local lock_fd
    if declare -f lock_file >/dev/null 2>&1; then
      if ! lock_file "$file" lock_fd 5; then
        echo "Error: Could not acquire lock on $file" >&2
        return 1
      fi
    fi

    # Write to temp file and rename atomically
    if ! echo "$new_content" > "${file}.tmp"; then
      if declare -f unlock_file >/dev/null 2>&1; then
        unlock_file "$lock_fd"
      fi
      rm -f "${file}.tmp" 2>/dev/null || true
      return 1
    fi

    if ! mv "${file}.tmp" "$file"; then
      if declare -f unlock_file >/dev/null 2>&1; then
        unlock_file "$lock_fd"
      fi
      rm -f "${file}.tmp" 2>/dev/null || true
      return 1
    fi

    if declare -f unlock_file >/dev/null 2>&1; then
      unlock_file "$lock_fd"
    fi
  fi

  return 0
}

# Check dependencies
check_deps() {
  if ! command -v jq &> /dev/null; then
    output_fatal "$E_DEPENDENCY_MISSING" "jq is required but not installed" "${EXIT_DEPENDENCY_ERROR:-5}"
  fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --strict) STRICT="true"; shift ;;
    --no-strict) STRICT="false"; shift ;;
    --fix) FIX=true; shift ;;
    --non-interactive) NON_INTERACTIVE=true; shift ;;
    --check-orphans) CHECK_ORPHANS=true; shift ;;
    --no-check-orphans) CHECK_ORPHANS=false; shift ;;
    --fix-orphans) 
      FIX_ORPHANS="${2:-unlink}"
      if [[ "$FIX_ORPHANS" != "unlink" && "$FIX_ORPHANS" != "delete" ]]; then
        output_fatal "$E_INPUT_INVALID" "--fix-orphans must be 'unlink' or 'delete', got: $FIX_ORPHANS" "${EXIT_INVALID_INPUT:-2}"
      fi
      shift 2
      ;;
    --json) JSON_OUTPUT=true; FORMAT="json"; shift ;;
    --human) JSON_OUTPUT=false; FORMAT="text"; shift ;;
    -f|--format)
      FORMAT="$2"
      if [[ "$FORMAT" == "json" ]]; then
        JSON_OUTPUT=true
      fi
      shift 2
      ;;
    -q|--quiet) QUIET=true; shift ;;
    -h|--help) usage ;;
    -*) output_fatal "$E_INPUT_INVALID" "Unknown option: $1" "${EXIT_INVALID_INPUT:-2}" ;;
    *) shift ;;
  esac
done

# Resolve format (TTY-aware auto-detection)
FORMAT=$(resolve_format "${FORMAT:-}")
if [[ "$FORMAT" == "json" ]]; then
  JSON_OUTPUT=true
fi

# Resolve strict mode (CLI > config > default)
if [[ -z "$STRICT" ]]; then
  # No CLI flag provided, check config
  if declare -f is_strict_mode >/dev/null 2>&1; then
    STRICT=$(is_strict_mode)
  else
    STRICT="false"
  fi
fi

check_deps

# Check file exists
if [[ ! -f "$TODO_FILE" ]]; then
  output_fatal "$E_FILE_NOT_FOUND" "File not found: $TODO_FILE" "${EXIT_NOT_FOUND:-4}"
fi

# 1. JSON syntax
if ! jq empty "$TODO_FILE" 2>/dev/null; then
  output_fatal "$E_VALIDATION_SCHEMA" "Invalid JSON syntax" "${EXIT_VALIDATION_ERROR:-6}"
fi
log_info "JSON syntax valid" "json_syntax"

# 2. Check for duplicate task IDs
ARCHIVE_FILE="${TODO_FILE%.json}-archive.json"
TASK_IDS=$(jq -r '.tasks[].id' "$TODO_FILE" 2>/dev/null || echo "")
DUPLICATE_IDS=$(echo "$TASK_IDS" | sort | uniq -d)

if [[ -n "$DUPLICATE_IDS" ]]; then
  log_error "Duplicate task IDs found in todo.json: $(echo "$DUPLICATE_IDS" | tr '\n' ', ' | sed 's/,$//')" "duplicate_ids"
  if [[ "$FIX" == true ]]; then
    # Keep only first occurrence of each ID (atomic write with locking)
    if safe_json_write "$TODO_FILE" '
      .tasks |= (
        reduce .[] as $task ([];
          if (map(.id) | index($task.id) | not) then . + [$task] else . end
        )
      )
    '; then
      echo "  Fixed: Removed duplicate tasks (kept first occurrence)"
    else
      log_error "Failed to fix duplicate tasks (could not acquire lock or write failed)"
    fi
  fi
else
  log_info "No duplicate task IDs in todo.json" "duplicate_ids"
fi

# Check archive for duplicates too
if [[ -f "$ARCHIVE_FILE" ]]; then
  ARCHIVE_IDS=$(jq -r '.archivedTasks[].id' "$ARCHIVE_FILE" 2>/dev/null || echo "")
  ARCHIVE_DUPLICATES=$(echo "$ARCHIVE_IDS" | sort | uniq -d)

  if [[ -n "$ARCHIVE_DUPLICATES" ]]; then
    log_error "Duplicate IDs in archive: $(echo "$ARCHIVE_DUPLICATES" | tr '\n' ', ' | sed 's/,$//')"
    if [[ "$FIX" == true ]]; then
      # Keep only first occurrence in archive (atomic write with locking)
      if safe_json_write "$ARCHIVE_FILE" '
        .archivedTasks |= (
          reduce .[] as $task ([];
            if (map(.id) | index($task.id) | not) then . + [$task] else . end
          )
        )
      '; then
        echo "  Fixed: Removed duplicate tasks from archive (kept first occurrence)"
      else
        log_error "Failed to fix archive duplicates (could not acquire lock or write failed)"
      fi
    fi
  else
    log_info "No duplicate IDs in archive" "archive_duplicates"
  fi

  # Check for IDs that exist in both active and archive
  if [[ -n "$TASK_IDS" ]] && [[ -n "$ARCHIVE_IDS" ]]; then
    CROSS_DUPLICATES=$(comm -12 <(echo "$TASK_IDS" | sort) <(echo "$ARCHIVE_IDS" | sort))
    if [[ -n "$CROSS_DUPLICATES" ]]; then
      log_error "IDs exist in both todo.json and archive: $(echo "$CROSS_DUPLICATES" | tr '\n' ', ' | sed 's/,$//')"
      if [[ "$FIX" == true ]]; then
        # Remove from archive (keep in active todo.json) - atomic write with locking
        cross_fix_failed=false
        for cross_id in $CROSS_DUPLICATES; do
          if ! safe_json_write "$ARCHIVE_FILE" '.archivedTasks |= map(select(.id != $id))' --arg id "$cross_id"; then
            cross_fix_failed=true
            break
          fi
        done
        if [[ "$cross_fix_failed" == true ]]; then
          log_error "Failed to fix cross-duplicates (could not acquire lock or write failed)"
        else
          echo "  Fixed: Removed cross-duplicates from archive (kept in todo.json)"
        fi
      fi
    else
      log_info "No cross-file duplicate IDs" "cross_duplicates"
    fi
  fi
fi

# Resolve config values for orphan detection (if not explicitly set)
if [[ -z "$CHECK_ORPHANS" ]] && declare -f get_config_value >/dev/null 2>&1; then
  CHECK_ORPHANS=$(get_config_value "validation.checkOrphans" "")
fi

# ORPHAN DETECTION (T341)
# Check for orphaned tasks (parentId references non-existent parents)
if [[ "$CHECK_ORPHANS" != false ]]; then
  ORPHANS=$(detect_orphans "$TODO_FILE")
  ORPHAN_COUNT=$(echo "$ORPHANS" | jq '. | length')
  
  if [[ "$ORPHAN_COUNT" -gt 0 ]]; then
    # If we're going to fix orphans, don't treat them as errors since they'll be resolved
    if [[ -n "$FIX_ORPHANS" ]]; then
      log_warn "Found $ORPHAN_COUNT orphaned tasks (parentId references missing parent)" "orphans"
    else
      log_error "Found $ORPHAN_COUNT orphaned tasks (parentId references missing parent)" "orphans"
    fi
    
    # Show details of orphaned tasks
    if [[ "$JSON_OUTPUT" != true ]]; then
      echo "$ORPHANS" | jq -r '.[] | "  - \(.id): \(.title) (missing parent: \(.parentId))"'
    fi
    
    if [[ -n "$FIX_ORPHANS" ]]; then
      case "$FIX_ORPHANS" in
        unlink)
          FIXED=$(repair_orphan_unlink "$TODO_FILE" "all")
          log_info "Unlinked $FIXED orphaned tasks (set parentId=null)" "orphans_fixed"
          ;;
        delete)
          FIXED=$(repair_orphan_delete "$TODO_FILE" "all")
          log_info "Deleted $FIXED orphaned tasks" "orphans_deleted"
          ;;
      esac
      
      # Update checksum after orphan repair (file was modified)
      if [[ "$FIXED" -gt 0 ]]; then
        new_checksum=$(jq -c '.tasks' "$TODO_FILE" | sha256sum | cut -c1-16)
        if safe_json_write "$TODO_FILE" '._meta.checksum = $cs' --arg cs "$new_checksum"; then
          log_info "Updated checksum after orphan repair" "checksum_updated"
        else
          log_warn "Failed to update checksum after orphan repair"
        fi
      fi
    fi
  else
    log_info "No orphaned tasks found" "orphans"
  fi
fi

# 3. Check active task limit (configurable via validation.maxActiveTasks)
ACTIVE_COUNT=$(jq '[.tasks[] | select(.status == "active")] | length' "$TODO_FILE")
MAX_ACTIVE_TASKS=1
if declare -f get_max_active_tasks >/dev/null 2>&1; then
  MAX_ACTIVE_TASKS=$(get_max_active_tasks)
  # 0 means unlimited
  if [[ "$MAX_ACTIVE_TASKS" -eq 0 ]]; then
    MAX_ACTIVE_TASKS=999999
  fi
fi

if [[ "$ACTIVE_COUNT" -gt "$MAX_ACTIVE_TASKS" ]]; then
  log_error "Too many active tasks found ($ACTIVE_COUNT). Maximum allowed: $MAX_ACTIVE_TASKS"
  if [[ "$FIX" == true ]]; then
    # Keep only the first N active tasks (atomic write with locking)
    FIRST_ACTIVE=$(jq -r '[.tasks[] | select(.status == "active")][0].id' "$TODO_FILE")
    if safe_json_write "$TODO_FILE" \
      '.tasks |= map(if .status == "active" and .id != $keep then .status = "pending" else . end)' \
      --arg keep "$FIRST_ACTIVE"; then
      echo "  Fixed: Set all but $FIRST_ACTIVE to pending"
    else
      log_error "Failed to fix multiple active tasks (could not acquire lock or write failed)"
    fi
  fi
elif [[ "$ACTIVE_COUNT" -ge 1 ]]; then
  if [[ "$MAX_ACTIVE_TASKS" -eq 1 ]]; then
    log_info "Single active task" "active_task"
  else
    log_info "$ACTIVE_COUNT active task(s) (max: $MAX_ACTIVE_TASKS)" "active_task"
  fi
else
  log_info "No active tasks" "active_task"
fi

# 4. Check all depends[] references exist
# Re-fetch TASK_IDS to get clean list after potential duplicate removal
TASK_IDS=$(jq -r '[.tasks[].id] | @json' "$TODO_FILE")
MISSING_DEPS=$(jq --argjson ids "$TASK_IDS" '
  [.tasks[] | select(.depends != null) | .depends[] | select(. as $d | $ids | index($d) | not)]
' "$TODO_FILE")
MISSING_COUNT=$(echo "$MISSING_DEPS" | jq 'length')
if [[ "$MISSING_COUNT" -gt 0 ]]; then
  log_error "Missing dependency references: $(echo "$MISSING_DEPS" | jq -r 'join(", ")')"
else
  log_info "All dependencies exist" "dependencies"
fi

# 5. Check for circular dependencies (full DFS) - configurable via validation.detectCircularDeps
CIRCULAR_DEPS_ENABLED=true
if declare -f is_circular_dep_detection_enabled >/dev/null 2>&1; then
  CIRCULAR_DEPS_ENABLED=$(is_circular_dep_detection_enabled)
fi

if [[ "$CIRCULAR_DEPS_ENABLED" == "true" ]]; then
  CIRCULAR_DETECTED=false
  while IFS=':' read -r task_id deps; do
    if [[ -n "$task_id" && -n "$deps" ]]; then
      if ! validate_no_circular_deps "$TODO_FILE" "$task_id" "$deps" 2>/dev/null; then
        # Capture error message for display (disable pipefail to avoid grep exit code issues)
        set +o pipefail
        ERROR_MSG=$(validate_no_circular_deps "$TODO_FILE" "$task_id" "$deps" 2>&1 | grep "ERROR:" | sed 's/ERROR: //')
        set -o pipefail
        log_error "$ERROR_MSG"
        CIRCULAR_DETECTED=true
      fi
    fi
  done < <(jq -r '
    .tasks[] |
    select(has("depends") and (.depends | length > 0)) |
    "\(.id):\(.depends | join(","))"
  ' "$TODO_FILE")

  if [[ "$CIRCULAR_DETECTED" != "true" ]]; then
    log_info "No circular dependencies" "circular_deps"
  fi
else
  log_info "Circular dependency check disabled (config: validation.detectCircularDeps=false)" "circular_deps"
fi

# 6. Check blocked tasks have blockedBy
BLOCKED_NO_REASON=$(jq '[.tasks[] | select(.status == "blocked" and (.blockedBy == null or .blockedBy == ""))] | length' "$TODO_FILE")
if [[ "$BLOCKED_NO_REASON" -gt 0 ]]; then
  log_error "$BLOCKED_NO_REASON blocked task(s) missing blockedBy reason"
else
  log_info "All blocked tasks have reasons" "blocked_reasons"
fi

# 7. Check done tasks have completedAt
DONE_NO_DATE=$(jq '[.tasks[] | select(.status == "done" and (.completedAt == null or .completedAt == ""))] | length' "$TODO_FILE")
if [[ "$DONE_NO_DATE" -gt 0 ]]; then
  log_error "$DONE_NO_DATE done task(s) missing completedAt"
  if [[ "$FIX" == true ]]; then
    # Atomic write with locking
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    if safe_json_write "$TODO_FILE" \
      '.tasks |= map(if .status == "done" and (.completedAt == null or .completedAt == "") then .completedAt = $now else . end)' \
      --arg now "$NOW"; then
      echo "  Fixed: Set completedAt to now"
    else
      log_error "Failed to fix completedAt (could not acquire lock or write failed)"
    fi
  fi
else
  log_info "All done tasks have completedAt" "completed_at"
fi

# 7.5. Check schema version compatibility
# Require ._meta.schemaVersion - no fallback to legacy .version field
SCHEMA_VERSION=$(jq -r '._meta.schemaVersion' "$TODO_FILE")
# Extract expected major version from schema file (2.6.0 -> 2)
EXPECTED_MAJOR=$(jq -r '._meta.schemaVersion // .schemaVersion | split(".")[0]' "$SCHEMA_DIR/todo.schema.json")
DEFAULT_VERSION=$(jq -r '._meta.schemaVersion // .schemaVersion' "$SCHEMA_DIR/todo.schema.json")

if [[ -z "$SCHEMA_VERSION" || "$SCHEMA_VERSION" == "null" ]]; then
  log_error "Missing ._meta.schemaVersion field. Run: cleo upgrade" "schema_version"
  if [[ "$FIX" == true ]]; then
    # Atomic write with locking
    if safe_json_write "$TODO_FILE" '._meta.schemaVersion = $ver' --arg ver "$DEFAULT_VERSION"; then
      echo "  Fixed: Added _meta.schemaVersion = $DEFAULT_VERSION"
      log_info "Schema version compatible ($DEFAULT_VERSION) (after fix)" "schema_version"
    else
      log_error "Failed to add schema version (could not acquire lock or write failed)"
    fi
  fi
elif [[ -n "$SCHEMA_VERSION" ]]; then
  # Extract major version (first number before dot)
  MAJOR_VERSION=$(echo "$SCHEMA_VERSION" | cut -d. -f1)

  if [[ "$MAJOR_VERSION" != "$EXPECTED_MAJOR" ]]; then
    log_error "Incompatible schema version: $SCHEMA_VERSION (expected major version $EXPECTED_MAJOR)" "schema_version"
  else
    log_info "Schema version compatible ($SCHEMA_VERSION)" "schema_version"
  fi
fi

# 7.6. Check required task fields
MISSING_FIELD_COUNT=0
while IFS= read -r task_index; do
  TASK_ID=$(jq -r ".tasks[$task_index].id // \"(unknown)\"" "$TODO_FILE")

  # Check for required fields per schema: id, title, status, priority, createdAt
  MISSING_FIELDS=()

  if ! jq -e ".tasks[$task_index].id" "$TODO_FILE" >/dev/null 2>&1; then
    MISSING_FIELDS+=("id")
  fi
  if ! jq -e ".tasks[$task_index].title" "$TODO_FILE" >/dev/null 2>&1; then
    MISSING_FIELDS+=("title")
  fi
  if ! jq -e ".tasks[$task_index].status" "$TODO_FILE" >/dev/null 2>&1; then
    MISSING_FIELDS+=("status")
  fi
  if ! jq -e ".tasks[$task_index].priority" "$TODO_FILE" >/dev/null 2>&1; then
    MISSING_FIELDS+=("priority")
  fi
  if ! jq -e ".tasks[$task_index].createdAt" "$TODO_FILE" >/dev/null 2>&1; then
    MISSING_FIELDS+=("createdAt")
  fi

  if [[ ${#MISSING_FIELDS[@]} -gt 0 ]]; then
    log_error "Task $TASK_ID missing required fields: ${MISSING_FIELDS[*]}"
    ((MISSING_FIELD_COUNT++))
  fi
done < <(jq -r 'range(0; .tasks | length)' "$TODO_FILE")

if [[ "$MISSING_FIELD_COUNT" -eq 0 ]]; then
  log_info "All tasks have required fields" "required_fields"
fi

# 8. Check focus.currentTask matches active task
FOCUS_TASK=$(jq -r '.focus.currentTask // ""' "$TODO_FILE")
ACTIVE_TASK=$(jq -r '[.tasks[] | select(.status == "active")][0].id // ""' "$TODO_FILE")
if [[ -n "$FOCUS_TASK" ]] && [[ "$FOCUS_TASK" != "$ACTIVE_TASK" ]]; then
  log_error "focus.currentTask ($FOCUS_TASK) doesn't match active task ($ACTIVE_TASK)"
  if [[ "$FIX" == true ]]; then
    # Atomic write with locking
    if [[ -n "$ACTIVE_TASK" ]]; then
      if safe_json_write "$TODO_FILE" '.focus.currentTask = $task' --arg task "$ACTIVE_TASK"; then
        echo "  Fixed: Set focus.currentTask to $ACTIVE_TASK"
      else
        log_error "Failed to set focus.currentTask (could not acquire lock or write failed)"
      fi
    else
      if safe_json_write "$TODO_FILE" '.focus.currentTask = null'; then
        echo "  Fixed: Cleared focus.currentTask"
      else
        log_error "Failed to clear focus.currentTask (could not acquire lock or write failed)"
      fi
    fi
  fi
elif [[ -z "$FOCUS_TASK" ]] && [[ -n "$ACTIVE_TASK" ]]; then
  log_warn "Active task ($ACTIVE_TASK) but focus.currentTask is null"
  if [[ "$FIX" == true ]]; then
    # Atomic write with locking
    if safe_json_write "$TODO_FILE" '.focus.currentTask = $task' --arg task "$ACTIVE_TASK"; then
      echo "  Fixed: Set focus.currentTask to $ACTIVE_TASK"
    else
      log_error "Failed to set focus.currentTask (could not acquire lock or write failed)"
    fi
  fi
else
  log_info "Focus matches active task" "focus_match"
fi

# 9. Check for multiple active phases (phase validation)
if jq -e 'if (.project | type) == "object" then .project.phases else null end' "$TODO_FILE" >/dev/null 2>&1; then
  ACTIVE_PHASE_COUNT=$(jq '[(if (.project | type) == "object" then .project.phases else null end // {}) | to_entries[] | select(.value.status == "active")] | length' "$TODO_FILE")
  if [[ "$ACTIVE_PHASE_COUNT" -gt 1 ]]; then
    if [[ "$FIX" == true ]]; then
      # Don't log error yet - try to fix first
      # Get all active phases with metadata
      ACTIVE_PHASES_JSON=$(jq -c '[(if (.project | type) == "object" then .project.phases else null end // {}) | to_entries[] | select(.value.status == "active") | {key: .key, order: .value.order, name: .value.name}] | sort_by(.order)' "$TODO_FILE")
      ACTIVE_PHASES_COUNT=$(echo "$ACTIVE_PHASES_JSON" | jq 'length')

      # Determine if we should be interactive
      IS_INTERACTIVE=false
      if [[ "$NON_INTERACTIVE" != true ]] && [[ -t 0 ]] && [[ -t 1 ]]; then
        IS_INTERACTIVE=true
      fi

      SELECTED_PHASE=""

      if [[ "$IS_INTERACTIVE" == true ]]; then
        # Interactive mode - prompt user to select
        echo ""
        echo -e "${YELLOW}Multiple active phases detected ($ACTIVE_PHASE_COUNT). Select which to keep as current:${NC}"
        echo ""

        # Build array of phase choices
        PHASE_CHOICES=()
        INDEX=1
        while IFS= read -r phase_entry; do
          PHASE_KEY=$(echo "$phase_entry" | jq -r '.key')
          PHASE_NAME=$(echo "$phase_entry" | jq -r '.name')
          PHASE_ORDER=$(echo "$phase_entry" | jq -r '.order')

          # Count tasks in this phase
          TASK_COUNT=$(jq --arg slug "$PHASE_KEY" '[.tasks[] | select(.phase == $slug)] | length' "$TODO_FILE")

          PHASE_CHOICES+=("$PHASE_KEY")
          echo "  $INDEX) $PHASE_KEY - \"$PHASE_NAME\" (order: $PHASE_ORDER, $TASK_COUNT tasks)"
          ((INDEX++))
        done < <(echo "$ACTIVE_PHASES_JSON" | jq -c '.[]')

        echo ""

        # Prompt for selection
        VALID_SELECTION=false
        while [[ "$VALID_SELECTION" != true ]]; do
          read -p "Select [1-$ACTIVE_PHASES_COUNT]: " CHOICE

          if [[ "$CHOICE" =~ ^[0-9]+$ ]] && [[ "$CHOICE" -ge 1 ]] && [[ "$CHOICE" -le "$ACTIVE_PHASES_COUNT" ]]; then
            SELECTED_PHASE="${PHASE_CHOICES[$((CHOICE-1))]}"
            VALID_SELECTION=true
          else
            echo -e "${RED}Invalid selection. Please choose 1-$ACTIVE_PHASES_COUNT${NC}"
          fi
        done

        echo ""
      else
        # Non-interactive mode - auto-select first by order
        SELECTED_PHASE=$(echo "$ACTIVE_PHASES_JSON" | jq -r '.[0].key')

        if [[ "$NON_INTERACTIVE" == true ]]; then
          echo "  Auto-selecting (non-interactive mode): $SELECTED_PHASE"
        else
          echo "  Auto-selecting (non-terminal environment): $SELECTED_PHASE"
        fi
      fi

      # Create backup before fixing
      if declare -f create_safety_backup >/dev/null 2>&1; then
        BACKUP_FILE=$(create_safety_backup "$TODO_FILE" "phase-conflict-fix" 2>/dev/null || echo "")
        if [[ -n "$BACKUP_FILE" ]]; then
          echo "  Backup created: $BACKUP_FILE"
        fi
      fi

      # Apply the fix - set selected as active, others to completed (atomic write with locking)
      if safe_json_write "$TODO_FILE" '
        if (.project | type) == "object" then
          .project.phases |= with_entries(
            if .value.status == "active" and .key != $keep then
              .value.status = "completed"
            else . end
          )
        else . end
      ' --arg keep "$SELECTED_PHASE"; then
        # Log the recovery action
        if declare -f log_operation >/dev/null 2>&1; then
          RECOVERY_DETAILS=$(jq -nc \
            --arg selected "$SELECTED_PHASE" \
            --argjson count "$ACTIVE_PHASE_COUNT" \
            --argjson interactive "$IS_INTERACTIVE" \
            '{
              fixType: "phase_conflict_resolution",
              selectedPhase: $selected,
              totalActivePhases: $count,
              resolutionMethod: (if $interactive then "user_selected" else "auto_selected" end)
            }')
          log_operation "validation_run" "system" "null" "null" "null" "$RECOVERY_DETAILS" "null" 2>/dev/null || true
        fi

        echo "  Fixed: Kept $SELECTED_PHASE as active, others set to completed"
        log_info "Single active phase (after fix)"
      else
        log_error "Multiple active phases found ($ACTIVE_PHASE_COUNT). Only ONE allowed. (fix failed)"
      fi
    else
      log_error "Multiple active phases found ($ACTIVE_PHASE_COUNT). Only ONE allowed."
    fi
  elif [[ "$ACTIVE_PHASE_COUNT" -eq 1 ]]; then
    log_info "Single active phase" "active_phase"
  else
    log_info "No active phases" "active_phase"
  fi

  # Check phase status values are valid (pending/active/completed)
  INVALID_STATUSES=$(jq -r '(if (.project | type) == "object" then .project.phases else null end // {}) | to_entries[] | select(.value.status != "pending" and .value.status != "active" and .value.status != "completed") | "\(.key): \(.value.status)"' "$TODO_FILE" 2>/dev/null)
  if [[ -n "$INVALID_STATUSES" ]]; then
    log_error "Invalid phase status values found: $INVALID_STATUSES"
  fi

  # Check currentPhase references an existing phase
  CURRENT_PHASE=$(jq -r 'if (.project | type) == "object" then .project.currentPhase else null end // ""' "$TODO_FILE")
  if [[ -n "$CURRENT_PHASE" && "$CURRENT_PHASE" != "null" ]]; then
    PHASE_EXISTS=$(jq --arg phase "$CURRENT_PHASE" '(if (.project | type) == "object" then .project.phases else null end // {}) | has($phase)' "$TODO_FILE")
    if [[ "$PHASE_EXISTS" != "true" ]]; then
      log_error "currentPhase '$CURRENT_PHASE' does not exist in phases"
    fi
  fi

  # Check for future timestamps in phases
  CURRENT_TIMESTAMP=$(date -u +%s)
  FUTURE_PHASES=$(jq --argjson now "$CURRENT_TIMESTAMP" '
    (if (.project | type) == "object" then .project.phases else null end // {}) | to_entries[] |
    select(
      (.value.startedAt != null and (.value.startedAt | fromdateiso8601) > $now) or
      (.value.completedAt != null and (.value.completedAt | fromdateiso8601) > $now)
    ) | .key
  ' "$TODO_FILE" 2>/dev/null || echo "")
  if [[ -n "$FUTURE_PHASES" ]]; then
    log_error "Future timestamps detected in phases: $FUTURE_PHASES"
  fi

  # Validate phaseHistory if present
  PHASE_HISTORY_COUNT=$(jq '(if (.project | type) == "object" then .project.phaseHistory else null end // []) | length' "$TODO_FILE")
  if [[ "$PHASE_HISTORY_COUNT" -gt 0 ]]; then
    log_info "Phase history entries: $PHASE_HISTORY_COUNT" "phase_history"

    # Check phaseHistory entries reference valid phases
    INVALID_PHASE_REFS=$(jq -r '
      (if (.project | type) == "object" then .project.phases else null end // {}) as $phases |
      (if (.project | type) == "object" then .project.phaseHistory else null end // []) |
      map(select(.phase as $p | $phases | has($p) | not)) |
      .[].phase
    ' "$TODO_FILE" 2>/dev/null || echo "")
    if [[ -n "$INVALID_PHASE_REFS" ]]; then
      log_error "phaseHistory references non-existent phases: $INVALID_PHASE_REFS"
    fi

    # Check phaseHistory entries have valid transition types
    INVALID_TRANSITIONS=$(jq -r '
      (if (.project | type) == "object" then .project.phaseHistory else null end // []) |
      map(select(.transitionType != "started" and .transitionType != "completed" and .transitionType != "rollback")) |
      .[].transitionType
    ' "$TODO_FILE" 2>/dev/null || echo "")
    if [[ -n "$INVALID_TRANSITIONS" ]]; then
      log_error "phaseHistory has invalid transition types: $INVALID_TRANSITIONS"
    fi

    # Check phaseHistory timestamps are not in future
    FUTURE_HISTORY=$(jq --argjson now "$CURRENT_TIMESTAMP" '
      (if (.project | type) == "object" then .project.phaseHistory else null end // []) |
      map(select(.timestamp != null and (.timestamp | fromdateiso8601) > $now)) |
      .[].phase
    ' "$TODO_FILE" 2>/dev/null || echo "")
    if [[ -n "$FUTURE_HISTORY" && "$FUTURE_HISTORY" != "null" ]]; then
      log_error "phaseHistory has future timestamps for phases: $FUTURE_HISTORY"
    fi

    # Check rollback entries have fromPhase
    MISSING_FROM_PHASE=$(jq -r '
      (if (.project | type) == "object" then .project.phaseHistory else null end // []) |
      map(select(.transitionType == "rollback" and (.fromPhase == null or .fromPhase == ""))) |
      .[].phase
    ' "$TODO_FILE" 2>/dev/null || echo "")
    if [[ -n "$MISSING_FROM_PHASE" ]]; then
      log_error "phaseHistory rollback entries missing fromPhase: $MISSING_FROM_PHASE"
    fi
  fi
fi

# 10. Verify checksum (configurable via validation.checksumEnabled)
CHECKSUM_ENABLED=true
if declare -f is_checksum_enabled >/dev/null 2>&1; then
  CHECKSUM_ENABLED=$(is_checksum_enabled)
fi

if [[ "$CHECKSUM_ENABLED" == "true" ]]; then
  STORED_CHECKSUM=$(jq -r '._meta.checksum // ""' "$TODO_FILE")
  if [[ -n "$STORED_CHECKSUM" ]]; then
    COMPUTED_CHECKSUM=$(jq -c '.tasks' "$TODO_FILE" | sha256sum | cut -c1-16)
    if [[ "$STORED_CHECKSUM" != "$COMPUTED_CHECKSUM" ]]; then
      if [[ "$FIX" == true ]]; then
        # Don't log error yet - try to fix first (atomic write with locking)
        if safe_json_write "$TODO_FILE" '._meta.checksum = $cs' --arg cs "$COMPUTED_CHECKSUM"; then
          echo "  Fixed: Updated checksum (was: $STORED_CHECKSUM, now: $COMPUTED_CHECKSUM)"
          log_info "Checksum valid (after fix)"
        else
          log_error "Checksum mismatch: stored=$STORED_CHECKSUM, computed=$COMPUTED_CHECKSUM (fix failed)"
        fi
      else
        log_error "Checksum mismatch: stored=$STORED_CHECKSUM, computed=$COMPUTED_CHECKSUM"
      fi
    else
      log_info "Checksum valid" "checksum"
    fi
  else
    log_warn "No checksum found"
  fi
else
  log_info "Checksum validation disabled (config: validation.checksumEnabled=false)" "checksum"
fi

# 10. WARNINGS: Stale tasks
STALE_DAYS=30
STALE_THRESHOLD=$(($(date +%s) - STALE_DAYS * 86400))
STALE_TASKS=$(jq --argjson threshold "$STALE_THRESHOLD" '
  [.tasks[] | select(.status == "pending" and .createdAt != null and ((.createdAt | fromdateiso8601) < $threshold))]
' "$TODO_FILE" 2>/dev/null || echo "[]")
STALE_COUNT=$(echo "$STALE_TASKS" | jq 'length')
if [[ "$STALE_COUNT" -gt 0 ]]; then
  log_warn "$STALE_COUNT task(s) pending for >$STALE_DAYS days"
fi

# 11-12. Check injection versions for all agent documentation files
# Uses injection library for registry-based validation (CLAUDE.md, AGENTS.md, GEMINI.md)
if command -v injection_get_targets &>/dev/null && command -v injection_check &>/dev/null; then
  injection_get_targets
  for target in "${REPLY[@]}"; do
    # Skip files that don't exist
    if [[ ! -f "$target" ]]; then
      continue
    fi

    # Get status from injection library
    status_json=$(injection_check "$target")
    status=$(echo "$status_json" | jq -r '.status')
    current_ver=$(echo "$status_json" | jq -r '.currentVersion // ""')
    installed_ver=$(echo "$status_json" | jq -r '.installedVersion // ""')

    # Convert target to log key (CLAUDE.md → claude_md)
    log_key="${target//./_}"
    log_key="${log_key,,}"  # lowercase

    case "$status" in
      current)
        log_info "${target} injection current (v${current_ver})" "$log_key"
        ;;
      legacy)
        if [[ "$FIX" == true ]]; then
          injection_update "$target" 2>/dev/null
          if injection_has_block "$target" && [[ "$(injection_extract_version "$target")" == "$installed_ver" ]]; then
            echo "  Fixed: Updated legacy ${target} injection (unversioned → v${installed_ver})"
            log_info "${target} injection current (v${installed_ver})" "$log_key"
          else
            log_warn "${target} has legacy (unversioned) injection. Run: cleo init"
          fi
        else
          log_warn "${target} has legacy (unversioned) injection. Run with --fix or: cleo init"
        fi
        ;;
      none)
        if [[ "$FIX" == true ]]; then
          injection_update "$target" 2>/dev/null
          if injection_has_block "$target"; then
            echo "  Fixed: Added ${target} injection (v${installed_ver})"
            log_info "${target} injection current (v${installed_ver})" "$log_key"
          else
            log_warn "No cleo injection found in ${target}. Run: cleo init"
          fi
        else
          log_warn "No cleo injection found in ${target}. Run with --fix or: cleo init"
        fi
        ;;
      outdated)
        if [[ "$FIX" == true ]]; then
          injection_update "$target" 2>/dev/null
          new_ver=$(injection_extract_version "$target")
          if [[ "$new_ver" == "$installed_ver" ]]; then
            echo "  Fixed: Updated ${target} injection (${current_ver} → ${installed_ver})"
            log_info "${target} injection current (v${installed_ver})" "$log_key"
          else
            log_warn "${target} injection outdated (${current_ver} → ${installed_ver}). Run: cleo init"
          fi
        else
          log_warn "${target} injection outdated (${current_ver} → ${installed_ver}). Run with --fix or: cleo init"
        fi
        ;;
    esac
  done
fi

# Summary
if [[ "$FORMAT" == "json" ]]; then
  # Don't print blank line for JSON output
  # Get app version (not schema version)
  APP_VERSION="${CLEO_VERSION:-unknown}"
  SCHEMA_VERSION=$(jq -r '._meta.schemaVersion' "$TODO_FILE" 2>/dev/null || echo "unknown")
  TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  VALID=$([[ $ERRORS -eq 0 ]] && echo "true" || echo "false")

  # Build details array from collected details
  DETAILS_ARRAY="[]"
  if [[ ${#DETAILS_JSON[@]} -gt 0 ]]; then
    DETAILS_ARRAY=$(printf '%s\n' "${DETAILS_JSON[@]}" | jq -s '.')
  fi

  jq -nc \
    --argjson errors "$ERRORS" \
    --argjson warnings "$WARNINGS" \
    --argjson valid "$VALID" \
    --arg version "$APP_VERSION" \
    --arg schemaVersion "$SCHEMA_VERSION" \
    --arg timestamp "$TIMESTAMP" \
    --argjson details "$DETAILS_ARRAY" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "format": "json",
        "version": $version,
        "command": "validate",
        "timestamp": $timestamp
      },
      "success": true,
      "valid": $valid,
      "schemaVersion": $schemaVersion,
      "errors": $errors,
      "warnings": $warnings,
      "details": $details
    }'

  # Exit with appropriate code
  if [[ "$ERRORS" -eq 0 ]]; then
    exit "${EXIT_SUCCESS:-0}"
  else
    exit "${EXIT_VALIDATION_ERROR:-6}"
  fi
else
  # Add blank line before text summary
  echo ""
  if [[ "$ERRORS" -eq 0 ]]; then
    echo -e "${GREEN}Validation passed${NC} ($WARNINGS warnings)"
    exit "${EXIT_SUCCESS:-0}"
  else
    echo -e "${RED}Validation failed${NC} ($ERRORS errors, $WARNINGS warnings)"
    if [[ "$STRICT" == true ]] && [[ "$WARNINGS" -gt 0 ]]; then
      exit "${EXIT_VALIDATION_ERROR:-6}"
    fi
    exit "${EXIT_VALIDATION_ERROR:-6}"
  fi
fi
