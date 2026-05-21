---
"@cleocode/worktree": minor
"@cleocode/contracts": minor
"@cleocode/cleo": minor
---

feat(T9805): worktree lifecycle audit log + auto-cleanup GHA workflow

Implements AC1, AC2, and AC3 of T9805 (E-WT-LIFECYCLE-HOOKS, saga SG-WORKTREE-CANON, council verdict D009):

**AC1 — GitHub Actions auto-cleanup** (`.github/workflows/worktree-cleanup.yml`)
Triggers on `pull_request: closed` when merged. Derives the task ID from the branch name
(`task/T####` or `feat/T####-*`) and calls `cleo worktree destroy <taskId> --reason pr-merged`.
Also runs an abandonment-timeout sweep after every merge.

**AC2 — Abandonment-timeout sweeper** (`--idle-days <N>` on `cleo worktree prune`)
`PruneWorktreesOptions` gains an `idleDays?: number` field. When set, worktrees whose last
commit is older than N days are also eligible for removal, independent of the `preserveTaskIds`
set. Added `isWorktreeIdle()` heuristic using `git log -1 --format=%ct`.

**AC3 — Lifecycle audit log** (`packages/worktree/src/worktree-audit.ts`)
New shared DRY helper `appendWorktreeAuditLog(projectRoot, payload)` writes JSONL to
`<projectRoot>/.cleo/audit/worktree-lifecycle.jsonl`. Every `create`, `destroy`, and
`prune` call in `worktree-create.ts`, `worktree-destroy.ts`, and `worktree-prune.ts`
now emits an audit entry.

**D009 sentinel index** (`resolveWorktreeIndexPath`, `addWorktreeToSentinelIndex`, `removeWorktreeFromSentinelIndex`)
Create adds entries to `<gitRoot>/.cleo/worktrees.json`; destroy and prune remove them.

**New `cleo worktree destroy <taskId>` command**
Explicit single-worktree teardown for use by the GHA workflow and for manual cleanup.

**contracts additions**
`WorktreeLifecycleAction` extended with `'create' | 'destroy' | 'adopt'`.
`DestroyWorktreeOptions.reason?: string` added.
`PruneWorktreesOptions.idleDays?: number` added.

AC4 (session-end hook) and AC5 (real-world test) are deferred to T9808.
