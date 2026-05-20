# Style Violations

The taxonomy of style violations that ct-docs-review catches. Each
violation type carries a detection pattern, an issue title format,
and a remediation message. The numbering scheme below (V-NNN) is
informational — issues in reviews are numbered sequentially per
review, not by global ID.

## Violation Categories

| Category | Examples | Severity |
|----------|----------|----------|
| Forbidden phrases | "easy", "simple", "just", "click here" | High |
| Tone and voice | "we" referring to CLEO, formal language | Medium |
| Structure | Buried lead, vague heading, no clear purpose | Medium |
| Links | Bare-word links, link-in-heading | High |
| Formatting | Missing language tag, full-width screenshot | Low |
| Code examples | Don't run, out of order | High |
| Sentence construction | Pronoun overuse, missing serial comma | Low |

Severity drives prioritization but not categorical filtering — review
flags everything worth fixing. The final filter is the materiality
test: "would fixing this make a meaningful difference to the reader?"

## Forbidden Phrases

The hardest-to-shake violations. They sneak into drafts because they
feel natural — and they're banned because they're patronizing.

### "easy" / "simple" / "just"

**Detection pattern.**

```bash
grep -inE '\b(easy|simple|just|easily|simply)\b' <file>
```

**Issue title.** `Patronizing qualifier: "<word>"`

**Remediation message.**

> Line X uses "<word>" — this assumes the reader's context. Remove it
> and let the steps speak for themselves.

**Examples.**

| Before | After |
|--------|-------|
| Setting up SAML is easy. | Set up SAML by following these steps. |
| Just run `cleo init`. | Run `cleo init`. |
| The CLI makes this simple. | Use the CLI: `cleo verify`. |

### "obviously" / "of course"

**Detection pattern.**

```bash
grep -inE '\b(obviously|of course|clearly|naturally)\b' <file>
```

**Issue title.** `Condescending qualifier: "<word>"`

**Remediation message.**

> Line X uses "<word>" — patronizing the reader. If it's truly obvious,
> the doc doesn't need to say so; if it's not, calling it obvious feels
> condescending.

### "click here" / "read more here"

**Detection pattern.**

```bash
grep -inE '\[(click here|here|read more here|this|more info)\]\(' <file>
```

**Issue title.** `Non-descriptive link text: "<text>"`

**Remediation message.**

> Line X uses "<text>" as the link text. Link text MUST describe the
> destination. Replace with descriptive text such as
> "the [SAML configuration guide]".

### "etc." / "and so on"

**Detection pattern.**

```bash
grep -inE '\b(etc\.|and so on|and more)\b' <file>
```

**Issue title.** `Trailing list: "<phrase>"`

**Remediation message.**

> Line X ends a list with "<phrase>" — this signals incomplete thinking.
> Either enumerate the items completely, or restate the sentence
> without the trailing phrase.

## Tone and Voice Violations

### "we" referring to CLEO

**Detection pattern.**

```bash
# Tricky — "we" + verb usually means CLEO
grep -inE '\bwe (will|can|use|do|have|are|provide|deliver|run|build|deploy)' <file>
```

**Issue title.** `First-person plural referring to CLEO`

**Remediation message.**

> Line X uses "we" — when talking about CLEO features, say "CLEO" or
> "it". "We" is for the human team; "CLEO" is for the system.

### Formal language

**Detection pattern.**

```bash
grep -inE '\b(utilize|leverage|reference|offerings|provisions|delineate)\b' <file>
```

**Issue title.** `Formal/corporate language: "<word>"`

**Remediation message.**

> Line X uses "<word>" — too formal. Use the everyday word: "<replacement>".

| Formal | Everyday |
|--------|----------|
| utilize | use |
| leverage | use |
| reference (verb) | see, look at |
| offerings | products, features |
| provisions | settings |
| delineate | describe, list |

### Missing contractions

**Detection pattern.**

```bash
grep -inE '\b(cannot|do not|will not|is not|are not|does not|did not)\b' <file>
```

**Issue title.** `Missing contraction: "<phrase>"`

**Remediation message.**

> Line X uses "<phrase>" — CLEO docs USE contractions. Change to
> "<contracted form>" for the conversational tone.

This is the one rule that surprises writers most often. CLEO is opposite
to many style guides on this point.

### "users" instead of "people"

**Detection pattern.**

```bash
# Standalone "users" — careful not to match "end-users" or "user-agent"
grep -inE '(?<!end-)\busers?\b(?!-)' <file>
```

**Issue title.** `User-construct instead of human: "<word>"`

**Remediation message.**

> Line X uses "<word>" — CLEO docs say "people" or "companies", not
> "users". "User" is a system construct; "people" centers the human.

Note: compound terms keep "user" — "end-user", "user-agent", "user-space".

## Structure Violations

### Buried lead

**Detection pattern.** (Manual — no regex.)

Read the first paragraph of each section. Does the action / definition
appear in the first sentence? If not, the lead is buried.

**Issue title.** `Buried lead in §<section>`

**Remediation message.**

> The action / definition is not stated until line X. Lead with it.
> Move the explanation after.

### Vague heading

**Detection pattern.** (Manual — needs semantic reading.)

Read each heading. Does it state the point or just the topic?

| Vague | Specific |
|-------|----------|
| Configuration | Configure release pipeline before first ship |
| Authentication | Authenticate with API tokens |
| Notes | Use environment variables for secrets |
| Setup | Install dependencies and run init |
| Performance | Set timeout to 30s on slow networks |

**Issue title.** `Vague heading: "<heading>"`

**Remediation message.**

> Heading "<heading>" doesn't tell the reader what the section is for.
> State the action or claim: e.g., "<specific replacement>".

### Paragraph without purpose

**Detection pattern.** (Manual.)

For each paragraph, ask "what does this contribute?" If the answer is
"none — it restates the previous paragraph or sets up the next one
without adding information", flag it.

**Issue title.** `Paragraph without clear purpose at line X`

**Remediation message.**

> The paragraph at line X restates / sets up without adding new
> information. Cut it or merge with adjacent content.

## Link Violations

### Link in heading

**Detection pattern.**

```bash
grep -inE '^#+ .*\[.*\]\(' <file>
```

**Issue title.** `Link inside heading: "<heading>"`

**Remediation message.**

> Line X has a link inside the heading. Headings should be plain text;
> move the link to the body. Exception: if the entire heading is the
> link (no surrounding text), it's allowed.

### Ampersands

**Detection pattern.**

```bash
grep -inE ' & ' <file>
```

**Issue title.** `Ampersand instead of "and"`

**Remediation message.**

> Line X uses "&" — spell out "and" unless the ampersand is part of a
> proper noun (e.g., "AT&T").

## Formatting Violations

### Missing language tag

**Detection pattern.**

```bash
# Find fenced blocks with no language tag
grep -inP '^```$' <file>
```

**Issue title.** `Code block without language tag`

**Remediation message.**

> Code block at line X has no language tag. Add `bash`, `typescript`,
> `python`, `json`, etc., for syntax highlighting.

### Abbreviated language tag

**Detection pattern.**

```bash
grep -inE '^```(ts|js|py|rs|md)\s*$' <file>
```

**Issue title.** `Abbreviated language tag: "<tag>"`

**Remediation message.**

> Code block at line X uses "<tag>" — use the full name. Mapping:
> ts → typescript, js → javascript, py → python, rs → rust,
> md → markdown.

## Code Example Violations

### Example doesn't run

**Detection pattern.** (Manual + tool.)

For TypeScript/JavaScript/Python code blocks that contain runnable
snippets, attempt to dry-run them (TS: `tsc --noEmit`; Python: `python
-c`). For shell snippets, sanity-check the syntax.

**Issue title.** `Example at line X doesn't compile / run`

**Remediation message.**

> The code at line X has <error>. Either fix the example to compile/run,
> or mark it as pseudocode with a comment.

### Commands out of order

**Detection pattern.** (Manual.)

In a sequence of shell commands, check that each command's
prerequisites are stated before it.

**Issue title.** `Commands out of dependency order at line X`

**Remediation message.**

> Command at line X depends on output of command at line Y, but appears
> before it. Reorder, or split into separate code blocks with prose
> between.

## Materiality Filter

After collecting all detected violations, apply the materiality filter:
"Would fixing this make a meaningful difference to the reader?"

- High-severity violations always pass the filter.
- Medium-severity: pass if the doc is end-user-facing or the violation
  appears in a prominent location (heading, intro, summary).
- Low-severity: pass if there are several together (signals a quality
  problem); otherwise SKIP.

Flag only what passes the filter. A flood of low-severity flags
overwhelms the reviewer — be selective.
