---
name: ct-docs-lookup
description: This skill should be used when the user asks "how do I configure [library]", "write code using [framework]", "what are the [library] methods", "show me [framework] examples", or mentions libraries like React, Vue, Next.js, Prisma, Supabase, Express, Tailwind, Drizzle, Svelte. Triggers for library setup, configuration, API references, framework code examples, or version-specific docs ("React 19", "Next.js 15").
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

When the user asks about libraries, frameworks, or needs code examples, use Context7 to fetch current documentation instead of relying on training data.

## When to Use This Skill

Activate this skill when the user:

- Asks setup or configuration questions ("How do I configure Next.js middleware?")
- Requests code involving libraries ("Write a Prisma query for...")
- Needs API references ("What are the Supabase auth methods?")
- Mentions specific frameworks (React, Vue, Svelte, Express, Tailwind, etc.)

## How to Fetch Documentation

### Step 1: Resolve the Library ID

Call `resolve-library-id` with:

- `libraryName`: The library name extracted from the user's question
- `query`: The user's full question (improves relevance ranking)

### Step 2: Select the Best Match

From the resolution results, choose based on:

- Exact or closest name match to what the user asked for
- Higher benchmark scores indicate better documentation quality
- If the user mentioned a version (e.g., "React 19"), prefer version-specific IDs

### Step 3: Fetch the Documentation

Call `query-docs` with:

- `libraryId`: The selected Context7 library ID (e.g., `/vercel/next.js`)
- `query`: The user's specific question

### Step 4: Use the Documentation

Incorporate the fetched documentation into your response:

- Answer the user's question using current, accurate information
- Include relevant code examples from the docs
- Cite the library version when relevant

## Guidelines

- **Be specific**: Pass the user's full question as the query for better results
- **Version awareness**: When users mention versions ("Next.js 15", "React 19"), use version-specific library IDs if available from the resolution step
- **Prefer official sources**: When multiple matches exist, prefer official/primary packages over community forks

## Why Context7 (not training data)

The user's global rule is explicit: prefer Context7 over training data for any
library, framework, SDK, API, CLI tool, or cloud service — even well-known ones
like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This
includes API syntax, configuration, version migration, library-specific
debugging, setup instructions, and CLI tool usage. Use even when you think
you know the answer; training data may not reflect recent changes.

## Three-Command Budget

The user rules cap a docs lookup at three CLI invocations per question. The
budget fits the standard workflow:

1. `npx ctx7@latest library "<name>" "<question>"` — one call to resolve.
2. `npx ctx7@latest docs <id> "<question>"` — one call to fetch.
3. (Optional) `npx ctx7@latest docs <id> "<question>" --research` — one
   retry with sandboxed agents pulling source + web search.

Going over budget is a signal: the library name is wrong, the question
is too broad, or Context7 doesn't cover this library. In any of those
cases, refine before retrying — don't burn more calls.

## When NOT to Use This Skill

The user rules explicitly exclude these from docs-lookup:

- **Refactoring** — re-shaping existing code; no library lookup needed.
- **Scripts written from scratch** — general programming, not library API.
- **Debugging business logic** — use codebase tools (Grep, GitNexus), not
  external docs.
- **Code review** — quality assessment, not library reference.
- **General programming concepts** — pure CS questions; training data is fine.

Use docs-lookup ONLY for: API syntax, configuration questions, version
migration issues, library-specific debugging, setup instructions, and CLI
tool usage.

## Authentication and Quotas

The `ctx7` CLI runs anonymously with a limited free quota. When quota
exhausts:

```text
Error: Quota exceeded.
  Run `npx ctx7@latest login` for higher limits.
  Or set CONTEXT7_API_KEY env var with your key.
```

Surface the error to the user (or include in `needs_followup`). NEVER
silently fall back to training data — that violates the skill's contract.

## Sensitive Data

Queries to Context7 are logged on the Context7 side. Never include:

- API keys, tokens, passwords
- Internal hostnames or URLs
- Customer-identifying data
- Source code excerpts from private repos

Use generic phrasing. If the actual API call needs a specific value,
describe it abstractly ("how do I authenticate with an API key" instead
of "use API key sk_live_abc123 to...").

## Multi-Library Composition

A single question may touch multiple libraries — common in modern stacks
(SvelteKit + Better-Auth + Drizzle, Next.js + Prisma + Tailwind, etc.).
Resolve each library independently with the right version pin, then
synthesize.

The three-command budget applies per-library; a question spanning
three libraries gets nine commands. Stay focused — fetch the specific
integration point each time, not the entire library surface.

## Citing Versions in Answers

Every code example produced from a version-pinned fetch MUST cite the
version. The reader copies the code and runs it; when their version
differs, the citation is the first thing they check.

```markdown
Use `defineRelations` (Drizzle ORM v1.0.0-beta and later):

```typescript
import { defineRelations } from "drizzle-orm";
// ...
```
```

Without the version note, the reader who is on Drizzle 0.x will be
confused when the import fails.

## Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Library not found" | Wrong name format | Use official punctuation: "Next.js" not "nextjs" |
| Stale answer | No version pin | Detect installed version from lockfile, pin |
| Generic answer when specifics needed | Vague query | Pass full question text, not single words |
| Quota exceeded | Anonymous over-use | `ctx7 login` or set `CONTEXT7_API_KEY` |
| Hallucinated API | Skipped Context7 | Always run Step 1+2 before answering library questions |
| Wrong fork picked | Took top result blindly | Read descriptions; prefer official org |

---

## See references/

Progressive disclosure — load on demand only:

- `references/ctx7-workflow.md` — two-step loop, query formatting, research mode, budget
- `references/library-id-resolution.md` — signals for picking the right ID; disambiguation procedure
- `references/version-specific-docs.md` — version pinning, migrations, deprecations, drift detection