#!/usr/bin/env bash
# metrics-enums.sh - Enum constants for CLEO metrics system
#
# LAYER: 0 (Foundation)
# DEPENDENCIES: none
# PROVIDES: SEVERITY_*, MANIFEST_INTEGRITY_*, INSTRUCTION_STABILITY_*,
#           SESSION_DEGRADATION_*, AGENT_RELIABILITY_*, METRIC_CATEGORY_*,
#           METRIC_SOURCE_*, AGGREGATION_PERIOD_*, is_valid_severity,
#           is_valid_manifest_integrity, is_valid_instruction_stability,
#           is_valid_session_degradation, is_valid_agent_reliability,
#           is_valid_metric_category, is_valid_metric_source,
#           is_valid_aggregation_period
#
# Schema reference: schemas/metrics.schema.json v1.0.0
#
# CRITICAL: All enum values MUST match schema definitions exactly.
# NO freetext allowed - all metric classifications use these enums.

#=== SOURCE GUARD ================================================
[[ -n "${_METRICS_ENUMS_SH_LOADED:-}" ]] && return 0
declare -r _METRICS_ENUMS_SH_LOADED=1

# ============================================================================
# SEVERITY ENUMS (violation_severity)
# ============================================================================
# Used for: violation_severity in compliance metrics
# Valid values: low, medium, high, critical

readonly SEVERITY_LOW="low"
readonly SEVERITY_MEDIUM="medium"
readonly SEVERITY_HIGH="high"
readonly SEVERITY_CRITICAL="critical"

# Array for validation
readonly -a SEVERITY_VALUES=(
    "$SEVERITY_LOW"
    "$SEVERITY_MEDIUM"
    "$SEVERITY_HIGH"
    "$SEVERITY_CRITICAL"
)

# ============================================================================
# MANIFEST INTEGRITY ENUMS (manifest_integrity)
# ============================================================================
# Used for: manifest_integrity in compliance metrics
# Valid values: valid, partial, invalid, missing

readonly MANIFEST_INTEGRITY_VALID="valid"
readonly MANIFEST_INTEGRITY_PARTIAL="partial"
readonly MANIFEST_INTEGRITY_INVALID="invalid"
readonly MANIFEST_INTEGRITY_MISSING="missing"

readonly -a MANIFEST_INTEGRITY_VALUES=(
    "$MANIFEST_INTEGRITY_VALID"
    "$MANIFEST_INTEGRITY_PARTIAL"
    "$MANIFEST_INTEGRITY_INVALID"
    "$MANIFEST_INTEGRITY_MISSING"
)

# ============================================================================
# INSTRUCTION STABILITY ENUMS (instruction_stability)
# ============================================================================
# Used for: instruction_stability in session metrics
# Valid values: stable, clarified, revised, unstable

readonly INSTRUCTION_STABILITY_STABLE="stable"
readonly INSTRUCTION_STABILITY_CLARIFIED="clarified"
readonly INSTRUCTION_STABILITY_REVISED="revised"
readonly INSTRUCTION_STABILITY_UNSTABLE="unstable"

readonly -a INSTRUCTION_STABILITY_VALUES=(
    "$INSTRUCTION_STABILITY_STABLE"
    "$INSTRUCTION_STABILITY_CLARIFIED"
    "$INSTRUCTION_STABILITY_REVISED"
    "$INSTRUCTION_STABILITY_UNSTABLE"
)

# ============================================================================
# SESSION DEGRADATION ENUMS (session_degradation)
# ============================================================================
# Used for: session_degradation in session metrics
# Valid values: none, mild, moderate, severe

readonly SESSION_DEGRADATION_NONE="none"
readonly SESSION_DEGRADATION_MILD="mild"
readonly SESSION_DEGRADATION_MODERATE="moderate"
readonly SESSION_DEGRADATION_SEVERE="severe"

readonly -a SESSION_DEGRADATION_VALUES=(
    "$SESSION_DEGRADATION_NONE"
    "$SESSION_DEGRADATION_MILD"
    "$SESSION_DEGRADATION_MODERATE"
    "$SESSION_DEGRADATION_SEVERE"
)

# ============================================================================
# AGENT RELIABILITY ENUMS (agent_reliability)
# ============================================================================
# Used for: agent_reliability in improvement metrics
# Valid values: high, medium, low, unreliable

readonly AGENT_RELIABILITY_HIGH="high"
readonly AGENT_RELIABILITY_MEDIUM="medium"
readonly AGENT_RELIABILITY_LOW="low"
readonly AGENT_RELIABILITY_UNRELIABLE="unreliable"

readonly -a AGENT_RELIABILITY_VALUES=(
    "$AGENT_RELIABILITY_HIGH"
    "$AGENT_RELIABILITY_MEDIUM"
    "$AGENT_RELIABILITY_LOW"
    "$AGENT_RELIABILITY_UNRELIABLE"
)

# ============================================================================
# METRIC CATEGORY ENUMS (category)
# ============================================================================
# Used for: category field in metric entries
# Valid values: compliance, efficiency, session, improvement

readonly METRIC_CATEGORY_COMPLIANCE="compliance"
readonly METRIC_CATEGORY_EFFICIENCY="efficiency"
readonly METRIC_CATEGORY_SESSION="session"
readonly METRIC_CATEGORY_IMPROVEMENT="improvement"

readonly -a METRIC_CATEGORY_VALUES=(
    "$METRIC_CATEGORY_COMPLIANCE"
    "$METRIC_CATEGORY_EFFICIENCY"
    "$METRIC_CATEGORY_SESSION"
    "$METRIC_CATEGORY_IMPROVEMENT"
)

# ============================================================================
# METRIC SOURCE ENUMS (source)
# ============================================================================
# Used for: source field in metric entries
# Valid values: task, session, agent, system, orchestrator

readonly METRIC_SOURCE_TASK="task"
readonly METRIC_SOURCE_SESSION="session"
readonly METRIC_SOURCE_AGENT="agent"
readonly METRIC_SOURCE_SYSTEM="system"
readonly METRIC_SOURCE_ORCHESTRATOR="orchestrator"

readonly -a METRIC_SOURCE_VALUES=(
    "$METRIC_SOURCE_TASK"
    "$METRIC_SOURCE_SESSION"
    "$METRIC_SOURCE_AGENT"
    "$METRIC_SOURCE_SYSTEM"
    "$METRIC_SOURCE_ORCHESTRATOR"
)

# ============================================================================
# AGGREGATION PERIOD ENUMS (period)
# ============================================================================
# Used for: period field in metric entries
# Valid values: instant, hourly, daily, weekly, monthly

readonly AGGREGATION_PERIOD_INSTANT="instant"
readonly AGGREGATION_PERIOD_HOURLY="hourly"
readonly AGGREGATION_PERIOD_DAILY="daily"
readonly AGGREGATION_PERIOD_WEEKLY="weekly"
readonly AGGREGATION_PERIOD_MONTHLY="monthly"

readonly -a AGGREGATION_PERIOD_VALUES=(
    "$AGGREGATION_PERIOD_INSTANT"
    "$AGGREGATION_PERIOD_HOURLY"
    "$AGGREGATION_PERIOD_DAILY"
    "$AGGREGATION_PERIOD_WEEKLY"
    "$AGGREGATION_PERIOD_MONTHLY"
)

# ============================================================================
# VALIDATION FUNCTIONS
# ============================================================================

# is_valid_severity - Check if value is valid severity
# Usage: is_valid_severity "$value" && echo "valid"
# Returns: 0 if valid, 1 if invalid
is_valid_severity() {
    local value="$1"
    local v
    for v in "${SEVERITY_VALUES[@]}"; do
        [[ "$v" == "$value" ]] && return 0
    done
    return 1
}

# is_valid_manifest_integrity - Check if value is valid manifest integrity
# Usage: is_valid_manifest_integrity "$value" && echo "valid"
# Returns: 0 if valid, 1 if invalid
is_valid_manifest_integrity() {
    local value="$1"
    local v
    for v in "${MANIFEST_INTEGRITY_VALUES[@]}"; do
        [[ "$v" == "$value" ]] && return 0
    done
    return 1
}

# is_valid_instruction_stability - Check if value is valid instruction stability
# Usage: is_valid_instruction_stability "$value" && echo "valid"
# Returns: 0 if valid, 1 if invalid
is_valid_instruction_stability() {
    local value="$1"
    local v
    for v in "${INSTRUCTION_STABILITY_VALUES[@]}"; do
        [[ "$v" == "$value" ]] && return 0
    done
    return 1
}

# is_valid_session_degradation - Check if value is valid session degradation
# Usage: is_valid_session_degradation "$value" && echo "valid"
# Returns: 0 if valid, 1 if invalid
is_valid_session_degradation() {
    local value="$1"
    local v
    for v in "${SESSION_DEGRADATION_VALUES[@]}"; do
        [[ "$v" == "$value" ]] && return 0
    done
    return 1
}

# is_valid_agent_reliability - Check if value is valid agent reliability
# Usage: is_valid_agent_reliability "$value" && echo "valid"
# Returns: 0 if valid, 1 if invalid
is_valid_agent_reliability() {
    local value="$1"
    local v
    for v in "${AGENT_RELIABILITY_VALUES[@]}"; do
        [[ "$v" == "$value" ]] && return 0
    done
    return 1
}

# is_valid_metric_category - Check if value is valid metric category
# Usage: is_valid_metric_category "$value" && echo "valid"
# Returns: 0 if valid, 1 if invalid
is_valid_metric_category() {
    local value="$1"
    local v
    for v in "${METRIC_CATEGORY_VALUES[@]}"; do
        [[ "$v" == "$value" ]] && return 0
    done
    return 1
}

# is_valid_metric_source - Check if value is valid metric source
# Usage: is_valid_metric_source "$value" && echo "valid"
# Returns: 0 if valid, 1 if invalid
is_valid_metric_source() {
    local value="$1"
    local v
    for v in "${METRIC_SOURCE_VALUES[@]}"; do
        [[ "$v" == "$value" ]] && return 0
    done
    return 1
}

# is_valid_aggregation_period - Check if value is valid aggregation period
# Usage: is_valid_aggregation_period "$value" && echo "valid"
# Returns: 0 if valid, 1 if invalid
is_valid_aggregation_period() {
    local value="$1"
    local v
    for v in "${AGGREGATION_PERIOD_VALUES[@]}"; do
        [[ "$v" == "$value" ]] && return 0
    done
    return 1
}

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

# get_severity_values - Output all valid severity values (one per line)
get_severity_values() {
    printf '%s\n' "${SEVERITY_VALUES[@]}"
}

# get_manifest_integrity_values - Output all valid manifest integrity values
get_manifest_integrity_values() {
    printf '%s\n' "${MANIFEST_INTEGRITY_VALUES[@]}"
}

# get_instruction_stability_values - Output all valid instruction stability values
get_instruction_stability_values() {
    printf '%s\n' "${INSTRUCTION_STABILITY_VALUES[@]}"
}

# get_session_degradation_values - Output all valid session degradation values
get_session_degradation_values() {
    printf '%s\n' "${SESSION_DEGRADATION_VALUES[@]}"
}

# get_agent_reliability_values - Output all valid agent reliability values
get_agent_reliability_values() {
    printf '%s\n' "${AGENT_RELIABILITY_VALUES[@]}"
}

# get_metric_category_values - Output all valid metric category values
get_metric_category_values() {
    printf '%s\n' "${METRIC_CATEGORY_VALUES[@]}"
}

# get_metric_source_values - Output all valid metric source values
get_metric_source_values() {
    printf '%s\n' "${METRIC_SOURCE_VALUES[@]}"
}

# get_aggregation_period_values - Output all valid aggregation period values
get_aggregation_period_values() {
    printf '%s\n' "${AGGREGATION_PERIOD_VALUES[@]}"
}
