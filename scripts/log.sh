#!/usr/bin/env bash
###CLEO
# command: log
# category: read
# synopsis: View audit log entries (operations, timestamps, changes)
# relevance: medium
# flags: --format,--quiet,--limit,--offset,--operation,--task
# exits: 0,100
# json-output: true
###END
# CLEO Log Script
# Add entries to todo-log.json
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source version from central location
# Source version library for proper version management
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/core/version.sh" ]]; then
  # shellcheck source=../lib/core/version.sh
  source "$LIB_DIR/core/version.sh"
fi

# Source logging library for should_use_color function
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/core/logging.sh" ]]; then
  # shellcheck source=../lib/core/logging.sh
  source "$LIB_DIR/core/logging.sh"
fi

# Source output-format library for format resolution
if [[ -f "$LIB_DIR/core/output-format.sh" ]]; then
  source "$LIB_DIR/core/output-format.sh"
fi

# Source exit codes and error-json libraries
if [[ -f "$LIB_DIR/core/exit-codes.sh" ]]; then
  source "$LIB_DIR/core/exit-codes.sh"
fi
if [[ -f "$LIB_DIR/core/error-json.sh" ]]; then
  source "$LIB_DIR/core/error-json.sh"
fi

# Source file-ops library for save_json function
if [[ -f "$LIB_DIR/data/file-ops.sh" ]]; then
  # shellcheck source=../lib/data/file-ops.sh
  source "$LIB_DIR/data/file-ops.sh"
fi

# shellcheck source=../lib/ui/flags.sh
if [[ -f "$LIB_DIR/ui/flags.sh" ]]; then
  source "$LIB_DIR/ui/flags.sh"
fi

# Source JSON output library for pagination support
# @task T1446
if [[ -f "$LIB_DIR/core/json-output.sh" ]]; then
  # shellcheck source=../lib/core/json-output.sh
  source "$LIB_DIR/core/json-output.sh"
fi

# Set TODO_FILE after sourcing logging.sh (LOG_FILE is set by logging.sh)
TODO_FILE="${TODO_FILE:-.cleo/todo.json}"

# Colors (respects NO_COLOR and FORCE_COLOR environment variables per https://no-color.org)
if declare -f should_use_color >/dev/null 2>&1 && should_use_color; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  NC='\033[0m'
else
  RED='' GREEN='' NC=''
fi

# Command name for output formatting
COMMAND_NAME="log"

# Initialize flag defaults
init_flag_defaults

# Defaults
ACTION=""
TASK_ID=""
SESSION_ID=""
BEFORE=""
AFTER=""
DETAILS=""
ACTOR="claude"

# Helper function to validate action against library's VALID_ACTIONS array
validate_action() {
  local action="$1"
  # Check if VALID_ACTIONS array is available from logging.sh
  if declare -p VALID_ACTIONS 2>/dev/null | grep -q 'declare -ar'; then
    for valid in "${VALID_ACTIONS[@]}"; do
      [[ "$action" == "$valid" ]] && return 0
    done
    return 1
  else
    # Fallback if library not sourced (shouldn't happen)
    local valid_actions="session_start session_end task_created task_updated status_changed task_archived focus_changed config_changed validation_run checksum_updated error_occurred"
    echo "$valid_actions" | grep -qw "$action"
  fi
}

# Helper function to get valid actions string for display
get_valid_actions_string() {
  if declare -p VALID_ACTIONS 2>/dev/null | grep -q 'declare -ar'; then
    echo "${VALID_ACTIONS[*]}"
  else
    echo "session_start session_end task_created task_updated status_changed task_archived focus_changed config_changed validation_run checksum_updated error_occurred"
  fi
}

usage() {
  cat << EOF
Usage: cleo log [SUBCOMMAND] [OPTIONS]

Manage todo-log.json entries.

Subcommands:
  list              List log entries (with filtering)
  show <log-id>     Show details of a specific log entry
  migrate           Migrate old schema entries to new schema
  add               Add a new log entry (default if --action specified)

List options:
  --limit N         Show last N entries (default: 20, 0 = all)
  --action ACTION   Filter by action type
  --task-id ID      Filter by task ID
  --actor ACTOR     Filter by actor (human|claude|system)
  --since DATE      Show entries since date (YYYY-MM-DD)
  -f, --format FMT  Output format: text|json (default: auto)
  --human           Force text output (human-readable)
  --json            Force JSON output (machine-readable)
  -q, --quiet       Suppress informational messages

Format Auto-Detection:
  When no format is specified, output format is automatically detected:
  - Interactive terminal (TTY): human-readable text format
  - Pipe/redirect/agent context: machine-readable JSON format

Add entry options:
  --action ACTION   One of: $(get_valid_actions_string)
  --task-id ID      Task ID (for task-related actions)
  --session-id ID   Session ID
  --before JSON     State before change
  --after JSON      State after change
  --details JSON    Additional details
  --actor ACTOR     human|claude|system (default: claude)
  -h, --help        Show this help

Examples:
  # List log entries
  cleo log list                              # Last 20 entries
  cleo log list --limit 50                   # Last 50 entries
  cleo log list --action task_created        # Filter by action
  cleo log list --task-id T001               # Filter by task
  cleo log list --since "2025-12-13"         # Since date
  cleo log list --format json                # JSON output

  # Show specific entry
  cleo log show log_abc123

  # Migrate old log entries
  cleo log migrate

  # Add log entries
  cleo log --action session_start --session-id "session_20251205_..."
  cleo log --action status_changed --task-id T001 --before '{"status":"pending"}' --after '{"status":"active"}'
  cleo log --action task_created --task-id T005 --after '{"title":"New task"}'
EOF
  exit "$EXIT_SUCCESS"
}

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# Check dependencies
if ! command -v jq &> /dev/null; then
  if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
    output_error "$E_DEPENDENCY_MISSING" "jq is required but not installed" "${EXIT_DEPENDENCY_ERROR:-5}" false "Install jq: apt install jq (Debian) or brew install jq (macOS)"
  else
    log_error "jq is required but not installed"
  fi
  exit "${EXIT_DEPENDENCY_ERROR:-5}"
fi

# Parse subcommand
SUBCOMMAND=""
if [[ $# -gt 0 ]] && [[ "$1" != -* ]]; then
  SUBCOMMAND="$1"
  shift
fi

# Handle subcommands
case "$SUBCOMMAND" in
  list)
    # List log entries with filtering
    LIMIT=20
    OFFSET=0
    FILTER_ACTION=""
    FILTER_TASK_ID=""
    FILTER_ACTOR=""
    FILTER_SINCE=""
    COMMAND_NAME="log"

    # Parse common flags first
    parse_common_flags "$@"
    set -- "${REMAINING_ARGS[@]}"

    # Bridge to legacy variables
    apply_flags_to_globals
    FORMAT="${FORMAT:-}"
    QUIET="${QUIET:-false}"

    # Handle help flag
    if [[ "$FLAG_HELP" == true ]]; then
      usage
    fi

    # Parse list-specific options
    while [[ $# -gt 0 ]]; do
      case $1 in
        --limit) LIMIT="$2"; shift 2 ;;
        --offset) OFFSET="$2"; shift 2 ;;
        --action) FILTER_ACTION="$2"; shift 2 ;;
        --task-id) FILTER_TASK_ID="$2"; shift 2 ;;
        --actor) FILTER_ACTOR="$2"; shift 2 ;;
        --since) FILTER_SINCE="$2"; shift 2 ;;
        -*)
          if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_INPUT_INVALID" "Unknown option: $1" "${EXIT_USAGE_ERROR:-64}" false "Run 'cleo log --help' for usage"
          else
            output_error "$E_INPUT_INVALID" "Unknown option: $1"
          fi
          exit "${EXIT_USAGE_ERROR:-64}"
          ;;
        *) shift ;;
      esac
    done

    # Resolve format with TTY-aware detection
    FORMAT=$(resolve_format "$FORMAT")

    # Validate log file exists
    if [[ ! -f "$LOG_FILE" ]]; then
      if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
        output_error "$E_FILE_NOT_FOUND" "Log file not found: $LOG_FILE" "${EXIT_FILE_ERROR:-4}" true "Initialize project with 'cleo init' first"
      else
        log_error "Log file not found: $LOG_FILE"
      fi
      exit "${EXIT_FILE_ERROR:-4}"
    fi

    # Build jq filter for content filtering (before pagination)
    # @task T1446 - Separate filtering from pagination for metadata
    JQ_FILTER='.entries'

    # Apply filters
    if [[ -n "$FILTER_ACTION" ]]; then
      JQ_FILTER="$JQ_FILTER | map(select(.action == \"$FILTER_ACTION\"))"
    fi

    if [[ -n "$FILTER_TASK_ID" ]]; then
      JQ_FILTER="$JQ_FILTER | map(select(.taskId == \"$FILTER_TASK_ID\"))"
    fi

    if [[ -n "$FILTER_ACTOR" ]]; then
      JQ_FILTER="$JQ_FILTER | map(select(.actor == \"$FILTER_ACTOR\"))"
    fi

    if [[ -n "$FILTER_SINCE" ]]; then
      # Convert date to ISO format for comparison
      SINCE_ISO="${FILTER_SINCE}T00:00:00Z"
      JQ_FILTER="$JQ_FILTER | map(select(.timestamp >= \"$SINCE_ISO\"))"
    fi

    # Get total filtered count BEFORE pagination
    all_filtered=$(jq -c "$JQ_FILTER" "$LOG_FILE")
    total_filtered=$(echo "$all_filtered" | jq 'length')

    # Apply pagination: limit + offset
    if [[ "$LIMIT" -gt 0 ]] && [[ "$OFFSET" -gt 0 ]]; then
      entries=$(echo "$all_filtered" | jq -c ".[-$(( LIMIT + OFFSET )):][-$LIMIT:] // .[$OFFSET:$((OFFSET + LIMIT))]")
    elif [[ "$LIMIT" -gt 0 ]]; then
      entries=$(echo "$all_filtered" | jq -c ".[-$LIMIT:]")
    elif [[ "$OFFSET" -gt 0 ]]; then
      entries=$(echo "$all_filtered" | jq -c ".[$OFFSET:]")
    else
      entries="$all_filtered"
    fi

    entry_count=$(echo "$entries" | jq 'length')

    # Output format
    if [[ "$FORMAT" == "json" ]]; then
      # Wrap in standard envelope per LLM-Agent-First spec
      current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

      # Build pagination metadata (@task T1446)
      PAGINATION_JSON="null"
      if [[ "$LIMIT" -gt 0 || "$OFFSET" -gt 0 ]]; then
        _effective_limit="${LIMIT:-0}"
        if declare -f get_pagination_meta >/dev/null 2>&1; then
          PAGINATION_JSON=$(get_pagination_meta "$total_filtered" "$_effective_limit" "$OFFSET")
        else
          _has_more="false"
          if [[ "$_effective_limit" -gt 0 ]] && (( OFFSET + _effective_limit < total_filtered )); then
            _has_more="true"
          fi
          PAGINATION_JSON=$(jq -nc \
            --argjson total "$total_filtered" \
            --argjson limit "$_effective_limit" \
            --argjson offset "$OFFSET" \
            --argjson has_more "$_has_more" \
            '{total: $total, limit: $limit, offset: $offset, hasMore: $has_more}')
        fi
      fi

      jq -nc \
        --arg timestamp "$current_timestamp" \
        --arg version "${CLEO_VERSION:-$(get_version)}" \
        --argjson entries "$entries" \
        --argjson count "$entry_count" \
        --argjson total_filtered "$total_filtered" \
        --argjson limit "$LIMIT" \
        --argjson pagination "$PAGINATION_JSON" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "command": "log list",
            "timestamp": $timestamp,
            "version": $version
          },
          "success": true,
          "summary": {
            "entryCount": $count,
            "totalFiltered": $total_filtered,
            "limit": (if $limit == 0 then null else $limit end)
          },
          "pagination": $pagination,
          "entries": $entries
        } | if .pagination == null then del(.pagination) else . end'
    else
      # Text format - output each entry line by line
      echo "$entries" | jq -r '.[] |
        "[\(.timestamp | sub("T"; " ") | sub("Z"; ""))] \(.action) - \(.taskId // "(no task)") by \(.actor)" +
        (if .after.title then "\n  title: \"\(.after.title)\"" else "" end) +
        (if .details then "\n  details: \(.details | tostring)" else "" end)
      '
    fi

    exit "$EXIT_SUCCESS"
    ;;

  show)
    # Show specific log entry
    if [[ $# -lt 1 ]]; then
      if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
        output_error "$E_INPUT_MISSING" "Log ID required" "${EXIT_USAGE_ERROR:-64}" false "Usage: cleo log show <log-id>"
      else
        log_error "Log ID required. Usage: cleo log show <log-id>"
      fi
      exit "${EXIT_USAGE_ERROR:-64}"
    fi

    LOG_ID="$1"
    shift

    # Validate log file exists
    if [[ ! -f "$LOG_FILE" ]]; then
      if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
        output_error "$E_FILE_NOT_FOUND" "Log file not found: $LOG_FILE" "${EXIT_FILE_ERROR:-4}" true "Initialize project with 'cleo init' first"
      else
        log_error "Log file not found: $LOG_FILE"
      fi
      exit "${EXIT_FILE_ERROR:-4}"
    fi

    # Find and display entry
    ENTRY=$(jq --arg id "$LOG_ID" '.entries[] | select(.id == $id)' "$LOG_FILE")

    if [[ -z "$ENTRY" ]]; then
      if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
        output_error "$E_TASK_NOT_FOUND" "Log entry not found: $LOG_ID" "${EXIT_NOT_FOUND:-1}" true "Use 'cleo log list' to see available entries"
      else
        log_error "Log entry not found: $LOG_ID"
      fi
      exit "${EXIT_NOT_FOUND:-1}"
    fi

    # Display entry in readable format
    echo "$ENTRY" | jq -r '
      "Log Entry: \(.id)",
      "Timestamp:  \(.timestamp | sub("T"; " ") | sub("Z"; ""))",
      "Action:     \(.action)",
      "Actor:      \(.actor)",
      (if .taskId then "Task ID:    \(.taskId)" else "" end),
      (if .sessionId then "Session ID: \(.sessionId)" else "" end),
      "",
      (if .before then "Before:\n\(.before | tojson)" else "" end),
      (if .after then "After:\n\(.after | tojson)" else "" end),
      (if .details then "Details:\n\(.details | if type == "string" then . else tojson end)" else "" end)
    ' | grep -v '^$' || true

    exit "$EXIT_SUCCESS"
    ;;

  migrate)
    # Migrate old schema to new schema
    if ! declare -f migrate_log_entries >/dev/null 2>&1; then
      if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
        output_error "$E_DEPENDENCY_MISSING" "migrate_log_entries function not available from logging.sh" "${EXIT_DEPENDENCY_ERROR:-5}" false "Ensure logging.sh is properly sourced"
      else
        log_error "migrate_log_entries function not available from logging.sh"
      fi
      exit "${EXIT_DEPENDENCY_ERROR:-5}"
    fi

    log_info "Starting log migration..."
    migrated_count=$(migrate_log_entries "$LOG_FILE")
    if [[ $? -eq 0 ]]; then
      log_info "Migration completed successfully ($migrated_count entries migrated)"
      exit "$EXIT_SUCCESS"
    else
      log_error "Migration failed"
      exit "$EXIT_GENERAL_ERROR"
    fi
    ;;
  rotate)
    # Manual log rotation (T214)
    if ! declare -f rotate_log >/dev/null 2>&1; then
      if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
        output_error "$E_DEPENDENCY_MISSING" "rotate_log function not available from logging.sh" "${EXIT_DEPENDENCY_ERROR:-5}" false "Ensure logging.sh is properly sourced"
      else
        log_error "rotate_log function not available from logging.sh"
      fi
      exit "${EXIT_DEPENDENCY_ERROR:-5}"
    fi

    FORCE=false
    while [[ $# -gt 0 ]]; do
      case $1 in
        --force) FORCE=true; shift ;;
        -h|--help)
          echo "Usage: cleo log rotate [OPTIONS]"
          echo ""
          echo "Rotate log file if it exceeds configured threshold."
          echo ""
          echo "Options:"
          echo "  --force    Force rotation regardless of size"
          echo "  --help     Show this help"
          exit "$EXIT_SUCCESS"
          ;;
        *) shift ;;
      esac
    done

    if [[ ! -f "$LOG_FILE" ]]; then
      if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
        output_error "$E_FILE_NOT_FOUND" "Log file not found: $LOG_FILE" "${EXIT_FILE_ERROR:-4}" true "Initialize project with 'cleo init' first"
      else
        log_error "Log file not found: $LOG_FILE"
      fi
      exit "${EXIT_FILE_ERROR:-4}"
    fi

    current_size=$(stat -c%s "$LOG_FILE" 2>/dev/null || stat -f%z "$LOG_FILE" 2>/dev/null || echo "0")
    size_kb=$((current_size / 1024))

    CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"

    if [[ "$FORCE" == "true" ]]; then
      log_info "Forcing log rotation..."
      rotate_log 30 "$LOG_FILE"
      log_success "Log rotated successfully"
    else
      log_info "Current log size: ${size_kb}KB"
      if [[ -f "$CONFIG_FILE" ]]; then
        check_and_rotate_log "$CONFIG_FILE" "$LOG_FILE"
        log_info "Log rotation check complete"
      else
        log_warn "No config file found, skipping automatic rotation"
        log_info "Use --force to rotate anyway"
      fi
    fi
    exit "$EXIT_SUCCESS"
    ;;

  add|"")
    # Fall through to add entry logic
    ;;
  *)
    if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_INPUT_INVALID" "Unknown subcommand: $SUBCOMMAND" "${EXIT_USAGE_ERROR:-64}" false "Run 'cleo log --help' for usage"
    else
      output_error "$E_INPUT_INVALID" "Unknown subcommand: $SUBCOMMAND"
    fi
    exit "${EXIT_USAGE_ERROR:-64}"
    ;;
esac

# Parse arguments for add entry
while [[ $# -gt 0 ]]; do
  case $1 in
    --action) ACTION="$2"; shift 2 ;;
    --task-id) TASK_ID="$2"; shift 2 ;;
    --session-id) SESSION_ID="$2"; shift 2 ;;
    --before) BEFORE="$2"; shift 2 ;;
    --after) AFTER="$2"; shift 2 ;;
    --details) DETAILS="$2"; shift 2 ;;
    --actor) ACTOR="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*)
      if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
        output_error "$E_INPUT_INVALID" "Unknown option: $1" "${EXIT_USAGE_ERROR:-64}" false "Run 'cleo log --help' for usage"
      else
        output_error "$E_INPUT_INVALID" "Unknown option: $1"
      fi
      exit "${EXIT_USAGE_ERROR:-64}"
      ;;
    *) shift ;;
  esac
done

# Validate action
if [[ -z "$ACTION" ]]; then
  if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
    output_error "$E_INPUT_MISSING" "Action required" "${EXIT_USAGE_ERROR:-64}" false "Use --action to specify an action type"
  else
    log_error "Action required. Use --action"
  fi
  exit "${EXIT_USAGE_ERROR:-64}"
fi

if ! validate_action "$ACTION"; then
  if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
    output_error "$E_INPUT_INVALID" "Invalid action: $ACTION" "${EXIT_VALIDATION_ERROR:-2}" false "Valid actions: $(get_valid_actions_string)"
  else
    log_error "Invalid action: $ACTION"
    echo "Valid actions: $(get_valid_actions_string)"
  fi
  exit "${EXIT_VALIDATION_ERROR:-2}"
fi

# Validate actor
if ! echo "human claude system" | grep -qw "$ACTOR"; then
  if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
    output_error "$E_INPUT_INVALID" "Invalid actor: $ACTOR" "${EXIT_VALIDATION_ERROR:-2}" false "Actor must be one of: human, claude, system"
  else
    log_error "Invalid actor: $ACTOR (must be human, claude, or system)"
  fi
  exit "${EXIT_VALIDATION_ERROR:-2}"
fi

# Validate JSON inputs
for var in BEFORE AFTER DETAILS; do
  val="${!var}"
  if [[ -n "$val" ]] && ! echo "$val" | jq empty 2>/dev/null; then
    if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_INPUT_FORMAT" "Invalid JSON for --$(echo $var | tr '[:upper:]' '[:lower:]')" "${EXIT_VALIDATION_ERROR:-2}" false "Ensure valid JSON syntax for the value"
    else
      log_error "Invalid JSON for --$(echo $var | tr '[:upper:]' '[:lower:]'): $val"
    fi
    exit "${EXIT_VALIDATION_ERROR:-2}"
  fi
done

# Get session ID from todo.json if not provided
if [[ -z "$SESSION_ID" ]] && [[ -f "$TODO_FILE" ]]; then
  SESSION_ID=$(jq -r '._meta.activeSession // ""' "$TODO_FILE")
fi

# Create log file if missing
if [[ ! -f "$LOG_FILE" ]]; then
  PROJECT=""
  [[ -f "$TODO_FILE" ]] && PROJECT=$(jq -r '.project' "$TODO_FILE")
  cat > "$LOG_FILE" << EOF
{
  "version": "$VERSION",
  "project": "$PROJECT",
  "_meta": {
    "totalEntries": 0,
    "firstEntry": null,
    "lastEntry": null,
    "entriesPruned": 0
  },
  "entries": []
}
EOF
  log_info "Created $LOG_FILE"
fi

# Generate entry
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
LOG_ID="log_$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 12)"

# Build entry JSON
ENTRY=$(jq -nc \
  --arg id "$LOG_ID" \
  --arg ts "$TIMESTAMP" \
  --arg sid "$SESSION_ID" \
  --arg action "$ACTION" \
  --arg actor "$ACTOR" \
  --arg tid "$TASK_ID" \
  --argjson before "${BEFORE:-null}" \
  --argjson after "${AFTER:-null}" \
  --argjson details "${DETAILS:-null}" \
  '{
    id: $id,
    timestamp: $ts,
    sessionId: (if $sid == "" then null else $sid end),
    action: $action,
    actor: $actor,
    taskId: (if $tid == "" then null else $tid end),
    before: $before,
    after: $after,
    details: $details
  }')

# Build updated log content
UPDATED_LOG=$(jq --argjson entry "$ENTRY" --arg ts "$TIMESTAMP" '
  .entries += [$entry] |
  ._meta.totalEntries += 1 |
  ._meta.lastEntry = $ts |
  ._meta.firstEntry = (._meta.firstEntry // $ts)
' "$LOG_FILE")

# Atomic write with file locking via save_json
if ! save_json "$LOG_FILE" "$UPDATED_LOG"; then
  log_error "Failed to save log entry"
  exit "$EXIT_FILE_ERROR"
fi

log_info "Logged: $ACTION ($LOG_ID)"
