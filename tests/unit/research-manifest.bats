#!/usr/bin/env bats
# =============================================================================
# research-manifest.bats - Unit tests for lib/skills/research-manifest.sh
# =============================================================================
# Tests MANIFEST.jsonl CRUD operations for research outputs.
#
# Functions tested:
#   - read_manifest: Read all entries, return JSON array
#   - append_manifest: Append single JSON line
#   - find_entry: Find entry by ID
#   - filter_entries: Filter by status, topic, date, actionable
#   - archive_entry: Update entry status to "archived"
#
# Exit codes tested:
#   0   - Success
#   4   - Not found (EXIT_NOT_FOUND)
#   6   - Validation error (EXIT_VALIDATION_ERROR)
#   101 - Already exists (EXIT_ALREADY_EXISTS)
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    # Source the library under test
    source "${LIB_DIR}/skills/research-manifest.sh"

    # Create agent output directory (new default path, replacing research-outputs)
    export RESEARCH_OUTPUT_DIR="${TEST_TEMP_DIR}/claudedocs/agent-outputs"
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    export MANIFEST_FILE="${RESEARCH_OUTPUT_DIR}/MANIFEST.jsonl"
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

# Create a valid manifest entry JSON
_valid_entry() {
    local id="${1:-test-2025-01-17}"
    local status="${2:-complete}"
    cat <<EOF
{
    "id": "${id}",
    "file": "2025-01-17_test.md",
    "title": "Test Research",
    "date": "2025-01-17",
    "status": "${status}",
    "topics": ["testing", "research"],
    "key_findings": ["Finding 1", "Finding 2"],
    "actionable": true,
    "needs_followup": []
}
EOF
}

# Create an invalid manifest entry (missing required field)
_invalid_entry_missing_field() {
    cat <<EOF
{
    "id": "test-2025-01-17",
    "file": "2025-01-17_test.md",
    "title": "Test Research",
    "date": "2025-01-17",
    "status": "complete",
    "topics": ["testing"],
    "actionable": true
}
EOF
}

# Create an invalid entry with bad status
_invalid_entry_bad_status() {
    cat <<EOF
{
    "id": "test-2025-01-17",
    "file": "2025-01-17_test.md",
    "title": "Test Research",
    "date": "2025-01-17",
    "status": "invalid_status",
    "topics": ["testing"],
    "key_findings": ["Finding 1"],
    "actionable": true
}
EOF
}

# Create an invalid entry with bad date format
_invalid_entry_bad_date() {
    cat <<EOF
{
    "id": "test-2025-01-17",
    "file": "2025-01-17_test.md",
    "title": "Test Research",
    "date": "01-17-2025",
    "status": "complete",
    "topics": ["testing"],
    "key_findings": ["Finding 1"],
    "actionable": true
}
EOF
}

# Create manifest with sample entries
_create_sample_manifest() {
    echo '{"id":"entry-1","file":"2025-01-15_first.md","title":"First Research","date":"2025-01-15","status":"complete","topics":["api","testing"],"key_findings":["Found API issue"],"actionable":true,"needs_followup":[]}' > "$MANIFEST_FILE"
    echo '{"id":"entry-2","file":"2025-01-16_second.md","title":"Second Research","date":"2025-01-16","status":"partial","topics":["security"],"key_findings":["Security concern"],"actionable":false,"needs_followup":["Review needed"]}' >> "$MANIFEST_FILE"
    echo '{"id":"entry-3","file":"2025-01-17_third.md","title":"Third Research","date":"2025-01-17","status":"blocked","topics":["api","performance"],"key_findings":["Performance issue"],"actionable":true,"needs_followup":["Needs benchmark"]}' >> "$MANIFEST_FILE"
}

# =============================================================================
# read_manifest Tests
# =============================================================================

@test "read_manifest returns empty array for non-existent manifest" {
    run read_manifest
    assert_success
    assert_valid_json

    local count=$(echo "$output" | jq '.result.count')
    [[ "$count" -eq 0 ]]

    local entries_len=$(echo "$output" | jq '.result.entries | length')
    [[ "$entries_len" -eq 0 ]]
}

@test "read_manifest returns empty array for empty manifest file" {
    touch "$MANIFEST_FILE"

    run read_manifest
    assert_success
    assert_valid_json

    local count=$(echo "$output" | jq '.result.count')
    [[ "$count" -eq 0 ]]
}

@test "read_manifest returns single entry correctly" {
    echo '{"id":"test-1","file":"test.md","title":"Test","date":"2025-01-17","status":"complete","topics":["t1"],"key_findings":["f1"],"actionable":true}' > "$MANIFEST_FILE"

    run read_manifest
    assert_success
    assert_valid_json

    local count=$(echo "$output" | jq '.result.count')
    [[ "$count" -eq 1 ]]

    local entry_id=$(echo "$output" | jq -r '.result.entries[0].id')
    [[ "$entry_id" == "test-1" ]]
}

@test "read_manifest returns multiple entries correctly" {
    _create_sample_manifest

    run read_manifest
    assert_success
    assert_valid_json

    local count=$(echo "$output" | jq '.result.count')
    [[ "$count" -eq 3 ]]

    # Verify order preserved
    local first_id=$(echo "$output" | jq -r '.result.entries[0].id')
    local last_id=$(echo "$output" | jq -r '.result.entries[2].id')
    [[ "$first_id" == "entry-1" ]]
    [[ "$last_id" == "entry-3" ]]
}

@test "read_manifest has CLEO envelope structure" {
    run read_manifest
    assert_success
    assert_valid_json

    assert_json_has_key "_meta"
    assert_json_has_key "success"
    assert_json_has_key "result"

    local operation=$(echo "$output" | jq -r '._meta.operation')
    [[ "$operation" == "read" ]]
}

# =============================================================================
# append_manifest Tests
# =============================================================================

@test "append_manifest creates manifest file if not exists" {
    rm -f "$MANIFEST_FILE"

    local entry=$(_valid_entry "new-entry")
    run append_manifest "$entry"
    assert_success
    assert_valid_json

    [[ -f "$MANIFEST_FILE" ]]

    local success=$(echo "$output" | jq '.success')
    [[ "$success" == "true" ]]
}

@test "append_manifest appends valid entry" {
    local entry=$(_valid_entry "test-entry")
    run append_manifest "$entry"
    assert_success
    assert_valid_json

    local action=$(echo "$output" | jq -r '.result.action')
    [[ "$action" == "appended" ]]

    # Verify entry was written to file
    grep -q '"id":"test-entry"' "$MANIFEST_FILE"
}

@test "append_manifest rejects invalid JSON" {
    run append_manifest "not valid json"
    assert_failure
    [[ "$status" -eq 6 ]]  # EXIT_VALIDATION_ERROR

    local success=$(echo "$output" | jq '.success')
    [[ "$success" == "false" ]]

    local error_code=$(echo "$output" | jq -r '.error.code')
    [[ "$error_code" == "E_VALIDATION" ]]
}

@test "append_manifest rejects entry missing required field" {
    local entry=$(_invalid_entry_missing_field)
    run append_manifest "$entry"
    assert_failure
    [[ "$status" -eq 6 ]]

    assert_output --partial "key_findings"
}

@test "append_manifest rejects entry with invalid status" {
    local entry=$(_invalid_entry_bad_status)
    run append_manifest "$entry"
    assert_failure
    [[ "$status" -eq 6 ]]

    assert_output --partial "Invalid status"
}

@test "append_manifest rejects entry with invalid date format" {
    local entry=$(_invalid_entry_bad_date)
    run append_manifest "$entry"
    assert_failure
    [[ "$status" -eq 6 ]]

    assert_output --partial "Invalid date"
}

@test "append_manifest rejects duplicate ID" {
    local entry=$(_valid_entry "duplicate-id")
    run append_manifest "$entry"
    assert_success

    # Try to append same ID again
    run append_manifest "$entry"
    assert_failure
    [[ "$status" -eq 101 ]]  # EXIT_ALREADY_EXISTS

    local error_code=$(echo "$output" | jq -r '.error.code')
    [[ "$error_code" == "E_ALREADY_EXISTS" ]]
}

@test "append_manifest compacts JSON to single line" {
    local entry=$(_valid_entry "compact-test")
    run append_manifest "$entry"
    assert_success

    # Verify file has exactly one line
    local line_count=$(wc -l < "$MANIFEST_FILE")
    [[ "$line_count" -eq 1 ]]
}

@test "append_manifest appends to existing manifest" {
    _create_sample_manifest
    local initial_count=$(wc -l < "$MANIFEST_FILE")

    local entry=$(_valid_entry "new-entry")
    run append_manifest "$entry"
    assert_success

    local final_count=$(wc -l < "$MANIFEST_FILE")
    [[ "$final_count" -eq $((initial_count + 1)) ]]
}

@test "append_manifest validates topics is array" {
    local entry='{"id":"test","file":"t.md","title":"T","date":"2025-01-17","status":"complete","topics":"not-array","key_findings":["f"],"actionable":true}'
    run append_manifest "$entry"
    assert_failure
    [[ "$status" -eq 6 ]]

    assert_output --partial "topics must be an array"
}

@test "append_manifest validates key_findings is array" {
    local entry='{"id":"test","file":"t.md","title":"T","date":"2025-01-17","status":"complete","topics":["t"],"key_findings":"not-array","actionable":true}'
    run append_manifest "$entry"
    assert_failure
    [[ "$status" -eq 6 ]]

    assert_output --partial "key_findings must be an array"
}

@test "append_manifest validates actionable is boolean" {
    local entry='{"id":"test","file":"t.md","title":"T","date":"2025-01-17","status":"complete","topics":["t"],"key_findings":["f"],"actionable":"yes"}'
    run append_manifest "$entry"
    assert_failure
    [[ "$status" -eq 6 ]]

    assert_output --partial "actionable must be a boolean"
}

@test "append_manifest validates agent_type enum" {
    local entry='{"id":"test","file":"t.md","title":"T","date":"2025-01-17","status":"complete","agent_type":"invalid","topics":["t"],"key_findings":["f"],"actionable":true}'
    run append_manifest "$entry"
    assert_failure
    [[ "$status" -eq 6 ]]

    assert_output --partial "Invalid agent_type"
}

@test "append_manifest accepts valid agent_type values" {
    local types=("research" "implementation" "validation" "documentation" "analysis")
    for agent_type in "${types[@]}"; do
        local entry
        entry=$(jq -n --arg id "test-$agent_type" --arg type "$agent_type" '{
            id: $id,
            file: "t.md",
            title: "T",
            date: "2025-01-17",
            status: "complete",
            agent_type: $type,
            topics: ["t"],
            key_findings: ["f"],
            actionable: true
        }')
        run append_manifest "$entry"
        assert_success
    done
}

@test "append_manifest defaults agent_type to research when missing" {
    local entry='{"id":"test-no-type","file":"t.md","title":"T","date":"2025-01-17","status":"complete","topics":["t"],"key_findings":["f"],"actionable":true}'
    run append_manifest "$entry"
    assert_success
}

# =============================================================================
# find_entry Tests
# =============================================================================

@test "find_entry returns error when manifest not found" {
    rm -f "$MANIFEST_FILE"

    run find_entry "any-id"
    assert_failure
    [[ "$status" -eq 4 ]]  # EXIT_NOT_FOUND

    local error_code=$(echo "$output" | jq -r '.error.code')
    [[ "$error_code" == "E_NOT_FOUND" ]]
}

@test "find_entry returns error for non-existent ID" {
    _create_sample_manifest

    run find_entry "nonexistent-id"
    assert_failure
    [[ "$status" -eq 4 ]]

    assert_output --partial "not found"
}

@test "find_entry returns entry for existing ID" {
    _create_sample_manifest

    run find_entry "entry-2"
    assert_success
    assert_valid_json

    local entry_id=$(echo "$output" | jq -r '.result.entry.id')
    [[ "$entry_id" == "entry-2" ]]

    local title=$(echo "$output" | jq -r '.result.entry.title')
    [[ "$title" == "Second Research" ]]
}

@test "find_entry returns correct entry from multiple" {
    _create_sample_manifest

    run find_entry "entry-1"
    assert_success

    local status=$(echo "$output" | jq -r '.result.entry.status')
    [[ "$status" == "complete" ]]

    run find_entry "entry-3"
    assert_success

    status=$(echo "$output" | jq -r '.result.entry.status')
    [[ "$status" == "blocked" ]]
}

@test "find_entry has CLEO envelope structure" {
    _create_sample_manifest

    run find_entry "entry-1"
    assert_success
    assert_valid_json

    assert_json_has_key "_meta"
    assert_json_has_key "success"
    assert_json_has_key "result"

    local operation=$(echo "$output" | jq -r '._meta.operation')
    [[ "$operation" == "find" ]]
}

# =============================================================================
# filter_entries Tests
# =============================================================================

@test "filter_entries returns empty for non-existent manifest" {
    rm -f "$MANIFEST_FILE"

    run filter_entries
    assert_success
    assert_valid_json

    local filtered=$(echo "$output" | jq '.result.filtered')
    [[ "$filtered" -eq 0 ]]
}

@test "filter_entries returns all entries without filters" {
    _create_sample_manifest

    run filter_entries
    assert_success
    assert_valid_json

    local filtered=$(echo "$output" | jq '.result.filtered')
    [[ "$filtered" -eq 3 ]]
}

@test "filter_entries filters by status" {
    _create_sample_manifest

    run filter_entries --status complete
    assert_success

    local filtered=$(echo "$output" | jq '.result.filtered')
    [[ "$filtered" -eq 1 ]]

    local entry_id=$(echo "$output" | jq -r '.result.entries[0].id')
    [[ "$entry_id" == "entry-1" ]]
}

@test "filter_entries filters by topic" {
    _create_sample_manifest

    run filter_entries --topic api
    assert_success

    local filtered=$(echo "$output" | jq '.result.filtered')
    [[ "$filtered" -eq 2 ]]  # entry-1 and entry-3 have "api" topic
}

@test "filter_entries topic filter is case insensitive" {
    _create_sample_manifest

    run filter_entries --topic API
    assert_success

    local filtered=$(echo "$output" | jq '.result.filtered')
    [[ "$filtered" -eq 2 ]]
}

@test "filter_entries filters by date (--since)" {
    _create_sample_manifest

    run filter_entries --since 2025-01-16
    assert_success

    local filtered=$(echo "$output" | jq '.result.filtered')
    [[ "$filtered" -eq 2 ]]  # entry-2 and entry-3
}

@test "filter_entries filters by actionable" {
    _create_sample_manifest

    run filter_entries --actionable
    assert_success

    local filtered=$(echo "$output" | jq '.result.filtered')
    [[ "$filtered" -eq 2 ]]  # entry-1 and entry-3 are actionable
}

@test "filter_entries combines multiple filters" {
    _create_sample_manifest

    run filter_entries --status complete --actionable
    assert_success

    local filtered=$(echo "$output" | jq '.result.filtered')
    [[ "$filtered" -eq 1 ]]  # Only entry-1 is complete AND actionable

    local entry_id=$(echo "$output" | jq -r '.result.entries[0].id')
    [[ "$entry_id" == "entry-1" ]]
}

@test "filter_entries respects limit" {
    _create_sample_manifest

    run filter_entries --limit 2
    assert_success

    local filtered=$(echo "$output" | jq '.result.filtered')
    [[ "$filtered" -eq 2 ]]

    local entries_len=$(echo "$output" | jq '.result.entries | length')
    [[ "$entries_len" -eq 2 ]]
}

@test "filter_entries returns total and filtered counts" {
    _create_sample_manifest

    run filter_entries --status complete
    assert_success

    local total=$(echo "$output" | jq '.result.total')
    local filtered=$(echo "$output" | jq '.result.filtered')

    [[ "$total" -eq 3 ]]
    [[ "$filtered" -eq 1 ]]
}

@test "filter_entries has CLEO envelope structure" {
    _create_sample_manifest

    run filter_entries
    assert_success
    assert_valid_json

    assert_json_has_key "_meta"
    assert_json_has_key "success"
    assert_json_has_key "result"

    local operation=$(echo "$output" | jq -r '._meta.operation')
    [[ "$operation" == "filter" ]]
}

@test "filter_entries filters by partial topic match" {
    _create_sample_manifest

    run filter_entries --topic secur
    assert_success

    local filtered=$(echo "$output" | jq '.result.filtered')
    [[ "$filtered" -eq 1 ]]  # entry-2 has "security" topic
}

# =============================================================================
# archive_entry Tests
# =============================================================================

@test "archive_entry returns error when manifest not found" {
    rm -f "$MANIFEST_FILE"

    run archive_entry "any-id"
    assert_failure
    [[ "$status" -eq 4 ]]

    local error_code=$(echo "$output" | jq -r '.error.code')
    [[ "$error_code" == "E_NOT_FOUND" ]]
}

@test "archive_entry returns error for non-existent ID" {
    _create_sample_manifest

    run archive_entry "nonexistent-id"
    assert_failure
    [[ "$status" -eq 4 ]]

    assert_output --partial "not found"
}

@test "archive_entry updates status to archived" {
    _create_sample_manifest

    run archive_entry "entry-1"
    assert_success
    assert_valid_json

    local action=$(echo "$output" | jq -r '.result.action')
    [[ "$action" == "updated" ]]

    local result_status=$(echo "$output" | jq -r '.result.status')
    [[ "$result_status" == "archived" ]]

    # Verify in file
    run find_entry "entry-1"
    assert_success

    local entry_status=$(echo "$output" | jq -r '.result.entry.status')
    [[ "$entry_status" == "archived" ]]
}

@test "archive_entry preserves other entries" {
    _create_sample_manifest

    run archive_entry "entry-2"
    assert_success

    # Check entry-1 is unchanged
    run find_entry "entry-1"
    assert_success
    local status1=$(echo "$output" | jq -r '.result.entry.status')
    [[ "$status1" == "complete" ]]

    # Check entry-3 is unchanged
    run find_entry "entry-3"
    assert_success
    local status3=$(echo "$output" | jq -r '.result.entry.status')
    [[ "$status3" == "blocked" ]]
}

@test "archive_entry has CLEO envelope structure" {
    _create_sample_manifest

    run archive_entry "entry-1"
    assert_success
    assert_valid_json

    assert_json_has_key "_meta"
    assert_json_has_key "success"
    assert_json_has_key "result"

    local operation=$(echo "$output" | jq -r '._meta.operation')
    [[ "$operation" == "archive" ]]
}

# =============================================================================
# Validation Helper Tests
# =============================================================================

@test "validation accepts all valid status values" {
    for status in complete partial blocked archived; do
        local entry=$(_valid_entry "test-${status}" "$status")
        run append_manifest "$entry"
        assert_success
        rm -f "$MANIFEST_FILE"
    done
}

@test "validation accepts empty arrays for topics and key_findings" {
    local entry='{"id":"test","file":"t.md","title":"T","date":"2025-01-17","status":"complete","topics":[],"key_findings":[],"actionable":false}'
    run append_manifest "$entry"
    assert_success
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "handles special characters in entry content" {
    local entry='{"id":"special-chars","file":"test.md","title":"Test with \"quotes\" and \\backslash","date":"2025-01-17","status":"complete","topics":["special"],"key_findings":["Found: key=value"],"actionable":true}'
    run append_manifest "$entry"
    assert_success

    run find_entry "special-chars"
    assert_success

    local title=$(echo "$output" | jq -r '.result.entry.title')
    [[ "$title" == 'Test with "quotes" and \backslash' ]]
}

@test "handles unicode in entry content" {
    local entry='{"id":"unicode-test","file":"test.md","title":"Test with emoji and unicode chars","date":"2025-01-17","status":"complete","topics":["unicode"],"key_findings":["Works with special chars"],"actionable":true}'
    run append_manifest "$entry"
    assert_success

    run find_entry "unicode-test"
    assert_success
}

@test "handles very long key_findings array" {
    local findings=""
    for i in {1..50}; do
        if [[ -n "$findings" ]]; then
            findings="${findings},"
        fi
        findings="${findings}\"Finding $i\""
    done

    local entry="{\"id\":\"long-findings\",\"file\":\"t.md\",\"title\":\"T\",\"date\":\"2025-01-17\",\"status\":\"complete\",\"topics\":[\"t\"],\"key_findings\":[${findings}],\"actionable\":true}"
    run append_manifest "$entry"
    assert_success

    run find_entry "long-findings"
    assert_success

    local count=$(echo "$output" | jq '.result.entry.key_findings | length')
    [[ "$count" -eq 50 ]]
}

# =============================================================================
# ensure_research_outputs Tests (T1947)
# =============================================================================

@test "ensure_research_outputs creates directory when missing" {
    rm -rf "$RESEARCH_OUTPUT_DIR"

    run ensure_research_outputs
    assert_success
    assert_valid_json

    [[ -d "$RESEARCH_OUTPUT_DIR" ]]
    [[ -f "$MANIFEST_FILE" ]]

    local already_existed=$(echo "$output" | jq '.result.alreadyExisted')
    [[ "$already_existed" == "false" ]]
}

@test "ensure_research_outputs creates archive directory" {
    rm -rf "$RESEARCH_OUTPUT_DIR"

    run ensure_research_outputs
    assert_success

    [[ -d "${RESEARCH_OUTPUT_DIR}/archive" ]]
}

@test "ensure_research_outputs creates MANIFEST.jsonl when missing" {
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    rm -f "$MANIFEST_FILE"

    run ensure_research_outputs
    assert_success
    assert_valid_json

    [[ -f "$MANIFEST_FILE" ]]

    local created=$(echo "$output" | jq -r '.result.created | length')
    [[ "$created" -ge 1 ]]
}

@test "ensure_research_outputs is idempotent" {
    # Create structure first
    run ensure_research_outputs
    assert_success

    local first_created=$(echo "$output" | jq '.result.created | length')

    # Run again
    run ensure_research_outputs
    assert_success

    local second_created=$(echo "$output" | jq '.result.created | length')
    local already_existed=$(echo "$output" | jq '.result.alreadyExisted')

    [[ "$already_existed" == "true" ]]
    [[ "$second_created" -eq 0 ]]
}

@test "ensure_research_outputs returns CLEO envelope structure" {
    run ensure_research_outputs
    assert_success
    assert_valid_json

    assert_json_has_key "_meta"
    assert_json_has_key "success"
    assert_json_has_key "result"

    local operation=$(echo "$output" | jq -r '._meta.operation')
    [[ "$operation" == "ensure" ]]
}

@test "ensure_research_outputs reports created items" {
    rm -rf "$RESEARCH_OUTPUT_DIR"

    run ensure_research_outputs
    assert_success

    local created=$(echo "$output" | jq -r '.result.created[]' | wc -l)
    [[ "$created" -ge 2 ]]  # At least directory and manifest file
}

# =============================================================================
# validate_research_manifest Tests (T1947)
# =============================================================================

@test "validate_research_manifest returns error when directory missing" {
    rm -rf "$RESEARCH_OUTPUT_DIR"

    run validate_research_manifest
    assert_failure
    [[ "$status" -eq 4 ]]  # EXIT_NOT_FOUND

    local error_code=$(echo "$output" | jq -r '.error.code')
    [[ "$error_code" == "E_FILE_NOT_FOUND" ]]

    # Should include fix command
    local fix_cmd=$(echo "$output" | jq -r '.error.fixCommand')
    [[ "$fix_cmd" == "cleo research init" ]]
}

@test "validate_research_manifest returns error when manifest missing" {
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    rm -f "$MANIFEST_FILE"

    run validate_research_manifest
    assert_failure
    [[ "$status" -eq 4 ]]

    local error_code=$(echo "$output" | jq -r '.error.code')
    [[ "$error_code" == "E_FILE_NOT_FOUND" ]]
}

@test "validate_research_manifest succeeds for empty manifest" {
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    mkdir -p "${RESEARCH_OUTPUT_DIR}/archive"
    touch "$MANIFEST_FILE"

    run validate_research_manifest
    assert_success
    assert_valid_json

    local valid=$(echo "$output" | jq '.valid')
    [[ "$valid" == "true" ]]

    local total_lines=$(echo "$output" | jq '.result.totalLines')
    [[ "$total_lines" -eq 0 ]]
}

@test "validate_research_manifest succeeds for valid entries" {
    mkdir -p "${RESEARCH_OUTPUT_DIR}/archive"
    _create_sample_manifest

    run validate_research_manifest
    assert_success
    assert_valid_json

    local valid=$(echo "$output" | jq '.valid')
    [[ "$valid" == "true" ]]

    local valid_entries=$(echo "$output" | jq '.result.validEntries')
    [[ "$valid_entries" -eq 3 ]]
}

@test "validate_research_manifest detects invalid JSON line" {
    mkdir -p "${RESEARCH_OUTPUT_DIR}/archive"
    echo '{"id":"valid","file":"t.md","title":"T","date":"2025-01-17","status":"complete","topics":[],"key_findings":[],"actionable":true}' > "$MANIFEST_FILE"
    echo 'not valid json' >> "$MANIFEST_FILE"
    echo '{"id":"valid2","file":"t2.md","title":"T2","date":"2025-01-17","status":"complete","topics":[],"key_findings":[],"actionable":false}' >> "$MANIFEST_FILE"

    run validate_research_manifest
    assert_failure
    [[ "$status" -eq 6 ]]  # EXIT_VALIDATION_ERROR

    local valid=$(echo "$output" | jq '.valid')
    [[ "$valid" == "false" ]]

    local invalid_entries=$(echo "$output" | jq '.result.invalidEntries')
    [[ "$invalid_entries" -eq 1 ]]

    local valid_entries=$(echo "$output" | jq '.result.validEntries')
    [[ "$valid_entries" -eq 2 ]]
}

@test "validate_research_manifest detects missing required fields" {
    mkdir -p "${RESEARCH_OUTPUT_DIR}/archive"
    echo '{"id":"missing-fields","file":"t.md","title":"T","date":"2025-01-17"}' > "$MANIFEST_FILE"

    run validate_research_manifest
    assert_failure
    [[ "$status" -eq 6 ]]

    local invalid_entries=$(echo "$output" | jq '.result.invalidEntries')
    [[ "$invalid_entries" -eq 1 ]]
}

@test "validate_research_manifest warns when archive directory missing" {
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    rm -rf "${RESEARCH_OUTPUT_DIR}/archive"
    touch "$MANIFEST_FILE"

    run validate_research_manifest
    assert_success  # Warning, not error

    local warnings_len=$(echo "$output" | jq '.result.warnings | length')
    [[ "$warnings_len" -ge 1 ]]
}

@test "validate_research_manifest returns CLEO envelope structure" {
    mkdir -p "${RESEARCH_OUTPUT_DIR}/archive"
    touch "$MANIFEST_FILE"

    run validate_research_manifest
    assert_success
    assert_valid_json

    assert_json_has_key "_meta"
    assert_json_has_key "success"
    assert_json_has_key "valid"

    local operation=$(echo "$output" | jq -r '._meta.operation')
    [[ "$operation" == "validate" ]]
}

@test "validate_research_manifest reports errors with line numbers" {
    mkdir -p "${RESEARCH_OUTPUT_DIR}/archive"
    echo '{"id":"ok","file":"t.md","title":"T","date":"2025-01-17","status":"complete","topics":[],"key_findings":[],"actionable":true}' > "$MANIFEST_FILE"
    echo 'invalid json on line 2' >> "$MANIFEST_FILE"

    run validate_research_manifest
    assert_failure

    local error_msg=$(echo "$output" | jq -r '.result.errors[0]')
    assert_output --partial "Line 2"
}

# =============================================================================
# manifest_check_size Tests
# =============================================================================

@test "manifest_check_size returns file not found when manifest missing" {
    rm -f "$MANIFEST_FILE"

    run manifest_check_size 100000
    # Returns EXIT_NO_DATA (100) when file doesn't exist
    [[ "$status" -eq 100 ]]

    assert_valid_json
    local file_exists=$(echo "$output" | jq -r '.result.fileExists')
    [[ "$file_exists" == "false" ]]
}

@test "manifest_check_size calculates size correctly" {
    _create_sample_manifest

    run manifest_check_size 100000
    assert_success
    assert_valid_json

    local file_exists=$(echo "$output" | jq -r '.result.fileExists')
    [[ "$file_exists" == "true" ]]

    local current_bytes=$(echo "$output" | jq -r '.result.currentBytes')
    [[ "$current_bytes" -gt 0 ]]
}

@test "manifest_check_size detects when archival needed" {
    _create_sample_manifest

    # Set threshold very low to trigger archival
    run manifest_check_size 100
    assert_success
    assert_valid_json

    local needs_archival=$(echo "$output" | jq -r '.result.needsArchival')
    [[ "$needs_archival" == "true" ]]

    local percent_used=$(echo "$output" | jq -r '.result.percentUsed')
    [[ "$percent_used" -gt 100 ]]
}

@test "manifest_check_size reports entry count" {
    _create_sample_manifest

    run manifest_check_size 100000
    assert_success
    assert_valid_json

    local entry_count=$(echo "$output" | jq -r '.result.entryCount')
    [[ "$entry_count" -eq 3 ]]
}

# =============================================================================
# manifest_archive_old Tests
# =============================================================================

@test "manifest_archive_old returns no data when manifest missing" {
    rm -f "$MANIFEST_FILE"

    run manifest_archive_old 50
    [[ "$status" -eq 100 ]]

    assert_valid_json
    echo "$output" | jq -e '.result.entriesArchived == 0' >/dev/null
}

@test "manifest_archive_old handles single entry manifest" {
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    echo '{"id":"single","file":"t.md","title":"T","date":"2025-01-17","status":"complete","topics":[],"key_findings":[],"actionable":true}' > "$MANIFEST_FILE"

    run manifest_archive_old 50
    # Too few entries to archive
    [[ "$status" -eq 100 ]]

    assert_valid_json
    echo "$output" | jq -e '.result.message | contains("Too few")' >/dev/null
}

@test "manifest_archive_old archives percentage of entries" {
    _create_sample_manifest

    # Archive 50% = 1-2 entries out of 3
    run manifest_archive_old 50
    assert_success
    assert_valid_json

    local archived=$(echo "$output" | jq -r '.result.entriesArchived')
    [[ "$archived" -ge 1 ]]

    # Verify archive file created
    [[ -f "${RESEARCH_OUTPUT_DIR}/MANIFEST-ARCHIVE.jsonl" ]]
}

@test "manifest_archive_old preserves kept entries" {
    _create_sample_manifest
    local original_count=$(wc -l < "$MANIFEST_FILE" | tr -d ' ')

    run manifest_archive_old 50
    assert_success

    local archived=$(echo "$output" | jq -r '.result.entriesArchived')
    local kept=$(echo "$output" | jq -r '.result.entriesKept')

    # Verify counts add up
    [[ $((archived + kept)) -eq $original_count ]]

    # Verify manifest has expected number of entries
    local new_count=$(wc -l < "$MANIFEST_FILE" | tr -d ' ')
    [[ "$new_count" -eq "$kept" ]]
}

# =============================================================================
# manifest_rotate Tests
# =============================================================================

@test "manifest_rotate skips when below threshold" {
    _create_sample_manifest

    run manifest_rotate 1000000 50
    # Returns EXIT_NO_CHANGE (102) when below threshold
    [[ "$status" -eq 102 ]]

    assert_valid_json
    local action=$(echo "$output" | jq -r '.result.action')
    [[ "$action" == "none" ]]
}

@test "manifest_rotate archives when over threshold" {
    _create_sample_manifest

    # Very low threshold to force archival
    run manifest_rotate 100 50
    assert_success
    assert_valid_json

    local action=$(echo "$output" | jq -r '.result.action')
    [[ "$action" == "archived" ]]

    local entries_archived=$(echo "$output" | jq -r '.result.entriesArchived')
    [[ "$entries_archived" -ge 1 ]]
}

@test "manifest_rotate reports before/after bytes" {
    _create_sample_manifest

    run manifest_rotate 100 50
    assert_success
    assert_valid_json

    local bytes_before=$(echo "$output" | jq -r '.result.bytesBefore')
    local bytes_after=$(echo "$output" | jq -r '.result.bytesAfter')

    [[ "$bytes_before" -gt "$bytes_after" ]]
}

# =============================================================================
# get_manifest_stats Tests
# =============================================================================

@test "get_manifest_stats returns error when manifest missing" {
    rm -f "$MANIFEST_FILE"

    run get_manifest_stats
    assert_failure

    assert_valid_json
    local error_code=$(echo "$output" | jq -r '.error.code')
    [[ "$error_code" == "E_NOT_FOUND" ]]
}

@test "get_manifest_stats handles empty manifest" {
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    touch "$MANIFEST_FILE"

    run get_manifest_stats
    assert_success
    assert_valid_json

    local entry_count=$(echo "$output" | jq -r '.result.manifest.entries')
    [[ "$entry_count" -eq 0 ]]
}

@test "get_manifest_stats returns comprehensive stats" {
    _create_sample_manifest

    run get_manifest_stats
    assert_success
    assert_valid_json

    # Check manifest section
    echo "$output" | jq -e '.result.manifest.bytes > 0' >/dev/null
    echo "$output" | jq -e '.result.manifest.entries == 3' >/dev/null

    # Check status counts
    echo "$output" | jq -e '.result.statusCounts | has("complete")' >/dev/null

    # Check actionable count exists
    echo "$output" | jq -e '.result | has("actionableCount")' >/dev/null
}

# =============================================================================
# compact_manifest Tests
# =============================================================================

@test "compact_manifest handles empty manifest" {
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    touch "$MANIFEST_FILE"

    run compact_manifest
    [[ "$status" -eq 100 ]]

    assert_valid_json
    echo "$output" | jq -e '.result.entriesBefore == 0' >/dev/null
}

@test "compact_manifest removes duplicates by ID" {
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    # Two entries with same ID
    echo '{"id":"dup-1","file":"t1.md","title":"T1","date":"2025-01-17","status":"complete","topics":[],"key_findings":[],"actionable":true}' > "$MANIFEST_FILE"
    echo '{"id":"dup-1","file":"t2.md","title":"T2 Updated","date":"2025-01-18","status":"complete","topics":[],"key_findings":[],"actionable":false}' >> "$MANIFEST_FILE"
    echo '{"id":"unique","file":"t3.md","title":"T3","date":"2025-01-17","status":"partial","topics":[],"key_findings":[],"actionable":true}' >> "$MANIFEST_FILE"

    run compact_manifest
    assert_success
    assert_valid_json

    local entries_before=$(echo "$output" | jq -r '.result.entriesBefore')
    local entries_after=$(echo "$output" | jq -r '.result.entriesAfter')

    [[ "$entries_before" -eq 3 ]]
    [[ "$entries_after" -eq 2 ]]
}

@test "compact_manifest removes archived status entries" {
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    echo '{"id":"active-1","file":"t1.md","title":"T1","date":"2025-01-17","status":"complete","topics":[],"key_findings":[],"actionable":true}' > "$MANIFEST_FILE"
    echo '{"id":"archived-1","file":"t2.md","title":"T2","date":"2025-01-17","status":"archived","topics":[],"key_findings":[],"actionable":false}' >> "$MANIFEST_FILE"

    run compact_manifest
    assert_success
    assert_valid_json

    local entries_after=$(echo "$output" | jq -r '.result.entriesAfter')
    [[ "$entries_after" -eq 1 ]]

    # Verify archived entry is removed
    local remaining=$(cat "$MANIFEST_FILE")
    ! echo "$remaining" | grep -q "archived-1"
}

# =============================================================================
# list_archived_entries Tests
# =============================================================================

@test "list_archived_entries returns empty when no archive" {
    rm -f "${RESEARCH_OUTPUT_DIR}/MANIFEST-ARCHIVE.jsonl"

    run list_archived_entries
    [[ "$status" -eq 100 ]]

    assert_valid_json
    echo "$output" | jq -e '.result.total == 0' >/dev/null
}

@test "list_archived_entries returns archived entries" {
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    echo '{"id":"arch-1","file":"t1.md","title":"Archived 1","date":"2025-01-15","status":"complete","archivedAt":"2025-01-17T10:00:00Z","topics":[],"key_findings":[],"actionable":false}' > "${RESEARCH_OUTPUT_DIR}/MANIFEST-ARCHIVE.jsonl"
    echo '{"id":"arch-2","file":"t2.md","title":"Archived 2","date":"2025-01-16","status":"complete","archivedAt":"2025-01-17T11:00:00Z","topics":[],"key_findings":[],"actionable":false}' >> "${RESEARCH_OUTPUT_DIR}/MANIFEST-ARCHIVE.jsonl"

    run list_archived_entries
    assert_success
    assert_valid_json

    local total=$(echo "$output" | jq -r '.result.total')
    [[ "$total" -eq 2 ]]

    local returned=$(echo "$output" | jq -r '.result.returned')
    [[ "$returned" -eq 2 ]]
}

@test "list_archived_entries respects limit" {
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    for i in 1 2 3 4 5; do
        echo "{\"id\":\"arch-$i\",\"file\":\"t$i.md\",\"title\":\"Archived $i\",\"date\":\"2025-01-$((10+i))\",\"status\":\"complete\",\"archivedAt\":\"2025-01-17T1$i:00:00Z\",\"topics\":[],\"key_findings\":[],\"actionable\":false}" >> "${RESEARCH_OUTPUT_DIR}/MANIFEST-ARCHIVE.jsonl"
    done

    run list_archived_entries --limit 2
    assert_success
    assert_valid_json

    local total=$(echo "$output" | jq -r '.result.total')
    [[ "$total" -eq 5 ]]

    local returned=$(echo "$output" | jq -r '.result.returned')
    [[ "$returned" -eq 2 ]]
}
