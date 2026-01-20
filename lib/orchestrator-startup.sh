#!/usr/bin/env bash
# orchestrator-startup.sh - Orchestrator Session Startup Protocol
#
# LAYER: 3 (Domain Logic)
# DEPENDENCIES: exit-codes.sh, config.sh, research-manifest.sh, sessions.sh
# PROVIDES: orchestrator_check_pending, orchestrator_session_init,
#           orchestrator_get_next_task, orchestrator_context_check,
#           orchestrator_get_startup_state, orchestrator_get_ready_tasks
#
# Implements the session startup sequence for the Orchestrator Protocol.
# Ensures consistent bootstrapping across conversations.
#
# Version: 1.0.0 (cleo v0.54.0)
# Spec: docs/specs/ORCHESTRATOR-PROTOCOL-SPEC.md

#=== SOURCE GUARD ================================================
[[ -n "${_ORCHESTRATOR_STARTUP_LOADED:-}" ]] && return 0
declare -r _ORCHESTRATOR_STARTUP_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_OS_LIB_DIR="${BASH_SOURCE[0]%/*}"
[[ "$_OS_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _OS_LIB_DIR="."

# Source dependencies
# shellcheck source=lib/exit-codes.sh
source "${_OS_LIB_DIR}/exit-codes.sh"
# shellcheck source=lib/config.sh
source "${_OS_LIB_DIR}/config.sh"
# shellcheck source=lib/research-manifest.sh
source "${_OS_LIB_DIR}/research-manifest.sh"
# shellcheck source=lib/paths.sh
source "${_OS_LIB_DIR}/paths.sh"

# ============================================================================
# CONFIGURATION
# ============================================================================

# Orchestrator context budget (tokens)
readonly ORCHESTRATOR_CONTEXT_BUDGET=10000

# Context warning threshold (percentage)
readonly ORCHESTRATOR_CONTEXT_WARNING=70

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

# Get todo.json path
_os_get_todo_file() {
    local cleo_dir
    cleo_dir=$(get_cleo_dir)
    echo "${cleo_dir}/todo.json"
}

# Get sessions.json path
_os_get_sessions_file() {
    local cleo_dir
    cleo_dir=$(get_cleo_dir)
    echo "${cleo_dir}/sessions.json"
}

# Get focus.json path
_os_get_focus_file() {
    local cleo_dir
    cleo_dir=$(get_cleo_dir)
    echo "${cleo_dir}/focus.json"
}

# ============================================================================
# PUBLIC API
# ============================================================================

# orchestrator_check_pending - Check for pending work from previous sessions
# Args: none
# Output: JSON with pending items from manifest and CLEO
# Returns: 0 on success
orchestrator_check_pending() {
    local manifest_pending cleo_followup_tasks

    # Get manifest entries with needs_followup
    manifest_pending=$(get_pending_followup 2>/dev/null || echo '{"result":{"entries":[],"count":0}}')

    # Get unique task IDs from manifest followups
    cleo_followup_tasks=$(get_followup_tasks 2>/dev/null || echo '{"result":{"taskIds":[],"count":0}}')

    # Extract counts
    local manifest_count task_count
    manifest_count=$(echo "$manifest_pending" | jq -r '.result.count // 0')
    task_count=$(echo "$cleo_followup_tasks" | jq -r '.result.count // 0')

    # Build response
    jq -n \
        --argjson manifest_pending "$manifest_pending" \
        --argjson followup_tasks "$cleo_followup_tasks" \
        --argjson manifest_count "$manifest_count" \
        --argjson task_count "$task_count" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "check_pending"
            },
            "success": true,
            "result": {
                "hasPending": ($manifest_count > 0 or $task_count > 0),
                "manifestEntries": $manifest_pending.result.entries,
                "manifestCount": $manifest_count,
                "followupTaskIds": $followup_tasks.result.taskIds,
                "followupTaskCount": $task_count
            }
        }'

    return 0
}

# orchestrator_session_init - Resume or start orchestrator session
# Args:
#   $1 - Epic ID to scope session (optional)
# Output: JSON with session state and recommended action
# Returns: 0 on success
orchestrator_session_init() {
    local epic_id="${1:-}"
    local sessions_file focus_file
    sessions_file=$(_os_get_sessions_file)
    focus_file=$(_os_get_focus_file)

    # Check for active sessions
    local active_sessions=0
    local active_session_id=""
    local active_scope=""

    if [[ -f "$sessions_file" ]]; then
        local session_data
        session_data=$(jq -c '[.sessions[] | select(.status == "active")]' "$sessions_file" 2>/dev/null || echo '[]')
        active_sessions=$(echo "$session_data" | jq 'length')
        if [[ "$active_sessions" -gt 0 ]]; then
            active_session_id=$(echo "$session_data" | jq -r '.[0].id // ""')
            active_scope=$(echo "$session_data" | jq -r '.[0].scope.rootId // ""')
        fi
    fi

    # Check for current focus
    local has_focus=false
    local focused_task=""

    if [[ -f "$focus_file" ]]; then
        focused_task=$(jq -r '.focusedTaskId // ""' "$focus_file" 2>/dev/null || echo "")
        [[ -n "$focused_task" ]] && has_focus=true
    fi

    # Check manifest for pending followups
    local pending_result
    pending_result=$(orchestrator_check_pending)
    local has_pending
    has_pending=$(echo "$pending_result" | jq -r '.result.hasPending')

    # Determine recommended action based on decision matrix
    local action reason
    if [[ "$active_sessions" -gt 0 && "$has_focus" == "true" ]]; then
        action="resume"
        reason="Active session with focus - continue focused task"
    elif [[ "$active_sessions" -gt 0 && "$has_focus" == "false" ]]; then
        action="spawn_followup"
        reason="Active session without focus - query manifest and spawn next agent"
    elif [[ "$active_sessions" -eq 0 && "$has_pending" == "true" ]]; then
        action="create_and_spawn"
        reason="No session but manifest has followups - create session and spawn"
    else
        action="request_direction"
        reason="No session, no pending work - await user direction"
    fi

    jq -n \
        --argjson active_sessions "$active_sessions" \
        --arg active_session_id "$active_session_id" \
        --arg active_scope "$active_scope" \
        --argjson has_focus "$has_focus" \
        --arg focused_task "$focused_task" \
        --argjson has_pending "$has_pending" \
        --argjson pending "$pending_result" \
        --arg action "$action" \
        --arg reason "$reason" \
        --arg epic_id "$epic_id" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "session_init"
            },
            "success": true,
            "result": {
                "activeSessions": $active_sessions,
                "activeSessionId": (if $active_session_id != "" then $active_session_id else null end),
                "activeScope": (if $active_scope != "" then $active_scope else null end),
                "hasFocus": $has_focus,
                "focusedTask": (if $focused_task != "" then $focused_task else null end),
                "hasPending": $has_pending,
                "pendingSummary": {
                    "manifestCount": $pending.result.manifestCount,
                    "followupTaskIds": $pending.result.followupTaskIds
                },
                "recommendedAction": $action,
                "actionReason": $reason,
                "requestedEpic": (if $epic_id != "" then $epic_id else null end)
            }
        }'

    return 0
}

# orchestrator_get_next_task - Get next task to spawn agent for
# Args:
#   $1 - Epic ID to filter tasks (required)
# Output: JSON with next ready task and spawn context
# Returns: 0 on success, 4 if no tasks ready
orchestrator_get_next_task() {
    local epic_id="$1"
    local todo_file
    todo_file=$(_os_get_todo_file)

    if [[ ! -f "$todo_file" ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "get_next_task"
            },
            "success": false,
            "error": {
                "code": "E_FILE_NOT_FOUND",
                "message": "Todo file not found. Run: cleo init"
            }
        }'
        return "$EXIT_NOT_FOUND"
    fi

    # Find tasks under epic with satisfied dependencies
    local ready_tasks
    ready_tasks=$(jq --arg epic_id "$epic_id" '
        # Get all task IDs that are done
        (.tasks | map(select(.status == "done")) | map(.id)) as $done_ids |

        # Find tasks under this epic that are pending and have all deps satisfied
        [.tasks[] | select(
            .parentId == $epic_id and
            .status == "pending" and
            (
                (.depends == null) or
                (.depends | length == 0) or
                (.depends | all(. as $dep | $done_ids | any(. == $dep)))
            )
        )] |

        # Sort by priority then position
        sort_by(
            (if .priority == "critical" then 0
             elif .priority == "high" then 1
             elif .priority == "medium" then 2
             else 3 end),
            .position
        )
    ' "$todo_file" 2>/dev/null || echo '[]')

    local count next_task
    count=$(echo "$ready_tasks" | jq 'length')

    if [[ "$count" -eq 0 ]]; then
        jq -n \
            --arg epic_id "$epic_id" \
            '{
                "_meta": {
                    "command": "orchestrator",
                    "operation": "get_next_task"
                },
                "success": true,
                "result": {
                    "hasReadyTask": false,
                    "epicId": $epic_id,
                    "readyCount": 0,
                    "nextTask": null,
                    "reason": "No tasks with satisfied dependencies"
                }
            }'
        return 0
    fi

    next_task=$(echo "$ready_tasks" | jq '.[0]')

    # Check if task has linked research
    local task_id research_check
    task_id=$(echo "$next_task" | jq -r '.id')
    research_check=$(task_has_research "$task_id" 2>/dev/null || echo '{"result":{"hasResearch":false}}')

    jq -n \
        --arg epic_id "$epic_id" \
        --argjson count "$count" \
        --argjson next_task "$next_task" \
        --argjson research "$research_check" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "get_next_task"
            },
            "success": true,
            "result": {
                "hasReadyTask": true,
                "epicId": $epic_id,
                "readyCount": $count,
                "nextTask": {
                    "id": $next_task.id,
                    "title": $next_task.title,
                    "priority": $next_task.priority,
                    "size": $next_task.size,
                    "phase": $next_task.phase,
                    "description": $next_task.description,
                    "depends": ($next_task.depends // [])
                },
                "hasLinkedResearch": $research.result.hasResearch,
                "linkedResearchCount": $research.result.count
            }
        }'

    return 0
}

# orchestrator_get_ready_tasks - Get all tasks ready to spawn (parallel-safe)
# Args:
#   $1 - Epic ID to filter tasks (required)
# Output: JSON array of tasks that can be spawned in parallel
# Returns: 0 on success
orchestrator_get_ready_tasks() {
    local epic_id="$1"
    local todo_file
    todo_file=$(_os_get_todo_file)

    if [[ ! -f "$todo_file" ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "get_ready_tasks"
            },
            "success": false,
            "error": {
                "code": "E_FILE_NOT_FOUND",
                "message": "Todo file not found"
            }
        }'
        return "$EXIT_NOT_FOUND"
    fi

    # Find all tasks with satisfied dependencies that don't depend on each other
    local ready_tasks
    ready_tasks=$(jq --arg epic_id "$epic_id" '
        # Get all task IDs that are done
        (.tasks | map(select(.status == "done")) | map(.id)) as $done_ids |

        # Get all pending tasks under epic with satisfied deps
        [.tasks[] | select(
            .parentId == $epic_id and
            .status == "pending" and
            (
                (.depends == null) or
                (.depends | length == 0) or
                (.depends | all(. as $dep | $done_ids | any(. == $dep)))
            )
        )] |

        # Get IDs of these ready tasks
        (map(.id)) as $ready_ids |

        # Filter to only tasks that dont depend on other ready tasks (parallel-safe)
        [.[] | select(
            (.depends == null) or
            (.depends | all(. as $dep | $ready_ids | all(. != $dep)))
        )] |

        # Sort by priority then position
        sort_by(
            (if .priority == "critical" then 0
             elif .priority == "high" then 1
             elif .priority == "medium" then 2
             else 3 end),
            .position
        ) |

        # Return minimal info for orchestrator
        map({
            id: .id,
            title: .title,
            priority: .priority,
            size: .size,
            phase: .phase
        })
    ' "$todo_file" 2>/dev/null || echo '[]')

    local count
    count=$(echo "$ready_tasks" | jq 'length')

    jq -n \
        --arg epic_id "$epic_id" \
        --argjson count "$count" \
        --argjson tasks "$ready_tasks" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "get_ready_tasks"
            },
            "success": true,
            "result": {
                "epicId": $epic_id,
                "readyCount": $count,
                "parallelSafe": true,
                "tasks": $tasks
            }
        }'

    return 0
}

# orchestrator_context_check - Validate orchestrator context limits
# Args:
#   $1 - Current context usage in tokens (optional, uses estimate if not provided)
# Output: JSON with context status and recommendations
# Returns: 0 if OK, 52 if critical
orchestrator_context_check() {
    local current_tokens="${1:-0}"

    # If not provided, try to get from context state file
    if [[ "$current_tokens" -eq 0 ]]; then
        local context_file
        context_file="$(get_cleo_dir)/.context-state.json"
        if [[ -f "$context_file" ]]; then
            current_tokens=$(jq -r '.usedTokens // 0' "$context_file" 2>/dev/null || echo 0)
        fi
    fi

    local usage_percent status recommendation
    if [[ "$ORCHESTRATOR_CONTEXT_BUDGET" -gt 0 ]]; then
        usage_percent=$(( (current_tokens * 100) / ORCHESTRATOR_CONTEXT_BUDGET ))
    else
        usage_percent=0
    fi

    if [[ "$usage_percent" -ge 90 ]]; then
        status="critical"
        recommendation="STOP - Delegate immediately. Context near limit."
    elif [[ "$usage_percent" -ge "$ORCHESTRATOR_CONTEXT_WARNING" ]]; then
        status="warning"
        recommendation="Delegate current work. Avoid reading large files."
    else
        status="ok"
        recommendation="Context healthy. Continue orchestration."
    fi

    jq -n \
        --argjson current "$current_tokens" \
        --argjson budget "$ORCHESTRATOR_CONTEXT_BUDGET" \
        --argjson percent "$usage_percent" \
        --arg status "$status" \
        --arg recommendation "$recommendation" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "context_check"
            },
            "success": true,
            "result": {
                "currentTokens": $current,
                "budgetTokens": $budget,
                "usagePercent": $percent,
                "status": $status,
                "recommendation": $recommendation
            }
        }'

    [[ "$status" == "critical" ]] && return 52
    return 0
}

# orchestrator_get_startup_state - Get complete startup state in one call
# Args:
#   $1 - Epic ID (optional)
# Output: JSON with all startup information
# Returns: 0 on success
orchestrator_get_startup_state() {
    local epic_id="${1:-}"

    # Get session init state
    local session_state
    session_state=$(orchestrator_session_init "$epic_id")

    # Get context check
    local context_state
    context_state=$(orchestrator_context_check)

    # Get next task if epic provided
    local next_task_state='null'
    local ready_tasks_state='null'
    if [[ -n "$epic_id" ]]; then
        next_task_state=$(orchestrator_get_next_task "$epic_id" 2>/dev/null || echo '{"result":null}')
        ready_tasks_state=$(orchestrator_get_ready_tasks "$epic_id" 2>/dev/null || echo '{"result":{"tasks":[]}}')
    fi

    # Combine into single response
    jq -n \
        --argjson session "$session_state" \
        --argjson context "$context_state" \
        --argjson next_task "$next_task_state" \
        --argjson ready_tasks "$ready_tasks_state" \
        --arg epic_id "$epic_id" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "startup_state"
            },
            "success": true,
            "result": {
                "session": $session.result,
                "context": $context.result,
                "nextTask": (if $next_task != null then $next_task.result else null end),
                "readyTasks": (if $ready_tasks != null then $ready_tasks.result else null end),
                "epic": (if $epic_id != "" then $epic_id else null end)
            }
        }'

    return 0
}

# ============================================================================
# AGENT SPAWNER FUNCTIONS
# ============================================================================

# Template directory
_os_get_templates_dir() {
    local script_dir="${BASH_SOURCE[0]%/*}"
    [[ "$script_dir" == "${BASH_SOURCE[0]}" ]] && script_dir="."
    echo "$(cd "$script_dir/../templates/orchestrator-protocol/subagent-prompts" && pwd)"
}

# Get research output directory
_os_get_research_output_dir() {
    local dir
    dir=$(get_config_value "research.outputDir" "claudedocs/research-outputs" 2>/dev/null || echo "claudedocs/research-outputs")
    echo "$dir"
}

# orchestrator_analyze_dependencies - Build dependency graph and return topological sort
# Args:
#   $1 - Epic ID to analyze
# Output: JSON with dependency waves and spawn order
# Returns: 0 on success
orchestrator_analyze_dependencies() {
    local epic_id="$1"
    local todo_file
    todo_file=$(_os_get_todo_file)

    if [[ ! -f "$todo_file" ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "analyze_dependencies"
            },
            "success": false,
            "error": {
                "code": "E_FILE_NOT_FOUND",
                "message": "Todo file not found"
            }
        }'
        return "$EXIT_NOT_FOUND"
    fi

    # Build dependency graph and compute waves using iterative approach
    local analysis
    analysis=$(jq --arg epic_id "$epic_id" '
        # Get all tasks under epic
        [.tasks[] | select(.parentId == $epic_id)] as $epic_tasks |

        # Get done task IDs
        [.tasks[] | select(.status == "done") | .id] as $done_ids |

        # Build dependency map: task_id -> [dependency_ids]
        ($epic_tasks | map({key: .id, value: (.depends // [])}) | from_entries) as $dep_map |

        # Get task lookup map
        ($epic_tasks | map({key: .id, value: .}) | from_entries) as $task_map |

        # Get epic task IDs for faster lookup
        ($epic_tasks | map(.id)) as $epic_ids |

        # Compute wave using iterative approach
        # Wave 0: tasks with no dependencies within epic
        # Wave N: tasks whose all dependencies are in wave N-1 or earlier
        (reduce range(10) as $iteration (
            {};  # Start with empty wave assignments
            . as $waves |
            reduce ($epic_ids[]) as $tid (
                $waves;
                if .[$tid] != null then
                    .
                else
                    # Get dependencies within epic
                    ($dep_map[$tid] | [.[] | select(. as $d | $epic_ids | any(. == $d))]) as $deps_in_epic |
                    if ($deps_in_epic | length) == 0 then
                        # No deps in epic = wave 0
                        .[$tid] = 0
                    elif ($deps_in_epic | all(. as $d | $waves[$d] != null)) then
                        # All deps have waves assigned = max(dep_waves) + 1
                        .[$tid] = ([$deps_in_epic[] | $waves[.]] | max + 1)
                    else
                        # Some deps not yet assigned
                        .
                    end
                end
            )
        )) as $wave_map |

        # Build tasks with waves
        ($epic_tasks | map({
            id: .id,
            title: .title,
            priority: .priority,
            status: .status,
            depends: (.depends // []),
            wave: ($wave_map[.id] // 0)
        })) as $tasks_with_waves |

        # Group by wave
        ($tasks_with_waves | group_by(.wave) | map({
            wave: .[0].wave,
            tasks: [.[] | {id, title, priority, status, depends}]
        }) | sort_by(.wave)) as $waves |

        # Get ready tasks (pending with all deps done or outside epic)
        [$tasks_with_waves[] | select(
            .status == "pending" and
            ((.depends | length == 0) or (.depends | all(. as $d | $done_ids | any(. == $d) or ($task_map[$d] == null))))
        )] as $ready |

        # Get blocked tasks (pending with unmet deps within epic)
        [$tasks_with_waves[] | select(
            .status == "pending" and
            (.depends | any(. as $d | $task_map[$d] != null and ($done_ids | all(. != $d))))
        )] as $blocked |

        {
            epicId: $epic_id,
            totalTasks: ($epic_tasks | length),
            completedTasks: [$epic_tasks[] | select(.status == "done")] | length,
            pendingTasks: [$epic_tasks[] | select(.status == "pending")] | length,
            activeTasks: [$epic_tasks[] | select(.status == "active")] | length,
            waves: $waves,
            readyToSpawn: ($ready | sort_by(
                (if .priority == "critical" then 0
                 elif .priority == "high" then 1
                 elif .priority == "medium" then 2
                 else 3 end),
                .wave
            ) | map({id, title, priority, wave})),
            blockedTasks: ($blocked | map({id, title, depends, wave}))
        }
    ' "$todo_file" 2>/dev/null)

    if [[ -z "$analysis" || "$analysis" == "null" ]]; then
        jq -n \
            --arg epic_id "$epic_id" \
            '{
                "_meta": {
                    "command": "orchestrator",
                    "operation": "analyze_dependencies"
                },
                "success": false,
                "error": {
                    "code": "E_ANALYSIS_FAILED",
                    "message": ("Failed to analyze dependencies for epic " + $epic_id)
                }
            }'
        return 1
    fi

    jq -n \
        --argjson analysis "$analysis" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "analyze_dependencies"
            },
            "success": true,
            "result": $analysis
        }'

    return 0
}

# orchestrator_get_manifest_summaries - Get key_findings for tasks in dependency chain
# Args:
#   $1 - Task ID (to get context from dependencies)
# Output: JSON with summaries from manifest entries linked to dependency tasks
# Returns: 0 on success
orchestrator_get_manifest_summaries() {
    local task_id="$1"
    local todo_file manifest_path
    todo_file=$(_os_get_todo_file)
    manifest_path=$(_rm_get_manifest_path)

    if [[ ! -f "$todo_file" ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "get_manifest_summaries"
            },
            "success": true,
            "result": {
                "summaries": [],
                "count": 0
            }
        }'
        return 0
    fi

    # Get task dependencies
    local deps
    deps=$(jq -r --arg task_id "$task_id" '
        [.tasks[] | select(.id == $task_id) | .depends // []] | flatten | unique
    ' "$todo_file" 2>/dev/null || echo '[]')

    if [[ ! -f "$manifest_path" ]]; then
        jq -n \
            --argjson deps "$deps" \
            '{
                "_meta": {
                    "command": "orchestrator",
                    "operation": "get_manifest_summaries"
                },
                "success": true,
                "result": {
                    "taskId": "'"$task_id"'",
                    "dependencyTaskIds": $deps,
                    "summaries": [],
                    "count": 0
                }
            }'
        return 0
    fi

    # Get manifest entries linked to dependency tasks
    local summaries
    summaries=$(jq -s --argjson deps "$deps" '
        [.[] | select(
            .linked_tasks as $lt |
            ($lt != null) and ($deps | any(. as $d | $lt | any(. == $d)))
        ) | {
            taskId: (.linked_tasks | map(select(. as $t | $deps | any(. == $t))) | .[0]),
            researchId: .id,
            title: .title,
            key_findings: .key_findings
        }]
    ' "$manifest_path" 2>/dev/null || echo '[]')

    local count
    count=$(echo "$summaries" | jq 'length')

    jq -n \
        --arg task_id "$task_id" \
        --argjson deps "$deps" \
        --argjson summaries "$summaries" \
        --argjson count "$count" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "get_manifest_summaries"
            },
            "success": true,
            "result": {
                "taskId": $task_id,
                "dependencyTaskIds": $deps,
                "summaries": $summaries,
                "count": $count
            }
        }'

    return 0
}

# orchestrator_build_prompt - Generate agent prompt from template + context
# Args:
#   $1 - Task ID
#   $2 - Template name (default: TASK-EXECUTOR)
# Output: JSON with complete prompt ready for spawning
# Returns: 0 on success, 4 if task/template not found
orchestrator_build_prompt() {
    local task_id="$1"
    local template_name="${2:-TASK-EXECUTOR}"
    local todo_file template_dir template_path
    todo_file=$(_os_get_todo_file)
    template_dir=$(_os_get_templates_dir)
    template_path="${template_dir}/${template_name}.md"

    # Verify task exists
    if [[ ! -f "$todo_file" ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "build_prompt"
            },
            "success": false,
            "error": {
                "code": "E_FILE_NOT_FOUND",
                "message": "Todo file not found"
            }
        }'
        return "$EXIT_NOT_FOUND"
    fi

    # Get task details
    local task
    task=$(jq --arg task_id "$task_id" '.tasks[] | select(.id == $task_id)' "$todo_file" 2>/dev/null)

    if [[ -z "$task" || "$task" == "null" ]]; then
        jq -n \
            --arg task_id "$task_id" \
            '{
                "_meta": {
                    "command": "orchestrator",
                    "operation": "build_prompt"
                },
                "success": false,
                "error": {
                    "code": "E_NOT_FOUND",
                    "message": ("Task " + $task_id + " not found")
                }
            }'
        return "$EXIT_NOT_FOUND"
    fi

    # Verify template exists
    if [[ ! -f "$template_path" ]]; then
        jq -n \
            --arg template "$template_name" \
            --arg path "$template_path" \
            '{
                "_meta": {
                    "command": "orchestrator",
                    "operation": "build_prompt"
                },
                "success": false,
                "error": {
                    "code": "E_TEMPLATE_NOT_FOUND",
                    "message": ("Template " + $template + " not found at " + $path)
                }
            }'
        return "$EXIT_NOT_FOUND"
    fi

    # Read template
    local template_content
    template_content=$(cat "$template_path")

    # Get epic details
    local parent_id epic_title
    parent_id=$(echo "$task" | jq -r '.parentId // ""')
    if [[ -n "$parent_id" ]]; then
        epic_title=$(jq -r --arg pid "$parent_id" '.tasks[] | select(.id == $pid) | .title // "Unknown Epic"' "$todo_file" 2>/dev/null)
    else
        epic_title="No Epic"
    fi

    # Get manifest summaries for dependencies
    local manifest_result summaries_text
    manifest_result=$(orchestrator_get_manifest_summaries "$task_id")
    summaries_text=$(echo "$manifest_result" | jq -r '
        if .result.count == 0 then
            "No prior research available."
        else
            [.result.summaries[] |
                "- " + .taskId + " (" + .title + "):\n" +
                ([.key_findings[] | "  * " + .] | join("\n"))
            ] | join("\n\n")
        end
    ')

    # Get session info
    local session_id
    session_id=$(cat "$(get_cleo_dir)/.current-session" 2>/dev/null || echo "no-session")

    # Prepare variables for substitution
    local date_today output_dir topic_slug
    date_today=$(date +%Y-%m-%d)
    output_dir=$(_os_get_research_output_dir)
    topic_slug=$(echo "$task" | jq -r '.title | gsub("[^a-zA-Z0-9]+"; "-") | ascii_downcase | ltrimstr("-") | rtrimstr("-")')

    # Get task fields
    local task_title task_description task_depends
    task_title=$(echo "$task" | jq -r '.title')
    task_description=$(echo "$task" | jq -r '.description // "No description provided"')
    task_depends=$(echo "$task" | jq -r '(.depends // []) | if length == 0 then "None" else join(", ") end')

    # Build substitution map and apply
    local prompt_content="$template_content"
    prompt_content="${prompt_content//\{TASK_ID\}/$task_id}"
    prompt_content="${prompt_content//\{TASK_NAME\}/$topic_slug}"
    prompt_content="${prompt_content//\{TASK_TITLE\}/$task_title}"
    prompt_content="${prompt_content//\{EPIC_ID\}/$parent_id}"
    prompt_content="${prompt_content//\{EPIC_TITLE\}/$epic_title}"
    prompt_content="${prompt_content//\{SESSION_ID\}/$session_id}"
    prompt_content="${prompt_content//\{DATE\}/$date_today}"
    prompt_content="${prompt_content//\{OUTPUT_DIR\}/$output_dir}"
    prompt_content="${prompt_content//\{TOPIC_SLUG\}/$topic_slug}"
    prompt_content="${prompt_content//\{DEPENDS_LIST\}/$task_depends}"
    prompt_content="${prompt_content//\{MANIFEST_SUMMARIES\}/$summaries_text}"
    prompt_content="${prompt_content//\{TASK_INSTRUCTIONS\}/$task_description}"

    # Provide empty defaults for optional placeholders
    prompt_content="${prompt_content//\{DELIVERABLES_LIST\}/See task description}"
    prompt_content="${prompt_content//\{ACCEPTANCE_CRITERIA\}/Task completion via cleo complete}"
    prompt_content="${prompt_content//\{DESCRIPTIVE_TITLE\}/$task_title}"
    prompt_content="${prompt_content//\{TOPICS_JSON\}/[\"$(echo "$topic_slug" | tr '-' '\n' | head -3 | tr '\n' ',' | sed 's/,$//' | sed 's/,/\",\"/g')\"]}"
    prompt_content="${prompt_content//\{KEY_FINDINGS_JSON\}/[]}"
    prompt_content="${prompt_content//\{ACTIONABLE\}/true}"
    prompt_content="${prompt_content//\{NEEDS_FOLLOWUP_JSON\}/[]}"

    # Output result
    jq -n \
        --arg task_id "$task_id" \
        --arg template "$template_name" \
        --arg prompt "$prompt_content" \
        --arg topic_slug "$topic_slug" \
        --arg date "$date_today" \
        --arg output_dir "$output_dir" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "build_prompt"
            },
            "success": true,
            "result": {
                "taskId": $task_id,
                "template": $template,
                "topicSlug": $topic_slug,
                "date": $date,
                "outputDir": $output_dir,
                "outputFile": ($date + "_" + $topic_slug + ".md"),
                "prompt": $prompt
            }
        }'

    return 0
}

# orchestrator_spawn - Generate spawn command for task
# Args:
#   $1 - Task ID
#   $2 - Template name (default: TASK-EXECUTOR)
# Output: JSON with spawn command and metadata
# Returns: 0 on success
orchestrator_spawn() {
    local task_id="$1"
    local template_name="${2:-TASK-EXECUTOR}"

    # Build the prompt first
    local prompt_result
    prompt_result=$(orchestrator_build_prompt "$task_id" "$template_name")

    local success
    success=$(echo "$prompt_result" | jq -r '.success')

    if [[ "$success" != "true" ]]; then
        # Return the error from build_prompt
        echo "$prompt_result"
        return 1
    fi

    # Extract prompt content
    local prompt topic_slug output_file
    prompt=$(echo "$prompt_result" | jq -r '.result.prompt')
    topic_slug=$(echo "$prompt_result" | jq -r '.result.topicSlug')
    output_file=$(echo "$prompt_result" | jq -r '.result.outputFile')

    # Record spawn intent (for manifest tracking)
    local spawn_timestamp
    spawn_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq -n \
        --arg task_id "$task_id" \
        --arg template "$template_name" \
        --arg topic_slug "$topic_slug" \
        --arg output_file "$output_file" \
        --arg timestamp "$spawn_timestamp" \
        --arg prompt "$prompt" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "spawn"
            },
            "success": true,
            "result": {
                "taskId": $task_id,
                "template": $template,
                "topicSlug": $topic_slug,
                "outputFile": $output_file,
                "spawnTimestamp": $timestamp,
                "instruction": "Use Task tool to spawn subagent with the following prompt:",
                "prompt": $prompt
            }
        }'

    return 0
}

# orchestrator_can_parallelize - Check if tasks can be spawned in parallel
# Args:
#   $@ - List of task IDs to check
# Output: JSON with parallelization analysis
# Returns: 0 on success
orchestrator_can_parallelize() {
    local task_ids=("$@")
    local todo_file
    todo_file=$(_os_get_todo_file)

    if [[ ${#task_ids[@]} -eq 0 ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "can_parallelize"
            },
            "success": false,
            "error": {
                "code": "E_INVALID_INPUT",
                "message": "No task IDs provided"
            }
        }'
        return 2
    fi

    if [[ ! -f "$todo_file" ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "can_parallelize"
            },
            "success": false,
            "error": {
                "code": "E_FILE_NOT_FOUND",
                "message": "Todo file not found"
            }
        }'
        return "$EXIT_NOT_FOUND"
    fi

    # Convert bash array to JSON array
    local task_ids_json
    task_ids_json=$(printf '%s\n' "${task_ids[@]}" | jq -R . | jq -s .)

    # Check for mutual dependencies
    local analysis
    analysis=$(jq --argjson ids "$task_ids_json" '
        # Get tasks by IDs
        [.tasks[] | select(.id as $tid | $ids | any(. == $tid))] as $tasks |

        # Check if any task depends on another in the set
        ($tasks | map({
            id: .id,
            depends: (.depends // []),
            dependsOnSet: [(.depends // [])[] | . as $d | $ids | any(. == $d)]
        })) as $dep_analysis |

        # Find conflicts
        [$dep_analysis[] | select(.dependsOnSet | any)] as $conflicts |

        # Find safe pairs (no mutual dependencies)
        if ($conflicts | length) == 0 then
            {
                canParallelize: true,
                taskCount: ($tasks | length),
                conflicts: [],
                safeToSpawn: $ids,
                reason: "No inter-dependencies detected"
            }
        else
            {
                canParallelize: false,
                taskCount: ($tasks | length),
                conflicts: [$conflicts[] | {id, dependsOn: [.depends[] | select(. as $d | $ids | any(. == $d))]}],
                safeToSpawn: [$dep_analysis[] | select(.dependsOnSet | all(. == false)) | .id],
                reason: "Some tasks depend on others in the set"
            }
        end
    ' "$todo_file" 2>/dev/null)

    jq -n \
        --argjson analysis "$analysis" \
        --argjson task_ids "$task_ids_json" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "can_parallelize"
            },
            "success": true,
            "result": ($analysis + {requestedTasks: $task_ids})
        }'

    return 0
}

# orchestrator_get_parallel_waves - Get tasks organized by execution waves
# Args:
#   $1 - Epic ID
# Output: JSON with tasks grouped by wave for parallel execution
# Returns: 0 on success
orchestrator_get_parallel_waves() {
    local epic_id="$1"

    # Use analyze_dependencies and reformat for wave-based output
    local analysis_result
    analysis_result=$(orchestrator_analyze_dependencies "$epic_id")

    local success
    success=$(echo "$analysis_result" | jq -r '.success')

    if [[ "$success" != "true" ]]; then
        echo "$analysis_result"
        return 1
    fi

    # Transform to wave-focused output
    echo "$analysis_result" | jq '
        {
            "_meta": {
                "command": "orchestrator",
                "operation": "get_parallel_waves"
            },
            "success": true,
            "result": {
                "epicId": .result.epicId,
                "totalWaves": (.result.waves | length),
                "currentlySpawnable": .result.readyToSpawn,
                "spawnableCount": (.result.readyToSpawn | length),
                "waves": [.result.waves[] | {
                    wave: .wave,
                    taskCount: (.tasks | length),
                    pendingCount: ([.tasks[] | select(.status == "pending")] | length),
                    doneCount: ([.tasks[] | select(.status == "done")] | length),
                    tasks: .tasks
                }],
                "summary": {
                    "total": .result.totalTasks,
                    "completed": .result.completedTasks,
                    "pending": .result.pendingTasks,
                    "active": .result.activeTasks,
                    "blocked": (.result.blockedTasks | length)
                }
            }
        }
    '

    return 0
}

# ============================================================================
# EXPORT FUNCTIONS
# ============================================================================

export -f orchestrator_check_pending
export -f orchestrator_session_init
export -f orchestrator_get_next_task
export -f orchestrator_get_ready_tasks
export -f orchestrator_context_check
export -f orchestrator_get_startup_state
export -f orchestrator_analyze_dependencies
export -f orchestrator_get_manifest_summaries
export -f orchestrator_build_prompt
export -f orchestrator_spawn
export -f orchestrator_can_parallelize
export -f orchestrator_get_parallel_waves
