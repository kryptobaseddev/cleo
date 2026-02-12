#!/usr/bin/env bash
# metrics-aggregation.sh - Metrics Aggregation and Global Sync Functions
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: exit-codes.sh, metrics-enums.sh, file-ops.sh
# PROVIDES: sync_metrics_to_global, get_project_compliance_summary,
#           get_global_compliance_summary, get_compliance_trend,
#           get_skill_reliability, format_compliance_report
#
# Implements project-to-global metrics aggregation for cross-project analysis.
# Project metrics: .cleo/metrics/COMPLIANCE.jsonl
# Global metrics:  ~/.cleo/metrics/GLOBAL.jsonl
#
# Schema: schemas/metrics.schema.json v1.0.0

#=== SOURCE GUARD ================================================
[[ -n "${_METRICS_AGGREGATION_SH_LOADED:-}" ]] && return 0
declare -r _METRICS_AGGREGATION_SH_LOADED=1

set -euo pipefail

# Determine library directory
_MA_LIB_DIR="${BASH_SOURCE[0]%/*}/.."
[[ "$_MA_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _MA_LIB_DIR="."

# Source dependencies
# shellcheck source=lib/core/exit-codes.sh
source "${_MA_LIB_DIR}/core/exit-codes.sh"
# shellcheck source=lib/metrics/metrics-enums.sh
source "${_MA_LIB_DIR}/metrics/metrics-enums.sh"
# shellcheck source=lib/metrics/metrics-common.sh
source "${_MA_LIB_DIR}/metrics/metrics-common.sh"
# shellcheck source=lib/data/file-ops.sh
source "${_MA_LIB_DIR}/data/file-ops.sh"
# shellcheck source=lib/core/paths.sh
source "${_MA_LIB_DIR}/core/paths.sh"
# shellcheck source=lib/core/config.sh
source "${_MA_LIB_DIR}/core/config.sh"

# ============================================================================
# CONFIGURATION
# ============================================================================

# Project-level metrics directory
_MA_PROJECT_METRICS_DIR="$(get_cleo_dir)/metrics"

# Global metrics directory
_MA_GLOBAL_METRICS_DIR="${HOME}/.cleo/metrics"

# Compliance JSONL filenames
_MA_COMPLIANCE_FILE="COMPLIANCE.jsonl"
_MA_GLOBAL_FILE="GLOBAL.jsonl"

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

# @task T2753 - Migrated common functions to metrics-common.sh
# Use ensure_metrics_dir, get_compliance_path, iso_timestamp from metrics-common.sh

# _ma_ensure_project_metrics_dir - Create project metrics directory if missing
# Returns: 0 on success, 3 on failure
_ma_ensure_project_metrics_dir() {
    ensure_metrics_dir "$_MA_PROJECT_METRICS_DIR" >/dev/null
    return $?
}

# _ma_ensure_global_metrics_dir - Create global metrics directory if missing
# Returns: 0 on success, 3 on failure
_ma_ensure_global_metrics_dir() {
    if [[ ! -d "$_MA_GLOBAL_METRICS_DIR" ]]; then
        if ! mkdir -p "$_MA_GLOBAL_METRICS_DIR" 2>/dev/null; then
            return "$EXIT_FILE_ERROR"
        fi
    fi
    return 0
}

# _ma_get_project_compliance_path - Get project compliance file path
_ma_get_project_compliance_path() {
    get_compliance_path "$_MA_PROJECT_METRICS_DIR"
}

# _ma_get_global_path - Get global metrics file path
_ma_get_global_path() {
    echo "${_MA_GLOBAL_METRICS_DIR}/${_MA_GLOBAL_FILE}"
}

# _ma_iso_timestamp - Generate ISO 8601 timestamp
_ma_iso_timestamp() {
    iso_timestamp
}

# _ma_get_project_name - Get current project name from git or directory
_ma_get_project_name() {
    local project_name
    # Try git remote
    project_name=$(git remote get-url origin 2>/dev/null | sed 's|.*[/:]||; s|\.git$||' || true)
    # Fallback to directory name
    if [[ -z "$project_name" ]]; then
        project_name=$(basename "$(pwd)")
    fi
    echo "$project_name"
}

# _ma_generate_entry_id - Generate unique entry ID
# Args: $1 = timestamp, $2 = source_id
_ma_generate_entry_id() {
    local timestamp="$1"
    local source_id="$2"
    # Create deterministic ID from timestamp + source
    echo "${timestamp}_${source_id}" | md5sum | cut -c1-12
}

# ============================================================================
# SYNC FUNCTIONS
# ============================================================================

# sync_metrics_to_global - Sync project metrics to global aggregation file
# Args: [--force] - Sync all entries (not just new ones)
# Returns: JSON result with sync summary via stdout
# Exit codes: 0 on success, 3 on file error
#
# Deduplicates by entry ID (timestamp + source_id hash)
# Adds project field to each entry for cross-project tracking
sync_metrics_to_global() {
    local force_sync=false

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --force)
                force_sync=true
                shift
                ;;
            *)
                shift
                ;;
        esac
    done

    local project_path global_path lock_path
    project_path=$(_ma_get_project_compliance_path)
    global_path=$(_ma_get_global_path)
    lock_path="${global_path}.lock"

    # Check project file exists
    if [[ ! -f "$project_path" ]]; then
        jq -n '{
            "_meta": {"command": "metrics-aggregation", "operation": "sync"},
            "success": true,
            "result": {
                "synced": 0,
                "skipped": 0,
                "reason": "No project metrics file"
            }
        }'
        return 0
    fi

    # Ensure global directory exists
    if ! _ma_ensure_global_metrics_dir; then
        jq -n '{
            "_meta": {"command": "metrics-aggregation", "operation": "sync"},
            "success": false,
            "error": {
                "code": "E_FILE_ERROR",
                "message": "Failed to create global metrics directory"
            }
        }'
        return "$EXIT_FILE_ERROR"
    fi

    local project_name
    project_name=$(_ma_get_project_name)

    # Ensure lock file exists
    touch "$lock_path" 2>/dev/null || true

    # Sync with file lock
    local sync_result
    sync_result=$(
        flock -x 200

        # Get existing entry IDs from global file
        local existing_ids=""
        if [[ -f "$global_path" ]]; then
            existing_ids=$(jq -r '
                if .timestamp and .source_id then
                    "\(.timestamp)_\(.source_id)"
                else
                    empty
                end
            ' "$global_path" 2>/dev/null | sort -u || true)
        fi

        local synced=0
        local skipped=0

        # Process each project entry
        while IFS= read -r entry; do
            [[ -z "$entry" ]] && continue

            # Extract timestamp and source_id for dedup
            local ts src_id entry_key
            ts=$(echo "$entry" | jq -r '.timestamp // empty' 2>/dev/null || true)
            src_id=$(echo "$entry" | jq -r '.source_id // empty' 2>/dev/null || true)

            if [[ -z "$ts" || -z "$src_id" ]]; then
                skipped=$((skipped + 1))
                continue
            fi

            entry_key="${ts}_${src_id}"

            # Check for duplicate (unless force sync)
            if [[ "$force_sync" != "true" ]] && echo "$existing_ids" | grep -qF "$entry_key"; then
                skipped=$((skipped + 1))
                continue
            fi

            # Add project field (don't append yet - will use atomic_jsonl_append outside subshell)
            local enriched_entry
            enriched_entry=$(echo "$entry" | jq -c --arg proj "$project_name" '. + {project: $proj}')
            # Note: Cannot use atomic_jsonl_append inside flock subshell (would deadlock)
            # Must append directly here
            echo "$enriched_entry" >> "$global_path"
            synced=$((synced + 1))

        done < "$project_path"

        echo "{\"synced\": $synced, \"skipped\": $skipped}"
        exit 0
    ) 200>"$lock_path"

    local lock_exit=$?

    if [[ $lock_exit -ne 0 ]]; then
        jq -n '{
            "_meta": {"command": "metrics-aggregation", "operation": "sync"},
            "success": false,
            "error": {
                "code": "E_LOCK_FAILED",
                "message": "Failed to acquire lock for global metrics"
            }
        }'
        return 8
    fi

    # Parse sync result
    local synced skipped
    synced=$(echo "$sync_result" | jq -r '.synced // 0')
    skipped=$(echo "$sync_result" | jq -r '.skipped // 0')

    jq -n \
        --arg project "$project_name" \
        --argjson synced "$synced" \
        --argjson skipped "$skipped" \
        '{
            "_meta": {"command": "metrics-aggregation", "operation": "sync"},
            "success": true,
            "result": {
                "project": $project,
                "synced": $synced,
                "skipped": $skipped,
                "globalFile": "~/.cleo/metrics/GLOBAL.jsonl"
            }
        }'

    return 0
}

# ============================================================================
# QUERY FUNCTIONS
# ============================================================================

# get_project_compliance_summary - Get compliance summary for current project
# Args: [--since DATE] [--agent AGENT_ID] [--category CATEGORY]
# Returns: JSON summary via stdout
get_project_compliance_summary() {
    local since="" agent_filter="" category_filter=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --since)
                since="$2"
                shift 2
                ;;
            --agent)
                agent_filter="$2"
                shift 2
                ;;
            --category)
                category_filter="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    local project_path
    project_path=$(_ma_get_project_compliance_path)

    if [[ ! -f "$project_path" ]]; then
        jq -n \
            --arg project "$(_ma_get_project_name)" \
            '{
                "_meta": {"command": "metrics-aggregation", "operation": "project_summary"},
                "success": true,
                "result": {
                    "project": $project,
                    "totalEntries": 0,
                    "averagePassRate": 0,
                    "averageAdherence": 0,
                    "totalViolations": 0,
                    "bySeverity": {},
                    "byAgent": {}
                }
            }'
        return 0
    fi

    # Build jq filter
    local jq_filter="."
    if [[ -n "$since" ]]; then
        jq_filter="${jq_filter} | select(.timestamp >= \"$since\")"
    fi
    if [[ -n "$agent_filter" ]]; then
        jq_filter="${jq_filter} | select(.source_id == \"$agent_filter\")"
    fi
    if [[ -n "$category_filter" ]]; then
        jq_filter="${jq_filter} | select(.category == \"$category_filter\")"
    fi

    local summary
    summary=$(cat "$project_path" | jq -s "
        [.[] | $jq_filter] |
        {
            totalEntries: length,
            averagePassRate: (if length > 0 then ([.[].compliance.compliance_pass_rate // 0] | add / length) else 0 end),
            averageAdherence: (if length > 0 then ([.[].compliance.rule_adherence_score // 0] | add / length) else 0 end),
            totalViolations: ([.[].compliance.violation_count // 0] | add),
            bySeverity: (group_by(.compliance.violation_severity) | map({key: (.[0].compliance.violation_severity // \"unknown\"), value: length}) | from_entries),
            byAgent: (group_by(.source_id) | map({
                key: .[0].source_id,
                value: {
                    count: length,
                    avgPassRate: ([.[].compliance.compliance_pass_rate // 0] | add / length),
                    violations: ([.[].compliance.violation_count // 0] | add)
                }
            }) | from_entries),
            timeRange: {
                oldest: (if length > 0 then (sort_by(.timestamp) | .[0].timestamp) else null end),
                newest: (if length > 0 then (sort_by(.timestamp) | .[-1].timestamp) else null end)
            }
        }
    " 2>/dev/null || echo '{"totalEntries":0}')

    jq -n \
        --arg project "$(_ma_get_project_name)" \
        --argjson summary "$summary" \
        '{
            "_meta": {"command": "metrics-aggregation", "operation": "project_summary"},
            "success": true,
            "result": ({project: $project} + $summary)
        }'

    return 0
}

# get_global_compliance_summary - Get compliance summary across all projects
# Args: [--since DATE] [--project PROJECT_NAME]
# Returns: JSON summary via stdout
get_global_compliance_summary() {
    local since="" project_filter=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --since)
                since="$2"
                shift 2
                ;;
            --project)
                project_filter="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    local global_path
    global_path=$(_ma_get_global_path)

    if [[ ! -f "$global_path" ]]; then
        jq -n '{
            "_meta": {"command": "metrics-aggregation", "operation": "global_summary"},
            "success": true,
            "result": {
                "totalEntries": 0,
                "totalProjects": 0,
                "averagePassRate": 0,
                "averageAdherence": 0,
                "totalViolations": 0,
                "byProject": {},
                "bySeverity": {}
            }
        }'
        return 0
    fi

    # Build jq filter
    local jq_filter="."
    if [[ -n "$since" ]]; then
        jq_filter="${jq_filter} | select(.timestamp >= \"$since\")"
    fi
    if [[ -n "$project_filter" ]]; then
        jq_filter="${jq_filter} | select(.project == \"$project_filter\")"
    fi

    local summary
    summary=$(cat "$global_path" | jq -s "
        [.[] | $jq_filter] |
        {
            totalEntries: length,
            totalProjects: ([.[].project] | unique | length),
            averagePassRate: (if length > 0 then ([.[].compliance.compliance_pass_rate // 0] | add / length) else 0 end),
            averageAdherence: (if length > 0 then ([.[].compliance.rule_adherence_score // 0] | add / length) else 0 end),
            totalViolations: ([.[].compliance.violation_count // 0] | add),
            byProject: (group_by(.project) | map({
                key: (.[0].project // \"unknown\"),
                value: {
                    entries: length,
                    avgPassRate: ([.[].compliance.compliance_pass_rate // 0] | add / length),
                    violations: ([.[].compliance.violation_count // 0] | add)
                }
            }) | from_entries),
            bySeverity: (group_by(.compliance.violation_severity) | map({key: (.[0].compliance.violation_severity // \"unknown\"), value: length}) | from_entries),
            timeRange: {
                oldest: (if length > 0 then (sort_by(.timestamp) | .[0].timestamp) else null end),
                newest: (if length > 0 then (sort_by(.timestamp) | .[-1].timestamp) else null end)
            }
        }
    " 2>/dev/null || echo '{"totalEntries":0,"totalProjects":0}')

    jq -n \
        --argjson summary "$summary" \
        '{
            "_meta": {"command": "metrics-aggregation", "operation": "global_summary"},
            "success": true,
            "result": $summary
        }'

    return 0
}

# get_compliance_trend - Get compliance metrics trend over time
# Args: $1 = days (default 7), [--project PROJECT_NAME] [--global]
# Returns: JSON time-series via stdout
get_compliance_trend() {
    local days="${1:-7}"
    local project_filter="" use_global=false

    shift || true
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --project)
                project_filter="$2"
                shift 2
                ;;
            --global)
                use_global=true
                shift
                ;;
            *)
                shift
                ;;
        esac
    done

    local metrics_path
    if [[ "$use_global" == "true" ]]; then
        metrics_path=$(_ma_get_global_path)
    else
        metrics_path=$(_ma_get_project_compliance_path)
    fi

    if [[ ! -f "$metrics_path" ]]; then
        jq -n \
            --argjson days "$days" \
            '{
                "_meta": {"command": "metrics-aggregation", "operation": "trend"},
                "success": true,
                "result": {
                    "days": $days,
                    "dataPoints": [],
                    "trend": "no_data"
                }
            }'
        return 0
    fi

    # Calculate cutoff date
    local cutoff_date
    cutoff_date=$(date -u -d "$days days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-${days}d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "2000-01-01T00:00:00Z")

    # Build jq filter
    local jq_filter=". | select(.timestamp >= \"$cutoff_date\")"
    if [[ -n "$project_filter" ]]; then
        jq_filter="${jq_filter} | select(.project == \"$project_filter\")"
    fi

    local trend_data
    trend_data=$(cat "$metrics_path" | jq -s "
        [.[] | $jq_filter] |
        group_by(.timestamp | split(\"T\")[0]) |
        map({
            date: .[0].timestamp | split(\"T\")[0],
            entries: length,
            avgPassRate: ([.[].compliance.compliance_pass_rate // 0] | add / length),
            avgAdherence: ([.[].compliance.rule_adherence_score // 0] | add / length),
            violations: ([.[].compliance.violation_count // 0] | add)
        }) |
        sort_by(.date)
    " 2>/dev/null || echo '[]')

    # Calculate trend direction
    local trend_direction="stable"
    local data_points
    data_points=$(echo "$trend_data" | jq 'length')

    if [[ "$data_points" -ge 2 ]]; then
        local first_pass last_pass
        first_pass=$(echo "$trend_data" | jq '.[0].avgPassRate // 0')
        last_pass=$(echo "$trend_data" | jq '.[-1].avgPassRate // 0')

        local diff
        diff=$(awk "BEGIN {printf \"%.2f\", $last_pass - $first_pass}")

        if (( $(echo "$diff > 0.05" | bc -l 2>/dev/null || echo "0") )); then
            trend_direction="improving"
        elif (( $(echo "$diff < -0.05" | bc -l 2>/dev/null || echo "0") )); then
            trend_direction="declining"
        fi
    fi

    jq -n \
        --argjson days "$days" \
        --argjson dataPoints "$trend_data" \
        --arg trend "$trend_direction" \
        '{
            "_meta": {"command": "metrics-aggregation", "operation": "trend"},
            "success": true,
            "result": {
                "days": $days,
                "dataPoints": $dataPoints,
                "trend": $trend
            }
        }'

    return 0
}

# get_skill_reliability - Get reliability stats per skill/agent
# Args: [--since DATE] [--global]
# Returns: JSON with per-skill reliability metrics via stdout
get_skill_reliability() {
    local since="" use_global=false

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --since)
                since="$2"
                shift 2
                ;;
            --global)
                use_global=true
                shift
                ;;
            *)
                shift
                ;;
        esac
    done

    local metrics_path
    if [[ "$use_global" == "true" ]]; then
        metrics_path=$(_ma_get_global_path)
    else
        metrics_path=$(_ma_get_project_compliance_path)
    fi

    if [[ ! -f "$metrics_path" ]]; then
        jq -n '{
            "_meta": {"command": "metrics-aggregation", "operation": "skill_reliability"},
            "success": true,
            "result": {
                "skills": [],
                "summary": {
                    "totalSkills": 0,
                    "avgReliability": 0
                }
            }
        }'
        return 0
    fi

    # Build jq filter
    local jq_filter="."
    if [[ -n "$since" ]]; then
        jq_filter="${jq_filter} | select(.timestamp >= \"$since\")"
    fi

    local skill_stats
    skill_stats=$(cat "$metrics_path" | jq -s "
        [.[] | $jq_filter] |
        group_by(.source_id) |
        map({
            skill: .[0].source_id,
            invocations: length,
            avgPassRate: ([.[].compliance.compliance_pass_rate // 0] | add / length),
            avgAdherence: ([.[].compliance.rule_adherence_score // 0] | add / length),
            totalViolations: ([.[].compliance.violation_count // 0] | add),
            severityCounts: (group_by(.compliance.violation_severity) | map({key: (.[0].compliance.violation_severity // \"none\"), value: length}) | from_entries),
            reliability: (
                if length > 0 then
                    (([.[].compliance.compliance_pass_rate // 0] | add / length) * 0.6 +
                     ([.[].compliance.rule_adherence_score // 0] | add / length) * 0.4)
                else 0 end
            )
        }) |
        sort_by(-.reliability)
    " 2>/dev/null || echo '[]')

    local total_skills avg_reliability
    total_skills=$(echo "$skill_stats" | jq 'length')
    avg_reliability=$(echo "$skill_stats" | jq 'if length > 0 then [.[].reliability] | add / length else 0 end')

    jq -n \
        --argjson skills "$skill_stats" \
        --argjson totalSkills "$total_skills" \
        --argjson avgReliability "$avg_reliability" \
        '{
            "_meta": {"command": "metrics-aggregation", "operation": "skill_reliability"},
            "success": true,
            "result": {
                "skills": $skills,
                "summary": {
                    "totalSkills": $totalSkills,
                    "avgReliability": $avgReliability
                }
            }
        }'

    return 0
}

# ============================================================================
# REPORTING FUNCTIONS
# ============================================================================

# format_compliance_report - Format compliance data for CLI output
# Args: $1 = JSON data, [--format human|json]
# Returns: Formatted output via stdout
format_compliance_report() {
    local json_data="$1"
    local format="${2:-human}"

    shift || true
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --format)
                format="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    if [[ "$format" == "json" ]]; then
        echo "$json_data"
        return 0
    fi

    # Human-readable format
    local result
    result=$(echo "$json_data" | jq -r '.result // .')

    local total_entries avg_pass avg_adhere total_violations
    total_entries=$(echo "$result" | jq -r '.totalEntries // 0')
    avg_pass=$(echo "$result" | jq -r '.averagePassRate // 0')
    avg_adhere=$(echo "$result" | jq -r '.averageAdherence // 0')
    total_violations=$(echo "$result" | jq -r '.totalViolations // 0')

    # Format percentages
    local pass_pct adhere_pct
    pass_pct=$(awk "BEGIN {printf \"%.1f\", $avg_pass * 100}")
    adhere_pct=$(awk "BEGIN {printf \"%.1f\", $avg_adhere * 100}")

    # Status indicator
    local status_icon="+"
    if (( $(echo "$avg_pass < 0.7" | bc -l 2>/dev/null || echo "0") )); then
        status_icon="!"
    elif (( $(echo "$avg_pass < 0.9" | bc -l 2>/dev/null || echo "0") )); then
        status_icon="~"
    fi

    echo "=== Compliance Report ==="
    echo ""
    echo "Entries:     $total_entries"
    echo "Pass Rate:   ${pass_pct}% [$status_icon]"
    echo "Adherence:   ${adhere_pct}%"
    echo "Violations:  $total_violations"
    echo ""

    # Severity breakdown if present
    local by_severity
    by_severity=$(echo "$result" | jq -r '.bySeverity // {}')
    if [[ "$by_severity" != "{}" && "$by_severity" != "null" ]]; then
        echo "By Severity:"
        echo "$by_severity" | jq -r 'to_entries | .[] | "  \(.key): \(.value)"'
        echo ""
    fi

    # Project breakdown if present (global report)
    local by_project
    by_project=$(echo "$result" | jq -r '.byProject // {}')
    if [[ "$by_project" != "{}" && "$by_project" != "null" ]]; then
        echo "By Project:"
        echo "$by_project" | jq -r 'to_entries | .[] | "  \(.key): \(.value.entries) entries, \(.value.avgPassRate * 100 | floor)% pass"'
        echo ""
    fi

    # Agent breakdown if present
    local by_agent
    by_agent=$(echo "$result" | jq -r '.byAgent // {}')
    if [[ "$by_agent" != "{}" && "$by_agent" != "null" ]]; then
        echo "By Agent:"
        echo "$by_agent" | jq -r 'to_entries | .[] | "  \(.key): \(.value.count) checks, \(.value.avgPassRate * 100 | floor)% pass"'
        echo ""
    fi

    return 0
}

# ============================================================================
# SESSION METRICS FUNCTIONS (T1996)
# ============================================================================

# Session metrics JSONL file
_MA_SESSIONS_FILE="SESSIONS.jsonl"

# _ma_get_sessions_metrics_path - Get path to session metrics file
_ma_get_sessions_metrics_path() {
    echo "${_MA_PROJECT_METRICS_DIR}/${_MA_SESSIONS_FILE}"
}

# capture_session_start_metrics - Capture metrics at session start
# Args: $1 = session_id
# Returns: JSON object with start metrics
capture_session_start_metrics() {
    local session_id="$1"
    local timestamp
    timestamp=$(_ma_iso_timestamp)

    # Get current context state
    local context_state=""
    local cleo_dir
    cleo_dir=$(get_cleo_dir)
    repair_errant_context_state_paths "$cleo_dir" >/dev/null 2>&1 || true

    local context_file
    context_file=$(get_context_state_file_path "$session_id" "$cleo_dir")
    [[ ! -f "$context_file" ]] && context_file=$(get_context_state_file_path "" "$cleo_dir")

    local start_tokens=0 max_tokens=200000
    if [[ -f "$context_file" ]]; then
        start_tokens=$(jq -r '.contextWindow.currentTokens // 0' "$context_file" 2>/dev/null || echo 0)
        max_tokens=$(jq -r '.contextWindow.maxTokens // 200000' "$context_file" 2>/dev/null || echo 200000)
    fi

    jq -n \
        --arg session_id "$session_id" \
        --arg timestamp "$timestamp" \
        --argjson start_tokens "$start_tokens" \
        --argjson max_tokens "$max_tokens" \
        '{
            session_id: $session_id,
            start_timestamp: $timestamp,
            start_tokens: $start_tokens,
            max_tokens: $max_tokens
        }'
}

# capture_session_end_metrics - Capture metrics at session end
# Args: $1 = session_id, $2 = start_metrics JSON
# Returns: JSON object with end metrics and calculated efficiency
capture_session_end_metrics() {
    local session_id="$1"
    # Note: Use quoted default to avoid Bash 5.3+ brace expansion bug
    local start_metrics="${2:-'{}'}"
    local timestamp
    timestamp=$(_ma_iso_timestamp)

    # Get current context state
    local cleo_dir
    cleo_dir=$(get_cleo_dir)
    repair_errant_context_state_paths "$cleo_dir" >/dev/null 2>&1 || true

    local context_file
    context_file=$(get_context_state_file_path "$session_id" "$cleo_dir")
    [[ ! -f "$context_file" ]] && context_file=$(get_context_state_file_path "" "$cleo_dir")

    local end_tokens=0
    if [[ -f "$context_file" ]]; then
        end_tokens=$(jq -r '.contextWindow.currentTokens // 0' "$context_file" 2>/dev/null || echo 0)
    fi

    # Extract start values
    local start_tokens max_tokens start_timestamp
    start_tokens=$(echo "$start_metrics" | jq -r '.start_tokens // 0')
    max_tokens=$(echo "$start_metrics" | jq -r '.max_tokens // 200000')
    start_timestamp=$(echo "$start_metrics" | jq -r '.start_timestamp // ""')

    # Calculate tokens consumed
    local tokens_consumed=$((end_tokens - start_tokens))
    [[ "$tokens_consumed" -lt 0 ]] && tokens_consumed=0

    # Get session stats from sessions.json
    local sessions_file="${_MA_PROJECT_METRICS_DIR}/../sessions.json"
    local tasks_completed=0 focus_changes=0 suspend_count=0 resume_count=0
    if [[ -f "$sessions_file" ]]; then
        local session_stats
        session_stats=$(jq -r --arg id "$session_id" '.sessions[] | select(.id == $id) | .stats' "$sessions_file" 2>/dev/null)
        if [[ -n "$session_stats" && "$session_stats" != "null" ]]; then
            tasks_completed=$(echo "$session_stats" | jq -r '.tasksCompleted // 0')
            focus_changes=$(echo "$session_stats" | jq -r '.focusChanges // 0')
            suspend_count=$(echo "$session_stats" | jq -r '.suspendCount // 0')
            resume_count=$(echo "$session_stats" | jq -r '.resumeCount // 0')
        fi
    fi

    # Calculate efficiency metrics
    local session_efficiency_score=0 human_intervention_rate=0 context_utilization=0

    # Session efficiency: tasks_completed / (tokens_consumed / max_tokens * 10)
    # Normalized to tasks per 10% context used
    if [[ "$tokens_consumed" -gt 0 && "$max_tokens" -gt 0 ]]; then
        context_utilization=$(awk "BEGIN {printf \"%.4f\", $tokens_consumed / $max_tokens}")
        if (( $(echo "$context_utilization > 0.01" | bc -l) )); then
            session_efficiency_score=$(awk "BEGIN {printf \"%.4f\", $tasks_completed / ($context_utilization * 10)}")
        fi
    fi

    # Human intervention rate: (suspend_count + manual focus changes) / total actions
    local total_actions=$((focus_changes + suspend_count + resume_count + 1))
    human_intervention_rate=$(awk "BEGIN {printf \"%.4f\", ($suspend_count) / $total_actions}")

    jq -n \
        --arg session_id "$session_id" \
        --arg start_timestamp "$start_timestamp" \
        --arg end_timestamp "$timestamp" \
        --argjson start_tokens "$start_tokens" \
        --argjson end_tokens "$end_tokens" \
        --argjson tokens_consumed "$tokens_consumed" \
        --argjson max_tokens "$max_tokens" \
        --argjson tasks_completed "$tasks_completed" \
        --argjson focus_changes "$focus_changes" \
        --argjson suspend_count "$suspend_count" \
        --argjson resume_count "$resume_count" \
        --argjson session_efficiency_score "$session_efficiency_score" \
        --argjson human_intervention_rate "$human_intervention_rate" \
        --argjson context_utilization "$context_utilization" \
        '{
            session_id: $session_id,
            start_timestamp: $start_timestamp,
            end_timestamp: $end_timestamp,
            tokens: {
                start: $start_tokens,
                end: $end_tokens,
                consumed: $tokens_consumed,
                max: $max_tokens
            },
            stats: {
                tasks_completed: $tasks_completed,
                focus_changes: $focus_changes,
                suspend_count: $suspend_count,
                resume_count: $resume_count
            },
            efficiency: {
                session_efficiency_score: $session_efficiency_score,
                human_intervention_rate: $human_intervention_rate,
                context_utilization: $context_utilization
            }
        }'
}

# log_session_metrics - Append session metrics to SESSIONS.jsonl
# Args: $1 = JSON session metrics object
# Returns: JSON result via stdout
# @task T3152 - Applied atomic_jsonl_append for flock protection
# @epic T3147 - Manifest Bash Foundation and Protocol Updates
log_session_metrics() {
    local metrics_json="$1"
    local sessions_path

    # Ensure metrics directory exists
    if ! _ma_ensure_project_metrics_dir; then
        jq -n '{
            "_meta": {"command": "metrics-aggregation", "operation": "log_session"},
            "success": false,
            "error": {"code": "E_FILE_ERROR", "message": "Failed to create metrics directory"}
        }'
        return 3
    fi

    sessions_path=$(_ma_get_sessions_metrics_path)

    # Validate JSON input
    if ! echo "$metrics_json" | jq empty 2>/dev/null; then
        jq -n '{
            "_meta": {"command": "metrics-aggregation", "operation": "log_session"},
            "success": false,
            "error": {"code": "E_VALIDATION", "message": "Invalid JSON metrics input"}
        }'
        return 6
    fi

    # Use atomic JSONL append (handles compaction, locking, validation)
    if ! atomic_jsonl_append "$sessions_path" "$metrics_json"; then
        jq -n '{
            "_meta": {"command": "metrics-aggregation", "operation": "log_session"},
            "success": false,
            "error": {"code": "E_LOCK_FAILED", "message": "Failed to append session metrics"}
        }'
        return 8
    fi

    local session_id
    session_id=$(echo "$metrics_json" | jq -r '.session_id // "unknown"')

    jq -n \
        --arg file "$sessions_path" \
        --arg session_id "$session_id" \
        '{
            "_meta": {"command": "metrics-aggregation", "operation": "log_session"},
            "success": true,
            "result": {
                "sessionsFile": $file,
                "sessionId": $session_id,
                "action": "appended"
            }
        }'

    return 0
}

# get_session_metrics_summary - Get summary of session metrics
# Args: [--since DATE] [--agent AGENT_ID]
# Returns: JSON summary via stdout
get_session_metrics_summary() {
    local since="" agent_filter=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --since)
                since="$2"
                shift 2
                ;;
            --agent)
                agent_filter="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    local sessions_path
    sessions_path=$(_ma_get_sessions_metrics_path)

    if [[ ! -f "$sessions_path" ]]; then
        jq -n '{
            "_meta": {"command": "metrics-aggregation", "operation": "session_summary"},
            "success": true,
            "result": {
                "totalSessions": 0,
                "avgEfficiency": 0,
                "avgInterventionRate": 0,
                "totalTasksCompleted": 0,
                "totalTokensConsumed": 0
            }
        }'
        return 0
    fi

    # Build jq filter
    local jq_filter="."
    if [[ -n "$since" ]]; then
        jq_filter="${jq_filter} | select(.start_timestamp >= \"$since\")"
    fi

    local summary
    summary=$(cat "$sessions_path" | jq -s "
        [.[] | $jq_filter] |
        {
            totalSessions: length,
            avgEfficiency: (if length > 0 then ([.[].efficiency.session_efficiency_score // 0] | add / length) else 0 end),
            avgInterventionRate: (if length > 0 then ([.[].efficiency.human_intervention_rate // 0] | add / length) else 0 end),
            avgContextUtilization: (if length > 0 then ([.[].efficiency.context_utilization // 0] | add / length) else 0 end),
            totalTasksCompleted: ([.[].stats.tasks_completed // 0] | add),
            totalTokensConsumed: ([.[].tokens.consumed // 0] | add),
            avgTasksPerSession: (if length > 0 then ([.[].stats.tasks_completed // 0] | add / length) else 0 end),
            byContextUtilization: {
                low: ([.[] | select(.efficiency.context_utilization < 0.3)] | length),
                medium: ([.[] | select(.efficiency.context_utilization >= 0.3 and .efficiency.context_utilization < 0.7)] | length),
                high: ([.[] | select(.efficiency.context_utilization >= 0.7)] | length)
            }
        }
    " 2>/dev/null || echo '{"totalSessions":0}')

    jq -n \
        --argjson summary "$summary" \
        '{
            "_meta": {"command": "metrics-aggregation", "operation": "session_summary"},
            "success": true,
            "result": $summary
        }'

    return 0
}

# ============================================================================
# CLI INTEGRATION
# ============================================================================

# compliance_command - Entry point for `cleo compliance` command
# Args: subcommand [options]
# Subcommands: summary, global, trend, skills, sync, report
compliance_command() {
    local subcommand="${1:-summary}"
    shift || true

    case "$subcommand" in
        summary)
            get_project_compliance_summary "$@"
            ;;
        global)
            get_global_compliance_summary "$@"
            ;;
        trend)
            get_compliance_trend "$@"
            ;;
        skills|reliability)
            get_skill_reliability "$@"
            ;;
        sync)
            sync_metrics_to_global "$@"
            ;;
        report)
            local json_data
            json_data=$(get_project_compliance_summary "$@")
            format_compliance_report "$json_data" --format human
            ;;
        report-global)
            local json_data
            json_data=$(get_global_compliance_summary "$@")
            format_compliance_report "$json_data" --format human
            ;;
        help|--help|-h)
            echo "Usage: cleo compliance <subcommand> [options]"
            echo ""
            echo "Subcommands:"
            echo "  summary      Project compliance summary (default)"
            echo "  global       Cross-project compliance summary"
            echo "  trend [N]    Compliance trend over N days (default: 7)"
            echo "  skills       Per-skill reliability stats"
            echo "  sync         Sync project metrics to global"
            echo "  report       Human-readable project report"
            echo "  report-global Human-readable global report"
            echo ""
            echo "Options:"
            echo "  --since DATE     Filter by date"
            echo "  --agent AGENT    Filter by agent/skill"
            echo "  --project NAME   Filter by project (global only)"
            echo "  --global         Use global metrics (trend/skills)"
            echo "  --force          Force full sync (sync only)"
            ;;
        *)
            echo "Unknown subcommand: $subcommand" >&2
            echo "Use 'cleo compliance help' for usage" >&2
            return 1
            ;;
    esac
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f sync_metrics_to_global
export -f get_project_compliance_summary
export -f get_global_compliance_summary
export -f get_compliance_trend
export -f get_skill_reliability
export -f format_compliance_report
export -f compliance_command
export -f capture_session_start_metrics
export -f capture_session_end_metrics
export -f log_session_metrics
export -f get_session_metrics_summary
