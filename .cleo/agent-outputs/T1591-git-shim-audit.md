# T1591 — git-shim Audit + 4-Boundary Extension

**Task:** T1591 (parent T1586 — Foundation Lockdown · Wave B)
**Date:** 2026-04-29
**Worker:** Foundation-Worker-10
**Predecessor:** T1587 (ADR-062 + `completeAgentWorktreeViaMerge`)

---

## 1. Current Shim Scope (T1118 / T1121 baseline)

The shim at `packages/git-shim/src/shim.ts` is a `git` PATH override:

| Aspect | Behaviour |
|---|---|
| **Activation gate** | `CLEO_AGENT_ROLE ∈ {worker, lead, subagent}` (orchestrators bypass) |
| **Mode** | Subcommand denylist (`packages/git-shim/src/denylist.ts`) |
| **Coverage** | Branch-mutation ops only — checkout, switch, branch -b/-D/-m, worktree add/remove, reset --hard, clean -f, rebase, stash pop/apply, update-ref, push --force |
| **Escape hatch** | `CLEO_ALLOW_BRANCH_OPS=1` (single-shot, audited via stderr warning only) |
| **Audit log** | NONE — bypasses are warned to stderr but never persisted |
| **Path awareness** | NONE — shim does not inspect `cwd` against worktree boundary |
| **Commit-message validation** | NONE — `git commit` is wholly allowlisted |
| **Merge enforcement** | NONE — `git merge` is wholly allowlisted (gap discovered post-T1587) |
| **Cherry-pick refusal** | NONE — `git cherry-pick` is wholly allowlisted (gap discovered post-T1587 / ADR-062) |

The shim is a **subcommand fence**, not a **boundary fence**. It blocks classes of operations regardless of context (cwd, branch, ref). T1587's ADR-062 introduced contextual rules the shim cannot currently express.

### Spawn-prompt claim vs. shim reality

`packages/core/src/orchestration/spawn-prompt.ts` emits a `## Worktree Setup (REQUIRED)` section that promises:

> All reads, writes, and git operations MUST occur inside the worktree boundary. A git shim on the PATH blocks forbidden operations (checkout, switch, force-push, etc.).

Today the shim only blocks **listed subcommands**. The promise of "all writes inside the worktree boundary" is **enforced socially, not programmatically**. T1591 closes that gap.

---

## 2. Gaps Relative to T1591 Requirements

| # | Required boundary | Current state | Gap |
|---|---|---|---|
| **(a)** | Refuse writes outside agent worktree path | Not enforced | Shim never inspects cwd / staged paths |
| **(b)** | Refuse commits without T-ID in subject | Not enforced | `git commit` passes through unconditionally |
| **(c)** | Refuse merge except via `cleo orchestrate complete` | Not enforced | `git merge` passes through unconditionally |
| **(d)** | Refuse cherry-pick from `task/T<NUM>` branches | Not enforced | `git cherry-pick` passes through unconditionally |

Plus structural gaps:

- No persistent audit trail. Bypasses leave only stderr noise — no jsonl record.
- No env-paths-derived audit log location (project-agnostic).
- No documentation of `CLEO_ORCHESTRATE_MERGE` contract (T1587 integration point).

---

## 3. Recommended Shim Extensions (this deliverable)

Five new modules under `packages/git-shim/src/` (all under restricted-role gate):

1. **`worktree-path.ts`** — derive expected worktree root via env-paths (`XDG_DATA_HOME ?? ~/.local/share`) + `<projectHash>/<taskId>`. Detect "inside worktree?" based on `process.cwd()`. Mirror logic in `packages/core/src/spawn/branch-lock.ts::resolveAgentWorktreeRoot` so cleo-os and the shim agree on layout.
2. **`boundary.ts`** — pure boundary-check predicates (no I/O):
   - `isInsideWorktree(cwd, worktreeRoot)` — path containment check.
   - `validateAddPaths(args, worktreeRoot, cwd)` — rejects `git add <path>` when `<path>` resolves outside worktree.
   - `validateCommitSubject(args, taskId)` — rejects `git commit -m "<msg>"` when subject lacks `T<NUM>`.
   - `validateMergeAllowed(env)` — rejects `git merge` unless `CLEO_ORCHESTRATE_MERGE === '1'`.
   - `validateCherryPickSource(args)` — rejects `git cherry-pick <ref>` when `<ref>` matches `task/T<NUM>`.
3. **`audit-log.ts`** — append-only jsonl writer at `~/.local/share/cleo/audit/git-shim.jsonl` (env-paths-aware). Records every block AND every bypass.
4. **Wire into `shim.ts`** — call boundary validators before passthrough; call audit on block/bypass.
5. **Update `branch-lock.ts::completeAgentWorktreeViaMerge`** to set `CLEO_ORCHESTRATE_MERGE=1` in the spawned `git merge` env so orchestrator integration passes shim. (Also: documentation in README.)

### Override hierarchy

- `CLEO_ALLOW_BRANCH_OPS=1` — legacy single-shot bypass for original denylist (kept).
- `CLEO_ALLOW_GIT=1` — **NEW** universal bypass for any T1591 boundary block. Used for emergency operator intervention; every use writes an audit entry.
- `CLEO_ORCHESTRATE_MERGE=1` — **NEW** scoped grant for `git merge` only. Set automatically by `completeAgentWorktreeViaMerge`. Single-purpose, NOT a general escape hatch.

### Project-agnostic guarantees

- Worktree root derived via XDG/env-paths — works on any project, not just cleocode.
- Task-ID detection via `CLEO_TASK_ID` env or last segment of the worktree path — no project-specific regexes.
- Audit log under `~/.local/share/cleo/audit/` — same env-paths convention as worktrees.
- T-ID regex `T\d+` is a CLEO convention, not a project name — applies to any CLEO-managed project.
- Default branch resolution stays in `branch-lock.ts::getDefaultBranch` (already project-agnostic per ADR-062).

---

## 4. Test Strategy

`packages/git-shim/src/__tests__/boundary-enforcement.test.ts`:

- Pure-function tests for each predicate (no spawning real git).
- Fixture worktree tree under `tmpdir/<fakeProject>/<projectHash>/T<id>/` — verifies project-agnostic path resolution.
- Audit log writes to a tmpdir override (`CLEO_AUDIT_LOG_PATH`).
- Override env vars (`CLEO_ALLOW_GIT=1`, `CLEO_ORCHESTRATE_MERGE=1`) verified to bypass and emit audit.

All 38 existing denylist tests preserved.

---

## 5. Defense-in-Depth Pipeline

T1591 (this work) is the **git-binary layer**. It complements:

- **T1588** (commit-msg hook) — user-side hook layer (different package, `packages/core/git/`).
- **T1594** (drift watchdog) — file-system layer (independent of git).
- **T1595** (pre-push reconcile) — push layer (server-side hook).
- **T1598** (sync linter) — review-time layer (CI).

Both T1588 and T1591 enforce the commit-subject-T-ID rule. Redundant by design — different failure modes (developer disables hook ⇒ shim still catches).
