#!/usr/bin/env bash
# Simple CLEO workflow smoke test for sandbox

set -euo pipefail

SSH_KEY_PATH="${HOME}/.cleo/sandbox/ssh/sandbox_key"
SSH_PORT="2222"
CLEO="/home/testuser/cleo-source"
CLI="node ${CLEO}/packages/cleo/dist/cli/index.js"

sandbox_run() {
    ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR \
        -p "$SSH_PORT" -i "$SSH_KEY_PATH" \
        testuser@localhost "$@" 2>&1
}

echo "=== CLEO Simple Workflow Test ==="
echo

# Test 1: Create new project
echo "1. Creating fresh test project..."
sandbox_run "rm -rf ~/simple-test && mkdir -p ~/simple-test && cd ~/simple-test && git init && $CLI init"

# Test 2: Add tasks
echo "2. Adding tasks..."
sandbox_run "cd ~/simple-test && $CLI add 'First task' --description 'The first test task'"
sandbox_run "cd ~/simple-test && $CLI add 'Second task' --description 'The second test task'"

# Test 3: List tasks
echo "3. Listing tasks..."
sandbox_run "cd ~/simple-test && $CLI list"

# Test 4: Show specific task
echo "4. Showing task details..."
sandbox_run "cd ~/simple-test && $CLI show T001"

# Test 5: Complete task
echo "5. Completing first task..."
sandbox_run "cd ~/simple-test && $CLI session start --scope epic:T001 --name 'Smoke Test'"
sandbox_run "cd ~/simple-test && $CLI start T001"
sandbox_run "cd ~/simple-test && $CLI done T001 --notes 'Completed during sandbox smoke test'"
sandbox_run "cd ~/simple-test && $CLI session end"

# Test 6: Verify completion
echo "6. Verifying completion..."
sandbox_run "cd ~/simple-test && $CLI show T001"

echo
echo "=== Test Complete ==="
