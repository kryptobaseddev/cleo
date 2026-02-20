#!/usr/bin/env bats
# Unit tests for lib/skills/skills-install.sh
# Tests skill discovery, installation, and uninstallation functions

load '../libs/bats-support/load'
load '../libs/bats-assert/load'

setup() {
    # Create test environment
    export TEST_DIR="$(mktemp -d)"
    export CLEO_REPO_ROOT="$TEST_DIR/repo"
    export SKILLS_TARGET_DIR="$TEST_DIR/target"

    # Create mock repository structure
    mkdir -p "$CLEO_REPO_ROOT/lib"
    mkdir -p "$CLEO_REPO_ROOT/skills/ct-test-skill"
    mkdir -p "$CLEO_REPO_ROOT/skills/ct-another-skill"
    mkdir -p "$SKILLS_TARGET_DIR"

    # Create mock SKILL.md files
    echo "# Test Skill" > "$CLEO_REPO_ROOT/skills/ct-test-skill/SKILL.md"
    echo "# Another Skill" > "$CLEO_REPO_ROOT/skills/ct-another-skill/SKILL.md"

    # Create mock manifest.json
    cat > "$CLEO_REPO_ROOT/skills/manifest.json" << 'EOF'
{
  "_meta": {
    "schemaVersion": "1.0.0",
    "totalSkills": 3
  },
  "skills": [
    {
      "name": "ct-test-skill",
      "version": "1.0.0",
      "description": "Test skill for unit testing",
      "path": "skills/ct-test-skill",
      "tags": ["test"],
      "status": "active"
    },
    {
      "name": "ct-another-skill",
      "version": "1.0.0",
      "description": "Another test skill",
      "path": "skills/ct-another-skill",
      "tags": ["test"],
      "status": "active"
    },
    {
      "name": "ct-inactive-skill",
      "version": "1.0.0",
      "description": "Inactive skill should be skipped",
      "path": "skills/ct-inactive-skill",
      "tags": ["test"],
      "status": "inactive"
    }
  ]
}
EOF

    # Copy the skills-install.sh to test location
    # BATS_TEST_DIRNAME is tests/unit, so we need to go up twice to repo root
    cp "$BATS_TEST_DIRNAME/../../lib/skills/skills-install.sh" "$CLEO_REPO_ROOT/lib/"

    # Source the library
    source "$CLEO_REPO_ROOT/lib/skills/skills-install.sh"
}

teardown() {
    rm -rf "$TEST_DIR"
}

# ============================================================================
# get_skills_from_manifest tests
# ============================================================================

@test "get_skills_from_manifest returns only active skills" {
    run get_skills_from_manifest
    assert_success
    assert_line "ct-test-skill"
    assert_line "ct-another-skill"
    refute_line "ct-inactive-skill"
}

@test "get_skills_from_manifest fails when manifest not found" {
    rm "$CLEO_REPO_ROOT/skills/manifest.json"
    run get_skills_from_manifest
    assert_failure
    assert_output --partial "manifest not found"
}

# ============================================================================
# get_skill_path tests
# ============================================================================

@test "get_skill_path returns correct path for skill" {
    run get_skill_path "ct-test-skill"
    assert_success
    assert_output "skills/ct-test-skill"
}

@test "get_skill_path returns empty for non-existent skill" {
    run get_skill_path "ct-nonexistent"
    assert_success
    assert_output ""
}

# ============================================================================
# install_skill tests
# ============================================================================

@test "install_skill creates symlink for valid skill" {
    run install_skill "ct-test-skill" "echo"
    assert_success
    assert [ -L "$SKILLS_TARGET_DIR/ct-test-skill" ]

    # Verify symlink points to correct location
    local target
    target=$(readlink "$SKILLS_TARGET_DIR/ct-test-skill")
    assert [ "$target" = "$CLEO_REPO_ROOT/skills/ct-test-skill" ]
}

@test "install_skill detects already installed skill" {
    # First install
    install_skill "ct-test-skill" "echo"

    # Second install should detect existing
    run install_skill "ct-test-skill" "echo"
    assert_success
    assert_output --partial "already installed"
}

@test "install_skill skips when directory exists (not symlink)" {
    # Create regular directory instead of symlink
    mkdir -p "$SKILLS_TARGET_DIR/ct-test-skill"

    run install_skill "ct-test-skill" "echo"
    assert_success
    assert_output --partial "exists as directory"

    # Should still be a directory, not symlink
    assert [ -d "$SKILLS_TARGET_DIR/ct-test-skill" ]
    assert [ ! -L "$SKILLS_TARGET_DIR/ct-test-skill" ]
}

@test "install_skill fails for non-existent skill" {
    run install_skill "ct-nonexistent-skill" "echo"
    assert_failure
    assert_output --partial "not found in manifest"
}

# ============================================================================
# install_skills tests
# ============================================================================

@test "install_skills installs all active skills" {
    run install_skills "false" "echo"
    assert_success

    # Both active skills should be installed
    assert [ -L "$SKILLS_TARGET_DIR/ct-test-skill" ]
    assert [ -L "$SKILLS_TARGET_DIR/ct-another-skill" ]

    # Inactive skill should not be installed
    assert [ ! -e "$SKILLS_TARGET_DIR/ct-inactive-skill" ]
}

@test "install_skills skips when skip_skills is true" {
    run install_skills "true" "echo"
    assert_success
    assert_output --partial "Skipping skills installation"

    # No skills should be installed
    assert [ ! -e "$SKILLS_TARGET_DIR/ct-test-skill" ]
}

@test "install_skills handles missing target directory" {
    rm -rf "$SKILLS_TARGET_DIR"

    run install_skills "false" "echo"
    assert_success

    # Directory should be created
    assert [ -d "$SKILLS_TARGET_DIR" ]

    # Skills should be installed
    assert [ -L "$SKILLS_TARGET_DIR/ct-test-skill" ]
}

# ============================================================================
# uninstall_skills tests
# ============================================================================

@test "uninstall_skills removes symlinks only" {
    # Install skills first
    install_skills "false" "echo"

    # Create a regular directory that should not be removed
    mkdir -p "$SKILLS_TARGET_DIR/ct-manual-skill"

    # Uninstall
    run uninstall_skills "echo"
    assert_success

    # Symlinks should be removed
    assert [ ! -e "$SKILLS_TARGET_DIR/ct-test-skill" ]
    assert [ ! -e "$SKILLS_TARGET_DIR/ct-another-skill" ]

    # Regular directory should remain
    assert [ -d "$SKILLS_TARGET_DIR/ct-manual-skill" ]
}

@test "uninstall_skills handles empty directory" {
    run uninstall_skills "echo"
    assert_success
}

# ============================================================================
# list_installed_skills tests
# ============================================================================

@test "list_installed_skills returns JSON array" {
    run list_installed_skills
    assert_success

    # Should be valid JSON
    echo "$output" | jq . > /dev/null
    assert_success
}

@test "list_installed_skills shows not_installed status initially" {
    run list_installed_skills
    assert_success

    local status
    status=$(echo "$output" | jq -r '.[] | select(.name == "ct-test-skill") | .status')
    assert_equal "$status" "not_installed"
}

@test "list_installed_skills shows installed status after installation" {
    install_skill "ct-test-skill" "echo"

    run list_installed_skills
    assert_success

    local status
    status=$(echo "$output" | jq -r '.[] | select(.name == "ct-test-skill") | .status')
    assert_equal "$status" "installed"

    local is_symlink
    is_symlink=$(echo "$output" | jq -r '.[] | select(.name == "ct-test-skill") | .isSymlink')
    assert_equal "$is_symlink" "true"
}
