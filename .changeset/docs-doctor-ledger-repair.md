---
id: docs-doctor-ledger-repair
tasks: [T14117]
kind: fix
summary: "cleo docs doctor now repairs the publication ledger: it prunes rows whose mirror is gone (including dead worktree paths) and reports stale mirrors"
---

`cleo docs status` exited 2 permanently on this repo because `docs_publications`
held rows that could never be in sync. Thirteen pointed into dead worktrees
outside the project root, thirteen named mirrors that were removed, and six
named mirrors that drifted from the store. `cleo docs doctor` gains a ninth
diagnostic, `publication-ledger-drift`, built on the same classification as
`cleo docs status`:

- **Deleted mirror whose blob stays referenced elsewhere** (an attachments row,
  or a ledger row that is not itself deleted): `prune-publication`. On
  `--apply` the full row is appended to
  `.cleo/audit/docs-publications-prune.jsonl` first, then deleted, so a pruned
  row can be restored. This covers dead-worktree paths outside the root.
- **Deleted mirror that is the only reference to its blob:** plan only
  (`republish-or-prune`). Pruning it would drop the blob's last GC protection.
- **Modified mirror:** plan only. `republish` when the file still holds the last
  published blob (the store moved on), `reconcile-edit` when it was edited by
  hand. The doctor never picks which side of a drift wins.

Dry run stays the default, and `--apply` still requires the automatic backup.
