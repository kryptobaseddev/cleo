#!/usr/bin/env bats
# =============================================================================
# injection-output.bats - Golden File Tests for Injection Output Format
# =============================================================================
# Tests JSON output format stability for injection-related operations.
# Verifies that injection check/update operations produce consistent output.
# Run with UPDATE_GOLDEN=1 to regenerate golden files.
# =============================================================================

# Get the directory containing this test file
GOLDEN_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
PROJECT_ROOT="$(cd "$GOLDEN_DIR/../.." && pwd)"
FIXTURES_DIR="$GOLDEN_DIR/fixtures"
EXPECTED_DIR="$GOLDEN_DIR/expected"

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    common_setup_per_test

    # Use BATS-managed temp directory (auto-cleaned)
    TEST_DIR="${BATS_TEST_TMPDIR}"
    mkdir -p "$TEST_DIR/.cleo/templates"

    # Set up CLEO environment
    export CLEO_HOME="$PROJECT_ROOT"
    export CLEO_LIB_DIR="$PROJECT_ROOT/lib"

    # Source injection libraries
    source "$PROJECT_ROOT/lib/ui/injection-registry.sh"
    source "$PROJECT_ROOT/lib/ui/injection-config.sh"
    source "$PROJECT_ROOT/lib/ui/injection.sh"

    # Copy injection template
    if [[ -f "$PROJECT_ROOT/templates/AGENT-INJECTION.md" ]]; then
        cp "$PROJECT_ROOT/templates/AGENT-INJECTION.md" "$TEST_DIR/.cleo/templates/"
    fi

    # Ensure expected directory exists
    mkdir -p "$EXPECTED_DIR"

    # Set environment
    export NO_COLOR=1  # Disable colors for consistent output
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

# Normalize output for golden comparison
# - Replace timestamps with placeholder
# - Replace version numbers with placeholder
# - Normalize paths
normalize_injection_output() {
    sed -E \
        -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z?/TIMESTAMP/g' \
        -e 's/"timestamp":"[^"]+/"timestamp":"TIMESTAMP/g' \
        -e 's/"version":"[0-9]+\.[0-9]+\.[0-9]+"/"version":"VERSION"/g' \
        -e 's/"currentVersion":"[0-9]+\.[0-9]+\.[0-9]+"/"currentVersion":"VERSION"/g' \
        -e 's/"installedVersion":"[0-9]+\.[0-9]+\.[0-9]+"/"installedVersion":"VERSION"/g' \
        -e 's/v[0-9]+\.[0-9]+\.[0-9]+/vVERSION/g' \
        -e "s|$TEST_DIR|TESTDIR|g" \
        -e "s|$PROJECT_ROOT|PROJECT|g"
}

# Compare output with golden file
# Args: $1 = golden file name, $2 = actual output
compare_injection_golden() {
    local golden_name="$1"
    local actual="$2"
    local golden_file="$EXPECTED_DIR/$golden_name"

    local normalized
    normalized=$(echo "$actual" | normalize_injection_output)

    if [[ "${UPDATE_GOLDEN:-}" == "1" ]]; then
        echo "$normalized" > "$golden_file"
        echo "Updated: $golden_file" >&3
        return 0
    fi

    if [[ ! -f "$golden_file" ]]; then
        echo "Golden file not found: $golden_file" >&2
        echo "Run with UPDATE_GOLDEN=1 to create it" >&2
        echo "--- Actual output ---" >&2
        echo "$normalized" >&2
        return 1
    fi

    local expected
    expected=$(cat "$golden_file")

    if [[ "$normalized" != "$expected" ]]; then
        echo "Output differs from golden file: $golden_file" >&2
        echo "--- Expected ---" >&2
        echo "$expected" >&2
        echo "--- Actual ---" >&2
        echo "$normalized" >&2
        echo "--- Diff ---" >&2
        diff -u <(echo "$expected") <(echo "$normalized") >&2 || true
        return 1
    fi

    return 0
}

# =============================================================================
# Golden Tests: injection_check - missing file
# =============================================================================

@test "golden: injection_check missing file" {
    cd "$TEST_DIR"

    # Check a file that doesn't exist
    run injection_check "CLAUDE.md"
    [ "$status" -eq 0 ]
    compare_injection_golden "injection-check-missing.golden" "$output"
}

# =============================================================================
# Golden Tests: injection_check - no injection block
# =============================================================================

@test "golden: injection_check no injection" {
    cd "$TEST_DIR"

    # Create file without injection block
    echo "# My Project" > "$TEST_DIR/CLAUDE.md"
    echo "" >> "$TEST_DIR/CLAUDE.md"
    echo "Some content without injection." >> "$TEST_DIR/CLAUDE.md"

    run injection_check "CLAUDE.md"
    [ "$status" -eq 0 ]
    compare_injection_golden "injection-check-none.golden" "$output"
}

# =============================================================================
# Golden Tests: injection_check - current injection
# =============================================================================

@test "golden: injection_check current" {
    cd "$TEST_DIR"

    # Create file with current injection format (using @-reference)
    cat > "$TEST_DIR/CLAUDE.md" << 'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
# My Project

Some content after injection.
EOF

    run injection_check "CLAUDE.md"
    [ "$status" -eq 0 ]
    compare_injection_golden "injection-check-current.golden" "$output"
}

# =============================================================================
# Golden Tests: injection_check - outdated injection (wrong content)
# =============================================================================

@test "golden: injection_check outdated" {
    cd "$TEST_DIR"

    # Create file with outdated injection format (wrong @-reference)
    cat > "$TEST_DIR/CLAUDE.md" << 'EOF'
<!-- CLEO:START -->
@wrong/path/to/template.md
<!-- CLEO:END -->
# My Project

Some content after injection.
EOF

    run injection_check "CLAUDE.md"
    [ "$status" -eq 0 ]
    compare_injection_golden "injection-check-outdated.golden" "$output"
}

# =============================================================================
# Golden Tests: injection_check_all - mixed status
# =============================================================================

@test "golden: injection_check_all mixed" {
    cd "$TEST_DIR"

    # Create CLAUDE.md with current injection
    cat > "$TEST_DIR/CLAUDE.md" << 'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
EOF

    # Create AGENTS.md without injection
    echo "# Agents Documentation" > "$TEST_DIR/AGENTS.md"

    # GEMINI.md doesn't exist (missing)

    run injection_check_all
    [ "$status" -eq 0 ]
    compare_injection_golden "injection-check-all-mixed.golden" "$output"
}

# =============================================================================
# Golden Tests: injection_update - create new file
# =============================================================================

@test "golden: injection_update create" {
    cd "$TEST_DIR"

    # File doesn't exist, should be created
    local result
    result=$(injection_update "CLAUDE.md" 2>/dev/null)
    [ $? -eq 0 ]
    compare_injection_golden "injection-update-created.golden" "$result"

    # Verify file was created
    [ -f "$TEST_DIR/CLAUDE.md" ]
}

# =============================================================================
# Golden Tests: injection_update - add to existing
# =============================================================================

@test "golden: injection_update add" {
    cd "$TEST_DIR"

    # Create file without injection
    cat > "$TEST_DIR/CLAUDE.md" << 'EOF'
# My Project

Existing content that should be preserved.
EOF

    local result
    result=$(injection_update "CLAUDE.md" 2>/dev/null)
    [ $? -eq 0 ]
    compare_injection_golden "injection-update-added.golden" "$result"
}

# =============================================================================
# Golden Tests: injection_update - update existing
# =============================================================================

@test "golden: injection_update update" {
    cd "$TEST_DIR"

    # Create file with outdated injection
    cat > "$TEST_DIR/CLAUDE.md" << 'EOF'
<!-- CLEO:START -->
@old/path/template.md
<!-- CLEO:END -->
# My Project

Content after injection.
EOF

    local result
    result=$(injection_update "CLAUDE.md" 2>/dev/null)
    [ $? -eq 0 ]
    compare_injection_golden "injection-update-updated.golden" "$result"
}

# =============================================================================
# Golden Tests: injection_update --dry-run
# =============================================================================

@test "golden: injection_update dry-run" {
    cd "$TEST_DIR"

    # File doesn't exist
    local result
    result=$(injection_update "CLAUDE.md" "--dry-run" 2>/dev/null)
    [ $? -eq 0 ]
    compare_injection_golden "injection-update-dryrun.golden" "$result"

    # Verify file was NOT created
    [ ! -f "$TEST_DIR/CLAUDE.md" ]
}

# =============================================================================
# Golden Tests: injection_update_all - fresh project
# =============================================================================

@test "golden: injection_update_all fresh" {
    cd "$TEST_DIR"

    # No files exist - all should be created
    local result
    result=$(injection_update_all "." 2>/dev/null)
    [ $? -eq 0 ]
    compare_injection_golden "injection-update-all-fresh.golden" "$result"
}

# =============================================================================
# Golden Tests: injection_update_all - mixed (some current, some need update)
# =============================================================================

@test "golden: injection_update_all mixed" {
    cd "$TEST_DIR"

    # CLAUDE.md with current injection (should be skipped)
    cat > "$TEST_DIR/CLAUDE.md" << 'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
EOF

    # AGENTS.md without injection (should be added)
    echo "# Agents" > "$TEST_DIR/AGENTS.md"

    # GEMINI.md doesn't exist (should be created)

    local result
    result=$(injection_update_all "." 2>/dev/null)
    [ $? -eq 0 ]
    compare_injection_golden "injection-update-all-mixed.golden" "$result"
}

# =============================================================================
# Golden Tests: injection_get_summary
# =============================================================================

@test "golden: injection_get_summary mixed" {
    cd "$TEST_DIR"

    # Set up mixed state
    # CLAUDE.md - current
    cat > "$TEST_DIR/CLAUDE.md" << 'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
EOF

    # AGENTS.md - no injection
    echo "# Agents" > "$TEST_DIR/AGENTS.md"

    # GEMINI.md - missing

    local result
    result=$(injection_get_summary 2>/dev/null)
    [ $? -eq 0 ]
    compare_injection_golden "injection-summary-mixed.golden" "$result"
}

# =============================================================================
# Golden Tests: invalid target
# =============================================================================

@test "golden: injection_update invalid target" {
    cd "$TEST_DIR"

    # Try to update a file that's not in the registry
    # Use run to capture stderr and exit code properly
    run injection_update "README.md"
    [ "$status" -ne 0 ]  # Should fail with error
    compare_injection_golden "injection-update-invalid.golden" "$output"
}
