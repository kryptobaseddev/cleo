#!/usr/bin/env bash
# CLEO Installer Core - Atomic Installation Framework
# Provides state machine, locking, and recovery primitives
#
# Version: 1.0.0
# Task: T1858
# Based on: claudedocs/research-outputs/2026-01-20_atomic-installation-mechanism.md

set -euo pipefail

# ============================================
# GUARD: Prevent double-sourcing
# ============================================
[[ -n "${_INSTALLER_CORE_LOADED:-}" ]] && return 0
readonly _INSTALLER_CORE_LOADED=1

# ============================================
# CONSTANTS
# ============================================
readonly INSTALLER_VERSION="1.0.0"
readonly INSTALL_DIR="${CLEO_HOME:-$HOME/.cleo}"
readonly STATE_DIR="$INSTALL_DIR/.install-state"
readonly LOCK_FILE="$STATE_DIR/.install.lock"
readonly STATE_FILE="$STATE_DIR/current"
readonly MARKERS_DIR="$STATE_DIR/markers"
readonly BACKUPS_DIR="$STATE_DIR/backups"

# Timing constants
readonly LOCK_TIMEOUT=3600          # 1 hour stale threshold
readonly LOCK_WAIT_DEFAULT=30       # Default wait time for lock acquisition
readonly LOCK_POLL_INTERVAL=1       # Seconds between lock checks

# Exit codes (60-74 range for installer)
readonly EXIT_LOCK_HELD=60
readonly EXIT_STATE_CORRUPT=61
readonly EXIT_BACKUP_FAILED=62
readonly EXIT_INSTALL_FAILED=63
readonly EXIT_ROLLBACK_FAILED=64
readonly EXIT_VALIDATION_FAILED=65
readonly EXIT_DOWNLOAD_FAILED=66
readonly EXIT_CHECKSUM_MISMATCH_INST=67
readonly EXIT_PERMISSION_DENIED=68
readonly EXIT_INTERRUPTED=69
readonly EXIT_PROFILE_FAILED=70
readonly EXIT_STAGING_FAILED=71

# State machine - ordered progression
readonly -a INSTALLER_STATES=(INIT PREPARE VALIDATE BACKUP INSTALL LINK PROFILE VERIFY CLEANUP COMPLETE)

# Global state tracking
INSTALLER_INTERRUPTED=false
INSTALLER_CURRENT_STATE=""
INSTALLER_TEMP_DIR=""
INSTALLER_BACKUP_PATH=""

# ============================================
# LOGGING
# ============================================
installer_log_info() {
    echo "[INFO] $*" >&2
}

installer_log_warn() {
    echo "[WARN] $*" >&2
}

installer_log_error() {
    echo "[ERROR] $*" >&2
}

installer_log_debug() {
    [[ -n "${INSTALLER_DEBUG:-}" ]] && echo "[DEBUG] $*" >&2
    return 0
}

installer_log_step() {
    echo "[STEP] $*" >&2
}

# ============================================
# DIRECTORY SETUP
# ============================================
installer_ensure_dirs() {
    mkdir -p "$STATE_DIR" "$MARKERS_DIR" "$BACKUPS_DIR"
}

# ============================================
# LOCKING
# ============================================

# Acquire installation lock with timeout
# Args: [timeout_seconds]
# Returns: 0 on success, EXIT_LOCK_HELD on failure
installer_lock_acquire() {
    local timeout="${1:-$LOCK_WAIT_DEFAULT}"
    local start_time
    local lock_content

    installer_ensure_dirs
    start_time=$(date +%s)
    lock_content="$$|$(date -u +%Y-%m-%dT%H:%M:%SZ)|$(hostname)"

    while true; do
        # Attempt atomic lock creation using noclobber
        if (set -o noclobber; echo "$lock_content" > "$LOCK_FILE") 2>/dev/null; then
            installer_log_debug "Lock acquired (PID: $$)"
            return 0
        fi

        # Lock exists - check if stale
        if installer_lock_check_stale; then
            installer_log_warn "Removing stale lock"
            rm -f "$LOCK_FILE"
            continue
        fi

        # Check timeout
        local elapsed=$(($(date +%s) - start_time))
        if [[ $elapsed -ge $timeout ]]; then
            local lock_info
            lock_info=$(cat "$LOCK_FILE" 2>/dev/null || echo "unknown")
            installer_log_error "Failed to acquire lock after ${timeout}s"
            installer_log_error "Lock held by: $lock_info"
            return $EXIT_LOCK_HELD
        fi

        installer_log_debug "Waiting for lock... (${elapsed}s)"
        sleep $LOCK_POLL_INTERVAL
    done
}

# Release the installation lock
installer_lock_release() {
    if [[ -f "$LOCK_FILE" ]]; then
        local lock_pid
        lock_pid=$(cut -d'|' -f1 "$LOCK_FILE" 2>/dev/null || echo "")

        # Only release if we own it
        if [[ "$lock_pid" == "$$" ]]; then
            rm -f "$LOCK_FILE"
            installer_log_debug "Lock released"
        fi
    fi
}

# Check if existing lock is stale
# Returns: 0 if stale, 1 if valid
# Lock format: PID|TIMESTAMP|HOSTNAME (using | delimiter to avoid conflict with : in timestamp)
installer_lock_check_stale() {
    [[ ! -f "$LOCK_FILE" ]] && return 1

    local lock_info lock_pid lock_ts lock_host
    lock_info=$(cat "$LOCK_FILE" 2>/dev/null) || return 1

    # Use | as delimiter (timestamp contains colons)
    lock_pid=$(echo "$lock_info" | cut -d'|' -f1)
    lock_ts=$(echo "$lock_info" | cut -d'|' -f2)
    lock_host=$(echo "$lock_info" | cut -d'|' -f3)

    # Check if process is alive (only if same host)
    if [[ "$lock_host" == "$(hostname)" ]]; then
        if ! kill -0 "$lock_pid" 2>/dev/null; then
            installer_log_debug "Lock process $lock_pid is dead"
            return 0  # Stale
        fi
    fi

    # Check if lock is too old (stale threshold)
    local lock_epoch current_epoch
    # Handle both GNU and BSD date
    if date -d "$lock_ts" +%s &>/dev/null; then
        lock_epoch=$(date -d "$lock_ts" +%s)
    else
        lock_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$lock_ts" +%s 2>/dev/null || echo 0)
    fi
    current_epoch=$(date +%s)

    if [[ $((current_epoch - lock_epoch)) -gt $LOCK_TIMEOUT ]]; then
        installer_log_debug "Lock is older than ${LOCK_TIMEOUT}s"
        return 0  # Stale
    fi

    return 1  # Not stale
}

# ============================================
# STATE MACHINE
# ============================================

# Initialize state tracking
# Args: version source_dir install_dir [options_json]
installer_state_init() {
    local version="${1:-unknown}"
    local source_dir="${2:-$(pwd)}"
    local install_dir="${3:-$INSTALL_DIR}"
    local options_json="${4:-"{}"}"

    installer_ensure_dirs

    local state_json
    state_json=$(jq -n \
        --arg state "INIT" \
        --arg prev "" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg version "$version" \
        --arg source "$source_dir" \
        --arg install "$install_dir" \
        --argjson options "$options_json" \
        '{
            state: $state,
            previous_state: $prev,
            timestamp: $ts,
            started_at: $started,
            version: $version,
            source_dir: $source,
            install_dir: $install,
            backup_path: null,
            temp_dir: null,
            options: $options,
            completed: [],
            pending: ["INIT","PREPARE","VALIDATE","BACKUP","INSTALL","LINK","PROFILE","VERIFY","CLEANUP","COMPLETE"]
        }')

    # Atomic write to state file
    installer_atomic_write "$STATE_FILE" "$state_json"
    INSTALLER_CURRENT_STATE="INIT"
}

# Get current state
installer_state_get() {
    jq -r '.state' "$STATE_FILE" 2>/dev/null || echo "UNKNOWN"
}

# Update state value in state file
# Args: key value
installer_state_set() {
    local key="$1"
    local value="$2"

    [[ -f "$STATE_FILE" ]] || return 0

    local temp_state="${STATE_FILE}.tmp.$$"
    if jq --arg key "$key" --arg val "$value" \
       '.[$key] = $val' "$STATE_FILE" > "$temp_state" 2>/dev/null; then
        mv "$temp_state" "$STATE_FILE" 2>/dev/null || rm -f "$temp_state"
    else
        rm -f "$temp_state"
    fi
}

# Transition to new state
# Args: new_state
installer_state_transition() {
    local new_state="$1"
    local prev_state
    local timestamp

    prev_state=$(installer_state_get)
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Update state file atomically (if it exists)
    if [[ -f "$STATE_FILE" ]]; then
        local temp_state="${STATE_FILE}.tmp.$$"
        if jq --arg state "$new_state" \
           --arg prev "$prev_state" \
           --arg ts "$timestamp" \
           '.state = $state | .previous_state = $prev | .timestamp = $ts' \
           "$STATE_FILE" > "$temp_state" 2>/dev/null; then
            mv "$temp_state" "$STATE_FILE" 2>/dev/null || rm -f "$temp_state"
        else
            rm -f "$temp_state"
        fi
    fi

    INSTALLER_CURRENT_STATE="$new_state"
    installer_log_debug "State transition: $prev_state -> $new_state"
}

# Mark state as complete
# Args: state
installer_state_mark_complete() {
    local state="$1"
    local marker_file="$MARKERS_DIR/${state}.done"
    local timestamp

    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Ensure directories exist
    mkdir -p "$MARKERS_DIR" 2>/dev/null || true

    # Write marker file
    echo "$timestamp" > "$marker_file" 2>/dev/null || true
    sync "$marker_file" 2>/dev/null || true

    # Update state file (if it exists)
    if [[ -f "$STATE_FILE" ]]; then
        local temp_state="${STATE_FILE}.tmp.$$"
        if jq --arg state "$state" \
           '.completed += [$state] | .pending -= [$state]' \
           "$STATE_FILE" > "$temp_state" 2>/dev/null; then
            mv "$temp_state" "$STATE_FILE" 2>/dev/null || rm -f "$temp_state"
        else
            rm -f "$temp_state"
        fi
    fi
}

# Check if state is complete
# Args: state
installer_state_is_complete() {
    local state="$1"
    [[ -f "$MARKERS_DIR/${state}.done" ]]
}

# Check if recovery is possible from given state
# Args: state
# Returns: 0 if auto-recoverable, 1 if needs prompt, 2 if critical
installer_state_can_recover() {
    local state="$1"

    case "$state" in
        INIT|PREPARE|VALIDATE|VERIFY|CLEANUP|COMPLETE)
            return 0  # Auto-recoverable
            ;;
        BACKUP)
            # Check if backup exists and is valid
            local backup_path
            backup_path=$(jq -r '.backup_path // empty' "$STATE_FILE" 2>/dev/null)
            if [[ -n "$backup_path" && -d "$backup_path" ]]; then
                return 0  # Can auto-recover
            fi
            return 1  # Needs prompt
            ;;
        INSTALL)
            return 1  # Needs prompt - files may be partial
            ;;
        LINK|PROFILE)
            return 2  # Critical - may need manual intervention
            ;;
        *)
            return 2  # Unknown state is critical
            ;;
    esac
}

# ============================================
# ATOMIC OPERATIONS
# ============================================

# Atomic write: write to temp, then rename
# Args: target_file content
installer_atomic_write() {
    local target="$1"
    local content="$2"
    local temp_target="${target}.tmp.$$"
    local target_dir

    target_dir=$(dirname "$target")
    mkdir -p "$target_dir"

    # Write to temp file
    echo "$content" > "$temp_target" || {
        rm -f "$temp_target"
        return 1
    }

    # Preserve permissions if target exists
    if [[ -f "$target" ]]; then
        chmod --reference="$target" "$temp_target" 2>/dev/null || true
    fi

    # Sync to disk (if available)
    sync "$temp_target" 2>/dev/null || true

    # Atomic rename
    mv "$temp_target" "$target" || {
        rm -f "$temp_target"
        return 1
    }

    return 0
}

# Atomic file copy: source -> target with temp intermediate
# Args: source_file target_file
installer_atomic_copy() {
    local source="$1"
    local target="$2"
    local temp_target="${target}.tmp.$$"
    local target_dir

    target_dir=$(dirname "$target")
    mkdir -p "$target_dir"

    # Copy to temp location
    cp "$source" "$temp_target" || {
        rm -f "$temp_target"
        return 1
    }

    # Preserve permissions if target exists
    if [[ -f "$target" ]]; then
        chmod --reference="$target" "$temp_target" 2>/dev/null || true
    else
        chmod 644 "$temp_target"
    fi

    # Sync to disk
    sync "$temp_target" 2>/dev/null || true

    # Atomic rename
    mv "$temp_target" "$target" || {
        rm -f "$temp_target"
        return 1
    }

    return 0
}

# Atomic directory swap: staging_dir -> target_dir
# Creates backup of existing target before swap
# Args: source_dir target_dir
installer_atomic_swap() {
    local source_dir="$1"
    local target_dir="$2"
    local backup_dir="${target_dir}.bak.$$"

    # Backup existing target if present
    if [[ -d "$target_dir" ]]; then
        if ! mv "$target_dir" "$backup_dir"; then
            installer_log_error "Failed to backup existing directory: $target_dir"
            return $EXIT_BACKUP_FAILED
        fi
    fi

    # Atomic rename source to target
    if ! mv "$source_dir" "$target_dir"; then
        installer_log_error "Atomic swap failed"
        # Restore backup on failure
        if [[ -d "$backup_dir" ]]; then
            mv "$backup_dir" "$target_dir" || {
                installer_log_error "CRITICAL: Failed to restore backup"
                return $EXIT_ROLLBACK_FAILED
            }
        fi
        return $EXIT_INSTALL_FAILED
    fi

    # Success: remove backup
    [[ -d "$backup_dir" ]] && rm -rf "$backup_dir"

    return 0
}

# Create backup of existing installation
# Args: [source_dir]
# Sets: INSTALLER_BACKUP_PATH
installer_atomic_backup() {
    local source_dir="${1:-$INSTALL_DIR}"

    if [[ ! -d "$source_dir" ]]; then
        installer_log_debug "No existing installation to backup"
        return 0
    fi

    local backup_path="$BACKUPS_DIR/$(date +%Y%m%d%H%M%S)"
    mkdir -p "$backup_path"

    # Copy files excluding the .install-state directory to avoid copying into itself
    local failed=false
    while IFS= read -r -d '' item; do
        local basename
        basename=$(basename "$item")
        # Skip .install-state to avoid recursion
        if [[ "$basename" == ".install-state" ]]; then
            continue
        fi
        if ! cp -r "$item" "$backup_path/"; then
            failed=true
            break
        fi
    done < <(find "$source_dir" -mindepth 1 -maxdepth 1 -print0)

    if [[ "$failed" == "true" ]]; then
        installer_log_error "Failed to create backup: $backup_path"
        rm -rf "$backup_path"
        return $EXIT_BACKUP_FAILED
    fi

    INSTALLER_BACKUP_PATH="$backup_path"

    # Record backup path in state
    local temp_state="${STATE_FILE}.tmp.$$"
    jq --arg path "$backup_path" '.backup_path = $path' "$STATE_FILE" > "$temp_state"
    mv "$temp_state" "$STATE_FILE"

    installer_log_info "Backup created: $backup_path"
    return 0
}

# ============================================
# SIGNAL HANDLING
# ============================================

# Set up signal handlers for graceful interruption
installer_trap_setup() {
    trap 'installer_trap_handler SIGINT' INT
    trap 'installer_trap_handler SIGTERM' TERM
    trap 'installer_trap_handler SIGHUP' HUP
    trap 'installer_trap_exit' EXIT
}

# Signal handler - preserves state for recovery
# Args: signal_name
installer_trap_handler() {
    local signal="$1"

    installer_log_warn "Caught $signal"
    INSTALLER_INTERRUPTED=true

    # Save state for recovery
    installer_recover_save_state "interrupted"

    # Clean temp directory only (preserve state/backup)
    installer_cleanup_temp

    # Release lock
    installer_lock_release

    # Exit with signal-specific code
    case "$signal" in
        SIGINT)  exit 130 ;;  # 128 + 2
        SIGTERM) exit 143 ;;  # 128 + 15
        SIGHUP)  exit 129 ;;  # 128 + 1
        *)       exit 1 ;;
    esac
}

# Exit trap - cleanup on any exit
installer_trap_exit() {
    local exit_code=$?

    # Success: clean up state tracking
    if [[ $exit_code -eq 0 ]]; then
        installer_lock_release
        # Keep state file for audit trail
        return 0
    fi

    # Failure: preserve state for recovery
    if [[ "$INSTALLER_INTERRUPTED" != "true" ]]; then
        installer_log_error "Installation failed (exit code: $exit_code)"
        installer_recover_save_state "failed"
    fi

    # Release lock
    installer_lock_release

    # Clean temp only
    installer_cleanup_temp

    installer_log_info "State saved. Run 'install.sh --recover' to resume."
}

# Clean up temp directory only
installer_cleanup_temp() {
    local temp_dir
    temp_dir=$(jq -r '.temp_dir // empty' "$STATE_FILE" 2>/dev/null || echo "")

    if [[ -n "$temp_dir" && -d "$temp_dir" ]]; then
        rm -rf "$temp_dir"
        installer_log_debug "Cleaned temp directory: $temp_dir"
    fi

    # Also clean any leftover temp files (|| true to prevent set -e exit)
    if [[ -n "$INSTALLER_TEMP_DIR" && -d "$INSTALLER_TEMP_DIR" ]]; then
        rm -rf "$INSTALLER_TEMP_DIR"
    fi
    return 0
}

# ============================================
# RECOVERY
# ============================================

# Save current state for recovery
# Args: reason
installer_recover_save_state() {
    local reason="${1:-unknown}"

    [[ ! -f "$STATE_FILE" ]] && return 0

    local temp_state="${STATE_FILE}.tmp.$$"
    jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       --arg reason "$reason" \
       '.interrupted_at = $ts | .interrupt_reason = $reason' \
       "$STATE_FILE" > "$temp_state"
    mv "$temp_state" "$STATE_FILE"

    installer_log_debug "State saved: $(installer_state_get) ($reason)"
}

# Detect if there's an interrupted installation
# Returns: 0 if interrupted install found, 1 otherwise
installer_recover_detect() {
    [[ -f "$STATE_FILE" ]] || return 1

    local state
    state=$(installer_state_get)

    # COMPLETE state means no recovery needed
    [[ "$state" == "COMPLETE" ]] && return 1

    # Check if all states are complete
    for s in "${INSTALLER_STATES[@]}"; do
        if ! installer_state_is_complete "$s"; then
            return 0  # Found incomplete state
        fi
    done

    return 1  # All complete
}

# Automatic recovery for safe states
# Returns: 0 on success, 1 if manual intervention needed
installer_recover_auto() {
    [[ ! -f "$STATE_FILE" ]] && return 0

    local state
    state=$(installer_state_get)

    local recovery_level
    installer_state_can_recover "$state"
    recovery_level=$?

    case $recovery_level in
        0)
            # Auto-recoverable
            installer_log_info "Auto-recovering from state: $state"
            installer_cleanup_partial "temp"
            return 0
            ;;
        1)
            # Needs user prompt
            return 1
            ;;
        2)
            # Critical - needs special handling
            installer_log_error "Critical state detected: $state"
            installer_log_error "Manual intervention may be required"
            return 1
            ;;
    esac
}

# Prompt user for recovery action
# Args: context
installer_recover_prompt() {
    local context="$1"
    local state
    state=$(installer_state_get)

    installer_log_info "Detected interrupted installation at state: $state"

    case "$state" in
        INSTALL)
            echo ""
            echo "Installation was interrupted during file staging."
            echo ""
            echo "Options:"
            echo "  1) Resume - Continue from last checkpoint"
            echo "  2) Restart - Clean restart (removes staged files)"
            echo "  3) Rollback - Restore backup and abort"
            echo ""
            ;;
        LINK)
            echo ""
            echo "CRITICAL: Interrupted during atomic swap."
            echo "Your installation may be in an inconsistent state."
            local backup_path
            backup_path=$(jq -r '.backup_path // "none"' "$STATE_FILE")
            echo "Backup location: $backup_path"
            echo ""
            echo "Options:"
            echo "  1) Auto-restore - Attempt automatic restore from backup"
            echo "  2) Manual - Exit for manual inspection"
            echo ""
            ;;
        PROFILE)
            echo ""
            echo "Interrupted during shell configuration."
            echo "Shell profile may be partially modified."
            echo ""
            echo "Options:"
            echo "  1) Continue - Retry profile configuration"
            echo "  2) Restore - Restore shell profile from backup"
            echo "  3) Skip - Skip profile modification (manual PATH setup)"
            echo ""
            ;;
    esac
}

# Restore from backup
installer_recover_restore_backup() {
    local backup_path
    backup_path=$(jq -r '.backup_path // empty' "$STATE_FILE" 2>/dev/null)
    local install_dir
    install_dir=$(jq -r '.install_dir // empty' "$STATE_FILE" 2>/dev/null)
    install_dir="${install_dir:-$INSTALL_DIR}"

    if [[ -z "$backup_path" || ! -d "$backup_path" ]]; then
        installer_log_error "Backup not found: $backup_path"
        return $EXIT_ROLLBACK_FAILED
    fi

    installer_log_info "Restoring from backup: $backup_path"

    # Remove current installation if exists
    [[ -d "$install_dir" ]] && rm -rf "$install_dir"

    # Restore backup
    if ! cp -r "$backup_path" "$install_dir"; then
        installer_log_error "Failed to restore backup"
        return $EXIT_ROLLBACK_FAILED
    fi

    # Clear state
    installer_cleanup_partial "full"

    installer_log_info "Backup restored successfully"
    return 0
}

# Rotate old backups, keeping the most recent N
# Args: keep_count
installer_recover_rotate_backups() {
    local keep_count="${1:-5}"

    [[ ! -d "$BACKUPS_DIR" ]] && return 0

    local backup_count
    backup_count=$(find "$BACKUPS_DIR" -maxdepth 1 -type d -name "[0-9]*" | wc -l)

    if [[ $backup_count -gt $keep_count ]]; then
        local delete_count=$((backup_count - keep_count))
        # Delete oldest backups (sorted by name which is timestamp)
        find "$BACKUPS_DIR" -maxdepth 1 -type d -name "[0-9]*" | \
            sort | head -n "$delete_count" | \
            xargs rm -rf
        installer_log_debug "Rotated $delete_count old backups"
    fi
}

# Clean up partial installation state
# Args: level (temp|staged|full)
installer_cleanup_partial() {
    local level="${1:-full}"

    case "$level" in
        temp)
            # Remove only temp working files
            installer_cleanup_temp
            installer_lock_release
            ;;
        staged)
            # Remove staged files + temp
            installer_cleanup_partial "temp"
            local install_dir
            install_dir=$(jq -r '.install_dir // empty' "$STATE_FILE" 2>/dev/null)
            install_dir="${install_dir:-$INSTALL_DIR}"
            rm -rf "${install_dir}.staging."* 2>/dev/null || true
            rm -rf "${install_dir}.tmp."* 2>/dev/null || true
            ;;
        full)
            # Full cleanup including state
            installer_cleanup_partial "staged"
            rm -f "$STATE_FILE"
            rm -f "$MARKERS_DIR"/*.done 2>/dev/null || true
            ;;
    esac

    installer_log_debug "Cleanup complete (level: $level)"
}

# ============================================
# STATE MACHINE RUNNER
# ============================================

# Run the state machine from current state to completion
# Args: handler_prefix (function prefix for state handlers)
# State handlers should be named: ${prefix}_${state} (e.g., do_state_init)
installer_run_state_machine() {
    local handler_prefix="${1:-do_state}"

    for state in "${INSTALLER_STATES[@]}"; do
        # Skip completed states
        if installer_state_is_complete "$state"; then
            installer_log_debug "Skipping completed state: $state"
            continue
        fi

        # Transition to state
        installer_state_transition "$state"

        # Execute state handler
        local handler="${handler_prefix}_${state,,}"
        if declare -f "$handler" > /dev/null 2>&1; then
            installer_log_step "Executing: $state"
            if ! "$handler"; then
                installer_log_error "State $state failed"
                return 1
            fi
        else
            installer_log_debug "No handler for state: $state (skipping)"
        fi

        # Mark complete
        installer_state_mark_complete "$state"
    done

    return 0
}

# ============================================
# UTILITY FUNCTIONS
# ============================================

# Create a temp directory for installation staging
# Sets: INSTALLER_TEMP_DIR
installer_create_temp_dir() {
    INSTALLER_TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/cleo-install.XXXXXX")

    if [[ ! -d "$INSTALLER_TEMP_DIR" ]]; then
        installer_log_error "Failed to create temp directory"
        return 1
    fi

    # Record in state
    local temp_state="${STATE_FILE}.tmp.$$"
    jq --arg temp "$INSTALLER_TEMP_DIR" '.temp_dir = $temp' "$STATE_FILE" > "$temp_state"
    mv "$temp_state" "$STATE_FILE"

    installer_log_debug "Created temp directory: $INSTALLER_TEMP_DIR"
    return 0
}

# Get temp directory from state
installer_get_temp_dir() {
    if [[ -n "$INSTALLER_TEMP_DIR" ]]; then
        echo "$INSTALLER_TEMP_DIR"
    else
        jq -r '.temp_dir // empty' "$STATE_FILE" 2>/dev/null || true
    fi
    return 0
}

# Get backup path from state
installer_get_backup_path() {
    if [[ -n "$INSTALLER_BACKUP_PATH" ]]; then
        echo "$INSTALLER_BACKUP_PATH"
    else
        jq -r '.backup_path // empty' "$STATE_FILE" 2>/dev/null
    fi
}

# Print state machine status
installer_show_status() {
    [[ ! -f "$STATE_FILE" ]] && {
        echo "No installation state found."
        return 0
    }

    echo "Installation State:"
    echo "==================="
    jq -r '
        "Current state: \(.state)",
        "Previous state: \(.previous_state // "none")",
        "Started: \(.started_at)",
        "Last update: \(.timestamp)",
        "Version: \(.version)",
        "",
        "Completed: \(.completed | join(", "))",
        "Pending: \(.pending | join(", "))",
        "",
        "Temp dir: \(.temp_dir // "none")",
        "Backup path: \(.backup_path // "none")"
    ' "$STATE_FILE"

    if jq -e '.interrupted_at' "$STATE_FILE" > /dev/null 2>&1; then
        echo ""
        echo "** INTERRUPTED **"
        jq -r '"Interrupted at: \(.interrupted_at)", "Reason: \(.interrupt_reason)"' "$STATE_FILE"
    fi
}

# ============================================
# EXPORT PUBLIC API
# ============================================
# Locking
export -f installer_lock_acquire
export -f installer_lock_release
export -f installer_lock_check_stale

# State machine
export -f installer_state_init
export -f installer_state_get
export -f installer_state_set
export -f installer_state_transition
export -f installer_state_mark_complete
export -f installer_state_is_complete
export -f installer_state_can_recover
export -f installer_run_state_machine

# Atomic operations
export -f installer_atomic_write
export -f installer_atomic_copy
export -f installer_atomic_swap
export -f installer_atomic_backup

# Signal handling
export -f installer_trap_setup
export -f installer_trap_handler
export -f installer_trap_exit

# Recovery
export -f installer_recover_detect
export -f installer_recover_auto
export -f installer_recover_prompt
export -f installer_recover_restore_backup
export -f installer_recover_rotate_backups
export -f installer_recover_save_state
export -f installer_cleanup_partial
export -f installer_cleanup_temp

# Utilities
export -f installer_create_temp_dir
export -f installer_get_temp_dir
export -f installer_get_backup_path
export -f installer_show_status
export -f installer_ensure_dirs

# Logging
export -f installer_log_info
export -f installer_log_warn
export -f installer_log_error
export -f installer_log_debug
export -f installer_log_step
