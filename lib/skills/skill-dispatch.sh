#!/usr/bin/env bash
# skill-dispatch.sh - Skill Dispatch Library for Orchestrator Protocol
#
# ARCHITECTURE NOTE (Universal Subagent Architecture):
#   All spawns use a single agent type: 'cleo-subagent'
#   Skills (ct-research-agent, ct-task-executor, etc.) are PROTOCOL IDENTIFIERS,
#   NOT separate agent types. They are injected as context into cleo-subagent.
#   The '-agent' suffix in skill names is legacy naming - they are skills/protocols.
#
# LAYER: 2 (Services - depends on Layer 1)
# DEPENDENCIES: exit-codes.sh, skill-validate.sh, token-inject.sh
# PROVIDES:
#   # Spec-compliant API (CLEO-SKILLS-SYSTEM-SPEC.md)
#   skill_dispatch_by_keywords   - Match task to skill by keyword patterns
#   skill_dispatch_by_type       - Match by task type
#   skill_dispatch_by_protocol   - Match by protocol name (7 conditional protocols)
#   skill_dispatch_by_category   - Match by skill category (taxonomy-based)
#   get_skills_by_category       - Get skills in a category
#   skill_get_tier               - Get tier level for a skill
#   skill_is_tier                - Check if skill is at specific tier
#   skill_get_metadata           - Get full skill metadata
#   skill_get_references         - Get reference files for progressive loading
#   skill_check_compatibility    - Check Claude Code subagent type compatibility
#   skill_list_by_tier           - List skills at tier level
#   skill_auto_dispatch          - Auto-select skill for CLEO task
#   skill_prepare_spawn          - Generate spawn context JSON with resolved prompt
#
#   # Original API
#   skill_select_for_task, skill_dispatch_validate, skill_inject,
#   skill_get_dispatch_triggers, skill_matches_labels, skill_matches_keywords
#
# Enables orchestrator to automatically select skills based on task type/labels/keywords/categories.
# Uses multiple matching strategies in priority order:
#   1. Category-based: task labels or keywords map to skill category taxonomy
#   2. Keyword-based: task title/description keywords match dispatch_triggers
#   3. Label-based: task labels match skill tags in manifest
#   4. Type-based: task type (epic|task|subtask) maps to skill
#
# USAGE:
#   source lib/skills/skill-dispatch.sh
#
#   # Spec-compliant API (recommended for Universal Subagent Architecture)
#   # 1. Select skill protocol based on task
#   skill=$(skill_auto_dispatch "T1234")  # Returns skill name (protocol identifier)
#   skill=$(skill_dispatch_by_keywords "implement auth middleware")
#   skill=$(skill_dispatch_by_category "research")  # Category-based selection
#
#   # 2. Get skills by category or tier
#   get_skills_by_category "execution"    # Get skills in execution category
#   skill_list_by_tier 2                  # List tier 2 skills
#   skill_get_tier "ct-research-agent"    # Get tier number
#
#   # 3. Prepare spawn context with fully-resolved prompt
#   context=$(skill_prepare_spawn "$skill" "T1234")  # Returns JSON with prompt for cleo-subagent
#
#   # 4. Spawn cleo-subagent with Task tool using context.prompt
#   #    NOTE: The skill name identifies the protocol, NOT the agent type.
#   #    All spawns use subagent_type: "cleo-subagent"
#
#   # Original API (still functional)
#   skill=$(skill_select_for_task "$task_json")
#
#   # Validate skill protocol for use
#   if skill_dispatch_validate "ct-research-agent"; then
#       echo "Skill protocol ready"
#   fi
#
#   # Inject skill protocol into prompt (used internally by skill_prepare_spawn)
#   prompt=$(skill_inject "ct-research-agent" "T1234" "2026-01-20" "topic-slug")

#=== SOURCE GUARD ================================================
[[ -n "${_SKILL_DISPATCH_LOADED:-}" ]] && return 0
declare -r _SKILL_DISPATCH_LOADED=1

set -euo pipefail

# Determine library directory
_SD_LIB_DIR="${BASH_SOURCE[0]%/*}/.."
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
# shellcheck source=lib/core/exit-codes.sh
source "${_SD_LIB_DIR}/core/exit-codes.sh"
# shellcheck source=lib/skills/skill-validate.sh
source "${_SD_LIB_DIR}/skills/skill-validate.sh"
# shellcheck source=lib/skills/token-inject.sh
source "${_SD_LIB_DIR}/skills/token-inject.sh"
# shellcheck source=lib/metrics/token-estimation.sh
source "${_SD_LIB_DIR}/metrics/token-estimation.sh"

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
# CATEGORY MAPPING & TIER FUNCTIONS
# ============================================================================

# Skill category taxonomy mapping (from T2434)
# Categories: research, execution, planning, documentation, testing, validation
readonly -A _SD_CATEGORY_MAP=(
    ["research"]="ct-research-agent"
    ["execution"]="ct-task-executor"
    ["planning"]="ct-epic-architect"
    ["documentation"]="ct-documentor"
    ["testing"]="ct-test-writer-bats"
    ["validation"]="ct-validator"
    ["specification"]="ct-spec-writer"
    ["bash-library"]="ct-library-implementer-bash"
    ["workflow"]="ct-dev-workflow"
    ["orchestration"]="ct-orchestrator"
)

# get_skills_by_category - Get skills matching a category
# Args: $1 = category name (research|execution|planning|documentation|testing|validation)
# Returns: 0 on success, EXIT_NOT_FOUND (4) if no match
# Output: Skill names matching category (one per line)
get_skills_by_category() {
    local category="$1"

    _sd_require_jq || return $?
    _sd_require_manifest || return $?

    # First check taxonomy mapping
    if [[ -n "${_SD_CATEGORY_MAP[$category]:-}" ]]; then
        local skill="${_SD_CATEGORY_MAP[$category]}"
        # Verify skill exists and is active
        local exists
        exists=$(jq -r --arg name "$skill" \
            '.skills[] | select(.name == $name and .status == "active") | .name' \
            "$_SD_MANIFEST_JSON" 2>/dev/null)

        if [[ -n "$exists" ]]; then
            echo "$exists"
            return 0
        fi
    fi

    # Fallback: search by tags
    local results
    results=$(jq -r --arg cat "$category" \
        '.skills[] | select(.status == "active") | select(.tags[]? == $cat) | .name' \
        "$_SD_MANIFEST_JSON" 2>/dev/null)

    if [[ -n "$results" ]]; then
        echo "$results"
        return 0
    fi

    return "$EXIT_NOT_FOUND"
}

# skill_dispatch_by_category - Match task to skill by category
# Args: $1 = category name OR task type that maps to category
# Returns: 0 on success, 1 if no match
# Output: Skill name or empty if no match
skill_dispatch_by_category() {
    local input="$1"
    local category=""

    _sd_require_jq || return 1
    _sd_require_manifest || return 1

    # Map task type to category if needed
    case "$input" in
        # Direct category names
        research|execution|planning|documentation|testing|validation|specification|bash-library|workflow|orchestration)
            category="$input"
            ;;
        # Task type mappings
        investigate|explore|discover)
            category="research"
            ;;
        implement|build|execute|create)
            category="execution"
            ;;
        epic|architect|decompose)
            category="planning"
            ;;
        doc|docs|document|readme|guide)
            category="documentation"
            ;;
        test|bats|coverage)
            category="testing"
            ;;
        validate|verify|audit|compliance)
            category="validation"
            ;;
        spec|rfc|protocol|contract)
            category="specification"
            ;;
        "lib/"|bash|shell|library)
            category="bash-library"
            ;;
        commit|release|version)
            category="workflow"
            ;;
        orchestrate|coordinate|delegate)
            category="orchestration"
            ;;
        *)
            # No match
            return 1
            ;;
    esac

    # Get skill for category
    local skill
    skill=$(get_skills_by_category "$category" | head -1)

    if [[ -n "$skill" ]]; then
        _sd_debug "Category dispatch: '$category' -> $skill"
        echo "$skill"
        return 0
    fi

    return 1
}

# skill_get_tier - Get tier level for a skill
# Args: $1 = skill name
# Returns: 0 on success
# Output: Tier number (0-3) or "unknown"
skill_get_tier() {
    local skill_name="$1"

    _sd_require_jq || return $?
    _sd_require_manifest || return $?

    local tier
    tier=$(jq -r --arg name "$skill_name" \
        '.skills[] | select(.name == $name) | .tier // "unknown"' \
        "$_SD_MANIFEST_JSON" 2>/dev/null)

    echo "$tier"
    return 0
}

# skill_is_tier - Check if skill is at specific tier
# Args: $1 = skill name, $2 = tier number (0-3)
# Returns: 0 if match, 1 if no match
skill_is_tier() {
    local skill_name="$1"
    local target_tier="$2"

    local current_tier
    current_tier=$(skill_get_tier "$skill_name")

    [[ "$current_tier" == "$target_tier" ]]
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

# _sd_skill_to_protocol - Map skill name to conditional protocol type
# Args: $1 = skill name
# Output: protocol type name (research, consensus, specification, etc.)
_sd_skill_to_protocol() {
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
        ct-test-writer*|*test-writer*)
            echo "testing"
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

# skill_inject - Inject skill into subagent prompt with protocol
# Args: $1 = skill name
#       $2 = task ID (for token injection)
#       $3 = date (for token injection)
#       $4 = topic slug (for token injection)
# Returns: 0 on success, appropriate exit code on failure
# Output: Full prompt content (conditional protocol + base protocol + skill) to stdout
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

    # Map skill to protocol type
    local protocol_type
    protocol_type=$(_sd_skill_to_protocol "$skill_name")

    # Load conditional protocol if exists
    local conditional_protocol=""
    local conditional_protocol_file="${_SD_PROJECT_ROOT}/protocols/${protocol_type}.md"
    if [[ -f "$conditional_protocol_file" ]]; then
        conditional_protocol=$(ti_load_template "$conditional_protocol_file")
        _sd_debug "Loaded conditional protocol: ${protocol_type}.md"
    else
        _sd_debug "No conditional protocol found: ${conditional_protocol_file}"
    fi

    # Load protocol base if exists
    local protocol_content=""
    if [[ -f "$_SD_PROTOCOL_BASE" ]]; then
        protocol_content=$(ti_load_template "$_SD_PROTOCOL_BASE")
    fi

    # Combine: conditional protocol + base protocol + skill content
    # Order: conditional first, then base, then skill
    if [[ -n "$conditional_protocol" ]] || [[ -n "$protocol_content" ]]; then
        cat <<EOF
## Subagent Protocol (Auto-injected)

EOF
        # Add conditional protocol if present
        if [[ -n "$conditional_protocol" ]]; then
            cat <<EOF
### Conditional Protocol: ${protocol_type}

${conditional_protocol}

---

EOF
        fi

        # Add base protocol if present
        if [[ -n "$protocol_content" ]]; then
            cat <<EOF
### Base Protocol

${protocol_content}

---

EOF
        fi

        # Add skill content
        cat <<EOF
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
# SPEC-COMPLIANT API (from CLEO-SKILLS-SYSTEM-SPEC.md)
# These 8 functions implement the programmatic dispatch interface
# ============================================================================

# skill_dispatch_by_keywords - Match task description to skill by keyword patterns
# Usage: skill_dispatch_by_keywords "implement auth middleware"
# Returns: skill name or empty if no match
# Uses dispatch_matrix.by_keyword if available, otherwise searches dispatch_triggers
skill_dispatch_by_keywords() {
    local query="$1"
    local query_lower

    _sd_require_jq || return $?
    _sd_require_manifest || return $?

    query_lower=$(echo "$query" | tr '[:upper:]' '[:lower:]')

    # First try dispatch_matrix.by_keyword if it exists in manifest
    local matrix_result
    matrix_result=$(jq -r --arg query "$query_lower" '
        .dispatch_matrix.by_keyword // {} |
        to_entries[] |
        select(.key | split("|") | any(. as $p | $query | test($p; "i"))) |
        .value
    ' "$_SD_MANIFEST_JSON" 2>/dev/null | head -1)

    if [[ -n "$matrix_result" ]]; then
        echo "$matrix_result"
        return 0
    fi

    # Fallback: search dispatch_triggers in each skill
    local skills
    skills=$(jq -r '.skills[] | select(.status == "active") | .name' "$_SD_MANIFEST_JSON" 2>/dev/null)

    while IFS= read -r skill; do
        [[ -z "$skill" ]] && continue

        # Check both legacy and new format triggers
        local triggers
        triggers=$(jq -r --arg name "$skill" '
            .skills[] | select(.name == $name) |
            (.capabilities.dispatch_triggers // []) +
            (.dispatch_triggers.keywords // []) |
            .[]
        ' "$_SD_MANIFEST_JSON" 2>/dev/null)

        while IFS= read -r trigger; do
            [[ -z "$trigger" ]] && continue
            local trigger_lower
            trigger_lower=$(echo "$trigger" | tr '[:upper:]' '[:lower:]')
            if [[ "$query_lower" == *"$trigger_lower"* ]]; then
                _sd_debug "Keyword dispatch: '$trigger' matched -> $skill"
                echo "$skill"
                return 0
            fi
        done <<< "$triggers"
    done <<< "$skills"

    # No match
    return 0
}

# skill_dispatch_by_type - Match task to skill by task type
# Usage: skill_dispatch_by_type "research"
# Returns: skill name or empty if no match
# Uses dispatch_matrix.by_task_type if available
skill_dispatch_by_type() {
    local task_type="$1"

    _sd_require_jq || return $?
    _sd_require_manifest || return $?

    # Try dispatch_matrix.by_task_type first
    local result
    result=$(jq -r --arg type "$task_type" \
        '.dispatch_matrix.by_task_type[$type] // empty' \
        "$_SD_MANIFEST_JSON" 2>/dev/null)

    if [[ -n "$result" ]]; then
        echo "$result"
        return 0
    fi

    # Fallback: infer from skill tags
    local mapping
    case "$task_type" in
        research|investigation|explore)
            mapping="research"
            ;;
        planning|architecture|epic)
            mapping="planning"
            ;;
        implementation|build|execute)
            mapping="execution"
            ;;
        testing|test|bats)
            mapping="testing"
            ;;
        documentation|docs|doc)
            mapping="documentation"
            ;;
        specification|spec|rfc)
            mapping="specification"
            ;;
        validation|verify|audit)
            mapping="validation"
            ;;
        bash|shell|library)
            mapping="bash"
            ;;
        *)
            mapping=""
            ;;
    esac

    if [[ -n "$mapping" ]]; then
        # Find skill with matching tag
        result=$(jq -r --arg tag "$mapping" \
            '.skills[] | select(.status == "active") | select(.tags[]? == $tag) | .name' \
            "$_SD_MANIFEST_JSON" 2>/dev/null | head -1)

        if [[ -n "$result" ]]; then
            echo "$result"
            return 0
        fi
    fi

    return 0
}

# skill_dispatch_by_protocol - Match protocol name to skill
# Usage: skill_dispatch_by_protocol "research"
# Returns: skill name or empty if no match
# Uses dispatch_matrix.by_protocol if available
# Supports 7 conditional protocols: research, consensus, specification,
# decomposition, implementation, contribution, release
skill_dispatch_by_protocol() {
    local protocol_name="$1"

    _sd_require_jq || return $?
    _sd_require_manifest || return $?

    # Try dispatch_matrix.by_protocol first
    local result
    result=$(jq -r --arg proto "$protocol_name" \
        '.dispatch_matrix.by_protocol[$proto] // empty' \
        "$_SD_MANIFEST_JSON" 2>/dev/null)

    if [[ -n "$result" ]]; then
        _sd_debug "Protocol dispatch: '$protocol_name' -> $result"
        echo "$result"
        return 0
    fi

    # Fallback: map protocol to skill by convention
    local skill_name
    case "$protocol_name" in
        research)
            skill_name="ct-research-agent"
            ;;
        consensus)
            skill_name="ct-validator"
            ;;
        specification)
            skill_name="ct-spec-writer"
            ;;
        decomposition)
            skill_name="ct-epic-architect"
            ;;
        implementation)
            skill_name="ct-task-executor"
            ;;
        contribution)
            skill_name="ct-task-executor"
            ;;
        release)
            skill_name="ct-dev-workflow"
            ;;
        *)
            _sd_debug "Protocol dispatch: unknown protocol '$protocol_name'"
            return 0
            ;;
    esac

    # Verify skill exists
    if skill_exists "$skill_name"; then
        _sd_debug "Protocol dispatch fallback: '$protocol_name' -> $skill_name"
        echo "$skill_name"
        return 0
    fi

    return 0
}

# skill_get_metadata - Get full skill metadata from manifest
# Usage: skill_get_metadata "ct-research-agent"
# Returns: JSON object with all skill fields
skill_get_metadata() {
    local skill_name="$1"

    _sd_require_jq || return $?
    _sd_require_manifest || return $?

    local metadata
    metadata=$(jq -r --arg name "$skill_name" \
        '.skills[] | select(.name == $name)' \
        "$_SD_MANIFEST_JSON" 2>/dev/null)

    if [[ -z "$metadata" || "$metadata" == "null" ]]; then
        _sd_error "Skill not found: $skill_name"
        return "$EXIT_NOT_FOUND"
    fi

    echo "$metadata"
    return 0
}

# skill_get_references - Get reference files for progressive loading
# Usage: skill_get_references "ct-orchestrator"
# Returns: One reference path per line (relative to skill path)
skill_get_references() {
    local skill_name="$1"

    _sd_require_jq || return $?
    _sd_require_manifest || return $?

    local metadata
    metadata=$(skill_get_metadata "$skill_name") || return $?

    # Get references array from metadata
    local refs
    refs=$(echo "$metadata" | jq -r '.references[]? // empty' 2>/dev/null)

    if [[ -n "$refs" ]]; then
        echo "$refs"
        return 0
    fi

    # Fallback: check for references/ directory in skill path
    local skill_path
    skill_path=$(echo "$metadata" | jq -r '.path // ""')

    if [[ -n "$skill_path" && -d "${_SD_PROJECT_ROOT}/${skill_path}/references" ]]; then
        # List markdown files in references directory
        find "${_SD_PROJECT_ROOT}/${skill_path}/references" -name "*.md" -type f 2>/dev/null | \
            sed "s|${_SD_PROJECT_ROOT}/${skill_path}/||"
    fi

    return 0
}

# skill_check_compatibility - Check subagent type compatibility
# Usage: skill_check_compatibility "ct-research-agent" "general-purpose"
# Returns: 0 if compatible, 1 if not compatible
skill_check_compatibility() {
    local skill_name="$1"
    local subagent_type="$2"

    _sd_require_jq || return $?
    _sd_require_manifest || return $?

    local metadata
    metadata=$(skill_get_metadata "$skill_name") || return 1

    # Get compatible_subagent_types array
    local compatible
    compatible=$(echo "$metadata" | jq -r --arg type "$subagent_type" \
        '.capabilities.compatible_subagent_types // [] | index($type) != null' \
        2>/dev/null)

    if [[ "$compatible" == "true" ]]; then
        return 0
    fi

    # If no types specified, assume compatible with general-purpose
    local types_count
    types_count=$(echo "$metadata" | jq -r '.capabilities.compatible_subagent_types | length // 0' 2>/dev/null)

    if [[ "$types_count" == "0" && "$subagent_type" == "general-purpose" ]]; then
        return 0
    fi

    return 1
}

# skill_list_by_tier - List skills at specific tier level
# Usage: skill_list_by_tier 2
# Returns: One skill name per line
skill_list_by_tier() {
    local tier="$1"

    _sd_require_jq || return $?
    _sd_require_manifest || return $?

    # Check if tier field exists in manifest
    local has_tier
    has_tier=$(jq '.skills[0].tier // null' "$_SD_MANIFEST_JSON" 2>/dev/null)

    if [[ "$has_tier" != "null" ]]; then
        jq -r --argjson tier "$tier" \
            '.skills[] | select(.tier == $tier) | .name' \
            "$_SD_MANIFEST_JSON" 2>/dev/null
    else
        # Fallback: infer tier from skill characteristics
        # Tier 0: orchestrator
        # Tier 1: planning/architecture (ct-epic-architect)
        # Tier 2: execution skills (ct-task-executor, ct-research-agent, etc.)
        # Tier 3: domain/chaining skills (ct-documentor, ct-skill-*)
        case "$tier" in
            0)
                jq -r '.skills[] | select(.name | test("orchestrator")) | .name' \
                    "$_SD_MANIFEST_JSON" 2>/dev/null
                ;;
            1)
                jq -r '.skills[] | select(.name | test("epic-architect|planner")) | .name' \
                    "$_SD_MANIFEST_JSON" 2>/dev/null
                ;;
            2)
                jq -r '.skills[] | select(.name | test("executor|research|test-writer|spec-writer|library-impl|validator|dev-workflow")) | .name' \
                    "$_SD_MANIFEST_JSON" 2>/dev/null
                ;;
            3)
                jq -r '.skills[] | select(.name | test("documentor|skill-|docs-")) | .name' \
                    "$_SD_MANIFEST_JSON" 2>/dev/null
                ;;
            *)
                _sd_warn "Unknown tier: $tier"
                return 0
                ;;
        esac
    fi

    return 0
}

# skill_auto_dispatch - Auto-select skill for a CLEO task
# Usage: skill_auto_dispatch "T1234"
# Returns: skill name (defaults to ct-task-executor if no match)
# Priority: Explicit > Category > Keywords > Labels > Type > Default
skill_auto_dispatch() {
    local task_id="$1"

    _sd_require_jq || return $?

    # Get task details from cleo
    local task_json
    task_json=$(cleo show "$task_id" --format json 2>/dev/null)

    if [[ -z "$task_json" || "$task_json" == "null" ]]; then
        _sd_error "Task $task_id not found"
        echo "$_SD_DEFAULT_SKILL"
        return 1
    fi

    # Extract task metadata
    local title description labels task_type
    title=$(echo "$task_json" | jq -r '.task.title // ""')
    description=$(echo "$task_json" | jq -r '.task.description // ""')
    labels=$(echo "$task_json" | jq -r '.task.labels[]? // empty' 2>/dev/null | tr '\n' ' ')
    task_type=$(echo "$task_json" | jq -r '.task.type // "task"')

    # Combine text for matching
    local full_text="$title $description $labels"

    _sd_debug "Auto-dispatch for $task_id: '$full_text'"

    local skill

    # Strategy 1: Try category-based dispatch from labels
    for label in $labels; do
        skill=$(skill_dispatch_by_category "$label" 2>/dev/null)
        if [[ -n "$skill" ]]; then
            _sd_log_dispatch "$skill" "category match ($label) for $task_id"
            echo "$skill"
            return 0
        fi
    done

    # Strategy 2: Try category-based dispatch from title/description keywords
    local category_keywords="research investigate explore implement build execute epic plan document test validate verify audit"
    for keyword in $category_keywords; do
        if [[ "$full_text" == *"$keyword"* ]]; then
            skill=$(skill_dispatch_by_category "$keyword" 2>/dev/null)
            if [[ -n "$skill" ]]; then
                _sd_log_dispatch "$skill" "category keyword match ($keyword) for $task_id"
                echo "$skill"
                return 0
            fi
        fi
    done

    # Strategy 3: Try keyword-based dispatch
    skill=$(skill_dispatch_by_keywords "$full_text")

    if [[ -n "$skill" ]]; then
        _sd_log_dispatch "$skill" "keyword match for $task_id"
        echo "$skill"
        return 0
    fi

    # Strategy 4: Try label-based type dispatch
    for label in $labels; do
        skill=$(skill_dispatch_by_type "$label")
        if [[ -n "$skill" ]]; then
            _sd_log_dispatch "$skill" "type match ($label) for $task_id"
            echo "$skill"
            return 0
        fi
    done

    # Strategy 5: Use existing skill_select_for_task for label/keyword matching
    skill=$(skill_select_for_task "$task_json")

    if [[ -n "$skill" && "$skill" != "$_SD_DEFAULT_SKILL" ]]; then
        _sd_log_dispatch "$skill" "task metadata match for $task_id"
        echo "$skill"
        return 0
    fi

    # Default fallback
    _sd_log_dispatch "$_SD_DEFAULT_SKILL" "fallback for $task_id"
    echo "$_SD_DEFAULT_SKILL"
    return 0
}

# skill_prepare_spawn - Generate spawn context JSON for a skill and task with FULL token pre-resolution
# Usage: skill_prepare_spawn "ct-research-agent" "T1234"
# Returns: JSON object with spawn configuration including fully-resolved prompt content
#
# This function is the primary entry point for orchestrator spawning. It:
#   1. Gets skill metadata and validates it
#   2. Sets ALL context tokens from task data (ti_set_full_context)
#   3. Populates skill-specific tokens
#   4. Loads and injects skill template with ALL tokens resolved
#   5. Verifies no unresolved {{TOKEN}} patterns remain
#   6. Returns complete spawn context with ready-to-use prompt
#
# The output JSON includes a "prompt" field containing the FULLY RESOLVED prompt
# that subagents receive - no placeholders should remain.
skill_prepare_spawn() {
    local skill_name="$1"
    local task_id="$2"

    _sd_require_jq || return $?

    local metadata
    metadata=$(skill_get_metadata "$skill_name")

    if [[ -z "$metadata" || "$metadata" == "null" ]]; then
        _sd_error "Could not get metadata for skill: $skill_name"
        return "$EXIT_NOT_FOUND"
    fi

    # Extract fields from metadata
    local skill_path token_budget model tier
    skill_path=$(echo "$metadata" | jq -r '.path // ""')
    token_budget=$(echo "$metadata" | jq -r '.token_budget // 10000')
    model=$(echo "$metadata" | jq -r '.model // "auto"')
    tier=$(echo "$metadata" | jq -r '.tier // 2')

    # Handle null model
    [[ "$model" == "null" ]] && model="auto"

    # Get skill file path
    local skill_file="${skill_path}/SKILL.md"
    local full_skill_path="${_SD_PROJECT_ROOT}/${skill_file}"

    # Get references
    local references
    references=$(skill_get_references "$skill_name" | jq -R -s -c 'split("\n") | map(select(. != ""))' 2>/dev/null)
    [[ -z "$references" ]] && references="[]"

    # =========================================================================
    # FULL TOKEN PRE-RESOLUTION (T2405 Enhancement)
    # =========================================================================

    _sd_debug "Setting full context for task: $task_id"

    # Step 1: Set ALL context tokens from task data
    # This populates: TASK_ID, DATE, TOPIC_SLUG, EPIC_ID, SESSION_ID, PARENT_ID,
    # TITLE, RESEARCH_ID, TASK_TITLE, TASK_DESCRIPTION, TOPICS_JSON, DEPENDS_LIST,
    # ACCEPTANCE_CRITERIA, DELIVERABLES_LIST, MANIFEST_SUMMARIES, NEXT_TASK_IDS,
    # and all command defaults
    if ! ti_set_full_context "$task_id"; then
        _sd_error "Failed to set full context for task: $task_id"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Step 2: Populate skill-specific tokens (if skill defines them)
    # This maps skill name to skillSpecific section in placeholders.json
    local skill_key
    case "$skill_name" in
        ct-epic-architect)
            skill_key="epicArchitect"
            ;;
        ct-validator)
            skill_key="validator"
            ;;
        ct-task-executor)
            skill_key="taskExecutor"
            ;;
        *)
            skill_key=""
            ;;
    esac

    if [[ -n "$skill_key" ]]; then
        _sd_debug "Populating skill-specific tokens for: $skill_key"
        ti_populate_skill_specific_tokens "$skill_key" || true  # Don't fail if no specific tokens
    fi

    # Step 3: Load skill template with full injection
    local skill_content=""
    if [[ -f "$full_skill_path" ]]; then
        _sd_debug "Loading skill template: $full_skill_path"
        skill_content=$(ti_load_template "$full_skill_path")
    else
        _sd_warn "Skill file not found: $full_skill_path"
    fi

    # Step 4: Load and inject protocol base (if exists)
    local protocol_content=""
    if [[ -f "$_SD_PROTOCOL_BASE" ]]; then
        _sd_debug "Loading protocol base: $_SD_PROTOCOL_BASE"
        protocol_content=$(ti_load_template "$_SD_PROTOCOL_BASE")
    fi

    # Step 5: Combine into full prompt with protocol header
    local full_prompt
    if [[ -n "$protocol_content" ]]; then
        full_prompt="## Subagent Protocol (Auto-injected)

${protocol_content}

---

## Skill: ${skill_name}

${skill_content}"
    else
        full_prompt="$skill_content"
    fi

    # Step 6: Final token injection pass (catch any nested/computed tokens)
    full_prompt=$(ti_inject_tokens "$full_prompt")

    # Step 7: CRITICAL - Verify all tokens are resolved
    local unresolved_count=0
    local unresolved_tokens=""
    unresolved_tokens=$(echo "$full_prompt" | grep -oE '\{\{[A-Z_]+\}\}' | sort -u || true)

    if [[ -n "$unresolved_tokens" ]]; then
        unresolved_count=$(echo "$unresolved_tokens" | wc -l)
        _sd_warn "Found $unresolved_count unresolved token(s) after injection:"
        echo "$unresolved_tokens" | while IFS= read -r token; do
            [[ -n "$token" ]] && echo "  - $token" >&2
        done
    fi

    # Step 8: Track skill injection for token metrics
    local estimated_tokens
    estimated_tokens=$(estimate_tokens "$full_prompt")
    if declare -f track_skill_injection >/dev/null 2>&1; then
        track_skill_injection "$skill_name" "$tier" "$estimated_tokens" "$task_id" 2>/dev/null || true
    fi

    # Extract additional context for JSON output
    local date_today topic_slug epic_id title
    date_today="${TI_DATE:-$(date +%Y-%m-%d)}"
    topic_slug="${TI_TOPIC_SLUG:-task-${task_id}}"
    epic_id="${TI_EPIC_ID:-}"
    title="${TI_TITLE:-untitled}"
    local output_file="${date_today}_${topic_slug}.md"
    local spawn_timestamp
    spawn_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Build spawn context JSON with fully resolved prompt
    jq -n \
        --arg skill "$skill_name" \
        --arg path "$skill_path" \
        --arg task "$task_id" \
        --argjson budget "$token_budget" \
        --arg model "$model" \
        --argjson tier "$tier" \
        --argjson refs "$references" \
        --arg skillFile "$skill_file" \
        --arg prompt "$full_prompt" \
        --arg date "$date_today" \
        --arg topicSlug "$topic_slug" \
        --arg epicId "$epic_id" \
        --arg title "$title" \
        --arg outputFile "$output_file" \
        --arg timestamp "$spawn_timestamp" \
        --argjson unresolvedCount "$unresolved_count" \
        --arg unresolvedTokens "$unresolved_tokens" \
        '{
            skill: $skill,
            path: $path,
            taskId: $task,
            tokenBudget: $budget,
            model: $model,
            tier: $tier,
            references: $refs,
            skillFile: $skillFile,
            spawnContext: {
                date: $date,
                topicSlug: $topicSlug,
                epicId: (if $epicId == "" then null else $epicId end),
                title: $title,
                outputFile: $outputFile,
                spawnTimestamp: $timestamp
            },
            tokenResolution: {
                fullyResolved: ($unresolvedCount == 0),
                unresolvedCount: $unresolvedCount,
                unresolvedTokens: (if $unresolvedTokens == "" then [] else ($unresolvedTokens | split("\n") | map(select(. != ""))) end)
            },
            prompt: $prompt
        }'

    return 0
}

# ============================================================================
# MULTI-SKILL COMPOSITION (T2833)
# ============================================================================

# skill_prepare_spawn_multi - Compose multiple skills with progressive disclosure
# Usage: skill_prepare_spawn_multi "T1234" "ct-research-agent" "drizzle-orm" "svelte5-sveltekit"
# Returns: Combined prompt with skills in priority order, using progressive loading
#
# The first skill is loaded fully (primary skill).
# Secondary skills use progressive disclosure (frontmatter + first section only).
# This enables "skill recipes" where multiple specialized skills combine.
#
# @task T2833
# @why Single skill limitation prevents optimal context for multi-domain tasks
# @what Multi-skill composition with token tracking
skill_prepare_spawn_multi() {
    local task_id="$1"
    shift
    local skills=("$@")

    _sd_require_jq || return $?

    if [[ ${#skills[@]} -eq 0 ]]; then
        _sd_error "At least one skill required"
        return "$EXIT_INVALID_INPUT"
    fi

    # If only one skill, use standard function
    if [[ ${#skills[@]} -eq 1 ]]; then
        skill_prepare_spawn "${skills[0]}" "$task_id"
        return $?
    fi

    _sd_debug "Composing ${#skills[@]} skills for task $task_id"

    # Set base context from task
    if declare -f ti_set_full_context >/dev/null 2>&1; then
        ti_set_full_context "$task_id" || true
    fi

    # Load protocol base
    local protocol_content=""
    if [[ -f "$_SD_PROTOCOL_BASE" ]]; then
        protocol_content=$(cat "$_SD_PROTOCOL_BASE" 2>/dev/null)
        if declare -f ti_inject_tokens >/dev/null 2>&1; then
            protocol_content=$(ti_inject_tokens "$protocol_content")
        fi
    fi

    # Build combined prompt
    local combined_prompt=""
    local skill_manifest_arr=()
    local total_tokens=0
    local primary_skill="${skills[0]}"
    local is_first=true

    for skill in "${skills[@]}"; do
        local metadata tier skill_path skill_content skill_tokens

        # Get skill metadata
        metadata=$(skill_get_metadata "$skill" 2>/dev/null)
        if [[ -z "$metadata" || "$metadata" == "null" ]]; then
            _sd_warn "Skill not found: $skill, skipping"
            continue
        fi

        tier=$(echo "$metadata" | jq -r '.tier // 2')
        skill_path=$(echo "$metadata" | jq -r '.path // ""')
        local skill_file="${_SD_PROJECT_ROOT}/${skill_path}/SKILL.md"

        if [[ ! -f "$skill_file" ]]; then
            _sd_warn "Skill file not found: $skill_file"
            continue
        fi

        # Load skill content based on position
        if [[ "$is_first" == "true" ]]; then
            # Primary skill: full content
            skill_content=$(cat "$skill_file")
            _sd_debug "Loaded full content for primary skill: $skill"
            is_first=false
        else
            # Secondary skills: progressive disclosure (frontmatter + first section)
            skill_content=$(_sd_load_progressive "$skill_file")
            _sd_debug "Loaded progressive content for secondary skill: $skill"
        fi

        # Inject tokens if available
        if declare -f ti_inject_tokens >/dev/null 2>&1; then
            skill_content=$(ti_inject_tokens "$skill_content")
        fi

        # Estimate tokens
        skill_tokens=$(( ${#skill_content} / 4 ))
        total_tokens=$((total_tokens + skill_tokens))

        # Add to combined prompt
        combined_prompt+="
---

## Skill: ${skill} (Tier ${tier})

${skill_content}
"

        # Track skill in manifest
        skill_manifest_arr+=("{\"skill\":\"$skill\",\"tier\":$tier,\"tokens\":$skill_tokens,\"mode\":\"$([ "$skill" == "$primary_skill" ] && echo 'full' || echo 'progressive')\"}")
    done

    # Add protocol header if available
    if [[ -n "$protocol_content" ]]; then
        local protocol_tokens=$(( ${#protocol_content} / 4 ))
        total_tokens=$((total_tokens + protocol_tokens))

        combined_prompt="## Subagent Protocol (Auto-injected)

${protocol_content}

---

## Skills Loaded (${#skills[@]} total)
${combined_prompt}"
    fi

    # Build skills JSON array
    local skills_json
    skills_json=$(printf '%s\n' "${skill_manifest_arr[@]}" | jq -s '.')

    # Extract context
    local date_today topic_slug epic_id
    date_today="${TI_DATE:-$(date +%Y-%m-%d)}"
    topic_slug="${TI_TOPIC_SLUG:-task-${task_id}}"
    epic_id="${TI_EPIC_ID:-}"

    # Log token usage if available
    if declare -f track_skill_injection >/dev/null 2>&1; then
        for skill in "${skills[@]}"; do
            local st
            st=$(echo "$skills_json" | jq -r --arg s "$skill" '.[] | select(.skill == $s) | .tokens')
            track_skill_injection "$skill" "$(echo "$skills_json" | jq -r --arg s "$skill" '.[] | select(.skill == $s) | .tier')" "$st" "$task_id" 2>/dev/null || true
        done
    fi

    # Build output JSON
    jq -n \
        --arg task "$task_id" \
        --argjson skill_count "${#skills[@]}" \
        --argjson skills "$skills_json" \
        --argjson total_tokens "$total_tokens" \
        --arg primary "$primary_skill" \
        --arg prompt "$combined_prompt" \
        --arg date "$date_today" \
        --arg topic_slug "$topic_slug" \
        --arg epic_id "$epic_id" \
        '{
            taskId: $task,
            composition: {
                skillCount: $skill_count,
                primarySkill: $primary,
                skills: $skills,
                totalEstimatedTokens: $total_tokens
            },
            spawnContext: {
                date: $date,
                topicSlug: $topic_slug,
                epicId: (if $epic_id == "" then null else $epic_id end)
            },
            prompt: $prompt
        }'

    return 0
}

# _sd_load_progressive - Load skill with progressive disclosure
# Args: $1 = skill file path
# Returns: Frontmatter + first section only
_sd_load_progressive() {
    local file="$1"

    # Extract frontmatter and first section
    awk '
        BEGIN { in_fm=0; after_fm=0; in_section=0 }
        /^---$/ && !in_fm && !after_fm { in_fm=1; print; next }
        /^---$/ && in_fm { in_fm=0; after_fm=1; print; print ""; next }
        in_fm { print; next }
        after_fm && /^##? / && !in_section { in_section=1; print; next }
        after_fm && /^##? / && in_section { exit }
        in_section { print }
    ' "$file"

    # Add progressive disclosure note
    echo ""
    echo "> **Note**: This skill is loaded in progressive mode. Request full content if needed."
}

# ============================================================================
# EXPORT FUNCTIONS
# ============================================================================

# Original functions
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

# Category and tier functions
export -f get_skills_by_category
export -f skill_dispatch_by_category
export -f skill_get_tier
export -f skill_is_tier

# Spec-compliant API functions
export -f skill_dispatch_by_keywords
export -f skill_dispatch_by_type
export -f skill_dispatch_by_protocol
export -f skill_get_metadata
export -f skill_get_references
export -f skill_check_compatibility
export -f skill_list_by_tier
export -f skill_auto_dispatch
export -f skill_prepare_spawn
export -f skill_prepare_spawn_multi
