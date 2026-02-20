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

_CONFIG_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source exit codes if available
if [[ -f "$_CONFIG_LIB_DIR/core/exit-codes.sh" ]]; then
    source "$_CONFIG_LIB_DIR/core/exit-codes.sh"
fi

# Source platform compatibility if available
if [[ -f "$_CONFIG_LIB_DIR/core/platform-compat.sh" ]]; then
    source "$_CONFIG_LIB_DIR/core/platform-compat.sh"
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
# CLEO_* variables only - no legacy CLAUDE_TODO_* support (clean break)
# NOTE: Temporarily disable -u because Bash 5.3+ interprets array keys as
# variable references under set -u, causing "unbound variable" errors.
# See: https://github.com/kryptobaseddev/cleo/issues/10
set +u
declare -A ENV_TO_CONFIG=(
    # Special case - short form
    ["CLEO_FORMAT"]="output.defaultFormat"

    # Output settings
    ["CLEO_OUTPUT_DEFAULT_FORMAT"]="output.defaultFormat"
    ["CLEO_OUTPUT_SHOW_COLOR"]="output.showColor"
    ["CLEO_OUTPUT_SHOW_UNICODE"]="output.showUnicode"
    ["CLEO_OUTPUT_SHOW_PROGRESS_BARS"]="output.showProgressBars"
    ["CLEO_OUTPUT_DATE_FORMAT"]="output.dateFormat"

    # Archive settings
    ["CLEO_ARCHIVE_ENABLED"]="archive.enabled"
    ["CLEO_ARCHIVE_DAYS_UNTIL_ARCHIVE"]="archive.daysUntilArchive"
    ["CLEO_ARCHIVE_MAX_COMPLETED_TASKS"]="archive.maxCompletedTasks"
    ["CLEO_ARCHIVE_PRESERVE_RECENT_COUNT"]="archive.preserveRecentCount"
    ["CLEO_ARCHIVE_EXEMPT_LABELS"]="archive.exemptLabels"

    # Logging settings
    ["CLEO_LOGGING_ENABLED"]="logging.enabled"
    ["CLEO_LOGGING_LEVEL"]="logging.level"
    ["CLEO_LOGGING_RETENTION_DAYS"]="logging.retentionDays"

    # Validation settings
    ["CLEO_VALIDATION_STRICT_MODE"]="validation.strictMode"
    ["CLEO_VALIDATION_CHECKSUM_ENABLED"]="validation.checksumEnabled"
    ["CLEO_VALIDATION_REQUIRE_DESCRIPTION"]="validation.requireDescription"

    # Session settings
    ["CLEO_SESSION_REQUIRE_SESSION_NOTE"]="session.requireSessionNote"
    ["CLEO_SESSION_WARN_ON_NO_FOCUS"]="session.warnOnNoFocus"
    ["CLEO_SESSION_TIMEOUT_HOURS"]="session.sessionTimeoutHours"

    # Display settings
    ["CLEO_DISPLAY_SHOW_ARCHIVE_COUNT"]="display.showArchiveCount"
    ["CLEO_DISPLAY_SHOW_LOG_SUMMARY"]="display.showLogSummary"
    ["CLEO_DISPLAY_WARN_STALE_DAYS"]="display.warnStaleDays"

    # Debug settings
    ["CLEO_DEBUG"]="cli.debug.enabled"

    # Cancellation settings
    # NOTE: These mappings are explicit overrides for documentation purposes.
    # While env_to_config_path() would auto-convert these, explicit mappings
    # make the supported environment variables discoverable and self-documenting.
    ["CLEO_CANCELLATION_CASCADE_CONFIRM_THRESHOLD"]="cancellation.cascadeConfirmThreshold"
    ["CLEO_CANCELLATION_REQUIRE_REASON"]="cancellation.requireReason"
    ["CLEO_CANCELLATION_DAYS_UNTIL_ARCHIVE"]="cancellation.daysUntilArchive"
    ["CLEO_CANCELLATION_ALLOW_CASCADE"]="cancellation.allowCascade"
    ["CLEO_CANCELLATION_DEFAULT_CHILD_STRATEGY"]="cancellation.defaultChildStrategy"
)
set -u  # Re-enable after array declaration

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

# Convert environment variable name to config path
# Args: $1 = env var name (e.g., "CLEO_OUTPUT_SHOW_COLOR")
# Returns: config path (e.g., "output.showColor") or empty if not mapped
env_to_config_path() {
    local env_var="$1"

    # Check explicit mapping first
    if [[ -n "${ENV_TO_CONFIG[$env_var]:-}" ]]; then
        echo "${ENV_TO_CONFIG[$env_var]}"
        return 0
    fi

    # Try to convert automatically: CLEO_SECTION_KEY -> section.key
    if [[ "$env_var" =~ ^CLEO_([A-Z]+)_(.+)$ ]]; then
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

    local new_content
    if ! new_content=$(jq "${jq_filter} = ${jq_value}" "$config_file" 2>/dev/null); then
        return 1
    fi

    # Use atomic_write if available (from file-ops.sh), otherwise fall back to
    # save_json. Both provide: lock, backup, write-to-temp, validate, rename.
    # Note: file-ops.sh sources config.sh, so atomic_write may not be available
    # during early initialization. In that case, use a safe temp+rename pattern.
    if declare -f save_json >/dev/null 2>&1; then
        save_json "$config_file" "$new_content"
    elif declare -f atomic_write >/dev/null 2>&1; then
        atomic_write "$config_file" "$new_content"
    else
        # Fallback: safe temp+rename (no lock/backup but still atomic rename)
        local temp_file
        temp_file=$(mktemp "${config_file}.XXXXXX")
        if printf '%s\n' "$new_content" > "$temp_file" 2>/dev/null; then
            mv "$temp_file" "$config_file"
        else
            rm -f "$temp_file"
            return 1
        fi
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

# ============================================================================
# ANALYZE CONFIGURATION GETTERS
# ============================================================================

# Get phase boost multiplier for current phase tasks
# Returns: number (default: 1.5)
# Usage: boost=$(get_phase_boost_current)
get_phase_boost_current() {
    get_config_value "analyze.phaseBoost.current" "1.5"
}

# Get phase boost multiplier for adjacent phase tasks
# Returns: number (default: 1.25)
# Usage: boost=$(get_phase_boost_adjacent)
get_phase_boost_adjacent() {
    get_config_value "analyze.phaseBoost.adjacent" "1.25"
}

# Get phase boost multiplier for distant phase tasks
# Returns: number (default: 1.0)
# Usage: boost=$(get_phase_boost_distant)
get_phase_boost_distant() {
    get_config_value "analyze.phaseBoost.distant" "1.0"
}

# Get entire phaseBoost config section as JSON
# Returns: JSON object with all phaseBoost settings
# Usage: config_json=$(get_phase_boost_config)
get_phase_boost_config() {
    get_config_section "analyze.phaseBoost" "effective"
}

# Get entire analyze config section as JSON
# Returns: JSON object with all analyze settings
# Usage: config_json=$(get_analyze_config)
get_analyze_config() {
    get_config_section "analyze" "effective"
}

export -f get_phase_boost_current
export -f get_phase_boost_adjacent
export -f get_phase_boost_distant
export -f get_phase_boost_config
export -f get_analyze_config

# ============================================================================
# CONFIGURATION INHERITANCE (extends support)
# ============================================================================

# Track loaded configs to detect circular dependencies
declare -a _LOADED_CONFIGS=()

# Check if config has already been loaded (circular dependency detection)
# Arguments:
#   $1 - Config path to check
# Returns: 0 if not loaded, 1 if already loaded
_is_config_loaded() {
    local config_path="$1"
    local loaded
    for loaded in "${_LOADED_CONFIGS[@]}"; do
        if [[ "$loaded" == "$config_path" ]]; then
            return 1  # Already loaded - circular dependency
        fi
    done
    return 0  # Not loaded yet
}

# Resolve config path (handles ~, relative paths, npm packages)
# Arguments:
#   $1 - Config path or package name
# Returns: Resolved absolute path
_resolve_config_path() {
    local config_path="$1"

    # Expand tilde
    config_path="${config_path/#\~/$HOME}"

    # Handle npm packages (starts with @)
    if [[ "$config_path" == @* ]]; then
        # Try to find in node_modules
        local npm_path="node_modules/${config_path}/config.json"
        if [[ -f "$npm_path" ]]; then
            echo "$(realpath "$npm_path")"
            return 0
        fi
        # Not found - return original (will fail later with clear error)
        echo "$config_path"
        return 1
    fi

    # Handle relative paths
    if [[ "$config_path" != /* ]]; then
        config_path="$(pwd)/$config_path"
    fi

    # Resolve to absolute path
    if [[ -f "$config_path" ]]; then
        echo "$(realpath "$config_path")"
        return 0
    fi

    echo "$config_path"
    return 1
}

# Deep merge two JSON objects (right wins for primitives, concat arrays, recursive merge objects)
# Arguments:
#   $1 - Base JSON
#   $2 - Override JSON
# Returns: Merged JSON
_deep_merge_json() {
    local base="$1"
    local override="$2"

    # Use jq for deep merge
    echo "$base" | jq -s --argjson override "$override" '
        def deep_merge(a; b):
            if (a | type) == "object" and (b | type) == "object" then
                a * b | to_entries | map(
                    if .value | type == "object" then
                        {key: .key, value: deep_merge(a[.key] // {}; .value)}
                    elif .value | type == "array" then
                        {key: .key, value: ((a[.key] // []) + .value | unique)}
                    else
                        .
                    end
                ) | from_entries
            else
                b
            end;
        deep_merge(.[0]; $override)
    '
}

# Load and merge extended configurations
# Processes the "extends" field recursively with circular dependency detection
# Arguments:
#   $1 - Config file path (optional, defaults to PROJECT_CONFIG_FILE)
# Returns: Merged configuration JSON
# Exit codes:
#   0 - Success
#   6 - Circular dependency detected (E_VALIDATION_FAILED)
load_extended_config() {
    local config_file="${1:-$PROJECT_CONFIG_FILE}"
    local resolved_path
    local extends_value
    local extended_config
    local merged_config

    # Resolve path
    resolved_path=$(_resolve_config_path "$config_file") || {
        echo "Error: Cannot resolve config path: $config_file" >&2
        return 1
    }

    # Check for circular dependency
    if ! _is_config_loaded "$resolved_path"; then
        echo "Error: Circular dependency detected: $resolved_path" >&2
        return 6  # E_VALIDATION_FAILED
    fi

    # Mark as loaded
    _LOADED_CONFIGS+=("$resolved_path")

    # Read config file
    if [[ ! -f "$resolved_path" ]]; then
        echo "{}"  # Return empty if file doesn't exist
        return 0
    fi

    local config_content
    config_content=$(cat "$resolved_path")

    # Check for extends field
    extends_value=$(echo "$config_content" | jq -r '.extends // empty')

    if [[ -z "$extends_value" ]]; then
        # No extends - return config as-is
        echo "$config_content"
        return 0
    fi

    # Process extends (can be string or array)
    merged_config="{}"

    if echo "$extends_value" | jq -e 'type == "array"' >/dev/null 2>&1; then
        # Array of configs - process left to right
        local ext_path
        while IFS= read -r ext_path; do
            extended_config=$(load_extended_config "$ext_path") || return $?
            merged_config=$(_deep_merge_json "$merged_config" "$extended_config")
        done < <(echo "$extends_value" | jq -r '.[]')
    else
        # Single config string
        extended_config=$(load_extended_config "$extends_value") || return $?
        merged_config="$extended_config"
    fi

    # Merge current config on top (remove extends field from output)
    local current_without_extends
    current_without_extends=$(echo "$config_content" | jq 'del(.extends)')
    merged_config=$(_deep_merge_json "$merged_config" "$current_without_extends")

    echo "$merged_config"
}

# Check if config uses extends
# Returns: "true" or "false"
# Usage: if [[ "$(has_extended_config)" == "true" ]]; then ...
has_extended_config() {
    local extends_value
    extends_value=$(get_config_value "extends" "")
    if [[ -n "$extends_value" ]]; then
        echo "true"
    else
        echo "false"
    fi
}

# Reset loaded configs tracking (for testing)
_reset_loaded_configs() {
    _LOADED_CONFIGS=()
}

export -f load_extended_config
export -f has_extended_config

# ============================================================================
# DEPRECATED CONFIG PATH MAPPINGS
# ============================================================================

# Map of deprecated config paths to their new equivalents
# Used for backward compatibility when reading old configs
declare -A DEPRECATED_CONFIG_PATHS=(
    ["research.outputDir"]="agentOutputs.directory"
    ["research.manifestFile"]="agentOutputs.manifestFile"
    ["research.archiveDir"]="agentOutputs.archiveDir"
    ["research.archiveDays"]="agentOutputs.archiveDays"
    ["research.manifest.maxEntries"]="agentOutputs.manifest.maxEntries"
    ["research.manifest.thresholdBytes"]="agentOutputs.manifest.thresholdBytes"
    ["research.manifest.archivePercent"]="agentOutputs.manifest.archivePercent"
    ["research.manifest.autoRotate"]="agentOutputs.manifest.autoRotate"
)

# Get config value with deprecated path fallback
# Checks new path first, then falls back to deprecated path if exists
# Args: $1 = config path (new), $2 = default value (optional)
# Returns: resolved value
get_config_value_with_fallback() {
    local config_path="$1"
    local default_value="${2:-}"

    # Try new path first
    local value
    value=$(get_config_value "$config_path" "")

    if [[ -n "$value" ]]; then
        echo "$value"
        return 0
    fi

    # Check if there's a deprecated path that maps to this new path
    local deprecated_path=""
    for dep_path in "${!DEPRECATED_CONFIG_PATHS[@]}"; do
        if [[ "${DEPRECATED_CONFIG_PATHS[$dep_path]}" == "$config_path" ]]; then
            deprecated_path="$dep_path"
            break
        fi
    done

    # Try deprecated path
    if [[ -n "$deprecated_path" ]]; then
        value=$(get_config_value "$deprecated_path" "")
        if [[ -n "$value" ]]; then
            echo "$value"
            return 0
        fi
    fi

    # Return default
    echo "$default_value"
}

export -f get_config_value_with_fallback

# ============================================================================
# AGENT OUTPUTS CONFIGURATION GETTERS
# ============================================================================

# Get agent outputs directory
# Returns: string (default: claudedocs/agent-outputs)
# Supports backward compatibility with research.outputDir
# Usage: dir=$(get_agent_outputs_directory)
get_agent_outputs_directory() {
    get_config_value_with_fallback "agentOutputs.directory" "claudedocs/agent-outputs"
}

# Get agent outputs manifest filename
# Returns: string (default: MANIFEST.jsonl)
# Supports backward compatibility with research.manifestFile
# Usage: file=$(get_agent_outputs_manifest_file)
get_agent_outputs_manifest_file() {
    get_config_value_with_fallback "agentOutputs.manifestFile" "MANIFEST.jsonl"
}

# Get agent outputs archive directory (relative to agent outputs directory)
# Returns: string (default: archive)
# Supports backward compatibility with research.archiveDir
# Usage: dir=$(get_agent_outputs_archive_dir)
get_agent_outputs_archive_dir() {
    get_config_value_with_fallback "agentOutputs.archiveDir" "archive"
}

# Get days until agent outputs are archived
# Returns: integer (default: 30)
# Supports backward compatibility with research.archiveDays
# Usage: days=$(get_agent_outputs_archive_days)
get_agent_outputs_archive_days() {
    get_config_value_with_fallback "agentOutputs.archiveDays" "30"
}

# Get entire agentOutputs config section as JSON
# Returns: JSON object with all agentOutputs settings
# Usage: config_json=$(get_agent_outputs_config)
get_agent_outputs_config() {
    get_config_section "agentOutputs" "effective"
}

export -f get_agent_outputs_directory
export -f get_agent_outputs_manifest_file
export -f get_agent_outputs_archive_dir
export -f get_agent_outputs_archive_days
export -f get_agent_outputs_config

# ============================================================================
# STALE DETECTION CONFIGURATION GETTERS
# ============================================================================

# Check if stale detection is enabled
# Returns: "true" or "false" (default: true)
# Usage: if [[ "$(get_stale_detection_enabled)" == "true" ]]; then ...
get_stale_detection_enabled() {
    get_config_value "analyze.staleDetection.enabled" "true"
}

# Get days before pending task is considered stale
# Returns: integer (default: 30)
# Usage: days=$(get_stale_pending_days)
get_stale_pending_days() {
    get_config_value "analyze.staleDetection.pendingDays" "30"
}

# Get days without updates before task is considered stale
# Returns: integer (default: 14)
# Usage: days=$(get_stale_no_update_days)
get_stale_no_update_days() {
    get_config_value "analyze.staleDetection.noUpdateDays" "14"
}

# Get days blocked before stale warning
# Returns: integer (default: 7)
# Usage: days=$(get_stale_blocked_days)
get_stale_blocked_days() {
    get_config_value "analyze.staleDetection.blockedDays" "7"
}

# Get days high/critical priority task untouched before warning
# Returns: integer (default: 7)
# Usage: days=$(get_stale_urgent_neglected_days)
get_stale_urgent_neglected_days() {
    get_config_value "analyze.staleDetection.urgentNeglectedDays" "7"
}

# Get entire staleDetection config section as JSON
# Returns: JSON object with all staleDetection settings
# Usage: config_json=$(get_stale_detection_config)
get_stale_detection_config() {
    get_config_section "analyze.staleDetection" "effective"
}

export -f get_stale_detection_enabled
export -f get_stale_pending_days
export -f get_stale_no_update_days
export -f get_stale_blocked_days
export -f get_stale_urgent_neglected_days
export -f get_stale_detection_config

# ============================================================================
# TESTING CONFIGURATION GETTERS
# ============================================================================

# Get test execution command from validation.testing.command
# Falls back to testing.framework.runCommand if validation.testing.command is not set
# Returns: string (default: ./tests/run-all-tests.sh)
# Usage: cmd=$(get_test_command)
get_test_command() {
    local cmd
    cmd=$(get_config_value "validation.testing.command" "")
    if [[ -z "$cmd" ]]; then
        cmd=$(get_config_value "testing.framework.runCommand" "./tests/run-all-tests.sh")
    fi
    echo "$cmd"
}

# Check if test validation is enabled
# Returns: "true" or "false" (default: true)
# Usage: if [[ "$(get_test_validation_enabled)" == "true" ]]; then ...
get_test_validation_enabled() {
    get_config_value "validation.testing.enabled" "true"
}

# Check if tests must pass for operations to proceed
# Returns: "true" or "false" (default: false)
# Usage: if [[ "$(get_require_passing_tests)" == "true" ]]; then ...
get_require_passing_tests() {
    get_config_value "validation.testing.requirePassingTests" "false"
}

# Check if tests should run on task completion
# Returns: "true" or "false" (default: false)
# Usage: if [[ "$(get_run_tests_on_complete)" == "true" ]]; then ...
get_run_tests_on_complete() {
    get_config_value "validation.testing.runOnComplete" "false"
}

# Get test directory path
# Returns: string (default: tests)
# Usage: dir=$(get_test_directory)
get_test_directory() {
    local dir
    dir=$(get_config_value "validation.testing.directory" "")
    if [[ -z "$dir" ]]; then
        dir=$(get_config_value "testing.directories.unit" "tests")
        # Strip trailing slash if present
        dir="${dir%/}"
        # Return parent directory (tests/unit -> tests)
        dir="${dir%/*}"
        [[ -z "$dir" ]] && dir="tests"
    fi
    echo "$dir"
}

# Get testing framework identifier
# Returns: string from enum [bats, jest, vitest, playwright, cypress, mocha, ava, uvu, tap, node:test, deno, bun, pytest, go, cargo, custom]
# Default: bats (preserves CLEO project behavior)
# Usage: framework=$(get_test_framework)
get_test_framework() {
    local framework
    framework=$(get_config_value "validation.testing.framework" "")
    if [[ -z "$framework" ]]; then
        framework=$(get_config_value "testing.framework.name" "bats")
    fi
    echo "$framework"
}

# Get test file extension for current framework
# Returns: string (default: .bats)
# Usage: ext=$(get_test_file_extension)
get_test_file_extension() {
    get_config_value "testing.framework.fileExtension" ".bats"
}

# Get test file patterns (glob patterns)
# Returns: JSON array as string (default: ["**/*.bats"])
# Usage: patterns=$(get_test_file_patterns)
get_test_file_patterns() {
    get_config_value "validation.testing.testFilePatterns" '["**/*.bats"]'
}

# Get entire validation.testing config section as JSON
# Returns: JSON object with all validation.testing settings
# Usage: config_json=$(get_test_validation_config)
get_test_validation_config() {
    get_config_section "validation.testing" "effective"
}

export -f get_test_command
export -f get_test_validation_enabled
export -f get_require_passing_tests
export -f get_run_tests_on_complete
export -f get_test_directory
export -f get_test_framework
export -f get_test_file_extension
export -f get_test_file_patterns
export -f get_test_validation_config

# ============================================================================
# TOOLS CONFIGURATION GETTERS
# ============================================================================

# Get tool command by tool type
# Arguments:
#   $1 - Tool type: jsonProcessor|schemaValidator|testRunner|linter.bash
# Returns: string (command name)
# Usage: cmd=$(get_tool_command "jsonProcessor")  # Returns: jq
get_tool_command() {
    local tool_type="${1:-}"

    case "$tool_type" in
        jsonProcessor)
            get_config_value "tools.jsonProcessor.command" "jq"
            ;;
        schemaValidator)
            get_config_value "tools.schemaValidator.command" "ajv"
            ;;
        testRunner)
            get_config_value "tools.testRunner.command" "bats"
            ;;
        linter.bash|bash-linter)
            get_config_value "tools.linter.bash.command" "shellcheck"
            ;;
        *)
            echo ""
            return 1
            ;;
    esac
}

# Get tool install command by tool type
# Arguments:
#   $1 - Tool type: jsonProcessor|schemaValidator|testRunner|linter.bash
# Returns: string (install command)
# Usage: install=$(get_tool_install_command "jsonProcessor")  # Returns: brew install jq
get_tool_install_command() {
    local tool_type="${1:-}"

    case "$tool_type" in
        jsonProcessor)
            get_config_value "tools.jsonProcessor.installCommand" "brew install jq"
            ;;
        schemaValidator)
            get_config_value "tools.schemaValidator.installCommand" "npm install -g ajv-cli"
            ;;
        testRunner)
            get_config_value "tools.testRunner.installCommand" "npm install -g bats"
            ;;
        linter.bash|bash-linter)
            get_config_value "tools.linter.bash.installCommand" "brew install shellcheck"
            ;;
        *)
            echo ""
            return 1
            ;;
    esac
}

# Check if a tool is required
# Arguments:
#   $1 - Tool type: jsonProcessor|schemaValidator|testRunner|linter.bash
# Returns: "true" or "false"
# Usage: if [[ "$(is_tool_required "jsonProcessor")" == "true" ]]; then ...
is_tool_required() {
    local tool_type="${1:-}"

    case "$tool_type" in
        jsonProcessor)
            get_config_value "tools.jsonProcessor.required" "true"
            ;;
        schemaValidator)
            get_config_value "tools.schemaValidator.required" "false"
            ;;
        testRunner)
            get_config_value "tools.testRunner.required" "true"
            ;;
        linter.bash|bash-linter)
            get_config_value "tools.linter.bash.required" "false"
            ;;
        *)
            echo "false"
            return 1
            ;;
    esac
}

# Get entire tools config section as JSON
# Returns: JSON object with all tool settings
# Usage: config_json=$(get_tools_config)
get_tools_config() {
    get_config_section "tools" "effective"
}

export -f get_tool_command
export -f get_tool_install_command
export -f is_tool_required
export -f get_tools_config

# ============================================================================
# DIRECTORIES CONFIGURATION GETTERS
# ============================================================================

# Get directory path by type from directories config section
# Arguments:
#   $1 - Directory type: data|schemas|templates|agentOutputs|metrics|documentation|skills|sync|backups|research|researchArchive
#   $2 - Optional default value
# Returns: string (relative path from project root)
# Usage: dir=$(get_directory "schemas")
# Usage: dir=$(get_directory "metrics" "claudedocs/metrics")
get_directory() {
    local dir_type="${1:-}"
    local default="${2:-}"

    case "$dir_type" in
        data)
            get_config_value "directories.data" "${default:-.cleo}"
            ;;
        schemas)
            get_config_value "directories.schemas" "${default:-schemas}"
            ;;
        templates)
            get_config_value "directories.templates" "${default:-templates}"
            ;;
        agentOutputs)
            get_config_value "directories.agentOutputs" "${default:-claudedocs/agent-outputs}"
            ;;
        metrics)
            get_config_value "directories.metrics" "${default:-claudedocs/metrics}"
            ;;
        documentation|docs)
            get_config_value "directories.documentation" "${default:-docs}"
            ;;
        skills)
            get_config_value "directories.skills" "${default:-skills}"
            ;;
        sync)
            get_config_value "directories.sync" "${default:-sync}"
            ;;
        backups)
            get_config_value "directories.backups.root" "${default:-backups}"
            ;;
        research)
            get_config_value "directories.research.output" "${default:-research}"
            ;;
        researchArchive)
            get_config_value "directories.research.archive" "${default:-research/archive}"
            ;;
        *)
            # Unknown type - return default or empty
            echo "${default:-}"
            return 1
            ;;
    esac
}

# Get backup directory types array
# Returns: JSON array of backup types
# Usage: types=$(get_backup_types)
get_backup_types() {
    get_config_value "directories.backups.types" '["snapshot","safety","incremental","archive","migration"]'
}

# Get entire directories config section as JSON
# Returns: JSON object with all directory settings
# Usage: config_json=$(get_directories_config)
get_directories_config() {
    get_config_section "directories" "effective"
}

export -f get_directory
export -f get_backup_types
export -f get_directories_config

# ============================================================================
# RELEASE GATES CONFIGURATION GETTERS
# ============================================================================

# @task T2844
# Get release gates array from config (new location)
# Returns: JSON array of release gate objects (default: [])
# Usage: gates=$(get_release_gates_new)
get_release_gates_new() {
    local config_file="${CONFIG_FILE:-.cleo/config.json}"
    if [[ -f "$config_file" ]]; then
        # Try new location first, fall back to old locations with warning
        local gates
        gates=$(jq -c '.release.gates // empty' "$config_file" 2>/dev/null)

        if [[ -n "$gates" && "$gates" != "null" ]]; then
            echo "$gates"
            return 0
        fi

        # Check old locations and warn
        local old_gates
        old_gates=$(jq -c '.validation.releaseGates // .orchestrator.validation.customGates // []' "$config_file" 2>/dev/null)

        if [[ -n "$old_gates" && "$old_gates" != "[]" && "$old_gates" != "null" ]]; then
            echo "DEPRECATION: Using validation.releaseGates or orchestrator.validation.customGates. Please migrate to release.gates" >&2
            echo "$old_gates"
            return 0
        fi

        echo "[]"
    else
        echo "[]"
    fi
}

# @task T2823 T2844
# Get release gates array from config (legacy wrapper)
# DEPRECATED: Use get_release_gates_new() instead
# Returns: JSON array of release gate objects (default: [])
# Usage: gates=$(get_release_gates)
get_release_gates() {
    get_release_gates_new
}

# @task T2848
# Get enabled changelog platforms from config
# Returns: Space-separated list of platform names (empty if no config)
# Usage: while IFS= read -r platform; do ...; done < <(get_changelog_platforms)
get_changelog_platforms() {
    local platforms
    platforms=$(jq -r '.release.changelog.outputs[]? | select(.enabled == true) | .platform' "$PROJECT_CONFIG_FILE" 2>/dev/null || true)
    echo "$platforms"
}

# @task T2848
# Get changelog output path for a specific platform
# Args: $1 - Platform name (mintlify, docusaurus, github, plain, custom)
# Returns: Output file path (relative to project root)
# Usage: path=$(get_changelog_output_path "mintlify")
get_changelog_output_path() {
    local platform="${1:?Platform name required}"
    local config_path
    config_path=$(jq -r ".release.changelog.outputs[]? | select(.platform == \"$platform\" and .enabled == true) | .path // empty" "$PROJECT_CONFIG_FILE" 2>/dev/null)

    if [[ -z "$config_path" ]]; then
        # Default paths by platform
        case "$platform" in
            mintlify) echo "docs/changelog/overview.mdx" ;;
            docusaurus) echo "docs/changelog.md" ;;
            github) echo "CHANGELOG.md" ;;
            plain) echo "CHANGELOG.md" ;;
            *) echo "" ;;
        esac
    else
        echo "$config_path"
    fi
}

export -f get_release_gates_new
export -f get_release_gates
export -f get_changelog_platforms
export -f get_changelog_output_path
