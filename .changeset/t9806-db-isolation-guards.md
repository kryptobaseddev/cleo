---
id: t9806-db-isolation-guards
tasks: [T9806]
kind: feat
prs: []
summary: DB chokepoint refuses opens when the resolved `.cleo/` resides inside a git worktree — defense-in-depth on top of T9803.
---

After T9803 closed the orphan `.cleo/` synthesis vector at the path-resolution
layer, T9806 adds a second guard at the DB-open chokepoint:

```ts
assertDbPathIsNotWorktreeResident(role, cwd);
```

If the resolved `.cleo/`'s parent directory has `.git` as a FILE (gitlink —
i.e. the parent is a git worktree, not a canonical project root), the open
is refused with `E_WT_DB_ISOLATION_VIOLATION`. This catches the residual
case where a leaked `.cleo/` already exists inside a worktree from a
pre-T9803 install.

`signaldock` and `skills` roles are skipped — they open against
`~/.local/share/cleo/` regardless of cwd, so a worktree gitlink parent is
irrelevant.

**Kill-switch**: `CLEO_ALLOW_WORKTREE_DB_CREATE=1` bypasses the guard. The
override is logged to stderr:

```
[T9806 WT-DB-OVERRIDE] role=<role> path=<cleoDir> reason=CLEO_ALLOW_WORKTREE_DB_CREATE=1
```

Non-`'1'` values (e.g. `'true'`, `'yes'`) do NOT bypass — the literal string
match is intentional to require explicit opt-in.

Regression suite at
`packages/core/src/store/__tests__/open-cleo-db-worktree-guard.test.ts`
covers AC-1 (refuses for tasks/brain/conduit/nexus), AC-2 (kill-switch
bypass + literal-`'1'` enforcement), AC-3 (signaldock unaffected).

Saga: T9800 SG-WORKTREE-CANON · Decision D009 (council verdict).
