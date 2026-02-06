#!/usr/bin/env bash
# CLEO Production Test Runner
# Runs realistic production scenarios in the sandbox environment

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MANAGER="$SCRIPT_DIR/sandbox-manager.sh"

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

# Execute command in sandbox and check exit code
run_in_sandbox() {
    local description="$1"
    shift

    log_test "$description"

    if "$MANAGER" exec "$@"; then
        log_pass "$description"
        return 0
    else
        log_fail "$description"
        return 1
    fi
}

# Test scenario: Fresh installation
test_fresh_installation() {
    echo
    echo "========================================="
    echo "Test Scenario 1: Fresh Installation"
    echo "========================================="

    # Re-install from the already-mounted project source
    # (sandbox-manager.sh copies the project into /home/testuser/projects)
    run_in_sandbox "Check dependencies" \
        "cd /home/testuser/projects/claude-todo && ./install.sh --check-deps"

    # Run installation
    run_in_sandbox "Run installation" \
        "cd /home/testuser/projects/claude-todo && ./install.sh"

    # Verify installation
    run_in_sandbox "Verify cleo command" \
        "which cleo"

    # Check version
    run_in_sandbox "Check CLEO version" \
        "cleo version"
}

# Test scenario: Basic workflow
test_basic_workflow() {
    echo
    echo "========================================="
    echo "Test Scenario 2: Basic Task Workflow"
    echo "========================================="

    # Initialize project
    run_in_sandbox "Initialize CLEO in new project" \
        "mkdir -p /home/testuser/test-project && cd /home/testuser/test-project && cleo init"

    # Disable multiSession so workflow tests don't require session scoping
    run_in_sandbox "Disable multiSession for test" \
        "cd /home/testuser/test-project && cleo config set multiSession.enabled false"

    # Create tasks
    run_in_sandbox "Create first task" \
        "cd /home/testuser/test-project && cleo add 'Setup development environment' --notes 'Install dependencies and configure tools'"

    run_in_sandbox "Create second task" \
        "cd /home/testuser/test-project && cleo add 'Write documentation' --notes 'Create README and API docs'"

    # List tasks
    run_in_sandbox "List all tasks" \
        "cd /home/testuser/test-project && cleo list"

    # Start session
    run_in_sandbox "Start work session" \
        "cd /home/testuser/test-project && cleo session start --name 'Test Session'"

    # Set focus
    run_in_sandbox "Set focus to first task" \
        "cd /home/testuser/test-project && cleo focus set T001"

    # Complete task
    run_in_sandbox "Complete first task" \
        "cd /home/testuser/test-project && cleo done T001 --skip-notes"

    # End session
    run_in_sandbox "End work session" \
        "cd /home/testuser/test-project && cleo session end"
}

# Test scenario: Multi-project setup
test_multi_project() {
    echo
    echo "========================================="
    echo "Test Scenario 3: Multi-Project Setup"
    echo "========================================="

    # Create multiple projects
    run_in_sandbox "Create project A" \
        "mkdir -p /home/testuser/project-a && cd /home/testuser/project-a && cleo init"

    run_in_sandbox "Create project B" \
        "mkdir -p /home/testuser/project-b && cd /home/testuser/project-b && cleo init"

    # Add tasks to both
    run_in_sandbox "Add task to project A" \
        "cd /home/testuser/project-a && cleo add 'Feature A1'"

    run_in_sandbox "Add task to project B" \
        "cd /home/testuser/project-b && cleo add 'Feature B1'"

    # Verify isolation
    run_in_sandbox "List tasks in project A" \
        "cd /home/testuser/project-a && cleo list"

    run_in_sandbox "List tasks in project B" \
        "cd /home/testuser/project-b && cleo list"
}

# Test scenario: Error handling
test_error_handling() {
    echo
    echo "========================================="
    echo "Test Scenario 4: Error Handling"
    echo "========================================="

    # Invalid commands (these should fail gracefully)
    log_test "Test invalid task ID"
    if "$MANAGER" exec "cd /home/testuser/test-project && cleo show T999" 2>/dev/null; then
        log_fail "Should have failed for invalid task ID"
    else
        log_pass "Correctly handled invalid task ID"
    fi

    log_test "Test operation outside CLEO project"
    if "$MANAGER" exec "cd /tmp && cleo list" 2>/dev/null; then
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

    # Create task and verify it persists
    run_in_sandbox "Create task for persistence test" \
        "cd /home/testuser/test-project && cleo add 'Persistence test task'"

    run_in_sandbox "Verify task data file exists" \
        "test -f /home/testuser/test-project/.cleo/todo.json"

    run_in_sandbox "Verify task is in JSON" \
        "cd /home/testuser/test-project && jq -e '.tasks[] | select(.title == \"Persistence test task\")' .cleo/todo.json"
}

# Main test runner
main() {
    echo "========================================"
    echo "CLEO Production Testing Suite"
    echo "========================================"

    # Ensure sandbox is running
    log_info "Ensuring sandbox is running..."
    "$MANAGER" start

    echo
    "$MANAGER" status

    # Run test scenarios
    local failed=0

    test_fresh_installation || ((failed++))
    test_basic_workflow || ((failed++))
    test_multi_project || ((failed++))
    test_error_handling || ((failed++))
    test_data_persistence || ((failed++))

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
RUN_SPECIFIC=""
if [[ $# -gt 0 ]]; then
    case "$1" in
        fresh)
            test_fresh_installation
            ;;
        workflow)
            test_basic_workflow
            ;;
        multi)
            test_multi_project
            ;;
        errors)
            test_error_handling
            ;;
        persistence)
            test_data_persistence
            ;;
        *)
            main
            ;;
    esac
else
    main
fi
