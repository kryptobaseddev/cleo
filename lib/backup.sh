#!/usr/bin/env bash
# Unified backup management for cleo
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: file-ops.sh, logging.sh
# PROVIDES: create_snapshot_backup, create_safety_backup, create_archive_backup,
#           create_migration_backup, list_typed_backups, restore_typed_backup,
#           rotate_backups, get_backup_metadata, BACKUP_TYPES

#=== SOURCE GUARD ================================================
[[ -n "${_BACKUP_LOADED:-}" ]] && return 0
declare -r _BACKUP_LOADED=1

# ============================================================================
# BACKUP TYPE TAXONOMY
# ============================================================================
#
# The backup system uses a hierarchical directory structure to organize
# different backup types with specific purposes and retention policies.
#
# Directory Structure:
#   .cleo/backups/
#   ├── snapshot/      Point-in-time snapshots (frequent, short retention)
#   ├── safety/        Pre-operation safety backups (auto-created before changes)
#   ├── incremental/   Delta-based backups (efficient storage, version history)
#   ├── archive/       Long-term archive backups (compressed, long retention)
#   └── migration/     Schema migration backups (versioned, permanent)
#
# Backup Types:
#
# 1. SNAPSHOT (snapshot/)
#    - Purpose: Complete system state capture at a point in time
#    - Trigger: Manual user request via `cleo backup`
#    - Contains: All system files (todo.json, todo-archive.json, config.json, todo-log.json)
#    - Retention: Configurable (default: keep last 10)
#    - Use Case: Regular backups, before major changes, scheduled snapshots
#    - Naming: snapshot_YYYYMMDD_HHMMSS[_custom_name]
#
# 2. SAFETY (safety/)
#    - Purpose: Pre-operation safety net for rollback capability
#    - Trigger: Automatic before any file modification operation
#    - Contains: Single file being modified
#    - Retention: Time-based (default: 7 days) + count-based (default: keep last 5)
#    - Use Case: Rollback protection, error recovery, undo capability
#    - Naming: safety_YYYYMMDD_HHMMSS_<operation>_<filename>
#
# 3. INCREMENTAL (incremental/)
#    - Purpose: Efficient file versioning with delta tracking
#    - Trigger: Automatic on file changes (when enabled)
#    - Contains: Single file version
#    - Retention: Configurable (default: keep last 10)
#    - Use Case: Version history, file evolution tracking, efficient storage
#    - Naming: incremental_YYYYMMDD_HHMMSS_<filename>
#
# 4. ARCHIVE (archive/)
#    - Purpose: Long-term preservation of completed work
#    - Trigger: Automatic before archive operations
#    - Contains: todo.json and todo-archive.json
#    - Retention: Configurable (default: keep last 3)
#    - Use Case: Long-term storage, compliance, historical records
#    - Naming: archive_YYYYMMDD_HHMMSS
#    - Future: May include compression (.tar.gz)
#
# 5. MIGRATION (migration/)
#    - Purpose: Schema version migration safety
#    - Trigger: Automatic before schema migrations
#    - Contains: All system files with version information
#    - Retention: PERMANENT (never auto-deleted)
#    - Use Case: Rollback from failed migrations, schema change audit trail
#    - Naming: migration_v<from>_to_v<to>_YYYYMMDD_HHMMSS
#    - Special: Marked with neverDelete flag
#
# Retention Policies:
#   - snapshot:     Count-based (maxSnapshots, default 10)
#   - safety:       Time-based (safetyRetentionDays, default 7) AND count-based (maxSafetyBackups, default 5)
#   - incremental:  Count-based (maxIncremental, default 10)
#   - archive:      Count-based (maxArchiveBackups, default 3)
#   - migration:    NEVER deleted automatically
#
# Configuration:
#   All retention policies are configurable via config.json:
#   {
#     "backup": {
#       "enabled": true,
#       "directory": ".cleo/backups",
#       "maxSnapshots": 10,
#       "maxSafetyBackups": 5,
#       "maxIncremental": 10,
#       "maxArchiveBackups": 3,
#       "safetyRetentionDays": 7
#     }
#   }
#
# ============================================================================

set -euo pipefail
IFS=$'\n\t'

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source required libraries
# NOTE: file-ops.sh sources platform-compat.sh, so we get platform functions transitively
if [[ -f "$_LIB_DIR/file-ops.sh" ]]; then
    # shellcheck source=lib/file-ops.sh
    source "$_LIB_DIR/file-ops.sh"
else
    echo "ERROR: Cannot find file-ops.sh in $_LIB_DIR" >&2
    exit 1
fi

if [[ -f "$_LIB_DIR/logging.sh" ]]; then
    # shellcheck source=lib/logging.sh
    source "$_LIB_DIR/logging.sh"
else
    echo "ERROR: Cannot find logging.sh in $_LIB_DIR" >&2
    exit 1
fi

# ============================================================================
# CONSTANTS
# ============================================================================

# Backup types
readonly BACKUP_TYPE_SNAPSHOT="snapshot"
readonly BACKUP_TYPE_SAFETY="safety"
readonly BACKUP_TYPE_INCREMENTAL="incremental"
readonly BACKUP_TYPE_ARCHIVE="archive"
readonly BACKUP_TYPE_MIGRATION="migration"

# Default configuration values
readonly DEFAULT_BACKUP_ENABLED=true
readonly DEFAULT_BACKUP_DIR=".cleo/backups"
readonly DEFAULT_MAX_SNAPSHOTS=10
readonly DEFAULT_MAX_SAFETY_BACKUPS=5
readonly DEFAULT_MAX_INCREMENTAL=10
readonly DEFAULT_MAX_ARCHIVE_BACKUPS=3
readonly DEFAULT_SAFETY_RETENTION_DAYS=7
readonly DEFAULT_SCHEDULED_ON_SESSION_START=false
readonly DEFAULT_SCHEDULED_ON_SESSION_END=false
readonly DEFAULT_SCHEDULED_ON_ARCHIVE=true
readonly DEFAULT_SCHEDULED_INTERVAL_MINUTES=0

# Schedule state file for tracking interval-based backups
readonly SCHEDULE_STATE_FILENAME=".schedule"

# Manifest file for O(1) backup lookups
readonly MANIFEST_FILENAME="backup-manifest.json"
readonly MANIFEST_VERSION="1.0.0"

# ============================================================================
# MANIFEST FUNCTIONS
# ============================================================================

# Initialize manifest file if it doesn't exist
# Args: none
# Returns: 0 on success, 1 on error
_init_manifest() {
    local backup_dir="${BACKUP_DIR:-$DEFAULT_BACKUP_DIR}"
    local manifest_path="$backup_dir/$MANIFEST_FILENAME"

    # Ensure backup directory exists
    if [[ ! -d "$backup_dir" ]]; then
        mkdir -p "$backup_dir" || {
            echo "ERROR: Failed to create backup directory: $backup_dir" >&2
            return 1
        }
    fi

    # Create manifest if it doesn't exist
    if [[ ! -f "$manifest_path" ]]; then
        local timestamp
        timestamp=$(get_iso_timestamp)
        jq -n \
            --arg schema "https://cleo-dev.com/schemas/v1/backup-manifest.schema.json" \
            --arg version "$MANIFEST_VERSION" \
            --arg created "$timestamp" \
            --arg modified "$timestamp" \
            '{
                "$schema": $schema,
                "_meta": {
                    "version": $version,
                    "created": $created,
                    "lastModified": $modified
                },
                "backups": []
            }' > "$manifest_path" || {
            echo "ERROR: Failed to create manifest file: $manifest_path" >&2
            return 1
        }
    fi

    return 0
}

# Add a backup entry to the manifest
# Args: $1 = backup_id, $2 = backup_type, $3 = backup_path, $4 = files_json, $5 = total_size, $6 = custom_name (optional)
# Returns: 0 on success, 1 on error
_add_to_manifest() {
    local backup_id="$1"
    local backup_type="$2"
    local backup_path="$3"
    local files_json="$4"
    local total_size="$5"
    local custom_name="${6:-}"

    local backup_dir="${BACKUP_DIR:-$DEFAULT_BACKUP_DIR}"
    local manifest_path="$backup_dir/$MANIFEST_FILENAME"

    # Ensure manifest exists
    _init_manifest || return 1

    local timestamp
    timestamp=$(get_iso_timestamp)

    # Calculate checksum summary (sha256 of concatenated file checksums)
    local checksum_summary=""
    if [[ -n "$files_json" && "$files_json" != "[]" ]]; then
        local checksums
        checksums=$(echo "$files_json" | jq -r '.[].checksum // empty' | tr '\n' ' ' | xargs echo)
        if [[ -n "$checksums" ]]; then
            checksum_summary=$(echo -n "$checksums" | safe_checksum_stdin)
        fi
    fi

    # Extract file names from files_json
    local file_names
    file_names=$(echo "$files_json" | jq -r '[.[].source // .[].backup] | unique')

    # Determine neverDelete flag (migration backups are permanent)
    local never_delete="false"
    if [[ "$backup_type" == "$BACKUP_TYPE_MIGRATION" ]]; then
        never_delete="true"
    fi

    # Create backup entry
    local entry
    if [[ -n "$custom_name" ]]; then
        entry=$(jq -n \
            --arg id "$backup_id" \
            --arg type "$backup_type" \
            --arg timestamp "$timestamp" \
            --arg path "$backup_path" \
            --argjson files "$file_names" \
            --arg checksumSummary "$checksum_summary" \
            --argjson sizeBytes "$total_size" \
            --argjson neverDelete "$never_delete" \
            --arg name "$custom_name" \
            '{
                id: $id,
                type: $type,
                timestamp: $timestamp,
                path: $path,
                files: $files,
                checksumSummary: $checksumSummary,
                sizeBytes: $sizeBytes,
                neverDelete: $neverDelete,
                name: $name
            }')
    else
        entry=$(jq -n \
            --arg id "$backup_id" \
            --arg type "$backup_type" \
            --arg timestamp "$timestamp" \
            --arg path "$backup_path" \
            --argjson files "$file_names" \
            --arg checksumSummary "$checksum_summary" \
            --argjson sizeBytes "$total_size" \
            --argjson neverDelete "$never_delete" \
            '{
                id: $id,
                type: $type,
                timestamp: $timestamp,
                path: $path,
                files: $files,
                checksumSummary: $checksumSummary,
                sizeBytes: $sizeBytes,
                neverDelete: $neverDelete
            }')
    fi

    # Update manifest atomically
    local temp_manifest
    temp_manifest=$(mktemp)
    local modified_timestamp
    modified_timestamp=$(get_iso_timestamp)

    if jq --argjson entry "$entry" --arg modified "$modified_timestamp" \
        '.backups += [$entry] | ._meta.lastModified = $modified' \
        "$manifest_path" > "$temp_manifest" 2>/dev/null; then
        mv "$temp_manifest" "$manifest_path" || {
            rm -f "$temp_manifest"
            echo "ERROR: Failed to update manifest file" >&2
            return 1
        }
    else
        rm -f "$temp_manifest"
        echo "ERROR: Failed to add entry to manifest" >&2
        return 1
    fi

    return 0
}

# Remove a backup entry from the manifest
# Args: $1 = backup_id or backup_path
# Returns: 0 on success, 1 on error
_remove_from_manifest() {
    local identifier="$1"

    local backup_dir="${BACKUP_DIR:-$DEFAULT_BACKUP_DIR}"
    local manifest_path="$backup_dir/$MANIFEST_FILENAME"

    # If manifest doesn't exist, nothing to remove
    if [[ ! -f "$manifest_path" ]]; then
        return 0
    fi

    # Update manifest atomically
    local temp_manifest
    temp_manifest=$(mktemp)
    local modified_timestamp
    modified_timestamp=$(get_iso_timestamp)

    # Remove by id or path match
    if jq --arg id "$identifier" --arg path "$identifier" --arg modified "$modified_timestamp" \
        '.backups = [.backups[] | select(.id != $id and .path != $path)] | ._meta.lastModified = $modified' \
        "$manifest_path" > "$temp_manifest" 2>/dev/null; then
        mv "$temp_manifest" "$manifest_path" || {
            rm -f "$temp_manifest"
            echo "ERROR: Failed to update manifest file" >&2
            return 1
        }
    else
        rm -f "$temp_manifest"
        echo "ERROR: Failed to remove entry from manifest" >&2
        return 1
    fi

    return 0
}

# Get a backup entry from the manifest by ID
# Args: $1 = backup_id
# Output: JSON object of the backup entry or empty if not found
# Returns: 0 on success (even if not found), 1 on error
_get_from_manifest() {
    local backup_id="$1"

    local backup_dir="${BACKUP_DIR:-$DEFAULT_BACKUP_DIR}"
    local manifest_path="$backup_dir/$MANIFEST_FILENAME"

    # If manifest doesn't exist, return empty
    if [[ ! -f "$manifest_path" ]]; then
        echo ""
        return 0
    fi

    # Look up by ID
    local entry
    entry=$(jq --arg id "$backup_id" '.backups[] | select(.id == $id)' "$manifest_path" 2>/dev/null)

    if [[ -n "$entry" && "$entry" != "null" ]]; then
        echo "$entry"
    else
        echo ""
    fi

    return 0
}

# Get backups from manifest filtered by type
# Args: $1 = backup_type (or "all" for all types)
# Output: JSON array of backup entries
# Returns: 0 on success, 1 on error
_get_backups_from_manifest() {
    local filter_type="${1:-all}"

    local backup_dir="${BACKUP_DIR:-$DEFAULT_BACKUP_DIR}"
    local manifest_path="$backup_dir/$MANIFEST_FILENAME"

    # If manifest doesn't exist, return empty array
    if [[ ! -f "$manifest_path" ]]; then
        echo "[]"
        return 0
    fi

    if [[ "$filter_type" == "all" ]]; then
        jq '.backups' "$manifest_path" 2>/dev/null || echo "[]"
    else
        jq --arg type "$filter_type" '[.backups[] | select(.type == $type)]' "$manifest_path" 2>/dev/null || echo "[]"
    fi

    return 0
}

# Update manifest lastModified timestamp
# Args: none
# Returns: 0 on success, 1 on error
_update_manifest_meta() {
    local backup_dir="${BACKUP_DIR:-$DEFAULT_BACKUP_DIR}"
    local manifest_path="$backup_dir/$MANIFEST_FILENAME"

    if [[ ! -f "$manifest_path" ]]; then
        return 0
    fi

    local temp_manifest
    temp_manifest=$(mktemp)
    local modified_timestamp
    modified_timestamp=$(get_iso_timestamp)

    if jq --arg modified "$modified_timestamp" \
        '._meta.lastModified = $modified' \
        "$manifest_path" > "$temp_manifest" 2>/dev/null; then
        mv "$temp_manifest" "$manifest_path" || {
            rm -f "$temp_manifest"
            return 1
        }
    else
        rm -f "$temp_manifest"
        return 1
    fi

    return 0
}

# Rebuild manifest from existing backup directories
# Args: none
# Output: Summary of rebuilt entries
# Returns: 0 on success, 1 on error
_rebuild_manifest() {
    local backup_dir="${BACKUP_DIR:-$DEFAULT_BACKUP_DIR}"
    local manifest_path="$backup_dir/$MANIFEST_FILENAME"

    if [[ ! -d "$backup_dir" ]]; then
        echo "ERROR: Backup directory not found: $backup_dir" >&2
        return 1
    fi

    # Create fresh manifest
    local timestamp
    timestamp=$(get_iso_timestamp)
    local temp_manifest
    temp_manifest=$(mktemp)

    jq -n \
        --arg schema "https://cleo-dev.com/schemas/v1/backup-manifest.schema.json" \
        --arg version "$MANIFEST_VERSION" \
        --arg created "$timestamp" \
        --arg modified "$timestamp" \
        '{
            "$schema": $schema,
            "_meta": {
                "version": $version,
                "created": $created,
                "lastModified": $modified
            },
            "backups": []
        }' > "$temp_manifest"

    local count=0
    local type

    # Iterate through all backup types
    for type in "$BACKUP_TYPE_SNAPSHOT" "$BACKUP_TYPE_SAFETY" "$BACKUP_TYPE_INCREMENTAL" "$BACKUP_TYPE_ARCHIVE" "$BACKUP_TYPE_MIGRATION"; do
        local type_dir="$backup_dir/$type"
        if [[ ! -d "$type_dir" ]]; then
            continue
        fi

        # Find all backup directories
        while IFS= read -r backup_path; do
            [[ -z "$backup_path" ]] && continue
            [[ ! -d "$backup_path" ]] && continue

            local backup_id
            backup_id=$(basename "$backup_path")

            # Read metadata if available
            local metadata_file="$backup_path/metadata.json"
            local backup_timestamp=""
            local files_array="[]"
            local total_size=0
            local never_delete="false"

            if [[ -f "$metadata_file" ]]; then
                backup_timestamp=$(jq -r '.timestamp // empty' "$metadata_file" 2>/dev/null)
                files_array=$(jq '[.files[].source // .files[].backup] // []' "$metadata_file" 2>/dev/null || echo "[]")
                total_size=$(jq -r '.totalSize // 0' "$metadata_file" 2>/dev/null)
                never_delete=$(jq -r '.neverDelete // false' "$metadata_file" 2>/dev/null)
            fi

            # Use directory mtime if no timestamp in metadata
            if [[ -z "$backup_timestamp" ]]; then
                backup_timestamp=$(get_iso_timestamp)
            fi

            # Calculate checksum summary from existing files
            local checksum_summary=""
            if [[ -f "$metadata_file" ]]; then
                local checksums
                checksums=$(jq -r '.files[].checksum // empty' "$metadata_file" 2>/dev/null | tr '\n' ' ' | xargs echo)
                if [[ -n "$checksums" ]]; then
                    checksum_summary=$(echo -n "$checksums" | safe_checksum_stdin)
                fi
            fi

            # Calculate actual size if not in metadata
            if [[ "$total_size" -eq 0 ]]; then
                total_size=$(_calculate_backup_size "$backup_path")
            fi

            # Create entry
            local entry
            entry=$(jq -n \
                --arg id "$backup_id" \
                --arg type "$type" \
                --arg timestamp "$backup_timestamp" \
                --arg path "$backup_path" \
                --argjson files "$files_array" \
                --arg checksumSummary "$checksum_summary" \
                --argjson sizeBytes "$total_size" \
                --argjson neverDelete "$never_delete" \
                '{
                    id: $id,
                    type: $type,
                    timestamp: $timestamp,
                    path: $path,
                    files: $files,
                    checksumSummary: $checksumSummary,
                    sizeBytes: $sizeBytes,
                    neverDelete: $neverDelete
                }')

            # Add to manifest
            jq --argjson entry "$entry" '.backups += [$entry]' "$temp_manifest" > "${temp_manifest}.tmp" && \
                mv "${temp_manifest}.tmp" "$temp_manifest"

            count=$((count + 1))
        done < <(find "$type_dir" -maxdepth 1 -name "${type}_*" -type d 2>/dev/null)
    done

    # Move temp manifest to final location
    mv "$temp_manifest" "$manifest_path" || {
        rm -f "$temp_manifest"
        echo "ERROR: Failed to save rebuilt manifest" >&2
        return 1
    }

    echo "Rebuilt manifest with $count backup entries"
    return 0
}

# Check if manifest exists and is valid
# Args: none
# Returns: 0 if manifest is valid, 1 if missing or invalid
_manifest_exists() {
    local backup_dir="${BACKUP_DIR:-$DEFAULT_BACKUP_DIR}"
    local manifest_path="$backup_dir/$MANIFEST_FILENAME"

    if [[ ! -f "$manifest_path" ]]; then
        return 1
    fi

    # Check if valid JSON
    if ! jq empty "$manifest_path" 2>/dev/null; then
        return 1
    fi

    return 0
}

# ============================================================================
# INTERNAL FUNCTIONS
# ============================================================================

# Log rotation error to stderr and optionally to audit trail
# Args: $1 = backup_type, $2 = error_message
# Returns: 0 always (logging should not fail operations)
_log_rotation_error() {
    local backup_type="$1"
    local message="$2"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Always log to stderr
    echo "[$timestamp] ROTATION ERROR ($backup_type): $message" >&2

    # Log to audit trail if logging function available
    if declare -f log_operation >/dev/null 2>&1; then
        local details
        details=$(jq -n \
            --arg type "$backup_type" \
            --arg error "$message" \
            '{operation: "backup_rotation", type: $type, error: $error}')
        log_operation "error_occurred" "system" "null" "null" "null" "$details" "null" 2>/dev/null || true
    fi
}

# Log rotation summary to audit trail
# Args: $1 = backup_type, $2 = deleted_count, $3 = retained_count, $4 = error_count
# Returns: 0 always (logging should not fail operations)
_log_rotation_summary() {
    local backup_type="$1"
    local deleted_count="$2"
    local retained_count="$3"
    local error_count="${4:-0}"

    # Only log to audit trail if there were actual deletions or errors
    if [[ "$deleted_count" -eq 0 && "$error_count" -eq 0 ]]; then
        return 0
    fi

    # Log to audit trail if logging function available
    if declare -f log_operation >/dev/null 2>&1; then
        local details
        details=$(jq -n \
            --arg type "$backup_type" \
            --argjson deleted "$deleted_count" \
            --argjson retained "$retained_count" \
            --argjson errors "$error_count" \
            '{operation: "backup_rotation", type: $type, deleted: $deleted, retained: $retained, errors: $errors}')
        # Use config_changed as a general system operation action
        log_operation "config_changed" "system" "null" "null" "null" "$details" "null" 2>/dev/null || true
    fi
}

# Ensure backup type subdirectory exists
# Args: $1 = backup type
# Returns: 0 on success, 1 on error
_ensure_backup_type_dir() {
    local backup_type="$1"
    local backup_dir="${BACKUP_DIR:-$DEFAULT_BACKUP_DIR}"
    local type_dir="$backup_dir/$backup_type"

    if [[ ! -d "$type_dir" ]]; then
        mkdir -p "$type_dir" || {
            echo "ERROR: Failed to create backup type directory: $type_dir" >&2
            return 1
        }
    fi

    return 0
}

# Load backup configuration from config.json or use defaults
# Args: $1 = config file path (optional)
# Returns: 0 on success, 1 on error
_load_backup_config() {
    local config_file="${1:-${CLEO_DIR:-.cleo}/config.json}"

    # Initialize with defaults
    BACKUP_ENABLED="$DEFAULT_BACKUP_ENABLED"
    BACKUP_DIR="$DEFAULT_BACKUP_DIR"
    MAX_SNAPSHOTS="$DEFAULT_MAX_SNAPSHOTS"
    MAX_SAFETY_BACKUPS="$DEFAULT_MAX_SAFETY_BACKUPS"
    MAX_INCREMENTAL="$DEFAULT_MAX_INCREMENTAL"
    MAX_ARCHIVE_BACKUPS="$DEFAULT_MAX_ARCHIVE_BACKUPS"
    SAFETY_RETENTION_DAYS="$DEFAULT_SAFETY_RETENTION_DAYS"
    SCHEDULED_ON_SESSION_START="$DEFAULT_SCHEDULED_ON_SESSION_START"
    SCHEDULED_ON_SESSION_END="$DEFAULT_SCHEDULED_ON_SESSION_END"
    SCHEDULED_ON_ARCHIVE="$DEFAULT_SCHEDULED_ON_ARCHIVE"
    SCHEDULED_INTERVAL_MINUTES="$DEFAULT_SCHEDULED_INTERVAL_MINUTES"

    # Override with config file values if available
    if [[ -f "$config_file" ]]; then
        BACKUP_ENABLED=$(jq -r '.backup.enabled // true' "$config_file" 2>/dev/null || echo "$DEFAULT_BACKUP_ENABLED")
        BACKUP_DIR=$(jq -r '.backup.directory // ".cleo/backups"' "$config_file" 2>/dev/null || echo "$DEFAULT_BACKUP_DIR")
        MAX_SNAPSHOTS=$(jq -r '.backup.maxSnapshots // 10' "$config_file" 2>/dev/null || echo "$DEFAULT_MAX_SNAPSHOTS")
        MAX_SAFETY_BACKUPS=$(jq -r '.backup.maxSafetyBackups // 5' "$config_file" 2>/dev/null || echo "$DEFAULT_MAX_SAFETY_BACKUPS")
        MAX_INCREMENTAL=$(jq -r '.backup.maxIncremental // 10' "$config_file" 2>/dev/null || echo "$DEFAULT_MAX_INCREMENTAL")
        MAX_ARCHIVE_BACKUPS=$(jq -r '.backup.maxArchiveBackups // 3' "$config_file" 2>/dev/null || echo "$DEFAULT_MAX_ARCHIVE_BACKUPS")
        SAFETY_RETENTION_DAYS=$(jq -r '.backup.safetyRetentionDays // 7' "$config_file" 2>/dev/null || echo "$DEFAULT_SAFETY_RETENTION_DAYS")
        SCHEDULED_ON_SESSION_START=$(jq -r '.backup.scheduled.onSessionStart // false' "$config_file" 2>/dev/null || echo "$DEFAULT_SCHEDULED_ON_SESSION_START")
        SCHEDULED_ON_SESSION_END=$(jq -r '.backup.scheduled.onSessionEnd // false' "$config_file" 2>/dev/null || echo "$DEFAULT_SCHEDULED_ON_SESSION_END")
        SCHEDULED_ON_ARCHIVE=$(jq -r 'if .backup.scheduled.onArchive == null then true else .backup.scheduled.onArchive end' "$config_file" 2>/dev/null || echo "$DEFAULT_SCHEDULED_ON_ARCHIVE")
        SCHEDULED_INTERVAL_MINUTES=$(jq -r '.backup.scheduled.intervalMinutes // 0' "$config_file" 2>/dev/null || echo "$DEFAULT_SCHEDULED_INTERVAL_MINUTES")
    fi

    return 0
}

# Create backup metadata JSON
# Args: $1 = backup type, $2 = trigger, $3 = operation, $4 = files array (JSON), $5 = total size
# Output: metadata JSON object
_create_backup_metadata() {
    local backup_type="$1"
    local trigger="$2"
    local operation="$3"
    local files_json="$4"
    local total_size="$5"
    local timestamp
    local version

    timestamp=$(get_iso_timestamp)
    version="${CLEO_VERSION:-0.9.8}"

    jq -n \
        --arg type "$backup_type" \
        --arg ts "$timestamp" \
        --arg ver "$version" \
        --arg trigger "$trigger" \
        --arg op "$operation" \
        --argjson files "$files_json" \
        --argjson size "$total_size" \
        '{
            backupType: $type,
            timestamp: $ts,
            version: $ver,
            trigger: $trigger,
            operation: $op,
            files: $files,
            totalSize: $size
        }'
}

# Validate backup integrity
# Args: $1 = backup directory path
# Returns: 0 if valid, 1 if invalid
_validate_backup() {
    local backup_dir="$1"
    local errors=0

    if [[ ! -d "$backup_dir" ]]; then
        echo "ERROR: Backup directory not found: $backup_dir" >&2
        return 1
    fi

    # Check metadata exists
    if [[ ! -f "$backup_dir/metadata.json" ]]; then
        echo "ERROR: Backup metadata not found: $backup_dir/metadata.json" >&2
        ((errors++))
    fi

    # Validate all backed up files have valid JSON
    local file
    for file in "$backup_dir"/*.json; do
        [[ ! -f "$file" ]] && continue
        [[ "$(basename "$file")" == "metadata.json" ]] && continue

        if ! jq empty "$file" 2>/dev/null; then
            echo "ERROR: Invalid JSON in backup file: $file" >&2
            ((errors++))
        fi
    done

    [[ $errors -eq 0 ]]
}

# Calculate total backup size in bytes
# Args: $1 = backup directory path
# Output: total size in bytes
_calculate_backup_size() {
    local backup_dir="$1"
    local total_size=0
    local file

    if [[ ! -d "$backup_dir" ]]; then
        echo "0"
        return 0
    fi

    for file in "$backup_dir"/*.json; do
        [[ ! -f "$file" ]] && continue
        local file_size
        file_size=$(get_file_size "$file")
        total_size=$((total_size + file_size))
    done

    echo "$total_size"
}

# ============================================================================
# CORE BACKUP FUNCTIONS
# ============================================================================

# Create full system snapshot backup
# Args: $1 = custom name (optional)
# Returns: 0 on success, 1 on error
# Output: backup directory path
create_snapshot_backup() {
    local custom_name="${1:-}"
    local timestamp
    local backup_id
    local backup_path
    local files_backed_up=()
    local total_size=0

    # Load config
    _load_backup_config

    # Check if backups are enabled
    if [[ "$BACKUP_ENABLED" != "true" ]]; then
        echo "WARNING: Backups are disabled in configuration" >&2
        return 1
    fi

    # Generate backup ID
    timestamp=$(date +"%Y%m%d_%H%M%S")
    backup_id="snapshot_${timestamp}"
    if [[ -n "$custom_name" ]]; then
        backup_id="${backup_id}_${custom_name}"
    fi

    # Ensure backup type directory exists
    _ensure_backup_type_dir "$BACKUP_TYPE_SNAPSHOT" || return 1

    # Create backup directory structure
    backup_path="$BACKUP_DIR/$BACKUP_TYPE_SNAPSHOT/$backup_id"
    ensure_directory "$backup_path" || return 1

    # Backup all system files (including sessions.json for multi-session support)
    local source_dir="${CLEO_DIR:-.cleo}"
    local files=("todo.json" "todo-archive.json" "config.json" "todo-log.json" "sessions.json")
    local file

    for file in "${files[@]}"; do
        local source_file="$source_dir/$file"
        local dest_file="$backup_path/$file"

        if [[ -f "$source_file" ]]; then
            # Validate source file
            if jq empty "$source_file" 2>/dev/null; then
                cp "$source_file" "$dest_file" || {
                    echo "ERROR: Failed to backup $file" >&2
                    return 1
                }

                local file_size
                file_size=$(get_file_size "$dest_file")
                local checksum
                checksum=$(safe_checksum "$dest_file")

                files_backed_up+=("$(jq -n \
                    --arg src "$file" \
                    --arg backup "$file" \
                    --argjson size "$file_size" \
                    --arg checksum "$checksum" \
                    '{source: $src, backup: $backup, size: $size, checksum: $checksum}')")

                total_size=$((total_size + file_size))
            else
                echo "WARNING: Skipping invalid JSON file: $file" >&2
            fi
        fi
    done

    # Create files array JSON
    local files_json
    files_json=$(printf '%s\n' "${files_backed_up[@]}" | jq -s '.')

    # Create metadata
    local metadata
    metadata=$(_create_backup_metadata \
        "$BACKUP_TYPE_SNAPSHOT" \
        "manual" \
        "backup" \
        "$files_json" \
        "$total_size")

    echo "$metadata" > "$backup_path/metadata.json"

    # Validate backup
    if ! _validate_backup "$backup_path"; then
        echo "ERROR: Backup validation failed" >&2
        return 1
    fi

    # Log backup creation
    log_operation "backup_created" "system" "null" "null" "null" \
        "$(jq -n --arg type "$BACKUP_TYPE_SNAPSHOT" --arg path "$backup_path" '{type: $type, path: $path}')" \
        "null" 2>/dev/null || true

    # Add to manifest for O(1) lookups
    _add_to_manifest "$backup_id" "$BACKUP_TYPE_SNAPSHOT" "$backup_path" "$files_json" "$total_size" "$custom_name" || true

    # Rotate old backups
    rotate_backups "$BACKUP_TYPE_SNAPSHOT"

    echo "$backup_path"
    return 0
}

# Create safety backup before operation
# Args: $1 = file path, $2 = operation name
# Returns: 0 on success, 1 on error
# Output: backup directory path
create_safety_backup() {
    local file="$1"
    local operation="${2:-unknown}"
    local timestamp
    local backup_id
    local backup_path

    if [[ -z "$file" ]]; then
        echo "ERROR: File path required for safety backup" >&2
        return 1
    fi

    if [[ ! -f "$file" ]]; then
        echo "ERROR: File not found: $file" >&2
        return 1
    fi

    # Load config
    _load_backup_config

    # Check if backups are enabled
    if [[ "$BACKUP_ENABLED" != "true" ]]; then
        return 0  # Silently skip if disabled
    fi

    # Generate backup ID
    timestamp=$(date +"%Y%m%d_%H%M%S")
    local filename
    filename=$(basename "$file")
    backup_id="safety_${timestamp}_${operation}_${filename}"

    # Ensure backup type directory exists
    _ensure_backup_type_dir "$BACKUP_TYPE_SAFETY" || return 1

    # Create backup directory
    backup_path="$BACKUP_DIR/$BACKUP_TYPE_SAFETY/$backup_id"
    ensure_directory "$backup_path" || return 1

    # Backup file
    local dest_file="$backup_path/$filename"
    cp "$file" "$dest_file" || {
        echo "ERROR: Failed to create safety backup" >&2
        return 1
    }

    # Calculate metadata
    local file_size
    file_size=$(get_file_size "$dest_file")
    local checksum
    checksum=$(safe_checksum "$dest_file")

    local files_json
    files_json=$(jq -n \
        --arg src "$filename" \
        --arg backup "$filename" \
        --argjson size "$file_size" \
        --arg checksum "$checksum" \
        '[{source: $src, backup: $backup, size: $size, checksum: $checksum}]')

    # Create metadata
    local metadata
    metadata=$(_create_backup_metadata \
        "$BACKUP_TYPE_SAFETY" \
        "auto" \
        "$operation" \
        "$files_json" \
        "$file_size")

    echo "$metadata" > "$backup_path/metadata.json"

    # Add to manifest for O(1) lookups
    _add_to_manifest "$backup_id" "$BACKUP_TYPE_SAFETY" "$backup_path" "$files_json" "$file_size" "" || true

    echo "$backup_path"
    return 0
}

# Create incremental backup for file versioning
# Args: $1 = file path
# Returns: 0 on success, 1 on error
# Output: backup directory path
create_incremental_backup() {
    local file="$1"
    local timestamp
    local backup_id
    local backup_path

    if [[ -z "$file" ]]; then
        echo "ERROR: File path required for incremental backup" >&2
        return 1
    fi

    if [[ ! -f "$file" ]]; then
        echo "ERROR: File not found: $file" >&2
        return 1
    fi

    # Load config
    _load_backup_config

    # Check if backups are enabled
    if [[ "$BACKUP_ENABLED" != "true" ]]; then
        return 0  # Silently skip if disabled
    fi

    # Generate backup ID
    timestamp=$(date +"%Y%m%d_%H%M%S")
    local filename
    filename=$(basename "$file")
    backup_id="incremental_${timestamp}_${filename}"

    # Ensure backup type directory exists
    _ensure_backup_type_dir "$BACKUP_TYPE_INCREMENTAL" || return 1

    # Create backup directory
    backup_path="$BACKUP_DIR/$BACKUP_TYPE_INCREMENTAL/$backup_id"
    ensure_directory "$backup_path" || return 1

    # Backup file
    local dest_file="$backup_path/$filename"
    cp "$file" "$dest_file" || {
        echo "ERROR: Failed to create incremental backup" >&2
        return 1
    }

    # Calculate metadata
    local file_size
    file_size=$(get_file_size "$dest_file")
    local checksum
    checksum=$(safe_checksum "$dest_file")

    local files_json
    files_json=$(jq -n \
        --arg src "$filename" \
        --arg backup "$filename" \
        --argjson size "$file_size" \
        --arg checksum "$checksum" \
        '[{source: $src, backup: $backup, size: $size, checksum: $checksum}]')

    # Create metadata
    local metadata
    metadata=$(_create_backup_metadata \
        "$BACKUP_TYPE_INCREMENTAL" \
        "auto" \
        "version" \
        "$files_json" \
        "$file_size")

    echo "$metadata" > "$backup_path/metadata.json"

    # Add to manifest for O(1) lookups
    _add_to_manifest "$backup_id" "$BACKUP_TYPE_INCREMENTAL" "$backup_path" "$files_json" "$file_size" "" || true

    # Rotate old incremental backups
    rotate_backups "$BACKUP_TYPE_INCREMENTAL"

    echo "$backup_path"
    return 0
}

# Create archive backup before archiving tasks
# Args: none
# Returns: 0 on success, 1 on error
# Output: backup directory path
create_archive_backup() {
    local timestamp
    local backup_id
    local backup_path
    local files_backed_up=()
    local total_size=0

    # Load config
    _load_backup_config

    # Check if backups are enabled
    if [[ "$BACKUP_ENABLED" != "true" ]]; then
        return 0  # Silently skip if disabled
    fi

    # Generate backup ID
    timestamp=$(date +"%Y%m%d_%H%M%S")
    backup_id="archive_${timestamp}"

    # Ensure backup type directory exists
    _ensure_backup_type_dir "$BACKUP_TYPE_ARCHIVE" || return 1

    # Create backup directory
    backup_path="$BACKUP_DIR/$BACKUP_TYPE_ARCHIVE/$backup_id"
    ensure_directory "$backup_path" || return 1

    # Backup relevant files
    local source_dir="${CLEO_DIR:-.cleo}"
    local files=("todo.json" "todo-archive.json")
    local file

    for file in "${files[@]}"; do
        local source_file="$source_dir/$file"
        local dest_file="$backup_path/$file"

        if [[ -f "$source_file" ]]; then
            cp "$source_file" "$dest_file" || {
                echo "ERROR: Failed to backup $file" >&2
                return 1
            }

            local file_size
            file_size=$(get_file_size "$dest_file")
            local checksum
            checksum=$(safe_checksum "$dest_file")

            files_backed_up+=("$(jq -n \
                --arg src "$file" \
                --arg backup "$file" \
                --argjson size "$file_size" \
                --arg checksum "$checksum" \
                '{source: $src, backup: $backup, size: $size, checksum: $checksum}')")

            total_size=$((total_size + file_size))
        fi
    done

    # Create files array JSON
    local files_json
    files_json=$(printf '%s\n' "${files_backed_up[@]}" | jq -s '.')

    # Create metadata
    local metadata
    metadata=$(_create_backup_metadata \
        "$BACKUP_TYPE_ARCHIVE" \
        "auto" \
        "archive" \
        "$files_json" \
        "$total_size")

    echo "$metadata" > "$backup_path/metadata.json"

    # Add to manifest for O(1) lookups
    _add_to_manifest "$backup_id" "$BACKUP_TYPE_ARCHIVE" "$backup_path" "$files_json" "$total_size" "" || true

    # Rotate old archive backups
    rotate_backups "$BACKUP_TYPE_ARCHIVE"

    echo "$backup_path"
    return 0
}

# Create migration backup before schema migration
# Args: $1 = version string
# Returns: 0 on success, 1 on error
# Output: backup directory path
create_migration_backup() {
    local version="${1:-unknown}"
    local timestamp
    local backup_id
    local backup_path
    local files_backed_up=()
    local total_size=0

    # Load config
    _load_backup_config

    # Migration backups are ALWAYS created (ignore BACKUP_ENABLED)

    # Generate backup ID
    timestamp=$(date +"%Y%m%d_%H%M%S")
    backup_id="migration_v${version}_${timestamp}"

    # Ensure backup type directory exists
    _ensure_backup_type_dir "$BACKUP_TYPE_MIGRATION" || return 1

    # Create backup directory
    backup_path="$BACKUP_DIR/$BACKUP_TYPE_MIGRATION/$backup_id"
    ensure_directory "$backup_path" || return 1

    # Backup all system files (including sessions.json for multi-session support)
    local source_dir="${CLEO_DIR:-.cleo}"
    local files=("todo.json" "todo-archive.json" "config.json" "todo-log.json" "sessions.json")
    local file

    for file in "${files[@]}"; do
        local source_file="$source_dir/$file"
        local dest_file="$backup_path/$file"

        if [[ -f "$source_file" ]]; then
            cp "$source_file" "$dest_file" || {
                echo "ERROR: Failed to backup $file" >&2
                return 1
            }

            local file_size
            file_size=$(get_file_size "$dest_file")
            local checksum
            checksum=$(safe_checksum "$dest_file")

            files_backed_up+=("$(jq -n \
                --arg src "$file" \
                --arg backup "$file" \
                --argjson size "$file_size" \
                --arg checksum "$checksum" \
                '{source: $src, backup: $backup, size: $size, checksum: $checksum}')")

            total_size=$((total_size + file_size))
        fi
    done

    # Create files array JSON
    local files_json
    files_json=$(printf '%s\n' "${files_backed_up[@]}" | jq -s '.')

    # Create metadata with neverDelete flag
    local metadata
    metadata=$(_create_backup_metadata \
        "$BACKUP_TYPE_MIGRATION" \
        "auto" \
        "migrate" \
        "$files_json" \
        "$total_size")

    # Add neverDelete flag
    metadata=$(echo "$metadata" | jq '. + {neverDelete: true}')

    echo "$metadata" > "$backup_path/metadata.json"

    # Add to manifest for O(1) lookups (migration backups have neverDelete=true)
    _add_to_manifest "$backup_id" "$BACKUP_TYPE_MIGRATION" "$backup_path" "$files_json" "$total_size" "" || true

    # Migration backups are NEVER rotated

    echo "$backup_path"
    return 0
}

# ============================================================================
# BACKUP MANAGEMENT FUNCTIONS
# ============================================================================

# Rotate backups by type
# Args: $1 = backup type
# Returns: 0 on success, 1 if any deletion failed
rotate_backups() {
    local backup_type="$1"
    local max_backups
    local deleted_count=0
    local error_count=0

    # Load config
    _load_backup_config

    # Determine max backups for this type
    case "$backup_type" in
        "$BACKUP_TYPE_SNAPSHOT")
            max_backups="$MAX_SNAPSHOTS"
            ;;
        "$BACKUP_TYPE_SAFETY")
            max_backups="$MAX_SAFETY_BACKUPS"
            ;;
        "$BACKUP_TYPE_INCREMENTAL")
            max_backups="$MAX_INCREMENTAL"
            ;;
        "$BACKUP_TYPE_ARCHIVE")
            max_backups="$MAX_ARCHIVE_BACKUPS"
            ;;
        "$BACKUP_TYPE_MIGRATION")
            # Migration backups are never deleted
            return 0
            ;;
        *)
            _log_rotation_error "$backup_type" "Unknown backup type: $backup_type"
            return 1
            ;;
    esac

    # Skip rotation if max_backups is 0 (unlimited)
    if [[ "$max_backups" -eq 0 ]]; then
        return 0
    fi

    local backup_dir="$BACKUP_DIR/$backup_type"

    if [[ ! -d "$backup_dir" ]]; then
        return 0
    fi

    # Count existing backups
    local backup_count
    backup_count=$(find "$backup_dir" -maxdepth 1 -type d -name "${backup_type}_*" 2>/dev/null | wc -l)

    if [[ $backup_count -le $max_backups ]]; then
        return 0
    fi

    # Calculate how many to delete
    local delete_target=$((backup_count - max_backups))

    # Uses temp files to communicate state out of the pipeline subshell
    local deleted_marker error_marker
    deleted_marker=$(mktemp)
    error_marker=$(mktemp)
    echo "0" > "$deleted_marker"
    echo "0" > "$error_marker"

    _delete_old_backup() {
        local old_backup="$1"
        local error_output
        local current_deleted current_errors
        local backup_id
        backup_id=$(basename "$old_backup")
        if error_output=$(rm -rf "$old_backup" 2>&1); then
            # Successfully deleted - also remove from manifest
            _remove_from_manifest "$backup_id" 2>/dev/null || true
            current_deleted=$(cat "$deleted_marker")
            echo "$((current_deleted + 1))" > "$deleted_marker"
        else
            # Failed to delete - log the error
            current_errors=$(cat "$error_marker")
            echo "$((current_errors + 1))" > "$error_marker"
            _log_rotation_error "$backup_type" "Failed to delete backup: $old_backup${error_output:+ - $error_output}"
        fi
    }

    # Delete oldest backups using mtime-based sorting (directories)
    # Use find directly since safe_find_sorted_by_mtime is for files
    find "$backup_dir" -maxdepth 1 -name "${backup_type}_*" -type d -printf '%T@ %p\n' 2>/dev/null | sort -n | cut -d' ' -f2- | head -n "$delete_target" | while read -r old_backup; do
        _delete_old_backup "$old_backup"
    done || {
        # Fallback for BSD find (macOS)
        find "$backup_dir" -maxdepth 1 -name "${backup_type}_*" -type d 2>/dev/null | while read -r backup; do
            local mtime
            mtime=$(get_file_mtime "$backup")
            echo "$mtime $backup"
        done | sort -n | cut -d' ' -f2- | head -n "$delete_target" | while read -r old_backup; do
            _delete_old_backup "$old_backup"
        done
    }

    # Read final counts from temp files
    deleted_count=$(cat "$deleted_marker" 2>/dev/null || echo "0")
    error_count=$(cat "$error_marker" 2>/dev/null || echo "0")
    rm -f "$deleted_marker" "$error_marker"

    # Calculate retained count (original count minus successfully deleted)
    local retained_count=$((backup_count - deleted_count))

    # Log rotation summary
    _log_rotation_summary "$backup_type" "$deleted_count" "$retained_count" "$error_count"

    # Return failure if any deletions failed
    if [[ "$error_count" -gt 0 ]]; then
        return 1
    fi

    return 0
}

# List typed backups with optional type filter
# This is the Tier 2 backup system - lists typed backup directories
# For Tier 1 numbered backups, use list_backups() from file-ops.sh
# Args: $1 = backup type (optional, defaults to all)
# Output: backup directory paths, one per line
list_typed_backups() {
    local filter_type="${1:-all}"

    # Load config
    _load_backup_config

    if [[ ! -d "$BACKUP_DIR" ]]; then
        return 0
    fi

    if [[ "$filter_type" == "all" ]]; then
        # List all backup types
        local type
        for type in "$BACKUP_TYPE_SNAPSHOT" "$BACKUP_TYPE_SAFETY" "$BACKUP_TYPE_INCREMENTAL" "$BACKUP_TYPE_ARCHIVE" "$BACKUP_TYPE_MIGRATION"; do
            local type_dir="$BACKUP_DIR/$type"
            if [[ -d "$type_dir" ]]; then
                # List directories sorted by mtime
                find "$type_dir" -maxdepth 1 -name "${type}_*" -type d -printf '%T@ %p\n' 2>/dev/null | sort -n | cut -d' ' -f2- || \
                find "$type_dir" -maxdepth 1 -name "${type}_*" -type d 2>/dev/null | while read -r backup; do
                    local mtime
                    mtime=$(get_file_mtime "$backup")
                    echo "$mtime $backup"
                done | sort -n | cut -d' ' -f2-
            fi
        done
    else
        # List specific type
        local type_dir="$BACKUP_DIR/$filter_type"
        if [[ -d "$type_dir" ]]; then
            # List directories sorted by mtime
            find "$type_dir" -maxdepth 1 -name "${filter_type}_*" -type d -printf '%T@ %p\n' 2>/dev/null | sort -n | cut -d' ' -f2- || \
            find "$type_dir" -maxdepth 1 -name "${filter_type}_*" -type d 2>/dev/null | while read -r backup; do
                local mtime
                mtime=$(get_file_mtime "$backup")
                echo "$mtime $backup"
            done | sort -n | cut -d' ' -f2-
        fi
    fi
}

# Restore from typed backup (Tier 2)
# Restores files from a typed backup directory created by create_*_backup functions.
# For numbered backups (Tier 1), use restore_backup() from lib/file-ops.sh instead.
# Args: $1 = backup directory path or ID (e.g., "snapshot_20251215_120000")
# Returns: 0 on success, 1 on error
restore_typed_backup() {
    local backup_id="$1"
    local skip_verify="${2:-false}"  # Optional: skip checksum verification
    local backup_path

    if [[ -z "$backup_id" ]]; then
        echo "ERROR: Backup ID or path required" >&2
        return 1
    fi

    # Load config
    _load_backup_config

    # Resolve backup path
    if [[ -d "$backup_id" ]]; then
        backup_path="$backup_id"
    else
        # Search for backup ID in all types
        backup_path=$(list_typed_backups | grep -F "$backup_id" | head -1)

        if [[ -z "$backup_path" ]]; then
            echo "ERROR: Backup not found: $backup_id" >&2
            return 1
        fi
    fi

    # Validate backup
    if ! _validate_backup "$backup_path"; then
        echo "ERROR: Backup validation failed: $backup_path" >&2
        return 1
    fi

    # Read metadata
    local metadata_file="$backup_path/metadata.json"
    local files_json
    files_json=$(jq -r '.files' "$metadata_file")

    # Verify checksums before restoring (unless skip_verify=true)
    if [[ "$skip_verify" != "true" ]]; then
        local verify_errors=0
        local file_count
        file_count=$(echo "$files_json" | jq -r 'length')

        echo "Verifying checksums for $file_count files..." >&2

        local i
        for ((i=0; i<file_count; i++)); do
            local backup_file stored_checksum actual_checksum
            backup_file=$(echo "$files_json" | jq -r ".[$i].backup")
            stored_checksum=$(echo "$files_json" | jq -r ".[$i].checksum")
            
            local source_file="$backup_path/$backup_file"

            if [[ ! -f "$source_file" ]]; then
                echo "ERROR: Backup file missing: $backup_file" >&2
                ((verify_errors++))
                continue
            fi

            # Calculate actual checksum
            actual_checksum=$(safe_checksum "$source_file")

            if [[ "$stored_checksum" != "$actual_checksum" ]]; then
                echo "ERROR: Checksum mismatch for $backup_file" >&2
                echo "  Expected: $stored_checksum" >&2
                echo "  Got:      $actual_checksum" >&2
                ((verify_errors++))
            fi
        done

        if [[ $verify_errors -gt 0 ]]; then
            echo "ERROR: Checksum verification failed ($verify_errors errors)" >&2
            # Log verification failure
            log_operation "backup_verify_failed" "system" "null" "null" "null" \
                "$(jq -n --arg path "$backup_path" --argjson errors "$verify_errors" '{path: $path, verifyErrors: $errors}')" \
                "null" 2>/dev/null || true
            return "${EXIT_CHECKSUM_MISMATCH:-20}"
        fi

        echo "Checksum verification passed" >&2
    else
        echo "Skipping checksum verification (skip_verify=true)" >&2
    fi

    # Restore each file
    local dest_dir="${CLEO_DIR:-.cleo}"
    local file

    # Extract just the backup filenames
    local files
    files=$(echo "$files_json" | jq -r '.[].backup')

    while IFS= read -r file; do
        local source_file="$backup_path/$file"
        local dest_file="$dest_dir/$file"

        if [[ -f "$source_file" ]]; then
            # Create safety backup of current file before restoring
            if [[ -f "$dest_file" ]]; then
                create_safety_backup "$dest_file" "restore" >/dev/null 2>&1 || true
            fi

            # Restore file
            cp "$source_file" "$dest_file" || {
                echo "ERROR: Failed to restore $file" >&2
                return 1
            }

            echo "Restored: $file" >&2
        fi
    done <<< "$files"

    # Log restore operation (include verification status)
    log_operation "backup_restored" "system" "null" "null" "null" \
        "$(jq -n --arg path "$backup_path" --argjson verified "$([[ "$skip_verify" != "true" ]] && echo true || echo false)" '{path: $path, checksumVerified: $verified}')" \
        "null" 2>/dev/null || true

    return 0
}

# Get backup metadata
# Args: $1 = backup directory path
# Output: metadata JSON
get_backup_metadata() {
    local backup_path="$1"

    if [[ -z "$backup_path" ]]; then
        echo "ERROR: Backup path required" >&2
        return 1
    fi

    local metadata_file="$backup_path/metadata.json"

    if [[ ! -f "$metadata_file" ]]; then
        echo "ERROR: Metadata not found: $metadata_file" >&2
        return 1
    fi

    cat "$metadata_file"
}

# Prune old backups based on retention policies
# Args: none
# Returns: 0 on success
prune_backups() {
    # Load config
    _load_backup_config

    # Rotate each backup type
    rotate_backups "$BACKUP_TYPE_SNAPSHOT"
    rotate_backups "$BACKUP_TYPE_SAFETY"
    rotate_backups "$BACKUP_TYPE_INCREMENTAL"
    rotate_backups "$BACKUP_TYPE_ARCHIVE"

    # Prune safety backups by retention days
    if [[ "$SAFETY_RETENTION_DAYS" -gt 0 ]]; then
        local safety_dir="$BACKUP_DIR/$BACKUP_TYPE_SAFETY"

        if [[ -d "$safety_dir" ]]; then
            local cutoff_timestamp
            cutoff_timestamp=$(date_days_ago "$SAFETY_RETENTION_DAYS")
            local cutoff_epoch
            cutoff_epoch=$(iso_to_epoch "$cutoff_timestamp")

            safe_find_sorted_by_mtime "$safety_dir" "${BACKUP_TYPE_SAFETY}_*" \
                | while read -r backup; do
                    local backup_mtime
                    backup_mtime=$(get_file_mtime "$backup")

                    if [[ "$backup_mtime" -lt "$cutoff_epoch" ]]; then
                        local backup_id
                        backup_id=$(basename "$backup")
                        if rm -rf "$backup" 2>/dev/null; then
                            # Successfully deleted - also remove from manifest
                            _remove_from_manifest "$backup_id" 2>/dev/null || true
                        fi
                    fi
                done
        fi
    fi

    return 0
}

# ============================================================================
# SEARCH/FIND FUNCTIONS
# ============================================================================

# Parse relative date string to ISO timestamp
# Args: $1 = relative date string (e.g., "7d", "2w", "1m", or ISO date)
# Output: ISO timestamp string
# Returns: 0 on success, 1 on parse error
parse_relative_date() {
    local date_str="$1"
    local timestamp=""

    # Empty string means no filter
    if [[ -z "$date_str" ]]; then
        echo ""
        return 0
    fi

    # Already ISO format (YYYY-MM-DD or full ISO)
    if [[ "$date_str" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2} ]]; then
        # Validate and normalize
        if [[ "$date_str" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
            # Just date, add time
            echo "${date_str}T00:00:00Z"
        else
            echo "$date_str"
        fi
        return 0
    fi

    # Relative format: Nd (days), Nw (weeks), Nm (months)
    if [[ "$date_str" =~ ^([0-9]+)([dwm])$ ]]; then
        local count="${BASH_REMATCH[1]}"
        local unit="${BASH_REMATCH[2]}"
        local days=0

        case "$unit" in
            d) days="$count" ;;
            w) days=$((count * 7)) ;;
            m) days=$((count * 30)) ;;  # Approximate
        esac

        # Use platform-compat function
        timestamp=$(date_days_ago "$days")
        echo "$timestamp"
        return 0
    fi

    # Try parsing as natural date via GNU date
    if timestamp=$(date -u -d "$date_str" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
        echo "$timestamp"
        return 0
    fi

    # Failed to parse
    echo "ERROR: Cannot parse date: $date_str" >&2
    return 1
}

# Find backups matching search criteria
# Args (via options):
#   $1 = since (date/relative)
#   $2 = until (date/relative)
#   $3 = type filter (snapshot|safety|archive|migration|incremental|all)
#   $4 = name pattern (glob)
#   $5 = grep pattern (content search)
#   $6 = limit (number)
#   $7 = on date (exact date match, YYYY-MM-DD)
#   $8 = task ID pattern (search for specific task IDs)
#   $9 = verbose mode (include matched content snippets)
# Output: JSON array of matching backups or text list
# Returns: 0 on success
find_backups() {
    local since="${1:-}"
    local until="${2:-}"
    local type_filter="${3:-all}"
    local name_pattern="${4:-}"
    local grep_pattern="${5:-}"
    local limit="${6:-20}"
    local on_date="${7:-}"
    local task_id_pattern="${8:-}"
    local verbose_mode="${9:-false}"

    # Load config
    _load_backup_config

    local results=()
    local count=0

    # Parse date filters
    local since_epoch=0
    local until_epoch=0

    if [[ -n "$since" ]]; then
        local since_iso
        since_iso=$(parse_relative_date "$since") || return 1
        if [[ -n "$since_iso" ]]; then
            since_epoch=$(iso_to_epoch "$since_iso") || since_epoch=0
        fi
    fi

    if [[ -n "$until" ]]; then
        local until_iso
        until_iso=$(parse_relative_date "$until") || return 1
        if [[ -n "$until_iso" ]]; then
            until_epoch=$(iso_to_epoch "$until_iso") || until_epoch=0
        fi
    fi

    # Handle --on date filter (exact date match)
    # Converts to since/until range for the entire day
    local on_date_start_epoch=0
    local on_date_end_epoch=0
    if [[ -n "$on_date" ]]; then
        # Parse the on_date (expect YYYY-MM-DD or relative like "today", "yesterday")
        local on_date_iso
        on_date_iso=$(parse_relative_date "$on_date") || return 1
        if [[ -n "$on_date_iso" ]]; then
            # Extract just the date part (YYYY-MM-DD)
            local date_only="${on_date_iso:0:10}"
            # Set start to beginning of day
            local day_start="${date_only}T00:00:00Z"
            # Set end to end of day
            local day_end="${date_only}T23:59:59Z"
            on_date_start_epoch=$(iso_to_epoch "$day_start") || on_date_start_epoch=0
            on_date_end_epoch=$(iso_to_epoch "$day_end") || on_date_end_epoch=0
        fi
    fi

    # Determine which types to search
    local types_to_search=()
    if [[ "$type_filter" == "all" ]]; then
        types_to_search=("$BACKUP_TYPE_SNAPSHOT" "$BACKUP_TYPE_SAFETY" "$BACKUP_TYPE_INCREMENTAL" "$BACKUP_TYPE_ARCHIVE" "$BACKUP_TYPE_MIGRATION")
    else
        types_to_search=("$type_filter")
    fi

    # Search each backup type
    for backup_type in "${types_to_search[@]}"; do
        local type_dir="$BACKUP_DIR/$backup_type"

        [[ ! -d "$type_dir" ]] && continue

        # Find backup directories
        while IFS= read -r backup_path; do
            [[ -z "$backup_path" ]] && continue
            [[ ! -d "$backup_path" ]] && continue

            # Check limit
            if [[ $count -ge $limit ]]; then
                break 2
            fi

            local backup_name
            backup_name=$(basename "$backup_path")

            # Apply name pattern filter (glob matching)
            if [[ -n "$name_pattern" ]]; then
                # shellcheck disable=SC2053
                if [[ ! "$backup_name" == $name_pattern ]]; then
                    continue
                fi
            fi

            # Get backup metadata
            local metadata_file=""
            if [[ -f "$backup_path/metadata.json" ]]; then
                metadata_file="$backup_path/metadata.json"
            elif [[ -f "$backup_path/backup-metadata.json" ]]; then
                metadata_file="$backup_path/backup-metadata.json"
            fi

            # Extract timestamp from metadata or directory name
            local backup_timestamp=""
            local backup_epoch=0

            if [[ -n "$metadata_file" && -f "$metadata_file" ]]; then
                backup_timestamp=$(jq -r '.timestamp // empty' "$metadata_file" 2>/dev/null)
            fi

            # Fallback: extract from directory name
            if [[ -z "$backup_timestamp" && "$backup_name" =~ ([0-9]{8})_([0-9]{6}) ]]; then
                local date_part="${BASH_REMATCH[1]}"
                local time_part="${BASH_REMATCH[2]}"
                backup_timestamp="${date_part:0:4}-${date_part:4:2}-${date_part:6:2}T${time_part:0:2}:${time_part:2:2}:${time_part:4:2}Z"
            fi

            # Convert to epoch for comparison
            if [[ -n "$backup_timestamp" ]]; then
                backup_epoch=$(iso_to_epoch "$backup_timestamp") || backup_epoch=0
            else
                # Use file mtime as fallback
                backup_epoch=$(get_file_mtime "$backup_path")
            fi

            # Apply date filters
            if [[ $since_epoch -gt 0 && $backup_epoch -lt $since_epoch ]]; then
                continue
            fi
            if [[ $until_epoch -gt 0 && $backup_epoch -gt $until_epoch ]]; then
                continue
            fi

            # Apply --on date filter (exact day match)
            if [[ $on_date_start_epoch -gt 0 ]]; then
                if [[ $backup_epoch -lt $on_date_start_epoch || $backup_epoch -gt $on_date_end_epoch ]]; then
                    continue
                fi
            fi

            # Apply content grep filter
            if [[ -n "$grep_pattern" ]]; then
                local found_match=false

                # Search metadata for pattern
                if [[ -n "$metadata_file" && -f "$metadata_file" ]]; then
                    if grep -q "$grep_pattern" "$metadata_file" 2>/dev/null; then
                        found_match=true
                    fi
                fi

                # Search backup files for pattern
                if [[ "$found_match" == false ]]; then
                    for json_file in "$backup_path"/*.json; do
                        [[ ! -f "$json_file" ]] && continue
                        [[ "$(basename "$json_file")" == "metadata.json" ]] && continue
                        [[ "$(basename "$json_file")" == "backup-metadata.json" ]] && continue

                        if grep -q "$grep_pattern" "$json_file" 2>/dev/null; then
                            found_match=true
                            break
                        fi
                    done
                fi

                if [[ "$found_match" == false ]]; then
                    continue
                fi
            fi

            # Apply task ID filter (search for specific task ID in backup files)
            local matched_snippets=()
            if [[ -n "$task_id_pattern" ]]; then
                local found_task=false

                # Search todo.json for the task ID
                for json_file in "$backup_path"/*.json; do
                    [[ ! -f "$json_file" ]] && continue
                    local filename
                    filename=$(basename "$json_file")
                    # Only search in todo files, not metadata
                    [[ "$filename" == "metadata.json" ]] && continue
                    [[ "$filename" == "backup-metadata.json" ]] && continue

                    # Use jq to find task by ID (more accurate than grep)
                    if [[ "$filename" == "todo.json" ]]; then
                        if jq -e --arg id "$task_id_pattern" '.tasks[]? | select(.id == $id)' "$json_file" >/dev/null 2>&1; then
                            found_task=true
                            # Capture snippet if verbose
                            if [[ "$verbose_mode" == "true" ]]; then
                                local snippet
                                snippet=$(jq -c --arg id "$task_id_pattern" '.tasks[]? | select(.id == $id) | {id, title, status}' "$json_file" 2>/dev/null)
                                [[ -n "$snippet" ]] && matched_snippets+=("$filename:$snippet")
                            fi
                            break
                        fi
                    elif [[ "$filename" == "todo-archive.json" ]]; then
                        if jq -e --arg id "$task_id_pattern" '.archivedTasks[]? | select(.id == $id)' "$json_file" >/dev/null 2>&1; then
                            found_task=true
                            if [[ "$verbose_mode" == "true" ]]; then
                                local snippet
                                snippet=$(jq -c --arg id "$task_id_pattern" '.archivedTasks[]? | select(.id == $id) | {id, title, status}' "$json_file" 2>/dev/null)
                                [[ -n "$snippet" ]] && matched_snippets+=("$filename:$snippet")
                            fi
                            break
                        fi
                    fi
                done

                if [[ "$found_task" == false ]]; then
                    continue
                fi
            fi

            # Build result entry
            local total_size=0
            local file_count=0

            if [[ -n "$metadata_file" && -f "$metadata_file" ]]; then
                total_size=$(jq -r '.totalSize // 0' "$metadata_file" 2>/dev/null || echo 0)
                file_count=$(jq -r '.files | length // 0' "$metadata_file" 2>/dev/null || echo 0)
            else
                # Calculate from directory
                total_size=$(_calculate_backup_size "$backup_path")
                file_count=$(find "$backup_path" -maxdepth 1 -type f -name "*.json" 2>/dev/null | wc -l)
            fi

            # Convert size to human readable
            local size_human
            if command -v numfmt &>/dev/null; then
                size_human=$(numfmt --to=iec-i --suffix=B "$total_size" 2>/dev/null || echo "${total_size}B")
            else
                size_human="${total_size}B"
            fi

            # Add to results
            local result_entry

            # Build matched snippets JSON array for verbose mode
            local snippets_json="[]"
            if [[ "$verbose_mode" == "true" && ${#matched_snippets[@]} -gt 0 ]]; then
                snippets_json=$(printf '%s\n' "${matched_snippets[@]}" | jq -R -s 'split("\n") | map(select(length > 0))')
            fi

            result_entry=$(jq -n \
                --arg name "$backup_name" \
                --arg path "$backup_path" \
                --arg type "$backup_type" \
                --arg timestamp "$backup_timestamp" \
                --argjson size "$total_size" \
                --arg sizeHuman "$size_human" \
                --argjson fileCount "$file_count" \
                --argjson matchedSnippets "$snippets_json" \
                --argjson verbose "$([[ "$verbose_mode" == "true" ]] && echo true || echo false)" \
                '{
                    name: $name,
                    path: $path,
                    type: $type,
                    timestamp: $timestamp,
                    size: $size,
                    sizeHuman: $sizeHuman,
                    fileCount: $fileCount
                } + (if $verbose then {matchedSnippets: $matchedSnippets} else {} end)')

            results+=("$result_entry")
            ((count++))

        done < <(find "$type_dir" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -r)
    done

    # Output results as JSON array
    if [[ ${#results[@]} -eq 0 ]]; then
        echo "[]"
    else
        printf '%s\n' "${results[@]}" | jq -s '.'
    fi

    return 0
}

# ============================================================================
# SCHEDULED BACKUP FUNCTIONS
# ============================================================================

# Check config and create snapshot backup on session start if enabled
# Args: $1 = config file path (optional)
# Output: Backup path if created, empty if skipped
# Returns: 0 on success, 1 on error
auto_backup_on_session_start() {
    local config_file="${1:-${CLEO_DIR:-.cleo}/config.json}"

    # Load config to check scheduled settings
    _load_backup_config "$config_file"

    # Check if backups are enabled globally
    if [[ "$BACKUP_ENABLED" != "true" ]]; then
        return 0  # Silently skip if disabled
    fi

    # Check if session start backup is enabled
    if [[ "$SCHEDULED_ON_SESSION_START" != "true" ]]; then
        return 0  # Silently skip if not enabled
    fi

    # Create snapshot backup with session_start suffix
    local backup_path
    backup_path=$(create_snapshot_backup "session_start")
    local result=$?

    if [[ $result -eq 0 && -n "$backup_path" ]]; then
        echo "$backup_path"
    fi

    return $result
}

# Check config and create safety backup on session end if enabled
# Args: $1 = config file path (optional)
# Output: Backup path if created, empty if skipped
# Returns: 0 on success, 1 on error
auto_backup_on_session_end() {
    local config_file="${1:-${CLEO_DIR:-.cleo}/config.json}"

    # Load config to check scheduled settings
    _load_backup_config "$config_file"

    # Check if backups are enabled globally
    if [[ "$BACKUP_ENABLED" != "true" ]]; then
        return 0  # Silently skip if disabled
    fi

    # Check if session end backup is enabled
    if [[ "$SCHEDULED_ON_SESSION_END" != "true" ]]; then
        return 0  # Silently skip if not enabled
    fi

    # Create safety backup for the main todo file
    local todo_file="${CLEO_DIR:-.cleo}/todo.json"
    if [[ ! -f "$todo_file" ]]; then
        return 0  # No todo file to backup
    fi

    local backup_path
    backup_path=$(create_safety_backup "$todo_file" "session_end")
    local result=$?

    if [[ $result -eq 0 && -n "$backup_path" ]]; then
        echo "$backup_path"
    fi

    return $result
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f auto_backup_on_session_start
export -f auto_backup_on_session_end
export -f parse_relative_date
export -f find_backups
export -f create_snapshot_backup
export -f create_safety_backup
export -f create_incremental_backup
export -f create_archive_backup
export -f create_migration_backup
export -f rotate_backups
export -f list_typed_backups
export -f restore_typed_backup
export -f get_backup_metadata
export -f prune_backups

# Check config and create archive backup before archive operations if enabled
# Args: $1 = config file path (optional)
# Output: Backup path if created, empty if skipped
# Returns: 0 on success, 1 on error
auto_backup_on_archive() {
    local config_file="${1:-${CLEO_DIR:-.cleo}/config.json}"

    # Load config to check scheduled settings
    _load_backup_config "$config_file"

    # Check if backups are enabled globally
    if [[ "$BACKUP_ENABLED" != "true" ]]; then
        return 0  # Silently skip if disabled
    fi

    # Check if archive backup is enabled
    if [[ "$SCHEDULED_ON_ARCHIVE" != "true" ]]; then
        return 0  # Silently skip if not enabled
    fi

    # Create archive backup (backs up todo.json and todo-archive.json)
    local backup_path
    backup_path=$(create_archive_backup)
    local result=$?

    if [[ $result -eq 0 && -n "$backup_path" ]]; then
        echo "$backup_path"
    fi

    return $result
}

# Get the path to the schedule state file
# Args: none
# Output: Path to schedule state file
_get_schedule_state_path() {
    local backup_dir="${BACKUP_DIR:-$DEFAULT_BACKUP_DIR}"
    echo "$backup_dir/$SCHEDULE_STATE_FILENAME"
}

# Get timestamp of last backup from schedule state
# Args: $1 = config file path (optional)
# Output: ISO timestamp of last backup, or empty if never backed up
# Returns: 0 on success
get_last_backup_time() {
    local config_file="${1:-${CLEO_DIR:-.cleo}/config.json}"

    # Load config to get backup directory
    _load_backup_config "$config_file"

    local state_file
    state_file=$(_get_schedule_state_path)

    if [[ ! -f "$state_file" ]]; then
        echo ""
        return 0
    fi

    # Read last backup timestamp from state file
    local last_backup
    last_backup=$(jq -r '.lastBackupTimestamp // empty' "$state_file" 2>/dev/null)
    echo "$last_backup"
    return 0
}

# Record backup timestamp in schedule state
# Args: $1 = config file path (optional)
# Returns: 0 on success, 1 on error
schedule_backup() {
    local config_file="${1:-${CLEO_DIR:-.cleo}/config.json}"

    # Load config to get backup directory
    _load_backup_config "$config_file"

    local state_file
    state_file=$(_get_schedule_state_path)

    # Ensure backup directory exists
    local backup_dir="${BACKUP_DIR:-$DEFAULT_BACKUP_DIR}"
    if [[ ! -d "$backup_dir" ]]; then
        mkdir -p "$backup_dir" || return 1
    fi

    local timestamp
    timestamp=$(get_iso_timestamp)

    # Calculate next scheduled time if interval is set
    local next_scheduled=""
    if [[ "$SCHEDULED_INTERVAL_MINUTES" -gt 0 ]]; then
        local current_epoch
        current_epoch=$(date +%s)
        local next_epoch=$((current_epoch + SCHEDULED_INTERVAL_MINUTES * 60))
        # Convert to ISO format (platform-compatible)
        if date --version >/dev/null 2>&1; then
            # GNU date
            next_scheduled=$(date -u -d "@$next_epoch" +"%Y-%m-%dT%H:%M:%SZ")
        else
            # BSD date (macOS)
            next_scheduled=$(date -u -r "$next_epoch" +"%Y-%m-%dT%H:%M:%SZ")
        fi
    fi

    # Write schedule state
    jq -n \
        --arg lastBackup "$timestamp" \
        --arg nextScheduled "$next_scheduled" \
        --argjson intervalMinutes "$SCHEDULED_INTERVAL_MINUTES" \
        '{
            lastBackupTimestamp: $lastBackup,
            nextScheduledTimestamp: (if $nextScheduled == "" then null else $nextScheduled end),
            intervalMinutes: $intervalMinutes
        }' > "$state_file" || return 1

    return 0
}

# Check if auto backup is enabled and due based on interval
# Args: $1 = config file path (optional)
# Output: "true" if backup is due, "false" otherwise
# Returns: 0 always
should_auto_backup() {
    local config_file="${1:-${CLEO_DIR:-.cleo}/config.json}"

    # Load config to check scheduled settings
    _load_backup_config "$config_file"

    # Check if backups are enabled globally
    if [[ "$BACKUP_ENABLED" != "true" ]]; then
        echo "false"
        return 0
    fi

    # Check if interval-based backups are configured
    if [[ "$SCHEDULED_INTERVAL_MINUTES" -le 0 ]]; then
        echo "false"
        return 0
    fi

    # Get last backup time
    local last_backup
    last_backup=$(get_last_backup_time "$config_file")

    # If never backed up, backup is due
    if [[ -z "$last_backup" ]]; then
        echo "true"
        return 0
    fi

    # Calculate if interval has elapsed
    local last_epoch current_epoch elapsed_minutes
    last_epoch=$(iso_to_epoch "$last_backup" 2>/dev/null || echo 0)
    current_epoch=$(date +%s)

    if [[ "$last_epoch" -eq 0 ]]; then
        # Failed to parse timestamp, assume backup is due
        echo "true"
        return 0
    fi

    elapsed_minutes=$(( (current_epoch - last_epoch) / 60 ))

    if [[ "$elapsed_minutes" -ge "$SCHEDULED_INTERVAL_MINUTES" ]]; then
        echo "true"
    else
        echo "false"
    fi

    return 0
}

# Perform scheduled backup if due (interval-based)
# Args: $1 = config file path (optional)
# Output: Backup path if created, empty if skipped
# Returns: 0 on success, 1 on error
perform_scheduled_backup() {
    local config_file="${1:-${CLEO_DIR:-.cleo}/config.json}"

    # Check if backup is due
    local is_due
    is_due=$(should_auto_backup "$config_file")

    if [[ "$is_due" != "true" ]]; then
        return 0  # Not due, skip
    fi

    # Create snapshot backup
    local backup_path
    backup_path=$(create_snapshot_backup "scheduled")
    local result=$?

    if [[ $result -eq 0 && -n "$backup_path" ]]; then
        # Record backup time for next interval check
        schedule_backup "$config_file" || true
        echo "$backup_path"
    fi

    return $result
}

export -f auto_backup_on_archive
export -f get_last_backup_time
export -f schedule_backup
export -f should_auto_backup
export -f perform_scheduled_backup
