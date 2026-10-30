---
id: no-sweep-from-worktree
tasks: [T14168]
kind: fix
summary: "The lazy merge sweep never starts from a CLI built in a worktree, nor for a release command run from a CLEO worktree"
---

`release`, `briefing`, `next`, `current` and `show` start a detached
`cleo done --from-merge all` in the project checkout (T14101). Run from a
CLEO worktree, `cleo release cut` thereby ran git in the project checkout it
was not started in (T14160), and a CLI built inside a worktree ran a real,
non-dry sweep against the live store with unreleased code.

- A CLI built inside a worktree (its build stamp names a linked worktree)
  never starts the lazy sweep.
- A `release` command run from a CLEO worktree never starts it; from the
  project checkout it starts as before.
