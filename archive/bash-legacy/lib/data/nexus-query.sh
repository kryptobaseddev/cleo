#!/usr/bin/env bash
# nexus-query.sh - Query parser for cross-project task references
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: nexus-registry.sh, exit-codes.sh
# PROVIDES: nexus_parse_query, nexus_resolve_task, nexus_query,
#           nexus_validate_syntax, nexus_get_project_from_query,
#           nexus_get_current_project
#
# PURPOSE:
#   Parse and resolve `project:task_id` syntax for cross-project queries.
#   Supports wildcards (*), current project (.), and named projects.
#
# USAGE:
#   source lib/data/nexus-query.sh
#   result=$(nexus_parse_query "my-app:T001")
#   task=$(nexus_resolve_task "my-app:T001")
#   nexus_query "my-app:T001" --json
#
#=== SOURCE GUARD ================================================
[[ -n "${_NEXUS_QUERY_LOADED:-}" ]] && return 0
declare -r _NEXUS_QUERY_LOADED=1

set -euo pipefail

#=== DEPENDENCIES ================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source nexus-registry for project resolution
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

#=== TEST OVERRIDES ==============================================

# Allow override for testing
NEXUS_CURRENT_PROJECT="${NEXUS_CURRENT_PROJECT:-}"

#=== FUNCTIONS ===================================================

#######################################
# Get current project name from context
#
# Resolves the current project name by reading .cleo/project-info.json
# or falling back to directory name if file doesn't exist.
# Can be overridden via NEXUS_CURRENT_PROJECT for testing.
#
# Arguments:
#   None
#
# Returns:
#   Project name on stdout
#
# Exit Status:
#   0 - Success
#   1 - Cannot determine current project
#
# Example:
#   project=$(nexus_get_current_project)
#   # Returns: "my-api"
#######################################
nexus_get_current_project() {
    # Allow test override
    if [[ -n "$NEXUS_CURRENT_PROJECT" ]]; then
        echo "$NEXUS_CURRENT_PROJECT"
        return 0
    fi

    # Try to read from project-info.json
    if [[ -f ".cleo/project-info.json" ]]; then
        local name
        name=$(jq -r '.name // empty' .cleo/project-info.json 2>/dev/null)
        if [[ -n "$name" ]]; then
            echo "$name"
            return 0
        fi
    fi

    # Fallback to directory name
    local dir_name
    dir_name=$(basename "$(pwd)")
    if [[ -n "$dir_name" ]]; then
        echo "$dir_name"
        return 0
    fi

    echo "ERROR: Cannot determine current project name" >&2
    return 1
}

#######################################
# Validate query string syntax
#
# Validates that a query string matches the expected format:
# - project:T001 (named project)
# - .:T001 (current project)
# - *:T001 (wildcard)
# - T001 (implicit current project)
#
# Arguments:
#   $1 - Query string (required)
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Valid syntax
#   EXIT_NEXUS_INVALID_SYNTAX (73) - Invalid format
#
# Example:
#   if nexus_validate_syntax "my-app:T001"; then
#       echo "Valid"
#   fi
#######################################
nexus_validate_syntax() {
    local query="${1:-}"

    if [[ -z "$query" ]]; then
        return "$EXIT_NEXUS_INVALID_SYNTAX"
    fi

    # Valid formats:
    # - T001 (task ID only)
    # - project:T001 (named project)
    # - .:T001 (current project)
    # - *:T001 (wildcard)
    if [[ "$query" =~ ^T[0-9]{3,}$ ]]; then
        # Task ID only - valid
        return 0
    elif [[ "$query" =~ ^([a-z0-9_-]+|\.|\*):T[0-9]{3,}$ ]]; then
        # Project prefix with task ID - valid
        return 0
    else
        # Invalid format
        return "$EXIT_NEXUS_INVALID_SYNTAX"
    fi
}

#######################################
# Parse query into components
#
# Parses a query string into a JSON object with project name and task ID.
# Handles implicit current project (no colon) and wildcard search.
#
# Arguments:
#   $1 - Query string (required)
#
# Returns:
#   JSON object on stdout:
#   {"project": "name", "taskId": "T001", "wildcard": false}
#
# Exit Status:
#   0 - Success
#   EXIT_NEXUS_INVALID_SYNTAX (73) - Invalid format
#   1 - Cannot determine current project (for implicit queries)
#
# Example:
#   result=$(nexus_parse_query "my-app:T001")
#   # Returns: {"project":"my-app","taskId":"T001","wildcard":false}
#######################################
nexus_parse_query() {
    local query="${1:-}"

    # Validate syntax first
    if ! nexus_validate_syntax "$query"; then
        echo "ERROR: Invalid query syntax: $query" >&2
        return "$EXIT_NEXUS_INVALID_SYNTAX"
    fi

    local project=""
    local task_id=""
    local wildcard="false"

    # Check if query contains colon
    if [[ "$query" =~ ^([^:]+):(.+)$ ]]; then
        # Has project prefix
        local prefix="${BASH_REMATCH[1]}"
        task_id="${BASH_REMATCH[2]}"

        case "$prefix" in
            ".")
                # Current project
                project=$(nexus_get_current_project) || return 1
                ;;
            "*")
                # Wildcard search
                project="*"
                wildcard="true"
                ;;
            *)
                # Named project
                project="$prefix"
                ;;
        esac
    else
        # No colon - implicit current project
        task_id="$query"
        project=$(nexus_get_current_project) || return 1
    fi

    # Output JSON
    jq -n \
        --arg project "$project" \
        --arg taskId "$task_id" \
        --argjson wildcard "$wildcard" \
        '{project: $project, taskId: $taskId, wildcard: $wildcard}'

    return 0
}

#######################################
# Resolve project name to path
#
# Resolves a project name to its filesystem path.
# Handles special cases: "." (current), "*" (wildcard).
# Uses nexus_get_project() for registry lookup.
#
# Arguments:
#   $1 - Project name (required)
#
# Returns:
#   Project path on stdout
#   For "*", returns special marker "WILDCARD"
#
# Exit Status:
#   0 - Success
#   EXIT_NEXUS_PROJECT_NOT_FOUND (71) - Project not in registry
#   1 - Current directory not a CLEO project
#
# Example:
#   path=$(nexus_resolve_project "my-api")
#   # Returns: "/home/user/my-api"
#######################################
nexus_resolve_project() {
    local project_name="${1:-}"
    local format="${2:-}"

    if [[ -z "$project_name" ]]; then
        # Only output error to stderr if not in JSON mode
        if [[ "$format" != "--json" ]]; then
            echo "ERROR: Project name required" >&2
        fi
        return 1
    fi

    # Handle special cases
    case "$project_name" in
        ".")
            # Current directory
            if [[ -f ".cleo/todo.json" ]]; then
                pwd
                return 0
            else
                # Only output error to stderr if not in JSON mode
                if [[ "$format" != "--json" ]]; then
                    echo "ERROR: Current directory is not a CLEO project" >&2
                fi
                return 1
            fi
            ;;
        "*")
            # Wildcard - return special marker
            echo "WILDCARD"
            return 0
            ;;
        *)
            # Named project - lookup in registry
            local project_json
            project_json=$(nexus_get_project "$project_name")

            if [[ "$project_json" == "{}" ]]; then
                # Only output error to stderr if not in JSON mode
                if [[ "$format" != "--json" ]]; then
                    echo "ERROR: Project not found in registry: $project_name" >&2
                fi
                return "$EXIT_NEXUS_PROJECT_NOT_FOUND"
            fi

            # Extract path
            local path
            path=$(echo "$project_json" | jq -r '.path // empty')

            if [[ -z "$path" ]]; then
                # Only output error to stderr if not in JSON mode
                if [[ "$format" != "--json" ]]; then
                    echo "ERROR: Project has no path: $project_name" >&2
                fi
                return "$EXIT_NEXUS_PROJECT_NOT_FOUND"
            fi

            echo "$path"
            return 0
            ;;
    esac
}

#######################################
# Resolve task from query
#
# Full resolution: query → project path → task data.
# For wildcard queries, returns array of matches from all projects.
# For named projects, returns single task with project context.
#
# Arguments:
#   $1 - Query string (required)
#
# Returns:
#   Task JSON on stdout (single object or array for wildcards)
#
# Exit Status:
#   0 - Success
#   EXIT_NEXUS_INVALID_SYNTAX (73) - Bad query format
#   EXIT_NEXUS_PROJECT_NOT_FOUND (71) - Project not in registry
#   EXIT_NOT_FOUND (4) - Task not found
#   EXIT_NEXUS_QUERY_FAILED (77) - Query execution failed
#
# Example:
#   task=$(nexus_resolve_task "my-api:T001")
#   # Returns: {"id":"T001","title":"...","_project":"my-api",...}
#######################################
nexus_resolve_task() {
    local query="${1:-}"
    local format="${2:-}"

    # Parse query
    local parsed
    parsed=$(nexus_parse_query "$query") || return $?

    local project
    project=$(echo "$parsed" | jq -r '.project')
    local task_id
    task_id=$(echo "$parsed" | jq -r '.taskId')
    local wildcard
    wildcard=$(echo "$parsed" | jq -r '.wildcard')

    # Handle wildcard search
    if [[ "$wildcard" == "true" ]]; then
        # Search all registered projects
        local registry_path
        registry_path=$(nexus_get_registry_path)

        if [[ ! -f "$registry_path" ]]; then
            echo "[]"
            return 0
        fi

        local results="[]"
        local project_hashes
        readarray -t project_hashes < <(jq -r '.projects | keys[]' "$registry_path")

        for hash in "${project_hashes[@]}"; do
            local project_data
            project_data=$(jq -r --arg hash "$hash" '.projects[$hash]' "$registry_path")

            local project_path
            project_path=$(echo "$project_data" | jq -r '.path')
            local project_name
            project_name=$(echo "$project_data" | jq -r '.name')

            local todo_file="${project_path}/.cleo/todo.json"
            if [[ ! -f "$todo_file" ]]; then
                continue
            fi

            # Check if task exists in this project
            local task
            task=$(jq --arg id "$task_id" '.tasks[] | select(.id == $id)' "$todo_file" 2>/dev/null || echo "")

            if [[ -n "$task" ]]; then
                # Add project context
                task=$(echo "$task" | jq --arg project "$project_name" '. + {_project: $project}')
                results=$(echo "$results" | jq --argjson task "$task" '. + [$task]')
            fi
        done

        echo "$results"
        return 0
    fi

    # Named project - resolve path
    local project_path
    project_path=$(nexus_resolve_project "$project" "$format") || return $?

    local todo_file="${project_path}/.cleo/todo.json"
    if [[ ! -f "$todo_file" ]]; then
        # Only output error to stderr if not in JSON mode
        if [[ "$format" != "--json" ]]; then
            echo "ERROR: Project todo.json not found: $todo_file" >&2
        fi
        return "$EXIT_NOT_FOUND"
    fi

    # Find task
    local task
    task=$(jq --arg id "$task_id" '.tasks[] | select(.id == $id)' "$todo_file" 2>/dev/null)

    if [[ -z "$task" ]]; then
        # Only output error to stderr if not in JSON mode
        if [[ "$format" != "--json" ]]; then
            echo "ERROR: Task not found: $task_id in project $project" >&2
        fi
        return "$EXIT_NOT_FOUND"
    fi

    # Add project context
    task=$(echo "$task" | jq --arg project "$project" '. + {_project: $project}')

    echo "$task"
    return 0
}

#######################################
# Main entry point for query operations
#
# Validates syntax, resolves project, and returns task data.
# Supports JSON output for programmatic use.
#
# Arguments:
#   $1 - Query string (required)
#   $2 - Output format (optional: "--json" or omit for human-readable)
#
# Returns:
#   Task data on stdout (JSON or human-readable)
#
# Exit Status:
#   0 - Success
#   EXIT_NEXUS_INVALID_SYNTAX (73) - Bad query format
#   EXIT_NEXUS_PROJECT_NOT_FOUND (71) - Project not in registry
#   EXIT_NOT_FOUND (4) - Task not found
#   EXIT_NEXUS_QUERY_FAILED (77) - Query execution failed
#
# Example:
#   nexus_query "my-api:T001" --json
#   nexus_query ".:T001"
#######################################
nexus_query() {
    local query="${1:-}"
    local format="${2:-}"

    if [[ -z "$query" ]]; then
        # Only output error to stderr if not in JSON mode
        if [[ "$format" != "--json" ]]; then
            echo "ERROR: Query string required" >&2
        fi
        return 1
    fi

    # Validate syntax
    if ! nexus_validate_syntax "$query"; then
        # Only output error to stderr if not in JSON mode
        if [[ "$format" != "--json" ]]; then
            echo "ERROR: Invalid query syntax: $query" >&2
            echo "Expected formats: T001, project:T001, .:T001, *:T001" >&2
        fi
        return "$EXIT_NEXUS_INVALID_SYNTAX"
    fi

    # Resolve task
    local result
    result=$(nexus_resolve_task "$query" "$format")
    local resolve_exit=$?
    if [[ $resolve_exit -ne 0 ]]; then
        return $resolve_exit
    fi

    # Output based on format
    if [[ "$format" == "--json" ]]; then
        echo "$result"
    else
        # Human-readable output
        if [[ "$(echo "$result" | jq -r 'type')" == "array" ]]; then
            # Wildcard results
            local count
            count=$(echo "$result" | jq 'length')
            echo "Found $count matching tasks:"
            echo "$result" | jq -r '.[] | "\(.id) [\(._project)] \(.title)"'
        else
            # Single task
            echo "$result" | jq -r '"Task: \(.id) [\(._project)]\nTitle: \(.title)\nStatus: \(.status)\nDescription: \(.description)"'
        fi
    fi

    return 0
}

#######################################
# Get project name from query
#
# Extracts the project name from a parsed query without full resolution.
# Useful for permission checks before full task lookup.
#
# Arguments:
#   $1 - Query string (required)
#
# Returns:
#   Project name on stdout
#
# Exit Status:
#   0 - Success
#   EXIT_NEXUS_INVALID_SYNTAX (73) - Bad query format
#   1 - Cannot determine project
#
# Example:
#   project=$(nexus_get_project_from_query "my-api:T001")
#   # Returns: "my-api"
#######################################
nexus_get_project_from_query() {
    local query="${1:-}"

    # Parse query
    local parsed
    parsed=$(nexus_parse_query "$query") || return $?

    local project
    project=$(echo "$parsed" | jq -r '.project')

    echo "$project"
    return 0
}
