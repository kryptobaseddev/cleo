# Specialist B — Studio / UI / UX / Frontend Audit

**Date:** 2026-04-28
**Auditor:** Specialist B
**Scope:** packages/studio + Studio UI/UX redesign + BRAIN visualization + design system + page-level surfaces
**Anchor task:** T990 (EPIC, critical, pending, size large, 0 children, position 137)

---

## 1. Domain Summary

T990 is the only Studio-domain epic in `pending` state, but it is **NOT** the only Studio work outstanding — it is the umbrella for ~35 sub-items already enumerated in `.cleo/agent-outputs/T990-decomposition/WAVE-PLAN.md` that **were never created as child tasks in CLEO**. Substantial T990 work has *already shipped to disk* via 8 design-research audits and Wave 0 + Waves 1A-1E REPORTs (see `.cleo/agent-outputs/T990-design-research/` and `.cleo/agent-outputs/T990-design-work/`). The Studio package is at v2026.4.154, has 22 page routes, 19 UI primitives in `$lib/ui/`, a full token system in `tokens.css` (191 lines), three renderer modules (`SvgRenderer`, `CosmosRenderer`, `ThreeBrainRenderer`), and the legacy `/brain/3d` and `/brain/graph` pages have been demoted to redirect tombstones / view-mode aliases. **Despite all this delivery, T990 has zero CLEO children, has not advanced past `pipelineStage: contribution`, and `readyToComplete: false` with all gates unverified.** Hidden Studio dependencies exist in: T1488/T1510 (nexus dispatch ops needed for `/api/nexus/+server.ts`), T945 (Universal Semantic Graph promotion that the Brain canvas would render), and T1056 Living Brain Completion (substrates feed `/api/brain/chunks` stream).

---

## 2. T990 Acceptance Audit (13 criteria)

| # | Criterion (paraphrased) | Status | Evidence | Blocker |
|---|---|---|---|---|
| 1 | Invoke `frontend-design:frontend-design` skill + engage full design team | **DONE** | 8 audits in `T990-design-research/`, decomposition in `T990-decomposition/WAVE-PLAN.md`, Wave 0/1A-1E REPORTs | None |
| 2 | Audit every page (/, /tasks, /tasks/pipeline, /brain, /brain/3d, /memory/observations, /memory/decisions, /memory/graph, /memory/quality, /code, /admin, /sessions) | **PARTIAL** | 7/8 page audits exist; routes for `/memory/*`, `/admin`, `/sessions` (top-level) do **NOT exist** as Svelte routes — they live as sub-routes under `/brain/` and `/projects/` | Route taxonomy mismatch — operator's mental model says `/memory/*` and `/admin` should exist; codebase has `/brain/observations`, `/brain/decisions`, `/projects/{audit,backup,clean,doctor,gc,migrate,reindex-all,scan}` |
| 3 | Document every existing component + feature + API call across all pages — nothing lost | **PARTIAL** | `api-wiring-audit.md` exists; 31 API endpoints mapped under `/routes/api/{brain,health,memory,nexus,project,search,tasks}` | No component-level inventory file shipped; no feature-loss matrix |
| 4 | Dashboard CLEAN — no Kanban/Graph crammed at bottom | **DONE** | `/tasks/+page.svelte` is now a two-column command surface w/ Explorer hero + right rail (per its own header comment); `/+page.svelte` is "Mission Control" 4-portal grid | None — but operator review still pending |
| 5 | BRAIN: single neural view consolidating sigma 2D + cosmos.gl GPU + 3d-force-graph | **DONE (architecturally)** | `/brain/3d/+page.svelte` is a tombstone redirecting to `/brain?view=3d`; `/brain/+page.svelte` uses `ThreeBrainRenderer` + `LivingBrainCosmograph` 2D fallback; sigma replaced by `SvgRenderer`; `/brain/graph/+page.svelte` survives as **retrospective time-travel view** using deprecated `BrainGraph.svelte` shim | `BrainGraph.svelte` still marked `@deprecated since T990; slated for removal` — incomplete cleanup; `/brain/graph` should arguably also fold into the unified canvas |
| 6 | No graph shows ALL node titles face-up — hover reveals; clusters get group titles | **DONE (graph engine)** | `$lib/graph/no-face-up.ts` exists (named contract!); `cluster-label-layer.svelte` exists; `hover-label.svelte` exists | Each consumer page must opt in — needs spot-check audit of `BrainGraph`, `NexusGraph`, `TaskDepGraph`, code page graphs |
| 7 | Code page connections audit + fix vs GitNexus reference | **NOT STARTED** | `code-page-audit.md` exists in research; `/code/+page.svelte` and `/code/symbol/[name]/+page.svelte` and `/code/community/[id]/+page.svelte` still ship; **no commit evidence of GitNexus reference being applied** | Operator must share the GitNexus reference code (epic description says "operator has source"); blocked on owner input |
| 8 | Task graph: parents + children + dependencies + blockers — visually distinct edge kinds | **PARTIAL** | `$lib/graph/edge-kinds.ts` exists; `TaskDepGraph.svelte` exists | Cannot verify edge-style differentiation without rendering; no test asserts visual distinctness; operator review required |
| 9 | All API endpoints correctly wired post-T962 | **LIKELY DONE** | `api-wiring-audit.md` reports "API wiring is clean post-T962 (no broken fetches to fix at URL level)" per the wave plan; 31 server endpoints under `routes/api/`; T962 itself is `archived` | No automated end-to-end fetch-coverage test — relies on a static audit doc; `/api/project/*` admin endpoints still exist alongside `/api/nexus` (nexus dispatch ops T1510 still pending) |
| 10 | Design system: tokens, typography, spacing, component library | **DONE (foundational)** | `lib/styles/tokens.css` 191 lines with 80+ `var(--…)` tokens (surface/border/text/accent/semantic/status/priority/spacing/typography/motion/elevation); `@fontsource-variable/inter` + `jetbrains-mono` in deps; 19 primitives in `$lib/ui/` (Badge, Breadcrumb, Button, Card, ChipGroup, Chip, Drawer, EmptyState, IconButton, Input, Modal, Select, Spinner, TabPanel, Tabs, Textarea, Tooltip) | No `prefers-reduced-motion` audit; component library is **not documented** (no Storybook / no MDX docs) |
| 11 | Accessibility: WCAG AA, keyboard nav, aria-labels | **PARTIAL** | `@axe-core/playwright` is in devDependencies; skip-link in `+layout.svelte`; `aria-current` on nav | No axe test runs visible in `pnpm test`; no per-page A11y attestation; operator never reviewed |
| 12 | Performance: <2s initial render, 60fps graph, no thrash | **UNCLEAR** | Wave plan mentions `agent-c-perf/REPORT.md` — exists at `T990-design-work/brain-emergency/agent-c-perf/REPORT.md`; no Lighthouse CI; no perf budget in build | Need to read perf REPORT for measured numbers; no performance regression test |
| 13 | Live in `http://localhost:3456/` w/ operator reviewing each page | **NOT STARTED** | `package.json` confirms `vite dev --port 3456`; no review log in handoffs | Operator review never happened — every wave landed without "owner sign-off" gate |

**Net:** Of 13 criteria, ~5 are functionally **done**, 4 **partial** (inventory/a11y/performance/edge-kinds visualization), 2 **not started** (Code page GitNexus alignment, owner page-by-page review), 2 **architecturally done but require operator validation** (consolidated brain view, dashboard layout). The bigger problem is that **the work was done outside the CLEO task graph**, so none of it can be `cleo verify`'d or attributed.

---

## 3. Outstanding Studio-Adjacent Tasks (not T990)

| Task | Status | Priority | Why it touches Studio |
|------|--------|----------|------------------------|
| T1510 | pending | low | Phase 2 nexus dispatch ops (clusters/flows/context/projects/refresh-bridge/diff/query-cte/hot-paths/hot-nodes/cold-symbols) — Studio's `/api/nexus/+server.ts` and `/code/+page.svelte` consume these; descoped from T1488 |
| T1488 | (parent T1508) | — | Original nexus dispatch ops parent — Studio consumes via `/api/nexus` |
| T945 | pending | high | Universal Semantic Graph — promote `brain_page_nodes` to sentience; Studio Brain canvas would render the promoted graph |
| T1056 | pending | critical | Nexus P2 Living Brain Completion epic — substrate completion feeds `/api/brain/chunks` stream consumed by `BrainGraph` and `ThreeBrainRenderer` |
| T1071 | pending | high | EP3-T6 Conduit→Symbol Ingestion — feeds `/api/nexus` symbol surface used by Code page |
| T1139 | pending | high | BRAIN auto-reconcile — affects `/brain/decisions` page (supersession state) |
| T1465 | pending | high | Dynamic provider/model architecture — affects `/projects` admin UI (model selectors hardcoded) |
| T1495 | pending | low | T-FU14 pipeline domain contract types — `/tasks/pipeline` Studio page consumes pipeline types |
| T1532 | pending | medium | Iterate on dialectic evaluator — feeds `/brain/causal/+page.svelte` |

No other epic except T990 is Studio-primary. Studio is a *consumer* of every other domain's API surface.

---

## 4. Priority-Ranked Task List (Studio domain only)

### P0 — Owner-blocking, ship before anything else
1. **Decompose T990 into the 35 child tasks already specified in `WAVE-PLAN.md`.** Right now the epic has `childRollup.total: 0` despite ~5 waves of work having shipped — orphaned delivery, no audit trail, no `cleo verify` possible.
2. **Operator page-by-page review on `localhost:3456`** (acceptance #13). Without this, T990 cannot ship — every previous wave landed unreviewed which is exactly what got T949 rejected.
3. **Reconcile route taxonomy with operator mental model.** Acceptance #2 lists `/memory/*`, `/admin`, `/sessions` as top-level routes but the codebase puts them under `/brain/*` and `/projects/*`. Either rename or formally retract those acceptance items.

### P1 — Critical Studio gaps
4. **Code page GitNexus reference alignment** (acceptance #7) — operator must share the reference code; nothing has happened on this since the epic was filed 2026-04-19.
5. **Per-page accessibility attestation** (acceptance #11). `@axe-core/playwright` is installed but never runs in CI. Add `pnpm --filter @cleocode/studio test:e2e:a11y` per route.
6. **Performance baselines** (acceptance #12) — Lighthouse CI on the four hero routes (`/`, `/tasks`, `/brain`, `/code`). Wave plan referenced perf work but no baseline is committed.
7. **Consume T1510 nexus dispatch ops** when shipped — wires Studio's `/api/nexus` to Phase 2 ops; Studio currently relies on Phase 1 surface only.

### P2 — Cleanup / polish
8. Remove `BrainGraph.svelte` (currently `@deprecated since T990; slated for removal`) once `/brain/graph` migrates to the unified canvas.
9. Document the 19 `$lib/ui/` primitives — Storybook or MDX so the design system is **discoverable** (acceptance #10 says "documented").
10. Add a feature-loss matrix per page audit so component-level inventory exists (acceptance #3).

### P3 — Nice to have
11. Promote `/projects` admin shell to a proper `/admin` route (operator's stated taxonomy).
12. Add `/sessions` top-level route (currently only `/tasks/sessions` exists as a sub-page).
13. Clarify whether `/brain/quality`, `/brain/tier-stats`, `/brain/causal`, `/brain/learnings`, `/brain/observations`, `/brain/decisions`, `/brain/patterns`, `/brain/search`, `/brain/overview` are all "Memory dashboards" (current navigation) or should split into `/memory/*` per acceptance #2.

---

## 5. Deep Findings

### Finding A — T990 has been **shadow-executed** outside the CLEO task graph
Acceptance is partially satisfied by ~5 waves of work (Wave 0 foundation, 1A brain, 1B code, 1C tasks, 1D memory, 1E ops) with full REPORT.md files at `.cleo/agent-outputs/T990-design-work/wave-{0,1a,1b,1c,1d,1e}*/REPORT.md`, but `cleo show T990` reports `childRollup.total: 0`, `gatesStatus.implemented: false`, `readyToComplete: false`. Per ADR-051 evidence ritual, **none of this work is verifiable.** The wave plan at `T990-decomposition/WAVE-PLAN.md` defines T990-WA-001 through T990-WE-* as 35 tasks but they were never created. The fact that page header comments cite `@task T990 / @wave 1A` proves the agents knew the structure; the orchestrator failed to materialize it.

### Finding B — Three brain views were consolidated, but `/brain/graph` survives as a deprecated shim
The 2D sigma + GPU cosmos + 3D force-graph triad is architecturally unified per acceptance #5: `/brain/3d/+page.svelte` is a 14-line tombstone that redirects to `/brain?view=3d` (verified at `/mnt/projects/cleocode/packages/studio/src/routes/brain/3d/+page.svelte`). However `/brain/graph/+page.svelte` (Wave 1D) still consumes `BrainGraph.svelte`, which is itself marked `@deprecated since T990; slated for removal` (line 18 of `BrainGraph.svelte`). `BrainGraph` is described as "THIN SHIM (T990 integration cleanup)" delegating to `ThreeBrainRenderer`. The retrospective/time-travel use case (`useTimeSlider`, `filterDate`) means there's a **real product decision pending**: does retrospective view fold into the main canvas via a `?t=<date>` URL param, or stay as a separate route? Right now we have both a deprecation note AND continued use, which is technical-debt by definition.

### Finding C — Route taxonomy mismatch with operator mental model
T990 acceptance #2 explicitly lists `/memory/observations`, `/memory/decisions`, `/memory/graph`, `/memory/quality`, `/admin`, `/sessions` as required routes. The actual codebase has:
- `/brain/observations`, `/brain/decisions`, `/brain/graph`, `/brain/quality` (NOT `/memory/*`)
- `/projects/[id]` + `/api/project/{audit,backup,clean,doctor,gc,migrate,reindex-all,scan,switch}` (NOT `/admin`)
- `/tasks/sessions` (NOT top-level `/sessions`)

The layout nav in `+layout.svelte` calls `/projects` "Admin" in the navItems array (`{ href: '/projects', label: 'Admin', … }`) — proving the renamer was attempted at the label level but never at the route level. Either acceptance #2 needs to be updated to reflect the brain-folder taxonomy, or the routes need to be relocated. **This is an unresolved design contradiction inside an in-flight epic.**

### Finding D — Design system foundation is DONE but undocumented
`tokens.css` (191 lines, 80+ tokens, all five token categories from the wave plan) plus 19 `$lib/ui/` primitives represent a **mature design system foundation**. Yet there is no `README.md` in `$lib/ui/`, no Storybook, no MDX, no `forge-ts` doc generation visible. Acceptance #10 says "component library documented" — this is the only word in #10 that is unmet. Operator-blocking on a small writeup, not on more code.

### Finding E — Wave plan was authored for 35 tasks, then frozen
`.cleo/agent-outputs/T990-decomposition/WAVE-PLAN.md` (authored 2026-04-20) contains operator-quoted root-cause analysis ("This UI/UX looks like SHIT!! …") and 35 atomic tasks IDs (`T990-WA-001` through `T990-WE-*`). It even states "Total Tasks: 35" and "Epic Lifecycle Stage: research → implementation (this plan advances it)". The plan was **never executed via `cleo orchestrate start T990`** — the epic remains `pipelineStage: contribution` and child count is zero. The actual execution went directly to subagent waves bypassing the task graph entirely.

---

## 6. Recommendations to Operator (top 5)

1. **YES, decompose T990 immediately.** Run `cleo orchestrate start T990` then bulk-create the 35 children from `T990-decomposition/WAVE-PLAN.md` (script it — it's a structured doc). Without children, `childRollup.total: 0` blocks `cleo verify` on the epic forever. **This is the biggest unblock in the audit.**
2. **Mark T990-WA-* and T990-WB-* children as `done` retroactively, with `--evidence "files:<file list>"` from the existing REPORT.md files.** Wave 0 / 1A-1E shipped to disk but are unattributed. Either retro-mark them done or accept that T990's gate verification will reject every existing file as `untracked work`.
3. **Schedule a formal operator walkthrough on `localhost:3456` covering `/`, `/tasks`, `/tasks/pipeline`, `/brain`, `/brain/graph`, `/brain/overview`, `/code`, `/projects`.** Acceptance #13 cannot be met any other way. Estimate 30-45 min walkthrough; produce a `/T990-OWNER-REVIEW-2026-04-XX.md` log per page with verdict (ship / iterate).
4. **Resolve the `/memory/*` vs `/brain/*` route taxonomy.** Either: (a) rename `/brain/{observations,decisions,graph,quality,…}` → `/memory/{…}` and add 301 redirects, OR (b) edit T990 acceptance #2 to align with the existing `/brain/*` taxonomy. Right now a future agent reading acceptance will assume the routes exist where they don't.
5. **Hand-off the GitNexus reference implementation for the Code page.** T990 epic description says "operator has source" — until that arrives, acceptance #7 cannot start. Either share it, or descope #7 to a follow-up task.

**Bonus (auditor's opinion):** T990 should NOT be re-marked critical/pause-current-merge until the 35-task decomposition is materialized. Right now the "critical" priority is misleading because there are zero scheduled children. Either scope it down to "Operator Review + Decomposition Hardening" (small) and file the implementation as a sibling epic T990-IMPL, or keep it large and create the children today. The current state — large epic, 0 children, work shipping outside the graph — is the worst of both worlds.

---

## Evidence References

- Epic: `cleo show T990` (status pending, position 137, 13 acceptance items, 13 labels, size large, childRollup.total 0)
- Decomposition: `/mnt/projects/cleocode/.cleo/agent-outputs/T990-decomposition/WAVE-PLAN.md`
- Research audits (8): `/mnt/projects/cleocode/.cleo/agent-outputs/T990-design-research/{api-wiring,brain-page,code-page,dashboard-admin,design-system,graph-engine-recommendation,memory-page,tasks-page}-audit.md`
- Wave reports: `/mnt/projects/cleocode/.cleo/agent-outputs/T990-design-work/{wave-0-foundation,wave-1a-brain,wave-1b-code,wave-1c-tasks,wave-1d-memory,wave-1e-ops,brain-rebuild,brain-emergency/{agent-b-3d,agent-c-perf,agent-d-connectivity,agent-e-shell},integration-cleanup}/REPORT.md`
- Tokens: `/mnt/projects/cleocode/packages/studio/src/lib/styles/tokens.css` (191 lines)
- UI primitives: `/mnt/projects/cleocode/packages/studio/src/lib/ui/` (19 components)
- Brain canvas (consolidated): `/mnt/projects/cleocode/packages/studio/src/routes/brain/+page.svelte` (header @task T990 @wave 1A)
- Tombstone: `/mnt/projects/cleocode/packages/studio/src/routes/brain/3d/+page.svelte`
- Deprecated shim: `/mnt/projects/cleocode/packages/studio/src/lib/components/BrainGraph.svelte` line 18
- Layout w/ Admin label routing to `/projects`: `/mnt/projects/cleocode/packages/studio/src/routes/+layout.svelte`
- Tasks command surface: `/mnt/projects/cleocode/packages/studio/src/routes/tasks/+page.svelte` (header documents T956/T949/T990 lineage)
- Studio version: `/mnt/projects/cleocode/packages/studio/package.json` (`@cleocode/studio` v2026.4.154)
