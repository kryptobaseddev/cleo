#!/usr/bin/env bash
# token-inject.sh - Token Injection Library for Subagent Templates
#
# LAYER: 1 (Foundation Services)
# DEPENDENCIES: exit-codes.sh
# PROVIDES: ti_inject_tokens, ti_validate_required, ti_set_defaults, ti_load_template, ti_reload_tokens
#
# Implements strict token replacement with validation to prevent hallucination.
# All tokens use {{TOKEN_NAME}} format. Required tokens MUST be set before injection.
# Token definitions are loaded from skills/_shared/placeholders.json (single source of truth).
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

# Determine project root (two levels up from lib/)
_TI_PROJECT_ROOT="${_TI_LIB_DIR}/.."
[[ -d "${_TI_PROJECT_ROOT}/skills" ]] || _TI_PROJECT_ROOT="."

# Path to placeholders.json (single source of truth)
_TI_PLACEHOLDERS_JSON="${_TI_PROJECT_ROOT}/skills/_shared/placeholders.json"

# Source dependencies
# shellcheck source=lib/exit-codes.sh
source "${_TI_LIB_DIR}/exit-codes.sh"

# ============================================================================
# TOKEN DEFINITIONS (loaded from placeholders.json)
# ============================================================================

# Arrays populated from placeholders.json
declare -a _TI_REQUIRED_TOKENS=()
declare -a _TI_ALL_TOKENS=()
declare -A _TI_CLEO_DEFAULTS=()
declare -A _TI_TOKEN_PATTERNS=()

# _ti_load_tokens_from_json - Load token definitions from placeholders.json
# Args: none
# Returns: 0 on success, EXIT_FILE_ERROR (3) if file not found
# Side effects: Populates _TI_REQUIRED_TOKENS, _TI_ALL_TOKENS, _TI_CLEO_DEFAULTS, _TI_TOKEN_PATTERNS
_ti_load_tokens_from_json() {
    local json_path="$_TI_PLACEHOLDERS_JSON"

    # Check file exists
    if [[ ! -f "$json_path" ]]; then
        echo "[token-inject] WARNING: placeholders.json not found at $json_path, using fallback defaults" >&2
        _ti_set_fallback_defaults
        return 0
    fi

    # Check jq is available
    if ! command -v jq &>/dev/null; then
        echo "[token-inject] WARNING: jq not found, using fallback defaults" >&2
        _ti_set_fallback_defaults
        return 0
    fi

    # Clear existing arrays
    _TI_REQUIRED_TOKENS=()
    _TI_ALL_TOKENS=()
    _TI_CLEO_DEFAULTS=()
    _TI_TOKEN_PATTERNS=()

    # Load required tokens
    local required_tokens
    required_tokens=$(jq -r '.required[].token' "$json_path" 2>/dev/null || echo "")
    if [[ -n "$required_tokens" ]]; then
        while IFS= read -r token; do
            [[ -n "$token" ]] && _TI_REQUIRED_TOKENS+=("$token")
        done <<< "$required_tokens"
    fi

    # Load required token patterns
    local patterns
    patterns=$(jq -r '.required[] | "\(.token)=\(.pattern // "")"' "$json_path" 2>/dev/null || echo "")
    if [[ -n "$patterns" ]]; then
        while IFS= read -r line; do
            [[ -n "$line" ]] && _TI_TOKEN_PATTERNS["${line%%=*}"]="${line#*=}"
        done <<< "$patterns"
    fi

    # Load context tokens and their defaults
    local context_tokens
    context_tokens=$(jq -r '.context[] | "\(.token)=\(.default // "")"' "$json_path" 2>/dev/null || echo "")
    if [[ -n "$context_tokens" ]]; then
        while IFS= read -r line; do
            if [[ -n "$line" ]]; then
                local token="${line%%=*}"
                local default="${line#*=}"
                _TI_ALL_TOKENS+=("$token")
                [[ -n "$default" ]] && _TI_CLEO_DEFAULTS["$token"]="$default"
            fi
        done <<< "$context_tokens"
    fi

    # Load task command tokens
    local task_cmd_tokens
    task_cmd_tokens=$(jq -r '.taskCommands.tokens[] | "\(.token)=\(.default // "")"' "$json_path" 2>/dev/null || echo "")
    if [[ -n "$task_cmd_tokens" ]]; then
        while IFS= read -r line; do
            if [[ -n "$line" ]]; then
                local token="${line%%=*}"
                local default="${line#*=}"
                _TI_ALL_TOKENS+=("$token")
                [[ -n "$default" ]] && _TI_CLEO_DEFAULTS["$token"]="$default"
            fi
        done <<< "$task_cmd_tokens"
    fi

    # Load taskContext tokens (skill-specific tokens populated from CLEO task data)
    local task_context_tokens
    task_context_tokens=$(jq -r '.taskContext.tokens[] | "\(.token)=\(.default // "")"' "$json_path" 2>/dev/null || echo "")
    if [[ -n "$task_context_tokens" ]]; then
        while IFS= read -r line; do
            if [[ -n "$line" ]]; then
                local token="${line%%=*}"
                local default="${line#*=}"
                _TI_ALL_TOKENS+=("$token")
                [[ -n "$default" ]] && _TI_CLEO_DEFAULTS["$token"]="$default"
            fi
        done <<< "$task_context_tokens"
    fi

    # Add required tokens to all tokens
    for token in "${_TI_REQUIRED_TOKENS[@]}"; do
        _TI_ALL_TOKENS+=("$token")
    done

    # Remove duplicates from _TI_ALL_TOKENS while preserving order
    local seen_tokens=()
    local unique_tokens=()
    for token in "${_TI_ALL_TOKENS[@]}"; do
        local is_seen=0
        for seen in "${seen_tokens[@]+"${seen_tokens[@]}"}"; do
            [[ "$seen" == "$token" ]] && is_seen=1 && break
        done
        if [[ $is_seen -eq 0 ]]; then
            unique_tokens+=("$token")
            seen_tokens+=("$token")
        fi
    done
    _TI_ALL_TOKENS=("${unique_tokens[@]}")

    return 0
}

# _ti_set_fallback_defaults - Set hardcoded defaults when JSON unavailable
# Args: none
# Returns: 0 always
_ti_set_fallback_defaults() {
    _TI_REQUIRED_TOKENS=("TASK_ID" "DATE" "TOPIC_SLUG")
    _TI_ALL_TOKENS=(
        "TASK_ID" "DATE" "TOPIC_SLUG"
        "EPIC_ID" "SESSION_ID" "RESEARCH_ID" "TITLE"
        "TASK_SHOW_CMD" "TASK_FOCUS_CMD" "TASK_COMPLETE_CMD"
        "TASK_LINK_CMD" "TASK_LIST_CMD" "TASK_FIND_CMD" "TASK_ADD_CMD"
        "OUTPUT_DIR" "MANIFEST_PATH"
        # taskContext tokens (populated from CLEO task data)
        "TASK_TITLE" "TASK_NAME" "TASK_DESCRIPTION" "TASK_INSTRUCTIONS"
        "TOPICS_JSON" "DEPENDS_LIST" "ACCEPTANCE_CRITERIA" "DELIVERABLES_LIST"
        "MANIFEST_SUMMARIES" "NEXT_TASK_IDS"
    )
    _TI_CLEO_DEFAULTS=(
        ["TASK_SHOW_CMD"]="cleo show"
        ["TASK_FOCUS_CMD"]="cleo focus set"
        ["TASK_COMPLETE_CMD"]="cleo complete"
        ["TASK_LINK_CMD"]="cleo research link"
        ["TASK_LIST_CMD"]="cleo list"
        ["TASK_FIND_CMD"]="cleo find"
        ["TASK_ADD_CMD"]="cleo add"
        ["OUTPUT_DIR"]="claudedocs/research-outputs"
        ["MANIFEST_PATH"]="claudedocs/research-outputs/MANIFEST.jsonl"
        ["EPIC_ID"]=""
        ["SESSION_ID"]=""
        ["RESEARCH_ID"]=""
        ["TITLE"]=""
        # taskContext defaults
        ["TASK_TITLE"]=""
        ["TASK_NAME"]=""
        ["TASK_DESCRIPTION"]=""
        ["TASK_INSTRUCTIONS"]=""
        ["TOPICS_JSON"]="[]"
        ["DEPENDS_LIST"]=""
        ["ACCEPTANCE_CRITERIA"]="Task completed successfully per description"
        ["DELIVERABLES_LIST"]="Implementation per task description"
        ["MANIFEST_SUMMARIES"]=""
        ["NEXT_TASK_IDS"]=""
    )
    _TI_TOKEN_PATTERNS=(
        ["TASK_ID"]="^T[0-9]+$"
        ["DATE"]="^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
        ["TOPIC_SLUG"]="^[a-zA-Z0-9_-]+$"
    )
}

# Load tokens on source
_ti_load_tokens_from_json

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

    # Validate tokens against patterns from placeholders.json
    for token in "${_TI_REQUIRED_TOKENS[@]}"; do
        value=$(_ti_get_token_value "$token")
        local pattern="${_TI_TOKEN_PATTERNS[$token]:-}"

        if [[ -n "$value" && -n "$pattern" ]]; then
            if [[ ! "$value" =~ $pattern ]]; then
                # DATE is critical - fail on invalid format
                if [[ "$token" == "DATE" ]]; then
                    _ti_error "${token} '${value}' does not match expected pattern: ${pattern}"
                    return "$EXIT_VALIDATION_ERROR"
                else
                    # Other tokens - warn only
                    _ti_warn "${token} '${value}' does not match expected pattern: ${pattern}"
                fi
            fi
        fi
    done

    return 0
}

# ti_reload_tokens - Reload token definitions from placeholders.json
# Args: none
# Returns: 0 on success
# Side effects: Repopulates _TI_REQUIRED_TOKENS, _TI_ALL_TOKENS, _TI_CLEO_DEFAULTS
# Use this after modifying placeholders.json to pick up changes without reloading the library
ti_reload_tokens() {
    _ti_load_tokens_from_json
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


# ti_set_task_context - Populate taskContext tokens from CLEO task JSON
# Args:
#   $1 = task JSON from `cleo show TASK_ID --format json`
# Returns: 0 on success, EXIT_VALIDATION_ERROR (6) if JSON invalid
# Side effects: Exports TI_TASK_TITLE, TI_TASK_NAME, TI_TASK_DESCRIPTION, etc.
#
# This function extracts task data from CLEO and sets the corresponding
# TI_* environment variables for token injection:
#   - TI_TASK_TITLE (from task.title)
#   - TI_TASK_NAME (alias for TASK_TITLE)
#   - TI_TASK_DESCRIPTION (from task.description)
#   - TI_TASK_INSTRUCTIONS (defaults to task.description)
#   - TI_TOPICS_JSON (from task.labels as JSON array string)
#   - TI_DEPENDS_LIST (from task.depends as comma-separated string)
#
# The following tokens are NOT populated here (orchestrator provides them):
#   - TI_ACCEPTANCE_CRITERIA
#   - TI_DELIVERABLES_LIST
#   - TI_MANIFEST_SUMMARIES
#   - TI_NEXT_TASK_IDS
ti_set_task_context() {
    local task_json="${1:-}"

    if [[ -z "$task_json" ]]; then
        _ti_error "task_json is required for ti_set_task_context"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Verify jq is available
    if ! command -v jq &>/dev/null; then
        _ti_error "jq is required for ti_set_task_context"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Validate JSON
    if ! echo "$task_json" | jq empty 2>/dev/null; then
        _ti_error "Invalid JSON provided to ti_set_task_context"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Extract task title
    local title
    title=$(echo "$task_json" | jq -r '.task.title // ""')
    export TI_TASK_TITLE="$title"
    export TI_TASK_NAME="$title"  # alias

    # Extract task description
    local description
    description=$(echo "$task_json" | jq -r '.task.description // ""')
    export TI_TASK_DESCRIPTION="$description"
    export TI_TASK_INSTRUCTIONS="$description"  # defaults to description

    # Extract labels as JSON array string
    local labels_json
    labels_json=$(echo "$task_json" | jq -c '.task.labels // []')
    export TI_TOPICS_JSON="$labels_json"

    # Extract depends as comma-separated string
    local depends_list
    depends_list=$(echo "$task_json" | jq -r '(.task.depends // []) | join(", ")')
    export TI_DEPENDS_LIST="$depends_list"

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
export -f ti_set_task_context
export -f ti_reload_tokens
