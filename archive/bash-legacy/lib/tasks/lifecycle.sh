#!/usr/bin/env bash
# lifecycle.sh - Lifecycle gate enforcement for RCSD→IVTR pipeline
#
# LAYER: 1 (Core Infrastructure)
# DEPENDENCIES: exit-codes.sh, config.sh, verification.sh
# PROVIDES: check_lifecycle_gate, enforce_release_gates, get_lifecycle_state,
#           validate_lifecycle_transition, get_lifecycle_history
#
# RCSD→IVTR Pipeline:
#   research → consensus → specification → decomposition →
#   implementation → validation → testing → release
#
# Lifecycle gate enforcement ensures proper progression through states
# and blocks release until all validation gates passed.

#=== SOURCE GUARD ================================================
[[ -n "${_LIFECYCLE_SH_LOADED:-}" ]] && return 0
declare -r _LIFECYCLE_SH_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_LIFECYCLE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source exit codes (required)
if [[ -f "$_LIFECYCLE_LIB_DIR/core/exit-codes.sh" ]]; then
    source "$_LIFECYCLE_LIB_DIR/core/exit-codes.sh"
fi

# Source config (required)
if [[ -f "$_LIFECYCLE_LIB_DIR/core/config.sh" ]]; then
    source "$_LIFECYCLE_LIB_DIR/core/config.sh"
fi

# Source verification (required for gate checking)
if [[ -f "$_LIFECYCLE_LIB_DIR/validation/verification.sh" ]]; then
    source "$_LIFECYCLE_LIB_DIR/validation/verification.sh"
fi

# ============================================================================
# CONSTANTS
# ============================================================================

# Lifecycle states in dependency order (RCSD→IVTR)
readonly LIFECYCLE_STATES=(
    "research"
    "consensus"
    "specification"
    "decomposition"
    "implementation"
    "validation"
    "testing"
    "release"
)

# Exit codes for lifecycle violations (from T2575 spec)
# Note: These are defined in exit-codes.sh, we just reference them here
# UPDATED: Moved from 75-79 to 80-84 to avoid conflict with Nexus codes (70-79)
: "${EXIT_LIFECYCLE_GATE_FAILED:=80}"
: "${EXIT_AUDIT_MISSING:=81}"
: "${EXIT_CIRCULAR_VALIDATION:=82}"
: "${EXIT_LIFECYCLE_TRANSITION_INVALID:=83}"
: "${EXIT_PROVENANCE_REQUIRED:=84}"

# ============================================================================
# LIFECYCLE STATE FUNCTIONS
# ============================================================================

# Get current lifecycle state for a task
# Args: $1 = task JSON object
# Returns: 0 on success
# Outputs: lifecycle state string or "null"
get_lifecycle_state() {
    local task_json="$1"

    echo "$task_json" | jq -r '.lifecycleState // null'
}

# Validate lifecycle state is in valid set
# Args: $1 = lifecycle state
# Returns: 0 if valid, 1 if invalid
validate_lifecycle_state() {
    local state="$1"

    # null is valid (for legacy/user tasks)
    if [[ -z "$state" || "$state" == "null" ]]; then
        return 0
    fi

    for valid_state in "${LIFECYCLE_STATES[@]}"; do
        if [[ "$state" == "$valid_state" ]]; then
            return 0
        fi
    done

    return 1
}

# Get index of lifecycle state (0-based)
# Args: $1 = lifecycle state
# Returns: 0 on success, 1 if not found
# Outputs: index number
get_lifecycle_index() {
    local state="$1"
    local index=0

    for lifecycle_state in "${LIFECYCLE_STATES[@]}"; do
        if [[ "$lifecycle_state" == "$state" ]]; then
            echo "$index"
            return 0
        fi
        ((index++))
    done

    return 1
}

# Check if transition from state A to state B is valid
# Args: $1 = from state (or null)
#       $2 = to state
# Returns: 0 if valid, EXIT_LIFECYCLE_TRANSITION_INVALID if invalid
validate_lifecycle_transition() {
    local from_state="$1"
    local to_state="$2"

    # Validate target state
    if ! validate_lifecycle_state "$to_state"; then
        return "$EXIT_LIFECYCLE_TRANSITION_INVALID"
    fi

    # null → any state is allowed (initial state)
    if [[ -z "$from_state" || "$from_state" == "null" ]]; then
        return 0
    fi

    # Get indices
    local from_index
    local to_index
    from_index=$(get_lifecycle_index "$from_state") || return "$EXIT_LIFECYCLE_TRANSITION_INVALID"
    to_index=$(get_lifecycle_index "$to_state") || return "$EXIT_LIFECYCLE_TRANSITION_INVALID"

    # Forward transitions are allowed
    if [[ "$to_index" -gt "$from_index" ]]; then
        return 0
    fi

    # Backward transitions are blocked (hard fail per T2575 spec)
    return "$EXIT_LIFECYCLE_TRANSITION_INVALID"
}

# ============================================================================
# LIFECYCLE ENFORCEMENT MODE
# ============================================================================

# @task T2718
# Get lifecycle enforcement mode from config
# Returns: 0 on success
# Outputs: Mode string (strict|advisory|off)
get_lifecycle_enforcement_mode() {
    local config_path=".cleo/config.json"

    if [[ ! -f "$config_path" ]]; then
        echo "strict"  # Default
        return 0
    fi

    local mode
    mode=$(jq -r '.lifecycleEnforcement.mode // "strict"' "$config_path" 2>/dev/null)

    # Validate mode
    case "$mode" in
        strict|advisory|off)
            echo "$mode"
            ;;
        *)
            echo "strict"  # Default on invalid
            ;;
    esac

    return 0
}
export -f get_lifecycle_enforcement_mode

# @task T2718
_lifecycle_debug() {
    [[ -n "${LIFECYCLE_DEBUG:-}" ]] && echo "[lifecycle] DEBUG: $1" >&2
    return 0
}

_lifecycle_warn() {
    echo "[lifecycle] WARN: $1" >&2
}

# ============================================================================
# LIFECYCLE GATE ENFORCEMENT
# ============================================================================

# Check if lifecycle gate requirements are met for target state
# Args: $1 = task_id
#       $2 = target lifecycle state
#       $3 = todo_file path
# Returns: 0 if gate passed, EXIT_LIFECYCLE_GATE_FAILED if failed
check_lifecycle_gate() {
    local task_id="$1"
    local target_state="$2"
    local todo_file="$3"

    # @task T2718
    # Check enforcement mode first
    local enforcement_mode
    enforcement_mode=$(get_lifecycle_enforcement_mode)

    # If mode is off, skip all checks
    if [[ "$enforcement_mode" == "off" ]]; then
        _lifecycle_debug "Enforcement mode is OFF - skipping gate check"
        return 0
    fi

    # Get task
    local task_json
    task_json=$(jq --arg id "$task_id" '.tasks[] | select(.id == $id)' "$todo_file")

    if [[ -z "$task_json" ]]; then
        return "${EXIT_NOT_FOUND:-4}"
    fi

    # Get current lifecycle state
    local current_state
    current_state=$(get_lifecycle_state "$task_json")

    # Validate transition is allowed
    if ! validate_lifecycle_transition "$current_state" "$target_state"; then
        return "$EXIT_LIFECYCLE_TRANSITION_INVALID"
    fi

    # Check entry gates based on target state
    case "$target_state" in
        "research")
            # No entry gate (initial state)
            return 0
            ;;
        "consensus")
            # Requires research completion
            if [[ "$current_state" == "research" ]]; then
                return 0
            fi
            ;;
        "specification")
            # Requires consensus completion
            if [[ "$current_state" == "consensus" ]]; then
                return 0
            fi
            ;;
        "decomposition")
            # Requires specification completion
            if [[ "$current_state" == "specification" ]]; then
                return 0
            fi
            ;;
        "implementation")
            # Requires decomposition completion (or specification for simple tasks)
            if [[ "$current_state" == "decomposition" || "$current_state" == "specification" ]]; then
                return 0
            fi
            ;;
        "validation")
            # Requires implementation completion
            if [[ "$current_state" == "implementation" ]]; then
                return 0
            fi
            ;;
        "testing")
            # Requires validation completion
            if [[ "$current_state" == "validation" ]]; then
                return 0
            fi
            ;;
        "release")
            # Requires testing completion AND all verification gates
            if [[ "$current_state" == "testing" ]]; then
                # Check all verification gates passed
                local verification
                verification=$(echo "$task_json" | jq -r '.verification // null')

                if [[ "$verification" != "null" ]]; then
                    if check_all_gates_passed "$verification"; then
                        return 0
                    fi
                fi
            fi
            ;;
    esac

    # @task T2718
    # Gate failed - check enforcement mode
    if [[ "$enforcement_mode" == "advisory" ]]; then
        _lifecycle_warn "Gate failed but mode is advisory - allowing spawn"
        return 0  # Allow spawn despite failure
    fi

    return "$EXIT_LIFECYCLE_GATE_FAILED"
}

# Enforce all release gates before allowing release
# Args: $1 = task_id
#       $2 = todo_file path
# Returns: 0 if all gates passed, EXIT_LIFECYCLE_GATE_FAILED if any failed
# Outputs: JSON error object on failure
enforce_release_gates() {
    local task_id="$1"
    local todo_file="$2"

    # Get task
    local task_json
    task_json=$(jq --arg id "$task_id" '.tasks[] | select(.id == $id)' "$todo_file")

    if [[ -z "$task_json" ]]; then
        return "${EXIT_NOT_FOUND:-4}"
    fi

    # Check lifecycle state is testing
    local lifecycle_state
    lifecycle_state=$(get_lifecycle_state "$task_json")

    if [[ "$lifecycle_state" != "testing" ]]; then
        if declare -f error_json >/dev/null 2>&1; then
            error_json "E_LIFECYCLE_GATE_FAILED" \
                "Release requires lifecycle state 'testing' (current: ${lifecycle_state:-null})" \
                "$EXIT_LIFECYCLE_GATE_FAILED"
        fi
        return "$EXIT_LIFECYCLE_GATE_FAILED"
    fi

    # Check all verification gates
    local verification
    verification=$(echo "$task_json" | jq -r '.verification // null')

    if [[ "$verification" == "null" ]]; then
        if declare -f error_json >/dev/null 2>&1; then
            error_json "E_LIFECYCLE_GATE_FAILED" \
                "Release requires verification object" \
                "$EXIT_LIFECYCLE_GATE_FAILED"
        fi
        return "$EXIT_LIFECYCLE_GATE_FAILED"
    fi

    # Check implemented gate
    local implemented
    implemented=$(echo "$verification" | jq -r '.gates.implemented // null')

    if [[ "$implemented" != "true" ]]; then
        if declare -f error_json >/dev/null 2>&1; then
            error_json "E_LIFECYCLE_GATE_FAILED" \
                "Release requires verification.gates.implemented=true" \
                "$EXIT_LIFECYCLE_GATE_FAILED"
        fi
        return "$EXIT_LIFECYCLE_GATE_FAILED"
    fi

    # Check validatedBy (must exist and be different from createdBy)
    local created_by
    local validated_by
    created_by=$(echo "$task_json" | jq -r '.createdBy // null')
    validated_by=$(echo "$task_json" | jq -r '.validatedBy // null')

    if [[ "$validated_by" == "null" || -z "$validated_by" ]]; then
        if declare -f error_json >/dev/null 2>&1; then
            error_json "E_LIFECYCLE_GATE_FAILED" \
                "Release requires validatedBy field" \
                "$EXIT_LIFECYCLE_GATE_FAILED"
        fi
        return "$EXIT_LIFECYCLE_GATE_FAILED"
    fi

    # Check circular validation (creator ≠ validator)
    if [[ "$created_by" == "$validated_by" ]]; then
        if declare -f error_json >/dev/null 2>&1; then
            error_json "E_CIRCULAR_VALIDATION" \
                "Release blocked: same agent created and validated (${created_by})" \
                "$EXIT_CIRCULAR_VALIDATION"
        fi
        return "$EXIT_CIRCULAR_VALIDATION"
    fi

    # Check testedBy (must exist and be different from createdBy and validatedBy)
    local tested_by
    tested_by=$(echo "$task_json" | jq -r '.testedBy // null')

    if [[ "$tested_by" == "null" || -z "$tested_by" ]]; then
        if declare -f error_json >/dev/null 2>&1; then
            error_json "E_LIFECYCLE_GATE_FAILED" \
                "Release requires testedBy field" \
                "$EXIT_LIFECYCLE_GATE_FAILED"
        fi
        return "$EXIT_LIFECYCLE_GATE_FAILED"
    fi

    # Check circular validation (tester ≠ creator ≠ validator)
    if [[ "$tested_by" == "$created_by" || "$tested_by" == "$validated_by" ]]; then
        if declare -f error_json >/dev/null 2>&1; then
            error_json "E_CIRCULAR_VALIDATION" \
                "Release blocked: tester must be different from creator and validator" \
                "$EXIT_CIRCULAR_VALIDATION"
        fi
        return "$EXIT_CIRCULAR_VALIDATION"
    fi

    # Check documented gate
    local documented
    documented=$(echo "$verification" | jq -r '.gates.documented // null')

    if [[ "$documented" != "true" ]]; then
        if declare -f error_json >/dev/null 2>&1; then
            error_json "E_LIFECYCLE_GATE_FAILED" \
                "Release requires verification.gates.documented=true" \
                "$EXIT_LIFECYCLE_GATE_FAILED"
        fi
        return "$EXIT_LIFECYCLE_GATE_FAILED"
    fi

    # All gates passed
    return 0
}

# ============================================================================
# LIFECYCLE HISTORY
# ============================================================================

# Get lifecycle transition history for a task
# Args: $1 = task JSON object
# Returns: 0 on success
# Outputs: JSON array of lifecycle transitions
get_lifecycle_history() {
    local task_json="$1"

    echo "$task_json" | jq -r '.validationHistory // []'
}

# ============================================================================
# RCSD STATE TRACKING
# ============================================================================

# @task T2716
# Get RCSD pipeline state for an epic
# Args: $1 = epic_id
# Returns: 0 on success, EXIT_NOT_FOUND if no manifest
# Outputs: JSON object with stage statuses
get_epic_rcsd_state() {
    local epic_id="$1"
    local manifest_path=".cleo/rcsd/${epic_id}/_manifest.json"

    if [[ ! -f "$manifest_path" ]]; then
        return "${EXIT_NOT_FOUND:-4}"
    fi

    jq '.status // {}' "$manifest_path"
}

# @task T2716
# Get status of a specific RCSD stage
# Args: $1 = epic_id, $2 = stage_name
# Returns: 0 on success
# Outputs: Stage state (pending|in_progress|completed|skipped|failed)
get_rcsd_stage_status() {
    local epic_id="$1"
    local stage="$2"
    local manifest_path=".cleo/rcsd/${epic_id}/_manifest.json"

    if [[ ! -f "$manifest_path" ]]; then
        echo "pending"
        return 0
    fi

    jq -r --arg stage "$stage" '.status[$stage].state // "pending"' "$manifest_path"
}

# @task T2716
# Check if prerequisite stages are completed for target stage
# Args: $1 = epic_id, $2 = target_stage (research|consensus|specification|decomposition|...)
# Returns: 0 if prerequisites met, EXIT_LIFECYCLE_GATE_FAILED if not
query_rcsd_prerequisite_status() {
    local epic_id="$1"
    local target_stage="$2"

    # Define stage order (RCSD → Implementation)
    local -a stages=("research" "consensus" "specification" "decomposition" "implementation" "validation" "testing" "release")

    # Get target index
    local target_idx=-1
    for i in "${!stages[@]}"; do
        [[ "${stages[$i]}" == "$target_stage" ]] && target_idx=$i && break
    done

    # If stage not found, fail
    if [[ $target_idx -eq -1 ]]; then
        return "${EXIT_LIFECYCLE_GATE_FAILED:-75}"
    fi

    # Check all prior stages
    local state
    for ((i=0; i<target_idx; i++)); do
        state=$(get_rcsd_stage_status "$epic_id" "${stages[$i]}")
        if [[ "$state" != "completed" && "$state" != "skipped" ]]; then
            return "${EXIT_LIFECYCLE_GATE_FAILED:-75}"
        fi
    done

    return 0
}

# @task T2716
# Record completion of an RCSD stage
# Args: $1 = epic_id, $2 = stage_name, $3 = status (completed|skipped|failed)
# Returns: 0 on success
record_rcsd_stage_completion() {
    local epic_id="$1"
    local stage="$2"
    local status="${3:-completed}"
    local manifest_path=".cleo/rcsd/${epic_id}/_manifest.json"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Ensure directory exists
    mkdir -p ".cleo/rcsd/${epic_id}"

    # Create or update manifest
    if [[ ! -f "$manifest_path" ]]; then
        # Initialize manifest
        jq -n --arg id "$epic_id" --arg stage "$stage" --arg status "$status" --arg ts "$timestamp" \
            '{taskId: $id, status: {($stage): {state: $status, completedAt: $ts}}}' > "$manifest_path"
    else
        # Update existing
        local tmp_file="${manifest_path}.tmp"
        jq --arg stage "$stage" --arg status "$status" --arg ts "$timestamp" \
            '.status[$stage] = {state: $status, completedAt: $ts}' "$manifest_path" > "$tmp_file"
        mv "$tmp_file" "$manifest_path"
    fi
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f get_lifecycle_state
export -f validate_lifecycle_state
export -f get_lifecycle_index
export -f validate_lifecycle_transition
export -f check_lifecycle_gate
export -f enforce_release_gates
export -f get_lifecycle_history
export -f get_epic_rcsd_state
export -f get_rcsd_stage_status
export -f query_rcsd_prerequisite_status
export -f record_rcsd_stage_completion
