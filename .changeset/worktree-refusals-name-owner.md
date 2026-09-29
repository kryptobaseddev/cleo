---
id: worktree-refusals-name-owner
tasks: [T12677]
kind: fix
summary: A linked worktree of a CLEO project never gets its own store. The store-open and auto-recovery refusals now name the owning project, and `cleo worktree adopt .` records the absolute worktree path
---

Field report, 2026-09-28. `cleo worktree adopt` was run inside a fresh task
worktree with the installed v2026.9.20, which predates T12460. It resolved the
worktree's own `.cleo/` as the project root, because the worktree carried the
project's tracked `.cleo/` files and the seeded `project-info.json`. The store
opened empty, and auto-recovery restored the parent's 1.3 GB snapshot into it
as `cleo.db` plus `cleo-pre-cleo.db.bak`. T12460 (on main, not yet released)
maps a worktree to its parent's store. This change finishes the remaining
parts of the fix:

- `E_WT_DB_ISOLATION_VIOLATION` and the auto-recovery refusal
  (`worktreeRecoveryRefusal`) now name the owning project, for example
  "owning project /home/u/project (projectId …)", or the owning repository
  when it is not an initialised CLEO project. The name comes from the new
  `describeWorktreeOwner`.
- `adoptWorktree` resolves `worktreePath` to an absolute path. Before this,
  `cleo worktree adopt .` run from inside the worktree recorded `"."` in the
  owning project's sentinel index, which names the project root, not the
  worktree.
- New regression test for the field layout: tracked `.cleo/` files, a
  populated parent store with a backup auto-recovery could use, and a sibling
  worktree. Reading and adopting from inside the worktree leaves no store in
  the worktree and the parent's task set unchanged.
