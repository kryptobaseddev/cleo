---
name: ct-dev-workflow
description: Development workflow orchestration for task-driven development with atomic commits, conventional commit messages, and systematic release processes. Enforces task traceability, branch discipline, smart test scope selection, and GitHub Actions integration. Use when committing code, creating releases, managing branches, or following contribution protocols. Triggers on commit operations, release preparation, or workflow compliance needs.
version: 3.0.0
tier: 2
core: false
category: specialist
protocol: contribution
dependencies: []
sharedResources:
  - subagent-protocol-base
  - task-system-integration
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
license: MIT
---

# Development Workflow Context Injection

**Protocol**: @protocols/contribution.md
**Type**: Context Injection (cleo-subagent)
**Version**: 3.0.0

---

## Purpose

Context injection for development workflow tasks spawned via cleo-subagent. Provides domain expertise for atomic commits with task traceability, conventional commit messages, and systematic release processes.

---

## Core Principle: Task-Driven Development

> **CRITICAL**: NO code changes or commits without a tracked task.

Every commit MUST be traceable to a CLEO task. This ensures:
- Work is planned and tracked
- Changes are reviewable and reversible
- Progress is measurable
- Context is preserved for future agents

---

## Immutable Constraints (WORKFLOW)

| ID | Rule | Enforcement |
|----|------|-------------|
| WF-001 | Task required | NO commits without CLEO task reference |
| WF-002 | Branch discipline | NO commits to main/master |
| WF-003 | Atomic commits | ONE logical change per commit |
| WF-004 | Conventional format | `<type>(<scope>): <description>` |
| WF-005 | Tests before push | Relevant tests MUST pass |

---

## Task Tracking Integration

### Before Any Work

```bash
# 1. Verify you have a task
cleo current

# 2. If no task, find or create one
cleo find "relevant query"
cleo add "Task title" --description "What you're doing" --parent T001
cleo start T123
```

### Commit Message Format

**MUST** include task reference:

```
<type>(<scope>): <description>

<body explaining why>

Task: T123
Co-Authored-By: Claude <noreply@anthropic.com>
```

**Example:**
```
fix(auth): prevent token expiry race condition

The refresh token was being invalidated before the new access
token was validated, causing intermittent auth failures.

Task: T1456
Co-Authored-By: Claude <noreply@anthropic.com>
```

---

## Branch & Subagent Awareness

### Single Branch Reality

Subagents share the parent session's branch. This means:

- All work happens on the same branch
- No parallel feature branches from subagents
- Commits are sequential, not parallel
- Worktrees needed for true branch isolation

### Branch Strategy

```bash
# Check current branch
git branch --show-current

# Feature work (typical pattern)
main → feature/T123-description → PR → main

# Branch naming
feature/T123-auth-improvements     # Task-prefixed
fix/T456-token-validation          # Bug fix
```

---

## Gate System (Simplified)

Not all gates apply to all changes. Follow the decision matrix.

### G0: Pre-Flight Check

**Always required.**

```bash
# 1. Verify task context
cleo current
# MUST have a current task

# 2. Check branch
git branch --show-current
# MUST NOT be main/master

# 3. Check for uncommitted work
git status --porcelain
# Review staged/unstaged changes
```

### G1: Classify Change

| Type | Description | Tests Needed | Version Bump |
|------|-------------|--------------|--------------|
| `feat` | New feature | Related tests | MINOR |
| `fix` | Bug fix | Regression test | PATCH |
| `docs` | Documentation | None | None |
| `refactor` | Code restructure | Affected tests | PATCH |
| `test` | Test additions | The new tests | None |
| `chore` | Maintenance | None | None |
| `perf` | Performance | Perf tests | PATCH |
| `security` | Security fix | Security tests | PATCH |

### G2: Testing (Smart Scope)

**NOT always full test suite.** CI runs full tests on push.

| Change Type | Test Scope | Command |
|-------------|------------|---------|
| `feat` | Related module tests | `bats tests/unit/feature.bats` |
| `fix` | Regression + affected | `bats tests/unit/affected.bats` |
| `docs` | None (CI validates) | Skip |
| `refactor` | Affected modules | `bats tests/unit/module*.bats` |
| `test` | The new tests only | `bats tests/unit/new.bats` |
| `chore` | Syntax check only | `bash -n scripts/*.sh` |

**When to run full suite locally:**
- Before release (version bump)
- Major refactoring
- Cross-cutting changes
- User explicitly requests

```bash
# Full suite (when needed)
./tests/run-all-tests.sh

# Targeted tests (typical)
bats tests/unit/specific-feature.bats
bats tests/integration/workflow.bats

# Quick syntax check
bash -n scripts/*.sh lib/*.sh
```

### G3: Commit

```bash
# 1. Get task info
task_id=$(cleo current --quiet)

# 2. Stage changes (be specific for atomic commits)
git add scripts/specific-file.sh lib/related.sh

# 3. Create commit with task reference
git commit -m "$(cat <<'EOF'
fix(auth): prevent token expiry race condition

The refresh token was being invalidated before validation.

Task: T1456
Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### G4: Push (Triggers CI)

```bash
# Push branch (CI runs full tests)
git push origin HEAD

# CI will run:
# - Full test suite
# - ShellCheck linting
# - JSON validation
# - Documentation drift check
# - Installation test
```

### G5: Version Bump (Release Only)

**Only for releases**, not every commit.

```bash
# 1. Preview
./dev/bump-version.sh --dry-run patch

# 2. Execute
./dev/bump-version.sh patch

# 3. Validate
./dev/validate-version.sh

# 4. Reinstall locally
./install.sh --force
cleo version
```

### G6: Tag & Release

**GitHub Actions handles release creation.**

```bash
# 1. Create annotated tag
git tag -a v${VERSION} -m "${TYPE}: ${SUMMARY}"

# 2. Push tag (triggers release workflow)
git push origin v${VERSION}

# 3. Push branch
git push origin HEAD

# GitHub Actions automatically:
# - Builds release tarball
# - Creates GitHub Release
# - Generates release notes
# - Uploads artifacts
```

---

## Quick Decision Matrix

### What Tests to Run?

| Change | Local Tests | Rely on CI |
|--------|-------------|------------|
| Single file fix | Related unit test | Yes |
| New feature | Feature tests | Yes |
| Docs only | None | Yes |
| Schema change | Schema tests | Yes |
| Cross-cutting refactor | Full suite | Yes |
| Release prep | Full suite | Yes |

### Do I Need a Version Bump?

| Change | Bump | Tag |
|--------|------|-----|
| `feat` | minor | Yes |
| `fix` | patch | Yes |
| `docs` | No | No |
| `refactor` | patch | Yes |
| `test` | No | No |
| `chore` | No | No |
| `perf` | patch | Yes |
| `security` | patch | Yes |

---

## Task System Integration

@skills/_shared/task-system-integration.md

### CLEO Integration Commands

```bash
# Task lifecycle
cleo current                 # Current task
cleo start T123              # Start task
cleo complete T123           # Mark done

# Find existing work
cleo find "query"            # Search tasks
cleo list --status pending   # Pending work

# Create new work
cleo add "Title" --parent T001 --description "..."

# Session management
cleo session status          # Current session
cleo session end --note "Completed X, Y, Z"
```

---

## Subagent Protocol

@skills/_shared/subagent-protocol-base.md

### Output Requirements

1. MUST write workflow summary to: `{{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md`
2. MUST append ONE line to: `{{MANIFEST_PATH}}`
3. MUST return ONLY: "Workflow complete. See MANIFEST.jsonl for summary."
4. MUST NOT return full commit/release details in response

---

## Complete Workflow Examples

### Example 1: Bug Fix (Typical)

```bash
# 1. Verify task
cleo current
# Output: T1456 - Fix token validation

# 2. Make changes
# ... edit files ...

# 3. Run relevant test
bats tests/unit/auth.bats

# 4. Stage specific files
git add lib/auth.sh scripts/login.sh

# 5. Commit with task
git commit -m "$(cat <<'EOF'
fix(auth): prevent token expiry race condition

Task: T1456
Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"

# 6. Push (CI handles full tests)
git push origin HEAD

# 7. Mark task complete
cleo complete T1456
```

### Example 2: Documentation Only

```bash
# 1. Verify task
cleo current  # T1550 - Update README

# 2. Make doc changes
# ... edit docs ...

# 3. No tests needed (CI validates)

# 4. Commit
git add docs/ README.md
git commit -m "$(cat <<'EOF'
docs: update installation instructions

Task: T1550
Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"

# 5. Push
git push origin HEAD

# 6. Complete
cleo complete T1550
```

---

## Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| No task reference | Untracked work | Create/find task first |
| Committing to main | Bypass review | Use feature branches |
| Running full tests always | Slow iteration | Use smart test scope |
| Skipping CI | Missing validations | Always push, let CI run |
| Manual release creation | Inconsistent releases | Use tag, GH Actions |
| Giant commits | Hard to review/revert | Atomic commits |
| Vague commit messages | Lost context | Conventional + task ref |

---

## Critical Rules Summary

1. **Always have a task** before making changes
2. **Always include task reference** in commit message
3. **Never commit to main/master** directly
4. **Run relevant tests** locally, not always full suite
5. **Let CI validate** with full test suite on push
6. **Use tags for releases** - GitHub Actions handles the rest
7. **One logical change** per commit (atomic)
8. **Conventional commit format** with task reference
