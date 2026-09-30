---
id: worktree-store-rewrite-guards
tasks: [T12708, T12677]
kind: fix
summary: "Every whole-store rewrite run from a git worktree now shares one guard: restore, backup recover, doctor repair, backup import and the db-substrate quarantine need --confirm-owner-store to overwrite the owning project's live store; open-time rewrites proceed on the owner store and are audited; a store inside the worktree is always refused; worktrees of a bare repo such as /p/app.git no longer bind to /p's store"
---
- **One guard, one message.** These commands now go through the same core
  guard: restore, `cleo backup recover`, `cleo doctor repair`,
  `cleo backup import` and the corrupt-DB quarantine in
  `cleo doctor db-substrate`. When run from a linked worktree against the
  owning project's store, each one stops with
  `E_WT_STORE_REWRITE_CONFIRM_REQUIRED`. The message names the store and the
  owning project. `--confirm-owner-store` lets it proceed.
- **Renamed codes.** The restore refusal prefixes `E_WT_RESTORE_CONFIRM_REQUIRED`
  and `E_WT_RESTORE_REFUSED` (released in v2026.9.23) are renamed to
  `E_WT_STORE_REWRITE_CONFIRM_REQUIRED` and `E_WT_STORE_REWRITE_REFUSED`. No
  aliases are kept.
- **db-substrate quarantine.** Auto-quarantine stays on by default. From a
  worktree it skips the owning project's live store unless
  `--confirm-owner-store` is given, and it reports why the DB was left in
  place. `--no-quarantine` still turns it off.
- **Open-time rewrites proceed.** Auto-recovery from backup, the exodus
  first-open migration, the legacy tasks-lineage rebuild and the
  `cleo upgrade` storage migration run against the owning project's store
  exactly as they would from the project root. A run from a worktree is
  audited. The T12687 guard still stops unreleased worktree builds from
  changing the schema.
- **Stores inside the worktree.** A rewrite whose target store lies inside a
  worktree is refused with `E_WT_STORE_REWRITE_REFUSED`, even when confirmed.
  The lineage rebuild throws this refusal with its fix, and the migration
  error is attached as the cause. The exodus migration reports `aborted` and
  releases its handle.
- **Audit.** Every owner-store rewrite run from a worktree, confirmed or
  open-time, appends a row to `<project>/.cleo/audit/owner-store-rewrite.jsonl`
  before anything is written. The row names the worktree, the store, the
  operation and the trigger. If the row cannot be written, the rewrite does
  not run.
- **Bare repositories.** A worktree of a bare repo such as `/p/app.git` used
  to resolve to `/p`'s store when `/p` was a CLEO project. It now has no
  owning project. The bare-worktree layout `/p/.bare` still resolves to `/p`,
  with or without a `/p/.git` gitlink.
