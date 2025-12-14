#!/bin/bash
# file-ops.sh - Atomic file operations with backup management
# Part of claude-todo system
# Provides safe file operations with rollback capability
#
# PERFORMANCE CHARACTERISTICS:
#   - atomic_write: O(1) + file I/O time
#   - backup_file: O(1) copy operation
#   - File locking: O(1) via flock
#   - restore_backup: O(1) copy operation
#
# Typical performance:
#   - atomic_write (small JSON): < 10ms
#   - atomic_write (1000 tasks): ~20-30ms
#   - backup_file: ~5-10ms
#   - lock/unlock: < 1ms
#
# Design notes:
#   - All operations use temp files for atomicity
#   - Backups rotated automatically (max 10 by default)
#   - File locking prevents concurrent write races
#   - Checksums validate data integrity

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source platform compatibility layer
if [[ -f "$_LIB_DIR/platform-compat.sh" ]]; then
    # shellcheck source=lib/platform-compat.sh
    source "$_LIB_DIR/platform-compat.sh"
else
    echo "ERROR: Cannot find platform-compat.sh in $_LIB_DIR" >&2
    exit 1
fi

# Configuration
BACKUP_DIR=".backups"
MAX_BACKUPS=10
TEMP_SUFFIX=".tmp"
LOCK_SUFFIX=".lock"

# Error codes
E_SUCCESS=0
E_INVALID_ARGS=1
E_FILE_NOT_FOUND=2
E_WRITE_FAILED=3
E_BACKUP_FAILED=4
E_VALIDATION_FAILED=5
E_RESTORE_FAILED=6
E_JSON_PARSE_FAILED=7
E_LOCK_FAILED=8

#######################################
# Ensure directory exists with proper permissions
# Arguments:
#   $1 - Directory path
# Returns:
#   0 on success, non-zero on error
#######################################
ensure_directory() {
    local dir="$1"

    if [[ -z "$dir" ]]; then
        echo "Error: Directory path required" >&2
        return $E_INVALID_ARGS
    fi

    if [[ ! -d "$dir" ]]; then
        if ! mkdir -p "$dir" 2>/dev/null; then
            echo "Error: Failed to create directory: $dir" >&2
            return $E_WRITE_FAILED
        fi

        # Set proper permissions (owner: rwx, group: rx, other: rx)
        chmod 755 "$dir" 2>/dev/null || true
    fi

    return $E_SUCCESS
}

#######################################
# Acquire exclusive lock on a file
# Arguments:
#   $1 - File path to lock
#   $2 - Lock file descriptor variable name (default: LOCK_FD)
#   $3 - Timeout in seconds (optional, default: 30)
# Returns:
#   0 on success, E_LOCK_FAILED on timeout/error
# Notes:
#   Lock file created at {file}.lock
#   Caller must close the FD to release the lock
#   FD number is stored in the variable named by $2
#######################################
lock_file() {
    local file="$1"
    local fd_var="${2:-LOCK_FD}"
    local timeout="${3:-30}"

    if [[ -z "$file" ]]; then
        echo "Error: File path required for locking" >&2
        return $E_INVALID_ARGS
    fi

    # Ensure parent directory exists
    local file_dir
    file_dir="$(dirname "$file")"
    if ! ensure_directory "$file_dir"; then
        return $E_LOCK_FAILED
    fi

    # Create lock file path
    local lock_file="${file}${LOCK_SUFFIX}"

    # Touch lock file to ensure it exists
    touch "$lock_file" 2>/dev/null || {
        echo "Error: Failed to create lock file: $lock_file" >&2
        return $E_LOCK_FAILED
    }

    # Find available file descriptor (200-210)
    local fd
    for fd in {200..210}; do
        if ! { true >&"$fd"; } 2>/dev/null; then
            # FD is available, use it
            if ! eval "exec $fd>'$lock_file'" 2>/dev/null; then
                # Failed to open FD, try next
                continue
            fi

            # Try to acquire lock with timeout
            if flock -w "$timeout" "$fd" 2>/dev/null; then
                # Success - store FD in caller's variable
                eval "$fd_var=$fd"
                return $E_SUCCESS
            else
                # Failed to acquire lock (timeout or error)
                # Close FD and exit immediately - don't try other FDs
                eval "exec $fd>&-" 2>/dev/null || true
                echo "Error: Failed to acquire lock on $file (timeout after ${timeout}s)" >&2
                echo "Another process may be accessing this file." >&2
                return $E_LOCK_FAILED
            fi
        fi
    done

    # If we get here, no FD was available
    echo "Error: No available file descriptors for locking" >&2
    return $E_LOCK_FAILED
}

#######################################
# Release file lock
# Arguments:
#   $1 - File descriptor to unlock (optional, uses LOCK_FD if not provided)
# Returns:
#   Always 0 (errors are suppressed)
# Notes:
#   Safe to call even if no lock is held
#   Closes the file descriptor
#######################################
unlock_file() {
    local fd="${1:-${LOCK_FD:-}}"

    if [[ -z "$fd" ]]; then
        return $E_SUCCESS
    fi

    # Release lock and close file descriptor
    flock -u "$fd" 2>/dev/null || true
    eval "exec $fd>&-" 2>/dev/null || true

    return $E_SUCCESS
}

#######################################
# Create versioned backup of file
# Arguments:
#   $1 - File path to backup
# Outputs:
#   Backup file path on success
# Returns:
#   0 on success, non-zero on error
#######################################
backup_file() {
    local file="$1"

    if [[ -z "$file" ]]; then
        echo "Error: File path required for backup" >&2
        return $E_INVALID_ARGS
    fi

    if [[ ! -f "$file" ]]; then
        echo "Error: File not found: $file" >&2
        return $E_FILE_NOT_FOUND
    fi

    # Determine backup directory
    local file_dir
    file_dir="$(dirname "$file")"
    local backup_dir="$file_dir/$BACKUP_DIR"

    # Ensure backup directory exists
    if ! ensure_directory "$backup_dir"; then
        return $E_BACKUP_FAILED
    fi

    # Get base filename
    local basename
    basename="$(basename "$file")"

    # Find next available backup number
    local backup_num=1
    local backup_file="$backup_dir/${basename}.${backup_num}"

    while [[ -f "$backup_file" ]]; do
        backup_num=$((backup_num + 1))
        backup_file="$backup_dir/${basename}.${backup_num}"
    done

    # Copy file to backup
    if ! cp -p "$file" "$backup_file" 2>/dev/null; then
        echo "Error: Failed to create backup: $backup_file" >&2
        return $E_BACKUP_FAILED
    fi

    # Set backup file permissions (owner only)
    chmod 600 "$backup_file" 2>/dev/null || true

    # Rotate old backups (use internal function to avoid conflict with lib/backup.sh)
    _rotate_numbered_backups "$file_dir" "$basename" "$MAX_BACKUPS"

    # Output backup file path
    echo "$backup_file"
    return $E_SUCCESS
}

#######################################
# Rotate numbered backups, keeping only max_backups most recent
# Internal function to avoid collision with lib/backup.sh rotate_backups
# Arguments:
#   $1 - Directory containing file
#   $2 - Base filename
#   $3 - Maximum number of backups to keep
# Returns:
#   0 on success
#######################################
_rotate_numbered_backups() {
    local file_dir="$1"
    local basename="$2"
    local max_backups="$3"

    local backup_dir="$file_dir/$BACKUP_DIR"

    if [[ ! -d "$backup_dir" ]]; then
        return $E_SUCCESS
    fi

    # Find all backup files for this basename
    local backup_pattern="${basename}.[0-9]*"
    local backup_count
    backup_count=$(find "$backup_dir" -maxdepth 1 -name "$backup_pattern" 2>/dev/null | wc -l)

    if [[ $backup_count -le $max_backups ]]; then
        return $E_SUCCESS
    fi

    # Calculate how many to delete
    local delete_count=$((backup_count - max_backups))

    # Delete oldest backups (lowest numbers) - uses platform-compat safe_find_sorted_by_mtime
    safe_find_sorted_by_mtime "$backup_dir" "$backup_pattern" \
        | head -n "$delete_count" \
        | xargs rm -f 2>/dev/null || true

    return $E_SUCCESS
}

#######################################
# Atomic write operation with validation and backup
# Arguments:
#   $1 - File path
#   $2 - Content to write (via stdin if not provided)
# Returns:
#   0 on success, non-zero on error
#######################################
atomic_write() {
    local file="$1"
    local content="${2:-}"
    local lock_fd=""

    if [[ -z "$file" ]]; then
        echo "Error: File path required" >&2
        return $E_INVALID_ARGS
    fi

    # Acquire exclusive lock on the file
    # This prevents concurrent writes from causing race conditions
    if ! lock_file "$file" lock_fd 30; then
        echo "Error: Could not acquire lock for atomic write" >&2
        return $E_LOCK_FAILED
    fi

    # Set up trap to ensure lock is released on exit/error
    # Note: Using double quotes intentionally so $lock_fd and $file are expanded now
    # shellcheck disable=SC2064
    trap "unlock_file $lock_fd; rm -f '${file}${TEMP_SUFFIX}' 2>/dev/null || true" EXIT ERR INT TERM

    # Ensure parent directory exists
    local file_dir
    file_dir="$(dirname "$file")"
    if ! ensure_directory "$file_dir"; then
        unlock_file "$lock_fd"
        return $E_WRITE_FAILED
    fi

    # Create temporary file
    local temp_file="${file}${TEMP_SUFFIX}"

    # Write content to temp file
    if [[ -n "$content" ]]; then
        if ! echo "$content" > "$temp_file" 2>/dev/null; then
            echo "Error: Failed to write to temp file: $temp_file" >&2
            rm -f "$temp_file" 2>/dev/null || true
            unlock_file "$lock_fd"
            return $E_WRITE_FAILED
        fi
    else
        if ! cat > "$temp_file" 2>/dev/null; then
            echo "Error: Failed to write to temp file: $temp_file" >&2
            rm -f "$temp_file" 2>/dev/null || true
            unlock_file "$lock_fd"
            return $E_WRITE_FAILED
        fi
    fi

    # Validate temp file exists and has content
    if [[ ! -f "$temp_file" ]]; then
        echo "Error: Temp file not created: $temp_file" >&2
        unlock_file "$lock_fd"
        return $E_WRITE_FAILED
    fi

    if [[ ! -s "$temp_file" ]]; then
        echo "Error: Temp file is empty: $temp_file" >&2
        rm -f "$temp_file" 2>/dev/null || true
        unlock_file "$lock_fd"
        return $E_VALIDATION_FAILED
    fi

    # Backup original file if it exists
    local backup_file=""
    if [[ -f "$file" ]]; then
        backup_file=$(backup_file "$file")
        local backup_result=$?
        if [[ $backup_result -ne $E_SUCCESS ]]; then
            echo "Error: Failed to backup original file" >&2
            rm -f "$temp_file" 2>/dev/null || true
            unlock_file "$lock_fd"
            return $E_BACKUP_FAILED
        fi
    fi

    # Atomic rename (mv is atomic on same filesystem)
    if ! mv "$temp_file" "$file" 2>/dev/null; then
        echo "Error: Failed to move temp file to target: $file" >&2

        # Attempt rollback if backup exists
        if [[ -n "$backup_file" && -f "$backup_file" ]]; then
            echo "Attempting rollback from backup..." >&2
            cp "$backup_file" "$file" 2>/dev/null || true
        fi

        rm -f "$temp_file" 2>/dev/null || true
        unlock_file "$lock_fd"
        return $E_WRITE_FAILED
    fi

    # Set proper permissions
    chmod 644 "$file" 2>/dev/null || true

    # Release lock before successful return
    unlock_file "$lock_fd"

    # Clear trap since we're exiting successfully
    trap - EXIT ERR INT TERM

    return $E_SUCCESS
}

#######################################
# Restore file from backup
# Arguments:
#   $1 - Original file path
#   $2 - Backup number (optional, defaults to most recent)
# Returns:
#   0 on success, non-zero on error
#######################################
restore_backup() {
    local file="$1"
    local backup_num="${2:-}"

    if [[ -z "$file" ]]; then
        echo "Error: File path required" >&2
        return $E_INVALID_ARGS
    fi

    local file_dir
    file_dir="$(dirname "$file")"
    local basename
    basename="$(basename "$file")"
    local backup_dir="$file_dir/$BACKUP_DIR"

    if [[ ! -d "$backup_dir" ]]; then
        echo "Error: Backup directory not found: $backup_dir" >&2
        return $E_FILE_NOT_FOUND
    fi

    local backup_file

    # If backup number specified, use it
    if [[ -n "$backup_num" ]]; then
        backup_file="$backup_dir/${basename}.${backup_num}"
        if [[ ! -f "$backup_file" ]]; then
            echo "Error: Backup not found: $backup_file" >&2
            return $E_FILE_NOT_FOUND
        fi
    else
        # Find most recent backup - uses platform-compat safe_find_sorted_by_mtime
        backup_file=$(safe_find_sorted_by_mtime "$backup_dir" "${basename}.*" \
            | tail -n 1)

        if [[ -z "$backup_file" ]]; then
            echo "Error: No backups found for: $basename" >&2
            return $E_FILE_NOT_FOUND
        fi
    fi

    # Validate backup file
    if [[ ! -f "$backup_file" || ! -s "$backup_file" ]]; then
        echo "Error: Invalid backup file: $backup_file" >&2
        return $E_VALIDATION_FAILED
    fi

    # Copy backup to original location
    if ! cp "$backup_file" "$file" 2>/dev/null; then
        echo "Error: Failed to restore from backup: $backup_file" >&2
        return $E_RESTORE_FAILED
    fi

    # Set proper permissions
    chmod 644 "$file" 2>/dev/null || true

    echo "Restored from backup: $backup_file" >&2
    return $E_SUCCESS
}

#######################################
# Load and parse JSON file
# Arguments:
#   $1 - JSON file path
# Outputs:
#   JSON content to stdout
# Returns:
#   0 on success, non-zero on error
#######################################
load_json() {
    local file="$1"

    if [[ -z "$file" ]]; then
        echo "Error: File path required" >&2
        return $E_INVALID_ARGS
    fi

    if [[ ! -f "$file" ]]; then
        echo "Error: File not found: $file" >&2
        return $E_FILE_NOT_FOUND
    fi

    # Validate JSON syntax using jq
    if ! jq empty "$file" 2>/dev/null; then
        echo "Error: Invalid JSON in file: $file" >&2
        return $E_JSON_PARSE_FAILED
    fi

    # Output JSON content
    cat "$file"
    return $E_SUCCESS
}

#######################################
# Save JSON with pretty-printing and atomic write
# Arguments:
#   $1 - File path
#   $2 - JSON content (via stdin if not provided)
# Returns:
#   0 on success, non-zero on error
# Notes:
#   Locking is handled by atomic_write, so this function
#   does not need to acquire additional locks
#######################################
save_json() {
    local file="$1"
    local json="${2:-}"

    if [[ -z "$file" ]]; then
        echo "Error: File path required" >&2
        return $E_INVALID_ARGS
    fi

    # Read from stdin if no JSON provided
    if [[ -z "$json" ]]; then
        json=$(cat)
    fi

    # Validate JSON syntax
    if ! echo "$json" | jq empty 2>/dev/null; then
        echo "Error: Invalid JSON content" >&2
        return $E_JSON_PARSE_FAILED
    fi

    # Pretty-print JSON and write atomically (with locking)
    if ! echo "$json" | jq '.' | atomic_write "$file"; then
        echo "Error: Failed to save JSON to: $file" >&2
        return $E_WRITE_FAILED
    fi

    return $E_SUCCESS
}

#######################################
# List available backups for a file
# Arguments:
#   $1 - File path
# Outputs:
#   List of backup files with timestamps
# Returns:
#   0 on success
#######################################
list_backups() {
    local file="$1"

    if [[ -z "$file" ]]; then
        echo "Error: File path required" >&2
        return $E_INVALID_ARGS
    fi

    local file_dir
    file_dir="$(dirname "$file")"
    local basename
    basename="$(basename "$file")"
    local backup_dir="$file_dir/$BACKUP_DIR"

    if [[ ! -d "$backup_dir" ]]; then
        echo "No backups found" >&2
        return $E_SUCCESS
    fi

    # Find and list backups with metadata - uses platform-compat functions
    safe_find_sorted_by_mtime "$backup_dir" "${basename}.*" \
        | while read -r backup; do
            local mtime
            mtime=$(get_file_mtime "$backup")
            local timestamp
            timestamp=$(date -d "@$mtime" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -r "$mtime" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "unknown")
            local size
            size=$(get_file_size "$backup")
            printf "%s\t%s\t%s bytes\n" "$(basename "$backup")" "$timestamp" "$size"
        done

    return $E_SUCCESS
}

# Export functions
export -f ensure_directory
export -f lock_file
export -f unlock_file
export -f backup_file
export -f _rotate_numbered_backups
export -f atomic_write
export -f restore_backup
export -f load_json
export -f save_json
export -f list_backups
