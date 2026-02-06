#!/usr/bin/env bash
# nexus-registry.sh - Global project registry for CLEO Nexus
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: file-ops.sh, paths.sh, project-registry.sh, exit-codes.sh
# PROVIDES: nexus_init, nexus_register, nexus_unregister, nexus_list,
#           nexus_get_project, nexus_sync, nexus_get_registry_path,
#           nexus_project_exists
#
# PURPOSE:
#   Implements global cross-project registry operations for CLEO Nexus.
#   Extends existing project-registry.sh with global coordination features.
#   Supports cross-project task references with project:task_id syntax.
#
# ARCHITECTURE:
#   - Reuses generate_project_hash() from project-registry.sh
#   - Stores global index at ~/.cleo/nexus/registry.json
#   - Maintains backward compatibility with single-project workflows
#   - Implements permission-aware project registration
#
# USAGE:
#   source lib/nexus-registry.sh
#   nexus_init
#   nexus_register "/path/to/project" "my-project" "read"
#   project_data=$(nexus_get_project "my-project")

#=== SOURCE GUARD ================================================
[[ -n "${_NEXUS_REGISTRY_LOADED:-}" ]] && return 0
declare -r _NEXUS_REGISTRY_LOADED=1

set -euo pipefail

#=== DEPENDENCIES ================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source file-ops library for atomic operations
if [[ -f "$_LIB_DIR/file-ops.sh" ]]; then
    # shellcheck source=lib/file-ops.sh
    source "$_LIB_DIR/file-ops.sh"
else
    echo "ERROR: Cannot find file-ops.sh in $_LIB_DIR" >&2
    exit 1
fi

# Source paths library for CLEO_HOME resolution
if [[ -f "$_LIB_DIR/paths.sh" ]]; then
    # shellcheck source=lib/paths.sh
    source "$_LIB_DIR/paths.sh"
else
    echo "ERROR: Cannot find paths.sh in $_LIB_DIR" >&2
    exit 1
fi

# Source project-registry for generate_project_hash
if [[ -f "$_LIB_DIR/project-registry.sh" ]]; then
    # shellcheck source=lib/project-registry.sh
    source "$_LIB_DIR/project-registry.sh"
else
    echo "ERROR: Cannot find project-registry.sh in $_LIB_DIR" >&2
    exit 1
fi

# Source exit codes for error handling
if [[ -f "$_LIB_DIR/exit-codes.sh" ]]; then
    # shellcheck source=lib/exit-codes.sh
    source "$_LIB_DIR/exit-codes.sh"
else
    echo "ERROR: Cannot find exit-codes.sh in $_LIB_DIR" >&2
    exit 1
fi

#=== TEST OVERRIDES ==============================================

# Allow override for testing (default to ~/.cleo/nexus)
NEXUS_HOME="${NEXUS_HOME:-$(get_cleo_home)/nexus}"
NEXUS_REGISTRY_FILE="${NEXUS_REGISTRY_FILE:-$NEXUS_HOME/registry.json}"
NEXUS_CACHE_DIR="${NEXUS_CACHE_DIR:-$NEXUS_HOME/cache}"

#=== FUNCTIONS ===================================================

#######################################
# Get path to Nexus registry file
#
# Returns the path to the global registry.json file.
# Uses test override if NEXUS_REGISTRY_FILE is set.
#
# Arguments:
#   None
#
# Returns:
#   Registry file path on stdout
#
# Exit Status:
#   0 - Always succeeds
#
# Example:
#   registry=$(nexus_get_registry_path)
#   # Returns: "/home/user/.cleo/nexus/registry.json"
#######################################
nexus_get_registry_path() {
    echo "$NEXUS_REGISTRY_FILE"
}

#######################################
# Initialize Nexus directory structure
#
# Creates the global Nexus directory and registry file if they don't exist.
# Safe to call multiple times (idempotent).
#
# Directory Structure:
#   ~/.cleo/nexus/
#   ├── registry.json       (global project index)
#   └── cache/              (graph and relationship caches)
#
# Arguments:
#   None
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Success
#   1 - Failed to create directories or registry
#
# Example:
#   nexus_init || { echo "Failed to initialize Nexus"; exit 1; }
#######################################
nexus_init() {
    local registry_path
    registry_path=$(nexus_get_registry_path)

    # Create Nexus home directory
    if [[ ! -d "$NEXUS_HOME" ]]; then
        if ! mkdir -p "$NEXUS_HOME"; then
            echo "ERROR: Failed to create Nexus directory: $NEXUS_HOME" >&2
            return 1
        fi
    fi

    # Create cache directory
    if [[ ! -d "$NEXUS_CACHE_DIR" ]]; then
        if ! mkdir -p "$NEXUS_CACHE_DIR"; then
            echo "ERROR: Failed to create Nexus cache directory: $NEXUS_CACHE_DIR" >&2
            return 1
        fi
    fi

    # Create empty registry if it doesn't exist
    if [[ ! -f "$registry_path" ]]; then
        local temp_file
        temp_file=$(mktemp)
        # Use double quotes to expand temp_file immediately (BATS compatibility)
        trap "rm -f '$temp_file'" RETURN

        cat > "$temp_file" <<'EOF'
{
  "_meta": {
    "schemaVersion": "1.0.0",
    "createdAt": "",
    "updatedAt": ""
  },
  "projects": {}
}
EOF

        # Set timestamps
        local now
        now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        local _nr_content
        _nr_content=$(jq --arg now "$now" '._meta.createdAt = $now | ._meta.updatedAt = $now' "$temp_file")
        echo "$_nr_content" > "$temp_file"

        # Save using atomic write
        if ! save_json "$registry_path" < "$temp_file"; then
            echo "ERROR: Failed to save Nexus registry file" >&2
            return 1
        fi
    fi

    return 0
}

#######################################
# Register a project in the global registry
#
# Adds a project to the Nexus global registry with specified name and permissions.
# Validates that project path exists and contains .cleo/todo.json.
# Returns E_DUPLICATE (EXIT_NEXUS_PROJECT_EXISTS) if already registered.
#
# Arguments:
#   $1 - Project path (required, absolute path)
#   $2 - Project name (optional, defaults to directory name)
#   $3 - Permissions (optional, defaults to "read")
#
# Returns:
#   Project hash on stdout if successful
#
# Exit Status:
#   0 - Success
#   1 - Missing required argument or invalid path
#   EXIT_NOT_FOUND (4) - Path missing .cleo/todo.json
#   EXIT_VALIDATION_ERROR (6) - Name conflicts with existing project
#   EXIT_NEXUS_PROJECT_EXISTS (76) - Project already registered
#
# Example:
#   hash=$(nexus_register "/home/user/my-api" "my-api" "read")
#   # Returns: "a3f5b2c8d1e9"
#######################################
nexus_register() {
    local project_path="${1:-}"
    local project_name="${2:-}"
    local permissions="${3:-read}"

    # Validate required arguments
    if [[ -z "$project_path" ]]; then
        echo "ERROR: Project path required" >&2
        return 1
    fi

    # Convert to absolute path
    project_path=$(cd "$project_path" 2>/dev/null && pwd) || {
        echo "ERROR: Invalid project path: $project_path" >&2
        return 1
    }

    # Validate project has .cleo/todo.json
    if [[ ! -f "$project_path/.cleo/todo.json" ]]; then
        echo "ERROR: Path missing .cleo/todo.json: $project_path" >&2
        return "$EXIT_NOT_FOUND"
    fi

    # Default name to directory name
    if [[ -z "$project_name" ]]; then
        project_name=$(basename "$project_path")
    fi

    # Generate project hash
    local project_hash
    project_hash=$(generate_project_hash "$project_path")

    # Initialize registry if needed
    nexus_init || return 1

    local registry_path
    registry_path=$(nexus_get_registry_path)

    # Check if already registered
    if jq -e --arg hash "$project_hash" '.projects[$hash]' "$registry_path" >/dev/null 2>&1; then
        echo "ERROR: Project already registered with hash: $project_hash" >&2
        return "$EXIT_NEXUS_PROJECT_EXISTS"
    fi

    # Check for name conflicts
    if jq -e --arg name "$project_name" '.projects[] | select(.name == $name)' "$registry_path" >/dev/null 2>&1; then
        echo "ERROR: Project name '$project_name' already exists in registry" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Get task count
    local task_count
    task_count=$(jq '.tasks | length' "$project_path/.cleo/todo.json" 2>/dev/null || echo "0")

    # Get labels
    local labels
    labels=$(jq -c '[.tasks[].labels // [] | .[] ] | unique' "$project_path/.cleo/todo.json" 2>/dev/null || echo "[]")

    # Add project to registry
    local temp_file
    temp_file=$(mktemp)
    trap "rm -f '$temp_file'" RETURN

    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq --arg hash "$project_hash" \
       --arg path "$project_path" \
       --arg name "$project_name" \
       --arg permissions "$permissions" \
       --arg now "$now" \
       --argjson taskCount "$task_count" \
       --argjson labels "$labels" \
       '.projects[$hash] = {
           "path": $path,
           "name": $name,
           "permissions": $permissions,
           "lastSync": $now,
           "taskCount": $taskCount,
           "labels": $labels
       } | ._meta.updatedAt = $now' \
       "$registry_path" > "$temp_file"

    # Save using atomic write
    if ! save_json "$registry_path" < "$temp_file"; then
        echo "ERROR: Failed to save registry file" >&2
        return 1
    fi

    # Output hash for caller
    echo "$project_hash"
    return 0
}

#######################################
# Unregister a project from the global registry
#
# Removes a project from the Nexus registry by name or hash.
# Does not delete the actual project files.
#
# Arguments:
#   $1 - Project name or hash (required)
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Success
#   1 - Missing required argument or registry doesn't exist
#   EXIT_NOT_FOUND (4) - Project not found in registry
#
# Example:
#   nexus_unregister "my-api"
#   nexus_unregister "a3f5b2c8d1e9"
#######################################
nexus_unregister() {
    local name_or_hash="${1:-}"

    if [[ -z "$name_or_hash" ]]; then
        echo "ERROR: Project name or hash required" >&2
        return 1
    fi

    local registry_path
    registry_path=$(nexus_get_registry_path)

    if [[ ! -f "$registry_path" ]]; then
        echo "ERROR: Nexus registry not initialized" >&2
        return 1
    fi

    # Try to find project by name or hash
    local project_hash
    if [[ "$name_or_hash" =~ ^[a-f0-9]{12}$ ]]; then
        # Looks like a hash
        project_hash="$name_or_hash"
    else
        # Try to resolve name to hash
        project_hash=$(jq -r --arg name "$name_or_hash" \
            '.projects[] | select(.name == $name) | .path' \
            "$registry_path" 2>/dev/null | head -1)

        if [[ -n "$project_hash" ]]; then
            project_hash=$(generate_project_hash "$project_hash")
        fi
    fi

    # Verify project exists
    if ! jq -e --arg hash "$project_hash" '.projects[$hash]' "$registry_path" >/dev/null 2>&1; then
        echo "ERROR: Project not found in registry: $name_or_hash" >&2
        return "$EXIT_NOT_FOUND"
    fi

    # Remove project from registry
    local temp_file
    temp_file=$(mktemp)
    trap "rm -f '$temp_file'" RETURN

    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq --arg hash "$project_hash" \
       --arg now "$now" \
       'del(.projects[$hash]) | ._meta.updatedAt = $now' \
       "$registry_path" > "$temp_file"

    # Save using atomic write
    if ! save_json "$registry_path" < "$temp_file"; then
        echo "ERROR: Failed to save registry file" >&2
        return 1
    fi

    return 0
}

#######################################
# List all registered projects
#
# Returns an array of all projects in the registry with their metadata.
# Supports JSON output for programmatic use.
#
# Arguments:
#   $1 - Format (optional: "json" or omit for human-readable)
#
# Returns:
#   JSON array if --json, human-readable table otherwise
#
# Exit Status:
#   0 - Success (returns empty array if no projects)
#   1 - Registry doesn't exist
#
# Example:
#   nexus_list --json | jq '.[] | select(.name == "my-api")'
#   nexus_list
#######################################
nexus_list() {
    local format="${1:-}"
    local registry_path
    registry_path=$(nexus_get_registry_path)

    if [[ ! -f "$registry_path" ]]; then
        if [[ "$format" == "--json" ]]; then
            echo "[]"
        else
            echo "No projects registered (run nexus_init first)" >&2
        fi
        return 1
    fi

    if [[ "$format" == "--json" ]]; then
        jq -r '.projects | to_entries | map(.value)' "$registry_path"
    else
        # Human-readable output
        jq -r '.projects | to_entries[] |
            "\(.value.name)\t\(.key)\t\(.value.taskCount)\t\(.value.lastSync)"' \
            "$registry_path" | \
        {
            echo -e "NAME\tHASH\tTASKS\tLAST_SYNC"
            cat
        } | column -t -s $'\t'
    fi
}

#######################################
# Get project details from registry
#
# Retrieves full project metadata by name or hash.
# Returns empty object if not found.
#
# Arguments:
#   $1 - Project name or hash (required)
#
# Returns:
#   JSON object on stdout (empty object {} if not found)
#
# Exit Status:
#   0 - Always succeeds (returns {} if not found)
#
# Example:
#   project=$(nexus_get_project "my-api")
#   path=$(echo "$project" | jq -r '.path')
#######################################
nexus_get_project() {
    local name_or_hash="${1:-}"
    local registry_path
    registry_path=$(nexus_get_registry_path)

    if [[ -z "$name_or_hash" ]]; then
        echo "{}"
        return 0
    fi

    if [[ ! -f "$registry_path" ]]; then
        echo "{}"
        return 0
    fi

    # Try hash first
    if [[ "$name_or_hash" =~ ^[a-f0-9]{12}$ ]]; then
        jq -r --arg hash "$name_or_hash" '.projects[$hash] // {}' "$registry_path"
        return 0
    fi

    # Try name - use jq first() to get only first match as complete JSON
    local result
    result=$(jq --arg name "$name_or_hash" \
        '[.projects[] | select(.name == $name)] | first // {}' \
        "$registry_path" 2>/dev/null)

    if [[ -n "$result" && "$result" != "null" ]]; then
        echo "$result"
    else
        echo "{}"
    fi
}

#######################################
# Sync project metadata in registry
#
# Updates task count, labels, and lastSync timestamp for a registered project.
# Reads current state from project's todo.json.
#
# Arguments:
#   $1 - Project name or hash (required)
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Success
#   1 - Missing required argument
#   EXIT_NOT_FOUND (4) - Project not found in registry
#
# Example:
#   nexus_sync "my-api"
#######################################
nexus_sync() {
    local name_or_hash="${1:-}"

    if [[ -z "$name_or_hash" ]]; then
        echo "ERROR: Project name or hash required" >&2
        return 1
    fi

    # Get project details
    local project
    project=$(nexus_get_project "$name_or_hash")

    if [[ "$project" == "{}" ]]; then
        echo "ERROR: Project not found in registry: $name_or_hash" >&2
        return "$EXIT_NOT_FOUND"
    fi

    local project_path
    project_path=$(echo "$project" | jq -r '.path')

    if [[ ! -f "$project_path/.cleo/todo.json" ]]; then
        echo "ERROR: Project todo.json not found: $project_path/.cleo/todo.json" >&2
        return "$EXIT_NOT_FOUND"
    fi

    # Get updated task count and labels
    local task_count
    task_count=$(jq '.tasks | length' "$project_path/.cleo/todo.json")

    local labels
    labels=$(jq -c '[.tasks[].labels // [] | .[] ] | unique' "$project_path/.cleo/todo.json")

    # Update registry
    local registry_path
    registry_path=$(nexus_get_registry_path)

    local project_hash
    project_hash=$(generate_project_hash "$project_path")

    local temp_file
    temp_file=$(mktemp)
    trap "rm -f '$temp_file'" RETURN

    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq --arg hash "$project_hash" \
       --arg now "$now" \
       --argjson taskCount "$task_count" \
       --argjson labels "$labels" \
       '.projects[$hash].taskCount = $taskCount |
        .projects[$hash].labels = $labels |
        .projects[$hash].lastSync = $now |
        ._meta.updatedAt = $now' \
       "$registry_path" > "$temp_file"

    # Save using atomic write
    if ! save_json "$registry_path" < "$temp_file"; then
        echo "ERROR: Failed to save registry file" >&2
        return 1
    fi

    return 0
}

#######################################
# Check if project is registered
#
# Tests whether a project exists in the Nexus registry by name or hash.
#
# Arguments:
#   $1 - Project name or hash (required)
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Project is registered
#   1 - Project is not registered or invalid argument
#
# Example:
#   if nexus_project_exists "my-api"; then
#       echo "Project is registered"
#   fi
#######################################
nexus_project_exists() {
    local name_or_hash="${1:-}"

    if [[ -z "$name_or_hash" ]]; then
        return 1
    fi

    local project
    project=$(nexus_get_project "$name_or_hash")

    [[ "$project" != "{}" ]]
}
