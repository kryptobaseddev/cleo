# T549 Waves 5+6: JIT Commands + Routing Integration

**Date**: 2026-04-13
**Status**: complete
**Scope**: Wave 5-A (context pull CLI), Wave 5-D/E (intelligence hooks), Wave 6-C/D (capacity-aware spawn routing)

---

## Wave 5-A: `cleo context pull <task-id>`

**Files changed**:
- `packages/cleo/src/cli/commands/context.ts` — added `pull <taskId>` sub-command
- `packages/cleo/src/dispatch/domains/admin.ts` — added `context.pull` query case
- `packages/cleo/src/dispatch/registry.ts` — registered `admin.context.pull` operation

**What it does**: Bundles task context + top-3 relevant brain entries (via `retrieveWithBudget`, 400-token budget) + last handoff note snippet (200 chars) into a single compact JSON response. Designed for agents to call at task start instead of making 3 separate queries.

**Output shape**:
```json
{
  "task": { "id", "title", "status", "acceptance" },
  "relevantMemory": [{ "id", "type", "summary" }],
  "lastHandoff": "<200 char snippet or null>",
  "meta": { "memoryTokensUsed", "memoryEntriesExcluded" }
}
```

**New export added to `internal.ts`**: `retrieveWithBudget`, `BudgetedEntry`, `BudgetedResult`, `BudgetedRetrievalOptions` (all from `brain-retrieval.ts`).

---

## Wave 5-D/E: Intelligence Hooks

**Files changed**:
- `packages/core/src/hooks/handlers/intelligence-hooks.ts` — new file
- `packages/core/src/hooks/handlers/index.ts` — auto-registers on import

**What it does**: On `PreToolUse` (task start), calculates risk score via `calculateTaskRisk`. If `riskScore >= 0.8` (HIGH threshold), stores a `discovery` observation in brain.db with the risk level, contributing factors, and recommendation. This makes risk context available to future agents via brain retrieval.

**Priority**: 50 — runs after `brain-tool-start` (priority 100) so the start observation is persisted first.

**Safety**: Entire handler wrapped in `try/catch`. Any error is silently swallowed. Never blocks task start.

---

## Wave 6-C/D: Capacity-Aware Spawn Routing

**File changed**: `packages/cleo/src/dispatch/engines/orchestrate-engine.ts`

**Where**: Inside `orchestrateSpawnExecute`, just before `adapter.spawn(cleoSpawnContext)`.

**What it does**: Calls `findLeastLoadedAgent(undefined, cwd)` to find the agent instance with the highest available capacity (most free). If found, attaches its `id` as `cleoSpawnContext.options.preferredAgent`. The spawn adapter can read this hint to route work to the least-loaded agent.

**Safety**: Wrapped in `try/catch`. If no agents are registered or the call throws, falls through to default spawn behavior unchanged. Never blocks spawning.

---

## Quality Gates

- `pnpm biome check --write` — PASS (1 auto-fix in admin.ts formatting)
- `pnpm run build` — PASS (all packages built, 0 errors)
- `pnpm run test` — PASS (396 test files, 7130 tests, 0 new failures)

## Tests Updated

- `packages/cleo/src/dispatch/domains/__tests__/admin.test.ts` — added `context.pull` to expected query ops list
- `packages/cleo/src/dispatch/__tests__/parity.test.ts` — bumped counts: queryCount 137→138, total 236→237
