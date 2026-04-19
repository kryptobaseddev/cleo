<!--
  RegionMeter — single substrate region card for the Brain Monitor side panel.

  Displays neuron count, live firing rate, a 60-sample sparkline of firing
  history over the last minute, cross-substrate bridge count, and a substrate
  colour bar on the left edge.

  @task T990
  @wave 1A
-->
<script lang="ts">
  import type { SubstrateId } from '$lib/graph/types.js';

  /**
   * Props for {@link RegionMeter}.
   */
  interface Props {
    /** Substrate id. Drives colour and region label lookup. */
    substrate: SubstrateId;
    /** Human-readable region name (e.g. "HIPPOCAMPUS"). */
    regionName: string;
    /** Current live neuron (node) count. */
    neuronCount: number;
    /** Rolling 5-second firing rate as a percentage [0..100]. */
    firingRate: number;
    /** Number of bridge edges to/from other substrates. */
    bridgeCount: number;
    /** 60-sample ring buffer of firing rate history. Oldest first. */
    history?: number[];
    /** CSS custom property reference for the substrate colour. */
    colorVar: string;
    /** Whether this substrate is currently actively firing (drives pulse dot). */
    firing?: boolean;
    /** Click handler — fires when the card is clicked. */
    onclick?: () => void;
  }

  let {
    substrate,
    regionName,
    neuronCount,
    firingRate,
    bridgeCount,
    history = [],
    colorVar,
    firing = false,
    onclick,
  }: Props = $props();

  /** Maximum samples to display in sparkline. */
  const SPARK_SAMPLES = 60;

  /**
   * Build an SVG polyline path string from an array of [0..100] values.
   * Uses the last SPARK_SAMPLES entries, normalised to a 120x28 viewport.
   */
  function buildSparkPath(values: number[]): string {
    const samples = values.slice(-SPARK_SAMPLES);
    if (samples.length < 2) return '';
    const w = 120;
    const h = 28;
    const max = Math.max(...samples, 1);
    const step = w / (samples.length - 1);
    const points = samples.map((v, i) => {
      const x = i * step;
      const y = h - (v / max) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `M ${points.join(' L ')}`;
  }

  const sparkPath = $derived(buildSparkPath(history));
  const firingRateDisplay = $derived(firingRate.toFixed(1));
  const firingRatePct = $derived(Math.min(100, firingRate));
</script>

<button
  type="button"
  class="region-meter"
  class:firing
  style="--meter-color: {colorVar};"
  onclick={onclick}
  aria-label="{regionName} region: {neuronCount} neurons, {firingRateDisplay}% firing rate, {bridgeCount} bridges"
  data-substrate={substrate}
>
  <!-- Left colour bar -->
  <div class="color-bar" aria-hidden="true"></div>

  <!-- Content -->
  <div class="meter-body">
    <!-- Header row -->
    <div class="meter-header">
      <div class="meter-name-row">
        <span class="firing-dot" class:active={firing} aria-hidden="true"></span>
        <span class="region-name">{regionName}</span>
      </div>
      <div class="meter-stats">
        <span class="stat-group">
          <span class="stat-val">{neuronCount.toLocaleString()}</span>
          <span class="stat-label">neurons</span>
        </span>
        <span class="sep" aria-hidden="true">·</span>
        <span class="stat-group">
          <span class="stat-val firing-val">{firingRateDisplay}%</span>
          <span class="stat-label">firing</span>
        </span>
        <span class="sep" aria-hidden="true">·</span>
        <span class="stat-group">
          <span class="stat-val">{bridgeCount}</span>
          <span class="stat-label">bridges</span>
        </span>
      </div>
    </div>

    <!-- Firing rate bar -->
    <div class="rate-bar-track" aria-hidden="true" role="presentation">
      <div class="rate-bar-fill" style="width: {firingRatePct}%"></div>
    </div>

    <!-- Sparkline -->
    {#if sparkPath}
      <div class="sparkline-wrap" aria-hidden="true">
        <svg
          class="sparkline"
          viewBox="0 0 120 28"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <path d={sparkPath} class="spark-path" />
          <!-- Fill area below the path -->
          <path d="{sparkPath} L 120,28 L 0,28 Z" class="spark-fill" />
        </svg>
      </div>
    {:else}
      <div class="sparkline-empty" aria-hidden="true">
        <span class="spark-placeholder">no history</span>
      </div>
    {/if}
  </div>
</button>

<style>
  .region-meter {
    display: flex;
    align-items: stretch;
    width: 100%;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-align: left;
    overflow: hidden;
    transition:
      background var(--ease),
      border-color var(--ease),
      box-shadow var(--ease);
    padding: 0;
    gap: 0;
    position: relative;
  }

  .region-meter:hover,
  .region-meter:focus-visible {
    background: color-mix(in srgb, var(--meter-color) 5%, var(--bg-elev-1));
    border-color: color-mix(in srgb, var(--meter-color) 40%, var(--border));
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .region-meter.firing {
    border-color: color-mix(in srgb, var(--meter-color) 50%, var(--border));
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--meter-color) 20%, transparent);
  }

  /* Left colour bar */
  .color-bar {
    width: 3px;
    flex-shrink: 0;
    background: var(--meter-color);
    opacity: 0.8;
    align-self: stretch;
  }

  /* Content area */
  .meter-body {
    flex: 1;
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  /* Header */
  .meter-header {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .meter-name-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  /* Pulse dot */
  .firing-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--border-strong);
    flex-shrink: 0;
    transition: background var(--ease), box-shadow var(--ease);
  }

  .firing-dot.active {
    background: var(--meter-color);
    animation: pulse-dot 1.2s ease-in-out infinite;
  }

  @keyframes pulse-dot {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--meter-color) 50%, transparent); }
    50%       { box-shadow: 0 0 0 4px transparent; }
  }

  .region-name {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: color-mix(in srgb, var(--meter-color) 80%, var(--text));
  }

  /* Stats row */
  .meter-stats {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .stat-group {
    display: inline-flex;
    align-items: baseline;
    gap: 3px;
  }

  .stat-val {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  .firing-val {
    color: var(--meter-color);
  }

  .stat-label {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
  }

  .sep {
    color: var(--text-faint);
    font-size: var(--text-2xs);
  }

  /* Rate bar */
  .rate-bar-track {
    height: 2px;
    background: var(--border);
    border-radius: var(--radius-pill);
    overflow: hidden;
    margin-top: 2px;
  }

  .rate-bar-fill {
    height: 100%;
    background: var(--meter-color);
    border-radius: var(--radius-pill);
    transition: width 400ms ease;
    max-width: 100%;
    opacity: 0.8;
  }

  /* Sparkline */
  .sparkline-wrap {
    margin-top: var(--space-1);
  }

  .sparkline {
    display: block;
    width: 100%;
    height: 28px;
    overflow: visible;
  }

  .spark-path {
    fill: none;
    stroke: var(--meter-color);
    stroke-width: 1.2;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.9;
  }

  .spark-fill {
    fill: color-mix(in srgb, var(--meter-color) 15%, transparent);
    stroke: none;
  }

  .sparkline-empty {
    height: 28px;
    display: flex;
    align-items: center;
    margin-top: var(--space-1);
  }

  .spark-placeholder {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .firing-dot.active {
      animation: none;
    }

    .rate-bar-fill {
      transition: none;
    }
  }
</style>
