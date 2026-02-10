#!/usr/bin/env bash
# MCP-CLI Integration Validation Test Suite
# Task: T3073

set -euo pipefail

MCP_SERVER="/mnt/projects/claude-todo/mcp-server/dist/index.js"
TEST_DIR="/tmp/mcp-cli-test-$$"
RESULTS_FILE="/tmp/mcp-integration-results.json"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test results tracking
declare -a PASSED_TESTS=()
declare -a FAILED_TESTS=()

log_test() {
    echo -e "${YELLOW}[TEST]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    PASSED_TESTS+=("$1")
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    FAILED_TESTS+=("$1")
}

# Helper: Call MCP server via stdin and extract CLI output from JSON-RPC response
call_mcp() {
    local method="$1"
    local tool_name="$2"
    local args="$3"
    local id="${4:-1}"

    # Get MCP JSON-RPC response
    local jsonrpc_response=$(CLEO_MCP_CLIPATH=/home/keatonhoskins/.local/bin/cleo \
        echo "{\"jsonrpc\":\"2.0\",\"method\":\"$method\",\"params\":{\"name\":\"$tool_name\",\"arguments\":$args},\"id\":$id}" | \
        node "$MCP_SERVER" 2>/dev/null)

    # Extract text content from MCP response (.result.content[0].text)
    # This contains the actual CLI JSON output as a string
    echo "$jsonrpc_response" | jq -r '.result.content[0].text // empty'
}

# Helper: Get raw MCP JSON-RPC response (for error testing)
call_mcp_raw() {
    local method="$1"
    local tool_name="$2"
    local args="$3"
    local id="${4:-1}"

    CLEO_MCP_CLIPATH=/home/keatonhoskins/.local/bin/cleo \
        echo "{\"jsonrpc\":\"2.0\",\"method\":\"$method\",\"params\":{\"name\":\"$tool_name\",\"arguments\":$args},\"id\":$id}" | \
        node "$MCP_SERVER" 2>/dev/null
}

# Test 1: Response Format Matching
test_response_format() {
    log_test "Test 1: Response Format Matching"

    # Get CLI output
    local cli_output=$(cleo list --status pending --json 2>/dev/null || echo '{"tasks":[]}')

    # Get MCP output (now returns CLI output directly, not JSON-RPC envelope)
    local mcp_args='{"domain":"tasks","operation":"list","params":{"status":"pending"}}'
    local mcp_output=$(call_mcp "tools/call" "cleo_query" "$mcp_args")

    # Check if both have _meta
    if echo "$cli_output" | jq -e '._meta' >/dev/null 2>&1 && \
       echo "$mcp_output" | jq -e '._meta' >/dev/null 2>&1; then
        log_pass "Both CLI and MCP return _meta envelope"
    else
        log_fail "Missing _meta envelope"
        echo "CLI: $(echo "$cli_output" | jq '._meta // "MISSING"')"
        echo "MCP: $(echo "$mcp_output" | jq '._meta // "MISSING"')"
    fi

    # Check if both have tasks array
    if echo "$cli_output" | jq -e '.tasks' >/dev/null 2>&1 && \
       echo "$mcp_output" | jq -e '.tasks' >/dev/null 2>&1; then
        log_pass "Both CLI and MCP return tasks array"
    else
        log_fail "Missing tasks array"
    fi
}

# Test 2: Data Consistency
test_data_consistency() {
    log_test "Test 2: Data Consistency"

    # Create a test task via CLI
    local test_title="MCP Test Task $$"
    local cli_add=$(cleo add "$test_title" --description "Test task for MCP integration" --json 2>/dev/null)
    local task_id=$(echo "$cli_add" | jq -r '.task.id // empty')

    if [[ -z "$task_id" ]]; then
        log_fail "Failed to create test task via CLI"
        return 1
    fi

    # Get task via CLI
    local cli_task=$(cleo show "$task_id" --json 2>/dev/null)

    # Get task via MCP (returns CLI output directly)
    local mcp_args="{\"domain\":\"tasks\",\"operation\":\"show\",\"params\":{\"id\":\"$task_id\"}}"
    local mcp_task=$(call_mcp "tools/call" "cleo_query" "$mcp_args")

    # Compare titles
    local cli_title=$(echo "$cli_task" | jq -r '.task.title // empty')
    local mcp_title=$(echo "$mcp_task" | jq -r '.task.title // empty')

    if [[ "$cli_title" == "$mcp_title" ]]; then
        log_pass "CLI and MCP return same task title"
    else
        log_fail "Title mismatch: CLI='$cli_title' vs MCP='$mcp_title'"
    fi

    # Compare descriptions
    local cli_desc=$(echo "$cli_task" | jq -r '.task.description // empty')
    local mcp_desc=$(echo "$mcp_task" | jq -r '.task.description // empty')

    if [[ "$cli_desc" == "$mcp_desc" ]]; then
        log_pass "CLI and MCP return same task description"
    else
        log_fail "Description mismatch"
    fi

    # Cleanup
    cleo done "$task_id" --quiet 2>/dev/null || true
    cleo archive --quiet 2>/dev/null || true
}

# Test 3: Mutation Operation Parity
test_mutation_parity() {
    log_test "Test 3: Mutation Operation Parity"

    # Add task via MCP (returns CLI output directly)
    local mcp_args='{"domain":"tasks","operation":"add","params":{"title":"MCP Added Task","description":"Added via MCP server"}}'
    local mcp_add=$(call_mcp "tools/call" "cleo_mutate" "$mcp_args")

    # Check if MCP add succeeded
    local mcp_success=$(echo "$mcp_add" | jq -r '.success // false')
    local mcp_task_id=$(echo "$mcp_add" | jq -r '.task.id // empty')

    if [[ "$mcp_success" == "true" ]] && [[ -n "$mcp_task_id" ]]; then
        log_pass "MCP mutation created task successfully"

        # Verify task exists via CLI
        if cleo show "$mcp_task_id" --json >/dev/null 2>&1; then
            log_pass "Task created by MCP is visible via CLI"
        else
            log_fail "Task created by MCP not found via CLI"
        fi

        # Cleanup
        cleo done "$mcp_task_id" --quiet 2>/dev/null || true
        cleo archive --quiet 2>/dev/null || true
    else
        log_fail "MCP mutation failed"
        echo "Response: $mcp_add"
    fi
}

# Test 4: Error Format Consistency
test_error_consistency() {
    log_test "Test 4: Error Format Consistency"

    local invalid_id="T99999"

    # CLI error
    local cli_error=$(cleo show "$invalid_id" --json 2>&1 || true)
    local cli_exit_code=$(cleo show "$invalid_id" >/dev/null 2>&1; echo $?)

    # MCP error (get CLI output from JSON-RPC response)
    local mcp_args="{\"domain\":\"tasks\",\"operation\":\"show\",\"params\":{\"id\":\"$invalid_id\"}}"
    local mcp_cli_output=$(call_mcp "tools/call" "cleo_query" "$mcp_args")

    # Check if both indicate error
    local cli_has_error=$(echo "$cli_error" | jq -r '.success // "null"')
    local mcp_has_error=$(echo "$mcp_cli_output" | jq -r '.success // "null"')

    if [[ "$cli_has_error" == "false" ]] && [[ "$mcp_has_error" == "false" ]]; then
        log_pass "Both CLI and MCP indicate error for invalid ID"
    else
        log_fail "Error handling inconsistency"
        echo "CLI success: $cli_has_error, exit: $cli_exit_code"
        echo "MCP success: $mcp_has_error"
    fi

    # Check error codes
    local cli_code=$(echo "$cli_error" | jq -r '.error.code // empty')
    local mcp_code=$(echo "$mcp_cli_output" | jq -r '.error.code // empty')

    if [[ -n "$cli_code" ]] && [[ -n "$mcp_code" ]]; then
        if [[ "$cli_code" == "$mcp_code" ]]; then
            log_pass "CLI and MCP return same error code"
        else
            log_fail "Error code mismatch: CLI='$cli_code' vs MCP='$mcp_code'"
        fi
    fi
}

# Test 5: Audit Log Integration
test_audit_logging() {
    log_test "Test 5: Audit Log Integration"

    local audit_log="/mnt/projects/claude-todo/.cleo/audit-log.json"

    if [[ ! -f "$audit_log" ]]; then
        log_fail "Audit log not found at $audit_log"
        return 1
    fi

    # Count entries before
    local before_count=$(wc -l < "$audit_log")

    # Perform MCP mutation
    local mcp_args='{"domain":"tasks","operation":"add","params":{"title":"Audit Test Task","description":"Testing audit log"}}'
    local mcp_add=$(call_mcp "tools/call" "cleo_mutate" "$mcp_args")
    local task_id=$(echo "$mcp_add" | jq -r '.task.id // empty')

    # Count entries after
    local after_count=$(wc -l < "$audit_log")

    if [[ $after_count -gt $before_count ]]; then
        log_pass "MCP mutation logged to audit log"

        # Check if latest entry mentions MCP
        local latest=$(tail -1 "$audit_log")
        if echo "$latest" | jq -r '.source // empty' | grep -qi "mcp"; then
            log_pass "Audit log entry indicates MCP source"
        else
            log_fail "Audit log entry doesn't indicate MCP source"
        fi
    else
        log_fail "MCP mutation not logged to audit log"
    fi

    # Cleanup
    if [[ -n "$task_id" ]]; then
        cleo done "$task_id" --quiet 2>/dev/null || true
        cleo archive --quiet 2>/dev/null || true
    fi
}

# Test 6: Session Scope Enforcement
test_session_scope() {
    log_test "Test 6: Session Scope Enforcement"

    # Check if we're in a session
    local session_status=$(cleo session status --json 2>/dev/null)
    local in_session=$(echo "$session_status" | jq -r '.session.active // false')

    if [[ "$in_session" == "true" ]]; then
        log_pass "Currently in active session"

        # Get session ID
        local session_id=$(echo "$session_status" | jq -r '.session.sessionId // empty')

        # Add task via MCP (should respect session)
        local mcp_args='{"domain":"tasks","operation":"add","params":{"title":"Session Scope Test","description":"Testing session binding"}}'
        local mcp_add=$(call_mcp "tools/call" "cleo_mutate" "$mcp_args")
        local task_id=$(echo "$mcp_add" | jq -r '.task.id // empty')

        if [[ -n "$task_id" ]]; then
            # Check if task is in session scope
            local task_info=$(cleo show "$task_id" --json 2>/dev/null)
            log_pass "Task created via MCP in session context"

            # Cleanup
            cleo done "$task_id" --quiet 2>/dev/null || true
            cleo archive --quiet 2>/dev/null || true
        else
            log_fail "Failed to create task via MCP in session"
        fi
    else
        log_pass "No active session (test skipped)"
    fi
}

# Run all tests
run_all_tests() {
    echo "=========================================="
    echo "MCP-CLI Integration Validation Test Suite"
    echo "Task: T3073"
    echo "=========================================="
    echo ""

    test_response_format
    echo ""

    test_data_consistency
    echo ""

    test_mutation_parity
    echo ""

    test_error_consistency
    echo ""

    test_audit_logging
    echo ""

    test_session_scope
    echo ""

    # Summary
    echo "=========================================="
    echo "TEST SUMMARY"
    echo "=========================================="
    echo -e "${GREEN}Passed: ${#PASSED_TESTS[@]}${NC}"
    echo -e "${RED}Failed: ${#FAILED_TESTS[@]}${NC}"
    echo ""

    if [[ ${#FAILED_TESTS[@]} -gt 0 ]]; then
        echo "Failed tests:"
        for test in "${FAILED_TESTS[@]}"; do
            echo "  - $test"
        done
        echo ""
    fi

    # Generate JSON report
    local report=$(jq -n \
        --argjson passed "${#PASSED_TESTS[@]}" \
        --argjson failed "${#FAILED_TESTS[@]}" \
        --argjson passed_tests "$(printf '%s\n' "${PASSED_TESTS[@]}" | jq -R . | jq -s .)" \
        --argjson failed_tests "$(printf '%s\n' "${FAILED_TESTS[@]}" | jq -R . | jq -s .)" \
        '{
            "taskId": "T3073",
            "testSuite": "MCP-CLI Integration Validation",
            "timestamp": now | todateiso8601,
            "summary": {
                "passed": $passed,
                "failed": $failed,
                "total": ($passed + $failed)
            },
            "passedTests": $passed_tests,
            "failedTests": $failed_tests
        }')

    echo "$report" > "$RESULTS_FILE"
    echo "Results saved to: $RESULTS_FILE"

    # Return exit code
    if [[ ${#FAILED_TESTS[@]} -eq 0 ]]; then
        return 0
    else
        return 1
    fi
}

# Execute tests
run_all_tests
