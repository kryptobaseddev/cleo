---
id: t9785-changeset-list-and-readme
tasks: [T9785]
kind: chore
summary: cleo changeset list verb + README pointing at canonical writer
---

Saga T9782 — the T9793 dual-write writer is now the only changesets author path.

Added `cleo changeset list` (LAFS envelope default, `--human` aligned SLUG/KIND/TASKS/PR/SUMMARY table) that reuses the same `parseChangesetDir` the release-plan aggregator + lint-changesets.mjs consume — no separate code path.

Regenerated `.changeset/README.md` to teach contributors the canonical `cleo changeset add` flow and document `cleo changeset list`.

Extended the integration test to cover the new `list` subcommand: empty-state envelope, post-add roundtrip, and `--human` table rendering.
