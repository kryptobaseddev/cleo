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
    source "$LIB_DIR/core/error-json.sh"
    run type minimize_error_context
    [ "$status" -eq 0 ]
}

@test "is_verbose_mode function exists" {
    source "$LIB_DIR/core/error-json.sh"
    run type is_verbose_mode
    [ "$status" -eq 0 ]
}

@test "minimize_error_context handles null input" {
    source "$LIB_DIR/core/error-json.sh"

    result=$(minimize_error_context "null")
    [ "$result" = "null" ]

    result=$(minimize_error_context "")
    [ "$result" = "null" ]
}

@test "minimize_error_context creates smart session summaries" {
    source "$LIB_DIR/core/error-json.sh"

    # Full session object with verbose fields
    input='{"activeSessions":2,"sessions":[{"id":"sess1","name":"Auth-Work","scope":{"type":"epic","rootTaskId":"T001"},"focus":{"currentTask":"T005"},"stats":{"tasksCompleted":3},"startMetrics":{"tokens":1000}},{"id":"sess2","name":"UI-Fix","scope":{"type":"task","rootTaskId":"T050"},"focus":{"currentTask":"T050"},"stats":{"tasksCompleted":0}}],"name":"test"}'
    result=$(minimize_error_context "$input")

    # Should have sessions array (not sessionsCount) with smart summary
    sessions_type=$(echo "$result" | jq -r '.sessions | type')
    [ "$sessions_type" = "array" ]

    # Session should have decision-relevant fields only
    first_session=$(echo "$result" | jq -r '.sessions[0]')

    # Has id
    echo "$first_session" | jq -e '.id == "sess1"' >/dev/null

    # Has name (for intent matching)
    echo "$first_session" | jq -e '.name == "Auth-Work"' >/dev/null

    # Has scope (formatted as "type:rootTaskId")
    echo "$first_session" | jq -e '.scope == "epic:T001"' >/dev/null

    # Has focus (current task)
    echo "$first_session" | jq -e '.focus == "T005"' >/dev/null

    # Does NOT have verbose fields
    echo "$first_session" | jq -e '.stats == null' >/dev/null
    echo "$first_session" | jq -e '.startMetrics == null' >/dev/null

    # Should preserve scalar name
    name=$(echo "$result" | jq -r '.name')
    [ "$name" = "test" ]
}

@test "minimize_error_context adds verbose hint" {
    source "$LIB_DIR/core/error-json.sh"

    input='{"count":1}'
    result=$(minimize_error_context "$input")

    # Hint is stored as _hint (underscore prefix for metadata)
    hint=$(echo "$result" | jq -r '._hint // .hint // empty')
    [[ "$hint" == *"CLEO_VERBOSE"* ]] || [[ "$hint" == *"verbose"* ]]
}

@test "is_verbose_mode returns false when not set" {
    source "$LIB_DIR/core/error-json.sh"
    unset CLEO_VERBOSE
    unset VERBOSE

    run is_verbose_mode
    [ "$status" -ne 0 ]
}

@test "is_verbose_mode returns true when CLEO_VERBOSE=1" {
    source "$LIB_DIR/core/error-json.sh"
    export CLEO_VERBOSE=1

    run is_verbose_mode
    [ "$status" -eq 0 ]

    unset CLEO_VERBOSE
}

@test "is_verbose_mode returns true when CLEO_VERBOSE=true" {
    source "$LIB_DIR/core/error-json.sh"
    export CLEO_VERBOSE=true

    run is_verbose_mode
    [ "$status" -eq 0 ]

    unset CLEO_VERBOSE
}

# =============================================================================
# OUTPUT SIZE TESTS
# =============================================================================

@test "output_error_actionable uses minimal context by default" {
    source "$LIB_DIR/core/error-json.sh"
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

    # Should have hint (stored as _hint for metadata convention)
    hint=$(echo "$ctx" | jq -r '._hint // .hint // empty')
    [ -n "$hint" ]
}

@test "output_error_actionable includes full context when CLEO_VERBOSE=1" {
    source "$LIB_DIR/core/error-json.sh"
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
    source "$LIB_DIR/core/error-json.sh"
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
    source "$LIB_DIR/core/error-json.sh"
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
    source "$LIB_DIR/core/error-json.sh"
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
    source "$LIB_DIR/core/error-json.sh"
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
    source "$LIB_DIR/core/error-json.sh"
    export FORMAT=json
    export COMMAND_NAME="test"

    result=$(output_error_actionable "E_TEST" "Msg" "1" "true" "" "" "" "[]" || true)

    ctx=$(echo "$result" | jq -r '.error.context')
    [ "$ctx" = "null" ]
}

@test "Nested objects get keyCount" {
    source "$LIB_DIR/core/error-json.sh"

    input='{"config":{"a":1,"b":2,"c":3}}'
    result=$(minimize_error_context "$input")

    keys_count=$(echo "$result" | jq -r '.configKeys')
    [ "$keys_count" = "3" ]
}

@test "minimize_error_context creates smart epic summaries" {
    source "$LIB_DIR/core/error-json.sh"

    # Full epic object with verbose fields
    input='{"epics":[{"id":"T001","title":"EPIC: Authentication System Implementation","status":"pending","priority":"critical","childCount":15,"pendingCount":10,"notes":["long note 1","long note 2"]}]}'
    result=$(minimize_error_context "$input")

    # Should have epics array with smart summary
    epic=$(echo "$result" | jq -r '.epics[0]')

    # Has id
    echo "$epic" | jq -e '.id == "T001"' >/dev/null

    # Has truncated title (max 50 chars)
    title=$(echo "$epic" | jq -r '.title')
    [ "${#title}" -le 53 ]  # 50 + "..."

    # Has status
    echo "$epic" | jq -e '.status == "pending"' >/dev/null

    # Has pending count
    echo "$epic" | jq -e '.pending == 10' >/dev/null

    # Does NOT have verbose fields
    echo "$epic" | jq -e '.notes == null' >/dev/null
    echo "$epic" | jq -e '.childCount == null' >/dev/null
}

@test "Progressive disclosure: smart summary enables agent decision-making" {
    source "$LIB_DIR/core/error-json.sh"

    # Simulate real E_SESSION_DISCOVERY_MODE context
    input='{"activeSessions":3,"availableEpics":5,"sessions":[{"id":"sess1","name":"Auth-Epic","scope":{"type":"epic","rootTaskId":"T100"},"focus":{"currentTask":"T105"},"stats":{"completed":2}},{"id":"sess2","name":"UI-Work","scope":{"type":"epic","rootTaskId":"T200"},"focus":{"currentTask":"T210"},"stats":{"completed":0}}],"epics":[{"id":"T100","title":"Authentication Epic","status":"pending","pendingCount":5},{"id":"T200","title":"UI Refactor Epic","status":"pending","pendingCount":3}]}'

    result=$(minimize_error_context "$input")

    # Agent can find session by name
    auth_session=$(echo "$result" | jq -r '.sessions[] | select(.name == "Auth-Epic")')
    [ -n "$auth_session" ]

    # Agent can find session by scope
    epic_t100_session=$(echo "$result" | jq -r '.sessions[] | select(.scope == "epic:T100")')
    [ -n "$epic_t100_session" ]

    # Agent can find epic by title pattern
    auth_epic=$(echo "$result" | jq -r '.epics[] | select(.title | contains("Auth"))')
    [ -n "$auth_epic" ]

    # Agent can compare pending counts
    most_work_epic=$(echo "$result" | jq -r '.epics | sort_by(.pending) | reverse | .[0].id')
    [ "$most_work_epic" = "T100" ]
}
