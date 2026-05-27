# T1484 Thin Dispatch Plan — Session / Pipeline / Conduit

Generated: 2026-04-27
Task: T1484
ADR: ADR-057 D3

---

## Phase 1 Audit Results

### Pattern Taxonomy

Every handler body in the three domains falls into one of these categories:

| Category | Pattern | Thinnable? |
|----------|---------|-----------|
| **A — Simple passthrough** | call coreOp, if !success lafsError, else lafsSuccess(result.data) | Yes — add `wrapCoreResult` helper |
| **B — Default fallback** | like A but `result.data ?? fallback` | Yes — pass fallback to helper |
| **C — Required-field validation** | param guard before calling coreOp | Yes — guard stays (1 line), body becomes A |
| **D — Conduit try/catch** | entire body in try/catch wrapping `*Impl()` | Yes — move catch into a `wrapConduitResult` helper |
| **E — Complex/multi-step (SSoT-EXEMPT)** | non-trivial request-context side-effects | NO — must document |

---

### Domain: session.ts — Typed Handler Ops (lines 186-526)

| Op | Lines | Category | Body Line Count | Notes |
|-----|-------|----------|----------------|-------|
| `status` | 191-205 | B | 15 | Default `{hasActiveSession:false,session:null,taskWork:null}` |
| `list` | 207-217 | B | 11 | Default `{sessions:[],total:0,filtered:0}` |
| `show` | 220-249 | A+C | 30 | Two code paths for `include === 'debrief'`; both call same coreOp |
| `find` | 251-261 | B | 11 | Default `{sessions:[]}` wraps array in obj |
| `decision.log` | 263-273 | B | 11 | Default `[]` |
| `context.drift` | 275-288 | A+null-check | 14 | Extra `if (!result.data)` guard |
| `handoff.show` | 290-300 | B | 11 | Default `null` |
| `briefing.show` | 302-312 | A | 11 | No default needed |
| `start` | 318-376 | E (SSoT-EXEMPT) | 58 | storeOwnerAuthToken + bindSession(scope parsing) |
| `end` | 378-446 | E (SSoT-EXEMPT) | 69 | debriefCompute + persistSessionMemory + unbindSession + refreshMemoryBridge |
| `resume` | 448-464 | A+C | 17 | Param guard + null E_NOT_FOUND check |
| `suspend` | 466-483 | A+C | 18 | Param guard + null E_NOT_FOUND check |
| `gc` | 484-495 | B | 12 | Default `{orphaned:[],removed:[]}` |
| `record.decision` | 497-510 | A+null-check | 14 | Extra `if (!result.data)` guard |
| `record.assumption` | 512-525 | A+null-check | 14 | Extra `if (!result.data)` guard |

**Total ops: 15. Thinnable: 13. SSoT-EXEMPT: 2 (start, end).**

The `show` op has two code paths that both call `coreOps.show(params)`, differ only in debrief path — this can stay as-is or fold to a single call with early return pattern. Keeping as 3 lines per path with helper.

---

### Domain: pipeline.ts — Typed Handler Ops (lines 451-989)

| Op | Lines | Category | Body Line Count | Notes |
|-----|-------|----------|----------------|-------|
| `stage.validate` | 456-469 | A+C | 14 | Guard epicId+targetStage |
| `stage.status` | 471-484 | A+C | 14 | Guard epicId |
| `stage.history` | 486-499 | A+C | 14 | Guard taskId |
| `stage.guidance` | 501-540 | E (SSoT-EXEMPT) | 40 | sentinel unwrap + isValidStage + buildStageGuidance + formatStageGuidance |
| `stage.record` | 546-559 | A+C | 14 | Guard taskId+stage+status |
| `stage.skip` | 561-574 | A+C | 14 | Guard taskId+stage+reason |
| `stage.reset` | 576-589 | A+C | 14 | Guard taskId+stage+reason |
| `stage.gate.pass` | 591-604 | A+C | 14 | Guard taskId+gateName |
| `stage.gate.fail` | 606-619 | A+C | 14 | Guard taskId+gateName |
| `release.list` | 625-639 | B-special | 15 | Embeds `_enginePage` sentinel for pagination |
| `release.show` | 641-654 | A+C | 14 | Guard version |
| `release.channel.show` | 656-659 | A-trivial | 4 | Already nearly 1 line |
| `release.changelog.since` | 661-674 | A+C | 14 | Guard sinceTag |
| `release.ship` | 680-693 | A+C | 14 | Guard version+epicId |
| `release.cancel` | 695-708 | A+C | 14 | Guard version |
| `release.rollback` | 710-723 | A+C | 14 | Guard version |
| `release.rollback.full` | 725-738 | A+C | 14 | Guard version |
| `manifest.show` | 744-757 | A+C | 14 | Guard entryId |
| `manifest.list` | 759-773 | B-special | 15 | Embeds `_enginePage` sentinel for pagination |
| `manifest.find` | 775-788 | A+C | 14 | Guard query |
| `manifest.stats` | 790-800 | A | 11 | No guard |
| `manifest.append` | 806-819 | A+C | 14 | Guard entry |
| `manifest.archive` | 821-838 | A+C | 14 | Guard beforeDate (longer error msg) |
| `phase.show` | 844-854 | A | 11 | No guard |
| `phase.list` | 856-867 | A | 12 | No guard; comment about pagination |
| `phase.set` | 873-886 | A+C | 14 | Guard phaseId |
| `phase.advance` | 888-898 | A | 11 | No guard |
| `phase.rename` | 900-913 | A+C | 14 | Guard oldName+newName |
| `phase.delete` | 915-928 | A+C | 14 | Guard phaseId |
| `chain.show` | 934-943 | A-special | 10 | sentinel unwrap pattern (chainShowOp returns {_chain,_chainId}) |
| `chain.list` | 945-948 | A-trivial | 4 | Already 1 line (lafsSuccess wraps coreOps result) |
| `chain.add` | 954-959 | A | 6 | No guard on this path |
| `chain.instantiate` | 962-979 | D-inner | 18 | try/catch with FK constraint detection |
| `chain.advance` | 982-988 | A+C | 7 | Guard instanceId+nextStage |

**Total ops: 34. Thinnable: 31. SSoT-EXEMPT: 1 (stage.guidance — sentinel unwrap + build logic). chain.instantiate has try/catch that handles FK translation — keep but can shrink.**

---

### Domain: conduit.ts — Typed Handler Ops (lines 66-242)

| Op | Lines | Category | Body Line Count | Notes |
|-----|-------|----------|----------------|-------|
| `status` | 71-89 | D | 19 | try/catch wrapping getStatusImpl(params.agentId) |
| `peek` | 91-105 | D | 15 | try/catch wrapping peekImpl(...) |
| `listen` | 107-130 | D | 24 | try/catch wrapping listenTopicImpl(...) |
| `start` | 136-158 | D | 23 | try/catch wrapping startPollingImpl(...) |
| `stop` | 160-174 | D | 15 | try/catch wrapping stopPollingImpl() (sync) |
| `send` | 176-195 | D | 20 | try/catch wrapping sendMessageImpl(...) |
| `subscribe` | 197-215 | D | 19 | try/catch wrapping subscribeTopicImpl(...) |
| `publish` | 217-241 | D | 25 | try/catch wrapping publishToTopicImpl(...) |

**Total ops: 8. Thinnable: 8 (all D-category — all follow identical try/catch pattern).**

---

## Phase 3 Implementation Plan

### Helper to Add: `wrapCoreResult`

Add to `packages/cleo/src/dispatch/adapters/typed.ts`:

```ts
/**
 * Wrap a Core engine result (success: bool, data?, error?) into a LafsEnvelope.
 * Standard pattern used by thin dispatch handlers.
 *
 * @param result - Result from a coreOp call.
 * @param opName - Operation name (for lafsError attribution).
 * @param fallback - Optional default data when result.data is null/undefined on success.
 */
export function wrapCoreResult<T>(
  result: { success: boolean; data?: T; error?: { code?: string | number; message?: string } },
  opName: string,
  fallback?: T,
): LafsEnvelope<T> {
  if (!result.success) {
    return lafsError(
      String(result.error?.code ?? 'E_INTERNAL'),
      result.error?.message ?? 'Unknown error',
      opName,
    );
  }
  const data = (result.data ?? fallback) as T;
  return lafsSuccess(data, opName);
}
```

### Helper to Add: `wrapConduitResult`

Add to `packages/cleo/src/dispatch/adapters/typed.ts` (or conduit.ts as internal):

```ts
/**
 * Wrap a conduit *Impl call in a standardized try/catch returning LafsEnvelope.
 *
 * @param fn - Async impl function to execute.
 * @param opName - Operation name for error attribution.
 */
async function wrapConduitImpl<T>(
  fn: () => Promise<{ success: boolean; data?: T; error?: { code?: string; message?: string } }>,
  opName: string,
): Promise<LafsEnvelope<T>> {
  try {
    const result = await fn();
    if (!result.success) {
      return lafsError(result.error?.code ?? 'E_CONDUIT', result.error?.message ?? 'Unknown error', opName);
    }
    return lafsSuccess(result.data ?? {} as T, opName);
  } catch (error) {
    return lafsError('E_CONDUIT', error instanceof Error ? error.message : String(error), opName);
  }
}
```

---

### Session Domain Changes

**Handlers to thin (13 of 15):**

Each A/B/C pattern handler collapses from 11-18 lines to 1-4 lines:

```ts
// Before (status, 15 lines):
status: async (_params: SessionOps['status'][0]) => {
  const result = await coreOps.status();
  if (!result.success) {
    return lafsError(String(result.error?.code ?? 'E_INTERNAL'), result.error?.message ?? 'Unknown error', 'status');
  }
  return lafsSuccess(result.data ?? { hasActiveSession: false, session: null, taskWork: null }, 'status');
},

// After (3 lines):
status: async (_params: SessionOps['status'][0]) =>
  wrapCoreResult(await coreOps.status(), 'status', { hasActiveSession: false, session: null, taskWork: null }),
```

**SSoT-EXEMPT handlers (2):**
- `start`: `// SSoT-EXEMPT: storeOwnerAuthToken (DB side-effect), bindSession (process-context), ownerAuthToken injection`
- `end`: `// SSoT-EXEMPT: sessionComputeDebrief, persistSessionMemory, unbindSession, refreshMemoryBridge — orchestrated post-op pipeline`

---

### Pipeline Domain Changes

**Handlers to thin (31 of 34):**

Same `wrapCoreResult` pattern. The `release.list` and `manifest.list` operators need to embed `_enginePage` — the coreOp already does this, so `wrapCoreResult` passes through naturally.

**SSoT-EXEMPT handlers (1):**
- `stage.guidance`: `// SSoT-EXEMPT: sentinel-unwrap from stageGuidanceOp + isValidStage + buildStageGuidance — cannot delegate to Core without major refactor`

**chain.instantiate**: Keep try/catch for FK translation but slim body:
```ts
'chain.instantiate': async (params: PipelineOps['chain.instantiate'][0]) => {
  if (!params.chainId || !params.epicId) {
    return lafsError('E_INVALID_INPUT', 'chainId and epicId are required', 'chain.instantiate');
  }
  try {
    return lafsSuccess(await coreOps['chain.instantiate'](params), 'chain.instantiate');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(`Chain "${params.chainId}" not found`) || message.includes('FOREIGN KEY constraint failed') || message.includes('SQLITE_CONSTRAINT_FOREIGNKEY')) {
      return lafsError('E_NOT_FOUND', `Chain "${params.chainId}" not found`, 'chain.instantiate');
    }
    throw error;
  }
},
```

---

### Conduit Domain Changes

**All 8 handlers thin to 1-2 lines using `wrapConduitImpl`:**

```ts
// Before (status, 19 lines):
status: async (params) => {
  try {
    const result = await getStatusImpl(params.agentId);
    if (!result.success) { ... }
    return lafsSuccess(result.data ?? {}, 'status');
  } catch (error) {
    return lafsError('E_CONDUIT', error instanceof Error ? error.message : String(error), 'status');
  }
},

// After (2 lines):
status: async (params) => wrapConduitImpl(() => getStatusImpl(params.agentId), 'status'),
```

---

## SSoT-EXEMPT Summary

| Domain | Handler | Reason |
|--------|---------|--------|
| session | `start` | Request-context side-effects: storeOwnerAuthToken (DB write with session ID), bindSession (process-scoped context) |
| session | `end` | Orchestrated post-op pipeline: sessionComputeDebrief, persistSessionMemory, unbindSession, refreshMemoryBridge |
| pipeline | `stage.guidance` | Sentinel-unwrap pattern from stageGuidanceOp + isValidStage + buildStageGuidance/formatStageGuidance — Core fn returns sentinel shape |

---

## Commit Plan

1. `feat(T1484): add wrapCoreResult and wrapConduitImpl helpers to typed adapter`
2. `feat(T1484): thin session dispatch handlers`
3. `feat(T1484): thin pipeline dispatch handlers`
4. `feat(T1484): thin conduit dispatch handlers`

---

## Validation Plan

```bash
pnpm -F @cleocode/cleo run build     # tsc -b clean
pnpm biome ci .                      # lint clean
pnpm run test                        # zero new failures
cleo session status                  # smoke
cleo pipeline stage validate --epicId T1 --targetStage research  # smoke (expected error, not crash)
cleo conduit status                  # smoke
```
