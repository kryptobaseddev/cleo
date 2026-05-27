# Worktree Lifecycle Specification

> **Task:** T9549 — closes the E1 5-task chain.
> **Epic:** T10192 — Worktree Lifecycle (5 of 5).
> **Saga:** T10176 (`SG-BOUNDARY-REGISTRY`) — Decision D010.
> **Status:** Stable. Canonical contract — supersedes all prior worktree lifecycle prose.
> **Scope:** Applies to all CLEO-spawned worktrees AND adopted worktrees
> registered via `cleo worktree adopt`.
> **Routing:** Published via `cleo docs add` per ADR-076 (Canonical Docs SSoT).
> Slug: `worktree-lifecycle-spec`.

This document is the canonical contract for how CLEO provisions, manages,
inspects, completes, and recovers git worktrees used by spawned agent
workers. Every command, audit action, and recovery procedure described here
maps to source that has already landed on `main`.

### Implementing PRs (T10176 chain)

| Task  | Topic                                          | T10176 PR  | Prior PR    |
|-------|------------------------------------------------|------------|-------------|
| T9545 | Spawn supervisor — bounded timeout + cleanup    | [#505](https://github.com/kryptobaseddev/cleo/pull/505) | [#229](https://github.com/kryptobaseddev/cleo/pull/229) |
| T9546 | `cleo worktree list` with structured envelope   | [#512](https://github.com/kryptobaseddev/cleo/pull/512) | [#230](https://github.com/kryptobaseddev/cleo/pull/230) |
| T9547 | `cleo worktree prune` + `force-unlock`          | [#523](https://github.com/kryptobaseddev/cleo/pull/523) | [#237](https://github.com/kryptobaseddev/cleo/pull/237) |
| T9548 | Auto-invoke worktree-complete post-success      | [#527](https://github.com/kryptobaseddev/cleo/pull/527) | [#242](https://github.com/kryptobaseddev/cleo/pull/242) |
| T9549 | This document                                   | _under T10176_ | [#244](https://github.com/kryptobaseddev/cleo/pull/244) |

The May-18 PRs (#229, #230, #237, #242, #244) landed the E1 chain under the
original T9515 epic. The May-23 PRs (#505, #512, #523, #527) re-shipped the
same surface area under the boundary-registry saga (T10176), bringing the
implementation up to the current contract.

## 0. Definitions

| Term                     | Definition                                                                                       |
|--------------------------|--------------------------------------------------------------------------------------------------|
| **Canonical worktree**   | A worktree under `<cleoHome>/worktrees/<projectHash>/<taskId>/`. ADR-055 forbids any other location. |
| **Owning task**          | The task ID extracted from the worktree's branch (`task/T####` pattern) or `null` for non-task branches. |
| **`source`**             | Provenance of the worktree. One of `cleo-spawn` (created by `cleo orchestrate spawn`), `claude-agent` (created by Claude Code Agent `isolation:worktree`, adopted post-hoc), or `manual` (operator-created, adopted explicitly). |
| **`statusCategory`**     | Mutually-exclusive classification computed by `cleo worktree list`. One of `active`, `stale`, `merged`, `orphan`, `locked`. |
| **`lockState`**          | Whether the worktree is locked at the porcelain level (`git worktree lock <path>`) and/or has a wedged `.git/index.lock`. |
| **Audit log**            | `.cleo/audit/worktree-lifecycle.jsonl` — append-only JSONL, one record per lifecycle action. |
| **Integration log**      | `.cleo/audit/worktree-integration.jsonl` — append-only JSONL written by `completeAgentWorktreeIntegration`. Records the actual `git merge --no-ff` outcome. |
| **Sentinel index**       | `.cleo/worktrees.json` — per-project, advisory sentinel for adopted worktrees (council D009 hybrid). |
| **`projectHash`**        | `sha256(<projectRoot>).slice(0, 16)`. Stable per project root, unique across machines and clones. |
| **`bindingSource`**      | Hint for downstream consumers that a worktree was bound via the `saga.groups` mechanism (the relation_type='groups' edge in `task_relations` per ADR-073). |
| **`CLEANUP_BUDGET_MS`**  | 5000 ms ceiling for the spawn supervisor's partial-state unwind path (T9545). |
| **`SPAWN_BUDGET_MS`**    | 60000 ms ceiling for the entire `cleo orchestrate spawn` flow (T9545). |
| **`GIT_TIMEOUT_MS`**     | 60000 ms ceiling for each git subprocess in `list.ts`, `prune.ts`, `force-unlock.ts`. |

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

## 9. Adoption Flow (Adopted Worktrees)

Claude Code Agent spawns with `isolation:worktree` create directories under
`.claude/worktrees/<sessionId>/` **outside** the CLEO SSoT. These bypass
`cleo orchestrate spawn` entirely. To bring them into the lifecycle contract,
operators (or the agent itself) MUST adopt them post-hoc.

```bash
# Register a Claude Code Agent worktree in the CLEO SSoT
cleo worktree adopt .claude/worktrees/<sessionId>

# With explicit source classification
cleo worktree adopt .claude/worktrees/<sessionId> --source claude-agent

# With explicit task ID association
cleo worktree adopt /path/to/worktree --source manual --task-id T9549
```

After adoption:

- The worktree appears in `cleo worktree list` tagged with the chosen
  `source` value.
- An audit entry is appended to `.cleo/audit/worktree-lifecycle.jsonl`.
- The worktree is subject to the same auto-cleanup rules as
  CLEO-spawned worktrees.
- The adoption is recorded in `.cleo/worktrees.json` (advisory sentinel —
  integrity does NOT depend on this file; the porcelain remains the source
  of truth).

Adopted worktrees are still subject to the canonical-path requirement
(§1, §10.MUST-1): if the adopted path is outside the canonical XDG root,
`cleo worktree adopt` MUST fail with a clear error so the operator can move
the directory before retrying.

## 10. Normative Requirements (RFC 2119)

The following requirements use [RFC 2119][rfc2119] terms: MUST, MUST NOT,
SHOULD, SHOULD NOT, MAY. Any implementation that claims to follow this
specification MUST satisfy every MUST and MUST NOT.

[rfc2119]: https://datatracker.ietf.org/doc/html/rfc2119

### Provisioning (`cleo orchestrate spawn`)

- **MUST-1.** Every CLEO-spawned worktree MUST live under
  `<cleoHome>/worktrees/<projectHash>/<taskId>/`. Implementations MUST
  reject any other path with `E_WT_LOCATION_FORBIDDEN` BEFORE invoking
  `git worktree add`. (ADR-055 / D009.)
- **MUST-2.** The branch name MUST follow the `task/<taskId>` convention
  (e.g. `task/T9549`). The branch MUST be created from the project's
  default branch tip (typically `origin/main`).
- **MUST-3.** The spawn flow MUST be bounded by `SPAWN_BUDGET_MS = 60_000`
  ms. On timeout, the implementation MUST attempt cleanup of any
  partially-created state within `CLEANUP_BUDGET_MS = 5_000` ms.
- **MUST-4.** On spawn timeout or non-cleanup failure, the returned error
  envelope MUST carry `E_TIMEOUT` (or a similarly explicit code) and SHOULD
  include the resolved worktree path so the operator can inspect partial
  state.
- **MUST-5.** A successful spawn MUST issue `git worktree lock <path>` so
  the worktree is not accidentally pruned by `git worktree prune`.
- **SHOULD-1.** The spawn implementation SHOULD record provisioning success
  via an audit entry in `.cleo/audit/worktree-lifecycle.jsonl`.

### Listing (`cleo worktree list`)

- **MUST-6.** `cleo worktree list` MUST return a structured envelope. Every
  entry MUST include `path`, `branch`, `taskId` (nullable),
  `statusCategory`, `isLocked`, `isOrphan`, `isMerged`, `isStale`, and
  `source`.
- **MUST-7.** `statusCategory` MUST be exactly one of `active`, `stale`,
  `merged`, `orphan`, `locked`. The resolution order (locked → orphan →
  merged → stale → active) MUST be honored — implementations MUST NOT
  reorder it.
- **MUST-8.** When a worktree was bound via the saga `groups` relation,
  the entry MUST surface `bindingSource: 'saga.groups'` so downstream
  consumers can distinguish task-parented worktrees from saga-grouped
  worktrees.
- **MAY-1.** Implementations MAY accept `--status`, `--stale-days`, and
  `--source` filters on the CLI surface. They MUST NOT alter the
  classification rules.

### Prune (`cleo worktree prune --orphaned`)

- **MUST-9.** Prune MUST only remove worktrees whose `statusCategory` is
  `orphan` or `merged`. Prune MUST NOT touch `active`, `stale`, or
  `locked` worktrees.
- **MUST-10.** Prune MUST support a `--dry-run` mode that lists candidates
  without mutating state.
- **MUST-11.** Without `--yes`, prune MUST prompt for confirmation per
  orphan and MUST honor a per-orphan N response by skipping that
  worktree only.
- **MUST-12.** For `orphan-cancelled` worktrees, prune MUST preserve the
  local `task/<id>` branch tip. For `merged` worktrees, prune MUST delete
  the local `task/<id>` branch.
- **MUST-13.** Prune MUST append one audit entry per acted-on worktree to
  `.cleo/audit/worktree-lifecycle.jsonl` with `action: 'prune'`.

### Force-unlock (`cleo worktree force-unlock`)

- **MUST-14.** Force-unlock MUST be idempotent — re-invoking on an
  already-unlocked worktree MUST succeed with a `reason` indicating no
  action was needed.
- **MUST-15.** Force-unlock MUST remove `.git/index.lock` from BOTH the
  in-worktree proxy path AND the admin path resolved via
  `git rev-parse --git-dir`.
- **MUST-16.** Force-unlock MUST NOT delete uncommitted changes in the
  worktree. When uncommitted changes exist, the audit entry MUST include
  `uncommitted-changes-preserved` in the `reason` field.
- **MUST-17.** Force-unlock MUST NOT kill running git processes. Operators
  are responsible for terminating runaway processes BEFORE invoking
  force-unlock.

### Auto-complete (`cleo orchestrate worktree-complete`)

- **MUST-18.** When `exitCode === 0` AND `opts.autoComplete !== false`,
  the spawn flow MUST attempt `completeWorktreeForTask` post-success.
- **MUST-19.** When the environment variable `CLEO_NO_AUTO_WORKTREE_COMPLETE=1`
  is set, the spawn flow MUST skip auto-completion AND append a
  `complete-skip` audit entry with `reason: 'env-override'`.
- **MUST-20.** Auto-completion MUST be idempotent. Implementations MUST
  scan `.cleo/audit/worktree-integration.jsonl` for a prior entry with
  the same `taskId` AND `merged === true` BEFORE attempting the merge.
  When found, the implementation MUST return `outcome: 'noop'` and append
  `complete-skip` to the lifecycle audit log.
- **MUST-21.** Integration MUST use `git merge --no-ff task/<taskId>`
  against the default branch. Implementations MUST NOT use
  `git cherry-pick` for this path (ADR-062).
- **MUST-22.** On merge conflict, implementations MUST preserve the
  worktree on disk and MUST append a `complete-conflict` audit entry.
  The worktree MUST NOT be pruned.
- **MUST-23.** The `--resolve manual` flag MUST skip the automatic merge
  attempt entirely and MUST append `complete-manual` to the audit log.
- **MUST-24.** Auto-completion MUST be best-effort with respect to the
  spawn envelope — a failure in the completion SDK import or invocation
  MUST NOT block the spawn envelope from returning to the caller.

### Audit + Adoption

- **MUST-25.** Every lifecycle action (`prune`, `force-unlock`,
  `complete`, `complete-skip`, `complete-manual`, `complete-conflict`,
  `adopt`) MUST append exactly one line to
  `.cleo/audit/worktree-lifecycle.jsonl`. The file MUST be append-only.
- **MUST-26.** Audit entries MUST be valid JSON Lines (one object per
  line, no embedded newlines).
- **MUST-27.** `cleo worktree adopt` MUST reject paths outside the
  canonical XDG worktree root with a clear error (per MUST-1).
- **SHOULD-2.** Adoption SHOULD record the adopted path in the sentinel
  index `.cleo/worktrees.json`. Implementations MUST treat the sentinel
  as advisory — porcelain (`git worktree list --porcelain`) remains the
  source of truth.

### Operator Behavior

- **MUST-28.** Agents that use `isolation:worktree` MUST call
  `cleo worktree adopt` if they want the worktree to surface in
  `cleo worktree list` and receive lifecycle cleanup hooks.
- **SHOULD-3.** Operators SHOULD run `cleo worktree list` before declaring
  any release cycle "clean".
- **SHOULD-4.** Operators SHOULD prefer `cleo worktree prune --orphaned`
  to manual `git worktree remove` invocations so that audit traceability
  is preserved.
- **MAY-2.** Operators MAY manage non-task worktrees (e.g. `main`, release
  branches) directly with plain `git worktree`. Lifecycle commands MUST
  NOT touch worktrees with `taskId === null`.

## 11. Cross-References

- **ADR-055** (`.cleo/adrs/ADR-055-agents-architecture-and-meta-agents.md`) —
  worktree-by-default agent isolation. Establishes the canonical XDG
  worktree location and the `E_WT_LOCATION_FORBIDDEN` guard.
- **ADR-062** (`.cleo/adrs/ADR-062-worktree-merge-not-cherry-pick.md`) —
  canonical `git merge --no-ff` integration strategy. Supersedes the
  cherry-pick guidance from T1118.
- **ADR-076** — Canonical Docs SSoT. This document is routed via
  `cleo docs add --type spec --slug worktree-lifecycle-spec`.
- **ADR-041** (`.cleo/adrs/ADR-041-worktree-handle-spawn-contract.md`) —
  worktree protocol: agents never touch the primary directory.
- **T9501** (`packages/core/src/release/engine-ops.ts`) — `runGitWithLockRetry`
  60-second timeout pattern that the worktree-lifecycle commands mirror.
- **T9545** (`packages/core/src/orchestrate/spawn-ops.ts`) — spawn pipeline
  timeout supervisor (`SPAWN_BUDGET_MS = 60_000`). PR
  [#505](https://github.com/kryptobaseddev/cleo/pull/505).
- **T9546** (`packages/core/src/worktree/list.ts`) — `cleo worktree list`
  + status classifier (`classifyStatus`). PR
  [#512](https://github.com/kryptobaseddev/cleo/pull/512).
- **T9547** (`packages/core/src/worktree/prune.ts`,
  `packages/core/src/worktree/force-unlock.ts`) — `cleo worktree prune`
  + `force-unlock`. PR
  [#523](https://github.com/kryptobaseddev/cleo/pull/523).
- **T9548** (`packages/core/src/orchestrate/worktree-complete.ts`) —
  auto-invoke worktree-complete post-success + idempotency + manual
  resolve mode. PR
  [#527](https://github.com/kryptobaseddev/cleo/pull/527).
- **T10176** — Saga `SG-BOUNDARY-REGISTRY`. Boundary-registry tracking
  saga under which the E1 chain re-shipped in May 2026.
- **T10192** — Epic owning T9549 (this document).
- **T1118 / T1140** — original worktree-by-default spawn (legacy
  cherry-pick path; superseded by ADR-062).

## 12. FAQ

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
