#!/usr/bin/env bash
# Simple CLEO workflow test for sandbox

set -euo pipefail

MANAGER="$(dirname "$0")/sandbox-manager.sh"

echo "=== CLEO Simple Workflow Test ==="
echo

# Test 1: Create new project with simpler config
echo "1. Creating fresh test project..."
$MANAGER exec "rm -rf ~/simple-test && mkdir -p ~/simple-test && cd ~/simple-test && echo '{\"session\":{\"requireSession\":false}}' > init-config.json && /home/testuser/.local/bin/cleo init"

# Test 2: Add tasks without session
echo "2. Adding tasks..."
$MANAGER exec "cd ~/simple-test && /home/testuser/.local/bin/cleo add 'First task'"
$MANAGER exec "cd ~/simple-test && /home/testuser/.local/bin/cleo add 'Second task'"

# Test 3: List tasks
echo "3. Listing tasks..."
$MANAGER exec "cd ~/simple-test && /home/testuser/.local/bin/cleo list"

# Test 4: Show specific task
echo "4. Showing task details..."
$MANAGER exec "cd ~/simple-test && /home/testuser/.local/bin/cleo show T001"

# Test 5: Complete task
echo "5. Completing first task..."
$MANAGER exec "cd ~/simple-test && /home/testuser/.local/bin/cleo done T001 --notes 'Completed during sandbox test'"

# Test 6: Verify completion
echo "6. Verifying completion..."
$MANAGER exec "cd ~/simple-test && /home/testuser/.local/bin/cleo show T001"

echo
echo "=== Test Complete ==="
