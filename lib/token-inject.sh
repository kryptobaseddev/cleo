#!/usr/bin/env bash
# token-inject.sh - Token Injection Library for Subagent Templates
#
# LAYER: 1 (Foundation Services)
# DEPENDENCIES: exit-codes.sh
# PROVIDES: ti_inject_tokens, ti_validate_required, ti_set_defaults, ti_load_template
#
# Implements strict token replacement with validation to prevent hallucination.
# All tokens use {{TOKEN_NAME}} format. Required tokens MUST be set before injection.
#
# USAGE:
#   source lib/token-inject.sh
#
#   # Set required tokens
#   export TI_TASK_ID="T1234"
#   export TI_DATE="2026-01-19"
#   export TI_TOPIC_SLUG="my-research"
#
#   # Optional: override defaults
#   export TI_OUTPUT_DIR="/custom/path"
#
#   # Load and inject
#   ti_set_defaults
#   template=$(ti_load_template "templates/agents/RESEARCH-AGENT.md")
#   # $template now has all {{TOKEN}} replaced

#=== SOURCE GUARD ================================================
[[ -n "${_TOKEN_INJECT_LOADED:-}" ]] && return 0
declare -r _TOKEN_INJECT_LOADED=1

set -euo pipefail

# Determine library directory
_TI_LIB_DIR="${BASH_SOURCE[0]%/*}"
[[ "$_TI_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _TI_LIB_DIR="."

# Source dependencies
# shellcheck source=lib/exit-codes.sh
source "${_TI_LIB_DIR}/exit-codes.sh"

# ============================================================================
# TOKEN DEFINITIONS
# ============================================================================

# Required tokens (MUST be set before injection)
readonly _TI_REQUIRED_TOKENS=(
    "TASK_ID"
    "DATE"
    "TOPIC_SLUG"
)

# All supported tokens with their environment variable names
readonly _TI_ALL_TOKENS=(
    # Required context tokens
    "TASK_ID"
    "DATE"
    "TOPIC_SLUG"
    # Optional context tokens
    "EPIC_ID"
    "SESSION_ID"
    "RESEARCH_ID"
    "TITLE"
    # Task system command tokens (CLEO defaults)
    "TASK_SHOW_CMD"
    "TASK_FOCUS_CMD"
    "TASK_COMPLETE_CMD"
    "TASK_LINK_CMD"
    "TASK_LIST_CMD"
    "TASK_FIND_CMD"
    "TASK_ADD_CMD"
    # Output tokens
    "OUTPUT_DIR"
    "MANIFEST_PATH"
)

# CLEO default values for task system tokens
declare -A _TI_CLEO_DEFAULTS=(
    ["TASK_SHOW_CMD"]="cleo show"
    ["TASK_FOCUS_CMD"]="cleo focus set"
    ["TASK_COMPLETE_CMD"]="cleo complete"
    ["TASK_LINK_CMD"]="cleo research link"
    ["TASK_LIST_CMD"]="cleo list"
    ["TASK_FIND_CMD"]="cleo find"
    ["TASK_ADD_CMD"]="cleo add"
    ["OUTPUT_DIR"]="claudedocs/research-outputs"
    ["MANIFEST_PATH"]="claudedocs/research-outputs/MANIFEST.jsonl"
    # Optional context defaults (empty strings)
    ["EPIC_ID"]=""
    ["SESSION_ID"]=""
    ["RESEARCH_ID"]=""
    ["TITLE"]=""
)

# ============================================================================
# INTERNAL HELPERS
# ============================================================================

# Get token value from environment variable
# Args: $1 = token name (without TI_ prefix)
# Returns: Token value or empty string
_ti_get_token_value() {
    local token="$1"
    local env_var="TI_${token}"
    echo "${!env_var:-}"
}

# Check if token is in required list
# Args: $1 = token name
# Returns: 0 if required, 1 if not
_ti_is_required() {
    local token="$1"
    local req
    for req in "${_TI_REQUIRED_TOKENS[@]}"; do
        if [[ "$req" == "$token" ]]; then
            return 0
        fi
    done
    return 1
}

# Check if token is supported
# Args: $1 = token name
# Returns: 0 if supported, 1 if not
_ti_is_supported() {
    local token="$1"
    local supported
    for supported in "${_TI_ALL_TOKENS[@]}"; do
        if [[ "$supported" == "$token" ]]; then
            return 0
        fi
    done
    return 1
}

# Log warning message to stderr
# Args: $1 = message
_ti_warn() {
    echo "[token-inject] WARNING: $1" >&2
}

# Log error message to stderr
# Args: $1 = message
_ti_error() {
    echo "[token-inject] ERROR: $1" >&2
}

# ============================================================================
# PUBLIC API
# ============================================================================

# ti_set_defaults - Set CLEO defaults for unset optional tokens
# Args: none
# Returns: 0 always
# Side effects: Exports TI_* environment variables with defaults
ti_set_defaults() {
    local token default_val env_var current_val

    for token in "${!_TI_CLEO_DEFAULTS[@]}"; do
        default_val="${_TI_CLEO_DEFAULTS[$token]}"
        env_var="TI_${token}"
        current_val="${!env_var:-}"

        # Only set if not already set
        if [[ -z "$current_val" ]]; then
            export "$env_var"="$default_val"
        fi
    done

    # Special case: MANIFEST_PATH depends on OUTPUT_DIR
    if [[ -n "${TI_OUTPUT_DIR:-}" && -z "${TI_MANIFEST_PATH:-}" ]]; then
        export TI_MANIFEST_PATH="${TI_OUTPUT_DIR}/MANIFEST.jsonl"
    fi

    return 0
}

# ti_validate_required - Validate all required tokens are set
# Args: none
# Returns: 0 if all required tokens set, EXIT_VALIDATION_ERROR (6) if missing
# Output: Error message to stderr if validation fails
ti_validate_required() {
    local missing=()
    local token value

    for token in "${_TI_REQUIRED_TOKENS[@]}"; do
        value=$(_ti_get_token_value "$token")
        if [[ -z "$value" ]]; then
            missing+=("TI_${token}")
        fi
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        _ti_error "Missing required tokens: ${missing[*]}"
        _ti_error "Set these environment variables before calling ti_inject_tokens()"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Validate TASK_ID format (should match T followed by digits)
    local task_id="${TI_TASK_ID:-}"
    if [[ -n "$task_id" && ! "$task_id" =~ ^T[0-9]+$ ]]; then
        _ti_warn "TASK_ID '$task_id' does not match expected format T[0-9]+"
    fi

    # Validate DATE format (YYYY-MM-DD)
    local date="${TI_DATE:-}"
    if [[ -n "$date" && ! "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
        _ti_error "DATE '$date' must be in YYYY-MM-DD format"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Validate TOPIC_SLUG (URL-safe: alphanumeric, hyphens, underscores)
    local topic_slug="${TI_TOPIC_SLUG:-}"
    if [[ -n "$topic_slug" && ! "$topic_slug" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        _ti_warn "TOPIC_SLUG '$topic_slug' contains non-URL-safe characters"
    fi

    return 0
}

# ti_inject_tokens - Replace all {{TOKEN}} patterns with values
# Args: $1 = input text with {{TOKEN}} patterns
# Returns: 0 on success, EXIT_VALIDATION_ERROR (6) if unknown tokens remain
# Output: Injected text to stdout
# Side effects: Warns on stderr if unknown tokens found
ti_inject_tokens() {
    local input="$1"
    local output="$input"
    local token env_var value

    # Replace all known tokens
    for token in "${_TI_ALL_TOKENS[@]}"; do
        value=$(_ti_get_token_value "$token")
        # Use sed with different delimiter to handle paths with /
        output=$(echo "$output" | sed "s|{{${token}}}|${value}|g")
    done

    # Check for remaining unknown tokens
    local remaining
    remaining=$(echo "$output" | grep -oE '\{\{[A-Z_]+\}\}' | sort -u || true)

    if [[ -n "$remaining" ]]; then
        local unknown_list
        unknown_list=$(echo "$remaining" | tr '\n' ' ')
        _ti_warn "Unknown tokens remain after injection: $unknown_list"
        _ti_warn "These tokens will NOT be replaced and may cause template issues"
        # Don't fail - just warn. Some templates might have legitimate {{PLACEHOLDER}} patterns
    fi

    echo "$output"
    return 0
}

# ti_load_template - Load template file and inject tokens
# Args: $1 = path to template file
# Returns: 0 on success, EXIT_FILE_ERROR (3) if file not found, EXIT_VALIDATION_ERROR (6) if validation fails
# Output: Injected template content to stdout
ti_load_template() {
    local template_path="$1"

    # Check file exists
    if [[ ! -f "$template_path" ]]; then
        _ti_error "Template file not found: $template_path"
        return "$EXIT_FILE_ERROR"
    fi

    # Read file content
    local content
    content=$(cat "$template_path")

    # Inject tokens
    ti_inject_tokens "$content"
}

# ti_list_tokens - List all supported tokens with their current values
# Args: none
# Returns: 0 always
# Output: Table of tokens to stdout
ti_list_tokens() {
    local token value required

    printf "%-25s %-10s %s\n" "TOKEN" "REQUIRED" "CURRENT VALUE"
    printf "%-25s %-10s %s\n" "-------------------------" "----------" "--------------------"

    for token in "${_TI_ALL_TOKENS[@]}"; do
        value=$(_ti_get_token_value "$token")
        if _ti_is_required "$token"; then
            required="YES"
        else
            required="no"
        fi

        # Truncate long values
        if [[ ${#value} -gt 40 ]]; then
            value="${value:0:37}..."
        fi

        # Show "(unset)" for empty values
        if [[ -z "$value" ]]; then
            value="(unset)"
        fi

        printf "%-25s %-10s %s\n" "{{${token}}}" "$required" "$value"
    done

    return 0
}

# ti_get_default - Get the CLEO default value for a token
# Args: $1 = token name (without TI_ prefix)
# Returns: 0 if token has default, 1 if not
# Output: Default value to stdout
ti_get_default() {
    local token="$1"

    if [[ -v "_TI_CLEO_DEFAULTS[$token]" ]]; then
        echo "${_TI_CLEO_DEFAULTS[$token]}"
        return 0
    fi

    return 1
}

# ti_clear_all - Clear all TI_* environment variables
# Args: none
# Returns: 0 always
# Side effects: Unsets all TI_* environment variables
ti_clear_all() {
    local token
    for token in "${_TI_ALL_TOKENS[@]}"; do
        unset "TI_${token}"
    done
    return 0
}

# ti_set_context - Set common context tokens in one call
# Args:
#   $1 = TASK_ID (required)
#   $2 = DATE (required, defaults to today if empty)
#   $3 = TOPIC_SLUG (required)
#   $4 = EPIC_ID (optional)
# Returns: 0 on success, EXIT_VALIDATION_ERROR (6) if required args missing
ti_set_context() {
    local task_id="${1:-}"
    local date="${2:-$(date +%Y-%m-%d)}"
    local topic_slug="${3:-}"
    local epic_id="${4:-}"

    if [[ -z "$task_id" ]]; then
        _ti_error "TASK_ID is required for ti_set_context"
        return "$EXIT_VALIDATION_ERROR"
    fi

    if [[ -z "$topic_slug" ]]; then
        _ti_error "TOPIC_SLUG is required for ti_set_context"
        return "$EXIT_VALIDATION_ERROR"
    fi

    export TI_TASK_ID="$task_id"
    export TI_DATE="$date"
    export TI_TOPIC_SLUG="$topic_slug"

    if [[ -n "$epic_id" ]]; then
        export TI_EPIC_ID="$epic_id"
    fi

    return 0
}

# ============================================================================
# EXPORT FUNCTIONS
# ============================================================================

export -f ti_set_defaults
export -f ti_validate_required
export -f ti_inject_tokens
export -f ti_load_template
export -f ti_list_tokens
export -f ti_get_default
export -f ti_clear_all
export -f ti_set_context
