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

    # Step 6: Inject and return complete prompt
    # skill_inject handles: token setting, skill loading, protocol injection
    local prompt_content
    prompt_content=$(skill_inject "$skill_name" "$task_id" "$date_today" "$topic_slug")
    local inject_rc=$?

    if [[ $inject_rc -ne 0 ]]; then
        _osp_error "Skill injection failed"
        _osp_json_error "E_INJECTION_FAILED" "Failed to inject skill: $skill_name" "$skill_name"
        return "$inject_rc"
    fi

    # Build enhanced prompt with task context
    local output_file="${date_today}_${topic_slug}.md"
    local spawn_timestamp
    spawn_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

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
