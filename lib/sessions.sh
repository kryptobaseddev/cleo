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

# Source error-json for LLM-agent-first structured error output
if [[ -f "$_LIB_DIR/error-json.sh" ]]; then
    source "$_LIB_DIR/error-json.sh"
fi

# Source token-estimation for session tracking (T2900)
if [[ -f "$_LIB_DIR/token-estimation.sh" ]]; then
    source "$_LIB_DIR/token-estimation.sh"
fi

# Source metrics-aggregation for session metrics capture (T1996/T2000)
if [[ -f "$_LIB_DIR/metrics-aggregation.sh" ]]; then
    source "$_LIB_DIR/metrics-aggregation.sh"
fi

# ============================================================================
# CONSTANTS
# ============================================================================

# Error codes for multi-session operations (30-39 range per MULTI-SESSION-SPEC.md)
# Use error-json.sh definitions if available, otherwise define here
: "${E_SESSION_EXISTS:=E_SESSION_EXISTS}"
: "${E_SESSION_NOT_FOUND:=E_SESSION_NOT_FOUND}"
: "${E_SCOPE_CONFLICT:=E_SCOPE_CONFLICT}"
: "${E_SCOPE_INVALID:=E_SCOPE_INVALID}"
: "${E_TASK_NOT_IN_SCOPE:=E_TASK_NOT_IN_SCOPE}"
: "${E_TASK_CLAIMED:=E_TASK_CLAIMED}"
: "${E_SESSION_SUSPENDED:=E_SESSION_SUSPENDED}"
: "${E_MAX_SESSIONS:=E_MAX_SESSIONS}"
: "${E_FOCUS_REQUIRED:=E_FOCUS_REQUIRED}"

# Session status values
readonly SESSION_STATUS_ACTIVE="active"
readonly SESSION_STATUS_SUSPENDED="suspended"
readonly SESSION_STATUS_ENDED="ended"
readonly SESSION_STATUS_CLOSED="closed"
readonly SESSION_STATUS_ARCHIVED="archived"

# Additional error code for close operation
: "${E_SESSION_ARCHIVE_BLOCKED:=E_SESSION_ARCHIVE_BLOCKED}"
: "${E_SESSION_CLOSE_BLOCKED:=E_SESSION_CLOSE_BLOCKED}"

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
    # Note: Using explicit null check instead of // operator because
    # jq's // treats false as falsy (false // true = true, which is wrong)
    enabled=$(jq -r 'if .multiSession.enabled == null then true else .multiSession.enabled end' "$config_file" 2>/dev/null)

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
    initial_content=$(jq -nc \
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
        # Store tasks array at the top level
        .tasks as $all_tasks |

        def descendants($tasks; $id; $depth):
            if $depth <= 0 then []
            else
                [$tasks[] | select(.parentId == $id) | .id] as $children |
                $children + ([$children[] | descendants($tasks; .; $depth - 1)] | flatten)
            end;

        [$root] + descendants($all_tasks; $root; $maxDepth)
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
            return ${EXIT_TASK_CLAIMED:-35}
            ;;
        identical)
            echo "Error: Scope identical to session $session_id" >&2
            return ${EXIT_SCOPE_CONFLICT:-32}
            ;;
        nested)
            local allow_nested
            allow_nested=$(echo "$sessions_content" | jq -r '.config.allowNestedScopes // true')
            if [[ "$allow_nested" != "true" ]]; then
                echo "Error: Scope nested within session $session_id (allowNestedScopes=false)" >&2
                return ${EXIT_SCOPE_CONFLICT:-32}
            fi
            echo "Warning: Scope nested within session $session_id" >&2
            return 0
            ;;
        partial)
            local allow_overlap
            allow_overlap=$(echo "$sessions_content" | jq -r '.config.allowScopeOverlap // false')
            if [[ "$allow_overlap" != "true" ]]; then
                echo "Error: Scope overlaps with session $session_id (allowScopeOverlap=false)" >&2
                return ${EXIT_SCOPE_CONFLICT:-32}
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

    # Focus task is optional when auto-focus found no pending tasks in scope
    # This allows starting sessions on new epics with no children yet

    # Initialize sessions file if needed
    if ! init_sessions_file "$sessions_file"; then
        return 1
    fi

    # Initialize context states directory and migrate singleton if needed
    init_context_states_dir

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

    # Check max sessions (read from project config, not sessions.json)
    local active_count max_sessions config_file
    active_count=$(echo "$sessions_content" | jq '[.sessions[] | select(.status == "active")] | length')
    config_file=$(get_config_file)
    max_sessions=$(jq -r '.multiSession.maxConcurrentSessions // 5' "$config_file" 2>/dev/null || echo "5")

    if [[ "$active_count" -ge "$max_sessions" ]]; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Maximum concurrent sessions reached ($max_sessions)" >&2
        return 30  # Max sessions reached
    fi

    # Validate root task exists (for non-custom scopes)
    local scope_type root_task_id
    scope_type=$(echo "$scope_def" | jq -r '.type')
    root_task_id=$(echo "$scope_def" | jq -r '.rootTaskId // ""')

    if [[ -n "$root_task_id" ]] && [[ "$scope_type" != "custom" ]]; then
        local root_exists
        root_exists=$(echo "$todo_content" | jq --arg id "$root_task_id" '[.tasks[] | select(.id == $id)] | length')
        if [[ "$root_exists" -eq 0 ]]; then
            unlock_file "$todo_fd"
            unlock_file "$sessions_fd"
            trap - EXIT ERR
            echo "Error: Scope invalid - root task $root_task_id not found" >&2
            return ${EXIT_SCOPE_INVALID:-33}
        fi
    fi

    # Compute scope tasks
    local computed_ids
    computed_ids=$(compute_scope_tasks "$todo_content" "$scope_def")

    if [[ "$(echo "$computed_ids" | jq 'length')" -eq 0 ]]; then
        if [[ -n "$focus_task" ]]; then
            unlock_file "$todo_fd"
            unlock_file "$sessions_fd"
            trap - EXIT ERR
            echo "Error: Scope is empty - no tasks match criteria" >&2
            return ${EXIT_SCOPE_INVALID:-33}
        fi
        # Allow empty scope when no focus (new epic with no children)
        echo "Warning: Scope is empty - session started without focus. Add tasks to the epic." >&2
    fi

    # Validate focus task is in scope (skip when no focus task)
    if [[ -n "$focus_task" ]]; then
        if ! echo "$computed_ids" | jq -e --arg id "$focus_task" 'index($id)' >/dev/null 2>&1; then
            unlock_file "$todo_fd"
            unlock_file "$sessions_fd"
            trap - EXIT ERR
            echo "Error: Focus task $focus_task is not in scope" >&2
            return ${EXIT_TASK_NOT_IN_SCOPE:-34}
        fi
    fi

    # Check for conflicts
    local conflict_info conflict_code
    conflict_info=$(detect_scope_conflict "$sessions_content" "$computed_ids")

    # Capture exit code before any other commands (local resets $?)
    validate_scope_conflict "$conflict_info" "$sessions_content" || conflict_code=$?

    if [[ ${conflict_code:-0} -ne 0 ]]; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        return $conflict_code
    fi

    # Generate session ID
    local session_id timestamp
    session_id=$(generate_session_id)
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Capture session start metrics (T1996/T2000)
    local start_metrics="{}"
    if type -t capture_session_start_metrics &>/dev/null; then
        start_metrics=$(capture_session_start_metrics "$session_id")
    fi

    # Create session entry
    local session_entry
    session_entry=$(jq -nc \
        --arg id "$session_id" \
        --arg name "$session_name" \
        --arg agent "$agent_id" \
        --argjson scope "$scope_def" \
        --argjson computedIds "$computed_ids" \
        --arg focus "$focus_task" \
        --arg ts "$timestamp" \
        --argjson startMetrics "$start_metrics" \
        '{
            id: $id,
            status: "active",
            name: (if $name == "" then null else $name end),
            agentId: (if $agent == "" then null else $agent end),
            scope: ($scope + {computedTaskIds: $computedIds}),
            focus: {
                currentTask: (if $focus == "" then null else $focus end),
                currentPhase: null,
                previousTask: null,
                sessionNote: null,
                nextAction: null,
                focusHistory: (if $focus == "" then [] else [{
                    taskId: $focus,
                    timestamp: $ts,
                    action: "focused"
                }] end)
            },
            startedAt: $ts,
            lastActivity: $ts,
            suspendedAt: null,
            stats: {
                tasksCompleted: 0,
                focusChanges: (if $focus == "" then 0 else 1 end),
                suspendCount: 0,
                resumeCount: 0
            },
            startMetrics: $startMetrics
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

    # Save both files using safe mktemp pattern (locks already held)
    local _sess_tmp
    _sess_tmp=$(mktemp "${sessions_file}.XXXXXX")
    if ! echo "$updated_sessions" | jq '.' > "$_sess_tmp"; then
        rm -f "$_sess_tmp"
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Failed to write sessions.json" >&2
        return 1
    fi
    mv "$_sess_tmp" "$sessions_file" || { rm -f "$_sess_tmp"; unlock_file "$todo_fd"; unlock_file "$sessions_fd"; trap - EXIT ERR; return 1; }

    local _todo_tmp
    _todo_tmp=$(mktemp "${todo_file}.XXXXXX")
    if ! echo "$updated_todo" | jq '.' > "$_todo_tmp"; then
        rm -f "$_todo_tmp"
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Failed to write todo.json" >&2
        return 1
    fi
    mv "$_todo_tmp" "$todo_file" || { rm -f "$_todo_tmp"; unlock_file "$todo_fd"; unlock_file "$sessions_fd"; trap - EXIT ERR; return 1; }

    # Cleanup
    unlock_file "$todo_fd"
    unlock_file "$sessions_fd"
    trap - EXIT ERR

    # Capture starting tokens for tracking (T2900)
    if _te_tracking_enabled 2>/dev/null; then
        local start_tokens=0

        # Try to read current token count from most recent context state
        # Context state for this session may not exist yet, so fall back to most recent
        local context_file
        context_file=$(find .cleo -maxdepth 1 -name ".context-state-*.json" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2- || echo "")

        if [[ -n "$context_file" && -f "$context_file" ]]; then
            start_tokens=$(jq -r '.contextWindow.currentTokens // 0' "$context_file" 2>/dev/null || echo 0)
        fi

        # Build context JSON with session metadata
        local scope_type focus_context
        scope_type=$(echo "$scope_def" | jq -r '.type')
        focus_context=$(jq -nc \
            --arg session "$session_id" \
            --arg scope "$scope_type" \
            --arg focus "$focus_task" \
            '{session_id: $session, scope_type: $scope, focus_task: $focus}')

        # Log session start with token count
        # Args: event_type, tokens, source, task_id, context
        log_token_event "session_start" "$start_tokens" "session" "$focus_task" "$focus_context" 2>/dev/null || true
    fi

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
        return ${EXIT_SESSION_NOT_FOUND:-31}
    fi

    if [[ "$session_status" != "active" ]]; then
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Session is not active: $session_id" >&2
        return 30  # Session already suspended
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

    # Write directly using aw_atomic_write (lock already held, avoid double-lock)
    local pretty_json
    pretty_json=$(echo "$updated_sessions" | jq '.')
    if ! aw_atomic_write "$sessions_file" "$pretty_json" "${MAX_BACKUPS:-10}"; then
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Failed to save sessions.json" >&2
        return 1
    fi

    unlock_file "$sessions_fd"
    trap - EXIT ERR

    return 0
}

# Resume a suspended or ended session
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

    # Verify session exists and is resumable (suspended or ended)
    local session_info
    session_info=$(echo "$sessions_content" | jq -c --arg id "$session_id" '
        .sessions[] | select(.id == $id)
    ')

    if [[ -z "$session_info" ]]; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR

        # LLM-Agent-First: Provide actionable error with fix command
        local context_json
        context_json=$(jq -nc --arg sid "$session_id" '{"requestedSessionId": $sid}')

        output_error_actionable \
            "E_SESSION_NOT_FOUND" \
            "Session not found: $session_id" \
            "${EXIT_SESSION_NOT_FOUND:-31}" \
            "true" \
            "Session $session_id does not exist. List available sessions to find the correct ID." \
            "cleo session list" \
            "$context_json" \
            '[{"action": "List all sessions", "command": "cleo session list"}, {"action": "List active sessions", "command": "cleo session list --status active"}, {"action": "Start new session", "command": "cleo session start --scope epic:<EPIC_ID>"}]'

        return ${EXIT_SESSION_NOT_FOUND:-31}
    fi

    local session_status focus_task
    session_status=$(echo "$session_info" | jq -r '.status')
    focus_task=$(echo "$session_info" | jq -r '.focus.currentTask // .focus.previousTask // ""')

    # Allow resuming both "suspended" and "ended" sessions
    if [[ "$session_status" != "suspended" && "$session_status" != "ended" ]]; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR

        # LLM-Agent-First: Provide actionable error with fix command
        local scope_info focus_info
        scope_info=$(echo "$session_info" | jq -r '.scope | "\(.type):\(.rootTaskId // "N/A")"')
        focus_info=$(echo "$session_info" | jq -r '.focus.currentTask // "none"')

        local context_json
        context_json=$(jq -nc \
            --arg sid "$session_id" \
            --arg status "$session_status" \
            --arg scope "$scope_info" \
            --arg focus "$focus_info" \
            '{
                "sessionId": $sid,
                "status": $status,
                "scope": $scope,
                "focusedTask": $focus
            }')

        local alternatives_json
        alternatives_json=$(jq -nc \
            --arg sid "$session_id" \
            '[
                {"action": "Run command directly", "command": "Session is active - just run your command without session start/resume"},
                {"action": "Check session status", "command": "cleo session status"},
                {"action": "Switch to this session", "command": ("cleo session switch " + $sid)}
            ]')

        output_error_actionable \
            "E_SESSION_RESUME_FAILED" \
            "Session cannot be resumed (status: $session_status). Session is already active - run your command directly." \
            "${EXIT_SESSION_EXISTS:-30}" \
            "true" \
            "Session $session_id is already active. You don't need to resume it - just run your command." \
            "cleo session status" \
            "$context_json" \
            "$alternatives_json"

        return ${EXIT_SESSION_EXISTS:-30}
    fi

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Update session - clear both suspendedAt and endedAt
    local updated_sessions
    updated_sessions=$(echo "$sessions_content" | jq \
        --arg id "$session_id" \
        --arg ts "$timestamp" \
        '
        .sessions = [.sessions[] |
            if .id == $id then
                .status = "active" |
                .suspendedAt = null |
                .endedAt = null |
                .lastActivity = $ts |
                .focus.currentTask = (.focus.currentTask // .focus.previousTask) |
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

    # Pretty-print JSON for atomic writes (we already hold locks)
    local pretty_sessions pretty_todo
    pretty_sessions=$(echo "$updated_sessions" | jq '.')
    pretty_todo=$(echo "$updated_todo" | jq '.')

    # Write directly using aw_atomic_write (we already hold locks, so no double-locking)
    if ! aw_atomic_write "$sessions_file" "$pretty_sessions"; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Failed to save sessions.json" >&2
        return 1
    fi

    if ! aw_atomic_write "$todo_file" "$pretty_todo"; then
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

# End a session (ENDED state - notes required, resumable)
# Changed from moving to history - now just changes status to "ended"
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

    # Get session info
    local session_info
    session_info=$(echo "$sessions_content" | jq -c --arg id "$session_id" '
        .sessions[] | select(.id == $id)
    ')

    if [[ -z "$session_info" ]]; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Session not found: $session_id" >&2
        return ${EXIT_SESSION_NOT_FOUND:-31}
    fi

    local focus_task
    focus_task=$(echo "$session_info" | jq -r '.focus.currentTask // ""')

    # Extract start metrics for end metrics calculation (T1996/T2000)
    local start_metrics
    start_metrics=$(echo "$session_info" | jq -c '.startMetrics // {}')

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Update session status to "ended" (NOT moving to history)
    local updated_sessions
    updated_sessions=$(echo "$sessions_content" | jq \
        --arg id "$session_id" \
        --arg ts "$timestamp" \
        --arg note "$note" \
        '
        .sessions = [.sessions[] |
            if .id == $id then
                .status = "ended" |
                .endedAt = $ts |
                .lastActivity = $ts |
                .focus.previousTask = .focus.currentTask |
                .focus.currentTask = null |
                (if $note != "" then .focus.sessionNote = $note else . end)
            else . end
        ] |
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

    # Save both files (using aw_atomic_write directly - locks already held)
    local pretty_sessions pretty_todo
    pretty_sessions=$(echo "$updated_sessions" | jq '.')
    if ! aw_atomic_write "$sessions_file" "$pretty_sessions" "${MAX_BACKUPS:-10}"; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Failed to save sessions.json" >&2
        return 1
    fi

    pretty_todo=$(echo "$updated_todo" | jq '.')
    if ! aw_atomic_write "$todo_file" "$pretty_todo" "${MAX_BACKUPS:-10}"; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Failed to save todo.json" >&2
        return 1
    fi

    unlock_file "$todo_fd"
    unlock_file "$sessions_fd"
    trap - EXIT ERR

    # Finalize token tracking (T2901)
    if type -t _te_tracking_enabled &>/dev/null && _te_tracking_enabled; then
        local context_file
        context_file="$(get_cleo_dir)/.context-state-${session_id}.json"

        local end_tokens=0
        if [[ -f "$context_file" ]]; then
            end_tokens=$(jq -r '.contextWindow.currentTokens // 0' "$context_file" 2>/dev/null || echo 0)
        fi

        # Extract start tokens from session info (from startMetrics)
        local start_tokens
        start_tokens=$(echo "$session_info" | jq -r '.startMetrics.tokens.start // 0')

        # Calculate consumed tokens (handle context resets gracefully)
        local consumed=$((end_tokens - start_tokens))
        [[ $consumed -lt 0 ]] && consumed=0

        # Extract session timestamps and stats for SESSIONS.jsonl
        local start_ts end_ts tasks_done focus_changes
        start_ts=$(echo "$session_info" | jq -r '.startedAt')
        end_ts="$timestamp"
        tasks_done=$(echo "$session_info" | jq -r '.stats.tasksCompleted // 0')
        focus_changes=$(echo "$session_info" | jq -r '.stats.focusChanges // 0')

        # Append to SESSIONS.jsonl
        # @task T3152 - Applied atomic_jsonl_append for flock protection
        # @epic T3147 - Manifest Bash Foundation and Protocol Updates
        local sessions_metrics
        sessions_metrics="$(get_cleo_dir)/metrics/SESSIONS.jsonl"
        mkdir -p "$(dirname "$sessions_metrics")"

        local session_entry
        session_entry=$(jq -n \
            --arg sid "$session_id" \
            --arg start_timestamp "$start_ts" \
            --arg end_timestamp "$end_ts" \
            --argjson start "$start_tokens" \
            --argjson end "$end_tokens" \
            --argjson consumed "$consumed" \
            --argjson tasks_completed "$tasks_done" \
            --argjson focus_changes "$focus_changes" \
            '{
                session_id: $sid,
                start_timestamp: $start_timestamp,
                end_timestamp: $end_timestamp,
                tokens: {
                    start: $start,
                    end: $end,
                    consumed: $consumed,
                    max: 200000
                },
                stats: {
                    tasks_completed: $tasks_completed,
                    focus_changes: $focus_changes
                }
            }')

        atomic_jsonl_append "$sessions_metrics" "$session_entry" 2>/dev/null || true
    fi

    # Capture and log session end metrics (T1996/T2000)
    if type -t capture_session_end_metrics &>/dev/null && type -t log_session_metrics &>/dev/null; then
        local end_metrics
        end_metrics=$(capture_session_end_metrics "$session_id" "$start_metrics")
        log_session_metrics "$end_metrics" >/dev/null 2>&1 || true
    fi

    # Cleanup context state file based on config
    cleanup_context_state_for_session "$session_id" "end"

    return 0
}

# Close a session permanently (CLOSED state - all tasks must be complete)
# Args: $1 - session ID
# Returns: 0 on success, E_SESSION_CLOSE_BLOCKED if tasks incomplete
close_session() {
    local session_id="$1"

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

    # Get session info
    local session_info
    session_info=$(echo "$sessions_content" | jq -c --arg id "$session_id" '
        .sessions[] | select(.id == $id)
    ')

    if [[ -z "$session_info" ]]; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Session not found: $session_id" >&2
        return ${EXIT_SESSION_NOT_FOUND:-31}
    fi

    # Extract start metrics for end metrics calculation (T1996/T2000)
    local start_metrics
    start_metrics=$(echo "$session_info" | jq -c '.startMetrics // {}')

    # Get scope task IDs
    local scope_task_ids
    scope_task_ids=$(echo "$session_info" | jq -c '.scope.computedTaskIds // []')

    # Check if all tasks in scope are complete
    local incomplete_count
    incomplete_count=$(echo "$todo_content" | jq --argjson ids "$scope_task_ids" '
        [.tasks[] | select(.id as $id | $ids | index($id)) | select(.status != "done")] | length
    ')

    if [[ "$incomplete_count" -gt 0 ]]; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Cannot close session - $incomplete_count tasks incomplete" >&2
        echo "Complete all tasks in scope first, or use 'session end' to end without closing" >&2
        return ${EXIT_SESSION_CLOSE_BLOCKED:-37}
    fi

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Get root task ID for Epic completion
    local root_task_id
    root_task_id=$(echo "$session_info" | jq -r '.scope.rootTaskId // ""')

    # Create history entry and remove from sessions
    local session_notes
    session_notes=$(echo "$session_info" | jq -r '.focus.sessionNote // ""')

    local updated_sessions
    updated_sessions=$(echo "$sessions_content" | jq \
        --arg id "$session_id" \
        --arg ts "$timestamp" \
        '
        (.sessions[] | select(.id == $id)) as $session |

        .sessions = [.sessions[] | select(.id != $id)] |

        .sessionHistory += [{
            id: $session.id,
            name: $session.name,
            agentId: $session.agentId,
            scope: $session.scope,
            startedAt: $session.startedAt,
            endedAt: $ts,
            endReason: "completed",
            endNote: $session.focus.sessionNote,
            lastFocusedTask: $session.focus.currentTask,
            stats: $session.stats,
            resumable: false
        }] |

        ._meta.lastModified = $ts
        ')

    # Mark Epic/root task as complete if it exists
    local updated_todo="$todo_content"
    if [[ -n "$root_task_id" ]]; then
        # Aggregate session notes to Epic
        local aggregated_note="Session completed: $session_notes"

        updated_todo=$(echo "$todo_content" | jq \
            --arg taskId "$root_task_id" \
            --arg ts "$timestamp" \
            --arg note "$aggregated_note" \
            '
            .tasks = [.tasks[] |
                if .id == $taskId then
                    .status = "done" |
                    .completedAt = $ts |
                    .updatedAt = $ts |
                    .notes = (.notes // []) + [{
                        timestamp: $ts,
                        type: "session_completion",
                        content: $note
                    }]
                else . end
            ] |
            ._meta.lastModified = $ts
            ')
    fi

    # Save both files (using aw_atomic_write directly - locks already held)
    local pretty_sessions pretty_todo
    pretty_sessions=$(echo "$updated_sessions" | jq '.')
    if ! aw_atomic_write "$sessions_file" "$pretty_sessions" "${MAX_BACKUPS:-10}"; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Failed to save sessions.json" >&2
        return 1
    fi

    pretty_todo=$(echo "$updated_todo" | jq '.')
    if ! aw_atomic_write "$todo_file" "$pretty_todo" "${MAX_BACKUPS:-10}"; then
        unlock_file "$todo_fd"
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Failed to save todo.json" >&2
        return 1
    fi

    unlock_file "$todo_fd"
    unlock_file "$sessions_fd"
    trap - EXIT ERR

    # Capture and log session end metrics (T1996/T2000)
    if type -t capture_session_end_metrics &>/dev/null && type -t log_session_metrics &>/dev/null; then
        local end_metrics
        end_metrics=$(capture_session_end_metrics "$session_id" "$start_metrics")
        log_session_metrics "$end_metrics" >/dev/null 2>&1 || true
    fi

    # Cleanup context state file based on config
    cleanup_context_state_for_session "$session_id" "close"

    echo "Session closed and archived"
    return 0
}

# Archive a session (move to read-only archived status)
# Archives ended/suspended sessions without requiring task completion.
# Args: $1 - session_id, $2 - reason (optional)
# Returns: 0 on success, error code on failure
archive_session() {
    local session_id="$1"
    local reason="${2:-}"

    local sessions_file
    sessions_file=$(get_sessions_file)

    # Lock file
    local sessions_fd
    if ! lock_file "$sessions_file" sessions_fd 30; then
        echo "Error: Failed to acquire lock on sessions.json" >&2
        return $FO_LOCK_FAILED
    fi

    trap "unlock_file $sessions_fd" EXIT ERR

    local sessions_content
    sessions_content=$(cat "$sessions_file")

    # Get session info
    local session_info
    session_info=$(echo "$sessions_content" | jq -c --arg id "$session_id" '
        .sessions[] | select(.id == $id)
    ')

    if [[ -z "$session_info" ]]; then
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Session not found: $session_id" >&2
        return ${EXIT_SESSION_NOT_FOUND:-31}
    fi

    # Check session status - can only archive ended or suspended sessions
    local current_status
    current_status=$(echo "$session_info" | jq -r '.status')

    if [[ "$current_status" != "ended" && "$current_status" != "suspended" ]]; then
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Cannot archive session with status '$current_status'. Only 'ended' or 'suspended' sessions can be archived." >&2
        return ${EXIT_SESSION_ARCHIVE_BLOCKED:-38}
    fi

    if [[ "$current_status" == "archived" ]]; then
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Session is already archived: $session_id" >&2
        return ${EXIT_NO_CHANGE:-102}
    fi

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Update session status to "archived"
    local updated_sessions
    updated_sessions=$(echo "$sessions_content" | jq \
        --arg id "$session_id" \
        --arg ts "$timestamp" \
        --arg reason "$reason" \
        '
        .sessions = [.sessions[] |
            if .id == $id then
                .status = "archived" |
                .archivedAt = $ts |
                .lastActivity = $ts |
                .focus.previousTask = (.focus.previousTask // .focus.currentTask) |
                .focus.currentTask = null |
                (if $reason != "" then .archiveReason = $reason else . end)
            else . end
        ] |
        ._meta.lastModified = $ts
        ')

    # Save sessions file
    local pretty_sessions
    pretty_sessions=$(echo "$updated_sessions" | jq '.')
    if ! aw_atomic_write "$sessions_file" "$pretty_sessions" "${MAX_BACKUPS:-10}"; then
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Failed to save sessions.json" >&2
        return 1
    fi

    unlock_file "$sessions_fd"
    trap - EXIT ERR

    echo "Session archived: $session_id"

    # Cleanup context state file based on config
    cleanup_context_state_for_session "$session_id" "archive"

    return 0
}


# Auto-end stale active sessions beyond retention period
# Uses retention.autoEndActiveAfterDays config (default: 7)
# Only targets 'active' sessions with lastActivity older than threshold
# Args: $1 - dry_run (optional, default: false)
# Returns: Number of sessions ended (or would end if dry_run)
session_auto_end_stale() {
    local dry_run="${1:-false}"

    local sessions_file
    sessions_file=$(get_sessions_file)

    if [[ ! -f "$sessions_file" ]]; then
        echo "0"
        return 0
    fi

    # Get config value for auto-end days (default 7)
    local auto_end_days
    auto_end_days=$(get_config_value "retention.autoEndActiveAfterDays" "7")

    # Calculate cutoff timestamp (sessions older than this will be auto-ended)
    local cutoff_timestamp
    cutoff_timestamp=$(date -u -d "$auto_end_days days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
                      date -u -v-${auto_end_days}d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)

    if [[ -z "$cutoff_timestamp" ]]; then
        echo "Error: Failed to calculate cutoff timestamp" >&2
        return 1
    fi

    # Find active sessions with lastActivity older than cutoff
    local eligible_sessions
    eligible_sessions=$(jq -r --arg cutoff "$cutoff_timestamp" '
        .sessions[] |
        select(
            .status == "active" and
            (.lastActivity < $cutoff)
        ) | .id
    ' "$sessions_file" 2>/dev/null)

    local ended_count=0
    local session_id

    while IFS= read -r session_id; do
        if [[ -z "$session_id" ]]; then
            continue
        fi

        if [[ "$dry_run" == "true" ]]; then
            echo "Would auto-end session: $session_id"
            ((ended_count++)) || true
        else
            # End session with reason indicating automatic ending due to inactivity
            if end_session "$session_id" "Auto-ended after ${auto_end_days} days of inactivity" >/dev/null 2>&1; then
                ((ended_count++)) || true
            fi
        fi
    done <<< "$eligible_sessions"

    echo "$ended_count"
    return 0
}


# Auto-archive sessions inactive beyond retention period
# Uses retention.autoArchiveEndedAfterDays config (default: 30)
# Only archives 'ended' or 'suspended' sessions (never 'active')
# Args: $1 - dry_run (optional, default: false)
# Returns: Number of sessions archived (or would archive if dry_run)
session_auto_archive() {
    local dry_run="${1:-false}"

    local sessions_file
    sessions_file=$(get_sessions_file)

    if [[ ! -f "$sessions_file" ]]; then
        echo "0"
        return 0
    fi

    # Get config for auto-archive days (default 30)
    local auto_archive_days
    auto_archive_days=$(get_config_value "retention.autoArchiveEndedAfterDays" "30")

    # Calculate cutoff timestamp (sessions older than this will be archived)
    local cutoff_timestamp
    cutoff_timestamp=$(date -u -d "$auto_archive_days days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
                      date -u -v-${auto_archive_days}d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)

    if [[ -z "$cutoff_timestamp" ]]; then
        echo "Error: Failed to calculate cutoff timestamp" >&2
        return 1
    fi

    # Find sessions eligible for auto-archive:
    # - Status is 'ended' or 'suspended' (never 'active')
    # - lastActivity is older than cutoff
    local eligible_sessions
    eligible_sessions=$(jq -r --arg cutoff "$cutoff_timestamp" '
        .sessions[] |
        select(
            (.status == "ended" or .status == "suspended") and
            (.lastActivity < $cutoff)
        ) | .id
    ' "$sessions_file" 2>/dev/null)

    local archived_count=0
    local session_id

    while IFS= read -r session_id; do
        if [[ -z "$session_id" ]]; then
            continue
        fi

        if [[ "$dry_run" == "true" ]]; then
            echo "Would auto-archive session: $session_id"
            ((archived_count++)) || true
        else
            # Archive with reason indicating automatic archival
            if archive_session "$session_id" "Auto-archived after ${auto_archive_days} days of inactivity" >/dev/null 2>&1; then
                ((archived_count++)) || true
            fi
        fi
    done <<< "$eligible_sessions"

    echo "$archived_count"
    return 0
}

# ============================================================================
# CONTEXT STATE MANAGEMENT
# ============================================================================

# Get the context state file path for a session
# Args: $1 - session ID
# Returns: Path to the context state file (may not exist)
get_context_state_path_for_session() {
    local session_id="$1"
    local cleo_dir="${CLEO_PROJECT_DIR:-$(get_cleo_dir)}"
    local project_root="${cleo_dir%/.cleo}"

    # Get config values with defaults
    local context_dir filename_pattern
    context_dir=$(get_config_value "contextStates.directory" ".cleo/context-states")
    filename_pattern=$(get_config_value "contextStates.filenamePattern" "context-state-{sessionId}.json")

    local full_dir="${project_root}/${context_dir}"

    if [[ -n "$session_id" ]]; then
        # Replace {sessionId} placeholder with actual session ID
        local filename="${filename_pattern//\{sessionId\}/$session_id}"
        echo "${full_dir}/${filename}"
    else
        # Fallback to singleton in .cleo directory (legacy behavior)
        echo "${cleo_dir}/.context-state.json"
    fi
}

# Cleanup context state file for a session based on config and lifecycle event
# Args: $1 - session ID, $2 - event (end|close|archive)
# Returns: 0 on success, 1 on error
cleanup_context_state_for_session() {
    local session_id="$1"
    local event="${2:-end}"

    if [[ -z "$session_id" ]]; then
        return 0
    fi

    # Check config for cleanup setting based on event
    local should_cleanup="true"
    case "$event" in
        end)
            should_cleanup=$(get_config_value "contextStates.cleanupOnSessionEnd" "true")
            ;;
        close)
            should_cleanup=$(get_config_value "contextStates.cleanupOnSessionClose" "true")
            ;;
        archive)
            should_cleanup=$(get_config_value "contextStates.cleanupOnSessionArchive" "true")
            ;;
    esac

    if [[ "$should_cleanup" != "true" ]]; then
        return 0
    fi

    local cleo_dir="${CLEO_PROJECT_DIR:-$(get_cleo_dir)}"

    # Get the state file path from config-based location
    local state_file
    state_file=$(get_context_state_path_for_session "$session_id")

    # Delete if exists
    if [[ -f "$state_file" ]]; then
        rm -f "$state_file" 2>/dev/null || true
    fi

    # Also check and delete legacy location (.cleo/.context-state-{sessionId}.json)
    local legacy_file="${cleo_dir}/.context-state-${session_id}.json"
    if [[ -f "$legacy_file" ]]; then
        rm -f "$legacy_file" 2>/dev/null || true
    fi

    return 0
}

# Cleanup orphaned context state files (files without corresponding sessions)
# Args: $1 - dry-run mode (optional: "true" for dry-run)
# Returns: 0 on success, outputs count of cleaned files
cleanup_orphaned_context_states() {
    local dry_run="${1:-false}"
    local cleo_dir="${CLEO_PROJECT_DIR:-$(get_cleo_dir)}"
    local project_root="${cleo_dir%/.cleo}"
    local sessions_file
    sessions_file=$(get_sessions_file)

    # Get config for context state directory
    local context_dir
    context_dir=$(get_config_value "contextStates.directory" ".cleo/context-states")
    local full_dir="${project_root}/${context_dir}"

    # Get max orphaned files to retain
    local max_orphaned
    max_orphaned=$(get_config_value "contextStates.maxOrphanedFiles" "10")

    # Get all session IDs (active and in history)
    local session_ids
    if [[ -f "$sessions_file" ]]; then
        session_ids=$(jq -r '
            ([.sessions[].id] + [.sessionHistory[].id]) | unique | .[]
        ' "$sessions_file" 2>/dev/null)
    else
        session_ids=""
    fi

    local cleaned_count=0
    local orphaned_files=()

    # Check new location (.cleo/context-states/)
    if [[ -d "$full_dir" ]]; then
        while IFS= read -r -d '' file; do
            local filename
            filename=$(basename "$file")

            # Extract session ID from filename (context-state-{sessionId}.json)
            local session_id
            session_id=$(echo "$filename" | sed -n 's/^context-state-\(.*\)\.json$/\1/p')

            if [[ -n "$session_id" ]]; then
                # Check if session exists
                if ! echo "$session_ids" | grep -qF "$session_id"; then
                    orphaned_files+=("$file")
                fi
            fi
        done < <(find "$full_dir" -name "context-state-*.json" -type f -print0 2>/dev/null)
    fi

    # Check legacy location (.cleo/.context-state-*.json)
    while IFS= read -r -d '' file; do
        local filename
        filename=$(basename "$file")

        # Skip singleton file
        if [[ "$filename" == ".context-state.json" ]]; then
            continue
        fi

        # Extract session ID from filename (.context-state-{sessionId}.json)
        local session_id
        session_id=$(echo "$filename" | sed -n 's/^\.context-state-\(.*\)\.json$/\1/p')

        if [[ -n "$session_id" ]]; then
            # Check if session exists
            if ! echo "$session_ids" | grep -qF "$session_id"; then
                orphaned_files+=("$file")
            fi
        fi
    done < <(find "$cleo_dir" -maxdepth 1 -name ".context-state-*.json" -type f -print0 2>/dev/null)

    # Sort orphaned files by modification time (oldest first)
    local sorted_orphaned=()
    if [[ ${#orphaned_files[@]} -gt 0 ]]; then
        while IFS= read -r file; do
            sorted_orphaned+=("$file")
        done < <(printf '%s\n' "${orphaned_files[@]}" | xargs -d '\n' ls -1t 2>/dev/null | tac)
    fi

    # Calculate how many to delete (keep max_orphaned newest)
    local total_orphaned=${#sorted_orphaned[@]}
    local to_delete=$((total_orphaned - max_orphaned))
    if [[ $to_delete -lt 0 ]]; then
        to_delete=0
    fi

    # Delete oldest orphaned files
    for ((i=0; i<to_delete; i++)); do
        local file="${sorted_orphaned[$i]}"
        if [[ "$dry_run" == "true" ]]; then
            echo "Would delete: $file"
        else
            rm -f "$file" 2>/dev/null && ((cleaned_count++)) || true
        fi
    done

    if [[ "$dry_run" != "true" ]]; then
        echo "$cleaned_count"
    else
        echo "Dry run: would delete $to_delete of $total_orphaned orphaned files"
    fi

    return 0
}

# Cleanup stale context state files for ended/archived sessions
# This handles context files that were not properly cleaned up during session lifecycle
# Args: $1 - dry-run mode (optional: "true" for dry-run)
#       $2 - include-archived (optional: "true" to also clean archived sessions, default "true")
# Returns: 0 on success, outputs count of cleaned files
cleanup_stale_context_states() {
    local dry_run="${1:-false}"
    local include_archived="${2:-true}"
    local cleo_dir="${CLEO_PROJECT_DIR:-$(get_cleo_dir)}"
    local sessions_file
    sessions_file=$(get_sessions_file)

    if [[ ! -f "$sessions_file" ]]; then
        echo "0"
        return 0
    fi

    # Build jq filter for session IDs to clean up
    local status_filter='.status == "ended"'
    if [[ "$include_archived" == "true" ]]; then
        status_filter='(.status == "ended" or .status == "archived")'
    fi

    # Get session IDs for ended/archived sessions
    local stale_session_ids
    stale_session_ids=$(jq -r --arg filter "$status_filter" "
        .sessions[] | select($status_filter) | .id
    " "$sessions_file" 2>/dev/null)

    # Also include sessions in history (already closed)
    local history_session_ids
    history_session_ids=$(jq -r '.sessionHistory[].id' "$sessions_file" 2>/dev/null)

    local cleaned_count=0
    local files_to_clean=()

    # Check legacy location (.cleo/.context-state-*.json) for stale sessions
    while IFS= read -r -d '' file; do
        local filename
        filename=$(basename "$file")

        # Skip singleton file
        if [[ "$filename" == ".context-state.json" ]]; then
            continue
        fi

        # Extract session ID from filename (.context-state-{sessionId}.json)
        local session_id
        session_id=$(echo "$filename" | sed -n 's/^\.context-state-\(.*\)\.json$/\1/p')

        if [[ -n "$session_id" ]]; then
            # Check if session is in stale list or history
            if echo "$stale_session_ids" | grep -qF "$session_id" || \
               echo "$history_session_ids" | grep -qF "$session_id"; then
                files_to_clean+=("$file")
            fi
        fi
    done < <(find "$cleo_dir" -maxdepth 1 -name ".context-state-*.json" -type f -print0 2>/dev/null)

    # Also check new location (.cleo/context-states/)
    local context_dir
    context_dir=$(get_config_value "contextStates.directory" ".cleo/context-states")
    local project_root="${cleo_dir%/.cleo}"
    local full_dir="${project_root}/${context_dir}"

    if [[ -d "$full_dir" ]]; then
        while IFS= read -r -d '' file; do
            local filename
            filename=$(basename "$file")

            # Extract session ID from filename (context-state-{sessionId}.json)
            local session_id
            session_id=$(echo "$filename" | sed -n 's/^context-state-\(.*\)\.json$/\1/p')

            if [[ -n "$session_id" ]]; then
                # Check if session is in stale list or history
                if echo "$stale_session_ids" | grep -qF "$session_id" || \
                   echo "$history_session_ids" | grep -qF "$session_id"; then
                    files_to_clean+=("$file")
                fi
            fi
        done < <(find "$full_dir" -name "context-state-*.json" -type f -print0 2>/dev/null)
    fi

    # Delete stale context files
    for file in "${files_to_clean[@]}"; do
        if [[ "$dry_run" == "true" ]]; then
            echo "Would delete: $file"
        else
            rm -f "$file" 2>/dev/null && ((cleaned_count++)) || true
        fi
    done

    if [[ "$dry_run" != "true" ]]; then
        echo "$cleaned_count"
    else
        echo "Dry run: would delete ${#files_to_clean[@]} stale context files"
    fi

    return 0
}

# Full context state cleanup - combines orphan and stale cleanup
# Args: $1 - dry-run mode (optional: "true" for dry-run)
# Returns: 0 on success, outputs JSON summary
session_cleanup_context_files() {
    local dry_run="${1:-false}"

    local orphan_count stale_count total_count

    if [[ "$dry_run" == "true" ]]; then
        echo "=== Context State Cleanup (Dry Run) ===" >&2
        orphan_count=$(cleanup_orphaned_context_states "true" 2>&1 | grep -oP '\d+(?= orphaned)' || echo "0")
        stale_count=$(cleanup_stale_context_states "true" 2>&1 | grep -oP '\d+(?= stale)' || echo "0")
    else
        orphan_count=$(cleanup_orphaned_context_states "false")
        stale_count=$(cleanup_stale_context_states "false")
    fi

    total_count=$((orphan_count + stale_count))

    # Output JSON summary
    jq -nc \
        --argjson orphaned "${orphan_count:-0}" \
        --argjson stale "${stale_count:-0}" \
        --argjson total "${total_count:-0}" \
        --arg mode "$(if [[ "$dry_run" == "true" ]]; then echo "dry-run"; else echo "executed"; fi)" \
        '{
            success: true,
            mode: $mode,
            cleaned: {
                orphaned: $orphaned,
                stale: $stale,
                total: $total
            }
        }'

    return 0
}

# Alias for cleanup_orphaned_context_states - named per task T1943 requirements
# Args: $1 - dry-run mode (optional: "true" for dry-run)
# Returns: 0 on success, outputs count of cleaned files
session_cleanup_orphans() {
    cleanup_orphaned_context_states "$@"
}

# Validate context state file ownership during session operations
# Prevents orphans by verifying session exists before creating context state
# Args: $1 - session ID to validate
# Returns: 0 if valid, 1 if session not found
validate_context_state_owner() {
    local session_id="$1"
    local sessions_file
    sessions_file=$(get_sessions_file)

    if [[ -z "$session_id" ]]; then
        return 1
    fi

    if [[ ! -f "$sessions_file" ]]; then
        return 1
    fi

    # Check if session exists in sessions or history
    local exists
    exists=$(jq -r --arg id "$session_id" '
        ([.sessions[].id] + [.sessionHistory[].id]) | index($id)
    ' "$sessions_file" 2>/dev/null)

    [[ "$exists" != "null" ]]
}

# Migrate existing singleton context state file to per-session format
# This handles the transition from the old singleton .context-state.json
# to the new per-session .cleo/context-states/ directory structure.
# Args: $1 - dry-run mode (optional: "true" for dry-run)
# Returns: 0 on success, outputs migration status
migrate_context_state_singleton() {
    local dry_run="${1:-false}"
    local cleo_dir="${CLEO_PROJECT_DIR:-$(get_cleo_dir)}"
    local project_root="${cleo_dir%/.cleo}"

    # Get config for context state directory
    local context_dir
    context_dir=$(get_config_value "contextStates.directory" ".cleo/context-states")
    local full_dir="${project_root}/${context_dir}"

    # Check for singleton file
    local singleton_file="${cleo_dir}/.context-state.json"
    if [[ ! -f "$singleton_file" ]]; then
        echo "No singleton context state file found - nothing to migrate"
        return 0
    fi

    # Create directory if needed
    if [[ "$dry_run" != "true" && ! -d "$full_dir" ]]; then
        mkdir -p "$full_dir" 2>/dev/null || true
    fi

    # Read singleton file to determine session ID
    local session_id
    session_id=$(jq -r '.cleoSessionId // ""' "$singleton_file" 2>/dev/null)

    if [[ -z "$session_id" || "$session_id" == "null" ]]; then
        # No session ID in singleton - check .current-session
        local current_session_file="${cleo_dir}/.current-session"
        if [[ -f "$current_session_file" ]]; then
            session_id=$(cat "$current_session_file" 2>/dev/null | tr -d '\n')
        fi
    fi

    if [[ -n "$session_id" && "$session_id" != "null" ]]; then
        # Get filename pattern
        local filename_pattern
        filename_pattern=$(get_config_value "contextStates.filenamePattern" "context-state-{sessionId}.json")

        # Build new file path
        local filename="${filename_pattern//\{sessionId\}/$session_id}"
        local new_file="${full_dir}/${filename}"

        if [[ "$dry_run" == "true" ]]; then
            echo "Would migrate: $singleton_file -> $new_file"
        else
            # Move to new location
            if mv "$singleton_file" "$new_file" 2>/dev/null; then
                echo "Migrated singleton to: $new_file"
            else
                # Fallback: copy then delete
                if cp "$singleton_file" "$new_file" 2>/dev/null; then
                    rm -f "$singleton_file" 2>/dev/null
                    echo "Migrated singleton to: $new_file"
                else
                    echo "Warning: Failed to migrate singleton file" >&2
                    return 1
                fi
            fi
        fi
    else
        # No active session - delete singleton (it's stale)
        if [[ "$dry_run" == "true" ]]; then
            echo "Would delete stale singleton: $singleton_file"
        else
            rm -f "$singleton_file" 2>/dev/null
            echo "Deleted stale singleton (no active session)"
        fi
    fi

    return 0
}

# Initialize context states directory structure
# Creates the .cleo/context-states/ directory if it doesn't exist
# Args: none
# Returns: 0 on success
init_context_states_dir() {
    local cleo_dir="${CLEO_PROJECT_DIR:-$(get_cleo_dir)}"
    local project_root="${cleo_dir%/.cleo}"

    # Get config for context state directory
    local context_dir
    context_dir=$(get_config_value "contextStates.directory" ".cleo/context-states")
    local full_dir="${project_root}/${context_dir}"

    # Create directory if needed
    if [[ ! -d "$full_dir" ]]; then
        mkdir -p "$full_dir" 2>/dev/null || true
    fi

    # Run migration for existing singleton file
    migrate_context_state_singleton >/dev/null 2>&1 || true

    return 0
}

# ============================================================================
# SESSION QUERIES
# ============================================================================

# List sessions
# Args: $1 - status filter (optional: "active", "suspended", "ended", "all")
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
        ended)
            jq -c '[.sessions[] | select(.status == "ended")]' "$sessions_file"
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


# Resolve current session ID using priority order:
# 1. Explicit --session flag (passed as $1)
# 2. CLEO_SESSION environment variable
# 3. TTY-based binding (multi-terminal isolation) [T1778]
# 4. .current-session file (legacy singleton)
# 5. Auto-detect single active session
# Returns: session ID on success, empty on failure
# Exit code: 0 on success, 1 if no session found
resolve_current_session_id() {
    local provided="${1:-}"
    local sessions_file
    sessions_file=$(get_sessions_file)

    # Helper function to validate session exists and is active/suspended
    _validate_session_exists() {
        local sid="$1"
        if [[ ! -f "$sessions_file" ]]; then
            return 1
        fi
        local status
        status=$(jq -r --arg id "$sid" '.sessions[] | select(.id == $id) | .status' "$sessions_file" 2>/dev/null)
        # Session must exist and be active or suspended (not ended/closed)
        [[ "$status" == "active" || "$status" == "suspended" ]]
    }

    # Priority 1: Explicit flag
    if [[ -n "$provided" ]]; then
        if _validate_session_exists "$provided"; then
            echo "$provided"
            return 0
        fi
        return 1  # Invalid session ID
    fi

    # Priority 2: Environment variable
    if [[ -n "${CLEO_SESSION:-}" ]]; then
        if _validate_session_exists "$CLEO_SESSION"; then
            echo "$CLEO_SESSION"
            return 0
        fi
        return 1  # Invalid env var
    fi

    # Priority 3: TTY-based binding (multi-terminal isolation) [T1778]
    local tty_session
    if tty_session=$(get_tty_bound_session 2>/dev/null) && [[ -n "$tty_session" ]]; then
        if _validate_session_exists "$tty_session"; then
            echo "$tty_session"
            return 0
        fi
        # Stale TTY binding - clean it up
        clear_tty_binding 2>/dev/null || true
    fi

    # Priority 4: .current-session file (legacy singleton)
    local current_file
    current_file="$(get_cleo_dir)/.current-session"
    if [[ -f "$current_file" ]]; then
        local file_session
        file_session=$(cat "$current_file" 2>/dev/null | tr -d '[:space:]')
        if [[ -n "$file_session" ]]; then
            if _validate_session_exists "$file_session"; then
                echo "$file_session"
                return 0
            fi
            # File points to invalid session - clear it
            rm -f "$current_file" 2>/dev/null
        fi
    fi

    # Priority 5: Auto-detect single active session
    if [[ -f "$sessions_file" ]]; then
        local active_sessions
        active_sessions=$(jq -c '[.sessions[] | select(.status == "active")]' "$sessions_file" 2>/dev/null)
        local active_count
        active_count=$(echo "$active_sessions" | jq 'length')

        if [[ "$active_count" -eq 1 ]]; then
            local active_session
            active_session=$(echo "$active_sessions" | jq -r '.[0].id')
            echo "$active_session"
            return 0
        fi
    fi

    return 1  # Could not resolve
}

# ============================================================================
# SESSION FOCUS FUNCTIONS
# ============================================================================

# Get session focus (current task for a session)
# Args: $1 - session ID
# Returns: Task ID or empty if no focus
# Exit codes: 0 = success, 31 = session not found
get_session_focus() {
    local session_id="$1"
    local sessions_file
    sessions_file=$(get_sessions_file)

    if [[ ! -f "$sessions_file" ]]; then
        return 31  # E_SESSION_NOT_FOUND
    fi

    local session_info
    session_info=$(jq -c --arg id "$session_id" '.sessions[] | select(.id == $id)' "$sessions_file" 2>/dev/null)

    if [[ -z "$session_info" ]]; then
        return 31  # E_SESSION_NOT_FOUND
    fi

    # Return focus.currentTask (empty string if not set)
    echo "$session_info" | jq -r '.focus.currentTask // ""'
    return 0
}

# Set session focus (focus task within session)
# Args: $1 - session ID, $2 - task ID
# Returns: Previous focus task ID (empty if none)
# Exit codes: 0 = success, 31 = session not found, 34 = task not in scope, 35 = task claimed by another session
set_session_focus() {
    local session_id="$1"
    local task_id="$2"

    local sessions_file todo_file
    sessions_file=$(get_sessions_file)
    todo_file="$(get_cleo_dir)/todo.json"

    if [[ ! -f "$sessions_file" ]]; then
        echo "Error: Sessions file not found" >&2
        return 31  # E_SESSION_NOT_FOUND
    fi

    local sessions_content todo_content
    sessions_content=$(cat "$sessions_file")
    todo_content=$(cat "$todo_file")

    # Get session info
    local session_info
    session_info=$(echo "$sessions_content" | jq -c --arg id "$session_id" '.sessions[] | select(.id == $id)')

    if [[ -z "$session_info" ]]; then
        echo "Error: Session not found: $session_id" >&2
        return 31  # E_SESSION_NOT_FOUND
    fi

    # Verify task is in session scope
    local in_scope
    in_scope=$(echo "$session_info" | jq --arg taskId "$task_id" '.scope.computedTaskIds | index($taskId)')

    if [[ "$in_scope" == "null" ]]; then
        echo "Error: Task $task_id is not in session scope" >&2
        return 34  # E_TASK_NOT_IN_SCOPE
    fi

    # Verify no other session has this task focused
    local claimed_by
    claimed_by=$(echo "$sessions_content" | jq -r --arg taskId "$task_id" --arg sessId "$session_id" '
        .sessions[] | select(.id != $sessId and .focus.currentTask == $taskId and .status == "active") | .id
    ' | head -1)

    if [[ -n "$claimed_by" ]]; then
        echo "Error: Task $task_id already focused by session $claimed_by" >&2
        return 35  # E_TASK_CLAIMED
    fi

    local timestamp old_focus
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    old_focus=$(echo "$session_info" | jq -r '.focus.currentTask // ""')

    # Update session focus
    local updated_sessions
    updated_sessions=$(echo "$sessions_content" | jq \
        --arg sessId "$session_id" \
        --arg taskId "$task_id" \
        --arg ts "$timestamp" \
        --arg oldFocus "$old_focus" \
        '
        .sessions = [.sessions[] |
            if .id == $sessId then
                .focus.previousTask = (if $oldFocus == "" then null else $oldFocus end) |
                .focus.currentTask = $taskId |
                .focus.focusHistory += [{
                    taskId: $taskId,
                    timestamp: $ts,
                    action: "focused"
                }] |
                .lastActivity = $ts |
                .stats.focusChanges += 1
            else . end
        ] |
        ._meta.lastModified = $ts
        ')

    # Update task status in todo.json
    local scope_ids
    scope_ids=$(echo "$session_info" | jq -c '.scope.computedTaskIds')

    local updated_todo
    updated_todo=$(echo "$todo_content" | jq \
        --arg taskId "$task_id" \
        --arg ts "$timestamp" \
        --argjson scopeIds "$scope_ids" \
        '
        # Reset other active tasks in scope to pending
        .tasks = [.tasks[] |
            if (.id as $id | $scopeIds | index($id)) and .status == "active" and .id != $taskId then
                .status = "pending" | .updatedAt = $ts
            else . end
        ] |
        # Set focus task to active
        .tasks = [.tasks[] |
            if .id == $taskId then
                .status = "active" | .updatedAt = $ts
            else . end
        ] |
        # Update global focus to match session focus
        .focus.currentTask = $taskId |
        ._meta.lastModified = $ts
        ')

    # Save both files using safe mktemp pattern
    local _sf_sess_tmp
    _sf_sess_tmp=$(mktemp "${sessions_file}.XXXXXX")
    if ! echo "$updated_sessions" | jq '.' > "$_sf_sess_tmp"; then
        rm -f "$_sf_sess_tmp"
        return 1
    fi
    mv "$_sf_sess_tmp" "$sessions_file" || { rm -f "$_sf_sess_tmp"; return 1; }

    local _sf_todo_tmp
    _sf_todo_tmp=$(mktemp "${todo_file}.XXXXXX")
    if ! echo "$updated_todo" | jq '.' > "$_sf_todo_tmp"; then
        rm -f "$_sf_todo_tmp"
        return 1
    fi
    mv "$_sf_todo_tmp" "$todo_file" || { rm -f "$_sf_todo_tmp"; return 1; }

    echo "$old_focus"
    return 0
}

# Clear session focus
# Args: $1 - session ID
# Returns: Previous focus task ID (empty if none)
# Exit codes: 0 = success, 31 = session not found
clear_session_focus() {
    local session_id="$1"

    local sessions_file todo_file
    sessions_file=$(get_sessions_file)
    todo_file="$(get_cleo_dir)/todo.json"

    if [[ ! -f "$sessions_file" ]]; then
        echo "Error: Sessions file not found" >&2
        return 31  # E_SESSION_NOT_FOUND
    fi

    local sessions_content todo_content
    sessions_content=$(cat "$sessions_file")
    todo_content=$(cat "$todo_file")

    # Get session info
    local session_info
    session_info=$(echo "$sessions_content" | jq -c --arg id "$session_id" '.sessions[] | select(.id == $id)')

    if [[ -z "$session_info" ]]; then
        echo "Error: Session not found: $session_id" >&2
        return 31  # E_SESSION_NOT_FOUND
    fi

    local timestamp old_focus
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    old_focus=$(echo "$session_info" | jq -r '.focus.currentTask // ""')

    # If no focus, nothing to clear
    if [[ -z "$old_focus" ]]; then
        echo ""
        return 0
    fi

    # Update session to clear focus
    local updated_sessions
    updated_sessions=$(echo "$sessions_content" | jq \
        --arg sessId "$session_id" \
        --arg ts "$timestamp" \
        --arg oldFocus "$old_focus" \
        '
        .sessions = [.sessions[] |
            if .id == $sessId then
                .focus.previousTask = $oldFocus |
                .focus.currentTask = null |
                .focus.focusHistory += [{
                    taskId: $oldFocus,
                    timestamp: $ts,
                    action: "cleared"
                }] |
                .lastActivity = $ts
            else . end
        ] |
        ._meta.lastModified = $ts
        ')

    # Reset task status in todo.json from active to pending
    local updated_todo
    updated_todo=$(echo "$todo_content" | jq \
        --arg taskId "$old_focus" \
        --arg ts "$timestamp" \
        '
        .tasks = [.tasks[] |
            if .id == $taskId and .status == "active" then
                .status = "pending" | .updatedAt = $ts
            else . end
        ] |
        ._meta.lastModified = $ts
        ')

    # Save both files using safe mktemp pattern
    local _cf_sess_tmp
    _cf_sess_tmp=$(mktemp "${sessions_file}.XXXXXX")
    if ! echo "$updated_sessions" | jq '.' > "$_cf_sess_tmp"; then
        rm -f "$_cf_sess_tmp"
        return 1
    fi
    mv "$_cf_sess_tmp" "$sessions_file" || { rm -f "$_cf_sess_tmp"; return 1; }

    local _cf_todo_tmp
    _cf_todo_tmp=$(mktemp "${todo_file}.XXXXXX")
    if ! echo "$updated_todo" | jq '.' > "$_cf_todo_tmp"; then
        rm -f "$_cf_todo_tmp"
        return 1
    fi
    mv "$_cf_todo_tmp" "$todo_file" || { rm -f "$_cf_todo_tmp"; return 1; }

    echo "$old_focus"
    return 0
}

# ============================================================================
# AUTO-BINDING (T1012)
# ============================================================================

# Auto-bind session after successful session start
# Writes session ID to .cleo/.current-session file for auto-detection
# Args: $1 - session ID
# Returns: 0 on success
auto_bind_session() {
    local session_id="$1"
    local cleo_dir

    cleo_dir="$(get_cleo_dir)"

    # Write session ID to .current-session file
    # Use mode 0600 for security (per MULTI-SESSION-BINDING-SPEC.md)
    local current_session_file="${cleo_dir}/.current-session"
    echo "$session_id" > "$current_session_file"
    chmod 600 "$current_session_file" 2>/dev/null || true

    return 0
}

# Clear session binding on session end
# Removes .cleo/.current-session file
# Args: none
# Returns: 0 on success
clear_session_binding() {
    local cleo_dir
    cleo_dir="$(get_cleo_dir)"

    local current_session_file="${cleo_dir}/.current-session"
    rm -f "$current_session_file" 2>/dev/null || true

    return 0
}

# ============================================================================
# TTY-BASED SESSION BINDING (T1778, T1788)
# Multi-terminal isolation via terminal-specific binding files
# ============================================================================

# Get sanitized TTY identifier for binding files
# Returns: Sanitized TTY ID (e.g., "tty-dev-pts-0") or exit 1 if not available
get_tty_id() {
    local tty_path
    tty_path=$(tty 2>/dev/null) || return 1

    # Not a TTY (pipe, cron, etc.)
    [[ "$tty_path" == "not a tty" ]] && return 1

    # Sanitize: /dev/pts/0 -> tty-dev-pts-0
    echo "$tty_path" | sed 's|^/||; s|/|-|g; s|^|tty-|'
}

# Get TTY bindings directory path
# Returns: Path to tty-bindings directory
get_tty_bindings_dir() {
    local cleo_dir
    cleo_dir="$(get_cleo_dir)"
    echo "${cleo_dir}/tty-bindings"
}

# Bind session to current TTY
# Args: $1 - session ID
# Returns: 0 on success, 1 if TTY not available
bind_session_to_tty() {
    local session_id="$1"
    local tty_id
    tty_id=$(get_tty_id) || return 1

    local binding_dir
    binding_dir="$(get_tty_bindings_dir)"
    mkdir -p "$binding_dir"

    local binding_file="${binding_dir}/${tty_id}"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Write binding with metadata
    jq -nc --arg sid "$session_id" \
           --arg tty "$(tty 2>/dev/null || echo 'unknown')" \
           --arg ts "$timestamp" \
           --arg pid "$$" '{
        sessionId: $sid,
        tty: $tty,
        boundAt: $ts,
        pid: ($pid | tonumber)
    }' > "$binding_file"

    chmod 600 "$binding_file" 2>/dev/null || true
    return 0
}

# Get session bound to current TTY
# Returns: Session ID or empty if no binding/TTY not available
get_tty_bound_session() {
    local tty_id
    tty_id=$(get_tty_id) || return 1

    local binding_dir
    binding_dir="$(get_tty_bindings_dir)"
    local binding_file="${binding_dir}/${tty_id}"

    [[ -f "$binding_file" ]] || return 1

    jq -r '.sessionId // empty' "$binding_file" 2>/dev/null
}

# Clear TTY binding for current terminal
# Returns: 0 always (idempotent)
clear_tty_binding() {
    local tty_id
    tty_id=$(get_tty_id) || return 0

    local binding_dir
    binding_dir="$(get_tty_bindings_dir)"
    local binding_file="${binding_dir}/${tty_id}"

    rm -f "$binding_file" 2>/dev/null
    return 0
}

# Clear all TTY bindings for a specific session
# Args: $1 - session ID
# Returns: 0 always (idempotent)
clear_session_tty_bindings() {
    local session_id="$1"
    local binding_dir
    binding_dir="$(get_tty_bindings_dir)"

    [[ -d "$binding_dir" ]] || return 0

    local file bound_session
    for file in "$binding_dir"/tty-*; do
        [[ -f "$file" ]] || continue
        bound_session=$(jq -r '.sessionId // empty' "$file" 2>/dev/null)
        if [[ "$bound_session" == "$session_id" ]]; then
            rm -f "$file"
        fi
    done
    return 0
}

# Check if TTY binding is stale (older than max age)
# Args: $1 - binding file path, $2 - max age in hours (default: 168 = 7 days)
# Returns: 0 if fresh, 1 if stale or invalid
check_binding_staleness() {
    local binding_file="$1"
    local max_age_hours="${2:-168}"

    [[ -f "$binding_file" ]] || return 1

    local bound_at
    bound_at=$(jq -r '.boundAt // empty' "$binding_file" 2>/dev/null)
    [[ -n "$bound_at" ]] || return 0  # No timestamp = treat as fresh

    local bound_ts now_ts age_hours
    # Try GNU date first, then BSD date
    if date --version >/dev/null 2>&1; then
        bound_ts=$(date -d "$bound_at" +%s 2>/dev/null || echo 0)
    else
        bound_ts=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$bound_at" +%s 2>/dev/null || echo 0)
    fi
    now_ts=$(date +%s)
    age_hours=$(( (now_ts - bound_ts) / 3600 ))

    [[ "$age_hours" -le "$max_age_hours" ]]
}

# Validate session binding - check for conflicts and staleness
# Args: $1 - session ID to validate
# Returns: 0 if valid, 1 if conflict/issue detected (warning printed to stderr)
validate_session_binding() {
    local session_id="$1"
    local tty_id
    tty_id=$(get_tty_id) || return 0  # No TTY = no conflict possible

    local binding_dir
    binding_dir="$(get_tty_bindings_dir)"
    local binding_file="${binding_dir}/${tty_id}"

    # Check if another session is bound to this TTY
    if [[ -f "$binding_file" ]]; then
        local existing_session
        existing_session=$(jq -r '.sessionId // empty' "$binding_file" 2>/dev/null)

        if [[ -n "$existing_session" && "$existing_session" != "$session_id" ]]; then
            echo "Warning: Another session ($existing_session) is bound to this terminal" >&2
            echo "  Switch: cleo session switch $session_id" >&2
            echo "  Or set: export CLEO_SESSION=$session_id" >&2
            return 1
        fi

        # Check staleness
        local max_age_hours
        max_age_hours=$(get_config_value "multiSession.ttyBinding.maxAgeHours" "168" 2>/dev/null || echo "168")
        if ! check_binding_staleness "$binding_file" "$max_age_hours"; then
            local age_days=$(( max_age_hours / 24 ))
            echo "Warning: Session binding is stale (bound >${age_days}d ago)" >&2
            echo "  Refresh: cleo session resume $existing_session" >&2
            return 1
        fi
    fi

    return 0
}

# ============================================================================
# AUTO-FOCUS
# ============================================================================

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
            select(.status == "pending") |
            select(.type != "epic")
        ] |
        sort_by([(.priority | priority_score) * -1, .createdAt]) |
        .[0].id // ""
    '
}

# Discover available Epics for session binding
# Args: $1 - todo file path (optional, defaults to .cleo/todo.json)
# Returns: JSON array of available Epics with id, title, status, childCount, pendingCount
# Output format: [{"id":"T001","title":"Epic Title","status":"pending","childCount":5,"pendingCount":3}, ...]
discover_available_epics() {
    local todo_file="${1:-$(get_cleo_dir)/todo.json}"

    if [[ ! -f "$todo_file" ]]; then
        echo "[]"
        return 0
    fi

    jq -c '
        # Store root tasks array for use inside iteration
        .tasks as $all_tasks |

        # Get all epic tasks that are not done
        [.tasks[] | select(.type == "epic" and .status != "done")] as $epics |

        # For each epic, count children and pending children
        [
            $epics[] | . as $epic |
            {
                id: $epic.id,
                title: ($epic.title // $epic.content // "Untitled"),
                status: $epic.status,
                priority: ($epic.priority // "medium"),
                childCount: [$all_tasks[] | select(.parentId == $epic.id)] | length,
                pendingCount: [$all_tasks[] | select(.parentId == $epic.id and .status == "pending")] | length
            }
        ] |

        # Sort by priority (critical > high > medium > low), then by pending count desc
        sort_by([
            (if .priority == "critical" then 0
             elif .priority == "high" then 1
             elif .priority == "medium" then 2
             else 3 end),
            (-.pendingCount)
        ])
    ' "$todo_file" 2>/dev/null || echo "[]"
}

# ============================================================================
# SESSION CONSISTENCY VALIDATION (T1946)
# ============================================================================

# Validate consistency between session registry and context state files
# Checks:
#   1. sessions.json status matches reality (not pointing to deleted sessions)
#   2. .current-session file points to valid active/suspended session
#   3. TTY bindings reference existing sessions
#   4. Context state files have corresponding sessions
# Args:
#   $1 - repair mode: "check" (default), "repair", "verbose"
# Returns:
#   0 = consistent, 1 = inconsistencies found (check), repaired (repair)
# Output: JSON report of findings
session_validate_consistency() {
    local mode="${1:-check}"
    local cleo_dir="${CLEO_PROJECT_DIR:-$(get_cleo_dir)}"
    local sessions_file
    sessions_file=$(get_sessions_file)

    local issues=()
    local repairs=()
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Helper to add issue
    add_issue() {
        local type="$1" source="$2" detail="$3" fix="$4"
        issues+=("{\"type\":\"$type\",\"source\":\"$source\",\"detail\":\"$detail\",\"fix\":\"$fix\"}")
    }

    # 1. Check sessions.json exists
    if [[ ! -f "$sessions_file" ]]; then
        jq -nc \
            --arg ts "$timestamp" \
            '{
                success: true,
                consistent: true,
                message: "No sessions.json - nothing to validate",
                timestamp: $ts,
                issues: [],
                repairs: []
            }'
        return 0
    fi

    local sessions_content
    sessions_content=$(cat "$sessions_file")

    # Get all session IDs and their statuses
    local session_ids session_statuses
    session_ids=$(echo "$sessions_content" | jq -r '.sessions[].id' 2>/dev/null)

    # 2. Check .current-session file consistency
    local current_session_file="${cleo_dir}/.current-session"
    if [[ -f "$current_session_file" ]]; then
        local bound_session
        bound_session=$(cat "$current_session_file" 2>/dev/null | tr -d '[:space:]')

        if [[ -n "$bound_session" ]]; then
            # Check if session exists in registry
            local session_exists session_status
            session_exists=$(echo "$sessions_content" | jq --arg id "$bound_session" \
                '[.sessions[] | select(.id == $id)] | length')

            if [[ "$session_exists" -eq 0 ]]; then
                add_issue "orphan_binding" ".current-session" \
                    "Points to non-existent session: $bound_session" \
                    "rm $current_session_file"

                if [[ "$mode" == "repair" ]]; then
                    rm -f "$current_session_file"
                    repairs+=("Removed .current-session pointing to $bound_session")
                fi
            else
                # Check if session is still usable (active or suspended)
                session_status=$(echo "$sessions_content" | jq -r --arg id "$bound_session" \
                    '.sessions[] | select(.id == $id) | .status')

                if [[ "$session_status" != "active" && "$session_status" != "suspended" ]]; then
                    add_issue "stale_binding" ".current-session" \
                        "Points to $session_status session: $bound_session" \
                        "rm $current_session_file"

                    if [[ "$mode" == "repair" ]]; then
                        rm -f "$current_session_file"
                        repairs+=("Removed .current-session pointing to $session_status session")
                    fi
                fi
            fi
        fi
    fi

    # 3. Check TTY bindings consistency
    local tty_dir
    tty_dir=$(get_tty_bindings_dir 2>/dev/null || echo "${cleo_dir}/tty-bindings")

    if [[ -d "$tty_dir" ]]; then
        for binding_file in "$tty_dir"/*; do
            [[ -f "$binding_file" ]] || continue

            local tty_session
            tty_session=$(jq -r '.sessionId // empty' "$binding_file" 2>/dev/null)

            if [[ -n "$tty_session" ]]; then
                local exists
                exists=$(echo "$sessions_content" | jq --arg id "$tty_session" \
                    '[.sessions[] | select(.id == $id)] | length')

                if [[ "$exists" -eq 0 ]]; then
                    local tty_name
                    tty_name=$(basename "$binding_file")
                    add_issue "orphan_tty_binding" "tty-bindings/$tty_name" \
                        "TTY bound to non-existent session: $tty_session" \
                        "rm $binding_file"

                    if [[ "$mode" == "repair" ]]; then
                        rm -f "$binding_file"
                        repairs+=("Removed TTY binding for $tty_session")
                    fi
                fi
            fi
        done
    fi

    # 4. Check context state files consistency
    local context_dir
    context_dir=$(get_config_value "contextStates.directory" ".cleo/context-states" 2>/dev/null)
    local project_root="${cleo_dir%/.cleo}"
    local full_context_dir="${project_root}/${context_dir}"

    # Check new location
    if [[ -d "$full_context_dir" ]]; then
        while IFS= read -r -d '' ctx_file; do
            local filename ctx_session
            filename=$(basename "$ctx_file")
            ctx_session=$(echo "$filename" | sed -n 's/^context-state-\(.*\)\.json$/\1/p')

            if [[ -n "$ctx_session" ]]; then
                local exists status
                exists=$(echo "$sessions_content" | jq --arg id "$ctx_session" \
                    '[.sessions[] | select(.id == $id)] | length')

                if [[ "$exists" -eq 0 ]]; then
                    # Check history too
                    local in_history
                    in_history=$(echo "$sessions_content" | jq --arg id "$ctx_session" \
                        '[.sessionHistory[] | select(.id == $id)] | length')

                    if [[ "$in_history" -eq 0 ]]; then
                        add_issue "orphan_context_state" "context-states/$filename" \
                            "Context state for unknown session: $ctx_session" \
                            "rm $ctx_file"

                        if [[ "$mode" == "repair" ]]; then
                            rm -f "$ctx_file"
                            repairs+=("Removed orphan context state for $ctx_session")
                        fi
                    fi
                else
                    # Session exists - check if context file should be cleaned
                    status=$(echo "$sessions_content" | jq -r --arg id "$ctx_session" \
                        '.sessions[] | select(.id == $id) | .status')

                    if [[ "$status" == "ended" || "$status" == "closed" || "$status" == "archived" ]]; then
                        add_issue "stale_context_state" "context-states/$filename" \
                            "Context state for $status session: $ctx_session" \
                            "rm $ctx_file"

                        if [[ "$mode" == "repair" ]]; then
                            rm -f "$ctx_file"
                            repairs+=("Removed stale context state for $status session")
                        fi
                    fi
                fi
            fi
        done < <(find "$full_context_dir" -name "context-state-*.json" -type f -print0 2>/dev/null)
    fi

    # Check legacy location too
    while IFS= read -r -d '' ctx_file; do
        local filename ctx_session
        filename=$(basename "$ctx_file")

        [[ "$filename" == ".context-state.json" ]] && continue

        ctx_session=$(echo "$filename" | sed -n 's/^\.context-state-\(.*\)\.json$/\1/p')

        if [[ -n "$ctx_session" ]]; then
            local exists
            exists=$(echo "$sessions_content" | jq --arg id "$ctx_session" \
                '[.sessions[] | select(.id == $id)] | length')

            if [[ "$exists" -eq 0 ]]; then
                add_issue "orphan_legacy_context" "$filename" \
                    "Legacy context state for unknown session: $ctx_session" \
                    "rm $ctx_file"

                if [[ "$mode" == "repair" ]]; then
                    rm -f "$ctx_file"
                    repairs+=("Removed orphan legacy context state for $ctx_session")
                fi
            fi
        fi
    done < <(find "$cleo_dir" -maxdepth 1 -name ".context-state-*.json" -type f -print0 2>/dev/null)

    # 5. Check session registry internal consistency
    # Verify active sessions have valid focus tasks
    while read -r session_id; do
        [[ -z "$session_id" ]] && continue

        local session_info focus_task scope_ids
        session_info=$(echo "$sessions_content" | jq -c --arg id "$session_id" \
            '.sessions[] | select(.id == $id)')

        focus_task=$(echo "$session_info" | jq -r '.focus.currentTask // ""')
        scope_ids=$(echo "$session_info" | jq -c '.scope.computedTaskIds // []')

        if [[ -n "$focus_task" ]]; then
            local in_scope
            in_scope=$(echo "$scope_ids" | jq --arg id "$focus_task" 'index($id)')

            if [[ "$in_scope" == "null" ]]; then
                add_issue "focus_out_of_scope" "sessions.json" \
                    "Session $session_id focus task $focus_task not in computed scope" \
                    "cleo focus set <valid-task> --session $session_id"
            fi
        fi
    done <<< "$(echo "$sessions_content" | jq -r '.sessions[] | select(.status == "active") | .id')"

    # Build result
    local issue_count=${#issues[@]}
    local repair_count=${#repairs[@]}
    local issues_json="[]"
    local repairs_json="[]"

    if [[ $issue_count -gt 0 ]]; then
        issues_json=$(printf '%s\n' "${issues[@]}" | jq -s '.')
    fi

    if [[ $repair_count -gt 0 ]]; then
        repairs_json=$(printf '%s\n' "${repairs[@]}" | jq -Rs 'split("\n") | map(select(length > 0))')
    fi

    local consistent="true"
    [[ $issue_count -gt 0 && "$mode" == "check" ]] && consistent="false"
    [[ "$mode" == "repair" && $repair_count -gt 0 ]] && consistent="true"

    jq -nc \
        --arg ts "$timestamp" \
        --arg mode "$mode" \
        --argjson issues "$issues_json" \
        --argjson repairs "$repairs_json" \
        --argjson issueCount "$issue_count" \
        --argjson repairCount "$repair_count" \
        --argjson consistent "$consistent" \
        '{
            success: true,
            consistent: $consistent,
            mode: $mode,
            timestamp: $ts,
            issueCount: $issueCount,
            repairCount: $repairCount,
            issues: $issues,
            repairs: $repairs
        }'

    if [[ $issue_count -gt 0 && "$mode" == "check" ]]; then
        return 1
    fi
    return 0
}

# Repair session status inconsistencies
# Wrapper for session_validate_consistency with repair mode
# Args: $1 - verbose (optional: "true" for detailed output)
# Returns: 0 on success, 1 on failure
session_repair_consistency() {
    local verbose="${1:-false}"

    local result
    result=$(session_validate_consistency "repair")

    if [[ "$verbose" == "true" ]]; then
        echo "$result" | jq '.'
    else
        local repair_count
        repair_count=$(echo "$result" | jq -r '.repairCount')

        if [[ "$repair_count" -gt 0 ]]; then
            echo "Repaired $repair_count inconsistencies"
        else
            echo "No inconsistencies found"
        fi
    fi

    return 0
}

# Synchronize session status atomically across all sources
# Ensures status updates propagate to: sessions.json, context files, bindings
# Args:
#   $1 - session ID
#   $2 - new status (active|suspended|ended|closed|archived)
#   $3 - optional note
# Returns: 0 on success, non-zero on failure
session_sync_status() {
    local session_id="$1"
    local new_status="$2"
    local note="${3:-}"

    local cleo_dir="${CLEO_PROJECT_DIR:-$(get_cleo_dir)}"
    local sessions_file
    sessions_file=$(get_sessions_file)

    if [[ ! -f "$sessions_file" ]]; then
        echo "Error: Sessions file not found" >&2
        return 1
    fi

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Lock sessions.json
    local sessions_fd
    if ! lock_file "$sessions_file" sessions_fd 30; then
        echo "Error: Failed to acquire lock on sessions.json" >&2
        return $FO_LOCK_FAILED
    fi

    trap "unlock_file $sessions_fd" EXIT ERR

    local sessions_content
    sessions_content=$(cat "$sessions_file")

    # Verify session exists
    local exists
    exists=$(echo "$sessions_content" | jq --arg id "$session_id" \
        '[.sessions[] | select(.id == $id)] | length')

    if [[ "$exists" -eq 0 ]]; then
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Session not found: $session_id" >&2
        return 31  # E_SESSION_NOT_FOUND
    fi

    # Update session status in registry
    local updated_sessions
    updated_sessions=$(echo "$sessions_content" | jq \
        --arg id "$session_id" \
        --arg status "$new_status" \
        --arg ts "$timestamp" \
        --arg note "$note" \
        '
        .sessions = [.sessions[] |
            if .id == $id then
                .status = $status |
                .lastActivity = $ts |
                (if $note != "" then .focus.sessionNote = $note else . end)
            else . end
        ] |
        ._meta.lastModified = $ts
        ')

    # Save updated sessions.json
    local pretty_json
    pretty_json=$(echo "$updated_sessions" | jq '.')
    if ! aw_atomic_write "$sessions_file" "$pretty_json" "${MAX_BACKUPS:-10}"; then
        unlock_file "$sessions_fd"
        trap - EXIT ERR
        echo "Error: Failed to save sessions.json" >&2
        return 1
    fi

    unlock_file "$sessions_fd"
    trap - EXIT ERR

    # Sync dependent artifacts based on new status
    case "$new_status" in
        ended|closed|archived)
            # Clean up .current-session if it points to this session
            local current_session_file="${cleo_dir}/.current-session"
            if [[ -f "$current_session_file" ]]; then
                local bound_id
                bound_id=$(cat "$current_session_file" 2>/dev/null | tr -d '[:space:]')
                if [[ "$bound_id" == "$session_id" ]]; then
                    rm -f "$current_session_file"
                fi
            fi

            # Clear TTY bindings for this session
            if declare -f clear_session_tty_bindings >/dev/null 2>&1; then
                clear_session_tty_bindings "$session_id" 2>/dev/null || true
            fi

            # Clean up context state file based on config
            cleanup_context_state_for_session "$session_id" "$new_status" 2>/dev/null || true
            ;;
        active|suspended)
            # No cleanup needed - these are resumable states
            ;;
    esac

    return 0
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f session_validate_consistency
export -f session_repair_consistency
export -f session_sync_status
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
export -f close_session
export -f archive_session
export -f list_sessions
export -f get_session
export -f get_current_session_id
export -f resolve_current_session_id
export -f auto_bind_session
export -f clear_session_binding
export -f get_tty_id
export -f get_tty_bindings_dir
export -f bind_session_to_tty
export -f get_tty_bound_session
export -f clear_tty_binding
export -f clear_session_tty_bindings
export -f check_binding_staleness
export -f validate_session_binding
export -f auto_select_focus_task
export -f discover_available_epics
export -f get_context_state_path_for_session
export -f cleanup_context_state_for_session
export -f cleanup_orphaned_context_states
export -f cleanup_stale_context_states
export -f session_cleanup_context_files
export -f session_cleanup_orphans
export -f session_auto_end_stale
export -f validate_context_state_owner
export -f migrate_context_state_singleton
export -f init_context_states_dir
