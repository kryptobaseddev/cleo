#!/usr/bin/env bash
# CLEO Session Management Script
# Manage work sessions with automatic logging
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source paths.sh for path resolution functions
if [[ -f "$CLEO_HOME/lib/paths.sh" ]]; then
    source "$CLEO_HOME/lib/paths.sh"
elif [[ -f "$SCRIPT_DIR/../lib/paths.sh" ]]; then
    source "$SCRIPT_DIR/../lib/paths.sh"
fi

# Source version - use central VERSION file
VERSION=$(cat "$CLEO_HOME/VERSION" 2>/dev/null || cat "$SCRIPT_DIR/../VERSION" 2>/dev/null || echo "0.36.0")

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

# Source config library for session settings
if [[ -f "$CLEO_HOME/lib/config.sh" ]]; then
  source "$CLEO_HOME/lib/config.sh"
elif [[ -f "$LIB_DIR/config.sh" ]]; then
  source "$LIB_DIR/config.sh"
fi

# Source phase tracking library for phase capture (v2.2.0)
if [[ -f "$CLEO_HOME/lib/phase-tracking.sh" ]]; then
  source "$CLEO_HOME/lib/phase-tracking.sh"
elif [[ -f "$LIB_DIR/phase-tracking.sh" ]]; then
  source "$LIB_DIR/phase-tracking.sh"
fi

# Source backup library for scheduled backup support (T632)
if [[ -f "$CLEO_HOME/lib/backup.sh" ]]; then
  source "$CLEO_HOME/lib/backup.sh"
elif [[ -f "$LIB_DIR/backup.sh" ]]; then
  source "$LIB_DIR/backup.sh"
fi

# Source validation library for input validation (Part 5.3 compliance)
if [[ -f "$CLEO_HOME/lib/validation.sh" ]]; then
  source "$CLEO_HOME/lib/validation.sh"
elif [[ -f "$LIB_DIR/validation.sh" ]]; then
  source "$LIB_DIR/validation.sh"
fi

# Source sessions library for multi-session support (v0.38.0+)
if [[ -f "$CLEO_HOME/lib/sessions.sh" ]]; then
  source "$CLEO_HOME/lib/sessions.sh"
elif [[ -f "$LIB_DIR/sessions.sh" ]]; then
  source "$LIB_DIR/sessions.sh"
fi

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"
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

log_info()    { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
# Format-aware log_error: uses output_error for JSON, text fallback otherwise
log_error() {
  local message="$1"
  local error_code="${2:-E_UNKNOWN}"
  local exit_code="${3:-1}"
  local suggestion="${4:-}"

  # Check if output_format is json (from cmd_status/cmd_info local vars or global)
  local current_format="${output_format:-${FORMAT:-text}}"

  if [[ "$current_format" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
    FORMAT="$current_format"  # Sync FORMAT for output_error
    output_error "$error_code" "$message" "$exit_code" true "$suggestion"
  else
    echo -e "${RED}[ERROR]${NC} $message" >&2
    [[ -n "$suggestion" ]] && echo "Suggestion: $suggestion" >&2
  fi
}
log_step()    { echo -e "${BLUE}[SESSION]${NC} $1"; }

# Global format variable for output_error (empty allows TTY auto-detection)
FORMAT=""
QUIET=false

COMMAND_NAME="session"
DRY_RUN=false

usage() {
  cat << EOF
Usage: cleo session <command> [OPTIONS]

Manage cleo work sessions.

Commands:
  start         Start a new session (single-session mode)
                Start with scope (multi-session mode)
  end           End the current session
  status        Show current session status
  info          Show detailed session information
  suspend       Suspend current session (multi-session)
  resume        Resume a suspended session (multi-session)
  list          List all sessions (multi-session)
  show          Show session details (multi-session)
  switch        Switch to different session (multi-session)

Single-Session Options:
  --note TEXT       Add a note when ending session

Multi-Session Options (requires multiSession.enabled=true):
  --scope TYPE:ID   Scope definition (epic:T001, taskGroup:T005, etc.)
  --focus ID        Task to focus on (required for multi-session start)
  --auto-focus      Auto-select highest priority pending task in scope
  --name TEXT       Session name for identification
  --agent ID        Agent identifier for the session

Common Options:
  -f, --format FMT  Output format: text|json (default: auto)
  --human           Force text output (human-readable)
  --json            Force JSON output (machine-readable)
  -q, --quiet       Suppress informational messages
  --dry-run         Show what would be changed without modifying files
  -h, --help        Show this help

Scope Types (multi-session):
  task:ID           Single task only
  taskGroup:ID      Parent task + direct children
  subtree:ID        Parent + all descendants
  epicPhase:ID      Epic filtered by phase (use --phase)
  epic:ID           Full epic tree
  custom:ID1,ID2    Explicit task list

Format Auto-Detection:
  When no format is specified, output format is automatically detected:
  - Interactive terminal (TTY): human-readable text format
  - Pipe/redirect/agent context: machine-readable JSON format

Config Settings (in .cleo/config.json):
  session.requireSessionNote      If true, require --note when ending
  session.warnOnNoFocus           If true, warn when starting without focus
  session.sessionTimeoutHours     Warn if session exceeds this duration
  session.autoStartSession        If true, auto-start session on first command
  multiSession.enabled            Enable multi-session concurrent agent mode
  multiSession.maxConcurrentSessions  Maximum concurrent sessions (default: 5)

Examples (Single-Session):
  cleo session start                    # Start new session
  cleo session end --note "Completed auth"
  cleo session status                   # Check current session

Examples (Multi-Session):
  cleo session start --scope epic:T001 --focus T005 --name "Auth impl"
  cleo session start --scope taskGroup:T010 --auto-focus
  cleo session list                     # List all sessions
  cleo session suspend --note "Waiting for review"
  cleo session resume session_20251227_...
  cleo session switch session_20251227_...
EOF
  exit "$EXIT_SUCCESS"
}

# Check dependencies
if ! command -v jq &> /dev/null; then
  log_error "jq is required but not installed" "E_DEPENDENCY_MISSING" "$EXIT_DEPENDENCY_ERROR" "Install jq: brew install jq (macOS) or apt install jq (Linux)"
  exit "$EXIT_DEPENDENCY_ERROR"
fi

# Check todo.json exists
check_todo_exists() {
  if [[ ! -f "$TODO_FILE" ]]; then
    log_error "Todo file not found: $TODO_FILE. Run 'cleo init' first" "E_NOT_INITIALIZED" "$EXIT_NOT_FOUND" "Run 'cleo init' to initialize"
    exit "$EXIT_NOT_FOUND"
  fi
}

# Generate session ID: session_YYYYMMDD_HHMMSS_<6hex>
generate_session_id() {
  local date_part
  local random_hex
  date_part=$(date +"%Y%m%d_%H%M%S")
  random_hex=$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')
  echo "session_${date_part}_${random_hex}"
}

# Auto-start session if configured and no active session exists
# This function can be called from other scripts or the main wrapper
# Returns: 0 if session started or already exists, 1 on error
maybe_auto_start_session() {
  local todo_file="${1:-$TODO_FILE}"

  if [[ ! -f "$todo_file" ]]; then
    return 1
  fi

  # Check if auto-start is enabled
  local auto_start
  auto_start=$(get_config_value "session.autoStartSession" "false")

  if [[ "$auto_start" != "true" ]]; then
    return 0  # Not configured, nothing to do
  fi

  # Check if session already active
  local current_session
  current_session=$(jq -r '._meta.activeSession // ""' "$todo_file")

  if [[ -n "$current_session" ]]; then
    return 0  # Session already active
  fi

  # Auto-start a new session
  local session_id
  session_id=$(generate_session_id)
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Update todo.json with new session
  local updated_todo
  updated_todo=$(jq --arg sid "$session_id" --arg ts "$timestamp" '
    ._meta.activeSession = $sid |
    ._meta.lastModified = $ts
  ' "$todo_file")

  if save_json "$todo_file" "$updated_todo" 2>/dev/null; then
    if [[ "${QUIET:-false}" != "true" ]]; then
      log_info "Session auto-started: $session_id"
    fi
    return 0
  else
    return 1
  fi
}

# Export for use by other scripts
export -f maybe_auto_start_session 2>/dev/null || true

# Get current session info
get_current_session() {
  jq -r '._meta.activeSession // ""' "$TODO_FILE"
}

# Parse scope string into JSON scope definition
# Args: $1 - scope string (e.g., "epic:T001", "taskGroup:T005")
# Returns: JSON scope definition
parse_scope_string() {
  local scope_str="$1"
  local scope_type root_id

  # Parse TYPE:ID format
  if [[ "$scope_str" == *":"* ]]; then
    scope_type="${scope_str%%:*}"
    root_id="${scope_str#*:}"
  else
    log_error "Invalid scope format: $scope_str. Use TYPE:ID (e.g., epic:T001)" "E_INVALID_INPUT" "$EXIT_INVALID_INPUT"
    return 1
  fi

  # Handle custom scope (comma-separated IDs)
  if [[ "$scope_type" == "custom" ]]; then
    local task_ids
    task_ids=$(echo "$root_id" | tr ',' '\n' | jq -R . | jq -sc .)
    jq -n --arg type "$scope_type" --argjson ids "$task_ids" '{
      type: $type,
      taskIds: $ids
    }'
  else
    jq -n --arg type "$scope_type" --arg root "$root_id" '{
      type: $type,
      rootTaskId: $root
    }'
  fi
}

# Start a new session
cmd_start() {
  local scope_str="" focus_task="" session_name="" agent_id="" auto_focus=false phase_filter=""

  # Parse multi-session options
  while [[ $# -gt 0 ]]; do
    case $1 in
      --scope) scope_str="$2"; shift 2 ;;
      --focus) focus_task="$2"; shift 2 ;;
      --auto-focus) auto_focus=true; shift ;;
      --name) session_name="$2"; shift 2 ;;
      --agent) agent_id="$2"; shift 2 ;;
      --phase) phase_filter="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  check_todo_exists

  # Check if multi-session mode is enabled
  local multi_session_enabled=false
  if declare -f is_multi_session_enabled >/dev/null 2>&1; then
    if is_multi_session_enabled "$CONFIG_FILE"; then
      multi_session_enabled=true
    fi
  fi

  # If scope is provided, use multi-session mode
  if [[ -n "$scope_str" ]]; then
    if [[ "$multi_session_enabled" != "true" ]]; then
      log_error "Multi-session mode not enabled. Set multiSession.enabled=true in config" "E_CONFIG_ERROR" "$EXIT_INVALID_INPUT"
      exit "$EXIT_INVALID_INPUT"
    fi

    cmd_start_multi_session "$scope_str" "$focus_task" "$session_name" "$agent_id" "$auto_focus" "$phase_filter"
    return
  fi

  # Single-session mode (original behavior)
  local current_session
  current_session=$(get_current_session)

  if [[ -n "$current_session" ]]; then
    log_error "Session already active: $current_session" "E_SESSION_ACTIVE" "$EXIT_ALREADY_EXISTS" "Use 'cleo session end' first, or continue with current session"
    exit "$EXIT_ALREADY_EXISTS"
  fi

  # Check session.warnOnNoFocus config setting
  local warn_no_focus
  warn_no_focus=$(get_config_value "session.warnOnNoFocus" "true")
  if [[ "$warn_no_focus" == "true" ]]; then
    local focus_task_check
    focus_task_check=$(jq -r '.focus.currentTask // ""' "$TODO_FILE")
    if [[ -z "$focus_task_check" ]]; then
      log_warn "Starting session without a focused task"
      log_warn "Consider setting focus: cleo focus set <task-id>"
    fi
  fi

  local session_id
  session_id=$(generate_session_id)
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Handle --dry-run mode
  if [[ "$DRY_RUN" == "true" ]]; then
    if [[ "$FORMAT" == "json" ]]; then
      jq -n \
        --arg sid "$session_id" \
        --arg ts "$timestamp" \
        --arg version "${CLEO_VERSION:-$(get_version)}" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "command": "session start",
            "timestamp": $ts,
            "version": $version
          },
          "success": true,
          "dryRun": true,
          "wouldStart": {
            "sessionId": $sid,
            "timestamp": $ts
          },
          "message": "Would start new session (dry-run mode)"
        }'
    else
      log_info "[DRY-RUN] Would start session: $session_id"
    fi
    exit "$EXIT_SUCCESS"
  fi

  # Update todo.json with new session
  local updated_todo
  updated_todo=$(jq --arg sid "$session_id" --arg ts "$timestamp" '
    ._meta.activeSession = $sid |
    ._meta.lastModified = $ts
  ' "$TODO_FILE")
  save_json "$TODO_FILE" "$updated_todo" || {
    log_error "Failed to start session" "E_FILE_WRITE_ERROR" "$EXIT_FILE_ERROR" "Check file permissions on $TODO_FILE"
    exit "$EXIT_FILE_ERROR"
  }

  # Log session start
  if [[ -f "$LOG_FILE" ]]; then
    local log_id
    log_id="log_$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    local updated_log
    updated_log=$(jq --arg id "$log_id" --arg ts "$timestamp" --arg sid "$session_id" '
      .entries += [{
        id: $id,
        timestamp: $ts,
        sessionId: $sid,
        action: "session_start",
        actor: "system",
        taskId: null,
        before: null,
        after: null,
        details: "Session started"
      }] |
      ._meta.totalEntries += 1 |
      ._meta.lastEntry = $ts
    ' "$LOG_FILE")
    save_json "$LOG_FILE" "$updated_log" || log_warn "Failed to write log entry"
  fi

  log_step "Session started: $session_id"

  # Auto-backup on session start if enabled (T632)
  if declare -f auto_backup_on_session_start >/dev/null 2>&1; then
    local backup_path
    backup_path=$(auto_backup_on_session_start "$CONFIG_FILE" 2>/dev/null || true)
    if [[ -n "$backup_path" ]]; then
      log_info "Auto-backup created: $(basename "$backup_path")"
    fi
  fi

  # Show current focus if any
  local focus_task
  focus_task=$(jq -r '.focus.currentTask // ""' "$TODO_FILE")
  if [[ -n "$focus_task" ]]; then
    local task_title
    task_title=$(jq -r --arg id "$focus_task" '.tasks[] | select(.id == $id) | .content // .title // "Unknown"' "$TODO_FILE")
    log_info "Resume focus: $task_title ($focus_task)"
  fi

  # Show session note from last session
  local last_note
  last_note=$(jq -r '.focus.sessionNote // ""' "$TODO_FILE")
  if [[ -n "$last_note" ]]; then
    log_info "Last session note: $last_note"
  fi

  # Show next action if any
  local next_action
  next_action=$(jq -r '.focus.nextAction // ""' "$TODO_FILE")
  if [[ -n "$next_action" ]]; then
    log_info "Suggested next action: $next_action"
  fi

  # Capture and display current project phase (passive - no validation)
  if declare -f get_current_phase >/dev/null 2>&1; then
    local current_phase
    current_phase=$(get_current_phase "$TODO_FILE")
    if [[ -n "$current_phase" && "$current_phase" != "null" ]]; then
      log_info "Project phase: $current_phase"
    fi
  fi

  # Check if CLAUDE.md injection is outdated
  if [[ -f "CLAUDE.md" ]] && [[ -f "$CLEO_HOME/templates/AGENT-INJECTION.md" ]]; then
    local current_version installed_version
    current_version=$(grep -oP 'CLEO:START v\K[0-9.]+' CLAUDE.md 2>/dev/null || echo "")
    installed_version=$(grep -oP 'CLEO:START v\K[0-9.]+' "$CLEO_HOME/templates/AGENT-INJECTION.md" 2>/dev/null || echo "")

    if [[ -n "$installed_version" ]] && [[ "$current_version" != "$installed_version" ]]; then
      log_warn "CLAUDE.md injection outdated (${current_version:-unknown} → $installed_version)"
      log_warn "Run: cleo init --update-claude-md"
    fi
  fi
}

# Start a multi-session with scope
cmd_start_multi_session() {
  local scope_str="$1"
  local focus_task="$2"
  local session_name="$3"
  local agent_id="$4"
  local auto_focus="$5"
  local phase_filter="$6"

  # Parse scope string into JSON
  local scope_def
  if ! scope_def=$(parse_scope_string "$scope_str"); then
    exit "$EXIT_INVALID_INPUT"
  fi

  # Add phase filter if provided
  if [[ -n "$phase_filter" ]]; then
    scope_def=$(echo "$scope_def" | jq --arg phase "$phase_filter" '. + {phaseFilter: $phase}')
  fi

  # Handle auto-focus
  if [[ "$auto_focus" == "true" ]] && [[ -z "$focus_task" ]]; then
    local todo_content
    todo_content=$(cat "$TODO_FILE")

    # Compute scope to find tasks
    local computed_ids
    computed_ids=$(compute_scope_tasks "$todo_content" "$scope_def")

    # Select highest priority pending task
    focus_task=$(auto_select_focus_task "$todo_content" "$computed_ids")

    if [[ -z "$focus_task" ]]; then
      log_error "No pending tasks in scope for auto-focus" "E_SCOPE_EMPTY" "$EXIT_NOT_FOUND"
      exit "$EXIT_NOT_FOUND"
    fi

    log_info "Auto-selected focus: $focus_task"
  fi

  # Validate focus is provided
  if [[ -z "$focus_task" ]]; then
    log_error "Session requires --focus <task-id> or --auto-focus" "E_FOCUS_REQUIRED" 38
    exit 38
  fi

  # Handle dry-run
  if [[ "$DRY_RUN" == "true" ]]; then
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local preview_id
    preview_id=$(generate_session_id)

    if [[ "$FORMAT" == "json" ]]; then
      jq -n \
        --arg sid "$preview_id" \
        --arg ts "$timestamp" \
        --argjson scope "$scope_def" \
        --arg focus "$focus_task" \
        --arg name "$session_name" \
        --arg version "${CLEO_VERSION:-$(get_version)}" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "command": "session start",
            "timestamp": $ts,
            "version": $version
          },
          "success": true,
          "dryRun": true,
          "wouldStart": {
            "sessionId": $sid,
            "scope": $scope,
            "focusTask": $focus,
            "name": (if $name == "" then null else $name end)
          },
          "message": "Would start multi-session (dry-run mode)"
        }'
    else
      log_info "[DRY-RUN] Would start multi-session: $preview_id"
      log_info "[DRY-RUN] Scope: $scope_str"
      log_info "[DRY-RUN] Focus: $focus_task"
    fi
    exit "$EXIT_SUCCESS"
  fi

  # Call the multi-session start function
  local session_id
  if ! session_id=$(start_session "$scope_def" "$focus_task" "$session_name" "$agent_id"); then
    local exit_code=$?
    log_error "Failed to start multi-session" "E_SESSION_START_FAILED" "$exit_code"
    exit "$exit_code"
  fi

  log_step "Multi-session started: $session_id"
  log_info "Scope: $scope_str"
  log_info "Focus: $focus_task"
  [[ -n "$session_name" ]] && log_info "Name: $session_name"

  # Log session start
  if [[ -f "$LOG_FILE" ]]; then
    local timestamp log_id
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    log_id="log_$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    local updated_log
    updated_log=$(jq --arg id "$log_id" --arg ts "$timestamp" --arg sid "$session_id" \
      --argjson scope "$scope_def" --arg focus "$focus_task" '
      .entries += [{
        id: $id,
        timestamp: $ts,
        sessionId: $sid,
        action: "session_start",
        actor: "system",
        taskId: $focus,
        before: null,
        after: null,
        details: "Multi-session started",
        scope: $scope
      }] |
      ._meta.totalEntries += 1 |
      ._meta.lastEntry = $ts
    ' "$LOG_FILE")
    save_json "$LOG_FILE" "$updated_log" || log_warn "Failed to write log entry"
  fi
}

# End current session
cmd_end() {
  local note=""

  # Parse options
  while [[ $# -gt 0 ]]; do
    case $1 in
      --note) note="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  check_todo_exists

  local current_session
  current_session=$(get_current_session)

  if [[ -z "$current_session" ]]; then
    log_warn "No active session to end"
    exit "$EXIT_NO_CHANGE"
  fi

  # Check session.requireSessionNote config setting
  local require_note
  require_note=$(get_config_value "session.requireSessionNote" "false")
  if [[ "$require_note" == "true" ]] && [[ -z "$note" ]]; then
    log_error "Session note required by configuration" "E_SESSION_NOTE_REQUIRED" "$EXIT_INVALID_INPUT" "Use --note 'Your session summary' to end the session"
    exit "$EXIT_INVALID_INPUT"
  fi

  # Check session.sessionTimeoutHours for warning
  local timeout_hours
  timeout_hours=$(get_config_value "session.sessionTimeoutHours" "8")
  if [[ "$timeout_hours" =~ ^[0-9]+$ ]] && [[ "$timeout_hours" -gt 0 ]]; then
    # Extract session start time from session ID (format: session_YYYYMMDD_HHMMSS_hex)
    local session_date_part
    session_date_part=$(echo "$current_session" | sed -n 's/session_\([0-9]\{8\}\)_\([0-9]\{6\}\)_.*/\1\2/p')
    if [[ -n "$session_date_part" ]]; then
      # Parse session start time
      local session_year="${session_date_part:0:4}"
      local session_month="${session_date_part:4:2}"
      local session_day="${session_date_part:6:2}"
      local session_hour="${session_date_part:8:2}"
      local session_min="${session_date_part:10:2}"
      local session_sec="${session_date_part:12:2}"

      # Calculate session start timestamp (platform-compatible)
      local session_start_ts
      if date --version >/dev/null 2>&1; then
        # GNU date
        session_start_ts=$(date -d "${session_year}-${session_month}-${session_day} ${session_hour}:${session_min}:${session_sec}" +%s 2>/dev/null || echo "0")
      else
        # BSD date (macOS)
        session_start_ts=$(date -j -f "%Y%m%d%H%M%S" "$session_date_part" +%s 2>/dev/null || echo "0")
      fi

      if [[ "$session_start_ts" -gt 0 ]]; then
        local current_ts
        current_ts=$(date +%s)
        local elapsed_hours=$(( (current_ts - session_start_ts) / 3600 ))

        if [[ "$elapsed_hours" -ge "$timeout_hours" ]]; then
          log_warn "Session exceeded timeout: ${elapsed_hours}h (limit: ${timeout_hours}h)"
          log_warn "Consider taking breaks for sustained productivity"
        fi
      fi
    fi
  fi

  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Handle --dry-run mode
  if [[ "$DRY_RUN" == "true" ]]; then
    if [[ "$FORMAT" == "json" ]]; then
      jq -n \
        --arg sid "$current_session" \
        --arg ts "$timestamp" \
        --arg version "${CLEO_VERSION:-$(get_version)}" \
        --arg note "$note" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "command": "session end",
            "timestamp": $ts,
            "version": $version
          },
          "success": true,
          "dryRun": true,
          "wouldEnd": {
            "sessionId": $sid,
            "timestamp": $ts,
            "note": (if $note == "" then null else $note end)
          },
          "message": "Would end session (dry-run mode)"
        }'
    else
      log_info "[DRY-RUN] Would end session: $current_session"
      [[ -n "$note" ]] && log_info "[DRY-RUN] Would save note: $note"
    fi
    exit "$EXIT_SUCCESS"
  fi

  # Build update JSON
  local update_expr='
    ._meta.activeSession = null |
    ._meta.lastModified = $ts
  '

  if [[ -n "$note" ]]; then
    update_expr="$update_expr | .focus.sessionNote = \$note"
  fi

  # Update todo.json
  local updated_todo
  if [[ -n "$note" ]]; then
    updated_todo=$(jq --arg ts "$timestamp" --arg note "$note" "$update_expr" "$TODO_FILE")
  else
    updated_todo=$(jq --arg ts "$timestamp" '
      ._meta.activeSession = null |
      ._meta.lastModified = $ts
    ' "$TODO_FILE")
  fi
  save_json "$TODO_FILE" "$updated_todo" || {
    log_error "Failed to end session" "E_FILE_WRITE_ERROR" "$EXIT_FILE_ERROR" "Check file permissions on $TODO_FILE"
    exit "$EXIT_FILE_ERROR"
  }

  # Log session end
  if [[ -f "$LOG_FILE" ]]; then
    local log_id
    log_id="log_$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    local details_json
    if [[ -n "$note" ]]; then
      details_json=$(jq -n --arg note "$note" '{note: $note}')
    else
      details_json="null"
    fi

    local updated_log
    updated_log=$(jq --arg id "$log_id" --arg ts "$timestamp" --arg sid "$current_session" --argjson details "$details_json" '
      .entries += [{
        id: $id,
        timestamp: $ts,
        sessionId: $sid,
        action: "session_end",
        actor: "system",
        taskId: null,
        before: null,
        after: null,
        details: $details
      }] |
      ._meta.totalEntries += 1 |
      ._meta.lastEntry = $ts
    ' "$LOG_FILE")
    save_json "$LOG_FILE" "$updated_log" || log_warn "Failed to write log entry"
  fi

  log_step "Session ended: $current_session"
  [[ -n "$note" ]] && log_info "Note saved: $note" || true

  # Auto-backup on session end if enabled (T632)
  if declare -f auto_backup_on_session_end >/dev/null 2>&1; then
    local backup_path
    backup_path=$(auto_backup_on_session_end "$CONFIG_FILE" 2>/dev/null || true)
    if [[ -n "$backup_path" ]]; then
      log_info "Auto-backup created: $(basename "$backup_path")"
    fi
  fi

  # Display phase context in session end summary (passive capture)
  if declare -f get_current_phase >/dev/null 2>&1; then
    local end_phase
    end_phase=$(get_current_phase "$TODO_FILE")
    if [[ -n "$end_phase" && "$end_phase" != "null" ]]; then
      log_info "Project phase: $end_phase"
    fi
  fi

  # Check and rotate log if needed (T214)
  if declare -f check_and_rotate_log >/dev/null 2>&1; then
    local config_file="${CONFIG_FILE:-.cleo/config.json}"
    [[ -f "$config_file" ]] && check_and_rotate_log "$config_file" "$LOG_FILE" 2>/dev/null || true
  fi
}

# Show session status
cmd_status() {
  local format_arg=""

  while [[ $# -gt 0 ]]; do
    case $1 in
      -f|--format) format_arg="$2"; shift 2 ;;
      --human) format_arg="text"; shift ;;
      --json) format_arg="json"; shift ;;
      -q|--quiet) QUIET=true; shift ;;
      *) shift ;;
    esac
  done

  # Resolve format with TTY-aware detection
  local output_format
  output_format=$(resolve_format "$format_arg")

  check_todo_exists

  local session_id
  local focus_task
  local session_note
  local next_action

  session_id=$(jq -r '._meta.activeSession // ""' "$TODO_FILE")
  focus_task=$(jq -r '.focus.currentTask // ""' "$TODO_FILE")
  session_note=$(jq -r '.focus.sessionNote // ""' "$TODO_FILE")
  next_action=$(jq -r '.focus.nextAction // ""' "$TODO_FILE")

  if [[ "$output_format" == "json" ]]; then
    local current_timestamp
    current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq -n \
      --arg timestamp "$current_timestamp" \
      --arg version "${CLEO_VERSION:-$(get_version)}" \
      --arg session "$session_id" \
      --arg focus "$focus_task" \
      --arg note "$session_note" \
      --arg next "$next_action" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "command": "session status",
          "timestamp": $timestamp,
          "version": $version
        },
        "success": true,
        "session": {
          "active": ($session != ""),
          "sessionId": (if $session == "" then null else $session end),
          "focusTask": (if $focus == "" then null else $focus end),
          "sessionNote": (if $note == "" then null else $note end),
          "nextAction": (if $next == "" then null else $next end)
        }
      }'
  else
    if [[ -n "$session_id" ]]; then
      echo -e "${GREEN}Session Active${NC}: $session_id"
    else
      echo -e "${YELLOW}No Active Session${NC}"
    fi

    if [[ -n "$focus_task" ]]; then
      local task_title
      task_title=$(jq -r --arg id "$focus_task" '.tasks[] | select(.id == $id) | .content // .title // "Unknown"' "$TODO_FILE")
      echo -e "Focus Task: $task_title ($focus_task)"
    fi

    [[ -n "$session_note" ]] && echo -e "Session Note: $session_note" || true
    [[ -n "$next_action" ]] && echo -e "Next Action: $next_action" || true
  fi
}

# Show detailed session info
cmd_info() {
  local format_arg=""

  while [[ $# -gt 0 ]]; do
    case $1 in
      -f|--format) format_arg="$2"; shift 2 ;;
      --human) format_arg="text"; shift ;;
      --json) format_arg="json"; shift ;;
      -q|--quiet) QUIET=true; shift ;;
      *) shift ;;
    esac
  done

  # Resolve format with TTY-aware detection
  local output_format
  output_format=$(resolve_format "$format_arg")

  check_todo_exists

  if [[ "$output_format" == "json" ]]; then
    local current_timestamp
    current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq --arg timestamp "$current_timestamp" --arg version "$VERSION" '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "format": "json",
        "command": "session info",
        "timestamp": $timestamp,
        "version": $version
      },
      "success": true,
      "session": {
        "meta": ._meta,
        "focus": .focus,
        "taskCounts": {
          "total": (.tasks | length),
          "pending": ([.tasks[] | select(.status == "pending")] | length),
          "active": ([.tasks[] | select(.status == "active")] | length),
          "blocked": ([.tasks[] | select(.status == "blocked")] | length),
          "done": ([.tasks[] | select(.status == "done")] | length)
        }
      }
    }' "$TODO_FILE"
  else
    echo ""
    echo "=== Session Information ==="
    echo ""

    local session_id
    session_id=$(jq -r '._meta.activeSession // "none"' "$TODO_FILE")
    echo "Session ID: $session_id"

    local last_modified
    last_modified=$(jq -r '._meta.lastModified // "unknown"' "$TODO_FILE")
    echo "Last Modified: $last_modified"

    echo ""
    echo "=== Focus State ==="
    jq -r '.focus | to_entries[] | "  \(.key): \(.value // "not set")"' "$TODO_FILE"

    echo ""
    echo "=== Task Counts ==="
    echo "  Total: $(jq '.tasks | length' "$TODO_FILE")"
    echo "  Pending: $(jq '[.tasks[] | select(.status == "pending")] | length' "$TODO_FILE")"
    echo "  Active: $(jq '[.tasks[] | select(.status == "active")] | length' "$TODO_FILE")"
    echo "  Blocked: $(jq '[.tasks[] | select(.status == "blocked")] | length' "$TODO_FILE")"
    echo "  Done: $(jq '[.tasks[] | select(.status == "done")] | length' "$TODO_FILE")"
    echo ""
  fi
}

# Parse global options before command
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN=true; shift ;;
    -f|--format) FORMAT="$2"; shift 2 ;;
    --json) FORMAT="json"; shift ;;
    --human) FORMAT="text"; shift ;;
    -q|--quiet) QUIET=true; shift ;;
    -*) break ;;  # Unknown option, let subcommand handle
    *) break ;;   # First non-option is command
  esac
done

# Resolve format with TTY-aware detection
FORMAT=$(resolve_format "$FORMAT")

# ============================================================================
# MULTI-SESSION COMMANDS
# ============================================================================

# Suspend current multi-session
cmd_suspend() {
  local note="" session_id=""

  while [[ $# -gt 0 ]]; do
    case $1 in
      --note) note="$2"; shift 2 ;;
      --session) session_id="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  # Check multi-session enabled
  if ! is_multi_session_enabled "$CONFIG_FILE" 2>/dev/null; then
    log_error "Multi-session mode not enabled" "E_CONFIG_ERROR" "$EXIT_INVALID_INPUT"
    exit "$EXIT_INVALID_INPUT"
  fi

  # Get session ID if not provided
  if [[ -z "$session_id" ]]; then
    session_id=$(get_current_session_id 2>/dev/null || true)
    if [[ -z "$session_id" ]]; then
      log_error "No current session. Use --session ID or set CLEO_SESSION" "E_SESSION_NOT_FOUND" "$EXIT_NOT_FOUND"
      exit "$EXIT_NOT_FOUND"
    fi
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[DRY-RUN] Would suspend session: $session_id"
    exit "$EXIT_SUCCESS"
  fi

  if suspend_session "$session_id" "$note"; then
    log_step "Session suspended: $session_id"
    [[ -n "$note" ]] && log_info "Note: $note"
  else
    log_error "Failed to suspend session" "E_SESSION_SUSPEND_FAILED" "$?"
    exit $?
  fi
}

# Resume a suspended multi-session
cmd_resume() {
  local session_id="" last_mode=false

  while [[ $# -gt 0 ]]; do
    case $1 in
      --last) last_mode=true; shift ;;
      -*) shift ;;
      *) session_id="$1"; shift ;;
    esac
  done

  # Check multi-session enabled
  if ! is_multi_session_enabled "$CONFIG_FILE" 2>/dev/null; then
    log_error "Multi-session mode not enabled" "E_CONFIG_ERROR" "$EXIT_INVALID_INPUT"
    exit "$EXIT_INVALID_INPUT"
  fi

  local sessions_file
  sessions_file=$(get_sessions_file)

  # Handle --last mode
  if [[ "$last_mode" == "true" ]]; then
    session_id=$(jq -r '[.sessions[] | select(.status == "suspended")] | sort_by(.suspendedAt) | last | .id // ""' "$sessions_file")
    if [[ -z "$session_id" ]]; then
      log_error "No suspended sessions to resume" "E_SESSION_NOT_FOUND" "$EXIT_NOT_FOUND"
      exit "$EXIT_NOT_FOUND"
    fi
  fi

  if [[ -z "$session_id" ]]; then
    log_error "Session ID required. Use: cleo session resume <session-id> or --last" "E_INVALID_INPUT" "$EXIT_INVALID_INPUT"
    exit "$EXIT_INVALID_INPUT"
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[DRY-RUN] Would resume session: $session_id"
    exit "$EXIT_SUCCESS"
  fi

  if resume_session "$session_id"; then
    log_step "Session resumed: $session_id"

    # Show session info
    local session_info
    session_info=$(get_session "$session_id")
    local focus_task session_name
    focus_task=$(echo "$session_info" | jq -r '.focus.currentTask // ""')
    session_name=$(echo "$session_info" | jq -r '.name // ""')

    [[ -n "$session_name" ]] && log_info "Name: $session_name"
    [[ -n "$focus_task" ]] && log_info "Focus: $focus_task"
  else
    log_error "Failed to resume session" "E_SESSION_RESUME_FAILED" "$?"
    exit $?
  fi
}

# List all sessions
cmd_list() {
  local status_filter="all" format_arg=""

  while [[ $# -gt 0 ]]; do
    case $1 in
      --status) status_filter="$2"; shift 2 ;;
      -f|--format) format_arg="$2"; shift 2 ;;
      --human) format_arg="text"; shift ;;
      --json) format_arg="json"; shift ;;
      *) shift ;;
    esac
  done

  local output_format
  output_format=$(resolve_format "$format_arg")

  local sessions_file
  sessions_file=$(get_sessions_file)

  if [[ ! -f "$sessions_file" ]]; then
    if [[ "$output_format" == "json" ]]; then
      jq -n '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "success": true,
        "sessions": [],
        "message": "No sessions file found (multi-session not initialized)"
      }'
    else
      log_info "No sessions (multi-session not initialized)"
    fi
    exit "$EXIT_SUCCESS"
  fi

  local sessions
  sessions=$(list_sessions "$status_filter")

  if [[ "$output_format" == "json" ]]; then
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq -n \
      --arg ts "$timestamp" \
      --arg version "${CLEO_VERSION:-$(get_version)}" \
      --argjson sessions "$sessions" \
      --arg filter "$status_filter" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "command": "session list",
          "timestamp": $ts,
          "version": $version
        },
        "success": true,
        "filter": $filter,
        "count": ($sessions | length),
        "sessions": $sessions
      }'
  else
    local count
    count=$(echo "$sessions" | jq 'length')

    if [[ "$count" -eq 0 ]]; then
      echo "No sessions found (filter: $status_filter)"
    else
      echo ""
      echo "Sessions ($count):"
      echo "─────────────────────────────────────────────────────────"
      echo "$sessions" | jq -r '.[] | "\(.status | if . == "active" then "●" else "○" end) \(.id) \(.name // "(unnamed)") [\(.scope.type):\(.scope.rootTaskId // "custom")]"'
      echo ""
    fi
  fi
}

# Show session details
cmd_show_session() {
  local session_id="" format_arg=""

  while [[ $# -gt 0 ]]; do
    case $1 in
      -f|--format) format_arg="$2"; shift 2 ;;
      --human) format_arg="text"; shift ;;
      --json) format_arg="json"; shift ;;
      -*) shift ;;
      *) session_id="$1"; shift ;;
    esac
  done

  local output_format
  output_format=$(resolve_format "$format_arg")

  # Get session ID if not provided
  if [[ -z "$session_id" ]]; then
    session_id=$(get_current_session_id 2>/dev/null || true)
    if [[ -z "$session_id" ]]; then
      log_error "Session ID required. Use: cleo session show <session-id>" "E_INVALID_INPUT" "$EXIT_INVALID_INPUT"
      exit "$EXIT_INVALID_INPUT"
    fi
  fi

  local session_info
  session_info=$(get_session "$session_id")

  if [[ -z "$session_info" ]]; then
    log_error "Session not found: $session_id" "E_SESSION_NOT_FOUND" "$EXIT_NOT_FOUND"
    exit "$EXIT_NOT_FOUND"
  fi

  if [[ "$output_format" == "json" ]]; then
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq -n \
      --arg ts "$timestamp" \
      --arg version "${CLEO_VERSION:-$(get_version)}" \
      --argjson session "$session_info" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "command": "session show",
          "timestamp": $ts,
          "version": $version
        },
        "success": true,
        "session": $session
      }'
  else
    echo ""
    echo "Session: $(echo "$session_info" | jq -r '.id')"
    echo "─────────────────────────────────────────────────────────"
    echo "Status:      $(echo "$session_info" | jq -r '.status')"
    echo "Name:        $(echo "$session_info" | jq -r '.name // "(unnamed)"')"
    echo "Agent:       $(echo "$session_info" | jq -r '.agentId // "(none)"')"
    echo ""
    echo "Scope:"
    echo "  Type:      $(echo "$session_info" | jq -r '.scope.type')"
    echo "  Root:      $(echo "$session_info" | jq -r '.scope.rootTaskId // "N/A"')"
    echo "  Tasks:     $(echo "$session_info" | jq -r '.scope.computedTaskIds | length') in scope"
    echo ""
    echo "Focus:"
    echo "  Current:   $(echo "$session_info" | jq -r '.focus.currentTask // "(none)"')"
    echo "  Note:      $(echo "$session_info" | jq -r '.focus.sessionNote // "(none)"')"
    echo ""
    echo "Timeline:"
    echo "  Started:   $(echo "$session_info" | jq -r '.startedAt')"
    echo "  Activity:  $(echo "$session_info" | jq -r '.lastActivity')"
    echo ""
    echo "Stats:"
    echo "  Completed: $(echo "$session_info" | jq -r '.stats.tasksCompleted')"
    echo "  Focuses:   $(echo "$session_info" | jq -r '.stats.focusChanges')"
    echo ""
  fi
}

# Switch to a different session (sets CLEO_SESSION context)
cmd_switch() {
  local session_id=""

  while [[ $# -gt 0 ]]; do
    case $1 in
      -*) shift ;;
      *) session_id="$1"; shift ;;
    esac
  done

  if [[ -z "$session_id" ]]; then
    log_error "Session ID required. Use: cleo session switch <session-id>" "E_INVALID_INPUT" "$EXIT_INVALID_INPUT"
    exit "$EXIT_INVALID_INPUT"
  fi

  # Verify session exists
  local session_info
  session_info=$(get_session "$session_id" 2>/dev/null)

  if [[ -z "$session_info" ]]; then
    log_error "Session not found: $session_id" "E_SESSION_NOT_FOUND" "$EXIT_NOT_FOUND"
    exit "$EXIT_NOT_FOUND"
  fi

  # Write to .current-session file
  local current_session_file
  current_session_file="$(get_cleo_dir)/.current-session"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[DRY-RUN] Would switch to session: $session_id"
    exit "$EXIT_SUCCESS"
  fi

  echo "$session_id" > "$current_session_file"

  log_step "Switched to session: $session_id"
  log_info "Set CLEO_SESSION=$session_id in your environment for persistent context"

  # Show session info
  local focus_task session_name status
  focus_task=$(echo "$session_info" | jq -r '.focus.currentTask // ""')
  session_name=$(echo "$session_info" | jq -r '.name // ""')
  status=$(echo "$session_info" | jq -r '.status')

  [[ -n "$session_name" ]] && log_info "Name: $session_name"
  log_info "Status: $status"
  [[ -n "$focus_task" ]] && log_info "Focus: $focus_task"
}

# Main command dispatch
COMMAND="${1:-help}"
shift || true

case "$COMMAND" in
  start)   cmd_start "$@" ;;
  end)     cmd_end "$@" ;;
  status)  cmd_status "$@" ;;
  info)    cmd_info "$@" ;;
  suspend) cmd_suspend "$@" ;;
  resume)  cmd_resume "$@" ;;
  list)    cmd_list "$@" ;;
  show)    cmd_show_session "$@" ;;
  switch)  cmd_switch "$@" ;;
  -h|--help|help) usage ;;
  *)
    log_error "Unknown command: $COMMAND" "E_INPUT_INVALID" "$EXIT_INVALID_INPUT" "Run 'cleo session --help' for usage"
    exit "$EXIT_INVALID_INPUT"
    ;;
esac
