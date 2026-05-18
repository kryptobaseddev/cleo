# Worktree Lifecycle — Conflict Recovery (T9548 stub)

> **Stub document.** T9549 will replace this with the canonical
> `docs/spec/worktree-lifecycle.md`. Captured here so the T9548 acceptance
> criterion ("merge conflict path documented") has a tracked landing site
> before the full spec exists.
>
> Task: T9548 (T9515 Worktree Lifecycle / 4 of 5)
> Owner: ct-task-executor
> Status: stub — will be folded into T9549's full spec.

## Auto-invoke contract

After `orchestrate.spawn.execute` returns success (worker `exitCode === 0`),
the SDK invokes `completeWorktreeForTask(taskId, projectRoot)` to integrate
the worktree back to the default branch. The auto-invoke is idempotent:
re-running on an already-completed worktree appends a `complete-skip` audit
row to `.cleo/audit/worktree-lifecycle.jsonl` and returns
`outcome: 'noop'`.

The auto-invoke is **skipped** when:

- `opts.autoComplete === false` was passed (CLI flag: `--no-auto-complete`).
- The worker returned a non-zero exit code (worktree preserved for inspection).
- Import of the worktree-complete SDK throws (best-effort).

## Outcome contract

`completeWorktreeForTask` returns one of four outcomes:

| Outcome     | Meaning                                                                                              | Audit action       |
|-------------|------------------------------------------------------------------------------------------------------|--------------------|
| `merged`    | `git merge --no-ff` succeeded; worktree + branch pruned.                                             | `complete`         |
| `noop`      | Idempotent skip — prior merge already recorded.                                                      | `complete-skip`    |
| `manual`    | `resolve: 'manual'` was set; merge skipped; worktree marked as manually-handled.                     | `complete-manual`  |
| `conflict`  | Auto-merge failed (rebase or merge conflict). **Worktree preserved.** No prune attempted.            | `complete-conflict`|

## Merge conflict recovery path

When the auto-merge step fails (e.g. rebase conflict against the rebased
target branch), the dispatch envelope's `error.details.recovery` block
contains an ordered list of recovery steps the operator can follow:

```
cd <worktreePath>
git status                      # inspect conflicted files
git rebase --continue           # OR resolve + git commit
git push origin HEAD            # push resolution upstream
cleo orchestrate worktree-complete <TASKID> --resolve manual
```

The `--resolve manual` invocation:

1. Skips the automatic `git merge --no-ff` attempt entirely.
2. Appends a `complete-manual` row to
   `.cleo/audit/worktree-lifecycle.jsonl` (`success: true`).
3. Returns `outcome: 'manual'` so downstream automation can distinguish
   manually-handled worktrees from auto-merged ones.

The operator is responsible for ensuring the worktree contents have already
been integrated into the target branch (via rebase + push, cherry-pick,
or any other manual flow) before flipping the `--resolve manual` switch.
The audit row only records the operator's assertion — it does not perform
the integration itself.

## Idempotency check

`completeWorktreeForTask` scans
`.cleo/audit/worktree-integration.jsonl` for a prior entry with
`taskId === <taskId>` and `merged === true`. When found, the function
short-circuits:

- Writes a `complete-skip` row to the lifecycle audit log.
- Returns `outcome: 'noop'` with a reason describing the prior merge.
- Performs no git operations.

The check is best-effort — if the audit file is missing, unreadable, or
malformed the function proceeds with the merge attempt. The underlying
`completeAgentWorktreeViaMerge` call is itself near-no-op when the
`task/<taskId>` branch is absent (it returns `merged: false` with an
explanatory error rather than throwing).

## References

- ADR-062 — Worktree integration via `git merge --no-ff` (not cherry-pick).
- T9043 — `completeAgentWorktreeIntegration` audit log path.
- T9547 — `worktree-lifecycle.jsonl` schema + actions.
- T9548 — Auto-invoke worktree-complete post-success (this stub).
- T9549 — Replaces this stub with the full spec.
