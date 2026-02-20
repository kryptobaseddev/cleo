#!/usr/bin/env bash
###CLEO
# command: deps
# category: read
# synopsis: Dependency visualization and analysis (tree view, what depends on X)
# relevance: high
# flags: --format,--quiet,--tree
# exits: 0,4,100
# json-output: true
###END
# deps.sh - Dependency visualization for Claude Todo System
#
# Visualizes task dependencies to help understand task relationships:
# - Shows which tasks depend on what (upstream dependencies)
# - Shows which tasks are blocked by a task (downstream dependents)
# - Provides tree visualization of dependency chains
# - Supports multiple output formats (text, json, markdown)
# - Advanced graph operations: critical-path, impact, waves, cycles
#
# Usage:
#   deps.sh [COMMAND|TASK_ID] [OPTIONS]
#
# Commands:
#   (no command)          Overview of all dependencies
#   tree                  Full dependency tree visualization
#   critical-path <ID>    Find longest dependency chain from task
#   impact <ID>           Find all tasks affected by changes to task
#   waves [ID]            Group tasks into parallelizable execution waves
#   cycles                Detect circular dependencies
#
# Options:
#   TASK_ID               Show dependencies for specific task
#   --depth N             Maximum depth for impact analysis (default: 10)
#   --format FORMAT       Output format: text | json | markdown (default: text)
#   --help               Show this help message
#
# Examples:
#   deps.sh              # Overview of all dependencies
#   deps.sh T001         # Dependencies for specific task
#   deps.sh tree         # ASCII tree visualization
#   deps.sh critical-path T001  # Longest chain from T001
#   deps.sh impact T001 --depth 5  # Tasks affected by T001
#   deps.sh waves        # All tasks in execution waves
#   deps.sh cycles       # Detect circular dependencies
#   deps.sh --format json # JSON output

set -euo pipefail

# Source library functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source version from central location
if [[ -f "$CLEO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="unknown"
fi

# shellcheck source=../lib/data/file-ops.sh
source "${LIB_DIR}/data/file-ops.sh"

# shellcheck source=../lib/core/output-format.sh
source "${LIB_DIR}/core/output-format.sh"

# shellcheck source=../lib/core/logging.sh
source "${LIB_DIR}/core/logging.sh"

# Source exit codes and error-json libraries if available
if [[ -f "$LIB_DIR/core/exit-codes.sh" ]]; then
  source "$LIB_DIR/core/exit-codes.sh"
fi
if [[ -f "$LIB_DIR/core/error-json.sh" ]]; then
  source "$LIB_DIR/core/error-json.sh"
fi
if [[ -f "$LIB_DIR/ui/flags.sh" ]]; then
  source "$LIB_DIR/ui/flags.sh"
fi

# Source graph-cache for O(1) dependency lookups (90x performance improvement)
# shellcheck source=../lib/tasks/graph-cache.sh
if [[ -f "$LIB_DIR/tasks/graph-cache.sh" ]]; then
  source "$LIB_DIR/tasks/graph-cache.sh"
fi

# Default configuration
TASK_ID=""
SHOW_TREE=false
COMMAND_NAME="deps"
REBUILD_CACHE=false
SUBCOMMAND=""
IMPACT_DEPTH=10

# File paths
CLAUDE_DIR="${CLAUDE_DIR:-.cleo}"
TODO_FILE="${CLAUDE_DIR}/todo.json"

#####################################################################
# Helper Functions
#####################################################################

usage() {
    cat << 'USAGEEOF'
Usage: cleo deps [COMMAND|TASK_ID] [OPTIONS]

Visualize task dependency relationships and perform graph analysis.

Commands:
    (no command)          Overview of all dependencies
    tree                  Full dependency tree visualization
    critical-path <ID>    Find longest dependency chain from task
    impact <ID>           Find all tasks affected by changes to task
    waves [ID]            Group tasks into parallelizable execution waves
    cycles                Detect circular dependencies

Arguments:
    TASK_ID               Show dependencies for specific task (e.g., T001)

Options:
    -f, --format FORMAT   Output format: text | json | markdown (default: auto)
    --depth N             Maximum depth for impact analysis (default: 10)
    --human               Force text output (human-readable)
    --json                Force JSON output (machine-readable)
    -q, --quiet           Suppress informational messages
    --rebuild-cache       Force rebuild of dependency graph cache
    -h, --help            Show this help message

Format Auto-Detection:
    When no format is specified, output format is automatically detected:
    - Interactive terminal (TTY): human-readable text format
    - Pipe/redirect/agent context: machine-readable JSON format

Examples:
    cleo deps                      # Overview of all dependencies
    cleo deps T001                 # Dependencies for task T001
    cleo deps tree                 # ASCII tree visualization
    cleo deps critical-path T001   # Longest chain from T001
    cleo deps impact T001          # Tasks affected by T001
    cleo deps impact T001 --depth 5  # Limited depth impact
    cleo deps waves                # All tasks grouped by execution wave
    cleo deps waves T001           # Waves scoped to T001 subtree
    cleo deps cycles               # Find circular dependencies
    cleo deps --format json        # JSON output for scripting

Output Modes:
    Overview: Shows all tasks with dependencies and their dependency counts
    Specific Task: Shows upstream dependencies and downstream dependents
    Tree: ASCII tree showing full dependency hierarchy
    Critical Path: JSON array of task IDs in longest chain
    Impact: JSON array of affected task IDs
    Waves: JSON array of arrays (parallel execution groups)
    Cycles: JSON array of cycles (empty if none found)
USAGEEOF
}

# Get task info by ID
get_task_info() {
    local task_id="$1"

    if [[ ! -f "$TODO_FILE" ]]; then
        echo ""
        return 1
    fi

    jq -r --arg id "$task_id" '.tasks[] | select(.id == $id)' "$TODO_FILE" 2>/dev/null || echo ""
}

# Get all tasks with dependencies
get_tasks_with_deps() {
    if [[ ! -f "$TODO_FILE" ]]; then
        echo "[]"
        return
    fi

    jq -c '[.tasks[] | select(.depends != null and (.depends | length) > 0)]' "$TODO_FILE" 2>/dev/null || echo "[]"
}

# Get tasks that depend on a specific task (downstream)
# Uses graph cache for O(1) lookup when available
get_dependent_tasks() {
    local task_id="$1"

    if [[ ! -f "$TODO_FILE" ]]; then
        echo "[]"
        return
    fi

    # Use graph cache if available (O(1) lookup)
    if declare -f get_reverse_deps &>/dev/null; then
        local cached_deps
        cached_deps=$(get_reverse_deps "$task_id")
        if [[ -z "$cached_deps" ]]; then
            echo "[]"
            return
        fi
        # Convert comma-separated IDs to JSON array of task objects
        # shellcheck disable=SC2016
        jq -c --arg ids "$cached_deps" '
            ($ids | split(",")) as $id_list |
            [.tasks[] | select(.id as $tid | $id_list | index($tid))]
        ' "$TODO_FILE" 2>/dev/null || echo "[]"
        return
    fi

    # Fallback to O(n) jq scan
    jq -c --arg id "$task_id" '[.tasks[] | select(.depends != null and (.depends | index($id)))]' "$TODO_FILE" 2>/dev/null || echo "[]"
}

# Get all dependencies for a task (upstream)
get_task_dependencies() {
    local task_id="$1"

    local task_info
    task_info=$(get_task_info "$task_id")

    if [[ -z "$task_info" ]]; then
        echo "[]"
        return
    fi

    echo "$task_info" | jq -c '.depends // []' 2>/dev/null || echo "[]"
}

# Build dependency graph (adjacency list)
# Uses graph cache for O(1) lookup when available
build_dependency_graph() {
    if [[ ! -f "$TODO_FILE" ]]; then
        echo "{}"
        return
    fi

    # Use graph cache if available (returns pre-computed graph)
    if declare -f get_forward_graph_json &>/dev/null; then
        get_forward_graph_json
        return
    fi

    # Fallback to O(n) jq construction
    jq -c 'reduce .tasks[] as $task ({};
        if $task.depends != null and ($task.depends | length) > 0 then
            .[$task.id] = $task.depends
        else
            .
        end
    )' "$TODO_FILE" 2>/dev/null || echo "{}"
}

# Detect circular dependencies (legacy implementation)
detect_circular_deps() {
    local visited="$1"
    local current_path="$2"
    local task_id="$3"
    local graph="$4"

    # Check if already in current path (cycle detected)
    if echo "$current_path" | jq -e --arg id "$task_id" 'index($id) != null' >/dev/null 2>&1; then
        echo "true"
        return
    fi

    # Check if already visited
    if echo "$visited" | jq -e --arg id "$task_id" 'index($id) != null' >/dev/null 2>&1; then
        echo "false"
        return
    fi

    # Get dependencies
    local deps
    deps=$(echo "$graph" | jq -c --arg id "$task_id" '.[$id] // []')

    # If no dependencies, no cycle
    if [[ "$deps" == "[]" ]]; then
        echo "false"
        return
    fi

    # Add to path
    local new_path
    new_path=$(echo "$current_path" | jq -c --arg id "$task_id" '. + [$id]')

    # Check each dependency
    local has_cycle="false"
    while read -r dep_id; do
        [[ -z "$dep_id" ]] && continue

        local cycle_result
        cycle_result=$(detect_circular_deps "$visited" "$new_path" "$dep_id" "$graph")

        if [[ "$cycle_result" == "true" ]]; then
            has_cycle="true"
            break
        fi
    done < <(echo "$deps" | jq -r '.[]')

    echo "$has_cycle"
}

#####################################################################
# Output Formatters
#####################################################################

output_overview_text() {
    local tasks_with_deps="$1"

    # Detect Unicode support
    local unicode_enabled
    if detect_unicode_support 2>/dev/null; then
        unicode_enabled=true
    else
        unicode_enabled=false
    fi

    local ICON_DEPS ICON_UPSTREAM ICON_DOWNSTREAM
    if [[ "$unicode_enabled" == true ]]; then
        ICON_DEPS="🔗"
        ICON_UPSTREAM="⬆️"
        ICON_DOWNSTREAM="⬇️"
    else
        ICON_DEPS="[DEPS]"
        ICON_UPSTREAM="[UP]"
        ICON_DOWNSTREAM="[DOWN]"
    fi

    echo "================================================"
    echo "$ICON_DEPS TASK DEPENDENCIES OVERVIEW"
    echo "================================================"
    echo ""

    local total_with_deps
    total_with_deps=$(echo "$tasks_with_deps" | jq 'length')

    if [[ "$total_with_deps" -eq 0 ]]; then
        echo "No tasks with dependencies found."
        echo ""
        echo "Use 'cleo add --depends T001,T002' to create dependencies."
        return
    fi

    echo "Tasks with dependencies: $total_with_deps"
    echo ""

    # List each task with its dependencies
    while read -r task; do
        [[ -z "$task" ]] && continue

        local task_id
        task_id=$(echo "$task" | jq -r '.id')
        local title
        title=$(echo "$task" | jq -r '.title')
        local status
        status=$(echo "$task" | jq -r '.status')
        local deps
        deps=$(echo "$task" | jq -r '.depends[]' | tr '\n' ' ')
        local dep_count
        dep_count=$(echo "$task" | jq '.depends | length')

        # Get dependent tasks (tasks that depend on this one)
        local dependents
        dependents=$(get_dependent_tasks "$task_id")
        local dependent_count
        dependent_count=$(echo "$dependents" | jq 'length')

        # Status symbol
        local status_sym
        status_sym=$(status_symbol "$status" "$unicode_enabled")

        echo "[$task_id] $status_sym $title"
        echo "  $ICON_UPSTREAM Dependencies ($dep_count): $deps"

        if [[ "$dependent_count" -gt 0 ]]; then
            local dependent_ids
            dependent_ids=$(echo "$dependents" | jq -r '.[].id' | tr '\n' ' ')
            echo "  $ICON_DOWNSTREAM Blocks ($dependent_count): $dependent_ids"
        fi

        echo ""
    done < <(echo "$tasks_with_deps" | jq -c '.[]')

    echo "================================================"
}

output_task_deps_text() {
    local task_id="$1"

    # Detect Unicode support
    local unicode_enabled
    if detect_unicode_support 2>/dev/null; then
        unicode_enabled=true
    else
        unicode_enabled=false
    fi

    local ICON_DEPS ICON_UPSTREAM ICON_DOWNSTREAM
    if [[ "$unicode_enabled" == true ]]; then
        ICON_DEPS="🔗"
        ICON_UPSTREAM="⬆️"
        ICON_DOWNSTREAM="⬇️"
    else
        ICON_DEPS="[DEPS]"
        ICON_UPSTREAM="[UP]"
        ICON_DOWNSTREAM="[DOWN]"
    fi

    # Get task info
    local task_info
    task_info=$(get_task_info "$task_id")

    if [[ -z "$task_info" ]]; then
        if declare -f output_error &>/dev/null; then
            output_error "$E_TASK_NOT_FOUND" "Task not found: $task_id"
        else
            echo "[ERROR] Task not found: $task_id" >&2
        fi
        exit "${EXIT_NOT_FOUND:-1}"
    fi

    local title
    title=$(echo "$task_info" | jq -r '.title')
    local status
    status=$(echo "$task_info" | jq -r '.status')

    echo "================================================"
    echo "$ICON_DEPS DEPENDENCIES FOR $task_id"
    echo "================================================"
    echo ""
    echo "Task: $title"
    echo "Status: $status"
    echo ""

    # Upstream dependencies (what this task depends on)
    echo "$ICON_UPSTREAM UPSTREAM DEPENDENCIES (must complete before $task_id)"
    echo "----------------"

    local deps
    deps=$(get_task_dependencies "$task_id")
    local dep_count
    dep_count=$(echo "$deps" | jq 'length')

    if [[ "$dep_count" -eq 0 ]]; then
        echo "  None - this task has no dependencies"
    else
        while read -r dep_id; do
            [[ -z "$dep_id" ]] && continue

            local dep_info
            dep_info=$(get_task_info "$dep_id")

            if [[ -n "$dep_info" ]]; then
                local dep_title
                dep_title=$(echo "$dep_info" | jq -r '.title')
                local dep_status
                dep_status=$(echo "$dep_info" | jq -r '.status')
                local status_sym
                status_sym=$(status_symbol "$dep_status" "$unicode_enabled")

                echo "  $status_sym [$dep_id] $dep_title ($dep_status)"
            else
                echo "  ? [$dep_id] (task not found)"
            fi
        done < <(echo "$deps" | jq -r '.[]')
    fi

    echo ""

    # Downstream dependents (tasks that depend on this one)
    echo "$ICON_DOWNSTREAM DOWNSTREAM DEPENDENTS (blocked by $task_id)"
    echo "----------------"

    local dependents
    dependents=$(get_dependent_tasks "$task_id")
    local dependent_count
    dependent_count=$(echo "$dependents" | jq 'length')

    if [[ "$dependent_count" -eq 0 ]]; then
        echo "  None - no tasks depend on this one"
    else
        while read -r dependent; do
            [[ -z "$dependent" ]] && continue

            local dependent_id
            dependent_id=$(echo "$dependent" | jq -r '.id')
            local dependent_title
            dependent_title=$(echo "$dependent" | jq -r '.title')
            local dependent_status
            dependent_status=$(echo "$dependent" | jq -r '.status')
            local status_sym
            status_sym=$(status_symbol "$dependent_status" "$unicode_enabled")

            echo "  $status_sym [$dependent_id] $dependent_title ($dependent_status)"
        done < <(echo "$dependents" | jq -c '.[]')
    fi

    echo ""
    echo "================================================"
}

output_tree_text() {
    # Detect Unicode support
    local unicode_enabled
    if detect_unicode_support 2>/dev/null; then
        unicode_enabled=true
    else
        unicode_enabled=false
    fi

    local TREE_BRANCH TREE_LAST TREE_VERT TREE_SPACE
    if [[ "$unicode_enabled" == true ]]; then
        TREE_BRANCH="├──"
        TREE_LAST="└──"
        TREE_VERT="│"
        TREE_SPACE="    "
    else
        TREE_BRANCH="|--"
        TREE_LAST="+--"
        TREE_VERT="|"
        TREE_SPACE="   "
    fi

    echo "DEPENDENCY TREE"
    if [[ "$unicode_enabled" == true ]]; then
        echo "───────────────"
    else
        echo "---------------"
    fi
    echo ""

    # Build dependency graph
    local graph
    graph=$(build_dependency_graph)

    if [[ "$graph" == "{}" ]]; then
        echo "No dependencies found."
        return
    fi

    # Get all tasks
    local all_tasks
    all_tasks=$(jq -c '.tasks[]' "$TODO_FILE" 2>/dev/null)

    # Find root tasks (no dependencies or dependencies are done)
    local printed_tasks=()

    # Helper function to print task tree recursively
    print_task_tree() {
        local task_id="$1"
        local prefix="$2"
        local is_last="${3:-false}"

        # Prevent infinite loops
        for printed in "${printed_tasks[@]:-}"; do
            if [[ "$printed" == "$task_id" ]]; then
                return
            fi
        done

        printed_tasks+=("$task_id")

        # Get task info
        local task_info
        task_info=$(get_task_info "$task_id")

        if [[ -z "$task_info" ]]; then
            return
        fi

        local title
        title=$(echo "$task_info" | jq -r '.title')
        local status
        status=$(echo "$task_info" | jq -r '.status')
        local status_sym
        status_sym=$(status_symbol "$status" "$unicode_enabled")

        # Print task
        echo "${prefix}$task_id \"$title\" $status_sym"

        # Get dependent tasks
        local dependents
        dependents=$(get_dependent_tasks "$task_id")
        local dependent_count
        dependent_count=$(echo "$dependents" | jq 'length')

        if [[ "$dependent_count" -gt 0 ]]; then
            local new_prefix
            if [[ "$is_last" == "true" ]]; then
                new_prefix="${prefix}${TREE_SPACE}"
            else
                new_prefix="${prefix}${TREE_VERT}   "
            fi

            local index=0
            while read -r dependent; do
                [[ -z "$dependent" ]] && continue

                local dependent_id
                dependent_id=$(echo "$dependent" | jq -r '.id')

                index=$((index + 1))
                local dep_is_last=false
                [[ "$index" -eq "$dependent_count" ]] && dep_is_last=true

                if [[ "$dep_is_last" == true ]]; then
                    echo "${new_prefix}${TREE_LAST} "
                    print_task_tree "$dependent_id" "${new_prefix}${TREE_SPACE}" true
                else
                    echo "${new_prefix}${TREE_BRANCH} "
                    print_task_tree "$dependent_id" "${new_prefix}${TREE_VERT}   " false
                fi
            done < <(echo "$dependents" | jq -c '.[]')
        fi
    }

    # Find tasks with no dependencies (root tasks)
    local root_tasks
    root_tasks=$(jq -c '[.tasks[] | select(.depends == null or (.depends | length) == 0)]' "$TODO_FILE" 2>/dev/null)

    local root_count
    root_count=$(echo "$root_tasks" | jq 'length')

    if [[ "$root_count" -eq 0 ]]; then
        echo "No root tasks found (all tasks have dependencies)."
        echo "This might indicate circular dependencies."
        return
    fi

    # Print each root task and its tree
    local index=0
    while read -r task; do
        [[ -z "$task" ]] && continue

        local task_id
        task_id=$(echo "$task" | jq -r '.id')

        index=$((index + 1))
        local is_last=false
        [[ "$index" -eq "$root_count" ]] && is_last=true

        print_task_tree "$task_id" "" "$is_last"
    done < <(echo "$root_tasks" | jq -c '.[]')
}

output_json_format() {
    local mode="$1"
    local task_id="${2:-}"

    # Build dependency graph
    local graph
    graph=$(build_dependency_graph)

    # Build reverse graph (dependents) - O(1) with cache
    local reverse_graph
    if declare -f get_reverse_graph_json &>/dev/null; then
        # Use pre-computed reverse graph from cache
        reverse_graph=$(get_reverse_graph_json)
    else
        # Fallback to O(n^2) construction if cache not available
        reverse_graph="{}"
        while read -r task; do
            [[ -z "$task" ]] && continue

            local tid
            tid=$(echo "$task" | jq -r '.id')
            local dependents
            dependents=$(get_dependent_tasks "$tid")

            if [[ "$(echo "$dependents" | jq 'length')" -gt 0 ]]; then
                local dependent_ids
                dependent_ids=$(echo "$dependents" | jq -c '[.[].id]')
                reverse_graph=$(echo "$reverse_graph" | jq -c --arg id "$tid" --argjson deps "$dependent_ids" '.[$id] = $deps')
            fi
        done < <(jq -c '.tasks[]' "$TODO_FILE" 2>/dev/null)
    fi

    # Generate output based on mode
    case "$mode" in
        overview)
            local current_timestamp
            current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

            # Use slurpfile to avoid argument list too long error
            local tmp_graph tmp_reverse
            tmp_graph=$(mktemp)
            tmp_reverse=$(mktemp)
            echo "$graph" > "$tmp_graph"
            echo "$reverse_graph" > "$tmp_reverse"

            jq --slurpfile dep_graph "$tmp_graph" \
               --slurpfile rev_graph "$tmp_reverse" \
               --arg timestamp "$current_timestamp" \
               --arg version "$VERSION" '
            {
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": "deps overview",
                    "timestamp": $timestamp
                },
                "success": true,
                "mode": "overview",
                "task_count": ([.tasks[] | select(.depends != null and (.depends | length) > 0)] | length),
                "dependency_graph": $dep_graph[0],
                "dependent_graph": $rev_graph[0],
                "tasks": [.tasks[] | select(.depends != null and (.depends | length) > 0)]
            }' "$TODO_FILE"

            rm -f "$tmp_graph" "$tmp_reverse"
            ;;
        task)
            local deps
            deps=$(get_task_dependencies "$task_id")
            local dependents
            dependents=$(get_dependent_tasks "$task_id")
            local current_timestamp
            current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

            jq -nc --arg id "$task_id" \
                --argjson deps "$deps" \
                --argjson dependents "$dependents" \
                --arg timestamp "$current_timestamp" \
                --arg version "$VERSION" '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": "deps task",
                    "timestamp": $timestamp
                },
                "success": true,
                "mode": "task",
                "task_id": $id,
                "upstream_dependencies": $deps,
                "downstream_dependents": ($dependents | map(.id))
            }'
            ;;
        tree)
            local current_timestamp
            current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

            # Build enriched tree with task metadata for LLM agents
            jq --argjson graph "$graph" \
                --argjson reverse "$reverse_graph" \
                --arg timestamp "$current_timestamp" \
                --arg version "$VERSION" '
            (.tasks | map({(.id): {id, title, status, type: (.type // "task")}}) | add) as $lookup |
            (($graph | keys) + ($reverse | keys) | unique) as $node_ids |
            ([($reverse | keys)[] | select(. as $id | ($graph | has($id) | not) or (($graph[$id] // []) | length == 0))]) as $roots |
            ([($graph | keys)[] | select(. as $id | ($reverse | has($id) | not) or (($reverse[$id] // []) | length == 0))]) as $leaves |
            ([$node_ids[] as $id | $lookup[$id] // {id: $id, title: "Unknown", status: "unknown", type: "task"}]) as $nodes |
            {
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": "deps tree",
                    "timestamp": $timestamp
                },
                "success": true,
                "mode": "tree",
                "summary": {
                    "totalNodes": ($node_ids | length),
                    "rootCount": ($roots | length),
                    "leafCount": ($leaves | length)
                },
                "rootNodes": $roots,
                "leafNodes": $leaves,
                "nodes": $nodes,
                "dependency_graph": $graph,
                "dependent_graph": $reverse
            }' "$TODO_FILE"
            ;;
    esac
}

#####################################################################
# Graph Operations Output Handlers
#####################################################################

# Output critical path results
output_critical_path() {
    local task_id="$1"
    local current_timestamp
    current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    # Source graph-ops library
    source "${LIB_DIR}/tasks/graph-ops.sh"
    
    local result
    result=$(find_critical_path "$task_id" "$TODO_FILE")
    local exit_code=$?
    
    if [[ $exit_code -ne 0 ]]; then
        # Error case - result contains error JSON
        if [[ "$FORMAT" == "text" ]]; then
            local error_msg
            error_msg=$(echo "$result" | jq -r '.error // "Unknown error"' 2>/dev/null || echo "Unknown error")
            echo "[ERROR] $error_msg" >&2
        else
            echo "$result"
        fi
        return $exit_code
    fi
    
    # Success case
    if [[ "$FORMAT" == "text" ]]; then
        local path_length
        path_length=$(echo "$result" | jq 'length')
        echo "Critical Path from $task_id (length: $path_length)"
        echo "================================================"
        local i=0
        while read -r tid; do
            [[ -z "$tid" ]] && continue
            local task_info
            task_info=$(get_task_info "$tid")
            local title
            title=$(echo "$task_info" | jq -r '.title // "Unknown"')
            local status
            status=$(echo "$task_info" | jq -r '.status // "unknown"')
            echo "  $i. [$tid] $title ($status)"
            i=$((i + 1))
        done < <(echo "$result" | jq -r '.[]')
        echo "================================================"
    else
        jq -nc --argjson path "$result" \
            --arg task_id "$task_id" \
            --arg timestamp "$current_timestamp" \
            --arg version "$VERSION" '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "version": $version,
                "command": "deps critical-path",
                "timestamp": $timestamp
            },
            "success": true,
            "mode": "critical-path",
            "start_task": $task_id,
            "path_length": ($path | length),
            "path": $path
        }'
    fi
}

# Output impact analysis results
output_impact() {
    local task_id="$1"
    local depth="${2:-10}"
    local current_timestamp
    current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    # Source graph-ops library
    source "${LIB_DIR}/tasks/graph-ops.sh"
    
    local result
    result=$(calculate_impact_radius "$task_id" "$depth" "$TODO_FILE")
    local exit_code=$?
    
    if [[ $exit_code -ne 0 ]]; then
        # Error case
        if [[ "$FORMAT" == "text" ]]; then
            local error_msg
            error_msg=$(echo "$result" | jq -r '.error // "Unknown error"' 2>/dev/null || echo "Unknown error")
            echo "[ERROR] $error_msg" >&2
        else
            echo "$result"
        fi
        return $exit_code
    fi
    
    # Success case
    if [[ "$FORMAT" == "text" ]]; then
        local affected_count
        affected_count=$(echo "$result" | jq 'length')
        echo "Impact Analysis for $task_id (depth: $depth)"
        echo "================================================"
        echo "Affected tasks: $affected_count"
        echo ""
        if [[ "$affected_count" -gt 0 ]]; then
            echo "Tasks that would be affected by changes to $task_id:"
            while read -r tid; do
                [[ -z "$tid" ]] && continue
                local task_info
                task_info=$(get_task_info "$tid")
                local title
                title=$(echo "$task_info" | jq -r '.title // "Unknown"')
                local status
                status=$(echo "$task_info" | jq -r '.status // "unknown"')
                echo "  - [$tid] $title ($status)"
            done < <(echo "$result" | jq -r '.[]')
        else
            echo "No downstream tasks depend on $task_id"
        fi
        echo "================================================"
    else
        jq -nc --argjson affected "$result" \
            --arg task_id "$task_id" \
            --argjson depth "$depth" \
            --arg timestamp "$current_timestamp" \
            --arg version "$VERSION" '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "version": $version,
                "command": "deps impact",
                "timestamp": $timestamp
            },
            "success": true,
            "mode": "impact",
            "source_task": $task_id,
            "max_depth": $depth,
            "affected_count": ($affected | length),
            "affected_tasks": $affected
        }'
    fi
}

# Output dependency waves results
output_waves() {
    local root_id="${1:-}"
    local current_timestamp
    current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    # Source graph-ops library
    source "${LIB_DIR}/tasks/graph-ops.sh"
    
    local result
    result=$(calculate_dependency_waves "$root_id" "$TODO_FILE")
    local exit_code=$?
    
    if [[ $exit_code -ne 0 ]]; then
        # Error case
        if [[ "$FORMAT" == "text" ]]; then
            local error_msg
            error_msg=$(echo "$result" | jq -r '.error // "Unknown error"' 2>/dev/null || echo "Unknown error")
            echo "[ERROR] $error_msg" >&2
        else
            echo "$result"
        fi
        return $exit_code
    fi
    
    # Success case
    if [[ "$FORMAT" == "text" ]]; then
        local wave_count
        wave_count=$(echo "$result" | jq 'length')
        if [[ -n "$root_id" ]]; then
            echo "Dependency Waves for $root_id subtree"
        else
            echo "Dependency Waves (all tasks)"
        fi
        echo "================================================"
        echo "Total waves: $wave_count"
        echo ""
        if [[ "$wave_count" -gt 0 ]]; then
            local wave_num=0
            while read -r wave; do
                [[ -z "$wave" ]] && continue
                local task_count
                task_count=$(echo "$wave" | jq 'length')
                echo "Wave $wave_num ($task_count tasks):"
                while read -r tid; do
                    [[ -z "$tid" ]] && continue
                    local task_info
                    task_info=$(get_task_info "$tid")
                    local title
                    title=$(echo "$task_info" | jq -r '.title // "Unknown"')
                    echo "  - [$tid] $title"
                done < <(echo "$wave" | jq -r '.[]')
                echo ""
                wave_num=$((wave_num + 1))
            done < <(echo "$result" | jq -c '.[]')
        else
            echo "No waves computed (all tasks may be complete)"
        fi
        echo "================================================"
    else
        jq -nc --argjson waves "$result" \
            --arg root_id "${root_id:-all}" \
            --arg timestamp "$current_timestamp" \
            --arg version "$VERSION" '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "version": $version,
                "command": "deps waves",
                "timestamp": $timestamp
            },
            "success": true,
            "mode": "waves",
            "scope": $root_id,
            "wave_count": ($waves | length),
            "total_tasks": ($waves | flatten | length),
            "waves": $waves
        }'
    fi
}

# Output cycle detection results
output_cycles() {
    local current_timestamp
    current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    # Source graph-ops library
    source "${LIB_DIR}/tasks/graph-ops.sh"
    
    local result
    result=$(detect_dependency_cycles "$TODO_FILE")
    local exit_code=$?
    
    if [[ $exit_code -ne 0 ]]; then
        # Error case
        if [[ "$FORMAT" == "text" ]]; then
            local error_msg
            error_msg=$(echo "$result" | jq -r '.error // "Unknown error"' 2>/dev/null || echo "Unknown error")
            echo "[ERROR] $error_msg" >&2
        else
            echo "$result"
        fi
        return $exit_code
    fi
    
    # Success case
    if [[ "$FORMAT" == "text" ]]; then
        local cycle_count
        cycle_count=$(echo "$result" | jq 'length')
        echo "Circular Dependency Detection"
        echo "================================================"
        if [[ "$cycle_count" -eq 0 ]]; then
            echo "No circular dependencies detected."
            echo ""
            echo "All dependency chains are acyclic."
        else
            echo "WARNING: $cycle_count circular dependency chain(s) detected!"
            echo ""
            local cycle_num=1
            while read -r cycle; do
                [[ -z "$cycle" ]] && continue
                echo "Cycle $cycle_num:"
                local cycle_str
                cycle_str=$(echo "$cycle" | jq -r 'join(" -> ")')
                echo "  $cycle_str"
                echo ""
                cycle_num=$((cycle_num + 1))
            done < <(echo "$result" | jq -c '.[]')
            echo "Resolve these cycles to enable proper dependency ordering."
        fi
        echo "================================================"
    else
        jq -nc --argjson cycles "$result" \
            --arg timestamp "$current_timestamp" \
            --arg version "$VERSION" '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "version": $version,
                "command": "deps cycles",
                "timestamp": $timestamp
            },
            "success": true,
            "mode": "cycles",
            "has_cycles": (($cycles | length) > 0),
            "cycle_count": ($cycles | length),
            "cycles": $cycles
        }'
    fi
}

#####################################################################
# Argument Parsing
#####################################################################

parse_arguments() {
    # Parse common flags first (--format, --json, --human, --quiet, --help, etc.)
    init_flag_defaults
    parse_common_flags "$@"
    set -- "${REMAINING_ARGS[@]}"

    # Handle help flag
    if [[ "$FLAG_HELP" == true ]]; then
        usage
        exit 0
    fi

    # Parse command-specific flags and subcommands
    while [[ $# -gt 0 ]]; do
        case $1 in
            --rebuild-cache)
                REBUILD_CACHE=true
                shift
                ;;
            tree)
                SHOW_TREE=true
                shift
                ;;
            critical-path)
                SUBCOMMAND="critical-path"
                shift
                # Expect task ID as next argument
                if [[ $# -gt 0 && "$1" =~ ^T[0-9]+ ]]; then
                    TASK_ID="$1"
                    shift
                fi
                ;;
            impact)
                SUBCOMMAND="impact"
                shift
                # Expect task ID as next argument
                if [[ $# -gt 0 && "$1" =~ ^T[0-9]+ ]]; then
                    TASK_ID="$1"
                    shift
                fi
                ;;
            waves)
                SUBCOMMAND="waves"
                shift
                # Optional task ID for scoping
                if [[ $# -gt 0 && "$1" =~ ^T[0-9]+ ]]; then
                    TASK_ID="$1"
                    shift
                fi
                ;;
            cycles)
                SUBCOMMAND="cycles"
                shift
                ;;
            --depth)
                shift
                if [[ $# -gt 0 ]]; then
                    IMPACT_DEPTH="$1"
                    shift
                else
                    echo "[ERROR] --depth requires a numeric argument" >&2
                    exit "${EXIT_INVALID_INPUT:-2}"
                fi
                ;;
            T[0-9]*)
                TASK_ID="$1"
                shift
                ;;
            *)
                if declare -f output_error &>/dev/null; then
                    output_error "$E_INPUT_INVALID" "Unknown argument: $1"
                else
                    echo "[ERROR] Unknown argument: $1" >&2
                    echo "Run 'cleo deps --help' for usage"
                fi
                exit "${EXIT_USAGE_ERROR:-64}"
                ;;
        esac
    done

    # Apply common flags to globals
    apply_flags_to_globals
}

#####################################################################
# Main Execution
#####################################################################

main() {
    parse_arguments "$@"

    # Resolve format with TTY-aware detection
    FORMAT=$(resolve_format "$FLAG_FORMAT" "true" "human,text,json,markdown")
    # Normalize "human" to "text" for backward compatibility
    [[ "$FORMAT" == "human" ]] && FORMAT="text"

    # Check if in a todo-enabled project
    if [[ ! -d "$CLAUDE_DIR" ]]; then
        if declare -f output_error &>/dev/null; then
            output_error "$E_NOT_INITIALIZED" "Not in a todo-enabled project"
        else
            echo "[ERROR] Not in a todo-enabled project. Run 'cleo init' first." >&2
        fi
        exit "${EXIT_NOT_INITIALIZED:-3}"
    fi

    # Check if required commands are available
    if ! command -v jq &> /dev/null; then
        if declare -f output_error &>/dev/null; then
            output_error "$E_DEPENDENCY_MISSING" "jq is required but not installed"
        else
            echo "[ERROR] jq is required but not installed." >&2
        fi
        exit "${EXIT_DEPENDENCY_ERROR:-5}"
    fi

    # Initialize graph cache for O(1) dependency lookups
    if declare -f ensure_graph_cache &>/dev/null; then
        if [[ "${REBUILD_CACHE:-false}" == "true" ]]; then
            invalidate_graph_cache "$TODO_FILE"
        else
            ensure_graph_cache "$TODO_FILE"
        fi
    fi

    # Handle graph operation subcommands
    case "$SUBCOMMAND" in
        critical-path)
            if [[ -z "$TASK_ID" ]]; then
                echo "[ERROR] critical-path requires a task ID" >&2
                echo "Usage: cleo deps critical-path <task-id>" >&2
                exit "${EXIT_INVALID_INPUT:-2}"
            fi
            output_critical_path "$TASK_ID"
            exit $?
            ;;
        impact)
            if [[ -z "$TASK_ID" ]]; then
                echo "[ERROR] impact requires a task ID" >&2
                echo "Usage: cleo deps impact <task-id> [--depth N]" >&2
                exit "${EXIT_INVALID_INPUT:-2}"
            fi
            output_impact "$TASK_ID" "$IMPACT_DEPTH"
            exit $?
            ;;
        waves)
            output_waves "$TASK_ID"
            exit $?
            ;;
        cycles)
            output_cycles
            exit $?
            ;;
    esac

    # Determine mode and output for traditional commands
    if [[ "$SHOW_TREE" == true ]]; then
        # Tree mode
        case "$FORMAT" in
            text)
                output_tree_text
                ;;
            json)
                output_json_format "tree"
                ;;
            markdown)
                echo "# Dependency Tree"
                echo ""
                echo '```'
                output_tree_text
                echo '```'
                ;;
        esac
    elif [[ -n "$TASK_ID" ]]; then
        # Specific task mode
        case "$FORMAT" in
            text)
                output_task_deps_text "$TASK_ID"
                ;;
            json)
                output_json_format "task" "$TASK_ID"
                ;;
            markdown)
                echo "# Dependencies for $TASK_ID"
                echo ""
                output_task_deps_text "$TASK_ID"
                ;;
        esac
    else
        # Overview mode
        local tasks_with_deps
        tasks_with_deps=$(get_tasks_with_deps)

        case "$FORMAT" in
            text)
                output_overview_text "$tasks_with_deps"
                ;;
            json)
                output_json_format "overview"
                ;;
            markdown)
                echo "# Task Dependencies Overview"
                echo ""
                output_overview_text "$tasks_with_deps"
                ;;
        esac
    fi
}

# Run main function
main "$@"
