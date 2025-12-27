#!/bin/bash
# file-ops.sh - Atomic file operations with backup management
#
# LAYER: 2 (Data Layer)
# DEPENDENCIES: config.sh, atomic-write.sh
# PROVIDES: atomic_write, save_json, backup_file, restore_backup, lock_file,
#           unlock_file, recalculate_checksum, safe_file_read
#
# Design: All operations use temp files for atomicity with automatic backup rotation
#
# NOTE: This library does NOT depend on validation.sh to break circular dependency:
#       file-ops.sh -> validation.sh -> migrate.sh -> file-ops.sh
#       Validation is a Layer 2 concern handled by callers, not this library.
#
# NOTE: platform-compat.sh is sourced transitively via atomic-write.sh (Layer 1),
#       so we don't source it directly (reduces transitive dependencies).

#=== SOURCE GUARD ================================================
[[ -n "${_FILE_OPS_LOADED:-}" ]] && return 0
declare -r _FILE_OPS_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source atomic-write library (Layer 1) for primitive atomic operations
# This includes platform-compat.sh transitively and breaks circular dependency
if [[ -f "$_LIB_DIR/atomic-write.sh" ]]; then
    # shellcheck source=lib/atomic-write.sh
    source "$_LIB_DIR/atomic-write.sh"
else
    echo "ERROR: Cannot find atomic-write.sh in $_LIB_DIR" >&2
    exit 1
fi

# Source config library for unified config access (v0.24.0+)
# Optional - provides configurable backup retention
if [[ -f "$_LIB_DIR/config.sh" ]]; then
    # shellcheck source=lib/config.sh
    source "$_LIB_DIR/config.sh"
fi

# Configuration
# BACKUP_DIR: Unified backup directory per BACKUP-SYSTEM-SPEC.md Part 3.1
# Tier 1 (Operational) backups go to backups/operational/ with numbered rotation
BACKUP_DIR="backups/operational"
TEMP_SUFFIX=".tmp"
LOCK_SUFFIX=".lock"

# MAX_BACKUPS: Read from config with fallback to default (v0.24.0+)
# Uses backup.maxSafetyBackups since file-ops.sh creates safety backups during atomic writes
if declare -f get_config_value >/dev/null 2>&1; then
    MAX_BACKUPS=$(get_config_value "backup.maxSafetyBackups" "5")
else
    MAX_BACKUPS=5
fi

# Error codes (use FO_ prefix to avoid conflicts with error-json.sh constants)
FO_SUCCESS=0
FO_INVALID_ARGS=1
FO_FILE_NOT_FOUND=2
FO_WRITE_FAILED=3
FO_BACKUP_FAILED=4
FO_VALIDATION_FAILED=5
FO_RESTORE_FAILED=6
FO_JSON_PARSE_FAILED=7
FO_LOCK_FAILED=8

# ============================================================================
# SECURITY FUNCTIONS (inlined from validation.sh to avoid circular dependency)
# ============================================================================

#######################################
# Sanitize file path for safe shell usage
# Validates path does not contain shell metacharacters that could enable injection
# Arguments:
#   $1 - Path to sanitize
# Outputs:
#   Sanitized path to stdout if valid
# Returns:
#   0 if path is safe, 1 if path contains dangerous characters
# Security:
#   Prevents command injection via malicious file names with shell metacharacters
#   Used before any eval statements that include file paths
#######################################
_fo_sanitize_file_path() {
    local path="$1"

    # Check for empty path
    if [[ -z "$path" ]]; then
        echo "ERROR: Empty path provided" >&2
        return $FO_INVALID_ARGS
    fi

    # Note: Null byte check removed - bash cannot store null bytes in variables.
    # If a path contains null bytes, bash will truncate it before reaching here.
    # The metacharacter check below handles all relevant security concerns.

    # Check for shell metacharacters that could enable command injection
    # These characters have special meaning in shell contexts:
    #   $ - variable expansion / command substitution
    #   ` - command substitution (backticks)
    #   ; - command separator
    #   | - pipe
    #   & - background / AND operator
    #   < > - redirection
    #   ' " - quoting (can break out of quotes)
    #   ( ) - subshell / grouping
    #   { } - brace expansion / command grouping
    #   [ ] - glob patterns / test brackets
    #   ! - history expansion / negation
    #   \ - escape character (at end of path)
    #   newline/carriage return - command separator
    if [[ "$path" == *'$'* ]] || [[ "$path" == *'`'* ]] || [[ "$path" == *';'* ]] || \
       [[ "$path" == *'|'* ]] || [[ "$path" == *'&'* ]] || [[ "$path" == *'<'* ]] || \
       [[ "$path" == *'>'* ]] || [[ "$path" == *"'"* ]] || [[ "$path" == *'"'* ]] || \
       [[ "$path" == *'('* ]] || [[ "$path" == *')'* ]] || [[ "$path" == *'{'* ]] || \
       [[ "$path" == *'}'* ]] || [[ "$path" == *'['* ]] || [[ "$path" == *']'* ]] || \
       [[ "$path" == *'!'* ]]; then
        echo "ERROR: Path contains shell metacharacters - potential injection attempt: $path" >&2
        return $FO_INVALID_ARGS
    fi

    # Check for backslash at end of path (could escape following character)
    if [[ "$path" == *'\' ]]; then
        echo "ERROR: Path ends with backslash - potential injection attempt" >&2
        return $FO_INVALID_ARGS
    fi

    # Check for newlines and carriage returns (command separators)
    if [[ "$path" == *$'\n'* ]] || [[ "$path" == *$'\r'* ]]; then
        echo "ERROR: Path contains newline/carriage return - potential injection attempt" >&2
        return $FO_INVALID_ARGS
    fi

    # Path is safe - output it
    printf '%s' "$path"
    return $FO_SUCCESS
}

# ============================================================================
# DIRECTORY OPERATIONS
# ============================================================================

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
        return $FO_INVALID_ARGS
    fi

    # Delegate to atomic-write.sh Layer 1 primitive
    if ! aw_ensure_dir "$dir"; then
        return $FO_WRITE_FAILED
    fi

    return $FO_SUCCESS
}

# ============================================================================
# FILE LOCKING
# ============================================================================

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
# Security:
#   File paths are sanitized before use in eval to prevent command injection
#######################################
lock_file() {
    local file="$1"
    local fd_var="${2:-LOCK_FD}"
    local timeout="${3:-30}"

    if [[ -z "$file" ]]; then
        echo "Error: File path required for locking" >&2
        return $FO_INVALID_ARGS
    fi

    # SECURITY: Sanitize file path before use in eval statements
    # Prevents command injection via malicious file names with shell metacharacters
    local safe_file
    if ! safe_file=$(_fo_sanitize_file_path "$file"); then
        echo "Error: Invalid file path for locking (security check failed)" >&2
        return $FO_INVALID_ARGS
    fi

    # SECURITY: Validate fd_var contains only valid variable name characters
    # Prevents injection via the variable name parameter
    if [[ ! "$fd_var" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
        echo "Error: Invalid file descriptor variable name" >&2
        return $FO_INVALID_ARGS
    fi

    # Ensure parent directory exists
    local file_dir
    file_dir="$(dirname "$safe_file")"
    if ! ensure_directory "$file_dir"; then
        return $FO_LOCK_FAILED
    fi

    # Create lock file path and sanitize it
    local lock_file="${safe_file}${LOCK_SUFFIX}"
    local safe_lock_file
    if ! safe_lock_file=$(_fo_sanitize_file_path "$lock_file"); then
        echo "Error: Invalid lock file path (security check failed)" >&2
        return $FO_INVALID_ARGS
    fi

    # Touch lock file to ensure it exists
    touch "$safe_lock_file" 2>/dev/null || {
        echo "Error: Failed to create lock file: $safe_lock_file" >&2
        return $FO_LOCK_FAILED
    }

    # Find available file descriptor (200-210)
    local fd
    for fd in {200..210}; do
        if ! { true >&"$fd"; } 2>/dev/null; then
            # FD is available, use it
            # SECURITY: safe_lock_file has been sanitized above
            if ! eval "exec $fd>'$safe_lock_file'" 2>/dev/null; then
                # Failed to open FD, try next
                continue
            fi

            # Try to acquire lock with timeout
            if flock -w "$timeout" "$fd" 2>/dev/null; then
                # Success - store FD in caller's variable
                # SECURITY: fd_var validated above to contain only valid variable chars
                eval "$fd_var=$fd"
                return $FO_SUCCESS
            else
                # Failed to acquire lock (timeout or error)
                # Close FD and exit immediately - don't try other FDs
                eval "exec $fd>&-" 2>/dev/null || true
                echo "Error: Failed to acquire lock on $safe_file (timeout after ${timeout}s)" >&2
                echo "Another process may be accessing this file." >&2
                return $FO_LOCK_FAILED
            fi
        fi
    done

    # If we get here, no FD was available
    echo "Error: No available file descriptors for locking" >&2
    return $FO_LOCK_FAILED
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
# Security:
#   File descriptor is validated to be numeric before use in eval
#######################################
unlock_file() {
    local fd="${1:-${LOCK_FD:-}}"

    if [[ -z "$fd" ]]; then
        return $FO_SUCCESS
    fi

    # SECURITY: Validate fd is a valid file descriptor number (integer)
    # Prevents command injection via malicious fd values
    if [[ ! "$fd" =~ ^[0-9]+$ ]]; then
        echo "Error: Invalid file descriptor (must be numeric): $fd" >&2
        return $FO_INVALID_ARGS
    fi

    # Release lock and close file descriptor
    # SECURITY: fd validated above to be numeric only
    flock -u "$fd" 2>/dev/null || true
    eval "exec $fd>&-" 2>/dev/null || true

    return $FO_SUCCESS
}

# ============================================================================
# BACKUP OPERATIONS
# ============================================================================

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
        return $FO_INVALID_ARGS
    fi

    if [[ ! -f "$file" ]]; then
        echo "Error: File not found: $file" >&2
        return $FO_FILE_NOT_FOUND
    fi

    # Delegate to atomic-write.sh Layer 1 primitive
    # aw_create_backup handles: directory creation, numbered backup, rotation
    local backup_path
    if ! backup_path=$(aw_create_backup "$file" "$MAX_BACKUPS" "$BACKUP_DIR"); then
        echo "Error: Failed to create backup" >&2
        return $FO_BACKUP_FAILED
    fi

    # Output backup file path
    echo "$backup_path"
    return $FO_SUCCESS
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
        return $FO_SUCCESS
    fi

    # Find all backup files for this basename
    local backup_pattern="${basename}.[0-9]*"
    local backup_count
    backup_count=$(find "$backup_dir" -maxdepth 1 -name "$backup_pattern" 2>/dev/null | wc -l)

    if [[ $backup_count -le $max_backups ]]; then
        return $FO_SUCCESS
    fi

    # Calculate how many to delete
    local delete_count=$((backup_count - max_backups))

    # Delete oldest backups (lowest numbers) - uses platform-compat safe_find_sorted_by_mtime
    safe_find_sorted_by_mtime "$backup_dir" "$backup_pattern" \
        | head -n "$delete_count" \
        | xargs rm -f 2>/dev/null || true

    return $FO_SUCCESS
}

# ============================================================================
# ATOMIC WRITE OPERATIONS
# ============================================================================

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
        return $FO_INVALID_ARGS
    fi

    # Acquire exclusive lock on the file
    # This prevents concurrent writes from causing race conditions
    if ! lock_file "$file" lock_fd 30; then
        echo "Error: Could not acquire lock for atomic write" >&2
        return $FO_LOCK_FAILED
    fi

    # Set up trap to ensure lock is released on exit/error
    # Note: Using double quotes intentionally so $lock_fd and $file are expanded now
    # shellcheck disable=SC2064
    trap "unlock_file $lock_fd; rm -f '${file}${TEMP_SUFFIX}' 2>/dev/null || true" EXIT ERR INT TERM

    # Read content from stdin if not provided as argument
    if [[ -z "$content" ]]; then
        content=$(cat)
    fi

    # Validate content is not empty
    if [[ -z "$content" ]]; then
        echo "Error: Content is empty" >&2
        unlock_file "$lock_fd"
        trap - EXIT ERR INT TERM
        return $FO_VALIDATION_FAILED
    fi

    # Use atomic-write.sh Layer 1 primitive for the actual write
    # aw_atomic_write handles: temp file, backup, atomic move
    if ! aw_atomic_write "$file" "$content" "$MAX_BACKUPS"; then
        echo "Error: Atomic write failed for: $file" >&2
        unlock_file "$lock_fd"
        trap - EXIT ERR INT TERM
        return $FO_WRITE_FAILED
    fi

    # Release lock before successful return
    unlock_file "$lock_fd"

    # Clear trap since we're exiting successfully
    trap - EXIT ERR INT TERM

    return $FO_SUCCESS
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
        return $FO_INVALID_ARGS
    fi

    local file_dir
    file_dir="$(dirname "$file")"
    local basename
    basename="$(basename "$file")"
    local backup_dir="$file_dir/$BACKUP_DIR"

    if [[ ! -d "$backup_dir" ]]; then
        echo "Error: Backup directory not found: $backup_dir" >&2
        return $FO_FILE_NOT_FOUND
    fi

    local backup_file

    # If backup number specified, use it
    if [[ -n "$backup_num" ]]; then
        backup_file="$backup_dir/${basename}.${backup_num}"
        if [[ ! -f "$backup_file" ]]; then
            echo "Error: Backup not found: $backup_file" >&2
            return $FO_FILE_NOT_FOUND
        fi
    else
        # Find most recent backup - uses platform-compat safe_find_sorted_by_mtime
        backup_file=$(safe_find_sorted_by_mtime "$backup_dir" "${basename}.*" \
            | tail -n 1)

        if [[ -z "$backup_file" ]]; then
            echo "Error: No backups found for: $basename" >&2
            return $FO_FILE_NOT_FOUND
        fi
    fi

    # Validate backup file
    if [[ ! -f "$backup_file" || ! -s "$backup_file" ]]; then
        echo "Error: Invalid backup file: $backup_file" >&2
        return $FO_VALIDATION_FAILED
    fi

    # Copy backup to original location
    if ! cp "$backup_file" "$file" 2>/dev/null; then
        echo "Error: Failed to restore from backup: $backup_file" >&2
        return $FO_RESTORE_FAILED
    fi

    # Set proper permissions
    chmod 644 "$file" 2>/dev/null || true

    echo "Restored from backup: $backup_file" >&2
    return $FO_SUCCESS
}

# ============================================================================
# JSON OPERATIONS
# ============================================================================

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
        return $FO_INVALID_ARGS
    fi

    if [[ ! -f "$file" ]]; then
        echo "Error: File not found: $file" >&2
        return $FO_FILE_NOT_FOUND
    fi

    # Validate JSON syntax using jq
    if ! jq empty "$file" 2>/dev/null; then
        echo "Error: Invalid JSON in file: $file" >&2
        return $FO_JSON_PARSE_FAILED
    fi

    # Output JSON content
    cat "$file"
    return $FO_SUCCESS
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
        return $FO_INVALID_ARGS
    fi

    # Read from stdin if no JSON provided
    if [[ -z "$json" ]]; then
        json=$(cat)
    fi

    # Validate JSON syntax
    if ! echo "$json" | jq empty 2>/dev/null; then
        echo "Error: Invalid JSON content" >&2
        return $FO_JSON_PARSE_FAILED
    fi

    # Pretty-print JSON and write atomically (with locking)
    local pretty_json
    pretty_json=$(echo "$json" | jq '.')
    if ! atomic_write "$file" "$pretty_json"; then
        echo "Error: Failed to save JSON to: $file" >&2
        return $FO_WRITE_FAILED
    fi

    return $FO_SUCCESS
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
        return $FO_INVALID_ARGS
    fi

    local file_dir
    file_dir="$(dirname "$file")"
    local basename
    basename="$(basename "$file")"
    local backup_dir="$file_dir/$BACKUP_DIR"

    if [[ ! -d "$backup_dir" ]]; then
        echo "No backups found" >&2
        return $FO_SUCCESS
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

    return $FO_SUCCESS
}

# ============================================================================
# MULTI-FILE LOCKING (Multi-Session Support)
# ============================================================================

#######################################
# Acquire exclusive locks on multiple files in order
# Arguments:
#   $@ - File paths to lock (in order)
# Outputs:
#   Space-separated file descriptors to stdout
# Returns:
#   0 on success, FO_LOCK_FAILED if any lock fails
# Notes:
#   Locks are acquired in the order provided to prevent deadlock.
#   Per MULTI-SESSION-SPEC.md, always lock: sessions.json → todo.json → todo-log.json
#   On failure, any acquired locks are released before returning.
# Security:
#   File paths are sanitized by lock_file before use
#######################################
lock_multi_file() {
    local files=("$@")
    local fds=()
    local fd_var

    for file in "${files[@]}"; do
        fd_var="MULTI_LOCK_FD_${#fds[@]}"

        if ! lock_file "$file" "$fd_var" 30; then
            # Release any locks we already acquired
            for acquired_fd in "${fds[@]}"; do
                unlock_file "$acquired_fd"
            done
            echo "Error: Failed to acquire lock on $file" >&2
            return $FO_LOCK_FAILED
        fi

        # Get the FD value from the variable
        eval "fds+=(\"\$$fd_var\")"
    done

    # Output all FDs space-separated
    printf '%s\n' "${fds[*]}"
    return $FO_SUCCESS
}

#######################################
# Release multiple file locks
# Arguments:
#   $@ - File descriptors to unlock (order doesn't matter)
# Returns:
#   Always 0 (errors are suppressed)
# Notes:
#   Safe to call even if some locks aren't held
#######################################
unlock_multi_file() {
    local fds=("$@")

    for fd in "${fds[@]}"; do
        unlock_file "$fd"
    done

    return $FO_SUCCESS
}

#######################################
# Execute a function with multiple file locks held
# Arguments:
#   $1 - Function to execute
#   $@ (remaining) - Files to lock (in order)
# Returns:
#   Return value of the executed function
# Notes:
#   Automatically acquires locks, executes function, releases locks.
#   Function is called with no arguments; use closures or globals for state.
# Example:
#   with_multi_lock my_update_function sessions.json todo.json
#######################################
with_multi_lock() {
    local func="$1"
    shift
    local files=("$@")

    local fds_str
    if ! fds_str=$(lock_multi_file "${files[@]}"); then
        return $FO_LOCK_FAILED
    fi

    # Convert space-separated string to array
    read -ra fds <<< "$fds_str"

    # Set up trap to release locks on exit/error
    trap "unlock_multi_file ${fds[*]}" EXIT ERR INT TERM

    # Execute the function
    local result
    "$func"
    result=$?

    # Release locks
    unlock_multi_file "${fds[@]}"

    # Clear trap
    trap - EXIT ERR INT TERM

    return $result
}

# Export functions
export -f ensure_directory
export -f lock_file
export -f unlock_file
export -f lock_multi_file
export -f unlock_multi_file
export -f with_multi_lock
export -f backup_file
export -f _rotate_numbered_backups
export -f atomic_write
export -f restore_backup
export -f load_json
export -f save_json
export -f list_backups
export -f _fo_sanitize_file_path
