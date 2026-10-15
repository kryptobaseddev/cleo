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
message. Agent checks stay advisory and only warn.

Activation now records each hook's approved bindings, with a digest, so a commit
that deletes, rebinds or corrupts a hook definition cannot escape the gate.
Drift refuses every event in the approved, current or linked-checkout bindings.
A `.cleo/hooks.json` that no longer parses, or a handler, dependency, lockfile
or `./` executable that is deleted or replaced by a directory, refuses the
approved ones. A missing PATH runtime is still an environment fault that allows
locally. An event none of the bindings name runs no hooks, so worktree creation
is not blocked unless worktree events are bound. An activation from before
bindings were stored, or one whose bindings fail their digest, refuses every
non-agent event on drift, including an unparseable manifest or a deleted input. The same rules cover worktree inheritance (including
hooks only the linked checkout declares) and the recheck between handlers.

`cleo hook sync --disable` now skips providers that have no delivery receipt and
creates no files or directories for them. It removes only hook containers that
activation created and the removal empties. It deletes a provider config, and
the directory holding it, that activation created once nothing else is left in
them, and it deletes its own receipt. A pre-existing config returns to its
original bytes. For receipts written before this change, CLEO's entries are
removed; the container and file are kept.
