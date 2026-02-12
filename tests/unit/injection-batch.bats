#!/usr/bin/env bats
# =============================================================================
# injection-batch.bats - Unit tests for batch injection operations
# =============================================================================
# Tests batch operations for multi-file injection management:
# - check_all_injections() - JSON status for all targets
# - update_all_injections() - selective batch updates
# - get_injection_summary() - compact status summary
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    # Load injection libraries
    export CLEO_HOME="$PROJECT_ROOT"
    export CLEO_LIB_DIR="$PROJECT_ROOT/lib"

    # Set CLI_VERSION for deterministic version checking (must be before sourcing)
    export CLI_VERSION="0.50.2"

    source "$PROJECT_ROOT/lib/injection.sh"

    # Template version for testing (should match CLI_VERSION for "current" status)
    export TEMPLATE_VERSION="0.50.2"
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

# Create test file with injection block
# Args: file [version]
# If version matches TEMPLATE_VERSION (or "current"), creates current @-reference format
# Otherwise creates outdated format (legacy versioned markers with inline content)
create_injected_file() {
    local file="$1"
    local version="${2:-}"

    if [[ "$version" == "$TEMPLATE_VERSION" ]] || [[ "$version" == "current" ]]; then
        # Current format: no version in marker, @-reference content
        cat > "$file" << 'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->

# Original content
EOF
    else
        # Outdated format: versioned marker with inline content
        cat > "$file" << EOF
<!-- CLEO:START v${version} -->
Test injection content
<!-- CLEO:END -->

# Original content
EOF
    fi
}

# Create file without injection
create_plain_file() {
    local file="$1"
    cat > "$file" << EOF
# Plain file
No injection here
EOF
}

# Get JSON field value from status result
get_json_field() {
    local json="$1"
    local field="$2"
    echo "$json" | jq -r ".$field"
}

# =============================================================================
# injection_check_all() Tests
# =============================================================================

@test "injection_check_all returns all targets when no files exist" {
    # No files created - all targets should be reported as missing
    run injection_check_all
    assert_success

    # Should return valid JSON array
    [[ $(echo "$output" | jq 'type') == '"array"' ]]

    # Should have entries for all targets (3)
    local length
    length=$(echo "$output" | jq 'length')
    [[ "$length" -eq 3 ]]

    # All should have status "missing"
    local missing_count
    missing_count=$(echo "$output" | jq '[.[] | select(.status == "missing")] | length')
    [[ "$missing_count" -eq 3 ]]
}

@test "injection_check_all returns array of statuses for existing files" {
    # Create mixed state files
    create_injected_file "CLAUDE.md" "$TEMPLATE_VERSION"
    create_injected_file "AGENTS.md" "0.40.0"
    create_plain_file "GEMINI.md"

    run injection_check_all
    assert_success

    # Should return valid JSON array
    [[ $(echo "$output" | jq 'type') == '"array"' ]]

    # Should have 3 entries (all targets, regardless of file existence)
    local length
    length=$(echo "$output" | jq 'length')
    [[ "$length" -eq 3 ]]

    # Verify each entry has required fields
    local has_fields
    has_fields=$(echo "$output" | jq '.[0] | has("target") and has("status")')
    [[ "$has_fields" == "true" ]]
}

@test "injection_check_all correctly identifies current status" {
    create_injected_file "CLAUDE.md" "$TEMPLATE_VERSION"

    run injection_check_all
    assert_success

    # Extract status for CLAUDE.md
    local status
    status=$(echo "$output" | jq -r '.[] | select(.target == "CLAUDE.md") | .status')
    [[ "$status" == "current" ]]
}

@test "injection_check_all correctly identifies outdated status" {
    create_injected_file "CLAUDE.md" "0.40.0"

    run injection_check_all
    assert_success

    # Extract status for CLAUDE.md
    local status
    status=$(echo "$output" | jq -r '.[] | select(.target == "CLAUDE.md") | .status')
    [[ "$status" == "outdated" ]]
}

@test "injection_check_all correctly identifies none status" {
    create_plain_file "CLAUDE.md"

    run injection_check_all
    assert_success

    # Extract status for CLAUDE.md
    local status
    status=$(echo "$output" | jq -r '.[] | select(.target == "CLAUDE.md") | .status')
    [[ "$status" == "none" ]]
}

@test "injection_check_all handles mixed states correctly" {
    # Create files in different states
    create_injected_file "CLAUDE.md" "$TEMPLATE_VERSION"  # current
    create_injected_file "AGENTS.md" "0.40.0"              # outdated
    create_plain_file "GEMINI.md"                          # none

    run injection_check_all
    assert_success

    # Parse results
    local claude_status agents_status gemini_status
    claude_status=$(echo "$output" | jq -r '.[] | select(.target == "CLAUDE.md") | .status')
    agents_status=$(echo "$output" | jq -r '.[] | select(.target == "AGENTS.md") | .status')
    gemini_status=$(echo "$output" | jq -r '.[] | select(.target == "GEMINI.md") | .status')

    [[ "$claude_status" == "current" ]]
    [[ "$agents_status" == "outdated" ]]
    [[ "$gemini_status" == "none" ]]
}

@test "injection_check_all returns required fields for each target" {
    create_injected_file "CLAUDE.md" "0.40.0"

    run injection_check_all
    assert_success

    # Check required fields present (target, status, fileExists)
    # Note: New versionless format does not include currentVersion/installedVersion
    local has_required
    has_required=$(echo "$output" | jq '.[0] | has("target") and has("status") and has("fileExists")')
    [[ "$has_required" == "true" ]]

    # Verify target and status are correct
    local target status
    target=$(echo "$output" | jq -r '.[] | select(.target == "CLAUDE.md") | .target')
    status=$(echo "$output" | jq -r '.[] | select(.target == "CLAUDE.md") | .status')
    [[ "$target" == "CLAUDE.md" ]]
    [[ "$status" == "outdated" ]]  # Old versioned format is considered outdated
}

# =============================================================================
# injection_update_all() Tests
# =============================================================================

@test "injection_update_all returns JSON summary" {
    # Create files to update
    create_injected_file "CLAUDE.md" "0.40.0"

    run injection_update_all "."
    assert_success

    # Verify JSON structure
    run jq -e 'has("updated") and has("skipped") and has("failed") and has("results")' <<< "$output"
    assert_success
}

@test "injection_update_all skips current files" {
    # Create ALL files at current version
    create_injected_file "CLAUDE.md" "$TEMPLATE_VERSION"
    create_injected_file "AGENTS.md" "$TEMPLATE_VERSION"
    create_injected_file "GEMINI.md" "$TEMPLATE_VERSION"

    run injection_update_all "."
    assert_success

    # Should skip all files
    local skipped
    skipped=$(echo "$output" | jq -r '.skipped')
    [[ "$skipped" -eq 3 ]]

    local updated
    updated=$(echo "$output" | jq -r '.updated')
    [[ "$updated" -eq 0 ]]
}

@test "injection_update_all updates outdated files only" {
    # Create mixed state
    create_injected_file "CLAUDE.md" "$TEMPLATE_VERSION"  # current - skip
    create_injected_file "AGENTS.md" "0.40.0"              # outdated - update
    create_injected_file "GEMINI.md" "$TEMPLATE_VERSION"  # current - skip

    run injection_update_all "."
    assert_success

    # Should update 1 (AGENTS.md), skip 2 (CLAUDE.md, GEMINI.md)
    local updated skipped
    updated=$(echo "$output" | jq -r '.updated')
    skipped=$(echo "$output" | jq -r '.skipped')

    [[ "$updated" -eq 1 ]]
    [[ "$skipped" -eq 2 ]]
}

@test "injection_update_all creates missing files" {
    # Don't create CLAUDE.md - should be created

    run injection_update_all "."
    assert_success

    # Should have updated (created) at least one file
    local updated
    updated=$(echo "$output" | jq -r '.updated')
    [[ "$updated" -ge 1 ]]

    # File should now exist
    [[ -f "CLAUDE.md" ]]
}

@test "injection_update_all updates files without injection blocks" {
    # Create plain file
    create_plain_file "CLAUDE.md"

    run injection_update_all "."
    assert_success

    # Should update the file
    local updated
    updated=$(echo "$output" | jq -r '.updated')
    [[ "$updated" -ge 1 ]]

    # File should now have injection block
    run injection_has_block "CLAUDE.md"
    assert_success
}

@test "injection_update_all results array contains action details" {
    create_injected_file "CLAUDE.md" "0.40.0"

    run injection_update_all "."
    assert_success

    # Verify results array structure
    local is_array
    is_array=$(echo "$output" | jq '.results | type')
    [[ "$is_array" == '"array"' ]]

    # Check first result has required fields
    local has_fields
    has_fields=$(echo "$output" | jq '.results[0] | has("target") and has("action") and has("success")')
    [[ "$has_fields" == "true" ]]
}

@test "injection_update_all handles all files needing updates" {
    # All files outdated
    create_injected_file "CLAUDE.md" "0.40.0"
    create_injected_file "AGENTS.md" "0.40.0"
    create_injected_file "GEMINI.md" "0.40.0"

    run injection_update_all "."
    assert_success

    # All should be updated
    local updated
    updated=$(echo "$output" | jq -r '.updated')
    [[ "$updated" -eq 3 ]]

    local skipped
    skipped=$(echo "$output" | jq -r '.skipped')
    [[ "$skipped" -eq 0 ]]
}

@test "injection_update_all handles no updates needed" {
    # All files current
    create_injected_file "CLAUDE.md" "$TEMPLATE_VERSION"
    create_injected_file "AGENTS.md" "$TEMPLATE_VERSION"
    create_injected_file "GEMINI.md" "$TEMPLATE_VERSION"

    run injection_update_all "."
    assert_success

    # All should be skipped
    local updated skipped
    updated=$(echo "$output" | jq -r '.updated')
    skipped=$(echo "$output" | jq -r '.skipped')

    [[ "$updated" -eq 0 ]]
    [[ "$skipped" -eq 3 ]]
}

@test "injection_update_all returns zero failed on success" {
    create_injected_file "CLAUDE.md" "0.40.0"

    run injection_update_all "."
    assert_success

    local failed
    failed=$(echo "$output" | jq -r '.failed')
    [[ "$failed" -eq 0 ]]
}

# =============================================================================
# injection_get_summary() Tests
# =============================================================================

@test "injection_get_summary returns JSON object" {
    run injection_get_summary
    assert_success

    # Should be valid JSON object
    local obj_type
    obj_type=$(echo "$output" | jq 'type')
    [[ "$obj_type" == '"object"' ]]
}

@test "injection_get_summary has all required fields" {
    run injection_get_summary
    assert_success

    # Check all fields present
    local has_fields
    has_fields=$(echo "$output" | jq 'has("current") and has("outdated") and has("none") and has("missing") and has("total")')
    [[ "$has_fields" == "true" ]]
}

@test "injection_get_summary counts missing files correctly" {
    # No files exist
    run injection_get_summary
    assert_success

    local missing
    missing=$(echo "$output" | jq -r '.missing')
    [[ "$missing" -eq 3 ]]  # 3 targets (CLAUDE.md, AGENTS.md, GEMINI.md)
}

@test "injection_get_summary counts current files correctly" {
    create_injected_file "CLAUDE.md" "$TEMPLATE_VERSION"
    create_injected_file "AGENTS.md" "$TEMPLATE_VERSION"

    run injection_get_summary
    assert_success

    local current
    current=$(echo "$output" | jq -r '.current')
    [[ "$current" -eq 2 ]]
}

@test "injection_get_summary counts outdated files correctly" {
    create_injected_file "CLAUDE.md" "0.40.0"
    create_injected_file "AGENTS.md" "0.30.0"

    run injection_get_summary
    assert_success

    local outdated
    outdated=$(echo "$output" | jq -r '.outdated')
    [[ "$outdated" -eq 2 ]]
}

@test "injection_get_summary counts none status correctly" {
    create_plain_file "CLAUDE.md"
    create_plain_file "AGENTS.md"

    run injection_get_summary
    assert_success

    local none
    none=$(echo "$output" | jq -r '.none')
    [[ "$none" -eq 2 ]]
}

@test "injection_get_summary calculates total correctly" {
    create_injected_file "CLAUDE.md" "$TEMPLATE_VERSION"  # current
    create_injected_file "AGENTS.md" "0.40.0"              # outdated
    create_plain_file "GEMINI.md"                          # none

    run injection_get_summary
    assert_success

    local total
    total=$(echo "$output" | jq -r '.total')
    [[ "$total" -eq 3 ]]
}

@test "injection_get_summary handles mixed states" {
    create_injected_file "CLAUDE.md" "$TEMPLATE_VERSION"  # current
    create_injected_file "AGENTS.md" "0.40.0"              # outdated
    create_plain_file "GEMINI.md"                          # none

    run injection_get_summary
    assert_success

    # Parse all counts
    local current outdated none missing total
    current=$(echo "$output" | jq -r '.current')
    outdated=$(echo "$output" | jq -r '.outdated')
    none=$(echo "$output" | jq -r '.none')
    missing=$(echo "$output" | jq -r '.missing')
    total=$(echo "$output" | jq -r '.total')

    [[ "$current" -eq 1 ]]
    [[ "$outdated" -eq 1 ]]
    [[ "$none" -eq 1 ]]
    [[ "$missing" -eq 0 ]]
    [[ "$total" -eq 3 ]]
}

@test "injection_get_summary handles all current state" {
    create_injected_file "CLAUDE.md" "$TEMPLATE_VERSION"
    create_injected_file "AGENTS.md" "$TEMPLATE_VERSION"
    create_injected_file "GEMINI.md" "$TEMPLATE_VERSION"

    run injection_get_summary
    assert_success

    local current outdated none missing
    current=$(echo "$output" | jq -r '.current')
    outdated=$(echo "$output" | jq -r '.outdated')
    none=$(echo "$output" | jq -r '.none')
    missing=$(echo "$output" | jq -r '.missing')

    [[ "$current" -eq 3 ]]
    [[ "$outdated" -eq 0 ]]
    [[ "$none" -eq 0 ]]
    [[ "$missing" -eq 0 ]]
}

@test "injection_get_summary handles all outdated state" {
    create_injected_file "CLAUDE.md" "0.40.0"
    create_injected_file "AGENTS.md" "0.30.0"
    create_injected_file "GEMINI.md" "0.25.0"

    run injection_get_summary
    assert_success

    local current outdated
    current=$(echo "$output" | jq -r '.current')
    outdated=$(echo "$output" | jq -r '.outdated')

    [[ "$current" -eq 0 ]]
    [[ "$outdated" -eq 3 ]]
}

@test "injection_get_summary handles empty state" {
    # No files exist
    run injection_get_summary
    assert_success

    local current outdated none missing total
    current=$(echo "$output" | jq -r '.current')
    outdated=$(echo "$output" | jq -r '.outdated')
    none=$(echo "$output" | jq -r '.none')
    missing=$(echo "$output" | jq -r '.missing')
    total=$(echo "$output" | jq -r '.total')

    [[ "$current" -eq 0 ]]
    [[ "$outdated" -eq 0 ]]
    [[ "$none" -eq 0 ]]
    [[ "$missing" -eq 3 ]]
    [[ "$total" -eq 0 ]]
}

# =============================================================================
# Integration Tests - Batch Operations Workflow
# =============================================================================

@test "batch workflow: check all -> update all -> verify summary" {
    # Setup: mixed state
    create_injected_file "CLAUDE.md" "0.40.0"
    create_plain_file "AGENTS.md"
    # GEMINI.md missing

    # Step 1: Check all files
    run injection_check_all
    assert_success
    local check_result="$output"

    # Verify check returns all 3 targets (including missing)
    local file_count
    file_count=$(echo "$check_result" | jq 'length')
    [[ "$file_count" -eq 3 ]]

    # Verify statuses: CLAUDE.md=outdated, AGENTS.md=none, others=missing
    local claude_status agents_status gemini_status
    claude_status=$(echo "$check_result" | jq -r '.[] | select(.target == "CLAUDE.md") | .status')
    agents_status=$(echo "$check_result" | jq -r '.[] | select(.target == "AGENTS.md") | .status')
    gemini_status=$(echo "$check_result" | jq -r '.[] | select(.target == "GEMINI.md") | .status')
    [[ "$claude_status" == "outdated" ]]
    [[ "$agents_status" == "none" ]]
    [[ "$gemini_status" == "missing" ]]

    # Step 2: Update all
    run injection_update_all "."
    assert_success

    # Should have updated all 3 files (created GEMINI.md, updated others)
    local updated
    updated=$(echo "$output" | jq -r '.updated')
    [[ "$updated" -eq 3 ]]

    # Step 3: Get summary
    run injection_get_summary
    assert_success

    # All files should now be current
    local current
    current=$(echo "$output" | jq -r '.current')
    [[ "$current" -eq 3 ]]
}

@test "batch operations maintain consistency across calls" {
    create_injected_file "CLAUDE.md" "0.40.0"

    # First update
    run injection_update_all "."
    assert_success
    local first_updated
    first_updated=$(echo "$output" | jq -r '.updated')

    # Second update (should skip all)
    run injection_update_all "."
    assert_success
    local second_updated second_skipped
    second_updated=$(echo "$output" | jq -r '.updated')
    second_skipped=$(echo "$output" | jq -r '.skipped')

    [[ "$first_updated" -ge 1 ]]
    [[ "$second_updated" -eq 0 ]]
    [[ "$second_skipped" -ge 1 ]]
}
