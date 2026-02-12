#!/usr/bin/env bash
# orchestrator-startup.sh - Orchestrator Session Startup Protocol
#
# LAYER: 3 (Domain Logic)
# DEPENDENCIES: exit-codes.sh, config.sh, research-manifest.sh, sessions.sh
# PROVIDES: orchestrator_check_pending, orchestrator_session_init,
#           orchestrator_get_next_task, orchestrator_context_check,
#           orchestrator_get_startup_state, orchestrator_get_ready_tasks,
#           orchestrator_spawn, orchestrator_build_prompt,
#           orchestrator_should_pause, orchestrator_pre_spawn_check,
#           generate_hitl_summary, orchestrator_auto_stop, orchestrator_check_and_stop
#
# Implements the session startup sequence for the Orchestrator Protocol.
# Ensures consistent bootstrapping across conversations.
#
# Version: 1.0.0 (cleo v0.55.0)
# Spec: docs/specs/ORCHESTRATOR-PROTOCOL-SPEC.md

#=== SOURCE GUARD ================================================
[[ -n "${_ORCHESTRATOR_STARTUP_LOADED:-}" ]] && return 0
declare -r _ORCHESTRATOR_STARTUP_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_OS_LIB_DIR="${BASH_SOURCE[0]%/*}/.."
[[ "$_OS_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _OS_LIB_DIR="."

# Source dependencies
# shellcheck source=lib/core/exit-codes.sh
source "${_OS_LIB_DIR}/core/exit-codes.sh"
# shellcheck source=lib/core/config.sh
source "${_OS_LIB_DIR}/core/config.sh"
# shellcheck source=lib/skills/research-manifest.sh
source "${_OS_LIB_DIR}/skills/research-manifest.sh"
# shellcheck source=lib/core/paths.sh
source "${_OS_LIB_DIR}/core/paths.sh"
# shellcheck source=lib/skills/token-inject.sh
source "${_OS_LIB_DIR}/skills/token-inject.sh"

# ============================================================================
# CONFIGURATION
# ============================================================================

# Orchestrator context budget (tokens)
readonly ORCHESTRATOR_CONTEXT_BUDGET=10000

# Context thresholds (read from config, with fallback defaults)
# These are initialized lazily via _os_init_thresholds() to ensure config.sh is loaded
ORCHESTRATOR_CONTEXT_WARNING=""
ORCHESTRATOR_CONTEXT_CRITICAL=""

# Initialize thresholds from config (called on first use)
# Validates that warning < critical and uses sensible defaults
_os_init_thresholds() {
    # Only initialize once
    if [[ -n "$ORCHESTRATOR_CONTEXT_WARNING" && -n "$ORCHESTRATOR_CONTEXT_CRITICAL" ]]; then
        return 0
    fi

    # Read from config with fallback defaults
    local warning_threshold critical_threshold
    warning_threshold=$(get_config_value 'orchestrator.contextThresholds.warning' 70)
    critical_threshold=$(get_config_value 'orchestrator.contextThresholds.critical' 80)

    # Validate thresholds are numeric
    if ! [[ "$warning_threshold" =~ ^[0-9]+$ ]]; then
        warning_threshold=70
    fi
    if ! [[ "$critical_threshold" =~ ^[0-9]+$ ]]; then
        critical_threshold=80
    fi

    # Validate warning < critical (swap if needed, with fallback to defaults)
    if [[ "$warning_threshold" -ge "$critical_threshold" ]]; then
        # Invalid configuration - use defaults
        warning_threshold=70
        critical_threshold=80
    fi

    # Set global variables
    ORCHESTRATOR_CONTEXT_WARNING="$warning_threshold"
    ORCHESTRATOR_CONTEXT_CRITICAL="$critical_threshold"
}

# Get warning threshold (initializes if needed)
get_orchestrator_warning_threshold() {
    _os_init_thresholds
    echo "$ORCHESTRATOR_CONTEXT_WARNING"
}

# Get critical threshold (initializes if needed)
get_orchestrator_critical_threshold() {
    _os_init_thresholds
    echo "$ORCHESTRATOR_CONTEXT_CRITICAL"
}

# ============================================================================
# SKILL NAME MAPPING
# ============================================================================

# Skill name mapping table: user-friendly names to skill directory names
# Supports: UPPER-CASE, lower-case, with/without ct- prefix
#
# Usage: _os_map_skill_name "TASK-EXECUTOR" -> "ct-task-executor"
#        _os_map_skill_name "research-agent" -> "ct-research-agent"
#        _os_map_skill_name "ct-validator" -> "ct-validator"
#
# Returns: Normalized skill directory name (always ct-prefixed, lowercase)
# Exit: 0 on success, 1 if skill not recognized (returns input unchanged)

# Explicit mapping table (associative array)
declare -A _OS_SKILL_MAP=(
    # Task execution and generic work
    ["TASK-EXECUTOR"]="ct-task-executor"
    ["task-executor"]="ct-task-executor"
    ["ct-task-executor"]="ct-task-executor"
    ["EXECUTOR"]="ct-task-executor"
    ["executor"]="ct-task-executor"

    # Research and investigation
    ["RESEARCH-AGENT"]="ct-research-agent"
    ["research-agent"]="ct-research-agent"
    ["ct-research-agent"]="ct-research-agent"
    ["RESEARCH"]="ct-research-agent"
    ["research"]="ct-research-agent"

    # Epic and architecture planning
    ["EPIC-ARCHITECT"]="ct-epic-architect"
    ["epic-architect"]="ct-epic-architect"
    ["ct-epic-architect"]="ct-epic-architect"
    ["ARCHITECT"]="ct-epic-architect"
    ["architect"]="ct-epic-architect"

    # Specification writing
    ["SPEC-WRITER"]="ct-spec-writer"
    ["spec-writer"]="ct-spec-writer"
    ["ct-spec-writer"]="ct-spec-writer"
    ["SPEC"]="ct-spec-writer"
    ["spec"]="ct-spec-writer"

    # BATS test writing
    ["TEST-WRITER-BATS"]="ct-test-writer-bats"
    ["test-writer-bats"]="ct-test-writer-bats"
    ["ct-test-writer-bats"]="ct-test-writer-bats"
    ["TEST-WRITER"]="ct-test-writer-bats"
    ["test-writer"]="ct-test-writer-bats"
    ["BATS"]="ct-test-writer-bats"
    ["bats"]="ct-test-writer-bats"

    # Bash library implementation
    ["LIBRARY-IMPLEMENTER-BASH"]="ct-library-implementer-bash"
    ["library-implementer-bash"]="ct-library-implementer-bash"
    ["ct-library-implementer-bash"]="ct-library-implementer-bash"
    ["LIB-IMPLEMENTER"]="ct-library-implementer-bash"
    ["lib-implementer"]="ct-library-implementer-bash"
    ["BASH-LIB"]="ct-library-implementer-bash"
    ["bash-lib"]="ct-library-implementer-bash"

    # Validation
    ["VALIDATOR"]="ct-validator"
    ["validator"]="ct-validator"
    ["ct-validator"]="ct-validator"
    ["VALIDATE"]="ct-validator"
    ["validate"]="ct-validator"

    # Documentation orchestrator
    ["DOCUMENTOR"]="ct-documentor"
    ["documentor"]="ct-documentor"
    ["ct-documentor"]="ct-documentor"
    ["DOCS"]="ct-documentor"
    ["docs"]="ct-documentor"

    # Documentation sub-skills
    ["DOCS-LOOKUP"]="ct-docs-lookup"
    ["docs-lookup"]="ct-docs-lookup"
    ["ct-docs-lookup"]="ct-docs-lookup"

    ["DOCS-WRITE"]="ct-docs-write"
    ["docs-write"]="ct-docs-write"
    ["ct-docs-write"]="ct-docs-write"

    ["DOCS-REVIEW"]="ct-docs-review"
    ["docs-review"]="ct-docs-review"
    ["ct-docs-review"]="ct-docs-review"

    # Skill management
    ["SKILL-CREATOR"]="ct-skill-creator"
    ["skill-creator"]="ct-skill-creator"
    ["ct-skill-creator"]="ct-skill-creator"

    ["SKILL-LOOKUP"]="ct-skill-lookup"
    ["skill-lookup"]="ct-skill-lookup"
    ["ct-skill-lookup"]="ct-skill-lookup"

    # Orchestrator
    ["ORCHESTRATOR"]="ct-orchestrator"
    ["orchestrator"]="ct-orchestrator"
    ["ct-orchestrator"]="ct-orchestrator"
)

# Map skill name to canonical directory name
# Args:
#   $1 - Skill name (any supported format)
# Output: Canonical skill directory name (ct-prefixed, lowercase)
# Returns: 0 if mapped, 1 if fallback used
_os_map_skill_name() {
    local input="$1"
    local normalized

    # First, try direct lookup (case-sensitive match for speed)
    if [[ -n "${_OS_SKILL_MAP[$input]:-}" ]]; then
        echo "${_OS_SKILL_MAP[$input]}"
        return 0
    fi

    # Convert to uppercase for case-insensitive lookup
    local upper_input
    upper_input=$(echo "$input" | tr '[:lower:]' '[:upper:]' | tr '_' '-')

    if [[ -n "${_OS_SKILL_MAP[$upper_input]:-}" ]]; then
        echo "${_OS_SKILL_MAP[$upper_input]}"
        return 0
    fi

    # Fallback: normalize to ct-prefixed lowercase
    # This handles any format: "SOME-SKILL" -> "ct-some-skill"
    normalized=$(echo "$input" | tr '[:upper:]' '[:lower:]' | tr '_' '-')
    if [[ ! "$normalized" =~ ^ct- ]]; then
        normalized="ct-${normalized}"
    fi

    echo "$normalized"
    return 1  # Indicate fallback was used
}

# List all known skill mappings (for debugging/documentation)
# Output: JSON array of skill mappings
_os_list_skill_mappings() {
    local mappings='['
    local first=true
    local seen=()

    for key in "${!_OS_SKILL_MAP[@]}"; do
        local value="${_OS_SKILL_MAP[$key]}"
        # Only include each canonical name once
        if [[ ! " ${seen[*]} " =~ " ${value} " ]]; then
            seen+=("$value")
            [[ "$first" == "true" ]] || mappings+=","
            first=false
            mappings+="{\"canonical\":\"${value}\",\"aliases\":[\"${key}\"]}"
        fi
    done

    mappings+=']'
    echo "$mappings"
}

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
    # Use --slurpfile with process substitution to avoid ARG_MAX limits
    jq -n \
        --slurpfile manifest_pending <(echo "$manifest_pending") \
        --slurpfile followup_tasks <(echo "$cleo_followup_tasks") \
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
                "manifestEntries": $manifest_pending[0].result.entries,
                "manifestCount": $manifest_count,
                "followupTaskIds": $followup_tasks[0].result.taskIds,
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

    # Use --slurpfile with process substitution to avoid ARG_MAX limits
    jq -n \
        --argjson active_sessions "$active_sessions" \
        --arg active_session_id "$active_session_id" \
        --arg active_scope "$active_scope" \
        --argjson has_focus "$has_focus" \
        --arg focused_task "$focused_task" \
        --argjson has_pending "$has_pending" \
        --slurpfile pending <(echo "$pending_result") \
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
                    "manifestCount": $pending[0].result.manifestCount,
                    "followupTaskIds": $pending[0].result.followupTaskIds
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

# _os_get_context_state - Read current context state from session-aware files
# Args:
#   $1 - Session ID (optional, uses current session if not provided)
# Output: JSON object with percentage, currentTokens, maxTokens, status
# Returns: 0 if state found and valid, 1 if stale/missing
_os_get_context_state() {
    local session_id="${1:-}"
    local cleo_dir
    cleo_dir=$(get_cleo_dir)
    local cleo_dir_abs
    cleo_dir_abs=$(get_cleo_dir_absolute "$cleo_dir")

    # If no session specified, try to get current session
    if [[ -z "$session_id" ]]; then
        local session_file="${cleo_dir}/.current-session"
        if [[ -f "$session_file" ]]; then
            session_id=$(cat "$session_file" 2>/dev/null | tr -d '\n')
        fi
    fi

    # Get context state path (uses unified path helpers)
    local state_file

    repair_errant_context_state_paths "$cleo_dir" >/dev/null 2>&1 || true

    # Initialize state_file to empty string (will be set below)
    state_file=""

    if [[ -n "$session_id" ]]; then
        state_file=$(get_context_state_file_path "$session_id" "$cleo_dir")

        # Fallback to legacy flat file pattern
        if [[ ! -f "$state_file" ]]; then
            state_file="${cleo_dir_abs}/.context-state-${session_id}.json"
        fi
    fi

    # Final fallback to singleton
    if [[ -z "$state_file" ]] || [[ ! -f "$state_file" ]]; then
        state_file="${cleo_dir_abs}/.context-state.json"
    fi

    if [[ ! -f "$state_file" ]]; then
        # Return empty state
        echo '{"percentage": 0, "currentTokens": 0, "maxTokens": 200000, "status": "unknown", "stale": true}'
        return 1
    fi

    # Read and validate state file
    local timestamp stale_after_ms now_epoch file_epoch age_ms is_stale
    timestamp=$(jq -r '.timestamp // ""' "$state_file" 2>/dev/null)
    stale_after_ms=$(jq -r '.staleAfterMs // 5000' "$state_file" 2>/dev/null)

    is_stale="false"
    if [[ -n "$timestamp" ]]; then
        now_epoch=$(date +%s)
        file_epoch=$(date -d "$timestamp" +%s 2>/dev/null || echo "0")
        age_ms=$(( (now_epoch - file_epoch) * 1000 ))
        if [[ "$age_ms" -gt "$stale_after_ms" ]]; then
            is_stale="true"
        fi
    fi

    # Extract context values
    jq --argjson stale "$is_stale" '{
        percentage: (.contextWindow.percentage // 0),
        currentTokens: (.contextWindow.currentTokens // 0),
        maxTokens: (.contextWindow.maxTokens // 200000),
        status: (if $stale then "stale" else (.status // "unknown") end),
        stale: $stale
    }' "$state_file" 2>/dev/null || echo '{"percentage": 0, "currentTokens": 0, "maxTokens": 200000, "status": "unknown", "stale": true}'

    [[ "$is_stale" == "true" ]] && return 1
    return 0
}

# orchestrator_should_pause - Check if orchestrator should pause based on context usage
# Args: none (reads from context state file)
# Output: JSON with pause recommendation
# Returns:
#   0 - Continue: Context is healthy, safe to proceed
#   1 - Warning: Approaching threshold, wrap up current work
#   2 - Critical: At or above critical threshold, stop immediately
orchestrator_should_pause() {
    # Initialize thresholds from config
    _os_init_thresholds
    local warning_threshold="$ORCHESTRATOR_CONTEXT_WARNING"
    local critical_threshold="$ORCHESTRATOR_CONTEXT_CRITICAL"

    # Get current context state
    local context_state
    context_state=$(_os_get_context_state)
    local state_valid=$?

    # Extract values
    local percentage status is_stale
    percentage=$(echo "$context_state" | jq -r '.percentage // 0')
    status=$(echo "$context_state" | jq -r '.status // "unknown"')
    is_stale=$(echo "$context_state" | jq -r '.stale // false')

    # Determine pause status
    local pause_status pause_code recommendation
    if [[ "$percentage" -ge "$critical_threshold" ]]; then
        pause_status="critical"
        pause_code=2
        recommendation="STOP immediately. Delegate all remaining work to subagents."
    elif [[ "$percentage" -ge "$warning_threshold" ]]; then
        pause_status="warning"
        pause_code=1
        recommendation="Wrap up current work. Spawn final subagents and prepare handoff."
    else
        pause_status="ok"
        pause_code=0
        recommendation="Continue orchestration. Context usage is healthy."
    fi

    # Check config for auto-stop behavior
    local auto_stop_on_critical
    auto_stop_on_critical=$(get_config_value "orchestrator.autoStopOnCritical" "true")

    jq -n \
        --arg pause_status "$pause_status" \
        --argjson pause_code "$pause_code" \
        --argjson percentage "$percentage" \
        --argjson warning_threshold "$warning_threshold" \
        --argjson critical_threshold "$critical_threshold" \
        --arg recommendation "$recommendation" \
        --argjson is_stale "$is_stale" \
        --arg context_status "$status" \
        --arg auto_stop "$auto_stop_on_critical" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "should_pause"
            },
            "success": true,
            "result": {
                "pauseStatus": $pause_status,
                "pauseCode": $pause_code,
                "shouldPause": ($pause_code >= 2),
                "shouldWrapUp": ($pause_code >= 1),
                "contextPercentage": $percentage,
                "warningThreshold": $warning_threshold,
                "criticalThreshold": $critical_threshold,
                "recommendation": $recommendation,
                "contextStale": $is_stale,
                "contextStatus": $context_status,
                "autoStopOnCritical": ($auto_stop == "true")
            }
        }'

    return "$pause_code"
}

# orchestrator_pre_spawn_check - Validate conditions before spawning a new agent
# Args:
#   $1 - Task ID to spawn (optional, for task-specific validation)
#   $2 - Epic ID (optional, for scope validation)
#   $3 - Previous task ID (optional, to verify previous agent compliance)
#   $4 - Previous research ID (optional, for explicit compliance check)
# Output: JSON with spawn recommendation and detailed status
# Returns: 0 if can spawn, non-zero if should not spawn
orchestrator_pre_spawn_check() {
    local task_id="${1:-}"
    local epic_id="${2:-}"
    local previous_task_id="${3:-}"
    local previous_research_id="${4:-}"

    # Initialize thresholds from config
    _os_init_thresholds
    local warning_threshold="$ORCHESTRATOR_CONTEXT_WARNING"
    local critical_threshold="$ORCHESTRATOR_CONTEXT_CRITICAL"

    # Get current context state
    local context_state
    context_state=$(_os_get_context_state)

    # Extract context values
    local percentage current_tokens max_tokens context_status is_stale
    percentage=$(echo "$context_state" | jq -r '.percentage // 0')
    current_tokens=$(echo "$context_state" | jq -r '.currentTokens // 0')
    max_tokens=$(echo "$context_state" | jq -r '.maxTokens // 200000')
    context_status=$(echo "$context_state" | jq -r '.status // "unknown"')
    is_stale=$(echo "$context_state" | jq -r '.stale // false')

    # Determine spawn decision
    local can_spawn recommendation spawn_status reasons
    reasons="[]"

    if [[ "$percentage" -ge "$critical_threshold" ]]; then
        can_spawn="false"
        spawn_status="blocked"
        recommendation="stop"
        reasons=$(jq -n --argjson pct "$percentage" --argjson thresh "$critical_threshold" \
            '[{"code": "CONTEXT_CRITICAL", "message": ("Context at " + ($pct|tostring) + "% exceeds critical threshold " + ($thresh|tostring) + "%")}]')
    elif [[ "$percentage" -ge "$warning_threshold" ]]; then
        can_spawn="true"
        spawn_status="warning"
        recommendation="wrap_up"
        reasons=$(jq -n --argjson pct "$percentage" --argjson thresh "$warning_threshold" \
            '[{"code": "CONTEXT_WARNING", "message": ("Context at " + ($pct|tostring) + "% exceeds warning threshold " + ($thresh|tostring) + "%")}]')
    elif [[ "$is_stale" == "true" ]]; then
        can_spawn="true"
        spawn_status="stale"
        recommendation="continue"
        reasons=$(jq -n '[{"code": "CONTEXT_STALE", "message": "Context state is stale. Status line may not be running."}]')
    else
        can_spawn="true"
        spawn_status="ok"
        recommendation="continue"
        reasons="[]"
    fi

    # If task_id provided, validate task exists and is spawnable
    local task_validation='null'
    if [[ -n "$task_id" ]]; then
        local todo_file
        todo_file=$(_os_get_todo_file)
        if [[ -f "$todo_file" ]]; then
            local task_exists task_status task_title
            task_exists=$(jq --arg tid "$task_id" '[.tasks[] | select(.id == $tid)] | length > 0' "$todo_file" 2>/dev/null || echo "false")
            if [[ "$task_exists" == "true" ]]; then
                task_status=$(jq -r --arg tid "$task_id" '.tasks[] | select(.id == $tid) | .status' "$todo_file" 2>/dev/null)
                task_title=$(jq -r --arg tid "$task_id" '.tasks[] | select(.id == $tid) | .title' "$todo_file" 2>/dev/null)
                task_validation=$(jq -n \
                    --arg tid "$task_id" \
                    --arg status "$task_status" \
                    --arg title "$task_title" \
                    '{
                        "exists": true,
                        "taskId": $tid,
                        "status": $status,
                        "title": $title,
                        "spawnable": ($status == "pending")
                    }')
                if [[ "$task_status" != "pending" ]]; then
                    can_spawn="false"
                    spawn_status="blocked"
                    reasons=$(echo "$reasons" | jq --arg tid "$task_id" --arg status "$task_status" \
                        '. + [{"code": "TASK_NOT_PENDING", "message": ("Task " + $tid + " has status " + $status + ", expected pending")}]')
                fi
            else
                can_spawn="false"
                spawn_status="blocked"
                task_validation=$(jq -n --arg tid "$task_id" '{"exists": false, "taskId": $tid, "spawnable": false}')
                reasons=$(echo "$reasons" | jq --arg tid "$task_id" \
                    '. + [{"code": "TASK_NOT_FOUND", "message": ("Task " + $tid + " not found")}]')
            fi
        fi
    fi

    # If previous_task_id provided, verify previous agent compliance
    local compliance_validation='null'
    if [[ -n "$previous_task_id" && "$can_spawn" == "true" ]]; then
        # Source orchestrator-validator if not already loaded
        if ! declare -f orchestrator_verify_compliance >/dev/null 2>&1; then
            local lib_dir="${BASH_SOURCE[0]%/*}/.."
            if [[ -f "$lib_dir/skills/orchestrator-validator.sh" ]]; then
                source "$lib_dir/skills/orchestrator-validator.sh"
            fi
        fi

        if declare -f orchestrator_verify_compliance >/dev/null 2>&1; then
            local compliance_result
            compliance_result=$(orchestrator_verify_compliance "$previous_task_id" "$previous_research_id" 2>/dev/null) || true

            if [[ -n "$compliance_result" ]]; then
                local compliance_passed
                compliance_passed=$(echo "$compliance_result" | jq -r '.result.canSpawnNext // false')
                compliance_validation=$(echo "$compliance_result" | jq '.result')

                if [[ "$compliance_passed" != "true" ]]; then
                    can_spawn="false"
                    spawn_status="blocked"
                    recommendation="verify_compliance"

                    # Extract violations from compliance check
                    local compliance_violations
                    compliance_violations=$(echo "$compliance_result" | jq -c '.result.violations // []')
                    reasons=$(echo "$reasons" | jq --argjson cv "$compliance_violations" \
                        '. + [{"code": "PREVIOUS_AGENT_VIOLATION", "message": "Previous agent failed protocol compliance", "violations": $cv}]')
                fi
            fi
        fi
    fi

    # Build response
    jq -n \
        --argjson can_spawn "$can_spawn" \
        --arg spawn_status "$spawn_status" \
        --arg recommendation "$recommendation" \
        --argjson percentage "$percentage" \
        --argjson current_tokens "$current_tokens" \
        --argjson max_tokens "$max_tokens" \
        --argjson warning_threshold "$warning_threshold" \
        --argjson critical_threshold "$critical_threshold" \
        --argjson is_stale "$is_stale" \
        --arg context_status "$context_status" \
        --argjson reasons "$reasons" \
        --argjson task_validation "$task_validation" \
        --argjson compliance_validation "$compliance_validation" \
        --arg task_id "$task_id" \
        --arg epic_id "$epic_id" \
        --arg previous_task_id "$previous_task_id" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "pre_spawn_check"
            },
            "success": true,
            "result": {
                "canSpawn": $can_spawn,
                "spawnStatus": $spawn_status,
                "recommendation": $recommendation,
                "context": {
                    "percentage": $percentage,
                    "currentTokens": $current_tokens,
                    "maxTokens": $max_tokens,
                    "warningThreshold": $warning_threshold,
                    "criticalThreshold": $critical_threshold,
                    "status": $context_status,
                    "stale": $is_stale
                },
                "taskValidation": $task_validation,
                "complianceValidation": $compliance_validation,
                "reasons": $reasons,
                "requestedTaskId": (if $task_id != "" then $task_id else null end),
                "requestedEpicId": (if $epic_id != "" then $epic_id else null end),
                "previousTaskId": (if $previous_task_id != "" then $previous_task_id else null end)
            }
        }'

    [[ "$can_spawn" == "true" ]] && return 0
    return 1
}

# generate_hitl_summary - Generate Human-in-the-Loop summary for session handoff
# Creates a structured summary for human review when orchestrator pauses
# Args:
#   $1 - Epic ID (optional, uses current session scope if not provided)
#   $2 - Stop reason (optional, default: "context-limit")
# Output: JSON with HITL summary including progress, remaining work, resume instructions
# Returns: 0 on success
generate_hitl_summary() {
    local epic_id="${1:-}"
    local stop_reason="${2:-context-limit}"
    local todo_file sessions_file focus_file
    todo_file=$(_os_get_todo_file)
    sessions_file=$(_os_get_sessions_file)
    focus_file=$(_os_get_focus_file)

    # Get current session info
    local session_id=""
    local session_info='null'

    if [[ -f "$sessions_file" ]]; then
        # Try to get current session
        local current_session_file
        current_session_file="$(get_cleo_dir)/.current-session"
        if [[ -f "$current_session_file" ]]; then
            session_id=$(cat "$current_session_file" 2>/dev/null | tr -d '[:space:]')
        fi
        if [[ -n "$session_id" ]]; then
            session_info=$(jq -c --arg id "$session_id" '.sessions[] | select(.id == $id)' "$sessions_file" 2>/dev/null || echo 'null')
            if [[ "$session_info" != "null" && -z "$epic_id" ]]; then
                epic_id=$(echo "$session_info" | jq -r '.scope.rootId // ""')
            fi
        fi
    fi

    # Get current focus
    local focused_task=""
    local focus_note=""
    if [[ -f "$focus_file" ]]; then
        focused_task=$(jq -r '.focusedTaskId // ""' "$focus_file" 2>/dev/null || echo "")
        focus_note=$(jq -r '.sessionNote // ""' "$focus_file" 2>/dev/null || echo "")
    fi

    # Get task statistics for epic
    local completed_tasks=0
    local pending_tasks=0
    local active_tasks=0
    local blocked_tasks=0
    local completed_this_session='[]'
    local remaining_tasks='[]'

    if [[ -f "$todo_file" && -n "$epic_id" ]]; then
        local task_stats
        task_stats=$(jq --arg epic_id "$epic_id" '
            [.tasks[] | select(.parentId == $epic_id)] as $epic_tasks |
            {
                completed: ([$epic_tasks[] | select(.status == "done")] | length),
                pending: ([$epic_tasks[] | select(.status == "pending")] | length),
                active: ([$epic_tasks[] | select(.status == "active")] | length),
                blocked: ([$epic_tasks[] | select(.status == "blocked")] | length),
                completedTasks: [$epic_tasks[] | select(.status == "done") | {id, title}],
                remainingTasks: [$epic_tasks[] | select(.status != "done") | {id, title, status, priority}]
            }
        ' "$todo_file" 2>/dev/null || echo '{}')

        completed_tasks=$(echo "$task_stats" | jq -r '.completed // 0')
        pending_tasks=$(echo "$task_stats" | jq -r '.pending // 0')
        active_tasks=$(echo "$task_stats" | jq -r '.active // 0')
        blocked_tasks=$(echo "$task_stats" | jq -r '.blocked // 0')
        completed_this_session=$(echo "$task_stats" | jq -c '.completedTasks // []')
        remaining_tasks=$(echo "$task_stats" | jq -c '.remainingTasks // []')
    fi

    # Get next ready tasks
    local ready_tasks='[]'
    if [[ -n "$epic_id" ]]; then
        local ready_result
        ready_result=$(orchestrator_get_ready_tasks "$epic_id" 2>/dev/null || echo '{"result":{"tasks":[]}}')
        ready_tasks=$(echo "$ready_result" | jq -c '.result.tasks // []')
    fi

    # Build resume command
    local resume_command=""
    if [[ -n "$session_id" ]]; then
        resume_command="cleo session resume ${session_id}"
    elif [[ -n "$epic_id" ]]; then
        resume_command="cleo session start --scope epic:${epic_id} --auto-focus"
    else
        resume_command="cleo session list  # Resume appropriate session"
    fi

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Calculate total and percentage
    local total_tasks percent_complete
    total_tasks=$((completed_tasks + pending_tasks + active_tasks + blocked_tasks))
    if [[ "$total_tasks" -gt 0 ]]; then
        percent_complete=$((completed_tasks * 100 / total_tasks))
    else
        percent_complete=0
    fi

    jq -n \
        --arg session_id "$session_id" \
        --arg epic_id "$epic_id" \
        --arg focused_task "$focused_task" \
        --arg focus_note "$focus_note" \
        --arg stop_reason "$stop_reason" \
        --arg resume_command "$resume_command" \
        --arg timestamp "$timestamp" \
        --argjson completed "$completed_tasks" \
        --argjson pending "$pending_tasks" \
        --argjson active "$active_tasks" \
        --argjson blocked "$blocked_tasks" \
        --argjson total "$total_tasks" \
        --argjson percent "$percent_complete" \
        --argjson completed_tasks "$completed_this_session" \
        --argjson remaining_tasks "$remaining_tasks" \
        --argjson ready_tasks "$ready_tasks" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "hitl_summary"
            },
            "success": true,
            "result": {
                "timestamp": $timestamp,
                "stopReason": $stop_reason,
                "session": {
                    "id": (if $session_id != "" then $session_id else null end),
                    "epicId": (if $epic_id != "" then $epic_id else null end),
                    "focusedTask": (if $focused_task != "" then $focused_task else null end),
                    "progressNote": (if $focus_note != "" then $focus_note else null end)
                },
                "progress": {
                    "completed": $completed,
                    "pending": $pending,
                    "active": $active,
                    "blocked": $blocked,
                    "total": $total,
                    "percentComplete": $percent
                },
                "completedTasks": $completed_tasks,
                "remainingTasks": ($remaining_tasks | sort_by(
                    (if .priority == "critical" then 0
                     elif .priority == "high" then 1
                     elif .priority == "medium" then 2
                     else 3 end)
                )),
                "readyToSpawn": $ready_tasks,
                "handoff": {
                    "resumeCommand": $resume_command,
                    "nextSteps": [
                        ("Run: " + $resume_command),
                        ("Check progress: cleo list --parent " + (if $epic_id != "" then $epic_id else "<epic-id>" end)),
                        "Review dashboard: cleo dash"
                    ]
                }
            }
        }'

    return 0
}

# orchestrator_auto_stop - Execute automatic stop procedure when context limit reached
# Ends session cleanly and generates HITL summary for human handoff
# Args:
#   $1 - Epic ID (optional)
#   $2 - Stop reason (optional, default: "context-limit")
# Output: JSON with auto-stop result and HITL summary
# Returns: 0 on success
orchestrator_auto_stop() {
    local epic_id="${1:-}"
    local stop_reason="${2:-context-limit}"

    # Check if autoStopOnCritical is enabled
    local auto_stop_enabled
    auto_stop_enabled=$(get_config_value 'orchestrator.autoStopOnCritical' true)

    if [[ "$auto_stop_enabled" != "true" ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "auto_stop"
            },
            "success": false,
            "result": {
                "stopped": false,
                "reason": "autoStopOnCritical is disabled in config"
            }
        }'
        return 0
    fi

    # Check if HITL summary should be generated
    local hitl_enabled
    hitl_enabled=$(get_config_value 'orchestrator.hitlSummaryOnPause' true)

    # Get current session ID
    local session_id=""
    local current_session_file
    current_session_file="$(get_cleo_dir)/.current-session"
    if [[ -f "$current_session_file" ]]; then
        session_id=$(cat "$current_session_file" 2>/dev/null | tr -d '[:space:]')
    fi

    # Generate HITL summary if enabled
    local hitl_summary='null'
    if [[ "$hitl_enabled" == "true" ]]; then
        local hitl_result
        hitl_result=$(generate_hitl_summary "$epic_id" "$stop_reason")
        hitl_summary=$(echo "$hitl_result" | jq '.result')
    fi

    # End session with summary note (if session exists)
    local session_ended=false
    local session_note="Auto-stopped: ${stop_reason}"
    if [[ -n "$session_id" ]]; then
        # Source sessions library if not already loaded
        if ! declare -f end_session >/dev/null 2>&1; then
            local lib_dir="${BASH_SOURCE[0]%/*}/.."
            if [[ -f "$lib_dir/session/sessions.sh" ]]; then
                source "$lib_dir/session/sessions.sh"
            fi
        fi

        # End session with note
        if declare -f end_session >/dev/null 2>&1; then
            if end_session "$session_id" "$session_note" >/dev/null 2>&1; then
                session_ended=true
            fi
        fi
    fi

    # Build resume command
    local resume_command=""
    if [[ -n "$session_id" ]]; then
        resume_command="cleo session resume ${session_id}"
    elif [[ -n "$epic_id" ]]; then
        resume_command="cleo session start --scope epic:${epic_id} --auto-focus"
    fi

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Convert hitl_enabled to proper boolean for jq
    local hitl_enabled_bool
    [[ "$hitl_enabled" == "true" ]] && hitl_enabled_bool="true" || hitl_enabled_bool="false"

    jq -n \
        --arg stop_reason "$stop_reason" \
        --arg session_id "$session_id" \
        --arg resume_command "$resume_command" \
        --arg timestamp "$timestamp" \
        --argjson session_ended "$session_ended" \
        --argjson hitl_enabled "$hitl_enabled_bool" \
        --argjson hitl_summary "$hitl_summary" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "auto_stop"
            },
            "success": true,
            "result": {
                "stopped": true,
                "timestamp": $timestamp,
                "stopReason": $stop_reason,
                "sessionId": (if $session_id != "" then $session_id else null end),
                "sessionEnded": $session_ended,
                "hitlSummaryGenerated": $hitl_enabled,
                "hitlSummary": $hitl_summary,
                "resumeCommand": $resume_command,
                "message": ("Orchestrator auto-stopped due to " + $stop_reason + ". Resume with: " + $resume_command)
            }
        }'

    return 0
}

# orchestrator_check_and_stop - Combined check and auto-stop in one call
# Primary function for orchestrator workflow to check context before spawn decisions
# Args:
#   $1 - Epic ID (optional)
# Output: JSON with decision and actions taken
# Returns: 0 if should continue, 2 if stopped (critical threshold)
orchestrator_check_and_stop() {
    local epic_id="${1:-}"

    # Use orchestrator_should_pause for context check
    local pause_result
    pause_result=$(orchestrator_should_pause)
    local pause_code=$?

    local should_stop
    should_stop=$(echo "$pause_result" | jq -r '.result.shouldPause')

    if [[ "$should_stop" == "true" ]]; then
        # Execute auto-stop
        local auto_stop_result
        auto_stop_result=$(orchestrator_auto_stop "$epic_id" "context-limit")

        # Combine results
        jq -n \
            --argjson check "$pause_result" \
            --argjson stop "$auto_stop_result" \
            '{
                "_meta": {
                    "command": "orchestrator",
                    "operation": "check_and_stop"
                },
                "success": true,
                "result": {
                    "action": "stopped",
                    "pauseCheck": $check.result,
                    "autoStop": $stop.result
                }
            }'
        return 2
    fi

    # Continue - return check result with continue action
    jq -n \
        --argjson check "$pause_result" \
        '{
            "_meta": {
                "command": "orchestrator",
                "operation": "check_and_stop"
            },
            "success": true,
            "result": {
                "action": "continue",
                "pauseCheck": $check.result
            }
        }'
    return 0
}

# orchestrator_context_check - Validate orchestrator context limits
# Args:
#   $1 - Current context usage in tokens (optional, uses context state file if not provided)
# Output: JSON with context status and recommendations
# Returns: 0 if OK, 52 if critical
orchestrator_context_check() {
    local current_tokens="${1:-0}"

    # Initialize thresholds from config
    _os_init_thresholds
    local warning_threshold="$ORCHESTRATOR_CONTEXT_WARNING"
    local critical_threshold="$ORCHESTRATOR_CONTEXT_CRITICAL"

    # If not provided, try to get from context state file using session-aware helper
    if [[ "$current_tokens" -eq 0 ]]; then
        local context_state
        context_state=$(_os_get_context_state)
        current_tokens=$(echo "$context_state" | jq -r '.currentTokens // 0')
    fi

    local usage_percent status recommendation
    if [[ "$ORCHESTRATOR_CONTEXT_BUDGET" -gt 0 ]]; then
        usage_percent=$(( (current_tokens * 100) / ORCHESTRATOR_CONTEXT_BUDGET ))
    else
        usage_percent=0
    fi

    if [[ "$usage_percent" -ge "$critical_threshold" ]]; then
        status="critical"
        recommendation="STOP - Delegate immediately. Context near limit."
    elif [[ "$usage_percent" -ge "$warning_threshold" ]]; then
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
        --argjson warning_threshold "$warning_threshold" \
        --argjson critical_threshold "$critical_threshold" \
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
                "warningThreshold": $warning_threshold,
                "criticalThreshold": $critical_threshold,
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

# Template directory - now points to skills
_os_get_templates_dir() {
    local script_dir="${BASH_SOURCE[0]%/*}/.."
    [[ "$script_dir" == "${BASH_SOURCE[0]}" ]] && script_dir="."
    echo "$(cd "$script_dir/../skills" && pwd)"
}

# Map template name to skill directory path
# Args:
#   $1 - Template name (e.g., "TASK-EXECUTOR", "task-executor", "ct-task-executor")
# Output: Full path to SKILL.md file
# Returns: 0 on success, 1 if skill not found
#
# Uses _os_map_skill_name() for canonical name resolution, supporting:
# - User-friendly names: "TASK-EXECUTOR", "RESEARCH-AGENT"
# - Short aliases: "EXECUTOR", "RESEARCH", "BATS"
# - Mixed case: "Task-Executor", "research-Agent"
# - Already-normalized: "ct-task-executor"
_os_resolve_template_path() {
    local template_name="$1"
    local templates_dir skill_name skill_path

    templates_dir=$(_os_get_templates_dir)

    # Use skill name mapping for canonical resolution
    skill_name=$(_os_map_skill_name "$template_name")

    # Primary path: skills/ct-{name}/SKILL.md
    skill_path="${templates_dir}/${skill_name}/SKILL.md"

    if [[ -f "$skill_path" ]]; then
        echo "$skill_path"
        return 0
    fi

    # Fallback: try without ct- prefix (legacy support)
    local legacy_path="${templates_dir}/${skill_name#ct-}/SKILL.md"
    if [[ -f "$legacy_path" ]]; then
        echo "$legacy_path"
        return 0
    fi

    # Not found - return empty and error
    echo ""
    return 1
}

# Get agent output directory (for subagent outputs, research results, etc.)
# Uses canonical get_agent_outputs_directory() from lib/core/config.sh
_os_get_agent_output_dir() {
    get_agent_outputs_directory
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
#
# Uses token-inject.sh for proper {{TOKEN}} substitution from placeholders.json
orchestrator_build_prompt() {
    local task_id="$1"
    local template_name="${2:-TASK-EXECUTOR}"
    local todo_file template_path
    todo_file=$(_os_get_todo_file)

    # Resolve template path using skill directory mapping
    template_path=$(_os_resolve_template_path "$template_name")

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

    # Get task details as JSON (for ti_set_task_context)
    local task_json
    task_json=$(jq --arg task_id "$task_id" '{task: (.tasks[] | select(.id == $task_id))}' "$todo_file" 2>/dev/null)

    # Extract task for null check
    local task
    task=$(echo "$task_json" | jq '.task' 2>/dev/null)

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
    if [[ -z "$template_path" || ! -f "$template_path" ]]; then
        local templates_dir expected_path
        templates_dir=$(_os_get_templates_dir)
        # Show expected path for debugging
        expected_path="${templates_dir}/ct-$(echo "$template_name" | tr '[:upper:]' '[:lower:]' | tr '_' '-')/SKILL.md"
        jq -n \
            --arg template "$template_name" \
            --arg expected "$expected_path" \
            --arg templates_dir "$templates_dir" \
            '{
                "_meta": {
                    "command": "orchestrator",
                    "operation": "build_prompt"
                },
                "success": false,
                "error": {
                    "code": "E_TEMPLATE_NOT_FOUND",
                    "message": ("Skill template " + $template + " not found"),
                    "expectedPath": $expected,
                    "hint": "Skill should be at skills/ct-{name}/SKILL.md"
                }
            }'
        return "$EXIT_NOT_FOUND"
    fi

    # Read template content
    local template_content
    template_content=$(cat "$template_path")

    # =========================================================================
    # TOKEN INJECTION SETUP (using token-inject.sh)
    # =========================================================================

    # Clear any previous token state
    ti_clear_all

    # Prepare context values
    local date_today output_dir topic_slug
    date_today=$(date +%Y-%m-%d)
    output_dir=$(_os_get_agent_output_dir)
    topic_slug=$(echo "$task" | jq -r '.title | gsub("[^a-zA-Z0-9]+"; "-") | ascii_downcase | ltrimstr("-") | rtrimstr("-")')

    # Set required context tokens via ti_set_context
    ti_set_context "$task_id" "$date_today" "$topic_slug"

    # Set defaults for CLEO commands (TASK_SHOW_CMD, TASK_FOCUS_CMD, etc.)
    ti_set_defaults

    # Set task context tokens from task JSON (TASK_TITLE, TASK_DESCRIPTION, etc.)
    ti_set_task_context "$task_json"

    # Get epic details for additional context
    local parent_id epic_title
    parent_id=$(echo "$task" | jq -r '.parentId // ""')
    if [[ -n "$parent_id" ]]; then
        epic_title=$(jq -r --arg pid "$parent_id" '.tasks[] | select(.id == $pid) | .title // "Unknown Epic"' "$todo_file" 2>/dev/null)
        export TI_EPIC_ID="$parent_id"
    else
        epic_title="No Epic"
        export TI_EPIC_ID=""
    fi

    # Get session info
    local session_id
    session_id=$(cat "$(get_cleo_dir)/.current-session" 2>/dev/null || echo "no-session")
    export TI_SESSION_ID="$session_id"

    # Set output directory
    export TI_OUTPUT_DIR="$output_dir"
    export TI_MANIFEST_PATH="${output_dir}/MANIFEST.jsonl"

    # Get manifest summaries for dependencies (provides context from previous agents)
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
    export TI_MANIFEST_SUMMARIES="$summaries_text"

    # Extract next task IDs (tasks that become unblocked after this one)
    ti_extract_next_task_ids "$task_id"

    # Set additional tokens not covered by ti_set_task_context
    export TI_TITLE="$(echo "$task" | jq -r '.title')"
    export TI_RESEARCH_ID="${topic_slug}-${date_today}"

    # =========================================================================
    # INJECT TOKENS INTO TEMPLATE
    # =========================================================================

    local prompt_content
    prompt_content=$(ti_inject_tokens "$template_content")

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
export -f orchestrator_should_pause
export -f orchestrator_pre_spawn_check
export -f generate_hitl_summary
export -f orchestrator_auto_stop
export -f orchestrator_check_and_stop
export -f get_orchestrator_warning_threshold
export -f get_orchestrator_critical_threshold
