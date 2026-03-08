# Dynamic Context Injection

Skills can inject dynamic runtime information into SKILL.md content before Claude sees it. Three mechanisms are available: shell pre-processing, argument substitution, and session variables.

## Shell Pre-Processing

Embed shell command output directly into skill content using backtick-bang syntax.

**Syntax**: `` !`command` ``

The command runs before Claude sees the skill content. The entire `` !`command` `` expression is replaced with the command's stdout output.

**Examples**:

```markdown
## Current Repository State

Recent commits:
!`git log --oneline -5`

Current branch: !`git branch --show-current`

Last tag: !`git describe --tags --abbrev=0 2>/dev/null || echo "no tags"`
```

After pre-processing, Claude sees:

```markdown
## Current Repository State

Recent commits:
a1b2c3d fix: resolve auth timeout
d4e5f6g feat: add user dashboard
7h8i9j0 refactor: extract validation
k1l2m3n docs: update API reference
o4p5q6r test: add integration tests

Current branch: feature/user-dashboard

Last tag: v2.3.1
```

**Complex commands** work as expected -- pipes, subshells, and multi-command expressions:

```markdown
Node version: !`node --version`
Package name: !`cat package.json | python3 -c "import sys,json; print(json.load(sys.stdin)['name'])"`
File count: !`find src -name '*.ts' | wc -l`
```

**Failure behavior**: If a command fails (non-zero exit code), the expression is replaced with an empty string. The skill still loads -- failed commands do not block skill execution. Use fallback patterns like `command || echo "fallback"` to handle expected failures gracefully:

```markdown
Python version: !`python3 --version 2>/dev/null || echo "Python not installed"`
```

## Argument Substitution

When users invoke a skill with arguments (e.g., `/my-skill arg1 arg2`), the arguments are available through substitution variables in the skill body.

### Full Argument String

`$ARGUMENTS` -- all arguments as a single string, exactly as the user typed them.

```markdown
## Task

Analyze the following: $ARGUMENTS
```

If the user types `/analyze-code src/auth.ts --depth 3`, Claude sees:

```markdown
## Task

Analyze the following: src/auth.ts --depth 3
```

### Indexed Access

Access individual arguments by zero-based index:

| Variable | Equivalent | Value (for `/skill foo bar baz`) |
|---|---|---|
| `$ARGUMENTS[0]` | `$1` | `foo` |
| `$ARGUMENTS[1]` | `$2` | `bar` |
| `$ARGUMENTS[2]` | `$3` | `baz` |
| `$ARGUMENTS` | (all) | `foo bar baz` |

The `$1`, `$2`, `$3` shorthand forms are interchangeable with `$ARGUMENTS[0]`, `$ARGUMENTS[1]`, `$ARGUMENTS[2]`.

### Worked Example

Given the invocation `/deploy-check production api-gateway`:

```markdown
## Deployment Check

**Environment**: $1
**Service**: $2

Run the following verification:

1. Check that $ARGUMENTS[0] cluster is healthy
2. Verify $ARGUMENTS[1] pods are running
3. Full command context: deploying $ARGUMENTS
```

Claude sees:

```markdown
## Deployment Check

**Environment**: production
**Service**: api-gateway

Run the following verification:

1. Check that production cluster is healthy
2. Verify api-gateway pods are running
3. Full command context: deploying production api-gateway
```

### Missing Arguments

If a user provides fewer arguments than the skill references, unreferenced `$ARGUMENTS[N]` variables are replaced with empty strings. Design skills defensively by placing critical instructions outside of argument-dependent sections, or by documenting required arguments in `argument-hint`.

## Session Variables

Two environment variables are available for runtime context:

### CLAUDE_SESSION_ID

`${CLAUDE_SESSION_ID}` -- a unique identifier for the current Claude session. Useful for correlating logs, creating session-specific output files, or tracking work across multiple skill invocations within the same session.

```markdown
## Logging

Write analysis results to `/tmp/analysis-${CLAUDE_SESSION_ID}.json` for later review.
```

### CLAUDE_SKILL_DIR

`${CLAUDE_SKILL_DIR}` -- the absolute filesystem path to the skill's root directory. This is the directory containing SKILL.md.

This variable is critical for skills that bundle scripts, references, or assets. Without it, bundled scripts would need hardcoded absolute paths -- which break when the skill is installed in different locations (global vs. project, different providers, different machines).

**The portable bundled-script pattern**:

```markdown
## Analysis

Run the analysis script on the target file:

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/analyze.py "$1"
```
```

This works regardless of where the skill is installed:
- Global install: `${CLAUDE_SKILL_DIR}` = `/home/user/.claude/skills/my-skill`
- Project install: `${CLAUDE_SKILL_DIR}` = `/projects/myapp/.claude/skills/my-skill`
- Symlinked: `${CLAUDE_SKILL_DIR}` resolves through the symlink to the actual directory

Without `${CLAUDE_SKILL_DIR}`, you would need to hardcode paths like `/home/user/.claude/skills/my-skill/scripts/analyze.py`, which breaks for every other user and installation location.

**Referencing bundled resources**:

```markdown
For the full API schema, read: ${CLAUDE_SKILL_DIR}/references/api-schema.md

For brand assets, copy from: ${CLAUDE_SKILL_DIR}/assets/logo.png
```

## Combining All Features

A realistic skill body demonstrating all three injection mechanisms together:

```markdown
---
name: pr-review
description: "Automated pull request code review with project-aware analysis. Use when reviewing PRs, checking code quality, or preparing review comments."
argument-hint: "<pr-number>"
allowed-tools:
  - Read
  - Bash(gh pr *)
  - Bash(git *)
---

# PR Review

## Project Context

**Repository**: !`git remote get-url origin | sed 's/.*github.com[:/]//' | sed 's/.git$//'`
**Default branch**: !`git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main"`
**Test framework**: !`[ -f vitest.config.ts ] && echo "Vitest" || ([ -f jest.config.js ] && echo "Jest" || echo "unknown")`

## Review Target

Fetch and review PR #$1:

```bash
gh pr diff $ARGUMENTS[0] > /tmp/pr-${CLAUDE_SESSION_ID}.diff
```

## Review Checklist

Load the project's review standards:

```bash
cat ${CLAUDE_SKILL_DIR}/references/review-checklist.md
```

Run the automated checks:

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/lint_diff.py /tmp/pr-${CLAUDE_SESSION_ID}.diff
```

## Output

Write the review to `/tmp/review-$1-${CLAUDE_SESSION_ID}.md` using the template at `${CLAUDE_SKILL_DIR}/assets/review-template.md`.
```

In this example:
- **Shell pre-processing** (`!`...``) injects the repository name, default branch, and test framework at load time
- **Argument substitution** (`$1`, `$ARGUMENTS[0]`) passes the PR number into commands and filenames
- **Session variables** (`${CLAUDE_SESSION_ID}`, `${CLAUDE_SKILL_DIR}`) create unique temp files and locate bundled scripts portably
