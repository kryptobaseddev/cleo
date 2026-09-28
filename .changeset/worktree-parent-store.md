---
id: worktree-parent-store
tasks: [T12460]
kind: fix
summary: "Worktrees read and write the parent project's store; they no longer get a 1.25 GB diverged copy. New `cleo doctor worktree-stores` reports copies made before the fix"
---
**P0: writes from inside an orchestrate worktree were silently lost.**
`resolveCleoDir` accepted the nearest ancestor with a `.cleo/` directory before
it checked the gitlink. A worktree always has one. In this repo `.cleo/` is
partly tracked, and every worktree also gets the `project-info.json` that
`createWorktree` seeds. The `CLEO_WORKTREE_ROOT` scope pointed at the same
directory. The worktree's store therefore opened empty. `autoRecoverFromBackup`
then copied the parent's newest snapshot into it (about 1.25 GB), and
`createSafetyBackup` added a `.bak` of the same size. After that, every write
from the worktree went to that copy. Nothing merged the copy back, and prune
deleted it. The isolation guard did not catch this because it re-derived the
path through the gitlink and approved a path that was never opened.

- `resolveCleoDir` maps the worktree-scope root and the nearest-`.cleo` root
  through `resolveStoreOwnerRoot`. A linked checkout whose main repo is a CLEO
  project resolves to the parent `.cleo/`. `project-info.json` stays in the
  worktree for identity, but it no longer makes the worktree the store owner.
- `openDualScopeDbAtPath` now runs the isolation guard for every project-scope
  open, including runtime and port binds and dedicated opens. The guard checks
  the path being opened. `assertDbPathIsNotWorktreeResident` uses the same
  derivation as the open.
- `autoRecoverFromBackup` refuses to restore into a worktree. It also refuses a
  snapshot that belongs to a different store than the one being recovered.
- `cleo doctor worktree-stores` is a read-only report. It lists `.cleo/*.db`
  and `*.bak` files in every worktree it finds, from both `git worktree list`
  and the canonical worktree directory. For each file it reports, per table,
  the rows missing from the parent and the rows updated later than the
  parent's copy of the same row. It exits 1 when any copy holds such rows. It
  deletes nothing. Files are opened `immutable=1` when no WAL is present, so no
  sidecar files are created.
