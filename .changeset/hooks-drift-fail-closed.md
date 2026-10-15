---
id: hooks-drift-fail-closed
tasks: [T13742, T13743]
kind: fix
summary: a drifted hooks activation now refuses Git pushes, and hook sync --disable leaves no residue
---

With a drifted activation receipt or handler hash, the project hook executor
reported a non-blocking `warn (HOOK_REACTIVATION_REQUIRED)` and Git pre-push
allowed the push, so a check that would have blocked was skipped. Drift now runs
no handler and refuses every matching check wherever its block verdict would be
enforced (Git, worktree, CI), with `cleo hook sync --activate` in the message.
Agent checks stay advisory and only warn. The same rule covers worktree
inheritance and the recheck between handlers.

`cleo hook sync --disable` now skips providers that have no delivery receipt and
creates no files or directories for them. It removes hook containers that it
emptied, deletes a provider config that activation created once nothing else is
left in it, and deletes its own receipt. A pre-existing config returns to its
original bytes.
