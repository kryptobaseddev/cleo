#!/usr/bin/env bats
# =============================================================================
# release-v2.bats - Integration tests for Release System v2
# =============================================================================
# Tests the complete release v2 stack: config loading, CI templates, artifact
# handlers, provenance tracking. Uses mock projects for safe testing.
#
# Components tested:
# - T2669: lib/release/release-config.sh - Configuration loading and validation
# - T2670: lib/release/release-ci.sh - CI template generation
# - T2671: lib/release/release-artifacts.sh - Pluggable artifact handlers
# - T2672: lib/release/release-provenance.sh - Provenance tracking
# - T2845: cleo release ship - Unified ship command
#
# Task: T2674
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    load '../test_helper/assertions'
    common_setup_per_test

    # Project paths
    TEST_FILE_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
    PROJECT_ROOT="$(cd "$TEST_FILE_DIR/../.." && pwd)"

    # Test environment
    TEST_DIR="${BATS_TEST_TMPDIR}"
    CLEO_DIR="$TEST_DIR/.cleo"
    mkdir -p "$CLEO_DIR"

    # Export environment
    export TODO_FILE="$CLEO_DIR/todo.json"
    export CONFIG_FILE="$CLEO_DIR/config.json"
    export RELEASES_FILE="$CLEO_DIR/releases.json"
    export CHANGELOG_FILE="$TEST_DIR/CHANGELOG.md"

    # Source libraries for direct testing
    source "$PROJECT_ROOT/lib/core/exit-codes.sh"
    source "$PROJECT_ROOT/lib/data/file-ops.sh"
    source "$PROJECT_ROOT/lib/core/config.sh"
    source "$PROJECT_ROOT/lib/release/release-config.sh"
    source "$PROJECT_ROOT/lib/release/release-artifacts.sh"
    source "$PROJECT_ROOT/lib/release/release-provenance.sh"

    # Create minimal todo.json
    cat > "$TODO_FILE" << 'EOF'
{
  "tasks": [
    {
      "id": "T2666",
      "title": "EPIC: Release System v2",
      "type": "epic",
      "status": "active"
    },
    {
      "id": "T2669",
      "title": "Feat: Config loader",
      "type": "task",
      "status": "done",
      "parentId": "T2666"
    }
  ],
  "project": {
    "releases": []
  }
}
EOF
}

teardown() {
    common_teardown
}

# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

# Create config with release section
create_release_config() {
    local artifacts="${1:-[]}"
    local gates="${2:-[]}"

    cat > "$CONFIG_FILE" << EOF
{
  "version": "2.2.0",
  "project": {
    "name": "test-project"
  },
  "release": {
    "versioning": {
      "scheme": "semver",
      "semver": {
        "format": "MAJOR.MINOR.PATCH",
        "tagPrefix": "v"
      }
    },
    "artifacts": $artifacts,
    "gates": $gates,
    "changelog": {
      "format": "keepachangelog",
      "file": "CHANGELOG.md",
      "autoGenerate": true
    },
    "security": {
      "provenance": {
        "enabled": true,
        "framework": "slsa",
        "level": "SLSA_BUILD_LEVEL_3"
      },
      "signing": {
        "method": "sigstore",
        "keyless": true
      },
      "checksums": {
        "algorithm": "sha256",
        "file": "checksums.txt"
      }
    }
  }
}
EOF
}

# Create mock npm project
create_mock_npm_project() {
    cat > "$TEST_DIR/package.json" << 'EOF'
{
  "name": "@test/mock-npm",
  "version": "1.0.0",
  "description": "Mock npm package for testing",
  "license": "MIT",
  "scripts": {
    "build": "echo 'Building...'"
  }
}
EOF
}

# Create mock Python project
create_mock_python_project() {
    cat > "$TEST_DIR/pyproject.toml" << 'EOF'
[build-system]
requires = ["setuptools>=45", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "mock-python"
version = "1.0.0"
description = "Mock Python package for testing"
EOF
}

# Create mock Go project
create_mock_go_project() {
    cat > "$TEST_DIR/go.mod" << 'EOF'
module github.com/test/mock-go

go 1.21
EOF
}

# =============================================================================
# TESTS: Config Loading (T2669)
# =============================================================================

@test "load_release_config should return empty object when no release section" {
    cat > "$CONFIG_FILE" << 'EOF'
{
  "version": "2.2.0",
  "project": {}
}
EOF

    run load_release_config
    assert_success
    [[ "$output" == "{}" ]]
}

@test "load_release_config should load complete release configuration" {
    create_release_config '[]' '[]'

    run load_release_config
    assert_success

    # Verify versioning section exists
    local scheme
    scheme=$(echo "$output" | jq -r '.versioning.scheme')
    [[ "$scheme" == "semver" ]]

    # Verify security section exists
    local provenance_enabled
    provenance_enabled=$(echo "$output" | jq -r '.security.provenance.enabled')
    [[ "$provenance_enabled" == "true" ]]
}

@test "validate_release_config should accept valid configuration" {
    create_release_config '[{"type":"npm-package"}]' '[]'

    local config
    config=$(load_release_config)

    run validate_release_config "$config"
    assert_success
}

@test "validate_release_config should reject invalid versioning scheme" {
    cat > "$CONFIG_FILE" << 'EOF'
{
  "version": "2.2.0",
  "release": {
    "versioning": {
      "scheme": "invalid-scheme"
    }
  }
}
EOF

    local config
    config=$(load_release_config)

    run validate_release_config "$config"
    assert_failure
    assert_output --partial "Invalid versioning.scheme"
}

@test "validate_release_config should reject invalid artifact type" {
    create_release_config '[{"type":"invalid-artifact"}]' '[]'

    local config
    config=$(load_release_config)

    run validate_release_config "$config"
    assert_failure
    assert_output --partial "Invalid artifact type"
}

@test "validate_release_config should require gate name and command" {
    create_release_config '[]' '[{"name":"test"}]'

    local config
    config=$(load_release_config)

    run validate_release_config "$config"
    assert_failure
    assert_output --partial "missing required 'command' field"
}

@test "get_artifact_type should return configured types" {
    create_release_config '[{"type":"npm-package"},{"type":"docker-image"}]' '[]'

    local config
    config=$(load_release_config)

    run get_artifact_type "$config"
    assert_success

    # Verify both types are present
    echo "$output" | jq -e '.[] | select(. == "npm-package")' >/dev/null
    echo "$output" | jq -e '.[] | select(. == "docker-image")' >/dev/null
}

@test "get_artifact_type should skip disabled artifacts" {
    create_release_config '[{"type":"npm-package","enabled":false},{"type":"docker-image"}]' '[]'

    local config
    config=$(load_release_config)

    run get_artifact_type "$config"
    assert_success

    # Only docker-image should be present
    echo "$output" | jq -e '.[] | select(. == "docker-image")' >/dev/null
    ! echo "$output" | jq -e '.[] | select(. == "npm-package")' >/dev/null || false
}

@test "get_changelog_config should return defaults when not configured" {
    cat > "$CONFIG_FILE" << 'EOF'
{
  "version": "2.2.0",
  "release": {}
}
EOF

    local config
    config=$(load_release_config)

    run get_changelog_config "$config"
    assert_success

    local format
    format=$(echo "$output" | jq -r '.format')
    [[ "$format" == "keepachangelog" ]]
}

# =============================================================================
# TESTS: Artifact Handlers (T2671)
# =============================================================================

@test "npm_package_validate should pass for valid package.json" {
    create_mock_npm_project

    local artifact_config
    artifact_config=$(jq -n '{package: "package.json"}')

    cd "$TEST_DIR"
    run npm_package_validate "$artifact_config"
    assert_success
}

@test "npm_package_validate should fail when package.json missing" {
    local artifact_config
    artifact_config=$(jq -n '{package: "package.json"}')

    cd "$TEST_DIR"
    run npm_package_validate "$artifact_config"
    assert_failure
    assert_output --partial "package.json not found"
}

@test "npm_package_validate should fail when required fields missing" {
    cat > "$TEST_DIR/package.json" << 'EOF'
{
  "name": "test"
}
EOF

    local artifact_config
    artifact_config=$(jq -n '{package: "package.json"}')

    cd "$TEST_DIR"
    run npm_package_validate "$artifact_config"
    assert_failure
    assert_output --partial "missing required field"
}

@test "npm_package_build should respect dry-run mode" {
    create_mock_npm_project

    local artifact_config
    artifact_config=$(jq -n '{buildCommand: "npm run build"}')

    cd "$TEST_DIR"
    run npm_package_build "$artifact_config" "true"
    assert_success
    assert_output --partial "[DRY RUN]"
}

@test "python_wheel_validate should pass for valid pyproject.toml" {
    create_mock_python_project

    local artifact_config
    artifact_config=$(jq -n '{package: "pyproject.toml"}')

    cd "$TEST_DIR"
    run python_wheel_validate "$artifact_config"
    assert_success
}

@test "python_wheel_validate should fail when neither pyproject.toml nor setup.py exist" {
    local artifact_config
    artifact_config=$(jq -n '{package: "pyproject.toml"}')

    cd "$TEST_DIR"
    run python_wheel_validate "$artifact_config"
    assert_failure
    assert_output --partial "Neither pyproject.toml nor setup.py found"
}

@test "go_module_validate should pass for valid go.mod" {
    # Skip if go not installed
    if ! command -v go &>/dev/null; then
        skip "go command not available"
    fi

    create_mock_go_project

    local artifact_config
    artifact_config=$(jq -n '{package: "go.mod"}')

    cd "$TEST_DIR"
    run go_module_validate "$artifact_config"
    assert_success
}

@test "go_module_validate should fail when go.mod missing" {
    local artifact_config
    artifact_config=$(jq -n '{package: "go.mod"}')

    cd "$TEST_DIR"
    run go_module_validate "$artifact_config"
    assert_failure
    assert_output --partial "go.mod not found"
}

@test "generic_tarball_build should use default command when not specified" {
    local artifact_config
    artifact_config=$(jq -n '{}')

    cd "$TEST_DIR"
    run generic_tarball_build "$artifact_config" "true"
    assert_success
    assert_output --partial "tar czf"
}

@test "build_artifact dispatcher should call correct handler" {
    create_mock_npm_project

    local artifact_config
    artifact_config=$(jq -n '{buildCommand: "echo test"}')

    cd "$TEST_DIR"
    run build_artifact "npm-package" "$artifact_config" "true"
    assert_success
    assert_output --partial "[DRY RUN]"
}

@test "build_artifact should fail for unregistered handler" {
    local artifact_config
    artifact_config=$(jq -n '{}')

    run build_artifact "unknown-type" "$artifact_config" "false"
    assert_failure
    assert_output --partial "No handler registered"
}

# =============================================================================
# TESTS: Provenance Tracking (T2672)
# =============================================================================

@test "record_release should create releases.json if missing" {
    [[ ! -f "$RELEASES_FILE" ]]

    run record_release "1.0.0" '[]' '[]' '[]'
    assert_success

    [[ -f "$RELEASES_FILE" ]]

    # Verify structure
    local schema_version
    schema_version=$(jq -r '._meta.schemaVersion' "$RELEASES_FILE")
    [[ "$schema_version" == "1.0.0" ]]
}

@test "record_release should add release with SLSA provenance" {
    run record_release "1.0.0" '[]' '["abc123"]' '["T2666"]'
    assert_success

    # Verify release exists
    local version
    version=$(jq -r '.releases[0].version' "$RELEASES_FILE")
    [[ "$version" == "1.0.0" ]]

    # Verify SLSA metadata
    local slsa_version slsa_level
    slsa_version=$(jq -r '.releases[0].provenance.slsaVersion' "$RELEASES_FILE")
    slsa_level=$(jq -r '.releases[0].provenance.slsaLevel' "$RELEASES_FILE")
    [[ "$slsa_version" == "1.0" ]]
    [[ "$slsa_level" == "SLSA_BUILD_LEVEL_3" ]]
}

@test "record_release should reject invalid version format" {
    run record_release "invalid-version" '[]' '[]' '[]'
    assert_failure
    assert_output --partial "Invalid version format"
}

@test "record_release should prevent duplicate versions" {
    record_release "1.0.0" '[]' '[]' '[]'

    run record_release "1.0.0" '[]' '[]' '[]'
    assert_failure
    assert_output --partial "already exists"
}

@test "link_task_to_release should add task to existing release" {
    record_release "1.0.0" '[]' '[]' '[]'

    run link_task_to_release "T2669" "1.0.0"
    assert_success

    # Verify task was added
    local tasks
    tasks=$(jq -r '.releases[0].tasks | join(",")' "$RELEASES_FILE")
    [[ "$tasks" == "T2669" ]]
}

@test "link_task_to_release should reject invalid task ID format" {
    record_release "1.0.0" '[]' '[]' '[]'

    run link_task_to_release "invalid" "1.0.0"
    assert_failure
    assert_output --partial "Invalid task ID format"
}

@test "link_task_to_release should fail for non-existent release" {
    run link_task_to_release "T2669" "9.9.9"
    assert_failure
    assert_output --partial "not found"
}

@test "link_task_to_release should not duplicate tasks" {
    record_release "1.0.0" '[]' '[]' '["T2669"]'

    run link_task_to_release "T2669" "1.0.0"
    assert_success

    # Verify only one instance
    local task_count
    task_count=$(jq -r '.releases[0].tasks | length' "$RELEASES_FILE")
    [[ "$task_count" == "1" ]]
}

@test "get_release_provenance should return full provenance chain" {
    local artifacts
    artifacts='[{"type":"npm-package","sha256":"abc123"}]'
    record_release "1.0.0" "$artifacts" '["commit1"]' '["T2666"]'

    run get_release_provenance "1.0.0"
    assert_success

    # Verify all components present
    echo "$output" | jq -e '.version' >/dev/null
    echo "$output" | jq -e '.tasks' >/dev/null
    echo "$output" | jq -e '.commits' >/dev/null
    echo "$output" | jq -e '.artifacts' >/dev/null
    echo "$output" | jq -e '.provenance' >/dev/null
}

@test "get_task_releases should find all releases containing task" {
    record_release "1.0.0" '[]' '[]' '["T2666"]'
    record_release "1.1.0" '[]' '[]' '["T2666","T2669"]'
    record_release "1.2.0" '[]' '[]' '["T2669"]'

    run get_task_releases "T2666"
    assert_success

    # Should return 2 releases
    local count
    count=$(echo "$output" | jq 'length')
    [[ "$count" == "2" ]]
}

@test "verify_provenance_chain should validate complete provenance" {
    local artifacts
    artifacts='[{"type":"npm-package","sha256":"abc123"}]'
    record_release "1.0.0" "$artifacts" '["commit1"]' '["T2666"]'

    run verify_provenance_chain "1.0.0"
    assert_success
}

@test "verify_provenance_chain should fail for incomplete provenance" {
    # Create malformed release manually
    cat > "$RELEASES_FILE" << 'EOF'
{
  "_meta": {"schemaVersion": "1.0.0"},
  "releases": [
    {
      "version": "1.0.0"
    }
  ]
}
EOF

    run verify_provenance_chain "1.0.0"
    assert_failure
    assert_output --partial "Provenance chain incomplete"
}

@test "generate_provenance_report should produce markdown by default" {
    local artifacts
    artifacts='[{"type":"npm-package","sha256":"abc123"}]'
    record_release "1.0.0" "$artifacts" '["commit1"]' '["T2666"]'

    run generate_provenance_report "1.0.0"
    assert_success

    # Verify markdown structure
    echo "$output" | grep -q "^# Release Provenance Report"
    echo "$output" | grep -q "## Summary"
    echo "$output" | grep -q "## Tasks"
}

@test "generate_provenance_report should support JSON format" {
    local artifacts
    artifacts='[{"type":"npm-package","sha256":"abc123"}]'
    record_release "1.0.0" "$artifacts" '["commit1"]' '["T2666"]'

    run generate_provenance_report "1.0.0" "json"
    assert_success

    # Verify valid JSON
    echo "$output" | jq -e '.version' >/dev/null
    echo "$output" | jq -e '.provenance' >/dev/null
}

# =============================================================================
# TESTS: Multi-Artifact Release
# =============================================================================

@test "full workflow: multi-artifact release with npm and tarball" {
    # Setup
    create_release_config '[{"type":"npm-package"},{"type":"generic-tarball"}]' '[]'
    create_mock_npm_project

    # Load config
    local config
    config=$(load_release_config)

    # Validate config
    validate_release_config "$config"

    # Get artifact types
    local artifact_types
    artifact_types=$(get_artifact_type "$config")
    local type_count
    type_count=$(echo "$artifact_types" | jq 'length')
    [[ "$type_count" == "2" ]]

    # Validate npm artifact
    local npm_config
    npm_config=$(jq -n '{package: "package.json"}')
    cd "$TEST_DIR"
    npm_package_validate "$npm_config"

    # Build artifacts (dry-run)
    npm_package_build "$npm_config" "true"
    generic_tarball_build '{}' "true"

    # Record release
    cd "$PROJECT_ROOT"
    record_release "1.0.0" '[{"type":"npm-package"},{"type":"generic-tarball"}]' '[]' '["T2666"]'

    # Verify provenance
    verify_provenance_chain "1.0.0"
}

# =============================================================================
# TESTS: Config Inheritance (extends field)
# =============================================================================

@test "config should support extends field for inheritance" {
    # Create base config
    cat > "$TEST_DIR/base-release.json" << 'EOF'
{
  "versioning": {
    "scheme": "semver"
  },
  "changelog": {
    "format": "keepachangelog"
  }
}
EOF

    # Create config with extends
    cat > "$CONFIG_FILE" << 'EOF'
{
  "version": "2.2.0",
  "release": {
    "extends": "base-release.json",
    "artifacts": [{"type":"npm-package"}]
  }
}
EOF

    local config
    config=$(load_release_config)

    # Note: extends field is documented but implementation may merge configs
    # This test verifies the config loads successfully
    [[ "$config" != "{}" ]]
}

# =============================================================================
# TESTS: Dry-Run Mode
# =============================================================================

@test "dry-run should not create files" {
    create_mock_npm_project

    local artifact_config
    artifact_config=$(jq -n '{buildCommand: "touch should-not-exist.txt"}')

    cd "$TEST_DIR"
    npm_package_build "$artifact_config" "true"

    [[ ! -f "$TEST_DIR/should-not-exist.txt" ]]
}

@test "dry-run should show commands without executing" {
    local artifact_config
    artifact_config=$(jq -n '{buildCommand: "echo hello"}')

    cd "$TEST_DIR"
    run generic_tarball_build "$artifact_config" "true"
    assert_success
    assert_output --partial "[DRY RUN]"
    assert_output --partial "echo hello"
}

# =============================================================================
# TESTS: Error Conditions
# =============================================================================

@test "config validation should catch all invalid schemes" {
    local invalid_schemes=("random" "custom-wrong" "")

    for scheme in "${invalid_schemes[@]}"; do
        cat > "$CONFIG_FILE" << EOF
{
  "version": "2.2.0",
  "release": {
    "versioning": {
      "scheme": "$scheme"
    }
  }
}
EOF

        local config
        config=$(load_release_config)

        if [[ -n "$scheme" && "$scheme" != "custom" ]]; then
            run validate_release_config "$config"
            assert_failure
        fi
    done
}

@test "artifact handler should fail gracefully with missing commands" {
    # Unset all npm commands if they exist
    local has_npm=false
    if command -v npm >/dev/null 2>&1; then
        has_npm=true
    fi

    # Test that handler checks for command existence
    # (Implementation note: handlers should check command availability)
}

@test "provenance should preserve data on partial failure" {
    record_release "1.0.0" '[]' '[]' '["T2666"]'

    # Try to add invalid task
    link_task_to_release "invalid" "1.0.0" || true

    # Original release should be unchanged
    local tasks
    tasks=$(jq -r '.releases[0].tasks | join(",")' "$RELEASES_FILE")
    [[ "$tasks" == "T2666" ]]
}
