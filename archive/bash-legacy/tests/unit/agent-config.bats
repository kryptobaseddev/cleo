#!/usr/bin/env bats
# tests/unit/agent-config.bats - Agent config registry management tests

load '../libs/bats-support/load'
load '../libs/bats-assert/load'

setup() {
    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    export CLEO_HOME="$TEST_DIR/.cleo"
    export CLEO_LIB_DIR="$CLEO_HOME/lib"

    # Create necessary directories
    mkdir -p "$CLEO_HOME/lib"
    mkdir -p "$CLEO_HOME/schemas"
    mkdir -p "$TEST_DIR/.claude"
    mkdir -p "$TEST_DIR/.gemini"

    # Copy required libraries
    cp "$BATS_TEST_DIRNAME/../../lib/ui/injection-registry.sh" "$CLEO_LIB_DIR/"
    cp "$BATS_TEST_DIRNAME/../../lib/skills/agent-config.sh" "$CLEO_LIB_DIR/"

    # Copy required schemas
    cp "$BATS_TEST_DIRNAME/../../schemas/agent-registry.json" "$CLEO_HOME/schemas/"

    # Override HOME for testing
    export HOME="$TEST_DIR"

    # Source library
    source "$CLEO_LIB_DIR/agent-config.sh"
}

teardown() {
    rm -rf "$TEST_DIR"
}

# ==============================================================================
# AGENT NAME DETECTION
# ==============================================================================

@test "get_agent_name_from_path detects claude from ~/.claude/CLAUDE.md" {
    run get_agent_name_from_path "$HOME/.claude/CLAUDE.md"
    assert_success
    assert_output "claude-code"
}

@test "get_agent_name_from_path detects gemini from ~/.gemini/GEMINI.md" {
    run get_agent_name_from_path "$HOME/.gemini/GEMINI.md"
    assert_success
    assert_output "gemini"
}

@test "get_agent_name_from_path detects codex from ~/.codex/AGENTS.md" {
    mkdir -p "$HOME/.codex"
    run get_agent_name_from_path "$HOME/.codex/AGENTS.md"
    assert_success
    assert_output "codex"
}

@test "get_agent_name_from_path returns empty for non-agent path" {
    run get_agent_name_from_path "$HOME/random/CLAUDE.md"
    assert_success
    assert_output ""
}

# ==============================================================================
# CLI INSTALLATION DETECTION
# ==============================================================================

@test "is_agent_cli_installed returns success for existing directory" {
    mkdir -p "$HOME/.claude"
    run is_agent_cli_installed "claude"
    assert_success
}

@test "is_agent_cli_installed returns failure for missing directory" {
    run is_agent_cli_installed "codex"
    assert_failure
}

# ==============================================================================
# CONFIG PATH CONSTRUCTION
# ==============================================================================

@test "get_agent_config_path returns correct path for claude" {
    run get_agent_config_path "claude"
    assert_success
    assert_output "$HOME/.claude/CLAUDE.md"
}

@test "get_agent_config_path returns correct path for gemini" {
    run get_agent_config_path "gemini"
    assert_success
    assert_output "$HOME/.gemini/GEMINI.md"
}

@test "get_agent_config_path returns correct path for codex" {
    run get_agent_config_path "codex"
    assert_success
    assert_output "$HOME/.codex/AGENTS.md"
}

# ==============================================================================
# VERSION EXTRACTION
# ==============================================================================

@test "get_agent_config_version extracts version from file" {
    local test_file="$HOME/.claude/CLAUDE.md"
    mkdir -p "$(dirname "$test_file")"
    cat > "$test_file" <<'EOF'
<!-- CLEO:START v0.50.2 -->
Task management content
<!-- CLEO:END -->
EOF

    run get_agent_config_version "$test_file"
    assert_success
    assert_output "0.50.2"
}

@test "get_agent_config_version returns empty for file without version" {
    local test_file="$HOME/.claude/CLAUDE.md"
    mkdir -p "$(dirname "$test_file")"
    echo "No version marker" > "$test_file"

    run get_agent_config_version "$test_file"
    assert_success
    assert_output ""
}

@test "get_agent_config_version returns failure for missing file" {
    run get_agent_config_version "$HOME/.claude/NONEXISTENT.md"
    assert_failure
}

# ==============================================================================
# REGISTRY CREATION
# ==============================================================================

@test "create_empty_agent_registry creates valid JSON" {
    run create_empty_agent_registry
    assert_success
    assert [ -f "$AGENT_CONFIG_REGISTRY" ]

    # Validate JSON structure
    run jq -e '.schemaVersion' "$AGENT_CONFIG_REGISTRY"
    assert_success
    assert_output '"1.0.0"'

    run jq -e '.configs' "$AGENT_CONFIG_REGISTRY"
    assert_success
    assert_output '{}'
}

@test "init_agent_config_registry creates registry if missing" {
    run init_agent_config_registry
    assert_success
    assert [ -f "$AGENT_CONFIG_REGISTRY" ]
}

@test "init_agent_config_registry does not overwrite existing registry" {
    # Create initial registry
    create_empty_agent_registry
    local initial_timestamp
    initial_timestamp=$(jq -r '.lastUpdated' "$AGENT_CONFIG_REGISTRY")

    sleep 1

    # Run init again
    run init_agent_config_registry
    assert_success

    # Timestamp should be unchanged
    local final_timestamp
    final_timestamp=$(jq -r '.lastUpdated' "$AGENT_CONFIG_REGISTRY")
    assert_equal "$initial_timestamp" "$final_timestamp"
}

# ==============================================================================
# REGISTRY UPDATE
# ==============================================================================

@test "update_agent_config_registry adds new entry" {
    local config_path="$HOME/.claude/CLAUDE.md"
    mkdir -p "$(dirname "$config_path")"
    touch "$config_path"

    run update_agent_config_registry "$config_path" "0.50.2"
    assert_success

    # Verify entry exists (using config path as key)
    run jq -e ".configs[\"$config_path\"]" "$AGENT_CONFIG_REGISTRY"
    assert_success

    # Verify version
    run jq -r ".configs[\"$config_path\"].version" "$AGENT_CONFIG_REGISTRY"
    assert_output "0.50.2"
}

@test "update_agent_config_registry updates existing entry" {
    local config_path="$HOME/.claude/CLAUDE.md"
    mkdir -p "$(dirname "$config_path")"
    touch "$config_path"

    # Add initial entry
    update_agent_config_registry "$config_path" "0.50.1"

    # Update with new version
    run update_agent_config_registry "$config_path" "0.50.2"
    assert_success

    # Verify updated version
    run jq -r ".configs[\"$config_path\"].version" "$AGENT_CONFIG_REGISTRY"
    assert_output "0.50.2"
}

@test "update_agent_config_registry sets status to current" {
    local config_path="$HOME/.gemini/GEMINI.md"
    mkdir -p "$(dirname "$config_path")"
    touch "$config_path"

    run update_agent_config_registry "$config_path" "0.50.2"
    assert_success

    run jq -r ".configs[\"$config_path\"].status" "$AGENT_CONFIG_REGISTRY"
    assert_output "current"
}

# ==============================================================================
# REGISTRY VALIDATION
# ==============================================================================

@test "validate_agent_config_registry succeeds for valid registry" {
    create_empty_agent_registry
    run validate_agent_config_registry
    assert_success
}

@test "validate_agent_config_registry fails for invalid JSON" {
    mkdir -p "$CLEO_HOME"
    echo "invalid json {" > "$AGENT_CONFIG_REGISTRY"

    run validate_agent_config_registry
    assert_failure
}

@test "validate_agent_config_registry fails for missing required fields" {
    mkdir -p "$CLEO_HOME"
    echo '{"schemaVersion": "1.0.0", "lastUpdated": "2026-01-04T00:00:00Z"}' > "$AGENT_CONFIG_REGISTRY"

    run validate_agent_config_registry
    assert_failure
}

@test "validate_agent_config_registry succeeds when registry does not exist" {
    run validate_agent_config_registry
    assert_success
}

# ==============================================================================
# REGISTRY QUERIES
# ==============================================================================

@test "is_agent_registered returns success for registered agent" {
    local config_path="$HOME/.claude/CLAUDE.md"
    mkdir -p "$(dirname "$config_path")"
    touch "$config_path"
    update_agent_config_registry "$config_path" "0.50.2"

    run is_agent_registered "claude"
    assert_success
}

@test "is_agent_registered returns failure for unregistered agent" {
    create_empty_agent_registry

    run is_agent_registered "claude"
    assert_failure
}

@test "is_agent_registered returns failure when registry missing" {
    run is_agent_registered "claude"
    assert_failure
}

@test "get_agent_config_data returns agent object" {
    local config_path="$HOME/.claude/CLAUDE.md"
    mkdir -p "$(dirname "$config_path")"
    touch "$config_path"
    update_agent_config_registry "$config_path" "0.50.2"

    run get_agent_config_data "claude"
    assert_success

    # Verify JSON contains expected fields
    local version
    version=$(echo "$output" | jq -r '.version')
    assert_equal "$version" "0.50.2"

    local agent_type
    agent_type=$(echo "$output" | jq -r '.agentType')
    assert_equal "$agent_type" "claude-code"
}

@test "get_agent_config_data returns empty object for missing agent" {
    create_empty_agent_registry

    run get_agent_config_data "nonexistent"
    assert_success
    assert_output "{}"
}

@test "list_agent_configs returns array of agents" {
    # Add multiple agents
    local claude_path="$HOME/.claude/CLAUDE.md"
    local gemini_path="$HOME/.gemini/GEMINI.md"

    mkdir -p "$(dirname "$claude_path")" "$(dirname "$gemini_path")"
    touch "$claude_path" "$gemini_path"

    update_agent_config_registry "$claude_path" "0.50.2"
    update_agent_config_registry "$gemini_path" "0.50.2"

    run list_agent_configs
    assert_success

    # Verify it's an array with 2 elements
    local count
    count=$(echo "$output" | jq '. | length')
    assert_equal "$count" "2"

    # Verify each entry has a path field
    local has_path
    has_path=$(echo "$output" | jq '.[0] | has("path")')
    assert_equal "$has_path" "true"
}

@test "list_agent_configs returns empty array when registry missing" {
    run list_agent_configs
    assert_success
    assert_output "[]"
}
