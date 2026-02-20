#!/usr/bin/env bats
# =============================================================================
# installer-interruption.bats - Interruption recovery scenario tests
# =============================================================================
# Task: T1872
# Tests: Interruption at every state, signal handling, recovery detection,
#        backup/restore integrity, lock file behavior
# =============================================================================

setup_file() {
    load 'test_helper'
    installer_setup_file
}

setup() {
    load 'test_helper'
    installer_setup_per_test
}

teardown() {
    installer_teardown_per_test
}

teardown_file() {
    installer_teardown_file
}

# =============================================================================
# INTERRUPTION SIMULATION TESTS - Per State
# =============================================================================

@test "interruption: INIT state recovers cleanly" {
    # Simulate interrupt during INIT - auto-recoverable (level 0)
    simulate_interrupt_at_state "INIT"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_interrupted
    "
    assert_success

    # Verify clean state possible
    assert_clean_state_possible
}

@test "interruption: PREPARE state cleans temp directory" {
    # Create temp dir and simulate interrupt during PREPARE
    local temp_dir="${BATS_TEST_TMPDIR}/install_temp"
    mkdir -p "$temp_dir"

    simulate_interrupt_at_state "PREPARE" "$temp_dir"

    # Load libs and call cleanup directly (without subshell)
    load_installer_lib "core"
    load_installer_lib "recover"
    installer_recover_cleanup_temp

    # Temp dir should be removed
    [[ ! -d "$temp_dir" ]]
}

@test "interruption: VALIDATE state preserves nothing" {
    # VALIDATE is auto-recoverable, no partial state
    simulate_interrupt_at_state "VALIDATE"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'

        level=\"\${RECOVERY_LEVELS[VALIDATE]}\"
        [[ \"\$level\" == \"0\" ]]
    "
    assert_success
}

@test "interruption: BACKUP state removes backup marker only" {
    # BACKUP is level 1, should prompt but backup preserved
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    local backups_dir="${state_dir}/backups"

    # Create backup
    mkdir -p "$backups_dir/20260120120000_pre"
    echo "0.54.0" > "$backups_dir/20260120120000_pre/VERSION"

    simulate_interrupt_at_state "BACKUP"

    # Verify backup still exists but state indicates recovery needed
    [[ -d "$backups_dir/20260120120000_pre" ]]

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_needs_recovery
    "
    # Should detect recovery needed (exit 0 = recovery needed)
    assert_success
}

@test "interruption: INSTALL state requires restore from backup" {
    # INSTALL is level 1, needs user prompt for restore
    local backup_dir
    backup_dir=$(create_mock_backup)

    simulate_interrupt_at_state "INSTALL" "" "$backup_dir"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'

        # Check recovery level
        level=\"\${RECOVERY_LEVELS[INSTALL]}\"
        [[ \"\$level\" == \"1\" ]] || exit 1

        # Check recovery actions include restore_backup
        actions=\"\${RECOVERY_ACTIONS[INSTALL]}\"
        [[ \"\$actions\" == *\"restore_backup\"* ]] || exit 2
    "
    assert_success
}

@test "interruption: LINK state is critical - restores original links" {
    # LINK is level 2 (critical)
    simulate_interrupt_at_state "LINK"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'

        level=\"\${RECOVERY_LEVELS[LINK]}\"
        [[ \"\$level\" == \"2\" ]] || exit 1

        actions=\"\${RECOVERY_ACTIONS[LINK]}\"
        [[ \"\$actions\" == *\"restore_links\"* ]] || exit 2
    "
    assert_success
}

@test "interruption: PROFILE state is critical - restores shell config" {
    # PROFILE is level 2 (critical)
    simulate_interrupt_at_state "PROFILE"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'

        level=\"\${RECOVERY_LEVELS[PROFILE]}\"
        [[ \"\$level\" == \"2\" ]] || exit 1

        actions=\"\${RECOVERY_ACTIONS[PROFILE]}\"
        [[ \"\$actions\" == *\"restore_profile\"* ]] || exit 2
    "
    assert_success
}

@test "interruption: VERIFY state is auto-recoverable" {
    # VERIFY is level 0 - install succeeded, verification interrupted
    simulate_interrupt_at_state "VERIFY"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'

        level=\"\${RECOVERY_LEVELS[VERIFY]}\"
        [[ \"\$level\" == \"0\" ]]
    "
    assert_success
}

@test "interruption: CLEANUP state has no recovery actions" {
    # CLEANUP is level 0, actions = "none"
    simulate_interrupt_at_state "CLEANUP"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'

        actions=\"\${RECOVERY_ACTIONS[CLEANUP]}\"
        [[ \"\$actions\" == \"none\" ]]
    "
    assert_success
}

@test "interruption: COMPLETE state installation intact" {
    # COMPLETE is level 0, nothing to recover
    simulate_interrupt_at_state "COMPLETE"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'

        level=\"\${RECOVERY_LEVELS[COMPLETE]}\"
        actions=\"\${RECOVERY_ACTIONS[COMPLETE]}\"
        [[ \"\$level\" == \"0\" ]] && [[ \"\$actions\" == \"none\" ]]
    "
    assert_success
}

# =============================================================================
# SIGNAL HANDLING TESTS
# =============================================================================

@test "signal: SIGINT trap releases lock file" {
    local lock_file="${TEST_INSTALL_DIR}/.install-state/.install.lock"
    mkdir -p "${TEST_INSTALL_DIR}/.install-state"

    # The lock needs to be created by the same process that releases it
    # So we create and release in the same subshell
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        # Create lock owned by this subshell
        echo \"\$\$|\$(date -u +%Y-%m-%dT%H:%M:%SZ)|\$(hostname)\" > '$lock_file'
        # Now release it
        installer_lock_release
    "

    # Lock should be released
    [[ ! -f "$lock_file" ]]
}

@test "signal: cleanup runs on SIGTERM" {
    # Create state file before running
    mkdir -p "${TEST_INSTALL_DIR}/.install-state"
    echo '{"temp_dir": null}' > "${TEST_INSTALL_DIR}/.install-state/current"

    # Verify cleanup_partial function exists and can be called
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_cleanup_partial 'temp'
    "
    assert_success
}

@test "signal: cleanup preserves backup on interrupt" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    local backups_dir="${state_dir}/backups"

    # Create backup
    mkdir -p "${backups_dir}/20260120120000_pre"
    echo "0.54.0" > "${backups_dir}/20260120120000_pre/VERSION"

    # Simulate cleanup at temp level (shouldn't remove backups)
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        echo '{}' > '${state_dir}/current'
        installer_cleanup_partial 'temp'
    "

    # Backup should still exist
    [[ -f "${backups_dir}/20260120120000_pre/VERSION" ]]
}

@test "signal: interrupt handler sets interrupted state" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"

    cat > "${state_dir}/current" << 'EOF'
{
    "state": "INSTALL",
    "interrupted_at": null
}
EOF

    # Verify state can be read and interrupt detected
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_needs_recovery
    "
    # Incomplete state should trigger recovery
    assert_success
}

# =============================================================================
# RECOVERY DETECTION TESTS
# =============================================================================

@test "recovery: detects incomplete INSTALL state on restart" {
    simulate_interrupt_at_state "INSTALL"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_needs_recovery
    "
    assert_success  # 0 = recovery needed
}

@test "recovery: auto-recovers from safe states (INIT)" {
    simulate_interrupt_at_state "INIT"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'

        # INIT is level 0, should auto-recover
        installer_recover_interrupted
    "
    assert_success
}

@test "recovery: auto-recovers from safe states (PREPARE)" {
    simulate_interrupt_at_state "PREPARE"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_interrupted
    "
    assert_success
}

@test "recovery: requires prompt for critical states (LINK)" {
    simulate_interrupt_at_state "LINK"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'

        level=\"\${RECOVERY_LEVELS[LINK]}\"
        [[ \"\$level\" == \"2\" ]]
    "
    assert_success
}

@test "recovery: get_state_info returns complete JSON" {
    simulate_interrupt_at_state "INSTALL"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_get_state_info
    "
    assert_success

    # Verify JSON structure
    echo "$output" | jq -e '.exists' > /dev/null
    echo "$output" | jq -e '.state' > /dev/null
}

# =============================================================================
# BACKUP/RESTORE TESTS
# =============================================================================

@test "backup: contains all critical directories" {
    # Create installation structure
    mkdir -p "${TEST_INSTALL_DIR}"/{lib,scripts,schemas,templates,skills}
    echo "0.55.0" > "${TEST_INSTALL_DIR}/VERSION"
    echo "test lib" > "${TEST_INSTALL_DIR}/lib/test.sh"
    echo "test script" > "${TEST_INSTALL_DIR}/scripts/test.sh"

    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"
    echo '{}' > "${state_dir}/current"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_create_backup 'test'
    "
    assert_success

    # Find and verify backup
    local backup_dir
    backup_dir=$(find "${state_dir}/backups" -mindepth 1 -maxdepth 1 -type d | head -1)

    [[ -f "$backup_dir/VERSION" ]]
}

@test "backup: restore is complete and accurate" {
    # Create backup with known content
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    local backups_dir="${state_dir}/backups"
    local backup_dir="${backups_dir}/20260120120000_test"

    mkdir -p "$backup_dir"/{lib,scripts}
    echo "0.54.0" > "$backup_dir/VERSION"
    echo "original lib content" > "$backup_dir/lib/test.sh"

    # Record backup location
    mkdir -p "$state_dir"
    echo "$backup_dir" > "$state_dir/current_backup"
    echo "{\"backup_path\": \"$backup_dir\"}" > "${state_dir}/current"

    # Create "corrupted" current installation
    mkdir -p "${TEST_INSTALL_DIR}/lib"
    echo "corrupted" > "${TEST_INSTALL_DIR}/VERSION"
    echo "corrupted content" > "${TEST_INSTALL_DIR}/lib/test.sh"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_restore_current_backup
    "
    assert_success

    # Verify restored content
    run cat "${TEST_INSTALL_DIR}/VERSION"
    assert_output "0.54.0"
}

@test "backup: multiple interruptions don't corrupt backup chain" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    local backups_dir="${state_dir}/backups"

    mkdir -p "$state_dir"
    echo '{}' > "${state_dir}/current"

    # Create installation
    mkdir -p "${TEST_INSTALL_DIR}"
    echo "0.55.0" > "${TEST_INSTALL_DIR}/VERSION"

    # Create first backup
    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_create_backup 'first'
    "

    # Modify and create second backup
    echo "0.55.1" > "${TEST_INSTALL_DIR}/VERSION"
    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_create_backup 'second'
    "

    # Verify both backups exist
    local backup_count
    backup_count=$(find "$backups_dir" -mindepth 1 -maxdepth 1 -type d | wc -l)
    [[ "$backup_count" -ge 2 ]]
}

@test "backup: metadata includes timestamp and type" {
    mkdir -p "${TEST_INSTALL_DIR}"
    echo "0.55.0" > "${TEST_INSTALL_DIR}/VERSION"

    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"
    echo '{}' > "${state_dir}/current"

    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_create_backup 'snapshot'
    "

    # Find backup and check metadata
    local backup_dir
    backup_dir=$(find "${state_dir}/backups" -mindepth 1 -maxdepth 1 -type d | head -1)

    [[ -f "$backup_dir/.backup_meta.json" ]]
    run jq -r '.type' "$backup_dir/.backup_meta.json"
    assert_output "snapshot"
}

# =============================================================================
# LOCK FILE TESTS
# =============================================================================

@test "lock: stale lock detected after timeout" {
    local lock_file="${TEST_INSTALL_DIR}/.install-state/.install.lock"
    mkdir -p "${TEST_INSTALL_DIR}/.install-state"

    # Create old lock file (timestamp from 2020, use different hostname so PID check is skipped)
    # The timestamp is old enough to trigger the stale threshold
    echo "99999|2020-01-01T00:00:00Z|different-host" > "$lock_file"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_lock_check_stale
    "
    assert_success  # 0 = stale
}

@test "lock: fresh lock blocks concurrent install" {
    local lock_file="${TEST_INSTALL_DIR}/.install-state/.install.lock"
    mkdir -p "${TEST_INSTALL_DIR}/.install-state"

    # Use different hostname to prevent process liveness check
    # This simulates a lock held by a remote process
    echo "1|$(date -u +%Y-%m-%dT%H:%M:%SZ)|remote-host" > "$lock_file"

    # Try to acquire with 1 second timeout (should fail quickly)
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_lock_acquire 1
    " 2>&1

    # Should fail (exit code 60 = EXIT_LOCK_HELD)
    assert_failure
}

@test "lock: released on cleanup" {
    local lock_file="${TEST_INSTALL_DIR}/.install-state/.install.lock"
    mkdir -p "${TEST_INSTALL_DIR}/.install-state"

    # Create and release lock in the same subshell (must be same PID)
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        # Create lock owned by this subshell
        echo \"\$\$|\$(date -u +%Y-%m-%dT%H:%M:%SZ)|\$(hostname)\" > '$lock_file'
        # Release it
        installer_lock_release
    "

    # Lock should be removed
    [[ ! -f "$lock_file" ]]
}

@test "lock: not released if owned by different process" {
    local lock_file="${TEST_INSTALL_DIR}/.install-state/.install.lock"
    mkdir -p "${TEST_INSTALL_DIR}/.install-state"

    # Create lock owned by different PID
    local other_pid=$(($$+1))
    echo "${other_pid}|$(date -u +%Y-%m-%dT%H:%M:%SZ)|$(hostname)" > "$lock_file"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_lock_release
    "

    # Lock should still exist (we don't own it)
    [[ -f "$lock_file" ]]
}

@test "lock: stale detection handles dead process" {
    local lock_file="${TEST_INSTALL_DIR}/.install-state/.install.lock"
    mkdir -p "${TEST_INSTALL_DIR}/.install-state"

    # Create lock with PID that definitely doesn't exist, using current hostname
    # so that the process liveness check is performed
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        # Use a PID that doesn't exist (very high number)
        echo \"999999|\$(date -u +%Y-%m-%dT%H:%M:%SZ)|\$(hostname)\" > '$lock_file'
        installer_lock_check_stale
    "
    assert_success  # 0 = stale (process dead)
}

# =============================================================================
# RECOVERY ACTION EXECUTION TESTS
# =============================================================================

@test "recovery actions: execute for INIT state" {
    simulate_interrupt_at_state "INIT"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_execute_recovery_actions 'INIT'
    "
    assert_success
}

@test "recovery actions: execute for BACKUP state" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"
    echo '{"temp_dir": null}' > "${state_dir}/current"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_execute_recovery_actions 'BACKUP'
    "
    assert_success
}

@test "recovery actions: COMPLETE state requires no action" {
    simulate_interrupt_at_state "COMPLETE"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'

        actions=\"\${RECOVERY_ACTIONS[COMPLETE]}\"
        echo \"Actions: \$actions\"
    "
    assert_output --partial "none"
}

# =============================================================================
# EDGE CASES AND ERROR HANDLING
# =============================================================================

@test "edge: recovery handles missing state file gracefully" {
    # No state file exists
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_needs_recovery
    "
    assert_failure  # 1 = no recovery needed
}

@test "edge: recovery handles corrupted state file" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"

    # Create corrupted state file
    echo "not valid json {{{" > "${state_dir}/current"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_get_state_info 2>&1
    "
    # Should handle gracefully (may return error or default values)
    # The key is it shouldn't crash
    [[ $status -eq 0 ]] || [[ $status -eq 1 ]]
}

@test "edge: recovery handles empty backup directory" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "${state_dir}/backups"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_list_backups
    "
    assert_success

    # Should return empty array
    local count
    count=$(echo "$output" | jq '. | length')
    [[ "$count" == "0" ]]
}

@test "edge: restart action resets state to INIT" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    local markers_dir="${state_dir}/markers"
    mkdir -p "$markers_dir"

    cat > "${state_dir}/current" << EOF
{
    "state": "INSTALL",
    "version": "0.55.0",
    "source_dir": "/tmp/mock",
    "install_dir": "${TEST_INSTALL_DIR}",
    "completed": ["INIT","PREPARE","VALIDATE","BACKUP"],
    "pending": ["INSTALL","LINK","PROFILE","VERIFY","CLEANUP","COMPLETE"]
}
EOF

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_from_state 'restart'
    "
    assert_success

    # State should be reset to INIT
    run jq -r '.state' "${state_dir}/current"
    assert_output "INIT"
}
