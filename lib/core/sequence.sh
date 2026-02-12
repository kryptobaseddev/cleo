#!/usr/bin/env bash
# sequence.sh - Robust task ID generation with sequence file management
#
# Provides O(1) task ID generation using a persistent sequence file.
# Replaces the O(n) scan-based approach that failed to check archive.
#
# Usage:
#   source lib/core/sequence.sh
#   id=$(get_next_task_id)  # Returns "T1234"

# Guard against double-sourcing
[[ -n "${_SEQUENCE_SH_LOADED:-}" ]] && return 0
_SEQUENCE_SH_LOADED=1

# Determine script directory for sourcing dependencies
_SEQ_LIB_DIR="${_SEQ_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Source dependencies
# shellcheck source=paths.sh
source "${_SEQ_LIB_DIR}/core/paths.sh"
# shellcheck source=file-ops.sh
source "${_SEQ_LIB_DIR}/data/file-ops.sh"

# ============================================================================
# Constants
# ============================================================================

# Sequence file paths (relative to CLEO_DIR)
SEQUENCE_FILE_NAME=".sequence"
SEQUENCE_LOCK_SUFFIX=".lock"

# Lock timeout in seconds (5 seconds as specified)
SEQUENCE_LOCK_TIMEOUT=5

# Exit codes for sequence operations
SEQ_SUCCESS=0
SEQ_INVALID_ARGS=1
SEQ_FILE_NOT_FOUND=2
SEQ_PARSE_ERROR=3
SEQ_CHECKSUM_MISMATCH=4
SEQ_LOCK_FAILED=5
SEQ_WRITE_FAILED=6
SEQ_RECOVERY_FAILED=7

# ============================================================================
# Internal Helper Functions
# ============================================================================

# Get the sequence file path
# Returns: Path to .cleo/.sequence
_get_sequence_file() {
    echo "$(get_cleo_dir)/${SEQUENCE_FILE_NAME}"
}

# Get the sequence lock file path
# Returns: Path to .cleo/.sequence.lock
_get_sequence_lock_file() {
    echo "$(get_cleo_dir)/${SEQUENCE_FILE_NAME}${SEQUENCE_LOCK_SUFFIX}"
}

# Calculate checksum for sequence data
# Args: $1 = counter value
# Returns: First 8 characters of SHA-256 hash
_calculate_sequence_checksum() {
    local counter="$1"
    echo -n "$counter" | sha256sum | cut -c1-8
}

# Validate checksum matches counter
# Args: $1 = counter, $2 = checksum
# Returns: 0 if valid, 1 if mismatch
_validate_sequence_checksum() {
    local counter="$1"
    local checksum="$2"
    local expected
    expected=$(_calculate_sequence_checksum "$counter")
    [[ "$checksum" == "$expected" ]]
}

# Extract numeric ID from task ID string
# Args: $1 = task ID (e.g., "T1234")
# Returns: numeric value (e.g., 1234)
_extract_numeric_id() {
    local id="$1"
    # Remove leading 'T' and any leading zeros, convert to number
    echo "$id" | sed 's/^T//' | sed 's/^0*//' | grep -E '^[0-9]+$' || echo "0"
}

# ============================================================================
# Core Sequence Functions
# ============================================================================

# Read current sequence counter with validation
# Returns: JSON object with counter info on stdout, or error message on stderr
# Exit codes: SEQ_SUCCESS, SEQ_FILE_NOT_FOUND, SEQ_PARSE_ERROR, SEQ_CHECKSUM_MISMATCH
read_sequence() {
    local seq_file
    seq_file=$(_get_sequence_file)

    # Check file exists
    if [[ ! -f "$seq_file" ]]; then
        echo "Sequence file not found: $seq_file" >&2
        return $SEQ_FILE_NOT_FOUND
    fi

    # Read and parse JSON
    local content
    if ! content=$(cat "$seq_file" 2>/dev/null); then
        echo "Failed to read sequence file: $seq_file" >&2
        return $SEQ_PARSE_ERROR
    fi

    # Validate JSON syntax
    if ! echo "$content" | jq -e '.' >/dev/null 2>&1; then
        echo "Invalid JSON in sequence file: $seq_file" >&2
        return $SEQ_PARSE_ERROR
    fi

    # Extract and validate fields
    local counter checksum
    counter=$(echo "$content" | jq -r '.counter // empty')
    checksum=$(echo "$content" | jq -r '.checksum // empty')

    if [[ -z "$counter" ]]; then
        echo "Missing counter in sequence file" >&2
        return $SEQ_PARSE_ERROR
    fi

    # Validate counter is a positive integer
    if ! [[ "$counter" =~ ^[0-9]+$ ]]; then
        echo "Invalid counter value: $counter" >&2
        return $SEQ_PARSE_ERROR
    fi

    # Validate checksum if present
    if [[ -n "$checksum" ]]; then
        if ! _validate_sequence_checksum "$counter" "$checksum"; then
            echo "Checksum mismatch in sequence file (expected: $(_calculate_sequence_checksum "$counter"), got: $checksum)" >&2
            return $SEQ_CHECKSUM_MISMATCH
        fi
    fi

    # Return the content
    echo "$content"
    return $SEQ_SUCCESS
}

# Write sequence counter to file
# Args: $1 = counter value
# Returns: 0 on success, error code on failure
write_sequence() {
    local counter="$1"

    if [[ -z "$counter" ]] || ! [[ "$counter" =~ ^[0-9]+$ ]]; then
        echo "Invalid counter value: $counter" >&2
        return $SEQ_INVALID_ARGS
    fi

    local seq_file
    seq_file=$(_get_sequence_file)

    # Ensure directory exists
    local seq_dir
    seq_dir=$(dirname "$seq_file")
    if ! mkdir -p "$seq_dir" 2>/dev/null; then
        echo "Failed to create sequence directory: $seq_dir" >&2
        return $SEQ_WRITE_FAILED
    fi

    # Calculate checksum
    local checksum
    checksum=$(_calculate_sequence_checksum "$counter")

    # Format task ID
    local last_id
    last_id=$(printf "T%03d" "$counter")

    # Get current timestamp
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Preserve recoveredAt if it exists
    local recovered_at="null"
    if [[ -f "$seq_file" ]]; then
        recovered_at=$(jq -r '.recoveredAt // "null"' "$seq_file" 2>/dev/null || echo "null")
        if [[ "$recovered_at" != "null" ]]; then
            recovered_at="\"$recovered_at\""
        fi
    fi

    # Build JSON content
    local content
    content=$(cat <<EOF
{
  "counter": $counter,
  "lastId": "$last_id",
  "checksum": "$checksum",
  "updatedAt": "$timestamp",
  "recoveredAt": $recovered_at
}
EOF
)

    # Write atomically using temp file and rename
    local temp_file="${seq_file}.tmp.$$"

    if ! echo "$content" > "$temp_file" 2>/dev/null; then
        rm -f "$temp_file" 2>/dev/null
        echo "Failed to write temp sequence file" >&2
        return $SEQ_WRITE_FAILED
    fi

    # Atomic rename
    if ! mv "$temp_file" "$seq_file" 2>/dev/null; then
        rm -f "$temp_file" 2>/dev/null
        echo "Failed to rename sequence file" >&2
        return $SEQ_WRITE_FAILED
    fi

    return $SEQ_SUCCESS
}

# Scan existing tasks to find maximum ID
# Scans both todo.json and todo-archive.json
# Returns: Maximum numeric ID found (0 if none)
# NOTE: Uses jq ltrimstr+tonumber to convert IDs to proper integers,
#       avoiding issues with leading zeros (e.g., "T050" -> 50, not octal 40)
_scan_max_task_id() {
    local todo_file archive_file
    todo_file=$(get_todo_file)
    archive_file=$(get_archive_file)

    local max_id=0

    # Scan todo.json using jq to convert to proper integers
    # ltrimstr removes "T" prefix, tonumber converts to integer (strips leading zeros)
    if [[ -f "$todo_file" ]]; then
        local todo_max
        todo_max=$(jq -r '[.tasks[]?.id // empty | ltrimstr("T") | tonumber] | max // 0' "$todo_file" 2>/dev/null || echo "0")
        if [[ -n "$todo_max" ]] && [[ "$todo_max" =~ ^[0-9]+$ ]]; then
            if (( todo_max > max_id )); then
                max_id=$todo_max
            fi
        fi
    fi

    # Scan archive using same approach
    if [[ -f "$archive_file" ]]; then
        local archive_max
        archive_max=$(jq -r '[.archivedTasks[]?.id // empty | ltrimstr("T") | tonumber] | max // 0' "$archive_file" 2>/dev/null || echo "0")
        if [[ -n "$archive_max" ]] && [[ "$archive_max" =~ ^[0-9]+$ ]]; then
            if (( archive_max > max_id )); then
                max_id=$archive_max
            fi
        fi
    fi

    echo "$max_id"
}

# Recover sequence from existing tasks
# Scans todo.json and todo-archive.json to find max ID
# Returns: 0 on success, SEQ_RECOVERY_FAILED on error
recover_sequence() {
    local max_id
    max_id=$(_scan_max_task_id)

    local seq_file
    seq_file=$(_get_sequence_file)

    # Calculate values
    local checksum timestamp
    checksum=$(_calculate_sequence_checksum "$max_id")
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Format task ID (handle 0 case)
    local last_id
    if (( max_id == 0 )); then
        last_id="null"
    else
        last_id="\"$(printf "T%03d" "$max_id")\""
    fi

    # Build JSON with recoveredAt timestamp
    local content
    content=$(cat <<EOF
{
  "counter": $max_id,
  "lastId": $last_id,
  "checksum": "$checksum",
  "updatedAt": "$timestamp",
  "recoveredAt": "$timestamp"
}
EOF
)

    # Ensure directory exists
    local seq_dir
    seq_dir=$(dirname "$seq_file")
    if ! mkdir -p "$seq_dir" 2>/dev/null; then
        echo "Failed to create sequence directory: $seq_dir" >&2
        return $SEQ_RECOVERY_FAILED
    fi

    # Write atomically
    local temp_file="${seq_file}.tmp.$$"
    if ! echo "$content" > "$temp_file" 2>/dev/null; then
        rm -f "$temp_file" 2>/dev/null
        echo "Failed to write recovered sequence file" >&2
        return $SEQ_RECOVERY_FAILED
    fi

    if ! mv "$temp_file" "$seq_file" 2>/dev/null; then
        rm -f "$temp_file" 2>/dev/null
        echo "Failed to rename recovered sequence file" >&2
        return $SEQ_RECOVERY_FAILED
    fi

    return $SEQ_SUCCESS
}

# Validate sequence file and auto-recover if needed
# Returns: 0 if valid (or recovered), error code otherwise
validate_sequence() {
    local seq_file
    seq_file=$(_get_sequence_file)

    # Check file exists
    if [[ ! -f "$seq_file" ]]; then
        echo "Sequence file missing, recovering..." >&2
        if ! recover_sequence; then
            echo "Failed to recover sequence" >&2
            return $SEQ_RECOVERY_FAILED
        fi
        return $SEQ_SUCCESS
    fi

    # Try to read and validate
    local result
    if ! result=$(read_sequence 2>&1); then
        echo "Sequence validation failed: $result" >&2
        echo "Recovering sequence..." >&2
        if ! recover_sequence; then
            echo "Failed to recover sequence" >&2
            return $SEQ_RECOVERY_FAILED
        fi
        return $SEQ_SUCCESS
    fi

    # Check counter vs actual max ID in tasks
    local current_counter max_id
    current_counter=$(echo "$result" | jq -r '.counter')
    max_id=$(_scan_max_task_id)

    if (( max_id > current_counter )); then
        echo "Counter $current_counter is behind max ID $max_id, recovering..." >&2
        if ! recover_sequence; then
            echo "Failed to recover sequence" >&2
            return $SEQ_RECOVERY_FAILED
        fi
    fi

    return $SEQ_SUCCESS
}

# Initialize sequence file from existing tasks
# Called during project initialization or first use
# Returns: 0 on success, error code on failure
init_sequence() {
    local seq_file
    seq_file=$(_get_sequence_file)

    # If file exists, validate it
    if [[ -f "$seq_file" ]]; then
        if validate_sequence; then
            return $SEQ_SUCCESS
        fi
        # validate_sequence already handles recovery
        return $?
    fi

    # File doesn't exist, create from existing tasks
    if ! recover_sequence; then
        echo "Failed to initialize sequence" >&2
        return $SEQ_RECOVERY_FAILED
    fi

    return $SEQ_SUCCESS
}

# Get next task ID with atomic increment
# This is the main entry point for ID generation
# Returns: New task ID (e.g., "T1234") on stdout
# Exit codes: SEQ_SUCCESS, SEQ_LOCK_FAILED, etc.
get_next_task_id() {
    local seq_file lock_file
    seq_file=$(_get_sequence_file)
    lock_file=$(_get_sequence_lock_file)

    # Ensure sequence is initialized
    if [[ ! -f "$seq_file" ]]; then
        if ! init_sequence; then
            echo "Failed to initialize sequence" >&2
            return $SEQ_RECOVERY_FAILED
        fi
    fi

    # Ensure lock file directory exists
    local lock_dir
    lock_dir=$(dirname "$lock_file")
    mkdir -p "$lock_dir" 2>/dev/null

    # Acquire exclusive lock with timeout
    local lock_fd

    # Create lock file
    touch "$lock_file" 2>/dev/null || {
        echo "Failed to create lock file: $lock_file" >&2
        return $SEQ_LOCK_FAILED
    }

    # Open file descriptor for locking
    exec {lock_fd}>"$lock_file" || {
        echo "Failed to open lock file descriptor" >&2
        return $SEQ_LOCK_FAILED
    }

    # Try to acquire lock with timeout
    if ! flock -w "$SEQUENCE_LOCK_TIMEOUT" "$lock_fd" 2>/dev/null; then
        exec {lock_fd}>&- 2>/dev/null || true
        echo "Failed to acquire sequence lock (timeout after ${SEQUENCE_LOCK_TIMEOUT}s)" >&2
        echo "Another process may be generating task IDs" >&2
        return $SEQ_LOCK_FAILED
    fi

    # Set up cleanup trap
    # shellcheck disable=SC2064
    trap "exec ${lock_fd}>&- 2>/dev/null || true" EXIT

    # Read current counter (with validation/recovery)
    local seq_data current_counter
    if ! seq_data=$(read_sequence 2>/dev/null); then
        # Recovery needed
        if ! recover_sequence; then
            exec {lock_fd}>&- 2>/dev/null || true
            trap - EXIT
            echo "Failed to recover sequence during ID generation" >&2
            return $SEQ_RECOVERY_FAILED
        fi
        seq_data=$(read_sequence)
    fi

    current_counter=$(echo "$seq_data" | jq -r '.counter')

    # Validate counter vs actual max (belt and suspenders)
    local max_id
    max_id=$(_scan_max_task_id)
    if (( max_id >= current_counter )); then
        current_counter=$max_id
    fi

    # Increment counter
    local new_counter
    new_counter=$((current_counter + 1))

    # Write new counter
    if ! write_sequence "$new_counter"; then
        exec {lock_fd}>&- 2>/dev/null || true
        trap - EXIT
        echo "Failed to write new sequence counter" >&2
        return $SEQ_WRITE_FAILED
    fi

    # Release lock
    exec {lock_fd}>&- 2>/dev/null || true
    trap - EXIT

    # Return new task ID
    printf "T%03d\n" "$new_counter"
    return $SEQ_SUCCESS
}

# Reset sequence counter (for testing purposes only)
# Args: $1 = new counter value (default: 0)
# Returns: 0 on success
_reset_sequence() {
    local counter="${1:-0}"
    local seq_file
    seq_file=$(_get_sequence_file)

    # Remove existing file if present
    rm -f "$seq_file" 2>/dev/null

    # Write new sequence
    write_sequence "$counter"
}

# Get current counter value without incrementing
# Returns: Current counter value on stdout
get_current_sequence() {
    local seq_file
    seq_file=$(_get_sequence_file)

    if [[ ! -f "$seq_file" ]]; then
        echo "0"
        return $SEQ_SUCCESS
    fi

    local seq_data
    if seq_data=$(read_sequence 2>/dev/null); then
        echo "$seq_data" | jq -r '.counter'
    else
        echo "0"
    fi
    return $SEQ_SUCCESS
}
