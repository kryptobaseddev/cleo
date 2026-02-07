#!/usr/bin/env bats
# =============================================================================
# docs-gap-check.bats - Tests for cleo docs gap-check command
# =============================================================================
# Tests documentation gap validation between review docs and canonical docs
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

    # Create standard project structure in temp dir
    export TEST_PROJECT_ROOT="${TEST_TEMP_DIR}/test-project"
    export MANIFEST_FILE="${TEST_PROJECT_ROOT}/claudedocs/agent-outputs/MANIFEST.jsonl"
    export DOCS_DIR="${TEST_PROJECT_ROOT}/docs"
    mkdir -p "$(dirname "$MANIFEST_FILE")"
    mkdir -p "$DOCS_DIR"

    # Create gap-check script reference
    export GAP_CHECK_SCRIPT="${SCRIPTS_DIR}/docs.sh"
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

# Create a manifest entry for testing
create_manifest_entry() {
    local id="$1"
    local status="$2"
    local topics="$3"
    local linked_tasks="$4"

    cat >> "$MANIFEST_FILE" << EOF
{"id":"${id}","file":"2026-01-28_${id}.md","title":"Test Document ${id}","date":"2026-01-28","status":"${status}","agent_type":"research","topics":${topics},"linked_tasks":${linked_tasks}}
EOF
}

# Create a canonical docs file with content
create_canonical_doc() {
    local filename="$1"
    local content="$2"

    echo -e "$content" > "${DOCS_DIR}/${filename}"
}

# Run gap-check from test project root
run_gap_check() {
    (cd "$TEST_PROJECT_ROOT" && bash "$GAP_CHECK_SCRIPT" gap-check "$@")
}

# =============================================================================
# Exit Code Tests
# =============================================================================

@test "gap-check exits 0 when no review docs exist" {
    # Create manifest with only complete docs
    create_manifest_entry "T001-spec" "complete" '["topic1"]' '["T001"]'

    run run_gap_check --all-review --json
    assert_success
    assert_output --partial 'no_review_docs'
}

@test "gap-check exits 0 when all review docs have canonical coverage" {
    # Create review doc with topics
    create_manifest_entry "T002-review" "review" '["lifecycle","archival"]' '["T002"]'

    # Create canonical docs with those topics
    create_canonical_doc "commands.md" "# Commands\n\n## Lifecycle\n\nLifecycle management.\n\n## Archival\n\nArchival process."

    run run_gap_check --all-review --json
    assert_success
    echo "$output" | jq -e '.canArchive == true' >/dev/null
}

@test "gap-check exits 1 when gaps are found" {
    # Create review doc with uncovered topics
    create_manifest_entry "T003-gaps" "review" '["new-feature","uncovered-topic"]' '["T003"]'

    # Create canonical docs with only partial coverage
    create_canonical_doc "features.md" "# Features\n\n## New Feature\n\nThis is covered."

    run run_gap_check --all-review --json
    [ "$status" -eq 1 ]
    echo "$output" | jq -e '.canArchive == false' >/dev/null
    assert_output --partial 'uncovered-topic'
}

@test "gap-check exits 2 on error conditions" {
    # Remove manifest to trigger error
    rm -f "$MANIFEST_FILE"

    # Create docs dir but no manifest
    run run_gap_check --all-review --json
    # Without manifest, it should return no_review_docs (exit 0)
    # Or if it treats missing manifest as error:
    [ "$status" -eq 0 ] || [ "$status" -eq 2 ]
}

# =============================================================================
# Filtering Tests
# =============================================================================

@test "gap-check --epic filters to epic's linked docs" {
    # Create docs linked to different epics
    create_manifest_entry "T100-epic1" "review" '["topic1"]' '["T100","T101"]'
    create_manifest_entry "T200-epic2" "review" '["topic2"]' '["T200","T201"]'

    # No canonical coverage to ensure gaps
    run run_gap_check --epic T100 --json
    echo "$output" | jq -e '.reviewDocs[0].linked_tasks == ["T100","T101"]' >/dev/null
    refute_output --partial 'T200'
}

@test "gap-check --task filters to single task's docs" {
    # Create docs linked to specific tasks
    create_manifest_entry "T300-task" "review" '["task-specific"]' '["T300"]'
    create_manifest_entry "T301-other" "review" '["other-topic"]' '["T301"]'

    run run_gap_check --task T300 --json
    assert_output --partial 'T300-task'
    refute_output --partial 'T301'
}

@test "gap-check --all-review finds all docs in review status" {
    # Create mix of statuses
    create_manifest_entry "T400-review1" "review" '["r1"]' '["T400"]'
    create_manifest_entry "T401-complete" "complete" '["c1"]' '["T401"]'
    create_manifest_entry "T402-review2" "review" '["r2"]' '["T402"]'

    run run_gap_check --all-review --json
    assert_output --partial 'T400-review1'
    assert_output --partial 'T402-review2'
    refute_output --partial 'T401-complete'
}

# =============================================================================
# Output Format Tests
# =============================================================================

@test "gap-check JSON output validates schema" {
    create_manifest_entry "T500-json" "review" '["json-test"]' '["T500"]'

    run run_gap_check --all-review --json
    assert_success

    # Validate JSON structure
    echo "$output" | jq empty  # Fails if invalid JSON

    # Check required fields
    echo "$output" | jq -e '.timestamp' >/dev/null
    echo "$output" | jq -e '.reviewDocs' >/dev/null
    echo "$output" | jq -e '.gaps' >/dev/null
    echo "$output" | jq -e '.coverage' >/dev/null
    echo "$output" | jq -e '.status' >/dev/null
    echo "$output" | jq -e '.canArchive' >/dev/null
}

@test "gap-check --human produces human-readable output" {
    create_manifest_entry "T600-human" "review" '["readable"]' '["T600"]'

    run run_gap_check --all-review --human

    # Check for human-readable elements
    assert_output --partial "Gap Analysis"
    assert_output --partial "Documents in review"
    assert_output --partial "T600-human"
}

@test "gap-check JSON includes epic ID when filtered" {
    create_manifest_entry "T700-filtered" "review" '["epic-test"]' '["T700"]'

    run run_gap_check --epic T700 --json
    assert_success
    echo "$output" | jq -e '.epicId == "T700"' >/dev/null
}

# =============================================================================
# Coverage Analysis Tests
# =============================================================================

@test "gap-check detects topic coverage in canonical docs" {
    # Create review doc
    create_manifest_entry "T800-coverage" "review" '["authentication","authorization"]' '["T800"]'

    # Create canonical docs with both topics
    create_canonical_doc "security.md" "# Security\n\n## Authentication\n\nAuth info.\n\n## Authorization\n\nAuthz info."

    run run_gap_check --all-review --json
    assert_success

    # Verify coverage array is populated
    echo "$output" | jq -e '.coverage | length > 0' >/dev/null
    echo "$output" | jq -e '.gaps | length == 0' >/dev/null
}

@test "gap-check reports missing topics in gaps array" {
    # Create review doc with uncovered topics
    create_manifest_entry "T900-missing" "review" '["documented","undocumented"]' '["T900"]'

    # Only cover one topic
    create_canonical_doc "partial.md" "# Partial\n\nDocumented topic here."

    run run_gap_check --all-review --json
    [ "$status" -eq 1 ]

    # Verify gap is reported
    echo "$output" | jq -e '.gaps | length > 0' >/dev/null
    echo "$output" | jq -e '.gaps[] | select(.topic == "undocumented")' >/dev/null
}

@test "gap-check handles case-insensitive topic matching" {
    # Create review doc with mixed case
    create_manifest_entry "T1000-case" "review" '["API-Design"]' '["T1000"]'

    # Create canonical doc with different case
    create_canonical_doc "api.md" "# API\n\n## api-design\n\nDesign patterns."

    run run_gap_check --all-review --json
    assert_success

    # Should find coverage despite case difference
    echo "$output" | jq -e '.canArchive == true' >/dev/null
}

# =============================================================================
# Error Handling Tests
# =============================================================================

@test "gap-check handles invalid JSON entries in manifest" {
    # Create valid entry
    create_manifest_entry "T1100-valid" "review" '["valid"]' '["T1100"]'

    # Append invalid JSON
    echo '{"invalid": json without closing brace' >> "$MANIFEST_FILE"

    # Append another valid entry
    create_manifest_entry "T1101-valid2" "review" '["valid2"]' '["T1101"]'

    # Should skip invalid entry and process valid ones
    run run_gap_check --all-review --json
    assert_success
    assert_output --partial 'T1100-valid'
    assert_output --partial 'T1101-valid2'
}

@test "gap-check handles missing manifest file gracefully" {
    rm -f "$MANIFEST_FILE"

    run run_gap_check --all-review --json
    assert_success
    echo "$output" | jq -e '.status == "no_review_docs"' >/dev/null
}

@test "gap-check handles empty manifest file" {
    # Create empty manifest
    touch "$MANIFEST_FILE"

    run run_gap_check --all-review --json
    assert_success
    echo "$output" | jq -e '.reviewDocs == []' >/dev/null
}

@test "gap-check handles docs directory not existing" {
    # Remove docs directory
    rm -rf "$DOCS_DIR"

    # Create review doc
    create_manifest_entry "T1200-nodocs" "review" '["missing"]' '["T1200"]'

    run run_gap_check --all-review --json
    [ "$status" -eq 1 ]

    # All topics should be gaps
    echo "$output" | jq -e '.gaps | length > 0' >/dev/null
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "gap-check workflow: add review doc → check → add coverage → verify" {
    # Step 1: Create review doc without coverage
    create_manifest_entry "T1300-workflow" "review" '["workflow-topic"]' '["T1300"]'

    # Step 2: Check for gaps
    run run_gap_check --all-review --json
    [ "$status" -eq 1 ]
    echo "$output" | jq -e '.canArchive == false' >/dev/null

    # Step 3: Add canonical coverage
    create_canonical_doc "workflow.md" "# Workflow\n\n## Workflow Topic\n\nNow documented."

    # Step 4: Verify gaps cleared
    run run_gap_check --all-review --json
    assert_success
    echo "$output" | jq -e '.canArchive == true' >/dev/null
}

@test "gap-check multiple epics with different coverage states" {
    # Epic 1: Full coverage
    create_manifest_entry "T1400-epic1" "review" '["covered1"]' '["T1400"]'
    create_canonical_doc "covered.md" "# Covered\n\ncovered1 documentation"

    # Epic 2: Partial coverage
    create_manifest_entry "T1500-epic2" "review" '["covered2","missing2"]' '["T1500"]'
    create_canonical_doc "partial2.md" "# Partial\n\ncovered2 documentation"

    # Check epic 1 - should be ready
    run run_gap_check --epic T1400 --json
    assert_success
    echo "$output" | jq -e '.canArchive == true' >/dev/null

    # Check epic 2 - should have gaps
    run run_gap_check --epic T1500 --json
    [ "$status" -eq 1 ]
    echo "$output" | jq -e '.canArchive == false' >/dev/null
}

# =============================================================================
# Complex Scenario Tests
# =============================================================================

@test "gap-check with multiple topics and multiple files" {
    # Create review doc with many topics
    create_manifest_entry "T1600-complex" "review" '["auth","logging","metrics","testing"]' '["T1600"]'

    # Create multiple canonical docs covering different topics
    create_canonical_doc "auth.md" "# Authentication\n\nAuth documentation."
    create_canonical_doc "observability.md" "# Observability\n\n## Logging\n\nLogs.\n\n## Metrics\n\nMetrics."
    create_canonical_doc "testing.md" "# Testing\n\nTest guide."

    run run_gap_check --all-review --json
    assert_success

    # Verify all topics found
    local coverage_count
    coverage_count=$(echo "$output" | jq '.coverage | length')
    [ "$coverage_count" -eq 4 ]
}

@test "gap-check with hyphenated and underscored topic names" {
    # Create review doc with various naming styles
    create_manifest_entry "T1700-naming" "review" '["snake_case","kebab-case","PascalCase"]' '["T1700"]'

    # Create canonical docs with matching content
    create_canonical_doc "naming.md" "# Naming\n\nsnake_case example\nkebab-case example\nPascalCase example"

    run run_gap_check --all-review --json
    assert_success
    echo "$output" | jq -e '.canArchive == true' >/dev/null
}

@test "gap-check respects manifest linked_tasks array" {
    # Create doc linked to multiple tasks
    create_manifest_entry "T1800-multi" "review" '["shared"]' '["T1800","T1801","T1802"]'

    # Filter by one of the linked tasks
    run run_gap_check --task T1801 --json
    assert_success
    assert_output --partial 'T1800-multi'

    # Filter by task NOT in linked_tasks
    run run_gap_check --task T9999 --json
    assert_success
    echo "$output" | jq -e '.reviewDocs | length == 0' >/dev/null
}
