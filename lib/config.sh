#!/usr/bin/env bash
# config.sh - Central configuration loading and management for cleo
#
# LAYER: 1 (Core Infrastructure)
# DEPENDENCIES: exit-codes.sh, platform-compat.sh
# PROVIDES: get_config_value, set_config_value, get_cascade_threshold,
#           get_allow_cascade, get_require_reason, get_cancel_days_until_archive,
#           GLOBAL_CONFIG_FILE, PROJECT_CONFIG_FILE
#
# Priority resolution: CLI flags > Environment vars > Project config > Global config > Defaults

#=== SOURCE GUARD ================================================
[[ -n "${_CONFIG_SH_LOADED:-}" ]] && return 0
declare -r _CONFIG_SH_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_CONFIG_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source exit codes if available
if [[ -f "$_CONFIG_LIB_DIR/exit-codes.sh" ]]; then
    source "$_CONFIG_LIB_DIR/exit-codes.sh"
fi

# Source platform compatibility if available
if [[ -f "$_CONFIG_LIB_DIR/platform-compat.sh" ]]; then
    source "$_CONFIG_LIB_DIR/platform-compat.sh"
fi

# ============================================================================
# CONSTANTS
# ============================================================================

# Config file locations - use functions for dynamic path resolution
# This allows scripts to change cwd and have paths resolve correctly
GLOBAL_CONFIG_DIR="${CLEO_HOME:-$HOME/.cleo}"
GLOBAL_CONFIG_FILE="${GLOBAL_CONFIG_DIR}/config.json"

# PROJECT_CONFIG_FILE can be set before sourcing, or defaults to .cleo/config.json
# This supports test environments that set CONFIG_FILE before sourcing
if [[ -z "${PROJECT_CONFIG_FILE:-}" ]]; then
    if [[ -n "${CONFIG_FILE:-}" ]]; then
        PROJECT_CONFIG_FILE="$CONFIG_FILE"
    else
        PROJECT_CONFIG_FILE="${CLEO_DIR:-.cleo}/config.json"
    fi
fi

# Schema locations
GLOBAL_CONFIG_SCHEMA="${GLOBAL_CONFIG_DIR}/schemas/global-config.schema.json"
PROJECT_CONFIG_SCHEMA="${CLEO_DIR:-.cleo}/../schemas/config.schema.json"

# Environment variable prefix
ENV_PREFIX="CLEO"

# ============================================================================
# ENVIRONMENT VARIABLE MAPPING
# ============================================================================

# Map of environment variables to config paths
# Special cases and common overrides
declare -A ENV_TO_CONFIG=(
    # Special case - short form
    ["CLAUDE_TODO_FORMAT"]="output.defaultFormat"

    # Output settings
    ["CLAUDE_TODO_OUTPUT_DEFAULT_FORMAT"]="output.defaultFormat"
    ["CLAUDE_TODO_OUTPUT_SHOW_COLOR"]="output.showColor"
    ["CLAUDE_TODO_OUTPUT_SHOW_UNICODE"]="output.showUnicode"
    ["CLAUDE_TODO_OUTPUT_SHOW_PROGRESS_BARS"]="output.showProgressBars"
    ["CLAUDE_TODO_OUTPUT_DATE_FORMAT"]="output.dateFormat"

    # Archive settings
    ["CLAUDE_TODO_ARCHIVE_ENABLED"]="archive.enabled"
    ["CLAUDE_TODO_ARCHIVE_DAYS_UNTIL_ARCHIVE"]="archive.daysUntilArchive"
    ["CLAUDE_TODO_ARCHIVE_MAX_COMPLETED_TASKS"]="archive.maxCompletedTasks"
    ["CLAUDE_TODO_ARCHIVE_PRESERVE_RECENT_COUNT"]="archive.preserveRecentCount"
    ["CLAUDE_TODO_ARCHIVE_EXEMPT_LABELS"]="archive.exemptLabels"

    # Logging settings
    ["CLAUDE_TODO_LOGGING_ENABLED"]="logging.enabled"
    ["CLAUDE_TODO_LOGGING_LEVEL"]="logging.level"
    ["CLAUDE_TODO_LOGGING_RETENTION_DAYS"]="logging.retentionDays"

    # Validation settings
    ["CLAUDE_TODO_VALIDATION_STRICT_MODE"]="validation.strictMode"
    ["CLAUDE_TODO_VALIDATION_CHECKSUM_ENABLED"]="validation.checksumEnabled"
    ["CLAUDE_TODO_VALIDATION_REQUIRE_DESCRIPTION"]="validation.requireDescription"

    # Session settings
    ["CLAUDE_TODO_SESSION_REQUIRE_SESSION_NOTE"]="session.requireSessionNote"
    ["CLAUDE_TODO_SESSION_WARN_ON_NO_FOCUS"]="session.warnOnNoFocus"
    ["CLAUDE_TODO_SESSION_TIMEOUT_HOURS"]="session.sessionTimeoutHours"

    # Display settings
    ["CLAUDE_TODO_DISPLAY_SHOW_ARCHIVE_COUNT"]="display.showArchiveCount"
    ["CLAUDE_TODO_DISPLAY_SHOW_LOG_SUMMARY"]="display.showLogSummary"
    ["CLAUDE_TODO_DISPLAY_WARN_STALE_DAYS"]="display.warnStaleDays"

    # Debug settings
    ["CLAUDE_TODO_DEBUG"]="cli.debug.enabled"

    # Cancellation settings
    # NOTE: These mappings are explicit overrides for documentation purposes.
    # While env_to_config_path() would auto-convert these, explicit mappings
    # make the supported environment variables discoverable and self-documenting.
    ["CLAUDE_TODO_CANCELLATION_CASCADE_CONFIRM_THRESHOLD"]="cancellation.cascadeConfirmThreshold"
    ["CLAUDE_TODO_CANCELLATION_REQUIRE_REASON"]="cancellation.requireReason"
    ["CLAUDE_TODO_CANCELLATION_DAYS_UNTIL_ARCHIVE"]="cancellation.daysUntilArchive"
    ["CLAUDE_TODO_CANCELLATION_ALLOW_CASCADE"]="cancellation.allowCascade"
    ["CLAUDE_TODO_CANCELLATION_DEFAULT_CHILD_STRATEGY"]="cancellation.defaultChildStrategy"
)

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

# Convert environment variable name to config path
# Args: $1 = env var name (e.g., "CLAUDE_TODO_OUTPUT_SHOW_COLOR")
# Returns: config path (e.g., "output.showColor") or empty if not mapped
env_to_config_path() {
    local env_var="$1"

    # Check explicit mapping first
    if [[ -n "${ENV_TO_CONFIG[$env_var]:-}" ]]; then
        echo "${ENV_TO_CONFIG[$env_var]}"
        return 0
    fi

    # Try to convert automatically: CLAUDE_TODO_SECTION_KEY -> section.key
    if [[ "$env_var" =~ ^CLAUDE_TODO_([A-Z]+)_(.+)$ ]]; then
        local section="${BASH_REMATCH[1],,}"  # lowercase
        local key="${BASH_REMATCH[2]}"

        # Convert SNAKE_CASE to camelCase for the key
        key=$(echo "$key" | awk -F'_' '{
            result = tolower($1)
            for(i=2; i<=NF; i++) {
                result = result toupper(substr($i,1,1)) tolower(substr($i,2))
            }
            print result
        }')

        echo "${section}.${key}"
        return 0
    fi

    return 1
}

# Convert config path to jq filter
# Args: $1 = config path (e.g., "output.defaultFormat")
# Returns: jq filter (e.g., ".output.defaultFormat")
config_path_to_jq() {
    local path="$1"
    echo ".${path}"
}

# Check if value is a valid JSON type
# Args: $1 = value, $2 = expected type (string|boolean|number|array|object)
# Returns: 0 if valid, 1 if invalid
validate_type() {
    local value="$1"
    local expected_type="${2:-string}"

    case "$expected_type" in
        boolean)
            [[ "$value" =~ ^(true|false)$ ]] && return 0
            ;;
        number)
            [[ "$value" =~ ^-?[0-9]+\.?[0-9]*$ ]] && return 0
            ;;
        string)
            return 0  # Any value is a valid string
            ;;
        array|object)
            # Try to parse as JSON
            echo "$value" | jq -e '.' >/dev/null 2>&1 && return 0
            ;;
    esac

    return 1
}

# ============================================================================
# CONFIG FILE OPERATIONS
# ============================================================================

# Check if config file exists and is readable
# Args: $1 = config file path
# Returns: 0 if exists and readable, 1 otherwise
config_file_exists() {
    local config_file="$1"
    [[ -f "$config_file" && -r "$config_file" ]]
}

# Read a value from a config file
# Args: $1 = config file path, $2 = config path (e.g., "output.defaultFormat")
# Returns: value or empty if not found
# Note: Correctly handles boolean 'false' values (returns "false" not empty)
read_config_file() {
    local config_file="$1"
    local config_path="$2"

    if ! config_file_exists "$config_file"; then
        return 1
    fi

    local jq_filter
    jq_filter=$(config_path_to_jq "$config_path")

    # Use 'if . != null' instead of '// empty' to preserve boolean false values
    jq -r "${jq_filter} | if . != null then . else empty end" "$config_file" 2>/dev/null
}

# Write a value to a config file
# Args: $1 = config file path, $2 = config path, $3 = value, $4 = type (optional)
# Returns: 0 on success, 1 on failure
write_config_file() {
    local config_file="$1"
    local config_path="$2"
    local value="$3"
    local value_type="${4:-string}"

    if ! config_file_exists "$config_file"; then
        return 1
    fi

    local jq_filter
    jq_filter=$(config_path_to_jq "$config_path")

    local temp_file
    temp_file=$(mktemp)

    # Format value based on type
    local jq_value
    case "$value_type" in
        boolean|number)
            jq_value="$value"
            ;;
        array|object)
            jq_value="$value"
            ;;
        *)
            jq_value="\"$value\""
            ;;
    esac

    if jq "${jq_filter} = ${jq_value}" "$config_file" > "$temp_file" 2>/dev/null; then
        mv "$temp_file" "$config_file"
        return 0
    else
        rm -f "$temp_file"
        return 1
    fi
}

# ============================================================================
# PRIORITY RESOLUTION
# ============================================================================

# Get config value with priority resolution
# Priority: Environment var > Project config > Global config > Default
# Args: $1 = config path (e.g., "output.defaultFormat"), $2 = default value (optional)
# Returns: resolved value
get_config_value() {
    local config_path="$1"
    local default_value="${2:-}"
    local value=""

    # Determine which config file to use (allows runtime override via CONFIG_FILE env var)
    local project_config="${CONFIG_FILE:-$PROJECT_CONFIG_FILE}"

    # 1. Check environment variables (highest priority)
    for env_var in "${!ENV_TO_CONFIG[@]}"; do
        if [[ "${ENV_TO_CONFIG[$env_var]}" == "$config_path" ]]; then
            if [[ -n "${!env_var:-}" ]]; then
                echo "${!env_var}"
                return 0
            fi
        fi
    done

    # Also check dynamically constructed env var
    local upper_path
    upper_path=$(echo "$config_path" | tr '[:lower:].' '[:upper:]_')
    local dynamic_env_var="${ENV_PREFIX}_${upper_path}"
    if [[ -n "${!dynamic_env_var:-}" ]]; then
        echo "${!dynamic_env_var}"
        return 0
    fi

    # 2. Check project config (respects CONFIG_FILE override for tests)
    if config_file_exists "$project_config"; then
        value=$(read_config_file "$project_config" "$config_path")
        if [[ -n "$value" ]]; then
            echo "$value"
            return 0
        fi
    fi

    # 3. Check global config
    if config_file_exists "$GLOBAL_CONFIG_FILE"; then
        value=$(read_config_file "$GLOBAL_CONFIG_FILE" "$config_path")
        if [[ -n "$value" ]]; then
            echo "$value"
            return 0
        fi
    fi

    # 4. Return default
    echo "$default_value"
}

# Set config value (writes to project or global config)
# Args: $1 = config path, $2 = value, $3 = scope (project|global), $4 = type (optional)
# Returns: 0 on success, 1 on failure
set_config_value() {
    local config_path="$1"
    local value="$2"
    local scope="${3:-project}"
    local value_type="${4:-string}"

    local config_file
    if [[ "$scope" == "global" ]]; then
        config_file="$GLOBAL_CONFIG_FILE"
    else
        config_file="$PROJECT_CONFIG_FILE"
    fi

    if ! config_file_exists "$config_file"; then
        echo "ERROR: Config file not found: $config_file" >&2
        return 1
    fi

    write_config_file "$config_file" "$config_path" "$value" "$value_type"
}

# Get the effective config (merged global + project)
# Returns: JSON object with merged config
get_effective_config() {
    local global_config="{}"
    local project_config="{}"

    if config_file_exists "$GLOBAL_CONFIG_FILE"; then
        global_config=$(cat "$GLOBAL_CONFIG_FILE")
    fi

    if config_file_exists "$PROJECT_CONFIG_FILE"; then
        project_config=$(cat "$PROJECT_CONFIG_FILE")
    fi

    # Merge configs (project overrides global)
    echo "$global_config" "$project_config" | jq -s '.[0] * .[1]'
}

# Get a section from config
# Args: $1 = section name (e.g., "output"), $2 = scope (project|global|effective)
# Returns: JSON object for section
get_config_section() {
    local section="$1"
    local scope="${2:-effective}"

    local config
    case "$scope" in
        global)
            if config_file_exists "$GLOBAL_CONFIG_FILE"; then
                config=$(cat "$GLOBAL_CONFIG_FILE")
            else
                echo "{}"
                return 0
            fi
            ;;
        project)
            if config_file_exists "$PROJECT_CONFIG_FILE"; then
                config=$(cat "$PROJECT_CONFIG_FILE")
            else
                echo "{}"
                return 0
            fi
            ;;
        effective)
            config=$(get_effective_config)
            ;;
    esac

    echo "$config" | jq ".${section} // {}"
}

# ============================================================================
# VALIDATION
# ============================================================================

# Validate config against schema
# Args: $1 = config file path, $2 = schema file path
# Returns: 0 if valid, 1 if invalid
validate_config() {
    local config_file="$1"
    local schema_file="${2:-}"

    if ! config_file_exists "$config_file"; then
        echo "ERROR: Config file not found: $config_file" >&2
        return 1
    fi

    # If no schema specified, try to determine automatically
    if [[ -z "$schema_file" ]]; then
        if [[ "$config_file" == "$GLOBAL_CONFIG_FILE" ]]; then
            schema_file="$GLOBAL_CONFIG_SCHEMA"
        else
            schema_file="$PROJECT_CONFIG_SCHEMA"
        fi
    fi

    # Basic JSON validation
    if ! jq -e '.' "$config_file" >/dev/null 2>&1; then
        echo "ERROR: Invalid JSON in $config_file" >&2
        return 1
    fi

    # Schema validation if jsonschema available
    if command -v jsonschema &>/dev/null && [[ -f "$schema_file" ]]; then
        if ! jsonschema -i "$config_file" "$schema_file" 2>/dev/null; then
            return 1
        fi
    fi

    return 0
}

# ============================================================================
# INITIALIZATION
# ============================================================================

# Initialize global config if it doesn't exist
# Args: $1 = template file path (optional)
# Returns: 0 on success, 1 on failure
init_global_config() {
    local template="${1:-${GLOBAL_CONFIG_DIR}/templates/global-config.template.json}"

    # Create directory if needed
    mkdir -p "$(dirname "$GLOBAL_CONFIG_FILE")"

    # Don't overwrite existing config
    if config_file_exists "$GLOBAL_CONFIG_FILE"; then
        return 0
    fi

    # Copy from template if available
    if [[ -f "$template" ]]; then
        cp "$template" "$GLOBAL_CONFIG_FILE"
        return 0
    fi

    # Create minimal default config
    cat > "$GLOBAL_CONFIG_FILE" << 'EOF'
{
  "$schema": "./schemas/global-config.schema.json",
  "version": "1.0.0",
  "output": {
    "defaultFormat": "text",
    "showColor": true,
    "showUnicode": true,
    "showProgressBars": true,
    "dateFormat": "iso8601"
  },
  "display": {
    "showArchiveCount": true,
    "showLogSummary": true
  },
  "cli": {
    "aliases": {},
    "debug": {
      "enabled": false
    }
  }
}
EOF

    return 0
}

# ============================================================================
# EXPORTS
# ============================================================================

export GLOBAL_CONFIG_DIR
export GLOBAL_CONFIG_FILE
export PROJECT_CONFIG_FILE
export ENV_PREFIX

export -f env_to_config_path
export -f config_path_to_jq
export -f validate_type
export -f config_file_exists
export -f read_config_file
export -f write_config_file
export -f get_config_value
export -f set_config_value
export -f get_effective_config
export -f get_config_section
export -f validate_config
export -f init_global_config

# ============================================================================
# CANCELLATION CONFIGURATION GETTERS
# ============================================================================

# Get cascade confirmation threshold
# Returns: integer (default: 10)
# Usage: threshold=$(get_cascade_threshold)
get_cascade_threshold() {
    get_config_value "cancellation.cascadeConfirmThreshold" "10"
}

# Check if reason is required for cancellation
# Returns: "true" or "false" (default: true)
# Usage: if [[ "$(get_require_reason)" == "true" ]]; then ...
get_require_reason() {
    get_config_value "cancellation.requireReason" "true"
}

# Get days until cancelled tasks are archived
# Returns: integer (default: 3)
# Usage: days=$(get_cancel_days_until_archive)
get_cancel_days_until_archive() {
    get_config_value "cancellation.daysUntilArchive" "3"
}

# Check if cascade mode is allowed
# Returns: "true" or "false" (default: true)
# Usage: if [[ "$(get_allow_cascade)" == "true" ]]; then ...
get_allow_cascade() {
    get_config_value "cancellation.allowCascade" "true"
}

# Get default child strategy for cancellation
# Returns: "block", "orphan", "cascade", or "fail" (default: block)
# Usage: strategy=$(get_default_child_strategy)
get_default_child_strategy() {
    get_config_value "cancellation.defaultChildStrategy" "block"
}

# Get entire cancellation config section as JSON
# Returns: JSON object with all cancellation settings
# Usage: config_json=$(get_cancellation_config)
get_cancellation_config() {
    get_config_section "cancellation" "effective"
}

export -f get_cascade_threshold
export -f get_require_reason
export -f get_cancel_days_until_archive
export -f get_allow_cascade
export -f get_default_child_strategy
export -f get_cancellation_config
