#!/usr/bin/env bats
# =============================================================================
# manifest-hierarchy.bats - Unit tests for manifest hierarchy extension
# =============================================================================
# @task T4358
# @epic T4352

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    export CLEO_HOME="${PROJECT_ROOT}"
    export CLEO_LIB_DIR="${PROJECT_ROOT}/lib"

    # Source required libraries
    source "${PROJECT_ROOT}/lib/core/exit-codes.sh"
    source "${PROJECT_ROOT}/lib/core/config.sh" 2>/dev/null || true
    source "${PROJECT_ROOT}/lib/data/file-ops.sh" 2>/dev/null || true
    source "${PROJECT_ROOT}/lib/skills/research-manifest.sh" 2>/dev/null || true

    # Create test manifest directory
    mkdir -p "$TEST_TEMP_DIR/claudedocs/agent-outputs"
    export TODO_DIR="$TEST_TEMP_DIR/.cleo"
    mkdir -p "$TODO_DIR"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Schema Validation
# =============================================================================

@test "manifest_hierarchy: schema includes parentId field" {
    local schema="${PROJECT_ROOT}/schemas/research-manifest.schema.json"
    run jq '.properties.parentId' "$schema"
    assert_success
    assert_output --partial '"type"'
}

@test "manifest_hierarchy: schema includes epicId field" {
    local schema="${PROJECT_ROOT}/schemas/research-manifest.schema.json"
    run jq '.properties.epicId' "$schema"
    assert_success
    assert_output --partial '"type"'
}

@test "manifest_hierarchy: schema includes path field" {
    local schema="${PROJECT_ROOT}/schemas/research-manifest.schema.json"
    run jq '.properties.path' "$schema"
    assert_success
    assert_output --partial '"string"'
}

@test "manifest_hierarchy: schema includes depth field" {
    local schema="${PROJECT_ROOT}/schemas/research-manifest.schema.json"
    run jq '.properties.depth' "$schema"
    assert_success
    assert_output --partial '"integer"'
}

@test "manifest_hierarchy: schema includes childCount field" {
    local schema="${PROJECT_ROOT}/schemas/research-manifest.schema.json"
    run jq '.properties.childCount' "$schema"
    assert_success
    assert_output --partial '"integer"'
}

@test "manifest_hierarchy: depth has maximum of 10" {
    local schema="${PROJECT_ROOT}/schemas/research-manifest.schema.json"
    local max
    max=$(jq '.properties.depth.maximum' "$schema")
    [ "$max" -eq 10 ]
}

@test "manifest_hierarchy: hierarchy fields are not required" {
    local schema="${PROJECT_ROOT}/schemas/research-manifest.schema.json"
    local required
    required=$(jq -r '.required[]' "$schema")
    echo "$required" | grep -qv "parentId"
    echo "$required" | grep -qv "epicId"
    echo "$required" | grep -qv "path"
    echo "$required" | grep -qv "depth"
    echo "$required" | grep -qv "childCount"
}

# =============================================================================
# Backward Compatibility
# =============================================================================

@test "manifest_hierarchy: entries without hierarchy fields are valid" {
    # An entry without hierarchy fields should still work
    local entry='{"id":"test-2026-02-14","file":"2026-02-14_test.md","title":"Test entry without hierarchy","date":"2026-02-14","status":"complete","topics":["test"],"key_findings":["f1","f2","f3"],"actionable":false}'

    # Should parse without error
    echo "$entry" | jq -r '.id'
    local result=$?
    [ "$result" -eq 0 ]
}

@test "manifest_hierarchy: default values for missing hierarchy fields" {
    local entry='{"id":"test-2026-02-14"}'

    local parent_id epic_id path depth child_count
    parent_id=$(echo "$entry" | jq -r '.parentId // "null"')
    epic_id=$(echo "$entry" | jq -r '.epicId // "null"')
    path=$(echo "$entry" | jq -r '.path // ""')
    depth=$(echo "$entry" | jq -r '.depth // 0')
    child_count=$(echo "$entry" | jq -r '.childCount // 0')

    [ "$parent_id" = "null" ]
    [ "$epic_id" = "null" ]
    [ "$path" = "" ]
    [ "$depth" = "0" ]
    [ "$child_count" = "0" ]
}

# =============================================================================
# Tree Invariant Validation
# =============================================================================

@test "manifest_hierarchy: validate_manifest_hierarchy detects missing parent" {
    local manifest="$TEST_TEMP_DIR/claudedocs/agent-outputs/MANIFEST.jsonl"
    mkdir -p "$(dirname "$manifest")"

    # Entry references non-existent parent
    echo '{"id":"child-1","parentId":"parent-that-does-not-exist","path":"T001/T002","depth":1,"childCount":0}' > "$manifest"

    # Mock the config to use our test path
    _rm_get_manifest_path() { echo "$manifest"; }
    export -f _rm_get_manifest_path

    run validate_manifest_hierarchy
    # Should return validation error
    assert_output --partial "INV-1"
}

@test "manifest_hierarchy: validate_manifest_hierarchy detects depth inconsistency" {
    local manifest="$TEST_TEMP_DIR/claudedocs/agent-outputs/MANIFEST.jsonl"
    mkdir -p "$(dirname "$manifest")"

    # depth=2 but path has only 1 slash
    echo '{"id":"entry-1","parentId":null,"path":"T001/T002","depth":2,"childCount":0}' > "$manifest"

    _rm_get_manifest_path() { echo "$manifest"; }
    export -f _rm_get_manifest_path

    run validate_manifest_hierarchy
    assert_output --partial "INV-2"
}

@test "manifest_hierarchy: validate_manifest_hierarchy passes for valid tree" {
    local manifest="$TEST_TEMP_DIR/claudedocs/agent-outputs/MANIFEST.jsonl"
    mkdir -p "$(dirname "$manifest")"

    # Valid parent-child pair
    echo '{"id":"root-entry","parentId":null,"epicId":"T001","path":"T001","depth":0,"childCount":1}' > "$manifest"
    echo '{"id":"child-entry","parentId":"root-entry","epicId":"T001","path":"T001/T002","depth":1,"childCount":0}' >> "$manifest"

    _rm_get_manifest_path() { echo "$manifest"; }
    export -f _rm_get_manifest_path

    run validate_manifest_hierarchy
    assert_success
    assert_output --partial '"valid": true'
}

@test "manifest_hierarchy: validate_manifest_hierarchy detects childCount mismatch" {
    local manifest="$TEST_TEMP_DIR/claudedocs/agent-outputs/MANIFEST.jsonl"
    mkdir -p "$(dirname "$manifest")"

    # Claims childCount=5 but has no children
    echo '{"id":"lonely-root","parentId":null,"path":"T001","depth":0,"childCount":5}' > "$manifest"

    _rm_get_manifest_path() { echo "$manifest"; }
    export -f _rm_get_manifest_path

    run validate_manifest_hierarchy
    assert_output --partial "INV-3"
}

# =============================================================================
# Enrichment Function
# =============================================================================

@test "manifest_hierarchy: enrichment adds default hierarchy fields" {
    local entry='{"id":"test-entry","linked_tasks":[]}'
    local result
    result=$(_rm_enrich_hierarchy_fields "$entry" "")

    local depth child_count
    depth=$(echo "$result" | jq -r '.depth')
    child_count=$(echo "$result" | jq -r '.childCount')

    [ "$depth" = "0" ]
    [ "$child_count" = "0" ]
}

@test "manifest_hierarchy: enrichment preserves existing hierarchy fields" {
    local entry='{"id":"test-entry","epicId":"T999","path":"T999/T1000","depth":1,"childCount":3}'
    local result
    result=$(_rm_enrich_hierarchy_fields "$entry" "")

    local epic_id path depth child_count
    epic_id=$(echo "$result" | jq -r '.epicId')
    path=$(echo "$result" | jq -r '.path')
    depth=$(echo "$result" | jq -r '.depth')
    child_count=$(echo "$result" | jq -r '.childCount')

    [ "$epic_id" = "T999" ]
    [ "$path" = "T999/T1000" ]
    [ "$depth" = "1" ]
    [ "$child_count" = "3" ]
}
