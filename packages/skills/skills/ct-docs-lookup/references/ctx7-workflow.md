# ctx7 Workflow

`ct-docs-lookup` is the CLEO-side wrapper around the `ctx7` CLI. The
underlying contract is set in the user's global rules
(`~/.claude/rules/context7.md`) and the project's `MCP_Context7.md`.
This reference codifies the workflow with concrete examples and
recovery procedures.

## Why Context7

The skill's purpose statement is direct: when the user asks about a
library, framework, or needs code examples, fetch current documentation
instead of relying on training data. Training data is stale — the
project's user rules say so explicitly.

This applies even when you think you know the answer. API surfaces of
React, Next.js, Prisma, Tailwind, Drizzle, Svelte, Supabase, and friends
move faster than any model's cutoff. Verify against current docs.

## The Two-Step Loop

The ctx7 CLI is shipped as `npx ctx7@latest`. The workflow is two calls.

```bash
# Step 1 — resolve the official library ID
npx ctx7@latest library "<library-name>" "<user-question>"

# Step 2 — fetch docs for the resolved ID
npx ctx7@latest docs <libraryId> "<user-question>"
```

The output of Step 1 is a list of candidate library IDs in the form
`/org/project`. Pick the best match (see `library-id-resolution.md` for
the heuristics) and pass it to Step 2.

## Step 1: Library Resolution

Use the official library name with proper punctuation:

| ❌ Wrong | ✅ Correct |
|----------|------------|
| `"nextjs"` | `"Next.js"` |
| `"customerio"` | `"Customer.io"` |
| `"threejs"` | `"Three.js"` |
| `"reactdom"` | `"React DOM"` |
| `"vuejs"` | `"Vue.js"` |
| `"tailwindcss"` | `"Tailwind CSS"` |

The library name matches what the project documents itself as. When
unsure, search the project's GitHub README for the official name.

Pass the user's full question as the second arg — specific queries
return better matches than single words.

```bash
# GOOD
npx ctx7@latest library "Drizzle ORM" "how do I define relations in v1"

# BAD — too generic, ranks poorly
npx ctx7@latest library "drizzle" "relations"
```

## Step 1 Output Interpretation

The CLI returns candidates with several signals — pick by:

1. **Exact name match.** "Next.js" should resolve to `/vercel/next.js`
   over `/some-fork/next.js-clone`.
2. **Source reputation.** Look for High or Medium source labels.
3. **Code snippet count.** More snippets = better-indexed library.
4. **Benchmark score.** Higher is better; reflects retrieval quality.

If the top candidate doesn't match exactly what the user asked for —
e.g., they said "Next.js 15" and the top candidate is generic — try
again with refined terms or version-specific names.

## Step 2: Docs Fetch

Once you have the library ID:

```bash
npx ctx7@latest docs /vercel/next.js "how do I configure middleware to inject auth headers"
```

The output is documentation excerpts with citations. Use these directly
in your answer — they are current, sourced, and citable.

## Version-Specific Docs

When the user names a version, use the version-specific form:

```bash
# General
npx ctx7@latest docs /vercel/next.js "..."

# Pinned to v14.3.0
npx ctx7@latest docs /vercel/next.js/v14.3.0 "..."

# Pinned to v15 (latest 15.x)
npx ctx7@latest docs /vercel/next.js/v15 "..."
```

The Step 1 output enumerates available versions. Pick the version
matching the project's actual installed version (check
`package.json` / `Cargo.toml` / `requirements.txt`).

## Research Mode (Fallback)

If the default fetch doesn't satisfy the question, retry with
`--research`:

```bash
npx ctx7@latest docs /vercel/next.js "..." --research
```

This launches sandboxed agents that git-pull the actual source repos
plus live web search, then synthesizes a fresh answer. More costly
(longer, more tokens), so use only when:

- Default fetch returned a generic answer when specifics were needed.
- The question references a recent change that may not be indexed yet.
- The user explicitly asked for research-grade depth.

## Auth and Quotas

The `ctx7` CLI runs anonymously by default with limited quota. When
quota is exhausted:

```bash
# Error message will be something like:
# Error: Quota exceeded. Run `npx ctx7@latest login` or set CONTEXT7_API_KEY
```

Instruct the user (or surface in `needs_followup`) to either:
- Run `npx ctx7@latest login` (one-time browser auth)
- Set `CONTEXT7_API_KEY` env var with their key

Do NOT silently fall back to training data — that violates the skill's
contract. The whole point is current docs, not stale recall.

## Budget Discipline

The user rules cap the workflow at "no more than 3 commands per
question". For most lookups this is plenty:
- 1 call: library resolution
- 1 call: docs fetch
- 1 call (optional): retry with `--research` if needed

Going over budget signals one of:
- Wrong library name (refine and retry)
- Question too broad (narrow the question first)
- Genuine library mismatch (Context7 doesn't cover this library — use
  web search via WebSearch/WebFetch as alternative)

## Sensitive Data

Never include API keys, passwords, credentials, or internal URLs in
queries. The query is logged on the Context7 side.

```bash
# WRONG
npx ctx7@latest docs /supabase/supabase "use API key sk_live_abc123 to..."

# RIGHT
npx ctx7@latest docs /supabase/supabase "how do I authenticate the client with an API key"
```

## End-to-End Example

```bash
# User asked: "How do I do streaming server actions in Next.js 15?"

# Step 1 — resolve
$ npx ctx7@latest library "Next.js" "How do I do streaming server actions in Next.js 15?"
> /vercel/next.js/v15 (benchmark 0.87, snippets 1240, source: High)
> /vercel/next.js     (benchmark 0.85, snippets 5230, source: High)
> ...

# Step 2 — fetch (use version-pinned ID)
$ npx ctx7@latest docs /vercel/next.js/v15 "How do I do streaming server actions in Next.js 15?"
> [docs excerpt with streaming example, citation]

# Compose answer using the fetched docs, citing version
```

## When NOT to Use This Skill

See `library-id-resolution.md` for the boundary with debugging tasks,
and `version-specific-docs.md` for when the answer doesn't depend on
a specific library. Quick summary:

- ❌ Don't use for refactoring (no library lookup needed)
- ❌ Don't use for scripts written from scratch
- ❌ Don't use for debugging business logic (use codebase tools)
- ❌ Don't use for code review
- ❌ Don't use for general programming concepts
- ✅ Use for API syntax, configuration, version migration, library-specific
  debugging, setup instructions, CLI tool usage
