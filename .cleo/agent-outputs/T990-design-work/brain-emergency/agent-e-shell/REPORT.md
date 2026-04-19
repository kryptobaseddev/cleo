# Agent E — Brain Page Shell + Load Experience

**Task**: T990 Brain Emergency — Agent E  
**Wave**: 1A  
**Status**: SHIPPED

---

## Deliverables

### New files

| File | Purpose |
|------|---------|
| `packages/studio/src/lib/components/brain/BrainLoadingSkeleton.svelte` | Phase 0 ghost silhouette skeleton with shimmer, substrate cluster outlines, scan line |
| `packages/studio/src/lib/components/brain/RegionMeter.svelte` | Per-substrate monitor card with sparkline, firing rate bar, bridge count, pulse dot |
| `packages/studio/src/lib/components/brain/BrainMonitorPanel.svelte` | Side panel — Region Monitor (5 meters + bridges strip) and Node Detail (bridges, neighbors, source preview) |
| `packages/studio/src/lib/components/brain/SubstrateLegend.svelte` | Enhanced chip rail — click/shift-click/dbl-click/solo/firing-dot |
| `packages/studio/src/lib/components/brain/BrainControlsDock.svelte` | Bottom controls — synapses, bridges-only, breathing-pause, reset, edge taxonomy |
| `packages/studio/src/lib/components/brain/BrainSearchBar.svelte` | Header search with API + client-side fallback, keyboard navigation, combobox ARIA |
| `packages/studio/src/lib/components/brain/BrainStreamIndicator.svelte` | Phase 1/2 streaming dot-pulse badge + warmup progress bar overlay |
| `packages/studio/src/lib/components/brain/index.ts` | Barrel export for all brain components |
| `packages/studio/src/lib/components/__tests__/brain-shell.test.ts` | 10 test groups, 34 unit tests covering pure logic |

### Modified files

| File | Changes |
|------|---------|
| `packages/studio/src/routes/brain/+page.svelte` | Full rewrite wiring all new components; solo mode, bridges-only, keyboard shortcuts 1-5/0/f/b/s//, firing rate sampler, region stats, bridge events, search result navigation |

---

## Architecture

### Three-phase load

```
Phase 0 (0ms)     — BrainLoadingSkeleton renders server-side ghost clusters
                    Header/nav/legend chips all interactive immediately.
                    Canvas host is opacity:0 + pointer-events:none.

Phase 1 (≤300ms)  — onMount fires, loadPhase → 'streaming'.
                    Renderer mounts behind the skeleton host.
                    Canvas host fades in (var(--ease-slow) transition).
                    BrainStreamIndicator shows dot-pulse badge.

Phase 2 (~2s)     — Warmup timer reaches 100%.
                    loadPhase → 'ready'. isStreaming → false.
                    BrainStreamIndicator disappears.
```

The warmup progress bar simulates `d3-force-3d` alpha cooling via a small
interval. In a live integration, `ThreeBrainRenderer` would emit a warmup
event; the shell consumes it via `warmupProgress` state.

### Side panel views

- **Region Monitor** (default, nothing selected): 5 `RegionMeter` cards
  stacked, each with substrate colour bar, name, neuron count, firing rate,
  bridge count, 60-sample sparkline. Below: Active Bridges strip showing
  last 10 bridge events with relative timestamps.

- **Node Detail** (node selected): label, id, weight, freshness, cluster.
  Source preview by substrate (nexus → file path, brain → narrative, tasks → status).
  Connected neighbors grouped by substrate, each clickable.
  Bridges section with `meta.isBridge` detection + cross-substrate fallback.
  Raw metadata collapsible.

### Substrate legend interactions

| Interaction | Effect |
|-------------|--------|
| Click | Focus that substrate (camera zooms) |
| Shift+click | Toggle visibility of that substrate |
| Double-click | Solo mode (all others hidden). Double-click again exits. |
| Firing dot | Pulses when substrate has had fires in last 2s |

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `1`–`5` | Focus substrate 1 (brain) through 5 (signaldock) |
| `0` | Clear focus and solo |
| `f` | Fit camera |
| `/` | Focus search input |
| `s` | Toggle synapses |
| `b` | Toggle bridges-only |
| `Esc` | Close panel / clear focus |

### Bridge detection

Edges are tagged as bridges in two ways (defensive layering):
1. `edge.meta.isBridge === true` — set by `toGraphEdge()` in the page shell
   when `source.substrate !== target.substrate`.
2. Cross-substrate fallback in `BrainMonitorPanel` — if `meta.isBridge` is
   absent, substrate mismatch between source and target nodes counts as a bridge.

This ensures Agent D's explicit tagging takes precedence while the UI still
works if Agent D's deliverable is not yet present.

---

## Quality gates

| Gate | Result |
|------|--------|
| `pnpm --filter @cleocode/studio run test` | **648 passed, 0 failed** |
| `pnpm biome check --write packages/studio/src/...` | **No errors** (2 auto-fixes applied: unused import, export order) |
| `pnpm --filter @cleocode/studio run check` | **0 new errors** (1 pre-existing warning in our file — intentional `data` initial capture, same as original file) |
| `pnpm --filter @cleocode/studio run build` | **Built in 6.19s, 0 errors** |

New tests added: **34 assertions across 10 describe blocks** in
`brain-shell.test.ts`. All test pure extracted functions — no DOM, no WebGL.

---

## Before / after layout sketch

### Before (original shell)
```
┌─ header (breadcrumb + live status) ────────────────────┐
│  hero title                                             │
│  controls (tabs | substrate chips | weight | time)     │
├─────────────────────────────┬───────────────────────────┤
│                             │  Card: Navigator          │
│   ThreeBrainRenderer        │  • synapse toggle         │
│   (blank 5s on slow load)   │  • hub node list (120)    │
│                             │                           │
├─────────────────────────────┴───────────────────────────┤
│  legend dock (edge kinds)                               │
└─────────────────────────────────────────────────────────┘
```

### After (Agent E shell)
```
┌─ header ────────────────────────────────────────────────┐
│  breadcrumb  [search "observations, symbols, tasks..."] │
│              live badge + counts                        │
│  hero title + sub                                       │
│  controls: tabs | SubstrateLegend | weight | time       │
│            (click/shift/dbl + firing dots)              │
│            kbd strip: 1-5 · 0 · f · / · s · b · Esc    │
├─────────────────────────────┬───────────────────────────┤
│  Phase 0:                   │  BrainMonitorPanel        │
│   BrainLoadingSkeleton      │  Region Monitor:          │
│   (5 ghost clusters, shimmer│  • 5 RegionMeter cards    │
│    scan line, dot field)    │    name · neurons ·       │
│                             │    firing% · bridges      │
│  Phase 1/2:                 │    sparkline              │
│   ThreeBrainRenderer        │  • Active Bridges strip   │
│   + BrainStreamIndicator    │                           │
│     (dot-pulse + warmup%)   │  Node Detail (on select): │
│                             │  • identity + preview     │
│   [hover hint bottom-left]  │  • neighbors by substrate │
│                             │  • Bridges section        │
│                             │  • raw meta collapsible   │
│                             │  Hub nodes panel (below)  │
├─────────────────────────────┴───────────────────────────┤
│  BrainControlsDock:                                     │
│  Canvas: [synapses] [bridges only] [breathing]   [fit f]│
│  Edge taxonomy: [parent] [contains] ... (all kinds)     │
└─────────────────────────────────────────────────────────┘
```

---

## Coordination contracts consumed

- `ThreeBrainRenderer` — prop contract stable (`nodes edges onNodeSelect
  onCanvasClear onHover pulsingNodes pendingFires showSynapses focusSubstrate
  height`). `focusSubstrate` wired from SubstrateLegend clicks.

- `LivingBrainCosmograph` — unchanged prop contract.

- Agent D bridges: `edge.meta.isBridge` consumed in BrainMonitorPanel
  bridge list and `showBridgesOnly` filter in `renderGraph`. Cross-substrate
  fallback active when Agent D is not yet present.

- Agent C streaming: defensive — if `streamRemainingNodes` is not exported,
  the full graph from `data.graph` is rendered. Warmup progress is simulated
  locally until Agent C exposes a warmup signal.

---

## Accessibility

- All interactive elements have `aria-label` or visible labels.
- Keyboard shortcuts are documented in a visible strip and announced via
  title attributes.
- `BrainSearchBar` implements `role="combobox"` + `aria-autocomplete="list"`
  + `aria-expanded` + `aria-activedescendant`.
- `BrainLoadingSkeleton` has `aria-hidden="true"` — decorative only.
- `BrainStreamIndicator` uses `aria-live="polite"`.
- `RegionMeter` buttons have full descriptive `aria-label` including all
  numeric values.
- `prefers-reduced-motion`: shimmer stops, dot animations stop, scan line
  hidden, sparkline updates without animation, progress bar transition
  removed — all via `@media (prefers-reduced-motion: reduce)` blocks.

---

## Notes for peers

- `soloSubstrate` state is new — when set, `effectiveSubstrates` collapses
  to a single-element set. The `ThreeBrainRenderer` still receives all
  substrate data via `focusSubstrate`; the visual hiding is handled by
  `filteredRaw` upstream.
- The `showBridgesOnly` toggle filters `renderGraph.edges` to only include
  edges where `meta.isBridge === true`. It does not affect node visibility.
- `BrainSearchBar.searchInput` is bindable — the page shell holds a ref and
  uses it for the `/` keyboard shortcut to focus the input.
