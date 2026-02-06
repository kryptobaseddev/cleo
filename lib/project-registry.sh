#!/usr/bin/env bash
# project-registry.sh - Project registration utilities (Layer 1)
#
# LAYER: 1 (Utilities)
# DEPENDENCIES: file-ops.sh
# PROVIDES: generate_project_hash, is_project_registered, get_project_data,
#           get_project_data_global, create_empty_registry, list_registered_projects,
#           prune_registry, get_project_info_path, get_project_info, save_project_info,
#           has_project_info
#
# PURPOSE:
#   Functions for managing the hybrid project registry architecture:
#   - Global registry (~/.cleo/projects-registry.json): Minimal info, system-wide
#   - Per-project info (.cleo/project-info.json): Detailed metadata, project-local
#
# HYBRID MODEL:
#   The registry uses a two-tier approach:
#   1. Global registry: Contains minimal project info (hash, path, name, lastAccess)
#   2. Per-project file: Contains detailed metadata (description, aliases, custom fields)
#
#   get_project_data() merges both sources, with per-project info taking precedence.
#
# DESIGN PRINCIPLES:
#   - Pure functions with no global state pollution
#   - All variables are local
#   - Minimal dependencies (only file-ops.sh)
#   - Returns data via stdout, errors via stderr
#   - Exit codes follow exit-codes.sh conventions
#   - Backward compatible: works with or without per-project info
#
# USAGE:
#   source lib/project-registry.sh
#   hash=$(generate_project_hash "/path/to/project")
#   if is_project_registered "$hash"; then
#       data=$(get_project_data "$hash")
#   fi

#=== SOURCE GUARD ================================================
[[ -n "${_PROJECT_REGISTRY_LOADED:-}" ]] && return 0
declare -r _PROJECT_REGISTRY_LOADED=1

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

#=== FUNCTIONS ====================================================

#######################################
# Generate stable hash from project path
#
# Creates a 12-character hex hash from the absolute project path.
# This hash is used as the unique identifier in the project registry.
#
# Arguments:
#   $1 - Project path (required)
#
# Returns:
#   12-character hex hash on stdout
#
# Exit Status:
#   0 - Success
#   1 - Missing required argument
#
# Example:
#   hash=$(generate_project_hash "/home/user/myproject")
#   # Returns: "a3f5b2c8d1e9"
#######################################
generate_project_hash() {
    local path="${1:-}"

    if [[ -z "$path" ]]; then
        echo "ERROR: Project path required" >&2
        return 1
    fi

    echo -n "$path" | sha256sum | cut -c1-12
}

#=== PER-PROJECT INFO FUNCTIONS ======================================
# These functions manage the per-project .cleo/project-info.json file
# which stores detailed project metadata locally within each project.

#######################################
# Get per-project info file path
#
# Returns the path to the project-info.json file for a given project.
# The file is stored at .cleo/project-info.json within the project directory.
#
# Arguments:
#   $1 - Project path (optional, defaults to PWD)
#
# Returns:
#   Full path to project-info.json on stdout
#
# Exit Status:
#   0 - Always succeeds
#
# Example:
#   path=$(get_project_info_path "/home/user/myproject")
#   # Returns: "/home/user/myproject/.cleo/project-info.json"
#######################################
get_project_info_path() {
    local project_path="${1:-$PWD}"
    echo "${project_path}/.cleo/project-info.json"
}

#######################################
# Check if project has per-project info file
#
# Tests whether a project has a local project-info.json file.
#
# Arguments:
#   $1 - Project path (optional, defaults to PWD)
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Project has project-info.json
#   1 - Project does not have project-info.json
#
# Example:
#   if has_project_info "/home/user/myproject"; then
#       echo "Project has local info file"
#   fi
#######################################
has_project_info() {
    local project_path="${1:-$PWD}"
    [[ -f "$(get_project_info_path "$project_path")" ]]
}

#######################################
# Read per-project info
#
# Retrieves the complete project info from the local .cleo/project-info.json file.
# Returns empty object if the file doesn't exist.
#
# Arguments:
#   $1 - Project path (optional, defaults to PWD)
#
# Returns:
#   JSON object on stdout (empty object {} if file doesn't exist)
#
# Exit Status:
#   0 - Success (returns empty object if file doesn't exist)
#   1 - File exists but is not valid JSON
#
# Example:
#   info=$(get_project_info "/home/user/myproject")
#   description=$(echo "$info" | jq -r '.description')
#######################################
get_project_info() {
    local project_path="${1:-$PWD}"
    local info_file
    info_file=$(get_project_info_path "$project_path")

    # Return empty object if file doesn't exist
    if [[ ! -f "$info_file" ]]; then
        echo "{}"
        return 0
    fi

    # Validate JSON and return
    if ! jq -e . "$info_file" >/dev/null 2>&1; then
        echo "ERROR: Invalid JSON in $info_file" >&2
        return 1
    fi

    cat "$info_file"
}

#######################################
# Save per-project info
#
# Writes project info to the local .cleo/project-info.json file.
# Creates the .cleo directory if it doesn't exist.
# Uses atomic write for data safety.
#
# Arguments:
#   $1 - Project path (optional, defaults to PWD)
#   stdin - JSON content to save
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Success
#   1 - Invalid JSON input or save failed
#
# Example:
#   echo '{"description": "My project", "aliases": ["mp"]}' | save_project_info "/home/user/myproject"
#######################################
save_project_info() {
    local project_path="${1:-$PWD}"
    local info_file
    info_file=$(get_project_info_path "$project_path")

    # Read content from stdin
    local content
    content=$(cat)

    # Validate JSON input
    if ! echo "$content" | jq -e . >/dev/null 2>&1; then
        echo "ERROR: Invalid JSON content" >&2
        return 1
    fi

    # Ensure .cleo directory exists
    local cleo_dir
    cleo_dir=$(dirname "$info_file")
    if [[ ! -d "$cleo_dir" ]]; then
        mkdir -p "$cleo_dir" || {
            echo "ERROR: Failed to create directory $cleo_dir" >&2
            return 1
        }
    fi

    # Use atomic write via save_json
    if ! echo "$content" | save_json "$info_file"; then
        echo "ERROR: Failed to save project info to $info_file" >&2
        return 1
    fi
}

#######################################
# Check if project is registered
#
# Checks if a project with the given hash exists in the registry.
#
# Arguments:
#   $1 - Project hash (required, 12-char hex string)
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Project is registered
#   1 - Project is not registered or registry doesn't exist
#
# Example:
#   if is_project_registered "a3f5b2c8d1e9"; then
#       echo "Project found"
#   fi
#######################################
is_project_registered() {
    local project_hash="${1:-}"
    local registry

    if [[ -z "$project_hash" ]]; then
        echo "ERROR: Project hash required" >&2
        return 1
    fi

    registry="$(get_cleo_home)/projects-registry.json"

    [[ ! -f "$registry" ]] && return 1
    jq -e ".projects[\"$project_hash\"]" "$registry" >/dev/null 2>&1
}

#######################################
# Get project data from registry (hybrid model)
#
# Retrieves project data by merging global registry with per-project info.
# The function implements the hybrid registry model:
#   1. First retrieves minimal info from global registry
#   2. If project has a local project-info.json, merges detailed info
#   3. Per-project info takes precedence over global registry
#
# Arguments:
#   $1 - Project hash (required, 12-char hex string)
#
# Returns:
#   JSON object on stdout (empty object {} if not found)
#   The merged object contains fields from both sources.
#
# Exit Status:
#   0 - Always succeeds (returns empty object if not found)
#
# Example:
#   data=$(get_project_data "a3f5b2c8d1e9")
#   path=$(echo "$data" | jq -r '.path')
#   description=$(echo "$data" | jq -r '.description')  # from per-project
#######################################
get_project_data() {
    local project_hash="${1:-}"
    local registry
    local global_data
    local project_path
    local local_data

    if [[ -z "$project_hash" ]]; then
        echo "{}"
        return 0
    fi

    registry="$(get_cleo_home)/projects-registry.json"

    # Get global registry data
    if [[ ! -f "$registry" ]]; then
        echo "{}"
        return 0
    fi

    global_data=$(jq -r ".projects[\"$project_hash\"] // {}" "$registry")

    # If global data is empty, return it
    if [[ "$global_data" == "{}" ]]; then
        echo "{}"
        return 0
    fi

    # Extract project path from global data
    project_path=$(echo "$global_data" | jq -r '.path // empty')

    # If no path or path doesn't exist, return just global data
    if [[ -z "$project_path" || ! -d "$project_path" ]]; then
        echo "$global_data"
        return 0
    fi

    # Check for per-project info file
    if ! has_project_info "$project_path"; then
        echo "$global_data"
        return 0
    fi

    # Get per-project info
    local_data=$(get_project_info "$project_path")

    # If local data retrieval failed, return just global data
    if [[ $? -ne 0 || "$local_data" == "{}" ]]; then
        echo "$global_data"
        return 0
    fi

    # Merge: global_data as base, local_data takes precedence
    # Using jq's * operator for recursive merge
    echo "$global_data" | jq --argjson local "$local_data" '. * $local'
}

#######################################
# Get project data from global registry only (no merge)
#
# Retrieves only the global registry data without merging per-project info.
# Useful when you only need the minimal registration data.
#
# Arguments:
#   $1 - Project hash (required, 12-char hex string)
#
# Returns:
#   JSON object on stdout (empty object {} if not found)
#
# Exit Status:
#   0 - Always succeeds (returns empty object if not found)
#
# Example:
#   data=$(get_project_data_global "a3f5b2c8d1e9")
#   lastAccess=$(echo "$data" | jq -r '.lastAccess')
#######################################
get_project_data_global() {
    local project_hash="${1:-}"
    local registry

    if [[ -z "$project_hash" ]]; then
        echo "{}"
        return 0
    fi

    registry="$(get_cleo_home)/projects-registry.json"

    [[ ! -f "$registry" ]] && echo "{}" && return 0
    jq -r ".projects[\"$project_hash\"] // {}" "$registry"
}

#######################################
# Create empty registry file
#
# Initializes a new project registry file with the proper schema structure.
# Sets the initial lastUpdated timestamp to current time.
#
# Arguments:
#   $1 - Registry file path (required)
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Success
#   1 - Missing required argument or save failed
#
# Example:
#   create_empty_registry "$(get_cleo_home)/projects-registry.json"
#######################################
create_empty_registry() {
    local registry="${1:-}"
    local temp_file

    if [[ -z "$registry" ]]; then
        echo "ERROR: Registry file path required" >&2
        return 1
    fi

    # Create temporary file with base structure
    temp_file=$(mktemp)
    trap 'rm -f "$temp_file"' RETURN

    cat > "$temp_file" <<'EOF'
{
  "$schema": "./schemas/projects-registry.schema.json",
  "schemaVersion": "1.0.0",
  "lastUpdated": "",
  "projects": {}
}
EOF

    # Set initial lastUpdated timestamp
    local _pr_content
    _pr_content=$(jq '.lastUpdated = (now | todate)' "$temp_file")
    echo "$_pr_content" > "$temp_file"

    # Save using atomic write
    if ! save_json "$registry" < "$temp_file"; then
        echo "ERROR: Failed to save registry file" >&2
        return 1
    fi
}

#######################################
# List all registered projects
#
# Returns an array of all project objects in the registry.
# Returns empty array if registry doesn't exist.
#
# Arguments:
#   None
#
# Returns:
#   JSON array of project objects on stdout
#
# Exit Status:
#   0 - Success
#
# Example:
#   projects=$(list_registered_projects)
#   count=$(echo "$projects" | jq 'length')
#######################################
list_registered_projects() {
    local registry

    registry="$(get_cleo_home)/projects-registry.json"

    [[ ! -f "$registry" ]] && echo "[]" && return 0
    jq -r '.projects | to_entries | map(.value)' "$registry"
}

#######################################
# Prune missing projects from registry
#
# Removes projects from the registry where the project path no longer exists.
# Can be run in dry-run mode to preview what would be removed.
#
# Arguments:
#   $1 - "--dry-run" for preview mode (optional)
#
# Returns:
#   Newline-separated list of removed project hashes on stdout
#
# Exit Status:
#   0 - Success
#   1 - Registry doesn't exist
#
# Example:
#   # Preview what would be removed
#   prune_registry --dry-run
#
#   # Actually remove missing projects
#   prune_registry
#######################################
prune_registry() {
    local registry
    local dry_run="${1:-}"
    local removed=()
    local temp_file

    registry="$(get_cleo_home)/projects-registry.json"

    [[ ! -f "$registry" ]] && return 0

    # Get all project hashes
    local hashes
    hashes=$(jq -r '.projects | keys[]' "$registry")

    # Check each project path
    while IFS= read -r hash; do
        [[ -z "$hash" ]] && continue

        local project_path
        project_path=$(jq -r ".projects[\"$hash\"].path" "$registry")

        # If path doesn't exist, mark for removal
        if [[ ! -d "$project_path" ]]; then
            removed+=("$hash")

            # Remove from registry if not dry-run
            if [[ "$dry_run" != "--dry-run" ]]; then
                temp_file=$(mktemp)
                trap 'rm -f "$temp_file"' RETURN

                jq "del(.projects[\"$hash\"])" "$registry" > "$temp_file"

                if ! save_json "$registry" < "$temp_file"; then
                    echo "ERROR: Failed to update registry" >&2
                    return 1
                fi
            fi
        fi
    done <<< "$hashes"

    # Output removed project hashes
    if [[ ${#removed[@]} -gt 0 ]]; then
        printf '%s\n' "${removed[@]}"
    fi
}

# Remove a specific project from registry by hash
# Args: $1 - project hash
# Returns: 0 on success, 1 on failure
remove_project_from_registry() {
    local hash="$1"
    local registry="${CLEO_HOME:-$HOME/.cleo}/projects-registry.json"
    
    if [[ ! -f "$registry" ]]; then
        echo "Registry not found at $registry" >&2
        return 1
    fi
    
    # Check if project exists
    if ! is_project_registered "$hash"; then
        echo "Project $hash not found in registry" >&2
        return 1
    fi
    
    # Create temporary file for atomic update
    local temp_file="${registry}.tmp.$$"
    trap "rm -f '$temp_file'" EXIT
    
    # Remove project from registry
    if jq "del(.projects[\"$hash\"])" "$registry" > "$temp_file"; then
        if save_json "$registry" < "$temp_file"; then
            return 0
        else
            echo "Failed to save updated registry" >&2
            return 1
        fi
    else
        echo "Failed to remove project from registry" >&2
        return 1
    fi
}
