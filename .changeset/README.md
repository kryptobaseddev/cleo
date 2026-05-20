# Changesets (CLEO-native)

This directory holds CLEO-native task-anchored changeset entries. Each `*.md`
file is a markdown file with YAML frontmatter that pins a change to one or
more CLEO task IDs.

> Replaces the upstream `@changesets/cli` format. `@changesets/cli` itself
> remains a dormant devDep — its removal is tracked as a separate follow-up.

## File format

```md
---
id: <kebab-case-slug-matching-filename>
tasks: [T9686-A]               # one or more T#### or E-#### IDs (required)
kind: fix                      # feat | fix | perf | refactor | docs | test | chore | breaking
summary: One-line description. # required, user-facing
prs: [324]                     # optional, linked PR numbers
breaking: |                    # required iff kind == breaking
  Migration note explaining what consumers must change.
---

Optional longer-form markdown body becomes the `notes` field. Use it for
context, motivation, or migration steps.
```

## Validation

The schema is defined in `@cleocode/contracts/src/changesets.ts` and parsed by
`@cleocode/core/src/changesets/parser.ts`. CI runs `scripts/lint-changesets.mjs`
on every push — malformed entries fail the lint gate.

## Aggregation (T9738 follow-up)

For now, entries are write-only history. The future `cleo release plan`
aggregator will fold all entries since the previous tag into the next release
manifest. See `.cleo/agent-outputs/T9738-IVTR-bug-remediation-research.md`
§6.6 A3 for the full design.

## Example

See `t9686-a-dispatch-envelope.md` for a minimal example pinned to a single
task with a linked PR.
