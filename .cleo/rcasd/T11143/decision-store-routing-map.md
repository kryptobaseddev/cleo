# Decision-Store Routing Map — T11143

> T10516-P1: Map decision-to-doc routing paths — identify all decision-store read sites that should prefer BRAIN over ledger blobs

## Two Decision Storage Systems

### 1. BRAIN Decision Store (`brain.db` → `brain_decisions` table)
- **Accessor**: `store/memory-accessor.ts` → `BrainDataAccessor` (getDecision, findDecisions, addDecision, updateDecision)
- **Core API**: `memory/decisions.ts` → storeDecision, searchDecisions, listDecisions, getDecisionById
- **Public API**: `memory/public-api.ts` → getDecisions, findMemoryEntries
- **Engine Compat**: `memory/engine-compat.ts` → memoryShow, memoryDecisionFind, memoryDecisionStore
- **Characteristics**: Quality scored, validated (collision/contradiction detection), graph-linked, cross-session, tiered (short/medium/long), verified/unverified

### 2. Session Decision Log (`.cleo/audit/decisions.jsonl`)
- **Core API**: `sessions/decisions.ts` → recordDecision, getDecisionLog
- **Characteristics**: Append-only JSONL audit trail, session-scoped, flat fields (id, sessionId, taskId, decision, rationale, alternatives, timestamp), no validation, no cross-referencing

---

## Complete Read-Site Inventory

### A. Read Sites Using BRAIN (`brain_decisions`) — CORRECT

| # | File:Line | Function | Path | Notes |
|---|-----------|----------|------|-------|
| A1 | `memory/public-api.ts:486` | `getDecisions()` | Public API → searchDecisions or listDecisions | Used by CLI `cleo memory get-decisions` and Studio |
| A2 | `memory/public-api.ts:103` | `findMemoryEntries()` | Cross-table LIKE scan (incl. brain_decisions) | Falls back to LIKE; recommends RRF dispatch layer |
| A3 | `memory/engine-compat.ts:97` | `memoryShow()` | accessor.getDecision() by ID | Single-entry lookup by D- prefix |
| A4 | `memory/engine-compat.ts:276` | `memoryDecisionFind()` | accessor.findDecisions() with text/taskId filter | CLI `cleo memory decision-find`; defaults exclude AGT-* dispatch rows |
| A5 | `memory/engine-compat.ts:431` | `memoryFind()` | searchBrainCompact() across all tables | Token-efficient; cheapest-first retrieval pattern |
| A6 | `memory/decisions.ts:626` | `searchDecisions()` | accessor.findDecisions() with query filter | Internal search within decisions module |
| A7 | `memory/decisions.ts:660` | `listDecisions()` | accessor.findDecisions({}) with offset/limit | Paginated list of all decisions |
| A8 | `memory/decisions.ts:614` | `getDecisionById()` | accessor.getDecision(id) | Single decision lookup |
| A9 | `memory/decisions.ts:351` | `validateDecisionConflicts()` internals | accessor.findDecisions({}) for existing snapshot | ADR conflict checking (Pass 1-3) |
| A10 | `memory/decisions.ts:421` | `storeDecision()` duplicate check | accessor.findDecisions({type}) | Duplicate detection on write |
| A11 | `memory/retrieval/build-retrieval-bundle.ts:194` | warm pass | SQL SELECT from brain_decisions | Agent context injection — warm pass (50% budget) |
| A12 | `memory/brain-reasoning.ts:161` | `findDecisionsForTask()` | accessor.findDecisions({contextTaskId}) | Task-scoped decision lookup |
| A13 | `memory/brain-reasoning.ts:436` | `getEntryDetail()` | accessor.getDecision(entryId) | Brain reasoning detail fetch |
| A14 | `memory/brain-similarity.ts:126` | similarity scoring | accessor.getDecision(row.id) | Semantic similarity computation |
| A15 | `memory/brain-links.ts:183` | memory link validation | accessor.getDecision(link.memoryId) | Validates decision→task links |
| A16 | `memory/brain-backfill.ts:170,545` | backfill operations | accessor.findDecisions() | Backfill reads for migration |
| A17 | `memory/retrieval/fetch.ts:71` | `fetchBrainEntries()` | accessor.getDecision(id) | Full entry fetch by ID |
| A18 | `memory/retrieval/timeline.ts:68` | timeline anchoring | accessor.getDecision(anchorId) | Timeline context around decision |
| A19 | `memory/session-memory.ts:386-396` | `getSessionMemoryContext()` | searchBrainCompact(tables:['decisions']) | Session briefing enrichment — scope-filtered |
| A20 | `agents/execution-learning.ts:266` | agent performance | brain.findDecisions({type:'tactical', includeAgentDispatch:true}) | AGT-* dispatch row analysis |
| A21 | `tasks/evidence.ts:1153` | `validateDecision()` | drizzle SELECT from brain_decisions | Decision atom evidence validation |
| A22 | `sessions/briefing.ts:330-342` | `computeBriefing()` | getSessionMemoryContext → recentDecisions | Injected into briefing output as "Recent Decisions (from BRAIN)" |
| A23 | `render/session/briefing.ts:136-148` | briefing renderer | memoryContext['recentDecisions'] | Renders BRAIN decisions in terminal briefing |
| A24 | `dispatch/domains/memory.ts:172` | `decision.find` operation | memoryDecisionFind() | CLI dispatch for `cleo memory decision-find` |
| A25 | `dispatch/domains/focus.ts:150` | focus context | memoryFind({query:taskId, tables:['decisions']}) | Task focus enrichment |

### B. Read Sites Using Ledger Blob (`.cleo/audit/decisions.jsonl`) — NEEDS ROUTING REVIEW

| # | File:Line | Function | Current Path | Recommendation |
|---|-----------|----------|-------------|----------------|
| B1 | `sessions/handoff.ts:84` | `computeHandoff()` | `getDecisionLog(projectRoot, {sessionId})` | **SHOULD PREFER BRAIN** — reads ledger to count `decisionsRecorded`. BRAIN would provide richer context (quality, validation state, cross-session decisions). Could query brain_decisions where context matches session tasks. |
| B2 | `sessions/handoff.ts:429` | `computeDebrief()` | `getDecisionLog(projectRoot, {sessionId})` | **SHOULD PREFER BRAIN** — maps ledger decisions to DebriefDecision[]. BRAIN decisions would include quality scores, graph links, and provenance data in the debrief. |
| B3 | `sessions/snapshot.ts:167` | `serializeSession()` | `getDecisionLog(projectRoot, {sessionId})` | **SHOULD PREFER BRAIN** — session snapshots include only ledger decisions. BRAIN would provide session-linked decisions with cross-session context. |
| B4 | `orchestration/bootstrap.ts:98-121` | bootstrap brain context | Raw `readFileSync('.cleo/decision-log.jsonl')` | **MUST PREFER BRAIN** — most egregious: reads a different path (`.cleo/decision-log.jsonl` vs canonical `.cleo/audit/decisions.jsonl`), bypassing ALL APIs. Should use `getSessionMemoryContext()` or `accessor.findDecisions()`. Path may be stale/broken. |
| B5 | `dispatch/domains/session.ts:535` | `decision.log` operation | `coreOps['decision.log']` → `getDecisionLog` | **SHOULD UNIFY** — `cleo session decision-log` reads from ledger. Should augment with BRAIN decisions for the session scope, or provide a --brain flag. |
| B6 | `session/engine-ops.ts:1057` | session decision log | `getDecisionLog(projectRoot, params)` | **BRIDGE ROUTE** — wraps ledger read for engine. Could bridge to BRAIN via `getDecisions({query: sessionId})`. |

### C. Write Sites (for reference)

| # | File:Line | Function | Target | Notes |
|---|-----------|----------|--------|-------|
| W1 | `memory/decisions.ts:334` | `storeDecision()` | `brain_decisions` (BRAIN) | Primary BRAIN write path with quality scoring, graph auto-population, conflict validation |
| W2 | `memory/engine-compat.ts:347` | `memoryDecisionStore()` | routes through storeDecision → BRAIN | Engine-compat wrapper |
| W3 | `sessions/decisions.ts:27` | `recordDecision()` | `.cleo/audit/decisions.jsonl` (ledger) | Append-only session audit trail |
| W4 | `session/engine-ops.ts:1033` | session decision record | routes through recordDecision → ledger | Session engine wrapper |
| W5 | `agents/execution-learning.ts` | `recordAgentExecution()` | brain.addDecision() directly | AGT-* dispatch rows written to BRAIN |
| W6 | `dispatch/domains/memory.ts:1504` | `decision.store` operation | memoryDecisionStore() → BRAIN | CLI dispatch for `cleo memory decision-store` |

---

## Routing Gap Analysis

### Primary Gap: Session consumers use ledger, not BRAIN

The **fundamental routing problem** is that session lifecycle consumers (handoff, debrief, snapshot, briefing) read from the ledger blob while the richer BRAIN system exists. This creates several issues:

1. **Cross-session blindness**: `getDecisionLog(sessionId)` only sees decisions recorded in ONE session. BRAIN decisions span all sessions.

2. **Quality unawareness**: Ledger decisions have no quality scores, validation states, or graph links. Handoff and debrief cannot surface high-quality vs. low-confidence decisions.

3. **Duplicate systems**: Two parallel decision stores with disjoint read paths create confusion — users must know whether to use `cleo memory decision-find` (BRAIN) or `cleo session decision-log` (ledger) depending on what they want.

4. **Orchestration bootstrap path divergence**: `orchestration/bootstrap.ts` reads from `.cleo/decision-log.jsonl` (a path that may not even match the canonical `.cleo/audit/decisions.jsonl`), bypassing all APIs. This is the most fragile read site.

### Secondary Gap: No unified read model

There is no single "give me decisions for this context" function that combines BRAIN quality-scored decisions with session-scoped ledger entries. Each consumer invents its own query.

---

## Recommended Routing Changes

### Tier 1 (immediate — fix broken reads)
1. **B4**: Fix `orchestration/bootstrap.ts` to read from BRAIN via `getSessionMemoryContext()` or `accessor.findDecisions()` instead of raw fs read from wrong path.
2. **B1**: Route `computeHandoff()` decisions through BRAIN — use `accessor.findDecisions()` filtered by tasks completed in the session.

### Tier 2 (next — unify session consumers)
3. **B2**: Route `computeDebrief()` decisions through BRAIN, mapping BrainDecisionRow fields to DebriefDecision with quality scores.
4. **B3**: Route `serializeSession()` decisions through BRAIN, including cross-session references.
5. **B5**: Augment `cleo session decision-log` with BRAIN decisions, or add a `--brain` flag.

### Tier 3 (future — unified read model)
6. Create a single `resolveDecisions(context)` function in `memory/decisions.ts` that:
   - Queries brain_decisions with scope filters
   - Optionally includes ledger blob entries for session audit trail
   - Returns unified DecisionRecord[] with provenance tagging
   - Is consumed by ALL read sites (handoff, debrief, snapshot, briefing, CLI)

---

## Affected Test Files
- `memory/__tests__/decisions.test.ts`
- `memory/__tests__/public-api.test.ts`
- `memory/__tests__/session-memory.test.ts`
- `sessions/__tests__/handoff.test.ts`
- `sessions/__tests__/handoff-integration.test.ts`
- `sessions/__tests__/snapshot.test.ts` (if exists)
- `dispatch/domains/__tests__/memory-brain.test.ts`
- `store/__tests__/memory-accessor.test.ts`

---

## Summary

| Category | Count | Status |
|----------|-------|--------|
| BRAIN reads (correct) | 25 | OK — no routing change needed |
| Ledger blob reads (needs review) | 6 | B1-B5 should route through BRAIN; B6 is bridge |
| Write sites | 6 | Both stores written to (W1-W6) |
| **Total read sites** | **31** | 25 BRAIN / 6 ledger |
