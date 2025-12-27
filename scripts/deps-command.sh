#!/usr/bin/env bash
# deps-command.sh - Dependency visualization for Claude Todo System
#
# Visualizes task dependencies to help understand task relationships:
# - Shows which tasks depend on what (upstream dependencies)
# - Shows which tasks are blocked by a task (downstream dependents)
# - Provides tree visualization of dependency chains
# - Supports multiple output formats (text, json, markdown)
#
# Usage:
#   deps-command.sh [TASK_ID] [OPTIONS]
#
# Options:
#   TASK_ID               Show dependencies for specific task
#   tree                  Show full dependency tree visualization
#   --format FORMAT       Output format: text | json | markdown (default: text)
#   --help               Show this help message
#
# Examples:
#   deps-command.sh              # Overview of all dependencies
#   deps-command.sh T001         # Dependencies for specific task
#   deps-command.sh tree         # ASCII tree visualization
#   deps-command.sh --format json # JSON output

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

# shellcheck source=../lib/file-ops.sh
source "${LIB_DIR}/file-ops.sh"

# shellcheck source=../lib/output-format.sh
source "${LIB_DIR}/output-format.sh"

# shellcheck source=../lib/logging.sh
source "${LIB_DIR}/logging.sh"

# Source exit codes and error-json libraries if available
if [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  source "$LIB_DIR/exit-codes.sh"
fi
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  source "$LIB_DIR/error-json.sh"
fi

# Default configuration
FORMAT=""
TASK_ID=""
SHOW_TREE=false
COMMAND_NAME="deps"
QUIET=false

# File paths
CLEO_DIR=".cleo"
TODO_FILE="${CLEO_DIR}/todo.json"

#####################################################################
# Helper Functions
#####################################################################

usage() {
    cat << EOF
Usage: cleo deps [TASK_ID|tree] [OPTIONS]

Visualize task dependency relationships.

Arguments:
    TASK_ID               Show dependencies for specific task (e.g., T001)
    tree                  Show full dependency tree visualization

Options:
    -f, --format FORMAT   Output format: text | json | markdown (default: auto)
    --human               Force text output (human-readable)
    --json                Force JSON output (machine-readable)
    -q, --quiet           Suppress informational messages
    -h, --help            Show this help message

Format Auto-Detection:
    When no format is specified, output format is automatically detected:
    - Interactive terminal (TTY): human-readable text format
    - Pipe/redirect/agent context: machine-readable JSON format

Examples:
    cleo deps                  # Overview of all dependencies
    cleo deps T001             # Dependencies for task T001
    cleo deps tree             # ASCII tree visualization
    cleo deps --format json    # JSON output for scripting

Output Modes:
    Overview: Shows all tasks with dependencies and their dependency counts
    Specific Task: Shows upstream dependencies and downstream dependents
    Tree: ASCII tree showing full dependency hierarchy
EOF
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
get_dependent_tasks() {
    local task_id="$1"

    if [[ ! -f "$TODO_FILE" ]]; then
        echo "[]"
        return
    fi

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
build_dependency_graph() {
    if [[ ! -f "$TODO_FILE" ]]; then
        echo "{}"
        return
    fi

    jq -c 'reduce .tasks[] as $task ({};
        if $task.depends != null and ($task.depends | length) > 0 then
            .[$task.id] = $task.depends
        else
            .
        end
    )' "$TODO_FILE" 2>/dev/null || echo "{}"
}

# Detect circular dependencies
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

    # Build reverse graph (dependents)
    local reverse_graph="{}"
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

    # Generate output based on mode
    case "$mode" in
        overview)
            local tasks_with_deps
            tasks_with_deps=$(get_tasks_with_deps)
            local current_timestamp
            current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

            jq -n --argjson tasks "$tasks_with_deps" \
                --argjson graph "$graph" \
                --argjson reverse "$reverse_graph" \
                --arg timestamp "$current_timestamp" \
                --arg version "$VERSION" '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": "deps overview",
                    "timestamp": $timestamp
                },
                "success": true,
                "mode": "overview",
                "task_count": ($tasks | length),
                "dependency_graph": $graph,
                "dependent_graph": $reverse,
                "tasks": $tasks
            }'
            ;;
        task)
            local deps
            deps=$(get_task_dependencies "$task_id")
            local dependents
            dependents=$(get_dependent_tasks "$task_id")
            local current_timestamp
            current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

            jq -n --arg id "$task_id" \
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
            # Includes: summary, nodes with task info, and flat graphs
            jq --argjson graph "$graph" \
                --argjson reverse "$reverse_graph" \
                --arg timestamp "$current_timestamp" \
                --arg version "$VERSION" '
            # Build task lookup from tasks array
            (.tasks | map({(.id): {id, title, status, type: (.type // "task")}}) | add) as $lookup |

            # Get all node IDs from graphs (use keys not keys[])
            (($graph | keys) + ($reverse | keys) | unique) as $node_ids |

            # Root nodes: appear in reverse (have dependents) but not in graph (no dependencies)
            ([($reverse | keys)[] | select(. as $id | ($graph | has($id) | not) or (($graph[$id] // []) | length == 0))]) as $roots |

            # Leaf nodes: appear in graph (have dependencies) but not in reverse (no dependents)
            ([($graph | keys)[] | select(. as $id | ($reverse | has($id) | not) or (($reverse[$id] // []) | length == 0))]) as $leaves |

            # Build nodes array with metadata
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
# Argument Parsing
#####################################################################

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -f|--format)
                FORMAT="$2"
                shift 2
                ;;
            --human)
                FORMAT="text"
                shift
                ;;
            --json)
                FORMAT="json"
                shift
                ;;
            -q|--quiet)
                QUIET=true
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            tree)
                SHOW_TREE=true
                shift
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
}

#####################################################################
# Main Execution
#####################################################################

main() {
    parse_arguments "$@"

    # Resolve format with TTY-aware detection
    FORMAT=$(resolve_format "$FORMAT" "true" "text,json,markdown")

    # Check if in a todo-enabled project
    if [[ ! -d "$CLEO_DIR" ]]; then
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

    # Determine mode and output
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
                echo "\`\`\`"
                output_tree_text
                echo "\`\`\`"
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
