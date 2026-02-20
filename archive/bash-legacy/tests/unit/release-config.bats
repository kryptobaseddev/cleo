#!/usr/bin/env bats
# =============================================================================
# release-config.bats - Release config loader unit tests
# @task T2669
# =============================================================================
# Tests for:
# - load_release_config
# - validate_release_config
# - get_artifact_type
# - get_release_gates
# - get_changelog_config
# - get_versioning_config
# - get_security_config
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

teardown_file() {
    common_teardown_file
}

setup() {
    load '../test_helper/common_setup'
    common_setup_per_test

    # Create temp directory for test configs
    TEST_DIR="$(mktemp -d)"
    export CONFIG_FILE="$TEST_DIR/config.json"
    export PROJECT_CONFIG_FILE="$CONFIG_FILE"

    # Source the library (use absolute path from PROJECT_ROOT)
    source "${PROJECT_ROOT}/lib/release/release-config.sh"
}

teardown() {
    # Clean up temp directory
    rm -rf "$TEST_DIR"

    common_teardown_per_test
}

# ============================================================================
# load_release_config Tests
# ============================================================================

@test "load_release_config: loads full release config" {
    cat > "$CONFIG_FILE" << 'EOF'
{
  "_meta": { "schemaVersion": "2.10.0" },
  "version": "2.10.0",
  "release": {
    "versioning": {
      "scheme": "semver",
      "semver": {
        "tagPrefix": "v",
        "prereleaseTags": ["alpha", "beta"]
      }
    },
    "changelog": {
      "format": "keepachangelog",
      "file": "CHANGELOG.md"
    },
    "artifacts": [
      {
        "type": "npm-package",
        "enabled": true,
        "registry": "https://registry.npmjs.org"
      }
    ],
    "gates": [
      {
        "name": "tests",
        "command": "npm test",
        "required": true
      }
    ]
  }
}
EOF

    run load_release_config
    assert_success
    assert_output --partial '"versioning"'
    assert_output --partial '"changelog"'
    assert_output --partial '"artifacts"'
    assert_output --partial '"gates"'
}

@test "load_release_config: returns empty object for missing release section" {
    cat > "$CONFIG_FILE" << 'EOF'
{
  "_meta": { "schemaVersion": "2.10.0" },
  "version": "2.10.0"
}
EOF

    run load_release_config
    assert_success
    assert_output "{}"
}

@test "load_release_config: fails when config file not found" {
    CONFIG_FILE="$TEST_DIR/nonexistent.json"

    run load_release_config
    assert_failure
    assert_output --partial "Config file not found"
}

# ============================================================================
# validate_release_config Tests
# ============================================================================

@test "validate_release_config: accepts valid semver config" {
    local config
    config=$(cat << 'EOF'
{
  "versioning": {
    "scheme": "semver",
    "semver": {
      "tagPrefix": "v",
      "prereleaseTags": ["alpha", "beta", "rc"]
    }
  }
}
EOF
)

    run validate_release_config "$config"
    assert_success
}

@test "validate_release_config: accepts valid calver config" {
    local config
    config=$(cat << 'EOF'
{
  "versioning": {
    "scheme": "calver",
    "calver": {
      "format": "YY.MINOR.MICRO",
      "yearFormat": "YY"
    }
  }
}
EOF
)

    run validate_release_config "$config"
    assert_success
}

@test "validate_release_config: rejects invalid versioning scheme" {
    local config
    config=$(cat << 'EOF'
{
  "versioning": {
    "scheme": "invalid"
  }
}
EOF
)

    run validate_release_config "$config"
    assert_failure
    assert_output --partial "Invalid versioning.scheme"
}

@test "validate_release_config: accepts valid changelog format" {
    local config
    config=$(cat << 'EOF'
{
  "changelog": {
    "format": "conventional"
  }
}
EOF
)

    run validate_release_config "$config"
    assert_success
}

@test "validate_release_config: rejects invalid changelog format" {
    local config
    config=$(cat << 'EOF'
{
  "changelog": {
    "format": "invalid"
  }
}
EOF
)

    run validate_release_config "$config"
    assert_failure
    assert_output --partial "Invalid changelog.format"
}

@test "validate_release_config: accepts valid artifact types" {
    local config
    config=$(cat << 'EOF'
{
  "artifacts": [
    { "type": "npm-package" },
    { "type": "docker-image" },
    { "type": "python-wheel" }
  ]
}
EOF
)

    run validate_release_config "$config"
    assert_success
}

@test "validate_release_config: rejects invalid artifact type" {
    local config
    config=$(cat << 'EOF'
{
  "artifacts": [
    { "type": "invalid-type" }
  ]
}
EOF
)

    run validate_release_config "$config"
    assert_failure
    assert_output --partial "Invalid artifact type"
}

@test "validate_release_config: rejects artifact missing type field" {
    local config
    config=$(cat << 'EOF'
{
  "artifacts": [
    { "enabled": true }
  ]
}
EOF
)

    run validate_release_config "$config"
    assert_failure
    assert_output --partial "missing required 'type' field"
}

@test "validate_release_config: accepts valid gates" {
    local config
    config=$(cat << 'EOF'
{
  "gates": [
    {
      "name": "tests",
      "command": "npm test",
      "required": true
    },
    {
      "name": "lint",
      "command": "npm run lint"
    }
  ]
}
EOF
)

    run validate_release_config "$config"
    assert_success
}

@test "validate_release_config: rejects gate missing name" {
    local config
    config=$(cat << 'EOF'
{
  "gates": [
    {
      "command": "npm test"
    }
  ]
}
EOF
)

    run validate_release_config "$config"
    assert_failure
    assert_output --partial "missing required 'name' field"
}

@test "validate_release_config: rejects gate missing command" {
    local config
    config=$(cat << 'EOF'
{
  "gates": [
    {
      "name": "tests"
    }
  ]
}
EOF
)

    run validate_release_config "$config"
    assert_failure
    assert_output --partial "missing required 'command' field"
}

@test "validate_release_config: rejects invalid gate name pattern" {
    local config
    config=$(cat << 'EOF'
{
  "gates": [
    {
      "name": "Invalid Name",
      "command": "test"
    }
  ]
}
EOF
)

    run validate_release_config "$config"
    assert_failure
    assert_output --partial "must match pattern"
}

@test "validate_release_config: accepts empty config" {
    run validate_release_config "{}"
    assert_success
}

# ============================================================================
# get_artifact_type Tests
# ============================================================================

@test "get_artifact_type: returns configured artifact types" {
    local config
    config=$(cat << 'EOF'
{
  "artifacts": [
    { "type": "npm-package", "enabled": true },
    { "type": "docker-image", "enabled": true }
  ]
}
EOF
)

    run get_artifact_type "$config"
    assert_success
    assert_output '["npm-package","docker-image"]'
}

@test "get_artifact_type: excludes disabled artifacts" {
    local config
    config=$(cat << 'EOF'
{
  "artifacts": [
    { "type": "npm-package", "enabled": true },
    { "type": "docker-image", "enabled": false }
  ]
}
EOF
)

    run get_artifact_type "$config"
    assert_success
    assert_output '["npm-package"]'
}

@test "get_artifact_type: returns default for empty artifacts" {
    local config="{}"

    run get_artifact_type "$config"
    assert_success
    assert_output '["generic-tarball"]'
}

# ============================================================================
# get_release_gates Tests
# ============================================================================

@test "get_release_gates: returns configured gates" {
    local config
    config=$(cat << 'EOF'
{
  "gates": [
    {
      "name": "tests",
      "command": "npm test",
      "required": true
    }
  ]
}
EOF
)

    run get_release_gates "$config"
    assert_success
    assert_output --partial '"name":"tests"'
    assert_output --partial '"command":"npm test"'
}

@test "get_release_gates: returns empty array for no gates" {
    local config="{}"

    run get_release_gates "$config"
    assert_success
    assert_output "[]"
}

@test "get_release_gates: warns about deprecated validation.releaseGates" {
    cat > "$CONFIG_FILE" << 'EOF'
{
  "_meta": { "schemaVersion": "2.10.0" },
  "version": "2.10.0",
  "validation": {
    "releaseGates": [
      {
        "name": "legacy-test",
        "command": "test"
      }
    ]
  }
}
EOF

    run get_release_gates
    assert_success
    assert_output --partial "DEPRECATION WARNING"
    assert_output --partial "validation.releaseGates"
    assert_output --partial "legacy-test"
}

# ============================================================================
# get_changelog_config Tests
# ============================================================================

@test "get_changelog_config: returns configured changelog settings" {
    local config
    config=$(cat << 'EOF'
{
  "changelog": {
    "format": "conventional",
    "file": "CHANGES.md",
    "autoGenerate": false
  }
}
EOF
)

    run get_changelog_config "$config"
    assert_success
    assert_output --partial '"format": "conventional"'
    assert_output --partial '"file": "CHANGES.md"'
    assert_output --partial '"autoGenerate": false'
}

@test "get_changelog_config: returns defaults for empty config" {
    local config="{}"

    run get_changelog_config "$config"
    assert_success
    assert_output --partial '"format": "keepachangelog"'
    assert_output --partial '"file": "CHANGELOG.md"'
    assert_output --partial '"autoGenerate": true'
    assert_output --partial '"sections"'
}

# ============================================================================
# get_versioning_config Tests
# ============================================================================

@test "get_versioning_config: returns configured versioning settings" {
    local config
    config=$(cat << 'EOF'
{
  "versioning": {
    "scheme": "calver",
    "calver": {
      "format": "YY.MINOR.MICRO"
    }
  }
}
EOF
)

    run get_versioning_config "$config"
    assert_success
    assert_output --partial '"scheme": "calver"'
    assert_output --partial '"format": "YY.MINOR.MICRO"'
}

@test "get_versioning_config: returns defaults for empty config" {
    local config="{}"

    run get_versioning_config "$config"
    assert_success
    assert_output --partial '"scheme": "semver"'
    assert_output --partial '"tagPrefix": "v"'
}

# ============================================================================
# get_security_config Tests
# ============================================================================

@test "get_security_config: returns configured security settings" {
    local config
    config=$(cat << 'EOF'
{
  "security": {
    "provenance": {
      "enabled": false
    },
    "signing": {
      "method": "gpg"
    }
  }
}
EOF
)

    run get_security_config "$config"
    assert_success
    assert_output --partial '"enabled": false'
    assert_output --partial '"method": "gpg"'
}

@test "get_security_config: returns defaults for empty config" {
    local config="{}"

    run get_security_config "$config"
    assert_success
    assert_output --partial '"enabled": true'
    assert_output --partial '"framework": "slsa"'
    assert_output --partial '"method": "sigstore"'
}

# ============================================================================
# Integration Tests
# ============================================================================

@test "integration: full config lifecycle" {
    cat > "$CONFIG_FILE" << 'EOF'
{
  "_meta": { "schemaVersion": "2.10.0" },
  "version": "2.10.0",
  "release": {
    "versioning": {
      "scheme": "semver"
    },
    "changelog": {
      "format": "keepachangelog"
    },
    "artifacts": [
      {
        "type": "npm-package",
        "enabled": true
      }
    ],
    "gates": [
      {
        "name": "tests",
        "command": "npm test",
        "required": true
      }
    ]
  }
}
EOF

    # Load config
    run load_release_config
    assert_success
    local config="$output"

    # Validate config
    run validate_release_config "$config"
    assert_success

    # Get artifact type
    run get_artifact_type "$config"
    assert_success
    assert_output '["npm-package"]'

    # Get gates
    run get_release_gates "$config"
    assert_success
    assert_output --partial '"name":"tests"'

    # Get changelog config
    run get_changelog_config "$config"
    assert_success
    assert_output --partial '"format": "keepachangelog"'
}

@test "integration: defaults for unconfigured project" {
    cat > "$CONFIG_FILE" << 'EOF'
{
  "_meta": { "schemaVersion": "2.10.0" },
  "version": "2.10.0"
}
EOF

    # Load config returns empty
    run load_release_config
    assert_success
    assert_output "{}"

    # Get defaults
    run get_artifact_type
    assert_success
    assert_output '["generic-tarball"]'

    run get_changelog_config
    assert_success
    assert_output --partial '"format": "keepachangelog"'

    run get_versioning_config
    assert_success
    assert_output --partial '"scheme": "semver"'
}
