---
id: t14520-linked-worktree-lexical-trust
tasks: [T14520]
kind: fix
summary: "Claude Code lead preflight judges linked-worktree trust paths exactly as Claude does"
---

The linked-worktree trust check now resolves a worktree's gitdir and
commondir lexically, as Claude Code 2.1.322 does, instead of following them
through symlinks, and applies Claude's own unsafe-path rule to the gitdir,
commondir and backlink text and to every symlink target on the way. UNC and
device spellings, other network hosts, `/network` and volfs roots, and on
macOS another user's automounted `/home` are refused; same-host `/net` paths
and links to `/` are followed as Claude follows them. A main checkout at the
home directory stays refused and is now tested.
