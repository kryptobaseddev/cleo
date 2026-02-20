#!/usr/bin/env bats
# commit-hook.bats - Tests for commit-msg hook task enforcement
# @task T2702
# Part of Epic T2679: Protocol Enforcement and RCSD-IVTR Alignment

load '../libs/bats-support/load'
load '../libs/bats-assert/load'

# Setup test environment
setup() {
    # Create temp directory for test git repo
    export TEST_TEMP_DIR="${BATS_TEST_TMPDIR}/commit-hook-test-$$"
    mkdir -p "$TEST_TEMP_DIR"
    cd "$TEST_TEMP_DIR"

    # Initialize git repo
    git init -q
    git config user.email "test@example.com"
    git config user.name "Test User"

    # Create initial commit
    echo "initial" > initial.txt
    git add initial.txt
    git commit -q -m "Initial commit"

    # Create .cleo directory structure
    mkdir -p .cleo

    # Copy commit-msg hook
    mkdir -p .git/hooks
    # Dynamic path resolution for portability
    local project_root
    project_root="$(cd "$(dirname "${BATS_TEST_FILENAME}")/../.." && pwd)"
    cp "${project_root}/.cleo/templates/git-hooks/commit-msg" .git/hooks/commit-msg
    chmod +x .git/hooks/commit-msg

    # Create minimal CLEO database with test tasks
    cat > .cleo/todo.json <<'EOF'
{
  "tasks": [
    {
      "id": "T1234",
      "title": "Test Task",
      "status": "active",
      "description": "Test task for hook validation"
    },
    {
      "id": "T5678",
      "title": "Another Task",
      "status": "pending",
      "description": "Another test task"
    }
  ],
  "nextId": 9999
}
EOF

    # Mock cleo command that reads from .cleo/todo.json
    cat > cleo <<'EOF'
#!/bin/bash
# Mock cleo command for testing

if [[ "$1" == "exists" ]]; then
    task_id="$2"
    if grep -q "\"id\": \"$task_id\"" .cleo/todo.json 2>/dev/null; then
        exit 0
    else
        exit 4  # E_NOT_FOUND
    fi
elif [[ "$1" == "focus" && "$2" == "show" ]]; then
    echo '{"task":{"id":"T1234"}}'
fi
EOF
    chmod +x cleo
    export PATH="$TEST_TEMP_DIR:$PATH"
}

# Cleanup
teardown() {
    cd /
    rm -rf "$TEST_TEMP_DIR"
}

# ============================================================================
# VALID COMMIT MESSAGES
# ============================================================================

@test "commit hook accepts valid task ID in message" {
    echo "test" > file.txt
    git add file.txt

    run git commit -m "feat: Add feature (T1234)"
    assert_success
    assert_output --partial "✓ Commit linked to T1234"
}

@test "commit hook accepts task ID at end of message" {
    echo "test" > file.txt
    git add file.txt

    run git commit -m "fix: Bug fix (T5678)"
    assert_success
    assert_output --partial "✓ Commit linked to T5678"
}

@test "commit hook accepts task ID in middle of message" {
    echo "test" > file.txt
    git add file.txt

    run git commit -m "feat(module): Add feature (T1234) with tests"
    assert_success
    assert_output --partial "✓ Commit linked to T1234"
}

@test "commit hook extracts first task ID when multiple present" {
    echo "test" > file.txt
    git add file.txt

    run git commit -m "feat: Merge features (T1234) and (T5678)"
    assert_success
    assert_output --partial "✓ Commit linked to T1234"
}

# ============================================================================
# INVALID COMMIT MESSAGES
# ============================================================================

@test "commit hook rejects message without task ID" {
    echo "test" > file.txt
    git add file.txt

    run git commit -m "feat: Add feature without task"
    assert_failure
    assert_output --partial "ERROR: No task ID in commit message"
    assert_output --partial "Current focus: T1234"
}

@test "commit hook suggests focused task when no ID provided" {
    echo "test" > file.txt
    git add file.txt

    run git commit -m "fix: Simple fix"
    assert_failure
    assert_output --partial "Current focus: T1234"
    assert_output --partial "fix: Simple fix (T1234)"
}

@test "commit hook rejects non-existent task ID" {
    echo "test" > file.txt
    git add file.txt

    run git commit -m "feat: Add feature (T9999)"
    assert_failure
    assert_output --partial "ERROR: Task T9999 not found"
    assert_output --partial "cleo find"
}

@test "commit hook provides bypass instructions" {
    echo "test" > file.txt
    git add file.txt

    run git commit -m "feat: No task"
    assert_failure
    assert_output --partial "git commit --no-verify"
}

# ============================================================================
# BYPASS SCENARIOS
# ============================================================================

@test "commit hook allows bypass with --no-verify" {
    echo "test" > file.txt
    git add file.txt

    run git commit --no-verify -m "feat: Emergency fix"
    assert_success
}

@test "commit hook auto-bypasses merge commits" {
    echo "test" > file.txt
    git add file.txt

    # Create commit message file to simulate merge
    echo "Merge branch 'feature' into main" > .git/COMMIT_EDITMSG

    run .git/hooks/commit-msg .git/COMMIT_EDITMSG
    assert_success
}

@test "commit hook auto-bypasses revert commits" {
    echo "test" > file.txt
    git add file.txt

    # Create commit message file for revert
    echo "Revert \"feat: Bad commit\"" > .git/COMMIT_EDITMSG

    run .git/hooks/commit-msg .git/COMMIT_EDITMSG
    assert_success
}

@test "commit hook auto-bypasses in CI environment" {
    echo "test" > file.txt
    git add file.txt

    # Set CI environment variable
    export CI=true

    echo "feat: CI deployment" > .git/COMMIT_EDITMSG
    run .git/hooks/commit-msg .git/COMMIT_EDITMSG
    assert_success

    unset CI
}

@test "commit hook auto-bypasses in GitHub Actions" {
    echo "test" > file.txt
    git add file.txt

    # Set GitHub Actions environment variable
    export GITHUB_ACTIONS=true

    echo "feat: GHA deployment" > .git/COMMIT_EDITMSG
    run .git/hooks/commit-msg .git/COMMIT_EDITMSG
    assert_success

    unset GITHUB_ACTIONS
}

# ============================================================================
# BYPASS LOGGING
# ============================================================================

@test "commit hook logs merge commit bypass" {
    # Create commit message file to simulate merge
    echo "Merge branch 'feature' into main" > .git/COMMIT_EDITMSG

    run .git/hooks/commit-msg .git/COMMIT_EDITMSG
    assert_success

    # Check bypass log was created
    assert [ -f .cleo/bypass-log.json ]

    # Verify log entry structure
    run cat .cleo/bypass-log.json
    assert_output --partial '"justification": "automated"'
    assert_output --partial '"note": "Merge commit detected"'
    assert_output --partial '"hook": "commit-msg"'
}

@test "commit hook logs revert commit bypass" {
    echo "Revert \"feat: Bad commit\"" > .git/COMMIT_EDITMSG

    run .git/hooks/commit-msg .git/COMMIT_EDITMSG
    assert_success

    assert [ -f .cleo/bypass-log.json ]

    run cat .cleo/bypass-log.json
    assert_output --partial '"justification": "automated"'
    assert_output --partial '"note": "Revert commit detected"'
}

@test "commit hook logs CI bypass" {
    export CI=true
    echo "feat: CI deployment" > .git/COMMIT_EDITMSG

    run .git/hooks/commit-msg .git/COMMIT_EDITMSG
    assert_success

    assert [ -f .cleo/bypass-log.json ]

    run cat .cleo/bypass-log.json
    assert_output --partial '"justification": "automated"'
    assert_output --partial '"note": "CI/CD environment detected"'

    unset CI
}

@test "commit hook bypass log contains all required fields" {
    echo "Merge branch 'test'" > .git/COMMIT_EDITMSG

    .git/hooks/commit-msg .git/COMMIT_EDITMSG

    # Parse bypass log entry
    local entry
    entry=$(cat .cleo/bypass-log.json)

    # Verify all required fields present
    echo "$entry" | jq -e '.timestamp' >/dev/null
    echo "$entry" | jq -e '.commit' >/dev/null
    echo "$entry" | jq -e '.user' >/dev/null
    echo "$entry" | jq -e '.session' >/dev/null
    echo "$entry" | jq -e '.message' >/dev/null
    echo "$entry" | jq -e '.justification' >/dev/null
    echo "$entry" | jq -e '.note' >/dev/null
    echo "$entry" | jq -e '.hook' >/dev/null
}

# ============================================================================
# TASK ID PATTERN MATCHING
# ============================================================================

@test "commit hook matches task ID with parentheses" {
    echo "test" > file.txt
    git add file.txt

    run git commit -m "feat: Feature (T1234)"
    assert_success
}

@test "commit hook matches task ID with multiple digits" {
    # Add task with more digits
    jq '.tasks += [{"id":"T123456","title":"Big ID","status":"active","description":"Test"}]' \
        .cleo/todo.json > .cleo/todo.json.tmp
    mv .cleo/todo.json.tmp .cleo/todo.json

    echo "test" > file.txt
    git add file.txt

    run git commit -m "feat: Feature (T123456)"
    assert_success
    assert_output --partial "✓ Commit linked to T123456"
}

@test "commit hook ignores lowercase task references" {
    echo "test" > file.txt
    git add file.txt

    # Should fail because (t1234) is not valid pattern
    run git commit -m "feat: Feature (t1234)"
    assert_failure
    assert_output --partial "ERROR: No task ID in commit message"
}

@test "commit hook ignores task ID without parentheses" {
    echo "test" > file.txt
    git add file.txt

    # Should fail because T1234 without parens is not valid pattern
    run git commit -m "feat: Feature T1234"
    assert_failure
    assert_output --partial "ERROR: No task ID in commit message"
}

# ============================================================================
# ERROR MESSAGE QUALITY
# ============================================================================

@test "commit hook provides clear error for missing task ID" {
    echo "test" > file.txt
    git add file.txt

    run git commit -m "feat: No task"
    assert_failure
    assert_output --partial "ERROR: No task ID in commit message"
    assert_output --partial "Suggested format:"
}

@test "commit hook provides clear error for non-existent task" {
    echo "test" > file.txt
    git add file.txt

    run git commit -m "feat: Bad task (T9999)"
    assert_failure
    assert_output --partial "ERROR: Task T9999 not found"
    assert_output --partial "cleo find"
}

@test "commit hook suggests current focus when available" {
    echo "test" > file.txt
    git add file.txt

    run git commit -m "feat: Missing task"
    assert_failure
    assert_output --partial "Current focus: T1234"
    assert_output --partial "Suggested format:"
}

# ============================================================================
# INTEGRATION WITH CLEO
# ============================================================================

@test "commit hook calls cleo exists to validate task" {
    echo "test" > file.txt
    git add file.txt

    # Mock cleo to track calls
    cat > cleo <<'EOF'
#!/bin/bash
echo "exists called with: $2" >> /tmp/cleo-calls.txt
if [[ "$1" == "exists" && "$2" == "T1234" ]]; then
    exit 0
fi
exit 4
EOF
    chmod +x cleo

    rm -f /tmp/cleo-calls.txt

    git commit -m "feat: Test (T1234)" || true

    # Verify cleo exists was called
    assert [ -f /tmp/cleo-calls.txt ]
    run cat /tmp/cleo-calls.txt
    assert_output --partial "exists called with: T1234"

    rm -f /tmp/cleo-calls.txt
}

@test "commit hook calls cleo focus show when no task ID" {
    echo "test" > file.txt
    git add file.txt

    # Mock cleo to track calls
    cat > cleo <<'EOF'
#!/bin/bash
if [[ "$1" == "focus" && "$2" == "show" ]]; then
    echo '{"task":{"id":"T1234"}}'
    exit 0
fi
exit 0
EOF
    chmod +x cleo

    run git commit -m "feat: No task"
    assert_failure
    assert_output --partial "Current focus: T1234"
}

@test "commit hook handles cleo not installed gracefully" {
    # Remove cleo from path
    rm -f cleo

    echo "test" > file.txt
    git add file.txt

    run git commit -m "feat: No task (T1234)"
    # Should not crash, just skip validation
    assert_success
}

# ============================================================================
# EDGE CASES
# ============================================================================

@test "commit hook handles empty commit message" {
    echo "test" > file.txt
    git add file.txt

    echo "" > .git/COMMIT_EDITMSG
    run .git/hooks/commit-msg .git/COMMIT_EDITMSG
    assert_failure
}

@test "commit hook handles very long commit message" {
    echo "test" > file.txt
    git add file.txt

    local long_msg="feat: "$(printf 'A%.0s' {1..500})" (T1234)"
    run git commit -m "$long_msg"
    assert_success
}

@test "commit hook handles special characters in message" {
    echo "test" > file.txt
    git add file.txt

    run git commit -m "feat: Fix \$VAR expansion (T1234)"
    assert_success
}

@test "commit hook handles multiline commit message" {
    echo "test" > file.txt
    git add file.txt

    cat > .git/COMMIT_EDITMSG <<'EOF'
feat: Add feature (T1234)

This is a longer description
with multiple lines.
EOF

    run .git/hooks/commit-msg .git/COMMIT_EDITMSG
    assert_success
    assert_output --partial "✓ Commit linked to T1234"
}

@test "commit hook handles commit message with multiple task references" {
    echo "test" > file.txt
    git add file.txt

    run git commit -m "feat: Merge (T1234) and (T5678)"
    assert_success
    # Should accept first task ID
    assert_output --partial "✓ Commit linked to T1234"
}

# ============================================================================
# BYPASS LOG EDGE CASES
# ============================================================================

@test "commit hook creates bypass log if directory missing" {
    # Remove .cleo directory
    rm -rf .cleo

    echo "Merge branch 'test'" > .git/COMMIT_EDITMSG
    run .git/hooks/commit-msg .git/COMMIT_EDITMSG

    # Should succeed even without .cleo directory
    assert_success
}

@test "commit hook appends to existing bypass log" {
    # Create initial bypass log with single-line JSON
    echo '{"existing":"entry"}' > .cleo/bypass-log.json

    echo "Merge branch 'test'" > .git/COMMIT_EDITMSG
    .git/hooks/commit-msg .git/COMMIT_EDITMSG

    # Check that file contains original entry
    run cat .cleo/bypass-log.json
    assert_output --partial '"existing":"entry"'
    # And new entry
    assert_output --partial '"justification": "automated"'
}

# ============================================================================
# SESSION INTEGRATION
# ============================================================================

@test "commit hook includes session ID in bypass log when CLEO_SESSION set" {
    export CLEO_SESSION="session_test_123"

    echo "Merge branch 'test'" > .git/COMMIT_EDITMSG
    .git/hooks/commit-msg .git/COMMIT_EDITMSG

    run cat .cleo/bypass-log.json
    assert_output --partial '"session": "session_test_123"'

    unset CLEO_SESSION
}

@test "commit hook handles missing CLEO_SESSION gracefully" {
    unset CLEO_SESSION

    echo "Merge branch 'test'" > .git/COMMIT_EDITMSG
    .git/hooks/commit-msg .git/COMMIT_EDITMSG

    run cat .cleo/bypass-log.json
    assert_output --partial '"session": "none"'
}
