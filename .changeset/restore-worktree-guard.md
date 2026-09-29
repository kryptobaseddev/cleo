---
id: restore-worktree-guard
tasks: [T12680]
kind: fix
summary: "cleo restore backup (and admin.backup restore) run from inside a git worktree now names the store it would overwrite and needs --confirm-owner-store; it refuses when the store would land in the worktree itself; bare-repo worktrees get an accurate message instead of 'unreadable gitlink'"
---
- **Initialised owner.** Before this fix, a restore run inside a linked worktree
  silently overwrote the owning project's LIVE store. It now stops with
  `E_WT_RESTORE_CONFIRM_REQUIRED`, which names the target `.cleo/` and the
  owning project. The restore goes ahead only with `--confirm-owner-store`
  (`confirmOwnerStore` in `admin.backup` mutate).
- **Owner that cannot hold a store.** When the owning repository is not an
  initialised CLEO project, or is a bare repository, the restore used to write
  into the worktree's own `.cleo/`, which CLEO never reads. It is now refused
  with `E_WT_RESTORE_REFUSED`, even when confirmation is given.
- **Where the guard lives.** It runs in the core functions `restoreBackup`
  and `restoreFromBackup`, so SDK callers are covered too.
- **Bare-repo message.** A bare repository's worktree now reports that the
  repository is bare. The message says to clone it to a regular checkout, run
  `cleo init` there, and create worktrees from that checkout. Before, it
  reported an "unreadable gitlink".
