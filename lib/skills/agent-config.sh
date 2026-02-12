#!/usr/bin/env bash
# lib/skills/agent-config.sh - Agent configuration registry management (Layer 1)
# Tracks agent config file versions and setup state
# v2.0.0 - Dynamic registry loading from schemas/agent-registry.json

[[ -n "${_AGENT_CONFIG_LOADED:-}" ]] && return 0
readonly _AGENT_CONFIG_LOADED=1

# Dependencies (Layer 0)
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$_LIB_DIR/ui/injection-registry.sh" ]]; then
    source "$_LIB_DIR/ui/injection-registry.sh"
fi

# ==============================================================================
# AGENT CONFIG REGISTRY MANAGEMENT
# ==============================================================================

# Registry file locations
readonly AGENT_CONFIG_REGISTRY="${CLEO_HOME:-$HOME/.cleo}/agent-configs.json"
readonly AGENT_REGISTRY_SCHEMA="${CLEO_HOME:-$HOME/.cleo}/schemas/agent-registry.json"

# Global variable for cached registry data
_AGENT_REGISTRY=""

# Load agent registry JSON
# Returns: 0 on success, 1 on error
# Sets: _AGENT_REGISTRY (global variable)
load_agent_registry() {
    [[ -n "$_AGENT_REGISTRY" ]] && return 0  # Already loaded

    local registry_path="$AGENT_REGISTRY_SCHEMA"

    # Check project location for dev mode
    if [[ ! -f "$registry_path" ]]; then
        registry_path="$(dirname "$_LIB_DIR")/schemas/agent-registry.json"
    fi

    if [[ ! -f "$registry_path" ]]; then
        return 1
    fi

    _AGENT_REGISTRY=$(cat "$registry_path" 2>/dev/null) || return 1
    return 0
}

# Normalize agent ID (handle legacy names)
# Args: agent_id
# Returns: normalized ID
normalize_agent_id() {
    local agent_id="$1"
    case "$agent_id" in
        claude) echo "claude-code" ;;
        copilot) echo "github-copilot" ;;
        *) echo "$agent_id" ;;
    esac
}

# Get agent directory path (evaluates HOME at runtime)
# Args: agent_id
# Returns: directory path
get_agent_dir() {
    local agent_id="$1"
    [[ -z "$_AGENT_REGISTRY" ]] && load_agent_registry

    agent_id=$(normalize_agent_id "$agent_id")

    local dir
    dir=$(echo "$_AGENT_REGISTRY" | jq -r --arg id "$agent_id" '.agents[$id].globalDir // empty' 2>/dev/null)

    # Expand $HOME
    echo "${dir//\$HOME/$HOME}"
}

# Get agent config filename
# Args: agent_id
# Returns: config filename
get_agent_config_file() {
    local agent_id="$1"
    [[ -z "$_AGENT_REGISTRY" ]] && load_agent_registry

    agent_id=$(normalize_agent_id "$agent_id")

    echo "$_AGENT_REGISTRY" | jq -r --arg id "$agent_id" '.agents[$id].instructionFile // empty' 2>/dev/null
}

# Get all agent IDs
# Returns: newline-separated agent IDs
get_all_agents() {
    [[ -z "$_AGENT_REGISTRY" ]] && load_agent_registry
    echo "$_AGENT_REGISTRY" | jq -r '.agents | keys[]' 2>/dev/null
}

# Get agents by priority tier
# Args: tier (tier1|tier2|tier3)
# Returns: newline-separated agent IDs
get_agents_by_tier() {
    local tier="$1"
    [[ -z "$_AGENT_REGISTRY" ]] && load_agent_registry
    echo "$_AGENT_REGISTRY" | jq -r --arg t "$tier" '.priorityTiers[$t][]' 2>/dev/null
}

# Get agent project skills directory (global)
# Args: agent_id
# Returns: skills directory path
get_agent_skills_dir() {
    local agent_id="$1"
    [[ -z "$_AGENT_REGISTRY" ]] && load_agent_registry

    agent_id=$(normalize_agent_id "$agent_id")

    local dir
    dir=$(echo "$_AGENT_REGISTRY" | jq -r --arg id "$agent_id" '.agents[$id].skillsDir // empty' 2>/dev/null)
    echo "$dir"
}

# Get agent project-level skills directory
# Args: agent_id
# Returns: project skills directory path
get_agent_project_skills_dir() {
    local agent_id="$1"
    [[ -z "$_AGENT_REGISTRY" ]] && load_agent_registry

    agent_id=$(normalize_agent_id "$agent_id")

    local dir
    dir=$(echo "$_AGENT_REGISTRY" | jq -r --arg id "$agent_id" '.agents[$id].projectSkillsDir // empty' 2>/dev/null)
    echo "$dir"
}

# Get agent global skills directory (evaluates HOME at runtime)
# Args: agent_id
# Returns: global skills directory path
get_agent_global_skills_dir() {
    local agent_id="$1"
    [[ -z "$_AGENT_REGISTRY" ]] && load_agent_registry

    agent_id=$(normalize_agent_id "$agent_id")

    local agent_dir skills_dir
    agent_dir=$(get_agent_dir "$agent_id")
    skills_dir=$(get_agent_skills_dir "$agent_id")

    if [[ -n "$agent_dir" ]] && [[ -n "$skills_dir" ]]; then
        echo "${agent_dir}/${skills_dir}"
    fi
}

# Get skill install path (where skill would be installed)
# Args: skill_name agent_id [--global]
# Returns: full path to skill directory
get_skill_install_path() {
    local skill_name="$1"
    local agent_id="$2"
    local global_flag="${3:-}"

    agent_id=$(normalize_agent_id "$agent_id")

    if [[ "$global_flag" == "--global" ]]; then
        local global_dir
        global_dir=$(get_agent_global_skills_dir "$agent_id")
        [[ -n "$global_dir" ]] && echo "${global_dir}/${skill_name}"
    else
        local project_dir
        project_dir=$(get_agent_project_skills_dir "$agent_id")
        [[ -n "$project_dir" ]] && echo "${project_dir}/${skill_name}"
    fi
}

# Install skill to agent directory
# Args: skill_path agent_id [--global]
# Returns: 0 on success, 1 on error
install_skill_to_agent() {
    local skill_path="$1"
    local agent_id="$2"
    local global_flag="${3:-}"

    [[ ! -d "$skill_path" ]] && return 1

    local skill_name
    skill_name=$(basename "$skill_path")

    local target_path
    target_path=$(get_skill_install_path "$skill_name" "$agent_id" "$global_flag")

    [[ -z "$target_path" ]] && return 1

    # Create parent directory if needed
    mkdir -p "$(dirname "$target_path")" || return 1

    # Copy skill directory
    if [[ -d "$target_path" ]]; then
        # Remove existing and replace
        rm -rf "$target_path" || return 1
    fi

    cp -r "$skill_path" "$target_path" || return 1
    return 0
}

# List installed skills for agent
# Args: agent_id [--global]
# Returns: newline-separated skill names
list_agent_skills() {
    local agent_id="$1"
    local global_flag="${2:-}"

    agent_id=$(normalize_agent_id "$agent_id")

    local skills_dir
    if [[ "$global_flag" == "--global" ]]; then
        skills_dir=$(get_agent_global_skills_dir "$agent_id")
    else
        skills_dir=$(get_agent_project_skills_dir "$agent_id")
    fi

    [[ -z "$skills_dir" ]] && return 0
    [[ ! -d "$skills_dir" ]] && return 0

    # List directories (skills)
    find "$skills_dir" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null | sort
}

# Check if skill is installed for agent
# Args: skill_name agent_id [--global]
# Returns: 0 if installed, 1 if not
is_skill_installed() {
    local skill_name="$1"
    local agent_id="$2"
    local global_flag="${3:-}"

    local skill_path
    skill_path=$(get_skill_install_path "$skill_name" "$agent_id" "$global_flag")

    [[ -n "$skill_path" ]] && [[ -d "$skill_path" ]]
}

# Uninstall skill from agent
# Args: skill_name agent_id [--global]
# Returns: 0 on success, 1 on error
uninstall_skill_from_agent() {
    local skill_name="$1"
    local agent_id="$2"
    local global_flag="${3:-}"

    local skill_path
    skill_path=$(get_skill_install_path "$skill_name" "$agent_id" "$global_flag")

    [[ -z "$skill_path" ]] && return 1
    [[ ! -d "$skill_path" ]] && return 1

    rm -rf "$skill_path"
}

# Get full agent config as JSON
# Args: agent_id
# Returns: JSON object
get_agent_config_json() {
    local agent_id="$1"
    [[ -z "$_AGENT_REGISTRY" ]] && load_agent_registry

    agent_id=$(normalize_agent_id "$agent_id")

    echo "$_AGENT_REGISTRY" | jq --arg id "$agent_id" '.agents[$id]' 2>/dev/null
}

# Get agent display name
# Args: agent_id
# Returns: display name
get_agent_display_name() {
    local agent_id="$1"
    [[ -z "$_AGENT_REGISTRY" ]] && load_agent_registry

    agent_id=$(normalize_agent_id "$agent_id")

    echo "$_AGENT_REGISTRY" | jq -r --arg id "$agent_id" '.agents[$id].displayName // empty' 2>/dev/null
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
# Returns: agent ID or empty
get_agent_name_from_path() {
    local file_path="$1"
    [[ -z "$_AGENT_REGISTRY" ]] && load_agent_registry

    local basename_file
    basename_file=$(basename "$file_path")

    # Get instruction file mapping from registry
    local agent_ids
    agent_ids=$(echo "$_AGENT_REGISTRY" | jq -r --arg file "$basename_file" '.instructionFileMap[$file][]?' 2>/dev/null)

    [[ -z "$agent_ids" ]] && return

    # For each potential agent, check if the path matches
    while IFS= read -r agent_id; do
        local agent_dir
        agent_dir=$(get_agent_dir "$agent_id")
        if [[ -n "$agent_dir" ]] && [[ "$file_path" == "$agent_dir"* ]]; then
            echo "$agent_id"
            return
        fi
    done <<< "$agent_ids"
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
