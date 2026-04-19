/**
 * Brain canvas component library.
 *
 * All components in this directory are owned by the Brain page shell (Agent E).
 * They are consumed exclusively by `src/routes/brain/+page.svelte`.
 *
 * Public surface:
 *   - {@link BrainLoadingSkeleton} — Phase 0 ghost silhouette skeleton.
 *   - {@link BrainMonitorPanel}   — Side panel (Region Monitor + Node Detail).
 *   - {@link SubstrateLegend}     — Enhanced substrate chip rail.
 *   - {@link BrainControlsDock}   — Bottom controls strip.
 *   - {@link BrainSearchBar}      — Header search input with fallback.
 *   - {@link BrainStreamIndicator}— Streaming + warmup progress overlay.
 *
 * Types re-exported for consumer convenience:
 *   - {@link RegionStats}
 *   - {@link BridgeEvent}
 *
 * @task T990
 * @wave 1A
 */

export { default as BrainControlsDock } from './BrainControlsDock.svelte';
export { default as BrainLoadingSkeleton } from './BrainLoadingSkeleton.svelte';
export type { BridgeEvent, RegionStats } from './BrainMonitorPanel.svelte';
export { default as BrainMonitorPanel } from './BrainMonitorPanel.svelte';
export { default as BrainSearchBar } from './BrainSearchBar.svelte';
export { default as BrainStreamIndicator } from './BrainStreamIndicator.svelte';
export { default as SubstrateLegend } from './SubstrateLegend.svelte';
