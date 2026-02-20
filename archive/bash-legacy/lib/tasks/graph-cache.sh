#!/usr/bin/env bash
# graph-cache.sh - Dependency Graph Caching Library for CLEO
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: cache.sh (for checksum utilities)
# PROVIDES: ensure_graph_cache, get_forward_deps, get_reverse_deps,
#           invalidate_graph_cache, graph_cache_stats
#
# Provides O(1) dependency lookups through pre-computed forward and reverse
# dependency graphs. Replaces O(n^2) iteration with single-pass jq construction.
#
# Performance: 90x improvement for deps command (18s -> <200ms for 789 tasks)

#=== SOURCE GUARD ================================================
[[ -n "${_GRAPH_CACHE_LOADED:-}" ]] && return 0
declare -r _GRAPH_CACHE_LOADED=1

# Get script directory for relative sourcing
GRAPH_CACHE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source cache.sh for checksum utilities
if [[ -f "${GRAPH_CACHE_SCRIPT_DIR}/data/cache.sh" ]]; then
    source "${GRAPH_CACHE_SCRIPT_DIR}/data/cache.sh"
fi

#####################################################################
# Configuration
#####################################################################

# Cache directory and files (use same cache dir as cache.sh)
GRAPH_CACHE_DIR="${CLAUDE_DIR:-.cleo}/.cache"
GRAPH_FORWARD_INDEX="$GRAPH_CACHE_DIR/graph.forward.json"
GRAPH_REVERSE_INDEX="$GRAPH_CACHE_DIR/graph.reverse.json"
GRAPH_CHECKSUM_FILE="$GRAPH_CACHE_DIR/graph.checksum.txt"
GRAPH_METADATA_FILE="$GRAPH_CACHE_DIR/graph.metadata.json"

# In-memory cache (associative arrays)
# Initialize as empty associative arrays for bash 4+
declare -gA _FORWARD_DEPS_CACHE=()
declare -gA _REVERSE_DEPS_CACHE=()
declare -g _GRAPH_CACHE_VALID=false
declare -g _GRAPH_CACHE_INITIALIZED=false
declare -g _GRAPH_CACHE_REBUILT=false

#####################################################################
# Internal Functions
#####################################################################

# Calculate checksum of todo.json for graph cache
_graph_cache_calculate_checksum() {
    local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"
    
    if [[ ! -f "$todo_file" ]]; then
        echo ""
        return
    fi
    
    # Use sha256sum or shasum depending on platform
    if command -v sha256sum &>/dev/null; then
        sha256sum "$todo_file" | cut -d' ' -f1
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$todo_file" | cut -d' ' -f1
    else
        # Fallback: use modification time and size
        stat -c "%Y%s" "$todo_file" 2>/dev/null || stat -f "%m%z" "$todo_file" 2>/dev/null
    fi
}

# Check if graph cache is stale
_graph_cache_is_stale() {
    local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"
    
    # No cache directory means stale
    if [[ ! -d "$GRAPH_CACHE_DIR" ]]; then
        return 0  # true = stale
    fi
    
    # No checksum file means stale
    if [[ ! -f "$GRAPH_CHECKSUM_FILE" ]]; then
        return 0
    fi
    
    # No index files means stale
    if [[ ! -f "$GRAPH_FORWARD_INDEX" ]] || [[ ! -f "$GRAPH_REVERSE_INDEX" ]]; then
        return 0
    fi
    
    # Compare checksums
    local stored_checksum current_checksum
    stored_checksum=$(cat "$GRAPH_CHECKSUM_FILE" 2>/dev/null)
    current_checksum=$(_graph_cache_calculate_checksum "$todo_file")
    
    if [[ "$stored_checksum" != "$current_checksum" ]]; then
        return 0  # stale
    fi
    
    return 1  # not stale
}

# Build forward dependency graph (task -> what it depends on)
# Single-pass jq construction for O(n) performance
_graph_build_forward_index() {
    local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"
    
    jq -c '
        reduce .tasks[] as $task ({};
            if $task.depends != null and ($task.depends | length) > 0 then
                .[$task.id] = $task.depends
            else
                .
            end
        )
    ' "$todo_file"
}

# Build reverse dependency graph (task -> what depends on it)
# Single-pass jq construction for O(n) performance
_graph_build_reverse_index() {
    local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"
    
    jq -c '
        reduce .tasks[] as $task ({};
            if $task.depends != null then
                reduce $task.depends[] as $dep (.;
                    .[$dep] = ((.[$dep] // []) + [$task.id])
                )
            else
                .
            end
        )
    ' "$todo_file"
}

# Write graph cache files
_graph_write_cache_files() {
    local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"
    
    # Create cache directory
    mkdir -p "$GRAPH_CACHE_DIR"
    
    # Build and write indices (single pass each)
    _graph_build_forward_index "$todo_file" > "$GRAPH_FORWARD_INDEX"
    _graph_build_reverse_index "$todo_file" > "$GRAPH_REVERSE_INDEX"
    
    # Write checksum
    _graph_cache_calculate_checksum "$todo_file" > "$GRAPH_CHECKSUM_FILE"
    
    # Get counts for metadata
    local forward_count reverse_count
    forward_count=$(jq 'length' "$GRAPH_FORWARD_INDEX" 2>/dev/null || echo "0")
    reverse_count=$(jq 'length' "$GRAPH_REVERSE_INDEX" 2>/dev/null || echo "0")
    
    # Write metadata
    printf '%s\n' "{
  \"version\": \"${VERSION:-unknown}\",
  \"createdAt\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\",
  \"todoFile\": \"$todo_file\",
  \"forwardEdges\": $forward_count,
  \"reverseEdges\": $reverse_count,
  \"cacheType\": \"dependency-graph\"
}" > "$GRAPH_METADATA_FILE"
}

# Load graph cache into memory
_graph_load_memory() {
    # Clear existing caches
    _FORWARD_DEPS_CACHE=()
    _REVERSE_DEPS_CACHE=()
    
    if [[ -f "$GRAPH_FORWARD_INDEX" ]]; then
        # Load forward dependencies into associative array
        while IFS='=' read -r key value; do
            [[ -n "$key" ]] && _FORWARD_DEPS_CACHE["$key"]="$value"
        done < <(jq -r 'to_entries[] | "\(.key)=\(.value | join(","))"' "$GRAPH_FORWARD_INDEX" 2>/dev/null)
    fi
    
    if [[ -f "$GRAPH_REVERSE_INDEX" ]]; then
        # Load reverse dependencies into associative array
        while IFS='=' read -r key value; do
            [[ -n "$key" ]] && _REVERSE_DEPS_CACHE["$key"]="$value"
        done < <(jq -r 'to_entries[] | "\(.key)=\(.value | join(","))"' "$GRAPH_REVERSE_INDEX" 2>/dev/null)
    fi
    
    _GRAPH_CACHE_VALID=true
}

#####################################################################
# Public API
#####################################################################

# Ensure graph cache is initialized and valid
# Returns: 0 on success (always - both cache hit and rebuild are successes)
# Note: Use was_graph_cache_rebuilt() after calling to check if rebuild occurred
ensure_graph_cache() {
    local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"
    
    # Fast path: already initialized and valid
    if [[ "$_GRAPH_CACHE_INITIALIZED" == "true" && "$_GRAPH_CACHE_VALID" == "true" ]]; then
        _GRAPH_CACHE_REBUILT=false
        return 0
    fi
    
    if _graph_cache_is_stale "$todo_file"; then
        _graph_write_cache_files "$todo_file"
        _graph_load_memory
        _GRAPH_CACHE_REBUILT=true
        _GRAPH_CACHE_INITIALIZED=true
        return 0
    fi
    
    _graph_load_memory
    _GRAPH_CACHE_REBUILT=false
    _GRAPH_CACHE_INITIALIZED=true
    return 0
}

# Check if the last ensure_graph_cache call rebuilt the cache
# Returns: 0 if cache was rebuilt, 1 if cache was valid
was_graph_cache_rebuilt() {
    [[ "${_GRAPH_CACHE_REBUILT:-false}" == "true" ]]
}

# Get forward dependencies for a task (what this task depends on)
# Args: $1 = task ID
# Returns: comma-separated task IDs or empty string
# Complexity: O(1) lookup
get_forward_deps() {
    local task_id="$1"
    
    ensure_graph_cache >/dev/null 2>&1
    
    echo "${_FORWARD_DEPS_CACHE[$task_id]:-}"
}

# Get reverse dependencies for a task (what depends on this task)
# Args: $1 = task ID
# Returns: comma-separated task IDs or empty string
# Complexity: O(1) lookup
get_reverse_deps() {
    local task_id="$1"
    
    ensure_graph_cache >/dev/null 2>&1
    
    echo "${_REVERSE_DEPS_CACHE[$task_id]:-}"
}

# Get forward dependency count for a task
# Args: $1 = task ID
# Returns: count of dependencies
get_forward_dep_count() {
    local task_id="$1"
    local deps
    
    deps=$(get_forward_deps "$task_id")
    if [[ -z "$deps" ]]; then
        echo "0"
    else
        echo "$deps" | tr ',' '\n' | wc -l | tr -d ' '
    fi
}

# Get reverse dependency count for a task
# Args: $1 = task ID
# Returns: count of dependents
get_reverse_dep_count() {
    local task_id="$1"
    local deps
    
    deps=$(get_reverse_deps "$task_id")
    if [[ -z "$deps" ]]; then
        echo "0"
    else
        echo "$deps" | tr ',' '\n' | wc -l | tr -d ' '
    fi
}

# Get the full forward graph as JSON
# Returns: JSON object {task_id: [dependency_ids]}
get_forward_graph_json() {
    ensure_graph_cache >/dev/null 2>&1
    
    if [[ -f "$GRAPH_FORWARD_INDEX" ]]; then
        cat "$GRAPH_FORWARD_INDEX"
    else
        echo "{}"
    fi
}

# Get the full reverse graph as JSON
# Returns: JSON object {task_id: [dependent_ids]}
get_reverse_graph_json() {
    ensure_graph_cache >/dev/null 2>&1
    
    if [[ -f "$GRAPH_REVERSE_INDEX" ]]; then
        cat "$GRAPH_REVERSE_INDEX"
    else
        echo "{}"
    fi
}

# Force cache invalidation and rebuild
invalidate_graph_cache() {
    local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"
    
    _GRAPH_CACHE_VALID=false
    _GRAPH_CACHE_INITIALIZED=false
    
    rm -f "$GRAPH_FORWARD_INDEX" "$GRAPH_REVERSE_INDEX" \
          "$GRAPH_CHECKSUM_FILE" "$GRAPH_METADATA_FILE" 2>/dev/null
    
    ensure_graph_cache "$todo_file"
}

# Get graph cache statistics
graph_cache_stats() {
    ensure_graph_cache >/dev/null 2>&1
    
    local forward_count reverse_count
    forward_count="${#_FORWARD_DEPS_CACHE[@]}"
    reverse_count="${#_REVERSE_DEPS_CACHE[@]}"
    
    local stale_status
    if _graph_cache_is_stale; then
        stale_status="true"
    else
        stale_status="false"
    fi
    
    printf '%s\n' "{
  \"initialized\": $_GRAPH_CACHE_INITIALIZED,
  \"valid\": $_GRAPH_CACHE_VALID,
  \"tasksWithDeps\": $forward_count,
  \"tasksDependedOn\": $reverse_count,
  \"cacheDir\": \"$GRAPH_CACHE_DIR\",
  \"stale\": $stale_status
}"
}

# Check if graph cache exists and is valid
graph_cache_is_valid() {
    [[ -d "$GRAPH_CACHE_DIR" ]] && ! _graph_cache_is_stale
}

# Get all tasks that have dependencies
# Returns: newline-separated task IDs
get_all_tasks_with_deps() {
    ensure_graph_cache >/dev/null 2>&1
    
    printf '%s\n' "${!_FORWARD_DEPS_CACHE[@]}"
}

# Get all tasks that are depended upon
# Returns: newline-separated task IDs
get_all_depended_tasks() {
    ensure_graph_cache >/dev/null 2>&1
    
    printf '%s\n' "${!_REVERSE_DEPS_CACHE[@]}"
}

# Export all public functions
export -f ensure_graph_cache
export -f was_graph_cache_rebuilt
export -f get_forward_deps
export -f get_reverse_deps
export -f get_forward_dep_count
export -f get_reverse_dep_count
export -f get_forward_graph_json
export -f get_reverse_graph_json
export -f invalidate_graph_cache
export -f graph_cache_stats
export -f graph_cache_is_valid
export -f get_all_tasks_with_deps
export -f get_all_depended_tasks
