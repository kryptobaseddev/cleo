---
id: core-prune-unlock-facade
tasks: [T10867, T10868]
kind: refactor
summary: "Core prune and force-unlock call the @cleocode/worktree facade; the forensic bypass policy is written down"
---

`cleo worktree prune` and `cleo worktree force-unlock` no longer shell out to
`git worktree prune` / `git worktree unlock` from core: they call the facade's
new `pruneWorktreeRegistry` and `unlockWorktree` helpers, which
`forceRemoveWorktreeDir` now also uses. `prune.ts` and `force-unlock.ts` leave
the raw-git-worktree lint allowlist. The worktree-lifecycle spec gains MUST-29
(lifecycle verbs run only in `@cleocode/worktree`) and MUST-30 (allowlisted,
read-only forensic bypass: the doctor orphan scan, and the core list
primitive until T10866).
