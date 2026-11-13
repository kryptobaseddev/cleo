---
id: t14520-linked-worktree-lexical-trust
tasks: [T14520]
kind: fix
summary: "Claude Code lead preflight resolves linked-worktree gitdir and commondir paths the way Claude does"
---

The linked-worktree trust check now resolves a worktree's gitdir and
commondir lexically, as Claude Code 2.1.322 does, instead of following them
through symlinks. A commondir spelled through a symlink that no longer names
the worktree entry's parent is refused, a gitdir spelled through a symlink is
trusted by the path Claude keys, and unsafe network paths or symlinked
metadata files are refused. A main checkout at the home directory stays
refused and is now tested.
