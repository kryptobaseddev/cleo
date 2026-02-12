#!/usr/bin/env bash
###CLEO
# command: stats
# category: read
# synopsis: Project statistics (counts, completion rates, velocity)
# relevance: medium
# flags: --format,--quiet,--period
# exits: 0
# json-output: true
###END

#####################################################################
# stats.sh - Statistics and Reporting for Claude Todo System
#
# Generates comprehensive statistics from todo.json, archive, and log:
# - Current state (tasks by status, priority)
# - Completion metrics (rate, average time, period analysis)
# - Activity metrics (creation/completion trends)
# - Archive statistics (total, growth rate)
#
# Usage:
#   stats.sh [OPTIONS]
#
# Options:
#   --period PERIOD   Analysis period: named (week/month/etc) or days (default: 30)
#   --format FORMAT   Output format: text | json (default: text)
#   --help           Show this help message
#
# Examples:
#   stats.sh                    # Full statistics (30 days)
#   stats.sh --period week      # Last week statistics
#   stats.sh --period 7         # Last 7 days (same as week)
#   stats.sh --format json      # JSON output for scripting
#####################################################################

set -euo pipefail

# Source library functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# shellcheck source=../lib/data/file-ops.sh
source "${LIB_DIR}/data/file-ops.sh"

# shellcheck source=../lib/validation/validation.sh
source "${LIB_DIR}/validation/validation.sh"

# shellcheck source=../lib/core/output-format.sh
source "${LIB_DIR}/core/output-format.sh"

# Source error JSON library (includes exit-codes.sh)
if [[ -f "$LIB_DIR/core/error-json.sh" ]]; then
  # shellcheck source=../lib/core/error-json.sh
  source "$LIB_DIR/core/error-json.sh"
elif [[ -f "$LIB_DIR/core/exit-codes.sh" ]]; then
  # Fallback: source exit codes directly if error-json.sh not available
  # shellcheck source=../lib/core/exit-codes.sh
  source "$LIB_DIR/core/exit-codes.sh"
fi

# Source centralized flag parsing
source "$LIB_DIR/ui/flags.sh"

# Default configuration
PERIOD_DAYS=30
FORMAT=""
VERBOSE=false
QUIET=false
COMMAND_NAME="stats"

# File paths
CLEO_DIR=".cleo"
TODO_FILE="${CLEO_DIR}/todo.json"
ARCHIVE_FILE="${CLEO_DIR}/todo-archive.json"
STATS_LOG_FILE="${CLEO_DIR}/todo-log.json"
CONFIG_FILE="${CLEO_DIR}/config.json"

#####################################################################
# Helper Functions
#####################################################################

# Pluralize words based on count
pluralize() {
    local count="$1"
    local singular="$2"
    local plural="${3:-${singular}s}"

    if [[ "$count" -eq 1 ]]; then
        echo "$count $singular"
    else
        echo "$count $plural"
    fi
}

# Resolve named period aliases to numeric days
resolve_period() {
    local period="$1"
    case "$period" in
        today|t)     echo 1 ;;
        week|w)      echo 7 ;;
        month|m)     echo 30 ;;
        quarter|q)   echo 90 ;;
        year|y)      echo 365 ;;
        *)
            # If numeric, use as-is
            if [[ "$period" =~ ^[0-9]+$ ]]; then
                echo "$period"
            else
                if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
                    output_error "$E_INPUT_INVALID" "Invalid period: $period" "${EXIT_INVALID_INPUT:-1}" true "Valid values: today/t, week/w, month/m, quarter/q, year/y, or a number"
                else
                    output_error "$E_INPUT_INVALID" "Invalid period: $period"
                    echo "Valid values: today/t, week/w, month/m, quarter/q, year/y, or a number" >&2
                fi
                return 1
            fi
            ;;
    esac
}

usage() {
    cat << EOF
Usage: cleo stats [OPTIONS]

Generate comprehensive statistics from todo system files.

Options:
    -p, --period PERIOD   Analysis period (default: 30)
                          Named: today/t, week/w, month/m, quarter/q, year/y
                          Numeric: any positive integer (days)
    -f, --format FORMAT   Output format: text | json (default: text)
    --json                Shortcut for --format json
    --human               Shortcut for --format text
    -v, --verbose         Show detailed breakdowns per category
    -q, --quiet           Suppress decorative output (headers, footers)
    -h, --help            Show this help message

Examples:
    cleo stats                    # Full statistics (30 days)
    cleo stats -p week            # Last week statistics
    cleo stats -p 7               # Last 7 days (same as week)
    cleo stats -p month -f json   # Last month in JSON format
    cleo stats -p q               # Last quarter (90 days)

Period Aliases:
    today, t      1 day
    week, w       7 days
    month, m      30 days
    quarter, q    90 days
    year, y       365 days

Statistics Categories:
    Current State: Tasks by status and priority
    Completion Metrics: Rate, average time, period analysis
    Activity Metrics: Tasks created/completed per period
    Archive Statistics: Total archived, growth rate
    All-Time Statistics: Total created, completed, success rate

JSON Output Structure (--format json):
    {
      "_meta": { "version": "...", "command": "stats", ... },
      "data": {
        "current_state": { "pending": N, "in_progress": N, "completed": N, "total_active": N },
        "completion_metrics": { ... },
        "activity_metrics": { ... },
        "archive_stats": { ... },
        "all_time": { ... }
      }
    }

EOF
}

# Get current timestamp in seconds since epoch
current_timestamp() {
    date +%s
}

# Convert ISO 8601 timestamp to seconds since epoch
iso_to_seconds() {
    local iso_date="$1"
    date -d "$iso_date" +%s 2>/dev/null || echo "0"
}

# Calculate days between two timestamps
days_between() {
    local start_seconds="$1"
    local end_seconds="$2"
    echo $(( (end_seconds - start_seconds) / 86400 ))
}

# Get timestamp N days ago
timestamp_days_ago() {
    local days="$1"
    date -d "${days} days ago" -Iseconds
}

# Count tasks by status in todo.json
count_by_status() {
    local status="$1"
    if [[ ! -f "$TODO_FILE" ]]; then
        echo "0"
        return
    fi
    jq -r --arg status "$status" '[.tasks[] | select(.status == $status)] | length' "$TODO_FILE" 2>/dev/null || echo "0"
}

# Count all tasks in todo.json
count_total_tasks() {
    if [[ ! -f "$TODO_FILE" ]]; then
        echo "0"
        return
    fi
    jq -r '[.tasks[]] | length' "$TODO_FILE" 2>/dev/null || echo "0"
}

# Count archived tasks
count_archived_tasks() {
    if [[ ! -f "$ARCHIVE_FILE" ]]; then
        echo "0"
        return
    fi
    jq -r '[.archivedTasks[]] | length' "$ARCHIVE_FILE" 2>/dev/null || echo "0"
}

# Get tasks created in period
count_created_in_period() {
    local cutoff_date="$1"
    if [[ ! -f "$STATS_LOG_FILE" ]]; then
        echo "0"
        return
    fi
    jq -r --arg cutoff "$cutoff_date" \
        '[.entries[] | select(.action == "task_created" and .timestamp >= $cutoff)] | length' \
        "$STATS_LOG_FILE" 2>/dev/null || echo "0"
}

# Get tasks completed in period
count_completed_in_period() {
    local cutoff_date="$1"
    if [[ ! -f "$STATS_LOG_FILE" ]]; then
        echo "0"
        return
    fi
    jq -r --arg cutoff "$cutoff_date" \
        '[.entries[] | select(.action == "status_changed" and .new_status == "done" and .timestamp >= $cutoff)] | length' \
        "$STATS_LOG_FILE" 2>/dev/null || echo "0"
}

# Get tasks archived in period
count_archived_in_period() {
    local cutoff_date="$1"
    if [[ ! -f "$STATS_LOG_FILE" ]]; then
        echo "0"
        return
    fi
    jq -r --arg cutoff "$cutoff_date" \
        '[.entries[] | select(.action == "task_archived" and .timestamp >= $cutoff)] | length' \
        "$STATS_LOG_FILE" 2>/dev/null || echo "0"
}

# Calculate average completion time in hours
# PERFORMANCE: O(n) single-pass algorithm using jq for all calculations
calculate_avg_completion_time() {
    if [[ ! -f "$STATS_LOG_FILE" ]]; then
        echo "0"
        return
    fi

    # Single-pass jq operation to build creation/completion map and calculate average
    # This is O(n) instead of O(n²) by avoiding nested loops
    local avg_hours
    avg_hours=$(jq -r '
        # Build map of task_id -> {created: timestamp, completed: timestamp}
        reduce .entries[] as $entry ({};
            if $entry.action == "task_created" and ($entry.task_id | type == "string") then
                .[$entry.task_id].created = $entry.timestamp
            elif $entry.action == "status_changed" and $entry.new_status == "done" and ($entry.task_id | type == "string") then
                .[$entry.task_id].completed = $entry.timestamp
            else
                .
            end
        ) |
        # Calculate completion times for tasks with both create and complete timestamps
        [to_entries[] |
         select(.value.created and .value.completed) |
         {
           created: (.value.created | sub("\\.[0-9]+Z$"; "Z") | fromdate),
           completed: (.value.completed | sub("\\.[0-9]+Z$"; "Z") | fromdate),
           task_id: .key
         } |
         select(.created > 0 and .completed > 0) |
         .duration = (.completed - .created)
        ] |
        # Calculate average in hours
        if length > 0 then
            (map(.duration) | add / length / 3600 | . * 100 | round / 100)
        else
            0
        end
    ' "$STATS_LOG_FILE" 2>/dev/null || echo "0")

    echo "$avg_hours"
}

# Get busiest day of week
get_busiest_day() {
    if [[ ! -f "$STATS_LOG_FILE" ]]; then
        echo "N/A"
        return
    fi

    # Count operations by day of week
    jq -r '.entries[] |
           .timestamp |
           split("T")[0]' "$STATS_LOG_FILE" 2>/dev/null | \
    xargs -I {} date -d {} +%A 2>/dev/null | \
    sort | uniq -c | sort -rn | head -1 | awk '{print $2}' || echo "N/A"
}

# Calculate completion rate percentage
calculate_completion_rate() {
    local completed="$1"
    local created="$2"

    if [[ "$created" -eq 0 ]]; then
        echo "0"
        return
    fi

    echo "scale=2; ($completed / $created) * 100" | bc
}

#####################################################################
# Output Formatters
#####################################################################

output_text_format() {
    local stats_json="$1"

    # Detect Unicode support (respects NO_COLOR, LANG=C)
    local unicode_enabled
    if detect_unicode_support 2>/dev/null; then
        unicode_enabled=true
    else
        unicode_enabled=false
    fi

    # Section headers - use ASCII when Unicode disabled
    local ICON_STATS ICON_STATUS ICON_METRICS ICON_ACTIVITY ICON_ARCHIVE ICON_ALLTIME
    if [[ "$unicode_enabled" == true ]]; then
        ICON_STATS="📊"
        ICON_STATUS="📋"
        ICON_METRICS="📈"
        ICON_ACTIVITY="📅"
        ICON_ARCHIVE="📦"
        ICON_ALLTIME="🏆"
    else
        ICON_STATS="[STATS]"
        ICON_STATUS="[STATUS]"
        ICON_METRICS="[METRICS]"
        ICON_ACTIVITY="[ACTIVITY]"
        ICON_ARCHIVE="[ARCHIVE]"
        ICON_ALLTIME="[ALL-TIME]"
    fi

    if [[ "$QUIET" != true ]]; then
        echo "================================================"
        echo "$ICON_STATS CLAUDE TODO SYSTEM STATISTICS"
        echo "================================================"
        echo ""
    fi

    # Current State
    if [[ "$QUIET" != true ]]; then
        echo "$ICON_STATUS CURRENT STATE"
        echo "----------------"
    fi
    local pending_count=$(echo "$stats_json" | jq -r '.data.current_state.pending')
    local in_progress_count=$(echo "$stats_json" | jq -r '.data.current_state.in_progress')
    local completed_count=$(echo "$stats_json" | jq -r '.data.current_state.completed')
    local total_active_count=$(echo "$stats_json" | jq -r '.data.current_state.total_active')
    echo "Pending:      $(pluralize "$pending_count" "Task")"
    echo "In Progress:  $(pluralize "$in_progress_count" "Task")"
    echo "Completed:    $(pluralize "$completed_count" "Task")"
    echo "Total Active: $(pluralize "$total_active_count" "Task")"

    # Verbose mode: show priority breakdown
    if [[ "$VERBOSE" == true ]] && [[ -f "$TODO_FILE" ]]; then
        local critical_count=$(jq -r '[.tasks[] | select(.priority == "critical" and .status != "done")] | length' "$TODO_FILE" 2>/dev/null || echo "0")
        local high_count=$(jq -r '[.tasks[] | select(.priority == "high" and .status != "done")] | length' "$TODO_FILE" 2>/dev/null || echo "0")
        local medium_count=$(jq -r '[.tasks[] | select(.priority == "medium" and .status != "done")] | length' "$TODO_FILE" 2>/dev/null || echo "0")
        local low_count=$(jq -r '[.tasks[] | select(.priority == "low" and .status != "done")] | length' "$TODO_FILE" 2>/dev/null || echo "0")
        echo ""
        echo "By Priority (active tasks):"
        echo "  Critical: $critical_count"
        echo "  High:     $high_count"
        echo "  Medium:   $medium_count"
        echo "  Low:      $low_count"
    fi

    echo ""

    # Completion Metrics
    local period=$(echo "$stats_json" | jq -r '.data.completion_metrics.period_days')
    if [[ "$QUIET" != true ]]; then
        echo "$ICON_METRICS COMPLETION METRICS (Last $(pluralize "$period" "Day"))"
        echo "----------------"
    fi
    local completed_period=$(echo "$stats_json" | jq -r '.data.completion_metrics.completed_in_period')
    local created_period=$(echo "$stats_json" | jq -r '.data.completion_metrics.created_in_period')
    echo "Tasks Completed:     $(pluralize "$completed_period" "Task")"
    echo "Tasks Created:       $(pluralize "$created_period" "Task")"
    echo "Completion Rate:     $(echo "$stats_json" | jq -r '.data.completion_metrics.completion_rate')%"
    echo "Avg Time to Complete: $(echo "$stats_json" | jq -r '.data.completion_metrics.avg_completion_hours')h"
    echo ""

    # Activity Metrics
    if [[ "$QUIET" != true ]]; then
        echo "$ICON_ACTIVITY ACTIVITY METRICS (Last $(pluralize "$period" "Day"))"
        echo "----------------"
    fi
    local activity_created=$(echo "$stats_json" | jq -r '.data.activity_metrics.created_in_period')
    local activity_completed=$(echo "$stats_json" | jq -r '.data.activity_metrics.completed_in_period')
    local activity_archived=$(echo "$stats_json" | jq -r '.data.activity_metrics.archived_in_period')
    echo "Tasks Created:    $(pluralize "$activity_created" "Task")"
    echo "Tasks Completed:  $(pluralize "$activity_completed" "Task")"
    echo "Tasks Archived:   $(pluralize "$activity_archived" "Task")"
    echo "Busiest Day:      $(echo "$stats_json" | jq -r '.data.activity_metrics.busiest_day')"

    # Verbose mode: show phase breakdown
    if [[ "$VERBOSE" == true ]] && [[ -f "$TODO_FILE" ]]; then
        echo ""
        echo "By Phase (active tasks):"
        jq -r '.phases // {} | to_entries | .[] | "  \(.value.name // .key): " + ([$.tasks[] | select(.phase == .key)] | length | tostring)' "$TODO_FILE" 2>/dev/null | sort || echo "  (no phases defined)"
    fi

    echo ""

    # Archive Statistics
    if [[ "$QUIET" != true ]]; then
        echo "$ICON_ARCHIVE ARCHIVE STATISTICS"
        echo "----------------"
    fi
    local archive_total=$(echo "$stats_json" | jq -r '.data.archive_stats.total_archived')
    local archive_period=$(echo "$stats_json" | jq -r '.data.archive_stats.archived_in_period')
    echo "Total Archived:    $(pluralize "$archive_total" "Task")"
    echo "Archived (Period): $(pluralize "$archive_period" "Task")"
    echo ""

    # All-Time Statistics
    if [[ "$QUIET" != true ]]; then
        echo "$ICON_ALLTIME ALL-TIME STATISTICS"
        echo "----------------"
    fi
    local alltime_created=$(echo "$stats_json" | jq -r '.data.all_time.total_tasks_created')
    local alltime_completed=$(echo "$stats_json" | jq -r '.data.all_time.total_tasks_completed')
    echo "Total Created: $(pluralize "$alltime_created" "Task")"
    echo "Total Completed: $(pluralize "$alltime_completed" "Task")"
    echo ""

    if [[ "$QUIET" != true ]]; then
        echo "================================================"
        echo "Generated: $(date -Iseconds)"
        echo "================================================"
    fi
}

output_json_format() {
    local stats_json="$1"
    echo "$stats_json" | jq '.'
}

#####################################################################
# Main Statistics Generation
#####################################################################

generate_statistics() {
    local period_days="$1"
    local cutoff_date
    cutoff_date=$(timestamp_days_ago "$period_days")

    # Current State Statistics
    local pending
    pending=$(count_by_status "pending")
    local in_progress
    in_progress=$(count_by_status "active")
    local completed
    completed=$(count_by_status "done")
    local total_active
    total_active=$(count_total_tasks)

    # Completion Metrics
    local completed_in_period
    completed_in_period=$(count_completed_in_period "$cutoff_date")
    local created_in_period
    created_in_period=$(count_created_in_period "$cutoff_date")
    local completion_rate
    completion_rate=$(calculate_completion_rate "$completed_in_period" "$created_in_period")
    local avg_completion_hours
    avg_completion_hours=$(calculate_avg_completion_time)

    # Activity Metrics
    local archived_in_period
    archived_in_period=$(count_archived_in_period "$cutoff_date")
    local busiest_day
    busiest_day=$(get_busiest_day)

    # Archive Statistics
    local total_archived
    total_archived=$(count_archived_tasks)

    # All-Time Statistics
    local total_created
    total_created=$(jq -r '[.entries[] | select(.action == "task_created")] | length' "$STATS_LOG_FILE" 2>/dev/null || echo "0")
    local total_completed
    total_completed=$(jq -r '[.entries[] | select(.action == "status_changed" and .new_status == "done")] | length' "$STATS_LOG_FILE" 2>/dev/null || echo "0")

    # Build JSON output with _meta envelope (consistent with list command)
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local version
    version=$(cat "${LIB_DIR}/../VERSION" 2>/dev/null || echo "0.8.0")

    cat <<EOF
{
  "\$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "version": "$version",
    "command": "stats",
    "timestamp": "$timestamp",
    "period_days": $period_days,
    "resultsField": "data"
  },
  "success": true,
  "data": {
    "current_state": {
      "pending": $pending,
      "in_progress": $in_progress,
      "completed": $completed,
      "total_active": $total_active
    },
    "completion_metrics": {
      "period_days": $period_days,
      "completed_in_period": $completed_in_period,
      "created_in_period": $created_in_period,
      "completion_rate": $completion_rate,
      "avg_completion_hours": $avg_completion_hours
    },
    "activity_metrics": {
      "created_in_period": $created_in_period,
      "completed_in_period": $completed_in_period,
      "archived_in_period": $archived_in_period,
      "busiest_day": "$busiest_day"
    },
    "archive_stats": {
      "total_archived": $total_archived,
      "archived_in_period": $archived_in_period
    },
    "all_time": {
      "total_tasks_created": $total_created,
      "total_tasks_completed": $total_completed
    }
  }
}
EOF
}

#####################################################################
# Argument Parsing
#####################################################################

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -p|--period)
                PERIOD_DAYS=$(resolve_period "$2") || exit "$EXIT_INVALID_INPUT"
                shift 2
                ;;
            -f|--format)
                FORMAT="$2"
                if ! validate_format "$FORMAT" "text,json"; then
                    exit "$EXIT_INVALID_INPUT"
                fi
                shift 2
                ;;
            --json)
                FORMAT="json"
                shift
                ;;
            --human)
                FORMAT="human"
                shift
                ;;
            -v|--verbose)
                VERBOSE=true
                shift
                ;;
            -q|--quiet)
                QUIET=true
                shift
                ;;
            -h|--help)
                usage
                exit "$EXIT_SUCCESS"
                ;;
            *)
                if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
                    output_error "$E_INPUT_INVALID" "Unknown option: $1" "${EXIT_INVALID_INPUT:-1}" true "Run 'cleo stats --help' for usage"
                else
                    output_error "$E_INPUT_INVALID" "Unknown option: $1"
                    echo "Run 'cleo stats --help' for usage" >&2
                fi
                exit "${EXIT_INVALID_INPUT:-1}"
                ;;
        esac
    done
}

#####################################################################
# Main Execution
#####################################################################

main() {
    parse_arguments "$@"

    # Resolve format (TTY-aware auto-detection)
    FORMAT=$(resolve_format "${FORMAT:-}")

    # Check if in a todo-enabled project
    if [[ ! -d "$CLEO_DIR" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "$E_NOT_INITIALIZED" "Not in a todo-enabled project" "${EXIT_NOT_INITIALIZED:-1}" true "Run 'cleo init' first"
        else
            output_error "$E_NOT_INITIALIZED" "Not in a todo-enabled project. Run 'cleo init' first."
        fi
        exit "${EXIT_NOT_INITIALIZED:-1}"
    fi

    # Check if required commands are available
    if ! command -v jq &> /dev/null; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "$E_DEPENDENCY_MISSING" "jq is required but not installed" "${EXIT_DEPENDENCY_MISSING:-1}" true "Install jq: https://stedolan.github.io/jq/download/"
        else
            output_error "$E_DEPENDENCY_MISSING" "jq is required but not installed."
        fi
        exit "${EXIT_DEPENDENCY_MISSING:-1}"
    fi

    if ! command -v bc &> /dev/null; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "$E_DEPENDENCY_MISSING" "bc is required but not installed" "${EXIT_DEPENDENCY_MISSING:-1}" true "Install bc via your package manager"
        else
            output_error "$E_DEPENDENCY_MISSING" "bc is required but not installed."
        fi
        exit "${EXIT_DEPENDENCY_MISSING:-1}"
    fi

    # Generate statistics
    local stats_json
    stats_json=$(generate_statistics "$PERIOD_DAYS")

    # Output in requested format
    case "$FORMAT" in
        text)
            output_text_format "$stats_json"
            ;;
        json)
            output_json_format "$stats_json"
            ;;
    esac
}

# Run main function
main "$@"
