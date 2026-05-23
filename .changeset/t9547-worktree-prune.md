---
"@cleocode/cleo": minor
"@cleocode/core": minor
---

feat(T9547): cleo worktree prune --orphaned + force-unlock (SAGA T10176)

Adds two CLI ops backed by SDK primitives in `@cleocode/core`:

- `cleo worktree prune --orphaned` — detects + removes worktrees whose
  owning task is done/cancelled or whose branch is reachable from `main`.
  Supports `--yes`, `--dry-run`, `--idle-days`, and `--days` plus
  per-orphan interactive Y/N confirmation on TTY. The dispatch primitive
  `pruneOrphanedWorktreesByStatus` reuses the T9546 listWorktrees
  classifier (no porcelain re-parsing), runs `git worktree remove --force`
  with `rmSync` fallback, and deletes merged task branches via
  `git branch -D`. Idempotent — re-running on a clean state returns
  `prunedCount=0` with no audit-log entries.

- `cleo worktree force-unlock <taskId>` — clears wedged worktree locks by
  removing stale `.git/index.lock` and running `git worktree unlock`.
  Detects (but never deletes) uncommitted changes.

Both operations append JSONL entries to
`.cleo/audit/worktree-lifecycle.jsonl` via a single chokepoint
(`appendWorktreeAuditEntry`) following the ADR-039 append-only pattern.

Includes 6 integration tests using real git worktrees (prune AC4 +
prune AC5 idempotency + dry-run + force-unlock AC2 lock-clear +
force-unlock AC5 idempotency + force-unlock E_WORKTREE_NOT_FOUND) on
top of the existing 22 hermetic unit tests, for 28 total tests
covering the T9547 surface.
