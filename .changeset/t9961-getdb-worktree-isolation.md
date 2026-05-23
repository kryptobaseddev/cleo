---
id: t9961-getdb-worktree-isolation
tasks: [T9961]
kind: fix
summary: "Route getDb() through worktree-isolation guard (defense-in-depth for ~61 direct core callers)"
---

`getDb()` in `packages/core/src/store/sqlite.ts` is called directly from many core handlers (tasks.find / tasks.show / tasks.list / agent-resolver / etc.), bypassing the `openCleoDb('tasks', cwd)` chokepoint where the T9806 worktree-isolation guard fired. A leaked `.cleo/` inside a worktree could still synthesize the wrong DB for those direct paths.

Fix:

- Extract `assertDbPathIsNotWorktreeResident()` into a new leaf module `packages/core/src/store/worktree-isolation-guard.ts` so both `sqlite.ts` and `open-cleo-db.ts` can import it without a circular cycle.
- Call the guard from `getDb()` BEFORE any DB file is touched (before `mkdirSync`).
- All direct `getDb()` callers now get the same `E_WT_DB_ISOLATION_VIOLATION` protection that the `openCleoDb` chokepoint already enforced.
- Regression test mirrors the T9803 synthesis fixture and asserts both the throw path and the `CLEO_ALLOW_WORKTREE_DB_CREATE=1` kill-switch override.

Parent epic: T9806. Strategy locked at council verdict (a) — chokepoint-internal routing over lint-allowlist exceptions.
