# T1148 + T1151 Explorer Map — v2026.4.133 April Terminus
Generated: 2026-04-24 | Read-only deep-mapping | Slot .133

---

## TL;DR (5 bullets)

- **Sigil (peer_card) surface is half-built**: Wave 2 added `peer_id`/`peer_scope` columns to all 6 brain tables and the `user_profile` table lives in `nexus.db`, but `fetchIdentity()` in `brain-retrieval.ts:1643` still returns a placeholder string for `peerInstructions` with comment "Wave 8 (T1148) will replace with actual CANT sigil data" — the `sigils` table does not yet exist anywhere in the schema.
- **Sentient subsystem is Tier-1 + Tier-2 only**: daemon at `packages/core/src/sentient/daemon.ts` runs ticks every 5 min (Tier-1) and propose-ticks every 2h (Tier-2, default disabled). Kill-switch = `killSwitch` field in `.cleo/sentient-state.json`. The `propose.enable` dispatch op at `packages/cleo/src/dispatch/domains/sentient.ts:414` calls `patchSentientState` directly — **no M7 gate exists yet**.
- **MCP was fully removed 2026-04-04** (per project memory); "MCP adapter proof" in T1148 AC means an _external-only_ shim or proof-of-concept re-introduction, NOT internal MCP wiring — this is the single highest-ambiguity item.
- **`cleo memory doctor` does not exist yet**: T1262 filed the detector as a parallel deliverable to E1 (.126) and CLI surface into E6 (.130); the `--assert-clean` flag is entirely new work with no stub in the codebase.
- **Dispatch-time reflex anchor is `packages/core/src/sentient/tick.ts`** (Tier-1) and `packages/core/src/sentient/propose-tick.ts` (Tier-2); the orchestration dispatch entry at `packages/core/src/orchestration/index.ts:421` (`autoDispatch`) is keyword-based label routing — neither contains self-healing logic yet.

---

## 1. Sigil = peer_card Surface

### What Wave 2 shipped (done, in nexus.db + brain.db)

Wave 2 (T1081) added `peer_id TEXT NOT NULL DEFAULT 'global'` and `peer_scope TEXT NOT NULL DEFAULT 'project'` to all 6 brain tables:
- `brain_decisions` — `packages/core/src/store/memory-schema.ts:237`
- `brain_patterns` — same file, ~line 330
- `brain_learnings` — same file, ~line 420
- `brain_observations` — same file, ~line 510
- `brain_memory_links` — same file
- `session_narrative` — same file

The `user_profile` table lives in `nexus.db` at `packages/core/src/store/nexus-schema.ts:460`. Per-trait rows with `traitKey` (PK), `traitValue`, `confidence`, `source`, `reinforcementCount`, `supersededBy`. Wave 1 (T1076/T1077) "cold pass" identity layer.

The `fetchIdentity()` function in `brain-retrieval.ts:1628` calls `listUserProfile(nexusDb, { minConfidence: 0.5 })` for traits but constructs `peerInstructions` as a simple string. Comment at line 1640:
> "Wave 8 (T1148) will enrich this from the sigils table; for now we derive a minimal instruction string from the peer ID so callers always receive a well-typed string."

### What T1148 must add

A `sigils` table (or extension columns on existing table — owner deferred per NEXT-SESSION-HANDOFF.md:304-305). Owner's open decision 5: "New `sigils` table vs extension columns on existing `signaldock.agents`?" — **unresolved, must be the first design decision W8 makes**.

Sigil contents per upstream PSYCHE lineage (gitignored):
- Peer display name and role
- CANT agent file path
- Behavioral constraints / system prompt fragment
- Capability flags (tier, spawn rights, thin-agent mode)

`fetchIdentity()` is the primary wiring point. W8 must: (a) define sigils schema, (b) write SDK functions (get/upsert/list sigil), (c) update `fetchIdentity()` to call them, (d) update `RetrievalBundle` type in contracts to carry richer `peerInstructions` or new `sigilCard` field.

### CANT representation requirements

CANT `.cant` agent files at `.cleo/cant/agents/` already reference `peer_id` values. T1148 must ensure:
- Each `.cant` agent file has a `sigil` block or sigils table has FK/soft-ref to CANT agent ID
- `classifyTask()` in `packages/core/src/orchestration/classify.ts` resolves active peer's sigil when composing spawn payloads
- `buildRetrievalBundle` calls real sigil lookup in cold pass instead of placeholder

---

## 2. Sentient Subsystem State

### State persistence

Single JSON: `.cleo/sentient-state.json`. Schema in `packages/core/src/sentient/state.ts`.

Key fields:
- `killSwitch: boolean` — checked at every tick checkpoint
- `tier2Enabled: boolean` — default `false`
- `pid: number | null`
- `stats: SentientStats`
- `stuckTasks: Record<string, StuckTaskRecord>`
- `tier2Stats: { proposalsAccepted, proposalsRejected, proposalsGenerated }`

### Current CLI surface

Domain handler at `packages/cleo/src/dispatch/domains/sentient.ts`:

**Query**: `propose.list`, `propose.diff` (Tier-3 stub), `allowlist.list`
**Mutate**: `propose.accept`, `propose.reject`, `propose.run`, `propose.enable` (sets `tier2Enabled: true`, NO M7 GATE), `propose.disable`, `allowlist.add`, `allowlist.remove`

`status`, `kill`, `start`, `stop` handled in CLI command file (likely co-located in dispatch layer; `packages/cleo/src/commands/sentient/` does not exist yet).

### Tier-2 proposal store

Stored as `tasks` rows in `tasks.db`:
- `status = 'proposed'`
- `labelsJson LIKE '%sentient-tier2%'`
- `notesJson[0]` = JSON with `kind: 'proposal-meta'` and `weight`

Rate limiter: `packages/core/src/sentient/proposal-rate-limiter.ts` — transactional `BEGIN IMMEDIATE + COUNT + INSERT`. Default: `DEFAULT_DAILY_PROPOSAL_LIMIT`.

Partial index `tasks-schema.ts:287-289` (`idx_tasks_sentient_proposals_today`) accelerates daily count.

Three ingesters:
- `packages/core/src/sentient/ingesters/brain-ingester.ts` — mines brain.db for low-quality/unverified
- `packages/core/src/sentient/ingesters/nexus-ingester.ts` — mines nexus.db for code patterns
- `packages/core/src/sentient/ingesters/test-ingester.ts` — mines `.cleo/audit/gates.jsonl`

Title format enforcement: `/^\[T2-(BRAIN|NEXUS|TEST)\]/` (prompt-injection defense).

### 4-Pillar integration anchor (T1151)

Reconstructed pillars:

| Pillar | What it is | Current location |
|--------|-----------|-----------------|
| BRAIN reconcile | 2440-entry sweep + doctor | T1147 W7 (.132) — not yet built |
| Nexus impact | Plasticity Hebbian strengthening | `classify.ts` + nexus-relations `weight` column |
| Peer memory | Wave 2 `peer_id` isolation + Wave 1 user_profile | `brain-schema.ts`, `nexus-schema.ts` |
| Dispatch reflex | Self-healing fires when dispatch resolves T1107 verb | `orchestration/index.ts:421` (`autoDispatch`) — NOT YET WIRED |

T1151 "dispatch-time reflex" = inserting self-healing checks INTO the dispatch path so every `autoDispatch()` / `sentient.propose.run` triggers reconciler check on BRAIN entry being used. Anchors:
- **Tier-1 reflex**: `sentient/tick.ts` — `safeRunTick()`
- **Tier-2 reflex**: `sentient/propose-tick.ts` — `safeRunProposeTick()`

The reflex wires a health-check call (e.g., `memory doctor --assert-clean` or in-process equivalent) before propose-tick generates proposals from BRAIN.

---

## 3. MCP Adapter Proof Clarification

Per project MEMORY.md (2026-04-04): "MCP Removal Complete — ALL MCP removed 2026-04-04. CLI-only dispatch."

T1148 AC "MCP adapter proof" means one of:
1. **External-only shim**: thin bridge wrapping CLEO CLI dispatch as MCP server for external consumption (not used internally)
2. **Proof-of-concept doc**: documented test showing sigil/peer_card identity layer is MCP-tool-compatible (metadata format proof)

Project memory is unambiguous: MCP NOT used internally. **Recommendation**: treat as "external-only stub package exposing `cleo sentient` ops as MCP tools" — small adapter, likely `packages/cleo-os/` or new `packages/mcp-adapter/`. Medium risk because scope is undefined.

---

## 4. M7 Entry Gate Plumbing

### `cleo memory doctor` — current state

**Does not exist.** T1262 filed as detector. Per council reconciliation:
- Detector surface (read-only) ships parallel to T1258 E1 in slot .126
- CLI surface + session-end hook ships in T1263 E6 slot .130

As of v2026.4.125, no `memory.doctor` dispatch op anywhere.

### `--assert-clean` flag design

M7 spec (council-output.md line 306):
> "`cleo sentient propose enable` MUST return non-zero until `cleo memory doctor --assert-clean` returns exit 0"

Implementation:
1. `cleo memory doctor --assert-clean` calls in-process function (T1262) scanning brain.db for `provenanceClass = 'unswept-pre-T1151'` or noise markers. Exit 0 if zero.
2. `propose.enable` op in `packages/cleo/src/dispatch/domains/sentient.ts:414` (currently calls `patchSentientState` directly) wrapped with pre-check call.

### Where to wire M7

```
packages/cleo/src/dispatch/domains/sentient.ts
  setTier2Enabled(projectRoot, enabled=true)  [line 414]
    → ADD: assertMemoryClean(projectRoot)
           throws E_M7_GATE_FAILED if doctor returns non-zero
    → THEN: patchSentientState(statePath, { tier2Enabled: true })
```

`assertMemoryClean()` authored in `packages/core/src/memory/doctor.ts` (new), re-exported from `packages/core/src/memory/index.ts`. Should:
1. Open brain.db via `getBrainNativeDb()`
2. `SELECT COUNT(*) FROM brain_observations WHERE provenance_class = 'unswept-pre-T1151'`
3. Exit 0 if count = 0, non-zero otherwise

`provenanceClass` (M6) added by T1260 E3 on retrieval surface and T1147 W7 on storage surface.

---

## 5. Dispatch-Time Reflex Entry Point

T1151 absorbed into T1148: when Tier-2 proposer reads BRAIN to generate proposals, fire self-healing check on any BRAIN entry with suspect provenance before emitting proposal.

### Current dispatch chain

```
cleo sentient propose run
  → sentient.ts:runProposeTick()
  → propose-tick.ts:safeRunProposeTick()
    → runBrainIngester()
    → runNexusIngester()
    → runTestIngester()
    → countTodayProposals()
    → transactionalInsertProposal()
```

Reflex hook in `safeRunProposeTick()` BEFORE ingesters:

```typescript
if (tier2Enabled) {
  const cleanResult = await checkBrainHealthReflex(projectRoot);
  if (!cleanResult.clean) {
    await triggerReconcilerSweep(projectRoot); // shadow-write, non-blocking
  }
}
```

NOT a blocking gate — triggers reconciler asynchronously, proceeds. M7 (`--assert-clean`) is the hard entry gate; dispatch reflex is ongoing health maintenance.

**Performance**: insert at every propose-tick (every 2h) is negligible. NOT at Tier-1 tick (every 5 min) — too expensive. Reflex belongs in Tier-2 propose path where BRAIN corpus is read.

---

## 6. Atomic Decomposition Proposal (12 workers)

| Worker ID | Scope | Anchor files | Gate |
|-----------|-------|-------------|------|
| W8-1 | **Sigil schema migration** — new `sigils` table in nexus.db (or extension on `user_profile`) | `packages/core/src/store/nexus-schema.ts`, new Drizzle migration | M7 depends |
| W8-2 | **Sigil SDK functions** — `getSigil`, `upsertSigil`, `listSigils` | `packages/core/src/nexus/sigil.ts` (new); pattern: `user-profile.ts` | W8-1 |
| W8-3 | **`fetchIdentity()` enrichment** — replace placeholder `peerInstructions` | `packages/core/src/memory/brain-retrieval.ts:1643` | W8-2 |
| W8-4 | **`RetrievalBundle` contract update** — add `sigilCard` or enrich `peerInstructions` type | `packages/contracts/src/` | W8-3 |
| W8-5 | **`cleo memory doctor --assert-clean`** — new `doctor.ts` + dispatch op `memory.doctor.assertClean` | `packages/core/src/memory/` (new), `packages/cleo/src/dispatch/domains/brain.ts` | Must ship before W8-7 |
| W8-6 | **M6 provenanceClass refusal in retrieval bundle** | `packages/core/src/memory/brain-retrieval.ts` (buildRetrievalBundle); schema column already added by T1260 E3 (.128) | W7 sweep (.132) must have stamped values first |
| W8-7 | **M7 gate wiring** — `assertMemoryClean()` pre-check in `sentient.ts:setTier2Enabled` | `packages/cleo/src/dispatch/domains/sentient.ts:414` | W8-5 |
| W8-8 | **Sentient consolidation (T1151)** — dispatch-time reflex in `propose-tick.ts`; reconciler trigger; kill-switch gating during sweep | `packages/core/src/sentient/propose-tick.ts` | W8-6, W8-7 |
| W8-9 | **MCP adapter proof** — thin external MCP server stub (sentient.propose.* ops) | New package or doc | W8-7 |
| W8-10 | **CANT spawn sigil wiring** — pull active peer's sigil into spawn prompt | `packages/core/src/orchestration/spawn.ts`, `packages/core/src/orchestration/spawn-prompt.ts` | W8-4 |
| W8-11 | **`hierarchy.ts` disposition verification** — confirm E1 (.126) deletion landed; barrel cleanup if not | `packages/core/src/orchestration/hierarchy.ts:203`, `packages/core/src/orchestration/index.ts:53` | E1 (.126) prereq |
| W8-12 | **Validation + ship** — E2E test: doctor exit 0 after W7; propose enable succeeds; proposal has provenanceClass; sigil in spawn prompt | All of above | All W8-x |

---

## 7. Risk Callouts (Top 3 — April Terminus Blockers)

### Risk 1: MCP adapter proof — UNDEFINED SCOPE (HIGH)
T1148 AC says "MCP adapter proof" but MCP was removed in April. Scope ambiguity:
- "Author new external MCP package": medium effort, new package, no internal wiring, 2-4 days
- "Demonstrate sigil metadata is MCP-compatible by spec doc": small effort, 1 day
- "Re-introduce MCP as internal transport": CRITICAL scope expansion, contradicts memory, requires ADR

**Mitigation (overnight autonomous mode)**: treat as "external-only stub package exposing `cleo sentient` ops as MCP tools" and proceed. This is the most defensible reading of an underspecified AC. Do NOT re-introduce MCP internally.

### Risk 2: Sentient consolidation scope creep (HIGH)
T1151 was filed as `pending/critical/large` with 4-pillar scope, then absorbed into T1148 as "dispatch-time reflex." Risk: workers scope-creep back to full 4-pillar vision, overlapping with W7 (reconciler, .132) and E3 (buildRetrievalBundle, .128) already shipped.

Correct T1151-in-W8 scope: ONLY dispatch-time reflex hook in `propose-tick.ts` + kill-switch gating during W7 sweep. Everything else (BRAIN reconcile = W7, nexus impact = classify.ts Hebbian, peer memory = Waves 1-4) MUST be blocked.

**Mitigation**: W8-8 worker explicit "dispatch-time reflex ONLY" scope. T1151 task record AC updated to absorbed-into-W8 scope before worker spawn.

### Risk 3: W7 dependency on `provenanceClass` — CROSS-SLOT ORDERING (CRITICAL)
W8-6 (M6 provenanceClass refusal in `buildRetrievalBundle`) requires W7 shadow-write sweep (.132) to have stamped BRAIN entries with `provenanceClass`. If W7 ships without writing it, W8-6 has nothing to refuse — M6 gate is no-op, M7 chain compromised.

Council explicitly: W7 must run shadow-write envelope BEFORE W8 exposes `buildRetrievalBundle` to Sentient proposer. If .132 ships without `provenanceClass` column AND population during sweep, W8 must add it — schema migration risk in final slot.

**Mitigation**: T1147 W7 AC MUST include "brain schema has `provenance_class` column on `brain_observations`; swept entries have `provenance_class = 'swept-v1'`; unswept legacy entries have `provenance_class = 'unswept-pre-T1151'`." Verify before W8 starts. NOTE per T1147 explorer map: schema lives in T1260 E3 (.128); W7 only updates VALUES.

---

## Key Files (Absolute Paths)

| File | Relevance |
|------|-----------|
| `packages/core/src/store/memory-schema.ts` | peer_id/peer_scope on all 6 brain tables; Wave 2 columns |
| `packages/core/src/store/nexus-schema.ts` | user_profile table; sigils table goes here |
| `packages/core/src/memory/brain-retrieval.ts` | fetchIdentity() placeholder at :1643; buildRetrievalBundle; M6 |
| `packages/core/src/sentient/daemon.ts` | SENTIENT_STATE_FILE, cron exprs |
| `packages/core/src/sentient/state.ts` | SentientState schema; killSwitch; tier2Enabled |
| `packages/core/src/sentient/propose-tick.ts` | safeRunProposeTick(); dispatch-time reflex anchor |
| `packages/cleo/src/dispatch/domains/sentient.ts` | setTier2Enabled(); M7 gate at :414 |
| `packages/core/src/orchestration/hierarchy.ts` | 202-line hardcoded tree; E1 disposition |
| `packages/core/src/orchestration/index.ts` | autoDispatch(); OrchestrationHierarchyImpl barrel at :53 |
| `packages/core/src/orchestration/spawn.ts` | composeSpawnPayload(); W8-10 sigil anchor |
| `packages/core/src/sessions/briefing.ts` | computeBriefing(); buildRetrievalBundle at :215 |
| `packages/core/src/store/tasks-schema.ts` | idx_tasks_sentient_proposals_today partial index at :287 |
