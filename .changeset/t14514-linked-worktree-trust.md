---
id: t14514-linked-worktree-trust
tasks: [T14514]
kind: fix
summary: "Claude Code lead preflight accepts saved main-checkout trust from linked worktrees"
---

Resolve Claude Code's canonical checkout through a linked worktree's git
common directory and matching backlink. Existing main-checkout trust now
permits the lead to launch, while unresolved metadata and trust outside the
repository remain refused without changing the user's Claude configuration.
