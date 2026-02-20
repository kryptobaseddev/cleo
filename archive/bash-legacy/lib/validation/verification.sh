#!/usr/bin/env bash
# verification.sh - Verification gates management for cleo
#
# LAYER: 1 (Core Infrastructure)
# DEPENDENCIES: exit-codes.sh, config.sh
# PROVIDES: init_verification, update_gate, reset_downstream_gates,
#           check_all_gates_passed, set_verification_passed, get_gate_order,
#           validate_gate_name, validate_agent_name, increment_round,
#           log_failure, should_require_verification, is_verification_complete,
#           get_verification_status, compute_passed
#
# Gate Dependency Chain:
#   implemented -> testsPassed -> qaPassed -> cleanupDone -> securityPassed -> documented
#
# When a gate fails, all downstream gates reset to null.

#=== SOURCE GUARD ================================================
[[ -n "${_VERIFICATION_SH_LOADED:-}" ]] && return 0
declare -r _VERIFICATION_SH_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_VERIFICATION_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source exit codes (required)
if [[ -f "$_VERIFICATION_LIB_DIR/core/exit-codes.sh" ]]; then
    source "$_VERIFICATION_LIB_DIR/core/exit-codes.sh"
fi

# Source config (required for verification settings)
if [[ -f "$_VERIFICATION_LIB_DIR/core/config.sh" ]]; then
    source "$_VERIFICATION_LIB_DIR/core/config.sh"
fi

# ============================================================================
# CONSTANTS
# ============================================================================

# Gate names in dependency order
# When a gate fails, all gates after it in this order are reset to null
readonly VERIFICATION_GATE_ORDER=(
    "implemented"
    "testsPassed"
    "qaPassed"
    "cleanupDone"
    "securityPassed"
    "documented"
)

# Valid agent names that can set gates
readonly VERIFICATION_VALID_AGENTS=(
    "planner"
    "coder"
    "testing"
    "qa"
    "cleanup"
    "security"
    "docs"
)

# ============================================================================
# VALIDATION FUNCTIONS
# ============================================================================

# Validate gate name is in valid set
# Args: $1 = gate name
# Returns: 0 if valid, EXIT_INVALID_GATE if invalid
# Outputs: nothing on success, error message on failure
validate_gate_name() {
    local gate_name="$1"

    for valid_gate in "${VERIFICATION_GATE_ORDER[@]}"; do
        if [[ "$gate_name" == "$valid_gate" ]]; then
            return 0
        fi
    done

    return "${EXIT_INVALID_GATE:-42}"
}

# Validate agent name is in valid set
# Args: $1 = agent name
# Returns: 0 if valid, EXIT_INVALID_AGENT if invalid
validate_agent_name() {
    local agent_name="$1"

    # Allow null/empty agent
    if [[ -z "$agent_name" || "$agent_name" == "null" ]]; then
        return 0
    fi

    for valid_agent in "${VERIFICATION_VALID_AGENTS[@]}"; do
        if [[ "$agent_name" == "$valid_agent" ]]; then
            return 0
        fi
    done

    return "${EXIT_INVALID_AGENT:-43}"
}

# ============================================================================
# GATE ORDER FUNCTIONS
# ============================================================================

# Get ordered list of gates
# Args: none
# Outputs: space-separated gate names in dependency order
get_gate_order() {
    echo "${VERIFICATION_GATE_ORDER[*]}"
}

# Get index of gate in order (0-based)
# Args: $1 = gate name
# Returns: 0 on success, EXIT_INVALID_GATE if not found
# Outputs: index number
get_gate_index() {
    local gate_name="$1"
    local index=0

    for gate in "${VERIFICATION_GATE_ORDER[@]}"; do
        if [[ "$gate" == "$gate_name" ]]; then
            echo "$index"
            return 0
        fi
        ((index++))
    done

    return "${EXIT_INVALID_GATE:-42}"
}

# Get all downstream gates (gates that come after the given gate)
# Args: $1 = gate name
# Returns: 0 on success
# Outputs: JSON array of downstream gate names
get_downstream_gates() {
    local from_gate="$1"
    local found=false
    local gates=()

    for gate in "${VERIFICATION_GATE_ORDER[@]}"; do
        if [[ "$found" == "true" ]]; then
            gates+=("\"$gate\"")
        fi
        if [[ "$gate" == "$from_gate" ]]; then
            found=true
        fi
    done

    if [[ ${#gates[@]} -eq 0 ]]; then
        echo "[]"
    else
        local IFS=','
        echo "[${gates[*]}]"
    fi
}

# ============================================================================
# VERIFICATION OBJECT FUNCTIONS
# ============================================================================

# Initialize verification object for a task
# Args: none
# Outputs: JSON verification object with defaults
init_verification() {
    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    cat <<EOF
{
  "passed": false,
  "round": 0,
  "gates": {
    "implemented": null,
    "testsPassed": null,
    "qaPassed": null,
    "cleanupDone": null,
    "securityPassed": null,
    "documented": null
  },
  "lastAgent": null,
  "lastUpdated": "$now",
  "failureLog": []
}
EOF
}

# Compute verification.passed from gates based on requiredGates config
# Args: $1 = verification JSON object
#       $2 = required gates JSON array (optional, reads from config if not provided)
# Outputs: "true" or "false"
compute_passed() {
    local verification_json="$1"
    local required_gates="${2:-}"

    # Get required gates from config if not provided
    if [[ -z "$required_gates" ]]; then
        required_gates=$(get_config_value "verification.requiredGates" '["implemented","testsPassed","qaPassed","securityPassed","documented"]')
    fi

    # Check each required gate
    local all_passed="true"

    while IFS= read -r gate; do
        # Skip empty lines
        [[ -z "$gate" ]] && continue

        # Get gate value from verification object
        local gate_value
        gate_value=$(echo "$verification_json" | jq -r ".gates.$gate // null")

        if [[ "$gate_value" != "true" ]]; then
            all_passed="false"
            break
        fi
    done < <(echo "$required_gates" | jq -r '.[]')

    echo "$all_passed"
}

# Set verification.passed on a verification object
# Args: $1 = verification JSON object
#       $2 = passed value (true/false)
# Outputs: updated verification JSON
set_verification_passed() {
    local verification_json="$1"
    local passed="$2"
    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    echo "$verification_json" | jq --argjson passed "$passed" --arg now "$now" '
        .passed = $passed |
        .lastUpdated = $now
    '
}

# Update a single gate value
# Args: $1 = verification JSON object
#       $2 = gate name
#       $3 = value (true/false/null)
#       $4 = agent name (optional)
# Returns: 0 on success, EXIT_INVALID_GATE if invalid gate
# Outputs: updated verification JSON
update_gate() {
    local verification_json="$1"
    local gate_name="$2"
    local value="$3"
    local agent="${4:-null}"

    # Validate gate name
    if ! validate_gate_name "$gate_name"; then
        return "${EXIT_INVALID_GATE:-42}"
    fi

    # Validate agent name if provided
    if [[ "$agent" != "null" ]] && ! validate_agent_name "$agent"; then
        return "${EXIT_INVALID_AGENT:-43}"
    fi

    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Convert value to proper JSON type
    local json_value
    case "$value" in
        true|false) json_value="$value" ;;
        null|"") json_value="null" ;;
        *) json_value="$value" ;;
    esac

    # Convert agent to JSON
    local json_agent
    if [[ "$agent" == "null" || -z "$agent" ]]; then
        json_agent="null"
    else
        json_agent="\"$agent\""
    fi

    echo "$verification_json" | jq \
        --arg gate "$gate_name" \
        --argjson value "$json_value" \
        --argjson agent "$json_agent" \
        --arg now "$now" '
        .gates[$gate] = $value |
        .lastAgent = $agent |
        .lastUpdated = $now
    '
}

# Reset all downstream gates to null after a gate failure
# Args: $1 = verification JSON object
#       $2 = failed gate name (all gates after this one reset)
# Returns: 0 on success
# Outputs: updated verification JSON
reset_downstream_gates() {
    local verification_json="$1"
    local from_gate="$2"

    # Validate gate name
    if ! validate_gate_name "$from_gate"; then
        return "${EXIT_INVALID_GATE:-42}"
    fi

    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Get downstream gates
    local found=false
    local result="$verification_json"

    for gate in "${VERIFICATION_GATE_ORDER[@]}"; do
        if [[ "$found" == "true" ]]; then
            result=$(echo "$result" | jq --arg gate "$gate" '.gates[$gate] = null')
        fi
        if [[ "$gate" == "$from_gate" ]]; then
            found=true
        fi
    done

    # Update lastUpdated
    echo "$result" | jq --arg now "$now" '.lastUpdated = $now'
}

# ============================================================================
# ROUND MANAGEMENT
# ============================================================================

# Increment the round counter
# Args: $1 = verification JSON object
#       $2 = max rounds (optional, reads from config if not provided)
# Returns: 0 on success, EXIT_MAX_ROUNDS_EXCEEDED if over limit
# Outputs: updated verification JSON
increment_round() {
    local verification_json="$1"
    local max_rounds="${2:-}"

    # Get max rounds from config if not provided
    if [[ -z "$max_rounds" ]]; then
        max_rounds=$(get_config_value "verification.maxRounds" "5")
    fi

    # Get current round
    local current_round
    current_round=$(echo "$verification_json" | jq -r '.round // 0')

    local new_round=$((current_round + 1))

    # Check if exceeded max rounds
    if [[ "$new_round" -gt "$max_rounds" ]]; then
        return "${EXIT_MAX_ROUNDS_EXCEEDED:-44}"
    fi

    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    echo "$verification_json" | jq \
        --argjson round "$new_round" \
        --arg now "$now" '
        .round = $round |
        .lastUpdated = $now
    '
}

# ============================================================================
# FAILURE LOGGING
# ============================================================================

# Log a failure to the failureLog array
# Args: $1 = verification JSON object
#       $2 = gate name that failed
#       $3 = agent name
#       $4 = reason for failure
# Outputs: updated verification JSON
log_failure() {
    local verification_json="$1"
    local gate_name="$2"
    local agent="$3"
    local reason="$4"

    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local round
    round=$(echo "$verification_json" | jq -r '.round // 0')

    echo "$verification_json" | jq \
        --arg gate "$gate_name" \
        --arg agent "$agent" \
        --arg reason "$reason" \
        --arg timestamp "$now" \
        --argjson round "$round" '
        .failureLog += [{
            "gate": $gate,
            "agent": $agent,
            "reason": $reason,
            "timestamp": $timestamp,
            "round": $round
        }] |
        .lastUpdated = $timestamp
    '
}

# ============================================================================
# STATUS CHECK FUNCTIONS
# ============================================================================

# Check if all required gates have passed
# Args: $1 = verification JSON object
#       $2 = required gates JSON array (optional)
# Returns: 0 if all passed, 1 if not
check_all_gates_passed() {
    local verification_json="$1"
    local required_gates="${2:-}"

    local result
    result=$(compute_passed "$verification_json" "$required_gates")

    [[ "$result" == "true" ]]
}

# Check if verification is complete (passed = true)
# Args: $1 = verification JSON object (or null)
# Returns: 0 if complete, 1 if not
is_verification_complete() {
    local verification_json="$1"

    # Handle null/empty verification
    if [[ -z "$verification_json" || "$verification_json" == "null" ]]; then
        return 1
    fi

    local passed
    passed=$(echo "$verification_json" | jq -r '.passed // false')

    [[ "$passed" == "true" ]]
}

# Get verification status for display
# Args: $1 = verification JSON object (or null)
# Outputs: pending | in-progress | passed | failed
get_verification_status() {
    local verification_json="$1"

    # Handle null/empty verification
    if [[ -z "$verification_json" || "$verification_json" == "null" ]]; then
        echo "pending"
        return 0
    fi

    # Check if passed
    local passed
    passed=$(echo "$verification_json" | jq -r '.passed // false')

    if [[ "$passed" == "true" ]]; then
        echo "passed"
        return 0
    fi

    # Check if any failures logged
    local failure_count
    failure_count=$(echo "$verification_json" | jq -r '.failureLog | length // 0')

    if [[ "$failure_count" -gt 0 ]]; then
        echo "failed"
        return 0
    fi

    # Check if any gates have been set
    local gates_set
    gates_set=$(echo "$verification_json" | jq -r '
        .gates | to_entries | map(select(.value != null)) | length
    ')

    if [[ "$gates_set" -gt 0 ]]; then
        echo "in-progress"
        return 0
    fi

    echo "pending"
}

# Check if task should require verification
# Args: $1 = task type (epic|task|subtask)
# Returns: 0 if should require, 1 if not
# Note: Epics don't use verification (derived from children)
should_require_verification() {
    local task_type="${1:-task}"

    # Epics don't use verification - they derive status from children
    if [[ "$task_type" == "epic" ]]; then
        return 1
    fi

    # Check if verification is enabled in config
    local enabled
    enabled=$(get_config_value "verification.enabled" "true")

    [[ "$enabled" == "true" ]]
}

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

# Get missing required gates
# Args: $1 = verification JSON object
#       $2 = required gates JSON array (optional)
# Outputs: JSON array of gate names that are not true
get_missing_gates() {
    local verification_json="$1"
    local required_gates="${2:-}"

    # Get required gates from config if not provided
    if [[ -z "$required_gates" ]]; then
        required_gates=$(get_config_value "verification.requiredGates" '["implemented","testsPassed","qaPassed","securityPassed","documented"]')
    fi

    local missing=()

    while IFS= read -r gate; do
        [[ -z "$gate" ]] && continue

        local gate_value
        gate_value=$(echo "$verification_json" | jq -r ".gates.$gate // null")

        if [[ "$gate_value" != "true" ]]; then
            missing+=("\"$gate\"")
        fi
    done < <(echo "$required_gates" | jq -r '.[]')

    if [[ ${#missing[@]} -eq 0 ]]; then
        echo "[]"
    else
        local IFS=','
        echo "[${missing[*]}]"
    fi
}

# Get gate summary for display
# Args: $1 = verification JSON object
# Outputs: JSON object with gate status summary
get_gate_summary() {
    local verification_json="$1"

    echo "$verification_json" | jq '{
        passed: .passed,
        round: .round,
        gates: .gates,
        lastAgent: .lastAgent,
        lastUpdated: .lastUpdated,
        failureCount: (.failureLog | length)
    }'
}

# ============================================================================
# PARENT AUTO-COMPLETE VERIFICATION FUNCTIONS
# ============================================================================

# Check if all children of parent have verification.passed = true
# Args: $1 = parent_id
#       $2 = current_task_id (unused, kept for API compatibility)
#       $3 = todo_file path
# Returns: 0 if all children verified, 1 if not
# Note: ALL children must have verification.passed = true, including the task
#       that was just completed. The just-completed task will have
#       verification.passed = false until explicitly verified.
all_siblings_verified() {
    local parent_id="$1"
    local _current_task_id="$2"  # Unused, kept for API compatibility
    local todo_file="$3"

    # Check if any children have verification.passed != true
    # This includes ALL children - the just-completed task will have passed=false
    local unverified_children
    unverified_children=$(jq --arg parentId "$parent_id" '
        .tasks[] |
        select(.parentId == $parentId and .status == "done") |
        select(.verification.passed != true)
    ' "$todo_file")

    # Also check for incomplete children (pending/active/blocked) - they can't be verified
    local incomplete_children
    incomplete_children=$(jq --arg parentId "$parent_id" '
        .tasks[] |
        select(.parentId == $parentId and
               (.status == "pending" or .status == "active" or .status == "blocked"))
    ' "$todo_file")

    # Return success only if no unverified completed children AND no incomplete children
    [[ -z "$unverified_children" && -z "$incomplete_children" ]]
}

# Check if verification is required for parent auto-complete
# Reads config.verification.requireForParentAutoComplete
# Returns: 0 if required, 1 if not
require_verification_for_parent_auto_complete() {
    if declare -f get_config_value >/dev/null 2>&1; then
        local required
        required=$(get_config_value "verification.requireForParentAutoComplete" "true")
        [[ "$required" == "true" ]]
    else
        # Default to true if config function not available
        return 0
    fi
}

# ============================================================================
# EPIC LIFECYCLE TRANSITION FUNCTIONS (T1156)
# ============================================================================

# Check if all children of an epic have verification.passed = true
# Args: $1 = epic_id
#       $2 = todo_file path
# Returns: 0 if all children verified, 1 if not or no children
all_epic_children_verified() {
    local epic_id="$1"
    local todo_file="$2"

    # Count total children
    local total_children
    total_children=$(jq --arg epicId "$epic_id" '[.tasks[] | select(.parentId == $epicId)] | length' "$todo_file")

    # Return failure if no children
    [[ "$total_children" -eq 0 ]] && return 1

    # Check if any children are NOT done
    local incomplete_children
    incomplete_children=$(jq --arg epicId "$epic_id" '
        [.tasks[] | select(.parentId == $epicId and .status != "done")] | length
    ' "$todo_file")

    [[ "$incomplete_children" -gt 0 ]] && return 1

    # Check if any done children don't have verification.passed = true
    local unverified_children
    unverified_children=$(jq --arg epicId "$epic_id" '
        [.tasks[] | select(.parentId == $epicId and .status == "done" and .verification.passed != true)] | length
    ' "$todo_file")

    [[ "$unverified_children" -eq 0 ]]
}

# Transition epic lifecycle from active to review
# Args: $1 = epic_id
#       $2 = todo_file path
#       $3 = format (json/text)
# Returns: 0 on success, 1 on failure
# Outputs: Updated JSON (to stdout if successful)
transition_epic_lifecycle_to_review() {
    local epic_id="$1"
    local todo_file="$2"
    local format="${3:-text}"

    # Get epic
    local epic
    epic=$(jq --arg id "$epic_id" '.tasks[] | select(.id == $id)' "$todo_file")

    # Verify it's an epic
    local epic_type
    epic_type=$(echo "$epic" | jq -r '.type // "task"')
    [[ "$epic_type" != "epic" ]] && return 1

    # Check current lifecycle state
    local current_lifecycle
    current_lifecycle=$(echo "$epic" | jq -r '.epicLifecycle // "active"')

    # Only transition from 'active' state
    if [[ "$current_lifecycle" != "active" ]]; then
        return 1
    fi

    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Update epicLifecycle to 'review'
    local updated_json
    updated_json=$(jq --arg id "$epic_id" --arg now "$now" '
        .tasks |= map(
            if .id == $id then
                .epicLifecycle = "review" |
                .updatedAt = $now
            else . end
        )
    ' "$todo_file")

    echo "$updated_json"
}

# Check and perform epic lifecycle transition after child verification
# Args: $1 = completed_task_id (the task that was just completed)
#       $2 = todo_file path
#       $3 = format (json/text)
# Returns: 0 if transition occurred, 1 if not
check_epic_lifecycle_transition() {
    local completed_task_id="$1"
    local todo_file="$2"
    local format="${3:-text}"

    # Get the completed task's parent
    local parent_id
    parent_id=$(jq -r --arg id "$completed_task_id" '.tasks[] | select(.id == $id) | .parentId // ""' "$todo_file")

    # No parent, nothing to check
    [[ -z "$parent_id" || "$parent_id" == "null" ]] && return 1

    # Check if parent is an epic
    local parent_type
    parent_type=$(jq -r --arg id "$parent_id" '.tasks[] | select(.id == $id) | .type // "task"' "$todo_file")

    if [[ "$parent_type" == "epic" ]]; then
        # Check if all children are verified
        if all_epic_children_verified "$parent_id" "$todo_file"; then
            # Transition epic lifecycle
            local updated_json
            if updated_json=$(transition_epic_lifecycle_to_review "$parent_id" "$todo_file" "$format"); then
                # Save the updated file
                if declare -f save_json >/dev/null 2>&1; then
                    if save_json "$todo_file" "$updated_json"; then
                        local epic_title
                        epic_title=$(jq -r --arg id "$parent_id" '.tasks[] | select(.id == $id) | .title' "$todo_file")
                        [[ "$format" != "json" ]] && log_info "Epic $parent_id ready for review - all children verified"
                        return 0
                    fi
                fi
            fi
        fi
    else
        # Parent is not an epic - recursively check grandparent
        check_epic_lifecycle_transition "$parent_id" "$todo_file" "$format"
        return $?
    fi

    return 1
}

# ============================================================================
# CIRCULAR VALIDATION FUNCTIONS (T2579)
# ============================================================================

# Check for circular validation (self-approval prevention)
# Args: $1 = task_id
#       $2 = current_agent (agent attempting to validate)
#       $3 = todo_file path
# Returns: 0 if valid, 70 (E_SELF_APPROVAL) if circular validation detected
# Outputs: error message to stderr if circular
check_circular_validation() {
    local task_id="$1"
    local current_agent="$2"
    local todo_file="$3"

    # Get task
    local task_json
    task_json=$(jq --arg id "$task_id" '.tasks[] | select(.id == $id)' "$todo_file")

    if [[ -z "$task_json" ]]; then
        return "${EXIT_NOT_FOUND:-4}"
    fi

    # Get provenance fields
    local created_by
    local validated_by
    local tested_by
    created_by=$(echo "$task_json" | jq -r '.createdBy // null')
    validated_by=$(echo "$task_json" | jq -r '.validatedBy // null')
    tested_by=$(echo "$task_json" | jq -r '.testedBy // null')

    # Allow user/legacy/system agents (special cases)
    if [[ "$current_agent" =~ ^(user|legacy|system)$ ]]; then
        return 0
    fi

    # Check for self-approval (creator cannot validate own work)
    if [[ "$current_agent" == "$created_by" ]]; then
        if declare -f error_json >/dev/null 2>&1; then
            error_json "E_SELF_APPROVAL" \
                "Cannot validate your own work (agent: $current_agent)" \
                70
        else
            echo "[ERROR] Cannot validate your own work (agent: $current_agent)" >&2
        fi
        return 70
    fi

    # Check for validator re-testing (validator cannot also be tester)
    if [[ "$current_agent" == "$validated_by" ]]; then
        if declare -f error_json >/dev/null 2>&1; then
            error_json "E_SELF_APPROVAL" \
                "Validator cannot also be tester (agent: $current_agent)" \
                70
        else
            echo "[ERROR] Validator cannot also be tester (agent: $current_agent)" >&2
        fi
        return 70
    fi

    # Check for tester re-creation (tester cannot create tasks for own testing)
    if [[ "$current_agent" == "$tested_by" ]]; then
        if declare -f error_json >/dev/null 2>&1; then
            error_json "E_SELF_APPROVAL" \
                "Tester cannot create tasks for own testing (agent: $current_agent)" \
                70
        else
            echo "[ERROR] Tester cannot create tasks for own testing (agent: $current_agent)" >&2
        fi
        return 70
    fi

    # All checks passed
    return 0
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f validate_gate_name
export -f validate_agent_name
export -f get_gate_order
export -f get_gate_index
export -f get_downstream_gates
export -f init_verification
export -f compute_passed
export -f set_verification_passed
export -f update_gate
export -f reset_downstream_gates
export -f increment_round
export -f log_failure
export -f check_all_gates_passed
export -f is_verification_complete
export -f get_verification_status
export -f should_require_verification
export -f get_missing_gates
export -f get_gate_summary
export -f all_siblings_verified
export -f require_verification_for_parent_auto_complete
export -f all_epic_children_verified
export -f transition_epic_lifecycle_to_review
export -f check_epic_lifecycle_transition
export -f check_circular_validation
