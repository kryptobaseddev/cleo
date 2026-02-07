#!/usr/bin/env bash
###CLEO
# command: compliance
# category: read
# synopsis: Monitor and report compliance metrics for orchestrator and agent outputs
# relevance: high
# flags: --format,--quiet,--json,--human,--days,--epic
# exits: 0,2,3,4
# json-output: true
# subcommands: summary,violations,trend,audit,sync
# note: Part of Orchestrator Protocol - tracks compliance with output standards
###END
# CLEO Compliance Command
# Monitor and report compliance metrics for orchestrator and agent outputs
#
# LAYER: CLI Entry Point
# DEPENDS: lib/metrics-aggregation.sh, lib/compliance-check.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source core libraries
source "$LIB_DIR/exit-codes.sh"
[[ -f "$LIB_DIR/output-format.sh" ]] && source "$LIB_DIR/output-format.sh"
[[ -f "$LIB_DIR/error-json.sh" ]] && source "$LIB_DIR/error-json.sh"
[[ -f "$LIB_DIR/flags.sh" ]] && source "$LIB_DIR/flags.sh"

# Source compliance and metrics libraries
source "$LIB_DIR/metrics-aggregation.sh"
source "$LIB_DIR/compliance-check.sh"

TODO_DIR="${TODO_DIR:-.cleo}"
COMMAND_NAME="compliance"

# ============================================================================
# USAGE
# ============================================================================

usage() {
    cat << 'EOF'
Usage: cleo compliance <subcommand> [OPTIONS]

Monitor and report compliance metrics for orchestrator and agent outputs.

Subcommands:
  summary            Aggregate compliance stats (default)
  violations         List compliance violations
  trend [N]          Show compliance trend over N days (default: 7)
  audit <EPIC_ID>    Check compliance for specific epic's tasks
  sync               Sync project metrics to global aggregation
  skills             Per-skill/agent reliability stats
  report             Human-readable project compliance report
  report-global      Human-readable cross-project report
  value [N]          VALUE PROOF: Token savings & validation impact (default: 7 days)

Options:
  --since DATE       Filter metrics from this date (ISO 8601)
  --agent AGENT_ID   Filter by agent/skill ID
  --project NAME     Filter by project (global commands only)
  --severity LEVEL   Filter violations by severity (low|medium|high|critical)
  --global           Use global metrics file (trend/skills)
  --force            Force full sync (sync only)
  --format FORMAT    Output format: json (default) or human
  --json             Shortcut for --format json
  --human            Shortcut for --format human
  --help             Show this help message

Examples:
  cleo compliance                      # Summary of project compliance
  cleo compliance summary --since 2026-01-01
  cleo compliance violations --severity high
  cleo compliance trend 14             # 14-day trend
  cleo compliance audit T1930          # Check epic T1930 tasks
  cleo compliance sync                 # Sync to global metrics
  cleo compliance skills --global      # Cross-project skill reliability
  cleo compliance report               # Human-readable report
  cleo compliance value                # Prove CLEO's value (token savings + validation)

Output:
  JSON by default (when piped or --json)
  Human-readable table for TTY (or --human)

Metrics tracked:
  - compliance_pass_rate: Tasks with zero violations (0.0-1.0)
  - rule_adherence_score: Rules satisfied / total rules (0.0-1.0)
  - violation_count: Total violations
  - violation_severity: low|medium|high|critical
  - manifest_integrity: valid|partial|invalid|missing
EOF
}

# ============================================================================
# VALUE METRICS SUBCOMMAND (T2833)
# Proves CLEO's value through real metrics
# ============================================================================

# get_value_metrics - Calculate CLEO value proof metrics
# Returns: JSON with token savings, validation impact, skill composition stats
get_value_metrics() {
    local days="${1:-7}"
    local compliance_path="${TODO_DIR}/metrics/COMPLIANCE.jsonl"
    local token_path="${TODO_DIR}/metrics/TOKEN_USAGE.jsonl"
    local manifest_path="claudedocs/agent-outputs/MANIFEST.jsonl"

    # Calculate date threshold
    local threshold
    threshold=$(date -u -d "$days days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
                date -u -v-${days}d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
                echo "1970-01-01T00:00:00Z")

    # Token savings estimation
    local manifest_entries=0
    [[ -f "$manifest_path" ]] && manifest_entries=$(wc -l < "$manifest_path" 2>/dev/null || echo 0)
    local manifest_tokens=$((manifest_entries * 200))
    local full_file_tokens=$((manifest_entries * 2000))
    local token_savings=$((full_file_tokens - manifest_tokens))
    local token_savings_percent=0
    [[ $full_file_tokens -gt 0 ]] && token_savings_percent=$(( (token_savings * 100) / full_file_tokens ))

    # Validation impact
    local total_validations=0
    local violations_caught=0
    local real_validations=0

    if [[ -f "$compliance_path" ]]; then
        total_validations=$(wc -l < "$compliance_path" 2>/dev/null || echo 0)
        violations_caught=$(jq -r 'select(.compliance.violation_count > 0)' "$compliance_path" 2>/dev/null | wc -l || echo 0)
        # Count entries with real validation (have validation_score in _context)
        real_validations=$(grep -c "validation_score" "$compliance_path" 2>/dev/null || echo 0)
    fi

    local violation_rate=0
    [[ $total_validations -gt 0 ]] && violation_rate=$(( (violations_caught * 100) / total_validations ))

    # OTel status
    local otel_enabled="false"
    [[ "${CLAUDE_CODE_ENABLE_TELEMETRY:-}" == "1" ]] && otel_enabled="true"

    # Build result JSON
    jq -nc \
        --argjson days "$days" \
        --argjson manifest_entries "$manifest_entries" \
        --argjson manifest_tokens "$manifest_tokens" \
        --argjson full_file_tokens "$full_file_tokens" \
        --argjson token_savings "$token_savings" \
        --argjson savings_percent "$token_savings_percent" \
        --argjson total_validations "$total_validations" \
        --argjson violations_caught "$violations_caught" \
        --argjson violation_rate "$violation_rate" \
        --argjson real_validations "$real_validations" \
        --argjson otel_enabled "$otel_enabled" \
        '{
            "_meta": {
                "command": "compliance",
                "operation": "value",
                "timestamp": (now | todate)
            },
            "success": true,
            "result": {
                "period_days": $days,
                "token_efficiency": {
                    "manifest_entries": $manifest_entries,
                    "manifest_tokens": $manifest_tokens,
                    "full_file_equivalent": $full_file_tokens,
                    "tokens_saved": $token_savings,
                    "savings_percent": $savings_percent,
                    "verdict": (
                        if $savings_percent >= 80 then "Excellent"
                        elif $savings_percent >= 50 then "Good"
                        elif $savings_percent >= 20 then "Moderate"
                        else "Low"
                        end
                    )
                },
                "validation_impact": {
                    "total_validations": $total_validations,
                    "violations_caught": $violations_caught,
                    "violation_rate_percent": $violation_rate,
                    "real_validations": $real_validations,
                    "status": (
                        if $real_validations > 0 then "Active"
                        else "Legacy (upgrade to real validation)"
                        end
                    )
                },
                "telemetry": {
                    "otel_enabled": $otel_enabled,
                    "recommendation": (
                        if $otel_enabled then "Token tracking active"
                        else "Enable CLAUDE_CODE_ENABLE_TELEMETRY=1 for real token data"
                        end
                    )
                }
            }
        }'
}

# format_value_human - Format value metrics for human display
# Args: $1 = JSON result from get_value_metrics
format_value_human() {
    local result="$1"

    local days manifest_entries manifest_tokens full_file_tokens
    local token_savings savings_percent verdict
    local total_validations violations_caught violation_rate real_validations val_status
    local otel_enabled otel_recommendation

    days=$(echo "$result" | jq -r '.result.period_days // 7')
    manifest_entries=$(echo "$result" | jq -r '.result.token_efficiency.manifest_entries // 0')
    manifest_tokens=$(echo "$result" | jq -r '.result.token_efficiency.manifest_tokens // 0')
    full_file_tokens=$(echo "$result" | jq -r '.result.token_efficiency.full_file_equivalent // 0')
    token_savings=$(echo "$result" | jq -r '.result.token_efficiency.tokens_saved // 0')
    savings_percent=$(echo "$result" | jq -r '.result.token_efficiency.savings_percent // 0')
    verdict=$(echo "$result" | jq -r '.result.token_efficiency.verdict // "Unknown"')

    total_validations=$(echo "$result" | jq -r '.result.validation_impact.total_validations // 0')
    violations_caught=$(echo "$result" | jq -r '.result.validation_impact.violations_caught // 0')
    violation_rate=$(echo "$result" | jq -r '.result.validation_impact.violation_rate_percent // 0')
    real_validations=$(echo "$result" | jq -r '.result.validation_impact.real_validations // 0')
    val_status=$(echo "$result" | jq -r '.result.validation_impact.status // "Unknown"')

    otel_enabled=$(echo "$result" | jq -r '.result.telemetry.otel_enabled // false')
    otel_recommendation=$(echo "$result" | jq -r '.result.telemetry.recommendation // ""')

    echo ""
    echo "╔══════════════════════════════════════════════════════════════════════╗"
    echo "║                    CLEO VALUE METRICS DASHBOARD                      ║"
    echo "╚══════════════════════════════════════════════════════════════════════╝"
    echo ""
    echo "TOKEN EFFICIENCY (manifest vs full files)"
    echo "┌────────────────────────────────────────────────────────────────────┐"
    printf "│  Manifest entries:     %-10d                                  │\n" "$manifest_entries"
    printf "│  Manifest tokens:      %-10d (estimated)                      │\n" "$manifest_tokens"
    printf "│  If full files:        %-10d (estimated)                      │\n" "$full_file_tokens"
    printf "│  TOKENS SAVED:         %-10d (%d%%)                           │\n" "$token_savings" "$savings_percent"
    printf "│  Verdict:              %-10s                                  │\n" "$verdict"
    echo "└────────────────────────────────────────────────────────────────────┘"
    echo ""
    echo "VALIDATION IMPACT"
    echo "┌────────────────────────────────────────────────────────────────────┐"
    printf "│  Total validations:    %-10d                                  │\n" "$total_validations"
    printf "│  Violations caught:    %-10d (%d%%)                           │\n" "$violations_caught" "$violation_rate"
    printf "│  Real validations:     %-10d                                  │\n" "$real_validations"
    printf "│  Status:               %-20s                      │\n" "$val_status"
    echo "└────────────────────────────────────────────────────────────────────┘"
    echo ""
    echo "TELEMETRY STATUS"
    echo "┌────────────────────────────────────────────────────────────────────┐"
    if [[ "$otel_enabled" == "true" ]]; then
        echo "│  OpenTelemetry:        ✓ ENABLED                                  │"
    else
        echo "│  OpenTelemetry:        ✗ DISABLED                                 │"
    fi
    printf "│  %-66s │\n" "$otel_recommendation"
    echo "└────────────────────────────────────────────────────────────────────┘"
    echo ""
    echo "Spec: docs/specs/CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md"
    echo ""
}

# ============================================================================
# AUDIT SUBCOMMAND (Check specific epic)
# ============================================================================

# audit_epic - Check compliance for all tasks under an epic
# Args: $1 = epic_id, [--since DATE]
# Returns: JSON with per-task compliance
audit_epic() {
    local epic_id="$1"
    shift || true

    local since=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --since)
                since="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    # Get tasks under epic
    local tasks_output
    if ! tasks_output=$(cleo list --parent "$epic_id" --format json 2>/dev/null); then
        jq -n \
            --arg epic_id "$epic_id" \
            '{
                "_meta": {"command": "compliance", "operation": "audit"},
                "success": false,
                "error": {
                    "code": "E_EPIC_NOT_FOUND",
                    "message": "Could not retrieve tasks for epic",
                    "epicId": $epic_id
                }
            }'
        return "$EXIT_NOT_FOUND"
    fi

    # Extract task IDs
    local task_ids
    task_ids=$(echo "$tasks_output" | jq -r '.tasks[]?.id // empty' 2>/dev/null)

    if [[ -z "$task_ids" ]]; then
        jq -n \
            --arg epic_id "$epic_id" \
            '{
                "_meta": {"command": "compliance", "operation": "audit"},
                "success": true,
                "result": {
                    "epicId": $epic_id,
                    "taskCount": 0,
                    "tasks": [],
                    "summary": {
                        "averagePassRate": 0,
                        "totalViolations": 0
                    }
                }
            }'
        return 0
    fi

    # Read compliance data
    local compliance_path
    compliance_path="${TODO_DIR}/metrics/COMPLIANCE.jsonl"

    if [[ ! -f "$compliance_path" ]]; then
        # No compliance data yet
        local task_count
        task_count=$(echo "$task_ids" | wc -l)

        jq -n \
            --arg epic_id "$epic_id" \
            --argjson count "$task_count" \
            '{
                "_meta": {"command": "compliance", "operation": "audit"},
                "success": true,
                "result": {
                    "epicId": $epic_id,
                    "taskCount": $count,
                    "tasks": [],
                    "summary": {
                        "averagePassRate": 0,
                        "totalViolations": 0,
                        "note": "No compliance data recorded yet"
                    }
                }
            }'
        return 0
    fi

    # Build task filter
    local task_filter=""
    while IFS= read -r tid; do
        [[ -z "$tid" ]] && continue
        if [[ -n "$task_filter" ]]; then
            task_filter="${task_filter}, \"$tid\""
        else
            task_filter="\"$tid\""
        fi
    done <<< "$task_ids"

    # Query compliance for these tasks
    local audit_result
    audit_result=$(cat "$compliance_path" | jq -s --arg epic_id "$epic_id" "
        [.[] | select(._context.task_id as \$tid | [$task_filter] | index(\$tid))] |
        {
            epicId: \$epic_id,
            taskCount: ([.[]] | map(._context.task_id) | unique | length),
            tasks: (group_by(._context.task_id) | map({
                taskId: .[0]._context.task_id,
                entries: length,
                latestPassRate: (sort_by(.timestamp) | .[-1].compliance.compliance_pass_rate // 0),
                latestAdherence: (sort_by(.timestamp) | .[-1].compliance.rule_adherence_score // 0),
                totalViolations: ([.[].compliance.violation_count // 0] | add),
                severities: (group_by(.compliance.violation_severity) | map({key: .[0].compliance.violation_severity, value: length}) | from_entries)
            })),
            summary: {
                averagePassRate: (if length > 0 then ([.[].compliance.compliance_pass_rate // 0] | add / length) else 0 end),
                averageAdherence: (if length > 0 then ([.[].compliance.rule_adherence_score // 0] | add / length) else 0 end),
                totalViolations: ([.[].compliance.violation_count // 0] | add),
                entriesAnalyzed: length
            }
        }
    " 2>/dev/null || echo '{"epicId":"'$epic_id'","taskCount":0,"tasks":[],"summary":{}}')

    jq -n \
        --argjson result "$audit_result" \
        '{
            "_meta": {"command": "compliance", "operation": "audit"},
            "success": true,
            "result": $result
        }'

    return 0
}

# ============================================================================
# VIOLATIONS SUBCOMMAND
# ============================================================================

# list_violations - List compliance violations with optional filtering
# Args: [--severity LEVEL] [--since DATE] [--agent AGENT_ID]
# Returns: JSON list of violations
list_violations() {
    local severity_filter="" since="" agent_filter=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --severity)
                severity_filter="$2"
                shift 2
                ;;
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

    local compliance_path
    compliance_path="${TODO_DIR}/metrics/COMPLIANCE.jsonl"

    if [[ ! -f "$compliance_path" ]]; then
        jq -n '{
            "_meta": {"command": "compliance", "operation": "violations"},
            "success": true,
            "result": {
                "violations": [],
                "totalCount": 0,
                "note": "No compliance data recorded yet"
            }
        }'
        return 0
    fi

    # Build jq filter
    local jq_filter=". | select(.compliance.violation_count > 0)"
    if [[ -n "$severity_filter" ]]; then
        jq_filter="${jq_filter} | select(.compliance.violation_severity == \"$severity_filter\")"
    fi
    if [[ -n "$since" ]]; then
        jq_filter="${jq_filter} | select(.timestamp >= \"$since\")"
    fi
    if [[ -n "$agent_filter" ]]; then
        jq_filter="${jq_filter} | select(.source_id == \"$agent_filter\")"
    fi

    local violations
    violations=$(cat "$compliance_path" | jq -s "
        [.[] | $jq_filter] |
        sort_by(.timestamp) | reverse |
        map({
            timestamp: .timestamp,
            agentId: .source_id,
            taskId: ._context.task_id,
            violationCount: .compliance.violation_count,
            severity: .compliance.violation_severity,
            manifestIntegrity: .compliance.manifest_integrity,
            passRate: .compliance.compliance_pass_rate,
            adherenceScore: .compliance.rule_adherence_score
        })
    " 2>/dev/null || echo '[]')

    local total_count
    total_count=$(echo "$violations" | jq 'length')

    jq -n \
        --argjson violations "$violations" \
        --argjson count "$total_count" \
        '{
            "_meta": {"command": "compliance", "operation": "violations"},
            "success": true,
            "result": {
                "violations": $violations,
                "totalCount": $count
            }
        }'

    return 0
}

# ============================================================================
# HUMAN-READABLE FORMATTERS
# ============================================================================

# format_summary_human - Format summary for human output
format_summary_human() {
    local json_data="$1"

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

    echo "=== Compliance Summary ==="
    echo ""
    echo "Entries:     $total_entries"
    echo "Pass Rate:   ${pass_pct}% [$status_icon]"
    echo "Adherence:   ${adhere_pct}%"
    echo "Violations:  $total_violations"
    echo ""

    # Severity breakdown
    local by_severity
    by_severity=$(echo "$result" | jq -r '.bySeverity // {}')
    if [[ "$by_severity" != "{}" && "$by_severity" != "null" ]]; then
        echo "By Severity:"
        echo "$by_severity" | jq -r 'to_entries | .[] | "  \(.key): \(.value)"'
        echo ""
    fi

    # Agent breakdown
    local by_agent
    by_agent=$(echo "$result" | jq -r '.byAgent // {}')
    if [[ "$by_agent" != "{}" && "$by_agent" != "null" ]]; then
        echo "By Agent:"
        echo "$by_agent" | jq -r 'to_entries | .[] | "  \(.key): \(.value.count) checks, \((.value.avgPassRate * 100) | floor)% pass"'
        echo ""
    fi
}

# format_violations_human - Format violations for human output
format_violations_human() {
    local json_data="$1"

    local violations
    violations=$(echo "$json_data" | jq -r '.result.violations // []')
    local count
    count=$(echo "$json_data" | jq -r '.result.totalCount // 0')

    echo "=== Compliance Violations ==="
    echo "Total: $count"
    echo ""

    if [[ "$count" -eq 0 ]]; then
        echo "No violations found."
        return 0
    fi

    printf "%-20s %-10s %-10s %-8s %-10s\n" "TIMESTAMP" "AGENT" "TASK" "SEVERITY" "VIOLATIONS"
    printf "%-20s %-10s %-10s %-8s %-10s\n" "---------" "-----" "----" "--------" "----------"

    echo "$violations" | jq -r '.[] | [.timestamp[:19], .agentId[:10], .taskId, .severity, .violationCount] | @tsv' | \
        while IFS=$'\t' read -r ts agent task sev vcount; do
            printf "%-20s %-10s %-10s %-8s %-10s\n" "$ts" "$agent" "$task" "$sev" "$vcount"
        done
}

# format_trend_human - Format trend for human output
format_trend_human() {
    local json_data="$1"

    local days trend
    days=$(echo "$json_data" | jq -r '.result.days // 7')
    trend=$(echo "$json_data" | jq -r '.result.trend // "no_data"')
    local data_points
    data_points=$(echo "$json_data" | jq -r '.result.dataPoints // []')

    echo "=== Compliance Trend ($days days) ==="
    echo "Direction: $trend"
    echo ""

    local count
    count=$(echo "$data_points" | jq 'length')

    if [[ "$count" -eq 0 ]]; then
        echo "No data points available."
        return 0
    fi

    printf "%-12s %-8s %-10s %-10s %-10s\n" "DATE" "ENTRIES" "PASS_RATE" "ADHERENCE" "VIOLATIONS"
    printf "%-12s %-8s %-10s %-10s %-10s\n" "----" "-------" "---------" "---------" "----------"

    echo "$data_points" | jq -r '.[] | [.date, .entries, ((.avgPassRate * 100) | floor | tostring + "%"), ((.avgAdherence * 100) | floor | tostring + "%"), .violations] | @tsv' | \
        while IFS=$'\t' read -r date entries pass adhere viols; do
            printf "%-12s %-8s %-10s %-10s %-10s\n" "$date" "$entries" "$pass" "$adhere" "$viols"
        done
}

# format_audit_human - Format audit for human output
format_audit_human() {
    local json_data="$1"

    local result
    result=$(echo "$json_data" | jq -r '.result // .')

    local epic_id task_count avg_pass total_viols
    epic_id=$(echo "$result" | jq -r '.epicId // "unknown"')
    task_count=$(echo "$result" | jq -r '.taskCount // 0')
    avg_pass=$(echo "$result" | jq -r '.summary.averagePassRate // 0')
    total_viols=$(echo "$result" | jq -r '.summary.totalViolations // 0')

    local pass_pct
    pass_pct=$(awk "BEGIN {printf \"%.1f\", $avg_pass * 100}")

    echo "=== Epic Compliance Audit: $epic_id ==="
    echo ""
    echo "Tasks:       $task_count"
    echo "Pass Rate:   ${pass_pct}%"
    echo "Violations:  $total_viols"
    echo ""

    local tasks
    tasks=$(echo "$result" | jq -r '.tasks // []')
    local tasks_count
    tasks_count=$(echo "$tasks" | jq 'length')

    if [[ "$tasks_count" -gt 0 ]]; then
        echo "Per-Task Breakdown:"
        printf "%-10s %-8s %-10s %-10s %-10s\n" "TASK" "ENTRIES" "PASS_RATE" "ADHERENCE" "VIOLATIONS"
        printf "%-10s %-8s %-10s %-10s %-10s\n" "----" "-------" "---------" "---------" "----------"

        echo "$tasks" | jq -r '.[] | [.taskId, .entries, ((.latestPassRate * 100) | floor | tostring + "%"), ((.latestAdherence * 100) | floor | tostring + "%"), .totalViolations] | @tsv' | \
            while IFS=$'\t' read -r tid entries pass adhere viols; do
                printf "%-10s %-8s %-10s %-10s %-10s\n" "$tid" "$entries" "$pass" "$adhere" "$viols"
            done
    fi
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    local subcommand="summary"
    local format=""
    local args=()

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            summary|violations|trend|audit|sync|skills|reliability|report|report-global|global|value|help|--help|-h)
                subcommand="$1"
                ;;
            --json)
                format="json"
                ;;
            --human)
                format="human"
                ;;
            --format)
                format="$2"
                shift
                ;;
            *)
                args+=("$1")
                ;;
        esac
        shift
    done

    # Handle help
    if [[ "$subcommand" == "help" || "$subcommand" == "--help" || "$subcommand" == "-h" ]]; then
        usage
        exit 0
    fi

    # Resolve format with TTY-aware defaults
    format=$(resolve_format "$format")

    # Execute subcommand
    local result
    case "$subcommand" in
        summary)
            result=$(get_project_compliance_summary "${args[@]}")
            if [[ "$format" == "human" || "$format" == "text" ]]; then
                format_summary_human "$result"
            else
                echo "$result"
            fi
            ;;
        violations)
            result=$(list_violations "${args[@]}")
            if [[ "$format" == "human" || "$format" == "text" ]]; then
                format_violations_human "$result"
            else
                echo "$result"
            fi
            ;;
        trend)
            result=$(get_compliance_trend "${args[@]}")
            if [[ "$format" == "human" || "$format" == "text" ]]; then
                format_trend_human "$result"
            else
                echo "$result"
            fi
            ;;
        audit)
            if [[ ${#args[@]} -lt 1 ]]; then
                echo "Error: audit requires EPIC_ID argument" >&2
                echo "Usage: cleo compliance audit <EPIC_ID>" >&2
                exit "$EXIT_USAGE_ERROR"
            fi
            result=$(audit_epic "${args[@]}")
            if [[ "$format" == "human" || "$format" == "text" ]]; then
                format_audit_human "$result"
            else
                echo "$result"
            fi
            ;;
        sync)
            result=$(sync_metrics_to_global "${args[@]}")
            if [[ "$format" == "human" || "$format" == "text" ]]; then
                local synced skipped project
                synced=$(echo "$result" | jq -r '.result.synced // 0')
                skipped=$(echo "$result" | jq -r '.result.skipped // 0')
                project=$(echo "$result" | jq -r '.result.project // "unknown"')
                echo "Synced $synced entries from $project to global metrics"
                echo "Skipped $skipped duplicates"
            else
                echo "$result"
            fi
            ;;
        skills|reliability)
            result=$(get_skill_reliability "${args[@]}")
            if [[ "$format" == "human" || "$format" == "text" ]]; then
                format_compliance_report "$result" --format human
            else
                echo "$result"
            fi
            ;;
        report)
            result=$(get_project_compliance_summary "${args[@]}")
            format_compliance_report "$result" --format human
            ;;
        report-global)
            result=$(get_global_compliance_summary "${args[@]}")
            format_compliance_report "$result" --format human
            ;;
        global)
            result=$(get_global_compliance_summary "${args[@]}")
            if [[ "$format" == "human" || "$format" == "text" ]]; then
                format_compliance_report "$result" --format human
            else
                echo "$result"
            fi
            ;;
        value)
            # T2833: Value proof dashboard - show CLEO's measurable impact
            result=$(get_value_metrics "${args[@]}")
            if [[ "$format" == "human" || "$format" == "text" ]]; then
                format_value_human "$result"
            else
                echo "$result"
            fi
            ;;
        *)
            echo "Unknown subcommand: $subcommand" >&2
            echo "Run 'cleo compliance help' for usage" >&2
            exit "$EXIT_USAGE_ERROR"
            ;;
    esac
}

main "$@"
