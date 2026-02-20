#!/usr/bin/env bats
# =============================================================================
# claude-migrate.bats - Unit tests for claude-migrate.sh
# =============================================================================
# Tests the CLEO migration detection and execution for T915-T918
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file

    # Override HOME to avoid affecting real user data
    export ORIGINAL_HOME="$HOME"
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    # Create isolated HOME for each test
    export HOME="${TEST_TEMP_DIR}/home"
    mkdir -p "$HOME"

    # Remove any .cleo created by common_setup - migration tests need clean slate
    rm -rf "${TEST_TEMP_DIR}/.cleo" 2>/dev/null || true

    # Suppress migration warnings
    export _CLEO_MIGRATION_WARNING_SHOWN=1

    # Clear legacy env vars
    unset CLAUDE_TODO_HOME CLAUDE_TODO_DIR CLAUDE_TODO_FORMAT CLAUDE_TODO_DEBUG 2>/dev/null || true
}

teardown() {
    common_teardown_per_test
    export HOME="$ORIGINAL_HOME"
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Help and Basic Command Tests
# =============================================================================

@test "claude-migrate --help shows usage" {
    run "$SCRIPTS_DIR/claude-migrate.sh" --help
    assert_success
    assert_output --partial "Usage: cleo claude-migrate"
    assert_output --partial "--check"
    assert_output --partial "--global"
    assert_output --partial "--project"
    assert_output --partial "--all"
}

@test "claude-migrate -h shows usage" {
    run "$SCRIPTS_DIR/claude-migrate.sh" -h
    assert_success
    assert_output --partial "Usage: cleo claude-migrate"
}

@test "claude-migrate without mode shows error" {
    run "$SCRIPTS_DIR/claude-migrate.sh"
    assert_failure
    assert_output --partial "Must specify --check, --global, --project, or --all"
}

@test "claude-migrate with unknown option shows error" {
    run "$SCRIPTS_DIR/claude-migrate.sh" --invalid
    assert_failure
    assert_output --partial "Unknown option"
}

# =============================================================================
# CHECK MODE - NO LEGACY
# =============================================================================

@test "claude-migrate --check exits 1 when no legacy found" {
    # Ensure no legacy directories exist
    rm -rf "$HOME/.claude-todo" 2>/dev/null || true

    # Work in temp dir with no .claude
    cd "$TEST_TEMP_DIR"
    rm -rf ".claude" 2>/dev/null || true

    run "$SCRIPTS_DIR/claude-migrate.sh" --check
    assert_failure 1  # Exit code 1 = no legacy found
}

@test "claude-migrate --check --format json returns valid JSON when no legacy" {
    rm -rf "$HOME/.claude-todo" 2>/dev/null || true
    cd "$TEST_TEMP_DIR"
    rm -rf ".claude" 2>/dev/null || true

    run "$SCRIPTS_DIR/claude-migrate.sh" --check --format json
    assert_failure 1  # No legacy found

    # Store output for multiple jq checks
    local json_output="$output"

    # Verify JSON structure
    jq -e '.migrationNeeded == false' <<< "$json_output"
    jq -e '.global.found == false' <<< "$json_output"
    jq -e '.project.found == false' <<< "$json_output"
}

@test "claude-migrate --check text output shows clean state" {
    rm -rf "$HOME/.claude-todo" 2>/dev/null || true
    cd "$TEST_TEMP_DIR"
    rm -rf ".claude" 2>/dev/null || true

    run "$SCRIPTS_DIR/claude-migrate.sh" --check --format text
    assert_failure 1
    assert_output --partial "No migration needed"
}

# =============================================================================
# CHECK MODE - LEGACY GLOBAL
# =============================================================================

@test "claude-migrate --check exits 0 when legacy global found" {
    # Create legacy global directory
    mkdir -p "$HOME/.claude-todo"
    touch "$HOME/.claude-todo/todo.json"

    cd "$TEST_TEMP_DIR"
    run "$SCRIPTS_DIR/claude-migrate.sh" --check
    assert_success  # Exit code 0 = legacy found
}

@test "claude-migrate --check --format json detects legacy global" {
    mkdir -p "$HOME/.claude-todo"
    echo '{"tasks":[]}' > "$HOME/.claude-todo/todo.json"

    cd "$TEST_TEMP_DIR"
    run "$SCRIPTS_DIR/claude-migrate.sh" --check --format json
    assert_success

    # Store output for multiple jq checks
    local json_output="$output"

    # Verify JSON structure
    jq -e '.migrationNeeded == true' <<< "$json_output"
    jq -e '.global.found == true' <<< "$json_output"
    jq -e '.global.hasTodo == true' <<< "$json_output"
}

@test "claude-migrate --check detects legacy global config" {
    mkdir -p "$HOME/.claude-todo"
    echo '{}' > "$HOME/.claude-todo/todo-config.json"

    cd "$TEST_TEMP_DIR"
    run "$SCRIPTS_DIR/claude-migrate.sh" --check --format json
    assert_success

    local json_output="$output"
    jq -e '.global.hasConfig == true' <<< "$json_output"
}

# =============================================================================
# CHECK MODE - LEGACY PROJECT
# =============================================================================

@test "claude-migrate --check exits 0 when legacy project found" {
    # Create legacy project directory in temp location
    cd "$TEST_TEMP_DIR"
    mkdir -p ".claude"
    touch ".claude/todo.json"

    run "$SCRIPTS_DIR/claude-migrate.sh" --check
    assert_success
}

@test "claude-migrate --check --format json detects legacy project" {
    cd "$TEST_TEMP_DIR"
    mkdir -p ".claude"
    echo '{"tasks":[]}' > ".claude/todo.json"

    run "$SCRIPTS_DIR/claude-migrate.sh" --check --format json
    assert_success

    local json_output="$output"
    jq -e '.migrationNeeded == true' <<< "$json_output"
    jq -e '.project.found == true' <<< "$json_output"
    jq -e '.project.hasTodo == true' <<< "$json_output"
}

@test "claude-migrate --check detects legacy project with all files" {
    cd "$TEST_TEMP_DIR"
    mkdir -p ".claude"
    echo '{}' > ".claude/todo.json"
    echo '{}' > ".claude/todo-config.json"
    echo '[]' > ".claude/todo-log.json"
    echo '{"archived":[]}' > ".claude/todo-archive.json"

    run "$SCRIPTS_DIR/claude-migrate.sh" --check --format json
    assert_success

    local json_output="$output"
    jq -e '.project.hasTodo == true' <<< "$json_output"
    jq -e '.project.hasConfig == true' <<< "$json_output"
    jq -e '.project.hasLog == true' <<< "$json_output"
    jq -e '.project.hasArchive == true' <<< "$json_output"
}

# =============================================================================
# CHECK MODE - LEGACY ENVIRONMENT
# =============================================================================

@test "claude-migrate --check detects CLAUDE_TODO_HOME" {
    export CLAUDE_TODO_HOME="/old/path"

    cd "$TEST_TEMP_DIR"
    run "$SCRIPTS_DIR/claude-migrate.sh" --check --format json
    # Note: env detection alone triggers legacy found
    assert_success

    local json_output="$output"
    jq -e '.environment.found == true' <<< "$json_output"

    unset CLAUDE_TODO_HOME
}

@test "claude-migrate --check detects multiple legacy env vars" {
    export CLAUDE_TODO_HOME="/old/path"
    export CLAUDE_TODO_FORMAT="json"

    cd "$TEST_TEMP_DIR"
    run "$SCRIPTS_DIR/claude-migrate.sh" --check --format json
    assert_success

    local json_output="$output"
    jq -e '.environment.count >= 2' <<< "$json_output"

    unset CLAUDE_TODO_HOME CLAUDE_TODO_FORMAT
}

@test "claude-migrate --check shows clean env when no legacy vars" {
    unset CLAUDE_TODO_HOME CLAUDE_TODO_DIR CLAUDE_TODO_FORMAT CLAUDE_TODO_DEBUG 2>/dev/null || true

    cd "$TEST_TEMP_DIR"
    rm -rf ".claude" "$HOME/.claude-todo" 2>/dev/null || true

    run "$SCRIPTS_DIR/claude-migrate.sh" --check --format json
    # No legacy at all

    local json_output="$output"
    jq -e '.environment.found == false' <<< "$json_output"
}

# =============================================================================
# CHECK MODE - COMBINED DETECTION
# =============================================================================

@test "claude-migrate --check detects both global and project legacy" {
    mkdir -p "$HOME/.claude-todo"
    echo '{}' > "$HOME/.claude-todo/todo.json"

    cd "$TEST_TEMP_DIR"
    mkdir -p ".claude"
    echo '{}' > ".claude/todo.json"

    run "$SCRIPTS_DIR/claude-migrate.sh" --check --format json
    assert_success

    local json_output="$output"
    jq -e '.global.found == true' <<< "$json_output"
    jq -e '.project.found == true' <<< "$json_output"
}

# =============================================================================
# GLOBAL MIGRATION MODE (T916)
# =============================================================================

@test "claude-migrate --global exits 1 when no legacy found" {
    rm -rf "$HOME/.claude-todo" 2>/dev/null || true
    cd "$TEST_TEMP_DIR"

    run "$SCRIPTS_DIR/claude-migrate.sh" --global
    assert_failure 1  # No legacy
    assert_output --partial "No legacy global installation"
}

@test "claude-migrate --global migrates ~/.claude-todo to ~/.cleo" {
    # Create legacy installation
    mkdir -p "$HOME/.claude-todo"
    echo '{"tasks":[]}' > "$HOME/.claude-todo/todo.json"
    echo '{}' > "$HOME/.claude-todo/todo-config.json"

    cd "$TEST_TEMP_DIR"
    run "$SCRIPTS_DIR/claude-migrate.sh" --global --format text
    assert_success

    # Verify migration (config files renamed: todo-config.json → config.json)
    [[ -d "$HOME/.cleo" ]]
    [[ -f "$HOME/.cleo/todo.json" ]]
    [[ -f "$HOME/.cleo/config.json" ]]
    [[ ! -d "$HOME/.claude-todo" ]]
}

@test "claude-migrate --global creates backup before migration" {
    mkdir -p "$HOME/.claude-todo"
    echo '{"tasks":[]}' > "$HOME/.claude-todo/todo.json"

    cd "$TEST_TEMP_DIR"
    run "$SCRIPTS_DIR/claude-migrate.sh" --global --format text
    assert_success

    # Check backup was created
    assert_output --partial "Backup created"
    [[ -d "$HOME/.cleo/backups/migration" ]]
    local backup_count
    backup_count=$(ls "$HOME/.cleo/backups/migration"/*.tar.gz 2>/dev/null | wc -l)
    [[ "$backup_count" -gt 0 ]]
}

@test "claude-migrate --global returns JSON on success" {
    mkdir -p "$HOME/.claude-todo"
    echo '{"tasks":[]}' > "$HOME/.claude-todo/todo.json"

    cd "$TEST_TEMP_DIR"
    run "$SCRIPTS_DIR/claude-migrate.sh" --global --format json
    assert_success

    local json_output="$output"
    jq -e '.success == true' <<< "$json_output"
    jq -e '.migration.type == "global"' <<< "$json_output"
    jq -e '.migration.fileCount >= 1' <<< "$json_output"
}

@test "claude-migrate --global fails if target already has data" {
    # Create both legacy and target with data
    mkdir -p "$HOME/.claude-todo"
    echo '{}' > "$HOME/.claude-todo/todo.json"
    mkdir -p "$HOME/.cleo"
    echo '{}' > "$HOME/.cleo/existing-data.json"

    cd "$TEST_TEMP_DIR"
    run "$SCRIPTS_DIR/claude-migrate.sh" --global --format text
    assert_failure 4  # Validation failed
    assert_output --partial "already exists"
}

@test "claude-migrate --global preserves all files during migration" {
    # Create legacy with multiple files
    mkdir -p "$HOME/.claude-todo/subdir"
    echo 'todo' > "$HOME/.claude-todo/todo.json"
    echo 'config' > "$HOME/.claude-todo/todo-config.json"
    echo 'log' > "$HOME/.claude-todo/todo-log.json"
    echo 'nested' > "$HOME/.claude-todo/subdir/file.txt"

    cd "$TEST_TEMP_DIR"
    run "$SCRIPTS_DIR/claude-migrate.sh" --global
    assert_success

    # Verify all files present (config renamed, log unchanged)
    [[ -f "$HOME/.cleo/todo.json" ]]
    [[ -f "$HOME/.cleo/config.json" ]]
    [[ -f "$HOME/.cleo/todo-log.json" ]]
    [[ -f "$HOME/.cleo/subdir/file.txt" ]]

    # Verify content preserved
    [[ "$(cat "$HOME/.cleo/todo.json")" == "todo" ]]
    [[ "$(cat "$HOME/.cleo/subdir/file.txt")" == "nested" ]]
}

# =============================================================================
# PROJECT MIGRATION MODE (T917)
# =============================================================================

@test "claude-migrate --project exits 1 when no legacy found" {
    cd "$TEST_TEMP_DIR"
    rm -rf ".claude" 2>/dev/null || true

    run "$SCRIPTS_DIR/claude-migrate.sh" --project
    assert_failure 1
    assert_output --partial "No legacy project directory"
}

@test "claude-migrate --project migrates .claude to .cleo" {
    cd "$TEST_TEMP_DIR"
    mkdir -p ".claude"
    echo '{"tasks":[]}' > ".claude/todo.json"
    echo '{}' > ".claude/todo-config.json"

    run "$SCRIPTS_DIR/claude-migrate.sh" --project --format text
    assert_success

    # Verify migration
    [[ -d ".cleo" ]]
    [[ -f ".cleo/todo.json" ]]
    [[ ! -d ".claude" ]]
}

@test "claude-migrate --project renames config files" {
    cd "$TEST_TEMP_DIR"
    mkdir -p ".claude"
    echo '{}' > ".claude/todo.json"
    echo '{}' > ".claude/todo-config.json"
    echo '[]' > ".claude/todo-log.json"

    run "$SCRIPTS_DIR/claude-migrate.sh" --project --format text
    assert_success

    # Verify config renamed, log unchanged
    [[ -f ".cleo/config.json" ]]
    [[ -f ".cleo/todo-log.json" ]]
    [[ ! -f ".cleo/todo-config.json" ]]
}

@test "claude-migrate --project updates .gitignore" {
    cd "$TEST_TEMP_DIR"
    mkdir -p ".claude"
    echo '{}' > ".claude/todo.json"
    echo -e ".claude/\n.claude/*.json" > ".gitignore"

    run "$SCRIPTS_DIR/claude-migrate.sh" --project --format text
    assert_success

    # Verify .gitignore updated
    grep -q "\.cleo/" ".gitignore"
    grep -q "\.cleo/\*.json" ".gitignore"
    ! grep -q "\.claude/" ".gitignore"
}

@test "claude-migrate --project returns JSON on success" {
    cd "$TEST_TEMP_DIR"
    mkdir -p ".claude"
    echo '{"tasks":[]}' > ".claude/todo.json"
    echo '{}' > ".claude/todo-config.json"

    run "$SCRIPTS_DIR/claude-migrate.sh" --project --format json
    assert_success

    local json_output="$output"
    jq -e '.success == true' <<< "$json_output"
    jq -e '.migration.type == "project"' <<< "$json_output"
    jq -e '.migration.configsRenamed >= 1' <<< "$json_output"
}

@test "claude-migrate --project fails if target already has data" {
    cd "$TEST_TEMP_DIR"
    mkdir -p ".claude"
    echo '{}' > ".claude/todo.json"
    mkdir -p ".cleo"
    echo '{}' > ".cleo/existing.json"

    run "$SCRIPTS_DIR/claude-migrate.sh" --project --format text
    assert_failure 4
    assert_output --partial "already exists"
}

@test "claude-migrate --project preserves all files" {
    cd "$TEST_TEMP_DIR"
    mkdir -p ".claude/subdir"
    echo 'todo' > ".claude/todo.json"
    echo 'archive' > ".claude/todo-archive.json"
    echo 'nested' > ".claude/subdir/data.json"

    run "$SCRIPTS_DIR/claude-migrate.sh" --project
    assert_success

    # Verify CLEO files migrated
    [[ -f ".cleo/todo.json" ]]
    [[ -f ".cleo/todo-archive.json" ]]
    [[ "$(cat ".cleo/todo.json")" == "todo" ]]

    # Verify non-CLEO files preserved in .claude/
    [[ -d ".claude" ]]
    [[ -f ".claude/subdir/data.json" ]]
}

# =============================================================================
# ALL MIGRATION MODE (T918)
# =============================================================================

@test "claude-migrate --all exits 1 when no legacy found" {
    rm -rf "$HOME/.claude-todo" 2>/dev/null || true
    cd "$TEST_TEMP_DIR"
    rm -rf ".claude" 2>/dev/null || true

    run "$SCRIPTS_DIR/claude-migrate.sh" --all
    assert_failure 1
    assert_output --partial "No legacy installations"
}

@test "claude-migrate --all migrates both global and project" {
    # Create both legacy installations
    mkdir -p "$HOME/.claude-todo"
    echo '{"tasks":[]}' > "$HOME/.claude-todo/todo.json"

    cd "$TEST_TEMP_DIR"
    mkdir -p ".claude"
    echo '{"tasks":[]}' > ".claude/todo.json"

    run "$SCRIPTS_DIR/claude-migrate.sh" --all --format text
    assert_success

    # Verify both migrated
    [[ -d "$HOME/.cleo" ]]
    [[ -f "$HOME/.cleo/todo.json" ]]
    [[ ! -d "$HOME/.claude-todo" ]]

    [[ -d ".cleo" ]]
    [[ -f ".cleo/todo.json" ]]
    [[ ! -d ".claude" ]]
}

@test "claude-migrate --all migrates only global if no project legacy" {
    mkdir -p "$HOME/.claude-todo"
    echo '{}' > "$HOME/.claude-todo/todo.json"

    cd "$TEST_TEMP_DIR"
    rm -rf ".claude" 2>/dev/null || true

    run "$SCRIPTS_DIR/claude-migrate.sh" --all --format text
    assert_success

    [[ -d "$HOME/.cleo" ]]
    [[ ! -d ".cleo" ]]
}

@test "claude-migrate --all migrates only project if no global legacy" {
    rm -rf "$HOME/.claude-todo" 2>/dev/null || true

    cd "$TEST_TEMP_DIR"
    mkdir -p ".claude"
    echo '{}' > ".claude/todo.json"

    run "$SCRIPTS_DIR/claude-migrate.sh" --all --format text
    assert_success

    [[ ! -d "$HOME/.cleo" ]]
    [[ -d ".cleo" ]]
}

@test "claude-migrate --all returns JSON with both migrations" {
    mkdir -p "$HOME/.claude-todo"
    echo '{}' > "$HOME/.claude-todo/todo.json"

    cd "$TEST_TEMP_DIR"
    mkdir -p ".claude"
    echo '{}' > ".claude/todo.json"

    run "$SCRIPTS_DIR/claude-migrate.sh" --all --format json
    assert_success

    local json_output="$output"
    # The JSON output will include both migration outputs plus summary
    # Check that both migrations ran by verifying files exist
    [[ -d "$HOME/.cleo" ]]
    [[ -d ".cleo" ]]
}

@test "claude-migrate --all shows summary" {
    mkdir -p "$HOME/.claude-todo"
    echo '{}' > "$HOME/.claude-todo/todo.json"

    cd "$TEST_TEMP_DIR"
    mkdir -p ".claude"
    echo '{}' > ".claude/todo.json"

    run "$SCRIPTS_DIR/claude-migrate.sh" --all --format text
    assert_success
    assert_output --partial "Migration Summary"
}

# =============================================================================
# VERBOSE MODE
# =============================================================================

@test "claude-migrate --check --verbose shows extra details" {
    mkdir -p "$HOME/.claude-todo"
    touch "$HOME/.claude-todo/todo.json"

    cd "$TEST_TEMP_DIR"
    run "$SCRIPTS_DIR/claude-migrate.sh" --check --format text --verbose
    assert_success
    assert_output --partial "Run: cleo claude-migrate"
}

@test "claude-migrate --check -v works as verbose shorthand" {
    mkdir -p "$HOME/.claude-todo"
    touch "$HOME/.claude-todo/todo.json"

    cd "$TEST_TEMP_DIR"
    run "$SCRIPTS_DIR/claude-migrate.sh" --check --format text -v
    assert_success
    assert_output --partial "Run: cleo claude-migrate"
}
