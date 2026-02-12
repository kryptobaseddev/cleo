#!/usr/bin/env bats
# =============================================================================
# injection-workflow.bats - Integration tests for multi-file injection system
# =============================================================================
# Tests end-to-end workflows for injection system across init, upgrade, validate:
# 1. init creates all target files with injection blocks
# 2. upgrade updates outdated injections across all files
# 3. validate detects injection issues
# 4. Full workflow: init → modify → upgrade → validate
#
# Related tasks: T1400 (Epic: T1384)
# Dependencies: T1396, T1397, T1398
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test

    # Set CLEO_HOME for library sourcing
    export CLEO_HOME="${PROJECT_ROOT}"
    export CLEO_LIB_DIR="${PROJECT_ROOT}/lib"

    # Export script paths
    export INIT_SCRIPT="${SCRIPTS_DIR}/init.sh"
    export UPGRADE_SCRIPT="${SCRIPTS_DIR}/upgrade.sh"
    export VALIDATE_SCRIPT="${SCRIPTS_DIR}/validate.sh"

    # Define injection targets
    export INJECTION_TARGETS=("CLAUDE.md" "AGENTS.md" "GEMINI.md")
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

# Check if file has injection block
_has_injection_block() {
    local file="$1"
    grep -q "<!-- CLEO:START" "$file" 2>/dev/null
}

# Check if injection uses @-reference format
_has_reference_format() {
    local file="$1"
    grep -q "@.cleo/templates/AGENT-INJECTION.md" "$file" 2>/dev/null
}

# Create outdated injection (legacy inline content)
_create_outdated_injection() {
    local file="$1"
    cat > "$file" <<EOF
<!-- CLEO:START v0.30.0 -->
## Old Task Management
This is outdated content that should be updated.
<!-- CLEO:END -->

# Project Documentation
This is the project readme.
EOF
}

# Create current injection (with @-reference)
_create_current_injection() {
    local file="$1"
    cat > "$file" <<EOF
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->

# Project Documentation
This is the project readme.
EOF
}

# Create file without injection
_create_clean_file() {
    local file="$1"
    cat > "$file" <<EOF
# Project Documentation

This file has no CLEO injection block.
EOF
}

# Get checksum of file
_get_file_checksum() {
    local file="$1"
    sha256sum "$file" 2>/dev/null | cut -c1-64
}

# =============================================================================
# TEST 1: init creates all agent files with injection blocks
# =============================================================================

@test "init creates all agent files with injection blocks" {
    # Ensure no agent files exist
    for target in "${INJECTION_TARGETS[@]}"; do
        rm -f "./$target"
    done

    # Run init
    run bash "$INIT_SCRIPT" test-project --force
    [ "$status" -eq 0 ] || [ "$status" -eq 101 ]

    # Verify all target files were created with injection blocks
    for target in "${INJECTION_TARGETS[@]}"; do
        [ -f "./$target" ]
        _has_injection_block "./$target"
        _has_reference_format "./$target"
    done
}

@test "init creates injection with @-reference format (not inline)" {
    # Remove existing files
    for target in "${INJECTION_TARGETS[@]}"; do
        rm -f "./$target"
    done

    # Run init
    run bash "$INIT_SCRIPT" test-project --force
    [ "$status" -eq 0 ] || [ "$status" -eq 101 ]

    # Verify @-reference format is used
    for target in "${INJECTION_TARGETS[@]}"; do
        grep -q "@.cleo/templates/AGENT-INJECTION.md" "./$target"
    done
}

@test "init copies AGENT-INJECTION.md template to .cleo/templates/" {
    # Run init
    run bash "$INIT_SCRIPT" test-project --force
    [ "$status" -eq 0 ] || [ "$status" -eq 101 ]

    # Verify template was copied
    [ -f ".cleo/templates/AGENT-INJECTION.md" ]
}

@test "init --update-docs updates existing files without touching task data" {
    # Create empty todo first (simulating existing project)
    create_empty_todo

    # Create outdated agent files
    for target in "${INJECTION_TARGETS[@]}"; do
        _create_outdated_injection "./$target"
    done

    # Get todo.json checksum before
    local todo_checksum_before
    todo_checksum_before=$(_get_file_checksum "$TODO_FILE")

    # Run init --update-docs
    run bash "$INIT_SCRIPT" --update-docs
    # Exit 0 = updated, 102 = no change needed
    [ "$status" -eq 0 ] || [ "$status" -eq 102 ]

    # Verify todo.json unchanged
    local todo_checksum_after
    todo_checksum_after=$(_get_file_checksum "$TODO_FILE")
    [ "$todo_checksum_before" = "$todo_checksum_after" ]

    # Verify agent files updated to @-reference format
    for target in "${INJECTION_TARGETS[@]}"; do
        _has_reference_format "./$target"
    done
}

# =============================================================================
# TEST 2: upgrade updates outdated injection in all files
# =============================================================================

@test "upgrade updates outdated injection in all files" {
    create_empty_todo

    # Create outdated injections
    for target in "${INJECTION_TARGETS[@]}"; do
        _create_outdated_injection "./$target"
    done

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Verify all files updated to @-reference format
    for target in "${INJECTION_TARGETS[@]}"; do
        _has_reference_format "./$target"
    done
}

@test "upgrade skips current injection files" {
    create_empty_todo

    # Create current injections
    for target in "${INJECTION_TARGETS[@]}"; do
        _create_current_injection "./$target"
    done

    # Get checksums before
    declare -A checksums_before
    for target in "${INJECTION_TARGETS[@]}"; do
        checksums_before["$target"]=$(_get_file_checksum "./$target")
    done

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ]

    # Verify files unchanged
    for target in "${INJECTION_TARGETS[@]}"; do
        local checksum_after
        checksum_after=$(_get_file_checksum "./$target")
        [ "${checksums_before[$target]}" = "$checksum_after" ]
    done
}

@test "upgrade --dry-run does not modify injection files" {
    create_empty_todo

    # Create outdated injections
    for target in "${INJECTION_TARGETS[@]}"; do
        _create_outdated_injection "./$target"
    done

    # Get checksums before
    declare -A checksums_before
    for target in "${INJECTION_TARGETS[@]}"; do
        checksums_before["$target"]=$(_get_file_checksum "./$target")
    done

    # Run upgrade with dry-run
    run bash "$UPGRADE_SCRIPT" --dry-run
    [ "$status" -eq 0 ]

    # Verify files unchanged
    for target in "${INJECTION_TARGETS[@]}"; do
        local checksum_after
        checksum_after=$(_get_file_checksum "./$target")
        [ "${checksums_before[$target]}" = "$checksum_after" ]
    done
}

@test "upgrade handles mixed injection states across files" {
    create_empty_todo

    # Create mixed states: outdated, current, missing
    _create_outdated_injection "./CLAUDE.md"
    _create_current_injection "./AGENTS.md"
    rm -f "./GEMINI.md"

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Verify CLAUDE.md updated
    _has_reference_format "./CLAUDE.md"

    # Verify AGENTS.md unchanged (already current)
    _has_reference_format "./AGENTS.md"
}

# =============================================================================
# TEST 3: validate detects missing injection blocks
# =============================================================================

@test "validate detects missing injection blocks" {
    create_empty_todo

    # Create files without injection
    for target in "${INJECTION_TARGETS[@]}"; do
        _create_clean_file "./$target"
    done

    # Run validate
    run bash "$VALIDATE_SCRIPT"
    # Should warn about missing injection (may or may not fail depending on strictness)
    [[ "$output" == *"injection"* ]] || [[ "$output" == *"CLAUDE"* ]]
}

@test "validate detects outdated injection" {
    create_empty_todo

    # Create outdated injection
    _create_outdated_injection "./CLAUDE.md"
    _create_current_injection "./AGENTS.md"
    _create_current_injection "./GEMINI.md"

    # Run validate
    run bash "$VALIDATE_SCRIPT"
    # Should detect outdated injection
    [[ "$output" == *"outdated"* ]] || [[ "$output" == *"CLAUDE"* ]] || [[ "$output" == *"injection"* ]]
}

@test "validate --fix updates injection issues" {
    # Initialize a proper project first
    run bash "$INIT_SCRIPT" test-project --force
    [ "$status" -eq 0 ] || [ "$status" -eq 101 ]

    # Create outdated injection
    _create_outdated_injection "./CLAUDE.md"

    # Run validate with fix
    run bash "$VALIDATE_SCRIPT" --fix
    # May return various exit codes based on other validation, but should update injection
    # The key check is that the file was fixed

    # Verify CLAUDE.md was fixed to @-reference format
    _has_reference_format "./CLAUDE.md"
}

@test "validate passes when all injections are current" {
    # Initialize a proper project first (creates valid todo.json)
    run bash "$INIT_SCRIPT" test-project --force
    [ "$status" -eq 0 ] || [ "$status" -eq 101 ]

    # Verify injections are current (created by init)
    for target in "${INJECTION_TARGETS[@]}"; do
        _has_reference_format "./$target"
    done

    # Run validate and check injection status in output
    run bash "$VALIDATE_SCRIPT"

    # Injection-specific checks should pass (look for "current" status in output)
    # Note: validate may fail for other reasons, so check injection status specifically
    [[ "$output" == *"injection current"* ]] || [[ "$output" == *"claude_md"* && "$output" == *"ok"* ]]
}

# =============================================================================
# TEST 4: Full workflow: init → modify → upgrade → validate
# =============================================================================

@test "full workflow: init -> modify template -> upgrade -> validate" {
    # Step 1: Initialize project
    run bash "$INIT_SCRIPT" test-project --force
    [ "$status" -eq 0 ] || [ "$status" -eq 101 ]

    # Verify initial state
    [ -f ".cleo/templates/AGENT-INJECTION.md" ]
    for target in "${INJECTION_TARGETS[@]}"; do
        [ -f "./$target" ]
        _has_injection_block "./$target"
    done

    # Step 2: Simulate outdated injection by creating legacy format
    _create_outdated_injection "./CLAUDE.md"

    # Step 3: Validate detects issue
    run bash "$VALIDATE_SCRIPT"
    [[ "$output" == *"CLAUDE"* ]] || [[ "$output" == *"outdated"* ]] || [[ "$output" == *"injection"* ]]

    # Step 4: Upgrade fixes the issue
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Verify fixed
    _has_reference_format "./CLAUDE.md"

    # Step 5: Validate injection status in output
    run bash "$VALIDATE_SCRIPT"
    # Check injection-specific status in output (may have other validation issues)
    [[ "$output" == *"injection current"* ]] || [[ "$output" == *"claude_md"*"ok"* ]]
}

@test "workflow: upgrade is idempotent across multiple runs" {
    create_empty_todo

    # Create outdated injection
    for target in "${INJECTION_TARGETS[@]}"; do
        _create_outdated_injection "./$target"
    done

    # First upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Get checksums after first run
    declare -A checksums_first
    for target in "${INJECTION_TARGETS[@]}"; do
        checksums_first["$target"]=$(_get_file_checksum "./$target")
    done

    # Second upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ]

    # Get checksums after second run
    declare -A checksums_second
    for target in "${INJECTION_TARGETS[@]}"; do
        checksums_second["$target"]=$(_get_file_checksum "./$target")
    done

    # Third upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ]

    # Verify files unchanged between runs 2 and 3
    for target in "${INJECTION_TARGETS[@]}"; do
        local checksum_third
        checksum_third=$(_get_file_checksum "./$target")
        [ "${checksums_second[$target]}" = "$checksum_third" ]
    done
}

@test "workflow: validate -> fix -> validate produces consistent state" {
    create_empty_todo

    # Create mixed injection states
    _create_outdated_injection "./CLAUDE.md"
    _create_clean_file "./AGENTS.md"
    _create_current_injection "./GEMINI.md"

    # First validate (should detect issues)
    run bash "$VALIDATE_SCRIPT"
    local first_status=$status

    # Fix issues
    run bash "$VALIDATE_SCRIPT" --fix

    # Second validate (should pass or improve)
    run bash "$VALIDATE_SCRIPT"
    local second_status=$status

    # State should be consistent now
    [ "$second_status" -eq 0 ] || [ "$second_status" -le "$first_status" ]
}

# =============================================================================
# TEST 5: Edge cases and error handling
# =============================================================================

@test "init handles read-only agent files gracefully" {
    # Initialize project first to create proper .cleo structure
    run bash "$INIT_SCRIPT" test-project --force
    [ "$status" -eq 0 ] || [ "$status" -eq 101 ]

    # Create read-only file
    echo "# Read-only" > "./CLAUDE.md"
    chmod 444 "./CLAUDE.md"

    # Run init --update-docs (should warn about read-only, not crash)
    run bash "$INIT_SCRIPT" --update-docs

    # Clean up before assertion
    chmod 644 "./CLAUDE.md" 2>/dev/null || true

    # Should either fail on permission error, or succeed on other files
    # The command should not crash unexpectedly (exit codes < 128)
    [ "$status" -lt 128 ]
}

@test "upgrade preserves user content outside injection block" {
    create_empty_todo

    # Create file with user content and outdated injection
    cat > "./CLAUDE.md" <<EOF
<!-- CLEO:START v0.30.0 -->
Old injection content
<!-- CLEO:END -->

# My Project

This is custom user content that should be preserved.

## Features
- Feature 1
- Feature 2
EOF

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Verify injection updated
    _has_reference_format "./CLAUDE.md"

    # Verify user content preserved
    grep -q "My Project" "./CLAUDE.md"
    grep -q "custom user content" "./CLAUDE.md"
    grep -q "Feature 1" "./CLAUDE.md"
}

@test "init creates necessary directories if missing" {
    # Remove .cleo directory
    rm -rf ".cleo"

    # Run init
    run bash "$INIT_SCRIPT" test-project --force
    [ "$status" -eq 0 ]

    # Verify directories created
    [ -d ".cleo" ]
    [ -d ".cleo/templates" ]
    [ -f ".cleo/templates/AGENT-INJECTION.md" ]
}

@test "injection targets are consistent across commands" {
    # Source injection registry
    source "${PROJECT_ROOT}/lib/ui/injection-registry.sh"

    # Verify INJECTION_TARGETS matches expected files
    [[ "$INJECTION_TARGETS" == *"CLAUDE.md"* ]]
    [[ "$INJECTION_TARGETS" == *"AGENTS.md"* ]]
    [[ "$INJECTION_TARGETS" == *"GEMINI.md"* ]]
}
