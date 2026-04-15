# Council Lead 4 — Plan Document Reality Reconciliation

> **Date**: 2026-04-15
> **Auditor**: Independent subagent (Council seat 4)
> **Scope**: brain-synaptic-visualization-research.md (v3) + stdp-feasibility.md (v1)
> **Method**: Read every claim, grep every file reference, check every line number, check every task status

---

## Decisions Verification (D-BRAIN-VIZ-01..14)

| ID | Decision | Implemented? | Evidence |
|----|----------|-------------|---------|
| D-BRAIN-VIZ-01 | Stack: Cosmograph + 3d-force-graph + Graphology + SSE | PARTIAL | Cosmograph: `LivingBrainCosmograph.svelte` ships, triggered at >2000 nodes. Graphology: used in `LivingBrainGraph.svelte` (lines 3, 7). SSE: `/api/living-brain/stream/+server.ts` ships. 3d-force-graph: NOT integrated (Phase 6 still open). |
| D-BRAIN-VIZ-02 | Option B — unified canvas with substrate filter toggles | DONE | `brain/+page.svelte:215-217` has `enabledSubstrates = new Set(['brain','nexus','tasks','conduit','signaldock'])`. Substrate toggle UI at line 426. |
| D-BRAIN-VIZ-03 | Five substrates including SIGNALDOCK | DONE | `LBSubstrate = 'brain' \| 'nexus' \| 'tasks' \| 'conduit' \| 'signaldock'` in `types.ts:35`. All five wired in adapters. |
| D-BRAIN-VIZ-04 | Preserve Hebbian during STDP (feature-flagged coexistence) | DONE | `brain-lifecycle.ts:678` calls `strengthenCoRetrievedEdges` (step 6); `brain-lifecycle.ts:706-714` calls `applyStdpPlasticity` (step 9). Both run alongside each other. |
| D-BRAIN-VIZ-05 | Rename `relates_to` → `co_retrieved`; add to BRAIN_EDGE_TYPES | DONE | `brain-schema.ts:571` has `'co_retrieved'`, line 567 has `'code_reference'`. Migration code at `brain-sqlite.ts:166-179` handles the rename at runtime. |
| D-BRAIN-VIZ-06 | Cross-project meta-brain is Phase 4 | Upheld | No `nexus_cross_project_edges` table exists. Phase 4 still open. |
| D-BRAIN-VIZ-07 | Vanilla `3d-force-graph` (not React wrapper) | NOT YET | 3d-force-graph not integrated at all. Phase 6 is open. Decision is correct, just not yet acted on. |
| D-BRAIN-VIZ-08 | STDP gets own epic + owner checkpoint | PARTIALLY VIOLATED | STDP shipped in v2026.4.51 without a documented owner checkpoint in the task record. `brain-stdp.ts` exists and runs in consolidation. The "owner checkpoint" step has no evidence of completion. |
| D-BRAIN-VIZ-09 | Build STDP-inspired plasticity, NOT biological STDP | DONE | `brain-stdp.ts` uses algebraic `A * exp(-Δt/τ)` updates on scalar weights. No SNN framework. Correct tool class. |
| D-BRAIN-VIZ-10 | Keep sqlite-vec, skip sqliteai | DONE | `brain-sqlite.ts:192-212` loads `sqlite-vec` (asg017). No sqliteai packages in `package.json`. |
| D-BRAIN-VIZ-11 | Evaluate sqlite-ai in Phase 6+, not now | Upheld | Not present in codebase. |
| D-BRAIN-VIZ-12 | SQLite scale ceiling not a concern | Upheld | Architecture unchanged. WAL mode, no migration away from SQLite. |
| D-BRAIN-VIZ-13 | Consider R-STDP via `reward_signal` column | NOT IMPLEMENTED | `brain_retrieval_log` does NOT have a `reward_signal` column. The column is specified in stdp-feasibility.md §3.3 but not yet added to the schema. |
| D-BRAIN-VIZ-14 | Route rename: /living-brain → /brain | DONE but MISSING FROM DOC | T649 (status: done, 2026-04-15) renamed the route. Decision exists in T649 description as "D-BRAIN-VIZ-14 revised" but is **absent from the plan doc's locked decisions table**. The doc stops at D-BRAIN-VIZ-13. |

---

## Phase Status Doc vs Reality

| Phase | Doc says | Code says | Git says | Truth |
|-------|----------|-----------|----------|-------|
| **0** | ✅ DONE — schema audit | Plan doc + memory file exist | T626/T634 done | **CORRECT** |
| **1a** | ✅ DONE — `/living-brain` route + 5-substrate API | Route is `/brain` (not `/living-brain`). `brain/+page.svelte` IS the canvas with 5 substrates. | T649 (done) renamed route post doc-v3 | **MISLEADING**: Feature is done but evidence path is stale. `/living-brain/+page.svelte` does not exist. Correct path: `packages/studio/src/routes/brain/+page.svelte` |
| **1b** | ✅ DONE — `/brain` overview + stats, evidence: `brain/+page.server.ts` (8 stat cards) | `brain/+page.server.ts` does NOT have 8 stat cards — it loads the unified graph canvas. 8 stat cards are in `brain/OVERVIEW/+page.server.ts:71-78`. | T620 (done) | **WRONG FILE**: Feature exists but doc cites wrong server file. After T649, `/brain` is the canvas, `/brain/overview` is the stats dashboard. |
| **1c** | ✅ DONE — `/brain/graph` + `BrainGraph.svelte` | `packages/studio/src/routes/brain/graph/+page.svelte` imports `BrainGraph.svelte` | T620 (done) | **CORRECT** |
| **1d** | ✅ DONE — `/brain/decisions`, `/brain/observations`, `/brain/quality` | All four routes present with `+page.svelte` | T620 (done) | **CORRECT** |
| **2a** | 🟡 IN PROGRESS — TODO at `living-brain/+page.svelte:299` | Time slider IS implemented. `brain/+page.svelte:227` (`timeSliderEnabled`), line 267-280 (filter logic), line 468 (`class="time-slider"`). No TODO at any line 299. | T635 (status: done) | **FALSE**: Doc says IN PROGRESS. Reality: DONE. File path wrong (living-brain doesn't exist). |
| **2b** | 🔴 OPEN — "No SSE endpoint exists" | `packages/studio/src/routes/api/living-brain/stream/+server.ts` EXISTS and is a full SSE implementation | T635 (status: done) | **FALSE**: Doc says OPEN. Reality: DONE. |
| **2c** | 🔴 OPEN — "Not integrated; current renderer is custom force layout" | `LivingBrainCosmograph.svelte` imports `@cosmograph/cosmos`. `brain/+page.svelte:382` switches to GPU renderer when `filteredGraph.nodes.length > 2000`. Both renderers are wired in same page. | T635 (status: done) | **FALSE**: Doc says OPEN. Reality: DONE. |
| **3a** | 🔴 OPEN — Enum drift: `co_retrieved` + `code_reference` missing from BRAIN_EDGE_TYPES | `brain-schema.ts:567` has `'code_reference'`, line `571` has `'co_retrieved'`. Migration in `brain-sqlite.ts:166-179`. | v2026.4.51 (T626-M1) | **FALSE**: Doc says OPEN. Reality: DONE. The enum has both types. The migration runs on init. |
| **3b** | 🔴 OPEN — Backfill missing bridge edges | No backfill code found for decisions→tasks, observations→files/symbols | No relevant commit | **CORRECT**: Still open. |
| **4** | 🔴 OPEN — Cross-project meta-brain | No `nexus_cross_project_edges` table | No relevant commit | **CORRECT** |
| **5** | 🔴 OPEN — STDP-inspired plasticity | `brain-stdp.ts` (448 lines) + `brain_plasticity_events` table + step 9 in `runConsolidation`. SHIPS in v2026.4.51. BUT: spec schema (§3.2 columns on `brain_page_edges`, §3.3 columns on `brain_retrieval_log`, §3.4 `brain_weight_history`) is NOT implemented. Different approach: event log table instead of edge columns. | v2026.4.51 commit `357bad55` | **PARTIALLY FALSE**: Core STDP algorithm is shipped. But doc calls it OPEN when the main algorithm runs. The spec schema deviates from what shipped. |
| **6** | 🔴 OPEN — 3D hero view | No `3d-force-graph` import anywhere | No relevant commit | **CORRECT** |
| **7** | 🔴 OPEN — Polish | Substrate + weight filters shipped (part of Phase 1). Time slider shipped (Phase 2a). GEXF export shipped (v2026.4.52). Query bar and subgraph highlight not present. | Partial | **PARTIALLY MISLEADING**: Some Phase 7 items (snapshot export as GEXF, time slider) already shipped as part of other phases. |

---

## Line-Number Reference Validation

All five line-number references are wrong in both plan docs.

| Reference | Doc claim | Actual content at that line | Valid? |
|-----------|-----------|----------------------------|--------|
| `brain-lifecycle.ts:911` | `strengthenCoRetrievedEdges` function start | `return evicted;` then section separator comment | **NO** — function is at line **930** |
| `brain-lifecycle.ts:606` | `runConsolidation` step 6 | JSDoc comment for `runConsolidation` | **NO** — `runConsolidation` export is at line **625** |
| `brain-retrieval.ts:1415` | `logRetrieval` function start | `return session?.id;` inside a getter, then a section separator | **NO** — `logRetrieval` is at line **1477** |
| `brain-sqlite.ts:172` | `loadBrainVecExtension` | Inside the `relates_to`→`co_retrieved` migration block | **NO** — `loadBrainVecExtension` is at line **192** |
| `brain-sqlite.ts:192` | `initializeBrainVec` | First line of `loadBrainVecExtension` body | **NO** — `initializeBrainVec` is at line **212** |

These same wrong line numbers appear in `stdp-feasibility.md §2, §11` and in the memory file `brain-living-initiative.md` at lines 56-59.

---

## Schema Count Errors

| Claim | Doc says | Reality |
|-------|----------|---------|
| `BRAIN_EDGE_TYPES` count | "12-element edge enum" (§3 substrate map, §9 sources) | **16 types**: `derived_from`, `produced_by`, `informed_by`, `supports`, `contradicts`, `supersedes`, `applies_to`, `documents`, `summarizes`, `part_of`, `references`, `modified_by`, `code_reference`, `affects`, `mentions`, `co_retrieved` |
| `NEXUS_NODE_KINDS` count | "31 kinds" | **33 kinds** (adds `import`, `export`, `type` since doc was written) |
| `NEXUS_RELATION_TYPES` count | "22 types" | **21 types** |
| `BRAIN_NODE_TYPES` count | "12 kinds" | **12 kinds** — this one is correct |

---

## Doc Drift / Lies / Outdated Claims

### Phase status table is severely out of date

The doc was created as "v3 (grounded in shipped reality, 2026-04-15)" but the route rename (T649) and Phase 2 completion (T635) both happened on 2026-04-15 AFTER the doc was written. The doc was not updated to reflect these changes.

Concretely:
- Phase 1a evidence references `living-brain/+page.svelte` — this file does not exist (T649 deleted it)
- Phase 1b evidence references `brain/+page.server.ts (8 stat cards)` — wrong file (stat cards are in `brain/overview/+page.server.ts`)
- Phases 2a, 2b, 2c all marked IN PROGRESS or OPEN — all three are DONE (T635 status: done)
- Phase 3a marked OPEN — DONE (enum has both types, migration runs on init)
- Phase 5 marked OPEN — PARTIALLY DONE (STDP algorithm runs, event log table exists, but spec schema not fully applied)

### D-BRAIN-VIZ-14 is missing from the plan doc

T649 (done) references "D-BRAIN-VIZ-14 revised" as its rationale. This is a locked decision about route naming (collapse `/living-brain` → `/brain`, `/brain` → `/brain/overview`, `/nexus` → `/code`). The plan doc's locked decisions table ends at D-BRAIN-VIZ-13. A reader of the plan doc would have no way to discover this decision.

### SSE event taxonomy does not match what shipped

Doc §6.1 lists these SSE events for Phase 2b:
- `brain_retrieval_log INSERT trigger → SSE event 'retrieval'`
- `brain_page_edges UPDATE → SSE event 'edge.strengthen'`
- `brain_observations INSERT → SSE event 'node.create'`
- `tasks.status UPDATE → SSE event 'task.status'`
- `nexus phase transition → SSE event 'nexus.reindex'`
- `conduit.messages INSERT → SSE event 'message.send'`

What actually shipped in `types.ts:158-180`:
- `hello` (connect acknowledge)
- `heartbeat` (keepalive every 30s)
- `node.create` (brain observations)
- `edge.strengthen` (brain page edges weight update)
- `task.status` (tasks status change)
- `message.send` (conduit messages)

The `retrieval` event was NOT shipped. The `nexus.reindex` event was NOT shipped. The `hello` and `heartbeat` events are not mentioned in the plan. The plan says "5 event types" when the shipped implementation has 6 distinct types (or 4 substantive + 2 infrastructure).

### STDP schema deviates from spec

`stdp-feasibility.md §3.2` specifies adding three columns to `brain_page_edges`:
- `lastReinforcedAt`
- `reinforcementCount`
- `plasticityClass` with enum `('static', 'hebbian', 'stdp')`

These columns do NOT exist on `brain_page_edges`. The shipped implementation instead uses a separate `brain_plasticity_events` table (LTP/LTD events log). This is a valid architectural choice but it means the spec is wrong as a description of what shipped.

`stdp-feasibility.md §3.3` specifies adding `retrievalOrder` and `rewardSignal` to `brain_retrieval_log`. Only `sessionId` was added; `retrievalOrder` and `rewardSignal` are absent. R-STDP (D-BRAIN-VIZ-13) is therefore not implemented despite the decision being listed as "locked."

`stdp-feasibility.md §3.4` `brain_weight_history` audit table: NOT in schema.

### Task ID T5157 does not exist

Both plan docs and the memory file reference `T5157` as the sqlite-vec integration task. The task does not exist in the task database. The comment `@task T5157` appears in `brain-sqlite.ts:190,210`. This is a stale reference to a deleted or mis-numbered task.

### Memory file `brain-living-initiative.md` contains the same stale data

Lines 56-59 of the memory file repeat all five wrong line numbers verbatim. Line 60 still references `packages/studio/src/routes/living-brain/+page.svelte` (deleted). Lines 64-70 still describe the enum drift as unfixed (it is fixed). The memory file was not updated when T635 and T649 completed.

---

## What Should Be Updated in the Plan Doc

1. **Add D-BRAIN-VIZ-14** to the locked decisions table: "Route consolidation: `/living-brain` → `/brain` (canvas), `/brain` → `/brain/overview` (stats), `/nexus` → `/code`."

2. **Phase 1a evidence**: Change `packages/studio/src/routes/living-brain/+page.svelte` to `packages/studio/src/routes/brain/+page.svelte`. File path is stale post-T649.

3. **Phase 1b evidence**: Change `brain/+page.server.ts (8 stat cards)` to `brain/overview/+page.server.ts (8 stat cards)`. After T649 the canvas owns `/brain`, overview owns `/brain/overview`.

4. **Phases 2a, 2b, 2c**: Mark all three ✅ DONE. Cite `brain/+page.svelte:227` for time slider, `api/living-brain/stream/+server.ts` for SSE, `LivingBrainCosmograph.svelte` + `brain/+page.svelte:382` for Cosmograph. Add T635 as done.

5. **Phase 3a**: Mark ✅ DONE. Cite `brain-schema.ts:567,571` for enum entries, `brain-sqlite.ts:166-179` for runtime migration.

6. **Phase 5**: Mark 🟡 PARTIAL. The main STDP algorithm shipped (`brain-stdp.ts`, `brain_plasticity_events` table, step 9 in consolidation, v2026.4.51). The spec schema (§3.2-3.4 columns) was not applied — different approach taken. Owner checkpoint requirement (D-BRAIN-VIZ-08) has no evidence of completion.

7. **All five line number references**: Correct across both docs and memory file:
   - `brain-lifecycle.ts:911` → `930`
   - `brain-lifecycle.ts:606` → `625`
   - `brain-retrieval.ts:1415` → `1477`
   - `brain-sqlite.ts:172` → `192`
   - `brain-sqlite.ts:192` → `212`

8. **Schema counts**: Fix "12-element edge enum" to 16 throughout. Fix "31 kinds" to 33. Fix "22 types" to 21.

9. **SSE event taxonomy in §6.1**: Correct the planned events to match what shipped. Remove `retrieval` and `nexus.reindex`. Add `hello` and `heartbeat` as infrastructure events. Note that 4 substantive events shipped (not 5).

10. **stdp-feasibility.md §3.2-3.4**: Annotate that the shipped implementation chose `brain_plasticity_events` event log over adding columns to `brain_page_edges`. Mark §3.2 and §3.3 columns as "planned but not yet applied."

11. **Remove T5157 references**: The task does not exist. Replace with "T5157 (sqlite-vec integration)" or locate the correct task ID.

12. **Update memory file `brain-living-initiative.md`**: Apply all the same line number corrections. Change `/living-brain/+page.svelte` to `/brain/+page.svelte`. Mark enum drift as fixed. Mark Phase 2 as done.

---

## What's Genuinely Coherent and Should Stay

1. **D-BRAIN-VIZ-01 through D-BRAIN-VIZ-13 rationale** — all 13 decisions are sound and the reasoning is well-documented. The decisions themselves are correct even if implementation status needs updating.

2. **§3 Substrate Map** — The 5-substrate architecture description is accurate. `project_registry.brain_db_path` and `tasks_db_path` do exist. The cross-link surface descriptions are correct (verified against schema files).

3. **§4 Cross-Substrate Edge Reality** — §4.1 (edges that exist) and §4.2 (edges that don't) are both accurate. The missing edges (decisions→brain_page_edges, observations→files/symbols, nexus_cross_project_edges) are genuinely missing.

4. **§5 Hebbian plasticity description** — The description of what `strengthenCoRetrievedEdges` does (reads retrieval_log, counts unordered pairs, strengthens at ≥3 co-retrievals, inserts with weight 0.3 if absent) is accurate. Only the line number reference is wrong.

5. **§6.0 Target architecture** — Still aspirational and still accurate. 3d-force-graph, Graphology shared model, SSE from hooks — these are correct goals and two of the three are now partially shipped.

6. **§7 Phase plan kill criteria** — All kill criteria are well-reasoned and remain valid guidance.

7. **§8 Open questions** — All 5 open questions remain genuinely open and relevant.

8. **stdp-feasibility.md §1** — The "what we are NOT building" framing is correct and the table of biological STDP vs CLEO STDP-inspired is accurate.

9. **stdp-feasibility.md §2** — The limitations of the current Hebbian implementation are accurate.

10. **stdp-feasibility.md §5** — The SQLite scale math and ceiling analysis is sound and uncontested.

11. **stdp-feasibility.md §8 decisions to lock at owner checkpoint** — These 8 questions are still unresolved. The spec is correct that they need resolution before the full Phase 5 schema can be applied.

12. **§9 Sources** — All library URLs are real and correct (cosmograph.app, github.com/vasturiano/3d-force-graph, graphology.github.io, etc.). No obviously broken links.

---

## Summary Judgment

The plan doc v3 was accurately grounded when written on 2026-04-15. However, multiple features shipped on the same day as or shortly after the doc was written (T635 closed Phase 2, T649 renamed routes, T626 closed Phase 3a). The doc was not updated to reflect these completions.

The net result: the doc claims that Phases 2a, 2b, 2c, 3a, and 5 are OPEN when they are DONE or PARTIAL. It uses stale file paths for Phase 1a and 1b evidence. It has five wrong line number references and three wrong schema counts. The memory file contains the same errors.

The architecture decisions, substrate map, missing-edge analysis, kill criteria, and open questions are sound and should not be changed.
