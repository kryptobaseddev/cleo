---
id: t9548-worktree-complete-auto
tasks: [T9548]
kind: feat
summary: "auto-invoke worktree-complete from `cleo complete <taskId>` (SAGA T10176)"
---

feat(T9548): auto-invoke worktree-complete from `cleo complete <taskId>` (SAGA T10176)

`cleo complete <taskId>` now automatically integrates the associated CLEO
worktree back into the project default branch via `git merge --no-ff`
(ADR-062). The hook is idempotent, best-effort, and surfaces a diagnostic
envelope under `data.worktreeAutoComplete` so the CLI can show what
happened (merged, noop, conflict, env-disabled, no-worktree).

- New SDK helper `maybeAutoCompleteWorktreeForTask()` wraps the existing
  `completeWorktreeForTask` with env-var skip, worktree-absence check,
  and a try/catch envelope that never derails task completion.
- Opt-out via `CLEO_NO_AUTO_WORKTREE_COMPLETE=1` env var (e.g. for manual
  recovery flows where the operator wants to inspect the worktree before
  integration).
- Lifecycle audit rows continue to be emitted only by the underlying SDK
  for real lifecycle events (`complete`, `complete-skip`,
  `complete-conflict`, `complete-manual`); the env-disabled and
  no-worktree paths are pure no-ops.
- Integration test (`worktree-complete-auto.test.ts`) covers happy path,
  idempotency (worktree-gone + same-worktree re-invoke), env-var skip
  toggle, falsy env-var values, no-worktree path, and envelope shape
  compliance.

Closes T9548 (T10192 / 4 of 5). Saga: T10176. Decision: D010.
