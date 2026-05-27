<!--
  StatBlock — tabular-nums KPI used across the Mission Control dashboard
  and the Project Registry cards.

  Renders a label (uppercase, dim), a large value (tabular-nums),
  optional delta chip and trend glyph, and an optional accent tint
  that colours the value + left accent bar.

  @task T990
  @wave 1E
-->
<script lang="ts">
  /**
   * Trend direction of the delta chip.
   */
  export type Trend = 'up' | 'down' | 'flat';

  /**
   * Tone controls the accent bar + value colour.
   */
  export type StatTone =
    | 'neutral'
    | 'success'
    | 'warning'
    | 'danger'
    | 'info'
    | 'accent';

  /**
   * Props for {@link StatBlock}.
   */
  interface Props {
    /** Uppercase label — 1-2 words. */
    label: string;
    /** Primary value. String-typed so callers can pre-format. */
    value: string | number;
    /** Optional unit suffix displayed next to the value. */
    unit?: string;
    /** Optional delta text (e.g. "+4", "-2%"). */
    delta?: string;
    /** Delta colour direction. Defaults to `flat` (neutral). */
    trend?: Trend;
    /** Semantic tone that tints the accent bar + value. */
    tone?: StatTone;
    /** Extra hint line rendered below the value (dim). */
    hint?: string;
    /** Extra class names forwarded to the root. */
    class?: string;
  }

  let {
    label,
    value,
    unit,
    delta,
    trend = 'flat',
    tone = 'neutral',
    hint,
    class: extraClass = '',
  }: Props = $props();

  const trendGlyph = $derived(
    trend === 'up' ? '▲' : trend === 'down' ? '▼' : '—',
  );
</script>

<div class="stat t-{tone} {extraClass}" role="group" aria-label={label}>
  <span class="stat-label">{label}</span>
  <div class="stat-value-row">
    <span class="stat-value">{value}</span>
    {#if unit}
      <span class="stat-unit">{unit}</span>
    {/if}
    {#if delta}
      <span class="stat-delta trend-{trend}">
        <span class="stat-delta-glyph" aria-hidden="true">{trendGlyph}</span>
        <span class="stat-delta-value">{delta}</span>
      </span>
    {/if}
  </div>
  {#if hint}
    <span class="stat-hint">{hint}</span>
  {/if}
</div>

<style>
  .stat {
    --stat-accent: var(--text-dim);

    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-4);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    border-left: 2px solid var(--stat-accent);
    transition: border-color var(--ease), background var(--ease);
    min-width: 0;
  }

  .stat:hover {
    background: var(--bg-elev-2);
  }

  /* tones */
  .stat.t-neutral   { --stat-accent: var(--text-faint); }
  .stat.t-success   { --stat-accent: var(--success); }
  .stat.t-warning   { --stat-accent: var(--warning); }
  .stat.t-danger    { --stat-accent: var(--danger); }
  .stat.t-info      { --stat-accent: var(--info); }
  .stat.t-accent    { --stat-accent: var(--accent); }

  .stat-label {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-weight: 600;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .stat-value-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
  }

  .stat-value {
    font-size: var(--text-xl);
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    letter-spacing: -0.02em;
  }

  .stat.t-success .stat-value  { color: var(--success); }
  .stat.t-warning .stat-value  { color: var(--warning); }
  .stat.t-danger  .stat-value  { color: var(--danger); }
  .stat.t-info    .stat-value  { color: var(--info); }
  .stat.t-accent  .stat-value  { color: var(--accent); }

  .stat-unit {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-faint);
    font-weight: 500;
  }

  .stat-delta {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    padding: 1px var(--space-2);
    border-radius: var(--radius-sm);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .trend-up {
    background: var(--success-soft);
    color: var(--success);
  }

  .trend-down {
    background: var(--danger-soft);
    color: var(--danger);
  }

  .trend-flat {
    background: var(--neutral-soft);
    color: var(--text-dim);
  }

  .stat-delta-glyph {
    font-size: 0.625rem;
  }

  .stat-hint {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: 0.02em;
  }
</style>
