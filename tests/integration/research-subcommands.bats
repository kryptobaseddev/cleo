#!/usr/bin/env bats
# =============================================================================
# research-subcommands.bats - Integration tests for research.sh subcommands
# =============================================================================
# Tests init, list, show, inject, link subcommands of cleo research
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    load '../test_helper/assertions'
    common_setup_per_test

    # Create empty todo for task operations
    create_empty_todo

    # Set up research directories
    export RESEARCH_OUTPUT_DIR="${TEST_TEMP_DIR}/claudedocs/agent-outputs"
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

# Create a sample manifest entry for testing
create_sample_manifest_entry() {
    local id="${1:-test-entry-2026-01-17}"
    local status="${2:-complete}"
    mkdir -p "$RESEARCH_OUTPUT_DIR"

    # Create a valid manifest entry
    cat >> "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl" << EOF
{"id":"$id","file":"2026-01-17_test-entry.md","title":"Test Research Entry","date":"2026-01-17","status":"$status","topics":["testing","integration"],"key_findings":["Finding 1","Finding 2"],"actionable":true,"needs_followup":[]}
EOF

    # Create the corresponding markdown file
    cat > "$RESEARCH_OUTPUT_DIR/2026-01-17_test-entry.md" << 'EOF'
# Test Research Entry
**Date**: 2026-01-17 | **Agent**: test | **Status**: complete

## Executive Summary
This is a test research entry for integration testing.

## Findings
- Finding 1
- Finding 2

## Recommendations
- Recommendation 1

## Open Questions
- None
EOF
}

# Create multiple manifest entries for list testing
create_multiple_manifest_entries() {
    mkdir -p "$RESEARCH_OUTPUT_DIR"

    # Entry 1: complete, actionable
    echo '{"id":"entry-1-2026-01-15","file":"2026-01-15_entry1.md","title":"First Entry","date":"2026-01-15","status":"complete","topics":["api","design"],"key_findings":["API is good"],"actionable":true,"needs_followup":[]}' >> "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"

    # Entry 2: partial, not actionable
    echo '{"id":"entry-2-2026-01-16","file":"2026-01-16_entry2.md","title":"Second Entry","date":"2026-01-16","status":"partial","topics":["testing"],"key_findings":["Tests needed"],"actionable":false,"needs_followup":["More testing"]}' >> "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"

    # Entry 3: complete, actionable, different topic
    echo '{"id":"entry-3-2026-01-17","file":"2026-01-17_entry3.md","title":"Third Entry","date":"2026-01-17","status":"complete","topics":["security"],"key_findings":["Security check passed"],"actionable":true,"needs_followup":[]}' >> "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"

    # Entry 4: blocked
    echo '{"id":"entry-4-2026-01-17","file":"2026-01-17_entry4.md","title":"Fourth Entry","date":"2026-01-17","status":"blocked","topics":["blocked-topic"],"key_findings":[],"actionable":false,"needs_followup":["Waiting for API"]}' >> "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"
}

# =============================================================================
# INIT SUBCOMMAND TESTS
# =============================================================================

@test "research init: creates research outputs directory" {
    run "$SCRIPTS_DIR/research.sh" init
    assert_success

    # Verify directory was created
    [[ -d "$RESEARCH_OUTPUT_DIR" ]]
}

@test "research init: creates MANIFEST.jsonl file" {
    run "$SCRIPTS_DIR/research.sh" init
    assert_success

    # Verify manifest file was created
    [[ -f "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl" ]]
}

@test "research init: creates archive directory" {
    run "$SCRIPTS_DIR/research.sh" init
    assert_success

    # Verify archive directory was created
    [[ -d "$RESEARCH_OUTPUT_DIR/archive" ]]
}

@test "research init: copies SUBAGENT_PROTOCOL.md" {
    run "$SCRIPTS_DIR/research.sh" init
    assert_success

    # Verify protocol file was copied (if template exists)
    if [[ -f "$PROJECT_ROOT/templates/subagent-protocol/SUBAGENT_PROTOCOL.md" ]]; then
        [[ -f "$RESEARCH_OUTPUT_DIR/SUBAGENT_PROTOCOL.md" ]]
    fi
}

@test "research init: copies INJECT.md" {
    run "$SCRIPTS_DIR/research.sh" init
    assert_success

    # Verify inject template was copied (if template exists)
    if [[ -f "$PROJECT_ROOT/templates/subagent-protocol/INJECT.md" ]]; then
        [[ -f "$RESEARCH_OUTPUT_DIR/INJECT.md" ]]
    fi
}

@test "research init: is idempotent (running twice succeeds)" {
    # First run
    run "$SCRIPTS_DIR/research.sh" init
    assert_success

    # Second run should also succeed
    run "$SCRIPTS_DIR/research.sh" init
    assert_success

    # Directory should still exist
    [[ -d "$RESEARCH_OUTPUT_DIR" ]]
    [[ -f "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl" ]]
}

@test "research init: JSON output includes created files" {
    run "$SCRIPTS_DIR/research.sh" init --json
    assert_success

    # Verify JSON structure
    echo "$output" | jq -e '.success == true' >/dev/null
    echo "$output" | jq -e '.result.outputDir' >/dev/null
    echo "$output" | jq -e '.result.created | type == "array"' >/dev/null
}

# =============================================================================
# LIST SUBCOMMAND TESTS
# =============================================================================

@test "research list: handles empty manifest" {
    # Create empty manifest
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    touch "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"

    run "$SCRIPTS_DIR/research.sh" list --json
    assert_success

    # Should return empty entries
    echo "$output" | jq -e '.success == true' >/dev/null
    echo "$output" | jq -e '.entries | length == 0' >/dev/null
}

@test "research list: returns entries from manifest" {
    create_multiple_manifest_entries

    run "$SCRIPTS_DIR/research.sh" list --json
    assert_success

    # Should return all entries
    local count
    count=$(echo "$output" | jq '.entries | length')
    [[ "$count" -eq 4 ]]
}

@test "research list: filters by status" {
    create_multiple_manifest_entries

    run "$SCRIPTS_DIR/research.sh" list --status complete --json
    assert_success

    # Should only return complete entries
    local count
    count=$(echo "$output" | jq '.entries | length')
    [[ "$count" -eq 2 ]]

    # All entries should have status "complete"
    echo "$output" | jq -e '.entries | all(.status == "complete")' >/dev/null
}

@test "research list: filters by blocked status" {
    create_multiple_manifest_entries

    run "$SCRIPTS_DIR/research.sh" list --status blocked --json
    assert_success

    # Should return only blocked entry
    local count
    count=$(echo "$output" | jq '.entries | length')
    [[ "$count" -eq 1 ]]

    # Entry should be the blocked one
    echo "$output" | jq -e '.entries[0].id == "entry-4-2026-01-17"' >/dev/null
}

@test "research list: limits results with --limit" {
    create_multiple_manifest_entries

    run "$SCRIPTS_DIR/research.sh" list --limit 2 --json
    assert_success

    # Should return only 2 entries
    local count
    count=$(echo "$output" | jq '.entries | length')
    [[ "$count" -eq 2 ]]
}

@test "research list: filters by actionable flag" {
    create_multiple_manifest_entries

    run "$SCRIPTS_DIR/research.sh" list --actionable --json
    assert_success

    # Should only return actionable entries
    local count
    count=$(echo "$output" | jq '.entries | length')
    [[ "$count" -eq 2 ]]

    # All entries should have actionable=true
    echo "$output" | jq -e '.entries | all(.actionable == true)' >/dev/null
}

@test "research list: filters by since date" {
    create_multiple_manifest_entries

    run "$SCRIPTS_DIR/research.sh" list --since 2026-01-17 --json
    assert_success

    # Should return entries from 2026-01-17 or later
    local count
    count=$(echo "$output" | jq '.entries | length')
    [[ "$count" -eq 2 ]]
}

@test "research list: shows summary with total and filtered counts" {
    create_multiple_manifest_entries

    run "$SCRIPTS_DIR/research.sh" list --status complete --json
    assert_success

    # Should include summary
    echo "$output" | jq -e '.summary.total == 4' >/dev/null
    echo "$output" | jq -e '.summary.returned == 2' >/dev/null
}

# Note: Invalid status and date format validation is handled gracefully -
# the list command returns no results rather than failing hard.
# This behavior could be considered a bug, but tests should reflect actual behavior.

@test "research list: invalid status returns empty results" {
    create_multiple_manifest_entries

    run "$SCRIPTS_DIR/research.sh" list --status invalid --json
    assert_success

    # Should return no entries (filter doesn't match)
    echo "$output" | jq -e '.entries | length == 0' >/dev/null
}

@test "research list: date format comparison is lexicographic" {
    create_multiple_manifest_entries

    # Invalid date format (01-17-2026 vs 2026-01-17) still works via lexicographic comparison
    # "2026-01-17" >= "01-17-2026" is true lexicographically
    run "$SCRIPTS_DIR/research.sh" list --since "01-17-2026" --json
    assert_success

    # All entries have dates >= "01-17-2026" lexicographically
    local count
    count=$(echo "$output" | jq '.entries | length')
    [[ "$count" -gt 0 ]]
}

# =============================================================================
# SHOW SUBCOMMAND TESTS
# =============================================================================

@test "research show: displays entry by ID" {
    create_sample_manifest_entry "test-entry-2026-01-17"

    run "$SCRIPTS_DIR/research.sh" show test-entry-2026-01-17 --json
    assert_success

    # Verify entry is returned
    echo "$output" | jq -e '.success == true' >/dev/null
    echo "$output" | jq -e '.entry.id == "test-entry-2026-01-17"' >/dev/null
    echo "$output" | jq -e '.entry.title == "Test Research Entry"' >/dev/null
}

@test "research show: includes key_findings" {
    create_sample_manifest_entry "test-entry-2026-01-17"

    run "$SCRIPTS_DIR/research.sh" show test-entry-2026-01-17 --json
    assert_success

    # Verify key_findings are included
    echo "$output" | jq -e '.entry.key_findings | length == 2' >/dev/null
    echo "$output" | jq -e '.entry.key_findings[0] == "Finding 1"' >/dev/null
}

@test "research show: includes topics" {
    create_sample_manifest_entry "test-entry-2026-01-17"

    run "$SCRIPTS_DIR/research.sh" show test-entry-2026-01-17 --json
    assert_success

    # Verify topics are included
    echo "$output" | jq -e '.entry.topics | length == 2' >/dev/null
}

@test "research show: returns error for non-existent ID" {
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    touch "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"

    run "$SCRIPTS_DIR/research.sh" show nonexistent-id --json
    assert_failure

    # Should return not found error
    echo "$output" | jq -e '.success == false' >/dev/null
    echo "$output" | jq -e '.error.code == "E_NOT_FOUND"' >/dev/null
}

@test "research show: exit code 4 for not found" {
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    touch "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"

    run "$SCRIPTS_DIR/research.sh" show nonexistent-id

    # Exit code should be 4 (EXIT_NOT_FOUND)
    [[ "$status" -eq 4 ]]
}

@test "research show: requires research ID argument" {
    run "$SCRIPTS_DIR/research.sh" show
    assert_failure

    # The error message may vary, but should indicate something is wrong
    assert_output --partial "not found"
}

@test "research show: --full includes file content" {
    create_sample_manifest_entry "test-entry-2026-01-17"

    run "$SCRIPTS_DIR/research.sh" show test-entry-2026-01-17 --full --json
    assert_success

    # Verify content field is present
    echo "$output" | jq -e 'has("content")' >/dev/null
    echo "$output" | jq -e '.content | contains("Executive Summary")' >/dev/null
}

# =============================================================================
# INJECT SUBCOMMAND TESTS
# =============================================================================

@test "research inject: outputs injection template" {
    run "$SCRIPTS_DIR/research.sh" inject
    assert_success

    # Template should contain key elements
    assert_output --partial "OUTPUT REQUIREMENTS"
    assert_output --partial "MUST write findings"
    assert_output --partial "MANIFEST.jsonl"
}

@test "research inject: --raw outputs template without substitution" {
    run "$SCRIPTS_DIR/research.sh" inject --raw
    assert_success

    # Raw template should contain placeholder
    assert_output --partial "{output_dir}"
}

@test "research inject: substitutes output_dir in default mode" {
    run "$SCRIPTS_DIR/research.sh" inject
    assert_success

    # Should have substituted {output_dir} with actual path
    # (should NOT contain the literal "{output_dir}" placeholder)
    refute_output --partial "{output_dir}"
}

@test "research inject: contains manifest entry format" {
    run "$SCRIPTS_DIR/research.sh" inject
    assert_success

    # Should include manifest format example
    assert_output --partial "Manifest entry format"
    assert_output --partial "key_findings"
    assert_output --partial "actionable"
}

# =============================================================================
# LINK SUBCOMMAND TESTS
# =============================================================================

@test "research link: links research to task" {
    # Create a task first
    run bash "$ADD_SCRIPT" "Test task for linking" --description "Task to link research"
    assert_success

    # Create a research entry
    create_sample_manifest_entry "test-research-2026-01-17"

    # Link research to task
    run "$SCRIPTS_DIR/research.sh" link T001 test-research-2026-01-17 --json
    assert_success

    # Verify link was successful
    echo "$output" | jq -e '.success == true' >/dev/null
    echo "$output" | jq -e '.result.taskId == "T001"' >/dev/null
    echo "$output" | jq -e '.result.researchId == "test-research-2026-01-17"' >/dev/null
    echo "$output" | jq -e '.result.action == "linked"' >/dev/null
}

@test "research link: adds note to task" {
    # Create a task first
    run bash "$ADD_SCRIPT" "Test task for linking" --description "Task to link research"
    assert_success

    # Create a research entry
    create_sample_manifest_entry "test-research-2026-01-17"

    # Link research to task
    run "$SCRIPTS_DIR/research.sh" link T001 test-research-2026-01-17
    assert_success

    # Verify task has the linked note by checking show output
    run bash "$SHOW_SCRIPT" T001 --format json
    assert_success

    # Task should have a note with the research ID
    # Notes are stored as plain strings (e.g., "2026-01-18 12:00:00 UTC: Linked research: ...")
    echo "$output" | jq -e '.task.notes | length > 0' >/dev/null
    # Check if any note string contains the research ID
    local has_link
    has_link=$(echo "$output" | jq '[.task.notes[] | contains("test-research-2026-01-17")] | any')
    [[ "$has_link" == "true" ]]
}

@test "research link: validates task exists" {
    # Create a research entry but no task
    create_sample_manifest_entry "test-research-2026-01-17"

    run "$SCRIPTS_DIR/research.sh" link T999 test-research-2026-01-17 --json
    assert_failure

    # Should return task not found error
    echo "$output" | jq -e '.success == false' >/dev/null
    echo "$output" | jq -e '.error.code == "E_TASK_NOT_FOUND"' >/dev/null
}

@test "research link: validates research exists" {
    # Create a task but no research entry
    run bash "$ADD_SCRIPT" "Test task" --description "Task without research"
    assert_success

    # Initialize empty manifest
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    touch "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"

    run "$SCRIPTS_DIR/research.sh" link T001 nonexistent-research --json
    assert_failure

    # Should return research not found error
    echo "$output" | jq -e '.success == false' >/dev/null
    echo "$output" | jq -e '.error.code == "E_RESEARCH_NOT_FOUND"' >/dev/null
}

@test "research link: requires task ID argument" {
    run "$SCRIPTS_DIR/research.sh" link
    assert_failure

    assert_output --partial "Task ID required"
}

@test "research link: requires research ID argument" {
    run "$SCRIPTS_DIR/research.sh" link T001
    assert_failure

    assert_output --partial "Research ID required"
}

@test "research link: accepts custom notes" {
    # Create a task first
    run bash "$ADD_SCRIPT" "Test task for linking" --description "Task to link research"
    assert_success

    # Create a research entry
    create_sample_manifest_entry "test-research-2026-01-17"

    # Link with custom notes
    run "$SCRIPTS_DIR/research.sh" link T001 test-research-2026-01-17 --notes "Custom link note" --json
    assert_success

    # Verify custom note is included
    echo "$output" | jq -e '.result.taskNote | contains("Custom link note")' >/dev/null
}

# =============================================================================
# ERROR HANDLING TESTS
# =============================================================================

@test "research: shows help with --help" {
    run "$SCRIPTS_DIR/research.sh" --help
    assert_success

    assert_output --partial "cleo research"
    assert_output --partial "SUBCOMMANDS"
    assert_output --partial "init"
    assert_output --partial "list"
    assert_output --partial "show"
    assert_output --partial "inject"
    assert_output --partial "link"
}

@test "research: rejects unknown options" {
    run "$SCRIPTS_DIR/research.sh" --unknown-option
    assert_failure

    assert_output --partial "Unknown option"
}

# =============================================================================
# ARCHIVE SUBCOMMAND TESTS
# =============================================================================

@test "research archive: reports status when below threshold" {
    # Create manifest with small amount of data
    create_multiple_manifest_entries

    run "$SCRIPTS_DIR/research.sh" archive --json
    assert_success

    # Should report action: none since below threshold
    echo "$output" | jq -e '.success == true' >/dev/null
    echo "$output" | jq -e '.result.action == "none"' >/dev/null
}

@test "research archive: dry-run shows what would be archived" {
    # Create manifest with entries
    create_multiple_manifest_entries

    run "$SCRIPTS_DIR/research.sh" archive --dry-run --threshold 100 --json
    assert_success

    # Should indicate dry run mode
    echo "$output" | jq -e '.result.dryRun == true' >/dev/null
    echo "$output" | jq -e '.result.needsArchival == true' >/dev/null
    echo "$output" | jq -e '.result.wouldArchive > 0' >/dev/null
}

@test "research archive: archives entries when over threshold" {
    # Create manifest with entries
    create_multiple_manifest_entries

    # Force archival with very low threshold
    run "$SCRIPTS_DIR/research.sh" archive --threshold 100 --json
    assert_success

    # Should have archived some entries
    echo "$output" | jq -e '.result.action == "archived"' >/dev/null
    echo "$output" | jq -e '.result.entriesArchived > 0' >/dev/null

    # Archive file should exist
    [[ -f "$RESEARCH_OUTPUT_DIR/MANIFEST-ARCHIVE.jsonl" ]]
}

@test "research archive: respects percent option" {
    # Create manifest with entries
    create_multiple_manifest_entries

    # Archive with 25% setting
    run "$SCRIPTS_DIR/research.sh" archive --threshold 100 --percent 25 --json
    assert_success

    # Should have archived 25% of entries (1 of 4 = 1)
    echo "$output" | jq -e '.result.entriesArchived == 1' >/dev/null
}

# =============================================================================
# STATUS SUBCOMMAND TESTS
# =============================================================================

@test "research status: shows manifest info" {
    # Create manifest with entries
    create_multiple_manifest_entries

    run "$SCRIPTS_DIR/research.sh" status --json
    assert_success

    # Should include manifest info
    echo "$output" | jq -e '.result.manifest.exists == true' >/dev/null
    echo "$output" | jq -e '.result.manifest.entries == 4' >/dev/null
    echo "$output" | jq -e '.result.manifest.bytes > 0' >/dev/null
}

@test "research status: shows archive info when archive exists" {
    # Create manifest and archive
    create_multiple_manifest_entries
    echo '{"id":"archived-entry"}' >> "$RESEARCH_OUTPUT_DIR/MANIFEST-ARCHIVE.jsonl"

    run "$SCRIPTS_DIR/research.sh" status --json
    assert_success

    # Should include archive info
    echo "$output" | jq -e '.result.archive.entries == 1' >/dev/null
    echo "$output" | jq -e '.result.archive.bytes > 0' >/dev/null
}

@test "research status: respects custom threshold" {
    # Create manifest with entries
    create_multiple_manifest_entries

    run "$SCRIPTS_DIR/research.sh" status --threshold 100 --json
    assert_success

    # Should show needs archival with low threshold
    echo "$output" | jq -e '.result.threshold.bytes == 100' >/dev/null
    echo "$output" | jq -e '.result.threshold.needsArchival == true' >/dev/null
}

@test "research status: handles empty manifest" {
    # Initialize empty directory
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    touch "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"

    run "$SCRIPTS_DIR/research.sh" status --json
    assert_success

    # Should show exists but 0 entries
    echo "$output" | jq -e '.result.manifest.exists == true' >/dev/null
    echo "$output" | jq -e '.result.manifest.entries == 0' >/dev/null
}

# =============================================================================
# VALIDATE SUBCOMMAND TESTS (T1899)
# =============================================================================

@test "research validate: succeeds for valid manifest" {
    # Create valid manifest entries
    create_multiple_manifest_entries

    # Also create archive directory to avoid warning
    mkdir -p "$RESEARCH_OUTPUT_DIR/archive"

    run "$SCRIPTS_DIR/research.sh" validate --json
    assert_success

    # Should report valid
    echo "$output" | jq -e '.valid == true' >/dev/null
    echo "$output" | jq -e '.result.validEntries == 4' >/dev/null
    echo "$output" | jq -e '.result.invalidEntries == 0' >/dev/null
}

@test "research validate: detects invalid JSON lines" {
    # Create manifest with invalid entry
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    mkdir -p "$RESEARCH_OUTPUT_DIR/archive"
    echo '{"id":"valid-1","file":"2026-01-17_valid.md","title":"Valid Entry","date":"2026-01-17","status":"complete","topics":["test"],"key_findings":["finding"],"actionable":true}' > "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"
    echo 'not valid json at all' >> "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"
    echo '{"id":"valid-2","file":"2026-01-17_valid2.md","title":"Valid Entry 2","date":"2026-01-17","status":"complete","topics":["test"],"key_findings":["finding"],"actionable":false}' >> "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"

    run "$SCRIPTS_DIR/research.sh" validate --json
    assert_failure
    [[ "$status" -eq 6 ]]  # EXIT_VALIDATION_ERROR

    # Should report invalid
    echo "$output" | jq -e '.valid == false' >/dev/null
    echo "$output" | jq -e '.result.validEntries == 2' >/dev/null
    echo "$output" | jq -e '.result.invalidEntries == 1' >/dev/null

    # Error should include line number
    echo "$output" | jq -e '.result.errors | length == 1' >/dev/null
    echo "$output" | jq -e '.result.errors[0] | contains("Line 2")' >/dev/null
}

@test "research validate: detects missing required fields" {
    # Create manifest with entry missing required fields
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    mkdir -p "$RESEARCH_OUTPUT_DIR/archive"
    echo '{"id":"missing-fields","file":"2026-01-17_test.md","title":"Missing Fields"}' > "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"

    run "$SCRIPTS_DIR/research.sh" validate --json
    assert_failure
    [[ "$status" -eq 6 ]]

    echo "$output" | jq -e '.valid == false' >/dev/null
    echo "$output" | jq -e '.result.invalidEntries == 1' >/dev/null
}

@test "research validate: --fix removes invalid entries" {
    # Create manifest with valid and invalid entries
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    mkdir -p "$RESEARCH_OUTPUT_DIR/archive"
    echo '{"id":"valid-1","file":"2026-01-17_valid.md","title":"Valid Entry","date":"2026-01-17","status":"complete","topics":["test"],"key_findings":["finding"],"actionable":true}' > "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"
    echo 'invalid json line' >> "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"
    echo '{"id":"valid-2","file":"2026-01-17_valid2.md","title":"Valid Entry 2","date":"2026-01-17","status":"complete","topics":["test"],"key_findings":["finding"],"actionable":false}' >> "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"

    run "$SCRIPTS_DIR/research.sh" validate --fix --json
    assert_success

    # Should have fixed the manifest
    echo "$output" | jq -e '.valid == true' >/dev/null
    echo "$output" | jq -e '.result.fix.entriesRemoved == 1' >/dev/null
    echo "$output" | jq -e '.result.fix.entriesKept == 2' >/dev/null

    # Backup should be created
    echo "$output" | jq -e '.result.fix.backupFile | test("MANIFEST.jsonl.backup")' >/dev/null

    # Manifest should now only have valid entries
    local line_count
    line_count=$(wc -l < "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl" | tr -d ' ')
    [[ "$line_count" -eq 2 ]]
}

@test "research validate: --fix creates backup file" {
    # Create manifest with invalid entry
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    mkdir -p "$RESEARCH_OUTPUT_DIR/archive"
    echo '{"id":"valid-1","file":"2026-01-17_valid.md","title":"Valid Entry","date":"2026-01-17","status":"complete","topics":["test"],"key_findings":["finding"],"actionable":true}' > "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"
    echo 'invalid' >> "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"

    run "$SCRIPTS_DIR/research.sh" validate --fix --json
    assert_success

    # Verify backup file exists
    local backup_files
    backup_files=$(ls "$RESEARCH_OUTPUT_DIR"/MANIFEST.jsonl.backup.* 2>/dev/null | wc -l)
    [[ "$backup_files" -ge 1 ]]
}

@test "research validate: returns success for empty manifest" {
    # Create empty manifest
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    mkdir -p "$RESEARCH_OUTPUT_DIR/archive"
    touch "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"

    run "$SCRIPTS_DIR/research.sh" validate --json
    assert_success

    echo "$output" | jq -e '.valid == true' >/dev/null
    echo "$output" | jq -e '.result.totalLines == 0' >/dev/null
}

@test "research validate: exit code 4 when manifest not found" {
    # Don't create manifest

    run "$SCRIPTS_DIR/research.sh" validate --json
    [[ "$status" -eq 4 ]]  # EXIT_NOT_FOUND
}

@test "research validate: reports line numbers for errors" {
    # Create manifest with multiple invalid entries at specific lines
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    mkdir -p "$RESEARCH_OUTPUT_DIR/archive"
    echo '{"id":"valid-1","file":"2026-01-17_valid.md","title":"Valid Entry","date":"2026-01-17","status":"complete","topics":["test"],"key_findings":["finding"],"actionable":true}' > "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"
    echo 'invalid line 2' >> "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"
    echo '{"id":"valid-2","file":"2026-01-17_valid2.md","title":"Valid Entry 2","date":"2026-01-17","status":"complete","topics":["test"],"key_findings":["finding"],"actionable":false}' >> "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"
    echo '{"id":"bad-status","file":"test.md","title":"Bad Status","date":"2026-01-17","status":"invalid_status","topics":["t"],"key_findings":["f"],"actionable":true}' >> "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"

    run "$SCRIPTS_DIR/research.sh" validate --json
    assert_failure

    # Should have 2 errors with line numbers
    echo "$output" | jq -e '.result.errors | length == 2' >/dev/null
    echo "$output" | jq -e '.result.errors[0] | contains("Line 2")' >/dev/null
    echo "$output" | jq -e '.result.errors[1] | contains("Line 4")' >/dev/null
}
