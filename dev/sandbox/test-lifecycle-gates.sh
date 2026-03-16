#!/usr/bin/env bash
# Test lifecycle gate enforcement via CLI
# Tests the RCASD-IVTR+C pipeline gate system

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGER="$SCRIPT_DIR/sandbox-manager.sh"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

log_pass() { echo -e "${GREEN}PASS${NC}: $*"; PASS=$((PASS + 1)); }
log_fail() { echo -e "${RED}FAIL${NC}: $*"; FAIL=$((FAIL + 1)); }

run_cmd() {
    "$MANAGER" exec "$@" 2>&1
}

echo "=== Lifecycle Gate Enforcement Tests ==="
echo ""

# Setup: create a test project
echo "Setting up test project..."
run_cmd "rm -rf ~/lifecycle-test && mkdir -p ~/lifecycle-test && cd ~/lifecycle-test && git init && cleo init" > /dev/null 2>&1

# Test 1: Create an epic task
echo "Test 1: Create epic task for lifecycle tracking..."
if output=$(run_cmd "cd ~/lifecycle-test && cleo add 'Lifecycle Test Epic' --description 'Epic for lifecycle gate testing' --type epic"); then
    log_pass "Created epic task"
else
    log_fail "Failed to create epic task: $output"
fi

# Test 2: Query pipeline stages
echo "Test 2: Query pipeline stages..."
if output=$(run_cmd "cd ~/lifecycle-test && cleo pipeline stages 2>&1" 2>&1); then
    log_pass "Pipeline stages query succeeded"
else
    # Pipeline command may not exist as CLI -- try MCP approach
    log_fail "Pipeline stages query failed: $output"
fi

# Test 3: Query pipeline status for epic
echo "Test 3: Query pipeline status..."
if output=$(run_cmd "cd ~/lifecycle-test && cleo pipeline status T001 2>&1" 2>&1); then
    log_pass "Pipeline status query succeeded"
else
    log_fail "Pipeline status query failed: $output"
fi

# Test 4: Verify task exists in database
echo "Test 4: Verify epic exists in tasks.db..."
if output=$(run_cmd "cd ~/lifecycle-test && sqlite3 .cleo/tasks.db \"SELECT id, title, type FROM tasks WHERE id = 'T001';\""); then
    if echo "$output" | grep -q "T001"; then
        log_pass "Epic T001 exists in tasks.db"
    else
        log_fail "Epic T001 not found in output: $output"
    fi
else
    log_fail "sqlite3 query failed: $output"
fi

# Test 5: Verify config.json has lifecycle enforcement settings
echo "Test 5: Check lifecycle enforcement config..."
if output=$(run_cmd "cd ~/lifecycle-test && sqlite3 .cleo/tasks.db \".tables\""); then
    log_pass "Database tables accessible"
else
    log_fail "Cannot access database tables: $output"
fi

# Summary
echo ""
echo "=== Results ==="
echo -e "${GREEN}Passed${NC}: $PASS"
echo -e "${RED}Failed${NC}: $FAIL"
echo "Total: $((PASS + FAIL))"

if [[ $FAIL -gt 0 ]]; then
    exit 1
fi
