---
id: worktree-store-rewrite-guards
tasks: [T12708, T12677]
kind: fix
summary: "Every whole-store rewrite run from a git worktree now shares one guard: backup recover, doctor repair and backup import need --confirm-owner-store to overwrite the owning project's live store, open-time rewrites refuse, a store inside the worktree is always refused, and confirmed overwrites are audited; bare-repo worktrees no longer bind to the bare repo's parent directory"
---
- **One guard, one message.** Restore, `cleo backup recover`, `cleo doctor repair`
  and `cleo backup import` go through the same core guard. Run from a linked
  worktree against the owning project's store, each stops with
  `E_WT_STORE_REWRITE_CONFIRM_REQUIRED`. The message names the store it would
  overwrite and the owning project. `--confirm-owner-store` lets it proceed.
  The restore codes `E_WT_RESTORE_CONFIRM_REQUIRED` and `E_WT_RESTORE_REFUSED`
  are renamed to these shared codes.
- **Stores inside the worktree.** A rewrite whose target store lies inside a
  worktree is refused with `E_WT_STORE_REWRITE_REFUSED`, even when confirmed.
  CLEO never reads such a store.
- **Open-time rewrites refuse.** Auto-recovery from backup, the exodus
  first-open migration, the legacy tasks-lineage rebuild and the `cleo upgrade`
  storage migration have no flag to pass. Run from a worktree against the
  owning project's store, they now refuse and say to run from the project.
  The exodus migration reports `aborted`, so writes refuse until it runs.
- **Audit.** A confirmed overwrite appends a row naming the worktree, the store
  and the operation to `<project>/.cleo/audit/owner-store-rewrite.jsonl`
  before anything is written.
- **Bare repositories.** A worktree of `/p/app.git` used to resolve to `/p`'s
  store when `/p` was a CLEO project. The gitlink resolver now requires the
  common directory to be `.git`, so such a worktree has no owning project.
