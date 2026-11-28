---
id: merged-gate-checkout-cleanup
tasks: [T14628]
kind: fix
summary: "The merge-commit gate checkout command removes its temporary worktree after the gate run"
---

The command CLEO prints to cache a typed-gate pass in a fresh checkout of the
merge now removes that checkout with `git worktree remove` (never `--force`)
once the gate run ends, whether it passed or failed. When git refuses, because
the checkout holds a tracked change or an untracked file, the checkout is kept
and its path printed. The command exits with the gate run's status, and the
recorded pass stays valid because it binds to the merge tree, not the path.
