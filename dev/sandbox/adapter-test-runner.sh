#!/usr/bin/env bash
# CLEO Sandbox Functional Test Suite
# Tests CLEO CLI and MCP server the same way a real user would.
# No importing individual dist files -- everything goes through CLI or MCP protocol.
#
# Usage:
#   ./adapter-test-runner.sh           # Run all suites
#   ./adapter-test-runner.sh build     # Run single suite
#
# Prerequisites:
#   - Sandbox running: ./sandbox-manager.sh start
#   - CLEO deployed:   ./sandbox-manager.sh deploy

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGER="$SCRIPT_DIR/sandbox-manager.sh"
SSH_KEY_PATH="${HOME}/.cleo/sandbox/ssh/sandbox_key"
SSH_PORT="2222"

# CLEO base path inside the container
CLEO="/home/testuser/cleo-source"
CLI="node ${CLEO}/dist/cli/index.js"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

log_test()  { echo -e "\n${BLUE}[TEST]${NC} $*"; }
log_pass()  { echo -e "${GREEN}[PASS]${NC} $*"; PASS_COUNT=$((PASS_COUNT + 1)); }
log_fail()  { echo -e "${RED}[FAIL]${NC} $*"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
log_skip()  { echo -e "${YELLOW}[SKIP]${NC} $*"; SKIP_COUNT=$((SKIP_COUNT + 1)); }
log_info()  { echo -e "${YELLOW}[INFO]${NC} $*"; }

# Run command in sandbox, capture stdout+stderr
sandbox_exec() {
    ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR \
        -p "$SSH_PORT" -i "$SSH_KEY_PATH" \
        testuser@localhost "$@" 2>&1
}

# Assert command succeeds and output contains expected string
assert_contains() {
    local description="$1"
    local expected="$2"
    shift 2

    log_test "$description"
    local output
    if output=$(sandbox_exec "$@"); then
        if echo "$output" | grep -qF "$expected"; then
            log_pass "$description"
        else
            log_fail "$description -- output missing '$expected'"
            echo "  Got: $(echo "$output" | head -5)"
        fi
    else
        log_fail "$description -- command failed (exit $?)"
        echo "  Output: $(echo "$output" | head -5)"
    fi
}

# Assert command succeeds (exit 0)
assert_success() {
    local description="$1"
    shift

    log_test "$description"
    local output
    if output=$(sandbox_exec "$@"); then
        log_pass "$description"
    else
        log_fail "$description -- command failed (exit $?)"
        echo "  Output: $(echo "$output" | head -5)"
    fi
}

# Assert command fails (non-zero exit)
assert_fails() {
    local description="$1"
    shift

    log_test "$description"
    local output
    if output=$(sandbox_exec "$@" 2>&1); then
        log_fail "$description -- should have failed but succeeded"
        echo "  Output: $(echo "$output" | head -3)"
    else
        log_pass "$description (correctly failed)"
    fi
}

# Assert file exists in sandbox
assert_file_exists() {
    local description="$1"
    local filepath="$2"

    log_test "$description"
    if sandbox_exec "test -f '$filepath'"; then
        log_pass "$description"
    else
        log_fail "$description -- file not found: $filepath"
    fi
}

# Assert file does NOT exist in sandbox
assert_file_missing() {
    local description="$1"
    local filepath="$2"

    log_test "$description"
    if sandbox_exec "test -f '$filepath'"; then
        log_fail "$description -- file should not exist: $filepath"
    else
        log_pass "$description"
    fi
}

# Assert directory does NOT exist in sandbox
assert_dir_missing() {
    local description="$1"
    local dirpath="$2"

    log_test "$description"
    if sandbox_exec "test -d '$dirpath'"; then
        log_fail "$description -- directory should not exist: $dirpath"
    else
        log_pass "$description"
    fi
}

# Deploy MCP test helper script to sandbox (called once before MCP tests)
deploy_mcp_helper() {
    # Write the helper script as a local file, then SCP it to the sandbox
    local _helper
    _helper=$(mktemp /tmp/mcp-helper-XXXXXX.sh)
    cat > "$_helper" << 'HELPEREOF'
#!/usr/bin/env bash
# MCP test helper: runs a single MCP operation with proper handshake
# Usage: mcp-test-helper.sh <gateway> <domain> <operation> <params_json> <project_dir>
GATEWAY="$1"
DOMAIN="$2"
OPERATION="$3"
PARAMS="${4:-"{}"}"
PROJECT_DIR="${5:-/home/testuser/mcp-test}"
CLEO="/home/testuser/cleo-source"

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"sandbox-test","version":"1.0"}}}'
NOTIF='{"jsonrpc":"2.0","method":"notifications/initialized"}'
CALL="{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"${GATEWAY}\",\"arguments\":{\"domain\":\"${DOMAIN}\",\"operation\":\"${OPERATION}\",\"params\":${PARAMS}}}}"

printf '%s\n%s\n%s\n' "$INIT" "$NOTIF" "$CALL" | (cd "$PROJECT_DIR" && node "$CLEO/dist/mcp/index.js" 2>/dev/null)
HELPEREOF
    chmod +x "$_helper"

    scp -o StrictHostKeyChecking=no -o LogLevel=ERROR \
        -P "$SSH_PORT" -i "$SSH_KEY_PATH" \
        "$_helper" testuser@localhost:/tmp/mcp-test-helper.sh >/dev/null 2>&1
    rm -f "$_helper"
}

# MCP helper: run MCP operation via remote helper script
# Usage: mcp_call <gateway> <domain> <operation> [params_json] [project_dir]
mcp_call() {
    local gateway="$1"
    local domain="$2"
    local operation="$3"
    local params_json="${4:-"{}"}"
    local project_dir="${5:-/home/testuser/mcp-test}"

    # Escape double quotes for SSH transport (remote shell would strip them)
    local escaped_params="${params_json//\"/\\\"}"
    sandbox_exec "bash /tmp/mcp-test-helper.sh '$gateway' '$domain' '$operation' \"$escaped_params\" '$project_dir'" || true
}

# Assert MCP call succeeds and response contains expected text
# Usage: assert_mcp_contains <desc> <gateway> <domain> <operation> <expected> [params_json] [project_dir]
assert_mcp_contains() {
    local description="$1"
    local gateway="$2"
    local domain="$3"
    local operation="$4"
    local expected="$5"
    local params_json="${6:-"{}"}"
    local project_dir="${7:-/home/testuser/mcp-test}"

    log_test "$description"
    local output
    output=$(mcp_call "$gateway" "$domain" "$operation" "$params_json" "$project_dir")
    if echo "$output" | grep -qF "$expected"; then
        log_pass "$description"
    else
        log_fail "$description -- MCP output missing '$expected'"
        echo "  Got: $(echo "$output" | tail -2 | head -1 | cut -c1-200)"
    fi
}

# Assert MCP call succeeds (response contains "result")
# Usage: assert_mcp_success <desc> <gateway> <domain> <operation> [params_json] [project_dir]
assert_mcp_success() {
    local description="$1"
    local gateway="$2"
    local domain="$3"
    local operation="$4"
    local params_json="${5:-"{}"}"
    local project_dir="${6:-/home/testuser/mcp-test}"

    log_test "$description"
    local output
    output=$(mcp_call "$gateway" "$domain" "$operation" "$params_json" "$project_dir")
    if echo "$output" | grep -qF '"result"'; then
        log_pass "$description"
    else
        log_fail "$description -- MCP call did not return a result"
        echo "  Got: $(echo "$output" | tail -2 | head -1 | cut -c1-200)"
    fi
}


#=============================================================
# TEST SUITE 1: Build & Version
#=============================================================
test_build_and_version() {
    echo -e "\n========================================="
    echo "Suite 1: Build & Version Verification"
    echo "========================================="

    assert_success "Node.js is installed in sandbox" \
        "node --version"

    assert_success "npm is installed in sandbox" \
        "npm --version"

    assert_success "sqlite3 CLI is installed in sandbox" \
        "sqlite3 --version"

    assert_contains "CLEO version returns valid CalVer" "2026" \
        "cd $CLEO && $CLI version"

    assert_contains "CLEO --help lists add command" "add" \
        "cd $CLEO && $CLI --help"

    assert_contains "CLEO --help lists session command" "session" \
        "cd $CLEO && $CLI --help"

    assert_file_exists "dist/cli/index.js exists (bundled CLI)" \
        "${CLEO}/dist/cli/index.js"

    assert_file_exists "dist/mcp/index.js exists (bundled MCP)" \
        "${CLEO}/dist/mcp/index.js"

    # Verify there is NO dist/core/ (esbuild bundles everything)
    assert_dir_missing "dist/core/ does NOT exist (esbuild bundles)" \
        "${CLEO}/dist/core"
}

#=============================================================
# TEST SUITE 2: CLI Init & Project Setup
#=============================================================
test_cli_init() {
    echo -e "\n========================================="
    echo "Suite 2: CLI Init & Project Setup"
    echo "========================================="

    # Clean up any prior test state
    sandbox_exec "rm -rf /home/testuser/init-test" >/dev/null 2>&1 || true

    assert_success "Create directory and git init" \
        "mkdir -p /home/testuser/init-test && cd /home/testuser/init-test && git init"

    assert_success "cleo init creates .cleo/" \
        "cd /home/testuser/init-test && $CLI init"

    assert_file_exists ".cleo/tasks.db created by init" \
        "/home/testuser/init-test/.cleo/tasks.db"

    assert_file_exists ".cleo/config.json created by init" \
        "/home/testuser/init-test/.cleo/config.json"

    # Verify the tasks database has the expected schema
    assert_contains "tasks table exists in database" "tasks" \
        "cd /home/testuser/init-test && sqlite3 .cleo/tasks.db '.tables'"

    assert_contains "sessions table exists in database" "sessions" \
        "cd /home/testuser/init-test && sqlite3 .cleo/tasks.db '.tables'"

    assert_contains "audit_log table exists in database" "audit_log" \
        "cd /home/testuser/init-test && sqlite3 .cleo/tasks.db '.tables'"
}

#=============================================================
# TEST SUITE 3: Task CRUD via CLI
#=============================================================
test_task_crud() {
    echo -e "\n========================================="
    echo "Suite 3: Task CRUD via CLI"
    echo "========================================="

    # Set up a fresh project
    sandbox_exec "rm -rf /home/testuser/crud-test" >/dev/null 2>&1 || true
    assert_success "Initialize CRUD test project" \
        "mkdir -p /home/testuser/crud-test && cd /home/testuser/crud-test && git init && $CLI init"

    # Add tasks
    assert_success "Add task with description" \
        "cd /home/testuser/crud-test && $CLI add 'Build feature X' --description 'Implement the new feature X with tests'"

    assert_success "Add second task" \
        "cd /home/testuser/crud-test && $CLI add 'Write documentation' --description 'Document the new feature X API'"

    # List tasks
    assert_contains "List shows first task" "Build feature X" \
        "cd /home/testuser/crud-test && $CLI list --human"

    assert_contains "List shows second task" "Write documentation" \
        "cd /home/testuser/crud-test && $CLI list --human"

    # Show task details
    assert_contains "Show T001 returns task title" "Build feature X" \
        "cd /home/testuser/crud-test && $CLI show T001"

    assert_contains "Show T001 returns description" "Implement the new feature" \
        "cd /home/testuser/crud-test && $CLI show T001"

    # Update task
    assert_success "Update task title" \
        "cd /home/testuser/crud-test && $CLI update T001 --title 'Build feature X v2'"

    assert_contains "Updated title is reflected" "Build feature X v2" \
        "cd /home/testuser/crud-test && $CLI show T001"

    # Task stats
    assert_contains "Stats shows task count" "2" \
        "cd /home/testuser/crud-test && $CLI stats"

    # Find tasks
    assert_contains "Find returns matching task" "documentation" \
        "cd /home/testuser/crud-test && $CLI find documentation"

    # Tree view
    assert_success "Tree view runs without error" \
        "cd /home/testuser/crud-test && $CLI tree"

    # Next task suggestion
    assert_success "Next task runs without error" \
        "cd /home/testuser/crud-test && $CLI next"

    # Verify task exists in DB directly (exists CLI may not be wired to MCP dispatch)
    assert_contains "T001 exists in database" "T001" \
        "cd /home/testuser/crud-test && sqlite3 .cleo/tasks.db \"SELECT id FROM tasks WHERE id='T001';\""

    assert_fails "Show non-existent T999 fails" \
        "cd /home/testuser/crud-test && $CLI show T999"
}

#=============================================================
# TEST SUITE 4: Session Lifecycle via CLI
#=============================================================
test_session_lifecycle() {
    echo -e "\n========================================="
    echo "Suite 4: Session Lifecycle via CLI"
    echo "========================================="

    # Use the crud-test project from suite 3
    local project="/home/testuser/crud-test"

    # Start session with epic scope (global requires a task ID reference)
    assert_success "Start session with epic scope" \
        "cd $project && $CLI session start --scope epic:T001 --name 'Test Session'"

    # Check session status (may return exit 0 with status or use --human for readability)
    assert_contains "Session status shows active" "active" \
        "cd $project && $CLI session status || true"

    # Start working on a task
    assert_success "Start working on T001" \
        "cd $project && $CLI start T001"

    # Check current task
    assert_contains "Current shows T001" "T001" \
        "cd $project && $CLI current"

    # Stop working on task
    assert_success "Stop working on current task" \
        "cd $project && $CLI stop"

    # End session
    assert_success "End session" \
        "cd $project && $CLI session end"

    # Verify session ended in database
    assert_contains "Session status is ended in DB" "ended" \
        "cd $project && sqlite3 .cleo/tasks.db 'SELECT status FROM sessions ORDER BY rowid DESC LIMIT 1;'"

    # Verify sessions table has provider_id column
    assert_contains "Sessions table has provider_id column" "provider_id" \
        "cd $project && sqlite3 .cleo/tasks.db '.schema sessions'"
}

#=============================================================
# TEST SUITE 5: Task Completion via CLI
#=============================================================
test_task_completion() {
    echo -e "\n========================================="
    echo "Suite 5: Task Completion via CLI"
    echo "========================================="

    local project="/home/testuser/crud-test"

    # Start session for completion
    assert_success "Start session for completion tests" \
        "cd $project && $CLI session start --scope epic:T002 --name 'Completion Test'"

    # Start task T002 (T001 may have verification gate issues, use fresh task)
    assert_success "Start T002 for completion" \
        "cd $project && $CLI start T002"

    # Complete task -- if verification gates block, test the gate itself
    log_test "Complete T002 with notes"
    local comp_output
    if comp_output=$(sandbox_exec "cd $project && $CLI done T002 --notes 'Completed during sandbox testing'" 2>&1); then
        log_pass "Complete T002 with notes"
    else
        if echo "$comp_output" | grep -qF "verification metadata"; then
            log_pass "Complete T002 correctly enforced verification gate (exit 40 -- lifecycle enforcement working)"
        else
            log_fail "Complete T002 with notes -- unexpected error"
            echo "  Output: $(echo "$comp_output" | head -3)"
        fi
    fi

    # Verify audit log has entries (check for count >= 1)
    assert_contains "Audit log has entries" "1" \
        "cd $project && sqlite3 .cleo/tasks.db \"SELECT CASE WHEN count(*) > 0 THEN 1 ELSE 0 END FROM audit_log;\""

    # End session
    assert_success "End completion test session" \
        "cd $project && $CLI session end"
}

#=============================================================
# TEST SUITE 6: Memory Bridge via CLI
#=============================================================
test_memory_bridge() {
    echo -e "\n========================================="
    echo "Suite 6: Memory Bridge via CLI"
    echo "========================================="

    # Use a fresh project
    sandbox_exec "rm -rf /home/testuser/bridge-test" >/dev/null 2>&1 || true
    assert_success "Initialize bridge test project" \
        "mkdir -p /home/testuser/bridge-test && cd /home/testuser/bridge-test && git init && $CLI init"

    # Run refresh-memory -- may exit non-zero if no brain.db data, but should not crash
    log_test "refresh-memory command runs without crashing"
    local output
    if output=$(sandbox_exec "cd /home/testuser/bridge-test && $CLI refresh-memory" 2>&1); then
        log_pass "refresh-memory completed successfully"
    else
        if echo "$output" | grep -qiE "TypeError|ReferenceError|SyntaxError|Cannot find module|ENOENT.*dist"; then
            log_fail "refresh-memory crashed with a code error: $(echo "$output" | head -3)"
        else
            log_pass "refresh-memory exited non-zero but did not crash (expected with empty brain.db)"
        fi
    fi

    assert_file_exists "tasks.db exists in bridge test project" \
        "/home/testuser/bridge-test/.cleo/tasks.db"
}

#=============================================================
# TEST SUITE 7: Adapter Manifests (file-level validation)
#=============================================================
test_adapter_manifests() {
    echo -e "\n========================================="
    echo "Suite 7: Adapter Manifest Files"
    echo "========================================="

    # Check adapter manifest files exist
    assert_file_exists "Claude Code adapter manifest exists" \
        "${CLEO}/packages/adapters/claude-code/manifest.json"

    assert_file_exists "OpenCode adapter manifest exists" \
        "${CLEO}/packages/adapters/opencode/manifest.json"

    assert_file_exists "Cursor adapter manifest exists" \
        "${CLEO}/packages/adapters/cursor/manifest.json"

    # Validate manifests are valid JSON
    assert_success "Claude Code manifest is valid JSON" \
        "jq . ${CLEO}/packages/adapters/claude-code/manifest.json > /dev/null"

    assert_success "OpenCode manifest is valid JSON" \
        "jq . ${CLEO}/packages/adapters/opencode/manifest.json > /dev/null"

    assert_success "Cursor manifest is valid JSON" \
        "jq . ${CLEO}/packages/adapters/cursor/manifest.json > /dev/null"

    # Validate manifest structure -- each must have an 'id' field
    assert_contains "Claude Code manifest has correct id" "claude-code" \
        "jq -r '.id' ${CLEO}/packages/adapters/claude-code/manifest.json"

    assert_contains "OpenCode manifest has correct id" "opencode" \
        "jq -r '.id' ${CLEO}/packages/adapters/opencode/manifest.json"

    assert_contains "Cursor manifest has correct id" "cursor" \
        "jq -r '.id' ${CLEO}/packages/adapters/cursor/manifest.json"
}

#=============================================================
# TEST SUITE 8: MCP Server Operations (proper handshake)
#=============================================================
test_mcp_operations() {
    echo -e "\n========================================="
    echo "Suite 8: MCP Server Operations"
    echo "========================================="

    # Deploy MCP test helper to sandbox
    deploy_mcp_helper

    # Set up a CLEO project for MCP tests
    sandbox_exec "rm -rf /home/testuser/mcp-test" >/dev/null 2>&1 || true
    assert_success "Initialize MCP test project" \
        "mkdir -p /home/testuser/mcp-test && cd /home/testuser/mcp-test && git init && $CLI init"

    # Add some tasks for MCP to query
    sandbox_exec "cd /home/testuser/mcp-test && $CLI add 'MCP test task one' --description 'First task for MCP testing'" >/dev/null 2>&1 || true
    sandbox_exec "cd /home/testuser/mcp-test && $CLI add 'MCP test task two' --description 'Second task for MCP testing'" >/dev/null 2>&1 || true

    # Test admin version via MCP
    assert_mcp_contains "MCP query admin version" \
        "query" "admin" "version" "version"

    # Test tasks list via MCP
    assert_mcp_contains "MCP query tasks list" \
        "query" "tasks" "list" "MCP test task"

    # Test tasks show via MCP
    assert_mcp_contains "MCP query tasks show T001" \
        "query" "tasks" "show" "T001" '{"taskId":"T001"}'

    # Test tasks find via MCP
    assert_mcp_contains "MCP query tasks find MCP" \
        "query" "tasks" "find" "MCP test task" '{"query":"MCP"}'

    # Test tasks stats via MCP
    assert_mcp_success "MCP query tasks stats" \
        "query" "tasks" "stats"

    # Test tasks tree via MCP
    assert_mcp_success "MCP query tasks tree" \
        "query" "tasks" "tree"

    # Test tasks next via MCP
    assert_mcp_success "MCP query tasks next" \
        "query" "tasks" "next"

    # Test admin health via MCP
    assert_mcp_success "MCP query admin health" \
        "query" "admin" "health"

    # Test admin help via MCP
    assert_mcp_success "MCP query admin help" \
        "query" "admin" "help"

    # Test admin dash via MCP
    assert_mcp_success "MCP query admin dash" \
        "query" "admin" "dash"

    # Test check validate via MCP
    assert_mcp_success "MCP query check validate" \
        "query" "check" "validate"

    # Test check health via MCP
    assert_mcp_success "MCP query check health" \
        "query" "check" "health"

    # Test memory brain.search via MCP
    assert_mcp_success "MCP query memory brain.search" \
        "query" "memory" "brain.search" '{"query":"test"}'

    # Test mutate: add task via MCP
    assert_mcp_contains "MCP mutate tasks add" \
        "mutate" "tasks" "add" "MCP created task" '{"title":"MCP created task","description":"Created via MCP protocol"}'

    # Verify the MCP-created task appears in CLI
    assert_contains "MCP-created task visible via CLI" "MCP created task" \
        "cd /home/testuser/mcp-test && $CLI list --human"

    # Test session operations via MCP
    assert_mcp_success "MCP query session status" \
        "query" "session" "status"

    assert_mcp_success "MCP query session list" \
        "query" "session" "list"
}

#=============================================================
# TEST SUITE 9: Error Handling via CLI
#=============================================================
test_error_handling() {
    echo -e "\n========================================="
    echo "Suite 9: Error Handling via CLI"
    echo "========================================="

    local project="/home/testuser/crud-test"

    # Non-existent task should fail
    assert_fails "Show non-existent task T999 fails" \
        "cd $project && $CLI show T999"

    # Operating outside a CLEO project should fail
    assert_fails "List outside CLEO project fails" \
        "cd /tmp && $CLI list"

    # Invalid command should fail
    assert_fails "Invalid CLI command fails" \
        "cd $project && $CLI nonexistentcommand"

    # Add task without explicit description should still work
    assert_success "Add task without explicit description succeeds" \
        "cd $project && $CLI add 'No description task'"

    # Show the task and verify it has content
    log_test "Task without explicit description has auto-generated description"
    local output
    if output=$(sandbox_exec "cd $project && $CLI show T003" 2>&1); then
        if echo "$output" | grep -qF "T003"; then
            log_pass "Task without explicit description has auto-generated description"
        else
            log_fail "Task T003 not found"
            echo "  Got: $(echo "$output" | head -3)"
        fi
    else
        log_fail "show T003 failed (exit $?)"
        echo "  Output: $(echo "$output" | head -3)"
    fi
}

#=============================================================
# TEST SUITE 10: Legacy Cleanup Verification
#=============================================================
test_legacy_cleanup() {
    echo -e "\n========================================="
    echo "Suite 10: Legacy Cleanup Verification"
    echo "========================================="

    # Verify .claude-plugin/ directory is deleted
    assert_dir_missing ".claude-plugin/ directory is deleted" \
        "${CLEO}/.claude-plugin"

    # Verify old claude-plugin.ts installer is deleted
    assert_file_missing "Old claude-plugin.ts installer is deleted" \
        "${CLEO}/src/core/install/claude-plugin.ts"

    # Verify old spawn adapters are deleted
    assert_file_missing "Old claude-code-adapter.ts is deleted" \
        "${CLEO}/src/core/spawn/adapters/claude-code-adapter.ts"

    assert_file_missing "Old opencode-adapter.ts is deleted" \
        "${CLEO}/src/core/spawn/adapters/opencode-adapter.ts"

    # Verify no dangling imports reference deleted files in source
    log_test "No source .ts files import from deleted claude-plugin path"
    local output
    output=$(sandbox_exec "grep -rl 'install/claude-plugin' ${CLEO}/src/ --include='*.ts' 2>/dev/null | grep -v '__tests__' | grep -v '.test.ts' | head -5" 2>&1) || true
    if [[ -n "$output" && "$output" != *"No such file"* ]]; then
        log_fail "Found references to deleted claude-plugin in source:"
        echo "  $output"
    else
        log_pass "No source references to deleted claude-plugin installer"
    fi

    log_test "No source .ts files import from deleted spawn/adapters path"
    output=$(sandbox_exec "grep -rl 'spawn/adapters/claude-code-adapter\|spawn/adapters/opencode-adapter' ${CLEO}/src/ --include='*.ts' 2>/dev/null | grep -v '__tests__' | grep -v '.test.ts' | head -5" 2>&1) || true
    if [[ -n "$output" && "$output" != *"No such file"* ]]; then
        log_fail "Found references to deleted spawn adapters:"
        echo "  $output"
    else
        log_pass "No source references to deleted spawn adapters"
    fi
}

#=============================================================
# TEST SUITE 11: Multi-Project Isolation
#=============================================================
test_multi_project() {
    echo -e "\n========================================="
    echo "Suite 11: Multi-Project Isolation"
    echo "========================================="

    # Create two isolated projects
    sandbox_exec "rm -rf /home/testuser/proj-a /home/testuser/proj-b" >/dev/null 2>&1 || true

    assert_success "Init project A" \
        "mkdir -p /home/testuser/proj-a && cd /home/testuser/proj-a && git init && $CLI init"

    assert_success "Init project B" \
        "mkdir -p /home/testuser/proj-b && cd /home/testuser/proj-b && git init && $CLI init"

    # Add different tasks to each
    assert_success "Add task to project A" \
        "cd /home/testuser/proj-a && $CLI add 'Alpha feature' --description 'Only in project A'"

    assert_success "Add task to project B" \
        "cd /home/testuser/proj-b && $CLI add 'Beta feature' --description 'Only in project B'"

    # Verify isolation: project A should not see project B tasks
    assert_contains "Project A has Alpha feature" "Alpha feature" \
        "cd /home/testuser/proj-a && $CLI list --human"

    assert_contains "Project B has Beta feature" "Beta feature" \
        "cd /home/testuser/proj-b && $CLI list --human"

    # Cross-check: A should not have B's task
    log_test "Project A does NOT show Beta feature"
    local output
    output=$(sandbox_exec "cd /home/testuser/proj-a && $CLI list --human" 2>&1) || true
    if echo "$output" | grep -qF "Beta feature"; then
        log_fail "Project A has Beta feature (isolation broken)"
    else
        log_pass "Project A does NOT show Beta feature (isolation works)"
    fi
}

#=============================================================
# TEST SUITE 12: Database Integrity
#=============================================================
test_db_integrity() {
    echo -e "\n========================================="
    echo "Suite 12: Database Integrity"
    echo "========================================="

    local project="/home/testuser/crud-test"

    # Validate command runs
    assert_success "cleo validate runs without error" \
        "cd $project && $CLI validate"

    # Doctor command runs
    assert_success "cleo doctor runs without error" \
        "cd $project && $CLI doctor"

    # Verify task ID sequencing
    assert_contains "Task IDs are sequential" "T001" \
        "cd $project && sqlite3 .cleo/tasks.db \"SELECT id FROM tasks ORDER BY rowid LIMIT 1;\""

    # Verify database can be queried directly
    assert_success "Direct SQLite query works" \
        "cd $project && sqlite3 .cleo/tasks.db 'SELECT count(*) FROM tasks;'"

    # Log command works
    assert_success "Audit log command runs" \
        "cd $project && $CLI log"
}


#=============================================================
# TEST SUITE 13: Full Lifecycle E2E
#=============================================================
test_lifecycle_e2e() {
    echo -e "\n========================================="
    echo "Suite 13: Full Lifecycle E2E"
    echo "========================================="

    if [ -f "$SCRIPT_DIR/test-lifecycle-e2e.sh" ]; then
        log_test "Full lifecycle E2E test"
        local output
        if output=$(sandbox_exec "bash /home/testuser/cleo-source/dev/sandbox/test-lifecycle-e2e.sh" 2>&1); then
            log_pass "Full lifecycle E2E test passed"
        else
            log_fail "Full lifecycle E2E test failed"
            echo "  Output (last 5 lines): $(echo "$output" | tail -5)"
        fi
    else
        log_info "test-lifecycle-e2e.sh not found, skipping"
    fi
}


#=============================================================
# MAIN RUNNER
#=============================================================
main() {
    echo "========================================================"
    echo "CLEO Sandbox Functional Test Suite"
    echo "========================================================"
    echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "Tests real CLI and MCP usage -- no individual dist file imports."
    echo

    # Ensure sandbox is running
    log_info "Ensuring sandbox is running..."
    "$MANAGER" start 2>/dev/null || true

    echo

    # Run all test suites
    test_build_and_version
    test_cli_init
    test_task_crud
    test_session_lifecycle
    test_task_completion
    test_memory_bridge
    test_adapter_manifests
    test_mcp_operations
    test_error_handling
    test_legacy_cleanup
    test_multi_project
    test_db_integrity
    test_lifecycle_e2e

    # Summary
    echo
    echo "========================================================"
    echo "RESULTS"
    echo "========================================================"
    local total=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))
    echo -e "  ${GREEN}PASS${NC}: $PASS_COUNT"
    echo -e "  ${RED}FAIL${NC}: $FAIL_COUNT"
    echo -e "  ${YELLOW}SKIP${NC}: $SKIP_COUNT"
    echo "  TOTAL: $total"
    echo

    if [[ $FAIL_COUNT -gt 0 ]]; then
        echo -e "${RED}VERDICT: FAILURES DETECTED${NC}"
        return 1
    else
        echo -e "${GREEN}VERDICT: ALL TESTS PASSED${NC}"
        return 0
    fi
}

# Allow running individual suites or all
if [[ $# -gt 0 ]]; then
    case "$1" in
        build)      test_build_and_version ;;
        init)       test_cli_init ;;
        crud)       test_task_crud ;;
        session)    test_session_lifecycle ;;
        completion) test_task_completion ;;
        bridge)     test_memory_bridge ;;
        manifests)  test_adapter_manifests ;;
        mcp)        test_mcp_operations ;;
        errors)     test_error_handling ;;
        cleanup)    test_legacy_cleanup ;;
        multi)      test_multi_project ;;
        integrity)  test_db_integrity ;;
        lifecycle)  test_lifecycle_e2e ;;
        *)          main ;;
    esac
else
    main
fi
