#!/usr/bin/env bash
# nexus-deps.sh - Global dependency analysis for CLEO Nexus
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: nexus-registry.sh, nexus-query.sh, nexus-permissions.sh,
#               graph-cache.sh
# PROVIDES: nexus_deps, nexus_critical_path, nexus_blocking_analysis,
#           nexus_build_global_graph, nexus_resolve_cross_deps,
#           nexus_orphan_detection
#
# PURPOSE:
#   Analyze dependencies across project boundaries. Enable unified critical
#   path and blocking analysis for the global task graph.
#
# CROSS-PROJECT DEPENDENCY FORMAT:
#   Dependencies can reference other projects:
#   {"id": "T001", "depends": ["T002", "other-project:T015"]}
#
# ARCHITECTURE:
#   - Extends lib/tasks/graph-cache.sh for O(1) lookups
#   - Resolves cross-project refs via nexus_resolve_task()
#   - Enforces permissions via nexus_check_permission()
#   - Caches global graph with combined checksum validation
#
# USAGE:
#   source lib/data/nexus-deps.sh
#   nexus_deps "my-app:T001"
#   nexus_critical_path "my-app:T100"
#   nexus_blocking_analysis "other-app:T015"
#   nexus_orphan_detection

#=== SOURCE GUARD ================================================
[[ -n "${_NEXUS_DEPS_LOADED:-}" ]] && return 0
declare -r _NEXUS_DEPS_LOADED=1

set -euo pipefail

#=== DEPENDENCIES ================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source nexus-registry for project operations
if [[ -f "$_LIB_DIR/data/nexus-registry.sh" ]]; then
    # shellcheck source=lib/data/nexus-registry.sh
    source "$_LIB_DIR/data/nexus-registry.sh"
else
    echo "ERROR: Cannot find nexus-registry.sh in $_LIB_DIR" >&2
    exit 1
fi

# Source nexus-query for cross-project resolution
if [[ -f "$_LIB_DIR/data/nexus-query.sh" ]]; then
    # shellcheck source=lib/data/nexus-query.sh
    source "$_LIB_DIR/data/nexus-query.sh"
else
    echo "ERROR: Cannot find nexus-query.sh in $_LIB_DIR" >&2
    exit 1
fi

# Source nexus-permissions for access control
if [[ -f "$_LIB_DIR/data/nexus-permissions.sh" ]]; then
    # shellcheck source=lib/data/nexus-permissions.sh
    source "$_LIB_DIR/data/nexus-permissions.sh"
else
    echo "ERROR: Cannot find nexus-permissions.sh in $_LIB_DIR" >&2
    exit 1
fi

# Source graph-cache for local graph operations
if [[ -f "$_LIB_DIR/tasks/graph-cache.sh" ]]; then
    # shellcheck source=lib/tasks/graph-cache.sh
    source "$_LIB_DIR/tasks/graph-cache.sh"
else
    echo "ERROR: Cannot find graph-cache.sh in $_LIB_DIR" >&2
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

#=== CONFIGURATION ===============================================

# Global cache location
NEXUS_GRAPH_CACHE="${NEXUS_CACHE_DIR:-${NEXUS_HOME:-~/.cleo/nexus}/cache}/global-graph.json"
NEXUS_GRAPH_CHECKSUM="${NEXUS_CACHE_DIR:-${NEXUS_HOME:-~/.cleo/nexus}/cache}/global-graph.checksum"
NEXUS_GRAPH_METADATA="${NEXUS_CACHE_DIR:-${NEXUS_HOME:-~/.cleo/nexus}/cache}/global-graph.metadata.json"

# In-memory global graph cache
declare -g _NEXUS_GLOBAL_GRAPH_CACHE=""
declare -g _NEXUS_GLOBAL_GRAPH_VALID=false

#=== INTERNAL FUNCTIONS ==========================================

#######################################
# Calculate combined checksum of all registered projects
#
# Computes checksum based on all registered project todo.json files.
# Used to detect changes across the global graph.
#
# Arguments:
#   None
#
# Returns:
#   Combined checksum on stdout
#
# Exit Status:
#   0 - Success
#   1 - Registry not initialized
#
# Example:
#   checksum=$(_nexus_graph_calculate_checksum)
#######################################
_nexus_graph_calculate_checksum() {
    local registry_path
    registry_path=$(nexus_get_registry_path)

    if [[ ! -f "$registry_path" ]]; then
        echo ""
        return 0
    fi

    # Get all project paths with read permission
    local paths=()
    while IFS= read -r path; do
        if [[ -f "$path/.cleo/todo.json" ]]; then
            paths+=("$path/.cleo/todo.json")
        fi
    done < <(jq -r '.projects[] | select(.permissions == "read" or .permissions == "write" or .permissions == "execute") | .path' "$registry_path" 2>/dev/null)

    # Compute combined checksum
    if [[ ${#paths[@]} -eq 0 ]]; then
        echo ""
        return 0
    fi

    # Use sha256sum or shasum depending on platform
    if command -v sha256sum &>/dev/null; then
        cat "${paths[@]}" | sha256sum | cut -d' ' -f1
    elif command -v shasum &>/dev/null; then
        cat "${paths[@]}" | shasum -a 256 | cut -d' ' -f1
    else
        # Fallback: concatenate modification times
        local combined=""
        for path in "${paths[@]}"; do
            local mtime
            mtime=$(stat -c "%Y" "$path" 2>/dev/null || stat -f "%m" "$path" 2>/dev/null)
            combined="${combined}${mtime}"
        done
        echo "$combined" | md5sum | cut -d' ' -f1 2>/dev/null || echo "$combined"
    fi
}

#######################################
# Check if global graph cache is stale
#
# Compares stored checksum with current checksum of all registered projects.
#
# Arguments:
#   None
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Cache is stale (needs rebuild)
#   1 - Cache is valid
#
# Example:
#   if _nexus_graph_cache_is_stale; then
#       echo "Rebuilding cache"
#   fi
#######################################
_nexus_graph_cache_is_stale() {
    # No cache directory means stale
    if [[ ! -d "$NEXUS_CACHE_DIR" ]]; then
        return 0  # true = stale
    fi

    # No checksum file means stale
    if [[ ! -f "$NEXUS_GRAPH_CHECKSUM" ]]; then
        return 0
    fi

    # No graph file means stale
    if [[ ! -f "$NEXUS_GRAPH_CACHE" ]]; then
        return 0
    fi

    # Compare checksums
    local stored_checksum current_checksum
    stored_checksum=$(cat "$NEXUS_GRAPH_CHECKSUM" 2>/dev/null)
    current_checksum=$(_nexus_graph_calculate_checksum)

    if [[ "$stored_checksum" != "$current_checksum" ]]; then
        return 0  # stale
    fi

    return 1  # not stale
}

#######################################
# Build global dependency graph across all projects
#
# Creates unified graph with nodes from all registered projects.
# Resolves cross-project dependencies via project:task syntax.
#
# Arguments:
#   None
#
# Returns:
#   JSON graph on stdout: {"nodes":[],"edges":[]}
#
# Exit Status:
#   0 - Success
#   1 - Registry not initialized
#
# Example:
#   graph=$(_nexus_build_global_graph_internal)
#######################################
_nexus_build_global_graph_internal() {
    local registry_path
    registry_path=$(nexus_get_registry_path)

    if [[ ! -f "$registry_path" ]]; then
        echo '{"nodes":[],"edges":[]}'
        return 0
    fi

    # Initialize graph
    local graph='{"nodes":[],"edges":[]}'

    # Get all registered projects with read permission
    local project_hashes
    readarray -t project_hashes < <(jq -r '.projects | keys[]' "$registry_path")

    for hash in "${project_hashes[@]}"; do
        local project_data
        project_data=$(jq -r --arg hash "$hash" '.projects[$hash]' "$registry_path")

        local project_path project_name permissions
        project_path=$(echo "$project_data" | jq -r '.path')
        project_name=$(echo "$project_data" | jq -r '.name')
        permissions=$(echo "$project_data" | jq -r '.permissions // "read"')

        # Skip projects without read permission
        if ! nexus_check_permission "$project_name" "read" 2>/dev/null; then
            continue
        fi

        local todo_file="${project_path}/.cleo/todo.json"
        if [[ ! -f "$todo_file" ]]; then
            continue
        fi

        # Add nodes from this project
        local tasks
        tasks=$(jq -c --arg project "$project_name" \
            '.tasks[] | {id: .id, project: $project, status: .status, title: .title}' \
            "$todo_file" 2>/dev/null || echo "")

        if [[ -n "$tasks" ]]; then
            while IFS= read -r task; do
                graph=$(echo "$graph" | jq --argjson task "$task" '.nodes += [$task]')
            done <<< "$tasks"
        fi

        # Add edges (dependencies)
        local edges
        edges=$(jq -c --arg project "$project_name" \
            '.tasks[] | select(.depends != null and (.depends | length) > 0) |
             {from: .id, fromProject: $project, depends: .depends}' \
            "$todo_file" 2>/dev/null || echo "")

        if [[ -n "$edges" ]]; then
            while IFS= read -r edge; do
                local from from_project
                from=$(echo "$edge" | jq -r '.from')
                from_project=$(echo "$edge" | jq -r '.fromProject')

                # Process each dependency
                local deps_array
                deps_array=$(echo "$edge" | jq -c '.depends')

                local dep_count
                dep_count=$(echo "$deps_array" | jq 'length')

                for ((i=0; i<dep_count; i++)); do
                    local dep
                    dep=$(echo "$deps_array" | jq -r ".[$i]")

                    # Parse dependency (may be cross-project)
                    local to to_project
                    if [[ "$dep" =~ ^([a-z0-9_-]+):(.+)$ ]]; then
                        # Cross-project: project:task
                        to_project="${BASH_REMATCH[1]}"
                        to="${BASH_REMATCH[2]}"
                    else
                        # Same project
                        to="$dep"
                        to_project="$from_project"
                    fi

                    # Add edge
                    graph=$(echo "$graph" | jq --arg from "$from" \
                        --arg fromProject "$from_project" \
                        --arg to "$to" \
                        --arg toProject "$to_project" \
                        '.edges += [{from: $from, fromProject: $fromProject, to: $to, toProject: $toProject}]')
                done
            done <<< "$edges"
        fi
    done

    echo "$graph"
}

#######################################
# Write global graph cache files
#
# Builds and writes global graph cache with metadata.
#
# Arguments:
#   None
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Success
#   1 - Failed to write cache
#
# Example:
#   _nexus_write_graph_cache
#######################################
_nexus_write_graph_cache() {
    # Create cache directory
    mkdir -p "$NEXUS_CACHE_DIR"

    # Build global graph
    local graph
    graph=$(_nexus_build_global_graph_internal)

    # Write graph
    echo "$graph" > "$NEXUS_GRAPH_CACHE"

    # Write checksum
    _nexus_graph_calculate_checksum > "$NEXUS_GRAPH_CHECKSUM"

    # Write metadata
    local node_count edge_count
    node_count=$(echo "$graph" | jq '.nodes | length')
    edge_count=$(echo "$graph" | jq '.edges | length')

    jq -n \
        --arg version "${VERSION:-unknown}" \
        --arg createdAt "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        --argjson nodeCount "$node_count" \
        --argjson edgeCount "$edge_count" \
        '{
            version: $version,
            createdAt: $createdAt,
            nodeCount: $nodeCount,
            edgeCount: $edgeCount,
            cacheType: "nexus-global-graph"
        }' > "$NEXUS_GRAPH_METADATA"

    return 0
}

#######################################
# Ensure global graph cache is initialized and valid
#
# Rebuilds cache if stale, otherwise loads from disk.
#
# Arguments:
#   None
#
# Returns:
#   Nothing on stdout
#
# Exit Status:
#   0 - Success
#   1 - Failed to initialize cache
#
# Example:
#   _nexus_ensure_graph_cache
#######################################
_nexus_ensure_graph_cache() {
    # Fast path: already loaded and valid
    if [[ "$_NEXUS_GLOBAL_GRAPH_VALID" == "true" && -n "$_NEXUS_GLOBAL_GRAPH_CACHE" ]]; then
        return 0
    fi

    # Check if cache is stale
    if _nexus_graph_cache_is_stale; then
        _nexus_write_graph_cache || return 1
    fi

    # Load into memory
    if [[ -f "$NEXUS_GRAPH_CACHE" ]]; then
        _NEXUS_GLOBAL_GRAPH_CACHE=$(cat "$NEXUS_GRAPH_CACHE")
        _NEXUS_GLOBAL_GRAPH_VALID=true
    else
        echo "ERROR: Failed to load global graph cache" >&2
        return 1
    fi

    return 0
}

#=== PUBLIC API ==================================================

#######################################
# Show dependencies for a task across projects
#
# Resolves cross-project dependencies and enriches with metadata.
# Supports both forward and reverse dependency lookups.
#
# Arguments:
#   $1 - Task query (required): project:task or task (current project)
#   $2 - Direction (optional): --reverse for reverse deps
#
# Returns:
#   JSON object on stdout with enriched dependencies
#
# Exit Status:
#   0 - Success
#   EXIT_NEXUS_INVALID_SYNTAX (73) - Invalid query
#   EXIT_NEXUS_PROJECT_NOT_FOUND (71) - Project not registered
#   EXIT_NOT_FOUND (4) - Task not found
#   EXIT_NEXUS_PERMISSION_DENIED (72) - No read permission
#
# Example:
#   nexus_deps "my-app:T001"
#   nexus_deps "my-app:T001" --reverse
#######################################
nexus_deps() {
    local task_query="${1:-}"
    local direction="${2:-forward}"

    if [[ -z "$task_query" ]]; then
        echo "ERROR: Task query required" >&2
        return 1
    fi

    # Validate query syntax
    if ! nexus_validate_syntax "$task_query"; then
        return "$EXIT_NEXUS_INVALID_SYNTAX"
    fi

    # Parse query to get project name
    local project_name
    project_name=$(nexus_get_project_from_query "$task_query") || return $?

    # Check read permission
    if ! nexus_check_permission "$project_name" "read" 2>/dev/null; then
        nexus_require_permission "$project_name" "read" "query dependencies"
        return $?
    fi

    # Resolve task
    local task
    task=$(nexus_resolve_task "$task_query") || return $?

    local task_id
    task_id=$(echo "$task" | jq -r '.id')

    # Ensure global graph cache
    _nexus_ensure_graph_cache || return 1

    # Build dependency result
    local result="{}"
    result=$(jq -n --arg query "$task_query" --arg project "$project_name" \
        '{task: $query, project: $project, depends: [], blocking: []}')

    if [[ "$direction" == "--reverse" ]]; then
        # Find what depends on this task
        local blocking
        blocking=$(echo "$_NEXUS_GLOBAL_GRAPH_CACHE" | \
            jq -c --arg taskId "$task_id" --arg project "$project_name" \
            '[.edges[] | select(.to == $taskId and .toProject == $project) |
             {query: (.fromProject + ":" + .from), project: .fromProject, task: .from}]')

        # Enrich with task metadata
        local enriched="[]"
        local count
        count=$(echo "$blocking" | jq 'length')
        for ((i=0; i<count; i++)); do
            local item
            item=$(echo "$blocking" | jq -c ".[$i]")
            local dep_query
            dep_query=$(echo "$item" | jq -r '.query')

            # Resolve task for status
            local dep_task
            if dep_task=$(nexus_resolve_task "$dep_query" 2>/dev/null); then
                local status
                status=$(echo "$dep_task" | jq -r '.status')
                item=$(echo "$item" | jq --arg status "$status" '. + {status: $status}')
            fi

            enriched=$(echo "$enriched" | jq --argjson item "$item" '. + [$item]')
        done

        result=$(echo "$result" | jq --argjson blocking "$enriched" '.blocking = $blocking')
    else
        # Get dependencies from task
        local depends
        depends=$(echo "$task" | jq -c '.depends // []')

        # Resolve each dependency
        local resolved="[]"
        local count
        count=$(echo "$depends" | jq 'length')
        for ((i=0; i<count; i++)); do
            local dep
            dep=$(echo "$depends" | jq -r ".[$i]")

            # Build query (add project if not present)
            local dep_query
            if [[ "$dep" =~ : ]]; then
                dep_query="$dep"
            else
                dep_query="${project_name}:${dep}"
            fi

            # Parse query to get project
            local dep_project
            dep_project=$(nexus_get_project_from_query "$dep_query" 2>/dev/null || echo "$project_name")

            # Check permission before resolving
            if ! nexus_check_permission "$dep_project" "read" 2>/dev/null; then
                # Add with permission denied status
                resolved=$(echo "$resolved" | jq --arg query "$dep_query" --arg project "$dep_project" \
                    '. + [{query: $query, project: $project, status: "permission_denied"}]')
                continue
            fi

            # Resolve task
            local dep_task
            if dep_task=$(nexus_resolve_task "$dep_query" 2>/dev/null); then
                local status
                status=$(echo "$dep_task" | jq -r '.status')
                resolved=$(echo "$resolved" | jq --arg query "$dep_query" --arg project "$dep_project" --arg status "$status" \
                    '. + [{query: $query, project: $project, status: $status}]')
            else
                # Task not found
                resolved=$(echo "$resolved" | jq --arg query "$dep_query" --arg project "$dep_project" \
                    '. + [{query: $query, project: $project, status: "not_found"}]')
            fi
        done

        result=$(echo "$result" | jq --argjson depends "$resolved" '.depends = $depends')
    fi

    echo "$result"
    return 0
}

#######################################
# Resolve array of dependencies (local or cross-project)
#
# Takes an array of dependency strings and resolves each to full task metadata.
# Used internally by other nexus-deps functions.
#
# Arguments:
#   $1 - JSON array of dependencies (required)
#   $2 - Source project name (required, for context)
#
# Returns:
#   JSON array on stdout with enriched dependency objects
#
# Exit Status:
#   0 - Success (returns array even if some deps fail to resolve)
#
# Example:
#   deps='["T002","other-project:T015"]'
#   nexus_resolve_cross_deps "$deps" "my-project"
#######################################
nexus_resolve_cross_deps() {
    local deps_array="${1:-[]}"
    local source_project="${2:-}"

    if [[ -z "$source_project" ]]; then
        echo "ERROR: Source project required" >&2
        return 1
    fi

    local resolved="[]"
    local count
    count=$(echo "$deps_array" | jq 'length')

    for ((i=0; i<count; i++)); do
        local dep
        dep=$(echo "$deps_array" | jq -r ".[$i]")

        # Parse dependency (may be cross-project)
        local dep_project dep_task
        if [[ "$dep" =~ ^([a-z0-9_-]+):(.+)$ ]]; then
            dep_project="${BASH_REMATCH[1]}"
            dep_task="${BASH_REMATCH[2]}"
        else
            dep_project="$source_project"
            dep_task="$dep"
        fi

        local dep_query="${dep_project}:${dep_task}"

        # Check permission
        if ! nexus_check_permission "$dep_project" "read" 2>/dev/null; then
            resolved=$(echo "$resolved" | jq --arg query "$dep_query" --arg project "$dep_project" \
                '. + [{query: $query, project: $project, status: "permission_denied"}]')
            continue
        fi

        # Resolve task
        local task
        if task=$(nexus_resolve_task "$dep_query" 2>/dev/null); then
            local status title
            status=$(echo "$task" | jq -r '.status')
            title=$(echo "$task" | jq -r '.title')
            resolved=$(echo "$resolved" | jq --arg query "$dep_query" --arg project "$dep_project" \
                --arg status "$status" --arg title "$title" \
                '. + [{query: $query, project: $project, status: $status, title: $title}]')
        else
            resolved=$(echo "$resolved" | jq --arg query "$dep_query" --arg project "$dep_project" \
                '. + [{query: $query, project: $project, status: "not_found"}]')
        fi
    done

    echo "$resolved"
    return 0
}

#######################################
# Build unified dependency graph across all projects
#
# Public wrapper for _nexus_build_global_graph_internal with caching.
#
# Arguments:
#   None
#
# Returns:
#   JSON graph on stdout: {"nodes":[],"edges":[]}
#
# Exit Status:
#   0 - Success
#   1 - Failed to build graph
#
# Example:
#   graph=$(nexus_build_global_graph)
#   node_count=$(echo "$graph" | jq '.nodes | length')
#######################################
nexus_build_global_graph() {
    _nexus_ensure_graph_cache || return 1
    echo "$_NEXUS_GLOBAL_GRAPH_CACHE"
}

#######################################
# Calculate critical path across project boundaries
#
# Finds the longest dependency chain from roots to a task (or all leaves).
# Critical path identifies the minimum time to complete dependencies.
#
# Arguments:
#   $1 - Epic/task query (optional): if provided, filters to this epic
#
# Returns:
#   JSON object on stdout with critical path
#
# Exit Status:
#   0 - Success
#   EXIT_NEXUS_INVALID_SYNTAX (73) - Invalid query
#
# Example:
#   nexus_critical_path
#   nexus_critical_path "my-app:T100"
#######################################
nexus_critical_path() {
    local epic_query="${1:-}"

    # Ensure global graph cache
    _nexus_ensure_graph_cache || return 1

    local graph="$_NEXUS_GLOBAL_GRAPH_CACHE"

    # Filter to epic if provided
    if [[ -n "$epic_query" ]]; then
        if ! nexus_validate_syntax "$epic_query"; then
            return "$EXIT_NEXUS_INVALID_SYNTAX"
        fi

        local project_name task_id
        project_name=$(nexus_get_project_from_query "$epic_query") || return $?
        local parsed
        parsed=$(nexus_parse_query "$epic_query")
        task_id=$(echo "$parsed" | jq -r '.taskId')

        # Filter nodes that are children of this epic
        # For simplicity, include all nodes (full filtering requires parent tracking)
        # This is a placeholder - full implementation would check task.parent field
    fi

    # Find all leaf nodes (no outgoing edges)
    local leaves
    leaves=$(echo "$graph" | jq -c '[.nodes[] | select(.id as $id |
        ([.edges[] | select(.from == $id)] | length) == 0)]')

    # For each leaf, trace back to roots and calculate path length
    local longest_path="[]"
    local max_length=0

    local leaf_count
    leaf_count=$(echo "$leaves" | jq 'length')

    for ((i=0; i<leaf_count; i++)); do
        local leaf
        leaf=$(echo "$leaves" | jq -c ".[$i]")
        local leaf_id leaf_project
        leaf_id=$(echo "$leaf" | jq -r '.id')
        leaf_project=$(echo "$leaf" | jq -r '.project')

        # BFS to find longest path
        local path="[$leaf]"
        local current_id="$leaf_id"
        local current_project="$leaf_project"
        local visited="[$leaf_id]"

        while true; do
            # Find dependencies (incoming edges)
            local deps
            deps=$(echo "$graph" | jq -c --arg id "$current_id" --arg project "$current_project" \
                '[.edges[] | select(.from == $id and .fromProject == $project)]')

            local dep_count
            dep_count=$(echo "$deps" | jq 'length')

            if [[ "$dep_count" -eq 0 ]]; then
                # Reached root
                break
            fi

            # Pick first dependency (TODO: handle multiple paths properly)
            local dep
            dep=$(echo "$deps" | jq -c '.[0]')
            local to to_project
            to=$(echo "$dep" | jq -r '.to')
            to_project=$(echo "$dep" | jq -r '.toProject')

            # Check if already visited (cycle detection)
            if echo "$visited" | jq -e --arg id "$to" 'any(. == $id)' >/dev/null 2>&1; then
                break
            fi

            # Find node
            local node
            node=$(echo "$graph" | jq -c --arg id "$to" --arg project "$to_project" \
                '.nodes[] | select(.id == $id and .project == $project)')

            if [[ -z "$node" ]]; then
                break
            fi

            # Add to path
            path=$(echo "$path" | jq --argjson node "$node" '. + [$node]')
            visited=$(echo "$visited" | jq --arg id "$to" '. + [$id]')

            current_id="$to"
            current_project="$to_project"
        done

        # Check if this is the longest path
        local path_length
        path_length=$(echo "$path" | jq 'length')

        if [[ "$path_length" -gt "$max_length" ]]; then
            max_length="$path_length"
            longest_path="$path"
        fi
    done

    # Reverse path (root to leaf)
    longest_path=$(echo "$longest_path" | jq '[reverse | .[] | {query: (.project + ":" + .id), title: .title}]')

    # Find blocker (first pending task in path)
    local blocker=""
    local blocker_count
    blocker_count=$(echo "$longest_path" | jq 'length')
    for ((i=0; i<blocker_count; i++)); do
        local item
        item=$(echo "$longest_path" | jq -c ".[$i]")
        local query
        query=$(echo "$item" | jq -r '.query')

        local task
        if task=$(nexus_resolve_task "$query" 2>/dev/null); then
            local status
            status=$(echo "$task" | jq -r '.status')
            if [[ "$status" == "pending" || "$status" == "blocked" ]]; then
                blocker="$query"
                break
            fi
        fi
    done

    # Build result
    jq -n \
        --argjson path "$longest_path" \
        --argjson length "$max_length" \
        --arg blockedBy "$blocker" \
        '{criticalPath: $path, length: $length, blockedBy: $blockedBy}'

    return 0
}

#######################################
# Find what a task blocks across all projects
#
# Analyzes impact of a task by finding all dependents (direct and transitive).
#
# Arguments:
#   $1 - Task query (required): project:task or task
#
# Returns:
#   JSON object on stdout with blocking analysis
#
# Exit Status:
#   0 - Success
#   EXIT_NEXUS_INVALID_SYNTAX (73) - Invalid query
#
# Example:
#   nexus_blocking_analysis "other-app:T015"
#######################################
nexus_blocking_analysis() {
    local task_query="${1:-}"

    if [[ -z "$task_query" ]]; then
        echo "ERROR: Task query required" >&2
        return 1
    fi

    # Validate syntax
    if ! nexus_validate_syntax "$task_query"; then
        return "$EXIT_NEXUS_INVALID_SYNTAX"
    fi

    # Ensure global graph cache
    _nexus_ensure_graph_cache || return 1

    # Parse query
    local parsed
    parsed=$(nexus_parse_query "$task_query") || return $?
    local project task_id
    project=$(echo "$parsed" | jq -r '.project')
    task_id=$(echo "$parsed" | jq -r '.taskId')

    # Find all direct dependents
    local direct_dependents
    direct_dependents=$(echo "$_NEXUS_GLOBAL_GRAPH_CACHE" | \
        jq -c --arg id "$task_id" --arg project "$project" \
        '[.edges[] | select(.to == $id and .toProject == $project) |
         {query: (.fromProject + ":" + .from), project: .fromProject}]')

    # Find transitive dependents (BFS)
    local all_dependents="$direct_dependents"
    local queue="$direct_dependents"
    local visited="[{\"id\":\"$task_id\",\"project\":\"$project\"}]"

    while [[ "$(echo "$queue" | jq 'length')" -gt 0 ]]; do
        local current
        current=$(echo "$queue" | jq -c '.[0]')
        queue=$(echo "$queue" | jq '.[1:]')

        local current_query current_project
        current_query=$(echo "$current" | jq -r '.query')
        current_project=$(echo "$current" | jq -r '.project')

        # Parse current query
        local current_parsed
        current_parsed=$(nexus_parse_query "$current_query" 2>/dev/null) || continue
        local current_id
        current_id=$(echo "$current_parsed" | jq -r '.taskId')

        # Find dependents of current
        local deps
        deps=$(echo "$_NEXUS_GLOBAL_GRAPH_CACHE" | \
            jq -c --arg id "$current_id" --arg project "$current_project" \
            '[.edges[] | select(.to == $id and .toProject == $project) |
             {query: (.fromProject + ":" + .from), project: .fromProject, id: .from}]')

        local dep_count
        dep_count=$(echo "$deps" | jq 'length')

        for ((i=0; i<dep_count; i++)); do
            local dep
            dep=$(echo "$deps" | jq -c ".[$i]")
            local dep_id dep_project
            dep_id=$(echo "$dep" | jq -r '.id')
            dep_project=$(echo "$dep" | jq -r '.project')

            # Check if already visited
            if echo "$visited" | jq -e --arg id "$dep_id" --arg project "$dep_project" \
                'any(.id == $id and .project == $project)' >/dev/null 2>&1; then
                continue
            fi

            # Add to visited and queue
            visited=$(echo "$visited" | jq --arg id "$dep_id" --arg project "$dep_project" \
                '. + [{id: $id, project: $project}]')
            queue=$(echo "$queue" | jq --argjson dep "$dep" '. + [$dep]')
            all_dependents=$(echo "$all_dependents" | jq --argjson dep "$dep" '. + [$dep]')
        done
    done

    # Calculate impact score (number of blocked tasks)
    local impact_score
    impact_score=$(echo "$all_dependents" | jq 'length')

    # Build result
    jq -n \
        --arg task "$task_query" \
        --argjson blocking "$all_dependents" \
        --argjson impactScore "$impact_score" \
        '{task: $task, blocking: $blocking, impactScore: $impactScore}'

    return 0
}

#######################################
# Detect orphaned cross-project dependencies
#
# Finds tasks with broken cross-project references (target not found).
#
# Arguments:
#   None
#
# Returns:
#   JSON array on stdout with orphan details
#
# Exit Status:
#   0 - Success
#
# Example:
#   orphans=$(nexus_orphan_detection)
#   count=$(echo "$orphans" | jq 'length')
#######################################
nexus_orphan_detection() {
    local registry_path
    registry_path=$(nexus_get_registry_path)

    if [[ ! -f "$registry_path" ]]; then
        echo "[]"
        return 0
    fi

    local orphans="[]"

    # Get all registered projects
    local project_hashes
    readarray -t project_hashes < <(jq -r '.projects | keys[]' "$registry_path")

    for hash in "${project_hashes[@]}"; do
        local project_data
        project_data=$(jq -r --arg hash "$hash" '.projects[$hash]' "$registry_path")

        local project_path project_name
        project_path=$(echo "$project_data" | jq -r '.path')
        project_name=$(echo "$project_data" | jq -r '.name')

        local todo_file="${project_path}/.cleo/todo.json"
        if [[ ! -f "$todo_file" ]]; then
            continue
        fi

        # Find all tasks with dependencies
        local tasks_with_deps
        tasks_with_deps=$(jq -c '.tasks[] | select(.depends != null and (.depends | length) > 0) |
            {id: .id, depends: .depends}' "$todo_file" 2>/dev/null || echo "")

        if [[ -z "$tasks_with_deps" ]]; then
            continue
        fi

        while IFS= read -r task; do
            local task_id deps_array
            task_id=$(echo "$task" | jq -r '.id')
            deps_array=$(echo "$task" | jq -c '.depends')

            local dep_count
            dep_count=$(echo "$deps_array" | jq 'length')

            for ((i=0; i<dep_count; i++)); do
                local dep
                dep=$(echo "$deps_array" | jq -r ".[$i]")

                # Check if cross-project dependency
                if [[ "$dep" =~ ^([a-z0-9_-]+):(.+)$ ]]; then
                    local target_project target_task
                    target_project="${BASH_REMATCH[1]}"
                    target_task="${BASH_REMATCH[2]}"

                    # Verify target project exists
                    if ! nexus_project_exists "$target_project" 2>/dev/null; then
                        orphans=$(echo "$orphans" | jq --arg sourceProject "$project_name" \
                            --arg sourceTask "$task_id" \
                            --arg targetProject "$target_project" \
                            --arg targetTask "$target_task" \
                            --arg reason "project_not_registered" \
                            '. + [{sourceProject: $sourceProject, sourceTask: $sourceTask, targetProject: $targetProject, targetTask: $targetTask, reason: $reason}]')
                        continue
                    fi

                    # Verify target task exists
                    local target_query="${target_project}:${target_task}"
                    if ! nexus_resolve_task "$target_query" >/dev/null 2>&1; then
                        orphans=$(echo "$orphans" | jq --arg sourceProject "$project_name" \
                            --arg sourceTask "$task_id" \
                            --arg targetProject "$target_project" \
                            --arg targetTask "$target_task" \
                            --arg reason "task_not_found" \
                            '. + [{sourceProject: $sourceProject, sourceTask: $sourceTask, targetProject: $targetProject, targetTask: $targetTask, reason: $reason}]')
                    fi
                fi
            done
        done <<< "$tasks_with_deps"
    done

    echo "$orphans"
    return 0
}

# Export all public functions
export -f nexus_deps
export -f nexus_resolve_cross_deps
export -f nexus_build_global_graph
export -f nexus_critical_path
export -f nexus_blocking_analysis
export -f nexus_orphan_detection
