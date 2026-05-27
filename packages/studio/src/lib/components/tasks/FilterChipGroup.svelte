<!--
  FilterChipGroup — multi-select pill chips with optional count badges.

  Consumed by the shared Task Explorer toolbar (status chips, priority
  chips, labels dropdown trigger). Matches the viz reference chip style at
  `/tmp/task-viz/index.html:167-199`.

  Keyboard: chips are `<button>` elements so Tab/Space/Enter work
  natively. Arrow keys are out of scope here — the Explorer-level keyboard
  handler owns `1/2/3` tab switching etc.

  @task T950
  @epic T949
-->
<script lang="ts">
  /**
   * A single selectable option in a {@link FilterChipGroup}.
   */
  export interface FilterChipOption {
    /** Opaque value stored in the `selected` array. */
    value: string;
    /** Human-readable chip label. */
    label: string;
    /**
     * Optional count shown as a trailing badge. When omitted, no badge
     * renders. Useful for "Pending (12)" style filters.
     */
    count?: number;
    /**
     * Optional CSS colour token to paint the chip's active state. Defaults
     * to the accent colour. Example: `"#22c55e"` for the done chip.
     */
    tint?: string;
  }

  /**
   * Props for {@link FilterChipGroup}.
   */
  interface Props {
    /** Group-level label shown as a lead-in (e.g. `"Status"`). */
    label?: string;
    /** Available options. */
    options: FilterChipOption[];
    /**
     * Currently selected values. A value is "on" iff it appears in this
     * array. Empty array = nothing selected (equivalent to "All").
     */
    selected: string[];
    /**
     * Called whenever the user toggles a chip. Receives the NEXT
     * selection array (immutable — do not mutate in place).
     */
    onChange: (next: string[]) => void;
    /**
     * When true, the group enforces single-selection (radio-style).
     * Default `false` (multi-select).
     */
    exclusive?: boolean;
  }

  let { label, options, selected, onChange, exclusive = false }: Props = $props();

  function toggle(value: string): void {
    if (exclusive) {
      onChange(selected.includes(value) ? [] : [value]);
      return;
    }
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    onChange(next);
  }
</script>

<div class="chip-group" role="group" aria-label={label ?? 'Filter'}>
  {#if label}
    <span class="chip-group-label">{label}</span>
  {/if}
  {#each options as opt (opt.value)}
    {@const isActive = selected.includes(opt.value)}
    <button
      type="button"
      class="chip"
      class:active={isActive}
      onclick={() => toggle(opt.value)}
      aria-pressed={isActive}
      style={opt.tint && isActive ? `--chip-tint:${opt.tint}` : undefined}
    >
      {#if opt.tint}
        <span class="dot" style="background:{opt.tint}"></span>
      {/if}
      <span class="chip-label">{opt.label}</span>
      {#if typeof opt.count === 'number'}
        <span class="chip-count">{opt.count}</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .chip-group {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px;
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    flex-wrap: wrap;
  }

  .chip-group-label {
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    padding: 0 0.375rem;
    display: flex;
    align-items: center;
    font-weight: 600;
  }

  .chip {
    background: transparent;
    border: none;
    color: var(--text-dim);
    padding: 0.25rem 0.625rem;
    border-radius: var(--radius-xs);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: background var(--ease), color var(--ease);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-weight: 500;
    font-family: inherit;
  }

  .chip:hover {
    color: var(--text);
  }

  .chip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .chip.active {
    color: var(--text);
    background: var(--bg-elev-2);
  }

  .chip.active[style*="--chip-tint"] {
    background: color-mix(in srgb, var(--chip-tint) 20%, transparent);
    color: var(--chip-tint);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
  }

  .chip-label {
    line-height: 1;
  }

  .chip-count {
    font-size: 0.625rem;
    color: inherit;
    opacity: 0.75;
    background: rgba(255, 255, 255, 0.05);
    padding: 0.075rem 0.3rem;
    border-radius: 999px;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
</style>
