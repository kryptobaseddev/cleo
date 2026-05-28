# ADR-051 — Worktree Extension: Evidence Validation in Git Worktree Contexts

**Status**: ACCEPTED
**Date**: 2026-05-18
**Task**: T9605 (T-WT-6)
**Epic**: T9586 (E-WORKTREE-IVTR)
**Saga**: T9585 (SG-CLEO-CORE-V2)
**Augments**: ADR-051 (Programmatic Gate Integrity)
**Supersedes**: nothing
**Relates to**: ADR-041 §D3 (ALS worktree scope bridge), ADR-055 (agents architecture)

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
RFC 2119.

---

## Context

ADR-051 established evidence-based gate integrity for `cleo verify`. Its implementation assumed
that the CLI always runs in the canonical project root (`/mnt/projects/cleocode` or equivalent),
where `HEAD` points to the current main branch tip and `tasks.db` is the authoritative record.

ADR-055 and ADR-041 §D3 introduced the worktree-by-default spawn model: every
`cleo orchestrate spawn <taskId>` provisions a git worktree at
`~/.local/share/cleo/worktrees/<projectHash>/<taskId>/` with its own `HEAD` pointing to
`task/<taskId>`. The spawned agent is expected to commit on this branch, then call
`cleo verify <taskId> --gate implemented --evidence "commit:<sha>;files:<paths>"`.

ADR-051's `validateCommit` implementation was written before the worktree spawn model existed.
Two structural assumptions it made are violated in the IVTR worker context:

1. `HEAD` in `getProjectRoot()` output refers to the main branch tip — not the worker's branch.
2. The `tasks.db` at `getProjectRoot()` output is the live canonical database — not a
   point-in-time spawn snapshot.

These assumptions produce hard failures that block every IVTR worker from completing the
`implemented` gate.

---

## Bugs

### Bug A — HEAD-Ancestry Check Against Main Branch HEAD

**File**: `packages/core/src/tasks/evidence.ts:468-478`

`validateCommit` runs:

```ts
const reachable = await runCommand(
  'git',
  ['merge-base', '--is-ancestor', sha, 'HEAD'],
  projectRoot,
);
```

When `CLEO_WORKTREE_ROOT` is absent (or the AsyncLocalStorage bridge is not active),
`getProjectRoot()` falls through to its step-2.5 gitlink-detection path and returns the
main repository root. The `git merge-base --is-ancestor <sha> HEAD` command then runs with
`cwd` = main repo, where `HEAD` = main branch tip.

A commit on `task/<taskId>` — the entire purpose of the IVTR workflow — is by construction
NOT an ancestor of the main branch HEAD until the PR is merged. Every call returns exit code 1,
producing:

```
E_EVIDENCE_INVALID: Commit <sha> exists but is not reachable from HEAD
```

This makes every IVTR `implemented` gate verification fail before the PR is merged, which is
exactly when agents need to verify (as proof their branch work is complete).

**Trigger condition**: `CLEO_WORKTREE_ROOT` not inherited by a subprocess, harness adapter
does not inject it, or the agent runs `cleo verify` in a child process that loses the env var.

### Bug B — T9178 Branch-Scope Check Uses Same Wrong `projectRoot` (Latent)

**File**: `packages/core/src/tasks/evidence.ts:486-502`

The T9178 branch-scope check also uses `projectRoot` for `git rev-parse --verify task/<taskId>`.
When `projectRoot` resolves to the main repo, this check happens to work correctly because git
branch refs are accessible from the main gitdir regardless of which directory is used as `cwd`.
The object store is shared.

This is architecturally wrong but not currently a blocker — it works by accident because git
stores all branch refs in the main gitdir. Future changes that relocate the git operations or
use a different git process model could break this assumption silently.

**Current impact**: None (passes correctly). Documented for future callers.

### Bug C — Content-Intersect Reads Stale `tasks.db` When ALS Is Active

**File**: `packages/core/src/tasks/evidence.ts:627-685`

`checkCommitContentIntersect` reads task metadata via:

```ts
const accessor = await getTaskAccessor(projectRoot);
task = await accessor.loadSingleTask(taskId);
```

When `CLEO_WORKTREE_ROOT` IS set and the ALS bridge is active, `getProjectRoot()` returns the
worktree path (step 0 of resolution). The worktree's `.cleo/tasks.db` is a point-in-time copy
made during spawn (`packages/worktree/src/worktree-create.ts` bootstrap step). This copy is
frozen at spawn time and receives no subsequent writes.

Two failure modes arise:

**False failure**: The spawned task had `acceptance` strings updated post-spawn by the
orchestrator (e.g., to narrow the AC file scope). The stale DB holds the old `acceptance`
value. `extractTaskAcFiles` derives a different `acFiles` list than the live DB would produce.
If the new AC paths are a subset of what the commit touched, `diffIntersectsAc` returns `false`
even though the commit correctly satisfies the current AC.

**Security regression (vacuous pass)**: More commonly, the stale DB has `task.files = []`
and the orchestrator added files post-spawn via `cleo update T### --files <paths>`. The stale
DB produces `acFiles = null` (no paths). `checkCommitContentIntersect` returns `ok: true`
vacuously — the T9245 content-intersect hardening is silently bypassed for all correctly-spawned
IVTR workers.

---

## Decision

### Decision 1: `getEffectiveHead` Primitive in `packages/core/src/worktree/`

A new exported function `getEffectiveHead(projectRoot: string, taskId?: string): Promise<string>`
MUST be placed at `packages/core/src/worktree/effective-head.ts`.

When `taskId` is provided and `git rev-parse --verify task/<taskId>` exits 0, it returns
`"task/<taskId>"`. This is the semantically correct ancestry target: "is this commit reachable
from the agent's branch?"

When `taskId` is absent, the task branch does not exist, or the git command fails, it returns
`"HEAD"`. This preserves existing behavior for all legacy callers.

The function is intentionally narrow: it resolves a ref string, makes no DB calls, has no
side effects, and is safe to call from any context.

**Reference**: `docs/plans/E-WORKTREE-IVTR.md §3.1`, task T-WT-1.

### Decision 2: Wire `getEffectiveHead` into `validateCommit`

`validateCommit` MUST replace the `'HEAD'` literal with
`await getEffectiveHead(projectRoot, taskId)`. The error message MUST include the resolved ref
name so agents can diagnose failures (e.g., `"not reachable from task/T9605"`).

This fix is env-var-independent: `getEffectiveHead` uses `git rev-parse --verify task/<taskId>`
to determine the effective HEAD directly, without relying on `CLEO_WORKTREE_ROOT` or the ALS
scope being active. Bug A is eliminated regardless of whether the harness injects the env var.

**Reference**: `docs/plans/E-WORKTREE-IVTR.md §3.2`, task T-WT-3.

### Decision 3: `resolveCanonicalProjectRoot` for DB Reads

`checkCommitContentIntersect` MUST derive the canonical main repository root before opening
`tasks.db`. A new helper `resolveCanonicalProjectRoot(projectRoot: string): string` (synchronous)
MUST be defined in `packages/core/src/tasks/evidence.ts` or an adjacent module.

The helper inspects `<projectRoot>/.git`: if it is a regular file (gitlink), it parses the
`gitdir:` path, strips three trailing path components, and returns the resulting main repo root,
provided `.cleo/` exists there. If `.git` is a directory (already main repo) or parsing fails,
it returns `projectRoot` unchanged.

`checkCommitContentIntersect` MUST use `canonicalRoot` (from `resolveCanonicalProjectRoot`) for
`getTaskAccessor()`. It MUST continue to use `projectRoot` (not `canonicalRoot`) for
`gitShowFiles()` git operations — git correctly resolves commits from any directory sharing the
object store, and using the worktree path as `cwd` is valid.

**Reference**: `docs/plans/E-WORKTREE-IVTR.md §3.3`, task T-WT-2.

### Decision 4: Main DB Is Authoritative for Gate Verification

The worktree's `.cleo/tasks.db` is a bootstrap convenience for worker-local commands (`cleo show`,
`cleo focus`, `cleo next`). It is NOT authoritative for gate verification.

`cleo verify` MUST always read task metadata from the canonical main repository's `tasks.db`
regardless of `getProjectRoot()` resolution. This prevents the Bug C vacuous-pass security
regression and eliminates false-failure divergence.

**Reference**: `docs/plans/E-WORKTREE-IVTR.md §2.1 D-WT-05`.

---

## Implications

### Future Callers of `validateCommit`

Any future caller that invokes `validateCommit` (directly or through `validateAtom`) in a
worktree context MUST be aware that:

- The `projectRoot` parameter is used as the `cwd` for all git operations. Git correctly
  resolves commits and branch refs from any directory sharing the object store.
- The `taskId` parameter is required to get correct ancestry behavior in the worktree model.
  Callers that omit `taskId` will continue to check `HEAD` in `projectRoot`, which may be the
  main branch tip. This is the backward-compatible fallback (REQ-11).
- After this fix, `validateCommit` without `taskId` behaves identically to today for the
  ancestry check. The `taskId`-absent path is unchanged.

### Orchestrator-Stays-on-Main Rule Unchanged

ADR-055 §D3 requires the orchestrator to remain on the main branch. This extension does not
affect the orchestrator's behavior. Orchestrator-driven `cleo verify` calls (e.g., for
meta-tasks or owner-driven completions) do not provide `taskId` to the branch-scope check, or
the task branch does not exist, so `getEffectiveHead` returns `"HEAD"` and behavior is unchanged.

### ALS Bridge Unchanged

The AsyncLocalStorage bridge in `packages/cleo/src/cli/index.ts:393-402` (ADR-041 §D3) remains
unchanged. When `CLEO_WORKTREE_ROOT` is set and the ALS scope is active, `getProjectRoot()`
correctly returns the worktree path as before. The fixes in this extension operate independently
of the ALS bridge — they do not rely on it being active, which is the critical property that
eliminates Bug A in Scenario 1 (missing env var).

### Content-Intersect Gate Remains in Force

Decision 3 strengthens the T9245 content-intersect gate rather than weakening it. By ensuring
`checkCommitContentIntersect` always reads from the canonical main DB, the check has access to
the most current `task.files` and `task.acceptance` values. The vacuous-pass security regression
(Bug C) is eliminated.

### Gitlink Parsing Duplication

`resolveCanonicalProjectRoot` replicates the gitlink-parsing logic from step 2.5 of
`getProjectRoot()` in `packages/core/src/paths.ts:511-536`. This is intentional scope
containment — refactoring into a shared `parseGitlink(path)` utility is deferred per
`docs/plans/E-WORKTREE-IVTR.md §Appendix A OOS-3` to avoid scope creep in this fix.

---

## References

- `ADR-051-programmatic-gate-integrity.md` — parent ADR establishing evidence-based gates
- `ADR-051-override-patterns.md` — override usage patterns for ADR-051
- `ADR-041-worktree-handle-spawn-contract.md` §D3 — ALS worktree scope bridge
- `docs/plans/E-WORKTREE-IVTR.md` — full RCASD spec with bug trace, architecture, and tasks
- Task T-WT-1: `getEffectiveHead` primitive
- Task T-WT-2: `resolveCanonicalProjectRoot` + `checkCommitContentIntersect` DB fix
- Task T-WT-3: wire `getEffectiveHead` into `validateCommit`
- Task T-WT-4: regression test suite
- Task T-WT-5: end-to-end spawn → verify integration test
- Task T-WT-6: this document (T9605)
- Task T-WT-7: CI green verification

---

## Status

**ACCEPTED** — augments ADR-051, supersedes nothing.

Decisions 1–4 are implemented by tasks T-WT-1 through T-WT-5 under epic T9586.
This document (T-WT-6) provides the architectural rationale and serves as the authoritative
reference for the worktree-aware evidence validation behavior going forward.
