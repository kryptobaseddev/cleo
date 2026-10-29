---
id: release-cut-invoking-checkout
tasks: [T14160]
kind: fix
summary: "cleo release cut, write-changelog and verify-tag run git only in the checkout they are started from, never in the project root checkout"
---

Run from a CLEO worktree, `cleo release cut` resolved the canonical project
root and ran `git fetch` there, so `checkoutAtMain` and the docs-rot scan
described that checkout (often on a stale branch) instead of the tree being
released.

- Every git and gh call of `cut`, its docs-rot scan and `checkoutAtMain` now
  use the checkout the command was started from: the CLEO worktree, else the
  project root (which honours `CLEO_ROOT`). The task store, the cut audit and
  standing authorizations still belong to the project.
- From a worktree, the merge sweep and the merged-work cleanup, which work on
  the project checkout, are skipped and named in the report rather than run
  there.
- `write-changelog` and `verify-tag` read the invoking checkout too.
