# Audit C: LOOM + BRAIN (T785/786/787/790/791)

Auditor: AUDIT AGENT C
Date: 2026-04-15
Scope: Independent read-code + run-tests verification. Zero trust.

---

## Summary Table

| Task | Key file | Spec checks | Tests | Smoke | Verdict |
|------|----------|-------------|-------|-------|---------|
| T785 | orchestrate-engine.ts | 0/3 | 0/2 | N/A | FAIL |
| T786 | add.ts + lifecycle-engine.ts | 3/3 | 3/3 | N/A | PASS |
| T787 | task-engine.ts + show.ts | 0/3 | 0/6 | has history: False | FAIL |
| T790 | brain-lifecycle.ts + migration | 1/3 + migration present | 0/6 | N/A | FAIL |
| T791 | anthropic-key-resolver.ts + memory.ts | 0/3 | 0/14 | Unknown command llm-status | FAIL |

**Overall: 1/5 PASS**

---

## T785 (LOOM-01 — orchestrate auto-init)

**File**: `packages/cleo/src/dispatch/engines/orchestrate-engine.ts`

**Spec checks**:

1. **Import `getLifecycleStatus` and `recordStageProgress`** — FAIL. Neither symbol appears anywhere in orchestrate-engine.ts imports. The import block (lines 19-46) pulls from `@cleocode/core/internal` but does not include either function.

2. **`orchestrateStartup` conditionally calls lifecycle start with stage="research" when not initialized** — FAIL. `orchestrateStartup` (lines 736-764) calls `computeStartupSummary` and returns. No lifecycle check, no `recordStageProgress` call, no auto-init branch.

3. **Idempotency — re-invoking orchestrate start does not re-init** — FAIL. No init logic exists to be idempotent.

**Test file**: `packages/cleo/src/dispatch/engines/__tests__/orchestrate-engine.test.ts`

Searched for "auto-init", "autoInit", "lifecycle.*init", "idempotent", "re-init", "T785" — zero matches. The 2 required new test cases are absent.

**Test run (isolation)**: 16/16 pass (all pre-existing tests). The 2 T785 tests were never written.

**Verdict: FAIL — lifecycle auto-init logic not implemented in orchestrate-engine.ts; 0/2 spec tests written.**

---

## T786 (LOOM-02 — lifecycle auto flag)

**File**: `packages/cleo/src/cli/commands/add.ts`

**Spec checks**:

1. **`--lifecycle <mode>` flag with `auto|off` values (default `off`)** — PASS. Line 157-161:
   ```
   .option('--lifecycle <mode>', 'Auto-initialize LOOM pipeline at research stage when epic is created (auto|off)', 'off')
   ```

2. **`lifecycleAutoInit` imported and called when flag=`auto` AND type=`epic`** — PASS. Lines 9, 229-252. Import on line 9 from lifecycle-engine.js. Guard: `isAutoLifecycle && isEpic && !data?.dryRun` (line 234). Calls `lifecycleAutoInit(epicId)`.

3. **When flag=`off` (default), no lifecycle call** — PASS. Guard ensures `lifecycleAutoInit` is only called when `isAutoLifecycle` is true.

**File**: `packages/cleo/src/dispatch/engines/lifecycle-engine.ts`

`lifecycleAutoInit` function present at lines 277-300. Correctly:
- Returns `lifecycleInitialized: false` when already initialized (idempotency via `status.initialized` check, line 286)
- Calls `recordStageProgress(epicId, 'research', 'in_progress', ...)` on a fresh epic (line 292)
- Returns `engineError('E_INVALID_INPUT', ...)` for missing epicId

**Test file**: `packages/cleo/src/dispatch/engines/__tests__/lifecycle-engine.test.ts`

Lines 229-262: 3 tests for `lifecycleAutoInit`:
- "initializes lifecycle at research stage for a new epic" — verifies `lifecycleInitialized: true`, stage: 'research', pipeline bootstrapped
- "is idempotent — returns lifecycleInitialized: false when already initialized"
- "returns error for missing epicId"

**Test run (isolation)**: `npx vitest run packages/cleo/src/dispatch/engines/__tests__/lifecycle-engine.test.ts` — 24/24 PASS.

**Verdict: PASS — flag implemented, lifecycleAutoInit correct, idempotent, 3/3 tests pass.**

---

## T787 (LOOM-03 — show --history)

**File**: `packages/cleo/src/dispatch/engines/task-engine.ts`

Searched for `taskShowWithHistory`, `LifecycleStageEntry`, `showWithHistory`, `history.*flag` — zero matches. The function is absent.

**File**: `packages/cleo/src/cli/commands/show.ts`

Searched for `--history`, `history` — zero matches. The flag is not registered. `registerShowCommand` (lines 33-52) registers only a `taskId` positional arg and dispatches `query tasks show { taskId }` with no history support.

**Smoke test**:
```
cleo show T767 --history
→ has history: False   (flag silently ignored; no history key in response)
```

**Test file**: `packages/cleo/src/dispatch/engines/__tests__/task-show-history.test.ts`

Test file exists (6 tests), imports `taskShowWithHistory` from `../task-engine.js`. Running the full suite shows all 6 fail with `TypeError: taskShowWithHistory is not a function`.

**Verdict: FAIL — `taskShowWithHistory` not implemented in task-engine.ts; `--history` flag absent from show.ts; 0/6 tests pass; smoke test returns no history key.**

---

## T790 (BRAIN-01 — Hebbian threshold)

**File**: `packages/core/src/memory/brain-lifecycle.ts`

**Spec checks**:

1. **Uses `Set<string>` per pair tracking distinct queries, only emits edge when `size >= 3`** — FAIL. Actual implementation (lines 1095-1130) uses `Map<string, number>` (raw count), not `Map<string, Set<string>>`. The SQL is `SELECT entry_ids FROM brain_retrieval_log` — no `query` column fetched. The `LogRow` interface only has `entry_ids`. The guard is `if (count < 3) continue` which counts raw log rows, not distinct query strings. The old broken path is still in place.

2. **`strengthenCoRetrievedEdgesForTest` exported for test access** — FAIL. Function is private (`async function strengthenCoRetrievedEdges`, line 1075), no export. The test imports `strengthenCoRetrievedEdgesForTest` which does not exist.

3. **Migration file exists** — PASS. `/packages/core/migrations/drizzle-brain/20260416000006_t790-hebbian-prune/migration.sql` exists and is correct. Contains two DELETE statements pruning low-weight and pre-fix-date co_retrieved edges with `plasticity_class IN ('hebbian', 'static')`, and creates an index.

**Test file**: `packages/core/src/memory/__tests__/hebbian-threshold.test.ts`

6 tests present. The tests import `strengthenCoRetrievedEdgesForTest` and build a mock DB returning rows with both `query` and `entry_ids` fields. However the actual implementation neither exports this function nor fetches the `query` column.

**Test run**: All 6 hebbian tests FAIL — `strengthenCoRetrievedEdgesForTest is not a function`.

**Verdict: FAIL — core fix not applied (still uses raw count, not distinct-query Set); test export missing; 0/6 tests pass. Migration SQL file is correct but the code that would make it work is absent.**

---

## T791 (BRAIN-02 — resolver coverage + llm-status)

**File**: `packages/core/src/memory/anthropic-key-resolver.ts`

**Spec checks**:

1. **`resolveAnthropicApiKeySource()` function present** — FAIL. File exports only `resolveAnthropicApiKey()`, `storeAnthropicApiKey()`, `clearAnthropicKeyCache()`. `resolveAnthropicApiKeySource` and `AnthropicKeySource` type do not exist in this file.

2. **`case 'llm-status'` handler in `packages/cleo/src/dispatch/domains/memory.ts`** — FAIL. `getSupportedOperations()` (lines 623-658) lists 19 query operations; `llm-status` is absent. Grep for `llm-status` in memory.ts returns zero matches.

3. **`cleo memory llm-status` subcommand in memory-brain.ts** — FAIL. Grep for `llm-status` in memory-brain.ts returns zero matches. CLI confirms: `Unknown command llm-status`.

**Test files**:
- `packages/core/src/memory/__tests__/anthropic-key-resolver-source.test.ts` — 8 tests, all importing `resolveAnthropicApiKeySource`. All fail: function not exported.
- `packages/cleo/src/dispatch/domains/__tests__/memory-llm-status.test.ts` — 6 tests, all fail. Handler returns error for unknown operation.

**Smoke test**: `cleo memory llm-status` → exit code 1, "Unknown command llm-status".

**Env-access check**: No other files in `packages/core/src/memory` access `process.env.ANTHROPIC_API_KEY` directly (the resolver owns this cleanly). This part of the spec is technically satisfied by the existing code, but irrelevant because the `resolveAnthropicApiKeySource` function itself was never added.

**Verdict: FAIL — `resolveAnthropicApiKeySource` not implemented; `llm-status` not registered in domain or CLI; 0/14 tests pass; smoke test returns unknown command.**

---

## Anomalies

1. **T790 migration SQL exists but code fix does not**: The migration file was written and describes the fix accurately (the `query`-based distinct-count approach), but the actual `strengthenCoRetrievedEdges` function body was not updated. This is a split delivery — the pruning migration will run but future runs will immediately regenerate noise edges via the unfixed path.

2. **T785 appears shipped but is entirely absent**: The orchestrate-engine tests pass 16/16 because the 2 required T785 tests were never added. The implementation has no trace of the feature. The passing test count is misleading.

3. **T787 tests exist but target a non-existent function**: `task-show-history.test.ts` imports `taskShowWithHistory` which was never added to task-engine.ts. Tests fail with a TypeError, not a logic failure. The function signature and test expectations are fully specified — implementation is the only gap.

4. **T791 tests exist but target non-existent exports**: `anthropic-key-resolver-source.test.ts` imports `resolveAnthropicApiKeySource` which is absent from the source file. Same pattern as T787 and T790 — tests written, implementation skipped.

5. **Parity test breakage**: `packages/cleo/src/dispatch/__tests__/parity.test.ts` fails (1 test) because `llm-status` is listed in expected operations but absent from the domain. This is a downstream casualty of T791 being incomplete.

---

## Recommended Re-Spawn

All four failing tasks require implementation work, not design work. Test files and specs are already written.

| Task | What to implement | Estimated scope |
|------|-------------------|-----------------|
| T785 | Add `getLifecycleStatus` + `recordStageProgress` imports to orchestrate-engine.ts; add auto-init branch in `orchestrateStartup`; add 2 test cases | small |
| T787 | Add `taskShowWithHistory` to task-engine.ts; add `--history` flag to show.ts; wire dispatch | small |
| T790 | Update `strengthenCoRetrievedEdges` to use `Map<string, Set<string>>` + `SELECT query, entry_ids`; export as `strengthenCoRetrievedEdgesForTest` | small |
| T791 | Add `resolveAnthropicApiKeySource()` + `AnthropicKeySource` type to anthropic-key-resolver.ts; add `case 'llm-status'` to memory.ts; register `memory llm-status` CLI subcommand | medium |

T786 is complete and verified. No re-spawn needed.
