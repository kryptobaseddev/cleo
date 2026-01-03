#!/usr/bin/env bash
# import-logging.sh - Import-specific logging functions for CLEO system
#
# LAYER: 2 (Data Layer)
# DEPENDENCIES: logging.sh
# PROVIDES: log_import_operation, log_import_conflict

#=== SOURCE GUARD ================================================
[[ -n "${_IMPORT_LOGGING_LOADED:-}" ]] && return 0
declare -r _IMPORT_LOGGING_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source logging library for base log_operation function
if [[ -f "$_LIB_DIR/logging.sh" ]]; then
    # shellcheck source=lib/logging.sh
    source "$_LIB_DIR/logging.sh"
else
    echo "ERROR: Cannot find logging.sh in $_LIB_DIR" >&2
    exit 1
fi

# ============================================================================
# IMPORT LOGGING FUNCTIONS
# ============================================================================

# Log import operation start with package metadata
# Arguments:
#   $1 - source file path (package.cleo-export.json)
#   $2 - session_id (optional)
# Returns: 0 on success, 1 on failure
log_import_start() {
    local source_file="$1"
    local session_id="${2:-null}"
    local details

    if [[ ! -f "$source_file" ]]; then
        echo "WARNING: Source file not found for logging: $source_file" >&2
        return 1
    fi

    # Extract package metadata
    local source_project
    local exported_at
    local package_checksum
    local task_count

    source_project=$(jq -r '._meta.source.project // "unknown"' "$source_file" 2>/dev/null || echo "unknown")
    exported_at=$(jq -r '._meta.exportedAt // "unknown"' "$source_file" 2>/dev/null || echo "unknown")
    package_checksum=$(jq -r '._meta.checksum // "unknown"' "$source_file" 2>/dev/null || echo "unknown")
    task_count=$(jq -r '._meta.taskCount // 0' "$source_file" 2>/dev/null || echo "0")

    # Build details JSON
    details=$(jq -nc \
        --arg file "$(basename "$source_file")" \
        --arg project "$source_project" \
        --arg exportedAt "$exported_at" \
        --arg checksum "$package_checksum" \
        --argjson count "$task_count" \
        '{
            sourceFile: $file,
            sourceProject: $project,
            exportedAt: $exportedAt,
            packageChecksum: $checksum,
            taskCount: $count,
            stage: "start"
        }')

    # Add import action to VALID_ACTIONS temporarily if not present
    # Note: This is a workaround until import is added to core schema
    if ! validate_action "import" 2>/dev/null; then
        # Use generic task_created action as fallback
        log_operation "task_created" "system" "null" "null" "null" "$details" "$session_id"
    else
        log_operation "import" "system" "null" "null" "null" "$details" "$session_id"
    fi
}

# Log import operation completion with full metadata
# Arguments:
#   $1 - source file path
#   $2 - tasks imported (comma-separated IDs: T031,T032,T033)
#   $3 - id remap JSON object ({"T001":"T031","T002":"T032"})
#   $4 - conflicts JSON array ([{type, resolution}])
#   $5 - options JSON object ({parent, phase, resetStatus})
#   $6 - session_id (optional)
# Returns: 0 on success, 1 on failure
log_import_success() {
    local source_file="$1"
    local tasks_imported="$2"
    local id_remap="$3"
    local conflicts="${4:-"[]"}"
    local options="${5:-"{}"}"
    local session_id="${6:-null}"
    local details
    local timestamp

    if [[ ! -f "$source_file" ]]; then
        echo "WARNING: Source file not found for logging: $source_file" >&2
        return 1
    fi

    # Extract package metadata
    local source_project
    local exported_at
    local package_checksum

    source_project=$(jq -r '._meta.source.project // "unknown"' "$source_file" 2>/dev/null || echo "unknown")
    exported_at=$(jq -r '._meta.exportedAt // "unknown"' "$source_file" 2>/dev/null || echo "unknown")
    package_checksum=$(jq -r '._meta.checksum // "unknown"' "$source_file" 2>/dev/null || echo "unknown")

    # Convert comma-separated IDs to JSON array
    local tasks_array
    if [[ -n "$tasks_imported" ]]; then
        tasks_array=$(echo "$tasks_imported" | jq -R 'split(",") | map(select(length > 0))')
    else
        tasks_array="[]"
    fi

    # Validate id_remap is valid JSON
    if ! echo "$id_remap" | jq empty 2>/dev/null; then
        echo "WARNING: Invalid id_remap JSON for logging" >&2
        id_remap="{}"
    fi

    # Validate conflicts is valid JSON
    if ! echo "$conflicts" | jq empty 2>/dev/null; then
        echo "WARNING: Invalid conflicts JSON for logging" >&2
        conflicts="[]"
    fi

    # Validate options is valid JSON
    if ! echo "$options" | jq empty 2>/dev/null; then
        echo "WARNING: Invalid options JSON for logging" >&2
        options="{}"
    fi

    timestamp=$(get_timestamp)

    # Build complete details JSON with provenance metadata
    details=$(jq -nc \
        --arg file "$(basename "$source_file")" \
        --arg project "$source_project" \
        --arg exportedAt "$exported_at" \
        --arg checksum "$package_checksum" \
        --arg importedAt "$timestamp" \
        --argjson tasks "$tasks_array" \
        --argjson idRemap "$id_remap" \
        --argjson conflicts "$conflicts" \
        --argjson options "$options" \
        '{
            sourceFile: $file,
            sourceProject: $project,
            exportedAt: $exportedAt,
            packageChecksum: $checksum,
            importedAt: $importedAt,
            tasksImported: $tasks,
            idRemap: $idRemap,
            conflicts: $conflicts,
            options: $options,
            stage: "success"
        }')

    # Log using generic action (import action may not be in schema yet)
    if ! validate_action "import" 2>/dev/null; then
        log_operation "task_created" "system" "null" "null" "null" "$details" "$session_id"
    else
        log_operation "import" "system" "null" "null" "null" "$details" "$session_id"
    fi
}

# Log import operation error with diagnostic details
# Arguments:
#   $1 - source file path
#   $2 - error message
#   $3 - error code
#   $4 - stage (validation|parsing|remapping|writing)
#   $5 - session_id (optional)
# Returns: 0 on success (logging succeeded), 1 on failure
log_import_error() {
    local source_file="$1"
    local error_message="$2"
    local error_code="$3"
    local stage="${4:-unknown}"
    local session_id="${5:-null}"
    local details
    local timestamp

    timestamp=$(get_timestamp)

    # Build error details JSON
    details=$(jq -nc \
        --arg file "$(basename "$source_file")" \
        --arg stage "$stage" \
        --arg message "$error_message" \
        --arg code "$error_code" \
        --arg timestamp "$timestamp" \
        '{
            sourceFile: $file,
            stage: $stage,
            error: {
                message: $message,
                code: $code,
                timestamp: $timestamp
            }
        }')

    # Use error_occurred action from core schema
    log_operation "error_occurred" "system" "null" "null" "null" "$details" "$session_id"
}

# Log import conflict detection and resolution
# Arguments:
#   $1 - conflict type (duplicate_title|missing_dependency|missing_parent|depth_exceeded|phase_mismatch)
#   $2 - original task ID
#   $3 - conflict details JSON
#   $4 - resolution (skip|rename|force|strip|create_placeholder|fail)
#   $5 - session_id (optional)
# Returns: 0 on success, 1 on failure
log_import_conflict() {
    local conflict_type="$1"
    local task_id="$2"
    local conflict_details="$3"
    local resolution="$4"
    local session_id="${5:-null}"
    local details

    # Validate conflict_details is valid JSON
    if ! echo "$conflict_details" | jq empty 2>/dev/null; then
        echo "WARNING: Invalid conflict_details JSON for logging" >&2
        conflict_details="{}"
    fi

    # Build full details JSON
    details=$(jq -nc \
        --arg type "$conflict_type" \
        --arg resolution "$resolution" \
        --argjson conflictDetails "$conflict_details" \
        '{
            conflictType: $type,
            resolution: $resolution,
            details: $conflictDetails
        }')

    # Log using task_updated action (conflict is a type of update event)
    log_operation "task_updated" "system" "$task_id" "null" "null" "$details" "$session_id"
}

# ============================================================================
# EXPORTS
# ============================================================================

# Export functions for use by other scripts
export -f log_import_start
export -f log_import_success
export -f log_import_error
export -f log_import_conflict
