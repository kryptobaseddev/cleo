#!/usr/bin/env bats
# =============================================================================
# installer-recovery.bats - Recovery scenario tests
# =============================================================================
# Task: T1870
# Tests: Interrupted installation detection, backup restoration, cleanup
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
# Interrupted Installation Detection Tests (recover.sh)
# =============================================================================

@test "recover: detect identifies incomplete installation" {
    # Create state in test directory
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "${state_dir}/markers"

    cat > "${state_dir}/current" << 'EOF'
{
    "state": "INSTALL",
    "previous_state": "BACKUP",
    "completed": ["INIT","PREPARE","VALIDATE","BACKUP"],
    "pending": ["INSTALL","LINK","PROFILE","VERIFY","CLEANUP","COMPLETE"]
}
EOF

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_detect
    "
    assert_success  # 0 = recovery needed
}

@test "recover: detect returns false for complete installation" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    local markers_dir="${state_dir}/markers"

    mkdir -p "$markers_dir"
    cat > "${state_dir}/current" << 'EOF'
{
    "state": "COMPLETE",
    "completed": ["INIT","PREPARE","VALIDATE","BACKUP","INSTALL","LINK","PROFILE","VERIFY","CLEANUP","COMPLETE"],
    "pending": []
}
EOF

    # Mark all complete
    for state in INIT PREPARE VALIDATE BACKUP INSTALL LINK PROFILE VERIFY CLEANUP COMPLETE; do
        touch "${markers_dir}/${state}.done"
    done

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_detect
    "
    assert_failure  # 1 = no recovery needed
}

@test "recover: detect returns false when no state file" {
    # No state file, just empty test dir
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_detect
    "
    assert_failure  # 1 = no recovery needed
}

@test "recover: get_state_info returns JSON with state details" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"

    cat > "${state_dir}/current" << 'EOF'
{
    "state": "INSTALL",
    "version": "0.55.0",
    "started_at": "2026-01-20T00:00:00Z"
}
EOF

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

    local state
    state=$(echo "$output" | jq -r '.state')
    [[ "$state" == "INSTALL" ]]
}

@test "recover: is_state_stale detects old state" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"

    # Create state with old timestamp (> 24 hours)
    cat > "${state_dir}/current" << 'EOF'
{
    "state": "INSTALL",
    "started_at": "2020-01-01T00:00:00Z"
}
EOF

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_is_state_stale
    "
    assert_success  # 0 = stale
}

@test "recover: is_state_stale returns false for recent state" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"

    # Create state with current timestamp
    local now
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    cat > "${state_dir}/current" << EOF
{
    "state": "INSTALL",
    "started_at": "$now"
}
EOF

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_is_state_stale
    "
    assert_failure  # 1 = not stale
}

# =============================================================================
# Backup Restoration Tests (recover.sh)
# =============================================================================

@test "recover: create_backup creates timestamped backup" {
    # Create existing installation
    mkdir -p "${TEST_INSTALL_DIR}"/{lib,scripts,schemas}
    echo "0.54.0" > "${TEST_INSTALL_DIR}/VERSION"

    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"
    echo '{}' > "${state_dir}/current"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_create_backup 'snapshot'
    "
    assert_success

    # Verify backup created
    local backup_count
    backup_count=$(find "${state_dir}/backups" -mindepth 1 -maxdepth 1 -type d -name "*snapshot" 2>/dev/null | wc -l)
    [[ "$backup_count" -ge 1 ]]
}

@test "recover: create_backup includes metadata" {
    mkdir -p "${TEST_INSTALL_DIR}"
    echo "0.54.0" > "${TEST_INSTALL_DIR}/VERSION"

    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"
    echo '{}' > "${state_dir}/current"

    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_create_backup 'test'
    "

    # Find backup dir
    local backup_dir
    backup_dir=$(find "${state_dir}/backups" -mindepth 1 -maxdepth 1 -type d | head -1)

    # Verify metadata
    [[ -f "$backup_dir/.backup_meta.json" ]]
    run jq -r '.type' "$backup_dir/.backup_meta.json"
    assert_output "test"
}

@test "recover: restore fails gracefully without backup" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"
    echo '{"backup_path": null}' > "${state_dir}/current"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_restore_current_backup
    "
    assert_failure
}

@test "recover: list_backups returns JSON array" {
    local backups_dir="${TEST_INSTALL_DIR}/.install-state/backups"

    # Create some mock backups
    mkdir -p "${backups_dir}/20260120120000_test"
    mkdir -p "${backups_dir}/20260120130000_test"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_list_backups
    "
    assert_success

    # Verify JSON array
    local count
    count=$(echo "$output" | jq '. | length')
    [[ "$count" -ge 2 ]]
}

# =============================================================================
# Cleanup Tests (recover.sh)
# =============================================================================

@test "recover: cleanup_temp removes temp files" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"

    # Create temp directory
    local temp_dir="${BATS_TEST_TMPDIR}/install_temp"
    mkdir -p "$temp_dir"

    echo '{"temp_dir": "'$temp_dir'"}' > "${state_dir}/current"

    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        INSTALLER_TEMP_DIR='$temp_dir'
        installer_recover_cleanup_temp
    "

    # Temp dir should be removed
    [[ ! -d "$temp_dir" ]]
}

@test "recover: cleanup staged removes staging directories" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"
    echo '{"temp_dir": null}' > "${state_dir}/current"

    # Create staging directories
    mkdir -p "${TEST_INSTALL_DIR}.staging.12345"
    mkdir -p "${TEST_INSTALL_DIR}.tmp.67890"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_cleanup 'staged'
    "
    assert_success

    # Staging dirs should be removed
    [[ ! -d "${TEST_INSTALL_DIR}.staging.12345" ]]
    [[ ! -d "${TEST_INSTALL_DIR}.tmp.67890" ]]
}

@test "recover: cleanup state removes markers" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    local markers_dir="${state_dir}/markers"
    local state_file="${state_dir}/current"

    mkdir -p "$markers_dir"
    touch "$state_file"
    touch "${markers_dir}/INIT.done"
    touch "${markers_dir}/PREPARE.done"

    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_cleanup 'state'
    "

    # State and markers should be removed
    [[ ! -f "$state_file" ]]
    [[ ! -f "${markers_dir}/INIT.done" ]]
}

# =============================================================================
# Recovery Action Matrix Tests (recover.sh)
# =============================================================================

@test "recover: execute_recovery_actions for INIT state" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"
    echo '{"temp_dir": null}' > "${state_dir}/current"

    # INIT state has action: cleanup_temp
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_execute_recovery_actions 'INIT'
    "
    assert_success
}

@test "recover: recovery_levels are correctly defined" {
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'

        # Auto-recoverable (level 0)
        [[ \"\${RECOVERY_LEVELS[INIT]}\" == \"0\" ]] || exit 1
        [[ \"\${RECOVERY_LEVELS[PREPARE]}\" == \"0\" ]] || exit 2
        [[ \"\${RECOVERY_LEVELS[VALIDATE]}\" == \"0\" ]] || exit 3

        # Needs prompt (level 1)
        [[ \"\${RECOVERY_LEVELS[BACKUP]}\" == \"1\" ]] || exit 4
        [[ \"\${RECOVERY_LEVELS[INSTALL]}\" == \"1\" ]] || exit 5

        # Critical (level 2)
        [[ \"\${RECOVERY_LEVELS[LINK]}\" == \"2\" ]] || exit 6
        [[ \"\${RECOVERY_LEVELS[PROFILE]}\" == \"2\" ]] || exit 7
    "
    assert_success
}

@test "recover: interrupted handles auto-recoverable states" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    local markers_dir="${state_dir}/markers"

    mkdir -p "$markers_dir"

    cat > "${state_dir}/current" << 'EOF'
{
    "state": "VALIDATE",
    "temp_dir": null,
    "completed": ["INIT","PREPARE"],
    "pending": ["VALIDATE","BACKUP","INSTALL","LINK","PROFILE","VERIFY","CLEANUP","COMPLETE"]
}
EOF

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_interrupted
    "
    assert_success
}

# =============================================================================
# Manual Recovery Command Tests (recover.sh)
# =============================================================================

@test "recover: manual_cleanup removes temp and staged files" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"
    echo '{"temp_dir": null}' > "${state_dir}/current"

    # Create temp and staged files
    mkdir -p "${TEST_INSTALL_DIR}.staging.test"
    mkdir -p "${TEST_INSTALL_DIR}.tmp.test"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_manual_cleanup 'staged'
    "
    assert_success

    [[ ! -d "${TEST_INSTALL_DIR}.staging.test" ]]
    [[ ! -d "${TEST_INSTALL_DIR}.tmp.test" ]]
}

@test "recover: from_state handles restart action" {
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

# =============================================================================
# Rollback Tests (recover.sh)
# =============================================================================

@test "recover: rollback fails without backup" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"
    echo '{"backup_path": null, "install_dir": "'$TEST_INSTALL_DIR'"}' > "${state_dir}/current"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_rollback
    "
    assert_failure
}

@test "recover: restore_current_backup restores from backup" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    local backups_dir="${state_dir}/backups"

    # Create backup
    local backup_dir="${backups_dir}/20260120120000_test"
    mkdir -p "$backup_dir"
    echo "0.54.0" > "$backup_dir/VERSION"
    mkdir -p "$backup_dir"/{lib,scripts,schemas}

    # Record backup location
    mkdir -p "$state_dir"
    echo "$backup_dir" > "$state_dir/current_backup"
    echo '{"backup_path": "'$backup_dir'"}' > "${state_dir}/current"

    # Create "corrupted" current installation
    mkdir -p "$TEST_INSTALL_DIR"
    echo "corrupted" > "$TEST_INSTALL_DIR/VERSION"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        source '${INSTALLER_LIB_DIR}/recover.sh'
        installer_recover_restore_current_backup
    "
    assert_success

    # Verify restored
    run cat "$TEST_INSTALL_DIR/VERSION"
    assert_output "0.54.0"
}
