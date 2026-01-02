#!/usr/bin/env bats
# =============================================================================
# upgrade.bats - Integration tests for cleo upgrade command (T1209)
# =============================================================================
# Tests for the unified upgrade command:
# 1. Fresh project → should report up-to-date
# 2. Legacy top-level phases → should fix
# 3. Outdated CLAUDE.md → should update
# 4. Multiple runs → should be idempotent
# 5. --dry-run → should not modify files
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

    # Export paths for upgrade script
    export UPGRADE_SCRIPT="${SCRIPTS_DIR}/upgrade.sh"
    export INIT_SCRIPT="${SCRIPTS_DIR}/init.sh"
    export CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
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

# Get installed version from CLEO_HOME
_get_installed_version() {
    cat "$CLEO_HOME/VERSION" 2>/dev/null || echo "unknown"
}

# Create todo.json with legacy top-level phases (pre-2.3.0 structure)
_create_legacy_phases_todo() {
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.1.0",
  "project": "test-project",
  "phases": {
    "setup": {"order": 1, "name": "Setup", "status": "active"},
    "core": {"order": 2, "name": "Core", "status": "pending"}
  },
  "checksum": "legacy123",
  "tasks": [
    {"id": "T001", "title": "Test task", "description": "Legacy task", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T10:00:00Z"}
  ],
  "_meta": {"version": "2.1.0"},
  "focus": {},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF
}

# Create fresh todo.json with current schema (should be up-to-date)
_create_current_todo() {
    create_empty_todo
}

# Create CLAUDE.md with outdated version marker
_create_outdated_claude_md() {
    local version="${1:-0.30.0}"
    cat > "./CLAUDE.md" << EOF
<!-- CLEO:START v${version} -->
## Task Management (cleo)
Old content that should be updated.
<!-- CLEO:END -->

# Project Documentation
This is my project.
EOF
}

# Create CLAUDE.md with current version marker
_create_current_claude_md() {
    local version
    version=$(_get_installed_version)
    cat > "./CLAUDE.md" << EOF
<!-- CLEO:START v${version} -->
## Task Management (cleo)
Current content.
<!-- CLEO:END -->

# Project Documentation
This is my project.
EOF
}

# Get file checksum for comparison
_get_file_checksum() {
    local file="$1"
    sha256sum "$file" 2>/dev/null | cut -c1-64
}

# =============================================================================
# TEST 1: Fresh project reports up-to-date
# =============================================================================

@test "upgrade: fresh project reports up-to-date" {
    # Create a fresh project with current schema
    _create_current_todo

    # Run upgrade with force (to avoid interactive prompts)
    run bash "$UPGRADE_SCRIPT" --force

    # Should succeed with exit 0 (up to date)
    [ "$status" -eq 0 ]

    # Output contains multiple JSON lines, get the upgrade command output (last line)
    local upgrade_output
    upgrade_output=$(echo "$output" | tail -n 1)
    echo "$upgrade_output" | jq -e '.success == true' >/dev/null
}

@test "upgrade --status: shows status without error" {
    _create_current_todo

    run bash "$UPGRADE_SCRIPT" --status
    [ "$status" -eq 0 ]

    # Status should output valid JSON (in non-TTY) with success field
    local upgrade_output
    upgrade_output=$(echo "$output" | tail -n 1)
    echo "$upgrade_output" | jq -e '.success == true' >/dev/null

    # Note: upToDate may be false if fixture schema version differs from current
    # The key test is that --status runs without error
}

# =============================================================================
# TEST 2: Legacy top-level phases are fixed
# =============================================================================

@test "upgrade: fixes legacy top-level phases" {
    # Create legacy structure with top-level phases
    _create_legacy_phases_todo

    # Verify legacy structure exists
    jq -e 'has("phases")' "$TODO_FILE" >/dev/null

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force

    # Should succeed
    [ "$status" -eq 0 ]

    # Verify legacy phases removed
    run jq -e 'has("phases")' "$TODO_FILE"
    [ "$status" -ne 0 ]  # Should NOT have top-level phases

    # Verify legacy checksum removed
    run jq -e 'has("checksum")' "$TODO_FILE"
    [ "$status" -ne 0 ]  # Should NOT have top-level checksum
}

@test "upgrade --status: detects legacy top-level phases" {
    _create_legacy_phases_todo

    run bash "$UPGRADE_SCRIPT" --status

    # Should detect updates needed
    [ "$status" -eq 0 ]  # Status check always exits 0

    # Should mention legacy or structural repair needed
    [[ "$output" == *"legacy"* ]] || [[ "$output" == *"update"* ]] || \
        [[ "$output" == *"needs"* ]] || echo "$output" | jq -e '.upToDate == false' >/dev/null
}

# =============================================================================
# TEST 3: Outdated CLAUDE.md is updated
# =============================================================================

@test "upgrade: updates outdated CLAUDE.md injection" {
    _create_current_todo
    _create_outdated_claude_md "0.30.0"

    # Verify outdated version
    grep -q "CLEO:START v0.30.0" "./CLAUDE.md"

    # Run upgrade
    run bash "$UPGRADE_SCRIPT" --force

    # Should succeed
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Verify version updated
    local installed_version
    installed_version=$(_get_installed_version)
    grep -q "CLEO:START v$installed_version" "./CLAUDE.md"
}

@test "upgrade --status: detects outdated CLAUDE.md version" {
    _create_current_todo
    _create_outdated_claude_md "0.25.0"

    run bash "$UPGRADE_SCRIPT" --status
    [ "$status" -eq 0 ]

    # Should detect CLAUDE.md needs update (JSON output in non-TTY)
    echo "$output" | jq -e '.upToDate == false' >/dev/null || \
        [[ "$output" == *"CLAUDE.md"* ]] || \
        [[ "$output" == *"update"* ]]
}

# =============================================================================
# TEST 4: Multiple runs are idempotent
# =============================================================================

@test "upgrade: multiple runs produce same result (idempotent)" {
    # Create fresh project without CLAUDE.md (simpler test case)
    _create_current_todo

    # First run
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ]

    # Get checksum after first run
    local todo_checksum_1
    todo_checksum_1=$(_get_file_checksum "$TODO_FILE")

    # Second run
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ]

    local todo_checksum_2
    todo_checksum_2=$(_get_file_checksum "$TODO_FILE")

    # Third run for good measure
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ]

    local todo_checksum_3
    todo_checksum_3=$(_get_file_checksum "$TODO_FILE")

    # Checksums should be identical between runs (no unnecessary changes)
    [ "$todo_checksum_1" = "$todo_checksum_2" ]
    [ "$todo_checksum_2" = "$todo_checksum_3" ]
}

@test "upgrade: idempotent after fixing legacy structure" {
    _create_legacy_phases_todo

    # First run fixes legacy
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ]

    # Verify legacy phases were removed
    run jq -e 'has("phases")' "$TODO_FILE"
    [ "$status" -ne 0 ]  # Should NOT have top-level phases

    # Second run should be no-op and succeed
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ]

    # Still no top-level phases
    run jq -e 'has("phases")' "$TODO_FILE"
    [ "$status" -ne 0 ]
}

# =============================================================================
# TEST 5: --dry-run does not modify files
# =============================================================================

@test "upgrade --dry-run: does not modify todo.json" {
    _create_legacy_phases_todo

    # Get original checksum
    local original_checksum
    original_checksum=$(_get_file_checksum "$TODO_FILE")

    # Run with dry-run
    run bash "$UPGRADE_SCRIPT" --dry-run
    [ "$status" -eq 0 ]

    # Checksum should be identical
    local after_checksum
    after_checksum=$(_get_file_checksum "$TODO_FILE")

    [ "$original_checksum" = "$after_checksum" ]

    # Legacy structure should still exist
    jq -e 'has("phases")' "$TODO_FILE" >/dev/null
}

@test "upgrade --dry-run: does not modify CLAUDE.md" {
    _create_current_todo
    _create_outdated_claude_md "0.20.0"

    # Get original checksum
    local original_checksum
    original_checksum=$(_get_file_checksum "./CLAUDE.md")

    # Run with dry-run
    run bash "$UPGRADE_SCRIPT" --dry-run
    [ "$status" -eq 0 ]

    # Checksum should be identical
    local after_checksum
    after_checksum=$(_get_file_checksum "./CLAUDE.md")

    [ "$original_checksum" = "$after_checksum" ]

    # Old version should still be present
    grep -q "CLEO:START v0.20.0" "./CLAUDE.md"
}

@test "upgrade --dry-run: shows what would be changed" {
    _create_legacy_phases_todo
    _create_outdated_claude_md "0.15.0"

    run bash "$UPGRADE_SCRIPT" --dry-run
    [ "$status" -eq 0 ]

    # Should list updates that would be applied
    [[ "$output" == *"update"* ]] || [[ "$output" == *"legacy"* ]] || \
        [[ "$output" == *"CLAUDE"* ]] || echo "$output" | jq -e '.updatesNeeded > 0' >/dev/null
}

# =============================================================================
# ADDITIONAL EDGE CASES
# =============================================================================

@test "upgrade: handles project without CLAUDE.md" {
    _create_current_todo
    rm -f "./CLAUDE.md"

    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ]

    # Should not create CLAUDE.md (upgrade doesn't create, only updates)
    [ ! -f "./CLAUDE.md" ]
}

@test "upgrade: creates backup before changes" {
    _create_legacy_phases_todo

    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Should have created backup
    local backup_count
    backup_count=$(find .cleo/backups/upgrade -name "*.json.*" 2>/dev/null | wc -l)
    [ "$backup_count" -gt 0 ]
}

@test "upgrade: exit code 0 for up-to-date" {
    _create_current_todo

    run bash "$UPGRADE_SCRIPT"
    [ "$status" -eq 0 ]
}

@test "upgrade: handles checksum mismatch" {
    # Create todo with incorrect checksum
    cat > "$TODO_FILE" << 'EOF'
{
  "version": "2.3.0",
  "project": {"name": "test", "currentPhase": "setup"},
  "_meta": {"version": "2.3.0", "checksum": "incorrect123"},
  "tasks": [
    {"id": "T001", "title": "Test", "description": "Desc", "status": "pending", "priority": "medium", "createdAt": "2025-12-01T10:00:00Z"}
  ],
  "focus": {},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF

    # Run upgrade to fix checksum
    run bash "$UPGRADE_SCRIPT" --force
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]

    # Checksum should now be correct
    local stored_checksum computed_checksum
    stored_checksum=$(jq -r '._meta.checksum' "$TODO_FILE")
    computed_checksum=$(jq -c '.tasks' "$TODO_FILE" | sha256sum | cut -c1-16)

    [ "$stored_checksum" = "$computed_checksum" ]
}
