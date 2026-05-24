---
name: ct-docs-write
description: This skill should be used when creating, editing, or reviewing documentation files (markdown, MDX, README, guides). Use when the user asks to "write docs", "create documentation", "edit the README", "improve doc clarity", "make docs more readable", "follow the style guide", or "write user-facing content". Applies CLEO's conversational, clear, and user-focused writing style.
version: 1.1.0
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

# Documentation Writing Skill

@skills/_shared/cleo-style-guide.md

## When writing documentation

### Start here

1. **Who is this for?** Match complexity to audience. Don't oversimplify hard things or overcomplicate simple ones.
2. **What do they need?** Get them to the answer fast. Nobody wants to be in docs longer than necessary.
3. **What did you struggle with?** Those common questions you had when learning? Answer them (without literally including the question).

### Writing process

**Draft:**

- Write out the steps/explanation as you'd tell a colleague
- Lead with what to do, then explain why
- Use headings that state your point: "Set SAML before adding users" not "SAML configuration timing"

**Edit:**

- Read aloud. Does it sound like you talking? If it's too formal, simplify.
- Cut anything that doesn't directly help the reader
- Check each paragraph has one clear purpose
- Verify examples actually work (don't give examples that error)

**Polish:**

- Make links descriptive (never "here")
- Backticks only for code/variables, **bold** for UI elements
- American spelling, serial commas
- Keep images minimal and scoped tight

**Format:**

- Run prettier on the file after making edits: `yarn prettier --write <file-path>`
- This ensures consistent formatting across all documentation

### Common patterns

**Instructions:**

```markdown
Run:
\`\`\`
command-to-run
\`\`\`

Then:
\`\`\`
next-command
\`\`\`

This ensures you're getting the latest changes.
```

Not: "(remember to run X before Y...)" buried in a paragraph.

**Headings:**

- "Use environment variables for configuration" ✅
- "Environment variables" ❌ (too vague)
- "How to use environment variables for configuration" ❌ (too wordy)

**Links:**

- "Check out the [SAML documentation](link)" ✅
- "Read the docs [here](link)" ❌

### Watch out for

- Describing tasks as "easy" (you don't know the reader's context)
- Using "we" when talking about CLEO features (use "CLEO" or "it")
- Formal language: "utilize", "reference", "offerings"
- Too peppy: multiple exclamation points
- Burying the action in explanation
- Code examples that don't work
- Numbers that will become outdated

### Quick reference

| Write This                 | Not This           |
| -------------------------- | ------------------ |
| people, companies          | users              |
| summarize                  | aggregate          |
| take a look at             | reference          |
| can't, don't               | cannot, do not     |
| **Filter** button          | \`Filter\` button  |
| Check out [the docs](link) | Click [here](link) |

## The Three Pillars (Why)

CLEO documentation has three principles. Every rule supports one of them.

1. **Conversational.** Read aloud — does it sound like you talking? CLEO docs
   use contractions (don't, can't) where many style guides ban them. The
   contractions are deliberate; they make the writing feel like a colleague
   talking, not a corporate press release.

2. **Clear.** Lead with what to do; explain after. Headings state the point,
   not just the topic. "Configure release pipeline before first ship" beats
   "Configuration" every time.

3. **User-focused.** Say "people" and "companies" — not "users". The user
   construct is for systems; people are the readers. This change is jarring
   the first time, then becomes second nature.

## Forbidden Phrases (Most Common Failures)

These ship to PR, get caught in review, and create rework. Avoid them up
front.

- "easy" / "simple" / "just" — patronizing; you don't know the reader's context
- "obviously" / "of course" — same problem
- "click here" / "read more here" — link text must describe the destination
- "etc." / "and so on" — be specific, or cut the sentence
- "we" referring to CLEO — say "CLEO" or "it"

## Audience-Matching

Match complexity to audience. Mismatch is the biggest style failure.

| Audience | Tone | Code examples | Depth |
|----------|------|---------------|-------|
| End-user | Conversational, second-person | Realistic, copy-paste | Low |
| Agent (LLM) | Dense, structured | Schemas, JSON | Medium |
| Maintainer | Technical, third-person | Code with internals | High |

Declare the audience in frontmatter — `audience: end-user | agent | maintainer`
— so reviewers can apply the right rubric.

## Verb Selection — pick the right writer

`packages/core/src/docs/writer-registry.ts` is the SSoT for "which CLI verb
writes which DocKind". Every `BuiltinDocKind` maps to EXACTLY ONE writer —
the registry rejects multi-writer regressions at build time (T10366 ·
Saga T10288 / Epic T10290). The decision tree:

```text
if kind === 'changeset'  → cleo changeset add --slug <handle> --kind <bump> --summary "..."
elif kind === 'llm-readme'    → tooling-composed (system-managed; do not author by hand)
elif kind === 'release-note'  → cleo release reconcile (system-managed)
else                          → cleo docs add <ownerId> <path> --type <kind> --slug <handle>
```

`cleo changeset add` is the dedicated dual-write verb for `changeset` —
the kind's `canonicalHome` is `ssot-first` in `.cleo/canon.yml`, so the
`.changeset/*.md` file IS part of the contract (it's git-tracked). For
every other human-authored kind (`adr`, `spec`, `research`, `handoff`,
`note`, `plan`, `rcasd`) the canonical verb is `cleo docs add --type <kind>`.

**Migration rule for examples in this guide:** any example that
hand-writes `.changeset/*.md`, `.cleo/adrs/*.md`, `.cleo/research/*.md`,
or `.cleo/agent-outputs/*.md` is OBSOLETE. Update it to use the
registered verb instead. The CI gate `cleo check canon docs` will fail
the PR otherwise (T9796).

## Through SDK (preferred)

CLEO docs are first-class records in the docs SSoT — not loose markdown files.
Always write through `cleo docs add` so the doc gets a slug, a type, an owner,
and a content-addressed blob that downstream consumers can fetch by slug.

### Write a draft attached to a task

```bash
cleo docs add T1234 docs/drafts/saml-setup.md \
  --type note \
  --slug saml-setup-draft \
  --desc "Conversational SAML setup walkthrough — pre-review"
```

- `--type` MUST be one of `spec | adr | research | handoff | note | llm-readme`.
  For user-facing prose use `note`; for end-user docs use `note` or `spec`
  depending on whether the doc carries REQ-XXX requirements.
- `--slug` is the human-friendly handle for retrieval. Use kebab-case. If the
  slug is already taken the CLI returns `E_SLUG_TAKEN` with 3 alternatives —
  pick one rather than overwriting silently.
- The owner ID (`T1234` above) auto-classifies the attachment by prefix:
  `T###` → task, `ses_*` → session, `O-*` → observation.

### Publish to a git-tracked path (when the doc must live on disk)

```bash
cleo docs publish --for T1234 --to docs/saml-setup.md
```

Atomic tmp-then-rename. The published file ships in the next commit; the
SSoT blob remains canonical and continues to track future versions.

### Fetch the doc back by slug

```bash
cleo docs fetch saml-setup-draft       # latest version
cleo docs versions --for T1234         # list every SHA version
```

Slug-based fetch is the contract used by reviewers, downstream skills, and
the docs graph — never grep the filesystem for the file you just wrote.

### List docs by type

```bash
cleo docs list --type note --project   # every note in this project
cleo docs list --task T1234            # everything attached to a task
```

## Deprecated: Direct filesystem

The legacy "write straight to `docs/` and commit" pattern is deprecated.
The drift between the working file and the docs SSoT is real: published
files go stale, types are inferred ad-hoc from path, and slug-based
retrieval becomes impossible. Migrate to `cleo docs add --type X --slug Y`
for every new doc — and use `cleo docs sync --from <path> --for <ownerId>`
to back-fill existing on-disk files into the SSoT.

## Output Location

Documentation blobs live in the docs SSoT; published copies on disk go in
`docs/` for end-user and maintainer content. Agent-facing protocol docs
(skill references, agent-outputs) go in
`packages/skills/skills/<name>/references/` or `.cleo/agent-outputs/`.
Never mix audiences in one location.

## When to Update Instead of Create

The MAINTAIN, DON'T DUPLICATE rule from ct-documentor applies here too.
Before creating any new file:

1. Run `Glob: docs/**/*.md` and `Grep: <topic-keywords> path=docs/` to find
   prior coverage.
2. If a prior page exists, UPDATE that page. Add a section if needed.
3. If multiple prior pages cover the topic in fragments, propose a
   consolidation to the documentor coordinator before writing.
4. Only create a new file when no existing location fits.

The cost of duplicate documentation is paid by every future reader —
they find one page or the other depending on search keywords, and the
two versions inevitably drift.

## Final-Pass Checklist

Before declaring the draft done:

- [ ] All code blocks have explicit language tags (`bash`, `typescript`, not `ts`).
- [ ] All links have descriptive text (no "here", "this").
- [ ] All headings state the point in sentence case.
- [ ] All "users" replaced with "people" or "companies".
- [ ] Contractions present (don't, can't, won't).
- [ ] No "easy", "simple", "just", "obviously" anywhere (including code comments).
- [ ] Frontmatter title and H1 match.
- [ ] Audience declared in frontmatter.
- [ ] Final newline at end of file.

Run grep for the forbidden phrases before completing:

```bash
for word in easy simple just obviously "click here" "read more"; do
  grep -in "$word" <new-file>
done
```

---

## See references/

Progressive disclosure — load on demand only:

- `references/cleo-style-guide.md` — the three pillars, forbidden phrases, format conventions, hidden drift
- `references/markdown-patterns.md` — code-block / table / list / link / callout patterns with positive/negative examples
- `references/audience-targeting.md` — end-user / agent / maintainer profiles, mixed-audience pitfalls, re-targeting