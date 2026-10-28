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

- **Deleted mirror that is provably gone, with its blob still referenced
  elsewhere** (an attachments row, or a ledger row that is not itself
  deleted): `prune-publication`. On `--apply` the full row is appended to
  `.cleo/audit/docs-publications-prune.jsonl` first, then deleted, so a pruned
  row can be restored. Provably gone means:
  - for a path inside this project, absent from HEAD and from the default
    branch (local and `origin/`);
  - for a path inside this device's CLEO worktrees root, the worktree itself
    is removed.
- **Mirror on another device or checkout:** `report-only`. `docs_publications`
  syncs across devices, so a prune would delete the row everywhere. This
  covers an absolute path, a path outside both this root and this device's
  worktrees root, a path still tracked by HEAD or the default branch, or a
  checkout git cannot read.
- **Deleted mirror that is the only reference to its blob:** plan only
  (`republish-or-prune`). Pruning it would drop the blob's last GC protection.
- **Modified mirror:** plan only. `republish` when the file still holds the last
  published blob (the store moved on), `reconcile-edit` when it was edited by
  hand. The doctor never picks which side of a drift wins.

Dry run stays the default, and `--apply` still requires the automatic backup.
