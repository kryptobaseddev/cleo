#!/usr/bin/env bash
# lib/skills/agent-registry.sh - Unified Agent Registry (Layer 1)
# Single source of truth for all LLM coding agent configurations
#
# LAYER: 1 (Core)
# DEPENDENCIES: exit-codes.sh
# PROVIDES: ar_*, agent registry functions

[[ -n "${_AGENT_REGISTRY_LOADED:-}" ]] && return 0
readonly _AGENT_REGISTRY_LOADED=1

# ==============================================================================
# CONFIGURATION
# ==============================================================================

# Registry file location
readonly AR_REGISTRY_FILE="${CLEO_HOME:-$HOME/.cleo}/templates/agent-registry.json"
readonly AR_REGISTRY_FALLBACK="${CLEO_LIB_DIR:-$CLEO_HOME/lib}/../templates/agent-registry.json"

# Cache for loaded registry (avoid repeated file reads)
_AR_REGISTRY_CACHE=""

# ==============================================================================
# REGISTRY LOADING
# ==============================================================================

# Load registry into cache
# Returns: 0 on success, 1 on error
ar_load_registry() {
    local registry_path=""

    # Find registry file
    if [[ -f "$AR_REGISTRY_FILE" ]]; then
        registry_path="$AR_REGISTRY_FILE"
    elif [[ -f "$AR_REGISTRY_FALLBACK" ]]; then
        registry_path="$AR_REGISTRY_FALLBACK"
    else
        echo "Error: Agent registry not found" >&2
        return 1
    fi

    # Load and cache
    _AR_REGISTRY_CACHE=$(cat "$registry_path" 2>/dev/null) || return 1

    # Validate JSON
    if ! echo "$_AR_REGISTRY_CACHE" | jq empty 2>/dev/null; then
        echo "Error: Invalid JSON in agent registry" >&2
        _AR_REGISTRY_CACHE=""
        return 1
    fi

    return 0
}

# Ensure registry is loaded
# Returns: 0 on success, 1 on error
_ar_ensure_loaded() {
    if [[ -z "$_AR_REGISTRY_CACHE" ]]; then
        ar_load_registry || return 1
    fi
    return 0
}

# ==============================================================================
# AGENT QUERIES
# ==============================================================================

# List all agent IDs
# Returns: Space-separated list of agent IDs
ar_list_agents() {
    _ar_ensure_loaded || return 1
    echo "$_AR_REGISTRY_CACHE" | jq -r '.agents | keys[]' | tr '\n' ' '
}

# List agents by priority tier
# Args: tier (tier1|tier2|tier3)
# Returns: Space-separated list of agent IDs
ar_list_by_tier() {
    local tier="$1"
    _ar_ensure_loaded || return 1
    echo "$_AR_REGISTRY_CACHE" | jq -r ".priorityTiers.$tier // [] | .[]" | tr '\n' ' '
}

# List agents by instruction file
# Args: instruction_file (e.g., "CLAUDE.md", "AGENTS.md")
# Returns: Space-separated list of agent IDs
ar_list_by_instruction_file() {
    local file="$1"
    _ar_ensure_loaded || return 1
    echo "$_AR_REGISTRY_CACHE" | jq -r ".instructionFileMap[\"$file\"] // [] | .[]" | tr '\n' ' '
}

# Get agent configuration
# Args: agent_id
# Returns: JSON object
ar_get_agent() {
    local agent_id="$1"
    _ar_ensure_loaded || return 1
    echo "$_AR_REGISTRY_CACHE" | jq -r ".agents[\"$agent_id\"] // {}"
}

# Get specific agent field
# Args: agent_id field
# Returns: Field value
ar_get_field() {
    local agent_id="$1"
    local field="$2"
    _ar_ensure_loaded || return 1
    echo "$_AR_REGISTRY_CACHE" | jq -r ".agents[\"$agent_id\"].$field // empty"
}

# Check if agent exists in registry
# Args: agent_id
# Returns: 0 if exists, 1 if not
ar_agent_exists() {
    local agent_id="$1"
    _ar_ensure_loaded || return 1
    local result
    result=$(echo "$_AR_REGISTRY_CACHE" | jq -e ".agents[\"$agent_id\"]" 2>/dev/null)
    [[ -n "$result" && "$result" != "null" ]]
}

# ==============================================================================
# PATH RESOLUTION
# ==============================================================================

# Get global directory for agent (with $HOME expanded)
# Args: agent_id
# Returns: Expanded path
ar_get_global_dir() {
    local agent_id="$1"
    local path
    path=$(ar_get_field "$agent_id" "globalDir")
    echo "${path//\$HOME/$HOME}"
}

# Get project directory for agent
# Args: agent_id
# Returns: Relative path
ar_get_project_dir() {
    local agent_id="$1"
    ar_get_field "$agent_id" "projectDir"
}

# Get instruction file name
# Args: agent_id
# Returns: Filename (e.g., "CLAUDE.md")
ar_get_instruction_file() {
    local agent_id="$1"
    ar_get_field "$agent_id" "instructionFile"
}

# Get full global instruction file path
# Args: agent_id
# Returns: Full path to instruction file
ar_get_global_instruction_path() {
    local agent_id="$1"
    local global_dir instruction_file
    global_dir=$(ar_get_global_dir "$agent_id")
    instruction_file=$(ar_get_instruction_file "$agent_id")
    echo "${global_dir}/${instruction_file}"
}

# Get full project instruction file path
# Args: agent_id [project_root]
# Returns: Full path to instruction file
ar_get_project_instruction_path() {
    local agent_id="$1"
    local project_root="${2:-.}"
    local instruction_file
    instruction_file=$(ar_get_instruction_file "$agent_id")
    echo "${project_root}/${instruction_file}"
}

# Get global skills directory
# Args: agent_id
# Returns: Full path to skills directory
ar_get_global_skills_dir() {
    local agent_id="$1"
    local global_dir skills_dir
    global_dir=$(ar_get_global_dir "$agent_id")
    skills_dir=$(ar_get_field "$agent_id" "skillsDir")
    echo "${global_dir}/${skills_dir}"
}

# Get project skills directory
# Args: agent_id [project_root]
# Returns: Full path to project skills directory
ar_get_project_skills_dir() {
    local agent_id="$1"
    local project_root="${2:-.}"
    local project_skills_dir
    project_skills_dir=$(ar_get_field "$agent_id" "projectSkillsDir")
    echo "${project_root}/${project_skills_dir}"
}

# ==============================================================================
# DETECTION
# ==============================================================================

# Check if agent CLI is installed
# Args: agent_id
# Returns: 0 if installed, 1 if not
ar_is_installed() {
    local agent_id="$1"
    local method check_path

    method=$(ar_get_field "$agent_id" "cliDetection.method")
    check_path=$(ar_get_field "$agent_id" "cliDetection.check")

    # Expand $HOME
    check_path="${check_path//\$HOME/$HOME}"

    case "$method" in
        directory)
            [[ -d "$check_path" ]]
            ;;
        file)
            [[ -f "$check_path" ]]
            ;;
        command)
            command -v "$check_path" &>/dev/null
            ;;
        *)
            # Fallback: check global directory
            local global_dir
            global_dir=$(ar_get_global_dir "$agent_id")
            [[ -d "$global_dir" ]]
            ;;
    esac
}

# List all installed agents
# Returns: Space-separated list of installed agent IDs
ar_list_installed() {
    local agents agent
    agents=$(ar_list_agents)

    for agent in $agents; do
        if ar_is_installed "$agent"; then
            echo -n "$agent "
        fi
    done
}

# List installed agents by tier
# Args: tier (tier1|tier2|tier3|all)
# Returns: Space-separated list of installed agent IDs
ar_list_installed_by_tier() {
    local tier="$1"
    local agents

    if [[ "$tier" == "all" ]]; then
        agents=$(ar_list_agents)
    else
        agents=$(ar_list_by_tier "$tier")
    fi

    for agent in $agents; do
        if ar_is_installed "$agent"; then
            echo -n "$agent "
        fi
    done
}

# ==============================================================================
# UTILITY FUNCTIONS
# ==============================================================================

# Get agent display name
# Args: agent_id
# Returns: Display name
ar_get_display_name() {
    ar_get_field "$1" "displayName"
}

# Get agent vendor
# Args: agent_id
# Returns: Vendor name
ar_get_vendor() {
    ar_get_field "$1" "vendor"
}

# Get agent priority
# Args: agent_id
# Returns: Priority (high|medium|low)
ar_get_priority() {
    ar_get_field "$1" "priority"
}

# Get agent status
# Args: agent_id
# Returns: Status (active|beta|deprecated|planned)
ar_get_status() {
    ar_get_field "$1" "status"
}

# Check if agent is Agent Skills compatible
# Args: agent_id
# Returns: 0 if compatible, 1 if not
ar_is_agent_skills_compatible() {
    local agent_id="$1"
    local result
    result=$(ar_get_field "$agent_id" "agentSkillsCompatible")
    [[ "$result" == "true" ]]
}

# Get unique instruction files
# Returns: Space-separated list of unique instruction file names
ar_get_instruction_files() {
    _ar_ensure_loaded || return 1
    echo "$_AR_REGISTRY_CACHE" | jq -r '.instructionFileMap | keys[]' | tr '\n' ' '
}

# ==============================================================================
# JSON OUTPUT
# ==============================================================================

# Get full registry as JSON
# Returns: Full registry JSON
ar_get_registry_json() {
    _ar_ensure_loaded || return 1
    echo "$_AR_REGISTRY_CACHE"
}

# Get agent summary as JSON
# Args: agent_id
# Returns: Summary JSON
ar_get_agent_summary() {
    local agent_id="$1"
    _ar_ensure_loaded || return 1
    echo "$_AR_REGISTRY_CACHE" | jq --arg id "$agent_id" '
        .agents[$id] | {
            id: .id,
            displayName: .displayName,
            vendor: .vendor,
            priority: .priority,
            status: .status,
            globalPath: .globalDir,
            instructionFile: .instructionFile,
            skillsPath: (.globalDir + "/" + .skillsDir)
        }
    '
}

# List all agents as JSON array with key info
# Returns: JSON array of agent summaries
ar_list_agents_json() {
    _ar_ensure_loaded || return 1
    echo "$_AR_REGISTRY_CACHE" | jq '
        [.agents | to_entries[] | {
            id: .key,
            displayName: .value.displayName,
            vendor: .value.vendor,
            priority: .value.priority,
            status: .value.status,
            instructionFile: .value.instructionFile
        }] | sort_by(.priority, .displayName)
    '
}

# ==============================================================================
# EXPORTS
# ==============================================================================

export -f ar_load_registry
export -f ar_list_agents
export -f ar_list_by_tier
export -f ar_list_by_instruction_file
export -f ar_get_agent
export -f ar_get_field
export -f ar_agent_exists
export -f ar_get_global_dir
export -f ar_get_project_dir
export -f ar_get_instruction_file
export -f ar_get_global_instruction_path
export -f ar_get_project_instruction_path
export -f ar_get_global_skills_dir
export -f ar_get_project_skills_dir
export -f ar_is_installed
export -f ar_list_installed
export -f ar_list_installed_by_tier
export -f ar_get_display_name
export -f ar_get_vendor
export -f ar_get_priority
export -f ar_get_status
export -f ar_is_agent_skills_compatible
export -f ar_get_instruction_files
export -f ar_get_registry_json
export -f ar_get_agent_summary
export -f ar_list_agents_json
