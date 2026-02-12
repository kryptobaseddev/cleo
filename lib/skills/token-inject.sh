#!/usr/bin/env bash
# token-inject.sh - Token Injection Library for Subagent Templates
#
# LAYER: 1 (Foundation Services)
# DEPENDENCIES: exit-codes.sh
# PROVIDES: ti_inject_tokens, ti_validate_required, ti_set_defaults, ti_load_template, ti_reload_tokens, ti_populate_skill_specific_tokens, validate_token_value, ti_validate_all_tokens
#
# Implements strict token replacement with validation to prevent hallucination.
# All tokens use {{TOKEN_NAME}} format. Required tokens MUST be set before injection.
# Token definitions are loaded from skills/_shared/placeholders.json (single source of truth).
#
# USAGE:
#   source lib/skills/token-inject.sh
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
_TI_LIB_DIR="${BASH_SOURCE[0]%/*}/.."
[[ "$_TI_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _TI_LIB_DIR="."

# Determine project root (two levels up from lib/)
_TI_PROJECT_ROOT="${_TI_LIB_DIR}/.."
[[ -d "${_TI_PROJECT_ROOT}/skills" ]] || _TI_PROJECT_ROOT="."

# Path to placeholders.json (single source of truth)
_TI_PLACEHOLDERS_JSON="${_TI_PROJECT_ROOT}/skills/_shared/placeholders.json"

# Source dependencies
# shellcheck source=lib/core/exit-codes.sh
source "${_TI_LIB_DIR}/core/exit-codes.sh"

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
        "EPIC_ID" "SESSION_ID" "RESEARCH_ID" "TITLE" "PARENT_ID"
        # Task system commands
        "TASK_SHOW_CMD" "TASK_FOCUS_CMD" "TASK_FOCUS_SHOW_CMD" "TASK_COMPLETE_CMD"
        "TASK_LINK_CMD" "TASK_LIST_CMD" "TASK_FIND_CMD" "TASK_ADD_CMD"
        "TASK_EXISTS_CMD" "TASK_PHASE_CMD" "TASK_TREE_CMD"
        # Session commands
        "SESSION_LIST_CMD" "SESSION_START_CMD" "SESSION_END_CMD" "SESSION_GC_CMD"
        # Research commands
        "RESEARCH_LIST_CMD" "RESEARCH_SHOW_CMD" "RESEARCH_PENDING_CMD" "RESEARCH_INJECT_CMD"
        # Dashboard
        "DASH_CMD"
        # Output paths
        "OUTPUT_DIR" "MANIFEST_PATH"
        # Manifest tokens
        "MANIFEST_ID" "MANIFEST_FILE" "MANIFEST_TITLE" "MANIFEST_STATUS"
        "MANIFEST_TOPICS" "MANIFEST_FINDINGS" "LINKED_TASKS" "NEEDS_FOLLOWUP"
        # taskContext tokens (populated from CLEO task data)
        "TASK_TITLE" "TASK_NAME" "TASK_DESCRIPTION" "TASK_INSTRUCTIONS"
        "TOPICS_JSON" "DEPENDS_LIST" "ACCEPTANCE_CRITERIA" "DELIVERABLES_LIST"
        "MANIFEST_SUMMARIES" "NEXT_TASK_IDS"
        # skillSpecific tokens
        "FEATURE_SLUG" "FEATURE_NAME" "FEATURE_DESCRIPTION"
        "TEST_SCOPE" "TARGET_PATH"
    )
    _TI_CLEO_DEFAULTS=(
        # Task commands
        ["TASK_SHOW_CMD"]="cleo show"
        ["TASK_FOCUS_CMD"]="cleo focus set"
        ["TASK_FOCUS_SHOW_CMD"]="cleo focus show"
        ["TASK_COMPLETE_CMD"]="cleo complete"
        ["TASK_LINK_CMD"]="cleo research link"
        ["TASK_LIST_CMD"]="cleo list"
        ["TASK_FIND_CMD"]="cleo find"
        ["TASK_ADD_CMD"]="cleo add"
        ["TASK_EXISTS_CMD"]="cleo exists"
        ["TASK_PHASE_CMD"]="cleo phase show"
        ["TASK_TREE_CMD"]="cleo list --tree"
        # Session commands
        ["SESSION_LIST_CMD"]="cleo session list"
        ["SESSION_START_CMD"]="cleo session start"
        ["SESSION_END_CMD"]="cleo session end"
        ["SESSION_GC_CMD"]="cleo session gc"
        # Research commands
        ["RESEARCH_LIST_CMD"]="cleo research list"
        ["RESEARCH_SHOW_CMD"]="cleo research show"
        ["RESEARCH_PENDING_CMD"]="cleo research pending"
        ["RESEARCH_INJECT_CMD"]="cleo research inject"
        # Dashboard
        ["DASH_CMD"]="cleo dash"
        # Output paths
        ["OUTPUT_DIR"]="claudedocs/agent-outputs"
        ["MANIFEST_PATH"]="claudedocs/agent-outputs/MANIFEST.jsonl"
        # Context tokens
        ["EPIC_ID"]=""
        ["SESSION_ID"]=""
        ["RESEARCH_ID"]=""
        ["TITLE"]=""
        ["PARENT_ID"]=""
        # Manifest defaults
        ["MANIFEST_ID"]=""
        ["MANIFEST_FILE"]=""
        ["MANIFEST_TITLE"]=""
        ["MANIFEST_STATUS"]="complete"
        ["MANIFEST_TOPICS"]="[]"
        ["MANIFEST_FINDINGS"]="[]"
        ["LINKED_TASKS"]="[]"
        ["NEEDS_FOLLOWUP"]="[]"
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
        # skillSpecific defaults
        ["FEATURE_SLUG"]=""
        ["FEATURE_NAME"]=""
        ["FEATURE_DESCRIPTION"]=""
        ["TEST_SCOPE"]=""
        ["TARGET_PATH"]=""
    )
    _TI_TOKEN_PATTERNS=(
        ["TASK_ID"]="^T[0-9]+$"
        ["DATE"]="^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
        ["TOPIC_SLUG"]="^[a-zA-Z0-9_-]+$"
        ["EPIC_ID"]="^T[0-9]+$"
        ["PARENT_ID"]="^T[0-9]+$"
        ["SESSION_ID"]="^session_[0-9]{8}_[0-9]{6}_[a-f0-9]+$"
    )
}

# Load tokens on source
_ti_load_tokens_from_json

# ============================================================================
# TOKEN VALIDATION
# ============================================================================

# Associative array for validation rules loaded from placeholders.json
declare -A _TI_VALIDATION_RULES=()

# _ti_load_validation_rules - Load validation rules from placeholders.json
# Args: none
# Returns: 0 on success
# Side effects: Populates _TI_VALIDATION_RULES with type and constraints per token
_ti_load_validation_rules() {
    local json_path="$_TI_PLACEHOLDERS_JSON"

    # Check file exists
    if [[ ! -f "$json_path" ]]; then
        return 0
    fi

    # Check jq is available
    if ! command -v jq &>/dev/null; then
        return 0
    fi

    # Clear existing rules
    _TI_VALIDATION_RULES=()

    # Load validation rules from all sections
    local sections=("required" "context" "taskContext.tokens" "manifest.tokens")

    for section in "${sections[@]}"; do
        local tokens_json
        tokens_json=$(jq -c ".$section // []" "$json_path" 2>/dev/null) || continue

        if [[ "$tokens_json" == "[]" || "$tokens_json" == "null" ]]; then
            continue
        fi

        # Extract token validation rules
        local rules
        rules=$(echo "$tokens_json" | jq -r '.[] | "\(.token)|\(.type // "string")|\(.pattern // "")|\(.enum // [] | join(","))|\(.required // false)"' 2>/dev/null) || continue

        while IFS='|' read -r token_name type pattern enum_vals required; do
            [[ -z "$token_name" ]] && continue
            # Store as: type:pattern:enum:required
            _TI_VALIDATION_RULES["$token_name"]="${type}:${pattern}:${enum_vals}:${required}"
        done <<< "$rules"
    done

    return 0
}

# validate_token_value - Validate a token value against its type constraints
# Args:
#   $1 = token name (without TI_ prefix)
#   $2 = value to validate
#   $3 = validation type (optional, auto-detected from placeholders.json if not provided)
#        Supported types: string, enum, path, array, required
#   $4 = validation constraint (optional)
#        For enum: comma-separated allowed values
#        For array: optional JSON schema or length constraint (e.g., "minLength:3,maxLength:7")
#        For path: "file", "dir", or "any" (default: "any")
# Returns: 0 if valid, EXIT_VALIDATION_ERROR (6) if invalid
# Output: Error message to stderr if validation fails
#
# Examples:
#   validate_token_value "MANIFEST_STATUS" "complete" "enum" "complete,partial,blocked"
#   validate_token_value "OUTPUT_DIR" "claudedocs/agent-outputs" "path" "dir"
#   validate_token_value "TOPICS_JSON" '["auth","api"]' "array"
#   validate_token_value "TASK_ID" "T1234"  # Auto-detects type from placeholders.json
validate_token_value() {
    local token_name="${1:-}"
    local value="${2:-}"
    local val_type="${3:-}"
    local constraint="${4:-}"

    # Token name is required
    if [[ -z "$token_name" ]]; then
        _ti_error "validate_token_value: token_name is required"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Auto-detect validation type from rules if not provided
    if [[ -z "$val_type" ]]; then
        local rule="${_TI_VALIDATION_RULES[$token_name]:-}"
        if [[ -n "$rule" ]]; then
            # Parse rule: type:pattern:enum:required
            val_type="${rule%%:*}"
            local remainder="${rule#*:}"
            local pattern="${remainder%%:*}"
            remainder="${remainder#*:}"
            local enum_vals="${remainder%%:*}"
            local required="${remainder##*:}"

            # Set constraint based on type
            case "$val_type" in
                enum)
                    [[ -z "$constraint" && -n "$enum_vals" ]] && constraint="$enum_vals"
                    ;;
                path)
                    [[ -z "$constraint" ]] && constraint="any"
                    ;;
            esac

            # Check required first
            if [[ "$required" == "true" && -z "$value" ]]; then
                _ti_error "Token '$token_name' is required but value is empty"
                return "$EXIT_VALIDATION_ERROR"
            fi
        else
            # No rule found, default to string validation
            val_type="string"
        fi
    fi

    # Empty values for non-required fields are valid
    if [[ -z "$value" && "$val_type" != "required" ]]; then
        return 0
    fi

    # Validate based on type
    case "$val_type" in
        required)
            if [[ -z "$value" ]]; then
                _ti_error "Token '$token_name' is required but value is empty"
                return "$EXIT_VALIDATION_ERROR"
            fi
            ;;

        string)
            # String validation - check pattern if available in rules
            local rule="${_TI_VALIDATION_RULES[$token_name]:-}"
            if [[ -n "$rule" ]]; then
                local pattern="${rule#*:}"
                pattern="${pattern%%:*}"
                if [[ -n "$pattern" && ! "$value" =~ $pattern ]]; then
                    _ti_error "Token '$token_name' value '$value' does not match pattern: $pattern"
                    return "$EXIT_VALIDATION_ERROR"
                fi
            fi
            ;;

        enum)
            if [[ -z "$constraint" ]]; then
                _ti_error "validate_token_value: enum constraint is required for type 'enum'"
                return "$EXIT_VALIDATION_ERROR"
            fi

            # Split constraint into array and check value
            local valid=0
            IFS=',' read -ra allowed_values <<< "$constraint"
            for allowed in "${allowed_values[@]}"; do
                if [[ "$value" == "$allowed" ]]; then
                    valid=1
                    break
                fi
            done

            if [[ $valid -eq 0 ]]; then
                _ti_error "Token '$token_name' value '$value' is not in allowed values: $constraint"
                return "$EXIT_VALIDATION_ERROR"
            fi
            ;;

        path)
            local path_type="${constraint:-any}"

            # Check for obviously invalid paths
            if [[ "$value" =~ [[:cntrl:]] ]]; then
                _ti_error "Token '$token_name' path contains invalid characters"
                return "$EXIT_VALIDATION_ERROR"
            fi

            # Validate path existence based on constraint
            case "$path_type" in
                file)
                    if [[ ! -f "$value" ]]; then
                        _ti_error "Token '$token_name' path '$value' is not an existing file"
                        return "$EXIT_VALIDATION_ERROR"
                    fi
                    ;;
                dir)
                    if [[ ! -d "$value" ]]; then
                        _ti_error "Token '$token_name' path '$value' is not an existing directory"
                        return "$EXIT_VALIDATION_ERROR"
                    fi
                    ;;
                any)
                    # Path must exist as either file or directory
                    if [[ ! -e "$value" ]]; then
                        # For "any", we allow non-existent paths (they may be created later)
                        # Only warn, don't fail
                        _ti_warn "Token '$token_name' path '$value' does not exist (may be created later)"
                    fi
                    ;;
                exists)
                    # Strict: path must exist
                    if [[ ! -e "$value" ]]; then
                        _ti_error "Token '$token_name' path '$value' does not exist"
                        return "$EXIT_VALIDATION_ERROR"
                    fi
                    ;;
            esac
            ;;

        array)
            # Verify jq is available for array validation
            if ! command -v jq &>/dev/null; then
                _ti_warn "jq not available, skipping array validation for '$token_name'"
                return 0
            fi

            # Validate JSON array syntax
            if ! echo "$value" | jq empty 2>/dev/null; then
                _ti_error "Token '$token_name' value is not valid JSON"
                return "$EXIT_VALIDATION_ERROR"
            fi

            # Check if it's actually an array
            local is_array
            is_array=$(echo "$value" | jq 'type == "array"' 2>/dev/null)
            if [[ "$is_array" != "true" ]]; then
                _ti_error "Token '$token_name' value is not a JSON array"
                return "$EXIT_VALIDATION_ERROR"
            fi

            # Check length constraints if provided
            if [[ -n "$constraint" ]]; then
                local length
                length=$(echo "$value" | jq 'length' 2>/dev/null)

                # Parse constraint (e.g., "minLength:3,maxLength:7" or just "3-7")
                if [[ "$constraint" =~ ^([0-9]+)-([0-9]+)$ ]]; then
                    local min="${BASH_REMATCH[1]}"
                    local max="${BASH_REMATCH[2]}"

                    if [[ $length -lt $min ]]; then
                        _ti_error "Token '$token_name' array has $length items, minimum is $min"
                        return "$EXIT_VALIDATION_ERROR"
                    fi
                    if [[ $length -gt $max ]]; then
                        _ti_error "Token '$token_name' array has $length items, maximum is $max"
                        return "$EXIT_VALIDATION_ERROR"
                    fi
                elif [[ "$constraint" =~ minLength:([0-9]+) ]]; then
                    local min="${BASH_REMATCH[1]}"
                    if [[ $length -lt $min ]]; then
                        _ti_error "Token '$token_name' array has $length items, minimum is $min"
                        return "$EXIT_VALIDATION_ERROR"
                    fi
                elif [[ "$constraint" =~ maxLength:([0-9]+) ]]; then
                    local max="${BASH_REMATCH[1]}"
                    if [[ $length -gt $max ]]; then
                        _ti_error "Token '$token_name' array has $length items, maximum is $max"
                        return "$EXIT_VALIDATION_ERROR"
                    fi
                fi
            fi
            ;;

        *)
            _ti_warn "Unknown validation type '$val_type' for token '$token_name', skipping validation"
            ;;
    esac

    return 0
}

# ti_validate_all_tokens - Validate all set TI_* tokens against their rules
# Args: none
# Returns: 0 if all valid, EXIT_VALIDATION_ERROR (6) if any invalid
# Output: Error messages to stderr for each validation failure
#
# This function iterates through all known tokens and validates their values
# against the rules defined in placeholders.json. It's useful for batch
# validation before template injection.
ti_validate_all_tokens() {
    local has_error=0
    local token value

    for token in "${_TI_ALL_TOKENS[@]}"; do
        value=$(_ti_get_token_value "$token")

        # Skip empty optional tokens
        if [[ -z "$value" ]] && ! _ti_is_required "$token"; then
            continue
        fi

        # Validate the token
        if ! validate_token_value "$token" "$value"; then
            has_error=1
        fi
    done

    if [[ $has_error -eq 1 ]]; then
        return "$EXIT_VALIDATION_ERROR"
    fi

    return 0
}

# Load validation rules on source
_ti_load_validation_rules

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
        # Use bash parameter expansion - handles multiline values and special chars safely
        # (sed breaks on newlines, |, &, and \ in replacement values)
        local pattern="{{${token}}}"
        output="${output//$pattern/$value}"
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


# ti_extract_manifest_summaries - Extract key_findings from recent MANIFEST.jsonl entries
# Args:
#   $1 = limit (optional, default 5) - number of recent entries to read
# Returns: 0 on success, EXIT_FILE_ERROR (3) if manifest not found
# Side effects: Exports TI_MANIFEST_SUMMARIES environment variable
#
# Reads the last N entries from MANIFEST.jsonl and extracts key_findings
# to provide context for subagent spawning.
ti_extract_manifest_summaries() {
    local limit="${1:-5}"
    local manifest_path="${TI_MANIFEST_PATH:-claudedocs/agent-outputs/MANIFEST.jsonl}"

    # Check if manifest exists
    if [[ ! -f "$manifest_path" ]]; then
        _ti_warn "MANIFEST.jsonl not found at $manifest_path"
        export TI_MANIFEST_SUMMARIES=""
        return 0  # Not an error - manifest may not exist yet
    fi

    # Verify jq is available
    if ! command -v jq &>/dev/null; then
        _ti_warn "jq not available, cannot extract manifest summaries"
        export TI_MANIFEST_SUMMARIES=""
        return 0
    fi

    # Extract last N entries and format as summary
    local summaries=""
    local entry_count=0

    # Read last N lines and process each entry
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue

        # Extract fields from entry
        local title id key_findings_json status
        title=$(echo "$line" | jq -r '.title // ""' 2>/dev/null) || continue
        id=$(echo "$line" | jq -r '.id // ""' 2>/dev/null) || continue
        status=$(echo "$line" | jq -r '.status // ""' 2>/dev/null) || continue
        key_findings_json=$(echo "$line" | jq -c '.key_findings // []' 2>/dev/null) || continue

        # Skip if no title or findings
        [[ -z "$title" || "$key_findings_json" == "[]" || "$key_findings_json" == "null" ]] && continue

        # Format entry header
        summaries+="### ${title}"
        [[ -n "$id" ]] && summaries+=" (${id})"
        summaries+=$'\n'

        # Format key findings as bullets
        local findings
        findings=$(echo "$key_findings_json" | jq -r '.[] | "- " + .' 2>/dev/null)
        if [[ -n "$findings" ]]; then
            summaries+="$findings"$'\n'
        fi

        summaries+=$'\n'
        ((entry_count++))

    done < <(tail -n "$limit" "$manifest_path" | tac)  # tac reverses for most-recent-first

    # If no entries found, use empty string
    if [[ $entry_count -eq 0 ]]; then
        export TI_MANIFEST_SUMMARIES=""
    else
        # Trim trailing newlines and export
        summaries="${summaries%$'\n'}"
        summaries="${summaries%$'\n'}"
        export TI_MANIFEST_SUMMARIES="$summaries"
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
# Also calls ti_extract_manifest_summaries() to populate TI_MANIFEST_SUMMARIES.
#
# The following token is NOT populated here (orchestrator provides it):
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

    # Extract acceptance criteria
    # Priority: task.acceptance array > parse from description > default
    local acceptance_criteria=""
    local acceptance_array
    acceptance_array=$(echo "$task_json" | jq -c '.task.acceptance // []')

    if [[ "$acceptance_array" != "[]" && "$acceptance_array" != "null" ]]; then
        # Format acceptance array as markdown bulleted list
        acceptance_criteria=$(echo "$task_json" | jq -r '(.task.acceptance // []) | map("- " + .) | join("\n")')
    elif [[ -n "$description" ]]; then
        # Try to parse acceptance criteria from description
        # Look for common patterns: "Acceptance Criteria:", "AC:", "Criteria:", numbered lists after these
        local parsed_ac
        parsed_ac=$(echo "$description" | grep -iE '(acceptance|criteria|requirements|must|should):' | head -5 || true)

        if [[ -n "$parsed_ac" ]]; then
            acceptance_criteria="$parsed_ac"
        else
            # Use default
            acceptance_criteria="Task completed successfully per description"
        fi
    else
        # Use default
        acceptance_criteria="Task completed successfully per description"
    fi

    export TI_ACCEPTANCE_CRITERIA="$acceptance_criteria"

    # Extract deliverables list
    # Priority: task.deliverables array > task.files array > parse from description > default
    local deliverables_list=""
    local deliverables_array
    deliverables_array=$(echo "$task_json" | jq -c '.task.deliverables // []')

    if [[ "$deliverables_array" != "[]" && "$deliverables_array" != "null" ]]; then
        # Format deliverables array as markdown bulleted list
        deliverables_list=$(echo "$task_json" | jq -r '(.task.deliverables // []) | map("- " + .) | join("\n")')
    else
        # Fall back to task.files array
        local files_array
        files_array=$(echo "$task_json" | jq -c '.task.files // []')

        if [[ "$files_array" != "[]" && "$files_array" != "null" ]]; then
            # Format files array as markdown bulleted list
            deliverables_list=$(echo "$task_json" | jq -r '(.task.files // []) | map("- " + .) | join("\n")')
        elif [[ -n "$description" ]]; then
            # Try to parse deliverables from description
            # Look for patterns: "Deliverables:", "Output:", "Files:", numbered/bulleted lists
            local parsed_deliverables
            parsed_deliverables=$(echo "$description" | grep -iE '(deliverables?|outputs?|files?|creates?):' | head -5 || true)

            if [[ -n "$parsed_deliverables" ]]; then
                deliverables_list="$parsed_deliverables"
            else
                # Use default
                deliverables_list="Implementation per task description"
            fi
        else
            # Use default
            deliverables_list="Implementation per task description"
        fi
    fi

    export TI_DELIVERABLES_LIST="$deliverables_list"

    # Extract manifest summaries for context from previous subagent work
    ti_extract_manifest_summaries

    return 0
}

# ti_extract_next_task_ids - Identify tasks that become unblocked after current task completion
# Args:
#   $1 = task_id (optional, defaults to TI_TASK_ID)
# Returns: 0 on success, 1 if no task ID available
# Side effects: Exports TI_NEXT_TASK_IDS environment variable (comma-separated list)
#
# Analyzes dependencies to find tasks that depend on the current task and would
# become executable after the current task completes. A task becomes unblocked
# when ALL its dependencies are done (or will be done including the current task).
#
# Example output: "T1234,T1235,T1236"
ti_extract_next_task_ids() {
    local task_id="${1:-${TI_TASK_ID:-}}"

    # If no task ID provided, try to get from focus
    if [[ -z "$task_id" ]]; then
        if command -v cleo &>/dev/null; then
            task_id=$(cleo focus show --quiet 2>/dev/null || true)
        fi
    fi

    if [[ -z "$task_id" ]]; then
        _ti_warn "No task ID available for dependency analysis"
        export TI_NEXT_TASK_IDS=""
        return 0
    fi

    # Verify cleo and jq are available
    if ! command -v cleo &>/dev/null; then
        _ti_warn "cleo not available, cannot analyze dependencies"
        export TI_NEXT_TASK_IDS=""
        return 0
    fi

    if ! command -v jq &>/dev/null; then
        _ti_warn "jq not available, cannot analyze dependencies"
        export TI_NEXT_TASK_IDS=""
        return 0
    fi

    # Get downstream dependents (tasks that depend on current task)
    local deps_json
    deps_json=$(cleo deps "$task_id" --format json 2>/dev/null || echo '{"downstream_dependents":[]}')

    local dependents
    dependents=$(echo "$deps_json" | jq -r '.downstream_dependents // [] | .[]' 2>/dev/null)

    if [[ -z "$dependents" ]]; then
        # No tasks depend on this one
        export TI_NEXT_TASK_IDS=""
        return 0
    fi

    # Get all tasks to check their dependency status
    local all_tasks_json
    all_tasks_json=$(cleo list --format json 2>/dev/null || echo '{"tasks":[]}')

    # For each dependent, check if it would become unblocked
    local next_ids=()
    local dependent_id

    while IFS= read -r dependent_id; do
        [[ -z "$dependent_id" ]] && continue

        # Get dependent task's dependencies
        local task_deps
        task_deps=$(echo "$all_tasks_json" | jq -r --arg id "$dependent_id" \
            '.tasks[] | select(.id == $id) | .depends // [] | .[]' 2>/dev/null)

        if [[ -z "$task_deps" ]]; then
            # Task has no dependencies listed, should already be unblocked
            continue
        fi

        # Check if all OTHER dependencies are done
        local all_deps_satisfied=1
        local dep

        while IFS= read -r dep; do
            [[ -z "$dep" ]] && continue

            # Skip the current task (we're assuming it will be done)
            [[ "$dep" == "$task_id" ]] && continue

            # Check if this dependency is done
            local dep_status
            dep_status=$(echo "$all_tasks_json" | jq -r --arg id "$dep" \
                '.tasks[] | select(.id == $id) | .status // "pending"' 2>/dev/null)

            if [[ "$dep_status" != "done" ]]; then
                all_deps_satisfied=0
                break
            fi
        done <<< "$task_deps"

        # If all other deps are done, this task will become unblocked
        if [[ $all_deps_satisfied -eq 1 ]]; then
            next_ids+=("$dependent_id")
        fi
    done <<< "$dependents"

    # Format as comma-separated list
    local result=""
    if [[ ${#next_ids[@]} -gt 0 ]]; then
        result=$(IFS=','; echo "${next_ids[*]}")
    fi

    export TI_NEXT_TASK_IDS="$result"
    return 0
}

# ti_populate_skill_specific_tokens - Load skill-specific tokens from placeholders.json
# Args:
#   $1 = skill name (e.g., "epicArchitect", "validator", "taskExecutor")
# Returns: 0 on success, EXIT_VALIDATION_ERROR (6) if skill not found
# Side effects: Exports TI_* environment variables for each skill-specific token
#
# Reads tokens from .skillSpecific[skillName] in placeholders.json and exports
# them as TI_* environment variables. Tokens with "inherits" property will
# copy values from already-set taskContext tokens.
#
# Example usage:
#   ti_set_task_context "$task_json"  # Set base taskContext tokens first
#   ti_populate_skill_specific_tokens "taskExecutor"  # Add skill-specific tokens
#
# This allows skills to define additional tokens or override defaults from taskContext.
ti_populate_skill_specific_tokens() {
    local skill_name="${1:-}"

    if [[ -z "$skill_name" ]]; then
        _ti_error "skill_name is required for ti_populate_skill_specific_tokens"
        return "$EXIT_VALIDATION_ERROR"
    fi

    local json_path="$_TI_PLACEHOLDERS_JSON"

    # Check file exists
    if [[ ! -f "$json_path" ]]; then
        _ti_warn "placeholders.json not found at $json_path, skipping skill-specific tokens"
        return 0
    fi

    # Check jq is available
    if ! command -v jq &>/dev/null; then
        _ti_warn "jq not available, skipping skill-specific tokens"
        return 0
    fi

    # Check if skill exists in skillSpecific section
    local skill_exists
    skill_exists=$(jq -r --arg skill "$skill_name" '.skillSpecific[$skill] // empty' "$json_path" 2>/dev/null)

    if [[ -z "$skill_exists" || "$skill_exists" == "null" ]]; then
        _ti_warn "Skill '$skill_name' not found in skillSpecific section"
        return 0  # Not an error - skill may not have specific tokens
    fi

    # Load skill-specific tokens
    local tokens_json
    tokens_json=$(jq -c --arg skill "$skill_name" '.skillSpecific[$skill] // []' "$json_path" 2>/dev/null)

    if [[ "$tokens_json" == "[]" || "$tokens_json" == "null" ]]; then
        return 0  # No tokens defined for this skill
    fi

    # Process each token
    local token_count
    token_count=$(echo "$tokens_json" | jq 'length' 2>/dev/null || echo "0")

    local i=0
    while [[ $i -lt $token_count ]]; do
        local token_def
        token_def=$(echo "$tokens_json" | jq -c ".[$i]" 2>/dev/null)

        # Extract token properties
        local token_name inherits_from default_val
        token_name=$(echo "$token_def" | jq -r '.token // ""' 2>/dev/null)
        inherits_from=$(echo "$token_def" | jq -r '.inherits // ""' 2>/dev/null)
        default_val=$(echo "$token_def" | jq -r '.default // ""' 2>/dev/null)

        if [[ -z "$token_name" ]]; then
            ((i++))
            continue
        fi

        local env_var="TI_${token_name}"
        local current_val="${!env_var:-}"

        # Skip if already set (don't override explicit values)
        if [[ -n "$current_val" ]]; then
            ((i++))
            continue
        fi

        # Handle inheritance from taskContext tokens
        if [[ -n "$inherits_from" && "$inherits_from" != "null" ]]; then
            # Parse inheritance source (e.g., "taskContext.TASK_TITLE" -> "TASK_TITLE")
            local source_token
            source_token="${inherits_from##*.}"  # Get part after last dot

            local source_env_var="TI_${source_token}"
            local inherited_val="${!source_env_var:-}"

            if [[ -n "$inherited_val" ]]; then
                export "$env_var"="$inherited_val"
                ((i++))
                continue
            fi
        fi

        # Fall back to default value if no inheritance or inherited value empty
        if [[ -n "$default_val" && "$default_val" != "null" ]]; then
            export "$env_var"="$default_val"
        fi

        # Add token to _TI_ALL_TOKENS if not already present
        if ! _ti_is_supported "$token_name"; then
            _TI_ALL_TOKENS+=("$token_name")
        fi

        ((i++))
    done

    return 0
}

# ti_verify_all_resolved - Check that all {{TOKEN}} patterns have been resolved
# Args: $1 = content to verify
#       $2 = strict mode (optional, default "false") - if "true", returns error on unresolved
# Returns: 0 if all resolved (or non-strict mode), EXIT_VALIDATION_ERROR (6) if unresolved in strict mode
# Output: List of unresolved tokens to stderr if any found
#
# This function verifies that NO {{TOKEN}} patterns remain after injection.
# Useful for final validation before spawning a subagent.
#
# Example:
#   if ! ti_verify_all_resolved "$prompt" "true"; then
#       echo "ERROR: Unresolved tokens in prompt"
#       exit 1
#   fi
ti_verify_all_resolved() {
    local content="${1:-}"
    local strict="${2:-false}"

    if [[ -z "$content" ]]; then
        _ti_error "Content is required for ti_verify_all_resolved"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Find all remaining {{TOKEN}} patterns
    local remaining
    remaining=$(echo "$content" | grep -oE '\{\{[A-Z_]+\}\}' | sort -u || true)

    if [[ -z "$remaining" ]]; then
        # All tokens resolved
        return 0
    fi

    # Count unresolved tokens
    local count
    count=$(echo "$remaining" | wc -l)

    # Log warnings
    _ti_warn "Found $count unresolved token(s) after injection:"
    echo "$remaining" | while IFS= read -r token; do
        [[ -n "$token" ]] && echo "  - $token" >&2
    done

    if [[ "$strict" == "true" ]]; then
        _ti_error "Strict mode: All tokens must be resolved before spawn"
        return "$EXIT_VALIDATION_ERROR"
    fi

    return 0
}

# ti_inject_and_verify - Combined injection and verification for spawn preparation
# Args: $1 = input text with {{TOKEN}} patterns
#       $2 = strict mode (optional, default "true") - fail if unresolved tokens remain
# Returns: 0 on success, EXIT_VALIDATION_ERROR (6) if validation fails
# Output: Injected text to stdout
#
# This is the recommended function for spawn preparation as it combines
# injection with mandatory verification.
ti_inject_and_verify() {
    local input="$1"
    local strict="${2:-true}"

    # Perform injection
    local output
    output=$(ti_inject_tokens "$input")

    # Verify all resolved
    if ! ti_verify_all_resolved "$output" "$strict"; then
        # In strict mode, still output the content but return error
        echo "$output"
        return "$EXIT_VALIDATION_ERROR"
    fi

    echo "$output"
    return 0
}

# ti_get_session_id - Get current CLEO session ID
# Args: none
# Returns: 0 on success
# Output: Session ID to stdout (empty if no active session)
ti_get_session_id() {
    if ! command -v cleo &>/dev/null; then
        return 0
    fi

    local session_json
    session_json=$(cleo session status --format json 2>/dev/null || echo '{}')

    if [[ -n "$session_json" && "$session_json" != "{}" ]]; then
        local session_id
        session_id=$(echo "$session_json" | jq -r '.session.id // ""' 2>/dev/null)
        echo "$session_id"
    fi

    return 0
}

# ti_set_full_context - Set ALL context tokens from task and session
# Args:
#   $1 = task_id (required)
#   $2 = date (optional, defaults to today)
#   $3 = topic_slug (optional, derived from title if not provided)
# Returns: 0 on success, EXIT_VALIDATION_ERROR (6) if task not found
# Side effects: Exports all TI_* environment variables for full token resolution
#
# This is the comprehensive context-setting function for orchestrator spawn.
# It sets:
#   - Required tokens (TASK_ID, DATE, TOPIC_SLUG)
#   - Context tokens (EPIC_ID, SESSION_ID, PARENT_ID, etc.)
#   - taskContext tokens (TASK_TITLE, TASK_DESCRIPTION, etc.)
#   - Command defaults
#   - Manifest context (RESEARCH_ID, OUTPUT paths)
ti_set_full_context() {
    local task_id="${1:-}"
    local date="${2:-$(date +%Y-%m-%d)}"
    local topic_slug="${3:-}"

    if [[ -z "$task_id" ]]; then
        _ti_error "task_id is required for ti_set_full_context"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Get task JSON from cleo
    local task_json
    task_json=$(cleo show "$task_id" --format json 2>/dev/null)

    if [[ -z "$task_json" || "$task_json" == "null" ]]; then
        _ti_error "Task not found: $task_id"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Check cleo success
    local cleo_success
    cleo_success=$(echo "$task_json" | jq -r '.success // false')
    if [[ "$cleo_success" != "true" ]]; then
        _ti_error "Failed to fetch task: $task_id"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Extract task metadata
    local title parent_id
    title=$(echo "$task_json" | jq -r '.task.title // "untitled"')
    parent_id=$(echo "$task_json" | jq -r '.task.parentId // ""')

    # Generate topic_slug if not provided
    if [[ -z "$topic_slug" ]]; then
        topic_slug=$(echo "$title" | tr '[:upper:]' '[:lower:]' | \
                     sed -E 's/[^a-z0-9]+/-/g' | sed -E 's/^-+|-+$//g')
        [[ -z "$topic_slug" ]] && topic_slug="task-${task_id}"
    fi

    # Set required tokens
    export TI_TASK_ID="$task_id"
    export TI_DATE="$date"
    export TI_TOPIC_SLUG="$topic_slug"

    # Set context tokens
    export TI_EPIC_ID="$parent_id"
    export TI_PARENT_ID="$parent_id"
    export TI_TITLE="$title"

    # Get session ID
    local session_id
    session_id=$(ti_get_session_id)
    [[ -n "$session_id" ]] && export TI_SESSION_ID="$session_id"

    # Generate research ID
    export TI_RESEARCH_ID="${topic_slug}-${date}"

    # Set command defaults
    ti_set_defaults

    # Set taskContext tokens from task JSON
    ti_set_task_context "$task_json"

    # Extract next task IDs for dependency tracking
    ti_extract_next_task_ids "$task_id"

    # Set computed manifest tokens
    export TI_MANIFEST_ID="${topic_slug}-${date}"
    export TI_MANIFEST_FILE="${date}_${topic_slug}.md"
    export TI_MANIFEST_TITLE="$title"

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
export -f ti_extract_manifest_summaries
export -f ti_extract_next_task_ids
export -f ti_reload_tokens
export -f ti_populate_skill_specific_tokens
export -f validate_token_value
export -f ti_validate_all_tokens
export -f ti_verify_all_resolved
export -f ti_inject_and_verify
export -f ti_get_session_id
export -f ti_set_full_context
