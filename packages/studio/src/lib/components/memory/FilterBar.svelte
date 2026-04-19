<!--
  FilterBar — unified filter control for memory surfaces.

  Drives every filterable /brain page (observations, decisions, patterns,
  learnings, search, graph). Renders only the controls the caller
  actually wants by passing explicit option arrays.

  - Tier / type / status / confidence are rendered as `<ChipGroup>` rows
  - Min-quality is a 0..1 range slider (token-tinted)
  - Optional free-text search uses `<Input type="search">`

  Change events fire through `onChange(next)` — the caller owns the
  filter state (URL-round-tripping, debounce, etc) per Wave 1C pattern.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { Chip, ChipGroup, Input } from '$lib/ui';
  import type {
    FilterValue,
    MemoryConfidenceFilter,
    MemoryStatusFilter,
    MemoryTierFilter,
    MemoryTypeFilter,
  } from './types.js';

  /**
   * Props for {@link FilterBar}.
   */
  interface Props {
    /** Current filter value (controlled). */
    value: FilterValue;
    /** Tier options offered. Omit to hide the tier row. */
    tiers?: Array<Exclude<MemoryTierFilter, null>>;
    /** Type options offered. Omit to hide the type row. */
    types?: string[];
    /** Status options offered. Omit to hide the status row. */
    statuses?: Array<Exclude<MemoryStatusFilter, null>>;
    /** Confidence options offered. Omit to hide the confidence row. */
    confidences?: Array<Exclude<MemoryConfidenceFilter, null>>;
    /** When true, render the min-quality slider. Defaults to `true`. */
    showQuality?: boolean;
    /** When true, render the free-text search input. Defaults to `false`. */
    showSearch?: boolean;
    /** Search placeholder. */
    searchPlaceholder?: string;
    /** Called whenever any filter changes. */
    onChange: (next: FilterValue) => void;
  }

  let {
    value,
    tiers,
    types,
    statuses,
    confidences,
    showQuality = true,
    showSearch = false,
    searchPlaceholder = 'Search…',
    onChange,
  }: Props = $props();

  function emit(patch: Partial<FilterValue>): void {
    onChange({ ...value, ...patch });
  }

  function setTier(t: MemoryTierFilter): void {
    emit({ tier: value.tier === t ? null : t });
  }

  function setType(t: MemoryTypeFilter): void {
    emit({ type: value.type === t ? null : t });
  }

  function setStatus(s: MemoryStatusFilter): void {
    emit({ status: value.status === s ? null : s });
  }

  function setConfidence(c: MemoryConfidenceFilter): void {
    emit({ confidence: value.confidence === c ? null : c });
  }

  function onQualitySlider(e: Event): void {
    const el = e.target as HTMLInputElement;
    const n = Number(el.value);
    emit({ minQuality: Number.isFinite(n) ? n : undefined });
  }

  function clearQuality(): void {
    emit({ minQuality: undefined });
  }

  // Tint map — drives `--chip-tint` per Chip to match the tier / status / confidence palette.
  const TIER_TINT: Record<string, string> = {
    short: 'var(--text-faint)',
    medium: 'var(--info)',
    long: 'var(--success)',
  };

  const STATUS_TINT: Record<string, string> = {
    verified: 'var(--success)',
    prune: 'var(--warning)',
    invalidated: 'var(--danger)',
  };

  const CONFIDENCE_TINT: Record<string, string> = {
    high: 'var(--success)',
    medium: 'var(--warning)',
    low: 'var(--danger)',
    unknown: 'var(--text-faint)',
  };

  // Svelte 5: the Chip component expects a `tint: string`. Resolving via
  // CSS variables works because `color-mix(in srgb, var(--chip-tint) …)`
  // is evaluated per-component, so the variable reference composes.

  const qualityValue = $derived(value.minQuality ?? 0);
  const qualityPct = $derived(Math.round(qualityValue * 100));
</script>

<section class="filter-bar" aria-label="Memory filters">
  {#if tiers && tiers.length > 0}
    <div class="row">
      <span class="row-label">Tier</span>
      <ChipGroup label="Tier">
        {#each tiers as t (t)}
          <Chip
            mode="toggle"
            active={value.tier === t}
            tint={TIER_TINT[t]}
            onclick={() => setTier(t)}
          >
            {t}
          </Chip>
        {/each}
      </ChipGroup>
    </div>
  {/if}

  {#if types && types.length > 0}
    <div class="row">
      <span class="row-label">Type</span>
      <ChipGroup label="Type">
        {#each types as t (t)}
          <Chip mode="toggle" active={value.type === t} onclick={() => setType(t)}>
            {t}
          </Chip>
        {/each}
      </ChipGroup>
    </div>
  {/if}

  {#if statuses && statuses.length > 0}
    <div class="row">
      <span class="row-label">Status</span>
      <ChipGroup label="Status">
        {#each statuses as s (s)}
          <Chip
            mode="toggle"
            active={value.status === s}
            tint={STATUS_TINT[s]}
            onclick={() => setStatus(s)}
          >
            {s}
          </Chip>
        {/each}
      </ChipGroup>
    </div>
  {/if}

  {#if confidences && confidences.length > 0}
    <div class="row">
      <span class="row-label">Confidence</span>
      <ChipGroup label="Confidence">
        {#each confidences as c (c)}
          <Chip
            mode="toggle"
            active={value.confidence === c}
            tint={CONFIDENCE_TINT[c]}
            onclick={() => setConfidence(c)}
          >
            {c}
          </Chip>
        {/each}
      </ChipGroup>
    </div>
  {/if}

  {#if showQuality}
    <div class="row">
      <span class="row-label">Quality ≥</span>
      <div class="quality-wrap">
        <input
          class="slider"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={qualityValue}
          oninput={onQualitySlider}
          aria-label={`Minimum quality: ${qualityPct}%`}
        />
        <span class="slider-value">
          {#if value.minQuality === undefined}
            any
          {:else}
            {qualityValue.toFixed(2)}
          {/if}
        </span>
        {#if value.minQuality !== undefined}
          <button type="button" class="clear-btn" onclick={clearQuality} aria-label="Clear quality filter">
            clear
          </button>
        {/if}
      </div>
    </div>
  {/if}

  {#if showSearch}
    <div class="row search-row">
      <Input
        type="search"
        value={value.q ?? ''}
        label="Search"
        placeholder={searchPlaceholder}
        oninput={(e) => emit({ q: (e.target as HTMLInputElement).value })}
      />
    </div>
  {/if}
</section>

<style>
  .filter-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3) var(--space-4);
    padding: var(--space-3) var(--space-4);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .row-label {
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    font-weight: 700;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    white-space: nowrap;
  }

  .search-row {
    flex: 1;
    min-width: 240px;
  }

  .quality-wrap {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .slider {
    width: 140px;
    accent-color: var(--accent);
  }

  .slider-value {
    font-size: var(--text-xs);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    min-width: 36px;
  }

  .clear-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-faint);
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color var(--ease), border-color var(--ease);
  }

  .clear-btn:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .clear-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }
</style>
