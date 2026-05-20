# Library ID Resolution

The Context7 library catalog uses `/org/project` IDs. Picking the right
ID is the difference between fetching authoritative docs and fetching
a community fork's stale README. This reference codifies the
disambiguation heuristics with concrete examples.

## ID Anatomy

```
/vercel/next.js
└org─┘ └proj─┘

/vercel/next.js/v14.3.0
└org─┘ └proj─┘ └version┘
```

- The `org` is typically the GitHub org or the company name.
- The `project` is the official package name.
- The optional `version` is a tag or release branch.

## Resolution Output Format

A typical Step 1 (`ctx7 library`) output:

```text
Top matches for "Next.js" against query "configure middleware":

1. /vercel/next.js
   - Source: High
   - Description: The React Framework for the Web.
   - Code snippets: 5230
   - Benchmark: 0.85

2. /vercel/next.js/v15
   - Source: High
   - Description: Next.js v15 release line.
   - Code snippets: 1240
   - Benchmark: 0.87

3. /community/next-with-foo
   - Source: Medium
   - Description: Next.js + Foo starter template.
   - Code snippets: 87
   - Benchmark: 0.42

4. /old-org/nextjs-legacy
   - Source: Low
   - Description: Pre-app-router Next.js patterns.
   - Code snippets: 412
   - Benchmark: 0.39
```

Five signals to weigh.

## Signal 1: Exact Name Match

The user said "Next.js". Candidates 1 and 2 are exact matches; 3 is
"next-with-foo" (a derivative); 4 is "nextjs-legacy" (suffixed).

Prefer the canonical name. The derivative or suffixed projects are
appropriate ONLY when the user explicitly named them.

## Signal 2: Source Reputation

`High` > `Medium` > `Low`. Source reputation reflects how authoritative
Context7 considers the project. Official org-owned repos are High.
Community forks are typically Medium. Abandoned or low-quality projects
are Low.

When multiple High candidates exist, look further. When the only
High candidate is the obvious one, pick it.

## Signal 3: Code Snippet Count

More snippets = better-indexed library = higher chance of finding the
exact API the user asked about. The unversioned ID usually has higher
snippet counts than version-pinned IDs because it aggregates across
versions.

For general questions, prefer unversioned IDs. For version-specific
questions, accept the lower snippet count of the pinned ID.

## Signal 4: Benchmark Score

The benchmark is a retrieval-quality measure produced by Context7 —
higher means the candidate library has good documentation that
indexes well. Use as a tiebreaker only.

In the example above, candidate 2 has a slightly higher benchmark
(0.87) than candidate 1 (0.85) because v15-specific queries score
better against the pinned slice. For a v15-specific question, prefer
candidate 2.

## Signal 5: Query Alignment

The user's query in Step 1 affects ranking. If the query mentioned
"middleware", candidates whose docs cover middleware will rank higher.
This is why passing the FULL user question (not a single word) yields
better resolution.

## Common Pitfalls

### Pitfall: Picking the version-pinned ID for a general question

The user asked "What does Next.js do?" — a general question.

- ❌ Pick `/vercel/next.js/v15` — too narrow; misses cross-version context.
- ✅ Pick `/vercel/next.js` — covers the whole project.

### Pitfall: Picking the unversioned ID for a version-specific question

The user asked "How do I migrate from Next.js 14 to 15?"

- ❌ Pick `/vercel/next.js` — might return mixed-version docs.
- ✅ Pick `/vercel/next.js/v15` — gets the migration guide for 15.
- ✅ Better: pick `/vercel/next.js/v15` for "to" and `/vercel/next.js/v14`
  for "from", and run two fetches.

### Pitfall: Picking the community fork when the user wants the official

The user asked "How do I use Tailwind utilities?"

- ❌ Pick `/some-community/tailwind-with-extras` — not what they meant.
- ✅ Pick `/tailwindlabs/tailwindcss` — the official.

Community forks rank LOW on the "what user meant" axis even when they
rank high on other signals. Default to the official.

### Pitfall: Picking the highest snippet count regardless of relevance

The user asked about Vue 3 composition API.

- ❌ Pick `/vuejs/vue` (high snippet count, but it's the Vue 2 line).
- ✅ Pick `/vuejs/core` or `/vuejs/vue-next` (Vue 3).

Always read the description, not just the count. Old projects accumulate
snippets because they've been around longer — they may no longer be
current.

## Disambiguation Procedure

When two candidates look equally good:

1. **Read the descriptions.** They usually disambiguate.
2. **Check the org.** Official org = the project's home; community
   org = derivative.
3. **Check the project's GitHub URL** if Context7 includes it. The URL
   matches what the project's README cites.
4. **Try both.** Compare the outputs of Step 2 for each candidate. The
   one that better answers the question is the right one.

## When Resolution Fails

Sometimes Step 1 returns no good match. The library may not be in
Context7's catalog, or the name was wrong. Recovery:

```bash
# Retry with the formal name from the project's GitHub
npx ctx7@latest library "TanStack Query" "..."   # not "react-query"

# Retry with the alternative spelling
npx ctx7@latest library "GitHub Actions" "..."   # not "gh-actions"

# Retry with a more specific query
npx ctx7@latest library "Next.js" "App Router middleware in v15"

# If all retries fail, fall back to WebSearch / WebFetch
# (but tell the user the library isn't in Context7's catalog)
```

## Version Resolution Specifics

When a project has many versions, Step 1's output lists them. Pick by:

1. **Match the project's installed version.** Check `package.json`,
   `Cargo.toml`, `requirements.txt`, etc.
2. **If the user named a version, use that.**
3. **If neither, use the latest stable (highest version number that
   isn't pre-release).**

```bash
# Project installed Next.js 14.3.x
$ jq '.dependencies.next' package.json
"14.3.0"

# Use the pinned version
npx ctx7@latest docs /vercel/next.js/v14.3.0 "..."
```

This catches the case where the user asks about behavior that differs
between versions; using the wrong version pin gives a confidently
wrong answer.

## Caching

Library IDs rarely change. If you resolved `/vercel/next.js/v15` for
one query, you can re-use it for the next query about the same library
without running Step 1 again. Just remember to refresh the resolution
when:

- Asking about a different major version.
- The project's installed version changed.
- The previous fetch didn't satisfy the question (maybe the wrong ID
  was picked).

## When NOT to Use Library Lookup

The user rules are explicit: not for refactoring, scripts-from-scratch,
business-logic debugging, code review, or general programming concepts.

If the question is "how do I structure my repository?" — that is a
general programming question. Use general knowledge plus codebase
inspection, not Context7.

If the question is "how does Next.js's app router handle parallel
routes?" — that is a library API question. Use Context7.
