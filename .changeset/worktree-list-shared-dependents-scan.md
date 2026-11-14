---
id: worktree-list-shared-dependents-scan
tasks: [T14554]
kind: fix
summary: "cleo worktree list proves every finished worktree with one shared dependents scan; destroy --force archives leave out the pnpm store and the generated .npmrc"
---

`cleo worktree list` (and the full `cleo orchestrate` dashboard built on it)
ran the disposal proof for every finished worktree, and each proof's
dependents check read every other checkout's `node_modules` again. On a
project with 183 worktrees a listing took about 160 s: n proofs times n
checkouts, with an `lstat` per `.pnpm` entry.

A listing now shares one dependents scan across its dry-run proofs, so each
checkout is read once per listing, and entry types come from the directory
read instead of an `lstat` per entry. The categories are unchanged: a
worktree another checkout links into is still `keep`. The shared scan is
honoured only by dry runs; prune, destroy and every other removal scan the
disk afresh, so a link made after the listing still keeps a worktree.

`cleo worktree destroy --force` no longer copies CLEO's own pnpm provisioning
into the archive: a real `.pnpm-store/` and the `.npmrc` provisioning wrote,
unchanged and untracked. A tracked or edited `.npmrc` and a `.pnpm-store`
that is not a pnpm store are archived as before.
