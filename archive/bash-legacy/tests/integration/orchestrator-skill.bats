#!/usr/bin/env bats
# =============================================================================
# orchestrator-skill.bats - Integration tests for Orchestrator Skill
# =============================================================================
# Tests the orchestrator skill installation, verification, and content:
# - Skill installation (--install creates proper structure)
# - Skill verification (--verify validates installation)
# - Skill content (SKILL.md has required ORC constraints and frontmatter)
# - Context isolation (subagents do NOT inherit orchestrator constraints)
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    common_setup_per_test

    # Create empty todo for task operations
    create_empty_todo

    # Ensure CLEO_HOME is set for skill source
    export CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

    # Set up orchestrator fixtures path
    export ORCH_FIXTURES="${FIXTURES_DIR}/orchestrator"

    # Source libraries for orchestrator functions
    source "${LIB_DIR}/skills/orchestrator-startup.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper Functions
# =============================================================================

# Create test task structure for spawn testing
create_test_tasks() {
    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    cat > "$todo_file" << 'EOF'
{
  "version": "2.6.0",
  "project": "test",
  "tasks": [
    {
      "id": "T001",
      "title": "Test Epic",
      "description": "An epic for testing orchestrator",
      "status": "active",
      "type": "epic",
      "priority": "high",
      "createdAt": "2026-01-19T10:00:00Z",
      "updatedAt": "2026-01-19T10:00:00Z"
    },
    {
      "id": "T002",
      "title": "Test Task",
      "description": "A task under the epic",
      "status": "pending",
      "type": "task",
      "parentId": "T001",
      "priority": "medium",
      "createdAt": "2026-01-19T10:00:00Z",
      "updatedAt": "2026-01-19T10:00:00Z"
    }
  ]
}
EOF
}

# =============================================================================
# SKILL INSTALLATION TESTS
# =============================================================================

@test "skill: --install creates directory structure" {
    # Verify source exists first
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    run bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    assert_success
    assert [ -d ".cleo/skills/orchestrator" ]
    assert [ -f ".cleo/skills/orchestrator/SKILL.md" ]
}

@test "skill: --install copies INSTALL.md" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    run bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    assert_success
    assert [ -f ".cleo/skills/orchestrator/INSTALL.md" ]
}

@test "skill: --install copies references directory" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"
    [[ -d "$CLEO_HOME/skills/orchestrator/references" ]] || skip "No references directory in source"

    run bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    assert_success
    assert [ -d ".cleo/skills/orchestrator/references" ]
}

@test "skill: --install returns JSON with success and file count" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    run bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    assert_success

    # Parse JSON output
    local success
    success=$(echo "$output" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Should report files copied
    local files_copied
    files_copied=$(echo "$output" | jq -r '.installed.filesCopied')
    [[ "$files_copied" -gt 0 ]]
}

@test "skill: --install is idempotent (can run multiple times)" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    # First install
    run bash "$SCRIPTS_DIR/orchestrator.sh" skill --install
    assert_success

    # Second install should also succeed
    run bash "$SCRIPTS_DIR/orchestrator.sh" skill --install
    assert_success

    # Files should still exist
    assert [ -f ".cleo/skills/orchestrator/SKILL.md" ]
}

# =============================================================================
# SKILL VERIFICATION TESTS
# =============================================================================

@test "skill: --verify reports not_installed before install" {
    run bash "$SCRIPTS_DIR/orchestrator.sh" skill --verify

    assert_success

    local status
    status=$(echo "$output" | jq -r '.verification.status')
    [[ "$status" == "not_installed" ]]

    local installed
    installed=$(echo "$output" | jq -r '.verification.installed')
    [[ "$installed" == "false" ]]
}

@test "skill: --verify reports valid after install" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    run bash "$SCRIPTS_DIR/orchestrator.sh" skill --verify

    assert_success

    local status
    status=$(echo "$output" | jq -r '.verification.status')
    [[ "$status" == "valid" ]]

    local installed
    installed=$(echo "$output" | jq -r '.verification.installed')
    [[ "$installed" == "true" ]]
}

@test "skill: --verify detects missing SKILL.md" {
    # Create partial installation without SKILL.md
    mkdir -p ".cleo/skills/orchestrator"
    touch ".cleo/skills/orchestrator/INSTALL.md"

    run bash "$SCRIPTS_DIR/orchestrator.sh" skill --verify

    assert_success

    local status
    status=$(echo "$output" | jq -r '.verification.status')
    [[ "$status" == "invalid" ]]

    # Should have issue about missing SKILL.md
    local issues
    issues=$(echo "$output" | jq -r '.verification.issues[]')
    [[ "$issues" =~ "SKILL.md missing" ]]
}

@test "skill: --verify detects missing frontmatter" {
    # Create installation with SKILL.md but no frontmatter
    mkdir -p ".cleo/skills/orchestrator"
    echo "# Orchestrator" > ".cleo/skills/orchestrator/SKILL.md"
    touch ".cleo/skills/orchestrator/INSTALL.md"

    run bash "$SCRIPTS_DIR/orchestrator.sh" skill --verify

    assert_success

    local status
    status=$(echo "$output" | jq -r '.verification.status')
    [[ "$status" == "invalid" ]]

    # Should have issue about missing frontmatter
    local issues
    issues=$(echo "$output" | jq -r '.verification.issues | join(" ")')
    [[ "$issues" =~ "frontmatter" ]]
}

@test "skill: --verify detects missing ORC constraints" {
    # Create installation with frontmatter but no ORC constraints
    mkdir -p ".cleo/skills/orchestrator"
    cat > ".cleo/skills/orchestrator/SKILL.md" << 'EOF'
---
name: orchestrator
description: Test skill
version: 1.0.0
---
# Orchestrator
No constraints here.
EOF
    touch ".cleo/skills/orchestrator/INSTALL.md"

    run bash "$SCRIPTS_DIR/orchestrator.sh" skill --verify

    assert_success

    local status
    status=$(echo "$output" | jq -r '.verification.status')
    [[ "$status" == "invalid" ]]

    # Should have issue about missing ORC constraints
    local issues
    issues=$(echo "$output" | jq -r '.verification.issues | join(" ")')
    [[ "$issues" =~ "ORC constraints" ]]
}

# =============================================================================
# SKILL CONTENT TESTS
# =============================================================================

@test "skill: SKILL.md contains all 5 ORC constraints" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    # Count ORC-00X patterns
    local orc_count
    orc_count=$(grep -c "ORC-00[1-5]" ".cleo/skills/orchestrator/SKILL.md" || echo "0")
    [[ "$orc_count" -eq 5 ]]
}

@test "skill: SKILL.md contains ORC-001 (Stay high-level)" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    run grep "ORC-001" ".cleo/skills/orchestrator/SKILL.md"
    assert_success
}

@test "skill: SKILL.md contains ORC-002 (Delegate ALL work)" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    run grep "ORC-002" ".cleo/skills/orchestrator/SKILL.md"
    assert_success
}

@test "skill: SKILL.md contains ORC-003 (No full file reads)" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    run grep "ORC-003" ".cleo/skills/orchestrator/SKILL.md"
    assert_success
}

@test "skill: SKILL.md contains ORC-004 (Dependency order)" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    run grep "ORC-004" ".cleo/skills/orchestrator/SKILL.md"
    assert_success
}

@test "skill: SKILL.md contains ORC-005 (Context budget)" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    run grep "ORC-005" ".cleo/skills/orchestrator/SKILL.md"
    assert_success
}

@test "skill: SKILL.md contains session startup protocol" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    run grep -i "session startup" ".cleo/skills/orchestrator/SKILL.md"
    assert_success
}

@test "skill: SKILL.md frontmatter has name field" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    run grep "^name:" ".cleo/skills/orchestrator/SKILL.md"
    assert_success
}

@test "skill: SKILL.md frontmatter has description field" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    run grep "^description:" ".cleo/skills/orchestrator/SKILL.md"
    assert_success
}

@test "skill: SKILL.md frontmatter has version field" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    run grep "^version:" ".cleo/skills/orchestrator/SKILL.md"
    assert_success
}

@test "skill: SKILL.md frontmatter has triggers field" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    run grep "^triggers:" ".cleo/skills/orchestrator/SKILL.md"
    assert_success
}

# =============================================================================
# CONTEXT ISOLATION TESTS (CRITICAL)
# =============================================================================

@test "isolation: subagent spawn prompt does NOT contain ORC-001" {
    create_test_tasks

    # Generate spawn prompt
    run bash "$SCRIPTS_DIR/orchestrator.sh" spawn T002

    assert_success

    # Extract the prompt content
    local prompt
    prompt=$(echo "$output" | jq -r '.result.prompt')

    # CRITICAL: Prompt must NOT contain orchestrator constraints
    if [[ "$prompt" =~ "ORC-001" ]]; then
        fail "Subagent prompt contains ORC-001 (orchestrator constraint leak)"
    fi
}

@test "isolation: subagent spawn prompt does NOT contain ORC-002" {
    create_test_tasks

    run bash "$SCRIPTS_DIR/orchestrator.sh" spawn T002

    assert_success

    local prompt
    prompt=$(echo "$output" | jq -r '.result.prompt')

    if [[ "$prompt" =~ "ORC-002" ]]; then
        fail "Subagent prompt contains ORC-002 (orchestrator constraint leak)"
    fi
}

@test "isolation: subagent spawn prompt does NOT contain ORC-003" {
    create_test_tasks

    run bash "$SCRIPTS_DIR/orchestrator.sh" spawn T002

    assert_success

    local prompt
    prompt=$(echo "$output" | jq -r '.result.prompt')

    if [[ "$prompt" =~ "ORC-003" ]]; then
        fail "Subagent prompt contains ORC-003 (orchestrator constraint leak)"
    fi
}

@test "isolation: subagent spawn prompt does NOT contain ORC-004" {
    create_test_tasks

    run bash "$SCRIPTS_DIR/orchestrator.sh" spawn T002

    assert_success

    local prompt
    prompt=$(echo "$output" | jq -r '.result.prompt')

    if [[ "$prompt" =~ "ORC-004" ]]; then
        fail "Subagent prompt contains ORC-004 (orchestrator constraint leak)"
    fi
}

@test "isolation: subagent spawn prompt does NOT contain ORC-005" {
    create_test_tasks

    run bash "$SCRIPTS_DIR/orchestrator.sh" spawn T002

    assert_success

    local prompt
    prompt=$(echo "$output" | jq -r '.result.prompt')

    if [[ "$prompt" =~ "ORC-005" ]]; then
        fail "Subagent prompt contains ORC-005 (orchestrator constraint leak)"
    fi
}

@test "isolation: subagent spawn prompt does NOT contain 'Orchestrator Protocol' title" {
    create_test_tasks

    run bash "$SCRIPTS_DIR/orchestrator.sh" spawn T002

    assert_success

    local prompt
    prompt=$(echo "$output" | jq -r '.result.prompt')

    # Should not contain orchestrator protocol title
    if [[ "$prompt" =~ "# Orchestrator Protocol" ]]; then
        fail "Subagent prompt contains Orchestrator Protocol title (orchestrator constraint leak)"
    fi
}

@test "isolation: subagent spawn prompt DOES contain SUBAGENT PROTOCOL" {
    create_test_tasks

    run bash "$SCRIPTS_DIR/orchestrator.sh" spawn T002

    assert_success

    local prompt
    prompt=$(echo "$output" | jq -r '.result.prompt')

    # Should contain subagent protocol
    [[ "$prompt" =~ "SUBAGENT PROTOCOL" ]]
}

@test "isolation: subagent spawn prompt DOES contain MANIFEST requirements" {
    create_test_tasks

    run bash "$SCRIPTS_DIR/orchestrator.sh" spawn T002

    assert_success

    local prompt
    prompt=$(echo "$output" | jq -r '.result.prompt')

    # Should contain manifest writing requirement
    [[ "$prompt" =~ "MANIFEST.jsonl" ]]
}

# =============================================================================
# SKILL (NO ARGS) DISPLAY TESTS
# =============================================================================

@test "skill: no args shows installation instructions (TTY)" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    # Force TTY-like behavior by checking the INSTALL.md directly
    local install_doc="$CLEO_HOME/skills/orchestrator/INSTALL.md"
    [[ -f "$install_doc" ]]

    # The command should succeed
    run bash "$SCRIPTS_DIR/orchestrator.sh" skill

    assert_success
}

@test "skill: no args returns JSON when piped (non-TTY)" {
    [[ -d "$CLEO_HOME/skills/orchestrator" ]] || skip "CLEO orchestrator skill not installed globally"

    # Pipe output to ensure non-TTY detection
    run bash -c "bash '$SCRIPTS_DIR/orchestrator.sh' skill | cat"

    assert_success

    # Should be valid JSON with installInstructions
    local has_instructions
    has_instructions=$(echo "$output" | jq -r 'if .installInstructions then "yes" else "no" end')
    [[ "$has_instructions" == "yes" ]]
}

# =============================================================================
# ERROR HANDLING TESTS
# =============================================================================

@test "skill: --install fails gracefully if source missing" {
    # Temporarily override CLEO_HOME to non-existent path
    export CLEO_HOME="/nonexistent/path"

    run bash "$SCRIPTS_DIR/orchestrator.sh" skill --install

    # Should fail with exit code 4 (NOT_FOUND)
    [[ "$status" -eq 4 ]]

    local error_code
    error_code=$(echo "$output" | jq -r '.error.code')
    [[ "$error_code" == "E_NOT_FOUND" ]]
}
