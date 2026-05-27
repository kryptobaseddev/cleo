# CLEO Changesets

The `.changeset/` directory holds task-anchored changeset entries that
`cleo release plan` aggregates into structured `CHANGELOG.md` sections.
Each `*.md` file pins one shipped change to one or more CLEO task IDs.

## Adding an entry

ALWAYS use the canonical writer — never hand-author `*.md` files here:

```bash
cleo changeset add \
  --slug t9785-polish-changeset \
  --tasks T9785 \
  --kind chore \
  --summary "One-line user-facing description." \
  --prs 123,456 \
  --notes "Optional longer markdown body (becomes the file body)."
```

Required flags: `--slug`, `--tasks`, `--kind`, `--summary`.
Optional: `--prs` (comma-separated PR numbers), `--notes` (markdown body),
`--breaking` (REQUIRED iff `--kind breaking`), `--attached-by` (SSoT identity).

The verb dual-writes — either both surfaces succeed or NEITHER persists:

- `.changeset/<slug>.md` — this directory; human-reviewable PR mirror.
- The docs SSoT blob store — canonical, content-addressed, searchable
  (`extras.type = 'changeset'`, owner = first task in `tasks`).

Slug rules: must match `/^t\d+-[a-z0-9-]+$/`
(e.g. `t9793-changeset-ssot-integration`). `kind` is one of
`feat | fix | perf | refactor | docs | test | chore | breaking`.

## Listing entries

```bash
cleo changeset list             # LAFS JSON envelope (default — agent mode)
cleo changeset list --human     # aligned SLUG/KIND/TASKS/PR/SUMMARY table
```

`list` parses every `*.md` under `.changeset/` via the SAME parser
(`@cleocode/core` → `parseChangesetDir`) that the release-plan aggregator
and `scripts/lint-changesets.mjs` consume — a successful `list` implies
the lint gate would also pass.

## File format

```md
---
id: t9686-a-dispatch-envelope           # MUST match filename slug
tasks: [T9686-A]                        # one or more T#### or E-#### IDs
kind: fix                               # feat|fix|perf|refactor|docs|test|chore|breaking
summary: One-line description.          # required, user-facing
prs: [324]                              # optional, linked PR numbers
breaking: |                             # required iff kind == breaking
  Migration note explaining what consumers must change.
---

Optional longer-form markdown body becomes the `notes` field. Use it for
context, motivation, or migration steps.
```

The Zod schema lives in `@cleocode/contracts/src/changesets.ts` and is
parsed by `@cleocode/core/src/changesets/parser.ts`. CI runs
`scripts/lint-changesets.mjs` on every push — malformed entries fail the
lint gate.

## How entries become CHANGELOG sections

`cleo release plan v<version> --epic T####` parses every entry under
`.changeset/`, validates the YAML + body, groups by `kind`, and renders
the markdown into:

- `meta.releaseNotes` on the release plan envelope.
- The `## [VERSION] (YYYY-MM-DD)` section in `CHANGELOG.md` (per the
  T9838-A release-as-product pipeline).

See ADR-028 (revised 2026-05-20) for the canonical pipeline spec.

## Example

See `t9686-a-dispatch-envelope.md` for a minimal example pinned to a
single task with a linked PR.
