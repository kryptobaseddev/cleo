#!/usr/bin/env bash
# Cancellation archival operations for cleo
#
# LAYER: 3 (Domain Logic)
# DEPENDENCIES: file-ops.sh (transitive: config.sh, exit-codes.sh)
# PROVIDES: prepare_cancel_archive_entry, archive_cancelled_task,
#           archive_cancelled_tasks, should_auto_archive_cancel

#=== SOURCE GUARD ================================================
[[ -n "${_ARCHIVE_CANCEL_LOADED:-}" ]] && return 0
declare -r _ARCHIVE_CANCEL_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_ARCHIVE_CANCEL_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source file-ops library (transitively loads config.sh and exit-codes.sh)
if [[ -f "$_ARCHIVE_CANCEL_LIB_DIR/data/file-ops.sh" ]]; then
    # shellcheck source=lib/data/file-ops.sh
    source "$_ARCHIVE_CANCEL_LIB_DIR/data/file-ops.sh"
fi

# Fallback exit codes (in case file-ops.sh not available)
: "${EXIT_SUCCESS:=0}"
: "${EXIT_FILE_ERROR:=3}"
: "${EXIT_VALIDATION_ERROR:=6}"

# ============================================================================
# CONFIGURATION HELPERS
# ============================================================================

# Check if cancelled tasks should be archived immediately (daysUntilArchive = 0)
# Returns: "true" if immediate archive, "false" otherwise
should_auto_archive_cancel() {
    local days_until_archive
    if declare -f get_cancel_days_until_archive >/dev/null 2>&1; then
        days_until_archive=$(get_cancel_days_until_archive)
    else
        days_until_archive=3  # Default
    fi

    if [[ "$days_until_archive" -eq 0 ]]; then
        echo "true"
    else
        echo "false"
    fi
}

# Get days until cancelled tasks are archived
# Returns: integer (default: 3)
get_cancel_archive_days() {
    if declare -f get_cancel_days_until_archive >/dev/null 2>&1; then
        get_cancel_days_until_archive
    else
        echo "3"
    fi
}

# ============================================================================
# ARCHIVE ENTRY PREPARATION
# ============================================================================

# prepare_cancel_archive_entry - Build archive entry for a cancelled task
#
# Creates the archive entry with proper _archive metadata including
# cancellationDetails object per the archive.schema.json spec.
#
# Args:
#   $1 - Task JSON object (the task being archived)
#   $2 - Session ID (optional, defaults to "system")
#   $3 - Archive source (optional, defaults to "delete-command")
#
# Returns: JSON object ready to be added to archivedTasks array
# Exit code: 0 on success, 1 on failure
prepare_cancel_archive_entry() {
    local task_json="$1"
    local session_id="${2:-system}"
    local archive_source="${3:-delete-command}"

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Extract task fields
    local task_id cancelled_at cancel_reason previous_status
    task_id=$(echo "$task_json" | jq -r '.id // empty')
    cancelled_at=$(echo "$task_json" | jq -r '.cancelledAt // empty')
    cancel_reason=$(echo "$task_json" | jq -r '.cancelReason // .cancellationReason // "No reason provided"')
    previous_status=$(echo "$task_json" | jq -r '
        if .status == "cancelled" then
            # Try to get from notes or default to pending
            if (.notes // [] | any(contains("[CANCELLED"))) then
                # Extract previous status from before state if available
                "pending"
            else
                "pending"
            end
        else
            .status
        end
    ')

    # Use current timestamp if cancelledAt not set
    [[ -z "$cancelled_at" ]] && cancelled_at="$timestamp"

    # Calculate cycle time (days from creation to cancellation)
    local cycle_time_days="null"
    local created_at
    created_at=$(echo "$task_json" | jq -r '.createdAt // empty')
    if [[ -n "$created_at" && -n "$cancelled_at" ]]; then
        cycle_time_days=$(jq -nc \
            --arg created "$created_at" \
            --arg cancelled "$cancelled_at" \
            '((($cancelled | fromdateiso8601) - ($created | fromdateiso8601)) / 86400 | floor)'
        ) || cycle_time_days="null"
    fi

    # Build the archive entry
    echo "$task_json" | jq \
        --arg ts "$timestamp" \
        --arg sid "$session_id" \
        --arg source "$archive_source" \
        --arg cancelledAt "$cancelled_at" \
        --arg cancelReason "$cancel_reason" \
        --arg previousStatus "$previous_status" \
        --argjson cycleTime "$cycle_time_days" \
        '
        # Remove internal fields that should not be in archive
        del(.cancelReason) |

        # Set completedAt to cancelledAt for consistency (cancelled is a form of completion)
        .completedAt = $cancelledAt |
        .cancelledAt = $cancelledAt |
        .cancellationReason = $cancelReason |

        # Add archive metadata
        ._archive = {
            "archivedAt": $ts,
            "reason": "cancelled",
            "archiveSource": $source,
            "sessionId": $sid,
            "cycleTimeDays": $cycleTime,
            "cancellationDetails": {
                "cancelledAt": $cancelledAt,
                "cancellationReason": $cancelReason,
                "cancelledBy": $sid,
                "previousStatus": $previousStatus
            }
        }
        '
}

# ============================================================================
# ARCHIVE OPERATIONS
# ============================================================================

# archive_cancelled_task - Archive a single cancelled task
#
# Moves a cancelled task from todo.json to todo-archive.json with proper
# metadata. Updates statistics.cancelled counter.
#
# Args:
#   $1 - Task ID (e.g., "T001")
#   $2 - Path to todo.json
#   $3 - Path to todo-archive.json
#   $4 - Session ID (optional)
#
# Returns: JSON result object with success status
# Exit code: 0 on success, non-zero on failure
archive_cancelled_task() {
    local task_id="$1"
    local todo_file="$2"
    local archive_file="$3"
    local session_id="${4:-system}"

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Validate files exist
    if [[ ! -f "$todo_file" ]]; then
        echo '{"success": false, "error": "Todo file not found"}'
        return "${EXIT_FILE_ERROR:-3}"
    fi

    # Get the task
    local task
    task=$(jq --arg id "$task_id" '.tasks[] | select(.id == $id)' "$todo_file")
    if [[ -z "$task" || "$task" == "null" ]]; then
        echo '{"success": false, "error": "Task not found"}'
        return "${EXIT_NOT_FOUND:-4}"
    fi

    # Verify task is cancelled
    local status
    status=$(echo "$task" | jq -r '.status')
    if [[ "$status" != "cancelled" ]]; then
        echo "{\"success\": false, \"error\": \"Task is not cancelled (status: $status)\"}"
        return "${EXIT_VALIDATION_ERROR:-6}"
    fi

    # Prepare archive entry
    local archive_entry
    archive_entry=$(prepare_cancel_archive_entry "$task" "$session_id" "delete-command")

    # Create archive file if it doesn't exist
    if [[ ! -f "$archive_file" ]]; then
        local project_name
        project_name=$(jq -r '.project.name // .project // "unknown"' "$todo_file")

        # Get schema version from archive schema file (fail loudly if unreadable)
        local version
        version=$(get_schema_version_from_file "archive") || {
            echo "ERROR: Failed to read archive schema version" >&2
            return "${EXIT_FILE_READ_ERROR:-3}"
        }

        cat > "$archive_file" << EOF
{
  "version": "$version",
  "project": "$project_name",
  "_meta": { "totalArchived": 0, "lastArchived": null, "oldestTask": null, "newestTask": null },
  "archivedTasks": [],
  "phaseSummary": {},
  "statistics": { "byPhase": {}, "byPriority": {"critical":0,"high":0,"medium":0,"low":0}, "byLabel": {}, "averageCycleTime": null, "cancelled": 0 }
}
EOF
    fi

    # Update archive file
    local updated_archive
    updated_archive=$(jq --argjson entry "$archive_entry" --arg ts "$timestamp" '
        # Add task to archive
        .archivedTasks += [$entry] |

        # Update metadata
        ._meta.totalArchived += 1 |
        ._meta.lastArchived = $ts |

        # Update statistics.cancelled counter (initialize if not exists)
        .statistics.cancelled = ((.statistics.cancelled // 0) + 1) |

        # Update byPriority
        .statistics.byPriority[$entry.priority] = ((.statistics.byPriority[$entry.priority] // 0) + 1) |

        # Update byPhase if task has phase
        (if $entry.phase then
            .statistics.byPhase[$entry.phase] = ((.statistics.byPhase[$entry.phase] // 0) + 1)
        else . end) |

        # Update byLabel
        (reduce ($entry.labels // [])[] as $label (.;
            .statistics.byLabel[$label] = ((.statistics.byLabel[$label] // 0) + 1)
        ))
    ' "$archive_file")

    # Write updated archive
    if declare -f save_json >/dev/null 2>&1; then
        if ! save_json "$archive_file" "$updated_archive"; then
            echo '{"success": false, "error": "Failed to write archive file"}'
            return "${EXIT_FILE_ERROR:-3}"
        fi
    else
        echo "$updated_archive" > "$archive_file"
    fi

    # Remove task from todo.json
    local updated_todo
    updated_todo=$(jq --arg id "$task_id" '
        .tasks = [.tasks[] | select(.id != $id)]
    ' "$todo_file")

    # Recalculate checksum
    local new_checksum
    new_checksum=$(echo "$updated_todo" | jq -c '.tasks' | sha256sum | cut -c1-16)
    updated_todo=$(echo "$updated_todo" | jq --arg checksum "$new_checksum" --arg ts "$timestamp" '
        ._meta.checksum = $checksum |
        .lastUpdated = $ts
    ')

    # Write updated todo
    if declare -f save_json >/dev/null 2>&1; then
        if ! save_json "$todo_file" "$updated_todo"; then
            echo '{"success": false, "error": "Failed to write todo file"}'
            return "${EXIT_FILE_ERROR:-3}"
        fi
    else
        echo "$updated_todo" > "$todo_file"
    fi

    # Return success
    jq -nc \
        --arg taskId "$task_id" \
        --arg ts "$timestamp" \
        '{
            "success": true,
            "taskId": $taskId,
            "archivedAt": $ts,
            "reason": "cancelled"
        }'

    return 0
}

# archive_cancelled_tasks - Batch archive multiple cancelled tasks
#
# Archives an array of cancelled tasks together (for cascade deletions).
# All tasks are archived with the same timestamp for grouping.
#
# Args:
#   $1 - JSON array of task IDs (e.g., '["T001", "T002", "T003"]')
#   $2 - Path to todo.json
#   $3 - Path to todo-archive.json
#   $4 - Session ID (optional)
#
# Returns: JSON result object with success status and archived count
# Exit code: 0 on success, non-zero on failure
archive_cancelled_tasks() {
    local task_ids_json="$1"
    local todo_file="$2"
    local archive_file="$3"
    local session_id="${4:-system}"

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Validate files exist
    if [[ ! -f "$todo_file" ]]; then
        echo '{"success": false, "error": "Todo file not found"}'
        return "${EXIT_FILE_ERROR:-3}"
    fi

    # Get all tasks to archive
    local tasks_to_archive
    tasks_to_archive=$(jq --argjson ids "$task_ids_json" '
        [.tasks[] | select(.id as $id | $ids | index($id)) | select(.status == "cancelled")]
    ' "$todo_file")

    local archive_count
    archive_count=$(echo "$tasks_to_archive" | jq 'length')

    if [[ "$archive_count" -eq 0 ]]; then
        echo '{"success": true, "archivedCount": 0, "message": "No cancelled tasks to archive"}'
        return 0
    fi

    # Prepare all archive entries
    local archive_entries="[]"
    while IFS= read -r task; do
        local entry
        entry=$(prepare_cancel_archive_entry "$task" "$session_id" "delete-command")
        archive_entries=$(echo "$archive_entries" | jq --argjson e "$entry" '. + [$e]')
    done < <(echo "$tasks_to_archive" | jq -c '.[]')

    # Create archive file if it doesn't exist
    if [[ ! -f "$archive_file" ]]; then
        local project_name
        project_name=$(jq -r '.project.name // .project // "unknown"' "$todo_file")

        # Get schema version from archive schema file (fail loudly if unreadable)
        local version
        version=$(get_schema_version_from_file "archive") || {
            echo "ERROR: Failed to read archive schema version" >&2
            return "${EXIT_FILE_READ_ERROR:-3}"
        }

        cat > "$archive_file" << EOF
{
  "version": "$version",
  "project": "$project_name",
  "_meta": { "totalArchived": 0, "lastArchived": null, "oldestTask": null, "newestTask": null },
  "archivedTasks": [],
  "phaseSummary": {},
  "statistics": { "byPhase": {}, "byPriority": {"critical":0,"high":0,"medium":0,"low":0}, "byLabel": {}, "averageCycleTime": null, "cancelled": 0 }
}
EOF
    fi

    # Update archive file with all entries
    local updated_archive
    updated_archive=$(jq --argjson entries "$archive_entries" --arg ts "$timestamp" --argjson count "$archive_count" '
        # Add all tasks to archive
        .archivedTasks += $entries |

        # Update metadata
        ._meta.totalArchived += $count |
        ._meta.lastArchived = $ts |

        # Update statistics.cancelled counter
        .statistics.cancelled = ((.statistics.cancelled // 0) + $count) |

        # Update byPriority for all entries
        (reduce $entries[] as $entry (.;
            .statistics.byPriority[$entry.priority] = ((.statistics.byPriority[$entry.priority] // 0) + 1)
        )) |

        # Update byPhase for all entries
        (reduce $entries[] as $entry (.;
            if $entry.phase then
                .statistics.byPhase[$entry.phase] = ((.statistics.byPhase[$entry.phase] // 0) + 1)
            else . end
        )) |

        # Update byLabel for all entries
        (reduce $entries[] as $entry (.;
            reduce ($entry.labels // [])[] as $label (.;
                .statistics.byLabel[$label] = ((.statistics.byLabel[$label] // 0) + 1)
            )
        ))
    ' "$archive_file")

    # Write updated archive
    if declare -f save_json >/dev/null 2>&1; then
        if ! save_json "$archive_file" "$updated_archive"; then
            echo '{"success": false, "error": "Failed to write archive file"}'
            return "${EXIT_FILE_ERROR:-3}"
        fi
    else
        echo "$updated_archive" > "$archive_file"
    fi

    # Remove all archived tasks from todo.json
    local updated_todo
    updated_todo=$(jq --argjson ids "$task_ids_json" '
        .tasks = [.tasks[] | select(.id as $id | $ids | index($id) | not)]
    ' "$todo_file")

    # Recalculate checksum
    local new_checksum
    new_checksum=$(echo "$updated_todo" | jq -c '.tasks' | sha256sum | cut -c1-16)
    updated_todo=$(echo "$updated_todo" | jq --arg checksum "$new_checksum" --arg ts "$timestamp" '
        ._meta.checksum = $checksum |
        .lastUpdated = $ts
    ')

    # Write updated todo
    if declare -f save_json >/dev/null 2>&1; then
        if ! save_json "$todo_file" "$updated_todo"; then
            echo '{"success": false, "error": "Failed to write todo file"}'
            return "${EXIT_FILE_ERROR:-3}"
        fi
    else
        echo "$updated_todo" > "$todo_file"
    fi

    # Return success
    jq -nc \
        --argjson ids "$task_ids_json" \
        --argjson count "$archive_count" \
        --arg ts "$timestamp" \
        '{
            "success": true,
            "archivedCount": $count,
            "taskIds": $ids,
            "archivedAt": $ts,
            "reason": "cancelled"
        }'

    return 0
}

# ============================================================================
# RESTORE OPERATIONS
# ============================================================================

# restore_cancelled_from_archive - Restore a cancelled task from archive to todo
#
# Moves a cancelled task from todo-archive.json back to todo.json,
# setting status to pending and preserving history.
#
# Args:
#   $1 - Task ID (e.g., "T001")
#   $2 - Path to todo.json
#   $3 - Path to todo-archive.json
#   $4 - Restoration note (optional)
#   $5 - Session ID (optional)
#
# Returns: JSON result object with success status and restored task
# Exit code: 0 on success, non-zero on failure
restore_cancelled_from_archive() {
    local task_id="$1"
    local todo_file="$2"
    local archive_file="$3"
    local restore_note="${4:-}"
    local session_id="${5:-system}"

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Validate archive file exists
    if [[ ! -f "$archive_file" ]]; then
        echo '{"success": false, "error": "Archive file not found"}'
        return "${EXIT_FILE_ERROR:-3}"
    fi

    # Find the task in archive
    local archived_task
    archived_task=$(jq --arg id "$task_id" '.archivedTasks[] | select(.id == $id)' "$archive_file")
    if [[ -z "$archived_task" || "$archived_task" == "null" ]]; then
        echo '{"success": false, "error": "Task not found in archive"}'
        return "${EXIT_NOT_FOUND:-4}"
    fi

    # Verify task was cancelled (not just completed)
    local status archive_reason
    status=$(echo "$archived_task" | jq -r '.status')
    archive_reason=$(echo "$archived_task" | jq -r '._archive.reason // "unknown"')
    if [[ "$status" != "cancelled" && "$archive_reason" != "cancelled" ]]; then
        echo "{\"success\": false, \"error\": \"Task was not cancelled (status: $status, reason: $archive_reason)\"}"
        return "${EXIT_VALIDATION_ERROR:-6}"
    fi

    # Extract original cancellation info for the note
    local original_reason cancelled_at
    original_reason=$(echo "$archived_task" | jq -r '.cancellationReason // ._archive.cancellationDetails.cancellationReason // "No reason provided"')
    cancelled_at=$(echo "$archived_task" | jq -r '.cancelledAt // ._archive.cancellationDetails.cancelledAt // ""')

    # Build restoration note
    local full_restore_note="[RESTORED FROM ARCHIVE $timestamp]"
    if [[ -n "$original_reason" && "$original_reason" != "No reason provided" ]]; then
        full_restore_note="$full_restore_note Originally cancelled: $original_reason"
    fi
    if [[ -n "$restore_note" ]]; then
        full_restore_note="$full_restore_note | Restored because: $restore_note"
    fi

    # Prepare the restored task (clean up archive-specific fields)
    local restored_task
    restored_task=$(echo "$archived_task" | jq \
        --arg ts "$timestamp" \
        --arg note "$full_restore_note" \
        '
        # Set status back to pending
        .status = "pending" |

        # Remove archive metadata
        del(._archive) |

        # Remove cancellation fields
        del(.cancelledAt) |
        del(.cancellationReason) |
        del(.cancelReason) |
        del(.completedAt) |

        # Update timestamps
        .updatedAt = $ts |

        # Add restoration note
        .notes = ((.notes // []) + [$note])
        ')

    # Validate todo file exists
    if [[ ! -f "$todo_file" ]]; then
        echo '{"success": false, "error": "Todo file not found"}'
        return "${EXIT_FILE_ERROR:-3}"
    fi

    # Add task back to todo.json
    local updated_todo
    updated_todo=$(jq --argjson task "$restored_task" --arg ts "$timestamp" '
        .tasks += [$task] |
        .lastUpdated = $ts
    ' "$todo_file")

    # Recalculate checksum
    local new_checksum
    new_checksum=$(echo "$updated_todo" | jq -c '.tasks' | sha256sum | cut -c1-16)
    updated_todo=$(echo "$updated_todo" | jq --arg checksum "$new_checksum" '
        ._meta.checksum = $checksum
    ')

    # Write updated todo
    if declare -f save_json >/dev/null 2>&1; then
        if ! save_json "$todo_file" "$updated_todo"; then
            echo '{"success": false, "error": "Failed to write todo file"}'
            return "${EXIT_FILE_ERROR:-3}"
        fi
    else
        echo "$updated_todo" > "$todo_file"
    fi

    # Remove task from archive
    local updated_archive
    updated_archive=$(jq --arg id "$task_id" --arg ts "$timestamp" '
        # Remove the task from archivedTasks
        .archivedTasks = [.archivedTasks[] | select(.id != $id)] |

        # Update metadata
        ._meta.totalArchived = (._meta.totalArchived - 1) |
        ._meta.lastModified = $ts |

        # Decrement statistics.cancelled
        .statistics.cancelled = ([(.statistics.cancelled // 1) - 1, 0] | max)
    ' "$archive_file")

    # Write updated archive
    if declare -f save_json >/dev/null 2>&1; then
        if ! save_json "$archive_file" "$updated_archive"; then
            echo '{"success": false, "error": "Failed to write archive file"}'
            return "${EXIT_FILE_ERROR:-3}"
        fi
    else
        echo "$updated_archive" > "$archive_file"
    fi

    # Return success with restored task
    jq -nc \
        --arg taskId "$task_id" \
        --arg ts "$timestamp" \
        --arg originalReason "$original_reason" \
        --argjson task "$restored_task" \
        '{
            "success": true,
            "taskId": $taskId,
            "restoredAt": $ts,
            "restoredFromArchive": true,
            "originalReason": $originalReason,
            "task": $task
        }'

    return 0
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f should_auto_archive_cancel
export -f get_cancel_archive_days
export -f prepare_cancel_archive_entry
export -f archive_cancelled_task
export -f archive_cancelled_tasks
export -f restore_cancelled_from_archive
