#!/usr/bin/env bash
# analysis.sh - Task analysis and prioritization algorithms
#
# LAYER: 3 (Domain Logic)
# DEPENDENCIES: file-ops.sh, validation.sh
# PROVIDES: calculate_leverage_scores, identify_bottlenecks, group_by_tiers,
#           get_analysis_summary, suggest_next_task

#=== SOURCE GUARD ================================================
[[ -n "${_ANALYSIS_LOADED:-}" ]] && return 0
declare -r _ANALYSIS_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source required libraries
if [[ -f "$_LIB_DIR/data/file-ops.sh" ]]; then
    # shellcheck source=lib/data/file-ops.sh
    source "$_LIB_DIR/data/file-ops.sh"
fi

if [[ -f "$_LIB_DIR/validation/validation.sh" ]]; then
    # shellcheck source=lib/validation/validation.sh
    source "$_LIB_DIR/validation/validation.sh"
fi

# ============================================================================
# LEVERAGE SCORING
# ============================================================================

#######################################
# Calculate leverage scores for all pending tasks
# Identifies tasks that unlock the most downstream work
# Arguments:
#   $1 - Path to todo.json file
# Outputs:
#   JSON array of tasks sorted by leverage score (descending)
# Returns:
#   0 on success, 1 on error
#######################################
calculate_leverage_scores() {
    local todo_file="$1"

    if [[ ! -f "$todo_file" ]]; then
        echo "ERROR: File not found: $todo_file" >&2
        return 1
    fi

    # Build reverse dependency map and calculate scores
    jq '
        # Build reverse dependency map (task_id -> tasks that depend on it)
        .tasks as $all_tasks |
        (
            reduce $all_tasks[] as $task (
                {};
                if $task.depends then
                    reduce $task.depends[] as $dep (
                        .;
                        .[$dep] += [$task.id]
                    )
                else
                    .
                end
            )
        ) as $reverse_deps |

        # Calculate leverage scores for pending tasks
        [
            .tasks[] |
            select(.status == "pending") |
            {
                id: .id,
                title: .title,
                status: .status,
                priority: .priority,
                phase: .phase,
                unlocks_count: (($reverse_deps[.id] // []) | length),
                unlocks_tasks: ($reverse_deps[.id] // []),
                priority_bonus: (
                    if .priority == "critical" then 40
                    elif .priority == "high" then 30
                    elif .priority == "medium" then 20
                    else 10
                    end
                )
            } |
            .leverage_score = (.unlocks_count * 10) + .priority_bonus
        ] |
        sort_by(-.leverage_score)
    ' "$todo_file"
}

#######################################
# Identify tasks that are blocking others (bottlenecks)
# Arguments:
#   $1 - Path to todo.json file
# Outputs:
#   JSON array of bottleneck objects
# Returns:
#   0 on success, 1 on error
#######################################
identify_bottlenecks() {
    local todo_file="$1"

    if [[ ! -f "$todo_file" ]]; then
        echo "ERROR: File not found: $todo_file" >&2
        return 1
    fi

    # Find tasks with status pending/active that have 2+ tasks depending on them
    jq '
        # Build reverse dependency map
        .tasks as $all_tasks |
        (
            reduce $all_tasks[] as $task (
                {};
                if $task.depends then
                    reduce $task.depends[] as $dep (
                        .;
                        .[$dep] += [$task.id]
                    )
                else
                    .
                end
            )
        ) as $reverse_deps |

        # Find bottleneck tasks
        [
            .tasks[] |
            select(.status == "pending" or .status == "active") |
            select($reverse_deps[.id] and (($reverse_deps[.id] | length) >= 2)) |
            {
                id: .id,
                title: .title,
                status: .status,
                priority: .priority,
                phase: .phase,
                blocks_count: ($reverse_deps[.id] | length),
                blocked_tasks: $reverse_deps[.id]
            }
        ] |
        sort_by(-.blocks_count)
    ' "$todo_file"
}

#######################################
# Group tasks into priority tiers based on dependencies and priority
# Tier 1: Tasks that unblock 3+ others (bottleneck unlockers)
# Tier 2: Critical/high priority with satisfied dependencies
# Tier 3: Medium priority or blocked tasks
# Tier 4: Low priority / backlog
# Arguments:
#   $1 - Path to todo.json file
# Outputs:
#   JSON object with tasks grouped by tier
# Returns:
#   0 on success, 1 on error
#######################################
group_by_tiers() {
    local todo_file="$1"

    if [[ ! -f "$todo_file" ]]; then
        echo "ERROR: File not found: $todo_file" >&2
        return 1
    fi

    jq '
        # Build reverse dependency map
        .tasks as $all_tasks |
        (
            reduce $all_tasks[] as $task (
                {};
                if $task.depends then
                    reduce $task.depends[] as $dep (
                        .;
                        .[$dep] += [$task.id]
                    )
                else
                    .
                end
            )
        ) as $reverse_deps |

        # Build done task set for dependency checking
        ([.tasks[] | select(.status == "done") | .id]) as $done_tasks |

        # Classify each task into a tier
        .tasks | map(
            . as $task |
            if $task.status == "done" then
                {task: $task, tier: 0}  # Tier 0 for completed (filtered out later)
            else
                # Calculate unlocks count
                (($reverse_deps[$task.id] // []) | length) as $unlocks |

                # Check if dependencies are satisfied
                (
                    if $task.depends then
                        all($task.depends[]; . as $dep | $done_tasks | index($dep) != null)
                    else
                        true
                    end
                ) as $deps_satisfied |

                # Tier assignment logic
                if $unlocks >= 3 then
                    {task: $task, tier: 1, reason: "Unblocks \($unlocks) tasks"}
                elif ($task.priority == "critical" or $task.priority == "high") and $deps_satisfied then
                    {task: $task, tier: 2, reason: "High priority with satisfied dependencies"}
                elif $task.status == "blocked" or $task.priority == "medium" then
                    {task: $task, tier: 3, reason: "Medium priority or blocked"}
                else
                    {task: $task, tier: 4, reason: "Low priority / backlog"}
                end
            end
        ) |

        # Group by tier and format output
        group_by(.tier) |
        map({
            tier: (.[0].tier | tostring),
            count: length,
            tasks: [.[] | {
                id: .task.id,
                title: .task.title,
                status: .task.status,
                priority: .task.priority,
                phase: .task.phase,
                reason: .reason
            }]
        }) |

        # Filter out tier 0 (done tasks) and convert to object
        [.[] | select(.tier != "0")] |
        {
            tier_1: (.[] | select(.tier == "1") | .tasks // []),
            tier_2: (.[] | select(.tier == "2") | .tasks // []),
            tier_3: (.[] | select(.tier == "3") | .tasks // []),
            tier_4: (.[] | select(.tier == "4") | .tasks // []),
            summary: {
                tier_1_count: (.[] | select(.tier == "1") | .count // 0),
                tier_2_count: (.[] | select(.tier == "2") | .count // 0),
                tier_3_count: (.[] | select(.tier == "3") | .count // 0),
                tier_4_count: (.[] | select(.tier == "4") | .count // 0)
            }
        }
    ' "$todo_file"
}

#######################################
# Get combined analysis summary
# Combines leverage scores, bottlenecks, and tier grouping
# Arguments:
#   $1 - Path to todo.json file
# Outputs:
#   JSON object with complete analysis
# Returns:
#   0 on success, 1 on error
#######################################
get_analysis_summary() {
    local todo_file="$1"

    if [[ ! -f "$todo_file" ]]; then
        echo "ERROR: File not found: $todo_file" >&2
        return 1
    fi

    # Run all analysis functions and combine results
    local leverage_scores bottlenecks tier_groups

    leverage_scores=$(calculate_leverage_scores "$todo_file") || return 1
    bottlenecks=$(identify_bottlenecks "$todo_file") || return 1
    tier_groups=$(group_by_tiers "$todo_file") || return 1

    # Combine into single JSON object
    jq -nc \
        --argjson leverage "$leverage_scores" \
        --argjson bottlenecks "$bottlenecks" \
        --argjson tiers "$tier_groups" \
        '{
            leverage_scores: $leverage,
            bottlenecks: $bottlenecks,
            tier_groups: $tiers,
            meta: {
                generated_at: (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
                top_leverage_task: ($leverage[0] // null),
                critical_bottleneck: ($bottlenecks[0] // null),
                recommended_next: (
                    if ($tiers.tier_1 | length) > 0 then
                        $tiers.tier_1[0]
                    elif ($tiers.tier_2 | length) > 0 then
                        $tiers.tier_2[0]
                    else
                        null
                    end
                )
            }
        }'
}

# Export functions
export -f calculate_leverage_scores
export -f identify_bottlenecks
export -f group_by_tiers
export -f get_analysis_summary
