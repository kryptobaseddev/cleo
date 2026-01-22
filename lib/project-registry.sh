#!/usr/bin/env bash
# project-registry.sh - Project registration utilities (Layer 1)
#
# LAYER: 1 (Utilities)
# DEPENDENCIES: file-ops.sh
# PROVIDES: generate_project_hash, is_project_registered, get_project_data,
#           create_empty_registry, list_registered_projects, prune_registry
#
# PURPOSE:
#   Pure functions for managing the global project registry.
#   No side effects - all functions are read-only except create_empty_registry.
#
# DESIGN PRINCIPLES:
#   - Pure functions with no global state pollution
#   - All variables are local
#   - Minimal dependencies (only file-ops.sh)
#   - Returns data via stdout, errors via stderr
#   - Exit codes follow exit-codes.sh conventions
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
# Get project data from registry
#
# Retrieves the complete project data object for a given hash.
# Returns empty object if project not found or registry doesn't exist.
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
#   data=$(get_project_data "a3f5b2c8d1e9")
#   path=$(echo "$data" | jq -r '.path')
#######################################
get_project_data() {
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
    jq '.lastUpdated = (now | todate)' "$temp_file" > "${temp_file}.tmp"
    mv "${temp_file}.tmp" "$temp_file"

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
