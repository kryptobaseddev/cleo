---
id: durability-pr-ledger
tasks: [T14247]
kind: feat
summary: "Durability PRs carry a machine-readable ledger: every exception they add names the rule it deletes, checked on the PR body"
---

SG-CLEO-DURABILITY replaces rules with models, so each durability PR now lists
what it adds and deletes in one grammar, which `cleo doctor durability` and the
per-engine caps can read. A `Ledger:` line carries the items, on the line
separated by `;` or as bullets below it: `adds <kind> <name> -> deletes <rule>`,
`adds model <name>`, `adds part <name>`, `deletes <rule>`, or `adds nothing`.
An exception (`verdict`, `code`, `key`, `flag`, `registry`, `gate`) must name
the rule it deletes; a model or a part needs no pairing.

The `PR Task Lines` workflow now also runs `scripts/lint-pr-ledger.mjs`: a PR
whose body has a `Ledger:` or `Durability:` line is flagged when its ledger is
missing, malformed or adds an unpaired exception. The ct-dev-workflow skill
documents the grammar, and every task under the durability saga carries a
ledger line in the same grammar.
