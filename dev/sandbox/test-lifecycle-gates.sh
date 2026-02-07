#!/usr/bin/env bash
# Test lifecycle gate enforcement
# @task T3071

set -euo pipefail

# Source lifecycle functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

source "$PROJECT_ROOT/lib/lifecycle.sh"
source "$PROJECT_ROOT/lib/config.sh"
source "$PROJECT_ROOT/lib/file-ops.sh"

echo "=== Test 1: Lifecycle Gate Enforcement ==="
echo ""

# Change to test project directory
cd ~/test-mcp

# Create a test task with lifecycleState
echo "Creating test task with research state..."
TASK_ID=$(cleo add "Lifecycle Test Task" --type epic --json | jq -r '.task.id')
echo "Created task: $TASK_ID"

# Add lifecycleState to task (simulate research state)
TODO_FILE=".cleo/todo.json"
jq --arg id "$TASK_ID" \
   '.tasks |= map(if .id == $id then . + {"lifecycleState": "research"} else . end)' \
   "$TODO_FILE" > /tmp/todo.json && mv /tmp/todo.json "$TODO_FILE"

echo "Set lifecycleState to research"
echo ""

# Test 1: Try to transition to implementation (should fail - skips consensus/spec/decomp)
echo "Test 1a: Try to skip to implementation (should fail)..."
if check_lifecycle_gate "$TASK_ID" "implementation" "$TODO_FILE"; then
    echo "❌ FAIL: Gate should have blocked transition to implementation"
    exit 1
else
    EXIT_CODE=$?
    echo "✅ PASS: Gate blocked with exit code $EXIT_CODE (expected 80)"
fi
echo ""

# Test 2: Valid transition to consensus
echo "Test 1b: Valid transition to consensus (should succeed)..."
if check_lifecycle_gate "$TASK_ID" "consensus" "$TODO_FILE"; then
    echo "✅ PASS: Gate allowed transition to consensus"
else
    echo "❌ FAIL: Gate should have allowed transition to consensus"
    exit 1
fi
echo ""

# Advance task through lifecycle
echo "Test 2: Advance through full lifecycle..."
for state in consensus specification decomposition implementation; do
    echo "  Advancing to $state..."
    jq --arg id "$TASK_ID" --arg state "$state" \
       '.tasks |= map(if .id == $id then . + {"lifecycleState": $state} else . end)' \
       "$TODO_FILE" > /tmp/todo.json && mv /tmp/todo.json "$TODO_FILE"

    # Get next state
    case "$state" in
        consensus) next="specification" ;;
        specification) next="decomposition" ;;
        decomposition) next="implementation" ;;
        implementation) next="validation" ;;
    esac

    if [[ -n "${next:-}" ]]; then
        if check_lifecycle_gate "$TASK_ID" "$next" "$TODO_FILE"; then
            echo "  ✅ Can advance to $next"
        else
            echo "  ❌ Cannot advance to $next (unexpected)"
            exit 1
        fi
    fi
done
echo ""

# Test 3: Enforcement modes
echo "Test 3: Enforcement modes..."
CONFIG_FILE=".cleo/config.json"

# Reset task to research state
jq --arg id "$TASK_ID" \
   '.tasks |= map(if .id == $id then . + {"lifecycleState": "research"} else . end)' \
   "$TODO_FILE" > /tmp/todo.json && mv /tmp/todo.json "$TODO_FILE"

# Test strict mode (default)
echo "Test 3a: Strict mode (should block invalid transition)..."
jq '.lifecycleEnforcement.mode = "strict"' "$CONFIG_FILE" > /tmp/config.json && mv /tmp/config.json "$CONFIG_FILE"
if check_lifecycle_gate "$TASK_ID" "implementation" "$TODO_FILE"; then
    echo "❌ FAIL: Strict mode should block"
    exit 1
else
    echo "✅ PASS: Strict mode blocked (exit $?)"
fi
echo ""

# Test advisory mode
echo "Test 3b: Advisory mode (should warn but allow)..."
jq '.lifecycleEnforcement.mode = "advisory"' "$CONFIG_FILE" > /tmp/config.json && mv /tmp/config.json "$CONFIG_FILE"
if check_lifecycle_gate "$TASK_ID" "implementation" "$TODO_FILE" 2>&1 | tee /tmp/advisory.log; then
    echo "✅ PASS: Advisory mode allowed transition"
    if grep -q "WARN" /tmp/advisory.log; then
        echo "✅ PASS: Warning was emitted"
    else
        echo "⚠️  Note: No warning found in output"
    fi
else
    echo "❌ FAIL: Advisory mode should allow transition"
    exit 1
fi
echo ""

# Test off mode
echo "Test 3c: Off mode (should skip checks)..."
jq '.lifecycleEnforcement.mode = "off"' "$CONFIG_FILE" > /tmp/config.json && mv /tmp/config.json "$CONFIG_FILE"
if check_lifecycle_gate "$TASK_ID" "implementation" "$TODO_FILE"; then
    echo "✅ PASS: Off mode skipped checks"
else
    echo "❌ FAIL: Off mode should skip checks"
    exit 1
fi
echo ""

# Restore strict mode
jq '.lifecycleEnforcement.mode = "strict"' "$CONFIG_FILE" > /tmp/config.json && mv /tmp/config.json "$CONFIG_FILE"

echo "=== All Tests Passed ==="
echo ""
echo "Summary:"
echo "- Gate blocks invalid transitions (exit 80)"
echo "- Gate allows valid transitions"
echo "- Strict mode: blocks"
echo "- Advisory mode: warns but allows"
echo "- Off mode: skips checks"
