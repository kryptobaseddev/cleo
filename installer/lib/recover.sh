#!/usr/bin/env bash
# CLEO Installer - Rollback and Cleanup
# Provides recovery from interrupted installations and rollback capabilities
#
# Version: 1.1.0
# Task: T1862 (Enhanced from T1860)
# Based on: claudedocs/research-outputs/2026-01-20_modular-installer-architecture.md
#           claudedocs/research-outputs/2026-01-20_rollback-mechanism-implementation.md
#
# LAYER: 2 (Operations)
# DEPENDENCIES: core.sh
# PROVIDES: installer_recover_from_state, installer_recover_rollback,
#           installer_recover_cleanup, installer_recover_reset,
#           installer_recover_interrupted, installer_recover_create_backup,
#           installer_recover_manual_rollback, installer_recover_manual_cleanup,
#           installer_recover_manual_reset

# ============================================
# GUARD: Prevent double-sourcing
# ============================================
[[ -n "${_INSTALLER_RECOVER_LOADED:-}" ]] && return 0
readonly _INSTALLER_RECOVER_LOADED=1

# ============================================
# DEPENDENCIES
# ============================================
INSTALLER_LIB_DIR="${INSTALLER_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
source "${INSTALLER_LIB_DIR}/core.sh"

# Optional: profile.sh for profile restoration
if [[ -f "${INSTALLER_LIB_DIR}/profile.sh" ]]; then
    source "${INSTALLER_LIB_DIR}/profile.sh"
fi

# Optional: link.sh for symlink cleanup
if [[ -f "${INSTALLER_LIB_DIR}/link.sh" ]]; then
    source "${INSTALLER_LIB_DIR}/link.sh"
fi

# ============================================
# CONSTANTS
# ============================================
readonly RECOVER_STATE_EXPIRY_HOURS="${CLEO_STATE_EXPIRY:-24}"

# Recovery action types
readonly RECOVER_ACTION_RESUME="resume"
readonly RECOVER_ACTION_RESTART="restart"
readonly RECOVER_ACTION_ROLLBACK="rollback"
readonly RECOVER_ACTION_ABORT="abort"

# ============================================
# STATE RECOVERY MATRIX
# ============================================
# Defines specific rollback actions per state
# Actions: cleanup_temp, remove_backup_marker, restore_backup,
#          restore_links, restore_profile, none
# Multiple actions separated by commas

# Declare associative array for state-specific recovery actions
declare -gA RECOVERY_ACTIONS
RECOVERY_ACTIONS=(
    [INIT]="cleanup_temp"
    [PREPARE]="cleanup_temp"
    [VALIDATE]="cleanup_temp"
    [BACKUP]="cleanup_temp,remove_backup_marker"
    [INSTALL]="restore_backup,cleanup_temp"
    [LINK]="restore_links,restore_backup,cleanup_temp"
    [PROFILE]="restore_profile,restore_links,restore_backup,cleanup_temp"
    [VERIFY]="restore_profile,restore_links,restore_backup,cleanup_temp"
    [CLEANUP]="none"
    [COMPLETE]="none"
)

# Recovery levels per state
# 0 = auto-recoverable (safe to cleanup and restart)
# 1 = needs user prompt (partial state, ask before action)
# 2 = critical (may need manual intervention)
declare -gA RECOVERY_LEVELS
RECOVERY_LEVELS=(
    [INIT]=0
    [PREPARE]=0
    [VALIDATE]=0
    [BACKUP]=1
    [INSTALL]=1
    [LINK]=2
    [PROFILE]=2
    [VERIFY]=0
    [CLEANUP]=0
    [COMPLETE]=0
)

# ============================================
# STATE DETECTION
# ============================================

# Check if there's an interrupted installation to recover
# Returns: 0 if recovery needed, 1 if not
installer_recover_needs_recovery() {
    installer_recover_detect
}

# Get details about the interrupted state
# Returns: JSON object with state details
installer_recover_get_state_info() {
    if [[ ! -f "$STATE_FILE" ]]; then
        echo '{"exists": false}'
        return 1
    fi

    # Validate JSON first
    if ! jq empty "$STATE_FILE" 2>/dev/null; then
        echo '{"exists": true, "state": "CORRUPTED", "error": "Invalid JSON in state file"}'
        return 1
    fi

    local state version started_at interrupted_at backup_path
    state=$(jq -r '.state // "UNKNOWN"' "$STATE_FILE" 2>/dev/null) || state="UNKNOWN"
    version=$(jq -r '.version // "unknown"' "$STATE_FILE" 2>/dev/null) || version="unknown"
    started_at=$(jq -r '.started_at // null' "$STATE_FILE" 2>/dev/null) || started_at="null"
    interrupted_at=$(jq -r '.interrupted_at // null' "$STATE_FILE" 2>/dev/null) || interrupted_at="null"
    backup_path=$(jq -r '.backup_path // null' "$STATE_FILE" 2>/dev/null) || backup_path="null"

    jq -n \
        --arg exists "true" \
        --arg state "$state" \
        --arg version "$version" \
        --arg started "$started_at" \
        --arg interrupted "$interrupted_at" \
        --arg backup "$backup_path" \
        '{
            exists: true,
            state: $state,
            version: $version,
            started_at: $started,
            interrupted_at: $interrupted,
            backup_path: $backup,
            has_backup: ($backup != "null" and $backup != "")
        }'
}

# Check if state file is stale (older than expiry threshold)
# Returns: 0 if stale, 1 if fresh
installer_recover_is_state_stale() {
    [[ ! -f "$STATE_FILE" ]] && return 0

    local started_at
    started_at=$(jq -r '.started_at // empty' "$STATE_FILE")

    if [[ -z "$started_at" ]]; then
        return 0  # No timestamp = stale
    fi

    # Calculate age in hours
    local start_epoch current_epoch age_hours

    if date -d "$started_at" +%s &>/dev/null; then
        start_epoch=$(date -d "$started_at" +%s)
    else
        start_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$started_at" +%s 2>/dev/null || echo 0)
    fi

    current_epoch=$(date +%s)
    age_hours=$(( (current_epoch - start_epoch) / 3600 ))

    if [[ $age_hours -ge $RECOVER_STATE_EXPIRY_HOURS ]]; then
        installer_log_debug "State file is stale (${age_hours}h old)"
        return 0
    fi

    return 1
}

# ============================================
# RECOVERY FROM STATE
# ============================================

# Recover from saved state
# Args: [action] (resume, restart, rollback)
# Returns: 0 on success, non-zero on failure
installer_recover_from_state() {
    local action="${1:-auto}"

    if [[ ! -f "$STATE_FILE" ]]; then
        installer_log_error "No state file found for recovery"
        return $EXIT_STATE_CORRUPT
    fi

    local state
    state=$(installer_state_get)

    installer_log_info "Recovering from state: $state"

    # Auto-determine action if not specified
    if [[ "$action" == "auto" ]]; then
        local recovery_level
        installer_state_can_recover "$state"
        recovery_level=$?

        case $recovery_level in
            0)  action="$RECOVER_ACTION_RESUME" ;;
            1)  action="$RECOVER_ACTION_RESUME" ;;  # User should have been prompted
            2)  action="$RECOVER_ACTION_ROLLBACK" ;;
        esac
    fi

    case "$action" in
        "$RECOVER_ACTION_RESUME")
            installer_recover_resume_from_state "$state"
            ;;
        "$RECOVER_ACTION_RESTART")
            installer_recover_restart
            ;;
        "$RECOVER_ACTION_ROLLBACK")
            installer_recover_rollback
            ;;
        "$RECOVER_ACTION_ABORT")
            installer_recover_cleanup "full"
            return 0
            ;;
        *)
            installer_log_error "Unknown recovery action: $action"
            return 1
            ;;
    esac
}

# Resume installation from a specific state
# Args: state
# Returns: 0 on success
installer_recover_resume_from_state() {
    local state="$1"

    installer_log_info "Resuming installation from: $state"

    # Clean up any partial state for current step
    case "$state" in
        INSTALL)
            # Remove partial staging
            local install_dir
            install_dir=$(jq -r '.install_dir // empty' "$STATE_FILE")
            rm -rf "${install_dir}.staging."* 2>/dev/null || true
            ;;
        LINK)
            # Links are atomic - nothing to clean
            ;;
        PROFILE)
            # Profile changes may need restoration
            declare -F installer_profile_restore &>/dev/null && {
                local config_file
                config_file=$(installer_profile_detect_config_file 2>/dev/null)
                installer_profile_restore "$config_file" 2>/dev/null || true
            }
            ;;
    esac

    # State machine will resume from next pending state
    return 0
}

# Restart installation from scratch
# Returns: 0 on success
installer_recover_restart() {
    installer_log_info "Restarting installation..."

    # Clean up all state
    installer_recover_cleanup "staged"

    # Re-initialize state
    local version source_dir install_dir
    version=$(jq -r '.version // "unknown"' "$STATE_FILE" 2>/dev/null)
    source_dir=$(jq -r '.source_dir // empty' "$STATE_FILE" 2>/dev/null)
    install_dir=$(jq -r '.install_dir // empty' "$STATE_FILE" 2>/dev/null)

    # Remove old state file
    rm -f "$STATE_FILE"
    rm -f "$MARKERS_DIR"/*.done 2>/dev/null || true

    # Re-initialize
    installer_state_init "$version" "$source_dir" "$install_dir"

    return 0
}

# ============================================
# ROLLBACK OPERATIONS
# ============================================

# Full rollback to pre-installation state
# Returns: 0 on success, EXIT_ROLLBACK_FAILED on failure
installer_recover_rollback() {
    installer_log_info "Starting rollback..."

    local backup_path
    backup_path=$(installer_get_backup_path)

    if [[ -z "$backup_path" || ! -d "$backup_path" ]]; then
        installer_log_error "No backup available for rollback"
        return $EXIT_ROLLBACK_FAILED
    fi

    local install_dir
    install_dir=$(jq -r '.install_dir // empty' "$STATE_FILE" 2>/dev/null)
    install_dir="${install_dir:-$INSTALL_DIR}"

    # Step 1: Restore installation directory
    if [[ -d "$install_dir" ]]; then
        local temp_current="${install_dir}.rollback.$$"
        mv "$install_dir" "$temp_current" || {
            installer_log_error "Failed to move current installation"
            return $EXIT_ROLLBACK_FAILED
        }

        if cp -r "$backup_path" "$install_dir"; then
            rm -rf "$temp_current"
            installer_log_info "Restored installation from backup"
        else
            # Restore failed - put back current
            mv "$temp_current" "$install_dir"
            installer_log_error "Rollback failed - original preserved"
            return $EXIT_ROLLBACK_FAILED
        fi
    else
        # No current installation - just restore backup
        cp -r "$backup_path" "$install_dir" || {
            installer_log_error "Failed to restore from backup"
            return $EXIT_ROLLBACK_FAILED
        }
    fi

    # Step 2: Restore shell profile
    if declare -F installer_profile_restore &>/dev/null; then
        local config_file
        config_file=$(installer_profile_detect_config_file 2>/dev/null)
        installer_profile_restore "$config_file" 2>/dev/null || true
    fi

    # Step 3: Restore symlinks
    if declare -F installer_link_setup_bin &>/dev/null; then
        installer_link_setup_bin "$install_dir" 2>/dev/null || true
    fi

    # Step 4: Clean up state
    installer_recover_cleanup "state"

    installer_log_info "Rollback complete"
    return 0
}

# Rollback to a specific state (partial rollback)
# Args: target_state
# Returns: 0 on success
installer_recover_rollback_to_state() {
    local target_state="$1"
    local current_state
    current_state=$(installer_state_get)

    installer_log_info "Rolling back from $current_state to $target_state"

    # Find position of target and current in state list
    local target_pos=-1 current_pos=-1 i=0

    for state in "${INSTALLER_STATES[@]}"; do
        [[ "$state" == "$target_state" ]] && target_pos=$i
        [[ "$state" == "$current_state" ]] && current_pos=$i
        ((i++))
    done

    if [[ $target_pos -lt 0 ]]; then
        installer_log_error "Unknown target state: $target_state"
        return 1
    fi

    # Rollback states from current to target (in reverse)
    for ((j = current_pos; j > target_pos; j--)); do
        local state="${INSTALLER_STATES[$j]}"
        installer_recover_rollback_state "$state"
    done

    # Update state file
    installer_state_transition "$target_state"

    return 0
}

# Rollback a single state's changes
# Args: state
installer_recover_rollback_state() {
    local state="$1"

    installer_log_debug "Rolling back state: $state"

    case "$state" in
        PROFILE)
            # Restore profile from backup
            declare -F installer_profile_restore &>/dev/null && {
                local config_file
                config_file=$(installer_profile_detect_config_file 2>/dev/null)
                installer_profile_restore "$config_file" || true
            }
            ;;
        LINK)
            # Remove symlinks
            declare -F installer_link_remove_bin &>/dev/null && {
                installer_link_remove_bin || true
            }
            ;;
        INSTALL)
            # Restore from backup
            installer_recover_restore_backup || true
            ;;
        BACKUP|VALIDATE|PREPARE|INIT)
            # These states don't have side effects to rollback
            ;;
    esac

    # Remove completion marker
    rm -f "$MARKERS_DIR/${state}.done" 2>/dev/null || true
}

# ============================================
# CLEANUP OPERATIONS
# ============================================

# Clean up installation artifacts
# Args: level (temp|staged|state|full)
# Returns: 0 on success
installer_recover_cleanup() {
    local level="${1:-full}"

    installer_log_debug "Cleanup level: $level"

    case "$level" in
        temp)
            # Remove only temp files
            installer_cleanup_temp
            ;;
        staged)
            # Remove temp + staged files
            installer_cleanup_partial "staged"
            ;;
        state)
            # Remove state tracking files (markers, state.json)
            rm -f "$STATE_FILE" 2>/dev/null || true
            rm -f "$MARKERS_DIR"/*.done 2>/dev/null || true
            ;;
        full)
            # Complete cleanup
            installer_cleanup_partial "full"
            ;;
    esac

    return 0
}

# Clean temporary installation files
# Returns: 0 on success
installer_recover_cleanup_temp() {
    local temp_dir
    temp_dir=$(installer_get_temp_dir 2>/dev/null) || true

    if [[ -n "$temp_dir" && -d "$temp_dir" ]]; then
        rm -rf "$temp_dir"
        installer_log_debug "Removed temp directory: $temp_dir"
    fi

    # Get install_dir from state file, fallback to INSTALL_DIR constant
    local install_dir
    install_dir=$(jq -r '.install_dir // empty' "$STATE_FILE" 2>/dev/null) || true
    install_dir="${install_dir:-$INSTALL_DIR}"

    # Clean any orphaned temp files
    rm -rf "${install_dir}.staging."* 2>/dev/null || true
    rm -rf "${install_dir}.tmp."* 2>/dev/null || true

    return 0
}

# ============================================
# RESET OPERATIONS
# ============================================

# Reset to clean state (remove all CLEO installation)
# Args: [confirm] (pass "confirm" to skip prompt)
# Returns: 0 on success
installer_recover_reset() {
    local confirm="${1:-}"

    if [[ "$confirm" != "confirm" ]]; then
        installer_log_error "Reset requires confirmation. Pass 'confirm' as argument."
        return 1
    fi

    installer_log_warn "Resetting CLEO installation..."

    # Step 1: Remove symlinks
    if declare -F installer_link_remove_bin &>/dev/null; then
        installer_link_remove_bin
    fi

    if declare -F installer_link_remove_skills &>/dev/null; then
        installer_link_remove_skills
    fi

    # Step 2: Remove profile modifications
    if declare -F installer_profile_remove &>/dev/null; then
        local config_file
        config_file=$(installer_profile_detect_config_file 2>/dev/null)
        installer_profile_remove "$config_file"
    fi

    # Step 3: Remove installation state
    rm -rf "$STATE_DIR" 2>/dev/null || true

    # Step 4: Remove installation directory (user must do this manually for safety)
    installer_log_warn "Installation directory NOT removed: $INSTALL_DIR"
    installer_log_warn "Remove manually if desired: rm -rf $INSTALL_DIR"

    installer_log_info "Reset complete"
    return 0
}

# ============================================
# ENHANCED BACKUP MANAGEMENT
# ============================================

# Create a comprehensive backup of the current installation
# Records backup location in state file and creates metadata
# Args: [backup_type] (default: "snapshot")
# Returns: 0 on success, EXIT_BACKUP_FAILED on failure
installer_recover_create_backup() {
    local backup_type="${1:-snapshot}"
    local backup_dir="$BACKUPS_DIR/$(date +%Y%m%d_%H%M%S)_${backup_type}"

    mkdir -p "$backup_dir" || {
        installer_log_error "Failed to create backup directory: $backup_dir"
        return $EXIT_BACKUP_FAILED
    }

    installer_log_info "Creating backup: $backup_dir"

    # Backup critical files if they exist
    if [[ -d "$INSTALL_DIR" ]]; then
        cp -a "$INSTALL_DIR/VERSION" "$backup_dir/" 2>/dev/null || true
        cp -a "$INSTALL_DIR/scripts" "$backup_dir/" 2>/dev/null || true
        cp -a "$INSTALL_DIR/lib" "$backup_dir/" 2>/dev/null || true
        cp -a "$INSTALL_DIR/schemas" "$backup_dir/" 2>/dev/null || true
        cp -a "$INSTALL_DIR/templates" "$backup_dir/" 2>/dev/null || true
        cp -a "$INSTALL_DIR/skills" "$backup_dir/" 2>/dev/null || true
        cp -a "$INSTALL_DIR/cleo" "$backup_dir/" 2>/dev/null || true
    fi

    # Create backup metadata
    local metadata_file="$backup_dir/.backup_meta.json"
    jq -n \
        --arg type "$backup_type" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg version "$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo 'unknown')" \
        --arg state "$(installer_state_get 2>/dev/null || echo 'unknown')" \
        '{
            type: $type,
            created_at: $ts,
            version: $version,
            state_at_backup: $state,
            install_dir: "'"$INSTALL_DIR"'"
        }' > "$metadata_file"

    # Record backup location in state file
    if [[ -f "$STATE_FILE" ]]; then
        local temp_state="${STATE_FILE}.tmp.$$"
        jq --arg path "$backup_dir" '.backup_path = $path' "$STATE_FILE" > "$temp_state"
        mv "$temp_state" "$STATE_FILE"
    fi

    # Write marker for current backup
    echo "$backup_dir" > "$STATE_DIR/current_backup"

    installer_log_info "Backup complete: $backup_dir"
    return 0
}

# Restore from the current backup marker
# Returns: 0 on success, EXIT_BACKUP_FAILED if no backup or restore fails
installer_recover_restore_current_backup() {
    local backup_dir

    # First try the marker file
    if [[ -f "$STATE_DIR/current_backup" ]]; then
        backup_dir=$(cat "$STATE_DIR/current_backup" 2>/dev/null)
    fi

    # Fallback to state file
    if [[ -z "$backup_dir" || ! -d "$backup_dir" ]]; then
        backup_dir=$(jq -r '.backup_path // empty' "$STATE_FILE" 2>/dev/null)
    fi

    if [[ -z "$backup_dir" || ! -d "$backup_dir" ]]; then
        installer_log_error "No valid backup found for restoration"
        return $EXIT_BACKUP_FAILED
    fi

    installer_log_info "Restoring from backup: $backup_dir"

    # Verify backup integrity
    if [[ ! -f "$backup_dir/.backup_meta.json" ]]; then
        installer_log_warn "Backup metadata missing - proceeding with caution"
    fi

    # Copy backup to a safe location FIRST (before moving $INSTALL_DIR which may contain it)
    local temp_backup="${TMPDIR:-/tmp}/cleo-restore-backup.$$"
    if ! cp -a "$backup_dir" "$temp_backup"; then
        installer_log_error "Failed to copy backup to temporary location"
        return $EXIT_BACKUP_FAILED
    fi

    # Remove current installation if exists
    if [[ -d "$INSTALL_DIR" ]]; then
        local temp_current="${INSTALL_DIR}.restore_temp.$$"
        mv "$INSTALL_DIR" "$temp_current" || {
            installer_log_error "Failed to move current installation for restoration"
            rm -rf "$temp_backup"
            return $EXIT_BACKUP_FAILED
        }

        # Restore from the temporary backup copy
        if cp -a "$temp_backup" "$INSTALL_DIR"; then
            # Remove the temp copies on success
            rm -rf "$temp_current"
            rm -rf "$temp_backup"
            installer_log_info "Restored installation from backup"
        else
            # Restore failed - put back current
            mv "$temp_current" "$INSTALL_DIR"
            rm -rf "$temp_backup"
            installer_log_error "Restore failed - original preserved"
            return $EXIT_BACKUP_FAILED
        fi
    else
        # No current installation - just copy from temp backup
        if cp -a "$temp_backup" "$INSTALL_DIR"; then
            rm -rf "$temp_backup"
        else
            rm -rf "$temp_backup"
            installer_log_error "Failed to restore from backup"
            return $EXIT_BACKUP_FAILED
        fi
    fi

    return 0
}

# ============================================
# INTERRUPTED INSTALL RECOVERY
# ============================================

# Handle recovery from an interrupted installation
# Uses state-based recovery matrix to determine actions
# Returns: 0 on success, appropriate exit code on failure
installer_recover_interrupted() {
    local state
    state=$(installer_state_get)

    installer_log_info "Recovering from interrupted state: $state"

    # Get recovery level for this state
    local recovery_level="${RECOVERY_LEVELS[$state]:-2}"

    case "$recovery_level" in
        0)
            # Auto-recoverable: safe to cleanup and restart
            installer_log_info "State $state is auto-recoverable"
            installer_recover_cleanup_temp
            return 0
            ;;
        1)
            # Needs user prompt
            installer_log_warn "Installation interrupted during $state"
            if installer_recover_prompt_restore; then
                installer_recover_execute_recovery_actions "$state"
            else
                installer_log_info "Recovery cancelled by user"
                return $EXIT_INTERRUPTED
            fi
            ;;
        2)
            # Critical - may need manual intervention
            installer_log_warn "CRITICAL: Installation interrupted during $state"
            installer_log_warn "Your installation may be in an inconsistent state."
            installer_recover_prompt_action
            ;;
    esac

    return 0
}

# Prompt user whether to restore from backup
# Returns: 0 if user confirms, 1 if user declines
installer_recover_prompt_restore() {
    local backup_path
    backup_path=$(cat "$STATE_DIR/current_backup" 2>/dev/null)

    if [[ -z "$backup_path" || ! -d "$backup_path" ]]; then
        backup_path=$(jq -r '.backup_path // "none"' "$STATE_FILE" 2>/dev/null)
    fi

    echo ""
    echo "A backup is available: $backup_path"
    echo ""
    echo "Would you like to restore from this backup? [y/N]"

    local response
    read -r response
    [[ "$response" =~ ^[Yy] ]]
}

# Prompt user for recovery action on critical state
# Returns: selected action (0=restore, 1=manual, 2=abort)
installer_recover_prompt_action() {
    local state
    state=$(installer_state_get)
    local backup_path
    backup_path=$(cat "$STATE_DIR/current_backup" 2>/dev/null)
    backup_path="${backup_path:-$(jq -r '.backup_path // "none"' "$STATE_FILE" 2>/dev/null)}"

    echo ""
    echo "Installation was interrupted during: $state"
    echo "Backup location: $backup_path"
    echo ""
    echo "Recovery options:"
    echo "  1) Auto-restore - Attempt automatic restore from backup"
    echo "  2) Continue - Try to resume from current state"
    echo "  3) Cleanup - Cleanup temp files and exit for manual inspection"
    echo "  4) Abort - Exit without changes"
    echo ""
    echo -n "Select option [1-4]: "

    local choice
    read -r choice

    case "$choice" in
        1)
            installer_log_info "Attempting auto-restore..."
            installer_recover_restore_current_backup
            ;;
        2)
            installer_log_info "Attempting to continue from state: $state"
            # Mark current state for retry
            rm -f "$MARKERS_DIR/${state}.done" 2>/dev/null || true
            return 0
            ;;
        3)
            installer_log_info "Cleaning up temp files..."
            installer_recover_cleanup "temp"
            installer_log_warn "Manual inspection recommended"
            installer_log_warn "Run with --recover to retry, or --rollback to restore backup"
            exit $EXIT_INTERRUPTED
            ;;
        4|*)
            installer_log_info "Aborting recovery"
            exit $EXIT_INTERRUPTED
            ;;
    esac
}

# Execute recovery actions for a specific state
# Args: state
# Returns: 0 on success
installer_recover_execute_recovery_actions() {
    local state="$1"
    local actions="${RECOVERY_ACTIONS[$state]:-none}"

    if [[ "$actions" == "none" ]]; then
        installer_log_debug "No recovery actions needed for state: $state"
        return 0
    fi

    installer_log_info "Executing recovery actions for state: $state"

    # Split actions by comma and execute each
    IFS=',' read -ra action_list <<< "$actions"
    for action in "${action_list[@]}"; do
        action=$(echo "$action" | xargs)  # Trim whitespace
        installer_log_debug "Executing recovery action: $action"

        case "$action" in
            cleanup_temp)
                installer_recover_cleanup_temp
                ;;
            remove_backup_marker)
                rm -f "$STATE_DIR/current_backup" 2>/dev/null || true
                ;;
            restore_backup)
                installer_recover_restore_current_backup || true
                ;;
            restore_links)
                # Re-run link setup if function available
                if declare -F installer_link_setup_bin &>/dev/null; then
                    installer_link_setup_bin "$INSTALL_DIR" 2>/dev/null || true
                fi
                ;;
            restore_profile)
                # Restore profile from backup if function available
                if declare -F installer_profile_restore &>/dev/null; then
                    local config_file
                    config_file=$(installer_profile_detect_config_file 2>/dev/null)
                    installer_profile_restore "$config_file" 2>/dev/null || true
                fi
                ;;
            *)
                installer_log_warn "Unknown recovery action: $action"
                ;;
        esac
    done

    return 0
}

# ============================================
# MANUAL RECOVERY COMMANDS
# ============================================

# Manual full rollback to last known good state
# Restores from backup and cleans all installation state
# Args: [confirm] (pass "confirm" to skip prompt)
# Returns: 0 on success, EXIT_ROLLBACK_FAILED on failure
installer_recover_manual_rollback() {
    local confirm="${1:-}"

    if [[ "$confirm" != "confirm" && "$confirm" != "-y" ]]; then
        echo ""
        echo "This will roll back to the last backup and remove current installation."
        echo ""
        echo -n "Are you sure you want to proceed? [y/N]: "
        local response
        read -r response
        if [[ ! "$response" =~ ^[Yy] ]]; then
            installer_log_info "Rollback cancelled"
            return 0
        fi
    fi

    installer_log_info "Starting manual rollback..."

    # Restore from backup
    if ! installer_recover_restore_current_backup; then
        installer_log_error "Rollback failed - backup restoration failed"
        return $EXIT_ROLLBACK_FAILED
    fi

    # Restore symlinks
    if declare -F installer_link_setup_bin &>/dev/null; then
        installer_link_setup_bin "$INSTALL_DIR" || true
    fi

    # Restore profile
    if declare -F installer_profile_restore &>/dev/null; then
        local config_file
        config_file=$(installer_profile_detect_config_file 2>/dev/null)
        installer_profile_restore "$config_file" 2>/dev/null || true
    fi

    # Clean up state
    installer_recover_cleanup "state"

    installer_log_info "Manual rollback complete"
    return 0
}

# Manual cleanup of all temporary and staged files
# Preserves backups and state for debugging
# Args: [level] (temp|staged|full)
# Returns: 0 on success
installer_recover_manual_cleanup() {
    local level="${1:-staged}"

    installer_log_info "Manual cleanup starting (level: $level)..."

    case "$level" in
        temp)
            # Remove only temp working files
            installer_recover_cleanup_temp
            ;;
        staged)
            # Remove temp + any staging directories
            installer_recover_cleanup_temp
            rm -rf "${INSTALL_DIR}.staging."* 2>/dev/null || true
            rm -rf "${INSTALL_DIR}.tmp."* 2>/dev/null || true
            rm -rf "${INSTALL_DIR}.rollback."* 2>/dev/null || true
            rm -rf "${INSTALL_DIR}.restore_temp."* 2>/dev/null || true
            ;;
        full)
            # Full cleanup including state markers (but not backups)
            installer_recover_manual_cleanup "staged"
            rm -f "$MARKERS_DIR"/*.done 2>/dev/null || true
            rm -f "$STATE_FILE" 2>/dev/null || true
            rm -f "$STATE_DIR/current_backup" 2>/dev/null || true
            ;;
        *)
            installer_log_warn "Unknown cleanup level: $level. Using 'staged'"
            installer_recover_manual_cleanup "staged"
            ;;
    esac

    installer_log_info "Manual cleanup complete"
    return 0
}

# Manual complete reset to pre-install state
# Removes ALL CLEO installation artifacts
# Args: [confirm] (pass "confirm" to skip prompt)
# Returns: 0 on success
installer_recover_manual_reset() {
    local confirm="${1:-}"

    if [[ "$confirm" != "confirm" && "$confirm" != "-y" ]]; then
        echo ""
        echo "WARNING: This will completely remove CLEO installation including:"
        echo "  - All symlinks (cleo, ct commands)"
        echo "  - Shell profile modifications"
        echo "  - Installation state and markers"
        echo "  - All backups"
        echo ""
        echo "The installation directory ($INSTALL_DIR) will NOT be removed."
        echo ""
        echo -n "Are you absolutely sure? Type 'yes' to confirm: "
        local response
        read -r response
        if [[ "$response" != "yes" ]]; then
            installer_log_info "Reset cancelled"
            return 0
        fi
    fi

    installer_log_warn "Starting complete reset..."

    # Step 1: Remove symlinks
    if declare -F installer_link_remove_bin &>/dev/null; then
        installer_link_remove_bin
    fi
    if declare -F installer_link_remove_skills &>/dev/null; then
        installer_link_remove_skills
    fi

    # Step 2: Remove profile modifications
    if declare -F installer_profile_remove &>/dev/null; then
        local config_file
        config_file=$(installer_profile_detect_config_file 2>/dev/null)
        installer_profile_remove "$config_file" || true
    fi

    # Step 3: Remove all state (including backups)
    rm -rf "$STATE_DIR" 2>/dev/null || true

    # Step 4: Installation directory warning
    installer_log_warn ""
    installer_log_warn "=========================================="
    installer_log_warn "  Installation directory NOT removed:"
    installer_log_warn "  $INSTALL_DIR"
    installer_log_warn ""
    installer_log_warn "  Remove manually if desired:"
    installer_log_warn "  rm -rf $INSTALL_DIR"
    installer_log_warn "=========================================="

    installer_log_info "Reset complete"
    return 0
}

# ============================================
# BACKUP MANAGEMENT (Legacy/List Functions)
# ============================================

# Get list of available backups
# Returns: JSON array of backup info
installer_recover_list_backups() {
    if [[ ! -d "$BACKUPS_DIR" ]]; then
        echo "[]"
        return 0
    fi

    local backups=()

    while IFS= read -r -d '' backup_dir; do
        local name timestamp size
        name=$(basename "$backup_dir")
        timestamp="${name:0:4}-${name:4:2}-${name:6:2} ${name:8:2}:${name:10:2}:${name:12:2}"
        size=$(du -sh "$backup_dir" 2>/dev/null | cut -f1)

        backups+=("{\"name\":\"$name\",\"timestamp\":\"$timestamp\",\"size\":\"$size\",\"path\":\"$backup_dir\"}")
    done < <(find "$BACKUPS_DIR" -maxdepth 1 -type d -name "[0-9]*" -print0 | sort -z)

    local json_array="["
    local first=true
    for b in "${backups[@]}"; do
        [[ "$first" != "true" ]] && json_array+=","
        json_array+="$b"
        first=false
    done
    json_array+="]"

    echo "$json_array"
}

# Restore from a specific backup
# Args: backup_name_or_path
# Returns: 0 on success
installer_recover_restore_from() {
    local backup="$1"
    local backup_path

    # Resolve backup path
    if [[ -d "$backup" ]]; then
        backup_path="$backup"
    elif [[ -d "$BACKUPS_DIR/$backup" ]]; then
        backup_path="$BACKUPS_DIR/$backup"
    else
        installer_log_error "Backup not found: $backup"
        return $EXIT_ROLLBACK_FAILED
    fi

    # Update state with new backup path and perform rollback
    local temp_state="${STATE_FILE}.tmp.$$"
    jq --arg path "$backup_path" '.backup_path = $path' "$STATE_FILE" > "$temp_state"
    mv "$temp_state" "$STATE_FILE"

    installer_recover_rollback
}

# ============================================
# EXPORT PUBLIC API
# ============================================

# State detection
export -f installer_recover_needs_recovery
export -f installer_recover_get_state_info
export -f installer_recover_is_state_stale

# Recovery from state
export -f installer_recover_from_state
export -f installer_recover_resume_from_state
export -f installer_recover_restart

# Rollback operations
export -f installer_recover_rollback
export -f installer_recover_rollback_to_state
export -f installer_recover_rollback_state

# Cleanup operations
export -f installer_recover_cleanup
export -f installer_recover_cleanup_temp
export -f installer_recover_reset

# Enhanced backup management (T1862)
export -f installer_recover_create_backup
export -f installer_recover_restore_current_backup
export -f installer_recover_list_backups
export -f installer_recover_restore_from

# Interrupted install recovery (T1862)
export -f installer_recover_interrupted
export -f installer_recover_prompt_restore
export -f installer_recover_prompt_action
export -f installer_recover_execute_recovery_actions

# Manual recovery commands (T1862)
export -f installer_recover_manual_rollback
export -f installer_recover_manual_cleanup
export -f installer_recover_manual_reset
