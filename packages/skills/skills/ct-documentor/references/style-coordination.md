# Style Coordination

The CLEO documentation style guide lives at
`packages/skills/skills/_shared/cleo-style-guide.md` and is referenced
by both `ct-docs-write` and `ct-docs-review`. As coordinator, the
documentor's role is to ensure the style guide is enforced consistently
across the chain — write applies it; review verifies it. This reference
covers the parts of the style guide most commonly violated and how the
documentor enforces them.

## Tone Pillars

The CLEO style is **conversational, clear, user-focused**. Three pillars
the documentor must enforce across the chain.

### 1. Conversational

Write the way you would explain to a colleague — not the way a corporate
press release would. This shows up at the word level.

| Avoid | Prefer |
|-------|--------|
| utilize | use |
| reference | see / look at |
| offerings | products / features |
| we will / we can | CLEO does / CLEO can |
| cannot, do not | can't, don't |
| people are able to | people can |

The contraction rule is real and unusual — CLEO docs USE contractions.
Many style guides ban them; CLEO does the opposite.

### 2. Clear

Lead with the action; explain after. Headings state the point.

| Vague heading | Clear heading |
|---------------|---------------|
| "Environment variables" | "Use environment variables for configuration" |
| "Authentication" | "Authenticate with API tokens" |
| "Configuration" | "Configure release pipeline before first ship" |
| "Performance considerations" | "Set timeout to 30s on slow networks" |

Vague headings force the reader to scan the body to learn the point.
Clear headings let the reader skip the section if it's not what they
need.

### 3. User-Focused

Use "people" or "companies", not "users". The first refers to humans;
the second to a system construct. The CLEO docs are for humans.

| Avoid | Prefer |
|-------|--------|
| users can | people can |
| our users | our customers / the companies using CLEO |
| user input | what people type |
| user experience | what people see |

This is jarring at first — many docs are full of "users". Once you
switch, the writing reads more concretely.

## Forbidden Phrases

These never appear in CLEO docs. The review child rejects them on sight.

- "easy" / "simple" / "just" — patronizing; the reader doesn't know if
  it's easy until they try
- "obviously" / "of course" — same problem
- "for free" / "out of the box" — vague
- "click here" / "read more here" — link text must be descriptive
- "and so on" / "etc." — be specific or cut the sentence
- "as mentioned above" — use a stable cross-reference

The forbidden list is the most common reason a draft fails review.
Pass the list to ct-docs-write as part of the input contract so it
knows what to avoid.

## Link Discipline

Link text must describe the destination. Never link bare words like
"here", "this", "read more".

```markdown
GOOD: See the [release pipeline ADR](../.cleo/adrs/ADR-065.md) for the gate set.

BAD: See ADR-065 [here](../.cleo/adrs/ADR-065.md) for the gate set.

BAD: For more info, [click here](../.cleo/adrs/ADR-065.md).
```

The full link text MUST make sense out of context — a reader scanning
just the link list should understand each destination.

## Code Block Discipline

Code blocks include their language tag for syntax highlighting and
their working-directory context.

````markdown
GOOD:
```bash
# In the project root
pnpm run test
```

GOOD:
```typescript
// packages/cleo/src/foo.ts
import { bar } from "@cleocode/contracts";
```

BAD:
```
pnpm run test
```
(no language tag)

BAD:
```ts
import { bar } from "@cleocode/contracts";
```
(use `typescript`, not `ts`)
````

The full language tags are `bash`, `typescript`, `tsx`, `python`,
`rust`, `json`, `yaml`, `markdown`. Avoid abbreviations.

## Table Discipline

Tables compress information that would otherwise sprawl. Use them
liberally — they signal "look up data" mode.

| Use a table when... | Don't use when... |
|---------------------|-------------------|
| You have parallel structured items | You have unstructured prose |
| Each row has the same columns | Each "row" has different fields |
| The reader will scan, not read | The reader needs narrative |

Keep tables narrow — three to five columns is the sweet spot. Wider
tables overflow on mobile and look like data dumps.

## Image Discipline

Images are scoped — they show one specific UI element with relevant
context. They never show full-window screenshots.

| Scope | When to use |
|-------|-------------|
| UI element + label | Annotating a feature |
| Specific dialog | Showing a flow step |
| Code in editor | Showing syntax highlighting |
| Whole window | Almost never |

Add alt text that describes what the image conveys, not what the image
is of. "Screenshot of the release pipeline dashboard showing three
green checks" rather than "Dashboard screenshot".

## Cross-Skill Drift Detection

Documentor MUST check that write's output and review's checks agree.
If they disagree, the style guide reference is the tiebreaker.

```text
write_output = ct-docs-write(input)
review_findings = ct-docs-review(write_output)

# Possible drift case:
# write produced "users" (it should have used "people")
# review didn't flag it (its rule list was outdated)
# → file a sync task; passing the style guide explicitly to write
#   on next iteration

# Possible drift case:
# write produced "click here"
# review flagged "click here" with high confidence
# → no drift; write just made a mistake; iterate
```

When drift is detected, surface it in `needs_followup` so the next
session updates the shared style guide or the child skill's rules.

## Pre-PR Style Pass

Before opening a PR with documentation changes, the documentor MUST
run review one more time on the diff:

```bash
# Review the diff for style violations
gh pr diff <PR_NUMBER> | ct-docs-review --mode=diff
```

PR-mode review uses the `mcp__github__*` tools when available;
otherwise local mode is fine. The pre-PR pass catches drift that
sneaked in during integration.
