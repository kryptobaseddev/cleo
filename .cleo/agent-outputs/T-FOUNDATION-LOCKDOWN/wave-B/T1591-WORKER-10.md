# T1591 — git-shim Boundary Fence (WORKER-10 · Wave B)

**Parent:** T1586 Foundation Lockdown
**Predecessor:** T1587 (ADR-062 + `completeAgentWorktreeViaMerge`)
**Date:** 2026-04-29
**Status:** Implementation complete; tests green; build green; lint clean.

---

## Audit Findings (current shim scope vs. T1591 requirements)

The pre-T1591 shim (T1118 / T1121, `packages/git-shim/src/{shim,denylist}.ts`)
is a **subcommand denylist**: branch-mutation ops (`checkout`, `switch`,
`reset --hard`, `rebase`, `push --force`, `worktree add/remove`, etc.) are
blocked when `CLEO_AGENT_ROLE ∈ {worker, lead, subagent}`. It does not
inspect the cwd, the path arguments, the commit message, or any
context-sensitive state. Bypass via `CLEO_ALLOW_BRANCH_OPS=1` warns to
stderr but never persists an audit record.

| Requirement | Pre-T1591 | Gap closed by this deliverable |
|---|---|---|
| (a) `git add` paths inside worktree | not enforced | `validateAddPaths` + `resolveActiveWorktree` |
| (b) `git commit` subject contains `T<NUM>` | not enforced | `validateCommitSubject` (anchored to active task ID when known) |
| (c) `git merge` only via `cleo orchestrate complete` | not enforced | `validateMergeAllowed` gated on `CLEO_ORCHESTRATE_MERGE=1` |
| (d) `git cherry-pick` refuses `task/T<NUM>` | not enforced | `validateCherryPickSource` (single + range refs) |
| Persistent audit log | none | `~/.local/share/cleo/audit/git-shim.jsonl` |
| Universal emergency bypass | none | `CLEO_ALLOW_GIT=1` (audited) |

Full audit doc: `.cleo/agent-outputs/T1591-git-shim-audit.md`.

---

## 4 Boundary Implementations

New modules under `packages/git-shim/src/`:

- **`worktree-path.ts`** — XDG-aware worktree resolution. Mirrors
  `core::resolveAgentWorktreeRoot` without taking a runtime dependency
  on `@cleocode/core` (the shim must stay lean — runs on every git
  invocation).
- **`boundary.ts`** — pure-function predicates for (a)/(b)/(c)/(d).
  Returns typed `BoundaryViolation` records. No I/O, no spawning.
- **`audit-log.ts`** — append-only JSONL writer at
  `<XDG>/cleo/audit/git-shim.jsonl`. Override via `CLEO_AUDIT_LOG_PATH`.
  Best-effort writes — never wedges a git invocation.
- **`shim.ts`** (extended) — wires the new boundaries after the legacy
  denylist check. Both blocks and bypasses produce audit records.

Cross-package integration:

- **`packages/core/src/spawn/branch-lock.ts`** — `completeAgentWorktreeViaMerge`
  now sets `CLEO_ORCHESTRATE_MERGE=1` in the env passed to the spawned
  `git merge --no-ff` so a PATH-shimmed orchestrator passes boundary (c).
- **`packages/git-shim/README.md`** — documents `CLEO_ORCHESTRATE_MERGE`
  contract for future maintainers; lists every env var; describes the
  defense-in-depth pipeline (T1588 hooks + T1591 shim + T1594 watchdog +
  T1595 push reconcile + T1598 sync linter).

---

## Test Results

```
Test Files  2 passed (git-shim) + 1 passed (worktree-merge regression)
Tests       71 git-shim (38 legacy denylist + 33 boundary + audit + project-agnostic)
            8  T1587 worktree-merge (regression-free)
            ─────
            79 total
```

`packages/git-shim/src/__tests__/boundary-enforcement.test.ts` covers:

- `worktree-path` resolution: 7 tests (XDG paths, walk-up, env override)
- Boundary (a): 5 tests (allow `.`, allow inside, allow `-A`, refuse abs
  `/etc/passwd`, refuse `../../escape`)
- Boundary (b): 5 tests (allow `T<NUM>`, refuse missing, anchor to expected
  ID, `--message=` syntax, editor flow passthrough)
- Boundary (c): 4 tests (refuse default, allow with env, allow `--abort/--continue/--quit`, refuse non-`"1"` env value)
- Boundary (d): 6 tests (refuse `task/T<NUM>`, refuse `..` range, refuse `...` range, allow regular branch, allow SHA, allow `HEAD~3`)
- Audit log: 4 tests (path override, default path, persists JSONL, append semantics)
- Project-agnostic: 2 tests (no `cleocode` literal in worktree paths or audit-log default)

`pnpm exec tsc -b packages/git-shim packages/core` exits 0.
`pnpm exec biome check packages/git-shim/src/ packages/core/src/spawn/branch-lock.ts` reports no errors.

---

## Override Env Vars + Audit Log Path

| Variable | Purpose | Audited? |
|---|---|---|
| `CLEO_ALLOW_GIT=1` | Universal bypass for any T1591 boundary block | yes — outcome `bypassed-allow-git` |
| `CLEO_ALLOW_BRANCH_OPS=1` | Legacy single-shot bypass for the T1118 denylist | yes — outcome `bypassed-allow-git` (boundary `denylist`) |
| `CLEO_ORCHESTRATE_MERGE=1` | Single-purpose grant for `git merge` (T1587 integration) | not audited as bypass — boundary (c) treats it as the sanctioned signal |
| `CLEO_AUDIT_LOG_PATH` | Test/owner override for audit file location | n/a |
| `CLEO_TASK_ID` | Hint for active task when not derivable from cwd | n/a |
| `CLEO_WORKTREE_ROOT` | Hint for active worktree path | n/a |

**Audit log:** `~/.local/share/cleo/audit/git-shim.jsonl` (or
`$XDG_DATA_HOME/cleo/audit/git-shim.jsonl`). Records every block AND every
bypass with full context (cwd, worktree, task_id, role, args).

---

## Project-Agnostic Verification

- Worktree path uses sha256(projectRoot)[:16] under
  `<XDG>/cleo/worktrees/` — same algorithm as
  `core::resolveAgentWorktreeRoot`.
- Audit log lives under `<XDG>/cleo/audit/` — identical XDG convention.
- T-ID regex `T\d+` is the CLEO project-agnostic convention; `task/T\d+`
  is the canonical worktree branch pattern (set by `branch-lock.ts:162`).
- No string `"cleocode"` in any new code path. Tests assert this via
  `path.includes('cleocode') === false`.
- Default branch resolution (for ADR-062 merges) stays in
  `branch-lock.ts::getDefaultBranch` (already project-agnostic per
  ADR-062 §"Project-agnostic verification").

---

## Files Touched

Created:

- `packages/git-shim/src/worktree-path.ts`
- `packages/git-shim/src/boundary.ts`
- `packages/git-shim/src/audit-log.ts`
- `packages/git-shim/src/__tests__/boundary-enforcement.test.ts`
- `packages/git-shim/README.md`
- `.cleo/agent-outputs/T1591-git-shim-audit.md`

Edited:

- `packages/git-shim/src/shim.ts` (T1591 boundary fence wired in after
  legacy denylist check)
- `packages/git-shim/src/index.ts` (re-exports for new modules)
- `packages/core/src/spawn/branch-lock.ts` (`completeAgentWorktreeViaMerge`
  now sets `CLEO_ORCHESTRATE_MERGE=1` on the spawned `git merge` env)

---

## Coordination Notes

- **T1588** (commit-msg hook, `core/git/`) and **T1591** (this) overlap
  on commit-subject T-ID enforcement. This is intentional defense in
  depth — the shim catches commits **before** the hook runs and protects
  agents that disable hooks.
- **T1594/T1595/T1598** are independent enforcement layers (file-system
  drift, push reconcile, sync linter). The shim audit log can be a
  data source for those layers (`jq 'select(.outcome == "blocked")'`).
- The shim explicitly does NOT take a `@cleocode/core` runtime dep —
  worktree-path resolution is duplicated (intentionally) so the shim
  stays under 200 lines and starts in <50ms on any platform.
