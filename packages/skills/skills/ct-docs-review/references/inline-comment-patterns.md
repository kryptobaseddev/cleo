# Inline Comment Patterns

How to construct individual review comments that are concrete,
actionable, and respectful. Each pattern below covers a common
review situation with a template and a worked example.

## Anatomy of a Good Comment

A review comment has four parts:

1. **Title line.** `**Issue N: [Brief title]**` — always.
2. **Location.** Line number or "throughout the file".
3. **Description.** What's wrong, one sentence.
4. **Suggestion.** Concrete fix, copy-paste-ready when possible.

Skipping any part degrades the comment. Skipping the title makes
issues unfindable; skipping location makes the fix scope unclear;
skipping description makes the rule arbitrary; skipping suggestion
makes the comment unactionable.

## Pattern: Single-Line Fix

When the fix is a one-line replacement, use the GitHub `suggestion`
block.

````text
**Issue 1: Missing contraction**

Line 15: CLEO docs use contractions. Change "cannot" to "can't".

```suggestion
You can't run this command on a dirty tree.
```
````

The suggestion block renders as a one-click "Commit suggestion"
button. Author applies it without leaving the PR view.

## Pattern: Multi-Line Fix

When the fix spans multiple lines, use a diff fence.

````text
**Issue 2: Buried lead**

Lines 14-18: The action is buried in the third sentence. Lead with it.

Suggested fix:

```diff
-Configuration files in CLEO support various format options including
-JSON, YAML, and TOML. When choosing a format, consider readability,
-merge-conflict friendliness, and editor support. Use JSON for the
-primary config file because it's the project default.
+Use JSON for the primary CLEO config file (the project default).
+CLEO also supports YAML and TOML if your team prefers them.
```
````

The diff fence shows before and after side-by-side. No one-click apply,
but the structure is clear.

## Pattern: Pattern Issue (Throughout File)

When the same issue appears in multiple places, flag once with
representative examples — not once per occurrence.

```text
**Issue 4: "Users" instead of "people"**

The word "users" appears throughout the file (lines 8, 14, 22, 37, 51,
68). CLEO docs say "people" or "companies".

Examples to fix:
- Line 8: "users can configure" → "people can configure"
- Line 22: "our users expect" → "our customers expect"
- Line 51: "user input" → "what people type"

Apply the same pattern to remaining instances.
```

This compresses a 6-comment flood into a 1-comment summary. The author
gets the message without scrolling through duplicates.

## Pattern: Question (Clarification Needed)

Sometimes the issue is "I don't understand the intent". Phrase as a
question, not a demand.

```text
**Issue 5: Ambiguous step**

Line 33: "Configure the cache before deployment."

The step doesn't say HOW to configure the cache or WHERE to deploy.
Is this the production cache or the dev cache? Should it reference
the `cacheTimeout` config or the `cacheStore` setting?

Suggested expansion:
"Set `cacheTimeout` to 30000 (30s) in `cleo.config.json` before
deploying to production."
```

Questions are respectful — they assume the author had a reason and
you're inviting them to make it visible.

## Pattern: Code-Example Failure

When a code example wouldn't run, show the error.

````text
**Issue 6: Code example doesn't compile**

Lines 42-46: The TypeScript example imports `defineRelations` from
`drizzle-orm`, but the function isn't exported from the top-level
package in v0.x — it's in `drizzle-orm/relations`.

Tested:
```bash
$ npx tsc --noEmit example.ts
example.ts:1:10 - error TS2305: Module '"drizzle-orm"' has no
exported member 'defineRelations'.
```

Either:
- Import from the subpath: `import { defineRelations } from "drizzle-orm/relations";`
- Or cite the version that has the top-level export (v1.0.0-beta and later)
````

The error excerpt gives the author proof. Without it, the author may
push back ("works on my machine"); with it, the issue is unambiguous.

## Pattern: Style Choice with Rationale

When flagging style violations, cite the rule. Don't enforce personal
preference disguised as style.

```text
**Issue 7: Formal language**

Line 27 uses "utilize" — too formal for CLEO docs. Use "use".

Source: CLEO style guide §Conversational Pillar — "utilize" is on
the avoid-list because it's just "use" wearing a suit.

```suggestion
Use the orchestrator to dispatch wave 3.
```
```

The source line lets the author verify the rule. Without it, the
flag feels arbitrary.

## Pattern: Praise (Sometimes)

When the doc does something particularly well, a short positive note
can be valuable feedback. Keep them sparse — too much praise reads as
performative.

```text
**Issue 8 (note, not a fix): Excellent structure**

The migration table at lines 60-75 is exactly the right pattern for
a v0.x → v1.x guide — current API, new API, mapping. Consider
extracting this table format into a shared template for future
migration docs.
```

Note: even praise gets a number — sequential numbering throughout.

## Anti-Patterns

### "This is wrong" (no fix)

```text
BAD:
**Issue 9: Wrong**
Line 22 is wrong.
```

No location specificity, no description, no fix. Useless.

### "Maybe consider perhaps"

```text
BAD:
**Issue 10: Possibly an issue**
Line 33: This might be slightly suboptimal, maybe consider...
```

Hedging tells the author you don't trust your own judgment. Either
flag it confidently or skip it.

### "Bikeshedding"

```text
BAD:
**Issue 11: Two spaces**
Line 18 has two spaces after the period — CLEO docs use one.
```

If the rule isn't material to readers, don't flag it. Whitespace
between sentences is invisible in rendered markdown.

### "Personal preference disguised as rule"

```text
BAD:
**Issue 12: I'd write this differently**
Line 41 isn't how I'd phrase it — I'd say...
```

Style preference is not a rule. Either it's in the style guide (cite
it) or it's not (skip the flag).

### "Compound issue"

```text
BAD:
**Issue 13: Multiple problems**
Line 22 has formal tone, a vague heading, and a missing serial comma.
Also lines 30-35 have user-construct issues.
```

Split into separate numbered issues. The author may want to fix one
but not the others; combined flags can't be resolved partially.

## Length Discipline

Keep each comment short. 3-6 lines for the description; 3-10 lines
for the suggestion block.

Long comments lose the author. If the explanation needs 20 lines, you
might be over-explaining — trust the author to understand the rule
after the suggestion.

## Tone

Comments are feedback, not judgment. Aim for:

- **Specific** — "line 22 uses X" not "the writing feels wrong"
- **Concrete** — show the fix, don't describe it
- **Respectful** — assume the author had a reason; don't assume bad faith
- **Time-respecting** — short over long; one issue per comment

## Comment Lifecycle

After the author addresses feedback, the comment can be:

- **Resolved** — author marks the conversation resolved when fixed
- **Unresolved** — left as historical record if not addressed
- **Updated** — reviewer adds follow-up after author's fix

The skill doesn't need to track resolution — that's GitHub's job. But
when re-reviewing, scan unresolved threads to see what's still pending.

## Cross-Reference to Other Comments

When two issues are related, reference the prior issue's number:

```text
**Issue 14: Related to Issue 3**

Line 47 has the same "users" problem as Issue 3. Apply the same fix
here too.
```

This compresses the review and shows the author the pattern.
