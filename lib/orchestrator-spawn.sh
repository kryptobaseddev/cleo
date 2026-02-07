#!/usr/bin/env bash
# orchestrator-spawn.sh - Dynamic Skill Injection for Subagent Spawning
#
# LAYER: 3 (Application - depends on Layer 2)
# DEPENDENCIES: exit-codes.sh, skill-dispatch.sh, skill-validate.sh, token-inject.sh
# PROVIDES: orchestrator_spawn_for_task
#
# Single-function orchestrator spawning that:
#   1. Reads task from CLEO
#   2. Selects skill based on task type/labels
#   3. Validates compatibility
#   4. Injects protocol
#   5. Sets tokens
#   6. Returns complete prompt ready for spawning
#
# Replaces manual 6-step orchestrator workflow.
#
# USAGE:
#   source lib/orchestrator-spawn.sh
#
#   # Prepare complete subagent prompt for a task
#   prompt=$(orchestrator_spawn_for_task "T1234")
#
#   # With explicit skill override
#   prompt=$(orchestrator_spawn_for_task "T1234" "ct-research-agent")
#
#   # With target model validation
#   prompt=$(orchestrator_spawn_for_task "T1234" "" "sonnet")

#=== SOURCE GUARD ================================================
[[ -n "${_ORCHESTRATOR_SPAWN_LOADED:-}" ]] && return 0
declare -r _ORCHESTRATOR_SPAWN_LOADED=1

set -euo pipefail

# Determine library directory
_OSP_LIB_DIR="${BASH_SOURCE[0]%/*}"
[[ "$_OSP_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _OSP_LIB_DIR="."

# Determine project root (one level up from lib/)
_OSP_PROJECT_ROOT="${_OSP_LIB_DIR}/.."
[[ -d "${_OSP_PROJECT_ROOT}/skills" ]] || _OSP_PROJECT_ROOT="."

# Source dependencies
# shellcheck source=lib/exit-codes.sh
source "${_OSP_LIB_DIR}/exit-codes.sh"
# shellcheck source=lib/skill-dispatch.sh
source "${_OSP_LIB_DIR}/skill-dispatch.sh"
# shellcheck source=lib/compliance-check.sh
source "${_OSP_LIB_DIR}/compliance-check.sh"
# shellcheck source=lib/protocol-validation.sh
source "${_OSP_LIB_DIR}/protocol-validation.sh"
# shellcheck source=lib/lifecycle.sh
source "${_OSP_LIB_DIR}/lifecycle.sh"
# shellcheck source=lib/token-estimation.sh
source "${_OSP_LIB_DIR}/token-estimation.sh"

# ============================================================================
# INTERNAL HELPERS
# ============================================================================

# Log debug message to stderr
# Args: $1 = message
_osp_debug() {
    [[ -n "${ORCHESTRATOR_SPAWN_DEBUG:-}" ]] && echo "[orchestrator-spawn] DEBUG: $1" >&2
    return 0
}

# Log warning message to stderr
# Args: $1 = message
_osp_warn() {
    echo "[orchestrator-spawn] WARN: $1" >&2
}

# Log error message to stderr
# Args: $1 = message
_osp_error() {
    echo "[orchestrator-spawn] ERROR: $1" >&2
}

# Output JSON error
# Args: $1 = code, $2 = message, $3 = context (optional)
_osp_json_error() {
    local code="$1"
    local message="$2"
    local context="${3:-}"

    if [[ -n "$context" ]]; then
        jq -n \
            --arg code "$code" \
            --arg message "$message" \
            --arg context "$context" \
            '{
                "_meta": {
                    "command": "orchestrator",
                    "operation": "spawn_for_task"
                },
                "success": false,
                "error": {
                    "code": $code,
                    "message": $message,
                    "context": $context
                }
            }'
    else
        jq -n \
            --arg code "$code" \
            --arg message "$message" \
            '{
                "_meta": {
                    "command": "orchestrator",
                    "operation": "spawn_for_task"
                },
                "success": false,
                "error": {
                    "code": $code,
                    "message": $message
                }
            }'
    fi
}

# Check jq is available
_osp_require_jq() {
    if ! command -v jq &>/dev/null; then
        _osp_error "jq is required but not installed"
        return "$EXIT_DEPENDENCY_ERROR"
    fi
    return 0
}

# Map skill name to protocol type
# Args: $1 = skill_name
# Returns: protocol type (research|consensus|specification|decomposition|implementation|contribution|release) or empty
_osp_skill_to_protocol() {
    local skill_name="$1"

    # Map based on skill naming conventions and known skills
    case "$skill_name" in
        ct-research-agent|*research*)
            echo "research"
            ;;
        ct-validator|*consensus*|*vote*)
            echo "consensus"
            ;;
        ct-spec-writer|*specification*|*spec*)
            echo "specification"
            ;;
        ct-epic-architect|*decomposition*|*architect*)
            echo "decomposition"
            ;;
        ct-task-executor|*executor*|*implementation*)
            echo "implementation"
            ;;
        *contribution*|*merge*)
            echo "contribution"
            ;;
        *release*)
            echo "release"
            ;;
        *)
            # Default to implementation for unknown skills
            echo "implementation"
            ;;
    esac
}

# @task T2717
# Get list of missing prerequisite stages
# Args: $1 = epic_id, $2 = target_stage
# Returns: 0 on success
# Outputs: Comma-separated list of missing stages
_osp_get_missing_prerequisite_stages() {
    local epic_id="$1"
    local target_stage="$2"

    local -a stages=("research" "consensus" "specification" "decomposition" "implementation")
    local -a missing=()

    local target_idx=-1
    for i in "${!stages[@]}"; do
        [[ "${stages[$i]}" == "$target_stage" ]] && target_idx=$i && break
    done

    for ((i=0; i<target_idx; i++)); do
        local state
        state=$(get_rcsd_stage_status "$epic_id" "${stages[$i]}" 2>/dev/null || echo "pending")
        if [[ "$state" != "completed" && "$state" != "skipped" ]]; then
            missing+=("${stages[$i]}")
        fi
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        local IFS=','
        echo "${missing[*]}"
    fi
}

# ============================================================================
# MAIN FUNCTION
# ============================================================================

# orchestrator_spawn_for_task - Prepare complete subagent prompt
#
# This function consolidates the manual 6-step orchestrator workflow into
# a single call that:
#   1. Reads task from CLEO
#   2. Selects skill based on task type/labels (or uses override)
#   3. Validates skill compatibility with target model
#   4. Injects protocol base + skill content
#   5. Sets context tokens (TASK_ID, DATE, TOPIC_SLUG, EPIC_ID)
#   6. Returns complete prompt ready for Task tool
#
# Args:
#   $1 = task_id (required) - CLEO task ID (e.g., T1234)
#   $2 = skill_override (optional) - Explicit skill name, bypasses auto-dispatch
#   $3 = target_model (optional) - Model to validate compatibility against
#
# Returns:
#   0 on success, prompt content to stdout
#   Non-zero on error, JSON error object to stdout
#
# Environment Variables:
#   ORCHESTRATOR_SPAWN_DEBUG - Enable debug logging if set
#   TI_* - Token values can be pre-set to override defaults
#
# Example:
#   prompt=$(orchestrator_spawn_for_task "T1234")
#   prompt=$(orchestrator_spawn_for_task "T1234" "ct-research-agent")
#   prompt=$(orchestrator_spawn_for_task "T1234" "" "opus")
#
orchestrator_spawn_for_task() {
    local task_id="${1:-}"
    local skill_override="${2:-}"
    local target_model="${3:-}"

    # Validate required arguments
    if [[ -z "$task_id" ]]; then
        _osp_error "task_id is required"
        _osp_json_error "E_INVALID_INPUT" "task_id is required"
        return "$EXIT_INVALID_INPUT"
    fi

    _osp_require_jq || return $?

    _osp_debug "Spawning for task: $task_id"
    [[ -n "$skill_override" ]] && _osp_debug "Skill override: $skill_override"
    [[ -n "$target_model" ]] && _osp_debug "Target model: $target_model"

    # Step 1: Read task from CLEO
    local task_json
    task_json=$(cleo show "$task_id" --format json 2>/dev/null)

    if [[ -z "$task_json" || "$task_json" == "null" ]]; then
        _osp_error "Could not fetch task: $task_id"
        _osp_json_error "E_NOT_FOUND" "Task not found: $task_id" "$task_id"
        return "$EXIT_NOT_FOUND"
    fi

    # Check if cleo returned success
    local cleo_success
    cleo_success=$(echo "$task_json" | jq -r '.success // false')
    if [[ "$cleo_success" != "true" ]]; then
        local cleo_error
        cleo_error=$(echo "$task_json" | jq -r '.error.message // "Unknown error"')
        _osp_error "CLEO error: $cleo_error"
        _osp_json_error "E_CLEO_ERROR" "CLEO returned error: $cleo_error" "$task_id"
        return "$EXIT_NOT_FOUND"
    fi

    # Extract task fields
    local title description task_type task_labels parent_id task_status
    title=$(echo "$task_json" | jq -r '.task.title // "untitled"')
    description=$(echo "$task_json" | jq -r '.task.description // ""')
    task_type=$(echo "$task_json" | jq -r '.task.type // "task"')
    task_labels=$(echo "$task_json" | jq -c '.task.labels // []')
    parent_id=$(echo "$task_json" | jq -r '.task.parentId // ""')
    task_status=$(echo "$task_json" | jq -r '.task.status // "pending"')

    _osp_debug "Task: $title (type=$task_type, status=$task_status)"

    # Step 2: Select skill
    local skill_name
    if [[ -n "$skill_override" ]]; then
        skill_name="$skill_override"
        _osp_debug "Using skill override: $skill_name"
    else
        # Use skill_select_for_task from skill-dispatch.sh
        skill_name=$(skill_select_for_task "$task_json")
        _osp_debug "Auto-selected skill: $skill_name"
    fi

    if [[ -z "$skill_name" ]]; then
        _osp_error "Could not determine skill for task"
        _osp_json_error "E_SKILL_NOT_FOUND" "No skill matched task criteria" "$task_id"
        return "$EXIT_NOT_FOUND"
    fi

    # Step 3: Validate skill compatibility
    if ! skill_validate_for_spawn "$skill_name" "$target_model"; then
        local validation_rc=$?
        _osp_error "Skill '$skill_name' failed validation"
        _osp_json_error "E_SKILL_VALIDATION" "Skill '$skill_name' failed validation" "$skill_name"
        return "$validation_rc"
    fi

    _osp_debug "Skill '$skill_name' passed validation"

    # Step 4 & 5: Set context tokens and inject protocol
    local date_today topic_slug epic_id
    date_today=$(date +%Y-%m-%d)

    # Generate topic slug from title
    topic_slug=$(echo "$title" | tr '[:upper:]' '[:lower:]' | \
                 sed -E 's/[^a-z0-9]+/-/g' | sed -E 's/^-+|-+$//g')
    [[ -z "$topic_slug" ]] && topic_slug="task-${task_id}"

    # Set epic_id from parent if available
    epic_id="$parent_id"

    _osp_debug "Tokens: TASK_ID=$task_id, DATE=$date_today, TOPIC_SLUG=$topic_slug, EPIC_ID=${epic_id:-none}"

    # Export core tokens for compliance check and template injection
    export TI_TASK_ID="$task_id"
    export TI_DATE="$date_today"
    export TI_TOPIC_SLUG="$topic_slug"
    export TI_EPIC_ID="${epic_id:-}"

    # Step 5.5: Set taskContext tokens from task data
    # This populates TI_TASK_TITLE, TI_TASK_DESCRIPTION, TI_TOPICS_JSON, TI_DEPENDS_LIST
    # These tokens are used by skill templates like task-executor
    if ! ti_set_task_context "$task_json"; then
        _osp_warn "Failed to set task context tokens - continuing with defaults"
    else
        _osp_debug "Task context tokens set: TASK_TITLE='${TI_TASK_TITLE:-}', TOPICS_JSON='${TI_TOPICS_JSON:-}'"
    fi

    # Step 6: PRE-SPAWN COMPLIANCE VERIFICATION
    # Verify tokens are set before injection to ensure template has required context
    _osp_debug "Pre-spawn compliance check: verifying tokens set"
    local missing_tokens=""
    [[ -z "${TI_TASK_ID:-}" ]] && missing_tokens="${missing_tokens}TI_TASK_ID "
    [[ -z "${TI_DATE:-}" ]] && missing_tokens="${missing_tokens}TI_DATE "
    [[ -z "${TI_TOPIC_SLUG:-}" ]] && missing_tokens="${missing_tokens}TI_TOPIC_SLUG "

    if [[ -n "$missing_tokens" ]]; then
        _osp_error "SPAWN BLOCKED: Required tokens not set before injection"
        jq -n \
            --arg task_id "$task_id" \
            --arg skill "$skill_name" \
            --arg missing "$missing_tokens" \
            '{
                "_meta": {
                    "command": "orchestrator",
                    "operation": "spawn_for_task"
                },
                "success": false,
                "error": {
                    "code": "E_TOKENS_NOT_SET",
                    "message": "SPAWN BLOCKED: Required tokens not set before injection. Missing: " + $missing,
                    "fix": "cleo orchestrator spawn " + $task_id + " --template " + $skill,
                    "alternatives": [
                        {
                            "action": "Check token injection in skill template",
                            "command": "grep -i \"{{\" skills/" + $skill + "/SKILL.md"
                        },
                        {
                            "action": "Verify skill uses ti_set_task_context",
                            "command": "grep -i \"ti_set_task_context\" skills/" + $skill + "/SKILL.md"
                        }
                    ],
                    "context": {
                        "taskId": $task_id,
                        "skill": $skill,
                        "missingTokens": ($missing | split(" ") | map(select(length > 0))),
                        "reason": "Token injection must complete before template rendering"
                    }
                }
            }'
        return "${EXIT_INVALID_INPUT:-2}"
    fi
    _osp_debug "Pre-spawn compliance passed: all required tokens set"

    # Step 6.5: PROTOCOL VALIDATION
    # Validate protocol requirements before spawning subagent
    # Maps skill to protocol type and validates MUST requirements
    _osp_debug "Protocol validation: checking protocol requirements for skill '$skill_name'"
    local protocol_type
    protocol_type=$(_osp_skill_to_protocol "$skill_name")
    _osp_debug "Detected protocol type: $protocol_type"

    # For protocol validation, we need a minimal manifest entry structure
    # We'll create it from task data for validation purposes
    local temp_manifest_entry
    temp_manifest_entry=$(jq -n \
        --arg task_id "$task_id" \
        --arg agent_type "$protocol_type" \
        --argjson labels "$task_labels" \
        '{
            id: $task_id,
            agent_type: $agent_type,
            labels: $labels,
            key_findings: [],
            status: "pending"
        }')

    # Run protocol validation (non-strict mode for pre-spawn check)
    # Strict mode will be enforced at completion time
    local validation_result
    validation_result=$(validate_protocol "$task_id" "$protocol_type" "$temp_manifest_entry" "{}" "false" 2>/dev/null || echo '{"valid":false,"violations":[],"score":0}')

    local is_valid
    is_valid=$(echo "$validation_result" | jq -r '.valid // false')

    if [[ "$is_valid" != "true" ]]; then
        local violations
        violations=$(echo "$validation_result" | jq -c '.violations // []')
        local error_count
        error_count=$(echo "$violations" | jq '[.[] | select(.severity == "error")] | length')

        if [[ $error_count -gt 0 ]]; then
            _osp_error "SPAWN BLOCKED: Protocol validation failed with $error_count error(s)"
            _osp_error "Violations: $(echo "$violations" | jq -c '.')"

            jq -n \
                --arg task_id "$task_id" \
                --arg skill "$skill_name" \
                --arg protocol "$protocol_type" \
                --argjson violations "$violations" \
                '{
                    "_meta": {
                        "command": "orchestrator",
                        "operation": "spawn_for_task"
                    },
                    "success": false,
                    "error": {
                        "code": "E_PROTOCOL_VALIDATION",
                        "message": "SPAWN BLOCKED: Protocol requirements not met for " + $protocol + " protocol",
                        "fix": "cleo show " + $task_id + " --validate-protocol",
                        "alternatives": [
                            {
                                "action": "Review protocol requirements",
                                "command": "cat protocols/" + $protocol + ".md"
                            },
                            {
                                "action": "Fix violations and retry",
                                "command": "cleo orchestrator spawn " + $task_id
                            }
                        ],
                        "context": {
                            "taskId": $task_id,
                            "skill": $skill,
                            "protocol": $protocol,
                            "violations": $violations
                        }
                    }
                }'
            return "${EXIT_PROTOCOL_GENERIC:-67}"
        else
            _osp_warn "Protocol validation warnings (non-blocking): $(echo "$violations" | jq -c '.')"
        fi
    else
        _osp_debug "Protocol validation passed for protocol: $protocol_type"
    fi

    # Step 6.75: LIFECYCLE GATE ENFORCEMENT
    # @task T2717
    _osp_debug "Checking lifecycle gate for protocol: $protocol_type"

    # Get parent epic ID (if task has one)
    local epic_id
    epic_id=$(echo "$task_json" | jq -r '.task.parentId // empty')

    if [[ -n "$epic_id" ]]; then
        # Check enforcement mode
        local enforcement_mode
        enforcement_mode=$(get_lifecycle_enforcement_mode 2>/dev/null || echo "strict")
        _osp_debug "Lifecycle enforcement mode: $enforcement_mode"

        if [[ "$enforcement_mode" != "off" ]]; then
            # Map protocol to RCSD stage
            local rcsd_stage
            case "$protocol_type" in
                research) rcsd_stage="research" ;;
                consensus) rcsd_stage="consensus" ;;
                specification) rcsd_stage="specification" ;;
                decomposition) rcsd_stage="decomposition" ;;
                implementation|contribution) rcsd_stage="implementation" ;;
                release) rcsd_stage="release" ;;
                *) rcsd_stage="" ;;
            esac

            if [[ -n "$rcsd_stage" ]]; then
                _osp_debug "Checking prerequisites for stage: $rcsd_stage"

                if ! query_rcsd_prerequisite_status "$epic_id" "$rcsd_stage" 2>/dev/null; then
                    local missing_stages
                    missing_stages=$(_osp_get_missing_prerequisite_stages "$epic_id" "$rcsd_stage" 2>/dev/null || echo "unknown")

                    if [[ "$enforcement_mode" == "strict" ]]; then
                        _osp_error "SPAWN BLOCKED: Lifecycle gate failed - missing prerequisites for $rcsd_stage"
                        jq -n \
                            --arg task_id "$task_id" \
                            --arg skill "$skill_name" \
                            --arg protocol "$protocol_type" \
                            --arg stage "$rcsd_stage" \
                            --arg epic "$epic_id" \
                            --arg missing "$missing_stages" \
                            '{
                                "_meta": {
                                    "command": "orchestrator",
                                    "operation": "spawn_for_task"
                                },
                                "success": false,
                                "error": {
                                    "code": "E_LIFECYCLE_GATE_FAILED",
                                    "message": "SPAWN BLOCKED: Lifecycle prerequisites not met for " + $stage + " stage",
                                    "fix": "Complete prerequisite stages first: " + $missing,
                                    "alternatives": [
                                        {
                                            "action": "Check RCSD state",
                                            "command": "jq . .cleo/rcsd/" + $epic + "/_manifest.json"
                                        },
                                        {
                                            "action": "Set enforcement to advisory",
                                            "command": "cleo config set lifecycleEnforcement.mode advisory"
                                        }
                                    ],
                                    "context": {
                                        "taskId": $task_id,
                                        "epicId": $epic,
                                        "targetStage": $stage,
                                        "missingPrerequisites": $missing,
                                        "enforcementMode": "strict"
                                    }
                                }
                            }'
                        return "${EXIT_LIFECYCLE_GATE_FAILED:-75}"
                    else
                        _osp_warn "Lifecycle gate failed but mode is advisory - proceeding with spawn"
                    fi
                else
                    _osp_debug "Lifecycle gate passed for stage: $rcsd_stage"
                fi
            fi
        else
            _osp_debug "Lifecycle enforcement is OFF - skipping gate check"
        fi
    else
        _osp_debug "No parent epic - skipping lifecycle gate check"
    fi

    # Step 7: Inject and return complete prompt
    # skill_inject handles: token setting, skill loading, protocol injection
    local prompt_content
    prompt_content=$(skill_inject "$skill_name" "$task_id" "$date_today" "$topic_slug")
    local inject_rc=$?

    if [[ $inject_rc -ne 0 ]]; then
        _osp_error "Skill injection failed"
        _osp_json_error "E_INJECTION_FAILED" "Failed to inject skill: $skill_name" "$skill_name"
        return "$inject_rc"
    fi

    # Step 7.5: Track prompt build tokens (T2851)
    _osp_debug "Tracking token usage for prompt build..."
    track_prompt_build "$prompt_content" "$task_id" "$skill_name" 2>/dev/null || \
        _osp_warn "Failed to track prompt tokens (non-blocking)"

    # Step 8: MANDATORY protocol validation - fail loudly if missing
    # This check ensures ALL spawned subagents have the protocol block
    _osp_debug "Validating protocol injection in generated prompt..."
    if ! orchestrator_verify_protocol_injection "$prompt_content"; then
        _osp_error "SPAWN BLOCKED: Protocol injection validation failed"
        jq -n \
            --arg task_id "$task_id" \
            --arg skill "$skill_name" \
            '{
                "_meta": {
                    "command": "orchestrator",
                    "operation": "spawn_for_task"
                },
                "success": false,
                "error": {
                    "code": "E_PROTOCOL_MISSING",
                    "message": "SPAWN BLOCKED: Generated prompt missing SUBAGENT PROTOCOL marker. The skill template may be missing protocol injection.",
                    "fix": "cleo orchestrator spawn --force-inject",
                    "alternatives": [
                        {
                            "action": "Manually append protocol block",
                            "command": "protocol=$(cleo research inject); prompt=\"${prompt}\\n\\n${protocol}\""
                        },
                        {
                            "action": "Check skill template includes protocol",
                            "command": "cat skills/" + $skill + "/SKILL.md | grep -i \"subagent protocol\""
                        },
                        {
                            "action": "Use a different skill with protocol support",
                            "command": "cleo orchestrator spawn " + $task_id + " --skill ct-task-executor"
                        }
                    ],
                    "context": {
                        "taskId": $task_id,
                        "skill": $skill,
                        "reason": "All subagents MUST include SUBAGENT PROTOCOL block to ensure manifest compliance"
                    }
                }
            }'
        return "${EXIT_PROTOCOL_MISSING:-60}"
    fi
    _osp_debug "Protocol validation passed"

    # Build enhanced prompt with task context
    local output_file="${date_today}_${topic_slug}.md"
    local spawn_timestamp
    spawn_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Step 9: Record spawn attempt (NOT compliance - that happens at completion)
    # T2832: Removed hardcoded 100% compliance. Real validation happens in cleo complete.
    # This only logs that a spawn was initiated - actual compliance is measured when
    # the subagent completes and its manifest entry is validated.
    _osp_debug "Spawn prepared for task $task_id with skill $skill_name"
    # Note: Compliance metrics are logged by validate_and_log() at task completion time,
    # using actual manifest entries and real protocol validation - not hardcoded values.

    # Output as JSON with all metadata for Task tool
    jq -n \
        --arg task_id "$task_id" \
        --arg skill "$skill_name" \
        --arg topic_slug "$topic_slug" \
        --arg date "$date_today" \
        --arg epic_id "$epic_id" \
        --arg output_file "$output_file" \
        --arg timestamp "$spawn_timestamp" \
        --arg target_model "${target_model:-auto}" \
        --arg prompt "$prompt_content" \
        --arg title "$title" \
        --arg description "$description" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "spawn_for_task"
            },
            "success": true,
            "result": {
                "taskId": $task_id,
                "skill": $skill,
                "topicSlug": $topic_slug,
                "date": $date,
                "epicId": (if $epic_id == "" then null else $epic_id end),
                "outputFile": $output_file,
                "spawnTimestamp": $timestamp,
                "targetModel": $target_model,
                "taskContext": {
                    "title": $title,
                    "description": $description
                },
                "instruction": "Use Task tool to spawn subagent with the following prompt:",
                "prompt": $prompt
            }
        }'

    return 0
}

# ============================================================================
# CONVENIENCE FUNCTIONS
# ============================================================================

# orchestrator_spawn_batch - Prepare prompts for multiple tasks
#
# Args:
#   $1 = JSON array of task IDs (e.g., '["T001", "T002", "T003"]')
#   $2 = skill_override (optional)
#   $3 = target_model (optional)
#
# Returns:
#   JSON array of spawn results
#
orchestrator_spawn_batch() {
    local task_ids_json="${1:-[]}"
    local skill_override="${2:-}"
    local target_model="${3:-}"

    _osp_require_jq || return $?

    local results="[]"
    local task_id

    while IFS= read -r task_id; do
        [[ -z "$task_id" ]] && continue

        local result
        result=$(orchestrator_spawn_for_task "$task_id" "$skill_override" "$target_model")
        results=$(echo "$results" | jq --argjson r "$result" '. + [$r]')
    done < <(echo "$task_ids_json" | jq -r '.[]')

    jq -n \
        --argjson results "$results" \
        --arg count "$(echo "$results" | jq 'length')" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "spawn_batch"
            },
            "success": true,
            "result": {
                "count": ($count | tonumber),
                "spawns": $results
            }
        }'
}

# orchestrator_spawn_preview - Preview skill selection without injection
#
# Useful for debugging skill dispatch decisions.
#
# Args:
#   $1 = task_id
#
# Returns:
#   JSON with skill selection preview
#
orchestrator_spawn_preview() {
    local task_id="${1:-}"

    if [[ -z "$task_id" ]]; then
        _osp_json_error "E_INVALID_INPUT" "task_id is required"
        return "$EXIT_INVALID_INPUT"
    fi

    _osp_require_jq || return $?

    # Read task
    local task_json
    task_json=$(cleo show "$task_id" --format json 2>/dev/null)

    if [[ -z "$task_json" || "$(echo "$task_json" | jq -r '.success')" != "true" ]]; then
        _osp_json_error "E_NOT_FOUND" "Task not found: $task_id" "$task_id"
        return "$EXIT_NOT_FOUND"
    fi

    # Extract fields
    local title task_type task_labels
    title=$(echo "$task_json" | jq -r '.task.title // "untitled"')
    task_type=$(echo "$task_json" | jq -r '.task.type // "task"')
    task_labels=$(echo "$task_json" | jq -c '.task.labels // []')

    # Select skill
    local skill_name
    skill_name=$(skill_select_for_task "$task_json")

    # Get skill info
    local skill_info
    skill_info=$(skill_get_info "$skill_name" 2>/dev/null || echo "{}")

    jq -n \
        --arg task_id "$task_id" \
        --arg title "$title" \
        --arg task_type "$task_type" \
        --argjson labels "$task_labels" \
        --arg skill "$skill_name" \
        --argjson skill_info "$skill_info" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "spawn_preview"
            },
            "success": true,
            "result": {
                "taskId": $task_id,
                "taskTitle": $title,
                "taskType": $task_type,
                "taskLabels": $labels,
                "selectedSkill": $skill,
                "skillInfo": $skill_info
            }
        }'
}

# ============================================================================
# PROTOCOL ENFORCEMENT FUNCTIONS
# ============================================================================

# orchestrator_verify_protocol_injection - Verify prompt contains protocol block
#
# MANDATORY validation before spawning any subagent via Task tool.
# Fails loudly with actionable fix instructions if protocol block is missing.
#
# Args:
#   $1 = prompt content (required)
#   $2 = output_json (optional) - if "true", output JSON error object
#
# Returns:
#   0 if protocol block found
#   EXIT_PROTOCOL_MISSING (60) if missing
#
# Output:
#   On failure with output_json=true: JSON error object with fix instructions
#   On failure without output_json: Error message to stderr
#
# Example:
#   if ! orchestrator_verify_protocol_injection "$prompt" "true"; then
#       echo "Protocol injection required"
#   fi
#
orchestrator_verify_protocol_injection() {
    local prompt="${1:-}"
    local output_json="${2:-false}"

    # Validate input
    if [[ -z "$prompt" ]]; then
        _osp_error "Prompt content is required for protocol validation"
        if [[ "$output_json" == "true" ]]; then
            jq -n '{
                "_meta": {
                    "command": "orchestrator",
                    "operation": "verify_protocol_injection"
                },
                "success": false,
                "error": {
                    "code": "E_INVALID_INPUT",
                    "message": "Prompt content is required for protocol validation",
                    "fix": "Pass prompt content as first argument to validation function"
                }
            }'
        fi
        return "${EXIT_INVALID_INPUT:-2}"
    fi

    # Check for SUBAGENT PROTOCOL marker (case-insensitive header check)
    # Accepts: "## SUBAGENT PROTOCOL", "# SUBAGENT PROTOCOL", "SUBAGENT PROTOCOL"
    if echo "$prompt" | grep -qi "SUBAGENT PROTOCOL"; then
        _osp_debug "Protocol block found in prompt"
        if [[ "$output_json" == "true" ]]; then
            jq -n '{
                "_meta": {
                    "command": "orchestrator",
                    "operation": "verify_protocol_injection"
                },
                "success": true,
                "valid": true,
                "message": "Protocol block present in prompt"
            }'
        fi
        return 0
    fi

    # PROTOCOL VIOLATION - fail loudly with fix instructions
    _osp_error "PROTOCOL VIOLATION: Missing 'SUBAGENT PROTOCOL' marker in spawn prompt"
    _osp_error "FIX: Use 'cleo research inject' to get the protocol block and inject it into your prompt"

    if [[ "$output_json" == "true" ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "verify_protocol_injection"
            },
            "success": false,
            "valid": false,
            "error": {
                "code": "E_PROTOCOL_MISSING",
                "message": "PROTOCOL VIOLATION: Missing SUBAGENT PROTOCOL marker in spawn prompt. All subagents MUST include the protocol injection block.",
                "fix": "cleo research inject",
                "alternatives": [
                    {
                        "action": "Get protocol block via CLI",
                        "command": "cleo research inject"
                    },
                    {
                        "action": "Copy protocol to clipboard",
                        "command": "cleo research inject --clipboard"
                    },
                    {
                        "action": "Use orchestrator spawn command (auto-injects)",
                        "command": "cleo orchestrator spawn <task-id>"
                    }
                ],
                "context": {
                    "required_marker": "SUBAGENT PROTOCOL",
                    "documentation": "skills/ct-orchestrator/references/SUBAGENT-PROTOCOL-BLOCK.md",
                    "reason": "Protocol block ensures subagents write to manifest and return standardized messages"
                }
            }
        }'
    fi

    return "${EXIT_PROTOCOL_MISSING:-60}"
}

# orchestrator_validate_return_message - Validate subagent return message format
#
# Args:
#   $1 = return message from subagent (required)
#
# Returns:
#   0 if valid format, 1 if invalid
#   Outputs JSON with validation result
#
# Example:
#   result=$(orchestrator_validate_return_message "$response")
#
orchestrator_validate_return_message() {
    local message="${1:-}"

    if [[ -z "$message" ]]; then
        _osp_error "Return message is required"
        jq -n '{
            "_meta": { "command": "orchestrator", "operation": "validate_return" },
            "success": false,
            "valid": false,
            "error": "Empty return message"
        }'
        return 1
    fi

    local status=""
    local valid=false

    # Check against allowed return message formats
    case "$message" in
        "Research complete. See MANIFEST.jsonl for summary.")
            status="complete"
            valid=true
            ;;
        "Research partial. See MANIFEST.jsonl for details.")
            status="partial"
            valid=true
            ;;
        "Research blocked. See MANIFEST.jsonl for blocker details.")
            status="blocked"
            valid=true
            ;;
        *)
            status="invalid"
            valid=false
            ;;
    esac

    if [[ "$valid" == "true" ]]; then
        _osp_debug "Valid return message: status=$status"
        jq -n \
            --arg status "$status" \
            --arg message "$message" \
            '{
                "_meta": { "command": "orchestrator", "operation": "validate_return" },
                "success": true,
                "valid": true,
                "status": $status,
                "message": $message
            }'
        return 0
    else
        _osp_error "PROTOCOL VIOLATION: Invalid return message format"
        jq -n \
            --arg message "$message" \
            '{
                "_meta": { "command": "orchestrator", "operation": "validate_return" },
                "success": false,
                "valid": false,
                "error": "Invalid return message format",
                "received": $message,
                "allowed": [
                    "Research complete. See MANIFEST.jsonl for summary.",
                    "Research partial. See MANIFEST.jsonl for details.",
                    "Research blocked. See MANIFEST.jsonl for blocker details."
                ]
            }'
        return 1
    fi
}

# orchestrator_verify_manifest_entry - Verify manifest entry exists after spawn
#
# Args:
#   $1 = research_id (required) - Expected manifest entry ID
#   $2 = manifest_path (optional) - Defaults to claudedocs/agent-outputs/MANIFEST.jsonl
#
# Returns:
#   0 if entry found, 1 if missing
#   Outputs JSON with verification result
#
# Example:
#   result=$(orchestrator_verify_manifest_entry "auth-research-2026-01-21")
#
orchestrator_verify_manifest_entry() {
    local research_id="${1:-}"
    local manifest_path="${2:-claudedocs/agent-outputs/MANIFEST.jsonl}"

    if [[ -z "$research_id" ]]; then
        _osp_error "research_id is required"
        jq -n '{
            "_meta": { "command": "orchestrator", "operation": "verify_manifest" },
            "success": false,
            "found": false,
            "error": "research_id is required"
        }'
        return 1
    fi

    if [[ ! -f "$manifest_path" ]]; then
        _osp_error "Manifest file not found: $manifest_path"
        jq -n \
            --arg path "$manifest_path" \
            '{
                "_meta": { "command": "orchestrator", "operation": "verify_manifest" },
                "success": false,
                "found": false,
                "error": "Manifest file not found",
                "path": $path
            }'
        return 1
    fi

    # Search for entry in manifest
    local entry
    entry=$(jq -s --arg id "$research_id" '.[] | select(.id == $id)' "$manifest_path" 2>/dev/null)

    if [[ -n "$entry" && "$entry" != "null" ]]; then
        _osp_debug "Manifest entry found: $research_id"
        local status file_name
        status=$(echo "$entry" | jq -r '.status // "unknown"')
        file_name=$(echo "$entry" | jq -r '.file // "unknown"')

        jq -n \
            --arg id "$research_id" \
            --arg status "$status" \
            --arg file "$file_name" \
            '{
                "_meta": { "command": "orchestrator", "operation": "verify_manifest" },
                "success": true,
                "found": true,
                "researchId": $id,
                "status": $status,
                "file": $file
            }'
        return 0
    else
        _osp_error "MANIFEST VERIFICATION FAILED: No entry for $research_id"
        jq -n \
            --arg id "$research_id" \
            --arg path "$manifest_path" \
            '{
                "_meta": { "command": "orchestrator", "operation": "verify_manifest" },
                "success": false,
                "found": false,
                "error": "Manifest entry not found",
                "researchId": $id,
                "manifestPath": $path,
                "action": "Re-spawn subagent with explicit manifest requirement"
            }'
        return 1
    fi
}

# orchestrator_get_protocol_block - Get the subagent protocol injection block
#
# Uses `cleo research inject` if available, otherwise returns inline block.
#
# Returns:
#   Protocol block content to stdout
#
# Example:
#   protocol=$(orchestrator_get_protocol_block)
#   prompt="${skill_content}\n\n${protocol}"
#
orchestrator_get_protocol_block() {
    # Try CLI first
    local protocol
    protocol=$(cleo research inject 2>/dev/null)

    if [[ -n "$protocol" ]]; then
        _osp_debug "Protocol block obtained via CLI"
        echo "$protocol"
        return 0
    fi

    # Fallback to inline block
    _osp_debug "Using inline protocol block (CLI unavailable)"
    cat << 'PROTOCOL_EOF'
## SUBAGENT PROTOCOL (RFC 2119 - MANDATORY)

OUTPUT REQUIREMENTS:
1. MUST write findings to: claudedocs/agent-outputs/YYYY-MM-DD_{topic-slug}.md
2. MUST append ONE line to: claudedocs/agent-outputs/MANIFEST.jsonl
3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. MUST NOT return research content in response.

Manifest entry format (single line):
{"id":"topic-YYYY-MM-DD","file":"YYYY-MM-DD_topic.md","title":"Title","date":"YYYY-MM-DD","status":"complete|partial|blocked","topics":["t1"],"key_findings":["Finding 1","Finding 2"],"actionable":true,"needs_followup":[]}
PROTOCOL_EOF
    return 0
}
