#!/usr/bin/env bats
# =============================================================================
# installer-modes.bats - Installation mode tests
# =============================================================================
# Task: T1870
# Tests: Dev mode symlinks, release mode downloads, version management
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
# Mode Detection Tests (source.sh)
# =============================================================================

@test "source: detect_mode returns dev when .git present" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    # Test runs from project root which has .git
    run installer_source_detect_mode
    assert_success
    assert_output "dev"
}

@test "source: detect_mode respects INSTALLER_MODE env var" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    export INSTALLER_MODE="release"

    run installer_source_detect_mode
    assert_success
    assert_output "release"

    unset INSTALLER_MODE
}

@test "source: detect_mode respects INSTALLER_DEV_MODE flag" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    export INSTALLER_DEV_MODE=1

    run installer_source_detect_mode
    assert_success
    assert_output "dev"

    unset INSTALLER_DEV_MODE
}

# =============================================================================
# Repository Validation Tests (source.sh)
# =============================================================================

@test "source: validate_repo passes for valid repo" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local repo_dir
    repo_dir=$(create_mock_repo)

    run installer_source_validate_repo "$repo_dir"
    assert_success
}

@test "source: validate_repo fails for invalid repo" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local repo_dir
    repo_dir=$(create_invalid_repo)

    run installer_source_validate_repo "$repo_dir"
    assert_failure
}

@test "source: validate_repo fails for empty directory" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local empty_dir="${BATS_TEST_TMPDIR}/empty"
    mkdir -p "$empty_dir"

    run installer_source_validate_repo "$empty_dir"
    assert_failure
}

@test "source: validate_repo fails for nonexistent directory" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    run installer_source_validate_repo "/nonexistent/path"
    assert_failure
}

# =============================================================================
# Dev Mode Symlink Tests (source.sh)
# =============================================================================

@test "source: link_repo creates symlinks in target" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local repo_dir target_dir
    repo_dir=$(create_mock_repo)
    target_dir="${BATS_TEST_TMPDIR}/dev_install"

    run installer_source_link_repo "$repo_dir" "$target_dir"
    assert_success

    # Verify symlinks created
    [[ -L "$target_dir/lib" ]]
    [[ -L "$target_dir/scripts" ]]
    [[ -L "$target_dir/schemas" ]]
}

@test "source: link_repo symlinks point to source" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local repo_dir target_dir
    repo_dir=$(create_mock_repo)
    target_dir="${BATS_TEST_TMPDIR}/dev_install2"

    installer_source_link_repo "$repo_dir" "$target_dir"

    # Verify symlinks point to correct source
    local lib_target
    lib_target=$(readlink "$target_dir/lib")
    [[ "$lib_target" == "$repo_dir/lib" ]]
}

@test "source: link_repo copies VERSION file (not symlink)" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local repo_dir target_dir
    repo_dir=$(create_mock_repo)
    target_dir="${BATS_TEST_TMPDIR}/dev_install3"

    installer_source_link_repo "$repo_dir" "$target_dir"

    # VERSION should be a regular file, not a symlink
    [[ -f "$target_dir/VERSION" ]]
    [[ ! -L "$target_dir/VERSION" ]]
}

@test "source: link_repo writes metadata to VERSION" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local repo_dir target_dir
    repo_dir=$(create_mock_repo)
    target_dir="${BATS_TEST_TMPDIR}/dev_install4"

    installer_source_link_repo "$repo_dir" "$target_dir"

    # Verify metadata written
    run grep "mode=dev" "$target_dir/VERSION"
    assert_success

    run grep "source=" "$target_dir/VERSION"
    assert_success

    run grep "installed=" "$target_dir/VERSION"
    assert_success
}

@test "source: copy_repo creates file copies (not symlinks)" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local repo_dir target_dir
    repo_dir=$(create_mock_repo)
    target_dir="${BATS_TEST_TMPDIR}/copy_install"

    run installer_source_copy_repo "$repo_dir" "$target_dir"
    assert_success

    # Verify directories are NOT symlinks
    [[ -d "$target_dir/lib" ]]
    [[ ! -L "$target_dir/lib" ]]
}

@test "source: is_dev_mode detects dev installation" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local repo_dir target_dir
    repo_dir=$(create_mock_repo)
    target_dir="${BATS_TEST_TMPDIR}/dev_check"

    installer_source_link_repo "$repo_dir" "$target_dir"

    run installer_source_is_dev_mode "$target_dir"
    assert_success
}

@test "source: dev_status shows installation info" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local repo_dir target_dir
    repo_dir=$(create_mock_repo)
    target_dir="${BATS_TEST_TMPDIR}/dev_status"

    installer_source_link_repo "$repo_dir" "$target_dir"

    # Pass target_dir as parameter (don't try to override readonly INSTALL_DIR)
    run installer_source_dev_status "$target_dir"
    assert_success
    assert_output --partial "Mode:      dev"
    assert_output --partial "Source:"
}

# =============================================================================
# Version Management Tests (source.sh)
# =============================================================================

@test "source: get_installed_version reads VERSION file" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local install_dir="${BATS_TEST_TMPDIR}/version_test"
    mkdir -p "$install_dir"
    echo "0.55.0" > "$install_dir/VERSION"

    run installer_source_get_installed_version "$install_dir"
    assert_success
    assert_output "0.55.0"
}

@test "source: get_installed_version returns none for missing file" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local install_dir="${BATS_TEST_TMPDIR}/no_version"
    mkdir -p "$install_dir"

    run installer_source_get_installed_version "$install_dir"
    assert_success
    assert_output "none"
}

@test "source: get_installed_mode reads mode from VERSION" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local install_dir="${BATS_TEST_TMPDIR}/mode_test"
    mkdir -p "$install_dir"
    cat > "$install_dir/VERSION" << 'EOF'
0.55.0
mode=release
source=github:kryptobaseddev/cleo
EOF

    run installer_source_get_installed_mode "$install_dir"
    assert_success
    assert_output "release"
}

@test "source: compare_versions detects upgrade" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    run installer_source_compare_versions "0.54.0" "0.55.0"
    assert_success
    assert_output "upgrade"
}

@test "source: compare_versions detects downgrade" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    run installer_source_compare_versions "0.55.0" "0.54.0"
    assert_success
    assert_output "downgrade"
}

@test "source: compare_versions detects equal" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    run installer_source_compare_versions "0.55.0" "0.55.0"
    assert_success
    assert_output "equal"
}

@test "source: compare_versions handles v prefix" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    run installer_source_compare_versions "v0.54.0" "v0.55.0"
    assert_success
    assert_output "upgrade"
}

@test "source: compare_versions handles 'none' versions" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    run installer_source_compare_versions "none" "0.55.0"
    assert_success
    assert_output "upgrade"

    run installer_source_compare_versions "0.55.0" "none"
    assert_success
    assert_output "downgrade"

    run installer_source_compare_versions "none" "none"
    assert_success
    assert_output "equal"
}

# =============================================================================
# Version Info Display Tests (source.sh)
# =============================================================================

@test "source: version_info displays installation details" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local repo_dir target_dir
    repo_dir=$(create_mock_repo)
    target_dir="${BATS_TEST_TMPDIR}/version_info"

    installer_source_link_repo "$repo_dir" "$target_dir"

    # Mock network unavailable to avoid GitHub API calls
    mock_network_unavailable

    run installer_source_version_info "$target_dir"
    assert_success
    assert_output --partial "CLEO Version Information"
    assert_output --partial "Installed:"
    assert_output --partial "Mode:"
}

# =============================================================================
# Fetch Operations Tests (source.sh - local only)
# =============================================================================

@test "source: fetch_local validates and copies repo" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local repo_dir target_dir
    repo_dir=$(create_mock_repo)
    target_dir="${BATS_TEST_TMPDIR}/fetch_local"

    # Set mode to dev so fetch_local uses symlinks
    export INSTALLER_DEV_MODE=1

    run installer_source_fetch_local "$target_dir" "false"  # false = copy mode
    assert_success

    # Verify content copied
    [[ -d "$target_dir/lib" ]]
    [[ -d "$target_dir/scripts" ]]
}

@test "source: verify_staging passes for complete staging" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local staging_dir
    staging_dir=$(create_mock_repo)

    run installer_source_verify_staging "$staging_dir"
    assert_success
}

@test "source: verify_staging fails for incomplete staging" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local staging_dir="${BATS_TEST_TMPDIR}/incomplete_staging"
    mkdir -p "$staging_dir/lib"
    # Missing required files

    run installer_source_verify_staging "$staging_dir"
    assert_failure
}

# =============================================================================
# Download Tests (source.sh - mocked)
# =============================================================================

@test "source: download fails gracefully when no downloader" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    # Hide curl and wget
    function curl() { return 127; }
    function wget() { return 127; }
    export -f curl wget

    run installer_source_download "http://example.com/file" "${BATS_TEST_TMPDIR}/output"
    assert_failure
}

# =============================================================================
# Symlink Management Tests (link.sh)
# =============================================================================

@test "link: create creates symlink to source" {
    load_installer_lib "core"
    load_installer_lib "link"

    local source_file="${BATS_TEST_TMPDIR}/source.txt"
    local target_link="${BATS_TEST_TMPDIR}/link.txt"

    echo "content" > "$source_file"

    run installer_link_create "$source_file" "$target_link"
    assert_success

    [[ -L "$target_link" ]]
    run cat "$target_link"
    assert_output "content"
}

@test "link: create backs up existing file" {
    load_installer_lib "core"
    load_installer_lib "link"

    local source_file="${BATS_TEST_TMPDIR}/new_source.txt"
    local target_link="${BATS_TEST_TMPDIR}/target.txt"

    echo "new content" > "$source_file"
    echo "old content" > "$target_link"

    installer_link_create "$source_file" "$target_link"

    # Backup should exist
    [[ -f "${target_link}.cleo-backup" ]]
    run cat "${target_link}.cleo-backup"
    assert_output "old content"
}

@test "link: verify passes for valid symlink" {
    load_installer_lib "core"
    load_installer_lib "link"

    local source_file="${BATS_TEST_TMPDIR}/verify_source.txt"
    local link="${BATS_TEST_TMPDIR}/verify_link.txt"

    echo "content" > "$source_file"
    ln -s "$source_file" "$link"

    run installer_link_verify "$link"
    assert_success
}

@test "link: verify fails for broken symlink" {
    load_installer_lib "core"
    load_installer_lib "link"

    local link="${BATS_TEST_TMPDIR}/broken_link.txt"
    ln -s "/nonexistent/file" "$link"

    run installer_link_verify "$link"
    assert_failure
}

@test "link: remove restores backup when available" {
    load_installer_lib "core"
    load_installer_lib "link"

    local source_file="${BATS_TEST_TMPDIR}/remove_source.txt"
    local target_link="${BATS_TEST_TMPDIR}/remove_target.txt"

    # Create backup
    echo "original" > "${target_link}.cleo-backup"

    # Create symlink
    echo "new" > "$source_file"
    ln -sf "$source_file" "$target_link"

    installer_link_remove "$target_link" "true"

    # Link should be removed, backup restored
    [[ ! -L "$target_link" ]]
    [[ -f "$target_link" ]]
    run cat "$target_link"
    assert_output "original"
}

@test "link: ensure_bin_dir creates directory" {
    # Set CLEO_BIN_DIR BEFORE loading libs to influence LINK_BIN_DIR constant
    local test_bin="${BATS_TEST_TMPDIR}/new_bin"
    export CLEO_BIN_DIR="$test_bin"

    # Reset guard to allow re-sourcing with new CLEO_BIN_DIR
    unset _INSTALLER_LINK_LOADED

    load_installer_lib "core"
    load_installer_lib "link"

    run installer_link_ensure_bin_dir
    # May return 2 (warning) if not in PATH, but directory should be created
    [[ $status -eq 0 ]] || [[ $status -eq 2 ]]
    [[ -d "$test_bin" ]]
}
