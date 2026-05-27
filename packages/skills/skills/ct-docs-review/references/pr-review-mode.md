# PR Review Mode

When the GitHub MCP tools are available, ct-docs-review uses the
pending-review workflow to post all findings as one cohesive GitHub
review. This reference codifies the workflow, the comment format,
and the integration with `gh` CLI for the cases where MCP tools are
not available.

## Mode Detection

The mode is determined by tool availability:

| Available | Mode | Output target |
|-----------|------|---------------|
| `mcp__github__create_pending_pull_request_review` | PR mode | GitHub PR review |
| Not available | Local mode | Conversation / file |

The skill MUST check tool availability before review starts. If a
review is conducted in the wrong mode, the findings won't reach the
reader.

## PR Mode Workflow

### Step 1: Start a Pending Review

```text
Tool: mcp__github__create_pending_pull_request_review
Args: { owner, repo, pull_number }
```

This creates a draft review that doesn't appear on the PR until
submitted. The draft accumulates comments without spamming the PR.

### Step 2: Fetch the Diff

```text
Tool: mcp__github__get_pull_request_diff
Args: { owner, repo, pull_number }
```

The diff tells you which file paths and line numbers to use for each
inline comment. Comments tied to lines that don't appear in the diff
are rejected by GitHub.

### Step 3: Collect All Findings First

Read through the entire diff. Identify every violation worth flagging.
Number them sequentially: Issue 1, Issue 2, Issue 3, etc.

Do NOT post comments as you find them. Collect first, post second.

### Step 4: Add Comments in Parallel

```text
Tool: mcp__github__add_pull_request_review_comment_to_pending_review
Args: { owner, repo, pull_number, path, line, body }
```

CRITICAL: Post ALL comments in a SINGLE response, in parallel tool
calls. Posting them one-at-a-time across multiple responses creates
visual flicker and may cause GitHub to throttle.

Each comment body starts with:

```text
**Issue N: [Brief title]**
```

Followed by the description and suggested fix.

### Step 5: Submit the Review

```text
Tool: mcp__github__submit_pending_pull_request_review
Args: { owner, repo, pull_number, event: "COMMENT" }
```

Use `event: "COMMENT"` (non-blocking) — NOT `REQUEST_CHANGES`. The
non-blocking event lets the author address comments without
forcing a re-review.

Do NOT include a `body` parameter. The pending-review workflow
already attaches each finding inline; a summary body just clutters
the PR.

## Comment Format

### Standard Comment

```text
**Issue 1: Formal tone**

Line 15 uses "cannot" — CLEO docs prefer the contraction "can't" for
conversational tone.

Suggested fix:

```diff
-You cannot run this command on a dirty tree.
+You can't run this command on a dirty tree.
```
```

### Comment with Multiple Examples

```text
**Issue 3: Vague headings**

The headings "Setup" (line 8) and "Configuration" (line 47) don't
tell the reader what each section is for.

Suggested fixes:

- "Setup" → "Install dependencies and run init"
- "Configuration" → "Configure release pipeline before first ship"
```

### Comment with Diff Suggestion

GitHub supports rendered diff suggestions when the comment is on a
specific line. Use this format:

````text
**Issue 5: User-construct**

Line 22 uses "users" — CLEO docs say "people".

```suggestion
people can configure the cache by setting `cacheTimeout`.
```
````

The `suggestion` block becomes a "Commit suggestion" button for the
author. Use sparingly — only when the fix is a one-line replacement.

## Local Mode Workflow

When MCP tools aren't available, output the same findings in the
conversation using numbered markdown:

```markdown
## Issues

**Issue 1: Formal tone**
Line 15: This could be more conversational. Consider: "You can't..."
instead of "You cannot..."

**Issue 2: Vague heading**
Line 8: The heading could be more specific. Try stating the point
directly: "Run migrations before upgrading" vs "Upgrade process"

**Issue 3: Patronizing qualifier**
Line 23: Remove "easy" — it patronizes the reader. Let the steps
speak for themselves.
```

### gh CLI Fallback

If MCP tools aren't available but `gh` CLI is, you can still post a
PR review via shell:

```bash
gh pr review <PR_NUMBER> --comment --body "$(cat <<'EOF'
## Issues

**Issue 1: Formal tone**
Line 15: This could be more conversational...

**Issue 2: Vague heading**
Line 8: The heading could be more specific...
EOF
)"
```

The shell route uses a single overall comment rather than inline
comments. Less precise but still useful when MCP isn't an option.

## Numbering Discipline

Every issue MUST be numbered sequentially starting from Issue 1.

```text
GOOD:
Issue 1: ...
Issue 2: ...
Issue 3: ...

BAD (skipping numbers):
Issue 1: ...
Issue 3: ...

BAD (random labels):
Issue A: ...
Issue 2: ...
Issue Important: ...
```

Sequential numbering lets the author say "fix issues 1, 3, and 5"
unambiguously. It also lets them track which feedback they've
addressed.

## Materiality Before Numbering

Before assigning Issue numbers, run the materiality filter (see
`style-violations.md` §Materiality Filter). Issues that would not
make a meaningful difference to the reader are SKIPPED, not numbered
and labeled "minor".

The materiality filter exists because flooding the author with low-
value flags trains them to ignore the review. Be selective up front;
flag only what matters.

## Review Length Guidelines

| Doc size | Typical issue count |
|----------|---------------------|
| Small (< 100 lines) | 0-3 issues |
| Medium (100-300 lines) | 0-8 issues |
| Large (300+ lines) | 0-15 issues |

A review with 30 issues on a 200-line doc signals one of:

- The doc is genuinely in bad shape (needs deep rewrite, not nits)
- The reviewer is over-flagging low-value stuff

If you find yourself at 20+ issues on a medium doc, step back and
ask: is the materiality filter being applied? Are these the issues
that matter?

## Workflow Discipline

| Step | Anti-pattern | Correct |
|------|--------------|---------|
| Start | Begin posting comments immediately | Start pending review first |
| Identify | Post issues one-by-one as found | Collect ALL, then post in parallel |
| Format | Plain text bodies | `**Issue N: [Title]**` prefix |
| Submit | `event: REQUEST_CHANGES` blocks PR | `event: COMMENT` is non-blocking |
| Body | Long summary body on submit | Empty body — let inline comments speak |

## Re-Review After Fix

When the author addresses feedback and pushes new commits, run the
review again on the updated diff. Don't re-flag issues that are
already fixed; do flag new issues introduced in the fix.

For re-reviews, start the comment with a status line:

```text
**Issue 2 (UPDATED): Vague heading**

The previous fix changed "Setup" to "Setup Steps" — still vague.
Try "Install dependencies, then run init".
```

The "(UPDATED)" tag signals to the author that this is iteration,
not a brand-new flag.

## When Review Should Block

The default event is `COMMENT` (non-blocking). Use `REQUEST_CHANGES`
only when the PR contains issues that, if shipped, would actively
harm readers:

- Broken code examples that would fail when copy-pasted
- Outdated security guidance
- Links to deprecated APIs in setup instructions
- Patronizing language to vulnerable audiences

For everything else, use COMMENT. Trust the author to take feedback
seriously without being forced.
