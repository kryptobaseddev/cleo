---
id: t14189-merge-sweep-env
tasks: [T14189]
kind: fix
summary: "a cleo read command run inside a git hook never starts the background merge sweep, and the sweep never inherits a hook's GIT_DIR or GIT_INDEX_FILE"
---

`cleo show`, `briefing`, `next`, `current` and `release` may start a detached
`cleo done --from-merge all` sweep. When the read command ran inside a git
hook (commit-msg runs `cleo show`), the sweep inherited the hook's `GIT_DIR`
and `GIT_INDEX_FILE` and outlived the commit: its task closes checkpointed
`.cleo` state into the hook's index, and its worktree cleanup ran `git -C`
against the hook's repository (`-C` does not override an inherited
`GIT_DIR`). The sweep now starts with every ambient repo variable stripped,
and merged-cleanup's own git calls strip them too.

A read command run inside a process git started (`GIT_EXEC_PATH`,
`GIT_INDEX_FILE` or `GIT_DIR` set: git exports them to its hooks) no longer
starts the sweep at all.
