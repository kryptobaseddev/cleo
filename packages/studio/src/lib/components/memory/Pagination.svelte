<!--
  Pagination — offset/limit paging for memory list surfaces.

  Minimal, keyboard-friendly. Renders:
    [ prev ]  page N of M  [ next ]

  Consumers own offset + limit state. We never fire on-empty pages; the
  Prev / Next buttons self-disable at the boundaries.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { Button } from '$lib/ui';

  /**
   * Props for {@link Pagination}.
   */
  interface Props {
    /** Current zero-based offset. */
    offset: number;
    /** Page size. */
    limit: number;
    /** Total item count returned by the server. */
    total: number;
    /** Called when user clicks Prev / Next. */
    onChange: (nextOffset: number) => void;
  }

  let { offset, limit, total, onChange }: Props = $props();

  const pageIndex = $derived(Math.floor(offset / Math.max(1, limit)) + 1);
  const pageCount = $derived(Math.max(1, Math.ceil(total / Math.max(1, limit))));
  const hasPrev = $derived(offset > 0);
  const hasNext = $derived(offset + limit < total);

  const rangeStart = $derived(total === 0 ? 0 : offset + 1);
  const rangeEnd = $derived(Math.min(total, offset + limit));

  function goPrev(): void {
    if (!hasPrev) return;
    onChange(Math.max(0, offset - limit));
  }

  function goNext(): void {
    if (!hasNext) return;
    onChange(offset + limit);
  }
</script>

<nav class="pager" aria-label="Pagination">
  <Button variant="subtle" size="sm" disabled={!hasPrev} onclick={goPrev}>
    ← Prev
  </Button>
  <span class="status">
    <span class="range">{rangeStart}–{rangeEnd}</span>
    <span class="divider">of</span>
    <span class="total">{total}</span>
    <span class="dot">·</span>
    <span class="page">page {pageIndex} / {pageCount}</span>
  </span>
  <Button variant="subtle" size="sm" disabled={!hasNext} onclick={goNext}>
    Next →
  </Button>
</nav>

<style>
  .pager {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding: var(--space-3) 0;
    font-family: var(--font-sans);
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .range,
  .total {
    color: var(--text);
    font-weight: 600;
  }

  .divider {
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: var(--text-2xs);
  }

  .dot {
    color: var(--text-faint);
  }

  .page {
    color: var(--text-faint);
  }
</style>
