---
id: provisioned-worktree-realpath
tasks: [T14054]
kind: fix
summary: "Provisioned-worktree check compares realpaths, so a row recorded through a symlink still counts"
---

`isCleoProvisionedWorktree` matched the lifecycle-audit row's path to the
task's worktree path with `path.resolve`, which does not follow symlinks. A
worktree adopted through a symlinked path (macOS `/tmp` vs `/private/tmp`, or a
symlinked CLEO home) was then judged not provisioned, and completion skipped
its merge. Both sides now go through `canonicalizePath` (realpath, falling back
to the resolved path when the directory is gone).
