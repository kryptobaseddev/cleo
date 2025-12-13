#!/usr/bin/env bash

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
#   --period DAYS     Analysis period in days (default: 30)
#   --format FORMAT   Output format: text | json (default: text)
#   --help           Show this help message
#
# Examples:
#   stats.sh                    # Full statistics (30 days)
#   stats.sh --period 7         # Last week statistics
#   stats.sh --format json      # JSON output for scripting
#####################################################################

set -euo pipefail

# Source library functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# shellcheck source=../lib/file-ops.sh
source "${LIB_DIR}/file-ops.sh"

# shellcheck source=../lib/validation.sh
source "${LIB_DIR}/validation.sh"

# shellcheck source=../lib/output-format.sh
source "${LIB_DIR}/output-format.sh"

# Default configuration
PERIOD_DAYS=30
OUTPUT_FORMAT="text"

# File paths
CLAUDE_DIR=".claude"
TODO_FILE="${CLAUDE_DIR}/todo.json"
ARCHIVE_FILE="${CLAUDE_DIR}/todo-archive.json"
STATS_LOG_FILE="${CLAUDE_DIR}/todo-log.json"
CONFIG_FILE="${CLAUDE_DIR}/todo-config.json"

#####################################################################
# Helper Functions
#####################################################################

usage() {
    cat << EOF
Usage: claude-todo stats [OPTIONS]

Generate comprehensive statistics from todo system files.

Options:
    -p, --period DAYS     Analysis period in days (default: 30)
    -f, --format FORMAT   Output format: text | json (default: text)
    -h, --help            Show this help message

Examples:
    claude-todo stats                    # Full statistics (30 days)
    claude-todo stats -p 7               # Last week statistics
    claude-todo stats -f json            # JSON output for scripting

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
        '[.entries[] | select(.operation == "create" and .timestamp >= $cutoff)] | length' \
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
        '[.entries[] | select(.operation == "complete" and .timestamp >= $cutoff)] | length' \
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
        '[.entries[] | select(.operation == "archive" and .timestamp >= $cutoff)] | length' \
        "$STATS_LOG_FILE" 2>/dev/null || echo "0"
}

# Calculate average completion time in hours
calculate_avg_completion_time() {
    if [[ ! -f "$STATS_LOG_FILE" ]]; then
        echo "0"
        return
    fi

    # Get all completion events with their task IDs
    local completion_times
    completion_times=$(jq -r '
        [.entries[] |
         select(.operation == "complete") |
         {task_id: .task_id, completed_at: .timestamp}] |
        unique_by(.task_id)
    ' "$STATS_LOG_FILE" 2>/dev/null || echo "[]")

    # Get creation times for those tasks
    local total_seconds=0
    local count=0

    while IFS= read -r task_id; do
        if [[ -z "$task_id" ]]; then
            continue
        fi

        local created_at
        created_at=$(jq -r --arg tid "$task_id" \
            '.entries[] | select(.operation == "create" and .task_id == $tid) | .timestamp' \
            "$STATS_LOG_FILE" 2>/dev/null | head -1)

        local completed_at
        completed_at=$(echo "$completion_times" | jq -r --arg tid "$task_id" \
            '.[] | select(.task_id == $tid) | .completed_at' 2>/dev/null | head -1)

        if [[ -n "$created_at" && -n "$completed_at" ]]; then
            local created_sec
            created_sec=$(iso_to_seconds "$created_at")
            local completed_sec
            completed_sec=$(iso_to_seconds "$completed_at")

            if [[ "$created_sec" -gt 0 && "$completed_sec" -gt 0 ]]; then
                local diff=$((completed_sec - created_sec))
                total_seconds=$((total_seconds + diff))
                count=$((count + 1))
            fi
        fi
    done < <(echo "$completion_times" | jq -r '.[].task_id' 2>/dev/null)

    if [[ "$count" -eq 0 ]]; then
        echo "0"
        return
    fi

    # Return average in hours
    echo "scale=2; $total_seconds / $count / 3600" | bc
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

    echo "================================================"
    echo "$ICON_STATS CLAUDE TODO SYSTEM STATISTICS"
    echo "================================================"
    echo ""

    # Current State
    echo "$ICON_STATUS CURRENT STATE"
    echo "----------------"
    echo "Pending:      $(echo "$stats_json" | jq -r '.data.current_state.pending')"
    echo "In Progress:  $(echo "$stats_json" | jq -r '.data.current_state.in_progress')"
    echo "Completed:    $(echo "$stats_json" | jq -r '.data.current_state.completed')"
    echo "Total Active: $(echo "$stats_json" | jq -r '.data.current_state.total_active')"
    echo ""

    # Completion Metrics
    local period=$(echo "$stats_json" | jq -r '.data.completion_metrics.period_days')
    echo "$ICON_METRICS COMPLETION METRICS (Last $period days)"
    echo "----------------"
    echo "Tasks Completed:     $(echo "$stats_json" | jq -r '.data.completion_metrics.completed_in_period')"
    echo "Tasks Created:       $(echo "$stats_json" | jq -r '.data.completion_metrics.created_in_period')"
    echo "Completion Rate:     $(echo "$stats_json" | jq -r '.data.completion_metrics.completion_rate')%"
    echo "Avg Time to Complete: $(echo "$stats_json" | jq -r '.data.completion_metrics.avg_completion_hours')h"
    echo ""

    # Activity Metrics
    echo "$ICON_ACTIVITY ACTIVITY METRICS (Last $period days)"
    echo "----------------"
    echo "Tasks Created:    $(echo "$stats_json" | jq -r '.data.activity_metrics.created_in_period')"
    echo "Tasks Completed:  $(echo "$stats_json" | jq -r '.data.activity_metrics.completed_in_period')"
    echo "Tasks Archived:   $(echo "$stats_json" | jq -r '.data.activity_metrics.archived_in_period')"
    echo "Busiest Day:      $(echo "$stats_json" | jq -r '.data.activity_metrics.busiest_day')"
    echo ""

    # Archive Statistics
    echo "$ICON_ARCHIVE ARCHIVE STATISTICS"
    echo "----------------"
    echo "Total Archived:    $(echo "$stats_json" | jq -r '.data.archive_stats.total_archived')"
    echo "Archived (Period): $(echo "$stats_json" | jq -r '.data.archive_stats.archived_in_period')"
    echo ""

    # All-Time Statistics
    echo "$ICON_ALLTIME ALL-TIME STATISTICS"
    echo "----------------"
    echo "Total Tasks Created: $(echo "$stats_json" | jq -r '.data.all_time.total_tasks_created')"
    echo "Total Tasks Completed: $(echo "$stats_json" | jq -r '.data.all_time.total_tasks_completed')"
    echo ""

    echo "================================================"
    echo "Generated: $(date -Iseconds)"
    echo "================================================"
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
    total_created=$(jq -r '[.entries[] | select(.operation == "create")] | length' "$STATS_LOG_FILE" 2>/dev/null || echo "0")
    local total_completed
    total_completed=$(jq -r '[.entries[] | select(.operation == "complete")] | length' "$STATS_LOG_FILE" 2>/dev/null || echo "0")

    # Build JSON output with _meta envelope (consistent with list command)
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local version
    version=$(cat "${LIB_DIR}/../VERSION" 2>/dev/null || echo "0.8.0")

    cat <<EOF
{
  "\$schema": "https://claude-todo.dev/schemas/output-v2.json",
  "_meta": {
    "version": "$version",
    "command": "stats",
    "timestamp": "$timestamp",
    "period_days": $period_days
  },
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
                PERIOD_DAYS="$2"
                if ! [[ "$PERIOD_DAYS" =~ ^[0-9]+$ ]]; then
                    echo "Error: --period must be a positive integer" >&2
                    exit 1
                fi
                shift 2
                ;;
            -f|--format)
                OUTPUT_FORMAT="$2"
                if ! validate_format "$OUTPUT_FORMAT" "text,json"; then
                    exit 1
                fi
                shift 2
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                echo "[ERROR] Unknown option: $1" >&2
                echo "Run 'claude-todo stats --help' for usage"
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
    if [[ ! -d "$CLAUDE_DIR" ]]; then
        echo "[ERROR] Not in a todo-enabled project. Run 'claude-todo init' first." >&2
        exit 1
    fi

    # Check if required commands are available
    if ! command -v jq &> /dev/null; then
        echo "[ERROR] jq is required but not installed." >&2
        exit 1
    fi

    if ! command -v bc &> /dev/null; then
        echo "[ERROR] bc is required but not installed." >&2
        exit 1
    fi

    # Generate statistics
    local stats_json
    stats_json=$(generate_statistics "$PERIOD_DAYS")

    # Output in requested format
    case "$OUTPUT_FORMAT" in
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
