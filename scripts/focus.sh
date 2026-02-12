#!/usr/bin/env bash
###CLEO
# command: focus
# category: write
# synopsis: Single-task workflow discipline. Set/show/clear active task.
# relevance: critical
# flags: --format,--quiet
# exits: 0,2,4
# json-output: true
# subcommands: set,show,clear,note,next
###END
# CLEO Focus Management Script
# Manage task focus for single-task workflow
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source paths.sh for path resolution functions
if [[ -f "$CLEO_HOME/lib/core/paths.sh" ]]; then
    source "$CLEO_HOME/lib/core/paths.sh"
elif [[ -f "$SCRIPT_DIR/../lib/core/paths.sh" ]]; then
    source "$SCRIPT_DIR/../lib/core/paths.sh"
fi

# Load VERSION from central location
if [[ -f "$CLEO_HOME/VERSION" ]]; then
  VERSION="$(head -n 1 "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(head -n 1 "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="unknown"
fi

# Source version library for proper version management
if [[ -f "$CLEO_HOME/lib/core/version.sh" ]]; then
  source "$CLEO_HOME/lib/core/version.sh"
elif [[ -f "$SCRIPT_DIR/../lib/core/version.sh" ]]; then
  source "$SCRIPT_DIR/../lib/core/version.sh"
fi

# Source libraries
[[ -f "$CLEO_HOME/lib/core/logging.sh" ]] && source "$CLEO_HOME/lib/core/logging.sh"
[[ -f "$CLEO_HOME/lib/data/file-ops.sh" ]] && source "$CLEO_HOME/lib/data/file-ops.sh"

# Also try local lib directory if home installation not found
LIB_DIR="${SCRIPT_DIR}/../lib"
[[ ! -f "$CLEO_HOME/lib/data/file-ops.sh" && -f "$LIB_DIR/data/file-ops.sh" ]] && source "$LIB_DIR/data/file-ops.sh"

# Source validation library for session note validation (v0.20.0+)
if [[ -f "$CLEO_HOME/lib/validation/validation.sh" ]]; then
  source "$CLEO_HOME/lib/validation/validation.sh"
elif [[ -f "$LIB_DIR/validation/validation.sh" ]]; then
  source "$LIB_DIR/validation/validation.sh"
fi

# Source output-format library for format resolution
if [[ -f "$CLEO_HOME/lib/core/output-format.sh" ]]; then
  source "$CLEO_HOME/lib/core/output-format.sh"
elif [[ -f "$LIB_DIR/core/output-format.sh" ]]; then
  source "$LIB_DIR/core/output-format.sh"
fi

# Source exit codes and error-json libraries
if [[ -f "$CLEO_HOME/lib/core/exit-codes.sh" ]]; then
  source "$CLEO_HOME/lib/core/exit-codes.sh"
elif [[ -f "$LIB_DIR/core/exit-codes.sh" ]]; then
  source "$LIB_DIR/core/exit-codes.sh"
fi
if [[ -f "$CLEO_HOME/lib/core/error-json.sh" ]]; then
  source "$CLEO_HOME/lib/core/error-json.sh"
elif [[ -f "$LIB_DIR/core/error-json.sh" ]]; then
  source "$LIB_DIR/core/error-json.sh"
fi

# Source config library for multi-session check
# IMPORTANT: Must be sourced BEFORE hierarchy.sh so config functions are available
if [[ -f "$CLEO_HOME/lib/core/config.sh" ]]; then
  source "$CLEO_HOME/lib/core/config.sh"
elif [[ -f "$LIB_DIR/core/config.sh" ]]; then
  source "$LIB_DIR/core/config.sh"
fi

# Source hierarchy library for hierarchy awareness (T345)
if [[ -f "$CLEO_HOME/lib/tasks/hierarchy.sh" ]]; then
  source "$CLEO_HOME/lib/tasks/hierarchy.sh"
elif [[ -f "$LIB_DIR/tasks/hierarchy.sh" ]]; then
  source "$LIB_DIR/tasks/hierarchy.sh"
fi

# Source sessions library for multi-session support (v0.38.0+)
if [[ -f "$CLEO_HOME/lib/session/sessions.sh" ]]; then
  source "$CLEO_HOME/lib/session/sessions.sh"
elif [[ -f "$LIB_DIR/session/sessions.sh" ]]; then
  source "$LIB_DIR/session/sessions.sh"
fi

# Source context alert library for context monitoring (T1323)
if [[ -f "$CLEO_HOME/lib/session/context-alert.sh" ]]; then
  source "$CLEO_HOME/lib/session/context-alert.sh"
elif [[ -f "$LIB_DIR/session/context-alert.sh" ]]; then
  source "$LIB_DIR/session/context-alert.sh"
fi

# Source flags library for standardized flag parsing
if [[ -f "$CLEO_HOME/lib/ui/flags.sh" ]]; then
  source "$CLEO_HOME/lib/ui/flags.sh"
elif [[ -f "$LIB_DIR/ui/flags.sh" ]]; then
  source "$LIB_DIR/ui/flags.sh"
fi

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"

# Multi-session context
SESSION_ID=""
# Note: LOG_FILE is set by lib/core/logging.sh (readonly) - don't reassign here
# If library wasn't sourced, set a fallback
if [[ -z "${LOG_FILE:-}" ]]; then
  LOG_FILE=".cleo/todo-log.json"
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

QUIET=false
DRY_RUN=false

log_info()    { [[ "$QUIET" != true ]] && echo -e "${GREEN}[INFO]${NC} $1" || true; }
log_warn()    { [[ "$QUIET" != true ]] && echo -e "${YELLOW}[WARN]${NC} $1" || true; }
log_error() {
  local message="$1"
  local error_code="${2:-E_UNKNOWN}"
  local exit_code="${3:-1}"
  local suggestion="${4:-}"

  if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
    output_error "$error_code" "$message" "$exit_code" true "$suggestion" || true
  else
    echo -e "${RED}[ERROR]${NC} $message" >&2
    [[ -n "$suggestion" ]] && echo "Suggestion: $suggestion" >&2
  fi
}
log_step()    { [[ "$QUIET" != true ]] && echo -e "${BLUE}[FOCUS]${NC} $1" || true; }

COMMAND_NAME="focus"

usage() {
  cat << EOF
Usage: cleo focus <command> [OPTIONS]

Manage task focus for single-task workflow.

Commands:
  set <task-id>   Set focus to a specific task (marks it active)
  clear           Clear current focus
  show            Show current focus
  note <text>     Set session note (progress/context)
  next <text>     Set suggested next action

Options:
  -f, --format FMT  Output format: text|json (default: auto)
  --human           Force text output (human-readable)
  --json            Force JSON output (machine-readable)
  -q, --quiet       Suppress informational messages
  --session ID      Session context (multi-session mode)
  --dry-run         Preview changes without modifying files
  -h, --help        Show this help

Multi-Session Mode:
  When multiSession.enabled=true, focus is per-session.
  Use --session or set CLEO_SESSION to specify session context.
  The focus task must be within the session's scope.

Format Auto-Detection:
  When no format is specified, output format is automatically detected:
  - Interactive terminal (TTY): human-readable text format
  - Pipe/redirect/agent context: machine-readable JSON format

Examples:
  cleo focus set T001
  cleo focus note "Completed API endpoints, working on tests"
  cleo focus next "Write unit tests for auth module"
  cleo focus clear
  cleo focus show --json
  cleo focus set T005 --session session_20251227_abc123
EOF
  exit "$EXIT_SUCCESS"
}

# Check dependencies
if ! command -v jq &> /dev/null; then
  if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
    output_error "$E_DEPENDENCY_MISSING" "jq is required but not installed" "${EXIT_DEPENDENCY_ERROR:-5}" false "Install jq: apt install jq (Debian) or brew install jq (macOS)"
  else
    log_error "jq is required but not installed"
  fi
  exit "${EXIT_DEPENDENCY_ERROR:-5}"
fi

# Check todo.json exists
check_todo_exists() {
  if [[ ! -f "$TODO_FILE" ]]; then
    if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_NOT_INITIALIZED" "Todo file not found: $TODO_FILE" "${EXIT_NOT_INITIALIZED:-3}" true "Run 'cleo init' first"
    else
      log_error "Todo file not found: $TODO_FILE"
      log_error "Run 'cleo init' first"
    fi
    exit "${EXIT_NOT_INITIALIZED:-3}"
  fi
}

# Get current timestamp
get_timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# Log focus change
log_focus_change() {
  local old_task="$1"
  local new_task="$2"
  local action="${3:-focus_changed}"

  if [[ ! -f "$LOG_FILE" ]]; then
    return 0
  fi

  local timestamp
  timestamp=$(get_timestamp)
  local log_id
  log_id="log_$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  local session_id
  session_id=$(jq -r '._meta.activeSession // ""' "$TODO_FILE")

  local before_json="null"
  local after_json="null"

  [[ -n "$old_task" ]] && before_json=$(jq -nc --arg t "$old_task" '{currentTask: $t}')
  [[ -n "$new_task" ]] && after_json=$(jq -nc --arg t "$new_task" '{currentTask: $t}')

  local updated_log
  updated_log=$(jq --arg id "$log_id" \
     --arg ts "$timestamp" \
     --arg sid "$session_id" \
     --arg action "$action" \
     --argjson before "$before_json" \
     --argjson after "$after_json" '
    .entries += [{
      id: $id,
      timestamp: $ts,
      sessionId: (if $sid == "" then null else $sid end),
      action: $action,
      actor: "claude",
      taskId: null,
      before: $before,
      after: $after,
      details: null
    }] |
    ._meta.totalEntries += 1 |
    ._meta.lastEntry = $ts
  ' "$LOG_FILE")

  # Use save_json with file locking to prevent race conditions
  save_json "$LOG_FILE" "$updated_log" || log_warn "Failed to write log entry"
}

# Set focus to a task (multi-session aware)
# Updates session focus in sessions.json when multi-session is enabled
set_session_focus() {
  local session_id="$1"
  local task_id="$2"

  local sessions_file todo_file
  sessions_file=$(get_sessions_file)
  todo_file="$TODO_FILE"

  # Lock both files
  local sessions_fd todo_fd
  if ! lock_file "$sessions_file" sessions_fd 30; then
    log_error "Failed to acquire lock on sessions.json" "E_LOCK_TIMEOUT" "${EXIT_LOCK_TIMEOUT:-7}" "Retry after a moment"
    return "${EXIT_LOCK_TIMEOUT:-7}"
  fi

  if ! lock_file "$todo_file" todo_fd 30; then
    unlock_file "$sessions_fd"
    log_error "Failed to acquire lock on todo.json" "E_LOCK_TIMEOUT" "${EXIT_LOCK_TIMEOUT:-7}" "Retry after a moment"
    return "${EXIT_LOCK_TIMEOUT:-7}"
  fi

  trap "unlock_file $todo_fd; unlock_file $sessions_fd" EXIT ERR

  local sessions_content todo_content
  sessions_content=$(cat "$sessions_file")
  todo_content=$(cat "$todo_file")

  # Get session info
  local session_info
  session_info=$(echo "$sessions_content" | jq -c --arg id "$session_id" '.sessions[] | select(.id == $id)')

  if [[ -z "$session_info" ]]; then
    unlock_file "$todo_fd"
    unlock_file "$sessions_fd"
    trap - EXIT ERR
    log_error "Session not found: $session_id" "E_SESSION_NOT_FOUND" "${EXIT_SESSION_NOT_FOUND:-31}" "Use 'cleo session list' to see available sessions"
    return "${EXIT_SESSION_NOT_FOUND:-31}"
  fi

  # Verify task is in session scope (T4267: dynamic recomputation)
  # Recompute scope from current todo.json to include newly added tasks
  local current_scope_ids in_scope
  if declare -f recompute_session_scope >/dev/null 2>&1; then
    current_scope_ids=$(recompute_session_scope "$session_info" "$todo_content")
  else
    current_scope_ids=$(echo "$session_info" | jq -c '.scope.computedTaskIds // []')
  fi
  in_scope=$(echo "$current_scope_ids" | jq --arg taskId "$task_id" 'index($taskId)')

  if [[ "$in_scope" == "null" ]]; then
    unlock_file "$todo_fd"
    unlock_file "$sessions_fd"
    trap - EXIT ERR
    log_error "Task $task_id is not in session scope" "E_TASK_NOT_IN_SCOPE" "${EXIT_TASK_NOT_IN_SCOPE:-34}" "Focus a task within your session scope, or start a new session for this task's epic"
    return "${EXIT_TASK_NOT_IN_SCOPE:-34}"
  fi

  # Verify no other session has this task focused
  local claimed_by
  claimed_by=$(echo "$sessions_content" | jq -r --arg taskId "$task_id" --arg sessId "$session_id" '
    .sessions[] | select(.id != $sessId and .focus.currentTask == $taskId and .status == "active") | .id
  ')

  if [[ -n "$claimed_by" ]]; then
    unlock_file "$todo_fd"
    unlock_file "$sessions_fd"
    trap - EXIT ERR
    log_error "Task $task_id already focused by session $claimed_by" "E_TASK_CLAIMED" "${EXIT_TASK_CLAIMED:-35}" "Choose a different task or wait for the other agent to release focus"
    return "${EXIT_TASK_CLAIMED:-35}"
  fi

  local timestamp old_focus
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  old_focus=$(echo "$session_info" | jq -r '.focus.currentTask // ""')

  # Update session focus (T4267: also persist recomputed scope)
  local updated_sessions
  updated_sessions=$(echo "$sessions_content" | jq \
    --arg sessId "$session_id" \
    --arg taskId "$task_id" \
    --arg ts "$timestamp" \
    --arg oldFocus "$old_focus" \
    --argjson recomputedIds "$current_scope_ids" \
    '
    .sessions = [.sessions[] |
      if .id == $sessId then
        .scope.computedTaskIds = $recomputedIds |
        .focus.previousTask = (if $oldFocus == "" then null else $oldFocus end) |
        .focus.currentTask = $taskId |
        .focus.focusHistory += [{
          taskId: $taskId,
          timestamp: $ts,
          action: "focused"
        }] |
        .lastActivity = $ts |
        .stats.focusChanges += 1
      else . end
    ] |
    ._meta.lastModified = $ts
    ')

  # Update task status in todo.json (use recomputed scope)
  local scope_ids
  scope_ids="$current_scope_ids"

  local updated_todo
  updated_todo=$(echo "$todo_content" | jq \
    --arg taskId "$task_id" \
    --arg ts "$timestamp" \
    --argjson scopeIds "$scope_ids" \
    '
    # Reset other active tasks in scope to pending
    .tasks = [.tasks[] |
      if (.id as $id | $scopeIds | index($id)) and .status == "active" and .id != $taskId then
        .status = "pending" | .updatedAt = $ts
      else . end
    ] |
    # Set focus task to active
    .tasks = [.tasks[] |
      if .id == $taskId then
        .status = "active" | .updatedAt = $ts
      else . end
    ] |
    # Update global focus to match session focus
    .focus.currentTask = $taskId |
    ._meta.lastModified = $ts
    ')

  # Save both files using safe mktemp pattern (locks already held)
  local _focus_sess_tmp _focus_todo_tmp
  _focus_sess_tmp=$(mktemp "${sessions_file}.XXXXXX")
  if ! echo "$updated_sessions" | jq '.' > "$_focus_sess_tmp"; then
    rm -f "$_focus_sess_tmp"
    unlock_file "$todo_fd"
    unlock_file "$sessions_fd"
    trap - EXIT ERR
    return 1
  fi
  mv "$_focus_sess_tmp" "$sessions_file" || { rm -f "$_focus_sess_tmp"; unlock_file "$todo_fd"; unlock_file "$sessions_fd"; trap - EXIT ERR; return 1; }

  _focus_todo_tmp=$(mktemp "${todo_file}.XXXXXX")
  if ! echo "$updated_todo" | jq '.' > "$_focus_todo_tmp"; then
    rm -f "$_focus_todo_tmp"
    unlock_file "$todo_fd"
    unlock_file "$sessions_fd"
    trap - EXIT ERR
    return 1
  fi
  mv "$_focus_todo_tmp" "$todo_file" || { rm -f "$_focus_todo_tmp"; unlock_file "$todo_fd"; unlock_file "$sessions_fd"; trap - EXIT ERR; return 1; }

  unlock_file "$todo_fd"
  unlock_file "$sessions_fd"
  trap - EXIT ERR

  # Use global variable to return old_focus so it doesn't go through
  # command substitution (which would capture error JSON output too)
  _FOCUS_OLD_VALUE="$old_focus"
  return 0
}

# Set focus to a task
cmd_set() {
  local task_id="${1:-}"

  if [[ -z "$task_id" ]]; then
    if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_INPUT_MISSING" "Task ID required" "${EXIT_USAGE_ERROR:-64}" false "Usage: cleo focus set <task-id>"
    else
      log_error "Task ID required"
      echo "Usage: cleo focus set <task-id>"
    fi
    exit "${EXIT_USAGE_ERROR:-64}"
  fi

  check_todo_exists

  # Check for multi-session mode
  local multi_session_enabled=false
  if declare -f is_multi_session_enabled >/dev/null 2>&1; then
    if is_multi_session_enabled "$CONFIG_FILE"; then
      multi_session_enabled=true
    fi
  fi

  # Handle multi-session focus
  if [[ "$multi_session_enabled" == "true" ]]; then
    # Resolve session using priority chain: flag > env > TTY binding > .current-session > auto-detect (T1778)
    local session_id
    if declare -f resolve_current_session_id >/dev/null 2>&1; then
      session_id=$(resolve_current_session_id "$SESSION_ID" 2>/dev/null || true)
    elif [[ -n "$SESSION_ID" ]]; then
      session_id="$SESSION_ID"
    elif declare -f get_current_session_id >/dev/null 2>&1; then
      session_id=$(get_current_session_id 2>/dev/null || true)
    fi

    if [[ -z "$session_id" ]]; then
      log_error "Multi-session mode requires --session ID or CLEO_SESSION" "E_SESSION_REQUIRED" "${EXIT_SESSION_REQUIRED:-36}" "Use 'cleo session list' to see active sessions"
      exit "${EXIT_SESSION_REQUIRED:-36}"
    fi

    # Validate session binding (T1794 - warn about conflicts but don't block)
    if declare -f validate_session_binding >/dev/null 2>&1; then
      validate_session_binding "$session_id" 2>&1 || true
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
      log_info "[DRY-RUN] Would set focus to $task_id in session $session_id"
      exit "$EXIT_SUCCESS"
    fi

    # Run set_session_focus directly (not in subshell) so log_error output
    # goes to the real stdout, not captured by command substitution.
    # The function sets _FOCUS_OLD_VALUE as a side-channel return.
    _FOCUS_OLD_VALUE=""
    local focus_rc=0
    set_session_focus "$session_id" "$task_id" || focus_rc=$?
    if [[ "$focus_rc" -ne 0 ]]; then
      exit "$focus_rc"
    fi
    local old_focus="$_FOCUS_OLD_VALUE"

    local task_title
    task_title=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .title // "Unknown"' "$TODO_FILE")

    if [[ "$FORMAT" == "json" ]]; then
      local current_timestamp
      current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
      jq -nc \
        --arg timestamp "$current_timestamp" \
        --arg version "${CLEO_VERSION:-$(get_version)}" \
        --arg task_id "$task_id" \
        --arg session_id "$session_id" \
        --arg old_focus "$old_focus" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "command": "focus set",
            "timestamp": $timestamp,
            "version": $version,
            "format": "json"
          },
          "success": true,
          "taskId": $task_id,
          "sessionId": $session_id,
          "previousFocus": (if $old_focus == "" then null else $old_focus end),
          "multiSession": true
        }'
    else
      log_step "Focus set: $task_title"
      log_info "Task ID: $task_id"
      log_info "Session: $session_id"
    fi

    # Log the focus change
    log_focus_change "$old_focus" "$task_id" "session_focus_changed"
    return
  fi

  # Single-session mode (original behavior)

  # Verify task exists
  local task_exists
  task_exists=$(jq --arg id "$task_id" '[.tasks[] | select(.id == $id)] | length' "$TODO_FILE")

  if [[ "$task_exists" -eq 0 ]]; then
    if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_TASK_NOT_FOUND" "Task not found: $task_id" "${EXIT_NOT_FOUND:-1}" true "Use 'cleo list' to see available tasks"
    else
      log_error "Task not found: $task_id"
    fi
    exit "${EXIT_NOT_FOUND:-1}"
  fi

  # Get current focus for logging
  local old_focus
  old_focus=$(jq -r '.focus.currentTask // ""' "$TODO_FILE")

  # Dry-run mode - show what would happen
  if [[ "$DRY_RUN" == "true" ]]; then
    if [[ "${FORMAT:-}" == "json" ]]; then
      jq -nc \
        --arg taskId "$task_id" \
        --arg oldFocus "$old_focus" \
        --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "command": "focus set",
            "timestamp": $timestamp,
            "format": "json"
          },
          "success": true,
          "dryRun": true,
          "wouldSet": {
            "taskId": $taskId,
            "previousFocus": (if $oldFocus == "" then null else $oldFocus end)
          }
        }'
    else
      echo "DRY RUN - Would set focus to task: $task_id"
      [[ -n "$old_focus" ]] && echo "  Previous focus: $old_focus"
    fi
    exit "$EXIT_SUCCESS"
  fi

  # Check if there's already an active task (not this one)
  local active_count
  active_count=$(jq --arg id "$task_id" '[.tasks[] | select(.status == "active" and .id != $id)] | length' "$TODO_FILE")

  if [[ "$active_count" -gt 0 ]]; then
    log_warn "Another task is already active. Setting to pending first..."
    # Set other active tasks to pending
    local updated_todo
    updated_todo=$(jq --arg id "$task_id" '
      .tasks = [.tasks[] | if .status == "active" and .id != $id then .status = "pending" else . end]
    ' "$TODO_FILE")
    save_json "$TODO_FILE" "$updated_todo" || {
      if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
        output_error "$E_FILE_WRITE_ERROR" "Failed to update task statuses" "${EXIT_FILE_ERROR:-4}" false "Check file permissions for $TODO_FILE"
      else
        log_error "Failed to update task statuses"
      fi
      exit "${EXIT_FILE_ERROR:-4}"
    }
  fi

  local timestamp
  timestamp=$(get_timestamp)

  # Get task's phase
  local task_phase
  task_phase=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .phase // empty' "$TODO_FILE")

  # Set focus and mark task as active
  local updated_todo
  updated_todo=$(jq --arg id "$task_id" --arg ts "$timestamp" '
    .focus.currentTask = $id |
    ._meta.lastModified = $ts |
    .tasks = [.tasks[] | if .id == $id then .status = "active" else . end]
  ' "$TODO_FILE")

  # Update project.currentPhase and focus.currentPhase if task has phase
  if [[ -n "$task_phase" && "$task_phase" != "null" ]]; then
    updated_todo=$(echo "$updated_todo" | jq --arg phase "$task_phase" '
      (if (.project | type) == "object" then .project.currentPhase = $phase else . end) |
      .focus.currentPhase = $phase
    ')
    [[ "$FORMAT" != "json" ]] && log_info "Phase changed to: $task_phase"
  fi

  save_json "$TODO_FILE" "$updated_todo" || {
    if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_FILE_WRITE_ERROR" "Failed to set focus" "${EXIT_FILE_ERROR:-4}" false "Check file permissions for $TODO_FILE"
    else
      log_error "Failed to set focus"
    fi
    exit "${EXIT_FILE_ERROR:-4}"
  }

  # Log the focus change
  log_focus_change "$old_focus" "$task_id"

  # Get task details for output
  local task_title
  task_title=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .title // "Unknown"' "$TODO_FILE")

  # Check context alert after successful focus set (T1324)
  if declare -f check_context_alert >/dev/null 2>&1; then
    check_context_alert || true
  fi

  if [[ "$FORMAT" == "json" ]]; then
    local current_timestamp
    current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local task_details
    task_details=$(jq --arg id "$task_id" '.tasks[] | select(.id == $id) | {id: .id, title: .title, status: .status, priority: .priority, phase: .phase}' "$TODO_FILE")

    jq -nc \
      --arg timestamp "$current_timestamp" \
      --arg version "${CLEO_VERSION:-$(get_version)}" \
      --arg task_id "$task_id" \
      --arg old_focus "${old_focus:-null}" \
      --argjson task "$task_details" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "command": "focus set",
          "timestamp": $timestamp,
          "version": $version,
          "format": "json"
        },
        "success": true,
        "taskId": $task_id,
        "previousFocus": (if $old_focus == "null" or $old_focus == "" then null else $old_focus end),
        "task": $task
      }'
  else
    log_step "Focus set: $task_title"
    log_info "Task ID: $task_id"
    log_info "Status: active"
  fi
}

# Clear focus
cmd_clear() {
  check_todo_exists

  local old_focus
  old_focus=$(jq -r '.focus.currentTask // ""' "$TODO_FILE")

  if [[ -z "$old_focus" ]]; then
    if [[ "$FORMAT" == "json" ]]; then
      local current_timestamp
      current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
      jq -nc \
        --arg timestamp "$current_timestamp" \
        --arg version "${CLEO_VERSION:-$(get_version)}" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "command": "focus clear",
            "timestamp": $timestamp,
            "version": $version,
            "format": "json"
          },
          "success": true,
          "message": "No focus to clear",
          "previousFocus": null
        }'
    else
      log_info "No focus to clear"
    fi
    exit "$EXIT_SUCCESS"
  fi

  local timestamp
  timestamp=$(get_timestamp)

  # Reset task status from active to pending, then clear focus
  local updated_todo
  updated_todo=$(jq --arg id "$old_focus" --arg ts "$timestamp" '
    .tasks = [.tasks[] |
      if .id == $id and .status == "active" then
        .status = "pending"
      else
        .
      end
    ] |
    .focus.currentTask = null |
    ._meta.lastModified = $ts
  ' "$TODO_FILE")
  save_json "$TODO_FILE" "$updated_todo" || {
    if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_FILE_WRITE_ERROR" "Failed to clear focus" "${EXIT_FILE_ERROR:-4}" false "Check file permissions for $TODO_FILE"
    else
      log_error "Failed to clear focus"
    fi
    exit "${EXIT_FILE_ERROR:-4}"
  }

  # Log the focus change
  log_focus_change "$old_focus" ""

  if [[ "$FORMAT" == "json" ]]; then
    local current_timestamp
    current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq -nc \
      --arg timestamp "$current_timestamp" \
      --arg version "${CLEO_VERSION:-$(get_version)}" \
      --arg old_focus "$old_focus" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "command": "focus clear",
          "timestamp": $timestamp,
          "version": $version,
          "format": "json"
        },
        "success": true,
        "message": "Focus cleared",
        "previousFocus": $old_focus,
        "taskStatusReset": "pending"
      }'
  else
    log_step "Focus cleared"
    log_info "Previous focus: $old_focus (status reset to pending)"
  fi
}

# Show current focus
cmd_show() {
  # FORMAT and QUIET already parsed globally
  check_todo_exists

  # Build hierarchy context functions
  build_breadcrumb() {
    local task_id="$1"
    local breadcrumb=""
    local current_id="$task_id"
    local max_depth=5
    local depth=0

    while [[ -n "$current_id" && "$current_id" != "null" && $depth -lt $max_depth ]]; do
      local parent_id=$(jq -r --arg id "$current_id" '.tasks[] | select(.id == $id) | .parentId // ""' "$TODO_FILE")
      if [[ -n "$parent_id" && "$parent_id" != "null" ]]; then
        local parent_title=$(jq -r --arg id "$parent_id" '.tasks[] | select(.id == $id) | .title' "$TODO_FILE")
        if [[ -n "$breadcrumb" ]]; then
          breadcrumb="$parent_id > $breadcrumb"
        else
          breadcrumb="$parent_id"
        fi
      fi
      current_id="$parent_id"
      ((depth++))
    done

    echo "$breadcrumb"
  }

  if [[ "$FORMAT" == "json" ]]; then
    local current_timestamp
    current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Get focus object and wrap in envelope
    local focus_obj
    focus_obj=$(jq '.focus' "$TODO_FILE")

    # Get task details if there's a focused task
    local current_task
    current_task=$(jq -r '.focus.currentTask // ""' "$TODO_FILE")
    local task_details="null"
    local hierarchy_context="null"

    if [[ -n "$current_task" ]]; then
      task_details=$(jq --arg id "$current_task" '.tasks[] | select(.id == $id) | {id: .id, title: .title, status: .status, priority: .priority, phase: .phase, parentId: .parentId, type: .type}' "$TODO_FILE")
      
      # Build hierarchy context
      local parent_id=$(jq -r --arg id "$current_task" '.tasks[] | select(.id == $id) | .parentId // ""' "$TODO_FILE")
      local parent_context=""
      local children_context=""
      local breadcrumb=""
      
      # Get parent info if task has parent
      if [[ -n "$parent_id" && "$parent_id" != "null" ]]; then
        local parent_title=$(jq -r --arg id "$parent_id" '.tasks[] | select(.id == $id) | .title // "Unknown"' "$TODO_FILE")
        parent_context="Parent: $parent_id ($parent_title)"
      fi
      
      # Get children summary if task has children
      local child_count=$(jq --arg id "$current_task" '[.tasks[] | select(.parentId == $id)] | length' "$TODO_FILE")
      if [[ "$child_count" -gt 0 ]]; then
        local done_children=$(jq --arg id "$current_task" '[.tasks[] | select(.parentId == $id and .status == "done")] | length' "$TODO_FILE")
        local pending_children=$((child_count - done_children))
        children_context="Children: $done_children done, $pending_children pending"
      fi
      
      # Build breadcrumb for deeply nested tasks
      breadcrumb=$(build_breadcrumb "$current_task")
      
      # Create hierarchy context JSON
      hierarchy_context=$(jq -nc \
        --arg parent "$parent_context" \
        --arg children "$children_context" \
        --arg breadcrumb "$breadcrumb" \
        '{
          "parent": (if $parent != "" then $parent else null end),
          "children": (if $children != "" then $children else null end),
          "breadcrumb": (if $breadcrumb != "" then $breadcrumb else null end)
        }')
    fi

    jq -nc \
      --arg timestamp "$current_timestamp" \
      --arg version "${CLEO_VERSION:-$(get_version)}" \
      --argjson focus "$focus_obj" \
      --argjson task "$task_details" \
      --argjson hierarchy "$hierarchy_context" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "command": "focus show",
          "timestamp": $timestamp,
          "version": $version,
          "format": "json"
        },
        "success": true,
        "focus": $focus,
        "focusedTask": $task,
        "hierarchy": $hierarchy
      }'
  else
    local current_task
    local session_note
    local next_action
    local current_phase

    current_task=$(jq -r '.focus.currentTask // ""' "$TODO_FILE")
    session_note=$(jq -r '.focus.sessionNote // ""' "$TODO_FILE")
    next_action=$(jq -r '.focus.nextAction // ""' "$TODO_FILE")
    current_phase=$(jq -r '(if (.project | type) == "object" then .project.currentPhase else null end) // ""' "$TODO_FILE")

    echo ""
    echo "=== Current Focus ==="

    if [[ -n "$current_task" ]]; then
      local task_title
      local task_status
      local parent_id
      local parent_title
      local parent_context=""
      local children_context=""
      local breadcrumb=""
      
      task_title=$(jq -r --arg id "$current_task" '.tasks[] | select(.id == $id) | .title // "Unknown"' "$TODO_FILE")
      task_status=$(jq -r --arg id "$current_task" '.tasks[] | select(.id == $id) | .status // "unknown"' "$TODO_FILE")
      parent_id=$(jq -r --arg id "$current_task" '.tasks[] | select(.id == $id) | .parentId // ""' "$TODO_FILE")
      
      # Get parent info if task has parent
      if [[ -n "$parent_id" && "$parent_id" != "null" ]]; then
        parent_title=$(jq -r --arg id "$parent_id" '.tasks[] | select(.id == $id) | .title // "Unknown"' "$TODO_FILE")
        parent_context="Parent: $parent_id ($parent_title)"
      fi
      
      # Get children summary if task has children
      local child_count=$(jq --arg id "$current_task" '[.tasks[] | select(.parentId == $id)] | length' "$TODO_FILE")
      if [[ "$child_count" -gt 0 ]]; then
        local done_children=$(jq --arg id "$current_task" '[.tasks[] | select(.parentId == $id and .status == "done")] | length' "$TODO_FILE")
        local pending_children=$((child_count - done_children))
        children_context="Children: $done_children done, $pending_children pending"
      fi
      
      # Build breadcrumb for deeply nested tasks
      breadcrumb=$(build_breadcrumb "$current_task")
      
      echo -e "Task: ${GREEN}$task_title${NC}"
      echo "  ID: $current_task"
      echo "  Status: $task_status"
      
      # Add hierarchy context
      [[ -n "$breadcrumb" ]] && echo "  Path: $breadcrumb > $current_task"
      [[ -n "$parent_context" ]] && echo "  $parent_context"
      [[ -n "$children_context" ]] && echo "  $children_context"
    else
      echo -e "Task: ${YELLOW}None${NC}"
    fi

    if [[ -n "$current_phase" ]]; then
      echo "  Phase: $current_phase"
    fi

    echo ""
    if [[ -n "$session_note" ]]; then
      echo "Session Note: $session_note"
    else
      echo "Session Note: (not set)"
    fi

    if [[ -n "$next_action" ]]; then
      echo "Next Action: $next_action"
    else
      echo "Next Action: (not set)"
    fi
    echo ""
  fi
}

# Set session note
cmd_note() {
  local note="${1:-}"

  if [[ -z "$note" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_INPUT_MISSING" "Note text required" "${EXIT_USAGE_ERROR:-64}" false "Usage: cleo focus note \"Your progress note\""
    else
      log_error "Note text required"
      echo "Usage: cleo focus note \"Your progress note\""
    fi
    exit "${EXIT_USAGE_ERROR:-64}"
  fi

  # Validate session note length (v0.20.0+)
  if declare -f validate_session_note &>/dev/null; then
    if ! validate_session_note "$note"; then
      if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
        output_error "$E_VALIDATION_SCHEMA" "Session note too long (max 1000 characters)" "${EXIT_VALIDATION_ERROR:-6}" false "Shorten the note or split into multiple updates"
      fi
      exit "${EXIT_VALIDATION_ERROR:-6}"
    fi
  fi

  check_todo_exists

  local timestamp
  timestamp=$(get_timestamp)

  local updated_todo
  updated_todo=$(jq --arg note "$note" --arg ts "$timestamp" '
    .focus.sessionNote = $note |
    ._meta.lastModified = $ts
  ' "$TODO_FILE")
  save_json "$TODO_FILE" "$updated_todo" || {
    if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_FILE_WRITE_ERROR" "Failed to update session note" "${EXIT_FILE_ERROR:-4}" false "Check file permissions for $TODO_FILE"
    else
      log_error "Failed to update session note"
    fi
    exit "${EXIT_FILE_ERROR:-4}"
  }

  if [[ "$FORMAT" == "json" ]]; then
    local current_timestamp
    current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq -nc \
      --arg timestamp "$current_timestamp" \
      --arg version "${CLEO_VERSION:-$(get_version)}" \
      --arg note "$note" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "command": "focus note",
          "timestamp": $timestamp,
          "version": $version,
          "format": "json"
        },
        "success": true,
        "message": "Session note updated",
        "sessionNote": $note
      }'
  else
    log_step "Session note updated"
    log_info "$note"
  fi
}

# Set next action
cmd_next() {
  local action="${1:-}"

  if [[ -z "$action" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_INPUT_MISSING" "Action text required" "${EXIT_USAGE_ERROR:-64}" false "Usage: cleo focus next \"Suggested next action\""
    else
      log_error "Action text required"
      echo "Usage: cleo focus next \"Suggested next action\""
    fi
    exit "${EXIT_USAGE_ERROR:-64}"
  fi

  check_todo_exists

  local timestamp
  timestamp=$(get_timestamp)

  local updated_todo
  updated_todo=$(jq --arg action "$action" --arg ts "$timestamp" '
    .focus.nextAction = $action |
    ._meta.lastModified = $ts
  ' "$TODO_FILE")
  save_json "$TODO_FILE" "$updated_todo" || {
    if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_FILE_WRITE_ERROR" "Failed to update next action" "${EXIT_FILE_ERROR:-4}" false "Check file permissions for $TODO_FILE"
    else
      log_error "Failed to update next action"
    fi
    exit "${EXIT_FILE_ERROR:-4}"
  }

  if [[ "$FORMAT" == "json" ]]; then
    local current_timestamp
    current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq -nc \
      --arg timestamp "$current_timestamp" \
      --arg version "${CLEO_VERSION:-$(get_version)}" \
      --arg action "$action" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "command": "focus next",
          "timestamp": $timestamp,
          "version": $version,
          "format": "json"
        },
        "success": true,
        "message": "Next action set",
        "nextAction": $action
      }'
  else
    log_step "Next action set"
    log_info "$action"
  fi
}

# Parse global flags before command dispatch using lib/ui/flags.sh
SUBCOMMAND_ARGS=()
COMMAND=""

# Initialize and parse common flags (--format, --json, --human, --quiet, --dry-run, --help)
init_flag_defaults
parse_common_flags "$@"
set -- "${REMAINING_ARGS[@]}"

# Bridge to legacy variables for compatibility
apply_flags_to_globals

# Handle help early if requested
if [[ "$FLAG_HELP" == "true" ]]; then
  usage
fi

# Parse remaining command-specific flags
while [[ $# -gt 0 ]]; do
  case $1 in
    --session) SESSION_ID="$2"; shift 2 ;;
    -h|--help|help)
      if [[ -z "$COMMAND" ]]; then
        usage
      else
        SUBCOMMAND_ARGS+=("$1")
        shift
      fi
      ;;
    set|clear|show|note|next)
      if [[ -z "$COMMAND" ]]; then
        COMMAND="$1"
        shift
      else
        SUBCOMMAND_ARGS+=("$1")
        shift
      fi
      ;;
    *)
      if [[ -z "$COMMAND" ]]; then
        COMMAND="$1"
        shift
      else
        SUBCOMMAND_ARGS+=("$1")
        shift
      fi
      ;;
  esac
done

# Default command is show
COMMAND="${COMMAND:-show}"

# Resolve format with TTY-aware detection
FORMAT=$(resolve_format "$FORMAT")

case "$COMMAND" in
  set)    cmd_set "${SUBCOMMAND_ARGS[@]}" ;;
  clear)  cmd_clear "${SUBCOMMAND_ARGS[@]}" ;;
  show)   cmd_show "${SUBCOMMAND_ARGS[@]}" ;;
  note)   cmd_note "${SUBCOMMAND_ARGS[@]}" ;;
  next)   cmd_next "${SUBCOMMAND_ARGS[@]}" ;;
  -h|--help|help) usage ;;
  *)
    if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_INPUT_INVALID" "Unknown command: $COMMAND" "${EXIT_USAGE_ERROR:-64}" false "Run 'cleo focus --help' for usage"
    else
      log_error "Unknown command: $COMMAND"
      echo "Run 'cleo focus --help' for usage"
    fi
    exit "${EXIT_USAGE_ERROR:-64}"
    ;;
esac
