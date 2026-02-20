#!/usr/bin/env bash
# atomic-write.sh - Primitive atomic file operations without validation dependencies
#
# LAYER: 1
# DEPENDENCIES: exit-codes.sh, platform-compat.sh
# PROVIDES: aw_ensure_dir, aw_write_temp, aw_atomic_move, aw_create_backup, aw_atomic_write
#
# PURPOSE:
#   This library provides low-level atomic file operations that do NOT depend on
#   validation.sh, migrate.sh, logging.sh, or any other Layer 2+ libraries.
#   It breaks the circular dependency chain:
#     file-ops.sh -> validation.sh -> migrate.sh -> file-ops.sh
#
#   By extracting these primitives to Layer 1, higher-level libraries can use
#   atomic operations without creating circular dependencies.
#
# DESIGN PRINCIPLES:
#   - All functions use 'aw_' prefix (atomic-write namespace)
#   - All variables are local (no global state pollution)
#   - Uses EXIT_* constants from exit-codes.sh (no magic numbers)
#   - Cross-platform via platform-compat.sh utilities
#   - No JSON validation (that's a Layer 2 concern)
#   - No logging (that's a Layer 2 concern)
#
# USAGE:
#   source lib/data/atomic-write.sh
#   aw_atomic_write "/path/to/file.json" "$content"

#=== SOURCE GUARD ================================================
[[ -n "${_ATOMIC_WRITE_LOADED:-}" ]] && return 0
declare -r _ATOMIC_WRITE_LOADED=1

set -euo pipefail

#=== DEPENDENCIES ================================================
# Layer 0 only - NO Layer 2+ dependencies!

_AW_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source exit codes (Layer 0)
if [[ -f "$_AW_LIB_DIR/core/exit-codes.sh" ]]; then
    # shellcheck source=lib/core/exit-codes.sh
    source "$_AW_LIB_DIR/core/exit-codes.sh"
else
    echo "ERROR: Cannot find exit-codes.sh in $_AW_LIB_DIR" >&2
    exit 1
fi

# Source platform compatibility (Layer 0)
if [[ -f "$_AW_LIB_DIR/core/platform-compat.sh" ]]; then
    # shellcheck source=lib/core/platform-compat.sh
    source "$_AW_LIB_DIR/core/platform-compat.sh"
else
    echo "ERROR: Cannot find platform-compat.sh in $_AW_LIB_DIR" >&2
    exit 1
fi

#=== CONFIGURATION ================================================

# Default backup directory (relative to file location)
# Guard pattern prevents readonly errors when sourced multiple times
[[ -z "${_AW_DEFAULT_BACKUP_SUBDIR:-}" ]] && readonly _AW_DEFAULT_BACKUP_SUBDIR="backups/operational"

# Default maximum number of backups to retain
[[ -z "${_AW_DEFAULT_MAX_BACKUPS:-}" ]] && readonly _AW_DEFAULT_MAX_BACKUPS=5

# Temp file suffix
[[ -z "${_AW_TEMP_SUFFIX:-}" ]] && readonly _AW_TEMP_SUFFIX=".tmp"

#=== FUNCTIONS ====================================================

#######################################
# Ensure directory exists with proper permissions
#
# Creates the directory and all parent directories if they don't exist.
# Sets permissions to 755 (owner: rwx, group: rx, other: rx).
#
# Arguments:
#   $1 - Directory path (required)
#
# Returns:
#   EXIT_SUCCESS (0) on success
#   EXIT_INVALID_INPUT (2) if path is empty
#   EXIT_FILE_ERROR (3) if directory creation fails
#
# Example:
#   aw_ensure_dir "/path/to/dir" || exit $?
#######################################
aw_ensure_dir() {
    local dir="$1"

    if [[ -z "$dir" ]]; then
        echo "aw_ensure_dir: Directory path required" >&2
        return "$EXIT_INVALID_INPUT"
    fi

    if [[ ! -d "$dir" ]]; then
        if ! mkdir -p "$dir" 2>/dev/null; then
            echo "aw_ensure_dir: Failed to create directory: $dir" >&2
            return "$EXIT_FILE_ERROR"
        fi

        # Set proper permissions (owner: rwx, group: rx, other: rx)
        chmod 755 "$dir" 2>/dev/null || true
    fi

    return "$EXIT_SUCCESS"
}

#######################################
# Write content to a temporary file
#
# Creates a temporary file with the given content. The temp file is created
# in the same directory as the target file to ensure atomic move works
# (mv is atomic only within the same filesystem).
#
# Arguments:
#   $1 - Target file path (temp file created alongside it)
#   $2 - Content to write (optional, reads from stdin if not provided)
#
# Outputs:
#   Writes the temp file path to stdout on success
#
# Returns:
#   EXIT_SUCCESS (0) on success
#   EXIT_INVALID_INPUT (2) if target path is empty
#   EXIT_FILE_ERROR (3) if write fails or temp file is empty
#
# Example:
#   temp_file=$(aw_write_temp "/path/to/file.json" "$json_content")
#   # or with stdin:
#   temp_file=$(echo "$json_content" | aw_write_temp "/path/to/file.json")
#######################################
aw_write_temp() {
    local target_file="$1"
    local content="${2:-}"

    if [[ -z "$target_file" ]]; then
        echo "aw_write_temp: Target file path required" >&2
        return "$EXIT_INVALID_INPUT"
    fi

    # Ensure parent directory exists
    local file_dir
    file_dir="$(dirname "$target_file")"
    if ! aw_ensure_dir "$file_dir"; then
        return "$EXIT_FILE_ERROR"
    fi

    # Create temp file in same directory as target (for atomic mv)
    local temp_file="${target_file}${_AW_TEMP_SUFFIX}"

    # Write content to temp file
    if [[ -n "$content" ]]; then
        if ! printf '%s' "$content" > "$temp_file" 2>/dev/null; then
            echo "aw_write_temp: Failed to write to temp file: $temp_file" >&2
            rm -f "$temp_file" 2>/dev/null || true
            return "$EXIT_FILE_ERROR"
        fi
    else
        # Read from stdin
        if ! cat > "$temp_file" 2>/dev/null; then
            echo "aw_write_temp: Failed to write stdin to temp file: $temp_file" >&2
            rm -f "$temp_file" 2>/dev/null || true
            return "$EXIT_FILE_ERROR"
        fi
    fi

    # Validate temp file exists
    if [[ ! -f "$temp_file" ]]; then
        echo "aw_write_temp: Temp file not created: $temp_file" >&2
        return "$EXIT_FILE_ERROR"
    fi

    # Validate temp file has content (prevent empty writes)
    if [[ ! -s "$temp_file" ]]; then
        echo "aw_write_temp: Temp file is empty: $temp_file" >&2
        rm -f "$temp_file" 2>/dev/null || true
        return "$EXIT_FILE_ERROR"
    fi

    # Output temp file path
    echo "$temp_file"
    return "$EXIT_SUCCESS"
}

#######################################
# Atomically move temp file to target
#
# Uses mv for atomic rename. This is atomic on POSIX filesystems when
# source and destination are on the same filesystem.
#
# Arguments:
#   $1 - Source file path (temp file)
#   $2 - Target file path (final destination)
#
# Returns:
#   EXIT_SUCCESS (0) on success
#   EXIT_INVALID_INPUT (2) if paths are empty
#   EXIT_FILE_ERROR (3) if source doesn't exist or move fails
#
# Example:
#   aw_atomic_move "$temp_file" "/path/to/file.json"
#######################################
aw_atomic_move() {
    local source_file="$1"
    local target_file="$2"

    if [[ -z "$source_file" ]]; then
        echo "aw_atomic_move: Source file path required" >&2
        return "$EXIT_INVALID_INPUT"
    fi

    if [[ -z "$target_file" ]]; then
        echo "aw_atomic_move: Target file path required" >&2
        return "$EXIT_INVALID_INPUT"
    fi

    if [[ ! -f "$source_file" ]]; then
        echo "aw_atomic_move: Source file not found: $source_file" >&2
        return "$EXIT_FILE_ERROR"
    fi

    # Atomic rename (mv is atomic on same filesystem)
    if ! mv "$source_file" "$target_file" 2>/dev/null; then
        echo "aw_atomic_move: Failed to move $source_file to $target_file" >&2
        return "$EXIT_FILE_ERROR"
    fi

    # Set proper permissions (owner: rw, group: r, other: r)
    chmod 644 "$target_file" 2>/dev/null || true

    return "$EXIT_SUCCESS"
}

#######################################
# Create a numbered backup of a file
#
# Creates a backup in the backup directory with an incrementing number.
# Automatically rotates old backups to maintain max_backups limit.
#
# Arguments:
#   $1 - File path to backup (required)
#   $2 - Max backups to keep (optional, default: 5)
#   $3 - Backup subdirectory (optional, default: "backups/operational")
#
# Outputs:
#   Writes the backup file path to stdout on success
#
# Returns:
#   EXIT_SUCCESS (0) on success
#   EXIT_INVALID_INPUT (2) if file path is empty
#   EXIT_NOT_FOUND (4) if source file doesn't exist
#   EXIT_FILE_ERROR (3) if backup creation fails
#
# Example:
#   backup_path=$(aw_create_backup "/path/to/file.json" 10)
#######################################
aw_create_backup() {
    local file="$1"
    local max_backups="${2:-$_AW_DEFAULT_MAX_BACKUPS}"
    local backup_subdir="${3:-$_AW_DEFAULT_BACKUP_SUBDIR}"

    if [[ -z "$file" ]]; then
        echo "aw_create_backup: File path required" >&2
        return "$EXIT_INVALID_INPUT"
    fi

    if [[ ! -f "$file" ]]; then
        echo "aw_create_backup: File not found: $file" >&2
        return "$EXIT_NOT_FOUND"
    fi

    # Determine backup directory (relative to file location)
    local file_dir
    file_dir="$(dirname "$file")"
    local backup_dir="$file_dir/$backup_subdir"

    # Ensure backup directory exists
    if ! aw_ensure_dir "$backup_dir"; then
        return "$EXIT_FILE_ERROR"
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

    # Copy file to backup (preserve timestamps)
    if ! cp -p "$file" "$backup_file" 2>/dev/null; then
        echo "aw_create_backup: Failed to create backup: $backup_file" >&2
        return "$EXIT_FILE_ERROR"
    fi

    # Set backup file permissions (owner only: rw)
    chmod 600 "$backup_file" 2>/dev/null || true

    # Rotate old backups (keep only max_backups)
    _aw_rotate_backups "$backup_dir" "$basename" "$max_backups"

    # Output backup file path
    echo "$backup_file"
    return "$EXIT_SUCCESS"
}

#######################################
# Internal: Rotate numbered backups
#
# Removes oldest backups to maintain max_backups limit.
# Uses modification time to determine age.
#
# Arguments:
#   $1 - Backup directory
#   $2 - Base filename
#   $3 - Maximum number of backups to keep
#
# Returns:
#   EXIT_SUCCESS (0) always
#######################################
_aw_rotate_backups() {
    local backup_dir="$1"
    local basename="$2"
    local max_backups="$3"

    if [[ ! -d "$backup_dir" ]]; then
        return "$EXIT_SUCCESS"
    fi

    # Pattern for backup files
    local backup_pattern="${basename}.[0-9]*"

    # Count existing backups
    local backup_count
    backup_count=$(find "$backup_dir" -maxdepth 1 -name "$backup_pattern" -type f 2>/dev/null | wc -l)

    if [[ $backup_count -le $max_backups ]]; then
        return "$EXIT_SUCCESS"
    fi

    # Calculate how many to delete
    local delete_count=$((backup_count - max_backups))

    # Delete oldest backups (uses platform-compat safe_find_sorted_by_mtime)
    safe_find_sorted_by_mtime "$backup_dir" "$backup_pattern" \
        | head -n "$delete_count" \
        | xargs rm -f 2>/dev/null || true

    return "$EXIT_SUCCESS"
}

#######################################
# Perform full atomic write operation
#
# Complete atomic write sequence:
#   1. Write content to temp file
#   2. Create backup of original (if exists)
#   3. Atomically move temp to target
#
# This function does NOT perform JSON validation or logging.
# Those are Layer 2 concerns handled by file-ops.sh.
#
# Arguments:
#   $1 - Target file path (required)
#   $2 - Content to write (optional, reads from stdin if not provided)
#   $3 - Max backups to keep (optional, default: 5)
#
# Returns:
#   EXIT_SUCCESS (0) on success
#   EXIT_INVALID_INPUT (2) if file path is empty
#   EXIT_FILE_ERROR (3) if any step fails
#
# Example:
#   aw_atomic_write "/path/to/file.json" "$json_content"
#   # or with stdin:
#   echo "$json_content" | aw_atomic_write "/path/to/file.json"
#
# Rollback behavior:
#   If the atomic move fails, attempts to restore from backup.
#   Temp file is always cleaned up on failure.
#######################################
aw_atomic_write() {
    local file="$1"
    local content="${2:-}"
    local max_backups="${3:-$_AW_DEFAULT_MAX_BACKUPS}"

    if [[ -z "$file" ]]; then
        echo "aw_atomic_write: File path required" >&2
        return "$EXIT_INVALID_INPUT"
    fi

    local temp_file=""
    local backup_file=""

    # Step 1: Write content to temp file
    if [[ -n "$content" ]]; then
        temp_file=$(aw_write_temp "$file" "$content")
    else
        # Read from stdin
        local stdin_content
        stdin_content=$(cat)
        temp_file=$(aw_write_temp "$file" "$stdin_content")
    fi

    local write_result=$?
    if [[ $write_result -ne "$EXIT_SUCCESS" ]]; then
        return "$EXIT_FILE_ERROR"
    fi

    # Step 2: Create backup of original file (if exists)
    if [[ -f "$file" ]]; then
        backup_file=$(aw_create_backup "$file" "$max_backups")
        local backup_result=$?
        if [[ $backup_result -ne "$EXIT_SUCCESS" ]]; then
            echo "aw_atomic_write: Failed to backup original file" >&2
            rm -f "$temp_file" 2>/dev/null || true
            return "$EXIT_FILE_ERROR"
        fi
    fi

    # Step 3: Atomically move temp to target
    if ! aw_atomic_move "$temp_file" "$file"; then
        echo "aw_atomic_write: Atomic move failed" >&2

        # Attempt rollback if backup exists
        if [[ -n "$backup_file" && -f "$backup_file" ]]; then
            echo "aw_atomic_write: Attempting rollback from backup..." >&2
            cp "$backup_file" "$file" 2>/dev/null || true
        fi

        # Clean up temp file
        rm -f "$temp_file" 2>/dev/null || true
        return "$EXIT_FILE_ERROR"
    fi

    return "$EXIT_SUCCESS"
}

#=== EXPORTS ======================================================

export -f aw_ensure_dir
export -f aw_write_temp
export -f aw_atomic_move
export -f aw_create_backup
export -f aw_atomic_write
