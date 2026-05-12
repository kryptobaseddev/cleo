# Worktree Utility Research Report

**Date**: 2026-05-05
**Task**: T1042
**Researcher**: Worktree-Utility Researcher (READ-ONLY)

---

## 1. Location of Worktree Provisioning Utility

### Primary provisioner chain

| Layer | File | Function |
|-------|------|----------|
| CLI command | `packages/cleo/src/cli/commands/orchestrate.ts:232-255` | `spawnCommand.run()` — dispatches `noWorktree` flag |
| CLI domain | `packages/cleo/src/dispatch/domains/orchestrate.ts:372-379` | `orchestrateSpawnOp()` — thin wrapper, passes `noWorktree` |
| Core engine | `packages/core/src/orchestrate/spawn-ops.ts:603-816` | `orchestrateSpawn()` — ALL business logic lives here |
| Dispatch | `packages/core/src/sentient/worktree-dispatch.ts:65-71` | `spawnWorktree()` — routes to `@cleocode/worktree` |
| Backend | `packages/worktree/src/worktree-create.ts:47-135` | `createWorktree()` — runs `git worktree add` |

The canonical provisioner function is `createWorktree` in the separate `@cleocode/worktree` package (correctly placed under `packages/worktree/`, dependency declared in `packages/core/package.json` line 266).

### Wiring into spawn prompt

`orchestrateSpawn()` (spawn-ops.ts line 704-716) calls `spawnWorktree(root, { taskId })` inside a try/catch. On success it sets `worktreePath` and `worktreeBranch`. These are forwarded into `composeSpawnForTask()` (line 730-737), which calls `composeSpawnPayload()`, which calls `buildSpawnPrompt()`, which at line 1430 conditionally emits the `## Worktree Setup (REQUIRED) — STRICT ISOLATION` section **only when `worktreePath` is truthy**.

Result: the `## Worktree Setup` section is correctly wired — but it is **conditional on provisioning succeeding at runtime**.

---

## 2. Package-Boundary Compliance Check

**Does the provisioner live in `packages/core/`?** — Partial.

- The `createWorktree` backend lives in `packages/worktree/` (its own dedicated package), imported lazily by `packages/core/src/sentient/worktree-dispatch.ts`. This is correct — `@cleocode/worktree` is in core's `package.json` deps.
- Zero `git worktree add/remove/move` calls exist in `packages/cleo/src/` (search confirmed).
- The CLI command at `packages/cleo/src/cli/commands/orchestrate.ts` is pure thin dispatch — no git ops, no provisioning logic, just flag plumbing. Compliant.
- The local domain type `OrchestrateSpawnParams` (orchestrate.ts line 136-141) in the CLI package includes `noWorktree?: boolean`. The exported contracts type `packages/contracts/src/operations/orchestrate.ts:522-539` does NOT include this field. **This is a contracts drift violation** — the CLI domain has a local inline type shadow instead of importing from contracts.

**Violations found**: 1
- `packages/cleo/src/dispatch/domains/orchestrate.ts:136-141` — `interface OrchestrateSpawnParams` is locally redefined with `noWorktree?: boolean` instead of extending the exported `OrchestrateSpawnParams` from `@cleocode/contracts`. Minor boundary drift, not a functional bug.

---

## 3. What's Broken — Hypotheses

### (A) The provisioner is NOT called by spawn-ops.ts — RULED OUT
Evidence: `spawn-ops.ts` lines 704-716 call `spawnWorktree(root, { taskId })`. Wiring is present.

### (B) Feature flag or env var gating — RULED OUT
No conditional gate before the `spawnWorktree` call other than the `noWorktree` boolean parameter (line 688). Default path always attempts provisioning.

### (C) `## Worktree Setup` section omitted due to conditional injection — CONFIRMED ROOT CAUSE
The section is emitted at `spawn-prompt.ts:1430` **only when `worktreePath` is truthy**. `worktreePath` is only set if `spawnWorktree()` resolves without throwing (lines 709-710). If the worktree creation throws at runtime, the catch at line 711-716 logs a warning and falls through with `worktreePath = undefined` — the prompt is built without the section.

### (D) Silent swallow — CONFIRMED (silent degradation, not a bug by design)
`spawn-ops.ts:711-716`:
```
} catch (wtErr) {
  getLogger('engine:orchestrate').warn({ taskId, err: wtErr },
    `T1140 worktree creation failed for ${taskId} — spawning without isolation: ...`);
}
```
Provisioning failure is non-fatal by design. The warning goes to the pino logger, not to stdout/stderr visible in CLI output. Callers see a successful spawn result with no worktree section — no indication of the failure.

### (E) Provisioner removed in refactor — RULED OUT
`createWorktree` exists in `packages/worktree/dist/index.js`. The function is exported and built.

### Most likely runtime failure points

The `createWorktree` function (worktree-create.ts:54-76) calls:
1. `getGitRoot(projectRoot)` — throws `Error("Not a git repository: ...")` if `projectRoot` is not in a git repo (line 76).
2. `gitSync(['worktree', 'add', ...])` — throws if git binary is missing, or if HEAD is unborn (no commits yet, mentioned in `packages/core/src/init.ts:767`).
3. If a branch `task/<taskId>` already exists from a prior aborted spawn, the stale-cleanup at lines 65-70 runs `git branch -D <branch>` — this may fail if the branch is checked out in another worktree, causing `gitSync` to throw.

**Highest probability**: a prior spawn left a stale `task/T1815` branch that cannot be deleted, causing the `gitSync(['worktree', 'add', ...])` call to fail. The error is swallowed, `worktreePath` stays `undefined`, prompt is built without the `## Worktree Setup` section, and the orchestrator receives a nominally "successful" spawn result.

---

## 4. Tests That Should Be Passing But Are Not

All 10 T1140/T1758 tests in `packages/core/src/orchestration/__tests__/spawn-prompt.test.ts` are **passing**:
- `emits Worktree Setup section when worktreePath is provided` ✓
- `omits Worktree Setup section when worktreePath is not provided` ✓
- (8 additional T1758 hardening tests) ✓

These tests pass because they inject `worktreePath` directly into `buildSpawnPrompt()` — they bypass the provisioner entirely. There is **no integration test** that exercises the full `orchestrateSpawn()` path with a real git repository and verifies that the prompt contains `## Worktree Setup`. The existing `packages/cleo/src/dispatch/engines/__tests__/orchestrate-engine-composer.test.ts` calls `orchestrateSpawn('T932W', ...)` but the test environment mocks out the worktree backend, so it cannot catch the stale-branch / git failure scenario.

**Gap**: No test covers the case where `spawnWorktree()` throws — i.e., no test verifies the silent degradation behavior or the stale-branch cleanup failure path.

---

## 5. Recommended Fix

**Scope**: ~30-50 LOC across 2 files.

### Fix 1 — Surface provisioning failure in spawn result (spawn-ops.ts)
In `packages/core/src/orchestrate/spawn-ops.ts` lines 711-716, change the silent warn to also set a `worktreeProvisioningError` field on the returned `data` envelope. Callers and CLI output can then surface this as a non-fatal warning rather than losing it in pino logs.

### Fix 2 — Stale-branch force-delete before worktree add (worktree-create.ts)
In `packages/worktree/src/worktree-create.ts`, the stale-cleanup block (lines 64-71) only runs `git branch -D` as best-effort (via `gitSilent`). Before calling `gitSync(['worktree', 'add', ...])`, add an unconditional `gitSilent(['branch', '-D', branch], gitRoot)` even when no stale directory exists. This handles the case where a prior spawn created the branch but the worktree directory was already cleaned up.

Exact change location: after line 71, before line 74 (`gitSync(['worktree', 'add', ...])`):
```ts
// Ensure the branch doesn't exist from a prior aborted spawn,
// even when no stale worktree directory was found.
gitSilent(['branch', '-D', branch], gitRoot);
```

### Fix 3 — Add `noWorktree` to contracts OrchestrateSpawnParams (contracts drift)
In `packages/contracts/src/operations/orchestrate.ts`, add `noWorktree?: boolean` to `OrchestrateSpawnParams` (line ~539). Remove the local inline redefinition in `packages/cleo/src/dispatch/domains/orchestrate.ts:136-141` and import from contracts.

---

## 6. Owner Directive Compliance

`packages/cleo/src/cli/commands/orchestrate.ts` — **COMPLIANT**. The spawn command is pure thin dispatch: parse flags, call `dispatchFromCli('mutate', 'orchestrate', 'spawn', {...})`. Zero business logic.

`packages/cleo/src/dispatch/domains/orchestrate.ts` — **MOSTLY COMPLIANT**. The `orchestrateSpawnOp` at line 372-379 is a one-liner wrapper into core. The only violation is the local `OrchestrateSpawnParams` type shadow (line 136-141 with `noWorktree`) instead of the exported contracts type.

No `git worktree add/remove/move` calls exist anywhere in `packages/cleo/src/`. Package boundary is clean for runtime operations.

---

## Summary

The worktree provisioner is architecturally complete and correctly wired. The `## Worktree Setup` section disappearing from spawn output is a **runtime failure** in `createWorktree()` that is silently swallowed by a try/catch in `orchestrateSpawn()`. The most likely trigger is a stale `task/<taskId>` branch from a prior aborted spawn that cannot be deleted, causing `git worktree add` to fail. The fix is ~30-50 LOC: (1) force-delete the stale branch unconditionally before `git worktree add`, and (2) surface provisioning failures in the spawn result envelope so they are observable. A contracts drift fix for `noWorktree` is also warranted (~5 LOC).
