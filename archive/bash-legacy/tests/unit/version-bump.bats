#!/usr/bin/env bats
# =============================================================================
# version-bump.bats - Unit tests for portable version bump library
# =============================================================================
# Tests validate_version_format, calculate_new_version, check_version_bump_configured,
# bump_version_from_config and all four strategies (plain, json, toml, sed)
# from lib/release/version-bump.sh
# =============================================================================

setup() {
    load '../test_helper/common_setup'
    common_setup_per_test

    export VB_TEST_DIR="${BATS_TEST_TMPDIR}/version-bump-$$"
    mkdir -p "$VB_TEST_DIR"

    # Source the library under test
    source "$PROJECT_ROOT/lib/release/version-bump.sh"
}

teardown() {
    common_teardown
    rm -rf "$VB_TEST_DIR"
}

# Helper: create a config file with versionBump config
create_bump_config() {
    local config_file="$1"
    shift
    # Remaining args are the files array JSON
    local files_json="$1"
    local pre_validate="${2:-}"
    local post_validate="${3:-}"

    local pre_field=""
    local post_field=""
    [[ -n "$pre_validate" ]] && pre_field=", \"preValidate\": \"$pre_validate\""
    [[ -n "$post_validate" ]] && post_field=", \"postValidate\": \"$post_validate\""

    cat > "$config_file" <<CONFIGEOF
{
  "version": "2.10.0",
  "release": {
    "versionBump": {
      "enabled": true,
      "files": $files_json
      $pre_field
      $post_field
    }
  }
}
CONFIGEOF
}

# =============================================================================
# validate_version_format tests
# =============================================================================

@test "validate_version_format: accepts valid semver" {
    run validate_version_format "1.2.3"
    assert_success
}

@test "validate_version_format: accepts zero version" {
    run validate_version_format "0.0.0"
    assert_success
}

@test "validate_version_format: accepts large numbers" {
    run validate_version_format "100.200.300"
    assert_success
}

@test "validate_version_format: rejects v prefix" {
    run validate_version_format "v1.2.3"
    assert_failure
    assert_output --partial "Invalid version format"
}

@test "validate_version_format: rejects two-part version" {
    run validate_version_format "1.2"
    assert_failure
    assert_output --partial "Invalid version format"
}

@test "validate_version_format: rejects empty string" {
    run validate_version_format ""
    assert_failure
}

@test "validate_version_format: rejects alpha characters" {
    run validate_version_format "1.2.3-beta"
    assert_failure
}

# =============================================================================
# calculate_new_version tests
# =============================================================================

@test "calculate_new_version: patch bump" {
    run calculate_new_version "1.2.3" "patch"
    assert_success
    assert_output "1.2.4"
}

@test "calculate_new_version: minor bump" {
    run calculate_new_version "1.2.3" "minor"
    assert_success
    assert_output "1.3.0"
}

@test "calculate_new_version: major bump" {
    run calculate_new_version "1.2.3" "major"
    assert_success
    assert_output "2.0.0"
}

@test "calculate_new_version: explicit version passthrough" {
    run calculate_new_version "1.2.3" "5.6.7"
    assert_success
    assert_output "5.6.7"
}

@test "calculate_new_version: rejects invalid explicit version" {
    run calculate_new_version "1.2.3" "not-a-version"
    assert_failure
}

@test "calculate_new_version: patch from zero" {
    run calculate_new_version "0.0.0" "patch"
    assert_success
    assert_output "0.0.1"
}

# =============================================================================
# check_version_bump_configured tests
# =============================================================================

@test "check_version_bump_configured: returns false for missing config file" {
    run check_version_bump_configured "$VB_TEST_DIR/nonexistent.json"
    assert_failure
    assert_output --partial "Version bump not configured"
}

@test "check_version_bump_configured: returns false for empty files array" {
    create_bump_config "$VB_TEST_DIR/config.json" "[]"
    run check_version_bump_configured "$VB_TEST_DIR/config.json"
    assert_failure
    assert_output --partial "Version bump not configured"
}

@test "check_version_bump_configured: returns false when disabled" {
    cat > "$VB_TEST_DIR/config.json" <<'EOF'
{
  "release": {
    "versionBump": {
      "enabled": false,
      "files": [{"path": "VERSION", "strategy": "plain"}]
    }
  }
}
EOF
    run check_version_bump_configured "$VB_TEST_DIR/config.json"
    assert_failure
    assert_output --partial "disabled"
}

@test "check_version_bump_configured: returns true when properly configured" {
    create_bump_config "$VB_TEST_DIR/config.json" '[{"path": "VERSION", "strategy": "plain"}]'
    run check_version_bump_configured "$VB_TEST_DIR/config.json"
    assert_success
}

@test "check_version_bump_configured: actionable error lists common examples" {
    run check_version_bump_configured "$VB_TEST_DIR/nonexistent.json"
    assert_failure
    assert_output --partial "Node.js"
    assert_output --partial "Rust"
    assert_output --partial "Python"
    assert_output --partial "package.json"
}

# =============================================================================
# bump_version_from_config: plain strategy
# =============================================================================

@test "bump plain strategy: updates VERSION file" {
    echo "1.0.0" > "$VB_TEST_DIR/VERSION"
    create_bump_config "$VB_TEST_DIR/config.json" '[{"path": "'"$VB_TEST_DIR"'/VERSION", "strategy": "plain"}]'

    run bump_version_from_config "1.0.1" "false" "$VB_TEST_DIR/config.json"
    assert_success

    # Verify file content
    local content
    content=$(cat "$VB_TEST_DIR/VERSION")
    [[ "$content" == "1.0.1" ]]
}

@test "bump plain strategy: dry run does not modify file" {
    echo "1.0.0" > "$VB_TEST_DIR/VERSION"
    create_bump_config "$VB_TEST_DIR/config.json" '[{"path": "'"$VB_TEST_DIR"'/VERSION", "strategy": "plain"}]'

    run bump_version_from_config "1.0.1" "true" "$VB_TEST_DIR/config.json"
    assert_success

    local content
    content=$(cat "$VB_TEST_DIR/VERSION")
    [[ "$content" == "1.0.0" ]]
}

@test "bump plain strategy: result JSON reports success" {
    echo "1.0.0" > "$VB_TEST_DIR/VERSION"
    create_bump_config "$VB_TEST_DIR/config.json" '[{"path": "'"$VB_TEST_DIR"'/VERSION", "strategy": "plain"}]'

    run bump_version_from_config "1.0.1" "false" "$VB_TEST_DIR/config.json"
    assert_success

    local success
    success=$(echo "$output" | jq -r '.success')
    [[ "$success" == "true" ]]

    local files_updated
    files_updated=$(echo "$output" | jq -r '.filesUpdated')
    [[ "$files_updated" == "1" ]]
}

# =============================================================================
# bump_version_from_config: json strategy
# =============================================================================

@test "bump json strategy: updates package.json .version" {
    cat > "$VB_TEST_DIR/package.json" <<'EOF'
{
  "name": "my-app",
  "version": "1.0.0",
  "description": "test"
}
EOF
    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/package.json", "strategy": "json", "jsonPath": ".version"}]'

    run bump_version_from_config "2.0.0" "false" "$VB_TEST_DIR/config.json"
    assert_success

    local version
    version=$(jq -r '.version' "$VB_TEST_DIR/package.json")
    [[ "$version" == "2.0.0" ]]
}

@test "bump json strategy: preserves other fields" {
    cat > "$VB_TEST_DIR/package.json" <<'EOF'
{
  "name": "my-app",
  "version": "1.0.0",
  "description": "test"
}
EOF
    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/package.json", "strategy": "json", "jsonPath": ".version"}]'

    run bump_version_from_config "2.0.0" "false" "$VB_TEST_DIR/config.json"
    assert_success

    local name
    name=$(jq -r '.name' "$VB_TEST_DIR/package.json")
    [[ "$name" == "my-app" ]]

    local desc
    desc=$(jq -r '.description' "$VB_TEST_DIR/package.json")
    [[ "$desc" == "test" ]]
}

@test "bump json strategy: nested jsonPath works" {
    cat > "$VB_TEST_DIR/plugin.json" <<'EOF'
{
  "name": "my-plugin",
  "metadata": {
    "version": "0.5.0"
  }
}
EOF
    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/plugin.json", "strategy": "json", "jsonPath": ".metadata.version"}]'

    run bump_version_from_config "0.6.0" "false" "$VB_TEST_DIR/config.json"
    assert_success

    local version
    version=$(jq -r '.metadata.version' "$VB_TEST_DIR/plugin.json")
    [[ "$version" == "0.6.0" ]]
}

# =============================================================================
# bump_version_from_config: toml strategy
# =============================================================================

@test "bump toml strategy: updates Cargo.toml package.version" {
    cat > "$VB_TEST_DIR/Cargo.toml" <<'EOF'
[package]
name = "my-crate"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = "1.0"
EOF
    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/Cargo.toml", "strategy": "toml", "tomlKey": "package.version"}]'

    run bump_version_from_config "0.2.0" "false" "$VB_TEST_DIR/config.json"
    assert_success

    run grep 'version = "0.2.0"' "$VB_TEST_DIR/Cargo.toml"
    assert_success
}

@test "bump toml strategy: does not change other sections" {
    cat > "$VB_TEST_DIR/Cargo.toml" <<'EOF'
[package]
name = "my-crate"
version = "0.1.0"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
EOF
    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/Cargo.toml", "strategy": "toml", "tomlKey": "package.version"}]'

    run bump_version_from_config "0.2.0" "false" "$VB_TEST_DIR/config.json"
    assert_success

    # The serde version should be untouched
    run grep 'version = "1.0"' "$VB_TEST_DIR/Cargo.toml"
    assert_success
}

@test "bump toml strategy: fails for missing section" {
    cat > "$VB_TEST_DIR/Cargo.toml" <<'EOF'
[dependencies]
serde = "1.0"
EOF
    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/Cargo.toml", "strategy": "toml", "tomlKey": "package.version"}]'

    run bump_version_from_config "0.2.0" "false" "$VB_TEST_DIR/config.json"
    assert_failure
}

# =============================================================================
# bump_version_from_config: sed strategy
# =============================================================================

@test "bump sed strategy: updates README badge" {
    cat > "$VB_TEST_DIR/README.md" <<'EOF'
# My Project

![Version](https://img.shields.io/badge/version-1.0.0-blue)

Some content here.
EOF
    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/README.md", "strategy": "sed", "sedPattern": "s|version-[0-9]\\+\\.[0-9]\\+\\.[0-9]\\+-|version-{{VERSION}}-|g", "sedMatch": "version-[0-9]", "optional": true}]'

    run bump_version_from_config "2.0.0" "false" "$VB_TEST_DIR/config.json"
    assert_success

    run grep "version-2.0.0-" "$VB_TEST_DIR/README.md"
    assert_success
}

@test "bump sed strategy: fails if sedMatch pattern not found" {
    echo "No version badge here" > "$VB_TEST_DIR/README.md"
    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/README.md", "strategy": "sed", "sedPattern": "s|version-[0-9]\\+-|version-{{VERSION}}-|g", "sedMatch": "version-[0-9]"}]'

    run bump_version_from_config "2.0.0" "false" "$VB_TEST_DIR/config.json"
    assert_failure
}

@test "bump sed strategy: fails if sedPattern is missing" {
    echo "content" > "$VB_TEST_DIR/file.txt"
    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/file.txt", "strategy": "sed"}]'

    run bump_version_from_config "1.0.0" "false" "$VB_TEST_DIR/config.json"
    assert_failure
}

# =============================================================================
# bump_version_from_config: multi-file
# =============================================================================

@test "bump multi-file: updates all configured files" {
    echo "1.0.0" > "$VB_TEST_DIR/VERSION"
    cat > "$VB_TEST_DIR/package.json" <<'EOF'
{"name": "test", "version": "1.0.0"}
EOF

    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/VERSION", "strategy": "plain"}, {"path": "'"$VB_TEST_DIR"'/package.json", "strategy": "json", "jsonPath": ".version"}]'

    run bump_version_from_config "2.0.0" "false" "$VB_TEST_DIR/config.json"
    assert_success

    local version_content
    version_content=$(cat "$VB_TEST_DIR/VERSION")
    [[ "$version_content" == "2.0.0" ]]

    local pkg_version
    pkg_version=$(jq -r '.version' "$VB_TEST_DIR/package.json")
    [[ "$pkg_version" == "2.0.0" ]]

    # Check result JSON
    local files_updated
    files_updated=$(echo "$output" | jq -r '.filesUpdated')
    [[ "$files_updated" == "2" ]]
}

@test "bump multi-file: optional missing file is skipped" {
    echo "1.0.0" > "$VB_TEST_DIR/VERSION"

    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/VERSION", "strategy": "plain"}, {"path": "'"$VB_TEST_DIR"'/optional-file.txt", "strategy": "plain", "optional": true}]'

    run bump_version_from_config "2.0.0" "false" "$VB_TEST_DIR/config.json"
    assert_success

    local files_skipped
    files_skipped=$(echo "$output" | jq -r '.filesSkipped')
    [[ "$files_skipped" == "1" ]]

    local files_updated
    files_updated=$(echo "$output" | jq -r '.filesUpdated')
    [[ "$files_updated" == "1" ]]
}

@test "bump multi-file: required missing file fails entire bump" {
    echo "1.0.0" > "$VB_TEST_DIR/VERSION"

    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/VERSION", "strategy": "plain"}, {"path": "'"$VB_TEST_DIR"'/required-missing.txt", "strategy": "plain"}]'

    run bump_version_from_config "2.0.0" "false" "$VB_TEST_DIR/config.json"
    assert_failure

    # VERSION should be restored (rollback)
    local content
    content=$(cat "$VB_TEST_DIR/VERSION")
    [[ "$content" == "1.0.0" ]]
}

# =============================================================================
# bump_version_from_config: backup and restore
# =============================================================================

@test "bump restores backups on failure" {
    echo "1.0.0" > "$VB_TEST_DIR/VERSION"
    cat > "$VB_TEST_DIR/package.json" <<'EOF'
{"name": "test", "version": "1.0.0"}
EOF

    # Second file will fail (strategy=toml on a JSON file with no [section])
    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/VERSION", "strategy": "plain"}, {"path": "'"$VB_TEST_DIR"'/package.json", "strategy": "toml", "tomlKey": "package.version"}]'

    run bump_version_from_config "2.0.0" "false" "$VB_TEST_DIR/config.json"
    assert_failure

    # Both files should be restored
    local version_content
    version_content=$(cat "$VB_TEST_DIR/VERSION")
    [[ "$version_content" == "1.0.0" ]]

    local pkg_version
    pkg_version=$(jq -r '.version' "$VB_TEST_DIR/package.json")
    [[ "$pkg_version" == "1.0.0" ]]
}

@test "bump cleans up .vb-bak files on success" {
    echo "1.0.0" > "$VB_TEST_DIR/VERSION"
    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/VERSION", "strategy": "plain"}]'

    run bump_version_from_config "2.0.0" "false" "$VB_TEST_DIR/config.json"
    assert_success

    # No backup files should remain
    [[ ! -f "$VB_TEST_DIR/VERSION.vb-bak" ]]
}

# =============================================================================
# bump_version_from_config: validation commands
# =============================================================================

@test "bump with pre-validate: succeeds when command passes" {
    echo "1.0.0" > "$VB_TEST_DIR/VERSION"
    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/VERSION", "strategy": "plain"}]' \
        "true"

    run bump_version_from_config "2.0.0" "false" "$VB_TEST_DIR/config.json"
    assert_success
}

@test "bump with pre-validate: fails when command fails" {
    echo "1.0.0" > "$VB_TEST_DIR/VERSION"
    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/VERSION", "strategy": "plain"}]' \
        "false"

    run bump_version_from_config "2.0.0" "false" "$VB_TEST_DIR/config.json"
    assert_failure

    # File should not be modified
    local content
    content=$(cat "$VB_TEST_DIR/VERSION")
    [[ "$content" == "1.0.0" ]]
}

# =============================================================================
# bump_version_from_config: invalid version
# =============================================================================

@test "bump rejects invalid version format" {
    echo "1.0.0" > "$VB_TEST_DIR/VERSION"
    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/VERSION", "strategy": "plain"}]'

    run bump_version_from_config "not-a-version" "false" "$VB_TEST_DIR/config.json"
    assert_failure
}

# =============================================================================
# bump_version_from_config: dry run result JSON
# =============================================================================

@test "bump dry run: result JSON shows would-update status" {
    echo "1.0.0" > "$VB_TEST_DIR/VERSION"
    create_bump_config "$VB_TEST_DIR/config.json" \
        '[{"path": "'"$VB_TEST_DIR"'/VERSION", "strategy": "plain"}]'

    run bump_version_from_config "2.0.0" "true" "$VB_TEST_DIR/config.json"
    assert_success

    local status
    status=$(echo "$output" | jq -r '.files[0].status')
    [[ "$status" == "would-update" ]]

    local dry_run
    dry_run=$(echo "$output" | jq -r '.dryRun')
    [[ "$dry_run" == "true" ]]
}
