#!/usr/bin/env bats
# =============================================================================
# installer-atomic.bats - Atomic operations tests
# =============================================================================
# Task: T1870
# Tests: Atomic writes, swaps, state machine, marker files
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
# Atomic Write Tests
# =============================================================================

@test "atomic_write creates temp file then renames" {
    local target_file="${BATS_TEST_TMPDIR}/atomic_test.txt"
    local content="test content for atomic write"

    # Perform atomic write in subshell
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_atomic_write '$target_file' '$content'
    "
    assert_success

    # Verify file exists with correct content
    assert_file_exists "$target_file"
    run cat "$target_file"
    assert_output "$content"

    # Verify no temp files left behind
    local temp_files
    temp_files=$(ls "${BATS_TEST_TMPDIR}"/*.tmp.* 2>/dev/null | wc -l)
    [[ "$temp_files" -eq 0 ]]
}

@test "atomic_write preserves permissions of existing file" {
    local target_file="${BATS_TEST_TMPDIR}/perm_test.txt"

    # Create file with specific permissions
    echo "original" > "$target_file"
    chmod 640 "$target_file"

    # Perform atomic write
    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_atomic_write '$target_file' 'new content'
    "

    # Check permissions preserved (format differs by OS)
    local perms
    perms=$(stat -c '%a' "$target_file" 2>/dev/null || stat -f '%Lp' "$target_file" 2>/dev/null)
    [[ "$perms" == "640" ]]
}

@test "atomic_write creates parent directories" {
    local target_file="${BATS_TEST_TMPDIR}/nested/path/to/file.txt"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_atomic_write '$target_file' 'content'
    "
    assert_success
    assert_file_exists "$target_file"
}

@test "atomic_copy copies file atomically" {
    local source_file="${BATS_TEST_TMPDIR}/source.txt"
    local target_file="${BATS_TEST_TMPDIR}/target.txt"

    echo "source content" > "$source_file"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_atomic_copy '$source_file' '$target_file'
    "
    assert_success

    # Verify content matches
    run cat "$target_file"
    assert_output "source content"
}

# =============================================================================
# Atomic Swap Tests
# =============================================================================

@test "atomic_swap replaces directory atomically" {
    # Create source directory
    local source_dir="${BATS_TEST_TMPDIR}/new_version"
    mkdir -p "$source_dir"
    echo "new content" > "$source_dir/file.txt"

    # Create target directory (existing installation)
    local target_dir="${BATS_TEST_TMPDIR}/install"
    mkdir -p "$target_dir"
    echo "old content" > "$target_dir/file.txt"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_atomic_swap '$source_dir' '$target_dir'
    "
    assert_success

    # Verify new content is in place
    run cat "$target_dir/file.txt"
    assert_output "new content"

    # Source should no longer exist (was moved)
    assert_not_exists "$source_dir"
}

@test "atomic_swap preserves backup on failure" {
    # Create target directory
    local target_dir="${BATS_TEST_TMPDIR}/install_fail"
    mkdir -p "$target_dir"
    echo "original" > "$target_dir/file.txt"

    # Source doesn't exist (will fail)
    local source_dir="${BATS_TEST_TMPDIR}/nonexistent"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_atomic_swap '$source_dir' '$target_dir'
    "
    assert_failure

    # Original should still be intact
    run cat "$target_dir/file.txt"
    assert_output "original"
}

# =============================================================================
# Atomic Backup Tests
# =============================================================================

@test "atomic_backup creates backup of existing installation" {
    mkdir -p "$TEST_INSTALL_DIR"
    echo "existing installation" > "$TEST_INSTALL_DIR/VERSION"

    # Initialize state for backup recording
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"
    echo '{"backup_path": null}' > "${state_dir}/current"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_atomic_backup '${TEST_INSTALL_DIR}'
    "
    assert_success

    # Verify backup exists
    local backup_count
    backup_count=$(find "${state_dir}/backups" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
    [[ "$backup_count" -ge 1 ]]
}

@test "atomic_backup skips if no existing installation" {
    local nonexistent="${BATS_TEST_TMPDIR}/nonexistent"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_atomic_backup '$nonexistent'
    "
    assert_success  # Should succeed but do nothing
}

# =============================================================================
# State Machine Tests
# =============================================================================

@test "state_machine initializes correctly" {
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_state_init '0.55.0' '/source' '${TEST_INSTALL_DIR}'
    "
    assert_success

    # Verify state file created
    assert_file_exists "${TEST_INSTALL_DIR}/.install-state/current"

    # Verify initial state
    run jq -r '.state' "${TEST_INSTALL_DIR}/.install-state/current"
    assert_output "INIT"
}

@test "state_machine transitions correctly" {
    # Initialize first
    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_state_init '0.55.0' '/source' '${TEST_INSTALL_DIR}'
    "

    # Transition to PREPARE
    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_state_transition 'PREPARE'
    "

    run jq -r '.state' "${TEST_INSTALL_DIR}/.install-state/current"
    assert_output "PREPARE"

    run jq -r '.previous_state' "${TEST_INSTALL_DIR}/.install-state/current"
    assert_output "INIT"
}

@test "state_machine tracks completed states" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    local markers_dir="${state_dir}/markers"

    mkdir -p "$markers_dir"

    # Initialize
    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_state_init '0.55.0' '/source' '${TEST_INSTALL_DIR}'
    "

    # Mark INIT complete
    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_state_mark_complete 'INIT'
    "

    # Verify marker file exists
    assert_file_exists "${markers_dir}/INIT.done"

    # Verify state updated
    run jq -r '.completed | contains(["INIT"])' "${state_dir}/current"
    assert_output "true"
}

@test "state_is_complete returns correct status" {
    local markers_dir="${TEST_INSTALL_DIR}/.install-state/markers"
    mkdir -p "$markers_dir"

    # Not complete
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_state_is_complete 'INIT'
    "
    assert_failure

    # Mark complete
    touch "${markers_dir}/INIT.done"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_state_is_complete 'INIT'
    "
    assert_success
}

@test "state_can_recover identifies auto-recoverable states" {
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_state_can_recover 'INIT'
    "
    assert_success  # 0 = auto-recoverable

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_state_can_recover 'PREPARE'
    "
    assert_success
}

@test "state_can_recover identifies prompt-required states" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"
    echo '{"backup_path": null}' > "${state_dir}/current"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_state_can_recover 'BACKUP'
    "
    # Returns 1 = needs prompt
    [[ "$status" -eq 1 ]]
}

@test "state_can_recover identifies critical states" {
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_state_can_recover 'LINK'
    "
    # Returns 2 = critical
    [[ "$status" -eq 2 ]]
}

# =============================================================================
# Marker File Tests
# =============================================================================

@test "marker_files track progress correctly" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    local markers_dir="${state_dir}/markers"
    mkdir -p "$markers_dir"

    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_state_init '0.55.0' '/source' '${TEST_INSTALL_DIR}'
    "

    # Mark multiple states complete
    for state in INIT PREPARE VALIDATE; do
        bash -c "
            export CLEO_HOME='${TEST_INSTALL_DIR}'
            source '${INSTALLER_LIB_DIR}/core.sh'
            installer_state_mark_complete '$state'
        "
    done

    # Verify all markers exist
    for state in INIT PREPARE VALIDATE; do
        assert_file_exists "${markers_dir}/${state}.done"
    done

    # Verify incomplete state has no marker
    assert_file_not_exists "${markers_dir}/BACKUP.done"
}

@test "marker_files contain timestamps" {
    local markers_dir="${TEST_INSTALL_DIR}/.install-state/markers"
    local state_dir="${TEST_INSTALL_DIR}/.install-state"

    mkdir -p "$markers_dir"
    echo '{"completed": [], "pending": ["INIT"]}' > "${state_dir}/current"

    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_state_mark_complete 'INIT'
    "

    # Verify marker contains timestamp (ISO 8601 format)
    local content
    content=$(cat "${markers_dir}/INIT.done")
    [[ "$content" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]]
}

# =============================================================================
# Temp Directory Management Tests
# =============================================================================

@test "create_temp_dir creates isolated temp directory" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"
    echo '{"temp_dir": null}' > "${state_dir}/current"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_create_temp_dir
        echo \"\$INSTALLER_TEMP_DIR\"
    "
    assert_success

    # Verify temp dir exists
    [[ -d "$output" ]]
}

@test "cleanup_temp removes temp directory" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    mkdir -p "$state_dir"

    # Create a temp dir
    local temp_dir="${BATS_TEST_TMPDIR}/test_temp"
    mkdir -p "$temp_dir"

    echo "{\"temp_dir\": \"$temp_dir\"}" > "${state_dir}/current"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        INSTALLER_TEMP_DIR='$temp_dir'
        installer_cleanup_temp
    "
    assert_success

    # Verify temp dir removed
    assert_not_exists "$temp_dir"
}

# =============================================================================
# State Machine Runner Tests
# =============================================================================

@test "run_state_machine executes handlers in order" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    local markers_dir="${state_dir}/markers"
    mkdir -p "$markers_dir"

    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_state_init '0.55.0' '/source' '${TEST_INSTALL_DIR}'

        # Define simple handlers
        do_state_init() { return 0; }
        do_state_prepare() { return 0; }
        do_state_validate() { return 0; }
        do_state_backup() { return 0; }
        do_state_install() { return 0; }
        do_state_link() { return 0; }
        do_state_profile() { return 0; }
        do_state_verify() { return 0; }
        do_state_cleanup() { return 0; }
        do_state_complete() { return 0; }

        installer_run_state_machine 'do_state'
    "

    # All states should be marked complete
    for state in INIT PREPARE VALIDATE BACKUP INSTALL LINK PROFILE VERIFY CLEANUP COMPLETE; do
        assert_file_exists "${markers_dir}/${state}.done"
    done
}

@test "run_state_machine skips completed states" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    local markers_dir="${state_dir}/markers"
    mkdir -p "$markers_dir"

    # Initialize and pre-mark some states
    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_state_init '0.55.0' '/source' '${TEST_INSTALL_DIR}'
    "

    # Pre-mark INIT and PREPARE as complete
    touch "${markers_dir}/INIT.done"
    touch "${markers_dir}/PREPARE.done"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'

        executed=''
        do_state_init() { executed=\"\${executed}INIT,\"; return 0; }
        do_state_prepare() { executed=\"\${executed}PREPARE,\"; return 0; }
        do_state_validate() { executed=\"\${executed}VALIDATE,\"; return 0; }
        do_state_backup() { return 0; }
        do_state_install() { return 0; }
        do_state_link() { return 0; }
        do_state_profile() { return 0; }
        do_state_verify() { return 0; }
        do_state_cleanup() { return 0; }
        do_state_complete() { return 0; }

        installer_run_state_machine 'do_state'
        echo \"\$executed\"
    "
    assert_success

    # INIT and PREPARE should NOT have been executed
    [[ "$output" != *"INIT"* ]]
    [[ "$output" != *"PREPARE"* ]]
    [[ "$output" == *"VALIDATE"* ]]
}

@test "run_state_machine stops on handler failure" {
    local state_dir="${TEST_INSTALL_DIR}/.install-state"
    local markers_dir="${state_dir}/markers"
    mkdir -p "$markers_dir"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_state_init '0.55.0' '/source' '${TEST_INSTALL_DIR}'

        do_state_init() { return 0; }
        do_state_prepare() { return 1; }  # Fails
        do_state_validate() { return 0; }

        installer_run_state_machine 'do_state'
    "
    assert_failure

    # Validate should NOT have been executed
    assert_file_not_exists "${markers_dir}/VALIDATE.done"
}
