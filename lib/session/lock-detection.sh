#!/bin/bash
# lock-detection.sh - Lock file scanning and concurrent operation awareness
#
# LAYER: 2 (Data Layer)
# DEPENDENCIES: config.sh
# PROVIDES: scan_lock_files, get_lock_holder, is_lock_stale, get_active_locks,
#           format_lock_info, wait_for_locks
#
# Design: Provides lock file detection and analysis for concurrent operation awareness.
#         Used by analyze.sh to warn about potential conflicts with active operations.
#
# Per FILE-LOCKING-SPEC.md:
#   - Lock files are at {file}.lock
#   - flock is used for advisory locking
#   - Lock files persist after operations (the lock itself releases when FD closes)

#=== SOURCE GUARD ================================================
[[ -n "${_LOCK_DETECTION_LOADED:-}" ]] && return 0
declare -r _LOCK_DETECTION_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_LOCK_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source config library for stale threshold configuration
if [[ -f "$_LOCK_LIB_DIR/core/config.sh" ]]; then
    # shellcheck source=lib/core/config.sh
    source "$_LOCK_LIB_DIR/core/config.sh"
fi

# ============================================================================
# CONFIGURATION
# ============================================================================

# Default stale threshold in seconds (5 minutes)
LOCK_STALE_THRESHOLD_DEFAULT=300

# Get configured stale threshold
get_stale_threshold() {
    if declare -f get_config_value >/dev/null 2>&1; then
        get_config_value "analyze.lockAwareness.staleThreshold" "$LOCK_STALE_THRESHOLD_DEFAULT"
    else
        echo "$LOCK_STALE_THRESHOLD_DEFAULT"
    fi
}

# Check if lock awareness is enabled
is_lock_awareness_enabled() {
    if declare -f get_config_value >/dev/null 2>&1; then
        local enabled
        enabled=$(get_config_value "analyze.lockAwareness.enabled" "true")
        [[ "$enabled" == "true" ]]
    else
        return 0  # Enabled by default
    fi
}

# ============================================================================
# LOCK FILE SCANNING
# ============================================================================

#######################################
# Scan for lock files in the .cleo directory
# Arguments:
#   $1 - Path to .cleo directory (optional, defaults to .cleo)
# Outputs:
#   JSON array of lock file paths
# Returns:
#   0 on success
#######################################
scan_lock_files() {
    local cleo_dir="${1:-.cleo}"

    if [[ ! -d "$cleo_dir" ]]; then
        echo "[]"
        return 0
    fi

    # Find all .lock files
    local lock_files=()
    while IFS= read -r -d '' file; do
        lock_files+=("$file")
    done < <(find "$cleo_dir" -name "*.lock" -type f -print0 2>/dev/null)

    # Output as JSON array
    if [[ ${#lock_files[@]} -eq 0 ]]; then
        echo "[]"
    else
        printf '%s\n' "${lock_files[@]}" | jq -R . | jq -s .
    fi

    return 0
}

#######################################
# Get the PID holding a lock on a file (if any)
# Uses fuser to find processes with open file descriptors
# Arguments:
#   $1 - Lock file path
# Outputs:
#   PID if lock is held, empty otherwise
# Returns:
#   0 if lock holder found, 1 otherwise
#######################################
get_lock_holder() {
    local lock_file="$1"

    if [[ ! -f "$lock_file" ]]; then
        return 1
    fi

    # Try fuser first (more reliable for flock)
    if command -v fuser &>/dev/null; then
        local pids
        pids=$(fuser "$lock_file" 2>/dev/null | tr -s ' ' | xargs)
        if [[ -n "$pids" ]]; then
            # Return first PID (primary holder)
            echo "${pids%% *}"
            return 0
        fi
    fi

    # Fallback to lsof
    if command -v lsof &>/dev/null; then
        local pid
        pid=$(lsof -t "$lock_file" 2>/dev/null | head -1)
        if [[ -n "$pid" ]]; then
            echo "$pid"
            return 0
        fi
    fi

    return 1
}

#######################################
# Check if a PID is still running
# Arguments:
#   $1 - PID to check
# Returns:
#   0 if running, 1 if not
#######################################
is_pid_running() {
    local pid="$1"

    if [[ -z "$pid" ]]; then
        return 1
    fi

    # Use kill -0 to check if process exists
    kill -0 "$pid" 2>/dev/null
}

#######################################
# Get the command/process name for a PID
# Arguments:
#   $1 - PID
# Outputs:
#   Command name or "unknown"
#######################################
get_process_name() {
    local pid="$1"

    if [[ -z "$pid" ]]; then
        echo "unknown"
        return
    fi

    # Try /proc first (Linux)
    if [[ -f "/proc/$pid/comm" ]]; then
        cat "/proc/$pid/comm" 2>/dev/null && return
    fi

    # Fallback to ps
    if command -v ps &>/dev/null; then
        local name
        name=$(ps -p "$pid" -o comm= 2>/dev/null | head -1)
        if [[ -n "$name" ]]; then
            echo "$name"
            return
        fi
    fi

    echo "unknown"
}

#######################################
# Check if a lock file is stale (old age, no holder)
# Arguments:
#   $1 - Lock file path
#   $2 - Stale threshold in seconds (optional)
# Outputs:
#   "stale" or "active" or "orphaned"
# Returns:
#   0 always
#######################################
check_lock_status() {
    local lock_file="$1"
    local threshold="${2:-$(get_stale_threshold)}"

    if [[ ! -f "$lock_file" ]]; then
        echo "missing"
        return 0
    fi

    # Get lock file age
    local mtime now age
    if [[ -f "/proc/version" ]]; then
        # Linux
        mtime=$(stat -c %Y "$lock_file" 2>/dev/null)
    else
        # macOS/BSD
        mtime=$(stat -f %m "$lock_file" 2>/dev/null)
    fi
    now=$(date +%s)
    age=$((now - mtime))

    # Check if lock is held
    local pid
    if pid=$(get_lock_holder "$lock_file"); then
        if is_pid_running "$pid"; then
            echo "active"
            return 0
        else
            # PID recorded but not running - orphaned lock
            echo "orphaned"
            return 0
        fi
    fi

    # No holder - check age for stale determination
    if [[ $age -gt $threshold ]]; then
        echo "stale"
    else
        # Recent lock file without detected holder - could be brief operation
        echo "unknown"
    fi

    return 0
}

#######################################
# Get file age in seconds
# Arguments:
#   $1 - File path
# Outputs:
#   Age in seconds
#######################################
get_file_age() {
    local file="$1"

    if [[ ! -f "$file" ]]; then
        echo "0"
        return
    fi

    local mtime now
    if [[ -f "/proc/version" ]]; then
        # Linux
        mtime=$(stat -c %Y "$file" 2>/dev/null || echo "$now")
    else
        # macOS/BSD
        mtime=$(stat -f %m "$file" 2>/dev/null || echo "$now")
    fi
    now=$(date +%s)

    echo $((now - mtime))
}

#######################################
# Infer operation from lock file name
# Arguments:
#   $1 - Lock file path
# Outputs:
#   Operation name (e.g., "todo.json write", "archive")
#######################################
infer_operation() {
    local lock_file="$1"
    local basename
    basename=$(basename "$lock_file" .lock)

    case "$basename" in
        todo.json)
            echo "task write"
            ;;
        todo-archive.json)
            echo "archive"
            ;;
        todo-log.json)
            echo "logging"
            ;;
        focus.json)
            echo "focus"
            ;;
        sessions.json)
            echo "session"
            ;;
        config.json)
            echo "config"
            ;;
        *)
            echo "file operation"
            ;;
    esac
}

# ============================================================================
# HIGH-LEVEL DETECTION FUNCTIONS
# ============================================================================

#######################################
# Get all active locks with full metadata
# Arguments:
#   $1 - Path to .cleo directory (optional)
# Outputs:
#   JSON array of lock info objects
# Returns:
#   0 on success
#######################################
get_active_locks() {
    local cleo_dir="${1:-.cleo}"
    local stale_threshold
    stale_threshold=$(get_stale_threshold)

    # Scan for lock files
    local lock_files_json
    lock_files_json=$(scan_lock_files "$cleo_dir")

    if [[ "$lock_files_json" == "[]" ]]; then
        echo "[]"
        return 0
    fi

    # Process each lock file
    local results="[]"
    local lock_file

    while IFS= read -r lock_file; do
        [[ -z "$lock_file" ]] && continue

        local status pid age operation process_name resource
        status=$(check_lock_status "$lock_file" "$stale_threshold")
        age=$(get_file_age "$lock_file")
        operation=$(infer_operation "$lock_file")
        resource=$(basename "$lock_file" .lock)

        # Get PID and process if active
        pid=""
        process_name=""
        if pid=$(get_lock_holder "$lock_file" 2>/dev/null); then
            process_name=$(get_process_name "$pid")
        fi

        # Build lock info object
        local lock_info
        lock_info=$(jq -nc \
            --arg file "$lock_file" \
            --arg resource "$resource" \
            --arg status "$status" \
            --arg pid "${pid:-null}" \
            --arg process "${process_name:-unknown}" \
            --arg operation "$operation" \
            --argjson age "$age" \
            '{
                file: $file,
                resource: $resource,
                status: $status,
                pid: (if $pid == "null" or $pid == "" then null else ($pid | tonumber) end),
                process: (if $process == "" then null else $process end),
                operation: $operation,
                age_seconds: $age,
                age_human: (
                    if $age < 60 then "\($age)s ago"
                    elif $age < 3600 then "\(($age / 60) | floor)m ago"
                    else "\(($age / 3600) | floor)h ago"
                    end
                )
            }')

        results=$(echo "$results" | jq --argjson lock "$lock_info" '. + [$lock]')
    done < <(echo "$lock_files_json" | jq -r '.[]')

    # Filter to only active/orphaned locks (not stale or missing)
    echo "$results" | jq '[.[] | select(.status == "active" or .status == "orphaned")]'

    return 0
}

#######################################
# Get all locks (including stale) for display
# Arguments:
#   $1 - Path to .cleo directory (optional)
# Outputs:
#   JSON array of all lock info objects
# Returns:
#   0 on success
#######################################
get_all_locks() {
    local cleo_dir="${1:-.cleo}"
    local stale_threshold
    stale_threshold=$(get_stale_threshold)

    # Scan for lock files
    local lock_files_json
    lock_files_json=$(scan_lock_files "$cleo_dir")

    if [[ "$lock_files_json" == "[]" ]]; then
        echo "[]"
        return 0
    fi

    # Process each lock file
    local results="[]"
    local lock_file

    while IFS= read -r lock_file; do
        [[ -z "$lock_file" ]] && continue

        local status pid age operation process_name resource
        status=$(check_lock_status "$lock_file" "$stale_threshold")
        age=$(get_file_age "$lock_file")
        operation=$(infer_operation "$lock_file")
        resource=$(basename "$lock_file" .lock)

        # Get PID and process if active
        pid=""
        process_name=""
        if pid=$(get_lock_holder "$lock_file" 2>/dev/null); then
            process_name=$(get_process_name "$pid")
        fi

        # Build lock info object
        local lock_info
        lock_info=$(jq -nc \
            --arg file "$lock_file" \
            --arg resource "$resource" \
            --arg status "$status" \
            --arg pid "${pid:-null}" \
            --arg process "${process_name:-unknown}" \
            --arg operation "$operation" \
            --argjson age "$age" \
            '{
                file: $file,
                resource: $resource,
                status: $status,
                pid: (if $pid == "null" or $pid == "" then null else ($pid | tonumber) end),
                process: (if $process == "" then null else $process end),
                operation: $operation,
                age_seconds: $age,
                age_human: (
                    if $age < 60 then "\($age)s ago"
                    elif $age < 3600 then "\(($age / 60) | floor)m ago"
                    else "\(($age / 3600) | floor)h ago"
                    end
                )
            }')

        results=$(echo "$results" | jq --argjson lock "$lock_info" '. + [$lock]')
    done < <(echo "$lock_files_json" | jq -r '.[]')

    # Filter out missing locks
    echo "$results" | jq '[.[] | select(.status != "missing")]'

    return 0
}

# ============================================================================
# WAIT FOR LOCKS
# ============================================================================

#######################################
# Wait for all active locks to be released
# Arguments:
#   $1 - Timeout in seconds (default: 30)
#   $2 - Path to .cleo directory (optional)
# Returns:
#   0 if all locks released, 1 if timeout
#######################################
wait_for_locks() {
    local timeout="${1:-30}"
    local cleo_dir="${2:-.cleo}"
    local start_time
    start_time=$(date +%s)

    while true; do
        local active_locks
        active_locks=$(get_active_locks "$cleo_dir")
        local lock_count
        lock_count=$(echo "$active_locks" | jq 'length')

        if [[ "$lock_count" -eq 0 ]]; then
            return 0
        fi

        # Check timeout
        local elapsed
        elapsed=$(($(date +%s) - start_time))
        if [[ $elapsed -ge $timeout ]]; then
            echo "Timeout waiting for locks after ${timeout}s" >&2
            echo "Active locks:" >&2
            echo "$active_locks" | jq -r '.[] | "  \(.resource) - \(.status) (\(.age_human))"' >&2
            return 1
        fi

        # Wait a bit before checking again
        sleep 0.5
    done
}

# ============================================================================
# FORMATTING FUNCTIONS
# ============================================================================

#######################################
# Format lock info for human display
# Arguments:
#   $1 - JSON lock info object or array
# Outputs:
#   Human-readable lock status
#######################################
format_lock_info() {
    local lock_json="$1"

    # Check if it's an array or object
    local is_array
    is_array=$(echo "$lock_json" | jq 'type == "array"')

    if [[ "$is_array" == "true" ]]; then
        local count
        count=$(echo "$lock_json" | jq 'length')

        if [[ "$count" -eq 0 ]]; then
            echo "No active locks detected"
            return 0
        fi

        echo "CONCURRENT OPERATIONS"
        echo "$lock_json" | jq -r '.[] |
            (if .status == "active" then "  \u26A0\uFE0F  " else "  \u2753 " end) +
            "\(.resource) locked" +
            (if .pid then " by PID \(.pid)" else "" end) +
            (if .process and .process != "unknown" then " (\(.process))" else "" end) +
            ", \(.age_human)"'
    else
        # Single lock object
        echo "$lock_json" | jq -r '
            (if .status == "active" then "\u26A0\uFE0F  " else "\u2753 " end) +
            "\(.resource) - \(.status)" +
            (if .pid then " (PID \(.pid))" else "" end) +
            " \(.age_human)"'
    fi
}

# ============================================================================
# TASK CONFLICT DETECTION
# ============================================================================

#######################################
# Get conflicting operation types for a locked resource
# Arguments:
#   $1 - Resource name (e.g., "todo.json")
# Outputs:
#   JSON array of conflicting operation types
#######################################
get_conflicting_operations() {
    local resource="$1"

    case "$resource" in
        todo.json)
            # All task write operations conflict
            echo '["add", "update", "complete", "delete", "reopen", "reparent"]'
            ;;
        todo-archive.json)
            echo '["archive", "unarchive", "restore"]'
            ;;
        todo-log.json)
            echo '["log", "audit"]'
            ;;
        focus.json)
            echo '["focus", "unfocus"]'
            ;;
        sessions.json)
            echo '["session-start", "session-end", "session-switch"]'
            ;;
        config.json)
            echo '["config-set", "config-update"]'
            ;;
        *)
            echo '["write"]'
            ;;
    esac
}

#######################################
# Check if a task operation would conflict with active locks
# Arguments:
#   $1 - Operation type (e.g., "add", "update", "archive")
#   $2 - Path to .cleo directory (optional)
# Outputs:
#   JSON object with conflict info
# Returns:
#   0 if no conflict, 1 if conflict detected
#######################################
check_operation_conflict() {
    local operation="$1"
    local cleo_dir="${2:-.cleo}"

    local active_locks
    active_locks=$(get_active_locks "$cleo_dir")

    if [[ "$active_locks" == "[]" ]]; then
        echo '{"conflicts": false, "locks": []}'
        return 0
    fi

    # Map operation to resource(s) it would access
    local resources=()
    case "$operation" in
        add|update|complete|delete|reopen|reparent|cancel|uncancel)
            resources+=("todo.json")
            ;;
        archive|unarchive)
            resources+=("todo.json" "todo-archive.json")
            ;;
        focus|unfocus)
            resources+=("focus.json" "todo.json")
            ;;
        session-start|session-end|session-switch)
            resources+=("sessions.json" "todo.json")
            ;;
        config-set|config-update)
            resources+=("config.json")
            ;;
        analyze)
            # Analyze is read-only but conflicts with writes
            resources+=("todo.json")
            ;;
        *)
            resources+=("todo.json")
            ;;
    esac

    # Check if any active lock is on a resource we need
    local conflicting_locks="[]"
    for resource in "${resources[@]}"; do
        local matching
        matching=$(echo "$active_locks" | jq --arg res "$resource" \
            '[.[] | select(.resource == $res)]')
        if [[ "$matching" != "[]" ]]; then
            conflicting_locks=$(echo "$conflicting_locks" | jq --argjson new "$matching" '. + $new')
        fi
    done

    local conflict_count
    conflict_count=$(echo "$conflicting_locks" | jq 'length')

    if [[ "$conflict_count" -gt 0 ]]; then
        jq -nc \
            --argjson locks "$conflicting_locks" \
            --arg operation "$operation" \
            '{
                conflicts: true,
                operation: $operation,
                locks: $locks,
                message: "Operation \($operation) would conflict with \($locks | length) active lock(s)"
            }'
        return 1
    else
        echo '{"conflicts": false, "locks": []}'
        return 0
    fi
}

#######################################
# Get tasks that would conflict with active locks
# Arguments:
#   $1 - JSON array of tasks to check
#   $2 - Path to .cleo directory (optional)
# Outputs:
#   JSON array of task IDs that would conflict
#######################################
get_conflicting_tasks() {
    local tasks_json="$1"
    local cleo_dir="${2:-.cleo}"

    local active_locks
    active_locks=$(get_active_locks "$cleo_dir")

    if [[ "$active_locks" == "[]" ]]; then
        echo "[]"
        return 0
    fi

    # Check if todo.json is locked - affects all pending tasks
    local todo_locked
    todo_locked=$(echo "$active_locks" | jq '[.[] | select(.resource == "todo.json")] | length > 0')

    if [[ "$todo_locked" == "true" ]]; then
        # All pending/active tasks would conflict with writes
        echo "$tasks_json" | jq '[.[] | select(.status == "pending" or .status == "active") | .id]'
    else
        # No todo.json lock - no task conflicts
        echo "[]"
    fi
}

#######################################
# Get lock-based warnings for analyze output
# Arguments:
#   $1 - Path to .cleo directory (optional)
# Outputs:
#   JSON object with warnings for analysis
#######################################
get_lock_warnings() {
    local cleo_dir="${1:-.cleo}"

    local active_locks all_locks
    active_locks=$(get_active_locks "$cleo_dir")
    all_locks=$(get_all_locks "$cleo_dir")

    local active_count stale_count orphan_count
    active_count=$(echo "$active_locks" | jq '[.[] | select(.status == "active")] | length')
    stale_count=$(echo "$all_locks" | jq '[.[] | select(.status == "stale")] | length')
    orphan_count=$(echo "$all_locks" | jq '[.[] | select(.status == "orphaned")] | length')

    local warnings="[]"
    local severity="none"

    # Active locks - warn about concurrent operations
    if [[ "$active_count" -gt 0 ]]; then
        severity="warn"
        local active_resources
        active_resources=$(echo "$active_locks" | jq -r '[.[] | select(.status == "active") | .resource] | join(", ")')
        warnings=$(echo "$warnings" | jq --arg msg "Active lock(s) on: $active_resources" '. + [$msg]')
    fi

    # Orphaned locks - may indicate crashed processes
    if [[ "$orphan_count" -gt 0 ]]; then
        severity="warn"
        warnings=$(echo "$warnings" | jq --argjson count "$orphan_count" '. + ["Orphaned lock(s) detected (\($count)) - process may have crashed"]')
    fi

    # Stale locks - may need cleanup
    if [[ "$stale_count" -gt 0 ]]; then
        if [[ "$severity" == "none" ]]; then
            severity="info"
        fi
        warnings=$(echo "$warnings" | jq --argjson count "$stale_count" '. + ["Stale lock file(s) detected (\($count)) - consider cleanup"]')
    fi

    jq -nc \
        --arg severity "$severity" \
        --argjson warnings "$warnings" \
        --argjson activeLocks "$active_locks" \
        --argjson allLocks "$all_locks" \
        --argjson activeCount "$active_count" \
        --argjson staleCount "$stale_count" \
        --argjson orphanCount "$orphan_count" \
        '{
            severity: $severity,
            warnings: $warnings,
            counts: {
                active: $activeCount,
                stale: $staleCount,
                orphaned: $orphanCount
            },
            activeLocks: $activeLocks,
            allLocks: $allLocks,
            suggestion: (
                if $orphanCount > 0 then "Run: rm .cleo/*.lock to clean up orphaned locks"
                elif $staleCount > 0 then "Stale locks can be safely removed"
                elif $activeCount > 0 then "Wait for operations to complete or investigate"
                else null
                end
            )
        }'
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f scan_lock_files
export -f get_lock_holder
export -f is_pid_running
export -f get_process_name
export -f check_lock_status
export -f get_file_age
export -f infer_operation
export -f get_active_locks
export -f get_all_locks
export -f wait_for_locks
export -f format_lock_info
export -f get_stale_threshold
export -f is_lock_awareness_enabled
export -f get_conflicting_operations
export -f check_operation_conflict
export -f get_conflicting_tasks
export -f get_lock_warnings
