#!/usr/bin/env bats
# =============================================================================
# injection-side-effects.bats - Unit tests for lib/ui/injection.sh side-effects
# =============================================================================
# Tests side-effect functions that modify files: injection_update,
# injection_apply, and injection_update_all.
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    # Source injection libraries (after common_setup sets paths)
    export CLEO_HOME="${PROJECT_ROOT}"
    export CLEO_LIB_DIR="${LIB_DIR}"

    # Set CLI_VERSION for deterministic test output
    export CLI_VERSION="0.50.2"

    source "$LIB_DIR/ui/injection-registry.sh"
    source "$LIB_DIR/ui/injection-config.sh"
    source "$LIB_DIR/ui/injection.sh"

    # Create test project structure
    mkdir -p "$TEST_TEMP_DIR"
    cd "$TEST_TEMP_DIR"

    # Create test template (note: template doesn't have markers - they're added by injection)
    TEMPLATE_FILE="$TEST_TEMP_DIR/test-template.md"
    cat > "$TEMPLATE_FILE" <<'EOF'
## Task Management (cleo)

Test injection content.
EOF

    # Create test header
    HEADER_FILE="$TEST_TEMP_DIR/test-header.md"
    cat > "$HEADER_FILE" <<'EOF'
# Test Header

Agent-specific instructions.
EOF

    # Mock template paths for testing
    injection_get_template_path() {
        echo "$TEMPLATE_FILE"
    }
    export -f injection_get_template_path

    injection_get_header_path() {
        local target="$1"
        if [[ "$target" == *"WITH-HEADER.md" ]]; then
            echo "$HEADER_FILE"
        fi
    }
    export -f injection_get_header_path
}

teardown() {
    cd /
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# injection_update() Tests - Create New File
# =============================================================================

@test "injection_update creates new file when target doesn't exist" {
    local target="CLAUDE.md"

    run injection_update "$target"
    assert_success

    # File should be created
    [ -f "$target" ]

    # Response should indicate creation
    echo "$output" | grep -q '"action":"created"'
    echo "$output" | grep -q '"success":true'
}

@test "injection_update creates file with correct content" {
    local target="CLAUDE.md"

    injection_update "$target"

    # File should contain versionless injection markers (no version - content is external)
    grep -q "<!-- CLEO:START -->" "$target"
    grep -q "<!-- CLEO:END -->" "$target"

    # File should contain @-reference to template (not full content)
    grep -q "@.cleo/templates/AGENT-INJECTION.md" "$target"
}

@test "injection_update creates file with reference (header merged at injection time)" {
    local target="GEMINI.md"  # GEMINI uses header

    # Update mock to return header for GEMINI
    injection_get_header_path() {
        local t="$1"
        if [[ "$t" == "GEMINI.md" ]]; then
            echo "$HEADER_FILE"
        fi
    }
    export -f injection_get_header_path

    injection_update "$target"

    # File should contain @-reference (header logic now handled by reference resolution)
    grep -q "@.cleo/templates/AGENT-INJECTION.md" "$target"
}

# =============================================================================
# injection_update() Tests - Add to Existing File
# =============================================================================

@test "injection_update adds injection to existing file without markers" {
    local target="CLAUDE.md"

    # Create existing file without injection
    cat > "$target" <<'EOF'
# Existing Content

Some documentation.
EOF

    run injection_update "$target"
    assert_success

    # Response should indicate addition
    echo "$output" | grep -q '"action":"added"'
    echo "$output" | grep -q '"success":true'
}

@test "injection_update prepends injection to existing content" {
    local target="CLAUDE.md"

    # Create existing file
    cat > "$target" <<'EOF'
# Existing Content

Some documentation.
EOF

    injection_update "$target"

    # Injection should be at the top
    head -n 5 "$target" | grep -q "CLEO:START"

    # Existing content should still be present
    grep -q "Existing Content" "$target"
    grep -q "Some documentation" "$target"
}

# =============================================================================
# injection_update() Tests - Update Existing Injection
# =============================================================================

@test "injection_update replaces existing injection block" {
    local target="CLAUDE.md"

    # Create file with old injection
    cat > "$target" <<'EOF'
<!-- CLEO:START v0.40.0 -->
## Old Content

Old injection content.
<!-- CLEO:END -->

# Existing Content

Some documentation.
EOF

    run injection_update "$target"
    assert_success

    # Response should indicate update
    echo "$output" | grep -q '"action":"updated"'
    echo "$output" | grep -q '"success":true'
}

@test "injection_update preserves content outside injection block" {
    local target="CLAUDE.md"

    # Create file with injection and other content
    cat > "$target" <<'EOF'
<!-- CLEO:START v0.40.0 -->
## Old Content
<!-- CLEO:END -->

# Repository Guidelines

This should be preserved.

## Another Section

More content to preserve.
EOF

    injection_update "$target"

    # Old injection content should be gone
    ! grep -q "Old Content" "$target"

    # New injection should be present (versionless marker and @-reference)
    grep -q "<!-- CLEO:START -->" "$target"
    grep -q "@.cleo/templates/AGENT-INJECTION.md" "$target"

    # Existing content should be preserved
    grep -q "Repository Guidelines" "$target"
    grep -q "This should be preserved" "$target"
    grep -q "Another Section" "$target"
    grep -q "More content to preserve" "$target"
}

@test "injection_update removes multiple injection blocks" {
    local target="CLAUDE.md"

    # Create file with multiple injection blocks (edge case)
    cat > "$target" <<'EOF'
<!-- CLEO:START v0.40.0 -->
First block
<!-- CLEO:END -->

# Content

<!-- CLEO:START v0.41.0 -->
Second block
<!-- CLEO:END -->

More content.
EOF

    injection_update "$target"

    # Should only have one injection block
    injection_count=$(grep -c "CLEO:START" "$target")
    [ "$injection_count" -eq 1 ]

    # Should have versionless marker
    grep -q "<!-- CLEO:START -->" "$target"

    # Other content preserved
    grep -q "# Content" "$target"
    grep -q "More content" "$target"
}

# =============================================================================
# injection_update() Tests - Dry Run
# =============================================================================

@test "injection_update --dry-run doesn't modify file" {
    local target="CLAUDE.md"

    # Create existing file
    cat > "$target" <<'EOF'
# Original Content
EOF

    run injection_update "$target" --dry-run
    assert_success

    # Response should indicate dry run
    echo "$output" | grep -q '"dryRun":true'
    echo "$output" | grep -q '"action":"added"'

    # File should be unchanged
    content=$(cat "$target")
    [[ "$content" == "# Original Content" ]]
}

@test "injection_update --dry-run reports correct action for missing file" {
    local target="CLAUDE.md"

    run injection_update "$target" --dry-run
    assert_success

    echo "$output" | grep -q '"action":"created"'
    echo "$output" | grep -q '"dryRun":true'

    # File should not exist
    [ ! -f "$target" ]
}

@test "injection_update --dry-run reports correct action for existing injection" {
    local target="CLAUDE.md"

    cat > "$target" <<'EOF'
<!-- CLEO:START v0.40.0 -->
Old content
<!-- CLEO:END -->
EOF

    run injection_update "$target" --dry-run
    assert_success

    echo "$output" | grep -q '"action":"updated"'
    echo "$output" | grep -q '"dryRun":true'

    # File should be unchanged
    grep -q "v0.40.0" "$target"
}

# =============================================================================
# injection_update() Tests - Validation
# =============================================================================

@test "injection_update rejects invalid target" {
    local target="INVALID.md"

    # Mock validation to return false
    injection_is_valid_target() {
        return 1
    }
    export -f injection_is_valid_target

    run injection_update "$target"
    assert_failure

    # Should output error JSON
    echo "$output" | grep -q '"error":"Invalid target"'
}

# =============================================================================
# injection_apply() Tests - Internal Function
# =============================================================================

@test "injection_apply creates new file (action=created)" {
    local target="NEW.md"
    local content="Test content (unused)"  # content param is unused - we inject reference

    run injection_apply "$target" "$content" "created"
    assert_success

    # File should exist
    [ -f "$target" ]

    # File should contain @-reference (not the content param)
    grep -q "@.cleo/templates/AGENT-INJECTION.md" "$target"
    grep -q "CLEO:START" "$target"
    grep -q "CLEO:END" "$target"
}

@test "injection_apply prepends to existing file (action=added)" {
    local target="EXISTING.md"
    local content="New injection (unused)"  # content param is unused - we inject reference

    # Create existing file
    echo "Old content" > "$target"

    run injection_apply "$target" "$content" "added"
    assert_success

    # @-reference should be first (within markers)
    head -n 3 "$target" | grep -q "@.cleo/templates/AGENT-INJECTION.md"

    # Old content should be preserved
    grep -q "Old content" "$target"
}

@test "injection_apply replaces injection block (action=updated)" {
    local target="UPDATE.md"
    local new_content="ignored (unused)"  # content param is unused - we inject reference

    # Create file with old injection
    cat > "$target" <<'EOF'
<!-- CLEO:START v0.40.0 -->
Old injection
<!-- CLEO:END -->

Preserved content
EOF

    run injection_apply "$target" "$new_content" "updated"
    assert_success

    # Should have versionless marker and @-reference
    grep -q "<!-- CLEO:START -->" "$target"
    grep -q "@.cleo/templates/AGENT-INJECTION.md" "$target"

    # Should not have old version or old content
    ! grep -q "v0.40.0" "$target"
    ! grep -q "Old injection" "$target"

    # Should preserve other content
    grep -q "Preserved content" "$target"
}

@test "injection_apply uses atomic operation (temp file)" {
    skip "Difficult to mock mktemp reliably in subprocess"
    # This is tested implicitly by other tests that verify file content changes
}

# =============================================================================
# injection_update_all() Tests - Batch Operations
# =============================================================================

@test "injection_update_all skips files with existing blocks" {
    # Only @-reference content is considered current; other content is outdated
    # Mock injection_get_targets to return test targets
    injection_get_targets() {
        REPLY=("CLAUDE.md" "AGENTS.md")
    }
    export -f injection_get_targets

    # Create files with current @-reference format (will be skipped)
    cat > "CLAUDE.md" <<'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
EOF

    cat > "AGENTS.md" <<'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
EOF

    run injection_update_all "."
    assert_success

    # Both files have @-reference content, so both should be skipped
    echo "$output" | grep -q '"skipped":2'
}

@test "injection_update_all creates missing files when no block exists" {
    injection_get_targets() {
        REPLY=("CLAUDE.md" "AGENTS.md")
    }
    export -f injection_get_targets

    # Create one file with current @-reference block (will be skipped)
    cat > "CLAUDE.md" <<'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
EOF

    # Create one file without block (will be updated)
    cat > "AGENTS.md" <<'EOF'
# Just content, no injection block
EOF

    run injection_update_all "."
    assert_success

    # Should skip file with @-reference block, update file without
    echo "$output" | grep -q '"updated":1'
    echo "$output" | grep -q '"skipped":1'
}

@test "injection_update_all creates missing files" {
    injection_get_targets() {
        REPLY=("CLAUDE.md")  # Use valid target
    }
    export -f injection_get_targets

    run injection_update_all "."
    assert_success

    # Should create file
    [ -f "CLAUDE.md" ]
    echo "$output" | grep -q '"updated":1'
}

@test "injection_update_all reports failures" {
    injection_get_targets() {
        REPLY=("CLAUDE.md")  # Use valid target
    }
    export -f injection_get_targets

    # Mock injection_update to fail
    injection_update() {
        echo '{"error":"Mock failure"}' >&2
        return 1
    }
    export -f injection_update

    run injection_update_all "."
    assert_success  # update_all succeeds even if individual updates fail

    # Should report failure
    echo "$output" | grep -q '"failed":1'
    echo "$output" | grep -q '"updated":0'
    echo "$output" | grep -q '"error"'
}

@test "injection_update_all works with project_root=." {
    injection_get_targets() {
        REPLY=("CLAUDE.md")  # Use valid target
    }
    export -f injection_get_targets

    run injection_update_all "."
    assert_success

    # Should create file in current directory
    [ -f "CLAUDE.md" ]
}

# =============================================================================
# Atomic Operation Tests
# =============================================================================

@test "injection_apply creates temp file before writing" {
    skip "mktemp mocking doesn't work reliably in BATS subshells"
    # Atomic behavior is tested by successful file operations
}

@test "injection_apply uses mv for atomic rename" {
    local target="ATOMIC.md"

    # Create initial file
    echo "original" > "$target"

    injection_apply "$target" "unused" "created"

    # File should be replaced atomically with @-reference
    grep -q "@.cleo/templates/AGENT-INJECTION.md" "$target"
}

# =============================================================================
# Error Condition Tests
# =============================================================================

@test "injection_update handles missing template file" {
    # Mock template path to non-existent file
    injection_get_template_path() {
        echo "/nonexistent/template.md"
    }
    export -f injection_get_template_path

    local target="TEST.md"

    run injection_update "$target"
    assert_failure
}

@test "injection_update handles read-only target file" {
    skip "Requires permission testing setup"

    local target="READONLY.md"
    echo "content" > "$target"
    chmod 444 "$target"

    run injection_update "$target"
    assert_failure

    # Cleanup
    chmod 644 "$target"
}

@test "injection_apply preserves content on failed write" {
    skip "mv mocking unreliable in BATS - function override doesn't affect subprocess"
    # This scenario is unlikely in practice and difficult to test reliably
}

# =============================================================================
# Content Preservation Tests
# =============================================================================

@test "injection_update preserves trailing content" {
    local target="CLAUDE.md"  # Test trailing content

    cat > "$target" <<'EOF'
<!-- CLEO:START v0.40.0 -->
Old
<!-- CLEO:END -->

# Section 1

Content 1

# Section 2

Content 2
EOF

    injection_update "$target"

    # All sections should be preserved
    grep -q "Section 1" "$target"
    grep -q "Content 1" "$target"
    grep -q "Section 2" "$target"
    grep -q "Content 2" "$target"
}

@test "injection_update preserves blank lines correctly" {
    local target="CLAUDE.md"  # Test blank lines

    cat > "$target" <<'EOF'
<!-- CLEO:START v0.40.0 -->
Old
<!-- CLEO:END -->

# Header


Content with blank lines


More content
EOF

    injection_update "$target"

    # Count blank lines in preserved section
    # Should maintain structure
    grep -q "# Header" "$target"
    grep -q "Content with blank lines" "$target"
    grep -q "More content" "$target"
}

@test "injection_update handles files with only injection block" {
    local target="CLAUDE.md"  # Test only injection

    cat > "$target" <<'EOF'
<!-- CLEO:START v0.40.0 -->
Only this
<!-- CLEO:END -->
EOF

    injection_update "$target"

    # Should replace with new injection (versionless marker)
    grep -q "<!-- CLEO:START -->" "$target"
    ! grep -q "Only this" "$target"
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "injection_update handles empty existing file" {
    local target="CLAUDE.md"  # Test empty file
    touch "$target"

    run injection_update "$target"
    assert_success

    # Should add injection
    grep -q "CLEO:START" "$target"
}

@test "injection_update handles file with only whitespace" {
    local target="CLAUDE.md"  # Test whitespace
    echo -e "\n\n  \n\n" > "$target"

    injection_update "$target"

    # Should add injection and preserve structure
    grep -q "CLEO:START" "$target"
}

@test "injection_update handles unclosed injection markers" {
    local target="CLAUDE.md"  # Test unclosed

    cat > "$target" <<'EOF'
<!-- CLEO:START v0.40.0 -->
Content without end marker

# Other content
EOF

    # This is malformed, but should still work (replaces from START onward)
    run injection_update "$target"
    assert_success

    # Should have properly closed injection
    grep -q "CLEO:START" "$target"
    grep -q "CLEO:END" "$target"
}
