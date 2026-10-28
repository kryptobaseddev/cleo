---
id: docs-publish-worktree-routes
tasks: [T14081]
kind: fix
summary: "docs publish into a linked non-canonical worktree says only canonical CLEO worktrees are publication targets and names the two routes"
---

Publishing into a Git-linked worktree that is not the canonical CLEO worktree
path is refused by design (T13376), but the refusal read like any other
outside-root path. It now states that only canonical CLEO worktrees are
publication targets and names both routes: publish into the store's project
root, or run from a CLEO-created worktree (`cleo orchestrate spawn <taskId>`).
The dry run gives the same refusal and creates nothing.
