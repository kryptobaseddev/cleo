#!/usr/bin/env bats
# Unit tests for lib/skills/agents-install.sh
# Tests agent discovery, installation, and uninstallation functions

load '../libs/bats-support/load'
load '../libs/bats-assert/load'

setup() {
    # Create test environment
    export TEST_DIR="$(mktemp -d)"
    export CLEO_REPO_ROOT="$TEST_DIR/repo"
    export AGENTS_TARGET_DIR="$TEST_DIR/target"

    # Create mock repository structure
    mkdir -p "$CLEO_REPO_ROOT/lib"
    mkdir -p "$CLEO_REPO_ROOT/templates/agents"
    mkdir -p "$AGENTS_TARGET_DIR"

    # Create mock agent files
    echo "# CLEO Subagent" > "$CLEO_REPO_ROOT/templates/agents/cleo-subagent.md"
    echo "# Another Agent" > "$CLEO_REPO_ROOT/templates/agents/another-agent.md"

    # Copy the agents-install.sh to test location
    # BATS_TEST_DIRNAME is tests/unit, so we need to go up twice to repo root
    cp "$BATS_TEST_DIRNAME/../../lib/skills/agents-install.sh" "$CLEO_REPO_ROOT/lib/"

    # Source the library
    source "$CLEO_REPO_ROOT/lib/skills/agents-install.sh"
}

teardown() {
    rm -rf "$TEST_DIR"
}

# ============================================================================
# install_agent tests - Symlink Mode (default)
# ============================================================================

@test "install_agent creates symlink when target doesn't exist" {
    run install_agent "cleo-subagent.md" "symlink" "echo"
    assert_success
    assert_output --partial "Installed agent (symlink)"

    # Verify symlink was created
    assert [ -L "$AGENTS_TARGET_DIR/cleo-subagent.md" ]

    # Verify symlink points to correct location
    local target
    target=$(readlink -f "$AGENTS_TARGET_DIR/cleo-subagent.md")
    local expected
    expected=$(cd "$CLEO_REPO_ROOT/templates/agents" && pwd)/cleo-subagent.md
    assert_equal "$target" "$expected"
}

@test "install_agent symlink points to correct source location" {
    install_agent "cleo-subagent.md" "symlink" "echo"

    # Verify symlink target
    local link_target
    link_target=$(readlink "$AGENTS_TARGET_DIR/cleo-subagent.md")
    assert_equal "$link_target" "$CLEO_REPO_ROOT/templates/agents/cleo-subagent.md"
}

@test "install_agent is idempotent - same symlink returns success" {
    # First install
    install_agent "cleo-subagent.md" "symlink" "echo"

    # Second install should detect existing and succeed
    run install_agent "cleo-subagent.md" "symlink" "echo"
    assert_success
    assert_output --partial "Agent already installed"

    # Should still be a symlink
    assert [ -L "$AGENTS_TARGET_DIR/cleo-subagent.md" ]
}

@test "install_agent refreshes symlink when pointing to different location" {
    # Create symlink to different location
    local old_source="$TEST_DIR/old-location.md"
    echo "# Old Agent" > "$old_source"
    ln -s "$old_source" "$AGENTS_TARGET_DIR/cleo-subagent.md"

    # Install should update the symlink
    run install_agent "cleo-subagent.md" "symlink" "echo"
    assert_success
    assert_output --partial "Updating agent installation"

    # Verify symlink now points to new location
    local target
    target=$(readlink "$AGENTS_TARGET_DIR/cleo-subagent.md")
    assert_equal "$target" "$CLEO_REPO_ROOT/templates/agents/cleo-subagent.md"
}

# ============================================================================
# install_agent tests - Copy Mode
# ============================================================================

@test "install_agent creates regular file copy when mode=copy" {
    run install_agent "cleo-subagent.md" "copy" "echo"
    assert_success
    assert_output --partial "Installed agent (copy)"

    # Verify it's a regular file, not symlink
    assert [ -f "$AGENTS_TARGET_DIR/cleo-subagent.md" ]
    assert [ ! -L "$AGENTS_TARGET_DIR/cleo-subagent.md" ]
}

@test "install_agent copy matches source content" {
    install_agent "cleo-subagent.md" "copy" "echo"

    # Verify content matches
    run diff "$CLEO_REPO_ROOT/templates/agents/cleo-subagent.md" "$AGENTS_TARGET_DIR/cleo-subagent.md"
    assert_success
}

# ============================================================================
# install_agent tests - Existing File Preservation
# ============================================================================

@test "install_agent does NOT overwrite existing regular file" {
    # Create existing regular file (user customization)
    echo "# User Customized Agent" > "$AGENTS_TARGET_DIR/cleo-subagent.md"

    # Install should preserve existing file
    run install_agent "cleo-subagent.md" "symlink" "echo"
    assert_success
    assert_output --partial "Preserving existing agent file"

    # Verify file content unchanged
    run grep "User Customized Agent" "$AGENTS_TARGET_DIR/cleo-subagent.md"
    assert_success

    # Should still be a regular file, not symlink
    assert [ -f "$AGENTS_TARGET_DIR/cleo-subagent.md" ]
    assert [ ! -L "$AGENTS_TARGET_DIR/cleo-subagent.md" ]
}

@test "install_agent preserves existing regular file even in copy mode" {
    # Create existing regular file
    echo "# User Customized Agent" > "$AGENTS_TARGET_DIR/cleo-subagent.md"

    # Install in copy mode should still preserve
    run install_agent "cleo-subagent.md" "copy" "echo"
    assert_success
    assert_output --partial "Preserving existing agent file"

    # Verify file content unchanged
    run grep "User Customized Agent" "$AGENTS_TARGET_DIR/cleo-subagent.md"
    assert_success
}

# ============================================================================
# install_agent tests - Broken Symlink Handling
# ============================================================================

@test "install_agent removes and recreates broken symlink" {
    # Create broken symlink
    ln -s "/nonexistent/path/agent.md" "$AGENTS_TARGET_DIR/cleo-subagent.md"

    # Verify it's broken
    assert [ -L "$AGENTS_TARGET_DIR/cleo-subagent.md" ]
    assert [ ! -e "$AGENTS_TARGET_DIR/cleo-subagent.md" ]

    # Install should fix broken symlink
    run install_agent "cleo-subagent.md" "symlink" "echo"
    assert_success
    assert_output --partial "Updating agent installation"

    # Verify symlink is now valid
    assert [ -L "$AGENTS_TARGET_DIR/cleo-subagent.md" ]
    assert [ -e "$AGENTS_TARGET_DIR/cleo-subagent.md" ]

    # Verify it points to correct location
    local target
    target=$(readlink "$AGENTS_TARGET_DIR/cleo-subagent.md")
    assert_equal "$target" "$CLEO_REPO_ROOT/templates/agents/cleo-subagent.md"
}

# ============================================================================
# install_agent tests - Error Handling
# ============================================================================

@test "install_agent fails when source file not found" {
    run install_agent "nonexistent-agent.md" "symlink" "echo"
    assert_failure
    assert_output --partial "Agent source file not found"
}

@test "install_agent fails with invalid mode" {
    run install_agent "cleo-subagent.md" "invalid-mode" "echo"
    assert_failure
    assert_output --partial "Invalid mode"
}

@test "install_agent handles permission errors gracefully" {
    # Make target directory read-only
    chmod 555 "$AGENTS_TARGET_DIR"

    # Install should fail gracefully
    run install_agent "cleo-subagent.md" "symlink" "echo"
    assert_failure
    assert_output --partial "Failed to create symlink"

    # Restore permissions for teardown
    chmod 755 "$AGENTS_TARGET_DIR"
}

# ============================================================================
# install_agents tests - Batch Installation
# ============================================================================

@test "install_agents installs all agents from templates/agents/" {
    run install_agents "symlink" "echo"
    assert_success

    # Both agents should be installed
    assert [ -L "$AGENTS_TARGET_DIR/cleo-subagent.md" ]
    assert [ -L "$AGENTS_TARGET_DIR/another-agent.md" ]
}

@test "install_agents uses symlink mode by default" {
    install_agents "symlink" "echo"

    # Verify both are symlinks
    assert [ -L "$AGENTS_TARGET_DIR/cleo-subagent.md" ]
    assert [ -L "$AGENTS_TARGET_DIR/another-agent.md" ]
}

@test "install_agents respects copy mode" {
    install_agents "copy" "echo"

    # Verify both are regular files
    assert [ -f "$AGENTS_TARGET_DIR/cleo-subagent.md" ]
    assert [ -f "$AGENTS_TARGET_DIR/another-agent.md" ]
    assert [ ! -L "$AGENTS_TARGET_DIR/cleo-subagent.md" ]
    assert [ ! -L "$AGENTS_TARGET_DIR/another-agent.md" ]
}

@test "install_agents creates target directory if missing" {
    rm -rf "$AGENTS_TARGET_DIR"

    run install_agents "symlink" "echo"
    assert_success

    # Directory should be created
    assert [ -d "$AGENTS_TARGET_DIR" ]

    # Agents should be installed
    assert [ -L "$AGENTS_TARGET_DIR/cleo-subagent.md" ]
}

@test "install_agents handles missing source directory gracefully" {
    rm -rf "$CLEO_REPO_ROOT/templates/agents"

    run install_agents "symlink" "echo"
    assert_success
    assert_output --partial "Agents source directory not found"
}

@test "install_agents shows summary of installation results" {
    run install_agents "symlink" "echo"
    assert_success
    assert_output --partial "Agents installation complete"
    assert_output --partial "installed"
}

# ============================================================================
# install_agents tests - Idempotent Behavior
# ============================================================================

@test "install_agents is idempotent - running twice produces same result" {
    # First run
    run install_agents "symlink" "echo"
    assert_success
    local first_output="$output"

    # Get file stats for comparison
    local stat1
    stat1=$(stat -c "%Y" "$AGENTS_TARGET_DIR/cleo-subagent.md" 2>/dev/null || stat -f "%m" "$AGENTS_TARGET_DIR/cleo-subagent.md")

    # Wait a moment to ensure timestamp would change if file is recreated
    sleep 1

    # Second run
    run install_agents "symlink" "echo"
    assert_success

    # Get file stats again
    local stat2
    stat2=$(stat -c "%Y" "$AGENTS_TARGET_DIR/cleo-subagent.md" 2>/dev/null || stat -f "%m" "$AGENTS_TARGET_DIR/cleo-subagent.md")

    # Files should not have been modified (timestamp unchanged)
    assert_equal "$stat1" "$stat2"

    # Should indicate agents already installed
    assert_output --partial "Agent already installed"
}

@test "install_agents handles mix of existing symlinks and new agents" {
    # Install one agent manually
    install_agent "cleo-subagent.md" "symlink" "echo"

    # Run install_agents (should skip existing, install new)
    run install_agents "symlink" "echo"
    assert_success

    # Both should be installed
    assert [ -L "$AGENTS_TARGET_DIR/cleo-subagent.md" ]
    assert [ -L "$AGENTS_TARGET_DIR/another-agent.md" ]
}

@test "install_agents counts preserved files correctly" {
    # Create a user-customized agent
    echo "# Custom" > "$AGENTS_TARGET_DIR/cleo-subagent.md"

    # Run installation
    run install_agents "symlink" "echo"
    assert_success

    # Summary should show preserved count
    assert_output --partial "preserved"

    # Customized file should be preserved
    run grep "Custom" "$AGENTS_TARGET_DIR/cleo-subagent.md"
    assert_success

    # Other agent should be installed
    assert [ -L "$AGENTS_TARGET_DIR/another-agent.md" ]
}

# ============================================================================
# uninstall_agents tests
# ============================================================================

@test "uninstall_agents removes symlinks only" {
    # Install agents via symlink
    install_agents "symlink" "echo"

    # Create a regular file that should not be removed
    echo "# User Agent" > "$AGENTS_TARGET_DIR/user-agent.md"

    # Uninstall
    run uninstall_agents "echo"
    assert_success

    # Symlinks should be removed
    assert [ ! -e "$AGENTS_TARGET_DIR/cleo-subagent.md" ]
    assert [ ! -e "$AGENTS_TARGET_DIR/another-agent.md" ]

    # Regular file should remain
    assert [ -f "$AGENTS_TARGET_DIR/user-agent.md" ]
}

@test "uninstall_agents preserves regular files (user customizations)" {
    # Install one agent as symlink, one as copy
    install_agent "cleo-subagent.md" "symlink" "echo"
    install_agent "another-agent.md" "copy" "echo"

    # Uninstall
    run uninstall_agents "echo"
    assert_success

    # Symlink should be removed
    assert [ ! -e "$AGENTS_TARGET_DIR/cleo-subagent.md" ]

    # Regular file (copy) should be preserved
    assert [ -f "$AGENTS_TARGET_DIR/another-agent.md" ]
}

@test "uninstall_agents handles empty directory gracefully" {
    rm -rf "$AGENTS_TARGET_DIR"/*

    run uninstall_agents "echo"
    assert_success
}

@test "uninstall_agents handles missing directory gracefully" {
    rm -rf "$AGENTS_TARGET_DIR"

    run uninstall_agents "echo"
    assert_success
    assert_output --partial "does not exist"
}

# ============================================================================
# list_installed_agents tests
# ============================================================================

@test "list_installed_agents returns valid JSON array" {
    run list_installed_agents
    assert_success

    # Should be valid JSON
    echo "$output" | jq . > /dev/null
}

@test "list_installed_agents shows installed symlinks" {
    install_agent "cleo-subagent.md" "symlink" "echo"

    run list_installed_agents
    assert_success

    # Check status for installed agent
    local status
    status=$(echo "$output" | jq -r '.[] | select(.name == "cleo-subagent.md") | .status')
    assert_equal "$status" "installed"

    # Check isSymlink flag
    local is_symlink
    is_symlink=$(echo "$output" | jq -r '.[] | select(.name == "cleo-subagent.md") | .isSymlink')
    assert_equal "$is_symlink" "true"
}

@test "list_installed_agents shows installed regular files" {
    install_agent "cleo-subagent.md" "copy" "echo"

    run list_installed_agents
    assert_success

    # Check status for installed agent
    local status
    status=$(echo "$output" | jq -r '.[] | select(.name == "cleo-subagent.md") | .status')
    assert_equal "$status" "installed_file"

    # Check isSymlink flag
    local is_symlink
    is_symlink=$(echo "$output" | jq -r '.[] | select(.name == "cleo-subagent.md") | .isSymlink')
    assert_equal "$is_symlink" "false"
}

@test "list_installed_agents skips broken symlinks" {
    # Create broken symlink
    ln -s "/nonexistent/path/agent.md" "$AGENTS_TARGET_DIR/broken-agent.md"

    # Also install a valid agent for comparison
    install_agent "cleo-subagent.md" "symlink" "echo"

    run list_installed_agents
    assert_success

    # Valid agent should be in the list
    local valid_count
    valid_count=$(echo "$output" | jq -r '.[] | select(.name == "cleo-subagent.md") | .status' | wc -l)
    assert_equal "$valid_count" "1"

    # Broken symlink should be skipped (not in the list)
    local broken_count
    broken_count=$(echo "$output" | jq -r '.[] | select(.name == "broken-agent.md") | .status' | wc -l)
    assert_equal "$broken_count" "0"
}

@test "list_installed_agents returns empty array when no agents" {
    run list_installed_agents
    assert_success

    # Should return empty JSON array
    assert_equal "$output" "[]"
}

@test "list_installed_agents handles missing target directory" {
    rm -rf "$AGENTS_TARGET_DIR"

    run list_installed_agents
    assert_success

    # Should return empty JSON array
    assert_equal "$output" "[]"
}
