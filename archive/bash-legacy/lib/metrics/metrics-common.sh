#!/usr/bin/env bash
# metrics-common.sh - Shared metrics utilities
#
# @task T2753
# @epic T2751
# LAYER: 2 (Shared Libraries)
# PROVIDES: ensure_metrics_dir, get_compliance_path, get_violations_path,
#           get_sessions_path, iso_timestamp, iso_date, get_compliance_summary_base

#=== SOURCE GUARD ================================================
[[ -n "${_METRICS_COMMON_SH_LOADED:-}" ]] && return 0
declare -r _METRICS_COMMON_SH_LOADED=1

set -euo pipefail

# Determine library directory
_MC_LIB_DIR="${BASH_SOURCE[0]%/*}/.."
[[ "$_MC_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _MC_LIB_DIR="."

# Source dependencies
# shellcheck source=lib/core/exit-codes.sh
source "${_MC_LIB_DIR}/core/exit-codes.sh"

# ============================================================================
# DIRECTORY UTILITIES
# ============================================================================

# @task T2753
# Ensure metrics directory exists
# Consolidated from: _cc_ensure_metrics_dir, _ma_ensure_project_metrics_dir
# Args: $1 = metrics_dir (optional, default: ${CLEO_DIR:-.cleo}/metrics)
# Returns: Echoes metrics directory path
# Exit: 0 on success, E_FILE_ERROR on failure
ensure_metrics_dir() {
    local metrics_dir="${1:-${CLEO_DIR:-.cleo}/metrics}"
    if [[ ! -d "$metrics_dir" ]]; then
        if ! mkdir -p "$metrics_dir" 2>/dev/null; then
            return "$EXIT_FILE_ERROR"
        fi
    fi
    echo "$metrics_dir"
    return 0
}

# ============================================================================
# PATH UTILITIES
# ============================================================================

# @task T2753
# Get compliance log path
# Consolidated from: _cc_get_compliance_path, _ma_get_project_compliance_path
# Args: $1 = metrics_dir (optional, default: ${CLEO_DIR:-.cleo}/metrics)
get_compliance_path() {
    local metrics_dir="${1:-${CLEO_DIR:-.cleo}/metrics}"
    echo "${metrics_dir}/COMPLIANCE.jsonl"
}

# @task T2753
# Get violations log path
# Args: $1 = metrics_dir (optional, default: ${CLEO_DIR:-.cleo}/metrics)
get_violations_path() {
    local metrics_dir="${1:-${CLEO_DIR:-.cleo}/metrics}"
    echo "${metrics_dir}/PROTOCOL_VIOLATIONS.jsonl"
}

# @task T2753
# Get sessions log path
# Args: $1 = metrics_dir (optional, default: ${CLEO_DIR:-.cleo}/metrics)
get_sessions_path() {
    local metrics_dir="${1:-${CLEO_DIR:-.cleo}/metrics}"
    echo "${metrics_dir}/SESSIONS.jsonl"
}

# ============================================================================
# TIMESTAMP UTILITIES
# ============================================================================

# @task T2753
# Generate ISO 8601 timestamp
# Consolidated from: _cc_iso_timestamp, _ma_iso_timestamp
iso_timestamp() {
    date -u +%Y-%m-%dT%H:%M:%SZ
}

# @task T2753
# Generate ISO 8601 date only
iso_date() {
    date -u +%Y-%m-%d
}

# ============================================================================
# SUMMARY UTILITIES
# ============================================================================

# @task T2753
# Get compliance summary from log file
# Consolidated from: get_compliance_summary (compliance-check.sh)
# Args: $1 = compliance_path (optional, uses default if not provided)
# Returns: JSON summary {total, pass, fail, rate}
get_compliance_summary_base() {
    local compliance_path="${1:-$(get_compliance_path)}"

    if [[ ! -f "$compliance_path" ]]; then
        jq -n '{total: 0, pass: 0, fail: 0, rate: 0}'
        return 0
    fi

    local total pass fail rate
    total=$(wc -l < "$compliance_path" | tr -d ' ')
    pass=$(grep -c '"compliance_pass_rate":1' "$compliance_path" 2>/dev/null || echo 0)
    fail=$((total - pass))

    if [[ $total -gt 0 ]]; then
        rate=$(echo "scale=2; $pass * 100 / $total" | bc)
    else
        rate=0
    fi

    jq -n \
        --argjson total "$total" \
        --argjson pass "$pass" \
        --argjson fail "$fail" \
        --argjson rate "$rate" \
        '{total: $total, pass: $pass, fail: $fail, rate: $rate}'
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f ensure_metrics_dir
export -f get_compliance_path
export -f get_violations_path
export -f get_sessions_path
export -f iso_timestamp
export -f iso_date
export -f get_compliance_summary_base
