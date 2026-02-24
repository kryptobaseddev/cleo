# Commit Task ID Enforcement Specification

**Version**: 1.0.0
**Status**: ACTIVE
**Created**: 2026-01-28
**Updated**: 2026-01-28
**Author**: Protocol Specification Agent (T2689)

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals.

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174.html

---

## Part 1: Preamble

### 1.1 Purpose

This specification defines the **commit-msg hook** implementation for enforcing task ID inclusion in commit messages, implementing provenance requirements IMPL-003 and CONT-002 from implementation and contribution protocols. It addresses the 0% enforcement gap for commit-level traceability while preserving existing developer conventions.

### 1.2 Authority

This specification is **AUTHORITATIVE** for:

- Commit-msg hook behavior (CMSG-*)
- Task ID pattern validation (PATTERN-*)
- Session scope integration (SCOPE-*)
- Bypass policy and logging (BYPASS-*)
- Edge case handling (EDGE-*)

This specification **DEFERS TO**:

- [PROTOCOL-ENFORCEMENT-SPEC.md](PROTOCOL-ENFORCEMENT-SPEC.md) for overall enforcement architecture
- Implementation protocol (protocols/implementation.md) for IMPL-003 provenance requirements
- Contribution protocol (protocols/contribution.md) for CONT-002 provenance requirements
- Multi-session architecture for session scope context

### 1.3 Scope

This specification governs:

1. **Pattern validation** - Detecting `(T####)` format in commit messages
2. **Session integration** - Validating task IDs against current session scope
3. **Auto-suggestion** - Proposing task IDs from focus context when missing
4. **Bypass handling** - `--no-verify` policy and audit logging
5. **Edge cases** - Multiple task IDs, branch extraction, automated commits

### 1.4 Evidence Base

This specification incorporates findings from:

- **T2686**: Consensus decision (commit-msg hook with session scope, confidence 0.88)
- **T2684**: Wave 0 audit (provenance tagging 0% enforcement despite protocol definitions)
- **Git log analysis**: 100% voluntary adoption of `(T####)` pattern in recent commits

**Key Evidence**:
- Current convention: `(T####)` suffix or flexible placement
- No commits use `Task: T####` prefix format (rejected Option A)
- Pre-commit hook timing wrong for message validation (need commit-msg)
- Session scope available via `CLEO_SESSION` env var and `cleo focus show`

---

## Part 2: Commit-msg Hook Requirements (CMSG-*)

### 2.1 Core Hook Behavior

| ID | Requirement | Rationale |
|----|-------------|-----------|
| CMSG-001 | Commit-msg hook MUST validate task ID presence in commit message | Enforces IMPL-003, CONT-002 provenance requirements |
| CMSG-002 | Hook MUST accept `(T####)` pattern (one or more digits) | Preserves existing convention (100% voluntary adoption) |
| CMSG-003 | Hook MUST verify task ID exists via `cleo exists` command | Prevents references to non-existent tasks |
| CMSG-004 | Hook MUST run after commit message written (commit-msg phase) | Correct Git hook lifecycle timing |
| CMSG-005 | Hook MUST be bypassable via `git commit --no-verify` | Emergency escape hatch per BYPS-001 |
| CMSG-006 | Hook MUST exit with code 1 (error) when validation fails without bypass | Standard Git hook failure signal |
| CMSG-007 | Hook MUST provide helpful error messages with auto-suggestion when available | Developer UX; reduces friction |
| CMSG-008 | Hook SHOULD integrate with session scope validation (Phase 2) | Advanced validation; prevents out-of-scope references |
| CMSG-009 | Hook MAY extract task ID from branch name as fallback | Convenience; validates branch-based workflow |

### 2.2 Hook Installation

| ID | Requirement | Implementation |
|----|-------------|----------------|
| CMSG-010 | Hook MUST be installed via `cleo init` command | Automatic setup for new projects |
| CMSG-011 | Hook MUST be tracked in `.cleo/config.json` for version management | Configuration persistence |
| CMSG-012 | Hook SHOULD be updated via `cleo self-update` or manual reinstall | Maintenance path |
| CMSG-013 | Hook MUST check if `.git/hooks/commit-msg` already exists before overwriting | Prevents clobbering custom hooks |
| CMSG-014 | Hook MAY support chaining with existing commit-msg hooks | Composability with other tools |

### 2.3 Hook Lifecycle

```
┌──────────────────────────────────────────────────────────────┐
│                     COMMIT MESSAGE FLOW                       │
└──────────────────────────────────────────────────────────────┘

1. Developer writes commit message
   ↓
2. Git invokes .git/hooks/commit-msg with message file path
   ↓
3. Hook reads commit message from file
   ↓
4. Pattern extraction: grep -oE '\(T[0-9]+\)'
   ↓
5. Task ID validation: cleo exists T####
   ├─ PASS → Check session scope (Phase 2)
   │          ├─ PASS → exit 0 (allow commit)
   │          └─ FAIL → Warn + confirm (exit 1 or 0)
   └─ FAIL → Check focus context
              ├─ Available → Suggest task ID (exit 1)
              └─ Unavailable → Generic error (exit 1)
   ↓
6. If exit 1: commit aborted, developer can:
   - Amend message with task ID
   - Use --no-verify to bypass (logged)
   - Fix task ID and retry
```

---

## Part 3: Pattern Validation (PATTERN-*)

### 3.1 Task ID Format

| ID | Requirement | Example |
|----|-------------|---------|
| PATTERN-001 | Hook MUST recognize `(T####)` format (uppercase T, one or more digits, in parentheses) | `(T2688)`, `(T1)`, `(T12345)` |
| PATTERN-002 | Hook SHOULD accept task ID anywhere in commit message (prefix, suffix, middle) | `fix(release): Add timestamp (T2677)` |
| PATTERN-003 | Hook MAY recognize multiple task IDs in single commit | `feat: Merge T001 and T002 fixes` |
| PATTERN-004 | Hook MUST NOT accept lowercase task IDs `(t####)` | Enforce convention consistency |
| PATTERN-005 | Hook MUST NOT accept task IDs without parentheses `T####` | Distinguish from noise (e.g., "T1000 terminator reference") |

### 3.2 Pattern Extraction

**Regex**: `\(T[0-9]+\)`

**Extraction Command**:
```bash
TASK_IDS=$(grep -oE '\(T[0-9]+\)' "$MSG_FILE" | grep -oE 'T[0-9]+')
```

**Multiple Task IDs**:
```bash
# Extract all task IDs
readarray -t TASK_IDS < <(grep -oE '\(T[0-9]+\)' "$MSG_FILE" | grep -oE 'T[0-9]+')

# Validate all exist
for task_id in "${TASK_IDS[@]}"; do
    if ! cleo exists "$task_id" >/dev/null 2>&1; then
        echo "ERROR: Task $task_id not found"
        exit 1
    fi
done
```

### 3.3 Special Cases

| Case | Pattern | Handling |
|------|---------|----------|
| Version references | `v0.73.6`, `T1000` without parens | Ignore (no parentheses) |
| Release commits | `chore: Release v0.73.6` | Allow (no task ID required for automated releases) |
| Merge commits | `Merge branch 'feature' into main` | Allow if automated (detect `Merge` prefix) |
| Revert commits | `Revert "commit message"` | Allow (bypass for emergency rollbacks) |
| Multiple tasks | `(T001, T002)` | Split on `,` or space, validate all |

---

## Part 4: Session Scope Integration (SCOPE-*)

### 4.1 Session Context

| ID | Requirement | Implementation |
|----|-------------|----------------|
| SCOPE-001 | Hook SHOULD validate task ID belongs to current session scope (Phase 2) | Prevents out-of-scope commits |
| SCOPE-002 | Hook MUST read `CLEO_SESSION` environment variable for session context | Session binding |
| SCOPE-003 | Hook MUST use `cleo session status --format json` to get scope task IDs | Programmatic access |
| SCOPE-004 | Hook SHOULD use `cleo focus show --format json` to get current focused task | Auto-suggestion source |
| SCOPE-005 | Hook MAY allow out-of-scope task IDs with interactive confirmation | Flexibility for cross-session work |
| SCOPE-006 | Hook MUST NOT fail if no session is active (allow work outside CLEO) | Non-blocking for non-session workflows |

### 4.2 Session Scope Validation

**Phase 1: Basic Validation** (Immediate - Wave 3)
```bash
#!/usr/bin/env bash
# .git/hooks/commit-msg (Phase 1)

MSG_FILE="$1"
COMMIT_MSG=$(cat "$MSG_FILE")

# Extract task ID
TASK_ID=$(echo "$COMMIT_MSG" | grep -oE '\(T[0-9]+\)' | head -1 | grep -oE 'T[0-9]+')

if [[ -z "$TASK_ID" ]]; then
    # No task ID found - suggest from focus if available
    FOCUSED_TASK=$(cleo focus show --format json 2>/dev/null | jq -r '.task.id // empty')

    if [[ -n "$FOCUSED_TASK" ]]; then
        echo "ERROR: No task ID in commit message"
        echo "Current focus: $FOCUSED_TASK"
        echo ""
        echo "Suggested format: $COMMIT_MSG ($FOCUSED_TASK)"
        echo ""
        echo "Add task ID or bypass with: git commit --no-verify"
        exit 1
    else
        echo "WARNING: No task ID in commit message and no active focus"
        echo "Convention: Include (T####) in commit message"
        echo "Bypass with: git commit --no-verify"
        exit 1
    fi
fi

# Validate task exists
if ! cleo exists "$TASK_ID" >/dev/null 2>&1; then
    echo "ERROR: Task $TASK_ID not found in CLEO database"
    echo "Use: cleo find <query> to discover valid task IDs"
    exit 1
fi

echo "✓ Commit linked to $TASK_ID"
exit 0
```

**Phase 2: Session Scope Validation** (Follow-up Epic)
```bash
# Additional validation after basic checks pass

if [[ -n "$CLEO_SESSION" ]]; then
    # Get session scope task IDs
    SESSION_TASKS=$(cleo session status --format json 2>/dev/null | jq -r '.session.scope.computedTaskIds[]? // empty')

    if [[ -n "$SESSION_TASKS" ]]; then
        # Check if task ID in session scope
        if ! echo "$SESSION_TASKS" | grep -q "^${TASK_ID}$"; then
            echo "WARNING: $TASK_ID not in current session scope"
            echo "Session: $CLEO_SESSION"
            echo ""
            echo "Continue anyway? (y/n)"
            read -r response
            if [[ "$response" != "y" ]]; then
                exit 1
            fi
        fi
    fi
fi
```

### 4.3 Auto-suggestion Logic

**Priority**:
1. Current focused task (`cleo focus show`)
2. Session scope tasks (if only one task in scope)
3. Branch name task ID (if matches pattern `feature/T####-*`)
4. No suggestion (generic error)

**Example Output**:
```
ERROR: No task ID in commit message

Suggestion sources:
  Focus:   T2688 (Specification: Write PROTOCOL-ENFORCEMENT-SPEC.md)
  Session: session_20260128_084500_abc123 (3 tasks in scope)
  Branch:  feature/T2688-protocol-enforcement

Suggested format:
  feat(spec): Add enforcement architecture (T2688)

Add task ID or bypass with: git commit --no-verify
```

---

## Part 5: Bypass Policy (BYPASS-*)

### 5.1 Bypass Conditions

| ID | Requirement | Use Case |
|----|-------------|----------|
| BYPASS-001 | Hook MUST allow bypass via `git commit --no-verify` flag | Emergency escape hatch |
| BYPASS-002 | Hook MUST log all bypasses to `.cleo/bypass-log.json` | Audit trail |
| BYPASS-003 | Bypass log MUST capture timestamp, commit hash, user, message, justification | Traceable for review |
| BYPASS-004 | Hook SHOULD detect automated commits (merge, revert) and auto-bypass | Reduced friction for CI/CD |
| BYPASS-005 | Hook MAY prompt for justification on bypass (interactive mode) | Accountability |
| BYPASS-006 | Bypass logging MUST NOT fail silently (but bypass succeeds even if logging fails) | Robustness |

### 5.2 Bypass Log Format

```json
{
  "timestamp": "2026-01-28T08:45:00Z",
  "commit": "abc123def456",
  "user": "keaton",
  "session": "session_20260128_084500_abc123",
  "message": "emergency fix for production crash",
  "justification": "emergency",
  "hook": "commit-msg",
  "violations": [
    {"requirement": "CMSG-001", "severity": "error", "message": "No task ID in commit message"}
  ]
}
```

### 5.3 Bypass Detection

**Automated Commit Patterns** (auto-bypass):
```bash
# Merge commits
if echo "$COMMIT_MSG" | grep -qE '^Merge (branch|pull request)'; then
    log_bypass "automated" "Merge commit detected"
    exit 0
fi

# Revert commits
if echo "$COMMIT_MSG" | grep -qE '^Revert '; then
    log_bypass "automated" "Revert commit detected"
    exit 0
fi

# CI/CD commits (detect CI env vars)
if [[ -n "$CI" || -n "$GITHUB_ACTIONS" || -n "$GITLAB_CI" ]]; then
    log_bypass "automated" "CI/CD environment detected"
    exit 0
fi
```

**Manual Bypass** (`--no-verify`):
```bash
# Git automatically skips hook when --no-verify used
# But we can detect in subsequent commit-msg runs if needed

# Log function (called before exit 1 when validation fails)
log_bypass() {
    local justification="$1"
    local note="$2"

    local bypass_entry
    bypass_entry=$(jq -n \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg commit "$(git rev-parse HEAD 2>/dev/null || echo 'pending')" \
        --arg user "$(git config user.name)" \
        --arg session "$CLEO_SESSION" \
        --arg message "$COMMIT_MSG" \
        --arg justification "$justification" \
        --arg note "$note" \
        --arg hook "commit-msg" \
        '{timestamp: $ts, commit: $commit, user: $user, session: $session, message: $message, justification: $justification, note: $note, hook: $hook}')

    echo "$bypass_entry" >> .cleo/bypass-log.json 2>/dev/null || true
}
```

---

## Part 6: Edge Cases (EDGE-*)

### 6.1 No Active Session

| ID | Scenario | Handling |
|----|----------|----------|
| EDGE-001 | No CLEO_SESSION env var set | Validate task ID exists only, no scope check |
| EDGE-002 | No focused task available | Provide generic error without suggestion |
| EDGE-003 | Session ended but still in branch | Warn but allow commit (session stale) |

**Implementation**:
```bash
if [[ -z "$CLEO_SESSION" ]]; then
    # No session active - basic validation only
    # Still require task ID, but no scope validation
    if [[ -z "$TASK_ID" ]]; then
        echo "WARNING: No task ID in commit message"
        echo "No active CLEO session detected"
        echo "Include (T####) or bypass with: git commit --no-verify"
        exit 1
    fi
fi
```

### 6.2 Multiple Task IDs

| ID | Scenario | Handling |
|----|----------|----------|
| EDGE-004 | Commit references multiple tasks `(T001, T002)` | Extract all, validate all exist |
| EDGE-005 | One task valid, one invalid | Fail with specific invalid task ID |
| EDGE-006 | Multiple tasks but only one in session scope | Warn but allow (cross-task work) |

**Implementation**:
```bash
# Extract all task IDs
readarray -t TASK_IDS < <(echo "$COMMIT_MSG" | grep -oE '\(T[0-9]+\)' | grep -oE 'T[0-9]+')

if [[ ${#TASK_IDS[@]} -eq 0 ]]; then
    # No task IDs found
    handle_missing_task_id
elif [[ ${#TASK_IDS[@]} -eq 1 ]]; then
    # Single task ID - standard validation
    validate_task_id "${TASK_IDS[0]}"
else
    # Multiple task IDs - validate all
    for task_id in "${TASK_IDS[@]}"; do
        if ! cleo exists "$task_id" >/dev/null 2>&1; then
            echo "ERROR: Task $task_id not found (from multiple references)"
            exit 1
        fi
    done
    echo "✓ Commit linked to multiple tasks: ${TASK_IDS[*]}"
fi
```

### 6.3 Branch-based Task ID Extraction

| ID | Scenario | Handling |
|----|----------|----------|
| EDGE-007 | Branch name `feature/T2688-description` | Extract T2688 as fallback if message missing task ID |
| EDGE-008 | Branch name without task ID `feature/new-feature` | No extraction, require explicit message reference |
| EDGE-009 | Branch task ID differs from message task ID | Prefer message task ID (explicit over implicit) |

**Implementation**:
```bash
# Try to extract from branch name as fallback
BRANCH_NAME=$(git symbolic-ref --short HEAD 2>/dev/null)
BRANCH_TASK=$(echo "$BRANCH_NAME" | grep -oE 'T[0-9]+' | head -1)

if [[ -z "$TASK_ID" && -n "$BRANCH_TASK" ]]; then
    echo "WARNING: No task ID in commit message, but found in branch name: $BRANCH_TASK"
    echo "Consider adding to message for clarity: ($BRANCH_TASK)"
    echo ""
    echo "Accept branch task ID? (y/n)"
    read -r response
    if [[ "$response" == "y" ]]; then
        TASK_ID="$BRANCH_TASK"
    else
        exit 1
    fi
fi
```

### 6.4 Rebase and Interactive History

| ID | Scenario | Handling |
|----|----------|----------|
| EDGE-010 | `git rebase -i` modifies history | Hook runs per commit during rebase |
| EDGE-011 | Rebase fixup/squash commits | Hook may run on temporary commits |
| EDGE-012 | Amend commit after hook failure | Hook runs again on amended message |

**Implementation**:
```bash
# Detect rebase in progress
if [[ -d ".git/rebase-merge" || -d ".git/rebase-apply" ]]; then
    # During rebase - be lenient (developer will fix in final squash)
    if [[ -z "$TASK_ID" ]]; then
        echo "WARNING: No task ID during rebase (will validate on final commit)"
        # Don't fail - allow rebase to proceed
        exit 0
    fi
fi
```

### 6.5 Automated Commits (CI/CD)

| ID | Scenario | Handling |
|----|----------|----------|
| EDGE-013 | GitHub Actions commits | Auto-bypass (detect CI env vars) |
| EDGE-014 | Dependabot commits | Auto-bypass (detect bot user) |
| EDGE-015 | Merge commits from PR | Auto-bypass (detect "Merge" prefix) |

**Implementation**:
```bash
# Detect automated environments
if [[ -n "$CI" || -n "$GITHUB_ACTIONS" || -n "$GITLAB_CI" ]]; then
    log_bypass "automated" "CI/CD environment detected: ${CI:-GITHUB_ACTIONS}"
    exit 0
fi

# Detect bot users
GIT_USER=$(git config user.name)
if [[ "$GIT_USER" =~ (bot|dependabot|renovate|semantic-release) ]]; then
    log_bypass "automated" "Bot user detected: $GIT_USER"
    exit 0
fi
```

---

## Part 7: Installation and Configuration

### 7.1 Installation Steps

**Via `cleo init`**:
```bash
#!/usr/bin/env bash
# lib/setup-hooks.sh

install_commit_msg_hook() {
    local hook_path=".git/hooks/commit-msg"
    local template_path=".cleo/templates/git-hooks/commit-msg"

    # Check if hook already exists
    if [[ -f "$hook_path" ]]; then
        echo "WARNING: commit-msg hook already exists at $hook_path"
        echo "Backup existing hook? (y/n)"
        read -r response
        if [[ "$response" == "y" ]]; then
            mv "$hook_path" "${hook_path}.backup.$(date +%s)"
        else
            echo "Skipping hook installation"
            return 1
        fi
    fi

    # Copy template
    cp "$template_path" "$hook_path"
    chmod +x "$hook_path"

    # Track in config
    cleo config set hooks.commitMsg.enabled true
    cleo config set hooks.commitMsg.version "1.0.0"
    cleo config set hooks.commitMsg.installedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    echo "✓ Installed commit-msg hook"
    return 0
}
```

**Manual Installation**:
```bash
# Copy hook template
cp .cleo/templates/git-hooks/commit-msg .git/hooks/commit-msg
chmod +x .git/hooks/commit-msg

# Verify installation
.git/hooks/commit-msg --version
```

### 7.2 Configuration Options

**Config Schema** (`.cleo/config.json`):
```json
{
  "hooks": {
    "commitMsg": {
      "enabled": true,
      "version": "1.0.0",
      "installedAt": "2026-01-28T08:45:00Z",
      "sessionScopeValidation": false,
      "autoSuggestion": true,
      "branchExtraction": true,
      "autoBypassMerges": true,
      "autoBypassReverts": true,
      "autoBypassCI": true,
      "bypassLogging": true,
      "interactivePrompts": true
    }
  }
}
```

**Config Commands**:
```bash
# Enable/disable hook
cleo config set hooks.commitMsg.enabled false

# Enable session scope validation (Phase 2)
cleo config set hooks.commitMsg.sessionScopeValidation true

# Disable auto-suggestion
cleo config set hooks.commitMsg.autoSuggestion false
```

---

## Part 8: Testing Requirements

### 8.1 Test Coverage

| Test Category | Coverage Target | Implementation |
|---------------|----------------|----------------|
| Pattern extraction | 100% (all formats) | BATS unit tests |
| Task validation | 100% (exists/not exists) | BATS integration tests |
| Session scope | 100% (in-scope/out-of-scope/no-session) | BATS integration tests |
| Auto-suggestion | 100% (focus/branch/none) | BATS integration tests |
| Bypass detection | 100% (merge/revert/CI) | BATS integration tests |
| Edge cases | 100% (multiple IDs, rebase, etc.) | BATS integration tests |

### 8.2 Test Structure

```bash
tests/
├── unit/
│   ├── commit-msg-pattern-extraction.bats
│   ├── commit-msg-task-validation.bats
│   └── commit-msg-bypass-detection.bats
├── integration/
│   ├── commit-msg-hook-flow.bats
│   ├── commit-msg-session-scope.bats
│   └── commit-msg-auto-suggestion.bats
└── fixtures/
    ├── valid-commit-messages.txt
    ├── invalid-commit-messages.txt
    └── mock-session-data.json
```

### 8.3 Example Test Cases

**Pattern Extraction Tests**:
```bash
@test "commit-msg: extract single task ID from suffix" {
    msg="feat(spec): Add enforcement (T2688)"
    result=$(extract_task_id "$msg")
    [[ "$result" == "T2688" ]]
}

@test "commit-msg: extract task ID from prefix" {
    msg="(T2688) feat(spec): Add enforcement"
    result=$(extract_task_id "$msg")
    [[ "$result" == "T2688" ]]
}

@test "commit-msg: extract multiple task IDs" {
    msg="feat: Merge T001 and T002 (T001) (T002)"
    result=$(extract_task_ids "$msg")
    [[ "$result" == "T001 T002" ]]
}

@test "commit-msg: ignore version references without parens" {
    msg="chore: Release v0.73.6"
    result=$(extract_task_id "$msg")
    [[ -z "$result" ]]
}
```

**Session Scope Tests**:
```bash
@test "commit-msg: allow in-scope task ID" {
    export CLEO_SESSION="session_123"
    mock_session_scope "T001 T002 T003"
    msg="feat: Update (T002)"
    run_commit_msg_hook "$msg"
    [[ $status -eq 0 ]]
}

@test "commit-msg: warn on out-of-scope task ID" {
    export CLEO_SESSION="session_123"
    mock_session_scope "T001 T002 T003"
    msg="feat: Update (T999)"
    run_commit_msg_hook "$msg" <<< "n"  # User declines
    [[ $status -eq 1 ]]
}
```

---

## Part 9: Phased Rollout Plan

### 9.1 Phase 1: Basic Validation (Immediate - Wave 3)

**Scope**:
- Pattern extraction (`(T####)`)
- Task existence validation (`cleo exists`)
- Auto-suggestion from focus
- Basic bypass logging

**Success Criteria**:
- 100% commits have task ID or bypass logged
- Zero false positives (valid commits blocked)
- Developer feedback positive

**Timeline**: Wave 3 (T2692-T2697 implementation)

### 9.2 Phase 2: Session Scope Validation (Follow-up Epic)

**Scope**:
- Session scope task ID validation
- Interactive confirmation for out-of-scope tasks
- Branch name extraction
- Enhanced bypass logging

**Success Criteria**:
- 90% commits reference in-scope tasks
- Out-of-scope commits intentional (confirmed)
- Session scope workflow adopted

**Timeline**: Wave 4 (follow-up epic)

### 9.3 Phase 3: Advanced Features (Long-term)

**Scope**:
- Interactive justification prompts
- Bypass audit dashboard integration
- Pre-commit hook chaining
- GitHub PR template integration

**Success Criteria**:
- 95% commits compliant
- Bypass audit actionable
- Zero developer complaints

**Timeline**: Future enhancements

---

## Part 10: Open Questions

1. Should session scope validation be **blocking** (fail commit) or **warning** (allow with confirmation)?
   - **Context**: Out-of-scope commits may be valid (cross-session work)
   - **Impact**: Developer friction vs correctness
   - **Recommendation**: Warning with confirmation (Phase 2)

2. Should hook auto-amend commit messages with suggested task ID?
   - **Context**: Convenience vs explicit developer action
   - **Impact**: Automation vs control
   - **Recommendation**: No auto-amend - suggest format only

3. Should hook integrate with GitHub PR templates?
   - **Context**: Task ID in commit message AND PR description
   - **Impact**: Redundancy vs visibility
   - **Recommendation**: Future enhancement - suggest PR template update

4. Should hook validate task status (only allow commits for `active` tasks)?
   - **Context**: Prevent commits for `done` or `blocked` tasks
   - **Impact**: Strictness vs flexibility
   - **Recommendation**: No - allow commits for any task (fixes may apply to done tasks)

5. Should bypass justification be **required** (interactive prompt) or **optional** (logged without prompt)?
   - **Context**: Accountability vs friction
   - **Impact**: Developer UX vs audit quality
   - **Recommendation**: Optional initially, required in future if abuse detected

---

## Part 11: References

### 11.1 Consensus Decision

- **T2686**: Commit-msg hook with session scope validation (confidence 0.88)
  - Option C selected over prefix format (Option A) and basic pattern check (Option B)
  - Session scope integration enables intelligent validation
  - Preserves existing `(T####)` convention (100% voluntary adoption)

### 11.2 Protocol Requirements

- **IMPL-003**: Implementation protocol provenance tagging (0% enforced)
- **CONT-002**: Contribution protocol provenance tagging (0% enforced)
- **T2684**: Wave 0 audit findings (provenance defined but not validated)

### 11.3 Related Specifications

- [PROTOCOL-ENFORCEMENT-SPEC.md](PROTOCOL-ENFORCEMENT-SPEC.md) - Overall enforcement architecture
- [PROJECT-LIFECYCLE-SPEC.md](PROJECT-LIFECYCLE-SPEC.md) - RCSD pipeline and session lifecycle
- [MULTI-SESSION-SPEC.md](MULTI-SESSION-SPEC.md) - Session scope and focus context

### 11.4 Git Evidence

**Recent commit analysis** (20 commits):
- 100% include task IDs in `(T####)` format or version references
- Pattern: Suffix placement most common, flexible positioning accepted
- No commits use `Task: T####` prefix format (rejected convention)
- Existing voluntary adoption proves convention works

---

## Part 12: Conclusion

This specification defines a **commit-msg hook** that enforces task ID inclusion while preserving existing developer conventions. By validating `(T####)` patterns, integrating with session scope, and providing intelligent auto-suggestion, the hook addresses 0% provenance enforcement without disrupting workflows.

**Key Insights**:
1. **Preserve convention** - 100% voluntary `(T####)` adoption proves pattern works
2. **Session integration** - Multi-session architecture enables scope validation
3. **Phased rollout** - Basic validation first, advanced features incrementally
4. **Bypass policy** - `--no-verify` escape hatch with audit logging

**Next Actions**:
- Wave 3 implementation: Install hook via `cleo init` (Phase 1)
- Wave 4 enhancement: Add session scope validation (Phase 2)
- Long-term: Bypass audit dashboard integration

**Expected Outcome**: 100% commits have task IDs or bypass logged, enabling full provenance traceability per IMPL-003 and CONT-002 requirements.
