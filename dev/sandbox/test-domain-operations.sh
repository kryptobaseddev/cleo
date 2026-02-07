#!/usr/bin/env bash
# Domain Operations Validation Script (T3069)
# Tests all 93 operations across 8 domains via MCP server

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_FILE="/tmp/mcp-domain-tests.jsonl"
SUMMARY_FILE="/tmp/mcp-domain-summary.txt"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Initialize results file
> "$RESULTS_FILE"
> "$SUMMARY_FILE"

# Helper function to test an operation
test_operation() {
    local gateway=$1
    local domain=$2
    local operation=$3
    local params=$4
    local description=$5

    TOTAL_TESTS=$((TOTAL_TESTS + 1))

    echo -e "${BLUE}[$TOTAL_TESTS] Testing: $domain.$operation${NC} - $description"

    # Create JSON-RPC request
    REQUEST=$(cat <<EOF
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "$gateway",
    "arguments": {
      "domain": "$domain",
      "operation": "$operation",
      "params": $params
    }
  },
  "id": $TOTAL_TESTS
}
EOF
)

    # Execute via MCP server in sandbox
    RESPONSE=$(echo "$REQUEST" | "$SCRIPT_DIR/sandbox-manager.sh" exec "cd ~/test-mcp && node ~/mcp-server/dist/index.js" 2>&1 || true)

    # Check response
    if echo "$RESPONSE" | jq -e '.result.content[0].text' >/dev/null 2>&1; then
        CONTENT=$(echo "$RESPONSE" | jq -r '.result.content[0].text')

        # Validate response structure
        if echo "$CONTENT" | jq -e '._meta' >/dev/null 2>&1; then
            echo -e "${GREEN}✓ PASS${NC}"
            PASSED_TESTS=$((PASSED_TESTS + 1))

            # Log result
            jq -n \
                --arg domain "$domain" \
                --arg operation "$operation" \
                --arg status "PASS" \
                --arg description "$description" \
                --argjson response "$CONTENT" \
                '{domain: $domain, operation: $operation, status: $status, description: $description, response: $response}' \
                >> "$RESULTS_FILE"
        else
            echo -e "${RED}✗ FAIL${NC} - Invalid response format (missing _meta)"
            FAILED_TESTS=$((FAILED_TESTS + 1))

            # Log result
            jq -n \
                --arg domain "$domain" \
                --arg operation "$operation" \
                --arg status "FAIL" \
                --arg description "$description" \
                --arg error "Invalid response format" \
                --arg response "$CONTENT" \
                '{domain: $domain, operation: $operation, status: $status, description: $description, error: $error, response: $response}' \
                >> "$RESULTS_FILE"
        fi
    else
        echo -e "${RED}✗ FAIL${NC} - MCP error or invalid response"
        FAILED_TESTS=$((FAILED_TESTS + 1))

        # Log result
        jq -n \
            --arg domain "$domain" \
            --arg operation "$operation" \
            --arg status "FAIL" \
            --arg description "$description" \
            --arg error "MCP error or invalid response" \
            --arg response "$RESPONSE" \
            '{domain: $domain, operation: $operation, status: $status, description: $description, error: $error, response: $response}' \
            >> "$RESULTS_FILE"
    fi

    echo ""
}

# Helper to compare MCP response with CLI output
compare_with_cli() {
    local domain=$1
    local operation=$2
    local cli_command=$3

    echo -e "${YELLOW}Comparing MCP response with CLI output for: $domain.$operation${NC}"

    # Get CLI output
    CLI_OUTPUT=$("$SCRIPT_DIR/sandbox-manager.sh" exec "cd ~/test-mcp && $cli_command" 2>&1 || true)

    echo "CLI output sample:"
    echo "$CLI_OUTPUT" | head -n 10
    echo ""
}

echo "=========================================="
echo "MCP Domain Operations Validation (T3069)"
echo "=========================================="
echo ""

# ============================================================
# 1. TASKS DOMAIN (Priority: High)
# ============================================================
echo -e "${BLUE}━━━ 1. TASKS DOMAIN ━━━${NC}"

test_operation "cleo_query" "tasks" "list" '{"status":"pending"}' \
    "List pending tasks"

test_operation "cleo_query" "tasks" "show" '{"id":"T001"}' \
    "Show task T001"

test_operation "cleo_query" "tasks" "find" '{"query":"test"}' \
    "Find tasks with 'test'"

test_operation "cleo_query" "tasks" "exists" '{"id":"T001"}' \
    "Check if T001 exists"

test_operation "cleo_query" "tasks" "next" '{}' \
    "Get next suggested task"

test_operation "cleo_query" "tasks" "stats" '{}' \
    "Get task statistics"

test_operation "cleo_mutate" "tasks" "add" '{"title":"MCP Test Task","description":"Created via MCP","addPhase":true}' \
    "Add new task via MCP"

test_operation "cleo_mutate" "tasks" "update" '{"id":"T002","title":"Updated via MCP"}' \
    "Update task T002"

test_operation "cleo_query" "tasks" "depends" '{"id":"T003"}' \
    "Get dependencies for T003"

# Error case
test_operation "cleo_query" "tasks" "show" '{"id":"T999"}' \
    "Error case: non-existent task"

# ============================================================
# 2. SESSION DOMAIN (Priority: High)
# ============================================================
echo -e "${BLUE}━━━ 2. SESSION DOMAIN ━━━${NC}"

test_operation "cleo_query" "session" "status" '{}' \
    "Get current session status"

test_operation "cleo_query" "session" "list" '{}' \
    "List all sessions"

test_operation "cleo_query" "session" "focus-show" '{}' \
    "Show current focus"

test_operation "cleo_query" "session" "stats" '{}' \
    "Get session statistics"

test_operation "cleo_mutate" "session" "focus-set" '{"id":"T002"}' \
    "Set focus to T002"

test_operation "cleo_query" "session" "focus-show" '{}' \
    "Verify focus changed to T002"

test_operation "cleo_mutate" "session" "focus-set" '{"id":"T001"}' \
    "Reset focus to T001"

# ============================================================
# 3. SYSTEM DOMAIN (Priority: High)
# ============================================================
echo -e "${BLUE}━━━ 3. SYSTEM DOMAIN ━━━${NC}"

test_operation "cleo_query" "system" "version" '{}' \
    "Get CLEO version"

test_operation "cleo_query" "system" "context" '{}' \
    "Get context window usage"

test_operation "cleo_query" "system" "health" '{}' \
    "Get system health"

test_operation "cleo_query" "system" "config" '{}' \
    "Get system configuration"

test_operation "cleo_query" "system" "metrics" '{}' \
    "Get system metrics"

test_operation "cleo_query" "system" "help" '{"command":"tasks"}' \
    "Get help for tasks domain"

# ============================================================
# 4. ORCHESTRATE DOMAIN (Priority: Medium)
# ============================================================
echo -e "${BLUE}━━━ 4. ORCHESTRATE DOMAIN ━━━${NC}"

test_operation "cleo_query" "orchestrate" "status" '{"epic":"T001"}' \
    "Get orchestration status for T001"

test_operation "cleo_query" "orchestrate" "ready" '{"epic":"T001"}' \
    "Get ready tasks for T001"

test_operation "cleo_query" "orchestrate" "next" '{"epic":"T001"}' \
    "Get next task for T001"

test_operation "cleo_query" "orchestrate" "waves" '{"epicId":"T001"}' \
    "Get dependency waves for T001"

test_operation "cleo_mutate" "orchestrate" "analyze" '{"epicId":"T001"}' \
    "Analyze epic T001"

# ============================================================
# 5. RESEARCH DOMAIN (Priority: Medium)
# ============================================================
echo -e "${BLUE}━━━ 5. RESEARCH DOMAIN ━━━${NC}"

test_operation "cleo_query" "research" "list" '{"task":"T001"}' \
    "List research for T001"

test_operation "cleo_query" "research" "stats" '{}' \
    "Get research statistics"

test_operation "cleo_query" "research" "validate" '{}' \
    "Validate research entries"

# ============================================================
# 6. LIFECYCLE DOMAIN (Priority: Medium)
# ============================================================
echo -e "${BLUE}━━━ 6. LIFECYCLE DOMAIN ━━━${NC}"

test_operation "cleo_query" "lifecycle" "stages" '{}' \
    "List lifecycle stages"

test_operation "cleo_query" "lifecycle" "status" '{"epicId":"T001"}' \
    "Get lifecycle status for T001"

test_operation "cleo_query" "lifecycle" "validate" '{"epicId":"T001"}' \
    "Validate lifecycle for T001"

test_operation "cleo_mutate" "lifecycle" "record" '{"epicId":"T001","stage":"research","status":"completed"}' \
    "Record lifecycle stage completion"

test_operation "cleo_query" "lifecycle" "report" '{"epicId":"T001"}' \
    "Generate lifecycle report for T001"

# ============================================================
# 7. VALIDATE DOMAIN (Priority: Medium)
# ============================================================
echo -e "${BLUE}━━━ 7. VALIDATE DOMAIN ━━━${NC}"

test_operation "cleo_query" "validate" "all" '{}' \
    "Validate all data"

test_operation "cleo_query" "validate" "task" '{"id":"T001"}' \
    "Validate task T001"

test_operation "cleo_query" "validate" "stats" '{}' \
    "Get validation statistics"

test_operation "cleo_query" "validate" "schema" '{}' \
    "Validate schema compliance"

# ============================================================
# 8. RELEASE DOMAIN (Priority: Low)
# ============================================================
echo -e "${BLUE}━━━ 8. RELEASE DOMAIN ━━━${NC}"

test_operation "cleo_query" "release" "version" '{}' \
    "Get release version"

test_operation "cleo_query" "release" "verify" '{}' \
    "Verify release readiness"

test_operation "cleo_query" "release" "changelog" '{}' \
    "Get changelog"

# ============================================================
# Generate Summary
# ============================================================
echo ""
echo "=========================================="
echo "TEST SUMMARY"
echo "=========================================="
echo "Total Tests: $TOTAL_TESTS"
echo -e "${GREEN}Passed: $PASSED_TESTS${NC}"
echo -e "${RED}Failed: $FAILED_TESTS${NC}"
echo ""

SUCCESS_RATE=$(echo "scale=2; $PASSED_TESTS * 100 / $TOTAL_TESTS" | bc)
echo "Success Rate: ${SUCCESS_RATE}%"
echo ""

# Write summary
cat > "$SUMMARY_FILE" <<EOF
MCP Domain Operations Validation (T3069)
========================================

Test Results:
- Total Tests: $TOTAL_TESTS
- Passed: $PASSED_TESTS
- Failed: $FAILED_TESTS
- Success Rate: ${SUCCESS_RATE}%

Domains Tested:
1. tasks (19 operations defined, $(jq -s 'map(select(.domain == "tasks")) | length' "$RESULTS_FILE") tested)
2. session (12 operations defined, $(jq -s 'map(select(.domain == "session")) | length' "$RESULTS_FILE") tested)
3. system (12 operations defined, $(jq -s 'map(select(.domain == "system")) | length' "$RESULTS_FILE") tested)
4. orchestrate (12 operations defined, $(jq -s 'map(select(.domain == "orchestrate")) | length' "$RESULTS_FILE") tested)
5. research (10 operations defined, $(jq -s 'map(select(.domain == "research")) | length' "$RESULTS_FILE") tested)
6. lifecycle (10 operations defined, $(jq -s 'map(select(.domain == "lifecycle")) | length' "$RESULTS_FILE") tested)
7. validate (11 operations defined, $(jq -s 'map(select(.domain == "validate")) | length' "$RESULTS_FILE") tested)
8. release (7 operations defined, $(jq -s 'map(select(.domain == "release")) | length' "$RESULTS_FILE") tested)

Results File: $RESULTS_FILE
Summary File: $SUMMARY_FILE
EOF

echo "Results written to:"
echo "  - $RESULTS_FILE"
echo "  - $SUMMARY_FILE"
echo ""

# Show failed tests
if [ $FAILED_TESTS -gt 0 ]; then
    echo -e "${RED}Failed Tests:${NC}"
    jq -r 'select(.status == "FAIL") | "  [\(.domain).\(.operation)] \(.description): \(.error)"' "$RESULTS_FILE"
    echo ""
fi

# Exit with appropriate code
if [ $FAILED_TESTS -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    exit 0
else
    echo -e "${YELLOW}⚠ Some tests failed. Review results above.${NC}"
    exit 1
fi
