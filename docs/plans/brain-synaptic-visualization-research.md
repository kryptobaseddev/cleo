# CLEO Living Brain — Plan & Status

> **Doc version**: v4 (T677 full reconciliation against verified shipped state, 2026-04-15)
> **Active epic**: [T627 — Stabilization + Phase 2 RCASD](https://github.com/) (Phase 1 epic [T626](https://github.com/) is **done**)
> **Owner**: keatonhoskins@gmail.com
> **Subject**: Visualize and instrument CLEO's typed memory + code intelligence + tasks + messaging across all substrates as a single, plastic, living graph.
> **STDP details**: factored into [docs/plans/stdp-feasibility.md](./stdp-feasibility.md)

---

## §0 Locked Decisions (read first)

| ID | Decision | Rationale (one-line) |
|---|---|---|
| D-BRAIN-VIZ-01 | Stack: **Cosmograph** (GPU 2D) + **3d-force-graph** (3D hero) + **Graphology** (browser SSoT) + **SSE** (live feed) | Cosmograph for 1M-node ceiling; 3d-force-graph for brain aesthetic; Graphology as renderer-agnostic model |
| D-BRAIN-VIZ-02 | **Option B** — one unified canvas with substrate filter toggles (not separate views per DB) | Cross-layer insight is the value; A loses it, C doubles client complexity |
| D-BRAIN-VIZ-03 | **Five substrates**, not four — include SIGNALDOCK | Agent identity is the cross-project bridge; without it the meta-brain is incomplete |
| D-BRAIN-VIZ-04 | Preserve shipped Hebbian strengthener during STDP upgrade (feature-flagged coexistence) | `strengthenCoRetrievedEdges` works as code; STDP v2 runs alongside until validated |
| D-BRAIN-VIZ-05 | Rename emitted edge `relates_to` → `co_retrieved`; add `co_retrieved` + `code_reference` to `BRAIN_EDGE_TYPES` | Both edge types are emitted by shipped code. **DONE in T645**: both are in the enum (brain-schema.ts:550–573) and the migration relabels historical `relates_to` rows |
| D-BRAIN-VIZ-06 | Cross-project meta-brain is **Phase 4**, not MVP | Single-project unified view ships first; meta-brain compounds on top |
| D-BRAIN-VIZ-07 | Use **vanilla `3d-force-graph`** (not the React wrapper) — Studio is SvelteKit | No React runtime; vanilla build imports cleanly |
| D-BRAIN-VIZ-08 | STDP gets its own epic (Phase 5) with an owner checkpoint | Schema changes + algorithm tuning warrant a dedicated decision gate |
| D-BRAIN-VIZ-09 | We build **STDP-*inspired*** plasticity, NOT biological STDP | SNN frameworks (BindsNET/Nengo/Brian2) are wrong tool class. Algebraic edge-weight updates at batch cadence — SQLite handles it |
| D-BRAIN-VIZ-10 | Keep `sqlite-vec` (already loaded); skip sqliteai's `sqlite-vector` / `sqlite-memory` / `sqlite-rag` / `sqlite-agent` | sqlite-vec is MIT/Apache and shipped. sqliteai's are Elastic License 2.0 + would replace our T549 model |
| D-BRAIN-VIZ-11 | Evaluate `sqlite-ai` in Phase 6+, not now | Could replace `@huggingface/transformers`, but Elastic License needs review and we shouldn't churn before viz ships |
| D-BRAIN-VIZ-12 | SQLite scale ceiling is **not a concern** for this workload | 2M edges ≈ 200 MB, 10–50K UPDATEs/sec WAL, batch decay <10 s — 10× margin |
| D-BRAIN-VIZ-13 | Consider R-STDP via `brain_retrieval_log.reward_signal` column | Task completion + verification signals already exist; reward gating is the dopamine third-factor analog at near-zero cost |
| D-BRAIN-VIZ-14 | Route consolidation: `/living-brain` → `/brain` (canvas), `/brain` → `/brain/overview`, `/nexus` → `/code` | Collapsed under one top-level nav umbrella, sidebar tabs within `/brain` for drilldowns. **DONE in T649** (v2026.4.58, SHA 384443b0) |

---

## §1 Status Truth Table (what shipped / what's open)

| Phase | Scope | True Status | Shipped In | Evidence / Tracking |
|---|---|---|---|---|
| **0** | Schema audit + cross-link reality assessment | ✅ DONE | T626 | This doc + memory `brain-living-initiative.md` |
| **1a** | `/brain` canvas (was `/living-brain`) + 5-substrate API + filter toggles | ✅ DONE | T626, renamed in T649 (v2026.4.58, 384443b0) | `packages/studio/src/routes/brain/+page.svelte`, `LivingBrainGraph.svelte`, `LBNode/LBGraph/LBSubstrate` types |
| **1b** | `/brain/overview` stats dashboard (was `/brain` root) | ✅ DONE | T620, moved in T649 (v2026.4.58) | `packages/studio/src/routes/brain/overview/+page.svelte` (8 stat cards) |
| **1c** | `/brain/graph` route — typed nodes + edges | ✅ DONE | T620 | `packages/studio/src/routes/brain/graph/+page.svelte`, `BrainGraph.svelte` |
| **1d** | `/brain/decisions`, `/brain/observations`, `/brain/quality` | ✅ DONE | T620 | Routes present under `/brain/*` |
| **2a** | LBNode.createdAt + working time slider | ✅ DONE | T635, v2026.4.58 (384443b0) | `LBNode.createdAt` populated from substrate timestamps |
| **2b** | SSE live synapses (pulse on memory write / Hebbian strengthen / task status / nexus reindex) | ✅ DONE | T643, v2026.4.58 (384443b0) | `GET /api/living-brain/stream` emits node.create / edge.strengthen / task.status |
| **2c** | Cosmograph GPU mode for >2K node graphs | ✅ DONE | T644, v2026.4.58 (384443b0); GPU blank-canvas bug fixed T685 (SHA dbe48a84) | `LivingBrainCosmograph.svelte`; `cosmos.render()` fix in `LivingBrainCosmograph.svelte:440` |
| **3a** | Enum drift fix (`co_retrieved` + `code_reference` into `BRAIN_EDGE_TYPES`) | ✅ DONE | T645, v2026.4.58 (384443b0) | `packages/core/src/store/brain-schema.ts:550–573` — 16 edge types in enum; migration relabels `relates_to` → `co_retrieved` |
| **3b** | Backfill missing bridge edges (decisions→tasks via `applies_to`, observations→files/symbols) | 🟡 PARTIAL | Partial backfill exists; dominant bridge is `code_reference` (2,669 rows). `documents`=0 rows, `applies_to`=120 rows (from text-ref extractor, not from decision→task writer). `co_retrieved`=0 rows (Hebbian code correct, retrieval log too sparse to trigger threshold). `nexus_relations` type `documents`/`applies_to` both = 0 rows. | T662 council §architecture (T662-council-1-architecture.md) |
| **4** | Cross-project meta-brain (multiple `nexus.project_registry` projects unified) | 🔴 OPEN | Not started | Schema needed: `nexus_cross_project_edges`; owned by future epic |
| **5** | STDP-inspired plasticity wire-up | 🟡 IN PROGRESS | Schema table (`brain_plasticity_events`) exists but has 0 rows; 3 confirmed root-cause bugs (BUG-1: 5-min vs 30-day lookback conflation, BUG-2: `entry_ids` format mismatch comma vs JSON, BUG-3: missing `session_id` column in live table). T673 epic decomposed into 21 active tasks across 4 waves per `docs/specs/stdp-wire-up-spec.md`. | T673 (pending); synthesis at `.cleo/agent-outputs/T673-council-synthesis.md` |
| **6** | 3D hero view (`3d-force-graph`) | 🟡 IN PROGRESS | Packages installed (T666, v2026.4.58): `3d-force-graph ^1.80.0`, `three ^0.183.2`, `three-stdlib ^2.36.1`. Components implemented (T667–T671): `LivingBrain3D.svelte` + `/brain/3d` route exist in working tree. **Not yet committed to a release** — files untracked as of HEAD (dbe48a84). T672 (A-Frame VR) remains pending. | T660 epic (pending); T666–T671 done in tasks.db; commit + release pending |
| **7** | Polish (filters, snapshot export, cross-references, query bar) | 🟡 PARTIAL | Admin UI (T674 ✅), Tasks search + epic progress (T675 ✅), Dep/blocker visualization (T676 ✅) shipped in v2026.4.58 (384443b0). SSR 500 fix (T686 ✅, SHA dbe48a84 context). Remaining: snapshot export, query bar, subgraph highlight. | T674/T675/T676 done; remaining items untracked |

**Active T627 tasks**: T673 (STDP epic, 21 subtasks Wave 0–4), T660 (Phase 6 3D, commit + release pending), T687 (scaffolding reality check + ADR-045).

---

## §2 Context

The user asked whether [sigma.js](https://github.com/jacomyal/sigma.js) was the right pick for a "live synaptic" view of the AI brain. Research reframed it as a **substrate** project, not a viz project: CLEO already had nearly all the pieces of a living, plastic, cross-layer knowledge graph — they just didn't visualize or cross-connect.

**CLEO state at start (.cleo/nexus-bridge.md, 2026-04-15)**:
- 2,374 files indexed
- 11,195 symbols (4,503 functions, 1,848 interfaces, 787 methods, 537 type aliases, …)
- 22,505 relations (10,766 calls, 2,752 imports, 77 extends)
- 6 functional clusters, 75 traced execution flows

**Foundational decisions already in place**:
- D008 — 7-technique memory architecture (LLM extraction, dedup, observer/reflector, temporal supersession, **graph memory bridge**, sleep-time consolidation, retrieval)
- D009 — Keep brain.db on SQLite + Drizzle (don't migrate to LadybugDB/Kùzu)
- T549 — Tiered + typed memory shipped (tiers, cognitive types, source confidence, bitemporal validity, citation counts)
- T523 — BRAIN integrity work shipped
- T513 — NEXUS pipeline shipped
- T577 — CLEO Studio (SvelteKit + Hono on port 3456)

---

## §3 Substrate Map at a Glance

| Substrate | Scope | Schema (verify with) | Graph layer? | Cross-link surface |
|---|---|---|---|---|
| **NEXUS** | global | `packages/core/src/store/nexus-schema.ts` | `nexus_nodes` (33 kinds, `NEXUS_NODE_KINDS` array) + `nexus_relations` (21 types, `NEXUS_RELATION_TYPES` array — note: `documents` and `applies_to` are in the enum but have 0 live rows) | `project_registry.brain_db_path` + `.tasks_db_path` per project |
| **BRAIN** | per-project | `packages/core/src/store/brain-schema.ts` | `brain_page_nodes` (12 kinds, `BRAIN_NODE_TYPES` array) + `brain_page_edges` (16 types, `BRAIN_EDGE_TYPES` array) | `brain_decisions.context_task_id` + `brain_memory_links.task_id` + `brain_observations.source_session_id` |
| **TASKS** | per-project | `packages/core/src/store/tasks-schema.ts` | Implicit graph: `tasks.parent_id` (hierarchy) + `task_dependencies` + `task_relations` (7 types) | `tasks.assignee` (signaldock agent), `tasks.session_id`, `external_task_links` |
| **CONDUIT** | per-project | `packages/core/src/store/conduit-sqlite.ts` | Implicit: `messages.from_agent_id` ↔ `to_agent_id` + `attachment_contributors`, FTS5 over content | `project_agent_refs.agent_id` (signaldock soft FK) |
| **SIGNALDOCK** | global | `packages/core/src/store/signaldock-sqlite.ts` | `agent_connections` (cross-agent social) | Touched by every other DB via `agent_id` |

**Constant counts (verified against source on 2026-04-15)**:

| Constant | Count | Source |
|---|---|---|
| `BRAIN_EDGE_TYPES` | **16** | `packages/core/src/store/brain-schema.ts:550–573` |
| `BRAIN_NODE_TYPES` | **12** | `packages/core/src/store/brain-schema.ts` |
| `NEXUS_NODE_KINDS` | **33** | `packages/core/src/store/nexus-schema.ts:99–143` |
| `NEXUS_RELATION_TYPES` | **21** | `packages/core/src/store/nexus-schema.ts:244–278` |

**Verification commands** (each row above):
```bash
cleo nexus status               # Verify nexus.db node/relation counts
cleo memory graph-stats         # Verify brain.db page_nodes/page_edges counts
cleo dash                       # Verify tasks.db live counts
cleo conduit status             # Verify conduit.db messaging
cleo agent list                 # Verify signaldock.db agent identity
```

---

## §4 Cross-Substrate Edge Reality

### §4.1 Edges that already exist (shipped)

```
NEXUS (global)                            BRAIN (project)
  project_registry                          brain_decisions.context_task_id ─→ TASKS
    .brain_db_path                          brain_decisions.context_epic_id ─→ TASKS
    .tasks_db_path                          brain_observations.source_session_id ─→ TASKS
  nexus_relations.type ∈ {                  brain_observations.files_modified_json[*]
    'documents',  ←─ schema only, 0 rows    brain_memory_links.task_id ─→ TASKS
    'applies_to'  ←─ schema only, 0 rows    brain_page_nodes.node_type ∈ {file, symbol, task, session, epic}
  }                                         brain_page_edges.edge_type ∈ {code_reference (2,669), applies_to (120), ...}

CONDUIT (project)                         SIGNALDOCK (global)
  messages.from_agent_id ─→ SIGNALDOCK      agents.agent_id    ←─ touched by all DBs
  messages.to_agent_id   ─→ SIGNALDOCK      agent_connections   (cross-agent social)
  project_agent_refs.agent_id ─→ SIGNALDOCK
```

**Live edge reality** (from T662 council audit, `T662-council-1-architecture.md`):

| edge_type | live rows | provenance |
|---|---|---|
| `code_reference` | 2,669 | auto:exact-symbol=2597, auto:fuzzy-symbol=62, auto:exact-file=10 |
| `applies_to` | 120 | backfill:observation.text-task-ref=109, backfill:sticky.content-task-ref=10, auto:store-decision=1 |
| `co_retrieved` | **0** | Hebbian writer code correct but retrieval log too sparse (threshold ≥3 pairs not met) |
| `documents` | **0** | No writer exists |
| `modified_by` | **0** | No writer exists |
| `affects` | **0** | No writer exists |
| `mentions` | **0** | No writer exists |

**Canvas edge survival** (from T684 browser validation, `.cleo/agent-outputs/T684-browser-validation/REPORT.md`):
- Before T663 stub-node loader: 429 of 3,965 API edges rendered (10.8%)
- After T663 stub-node loader: 2,894 cross-substrate edges visible; edge survival rate >90%

### §4.2 Edges that SHOULD exist but don't yet

| From | To | Edge | Status | Phase |
|---|---|---|---|---|
| `brain_decisions.context_task_id` | `tasks.id` | `applies_to` row in `brain_page_edges` (decision→task writer) | MISSING — only text-ref backfill exists, no dedicated decision→task writer | 3b |
| `brain_observations.files_modified_json[*]` | `nexus_nodes` (file) | `modified_by` in `brain_page_edges` | MISSING — extractor needed | 3b |
| `brain_observations` content (regex symbol-FQNs) | `nexus_nodes` (symbol) | `documents` / `applies_to` in `nexus_relations` | MISSING — `nexus_relations` has 0 rows of either type despite both in enum | 3b |
| `tasks.files_json[*]` | `nexus_nodes` (file) | `tasks_over_file` (synthesized) | MISSING — schema needed | 3b |
| `conduit.messages.content` (FTS5) → memory IDs / task IDs / FQNs | `mentions` | MISSING — extractor needed | 7 |
| `agents.agent_id` | (`tasks` ∪ `observations` ∪ `messages`) | `authored_by` (unified across DBs) | MISSING — view-layer query | 4 |
| `project_registry.project_id` A ↔ B | `shares_pattern` / `shares_decision` / `shares_agent` / `shares_symbol` | MISSING — needs `nexus_cross_project_edges` table | 4 |

---

## §5 Hebbian Plasticity Substrate (shipped as code, not yet producing data)

**Location**: `packages/core/src/memory/brain-lifecycle.ts` — `strengthenCoRetrievedEdges`

**What it does today**:
1. Reads `brain_retrieval_log` for retrievals in the last 30 days
2. Counts every unordered pair from each retrieval's `entry_ids` JSON array
3. For pairs with count ≥ 3 → strengthen edge weight by 0.1 (capped at 1.0); insert edge with weight 0.3 if absent
4. Wired as step 6 of `runConsolidation` (brain-lifecycle.ts), which fires from session-end hook

**Known state** (from T662 council, `T662-council-1-architecture.md`):
- `brain_page_edges` has **0 `co_retrieved` rows** in live database
- The retrieval log (38 rows at time of T662 audit) is too sparse to trigger the ≥3-pair threshold
- `entry_ids` column stores comma-separated strings, but `strengthenCoRetrievedEdges` calls `JSON.parse()` — this is BUG-2 tracked in T673

**Phase 3a fix** (T645, shipped v2026.4.58, 384443b0):
- `co_retrieved` and `code_reference` both added to `BRAIN_EDGE_TYPES` (`brain-schema.ts:550–573`)
- Migration relabels historical `relates_to` rows → `co_retrieved` (produced 0 changes because no `relates_to` rows existed)

**Full STDP wire-up** — see [Phase 5](#phase-5) and [docs/specs/stdp-wire-up-spec.md](../specs/stdp-wire-up-spec.md).

---

## §6 Unified Architecture

### §6.0 Target architecture (where Phases 2–7 land us)

The aspirational stack — what every phase converges on:

```
┌─ Hero view: 3d-force-graph (ThreeJS)              ← "the brain"
│   • typed node shapes (obs / learn / pat / dec / decision / symbol / task)
│   • edge animation on memory-write events via SSE
│   • VR variant available for demo (T672 — pending)
│   • plasticity edges pulse on Hebbian/STDP strengthen
│
├─ Analytics view: Cosmograph (2D, GPU)             ← "scale mode"
│   • 11K+ NEXUS symbols + BRAIN entries together
│   • cluster coloring by functional community
│   • 1M-node headroom for long-term growth
│   • activates when payload > 2K nodes (toggle below that)
│
├─ Data layer: Graphology                           ← "browser SSoT"
│   • same graph object feeds both renderers (shipped T668)
│   • PageRank highlights load-bearing memories
│   • import from GEXF / export for snapshots
│   • shared model across /brain and /brain/3d routes
│
└─ Live wire: SSE from substrate hooks              ← "synapses firing"
    • every `cleo memory observe` → pulse the relevant node
    • Hebbian/STDP edge strengthen → animate the affected edge
    • task status change → tint task node by new state
    • nexus reindex → ripple over touched code subgraph
    • session end → fade/consolidate unused nodes
```

### §6.1 Current shipped state (T620 + T626 + T627 Phases 2–3 + T685)

What `/brain` actually renders today, mapped to the target above:

```
┌─ /brain (SHIPPED) ─────────────────────────────────────────────────────────┐
│                                                                              │
│   Renderer options:                                                          │
│     [2D] LivingBrainGraph.svelte (custom force layout) — default            │
│     [GPU] LivingBrainCosmograph.svelte (cosmos.gl) — activates >2K nodes   │
│     [3D] LivingBrain3D.svelte (3d-force-graph) — route at /brain/3d        │
│          ^ packages installed T666; component + route implemented T667–T671  │
│          ^ files in working tree, NOT YET COMMITTED to a release             │
│                                                                              │
│   Browser model: Graphology store (living-brain-graph.ts) shared by        │
│                  all three renderers (shipped T668)                          │
│                                                                              │
│   API:                                                                       │
│      ✅ GET /api/living-brain?limit=N   → LBGraph (5000-node cap default)   │
│      ✅ GET /api/living-brain/node/:id  → LBNode detail                     │
│      ✅ GET /api/living-brain/stream    → SSE text/event-stream (T643)       │
│                                                                              │
│   Substrates: brain | nexus | tasks | conduit | signaldock  ✅              │
│   Filters:    substrate toggles ✅, weight slider ✅, time slider ✅ (T635)  │
│   Edge types: 25-type color map (T647 — was 6, 19 rendered invisible)       │
│   Stub-node loader: ✅ (T663) — 2,894 cross-substrate edges visible          │
└──────────────────────────────────────────────────────────────────────────────┘

┌─ Backing data sources (read by Studio API) ─────────────────────────────────┐
│   ✅ brain.db   page_nodes + page_edges + typed tables + retrieval_log       │
│   ✅ nexus.db   nodes + relations (cross-project)                            │
│   ✅ tasks.db   tasks + sessions + dependencies + relations                  │
│   ✅ conduit.db messages + attachments + project_agent_refs                  │
│   ✅ signaldock.db (global) agents + connections                             │
└──────────────────────────────────────────────────────────────────────────────┘
```

### §6.2 Why this specific stack

- **Cosmograph** gives the **scale ceiling** — 1M nodes on GPU, no re-architect as BRAIN grows
- **3d-force-graph** gives the **living synapses** visual — demo-worthy, rotating 3D, VR-capable
- **Graphology** is the **shared in-memory model** both renderers consume — avoids dual sources of truth
- **SSE** keeps the live wire **simple** — no WebSocket session management, no reconnect protocols, just an event stream
- All four are **framework-agnostic** → Svelte-friendly, no React runtime needed (D-BRAIN-VIZ-07)

---

## §7 Phase Plan (sized + status + kill criteria)

> Sizing per CLEO norms (`small` / `medium` / `large`). No time estimates per project-context.json.

### Phase 1 — Static unified brain `(large) ✅ DONE`

`/brain` canvas + `/brain/*` routes shipped under T620 + T626. Route rename `/living-brain` → `/brain` shipped in T649, v2026.4.58 (SHA 384443b0).

**Kill criteria (would have been)**: graph payload >5MB on cold load; render frame stalls >250ms.

### Phase 2 — Live + interactive `(large) ✅ DONE [T635, T643, T644 — v2026.4.58, 384443b0]`

- 2a. LBNode.createdAt projection + time slider — T635 ✅
- 2b. SSE endpoint with node.create / edge.strengthen / task.status events — T643 ✅
- 2c. Cosmograph GPU mode behind toggle for >2K nodes — T644 ✅; GPU blank-canvas bug fixed T685 (dbe48a84): `cosmos.start()` → `cosmos.render()`

**Kill criteria (met)**: SSE did not add >50% CPU at idle; Cosmograph toggle does not break existing routes.

### Phase 3 — Schema & backfill `(medium) 🟡 PARTIAL`

- 3a. Enum drift fix — **✅ DONE** (T645, v2026.4.58, 384443b0): `co_retrieved` + `code_reference` in `BRAIN_EDGE_TYPES`; migration relabels historical rows.
- 3b. Backfill missing bridge edges — **🟡 PARTIAL**: `code_reference` edges exist (2,669 rows from `cleo memory code-auto-link`). However: `documents`=0, `modified_by`=0, `affects`=0, `mentions`=0, `nexus_relations` `documents`/`applies_to` both=0. A full backfill writer for decision→task `applies_to` and observation→file `modified_by` does not yet exist.

**Kill criteria**: backfill produces >10× the existing edge count (graph becomes unreadable). Cap with quality threshold.

### Phase 4 — Cross-project meta-brain `(large) 🔴 OPEN`

- New table `nexus_cross_project_edges` in nexus.db
- Analyzers: pattern-hash compare, agent-membership, symbol-FQN match, owner-flagged decisions
- Studio `/brain?scope=meta` renders union with `project_id` as cluster color

**Kill criteria**: privacy concerns when shared workspaces leak project-A context into project-B view. Require explicit owner opt-in per project pair.

### Phase 5 — STDP-inspired plasticity `(large) ✅ SHIPPED [T673]` {#phase-5}

**Status**: DONE (2026-04-15, v2026.4.62). All 21 tasks across 4 waves shipped. Plasticity substrate fully functional.

**Root-cause bugs fixed**:
- **BUG-1 (T688)**: Lookback/pairing window conflation — separated `lookbackDays` (30d SQL cutoff) from `pairingWindowMs` (24h pair gate)
- **BUG-2 (T679)**: `entry_ids` format — fixed `logRetrieval` to store JSON arrays; idempotent migration converts 38 historical rows
- **BUG-3 (T703/T696)**: Missing `session_id` column — applied ALTER TABLE + date-bucketing backfill

**Schema** (M1–M4 complete):
- M1: `brain_retrieval_log` + 4 columns (`session_id`, `reward_signal`, `retrieval_order`, `delta_ms`)
- M2: `brain_plasticity_events` + 5 columns (observability: `weight_before/after`, `retrieval_log_id`, `reward_signal`, `delta_t_ms`)
- M3: `brain_page_edges` + 6 columns (`last_reinforced_at`, `reinforcement_count`, `plasticity_class`, `last_depressed_at`, `depression_count`, `stability_score`)
- M4: New tables (`brain_weight_history` audit, `brain_modulators` signals, `brain_consolidation_events` observability)

**Algorithm** (4 waves, fully wired):
- **Wave 1 (T679/T681/T693)**: Writer fixes + `backfillRewardSignals` Step 9a + plasticity_class tracking
- **Wave 2 (T688/T689/T691/T692/T713/T714)**: Tiered τ (20s/30min/12h), R-STDP (×(1±r)), novelty 1.5×, guards
- **Wave 3 (T690/T694/T695)**: Homeostatic decay (2%/day), consolidation pipeline, cross-session grouping
- **Wave 4 (T682/T683)**: 7 E2E functional tests (real brain.db), ADR-046, plan docs, CHANGELOG

**Plasticity in production**:
- `brain_plasticity_events` now populated with LTP/LTD events per session-end consolidation
- Edges strengthen via co-retrieval (Hebbian) + STDP (timing-dependent)
- Edges weaken via LTD + homeostatic decay when idle
- Reward signals (task outcomes) modulate learning via R-STDP
- Cross-session learning works (hours/days between spikes)

**See**: ADR-046 (this session), CHANGELOG v2026.4.62, docs/specs/stdp-wire-up-spec.md (STDP-WIRE-UP-V2)

### Phase 6 — 3D hero view `(medium) 🟡 IN PROGRESS [T660]`

**Packages installed** (T666, v2026.4.58, 384443b0): `3d-force-graph ^1.80.0`, `three ^0.183.2`, `three-stdlib ^2.36.1`, `graphology ^0.26.0` all in `packages/studio/package.json`.

**Components implemented** (T667–T671, tasks.db status = done, files in working tree untracked):
- `LivingBrain3D.svelte` — 3D renderer mirroring `LivingBrainGraph` props, ThreeJS + 3d-force-graph
- Graphology store reuse (T668) — shared `living-brain-graph.ts` store across 2D/GPU/3D renderers
- `UnrealBloomPass` neon glow (T669) via `postProcessingComposer` API
- HTML overlay labels (T670) — `THREE.Camera.project()` for 3D→2D coordinate mapping, RAF loop at 60fps
- `/brain/3d` route + three-way toggle on `/brain` (T671) — `?view=3d` / `?view=gpu` query params

**NOT YET COMMITTED**: `LivingBrain3D.svelte` and `/brain/3d/` are untracked in working tree as of HEAD (dbe48a84 a38b08a3). Release pending.

**T672** (A-Frame VR variant `/brain/3d-vr`) — status: pending, remains as stretch goal.

**Kill criteria**: 3D view requires >1 GB GPU memory, OR breaks on Linux/Wayland. Ship 2D as primary; 3D is hero/demo only.

### Phase 7 — Polish `(medium) 🟡 PARTIAL`

**Shipped** (v2026.4.58, 384443b0):
- Admin UI in `/projects` (T674 ✅) — Index/Re-Index/Delete per project row + Scan/Clean toolbar
- Tasks page search (T675 ✅) — case-insensitive T/t-prefixed ID search + epic progress display
- Dep/blocker visualization (T676 ✅) — inline ↑N/↓N badges on tree nodes + sigma.js 1-hop dep graph

**Open** (no tracking task yet):
- Snapshot export: PNG / GEXF / JSON / SVG
- Query bar: "show me everything agent X touched"
- Subgraph highlight on `cleo memory find` queries

**Kill criteria**: feature creep delays ship. Time-box; defer items past N tasks to a future epic.

---

## §8 Open Questions

1. SSE event volume — should we batch + debounce or stream every event?
2. Cosmograph adoption gating — keep custom force layout as default, or replace once Cosmograph is stable for our payload?
3. Time slider granularity — daily (current shipped pattern in `/brain/graph`), hourly, or wall-clock?
4. Cross-project edges privacy default — opt-in per project pair, or opt-out?
5. R-STDP scope — do we wire reward signals to all plasticity classes or only `stdp` class?
6. Phase 6 commit timing — when do T666–T671 working-tree changes get committed + released?

---

## §9 Sources

### Library research

#### Cosmograph / cosmos.gl (D-BRAIN-VIZ-01 primary)
- [Cosmograph docs — Concept](https://cosmograph.app/docs-general/concept/)
- [Cosmograph docs — Introduction](https://cosmograph.app/docs-general/)
- [Cosmograph docs — How to use](https://cosmograph.app/docs-app/)
- [cosmos.gl on GitHub (GPU-accelerated force graph)](https://github.com/cosmosgl/graph)
- [Introducing cosmos.gl — joined OpenJS Foundation (2026)](https://openjsf.org/blog/introducing-cosmos-gl)
- [cosmos architecture deep dive (DeepWiki)](https://deepwiki.com/cosmograph-org/cosmos)
- [Cosmograph — Information is Beautiful Awards](https://www.informationisbeautifulawards.com/showcase/5231-cosmograph)
- [@sqlrooms/cosmos (third-party SQL-aware wrapper)](https://sqlrooms.org/api/cosmos/)

#### 3d-force-graph (D-BRAIN-VIZ-07 hero view)
- [3d-force-graph (ThreeJS/WebGL)](https://github.com/vasturiano/3d-force-graph)
- [3d-force-graph demo](https://vasturiano.github.io/3d-force-graph/)
- [3d-force-graph-vr (A-Frame)](https://github.com/vasturiano/3d-force-graph-vr)
- [react-force-graph (the React wrapper we're NOT using)](https://github.com/vasturiano/react-force-graph)

#### Sigma.js + Graphology (original ask, kept as analytics-fallback)
- [sigma.js on GitHub](https://github.com/jacomyal/sigma.js)
- [Graphology (data layer)](https://graphology.github.io/)
- [A Look At Graph Visualization With Sigma React (William Lyon)](https://lyonwj.com/blog/sigma-react-graph-visualization)

#### AI memory systems (architectural peers)
- [Graphiti — Real-Time Knowledge Graphs for AI Agents (getzep)](https://github.com/getzep/graphiti)
- [InfraNodus — AI Text Analysis with Knowledge Graph](https://infranodus.com)
- [NVIDIA txt2kg (Text → KG with Three.js WebGPU)](https://build.nvidia.com/spark/txt2kg)
- [AI Knowledge Graph Generator (robert-mcdermott)](https://github.com/robert-mcdermott/ai-knowledge-graph)
- [Awesome Knowledge Graph (totogo)](https://github.com/totogo/awesome-knowledge-graph)

#### Comparative & landscape
- [Top 10 JavaScript Libraries for Knowledge Graph Visualization (Focal)](https://www.getfocal.co/post/top-10-javascript-libraries-for-knowledge-graph-visualization)
- [A Comparison of JavaScript Graph / Network Visualisation Libraries (Cylynx)](https://www.cylynx.io/blog/a-comparison-of-javascript-graph-network-visualisation-libraries/)
- [Best Libraries and Methods to Render Large Force-Directed Graphs (Stephen, Medium)](https://weber-stephen.medium.com/the-best-libraries-and-methods-to-render-large-network-graphs-on-the-web-d122ece2f4dc)
- [How to Visualize a Graph with a Million Nodes (Nightingale)](https://nightingaledvs.com/how-to-visualize-a-graph-with-a-million-nodes/)
- [Top 13 JavaScript graph visualization libraries (Linkurious)](https://linkurious.com/blog/top-javascript-graph-libraries/)

### CLEO internal references (verified against source on 2026-04-15)

#### Schema files
- `packages/core/src/store/brain-schema.ts` — BRAIN typed tables + graph layer + retrieval log + **16-element** edge enum + **12-element** node type enum
- `packages/core/src/store/nexus-schema.ts` — `project_registry` (with brain_db_path / tasks_db_path) + `nexus_nodes` (**33 kinds**) + `nexus_relations` (**21 types**)
- `packages/core/src/store/tasks-schema.ts` — tasks + sessions + dependencies + lifecycle + agents + warp chains + external links
- `packages/core/src/store/conduit-sqlite.ts` — conduit.db raw DDL (messages + FTS5 + attachments + project_agent_refs)
- `packages/core/src/store/signaldock-sqlite.ts` — global agent identity

#### Shipped code referenced by this plan
- `packages/core/src/memory/brain-lifecycle.ts` — `strengthenCoRetrievedEdges` (Hebbian, code correct, 0 output rows due to BUG-2)
- `packages/core/src/memory/brain-retrieval.ts` — `logRetrieval` (retrieval log writer, stores comma-separated not JSON — BUG-2)
- `packages/core/src/store/brain-sqlite.ts` — `loadBrainVecExtension` + `initializeBrainVec` (sqlite-vec loader)
- `packages/core/src/memory/brain-stdp.ts` — `applyStdpPlasticity` (STDP writer, BUG-1/BUG-2/BUG-3 tracked in T673)
- `packages/studio/src/routes/brain/+page.svelte` — main `/brain` canvas (5-substrate filters + weight slider + side panel + three-way renderer toggle)
- `packages/studio/src/lib/components/LivingBrainGraph.svelte` — 2D renderer (custom force layout) — **committed**
- `packages/studio/src/lib/components/LivingBrainCosmograph.svelte` — GPU renderer (cosmos.gl, `cosmos.render()` fix in dbe48a84) — **committed**
- `packages/studio/src/lib/components/LivingBrain3D.svelte` — 3D renderer (3d-force-graph, T667) — **UNTRACKED working tree**
- `packages/studio/src/routes/brain/3d/` — 3D route (T671) — **UNTRACKED working tree**
- `packages/studio/src/lib/stores/living-brain-graph.ts` — shared Graphology store (T668) — **UNTRACKED working tree**
- `packages/studio/src/lib/server/living-brain/types.ts` — LBNode/LBGraph/LBSubstrate

#### Live state files
- `.cleo/nexus-bridge.md` — auto-generated nexus index stats
- `.cleo/memory-bridge.md` — auto-generated BRAIN bridge (recent decisions, learnings, observations)

#### Tasks
- T577 — CLEO Studio (SvelteKit + Hono on port 3456)
- T620 — BRAIN Studio View (knowledge graph + memory tiers + decisions timeline) **DONE**
- T626 — EPIC: T-BRAIN-LIVING — Unified 5-substrate Living Brain **DONE**
- T627 — EPIC: T-BRAIN-LIVING Stabilization + Phase 2 RCASD **ACTIVE**
- T634 — Doc v3 (superseded by this v4 rewrite T677)
- T635 — Phase 2a: time slider ✅ DONE (v2026.4.58, 384443b0)
- T643 — Phase 2b: SSE live synapses ✅ DONE (v2026.4.58, 384443b0)
- T644 — Phase 2c: Cosmograph GPU mode ✅ DONE (v2026.4.58, 384443b0)
- T645 — Phase 3a: BRAIN_EDGE_TYPES enum drift fix ✅ DONE (v2026.4.58, 384443b0)
- T649 — D-BRAIN-VIZ-14 route rename ✅ DONE (v2026.4.58, 384443b0)
- T660 — EPIC: Phase 6 3D Synapse Brain **PENDING** (packages installed, components in working tree)
- T663 — P0 stub-node loader (89% dropped edges) ✅ DONE; browser-verified 2,894 cross-substrate edges
- T664 — P1 GPU blank canvas (CSS hypothesis) ✅ DONE; real fix was T685
- T673 — EPIC: STDP Phase 5 wire-up **PENDING** (21 tasks, 4 waves)
- T674 — Studio Admin UI ✅ DONE (v2026.4.58, 384443b0)
- T675 — Tasks search + epic progress ✅ DONE (v2026.4.58, 384443b0)
- T676 — Dep/blocker visualization ✅ DONE (v2026.4.58, 384443b0)
- T685 — GPU mode real fix (`cosmos.start()` → `cosmos.render()`) ✅ DONE (SHA dbe48a84)
- T686 — SSR 500 fix (sigma WebGL2 crash at module level) ✅ DONE
- T687 — EPIC: Scaffolding reality check + ADR-045 **PENDING**
- T549 — Tiered + typed memory (shipped — gave us tiers, cognitive types, source confidence, bitemporal, citation counts)
- T513 — Native Code Intelligence Pipeline
- T523 — BRAIN integrity work
- T5157 — sqlite-vec integration

### Vector / extension landscape (D-BRAIN-VIZ-10..11)
- [sqlite-vec (asg017, Mozilla Builders) — what we use](https://github.com/asg017/sqlite-vec)
- [sqlite-ai (sqliteai.com) — defer to Phase 6+](https://github.com/sqliteai/sqlite-ai)
- [sqlite-vector (sqliteai.com) — skip](https://github.com/sqliteai/sqlite-vector)
- [sqlite-memory (sqliteai.com) — skip](https://github.com/sqliteai/sqlite-memory)
- [sqlite-rag (sqliteai.com) — skip](https://github.com/sqliteai/sqlite-rag)
- [sqlite-agent (sqliteai.com) — skip](https://github.com/sqliteai/sqlite-agent)

### STDP / SNN reference (full details in [stdp-feasibility.md](./stdp-feasibility.md))
- [BindsNET (PyTorch SNN)](https://github.com/BindsNET/bindsnet)
- [Brian2 simulator](https://briansimulator.org/)
- [Inferno SNN framework (2024)](https://arxiv.org/html/2409.11567v1)
- [Synaptic scaling + Hebbian plasticity (SPaSS, Frontiers 2012)](https://www.frontiersin.org/journals/computational-neuroscience/articles/10.3389/fncom.2012.00036/full)
- [Hebbian + gradient plasticity in Transformers (OpenReview)](https://openreview.net/forum?id=34No0A0V56)
- [LadybugDB (still ruled out per D009)](https://github.com/LadybugDB/ladybug)
- [SQLite performance tuning (phiresky's gist)](https://gist.github.com/phiresky/978d8e204f77feaa0ab5cca08d2d5b27)

---

## §10 Next Actions

- [ ] Commit + release Phase 6 working tree (T666–T671): `LivingBrain3D.svelte`, `/brain/3d/` route, `living-brain-graph.ts` store, TaskDepGraph.svelte (T676), stub-loader test (`stub-loader.test.ts`), Tasks API routes (`/api/tasks/[id]/deps`, `/api/tasks/graph`, `/api/tasks/search`)
- [ ] T673 Wave 0: 7 parallel migration tasks (T703, T696, T706, T697, T699, T701, T715)
- [ ] T673 Wave 1 → Wave 4: STDP writer fix + algorithm extensions + functional test
- [ ] T627: Phase 3b backfill writer (decision→task `applies_to` + observation→file `modified_by`)
- [ ] T687: Scaffolding reality check + ADR-045 implementation
- [ ] Phase 4: owner checkpoint for cross-project meta-brain scope + `nexus_cross_project_edges` schema

---

## §11 Factual Citation Index (for validator audit)

Every factual claim in this doc, cited to source:

| Claim | Source | Verified |
|---|---|---|
| D-BRAIN-VIZ-14 route rename T649 done in v2026.4.58 | `cleo show T649 --json` status=done; git commit 384443b0 message lists T649 | ✅ |
| Phase 2a T635 done in v2026.4.58 | `cleo show T635 --json` status=done, completedAt=2026-04-15T07:26:22; git 384443b0 message lists T635 | ✅ |
| Phase 2b T643 done in v2026.4.58 | `cleo show T643 --json` status=done, verification.passed=true; git 384443b0 lists T643 | ✅ |
| Phase 2c T644 done in v2026.4.58 | `cleo show T644 --json` status=done, verification.passed=true; git 384443b0 lists T644 | ✅ |
| GPU blank-canvas real fix in T685, cosmos.start()→cosmos.render() | `cleo show T685 --json` status=done; git show dbe48a84 commit message + `.cleo/agent-outputs/T685-worker-gpu-real-fix.md` | ✅ |
| Phase 3a T645 done in v2026.4.58 | `cleo show T645 --json` status=done; git 384443b0 lists T645 | ✅ |
| BRAIN_EDGE_TYPES has 16 entries | `awk '/^export const BRAIN_EDGE_TYPES/,/\] as const/' brain-schema.ts | grep "'" | wc -l` → 16 | ✅ |
| BRAIN_NODE_TYPES has 12 entries | same awk pattern on BRAIN_NODE_TYPES → 12 | ✅ |
| NEXUS_NODE_KINDS has 33 entries | `awk '/^export const NEXUS_NODE_KINDS/,/\] as const/' nexus-schema.ts | grep "'" | wc -l` → 33 | ✅ |
| NEXUS_RELATION_TYPES has 21 entries | same awk pattern on NEXUS_RELATION_TYPES → 21 | ✅ |
| T649 added D-BRAIN-VIZ-14 (route rename /living-brain→/brain, /nexus→/code) | `cleo show T649 --json` description + acceptance criteria; git 384443b0 message lists T649 | ✅ |
| 2,894 cross-substrate edges verified post-T663 | `.cleo/agent-outputs/T684-browser-validation/REPORT.md`: "2312 nodes, 4988 edges, 2894 cross-substrate bridges visible" | ✅ |
| T663 stub-node loader done | `cleo show T663 --json` status=done, verification.passed=true, completedAt=2026-04-15T17:48:41 | ✅ |
| Phase 3b: code_reference=2,669 rows, documents=0, co_retrieved=0 | `.cleo/agent-outputs/T662-council-1-architecture.md` edge type table | ✅ |
| nexus_relations documents/applies_to = 0 rows | `.cleo/agent-outputs/T662-council-1-architecture.md`: "SELECT COUNT(*) → 0 rows each" | ✅ |
| T673 STDP 3 root-cause bugs | `docs/specs/stdp-wire-up-spec.md §1.4`; `.cleo/agent-outputs/T673-council-synthesis.md` | ✅ |
| T673 21 active tasks in 4 waves | `.cleo/agent-outputs/T673-council-synthesis.md` §4 task table: "Total active tasks: 21"; Wave 0 (7) + Wave 1 (3) + Wave 2 (6) + Wave 3 (3) + Wave 4 (2) = 21 | ✅ |
| T660 Phase 6 packages installed in studio package.json | `cat packages/studio/package.json | python3 -c ...` → 3d-force-graph ^1.80.0, three ^0.183.2, three-stdlib ^2.36.1, graphology ^0.26.0 present | ✅ |
| LivingBrain3D.svelte is UNTRACKED (not committed) | `git status packages/studio/src/lib/components/LivingBrain3D.svelte` → "Untracked files" | ✅ |
| /brain/3d route is UNTRACKED | `git status packages/studio/src/routes/brain/3d/` → "Untracked files" | ✅ |
| T666–T671 status=done in tasks.db | `for t in T666..T671; cleo show $t --json` → all status=done or checked via MANIFEST entries | ✅ |
| T672 A-Frame VR still pending | `cleo show T672 --json | python3 ... | "pending"` | ✅ |
| T674 Admin UI done in v2026.4.58 | `cleo show T674` status=done; git 384443b0 | ✅ |
| T675 Tasks search done in v2026.4.58 | `cleo show T675` status=done; git 384443b0 | ✅ |
| T676 Dep/blocker viz done in v2026.4.58 | `cleo show T676` status=done; git 384443b0 | ✅ |
| T686 SSR 500 fix done | `cleo show T686` status=done | ✅ |
| Current HEAD is dbe48a84 (T685 fix) + a38b08a3 (CI fix), latest release v2026.4.59 | `git log --oneline | head -3` | ✅ |
| v2026.4.60 does not yet exist | `git log --oneline | grep "v2026.4.6[0-9]"` → no output | ✅ |
