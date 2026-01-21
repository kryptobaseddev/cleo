#!/usr/bin/env bash
# skill-dispatch.sh - Skill Dispatch Library for Orchestrator Protocol
#
# LAYER: 2 (Services - depends on Layer 1)
# DEPENDENCIES: exit-codes.sh, skill-validate.sh, token-inject.sh
# PROVIDES: skill_select_for_task, skill_dispatch_validate, skill_inject,
#           skill_get_dispatch_triggers, skill_matches_labels, skill_matches_keywords
#
# Enables orchestrator to automatically select skills based on task type/labels/keywords.
# Uses three matching strategies in priority order:
#   1. Label-based: task labels match skill tags in manifest
#   2. Type-based: task type (epic|task|subtask) maps to skill
#   3. Keyword-based: task title/description keywords match dispatch_triggers
#
# USAGE:
#   source lib/skill-dispatch.sh
#
#   # Select skill for a task
#   skill=$(skill_select_for_task "$task_json")
#
#   # Validate skill for use
#   if skill_dispatch_validate "ct-research-agent"; then
#       echo "Skill ready"
#   fi
#
#   # Inject skill into subagent prompt
#   prompt=$(skill_inject "ct-research-agent" "T1234" "2026-01-20" "topic-slug")

#=== SOURCE GUARD ================================================
[[ -n "${_SKILL_DISPATCH_LOADED:-}" ]] && return 0
declare -r _SKILL_DISPATCH_LOADED=1

set -euo pipefail

# Determine library directory
_SD_LIB_DIR="${BASH_SOURCE[0]%/*}"
[[ "$_SD_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _SD_LIB_DIR="."

# Determine project root (one level up from lib/)
_SD_PROJECT_ROOT="${_SD_LIB_DIR}/.."
[[ -d "${_SD_PROJECT_ROOT}/skills" ]] || _SD_PROJECT_ROOT="."

# Path to manifest.json (single source of truth)
_SD_MANIFEST_JSON="${_SD_PROJECT_ROOT}/skills/manifest.json"

# Path to subagent protocol base
_SD_PROTOCOL_BASE="${_SD_PROJECT_ROOT}/skills/_shared/subagent-protocol-base.md"

# Default fallback skill
readonly _SD_DEFAULT_SKILL="ct-task-executor"

# Source dependencies
# shellcheck source=lib/exit-codes.sh
source "${_SD_LIB_DIR}/exit-codes.sh"
# shellcheck source=lib/skill-validate.sh
source "${_SD_LIB_DIR}/skill-validate.sh"
# shellcheck source=lib/token-inject.sh
source "${_SD_LIB_DIR}/token-inject.sh"

# ============================================================================
# INTERNAL HELPERS
# ============================================================================

# Log debug message to stderr
# Args: $1 = message
_sd_debug() {
    [[ -n "${SKILL_DISPATCH_DEBUG:-}" ]] && echo "[skill-dispatch] DEBUG: $1" >&2
    return 0
}

# Log warning message to stderr
# Args: $1 = message
_sd_warn() {
    echo "[skill-dispatch] WARNING: $1" >&2
}

# Log error message to stderr
# Args: $1 = message
_sd_error() {
    echo "[skill-dispatch] ERROR: $1" >&2
}

# Log dispatch decision to stderr
# Args: $1 = skill_name, $2 = reason
_sd_log_dispatch() {
    local skill="$1"
    local reason="$2"
    echo "[skill-dispatch] Selected '$skill' (reason: $reason)" >&2
}

# Check if jq is available
# Returns: 0 if available, EXIT_DEPENDENCY_ERROR (5) if not
_sd_require_jq() {
    if ! command -v jq &>/dev/null; then
        _sd_error "jq is required but not found"
        return "$EXIT_DEPENDENCY_ERROR"
    fi
    return 0
}

# Check if manifest exists
# Returns: 0 if exists, EXIT_FILE_ERROR (3) if not
_sd_require_manifest() {
    if [[ ! -f "$_SD_MANIFEST_JSON" ]]; then
        _sd_error "Manifest not found: $_SD_MANIFEST_JSON"
        return "$EXIT_FILE_ERROR"
    fi
    return 0
}

# ============================================================================
# DISPATCH TRIGGER FUNCTIONS
# ============================================================================

# skill_get_dispatch_triggers - Get dispatch triggers for a skill
# Args: $1 = skill name
# Returns: 0 on success, EXIT_NOT_FOUND (4) if skill not found
# Output: JSON object with triggers {labels:[], keywords:[], types:[]}
# Note: Supports two formats:
#   1. New format: .dispatch_triggers = {labels:[], keywords:[], types:[]}
#   2. Legacy format: .capabilities.dispatch_triggers = ["phrase1", "phrase2"]
#      (converted to {keywords: [...]} for compatibility)
skill_get_dispatch_triggers() {
    local skill_name="$1"

    _sd_require_jq || return $?
    _sd_require_manifest || return $?

    local triggers
    # First try new format (top-level dispatch_triggers object)
    triggers=$(jq -r --arg name "$skill_name" \
        '.skills[] | select(.name == $name) | .dispatch_triggers // null' \
        "$_SD_MANIFEST_JSON" 2>/dev/null)

    # If new format exists and is an object, use it
    if [[ -n "$triggers" && "$triggers" != "null" ]]; then
        local is_object
        is_object=$(echo "$triggers" | jq 'type == "object"' 2>/dev/null || echo "false")
        if [[ "$is_object" == "true" ]]; then
            echo "$triggers"
            return 0
        fi
    fi

    # Try legacy format (capabilities.dispatch_triggers as array of strings)
    local legacy_triggers
    legacy_triggers=$(jq -r --arg name "$skill_name" \
        '.skills[] | select(.name == $name) | .capabilities.dispatch_triggers // []' \
        "$_SD_MANIFEST_JSON" 2>/dev/null)

    # Also get tags as fallback labels
    local tags
    tags=$(jq -r --arg name "$skill_name" \
        '.skills[] | select(.name == $name) | .tags // []' \
        "$_SD_MANIFEST_JSON" 2>/dev/null)

    # Combine legacy triggers with tags
    if [[ -n "$legacy_triggers" && "$legacy_triggers" != "null" && "$legacy_triggers" != "[]" ]]; then
        # Convert array of strings to {keywords: []} format, include tags as labels
        local labels_json="${tags:-[]}"
        [[ "$labels_json" == "null" ]] && labels_json="[]"
        echo "{\"keywords\": $legacy_triggers, \"labels\": $labels_json, \"types\": []}"
        return 0
    fi

    # Tags-only fallback
    if [[ -n "$tags" && "$tags" != "null" && "$tags" != "[]" ]]; then
        echo "{\"labels\": $tags, \"keywords\": [], \"types\": []}"
        return 0
    fi

    echo "{}"
    return 0
}

# skill_matches_labels - Check if task labels match skill's dispatch triggers
# Args: $1 = skill name, $2 = task labels (JSON array)
# Returns: 0 if match, 1 if no match
skill_matches_labels() {
    local skill_name="$1"
    local task_labels="$2"

    _sd_require_jq || return 1

    local triggers
    triggers=$(skill_get_dispatch_triggers "$skill_name")

    local skill_labels
    skill_labels=$(echo "$triggers" | jq -r '.labels // []')

    # Check if any task label matches any skill trigger label
    local match
    match=$(jq -n --argjson task "$task_labels" --argjson skill "$skill_labels" \
        '($task | if type == "array" then . else [] end) as $t |
         ($skill | if type == "array" then . else [] end) as $s |
         [($t[]? // empty) | select(. as $label | $s | index($label))] | length > 0')

    [[ "$match" == "true" ]]
}

# skill_matches_keywords - Check if task title/description matches skill's keywords
# Args: $1 = skill name, $2 = task title, $3 = task description
# Returns: 0 if match, 1 if no match
skill_matches_keywords() {
    local skill_name="$1"
    local title="$2"
    local description="$3"

    _sd_require_jq || return 1

    local triggers
    triggers=$(skill_get_dispatch_triggers "$skill_name")

    local keywords
    keywords=$(echo "$triggers" | jq -r '.keywords // [] | .[]?' 2>/dev/null)

    if [[ -z "$keywords" ]]; then
        return 1
    fi

    # Combine title and description for search (case-insensitive)
    local combined
    combined=$(echo "${title} ${description}" | tr '[:upper:]' '[:lower:]')

    # Check each keyword
    while IFS= read -r keyword; do
        [[ -z "$keyword" ]] && continue
        keyword_lower=$(echo "$keyword" | tr '[:upper:]' '[:lower:]')
        if [[ "$combined" == *"$keyword_lower"* ]]; then
            _sd_debug "Keyword match: '$keyword' in '$skill_name'"
            return 0
        fi
    done <<< "$keywords"

    return 1
}

# skill_matches_type - Check if task type matches skill's type triggers
# Args: $1 = skill name, $2 = task type (epic|task|subtask)
# Returns: 0 if match, 1 if no match
skill_matches_type() {
    local skill_name="$1"
    local task_type="$2"

    _sd_require_jq || return 1

    local triggers
    triggers=$(skill_get_dispatch_triggers "$skill_name")

    local types
    types=$(echo "$triggers" | jq -r '.types // []')

    # Check if task type is in skill's type triggers
    local match
    match=$(echo "$types" | jq -r --arg type "$task_type" 'index($type) != null')

    [[ "$match" == "true" ]]
}

# ============================================================================
# PUBLIC API - SELECTION
# ============================================================================

# skill_select_for_task - Select appropriate skill based on task metadata
# Args: $1 = task JSON (from cleo show --format json)
# Returns: 0 on success
# Output: Skill name to stdout
# Note: Uses three-tier dispatch: labels > type > keywords > default
skill_select_for_task() {
    local task_json="$1"

    _sd_require_jq || return $?
    _sd_require_manifest || return $?

    # Extract task metadata
    local task_type task_labels title description
    task_type=$(echo "$task_json" | jq -r '.task.type // "task"')
    task_labels=$(echo "$task_json" | jq -c '.task.labels // []')
    title=$(echo "$task_json" | jq -r '.task.title // ""')
    description=$(echo "$task_json" | jq -r '.task.description // ""')

    _sd_debug "Selecting skill for type='$task_type', labels=$task_labels"

    # Get list of active skills
    local active_skills
    active_skills=$(skill_list_all "active" | jq -r '.[]')

    # Strategy 1: Label-based matching (highest priority)
    while IFS= read -r skill; do
        [[ -z "$skill" ]] && continue
        if skill_matches_labels "$skill" "$task_labels"; then
            _sd_log_dispatch "$skill" "label match"
            echo "$skill"
            return 0
        fi
    done <<< "$active_skills"

    # Strategy 2: Type-based matching
    while IFS= read -r skill; do
        [[ -z "$skill" ]] && continue
        if skill_matches_type "$skill" "$task_type"; then
            _sd_log_dispatch "$skill" "type match ($task_type)"
            echo "$skill"
            return 0
        fi
    done <<< "$active_skills"

    # Strategy 3: Keyword-based matching
    while IFS= read -r skill; do
        [[ -z "$skill" ]] && continue
        if skill_matches_keywords "$skill" "$title" "$description"; then
            _sd_log_dispatch "$skill" "keyword match"
            echo "$skill"
            return 0
        fi
    done <<< "$active_skills"

    # Fallback to default
    _sd_log_dispatch "$_SD_DEFAULT_SKILL" "fallback (no match)"
    echo "$_SD_DEFAULT_SKILL"
    return 0
}

# ============================================================================
# PUBLIC API - VALIDATION
# ============================================================================

# skill_dispatch_validate - Validate skill can be used for dispatch
# Args: $1 = skill name
#       $2 = target model (optional)
# Returns: 0 if valid, appropriate exit code if not
# Output: Error messages to stderr on failure
# Note: Delegates to skill_validate_for_spawn from skill-validate.sh
skill_dispatch_validate() {
    local skill_name="$1"
    local target_model="${2:-}"

    # Delegate to skill-validate.sh's comprehensive validation
    local rc
    skill_validate_for_spawn "$skill_name" "$target_model"
    rc=$?

    if [[ "$rc" -ne 0 ]]; then
        _sd_error "Skill '$skill_name' failed validation"
        return "$rc"
    fi

    _sd_debug "Skill '$skill_name' passed validation"
    return 0
}

# ============================================================================
# PUBLIC API - INJECTION
# ============================================================================

# skill_inject - Inject skill into subagent prompt with protocol
# Args: $1 = skill name
#       $2 = task ID (for token injection)
#       $3 = date (for token injection)
#       $4 = topic slug (for token injection)
# Returns: 0 on success, appropriate exit code on failure
# Output: Full prompt content (skill + protocol) to stdout
skill_inject() {
    local skill_name="$1"
    local task_id="$2"
    local date="$3"
    local topic_slug="$4"

    _sd_require_jq || return $?

    # Validate skill first
    if ! skill_dispatch_validate "$skill_name"; then
        return $?
    fi

    # Get skill path
    local skill_path
    skill_path=$(skill_get_path "$skill_name")
    if [[ -z "$skill_path" ]]; then
        _sd_error "Could not get path for skill: $skill_name"
        return "$EXIT_NOT_FOUND"
    fi

    local skill_file="${_SD_PROJECT_ROOT}/${skill_path}/SKILL.md"
    if [[ ! -f "$skill_file" ]]; then
        _sd_error "Skill file not found: $skill_file"
        return "$EXIT_FILE_ERROR"
    fi

    # Set tokens for injection
    export TI_TASK_ID="$task_id"
    export TI_DATE="$date"
    export TI_TOPIC_SLUG="$topic_slug"

    # Set defaults
    ti_set_defaults

    # Load skill with token injection
    local skill_content
    skill_content=$(ti_load_template "$skill_file")

    # Load protocol base if exists
    local protocol_content=""
    if [[ -f "$_SD_PROTOCOL_BASE" ]]; then
        protocol_content=$(ti_load_template "$_SD_PROTOCOL_BASE")
    fi

    # Combine: protocol header + skill content
    if [[ -n "$protocol_content" ]]; then
        cat <<EOF
## Subagent Protocol (Auto-injected)

${protocol_content}

---

## Skill: ${skill_name}

${skill_content}
EOF
    else
        echo "$skill_content"
    fi

    return 0
}

# skill_inject_for_task - High-level function to inject skill for a CLEO task
# Args: $1 = task ID
#       $2 = skill override (optional, will auto-select if not provided)
# Returns: 0 on success, appropriate exit code on failure
# Output: Full prompt content to stdout
# Note: This is the primary entry point for orchestrators
skill_inject_for_task() {
    local task_id="$1"
    local skill_override="${2:-}"

    _sd_require_jq || return $?

    # Get task JSON
    local task_json
    task_json=$(cleo show "$task_id" --format json 2>/dev/null)
    if [[ -z "$task_json" || "$task_json" == "null" ]]; then
        _sd_error "Could not fetch task: $task_id"
        return "$EXIT_NOT_FOUND"
    fi

    # Determine skill
    local skill_name
    if [[ -n "$skill_override" ]]; then
        skill_name="$skill_override"
        _sd_debug "Using skill override: $skill_name"
    else
        skill_name=$(skill_select_for_task "$task_json")
    fi

    # Extract task metadata for tokens
    local title date_today topic_slug
    title=$(echo "$task_json" | jq -r '.task.title // "untitled"')
    date_today=$(date +%Y-%m-%d)

    # Generate topic slug from title
    topic_slug=$(echo "$title" | tr '[:upper:]' '[:lower:]' | \
                 sed -E 's/[^a-z0-9]+/-/g' | sed -E 's/^-+|-+$//g')
    [[ -z "$topic_slug" ]] && topic_slug="task-${task_id}"

    # Set task context tokens from task JSON (TI_TASK_TITLE, TI_TASK_DESCRIPTION, etc.)
    # This matches the pattern in orchestrator-spawn.sh
    if ! ti_set_task_context "$task_json"; then
        _sd_warn "Failed to set task context tokens - continuing with defaults"
    else
        _sd_debug "Task context tokens set: TASK_TITLE='${TI_TASK_TITLE:-}', TOPICS_JSON='${TI_TOPICS_JSON:-}'"
    fi

    # Inject skill with tokens
    skill_inject "$skill_name" "$task_id" "$date_today" "$topic_slug"
}

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

# skill_list_with_triggers - List all skills with their dispatch triggers
# Args: none
# Returns: 0 on success
# Output: JSON array with skill names and triggers
skill_list_with_triggers() {
    _sd_require_jq || return $?
    _sd_require_manifest || return $?

    jq '[.skills[] | {name: .name, status: .status, dispatch_triggers: (.dispatch_triggers // {})}]' \
        "$_SD_MANIFEST_JSON" 2>/dev/null
    return 0
}

# skill_find_by_trigger - Find skills matching a specific trigger
# Args: $1 = trigger type (labels|keywords|types)
#       $2 = trigger value
# Returns: 0 on success
# Output: JSON array of matching skill names
skill_find_by_trigger() {
    local trigger_type="$1"
    local trigger_value="$2"

    _sd_require_jq || return $?
    _sd_require_manifest || return $?

    case "$trigger_type" in
        labels)
            jq -r --arg val "$trigger_value" \
                '[.skills[] | select(.dispatch_triggers.labels[]? == $val) | .name]' \
                "$_SD_MANIFEST_JSON" 2>/dev/null
            ;;
        keywords)
            jq -r --arg val "$trigger_value" \
                '[.skills[] | select(.dispatch_triggers.keywords[]? == $val) | .name]' \
                "$_SD_MANIFEST_JSON" 2>/dev/null
            ;;
        types)
            jq -r --arg val "$trigger_value" \
                '[.skills[] | select(.dispatch_triggers.types[]? == $val) | .name]' \
                "$_SD_MANIFEST_JSON" 2>/dev/null
            ;;
        *)
            _sd_error "Invalid trigger type: $trigger_type (use labels|keywords|types)"
            return "$EXIT_INVALID_INPUT"
            ;;
    esac

    return 0
}

# ============================================================================
# EXPORT FUNCTIONS
# ============================================================================

export -f skill_select_for_task
export -f skill_dispatch_validate
export -f skill_inject
export -f skill_inject_for_task
export -f skill_get_dispatch_triggers
export -f skill_matches_labels
export -f skill_matches_keywords
export -f skill_matches_type
export -f skill_list_with_triggers
export -f skill_find_by_trigger
