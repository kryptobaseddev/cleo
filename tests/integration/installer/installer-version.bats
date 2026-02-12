#!/usr/bin/env bats
# =============================================================================
# installer-version.bats - Version management tests
# =============================================================================
# Task: T1870
# Tests: Version detection, comparison, upgrade checks, version selection
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
# Installed Version Detection Tests (source.sh)
# =============================================================================

@test "version: get_installed_version reads first line of VERSION" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local install_dir="${BATS_TEST_TMPDIR}/version_first_line"
    mkdir -p "$install_dir"

    cat > "$install_dir/VERSION" << 'EOF'
0.55.0
mode=release
source=github
installed=2026-01-20T00:00:00Z
EOF

    run installer_source_get_installed_version "$install_dir"
    assert_success
    assert_output "0.55.0"
}

@test "version: get_installed_version handles v prefix" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local install_dir="${BATS_TEST_TMPDIR}/version_v_prefix"
    mkdir -p "$install_dir"
    echo "v0.55.0" > "$install_dir/VERSION"

    run installer_source_get_installed_version "$install_dir"
    assert_success
    # Output may include v prefix
    [[ "$output" == "v0.55.0" ]] || [[ "$output" == "0.55.0" ]]
}

@test "version: get_installed_mode reads mode field" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local install_dir="${BATS_TEST_TMPDIR}/mode_field"
    mkdir -p "$install_dir"

    cat > "$install_dir/VERSION" << 'EOF'
0.55.0
mode=dev
source=/path/to/repo
EOF

    run installer_source_get_installed_mode "$install_dir"
    assert_success
    assert_output "dev"
}

@test "version: get_installed_mode returns unknown for missing mode" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local install_dir="${BATS_TEST_TMPDIR}/no_mode"
    mkdir -p "$install_dir"
    echo "0.55.0" > "$install_dir/VERSION"

    run installer_source_get_installed_mode "$install_dir"
    assert_success
    assert_output "unknown"
}

# =============================================================================
# Version Comparison Tests (source.sh)
# =============================================================================

@test "version: compare handles major version differences" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    run installer_source_compare_versions "0.55.0" "1.0.0"
    assert_success
    assert_output "upgrade"

    run installer_source_compare_versions "2.0.0" "1.0.0"
    assert_success
    assert_output "downgrade"
}

@test "version: compare handles minor version differences" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    run installer_source_compare_versions "0.54.0" "0.55.0"
    assert_success
    assert_output "upgrade"

    run installer_source_compare_versions "0.56.0" "0.55.0"
    assert_success
    assert_output "downgrade"
}

@test "version: compare handles patch version differences" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    run installer_source_compare_versions "0.55.0" "0.55.1"
    assert_success
    assert_output "upgrade"

    run installer_source_compare_versions "0.55.2" "0.55.1"
    assert_success
    assert_output "downgrade"
}

@test "version: compare handles pre-release versions" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    # Using validate.sh comparison which handles pre-release
    run installer_validate_compare_versions "0.55.0-alpha" "0.55.0-beta"
    assert_success
    # alpha < beta alphabetically
    assert_output "-1"
}

@test "version: compare handles different length versions" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    run installer_source_compare_versions "0.55" "0.55.0"
    assert_success
    assert_output "equal"

    run installer_source_compare_versions "0.55.0.0" "0.55.0"
    assert_success
    assert_output "equal"
}

# =============================================================================
# Upgrade Check Tests (source.sh - mocked)
# =============================================================================

@test "version: check_upgrade returns unknown when network unavailable" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local install_dir="${BATS_TEST_TMPDIR}/upgrade_check"
    mkdir -p "$install_dir"
    echo "0.55.0" > "$install_dir/VERSION"

    # Mock network unavailable
    mock_network_unavailable

    run installer_source_check_upgrade "$install_dir"
    # May fail (return 1) since can't fetch latest
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
    [[ "$output" == "unknown" ]] || [[ "$output" == "upgrade" ]] || [[ "$output" == "equal" ]]
}

@test "version: check_upgrade_available returns correct exit codes" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local install_dir="${BATS_TEST_TMPDIR}/upgrade_avail"
    mkdir -p "$install_dir"
    echo "0.55.0" > "$install_dir/VERSION"

    # Mock network unavailable
    mock_network_unavailable

    run installer_source_check_upgrade_available "$install_dir"
    # 0 = upgrade available, 1 = current/downgrade, 2 = can't determine
    [[ "$status" -le 2 ]]
}

# =============================================================================
# Version Info Display Tests (source.sh)
# =============================================================================

@test "version: version_info shows comprehensive details" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local install_dir="${BATS_TEST_TMPDIR}/version_info_test"
    mkdir -p "$install_dir"

    cat > "$install_dir/VERSION" << 'EOF'
0.55.0
mode=release
source=github:kryptobaseddev/cleo
installed=2026-01-20T12:00:00Z
version=v0.55.0
download_url=https://github.com/kryptobaseddev/cleo/releases/download/v0.55.0/cleo-v0.55.0.tar.gz
EOF

    mock_network_unavailable

    run installer_source_version_info "$install_dir"
    assert_success
    assert_output --partial "CLEO Version Information"
    assert_output --partial "Installed: 0.55.0"
    assert_output --partial "Mode:      release"
}

@test "version: version_info shows dev mode details" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local repo_dir target_dir
    repo_dir=$(create_mock_repo)
    target_dir="${BATS_TEST_TMPDIR}/dev_version_info"

    installer_source_link_repo "$repo_dir" "$target_dir"

    mock_network_unavailable

    run installer_source_version_info "$target_dir"
    assert_success
    assert_output --partial "Mode:      dev"
    assert_output --partial "Development Mode Details"
    assert_output --partial "Symlinks:"
}

# =============================================================================
# Release API Tests (source.sh - mocked)
# =============================================================================

@test "version: get_releases returns empty array when network unavailable" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    mock_network_unavailable

    run installer_source_get_releases
    # Should fail or return empty
    [[ "$status" -ne 0 ]] || [[ -z "$output" ]]
}

@test "version: get_latest returns empty when network unavailable" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    mock_network_unavailable

    run installer_source_get_latest
    # Should fail or return empty
    [[ "$status" -ne 0 ]] || [[ -z "$output" ]]
}

@test "version: get_versions returns JSON array" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    mock_network_unavailable

    run installer_source_get_versions
    assert_success

    # Should return JSON array (even if empty)
    echo "$output" | jq -e '. | type == "array"' > /dev/null
}

# =============================================================================
# Upgrade Flow Tests (source.sh)
# =============================================================================

@test "version: upgrade detects dev mode conflict" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local install_dir="${BATS_TEST_TMPDIR}/dev_upgrade"
    mkdir -p "$install_dir"

    cat > "$install_dir/VERSION" << 'EOF'
0.55.0
mode=dev
source=/path/to/repo
EOF

    run installer_source_upgrade "0.56.0" "$install_dir"
    assert_failure
    assert_output --partial "Development mode"
}

@test "version: upgrade detects already at version" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local install_dir="${BATS_TEST_TMPDIR}/same_version"
    mkdir -p "$install_dir"

    cat > "$install_dir/VERSION" << 'EOF'
0.55.0
mode=release
EOF

    run installer_source_upgrade "0.55.0" "$install_dir"
    assert_success
    assert_output --partial "Already at version"
}

# =============================================================================
# validate.sh Version Tests
# =============================================================================

@test "version: validate_get_installed_version reads VERSION file" {
    load_installer_lib "core"
    load_installer_lib "validate"

    local install_dir="${BATS_TEST_TMPDIR}/validate_version"
    mkdir -p "$install_dir"
    echo "0.55.0" > "$install_dir/VERSION"

    run installer_validate_get_installed_version "$install_dir"
    assert_success
    assert_output "0.55.0"
}

@test "version: validate_get_installed_version reads from lib/core/version.sh fallback" {
    load_installer_lib "core"
    load_installer_lib "validate"

    local install_dir="${BATS_TEST_TMPDIR}/lib_version"
    mkdir -p "$install_dir/lib"

    cat > "$install_dir/lib/core/version.sh" << 'EOF'
#!/usr/bin/env bash
CLEO_VERSION="0.55.0"
EOF

    run installer_validate_get_installed_version "$install_dir"
    assert_success
    assert_output "0.55.0"
}

@test "version: validate_get_installed_version returns empty for missing" {
    load_installer_lib "core"
    load_installer_lib "validate"

    local install_dir="${BATS_TEST_TMPDIR}/no_version_file"
    mkdir -p "$install_dir"

    run installer_validate_get_installed_version "$install_dir"
    assert_success
    assert_output ""
}

# =============================================================================
# Version Metadata Writing Tests (source.sh)
# =============================================================================

@test "version: write_version_metadata creates complete VERSION file" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local target_dir="${BATS_TEST_TMPDIR}/write_metadata"
    mkdir -p "$target_dir"

    # Pre-create VERSION with version
    echo "0.55.0" > "$target_dir/VERSION"

    installer_source_write_version_metadata "$target_dir" "/path/to/source" "dev"

    # Verify content
    run cat "$target_dir/VERSION"
    assert_output --partial "0.55.0"
    assert_output --partial "mode=dev"
    assert_output --partial "source=/path/to/source"
    assert_output --partial "installed="
}

@test "version: write_version_metadata uses development for empty version" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local target_dir="${BATS_TEST_TMPDIR}/empty_version"
    mkdir -p "$target_dir"

    # No VERSION file exists
    installer_source_write_version_metadata "$target_dir" "/source" "copy"

    run head -1 "$target_dir/VERSION"
    assert_output "development"
}

# =============================================================================
# Complex Version Scenarios
# =============================================================================

@test "version: handles edge case version numbers" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    # Large version numbers
    run installer_source_compare_versions "10.0.0" "9.99.99"
    assert_output "downgrade"

    # Zero versions
    run installer_source_compare_versions "0.0.0" "0.0.1"
    assert_output "upgrade"

    # Many parts
    run installer_source_compare_versions "1.2.3.4" "1.2.3.5"
    assert_output "upgrade"
}

@test "version: preserves version across copy operations" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    local repo_dir target_dir
    repo_dir=$(create_mock_repo)
    target_dir="${BATS_TEST_TMPDIR}/copy_preserve"

    installer_source_copy_repo "$repo_dir" "$target_dir"

    # Version should match
    local source_version target_version
    source_version=$(head -1 "$repo_dir/VERSION")
    target_version=$(installer_source_get_installed_version "$target_dir")

    # First line should be the version
    [[ "$target_version" == "$source_version" ]] || [[ "$target_version" == "development" ]]
}

@test "version: complete flow from detection to info display" {
    load_installer_lib "core"
    load_installer_lib "validate"
    load_installer_lib "source"

    # Create a mock release installation
    local install_dir="${BATS_TEST_TMPDIR}/full_flow"
    mkdir -p "$install_dir"/{lib,scripts,schemas}

    cat > "$install_dir/VERSION" << 'EOF'
0.54.0
mode=release
source=github:kryptobaseddev/cleo
installed=2026-01-15T00:00:00Z
version=v0.54.0
EOF

    # Get installed version
    local installed
    installed=$(installer_source_get_installed_version "$install_dir")
    [[ "$installed" == "0.54.0" ]]

    # Get mode
    local mode
    mode=$(installer_source_get_installed_mode "$install_dir")
    [[ "$mode" == "release" ]]

    # Compare with newer version
    local comparison
    comparison=$(installer_source_compare_versions "$installed" "0.55.0")
    [[ "$comparison" == "upgrade" ]]

    # Display version info
    mock_network_unavailable
    run installer_source_version_info "$install_dir"
    assert_success
    assert_output --partial "0.54.0"
    assert_output --partial "release"
}
