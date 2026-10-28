---
id: docs-kinds-and-naming-rule
tasks: [T14107]
kind: feat
summary: "One canonical docs category set and a naming rule - no task id, session id or date in a doc name"
---

Owner decision D11210 ("docs never rot"). Each doc kind now publishes to
exactly one directory, under its singular name. The plural twins (specs,
plans, handoffs, migrations) merge into their singular kinds. New kinds cover
the user docs that had no kind: `guide` (how-to), `concept` (explanation),
`reference`, and `migration`. Handoffs become store-only and are never
published.

A doc is named by its subject: lowercase kebab-case, at most 64 characters,
with no task id, session id or date in the name. Task and decision links and
dates go in the doc's metadata. An ADR keeps its number and a release note
keeps its version.

How the rule is enforced:
- `cleo docs add` refuses a slug that breaks the rule (`E_DOC_NAME_RULE`) and
  suggests a valid one.
- `cleo check canon docs` refuses any tracked `docs/**.md` whose name breaks
  the rule, and names the `git mv` that fixes it.
- Names that broke the rule before it existed sit in
  `scripts/.docs-name-baseline.json`. That list only shrinks: the docs census
  removes each entry as it renames the doc.
