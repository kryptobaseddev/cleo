# CLEO Style Guide

The canonical style guide lives at
`packages/skills/skills/_shared/cleo-style-guide.md` and is consumed
by both ct-docs-write and ct-docs-review. This reference makes the
guide's most-violated rules concrete with positive/negative examples
and the rationale for each.

## The Three Pillars

CLEO documentation is **conversational, clear, and user-focused**.
Every other rule supports one of these three. When in doubt, ask:
"would I say this to a colleague in a chat?"

### Pillar 1: Conversational

Write the way you talk to a colleague — not the way a corporate press
release would. The contraction rule is the most distinctive marker.

CLEO USES contractions. Many style guides ban them; CLEO does the
opposite. "Don't" reads more like a colleague than "do not".

| Avoid | Prefer | Why |
|-------|--------|-----|
| utilize | use | "utilize" is just "use" wearing a suit |
| reference (verb) | see, look at | "reference" makes things sound bureaucratic |
| offerings | products, features | "offerings" sounds like a press release |
| we will use HTTPS | use HTTPS | imperative > first-person future |
| cannot, do not | can't, don't | contractions read more conversationally |
| it is recommended that | use | passive recommendation = no recommendation |

### Pillar 2: Clear

Lead with what to do. Explain after. Bury nothing.

Headings state the point. Vague headings make the reader scan the body
to learn whether to read it.

| Vague heading | Clear heading |
|---------------|---------------|
| Configuration | Configure release pipeline before first ship |
| Authentication | Authenticate with API tokens |
| Performance | Set timeout to 30s on slow networks |
| Common issues | Solve E_VALIDATION errors |
| Setup | Install dependencies and run init |
| Notes | Use environment variables for secrets |

The pattern: action verb + object + (qualifier). Vague nouns alone
fail the test.

### Pillar 3: User-Focused

CLEO docs say "people" and "companies", not "users". This is jarring
the first time you switch; once you do, the writing reads more
concrete.

| Avoid | Prefer |
|-------|--------|
| users can | people can |
| our users | our customers, or "the companies using CLEO" |
| user input | what people type |
| user experience | what people see |
| end-user | (the same — only when "user" is part of a compound) |

The exception: when "user" is part of a compound technical term
("end-user", "user-agent", "user-space"), it stays. Only the standalone
"user" gets replaced.

## Forbidden Phrases

These never appear in CLEO docs. The review skill rejects them on sight.

### "easy" / "simple" / "just"

These words assume you know the reader's context — and you don't. What
is easy for you may be intimidating for them. Removing these words
costs nothing and makes the doc respectful.

| Bad | Good |
|-----|------|
| Setting up SAML is easy. Just follow these steps. | Set up SAML with these steps. |
| It's simple to configure the cache. | Configure the cache by setting `cacheTimeout`. |
| You can just import the helper. | Import the helper from `@cleocode/contracts`. |

### "obviously" / "of course"

Same problem as "easy" — they patronize the reader. If something is
obvious, it doesn't need to be said. If it's not, calling it obvious
makes the reader feel stupid.

### "click here" / "read more here"

Link text must describe the destination. The naked words "here" or
"this" tell the reader nothing about where the link goes.

| Bad | Good |
|-----|------|
| Click [here](url) to learn about SAML. | See the [SAML configuration guide](url). |
| For more info, [read this](url). | Read the [release pipeline ADR](url). |
| You can [download it here](url). | Download [the CLEO CLI binary](url). |

### "etc." / "and so on"

Be specific or cut the sentence. Trailing-off phrases signal you
didn't finish thinking.

| Bad | Good |
|-----|------|
| Use environment variables, config files, etc. | Use environment variables or config files. |
| You can run tests, lint, format, and so on. | Run lint, format, build, then tests. |

### "we" (when referring to CLEO)

When talking about CLEO features, say "CLEO" or "it" — not "we".
"We" is for the human team, not the system.

| Bad | Good |
|-----|------|
| We use a per-skill token budget. | CLEO uses a per-skill token budget. |
| We will deprecate this in 2026-Q3. | This feature is deprecated as of 2026-Q3. |
| Our orchestrator manages... | The orchestrator manages... |

## Code Block Discipline

Code blocks always have a language tag.

````markdown
GOOD:
```bash
pnpm run test
```

GOOD:
```typescript
import { foo } from "@cleocode/contracts";
```

BAD (no tag):
```
pnpm run test
```

BAD (abbreviated tag):
```ts
import { foo } from "@cleocode/contracts";
```
````

Use full names: `bash`, `typescript`, `tsx`, `python`, `rust`, `json`,
`yaml`, `markdown`. Avoid `js`, `ts`, `py`, `rs`.

When the command depends on a working directory or other context, say
so in a comment within the block:

````markdown
```bash
# In the project root
pnpm run test
```

```typescript
// packages/cleo/src/foo.ts
import { bar } from "@cleocode/contracts";
```
````

## Format Conventions

| Element | Convention |
|---------|-----------|
| **Bold** | UI element names: "Click the **Submit** button" |
| `Code` | Code symbols, variables, commands, filenames |
| _Italic_ | New terms (on first mention) only |
| `[link text](url)` | Descriptive link text always |
| Numbered list | When order matters |
| Bulleted list | When items are peers |
| Table | When items have parallel structure |
| Heading | State the point, not the topic |

### Spelling and Punctuation

- **American spelling.** "color" not "colour", "behavior" not "behaviour".
- **Serial commas.** "a, b, and c" with the comma before "and".
- **One space after periods.** Not two.
- **Em dashes.** Use `—` (em dash) for parenthetical breaks. Not `--` or
  ` - ` with surrounding spaces.
- **Quote marks.** Straight (`"`) in code; curly (`"`) in prose (your
  editor handles this).

## Audience-Matching

Match complexity to audience. The biggest stylistic failure is mismatch.

| Audience | Tone | Code examples | Conceptual depth |
|----------|------|---------------|------------------|
| End-user (using CLEO) | Conversational, practical | Realistic, copy-paste | Low — they want to ship |
| Agent (LLM consuming docs) | Dense, structured | Schemas, JSON | Medium — context-economical |
| Maintainer (contributing) | Technical, precise | Code with internals | High — internal architecture |

End-user docs say "Run `cleo show T123` to see the task." Maintainer
docs say "The `cleo show` handler dispatches via `dispatch.ts:107`
through the LAFS envelope wrapper at `packages/cleo/src/dispatch.ts`."

## Headings: One Pattern

Use sentence case (only the first word and proper nouns capitalized).

| Bad | Good |
|-----|------|
| # How To Configure The Release Pipeline | # How to configure the release pipeline |
| ## Common Issues With Authentication | ## Common issues with authentication |
| ### Pre-Flight Checks | ### Pre-flight checks |

Exception: ADRs use title case for their title because they are formal
documents — but their internal headings use sentence case.

## Hidden Drift

These violations sneak through review most often:

1. "easy"/"simple" inside code comments (review may skip code blocks)
2. "users" in alt text on images
3. Title case headings in newly-added sections of an otherwise
   sentence-case doc
4. Trailing "etc." inside a longer list
5. "we" in the description field of frontmatter

Run grep before declaring done:

```bash
for word in easy simple just obviously "click here" "read more"; do
  grep -in "$word" <new-file>
done
```
