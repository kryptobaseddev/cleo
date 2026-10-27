---
id: drop-core-partial-worktree-copy
tasks: [T10870]
kind: refactor
summary: "Remove core's unused copy of detectPartialWorktree; the @cleocode/worktree facade owns partial-worktree detection"
---

`packages/core/src/orchestrate/spawn-ops.ts` exported its own
`detectPartialWorktree` and `PartialWorktreeSignals`, a duplicate of the
`@cleocode/worktree` recovery facade that nothing called. Its index-lock probe
looked for `.git/index.lock` inside the worktree, which never exists in a
linked worktree (where `.git` is a file); the facade resolves the real admin
directory. The duplicate and its raw `git status` call are removed.
