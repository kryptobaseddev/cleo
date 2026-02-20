#!/usr/bin/env bash
# subagent-inject.sh - Subagent Protocol Injection Library for Orchestrator
#
# LAYER: 2 (Services - depends on Layer 1)
# DEPENDENCIES: exit-codes.sh, token-inject.sh, skill-validate.sh, skill-dispatch.sh
# PROVIDES: subagent_prepare, subagent_inject_protocol, orchestrator_spawn_skill, subagent_get_task_context
#
# Guarantees protocol compliance for all subagent spawns by automatically
# injecting the RFC 2119 protocol from skills/_shared/subagent-protocol-base.md.
#
# INJECTION PATTERN:
#   [SKILL CONTENT]
#   ---
#   ## SUBAGENT PROTOCOL (RFC 2119)
#   [Content from subagent-protocol-base.md with tokens resolved]
#   ---
#   [TASK CONTEXT]
#
# USAGE:
#   source lib/skills/subagent-inject.sh
#
#   # High-level: Full orchestrator workflow (skill-based)
#   prompt=$(orchestrator_spawn_skill "T1234" "ct-research-agent")
#
#   # Low-level: Manual preparation
#   subagent_prepare "T1234" "my-topic" "T1666"
#   prompt=$(subagent_inject_protocol "$skill_content")

#=== SOURCE GUARD ================================================
[[ -n "${_SUBAGENT_INJECT_LOADED:-}" ]] && return 0
declare -r _SUBAGENT_INJECT_LOADED=1

set -euo pipefail

# Determine library directory
_SI_LIB_DIR="${BASH_SOURCE[0]%/*}/.."
[[ "$_SI_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _SI_LIB_DIR="."

# Determine project root (one level up from lib/)
_SI_PROJECT_ROOT="${_SI_LIB_DIR}/.."
[[ -d "${_SI_PROJECT_ROOT}/skills" ]] || _SI_PROJECT_ROOT="."

# Path to subagent protocol base (single source of truth)
_SI_PROTOCOL_BASE="${_SI_PROJECT_ROOT}/skills/_shared/subagent-protocol-base.md"

# Source dependencies
# shellcheck source=lib/core/exit-codes.sh
source "${_SI_LIB_DIR}/core/exit-codes.sh"
# shellcheck source=lib/skills/token-inject.sh
source "${_SI_LIB_DIR}/skills/token-inject.sh"
# shellcheck source=lib/skills/skill-validate.sh
source "${_SI_LIB_DIR}/skills/skill-validate.sh"
# shellcheck source=lib/skills/skill-dispatch.sh
source "${_SI_LIB_DIR}/skills/skill-dispatch.sh"

# ============================================================================
# INTERNAL HELPERS
# ============================================================================

# Log debug message to stderr
# Args: $1 = message
_si_debug() {
    [[ -n "${SUBAGENT_INJECT_DEBUG:-}" ]] && echo "[subagent-inject] DEBUG: $1" >&2
    return 0
}

# Log warning message to stderr
# Args: $1 = message
_si_warn() {
    echo "[subagent-inject] WARNING: $1" >&2
}

# Log error message to stderr
# Args: $1 = message
_si_error() {
    echo "[subagent-inject] ERROR: $1" >&2
}

# Log info message to stderr
# Args: $1 = message
_si_info() {
    echo "[subagent-inject] $1" >&2
}

# Check if jq is available
# Returns: 0 if available, EXIT_DEPENDENCY_ERROR (5) if not
_si_require_jq() {
    if ! command -v jq &>/dev/null; then
        _si_error "jq is required but not found"
        return "$EXIT_DEPENDENCY_ERROR"
    fi
    return 0
}

# Check if protocol base exists
# Returns: 0 if exists, EXIT_FILE_ERROR (3) if not
_si_require_protocol_base() {
    if [[ ! -f "$_SI_PROTOCOL_BASE" ]]; then
        _si_error "Protocol base not found: $_SI_PROTOCOL_BASE"
        return "$EXIT_FILE_ERROR"
    fi
    return 0
}

# Generate topic slug from title
# Args: $1 = title
# Returns: 0 always
# Output: slug to stdout
_si_generate_topic_slug() {
    local title="$1"
    local slug

    # Convert to lowercase, replace non-alphanumeric with dashes, trim dashes
    slug=$(echo "$title" | tr '[:upper:]' '[:lower:]' | \
           sed -E 's/[^a-z0-9]+/-/g' | sed -E 's/^-+|-+$//g')

    # Fallback if empty
    [[ -z "$slug" ]] && slug="task"

    echo "$slug"
}

# ============================================================================
# PUBLIC API - PREPARATION
# ============================================================================

# subagent_prepare - Prepare tokens and context for subagent
# Args: $1 = task_id (required)
#       $2 = topic_slug (optional, auto-generated from task title if not provided)
#       $3 = epic_id (optional)
# Returns: 0 on success, appropriate exit code on failure
# Side effects: Sets TI_* environment variables for token injection
# Note: Must be called before subagent_inject_protocol()
subagent_prepare() {
    local task_id="$1"
    local topic_slug="${2:-}"
    local epic_id="${3:-}"

    _si_require_jq || return $?

    # Validate task_id
    if [[ -z "$task_id" ]]; then
        _si_error "task_id is required for subagent_prepare"
        return "$EXIT_INVALID_INPUT"
    fi

    # Get task info to extract title if topic_slug not provided
    if [[ -z "$topic_slug" ]]; then
        local task_json
        task_json=$(cleo show "$task_id" --format json 2>/dev/null)
        if [[ -z "$task_json" || "$task_json" == "null" ]]; then
            _si_error "Could not fetch task: $task_id"
            return "$EXIT_NOT_FOUND"
        fi

        local title
        title=$(echo "$task_json" | jq -r '.task.title // "untitled"')
        topic_slug=$(_si_generate_topic_slug "$title")

        # Auto-detect epic_id from task hierarchy if not provided
        if [[ -z "$epic_id" ]]; then
            epic_id=$(echo "$task_json" | jq -r '
                if .task.hierarchy.parent then
                    if .task.hierarchy.parent.type == "epic" then
                        .task.hierarchy.parent.id
                    else
                        # Look for grandparent epic
                        .task.hierarchy.parent.parentId // ""
                    end
                else
                    ""
                end
            ' 2>/dev/null || echo "")
        fi
    fi

    _si_debug "Preparing subagent: task=$task_id topic=$topic_slug epic=$epic_id"

    # Set token context using ti_set_context from token-inject.sh
    local date_today
    date_today=$(date +%Y-%m-%d)

    ti_set_context "$task_id" "$date_today" "$topic_slug" "$epic_id"

    # Set defaults for optional tokens
    ti_set_defaults

    # Validate required tokens are set
    ti_validate_required || return $?

    _si_debug "Tokens prepared: TASK_ID=$TI_TASK_ID DATE=$TI_DATE TOPIC_SLUG=$TI_TOPIC_SLUG"

    return 0
}

# subagent_get_task_context - Get task context block for prompt
# Args: $1 = task_id
# Returns: 0 on success, appropriate exit code on failure
# Output: Task context markdown block to stdout
subagent_get_task_context() {
    local task_id="$1"

    _si_require_jq || return $?

    local task_json
    task_json=$(cleo show "$task_id" --format json 2>/dev/null)
    if [[ -z "$task_json" || "$task_json" == "null" ]]; then
        _si_error "Could not fetch task: $task_id"
        return "$EXIT_NOT_FOUND"
    fi

    # Extract task details
    local title description type status parent_id epic_id labels
    title=$(echo "$task_json" | jq -r '.task.title // "untitled"')
    description=$(echo "$task_json" | jq -r '.task.description // ""')
    type=$(echo "$task_json" | jq -r '.task.type // "task"')
    status=$(echo "$task_json" | jq -r '.task.status // "pending"')
    parent_id=$(echo "$task_json" | jq -r '.task.parentId // ""')
    labels=$(echo "$task_json" | jq -r '.task.labels // [] | join(", ")')

    # Get epic ID from hierarchy
    epic_id=$(echo "$task_json" | jq -r '
        if .task.hierarchy.parent then
            if .task.hierarchy.parent.type == "epic" then
                .task.hierarchy.parent.id
            else
                .task.hierarchy.parent.parentId // ""
            end
        else
            ""
        end
    ' 2>/dev/null || echo "")

    # Build context block
    cat <<EOF
## Task Context

| Field | Value |
|-------|-------|
| Task ID | \`${task_id}\` |
| Title | ${title} |
| Type | ${type} |
| Status | ${status} |
| Epic | \`${epic_id:-N/A}\` |
| Parent | \`${parent_id:-N/A}\` |
| Labels | ${labels:-none} |

### Description

${description:-No description provided.}
EOF

    return 0
}

# ============================================================================
# PUBLIC API - INJECTION
# ============================================================================

# subagent_inject_protocol - Inject protocol block into prompt
# Args: $1 = skill content (markdown, already has tokens resolved)
#       $2 = include_task_context (optional, "true" or "false", default "true")
# Returns: 0 on success, appropriate exit code on failure
# Output: Complete prompt with protocol injected to stdout
# Note: Expects tokens already set via subagent_prepare()
subagent_inject_protocol() {
    local skill_content="$1"
    local include_task_context="${2:-true}"

    _si_require_protocol_base || return $?

    # Validate tokens are set
    if [[ -z "${TI_TASK_ID:-}" ]]; then
        _si_error "Tokens not prepared. Call subagent_prepare() first."
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Load and inject protocol base
    local protocol_content
    protocol_content=$(ti_load_template "$_SI_PROTOCOL_BASE")

    # Build complete prompt with injection pattern
    local output=""

    # 1. Skill content
    output="${skill_content}"

    # 2. Protocol separator and content
    output+="

---

## SUBAGENT PROTOCOL (RFC 2119)

${protocol_content}

---"

    # 3. Task context (if requested)
    if [[ "$include_task_context" == "true" ]]; then
        local task_context
        task_context=$(subagent_get_task_context "$TI_TASK_ID")
        output+="

${task_context}"
    fi

    echo "$output"
    return 0
}

# ============================================================================
# PUBLIC API - HIGH-LEVEL ORCHESTRATOR
# ============================================================================

# orchestrator_spawn_skill - Full skill-based workflow to prepare prompt for subagent spawn
# Args: $1 = task_id (required)
#       $2 = skill_name (optional, auto-selects if not provided)
#       $3 = epic_id (optional, auto-detects from task hierarchy)
# Returns: 0 on success, appropriate exit code on failure
# Output: Complete prompt ready for Task tool to stdout
# Note: This is the skill-based entry point for orchestrators
#       For CLI/JSON output, use orchestrator_spawn from orchestrator-startup.sh
#
# EXAMPLE:
#   prompt=$(orchestrator_spawn_skill "T1234" "ct-research-agent")
#   # Use $prompt with Task tool to spawn subagent
orchestrator_spawn_skill() {
    local task_id="$1"
    local skill_name="${2:-}"
    local epic_id="${3:-}"

    _si_require_jq || return $?

    # Validate task_id
    if [[ -z "$task_id" ]]; then
        _si_error "task_id is required for orchestrator_spawn_skill"
        return "$EXIT_INVALID_INPUT"
    fi

    _si_info "Spawning subagent for task $task_id"

    # Step 1: Get task info
    local task_json
    task_json=$(cleo show "$task_id" --format json 2>/dev/null)
    if [[ -z "$task_json" || "$task_json" == "null" ]]; then
        _si_error "Could not fetch task: $task_id"
        return "$EXIT_NOT_FOUND"
    fi

    # Step 2: Select skill if not provided
    if [[ -z "$skill_name" ]]; then
        skill_name=$(skill_select_for_task "$task_json")
        _si_debug "Auto-selected skill: $skill_name"
    fi

    # Step 3: Validate skill
    if ! skill_validate_for_spawn "$skill_name"; then
        _si_error "Skill validation failed: $skill_name"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Step 4: Get skill path and load skill content
    local skill_path
    skill_path=$(skill_get_path "$skill_name")
    if [[ -z "$skill_path" ]]; then
        _si_error "Could not get path for skill: $skill_name"
        return "$EXIT_NOT_FOUND"
    fi

    local skill_file="${_SI_PROJECT_ROOT}/${skill_path}/SKILL.md"
    if [[ ! -f "$skill_file" ]]; then
        _si_error "Skill file not found: $skill_file"
        return "$EXIT_FILE_ERROR"
    fi

    # Step 5: Prepare tokens
    subagent_prepare "$task_id" "" "$epic_id" || return $?

    # Step 6: Load skill with token injection
    local skill_content
    skill_content=$(ti_load_template "$skill_file")

    # Step 7: Inject protocol and task context
    local complete_prompt
    complete_prompt=$(subagent_inject_protocol "$skill_content" "true")

    _si_info "Prompt prepared (skill: $skill_name, tokens: TASK_ID=$TI_TASK_ID DATE=$TI_DATE)"

    echo "$complete_prompt"
    return 0
}

# orchestrator_spawn_minimal - Spawn with minimal context (no task details)
# Args: $1 = task_id (required)
#       $2 = skill_name (required)
#       $3 = custom_content (optional, additional content to append)
# Returns: 0 on success, appropriate exit code on failure
# Output: Prompt with skill + protocol (no task context) to stdout
# Note: Use when task context should not be included (e.g., pure research tasks)
orchestrator_spawn_minimal() {
    local task_id="$1"
    local skill_name="$2"
    local custom_content="${3:-}"

    # Validate inputs
    if [[ -z "$task_id" || -z "$skill_name" ]]; then
        _si_error "task_id and skill_name are required for orchestrator_spawn_minimal"
        return "$EXIT_INVALID_INPUT"
    fi

    # Validate skill
    if ! skill_validate_for_spawn "$skill_name"; then
        _si_error "Skill validation failed: $skill_name"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Get skill path and load skill content
    local skill_path
    skill_path=$(skill_get_path "$skill_name")
    if [[ -z "$skill_path" ]]; then
        _si_error "Could not get path for skill: $skill_name"
        return "$EXIT_NOT_FOUND"
    fi

    local skill_file="${_SI_PROJECT_ROOT}/${skill_path}/SKILL.md"
    if [[ ! -f "$skill_file" ]]; then
        _si_error "Skill file not found: $skill_file"
        return "$EXIT_FILE_ERROR"
    fi

    # Prepare tokens (generate topic from task title)
    subagent_prepare "$task_id" || return $?

    # Load skill with token injection
    local skill_content
    skill_content=$(ti_load_template "$skill_file")

    # Inject protocol WITHOUT task context
    local complete_prompt
    complete_prompt=$(subagent_inject_protocol "$skill_content" "false")

    # Append custom content if provided
    if [[ -n "$custom_content" ]]; then
        complete_prompt+="

---

${custom_content}"
    fi

    echo "$complete_prompt"
    return 0
}

# orchestrator_validate_spawn - Pre-flight validation before spawning
# Args: $1 = task_id
#       $2 = skill_name (optional)
# Returns: 0 if valid, appropriate exit code if not
# Output: Validation messages to stderr
# Note: Use to validate before spawning without producing output
orchestrator_validate_spawn() {
    local task_id="$1"
    local skill_name="${2:-}"

    _si_require_jq || return $?

    # Validate task exists
    local task_json
    task_json=$(cleo show "$task_id" --format json 2>/dev/null)
    if [[ -z "$task_json" || "$task_json" == "null" ]]; then
        _si_error "Task not found: $task_id"
        return "$EXIT_NOT_FOUND"
    fi

    _si_debug "Task $task_id exists"

    # Validate skill if provided
    if [[ -n "$skill_name" ]]; then
        if ! skill_validate_for_spawn "$skill_name"; then
            _si_error "Skill validation failed: $skill_name"
            return "$EXIT_VALIDATION_ERROR"
        fi
        _si_debug "Skill $skill_name validated"
    fi

    # Validate protocol base exists
    _si_require_protocol_base || return $?
    _si_debug "Protocol base exists"

    _si_info "Pre-flight validation passed for task $task_id"
    return 0
}

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

# subagent_list_required_tokens - List tokens required for protocol injection
# Args: none
# Returns: 0 always
# Output: List of required tokens to stdout
subagent_list_required_tokens() {
    echo "Required tokens for subagent protocol injection:"
    echo "  TI_TASK_ID       - Task identifier (e.g., T1234)"
    echo "  TI_DATE          - Current date (YYYY-MM-DD)"
    echo "  TI_TOPIC_SLUG    - URL-safe topic name"
    echo ""
    echo "Optional tokens (have defaults):"
    echo "  TI_EPIC_ID       - Parent epic identifier"
    echo "  TI_OUTPUT_DIR    - Output directory (default: claudedocs/agent-outputs)"
    echo "  TI_MANIFEST_PATH - Manifest file path"
    echo ""
    echo "Use 'ti_list_tokens' for full token list with current values."
    return 0
}

# subagent_get_protocol_path - Get path to protocol base file
# Args: none
# Returns: 0 always
# Output: Path to protocol base file
subagent_get_protocol_path() {
    echo "$_SI_PROTOCOL_BASE"
}

# ============================================================================
# EXPORT FUNCTIONS
# ============================================================================

export -f subagent_prepare
export -f subagent_get_task_context
export -f subagent_inject_protocol
export -f orchestrator_spawn_skill
export -f orchestrator_spawn_minimal
export -f orchestrator_validate_spawn
export -f subagent_list_required_tokens
export -f subagent_get_protocol_path
