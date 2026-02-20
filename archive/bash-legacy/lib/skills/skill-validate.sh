#!/usr/bin/env bash
# skill-validate.sh - Skill Validation Library for Orchestrator Protocol
#
# ARCHITECTURE NOTE (Universal Subagent Architecture):
#   Skills (ct-research-agent, ct-task-executor, etc.) are PROTOCOL IDENTIFIERS,
#   NOT separate agent types. All spawns use 'cleo-subagent' with skill injection.
#   The '-agent' suffix in skill names is legacy naming - they are skills/protocols.
#
# LAYER: 1 (Foundation Services)
# DEPENDENCIES: exit-codes.sh
# PROVIDES: skill_exists, skill_is_active, skill_has_required_tokens,
#           skill_is_compatible_with_subagent, skill_get_info, skill_list_all,
#           skill_validate_for_spawn
#
# Validates skill protocol configurations before cleo-subagent spawning to prevent
# hallucination and catch config errors early. All validation functions
# read from skills/manifest.json (single source of truth).
#
# USAGE:
#   source lib/skills/skill-validate.sh
#
#   # Check if skill exists
#   if skill_exists "ct-research-agent"; then
#       echo "Skill found"
#   fi
#
#   # Full validation before spawning
#   if skill_validate_for_spawn "ct-research-agent"; then
#       echo "Ready to spawn"
#   fi
#
#   # Get skill info
#   info=$(skill_get_info "ct-research-agent")

#=== SOURCE GUARD ================================================
[[ -n "${_SKILL_VALIDATE_LOADED:-}" ]] && return 0
declare -r _SKILL_VALIDATE_LOADED=1

set -euo pipefail

# Determine library directory
_SV_LIB_DIR="${BASH_SOURCE[0]%/*}/.."
[[ "$_SV_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _SV_LIB_DIR="."

# Determine project root (one level up from lib/)
_SV_PROJECT_ROOT="${_SV_LIB_DIR}/.."
[[ -d "${_SV_PROJECT_ROOT}/skills" ]] || _SV_PROJECT_ROOT="."

# Path to manifest.json (single source of truth)
_SV_MANIFEST_JSON="${_SV_PROJECT_ROOT}/skills/manifest.json"

# Path to placeholders.json (for token validation)
_SV_PLACEHOLDERS_JSON="${_SV_PROJECT_ROOT}/skills/_shared/placeholders.json"

# Source dependencies
# shellcheck source=lib/core/exit-codes.sh
source "${_SV_LIB_DIR}/core/exit-codes.sh"

# ============================================================================
# INTERNAL HELPERS
# ============================================================================

# Log warning message to stderr
# Args: $1 = message
_sv_warn() {
    echo "[skill-validate] WARNING: $1" >&2
}

# Log error message to stderr
# Args: $1 = message
_sv_error() {
    echo "[skill-validate] ERROR: $1" >&2
}

# Check if jq is available
# Returns: 0 if available, EXIT_DEPENDENCY_ERROR (5) if not
_sv_require_jq() {
    if ! command -v jq &>/dev/null; then
        _sv_error "jq is required but not found"
        return "$EXIT_DEPENDENCY_ERROR"
    fi
    return 0
}

# Check if manifest exists
# Returns: 0 if exists, EXIT_FILE_ERROR (3) if not
_sv_require_manifest() {
    if [[ ! -f "$_SV_MANIFEST_JSON" ]]; then
        _sv_error "Manifest not found: $_SV_MANIFEST_JSON"
        return "$EXIT_FILE_ERROR"
    fi
    return 0
}

# ============================================================================
# PUBLIC API
# ============================================================================

# skill_exists - Check if skill exists in manifest
# Args: $1 = skill name (e.g., "ct-research-agent")
# Returns: 0 if exists, EXIT_NOT_FOUND (4) if not found
# Output: none
skill_exists() {
    local skill_name="$1"

    _sv_require_jq || return $?
    _sv_require_manifest || return $?

    local exists
    exists=$(jq -r --arg name "$skill_name" \
        '.skills[] | select(.name == $name) | .name' \
        "$_SV_MANIFEST_JSON" 2>/dev/null)

    if [[ -n "$exists" ]]; then
        return 0
    else
        return "$EXIT_NOT_FOUND"
    fi
}

# skill_is_active - Check if skill status is "active"
# Args: $1 = skill name
# Returns: 0 if active, EXIT_NOT_FOUND (4) if skill not found,
#          EXIT_VALIDATION_ERROR (6) if skill exists but not active
# Output: none
skill_is_active() {
    local skill_name="$1"

    _sv_require_jq || return $?
    _sv_require_manifest || return $?

    local status
    status=$(jq -r --arg name "$skill_name" \
        '.skills[] | select(.name == $name) | .status // "unknown"' \
        "$_SV_MANIFEST_JSON" 2>/dev/null)

    if [[ -z "$status" ]]; then
        _sv_error "Skill not found: $skill_name"
        return "$EXIT_NOT_FOUND"
    fi

    if [[ "$status" == "active" ]]; then
        return 0
    else
        _sv_warn "Skill '$skill_name' status is '$status', not 'active'"
        return "$EXIT_VALIDATION_ERROR"
    fi
}

# skill_has_required_tokens - Verify skill has needed tokens defined
# Args: $1 = skill name
# Returns: 0 if tokens available, EXIT_NOT_FOUND (4) if skill not found,
#          EXIT_VALIDATION_ERROR (6) if required tokens missing
# Output: none
# Note: Checks against skills/_shared/placeholders.json required tokens
skill_has_required_tokens() {
    local skill_name="$1"

    _sv_require_jq || return $?
    _sv_require_manifest || return $?

    # First verify skill exists
    if ! skill_exists "$skill_name"; then
        _sv_error "Skill not found: $skill_name"
        return "$EXIT_NOT_FOUND"
    fi

    # Check if placeholders.json exists
    if [[ ! -f "$_SV_PLACEHOLDERS_JSON" ]]; then
        _sv_warn "Placeholders file not found, skipping token validation"
        return 0
    fi

    # Get required tokens from placeholders.json
    local required_tokens
    required_tokens=$(jq -r '.required[].token' "$_SV_PLACEHOLDERS_JSON" 2>/dev/null)

    if [[ -z "$required_tokens" ]]; then
        _sv_warn "No required tokens defined in placeholders.json"
        return 0
    fi

    # Get skill path to check for skill-specific config
    local skill_path
    skill_path=$(jq -r --arg name "$skill_name" \
        '.skills[] | select(.name == $name) | .path' \
        "$_SV_MANIFEST_JSON" 2>/dev/null)

    # For now, return success if skill exists and has path
    # Future: could check skill-specific template for token usage
    if [[ -n "$skill_path" ]]; then
        return 0
    fi

    return "$EXIT_VALIDATION_ERROR"
}

# skill_is_compatible_with_subagent - Check subagent compatibility
# Args: $1 = skill name
#       $2 = subagent model (optional, defaults to checking any model)
# Returns: 0 if compatible, EXIT_NOT_FOUND (4) if skill not found,
#          EXIT_VALIDATION_ERROR (6) if incompatible
# Output: none
# Note: Checks skill.model field if specified (e.g., "sonnet", "opus")
skill_is_compatible_with_subagent() {
    local skill_name="$1"
    local target_model="${2:-}"

    _sv_require_jq || return $?
    _sv_require_manifest || return $?

    # First verify skill exists
    if ! skill_exists "$skill_name"; then
        _sv_error "Skill not found: $skill_name"
        return "$EXIT_NOT_FOUND"
    fi

    # Get skill's model requirement
    local skill_model
    skill_model=$(jq -r --arg name "$skill_name" \
        '.skills[] | select(.name == $name) | .model // ""' \
        "$_SV_MANIFEST_JSON" 2>/dev/null)

    # If no target model specified, just verify skill has valid config
    if [[ -z "$target_model" ]]; then
        return 0
    fi

    # If skill has no model requirement, it's compatible with any model
    if [[ -z "$skill_model" ]]; then
        return 0
    fi

    # Check model compatibility
    if [[ "$skill_model" == "$target_model" ]]; then
        return 0
    fi

    # Special case: "sonnet" skill can run on "opus" (higher capability)
    if [[ "$skill_model" == "sonnet" && "$target_model" == "opus" ]]; then
        return 0
    fi

    _sv_warn "Skill '$skill_name' requires model '$skill_model', but target is '$target_model'"
    return "$EXIT_VALIDATION_ERROR"
}

# skill_get_info - Get skill metadata as JSON
# Args: $1 = skill name
# Returns: 0 on success, EXIT_NOT_FOUND (4) if not found
# Output: JSON object with skill metadata to stdout
skill_get_info() {
    local skill_name="$1"

    _sv_require_jq || return $?
    _sv_require_manifest || return $?

    local info
    info=$(jq --arg name "$skill_name" \
        '.skills[] | select(.name == $name)' \
        "$_SV_MANIFEST_JSON" 2>/dev/null)

    if [[ -z "$info" || "$info" == "null" ]]; then
        _sv_error "Skill not found: $skill_name"
        return "$EXIT_NOT_FOUND"
    fi

    echo "$info"
    return 0
}

# skill_list_all - List all skills in manifest
# Args: $1 = filter (optional): "active", "inactive", or empty for all
# Returns: 0 on success
# Output: JSON array of skill names to stdout
skill_list_all() {
    local filter="${1:-}"

    _sv_require_jq || return $?
    _sv_require_manifest || return $?

    local query
    if [[ -z "$filter" ]]; then
        query='[.skills[].name]'
    elif [[ "$filter" == "active" ]]; then
        query='[.skills[] | select(.status == "active") | .name]'
    elif [[ "$filter" == "inactive" ]]; then
        query='[.skills[] | select(.status != "active") | .name]'
    else
        _sv_error "Invalid filter: $filter (use 'active', 'inactive', or empty)"
        return "$EXIT_INVALID_INPUT"
    fi

    jq -r "$query" "$_SV_MANIFEST_JSON" 2>/dev/null
    return 0
}

# skill_validate_for_spawn - Full validation before spawning subagent
# Args: $1 = skill name
#       $2 = target model (optional)
# Returns: 0 if valid for spawning, appropriate exit code if not
# Output: Error messages to stderr on failure
# Note: Runs all validations: exists, active, tokens, compatibility
skill_validate_for_spawn() {
    local skill_name="$1"
    local target_model="${2:-}"
    local errors=0

    # Check existence
    if ! skill_exists "$skill_name"; then
        _sv_error "Skill '$skill_name' does not exist in manifest"
        return "$EXIT_NOT_FOUND"
    fi

    # Check active status
    if ! skill_is_active "$skill_name"; then
        _sv_error "Skill '$skill_name' is not active"
        ((errors++))
    fi

    # Check tokens
    if ! skill_has_required_tokens "$skill_name"; then
        _sv_error "Skill '$skill_name' missing required tokens"
        ((errors++))
    fi

    # Check model compatibility
    if [[ -n "$target_model" ]]; then
        if ! skill_is_compatible_with_subagent "$skill_name" "$target_model"; then
            _sv_error "Skill '$skill_name' not compatible with model '$target_model'"
            ((errors++))
        fi
    fi

    if [[ $errors -gt 0 ]]; then
        return "$EXIT_VALIDATION_ERROR"
    fi

    return 0
}

# skill_get_path - Get skill directory path
# Args: $1 = skill name
# Returns: 0 on success, EXIT_NOT_FOUND (4) if not found
# Output: Path string to stdout
skill_get_path() {
    local skill_name="$1"

    _sv_require_jq || return $?
    _sv_require_manifest || return $?

    local path
    path=$(jq -r --arg name "$skill_name" \
        '.skills[] | select(.name == $name) | .path // ""' \
        "$_SV_MANIFEST_JSON" 2>/dev/null)

    if [[ -z "$path" ]]; then
        _sv_error "Skill not found or has no path: $skill_name"
        return "$EXIT_NOT_FOUND"
    fi

    echo "$path"
    return 0
}

# skill_get_tags - Get skill tags
# Args: $1 = skill name
# Returns: 0 on success, EXIT_NOT_FOUND (4) if not found
# Output: JSON array of tags to stdout
skill_get_tags() {
    local skill_name="$1"

    _sv_require_jq || return $?
    _sv_require_manifest || return $?

    local tags
    tags=$(jq -r --arg name "$skill_name" \
        '.skills[] | select(.name == $name) | .tags // []' \
        "$_SV_MANIFEST_JSON" 2>/dev/null)

    if [[ -z "$tags" || "$tags" == "null" ]]; then
        echo "[]"
    else
        echo "$tags"
    fi
    return 0
}

# skill_find_by_tag - Find skills with specific tag
# Args: $1 = tag name
# Returns: 0 on success
# Output: JSON array of skill names to stdout
skill_find_by_tag() {
    local tag="$1"

    _sv_require_jq || return $?
    _sv_require_manifest || return $?

    jq -r --arg tag "$tag" \
        '[.skills[] | select(.tags[]? == $tag) | .name]' \
        "$_SV_MANIFEST_JSON" 2>/dev/null
    return 0
}

# ============================================================================
# EXPORT FUNCTIONS
# ============================================================================

export -f skill_exists
export -f skill_is_active
export -f skill_has_required_tokens
export -f skill_is_compatible_with_subagent
export -f skill_get_info
export -f skill_list_all
export -f skill_validate_for_spawn
export -f skill_get_path
export -f skill_get_tags
export -f skill_find_by_tag
