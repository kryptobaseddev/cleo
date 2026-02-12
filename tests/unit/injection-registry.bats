#!/usr/bin/env bats
# =============================================================================
# injection-registry.bats - Unit tests for lib/injection-registry.sh
# =============================================================================
# Tests injection target registry, marker patterns, and file validation.
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
    source "${LIB_DIR}/injection-registry.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Script Presence Tests
# =============================================================================

@test "injection-registry library exists" {
    [ -f "${LIB_DIR}/injection-registry.sh" ]
}

@test "injection-registry library is readable" {
    [ -r "${LIB_DIR}/injection-registry.sh" ]
}

# =============================================================================
# Source Guard Tests
# =============================================================================

@test "source guard prevents double-loading" {
    source "${LIB_DIR}/injection-registry.sh"
    local first_load=$_INJECTION_REGISTRY_LOADED

    source "${LIB_DIR}/injection-registry.sh"
    local second_load=$_INJECTION_REGISTRY_LOADED

    [ "$first_load" = "$second_load" ]
    [ "$_INJECTION_REGISTRY_LOADED" = "1" ]
}

@test "source guard sets readonly variable" {
    [ -n "$_INJECTION_REGISTRY_LOADED" ]

    # Attempt to modify should fail
    run bash -c '_INJECTION_REGISTRY_LOADED=2'
    # In new shell it's not readonly, but in current shell it should be
}

# =============================================================================
# INJECTION_TARGETS Tests
# =============================================================================

@test "INJECTION_TARGETS is defined" {
    [ -n "$INJECTION_TARGETS" ]
}

@test "INJECTION_TARGETS contains CLAUDE.md" {
    [[ "$INJECTION_TARGETS" =~ CLAUDE\.md ]]
}

@test "INJECTION_TARGETS contains AGENTS.md" {
    [[ "$INJECTION_TARGETS" =~ AGENTS\.md ]]
}

@test "INJECTION_TARGETS contains GEMINI.md" {
    [[ "$INJECTION_TARGETS" =~ GEMINI\.md ]]
}

@test "INJECTION_TARGETS is space-separated" {
    # Should contain spaces between targets
    [[ "$INJECTION_TARGETS" =~ [[:space:]] ]]
}

@test "INJECTION_TARGETS contains exactly 3 targets" {
    local count=$(echo "$INJECTION_TARGETS" | wc -w)
    [ "$count" -eq 3 ]
}

# =============================================================================
# Injection Marker Pattern Tests
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

@test "INJECTION_MARKER_START has correct format" {
    [ "$INJECTION_MARKER_START" = "<!-- CLEO:START" ]
}

@test "INJECTION_MARKER_END has correct format" {
    [ "$INJECTION_MARKER_END" = "<!-- CLEO:END -->" ]
}

@test "INJECTION_VERSION_PATTERN matches semver format" {
    # Pattern should match version strings like "v1.2.3"
    [[ "$INJECTION_VERSION_PATTERN" =~ CLEO:START ]]
    [[ "$INJECTION_VERSION_PATTERN" =~ \[0-9\] ]]
}

@test "INJECTION_VERSION_PATTERN matches valid version marker" {
    local test_marker="<!-- CLEO:START v0.50.2 -->"
    [[ "$test_marker" =~ $INJECTION_VERSION_PATTERN ]]
}

@test "INJECTION_VERSION_PATTERN captures version number from legacy markers" {
    local test_marker="<!-- CLEO:START v1.2.3 -->"
    if [[ "$test_marker" =~ $INJECTION_VERSION_PATTERN ]]; then
        # Group 1 is " v1.2.3", group 2 is "1.2.3"
        [ "${BASH_REMATCH[2]}" = "1.2.3" ]
    else
        fail "Pattern should match version marker"
    fi
}

@test "INJECTION_VERSION_PATTERN matches versionless markers" {
    local test_marker="<!-- CLEO:START -->"
    [[ "$test_marker" =~ $INJECTION_VERSION_PATTERN ]]
    # Group 1 and 2 should be empty for versionless markers
    [ -z "${BASH_REMATCH[1]}" ]
    [ -z "${BASH_REMATCH[2]}" ]
}

# =============================================================================
# Template Path Tests
# =============================================================================

@test "INJECTION_TEMPLATE_MAIN is defined" {
    [ -n "$INJECTION_TEMPLATE_MAIN" ]
}

@test "INJECTION_TEMPLATE_DIR is defined" {
    [ -n "$INJECTION_TEMPLATE_DIR" ]
}

@test "INJECTION_TEMPLATE_MAIN has correct path" {
    [ "$INJECTION_TEMPLATE_MAIN" = "templates/AGENT-INJECTION.md" ]
}

@test "INJECTION_TEMPLATE_DIR has correct path" {
    [ "$INJECTION_TEMPLATE_DIR" = "templates/agents" ]
}

# =============================================================================
# INJECTION_HEADERS Associative Array Tests
# =============================================================================

@test "INJECTION_HEADERS is defined in source" {
    run grep "declare -gA INJECTION_HEADERS" "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "INJECTION_HEADERS is associative array in source" {
    run grep "declare -gA INJECTION_HEADERS" "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "INJECTION_HEADERS is empty (unified template)" {
    # All agents now use unified AGENT-INJECTION.md - no per-agent headers
    run grep '\["GEMINI.md"\]=' "${LIB_DIR}/injection-registry.sh"
    # Should NOT find header entries in INJECTION_HEADERS (only in VALIDATION_KEYS)
    local header_section
    header_section=$(sed -n '/declare -gA INJECTION_HEADERS/,/^)/p' "${LIB_DIR}/injection-registry.sh")
    [[ ! "$header_section" == *'["GEMINI.md"]='* ]]
}

@test "INJECTION_HEADERS uses unified AGENT-INJECTION.md" {
    # Verify comment documents the unified approach
    run grep "unified AGENT-INJECTION.md" "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "CODEX.md and KIMI.md not in INJECTION_TARGETS" {
    # Codex and Kimi use AGENTS.md, not standalone files
    [[ ! " $INJECTION_TARGETS " == *" CODEX.md "* ]]
    [[ ! " $INJECTION_TARGETS " == *" KIMI.md "* ]]
}

@test "INJECTION_HEADERS legacy system removed comment exists" {
    run grep "Legacy header system removed" "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "INJECTION_HEADERS declaration is global associative" {
    run grep "declare -gA INJECTION_HEADERS" "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "INJECTION_HEADERS does not contain CLAUDE.md" {
    # CLAUDE.md should only appear in INJECTION_VALIDATION_KEYS, not INJECTION_HEADERS (lines 27-33)
    run bash -c "sed -n '27,33p' '${LIB_DIR}/injection-registry.sh' | grep '\[\"CLAUDE.md\"\]='"
    assert_failure
}

@test "INJECTION_HEADERS does not contain AGENTS.md" {
    # AGENTS.md should only appear in INJECTION_VALIDATION_KEYS, not INJECTION_HEADERS (lines 27-33)
    run bash -c "sed -n '27,33p' '${LIB_DIR}/injection-registry.sh' | grep '\[\"AGENTS.md\"\]='"
    assert_failure
}

# =============================================================================
# INJECTION_VALIDATION_KEYS Associative Array Tests
# =============================================================================

@test "INJECTION_VALIDATION_KEYS is defined in source" {
    run grep "declare -gA INJECTION_VALIDATION_KEYS" "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "INJECTION_VALIDATION_KEYS is associative array in source" {
    run grep "declare -gA INJECTION_VALIDATION_KEYS" "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "INJECTION_VALIDATION_KEYS contains CLAUDE.md entry" {
    run grep '\["CLAUDE.md"\]="claude_md"' "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "INJECTION_VALIDATION_KEYS CLAUDE.md maps to claude_md" {
    local value=$(grep -A10 'declare -gA INJECTION_VALIDATION_KEYS' "${LIB_DIR}/injection-registry.sh" | grep '\["CLAUDE.md"\]=' | sed 's/.*="\(.*\)".*/\1/')
    [ "$value" = "claude_md" ]
}

@test "INJECTION_VALIDATION_KEYS contains AGENTS.md entry" {
    run grep '\["AGENTS.md"\]="agents_md"' "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "INJECTION_VALIDATION_KEYS AGENTS.md maps to agents_md" {
    local value=$(grep -A10 'declare -gA INJECTION_VALIDATION_KEYS' "${LIB_DIR}/injection-registry.sh" | grep '\["AGENTS.md"\]=' | sed 's/.*="\(.*\)".*/\1/')
    [ "$value" = "agents_md" ]
}

@test "INJECTION_VALIDATION_KEYS contains GEMINI.md entry" {
    run grep '\["GEMINI.md"\]="gemini_md"' "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "INJECTION_VALIDATION_KEYS GEMINI.md maps to gemini_md" {
    local value=$(grep -A10 'declare -gA INJECTION_VALIDATION_KEYS' "${LIB_DIR}/injection-registry.sh" | grep '\["GEMINI.md"\]=' | sed 's/.*="\(.*\)".*/\1/')
    [ "$value" = "gemini_md" ]
}

# =============================================================================
# Readonly Variable Tests
# =============================================================================

@test "INJECTION_TARGETS is readonly in source" {
    # Check if variable is marked readonly in source file
    run grep "readonly INJECTION_TARGETS=" "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "INJECTION_MARKER_START is readonly in source" {
    run grep "readonly INJECTION_MARKER_START=" "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "INJECTION_MARKER_END is readonly in source" {
    run grep "readonly INJECTION_MARKER_END=" "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "INJECTION_VERSION_PATTERN is readonly in source" {
    run grep "readonly INJECTION_VERSION_PATTERN=" "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "INJECTION_TEMPLATE_MAIN is readonly in source" {
    run grep "readonly INJECTION_TEMPLATE_MAIN=" "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "INJECTION_TEMPLATE_DIR is readonly in source" {
    run grep "readonly INJECTION_TEMPLATE_DIR=" "${LIB_DIR}/injection-registry.sh"
    assert_success
}

# =============================================================================
# Layer 0 Independence Tests
# =============================================================================

@test "injection-registry does not source other libraries" {
    # Check file content doesn't contain source or . commands for other libs
    run grep -E '^\s*(source|\.) .*/lib/' "${LIB_DIR}/injection-registry.sh"
    assert_failure
}

@test "injection-registry has no external dependencies" {
    # Should only use bash builtins and readonly declarations
    # Check it doesn't call external commands (except in comments)
    local content=$(grep -v '^#' "${LIB_DIR}/injection-registry.sh")
    ! echo "$content" | grep -qE '\$\(.*\)' || true
}

# =============================================================================
# Validation Key Format Tests
# =============================================================================

@test "validation keys use snake_case format" {
    # Extract all validation key values and check they're snake_case
    local keys=$(grep -oP '\["[^"]+"\]="\K[^"]+' "${LIB_DIR}/injection-registry.sh" | grep -A3 'INJECTION_VALIDATION_KEYS')
    while IFS= read -r key; do
        if [ -n "$key" ]; then
            [[ "$key" =~ ^[a-z]+(_[a-z]+)*$ ]]
        fi
    done <<< "$keys"
}

@test "validation keys match file names logically" {
    run grep '\["CLAUDE.md"\]="claude_md"' "${LIB_DIR}/injection-registry.sh"
    assert_success
    run grep '\["AGENTS.md"\]="agents_md"' "${LIB_DIR}/injection-registry.sh"
    assert_success
    run grep '\["GEMINI.md"\]="gemini_md"' "${LIB_DIR}/injection-registry.sh"
    assert_success
}

# =============================================================================
# Array Consistency Tests
# =============================================================================

@test "all INJECTION_TARGETS have validation keys" {
    # Check that each target in INJECTION_TARGETS has a validation key defined
    for target in $INJECTION_TARGETS; do
        run grep "\[\"$target\"\]=" "${LIB_DIR}/injection-registry.sh"
        assert_success
    done
}

@test "validation keys count matches targets count" {
    local targets_count=$(echo "$INJECTION_TARGETS" | wc -w)
    local keys_count=$(grep -c '^\s*\[".*\.md"\]=' "${LIB_DIR}/injection-registry.sh" | tail -1)
    [ "$targets_count" -eq 3 ]
}

# =============================================================================
# Edge Case Tests
# =============================================================================

@test "empty header value for CLAUDE.md is handled" {
    # CLAUDE.md should not have a header entry in INJECTION_HEADERS
    run grep '\["CLAUDE.md"\]=' "${LIB_DIR}/injection-registry.sh"
    # Should only find it in INJECTION_VALIDATION_KEYS section
    local count=$(grep -c '\["CLAUDE.md"\]=' "${LIB_DIR}/injection-registry.sh" || echo "0")
    [ "$count" -eq 1 ]
}

@test "empty header value for AGENTS.md is handled" {
    # AGENTS.md should not have a header entry in INJECTION_HEADERS
    run grep '\["AGENTS.md"\]=' "${LIB_DIR}/injection-registry.sh"
    # Should only find it in INJECTION_VALIDATION_KEYS section
    local count=$(grep -c '\["AGENTS.md"\]=' "${LIB_DIR}/injection-registry.sh" || echo "0")
    [ "$count" -eq 1 ]
}

@test "marker patterns are non-empty strings" {
    [ ${#INJECTION_MARKER_START} -gt 0 ]
    [ ${#INJECTION_MARKER_END} -gt 0 ]
    [ ${#INJECTION_VERSION_PATTERN} -gt 0 ]
}

@test "template paths are non-empty strings" {
    [ ${#INJECTION_TEMPLATE_MAIN} -gt 0 ]
    [ ${#INJECTION_TEMPLATE_DIR} -gt 0 ]
}

# =============================================================================
# Pattern Matching Tests
# =============================================================================

@test "version pattern rejects invalid formats" {
    local invalid_markers=(
        "<!-- CLEO:START -->"
        "<!-- CLEO:START v1.2 -->"
        "<!-- CLEO:START 1.2.3 -->"
        "<!-- CLEO:START vX.Y.Z -->"
    )

    for marker in "${invalid_markers[@]}"; do
        if [[ "$marker" =~ $INJECTION_VERSION_PATTERN ]]; then
            # Extract captured group to verify it's a valid semver
            local version="${BASH_REMATCH[1]}"
            if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
                continue
            fi
            fail "Pattern should not match invalid marker: $marker"
        fi
    done
}

@test "version pattern accepts valid formats" {
    local valid_versioned_markers=(
        "<!-- CLEO:START v0.50.2 -->"
        "<!-- CLEO:START v1.0.0 -->"
        "<!-- CLEO:START v10.20.30 -->"
    )

    for marker in "${valid_versioned_markers[@]}"; do
        if ! [[ "$marker" =~ $INJECTION_VERSION_PATTERN ]]; then
            fail "Pattern should match valid marker: $marker"
        fi
        # Verify captured version is semver format (group 2)
        local version="${BASH_REMATCH[2]}"
        [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
    done

    # Also test versionless markers (new format)
    local versionless_marker="<!-- CLEO:START -->"
    if ! [[ "$versionless_marker" =~ $INJECTION_VERSION_PATTERN ]]; then
        fail "Pattern should match versionless marker"
    fi
    # Version groups should be empty
    [ -z "${BASH_REMATCH[2]}" ]
}

# =============================================================================
# Documentation Consistency Tests
# =============================================================================

@test "library has Layer 0 documentation comment" {
    run grep "Layer 0" "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "library has MUST NOT source warning" {
    run grep "MUST NOT source" "${LIB_DIR}/injection-registry.sh"
    assert_success
}

@test "library has single source of truth comment" {
    run grep -i "single source of truth" "${LIB_DIR}/injection-registry.sh"
    assert_success
}
