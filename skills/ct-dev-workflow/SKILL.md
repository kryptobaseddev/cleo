---
name: ct-dev-workflow
description: |
  Development workflow skill for atomic commits, conventional commits, and release management.
  Use when user says "commit", "release", "run the workflow", "prepare release",
  "atomic commit", "conventional commit", "version bump", "create release",
  "commit and push", "finalize changes", "ship it", "cut a release".
version: 1.0.0
---

# Development Workflow Skill

You are a development workflow executor. Your role is to ensure proper atomic commits, conventional commit messages, and systematic release processes following gate-based validation.

## Capabilities

1. **Pre-flight Validation** - Verify clean state before operations
2. **Change Classification** - Determine change type and version impact
3. **Quality Gates** - Execute lint, test, and compliance checks
4. **Atomic Commits** - Create focused, well-formed commits
5. **Version Management** - Semantic versioning based on change type
6. **Release Orchestration** - Tag and push with proper metadata

---

## Core Philosophy

### Atomic Commits

**MUST** follow atomic commit principles:

| Principle | Description |
|-----------|-------------|
| **Single concern** | One logical change per commit |
| **Self-contained** | Commit compiles/runs independently |
| **Descriptive** | Message explains why, not just what |
| **Reviewable** | Diff is small enough to review |

**Anti-patterns to avoid:**
- "WIP" commits with mixed changes
- Combining unrelated fixes
- Giant "update everything" commits
- Commits that break the build

### Conventional Commits

**MUST** use format: `<type>(<scope>): <description>`

```
feat(auth): add JWT refresh token support
fix(api): handle null response in user endpoint
docs: update API reference for v2 endpoints
refactor(db): extract connection pooling to module
test(auth): add integration tests for login flow
chore: update dependencies to latest versions
perf(query): optimize user lookup with index
security(auth): fix token validation bypass
```

---

## Gate System (G0-G7)

Execute gates in order. **MUST NOT** skip gates unless classification allows.

### G0: Pre-Flight Check

**Purpose**: Verify clean starting state

```bash
# 1. Check working directory
git status --porcelain
# MUST be empty OR only intended changes

# 2. Check branch
git branch --show-current
# MUST NOT be main/master

# 3. Run tests (baseline)
./tests/run-all-tests.sh  # or project test command
# MUST pass
```

**Failure action**: Fix issues before proceeding. Do NOT continue.

### G1: Classify Change

**Purpose**: Determine change type and version impact

| Type | Description | Version Bump | Tag? |
|------|-------------|--------------|------|
| `feat` | New feature/command | MINOR | Yes |
| `fix` | Bug fix | PATCH | Yes |
| `docs` | Documentation only | None | No |
| `refactor` | Code restructure | PATCH | Yes |
| `test` | Test additions | None | No |
| `chore` | Maintenance | None | No |
| `perf` | Performance | PATCH | Yes |
| `security` | Security fix | PATCH | Yes |
| `chore(dev)` | Dev tooling only | None | No |

**Record**: `CHANGE_TYPE`, `VERSION_BUMP`, `SCOPE`

### G2: Implementation Validation

**Purpose**: Code quality verification

```bash
# Lint check (project-specific)
shellcheck scripts/*.sh lib/*.sh  # bash projects
eslint src/                       # js/ts projects
ruff check .                      # python projects

# Compliance check (if available)
./dev/check-compliance.sh --threshold 95
```

**Failure action**: Fix lint errors, re-run.

### G3: Testing

**Purpose**: Verify all tests pass

```bash
./tests/run-all-tests.sh
```

**MUST pass**. If tests fail:
1. Fix failing tests
2. Re-run tests
3. Do NOT proceed until all pass

### G4: Documentation Update

**Required for**: `feat`, `fix` (if behavior changed), `security`

**Documentation Layers** (update in order):
1. **Layer 3** (Reference): Full command/API docs - CREATE/UPDATE
2. **Layer 4** (Index): Add link if NEW item
3. **Layer 2** (Summary): Add/update syntax
4. **Layer 1** (Injection): ONLY if essential (limit to 10 items)

**CHANGELOG Update**:
```markdown
## [Unreleased]

### Added/Fixed/Changed
- Description of change
```

### G5: Version Bump

**Skip if**: `VERSION_BUMP=none` (docs, test, chore)

```bash
# 1. Preview bump
./dev/bump-version.sh --dry-run ${BUMP_TYPE}

# 2. Execute bump
./dev/bump-version.sh ${BUMP_TYPE}

# 3. Validate sync
./dev/validate-version.sh

# 4. Reinstall and verify
./install.sh --force
cleo version  # or project version command
```

**Record**: `PREVIOUS_VERSION`, `NEW_VERSION`

### G6: Commit

**Purpose**: Create atomic commit with conventional format

```bash
# 1. Stage changes
git add -A  # or specific files for atomic commits

# 2. Review staged changes
git diff --staged --stat

# 3. Create commit
git commit -m "$(cat <<'EOF'
${CHANGE_TYPE}(${SCOPE}): ${DESCRIPTION}

${DETAILED_BODY}

Files changed:
- file1.sh
- file2.md

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### G7: Tag and Release

**Skip if**: `VERSION_BUMP=none`

```bash
# 1. Create annotated tag
git tag -a v${NEW_VERSION} -m "${CHANGE_TYPE}: ${SUMMARY}"

# 2. Push tag
git push origin v${NEW_VERSION}

# 3. Push branch
git push origin HEAD
```

---

## Classification Matrix

| Type | Gates | Bump | Tag | Docs |
|------|-------|------|-----|------|
| `feat` | G0-G7 | minor | Yes | Full |
| `fix` | G0-G7 | patch | Yes | If behavior changed |
| `docs` | G0,G1,G4,G6 | - | No | N/A |
| `refactor` | G0-G3,G6 | patch | Yes | No |
| `test` | G0-G3,G6 | - | No | No |
| `chore` | G0-G2,G6 | - | No | No |
| `perf` | G0-G3,G5-G7 | patch | Yes | If behavior changed |
| `security` | G0-G7 | patch | Yes | Full |
| `chore(dev)` | G0-G2,G6 | - | No | dev/ only |

---

## Workflow Execution

### Trigger Phrases

- "run the workflow"
- "commit and release"
- "prepare release"
- "atomic commit"
- "finalize changes"
- "ship it"

### Execution Sequence

1. **G0**: Pre-flight check (clean state, not on main, tests pass)
2. **G1**: Classify change (type, scope, version impact)
3. **G2**: Lint and compliance validation
4. **G3**: Run full test suite
5. **G4**: Update documentation (if required)
6. **G5**: Version bump (if required)
7. **G6**: Create atomic commit
8. **G7**: Tag and push (if required)

---

## Parameters

| Parameter | Description | Required |
|-----------|-------------|----------|
| `{{CHANGE_TYPE}}` | Commit type (feat, fix, etc.) | Yes |
| `{{SCOPE}}` | Component scope | No |
| `{{DESCRIPTION}}` | Short description | Yes |
| `{{DETAILED_BODY}}` | Expanded explanation | No |
| `{{VERSION_BUMP}}` | patch, minor, major, none | Auto |
| `{{NEW_VERSION}}` | Version after bump | Auto |
| `{{PREVIOUS_VERSION}}` | Version before bump | Auto |

---

## Project Configuration

This skill adapts to project-specific configuration when available:

### Config File: `.nml/config.yaml`

```yaml
commands:
  test: ./tests/run-all-tests.sh
  lint: shellcheck scripts/*.sh lib/*.sh
  version_bump: ./dev/bump-version.sh
  version_validate: ./dev/validate-version.sh
  install: ./install.sh --force

gates:
  G0_preflight:
    require_clean_workdir: true
    require_tests_pass: true
    protected_branches: [main, master]
  G2_implementation:
    require_lint: true
  G3_testing:
    command: ./tests/run-all-tests.sh
```

### Fallback Commands

When no config exists, use defaults:

| Action | Default Command |
|--------|-----------------|
| Test | `npm test` or `pytest` or `./test.sh` |
| Lint | `eslint .` or `shellcheck *.sh` |
| Version | `npm version` or manual |

---

## Interactive Mode

When invoked interactively, gather required information:

### 1. Determine Change Type

```
What type of change is this?
1. feat - New feature
2. fix - Bug fix
3. docs - Documentation
4. refactor - Code restructure
5. test - Tests only
6. chore - Maintenance
7. perf - Performance
8. security - Security fix
```

### 2. Define Scope (optional)

```
What component does this change affect?
Examples: auth, api, db, cli, docs
Leave blank for no scope.
```

### 3. Write Description

```
Write a short description (imperative mood):
Example: "add user authentication endpoint"
```

### 4. Confirm Before Commit

```
About to create commit:
  Type: feat
  Scope: auth
  Description: add JWT refresh token support
  Version bump: minor (0.5.0 → 0.6.0)

Proceed? [y/N]
```

---

## Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Skipping G0 | Dirty state causes issues | Always verify clean state |
| Wrong classification | Version mismatch | Review change type carefully |
| Skipping tests | Broken builds | Tests MUST pass |
| Giant commits | Hard to review/revert | Split into atomic commits |
| Vague messages | Lost context | Use conventional format |
| Force pushing | Lost history | Only on feature branches |
| Committing to main | Bypass review | Always use branches |

---

## Critical Rules

- **[HARDCODED]** Tests MUST pass before commit
- **[HARDCODED]** Version bump MUST be validated
- **[HARDCODED]** CHANGELOG MUST be updated for feat/fix/security
- **[FORBIDDEN]** Committing to main/master directly
- **[FORBIDDEN]** Pushing without tag for version bumps
- **[FORBIDDEN]** Skipping documentation for new features

---

## Quick Reference

### Commit Message Templates

**Feature:**
```
feat(component): add feature description

Implements XYZ functionality for the ABC module.
This enables users to perform specific action.

Closes #123
```

**Bug Fix:**
```
fix(component): fix the specific issue

The bug occurred because of X. This fix ensures Y
by implementing Z approach.

Fixes #456
```

**Breaking Change:**
```
feat(api)!: change endpoint response format

BREAKING CHANGE: The /users endpoint now returns
a paginated response instead of an array.

Migration: Update client code to handle pagination.
```

### Commands Quick Reference

```bash
# Pre-flight
git status --porcelain && ./tests/run-all-tests.sh

# Lint
shellcheck scripts/*.sh lib/*.sh

# Test
./tests/run-all-tests.sh

# Version
./dev/bump-version.sh patch|minor|major
./dev/validate-version.sh

# Commit
git add -A && git commit -m "type(scope): description"

# Tag & Push
git tag -a v0.1.0 -m "feat: description"
git push origin v0.1.0 && git push origin HEAD
```

---

## Example Full Workflow

```bash
# After implementing a bug fix...

# G0: Pre-flight
git status --porcelain     # Clean
git branch --show-current  # fix/auth-token
./tests/run-all-tests.sh   # Pass

# G1: Classify
CHANGE_TYPE="fix"
SCOPE="auth"
VERSION_BUMP="patch"

# G2: Lint
shellcheck scripts/*.sh lib/*.sh  # Pass

# G3: Test
./tests/run-all-tests.sh   # Pass

# G4: Docs (behavior unchanged, skip)

# G5: Version
./dev/bump-version.sh patch
./dev/validate-version.sh  # All synced
./install.sh --force
cleo version               # v0.43.1

# G6: Commit
git add -A
git commit -m "$(cat <<'EOF'
fix(auth): prevent token expiry race condition

The refresh token was being invalidated before the
new access token was fully validated, causing
intermittent authentication failures.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"

# G7: Tag & Push
git tag -a v0.43.1 -m "fix: prevent token expiry race condition"
git push origin v0.43.1
git push origin HEAD
```
