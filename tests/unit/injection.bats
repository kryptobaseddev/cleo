#!/usr/bin/env bats
# =============================================================================
# injection.bats - Unit tests for lib/injection.sh core (pure) functions
# =============================================================================
# Tests injection operations for agent documentation files.
# Focuses on PURE functions: extract_version, validate_markers, check_status.
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
    source "${PROJECT_ROOT}/lib/injection-registry.sh"
    source "${PROJECT_ROOT}/lib/injection-config.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# injection_extract_version() Tests
# =============================================================================

@test "injection_extract_version extracts version from versioned marker" {
    local version
    version=$(injection_extract_version "${FIXTURES_DIR}/injection/current.md")
    [ "$version" = "0.50.2" ]
}

@test "injection_extract_version extracts version from outdated file" {
    local version
    version=$(injection_extract_version "${FIXTURES_DIR}/injection/outdated.md")
    [ "$version" = "0.48.0" ]
}

@test "injection_extract_version returns empty for unversioned marker" {
    local version
    version=$(injection_extract_version "${FIXTURES_DIR}/injection/legacy-unversioned.md")
    [ -z "$version" ]
}

@test "injection_extract_version returns empty for missing markers" {
    local version
    version=$(injection_extract_version "${FIXTURES_DIR}/injection/clean.md")
    [ -z "$version" ]
}

@test "injection_extract_version returns empty for nonexistent file" {
    local version
    version=$(injection_extract_version "${FIXTURES_DIR}/injection/nonexistent.md")
    [ -z "$version" ]
}

@test "injection_extract_version extracts first version from nested markers" {
    local version
    version=$(injection_extract_version "${FIXTURES_DIR}/injection/malformed-nested.md")
    [ "$version" = "0.50.2" ]
}

@test "injection_extract_version handles template file (no version in template)" {
    local version template_path
    template_path=$(injection_get_template_path)
    version=$(injection_extract_version "$template_path")
    # Template should NOT have version marker (added by setup-agents.sh)
    [ -z "$version" ]
}

# =============================================================================
# injection_has_block() Tests (Marker Validation)
# =============================================================================

@test "injection_has_block detects versioned marker" {
    injection_has_block "${FIXTURES_DIR}/injection/current.md"
}

@test "injection_has_block detects unversioned marker" {
    injection_has_block "${FIXTURES_DIR}/injection/legacy-unversioned.md"
}

@test "injection_has_block detects outdated marker" {
    injection_has_block "${FIXTURES_DIR}/injection/outdated.md"
}

@test "injection_has_block returns false for clean file" {
    ! injection_has_block "${FIXTURES_DIR}/injection/clean.md"
}

@test "injection_has_block returns false for nonexistent file" {
    ! injection_has_block "${FIXTURES_DIR}/injection/nonexistent.md"
}

@test "injection_has_block detects marker even with missing end" {
    injection_has_block "${FIXTURES_DIR}/injection/malformed-missing-end.md"
}

@test "injection_has_block detects marker even with missing start (has end)" {
    # This tests that we only check for START marker presence
    ! injection_has_block "${FIXTURES_DIR}/injection/malformed-missing-start.md"
}

# =============================================================================
# injection_check() Tests (Status Determination)
# =============================================================================

@test "injection_check reports 'missing' status for nonexistent file" {
    local result status file_exists
    result=$(cd "$PROJECT_ROOT" && source lib/injection.sh && injection_check "${FIXTURES_DIR}/injection/nonexistent.md")

    status=$(echo "$result" | jq -r '.status')
    file_exists=$(echo "$result" | jq -r '.fileExists')

    [ "$status" = "missing" ]
    [ "$file_exists" = "false" ]
}

@test "injection_check reports 'none' status for clean file" {
    local result status file_exists
    result=$(cd "$PROJECT_ROOT" && source lib/injection.sh && injection_check "${FIXTURES_DIR}/injection/clean.md")

    status=$(echo "$result" | jq -r '.status')
    file_exists=$(echo "$result" | jq -r '.fileExists')

    [ "$status" = "none" ]
    [ "$file_exists" = "true" ]
}

@test "injection_check reports 'legacy' status for unversioned marker" {
    local result status current_version installed_version
    result=$(cd "$PROJECT_ROOT" && source lib/injection.sh && CLI_VERSION="0.50.2" injection_check "${FIXTURES_DIR}/injection/legacy-unversioned.md")

    status=$(echo "$result" | jq -r '.status')
    current_version=$(echo "$result" | jq -r '.currentVersion')
    installed_version=$(echo "$result" | jq -r '.installedVersion')

    [ "$status" = "legacy" ]
    [ "$current_version" = "" ]
    [ "$installed_version" = "0.50.2" ]
}

@test "injection_check reports 'current' status for current version" {
    local result status current_version installed_version

    # Use CLI_VERSION as the expected version (no longer from template)
    local expected_version="0.50.2"

    # Create a temp file with current version
    local temp_file
    temp_file="${TEST_TEMP_DIR}/current-test.md"
    cat > "$temp_file" <<EOF
<!-- CLEO:START v${expected_version} -->
## Task Management
Content here
<!-- CLEO:END -->
EOF

    result=$(cd "$PROJECT_ROOT" && source lib/injection.sh && CLI_VERSION="$expected_version" injection_check "$temp_file")

    status=$(echo "$result" | jq -r '.status')
    current_version=$(echo "$result" | jq -r '.currentVersion')
    installed_version=$(echo "$result" | jq -r '.installedVersion')

    [ "$status" = "current" ]
    [ "$current_version" = "$expected_version" ]
    [ "$installed_version" = "$expected_version" ]
}

@test "injection_check reports 'outdated' status for old version" {
    local result status current_version installed_version
    result=$(cd "$PROJECT_ROOT" && source lib/injection.sh && CLI_VERSION="0.50.2" injection_check "${FIXTURES_DIR}/injection/outdated.md")

    status=$(echo "$result" | jq -r '.status')
    current_version=$(echo "$result" | jq -r '.currentVersion')
    installed_version=$(echo "$result" | jq -r '.installedVersion')

    [ "$status" = "outdated" ]
    [ "$current_version" = "0.48.0" ]
    [ "$installed_version" = "0.50.2" ]
    # Installed should be newer than current
    [[ "$installed_version" > "$current_version" ]]
}

@test "injection_check returns valid JSON" {
    local result
    result=$(cd "$PROJECT_ROOT" && source lib/injection.sh && injection_check "${FIXTURES_DIR}/injection/current.md")

    # Should parse as valid JSON
    echo "$result" | jq empty
}

@test "injection_check includes target in response" {
    local result target
    result=$(cd "$PROJECT_ROOT" && source lib/injection.sh && injection_check "${FIXTURES_DIR}/injection/current.md")

    target=$(echo "$result" | jq -r '.target')
    [ "$target" = "${FIXTURES_DIR}/injection/current.md" ]
}

# =============================================================================
# injection_is_valid_target() Tests
# =============================================================================

@test "injection_is_valid_target accepts CLAUDE.md" {
    injection_is_valid_target "CLAUDE.md"
}

@test "injection_is_valid_target accepts AGENTS.md" {
    injection_is_valid_target "AGENTS.md"
}

@test "injection_is_valid_target accepts GEMINI.md" {
    injection_is_valid_target "GEMINI.md"
}

@test "injection_is_valid_target rejects README.md" {
    ! injection_is_valid_target "README.md"
}

@test "injection_is_valid_target rejects arbitrary.md" {
    ! injection_is_valid_target "arbitrary.md"
}

@test "injection_is_valid_target rejects path with directory" {
    ! injection_is_valid_target "docs/CLAUDE.md"
}

# =============================================================================
# injection_get_targets() Tests
# =============================================================================

@test "injection_get_targets returns array of targets" {
    injection_get_targets
    [ ${#REPLY[@]} -gt 0 ]
}

@test "injection_get_targets includes CLAUDE.md" {
    injection_get_targets
    local found=false
    for target in "${REPLY[@]}"; do
        if [ "$target" = "CLAUDE.md" ]; then
            found=true
            break
        fi
    done
    [ "$found" = true ]
}

@test "injection_get_targets includes AGENTS.md" {
    injection_get_targets
    local found=false
    for target in "${REPLY[@]}"; do
        if [ "$target" = "AGENTS.md" ]; then
            found=true
            break
        fi
    done
    [ "$found" = true ]
}

@test "injection_get_targets includes GEMINI.md" {
    injection_get_targets
    local found=false
    for target in "${REPLY[@]}"; do
        if [ "$target" = "GEMINI.md" ]; then
            found=true
            break
        fi
    done
    [ "$found" = true ]
}

# =============================================================================
# injection_get_template_path() Tests
# =============================================================================

@test "injection_get_template_path returns valid path" {
    local template_path
    template_path=$(injection_get_template_path)
    [ -n "$template_path" ]
}

@test "injection_get_template_path returns existing file" {
    local template_path
    template_path=$(injection_get_template_path)
    [ -f "$template_path" ]
}

@test "injection_get_template_path file has no version marker (added by setup-agents.sh)" {
    local template_path
    template_path=$(injection_get_template_path)
    # Template should NOT contain markers (added by wrapper script)
    ! grep -q "CLEO:START" "$template_path"
    ! grep -q "CLEO:END" "$template_path"
}

# =============================================================================
# injection_get_header_path() Tests
# =============================================================================

@test "injection_get_header_path returns empty for CLAUDE.md" {
    # Test in subshell to avoid BATS associative array issues
    run bash -c "
        export CLEO_HOME='${PROJECT_ROOT}'
        source '${PROJECT_ROOT}/lib/injection-registry.sh'
        source '${PROJECT_ROOT}/lib/injection-config.sh'
        injection_get_header_path 'CLAUDE.md'
    "
    assert_success
    [ -z "$output" ]
}

@test "injection_get_header_path returns empty for AGENTS.md" {
    # Test in subshell to avoid BATS associative array issues
    run bash -c "
        export CLEO_HOME='${PROJECT_ROOT}'
        source '${PROJECT_ROOT}/lib/injection-registry.sh'
        source '${PROJECT_ROOT}/lib/injection-config.sh'
        injection_get_header_path 'AGENTS.md'
    "
    assert_success
    [ -z "$output" ]
}

@test "injection_get_header_path returns path for GEMINI.md" {
    # Test in subshell to avoid BATS associative array issues
    run bash -c "
        export CLEO_HOME='${PROJECT_ROOT}'
        source '${PROJECT_ROOT}/lib/injection-registry.sh'
        source '${PROJECT_ROOT}/lib/injection-config.sh'
        injection_get_header_path 'GEMINI.md'
    "
    assert_success
    [ -n "$output" ]
    [[ "$output" =~ GEMINI-HEADER\.md$ ]]
}

# =============================================================================
# Marker Format Tests
# =============================================================================

@test "INJECTION_MARKER_START is defined" {
    [ -n "$INJECTION_MARKER_START" ]
}

@test "INJECTION_MARKER_END is defined" {
    [ -n "$INJECTION_MARKER_END" ]
}

@test "INJECTION_VERSION_PATTERN is defined" {
    [ -n "$INJECTION_VERSION_PATTERN" ]
}

@test "INJECTION_MARKER_START has HTML comment format" {
    [[ "$INJECTION_MARKER_START" =~ ^\<\!-- ]]
}

@test "INJECTION_MARKER_END has HTML comment format" {
    [[ "$INJECTION_MARKER_END" =~ ^\<\!-- ]]
    [[ "$INJECTION_MARKER_END" =~ --\>$ ]]
}

@test "INJECTION_VERSION_PATTERN matches semantic version" {
    local test_string="CLEO:START v1.2.3"
    [[ "$test_string" =~ $INJECTION_VERSION_PATTERN ]]
}
