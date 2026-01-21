#!/usr/bin/env bash
# lib/agent-config.sh - Agent configuration registry management (Layer 1)
# Tracks agent config file versions and setup state

[[ -n "${_AGENT_CONFIG_LOADED:-}" ]] && return 0
readonly _AGENT_CONFIG_LOADED=1

# Dependencies (Layer 0)
source "${CLEO_LIB_DIR:-$CLEO_HOME/lib}/injection-registry.sh"

# ==============================================================================
# AGENT CONFIG REGISTRY MANAGEMENT
# ==============================================================================

# Registry file location
readonly AGENT_CONFIG_REGISTRY="${CLEO_HOME:-$HOME/.cleo}/agent-configs.json"

# Get agent directory path (evaluates HOME at runtime)
# Args: agent_name
# Returns: directory path
get_agent_dir() {
    local agent_name="$1"
    case "$agent_name" in
        claude) echo "$HOME/.claude" ;;
        gemini) echo "$HOME/.gemini" ;;
        codex) echo "$HOME/.codex" ;;
        kimi) echo "$HOME/.kimi" ;;
    esac
}

# Get agent config filename
# Args: agent_name
# Returns: config filename
get_agent_config_file() {
    local agent_name="$1"
    case "$agent_name" in
        claude) echo "CLAUDE.md" ;;
        gemini) echo "GEMINI.md" ;;
        codex|kimi) echo "AGENTS.md" ;;
    esac
}

# ==============================================================================
# REGISTRY OPERATIONS
# ==============================================================================

# Update agent config registry with version information
# Args: file_path version
# Returns: 0 on success, 1 on error
update_agent_config_registry() {
    local file_path="$1"
    local version="$2"
    local agent_name agent_dir config_file

    # Determine agent type from file path
    agent_name=$(get_agent_name_from_path "$file_path")
    if [[ -z "$agent_name" ]]; then
        return 1
    fi

    agent_dir=$(get_agent_dir "$agent_name")
    config_file=$(get_agent_config_file "$agent_name")

    # Create registry if missing
    if [[ ! -f "$AGENT_CONFIG_REGISTRY" ]]; then
        create_empty_agent_registry
    fi

    # Update registry entry
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq --arg path "$file_path" \
       --arg version "$version" \
       --arg timestamp "$timestamp" \
       --arg agent_type "$agent_name" \
       '.configs[$path] = {
           version: $version,
           method: "@",
           setupDate: $timestamp,
           lastChecked: null,
           status: "current",
           cliVersion: null,
           agentType: $agent_type,
           notes: null
       } | .lastUpdated = $timestamp' \
       "$AGENT_CONFIG_REGISTRY" > "${AGENT_CONFIG_REGISTRY}.tmp" || return 1

    mv "${AGENT_CONFIG_REGISTRY}.tmp" "$AGENT_CONFIG_REGISTRY" || return 1
    return 0
}

# Get agent config version from file (legacy support)
# Args: file_path
# Returns: version string or empty (empty for new versionless markers)
# Note: New markers don't include version - returns empty which is expected
get_agent_config_version() {
    local file_path="$1"

    [[ ! -f "$file_path" ]] && return 1

    # Extract version from legacy CLEO injection marker (if present)
    grep -oP 'CLEO:START v([0-9]+\.[0-9]+\.[0-9]+)' "$file_path" 2>/dev/null | \
        head -1 | \
        grep -oP '[0-9]+\.[0-9]+\.[0-9]+' || true
}

# Validate agent config registry
# Returns: 0 if valid, 1 if invalid
validate_agent_config_registry() {
    [[ ! -f "$AGENT_CONFIG_REGISTRY" ]] && return 0

    # Basic JSON validity check
    if ! jq empty "$AGENT_CONFIG_REGISTRY" 2>/dev/null; then
        return 1
    fi

    # Check required top-level fields
    local has_configs has_last_updated
    has_configs=$(jq 'has("configs")' "$AGENT_CONFIG_REGISTRY" 2>/dev/null)
    has_last_updated=$(jq 'has("lastUpdated")' "$AGENT_CONFIG_REGISTRY" 2>/dev/null)

    if [[ "$has_configs" != "true" ]] || [[ "$has_last_updated" != "true" ]]; then
        return 1
    fi

    return 0
}

# Check if agent config is registered
# Args: agent_name (claude|gemini|codex|kimi) OR file_path
# Returns: 0 if registered, 1 if not
is_agent_registered() {
    local input="$1"
    local file_path

    [[ ! -f "$AGENT_CONFIG_REGISTRY" ]] && return 1

    # If input looks like a path, use it directly
    if [[ "$input" == /* ]]; then
        file_path="$input"
    else
        # Treat as agent name, get the config path
        file_path=$(get_agent_config_path "$input")
    fi

    [[ -z "$file_path" ]] && return 1

    jq -e ".configs[\"$file_path\"]" "$AGENT_CONFIG_REGISTRY" >/dev/null 2>&1
}

# Get agent config data from registry
# Args: agent_name OR file_path
# Returns: JSON object or empty
get_agent_config_data() {
    local input="$1"
    local file_path

    [[ ! -f "$AGENT_CONFIG_REGISTRY" ]] && echo "{}" && return

    # If input looks like a path, use it directly
    if [[ "$input" == /* ]]; then
        file_path="$input"
    else
        # Treat as agent name, get the config path
        file_path=$(get_agent_config_path "$input")
    fi

    [[ -z "$file_path" ]] && echo "{}" && return

    jq -r ".configs[\"$file_path\"] // {}" "$AGENT_CONFIG_REGISTRY"
}

# List all registered agent configs
# Returns: JSON array of agent config objects with file paths
list_agent_configs() {
    [[ ! -f "$AGENT_CONFIG_REGISTRY" ]] && echo "[]" && return

    jq -r '.configs | to_entries | map({path: .key} + .value)' "$AGENT_CONFIG_REGISTRY"
}

# Get agent name from file path
# Args: file_path
# Returns: agent name (claude|gemini|codex|kimi) or empty
get_agent_name_from_path() {
    local file_path="$1"
    local basename_file agent_name

    basename_file=$(basename "$file_path")

    # Map filename to agent
    case "$basename_file" in
        CLAUDE.md)
            # Verify it's in ~/.claude/
            if [[ "$file_path" == *"/.claude/"* ]]; then
                echo "claude"
            fi
            ;;
        GEMINI.md)
            if [[ "$file_path" == *"/.gemini/"* ]]; then
                echo "gemini"
            fi
            ;;
        AGENTS.md)
            # Could be codex or kimi, check parent directory
            if [[ "$file_path" == *"/.codex/"* ]]; then
                echo "codex"
            elif [[ "$file_path" == *"/.kimi/"* ]]; then
                echo "kimi"
            fi
            ;;
    esac
}

# Check if agent CLI is installed (directory exists)
# Args: agent_name
# Returns: 0 if installed, 1 if not
is_agent_cli_installed() {
    local agent_name="$1"
    local agent_dir
    agent_dir=$(get_agent_dir "$agent_name")

    [[ -n "$agent_dir" ]] && [[ -d "$agent_dir" ]]
}

# Get agent config file path
# Args: agent_name
# Returns: full path to config file
get_agent_config_path() {
    local agent_name="$1"
    local agent_dir config_file
    agent_dir=$(get_agent_dir "$agent_name")
    config_file=$(get_agent_config_file "$agent_name")

    if [[ -n "$agent_dir" ]] && [[ -n "$config_file" ]]; then
        echo "${agent_dir}/${config_file}"
    fi
}

# ==============================================================================
# REGISTRY INITIALIZATION
# ==============================================================================

# Create empty agent config registry
create_empty_agent_registry() {
    local registry="$AGENT_CONFIG_REGISTRY"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    mkdir -p "$(dirname "$registry")"

    cat > "$registry" <<EOF
{
  "schemaVersion": "1.0.0",
  "lastUpdated": "$timestamp",
  "configs": {}
}
EOF
}

# Initialize registry if missing
init_agent_config_registry() {
    if [[ ! -f "$AGENT_CONFIG_REGISTRY" ]]; then
        create_empty_agent_registry
    fi
}
