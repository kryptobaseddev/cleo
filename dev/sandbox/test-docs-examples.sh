#!/usr/bin/env bash
# Test documentation examples from USAGE-GUIDE.md and README.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MCP_SERVER="${PROJECT_ROOT}/mcp-server/dist/index.js"
TEST_RESULTS=()
TESTS_PASSED=0
TESTS_FAILED=0

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_test() {
    local status=$1
    local name=$2
    local message=$3

    if [[ "$status" == "PASS" ]]; then
        echo -e "${GREEN}✓${NC} $name"
        ((TESTS_PASSED++))
    elif [[ "$status" == "FAIL" ]]; then
        echo -e "${RED}✗${NC} $name"
        echo -e "  ${RED}Error:${NC} $message"
        ((TESTS_FAILED++))
    else
        echo -e "${YELLOW}⊘${NC} $name - $message"
    fi

    TEST_RESULTS+=("$status|$name|$message")
}

# Test 1: System Version (QUICK-START.md line 47-52)
test_system_version() {
    echo ""
    echo "Testing: System Version Query (QUICK-START.md)"

    local request='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"cleo_query","arguments":{"domain":"system","operation":"version"}}}'

    local response=$(echo "$request" | node "$MCP_SERVER" 2>/dev/null || echo '{"error":"failed"}')

    if echo "$response" | jq -e '.result.content[0].text' &>/dev/null; then
        local result=$(echo "$response" | jq -r '.result.content[0].text')
        if echo "$result" | jq -e '.success == true and .data.version' &>/dev/null; then
            log_test "PASS" "System Version Query" "Returned version data"
        else
            log_test "FAIL" "System Version Query" "Invalid response structure: $result"
        fi
    else
        log_test "FAIL" "System Version Query" "No valid response: $response"
    fi
}

# Test 2: Task Find (README.md line 80-85)
test_task_find() {
    echo ""
    echo "Testing: Task Find Operation (README.md)"

    local request='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"cleo_query","arguments":{"domain":"tasks","operation":"find","params":{"query":"validation"}}}}'

    local response=$(echo "$request" | node "$MCP_SERVER" 2>/dev/null || echo '{"error":"failed"}')

    if echo "$response" | jq -e '.result.content[0].text' &>/dev/null; then
        local result=$(echo "$response" | jq -r '.result.content[0].text')
        if echo "$result" | jq -e '.success == true' &>/dev/null; then
            log_test "PASS" "Task Find Operation" "Successfully found tasks"
        else
            log_test "FAIL" "Task Find Operation" "Query failed: $result"
        fi
    else
        log_test "FAIL" "Task Find Operation" "No valid response: $response"
    fi
}

# Test 3: Task Get (task-management.md line 42-46)
test_task_get() {
    echo ""
    echo "Testing: Task Get Operation (task-management.md)"

    local request='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"cleo_query","arguments":{"domain":"tasks","operation":"get","params":{"taskId":"T3074"}}}}'

    local response=$(echo "$request" | node "$MCP_SERVER" 2>/dev/null || echo '{"error":"failed"}')

    if echo "$response" | jq -e '.result.content[0].text' &>/dev/null; then
        local result=$(echo "$response" | jq -r '.result.content[0].text')
        if echo "$result" | jq -e '.success == true and .data.task.id == "T3074"' &>/dev/null; then
            log_test "PASS" "Task Get Operation" "Retrieved task T3074"
        else
            log_test "FAIL" "Task Get Operation" "Failed to get task: $result"
        fi
    else
        log_test "FAIL" "Task Get Operation" "No valid response: $response"
    fi
}

# Test 4: Session Status (USAGE-GUIDE.md line 553-556)
test_session_status() {
    echo ""
    echo "Testing: Session Status Query (USAGE-GUIDE.md)"

    local request='{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"cleo_query","arguments":{"domain":"session","operation":"status"}}}'

    local response=$(echo "$request" | node "$MCP_SERVER" 2>/dev/null || echo '{"error":"failed"}')

    if echo "$response" | jq -e '.result.content[0].text' &>/dev/null; then
        local result=$(echo "$response" | jq -r '.result.content[0].text')
        if echo "$result" | jq -e '.success == true' &>/dev/null; then
            log_test "PASS" "Session Status Query" "Retrieved session status"
        else
            log_test "FAIL" "Session Status Query" "Query failed: $result"
        fi
    else
        log_test "FAIL" "Session Status Query" "No valid response: $response"
    fi
}

# Test 5: Task Exists Check (task-management.md line 445-449)
test_task_exists() {
    echo ""
    echo "Testing: Task Exists Check (task-management.md)"

    local request='{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"cleo_query","arguments":{"domain":"tasks","operation":"exists","params":{"taskId":"T3074"}}}}'

    local response=$(echo "$request" | node "$MCP_SERVER" 2>/dev/null || echo '{"error":"failed"}')

    if echo "$response" | jq -e '.result.content[0].text' &>/dev/null; then
        local result=$(echo "$response" | jq -r '.result.content[0].text')
        if echo "$result" | jq -e '.success == true and .data.exists == true' &>/dev/null; then
            log_test "PASS" "Task Exists Check" "Task T3074 exists"
        else
            log_test "FAIL" "Task Exists Check" "Task check failed: $result"
        fi
    else
        log_test "FAIL" "Task Exists Check" "No valid response: $response"
    fi
}

# Test 6: Task Dependencies (task-management.md line 197-203)
test_task_deps() {
    echo ""
    echo "Testing: Task Dependencies Query (task-management.md)"

    local request='{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"cleo_query","arguments":{"domain":"tasks","operation":"deps","params":{"taskId":"T3074","direction":"both"}}}}'

    local response=$(echo "$request" | node "$MCP_SERVER" 2>/dev/null || echo '{"error":"failed"}')

    if echo "$response" | jq -e '.result.content[0].text' &>/dev/null; then
        local result=$(echo "$response" | jq -r '.result.content[0].text')
        if echo "$result" | jq -e '.success == true' &>/dev/null; then
            log_test "PASS" "Task Dependencies Query" "Retrieved dependencies"
        else
            log_test "FAIL" "Task Dependencies Query" "Query failed: $result"
        fi
    else
        log_test "FAIL" "Task Dependencies Query" "No valid response: $response"
    fi
}

# Test 7: Lifecycle Status Check (USAGE-GUIDE.md line 779-784)
test_lifecycle_status() {
    echo ""
    echo "Testing: Lifecycle Status Check (USAGE-GUIDE.md)"

    local request='{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"cleo_query","arguments":{"domain":"lifecycle","operation":"status","params":{"taskId":"T3074"}}}}'

    local response=$(echo "$request" | node "$MCP_SERVER" 2>/dev/null || echo '{"error":"failed"}')

    if echo "$response" | jq -e '.result.content[0].text' &>/dev/null; then
        local result=$(echo "$response" | jq -r '.result.content[0].text')
        if echo "$result" | jq -e '.success == true' &>/dev/null; then
            log_test "PASS" "Lifecycle Status Check" "Retrieved lifecycle state"
        else
            log_test "FAIL" "Lifecycle Status Check" "Query failed: $result"
        fi
    else
        log_test "FAIL" "Lifecycle Status Check" "No valid response: $response"
    fi
}

# Test 8: Error Response Format (README.md line 223-240)
test_error_format() {
    echo ""
    echo "Testing: Error Response Format (README.md)"

    # Use non-existent task to trigger error
    local request='{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"cleo_query","arguments":{"domain":"tasks","operation":"get","params":{"taskId":"T9999999"}}}}'

    local response=$(echo "$request" | node "$MCP_SERVER" 2>/dev/null || echo '{"error":"failed"}')

    if echo "$response" | jq -e '.result.content[0].text' &>/dev/null; then
        local result=$(echo "$response" | jq -r '.result.content[0].text')
        if echo "$result" | jq -e '.success == false and .error.code and .error.message and .error.exitCode' &>/dev/null; then
            log_test "PASS" "Error Response Format" "Error format matches docs"
        else
            log_test "FAIL" "Error Response Format" "Error format incorrect: $result"
        fi
    else
        log_test "FAIL" "Error Response Format" "No valid response: $response"
    fi
}

# Run all tests
echo "========================================="
echo "Documentation Examples Validation Tests"
echo "========================================="

test_system_version
test_task_find
test_task_get
test_session_status
test_task_exists
test_task_deps
test_lifecycle_status
test_error_format

# Summary
echo ""
echo "========================================="
echo "Test Summary"
echo "========================================="
echo -e "${GREEN}Passed:${NC} $TESTS_PASSED"
echo -e "${RED}Failed:${NC} $TESTS_FAILED"
echo "Total: $((TESTS_PASSED + TESTS_FAILED))"
echo ""

if [[ $TESTS_FAILED -gt 0 ]]; then
    exit 1
else
    exit 0
fi
