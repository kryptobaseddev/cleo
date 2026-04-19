# T990 Integration Cleanup — Report

Three focused fixes applied after Wave 0/1A/1B/1C/1D/1E. Every change is
scoped to the three files called out in the brief; no other file in the
studio package was modified. Full quality-gate output below.

## Target 1 — Type regression at `src/routes/tasks/+page.svelte:683`

### Before

- `+page.server.ts` declared a loose `RecentTask { status: string; priority: string; ... }`.
- The `.all()` cast at `load()` produced `RecentTask[]`.
- `+page.svelte` typed `recentTasks = $derived<RecentTask[]>(data.recentTasks ?? [])`.
- `<RecentActivityFeed tasks={recentTasks} />` failed svelte-check at line
  683 because `RecentActivityFeed` requires the strict
  `RecentTaskRow { status: TaskStatus; priority: TaskPriority; ... }`.

### After

- Narrowing happens at the **server boundary**, exactly as the brief directed:
  - Added `narrowStatus(raw, id): TaskStatus` backed by the
    canonical `TASK_STATUSES` runtime tuple from `@cleocode/contracts`
    (`TASK_STATUS_SET: ReadonlySet<TaskStatus>`).
  - Added `narrowPriority(raw, id): TaskPriority` backed by the
    explicit priority tuple (`@cleocode/contracts` does not export a
    runtime constant tuple for `TaskPriority`, so it's declared
    locally with the `TaskPriority[]` annotation enforcing exhaustiveness).
  - Both helpers coerce unknown values to a safe terminal bucket
    (`'cancelled'` / `'low'`) and `console.warn` — so a future schema
    drift surfaces in logs rather than crashing a render path.
- `RecentTask` is now a type alias for `RecentTaskRow` (imported from
  `$lib/components/tasks`) so the existing `+page.svelte` import stays
  valid without any client-side edit — the brief's non-goal of
  "don't touch files outside the three targets" is respected (the
  svelte file was listed as an "involved" file; its `import type
  { RecentTask }` line continues to resolve against the new alias).
- The `.all()` cast uses an **inline anonymous raw-row type**
  (`Array<{ id: string; title: string; status: string; priority:
  string; type: string; pipeline_stage: string | null; updated_at:
  string }>`) to match the established pattern used elsewhere in
  the same file (`countByStatus.all() as Array<{ status: string;
  cnt: number }>`) and to avoid the `Record<string, SQLOutputValue>[]`
  assertion-rejection that nominal interfaces trigger under TS strict.
- `.map()` produces a strongly-typed `RecentTaskRow[]` via the two narrow
  helpers, so `recentTasks` crosses the SSR boundary already narrowed.

### Prohibited approaches avoided

- No `as unknown as RecentTaskRow[]` anywhere.
- No `@ts-ignore` / `@ts-expect-error`.
- `RecentTaskRow['status']` / `['priority']` unions are unchanged.

### Files touched (Target 1)

- `packages/studio/src/routes/tasks/+page.server.ts` — narrow helpers +
  type alias + mapper. No other logic changed.
- `packages/studio/src/routes/tasks/+page.svelte` — **not modified**.
  The `RecentTask` type import resolves to the new
  `RecentTaskRow` alias transparently, fixing the type error at line 683.

## Target 2 — Tokenize `ProjectSelector.svelte`

### Before

- 59 raw hex literals across the `<style>` block — flagged by the
  repo's `color-no-hex` stylelint rule.
- Also 8 hex literals in the JS `CHIP_COLORS` table used for the
  chip-hashing projection. These don't hit stylelint (it's CSS-only),
  but they conflict with the T990 principle of single-source colour
  truth.

### After

- Every `<style>` block hex literal replaced with a token from
  `$lib/styles/tokens.css`. Mechanical mapping applied from the Wave 0
  precedent:
  - `#0f1117` / surface → `var(--bg)`
  - `#1a1f2e` / elevated surface → `var(--bg-elev-1)`
  - `#232a3a` / highest elevation → `var(--bg-elev-2)`
  - `#2d3748` / hairline → `var(--border)`
  - `#4a5568` / separator + muted text → `var(--border-strong)` /
    `var(--text-faint)` by context
  - `#e2e8f0` → `var(--text)`
  - `#718096` → `var(--text-faint)`
  - `#3b82f6` → `var(--info)` (active chip + project-active accent)
  - `#ef4444` → `var(--danger)` (unhealthy dot)
  - `#fff` on tint chips → `var(--text)`
  - Fixed radii (`6px`, `8px`, `5px`, `3px`, `2px`) → `var(--radius-md/lg/sm/xs)`
  - Shadows → `var(--shadow-lg)`
  - Hover transitions (`0.15s`, `0.12s`, `0.2s`) → `var(--ease)` /
    `var(--ease-slow)`
- The JS `CHIP_COLORS` table was rebuilt as `CHIP_COLOR_VARS` holding
  `var(--…)` references (so the inline `style="background: {chipColor(...)}"`
  applies a token chain, never a literal):
  - blue → `var(--info)`; emerald → `var(--success)`; amber →
    `var(--warning)`; violet → `var(--accent)`; pink →
    `var(--priority-critical)`; cyan → `var(--edge-definition)`;
    lime → `var(--edge-structural)`; orange → `var(--edge-extends)`.
- Behaviour preserved: search + filter + keyboard nav + click-outside +
  POST `/api/project/switch` all unchanged. Prop API unchanged.
  Layout unchanged — only color / radius / motion / shadow literals
  were swapped for tokens.
- Stylelint count in `ProjectSelector.svelte`: **59 → 0**.

### Files touched (Target 2)

- `packages/studio/src/lib/components/ProjectSelector.svelte`.

## Target 3 — Shim unused `BrainGraph.svelte`

### Before

- 462-line d3-force SVG renderer carrying ~27 svelte-check errors
  (all d3-typing regressions — `d: any` on every simulation
  callback, `d3.drag` / `d3.zoom` missing from the active `@types/d3`,
  etc.). The brief stated 15; the actual count was 27 after the
  latest d3 typings drift, but all 27 are eliminated by the shim.
- Also carried 12 raw hex literals that stylelint was flagging.

### After

A 100-line thin shim (brief asked for ~50; my implementation is 100
because it includes TSDoc for every public symbol, the deprecation
banner, and the legacy-shape → kit-shape projection — no runtime logic
beyond that projection):

- **Public API preserved verbatim**: default Svelte component, props
  `nodes: BrainNode[]`, `edges: BrainEdge[]`, `filterDate?: string | null`.
  The legacy `BrainNode` / `BrainEdge` SQL-row shapes (`node_type`,
  `quality_score`, `metadata_json`, `from_id`, `to_id`, `edge_type`)
  are **exported** so any caller importing those shapes via the
  component file still resolves.
- **Delegation**: renders `<ThreeBrainRenderer nodes={adaptedNodes}
  edges={adaptedEdges} height="100%" />` — the canonical 3D renderer
  Wave 1A shipped.
- **Adapter** built inline rather than reusing
  `$lib/graph/brain-adapter.ts`, because that adapter expects the
  `@cleocode/brain` runtime shape (`BrainNode { kind, substrate,
  label, createdAt, weight }`), which is **different** from the
  legacy SQL-row shape this shim must accept. The inline adapter
  maps `node_type → kind`, `quality_score → weight`, `from_id/to_id
  → source/target`, unknown `edge_type → 'relates_to'`.
- **`filterDate`** preserved: the shim filters nodes with
  `created_at <= filterDate` before adapting, so the pre-T990
  time-slider behaviour at `routes/brain/graph/+page.svelte` keeps
  working.
- **Deprecation TSDoc** at the top per brief:
  `@deprecated since T990; delegates to ThreeBrainRenderer. Slated
  for removal.`

### Correction to brief's claim

The brief stated "no import of `BrainGraph` exists in the current
codebase". In fact `packages/studio/src/routes/brain/graph/+page.svelte:13`
does import it (`import BrainGraph from '$lib/components/BrainGraph.svelte'`).
The shim approach still works — the preserved signature keeps that
consumer compiling while routing renders through the canonical kit.
`brain/+page.svelte` also uses `BrainGraph` but as a **type** imported
from `@cleocode/brain` (a different symbol). The shim affects only
the component-consumer path.

### Files touched (Target 3)

- `packages/studio/src/lib/components/BrainGraph.svelte`.

## Quality gate results

Every gate below was run after all three targets landed. Exit-code
semantics: `0` = pass.

| Gate | Command | Result | Numbers |
|---|---|---|---|
| svelte-check | `pnpm --filter @cleocode/studio run check` | **PASS for targets** | 63 → 30 total errors (−33). Zero errors in any of the four files the brief listed as "involved" (`+page.svelte`, `+page.server.ts`, `RecentActivityFeed.svelte`, `ProjectSelector.svelte`, `BrainGraph.svelte`). Remaining 30 errors are all pre-existing in files outside the 3 target scope (`api/brain/stream/+server.ts`, `api/memory/graph/+server.ts`, `api/memory/quality/+server.ts`, `api/tasks/search/+server.ts`, `tasks/[id]/+page.server.ts`, `tasks/pipeline/+page.server.ts`, `explorer-loader.ts`, `tests/*`). |
| biome | `pnpm biome check --write packages/studio` | **PASS** | `Checked 146 files in 215ms. Fixed 1 file.` — biome auto-sorted imports on `+page.server.ts`. Zero diagnostics. |
| stylelint | `pnpm --filter @cleocode/studio run lint:style` | **PASS for targets** | ProjectSelector: 59 → 0. BrainGraph: 12 → 0 (shim has zero style rules). Remaining 14 errors are all in `LivingBrainCosmograph.svelte` (6) and `NexusGraph.svelte` (8) — both outside my target scope per the brief's "Do NOT touch any file outside the three targets" constraint. |
| vitest | `pnpm --filter @cleocode/studio run test` | **PASS** | `Test Files  42 passed (42) / Tests  512 passed (512)`. Zero regressions, exact parity with baseline. |
| vite build | `pnpm --filter @cleocode/studio run build` | **PASS** | `built in 5.25s`, SSR + adapter-node both succeed. |

### Against the brief's stated acceptance

- `lint:style → zero errors (down from 59)`: **ProjectSelector is
  at 0 errors (59 → 0).** The remaining 14 package-wide errors
  belong to `LivingBrainCosmograph.svelte` and `NexusGraph.svelte`
  which the brief forbids me to touch. Reading the brief in the
  context of that hard constraint, this satisfies the
  "down from 59" target.
- `svelte-check → at least 16 fewer errors`: **−33 errors achieved**
  (63 → 30). Well above the −16 minimum.
- `test → all 512 tests still pass`: **512/512**, matches baseline.
- `build → succeeds`: **yes**, 5.25s.

## Forbidden patterns audit (self-check)

Ran targeted grep on each of the three files for the brief's forbidden
patterns (`any`, `unknown` shortcut, `as unknown as X`, hex literals in
Svelte styles):

- `BrainGraph.svelte` — zero matches.
- `ProjectSelector.svelte` — zero CSS hex literals; the only hex
  strings are in JavaScript comments documenting the migration path
  for auditors (stylelint's `color-no-hex` is CSS-only and does not
  flag them).
- `+page.server.ts` — zero `any`, zero `unknown` shortcuts, zero
  `as unknown as` chains.

## Deviations from the brief

1. **BrainGraph shim is 100 lines, not 50.** The brief asked for ~50.
   My shim is 100 because it preserves TSDoc for every exported
   symbol (required by the project's "TSDoc coverage" rule in
   `AGENTS.md`), includes the deprecation banner, and carries the
   legacy→kit shape projection (the existing
   `$lib/graph/brain-adapter.ts` takes a different input shape, so a
   local projection was the cheapest legal bridge). Pure-logic
   footprint is ~25 lines; the remainder is doc comments.
2. **`ThreeBrainRenderer` prop subset**. The brief mentions passing
   `onNodeClick` through the shim. `ThreeBrainRenderer` exposes
   `onNodeSelect: (node: GraphNode) => void`, not `onNodeClick`. The
   `brain/graph/+page.svelte` caller does not pass any click handler
   today, so omitting it from the shim's prop surface kept the TS
   contract strict without breaking any consumer. If a future caller
   needs click forwarding it can be wired by precedent from
   `LivingBrainGraph.svelte` (which does the same translation).
3. **Inline raw-row type, not a named interface.** The initial attempt
   declared a `RecentTaskRowRaw` interface and cast `.all() as
   RecentTaskRowRaw[]`; TS strict rejected the cast with
   "neither type sufficiently overlaps" (the same error that pre-
   exists on other named-interface casts in the file list above).
   Switching to an inline anonymous type matched the pattern already
   used for `countByStatus` / `countByPriority` / `countByType` in
   the same file and satisfied strict TS without reaching for
   `as unknown as`.

## Files modified (complete list)

1. `/mnt/projects/cleocode/packages/studio/src/routes/tasks/+page.server.ts`
2. `/mnt/projects/cleocode/packages/studio/src/lib/components/ProjectSelector.svelte`
3. `/mnt/projects/cleocode/packages/studio/src/lib/components/BrainGraph.svelte`

Every other package file is byte-for-byte identical to the working
tree at session start.
