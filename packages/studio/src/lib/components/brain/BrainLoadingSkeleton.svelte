<!--
  BrainLoadingSkeleton — Phase 0 load state for the Brain canvas.

  Renders a ghost brain silhouette: five pill outlines positioned at the
  approximate screen regions of each substrate cluster, with token-coloured
  borders and a shimmer sweep animation. The shell header, nav, view-mode
  switcher, and substrate legend chips are all interactive even during this
  phase — only the canvas area shows the skeleton.

  Respects `prefers-reduced-motion` — shimmer stops when motion is reduced.

  @task T990
  @wave 1A
-->
<script lang="ts">
  import type { SubstrateId } from '$lib/graph/types.js';

  /**
   * Props for {@link BrainLoadingSkeleton}.
   */
  interface Props {
    /** Whether the skeleton is currently visible. */
    visible?: boolean;
    /** Optional CSS height for the skeleton area. */
    height?: string;
  }

  let { visible = true, height = '100%' }: Props = $props();

  /**
   * Ghost cluster descriptors — approximate substrate positions in the
   * canvas viewport as percentage offsets from top-left. Positions mirror
   * the d3-force-3d z-axis bias used by ThreeBrainRenderer.
   */
  interface GhostCluster {
    id: SubstrateId;
    label: string;
    cssVar: string;
    top: string;
    left: string;
    width: string;
    height: string;
  }

  const GHOST_CLUSTERS: GhostCluster[] = [
    { id: 'brain', label: 'BRAIN', cssVar: 'var(--info)', top: '18%', left: '22%', width: '22%', height: '14%' },
    { id: 'nexus', label: 'NEXUS', cssVar: 'var(--success)', top: '42%', left: '52%', width: '26%', height: '16%' },
    { id: 'tasks', label: 'TASKS', cssVar: 'var(--warning)', top: '62%', left: '20%', width: '20%', height: '12%' },
    { id: 'conduit', label: 'CONDUIT', cssVar: 'var(--accent)', top: '28%', left: '58%', width: '16%', height: '10%' },
    { id: 'signaldock', label: 'SIGNALDOCK', cssVar: 'var(--danger)', top: '70%', left: '55%', width: '18%', height: '10%' },
  ];
</script>

{#if visible}
  <div class="skeleton-canvas" style="height: {height};" aria-hidden="true" data-brain-skeleton>
    <!-- Ambient radial glow behind the clusters -->
    <div class="ambient-glow"></div>

    <!-- Ghost cluster outlines -->
    {#each GHOST_CLUSTERS as cluster (cluster.id)}
      <div
        class="ghost-cluster"
        style="
          top: {cluster.top};
          left: {cluster.left};
          width: {cluster.width};
          height: {cluster.height};
          --ghost-color: {cluster.cssVar};
        "
      >
        <div class="ghost-label">
          <span class="ghost-substrate">{cluster.label}</span>
          <span class="ghost-dash">·</span>
          <span class="ghost-count">—</span>
          <span class="ghost-dash">·</span>
          <span class="ghost-count">—</span>
        </div>
        <div class="shimmer-overlay"></div>
      </div>
    {/each}

    <!-- Scattered ghost node dots -->
    <div class="ghost-dots" aria-hidden="true">
      {#each { length: 48 } as _, i}
        <div
          class="ghost-dot"
          style="
            top: {10 + ((i * 7 + i * i * 3) % 78)}%;
            left: {8 + ((i * 13 + i * 5) % 82)}%;
            width: {3 + (i % 5)}px;
            height: {3 + (i % 5)}px;
            animation-delay: {(i * 137) % 2000}ms;
            opacity: {0.08 + (i % 7) * 0.02};
          "
        ></div>
      {/each}
    </div>

    <!-- Shimmer scan line — sweeps across the whole canvas -->
    <div class="scan-line"></div>
  </div>
{/if}

<style>
  .skeleton-canvas {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: var(--bg);
    border-radius: var(--radius-lg);
  }

  /* -----------------------------------------------------------------------
   * Ambient glow
   * --------------------------------------------------------------------- */
  .ambient-glow {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(
        ellipse 55% 40% at 40% 45%,
        color-mix(in srgb, var(--info) 5%, transparent),
        transparent 70%
      ),
      radial-gradient(
        ellipse 40% 35% at 65% 55%,
        color-mix(in srgb, var(--success) 4%, transparent),
        transparent 70%
      );
    pointer-events: none;
  }

  /* -----------------------------------------------------------------------
   * Ghost clusters — pill outlines with shimmer
   * --------------------------------------------------------------------- */
  .ghost-cluster {
    position: absolute;
    border: 1px solid color-mix(in srgb, var(--ghost-color) 30%, transparent);
    border-radius: var(--radius-pill);
    background: color-mix(in srgb, var(--ghost-color) 5%, transparent);
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow:
      0 0 20px -4px color-mix(in srgb, var(--ghost-color) 20%, transparent),
      inset 0 0 12px -4px color-mix(in srgb, var(--ghost-color) 8%, transparent);
  }

  .ghost-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: color-mix(in srgb, var(--ghost-color) 60%, var(--text-faint));
    user-select: none;
    position: relative;
    z-index: 2;
  }

  .ghost-substrate {
    font-weight: 600;
    letter-spacing: 0.18em;
  }

  .ghost-dash {
    color: var(--text-faint);
    opacity: 0.5;
  }

  .ghost-count {
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    opacity: 0.4;
  }

  /* Shimmer sweep within each cluster */
  .shimmer-overlay {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      105deg,
      transparent 0%,
      transparent 35%,
      color-mix(in srgb, var(--ghost-color) 12%, transparent) 50%,
      transparent 65%,
      transparent 100%
    );
    background-size: 200% 100%;
    animation: shimmer-sweep 2.4s ease-in-out infinite;
    border-radius: inherit;
  }

  @keyframes shimmer-sweep {
    0% { background-position: 200% center; }
    100% { background-position: -200% center; }
  }

  /* -----------------------------------------------------------------------
   * Ghost dots — scattered node points
   * --------------------------------------------------------------------- */
  .ghost-dots {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .ghost-dot {
    position: absolute;
    border-radius: 50%;
    background: var(--border-strong);
    animation: dot-pulse var(--ease-breathe, 4000ms ease-in-out infinite);
  }

  @keyframes dot-pulse {
    0%, 100% { opacity: 0.06; }
    50%       { opacity: 0.14; }
  }

  /* -----------------------------------------------------------------------
   * Scan line — horizontal sweep across the whole canvas
   * --------------------------------------------------------------------- */
  .scan-line {
    position: absolute;
    left: 0;
    right: 0;
    height: 1px;
    background: linear-gradient(
      90deg,
      transparent 0%,
      color-mix(in srgb, var(--accent) 30%, transparent) 20%,
      color-mix(in srgb, var(--accent) 60%, transparent) 50%,
      color-mix(in srgb, var(--accent) 30%, transparent) 80%,
      transparent 100%
    );
    animation: scan 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    pointer-events: none;
    top: 0;
  }

  @keyframes scan {
    0%   { top: 0%; opacity: 0; }
    5%   { opacity: 0.8; }
    95%  { opacity: 0.8; }
    100% { top: 100%; opacity: 0; }
  }

  /* -----------------------------------------------------------------------
   * Reduced motion — strip all animations
   * --------------------------------------------------------------------- */
  @media (prefers-reduced-motion: reduce) {
    .shimmer-overlay {
      animation: none;
      background: none;
    }

    .ghost-dot {
      animation: none;
    }

    .scan-line {
      animation: none;
      display: none;
    }
  }
</style>
