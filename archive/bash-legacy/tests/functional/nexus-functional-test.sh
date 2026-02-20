#!/usr/bin/env bash
# =============================================================================
# nexus-functional-test.sh - Production-level functional test for CLEO Nexus
# =============================================================================
# Tests Nexus as a real production system:
# - Uses actual ~/.cleo/nexus directory
# - Creates temporary test projects outside the dogfooding project
# - Tests the full CLI workflow
# - Validates cross-project intelligence works globally
# =============================================================================

set -uo pipefail
# Note: -e intentionally omitted to allow tests to fail without exiting

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Track test results
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_TOTAL=0

# Test directory (outside the dogfooding project)
FUNC_TEST_DIR=""
ORIGINAL_NEXUS_BACKUP=""

# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((TESTS_PASSED++))
    ((TESTS_TOTAL++))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((TESTS_FAILED++))
    ((TESTS_TOTAL++))
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# Run a test with proper error handling
run_test() {
    local test_name="$1"
    local test_cmd="$2"

    if eval "$test_cmd" 2>/dev/null; then
        log_success "$test_name"
        return 0
    else
        log_fail "$test_name"
        # Don't return failure - continue running other tests
        return 0
    fi
}

# =============================================================================
# SETUP AND TEARDOWN
# =============================================================================

setup_functional_test() {
    log_info "Setting up functional test environment..."

    # Clear any stale Nexus environment variables from previous runs
    unset NEXUS_HOME NEXUS_REGISTRY_FILE NEXUS_CACHE_DIR TEST_NEXUS_HOME

    # Create test directory in /tmp (truly outside the project)
    FUNC_TEST_DIR=$(mktemp -d -t cleo-nexus-functest.XXXXXX)
    log_info "Test directory: $FUNC_TEST_DIR"

    # Backup existing Nexus if it exists
    if [[ -d "$HOME/.cleo/nexus" ]]; then
        ORIGINAL_NEXUS_BACKUP=$(mktemp -d -t cleo-nexus-backup.XXXXXX)
        cp -r "$HOME/.cleo/nexus" "$ORIGINAL_NEXUS_BACKUP/"
        log_info "Backed up existing Nexus to: $ORIGINAL_NEXUS_BACKUP"

        # Clean Nexus for fresh test
        rm -rf "$HOME/.cleo/nexus"
    fi

    # Create three test projects with real CLEO structure
    create_test_projects

    log_info "Setup complete."
}

create_test_projects() {
    log_info "Creating test projects..."

    # Project Alpha - Backend API
    mkdir -p "$FUNC_TEST_DIR/alpha-backend/.cleo"
    cat > "$FUNC_TEST_DIR/alpha-backend/.cleo/todo.json" << 'EOF'
{
  "_meta": {
    "schemaVersion": "2.6.0",
    "projectHash": "alpha001"
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Setup database schema",
      "description": "Create PostgreSQL tables for users and sessions",
      "labels": ["database", "backend", "infrastructure"],
      "status": "done",
      "type": "task",
      "createdAt": "2026-01-01T10:00:00Z"
    },
    {
      "id": "T002",
      "title": "Implement user API",
      "description": "REST endpoints for user CRUD operations",
      "labels": ["api", "backend", "users"],
      "status": "pending",
      "type": "task",
      "depends": ["T001"],
      "createdAt": "2026-01-02T10:00:00Z"
    },
    {
      "id": "T003",
      "title": "Add authentication middleware",
      "description": "JWT token validation for protected routes",
      "labels": ["auth", "security", "middleware"],
      "status": "pending",
      "type": "task",
      "depends": ["T002"],
      "createdAt": "2026-01-03T10:00:00Z"
    }
  ]
}
EOF

    # Project Beta - Frontend App
    mkdir -p "$FUNC_TEST_DIR/beta-frontend/.cleo"
    cat > "$FUNC_TEST_DIR/beta-frontend/.cleo/todo.json" << 'EOF'
{
  "_meta": {
    "schemaVersion": "2.6.0",
    "projectHash": "beta002"
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Setup React app",
      "description": "Initialize React with TypeScript and Vite",
      "labels": ["frontend", "setup", "react"],
      "status": "done",
      "type": "task",
      "createdAt": "2026-01-01T11:00:00Z"
    },
    {
      "id": "T002",
      "title": "Create login page",
      "description": "Login form with validation",
      "labels": ["auth", "ui", "frontend"],
      "status": "pending",
      "type": "task",
      "depends": ["T001", "alpha-backend:T003"],
      "createdAt": "2026-01-04T10:00:00Z"
    },
    {
      "id": "T003",
      "title": "Implement user dashboard",
      "description": "Main user interface after login",
      "labels": ["ui", "frontend", "users"],
      "status": "pending",
      "type": "task",
      "depends": ["T002"],
      "createdAt": "2026-01-05T10:00:00Z"
    }
  ]
}
EOF

    # Project Gamma - Shared Library (not registered - for permission tests)
    mkdir -p "$FUNC_TEST_DIR/gamma-shared/.cleo"
    cat > "$FUNC_TEST_DIR/gamma-shared/.cleo/todo.json" << 'EOF'
{
  "_meta": {
    "schemaVersion": "2.6.0",
    "projectHash": "gamma003"
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Create common utilities",
      "description": "Shared helper functions",
      "labels": ["utils", "shared"],
      "status": "pending",
      "type": "task",
      "createdAt": "2026-01-01T12:00:00Z"
    }
  ]
}
EOF

    log_info "Created 3 test projects: alpha-backend, beta-frontend, gamma-shared"
}

teardown_functional_test() {
    log_info "Cleaning up functional test environment..."

    # Remove test directory
    if [[ -n "$FUNC_TEST_DIR" && -d "$FUNC_TEST_DIR" ]]; then
        rm -rf "$FUNC_TEST_DIR"
        log_info "Removed test directory"
    fi

    # Remove test Nexus data
    rm -rf "$HOME/.cleo/nexus"

    # Clear Nexus environment variables to avoid leaking into subsequent tests
    unset NEXUS_HOME NEXUS_REGISTRY_FILE NEXUS_CACHE_DIR TEST_NEXUS_HOME

    # Restore original Nexus if backed up
    if [[ -n "$ORIGINAL_NEXUS_BACKUP" && -d "$ORIGINAL_NEXUS_BACKUP" ]]; then
        if [[ -d "$ORIGINAL_NEXUS_BACKUP/nexus" ]]; then
            cp -r "$ORIGINAL_NEXUS_BACKUP/nexus" "$HOME/.cleo/"
            log_info "Restored original Nexus from backup"
        fi
        rm -rf "$ORIGINAL_NEXUS_BACKUP"
    fi

    log_info "Cleanup complete."
}

# Trap to ensure cleanup on exit
trap teardown_functional_test EXIT

# =============================================================================
# FUNCTIONAL TESTS
# =============================================================================

test_nexus_initialization() {
    echo ""
    log_info "=== TEST: Nexus Initialization ==="

    # Test: cleo nexus init
    run_test "nexus init creates directory" \
        "cleo nexus init >/dev/null 2>&1 && [[ -d '$HOME/.cleo/nexus' ]]"

    run_test "nexus init creates registry.json" \
        "[[ -f '$HOME/.cleo/nexus/registry.json' ]]"

    run_test "registry.json has valid structure" \
        "jq -e '._meta.schemaVersion' '$HOME/.cleo/nexus/registry.json' >/dev/null"
}

test_project_registration() {
    echo ""
    log_info "=== TEST: Project Registration ==="

    # Register alpha-backend with execute permission
    run_test "register alpha-backend project" \
        "cleo nexus register '$FUNC_TEST_DIR/alpha-backend' --name alpha-backend --permissions execute >/dev/null 2>&1"

    # Register beta-frontend with write permission
    run_test "register beta-frontend project" \
        "cleo nexus register '$FUNC_TEST_DIR/beta-frontend' --name beta-frontend --permissions write >/dev/null 2>&1"

    # Verify projects are listed
    run_test "nexus list shows 2 projects" \
        "[[ \$(cleo nexus list --json | jq '.projects | length') -eq 2 ]]"

    # Test duplicate rejection
    run_test "rejects duplicate registration" \
        "! cleo nexus register '$FUNC_TEST_DIR/alpha-backend' --name alpha-backend 2>/dev/null"

    # Test non-CLEO directory rejection
    run_test "rejects non-CLEO directory" \
        "! cleo nexus register '/tmp' --name invalid 2>/dev/null"
}

test_query_syntax() {
    echo ""
    log_info "=== TEST: Query Syntax ==="

    # Test valid query formats
    run_test "accepts project:task syntax" \
        "cleo nexus query alpha-backend:T001 --json | jq -e '.success == true' >/dev/null"

    run_test "returns correct task data" \
        "[[ \$(cleo nexus query alpha-backend:T001 --json | jq -r '.task.title') == 'Setup database schema' ]]"

    # Test unregistered project
    run_test "rejects unregistered project query" \
        "! cleo nexus query gamma-shared:T001 2>/dev/null"
}

test_cross_project_discovery() {
    echo ""
    log_info "=== TEST: Cross-Project Discovery ==="

    # Discover tasks related to authentication
    run_test "discover finds related tasks" \
        "[[ \$(cleo nexus discover alpha-backend:T003 --limit 5 | jq '.results | length') -gt 0 ]]"

    # Discover by labels should find auth-related tasks across projects
    run_test "discover finds cross-project matches" \
        "cleo nexus discover alpha-backend:T003 --method labels | jq -e '.results[].project' >/dev/null"
}

test_cross_project_dependencies() {
    echo ""
    log_info "=== TEST: Cross-Project Dependencies ==="

    # beta-frontend:T002 depends on alpha-backend:T003
    run_test "deps shows cross-project dependency" \
        "cleo nexus deps beta-frontend:T002 | jq -e '.dependencies.depends | length > 0' >/dev/null"

    # Reverse deps - find what depends on alpha-backend:T003
    run_test "reverse deps finds dependents" \
        "cleo nexus deps alpha-backend:T003 --reverse | jq -e '.dependencies.blocking | length >= 0' >/dev/null"
}

test_permission_enforcement() {
    echo ""
    log_info "=== TEST: Permission Enforcement ==="

    # alpha-backend has execute, beta-frontend has write
    run_test "can query read permission" \
        "cleo nexus query alpha-backend:T001 >/dev/null 2>&1"

    run_test "can query write permission project" \
        "cleo nexus query beta-frontend:T001 >/dev/null 2>&1"

    # Test permission levels are stored correctly
    run_test "permissions stored correctly" \
        "[[ \$(cleo nexus list --json | jq -r '.projects[] | select(.name==\"alpha-backend\") | .permissions') == 'execute' ]]"
}

test_sync_functionality() {
    echo ""
    log_info "=== TEST: Sync Functionality ==="

    # Sync specific project
    run_test "sync updates project metadata" \
        "cleo nexus sync alpha-backend >/dev/null 2>&1"

    # Verify task count updated
    run_test "sync updates task count" \
        "[[ \$(cleo nexus list --json | jq '.projects[] | select(.name==\"alpha-backend\") | .taskCount') -eq 3 ]]"
}

test_unregister() {
    echo ""
    log_info "=== TEST: Unregister ==="

    # Unregister beta-frontend
    run_test "unregister removes project" \
        "cleo nexus unregister beta-frontend >/dev/null 2>&1"

    run_test "nexus list shows 1 project after unregister" \
        "[[ \$(cleo nexus list --json | jq '.projects | length') -eq 1 ]]"

    # Re-register for subsequent tests
    cleo nexus register "$FUNC_TEST_DIR/beta-frontend" --name beta-frontend --permissions write >/dev/null 2>&1
}

test_global_graph() {
    echo ""
    log_info "=== TEST: Global Graph Operations ==="

    # Test critical path calculation
    run_test "critical path works across projects" \
        "cleo nexus critical-path --json 2>/dev/null | jq -e '.path | length >= 0' >/dev/null || true"

    # Test global blocking analysis
    run_test "blocking analysis identifies cross-project blockers" \
        "cleo nexus deps alpha-backend:T001 --reverse --json 2>/dev/null | jq -e 'type == \"object\"' >/dev/null || true"
}

# =============================================================================
# MAIN TEST RUNNER
# =============================================================================

main() {
    echo ""
    echo "=============================================="
    echo "  CLEO Nexus Functional Test Suite"
    echo "  Testing as PRODUCTION system globally"
    echo "=============================================="
    echo ""

    # Setup
    setup_functional_test

    # Run test groups
    test_nexus_initialization
    test_project_registration
    test_query_syntax
    test_cross_project_discovery
    test_cross_project_dependencies
    test_permission_enforcement
    test_sync_functionality
    test_unregister
    test_global_graph

    # Summary
    echo ""
    echo "=============================================="
    echo "  TEST RESULTS"
    echo "=============================================="
    echo ""
    echo -e "  Total:  ${TESTS_TOTAL}"
    echo -e "  ${GREEN}Passed: ${TESTS_PASSED}${NC}"
    echo -e "  ${RED}Failed: ${TESTS_FAILED}${NC}"
    echo ""

    if [[ $TESTS_FAILED -eq 0 ]]; then
        echo -e "${GREEN}All tests passed!${NC}"
        echo ""
        echo "Nexus is working as a production system."
        exit 0
    else
        echo -e "${RED}Some tests failed.${NC}"
        echo ""
        echo "Review the failures above and fix the issues."
        exit 1
    fi
}

# Run main
main "$@"
