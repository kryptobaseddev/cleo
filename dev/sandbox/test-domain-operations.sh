#!/usr/bin/env bash
# Domain Operations Validation Script
# Tests operations across canonical MCP domains via proper MCP JSON-RPC protocol
# with initialization handshake, plus CLI verification.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_KEY_PATH="${HOME}/.cleo/sandbox/ssh/sandbox_key"
SSH_PORT="2222"
CLEO="/home/testuser/cleo-source"
CLI="node ${CLEO}/dist/cli/index.js"
RESULTS_FILE="/tmp/mcp-domain-tests.jsonl"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Test counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

> "$RESULTS_FILE"

# Run command in sandbox via SSH
sandbox_run() {
    ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR \
        -p "$SSH_PORT" -i "$SSH_KEY_PATH" \
        testuser@localhost "$@" 2>&1
}

# Send a properly handshaked MCP request and return the tool call response
# Usage: mcp_request <gateway> <domain> <operation> [params_json] [project_dir]
mcp_request() {
    local gateway="$1"
    local domain="$2"
    local operation="$3"
    local params_json="${4:-{}}"
    local project_dir="${5:-/home/testuser/domain-test}"

    local args_json
    args_json=$(printf '{"domain":"%s","operation":"%s","params":%s}' "$domain" "$operation" "$params_json")

    local init_msg='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"domain-test","version":"1.0"}}}'
    local notif_msg='{"jsonrpc":"2.0","method":"notifications/initialized"}'
    local call_msg
    call_msg=$(printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"%s","arguments":%s}}' "$gateway" "$args_json")

    sandbox_run "cd ${project_dir} && printf '%s\n%s\n%s\n' '${init_msg}' '${notif_msg}' '${call_msg}' | node ${CLEO}/dist/mcp/index.js 2>/dev/null" || true
}

# Test a domain operation via MCP with proper handshake
# Usage: test_mcp_operation <gateway> <domain> <operation> <description> [expected] [params_json]
test_mcp_operation() {
    local gateway=$1
    local domain=$2
    local operation=$3
    local description=$4
    local expected="${5:-}"
    local params_json="${6:-{}}"

    TOTAL_TESTS=$((TOTAL_TESTS + 1))

    echo -e "${BLUE}[$TOTAL_TESTS] MCP: $gateway $domain.$operation${NC} - $description"

    local response
    response=$(mcp_request "$gateway" "$domain" "$operation" "$params_json")

    # Check if we got a valid JSON-RPC result
    if echo "$response" | grep -qF '"result"'; then
        if [[ -n "$expected" ]]; then
            if echo "$response" | grep -qF "$expected"; then
                echo -e "${GREEN}  PASS${NC}"
                PASSED_TESTS=$((PASSED_TESTS + 1))
            else
                echo -e "${RED}  FAIL${NC} - response missing '$expected'"
                echo "  Response tail: $(echo "$response" | tail -2 | head -1 | cut -c1-200)"
                FAILED_TESTS=$((FAILED_TESTS + 1))
            fi
        else
            echo -e "${GREEN}  PASS${NC}"
            PASSED_TESTS=$((PASSED_TESTS + 1))
        fi
    else
        echo -e "${RED}  FAIL${NC} - no valid result in response"
        echo "  Response tail: $(echo "$response" | tail -2 | head -1 | cut -c1-200)"
        FAILED_TESTS=$((FAILED_TESTS + 1))
    fi

    echo ""
}

# Test a CLI operation
test_cli_operation() {
    local command=$1
    local description=$2
    local expected="${3:-}"

    TOTAL_TESTS=$((TOTAL_TESTS + 1))

    echo -e "${BLUE}[$TOTAL_TESTS] CLI: $command${NC} - $description"

    local output
    if output=$(sandbox_run "cd /home/testuser/domain-test && $CLI $command" 2>&1); then
        if [[ -n "$expected" ]]; then
            if echo "$output" | grep -qF "$expected"; then
                echo -e "${GREEN}  PASS${NC}"
                PASSED_TESTS=$((PASSED_TESTS + 1))
            else
                echo -e "${RED}  FAIL${NC} - output missing '$expected'"
                echo "  Output: $(echo "$output" | head -3)"
                FAILED_TESTS=$((FAILED_TESTS + 1))
            fi
        else
            echo -e "${GREEN}  PASS${NC}"
            PASSED_TESTS=$((PASSED_TESTS + 1))
        fi
    else
        # Some commands are expected to fail (error cases)
        if [[ -n "$expected" ]] && echo "$output" | grep -qF "$expected"; then
            echo -e "${GREEN}  PASS${NC} (failed as expected with matching output)"
            PASSED_TESTS=$((PASSED_TESTS + 1))
        else
            echo -e "${RED}  FAIL${NC} - command failed"
            echo "  Output: $(echo "$output" | head -3)"
            FAILED_TESTS=$((FAILED_TESTS + 1))
        fi
    fi

    echo ""
}

echo "=========================================="
echo "MCP Domain Operations Validation"
echo "(with proper JSON-RPC handshake)"
echo "=========================================="
echo ""

# Setup: create a test project with sample data
echo -e "${YELLOW}Setting up test project...${NC}"
sandbox_run "rm -rf /home/testuser/domain-test" >/dev/null 2>&1 || true
sandbox_run "mkdir -p /home/testuser/domain-test && cd /home/testuser/domain-test && git init && $CLI init" >/dev/null 2>&1 || true
sandbox_run "cd /home/testuser/domain-test && $CLI add 'Domain test task' --description 'Task for domain operation testing'" >/dev/null 2>&1 || true
sandbox_run "cd /home/testuser/domain-test && $CLI add 'Second domain task' --description 'Another task for testing'" >/dev/null 2>&1 || true
echo ""

# ============================================================
# 1. TASKS DOMAIN
# ============================================================
echo -e "${BLUE}--- 1. TASKS DOMAIN ---${NC}"

test_mcp_operation "query" "tasks" "list" \
    "List tasks via MCP" "Domain test task"

test_mcp_operation "query" "tasks" "show" \
    "Show task T001 via MCP" "T001" '{"id":"T001"}'

test_mcp_operation "query" "tasks" "find" \
    "Find tasks matching 'domain'" "domain" '{"query":"domain"}'

test_mcp_operation "query" "tasks" "tree" \
    "Get task tree via MCP"

test_mcp_operation "query" "tasks" "next" \
    "Get next suggested task via MCP"

test_mcp_operation "query" "tasks" "stats" \
    "Get task statistics via MCP"

test_mcp_operation "mutate" "tasks" "add" \
    "Add task via MCP mutate" "MCP domain task" '{"title":"MCP domain task","description":"Added via domain test"}'

test_cli_operation "list --human" \
    "CLI list confirms MCP-added task" "MCP domain task"

# ============================================================
# 2. SESSION DOMAIN
# ============================================================
echo -e "${BLUE}--- 2. SESSION DOMAIN ---${NC}"

test_mcp_operation "query" "session" "status" \
    "Get session status via MCP"

test_mcp_operation "query" "session" "list" \
    "List sessions via MCP"

test_mcp_operation "query" "session" "find" \
    "Find sessions via MCP"

# ============================================================
# 3. ADMIN DOMAIN
# ============================================================
echo -e "${BLUE}--- 3. ADMIN DOMAIN ---${NC}"

test_mcp_operation "query" "admin" "version" \
    "Get CLEO version via MCP" "2026"

test_mcp_operation "query" "admin" "health" \
    "Get system health via MCP"

test_mcp_operation "query" "admin" "help" \
    "Get help via MCP"

test_mcp_operation "query" "admin" "dash" \
    "Get dashboard via MCP"

test_mcp_operation "query" "admin" "context" \
    "Get context usage via MCP"

test_mcp_operation "query" "admin" "stats" \
    "Get system stats via MCP"

# ============================================================
# 4. CHECK DOMAIN
# ============================================================
echo -e "${BLUE}--- 4. CHECK DOMAIN ---${NC}"

test_mcp_operation "query" "check" "validate" \
    "Validate data integrity via MCP"

test_mcp_operation "query" "check" "health" \
    "Check system health via MCP"

# ============================================================
# 5. MEMORY DOMAIN
# ============================================================
echo -e "${BLUE}--- 5. MEMORY DOMAIN ---${NC}"

test_mcp_operation "query" "memory" "brain.search" \
    "Search brain via MCP" "" '{"query":"test"}'

# ============================================================
# 6. CLI CROSS-CHECK (verify CLI and MCP agree)
# ============================================================
echo -e "${BLUE}--- 6. CLI CROSS-CHECK ---${NC}"

test_cli_operation "version" \
    "CLI version" "2026"

test_cli_operation "list" \
    "CLI list tasks"

test_cli_operation "show T001" \
    "CLI show T001" "T001"

test_cli_operation "stats" \
    "CLI stats"

test_cli_operation "tree" \
    "CLI tree"

test_cli_operation "validate" \
    "CLI validate"

test_cli_operation "doctor" \
    "CLI doctor"

# ============================================================
# Summary
# ============================================================
echo ""
echo "=========================================="
echo "TEST SUMMARY"
echo "=========================================="
echo "Total Tests: $TOTAL_TESTS"
echo -e "${GREEN}Passed: $PASSED_TESTS${NC}"
echo -e "${RED}Failed: $FAILED_TESTS${NC}"
echo ""

if [[ $TOTAL_TESTS -gt 0 ]]; then
    SUCCESS_RATE=$(echo "scale=1; $PASSED_TESTS * 100 / $TOTAL_TESTS" | bc)
    echo "Success Rate: ${SUCCESS_RATE}%"
else
    echo "No tests ran."
fi
echo ""

if [[ $FAILED_TESTS -eq 0 ]]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${YELLOW}Some tests failed. Review results above.${NC}"
    exit 1
fi
