#!/usr/bin/env bats
# =============================================================================
# research-manifest.bats - Unit tests for lib/research-manifest.sh
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
    source "${LIB_DIR}/research-manifest.sh"

    # Create research output directory
    export RESEARCH_OUTPUT_DIR="${TEST_TEMP_DIR}/docs/claudedocs/research-outputs"
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
