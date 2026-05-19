# Chain Orchestration

`ct-documentor` is a coordinator skill — it does not produce documentation
directly. Its job is to orchestrate three child skills (`ct-docs-lookup`,
`ct-docs-write`, `ct-docs-review`) in the right sequence with the right
inputs. This reference defines when to invoke each child, what to pass,
and how to handle returns.

## The Three Children

| Child | Purpose | Owns |
|-------|---------|------|
| `ct-docs-lookup` | Library/framework API lookup via Context7 | Current external docs |
| `ct-docs-write` | Drafts content following CLEO style guide | New content |
| `ct-docs-review` | Reviews against style guide; supports PR mode | Quality validation |

A complete documentation task usually invokes write + review. Lookup is
optional — only when the doc must cite a library's actual current API.

## Decision Sequence

For every documentation task, run this sequence before invoking any child.

```text
1. DISCOVERY
   - Glob: docs/**/*.md to map the existing tree
   - Grep: <topic-keywords> across docs/ to find prior coverage
   - Decision: is there already a canonical location for this content?

2. CLASSIFICATION
   - Type: tutorial | how-to | reference | explanation (Diátaxis grid)
   - Audience: end-user | agent | maintainer
   - Lifecycle: new file | update existing | consolidate scattered

3. CHAIN
   - If type touches library APIs → ct-docs-lookup first
   - Always → ct-docs-write
   - Always → ct-docs-review

4. REPORT
   - Manifest entry with "Files NOT Created (Avoided Duplication)" section
   - Cross-references updated
```

The Discovery step is mandatory. Skipping it produces duplicate
documentation — the dominant failure mode of past documentation tasks.

## Invoking ct-docs-lookup

Use when the task touches a specific library, framework, or external
API. Pass the library name, the user's actual question (full sentence,
not a single word), and any version qualifier.

**Invoke when:**

- Documenting a setup or migration that depends on a specific
  framework version.
- Writing reference docs that cite a library's exported API.
- Answering "how do I X with library Y" in a guide.

**Do NOT invoke when:**

- The doc describes CLEO's own internal architecture (use BRAIN + code
  reading, not external lookup).
- The user asks a conceptual question that does not name a library.

**Input shape:**

```json
{
  "library": "Next.js",
  "version": "15",
  "query": "how do I configure middleware to inject auth headers"
}
```

**Return.** Documentation excerpts with citations. Do not paste blindly —
synthesize into the doc body, citing the library version.

## Invoking ct-docs-write

The write child owns content production. Its frontmatter (under
`packages/skills/skills/ct-docs-write/SKILL.md`) describes the style
guide it enforces. Always invoke for any new or updated content.

**Input shape:**

```json
{
  "file_path": "docs/guides/auth-setup.md",
  "content_topic": "configure SAML before adding users",
  "audience": "end-user",
  "type": "how-to",
  "outline": [
    "Why SAML must precede user addition",
    "Step-by-step config",
    "Common errors and fixes"
  ]
}
```

The outline guides the writer — without it, the draft tends to drift
into tutorial mode when reference was needed (and vice versa).

**Return.** A drafted markdown file. The documentor does not edit it
directly — the next step is review.

## Invoking ct-docs-review

The review child owns quality validation. It checks against the CLEO
style guide and is the gate before the documentation task can complete.

**Input shape:**

```json
{
  "file_path": "docs/guides/auth-setup.md",
  "mode": "local"
}
```

For PR-mode review (when reviewing a GitHub PR rather than a local
file):

```json
{
  "pr_url": "https://github.com/kryptobaseddev/cleocode/pull/315",
  "mode": "pr"
}
```

**Return.** A numbered list of issues with line refs and suggested
fixes. If the issue count is 0, the doc passes. If non-zero, the
documentor MUST loop — pass the issues back to `ct-docs-write` for
revision, then re-review.

## The Review Loop

The contract is: documentation does not ship with open review issues.
The documentor MUST loop until review returns zero issues OR escalates
to HITL.

```text
draft = ct-docs-write(input)
issues = ct-docs-review(draft)
while issues != [] and iteration < 3:
  draft = ct-docs-write(input + issues)
  issues = ct-docs-review(draft)
if issues != []:
  escalate_to_HITL("3 review iterations did not converge")
```

Three iterations is the convergence budget. If review keeps finding
issues, the task is mis-scoped (audience confusion, style guide
conflict with content) — escalate rather than burning more tokens.

## Cross-Skill Output Conventions

All three children return to the documentor. The documentor aggregates
into ONE manifest entry. Children do NOT each append their own — that
would inflate the manifest.

```json
{
  "id": "docs-auth-setup-2026-05-19",
  "file": "2026-05-19_docs-auth-setup.md",
  "title": "Documentation Update: SAML Setup Guide",
  "status": "complete",
  "agent_type": "documentation",
  "topics": ["documentation", "auth", "saml"],
  "key_findings": [
    "Created docs/guides/auth-setup.md (how-to, end-user audience)",
    "Cited Next.js 15 middleware API via ct-docs-lookup",
    "Review converged in 2 iterations (8 issues → 3 → 0)",
    "Updated docs/index.md to reference new guide"
  ],
  "actionable": false,
  "needs_followup": [],
  "linked_tasks": ["{{TASK_ID}}"]
}
```

The `key_findings` MUST report the iteration count and the chain that
ran. This lets the orchestrator confirm the contract was honored.

## Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Doc duplicates existing content | Skipped Discovery | Always Glob + Grep before write |
| Doc cites stale API | Skipped ct-docs-lookup | Invoke lookup for any library API claim |
| Doc fails review repeatedly | Audience or type mismatch | Re-classify; pass corrected to write |
| Review iteration count >3 | Mis-scoped task | Escalate to HITL with summary |
| Manifest missing iteration data | Children appended their own entries | Children MUST return to documentor; one entry only |
