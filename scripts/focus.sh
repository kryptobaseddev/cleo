#!/usr/bin/env bash
# CLEO Focus Management Script
# Manage task focus for single-task workflow
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source paths.sh for path resolution functions
if [[ -f "$CLEO_HOME/lib/paths.sh" ]]; then
    source "$CLEO_HOME/lib/paths.sh"
elif [[ -f "$SCRIPT_DIR/../lib/paths.sh" ]]; then
    source "$SCRIPT_DIR/../lib/paths.sh"
fi

# Load VERSION from central location
if [[ -f "$CLEO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="unknown"
fi

# Source version library for proper version management
if [[ -f "$CLEO_HOME/lib/version.sh" ]]; then
  source "$CLEO_HOME/lib/version.sh"
elif [[ -f "$SCRIPT_DIR/../lib/version.sh" ]]; then
  source "$SCRIPT_DIR/../lib/version.sh"
fi

# Source libraries
[[ -f "$CLEO_HOME/lib/logging.sh" ]] && source "$CLEO_HOME/lib/logging.sh"
[[ -f "$CLEO_HOME/lib/file-ops.sh" ]] && source "$CLEO_HOME/lib/file-ops.sh"

# Also try local lib directory if home installation not found
LIB_DIR="${SCRIPT_DIR}/../lib"
[[ ! -f "$CLEO_HOME/lib/file-ops.sh" && -f "$LIB_DIR/file-ops.sh" ]] && source "$LIB_DIR/file-ops.sh"

# Source validation library for session note validation (v0.20.0+)
if [[ -f "$CLEO_HOME/lib/validation.sh" ]]; then
  source "$CLEO_HOME/lib/validation.sh"
elif [[ -f "$LIB_DIR/validation.sh" ]]; then
  source "$LIB_DIR/validation.sh"
fi

# Source output-format library for format resolution
if [[ -f "$CLEO_HOME/lib/output-format.sh" ]]; then
  source "$CLEO_HOME/lib/output-format.sh"
elif [[ -f "$LIB_DIR/output-format.sh" ]]; then
  source "$LIB_DIR/output-format.sh"
fi

# Source exit codes and error-json libraries
if [[ -f "$CLEO_HOME/lib/exit-codes.sh" ]]; then
  source "$CLEO_HOME/lib/exit-codes.sh"
elif [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  source "$LIB_DIR/exit-codes.sh"
fi
if [[ -f "$CLEO_HOME/lib/error-json.sh" ]]; then
  source "$CLEO_HOME/lib/error-json.sh"
elif [[ -f "$LIB_DIR/error-json.sh" ]]; then
  source "$LIB_DIR/error-json.sh"
fi

# Source hierarchy library for hierarchy awareness (T345)
if [[ -f "$CLEO_HOME/lib/hierarchy.sh" ]]; then
  source "$CLEO_HOME/lib/hierarchy.sh"
elif [[ -f "$LIB_DIR/hierarchy.sh" ]]; then
  source "$LIB_DIR/hierarchy.sh"
fi

# Source sessions library for multi-session support (v0.38.0+)
if [[ -f "$CLEO_HOME/lib/sessions.sh" ]]; then
  source "$CLEO_HOME/lib/sessions.sh"
elif [[ -f "$LIB_DIR/sessions.sh" ]]; then
  source "$LIB_DIR/sessions.sh"
fi

# Source config library for multi-session check
if [[ -f "$CLEO_HOME/lib/config.sh" ]]; then
  source "$CLEO_HOME/lib/config.sh"
elif [[ -f "$LIB_DIR/config.sh" ]]; then
  source "$LIB_DIR/config.sh"
fi

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"

# Multi-session context
SESSION_ID=""
# Note: LOG_FILE is set by lib/logging.sh (readonly) - don't reassign here
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
log_error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }
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

  [[ -n "$old_task" ]] && before_json=$(jq -n --arg t "$old_task" '{currentTask: $t}')
  [[ -n "$new_task" ]] && after_json=$(jq -n --arg t "$new_task" '{currentTask: $t}')

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
    log_error "Failed to acquire lock on sessions.json"
    return 1
  fi

  if ! lock_file "$todo_file" todo_fd 30; then
    unlock_file "$sessions_fd"
    log_error "Failed to acquire lock on todo.json"
    return 1
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
    log_error "Session not found: $session_id"
    return 1
  fi

  # Verify task is in session scope
  local in_scope
  in_scope=$(echo "$session_info" | jq --arg taskId "$task_id" '.scope.computedTaskIds | index($taskId)')

  if [[ "$in_scope" == "null" ]]; then
    unlock_file "$todo_fd"
    unlock_file "$sessions_fd"
    trap - EXIT ERR
    log_error "Task $task_id is not in session scope"
    return 1
  fi

  # Verify no other session has this task focused
  local claimed_by
  claimed_by=$(echo "$sessions_content" | jq -r --arg taskId "$task_id" --arg sessId "$session_id" '
    .sessions[] | select(.id != $sessId and .focus.currentTask == $taskId) | .id
  ')

  if [[ -n "$claimed_by" ]]; then
    unlock_file "$todo_fd"
    unlock_file "$sessions_fd"
    trap - EXIT ERR
    log_error "Task $task_id already focused by session $claimed_by"
    return 1
  fi

  local timestamp old_focus
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  old_focus=$(echo "$session_info" | jq -r '.focus.currentTask // ""')

  # Update session focus
  local updated_sessions
  updated_sessions=$(echo "$sessions_content" | jq \
    --arg sessId "$session_id" \
    --arg taskId "$task_id" \
    --arg ts "$timestamp" \
    --arg oldFocus "$old_focus" \
    '
    .sessions = [.sessions[] |
      if .id == $sessId then
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

  # Update task status in todo.json
  local scope_ids
  scope_ids=$(echo "$session_info" | jq -c '.scope.computedTaskIds')

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
    ._meta.lastModified = $ts
    ')

  # Save both files
  if ! echo "$updated_sessions" | jq '.' > "$sessions_file.tmp"; then
    unlock_file "$todo_fd"
    unlock_file "$sessions_fd"
    trap - EXIT ERR
    rm -f "$sessions_file.tmp"
    return 1
  fi
  mv "$sessions_file.tmp" "$sessions_file"

  if ! echo "$updated_todo" | jq '.' > "$todo_file.tmp"; then
    unlock_file "$todo_fd"
    unlock_file "$sessions_fd"
    trap - EXIT ERR
    rm -f "$todo_file.tmp"
    return 1
  fi
  mv "$todo_file.tmp" "$todo_file"

  unlock_file "$todo_fd"
  unlock_file "$sessions_fd"
  trap - EXIT ERR

  echo "$old_focus"
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
    # Get session ID from flag, env var, or .current-session file
    local session_id="$SESSION_ID"
    if [[ -z "$session_id" ]] && declare -f get_current_session_id >/dev/null 2>&1; then
      session_id=$(get_current_session_id 2>/dev/null || true)
    fi

    if [[ -z "$session_id" ]]; then
      log_error "Multi-session mode requires --session ID or CLEO_SESSION"
      log_error "Use 'cleo session list' to see active sessions"
      exit "${EXIT_INVALID_INPUT:-64}"
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
      log_info "[DRY-RUN] Would set focus to $task_id in session $session_id"
      exit "$EXIT_SUCCESS"
    fi

    local old_focus
    if ! old_focus=$(set_session_focus "$session_id" "$task_id"); then
      exit "${EXIT_FILE_ERROR:-4}"
    fi

    local task_title
    task_title=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .title // "Unknown"' "$TODO_FILE")

    if [[ "$FORMAT" == "json" ]]; then
      local current_timestamp
      current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
      jq -n \
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
      jq -n \
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
      .project.currentPhase = $phase |
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

  if [[ "$FORMAT" == "json" ]]; then
    local current_timestamp
    current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local task_details
    task_details=$(jq --arg id "$task_id" '.tasks[] | select(.id == $id) | {id: .id, title: .title, status: .status, priority: .priority, phase: .phase}' "$TODO_FILE")

    jq -n \
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
      jq -n \
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
    jq -n \
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
      hierarchy_context=$(jq -n \
        --arg parent "$parent_context" \
        --arg children "$children_context" \
        --arg breadcrumb "$breadcrumb" \
        '{
          "parent": (if $parent != "" then $parent else null end),
          "children": (if $children != "" then $children else null end),
          "breadcrumb": (if $breadcrumb != "" then $breadcrumb else null end)
        }')
    fi

    jq -n \
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
    current_phase=$(jq -r '.project.currentPhase // ""' "$TODO_FILE")

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
    jq -n \
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
    jq -n \
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

# Parse global flags before command dispatch
FORMAT=""
SUBCOMMAND_ARGS=()
COMMAND=""

while [[ $# -gt 0 ]]; do
  case $1 in
    -f|--format) FORMAT="$2"; shift 2 ;;
    --human) FORMAT="text"; shift ;;
    --json) FORMAT="json"; shift ;;
    -q|--quiet) QUIET=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
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
