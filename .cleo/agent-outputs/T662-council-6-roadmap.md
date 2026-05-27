# Council Lead 6 — Long-Term Roadmap

> **Council**: T662 Full Audit — Brain Viz System
> **Lead**: 6 of 6 — Long-Term Roadmap Synthesis
> **Date**: 2026-04-15
> **Evidence base**: memory O-mo05p29k-0, O-mo07kcda-0, O-mo08hutr-0, O-mo09ac7m-0;
> `docs/plans/brain-synaptic-visualization-research.md` (v3); `docs/plans/stdp-feasibility.md`;
> full T627 task tree audit; sibling council reports (all in-flight — synthesized from primary sources)

---

## North Star

The owner's vision is a real-time 3D rendering of the CLEO project's entire knowledge substrate — every memory node, code symbol, task, message, and agent identity — rendered as glowing, pulsing synapses in a rotating three-dimensional cortex. It should feel alive: edges animate when memory is written, nodes brighten when retrieved, the graph plastically reshapes over time as the system learns. This is not a dashboard. It is a living, breathing externalization of the AI brain — the kind of artefact that makes the invisible visible and earns the description "this is the actual mind of CLEO." A 2D canvas is the foundation. The 3D hero is the destination. All six substrates (BRAIN, NEXUS, TASKS, CONDUIT, SIGNALDOCK, cross-project) should be present and filterable. Zero broken states at any phase.

---

## Current Reality (one-paragraph honest summary)

As of v2026.4.58 (2026-04-15), the system is substantially further along than the owner's confusion suggests — but the 3D vision is genuinely unstarted. The route structure has been consolidated: `/brain` is now the unified 5-substrate living canvas (formerly `/living-brain`), `/brain/overview` is the memory stats dashboard, and `/brain/graph` is the legacy typed-node browser. The canvas is real and working: it loads up to 5,000 nodes across five substrates, edges are visible (post T651 fix: 357→1,053 nodes, 114→3,917 edges), Cosmograph GPU mode is live for large graphs, SSE live-pulse is wired, the time slider is functional, and a project-selector header feeds context correctly to all pages. The Admin UI for the project registry is also shipped. What is NOT started: Phase 6 (3D hero view, `3d-force-graph` + `UnrealBloomPass`), Phase 3b (backfill of missing bridge edges between decisions/observations and nexus symbols), Phase 4 (cross-project meta-brain), Phase 5 (STDP-inspired plasticity upgrade), and Phase 7 (polish: query bar, snapshot export, filter panel). Two structural bugs remain open: CI regression T630 (nexus-e2e 71 failures) and migration reconciler T632 (Sub-case B marks migrations applied without running DDL). The 3D Synapse Brain epic T660 exists but has zero subtasks and no dependencies installed (`3d-force-graph` and `three` are absent from `packages/studio/package.json`).

---

## Phase Status Reconciled

| Phase | Name | True Status | Key Gap | Size |
|-------|------|-------------|---------|------|
| **0** | Schema audit + cross-link reality | DONE (T626) | — | small |
| **1a** | `/brain` canvas + 5-substrate API + filter toggles | DONE (T626, T649 rename) | — | large |
| **1b** | `/brain/overview` stats dashboard | DONE (T620, T649) | — | medium |
| **1c** | `/brain/graph` legacy typed-node view | DONE (T620) | — | medium |
| **1d** | `/brain/decisions`, `/brain/observations`, `/brain/quality` | DONE (T620) | — | small |
| **2a** | LBNode.createdAt + time slider | DONE (T635/T643) | — | medium |
| **2b** | SSE live synapses endpoint + Svelte client | DONE (T643) | — | medium |
| **2c** | Cosmograph GPU renderer for >2K nodes | DONE (T644, T652 fix) | GPU blank bug FIXED | medium |
| **3a** | `BRAIN_EDGE_TYPES` enum drift fix | DONE (T645) | — | small |
| **3b** | Backfill missing bridge edges | NOT STARTED — no task created | No task, no plan, no code | medium |
| **4** | Cross-project meta-brain | NOT STARTED — no task created | Schema `nexus_cross_project_edges` not designed | large |
| **5** | STDP-inspired plasticity | NOT STARTED — owner checkpoint required | 3 schema additions needed; owner has not approved | large |
| **6** | 3D hero view (3d-force-graph + ThreeJS) | NOT STARTED (T660 epic, no subtasks) | Packages not installed; no subtasks decomposed | large |
| **7** | Polish (filters, snapshot export, query bar, subgraph highlight) | NOT STARTED | Partially stub-exists (substrate/weight filters only) | medium |

**Summary**: Phases 0–3a are complete. Phase 3b through 7 are genuinely open. No tasks have been created for Phases 4 or 5. Phase 6 has an epic but no children and no dependencies.

---

## Phase 6 — 3D Synapse Brain Decomposition

**What Phase 6 actually requires before any code is written:**

- `3d-force-graph` npm package installed in `packages/studio` (vanilla, NOT `react-force-graph`)
- `three` npm package installed (`3d-force-graph` peer dependency)
- Optional: `postprocessing` or `three` `EffectComposer` + `UnrealBloomPass` for glow
- Graphology already installed — shared data model confirmed
- Decision from owner: `/brain/3d` route or `/living-brain/3d` or top-level `/3d`? (see Route section below)
- Decision from owner: is 3D the new default landing page for `/brain`, or a toggle/hero view?

**Atomic task decomposition (T660-n):**

- **T660-1** (small): Install `3d-force-graph` + `three` into `packages/studio`. Add TypeScript types (`@types/three`). Verify SvelteKit SSR-safe import with `{#if browser}` guard. Build green.
- **T660-2** (medium): Create `ThreeBrainGraph.svelte` component. Wire vanilla `3d-force-graph` with `LBGraph` data fed from same Graphology instance as `LivingBrainGraph.svelte`. Nodes as spheres, edges as lines. No bloom yet. Confirm 60 fps at 1,000 nodes. Route: `/brain/3d`.
- **T660-3** (small): Wire substrate filter chips from existing `/brain` page logic into the 3D component. Click node → open existing side panel (reuse `LBNode` panel component). Match feature parity with 2D canvas for substrate toggles.
- **T660-4** (small): Add `UnrealBloomPass` via `three/examples/jsm/postprocessing/`. Tune bloom threshold and radius for neon-synapse aesthetic. Gated behind `{#if bloomEnabled}` toggle. VR variant is deferred.
- **T660-5** (medium): Wire SSE live synapses into 3D view. On `node.create` event: flash-animate sphere. On `edge.strengthen` event: pulse line color. On `task.status` change: tint task node by status color. Reuse existing `/api/living-brain/stream` endpoint.
- **T660-6** (small): Navigation: add toggle button on `/brain` canvas to switch to 3D hero view. Add breadcrumb back. Both views share same server-loaded data; no duplicate API call.
- **T660-7** (small): Performance gate + kill criteria check. If 1K nodes renders below 30 fps on reference hardware, add a node-count cap and warn user. Document kill criteria outcome in release notes.

**Files to create:**
- `packages/studio/src/lib/components/ThreeBrainGraph.svelte`
- `packages/studio/src/routes/brain/3d/+page.svelte`
- `packages/studio/src/routes/brain/3d/+page.server.ts` (reuse living-brain server loader)
- `packages/studio/src/lib/components/__tests__/ThreeBrainGraph.test.ts`

**Files to modify:**
- `packages/studio/package.json` — add `3d-force-graph`, `three`
- `packages/studio/src/routes/brain/+page.svelte` — add 3D toggle button

---

## Decision Points for Owner

These are the questions that block the next two weeks of work. They require owner answers before agents can proceed.

**1. Is Phase 3b (backfill bridge edges) a priority right now?**
The canvas has 3,917 edges. Most decisions-to-tasks and observations-to-symbols bridges are still missing. Phase 3b would add thousands more edges and make the "living brain" more truthful. It is a prerequisite for Phase 4 (cross-project) making sense. But it requires running a backfill pass on live data — an irreversible mutation. Owner must confirm: proceed, or defer to after Phase 6?

**2. Is the 3D view the new default, a hero/demo mode, or a separate route?**
Three options:
- Option A: `/brain` stays 2D canvas; `/brain/3d` is an optional hero toggle (least disruption, safest)
- Option B: `/brain` becomes the 3D view by default; 2D is accessible via toggle (most "wow", higher implementation risk)
- Option C: `/3d` is a standalone page with no relation to `/brain` (cleanest separation but fragmenting the UX)
The plan (D-BRAIN-VIZ-07, §7 Phase 6) says "hero/demo only" but the owner's stated vision implies they want it as the primary experience. Owner must decide.

**3. What is the correct deployment path for new CLI commands?**
Per O-mo07kcda-0: `cleo nexus projects scan` and `clean` won't be invokable from the user's terminal until either `pnpm link --global` from `packages/cleo` is run or a new CLI is republished. This affects every CLI-backed feature shipped since the npm global install diverged. Owner must decide: maintain a symlinked dev build, or establish a release cadence that keeps the global install current?

**4. Should Phase 5 (STDP) be approved and scheduled?**
Eight decisions are awaiting owner approval at `docs/plans/stdp-feasibility.md §8`. STDP is entirely non-blocking for Phase 6 — it modifies `brain-lifecycle.ts`, not the viz layer. But if STDP is approved, it should be sequenced before Phase 7 so the weight-history visualization ships in the polish phase. Owner: read the 8 checkpoints in `stdp-feasibility.md §8` and signal go/no-go.

**5. What is the priority order: Phase 6 (3D viz) vs T628 (auto-dream) vs T629 (provider-agnostic memory) vs T630/T632 (bug fixes)?**
All four are open under T627. T630 (CI regression) and T632 (migration reconciler) are structural bugs that will cause ongoing pain. T628 and T629 are architectural improvements. Phase 6 is the visual north star. Owner must rank: bugs-first, or ship the 3D brain first?

---

## Three Brain Routes — Long-Term Recommendation

**`/brain` (the unified canvas, post-T649):**
Keep. This is now the primary living-brain experience — 5-substrate, SSE live, Cosmograph GPU, time slider. It is what was previously at `/living-brain`. The rename was correct. Do not merge or archive. Long term: this becomes the toggle-host for both 2D and 3D modes.

**`/brain/overview` (Memory stats dashboard):**
Keep. This is the analytical complement to the canvas — stat cards, memory tier distribution, quality scores. It serves a different mental model (metrics vs exploration). The landing card on the home page (T653) now surfaces it. It should eventually link bidirectionally with the canvas: "show this memory node in canvas" button on each stat item.

**`/brain/graph` (Legacy typed-node browser, BrainGraph.svelte, Sigma.js):**
Archive or merge after Phase 6 ships. It uses Sigma.js (not Cosmograph/3d-force-graph), serves only `brain.db` nodes (not the 5-substrate view), and was the pre-T626 implementation. Once Phase 6's 3D route covers the same cognitive need with better aesthetics and richer data, `/brain/graph` becomes redundant. Recommendation: keep it alive until 3D is browser-verified stable, then redirect `/brain/graph` → `/brain/3d` and remove the Sigma.js dependency.

**`/code` (was /nexus, code intelligence view):**
Out of scope for Brain viz epic but relevant to the full picture. This route uses Sigma.js for the NEXUS community graph. It is independent of the brain canvas and should not be touched by Phase 6 work.

---

## Sequencing — Next 5 Epics in Order

**1. T627 stabilization — close the remaining open bugs (T630, T632)**
Before any new epic starts, the two structural bugs must be fixed. T630 (71 CI failures in nexus-e2e) makes every release uncertain. T632 (migration reconciler Sub-case B) is a silent data-corruption footgun that has already produced three separate CI incidents. Both are medium-sized. Fix first, then new features.

**2. Phase 3b — Backfill bridge edges (new epic, no task yet)**
Requires owner go-ahead (Decision Point 1 above). A single medium-sized task: extract `decisions.context_task_id` → `brain_page_edges` rows, `observations.files_modified_json[*]` → nexus file nodes, `tasks.files_json[*]` → nexus file nodes. This increases the living-brain edge fidelity 2-5x and makes the canvas substantially more informative before the 3D view arrives.

**3. T660 Phase 6 — 3D Synapse Brain (7 subtasks, large)**
The north star deliverable. Should start only after stabilization bugs are resolved. Seven atomic tasks as decomposed above. Estimated sequence: T660-1 through T660-3 (basic 3D structure with filters), then T660-4 (bloom), then T660-5 (SSE wiring), then T660-6 (navigation), then T660-7 (performance gate).

**4. Phase 5 — STDP-inspired plasticity (new epic, owner checkpoint required)**
Requires owner approval of 8 decisions. Non-blocking for Phase 6 but should precede Phase 7 so weight-history visualization ships in the polish pass. Estimated large-sized epic: 10 implementation tasks per `stdp-feasibility.md §10`.

**5. Phase 7 — Polish (new epic, medium)**
Time-box deliberately. Filter panel (time range, plasticity class, agent), snapshot export (PNG/GEXF/JSON), query bar ("show me everything agent X touched"), subgraph highlight on `cleo memory find` results. Some of this (substrate/weight filters) already partially exists. Phase 7 closes the loop on the full target architecture described in `brain-synaptic-visualization-research.md §6.0`.

---

## 90-Day Outlook

In 90 days, if the decisions above are answered and sequencing is followed, the system should reach: zero structural bugs in the brain-viz stack, a truthful living canvas with 5× more edges than today (post Phase 3b backfill), a functional 3D Synapse Brain hero view at `/brain/3d` with bloom glow and SSE-live-pulse animations, STDP-inspired plasticity running at session-end consolidation with reward-modulated edge weights, and a complete Polish layer with query bar and snapshot export. Phase 4 (cross-project meta-brain) is realistically a post-90-day effort — it requires a `nexus_cross_project_edges` table design, privacy model decisions, and a separate RCASD epic. The owner should also expect to resolve the CLI deployment chain (T629 provider-agnostic memory and the npm global install divergence) because the brain-viz features depend on CLI correctness for live SSE event sources. The most likely bottleneck is not engineering capacity but owner decision velocity: five of the seven open questions above are binary choices that only the owner can make, and two of them (3D-as-default and STDP go/no-go) directly gate the next two epics.

---

## Appendix: Evidence Provenance

| Claim | Source |
|-------|--------|
| `/brain` = unified canvas post-T649 rename | T649 task status=done; `ls routes/` confirms no `/living-brain` directory |
| 3,917 edges after T651 fix | O-mo05p29k-0 narrative; T651 MANIFEST entry (before:114, after:3575) |
| `3d-force-graph` + `three` NOT installed | `packages/studio/package.json` deps audit — absent |
| Cosmograph IS installed | `@cosmograph/cosmos ^2.0.0-beta.26` in package.json |
| T660 has zero subtasks | `cleo list --parent T660` returns 0 filtered results |
| T630 still pending | Task status check: `pending`, priority `critical` |
| T632 still pending | Task status check: `pending`, priority `critical` |
| Phase 3b has no task | `cleo find "Phase 3b"` returns no matching task; plan §7 says "TBD task" |
| Phase 4 has no task | `cleo find "cross-project meta-brain"` returns only plan references, not tasks |
| Phase 5 has no task | T554 (LLM-Managed Living Brain v3) is adjacent but not Phase 5 STDP |
| SSE endpoint exists and works | T643 status=done; `/api/living-brain/stream` present in `ls routes/api/living-brain/` |
| Admin UI shipped | O-mo08hutr-0; T657 status=done |
| v2026.4.58 is current | `cleo version` + `git log --oneline` confirms |
