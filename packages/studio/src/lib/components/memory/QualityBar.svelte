<!--
  QualityBar — horizontal 80×6 quality score visualization.

  Interpolates across semantic tokens so the gradient responds to the
  palette rather than hard-coded hex. Score `null` / `undefined` renders
  a faint placeholder block with the dim tone.

  @task T990
  @wave 1D
-->
<script lang="ts">
  /**
   * Props for {@link QualityBar}.
   */
  interface Props {
    /** Quality score in [0..1]. `null` → placeholder. */
    score: number | null | undefined;
    /** When true, render the numeric label next to the bar. Defaults to `true`. */
    showLabel?: boolean;
    /** Width of the bar in px. Defaults to 80. */
    width?: number;
  }

  let { score, showLabel = true, width = 80 }: Props = $props();

  const resolved = $derived(typeof score === 'number' && Number.isFinite(score) ? score : null);

  const pct = $derived(resolved === null ? 0 : Math.round(Math.max(0, Math.min(1, resolved)) * 100));

  /** Semantic bucket — drives the token-driven colour. */
  const tone = $derived.by(() => {
    if (resolved === null) return 'unknown' as const;
    if (resolved >= 0.7) return 'high' as const;
    if (resolved >= 0.4) return 'mid' as const;
    return 'low' as const;
  });

  const labelText = $derived(resolved === null ? '—' : resolved.toFixed(2));
</script>

<span class="q-bar" style="--q-width:{width}px" role="img" aria-label={`Quality ${labelText}`}>
  <span class="track">
    <span class="fill t-{tone}" style="width:{pct}%"></span>
  </span>
  {#if showLabel}
    <span class="label t-{tone}">{labelText}</span>
  {/if}
</span>

<style>
  .q-bar {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-variant-numeric: tabular-nums;
  }

  .track {
    display: block;
    width: var(--q-width, 80px);
    height: 6px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    overflow: hidden;
    flex-shrink: 0;
  }

  .fill {
    display: block;
    height: 100%;
    border-radius: var(--radius-pill);
    min-width: 2px;
    transition: width var(--ease-slow);
  }

  .fill.t-high {
    background: var(--success);
  }

  .fill.t-mid {
    background: var(--warning);
  }

  .fill.t-low {
    background: var(--danger);
  }

  .fill.t-unknown {
    background: var(--border-strong);
  }

  .label {
    font-size: var(--text-2xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    min-width: 28px;
  }

  .label.t-high {
    color: var(--success);
  }

  .label.t-mid {
    color: var(--warning);
  }

  .label.t-low {
    color: var(--danger);
  }

  .label.t-unknown {
    color: var(--text-faint);
  }
</style>
