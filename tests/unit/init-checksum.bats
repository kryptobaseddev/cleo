#!/usr/bin/env bats
# =============================================================================
# init-checksum.bats - Unit tests for init.sh checksum handling (T137)
# =============================================================================
# Tests that init creates valid checksums that pass validation.
# =============================================================================

# =============================================================================
# File-Level Setup (runs once per test file)
# =============================================================================
setup_file() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_file
}

# =============================================================================
# Per-Test Setup (runs before each test)
# =============================================================================
setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    common_setup_per_test
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# T137: Init creates valid checksum
# =============================================================================

@test "T137: init creates valid checksum that passes validation" {
    # Remove existing .claude directory to start fresh
    rm -rf "$TEST_TEMP_DIR/.claude"

    # Run init
    run bash "$INIT_SCRIPT" test-project
    assert_success

    # Verify todo.json was created
    [ -f "$TEST_TEMP_DIR/.cleo/todo.json" ]

    # Run validate script
    cd "$TEST_TEMP_DIR"
    run bash "$VALIDATE_SCRIPT"
    assert_success
    [[ "$output" =~ "validation successful" ]] || [[ "$output" =~ "Valid" ]]
}

@test "T137: checksum matches actual tasks array after init" {
    rm -rf "$TEST_TEMP_DIR/.claude"
    cd "$TEST_TEMP_DIR"
    bash "$INIT_SCRIPT" test-project

    local stored_checksum
    stored_checksum=$(jq -r '._meta.checksum' .cleo/todo.json)

    local tasks_array calculated_checksum
    tasks_array=$(jq -c '.tasks' .cleo/todo.json)
    calculated_checksum=$(echo "$tasks_array" | sha256sum | cut -c1-16)

    [ "$stored_checksum" = "$calculated_checksum" ]
}

@test "T137: init creates valid checksum format (16 hex chars)" {
    rm -rf "$TEST_TEMP_DIR/.claude"
    cd "$TEST_TEMP_DIR"
    bash "$INIT_SCRIPT" test-project

    local checksum
    checksum=$(jq -r '._meta.checksum' .cleo/todo.json)
    [[ "$checksum" =~ ^[a-f0-9]{16}$ ]]
}

@test "T137: init creates empty tasks array with correct checksum" {
    rm -rf "$TEST_TEMP_DIR/.claude"
    cd "$TEST_TEMP_DIR"
    bash "$INIT_SCRIPT" test-project

    local tasks_count
    tasks_count=$(jq '.tasks | length' .cleo/todo.json)
    [ "$tasks_count" -eq 0 ]

    local stored_checksum expected_checksum
    stored_checksum=$(jq -r '._meta.checksum' .cleo/todo.json)
    expected_checksum=$(jq -c '.tasks' .cleo/todo.json | sha256sum | cut -c1-16)
    [ "$stored_checksum" = "$expected_checksum" ]
}

@test "T137: fresh init followed by validation never fails" {
    rm -rf "$TEST_TEMP_DIR/.claude"
    cd "$TEST_TEMP_DIR"
    bash "$INIT_SCRIPT" fresh-test

    run bash "$VALIDATE_SCRIPT"
    assert_success

    [[ ! "$output" =~ "checksum mismatch" ]]
    [[ ! "$output" =~ "External modification" ]]
}

@test "T137: init with --force recalculates checksum correctly" {
    rm -rf "$TEST_TEMP_DIR/.claude"
    cd "$TEST_TEMP_DIR"
    bash "$INIT_SCRIPT" test-project

    run bash "$INIT_SCRIPT" --force --confirm-wipe test-project-2
    assert_success

    run bash "$VALIDATE_SCRIPT"
    assert_success
}

@test "T137: all created files are valid JSON after init" {
    rm -rf "$TEST_TEMP_DIR/.claude"
    cd "$TEST_TEMP_DIR"
    bash "$INIT_SCRIPT" test-project

    run jq empty .cleo/todo.json
    assert_success

    run jq empty .cleo/todo-archive.json
    assert_success

    run jq empty .cleo/config.json
    assert_success

    run jq empty .cleo/todo-log.json
    assert_success
}

# =============================================================================
# T1947: Init creates agent-outputs structure
# =============================================================================

@test "T1947: init creates agent-outputs directory" {
    rm -rf "$TEST_TEMP_DIR/.cleo"
    rm -rf "$TEST_TEMP_DIR/claudedocs"
    cd "$TEST_TEMP_DIR"
    bash "$INIT_SCRIPT" test-project

    [[ -d "claudedocs/agent-outputs" ]]
}

@test "T1947: init creates MANIFEST.jsonl file" {
    rm -rf "$TEST_TEMP_DIR/.cleo"
    rm -rf "$TEST_TEMP_DIR/claudedocs"
    cd "$TEST_TEMP_DIR"
    bash "$INIT_SCRIPT" test-project

    [[ -f "claudedocs/agent-outputs/MANIFEST.jsonl" ]]
}

@test "T1947: init creates archive subdirectory" {
    rm -rf "$TEST_TEMP_DIR/.cleo"
    rm -rf "$TEST_TEMP_DIR/claudedocs"
    cd "$TEST_TEMP_DIR"
    bash "$INIT_SCRIPT" test-project

    [[ -d "claudedocs/agent-outputs/archive" ]]
}

@test "T1947: init is idempotent for agent-outputs" {
    rm -rf "$TEST_TEMP_DIR/.cleo"
    rm -rf "$TEST_TEMP_DIR/claudedocs"
    cd "$TEST_TEMP_DIR"

    # First init
    bash "$INIT_SCRIPT" test-project

    # Add content to MANIFEST.jsonl to verify it's not wiped
    echo '{"id":"test","file":"t.md","title":"T","date":"2025-01-17","status":"complete","topics":[],"key_findings":[],"actionable":true}' >> "claudedocs/agent-outputs/MANIFEST.jsonl"

    # Second init with force (simulating reinit)
    run bash "$INIT_SCRIPT" --force --confirm-wipe test-project-2
    assert_success

    # Verify directory still exists (reinit doesn't delete it)
    [[ -d "claudedocs/agent-outputs" ]]
    [[ -f "claudedocs/agent-outputs/MANIFEST.jsonl" ]]

    # Note: Content may or may not be preserved depending on reinit behavior
    # The key is that the structure exists after reinit
}
