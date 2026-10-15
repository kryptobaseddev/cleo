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
enforced (Git, worktree, direct, CI), with `cleo hook sync --activate` in the
message. Activation now records each hook's approved bindings, so a commit that
deletes, rebinds or corrupts a hook definition cannot escape the gate: drift
refuses every event in the approved, current or linked-checkout bindings, and a
`.cleo/hooks.json` that no longer parses refuses the approved ones. An event
none of them binds still runs no hooks, so worktree creation is not blocked
unless worktree events are bound; an activation from before bindings were stored
refuses every non-agent event on drift. Agent checks stay advisory and only warn. The same rule
covers worktree inheritance (including hooks only the linked checkout declares)
and the recheck between handlers.

`cleo hook sync --disable` now skips providers that have no delivery receipt and
creates no files or directories for them. It removes only hook containers that
activation created and the removal empties, deletes a provider config, and the directory holding it, that activation
created once nothing else is left in them, and deletes its own receipt. A
pre-existing config returns to its original bytes. Receipts written before this
fix record no creation, so their config is pruned but kept.
