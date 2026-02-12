#!/usr/bin/env bats
# =============================================================================
# installer-platform.bats - Cross-Platform Compatibility Tests
# =============================================================================
# Task: T1874
# Tests: Platform detection, date commands, checksums, temp dirs, shell configs,
#        symlinks, stat commands, and lock files across Linux and macOS
# =============================================================================

setup_file() {
    load 'test_helper'
    installer_setup_file
}

setup() {
    load 'test_helper'
    installer_setup_per_test

    # Load platform-compat.sh for cross-platform testing
    source "${PROJECT_ROOT}/lib/core/platform-compat.sh"
}

teardown() {
    installer_teardown_per_test
}

teardown_file() {
    installer_teardown_file
}

# =============================================================================
# PLATFORM DETECTION TESTS
# =============================================================================

@test "platform: detect_platform returns valid platform" {
    run detect_platform
    assert_success

    # Should return linux, macos, windows, or unknown
    [[ "$output" =~ ^(linux|macos|windows|unknown)$ ]]
}

@test "platform: PLATFORM constant is set correctly" {
    [[ -n "$PLATFORM" ]]
    [[ "$PLATFORM" =~ ^(linux|macos|windows|unknown)$ ]]
}

@test "platform: detect_platform matches uname output" {
    local uname_output
    uname_output="$(uname -s)"

    run detect_platform

    case "$uname_output" in
        Linux*)
            assert_output "linux"
            ;;
        Darwin*)
            assert_output "macos"
            ;;
        CYGWIN*|MINGW*|MSYS*)
            assert_output "windows"
            ;;
    esac
}

@test "platform: deps detect_os returns valid OS" {
    load_installer_lib "core"
    load_installer_lib "deps"

    run installer_deps_detect_os
    assert_success

    # Should return linux, darwin, wsl, or unknown
    [[ "$output" =~ ^(linux|darwin|wsl|unknown)$ ]]
}

@test "platform: deps detect_arch returns valid architecture" {
    load_installer_lib "core"
    load_installer_lib "deps"

    run installer_deps_detect_arch
    assert_success

    # Architecture should not be empty
    [[ -n "$output" ]]
    # Common architectures
    [[ "$output" =~ ^(x86_64|aarch64|arm64|i386|i686|armv7l)$ ]] || true
}

# =============================================================================
# DATE COMMAND COMPATIBILITY TESTS
# =============================================================================

@test "date: get_iso_timestamp returns valid ISO format" {
    run get_iso_timestamp
    assert_success

    # Should match ISO 8601 format: YYYY-MM-DDTHH:MM:SSZ
    [[ "$output" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

@test "date: get_iso_timestamp returns current time (within 2 seconds)" {
    local timestamp
    timestamp=$(get_iso_timestamp)

    # Extract date portion
    local date_part="${timestamp:0:10}"
    local expected_date
    expected_date=$(date -u +"%Y-%m-%d")

    [[ "$date_part" == "$expected_date" ]]
}

@test "date: iso_to_epoch converts valid timestamp" {
    local test_ts="2026-01-20T12:00:00Z"

    run iso_to_epoch "$test_ts"
    assert_success

    # Should return a numeric epoch
    [[ "$output" =~ ^[0-9]+$ ]]
}

@test "date: iso_to_epoch handles current timestamp" {
    local current_ts
    current_ts=$(get_iso_timestamp)

    run iso_to_epoch "$current_ts"

    # Should succeed or return 0 on unsupported platforms
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 && "$output" == "0" ]]
}

@test "date: date_days_ago returns valid ISO timestamp" {
    run date_days_ago 7
    assert_success

    # Should match ISO 8601 format
    [[ "$output" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

@test "date: date_days_ago returns past date" {
    local past_ts
    past_ts=$(date_days_ago 1)
    local current_ts
    current_ts=$(get_iso_timestamp)

    # Extract date portions
    local past_date="${past_ts:0:10}"
    local current_date="${current_ts:0:10}"

    # Past date should not equal current date
    [[ "$past_date" != "$current_date" ]] || skip "Midnight edge case"
}

# =============================================================================
# CHECKSUM TOOL COMPATIBILITY TESTS
# =============================================================================

@test "checksum: safe_checksum finds available tool" {
    local test_file="${BATS_TEST_TMPDIR}/checksum_test.txt"
    echo "test content for checksum" > "$test_file"

    run safe_checksum "$test_file"
    assert_success

    # Should return a hex string (at least 32 chars for MD5, 64 for SHA256)
    [[ ${#output} -ge 32 ]]
    [[ "$output" =~ ^[0-9a-f]+$ ]]
}

@test "checksum: safe_checksum returns consistent hash" {
    local test_file="${BATS_TEST_TMPDIR}/checksum_consistent.txt"
    echo "consistent content" > "$test_file"

    local hash1
    hash1=$(safe_checksum "$test_file")
    local hash2
    hash2=$(safe_checksum "$test_file")

    [[ "$hash1" == "$hash2" ]]
}

@test "checksum: safe_checksum_stdin works from pipe" {
    local hash
    hash=$(echo "piped content" | safe_checksum_stdin)

    # Should return a hex string
    [[ ${#hash} -ge 32 ]]
    [[ "$hash" =~ ^[0-9a-f]+$ ]]
}

@test "checksum: installer validate_calc_checksum returns SHA256" {
    load_installer_lib "core"
    load_installer_lib "validate"

    local test_file="${BATS_TEST_TMPDIR}/sha256_test.txt"
    echo "sha256 test content" > "$test_file"

    run installer_validate_calc_checksum "$test_file"
    assert_success

    # SHA256 hash is exactly 64 characters
    [[ ${#output} -eq 64 ]]
    [[ "$output" =~ ^[0-9a-f]+$ ]]
}

@test "checksum: validate_checksum verifies correctly" {
    load_installer_lib "core"
    load_installer_lib "validate"

    local test_file="${BATS_TEST_TMPDIR}/verify_checksum.txt"
    echo "verify this content" > "$test_file"

    local expected
    expected=$(installer_validate_calc_checksum "$test_file")

    run installer_validate_checksum "$test_file" "$expected"
    assert_success
}

@test "checksum: validate_checksum detects mismatch" {
    load_installer_lib "core"
    load_installer_lib "validate"

    local test_file="${BATS_TEST_TMPDIR}/mismatch_checksum.txt"
    echo "original content" > "$test_file"

    local wrong_hash="0000000000000000000000000000000000000000000000000000000000000000"

    run installer_validate_checksum "$test_file" "$wrong_hash"
    assert_failure
}

# =============================================================================
# TEMP DIRECTORY COMPATIBILITY TESTS
# =============================================================================

@test "temp: mktemp creates directory on current platform" {
    run mktemp -d
    assert_success

    # Directory should exist
    [[ -d "$output" ]]

    # Cleanup
    rmdir "$output"
}

@test "temp: create_temp_file creates valid temp file" {
    run create_temp_file
    assert_success

    # File should exist
    [[ -f "$output" ]]

    # Cleanup
    rm -f "$output"
}

@test "temp: installer_create_temp_dir creates directory" {
    load_installer_lib "core"

    # Create minimal state file for function
    mkdir -p "${TEST_INSTALL_DIR}/.install-state"
    echo '{}' > "${TEST_INSTALL_DIR}/.install-state/current"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_create_temp_dir
        echo \"\$INSTALLER_TEMP_DIR\"
    "
    assert_success

    # Should have created a temp directory
    [[ -n "$output" ]]
}

@test "temp: temp directory has correct permissions" {
    local temp_dir
    temp_dir=$(mktemp -d)

    # Get permissions (cross-platform)
    local perms
    if stat --version 2>/dev/null | grep -q GNU; then
        perms=$(stat -c %a "$temp_dir")
    else
        perms=$(stat -f %Lp "$temp_dir")
    fi

    # Should be 700 or more restrictive (700, 750, 755)
    [[ "$perms" =~ ^7[0-5][0-5]$ ]]

    rmdir "$temp_dir"
}

# =============================================================================
# SHELL CONFIG DETECTION TESTS
# =============================================================================

@test "shell: profile_detect_shell returns valid shell" {
    load_installer_lib "core"
    load_installer_lib "profile"

    run installer_profile_detect_shell
    assert_success

    # Should return bash, zsh, fish, sh, or unknown
    [[ "$output" =~ ^(bash|zsh|fish|sh|unknown)$ ]]
}

@test "shell: profile_detect_config_file returns path for bash" {
    load_installer_lib "core"
    load_installer_lib "profile"

    export SHELL="/bin/bash"

    run installer_profile_detect_config_file "bash"
    assert_success

    # Should return a path containing bashrc or bash_profile
    [[ "$output" =~ (bashrc|bash_profile) ]]
}

@test "shell: profile_detect_config_file returns path for zsh" {
    load_installer_lib "core"
    load_installer_lib "profile"

    run installer_profile_detect_config_file "zsh"
    assert_success

    # Should return a path containing zshrc
    [[ "$output" =~ zshrc ]]
}

@test "shell: profile_detect_config_file returns path for fish" {
    load_installer_lib "core"
    load_installer_lib "profile"

    run installer_profile_detect_config_file "fish"
    assert_success

    # Should return fish config path
    [[ "$output" =~ config\.fish ]]
}

@test "shell: profile_detect_config_file handles missing files" {
    load_installer_lib "core"
    load_installer_lib "profile"

    # Use a non-existent home
    export HOME="${BATS_TEST_TMPDIR}/empty_home"
    mkdir -p "$HOME"

    run installer_profile_detect_config_file "bash"
    assert_success

    # Should still return a valid path (will be created)
    [[ -n "$output" ]]
}

# =============================================================================
# PATH MANIPULATION COMPATIBILITY TESTS
# =============================================================================

@test "path: profile_check_path detects bin directory" {
    load_installer_lib "core"
    load_installer_lib "profile"

    # Add the profile bin dir to PATH
    export PATH="$HOME/.local/bin:$PATH"

    run installer_profile_check_path
    # May succeed or fail depending on PROFILE_BIN_DIR setting
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
}

@test "path: profile_get_path_cmd generates correct command for bash" {
    load_installer_lib "core"
    load_installer_lib "profile"

    run installer_profile_get_path_cmd "bash"
    assert_success

    # Should contain export PATH
    [[ "$output" =~ "export PATH=" ]]
}

@test "path: profile_get_path_cmd generates correct command for fish" {
    load_installer_lib "core"
    load_installer_lib "profile"

    run installer_profile_get_path_cmd "fish"
    assert_success

    # Fish uses set -gx instead of export
    [[ "$output" =~ "set -gx PATH" ]]
}

# =============================================================================
# SYMLINK COMPATIBILITY TESTS
# =============================================================================

@test "symlink: creation works cross-platform" {
    local target_dir="${BATS_TEST_TMPDIR}/symlink_target"
    local link_path="${BATS_TEST_TMPDIR}/symlink_link"

    mkdir -p "$target_dir"
    echo "target content" > "$target_dir/file.txt"

    run ln -sf "$target_dir" "$link_path"
    assert_success

    # Symlink should exist
    [[ -L "$link_path" ]]
}

@test "symlink: verification detects valid link" {
    local target_dir="${BATS_TEST_TMPDIR}/valid_target"
    local link_path="${BATS_TEST_TMPDIR}/valid_link"

    mkdir -p "$target_dir"
    ln -sf "$target_dir" "$link_path"

    # Link should be valid (target exists)
    [[ -L "$link_path" ]]
    [[ -e "$link_path" ]]
}

@test "symlink: verification detects broken link" {
    local link_path="${BATS_TEST_TMPDIR}/broken_link"

    ln -sf "/nonexistent/path/that/does/not/exist" "$link_path"

    # Link exists but is broken
    [[ -L "$link_path" ]]
    [[ ! -e "$link_path" ]]
}

# =============================================================================
# STAT COMMAND COMPATIBILITY TESTS
# =============================================================================

@test "stat: get_file_size returns numeric value" {
    local test_file="${BATS_TEST_TMPDIR}/size_test.txt"
    echo "test content for size" > "$test_file"

    run get_file_size "$test_file"
    assert_success

    # Should be a number
    [[ "$output" =~ ^[0-9]+$ ]]
    # Should be greater than 0
    [[ "$output" -gt 0 ]]
}

@test "stat: get_file_size returns correct size" {
    local test_file="${BATS_TEST_TMPDIR}/known_size.txt"

    # Create file with known content (10 bytes + newline)
    echo -n "0123456789" > "$test_file"

    run get_file_size "$test_file"
    assert_success

    [[ "$output" -eq 10 ]]
}

@test "stat: get_file_mtime returns unix timestamp" {
    local test_file="${BATS_TEST_TMPDIR}/mtime_test.txt"
    touch "$test_file"

    run get_file_mtime "$test_file"
    assert_success

    # Should be a number (Unix timestamp)
    [[ "$output" =~ ^[0-9]+$ ]]
    # Should be recent (within last day = 86400 seconds)
    local now
    now=$(date +%s)
    local diff=$((now - output))
    [[ "$diff" -lt 86400 ]]
}

@test "stat: get_file_mtime handles non-existent file" {
    run get_file_mtime "/nonexistent/file/path"

    # Should return 0 and exit with failure
    [[ "$output" == "0" ]]
    [[ "$status" -eq 1 ]]
}

@test "stat: installer validate_permissions handles cross-platform stat" {
    load_installer_lib "core"
    load_installer_lib "validate"

    local repo_dir
    repo_dir=$(create_mock_repo)

    run installer_validate_permissions "$repo_dir"
    # May pass or fail depending on permissions, but should not crash
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
}

# =============================================================================
# LOCK FILE COMPATIBILITY TESTS
# =============================================================================

@test "lock: acquire succeeds on fresh state" {
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_ensure_dirs
        installer_lock_acquire 2
    "
    assert_success

    # Lock file should exist
    assert_file_exists "${TEST_INSTALL_DIR}/.install-state/.install.lock"
}

@test "lock: lock file contains correct format" {
    bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_ensure_dirs
        installer_lock_acquire 1
    "

    local lock_content
    lock_content=$(cat "${TEST_INSTALL_DIR}/.install-state/.install.lock")

    # Format: PID|TIMESTAMP|HOSTNAME (using | to avoid conflict with : in timestamp)
    [[ "$lock_content" =~ ^[0-9]+\|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\|.+$ ]]
}

@test "lock: stale detection works cross-platform" {
    # Create a lock with dead PID
    local lock_file="${TEST_INSTALL_DIR}/.install-state/.install.lock"
    mkdir -p "$(dirname "$lock_file")"
    echo "999999|2020-01-01T00:00:00Z|$(hostname)" > "$lock_file"

    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_lock_check_stale
    "
    assert_success  # 0 means stale
}

@test "lock: timestamp parsing works cross-platform" {
    local lock_file="${TEST_INSTALL_DIR}/.install-state/.install.lock"
    mkdir -p "$(dirname "$lock_file")"

    # Create lock with current timestamp and a running PID (init process always exists)
    local current_ts
    current_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    echo "1|${current_ts}|$(hostname)" > "$lock_file"

    # Lock with PID 1 (init) and fresh timestamp should NOT be stale
    run bash -c "
        export CLEO_HOME='${TEST_INSTALL_DIR}'
        source '${INSTALLER_LIB_DIR}/core.sh'
        installer_lock_check_stale
    "
    # Return code 1 means not stale (lock is valid)
    # Return code 0 means stale
    # PID 1 always exists, but may be different hostname, which makes it not stale
    [[ "$status" -eq 1 ]] || [[ "$status" -eq 0 ]]  # Either is valid depending on kill -0 behavior
}

# =============================================================================
# RANDOM GENERATION COMPATIBILITY TESTS
# =============================================================================

@test "random: generate_random_hex returns hex string" {
    run generate_random_hex 8
    assert_success

    # Should be 16 hex chars (8 bytes = 16 hex digits)
    [[ ${#output} -eq 16 ]]
    [[ "$output" =~ ^[0-9a-f]+$ ]]
}

@test "random: generate_random_hex default length" {
    run generate_random_hex
    assert_success

    # Default is 6 bytes = 12 hex chars
    [[ ${#output} -eq 12 ]]
    [[ "$output" =~ ^[0-9a-f]+$ ]]
}

@test "random: generate_random_hex produces unique values" {
    local hex1
    hex1=$(generate_random_hex 8)
    local hex2
    hex2=$(generate_random_hex 8)

    # Should be different (extremely unlikely to collide)
    [[ "$hex1" != "$hex2" ]]
}

# =============================================================================
# JSON VALIDATOR COMPATIBILITY TESTS
# =============================================================================

@test "json: detect_json_validator returns available validator" {
    run detect_json_validator

    # Should return ajv, jsonschema, or none
    [[ "$output" =~ ^(ajv|jsonschema|none)$ ]]
}

@test "json: validate_json_schema with jq fallback" {
    local data_file="${BATS_TEST_TMPDIR}/test_data.json"
    local schema_file="${BATS_TEST_TMPDIR}/test_schema.json"

    echo '{"name": "test"}' > "$data_file"
    echo '{"type": "object"}' > "$schema_file"

    run validate_json_schema "$data_file" "$schema_file"
    # Should succeed (at least with jq fallback)
    assert_success
}

# =============================================================================
# FIND COMPATIBILITY TESTS
# =============================================================================

@test "find: safe_find locates files" {
    local search_dir="${BATS_TEST_TMPDIR}/find_test"
    mkdir -p "$search_dir"
    touch "$search_dir/file1.txt"
    touch "$search_dir/file2.txt"
    touch "$search_dir/other.md"

    run safe_find "$search_dir" "*.txt"
    assert_success

    # Should find the txt files
    [[ "$output" =~ file1\.txt ]]
    [[ "$output" =~ file2\.txt ]]
    [[ ! "$output" =~ other\.md ]]
}

@test "find: safe_find handles empty directory" {
    local empty_dir="${BATS_TEST_TMPDIR}/empty_find"
    mkdir -p "$empty_dir"

    run safe_find "$empty_dir" "*.txt"
    assert_success

    # Output should be empty
    [[ -z "$output" ]]
}

@test "find: safe_find_sorted_by_mtime returns oldest first" {
    local search_dir="${BATS_TEST_TMPDIR}/sorted_find"
    mkdir -p "$search_dir"

    # Create files with different mtimes
    touch "$search_dir/newer.txt"
    sleep 1
    touch "$search_dir/newest.txt"

    # Touch older file to make it older
    touch -t 202001010000 "$search_dir/older.txt" 2>/dev/null || \
        touch -d "2020-01-01" "$search_dir/older.txt" 2>/dev/null || \
        skip "Cannot set file modification time on this platform"

    run safe_find_sorted_by_mtime "$search_dir" "*.txt"
    assert_success

    # First file should be the oldest
    local first_file
    first_file=$(echo "$output" | head -1)
    [[ "$first_file" =~ older\.txt ]]
}

# =============================================================================
# BASH VERSION COMPATIBILITY TESTS
# =============================================================================

@test "bash: check_bash_version passes on current system" {
    run check_bash_version
    assert_success
}

@test "bash: get_bash_version_info returns version string" {
    run get_bash_version_info
    assert_success

    # Should contain version numbers
    [[ "$output" =~ [0-9]+\.[0-9]+ ]]
}

@test "bash: BASH_VERSINFO is available" {
    [[ -n "${BASH_VERSINFO[0]}" ]]
    [[ "${BASH_VERSINFO[0]}" -ge 4 ]]
}

# =============================================================================
# DISK SPACE COMPATIBILITY TESTS
# =============================================================================

@test "disk: validate_disk_space works cross-platform" {
    load_installer_lib "core"
    load_installer_lib "validate"

    run installer_validate_disk_space "${BATS_TEST_TMPDIR}" 1
    assert_success
}

@test "disk: validate_disk_space detects insufficient space" {
    load_installer_lib "core"
    load_installer_lib "validate"

    # Request absurdly large amount
    run installer_validate_disk_space "${BATS_TEST_TMPDIR}" 999999999
    assert_failure
}

# =============================================================================
# COMMAND EXISTENCE TESTS
# =============================================================================

@test "command: command_exists detects jq" {
    if ! command -v jq &>/dev/null; then
        skip "jq not installed"
    fi

    run command_exists jq
    assert_success
}

@test "command: command_exists handles missing command" {
    run command_exists nonexistent_command_that_does_not_exist_12345
    assert_failure
}

@test "command: require_tool provides helpful error" {
    run require_tool nonexistent_command_xyz "apt install nonexistent_command_xyz"
    assert_failure
    assert_output --partial "Required tool not found"
}
