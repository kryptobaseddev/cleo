#!/usr/bin/env bats
# =============================================================================
# command-registry.bats - Unit tests for lib/command-registry.sh
# =============================================================================
# Tests ###CLEO header parsing, registry scanning, validation, and rebuild.
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    # Source the library under test
    source "${LIB_DIR}/command-registry.sh"

    # Create a temp scripts directory with test scripts
    TEST_SCRIPTS_DIR="${TEST_TEMP_DIR}/scripts"
    mkdir -p "$TEST_SCRIPTS_DIR"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper: Create a test script with ###CLEO header
# =============================================================================
create_test_script() {
    local name="$1"
    local command="${2:-$name}"
    local category="${3:-write}"
    local synopsis="${4:-Test command}"
    local relevance="${5:-medium}"

    cat > "${TEST_SCRIPTS_DIR}/${name}.sh" << EOF
#!/usr/bin/env bash
###CLEO
# command: ${command}
# category: ${category}
# synopsis: ${synopsis}
# relevance: ${relevance}
# flags: --format,--json
# exits: 0,2
# json-output: true
###END
echo "hello"
EOF
}

# =============================================================================
# parse_command_header Tests
# =============================================================================

@test "parse_command_header: parses basic header correctly" {
    create_test_script "mycommand" "mycommand" "write" "My test command" "high"

    run parse_command_header "${TEST_SCRIPTS_DIR}/mycommand.sh"
    assert_success

    local name category synopsis relevance
    name=$(echo "$output" | jq -r '.name')
    category=$(echo "$output" | jq -r '.category')
    synopsis=$(echo "$output" | jq -r '.synopsis')
    relevance=$(echo "$output" | jq -r '.agentRelevance')

    assert_equal "$name" "mycommand"
    assert_equal "$category" "write"
    assert_equal "$synopsis" "My test command"
    assert_equal "$relevance" "high"
}

@test "parse_command_header: parses flags as array" {
    create_test_script "flagtest" "flagtest"

    run parse_command_header "${TEST_SCRIPTS_DIR}/flagtest.sh"
    assert_success

    local flags_count
    flags_count=$(echo "$output" | jq '.flags | length')
    assert_equal "$flags_count" "2"

    local first_flag
    first_flag=$(echo "$output" | jq -r '.flags[0]')
    assert_equal "$first_flag" "--format"
}

@test "parse_command_header: parses exit codes as number array" {
    create_test_script "exittest" "exittest"

    run parse_command_header "${TEST_SCRIPTS_DIR}/exittest.sh"
    assert_success

    local exits_count first_exit
    exits_count=$(echo "$output" | jq '.exitCodes | length')
    first_exit=$(echo "$output" | jq '.exitCodes[0]')
    assert_equal "$exits_count" "2"
    assert_equal "$first_exit" "0"
}

@test "parse_command_header: returns error for missing file" {
    run parse_command_header "${TEST_SCRIPTS_DIR}/nonexistent.sh"
    assert_failure

    local error
    error=$(echo "$output" | jq -r '.error')
    assert_equal "$error" "file_not_found"
}

@test "parse_command_header: returns error for script without header" {
    cat > "${TEST_SCRIPTS_DIR}/noheader.sh" << 'EOF'
#!/usr/bin/env bash
echo "no header here"
EOF

    run parse_command_header "${TEST_SCRIPTS_DIR}/noheader.sh"
    assert_failure

    local error
    error=$(echo "$output" | jq -r '.error')
    assert_equal "$error" "no_header_found"
}

@test "parse_command_header: parses subcommands" {
    cat > "${TEST_SCRIPTS_DIR}/withsub.sh" << 'EOF'
#!/usr/bin/env bash
###CLEO
# command: withsub
# category: write
# synopsis: Has subcommands
# relevance: high
# flags: --format
# exits: 0
# json-output: true
# subcommands: create,list,show
###END
EOF

    run parse_command_header "${TEST_SCRIPTS_DIR}/withsub.sh"
    assert_success

    local sub_count
    sub_count=$(echo "$output" | jq '.subcommands | length')
    assert_equal "$sub_count" "3"
}

@test "parse_command_header: parses aliases" {
    cat > "${TEST_SCRIPTS_DIR}/withalias.sh" << 'EOF'
#!/usr/bin/env bash
###CLEO
# command: withalias
# category: read
# synopsis: Has aliases
# relevance: medium
# aliases: wa,with
# flags: --format
# exits: 0
# json-output: false
###END
EOF

    run parse_command_header "${TEST_SCRIPTS_DIR}/withalias.sh"
    assert_success

    local alias_count
    alias_count=$(echo "$output" | jq '.aliases | length')
    assert_equal "$alias_count" "2"
}

@test "parse_command_header: handles json-default field" {
    cat > "${TEST_SCRIPTS_DIR}/jsondefault.sh" << 'EOF'
#!/usr/bin/env bash
###CLEO
# command: jsondefault
# category: read
# synopsis: JSON default test
# relevance: low
# flags: --format
# exits: 0
# json-output: true
# json-default: true
###END
EOF

    run parse_command_header "${TEST_SCRIPTS_DIR}/jsondefault.sh"
    assert_success

    local json_default
    json_default=$(echo "$output" | jq '.jsonDefault')
    assert_equal "$json_default" "true"
}

@test "parse_command_header: script name comes from filename" {
    create_test_script "my-cmd" "my-cmd"

    run parse_command_header "${TEST_SCRIPTS_DIR}/my-cmd.sh"
    assert_success

    local script
    script=$(echo "$output" | jq -r '.script')
    assert_equal "$script" "my-cmd.sh"
}

# =============================================================================
# scan_all_commands Tests
# =============================================================================

@test "scan_all_commands: scans directory of scripts" {
    create_test_script "alpha" "alpha" "write" "Alpha command"
    create_test_script "beta" "beta" "read" "Beta command"
    create_test_script "gamma" "gamma" "sync" "Gamma command"

    run scan_all_commands "$TEST_SCRIPTS_DIR"
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    assert_equal "$count" "3"
}

@test "scan_all_commands: returns sorted by name" {
    create_test_script "zebra" "zebra"
    create_test_script "alpha" "alpha"
    create_test_script "middle" "middle"

    run scan_all_commands "$TEST_SCRIPTS_DIR"
    assert_success

    local first last
    first=$(echo "$output" | jq -r '.[0].name')
    last=$(echo "$output" | jq -r '.[-1].name')
    assert_equal "$first" "alpha"
    assert_equal "$last" "zebra"
}

@test "scan_all_commands: skips scripts without headers" {
    create_test_script "valid" "valid"
    cat > "${TEST_SCRIPTS_DIR}/nope.sh" << 'EOF'
#!/usr/bin/env bash
echo "no header"
EOF

    run scan_all_commands "$TEST_SCRIPTS_DIR"
    assert_success

    local count
    count=$(echo "$output" | jq 'length')
    assert_equal "$count" "1"
}

@test "scan_all_commands: returns empty array for empty dir" {
    local empty_dir="${TEST_TEMP_DIR}/empty"
    mkdir -p "$empty_dir"

    run scan_all_commands "$empty_dir"
    assert_success
    assert_equal "$output" "[]"
}

# =============================================================================
# validate_header Tests
# =============================================================================

@test "validate_header: valid script passes" {
    create_test_script "good" "good" "write" "Good command" "high"

    run validate_header "${TEST_SCRIPTS_DIR}/good.sh"
    assert_success

    local valid
    valid=$(echo "$output" | jq '.valid')
    assert_equal "$valid" "true"
}

@test "validate_header: missing command field fails" {
    cat > "${TEST_SCRIPTS_DIR}/noname.sh" << 'EOF'
#!/usr/bin/env bash
###CLEO
# category: write
# synopsis: Missing name
# relevance: high
###END
EOF

    run validate_header "${TEST_SCRIPTS_DIR}/noname.sh"
    assert_failure

    local valid
    valid=$(echo "$output" | jq '.valid')
    assert_equal "$valid" "false"
}

@test "validate_header: missing category field fails" {
    cat > "${TEST_SCRIPTS_DIR}/nocat.sh" << 'EOF'
#!/usr/bin/env bash
###CLEO
# command: nocat
# synopsis: Missing category
# relevance: high
###END
EOF

    run validate_header "${TEST_SCRIPTS_DIR}/nocat.sh"
    assert_failure

    local valid
    valid=$(echo "$output" | jq '.valid')
    assert_equal "$valid" "false"
}

@test "validate_header: script without header fails" {
    cat > "${TEST_SCRIPTS_DIR}/bare.sh" << 'EOF'
#!/usr/bin/env bash
echo "nothing"
EOF

    run validate_header "${TEST_SCRIPTS_DIR}/bare.sh"
    assert_failure

    local valid
    valid=$(echo "$output" | jq '.valid')
    assert_equal "$valid" "false"
}

# =============================================================================
# get_command_script_map Tests
# =============================================================================

@test "get_command_script_map: returns name-to-script mapping" {
    create_test_script "foo" "foo"
    create_test_script "bar" "bar"

    run get_command_script_map "$TEST_SCRIPTS_DIR"
    assert_success

    local foo_script bar_script
    foo_script=$(echo "$output" | jq -r '.foo')
    bar_script=$(echo "$output" | jq -r '.bar')
    assert_equal "$foo_script" "foo.sh"
    assert_equal "$bar_script" "bar.sh"
}

# =============================================================================
# get_alias_map Tests
# =============================================================================

@test "get_alias_map: returns alias-to-command mapping" {
    cat > "${TEST_SCRIPTS_DIR}/aliased.sh" << 'EOF'
#!/usr/bin/env bash
###CLEO
# command: aliased
# category: write
# synopsis: Has aliases
# relevance: medium
# aliases: al,a
# flags: --format
# exits: 0
# json-output: false
###END
EOF

    run get_alias_map "$TEST_SCRIPTS_DIR"
    assert_success

    local al_cmd a_cmd
    al_cmd=$(echo "$output" | jq -r '.al')
    a_cmd=$(echo "$output" | jq -r '.a')
    assert_equal "$al_cmd" "aliased"
    assert_equal "$a_cmd" "aliased"
}

# =============================================================================
# rebuild_commands_index Tests
# =============================================================================

@test "rebuild_commands_index: generates valid INDEX JSON" {
    create_test_script "cmd1" "cmd1" "write" "Command one" "high"
    create_test_script "cmd2" "cmd2" "read" "Command two" "medium"

    local output_file="${TEST_TEMP_DIR}/test-index.json"

    run rebuild_commands_index "$TEST_SCRIPTS_DIR" "$output_file"
    assert_success

    # Validate it's valid JSON
    run jq empty "$output_file"
    assert_success

    # Check structure
    local total
    total=$(jq '._meta.totalCommands' "$output_file")
    assert_equal "$total" "2"

    local gen_from
    gen_from=$(jq -r '._meta.generatedFrom' "$output_file")
    assert_equal "$gen_from" "script-headers"
}

@test "rebuild_commands_index: commands sorted by name" {
    create_test_script "zzz" "zzz" "write" "Last" "low"
    create_test_script "aaa" "aaa" "read" "First" "high"

    local output_file="${TEST_TEMP_DIR}/sorted-index.json"
    run rebuild_commands_index "$TEST_SCRIPTS_DIR" "$output_file"
    assert_success

    local first_cmd last_cmd
    first_cmd=$(jq -r '.commands[0].name' "$output_file")
    last_cmd=$(jq -r '.commands[-1].name' "$output_file")
    assert_equal "$first_cmd" "aaa"
    assert_equal "$last_cmd" "zzz"
}

@test "rebuild_commands_index: dry-run outputs JSON to stdout" {
    create_test_script "drytest" "drytest"

    run rebuild_commands_index "$TEST_SCRIPTS_DIR" "/dev/null" "--dry-run"
    assert_success

    # Output should be valid JSON with commands
    local count
    count=$(echo "$output" | jq '.commands | length')
    assert_equal "$count" "1"
}

@test "rebuild_commands_index: preserves agentWorkflows from existing INDEX" {
    create_test_script "cmd1" "cmd1" "write" "Command one"

    # Create a fake existing INDEX with agentWorkflows
    mkdir -p "${TEST_SCRIPTS_DIR}/../docs/commands"
    cat > "${TEST_SCRIPTS_DIR}/../docs/commands/COMMANDS-INDEX.json" << 'EOF'
{
  "commands": [],
  "agentWorkflows": {"test-workflow": ["step1", "step2"]},
  "quickLookup": {"find tasks": "cleo find"}
}
EOF

    local output_file="${TEST_TEMP_DIR}/preserved-index.json"
    run rebuild_commands_index "$TEST_SCRIPTS_DIR" "$output_file"
    assert_success

    local workflow
    workflow=$(jq -r '.agentWorkflows["test-workflow"][0]' "$output_file")
    assert_equal "$workflow" "step1"

    local lookup
    lookup=$(jq -r '.quickLookup["find tasks"]' "$output_file")
    assert_equal "$lookup" "cleo find"
}

@test "rebuild_commands_index: builds categories from commands" {
    create_test_script "writer" "writer" "write" "Write cmd"
    create_test_script "reader" "reader" "read" "Read cmd"

    local output_file="${TEST_TEMP_DIR}/categorized-index.json"
    run rebuild_commands_index "$TEST_SCRIPTS_DIR" "$output_file"
    assert_success

    local write_cmds read_cmds
    write_cmds=$(jq '.categories.write | length' "$output_file")
    read_cmds=$(jq '.categories.read | length' "$output_file")
    assert_equal "$write_cmds" "1"
    assert_equal "$read_cmds" "1"
}

# =============================================================================
# Real Scripts Integration Tests
# =============================================================================

@test "all production scripts have valid ###CLEO headers" {
    local invalid_count=0
    local invalid_scripts=""

    for script in "${SCRIPTS_DIR}"/*.sh; do
        [[ -f "$script" ]] || continue

        local result
        result=$(validate_header "$script" 2>/dev/null) || true
        local valid
        valid=$(echo "$result" | jq -r '.valid' 2>/dev/null)

        if [[ "$valid" != "true" ]]; then
            ((invalid_count++))
            invalid_scripts="${invalid_scripts}  $(basename "$script")\n"
        fi
    done

    if [[ $invalid_count -gt 0 ]]; then
        fail "Found $invalid_count scripts with invalid headers:\n${invalid_scripts}"
    fi
}

@test "production INDEX matches generated from headers" {
    local generated
    generated=$(rebuild_commands_index "$SCRIPTS_DIR" "/dev/null" "--dry-run" 2>/dev/null)

    local current_names generated_names
    current_names=$(jq -r '[.commands[].name] | sort | join(",")' "${PROJECT_ROOT}/docs/commands/COMMANDS-INDEX.json")
    generated_names=$(echo "$generated" | jq -r '[.commands[].name] | sort | join(",")')

    assert_equal "$current_names" "$generated_names"
}

@test "every production script command name matches filename" {
    local mismatches=""

    for script in "${SCRIPTS_DIR}"/*.sh; do
        [[ -f "$script" ]] || continue

        local filename_cmd header_cmd
        filename_cmd=$(basename "$script" .sh)
        header_cmd=$(parse_command_header "$script" 2>/dev/null | jq -r '.name' 2>/dev/null) || continue

        if [[ -n "$header_cmd" && "$header_cmd" != "null" && "$filename_cmd" != "$header_cmd" ]]; then
            mismatches="${mismatches}  ${filename_cmd}.sh has command: ${header_cmd}\n"
        fi
    done

    if [[ -n "$mismatches" ]]; then
        fail "Script filenames don't match command names:\n${mismatches}"
    fi
}
