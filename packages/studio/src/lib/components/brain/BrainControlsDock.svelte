<!--
  BrainControlsDock — bottom control strip for the Brain canvas.

  Contains:
    - Edge taxonomy toggles (existing legend dock behaviour).
    - Show synapses toggle (default ON).
    - Show bridges only toggle (default OFF).
    - Pause breathing toggle.
    - Reset view button (fires onResetView, shortcut `f`).

  @task T990
  @wave 1A
-->
<script lang="ts">
  import { ALL_EDGE_KINDS, describeEdgeKind, EDGE_STYLE } from '$lib/graph/edge-kinds.js';
  import type { EdgeKind } from '$lib/graph/types.js';

  /**
   * Props for {@link BrainControlsDock}.
   */
  interface Props {
    /** Which edge kinds are currently visible. */
    enabledKinds: Set<EdgeKind>;
    /** Whether the synapse line layer is visible. */
    showSynapses: boolean;
    /** When true, hide all intra-substrate edges (show bridges only). */
    showBridgesOnly: boolean;
    /** When true, the ambient d3 sim is paused. */
    breathingPaused: boolean;
    /** Fired when an edge-kind chip is toggled. */
    onToggleKind?: (k: EdgeKind) => void;
    /** Fired when synapse toggle is changed. */
    onToggleSynapses?: () => void;
    /** Fired when bridges-only toggle is changed. */
    onToggleBridgesOnly?: () => void;
    /** Fired when breathing-pause toggle is changed. */
    onToggleBreathing?: () => void;
    /** Fired when the reset-view button is pressed. */
    onResetView?: () => void;
  }

  let {
    enabledKinds,
    showSynapses,
    showBridgesOnly,
    breathingPaused,
    onToggleKind,
    onToggleSynapses,
    onToggleBridgesOnly,
    onToggleBreathing,
    onResetView,
  }: Props = $props();
</script>

<footer class="controls-dock" aria-label="Canvas controls">
  <!-- Section: canvas toggles -->
  <div class="dock-section controls-toggles">
    <span class="dock-eyebrow">Canvas</span>
    <div class="toggle-group" role="group" aria-label="Canvas visibility toggles">
      <button
        type="button"
        class="dock-toggle"
        class:active={showSynapses}
        onclick={onToggleSynapses}
        aria-pressed={showSynapses}
        title="Toggle synapse edge lines (s)"
      >
        <span class="toggle-dot" class:on={showSynapses} aria-hidden="true"></span>
        synapses
        <kbd class="shortcut-hint" aria-hidden="true">s</kbd>
      </button>

      <button
        type="button"
        class="dock-toggle"
        class:active={showBridgesOnly}
        onclick={onToggleBridgesOnly}
        aria-pressed={showBridgesOnly}
        title="Show only cross-substrate bridge edges (b)"
      >
        <span class="toggle-dot" class:on={showBridgesOnly} aria-hidden="true"></span>
        bridges only
        <kbd class="shortcut-hint" aria-hidden="true">b</kbd>
      </button>

      <button
        type="button"
        class="dock-toggle"
        class:active={breathingPaused}
        onclick={onToggleBreathing}
        aria-pressed={breathingPaused}
        title="Pause ambient simulation breathing"
      >
        <span class="toggle-dot" class:on={breathingPaused} aria-hidden="true"></span>
        {breathingPaused ? 'paused' : 'breathing'}
      </button>
    </div>
  </div>

  <!-- Divider -->
  <div class="dock-divider" aria-hidden="true"></div>

  <!-- Section: edge taxonomy -->
  <div class="dock-section edge-section">
    <span class="dock-eyebrow">Edge taxonomy — toggle to filter</span>
    <div class="edge-grid">
      {#each ALL_EDGE_KINDS as k (k)}
        {@const style = EDGE_STYLE[k]}
        <button
          type="button"
          class="edge-kind"
          class:active={enabledKinds.has(k)}
          onclick={() => onToggleKind?.(k)}
          aria-pressed={enabledKinds.has(k)}
          title={describeEdgeKind(k)}
        >
          <span
            class="edge-swatch"
            class:dashed={Boolean(style.dash)}
            style="--swatch-color: {style.color};"
            aria-hidden="true"
          ></span>
          <span class="edge-name">{k}</span>
        </button>
      {/each}
    </div>
  </div>

  <!-- Reset view -->
  <div class="dock-actions">
    <button
      type="button"
      class="reset-btn"
      onclick={onResetView}
      title="Fit camera to graph (f)"
      aria-label="Reset camera view to fit the graph"
    >
      fit view
      <kbd class="shortcut-hint" aria-hidden="true">f</kbd>
    </button>
  </div>
</footer>

<style>
  .controls-dock {
    padding: var(--space-3) var(--space-4);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    align-items: flex-start;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  .dock-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .controls-toggles {
    flex-shrink: 0;
  }

  .edge-section {
    flex: 1;
    min-width: 200px;
  }

  .dock-eyebrow {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-faint);
  }

  .dock-divider {
    width: 1px;
    background: var(--border);
    align-self: stretch;
    flex-shrink: 0;
  }

  /* -----------------------------------------------------------------------
   * Canvas toggles
   * --------------------------------------------------------------------- */
  .toggle-group {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .dock-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 4px var(--space-3);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
    transition: background var(--ease), border-color var(--ease), color var(--ease);
  }

  .dock-toggle:hover,
  .dock-toggle:focus-visible {
    color: var(--text);
    border-color: var(--border-strong);
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .dock-toggle.active {
    color: var(--text);
    background: var(--bg-elev-2);
    border-color: var(--accent);
  }

  .toggle-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--border-strong);
    transition: background var(--ease), box-shadow var(--ease);
    flex-shrink: 0;
  }

  .toggle-dot.on {
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent);
  }

  .shortcut-hint {
    display: inline-block;
    padding: 0 3px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    font-family: inherit;
    font-size: 0.6rem;
    color: var(--text-faint);
    line-height: 1.4;
    margin-left: 2px;
  }

  /* -----------------------------------------------------------------------
   * Edge taxonomy
   * --------------------------------------------------------------------- */
  .edge-grid {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .edge-kind {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 3px var(--space-3);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
    transition: background var(--ease), border-color var(--ease), color var(--ease);
  }

  .edge-kind:hover,
  .edge-kind:focus-visible {
    color: var(--text);
    border-color: var(--border-strong);
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .edge-kind.active {
    color: var(--text);
    background: var(--bg-elev-2);
    border-color: var(--border-strong);
  }

  .edge-kind:not(.active) .edge-name {
    text-decoration: line-through;
    text-decoration-color: var(--text-faint);
  }

  .edge-swatch {
    width: 18px;
    height: 2px;
    background: var(--swatch-color);
    border-radius: var(--radius-xs);
    flex-shrink: 0;
  }

  .edge-swatch.dashed {
    background-image: linear-gradient(
      90deg,
      var(--swatch-color) 0 6px,
      transparent 6px 10px,
      var(--swatch-color) 10px 16px,
      transparent 16px 20px
    );
    background-color: transparent;
  }

  .edge-name {
    white-space: nowrap;
  }

  /* -----------------------------------------------------------------------
   * Reset view
   * --------------------------------------------------------------------- */
  .dock-actions {
    flex-shrink: 0;
    align-self: flex-end;
  }

  .reset-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 4px var(--space-3);
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
    transition: background var(--ease), border-color var(--ease), color var(--ease);
  }

  .reset-btn:hover,
  .reset-btn:focus-visible {
    color: var(--text);
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--bg-elev-2));
    outline: none;
    box-shadow: var(--shadow-focus);
  }
</style>
