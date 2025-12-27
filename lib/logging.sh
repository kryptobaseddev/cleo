#!/usr/bin/env bash
# logging.sh - Change log functions for CLEO system
#
# LAYER: 2 (Data Layer)
# DEPENDENCIES: atomic-write.sh
# PROVIDES: log_operation, get_log_entries, get_task_history, prune_log,
#           LOG_FILE, generate_log_id

#=== SOURCE GUARD ================================================
[[ -n "${_LOGGING_LOADED:-}" ]] && return 0
declare -r _LOGGING_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source atomic-write for primitive atomic operations (Layer 1)
# Note: atomic-write.sh transitively provides platform-compat.sh
if [[ -f "$_LIB_DIR/atomic-write.sh" ]]; then
    # shellcheck source=lib/atomic-write.sh
    source "$_LIB_DIR/atomic-write.sh"
else
    echo "ERROR: Cannot find atomic-write.sh in $_LIB_DIR" >&2
    exit 1
fi

# ============================================================================
# VERSION
# ============================================================================

_CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

if [[ -f "$_CLEO_HOME/VERSION" ]]; then
  CLEO_VERSION="$(cat "$_CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$_LIB_DIR/../VERSION" ]]; then
  CLEO_VERSION="$(cat "$_LIB_DIR/../VERSION" | tr -d '[:space:]')"
else
  CLEO_VERSION="0.1.0"
fi

# ============================================================================
# CONFIGURATION AND GLOBALS
# ============================================================================

# Default log file location (relative to project .cleo directory)
# Only set if not already defined (prevent re-sourcing errors)
if [[ -z "${LOG_FILE:-}" ]]; then
    readonly LOG_FILE="${CLEO_DIR:-.cleo}/todo-log.json"
fi

# Log entry ID format: log_<12-hex-chars>
if [[ -z "${LOG_ID_PATTERN:-}" ]]; then
    readonly LOG_ID_PATTERN="^log_[a-f0-9]{12}$"
fi

# Valid action types per schema
if [[ -z "${VALID_ACTIONS:-}" ]]; then
    readonly VALID_ACTIONS=(
        "session_start"
        "session_end"
        "task_created"
        "task_updated"
        "status_changed"
        "task_archived"
        "task_cancelled"
        "task_restored_from_cancelled"
        "task_reopened"
        "dependency_removed"
        "focus_changed"
        "config_changed"
        "validation_run"
        "checksum_updated"
        "error_occurred"
        "phase_changed"
        "phase_started"
        "phase_completed"
        "phase_rollback"
        "phase_deleted"
    )
fi

# Valid actor types
if [[ -z "${VALID_ACTORS:-}" ]]; then
    readonly VALID_ACTORS=("human" "claude" "system")
fi

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

# Check if color output should be used
# Respects NO_COLOR and FORCE_COLOR environment variables per https://no-color.org
# Returns: 0 if colors should be used, 1 otherwise
should_use_color() {
    # NO_COLOR takes precedence - disable colors if set (to any value)
    [[ -n "${NO_COLOR:-}" ]] && return 1

    # FORCE_COLOR overrides TTY detection
    [[ -n "${FORCE_COLOR:-}" ]] && return 0

    # Default: check if stdout is a terminal and tput is available
    [[ -t 1 ]] && command -v tput &>/dev/null && [[ $(tput colors 2>/dev/null) -ge 8 ]]
}

# Generate unique log entry ID
# Format: log_<12-hex-chars>
# Output: log ID string
generate_log_id() {
    local random_hex
    random_hex=$(generate_random_hex 6)
    echo "log_${random_hex}"
}

# Get ISO 8601 timestamp
# Output: timestamp string in ISO format (uses platform-compat)
get_timestamp() {
    get_iso_timestamp
}

# Validate action type
# Arguments:
#   $1 - action string
# Returns: 0 if valid, 1 if invalid
validate_action() {
    local action="$1"
    local valid_action

    for valid_action in "${VALID_ACTIONS[@]}"; do
        if [[ "$action" == "$valid_action" ]]; then
            return 0
        fi
    done

    return 1
}

# Validate actor type
# Arguments:
#   $1 - actor string
# Returns: 0 if valid, 1 if invalid
validate_actor() {
    local actor="$1"
    local valid_actor

    for valid_actor in "${VALID_ACTORS[@]}"; do
        if [[ "$actor" == "$valid_actor" ]]; then
            return 0
        fi
    done

    return 1
}

# ============================================================================
# LOG FILE INITIALIZATION
# ============================================================================

# Initialize log file if it doesn't exist
# Arguments:
#   $1 - (optional) log file path, defaults to LOG_FILE
# Returns: 0 on success, 1 on failure
init_log_file() {
    local log_path="${1:-$LOG_FILE}"
    local log_dir

    log_dir=$(dirname "$log_path")

    # Create directory if needed
    if [[ ! -d "$log_dir" ]]; then
        mkdir -p "$log_dir" || {
            echo "ERROR: Cannot create log directory: $log_dir" >&2
            return 1
        }
    fi

    # Create empty log file if it doesn't exist
    if [[ ! -f "$log_path" ]]; then
        local project_name
        project_name=$(basename "$(pwd)")

        cat > "$log_path" <<EOF
{
  "version": "${CLEO_VERSION}",
  "project": "${project_name}",
  "_meta": {
    "totalEntries": 0,
    "firstEntry": null,
    "lastEntry": null,
    "entriesPruned": 0
  },
  "entries": []
}
EOF

        if [[ $? -eq 0 ]]; then
            echo "Initialized log file: $log_path" >&2
            return 0
        else
            echo "ERROR: Failed to create log file: $log_path" >&2
            return 1
        fi
    fi

    return 0
}

# ============================================================================
# LOG ENTRY CREATION
# ============================================================================

# Create a log entry object as JSON
# Arguments:
#   $1 - action (required)
#   $2 - actor (required)
#   $3 - taskId (optional, use "null" if not applicable)
#   $4 - before state JSON (optional, use "null" if not applicable)
#   $5 - after state JSON (optional, use "null" if not applicable)
#   $6 - details JSON/string (optional, use "null" if not applicable)
#   $7 - sessionId (optional, use "null" if not applicable)
# Output: JSON log entry object
create_log_entry() {
    local action="$1"
    local actor="$2"
    local task_id="${3:-null}"
    local before="${4:-null}"
    local after="${5:-null}"
    local details="${6:-null}"
    local session_id="${7:-null}"
    local log_id
    local timestamp

    # Validate required fields
    if [[ -z "$action" ]] || [[ -z "$actor" ]]; then
        echo "ERROR: action and actor are required" >&2
        return 1
    fi

    if ! validate_action "$action"; then
        echo "ERROR: Invalid action type: $action" >&2
        return 1
    fi

    if ! validate_actor "$actor"; then
        echo "ERROR: Invalid actor type: $actor" >&2
        return 1
    fi

    # Generate ID and timestamp
    log_id=$(generate_log_id)
    timestamp=$(get_timestamp)

    # Build JSON entry using jq
    jq -n \
        --arg id "$log_id" \
        --arg ts "$timestamp" \
        --arg action "$action" \
        --arg actor "$actor" \
        --argjson taskId "$(echo "$task_id" | jq -R 'if . == "null" then null else . end')" \
        --argjson sessionId "$(echo "$session_id" | jq -R 'if . == "null" then null else . end')" \
        --argjson before "$before" \
        --argjson after "$after" \
        --argjson details "$details" \
        '{
            id: $id,
            timestamp: $ts,
            sessionId: $sessionId,
            action: $action,
            actor: $actor,
            taskId: $taskId,
            before: $before,
            after: $after,
            details: $details
        }'
}

# ============================================================================
# LOG OPERATIONS
# ============================================================================

# Append log entry to log file (atomic operation)
# Arguments:
#   $1 - action (required)
#   $2 - actor (required)
#   $3 - taskId (optional)
#   $4 - before state JSON (optional)
#   $5 - after state JSON (optional)
#   $6 - details JSON/string (optional)
#   $7 - sessionId (optional)
#   $8 - log file path (optional, defaults to LOG_FILE)
# Returns: 0 on success, 1 on failure
log_operation() {
    local action="$1"
    local actor="$2"
    local task_id="${3:-null}"
    local before="${4:-null}"
    local after="${5:-null}"
    local details="${6:-null}"
    local session_id="${7:-null}"
    local log_path="${8:-$LOG_FILE}"
    local log_entry
    local timestamp
    local updated_log

    # Initialize log file if needed
    if [[ ! -f "$log_path" ]]; then
        init_log_file "$log_path" || return 1
    fi

    # Create log entry
    log_entry=$(create_log_entry "$action" "$actor" "$task_id" "$before" "$after" "$details" "$session_id")
    if [[ $? -ne 0 ]]; then
        echo "ERROR: Failed to create log entry" >&2
        return 1
    fi

    timestamp=$(get_timestamp)

    # Build updated log content
    updated_log=$(jq \
        --argjson entry "$log_entry" \
        --arg timestamp "$timestamp" \
        '
        .entries += [$entry] |
        ._meta.totalEntries = (.entries | length) |
        ._meta.lastEntry = $timestamp |
        if ._meta.firstEntry == null then
            ._meta.firstEntry = $timestamp
        else
            .
        end
        ' "$log_path")

    if [[ $? -ne 0 ]]; then
        echo "ERROR: Failed to build log entry" >&2
        return 1
    fi

    # Atomic write via aw_atomic_write (Layer 1 primitive)
    if ! aw_atomic_write "$log_path" "$updated_log"; then
        echo "ERROR: Failed to save log entry" >&2
        return 1
    fi

    return 0
}

# ============================================================================
# LOG ROTATION AND PRUNING
# ============================================================================

# Rotate log file based on retention policy
# Arguments:
#   $1 - retention days (from config)
#   $2 - log file path (optional, defaults to LOG_FILE)
# Returns: 0 on success, 1 on failure
rotate_log() {
    local retention_days="${1:-30}"
    local log_path="${2:-$LOG_FILE}"
    local cutoff_timestamp
    local pruned_count
    local updated_log

    if [[ ! -f "$log_path" ]]; then
        echo "ERROR: Log file does not exist: $log_path" >&2
        return 1
    fi

    # Calculate cutoff date (retention_days ago) - uses platform-compat
    cutoff_timestamp=$(date_days_ago "$retention_days")

    # Get pruned count before modification
    pruned_count=$(jq -r \
        --arg cutoff "$cutoff_timestamp" \
        '.entries | map(select(.timestamp < $cutoff)) | length' \
        "$log_path")

    # Build updated log content with filtered entries
    updated_log=$(jq \
        --arg cutoff "$cutoff_timestamp" \
        '
        .entries as $all_entries |
        (.entries | length) as $original_count |
        .entries = (.entries | map(select(.timestamp >= $cutoff))) |
        ._meta.totalEntries = (.entries | length) |
        ._meta.entriesPruned = (._meta.entriesPruned + ($original_count - (.entries | length))) |
        if (.entries | length) > 0 then
            ._meta.firstEntry = (.entries[0].timestamp) |
            ._meta.lastEntry = (.entries[-1].timestamp)
        else
            ._meta.firstEntry = null |
            ._meta.lastEntry = null
        end
        ' "$log_path")

    if [[ $? -ne 0 ]]; then
        echo "ERROR: Failed to build rotated log content" >&2
        return 1
    fi

    # Atomic write via aw_atomic_write (Layer 1 primitive)
    if ! aw_atomic_write "$log_path" "$updated_log"; then
        echo "ERROR: Failed to save rotated log file" >&2
        return 1
    fi

    echo "Pruned $pruned_count log entries older than $retention_days days" >&2
    return 0
}

# Check if log rotation is needed based on config
# Arguments:
#   $1 - config file path
#   $2 - log file path (optional, defaults to LOG_FILE)
# Returns: 0 if rotation performed, 1 if not needed or error
check_and_rotate_log() {
    local config_path="$1"
    local log_path="${2:-$LOG_FILE}"
    local retention_days
    local logging_enabled

    if [[ ! -f "$config_path" ]]; then
        echo "ERROR: Config file not found: $config_path" >&2
        return 1
    fi

    # Read config settings
    logging_enabled=$(jq -r '.logging.enabled // true' "$config_path")
    retention_days=$(jq -r '.logging.retentionDays // 30' "$config_path")

    if [[ "$logging_enabled" != "true" ]]; then
        return 1
    fi

    # Perform rotation
    rotate_log "$retention_days" "$log_path"
}

# ============================================================================
# LOG QUERY FUNCTIONS
# ============================================================================

# Get log entries with optional filtering
# Arguments:
#   $1 - filter type (action|taskId|actor|date_range)
#   $2 - filter value(s)
#   $3 - log file path (optional, defaults to LOG_FILE)
# Output: JSON array of matching log entries
get_log_entries() {
    local filter_type="${1:-all}"
    local filter_value="${2:-}"
    local log_path="${3:-$LOG_FILE}"

    if [[ ! -f "$log_path" ]]; then
        echo "[]"
        return 0
    fi

    case "$filter_type" in
        action)
            jq --arg action "$filter_value" \
                '.entries | map(select(.action == $action))' \
                "$log_path"
            ;;
        taskId)
            jq --arg taskId "$filter_value" \
                '.entries | map(select(.taskId == $taskId))' \
                "$log_path"
            ;;
        actor)
            jq --arg actor "$filter_value" \
                '.entries | map(select(.actor == $actor))' \
                "$log_path"
            ;;
        date_range)
            # filter_value should be "start_date,end_date"
            local start_date="${filter_value%,*}"
            local end_date="${filter_value#*,}"
            jq --arg start "$start_date" --arg end "$end_date" \
                '.entries | map(select(.timestamp >= $start and .timestamp <= $end))' \
                "$log_path"
            ;;
        all)
            jq '.entries' "$log_path"
            ;;
        *)
            echo "ERROR: Invalid filter type: $filter_type" >&2
            echo "[]"
            return 1
            ;;
    esac
}

# Get most recent log entries
# Arguments:
#   $1 - count (number of entries to retrieve)
#   $2 - log file path (optional, defaults to LOG_FILE)
# Output: JSON array of log entries
get_recent_log_entries() {
    local count="${1:-10}"
    local log_path="${2:-$LOG_FILE}"

    if [[ ! -f "$log_path" ]]; then
        echo "[]"
        return 0
    fi

    jq --argjson count "$count" \
        '.entries | reverse | .[:$count] | reverse' \
        "$log_path"
}

# Get log statistics
# Arguments:
#   $1 - log file path (optional, defaults to LOG_FILE)
# Output: JSON object with statistics
get_log_stats() {
    local log_path="${1:-$LOG_FILE}"

    if [[ ! -f "$log_path" ]]; then
        echo '{"totalEntries":0,"firstEntry":null,"lastEntry":null,"entriesPruned":0}'
        return 0
    fi

    jq '._meta' "$log_path"
}

# ============================================================================
# CONVENIENCE LOGGING FUNCTIONS
# ============================================================================

# Log task creation
log_task_created() {
    local task_id="$1"
    local task_content="$2"
    local session_id="${3:-null}"
    local details

    details=$(jq -n --arg content "$task_content" '{content: $content}')
    log_operation "task_created" "claude" "$task_id" "null" "null" "$details" "$session_id"
}

# Log task status change
log_status_changed() {
    local task_id="$1"
    local old_status="$2"
    local new_status="$3"
    local session_id="${4:-null}"
    local before
    local after

    before=$(jq -n --arg status "$old_status" '{status: $status}')
    after=$(jq -n --arg status "$new_status" '{status: $status}')
    log_operation "status_changed" "claude" "$task_id" "$before" "$after" "null" "$session_id"
}

# Log task update
log_task_updated() {
    local task_id="$1"
    local field="$2"
    local old_value="$3"
    local new_value="$4"
    local session_id="${5:-null}"
    local details

    details=$(jq -n \
        --arg field "$field" \
        --arg old "$old_value" \
        --arg new "$new_value" \
        '{field: $field, oldValue: $old, newValue: $new}')
    log_operation "task_updated" "claude" "$task_id" "null" "null" "$details" "$session_id"
}

# Log session start
log_session_start() {
    local session_id="$1"
    local details="${2:-null}"

    log_operation "session_start" "system" "null" "null" "null" "$details" "$session_id"
}

# Log session end
log_session_end() {
    local session_id="$1"
    local details="${2:-null}"

    log_operation "session_end" "system" "null" "null" "null" "$details" "$session_id"
}

# Log validation run
log_validation() {
    local result="$1"
    local details="$2"

    log_operation "validation_run" "system" "null" "null" "null" "$details" "null"
}

# Log error
log_error() {
    local error_code="$1"
    local error_message="$2"
    local recoverable="${3:-false}"
    local task_id="${4:-null}"
    local details

    details=$(jq -n \
        --arg code "$error_code" \
        --arg message "$error_message" \
        --argjson recoverable "$recoverable" \
        '{error: {code: $code, message: $message, recoverable: $recoverable}}')
    log_operation "error_occurred" "system" "$task_id" "null" "null" "$details" "null"
}

# ============================================================================
# PHASE LOGGING FUNCTIONS
# ============================================================================

# Log phase change (setting current phase)
# Args: $1 = old phase, $2 = new phase, $3 = session_id (optional)
log_phase_changed() {
    local old_phase="$1"
    local new_phase="$2"
    local session_id="${3:-null}"
    local before
    local after
    local details

    before=$(jq -n --arg phase "$old_phase" '{currentPhase: $phase}')
    after=$(jq -n --arg phase "$new_phase" '{currentPhase: $phase}')
    details=$(jq -n --arg from "$old_phase" --arg to "$new_phase" '{transitionType: "set", fromPhase: $from, toPhase: $to}')

    log_operation "phase_changed" "human" "null" "$before" "$after" "$details" "$session_id"
}

# Log phase started (pending → active)
# Args: $1 = phase slug, $2 = session_id (optional)
log_phase_started() {
    local phase="$1"
    local session_id="${2:-null}"
    local before
    local after
    local details
    local timestamp

    timestamp=$(get_timestamp)
    before=$(jq -n --arg slug "$phase" '{phase: {slug: $slug, status: "pending"}}')
    after=$(jq -n --arg slug "$phase" --arg ts "$timestamp" '{phase: {slug: $slug, status: "active", startedAt: $ts}}')
    details=$(jq -n --arg slug "$phase" '{phase: $slug, action: "start"}')

    log_operation "phase_started" "human" "null" "$before" "$after" "$details" "$session_id"
}

# Log phase completed (active → completed)
# Args: $1 = phase slug, $2 = started_at timestamp, $3 = session_id (optional)
log_phase_completed() {
    local phase="$1"
    local started_at="${2:-null}"
    local session_id="${3:-null}"
    local before
    local after
    local details
    local timestamp
    local duration_days

    timestamp=$(get_timestamp)
    before=$(jq -n --arg slug "$phase" --arg started "$started_at" '{phase: {slug: $slug, status: "active", startedAt: $started}}')
    after=$(jq -n --arg slug "$phase" --arg started "$started_at" --arg completed "$timestamp" '{phase: {slug: $slug, status: "completed", startedAt: $started, completedAt: $completed}}')

    # Calculate duration if possible
    if [[ "$started_at" != "null" && -n "$started_at" ]]; then
        # Simple day calculation
        local start_epoch end_epoch
        start_epoch=$(date -d "$started_at" +%s 2>/dev/null || echo 0)
        end_epoch=$(date +%s)
        duration_days=$(( (end_epoch - start_epoch) / 86400 ))
        details=$(jq -n --arg slug "$phase" --argjson days "$duration_days" '{phase: $slug, action: "complete", durationDays: $days}')
    else
        details=$(jq -n --arg slug "$phase" '{phase: $slug, action: "complete"}')
    fi

    log_operation "phase_completed" "human" "null" "$before" "$after" "$details" "$session_id"
}

# Log phase rollback
# Args: $1 = from phase, $2 = to phase, $3 = reason (optional), $4 = session_id (optional)
log_phase_rollback() {
    local from_phase="$1"
    local to_phase="$2"
    local reason="${3:-}"
    local session_id="${4:-null}"
    local before
    local after
    local details

    before=$(jq -n --arg phase "$from_phase" '{currentPhase: $phase}')
    after=$(jq -n --arg phase "$to_phase" '{currentPhase: $phase}')

    if [[ -n "$reason" ]]; then
        details=$(jq -n --arg from "$from_phase" --arg to "$to_phase" --arg reason "$reason" '{transitionType: "rollback", fromPhase: $from, toPhase: $to, reason: $reason}')
    else
        details=$(jq -n --arg from "$from_phase" --arg to "$to_phase" '{transitionType: "rollback", fromPhase: $from, toPhase: $to}')
    fi

    log_operation "phase_rollback" "human" "null" "$before" "$after" "$details" "$session_id"
}

log_phase_deleted() {
    local phase_slug="$1"
    local reassign_to="${2:-none}"
    local task_count="${3:-0}"
    local session_id="${4:-null}"
    local before
    local after
    local details

    before=$(jq -n --arg phase "$phase_slug" '{deletedPhase: $phase}')
    after=$(jq -n '{deletedPhase: null}')

    if [[ "$reassign_to" != "none" ]]; then
        details=$(jq -n \
            --arg phase "$phase_slug" \
            --arg reassign "$reassign_to" \
            --argjson count "$task_count" \
            '{operation: "delete", deletedPhase: $phase, tasksReassigned: $count, reassignedTo: $reassign}')
    else
        details=$(jq -n --arg phase "$phase_slug" '{operation: "delete", deletedPhase: $phase}')
    fi

    log_operation "phase_deleted" "system" "null" "$before" "$after" "$details" "$session_id"
}

# ============================================================================
# LOG MIGRATION
# ============================================================================

# Migrate old schema log entries to new schema
# Transforms: operation -> action, user -> actor, task_id -> taskId
# Arguments:
#   $1 - log file path (optional, defaults to LOG_FILE)
# Returns: 0 on success, 1 on failure
# Output: Number of entries migrated
migrate_log_entries() {
    local log_path="${1:-$LOG_FILE}"
    local backup_file
    local migrated_count
    local updated_log

    if [[ ! -f "$log_path" ]]; then
        echo "ERROR: Log file does not exist: $log_path" >&2
        return 1
    fi

    # Count entries needing migration (schema change, action value mapping, or ID format)
    # Note: Count unique entries needing ANY type of migration
    local schema_count
    local action_count
    local id_count
    schema_count=$(jq '[.entries[] | select(has("operation"))] | length' "$log_path")
    action_count=$(jq '[.entries[] | select(.action == "create" or .action == "update" or .action == "system_initialized")] | length' "$log_path")
    id_count=$(jq '[.entries[] | select(.id | test("^log-[0-9]+-[0-9a-f]+$"))] | length' "$log_path")
    # Count unique entries needing at least one migration
    migrated_count=$(jq '[.entries[] | select(
        has("operation") or
        .action == "create" or .action == "update" or .action == "system_initialized" or
        (.id | test("^log-[0-9]+-[0-9a-f]+$"))
    )] | length' "$log_path")

    if [[ "$migrated_count" -eq 0 ]]; then
        echo "No entries need migration" >&2
        return 0
    fi

    echo "Found $migrated_count entries to migrate ($schema_count schema changes, $action_count action mappings, $id_count ID fixes)" >&2

    # Create backup
    backup_file="${log_path}.pre-migration.$(date +%Y%m%d-%H%M%S)"
    cp "$log_path" "$backup_file" || {
        echo "ERROR: Failed to create backup: $backup_file" >&2
        return 1
    }
    echo "Created backup: $backup_file" >&2

    # Validate backup was created and is valid JSON
    if ! jq empty "$backup_file" 2>/dev/null; then
        echo "ERROR: Backup file is not valid JSON: $backup_file" >&2
        rm -f "$backup_file"
        return 1
    fi

    # Transform entries using jq - build updated content in memory
    updated_log=$(jq --arg version "$CLEO_VERSION" '
        # Define action value mappings from old to new schema
        def map_action_value:
            if . == "create" then "task_created"
            elif . == "update" then "task_updated"
            elif . == "system_initialized" then "config_changed"
            else .
            end;

        # Fix log entry ID format: log-<timestamp>-<hex> → log_<12hexchars>
        # Only transforms IDs with multiple dashes (timestamp format)
        def fix_log_id:
            if test("^log-[0-9]+-[0-9a-f]+$") then
                # Extract hex chars only, remove dashes and digits, pad/truncate to 12 chars
                ("log_" + (split("-") | last | .[0:12]))
            else
                .
            end;

        # Update version metadata
        .version = $version |
        .entries = (.entries | map(
            if has("operation") then
                # Transform old schema to new schema
                {
                    id: (.id | fix_log_id),
                    timestamp: .timestamp,
                    sessionId: (.sessionId // null),
                    action: (.operation | map_action_value),
                    actor: (.user // "system"),
                    taskId: (.task_id // null),
                    before: .before,
                    after: .after,
                    details: .details
                } + (if has("error") then {error: .error} else {} end)
            else
                # Also map action values in entries that already have new schema
                {
                    id: (.id | fix_log_id),
                    timestamp: .timestamp,
                    sessionId: (.sessionId // null),
                    action: (.action | map_action_value),
                    actor: .actor,
                    taskId: .taskId,
                    before: .before,
                    after: .after,
                    details: .details
                } + (if has("error") then {error: .error} else {} end)
            end
        ))
    ' "$log_path")

    if [[ $? -ne 0 ]]; then
        echo "ERROR: Failed to build migrated log content" >&2
        return 1
    fi

    # Validate migrated content has valid JSON
    if ! echo "$updated_log" | jq empty 2>/dev/null; then
        echo "ERROR: Migrated content contains invalid JSON" >&2
        return 1
    fi

    # Atomic write via aw_atomic_write (Layer 1 primitive)
    if ! aw_atomic_write "$log_path" "$updated_log"; then
        echo "ERROR: Failed to save migrated log file" >&2
        return 1
    fi

    echo "Successfully migrated $migrated_count entries" >&2
    echo "$migrated_count"
    return 0
}

# ============================================================================
# ERROR HANDLING
# ============================================================================

# Handle logging errors gracefully
# Arguments:
#   $1 - error message
handle_log_error() {
    local error_msg="$1"
    echo "WARNING: Logging failed: $error_msg" >&2
    echo "This will not prevent the operation from completing" >&2
}


# ============================================================================
# CANCELLATION LOGGING FUNCTIONS
# ============================================================================

# Log task cancellation with full cascade details
# Parameters:
#   $1 - Primary task ID being cancelled
#   $2 - Cancellation reason
#   $3 - Child handling mode (cascade, orphan, block)
#   $4 - JSON array of all affected task IDs (including primary)
#   $5 - Session ID (optional)
log_task_cancelled() {
    local task_id="$1"
    local reason="$2"
    local child_mode="${3:-orphan}"
    local affected_ids="${4:-[]}"
    local session_id="${5:-null}"
    local before
    local after
    local details
    local cascade_count
    local original_status="${6:-pending}"

    # Calculate cascade count (affected minus primary task)
    cascade_count=$(echo "$affected_ids" | jq 'length - 1')
    [[ "$cascade_count" -lt 0 ]] && cascade_count=0

    before=$(jq -n --arg status "$original_status" '{status: $status}')
    after=$(jq -n '{status: "cancelled"}')

    details=$(jq -n \
        --arg reason "$reason" \
        --arg mode "$child_mode" \
        --argjson affected "$affected_ids" \
        --argjson count "$cascade_count" \
        '{
            originalStatus: $status,
            cancellationReason: $reason,
            childHandlingMode: $mode,
            affectedTaskIds: $affected,
            cascadeCount: $count
        }' --arg status "$original_status")

    log_operation "task_cancelled" "system" "$task_id" "$before" "$after" "$details" "$session_id"
}

# Log task restoration from cancelled status
# Parameters:
#   $1 - Task ID being restored
#   $2 - Original cancellation reason (for audit trail)
#   $3 - New status to restore to
#   $4 - Session ID (optional)
log_task_restored() {
    local task_id="$1"
    local original_reason="${2:-}"
    local new_status="${3:-pending}"
    local session_id="${4:-null}"
    local before
    local after
    local details

    before=$(jq -n '{status: "cancelled"}')
    after=$(jq -n --arg status "$new_status" '{status: $status}')

    if [[ -n "$original_reason" ]]; then
        details=$(jq -n \
            --arg reason "$original_reason" \
            --arg new_status "$new_status" \
            '{
                restoredFrom: "cancelled",
                originalCancellationReason: $reason,
                restoredToStatus: $new_status
            }')
    else
        details=$(jq -n --arg new_status "$new_status" '{
            restoredFrom: "cancelled",
            restoredToStatus: $new_status
        }')
    fi

    log_operation "task_restored_from_cancelled" "system" "$task_id" "$before" "$after" "$details" "$session_id"
}

# Log dependency removal (e.g., when a depended-upon task is cancelled)
# Parameters:
#   $1 - Task ID that had dependency removed
#   $2 - Removed dependency ID (the cancelled task)
#   $3 - Reason for removal
#   $4 - Session ID (optional)
log_dependency_removed() {
    local task_id="$1"
    local removed_dep_id="$2"
    local reason="${3:-task_cancelled}"
    local session_id="${4:-null}"
    local details

    details=$(jq -n \
        --arg removed "$removed_dep_id" \
        --arg reason "$reason" \
        '{
            removedDependencyId: $removed,
            removalReason: $reason
        }')

    log_operation "dependency_removed" "system" "$task_id" "null" "null" "$details" "$session_id"
}

# ============================================================================
# EXPORTS
# ============================================================================

# Export functions for use by other scripts
export -f should_use_color
export -f generate_log_id
export -f get_timestamp
export -f init_log_file
export -f create_log_entry
export -f log_operation
export -f rotate_log
export -f check_and_rotate_log
export -f get_log_entries
export -f get_recent_log_entries
export -f get_log_stats
export -f log_task_created
export -f log_status_changed
export -f log_task_updated
export -f log_session_start
export -f log_session_end
export -f log_validation
export -f log_error
export -f log_phase_changed
export -f log_phase_started
export -f log_phase_completed
export -f log_phase_rollback
export -f log_phase_deleted
export -f handle_log_error
export -f migrate_log_entries
