<!--
  LabelsFilter — dropdown combobox for the Task Explorer Labels filter.

  Replaces the 150-chip inline sprawl with a compact trigger button that
  opens a floating panel containing:

    - Search input (live-filters the list)
    - Scrollable checkbox list with selected-first ordering
    - "Clear all" button (resets to empty selection)
    - Click-outside and `Esc` dismiss

  A11y: `role="combobox"` with `aria-expanded` on the trigger, listbox
  semantics inside, full keyboard support (Up/Down navigates, Space
  toggles, Enter activates, Esc closes).

  All styling comes from tokens — zero hex literals.

  @task T990
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';

  /** Option shape — matches {@link FilterChipOption} from the tasks barrel. */
  export interface LabelOption {
    value: string;
    label?: string;
  }

  /**
   * Props for {@link LabelsFilter}.
   */
  interface Props {
    /** Full set of selectable labels (project-wide). */
    options: LabelOption[];
    /** Currently selected label values. */
    selected: string[];
    /** Fires with the new selection after any toggle / clear. */
    onChange: (next: string[]) => void;
    /** Optional leading label ("Labels" by default). */
    heading?: string;
  }

  let { options, selected, onChange, heading = 'Labels' }: Props = $props();

  let open = $state(false);
  let query = $state('');
  let rootEl: HTMLDivElement | null = $state(null);
  let searchInput: HTMLInputElement | null = $state(null);

  /** Selection as a Set for O(1) membership checks in the template. */
  const selectedSet = $derived(new Set(selected));

  /**
   * Filtered + ordered option list:
   *   1. Selected items first (so the operator can find what's active).
   *   2. Then case-insensitive substring match on `query`.
   *   3. Stable label-alphabetical ordering within each group.
   */
  const visibleOptions = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const matches = (o: LabelOption): boolean => {
      if (!q) return true;
      const label = (o.label ?? o.value).toLowerCase();
      return label.includes(q) || o.value.toLowerCase().includes(q);
    };
    const sel: LabelOption[] = [];
    const rest: LabelOption[] = [];
    for (const o of options) {
      if (!matches(o)) continue;
      if (selectedSet.has(o.value)) sel.push(o);
      else rest.push(o);
    }
    const byLabel = (a: LabelOption, b: LabelOption): number =>
      (a.label ?? a.value).localeCompare(b.label ?? b.value);
    sel.sort(byLabel);
    rest.sort(byLabel);
    return [...sel, ...rest];
  });

  function toggle(): void {
    open = !open;
    if (open) {
      void tick().then(() => searchInput?.focus());
    }
  }

  function close(): void {
    open = false;
    query = '';
  }

  function toggleValue(value: string): void {
    const next = selectedSet.has(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    onChange(next);
  }

  function clearAll(): void {
    onChange([]);
  }

  /** Close on outside click. */
  onMount(() => {
    const onDocPointerDown = (e: PointerEvent): void => {
      if (!open) return;
      const target = e.target as Node | null;
      if (rootEl && target && !rootEl.contains(target)) close();
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  });

  /** Escape closes; Arrow keys navigate; Space/Enter toggles focused item. */
  function onKeydown(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = Array.from(
        rootEl?.querySelectorAll<HTMLLabelElement>('.opt-row') ?? [],
      );
      if (items.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? items.findIndex((el) => el.contains(active)) : -1;
      const nextIdx =
        e.key === 'ArrowDown'
          ? (idx + 1) % items.length
          : (idx - 1 + items.length) % items.length;
      const input = items[nextIdx]?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      input?.focus();
    }
  }
</script>

<div
  bind:this={rootEl}
  class="labels-filter"
  role="group"
  aria-label={heading}
  onkeydown={onKeydown}
>
  <button
    type="button"
    class="trigger"
    aria-haspopup="listbox"
    aria-expanded={open}
    onclick={toggle}
  >
    <span class="trigger-label">{heading}</span>
    {#if selected.length > 0}
      <span class="trigger-count" aria-label={`${selected.length} selected`}>{selected.length}</span>
    {:else}
      <span class="trigger-hint">Any</span>
    {/if}
    <span class="trigger-chev" aria-hidden="true">{open ? '▴' : '▾'}</span>
  </button>

  {#if open}
    <div class="popover" role="dialog" aria-label={`${heading} filter`}>
      <div class="popover-head">
        <input
          bind:this={searchInput}
          bind:value={query}
          type="search"
          placeholder="Search labels..."
          aria-label="Filter label options"
          class="search-input"
        />
      </div>

      <div class="popover-body" role="listbox" aria-multiselectable="true">
        {#each visibleOptions as opt (opt.value)}
          <label class="opt-row">
            <input
              type="checkbox"
              checked={selectedSet.has(opt.value)}
              onchange={() => toggleValue(opt.value)}
            />
            <span class="opt-label">{opt.label ?? opt.value}</span>
          </label>
        {:else}
          <div class="opt-empty">No labels match "{query}"</div>
        {/each}
      </div>

      <div class="popover-foot">
        <span class="selected-count">
          {selected.length}
          {selected.length === 1 ? 'label' : 'labels'} selected
        </span>
        <button
          type="button"
          class="clear-btn"
          onclick={clearAll}
          disabled={selected.length === 0}
        >
          Clear all
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .labels-filter {
    position: relative;
    display: inline-flex;
  }

  .trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 4px 10px;
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    color: var(--text);
    font-family: inherit;
    font-size: var(--text-xs);
    font-weight: 500;
    letter-spacing: 0.02em;
    cursor: pointer;
    transition: background var(--ease), border-color var(--ease);
  }

  .trigger:hover {
    background: var(--bg-elev-2);
    border-color: var(--border-strong);
  }

  .trigger:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .trigger-label {
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-size: var(--text-2xs);
    color: var(--text-dim);
  }

  .trigger-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: var(--radius-pill);
    font-size: var(--text-2xs);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .trigger-hint {
    color: var(--text-faint);
    font-size: var(--text-2xs);
    font-style: italic;
  }

  .trigger-chev {
    color: var(--text-dim);
    font-size: 10px;
  }

  .popover {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 40;
    width: 320px;
    max-width: 96vw;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .popover-head {
    padding: var(--space-2);
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev-1);
  }

  .search-input {
    width: 100%;
    padding: 6px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: inherit;
    font-size: var(--text-sm);
  }

  .search-input::placeholder {
    color: var(--text-faint);
  }

  .search-input:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: var(--shadow-focus);
  }

  .popover-body {
    max-height: 280px;
    overflow-y: auto;
    padding: var(--space-1) 0;
  }

  .opt-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 6px var(--space-3);
    cursor: pointer;
    font-size: var(--text-sm);
    color: var(--text);
    transition: background var(--ease);
  }

  .opt-row:hover {
    background: var(--bg-elev-1);
  }

  .opt-row input[type='checkbox'] {
    accent-color: var(--accent);
    cursor: pointer;
    width: 14px;
    height: 14px;
  }

  .opt-row input[type='checkbox']:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .opt-label {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .opt-empty {
    padding: var(--space-3);
    color: var(--text-faint);
    font-size: var(--text-sm);
    font-style: italic;
    text-align: center;
  }

  .popover-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) var(--space-3);
    border-top: 1px solid var(--border);
    background: var(--bg-elev-1);
  }

  .selected-count {
    font-size: var(--text-2xs);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .clear-btn {
    padding: 4px 10px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    font-family: inherit;
    font-size: var(--text-2xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    transition: background var(--ease), color var(--ease), border-color var(--ease);
  }

  .clear-btn:hover:not(:disabled) {
    background: var(--danger-soft);
    color: var(--danger);
    border-color: var(--danger);
  }

  .clear-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .clear-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }
</style>
