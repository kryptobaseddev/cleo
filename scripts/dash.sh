#!/usr/bin/env bash

#####################################################################
# dash.sh - Dashboard/Overview Command for Claude Todo System
#
# Generates a comprehensive dashboard view showing:
# - Project status overview
# - Current phase (if set in project.currentPhase)
# - Current focus task
# - Task counts by status and priority
# - Phase progress with visual bars (highlights current phase)
# - Blocked tasks
# - Top labels
# - Recent activity metrics
#
# Usage:
#   dash.sh [OPTIONS]
#
# Options:
#   --compact         Condensed single-line view
#   --period DAYS     Stats period in days (default: 7)
#   --no-chart        Disable ASCII charts/progress bars
#   --sections LIST   Comma-separated list of sections to show
#   --format FORMAT   Output format: text | json (default: text)
#   -h, --help        Show this help message
#
# Sections:
#   focus        - Current focus task and session note
#   summary      - Task counts by status
#   priority     - High/critical priority tasks
#   blocked      - Blocked tasks
#   phases       - Phase progress bars (with current phase highlighted)
#   labels       - Top labels with counts
#   activity     - Recent activity metrics
#   archive      - Archived task count and date range
#   completions  - Recent completion history
#   all          - All sections (default)
#
# Examples:
#   dash.sh                              # Full dashboard
#   dash.sh --compact                    # Single-line summary
#   dash.sh --period 14                  # 14-day activity metrics
#   dash.sh --sections focus,blocked     # Only focus and blocked sections
#   dash.sh --format json                # JSON output for scripting
#
# Version: 0.8.3
# Part of: claude-todo CLI Output Enhancement (Phase 2)
# Enhanced: Added current phase display (T254)
#####################################################################

set -euo pipefail

# Script and library paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
CLAUDE_TODO_HOME="${CLAUDE_TODO_HOME:-$HOME/.claude-todo}"

# Source version from central location
if [[ -f "$CLAUDE_TODO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLAUDE_TODO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="unknown"
fi

# Source library functions
if [[ -f "${LIB_DIR}/file-ops.sh" ]]; then
  source "${LIB_DIR}/file-ops.sh"
elif [[ -f "$CLAUDE_TODO_HOME/lib/file-ops.sh" ]]; then
  source "$CLAUDE_TODO_HOME/lib/file-ops.sh"
fi

if [[ -f "${LIB_DIR}/logging.sh" ]]; then
  source "${LIB_DIR}/logging.sh"
elif [[ -f "$CLAUDE_TODO_HOME/lib/logging.sh" ]]; then
  source "$CLAUDE_TODO_HOME/lib/logging.sh"
fi

if [[ -f "${LIB_DIR}/output-format.sh" ]]; then
  source "${LIB_DIR}/output-format.sh"
elif [[ -f "$CLAUDE_TODO_HOME/lib/output-format.sh" ]]; then
  source "$CLAUDE_TODO_HOME/lib/output-format.sh"
fi

# Default configuration
PERIOD_DAYS=7
OUTPUT_FORMAT="text"
COMPACT_MODE=false
SHOW_CHARTS=true
SECTIONS="all"

# File paths
CLAUDE_DIR=".claude"
TODO_FILE="${CLAUDE_DIR}/todo.json"
ARCHIVE_FILE="${CLAUDE_DIR}/todo-archive.json"
# LOG_FILE is set by logging.sh - use fallback if not set
DASH_LOG_FILE="${LOG_FILE:-.claude/todo-log.json}"

#####################################################################
# Usage
#####################################################################

usage() {
  cat << 'EOF'
Usage: claude-todo dash [OPTIONS]

Generate a comprehensive dashboard view of your todo system.

Options:
    -c, --compact     Condensed single-line view
    --period DAYS     Stats period in days (default: 7)
    --no-chart        Disable ASCII charts/progress bars
    --sections LIST   Comma-separated: focus,summary,priority,blocked,phases,labels,activity,all
    -f, --format FORMAT   Output format: text | json (default: text)
    -h, --help        Show this help message

Examples:
    claude-todo dash                              # Full dashboard
    claude-todo dash --compact                    # Single-line summary
    claude-todo dash --period 14                  # 14-day activity metrics
    claude-todo dash --sections focus,blocked     # Only focus and blocked sections
    claude-todo dash --format json                # JSON output

Sections:
    focus        - Current focus task and session note
    summary      - Task counts by status
    priority     - High/critical priority tasks
    blocked      - Blocked tasks with blocking reason
    phases       - Phase progress bars (highlights current phase)
    labels       - Top labels with counts
    activity     - Recent activity metrics (created/completed)
    archive      - Archived task count and date range
    completions  - Recent completion history
    all          - All sections (default)

Dashboard Features:
    - Displays current phase in header (if project.currentPhase is set)
    - Highlights current phase with ★ symbol in phases section
    - Shows phase name in compact mode
    - Gracefully handles both legacy (string) and new (object) project format
EOF
  exit 0
}

#####################################################################
# Helper Functions
#####################################################################

# Get current timestamp in ISO format
get_timestamp() {
  date -Iseconds
}

# Get timestamp N days ago
timestamp_days_ago() {
  local days="$1"
  date -d "${days} days ago" -Iseconds
}

# Check if a section should be shown
should_show_section() {
  local section="$1"
  [[ "$SECTIONS" == "all" ]] && return 0
  [[ ",$SECTIONS," == *",$section,"* ]] && return 0
  return 1
}

# Get ANSI color codes (respects NO_COLOR)
get_colors() {
  if detect_color_support 2>/dev/null; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    DIM='\033[2m'
    NC='\033[0m'
  else
    RED='' GREEN='' YELLOW='' BLUE='' CYAN='' BOLD='' DIM='' NC=''
  fi
}

#####################################################################
# Data Collection Functions
#####################################################################

# Count tasks by status
count_by_status() {
  local status="$1"
  jq -r --arg status "$status" '[.tasks[] | select(.status == $status)] | length' "$TODO_FILE" 2>/dev/null || echo "0"
}

# Count tasks by priority
count_by_priority() {
  local priority="$1"
  jq -r --arg priority "$priority" '[.tasks[] | select(.priority == $priority)] | length' "$TODO_FILE" 2>/dev/null || echo "0"
}

# Get high priority pending tasks (not done, not blocked)
get_high_priority_tasks() {
  jq -r '[.tasks[] | select((.priority == "critical" or .priority == "high") and .status != "done")] | sort_by(if .priority == "critical" then 0 else 1 end) | .[0:5]' "$TODO_FILE" 2>/dev/null || echo "[]"
}

# Get blocked tasks
get_blocked_tasks() {
  jq -r '[.tasks[] | select(.status == "blocked")]' "$TODO_FILE" 2>/dev/null || echo "[]"
}

# Get focus information
get_focus_info() {
  jq -r '.focus // {}' "$TODO_FILE" 2>/dev/null || echo "{}"
}

# Get current focus task details
get_focus_task() {
  local task_id
  task_id=$(jq -r '.focus.currentTask // ""' "$TODO_FILE" 2>/dev/null)
  if [[ -n "$task_id" && "$task_id" != "null" ]]; then
    jq -r --arg id "$task_id" '.tasks[] | select(.id == $id)' "$TODO_FILE" 2>/dev/null || echo "{}"
  else
    echo "{}"
  fi
}

# Get phase statistics
get_phase_stats() {
  jq -r '
    .phases as $phases |
    if $phases then
      [.tasks | group_by(.phase) | .[] |
        select(.[0].phase != null) |
        {
          slug: .[0].phase,
          name: ($phases[.[0].phase].name // .[0].phase),
          order: ($phases[.[0].phase].order // 999),
          total: length,
          done: [.[] | select(.status == "done")] | length,
          active: [.[] | select(.status == "active")] | length,
          pending: [.[] | select(.status == "pending")] | length,
          blocked: [.[] | select(.status == "blocked")] | length
        }
      ] | sort_by(.order)
    else
      []
    end
  ' "$TODO_FILE" 2>/dev/null || echo "[]"
}

# Get top labels with counts
get_top_labels() {
  jq -r '
    [.tasks[].labels // [] | .[]] |
    group_by(.) |
    map({label: .[0], count: length}) |
    sort_by(-.count) |
    .[0:8]
  ' "$TODO_FILE" 2>/dev/null || echo "[]"
}

# Get archived task count
get_archived_count() {
  if [[ ! -f "$ARCHIVE_FILE" ]]; then
    echo "0"
    return
  fi
  jq -r '._meta.totalArchived // 0' "$ARCHIVE_FILE" 2>/dev/null || echo "0"
}

# Get archive date range
get_archive_date_range() {
  if [[ ! -f "$ARCHIVE_FILE" ]]; then
    echo '{"oldest": null, "newest": null}'
    return
  fi

  jq -r '{
    oldest: (._meta.oldestTask // null),
    newest: (._meta.newestTask // null)
  }' "$ARCHIVE_FILE" 2>/dev/null || echo '{"oldest": null, "newest": null}'
}

# Get completion counts by time period
get_completion_counts() {
  if [[ ! -f "$DASH_LOG_FILE" ]]; then
    echo '{"today": 0, "thisWeek": 0, "thisMonth": 0}'
    return
  fi

  local now today_start week_start month_start
  now=$(date -Iseconds)
  today_start=$(date -d "today 00:00:00" -Iseconds 2>/dev/null || date -Iseconds)
  week_start=$(date -d "7 days ago" -Iseconds 2>/dev/null || date -Iseconds)
  month_start=$(date -d "30 days ago" -Iseconds 2>/dev/null || date -Iseconds)

  local today_count week_count month_count
  today_count=$(jq -r --arg start "$today_start" \
    '[.entries[] | select(.action == "status_changed" and .after.status == "done" and .timestamp >= $start)] | length' \
    "$DASH_LOG_FILE" 2>/dev/null || echo "0")

  week_count=$(jq -r --arg start "$week_start" \
    '[.entries[] | select(.action == "status_changed" and .after.status == "done" and .timestamp >= $start)] | length' \
    "$DASH_LOG_FILE" 2>/dev/null || echo "0")

  month_count=$(jq -r --arg start "$month_start" \
    '[.entries[] | select(.action == "status_changed" and .after.status == "done" and .timestamp >= $start)] | length' \
    "$DASH_LOG_FILE" 2>/dev/null || echo "0")

  jq -n --argjson today "$today_count" --argjson week "$week_count" --argjson month "$month_count" \
    '{today: $today, thisWeek: $week, thisMonth: $month}'
}

# Get recent completions with task details
get_recent_completions() {
  local limit="${1:-5}"

  if [[ ! -f "$DASH_LOG_FILE" ]]; then
    echo '[]'
    return
  fi

  # Get completion events from log
  local completions
  completions=$(jq -r --argjson limit "$limit" '
    [.entries[] | select(.action == "status_changed" and .after.status == "done")] |
    sort_by(.timestamp) | reverse | .[0:$limit] |
    map({taskId: .taskId, timestamp: .timestamp})
  ' "$DASH_LOG_FILE" 2>/dev/null || echo "[]")

  # Enrich with task titles from archive or current tasks
  local enriched="[]"
  if [[ -f "$ARCHIVE_FILE" ]]; then
    enriched=$(jq -n --argjson completions "$completions" --slurpfile archive "$ARCHIVE_FILE" --slurpfile todo "$TODO_FILE" '
      $completions | map(
        . as $comp |
        (($archive[0].archivedTasks // [] | map(select(.id == $comp.taskId)) | .[0]) //
         ($todo[0].tasks // [] | map(select(.id == $comp.taskId)) | .[0])) as $task |
        if $task then
          {
            id: $comp.taskId,
            title: $task.title,
            timestamp: $comp.timestamp,
            date: ($comp.timestamp | split("T")[0])
          }
        else
          {
            id: $comp.taskId,
            title: "Unknown",
            timestamp: $comp.timestamp,
            date: ($comp.timestamp | split("T")[0])
          }
        end
      )
    ')
  fi

  echo "$enriched"
}

# Get recent activity metrics
get_activity_metrics() {
  local cutoff_date="$1"

  if [[ ! -f "$DASH_LOG_FILE" ]]; then
    echo '{"created": 0, "completed": 0, "rate": 0}'
    return
  fi

  local created completed
  created=$(jq -r --arg cutoff "$cutoff_date" \
    '[.entries[] | select(.operation == "create" and .timestamp >= $cutoff)] | length' \
    "$DASH_LOG_FILE" 2>/dev/null || echo "0")
  completed=$(jq -r --arg cutoff "$cutoff_date" \
    '[.entries[] | select(.operation == "complete" and .timestamp >= $cutoff)] | length' \
    "$DASH_LOG_FILE" 2>/dev/null || echo "0")

  local rate=0
  if [[ "$created" -gt 0 ]]; then
    rate=$(echo "scale=0; $completed * 100 / $created" | bc 2>/dev/null || echo "0")
  fi

  jq -n --argjson created "$created" --argjson completed "$completed" --argjson rate "$rate" \
    '{created: $created, completed: $completed, rate: $rate}'
}

# Get project name
get_project_name() {
  local project
  project=$(jq -r '.project' "$TODO_FILE" 2>/dev/null || echo "null")

  # Handle legacy string format vs new object format
  if [[ "$project" == "null" ]]; then
    echo "Unknown Project"
  elif echo "$project" | jq -e 'type == "object"' &>/dev/null; then
    # New format: extract .name
    echo "$project" | jq -r '.name // "Unknown Project"'
  else
    # Legacy format: project is a string
    echo "$project"
  fi
}

# Get current phase information
get_current_phase() {
  local project
  project=$(jq -r '.project' "$TODO_FILE" 2>/dev/null || echo "null")

  # Only works with new object format
  if echo "$project" | jq -e 'type == "object"' &>/dev/null; then
    local current_phase_slug
    current_phase_slug=$(echo "$project" | jq -r '.currentPhase // empty')

    if [[ -n "$current_phase_slug" && "$current_phase_slug" != "null" ]]; then
      local phase_name
      phase_name=$(jq -r --arg slug "$current_phase_slug" '.phases[$slug].name // $slug' "$TODO_FILE" 2>/dev/null)

      # Return JSON object with slug and name
      jq -n --arg slug "$current_phase_slug" --arg name "$phase_name" \
        '{slug: $slug, name: $name}'
      return
    fi
  fi

  # No current phase set
  echo '{"slug": null, "name": null}'
}

# Get session status
get_session_status() {
  local session_id
  session_id=$(jq -r '._meta.activeSession // ""' "$TODO_FILE" 2>/dev/null)
  if [[ -n "$session_id" && "$session_id" != "null" ]]; then
    echo "$session_id"
  else
    echo ""
  fi
}

#####################################################################
# Output Formatters - Text
#####################################################################

# Print box top border
print_box_top() {
  local width="${1:-65}"
  local unicode
  detect_unicode_support 2>/dev/null && unicode="true" || unicode="false"

  local TL=$(draw_box TL "$unicode")
  local TR=$(draw_box TR "$unicode")
  local H=$(draw_box H "$unicode")

  printf "%s" "$TL"
  for ((i=0; i<width-2; i++)); do printf "%s" "$H"; done
  printf "%s\n" "$TR"
}

# Print box bottom border
print_box_bottom() {
  local width="${1:-65}"
  local unicode
  detect_unicode_support 2>/dev/null && unicode="true" || unicode="false"

  local BL=$(draw_box BL "$unicode")
  local BR=$(draw_box BR "$unicode")
  local H=$(draw_box H "$unicode")

  printf "%s" "$BL"
  for ((i=0; i<width-2; i++)); do printf "%s" "$H"; done
  printf "%s\n" "$BR"
}

# Print box separator
print_box_separator() {
  local width="${1:-65}"
  local unicode
  detect_unicode_support 2>/dev/null && unicode="true" || unicode="false"

  local H=$(draw_box H "$unicode")
  local V=$(draw_box V "$unicode")

  # Use simple corners for separator
  printf "%s" "$V"
  for ((i=0; i<width-2; i++)); do printf "%s" "$H"; done
  printf "%s\n" "$V"
}

# Print padded content line
print_box_line() {
  local content="$1"
  local width="${2:-65}"
  local unicode
  detect_unicode_support 2>/dev/null && unicode="true" || unicode="false"

  local V=$(draw_box V "$unicode")

  # Calculate visible length (strip ANSI codes for length calculation)
  local visible_content
  visible_content=$(echo -e "$content" | sed 's/\x1b\[[0-9;]*m//g')
  local visible_len=${#visible_content}
  local padding=$((width - 4 - visible_len))
  [[ $padding -lt 0 ]] && padding=0

  printf "%s  %b%*s%s\n" "$V" "$content" "$padding" "" "$V"
}

# Output compact text format (single line)
output_compact() {
  local pending=$(count_by_status "pending")
  local active=$(count_by_status "active")
  local blocked=$(count_by_status "blocked")
  local done=$(count_by_status "done")
  local total=$((pending + active + blocked + done))

  local archived_count
  archived_count=$(get_archived_count)

  local completion_counts
  completion_counts=$(get_completion_counts)
  local today_completed
  today_completed=$(echo "$completion_counts" | jq -r '.today')

  local focus_id
  focus_id=$(jq -r '.focus.currentTask // ""' "$TODO_FILE" 2>/dev/null)

  local high_count
  high_count=$(jq -r '[.tasks[] | select((.priority == "critical" or .priority == "high") and .status != "done")] | length' "$TODO_FILE" 2>/dev/null || echo "0")

  local blocked_count
  blocked_count=$(count_by_status "blocked")

  local project
  project=$(get_project_name)

  local current_phase_info
  current_phase_info=$(get_current_phase)
  local current_phase_name
  current_phase_name=$(echo "$current_phase_info" | jq -r '.name // ""')

  local unicode
  detect_unicode_support 2>/dev/null && unicode="true" || unicode="false"

  local sym_pending=$(status_symbol "pending" "$unicode")
  local sym_active=$(status_symbol "active" "$unicode")
  local sym_blocked=$(status_symbol "blocked" "$unicode")
  local sym_done=$(status_symbol "done" "$unicode")

  # Calculate completion percentage
  local done_pct=0
  if [[ $total -gt 0 ]]; then
    done_pct=$(echo "scale=0; $done * 100 / $total" | bc 2>/dev/null || echo "0")
  fi

  if detect_color_support 2>/dev/null; then
    printf "${BOLD}%s${NC}" "$project"

    # Add current phase if set
    if [[ -n "$current_phase_name" && "$current_phase_name" != "null" ]]; then
      printf " | ${BLUE}Phase: %s${NC}" "$current_phase_name"
    fi

    printf " | ${CYAN}%s${NC}%d ${GREEN}%s${NC}%d (%d%%) | ${DIM}Archived: %d${NC} | ${GREEN}Today: %d completed${NC}" \
      "$sym_active" "$active" "$sym_done" "$done" "$done_pct" "$archived_count" "$today_completed"

    if [[ -n "$focus_id" && "$focus_id" != "null" ]]; then
      printf " | Focus: ${CYAN}%s${NC}" "$focus_id"
    fi

    if [[ "$high_count" -gt 0 ]]; then
      printf " | ${YELLOW}High: %d${NC}" "$high_count"
    fi

    if [[ "$blocked_count" -gt 0 ]]; then
      printf " | ${RED}Blocked: %d${NC}" "$blocked_count"
    fi
  else
    printf "%s" "$project"

    # Add current phase if set
    if [[ -n "$current_phase_name" && "$current_phase_name" != "null" ]]; then
      printf " | Phase: %s" "$current_phase_name"
    fi

    printf " | %s%d %s%d (%d%%) | Archived: %d | Today: %d completed" \
      "$sym_active" "$active" "$sym_done" "$done" "$done_pct" "$archived_count" "$today_completed"

    if [[ -n "$focus_id" && "$focus_id" != "null" ]]; then
      printf " | Focus: %s" "$focus_id"
    fi

    if [[ "$high_count" -gt 0 ]]; then
      printf " | High: %d" "$high_count"
    fi

    if [[ "$blocked_count" -gt 0 ]]; then
      printf " | Blocked: %d" "$blocked_count"
    fi
  fi

  printf "\n"
}

# Output full text format
output_text_format() {
  local width=65
  local unicode
  detect_unicode_support 2>/dev/null && unicode="true" || unicode="false"

  get_colors

  local project
  project=$(get_project_name)
  local timestamp
  timestamp=$(date "+%Y-%m-%d %H:%M:%S")

  local current_phase_info
  current_phase_info=$(get_current_phase)
  local current_phase_name
  current_phase_name=$(echo "$current_phase_info" | jq -r '.name // ""')
  local current_phase_slug
  current_phase_slug=$(echo "$current_phase_info" | jq -r '.slug // ""')

  # Header
  print_box_top "$width"
  print_box_line "${BOLD}  PROJECT DASHBOARD${NC}" "$width"
  print_box_line "  ${DIM}$project${NC}" "$width"

  # Add current phase if set
  if [[ -n "$current_phase_name" && "$current_phase_name" != "null" ]]; then
    print_box_line "  ${BLUE}Current Phase: $current_phase_name${NC} ${DIM}($current_phase_slug)${NC}" "$width"
  fi

  print_box_line "  ${DIM}Last updated: $timestamp${NC}" "$width"

  # Focus Section
  if should_show_section "focus"; then
    print_box_separator "$width"
    print_box_line "${CYAN}  CURRENT FOCUS${NC}" "$width"

    local focus_task
    focus_task=$(get_focus_task)
    local focus_id
    focus_id=$(jq -r '.focus.currentTask // ""' "$TODO_FILE" 2>/dev/null)

    if [[ -n "$focus_id" && "$focus_id" != "null" ]]; then
      local task_title
      task_title=$(echo "$focus_task" | jq -r '.title // "Unknown"')
      local task_status
      task_status=$(echo "$focus_task" | jq -r '.status // "unknown"')
      local status_sym=$(status_symbol "$task_status" "$unicode")

      print_box_line "  ${status_sym} [$focus_id] $task_title" "$width"

      local session_note
      session_note=$(jq -r '.focus.sessionNote // ""' "$TODO_FILE" 2>/dev/null)
      if [[ -n "$session_note" && "$session_note" != "null" ]]; then
        # Truncate long notes
        if [[ ${#session_note} -gt 50 ]]; then
          session_note="${session_note:0:47}..."
        fi
        print_box_line "  ${DIM}Note: $session_note${NC}" "$width"
      fi
    else
      print_box_line "  ${DIM}No active focus${NC}" "$width"
    fi
  fi

  # Summary Section
  if should_show_section "summary"; then
    print_box_separator "$width"
    print_box_line "${BLUE}  TASK OVERVIEW${NC}" "$width"

    local pending=$(count_by_status "pending")
    local active=$(count_by_status "active")
    local blocked=$(count_by_status "blocked")
    local done=$(count_by_status "done")
    local total=$((pending + active + blocked + done))

    local sym_pending=$(status_symbol "pending" "$unicode")
    local sym_active=$(status_symbol "active" "$unicode")
    local sym_blocked=$(status_symbol "blocked" "$unicode")
    local sym_done=$(status_symbol "done" "$unicode")

    print_box_line "  ${DIM}$sym_pending${NC} $pending pending   ${CYAN}$sym_active${NC} $active active" "$width"
    print_box_line "  ${YELLOW}$sym_blocked${NC} $blocked blocked   ${GREEN}$sym_done${NC} $done done" "$width"
    print_box_line "  ${DIM}Total: $total tasks${NC}" "$width"
  fi

  # Priority Section
  if should_show_section "priority"; then
    local high_tasks
    high_tasks=$(get_high_priority_tasks)
    local high_count
    high_count=$(echo "$high_tasks" | jq -r 'length')

    if [[ "$high_count" -gt 0 ]]; then
      print_box_separator "$width"
      print_box_line "${YELLOW}  HIGH PRIORITY ($high_count tasks)${NC}" "$width"

      echo "$high_tasks" | jq -r '.[] | "\(.id) \(.title)"' | head -5 | while read -r line; do
        local task_id="${line%% *}"
        local task_title="${line#* }"
        if [[ ${#task_title} -gt 45 ]]; then
          task_title="${task_title:0:42}..."
        fi
        print_box_line "  $task_id $task_title" "$width"
      done
    fi
  fi

  # Blocked Section
  if should_show_section "blocked"; then
    local blocked_tasks
    blocked_tasks=$(get_blocked_tasks)
    local blocked_count
    blocked_count=$(echo "$blocked_tasks" | jq -r 'length')

    if [[ "$blocked_count" -gt 0 ]]; then
      print_box_separator "$width"
      print_box_line "${RED}  BLOCKED TASKS ($blocked_count)${NC}" "$width"

      echo "$blocked_tasks" | jq -r '.[] | "\(.id) \(.title) |\(.blockedBy // "unknown")"' | head -3 | while read -r line; do
        local task_id="${line%%|*}"
        task_id="${task_id%% *}"
        local rest="${line#* }"
        local task_title="${rest%%|*}"
        local blocked_by="${rest#*|}"

        if [[ ${#task_title} -gt 35 ]]; then
          task_title="${task_title:0:32}..."
        fi

        local sym_blocked=$(status_symbol "blocked" "$unicode")
        print_box_line "  ${sym_blocked} $task_id $task_title" "$width"
        if [[ -n "$blocked_by" && "$blocked_by" != "unknown" && "$blocked_by" != "null" ]]; then
          if [[ ${#blocked_by} -gt 40 ]]; then
            blocked_by="${blocked_by:0:37}..."
          fi
          print_box_line "    ${DIM}Blocked by: $blocked_by${NC}" "$width"
        fi
      done
    fi
  fi

  # Phases Section
  if should_show_section "phases" && [[ "$SHOW_CHARTS" == "true" ]]; then
    local phase_stats
    phase_stats=$(get_phase_stats)
    local phase_count
    phase_count=$(echo "$phase_stats" | jq -r 'length')

    if [[ "$phase_count" -gt 0 ]]; then
      print_box_separator "$width"
      print_box_line "${GREEN}  PHASES${NC}" "$width"

      echo "$phase_stats" | jq -c '.[]' | while read -r phase; do
        local slug name total done_count
        slug=$(echo "$phase" | jq -r '.slug')
        name=$(echo "$phase" | jq -r '.name')
        total=$(echo "$phase" | jq -r '.total')
        done_count=$(echo "$phase" | jq -r '.done')

        local progress_str
        if [[ "$total" -gt 0 ]]; then
          progress_str=$(progress_bar "$done_count" "$total" 12 "$unicode")
        else
          progress_str=$(progress_bar 0 1 12 "$unicode")
        fi

        local display_name="$name"
        if [[ ${#display_name} -gt 12 ]]; then
          display_name="${display_name:0:10}.."
        fi

        # Check if this is the current phase
        local is_current=""
        if [[ "$slug" == "$current_phase_slug" && -n "$current_phase_slug" ]]; then
          is_current="${BOLD}★${NC} "
        else
          is_current="  "
        fi

        printf -v line_content "%s%-12s %s %d/%d" "$is_current" "$display_name" "$progress_str" "$done_count" "$total"
        print_box_line "$line_content" "$width"
      done
    fi
  fi

  # Labels Section
  if should_show_section "labels"; then
    local top_labels
    top_labels=$(get_top_labels)
    local label_count
    label_count=$(echo "$top_labels" | jq -r 'length')

    if [[ "$label_count" -gt 0 ]]; then
      print_box_separator "$width"
      print_box_line "${BLUE}  TOP LABELS${NC}" "$width"

      local label_line=""
      echo "$top_labels" | jq -r '.[] | "\(.label) (\(.count))"' | head -6 | while read -r label_info; do
        if [[ -z "$label_line" ]]; then
          label_line="  $label_info"
        else
          label_line="$label_line  $label_info"
        fi

        # Print when line gets long enough
        if [[ ${#label_line} -gt 50 ]]; then
          print_box_line "$label_line" "$width"
          label_line=""
        fi
      done

      # Print remaining labels
      [[ -n "$label_line" ]] && print_box_line "$label_line" "$width"
    fi
  fi

  # Activity Section
  if should_show_section "activity"; then
    local cutoff_date
    cutoff_date=$(timestamp_days_ago "$PERIOD_DAYS")
    local activity
    activity=$(get_activity_metrics "$cutoff_date")

    local created completed rate
    created=$(echo "$activity" | jq -r '.created')
    completed=$(echo "$activity" | jq -r '.completed')
    rate=$(echo "$activity" | jq -r '.rate')

    print_box_separator "$width"
    print_box_line "${DIM}  RECENT ACTIVITY (${PERIOD_DAYS} days)${NC}" "$width"
    print_box_line "  Created: $created   Completed: $completed   Rate: ${rate}%" "$width"
  fi

  # Archive Section
  if should_show_section "archive"; then
    local archived_count
    archived_count=$(get_archived_count)

    if [[ "$archived_count" -gt 0 ]]; then
      local date_range
      date_range=$(get_archive_date_range)
      local oldest newest
      oldest=$(echo "$date_range" | jq -r '.oldest // "" | split("T")[0]')
      newest=$(echo "$date_range" | jq -r '.newest // "" | split("T")[0]')

      print_box_separator "$width"
      print_box_line "${DIM}  ARCHIVE${NC}" "$width"
      print_box_line "  Archived Tasks: $archived_count" "$width"

      if [[ -n "$oldest" && "$oldest" != "null" && "$oldest" != "" ]]; then
        print_box_line "  Oldest: $oldest   |   Newest: $newest" "$width"
      fi
    fi
  fi

  # Recent Completions Section
  if should_show_section "completions"; then
    local completion_counts
    completion_counts=$(get_completion_counts)
    local today week month
    today=$(echo "$completion_counts" | jq -r '.today')
    week=$(echo "$completion_counts" | jq -r '.thisWeek')
    month=$(echo "$completion_counts" | jq -r '.thisMonth')

    if [[ "$month" -gt 0 ]]; then
      print_box_separator "$width"
      print_box_line "${GREEN}  RECENT COMPLETIONS${NC}" "$width"
      print_box_line "  Today: $today   This Week: $week   This Month: $month" "$width"

      # Get recent completions with details
      local recent_completions
      recent_completions=$(get_recent_completions 5)
      local completion_count
      completion_count=$(echo "$recent_completions" | jq -r 'length')

      if [[ "$completion_count" -gt 0 ]]; then
        print_box_line "" "$width"
        print_box_line "  ${DIM}Last $completion_count completed:${NC}" "$width"

        echo "$recent_completions" | jq -r '.[] | "\(.id) \(.title) \(.date)"' | while read -r line; do
          local task_id="${line%% *}"
          local rest="${line#* }"
          local task_title="${rest% *}"
          local task_date="${rest##* }"

          # Truncate title if too long
          if [[ ${#task_title} -gt 30 ]]; then
            task_title="${task_title:0:27}..."
          fi

          # Format date as MM/DD
          local month_day
          month_day=$(echo "$task_date" | awk -F- '{print $2"/"$3}')

          local sym_done=$(status_symbol "done" "$unicode")
          print_box_line "    ${sym_done} $task_id - $task_title ($month_day)" "$width"
        done
      fi
    fi
  fi

  print_box_bottom "$width"
}

# Output JSON format
output_json_format() {
  local cutoff_date
  cutoff_date=$(timestamp_days_ago "$PERIOD_DAYS")

  local project
  project=$(get_project_name)

  local current_phase_info
  current_phase_info=$(get_current_phase)

  local pending=$(count_by_status "pending")
  local active=$(count_by_status "active")
  local blocked=$(count_by_status "blocked")
  local done=$(count_by_status "done")
  local total=$((pending + active + blocked + done))

  local focus_info
  focus_info=$(get_focus_info)

  local focus_task
  focus_task=$(get_focus_task)

  local high_priority_tasks
  high_priority_tasks=$(get_high_priority_tasks)

  local blocked_tasks
  blocked_tasks=$(get_blocked_tasks)

  local phase_stats
  phase_stats=$(get_phase_stats)

  local top_labels
  top_labels=$(get_top_labels)

  local activity
  activity=$(get_activity_metrics "$cutoff_date")

  local archived_count
  archived_count=$(get_archived_count)

  local date_range
  date_range=$(get_archive_date_range)

  local completion_counts
  completion_counts=$(get_completion_counts)

  local recent_completions
  recent_completions=$(get_recent_completions 5)

  local session_id
  session_id=$(get_session_status)

  jq -n \
    --arg project "$project" \
    --arg timestamp "$(get_timestamp)" \
    --argjson currentPhase "$current_phase_info" \
    --argjson pending "$pending" \
    --argjson active "$active" \
    --argjson blocked "$blocked" \
    --argjson done "$done" \
    --argjson total "$total" \
    --argjson focus "$focus_info" \
    --argjson focusTask "$focus_task" \
    --argjson highPriority "$high_priority_tasks" \
    --argjson blockedTasks "$blocked_tasks" \
    --argjson phases "$phase_stats" \
    --argjson topLabels "$top_labels" \
    --argjson activity "$activity" \
    --argjson archivedCount "$archived_count" \
    --argjson archiveDateRange "$date_range" \
    --argjson completionCounts "$completion_counts" \
    --argjson recentCompletions "$recent_completions" \
    --argjson periodDays "$PERIOD_DAYS" \
    --arg session "$session_id" \
    --arg version "$VERSION" \
    '{
      "_meta": {
        "format": "json",
        "version": $version,
        "command": "dash",
        "timestamp": $timestamp,
        "periodDays": $periodDays
      },
      "project": $project,
      "currentPhase": $currentPhase,
      "session": (if $session == "" then null else $session end),
      "focus": {
        "current": $focus,
        "task": (if $focusTask == {} then null else $focusTask end)
      },
      "summary": {
        "pending": $pending,
        "active": $active,
        "blocked": $blocked,
        "done": $done,
        "total": $total
      },
      "highPriority": {
        "count": ($highPriority | length),
        "tasks": $highPriority
      },
      "blockedTasks": {
        "count": ($blockedTasks | length),
        "tasks": $blockedTasks
      },
      "phases": $phases,
      "topLabels": $topLabels,
      "recentActivity": $activity,
      "archive": {
        "count": $archivedCount,
        "dateRange": $archiveDateRange
      },
      "completions": {
        "counts": $completionCounts,
        "recent": $recentCompletions
      }
    }'
}

#####################################################################
# Argument Parsing
#####################################################################

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      --compact|-c)
        COMPACT_MODE=true
        shift
        ;;
      --period)
        PERIOD_DAYS="$2"
        if ! [[ "$PERIOD_DAYS" =~ ^[0-9]+$ ]]; then
          echo "[ERROR] --period must be a positive integer" >&2
          exit 1
        fi
        shift 2
        ;;
      --no-chart|--no-charts)
        SHOW_CHARTS=false
        shift
        ;;
      --sections)
        SECTIONS="$2"
        shift 2
        ;;
      --format|-f)
        OUTPUT_FORMAT="$2"
        if ! validate_format "$OUTPUT_FORMAT" "text,json"; then
          exit 1
        fi
        shift 2
        ;;
      --help|-h)
        usage
        ;;
      *)
        echo "[ERROR] Unknown option: $1" >&2
        echo "Run 'claude-todo dash --help' for usage"
        exit 1
        ;;
    esac
  done
}

#####################################################################
# Main Execution
#####################################################################

main() {
  parse_arguments "$@"

  # Check if in a todo-enabled project
  if [[ ! -f "$TODO_FILE" ]]; then
    echo "[ERROR] Todo file not found: $TODO_FILE" >&2
    echo "Run 'claude-todo init' first" >&2
    exit 1
  fi

  # Check required commands
  if ! command -v jq &>/dev/null; then
    echo "[ERROR] jq is required but not installed" >&2
    exit 1
  fi

  # Output in requested format
  case "$OUTPUT_FORMAT" in
    json)
      output_json_format
      ;;
    text)
      if [[ "$COMPACT_MODE" == "true" ]]; then
        output_compact
      else
        output_text_format
      fi
      ;;
  esac
}

main "$@"
