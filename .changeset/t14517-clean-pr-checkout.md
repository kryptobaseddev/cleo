---
id: t14517-clean-pr-checkout
tasks: [T14517]
kind: fix
summary: "Require a clean tracked tree when PR evidence tools run on the merged checkout"
---

Reuse the branch change set's dirty-tree check for PR-sourced tool runs after
verifying merge ancestry. Staged and unstaged tracked edits now block a detached
merge checkout; untracked worktree-include files such as `.npmrc` remain allowed.
