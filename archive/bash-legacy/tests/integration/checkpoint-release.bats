#!/usr/bin/env bats
# =============================================================================
# checkpoint-release.bats - Integration tests for checkpoint/release fixes
# =============================================================================
# Verifies checkpoint suppression, recalculate_checksum, and session-end
# checkpoint behavior introduced by T4247-T4251.
#
# @task T4252
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    common_setup_per_test

    # Ensure suppression is clean before each test
    unset GIT_CHECKPOINT_SUPPRESS
}

teardown() {
    unset GIT_CHECKPOINT_SUPPRESS
    cd "${PROJECT_ROOT}" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Test 1: should_checkpoint returns 1 when GIT_CHECKPOINT_SUPPRESS=true
# Validates T4247: suppression env var skips checkpoint even with force=true
# ---------------------------------------------------------------------------
@test "should_checkpoint skips when GIT_CHECKPOINT_SUPPRESS=true" {
    source "$LIB_DIR/data/git-checkpoint.sh"

    export GIT_CHECKPOINT_SUPPRESS=true

    # force=true still suppressed
    run should_checkpoint "true"
    [[ "$status" -eq 1 ]]
}

# ---------------------------------------------------------------------------
# Test 2: git_checkpoint_status reports suppression in JSON output
# Validates T4247: status.suppressed field reflects env var
# ---------------------------------------------------------------------------
@test "git_checkpoint_status includes suppressed field" {
    source "$LIB_DIR/data/git-checkpoint.sh"

    export GIT_CHECKPOINT_SUPPRESS=true
    run git_checkpoint_status "json"
    [[ "$status" -eq 0 ]]

    local suppressed
    suppressed=$(echo "$output" | jq -r '.status.suppressed')
    [[ "$suppressed" == "true" ]]
}

# ---------------------------------------------------------------------------
# Test 3: git_checkpoint_status shows suppressed=false when unset
# Validates T4247: default state is not suppressed
# ---------------------------------------------------------------------------
@test "git_checkpoint_status shows suppressed false when unset" {
    source "$LIB_DIR/data/git-checkpoint.sh"

    unset GIT_CHECKPOINT_SUPPRESS
    run git_checkpoint_status "json"
    [[ "$status" -eq 0 ]]

    local suppressed
    suppressed=$(echo "$output" | jq -r '.status.suppressed')
    [[ "$suppressed" == "false" ]]
}

# ---------------------------------------------------------------------------
# Test 4: recalculate_checksum updates ._meta.checksum
# Validates T4251: checksum is computed from .tasks and truncated to 16 chars
# ---------------------------------------------------------------------------
@test "recalculate_checksum updates ._meta.checksum" {
    source "$LIB_DIR/data/file-ops.sh"

    local test_json='{"_meta":{"checksum":"old"},"tasks":[{"id":"T1"}]}'
    local result
    result=$(recalculate_checksum "$test_json")

    local new_checksum
    new_checksum=$(echo "$result" | jq -r '._meta.checksum')

    # Checksum should be different from placeholder
    [[ "$new_checksum" != "old" ]]
    # Checksum should be 16 chars (sha256 truncated)
    [[ ${#new_checksum} -eq 16 ]]
}

# ---------------------------------------------------------------------------
# Test 5: recalculate_checksum is deterministic
# Validates T4251: same input always produces same checksum
# ---------------------------------------------------------------------------
@test "recalculate_checksum produces same result for same input" {
    source "$LIB_DIR/data/file-ops.sh"

    local test_json='{"_meta":{"checksum":"x"},"tasks":[{"id":"T1","title":"test"}]}'
    local result1 result2
    result1=$(recalculate_checksum "$test_json" | jq -r '._meta.checksum')
    result2=$(recalculate_checksum "$test_json" | jq -r '._meta.checksum')

    [[ "$result1" == "$result2" ]]
}

# ---------------------------------------------------------------------------
# Test 6: git_checkpoint returns 0 without action when suppressed
# Validates T4247+T4250: checkpoint call is a no-op under suppression
# ---------------------------------------------------------------------------
@test "git_checkpoint skips without error when suppressed" {
    source "$LIB_DIR/data/git-checkpoint.sh"

    export GIT_CHECKPOINT_SUPPRESS=true

    # git_checkpoint should return 0 (no-op, not an error)
    run git_checkpoint "session-end" "test"
    [[ "$status" -eq 0 ]]
}

# ---------------------------------------------------------------------------
# Test 7: recalculate_checksum preserves JSON structure
# Validates T4251: only ._meta.checksum changes, rest of JSON intact
# ---------------------------------------------------------------------------
@test "recalculate_checksum preserves other fields" {
    source "$LIB_DIR/data/file-ops.sh"

    local test_json='{"_meta":{"checksum":"old","schemaVersion":"2.6.0"},"tasks":[{"id":"T1","title":"keep"}]}'
    local result
    result=$(recalculate_checksum "$test_json")

    # Schema version should be preserved
    local version
    version=$(echo "$result" | jq -r '._meta.schemaVersion')
    [[ "$version" == "2.6.0" ]]

    # Task data should be preserved
    local task_title
    task_title=$(echo "$result" | jq -r '.tasks[0].title')
    [[ "$task_title" == "keep" ]]
}
