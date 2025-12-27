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

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/todo-config.json}"
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
  start       Start a new session
  end         End the current session
  status      Show current session status
  info        Show detailed session information

Options:
  --note TEXT       Add a note when ending session
  -f, --format FMT  Output format: text|json (default: auto)
  --human           Force text output (human-readable)
  --json            Force JSON output (machine-readable)
  -q, --quiet       Suppress informational messages
  --dry-run         Show what would be changed without modifying files
  -h, --help        Show this help

Format Auto-Detection:
  When no format is specified, output format is automatically detected:
  - Interactive terminal (TTY): human-readable text format
  - Pipe/redirect/agent context: machine-readable JSON format

Config Settings (in .cleo/todo-config.json):
  session.requireSessionNote   If true, require --note when ending session (default: false)
  session.warnOnNoFocus        If true, warn when starting without focus (default: true)
  session.sessionTimeoutHours  Warn if session exceeds this duration (default: 8)
  session.autoStartSession     If true, auto-start session on first command (default: false)

Examples:
  cleo session start                    # Start new session
  cleo session end --note "Completed auth implementation"
  cleo session status                   # Check current session
  cleo session info --json              # Detailed info as JSON
  cleo session status --format json     # Machine-readable status
  cleo session start --dry-run          # Preview session start
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

# Start a new session
cmd_start() {
  check_todo_exists

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
          "$schema": "https://claude-todo.dev/schemas/v1/output.schema.json",
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
  if [[ -f "CLAUDE.md" ]] && [[ -f "$CLEO_HOME/templates/CLAUDE-INJECTION.md" ]]; then
    local current_version installed_version
    current_version=$(grep -oP 'CLAUDE-TODO:START v\K[0-9.]+' CLAUDE.md 2>/dev/null || echo "")
    installed_version=$(grep -oP 'CLAUDE-TODO:START v\K[0-9.]+' "$CLEO_HOME/templates/CLAUDE-INJECTION.md" 2>/dev/null || echo "")

    if [[ -n "$installed_version" ]] && [[ "$current_version" != "$installed_version" ]]; then
      log_warn "CLAUDE.md injection outdated (${current_version:-unknown} → $installed_version)"
      log_warn "Run: cleo init --update-claude-md"
    fi
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
          "$schema": "https://claude-todo.dev/schemas/v1/output.schema.json",
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
    local config_file="${CONFIG_FILE:-.cleo/todo-config.json}"
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
        "$schema": "https://claude-todo.dev/schemas/v1/output.schema.json",
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
      "$schema": "https://claude-todo.dev/schemas/v1/output.schema.json",
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

# Main command dispatch
COMMAND="${1:-help}"
shift || true

case "$COMMAND" in
  start)  cmd_start "$@" ;;
  end)    cmd_end "$@" ;;
  status) cmd_status "$@" ;;
  info)   cmd_info "$@" ;;
  -h|--help|help) usage ;;
  *)
    log_error "Unknown command: $COMMAND" "E_INPUT_INVALID" "$EXIT_INVALID_INPUT" "Run 'cleo session --help' for usage"
    exit "$EXIT_INVALID_INPUT"
    ;;
esac
