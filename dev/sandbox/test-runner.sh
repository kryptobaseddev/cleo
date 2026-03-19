#!/usr/bin/env bash
# CLEO Production Test Runner
# Runs realistic production scenarios in the sandbox environment

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MANAGER="$SCRIPT_DIR/sandbox-manager.sh"
SSH_KEY_PATH="${HOME}/.cleo/sandbox/ssh/sandbox_key"
SSH_PORT="2222"
CLEO="/home/testuser/cleo-source"
CLI="node ${CLEO}/packages/cleo/dist/cli/index.js"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_test() {
    echo -e "${BLUE}[TEST]${NC} $*"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $*"
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $*"
}

log_info() {
    echo -e "${YELLOW}[INFO]${NC} $*"
}

# Run command in sandbox via SSH
sandbox_run() {
    ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR \
        -p "$SSH_PORT" -i "$SSH_KEY_PATH" \
        testuser@localhost "$@" 2>&1
}

# Execute command in sandbox and check exit code
run_in_sandbox() {
    local description="$1"
    shift

    log_test "$description"

    if sandbox_run "$@"; then
        log_pass "$description"
        return 0
    else
        log_fail "$description"
        return 1
    fi
}

# Test scenario: Fresh project setup
test_fresh_setup() {
    echo
    echo "========================================="
    echo "Test Scenario 1: Fresh Project Setup"
    echo "========================================="

    run_in_sandbox "Check CLEO CLI is available" \
        "cd $CLEO && $CLI version"

    run_in_sandbox "Check Node.js version" \
        "node --version"
}

# Test scenario: Basic workflow
test_basic_workflow() {
    echo
    echo "========================================="
    echo "Test Scenario 2: Basic Task Workflow"
    echo "========================================="

    # Clean and initialize project
    sandbox_run "rm -rf /home/testuser/test-project" >/dev/null 2>&1 || true

    run_in_sandbox "Initialize CLEO in new project" \
        "mkdir -p /home/testuser/test-project && cd /home/testuser/test-project && git init && $CLI init"

    # Create tasks
    run_in_sandbox "Create first task" \
        "cd /home/testuser/test-project && $CLI add 'Setup development environment' --description 'Install dependencies and configure tools'"

    run_in_sandbox "Create second task" \
        "cd /home/testuser/test-project && $CLI add 'Write documentation' --description 'Create README and API docs'"

    # List tasks
    run_in_sandbox "List all tasks" \
        "cd /home/testuser/test-project && $CLI list"

    # Start session with proper scope format
    run_in_sandbox "Start work session" \
        "cd /home/testuser/test-project && $CLI session start --scope epic:T001 --name 'Test Session'"

    # Start task
    run_in_sandbox "Start first task" \
        "cd /home/testuser/test-project && $CLI start T001"

    # Complete task (provide notes instead of non-existent --skip-notes)
    run_in_sandbox "Complete first task" \
        "cd /home/testuser/test-project && $CLI done T001 --notes 'Completed in test'"

    # End session
    run_in_sandbox "End work session" \
        "cd /home/testuser/test-project && $CLI session end"
}

# Test scenario: Multi-project setup
test_multi_project() {
    echo
    echo "========================================="
    echo "Test Scenario 3: Multi-Project Setup"
    echo "========================================="

    sandbox_run "rm -rf /home/testuser/project-a /home/testuser/project-b" >/dev/null 2>&1 || true

    run_in_sandbox "Create project A" \
        "mkdir -p /home/testuser/project-a && cd /home/testuser/project-a && git init && $CLI init"

    run_in_sandbox "Create project B" \
        "mkdir -p /home/testuser/project-b && cd /home/testuser/project-b && git init && $CLI init"

    run_in_sandbox "Add task to project A" \
        "cd /home/testuser/project-a && $CLI add 'Feature A1' --description 'Project A feature'"

    run_in_sandbox "Add task to project B" \
        "cd /home/testuser/project-b && $CLI add 'Feature B1' --description 'Project B feature'"

    run_in_sandbox "List tasks in project A" \
        "cd /home/testuser/project-a && $CLI list"

    run_in_sandbox "List tasks in project B" \
        "cd /home/testuser/project-b && $CLI list"
}

# Test scenario: Error handling
test_error_handling() {
    echo
    echo "========================================="
    echo "Test Scenario 4: Error Handling"
    echo "========================================="

    log_test "Test invalid task ID"
    if sandbox_run "cd /home/testuser/test-project && $CLI show T999" >/dev/null 2>&1; then
        log_fail "Should have failed for invalid task ID"
    else
        log_pass "Correctly handled invalid task ID"
    fi

    log_test "Test operation outside CLEO project"
    if sandbox_run "cd /tmp && $CLI list" >/dev/null 2>&1; then
        log_fail "Should have failed outside project"
    else
        log_pass "Correctly detected non-CLEO directory"
    fi
}

# Test scenario: Data persistence
test_data_persistence() {
    echo
    echo "========================================="
    echo "Test Scenario 5: Data Persistence"
    echo "========================================="

    run_in_sandbox "Create task for persistence test" \
        "cd /home/testuser/test-project && $CLI add 'Persistence test task' --description 'Test that data persists in SQLite'"

    run_in_sandbox "Verify tasks database exists" \
        "test -f /home/testuser/test-project/.cleo/tasks.db"

    run_in_sandbox "Verify task is in database" \
        "cd /home/testuser/test-project && sqlite3 .cleo/tasks.db \"SELECT title FROM tasks WHERE title = 'Persistence test task'\""
}

# Main test runner
main() {
    echo "========================================"
    echo "CLEO Production Testing Suite"
    echo "========================================"

    # Ensure sandbox is running
    log_info "Ensuring sandbox is running..."
    "$MANAGER" start 2>/dev/null || true

    echo

    # Run test scenarios
    local failed=0

    test_fresh_setup || failed=$((failed + 1))
    test_basic_workflow || failed=$((failed + 1))
    test_multi_project || failed=$((failed + 1))
    test_error_handling || failed=$((failed + 1))
    test_data_persistence || failed=$((failed + 1))

    # Summary
    echo
    echo "========================================"
    echo "Test Summary"
    echo "========================================"

    if [[ $failed -eq 0 ]]; then
        log_pass "All test scenarios passed!"
        return 0
    else
        log_fail "$failed test scenario(s) failed"
        return 1
    fi
}

# Parse options
if [[ $# -gt 0 ]]; then
    case "$1" in
        fresh)       test_fresh_setup ;;
        workflow)    test_basic_workflow ;;
        multi)       test_multi_project ;;
        errors)      test_error_handling ;;
        persistence) test_data_persistence ;;
        *)           main ;;
    esac
else
    main
fi
