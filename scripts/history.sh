#!/usr/bin/env bash
###CLEO
# command: history
# category: read
# synopsis: Completion timeline and productivity analytics
# relevance: medium
# flags: --format,--quiet,--days,--since
# exits: 0,100
# json-output: true
###END

#####################################################################
# history.sh - Completion History & Timeline Command
#
# Provides completion timeline views with analytics:
# - Daily completion counts with sparkline visualization
# - Phase distribution of completed tasks
# - Label breakdown of completions
# - Velocity metrics (tasks/day average and peak)
#
# Usage:
#   history.sh [OPTIONS]
#
# Options:
#   --days N          Show last N days (default: 30)
#   --since DATE      Show completions since date (YYYY-MM-DD)
#   --until DATE      Show completions until date (YYYY-MM-DD)
#   --format FORMAT   Output format: text | json (default: text)
#   --no-chart        Disable bar charts
#   -h, --help        Show this help message
#
# Examples:
#   history.sh                           # Last 30 days
#   history.sh --days 7                  # Last week
#   history.sh --since 2025-12-01        # From specific date
#   history.sh --format json             # JSON output
#
# Version: 0.10.2
# Part of: cleo CLI Output Enhancement (Phase 3)
#####################################################################

set -euo pipefail

# Script and library paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source version from central location
if [[ -f "$CLEO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="unknown"
fi

# Source library functions
if [[ -f "${LIB_DIR}/data/file-ops.sh" ]]; then
  source "${LIB_DIR}/data/file-ops.sh"
elif [[ -f "$CLEO_HOME/lib/data/file-ops.sh" ]]; then
  source "$CLEO_HOME/lib/data/file-ops.sh"
fi

if [[ -f "${LIB_DIR}/core/logging.sh" ]]; then
  source "${LIB_DIR}/core/logging.sh"
elif [[ -f "$CLEO_HOME/lib/core/logging.sh" ]]; then
  source "$CLEO_HOME/lib/core/logging.sh"
fi

# Source error JSON library (includes exit-codes.sh)
if [[ -f "$LIB_DIR/core/error-json.sh" ]]; then
  # shellcheck source=../lib/core/error-json.sh
  source "$LIB_DIR/core/error-json.sh"
elif [[ -f "$LIB_DIR/core/exit-codes.sh" ]]; then
  # Fallback: source exit codes directly if error-json.sh not available
  # shellcheck source=../lib/core/exit-codes.sh
  source "$LIB_DIR/core/exit-codes.sh"
fi

if [[ -f "${LIB_DIR}/core/output-format.sh" ]]; then
  source "${LIB_DIR}/core/output-format.sh"
elif [[ -f "$CLEO_HOME/lib/core/output-format.sh" ]]; then
  source "$CLEO_HOME/lib/core/output-format.sh"
fi

# shellcheck source=../lib/ui/flags.sh
if [[ -f "${LIB_DIR}/ui/flags.sh" ]]; then
  source "${LIB_DIR}/ui/flags.sh"
elif [[ -f "$CLEO_HOME/lib/ui/flags.sh" ]]; then
  source "$CLEO_HOME/lib/ui/flags.sh"
fi

# Default configuration
DAYS=30
SINCE_DATE=""
UNTIL_DATE=""
COMMAND_NAME="history"
SHOW_CHARTS=true

# Initialize flag defaults
init_flag_defaults

# File paths
CLEO_DIR=".cleo"
TODO_FILE="${CLEO_DIR}/todo.json"
ARCHIVE_FILE="${CLEO_DIR}/todo-archive.json"
HIST_LOG_FILE="${LOG_FILE:-.cleo/todo-log.json}"

#####################################################################
# Usage
#####################################################################

usage() {
  cat << 'EOF'
Usage: cleo history [OPTIONS]

Show completion timeline and analytics.

Options:
    --days N          Show last N days (default: 30)
    --since DATE      Show completions since date (YYYY-MM-DD)
    --until DATE      Show completions until date (YYYY-MM-DD)
    -f, --format FORMAT   Output format: text | json (default: text)
    --no-chart        Disable bar charts
    -q, --quiet       Suppress informational messages
    -h, --help        Show this help message

Examples:
    cleo history                           # Last 30 days
    cleo history --days 7                  # Last week
    cleo history --since 2025-12-01        # From specific date
    cleo history --since 2025-12-01 --until 2025-12-13
    cleo history --format json             # JSON output

Output:
    - Completion counts by day with sparkline visualization
    - Phase distribution of completed tasks
    - Top labels from completed tasks
    - Velocity metrics (average, peak)
EOF
  exit "$EXIT_SUCCESS"
}

#####################################################################
# Helper Functions
#####################################################################

# Calculate date ranges
calculate_date_range() {
  local end_date
  end_date=$(date -u -Iseconds)

  local start_date
  if [[ -n "$SINCE_DATE" ]]; then
    start_date="${SINCE_DATE}T00:00:00Z"
  else
    start_date=$(date -u -d "$DAYS days ago" -Iseconds 2>/dev/null || date -u -Iseconds)
  fi

  if [[ -n "$UNTIL_DATE" ]]; then
    end_date="${UNTIL_DATE}T23:59:59Z"
  fi

  echo "$start_date|$end_date"
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

# Print box functions (reuse from dash.sh)
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

print_box_separator() {
  local width="${1:-65}"
  local unicode
  detect_unicode_support 2>/dev/null && unicode="true" || unicode="false"

  local H=$(draw_box H "$unicode")
  local V=$(draw_box V "$unicode")

  printf "%s" "$V"
  for ((i=0; i<width-2; i++)); do printf "%s" "$H"; done
  printf "%s\n" "$V"
}

print_box_line() {
  local content="$1"
  local width="${2:-65}"
  local unicode
  detect_unicode_support 2>/dev/null && unicode="true" || unicode="false"

  local V=$(draw_box V "$unicode")

  # Calculate visible length (strip ANSI codes)
  local visible_content
  visible_content=$(echo -e "$content" | sed 's/\x1b\[[0-9;]*m//g')
  local visible_len=${#visible_content}
  local padding=$((width - 4 - visible_len))
  [[ $padding -lt 0 ]] && padding=0

  printf "%s  %b%*s%s\n" "$V" "$content" "$padding" "" "$V"
}

#####################################################################
# Data Collection Functions
#####################################################################

# Get completion events from log within date range
get_completions() {
  local start_date="$1"
  local end_date="$2"

  if [[ ! -f "$HIST_LOG_FILE" ]]; then
    echo "[]"
    return
  fi

  jq -r --arg start "$start_date" --arg end "$end_date" '
    [.entries[] |
     select(.action == "status_changed" and
            .after.status == "done" and
            .timestamp >= $start and
            .timestamp <= $end)] |
    map({
      taskId: .taskId,
      timestamp: .timestamp,
      date: (.timestamp | split("T")[0])
    })
  ' "$HIST_LOG_FILE" 2>/dev/null || echo "[]"
}

# Enrich completions with task metadata (phase, labels)
enrich_completions() {
  local completions="$1"

  # Load archive and current tasks for enrichment
  local archive_tasks="[]"
  local current_tasks="[]"

  [[ -f "$ARCHIVE_FILE" ]] && archive_tasks=$(jq -r '.archivedTasks // []' "$ARCHIVE_FILE" 2>/dev/null || echo "[]")
  [[ -f "$TODO_FILE" ]] && current_tasks=$(jq -r '.tasks // []' "$TODO_FILE" 2>/dev/null || echo "[]")

  # Merge completion events with task metadata
  # Use temp files to avoid "Argument list too long" with large datasets
  local temp_dir
  temp_dir=$(mktemp -d)
  echo "$completions" > "$temp_dir/completions.json"
  echo "$archive_tasks" > "$temp_dir/archive.json"
  echo "$current_tasks" > "$temp_dir/current.json"

  jq -nc --slurpfile completions "$temp_dir/completions.json" \
        --slurpfile archive "$temp_dir/archive.json" \
        --slurpfile current "$temp_dir/current.json" '
    $completions[0] | map(
      . as $comp |
      (($archive[0] | map(select(.id == $comp.taskId)) | .[0]) //
       ($current[0] | map(select(.id == $comp.taskId)) | .[0])) as $task |
      if $task then
        {
          taskId: $comp.taskId,
          timestamp: $comp.timestamp,
          date: $comp.date,
          phase: ($task.phase // null),
          labels: ($task.labels // [])
        }
      else
        {
          taskId: $comp.taskId,
          timestamp: $comp.timestamp,
          date: $comp.date,
          phase: null,
          labels: []
        }
      end
    )
  '

  rm -rf "$temp_dir"
}

# Aggregate completions by day
aggregate_by_day() {
  local enriched="$1"

  echo "$enriched" | jq -r '
    group_by(.date) |
    map({
      date: .[0].date,
      count: length
    }) |
    sort_by(.date)
  '
}

# Aggregate completions by phase
aggregate_by_phase() {
  local enriched="$1"

  echo "$enriched" | jq -r '
    [.[] | select(.phase != null)] |
    group_by(.phase) |
    map({
      phase: .[0].phase,
      count: length
    }) |
    sort_by(-.count)
  '
}

# Aggregate completions by label
aggregate_by_label() {
  local enriched="$1"

  echo "$enriched" | jq -r '
    [.[].labels // [] | .[]] |
    group_by(.) |
    map({
      label: .[0],
      count: length
    }) |
    sort_by(-.count) |
    .[0:10]
  '
}

# Calculate velocity metrics
calculate_velocity() {
  local by_day="$1"
  local total_days="$2"

  local total_completed
  total_completed=$(echo "$by_day" | jq -r '[.[].count] | add // 0')

  local peak
  peak=$(echo "$by_day" | jq -r '[.[].count] | max // 0')

  local average=0
  if [[ "$total_days" -gt 0 && "$total_completed" -gt 0 ]]; then
    average=$(echo "scale=1; $total_completed / $total_days" | bc 2>/dev/null || echo "0")
  fi

  jq -nc --argjson total "$total_completed" \
        --argjson peak "$peak" \
        --arg average "$average" \
        '{total: $total, peak: $peak, average: ($average | tonumber)}'
}

#####################################################################
# Output Formatters - Text
#####################################################################

# Draw simple horizontal bar chart
draw_bar() {
  local count="$1"
  local max="$2"
  local width="${3:-30}"

  if [[ "$max" -eq 0 ]]; then
    return
  fi

  local filled=$(echo "scale=0; $count * $width / $max" | bc 2>/dev/null || echo "0")
  [[ "$filled" -lt 1 && "$count" -gt 0 ]] && filled=1

  local unicode
  detect_unicode_support 2>/dev/null && unicode="true" || unicode="false"

  local BLOCK
  if [[ "$unicode" == "true" ]]; then
    BLOCK="█"
  else
    BLOCK="#"
  fi

  for ((i=0; i<filled; i++)); do
    printf "%s" "$BLOCK"
  done
}

# Output text format
output_text_format() {
  local width=65
  get_colors

  local date_range
  date_range=$(calculate_date_range)
  local start_date="${date_range%|*}"
  local end_date="${date_range#*|}"

  # Calculate total days
  local start_ts end_ts total_days
  start_ts=$(date -d "${start_date}" +%s 2>/dev/null || date +%s)
  end_ts=$(date -d "${end_date}" +%s 2>/dev/null || date +%s)
  total_days=$(( (end_ts - start_ts) / 86400 + 1 ))
  [[ "$total_days" -lt 1 ]] && total_days=1

  # Format dates for display
  local start_display end_display
  start_display=$(date -d "${start_date}" "+%b %d, %Y" 2>/dev/null || echo "$start_date")
  end_display=$(date -d "${end_date}" "+%b %d, %Y" 2>/dev/null || echo "$end_date")

  # Collect data
  local completions enriched by_day by_phase by_label velocity
  completions=$(get_completions "$start_date" "$end_date")
  enriched=$(enrich_completions "$completions")
  by_day=$(aggregate_by_day "$enriched")
  by_phase=$(aggregate_by_phase "$enriched")
  by_label=$(aggregate_by_label "$enriched")
  velocity=$(calculate_velocity "$by_day" "$total_days")

  local total_completed peak average
  total_completed=$(echo "$velocity" | jq -r '.total')
  peak=$(echo "$velocity" | jq -r '.peak')
  average=$(echo "$velocity" | jq -r '.average')

  # Header
  print_box_top "$width"
  print_box_line "${BOLD}COMPLETION HISTORY${NC}" "$width"
  print_box_line "${DIM}Period: $start_display - $end_display${NC}" "$width"
  print_box_line "${DIM}Total Days: $total_days${NC}" "$width"
  print_box_separator "$width"

  # Summary
  print_box_line "${GREEN}Total Completed: $total_completed tasks${NC}" "$width"
  print_box_line "${CYAN}Average: $average tasks/day${NC}" "$width"
  print_box_line "${YELLOW}Peak: $peak tasks in one day${NC}" "$width"

  # By Day (show only if completions exist)
  local day_count
  day_count=$(echo "$by_day" | jq -r 'length')

  if [[ "$day_count" -gt 0 && "$SHOW_CHARTS" == "true" ]]; then
    print_box_separator "$width"
    print_box_line "${BLUE}BY DAY:${NC}" "$width"

    # Limit to last 10 days if too many
    local display_days
    if [[ "$day_count" -gt 10 ]]; then
      display_days=$(echo "$by_day" | jq -r '.[-10:]')
      print_box_line "${DIM}Showing last 10 days (of $day_count)${NC}" "$width"
    else
      display_days="$by_day"
    fi

    echo "$display_days" | jq -c '.[]' | while read -r day_entry; do
      local date count
      date=$(echo "$day_entry" | jq -r '.date')
      count=$(echo "$day_entry" | jq -r '.count')

      # Format date as MM/DD
      local month_day
      month_day=$(echo "$date" | awk -F- '{print $2"/"$3}')

      local bar
      bar=$(draw_bar "$count" "$peak" 25)

      printf -v line_content "  %s: %s %d" "$month_day" "$bar" "$count"
      print_box_line "$line_content" "$width"
    done
  fi

  # By Phase
  local phase_count
  phase_count=$(echo "$by_phase" | jq -r 'length')

  if [[ "$phase_count" -gt 0 ]]; then
    print_box_separator "$width"
    print_box_line "${BLUE}BY PHASE:${NC}" "$width"

    local total_with_phase
    total_with_phase=$(echo "$by_phase" | jq -r '[.[].count] | add // 0')

    echo "$by_phase" | jq -c '.[]' | while read -r phase_entry; do
      local phase count pct
      phase=$(echo "$phase_entry" | jq -r '.phase')
      count=$(echo "$phase_entry" | jq -r '.count')

      if [[ "$total_with_phase" -gt 0 ]]; then
        pct=$(echo "scale=0; $count * 100 / $total_with_phase" | bc 2>/dev/null || echo "0")
      else
        pct=0
      fi

      local bar=""
      if [[ "$SHOW_CHARTS" == "true" ]]; then
        bar=$(draw_bar "$count" "$total_with_phase" 20)
      fi

      printf -v line_content "  %-12s %3d (%2d%%)  %s" "$phase" "$count" "$pct" "$bar"
      print_box_line "$line_content" "$width"
    done
  fi

  # By Label
  local label_count
  label_count=$(echo "$by_label" | jq -r 'length')

  if [[ "$label_count" -gt 0 ]]; then
    print_box_separator "$width"
    print_box_line "${BLUE}TOP LABELS:${NC}" "$width"

    local label_line=""
    echo "$by_label" | jq -r '.[] | "\(.label): \(.count)"' | head -8 | while read -r label_info; do
      if [[ -z "$label_line" ]]; then
        label_line="  $label_info"
      else
        label_line="$label_line   $label_info"
      fi

      # Print when line gets long
      if [[ ${#label_line} -gt 50 ]]; then
        print_box_line "$label_line" "$width"
        label_line=""
      fi
    done

    # Print remaining
    [[ -n "$label_line" ]] && print_box_line "$label_line" "$width"
  fi

  print_box_bottom "$width"
}

# Output JSON format
output_json_format() {
  local date_range
  date_range=$(calculate_date_range)
  local start_date="${date_range%|*}"
  local end_date="${date_range#*|}"

  # Calculate total days
  local start_ts end_ts total_days
  start_ts=$(date -d "${start_date}" +%s 2>/dev/null || date +%s)
  end_ts=$(date -d "${end_date}" +%s 2>/dev/null || date +%s)
  total_days=$(( (end_ts - start_ts) / 86400 + 1 ))
  [[ "$total_days" -lt 1 ]] && total_days=1

  # Collect data
  local completions enriched by_day by_phase by_label velocity
  completions=$(get_completions "$start_date" "$end_date")
  enriched=$(enrich_completions "$completions")
  by_day=$(aggregate_by_day "$enriched")
  by_phase=$(aggregate_by_phase "$enriched")
  by_label=$(aggregate_by_label "$enriched")
  velocity=$(calculate_velocity "$by_day" "$total_days")

  # Build JSON output
  jq -nc \
    --arg start "$start_date" \
    --arg end "$end_date" \
    --argjson days "$total_days" \
    --argjson byDay "$by_day" \
    --argjson byPhase "$by_phase" \
    --argjson byLabel "$by_label" \
    --argjson velocity "$velocity" \
    --arg version "$VERSION" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "format": "json",
        "version": $version,
        "command": "history",
        "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
      },
      "success": true,
      "period": {
        "start": $start,
        "end": $end,
        "days": $days
      },
      "total": $velocity.total,
      "byDay": ($byDay | map({(.date): .count}) | add // {}),
      "byPhase": ($byPhase | map({(.phase): .count}) | add // {}),
      "byLabel": ($byLabel | map({(.label): .count}) | add // {}),
      "velocity": {
        "average": $velocity.average,
        "peak": $velocity.peak
      }
    }'
}

#####################################################################
# Argument Parsing
#####################################################################

parse_arguments() {
  # Parse common flags first
  parse_common_flags "$@"
  set -- "${REMAINING_ARGS[@]}"

  # Bridge to legacy variables
  apply_flags_to_globals
  local FORMAT="${FORMAT:-}"
  local QUIET="${QUIET:-false}"

  # Handle help flag
  if [[ "$FLAG_HELP" == true ]]; then
    usage
  fi

  # Parse command-specific arguments
  while [[ $# -gt 0 ]]; do
    case $1 in
      --days)
        DAYS="$2"
        if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then
          if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "$E_INPUT_INVALID" "--days must be a positive integer" 1 true "Provide a number like --days 7"
          else
            output_error "$E_INPUT_INVALID" "--days must be a positive integer"
          fi
          exit $EXIT_INVALID_INPUT
        fi
        shift 2
        ;;
      --since)
        SINCE_DATE="$2"
        # Basic date validation (YYYY-MM-DD format)
        if ! [[ "$SINCE_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
          if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "$E_INPUT_INVALID" "--since must be in YYYY-MM-DD format" 1 true "Use format like --since 2025-12-01"
          else
            output_error "$E_INPUT_INVALID" "--since must be in YYYY-MM-DD format"
          fi
          exit $EXIT_INVALID_INPUT
        fi
        shift 2
        ;;
      --until)
        UNTIL_DATE="$2"
        if ! [[ "$UNTIL_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
          if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "$E_INPUT_INVALID" "--until must be in YYYY-MM-DD format" 1 true "Use format like --until 2025-12-15"
          else
            output_error "$E_INPUT_INVALID" "--until must be in YYYY-MM-DD format"
          fi
          exit $EXIT_INVALID_INPUT
        fi
        shift 2
        ;;
      --no-chart|--no-charts)
        SHOW_CHARTS=false
        shift
        ;;
      -*)
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
          output_error "$E_INPUT_INVALID" "Unknown option: $1" 1 true "Run 'cleo history --help' for usage"
        else
          output_error "$E_INPUT_INVALID" "Unknown option: $1"
          echo "Run 'cleo history --help' for usage"
        fi
        exit $EXIT_INVALID_INPUT
        ;;
      *)
        shift
        ;;
    esac
  done
}

#####################################################################
# Main Execution
#####################################################################

main() {
  parse_arguments "$@"

  # Bridge to legacy variables after parsing
  apply_flags_to_globals
  local FORMAT="${FORMAT:-}"
  local QUIET="${QUIET:-false}"

  # Resolve format (TTY-aware auto-detection)
  FORMAT=$(resolve_format "${FORMAT:-}")

  # Check if log file exists
  if [[ ! -f "$HIST_LOG_FILE" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "$E_FILE_NOT_FOUND" "Log file not found: $HIST_LOG_FILE" 1 true "Run some commands to generate history"
    else
      output_error "$E_FILE_NOT_FOUND" "Log file not found: $HIST_LOG_FILE"
      echo "No completion history available." >&2
    fi
    exit $EXIT_FILE_ERROR
  fi

  # Check required commands
  if ! command -v jq &>/dev/null; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "$E_DEPENDENCY_MISSING" "jq is required but not installed" 1 true "Install jq: brew install jq (macOS) or apt install jq (Linux)"
    else
      output_error "$E_DEPENDENCY_MISSING" "jq is required but not installed"
    fi
    exit $EXIT_DEPENDENCY_ERROR
  fi

  # Output in requested format
  case "$FORMAT" in
    json)
      output_json_format
      ;;
    text)
      output_text_format
      ;;
  esac
}

main "$@"
