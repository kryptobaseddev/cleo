---
id: docs-status-legacy-rows-from-worktree
tasks: [T14195]
kind: fix
summary: "docs status and doctor resolve legacy root-relative ledger rows against the project root when run from a worktree"
---

A `docs_publications` row whose relative path leaves the project root (a
legacy row such as `../../Library/…/worktrees/<hash>/<id>/docs/x.md`) was
recorded against the project root. Since T14188, `cleo docs status` and
`cleo docs doctor` read mirrors from the invoking checkout, so from a
worktree these rows were joined onto the worktree and reported as false
`deleted`. The doctor could then judge them "gone" through a fake worktree
directory and plan a prune of a synced row. Such rows now resolve against the
project root; in-tree rows still resolve in the invoking checkout.
