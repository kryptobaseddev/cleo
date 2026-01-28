# Commit Hook Installation Guide

**Purpose**: Install CLEO's commit-msg hook to enforce task ID references in commits

---

## Quick Install

### For CLEO Repository (This Repo)

```bash
cp .cleo/templates/git-hooks/commit-msg .git/hooks/commit-msg
chmod +x .git/hooks/commit-msg
```

### For Other Repositories

```bash
# Navigate to your project
cd /path/to/your/project

# Install CLEO (if not already installed)
cleo init

# Install commit hook
cleo init --install-hooks
```

---

## Manual Installation

If you prefer manual installation or need to customize:

1. **Copy template**:
   ```bash
   cp ~/.cleo/templates/git-hooks/commit-msg /path/to/project/.git/hooks/commit-msg
   ```

2. **Make executable**:
   ```bash
   chmod +x /path/to/project/.git/hooks/commit-msg
   ```

3. **Verify installation**:
   ```bash
   test -x /path/to/project/.git/hooks/commit-msg && echo "Hook installed" || echo "Hook not executable"
   ```

---

## How It Works

### Commit Message Format

All commits must reference a task ID:

```bash
git commit -m "feat(validation): Add protocol checks (T2692)"
                                                        ↑ Required
```

**Pattern**: `(T####)` anywhere in the commit message

**Examples**:
- ✓ `feat: Add feature (T1234)`
- ✓ `(T1234) feat: Add feature`
- ✓ `feat: Add feature for T1234 and (T1235)`
- ✗ `feat: Add feature` (no task ID)
- ✗ `feat: Add feature T1234` (missing parentheses)

### Validation Process

When you commit:

1. Hook extracts task ID from message
2. Validates ID exists: `cleo exists T####`
3. If valid → commit proceeds
4. If invalid → commit blocked with error

**Error example**:
```
ERROR: Task T9999 does not exist

Current focus: T2704

Suggested format:
  feat: Add feature (T2704)

Bypass with: git commit --no-verify
```

---

## Auto-Bypass Conditions

The hook automatically allows commits without task IDs for:

### 1. Merge Commits

```bash
git merge feature-branch
# "Merge branch 'feature-branch'" → auto-bypassed
```

### 2. Revert Commits

```bash
git revert abc123
# "Revert 'previous commit'" → auto-bypassed
```

### 3. CI/CD Environments

When these environment variables are set:
- `$CI`
- `$GITHUB_ACTIONS`
- `$GITLAB_CI`

```bash
# GitHub Actions example
CI=true git commit -m "automated release"  # auto-bypassed
```

---

## Manual Bypass

### When to Bypass

Use sparingly for:
- Emergency hotfixes
- External contributor commits
- Initial repository setup
- Migration commits

### How to Bypass

```bash
git commit --no-verify -m "emergency hotfix"
```

**Important**: All bypasses are logged to `.cleo/bypass-log.json`

### Bypass Log Format

```json
{
  "timestamp": "2026-01-28T09:30:00Z",
  "commit": "abc123def456",
  "user": "developer",
  "session": "session_20260128_093000_abc123",
  "message": "emergency hotfix",
  "justification": "manual",
  "note": "Emergency fix",
  "hook": "commit-msg"
}
```

---

## Troubleshooting

### Error: "cleo not found"

**Symptom**:
```
/path/to/commit-msg: line 15: cleo: command not found
```

**Fix**:
```bash
# Ensure CLEO is installed
which cleo

# If not installed:
cd /path/to/cleo && ./install.sh

# Verify:
cleo version
```

---

### Error: "Task does not exist"

**Symptom**:
```
ERROR: Task T1234 does not exist
```

**Fix**:
```bash
# Verify task exists
cleo show T1234

# If task missing, use correct ID:
cleo find "feature name"

# Or use current focus:
cleo focus show
```

---

### Hook Not Running

**Symptom**: Commits succeed without task IDs

**Diagnosis**:
```bash
# Check if hook exists
ls -la .git/hooks/commit-msg

# Check if executable
test -x .git/hooks/commit-msg && echo "Executable" || echo "Not executable"
```

**Fix**:
```bash
# Make executable
chmod +x .git/hooks/commit-msg

# Test hook directly
.git/hooks/commit-msg test-commit-msg.txt <<< "test commit (T1234)"
echo $?  # Should be 0 if successful
```

---

### Multiple Task References

If commit message contains multiple task IDs:

```bash
git commit -m "feat: Merge changes (T1234) (T1235)"
#                                    ↑ First ID used for validation
```

The hook validates the **first** task ID only.

---

## Bypass Log Management

### Viewing Bypasses

```bash
# Show all bypasses
cat .cleo/bypass-log.json

# Show recent bypasses (last 10)
tail -10 .cleo/bypass-log.json

# Show bypasses from today
jq 'select(.timestamp | startswith("2026-01-28"))' .cleo/bypass-log.json

# Count bypasses by justification
jq -s 'group_by(.justification) | map({justification: .[0].justification, count: length})' .cleo/bypass-log.json
```

### Bypass Log Location

- Default: `.cleo/bypass-log.json`
- Created automatically on first bypass
- One JSON entry per line (JSONL format)

### Cleaning Up Bypass Logs

```bash
# Archive old bypasses (older than 90 days)
jq -s 'map(select(.timestamp > (now - 90*24*60*60 | todate)))' .cleo/bypass-log.json > .cleo/bypass-log-new.json
mv .cleo/bypass-log-new.json .cleo/bypass-log.json

# Or delete all bypass logs
rm .cleo/bypass-log.json
```

---

## Integration with CI/CD

### GitHub Actions

```yaml
name: Validate Commits

on: [push, pull_request]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0  # Full history for commit validation

      - name: Install CLEO
        run: |
          cd /tmp
          git clone https://github.com/your-org/cleo.git
          cd cleo && ./install.sh

      - name: Validate commit messages
        run: |
          for commit in $(git rev-list origin/main..HEAD); do
            msg=$(git log --format=%B -n 1 "$commit")
            if ! echo "$msg" | grep -qE '\(T[0-9]+\)'; then
              echo "ERROR: Commit $commit missing task ID"
              echo "Message: $msg"
              exit 1
            fi
          done
```

### GitLab CI

```yaml
commit-validation:
  stage: validate
  script:
    - apt-get update && apt-get install -y git
    - cd /tmp && git clone https://github.com/your-org/cleo.git
    - cd cleo && ./install.sh
    - cd $CI_PROJECT_DIR
    - |
      for commit in $(git rev-list origin/main..HEAD); do
        msg=$(git log --format=%B -n 1 "$commit")
        if ! echo "$msg" | grep -qE '\(T[0-9]+\)'; then
          echo "ERROR: Commit $commit missing task ID"
          exit 1
        fi
      done
```

---

## Uninstallation

### Remove Hook

```bash
rm .git/hooks/commit-msg
```

### Verify Removal

```bash
test -f .git/hooks/commit-msg && echo "Hook still exists" || echo "Hook removed"
```

---

## Best Practices

### 1. Install in All Project Repos

Consistent enforcement across all projects:

```bash
for repo in ~/projects/*; do
  if [ -d "$repo/.git" ]; then
    cp ~/.cleo/templates/git-hooks/commit-msg "$repo/.git/hooks/commit-msg"
    chmod +x "$repo/.git/hooks/commit-msg"
    echo "Installed hook in $repo"
  fi
done
```

### 2. Set Focus Before Committing

```bash
# Set focus to task you're working on
cleo focus set T1234

# Make changes
git add .

# Commit (hook suggests focused task if you forget ID)
git commit -m "feat: Add feature"
# ERROR: No task ID in commit message
# Current focus: T1234
# Suggested format: feat: Add feature (T1234)
```

### 3. Review Bypass Logs Regularly

```bash
# Weekly review
cleo stats --bypasses --last-week

# Monthly audit
cleo report --bypasses --since 2026-01-01
```

### 4. Document Bypass Policy

Add to your project's CONTRIBUTING.md:

```markdown
## Commit Requirements

All commits must reference a task ID:

\`\`\`bash
git commit -m "feat: Add feature (T1234)"
\`\`\`

### Bypassing

Bypass only for:
- Emergency hotfixes
- Initial setup
- Migration commits

All bypasses are logged and reviewed weekly.
\`\`\`
```

---

## Reference

### Specifications

- **Commit Task Enforcement Spec**: `docs/specs/COMMIT-TASK-ENFORCEMENT-SPEC.md`
- **Protocol Enforcement Spec**: `docs/specs/PROTOCOL-ENFORCEMENT-SPEC.md`

### Hook Location

- **Template**: `.cleo/templates/git-hooks/commit-msg`
- **Installed**: `.git/hooks/commit-msg` (per repository)
- **Global template**: `~/.cleo/templates/git-hooks/commit-msg`

### Tests

- **Unit tests**: `tests/integration/commit-hook.bats`
- **36 test cases** covering all scenarios

---

## Support

For hook installation issues:

1. Check this guide
2. Verify CLEO installation: `cleo version`
3. Test hook directly: `.git/hooks/commit-msg test.txt`
4. Review bypass logs: `cat .cleo/bypass-log.json`
5. Check troubleshooting guide: `docs/guides/troubleshooting.md`

**Last Updated**: 2026-01-28 | **Version**: 1.0.0
