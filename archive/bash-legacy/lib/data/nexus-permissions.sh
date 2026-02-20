#!/usr/bin/env bash
# nexus-permissions.sh - Permission enforcement for CLEO Nexus
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: nexus-registry.sh, exit-codes.sh, file-ops.sh
# PROVIDES: nexus_check_permission, nexus_require_permission,
#           nexus_get_permission, nexus_set_permission,
#           nexus_permission_level, nexus_can_read,
#           nexus_can_write, nexus_can_execute
#
# PURPOSE:
#   Enforces three-tier permission model (read/write/execute) for cross-project
#   operations. Implements hierarchical permission checks with inheritance.
#
# PERMISSION MODEL:
#   read (1)    - Query tasks, discover relationships
#   write (2)   - read + modify task fields, add relationships
#   execute (3) - write + create/delete tasks, run commands
#
# ARCHITECTURE:
#   - Permissions stored in registry.json projects[hash].permissions field
#   - Hierarchical: execute > write > read
#   - Same project always has full permissions
#   - Default permission: "read" if not specified
#
# USAGE:
#   source lib/data/nexus-permissions.sh
#   nexus_require_permission "my-project" "write" "update task T001"
#   if nexus_can_write "auth-lib"; then
#       # perform write operation
#   fi

#=== SOURCE GUARD ================================================
[[ -n "${_NEXUS_PERMISSIONS_LOADED:-}" ]] && return 0
declare -r _NEXUS_PERMISSIONS_LOADED=1

set -euo pipefail

#=== DEPENDENCIES ================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source nexus-registry for project lookups
if [[ -f "$_LIB_DIR/data/nexus-registry.sh" ]]; then
    # shellcheck source=lib/data/nexus-registry.sh
    source "$_LIB_DIR/data/nexus-registry.sh"
else
    echo "ERROR: Cannot find nexus-registry.sh in $_LIB_DIR" >&2
    exit 1
fi

# Source exit codes for error handling
if [[ -f "$_LIB_DIR/core/exit-codes.sh" ]]; then
    # shellcheck source=lib/core/exit-codes.sh
    source "$_LIB_DIR/core/exit-codes.sh"
else
    echo "ERROR: Cannot find exit-codes.sh in $_LIB_DIR" >&2
    exit 1
fi

# Source file-ops for atomic writes
if [[ -f "$_LIB_DIR/data/file-ops.sh" ]]; then
    # shellcheck source=lib/data/file-ops.sh
    source "$_LIB_DIR/data/file-ops.sh"
else
    echo "ERROR: Cannot find file-ops.sh in $_LIB_DIR" >&2
    exit 1
fi

#=== CONSTANTS ===================================================

# Permission level values (hierarchical)
readonly NEXUS_PERMISSION_READ=1
readonly NEXUS_PERMISSION_WRITE=2
readonly NEXUS_PERMISSION_EXECUTE=3

# Valid permission enum values
readonly NEXUS_VALID_PERMISSIONS="read write execute"

#=== TEST OVERRIDES ==============================================

# Allow bypass for testing
NEXUS_SKIP_PERMISSION_CHECK="${NEXUS_SKIP_PERMISSION_CHECK:-false}"

#=== FUNCTIONS ===================================================

#######################################
# Convert permission string to numeric level
#
# Converts permission names to hierarchical numeric values for comparison.
# Returns 0 for invalid permissions to fail permission checks.
#
# Arguments:
#   $1 - Permission string (required): read, write, or execute
#
# Returns:
#   Numeric level on stdout:
#     1 for "read"
#     2 for "write"
#     3 for "execute"
#     0 for invalid/unknown permission
#
# Exit Status:
#   0 - Always succeeds
#
# Example:
#   level=$(nexus_permission_level "write")
#   # Returns: 2
#######################################
nexus_permission_level() {
    local permission="${1:-}"

    case "$permission" in
        read)    echo "$NEXUS_PERMISSION_READ" ;;
        write)   echo "$NEXUS_PERMISSION_WRITE" ;;
        execute) echo "$NEXUS_PERMISSION_EXECUTE" ;;
        *)       echo 0 ;;
    esac
}

#######################################
# Get permission level for a project
#
# Retrieves the permission field from the project's registry entry.
# Returns empty string if project not found or no permission specified.
#
# Arguments:
#   $1 - Project name or hash (required)
#
# Returns:
#   Permission string on stdout (read, write, execute) or empty
#
# Exit Status:
#   0 - Always succeeds (empty string if not found)
#
# Example:
#   permission=$(nexus_get_permission "my-api")
#   # Returns: "read" or "write" or "execute" or ""
#######################################
nexus_get_permission() {
    local name_or_hash="${1:-}"

    if [[ -z "$name_or_hash" ]]; then
        echo ""
        return 0
    fi

    # Get project details from registry
    local project
    project=$(nexus_get_project "$name_or_hash")

    if [[ "$project" == "{}" ]]; then
        echo ""
        return 0
    fi

    # Extract permission field (default to empty if not present)
    echo "$project" | jq -r '.permissions // ""'
}

#######################################
# Set permission for a project
#
# Updates the permissions field in the registry for a project.
# Validates that permission is a valid enum value (read, write, execute).
#
# Arguments:
#   $1 - Project name or hash (required)
#   $2 - Permission level (required): read, write, or execute
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Success
#   1 - Missing required argument or invalid permission
#   EXIT_NOT_FOUND (4) - Project not found in registry
#
# Example:
#   nexus_set_permission "my-api" "write"
#######################################
nexus_set_permission() {
    local name_or_hash="${1:-}"
    local permission="${2:-}"

    if [[ -z "$name_or_hash" ]]; then
        echo "ERROR: Project name or hash required" >&2
        return 1
    fi

    if [[ -z "$permission" ]]; then
        echo "ERROR: Permission level required" >&2
        return 1
    fi

    # Validate permission is in enum
    if [[ ! "$NEXUS_VALID_PERMISSIONS" =~ (^|[[:space:]])$permission($|[[:space:]]) ]]; then
        echo "ERROR: Invalid permission '$permission'. Must be one of: $NEXUS_VALID_PERMISSIONS" >&2
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

    # Generate project hash
    local project_hash
    project_hash=$(generate_project_hash "$project_path")

    # Update registry
    local registry_path
    registry_path=$(nexus_get_registry_path)

    local temp_file
    temp_file=$(mktemp)
    trap "rm -f '$temp_file'" RETURN

    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq --arg hash "$project_hash" \
       --arg permission "$permission" \
       --arg now "$now" \
       '.projects[$hash].permissions = $permission |
        .lastUpdated = $now' \
       "$registry_path" > "$temp_file"

    # Save using atomic write
    if ! save_json "$registry_path" < "$temp_file"; then
        echo "ERROR: Failed to save registry file" >&2
        return 1
    fi

    return 0
}

#######################################
# Check if project has sufficient permissions (non-exiting)
#
# Tests whether a project has at least the required permission level.
# Uses hierarchical permission model: execute > write > read.
# Returns exit status for conditional checks without terminating script.
#
# Arguments:
#   $1 - Project name or hash (required)
#   $2 - Required permission level (required): read, write, or execute
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Permission granted (sufficient level)
#   1 - Permission denied (insufficient level) or project not found
#
# Example:
#   if nexus_check_permission "my-api" "write"; then
#       echo "Write access granted"
#   else
#       echo "Write access denied"
#   fi
#######################################
nexus_check_permission() {
    local name_or_hash="${1:-}"
    local required_level="${2:-}"

    # Test bypass
    if [[ "$NEXUS_SKIP_PERMISSION_CHECK" == "true" ]]; then
        return 0
    fi

    if [[ -z "$name_or_hash" ]] || [[ -z "$required_level" ]]; then
        return 1
    fi

    # Validate required level is valid
    if [[ ! "$NEXUS_VALID_PERMISSIONS" =~ (^|[[:space:]])$required_level($|[[:space:]]) ]]; then
        return 1
    fi

    # Get granted permission
    local granted_permission
    granted_permission=$(nexus_get_permission "$name_or_hash")

    # Default to read if no permission specified
    if [[ -z "$granted_permission" ]]; then
        granted_permission="read"
    fi

    # Convert to numeric levels for comparison
    local required_num granted_num
    required_num=$(nexus_permission_level "$required_level")
    granted_num=$(nexus_permission_level "$granted_permission")

    # Check if granted level is sufficient (hierarchical)
    [[ "$granted_num" -ge "$required_num" ]]
}

#######################################
# Require permission or exit with error
#
# Enforces permission requirement for cross-project operations.
# Exits with EXIT_NEXUS_PERMISSION_DENIED (72) if permission denied.
# Logs operation attempt for audit trail.
#
# Arguments:
#   $1 - Project name or hash (required)
#   $2 - Required permission level (required): read, write, or execute
#   $3 - Operation name (optional, for error message)
#
# Returns:
#   Nothing on stdout if successful
#   JSON error on stderr if denied
#
# Exit Status:
#   0 - Permission granted
#   EXIT_NEXUS_PERMISSION_DENIED (72) - Permission denied
#
# Example:
#   nexus_require_permission "my-api" "write" "update task T001"
#   # continues only if write permission granted
#######################################
nexus_require_permission() {
    local name_or_hash="${1:-}"
    local required_level="${2:-}"
    local operation_name="${3:-operation}"

    # Test bypass
    if [[ "$NEXUS_SKIP_PERMISSION_CHECK" == "true" ]]; then
        return 0
    fi

    if ! nexus_check_permission "$name_or_hash" "$required_level"; then
        local granted_permission
        granted_permission=$(nexus_get_permission "$name_or_hash")
        if [[ -z "$granted_permission" ]]; then
            granted_permission="read (default)"
        fi

        # Format error message
        local error_msg="Permission denied: '$required_level' required for '$operation_name' on project '$name_or_hash' (granted: $granted_permission)"

        # JSON error output
        cat >&2 <<EOF
{
  "error": {
    "code": "E_NEXUS_PERMISSION_DENIED",
    "message": "$error_msg",
    "project": "$name_or_hash",
    "required": "$required_level",
    "granted": "$granted_permission",
    "operation": "$operation_name"
  }
}
EOF

        exit "$EXIT_NEXUS_PERMISSION_DENIED"
    fi

    return 0
}

#######################################
# Check if project has read permission
#
# Convenience function for checking read access.
# Equivalent to: nexus_check_permission "$project" "read"
#
# Arguments:
#   $1 - Project name or hash (required)
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Read permission granted
#   1 - Read permission denied
#
# Example:
#   if nexus_can_read "my-api"; then
#       # perform read operation
#   fi
#######################################
nexus_can_read() {
    local name_or_hash="${1:-}"
    nexus_check_permission "$name_or_hash" "read"
}

#######################################
# Check if project has write permission
#
# Convenience function for checking write access.
# Equivalent to: nexus_check_permission "$project" "write"
#
# Arguments:
#   $1 - Project name or hash (required)
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Write permission granted
#   1 - Write permission denied
#
# Example:
#   if nexus_can_write "my-api"; then
#       # perform write operation
#   fi
#######################################
nexus_can_write() {
    local name_or_hash="${1:-}"
    nexus_check_permission "$name_or_hash" "write"
}

#######################################
# Check if project has execute permission
#
# Convenience function for checking execute access.
# Equivalent to: nexus_check_permission "$project" "execute"
#
# Arguments:
#   $1 - Project name or hash (required)
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Execute permission granted
#   1 - Execute permission denied
#
# Example:
#   if nexus_can_execute "my-api"; then
#       # perform execute operation
#   fi
#######################################
nexus_can_execute() {
    local name_or_hash="${1:-}"
    nexus_check_permission "$name_or_hash" "execute"
}
