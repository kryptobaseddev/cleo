# Distilled Signal from 7 Retired Repo Docs (saga T11778)

**Date:** 2026-06-04 · Captured into the cleo-docs SSoT before retiring the source files (owner-ratified distill-now). Each section preserves the UNIQUE signal the source held; the source repo doc is deleted after this capture.

---

## 1. Living BRAIN Visualization — 14 locked decisions (from plans/brain-synaptic-visualization-research.md)

These are RATIFIED decisions; several already shipped (T644/T645/T649). Preserve verbatim.

| ID | Decision | Rationale |
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

**Status anchors:** Cosmograph GPU done (T644, v2026.4.58); route consolidation done (T649); edge enums done (T645, brain-schema.ts:550-573). Phase 5 STDP-inspired plasticity IN PROGRESS (T673 epic, 21 subtasks; 3 root-cause bugs: 5min-vs-30day lookback, entry_ids comma-vs-JSON, missing session_id col). 3D hero (`3d-force-graph` /brain/3d) implemented T667-671, commit+release pending. Stack: Cosmograph (1M-node GPU 2D) + 3d-force-graph (3D hero, vanilla not React) + Graphology (browser SSoT) + SSE live feed. STDP details: docs/specs/stdp-wire-up-spec.md (KEEP-REPO).

## 2. Circle of Eleven + The Hearth lore (from design/CLEO-PI-HARNESS-ARCHITECTURE.md)

The naming/lore worth preserving: the dev environment is a **workshop**; **The Hearth** = the terminal-facing workshop surface. Roles (Circle of Eleven): **The Smiths** forge Threads (tasks) · **The Weavers** weave Looms (pipelines) · **The Conductors** conduct Motion (orchestration) · **The Scribes** record · **The Artificers** (tools). Pi harness = the primary conduit, speaking NATIVELY (not via MCP). Maps onto interface/daemon/skills. Relates: [[projects/cleo/concepts/interface]], [[projects/cleo/concepts/sentient-harness-mandate]].

## 3. Autonomous-runtime primitives — PLANNED, none built (from specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md)

Unbuilt autonomy substrate mapping to the sentient-harness vision: **The Hearth** (T5520, operator viewport surface; hooks onAgentSpawn/onAgentComplete) · **The Impulse Engine** (T5574, self-propelling work pickup + execution triggering) · **Watchers** (T5523/T5575, long-running Cascade patrols for health/continuity/retry-pressure via onPatrol). Constraint: Watchers MUST be Cascades through existing pipeline/orchestrate/check/admin, NOT a separate daemon domain. Belongs in the psyche/north-star event-driven-runtime narrative (the gap flagged in sentient-harness-mandate §5.5).

## 4. CleoOS sentient-harness analysis — corrected thesis (from analysis/cleoos-sentient-harness-analysis-corrected.md)

Canonical of the analysis pair: Cleo CORE is real (~628K LOC) vs CleoOS harness mostly stubs vs Hermes Agent (~292K LOC reference). CANT is a REAL DSL (not templates). Layering: contracts → core → cleo → cleo-os. packages/cleo-os/ needs a Cleo-NATIVE agent harness to replace the Pi/Claude-Code binaries. Theatre items flagged: Tier-3 auto-merge, some provider adapters. Hermes capability-porting opportunities exist. (Superseded uncorrected sibling deleted.)

## 5. Memory architecture specifics (from architecture/memory-architecture.md)

Delta over the vault memory-brain concept: brain.db-as-SSoT persistence model, memory-bridge generation, provider-neutral design, session-bootstrap pattern. Fold the persistence + provider-integration specifics into [[projects/cleo/concepts/memory-brain]] on its next revision.

## 6. North-star repo mirror (from plan/cleo-canonical-north-star.md)

Was a repo mirror of the canonical north-star (already in cleo docs as `cleo-canonical-north-star` + vault `north-star`). Deleted to remove the third split-brain copy; readers use `cleo docs fetch cleo-canonical-north-star` (operational) or the vault north-star (vision).
