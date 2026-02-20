#!/usr/bin/env bats
# tests/unit/release-provenance.bats - Unit tests for release provenance tracking
#
# @task T2672

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test

    # Create test-specific setup
    export CLEO_DIR="$TEST_TEMP_DIR/.cleo"
    export RELEASES_FILE="$CLEO_DIR/releases.json"

    # Source the library (from project root)
    source "$BATS_TEST_DIRNAME/../../lib/release/release-provenance.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# ============================================================================
# INITIALIZATION TESTS
# ============================================================================

@test "release-provenance: _init_releases_file creates valid structure" {
    # Initialize file
    _init_releases_file "$RELEASES_FILE"

    # Verify file exists
    [[ -f "$RELEASES_FILE" ]]

    # Verify structure
    run jq -r '._meta.schemaVersion' "$RELEASES_FILE"
    assert_success
    assert_output "1.0.0"

    run jq -e '.releases | type' "$RELEASES_FILE"
    assert_success
    assert_output '"array"'

    run jq -e '.releases | length' "$RELEASES_FILE"
    assert_success
    assert_output "0"
}

@test "release-provenance: _init_releases_file is idempotent" {
    # Initialize twice
    _init_releases_file "$RELEASES_FILE"
    local first_content
    first_content=$(cat "$RELEASES_FILE")

    sleep 1
    _init_releases_file "$RELEASES_FILE"
    local second_content
    second_content=$(cat "$RELEASES_FILE")

    # Content should be identical (no modification)
    [[ "$first_content" == "$second_content" ]]
}

# ============================================================================
# RECORD RELEASE TESTS
# ============================================================================

@test "release-provenance: record_release creates valid release entry" {
    run record_release "1.0.0"
    assert_success

    # Verify release was added
    run jq -e '.releases | length' "$RELEASES_FILE"
    assert_success
    assert_output "1"

    # Verify version
    run jq -r '.releases[0].version' "$RELEASES_FILE"
    assert_success
    assert_output "1.0.0"

    # Verify required fields
    run jq -e '.releases[0].date' "$RELEASES_FILE"
    assert_success

    run jq -e '.releases[0].tasks | type' "$RELEASES_FILE"
    assert_success
    assert_output '"array"'

    run jq -e '.releases[0].provenance.slsaLevel' "$RELEASES_FILE"
    assert_success
}

@test "release-provenance: record_release with artifacts and tasks" {
    local artifacts='[{"type":"npm-package","sha256":"abc123"}]'
    local commits='["abc123","def456"]'
    local tasks='["T2666","T2667"]'

    run record_release "1.0.0" "$artifacts" "$commits" "$tasks"
    assert_success

    # Verify artifacts
    run jq -r '.releases[0].artifacts[0].type' "$RELEASES_FILE"
    assert_success
    assert_output "npm-package"

    # Verify commits
    run jq -e '.releases[0].commits | length' "$RELEASES_FILE"
    assert_success
    assert_output "2"

    # Verify tasks
    run jq -e '.releases[0].tasks | length' "$RELEASES_FILE"
    assert_success
    assert_output "2"

    run jq -r '.releases[0].tasks[0]' "$RELEASES_FILE"
    assert_success
    assert_output "T2666"
}

@test "release-provenance: record_release rejects invalid version format" {
    run record_release "invalid"
    assert_failure
    assert_output --partial "Invalid version format"
}

@test "release-provenance: record_release prevents duplicate versions" {
    record_release "1.0.0"

    run record_release "1.0.0"
    assert_failure
    assert_output --partial "already exists"
}

@test "release-provenance: record_release accepts semver pre-release" {
    run record_release "1.0.0-beta.1"
    assert_success

    run jq -r '.releases[0].version' "$RELEASES_FILE"
    assert_success
    assert_output "1.0.0-beta.1"
}

@test "release-provenance: record_release accepts semver build metadata" {
    run record_release "1.0.0+build.123"
    assert_success

    run jq -r '.releases[0].version' "$RELEASES_FILE"
    assert_success
    assert_output "1.0.0+build.123"
}

# ============================================================================
# LINK TASK TESTS
# ============================================================================

@test "release-provenance: link_task_to_release adds task to existing release" {
    record_release "1.0.0"

    run link_task_to_release "T2666" "1.0.0"
    assert_success

    # Verify task was added
    run jq -r '.releases[0].tasks[0]' "$RELEASES_FILE"
    assert_success
    assert_output "T2666"
}

@test "release-provenance: link_task_to_release prevents duplicate tasks" {
    record_release "1.0.0"
    link_task_to_release "T2666" "1.0.0"

    # Link same task again
    run link_task_to_release "T2666" "1.0.0"
    assert_success

    # Should still have only one entry
    run jq -e '.releases[0].tasks | length' "$RELEASES_FILE"
    assert_success
    assert_output "1"
}

@test "release-provenance: link_task_to_release rejects invalid task ID" {
    record_release "1.0.0"

    run link_task_to_release "invalid" "1.0.0"
    assert_failure
    assert_output --partial "Invalid task ID format"
}

@test "release-provenance: link_task_to_release fails for non-existent release" {
    run link_task_to_release "T2666" "9.9.9"
    assert_failure
    assert_output --partial "not found"
}

# ============================================================================
# GET PROVENANCE TESTS
# ============================================================================

@test "release-provenance: get_release_provenance returns full entry" {
    local artifacts='[{"type":"npm-package","sha256":"abc123"}]'
    record_release "1.0.0" "$artifacts" '[]' '["T2666"]'

    run get_release_provenance "1.0.0"
    assert_success

    # Verify JSON structure
    run bash -c "get_release_provenance '1.0.0' | jq -e '.version'"
    assert_success
    assert_output '"1.0.0"'

    run bash -c "get_release_provenance '1.0.0' | jq -e '.provenance.slsaLevel'"
    assert_success
}

@test "release-provenance: get_release_provenance fails for non-existent version" {
    run get_release_provenance "9.9.9"
    assert_failure
    assert_output --partial "not found"
}

# ============================================================================
# GET TASK RELEASES TESTS
# ============================================================================

@test "release-provenance: get_task_releases finds releases by task" {
    record_release "1.0.0" '[]' '[]' '["T2666"]'
    record_release "1.1.0" '[]' '[]' '["T2666","T2667"]'
    record_release "2.0.0" '[]' '[]' '["T2667"]'

    run bash -c "get_task_releases 'T2666' | jq -e 'length'"
    assert_success
    assert_output "2"

    run bash -c "get_task_releases 'T2667' | jq -e 'length'"
    assert_success
    assert_output "2"
}

@test "release-provenance: get_task_releases returns empty array for no matches" {
    record_release "1.0.0"

    run bash -c "get_task_releases 'T9999' | jq -e 'length'"
    assert_success
    assert_output "0"
}

@test "release-provenance: get_task_releases rejects invalid task ID" {
    run get_task_releases "invalid"
    assert_failure
    assert_output --partial "Invalid task ID format"
}

# ============================================================================
# PROVENANCE REPORT TESTS
# ============================================================================

@test "release-provenance: generate_provenance_report creates markdown" {
    record_release "1.0.0" \
        '[{"type":"npm-package","sha256":"abc123def456"}]' \
        '["abc123"]' \
        '["T2666"]'

    run generate_provenance_report "1.0.0" "markdown"
    assert_success
    assert_output --partial "# Release Provenance Report: v1.0.0"
    assert_output --partial "**SLSA Level**:"
    assert_output --partial "## Tasks"
    assert_output --partial "## Commits"
    assert_output --partial "## Artifacts"
}

@test "release-provenance: generate_provenance_report creates JSON" {
    record_release "1.0.0"

    run generate_provenance_report "1.0.0" "json"
    assert_success

    # Verify valid JSON
    run bash -c "generate_provenance_report '1.0.0' 'json' | jq -e '.version'"
    assert_success
    assert_output '"1.0.0"'
}

@test "release-provenance: generate_provenance_report defaults to markdown" {
    record_release "1.0.0"

    run generate_provenance_report "1.0.0"
    assert_success
    assert_output --partial "# Release Provenance Report"
}

# ============================================================================
# VERIFY PROVENANCE TESTS
# ============================================================================

@test "release-provenance: verify_provenance_chain validates complete entry" {
    record_release "1.0.0"

    run verify_provenance_chain "1.0.0"
    assert_success
}

@test "release-provenance: verify_provenance_chain fails for incomplete entry" {
    # Manually create incomplete entry (bypass record_release)
    _init_releases_file "$RELEASES_FILE"
    jq '.releases += [{"version": "1.0.0"}]' "$RELEASES_FILE" > "$RELEASES_FILE.tmp"
    mv "$RELEASES_FILE.tmp" "$RELEASES_FILE"

    run verify_provenance_chain "1.0.0"
    assert_failure
    assert_output --partial "incomplete"
}

@test "release-provenance: verify_provenance_chain fails for non-existent version" {
    run verify_provenance_chain "9.9.9"
    assert_failure
}

# ============================================================================
# SLSA METADATA TESTS
# ============================================================================

@test "release-provenance: record_release includes SLSA metadata" {
    record_release "1.0.0"

    # Verify SLSA version
    run jq -r '.releases[0].provenance.slsaVersion' "$RELEASES_FILE"
    assert_success
    assert_output "1.0"

    # Verify SLSA level
    run jq -r '.releases[0].provenance.slsaLevel' "$RELEASES_FILE"
    assert_success
    assert_output "SLSA_BUILD_LEVEL_3"

    # Verify builder metadata
    run jq -e '.releases[0].provenance.builder.id' "$RELEASES_FILE"
    assert_success
}

@test "release-provenance: record_release includes signing metadata" {
    record_release "1.0.0"

    # Verify signing method
    run jq -r '.releases[0].signing.method' "$RELEASES_FILE"
    assert_success
    assert_output "sigstore"

    # Verify keyless flag
    run jq -r '.releases[0].signing.keyless' "$RELEASES_FILE"
    assert_success
    assert_output "true"
}
