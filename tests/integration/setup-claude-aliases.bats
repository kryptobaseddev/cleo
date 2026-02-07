#!/usr/bin/env bats
# =============================================================================
# setup-claude-aliases.bats - Integration tests for setup-claude-aliases command
# =============================================================================
# Tests the CLI command for managing Claude Code CLI aliases:
#   - Help output
#   - Dry-run mode
#   - Installation workflow
#   - Removal workflow
#   - JSON output
#   - Error handling
#   - Idempotency
#
# Part of: Claude Code CLI Aliases feature (T2089)
# =============================================================================

load '../libs/bats-support/load'
load '../libs/bats-assert/load'

# ==============================================================================
# SETUP / TEARDOWN
# ==============================================================================

setup() {
    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    export TEST_HOME="$TEST_DIR/home"
    export HOME="$TEST_HOME"

    # Create home directory structure
    mkdir -p "$TEST_HOME"

    # Set up script paths
    export SCRIPT_DIR="${BATS_TEST_DIRNAME}/../../dev"
    export SETUP_SCRIPT="$SCRIPT_DIR/setup-claude-aliases.sh"

    # Mock claude CLI as installed (create a fake claude command)
    mkdir -p "$TEST_DIR/bin"
    cat > "$TEST_DIR/bin/claude" << 'EOF'
#!/bin/bash
echo "mock claude"
EOF
    chmod +x "$TEST_DIR/bin/claude"
    export PATH="$TEST_DIR/bin:$PATH"
}

teardown() {
    [[ -d "$TEST_DIR" ]] && rm -rf "$TEST_DIR"
}

# ==============================================================================
# HELP OUTPUT TESTS
# ==============================================================================

@test "--help shows usage" {
    run bash "$SETUP_SCRIPT" --help
    assert_success
    assert_output --partial "Usage:"
    assert_output --partial "setup-claude-aliases"
}

@test "-h shows usage" {
    run bash "$SETUP_SCRIPT" -h
    assert_success
    assert_output --partial "Usage:"
}

@test "--help shows available aliases" {
    run bash "$SETUP_SCRIPT" --help
    assert_success
    assert_output --partial "cc "
    assert_output --partial "ccy"
    assert_output --partial "ccr"
    assert_output --partial "ccry"
    assert_output --partial "cc-headless"
    assert_output --partial "cc-headfull"
}

@test "--help shows environment variables" {
    run bash "$SETUP_SCRIPT" --help
    assert_success
    assert_output --partial "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
    assert_output --partial "ENABLE_BACKGROUND_TASKS"
}

# ==============================================================================
# DRY-RUN TESTS
# ==============================================================================

@test "--dry-run shows preview without changes" {
    run bash "$SETUP_SCRIPT" --dry-run
    assert_success
    assert_output --partial "[DRY-RUN]"
}

@test "--dry-run --shell bash targets specific shell" {
    run bash "$SETUP_SCRIPT" --dry-run --shell bash
    assert_success
    assert_output --partial "[DRY-RUN]"
    assert_output --partial ".bashrc"
}

@test "--dry-run does not modify files" {
    local bashrc="$TEST_HOME/.bashrc"

    # Create empty bashrc
    touch "$bashrc"
    local before_size
    before_size=$(wc -c < "$bashrc")

    run bash "$SETUP_SCRIPT" --dry-run --shell bash
    assert_success

    # File should not have changed
    local after_size
    after_size=$(wc -c < "$bashrc")
    [[ "$before_size" -eq "$after_size" ]]
}

@test "--dry-run with --json outputs JSON" {
    run bash "$SETUP_SCRIPT" --dry-run --json
    assert_success

    # Should be valid JSON
    echo "$output" | jq . > /dev/null

    # Should indicate dry run
    echo "$output" | jq -e '.dryRun == true'
}

# ==============================================================================
# INSTALLATION TESTS
# ==============================================================================

@test "installation creates aliases in RC file" {
    run bash "$SETUP_SCRIPT" --shell bash
    assert_success

    # Check file was created with aliases
    local bashrc="$TEST_HOME/.bashrc"
    [[ -f "$bashrc" ]]
    grep -q "CLEO-CLAUDE-ALIASES:START" "$bashrc"
    grep -q "alias cc=" "$bashrc"
}

@test "installation reports success" {
    run bash "$SETUP_SCRIPT" --shell bash
    assert_success
    assert_output --partial "Installed"
}

@test "installation to multiple shells works" {
    # Create .zshrc directory
    run bash "$SETUP_SCRIPT"
    assert_success

    # Should mention installation (at least bash should work)
    assert_output --partial "Installed"
}

@test "installation includes all 7 aliases" {
    run bash "$SETUP_SCRIPT" --shell bash
    assert_success

    local bashrc="$TEST_HOME/.bashrc"
    grep -q "alias cc=" "$bashrc"
    grep -q "alias ccy=" "$bashrc"
    grep -q "alias ccr=" "$bashrc"
    grep -q "alias ccry=" "$bashrc"
    grep -q "alias cc-headless=" "$bashrc"
    grep -q "alias cc-headfull=" "$bashrc"
    grep -q "alias cc-headfull-stream=" "$bashrc"
}

@test "installation preserves existing RC file content" {
    local bashrc="$TEST_HOME/.bashrc"

    # Create existing bashrc with content
    cat > "$bashrc" << 'EOF'
# My custom bashrc
export MY_VAR="value"
alias ll='ls -la'
EOF

    run bash "$SETUP_SCRIPT" --shell bash
    assert_success

    # Original content should still be present
    grep -q "My custom bashrc" "$bashrc"
    grep -q "MY_VAR" "$bashrc"
    grep -q "alias ll=" "$bashrc"

    # Plus new aliases
    grep -q "CLEO-CLAUDE-ALIASES:START" "$bashrc"
}

# ==============================================================================
# REMOVAL TESTS
# ==============================================================================

@test "--remove removes aliases" {
    # First install
    bash "$SETUP_SCRIPT" --shell bash

    # Then remove
    run bash "$SETUP_SCRIPT" --remove --shell bash
    assert_success

    # Check file no longer has aliases
    local bashrc="$TEST_HOME/.bashrc"
    ! grep -q "CLEO-CLAUDE-ALIASES:START" "$bashrc"
}

@test "--remove reports success" {
    # First install
    bash "$SETUP_SCRIPT" --shell bash

    # Then remove
    run bash "$SETUP_SCRIPT" --remove --shell bash
    assert_success
    assert_output --partial "Removed"
}

@test "--remove when not installed reports skipped" {
    # Don't install, just try to remove
    run bash "$SETUP_SCRIPT" --remove --shell bash
    # Should succeed but with exit 102 (no change) or normal exit
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 102 ]]
}

@test "--remove preserves other RC file content" {
    local bashrc="$TEST_HOME/.bashrc"

    # Create bashrc with content
    cat > "$bashrc" << 'EOF'
# Before aliases
export BEFORE="yes"
EOF

    # Install aliases
    bash "$SETUP_SCRIPT" --shell bash

    # Add content after
    echo "# After aliases" >> "$bashrc"
    echo 'export AFTER="yes"' >> "$bashrc"

    # Remove aliases
    run bash "$SETUP_SCRIPT" --remove --shell bash
    assert_success

    # Check content preserved
    grep -q "BEFORE" "$bashrc"
    grep -q "AFTER" "$bashrc"

    # Aliases should be gone
    ! grep -q "CLEO-CLAUDE-ALIASES:START" "$bashrc"
}

# ==============================================================================
# JSON OUTPUT TESTS
# ==============================================================================

@test "--json outputs JSON format" {
    run bash "$SETUP_SCRIPT" --json --shell bash
    assert_success

    # Should be valid JSON
    echo "$output" | jq . > /dev/null
}

@test "--format json outputs JSON format" {
    run bash "$SETUP_SCRIPT" --format json --shell bash
    assert_success

    # Should be valid JSON
    echo "$output" | jq . > /dev/null
}

@test "JSON output has success field" {
    run bash "$SETUP_SCRIPT" --json --shell bash
    assert_success

    echo "$output" | jq -e '.success'
}

@test "JSON output has version field" {
    run bash "$SETUP_SCRIPT" --json --shell bash
    assert_success

    echo "$output" | jq -e '.version'
}

@test "JSON output has results array" {
    run bash "$SETUP_SCRIPT" --json --shell bash
    assert_success

    echo "$output" | jq -e '.results | type == "array"'
}

# ==============================================================================
# ERROR HANDLING TESTS
# ==============================================================================

@test "invalid --shell value returns error" {
    run bash "$SETUP_SCRIPT" --shell invalid_shell
    assert_failure
    assert_output --partial "Invalid shell type"
}

@test "unknown option returns error" {
    run bash "$SETUP_SCRIPT" --unknown-option
    assert_failure
    assert_output --partial "Unknown option"
}

@test "missing claude CLI returns error" {
    # Create a fresh PATH without the mock claude
    local clean_path="/usr/bin:/bin"

    run env PATH="$clean_path" bash "$SETUP_SCRIPT" --shell bash
    assert_failure
    assert_output --partial "Claude CLI not installed"
}

@test "missing claude CLI with --json returns JSON error" {
    # Create a fresh PATH without the mock claude
    local clean_path="/usr/bin:/bin"

    run env PATH="$clean_path" bash "$SETUP_SCRIPT" --json --shell bash
    assert_failure

    # Should be valid JSON with error
    echo "$output" | jq -e '.success == false'
    echo "$output" | jq -e '.error.code == "E_DEPENDENCY_ERROR"'
}

# ==============================================================================
# IDEMPOTENCY TESTS
# ==============================================================================

@test "re-running returns exit code 102 (no changes)" {
    # First install
    bash "$SETUP_SCRIPT" --shell bash

    # Second install (should be no-op)
    run bash "$SETUP_SCRIPT" --shell bash
    # Exit 102 = EXIT_NO_CHANGE
    [[ "$status" -eq 102 ]]
}

@test "re-running shows already current" {
    # First install
    bash "$SETUP_SCRIPT" --shell bash

    # Second install
    run bash "$SETUP_SCRIPT" --shell bash
    # Should mention skipped/already
    [[ "$output" == *"already_current"* ]] || [[ "$output" == *"Skipped"* ]]
}

@test "--force reinstalls even if current" {
    # First install
    bash "$SETUP_SCRIPT" --shell bash

    # Force reinstall
    run bash "$SETUP_SCRIPT" --force --shell bash
    assert_success
    assert_output --partial "Installed"
}

@test "--force with --json shows updated action" {
    # First install
    bash "$SETUP_SCRIPT" --shell bash

    # Force reinstall with JSON
    run bash "$SETUP_SCRIPT" --force --json --shell bash
    assert_success

    # Should show installed > 0
    local installed
    installed=$(echo "$output" | jq -r '.installed')
    [[ "$installed" -gt 0 ]]
}

# ==============================================================================
# QUIET MODE TESTS
# ==============================================================================

@test "--quiet suppresses output" {
    run bash "$SETUP_SCRIPT" --quiet --shell bash
    assert_success

    # Output should be minimal (no "Installed" message)
    [[ -z "$output" ]] || [[ ! "$output" =~ "Installed" ]]
}

@test "-q suppresses output" {
    run bash "$SETUP_SCRIPT" -q --shell bash
    assert_success

    # Output should be minimal
    [[ -z "$output" ]] || [[ ! "$output" =~ "Installed" ]]
}

@test "--quiet still creates aliases" {
    run bash "$SETUP_SCRIPT" --quiet --shell bash
    assert_success

    # File should have aliases
    local bashrc="$TEST_HOME/.bashrc"
    [[ -f "$bashrc" ]]
    grep -q "CLEO-CLAUDE-ALIASES:START" "$bashrc"
}

# ==============================================================================
# SHELL TARGETING TESTS
# ==============================================================================

@test "--shell zsh targets only zsh" {
    run bash "$SETUP_SCRIPT" --shell zsh
    assert_success

    # Only zshrc should have aliases
    local zshrc="$TEST_HOME/.zshrc"
    [[ -f "$zshrc" ]]
    grep -q "CLEO-CLAUDE-ALIASES:START" "$zshrc"

    # bashrc should not exist or not have aliases
    local bashrc="$TEST_HOME/.bashrc"
    if [[ -f "$bashrc" ]]; then
        ! grep -q "CLEO-CLAUDE-ALIASES:START" "$bashrc"
    fi
}

# ==============================================================================
# ENVIRONMENT VARIABLE TESTS
# ==============================================================================

@test "aliases include CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" {
    run bash "$SETUP_SCRIPT" --shell bash
    assert_success

    local bashrc="$TEST_HOME/.bashrc"
    grep -q "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true" "$bashrc"
}

@test "aliases include ENABLE_BACKGROUND_TASKS" {
    run bash "$SETUP_SCRIPT" --shell bash
    assert_success

    local bashrc="$TEST_HOME/.bashrc"
    grep -q "ENABLE_BACKGROUND_TASKS=true" "$bashrc"
}

@test "aliases include FORCE_AUTO_BACKGROUND_TASKS" {
    run bash "$SETUP_SCRIPT" --shell bash
    assert_success

    local bashrc="$TEST_HOME/.bashrc"
    grep -q "FORCE_AUTO_BACKGROUND_TASKS=true" "$bashrc"
}

@test "aliases include CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL" {
    run bash "$SETUP_SCRIPT" --shell bash
    assert_success

    local bashrc="$TEST_HOME/.bashrc"
    grep -q "CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL=true" "$bashrc"
}
