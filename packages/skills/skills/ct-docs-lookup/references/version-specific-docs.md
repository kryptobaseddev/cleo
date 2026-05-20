# Version-Specific Docs

Library APIs drift across versions — sometimes silently (default value
changes), sometimes loudly (renames, removals). This reference covers
how to lock the docs lookup to the version the user actually runs,
and how to handle migrations and deprecated APIs.

## Why Version Pinning Matters

The cost of citing the wrong version is high.

- Drizzle ORM v1.0.0-beta renamed `relations()` to `defineRelations()`.
  A 0.x user given a v1 example will copy code that doesn't import.
- Next.js 15 changed default `fetch` cache from `force-cache` to
  `no-store`. A user on 14 reading a 15 doc will not see the behavior
  they expect.
- React 19 introduced new hooks. A React 18 user copying a React 19
  example gets `useActionState is not defined`.

In each case, the failure mode is "confidently wrong answer". The
remedy is always: pin to the user's actual version before fetching.

## Finding the User's Version

The skill SHOULD detect the user's installed version before opening
Step 2.

```bash
# Node.js projects
jq -r '.dependencies.next, .devDependencies.next | select(.)' package.json

# Cargo projects
cargo tree -p drizzle 2>/dev/null  # if applicable
grep -A 1 '^drizzle-orm =' Cargo.toml

# Python projects
grep '^next' requirements.txt
pip show next 2>/dev/null | grep '^Version'

# Generic — search for any lockfile entry
grep -A 1 'next:' pnpm-lock.yaml | head -3
```

If detection fails (no lockfile, version not pinned), ask the user
or default to the project's stated version.

## Version Format Matching

Context7 IDs accept several version forms:

```text
/vercel/next.js                    # all versions; unspecified
/vercel/next.js/v15                # latest within v15.x
/vercel/next.js/v15.0.0            # exactly v15.0.0
/vercel/next.js/v15.0.0-canary.7   # specific canary
```

Match the granularity of the user's question:

- General "how do I do X with library" → unversioned or major-pinned.
- Migration "from N to M" → both major-pinned: `/lib/vN` and `/lib/vM`.
- Bug investigation "in 15.0.3 specifically X happens" → exact pin.

## Major-Version Migrations

When the user is upgrading from major N to major N+1, run two fetches.

```bash
# From-version: what works today
npx ctx7@latest docs /drizzle-team/drizzle-orm/v0.36 "how do I define relations"

# To-version: what they will move to
npx ctx7@latest docs /drizzle-team/drizzle-orm/v1.0.0-beta "how do I define relations"

# Compose the migration story:
# 1. Show the current API
# 2. Show the new API
# 3. Show the mapping
```

The migration story has THREE parts. Skipping any of them produces
confusion:

- **Current API.** What the user has now.
- **New API.** What it becomes.
- **Mapping.** Mechanical translation between them.

Documenting only the new API leaves the user wondering "but my code
uses X — what does that become?"

## Deprecated APIs

When a fetched doc mentions an API as deprecated:

1. Surface the deprecation explicitly. Don't bury it.
2. Show the recommended replacement, fetched from the same docs.
3. Cite when deprecation began and when removal is planned (if stated).

Example output:

```markdown
The `relations()` helper in Drizzle ORM 0.x is deprecated as of v1.0.0-beta.
Use `defineRelations` instead.

| Drizzle 0.x | Drizzle 1.x (beta) |
|-------------|--------------------|
| `relations(table, (helpers) => ({ ... }))` | `defineRelations(schema, (t) => ({ ... }))` |

Deprecation announced: v1.0.0-beta (2025-Q4).
Planned removal: TBD (the 0.x line is still supported through 2026).
```

## Version Drift Detection

Run a sanity check before answering — does the user's installed
version match what they think they're using?

```bash
# User says "I'm on Next.js 15".
$ jq -r '.dependencies.next' package.json
"14.3.0"

# Drift! Surface it:
# > Your package.json says Next.js 14.3.0, not 15. Are you planning
# > to upgrade, or did you mean 14? I'll fetch docs for what's
# > installed unless you confirm 15 is the target.
```

This catches the common case where the user's mental model is ahead
of (or behind) their actual install.

## Multi-Library Lookups

A single question may span multiple libraries. Resolve each
independently with the right version pin.

```bash
# Question: "How do I integrate Better-Auth with Drizzle ORM in a
#  Svelte 5 SvelteKit project?"

# Three libraries; resolve each with project's actual version
npx ctx7@latest library "Better-Auth" "..."
npx ctx7@latest library "Drizzle ORM" "..."
npx ctx7@latest library "SvelteKit" "..."

# Then three fetches:
npx ctx7@latest docs /better-auth/better-auth        "integration with drizzle"
npx ctx7@latest docs /drizzle-team/drizzle-orm/v1    "integration with better-auth"
npx ctx7@latest docs /sveltejs/kit/v2                "hooks for auth middleware"
```

Compose the answer from the three. Cite each library's version
explicitly so the user knows what works with what.

## When Versioned Docs Aren't Available

Context7's catalog doesn't always have per-version slices. When a
version pin returns "no matches":

1. Drop one granularity level (e.g., `/v15.0.0-canary.7` → `/v15`).
2. Drop another (`/v15` → `/vercel/next.js` unversioned).
3. Add a note that version-specific data may be missing — recommend
   the user verify against the official release notes.

## Reading Release Notes

When the question is "what changed in version X", release notes are
often a better source than API docs. Two routes:

```bash
# Route 1 — Context7 may have it indexed
npx ctx7@latest docs /vercel/next.js "release notes for v15"

# Route 2 — WebFetch the official release notes page
# (use when Context7 doesn't have release notes specifically)
WebFetch: https://nextjs.org/blog/next-15  "summarize the breaking changes"
```

Release notes are more concise than docs and explicitly call out
deprecations and removals — exactly what migration questions need.

## Citing Versions

Every code example produced from a version-pinned fetch MUST cite the
version.

```markdown
GOOD:
Use `defineRelations` (Drizzle ORM v1.0.0-beta and later):

```typescript
import { defineRelations } from "drizzle-orm";
// ...
```

BAD:
Use `defineRelations`:

```typescript
import { defineRelations } from "drizzle-orm";
// ...
```
(no version context — reader doesn't know if their version supports it)
```

When the user copies the code and it doesn't work, the version citation
is the first thing they check. Give it to them up front.

## Skill Boundary

This reference covers version handling within docs-lookup. It does NOT
cover:

- Migration code generators (out of scope; that's task-executor work).
- Upgrade plan authoring (out of scope; that's spec-writer work).
- Pinning the user's project to a new version (out of scope; that's a
  task for the human or the executor).

Docs-lookup just produces the version-accurate documentation. The
downstream skills act on it.
