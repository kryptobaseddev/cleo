#!/usr/bin/env bash
# import-sort.sh - Topological sort for import order
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: platform-compat.sh, exit-codes.sh
# PROVIDES: topological_sort_tasks, detect_cycles
#
# PURPOSE: Ensure tasks are imported in dependency order (parents before children)

#=== SOURCE GUARD ================================================
[[ -n "${_IMPORT_SORT_SH_LOADED:-}" ]] && return 0
declare -r _IMPORT_SORT_SH_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

# Determine library directory
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source platform compatibility layer
if [[ -f "$_LIB_DIR/core/platform-compat.sh" ]]; then
    # shellcheck source=lib/core/platform-compat.sh
    source "$_LIB_DIR/core/platform-compat.sh"
else
    echo "ERROR: Cannot find platform-compat.sh in $_LIB_DIR" >&2
    exit 1
fi

# Source exit codes
if [[ -f "$_LIB_DIR/core/exit-codes.sh" ]]; then
    # shellcheck source=lib/core/exit-codes.sh
    source "$_LIB_DIR/core/exit-codes.sh"
else
    echo "ERROR: Cannot find exit-codes.sh in $_LIB_DIR" >&2
    exit 1
fi

# ============================================================================
# TOPOLOGICAL SORT (Kahn's Algorithm)
# ============================================================================

# Topological sort for task import order
#
# Ensures tasks are imported in dependency order where:
# 1. Parents are imported before children (parentId references)
# 2. Dependencies are imported before dependents (depends[] references)
#
# Uses Kahn's Algorithm:
#   1. Build in-degree map (count incoming edges for each task)
#   2. Initialize queue with tasks having in-degree 0
#   3. Process queue, decrementing successors' in-degrees
#   4. Detect cycles if result count != input count
#
# Arguments:
#   $1 - tasks_json: JSON array of tasks from export package
# Outputs:
#   Space-separated task IDs in topological order
# Returns:
#   0 on success
#   EXIT_VALIDATION_ERROR (6) if cycle detected
# Example:
#   order=$(topological_sort_tasks "$(jq '.tasks' export.json)")
#   for task_id in $order; do
#     import_task "$task_id"
#   done
topological_sort_tasks() {
    local tasks_json="$1"

    # Validate input
    if [[ -z "$tasks_json" ]]; then
        echo "ERROR: Empty tasks JSON" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # ========================================================================
    # Build Graph Data Structures
    # ========================================================================

    # Build adjacency lists and in-degree map using jq
    # For each task:
    #   - Calculate in-degree (count of incoming edges from parentId + depends)
    #   - Build lists of children (tasks with this as parentId)
    #   - Build lists of dependents (tasks with this in depends[])
    local graph_data
    graph_data=$(echo "$tasks_json" | jq -c '
        . as $tasks |

        # Create id→index lookup for efficient access
        reduce range(length) as $i ({};
            .[$tasks[$i].id] = $i
        ) as $id_to_idx |

        # Initialize graph nodes with in-degrees
        # Only count edges to tasks within the set (external deps are ignored)
        [.[] | {
            id: .id,
            inDegree: (
                (if .parentId and ($id_to_idx[.parentId] != null) then 1 else 0 end) +
                ([(.depends // [])[] | select($id_to_idx[.] != null)] | length)
            ),
            children: [],
            dependents: []
        }] |

        # Build reverse edges (parent→children, dep→dependents)
        . as $nodes |
        reduce ($tasks | to_entries[]) as $entry ($nodes;
            ($entry.value.id) as $id |
            ($entry.key) as $idx |

            # Add to parent.children list
            if $entry.value.parentId then
                ($id_to_idx[$entry.value.parentId]) as $parent_idx |
                if $parent_idx then
                    .[$parent_idx].children += [$id]
                else . end
            else . end |

            # Add to each dep.dependents list
            reduce ($entry.value.depends // [])[] as $dep (.;
                ($id_to_idx[$dep]) as $dep_idx |
                if $dep_idx then
                    .[$dep_idx].dependents += [$id]
                else . end
            )
        )
    ')

    # ========================================================================
    # Kahn's Algorithm Implementation
    # ========================================================================

    # Initialize queue with zero in-degree nodes
    local queue=()
    while IFS= read -r task_id; do
        [[ -n "$task_id" ]] && queue+=("$task_id")
    done < <(echo "$graph_data" | jq -r '.[] | select(.inDegree == 0) | .id')

    # Process queue
    local result=()

    while [[ ${#queue[@]} -gt 0 ]]; do
        # Dequeue first element
        local current="${queue[0]}"
        queue=("${queue[@]:1}")
        result+=("$current")

        # Get all successors (children + dependents)
        local successors
        successors=$(echo "$graph_data" | jq -r --arg id "$current" '
            .[] | select(.id == $id) | (.children + .dependents)[]
        ' 2>/dev/null || true)

        # For each successor, decrement in-degree
        for successor in $successors; do
            # Decrement in-degree for this successor
            graph_data=$(echo "$graph_data" | jq --arg id "$successor" '
                map(if .id == $id then .inDegree -= 1 else . end)
            ')

            # Check if now zero
            local new_degree
            new_degree=$(echo "$graph_data" | jq -r --arg id "$successor" '
                .[] | select(.id == $id) | .inDegree
            ')

            # Enqueue if zero
            if [[ "$new_degree" == "0" ]]; then
                queue+=("$successor")
            fi
        done
    done

    # ========================================================================
    # Cycle Detection
    # ========================================================================

    local total_tasks
    total_tasks=$(echo "$tasks_json" | jq 'length')

    if [[ ${#result[@]} -ne $total_tasks ]]; then
        echo "ERROR: Cycle detected in task dependencies!" >&2
        echo "  Processed: ${#result[@]} tasks" >&2
        echo "  Total: $total_tasks tasks" >&2

        # Find tasks not processed (stuck in cycle)
        local unprocessed=()
        while IFS= read -r task_id; do
            if ! printf '%s\n' "${result[@]}" | grep -qF "$task_id"; then
                unprocessed+=("$task_id")
            fi
        done < <(echo "$tasks_json" | jq -r '.[].id')

        echo "  Tasks in cycle: ${unprocessed[*]}" >&2

        return "$EXIT_VALIDATION_ERROR"
    fi

    # Success - output topologically sorted IDs
    echo "${result[*]}"
    return 0
}

export -f topological_sort_tasks

# ============================================================================
# CYCLE DETECTION
# ============================================================================

# Detect cycles in task dependency graph
#
# Arguments:
#   $1 - tasks_json: JSON array of tasks
# Returns:
#   0 if no cycles, 1 if cycles detected
detect_cycles() {
    local tasks_json="$1"

    if topological_sort_tasks "$tasks_json" >/dev/null 2>&1; then
        return 0  # No cycles
    else
        return 1  # Cycles detected
    fi
}

export -f detect_cycles

# ============================================================================
# MAIN (for testing)
# ============================================================================

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "Testing topological sort functions..."
    echo "===================================="

    # Test 1: Simple linear dependency chain
    echo ""
    echo "Test 1: Linear dependency chain"
    TASKS_JSON='[
        {"id":"T001","title":"A","parentId":null,"depends":[]},
        {"id":"T002","title":"B","parentId":"T001","depends":[]},
        {"id":"T003","title":"C","parentId":"T002","depends":["T001"]}
    ]'

    ORDER=$(topological_sort_tasks "$TASKS_JSON")
    echo "  Input: T001 (root), T002 (child of T001), T003 (child of T002, depends on T001)"
    echo "  Order: $ORDER"

    # T001 must come before T002 and T003
    # T002 must come before T003
    if [[ "$ORDER" =~ T001.*T002.*T003 ]]; then
        echo "  ✓ Correct order (T001 before T002 before T003)"
    else
        echo "  ✗ Incorrect order"
        exit 1
    fi

    # Test 2: Diamond dependency
    echo ""
    echo "Test 2: Diamond dependency"
    TASKS_JSON='[
        {"id":"T001","title":"Root","parentId":null,"depends":[]},
        {"id":"T002","title":"Left","parentId":"T001","depends":[]},
        {"id":"T003","title":"Right","parentId":"T001","depends":[]},
        {"id":"T004","title":"Bottom","parentId":null,"depends":["T002","T003"]}
    ]'

    ORDER=$(topological_sort_tasks "$TASKS_JSON")
    echo "  Input: Diamond (T001→T002,T003→T004)"
    echo "  Order: $ORDER"

    # T001 before T002 and T003
    # T002 and T003 before T004
    if [[ "$ORDER" =~ T001 ]] && \
       [[ "$ORDER" =~ T001.*T002 ]] && \
       [[ "$ORDER" =~ T001.*T003 ]] && \
       [[ "$ORDER" =~ T002.*T004 ]] && \
       [[ "$ORDER" =~ T003.*T004 ]]; then
        echo "  ✓ Correct diamond order"
    else
        echo "  ✗ Incorrect diamond order"
        exit 1
    fi

    # Test 3: No dependencies (any order valid)
    echo ""
    echo "Test 3: No dependencies (independent tasks)"
    TASKS_JSON='[
        {"id":"T001","title":"A","parentId":null,"depends":[]},
        {"id":"T002","title":"B","parentId":null,"depends":[]},
        {"id":"T003","title":"C","parentId":null,"depends":[]}
    ]'

    ORDER=$(topological_sort_tasks "$TASKS_JSON")
    echo "  Input: Three independent tasks"
    echo "  Order: $ORDER"

    # All tasks should be present
    if [[ "$ORDER" =~ T001 ]] && \
       [[ "$ORDER" =~ T002 ]] && \
       [[ "$ORDER" =~ T003 ]]; then
        echo "  ✓ All tasks present"
    else
        echo "  ✗ Missing tasks"
        exit 1
    fi

    # Test 4: Cycle detection
    echo ""
    echo "Test 4: Cycle detection"
    TASKS_JSON='[
        {"id":"T001","title":"A","parentId":"T002","depends":[]},
        {"id":"T002","title":"B","parentId":"T001","depends":[]}
    ]'

    if topological_sort_tasks "$TASKS_JSON" >/dev/null 2>&1; then
        echo "  ✗ Failed to detect cycle"
        exit 1
    else
        echo "  ✓ Cycle correctly detected"
    fi

    # Test 5: Complex hierarchy with dependencies
    echo ""
    echo "Test 5: Complex hierarchy (epic with tasks and subtasks)"
    TASKS_JSON='[
        {"id":"T001","title":"Epic","type":"epic","parentId":null,"depends":[]},
        {"id":"T002","title":"Task1","type":"task","parentId":"T001","depends":[]},
        {"id":"T003","title":"Task2","type":"task","parentId":"T001","depends":["T002"]},
        {"id":"T004","title":"Subtask1","type":"subtask","parentId":"T002","depends":[]},
        {"id":"T005","title":"Subtask2","type":"subtask","parentId":"T003","depends":["T004"]}
    ]'

    ORDER=$(topological_sort_tasks "$TASKS_JSON")
    echo "  Input: Epic → Task1,Task2 → Subtask1,Subtask2 with cross-dependencies"
    echo "  Order: $ORDER"

    # Verify constraints:
    # - T001 before all
    # - T002 before T003 (dependency)
    # - T002 before T004 (parent)
    # - T003 before T005 (parent)
    # - T004 before T005 (dependency)
    if [[ "$ORDER" =~ T001.*T002 ]] && \
       [[ "$ORDER" =~ T002.*T003 ]] && \
       [[ "$ORDER" =~ T002.*T004 ]] && \
       [[ "$ORDER" =~ T003.*T005 ]] && \
       [[ "$ORDER" =~ T004.*T005 ]]; then
        echo "  ✓ All dependency constraints satisfied"
    else
        echo "  ✗ Dependency constraints violated"
        exit 1
    fi

    # Test 6: detect_cycles function
    echo ""
    echo "Test 6: detect_cycles() helper"

    # No cycles
    TASKS_JSON='[{"id":"T001","parentId":null,"depends":[]},{"id":"T002","parentId":"T001","depends":[]}]'
    if detect_cycles "$TASKS_JSON"; then
        echo "  ✓ Correctly reports no cycles"
    else
        echo "  ✗ False positive for cycles"
        exit 1
    fi

    # Has cycles
    TASKS_JSON='[{"id":"T001","parentId":"T002","depends":[]},{"id":"T002","parentId":"T001","depends":[]}]'
    if detect_cycles "$TASKS_JSON"; then
        echo "  ✗ Failed to detect cycle"
        exit 1
    else
        echo "  ✓ Correctly detected cycle"
    fi

    echo ""
    echo "===================================="
    echo "All tests passed! ✓"
fi
