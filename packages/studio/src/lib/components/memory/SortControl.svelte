<!--
  SortControl — three-axis sort selector.

  Every memory list surface supports the same triad:
    - created_desc   — newest first (default)
    - quality_desc   — highest-scoring first
    - citation_desc  — most-cited first

  Rendered as a token-consistent `<Select>`. Callers own the sort
  state; this component only emits the change.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { Select, type SelectOption } from '$lib/ui';
  import type { MemorySortKey } from './types.js';

  /**
   * Props for {@link SortControl}.
   */
  interface Props {
    /** Current sort key. */
    value: MemorySortKey;
    /** Emits the selected key. */
    onChange: (next: MemorySortKey) => void;
    /** When false, hide the citation option (e.g. decisions page has no citation_count). */
    allowCitation?: boolean;
  }

  let { value, onChange, allowCitation = true }: Props = $props();

  const options = $derived<SelectOption<MemorySortKey>[]>(
    [
      { value: 'created_desc', label: 'Newest first' },
      { value: 'quality_desc', label: 'Quality · high to low' },
      ...(allowCitation
        ? [{ value: 'citation_desc' as const, label: 'Citations · most first' }]
        : []),
    ],
  );

  function handle(e: Event): void {
    const el = e.target as HTMLSelectElement;
    onChange(el.value as MemorySortKey);
  }
</script>

<div class="sort-ctrl">
  <span class="sort-label">Sort</span>
  <Select value={value} options={options} onchange={handle} />
</div>

<style>
  .sort-ctrl {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 200px;
  }

  .sort-label {
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    font-weight: 700;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    white-space: nowrap;
  }
</style>
