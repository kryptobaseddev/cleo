<!--
  ClusterLabelLayer — ATC callout labels for the 5 CLEO substrate
  regions rendered on top of a CLEO Studio graph canvas.

  Renders EXACTLY 5 labels — one per substrate — regardless of node count.
  When a substrate has zero visible nodes the label fades to 0.15 alpha
  and displays `{SUBSTRATE} · —`.

  Label text uses real CLEO vocabulary — substrate name (BRAIN / NEXUS /
  TASKS / CONDUIT / SIGNALDOCK) with the actual content noun stored in
  that substrate:
    `BRAIN · 432 MEMORIES · 0.5% ACTIVE`
    `NEXUS · 1.0K SYMBOLS · 0.3% ACTIVE`
    `TASKS · 250 TASKS · 1.2% ACTIVE`
    `CONDUIT · 758 MESSAGES · 0.0% ACTIVE`
    `SIGNALDOCK · 3 AGENTS · 0.0% ACTIVE`

  No made-up neuroanatomy (no HIPPOCAMPUS / CORTEX / PREFRONTAL / etc.),
  no "NEURONS" — CLEO stores nodes, not neurons.  The "% ACTIVE" figure
  is the rolling 5-second rate of SSE firing-queue events per visible
  node in the substrate.

  `tint` must be a CSS token reference (`var(--info)` etc.) — never raw hex.

  This component has no THREE.js dependency. It works with WebGL,
  SVG, and 2D canvas renderers alike. The caller projects substrate
  centroids to screen space and feeds them as `points`.

  @task T990
-->
<script lang="ts" module>
  /**
   * A projected substrate ATC-callout label in screen coordinates.
   *
   * Exactly 5 must be passed, one per substrate.
   */
  export interface ClusterLabelPoint {
    /** Stable id — matches the {@link import('./types.js').SubstrateId}. */
    id: string;
    /**
     * Substrate name, upper-case. E.g. `BRAIN`, `NEXUS`, `TASKS`,
     * `CONDUIT`, `SIGNALDOCK`.
     *
     * When absent, falls back to {@link label} for backwards-compatibility
     * with pre-rename callers.
     */
    regionName?: string;
    /**
     * @deprecated Use {@link regionName} instead. Kept for backwards
     * compatibility with pre-Agent-B callers (e.g. CosmosRenderer).
     */
    label?: string;
    /** Member count (rendered as `N {NOUN}` via `SUBSTRATE_NOUN`). */
    memberCount?: number;
    /** Current activity percentage 0..100 (rendered as `X.X% ACTIVE`). */
    firingPct?: number;
    /** Screen x (pixels from left edge of the canvas container). */
    x: number;
    /** Screen y (pixels from top edge of the canvas container). */
    y: number;
    /**
     * CSS colour token reference for tint.
     * Must be `var(--<token>)` or `color-mix(...)`. Never raw hex.
     */
    tint?: string;
  }

  /**
   * Substrate names in upper-case. These are the actual CLEO substrate
   * identifiers, not brain-anatomy metaphors. Exported under the legacy
   * `CORTICAL_REGIONS` symbol too so existing importers keep working.
   */
  export const SUBSTRATE_LABELS: Record<string, string> = {
    brain: 'BRAIN',
    nexus: 'NEXUS',
    tasks: 'TASKS',
    conduit: 'CONDUIT',
    signaldock: 'SIGNALDOCK',
  };

  /**
   * The data-kind noun for each substrate — what the nodes actually
   * represent in CLEO. Used in the callout as `{N} {NOUN}`.
   */
  export const SUBSTRATE_NOUN: Record<string, string> = {
    brain: 'MEMORIES',
    nexus: 'SYMBOLS',
    tasks: 'TASKS',
    conduit: 'MESSAGES',
    signaldock: 'AGENTS',
  };

  /**
   * @deprecated Kept as a backwards-compatible alias for
   * {@link SUBSTRATE_LABELS}. New code should import `SUBSTRATE_LABELS`
   * and `SUBSTRATE_NOUN` directly.
   */
  export const CORTICAL_REGIONS: Record<string, string> = SUBSTRATE_LABELS;
</script>

<script lang="ts">
  /**
   * Props for {@link ClusterLabelLayer}.
   */
  interface Props {
    /**
     * Projected ATC labels. Must contain exactly 5 entries (one per
     * substrate) — substrates with zero nodes get `memberCount: 0` and
     * the label auto-fades.
     */
    points: ClusterLabelPoint[];
    /** Current camera zoom level. Labels fade below `fadeBelowZoom`. */
    zoom: number;
    /** Below this zoom level, labels are hidden. Default: 0.35. */
    fadeBelowZoom?: number;
    /** Visibility toggle (operator panel). */
    visible?: boolean;
    /**
     * Active drill-down substrate. When set, all other labels dim to
     * 0.25 alpha. `null` means full-brain view (all labels at full
     * opacity).
     */
    focusedId?: string | null;
  }

  let {
    points,
    zoom,
    fadeBelowZoom = 0.35,
    visible = true,
    focusedId = null,
  }: Props = $props();

  /** Layer-level opacity from zoom + visibility toggle. */
  const layerOpacity = $derived.by(() => {
    if (!visible) return 0;
    if (zoom >= fadeBelowZoom) return 1;
    if (zoom <= fadeBelowZoom * 0.5) return 0;
    return Math.max(0, Math.min(1, (zoom - fadeBelowZoom * 0.5) / (fadeBelowZoom * 0.5)));
  });

  /**
   * Per-label alpha: focused label = 1, others = 0.25 when drilling
   * down. If no focus, all labels respect zero-node fade only.
   */
  function labelAlpha(pt: ClusterLabelPoint): number {
    if (focusedId !== null && pt.id !== focusedId) return 0.25;
    if ((pt.memberCount ?? 0) === 0) return 0.15;
    return 1;
  }

  /** Format member count as `N`, `1.2K`, etc. */
  function formatCount(n: number | undefined): string {
    if (n === undefined || n === 0) return '\u2014';
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return `${n}`;
  }

  /** Format firing pct as `X.X%` clamped to `[0, 999]`. */
  function formatFiring(pct: number | undefined): string {
    if (pct === undefined || pct === 0) return '0.0%';
    return `${Math.min(999, Math.max(0, pct)).toFixed(1)}%`;
  }
</script>

<div
  class="cluster-label-layer"
  style="opacity: {layerOpacity};"
  aria-hidden="true"
>
  {#each points as pt (pt.id)}
    <div
      class="cluster-caption"
      style="
        left: {pt.x}px;
        top: {pt.y}px;
        --cluster-tint: {pt.tint ?? 'var(--text-dim)'};
        opacity: {labelAlpha(pt)};
      "
    >
      <span class="cl-region">{(pt.regionName ?? pt.label ?? '').toUpperCase()}</span>
      <span class="cl-sep" aria-hidden="true">·</span>
      <span class="cl-count">{formatCount(pt.memberCount)} {SUBSTRATE_NOUN[pt.id] ?? 'NODES'}</span>
      <span class="cl-sep" aria-hidden="true">·</span>
      <span class="cl-fire">{formatFiring(pt.firingPct)} ACTIVE</span>
    </div>
  {/each}
</div>

<style>
  .cluster-label-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    transition: opacity var(--ease-slow, 0.4s);
  }

  .cluster-caption {
    position: absolute;
    transform: translate(-50%, -100%);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.2;
    letter-spacing: 0.08em;
    font-weight: 600;
    text-transform: uppercase;
    padding: 6px 10px;
    color: color-mix(in srgb, var(--cluster-tint) 92%, transparent);
    background: color-mix(in srgb, var(--bg-elev-2) 72%, transparent);
    border: 1px solid color-mix(in srgb, var(--cluster-tint) 38%, transparent);
    border-radius: 999px;
    white-space: nowrap;
    text-shadow: 0 0 14px color-mix(in srgb, var(--cluster-tint) 60%, transparent);
    box-shadow:
      0 4px 20px color-mix(in srgb, var(--bg) 80%, transparent),
      0 0 0 0.5px color-mix(in srgb, var(--cluster-tint) 20%, transparent);
    backdrop-filter: blur(8px);
    transition: opacity var(--ease-fast, 0.15s);
  }

  .cl-sep {
    color: color-mix(in srgb, var(--cluster-tint) 55%, transparent);
    font-weight: 400;
  }

  .cl-region {
    font-weight: 700;
    font-size: 10px;
    letter-spacing: 0.12em;
  }

  .cl-count,
  .cl-fire {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
    font-size: 10px;
    opacity: 0.85;
  }
</style>
