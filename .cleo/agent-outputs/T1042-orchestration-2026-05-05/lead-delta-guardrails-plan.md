# Lead Delta — T1855 Guardrails Wave Plan

**Date**: 2026-05-05
**Author**: Team Lead Delta (RCASD planning, no production code modified)
**Scope**: T1855 epic — CLEO opinionated guardrails

---

## Current State

### Existing Dependency Infrastructure (confirmed by code inspection)

**packages/core/src/tasks/dependency-check.ts** — EXISTS, covers:
- `detectCircularDeps(taskId, tasks)` — DFS cycle detection
- `wouldCreateCycle(fromId, toId, tasks)` — pre-add guard
- `getBlockedTasks(tasks)` — tasks with unmet deps
- `getReadyTasks(tasks)` — tasks with all deps resolved
- `validateDependencies(tasks)` — validates refs + circular + self-deps
- `validateDependencyRefs(tasks)` — missing dep IDs
- `topologicalSort(tasks)` — Kahn's algorithm
- `getTransitiveBlockers(taskId, tasks)` — upstream non-done dep walk
- `getLeafBlockers(taskId, tasks)` — root-cause tasks

**packages/core/src/phases/deps.ts** — EXISTS, covers:
- `buildGraph(tasks)` — full adjacency graph
- `getDepsOverview(cwd, accessor)` — overview query
- `getTaskDeps(taskId, cwd, accessor)` — per-task upstream/downstream
- `getExecutionWaves(epicId, cwd, accessor)` — wave grouping
- `detectCycles(cwd, accessor)` — all-graph cycle scan
- `getCriticalPath(taskId, cwd, accessor)` — longest downstream path
- `getImpact(taskId, maxDepth, cwd, accessor)` — transitive impact

**packages/core/src/orchestrate/query-ops.ts** — `orchestrateReady()`:
- Already calls `getReadyTasks(epicId, root, accessor)` from `orchestration/index.js`
- Returns ready task set with diagnostic `reason` on empty
- Does NOT currently run dep-graph validation before advertising ready tasks

**packages/cleo/src/cli/commands/deps.ts** — Existing `cleo deps` subcommands:
- `overview`, `show`, `waves`, `critical-path`, `impact`, `cycles`
- NO `validate` subcommand
- NO `tree --epic` subcommand (only `cleo tree <rootId>` exists separately)

**packages/contracts/src/config.ts** — `LifecycleConfig` exists with:
- `mode: LifecycleEnforcementMode` ('strict' | 'advisory' | 'off')
- NO `depsRequiredAt` field yet (T1856 acceptance criterion mentions it but it is NOT in the config contract yet — T1856 only enforced at the CLI command level for critical-priority tasks)

**T1856 (done)** — Confirmed shipped in `add.ts` and `update.ts`:
- Rejects `--priority critical` without `--depends` or `--depends-waiver`
- No `depsRequiredAt` config read; threshold is hardcoded to `critical`

### Gap Analysis: What T1857 Must Add

The three detection categories T1857 requires are NOT yet implemented as a unified diagnostic surface:

1. **Orphan detection** — tasks with no `parentId` that aren't root-level epics. Not yet implemented.
2. **Cross-epic dep gap detection** — task A (child of epic X) depends on task B (child of epic Y) without epic X having an explicit dep on epic Y. NOT implemented in any existing module. The existing `dependency-check.ts` only validates that referenced dep IDs exist; it does not walk the parent chain to check epic-level alignment.
3. **Stale dep detection** — deps pointing to `closed-but-not-passed` tasks (e.g., `cancelled` without `testsPassed` gate). Partially covered by `validateDependencies` warnings for `W_COMPLETED_WITH_UNMET_DEPS` but NOT the cancelled-without-passing case.
4. **Mermaid + text tree output** — not yet implemented in `cleo deps`.
5. **Machine-readable JSON tree** — not yet implemented.

### Cross-Epic Detection: Algorithm Design

T1855 description explains the pattern: "T1834 → T1845 cross between epics T1042 and T1841." The algorithm for "epic of a task" must walk the `parentId` chain until reaching a task with `type === 'epic'`. This is the "nearest ancestor epic" definition. A cross-epic dep gap exists when:

- Task A has dep on Task B
- `nearestEpic(A) !== nearestEpic(B)`
- AND `nearestEpic(A).depends` does NOT include `nearestEpic(B)` (or any ancestor of B's epic chain)

This is a pure graph traversal over the already-loaded task set — O(n) per task, tier-0 (no LLM required).

### T1859 Scope (confirmed by `cleo show T1859`)

T1859 is a **one-time operational backfill task** — not a code implementation task. Its deliverable is:
- An audit markdown at `.cleo/agent-outputs/T1855-4-deps-audit.md`
- Owner-reviewed dep additions via `cleo update --depends`
- Final clean `cleo deps validate --epic <id>` for 6 epics: T1737, T1768, T1824, T1840, T1844, T1042

T1859 depends on T1857 (must have `validate` command before machine-checking). It can run in parallel with T1858 since T1858 is also unblocked as soon as T1857 ships.

### Enforcement Mode Decision: T1856 Acceptance vs Config Reality

T1856 acceptance criterion mentions `lifecycle.depsRequiredAt (critical|high|all|off)` as configurable. However, `LifecycleConfig` in `packages/contracts/src/config.ts` currently only has `mode: LifecycleEnforcementMode ('strict'|'advisory'|'off')`. The `depsRequiredAt` field does NOT exist yet in the config contract. T1857 should NOT introduce a second enforcement config surface — it should extend the existing `LifecycleConfig` with a `depsRequiredAt` field. This is a minor contracts change that belongs in T1857's scope.

---

## Wave Plan

### Wave 0 — Already Done

| Task | Status | Deliverable |
|------|--------|-------------|
| T1856 | DONE (v2026.5.23) | Mandatory `--depends` for critical-priority tasks at CLI layer |
| T1864 | DONE (v2026.5.22) | Project-root resolution fix; worktree scope ALS bridge |

### Wave 1 — T1857 (unblocked NOW)

**T1857**: `cleo deps validate` + `cleo deps tree` commands

**Package placement** (per AGENTS.md Package-Boundary Check):
- New core logic → `packages/core/src/tasks/dep-graph-validator.ts` (new file extending `dependency-check.ts` with cross-epic + orphan + stale-dep detection)
- CLI surface → extend `packages/cleo/src/cli/commands/deps.ts` with `validate` and `tree` subcommands
- Contracts → extend `packages/contracts/src/operations/tasks.ts` with `TasksDepsValidateParams`, `TasksDepsValidateResult`, `TasksDepsTreeParams`, `TasksDepsTreeResult`
- Config → extend `packages/contracts/src/config.ts` `LifecycleConfig` with `depsRequiredAt: 'critical' | 'high' | 'all' | 'off'`
- Dispatch handler → extend `packages/cleo/src/dispatch/domains/tasks.ts` with `deps.validate` and `deps.tree` operations

**Canonical CLI surface**:
```
cleo deps validate [--epic <id>] [--scope all|open|critical]
  → DepsValidateResult: { valid, issues: Issue[], summary }
  → Issue: { code, taskId, message, relatedIds?, epicA?, epicB? }
  → Issue codes: E_ORPHAN | E_CIRCULAR | E_CROSS_EPIC_GAP | E_STALE_DEP | E_MISSING_REF

cleo deps tree --epic <id> [--json] [--mermaid] [--text]
  → text (default): ASCII tree with critical path marked
  → --mermaid: Mermaid graph TD block
  → --json: machine-readable { epicId, nodes: Node[], edges: Edge[], criticalPath: string[] }
```

**Cross-epic algorithm** (pure, tier-0):
```typescript
function nearestEpic(taskId: string, taskMap: Map<string, Task>): string | null {
  let current = taskMap.get(taskId);
  while (current) {
    if (current.type === 'epic') return current.id;
    current = current.parentId ? taskMap.get(current.parentId) : undefined;
  }
  return null;
}

function detectCrossEpicGaps(tasks: Task[]): Issue[] {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const issues: Issue[] = [];
  for (const task of tasks) {
    const epicA = nearestEpic(task.id, taskMap);
    if (!epicA) continue;
    for (const depId of task.depends ?? []) {
      const epicB = nearestEpic(depId, taskMap);
      if (!epicB || epicA === epicB) continue;
      // Cross-epic dep: check if epicA has an explicit dep on epicB
      const epicATask = taskMap.get(epicA);
      if (!(epicATask?.depends ?? []).includes(epicB)) {
        issues.push({
          code: 'E_CROSS_EPIC_GAP',
          taskId: task.id,
          message: `Task ${task.id} (epic ${epicA}) depends on ${depId} (epic ${epicB}) but ${epicA} has no dep on ${epicB}`,
          epicA, epicB, relatedIds: [depId]
        });
      }
    }
  }
  return issues;
}
```

**Orphan detection** (tasks with `parentId === null/undefined` that aren't top-level epics):
```typescript
// "Orphan" = non-epic task with no parentId
function detectOrphans(tasks: Task[]): Issue[] {
  return tasks
    .filter(t => t.type !== 'epic' && !t.parentId && t.status !== 'done' && t.status !== 'cancelled')
    .map(t => ({ code: 'E_ORPHAN', taskId: t.id, message: `Task ${t.id} has no parent epic` }));
}
```

**Stale dep detection** (dep to cancelled/done-but-not-passed):
```typescript
function detectStaleDeps(tasks: Task[]): Issue[] {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const issues: Issue[] = [];
  for (const task of tasks) {
    for (const depId of task.depends ?? []) {
      const dep = taskMap.get(depId);
      if (!dep) continue;
      if (dep.status === 'cancelled') {
        issues.push({ code: 'E_STALE_DEP', taskId: task.id, message: `Dep ${depId} is cancelled`, relatedIds: [depId] });
      }
      // done-but-gates-not-passed: check verification.passed
      if (dep.status === 'done' && dep.verification && !dep.verification.passed) {
        issues.push({ code: 'E_STALE_DEP', taskId: task.id, message: `Dep ${depId} is done but gates not passed`, relatedIds: [depId] });
      }
    }
  }
  return issues;
}
```

**Mermaid tree format** (for `cleo deps tree --epic <id> --mermaid`):
```
graph TD
  T1857["T1857: cleo deps validate (done)"]
  T1858["T1858: orchestrate ready guard (pending)"]
  T1857 --> T1858
  classDef critical fill:#f96;
  class T1857 critical;
```

**JSON envelope** (for `cleo deps tree --epic <id> --json`):
```json
{
  "success": true,
  "data": {
    "epicId": "T1855",
    "nodes": [
      { "id": "T1857", "title": "...", "status": "done", "depends": ["T1856"] }
    ],
    "edges": [
      { "from": "T1856", "to": "T1857" }
    ],
    "criticalPath": ["T1856", "T1857", "T1858"]
  }
}
```

**Test file**: `packages/cleo/src/cli/commands/__tests__/deps-validate.test.ts`
- Test: orphan detection (task with no parent → E_ORPHAN)
- Test: circular dep detection (A→B→A → E_CIRCULAR)
- Test: cross-epic gap (T1834→T1845 pattern → E_CROSS_EPIC_GAP)
- Test: stale dep to cancelled task → E_STALE_DEP
- Test: clean graph → `{ valid: true, issues: [] }`
- Test: `--epic <id>` scoping — only validates children of that epic

### Wave 2 — T1858 and T1859 (both unblock after T1857 ships)

**T1858** and **T1859** can run in parallel since they are both unblocked by T1857 and have no dependency on each other.

#### T1858: `orchestrate ready` enforcement

**Package placement**:
- Core logic → extend `packages/core/src/orchestrate/query-ops.ts` `orchestrateReady()` to call `runDepsValidation(epicId, root)` before advertising ready tasks
- Audit log → write bypass entries to `.cleo/audit/orchestrate-deps-bypass.jsonl`
- CLI flag → add `--ignore-deps-validate` to `packages/cleo/src/cli/commands/orchestrate.ts` `readyCommand`
- Sentient mode check → sentient's `orchestrateReady` call path must NOT forward the bypass flag

**`orchestrateReady` modified behavior**:
```typescript
// BEFORE: returns ready tasks
// AFTER:
async function orchestrateReady(epicId, projectRoot, opts?) {
  // 1. Run dep validation
  const validation = await runDepsValidate(epicId, root);
  if (!validation.valid) {
    if (opts?.ignoreDepsValidate) {
      // Write audit log entry
      await appendBypassAuditLog({ epicId, issues: validation.issues, timestamp: Date.now(), source: 'cli' });
      // Fall through to ready computation
    } else {
      // Refuse: return structured error with all issues
      return engineError('E_DEP_GRAPH_INVALID', `Epic ${epicId} dep-graph validation failed`, {
        issues: validation.issues,
        hint: 'Fix dep graph or use --ignore-deps-validate (audit-logged)'
      });
    }
  }
  // existing ready computation...
}
```

**Sentient mode block**: The sentient `worktree-dispatch.ts` calls `orchestrateReady` — it must never receive the bypass flag. The flag is only available at the CLI layer. If called programmatically (sentient), bypass is always false.

**Audit log format** (`.cleo/audit/orchestrate-deps-bypass.jsonl`):
```json
{"ts":"2026-05-05T15:00:00Z","epicId":"T1855","source":"cli","issueCount":2,"issues":[{"code":"E_CROSS_EPIC_GAP","taskId":"T1834","epicA":"T1042","epicB":"T1841"}]}
```

**Test file**: `packages/cleo/src/cli/commands/__tests__/orchestrate-ready-deps-guard.test.ts`
- Test: invalid dep graph → `orchestrate ready` returns error with issues
- Test: valid dep graph → ready tasks returned normally
- Test: `--ignore-deps-validate` flag → bypass writes to audit log + returns ready tasks
- Test: sentient invocation path → bypass flag unavailable

#### T1859: Backfill cross-epic deps audit

**This is an operational task, not a code task.** The worker agent must:

1. Run `cleo deps validate --epic T1737` through `T1042` once T1857 ships
2. Collect all `E_CROSS_EPIC_GAP` + `E_ORPHAN` issues per epic
3. Produce `.cleo/agent-outputs/T1855-4-deps-audit.md` with:
   - Table: Epic | TaskId | DepId | Gap Type | Proposed Fix
   - For each gap: proposed `cleo update T<id> --depends <id>` command
4. Present to owner for review (HITL)
5. Apply approved dep additions
6. Re-run `cleo deps validate` per epic and confirm clean

**Note**: T1859 worker does NOT write production code. It runs CLI commands.
**Worktree**: Use `--no-worktree` for T1859 spawn (CLI-only task).

---

## IVTR Strategy per Task

### T1857 — `cleo deps validate` + `cleo deps tree`

| Gate | Evidence Atoms | Command |
|------|----------------|---------|
| `implemented` | `commit:<sha>;files:packages/core/src/tasks/dep-graph-validator.ts,packages/cleo/src/cli/commands/deps.ts,packages/contracts/src/operations/tasks.ts` | Run after commit |
| `testsPassed` | `tool:test` | `pnpm run test --filter @cleocode/cleo` |
| `qaPassed` | `tool:lint;tool:typecheck` | `pnpm biome check --write . && pnpm run typecheck` |
| `documented` | `files:docs/cli-reference/deps.md` | Verify file exists |
| `securityPassed` | `note:read-only CLI command, no network surface` | Note |
| `cleanupDone` | `note:no scaffolding removed` | Note |

**Critical file paths** (for spawn prompt):
- `packages/core/src/tasks/dependency-check.ts` — extend, do NOT rewrite
- `packages/core/src/phases/deps.ts` — extend `buildGraph` for cross-epic awareness
- `packages/cleo/src/cli/commands/deps.ts` — add `validate` and `tree` subcommands
- `packages/cleo/src/dispatch/domains/tasks.ts` — add `deps.validate` + `deps.tree` op handlers
- `packages/contracts/src/operations/tasks.ts` — add `TasksDepsValidateParams/Result`, `TasksDepsTreeParams/Result`
- `packages/contracts/src/config.ts` — extend `LifecycleConfig` with `depsRequiredAt`
- New test: `packages/cleo/src/cli/commands/__tests__/deps-validate.test.ts`

### T1858 — `orchestrate ready` enforcement

| Gate | Evidence Atoms | Command |
|------|----------------|---------|
| `implemented` | `commit:<sha>;files:packages/core/src/orchestrate/query-ops.ts,packages/cleo/src/cli/commands/orchestrate.ts` | Run after commit |
| `testsPassed` | `tool:test` | `pnpm run test --filter @cleocode/cleo` |
| `qaPassed` | `tool:lint;tool:typecheck` | `pnpm biome check --write . && pnpm run typecheck` |
| `securityPassed` | `note:audit log write, no network surface` | Note |
| `cleanupDone` | `note:additive change only` | Note |

**Critical file paths** (for spawn prompt):
- `packages/core/src/orchestrate/query-ops.ts` — `orchestrateReady()` function (line 138)
- `packages/cleo/src/cli/commands/orchestrate.ts` — `readyCommand` (add `--ignore-deps-validate` flag)
- `packages/cleo/src/dispatch/domains/orchestrate.ts` — `ready` operation handler (line 549)
- Audit log path: `.cleo/audit/orchestrate-deps-bypass.jsonl`
- New test: `packages/cleo/src/cli/commands/__tests__/orchestrate-ready-deps-guard.test.ts`

### T1859 — Backfill audit (operational)

| Gate | Evidence Atoms |
|------|----------------|
| `implemented` | `files:.cleo/agent-outputs/T1855-4-deps-audit.md` |
| `testsPassed` | `note:cleo deps validate --epic T1737 returns clean` |
| `qaPassed` | `note:no code changes, CLI commands only` |
| `documented` | `files:.cleo/agent-outputs/T1855-4-deps-audit.md` |

---

## Open Questions for HITL

### Q1: Enforcement mode scope for `cleo deps validate` (strict/advisory/off)

T1855 acceptance criterion: "Configurable strict|advisory|off mode set in lifecycle config (default: strict for critical priority epics)."

**Current state**: `LifecycleConfig.mode` exists but applies to epic lifecycle stages, not deps validation. Two options:

- **Option A**: Reuse `LifecycleConfig.mode` — `strict` means `orchestrate ready` refuses, `advisory` means it warns but proceeds, `off` means no check
- **Option B**: Add a new `LifecycleConfig.depsValidation.mode` field scoped specifically to dep-graph enforcement

**Recommendation**: Option A. `LifecycleConfig.mode` already covers "how strict is task management." Reusing it avoids config proliferation. The T1856 `depsRequiredAt: 'critical'|'high'|'all'|'off'` field would be a separate orthogonal control for when to REQUIRE deps declaration on creation.

**Owner decision needed**: Should `LifecycleConfig.mode` also gate `orchestrate ready` dep-validation, or should T1858 always enforce (with only the `--ignore-deps-validate` bypass)?

### Q2: Cross-epic gap: parent chain depth

When task A (child of epic X, which is child of mega-epic M) depends on task B (child of epic Y), does a dep from X → Y suffice, or must M also have a dep on Y? 

**Recommendation**: Nearest-epic-only check. If A.nearestEpic = X and B.nearestEpic = Y, require X.depends includes Y. Do NOT require M.depends includes Y — that would cascade to require too many parent-level deps.

### Q3: Orphan definition boundary

Should "orphan" include top-level epics with no parent? Top-level epics are by design parentless. Only non-epic tasks with no parentId should be flagged.

**Recommendation**: Orphan = `task.type !== 'epic' && !task.parentId && task.status not in [done, cancelled, archived]`. Owner should confirm.

---

## New Tasks Proposed

No new tasks required for T1855 completion. The scope is well-defined across T1857/T1858/T1859.

**Post-T1855 follow-on** (out of scope for this epic but worth filing):
- Sentient mode: automatic dep-gap suggestion on `cleo next` output (propose `cleo update --depends` when cross-epic gap detected)
- `cleo deps validate` as CI gate in release pipeline (add to `cleo check canon`)

---

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `orchestrateReady()` change in query-ops.ts breaks existing orchestration tests | Medium | High | Run full test suite before completing T1858; the change is additive (validation runs first, falls through on bypass) |
| Cross-epic gap algorithm generates false positives for intentional cross-epic deps | Medium | Medium | Owner review of T1859 audit output before `cleo update` runs; audit-driven not automatic |
| `LifecycleConfig.depsRequiredAt` field missing from contracts slows T1857 | Low | Low | T1857 worker must add the field to contracts first, before using it in CLI |
| T1859 worker modifies tasks.db without T1857 validate command available | Low | High | T1859 depends on T1857 — MUST NOT start until T1857 is verified complete |
| Mermaid output format breaking when task titles contain quotes or special chars | Low | Low | Escape task titles in Mermaid renderer; test with T-ids that have known special chars |
| `orchestrate-deps-bypass.jsonl` audit log not created atomically | Low | Low | Use existing `appendJsonlFile` utility (same pattern as `force-bypass.jsonl`) |

---

## Summary Table

| Wave | Task | Unblocked By | Size | Type | Key Deliverable |
|------|------|--------------|------|------|-----------------|
| 0 | T1856 | — | M | done | Mandatory --depends for critical-priority |
| 0 | T1864 | — | L | done | Project-root resolution fix |
| 1 | T1857 | T1856 ✓ | M | code | `cleo deps validate` + `cleo deps tree` |
| 2a | T1858 | T1857 | S | code | `orchestrate ready` dep-validation gate |
| 2b | T1859 | T1857 | M | operational | Backfill dep audit for 6 epics |

T1857 is the critical path bottleneck. T1858 and T1859 can both start immediately after T1857 ships. T1855 epic closes when T1858 + T1859 are both done.
