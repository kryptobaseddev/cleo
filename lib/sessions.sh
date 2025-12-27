#!/usr/bin/env bash
# sessions.sh - Multi-session concurrent agent management
#
# LAYER: 2 (Data Layer)
# DEPENDENCIES: file-ops.sh, paths.sh, config.sh
# PROVIDES: Session lifecycle, scope computation, conflict detection
#
# Design: Enables multiple LLM agents to work concurrently on different
# task groups (epics, phases, task groups) with isolated focus state.
#
# Version: 1.0.0 (cleo v0.38.0)
# Spec: docs/specs/MULTI-SESSION-SPEC.md

#=== SOURCE GUARD ================================================
[[ -n "${_SESSIONS_SH_LOADED:-}" ]] && return 0
declare -r _SESSIONS_SH_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source file-ops for locking and atomic writes
if [[ -f "$_LIB_DIR/file-ops.sh" ]]; then
    source "$_LIB_DIR/file-ops.sh"
fi

# Source paths for directory resolution
if [[ -f "$_LIB_DIR/paths.sh" ]]; then
    source "$_LIB_DIR/paths.sh"
fi

# Source config for settings access
if [[ -f "$_LIB_DIR/config.sh" ]]; then
    source "$_LIB_DIR/config.sh"
fi

# Source exit codes
if [[ -f "$_LIB_DIR/exit-codes.sh" ]]; then
    source "$_LIB_DIR/exit-codes.sh"
fi

# ============================================================================
# CONSTANTS
# ============================================================================

# Error codes for multi-session operations (30-39 range per MULTI-SESSION-SPEC.md)
readonly E_SESSION_EXISTS=30
readonly E_SESSION_NOT_FOUND=31
readonly E_SCOPE_CONFLICT=32
readonly E_SCOPE_INVALID=33
readonly E_TASK_NOT_IN_SCOPE=34
readonly E_TASK_CLAIMED=35
readonly E_SESSION_SUSPENDED=36
readonly E_MAX_SESSIONS=37
readonly E_FOCUS_REQUIRED=38

# Session status values
readonly SESSION_STATUS_ACTIVE="active"
readonly SESSION_STATUS_SUSPENDED="suspended"

# Scope types
readonly SCOPE_TYPE_TASK="task"
readonly SCOPE_TYPE_TASKGROUP="taskGroup"
readonly SCOPE_TYPE_SUBTREE="subtree"
readonly SCOPE_TYPE_EPICPHASE="epicPhase"
readonly SCOPE_TYPE_EPIC="epic"
readonly SCOPE_TYPE_CUSTOM="custom"

# Conflict types
readonly CONFLICT_NONE="none"
readonly CONFLICT_PARTIAL="partial"
readonly CONFLICT_NESTED="nested"
readonly CONFLICT_IDENTICAL="identical"
readonly CONFLICT_HARD="hard"

# ============================================================================
# FILE PATH RESOLUTION
# ============================================================================

# Get sessions.json file path
# Returns: Path to sessions.json
get_sessions_file() {
    echo "$(get_cleo_dir)/sessions.json"
}

# ============================================================================
# MULTI-SESSION MODE CHECK
# ============================================================================

# Check if multi-session mode is enabled
# Args: $1 - config file path (optional)
# Returns: 0 if enabled, 1 if disabled
is_multi_session_enabled() {
    local config_file="${1:-$(get_config_file)}"

    if [[ ! -f "$config_file" ]]; then
        return 1
    fi

    local enabled
    enabled=$(jq -r '.multiSession.enabled // false' "$config_file" 2>/dev/null)

    [[ "$enabled" == "true" ]]
}

# ============================================================================
# SESSION ID GENERATION
# ============================================================================

# Generate unique session ID
# Format: session_YYYYMMDD_HHMMSS_<6hex>
# Returns: Session ID string
generate_session_id() {
    local date_part random_hex
    date_part=$(date +"%Y%m%d_%H%M%S")
    random_hex=$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')
    echo "session_${date_part}_${random_hex}"
}

# ============================================================================
# SESSIONS.JSON INITIALIZATION
# ============================================================================

# Initialize sessions.json if it doesn't exist
# Args: $1 - sessions file path
# Returns: 0 on success, non-zero on error
init_sessions_file() {
    local sessions_file="${1:-$(get_sessions_file)}"

    if [[ -f "$sessions_file" ]]; then
        return 0
    fi

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    local project_name
    project_name=$(basename "$(pwd)")

    local initial_content
    initial_content=$(jq -n \
        --arg version "1.0.0" \
        --arg project "$project_name" \
        --arg ts "$timestamp" \
        '{
            "$schema": "../schemas/sessions.schema.json",
            "version": $version,
            "project": $project,
            "_meta": {
                "checksum": "",
                "lastModified": $ts,
                "totalSessionsCreated": 0
            },
            "config": {
                "maxConcurrentSessions": 5,
                "maxActiveTasksPerScope": 1,
                "scopeValidation": "strict",
                "allowNestedScopes": true,
                "allowScopeOverlap": false
            },
            "sessions": [],
            "sessionHistory": []
        }')

    if ! save_json "$sessions_file" "$initial_content"; then
        echo "Error: Failed to initialize sessions.json" >&2
        return 1
    fi

    return 0
}

# ============================================================================
# SCOPE COMPUTATION
# ============================================================================

# Compute tasks in scope based on scope definition
# Args:
#   $1 - todo.json content (JSON string)
#   $2 - scope definition (JSON string)
# Returns: JSON array of task IDs
compute_scope_tasks() {
    local todo_content="$1"
    local scope_def="$2"

    local scope_type root_task_id phase_filter max_depth exclude_ids
    scope_type=$(echo "$scope_def" | jq -r '.type')
    root_task_id=$(echo "$scope_def" | jq -r '.rootTaskId // ""')
    phase_filter=$(echo "$scope_def" | jq -r '.phaseFilter // ""')
    max_depth=$(echo "$scope_def" | jq -r '.maxDepth // 10')
    exclude_ids=$(echo "$scope_def" | jq -c '.excludeTaskIds // []')

    case "$scope_type" in
        task)
            # Single task only
            echo "[\"$root_task_id\"]"
            ;;
        taskGroup)
            # Parent + direct children
            echo "$todo_content" | jq -c --arg root "$root_task_id" '
                [.tasks[] | select(.id == $root or .parentId == $root) | .id]
            '
            ;;
        subtree)
            # Parent + all descendants (recursive)
            _compute_subtree "$todo_content" "$root_task_id" "$max_depth"
            ;;
        epicPhase)
            # Epic filtered by phase
            local epic_tasks
            epic_tasks=$(_compute_subtree "$todo_content" "$root_task_id" "$max_depth")
            echo "$todo_content" | jq -c --argjson ids "$epic_tasks" --arg phase "$phase_filter" '
                [.tasks[] | select(.id as $id | $ids | index($id)) | select(.phase == $phase) | .id]
            '
            ;;
        epic)
            # Full epic tree
            _compute_subtree "$todo_content" "$root_task_id" "$max_depth"
            ;;
        custom)
            # Explicit task list (passed in scope definition)
            echo "$scope_def" | jq -c '.taskIds // []'
            ;;
        *)
            echo "[]"
            ;;
    esac | jq -c --argjson exclude "$exclude_ids" '. - $exclude'
}

# Helper: Compute subtree recursively
# Args: $1 - todo content, $2 - root ID, $3 - max depth
_compute_subtree() {
    local todo_content="$1"
    local root_id="$2"
    local max_depth="${3:-10}"

    echo "$todo_content" | jq -c --arg root "$root_id" --argjson maxDepth "$max_depth" '
        def descendants($id; $depth):
            if $depth <= 0 then []
            else
                [.tasks[] | select(.parentId == $id) | .id] as $children |
                $children + ([$children[] | descendants(.; $depth - 1)] | flatten)
            end;

        [$root] + (.tasks as $tasks | descendants($root; $maxDepth))
    '
}

# ============================================================================
# CONFLICT DETECTION
# ============================================================================

# Check for scope conflicts with existing sessions
# Args:
#   $1 - sessions.json content
#   $2 - new scope computed task IDs (JSON array)
#   $3 - config file path (optional)
# Returns: JSON object with conflict info
# Output: { "type": "none|partial|nested|identical|hard", "sessionId": "...", "overlappingTasks": [...] }
detect_scope_conflict() {
    local sessions_content="$1"
    local new_scope_ids="$2"
    local config_file="${3:-$(get_config_file)}"

    # Get configuration
    local allow_nested allow_overlap
    allow_nested=$(jq -r '.config.allowNestedScopes // true' <<< "$sessions_content")
    allow_overlap=$(jq -r '.config.allowScopeOverlap // false' <<< "$sessions_content")

    # Check each active session
    local result
    result=$(echo "$sessions_content" | jq -c --argjson newIds "$new_scope_ids" '
        .sessions[] | select(.status == "active") | {
            sessionId: .id,
            existingIds: .scope.computedTaskIds,
            currentTask: .focus.currentTask
        }
    ' | while read -r session_info; do
        local session_id existing_ids current_task
        session_id=$(echo "$session_info" | jq -r '.sessionId')
        existing_ids=$(echo "$session_info" | jq -c '.existingIds')
        current_task=$(echo "$session_info" | jq -r '.currentTask // ""')

        # Calculate overlap
        local overlap
        overlap=$(jq -nc --argjson new "$new_scope_ids" --argjson existing "$existing_ids" '
            $new | map(select(. as $id | $existing | index($id)))
        ')

        local overlap_count new_count existing_count
        overlap_count=$(echo "$overlap" | jq 'length')
        new_count=$(echo "$new_scope_ids" | jq 'length')
        existing_count=$(echo "$existing_ids" | jq 'length')

        # Check for HARD conflict (same currentTask)
        if [[ -n "$current_task" ]] && echo "$new_scope_ids" | jq -e --arg id "$current_task" 'index($id)' >/dev/null 2>&1; then
            echo "{\"type\":\"$CONFLICT_HARD\",\"sessionId\":\"$session_id\",\"overlappingTasks\":$overlap,\"message\":\"Task $current_task already focused by session $session_id\"}"
            return
        fi

        if [[ "$overlap_count" -eq 0 ]]; then
            continue
        fi

        # Check for IDENTICAL
        if [[ "$overlap_count" -eq "$new_count" ]] && [[ "$overlap_count" -eq "$existing_count" ]]; then
            echo "{\"type\":\"$CONFLICT_IDENTICAL\",\"sessionId\":\"$session_id\",\"overlappingTasks\":$overlap}"
            return
        fi

        # Check for NESTED
        if [[ "$overlap_count" -eq "$new_count" ]] || [[ "$overlap_count" -eq "$existing_count" ]]; then
            echo "{\"type\":\"$CONFLICT_NESTED\",\"sessionId\":\"$session_id\",\"overlappingTasks\":$overlap}"
            return
        fi

        # PARTIAL overlap
        echo "{\"type\":\"$CONFLICT_PARTIAL\",\"sessionId\":\"$session_id\",\"overlappingTasks\":$overlap}"
        return
    done)

    # If no conflicts found
    if [[ -z "$result" ]]; then
        echo "{\"type\":\"$CONFLICT_NONE\",\"sessionId\":null,\"overlappingTasks\":[]}"
    else
        echo "$result"
    fi
}

# Validate scope conflict based on configuration
# Args:
#   $1 - conflict info (from detect_scope_conflict)
#   $2 - sessions.json content
# Returns: 0 if allowed, non-zero if blocked
# Outputs: Error message to stderr if blocked
validate_scope_conflict() {
    local conflict_info="$1"
    local sessions_content="$2"

    local conflict_type session_id
    conflict_type=$(echo "$conflict_info" | jq -r '.type')
    session_id=$(echo "$conflict_info" | jq -r '.sessionId // ""')

    case "$conflict_type" in
        none)
            return 0
            ;;
        hard)
            local message
            message=$(echo "$conflict_info" | jq -r '.message // "Task already claimed"')
            echo "Error: HARD conflict - $message" >&2
            return $E_TASK_CLAIMED
            ;;
        identical)
            echo "Error: Scope identical to session $session_id" >&2
            return $E_SCOPE_CONFLICT
            ;;
        nested)
            local allow_nested
            allow_nested=$(echo "$sessions_content" | jq -r '.config.allowNestedScopes // true')
            if [[ "$allow_nested" != "true" ]]; then
                echo "Error: Scope nested within session $session_id (allowNestedScopes=false)" >&2
                return $E_SCOPE_CONFLICT
            fi
            echo "Warning: Scope nested within session $session_id" >&2
            return 0
            ;;
        partial)
            local allow_overlap
            allow_overlap=$(echo "$sessions_content" | jq -r '.config.allowScopeOverlap // false')
            if [[ "$allow_overlap" != "true" ]]; then
                echo "Error: Scope overlaps with session $session_id (allowScopeOverlap=false)" >&2
                return $E_SCOPE_CONFLICT
            fi
            echo "Warning: Scope overlaps with session $session_id" >&2
            return 0
            ;;
        *)
            return 0
            ;;
    esac
}

# ============================================================================
# SESSION LIFECYCLE
# ============================================================================

# Start a new session
# Args:
#   $1 - scope definition (JSON)
#   $2 - focus task ID (required)
#   $3 - session name (optional)
#   $4 - agent ID (optional)
# Returns: Session ID on success, error on failure
start_session() {
    local scope_def="$1"
    local focus_task="${2:-}"
    local session_name="${3:-}"
    local agent_id="${4:-}"

    local sessions_file todo_file
    sessions_file=$(get_sessions_file)
    todo_file=$(get_todo_file)

    # Validate focus task is provided
    if [[ -z "$focus_task" ]]; then
        echo "Error: Session requires --focus <task-id> or --auto-focus" >&2
        return $E_FOCUS_REQUIRED
    fi

    # Initialize sessions file if needed
    if ! init_sessions_file "$sessions_file"; then
        return 1
    fi

    # Lock sessions.json first (per lock order convention)
    local sessions_fd
    if ! lock_file "$sessions_file" sessions_fd 30; then
        echo "Error: Failed to acquire lock on sessions.json" >&2
        return $FO_LOCK_FAILED
    fi

    # Lock todo.json second
    local todo_fd
    if ! lock_file "$todo_file" todo_fd 30; then
        unlock_file "$sessions_fd"
        echo "Error: Failed to acquire lock on todo.json" >&2
        return $FO_LOCK_FAILED
    fi

    # Set up cleanup trap
    trap "unlock_file $todo_fd; unlock_file $sessions_fd" EXIT ERR

    # Load current content
    local sessions_content todo_content
    sessions_content=$(cat "$sessions_file")
    todo_content=$(cat "$todo_file")

    # Check max sessions
    local active_count max_sessions
    active_count=$(echo "$sessions_content" | jq '[.sessions[] | select(.status == "active")] | length')
    max_sessions=$(echo "$sessions_content" | jq '.config.maxConcurrentSessions // 5')

    if [[ "$active_count" -ge "$max_sessions" ]]; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Maximum concurrent sessions reached ($max_sessions)" >&2
        return $E_MAX_SESSIONS
    fi

    # Compute scope tasks
    local computed_ids
    computed_ids=$(compute_scope_tasks "$todo_content" "$scope_def")

    if [[ "$(echo "$computed_ids" | jq 'length')" -eq 0 ]]; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Scope is empty - no tasks match criteria" >&2
        return $E_SCOPE_INVALID
    fi

    # Validate focus task is in scope
    if ! echo "$computed_ids" | jq -e --arg id "$focus_task" 'index($id)' >/dev/null 2>&1; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Focus task $focus_task is not in scope" >&2
        return $E_TASK_NOT_IN_SCOPE
    fi

    # Check for conflicts
    local conflict_info
    conflict_info=$(detect_scope_conflict "$sessions_content" "$computed_ids")

    if ! validate_scope_conflict "$conflict_info" "$sessions_content"; then
        local conflict_code=$?
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        return $conflict_code
    fi

    # Generate session ID
    local session_id timestamp
    session_id=$(generate_session_id)
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Create session entry
    local session_entry
    session_entry=$(jq -n \
        --arg id "$session_id" \
        --arg name "$session_name" \
        --arg agent "$agent_id" \
        --argjson scope "$scope_def" \
        --argjson computedIds "$computed_ids" \
        --arg focus "$focus_task" \
        --arg ts "$timestamp" \
        '{
            id: $id,
            status: "active",
            name: (if $name == "" then null else $name end),
            agentId: (if $agent == "" then null else $agent end),
            scope: ($scope + {computedTaskIds: $computedIds}),
            focus: {
                currentTask: $focus,
                currentPhase: null,
                previousTask: null,
                sessionNote: null,
                nextAction: null,
                focusHistory: [{
                    taskId: $focus,
                    timestamp: $ts,
                    action: "focused"
                }]
            },
            startedAt: $ts,
            lastActivity: $ts,
            suspendedAt: null,
            stats: {
                tasksCompleted: 0,
                focusChanges: 1,
                suspendCount: 0,
                resumeCount: 0
            }
        }')

    # Update sessions.json
    local updated_sessions
    updated_sessions=$(echo "$sessions_content" | jq \
        --argjson entry "$session_entry" \
        --arg ts "$timestamp" \
        '
        .sessions += [$entry] |
        ._meta.lastModified = $ts |
        ._meta.totalSessionsCreated += 1
        ')

    # Update todo.json - set task to active, update meta
    local updated_todo
    updated_todo=$(echo "$todo_content" | jq \
        --arg taskId "$focus_task" \
        --arg ts "$timestamp" \
        --arg sessionId "$session_id" \
        '
        # Reset any other active tasks in scope to pending
        .tasks = [.tasks[] | if .status == "active" then .status = "pending" else . end] |
        # Set focus task to active
        .tasks = [.tasks[] | if .id == $taskId then .status = "active" | .updatedAt = $ts else . end] |
        # Update meta
        ._meta.lastModified = $ts |
        ._meta.multiSessionEnabled = true |
        ._meta.activeSessionCount = (._meta.activeSessionCount // 0) + 1
        ')

    # Save both files
    if ! echo "$updated_sessions" | jq '.' > "$sessions_file.tmp"; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        rm -f "$sessions_file.tmp"
        echo "Error: Failed to write sessions.json" >&2
        return 1
    fi
    mv "$sessions_file.tmp" "$sessions_file"

    if ! echo "$updated_todo" | jq '.' > "$todo_file.tmp"; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        rm -f "$todo_file.tmp"
        echo "Error: Failed to write todo.json" >&2
        return 1
    fi
    mv "$todo_file.tmp" "$todo_file"

    # Cleanup
    unlock_file "$todo_fd"
    unlock_file "$sessions_fd"
    trap - EXIT ERR

    echo "$session_id"
    return 0
}

# Suspend a session
# Args: $1 - session ID, $2 - note (optional)
# Returns: 0 on success
suspend_session() {
    local session_id="$1"
    local note="${2:-}"

    local sessions_file
    sessions_file=$(get_sessions_file)

    # Lock and load
    local sessions_fd
    if ! lock_file "$sessions_file" sessions_fd 30; then
        echo "Error: Failed to acquire lock on sessions.json" >&2
        return $FO_LOCK_FAILED
    fi

    trap "unlock_file $sessions_fd" EXIT ERR

    local sessions_content
    sessions_content=$(cat "$sessions_file")

    # Verify session exists and is active
    local session_status
    session_status=$(echo "$sessions_content" | jq -r --arg id "$session_id" '
        .sessions[] | select(.id == $id) | .status
    ')

    if [[ -z "$session_status" ]]; then
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Session not found: $session_id" >&2
        return $E_SESSION_NOT_FOUND
    fi

    if [[ "$session_status" != "active" ]]; then
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Session is not active: $session_id" >&2
        return $E_SESSION_SUSPENDED
    fi

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Update session
    local updated_sessions
    updated_sessions=$(echo "$sessions_content" | jq \
        --arg id "$session_id" \
        --arg ts "$timestamp" \
        --arg note "$note" \
        '
        .sessions = [.sessions[] |
            if .id == $id then
                .status = "suspended" |
                .suspendedAt = $ts |
                .lastActivity = $ts |
                .stats.suspendCount += 1 |
                (if $note != "" then .focus.sessionNote = $note else . end)
            else . end
        ] |
        ._meta.lastModified = $ts
        ')

    if ! save_json "$sessions_file" "$updated_sessions"; then
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Failed to save sessions.json" >&2
        return 1
    fi

    unlock_file "$sessions_fd"
    trap - EXIT ERR

    return 0
}

# Resume a suspended session
# Args: $1 - session ID
# Returns: 0 on success
resume_session() {
    local session_id="$1"

    local sessions_file todo_file
    sessions_file=$(get_sessions_file)
    todo_file=$(get_todo_file)

    # Lock both files (sessions first per convention)
    local sessions_fd todo_fd
    if ! lock_file "$sessions_file" sessions_fd 30; then
        echo "Error: Failed to acquire lock on sessions.json" >&2
        return $FO_LOCK_FAILED
    fi

    if ! lock_file "$todo_file" todo_fd 30; then
        unlock_file "$sessions_fd"
        echo "Error: Failed to acquire lock on todo.json" >&2
        return $FO_LOCK_FAILED
    fi

    trap "unlock_file $todo_fd; unlock_file $sessions_fd" EXIT ERR

    local sessions_content todo_content
    sessions_content=$(cat "$sessions_file")
    todo_content=$(cat "$todo_file")

    # Verify session exists and is suspended
    local session_info
    session_info=$(echo "$sessions_content" | jq -c --arg id "$session_id" '
        .sessions[] | select(.id == $id)
    ')

    if [[ -z "$session_info" ]]; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Session not found: $session_id" >&2
        return $E_SESSION_NOT_FOUND
    fi

    local session_status focus_task
    session_status=$(echo "$session_info" | jq -r '.status')
    focus_task=$(echo "$session_info" | jq -r '.focus.currentTask // ""')

    if [[ "$session_status" != "suspended" ]]; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Session is not suspended: $session_id" >&2
        return $E_SESSION_EXISTS
    fi

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Update session
    local updated_sessions
    updated_sessions=$(echo "$sessions_content" | jq \
        --arg id "$session_id" \
        --arg ts "$timestamp" \
        '
        .sessions = [.sessions[] |
            if .id == $id then
                .status = "active" |
                .suspendedAt = null |
                .lastActivity = $ts |
                .stats.resumeCount += 1
            else . end
        ] |
        ._meta.lastModified = $ts
        ')

    # Restore focus task to active if it exists
    local updated_todo="$todo_content"
    if [[ -n "$focus_task" ]]; then
        updated_todo=$(echo "$todo_content" | jq \
            --arg taskId "$focus_task" \
            --arg ts "$timestamp" \
            '
            .tasks = [.tasks[] | if .id == $taskId then .status = "active" | .updatedAt = $ts else . end] |
            ._meta.lastModified = $ts
            ')
    fi

    # Save both files
    if ! save_json "$sessions_file" "$updated_sessions"; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Failed to save sessions.json" >&2
        return 1
    fi

    if ! save_json "$todo_file" "$updated_todo"; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Failed to save todo.json" >&2
        return 1
    fi

    unlock_file "$todo_fd"
    unlock_file "$sessions_fd"
    trap - EXIT ERR

    return 0
}

# End a session
# Args: $1 - session ID, $2 - note (optional)
# Returns: 0 on success
end_session() {
    local session_id="$1"
    local note="${2:-}"

    local sessions_file todo_file
    sessions_file=$(get_sessions_file)
    todo_file=$(get_todo_file)

    # Lock both files
    local sessions_fd todo_fd
    if ! lock_file "$sessions_file" sessions_fd 30; then
        echo "Error: Failed to acquire lock on sessions.json" >&2
        return $FO_LOCK_FAILED
    fi

    if ! lock_file "$todo_file" todo_fd 30; then
        unlock_file "$sessions_fd"
        echo "Error: Failed to acquire lock on todo.json" >&2
        return $FO_LOCK_FAILED
    fi

    trap "unlock_file $todo_fd; unlock_file $sessions_fd" EXIT ERR

    local sessions_content todo_content
    sessions_content=$(cat "$sessions_file")
    todo_content=$(cat "$todo_file")

    # Get session info before removal
    local session_info
    session_info=$(echo "$sessions_content" | jq -c --arg id "$session_id" '
        .sessions[] | select(.id == $id)
    ')

    if [[ -z "$session_info" ]]; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Session not found: $session_id" >&2
        return $E_SESSION_NOT_FOUND
    fi

    local focus_task
    focus_task=$(echo "$session_info" | jq -r '.focus.currentTask // ""')

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Create history entry and remove from active sessions
    local updated_sessions
    updated_sessions=$(echo "$sessions_content" | jq \
        --arg id "$session_id" \
        --arg ts "$timestamp" \
        --arg note "$note" \
        '
        # Find and prepare session for history
        (.sessions[] | select(.id == $id)) as $session |

        # Remove from sessions
        .sessions = [.sessions[] | select(.id != $id)] |

        # Add to history
        .sessionHistory += [{
            id: $session.id,
            name: $session.name,
            agentId: $session.agentId,
            scopeType: $session.scope.type,
            rootTaskId: $session.scope.rootTaskId,
            startedAt: $session.startedAt,
            endedAt: $ts,
            stats: $session.stats,
            endNote: (if $note == "" then null else $note end),
            resumable: true
        }] |

        ._meta.lastModified = $ts
        ')

    # Reset focus task to pending if it exists and was active
    local updated_todo="$todo_content"
    if [[ -n "$focus_task" ]]; then
        updated_todo=$(echo "$todo_content" | jq \
            --arg taskId "$focus_task" \
            --arg ts "$timestamp" \
            '
            .tasks = [.tasks[] |
                if .id == $taskId and .status == "active" then
                    .status = "pending" | .updatedAt = $ts
                else . end
            ] |
            ._meta.lastModified = $ts |
            ._meta.activeSessionCount = ([._meta.activeSessionCount - 1, 0] | max)
            ')
    fi

    # Save both files
    if ! save_json "$sessions_file" "$updated_sessions"; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Failed to save sessions.json" >&2
        return 1
    fi

    if ! save_json "$todo_file" "$updated_todo"; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Failed to save todo.json" >&2
        return 1
    fi

    unlock_file "$todo_fd"
    unlock_file "$sessions_fd"
    trap - EXIT ERR

    return 0
}

# ============================================================================
# SESSION QUERIES
# ============================================================================

# List active sessions
# Args: $1 - status filter (optional: "active", "suspended", "all")
# Returns: JSON array of sessions
list_sessions() {
    local status_filter="${1:-all}"
    local sessions_file
    sessions_file=$(get_sessions_file)

    if [[ ! -f "$sessions_file" ]]; then
        echo "[]"
        return 0
    fi

    case "$status_filter" in
        active)
            jq -c '[.sessions[] | select(.status == "active")]' "$sessions_file"
            ;;
        suspended)
            jq -c '[.sessions[] | select(.status == "suspended")]' "$sessions_file"
            ;;
        all|*)
            jq -c '.sessions' "$sessions_file"
            ;;
    esac
}

# Get session by ID
# Args: $1 - session ID
# Returns: Session JSON or empty
get_session() {
    local session_id="$1"
    local sessions_file
    sessions_file=$(get_sessions_file)

    if [[ ! -f "$sessions_file" ]]; then
        return 1
    fi

    jq -c --arg id "$session_id" '.sessions[] | select(.id == $id)' "$sessions_file"
}

# Get current session for environment
# Checks CLEO_SESSION env var, then .current-session file
# Returns: Session ID or empty
get_current_session_id() {
    # Check environment variable first
    if [[ -n "${CLEO_SESSION:-}" ]]; then
        echo "$CLEO_SESSION"
        return 0
    fi

    # Check .current-session file
    local current_session_file
    current_session_file="$(get_cleo_dir)/.current-session"

    if [[ -f "$current_session_file" ]]; then
        cat "$current_session_file" | tr -d '[:space:]'
        return 0
    fi

    return 1
}

# Auto-focus: Select highest priority pending task in scope
# Args: $1 - todo content (JSON), $2 - computed task IDs (JSON array)
# Returns: Task ID or empty
auto_select_focus_task() {
    local todo_content="$1"
    local scope_ids="$2"

    echo "$todo_content" | jq -r --argjson ids "$scope_ids" '
        # Priority order: critical=4, high=3, medium=2, low=1
        def priority_score:
            if . == "critical" then 4
            elif . == "high" then 3
            elif . == "medium" then 2
            else 1 end;

        [.tasks[] |
            select(.id as $id | $ids | index($id)) |
            select(.status == "pending")
        ] |
        sort_by([(.priority | priority_score) * -1, .createdAt]) |
        .[0].id // ""
    '
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f get_sessions_file
export -f is_multi_session_enabled
export -f generate_session_id
export -f init_sessions_file
export -f compute_scope_tasks
export -f detect_scope_conflict
export -f validate_scope_conflict
export -f start_session
export -f suspend_session
export -f resume_session
export -f end_session
export -f list_sessions
export -f get_session
export -f get_current_session_id
export -f auto_select_focus_task
