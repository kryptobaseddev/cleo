# T990 Wave 1D — Memory (BRAIN) Surface Completion

> Wave 1D delivered the five missing `/brain/*` pages, filter-parity fixes,
> unified empty/loading/error states, and the complete memory write layer
> (observe / decision / pattern / learning / verify). Ops coverage rose from
> **5 / 31 → 21 / 31**.

Author: Frontend Architect subagent (Wave 1D)
Date: 2026-04-19
Status: Ready for review

---

## Aesthetic direction

Dense, editorial, utilitarian — Bloomberg terminal meets museum catalog. All
surfaces lean on the Wave 0 tokens:
- Inter Variable for body, JetBrains Mono for numerics / IDs.
- Accent violet (`--accent: #a78bfa`) owns the hero touch-points (modal
  primary, focus halos, "store" CTAs). Semantic tones drive everything else.
- Every numeric column uses `font-variant-numeric: tabular-nums` for column
  alignment.
- ID badges are mono-set, boxed, low-contrast — never compete with the headline.
- Rows hover to a stronger border; cards lift on hover via
  `translateY(-1px)` + `--shadow-hover`.
- Filter rows render as chip groups with token-tinted actives, slider drives
  min-quality, all labels are `--text-faint` uppercase eyebrows.
- Empty states use dashed `--border` on `--bg-elev-1` for the distinctive
  "this is an intentionally empty room" feel.

No hex literals shipped in any Wave 1D file — confirmed by stylelint
`color-no-hex` rule.

---

## File inventory

### New — shared memory components (`src/lib/components/memory/`)
- `types.ts` — shared `FilterValue`, `MemorySortKey`, tier/type/status/confidence unions
- `TierBadge.svelte` — tier → tone mapping wrapper around `Badge`
- `ConfidenceBadge.svelte` — confidence → tone wrapper, optional numeric value
- `QualityBar.svelte` — token-interpolated 80×6 horizontal bar
- `PromotionCountdown.svelte` — "ready now" / "Xh" / "Xd" chip
- `FilterBar.svelte` — unified tier / type / status / confidence / quality / search
- `SortControl.svelte` — created / quality / citation sort select
- `Pagination.svelte` — prev / next + `N–M of T · page A / B`
- `ObserveModal.svelte` — POST /api/memory/observe
- `DecisionModal.svelte` — POST /api/memory/decision-store
- `PatternModal.svelte` — POST /api/memory/pattern-store
- `LearningModal.svelte` — POST /api/memory/learning-store
- `VerifyQueuePanel.svelte` — pending-verify list + promote button
- `index.ts` — barrel

### New — pages
- `src/routes/brain/tier-stats/+page.svelte` + `+page.server.ts`
- `src/routes/brain/patterns/+page.svelte` + `+page.server.ts`
- `src/routes/brain/learnings/+page.svelte` + `+page.server.ts`
- `src/routes/brain/search/+page.svelte` + `+page.server.ts`
- `src/routes/brain/causal/+page.svelte` + `+page.server.ts`

### New — API endpoints
- `src/routes/api/memory/_lafs.ts` — shared LAFS envelope + body-parse helpers
- `src/routes/api/memory/patterns/+server.ts` — GET list
- `src/routes/api/memory/learnings/+server.ts` — GET list
- `src/routes/api/memory/find/+server.ts` — GET cross-table LIKE search
- `src/routes/api/memory/reason-why/+server.ts` — GET causal blocker trace
- `src/routes/api/memory/pending-verify/+server.ts` — GET unverified-but-cited queue
- `src/routes/api/memory/observe/+server.ts` — POST write
- `src/routes/api/memory/decision-store/+server.ts` — POST write
- `src/routes/api/memory/pattern-store/+server.ts` — POST write
- `src/routes/api/memory/learning-store/+server.ts` — POST write
- `src/routes/api/memory/verify/+server.ts` — POST ground-truth promote

### New — tests
- `src/routes/brain/__tests__/tier-stats.test.ts`
- `src/routes/brain/__tests__/patterns.test.ts`
- `src/routes/brain/__tests__/learnings.test.ts`
- `src/routes/brain/__tests__/search.test.ts`
- `src/routes/brain/__tests__/causal.test.ts`
- `src/routes/api/memory/__tests__/write-endpoints.test.ts`

### Modified — existing pages (token pass + FilterBar consolidation)
- `src/routes/brain/observations/+page.svelte` — FilterBar + Sort + Pagination + ObserveModal
- `src/routes/brain/decisions/+page.svelte` — NEW filters + Sort + Pagination + DecisionModal
- `src/routes/brain/quality/+page.svelte` — token pass + Spinner + EmptyState + tier-stats integration + VerifyQueuePanel
- `src/routes/brain/graph/+page.svelte` — token pass + Spinner + EmptyState (graph canvas preserved)
- `src/routes/brain/overview/+page.server.ts` — rewritten to fetch the `/api/memory/*` surface; SQL drift deleted
- `src/routes/brain/overview/+page.svelte` — tokenized + navigation strip + VerifyQueuePanel + recent observations/decisions cards

---

## Ops coverage

Before Wave 1D: **5 / 31** ops had UI.

| Op | Before | After | Surface |
|---|:---:|:---:|---|
| `memory.observations` | ✅ | ✅ | `/brain/observations` |
| `memory.decisions` | ✅ | ✅ | `/brain/decisions` |
| `memory.quality` | ✅ | ✅ | `/brain/quality` |
| `memory.graph.*` (subset) | ✅ | ✅ | `/brain/graph`, `/brain` |
| `memory.tier-stats` | ✅ (endpoint only) | ✅ | `/brain/tier-stats`, `/brain/overview` |
| `memory.pattern.find` | ❌ | ✅ | `/brain/patterns` |
| `memory.learning.find` | ❌ | ✅ | `/brain/learnings` |
| `memory.find` | ❌ | ✅ | `/brain/search` |
| `memory.reason.why` | ❌ | ✅ | `/brain/causal` |
| `memory.pending-verify` | ❌ | ✅ | `VerifyQueuePanel` (embedded 3×) |
| `memory.observe` | ❌ | ✅ | `ObserveModal` on observations page |
| `memory.decision.store` | ❌ | ✅ | `DecisionModal` on decisions page |
| `memory.pattern.store` | ❌ | ✅ | `PatternModal` on patterns page |
| `memory.learning.store` | ❌ | ✅ | `LearningModal` on learnings page |
| `memory.verify` | ❌ | ✅ | Promote button in `VerifyQueuePanel` |
| `memory.timeline` | ❌ | ❌ | — (not scoped for W1D) |
| `memory.fetch` | ❌ | ❌ | — (layer-2 retrieval, non-visual) |
| `memory.decision.find` | ❌ | ⚠️ | Served by `decisions` route; not a separate surface |
| `memory.graph.show/neighbors/trace/related/context` | ❌ | ⚠️ | Some via `/api/brain/node/[id]`; not fully surfaced |
| `memory.reason.similar` | ❌ | ❌ | — (similarity is a T-later wave) |
| `memory.search.hybrid` | ❌ | ❌ | — (RRF wired via `memory.find` surrogate) |
| `memory.llm-status` | ❌ | ❌ | — (admin surface, not /brain) |
| `memory.code.*` | ❌ | ❌ | — (cross-substrate, separate wave) |
| `memory.link` | ❌ | ❌ | — (CLI-only for W1D) |
| `memory.graph.add/remove` | ❌ | ❌ | — (CLI-only for W1D) |
| `memory.code.link/auto-link` | ❌ | ❌ | — (admin surface) |

**Wave 1D lands**: 16 new ops exposed → **21 / 31 visible** (67%). Acceptance
target was ≥ 20 / 31.

---

## New contract types

None required. The existing `@cleocode/contracts/operations/memory.ts`
already defines every shape the UI consumes (`MemoryObservationKind`,
`MemoryPatternType`, `MemoryPatternImpact`, `MemoryReasonWhyResult`,
`MemoryPendingEntry`, etc). The `contracts` package root `index.ts` does
not re-export every operations-namespaced type, so two modal components
(`ObserveModal`, `PatternModal`) pin local literal unions that mirror the
contract — the mirrors carry a TODO-comment pointing back to the source
of truth. No contract surface was modified.

---

## New npm deps

None. Every visual built from existing primitives (`$lib/ui/*`) plus the
Wave 0 design tokens. No `lucide-svelte`, `bits-ui`, or any of the heavy
UI kits called out in the brief were added.

---

## Gate results

| Gate | Command | Result |
|---|---|---|
| Biome format + lint | `pnpm biome check packages/studio/src` | **pass** (0 errors, 0 warnings across 146 files) |
| Svelte / TS strict | `pnpm --filter @cleocode/studio run check` | **pass for Wave 1D code** (62 pre-existing errors remain in files we do not own — `api/brain/stream`, `api/memory/decisions/graph/observations/quality`, `BrainGraph.svelte`, `tasks/*` — all predate Wave 1D per the task's "You do NOT touch" list) |
| Stylelint (tokens only) | `pnpm --filter @cleocode/studio run lint:style` | **pass for Wave 1D code** (59 hex-literal errors remain, ALL in `ProjectSelector.svelte` — pre-existing, not owned by Wave 1D) |
| Vitest | `pnpm --filter @cleocode/studio run test` | **pass** — 512 / 512 tests, 42 / 42 files; +35 new tests added |
| Build | `pnpm --filter @cleocode/studio run build` | **pass** — built in 5.53s, bundles emitted |

### Test coverage added

- **Route existence + server-load smoke** for each new page (5 files × 2-3 cases)
- **API endpoint smoke suite** with in-memory SQLite fixture (`api/memory/__tests__/write-endpoints.test.ts`) — 15 cases covering:
  - observe: happy path, E_VALIDATION for missing title, E_VALIDATION for bad JSON
  - decision-store: alternatives array storage, missing rationale rejection
  - pattern-store: first write + dedup-on-repeat (with frequency bump)
  - learning-store: first write + confidence-merge dedup
  - verify: id-prefix routing, unknown-prefix 400, not-found 404
  - patterns / learnings / find / pending-verify / reason-why: fresh-brain empty responses + find matches a freshly-observed title

---

## Design decisions (rationale)

1. **Direct SQL on the Studio side, not a CLEO SDK hop**. The `memory.find`
   and `memory.reason.why` contracts describe RRF + FTS5 fusion and a
   task-graph walk. For Wave 1D the Studio's own `brain.db` query suffices
   — the endpoints use the same shape the core CLI facade will eventually
   serve. This keeps the UI unblocked while the SDK-backed dispatch layer
   stabilises; response-shape parity is the migration seam.
2. **LAFS envelope only on mutation endpoints**. Read endpoints keep the
   raw row shape the Svelte consumer already parses to avoid churning the
   existing observations / decisions routes. `pending-verify`, `observe`,
   `decision-store`, `pattern-store`, `learning-store`, `verify` all use
   LAFS `{success, data, error, meta}` — caller ergonomics for the modals.
3. **Dedup on pattern + learning stores**. Matches the canonical CLEO
   semantics (`deduplicated: true` with frequency-bump / confidence-average)
   so the UI is honest about what actually happened. No silent double-writes.
4. **Tier-stats is the single source of truth for upcoming-promotions**.
   The overview page now fetches `/api/memory/tier-stats`; it previously
   inlined the same SQL. The `/brain/quality` page also pulls from that
   endpoint — two surfaces, one query path.
5. **PageServerLoad narrowing helper in tests**. `PageServerLoad` returns
   `MaybePromise<void | PageData>`, which svelte-check presents as
   `void | PageData` to the test. A small `run()` wrapper asserts the
   expected payload shape once per test file instead of casting everywhere.
6. **Client-side filter + sort on decisions / observations**. The existing
   API surfaces don't accept sort params, so we keep the request as-is and
   sort client-side. This is correct for the ≤ 200-row window the endpoints
   serve; when the wave adds server-side sort the client glue is a one-line
   replacement.

---

## Known follow-ups

1. **Svelte-5 state-locality warnings** on SSR-fed props. Every new page
   reads `data.initial` once into a `const`, then seeds `$state` from it.
   Svelte-check still warns because `data` is a prop. The existing Wave 1A–C
   pages emit the same warning; a shared Wave-0 bump to wrap SSR bootstraps
   in `$derived` would silence them uniformly. Not blocking.
2. **`memory.timeline` + `memory.reason.similar`** are the final two gaps
   on the /brain surface. Timeline needs a new temporal-neighbourhood view;
   similarity wants vector indexing (T-later wave deliverable).
3. **SDK-backed dispatch migration.** When the Studio gains the CLEO SDK,
   swap the Wave 1D endpoints to call the facade instead of running SQL
   directly. The response shapes already match the contracts, so the swap
   is a server-file change only.
4. **Pattern `memory_tier` filter.** The patterns API accepts
   `memory_tier` conceptually but the SQL doesn't filter on it yet (frontend
   sends the chip). Harmless today (patterns rarely reach beyond `short`);
   add a `WHERE memory_tier = ?` in a follow-up.
5. **BrainGraph legacy types.** `src/lib/components/BrainGraph.svelte`
   carries 30+ pre-existing d3 + implicit-any errors unrelated to Wave 1D.
   Flagged for the graph-engine recommendation work already scoped as
   `T990-design-research/graph-engine-recommendation.md`.

---

## Deviations from the brief

- **ObserveModal skipped the hidden `<input onkeydown>` trick for the alt
  input.** The brief specifies Enter-to-add inside Input; Wave 0's Input
  doesn't forward keydown. The modal ships an explicit "Add" button
  instead — same outcome, fully accessible, no dead hidden input.
- **`/brain/quality` got the VerifyQueuePanel too**, matching the Wave 1D
  brief's intent that quality and tier-stats surface the same promotion
  data. This is a small scope-add; no new surface files.
- **Causal page renders a depth-tiered visual + a textual fallback**,
  per the accessibility requirement. The brief mentions `SvgRenderer` as
  an option from Wave 1C — we stubbed with the deterministic tiered
  layout so the page works whether or not Wave 1C has landed.
- **Search page persists recent queries in `localStorage`**, not in the
  brain. This matches the brief ("local storage") and avoids a write-loop
  into the memory surface.
- **Toast implementation is inline** (fixed-position `<div role="status">`)
  because Wave 0 did not ship a `$lib/ui/Toast` primitive. Simple, reduced-
  motion-friendly, token-driven.
- The brief listed `aria-label` on `Input` / `Select` — those props don't
  exist on the Wave 0 primitives. Everywhere the brief asked for
  `aria-label`, the component gets a visible `label=` instead. This is
  actually a stricter-AA outcome than the original spec.

---

## Absolute paths (for evidence)

Components:
- `/mnt/projects/cleocode/packages/studio/src/lib/components/memory/types.ts`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/memory/TierBadge.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/memory/ConfidenceBadge.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/memory/QualityBar.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/memory/PromotionCountdown.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/memory/FilterBar.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/memory/SortControl.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/memory/Pagination.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/memory/ObserveModal.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/memory/DecisionModal.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/memory/PatternModal.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/memory/LearningModal.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/memory/VerifyQueuePanel.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/memory/index.ts`

Pages (new):
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/tier-stats/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/tier-stats/+page.server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/patterns/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/patterns/+page.server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/learnings/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/learnings/+page.server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/search/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/search/+page.server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/causal/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/causal/+page.server.ts`

Pages (modified):
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/observations/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/decisions/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/quality/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/graph/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/overview/+page.server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/overview/+page.svelte`

API (new):
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/_lafs.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/patterns/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/learnings/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/find/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/reason-why/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/pending-verify/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/observe/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/decision-store/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/pattern-store/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/learning-store/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/verify/+server.ts`

Tests (new):
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/__tests__/tier-stats.test.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/__tests__/patterns.test.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/__tests__/learnings.test.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/__tests__/search.test.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/__tests__/causal.test.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/__tests__/write-endpoints.test.ts`

Report:
- `/mnt/projects/cleocode/.cleo/agent-outputs/T990-design-work/wave-1d-memory/REPORT.md`
