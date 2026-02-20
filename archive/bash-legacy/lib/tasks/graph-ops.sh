#!/usr/bin/env bash
# graph-ops.sh - Advanced graph operations for CLEO dependency system
#
# LAYER: 3 (Domain Logic)
# DEPENDENCIES: graph-cache.sh
# PROVIDES: find_critical_path, calculate_impact_radius, calculate_dependency_waves,
#           detect_dependency_cycles, topological_sort
#
# Uses cached graph data from graph-cache.sh for O(1) lookups.
# All functions output JSON to stdout.

#=== SOURCE GUARD ================================================
[[ -n "${_GRAPH_OPS_LOADED:-}" ]] && return 0
declare -r _GRAPH_OPS_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_GRAPH_OPS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source graph-cache.sh for cache access
if [[ -f "$_GRAPH_OPS_LIB_DIR/tasks/graph-cache.sh" ]]; then
    # shellcheck source=lib/tasks/graph-cache.sh
    source "$_GRAPH_OPS_LIB_DIR/tasks/graph-cache.sh"
else
    echo '{"error": "graph-cache.sh not found"}' >&2
    exit 1
fi

# ============================================================================
# INTERNAL HELPER FUNCTIONS
# ============================================================================

# Convert bash array to JSON array string
_array_to_json() {
    local result="["
    local first=true
    local item
    for item in "$@"; do
        [[ "$first" == "true" ]] || result+=","
        first=false
        result+="\"$item\""
    done
    result+="]"
    echo "$result"
}

# Safely get forward dependencies for a task
_safe_get_forward_deps() {
    local task_id="${1:-}"
    [[ -z "$task_id" ]] && return 0
    get_forward_deps "$task_id"
}

# Safely get reverse dependencies for a task
_safe_get_reverse_deps() {
    local task_id="${1:-}"
    [[ -z "$task_id" ]] && return 0
    get_reverse_deps "$task_id"
}

# Get all task IDs that have dependencies
_get_all_graph_tasks() {
    local todo_file="${TODO_FILE:-.cleo/todo.json}"
    ensure_graph_cache "$todo_file" >/dev/null 2>&1 || true
    local -A all_tasks
    local task
    for task in "${!_FORWARD_DEPS_CACHE[@]}"; do
        all_tasks["$task"]=1
    done
    for task in "${!_REVERSE_DEPS_CACHE[@]}"; do
        all_tasks["$task"]=1
    done
    echo "${!all_tasks[*]}"
}

# ============================================================================
# CRITICAL PATH ANALYSIS
# ============================================================================

# Memoization arrays for critical path (declared at module level for recursion)
declare -gA _CP_MEMO_LENGTH
declare -gA _CP_MEMO_PATH

# DFS helper for critical path
# IMPORTANT: All loop variables must be declared local to prevent
# recursion from corrupting outer scope variables
# Uses REVERSE deps (who depends on me) to traverse down the dependency tree
_cp_dfs() {
    local node="${1:-}"
    [[ -z "$node" ]] && return 0

    if [[ -v "_CP_MEMO_LENGTH[$node]" ]]; then
        return 0
    fi

    # Use reverse deps to find tasks that depend on this one
    local reverse_deps
    reverse_deps=$(_safe_get_reverse_deps "$node")

    if [[ -z "$reverse_deps" ]]; then
        # Leaf node (no one depends on this task)
        _CP_MEMO_LENGTH["$node"]=1
        _CP_MEMO_PATH["$node"]="$node"
        return 0
    fi

    local max_length=0
    local max_path="$node"

    # CRITICAL: Use local array and local loop variable
    local -a deps_array
    local dep
    local dep_length
    IFS=',' read -ra deps_array <<< "$reverse_deps"

    for dep in "${deps_array[@]}"; do
        _cp_dfs "$dep"

        dep_length=1
        if [[ -v "_CP_MEMO_LENGTH[$dep]" ]]; then
            dep_length="${_CP_MEMO_LENGTH[$dep]}"
        fi

        if (( dep_length > max_length )); then
            max_length=$dep_length
            if [[ -v "_CP_MEMO_PATH[$dep]" ]]; then
                max_path="$node,${_CP_MEMO_PATH[$dep]}"
            else
                max_path="$node,$dep"
            fi
        fi
    done

    _CP_MEMO_LENGTH["$node"]=$((max_length + 1))
    _CP_MEMO_PATH["$node"]="$max_path"
}

# Find the longest dependency chain from a task (critical path)
find_critical_path() {
    local start_task="${1:-}"
    
    if [[ -z "$start_task" ]]; then
        echo '{"error": "Task ID required"}'
        return 1
    fi
    
    ensure_graph_cache >/dev/null 2>&1 || true
    
    # Clear memoization
    _CP_MEMO_LENGTH=()
    _CP_MEMO_PATH=()
    
    _cp_dfs "$start_task"
    
    local path="$start_task"
    if [[ -v "_CP_MEMO_PATH[$start_task]" ]]; then
        path="${_CP_MEMO_PATH[$start_task]}"
    fi
    
    # Convert path to JSON array
    local -a path_array
    IFS=',' read -ra path_array <<< "$path"
    _array_to_json "${path_array[@]}"
}

# ============================================================================
# IMPACT ANALYSIS
# ============================================================================

# Calculate the impact radius of a task
calculate_impact_radius() {
    local task_id="${1:-}"
    local max_depth="${2:-10}"
    
    if [[ -z "$task_id" ]]; then
        echo '{"error": "Task ID required"}'
        return 1
    fi
    
    ensure_graph_cache >/dev/null 2>&1 || true
    
    local -A visited
    local -a queue
    local -a result
    local -a depths
    local current current_depth rev_deps dep
    local -a rev_array
    
    queue=("$task_id")
    depths=(0)
    visited["$task_id"]=1
    
    while [[ ${#queue[@]} -gt 0 ]]; do
        current="${queue[0]}"
        current_depth="${depths[0]}"
        queue=("${queue[@]:1}")
        depths=("${depths[@]:1}")

        if (( current_depth >= max_depth )); then
            continue
        fi

        rev_deps=$(_safe_get_reverse_deps "$current")
        if [[ -n "$rev_deps" ]]; then
            IFS=',' read -ra rev_array <<< "$rev_deps"
            for dep in "${rev_array[@]}"; do
                if [[ ! -v "visited[$dep]" ]]; then
                    visited["$dep"]=1
                    queue+=("$dep")
                    depths+=($((current_depth + 1)))
                    result+=("$dep")
                fi
            done
        fi
    done

    # Check if result array has any elements
    if [[ ! -v result[@] ]] || [[ ${#result[@]} -eq 0 ]]; then
        echo "[]"
    else
        _array_to_json "${result[@]}"
    fi
}

# ============================================================================
# DEPENDENCY WAVES (PARALLEL SCHEDULING)
# ============================================================================

# Calculate dependency waves for parallel execution
calculate_dependency_waves() {
    local root_task="${1:-}"

    ensure_graph_cache >/dev/null 2>&1 || true

    local -A all_tasks
    local -a task_queue
    local current rev_deps dep forward_deps
    local -a rev_array fwd_array
    local has_deps_in_subgraph can_calculate max_dep_wave dep_wave wave
    local task

    # If no root task specified, use all tasks in the graph
    if [[ -z "$root_task" ]]; then
        local all_graph_tasks
        all_graph_tasks=$(_get_all_graph_tasks)

        if [[ -z "$all_graph_tasks" ]]; then
            echo "[]"
            return 0
        fi

        for task in $all_graph_tasks; do
            all_tasks["$task"]=1
        done
    else
        # BFS to find all affected tasks from root
        task_queue=("$root_task")
        all_tasks["$root_task"]=1

        while [[ ${#task_queue[@]} -gt 0 ]]; do
            current="${task_queue[0]}"
            task_queue=("${task_queue[@]:1}")

            rev_deps=$(_safe_get_reverse_deps "$current")
            if [[ -n "$rev_deps" ]]; then
                IFS=',' read -ra rev_array <<< "$rev_deps"
                for dep in "${rev_array[@]}"; do
                    if [[ ! -v "all_tasks[$dep]" ]]; then
                        all_tasks["$dep"]=1
                        task_queue+=("$dep")
                    fi
                done
            fi
        done
    fi
    
    local -A task_wave
    local max_wave=0
    local changed=true
    
    # Initialize waves
    for task in "${!all_tasks[@]}"; do
        forward_deps=$(_safe_get_forward_deps "$task")
        has_deps_in_subgraph=false
        
        if [[ -n "$forward_deps" ]]; then
            IFS=',' read -ra fwd_array <<< "$forward_deps"
            for dep in "${fwd_array[@]}"; do
                if [[ -v "all_tasks[$dep]" ]]; then
                    has_deps_in_subgraph=true
                    break
                fi
            done
        fi
        
        if [[ "$has_deps_in_subgraph" == "false" ]]; then
            task_wave["$task"]=0
        else
            task_wave["$task"]=-1
        fi
    done
    
    # Iteratively calculate waves
    while [[ "$changed" == "true" ]]; do
        changed=false
        
        for task in "${!all_tasks[@]}"; do
            if [[ -v "task_wave[$task]" && "${task_wave[$task]}" != "-1" ]]; then
                continue
            fi
            
            forward_deps=$(_safe_get_forward_deps "$task")
            can_calculate=true
            max_dep_wave=0
            
            if [[ -n "$forward_deps" ]]; then
                IFS=',' read -ra fwd_array <<< "$forward_deps"
                for dep in "${fwd_array[@]}"; do
                    if [[ -v "all_tasks[$dep]" ]]; then
                        dep_wave=-1
                        if [[ -v "task_wave[$dep]" ]]; then
                            dep_wave="${task_wave[$dep]}"
                        fi
                        if [[ "$dep_wave" == "-1" ]]; then
                            can_calculate=false
                            break
                        fi
                        if (( dep_wave > max_dep_wave )); then
                            max_dep_wave=$dep_wave
                        fi
                    fi
                done
            fi
            
            if [[ "$can_calculate" == "true" ]]; then
                task_wave["$task"]=$((max_dep_wave + 1))
                changed=true
                if (( task_wave[$task] > max_wave )); then
                    max_wave=${task_wave[$task]}
                fi
            fi
        done
    done
    
    # Build waves array
    local -a waves
    local i
    for (( i=0; i<=max_wave; i++ )); do
        waves[$i]=""
    done
    
    for task in "${!task_wave[@]}"; do
        if [[ -v "task_wave[$task]" ]]; then
            wave="${task_wave[$task]}"
            if [[ "$wave" != "-1" ]]; then
                if [[ -n "${waves[$wave]:-}" ]]; then
                    waves[$wave]+=","
                fi
                waves[$wave]+="$task"
            fi
        fi
    done
    
    # Convert to JSON
    local json_result="["
    local first_wave=true
    local -a wave_array
    for (( i=0; i<=max_wave; i++ )); do
        [[ "$first_wave" == "true" ]] || json_result+=","
        first_wave=false
        
        if [[ -n "${waves[$i]:-}" ]]; then
            IFS=',' read -ra wave_array <<< "${waves[$i]}"
            json_result+=$(_array_to_json "${wave_array[@]}")
        else
            json_result+="[]"
        fi
    done
    json_result+="]"
    
    echo "$json_result"
}

# ============================================================================
# CYCLE DETECTION
# ============================================================================

# Module-level state for cycle detection
declare -gA _CD_COLOR
declare -ga _CD_CYCLES

# DFS helper for cycle detection
_cd_dfs() {
    local node="${1:-}"
    local path="${2:-}"
    
    [[ -z "$node" ]] && return 0
    
    _CD_COLOR["$node"]=1  # GRAY
    
    local forward_deps
    forward_deps=$(_safe_get_forward_deps "$node")
    if [[ -n "$forward_deps" ]]; then
        local -a fwd_array
        local dep dep_color cycle_start cycle_path in_cycle cycle p existing new_path
        local -a path_arr
        local cycle_found
        
        IFS=',' read -ra fwd_array <<< "$forward_deps"
        for dep in "${fwd_array[@]}"; do
            dep_color=0
            if [[ -v "_CD_COLOR[$dep]" ]]; then
                dep_color="${_CD_COLOR[$dep]}"
            fi
            
            if [[ "$dep_color" == "1" ]]; then
                # Found cycle
                cycle_start="$dep"
                if [[ -n "$path" ]]; then
                    cycle_path="$path,$node,$dep"
                else
                    cycle_path="$node,$dep"
                fi
                
                # Extract cycle portion
                in_cycle=false
                cycle=""
                IFS=',' read -ra path_arr <<< "$cycle_path"
                for p in "${path_arr[@]}"; do
                    if [[ "$p" == "$cycle_start" ]]; then
                        in_cycle=true
                    fi
                    if [[ "$in_cycle" == "true" ]]; then
                        [[ -n "$cycle" ]] && cycle+=","
                        cycle+="$p"
                    fi
                done
                
                # Store cycle (avoid duplicates)
                cycle_found=false
                for existing in "${_CD_CYCLES[@]:-}"; do
                    if [[ "$existing" == "$cycle" ]]; then
                        cycle_found=true
                        break
                    fi
                done
                if [[ "$cycle_found" == "false" && -n "$cycle" ]]; then
                    _CD_CYCLES+=("$cycle")
                fi
                
            elif [[ "$dep_color" == "0" ]]; then
                if [[ -n "$path" ]]; then
                    new_path="$path,$node"
                else
                    new_path="$node"
                fi
                _cd_dfs "$dep" "$new_path"
            fi
        done
    fi
    
    _CD_COLOR["$node"]=2  # BLACK
}

# Detect circular dependencies
detect_dependency_cycles() {
    ensure_graph_cache >/dev/null 2>&1 || true
    
    _CD_COLOR=()
    _CD_CYCLES=()
    
    local all_tasks task
    all_tasks=$(_get_all_graph_tasks)
    
    for task in $all_tasks; do
        _CD_COLOR["$task"]=0
    done
    
    if [[ ${#_CD_COLOR[@]} -eq 0 ]]; then
        echo "[]"
        return 0
    fi
    
    for task in "${!_CD_COLOR[@]}"; do
        if [[ -v "_CD_COLOR[$task]" && "${_CD_COLOR[$task]}" == "0" ]]; then
            _cd_dfs "$task" ""
        fi
    done
    
    # Convert to JSON
    local json_result="["
    local first=true
    local cycle
    local -a cycle_array
    for cycle in "${_CD_CYCLES[@]:-}"; do
        if [[ -n "$cycle" ]]; then
            [[ "$first" == "true" ]] || json_result+=","
            first=false
            IFS=',' read -ra cycle_array <<< "$cycle"
            json_result+=$(_array_to_json "${cycle_array[@]}")
        fi
    done
    json_result+="]"
    
    echo "$json_result"
}

# ============================================================================
# TOPOLOGICAL SORT
# ============================================================================

# Sort tasks respecting dependencies (Kahn's algorithm)
topological_sort() {
    local todo_file="${TODO_FILE:-.cleo/todo.json}"
    ensure_graph_cache "$todo_file" >/dev/null 2>&1 || true

    local -A tasks_to_sort
    local task

    if [[ $# -gt 0 ]]; then
        for task in "$@"; do
            tasks_to_sort["$task"]=1
        done
    else
        local all_tasks
        all_tasks=$(_get_all_graph_tasks)
        if [[ -n "$all_tasks" ]]; then
            for task in $all_tasks; do
                tasks_to_sort["$task"]=1
            done
        fi
    fi

    # Check if we have any tasks to sort (handles both empty arguments and empty graph)
    # Use ${arr[@]+x} pattern for set -u compatibility with empty associative arrays
    if [[ -z "${tasks_to_sort[*]+x}" ]] || [[ ${#tasks_to_sort[@]} -eq 0 ]]; then
        echo "[]"
        return 0
    fi
    
    local -A in_degree
    local forward_deps dep dependent rev_deps current
    local -a fwd_array rev_array queue result

    for task in "${!tasks_to_sort[@]}"; do
        in_degree["$task"]=0
    done
    
    for task in "${!tasks_to_sort[@]}"; do
        forward_deps=$(_safe_get_forward_deps "$task")
        if [[ -n "$forward_deps" ]]; then
            IFS=',' read -ra fwd_array <<< "$forward_deps"
            for dep in "${fwd_array[@]}"; do
                if [[ -v "tasks_to_sort[$dep]" ]]; then
                    in_degree["$task"]=$((${in_degree[$task]} + 1))
                fi
            done
        fi
    done
    
    for task in "${!in_degree[@]}"; do
        if [[ -v "in_degree[$task]" && "${in_degree[$task]}" == "0" ]]; then
            queue+=("$task")
        fi
    done
    
    while [[ ${#queue[@]} -gt 0 ]]; do
        IFS=$'\n' queue=($(sort <<<"${queue[*]}"))
        unset IFS
        
        current="${queue[0]}"
        queue=("${queue[@]:1}")
        result+=("$current")
        
        rev_deps=$(_safe_get_reverse_deps "$current")
        if [[ -n "$rev_deps" ]]; then
            IFS=',' read -ra rev_array <<< "$rev_deps"
            for dependent in "${rev_array[@]}"; do
                if [[ -v "tasks_to_sort[$dependent]" ]]; then
                    in_degree["$dependent"]=$((${in_degree[$dependent]} - 1))
                    if [[ "${in_degree[$dependent]}" == "0" ]]; then
                        queue+=("$dependent")
                    fi
                fi
            done
        fi
    done
    
    if [[ ${#result[@]} -lt ${#tasks_to_sort[@]} ]]; then
        echo '{"error": "Cycle detected - topological sort not possible"}'
        return 1
    fi
    
    _array_to_json "${result[@]}"
}

# ============================================================================
# CONVENIENCE FUNCTIONS
# ============================================================================

# Get all tasks blocking a specific task
get_blocking_tasks() {
    local task_id="${1:-}"
    
    if [[ -z "$task_id" ]]; then
        echo '{"error": "Task ID required"}'
        return 1
    fi
    
    ensure_graph_cache >/dev/null 2>&1 || true
    
    if declare -f get_all_dependencies >/dev/null 2>&1; then
        local all_deps
        all_deps=$(get_all_dependencies "$task_id")
        
        if [[ -n "$all_deps" ]]; then
            local -a deps_array
            IFS=',' read -ra deps_array <<< "$all_deps"
            _array_to_json "${deps_array[@]}"
        else
            echo "[]"
        fi
    else
        # Fallback: manual BFS
        local -A visited
        local -a queue result
        local initial_deps current next_deps dep
        local -a init_array next_array
        
        initial_deps=$(_safe_get_forward_deps "$task_id")
        
        if [[ -n "$initial_deps" ]]; then
            IFS=',' read -ra init_array <<< "$initial_deps"
            for dep in "${init_array[@]}"; do
                queue+=("$dep")
            done
        fi
        
        while [[ ${#queue[@]} -gt 0 ]]; do
            current="${queue[0]}"
            queue=("${queue[@]:1}")
            
            if [[ ! -v "visited[$current]" ]]; then
                visited["$current"]=1
                result+=("$current")
                
                next_deps=$(_safe_get_forward_deps "$current")
                if [[ -n "$next_deps" ]]; then
                    IFS=',' read -ra next_array <<< "$next_deps"
                    for dep in "${next_array[@]}"; do
                        if [[ ! -v "visited[$dep]" ]]; then
                            queue+=("$dep")
                        fi
                    done
                fi
            fi
        done
        
        if [[ ${#result[@]} -eq 0 ]]; then
            echo "[]"
        else
            _array_to_json "${result[@]}"
        fi
    fi
}

# Get dependency depth
get_dependency_depth() {
    local task_id="${1:-}"
    
    if [[ -z "$task_id" ]]; then
        echo "0"
        return 1
    fi
    
    ensure_graph_cache >/dev/null 2>&1 || true
    
    local path count
    path=$(find_critical_path "$task_id")
    count=$(echo "$path" | jq 'length' 2>/dev/null)
    
    echo "${count:-1}"
}

# Check if completing a task would unblock any other tasks
would_unblock() {
    local task_id="${1:-}"
    
    if [[ -z "$task_id" ]]; then
        echo '{"error": "Task ID required"}'
        return 1
    fi
    
    ensure_graph_cache >/dev/null 2>&1 || true
    
    local rev_deps direct_count direct_tasks impact transitive_count
    local -a rev_array
    
    rev_deps=$(_safe_get_reverse_deps "$task_id")
    direct_count=0
    direct_tasks="[]"
    
    if [[ -n "$rev_deps" ]]; then
        IFS=',' read -ra rev_array <<< "$rev_deps"
        direct_count=${#rev_array[@]}
        direct_tasks=$(_array_to_json "${rev_array[@]}")
    fi
    
    impact=$(calculate_impact_radius "$task_id" 10)
    transitive_count=$(echo "$impact" | jq 'length' 2>/dev/null || echo "0")
    
    jq -n \
        --arg taskId "$task_id" \
        --argjson directCount "$direct_count" \
        --argjson directTasks "$direct_tasks" \
        --argjson transitiveCount "$transitive_count" \
        --argjson transitiveImpact "$impact" \
        '{
            taskId: $taskId,
            wouldUnblock: ($directCount > 0),
            directDependents: $directTasks,
            directCount: $directCount,
            transitiveImpact: $transitiveImpact,
            transitiveCount: $transitiveCount
        }'
}

# ============================================================================
# ALIASES FOR BACKWARDS COMPATIBILITY
# ============================================================================

# Alias for backwards compatibility with tests
topological_sort_graph() {
    topological_sort "$@"
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f find_critical_path
export -f calculate_impact_radius
export -f calculate_dependency_waves
export -f detect_dependency_cycles
export -f topological_sort
export -f topological_sort_graph
export -f get_blocking_tasks
export -f get_dependency_depth
export -f would_unblock
