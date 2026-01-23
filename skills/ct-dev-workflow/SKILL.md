---
name: ct-dev-workflow
description: |
  Development workflow skill for atomic commits, conventional commits, and release management.
  Use when user says "commit", "release", "run the workflow", "prepare release",
  "atomic commit", "conventional commit", "version bump", "create release",
  "commit and push", "finalize changes", "ship it", "cut a release".
version: 2.0.0
---

# Development Workflow Skill

You are a development workflow executor. Your role is to ensure proper atomic commits with task traceability, conventional commit messages, and systematic release processes.

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
cleo focus show

# 2. If no task, find or create one
cleo find "relevant query"
cleo add "Task title" --description "What you're doing" --parent T001
cleo focus set T123
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
cleo focus show
# MUST have a focused task

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
task_id=$(cleo focus show --quiet)

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
| Single file fix | Related unit test | ✓ |
| New feature | Feature tests | ✓ |
| Docs only | None | ✓ |
| Schema change | Schema tests | ✓ |
| Cross-cutting refactor | Full suite | ✓ |
| Release prep | Full suite | ✓ |

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

### Push Flow

```
Local commit → Push → CI tests → PR → Review → Merge to main
                                                    ↓
                                        CHANGELOG.md updated
                                                    ↓
                                    (Auto-PR for Mintlify docs)
                                                    ↓
                                        Version bump commit
                                                    ↓
                                        Tag push (v*.*.*)
                                                    ↓
                                    GitHub Release (automated)
```

---

## Automated CI/CD Pipelines

### What GitHub Actions Handles

| Trigger | Workflow | Actions |
|---------|----------|---------|
| Push/PR to main | `ci.yml` | Tests, lint, JSON validation, docs drift, install test |
| Push to main (CHANGELOG.md) | `docs-update.yml` | Auto-PR for Mintlify changelog regeneration |
| Tag push (v*.*.*) | `release.yml` | Build tarball, create GitHub Release, upload artifacts |
| Push to docs/ | `mintlify-deploy.yml` | Validate MDX, check required files |

### What YOU Handle

| Action | When | How |
|--------|------|-----|
| Update CHANGELOG.md | Before release | Manual edit with release notes |
| Version bump | When releasing | `./dev/bump-version.sh patch\|minor\|major` |
| Create tag | After version bump | `git tag -a v0.X.Y -m "..."` |
| Push tag | After tagging | `git push origin v0.X.Y` |
| Merge auto-PRs | When changelog PR created | Review and merge the auto-generated PR |

### Release Sequence

```bash
# 1. Ensure all changes are merged to main

# 2. Update CHANGELOG.md with release notes
# (edit CHANGELOG.md manually)

# 3. Commit changelog
git add CHANGELOG.md
git commit -m "docs(changelog): Add v0.X.Y release notes"
git push origin main

# 4. (Auto) docs-update.yml creates PR for Mintlify
# → Review and merge the auto-PR

# 5. Version bump
./dev/bump-version.sh minor  # or patch/major
./dev/validate-version.sh

# 6. Commit version bump
git add -A
git commit -m "chore: bump version to v0.X.Y"
git push origin main

# 7. Tag and push (triggers release.yml)
git tag -a v0.X.Y -m "feat: Description of release"
git push origin v0.X.Y

# 8. (Auto) release.yml creates GitHub Release
```

---

## Complete Workflow Examples

### Example 1: Bug Fix (Typical)

```bash
# 1. Verify task
cleo focus show
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

### Example 2: New Feature

```bash
# 1. Verify task
cleo focus show  # T1500 - Add export command

# 2. Make changes
# ... implement feature ...

# 3. Run feature tests
bats tests/unit/export.bats
bats tests/integration/export.bats

# 4. Stage changes
git add scripts/export.sh lib/export-utils.sh tests/unit/export.bats

# 5. Commit
git commit -m "$(cat <<'EOF'
feat(export): add CSV export command

Enables exporting tasks to CSV format for external tools.

Task: T1500
Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"

# 6. Push
git push origin HEAD

# 7. Complete task
cleo complete T1500
```

### Example 3: Release

```bash
# 1. Verify all tasks complete
cleo list --status pending --parent T1400  # Should be empty

# 2. Run full test suite (release prep)
./tests/run-all-tests.sh

# 3. Update CHANGELOG
# ... edit CHANGELOG.md ...

# 4. Version bump
./dev/bump-version.sh minor
./dev/validate-version.sh

# 5. Commit version bump
git add -A
git commit -m "$(cat <<'EOF'
chore: bump version to v0.63.0

Task: T1400
Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"

# 6. Tag and push
git tag -a v0.63.0 -m "feat: Add export command and improvements"
git push origin v0.63.0
git push origin HEAD

# GitHub Actions creates the release automatically
```

### Example 4: Documentation Only

```bash
# 1. Verify task
cleo focus show  # T1550 - Update README

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
| Manual release creation | Inconsistent releases | Use tag → GH Actions |
| Giant commits | Hard to review/revert | Atomic commits |
| Vague commit messages | Lost context | Conventional + task ref |

---

## CLEO Integration Commands

```bash
# Task lifecycle
cleo focus show              # Current task
cleo focus set T123          # Set focus
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

## Critical Rules Summary

1. **Always have a task** before making changes
2. **Always include task reference** in commit message
3. **Never commit to main/master** directly
4. **Run relevant tests** locally, not always full suite
5. **Let CI validate** with full test suite on push
6. **Use tags for releases** - GitHub Actions handles the rest
7. **One logical change** per commit (atomic)
8. **Conventional commit format** with task reference

---

## Trigger Phrases

This skill activates when user says:
- "commit", "commit changes"
- "release", "prepare release", "cut a release"
- "run the workflow"
- "atomic commit", "conventional commit"
- "version bump"
- "ship it", "finalize changes"
- "push changes"
