#!/usr/bin/env bats
# Tests for lib/mcp-config.sh and scripts/mcp-install.sh

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
    export MCP_CONFIG_LIB="$LIB_DIR/mcp-config.sh"
    export MCP_INSTALL_SCRIPT="$SCRIPTS_DIR/mcp-install.sh"
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    # Source the library
    source "$MCP_CONFIG_LIB"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# ============================================================================
# TOOL REGISTRY
# ============================================================================

@test "mcp_get_tool_keys returns all 12 tools" {
    local count
    count=$(mcp_get_tool_keys | wc -l)
    [[ "$count" -eq 12 ]]
}

@test "mcp_get_tool_keys includes claude-code" {
    run mcp_get_tool_keys
    assert_output --partial "claude-code"
}

@test "mcp_get_tool_keys includes codex" {
    run mcp_get_tool_keys
    assert_output --partial "codex"
}

@test "mcp_get_tool_display_name returns correct name" {
    run mcp_get_tool_display_name "claude-code"
    assert_output "Claude Code"
}

@test "mcp_get_tool_display_name returns correct name for cursor" {
    run mcp_get_tool_display_name "cursor"
    assert_output "Cursor"
}

@test "mcp_get_tool_format returns standard for claude-code" {
    run mcp_get_tool_format "claude-code"
    assert_output "standard"
}

@test "mcp_get_tool_format returns opencode for opencode" {
    run mcp_get_tool_format "opencode"
    assert_output "opencode"
}

@test "mcp_get_tool_format returns codex for codex" {
    run mcp_get_tool_format "codex"
    assert_output "codex"
}

@test "mcp_get_tool_format returns vscode for vscode" {
    run mcp_get_tool_format "vscode"
    assert_output "vscode"
}

@test "mcp_get_tool_format returns zed for zed" {
    run mcp_get_tool_format "zed"
    assert_output "zed"
}

@test "mcp_get_tool_config_key returns mcpServers for standard tools" {
    run mcp_get_tool_config_key "claude-code"
    assert_output "mcpServers"
}

@test "mcp_get_tool_config_key returns mcp for opencode" {
    run mcp_get_tool_config_key "opencode"
    assert_output "mcp"
}

@test "mcp_get_tool_config_key returns servers for vscode" {
    run mcp_get_tool_config_key "vscode"
    assert_output "servers"
}

# ============================================================================
# PATH RESOLUTION
# ============================================================================

@test "mcp_get_config_path returns .mcp.json for claude-code project" {
    run mcp_get_config_path "claude-code" "project"
    assert_output ".mcp.json"
}

@test "mcp_get_config_path returns global path for claude-code global" {
    run mcp_get_config_path "claude-code" "global"
    assert_output "$HOME/.claude.json"
}

@test "mcp_get_config_path returns project path for vscode project" {
    run mcp_get_config_path "vscode" "project"
    assert_output ".vscode/mcp.json"
}

@test "mcp_get_config_path returns cursor global path" {
    run mcp_get_config_path "cursor" "global"
    assert_output "$HOME/.cursor/mcp.json"
}

@test "mcp_has_dual_scope returns 0 for claude-code" {
    mcp_has_dual_scope "claude-code"
}

@test "mcp_has_dual_scope returns 0 for vscode" {
    mcp_has_dual_scope "vscode"
}

@test "mcp_has_dual_scope returns 0 for gemini-cli" {
    mcp_has_dual_scope "gemini-cli"
}

@test "mcp_has_dual_scope returns 0 for opencode" {
    mcp_has_dual_scope "opencode"
}

@test "mcp_has_dual_scope returns 0 for codex" {
    mcp_has_dual_scope "codex"
}

@test "mcp_get_tool_display_name returns correct name for goose" {
    run mcp_get_tool_display_name "goose"
    assert_output "Goose"
}

@test "mcp_get_tool_format returns goose for goose" {
    run mcp_get_tool_format "goose"
    assert_output "goose"
}

@test "mcp_has_dual_scope returns 0 for goose" {
    mcp_has_dual_scope "goose"
}

@test "mcp_has_dual_scope returns 0 for zed" {
    mcp_has_dual_scope "zed"
}

@test "mcp_get_config_path returns .opencode.json for opencode project" {
    run mcp_get_config_path "opencode" "project"
    assert_output ".opencode.json"
}

@test "mcp_get_config_path returns .gemini/settings.json for gemini-cli project" {
    run mcp_get_config_path "gemini-cli" "project"
    assert_output ".gemini/settings.json"
}

@test "mcp_get_config_path returns .zed/settings.json for zed project" {
    run mcp_get_config_path "zed" "project"
    assert_output ".zed/settings.json"
}

@test "mcp_get_config_path returns .goose/config.yaml for goose project" {
    run mcp_get_config_path "goose" "project"
    assert_output ".goose/config.yaml"
}

# ============================================================================
# CONFIG GENERATION
# ============================================================================

@test "mcp_generate_entry npx mode produces correct JSON" {
    run mcp_generate_entry "npx"
    assert_success
    local command args
    command=$(echo "$output" | jq -r '.command')
    args=$(echo "$output" | jq -r '.args[0]')
    [[ "$command" == "npx" ]]
    [[ "$args" == "-y" ]]
    local pkg
    pkg=$(echo "$output" | jq -r '.args[1]')
    [[ "$pkg" == "@cleocode/mcp-server" ]]
}

@test "mcp_generate_entry local mode produces correct JSON" {
    run mcp_generate_entry "local" "/tmp/test-project"
    assert_success
    local command path
    command=$(echo "$output" | jq -r '.command')
    path=$(echo "$output" | jq -r '.args[0]')
    [[ "$command" == "node" ]]
    [[ "$path" == "/tmp/test-project/mcp-server/dist/index.js" ]]
}

# ============================================================================
# MERGE: STANDARD FORMAT
# ============================================================================

@test "merge standard: creates new config from empty" {
    local entry
    entry=$(mcp_generate_entry "npx")
    local result
    result=$(_mcp_merge_standard "" "$entry" "mcpServers")

    local has_key
    has_key=$(echo "$result" | jq 'has("mcpServers")')
    [[ "$has_key" == "true" ]]

    local command
    command=$(echo "$result" | jq -r '.mcpServers.cleo.command')
    [[ "$command" == "npx" ]]
}

@test "merge standard: preserves existing entries" {
    local existing='{"mcpServers":{"other":{"command":"node","args":["other.js"]}}}'
    local entry
    entry=$(mcp_generate_entry "npx")
    local result
    result=$(_mcp_merge_standard "$existing" "$entry" "mcpServers")

    # Check both entries exist
    local other_cmd cleo_cmd
    other_cmd=$(echo "$result" | jq -r '.mcpServers.other.command')
    cleo_cmd=$(echo "$result" | jq -r '.mcpServers.cleo.command')
    [[ "$other_cmd" == "node" ]]
    [[ "$cleo_cmd" == "npx" ]]
}

@test "merge standard: updates existing cleo entry" {
    local existing='{"mcpServers":{"cleo":{"command":"node","args":["old.js"]}}}'
    local entry
    entry=$(mcp_generate_entry "npx")
    local result
    result=$(_mcp_merge_standard "$existing" "$entry" "mcpServers")

    local command
    command=$(echo "$result" | jq -r '.mcpServers.cleo.command')
    [[ "$command" == "npx" ]]
}

@test "merge standard: preserves other top-level keys" {
    local existing='{"version":"1.0","mcpServers":{}}'
    local entry
    entry=$(mcp_generate_entry "npx")
    local result
    result=$(_mcp_merge_standard "$existing" "$entry" "mcpServers")

    local version
    version=$(echo "$result" | jq -r '.version')
    [[ "$version" == "1.0" ]]
}

# ============================================================================
# MERGE: OPENCODE FORMAT
# ============================================================================

@test "merge opencode: creates correct structure" {
    local entry
    entry=$(mcp_generate_entry "npx")
    local result
    result=$(_mcp_merge_opencode "" "$entry")

    local type enabled
    type=$(echo "$result" | jq -r '.mcp.cleo.type')
    enabled=$(echo "$result" | jq -r '.mcp.cleo.enabled')
    [[ "$type" == "local" ]]
    [[ "$enabled" == "true" ]]

    # OpenCode uses array-style command
    local cmd_first
    cmd_first=$(echo "$result" | jq -r '.mcp.cleo.command[0]')
    [[ "$cmd_first" == "npx" ]]
}

@test "merge opencode: preserves existing entries" {
    local existing='{"mcp":{"other":{"type":"local","command":["node","x.js"],"enabled":true}}}'
    local entry
    entry=$(mcp_generate_entry "npx")
    local result
    result=$(_mcp_merge_opencode "$existing" "$entry")

    local other cleo
    other=$(echo "$result" | jq -r '.mcp.other.command[0]')
    cleo=$(echo "$result" | jq -r '.mcp.cleo.command[0]')
    [[ "$other" == "node" ]]
    [[ "$cleo" == "npx" ]]
}

# ============================================================================
# MERGE: VSCODE FORMAT
# ============================================================================

@test "merge vscode: creates servers key" {
    local entry
    entry=$(mcp_generate_entry "npx")
    local result
    result=$(_mcp_merge_vscode "" "$entry")

    local has_servers
    has_servers=$(echo "$result" | jq 'has("servers")')
    [[ "$has_servers" == "true" ]]

    local command
    command=$(echo "$result" | jq -r '.servers.cleo.command')
    [[ "$command" == "npx" ]]
}

# ============================================================================
# MERGE: ZED FORMAT
# ============================================================================

@test "merge zed: creates context_servers key" {
    local entry
    entry=$(mcp_generate_entry "npx")
    local result
    result=$(_mcp_merge_zed "" "$entry")

    local has_key
    has_key=$(echo "$result" | jq 'has("context_servers")')
    [[ "$has_key" == "true" ]]

    local command
    command=$(echo "$result" | jq -r '.context_servers.cleo.command')
    [[ "$command" == "npx" ]]
}

@test "merge zed: preserves existing settings" {
    local existing='{"theme":"dark","context_servers":{}}'
    local entry
    entry=$(mcp_generate_entry "npx")
    local result
    result=$(_mcp_merge_zed "$existing" "$entry")

    local theme
    theme=$(echo "$result" | jq -r '.theme')
    [[ "$theme" == "dark" ]]
}

# ============================================================================
# MERGE: CODEX TOML FORMAT
# ============================================================================

@test "codex toml: generates correct block" {
    local entry
    entry=$(mcp_generate_entry "npx")
    local result
    result=$(_mcp_generate_codex_toml_block "$entry")

    [[ "$result" == *"[mcp_servers.cleo]"* ]]
    [[ "$result" == *'command = "npx"'* ]]
    [[ "$result" == *'args = ["-y", "@cleocode/mcp-server"]'* ]]
}

@test "codex toml: appends to empty content" {
    local entry
    entry=$(mcp_generate_entry "npx")
    local result
    result=$(_mcp_merge_codex_toml "" "$entry")

    [[ "$result" == *"[mcp_servers.cleo]"* ]]
}

@test "codex toml: appends to existing content" {
    local existing='[general]
model = "gpt-4"'
    local entry
    entry=$(mcp_generate_entry "npx")
    local result
    result=$(_mcp_merge_codex_toml "$existing" "$entry")

    [[ "$result" == *"[general]"* ]]
    [[ "$result" == *"[mcp_servers.cleo]"* ]]
}

@test "codex toml: replaces existing cleo block" {
    local existing='[mcp_servers.cleo]
command = "node"
args = ["old.js"]'
    local entry
    entry=$(mcp_generate_entry "npx")
    local result
    result=$(_mcp_merge_codex_toml "$existing" "$entry")

    [[ "$result" == *'command = "npx"'* ]]
    [[ "$result" != *'command = "node"'* ]]
}

# ============================================================================
# MERGE: GOOSE YAML FORMAT
# ============================================================================

@test "goose yaml: generates correct block" {
    local entry
    entry=$(mcp_generate_entry "npx")
    local result
    result=$(_mcp_generate_goose_yaml_block "$entry")

    [[ "$result" == *"cleo:"* ]]
    [[ "$result" == *"cmd: npx"* ]]
    [[ "$result" == *"- -y"* ]]
    [[ "$result" == *"- @cleocode/mcp-server"* ]]
    [[ "$result" == *"type: stdio"* ]]
    [[ "$result" == *"enabled: true"* ]]
}

@test "goose yaml: creates from empty" {
    local entry
    entry=$(mcp_generate_entry "npx")
    local result
    result=$(_mcp_merge_goose_yaml "" "$entry")

    [[ "$result" == *"extensions:"* ]]
    [[ "$result" == *"cleo:"* ]]
    [[ "$result" == *"cmd: npx"* ]]
}

@test "goose yaml: appends to existing content" {
    local existing='extensions:
  other:
    cmd: node
    type: stdio'
    local entry
    entry=$(mcp_generate_entry "npx")
    local result
    result=$(_mcp_merge_goose_yaml "$existing" "$entry")

    [[ "$result" == *"extensions:"* ]]
    [[ "$result" == *"other:"* ]]
    [[ "$result" == *"cleo:"* ]]
    [[ "$result" == *"cmd: npx"* ]]
}

# ============================================================================
# BACKUP
# ============================================================================

@test "mcp_backup_external_file creates timestamped backup" {
    local test_file="$TEST_TEMP_DIR/test-config.json"
    echo '{"test": true}' > "$test_file"

    run mcp_backup_external_file "$test_file"
    assert_success

    # Backup path should contain .cleo-backup.
    [[ "$output" == *".cleo-backup."* ]]

    # Backup file should exist
    [[ -f "$output" ]]

    # Content should match
    local backup_content
    backup_content=$(cat "$output")
    [[ "$backup_content" == '{"test": true}' ]]
}

@test "mcp_backup_external_file returns 0 for non-existent file" {
    run mcp_backup_external_file "$TEST_TEMP_DIR/nonexistent.json"
    assert_success
}

# ============================================================================
# WRITE CONFIG
# ============================================================================

@test "mcp_write_config dry run produces JSON without writing" {
    local test_dir="$TEST_TEMP_DIR/write-test"
    mkdir -p "$test_dir"
    cd "$test_dir"

    run mcp_write_config "claude-code" "project" "npx" "$test_dir" "true"
    assert_success

    # Should output JSON with dry_run action
    local action
    action=$(echo "$output" | jq -r '.action')
    [[ "$action" == "dry_run" ]]

    # File should NOT be created
    [[ ! -f "$test_dir/.mcp.json" ]]
}

@test "mcp_write_config writes .mcp.json for claude-code" {
    local test_dir="$TEST_TEMP_DIR/write-test2"
    mkdir -p "$test_dir"
    cd "$test_dir"

    run mcp_write_config "claude-code" "project" "npx" "$test_dir" "false"
    assert_success

    # File should be created
    [[ -f "$test_dir/.mcp.json" ]]

    # Content should be valid JSON with correct structure
    local command
    command=$(jq -r '.mcpServers.cleo.command' "$test_dir/.mcp.json")
    [[ "$command" == "npx" ]]
}

@test "mcp_write_config preserves existing entries in .mcp.json" {
    local test_dir="$TEST_TEMP_DIR/write-test3"
    mkdir -p "$test_dir"
    cd "$test_dir"

    # Create existing config
    echo '{"mcpServers":{"other":{"command":"node","args":["other.js"]}}}' > "$test_dir/.mcp.json"

    run mcp_write_config "claude-code" "project" "npx" "$test_dir" "false"
    assert_success

    # Both entries should exist
    local other_cmd cleo_cmd
    other_cmd=$(jq -r '.mcpServers.other.command' "$test_dir/.mcp.json")
    cleo_cmd=$(jq -r '.mcpServers.cleo.command' "$test_dir/.mcp.json")
    [[ "$other_cmd" == "node" ]]
    [[ "$cleo_cmd" == "npx" ]]
}

@test "mcp_write_config creates backup of existing file" {
    local test_dir="$TEST_TEMP_DIR/write-test4"
    mkdir -p "$test_dir"
    cd "$test_dir"

    echo '{"mcpServers":{}}' > "$test_dir/.mcp.json"

    run mcp_write_config "claude-code" "project" "npx" "$test_dir" "false"
    assert_success

    # Should report backup path
    local backup
    backup=$(echo "$output" | jq -r '.backup')
    [[ -n "$backup" ]]
    [[ -f "$backup" ]]
}

@test "mcp_write_config is idempotent - second run matches first" {
    local test_dir="$TEST_TEMP_DIR/idempotent-test"
    mkdir -p "$test_dir"
    cd "$test_dir"

    # First write
    mcp_write_config "claude-code" "project" "npx" "$test_dir" "false" >/dev/null

    # Capture state after first write
    local first_content
    first_content=$(cat "$test_dir/.mcp.json")

    # Second write (should produce identical output)
    mcp_write_config "claude-code" "project" "npx" "$test_dir" "false" >/dev/null

    local second_content
    second_content=$(cat "$test_dir/.mcp.json")

    [[ "$first_content" == "$second_content" ]]
}

@test "mcp_write_config idempotent with existing servers" {
    local test_dir="$TEST_TEMP_DIR/idempotent-test2"
    mkdir -p "$test_dir"
    cd "$test_dir"

    # Create config with other servers
    echo '{"mcpServers":{"other":{"command":"node","args":["x.js"]},"cleo":{"command":"npx","args":["-y","@cleocode/mcp-server"]}}}' > "$test_dir/.mcp.json"

    local before
    before=$(cat "$test_dir/.mcp.json")

    # Run mcp-install again
    mcp_write_config "claude-code" "project" "npx" "$test_dir" "false" >/dev/null

    # other server must still be there
    local other_cmd
    other_cmd=$(jq -r '.mcpServers.other.command' "$test_dir/.mcp.json")
    [[ "$other_cmd" == "node" ]]

    # Key count should be the same
    local keys_before keys_after
    keys_before=$(echo "$before" | jq '.mcpServers | keys | length')
    keys_after=$(jq '.mcpServers | keys | length' "$test_dir/.mcp.json")
    [[ "$keys_before" -eq "$keys_after" ]]
}

@test "mcp_write_config rejects invalid existing JSON" {
    local test_dir="$TEST_TEMP_DIR/write-test5"
    mkdir -p "$test_dir"
    cd "$test_dir"

    echo 'not valid json' > "$test_dir/.mcp.json"

    run mcp_write_config "claude-code" "project" "npx" "$test_dir" "false"
    assert_failure
}

@test "mcp_write_config creates parent directories" {
    local test_dir="$TEST_TEMP_DIR/write-test6"
    mkdir -p "$test_dir"
    cd "$test_dir"

    # .vscode/ doesn't exist yet
    run mcp_write_config "vscode" "project" "npx" "$test_dir" "false"
    assert_success

    [[ -f "$test_dir/.vscode/mcp.json" ]]
}

# ============================================================================
# DETECTION
# ============================================================================

@test "mcp_detect_all_tools returns valid JSON array" {
    run mcp_detect_all_tools
    assert_success

    # Should be valid JSON
    echo "$output" | jq empty
    assert_success

    # Should be an array
    local type
    type=$(echo "$output" | jq -r 'type')
    [[ "$type" == "array" ]]
}

@test "mcp_detect_tool returns JSON with expected fields" {
    # This test depends on having at least one tool detectable
    # We test the structure by mocking - detect claude (likely on this system)
    if ! command -v claude &>/dev/null; then
        skip "claude binary not found"
    fi

    run mcp_detect_tool "claude-code"
    assert_success

    local key name format method
    key=$(echo "$output" | jq -r '.key')
    name=$(echo "$output" | jq -r '.name')
    format=$(echo "$output" | jq -r '.format')
    method=$(echo "$output" | jq -r '.method')

    [[ "$key" == "claude-code" ]]
    [[ "$name" == "Claude Code" ]]
    [[ "$format" == "standard" ]]
    [[ "$method" == "binary" ]]
}

# ============================================================================
# CLI INTEGRATION
# ============================================================================

@test "mcp-install --help shows usage" {
    run bash "$MCP_INSTALL_SCRIPT" --help
    assert_success
    assert_output --partial "Usage: cleo mcp-install"
    assert_output --partial "--tool"
    assert_output --partial "--mode"
    assert_output --partial "--dry-run"
}

@test "mcp-install --list-tools shows all tools" {
    run bash "$MCP_INSTALL_SCRIPT" --list-tools
    assert_success
    assert_output --partial "claude-code"
    assert_output --partial "codex"
    assert_output --partial "KEY"
}

@test "mcp-install --list-tools --json outputs valid JSON" {
    run bash "$MCP_INSTALL_SCRIPT" --list-tools --json
    assert_success
    echo "$output" | jq empty
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    [[ "$count" -eq 12 ]]
}

@test "mcp-install rejects invalid tool" {
    run bash "$MCP_INSTALL_SCRIPT" --tool nonexistent --force
    assert_failure
}

@test "mcp-install rejects invalid mode" {
    run bash "$MCP_INSTALL_SCRIPT" --mode invalid
    assert_failure
}

@test "mcp-install rejects unknown flags" {
    run bash "$MCP_INSTALL_SCRIPT" --bogus
    assert_failure
}

@test "mcp-install --tool claude-code --dry-run --force produces preview" {
    local test_dir="$TEST_TEMP_DIR/cli-test"
    mkdir -p "$test_dir"
    cd "$test_dir"

    run bash "$MCP_INSTALL_SCRIPT" --tool claude-code --dry-run --force
    assert_success
    assert_output --partial "DRY RUN"
    assert_output --partial ".mcp.json"
}

@test "mcp-install --tool claude-code --dry-run --json produces JSON" {
    local test_dir="$TEST_TEMP_DIR/cli-test2"
    mkdir -p "$test_dir"
    cd "$test_dir"

    run bash "$MCP_INSTALL_SCRIPT" --tool claude-code --dry-run --json --force
    assert_success

    local action
    action=$(echo "$output" | jq -r '.action')
    [[ "$action" == "dry_run" ]]
}
