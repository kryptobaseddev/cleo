#!/usr/bin/env bats
# =============================================================================
# agent-outputs-migration.bats - Tests for agent-outputs directory migration (T2375)
# =============================================================================
# Epic T2348 - Cross-Agent Communication Protocol Unification
#
# Tests validate the migration from research-outputs/ to agent-outputs/:
# 1. Old directory detection - check_agent_outputs_migration_needed() returns correct status
# 2. Backup creation - Migration creates backup before changes
# 3. Atomic rename - Directory renamed correctly
# 4. Manifest path updates - MANIFEST.jsonl entries updated
# 5. Idempotency - Running twice is safe (returns 100 already-done)
# 6. No-op when nothing to migrate - Handles missing old dir gracefully
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    # Source the migration library
    source "${LIB_DIR}/data/migrate.sh"

    # Create project structure for migration tests
    mkdir -p "${TEST_TEMP_DIR}/claudedocs"
    mkdir -p "${TEST_TEMP_DIR}/.cleo"
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

# Create old research-outputs directory with sample MANIFEST.jsonl
_create_old_research_outputs() {
    local project_dir="${1:-$TEST_TEMP_DIR}"
    local old_dir="${project_dir}/claudedocs/research-outputs"

    mkdir -p "$old_dir"

    # Create sample MANIFEST.jsonl with old paths
    cat > "${old_dir}/MANIFEST.jsonl" << 'EOF'
{"id": "research_001", "file": "claudedocs/research-outputs/research_001.md", "title": "Test Research 1", "status": "complete"}
{"id": "research_002", "file": "claudedocs/research-outputs/research_002.md", "title": "Test Research 2", "status": "needs_followup"}
EOF

    # Create sample research files
    echo "# Research 1" > "${old_dir}/research_001.md"
    echo "# Research 2" > "${old_dir}/research_002.md"
}

# Create new agent-outputs directory (already migrated state)
_create_new_agent_outputs() {
    local project_dir="${1:-$TEST_TEMP_DIR}"
    local new_dir="${project_dir}/claudedocs/agent-outputs"

    mkdir -p "$new_dir"

    # Create sample MANIFEST.jsonl with new paths
    cat > "${new_dir}/MANIFEST.jsonl" << 'EOF'
{"id": "research_001", "file": "claudedocs/agent-outputs/research_001.md", "title": "Test Research 1", "status": "complete"}
EOF

    echo "# Research 1" > "${new_dir}/research_001.md"
}

# Create .gitignore with old research-outputs path
_create_gitignore_with_old_path() {
    local project_dir="${1:-$TEST_TEMP_DIR}"

    cat > "${project_dir}/.gitignore" << 'EOF'
# CLEO outputs
claudedocs/research-outputs/
.cleo/
EOF
}

# =============================================================================
# TEST 1: Old directory detection
# =============================================================================

@test "check_agent_outputs_migration_needed: returns 0 when old dir exists, new doesn't" {
    _create_old_research_outputs "$TEST_TEMP_DIR"

    run check_agent_outputs_migration_needed "$TEST_TEMP_DIR"
    assert_success  # Exit 0 = migration needed
}

@test "check_agent_outputs_migration_needed: returns 1 when already migrated (only new dir)" {
    _create_new_agent_outputs "$TEST_TEMP_DIR"

    run check_agent_outputs_migration_needed "$TEST_TEMP_DIR"
    assert_failure  # Exit 1 = no migration needed
}

@test "check_agent_outputs_migration_needed: returns 1 when neither dir exists" {
    # Neither old nor new dir exists
    run check_agent_outputs_migration_needed "$TEST_TEMP_DIR"
    assert_failure  # Exit 1 = no migration needed
}

@test "check_agent_outputs_migration_needed: returns 0 only when old exists and new doesn't" {
    # Both dirs exist - this is a conflict state that requires manual resolution
    _create_old_research_outputs "$TEST_TEMP_DIR"
    _create_new_agent_outputs "$TEST_TEMP_DIR"

    # Both exist - migration check returns false (needs manual resolution, not auto-migration)
    run check_agent_outputs_migration_needed "$TEST_TEMP_DIR"
    assert_failure  # Exit 1 = not eligible for auto-migration
}

# =============================================================================
# TEST 2: Backup creation
# =============================================================================

@test "migration: creates backup before changes" {
    _create_old_research_outputs "$TEST_TEMP_DIR"

    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    # Verify backup directory was created
    local backup_dir="${TEST_TEMP_DIR}/.cleo/backups/migration"
    assert_dir_exists "$backup_dir"

    # Verify backup was created (find any research-outputs backup)
    local backup_count
    backup_count=$(find "$backup_dir" -maxdepth 1 -type d -name "research-outputs_*" 2>/dev/null | wc -l)
    [ "$backup_count" -ge 1 ]
}

@test "migration: backup contains original files" {
    _create_old_research_outputs "$TEST_TEMP_DIR"

    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    # Find the backup directory
    local backup_dir="${TEST_TEMP_DIR}/.cleo/backups/migration"
    local backup_path
    backup_path=$(find "$backup_dir" -maxdepth 1 -type d -name "research-outputs_*" | head -n 1)

    # Verify backup contains original files
    assert_file_exists "${backup_path}/MANIFEST.jsonl"
    assert_file_exists "${backup_path}/research_001.md"
    assert_file_exists "${backup_path}/research_002.md"
}

# =============================================================================
# TEST 3: Atomic rename
# =============================================================================

@test "migration: renames directory from research-outputs to agent-outputs" {
    _create_old_research_outputs "$TEST_TEMP_DIR"

    # Verify old dir exists, new doesn't
    assert_dir_exists "${TEST_TEMP_DIR}/claudedocs/research-outputs"
    assert_dir_not_exists "${TEST_TEMP_DIR}/claudedocs/agent-outputs"

    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    # Verify old dir is gone, new exists
    assert_dir_not_exists "${TEST_TEMP_DIR}/claudedocs/research-outputs"
    assert_dir_exists "${TEST_TEMP_DIR}/claudedocs/agent-outputs"
}

@test "migration: preserves all files after rename" {
    _create_old_research_outputs "$TEST_TEMP_DIR"

    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    local new_dir="${TEST_TEMP_DIR}/claudedocs/agent-outputs"

    # Verify all files exist in new location
    assert_file_exists "${new_dir}/MANIFEST.jsonl"
    assert_file_exists "${new_dir}/research_001.md"
    assert_file_exists "${new_dir}/research_002.md"

    # Verify file contents preserved
    grep -q "# Research 1" "${new_dir}/research_001.md"
    grep -q "# Research 2" "${new_dir}/research_002.md"
}

# =============================================================================
# TEST 4: Manifest path updates
# =============================================================================

@test "migration: updates MANIFEST.jsonl file paths" {
    _create_old_research_outputs "$TEST_TEMP_DIR"

    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    local manifest="${TEST_TEMP_DIR}/claudedocs/agent-outputs/MANIFEST.jsonl"

    # Verify paths were updated from research-outputs to agent-outputs
    run grep "research-outputs" "$manifest"
    assert_failure  # Should NOT contain old paths

    run grep "agent-outputs" "$manifest"
    assert_success  # Should contain new paths

    # Verify specific file paths updated
    run grep "claudedocs/agent-outputs/research_001.md" "$manifest"
    assert_success

    run grep "claudedocs/agent-outputs/research_002.md" "$manifest"
    assert_success
}

@test "migration: preserves other MANIFEST.jsonl fields" {
    _create_old_research_outputs "$TEST_TEMP_DIR"

    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    local manifest="${TEST_TEMP_DIR}/claudedocs/agent-outputs/MANIFEST.jsonl"

    # Verify other fields preserved
    run grep '"id": "research_001"' "$manifest"
    assert_success

    run grep '"title": "Test Research 1"' "$manifest"
    assert_success

    run grep '"status": "complete"' "$manifest"
    assert_success

    run grep '"status": "needs_followup"' "$manifest"
    assert_success
}

@test "migration: handles MANIFEST.jsonl without file paths gracefully" {
    local old_dir="${TEST_TEMP_DIR}/claudedocs/research-outputs"
    mkdir -p "$old_dir"

    # Create MANIFEST.jsonl without file paths
    cat > "${old_dir}/MANIFEST.jsonl" << 'EOF'
{"id": "research_001", "title": "No file path", "status": "complete"}
EOF

    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    # Verify manifest exists and content preserved
    local manifest="${TEST_TEMP_DIR}/claudedocs/agent-outputs/MANIFEST.jsonl"
    assert_file_exists "$manifest"

    run grep '"id": "research_001"' "$manifest"
    assert_success
}

# =============================================================================
# TEST 5: Idempotency
# =============================================================================

@test "migration: returns 100 (already migrated) when run on already-migrated project" {
    _create_new_agent_outputs "$TEST_TEMP_DIR"

    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    [ "$status" -eq 100 ]
}

@test "migration: returns 100 when run twice consecutively" {
    _create_old_research_outputs "$TEST_TEMP_DIR"

    # First run should succeed
    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    # Second run should return 100 (already migrated)
    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    [ "$status" -eq 100 ]
}

@test "migration: second run does not modify files" {
    _create_old_research_outputs "$TEST_TEMP_DIR"

    # First migration
    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    # Get checksum of manifest after first migration
    local manifest="${TEST_TEMP_DIR}/claudedocs/agent-outputs/MANIFEST.jsonl"
    local checksum_before
    checksum_before=$(sha256sum "$manifest" | cut -c1-64)

    # Count backups before second run
    local backup_count_before
    backup_count_before=$(find "${TEST_TEMP_DIR}/.cleo/backups/migration" -maxdepth 1 -type d -name "research-outputs_*" 2>/dev/null | wc -l)

    # Second run
    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    [ "$status" -eq 100 ]

    # Verify manifest unchanged
    local checksum_after
    checksum_after=$(sha256sum "$manifest" | cut -c1-64)
    [ "$checksum_before" = "$checksum_after" ]

    # Verify no new backup created
    local backup_count_after
    backup_count_after=$(find "${TEST_TEMP_DIR}/.cleo/backups/migration" -maxdepth 1 -type d -name "research-outputs_*" 2>/dev/null | wc -l)
    [ "$backup_count_before" -eq "$backup_count_after" ]
}

# =============================================================================
# TEST 6: No-op when nothing to migrate
# =============================================================================

@test "migration: returns 100 when no old directory exists" {
    # Neither directory exists
    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    [ "$status" -eq 100 ]
}

@test "migration: outputs informative message when nothing to migrate" {
    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    [ "$status" -eq 100 ]

    # Should contain an info message
    [[ "$output" == *"No research-outputs directory"* ]] || [[ "$output" == *"Already migrated"* ]]
}

@test "migration: does not create backup when nothing to migrate" {
    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    [ "$status" -eq 100 ]

    # Verify no backup directory created (or empty)
    local backup_dir="${TEST_TEMP_DIR}/.cleo/backups/migration"
    if [ -d "$backup_dir" ]; then
        local backup_count
        backup_count=$(find "$backup_dir" -maxdepth 1 -type d -name "research-outputs_*" 2>/dev/null | wc -l)
        [ "$backup_count" -eq 0 ]
    fi
}

# =============================================================================
# TEST 7: Conflict handling (both directories exist)
# =============================================================================

@test "migration: returns error when both old and new directories exist" {
    _create_old_research_outputs "$TEST_TEMP_DIR"
    _create_new_agent_outputs "$TEST_TEMP_DIR"

    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_failure  # Exit 1 = error

    # Should warn about conflict
    [[ "$output" == *"Both research-outputs"* ]] || [[ "$output" == *"agent-outputs"* ]]
}

@test "migration: does not modify either directory on conflict" {
    _create_old_research_outputs "$TEST_TEMP_DIR"
    _create_new_agent_outputs "$TEST_TEMP_DIR"

    # Get checksums before
    local old_manifest="${TEST_TEMP_DIR}/claudedocs/research-outputs/MANIFEST.jsonl"
    local new_manifest="${TEST_TEMP_DIR}/claudedocs/agent-outputs/MANIFEST.jsonl"
    local old_checksum new_checksum
    old_checksum=$(sha256sum "$old_manifest" | cut -c1-64)
    new_checksum=$(sha256sum "$new_manifest" | cut -c1-64)

    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_failure

    # Verify both directories still exist
    assert_dir_exists "${TEST_TEMP_DIR}/claudedocs/research-outputs"
    assert_dir_exists "${TEST_TEMP_DIR}/claudedocs/agent-outputs"

    # Verify files unchanged
    local old_checksum_after new_checksum_after
    old_checksum_after=$(sha256sum "$old_manifest" | cut -c1-64)
    new_checksum_after=$(sha256sum "$new_manifest" | cut -c1-64)
    [ "$old_checksum" = "$old_checksum_after" ]
    [ "$new_checksum" = "$new_checksum_after" ]
}

# =============================================================================
# TEST 8: .gitignore update
# =============================================================================

@test "migration: updates .gitignore references" {
    _create_old_research_outputs "$TEST_TEMP_DIR"
    _create_gitignore_with_old_path "$TEST_TEMP_DIR"

    # Verify old path in .gitignore
    grep -q "research-outputs" "${TEST_TEMP_DIR}/.gitignore"

    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    # Verify path updated in .gitignore
    run grep "agent-outputs" "${TEST_TEMP_DIR}/.gitignore"
    assert_success

    run grep "research-outputs" "${TEST_TEMP_DIR}/.gitignore"
    assert_failure  # Should NOT contain old path
}

@test "migration: handles missing .gitignore gracefully" {
    _create_old_research_outputs "$TEST_TEMP_DIR"

    # No .gitignore file
    rm -f "${TEST_TEMP_DIR}/.gitignore"

    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    # Migration should complete without error
    assert_dir_exists "${TEST_TEMP_DIR}/claudedocs/agent-outputs"
}

# =============================================================================
# TEST 9: Migration logging
# =============================================================================

@test "migration: logs migration to .migration.log" {
    _create_old_research_outputs "$TEST_TEMP_DIR"

    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    # Verify migration log entry created
    local migration_log="${TEST_TEMP_DIR}/.cleo/.migration.log"
    assert_file_exists "$migration_log"

    run grep "DIRECTORY_MIGRATION" "$migration_log"
    assert_success

    run grep "research-outputs" "$migration_log"
    assert_success

    run grep "agent-outputs" "$migration_log"
    assert_success
}

# =============================================================================
# TEST 10: Edge cases
# =============================================================================

@test "migration: handles empty research-outputs directory" {
    local old_dir="${TEST_TEMP_DIR}/claudedocs/research-outputs"
    mkdir -p "$old_dir"
    # Empty directory, no files

    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    # Verify directory renamed
    assert_dir_not_exists "$old_dir"
    assert_dir_exists "${TEST_TEMP_DIR}/claudedocs/agent-outputs"
}

@test "migration: handles research-outputs without MANIFEST.jsonl" {
    local old_dir="${TEST_TEMP_DIR}/claudedocs/research-outputs"
    mkdir -p "$old_dir"

    # Only create .md files, no manifest
    echo "# Research" > "${old_dir}/research_001.md"

    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    # Verify directory renamed and file preserved
    assert_dir_not_exists "$old_dir"
    assert_file_exists "${TEST_TEMP_DIR}/claudedocs/agent-outputs/research_001.md"
}

@test "migration: uses default project dir when not specified" {
    # Test in current directory context
    cd "$TEST_TEMP_DIR"
    _create_old_research_outputs "."

    run migrate_agent_outputs_dir
    assert_success

    assert_dir_exists "claudedocs/agent-outputs"
    assert_dir_not_exists "claudedocs/research-outputs"
}

# =============================================================================
# Config Migration Tests (T2358 fix)
# =============================================================================

@test "migration: updates config.json from research to agentOutputs" {
    # Create old directory structure
    mkdir -p "$TEST_TEMP_DIR/claudedocs/research-outputs"
    echo '{"id":"test"}' > "$TEST_TEMP_DIR/claudedocs/research-outputs/MANIFEST.jsonl"

    # Create old config with research section
    cat > "$TEST_TEMP_DIR/.cleo/config.json" << 'CONF'
{
  "version": "2.6.0",
  "research": {
    "outputDir": "claudedocs/research-outputs",
    "manifestFile": "MANIFEST.jsonl"
  }
}
CONF

    # Run migration
    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    # Verify config was updated
    run jq -r '.agentOutputs.directory' "$TEST_TEMP_DIR/.cleo/config.json"
    assert_output "claudedocs/agent-outputs"

    # Verify research section was removed
    run jq -r '.research' "$TEST_TEMP_DIR/.cleo/config.json"
    assert_output "null"
}

@test "migration: preserves other config settings when updating" {
    # Create old directory structure
    mkdir -p "$TEST_TEMP_DIR/claudedocs/research-outputs"
    echo '{"id":"test"}' > "$TEST_TEMP_DIR/claudedocs/research-outputs/MANIFEST.jsonl"

    # Create config with research section AND other settings
    cat > "$TEST_TEMP_DIR/.cleo/config.json" << 'CONF'
{
  "version": "2.6.0",
  "research": {
    "outputDir": "claudedocs/research-outputs"
  },
  "validation": {
    "strictMode": true
  },
  "logging": {
    "enabled": true
  }
}
CONF

    # Run migration
    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    # Verify other settings preserved
    run jq -r '.validation.strictMode' "$TEST_TEMP_DIR/.cleo/config.json"
    assert_output "true"

    run jq -r '.logging.enabled' "$TEST_TEMP_DIR/.cleo/config.json"
    assert_output "true"
}

@test "migration: skips config update if no research section" {
    # Create old directory structure
    mkdir -p "$TEST_TEMP_DIR/claudedocs/research-outputs"
    echo '{"id":"test"}' > "$TEST_TEMP_DIR/claudedocs/research-outputs/MANIFEST.jsonl"

    # Create config WITHOUT research section (already using defaults)
    cat > "$TEST_TEMP_DIR/.cleo/config.json" << 'CONF'
{
  "version": "2.6.0",
  "validation": {
    "strictMode": false
  }
}
CONF

    # Run migration - directory migrates but config should NOT be touched
    run migrate_agent_outputs_dir "$TEST_TEMP_DIR"
    assert_success

    # Config should NOT have agentOutputs added (uses defaults, no override needed)
    run jq -r '.agentOutputs' "$TEST_TEMP_DIR/.cleo/config.json"
    assert_output "null"
}
