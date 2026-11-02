---
id: t14130-rust-project-hash-canonical
tasks: [T14130]
kind: fix
summary: "worktrunk-core's compute_project_hash now canonicalises the project root as the TypeScript computeProjectHash does (realpath, then a linked worktree hashes as its main checkout)"
---

`compute_project_hash` hashed the raw path bytes, while `computeProjectHash`
in `@cleocode/paths` resolves the path through the filesystem (T11023) and,
since T14126, hashes a linked git worktree as the main checkout that owns it.
A Rust caller (`step::relocate`) given a symlinked or worktree path named a
different `<cleo_home>/worktrees/<hash>/` than the TypeScript side.

The Rust function now applies the same canonicalisation: the real path, or the
path as given when it does not exist, then the owning main checkout of a
`<main>/.git/worktrees/<name>` gitlink. A parity test compares both
implementations on a symlink and a linked worktree, and the README and doc
comment describe the canonicalisation.
