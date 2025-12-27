#!/usr/bin/env bats
# =============================================================================
# golden.bats - Golden File Tests for Output Regression Detection
# =============================================================================
# Compares command output against known-good "golden" files.
# Run with UPDATE_GOLDEN=1 to regenerate golden files.
# =============================================================================

# Get the directory containing this test file
GOLDEN_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
PROJECT_ROOT="$(cd "$GOLDEN_DIR/../.." && pwd)"
FIXTURES_DIR="$GOLDEN_DIR/fixtures"
EXPECTED_DIR="$GOLDEN_DIR/expected"

# Test fixture
GOLDEN_TODO_FILE="$FIXTURES_DIR/todo.json"

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    common_setup_per_test

    # Use BATS-managed temp directory (auto-cleaned)
    TEST_DIR="${BATS_TEST_TMPDIR}"
    mkdir -p "$TEST_DIR/.claude"

    # Copy fixture
    cp "$GOLDEN_TODO_FILE" "$TEST_DIR/.cleo/todo.json"

    # Create minimal config
    cat > "$TEST_DIR/.cleo/config.json" << 'EOF'
{"version": "0.8.2", "output": {"showColor": false, "showUnicode": true}}
EOF

    # Create empty log and archive
    echo '{"version": "0.8.2", "entries": []}' > "$TEST_DIR/.cleo/todo-log.json"
    echo '{"version": "0.8.2", "tasks": []}' > "$TEST_DIR/.cleo/todo-archive.json"

    # Set environment
    export TODO_FILE="$TEST_DIR/.cleo/todo.json"
    export CONFIG_FILE="$TEST_DIR/.cleo/config.json"
    export LOG_FILE="$TEST_DIR/.cleo/todo-log.json"
    export ARCHIVE_FILE="$TEST_DIR/.cleo/todo-archive.json"
    export NO_COLOR=1  # Disable colors for consistent output

    # Ensure expected directory exists
    mkdir -p "$EXPECTED_DIR"
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
# - Replace checksums with placeholder
# - Replace execution times with placeholder
# - Normalize paths
normalize_output() {
    sed -E \
        -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z?/TIMESTAMP/g' \
        -e 's/"timestamp":"[^"]+/"timestamp":"TIMESTAMP/g' \
        -e 's/"createdAt":"[^"]+/"createdAt":"TIMESTAMP/g' \
        -e 's/"completedAt":"[^"]+/"completedAt":"TIMESTAMP/g' \
        -e 's/"checksum":"[^"]+/"checksum":"CHECKSUM/g' \
        -e 's/checksum.*[a-f0-9]{16}/checksum: CHECKSUM/g' \
        -e 's/"execution_ms": *[0-9]+/"execution_ms": XXX/g' \
        -e 's/execution_ms":[0-9]+/execution_ms":XXX/g' \
        -e 's/[0-9]+ms/XXXms/g' \
        -e "s|$TEST_DIR|TESTDIR|g" \
        -e "s|$PROJECT_ROOT|PROJECT|g"
}

# Compare output with golden file
# Args: $1 = golden file name, $2 = actual output
compare_golden() {
    local golden_name="$1"
    local actual="$2"
    local golden_file="$EXPECTED_DIR/$golden_name"

    local normalized
    normalized=$(echo "$actual" | normalize_output)

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
# Golden Tests: list command
# =============================================================================

@test "golden: list --format text" {
    cd "$TEST_DIR"
    run "$PROJECT_ROOT/scripts/list-tasks.sh" --format text
    [ "$status" -eq 0 ]
    compare_golden "list-text.golden" "$output"
}

@test "golden: list --format json" {
    cd "$TEST_DIR"
    run "$PROJECT_ROOT/scripts/list-tasks.sh" --format json
    [ "$status" -eq 0 ]
    compare_golden "list-json.golden" "$output"
}

@test "golden: list --format jsonl" {
    cd "$TEST_DIR"
    run "$PROJECT_ROOT/scripts/list-tasks.sh" --format jsonl
    [ "$status" -eq 0 ]
    compare_golden "list-jsonl.golden" "$output"
}

@test "golden: list --status pending" {
    cd "$TEST_DIR"
    run "$PROJECT_ROOT/scripts/list-tasks.sh" --status pending --format text
    [ "$status" -eq 0 ]
    compare_golden "list-pending.golden" "$output"
}

@test "golden: list --compact" {
    cd "$TEST_DIR"
    run "$PROJECT_ROOT/scripts/list-tasks.sh" --compact
    [ "$status" -eq 0 ]
    compare_golden "list-compact.golden" "$output"
}

# =============================================================================
# Golden Tests: stats command
# =============================================================================

@test "golden: stats" {
    cd "$TEST_DIR"
    run "$PROJECT_ROOT/scripts/stats.sh"
    [ "$status" -eq 0 ]
    compare_golden "stats-text.golden" "$output"
}

# =============================================================================
# Golden Tests: labels command
# =============================================================================

@test "golden: labels" {
    cd "$TEST_DIR"
    run "$PROJECT_ROOT/scripts/labels.sh"
    [ "$status" -eq 0 ]
    compare_golden "labels-text.golden" "$output"
}

@test "golden: labels --format json" {
    cd "$TEST_DIR"
    run "$PROJECT_ROOT/scripts/labels.sh" --format json
    [ "$status" -eq 0 ]
    compare_golden "labels-json.golden" "$output"
}

# =============================================================================
# Golden Tests: phases command
# =============================================================================

@test "golden: phases" {
    cd "$TEST_DIR"
    run "$PROJECT_ROOT/scripts/phases.sh"
    [ "$status" -eq 0 ]
    compare_golden "phases-text.golden" "$output"
}

@test "golden: phases --format json" {
    cd "$TEST_DIR"
    run "$PROJECT_ROOT/scripts/phases.sh" --format json
    [ "$status" -eq 0 ]
    compare_golden "phases-json.golden" "$output"
}

@test "golden: phases stats" {
    cd "$TEST_DIR"
    run "$PROJECT_ROOT/scripts/phases.sh" stats
    [ "$status" -eq 0 ]
    compare_golden "phases-stats.golden" "$output"
}

# =============================================================================
# Golden Tests: dash command
# =============================================================================

@test "golden: dash --compact" {
    cd "$TEST_DIR"
    run "$PROJECT_ROOT/scripts/dash.sh" --compact
    [ "$status" -eq 0 ]
    compare_golden "dash-compact.golden" "$output"
}

# =============================================================================
# Golden Tests: deps command
# =============================================================================

@test "golden: deps tree" {
    cd "$TEST_DIR"
    run "$PROJECT_ROOT/scripts/deps-command.sh" tree
    [ "$status" -eq 0 ]
    compare_golden "deps-tree.golden" "$output"
}

# =============================================================================
# Golden Tests: blockers command
# =============================================================================

@test "golden: blockers" {
    cd "$TEST_DIR"
    run "$PROJECT_ROOT/scripts/blockers-command.sh"
    [ "$status" -eq 0 ]
    compare_golden "blockers-text.golden" "$output"
}

# =============================================================================
# Golden Tests: export command
# =============================================================================

@test "golden: export --format todowrite" {
    cd "$TEST_DIR"
    run "$PROJECT_ROOT/scripts/export.sh" --format todowrite
    [ "$status" -eq 0 ]
    compare_golden "export-todowrite.golden" "$output"
}

@test "golden: export --format csv" {
    cd "$TEST_DIR"
    run "$PROJECT_ROOT/scripts/export.sh" --format csv --status pending,active,blocked,done
    [ "$status" -eq 0 ]
    compare_golden "export-csv.golden" "$output"
}
