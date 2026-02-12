#!/usr/bin/env bash
###CLEO
# command: labels
# category: read
# synopsis: List all labels with counts or show tasks with specific label
# relevance: medium
# flags: --format,--quiet
# exits: 0,4,100
# json-output: true
# subcommands: show
###END

#####################################################################
# labels.sh - Label Management Command for Claude Todo System
#
# List and analyze labels (tags) across all tasks:
# - Show all labels with task counts
# - Visual bar graph of label distribution
# - Highlight labels with critical/high priority tasks
# - Show tasks for specific labels
#
# Usage:
#   labels.sh [SUBCOMMAND] [OPTIONS]
#
# Subcommands:
#   (none)            List all labels with counts (default)
#   show LABEL        Show tasks with specific label
#   stats             Show detailed label statistics
#
# Options:
#   --format FORMAT   Output format: text | json (default: text)
#   -h, --help        Show this help message
#
# Alias: This command can also be invoked as 'tags'
#
# Examples:
#   labels.sh                      # List all labels
#   labels.sh show backend         # Show tasks with 'backend' label
#   labels.sh stats                # Detailed statistics
#   labels.sh --format json        # JSON output
#
# Version: 0.8.0
# Part of: cleo CLI Output Enhancement (Phase 2)
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

# Source error JSON library (includes exit-codes.sh)
if [[ -f "$LIB_DIR/core/error-json.sh" ]]; then
  # shellcheck source=../lib/core/error-json.sh
  source "$LIB_DIR/core/error-json.sh"
elif [[ -f "$LIB_DIR/core/exit-codes.sh" ]]; then
  # Fallback: source exit codes directly if error-json.sh not available
  # shellcheck source=../lib/core/exit-codes.sh
  source "$LIB_DIR/core/exit-codes.sh"
fi

if [[ -f "${LIB_DIR}/core/logging.sh" ]]; then
  source "${LIB_DIR}/core/logging.sh"
elif [[ -f "$CLEO_HOME/lib/core/logging.sh" ]]; then
  source "$CLEO_HOME/lib/core/logging.sh"
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
COMMAND_NAME="labels"
SUBCOMMAND="list"
LABEL_ARG=""
QUIET_MODE=false

# Initialize flag defaults
init_flag_defaults

# File paths
CLEO_DIR=".cleo"
TODO_FILE="${CLEO_DIR}/todo.json"

#####################################################################
# Usage
#####################################################################

usage() {
  cat << 'EOF'
Usage: cleo labels [SUBCOMMAND] [OPTIONS]

List and analyze labels (tags) across all tasks.

Subcommands:
    (none)            List all labels with counts (default)
    show LABEL        Show all tasks with specific label
    stats             Detailed label statistics

Options:
    --format, -f FORMAT   Output format: text | json (default: text)
    --json                Shortcut for --format json
    --human               Shortcut for --format text
    -q, --quiet           Suppress non-essential output (exit 0 if labels exist)
    -h, --help            Show this help message

Examples:
    cleo labels                      # List all labels
    cleo labels show backend         # Show tasks with 'backend' label
    cleo labels stats                # Show detailed statistics
    cleo labels --format json        # JSON output

Alias: This command can also be invoked as 'cleo tags'

Output:
    Shows labels sorted by task count with visual bars.
    Labels with critical or high priority tasks are highlighted.
EOF
  exit "$EXIT_SUCCESS"
}

#####################################################################
# Helper Functions
#####################################################################

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

# Pluralize word based on count (1 task vs 2 tasks)
pluralize() {
  local count="$1"
  local singular="$2"
  local plural="${3:-${singular}s}"
  if [[ "$count" -eq 1 ]]; then
    echo "$singular"
  else
    echo "$plural"
  fi
}

# Generate a simple bar visualization
make_bar() {
  local count="$1"
  local max_count="$2"
  local bar_width="${3:-20}"
  local unicode="${4:-true}"

  if [[ "$max_count" -eq 0 ]]; then
    echo ""
    return
  fi

  local filled=$((count * bar_width / max_count))
  [[ "$filled" -lt 1 && "$count" -gt 0 ]] && filled=1
  [[ "$filled" -gt "$bar_width" ]] && filled=$bar_width

  local bar=""
  if [[ "$unicode" == "true" ]]; then
    for ((i=0; i<filled; i++)); do
      bar="${bar}█"
    done
  else
    for ((i=0; i<filled; i++)); do
      bar="${bar}#"
    done
  fi

  echo "$bar"
}

# Get all labels with counts and priority info
get_label_data() {
  jq -r '
    # Collect all labels from all tasks
    [.tasks[] | {
      labels: (.labels // []),
      priority: .priority,
      status: .status,
      id: .id
    }] |
    # Flatten to individual label entries
    [.[] | .labels[] as $label | {label: $label, priority: .priority, status: .status, id: .id}] |
    # Group by label
    group_by(.label) |
    # Aggregate stats for each label
    map({
      label: .[0].label,
      count: length,
      taskIds: ([.[].id] | unique),
      byStatus: (group_by(.status) | map({key: .[0].status, value: length}) | from_entries),
      byPriority: (group_by(.priority) | map({key: .[0].priority, value: length}) | from_entries)
    }) |
    # Sort by count descending
    sort_by(-.count)
  ' "$TODO_FILE" 2>/dev/null || echo "[]"
}

# Get tasks for a specific label
get_tasks_by_label() {
  local label="$1"

  jq -r --arg label "$label" '
    [.tasks[] | select(.labels != null and (.labels | contains([$label])))]
  ' "$TODO_FILE" 2>/dev/null || echo "[]"
}

# Get label statistics
get_label_stats() {
  jq '
    # Get all labels
    ([.tasks[].labels // [] | .[]] | unique | length) as $uniqueLabels |
    # Get total tasks with labels
    ([.tasks[] | select(.labels != null and (.labels | length) > 0)] | length) as $tasksWithLabels |
    # Get total labels used
    ([.tasks[].labels // [] | .[]] | length) as $totalLabelUsage |
    # Get tasks without labels
    ([.tasks[] | select(.labels == null or (.labels | length) == 0)] | length) as $tasksWithoutLabels |
    # Total tasks
    (.tasks | length) as $totalTasks |

    {
      uniqueLabels: $uniqueLabels,
      tasksWithLabels: $tasksWithLabels,
      tasksWithoutLabels: $tasksWithoutLabels,
      totalTasks: $totalTasks,
      totalLabelUsage: $totalLabelUsage,
      avgLabelsPerTask: (if $tasksWithLabels > 0 then (($totalLabelUsage / $tasksWithLabels * 100 | floor) / 100) else 0 end)
    }
  ' "$TODO_FILE" 2>/dev/null || echo "{}"
}

# Get label co-occurrence data
get_label_cooccurrence() {
  jq '
    # Get all tasks with multiple labels and generate unique pairs
    [.tasks[] |
      select(.labels != null and (.labels | length) > 1) |
      .labels | sort |
      # Generate all unique pairs (no duplicates, no self-pairs)
      . as $labels |
      [range(0; length) | . as $i | range($i+1; $labels | length) | [$labels[$i], $labels[.]]]
    ] |
    flatten(1) |
    group_by(.) |
    map({pair: .[0], count: length}) |
    sort_by(-.count) |
    .[0:5]
  ' "$TODO_FILE" 2>/dev/null || echo "[]"
}

#####################################################################
# Output Formatters - List
#####################################################################

output_list_text() {
  local label_data="$1"
  local count
  count=$(echo "$label_data" | jq -r 'length')

  get_colors

  if [[ "$count" -eq 0 ]]; then
    echo ""
    echo -e "${YELLOW}No labels found in any tasks.${NC}"
    echo ""
    echo "To add labels to a task:"
    echo "  cleo update T001 --labels backend,api"
    echo ""
    return
  fi

  local unicode
  detect_unicode_support 2>/dev/null && unicode="true" || unicode="false"

  # Get max count for bar scaling
  local max_count
  max_count=$(echo "$label_data" | jq -r '.[0].count // 1')

  echo ""
  echo -e "${BOLD}Labels ($count unique)${NC}"
  echo ""

  echo "$label_data" | jq -c '.[]' | while read -r label_info; do
    local label count critical high
    label=$(echo "$label_info" | jq -r '.label')
    count=$(echo "$label_info" | jq -r '.count')
    critical=$(echo "$label_info" | jq -r '.byPriority.critical // 0')
    high=$(echo "$label_info" | jq -r '.byPriority.high // 0')

    # Generate bar
    local bar
    bar=$(make_bar "$count" "$max_count" 15 "$unicode")

    # Format label name (pad to 15 chars)
    local display_label="$label"
    if [[ ${#display_label} -gt 15 ]]; then
      display_label="${display_label:0:12}..."
    fi

    # Build line
    printf "  %-15s %s  %2d tasks" "$display_label" "$bar" "$count"

    # Add priority indicators
    if [[ "$critical" -gt 0 ]]; then
      printf "  ${RED}%d critical${NC}" "$critical"
    fi
    if [[ "$high" -gt 0 ]]; then
      printf "  ${YELLOW}%d high${NC}" "$high"
    fi

    echo ""
  done

  echo ""
}

output_list_json() {
  local label_data="$1"

  jq -nc \
    --argjson labels "$label_data" \
    --arg version "$VERSION" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "format": "json",
        "version": $version,
        "command": "labels",
        "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
      },
      "success": true,
      "totalLabels": ($labels | length),
      "labels": $labels
    }'
}

#####################################################################
# Output Formatters - Show
#####################################################################

output_show_text() {
  local label="$1"
  local tasks="$2"
  local count
  count=$(echo "$tasks" | jq -r 'length')

  get_colors

  if [[ "$count" -eq 0 ]]; then
    echo ""
    echo -e "${YELLOW}No tasks found with label: $label${NC}"
    echo ""
    return
  fi

  local unicode
  detect_unicode_support 2>/dev/null && unicode="true" || unicode="false"

  echo ""
  echo -e "${BOLD}Tasks with label: ${CYAN}$label${NC} ($count $(pluralize "$count" "task"))"
  echo ""

  echo "$tasks" | jq -c '.[]' | while read -r task; do
    local task_id title status priority
    task_id=$(echo "$task" | jq -r '.id')
    title=$(echo "$task" | jq -r '.title')
    status=$(echo "$task" | jq -r '.status')
    priority=$(echo "$task" | jq -r '.priority')

    local status_sym
    status_sym=$(status_symbol "$status" "$unicode")
    local priority_sym
    priority_sym=$(priority_symbol "$priority" "$unicode")

    # Truncate title if needed
    if [[ ${#title} -gt 50 ]]; then
      title="${title:0:47}..."
    fi

    echo -e "  ${status_sym} ${priority_sym} ${BOLD}[$task_id]${NC} $title"
    echo -e "     ${DIM}Status: $status  Priority: $priority${NC}"
    echo ""
  done
}

output_show_json() {
  local label="$1"
  local tasks="$2"

  jq -nc \
    --arg label "$label" \
    --argjson tasks "$tasks" \
    --arg version "$VERSION" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "format": "json",
        "version": $version,
        "command": "labels show",
        "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
      },
      "success": true,
      "label": $label,
      "taskCount": ($tasks | length),
      "tasks": $tasks
    }'
}

#####################################################################
# Output Formatters - Stats
#####################################################################

output_stats_text() {
  local label_data="$1"
  local stats="$2"
  local cooccurrence="$3"

  get_colors

  echo ""
  echo -e "${BOLD}Label Statistics${NC}"
  echo ""

  # Summary stats
  local unique total_tasks with_labels without_labels avg
  unique=$(echo "$stats" | jq -r '.uniqueLabels')
  total_tasks=$(echo "$stats" | jq -r '.totalTasks')
  with_labels=$(echo "$stats" | jq -r '.tasksWithLabels')
  without_labels=$(echo "$stats" | jq -r '.tasksWithoutLabels')
  avg=$(echo "$stats" | jq -r '.avgLabelsPerTask')

  echo "Summary:"
  echo "  Unique labels:      $unique"
  echo "  Tasks with labels:  $with_labels / $total_tasks"
  echo "  Tasks without:      $without_labels"
  echo "  Avg labels/task:    $avg"
  echo ""

  # Top labels
  echo -e "${BOLD}Top Labels:${NC}"
  echo "$label_data" | jq -r '.[:5][] | "  \(.label): \(.count) tasks"'
  echo ""

  # Co-occurrence
  local co_count
  co_count=$(echo "$cooccurrence" | jq -r 'length')
  if [[ "$co_count" -gt 0 ]]; then
    echo -e "${BOLD}Common Label Pairs:${NC}"
    echo "$cooccurrence" | jq -r '.[] | "  \(.pair[0]) + \(.pair[1]): \(.count) tasks"'
    echo ""
  fi

  # Priority distribution by label
  echo -e "${BOLD}Labels with High-Priority Tasks:${NC}"
  echo "$label_data" | jq -r '
    .[] |
    select((.byPriority.critical // 0) > 0 or (.byPriority.high // 0) > 0) |
    "  \(.label): \(.byPriority.critical // 0) critical, \(.byPriority.high // 0) high"
  ' | head -10
  echo ""
}

output_stats_json() {
  local label_data="$1"
  local stats="$2"
  local cooccurrence="$3"

  jq -nc \
    --argjson labels "$label_data" \
    --argjson stats "$stats" \
    --argjson cooccurrence "$cooccurrence" \
    --arg version "$VERSION" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "format": "json",
        "version": $version,
        "command": "labels stats",
        "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
      },
      "success": true,
      "summary": $stats,
      "labels": $labels,
      "cooccurrence": $cooccurrence
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
  QUIET_MODE="${FLAG_QUIET:-false}"

  # Handle help flag
  if [[ "$FLAG_HELP" == true ]]; then
    usage
  fi

  # Valid subcommands
  local VALID_SUBCOMMANDS="list show stats"

  # Check for subcommand first
  if [[ $# -gt 0 ]]; then
    case $1 in
      show)
        SUBCOMMAND="show"
        shift
        if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
          LABEL_ARG="$1"
          # Validate non-empty label
          if [[ -z "$LABEL_ARG" ]]; then
            if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
              output_error "$E_INPUT_MISSING" "Label cannot be empty" "${EXIT_INVALID_INPUT:-1}" true "Usage: cleo labels show LABEL"
            else
              output_error "$E_INPUT_MISSING" "Label cannot be empty"
              echo "Usage: cleo labels show LABEL" >&2
            fi
            exit "${EXIT_INVALID_INPUT:-1}"
          fi
          shift
        else
          if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "$E_INPUT_MISSING" "'show' requires a label argument" "${EXIT_INVALID_INPUT:-1}" true "Usage: cleo labels show LABEL"
          else
            output_error "$E_INPUT_MISSING" "'show' requires a label argument"
            echo "Usage: cleo labels show LABEL" >&2
          fi
          exit "${EXIT_INVALID_INPUT:-1}"
        fi
        ;;
      stats)
        SUBCOMMAND="stats"
        shift
        ;;
      list)
        SUBCOMMAND="list"
        shift
        ;;
      --*)
        # Not a subcommand, will be parsed below
        ;;
      -*)
        # Not a subcommand, will be parsed below
        ;;
      *)
        # Invalid subcommand - show error with suggestion
        if declare -f output_error >/dev/null 2>&1; then
          output_error "$E_INPUT_INVALID" "Invalid subcommand: $1" "${EXIT_INVALID_INPUT:-1}" true "Valid subcommands: $VALID_SUBCOMMANDS"
        else
          echo "[ERROR] Invalid subcommand: $1" >&2
          echo "Valid subcommands: $VALID_SUBCOMMANDS" >&2
        fi
        exit "${EXIT_INVALID_INPUT:-1}"
        ;;
    esac
  fi

  # Parse remaining command-specific options
  while [[ $# -gt 0 ]]; do
    case $1 in
      -*)
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
          output_error "$E_INPUT_INVALID" "Unknown option: $1" "${EXIT_INVALID_INPUT:-1}" true "Run 'cleo labels --help' for usage"
        else
          output_error "$E_INPUT_INVALID" "Unknown option: $1"
          echo "Run 'cleo labels --help' for usage" >&2
        fi
        exit "${EXIT_INVALID_INPUT:-1}"
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

  # Resolve format (TTY-aware auto-detection)
  FORMAT=$(resolve_format "${FORMAT:-}")

  # Validate format (reject invalid formats instead of silent fallback)
  local VALID_FORMATS="text json markdown"
  if ! echo "$VALID_FORMATS" | grep -qw "$FORMAT"; then
    if declare -f output_error >/dev/null 2>&1; then
      output_error "E_INPUT_INVALID" "Invalid format: $FORMAT" "${EXIT_INVALID_INPUT:-2}" true "Valid formats: $VALID_FORMATS"
    else
      echo "[ERROR] Invalid format: $FORMAT. Valid formats: $VALID_FORMATS" >&2
    fi
    exit "${EXIT_INVALID_INPUT:-2}"
  fi

  # Check if in a todo-enabled project
  if [[ ! -f "$TODO_FILE" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "$E_NOT_INITIALIZED" "Todo file not found: $TODO_FILE" "${EXIT_NOT_INITIALIZED:-1}" true "Run 'cleo init' first"
    else
      output_error "$E_NOT_INITIALIZED" "Todo file not found: $TODO_FILE"
      echo "Run 'cleo init' first" >&2
    fi
    exit "${EXIT_NOT_INITIALIZED:-1}"
  fi

  # Check required commands
  if ! command -v jq &>/dev/null; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "$E_DEPENDENCY_MISSING" "jq is required but not installed" "${EXIT_DEPENDENCY_MISSING:-1}" true "Install jq: https://stedolan.github.io/jq/download/"
    else
      output_error "$E_DEPENDENCY_MISSING" "jq is required but not installed"
    fi
    exit "${EXIT_DEPENDENCY_MISSING:-1}"
  fi

  case "$SUBCOMMAND" in
    list)
      local label_data
      label_data=$(get_label_data)

      # Quiet mode: just check if labels exist and exit
      if [[ "$QUIET_MODE" == "true" ]]; then
        local count
        count=$(echo "$label_data" | jq -r 'length')
        if [[ "$count" -gt 0 ]]; then
          exit "$EXIT_SUCCESS"
        else
          exit "$EXIT_NO_DATA"
        fi
      fi

      case "$FORMAT" in
        json) output_list_json "$label_data" ;;
        text) output_list_text "$label_data" ;;
      esac
      ;;

    show)
      local tasks
      tasks=$(get_tasks_by_label "$LABEL_ARG")

      # Quiet mode: just check if tasks exist with this label
      if [[ "$QUIET_MODE" == "true" ]]; then
        local count
        count=$(echo "$tasks" | jq -r 'length')
        if [[ "$count" -gt 0 ]]; then
          exit "$EXIT_SUCCESS"
        else
          exit "$EXIT_NO_DATA"
        fi
      fi

      case "$FORMAT" in
        json) output_show_json "$LABEL_ARG" "$tasks" ;;
        text) output_show_text "$LABEL_ARG" "$tasks" ;;
      esac
      ;;

    stats)
      local label_data stats cooccurrence
      label_data=$(get_label_data)
      stats=$(get_label_stats)
      cooccurrence=$(get_label_cooccurrence)

      # Quiet mode: just check if there are any labels
      if [[ "$QUIET_MODE" == "true" ]]; then
        local count
        count=$(echo "$label_data" | jq -r 'length')
        if [[ "$count" -gt 0 ]]; then
          exit "$EXIT_SUCCESS"
        else
          exit "$EXIT_NO_DATA"
        fi
      fi

      case "$FORMAT" in
        json) output_stats_json "$label_data" "$stats" "$cooccurrence" ;;
        text) output_stats_text "$label_data" "$stats" "$cooccurrence" ;;
      esac
      ;;
  esac
}

main "$@"
