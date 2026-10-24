---
id: t14022-gitignore-node-modules
tasks: [T14022]
kind: fix
summary: 'node_modules symlinks are ignored: .gitignore patterns drop the trailing slash'
---

The root, `packages/caamp` and `packages/lafs` `.gitignore` files said
`node_modules/`. A trailing slash matches directories only, so the
`packages/<pkg>/node_modules` symlink that a CLEO worktree links to the main
checkout was not ignored. `git add -A` could then commit an absolute local
path, as #2435 did. The pattern is now `node_modules`, which ignores the
symlink too. A scripts test checks it with `git check-ignore`.
