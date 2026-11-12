---
id: merged-pr-checkout-remedy
tasks: [T14512]
kind: fix
summary: "Done: name an accepted merged checkout when the task worktree is stale"
---

When a merged PR's task worktree is still at its branch head, `cleo done` now
reports the missing merge commit before directing the caller into that worktree.
Its remedy checks out the merged commit, enters that checkout, and preserves the
explicit PR selection and `--run-typed` request, leaving automatic PR discovery
intact. Merge and squash regression tests prove that the named checkout runs its
typed gate successfully.
