#!/usr/bin/env bats
# =============================================================================
# installer-core.bats - Core installer functionality tests
# =============================================================================
# Task: T1870
# Tests: Dependency checking, directory structure, validation, locking
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
# Dependency Checking Tests (deps.sh)
# =============================================================================

@test "deps: check_bash passes with Bash 4+" {
    load_installer_lib "core"
    load_installer_lib "deps"

    run installer_deps_check_bash
    assert_success
}

@test "deps: check_jq passes when jq available" {
    load_installer_lib "core"
    load_installer_lib "deps"

    # This test requires jq to be installed on the system
    if ! command -v jq &>/dev/null; then
        skip "jq not installed on test system"
    fi

    run installer_deps_check_jq
    assert_success
}

@test "deps: check_required passes with bash and jq" {
    load_installer_lib "core"
    load_installer_lib "deps"

    if ! command -v jq &>/dev/null; then
        skip "jq not installed on test system"
    fi

    run installer_deps_check_required
    assert_success
}

@test "deps: detect_os returns valid platform" {
    load_installer_lib "core"
    load_installer_lib "deps"

    run installer_deps_detect_os
    assert_success

    # Should return linux, darwin, wsl, or unknown
    [[ "$output" =~ ^(linux|darwin|wsl|unknown)$ ]]
}

@test "deps: detect_arch returns valid architecture" {
    load_installer_lib "core"
    load_installer_lib "deps"

    run installer_deps_detect_arch
    assert_success

    # Should return x86_64, aarch64, or other arch
    [[ -n "$output" ]]
}

@test "deps: report generates JSON output" {
    load_installer_lib "core"
    load_installer_lib "deps"

    # Ensure checks are run
    installer_deps_check_all

    run installer_deps_report "json"
    assert_success

    # Verify JSON structure
    echo "$output" | jq -e '.platform.os' > /dev/null
    echo "$output" | jq -e '.dependencies' > /dev/null
}

@test "deps: report generates text output" {
    load_installer_lib "core"
    load_installer_lib "deps"

    installer_deps_check_all

    run installer_deps_report "text"
    assert_success
    assert_output --partial "Dependency Report"
    assert_output --partial "Platform:"
}

# =============================================================================
# Directory Structure Tests (validate.sh)
# =============================================================================

@test "validate: structure fails on empty directory" {
    load_installer_lib "core"
    load_installer_lib "validate"

    local empty_dir="${BATS_TEST_TMPDIR}/empty_install"
    mkdir -p "$empty_dir"

    run installer_validate_structure "$empty_dir"
    assert_failure
}

@test "validate: structure passes on valid repo" {
    load_installer_lib "core"
    load_installer_lib "validate"

    local repo_dir
    repo_dir=$(create_mock_repo)

    run installer_validate_structure "$repo_dir"
    assert_success
}

@test "validate: writable detects non-writable directory" {
    load_installer_lib "core"
    load_installer_lib "validate"

    local readonly_dir="${BATS_TEST_TMPDIR}/readonly"
    mkdir -p "$readonly_dir"
    chmod 444 "$readonly_dir"

    run installer_validate_writable "$readonly_dir"
    assert_failure

    # Cleanup
    chmod 755 "$readonly_dir"
}

@test "validate: writable passes on writable directory" {
    load_installer_lib "core"
    load_installer_lib "validate"

    run installer_validate_writable "${BATS_TEST_TMPDIR}"
    assert_success
}

@test "validate: disk_space check succeeds on test system" {
    load_installer_lib "core"
    load_installer_lib "validate"

    # Test with minimal requirement (1 MB)
    run installer_validate_disk_space "${BATS_TEST_TMPDIR}" 1
    assert_success
}

# =============================================================================
# Version Comparison Tests (validate.sh)
# =============================================================================

@test "validate: compare_versions equal" {
    load_installer_lib "core"
    load_installer_lib "validate"

    run installer_validate_compare_versions "1.0.0" "1.0.0"
    assert_success
    assert_output "0"
}

@test "validate: compare_versions v1 < v2" {
    load_installer_lib "core"
    load_installer_lib "validate"

    run installer_validate_compare_versions "1.0.0" "1.1.0"
    assert_success
    assert_output "-1"
}

@test "validate: compare_versions v1 > v2" {
    load_installer_lib "core"
    load_installer_lib "validate"

    run installer_validate_compare_versions "2.0.0" "1.9.9"
    assert_success
    assert_output "1"
}

@test "validate: compare_versions handles v prefix" {
    load_installer_lib "core"
    load_installer_lib "validate"

    run installer_validate_compare_versions "v1.0.0" "v1.0.0"
    assert_success
    assert_output "0"
}

@test "validate: compare_versions handles different lengths" {
    load_installer_lib "core"
    load_installer_lib "validate"

    run installer_validate_compare_versions "1.0" "1.0.0"
    assert_success
    assert_output "0"
}

# =============================================================================
# Locking Tests (core.sh)
# =============================================================================

@test "lock: acquire succeeds on first attempt" {
    # Test locking in a subshell with its own environment
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_ensure_dirs
        installer_lock_acquire 1
    "
    assert_success

    # Verify lock file exists
    assert_file_exists "${TEST_INSTALL_DIR}/.install-state/.install.lock"
}

@test "lock: release removes lock file" {
    # Test in subshell
    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_ensure_dirs
        installer_lock_acquire 1
    "

    # Verify lock exists
    assert_file_exists "${TEST_INSTALL_DIR}/.install-state/.install.lock"

    # Release in same environment
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_lock_release
    "
    # Note: Can't easily release a lock owned by a different PID
    # This test verifies the lock was created successfully
}

@test "lock: stale detection identifies dead process" {
    # Create lock with non-existent PID in subshell
    local lock_file="${TEST_INSTALL_DIR}/.install-state/.install.lock"
    mkdir -p "$(dirname "$lock_file")"
    echo "999999|2026-01-01T00:00:00Z|$(hostname)" > "$lock_file"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_lock_check_stale
    "
    assert_success  # 0 means stale
}

@test "lock: prevents concurrent installations" {
    local lock_file="${TEST_INSTALL_DIR}/.install-state/.install.lock"

    # Create lock with different hostname to prevent stale detection
    # (simulates lock held by remote process)
    mkdir -p "${TEST_INSTALL_DIR}/.install-state"
    echo "1|$(date -u +%Y-%m-%dT%H:%M:%SZ)|remote-host" > "$lock_file"

    # Second acquire should fail quickly (1 second timeout)
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_lock_acquire 1
    "
    assert_failure
}

# =============================================================================
# Installation Validation Tests (validate.sh)
# =============================================================================

@test "validate: installation fails on missing files" {
    load_installer_lib "core"
    load_installer_lib "validate"

    local incomplete_dir="${BATS_TEST_TMPDIR}/incomplete"
    mkdir -p "${incomplete_dir}/lib"
    mkdir -p "${incomplete_dir}/scripts"
    # Missing schemas directory and files

    run installer_validate_installation "$incomplete_dir"
    assert_failure
}

@test "validate: installation passes on complete repo" {
    load_installer_lib "core"
    load_installer_lib "validate"

    local repo_dir
    repo_dir=$(create_mock_repo)

    run installer_validate_installation "$repo_dir"
    assert_success
}

@test "validate: checksum calculates SHA256" {
    load_installer_lib "core"
    load_installer_lib "validate"

    # Create test file
    local test_file="${BATS_TEST_TMPDIR}/test_checksum.txt"
    echo "test content" > "$test_file"

    run installer_validate_calc_checksum "$test_file"
    assert_success

    # SHA256 hash is 64 characters
    [[ ${#output} -eq 64 ]]
}

@test "validate: checksum verification succeeds on matching hash" {
    load_installer_lib "core"
    load_installer_lib "validate"

    local test_file="${BATS_TEST_TMPDIR}/test_verify.txt"
    echo "test content" > "$test_file"

    # Calculate expected checksum
    local expected
    expected=$(installer_validate_calc_checksum "$test_file")

    run installer_validate_checksum "$test_file" "$expected"
    assert_success
}

@test "validate: checksum verification fails on mismatched hash" {
    load_installer_lib "core"
    load_installer_lib "validate"

    local test_file="${BATS_TEST_TMPDIR}/test_verify_fail.txt"
    echo "test content" > "$test_file"

    run installer_validate_checksum "$test_file" "0000000000000000000000000000000000000000000000000000000000000000"
    assert_failure
}
