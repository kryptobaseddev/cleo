# Worktree Lifecycle Specification

> **Task:** T9549 — replaces `docs/spec/worktree-lifecycle-stub.md` (T9548).
> **Epic:** T9515 — Worktree Lifecycle (5 of 5, closes the epic).
> **Status:** Canonical contract — supersedes all prior worktree lifecycle prose.

This document is the canonical contract for how CLEO provisions, manages,
inspects, completes, and recovers git worktrees used by spawned agent
workers. Every command, audit action, and recovery procedure described here
maps to source that has already landed on `main` (T9545, T9546, T9547) or is
in PR (T9548).

## 1. Overview

A **CLEO worktree** is a per-task git worktree that hosts a single spawned
worker agent's filesystem-of-record while the worker runs. Worktrees exist
because CLEO routinely orchestrates **multiple workers in parallel against
the same repository**, and we need:

- **Context isolation** — every worker gets its own working tree, its own
  `task/T####` branch, and a path-ACL boundary so it cannot touch the
  orchestrator's checkout or a sibling worker's checkout.
- **Provenance preservation** — every commit the worker makes carries the
  worker's authorship; the integration step (ADR-062) is a
  `git merge --no-ff` that keeps every original commit SHA reachable from
  the project's default branch.
- **Recoverability** — a wedged worker, a killed orchestrator, or a
  user-cancelled task must never leave behind unrecoverable state. Every
  worktree carries enough metadata (branch name, owning task ID, last
  activity) for `cleo worktree list` to classify it and for
  `cleo worktree prune` / `force-unlock` to clean it up safely.

Worktrees live under a deterministic, OS-conformant path resolved by
`resolveAgentWorktreeRoot` in
`packages/core/src/spawn/branch-lock.ts`:

```
$XDG_DATA_HOME/cleo/worktrees/<projectHash>/<taskId>/
# fallback when XDG is unset:
~/.local/share/cleo/worktrees/<projectHash>/<taskId>/
```

`projectHash` is `sha256(<projectRoot>).slice(0, 16)` so the path is
stable for a given project root but unique across machines and project
clones. The branch convention is `task/<taskId>` (e.g. `task/T9549`).

## 2. Lifecycle FSM

```
                                  ┌─────────────────┐
                                  │   (no worktree) │
                                  └────────┬────────┘
                                           │
                                           │ cleo orchestrate spawn <taskId>
                                           │ (provision worktree + branch)
                                           ▼
                                  ┌─────────────────┐
                                  │     CREATE      │
                                  │ • mkdir <path>  │
                                  │ • git worktree  │
                                  │   add task/Txxx │
                                  └────────┬────────┘
                                           │
                                           ▼
                                  ┌─────────────────┐
                                  │     MANAGE      │
                                  │ worker commits, │
                                  │ tests, pushes   │
                                  └────┬───────┬────┘
                                       │       │
                  worker exit 0        │       │   worker hangs / fails / orphan
                  (autoComplete=true)  │       │
                                       ▼       ▼
                  ┌────────────────────────┐  ┌─────────────────────┐
                  │       COMPLETE         │  │       PRUNE         │
                  │ • git merge --no-ff    │  │ • detect via list   │
                  │ • prune worktree       │  │ • git worktree      │
                  │ • delete merged branch │  │   remove --force    │
                  │ • audit: 'complete'    │  │ • audit: 'prune'    │
                  └────────────┬───────────┘  └──────────┬──────────┘
                               │                         │
                               ▼                         ▼
                  ┌────────────────────────┐  ┌─────────────────────┐
                  │  conflict? preserve    │  │  branch retained    │
                  │  worktree, return      │  │  iff !isMerged      │
                  │  recovery envelope     │  │  (cancelled-orphan) │
                  └────────────┬───────────┘  └─────────────────────┘
                               │
                               ▼
                  ┌────────────────────────┐
                  │ operator resolves,     │
                  │ then re-runs           │
                  │ worktree-complete      │
                  │   --resolve manual     │
                  └────────────────────────┘
```

`CREATE` is driven by `orchestrateSpawn` /
`orchestrateSpawnExecute` in
`packages/core/src/orchestrate/spawn-ops.ts`. `COMPLETE` is auto-invoked
post-success by the same function (T9548). `PRUNE` and `force-unlock` are
operator-driven via `cleo worktree …` commands.

## 3. CLI Contract

| Command | Source | Purpose |
|---|---|---|
| `cleo orchestrate spawn <taskId>` | `packages/cleo/src/cli/commands/orchestrate.ts` | Provision worktree + `task/<taskId>` branch, compose prompt, dispatch worker. Bounded by `SPAWN_BUDGET_MS = 60_000` (T9545). |
| `cleo orchestrate worktree-complete <taskId> [--resolve manual]` | `packages/cleo/src/cli/commands/orchestrate.ts` | Integrate `task/<taskId>` into the default branch via `git merge --no-ff` (ADR-062). Idempotent (T9548). |
| `cleo worktree list [--status …] [--stale-days N]` | `packages/cleo/src/cli/commands/worktree.ts` | Enumerate every worktree and classify each by status (T9546). |
| `cleo worktree prune --orphaned [--dry-run] [--yes]` | `packages/cleo/src/cli/commands/worktree.ts` | Remove `orphan`/`merged` worktrees with per-orphan Y/N confirmation (T9547). |
| `cleo worktree force-unlock <taskId>` | `packages/cleo/src/cli/commands/worktree.ts` | Clear `.git/index.lock` + `git worktree unlock <path>` for a wedged worktree (T9547). |

Every command writes to `.cleo/audit/worktree-lifecycle.jsonl` via
`appendWorktreeAuditEntry` in `packages/core/src/worktree/audit.ts`. Audit
entries are append-only JSONL — one record per action, never blocking the
operation that triggered them.

Every git subprocess invoked by these commands is bounded by a 60-second
supervisor timeout (`GIT_TIMEOUT_MS` in `list.ts`, `prune.ts`,
`force-unlock.ts`; `SPAWN_BUDGET_MS` in `spawn-ops.ts`). The pattern mirrors
`runGitWithLockRetry` from `packages/core/src/release/engine-ops.ts` (T9501).

## 4. Worktree Status Categories

`cleo worktree list` classifies every worktree into exactly one
mutually-exclusive `statusCategory`, defined in
`packages/contracts/src/operations/worktree.ts`:

```ts
export type WorktreeStatusCategory =
  | 'active'
  | 'stale'
  | 'merged'
  | 'orphan'
  | 'locked';
```

Resolution precedence (first match wins — see `classifyStatus` in
`packages/core/src/worktree/list.ts`):

1. **`locked`** — porcelain reported a `locked` line. Either an explicit
   `git worktree lock <path>` (the spawn flow does this for every agent
   worktree to prevent accidental pruning) or a wedged
   `.git/index.lock`. Remediation: `cleo worktree force-unlock <taskId>`.

2. **`orphan`** — the worktree's owning task is either `cancelled`, or the
   branch matches `task/T####` but the task row is missing from the tasks
   SSoT (`owningTaskStatus === null` for a non-null `taskId`). The branch
   tip is **preserved** when pruning so an investigator can still inspect
   abandoned work via `git log task/T####`.

3. **`merged`** — `git merge-base --is-ancestor <branch> main` exits 0. The
   branch tip is reachable from the default branch; pruning is safe and the
   local `task/<id>` branch is deleted too.

4. **`stale`** — idle longer than `staleDays` (default 7) AND
   (`owningTaskStatus ∈ {done, cancelled}` OR `isMerged`). Stale worktrees
   are **not** pruned by `cleo worktree prune --orphaned` — they go through
   the future T9515-lifecycle stale-handler. The classifier surfaces them so
   operators can decide.

5. **`active`** — everything else. The worker may still be running, the task
   is in flight, or the worktree was created within the staleness window.

Detection rules live in `listWorktrees()` in
`packages/core/src/worktree/list.ts`. The five booleans
(`isLocked`, `isOrphan`, `isMerged`, `isStale`) are computed independently
and then collapsed to one category via `classifyStatus()`.

## 5. Auto-Invocation (T9548)

`orchestrateSpawnExecute` auto-invokes worktree completion after a
successful spawn returns. The contract is implemented in
`packages/core/src/orchestrate/worktree-complete.ts` and wired into
`spawn-ops.ts` as the **T9548 — Auto-invoke worktree-complete post-success**
block.

### Auto-invoke fires when:

- The worker process returned `exitCode === 0`.
- `opts.autoComplete !== false` (CLI flag: `--no-auto-complete`).
- The completion SDK module imports without error.

### Auto-invoke is skipped when:

- The worker returned a non-zero exit code — worktree is **preserved** so
  the operator can inspect partial work.
- `autoComplete: false` was passed in `OrchestrateSpawnExecuteOpts`.
- The completion SDK import throws — best-effort, never blocks the spawn
  envelope from returning to the caller.

### Outcome contract

`completeWorktreeForTask()` returns one of four `outcome` values:

| `outcome`   | Meaning                                                                                              | Audit action       |
|-------------|------------------------------------------------------------------------------------------------------|--------------------|
| `merged`    | `git merge --no-ff` succeeded; worktree + branch pruned.                                             | `complete`         |
| `noop`      | Idempotent skip — prior merge already recorded in `.cleo/audit/worktree-integration.jsonl`.          | `complete-skip`    |
| `manual`    | `resolve: 'manual'` was set; merge skipped; worktree marked as manually-handled.                     | `complete-manual`  |
| `conflict`  | Auto-merge failed (rebase or merge conflict). Worktree preserved. No prune attempted.                | `complete-conflict`|

### Idempotency

`completeWorktreeForTask()` scans
`.cleo/audit/worktree-integration.jsonl` for a prior entry with
`taskId === <taskId>` and `merged === true`. When found:

- Writes a `complete-skip` row to the lifecycle audit log.
- Returns `outcome: 'noop'` with a reason describing the prior merge.
- Performs no git operations.

The check is best-effort — if the audit file is missing, unreadable, or
malformed, the function proceeds with the merge attempt. The underlying
`completeAgentWorktreeViaMerge` call is itself near-no-op when the
`task/<taskId>` branch is absent.

## 6. Hook Points for IVTR / Release Consumers

The lifecycle audit log
(`.cleo/audit/worktree-lifecycle.jsonl`) is the canonical stream that
downstream automation consumes. Each line is a
`WorktreeLifecycleAuditEntry`:

```jsonc
{
  "timestamp": "2026-05-18T11:07:00.000Z",
  "actor": "cleo-prime",
  "action": "prune" | "force-unlock" | "complete" | "complete-skip" | "complete-manual" | "complete-conflict",
  "target": "/abs/path/to/worktree",
  "branch": "task/T9549",
  "taskId": "T9549",
  "reason": "orphaned-merged",
  "success": true
}
```

Downstream consumers (in particular the release pipeline — see
`cleo release reconcile` from T9526) read this log to:

- Detect worktrees that never completed (no `complete` row for a `task/<id>`
  branch that has commits reachable from `main`).
- Detect orphan-cancelled worktrees that still hold a branch tip (the
  reconcile step decides whether to archive or hard-delete).
- Detect manual-handled worktrees (`complete-manual`) that need a
  release-note flag.

The integration log
(`.cleo/audit/worktree-integration.jsonl`, written by
`completeAgentWorktreeIntegration` in
`packages/core/src/spawn/branch-lock.ts`) is the lower-level companion
record — it captures the actual `git merge --no-ff` outcome and is the
source of truth for idempotency checks.

## 7. Recovery Paths

### 7.1 Orphan worktree (task done / cancelled / missing)

**Symptom:** `cleo worktree list` reports `statusCategory: 'orphan'`.

**Causes:**

- Task was cancelled with `cleo cancel <taskId>` while the worker had
  already started a worktree.
- Task row was deleted (rare — usually a database-restore scenario).
- Worker crashed after committing work; orchestrator gave up.

**Resolution:**

```bash
# 1. Inspect what's there before deletion
cleo worktree list --status orphan
cd ~/.local/share/cleo/worktrees/<projectHash>/<taskId>
git log --oneline                # see if there's recoverable work

# 2. If recoverable: cherry-pick / merge manually, then mark manual-handled
cleo orchestrate worktree-complete <taskId> --resolve manual

# 3. Otherwise: prune (the branch tip is preserved for orphan-cancelled,
#    deleted for orphan-missing-task — see prune.ts:reasonForStatus).
cleo worktree prune --orphaned --dry-run        # preview
cleo worktree prune --orphaned                  # acts after Y/N prompt
```

### 7.2 Wedged lock (`.git/index.lock` contention)

**Symptom:** `cleo worktree list` reports `statusCategory: 'locked'`, OR a
spawned worker hangs with `fatal: Unable to create '.../index.lock'`.

**Causes:**

- Git process crashed mid-mutation (most common — `git rebase` killed by
  signal, `git commit` killed by OOM).
- Two processes raced on the same worktree.
- The spawn flow's `git worktree lock` was applied but never paired with
  the matching unlock (orchestrator crashed between).

**Resolution:**

```bash
# Single command. Idempotent. Writes to audit log either way.
cleo worktree force-unlock <taskId>
```

Behavior (see `forceUnlockWorktree` in `force-unlock.ts`):

1. Resolves the worktree via `cleo worktree list` (single source of truth).
2. Removes `.git/index.lock` from BOTH the in-worktree proxy path
   (`<wt>/.git/index.lock`) AND the admin path resolved via
   `git rev-parse --git-dir` (`<admin>/worktrees/<name>/index.lock`).
3. Runs `git worktree unlock <path>` if porcelain reports the worktree as
   locked.
4. **Detects uncommitted changes but NEVER deletes them.** The audit row
   carries `reason: '…,uncommitted-changes-preserved'` so the operator
   knows to inspect `git status` before re-spawning.

If the operator's uncommitted changes were recoverable work, stash or commit
them first:

```bash
cd ~/.local/share/cleo/worktrees/<projectHash>/<taskId>
git stash                                     # OR git add . && git commit
cleo worktree force-unlock <taskId>           # then re-unlock cleanly
```

### 7.3 Merge conflict (worker → main)

**Symptom:** `cleo orchestrate worktree-complete <taskId>` (or the
auto-invocation) returns `outcome: 'conflict'`. The worktree is **preserved**
on disk. The audit log has a `complete-conflict` row.

**Causes:**

- The worker's branch and the default branch diverged on overlapping files
  (a parallel worker already merged a conflicting change).
- The worker rebased its own branch in a way that left stale conflict
  markers.

**Resolution:**

```bash
# 1. Enter the worktree and resolve manually
cd ~/.local/share/cleo/worktrees/<projectHash>/<taskId>
git status                          # see conflicted files
# … resolve conflicts in your editor …
git add <resolved-files>
git rebase --continue               # OR git commit (depending on state)

# 2. Push the resolution upstream
git push origin HEAD

# 3. Mark the worktree as manually handled
cleo orchestrate worktree-complete <taskId> --resolve manual
```

The `--resolve manual` invocation:

1. Skips the automatic `git merge --no-ff` attempt entirely.
2. Appends a `complete-manual` row to
   `.cleo/audit/worktree-lifecycle.jsonl`.
3. Returns `outcome: 'manual'` so downstream automation (release reconcile,
   IVTR consumers) can distinguish manually-handled worktrees from
   auto-merged ones.

The operator is responsible for ensuring the worktree contents have already
been integrated into the target branch before flipping the
`--resolve manual` switch. The audit row only records the operator's
assertion — it does not perform the integration itself.

## 8. Example: 5-Worker Parallel Orchestration

```
                 orchestrator (cleo-prime, on main)
                            │
        ┌───────────┬───────┼───────┬───────────┐
        ▼           ▼       ▼       ▼           ▼
  cleo orchestrate spawn T1  T2     T3      T4      T5
        │           │       │       │           │
        ▼           ▼       ▼       ▼           ▼
   wt/T1        wt/T2   wt/T3   wt/T4       wt/T5
   task/T1      task/T2 task/T3 task/T4     task/T5

  (each worker commits, tests, pushes inside its own worktree)
        │           │       │       │           │
   exit 0      exit 0  exit 0  exit 1     exit 0
        │           │       │       │           │
   (autoComplete fires for T1, T2, T3, T5; skipped for T4)
        │           │       │       │           │
        ▼           ▼       ▼       │           ▼
   merged       merged  merged  preserved    merged
   pruned       pruned  pruned  (operator    pruned
                                inspects)
```

The orchestrator's working directory **never** moves off `main`. Every
worker operates in its own worktree. After the wave, the orchestrator runs:

```bash
cleo worktree list                       # confirm only T4's worktree remains
cleo worktree list --status orphan       # if T4 was cancelled, it's here
# … remediation for T4 …
cleo worktree prune --orphaned           # cleanup
```

## 9. Cross-References

- **ADR-062** (`.cleo/adrs/ADR-062-worktree-merge-not-cherry-pick.md`) —
  canonical `git merge --no-ff` integration strategy. Supersedes the
  cherry-pick guidance from T1118.
- **ADR-055** — worktree-by-default agent isolation.
- **ADR-041** (`.cleo/adrs/ADR-041-worktree-handle-spawn-contract.md`) —
  worktree protocol: agents never touch the primary directory.
- **T9501** (`packages/core/src/release/engine-ops.ts`) — `runGitWithLockRetry`
  60-second timeout pattern that the worktree-lifecycle commands mirror.
- **T9545** (`packages/core/src/orchestrate/spawn-ops.ts`) — spawn pipeline
  timeout supervisor (`SPAWN_BUDGET_MS = 60_000`).
- **T9546** (`packages/core/src/worktree/list.ts`) — `cleo worktree list`
  + status classifier (`classifyStatus`).
- **T9547** (`packages/core/src/worktree/prune.ts`,
  `packages/core/src/worktree/force-unlock.ts`) — `cleo worktree prune`
  + `force-unlock`.
- **T9548** (`packages/core/src/orchestrate/worktree-complete.ts`) —
  auto-invoke worktree-complete post-success + idempotency + manual
  resolve mode.
- **T1118 / T1140** — original worktree-by-default spawn (legacy
  cherry-pick path; superseded by ADR-062).

## 10. FAQ

### Q: My worker finished and the worktree is gone. Where did my code go?

**A:** The auto-invoke (§5) ran `git merge --no-ff task/<taskId>` against
the default branch. Your commits are reachable from `main` with their
original SHAs and authorship intact. Check:

```bash
git log --grep "<taskId>" --oneline       # find your commits
git log --all --oneline -- <path>         # see history for a specific file
```

The audit log entry is in `.cleo/audit/worktree-lifecycle.jsonl` with
`action: 'complete'`.

### Q: My worker finished with exit code 0 but I want to inspect the worktree before merging. How do I disable auto-complete?

**A:** Pass `autoComplete: false` to `orchestrateSpawnExecute()`, or use
the CLI flag if available. After inspection, run:

```bash
cleo orchestrate worktree-complete <taskId>
```

manually. The function is idempotent (§5), so it's safe to re-run.

### Q: Why is the orphan branch tip preserved after `cleo worktree prune`?

**A:** Cancelled workers may have committed partial work that the operator
wants to recover. `removeWorktreeFromDisk()` in `prune.ts` only deletes the
local `task/<id>` branch when `isMerged === true`. Orphan-cancelled branches
keep their tip so a future investigator can run
`git log task/<id>`. If you're certain you don't need it:

```bash
git branch -D task/<taskId>
```

### Q: The auto-invoke returned `conflict`. Is my work lost?

**A:** No. The worktree is **preserved** on conflict (see §7.3). Your
commits are still on `task/<taskId>` inside the worktree. Resolve the
conflict manually, push, and mark with
`cleo orchestrate worktree-complete <taskId> --resolve manual`.

### Q: I see a worktree in `cleo worktree list` whose `taskId` is `null`. What is it?

**A:** A worktree on a non-task branch (e.g. `main`, a release branch, a
manually-created branch, or a detached HEAD). The lifecycle commands don't
touch it — `cleo worktree prune` only considers worktrees whose
`statusCategory` is `orphan` or `merged`, and `cleo worktree force-unlock`
requires a task ID. Manage non-task worktrees with plain `git worktree`.

### Q: Two orchestrators spawned workers on the same task. What happens?

**A:** Don't do this. The branch name `task/<taskId>` is a global lock — the
second `git worktree add` fails with `branch 'task/<taskId>' is already
checked out`. If you genuinely need parallel attempts at the same task,
create distinct task IDs (e.g. `T9549` and `T9549b`) and merge the chosen
winner manually.

### Q: My `.git/index.lock` keeps coming back after `cleo worktree force-unlock`.

**A:** Something is actively creating the lock. Check for a runaway git
process inside the worktree:

```bash
ps aux | grep git | grep <taskId>
```

Kill the offending process, THEN run `cleo worktree force-unlock <taskId>`.
The unlock command does not (and should not) kill processes.

### Q: How do I find the canonical worktree path for a given task?

**A:**

```bash
cleo worktree list --status active | grep <taskId>
# OR programmatically:
node -e "console.log(require('@cleocode/core').resolveAgentWorktreeRoot(process.cwd()))"
# … then join with <taskId>.
```

The path is deterministic — see §1 for the formula.

---

**Closes T9549. Closes T9515 epic (worktree-lifecycle bug-fix, 5 of 5).**
