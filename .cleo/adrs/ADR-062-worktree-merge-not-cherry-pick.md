# ADR-062: Worktree integration uses `git merge --no-ff` (not cherry-pick)

## Status

Accepted — 2026-04-29 (T1587, parent T1586 — Foundation Lockdown)

Supersedes the cherry-pick guidance in:

- `~/.claude/projects/-mnt-projects-cleocode/memory/feedback_cherry_pick_worktrees.md` (corrected 2026-04-29)
- `packages/core/templates/CLEO-INJECTION.md` §"Worktree-by-Default" (line 91 — pending template republish)
- `packages/core/src/spawn/branch-lock.ts::completeAgentWorktree` (legacy implementation — see "Migration" below)
- `packages/worktree/src/worktree-destroy.ts` (cherry-pick branch — to be replaced)
- `packages/contracts/src/branch-lock.ts::WorktreeCompleteResult` (`cherryPicked` field — to be renamed)

Related: ADR-055 (worktree-by-default agent isolation), ADR-041 (worktree
protocol — agents never touch primary directory).

## Context

When a CLEO worker agent finishes work on `task/<TASK_ID>` inside its
`~/.local/share/cleo/worktrees/<projectHash>/<TASK_ID>/` worktree, the
orchestrator must integrate the agent's commits back into the project's
target branch (commonly `main`, but project-agnostic — could be `master`,
`develop`, `trunk`, or any branch named in the project's git config).

The original integration design (shipped 2026-04 as T1118 / ADR-055
implementation) used `git cherry-pick`:

```ts
// packages/core/src/spawn/branch-lock.ts:284 (legacy)
gitSync(['cherry-pick', ...commits], gitRoot);
```

### The provenance failure

Cherry-pick **rewrites every commit SHA**. The agent's original commits no
longer exist in the target branch. This destroys task↔commit traceability:

```bash
# After cherry-pick integration:
$ git log --grep "T1244"
# 0 hits — even though the work shipped
```

`git blame` reports the integrator (the orchestrator user) as the author of
every line. Forensic investigation, post-mortems, and IVTR loops that depend
on identifying which agent wrote which line are silently broken.

### Why cherry-pick was originally chosen

The fear was concurrent orchestrators producing stale-base worktrees: parallel
agents A and B both branch off `main@abc123`. A integrates, advancing main to
`abc124`. B's branch is now stale. Cherry-pick "just works" against the new
HEAD without rebase.

### Why that fear was wrong

`git rebase --onto origin/<targetBranch>` performed **inside the worktree**
solves staleness without rewriting integration history. The rebase rewrites
SHAs **inside the worktree branch** (which is throwaway), then `git merge
--no-ff` brings the rebased branch into target with all commits intact.

## Decision

Worktree integration MUST use `git merge --no-ff <task-branch>` with a
task-ID-bearing merge commit message. Cherry-pick is forbidden for this code
path.

### Integration steps (project-agnostic)

Inside the agent's worktree at
`~/.local/share/cleo/worktrees/<projectHash>/<TASK_ID>/`:

1. **Discover target branch** — read in this order:
   - `.cleo/config.json::git.defaultBranch`
   - `git symbolic-ref refs/remotes/origin/HEAD` (strip `refs/remotes/origin/`)
   - First match in `git branch --list main master develop trunk`
   - Last resort: `main`
2. **Rebase inside worktree** — `git fetch origin && git rebase
   origin/<targetBranch>`. Conflicts force the agent (still inside its
   worktree) to resolve them before integration is allowed to proceed.
3. **Re-run gates** — `cleo verify --all` against cached evidence
   (per ADR-061). Stale evidence (post-rebase) re-validates against the
   rewritten worktree-branch SHAs.
4. **Merge from target branch in main worktree** — `git merge --no-ff
   task/<TASK_ID> -m "Merge T<ID>: <task title>"`.
5. **Prune worktree** — call `pruneWorktree(taskId, projectRoot)` (T1462,
   shipped). This removes the worktree directory and the now-merged
   `task/<TASK_ID>` branch.

### Merge commit message contract

The merge commit subject MUST start with `Merge T<ID>:` so that
`git log --grep "T<ID>"` returns:

- The merge commit (full task title + integration record).
- All agent commits the merge brought in (preserved SHAs).

This restores the property that every shipped task is auditable from
`git log` alone — no SQLite query, no `.cleo/agent-outputs/` scrape required.

### Concurrent-orchestrator handling

Two parallel orchestrators integrating different task branches against the
same target branch:

- Orchestrator A merges `task/T1587` → main advances.
- Orchestrator B's worktree for `task/T1588` is now stale relative to main.
- B's pre-merge step 2 (rebase inside worktree) fast-forwards B onto the new
  main. No conflict if A and B touched disjoint files.
- If A and B touched the same file, B's rebase produces conflicts. B's agent
  resolves them in its worktree, re-runs gates (step 3), then merges.

**Stale base is a worktree-level concern, never an integration-level
concern.** The merge step itself is always a fast-forward-from-rebased-tip.

## Consequences

### Positive

- `git log --grep "T<ID>"` recovers full provenance for every shipped task.
- `git blame` correctly attributes every line to the originating agent.
- IVTR loops, post-mortems, and audit reviews can reconstruct exactly which
  agent committed which change at which time.
- Merge commits document the integration event itself (timestamp, integrator,
  resolved conflicts). This is data that cherry-pick discards.
- The agent's own commit graph (atomic commits, conventional messages,
  intermediate WIP) is preserved end-to-end.

### Negative

- Target branch history contains merge commits (linear-history advocates
  object). This is acceptable: CLEO is a multi-agent orchestration platform;
  integration events are first-class history.
- `git log --oneline` becomes more verbose. Mitigated by the `--first-parent`
  flag (`git log --first-parent main` shows only the integration timeline).
- Rebase-inside-worktree may surface conflicts that cherry-pick would have
  silently produced as broken merges. This is a **feature** — agents now must
  resolve conflicts before integration can succeed.

### Migration

This ADR mandates new code paths; legacy `completeAgentWorktree` (cherry-pick)
remains until callers migrate. Migration plan filed under T1587 deliverable:

1. Add `completeAgentWorktreeViaMerge` to
   `packages/core/src/spawn/branch-lock.ts` (T1587 — this ADR).
2. Update `WorktreeCompleteResult` contract: rename `cherryPicked` → `merged`,
   add `mergeCommit: string` field (follow-up task — flagged in deliverable).
3. Switch `cleo orchestrate worktree.complete` dispatch (registry.ts:6477) to
   the new function. Mark cherry-pick path deprecated for one release, then
   remove (follow-up task).
4. Republish `CLEO-INJECTION.md` template (line 91) in next CLEO release —
   shipped templates under `~/.local/share/cleo/` are immutable until
   release; this repo's `packages/core/templates/CLEO-INJECTION.md` is fixed
   in this commit.

## Code references

- `packages/core/src/spawn/branch-lock.ts` — legacy `completeAgentWorktree`
  (cherry-pick); new `completeAgentWorktreeViaMerge` added here.
- `packages/contracts/src/branch-lock.ts` — `WorktreeCompleteResult`
  (legacy field names retained for back-compat).
- `packages/contracts/src/operations/worktree.ts` — operation contract.
- `packages/core/src/spawn/__tests__/worktree-prune.test.ts` — fixture
  patterns reused by the new merge test.

## Project-agnostic verification

This ADR and the supporting code MUST NOT hardcode "main", "master", or any
project-specific branch name. All target-branch resolution flows through
`getDefaultBranch(projectRoot)` (added in T1587), which reads (in order):

1. `.cleo/config.json::git.defaultBranch`
2. `git symbolic-ref refs/remotes/origin/HEAD`
3. Probe `main`, `master`, `develop`, `trunk` in that order
4. Fallback: `main` (logged as a warning)

A cleocode-specific branch name in any new code path is a regression — file
a follow-up task.

## References

- ADR-055 — Worktree-by-default agent isolation
- ADR-041 — Worktree protocol (agent context boundary)
- ADR-061 — Project-agnostic verify tools + result cache
- T1118 — Branch-lock engine (legacy cherry-pick implementation)
- T1462 — pruneWorktree (single-task cleanup, retained as-is)
- T1587 — This ADR + new merge-based integration
- Memory: `feedback_cherry_pick_worktrees.md` (corrected 2026-04-29)
