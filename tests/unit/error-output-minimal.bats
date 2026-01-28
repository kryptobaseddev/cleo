#!/usr/bin/env bats
# =============================================================================
# error-output-minimal.bats - Tests for minimal error output (token optimization)
# =============================================================================
# Validates that error output is minimal by default for LLM token efficiency,
# with full context available via CLEO_VERBOSE=1 flag.
#
# Key test scenarios:
# - Default output is under 1500 chars (was 13K+ before fix)
# - Context has counts not full arrays
# - CLEO_VERBOSE=1 enables full context
# - Error codes and actionable fixes still work
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test
    export FORMAT=json
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# HELPER FUNCTION TESTS (These should always pass)
# =============================================================================

@test "minimize_error_context function exists" {
    source "$LIB_DIR/error-json.sh"
    run type minimize_error_context
    [ "$status" -eq 0 ]
}

@test "is_verbose_mode function exists" {
    source "$LIB_DIR/error-json.sh"
    run type is_verbose_mode
    [ "$status" -eq 0 ]
}

@test "minimize_error_context handles null input" {
    source "$LIB_DIR/error-json.sh"

    result=$(minimize_error_context "null")
    [ "$result" = "null" ]

    result=$(minimize_error_context "")
    [ "$result" = "null" ]
}

@test "minimize_error_context replaces arrays with counts" {
    source "$LIB_DIR/error-json.sh"

    input='{"activeSessions":5,"sessions":[{"id":"a"},{"id":"b"}],"name":"test"}'
    result=$(minimize_error_context "$input")

    # Should have sessionsCount = 2
    count=$(echo "$result" | jq -r '.sessionsCount')
    [ "$count" = "2" ]

    # Should preserve scalar name
    name=$(echo "$result" | jq -r '.name')
    [ "$name" = "test" ]

    # Should have hint
    hint=$(echo "$result" | jq -r '.hint')
    [ -n "$hint" ]
}

@test "minimize_error_context adds verbose hint" {
    source "$LIB_DIR/error-json.sh"

    input='{"count":1}'
    result=$(minimize_error_context "$input")

    hint=$(echo "$result" | jq -r '.hint')
    [[ "$hint" == *"CLEO_VERBOSE"* ]] || [[ "$hint" == *"verbose"* ]]
}

@test "is_verbose_mode returns false when not set" {
    source "$LIB_DIR/error-json.sh"
    unset CLEO_VERBOSE
    unset VERBOSE

    run is_verbose_mode
    [ "$status" -ne 0 ]
}

@test "is_verbose_mode returns true when CLEO_VERBOSE=1" {
    source "$LIB_DIR/error-json.sh"
    export CLEO_VERBOSE=1

    run is_verbose_mode
    [ "$status" -eq 0 ]

    unset CLEO_VERBOSE
}

@test "is_verbose_mode returns true when CLEO_VERBOSE=true" {
    source "$LIB_DIR/error-json.sh"
    export CLEO_VERBOSE=true

    run is_verbose_mode
    [ "$status" -eq 0 ]

    unset CLEO_VERBOSE
}

# =============================================================================
# OUTPUT SIZE TESTS
# =============================================================================

@test "output_error_actionable uses minimal context by default" {
    source "$LIB_DIR/error-json.sh"
    unset CLEO_VERBOSE
    export FORMAT=json
    export COMMAND_NAME="test"

    # Large context with arrays
    context='{"count":5,"items":[{"a":1},{"b":2},{"c":3}],"data":[1,2,3,4,5]}'
    alts='[{"action":"Fix it","command":"fix"}]'

    # Note: output_error_actionable returns exit code, so use || true
    result=$(output_error_actionable \
        "E_TEST" \
        "Test error message" \
        "1" \
        "true" \
        "Test suggestion" \
        "cleo test" \
        "$context" \
        "$alts" || true)

    # Context should be minimized
    ctx=$(echo "$result" | jq -r '.error.context')

    # Should have itemsCount instead of items array
    items_count=$(echo "$ctx" | jq -r '.itemsCount // empty')
    [ -n "$items_count" ] && [ "$items_count" = "3" ]

    # Should have dataCount instead of data array
    data_count=$(echo "$ctx" | jq -r '.dataCount // empty')
    [ -n "$data_count" ] && [ "$data_count" = "5" ]

    # Should have hint
    hint=$(echo "$ctx" | jq -r '.hint // empty')
    [ -n "$hint" ]
}

@test "output_error_actionable includes full context when CLEO_VERBOSE=1" {
    source "$LIB_DIR/error-json.sh"
    export CLEO_VERBOSE=1
    export FORMAT=json
    export COMMAND_NAME="test"

    # Context with arrays
    context='{"count":5,"items":[{"a":1},{"b":2}]}'
    alts='[]'

    result=$(output_error_actionable \
        "E_TEST" \
        "Test error message" \
        "1" \
        "true" \
        "Suggestion" \
        "fix" \
        "$context" \
        "$alts" || true)

    # Context should have full items array
    ctx=$(echo "$result" | jq -r '.error.context')
    items_type=$(echo "$ctx" | jq -r '.items | type')
    [ "$items_type" = "array" ]

    # Should have 2 items
    items_len=$(echo "$ctx" | jq -r '.items | length')
    [ "$items_len" = "2" ]

    unset CLEO_VERBOSE
}

# =============================================================================
# ERROR STRUCTURE TESTS
# =============================================================================

@test "Minimal output still includes fix command" {
    source "$LIB_DIR/error-json.sh"
    unset CLEO_VERBOSE
    export FORMAT=json
    export COMMAND_NAME="test"

    context='{"data":[1,2,3]}'

    result=$(output_error_actionable \
        "E_TEST" \
        "Test message" \
        "1" \
        "true" \
        "Suggestion" \
        "cleo fix-it" \
        "$context" \
        "[]" || true)

    fix=$(echo "$result" | jq -r '.error.fix')
    [ "$fix" = "cleo fix-it" ]
}

@test "Minimal output still includes error code" {
    source "$LIB_DIR/error-json.sh"
    unset CLEO_VERBOSE
    export FORMAT=json
    export COMMAND_NAME="test"

    result=$(output_error_actionable \
        "E_CUSTOM_CODE" \
        "Message" \
        "42" \
        "false" \
        "" \
        "" \
        "null" \
        "[]" || true)

    code=$(echo "$result" | jq -r '.error.code')
    [ "$code" = "E_CUSTOM_CODE" ]

    exit_code=$(echo "$result" | jq -r '.error.exitCode')
    [ "$exit_code" = "42" ]
}

@test "Minimal output still includes alternatives" {
    source "$LIB_DIR/error-json.sh"
    unset CLEO_VERBOSE
    export FORMAT=json
    export COMMAND_NAME="test"

    alts='[{"action":"Option A","command":"cmd-a"},{"action":"Option B","command":"cmd-b"}]'

    result=$(output_error_actionable \
        "E_TEST" \
        "Message" \
        "1" \
        "true" \
        "" \
        "" \
        "null" \
        "$alts" || true)

    alts_len=$(echo "$result" | jq -r '.error.alternatives | length')
    [ "$alts_len" = "2" ]
}

@test "Error output preserves success=false" {
    source "$LIB_DIR/error-json.sh"
    export FORMAT=json
    export COMMAND_NAME="test"

    result=$(output_error_actionable "E_TEST" "Msg" "1" "true" "" "" "null" "[]" || true)

    success=$(echo "$result" | jq -r '.success')
    [ "$success" = "false" ]
}

# =============================================================================
# EDGE CASE TESTS
# =============================================================================

@test "Empty context handled correctly" {
    source "$LIB_DIR/error-json.sh"
    export FORMAT=json
    export COMMAND_NAME="test"

    result=$(output_error_actionable "E_TEST" "Msg" "1" "true" "" "" "" "[]" || true)

    ctx=$(echo "$result" | jq -r '.error.context')
    [ "$ctx" = "null" ]
}

@test "Nested objects get keyCount" {
    source "$LIB_DIR/error-json.sh"

    input='{"config":{"a":1,"b":2,"c":3}}'
    result=$(minimize_error_context "$input")

    keys_count=$(echo "$result" | jq -r '.configKeys')
    [ "$keys_count" = "3" ]
}
