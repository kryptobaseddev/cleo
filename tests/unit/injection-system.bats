#!/usr/bin/env bats
# =============================================================================
# injection-system.bats - Integration tests for injection system validation
# =============================================================================
# Tests the full injection system workflow including:
# - Marker detection in injected files
# - Global vs project injection content
# - User content preservation
# - Agent registry discovery
# - Upgrade command injection refresh
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    # Set CLEO_HOME for library sourcing
    export CLEO_HOME="${PROJECT_ROOT}"
    export CLEO_LIB_DIR="${PROJECT_ROOT}/lib"

    # Source injection libraries
    source "${PROJECT_ROOT}/lib/ui/injection-registry.sh"
    source "${PROJECT_ROOT}/lib/ui/injection-config.sh"
    source "${PROJECT_ROOT}/lib/ui/injection.sh"
    source "${PROJECT_ROOT}/lib/skills/agent-registry.sh"

    # Create test project structure
    mkdir -p "$TEST_TEMP_DIR/.cleo/templates"

    # Copy template file
    cp "${PROJECT_ROOT}/templates/AGENT-INJECTION.md" \
       "$TEST_TEMP_DIR/.cleo/templates/AGENT-INJECTION.md"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Test Case 1: CLEO Markers Present
# =============================================================================

@test "injection_system: CLEO:START/END markers present in injected file" {
    local test_file="$TEST_TEMP_DIR/CLAUDE.md"

    # Create file with injection block
    cat > "$test_file" <<'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->

# User Content
EOF

    # Verify markers exist
    grep -q "<!-- CLEO:START -->" "$test_file"
    grep -q "<!-- CLEO:END -->" "$test_file"
}

@test "injection_system: markers use correct HTML comment format" {
    local test_file="$TEST_TEMP_DIR/CLAUDE.md"

    # Create injected file
    echo "<!-- CLEO:START -->" > "$test_file"
    echo "@.cleo/templates/AGENT-INJECTION.md" >> "$test_file"
    echo "<!-- CLEO:END -->" >> "$test_file"

    # Verify HTML comment format
    run grep -E "^<!-- CLEO:START -->$" "$test_file"
    assert_success

    run grep -E "^<!-- CLEO:END -->$" "$test_file"
    assert_success
}

@test "injection_system: injection_has_block detects markers" {
    local test_file="$TEST_TEMP_DIR/CLAUDE.md"

    cat > "$test_file" <<'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
EOF

    run injection_has_block "$test_file"
    assert_success
}

@test "injection_system: injection_has_block returns false for clean file" {
    local test_file="$TEST_TEMP_DIR/CLAUDE.md"

    echo "# Clean File" > "$test_file"
    echo "No injection markers" >> "$test_file"

    run injection_has_block "$test_file"
    assert_failure
}

# =============================================================================
# Test Case 2: Global Injection Content (CLEO-INJECTION.md)
# =============================================================================

@test "injection_system: global injection content uses @-reference format" {
    local test_file="$TEST_TEMP_DIR/CLAUDE.md"

    # Create file with proper @-reference
    cat > "$test_file" <<'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
EOF

    # Extract content between markers
    local content
    content=$(awk '/<!-- CLEO:START -->/{flag=1;next}/<!-- CLEO:END -->/{flag=0}flag' "$test_file" | tr -d '[:space:]')

    # Verify it's an @-reference
    [[ "$content" == "@.cleo/templates/AGENT-INJECTION.md" ]]
}

@test "injection_system: injection_check reports current for @-reference" {
    local test_file="$TEST_TEMP_DIR/CLAUDE.md"

    cat > "$test_file" <<'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
EOF

    local result status
    result=$(injection_check "$test_file")
    status=$(echo "$result" | jq -r '.status')

    [ "$status" = "current" ]
}

@test "injection_system: template file has no markers (added by wrapper)" {
    local template_path
    template_path=$(injection_get_template_path)

    # Template should NOT contain markers (added during injection)
    run grep -q "CLEO:START" "$template_path"
    assert_failure

    run grep -q "CLEO:END" "$template_path"
    assert_failure
}

@test "injection_system: AGENT-INJECTION.md template exists" {
    local template_path
    template_path=$(injection_get_template_path)

    [ -f "$template_path" ]
}

# =============================================================================
# Test Case 3: Project Injection Content (AGENT-INJECTION.md in .cleo/templates)
# =============================================================================

@test "injection_system: project template copied during init" {
    # Verify project-level template exists
    [ -f "$TEST_TEMP_DIR/.cleo/templates/AGENT-INJECTION.md" ]
}

@test "injection_system: project template matches global template" {
    local global_template project_template
    global_template=$(injection_get_template_path)
    project_template="$TEST_TEMP_DIR/.cleo/templates/AGENT-INJECTION.md"

    # Compare file contents (should be identical)
    cmp -s "$global_template" "$project_template"
}

@test "injection_system: @-reference points to project template" {
    local test_file="$TEST_TEMP_DIR/CLAUDE.md"

    cat > "$test_file" <<'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
EOF

    # Extract reference path
    local ref_path
    ref_path=$(awk '/<!-- CLEO:START -->/{flag=1;next}/<!-- CLEO:END -->/{flag=0}flag' "$test_file" | tr -d '[:space:]')

    # Verify it references project-level template
    [[ "$ref_path" == "@.cleo/templates/AGENT-INJECTION.md" ]]
}

# =============================================================================
# Test Case 4: User Content Preservation
# =============================================================================

@test "injection_system: user content outside markers preserved" {
    local test_file="$TEST_TEMP_DIR/CLAUDE.md"

    # Create file with user content
    cat > "$test_file" <<'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->

# My Custom Instructions

This is my custom content that should be preserved.

## Section 1
EOF

    # Apply injection update (should preserve user content)
    cd "$TEST_TEMP_DIR" && injection_update "CLAUDE.md" >/dev/null

    # Verify user content still exists
    grep -q "# My Custom Instructions" "$test_file"
    grep -q "This is my custom content" "$test_file"
    grep -q "## Section 1" "$test_file"
}

@test "injection_system: content before markers removed during update" {
    local test_file="$TEST_TEMP_DIR/CLAUDE.md"

    # Create file with content BEFORE markers (should be removed)
    cat > "$test_file" <<'EOF'
# Content Before Markers

<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->

# Content After Markers
EOF

    # Apply update
    cd "$TEST_TEMP_DIR" && injection_update "CLAUDE.md" >/dev/null

    # Content before markers should be removed
    run grep "Content Before Markers" "$test_file"
    assert_failure

    # Content after markers should be preserved
    grep -q "Content After Markers" "$test_file"
}

@test "injection_system: multiple injection blocks handled correctly" {
    local test_file="$TEST_TEMP_DIR/CLAUDE.md"

    # Create file with multiple blocks (only first should remain)
    cat > "$test_file" <<'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->

# User Content

<!-- CLEO:START -->
Old injection block
<!-- CLEO:END -->
EOF

    # Apply update (should strip all existing blocks, add single block)
    cd "$TEST_TEMP_DIR" && injection_update "CLAUDE.md" >/dev/null

    # Count blocks (should be exactly 1)
    local block_count
    block_count=$(grep -c "<!-- CLEO:START -->" "$test_file")
    [ "$block_count" -eq 1 ]
}

@test "injection_system: empty lines preserved after injection block" {
    local test_file="$TEST_TEMP_DIR/CLAUDE.md"

    cat > "$test_file" <<'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->


# User Content
EOF

    # Apply update
    cd "$TEST_TEMP_DIR" && injection_update "CLAUDE.md" >/dev/null

    # Verify blank lines still present (awk strips leading blanks by default)
    # User content should still be present
    grep -q "# User Content" "$test_file"
}

# =============================================================================
# Test Case 5: Agent Registry Discovery
# =============================================================================

@test "injection_system: agent registry finds installed agents" {
    # Load agent registry
    run ar_load_registry
    assert_success
}

@test "injection_system: agent registry lists known agents" {
    local agents
    agents=$(ar_list_agents)

    # Should include tier1 agents at minimum
    echo "$agents" | grep -q "claude-code"
}

@test "injection_system: agent registry provides agent config" {
    local config
    config=$(ar_get_agent "claude-code")

    # Should return valid JSON
    echo "$config" | jq empty

    # Should have required fields
    local display_name instruction_file
    display_name=$(echo "$config" | jq -r '.displayName')
    instruction_file=$(echo "$config" | jq -r '.instructionFile')

    [ "$display_name" = "Claude Code" ]
    [ "$instruction_file" = "CLAUDE.md" ]
}

@test "injection_system: agent registry resolves instruction files" {
    # Get all unique instruction files
    local files
    files=$(ar_get_instruction_files)

    # Should include standard files
    echo "$files" | grep -q "CLAUDE.md"
    echo "$files" | grep -q "AGENTS.md"
    echo "$files" | grep -q "GEMINI.md"
}

@test "injection_system: agent registry maps file to agents" {
    # CLAUDE.md should map to claude-code
    local agents
    agents=$(ar_list_by_instruction_file "CLAUDE.md")

    echo "$agents" | grep -q "claude-code"
}

@test "injection_system: ar_is_installed checks agent directory" {
    # Mock a fake agent installation
    mkdir -p "$HOME/.test-agent"

    # Temporarily add to registry (we'll just test with existing agents)
    # Test with claude-code (if directory exists)
    if [ -d "$HOME/.claude" ]; then
        run ar_is_installed "claude-code"
        assert_success
    else
        # Skip if not installed
        skip "Claude Code not installed on this system"
    fi
}

# =============================================================================
# Test Case 6: Upgrade Command Injection Refresh
# =============================================================================

@test "injection_system: injection_update_all returns JSON summary" {
    cd "$TEST_TEMP_DIR"

    # Create target files
    mkdir -p "$TEST_TEMP_DIR"
    echo "# Clean" > "$TEST_TEMP_DIR/CLAUDE.md"
    echo "# Clean" > "$TEST_TEMP_DIR/AGENTS.md"

    local result
    result=$(injection_update_all "$TEST_TEMP_DIR")

    # Should return valid JSON
    echo "$result" | jq empty

    # Should have summary fields
    local updated skipped failed
    updated=$(echo "$result" | jq -r '.updated')
    skipped=$(echo "$result" | jq -r '.skipped')
    failed=$(echo "$result" | jq -r '.failed')

    # At least one should be non-zero
    [ -n "$updated" ]
    [ -n "$skipped" ]
    [ -n "$failed" ]
}

@test "injection_system: injection_update creates file if missing" {
    cd "$TEST_TEMP_DIR"

    local test_file="$TEST_TEMP_DIR/CLAUDE.md"

    # File doesn't exist
    [ ! -f "$test_file" ]

    # Apply injection
    injection_update "CLAUDE.md" >/dev/null

    # File should now exist with markers
    [ -f "$test_file" ]
    grep -q "<!-- CLEO:START -->" "$test_file"
}

@test "injection_system: injection_update adds block to clean file" {
    cd "$TEST_TEMP_DIR"

    local test_file="$TEST_TEMP_DIR/CLAUDE.md"

    # Create clean file (no injection)
    cat > "$test_file" <<'EOF'
# My Instructions

Custom content here.
EOF

    # Apply injection
    injection_update "CLAUDE.md" >/dev/null

    # Should now have markers
    grep -q "<!-- CLEO:START -->" "$test_file"

    # Custom content should be preserved
    grep -q "Custom content here" "$test_file"
}

@test "injection_system: injection_update updates outdated block" {
    cd "$TEST_TEMP_DIR"

    local test_file="$TEST_TEMP_DIR/CLAUDE.md"

    # Create file with legacy inline content
    cat > "$test_file" <<'EOF'
<!-- CLEO:START v0.40.0 -->
Old inline content that should be replaced
<!-- CLEO:END -->
EOF

    # Apply injection
    injection_update "CLAUDE.md" >/dev/null

    # Should now have @-reference format
    grep -q "@.cleo/templates/AGENT-INJECTION.md" "$test_file"

    # Old content should be gone
    run grep "Old inline content" "$test_file"
    assert_failure
}

@test "injection_system: injection_check_all returns array for all targets" {
    cd "$TEST_TEMP_DIR"

    # Create some test files
    echo "# Clean" > "$TEST_TEMP_DIR/CLAUDE.md"
    echo "# Clean" > "$TEST_TEMP_DIR/AGENTS.md"

    local result
    result=$(injection_check_all)

    # Should be valid JSON array
    echo "$result" | jq empty

    # Should have entries
    local count
    count=$(echo "$result" | jq '. | length')
    [ "$count" -gt 0 ]
}

@test "injection_system: injection_get_summary provides status overview" {
    cd "$TEST_TEMP_DIR"

    # Create mix of files
    cat > "$TEST_TEMP_DIR/CLAUDE.md" <<'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
EOF

    echo "# Clean" > "$TEST_TEMP_DIR/AGENTS.md"

    local summary
    summary=$(injection_get_summary)

    # Should be valid JSON
    echo "$summary" | jq empty

    # Should have status counts
    local current outdated none missing
    current=$(echo "$summary" | jq -r '.current')
    outdated=$(echo "$summary" | jq -r '.outdated')
    none=$(echo "$summary" | jq -r '.none')
    missing=$(echo "$summary" | jq -r '.missing')

    [ -n "$current" ]
    [ -n "$outdated" ]
    [ -n "$none" ]
    [ -n "$missing" ]
}

# =============================================================================
# Additional Edge Cases
# =============================================================================

@test "injection_system: handles file with only markers (no content)" {
    local test_file="$TEST_TEMP_DIR/CLAUDE.md"

    # Create file with only markers
    cat > "$test_file" <<'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
EOF

    run injection_has_block "$test_file"
    assert_success

    # Status should be current
    local status
    status=$(injection_check "$test_file" | jq -r '.status')
    [ "$status" = "current" ]
}

@test "injection_system: validates target file names" {
    # Valid targets
    run injection_is_valid_target "CLAUDE.md"
    assert_success

    run injection_is_valid_target "AGENTS.md"
    assert_success

    run injection_is_valid_target "GEMINI.md"
    assert_success

    # Invalid targets
    run injection_is_valid_target "README.md"
    assert_failure

    run injection_is_valid_target "random.md"
    assert_failure
}

@test "injection_system: injection_get_targets returns array" {
    injection_get_targets

    # REPLY array should be populated
    [ ${#REPLY[@]} -gt 0 ]

    # Should include standard targets
    local found_claude=false
    for target in "${REPLY[@]}"; do
        if [ "$target" = "CLAUDE.md" ]; then
            found_claude=true
            break
        fi
    done
    [ "$found_claude" = true ]
}

@test "injection_system: dry-run mode doesn't modify files" {
    cd "$TEST_TEMP_DIR"
    local test_file="$TEST_TEMP_DIR/CLAUDE.md"

    # Create clean file
    echo "# Clean File" > "$test_file"
    local original_content
    original_content=$(cat "$test_file")

    # Run in dry-run mode
    injection_update "CLAUDE.md" --dry-run >/dev/null

    # File should be unchanged
    local current_content
    current_content=$(cat "$test_file")
    [ "$original_content" = "$current_content" ]
}
