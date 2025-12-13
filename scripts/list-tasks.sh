#!/usr/bin/env bash
# CLAUDE-TODO List Tasks Script
# Display tasks with flexible filtering and formatting
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_TODO_HOME="${CLAUDE_TODO_HOME:-$HOME/.claude-todo}"

# Capture start time for execution metrics (nanoseconds)
START_TIME_NS=$(date +%s%N 2>/dev/null || echo "0")

# Source version from central location
if [[ -f "$CLAUDE_TODO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLAUDE_TODO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="unknown"
fi

TODO_FILE="${TODO_FILE:-.claude/todo.json}"
ARCHIVE_FILE="${ARCHIVE_FILE:-.claude/todo-archive.json}"
CONFIG_FILE="${CONFIG_FILE:-.claude/todo-config.json}"

# Source logging library for should_use_color function
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/logging.sh" ]]; then
  # shellcheck source=../lib/logging.sh
  source "$LIB_DIR/logging.sh"
fi

# Source output-format library for Unicode detection
if [[ -f "$LIB_DIR/output-format.sh" ]]; then
  # shellcheck source=../lib/output-format.sh
  source "$LIB_DIR/output-format.sh"
fi

# Detect Unicode support (respects NO_COLOR, LANG=C, config)
if declare -f detect_unicode_support >/dev/null 2>&1 && detect_unicode_support; then
  UNICODE_ENABLED=true
else
  UNICODE_ENABLED=false
fi

# Colors (respects NO_COLOR and FORCE_COLOR environment variables per https://no-color.org)
if declare -f should_use_color >/dev/null 2>&1 && should_use_color; then
  COLORS_ENABLED=true
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  MAGENTA='\033[0;35m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  DIM='\033[2m'
  NC='\033[0m'
else
  COLORS_ENABLED=false
  RED='' GREEN='' YELLOW='' BLUE='' MAGENTA='' CYAN='' BOLD='' DIM='' NC=''
fi

# Defaults
STATUS_FILTER=""
PRIORITY_FILTER=""
PHASE_FILTER=""
LABEL_FILTER=""
FORMAT="text"
INCLUDE_ARCHIVE=false
LIMIT=""
SINCE_DATE=""
UNTIL_DATE=""
SORT_FIELD=""
SORT_REVERSE=false
SHOW_NOTES=false
SHOW_FILES=false
SHOW_ACCEPTANCE=false
VERBOSE=false
COMPACT=false
QUIET=false
GROUP_BY_PRIORITY=true

usage() {
  cat << EOF
Usage: $(basename "$0") [OPTIONS]

Display tasks from todo.json with flexible filtering and formatting.

Filters:
  -s, --status STATUS       Filter by status: pending|active|blocked|done
  -p, --priority PRIORITY   Filter by priority: critical|high|medium|low
      --phase PHASE         Filter by phase slug
  -l, --label LABEL         Filter by label
      --since DATE          Show tasks created after date (ISO 8601: YYYY-MM-DD)
      --until DATE          Show tasks created before date (ISO 8601: YYYY-MM-DD)
      --all                 Include archived tasks
      --limit N             Show first N tasks only

Sorting:
  --sort FIELD              Sort by field: status|priority|createdAt|title (default: priority)
  --reverse                 Reverse sort order

Display Options:
  -f, --format FORMAT       Output format: text|json|jsonl|markdown|table (default: text)
  -c, --compact             Compact one-line per task view
      --flat                Don't group by priority (flat list)
      --notes               Show task notes
      --files               Show associated files
      --acceptance          Show acceptance criteria
  -v, --verbose             Show all task details
  -q, --quiet               Suppress informational messages, only show task data
  -h, --help                Show this help

Examples:
  $(basename "$0")                          # List all active tasks
  $(basename "$0") -s pending               # Only pending tasks (short flag)
  $(basename "$0") --status pending         # Only pending tasks (long flag)
  $(basename "$0") -p critical              # Only critical priority
  $(basename "$0") --since 2025-12-01       # Tasks created after Dec 1
  $(basename "$0") --sort createdAt --reverse  # Newest first
  $(basename "$0") -f json                  # JSON output
  $(basename "$0") --all --limit 20         # Last 20 tasks including archive
  $(basename "$0") -v                       # Verbose mode with all details
  $(basename "$0") -s pending -p high -l backend  # Combined filters
  $(basename "$0") -q -f json               # Quiet mode with JSON output
EOF
  exit 0
}

log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# Check dependencies
check_deps() {
  if ! command -v jq &> /dev/null; then
    log_error "jq is required but not installed"
    exit 1
  fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -s|--status) STATUS_FILTER="$2"; shift 2 ;;
    -p|--priority) PRIORITY_FILTER="$2"; shift 2 ;;
    --phase) PHASE_FILTER="$2"; shift 2 ;;
    -l|--label) LABEL_FILTER="$2"; shift 2 ;;
    --since) SINCE_DATE="$2"; shift 2 ;;
    --until) UNTIL_DATE="$2"; shift 2 ;;
    --sort) SORT_FIELD="$2"; GROUP_BY_PRIORITY=false; shift 2 ;;
    --reverse) SORT_REVERSE=true; shift ;;
    -f|--format) FORMAT="$2"; shift 2 ;;
    --all) INCLUDE_ARCHIVE=true; shift ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --notes) SHOW_NOTES=true; shift ;;
    --files) SHOW_FILES=true; shift ;;
    --acceptance) SHOW_ACCEPTANCE=true; shift ;;
    -c|--compact) COMPACT=true; shift ;;
    --flat) GROUP_BY_PRIORITY=false; shift ;;
    -v|--verbose) VERBOSE=true; SHOW_NOTES=true; SHOW_FILES=true; SHOW_ACCEPTANCE=true; shift ;;
    -q|--quiet) QUIET=true; shift ;;
    -h|--help) usage ;;
    -*) log_error "Unknown option: $1"; exit 1 ;;
    *) shift ;;
  esac
done

check_deps

# Check if todo.json exists
if [[ ! -f "$TODO_FILE" ]]; then
  log_error "$TODO_FILE not found. Run init.sh first."
  exit 1
fi

# Load tasks from todo.json
TASKS=$(jq -c '.tasks[]' "$TODO_FILE" 2>/dev/null || echo "")

# Load archived tasks if requested
if [[ "$INCLUDE_ARCHIVE" == true ]] && [[ -f "$ARCHIVE_FILE" ]]; then
  ARCHIVED=$(jq -c '.archivedTasks[]' "$ARCHIVE_FILE" 2>/dev/null || echo "")
  TASKS=$(printf "%s\n%s" "$TASKS" "$ARCHIVED" | grep -v '^$' || echo "")
fi

# Handle empty task list
if [[ -z "$TASKS" ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    echo '{"tasks":[],"count":0,"filters":{}}'
  elif [[ "$QUIET" != true ]]; then
    echo "No tasks found."
  fi
  exit 0
fi

# Build jq filter based on arguments
JQ_FILTER='.'

if [[ -n "$STATUS_FILTER" ]]; then
  JQ_FILTER="$JQ_FILTER | select(.status == \"$STATUS_FILTER\")"
fi

if [[ -n "$PRIORITY_FILTER" ]]; then
  JQ_FILTER="$JQ_FILTER | select(.priority == \"$PRIORITY_FILTER\")"
fi

if [[ -n "$PHASE_FILTER" ]]; then
  JQ_FILTER="$JQ_FILTER | select(.phase == \"$PHASE_FILTER\")"
fi

if [[ -n "$LABEL_FILTER" ]]; then
  JQ_FILTER="$JQ_FILTER | select(.labels // [] | index(\"$LABEL_FILTER\"))"
fi

# Date-based filtering
if [[ -n "$SINCE_DATE" ]]; then
  JQ_FILTER="$JQ_FILTER | select(.createdAt >= \"$SINCE_DATE\")"
fi

if [[ -n "$UNTIL_DATE" ]]; then
  JQ_FILTER="$JQ_FILTER | select(.createdAt <= \"$UNTIL_DATE\")"
fi

# Build sort expression
SORT_EXPR=""
case "$SORT_FIELD" in
  status)
    SORT_EXPR='sort_by(if .status == "active" then 0 elif .status == "pending" then 1 elif .status == "blocked" then 2 else 3 end)'
    ;;
  priority)
    SORT_EXPR='sort_by(if .priority == "critical" then 0 elif .priority == "high" then 1 elif .priority == "medium" then 2 else 3 end)'
    ;;
  createdAt)
    SORT_EXPR='sort_by(.createdAt)'
    ;;
  title)
    SORT_EXPR='sort_by(.title | ascii_downcase)'
    ;;
  *)
    # Default: sort by priority then createdAt
    SORT_EXPR='sort_by((if .priority == "critical" then 0 elif .priority == "high" then 1 elif .priority == "medium" then 2 else 3 end), .createdAt)'
    ;;
esac

# Apply reverse if requested
if [[ "$SORT_REVERSE" == true ]]; then
  SORT_EXPR="$SORT_EXPR | reverse"
fi

# Apply filters and sort
FILTERED_TASKS=$(echo "$TASKS" | jq -s "map($JQ_FILTER) | $SORT_EXPR")

# Apply limit if specified
if [[ -n "$LIMIT" ]]; then
  FILTERED_TASKS=$(echo "$FILTERED_TASKS" | jq ".[:$LIMIT]")
fi

TASK_COUNT=$(echo "$FILTERED_TASKS" | jq 'length')

# Helper functions for status colors
status_color() {
  local status="$1"
  case "$status" in
    pending) echo -n "${YELLOW}" ;;
    active) echo -n "${GREEN}" ;;
    blocked) echo -n "${RED}" ;;
    done) echo -n "${DIM}" ;;
    *) echo -n "${NC}" ;;
  esac
}

priority_color() {
  local priority="$1"
  case "$priority" in
    critical) echo -n "${RED}${BOLD}" ;;
    high) echo -n "${YELLOW}" ;;
    medium) echo -n "${CYAN}" ;;
    low) echo -n "${DIM}" ;;
    *) echo -n "${NC}" ;;
  esac
}

status_icon() {
  local status="$1"
  if [[ "$UNICODE_ENABLED" == true ]]; then
    case "$status" in
      pending) echo "○" ;;
      active) echo "◉" ;;
      blocked) echo "⊗" ;;
      done) echo "✓" ;;
      *) echo "?" ;;
    esac
  else
    # ASCII fallback
    case "$status" in
      pending) echo "-" ;;
      active) echo "*" ;;
      blocked) echo "x" ;;
      done) echo "+" ;;
      *) echo "?" ;;
    esac
  fi
}

priority_icon() {
  local priority="$1"
  if [[ "$UNICODE_ENABLED" == true ]]; then
    case "$priority" in
      critical) echo "🔴" ;;
      high) echo "🟡" ;;
      medium) echo "🔵" ;;
      low) echo "⚪" ;;
      *) echo "?" ;;
    esac
  else
    # ASCII fallback
    case "$priority" in
      critical) echo "!" ;;
      high) echo "H" ;;
      medium) echo "M" ;;
      low) echo "L" ;;
      *) echo "?" ;;
    esac
  fi
}

# Function to render a single task (defined here for subshell access)
render_task() {
  local task="$1"
  local id=$(echo "$task" | jq -r '.id')
  local title=$(echo "$task" | jq -r '.title')
  local status=$(echo "$task" | jq -r '.status')
  local priority=$(echo "$task" | jq -r '.priority')
  local description=$(echo "$task" | jq -r '.description // ""')
  local blockedBy=$(echo "$task" | jq -r '.blockedBy // ""')
  local depends=$(echo "$task" | jq -r '.depends // [] | join(", ")')
  local labels=$(echo "$task" | jq -r '.labels // [] | join(", ")')
  local files=$(echo "$task" | jq -r '.files // [] | join(", ")')
  local acceptance=$(echo "$task" | jq -r '.acceptance // []')
  local notes=$(echo "$task" | jq -r '.notes // []')
  local createdAt=$(echo "$task" | jq -r '.createdAt')
  local completedAt=$(echo "$task" | jq -r '.completedAt // ""')

  local status_col=$(status_color "$status")
  local status_ic=$(status_icon "$status")

  if [[ "$COMPACT" == true ]]; then
    # Compact: one line per task
    local title_truncated="${title:0:50}"
    [[ ${#title} -gt 50 ]] && title_truncated="${title_truncated}…"
    printf "  ${DIM}%-5s${NC} ${status_col}%s${NC} %-52s" "$id" "$status_ic" "$title_truncated"
    [[ -n "$labels" ]] && printf " ${MAGENTA}#${NC}"
    echo ""
  else
    # Standard: multi-line with details
    echo -e "  ${BOLD}$id${NC} ${status_col}$status_ic $status${NC}"
    echo -e "      ${BOLD}$title${NC}"

    # Show labels inline if present
    if [[ -n "$labels" ]]; then
      echo -e "      ${MAGENTA}#${NC} ${DIM}$labels${NC}"
    fi

    # Show blockers/dependencies
    if [[ -n "$blockedBy" ]]; then
      echo -e "      ${RED}⊗ Blocked by:${NC} $blockedBy"
    fi
    if [[ -n "$depends" ]]; then
      echo -e "      ${CYAN}→ Depends:${NC} $depends"
    fi

    # Show description only in verbose mode
    if [[ "$VERBOSE" == true ]] && [[ -n "$description" ]]; then
      echo -e "      ${DIM}$description${NC}"
    fi

    # Show files if requested
    if [[ "$SHOW_FILES" == true ]] && [[ -n "$files" ]]; then
      echo -e "      ${CYAN}📁${NC} $files"
    fi

    # Show acceptance criteria if requested
    if [[ "$SHOW_ACCEPTANCE" == true ]]; then
      local acceptance_count=$(echo "$acceptance" | jq 'length')
      if [[ "$acceptance_count" -gt 0 ]]; then
        echo -e "      ${GREEN}✓ Acceptance:${NC}"
        local acc_items
        acc_items=$(echo "$acceptance" | jq -r '.[]')
        while IFS= read -r criterion; do
          echo "        • $criterion"
        done <<< "$acc_items"
      fi
    fi

    # Show notes if requested
    if [[ "$SHOW_NOTES" == true ]]; then
      local notes_count=$(echo "$notes" | jq 'length')
      if [[ "$notes_count" -gt 0 ]]; then
        echo -e "      ${BLUE}📝 Notes:${NC}"
        local note_items
        note_items=$(echo "$notes" | jq -r '.[]')
        while IFS= read -r note; do
          echo "        • $note"
        done <<< "$note_items"
      fi
    fi

    # Show timestamps in verbose mode
    if [[ "$VERBOSE" == true ]]; then
      echo -e "      ${DIM}Created: $createdAt${NC}"
      [[ -n "$completedAt" ]] && echo -e "      ${DIM}Completed: $completedAt${NC}"
    fi
  fi
}
# Export functions and variables for subshell access
export -f render_task status_color status_icon
export COMPACT VERBOSE SHOW_FILES SHOW_ACCEPTANCE SHOW_NOTES
export RED GREEN YELLOW BLUE MAGENTA CYAN BOLD DIM NC

# Calculate execution time and generate metadata
END_TIME_NS=$(date +%s%N 2>/dev/null || echo "$START_TIME_NS")
if [[ "$START_TIME_NS" != "0" ]] && [[ "$END_TIME_NS" != "0" ]]; then
  EXECUTION_MS=$(( (END_TIME_NS - START_TIME_NS) / 1000000 ))
else
  EXECUTION_MS=0
fi

# Generate checksum for data integrity
TASKS_CHECKSUM=$(echo "$FILTERED_TASKS" | sha256sum 2>/dev/null | cut -c1-16 || echo "unavailable")

# Current timestamp in ISO 8601 format
CURRENT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Calculate summary counts
TOTAL_TASKS=$(jq -c '.tasks[]' "$TODO_FILE" 2>/dev/null | wc -l || echo "0")
PENDING_COUNT=$(echo "$FILTERED_TASKS" | jq '[.[] | select(.status == "pending")] | length')
ACTIVE_COUNT=$(echo "$FILTERED_TASKS" | jq '[.[] | select(.status == "active")] | length')
BLOCKED_COUNT=$(echo "$FILTERED_TASKS" | jq '[.[] | select(.status == "blocked")] | length')
DONE_COUNT=$(echo "$FILTERED_TASKS" | jq '[.[] | select(.status == "done")] | length')

# Format output based on selected format
case "$FORMAT" in
  json)
    # JSON format with metadata envelope
    jq -n --argjson tasks "$FILTERED_TASKS" \
      --arg version "$VERSION" \
      --arg timestamp "$CURRENT_TIMESTAMP" \
      --arg checksum "$TASKS_CHECKSUM" \
      --argjson execution_ms "$EXECUTION_MS" \
      --arg status "$STATUS_FILTER" \
      --arg priority "$PRIORITY_FILTER" \
      --arg phase "$PHASE_FILTER" \
      --arg label "$LABEL_FILTER" \
      --argjson total "$TOTAL_TASKS" \
      --argjson filtered "$TASK_COUNT" \
      --argjson pending "$PENDING_COUNT" \
      --argjson active "$ACTIVE_COUNT" \
      --argjson blocked "$BLOCKED_COUNT" \
      --argjson done "$DONE_COUNT" '{
      "$schema": "https://claude-todo.dev/schemas/output-v2.json",
      "_meta": {
        version: $version,
        command: "list",
        timestamp: $timestamp,
        checksum: $checksum,
        execution_ms: $execution_ms
      },
      filters: {
        status: (if $status != "" then [$status] else null end),
        priority: (if $priority != "" then $priority else null end),
        phase: (if $phase != "" then $phase else null end),
        label: (if $label != "" then $label else null end)
      },
      summary: {
        total: $total,
        filtered: $filtered,
        pending: $pending,
        active: $active,
        blocked: $blocked,
        done: $done
      },
      tasks: $tasks
    }'
    ;;

  jsonl)
    # JSONL format - one JSON object per line (compact)
    # Line 1: Metadata
    jq -nc --arg version "$VERSION" \
      --arg timestamp "$CURRENT_TIMESTAMP" \
      --arg checksum "$TASKS_CHECKSUM" \
      --argjson execution_ms "$EXECUTION_MS" \
      '{_type: "meta", version: $version, command: "list", timestamp: $timestamp, checksum: $checksum, execution_ms: $execution_ms}'

    # Lines 2-N: Tasks (one per line)
    echo "$FILTERED_TASKS" | jq -c '.[] | {_type: "task"} + .'

    # Last line: Summary
    jq -nc --argjson total "$TOTAL_TASKS" \
      --argjson filtered "$TASK_COUNT" \
      --argjson pending "$PENDING_COUNT" \
      --argjson active "$ACTIVE_COUNT" \
      --argjson blocked "$BLOCKED_COUNT" \
      --argjson done "$DONE_COUNT" \
      '{_type: "summary", total: $total, filtered: $filtered, pending: $pending, active: $active, blocked: $blocked, done: $done}'
    ;;

  markdown)
    # Markdown format
    echo "# Tasks"
    echo ""
    if [[ -n "$STATUS_FILTER" ]] || [[ -n "$PRIORITY_FILTER" ]] || [[ -n "$PHASE_FILTER" ]] || [[ -n "$LABEL_FILTER" ]]; then
      echo "**Filters:**"
      [[ -n "$STATUS_FILTER" ]] && echo "- Status: $STATUS_FILTER"
      [[ -n "$PRIORITY_FILTER" ]] && echo "- Priority: $PRIORITY_FILTER"
      [[ -n "$PHASE_FILTER" ]] && echo "- Phase: $PHASE_FILTER"
      [[ -n "$LABEL_FILTER" ]] && echo "- Label: $LABEL_FILTER"
      echo ""
    fi
    echo "**Total:** $TASK_COUNT tasks"
    echo ""

    if [[ "$TASK_COUNT" -gt 0 ]]; then
      echo "$FILTERED_TASKS" | jq -r '.[] | "## \(.id): \(.title)\n\n- **Status:** \(.status)\n- **Priority:** \(.priority)\n- **Phase:** \(.phase // "none")\n- **Created:** \(.createdAt)\n" + (if .description then "- **Description:** \(.description)\n" else "" end) + (if .blockedBy then "- **Blocked:** \(.blockedBy)\n" else "" end) + (if .depends and (.depends | length > 0) then "- **Depends on:** \(.depends | join(", "))\n" else "" end) + (if .labels and (.labels | length > 0) then "- **Labels:** \(.labels | join(", "))\n" else "" end) + "\n"'
    fi
    ;;

  table)
    # ASCII table format
    printf "╔════════╦══════════════════════════════════════════════╦══════════╦══════════╦════════════╗\n"
    printf "║ %-6s ║ %-44s ║ %-8s ║ %-8s ║ %-10s ║\n" "ID" "Title" "Status" "Priority" "Phase"
    printf "╠════════╬══════════════════════════════════════════════╬══════════╬══════════╬════════════╣\n"

    if [[ "$TASK_COUNT" -gt 0 ]]; then
      echo "$FILTERED_TASKS" | jq -r '.[] | [.id, .title[0:44], .status, .priority, (.phase // "-")] | @tsv' | while IFS=$'\t' read -r id title status priority phase; do
        printf "║ %-6s ║ %-44s ║ %-8s ║ %-8s ║ %-10s ║\n" "$id" "$title" "$status" "$priority" "$phase"
      done
    fi

    printf "╚════════╩══════════════════════════════════════════════╩══════════╩══════════╩════════════╝\n"
    printf "Total: %d tasks\n" "$TASK_COUNT"
    ;;

  text|*)
    # Human-readable text format (default)
    if [[ "$TASK_COUNT" -eq 0 ]]; then
      [[ "$QUIET" != true ]] && echo "No tasks match the specified filters."
      exit 0
    fi

    # Count by status (used in header and summary)
    pending_count=$(echo "$FILTERED_TASKS" | jq '[.[] | select(.status == "pending")] | length')
    active_count=$(echo "$FILTERED_TASKS" | jq '[.[] | select(.status == "active")] | length')
    blocked_count=$(echo "$FILTERED_TASKS" | jq '[.[] | select(.status == "blocked")] | length')
    done_count=$(echo "$FILTERED_TASKS" | jq '[.[] | select(.status == "done")] | length')

    # Count by priority
    critical_count=$(echo "$FILTERED_TASKS" | jq '[.[] | select(.priority == "critical")] | length')
    high_count=$(echo "$FILTERED_TASKS" | jq '[.[] | select(.priority == "high")] | length')
    medium_count=$(echo "$FILTERED_TASKS" | jq '[.[] | select(.priority == "medium")] | length')
    low_count=$(echo "$FILTERED_TASKS" | jq '[.[] | select(.priority == "low")] | length')

    # Header
    # Header (suppress in quiet mode)
    if [[ "$QUIET" != true ]]; then
    echo ""
    if [[ "$UNICODE_ENABLED" == true ]]; then
      echo -e "${BOLD}╭─────────────────────────────────────────────────────────────────╮${NC}"
      echo -e "${BOLD}│${NC}  📋 ${BOLD}TASKS${NC}                                                       ${BOLD}│${NC}"
      echo -e "${BOLD}├─────────────────────────────────────────────────────────────────┤${NC}"
      echo -e "${BOLD}│${NC}  ${RED}🔴 ${critical_count} critical${NC}  ${YELLOW}🟡 ${high_count} high${NC}  ${CYAN}🔵 ${medium_count} medium${NC}  ${DIM}⚪ ${low_count} low${NC}          ${BOLD}│${NC}"
      echo -e "${BOLD}│${NC}  ${YELLOW}○ ${pending_count} pending${NC}  ${GREEN}◉ ${active_count} active${NC}  ${RED}⊗ ${blocked_count} blocked${NC}  ${DIM}✓ ${done_count} done${NC}          ${BOLD}│${NC}"
      echo -e "${BOLD}╰─────────────────────────────────────────────────────────────────╯${NC}"
    else
      # ASCII fallback
      echo -e "${BOLD}+-------------------------------------------------------------------+${NC}"
      echo -e "${BOLD}|${NC}  ${BOLD}TASKS${NC}                                                           ${BOLD}|${NC}"
      echo -e "${BOLD}+-------------------------------------------------------------------+${NC}"
      echo -e "${BOLD}|${NC}  ${RED}! ${critical_count} critical${NC}  ${YELLOW}H ${high_count} high${NC}  ${CYAN}M ${medium_count} medium${NC}  ${DIM}L ${low_count} low${NC}            ${BOLD}|${NC}"
      echo -e "${BOLD}|${NC}  ${YELLOW}- ${pending_count} pending${NC}  ${GREEN}* ${active_count} active${NC}  ${RED}x ${blocked_count} blocked${NC}  ${DIM}+ ${done_count} done${NC}            ${BOLD}|${NC}"
      echo -e "${BOLD}+-------------------------------------------------------------------+${NC}"
    fi

      # Show filters if any
      if [[ -n "$STATUS_FILTER" ]] || [[ -n "$PRIORITY_FILTER" ]] || [[ -n "$PHASE_FILTER" ]] || [[ -n "$LABEL_FILTER" ]]; then
        echo -e "${DIM}Filters: ${NC}"
        [[ -n "$STATUS_FILTER" ]] && echo -n -e "${DIM}status=${NC}$STATUS_FILTER "
        [[ -n "$PRIORITY_FILTER" ]] && echo -n -e "${DIM}priority=${NC}$PRIORITY_FILTER "
        [[ -n "$PHASE_FILTER" ]] && echo -n -e "${DIM}phase=${NC}$PHASE_FILTER "
        [[ -n "$LABEL_FILTER" ]] && echo -n -e "${DIM}label=${NC}$LABEL_FILTER "
        echo ""
      fi
    fi

    # Render tasks grouped by priority or flat
    if [[ "$GROUP_BY_PRIORITY" == true ]]; then
      # Group by priority with section headers
      for priority_level in critical high medium low; do
        case "$priority_level" in
          critical)
            priority_tasks=$(echo "$FILTERED_TASKS" | jq -c '[.[] | select(.priority == "critical")]')
            count=$critical_count
            if [[ "$UNICODE_ENABLED" == true ]]; then
              header="${RED}${BOLD}🔴 CRITICAL${NC}"
            else
              header="${RED}${BOLD}! CRITICAL${NC}"
            fi
            ;;
          high)
            priority_tasks=$(echo "$FILTERED_TASKS" | jq -c '[.[] | select(.priority == "high")]')
            count=$high_count
            if [[ "$UNICODE_ENABLED" == true ]]; then
              header="${YELLOW}${BOLD}🟡 HIGH${NC}"
            else
              header="${YELLOW}${BOLD}H HIGH${NC}"
            fi
            ;;
          medium)
            priority_tasks=$(echo "$FILTERED_TASKS" | jq -c '[.[] | select(.priority == "medium")]')
            count=$medium_count
            if [[ "$UNICODE_ENABLED" == true ]]; then
              header="${CYAN}${BOLD}🔵 MEDIUM${NC}"
            else
              header="${CYAN}${BOLD}M MEDIUM${NC}"
            fi
            ;;
          low)
            priority_tasks=$(echo "$FILTERED_TASKS" | jq -c '[.[] | select(.priority == "low")]')
            count=$low_count
            if [[ "$UNICODE_ENABLED" == true ]]; then
              header="${DIM}${BOLD}⚪ LOW${NC}"
            else
              header="${DIM}${BOLD}L LOW${NC}"
            fi
            ;;
        esac

        if [[ "$count" -gt 0 ]]; then
          # Suppress section headers in quiet mode
          if [[ "$QUIET" != true ]]; then
            echo ""
            echo -e "$header ${DIM}($count)${NC}"
            if [[ "$UNICODE_ENABLED" == true ]]; then
              echo -e "${DIM}─────────────────────────────────────────────────────────────────${NC}"
            else
              echo -e "${DIM}---------------------------------------------------------------------${NC}"
            fi
          fi

          # Use readarray to avoid subshell issues
          readarray -t tasks_arr < <(echo "$priority_tasks" | jq -c '.[]')
          for task in "${tasks_arr[@]}"; do
            render_task "$task" || true
          done
        fi
      done
    else
      # Flat list (no grouping)
      echo ""
      readarray -t tasks_arr < <(echo "$FILTERED_TASKS" | jq -c '.[]')
      for task in "${tasks_arr[@]}"; do
        render_task "$task" || true
      done
    fi

    # Footer (suppress in quiet mode)
    if [[ "$QUIET" != true ]]; then
      echo ""
      if [[ "$UNICODE_ENABLED" == true ]]; then
        echo -e "${DIM}─────────────────────────────────────────────────────────────────${NC}"
      else
        echo -e "${DIM}---------------------------------------------------------------------${NC}"
      fi
      echo -e "${DIM}Total: $TASK_COUNT tasks${NC}"
    fi
    ;;
esac
