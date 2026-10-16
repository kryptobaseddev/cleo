---
id: codex-worktree-hooks
tasks: [T13772]
kind: fix
summary: "cleo hook sync now delivers the Codex project hook where Codex reads it for a linked git worktree, so it fires in worktrees"
---

In a linked worktree, Codex ignores the worktree's own `.codex/hooks.json`.
It reads hooks from the matching `.codex` folder of the root checkout, and it
only looks there when the worktree has a `.codex` directory. CLEO wrote the
hook into the worktree, so it never fired there.

`cleo hook sync --activate` run in a linked worktree now writes the Codex entry
into the root checkout's `.codex/hooks.json`, under one receipt that the root
checkout and its worktrees share, and creates the worktree's `.codex`
directory. The hook command carries no paths: it resolves the worktree it runs
in from its cwd. A worktree only grows the shared entry (the union of the
events already delivered and its own); an activation with no agent bindings
leaves it untouched, and shrinking stays with a root sync. A worktree-local entry from an earlier release is removed by
its receipt. `--disable` in a worktree keeps the shared root entry (that
worktree's disabled activation makes it a no-op there) and removes the empty
`.codex` directory. `--disable` in the root checkout removes the entry for all
of them. Claude Code and the other harnesses are unchanged.
