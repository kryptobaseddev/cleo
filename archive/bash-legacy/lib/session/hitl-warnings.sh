#!/bin/bash
# hitl-warnings.sh - Human-in-the-Loop Warning System
#
# LAYER: 2 (Data Layer)
# DEPENDENCIES: lock-detection.sh
# PROVIDES: generate_hitl_warnings, format_hitl_output, get_hitl_level
#
# Design: Provides HITL (Human-in-the-Loop) warnings for operations that
#         require human review or investigation. Used by analyze.sh to
#         surface concurrent operation issues and suggest interventions.
#
# Warning Levels:
#   INFO  - Informational, no action needed
#   WARN  - Review recommended
#   BLOCK - Requires human decision before proceeding

#=== SOURCE GUARD ================================================
[[ -n "${_HITL_WARNINGS_LOADED:-}" ]] && return 0
declare -r _HITL_WARNINGS_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_HITL_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source lock detection library
if [[ -f "$_HITL_LIB_DIR/session/lock-detection.sh" ]]; then
    # shellcheck source=lib/session/lock-detection.sh
    source "$_HITL_LIB_DIR/session/lock-detection.sh"
fi

# Source config library
if [[ -f "$_HITL_LIB_DIR/core/config.sh" ]]; then
    # shellcheck source=lib/core/config.sh
    source "$_HITL_LIB_DIR/core/config.sh"
fi

# ============================================================================
# CONSTANTS
# ============================================================================

# Warning levels (numeric for comparison)
HITL_LEVEL_NONE=0
HITL_LEVEL_INFO=1
HITL_LEVEL_WARN=2
HITL_LEVEL_BLOCK=3

# ============================================================================
# CONFIGURATION
# ============================================================================

#######################################
# Check if HITL warnings are enabled
#######################################
is_hitl_enabled() {
    if declare -f get_config_value >/dev/null 2>&1; then
        local enabled
        enabled=$(get_config_value "analyze.lockAwareness.enabled" "true")
        [[ "$enabled" == "true" ]]
    else
        return 0  # Enabled by default
    fi
}

#######################################
# Check if we should warn only (not block)
#######################################
is_warn_only_mode() {
    if declare -f get_config_value >/dev/null 2>&1; then
        local warn_only
        warn_only=$(get_config_value "analyze.lockAwareness.warnOnly" "true")
        [[ "$warn_only" == "true" ]]
    else
        return 0  # Warn only by default
    fi
}

# ============================================================================
# WARNING GENERATION
# ============================================================================

#######################################
# Generate HITL warnings based on lock state
# Arguments:
#   $1 - Path to .cleo directory (optional)
# Outputs:
#   JSON object with HITL warnings
#######################################
generate_hitl_warnings() {
    local cleo_dir="${1:-.cleo}"

    if ! is_hitl_enabled; then
        echo '{"enabled": false, "level": "none", "warnings": []}'
        return 0
    fi

    local lock_warnings
    lock_warnings=$(get_lock_warnings "$cleo_dir")

    local active_count stale_count orphan_count
    active_count=$(echo "$lock_warnings" | jq '.counts.active')
    stale_count=$(echo "$lock_warnings" | jq '.counts.stale')
    orphan_count=$(echo "$lock_warnings" | jq '.counts.orphaned')

    local warnings="[]"
    local max_level="none"
    local requires_human=false

    # Active concurrent operations - WARN or BLOCK
    if [[ "$active_count" -gt 0 ]]; then
        local active_locks
        active_locks=$(echo "$lock_warnings" | jq '.activeLocks')

        # Multiple active locks on same resource - BLOCK
        local resource_counts
        resource_counts=$(echo "$active_locks" | jq 'group_by(.resource) | map(select(length > 1) | {resource: .[0].resource, count: length})')
        local multi_lock_count
        multi_lock_count=$(echo "$resource_counts" | jq 'length')

        if [[ "$multi_lock_count" -gt 0 ]]; then
            max_level="block"
            requires_human=true
            warnings=$(echo "$warnings" | jq --argjson locks "$resource_counts" '
                . + [{"level": "BLOCK", "type": "MULTI_LOCK", "message": "Multiple processes locking same resource", "details": $locks, "action": "Investigate - potential race condition"}]')
        fi

        # Check for high-risk operations
        local high_risk_resources='["todo-archive.json", "sessions.json", "config.json"]'
        local high_risk_locks
        high_risk_locks=$(echo "$active_locks" | jq --argjson hr "$high_risk_resources" '
            [.[] | select(.resource as $r | $hr | index($r))]')
        local high_risk_count
        high_risk_count=$(echo "$high_risk_locks" | jq 'length')

        if [[ "$high_risk_count" -gt 0 ]]; then
            if [[ "$max_level" != "block" ]]; then
                if is_warn_only_mode; then
                    max_level="warn"
                else
                    max_level="block"
                    requires_human=true
                fi
            fi
            warnings=$(echo "$warnings" | jq --argjson locks "$high_risk_locks" '
                . + [{"level": "WARN", "type": "HIGH_RISK_OP", "message": "High-risk operation in progress", "details": $locks, "action": "Wait for completion or investigate"}]')
        fi

        # Standard concurrent operation - WARN
        if [[ "$active_count" -gt 0 ]]; then
            if [[ "$max_level" == "none" ]]; then
                max_level="warn"
            fi
            local concurrent_info
            concurrent_info=$(echo "$active_locks" | jq '
                map({resource, pid, process, age_human}) | unique')
            warnings=$(echo "$warnings" | jq --argjson info "$concurrent_info" '
                . + [{"level": "WARN", "type": "CONCURRENT", "message": "Concurrent operation detected", "details": $info, "action": "Tasks may conflict with active operations"}]')
        fi
    fi

    # Orphaned locks - WARN (indicates crashed process)
    if [[ "$orphan_count" -gt 0 ]]; then
        if [[ "$max_level" == "none" ]]; then
            max_level="warn"
        fi
        local orphan_locks
        orphan_locks=$(echo "$lock_warnings" | jq '[.allLocks[] | select(.status == "orphaned")]')
        warnings=$(echo "$warnings" | jq --argjson locks "$orphan_locks" '
            . + [{"level": "WARN", "type": "ORPHANED", "message": "Orphaned lock detected - process may have crashed", "details": $locks, "action": "Run: rm .cleo/*.lock to clean up"}]')
    fi

    # Stale locks - INFO
    if [[ "$stale_count" -gt 0 ]]; then
        if [[ "$max_level" == "none" ]]; then
            max_level="info"
        fi
        local stale_locks
        stale_locks=$(echo "$lock_warnings" | jq '[.allLocks[] | select(.status == "stale")]')
        warnings=$(echo "$warnings" | jq --argjson locks "$stale_locks" '
            . + [{"level": "INFO", "type": "STALE", "message": "Stale lock file(s) detected", "details": $locks, "action": "Can be safely removed if no operations are pending"}]')
    fi

    jq -nc \
        --arg level "$max_level" \
        --argjson warnings "$warnings" \
        --argjson requiresHuman "$requires_human" \
        --argjson enabled true \
        --argjson activeLocks "$(echo "$lock_warnings" | jq '.activeLocks')" \
        '{
            enabled: $enabled,
            level: $level,
            requiresHuman: $requiresHuman,
            warnings: $warnings,
            activeLocks: $activeLocks,
            summary: (
                if ($warnings | length) == 0 then null
                else {
                    total: ($warnings | length),
                    byLevel: {
                        block: ([$warnings[] | select(.level == "BLOCK")] | length),
                        warn: ([$warnings[] | select(.level == "WARN")] | length),
                        info: ([$warnings[] | select(.level == "INFO")] | length)
                    }
                }
                end
            )
        }'
}

#######################################
# Get highest warning level from warnings
# Arguments:
#   $1 - JSON warnings array
# Outputs:
#   Highest level: "none", "info", "warn", or "block"
#######################################
get_highest_level() {
    local warnings="$1"

    if echo "$warnings" | jq -e '.[] | select(.level == "BLOCK")' >/dev/null 2>&1; then
        echo "block"
    elif echo "$warnings" | jq -e '.[] | select(.level == "WARN")' >/dev/null 2>&1; then
        echo "warn"
    elif echo "$warnings" | jq -e '.[] | select(.level == "INFO")' >/dev/null 2>&1; then
        echo "info"
    else
        echo "none"
    fi
}

# ============================================================================
# HUMAN-READABLE FORMATTING
# ============================================================================

#######################################
# Format HITL warnings for human display
# Arguments:
#   $1 - JSON HITL warnings object
# Outputs:
#   Formatted text for terminal display
#######################################
format_hitl_output() {
    local hitl_json="$1"

    local level
    level=$(echo "$hitl_json" | jq -r '.level')

    if [[ "$level" == "none" ]]; then
        return 0
    fi

    local warnings_count
    warnings_count=$(echo "$hitl_json" | jq '.warnings | length')

    if [[ "$warnings_count" -eq 0 ]]; then
        return 0
    fi

    # Get colors if available
    local RED="" YELLOW="" CYAN="" DIM="" BOLD="" NC=""
    if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
        RED='\033[0;31m'
        YELLOW='\033[1;33m'
        CYAN='\033[0;36m'
        DIM='\033[2m'
        BOLD='\033[1m'
        NC='\033[0m'
    fi

    # Header based on highest level
    case "$level" in
        block)
            echo -e "${BOLD}${RED}⛔ HITL REQUIRED${NC}"
            ;;
        warn)
            echo -e "${BOLD}${YELLOW}⚠️  HITL WARNINGS${NC}"
            ;;
        info)
            echo -e "${BOLD}${CYAN}ℹ️  HITL INFO${NC}"
            ;;
    esac

    # Format each warning
    echo "$hitl_json" | jq -r --arg red "$RED" --arg yellow "$YELLOW" --arg cyan "$CYAN" --arg dim "$DIM" --arg nc "$NC" '
        .warnings[] |
        (if .level == "BLOCK" then "\($red)[BLOCK]\($nc)"
         elif .level == "WARN" then "\($yellow)[WARN]\($nc)"
         else "\($cyan)[INFO]\($nc)" end) as $prefix |
        "  \($prefix) \(.message)",
        "    \($dim)\(.action)\($nc)",
        (if .details then
            (.details | if type == "array" then
                .[] | "    → \(.resource // .pid // .)"
            else
                "    → \(.)"
            end)
        else empty end)
    '

    echo ""
}

#######################################
# Format concurrency section for analyze output
# Arguments:
#   $1 - Path to .cleo directory (optional)
# Outputs:
#   Formatted concurrency info for analyze
#######################################
format_concurrency_section() {
    local cleo_dir="${1:-.cleo}"

    local hitl_warnings
    hitl_warnings=$(generate_hitl_warnings "$cleo_dir")

    local level
    level=$(echo "$hitl_warnings" | jq -r '.level')

    if [[ "$level" == "none" ]]; then
        return 0
    fi

    format_hitl_output "$hitl_warnings"
}

# ============================================================================
# JSON OUTPUT FOR ANALYZE
# ============================================================================

#######################################
# Get concurrency data for analyze JSON output
# Arguments:
#   $1 - Path to .cleo directory (optional)
# Outputs:
#   JSON object for analyze output
#######################################
get_concurrency_json() {
    local cleo_dir="${1:-.cleo}"

    if ! is_hitl_enabled; then
        echo '{"enabled": false}'
        return 0
    fi

    local hitl_warnings
    hitl_warnings=$(generate_hitl_warnings "$cleo_dir")

    local level
    level=$(echo "$hitl_warnings" | jq -r '.level')

    if [[ "$level" == "none" ]]; then
        jq -nc '{
            enabled: true,
            hasWarnings: false,
            level: "none",
            activeLocks: [],
            warnings: []
        }'
        return 0
    fi

    echo "$hitl_warnings" | jq '{
        enabled: .enabled,
        hasWarnings: (.warnings | length > 0),
        level: .level,
        requiresHuman: .requiresHuman,
        activeLocks: .activeLocks,
        warnings: .warnings,
        summary: .summary
    }'
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f is_hitl_enabled
export -f is_warn_only_mode
export -f generate_hitl_warnings
export -f get_highest_level
export -f format_hitl_output
export -f format_concurrency_section
export -f get_concurrency_json
