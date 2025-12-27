#!/usr/bin/env bash
# CLEO Archive Statistics/Analytics
# Generate reports and insights from archived tasks
#
# Provides detailed analytics including:
# - Summary statistics (counts, averages)
# - Phase breakdown with cycle times
# - Label breakdown with counts
# - Priority breakdown
# - Cycle time analysis with distribution
# - Archiving trends over time
#
# Version: 0.1.0 (part of cleo v0.31.0+)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source version library for proper version management
if [[ -f "$LIB_DIR/version.sh" ]]; then
    # shellcheck source=../lib/version.sh
    source "$LIB_DIR/version.sh"
fi

# Source libraries
# shellcheck source=../lib/logging.sh
source "$LIB_DIR/logging.sh"

# shellcheck source=../lib/output-format.sh
source "$LIB_DIR/output-format.sh"

# Source error JSON library (includes exit-codes.sh)
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
    # shellcheck source=../lib/error-json.sh
    source "$LIB_DIR/error-json.sh"
elif [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
    # shellcheck source=../lib/exit-codes.sh
    source "$LIB_DIR/exit-codes.sh"
fi

# File paths
ARCHIVE_FILE="${ARCHIVE_FILE:-.cleo/todo-archive.json}"
COMMAND_NAME="archive-stats"

# Options
REPORT_TYPE="summary"
SINCE_DATE=""
UNTIL_DATE=""
FORMAT=""
QUIET=false

usage() {
    cat << EOF
Usage: cleo archive-stats [OPTIONS]

Generate analytics and reports from archived tasks.

Options:
  --summary           Overview statistics (default)
  --by-phase          Breakdown by project phase
  --by-label          Breakdown by label
  --by-priority       Breakdown by priority
  --cycle-times       Analyze task completion cycle times
  --trends            Show archiving trends over time
  --since DATE        Only include tasks archived since DATE (ISO 8601)
  --until DATE        Only include tasks archived until DATE (ISO 8601)
  -f, --format FMT    Output format: text, json, csv (default: auto-detect)
  --human             Force human-readable text output
  --json              Force JSON output
  -q, --quiet         Suppress decorative output
  -h, --help          Show this help

Report Types:
  summary      Total counts, status breakdown, average cycle time, date ranges
  by-phase     Count and average cycle time per phase
  by-label     Count per label (sorted by frequency)
  by-priority  Count per priority level
  cycle-times  Min/max/avg/median cycle times with distribution buckets
  trends       Archive activity by week/month

Date Filtering:
  --since and --until accept ISO 8601 dates (YYYY-MM-DD or full timestamp)
  Tasks are filtered by their archivedAt timestamp

Examples:
  cleo archive-stats                    # Summary statistics
  cleo archive-stats --by-phase         # Phase breakdown
  cleo archive-stats --cycle-times      # Cycle time analysis
  cleo archive-stats --trends --json    # Trend data as JSON
  cleo archive-stats --since 2025-01-01 # Tasks archived in 2025

JSON Output Structure:
  {
    "\$schema": "...",
    "_meta": { "version": "...", "command": "archive-stats", ... },
    "success": true,
    "report": "summary|by-phase|by-label|by-priority|cycle-times|trends",
    "data": { ... },
    "generatedAt": "timestamp"
  }
EOF
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --summary)     REPORT_TYPE="summary"; shift ;;
        --by-phase)    REPORT_TYPE="by-phase"; shift ;;
        --by-label)    REPORT_TYPE="by-label"; shift ;;
        --by-priority) REPORT_TYPE="by-priority"; shift ;;
        --cycle-times) REPORT_TYPE="cycle-times"; shift ;;
        --trends)      REPORT_TYPE="trends"; shift ;;
        --since)       SINCE_DATE="$2"; shift 2 ;;
        --until)       UNTIL_DATE="$2"; shift 2 ;;
        -f|--format)   FORMAT="$2"; shift 2 ;;
        --human)       FORMAT="text"; shift ;;
        --json)        FORMAT="json"; shift ;;
        -q|--quiet)    QUIET=true; shift ;;
        -h|--help)     usage ;;
        -*)
            echo "[ERROR] Unknown option: $1" >&2
            exit "${EXIT_INVALID_INPUT:-1}"
            ;;
        *) shift ;;
    esac
done

# Resolve output format (CLI > env > config > JSON default)
if declare -f resolve_format >/dev/null 2>&1; then
    FORMAT=$(resolve_format "$FORMAT")
else
    FORMAT="${FORMAT:-json}"
fi

# Check jq dependency
if ! command -v jq &>/dev/null; then
    if [[ "$FORMAT" == "json" ]]; then
        echo '{"success":false,"error":{"code":"E_DEPENDENCY_MISSING","message":"jq is required but not installed"}}'
    else
        echo "[ERROR] jq is required but not installed" >&2
    fi
    exit "${EXIT_DEPENDENCY_ERROR:-5}"
fi

# Check archive file exists
if [[ ! -f "$ARCHIVE_FILE" ]]; then
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    if [[ "$FORMAT" == "json" ]]; then
        jq -n \
            --arg ts "$TIMESTAMP" \
            --arg ver "${CLEO_VERSION:-$(get_version 2>/dev/null || echo unknown)}" \
            --arg report "$REPORT_TYPE" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {"format": "json", "command": "archive-stats", "timestamp": $ts, "version": $ver},
                "success": true,
                "report": $report,
                "data": {"totalArchived": 0, "message": "No archive file found"},
                "generatedAt": $ts
            }'
    else
        echo "[INFO] No archive file found. No archived tasks to analyze."
    fi
    exit "${EXIT_SUCCESS:-0}"
fi

# Normalize date for comparison
# Date-only format (YYYY-MM-DD) needs time component for proper ISO string comparison
normalize_date_for_compare() {
    local date="$1"
    local mode="$2"  # "since" or "until"

    # If already has time component (contains T), use as-is
    if [[ "$date" == *"T"* ]]; then
        echo "$date"
    else
        # Date-only: append time based on mode
        if [[ "$mode" == "since" ]]; then
            echo "${date}T00:00:00Z"  # Start of day
        else
            echo "${date}T23:59:59Z"  # End of day
        fi
    fi
}

# Build date filter for jq
build_date_filter() {
    local filter=""
    if [[ -n "$SINCE_DATE" ]]; then
        local normalized_since
        normalized_since=$(normalize_date_for_compare "$SINCE_DATE" "since")
        filter="select(._archive.archivedAt >= \"$normalized_since\")"
    fi
    if [[ -n "$UNTIL_DATE" ]]; then
        local normalized_until
        normalized_until=$(normalize_date_for_compare "$UNTIL_DATE" "until")
        if [[ -n "$filter" ]]; then
            filter="$filter | select(._archive.archivedAt <= \"$normalized_until\")"
        else
            filter="select(._archive.archivedAt <= \"$normalized_until\")"
        fi
    fi
    echo "$filter"
}

DATE_FILTER=$(build_date_filter)

# Apply date filter to get filtered tasks
if [[ -n "$DATE_FILTER" ]]; then
    FILTERED_TASKS=$(jq --arg filter "$DATE_FILTER" "[.archivedTasks[] | $DATE_FILTER]" "$ARCHIVE_FILE")
else
    FILTERED_TASKS=$(jq '.archivedTasks' "$ARCHIVE_FILE")
fi

# Summary statistics
summary_stats() {
    echo "$FILTERED_TASKS" | jq '
        . as $tasks |
        {
            totalArchived: ($tasks | length),
            byStatus: (
                $tasks | group_by(.status) |
                map({key: .[0].status, value: length}) |
                from_entries
            ),
            byPriority: (
                $tasks | group_by(.priority) |
                map({key: (.[0].priority // "unset"), value: length}) |
                from_entries
            ),
            averageCycleTime: (
                [$tasks[] | ._archive.cycleTimeDays // empty] |
                if length > 0 then (add / length | . * 100 | floor / 100) else null end
            ),
            oldestArchived: (
                if ($tasks | length) > 0 then
                    ($tasks | sort_by(._archive.archivedAt) | first | ._archive.archivedAt)
                else null end
            ),
            newestArchived: (
                if ($tasks | length) > 0 then
                    ($tasks | sort_by(._archive.archivedAt) | last | ._archive.archivedAt)
                else null end
            ),
            archiveSourceBreakdown: (
                [$tasks[] | {source: (._archive.archiveSource // "unknown")}] |
                group_by(.source) |
                map({key: .[0].source, value: length}) |
                from_entries
            )
        }
    '
}

# Phase breakdown
by_phase_stats() {
    echo "$FILTERED_TASKS" | jq '
        group_by(.phase) |
        map({
            phase: (.[0].phase // "unassigned"),
            count: length,
            avgCycleTime: (
                [.[] | ._archive.cycleTimeDays // empty] |
                if length > 0 then (add / length | . * 100 | floor / 100) else null end
            ),
            priorities: (
                group_by(.priority) |
                map({key: (.[0].priority // "unset"), value: length}) |
                from_entries
            )
        }) |
        sort_by(-.count)
    '
}

# Label breakdown
by_label_stats() {
    echo "$FILTERED_TASKS" | jq '
        [.[] | .labels // [] | .[]] |
        group_by(.) |
        map({
            label: .[0],
            count: length
        }) |
        sort_by(-.count)
    '
}

# Priority breakdown
by_priority_stats() {
    echo "$FILTERED_TASKS" | jq '
        group_by(.priority) |
        map({
            priority: (.[0].priority // "unset"),
            count: length,
            avgCycleTime: (
                [.[] | ._archive.cycleTimeDays // empty] |
                if length > 0 then (add / length | . * 100 | floor / 100) else null end
            ),
            phases: (
                group_by(.phase) |
                map({key: (.[0].phase // "unassigned"), value: length}) |
                from_entries
            )
        }) |
        sort_by(
            if .priority == "critical" then 0
            elif .priority == "high" then 1
            elif .priority == "medium" then 2
            elif .priority == "low" then 3
            else 4 end
        )
    '
}

# Cycle time analysis
cycle_time_stats() {
    echo "$FILTERED_TASKS" | jq '
        [.[] | select(._archive.cycleTimeDays != null) | ._archive.cycleTimeDays] as $times |
        if ($times | length) == 0 then
            {
                count: 0,
                min: null,
                max: null,
                avg: null,
                median: null,
                distribution: {
                    "0-1 days": 0,
                    "2-7 days": 0,
                    "8-30 days": 0,
                    "30+ days": 0
                }
            }
        else
            ($times | sort) as $sorted |
            {
                count: ($times | length),
                min: ($times | min),
                max: ($times | max),
                avg: (($times | add) / ($times | length) | . * 100 | floor / 100),
                median: (
                    if ($sorted | length) == 0 then null
                    elif ($sorted | length) % 2 == 0 then
                        (($sorted[($sorted | length) / 2 - 1] + $sorted[($sorted | length) / 2]) / 2)
                    else
                        $sorted[(($sorted | length) - 1) / 2]
                    end
                ),
                distribution: {
                    "0-1 days": ([$times[] | select(. <= 1)] | length),
                    "2-7 days": ([$times[] | select(. > 1 and . <= 7)] | length),
                    "8-30 days": ([$times[] | select(. > 7 and . <= 30)] | length),
                    "30+ days": ([$times[] | select(. > 30)] | length)
                },
                percentiles: {
                    p25: ($sorted[(($sorted | length) * 0.25) | floor] // null),
                    p50: ($sorted[(($sorted | length) * 0.50) | floor] // null),
                    p75: ($sorted[(($sorted | length) * 0.75) | floor] // null),
                    p90: ($sorted[(($sorted | length) * 0.90) | floor] // null)
                }
            }
        end
    '
}

# Trends over time
trends_stats() {
    echo "$FILTERED_TASKS" | jq '
        # Group by week (ISO week)
        [.[] | select(._archive.archivedAt != null)] |
        group_by(._archive.archivedAt | .[0:10]) |
        map({
            date: .[0]._archive.archivedAt[0:10],
            count: length
        }) |
        sort_by(.date) |

        # Also compute monthly aggregation
        . as $daily |
        {
            byDay: $daily,
            byMonth: (
                $daily |
                group_by(.date[0:7]) |
                map({
                    month: .[0].date[0:7],
                    count: (map(.count) | add)
                })
            ),
            totalPeriod: ($daily | map(.count) | add // 0),
            averagePerDay: (
                if ($daily | length) > 0 then
                    (($daily | map(.count) | add) / ($daily | length) | . * 100 | floor / 100)
                else 0 end
            )
        }
    '
}

# Generate the report based on type
generate_report() {
    case "$REPORT_TYPE" in
        summary)     summary_stats ;;
        by-phase)    by_phase_stats ;;
        by-label)    by_label_stats ;;
        by-priority) by_priority_stats ;;
        cycle-times) cycle_time_stats ;;
        trends)      trends_stats ;;
        *)           summary_stats ;;
    esac
}

# Get report data
REPORT_DATA=$(generate_report)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
VERSION="${CLEO_VERSION:-$(get_version 2>/dev/null || echo unknown)}"

# Build filter info for output
FILTER_INFO="null"
if [[ -n "$SINCE_DATE" || -n "$UNTIL_DATE" ]]; then
    FILTER_INFO=$(jq -n \
        --arg since "${SINCE_DATE:-null}" \
        --arg until "${UNTIL_DATE:-null}" \
        '{since: (if $since == "null" then null else $since end), until: (if $until == "null" then null else $until end)}')
fi

# Output based on format
if [[ "$FORMAT" == "json" ]]; then
    jq -n \
        --arg ts "$TIMESTAMP" \
        --arg ver "$VERSION" \
        --arg report "$REPORT_TYPE" \
        --argjson data "$REPORT_DATA" \
        --argjson filters "$FILTER_INFO" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {"format": "json", "command": "archive-stats", "timestamp": $ts, "version": $ver},
            "success": true,
            "report": $report,
            "filters": $filters,
            "data": $data,
            "generatedAt": $ts
        }'
elif [[ "$FORMAT" == "csv" ]]; then
    # CSV output for specific report types
    case "$REPORT_TYPE" in
        by-phase)
            echo "phase,count,avgCycleTime"
            echo "$REPORT_DATA" | jq -r '.[] | [.phase, .count, (.avgCycleTime // "")] | @csv'
            ;;
        by-label)
            echo "label,count"
            echo "$REPORT_DATA" | jq -r '.[] | [.label, .count] | @csv'
            ;;
        by-priority)
            echo "priority,count,avgCycleTime"
            echo "$REPORT_DATA" | jq -r '.[] | [.priority, .count, (.avgCycleTime // "")] | @csv'
            ;;
        trends)
            echo "date,count"
            echo "$REPORT_DATA" | jq -r '.byDay[] | [.date, .count] | @csv'
            ;;
        *)
            # Summary doesn't translate well to CSV, output as JSON
            echo "$REPORT_DATA" | jq '.'
            ;;
    esac
else
    # Text output

    # Detect Unicode support
    unicode_enabled=false
    if detect_unicode_support 2>/dev/null; then
        unicode_enabled=true
    fi

    # Section headers
    if [[ "$unicode_enabled" == true ]]; then
        ICON_STATS="📊"
        ICON_PHASE="📁"
        ICON_LABEL="🏷️"
        ICON_PRIORITY="🎯"
        ICON_CYCLE="⏱️"
        ICON_TREND="📈"
    else
        ICON_STATS="[STATS]"
        ICON_PHASE="[PHASE]"
        ICON_LABEL="[LABEL]"
        ICON_PRIORITY="[PRIORITY]"
        ICON_CYCLE="[CYCLE]"
        ICON_TREND="[TREND]"
    fi

    if [[ "$QUIET" != true ]]; then
        echo "================================================"
        echo "$ICON_STATS ARCHIVE ANALYTICS: ${REPORT_TYPE^^}"
        echo "================================================"
        echo ""
    fi

    case "$REPORT_TYPE" in
        summary)
            total=$(echo "$REPORT_DATA" | jq -r '.totalArchived')
            avg_cycle=$(echo "$REPORT_DATA" | jq -r '.averageCycleTime // "N/A"')
            oldest=$(echo "$REPORT_DATA" | jq -r '.oldestArchived // "N/A"')
            newest=$(echo "$REPORT_DATA" | jq -r '.newestArchived // "N/A"')

            echo "Total Archived Tasks: $total"
            echo "Average Cycle Time:   ${avg_cycle} days"
            echo "Oldest Archive:       $oldest"
            echo "Newest Archive:       $newest"
            echo ""
            echo "By Status:"
            echo "$REPORT_DATA" | jq -r '.byStatus | to_entries[] | "  \(.key): \(.value)"'
            echo ""
            echo "By Priority:"
            echo "$REPORT_DATA" | jq -r '.byPriority | to_entries[] | "  \(.key): \(.value)"'
            echo ""
            echo "By Archive Source:"
            echo "$REPORT_DATA" | jq -r '.archiveSourceBreakdown | to_entries[] | "  \(.key): \(.value)"'
            ;;

        by-phase)
            echo "$ICON_PHASE Phase Breakdown:"
            echo ""
            printf "%-20s %8s %12s\n" "Phase" "Count" "Avg Cycle"
            echo "----------------------------------------"
            echo "$REPORT_DATA" | jq -r '.[] | [.phase, .count, (.avgCycleTime // "N/A" | tostring)] | @tsv' | \
                while IFS=$'\t' read -r phase count avg; do
                    printf "%-20s %8s %12s\n" "$phase" "$count" "${avg} days"
                done
            ;;

        by-label)
            echo "$ICON_LABEL Label Breakdown:"
            echo ""
            printf "%-30s %8s\n" "Label" "Count"
            echo "----------------------------------------"
            echo "$REPORT_DATA" | jq -r '.[] | [.label, .count] | @tsv' | \
                while IFS=$'\t' read -r label count; do
                    printf "%-30s %8s\n" "$label" "$count"
                done
            ;;

        by-priority)
            echo "$ICON_PRIORITY Priority Breakdown:"
            echo ""
            printf "%-12s %8s %12s\n" "Priority" "Count" "Avg Cycle"
            echo "----------------------------------------"
            echo "$REPORT_DATA" | jq -r '.[] | [.priority, .count, (.avgCycleTime // "N/A" | tostring)] | @tsv' | \
                while IFS=$'\t' read -r priority count avg; do
                    printf "%-12s %8s %12s\n" "$priority" "$count" "${avg} days"
                done
            ;;

        cycle-times)
            echo "$ICON_CYCLE Cycle Time Analysis:"
            echo ""
            ct_count=$(echo "$REPORT_DATA" | jq -r '.count')
            ct_min=$(echo "$REPORT_DATA" | jq -r '.min // "N/A"')
            ct_max=$(echo "$REPORT_DATA" | jq -r '.max // "N/A"')
            ct_avg=$(echo "$REPORT_DATA" | jq -r '.avg // "N/A"')
            ct_median=$(echo "$REPORT_DATA" | jq -r '.median // "N/A"')

            echo "Tasks with cycle time data: $ct_count"
            echo ""
            echo "Statistics (in days):"
            echo "  Minimum:  $ct_min"
            echo "  Maximum:  $ct_max"
            echo "  Average:  $ct_avg"
            echo "  Median:   $ct_median"
            echo ""
            echo "Distribution:"
            echo "  0-1 days:   $(echo "$REPORT_DATA" | jq -r '.distribution["0-1 days"]')"
            echo "  2-7 days:   $(echo "$REPORT_DATA" | jq -r '.distribution["2-7 days"]')"
            echo "  8-30 days:  $(echo "$REPORT_DATA" | jq -r '.distribution["8-30 days"]')"
            echo "  30+ days:   $(echo "$REPORT_DATA" | jq -r '.distribution["30+ days"]')"

            if [[ $(echo "$REPORT_DATA" | jq '.percentiles') != "null" ]]; then
                echo ""
                echo "Percentiles:"
                echo "  25th: $(echo "$REPORT_DATA" | jq -r '.percentiles.p25 // "N/A"') days"
                echo "  50th: $(echo "$REPORT_DATA" | jq -r '.percentiles.p50 // "N/A"') days"
                echo "  75th: $(echo "$REPORT_DATA" | jq -r '.percentiles.p75 // "N/A"') days"
                echo "  90th: $(echo "$REPORT_DATA" | jq -r '.percentiles.p90 // "N/A"') days"
            fi
            ;;

        trends)
            echo "$ICON_TREND Archive Trends:"
            echo ""
            total_period=$(echo "$REPORT_DATA" | jq -r '.totalPeriod')
            avg_per_day=$(echo "$REPORT_DATA" | jq -r '.averagePerDay')

            echo "Total in period: $total_period tasks"
            echo "Average per day: $avg_per_day tasks"
            echo ""
            echo "By Month:"
            echo "$REPORT_DATA" | jq -r '.byMonth[] | "  \(.month): \(.count) tasks"'
            ;;
    esac

    if [[ "$QUIET" != true ]]; then
        echo ""
        echo "================================================"
        echo "Generated: $TIMESTAMP"
        if [[ -n "$SINCE_DATE" || -n "$UNTIL_DATE" ]]; then
            echo "Filters: since=${SINCE_DATE:-any} until=${UNTIL_DATE:-any}"
        fi
        echo "================================================"
    fi
fi

exit "${EXIT_SUCCESS:-0}"
