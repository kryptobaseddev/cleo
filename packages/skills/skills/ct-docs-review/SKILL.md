---
name: ct-docs-review
description: This skill should be used when the user asks to "review documentation", "check docs style", "review this markdown file", "check style guide compliance", "review PR documentation", or needs documentation reviewed against the CLEO writing style guide. Supports both local file review and GitHub PR review modes with inline comments.
version: 1.0.0
tier: 3
core: false
category: composition
protocol: null
dependencies: []
sharedResources: []
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
license: MIT
---

# Documentation Review Skill

@skills/_shared/cleo-style-guide.md

## Review mode detection

**IMPORTANT: Before starting the review, determine which mode to use:**

1. **PR review mode**: If the `mcp__github__create_pending_pull_request_review` tool is available, you are reviewing a GitHub PR
   - Use the pending review workflow to post all issues as one cohesive review
   - Follow the workflow steps in "PR review mode format" below

2. **Local review mode**: If the MCP tool is NOT available, output issues in the conversation
   - Format all issues in a numbered markdown list (as described in "Feedback format" below)

## Review process

1. **Detect review mode** - Check if `mcp__github__create_pending_pull_request_review` is available
2. Read the changes through once to understand intent
3. Check all issues that violate style guide or significantly impact readability
4. Only flag issues worth mentioning - if it won't make a material difference to the reader, skip it
5. **REQUIRED: Number ALL feedback sequentially** - Start from Issue 1 and increment for each issue found

## Review checklist

Run through the diff looking for these issues:

**Tone and voice:**

- [ ] Formal/corporate language ("utilize" not "use", "offerings", etc.)
- [ ] "Users" instead of "people" or "companies"
- [ ] Excessive exclamation points or overly peppy tone
- [ ] Telling readers something is cool instead of showing them

**Structure and clarity:**

- [ ] Important information buried instead of leading
- [ ] Verbose text that adds little value
- [ ] Paragraphs without clear purpose
- [ ] Vague headings that don't convey the point
- [ ] Instructions explain "why" before telling "what to do"
- [ ] Tasks described as "easy" or "simple"

**Links and references:**

- [ ] Linking the word "here" instead of descriptive text
- [ ] Links in headings (unless entire heading is a link)

**Formatting:**

- [ ] Ampersands as "and" substitute (except proper nouns)
- [ ] Inconsistent list formatting

**Code and examples:**

- [ ] Code examples that don't work or would error
- [ ] Commands not in execution order
- [ ] Full-width screenshots instead of scoped UI elements
- [ ] Excessive or unnecessary images

**Sentence construction:**

- [ ] Overuse of pronouns when introducing new terms

## Quick scan table

| Pattern                       | Issue                                         |
| ----------------------------- | --------------------------------------------- |
| we can do X, our feature      | Should be "CLEO" or "it"                      |
| click here, read more here    | Need descriptive link text                    |
| easy, simple, just            | Remove condescending qualifiers               |
| users                         | Should be "people" or "companies" if possible |

## Feedback format

**MANDATORY REQUIREMENT: Every single issue MUST be numbered sequentially starting from Issue 1.**

This numbered format is NON-NEGOTIABLE. It allows users to efficiently reference specific issues (e.g., "fix issues 1, 3, and 5") and track which feedback has been addressed.

### Local review mode format

When outputting issues in the conversation (local mode), use this format:

```markdown
## Issues

**Issue 1: [Brief title]**
Line X: Succinct description of the issue
[code or example]
Suggested fix or succinct explanation

**Issue 2: [Brief title]**
Line Y: Description of the issue
Suggested fix or explanation

**Issue 3: [Brief title]**
...
```

**Examples:**

> **Issue 1: Formal tone**
> Line 15: This could be more conversational. Consider: "You can't..." instead of "You cannot..."

> **Issue 2: Vague heading**
> Line 8: The heading could be more specific. Try stating the point directly: "Run migrations before upgrading" vs "Upgrade process"

### PR review mode format

When posting to GitHub (PR mode), use the **pending review workflow**:

**Workflow steps:**

1. **Start a review**: Use `mcp__github__create_pending_pull_request_review` to begin a pending review
   - This creates a draft review that won't be visible until submitted

2. **Get diff information**: Use `mcp__github__get_pull_request_diff` to understand the code changes and line numbers
   - This helps you determine the correct file paths and line numbers for comments

3. **Identify ALL issues**: Read through all changes and identify every issue worth mentioning
   - Collect all issues before posting any comments
   - Number them sequentially (Issue 1, Issue 2, Issue 3, etc.)

4. **Add review comments**: Use `mcp__github__add_pull_request_review_comment_to_pending_review` for each issue
   - **CRITICAL**: Post ALL comments in a SINGLE response using multiple tool calls in parallel
   - Each comment should reference a specific file path and line number from the diff
   - Start each comment body with `**Issue N: [Brief title]**`
   - Include the description and suggested fix

5. **Submit the review**: Use `mcp__github__submit_pending_pull_request_review` to publish all comments at once
   - Use event type `"COMMENT"` (NOT "REQUEST_CHANGES") to make it non-blocking
   - **Do NOT include a body message** - Leave the body empty or omit it entirely
   - All comments will appear together as one cohesive review

**Comment format example:**

```
**Issue 1: Formal tone**

This could be more conversational. Consider: "You can't..." instead of "You cannot..."
```

**IMPORTANT**:
- Each issue gets its own review comment attached to the pending review
- Number ALL comments sequentially (Issue 1, Issue 2, Issue 3, etc.)
- Always start the comment body with `**Issue N: [Brief title]**`
- **MUST add all comments in parallel in a single response** - Do NOT add them one after another in separate responses
- Do NOT output a summary message to the conversation - only post GitHub review comments
- When submitting the review, do NOT include a body parameter (or leave it empty) to avoid cluttering the PR with summary text
- The review will appear as a single review with multiple comments when submitted

## Final check

1. Remove any issues from your assessment that won't make a material difference to the reader if addressed. Only flag issues worth the author's time to fix.
2. **Verify all issues are numbered sequentially** starting from Issue 1 with no gaps in numbering.
3. Confirm the format exactly matches: `**Issue N: [Brief title]**` where N is the issue number.
4. **In PR mode**: Verify each issue was posted as a separate GitHub comment (not output to conversation).

## Issue length guidelines

| Doc size | Typical issue count | Red flag |
|----------|---------------------|----------|
| Small (< 100 lines) | 0-3 issues | 10+ issues |
| Medium (100-300 lines) | 0-8 issues | 20+ issues |
| Large (300+ lines) | 0-15 issues | 30+ issues |

A flood of low-value flags trains the author to ignore reviews. Apply
the materiality filter aggressively — be selective up front; flag only
what matters.

## Workflow discipline

| Step | Anti-pattern | Correct |
|------|--------------|---------|
| Start | Post comments immediately | Start pending review first |
| Identify | Post issues one-by-one | Collect ALL, then post in parallel |
| Format | Plain text bodies | `**Issue N: [Title]**` prefix |
| Submit | `event: REQUEST_CHANGES` blocks PR | `event: COMMENT` is non-blocking |
| Body | Long summary body on submit | Empty body — let inline comments speak |

## When review should block

The default event is `COMMENT` (non-blocking). Use `REQUEST_CHANGES`
only when the PR contains issues that, if shipped, would actively harm
readers:

- Broken code examples that would fail when copy-pasted
- Outdated security guidance
- Links to deprecated APIs in setup instructions
- Patronizing language to vulnerable audiences

For everything else, use COMMENT. Trust the author to take feedback
seriously without being forced.

## Re-review after fix

When the author addresses feedback and pushes new commits, run the
review again on the updated diff. Don't re-flag issues already fixed;
do flag new issues introduced in the fix.

For re-reviews, start the comment with a status line:

```text
**Issue 2 (UPDATED): Vague heading**

The previous fix changed "Setup" to "Setup Steps" — still vague.
Try "Install dependencies, then run init".
```

The "(UPDATED)" tag signals iteration, not a brand-new flag.

---

## See references/

Progressive disclosure — load on demand only:

- `references/style-violations.md` — taxonomy of violations with detection patterns, issue titles, and remediation messages
- `references/pr-review-mode.md` — pending-review workflow, comment format, gh CLI fallback, materiality filter
- `references/inline-comment-patterns.md` — comment anatomy, single-line/multi-line/pattern fixes, anti-patterns